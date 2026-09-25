// ---- onvo-webhook.js ----
// Recibe los eventos que ONVO Pay envía cuando cambia el estado de un pago (tarjeta o SINPE
// Móvil, ambos pasan por el mismo Checkout hospedado — ver crear-pago.js). Verifica que la
// petición venga realmente de ONVO, avisa por correo al administrador cuando un pago queda
// confirmado, y agrega ese pago como una fila nueva al Registro de Ingresos (ver lib/ingresos.js).
//
// Segunda fase (2026-09-26): a diferencia de la primera fase, esta función ya NO vuelve a
// consultar la API de ONVO para confirmar el pago — el propio evento "payment-intent.succeeded"
// ya trae todo lo necesario (monto, moneda, metadata, referencia). Ese cambio fue necesario
// porque la consulta anterior (GET /checkout/sessions/{id}) fallaba con error 502: el ID que
// llega en "payment-intent.succeeded" es el de un Payment Intent, no el de una Checkout Session
// (son objetos distintos en la API de ONVO) — se confirmó revisando los logs del webhook en el
// panel de ONVO (2026-09-26).
//
// "payment-intent.succeeded" es el ÚNICO evento que dispara el correo de aviso y el registro del
// ingreso. "checkout-session.succeeded" se ignora a propósito (antes SÍ disparaba ambos, pero
// ONVO manda los dos eventos para el mismo pago, así que hacerlo con los dos duplicaba el correo
// y hubiera duplicado también la fila del Registro de Ingresos). "payment-intent.deferred" y
// "mobile-transfer.received" (eventos propios del flujo de SINPE Móvil, según indicó soporte de
// ONVO) se reconocen y se responden con 200 para que ONVO no los reintente, pero tampoco disparan
// nada — son solo pasos intermedios antes de que llegue (o no) el "succeeded" definitivo.
//
// Sigue pendiente (ver bitácora): marcar cada ficha como renovada/pagada en S3 y activar el
// bloqueo del visor público para fichas no pagadas (ver.js).
//
// Requiere dos variables de entorno en Netlify (Project configuration → Environment variables):
//   - ONVO_SECRET_KEY: la misma llave secreta usada en crear-pago.js (se usa aquí solo para
//     consultar el método de pago y determinar si fue tarjeta o SINPE — ya no para confirmar el
//     pago en sí, que ahora se confía directamente al contenido de "payment-intent.succeeded").
//   - ONVO_WEBHOOK_SECRET: el "Secreto de firma" que se ve en el panel de ONVO Pay, en
//     Webhooks → (el endpoint de vidavitalqr.com) → Secreto de firma → Mostrar.
// Ninguna de las dos debe escribirse en este archivo ni en ningún otro que se suba al repositorio.

