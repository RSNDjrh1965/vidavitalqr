// ---- onvo-webhook.js ----
// Recibe los eventos que ONVO Pay envía cuando cambia el estado de una Checkout Session (por
// ejemplo, cuando un pago de renovación se completa). Verifica que la petición venga realmente
// de ONVO, confirma el pago consultando directamente a la API de ONVO (nunca confía ciegamente
// en el contenido del webhook) y, si el pago quedó confirmado, avisa por correo al administrador.
//
// Primera fase (2026-09-15): esta función SOLO confirma y notifica el pago — todavía no marca la
// ficha como renovada en S3 ni cambia el bloqueo del visor público. Eso queda para la siguiente
// fase, una vez confirmado que los pagos de prueba llegan correctamente hasta aquí.
//
// Requiere dos variables de entorno en Netlify (Project configuration → Environment variables):
//   - ONVO_SECRET_KEY: la misma llave secreta usada en crear-pago.js.
//   - ONVO_WEBHOOK_SECRET: el "Secreto de firma" que se ve en el panel de ONVO Pay, en
//     Webhooks → (el endpoint de vidavitalqr.com) → Secreto de firma → Mostrar.
// Ninguna de las dos debe escribirse en este archivo ni en ningún otro que se suba al repositorio.

const ONVO_API_BASE = 'https://api.onvopay.com/v1';
// ---- reporte de pagos confirmados: este aviso llega solo al administrador (nunca se muestra ni
// se pide en el mockup de checkout), igual que la confirmación que ONVO Pay le envía al comprador
// a través de "customerEmail" (ver crear-pago.js) ----
const DESTINATARIO = 'roljamher@hotmail.com';
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';

const EVENTOS_DE_PAGO = ['checkout-session.succeeded', 'payment-intent.succeeded'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método no permitido.' };
  }

  // ---- 1) Verificar que la petición venga realmente de ONVO Pay ----
  const webhookSecret = process.env.ONVO_WEBHOOK_SECRET;
  const secretoRecibido = event.headers['x-webhook-secret'] || event.headers['X-Webhook-Secret'];
  if (!webhookSecret) {
    console.error('onvo-webhook: falta la variable de entorno ONVO_WEBHOOK_SECRET en Netlify.');
    return { statusCode: 500, body: 'Falta configuración.' };
  }
  if (secretoRecibido !== webhookSecret) {
    console.error('onvo-webhook: petición rechazada — el secreto de firma no coincide.');
    return { statusCode: 401, body: 'No autorizado.' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'JSON inválido.' };
  }

  const tipoEvento = payload.type;
  const sessionId = payload.data && payload.data.id;

  if (!sessionId) {
    return { statusCode: 200, body: 'ok (evento sin id, se ignora)' };
  }
  if (EVENTOS_DE_PAGO.indexOf(tipoEvento) === -1) {
    // otros eventos (fallidos, expirados, suscripciones, etc.) no nos interesan por ahora
    return { statusCode: 200, body: 'ok (evento ignorado: ' + tipoEvento + ')' };
  }

  const secretKey = process.env.ONVO_SECRET_KEY;
  if (!secretKey) {
    console.error('onvo-webhook: falta la variable de entorno ONVO_SECRET_KEY en Netlify.');
    return { statusCode: 500, body: 'Falta configuración.' };
  }

  // ---- 2) Confirmar el pago consultando directamente a ONVO (no confiar solo en el webhook) ----
  let session;
  try {
    const resp = await fetch(ONVO_API_BASE + '/checkout/sessions/' + encodeURIComponent(sessionId), {
      headers: { Authorization: 'Bearer ' + secretKey },
    });
    session = await resp.json().catch(() => null);
    if (!resp.ok || !session) {
      console.error('onvo-webhook: no se pudo confirmar la sesión', sessionId, '— status', resp.status);
      return { statusCode: 502, body: 'No se pudo confirmar el pago.' };
    }
  } catch (err) {
    console.error('onvo-webhook: error al consultar la sesión', sessionId, err);
    return { statusCode: 502, body: 'Error al confirmar el pago.' };
  }

  if (session.paymentStatus !== 'paid') {
    console.log('onvo-webhook: sesión', sessionId, 'todavía no está pagada (', session.paymentStatus, ') — se ignora por ahora.');
    return { statusCode: 200, body: 'ok (no pagado aún)' };
  }

  const meta = session.metadata || {};
  const modo = session.mode || 'desconocido';

  // ---- metadata.items es un JSON con [{item, folio, tipo}, ...] armado por crear-pago.js;
  // si por algún motivo no viene (por ejemplo, sesiones creadas antes de este cambio), se cae
  // de vuelta a los campos "folio"/"tipo" sueltos que usaba la primera fase ----
  let items = [];
  try {
    if (meta.items) items = JSON.parse(meta.items);
  } catch (e) { /* metadata inválida, se ignora */ }
  if (!items.length && (meta.folio || meta.tipo)) {
    items = [{ item: 'renewal', folio: meta.folio || '', tipo: meta.tipo || '' }];
  }
  const folios = meta.folios || items.filter((it) => it.folio).map((it) => it.folio).join(',');

  console.log('onvo-webhook: pago CONFIRMADO —', items.length, 'producto(s), folios:', folios || '(ninguno)', '— sesión', sessionId, '— modo', modo);

  // ---- 3) Avisar por correo al administrador (mismo destinatario que ya recibe los demás avisos) ----
  await avisarAdministrador({ items, folios, sessionId, modo });

  // TODO (próxima fase, una vez confirmado que esto funciona en pruebas): marcar cada ficha
  // (según folio/tipo en "items") como renovada/pagada en S3 (reiniciar su fecha "creado", igual
  // que hace send-ficha.js cuando se envía con esRenovacionPago), y activar el bloqueo del visor
  // público para fichas no pagadas (ver.js) — ambos pendientes según el punto 17 de la bitácora.
  // Los productos físicos/digitales sin folio (placa, pulsera, cadena, Identificador QR, código
  // QR solo digital) no requieren esa marca — su ficha se crea y envía por separado desde el
  // formulario de ficha correspondiente.

  return { statusCode: 200, body: 'ok' };
};

