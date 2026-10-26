// ---- lib/renovacion-empresa-pago.js (Etapa 3, 2026-10-22) ----
// Lo llama onvo-webhook.js cuando ONVO confirma un pago cuyo metadata trae "renovacionEmpresa" (lo pone
// renovacion-empresa.js). Aplica la renovación a todas las fichas activas de la empresa, le confirma a la empresa
// por correo, le avisa a James y anota el ingreso. Es idempotente: cada pago de ONVO se procesa una sola vez
// (se anota en empresas/<id>/renovaciones.json). Si falla ANTES de renovar, se lanza el error (el webhook responde
// 500 y ONVO reintenta).
const { leerJson, escribirJson, idEmpresaValido } = require('./empresa');
const { BUCKET_RESUMEN } = require('./lote-empresa');
const { infoRenovacion, aplicarRenovacion } = require('./renovacion-empresa');

const DESTINATARIO = 'roljamher@hotmail.com';
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';
const claveRenovaciones = (id) => `empresas/${id}/renovaciones.json`;

async function enviarCorreo(apiKey, { to, subject, text }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: REMITENTE, to: Array.isArray(to) ? to : [to], subject, text }),
  });
  if (!r.ok) { let det = ''; try { det = await r.text(); } catch (e) {} throw new Error('Resend ' + r.status + ' ' + det.slice(0, 300)); }
}
const fecha = (iso) => new Date(iso).toLocaleDateString('es-CR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Costa_Rica' });

async function procesarRenovacionEmpresa(ctx) {
  const { s3, meta, paymentIntentId, modo, moneda, montoBrutoReal, refNumber, tipoCambioUsado, agregarIngreso, registroKey, medioPago } = ctx;
  const apiKey = process.env.RESEND_API_KEY;
  const empresaId = String(meta.renovacionEmpresa || '').toLowerCase();
  const avisoAdmin = async (subject, text) => {
    if (!apiKey) return;
    try { await enviarCorreo(apiKey, { to: DESTINATARIO, subject, text }); } catch (e) { console.error('renovacion-empresa-pago: no se pudo avisar al administrador —', e.message); }
  };
  if (!idEmpresaValido(empresaId)) {
    await avisoAdmin('⚠ Renovación de empresa SIN empresa válida', `ONVO confirmó el pago ${paymentIntentId} pero la empresa "${empresaId}" no es válida. Revise el pago en ONVO.`);
    return;
  }
  const hist = (await leerJson(s3, BUCKET_RESUMEN, claveRenovaciones(empresaId))) || { pagos: [] };
  if ((hist.pagos || []).some((p) => p.paymentIntentId === paymentIntentId)) {
    console.log('renovacion-empresa-pago: el pago', paymentIntentId, 'ya estaba procesado (reintento del webhook) — se omite.');
    return;
  }
  const info = await infoRenovacion(s3, empresaId);
  if (!info) {
    await avisoAdmin('⚠ Renovación de empresa: empresa no encontrada', `ONVO confirmó el pago ${paymentIntentId} (${meta.correoCliente || ''}) pero no existe la empresa ${empresaId}. Revise el pago y renueve a mano con la herramienta.`);
    return;
  }
  // el monto debe coincidir con el calculado al crear el pago (metadata.totalUSD, que solo pone el servidor)
  const esperado = Number(meta.totalUSD);
  if (moneda === 'USD' && typeof montoBrutoReal === 'number' && esperado && Math.abs(montoBrutoReal - esperado) > 0.011) {
    await avisoAdmin('⚠ Renovación de empresa: el monto NO coincide', `Empresa ${info.nombre} (${empresaId}). Esperado $${esperado}, cobrado $${montoBrutoReal}. Pago ${paymentIntentId}. NO se renovó automáticamente.`);
    return;
  }

  // inicio de los 12 meses nuevos: el vencimiento actual si todavía no vence (no se pierde tiempo pagado), o hoy si ya venció
  const ahora = new Date();
  const venc = new Date(info.vencimiento);
  const inicio = ahora < venc ? venc : ahora;
  const res = await aplicarRenovacion(s3, empresaId, inicio.toISOString());

  hist.pagos = (hist.pagos || []).concat([{ paymentIntentId, fecha: ahora.toISOString(), modo, totalUSD: esperado || null, fichasRenovadas: res.fichasRenovadas, vencimiento: res.vencimiento }]);
  await escribirJson(s3, BUCKET_RESUMEN, claveRenovaciones(empresaId), hist);

  const etiqueta = modo === 'test' ? ' (MODO PRUEBA)' : '';
  if (apiKey && info.correo) {
    try {
      await enviarCorreo(apiKey, { to: info.correo, subject: `Renovación confirmada — ${info.nombre}${etiqueta}`, text: [
        `Hola, equipo de ${info.nombre}:`, '',
        `Recibimos el pago de la renovación anual de sus Identificadores QR de VidaVitalQR. Se renovaron ${res.fichasRenovadas} ficha(s) activa(s).`,
        `Nueva fecha de vencimiento: ${fecha(res.vencimiento)}.`, '',
        'No tienen que hacer nada más: las fichas de sus colaboradores siguen funcionando igual. Les avisaremos antes del próximo vencimiento.', '',
        'Cualquier consulta: WhatsApp +506 6093-3090.', '', 'Este es un correo automático de VidaVitalQR.',
      ].join('\n') });
    } catch (e) { console.error('renovacion-empresa-pago: no se pudo enviar el correo a la empresa —', e.message); }
  }
  await avisoAdmin(`Renovación de empresa pagada — ${info.nombre}${etiqueta}`, [
    'ONVO Pay confirmó el pago de una renovación de empresa.', '',
    `Empresa: ${info.nombre} (${empresaId})`, `Correo: ${info.correo || ''}`,
    `Fichas renovadas: ${res.fichasRenovadas} de ${info.activas} activas — cobradas ${meta.cantidad || info.precio.fichasCobradas} a $${info.precio.precioUnitario} c/u, total $${esperado || info.precio.totalUSD}`,
    `Nuevo vencimiento: ${fecha(res.vencimiento)}`, `Pago ONVO: ${paymentIntentId} — modo ${modo}`,
    ...(res.errores.length ? ['', 'ERRORES (revisar):', ...res.errores] : []),
  ].join('\n'));

  if (modo === 'test') { console.log('renovacion-empresa-pago: pago de PRUEBA — no se agrega al Registro de Ingresos.'); return; }
  if (montoBrutoReal === null || montoBrutoReal === undefined) { console.error('renovacion-empresa-pago: el evento no trae "amount" — no se registró el ingreso.'); return; }
  try {
    const r = await agregarIngreso(s3, BUCKET_RESUMEN, registroKey, {
      paymentIntentId, fecha: new Date(), folio: `Renovación ${info.nombre}`, cliente: info.nombre, medioPago: await medioPago(),
      moneda, montoBruto: montoBrutoReal, tipoCambio: tipoCambioUsado, referencia: refNumber, estado: 'Confirmado',
    });
    console.log('renovacion-empresa-pago: ingreso', r.duplicado ? 'ya registrado' : 'agregado, fila ' + r.rowNumber);
  } catch (e) { console.error('renovacion-empresa-pago: no se pudo agregar el ingreso —', e); }
}

module.exports = { procesarRenovacionEmpresa };