const { S3Client } = require('@aws-sdk/client-s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { agregarIngreso } = require('./lib/ingresos');

const ONVO_API_BASE = 'https://api.onvopay.com/v1';
// ---- reporte de pagos confirmados: este aviso llega solo al administrador (nunca se muestra ni
// se pide en el mockup de checkout), igual que la confirmación que ONVO Pay le envía al comprador
// a través de "customerEmail" (ver crear-pago.js) ----
const DESTINATARIO = 'roljamher@hotmail.com';
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';

// ---- bucket/llave del Registro de Ingresos (mismo bucket privado que resumen.xlsx) ----
const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const REGISTRO_INGRESOS_KEY = 'registro-ingresos.xlsx';

function getS3Client() {
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Faltan configurar S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en Netlify.');
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

// ---- eventos que solo se reconocen (200 OK) sin disparar ninguna acción — pasos intermedios del
// flujo de SINPE Móvil que ONVO puede enviar antes del "succeeded" definitivo ----
const EVENTOS_INFORMATIVOS_SINPE = ['payment-intent.deferred', 'mobile-transfer.received'];

// ---- etiquetas legibles de cada producto del catálogo (deben coincidir con PRECIOS en
// crear-pago.js) -- se usan para que el aviso de pago al administrador muestre el nombre real del
// producto en vez del identificador interno (ej. "plate_personal") ----
const ETIQUETAS_ITEM = {
  renewal:          'Renovación anual VidaVitalQR — Persona',
  renewal_mascota:  'Renovación anual VidaVitalQR — Mascota',
  renewal_objeto:   'Renovación anual VidaVitalQR — Objeto',
  qr_only_personal: 'Código QR (solo digital) — Personal',
  qr_only_objeto:   'Código QR (solo digital) — Objeto',
  plate_personal:   'Placa con código QR — Personal',
  plate_mascota:    'Placa con código QR — Mascota',
  plate_objeto:     'Placa con código QR — Objeto',
  bracelet:         'Pulsera con placa QR',
  chain:            'Cadena con incrustación religiosa',
  idcard:           'Identificador QR',
};

// ---- número (1-4, izquierda a derecha en el landing) y medidas de cada estilo de placa -- mismo
// criterio que etiquetaPlacaEstilo() en send-ficha.js, ver bitácora punto 39 ----
const ETIQUETAS_PLACA_ESTILO = {
  clasica: 'Placa 1 — Clásica (rectangular), 40 x 20 mm',
  llavero: 'Placa 2 — Llavero (con orificio), 40 x 22 mm',
  ranuras: 'Placa 3 — Con ranuras laterales, 45 x 25 mm',
  dije:    'Placa 4 — Dije / colgante (con argolla), 40 x 40 mm',
};

// ---- arma la descripción de un producto comprado para el correo de aviso al administrador: el
// nombre real del producto y, si es "plate_personal" con estilo elegido, cuál de las 4 placas ----
function descripcionItem(it) {
  const nombre = ETIQUETAS_ITEM[it.item] || it.item || '?';
  if (it.item === 'plate_personal' && it.placaEstilo && ETIQUETAS_PLACA_ESTILO[it.placaEstilo]) {
    return nombre + ' (' + ETIQUETAS_PLACA_ESTILO[it.placaEstilo] + ')';
  }
  return nombre;
}

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
  const data = payload.data;

  if (!data || !data.id) {
    return { statusCode: 200, body: 'ok (evento sin id, se ignora)' };
  }

  if (EVENTOS_INFORMATIVOS_SINPE.indexOf(tipoEvento) !== -1) {
    // pasos intermedios del flujo de SINPE Móvil (transferencia detectada, pago en proceso) —
    // se reconocen para que ONVO no los reintente, pero no confirman nada todavía
    console.log('onvo-webhook: evento informativo de SINPE recibido (', tipoEvento, ') — payment intent', data.id, '— se espera el "payment-intent.succeeded" definitivo.');
    return { statusCode: 200, body: 'ok (evento informativo: ' + tipoEvento + ')' };
  }

  if (tipoEvento !== 'payment-intent.succeeded') {
    // incluye "checkout-session.succeeded" (a propósito, ver nota arriba: se ignora para no
    // duplicar el correo y la fila del Registro de Ingresos) y cualquier otro evento (fallidos,
    // expirados, suscripciones, etc.) que no nos interese por ahora
    return { statusCode: 200, body: 'ok (evento ignorado: ' + tipoEvento + ')' };
  }

  if (data.status !== 'succeeded') {
    console.log('onvo-webhook: payment intent', data.id, 'no viene con status "succeeded" (', data.status, ') — se ignora por seguridad.');
    return { statusCode: 200, body: 'ok (status inesperado)' };
  }

  const paymentIntentId = data.id;
  const modo = data.mode || 'desconocido';
  const meta = data.metadata || {};

  // ---- metadata.items es un JSON con [{item, folio, tipo, placaEstilo?}, ...] armado por
  // crear-pago.js (placaEstilo solo viene en "plate_personal" -- ver bitácora punto 39); si por
  // algún motivo no viene (por ejemplo, pagos de antes de este cambio), se cae de vuelta a los
  // campos "folio"/"tipo" sueltos que usaba la primera fase ----
  let items = [];
  try {
    if (meta.items) items = JSON.parse(meta.items);
  } catch (e) { /* metadata inválida, se ignora */ }
  if (!items.length && (meta.folio || meta.tipo)) {
    items = [{ item: 'renewal', folio: meta.folio || '', tipo: meta.tipo || '' }];
  }
  const folios = meta.folios || items.filter((it) => it.folio).map((it) => it.folio).join(',');
  const primerFolio = items.find((it) => it.folio) ? items.find((it) => it.folio).folio : '';
  // ---- costo de envío (agregado por crear-pago.js en metadata.envio cuando el carrito incluía
  // algún producto físico) — se reporta aparte en el correo para que quede claro que ese monto
  // adicional es el envío y no un producto más ----
  const envio = meta.envio ? parseFloat(meta.envio) : 0;
  // ---- pago en colones (agregado 2026-09-23, ver crear-pago.js): si el pedido se cobró en CRC,
  // meta.moneda/tipoCambioUsado/totalUSD lo indican, para que el aviso al administrador muestre
  // ambos montos y el tipo de cambio real que se usó en ese pedido específico ----
  const moneda = (data.currency || meta.moneda || 'USD').toUpperCase() === 'CRC' ? 'CRC' : 'USD';
  const tipoCambioUsado = meta.tipoCambioUsado ? parseFloat(meta.tipoCambioUsado) : null;
  const totalUSDReportado = meta.totalUSD ? parseFloat(meta.totalUSD) : null;
  // ---- equivalente informativo en colones (agregado 2026-09-23): cuando el pago fue en USD,
  // crear-pago.js igual intenta calcular a cuántos colones equivale al tipo de cambio del día,
  // solo para mostrarlo aquí como referencia — nunca es el monto realmente cobrado ----
  const totalCRCInformativo = meta.totalCRCInformativo ? parseFloat(meta.totalCRCInformativo) : null;

  // ---- monto real cobrado: viene directo en el evento, en la unidad mínima de la moneda (ej.
  // 367100 = ₡3,671.00) — se usa este valor (y no el reportado en metadata) para el Registro de
  // Ingresos, porque es el que ONVO confirma que efectivamente se cobró ----
  const montoBrutoReal = typeof data.amount === 'number' ? data.amount / 100 : null;
  const refNumber = (data.charges && data.charges[0] && data.charges[0].refNumber) || '';

  console.log('onvo-webhook: pago CONFIRMADO —', items.length, 'producto(s), folios:', folios || '(ninguno)', '— payment intent', paymentIntentId, '— modo', modo, '— moneda', moneda, '— monto', montoBrutoReal);

  // ---- 2) Avisar por correo al administrador (mismo destinatario que ya recibe los demás avisos) ----
  await avisarAdministrador({ items, folios, sessionId: paymentIntentId, modo, envio, moneda, tipoCambioUsado, totalUSDReportado, totalCRCInformativo });

  // ---- 3) Registrar el ingreso, solo para pagos reales (nunca los de prueba, para no ensuciar
  // el Registro de Ingresos con cifras que no son dinero real) ----
  if (modo === 'test') {
    console.log('onvo-webhook: pago de PRUEBA — no se agrega al Registro de Ingresos.');
  } else if (montoBrutoReal === null) {
    console.error('onvo-webhook: el evento no trae "amount" — no se pudo registrar el ingreso de', paymentIntentId);
  } else {
    try {
      const secretKey = process.env.ONVO_SECRET_KEY;
      const medioPago = secretKey ? await medioDePago(data.paymentMethodId, secretKey) : 'Desconocido';
      const cliente = await resolverNombreCliente(primerFolio) || (data.customer && data.customer.name) || '';
      const s3 = getS3Client();
      const resultado = await agregarIngreso(s3, BUCKET_RESUMEN, REGISTRO_INGRESOS_KEY, {
        paymentIntentId,
        fecha: new Date(),
        folio: folios || primerFolio,
        cliente,
        medioPago,
        moneda,
        montoBruto: montoBrutoReal,
        tipoCambio: tipoCambioUsado,
        referencia: refNumber,
        estado: 'Confirmado',
      });
      if (resultado.duplicado) {
        console.log('onvo-webhook: el pago', paymentIntentId, 'ya estaba registrado en el Registro de Ingresos — se omite (reintento del webhook).');
      } else {
        console.log('onvo-webhook: ingreso agregado al Registro de Ingresos, fila', resultado.rowNumber);
      }
    } catch (err) {
      // Un fallo aquí NUNCA debe impedir que el webhook responda 200 — el pago ya está
      // confirmado y el correo ya se envió; si el Registro de Ingresos falla, se agrega a mano
      // con los datos de este correo, y queda este log para diagnosticar el problema.
      console.error('onvo-webhook: no se pudo agregar el ingreso al Registro de Ingresos —', err);
    }
  }

  // TODO (próxima fase): marcar cada ficha (según folio/tipo en "items") como renovada/pagada en
  // S3 (reiniciar su fecha "creado", igual que hace send-ficha.js cuando se envía con
  // esRenovacionPago), y activar el bloqueo del visor público para fichas no pagadas (ver.js) —
  // ambos pendientes según el punto 17 de la bitácora. Los productos físicos/digitales sin folio
  // (placa, pulsera, cadena, Identificador QR, código QR solo digital) no requieren esa marca —
  // su ficha se crea y envía por separado desde el formulario de ficha correspondiente.

  return { statusCode: 200, body: 'ok' };
};

// ---- consulta a ONVO qué tipo de método de pago se usó (tarjeta o SINPE Móvil) ----
// Nunca lanza un error hacia arriba: si la consulta falla o el tipo no se reconoce, devuelve
// "Desconocido" — nunca debe impedir que se registre el ingreso solo porque no se pudo saber el
// medio de pago exacto.
async function medioDePago(paymentMethodId, secretKey) {
  if (!paymentMethodId) return 'Desconocido';
  try {
    const resp = await fetch(ONVO_API_BASE + '/payment-methods/' + encodeURIComponent(paymentMethodId), {
      headers: { Authorization: 'Bearer ' + secretKey },
    });
    const pm = await resp.json().catch(() => null);
    if (!resp.ok || !pm) return 'Desconocido';
    if (pm.type === 'card') return 'Tarjeta';
    if (pm.type === 'mobile_number') return 'SINPE Móvil';
    return pm.type || 'Desconocido';
  } catch (err) {
    console.error('onvo-webhook: no se pudo consultar el método de pago', paymentMethodId, '—', err);
    return 'Desconocido';
  }
}

// ---- busca el nombre real del cliente en su ficha (login/<folio>.json), a partir del folio
// asociado al pago. Devuelve '' si no hay folio o no se encuentra (por ejemplo, productos sin
// ficha propia, como una placa o un código QR solo digital) ----
function carpetaDesdeFolio(folio) {
  const f = String(folio || '').toUpperCase();
  if (f.startsWith('VVMASCOTA')) return 'mascotas';
  if (f.startsWith('VVOBJETO')) return 'objetos';
  return 'personas';
}

function nombreDesdeDatosFormulario(datosFormulario, carpeta) {
  const df = datosFormulario || {};
  if (carpeta === 'personas') return [df.nombres, df.apellidos].filter(Boolean).join(' ');
  return df.nombres || '';
}

async function resolverNombreCliente(folio) {
  if (!folio) return '';
  const carpeta = carpetaDesdeFolio(folio);
  try {
    const s3 = getS3Client();
    let texto;
    try {
      const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: `${carpeta}/login/${folio}.json` }));
      texto = await streamToString(resp.Body);
    } catch (err) {
      const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: `login/${folio}.json` }));
      texto = await streamToString(resp.Body);
    }
    const registro = JSON.parse(texto);
    return nombreDesdeDatosFormulario(registro.datosFormulario, carpeta);
  } catch (err) {
    return ''; // no se encontró el registro — se deja en blanco, no es un error crítico
  }
}

