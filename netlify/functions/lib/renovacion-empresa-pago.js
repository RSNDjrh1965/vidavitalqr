// ---- lib/renovacion-empresa-pago.js (Etapa 3, 2026-10-22) ----
// Lo llama onvo-webhook.js cuando ONVO confirma un pago cuyo metadata trae "renovacionEmpresa" (lo pone
// renovacion-empresa.js). Aplica la renovación a todas las fichas activas de la empresa, le confirma a la empresa
// por correo, le avisa a James y anota el ingreso. Es idempotente: cada pago de ONVO se procesa una sola vez
// (se anota en empresas/<id>/renovaciones.json). Si falla ANTES de renovar, se lanza el error (el webhook responde
// 500 y ONVO reintenta).
// BAJAS (2026-10-28): si el pago trae metadata.bajasId, se leen los folios de baja guardados al crear el pago
// (empresas/<id>/bajas-pendientes/<token>.json): esas fichas NO se renuevan (siguen su cronología normal de vencimiento)
// y a cada titular se le avisa por correo que, si desea continuar con VidaVitalQR, debe solicitar su código de forma individual.
const { leerJson, escribirJson, idEmpresaValido, claveLote } = require('./empresa');
const { BUCKET_RESUMEN } = require('./lote-empresa');
const { infoRenovacion, aplicarRenovacion, normalizarBajas } = require('./renovacion-empresa');
const { fechaVencimiento, finGracia } = require('./vigencia');
const { lineasFactura } = require('./factura');

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
const URL_SITIO = 'https://vidavitalqr.com';
const fecha = (iso) => new Date(iso).toLocaleDateString('es-CR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Costa_Rica' });

