// ---- lib/pedido-empresa-pago.js (Etapa 2 de tarjetas para empresas, 2026-10-22) ----
// Lo llama onvo-webhook.js cuando ONVO confirma un pago cuyo metadata trae "pedidoEmpresa": crea el lote
// de folios de la empresa, le envía los enlaces por correo (con un CSV adjunto), le avisa a James y anota
// el ingreso. Es idempotente: si ONVO reintenta el webhook, el pedido ya "pagado" no se procesa dos veces.
// Si algo falla ANTES de crear el lote, se lanza el error (el webhook responde 500 y ONVO reintenta).
const { leerJson, escribirJson } = require('./empresa');
const { BUCKET_RESUMEN, crearLoteDePedido, clavePedido, PEDIDO_ID_RE, PRECIO_RENOVACION, MIN_FICHAS_RENOVACION } = require('./lote-empresa');
const { firmarEmpresa } = require('./enlace-qr');

const SITE_URL = process.env.SITE_URL || 'https://vidavitalqr.com';
const enlaceRenovacion = (empresaId) => `${SITE_URL}/empresas.html?renovar=${encodeURIComponent(empresaId)}&t=${firmarEmpresa(empresaId)}`;

// plazos de la tarjeta impresa (acordados con James, 2026-10-23); los aplica preparar-impresion.js
const PLAZOS = ' Plazos: después del pago, la empresa tiene 2 semanas para que todos sus colaboradores completen la ficha; la impresión se realiza en la tercera semana posterior al pago y el envío (o entrega) en la cuarta. Le enviaremos un recordatorio con los folios pendientes antes de la impresión; las fichas que se completen después se imprimen en un lote adicional.';
const RECORDATORIO_FONDO = ' Si alguien cambia el fondo de pantalla o actualiza su celular y la imagen se pierde, puede volver a ponerla desde sus fotos, o descargarla otra vez desde su ficha.';
const DESTINATARIO = 'roljamher@hotmail.com';
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';

async function enviarCorreo(apiKey, { to, subject, text, attachments }) {
  const body = { from: REMITENTE, to: Array.isArray(to) ? to : [to], subject, text };
  if (attachments && attachments.length) body.attachments = attachments;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let det = ''; try { det = await r.text(); } catch (e) {}
    throw new Error('Resend ' + r.status + ' ' + det.slice(0, 300));
  }
}

function csvDe(enlaces) {
  const filas = ['Folio,Enlace para llenar la ficha'].concat(enlaces.map((e) => `${e.folio},${e.enlace}`));
  return '﻿' + filas.join('\r\n') + '\r\n';
}