async function avisarAdministrador({ items, folios, sessionId, modo, envio, moneda, tipoCambioUsado, totalUSDReportado, totalCRCInformativo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('onvo-webhook: falta RESEND_API_KEY — no se pudo avisar por correo del pago confirmado.');
    return;
  }

  const listaItems = items.length
    ? items.map((it) => '  - ' + descripcionItem(it) + (it.folio ? ' (folio: ' + it.folio + ')' : '')).join('\n')
    : '  (sin detalle de productos)';
  const lineaEnvio = envio > 0 ? '  - Envío: $' + envio.toFixed(2) + '\n' : '';
  // ---- línea de moneda: si el pedido se cobró en colones, muestra el equivalente en dólares; si
  // se cobró en dólares (la gran mayoría), muestra el equivalente informativo en colones al tipo
  // de cambio del día (agregado 2026-09-23, a pedido del usuario) — en ambos casos nunca es el
  // monto realmente cobrado, solo una referencia ----
  const lineaMoneda = moneda === 'CRC'
    ? 'Cobrado en: colones (CRC)' + (totalUSDReportado ? ' — equivalente a $' + totalUSDReportado.toFixed(2) : '') + (tipoCambioUsado ? ' — tipo de cambio usado: ₡' + tipoCambioUsado : '') + '\n'
    : (totalCRCInformativo ? 'Cobrado en: dólares (USD) — equivalente informativo: ₡' + totalCRCInformativo.toLocaleString('es-CR') + (tipoCambioUsado ? ' (tipo de cambio del día: ₡' + tipoCambioUsado + ')' : '') + '\n' : '');

  const asunto = 'Pago confirmado — ' + items.length + ' producto(s)' + (moneda === 'CRC' ? ' (₡)' : '') + (modo === 'test' ? ' (MODO PRUEBA)' : '');
  const cuerpo = [
    'ONVO Pay confirmó un pago de VidaVitalQR.',
    '',
    'Productos:',
    listaItems + (lineaEnvio ? '\n' + lineaEnvio.trimEnd() : ''),
    '',
    'Folios asociados: ' + (folios || '(ninguno)'),
    'Sesión de ONVO Pay: ' + sessionId,
    'Modo: ' + modo + (modo === 'test' ? ' (pago de prueba, sin dinero real)' : ''),
    lineaMoneda.trimEnd(),
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
        '<li style="margin-bottom:6px;"><strong style="color:#0a7d3c;font-size:15px;">' + escaparHtml(descripcionItem(it)) + '</strong>' +
        (it.folio ? ' &nbsp;<span style="color:#555;">(folio: ' + escaparHtml(it.folio) + ')</span>' : '') +
        '</li>'
      ).join('') + (envio > 0 ? '<li style="margin-bottom:6px;"><strong style="color:#555;font-size:15px;">Envío</strong> &nbsp;<span style="color:#555;">$' + envio.toFixed(2) + '</span></li>' : '') + '</ul>'
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
    '<strong>Modo:</strong> ' + escaparHtml(modo) + (modo === 'test' ? ' (pago de prueba, sin dinero real)' : '') +
      (moneda === 'CRC'
        ? '<br><strong>Cobrado en:</strong> colones (CRC)' + (totalUSDReportado ? ' — equivalente a $' + totalUSDReportado.toFixed(2) : '') + (tipoCambioUsado ? ' — tipo de cambio usado: ₡' + tipoCambioUsado : '')
        : (totalCRCInformativo ? '<br><strong>Cobrado en:</strong> dólares (USD) — equivalente informativo: ₡' + totalCRCInformativo.toLocaleString('es-CR') + (tipoCambioUsado ? ' (tipo de cambio del día: ₡' + tipoCambioUsado + ')' : '') : '')) +
      '</p>',
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