async function avisarAdministrador({ items, folios, sessionId, modo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('onvo-webhook: falta RESEND_API_KEY — no se pudo avisar por correo del pago confirmado.');
    return;
  }

  const listaItems = items.length
    ? items.map((it) => '  - ' + (it.item || '?') + (it.folio ? ' (folio: ' + it.folio + ')' : '')).join('\n')
    : '  (sin detalle de productos)';

  const asunto = 'Pago confirmado — ' + items.length + ' producto(s)' + (modo === 'test' ? ' (MODO PRUEBA)' : '');
  const cuerpo = [
    'ONVO Pay confirmó un pago de VidaVitalQR.',
    '',
    'Productos:',
    listaItems,
    '',
    'Folios asociados: ' + (folios || '(ninguno)'),
    'Sesión de ONVO Pay: ' + sessionId,
    'Modo: ' + modo + (modo === 'test' ? ' (pago de prueba, sin dinero real)' : ''),
    '',
    'Nota: este aviso confirma que el pago llegó correctamente, pero todavía no marca ninguna',
    'ficha como renovada de forma automática en el sistema ni desbloquea nada en el visor',
    'público. Eso se agrega en la siguiente fase.',
  ].join('\n');

  // ---- versión HTML del aviso: resalta visualmente qué se compró (punto 4), para que quede claro
  // de un vistazo sin tener que leer todo el correo ----
  const escaparHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const listaItemsHtml = items.length
    ? '<ul style="margin:0;padding-left:20px;">' + items.map((it) =>
        '<li style="margin-bottom:6px;"><strong style="color:#0a7d3c;font-size:15px;">' + escaparHtml(it.item || '?') + '</strong>' +
        (it.folio ? ' &nbsp;<span style="color:#555;">(folio: ' + escaparHtml(it.folio) + ')</span>' : '') +
        '</li>'
      ).join('') + '</ul>'
    : '<p style="color:#555;">(sin detalle de productos)</p>';
  const cuerpoHtml = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5;">',
    '<p>ONVO Pay confirmó un pago de VidaVitalQR.</p>',
    '<div style="background:#f2f9f4;border:1px solid #cfe9d8;border-radius:8px;padding:14px 16px;margin:14px 0;">',
    '<p style="margin:0 0 8px 0;font-weight:bold;">Producto(s) comprado(s):</p>',
    listaItemsHtml,
    '</div>',
    '<p><strong>Folios asociados:</strong> ' + escaparHtml(folios || '(ninguno)') + '<br>',
    '<strong>Sesión de ONVO Pay:</strong> ' + escaparHtml(sessionId) + '<br>',
    '<strong>Modo:</strong> ' + escaparHtml(modo) + (modo === 'test' ? ' (pago de prueba, sin dinero real)' : '') + '</p>',
    '<p style="color:#777;font-size:12px;margin-top:18px;">Nota: este aviso confirma que el pago llegó correctamente, pero todavía no marca ninguna ficha como renovada de forma automática en el sistema ni desbloquea nada en el visor público. Eso se agrega en la siguiente fase.</p>',
    '</div>',
  ].join('');

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: REMITENTE, to: [DESTINATARIO], subject: asunto, text: cuerpo, html: cuerpoHtml }),
    });
    if (!resp.ok) {
      let detalle = '';
      try { detalle = JSON.stringify(await resp.json()); } catch (e) { /* sin detalle */ }
      console.error('onvo-webhook: Resend rechazó el aviso de pago confirmado —', resp.status, detalle);
    }
  } catch (err) {
    console.error('onvo-webhook: no se pudo enviar el aviso de pago confirmado —', err);
  }
}