// Aviso al TITULAR de una ficha dada de baja por su empresa. Devuelve { folio, enviado, motivo? }.
async function avisarBajaATitular(s3, apiKey, folio, nombreEmpresa) {
  try {
    const login = await leerJson(s3, BUCKET_RESUMEN, `personas/login/${folio}.json`);
    if (!login) return { folio, enviado: false, motivo: 'no se encontró el registro de acceso de la ficha' };
    const df = login.datosFormulario || {};
    const correo = (login.correoTitular && String(login.correoTitular).trim()) || (df.emailcontacto1 && String(df.emailcontacto1).trim()) || '';
    if (!correo) return { folio, enviado: false, motivo: 'la ficha no tiene un correo registrado' };
    if (!apiKey) return { folio, enviado: false, motivo: 'falta RESEND_API_KEY' };
    const nombre = [df.nombres, df.apellidos].filter(Boolean).join(' ') || 'colaborador(a)';
    const venc = login.creado ? fechaVencimiento(login.creado) : null;
    const gracia = login.creado ? finGracia(login.creado) : null;
    const texto = [
      `Hola ${nombre},`, '',
      `${nombreEmpresa} nos informó que usted ya no forma parte de la empresa y, por eso, su ficha de VidaVitalQR (folio ${folio}) no se incluyó en la renovación anual que paga la empresa.`, '',
      venc ? `Su ficha sigue funcionando con normalidad hasta el ${fecha(venc)}.` : 'Su ficha sigue funcionando con normalidad hasta que termine su vigencia actual.',
      venc && gracia ? `Después de esa fecha pasa por el proceso de vencimiento de siempre: queda "vencida" (con la información básica de emergencia aún visible) hasta el ${fecha(gracia)} y luego se elimina por completo. Le enviaremos los avisos correspondientes.` : '', '',
      'SI DESEA CONTINUAR CON VIDAVITALQR, debe solicitar su código de forma individual (ya no puede renovarlo la empresa). Puede hacerlo cuando quiera, antes o después de esa fecha, aquí:',
      URL_SITIO, '',
      'Si cree que se trata de un error, converse con su empresa. Para cualquier duda, escríbanos por WhatsApp al +506 6093-3090.', '',
      'Este es un correo automático de VidaVitalQR.',
    ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
    await enviarCorreo(apiKey, { to: correo, subject: 'Su ficha VidaVitalQR ya no será renovada por su empresa', text: texto });
    return { folio, enviado: true };
  } catch (e) {
    return { folio, enviado: false, motivo: e && e.message ? e.message : String(e) };
  }
}

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
  // ---- bajas guardadas al crear el pago (solo por token; nunca se confía en datos del navegador) ----
  let bajas = [];
  if (meta.bajasId) {
    const token = String(meta.bajasId);
    const rec = /^[a-f0-9]{16}$/.test(token) ? await leerJson(s3, BUCKET_RESUMEN, `empresas/${empresaId}/bajas-pendientes/${token}.json`) : null;
    if (!rec || !Array.isArray(rec.folios)) {
      await avisoAdmin('⚠ Renovación de empresa: NO se encontró la lista de bajas', `ONVO confirmó el pago ${paymentIntentId} de la empresa ${empresaId}, pero no se encontró la lista de bajas (token ${token}). NO se renovó automáticamente: renueve a mano con la herramienta, excluyendo a los folios dados de baja (revise el pago en ONVO).`);
      return;
    }
    bajas = normalizarBajas(rec.folios);
  }
  const info = await infoRenovacion(s3, empresaId, undefined, bajas);
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

  if (bajas.length && moneda === 'USD' && esperado && Math.abs(info.precio.totalUSD - esperado) > 0.011) {
    await avisoAdmin('⚠ Renovación de empresa: el total con bajas NO coincide', `Empresa ${info.nombre} (${empresaId}). Al crear el pago se cobraron $${esperado}, pero con las bajas el total actual sería $${info.precio.totalUSD} (cambió el número de fichas activas). Pago ${paymentIntentId}. NO se renovó automáticamente: revise y renueve a mano.`);
    return;
  }

  // inicio de los 12 meses nuevos: el vencimiento actual si todavía no vence (no se pierde tiempo pagado), o hoy si ya venció
  const ahora = new Date();
  const venc = new Date(info.vencimiento);
  const inicio = ahora < venc ? venc : ahora;
  const res = await aplicarRenovacion(s3, empresaId, inicio.toISOString(), bajas, paymentIntentId);

  hist.pagos = (hist.pagos || []).concat([{ paymentIntentId, fecha: ahora.toISOString(), modo, totalUSD: esperado || null, fichasRenovadas: res.fichasRenovadas, vencimiento: res.vencimiento, bajas: res.fichasNoRenovadas }]);
  await escribirJson(s3, BUCKET_RESUMEN, claveRenovaciones(empresaId), hist);

  // ---- aviso a cada titular dado de baja ----
  const avisosBaja = [];
  for (const fb of res.fichasNoRenovadas) avisosBaja.push(await avisarBajaATitular(s3, apiKey, fb, info.nombre));

  let facturaEmpresa = null;
  try { const lt = await leerJson(s3, BUCKET_RESUMEN, claveLote(empresaId)); facturaEmpresa = (lt && lt.factura) || null; } catch (e) { /* sin datos de factura: el aviso sale igual */ }
  const etiqueta = modo === 'test' ? ' (MODO PRUEBA)' : '';
  if (apiKey && info.correo) {
    try {
      await enviarCorreo(apiKey, { to: info.correo, subject: `Renovación confirmada — ${info.nombre}${etiqueta}`, text: [
        `Hola, equipo de ${info.nombre}:`, '',
        `Recibimos el pago de la renovación anual de sus Identificadores QR de VidaVitalQR. Se renovaron ${res.fichasRenovadas} ficha(s) activa(s).`,
        `Nueva fecha de vencimiento: ${fecha(res.vencimiento)}.`, '',
        'No tienen que hacer nada más: las fichas de sus colaboradores siguen funcionando igual. Les avisaremos antes del próximo vencimiento.',
        ...(res.fichasNoRenovadas.length ? ['', `No se renovaron ${res.fichasNoRenovadas.length} ficha(s) por baja (${res.fichasNoRenovadas.join(', ')}). Esas fichas siguen su proceso normal de vencimiento y le avisamos por correo a cada titular que, si desea continuar con VidaVitalQR, debe solicitar su código de forma individual.`] : []),
        '',
        'Cualquier consulta: WhatsApp +506 6093-3090.', '', 'Este es un correo automático de VidaVitalQR.',
      ].join('\n') });
    } catch (e) { console.error('renovacion-empresa-pago: no se pudo enviar el correo a la empresa —', e.message); }
  }
  await avisoAdmin(`Renovación de empresa pagada — ${info.nombre}${etiqueta}`, [
    'ONVO Pay confirmó el pago de una renovación de empresa.', '',
    `Empresa: ${info.nombre} (${empresaId})`, `Correo: ${info.correo || ''}`,
    `Fichas renovadas: ${res.fichasRenovadas} de ${info.activas} activas — cobradas ${meta.cantidad || info.precio.fichasCobradas} a $${info.precio.precioUnitario} c/u, total $${esperado || info.precio.totalUSD}`,
    ...(res.fichasNoRenovadas.length ? [`BAJAS (no renovadas, siguen su cronología de vencimiento): ${res.fichasNoRenovadas.join(', ')}`,
      ...avisosBaja.map((a) => `   ${a.folio}: ${a.enviado ? 'se le avisó por correo al titular' : '⚠ NO se pudo avisar al titular (' + a.motivo + ') — avísele usted'}`)] : []),
    `Nuevo vencimiento: ${fecha(res.vencimiento)}`, `Pago ONVO: ${paymentIntentId} — modo ${modo}`,
    ...(facturaEmpresa ? ['', ...lineasFactura(facturaEmpresa)] : ['', 'Factura: esta empresa no tiene datos de factura guardados (pedido anterior a esta función) — pídaselos si los necesita.']),
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