async function procesarPedidoEmpresa(ctx) {
  const { s3, meta, paymentIntentId, modo, moneda, montoBrutoReal, refNumber, tipoCambioUsado, totalCRCInformativo,
    agregarIngreso, registroKey, medioPago } = ctx;
  const apiKey = process.env.RESEND_API_KEY;
  const pedidoId = String(meta.pedidoEmpresa || '');
  const avisoAdmin = async (asunto, texto) => {
    if (!apiKey) return;
    try { await enviarCorreo(apiKey, { to: DESTINATARIO, subject: asunto, text: texto }); }
    catch (e) { console.error('pedido-empresa-pago: no se pudo avisar al administrador —', e.message); }
  };

  if (!PEDIDO_ID_RE.test(pedidoId)) {
    await avisoAdmin('⚠ Pago de empresa SIN pedido válido', `ONVO confirmó el pago ${paymentIntentId} pero el pedido "${pedidoId}" no es válido. Revise el pago en ONVO.`);
    return;
  }
  const pedido = await leerJson(s3, BUCKET_RESUMEN, clavePedido(pedidoId));
  if (!pedido) {
    await avisoAdmin('⚠ Pago de empresa: pedido no encontrado', `ONVO confirmó el pago ${paymentIntentId} (${meta.correoCliente || ''}) pero no existe el pedido ${pedidoId} en S3. Revise y cree el lote a mano con la herramienta.`);
    return;
  }
  if (pedido.estado === 'pagado' && pedido.empresaId) {
    console.log('pedido-empresa-pago: el pedido', pedidoId, 'ya estaba procesado (reintento del webhook) — se omite.');
    return;
  }

  // el monto cobrado debe coincidir con el del pedido (en dólares; en colones se omite la comparación exacta)
  if (moneda === 'USD' && typeof montoBrutoReal === 'number' && Math.abs(montoBrutoReal - pedido.totalUSD) > 0.011) {
    pedido.estado = 'revisar';
    pedido.nota = `Monto cobrado ${montoBrutoReal} distinto del esperado ${pedido.totalUSD}`;
    pedido.paymentIntentId = paymentIntentId;
    await escribirJson(s3, BUCKET_RESUMEN, clavePedido(pedidoId), pedido);
    await avisoAdmin('⚠ Pago de empresa: el monto NO coincide', `Pedido ${pedidoId} (${pedido.nombre}, ${pedido.cantidad} tarjetas). Esperado $${pedido.totalUSD}, cobrado $${montoBrutoReal}. NO se creó el lote automáticamente. Pago: ${paymentIntentId}.`);
    return;
  }

  const lote = await crearLoteDePedido(s3, {
    nombre: pedido.nombre, correo: pedido.correo, telefono: pedido.telefono, cantidad: pedido.cantidad, modalidad: pedido.modalidad === 'digital' ? 'digital' : 'fisica', retiroPersona: pedido.retiroPersona === true,
    logoTipo: pedido.logoTipo, logoBase64: pedido.logoBase64,
  }, { prueba: modo === 'test', fechaPago: new Date().toISOString(), pedidoId, autorizaLogoFecha: pedido.autorizaLogoFecha });

  // se marca pagado de inmediato (y se descarta el logo del pedido: ya quedó en la carpeta de la empresa)
  pedido.estado = 'pagado';
  pedido.empresaId = lote.empresaId;
  pedido.pagado = new Date().toISOString();
  pedido.paymentIntentId = paymentIntentId;
  pedido.modo = modo;
  pedido.folioInicial = lote.folios[0];
  pedido.folioFinal = lote.folios[lote.folios.length - 1];
  delete pedido.logoBase64;
  await escribirJson(s3, BUCKET_RESUMEN, clavePedido(pedidoId), pedido);

  const listaEnlaces = lote.enlaces.map((e, i) => `${i + 1}. ${e.folio}\n   ${e.enlace}`).join('\n');
  const csvB64 = Buffer.from(csvDe(lote.enlaces), 'utf-8').toString('base64');
  const etiquetaPrueba = modo === 'test' ? ' (MODO PRUEBA)' : '';
  const digital = pedido.modalidad === 'digital';
  const retiro = pedido.retiroPersona === true && !digital;
  const linkRenov = firmarEmpresa(lote.empresaId) ? enlaceRenovacion(lote.empresaId) : '';

  // ---- correo a la empresa ----
  if (apiKey) {
    const texto = [
      `Gracias por su pedido en VidaVitalQR. Recibimos el pago de ${pedido.cantidad} tarjeta(s) Identificador QR ${digital ? '(solo digital, sin impresión) ' : ''}para ${pedido.nombre}.`,
      '',
      'Cómo seguir:',
      '1. Reparta un enlace a cada colaborador (abajo, y también en el archivo adjunto "enlaces.csv").',
      '2. Cada colaborador abre SU enlace en su celular y llena su ficha: foto, nombres, cargo, datos de emergencia y la casilla de privacidad. Cada enlace sirve para UNA sola persona.',
      '3. Al terminar, el colaborador recibe su PIN personal (la empresa no lo conoce) y puede descargar su tarjeta como imagen para la pantalla de bloqueo del celular.',
      digital
        ? '4. Esta modalidad no incluye tarjetas impresas: cada colaborador conserva su tarjeta digital (imagen) y su imagen de pantalla de bloqueo en su celular.' + RECORDATORIO_FONDO
        : (retiro
          ? '4. Usted eligió retirar las tarjetas en persona (sin costo de envío). Cuando sus colaboradores hayan completado sus fichas, nos pondremos en contacto con usted para coordinar dónde y cuándo retirarlas.' + PLAZOS
          : '4. Cuando sus colaboradores hayan completado sus fichas, nos pondremos en contacto con usted para coordinar la entrega de las tarjetas impresas.' + PLAZOS),
      '',
      `Vigencia: 12 meses desde hoy. La renovación la realiza la empresa con un solo pago por todo el grupo ($${PRECIO_RENOVACION} por ficha activa, mínimo ${MIN_FICHAS_RENOVACION} fichas, más IVA); le avisaremos antes de que venza. También le avisaremos si pasan los meses y hay enlaces sin usar.`,
      ...(linkRenov ? ['', 'Enlace para renovar (guárdelo; sirve cuando se acerque el vencimiento):', linkRenov] : []),
      '',
      `Enlaces (${lote.enlaces.length}):`,
      listaEnlaces,
      '',
      'Si necesita ayuda, escríbanos por WhatsApp al 6093-3090.',
      '',
      'Este es un correo automático de VidaVitalQR.',
    ].join('\n');
    try {
      await enviarCorreo(apiKey, { to: pedido.correo, subject: `Su pedido de tarjetas VidaVitalQR — ${pedido.cantidad} enlace(s) para sus colaboradores${etiquetaPrueba}`, text: texto, attachments: [{ filename: 'enlaces.csv', content: csvB64 }] });
    } catch (e) { console.error('pedido-empresa-pago: no se pudo enviar el correo a la empresa —', e.message); }
  }

  // ---- correo a James ----
  await avisoAdmin(`Pedido de empresa pagado — ${pedido.nombre} — ${pedido.cantidad} tarjeta(s)${etiquetaPrueba}`, [
    'ONVO Pay confirmó el pago de un pedido de tarjetas para empresa.',
    '',
    `Empresa: ${pedido.nombre}`,
    `Correo: ${pedido.correo}${pedido.telefono ? '   Teléfono: ' + pedido.telefono : ''}`,
    `Modalidad: ${digital ? 'SOLO DIGITAL (no hay que imprimir ni enviar nada)' : 'TARJETA IMPRESA (hay que imprimir y coordinar la entrega)'}`,
    ...(retiro ? ['⚠ RETIRO EN PERSONA — NO enviar por correo postal: la empresa pasa a retirar las tarjetas (coordinar con su teléfono).'] : []),
    `Tarjetas: ${pedido.cantidad} a $${pedido.precioUnitario} c/u${pedido.envio ? ' + envío $' + pedido.envio : ''} — subtotal $${pedido.subtotal}, IVA $${pedido.iva}, total $${pedido.totalUSD}`,
    `Folios: ${lote.folios[0]} a ${lote.folios[lote.folios.length - 1]}`,
    `Carpeta en S3: empresas/${lote.empresaId}/`,
    `Logo autorizado por la empresa (casilla marcada el ${pedido.autorizaLogoFecha}).`,
    `Pago ONVO: ${paymentIntentId} — modo ${modo}`,
    '',
    digital
      ? 'Ya se creó el lote y se enviaron los enlaces a la empresa. Es solo digital: no queda nada pendiente de su parte.'
      : 'Ya se creó el lote y se enviaron los enlaces a la empresa. Pendiente de su parte: cuando los colaboradores completen las fichas, imprimir y coordinar la entrega.',
    '',
    'Enlaces:',
    listaEnlaces,
  ].join('\n'));

  // ---- Registro de Ingresos (solo pagos reales) ----
  if (modo === 'test') { console.log('pedido-empresa-pago: pago de PRUEBA — no se agrega al Registro de Ingresos.'); return; }
  if (montoBrutoReal === null || montoBrutoReal === undefined) { console.error('pedido-empresa-pago: el evento no trae "amount" — no se registró el ingreso.'); return; }
  try {
    const r = await agregarIngreso(s3, BUCKET_RESUMEN, registroKey, {
      paymentIntentId, fecha: new Date(), folio: `${lote.folios[0]}…${lote.folios[lote.folios.length - 1]}`,
      cliente: pedido.nombre, medioPago: await medioPago(), moneda, montoBruto: montoBrutoReal,
      tipoCambio: tipoCambioUsado, referencia: refNumber, estado: 'Confirmado',
    });
    console.log('pedido-empresa-pago: ingreso', r.duplicado ? 'ya registrado' : 'agregado, fila ' + r.rowNumber);
  } catch (e) { console.error('pedido-empresa-pago: no se pudo agregar el ingreso —', e); }
}

module.exports = { procesarPedidoEmpresa };
