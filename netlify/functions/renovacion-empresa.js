// ---- renovacion-empresa.js (Etapa 3: renovación de empresas con pago por ONVO, 2026-10-22) ----
// La página /empresas.html?renovar=<empresaId>&t=<firma> llama aquí:
//   GET  ?e=<empresaId>&t=<firma>   -> resumen de la renovación (nombre, vencimiento, fichas activas, precio)
//   POST { e, t, accion:'calcular', bajas? } -> recalcula el resumen EXCLUYENDO los folios de baja (no cobra nada)
//   POST { e, t, moneda?, bajas? }  -> crea el pago en ONVO Pay y devuelve la URL
// BAJAS (2026-10-28): "bajas" = folios de colaboradores que ya no están en la empresa (texto, uno por línea). No se renuevan ni
// se cobran; siguen su cronología normal de vencimiento y se les avisa que, si quieren continuar, soliciten su código individual.
// Los folios se validan contra los de ESTA empresa y se guardan en S3 (empresas/<id>/bajas-pendientes/<token>.json); al ONVO
// confirmar el pago, el webhook lee ese registro por el token (metadata.bajasId) — nunca se confía en lo que traiga el navegador.
// El enlace lleva una firma (lib/enlace-qr.js) que solo se entrega por correo a la empresa; con ella SOLO se puede ver
// el resumen y pagar: no da acceso a ningún dato de los colaboradores. El total se calcula siempre aquí. Cuando ONVO
// confirma el pago, onvo-webhook.js (metadata.renovacionEmpresa) aplica la renovación (lib/renovacion-empresa-pago.js).
const crypto = require('crypto');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { estaBloqueado, anotar, ipDe } = require('./lib/limite');
const { idEmpresaValido, escribirJson } = require('./lib/empresa');
const { firmaEmpresaValida } = require('./lib/enlace-qr');
const { BUCKET_RESUMEN } = require('./lib/lote-empresa');
const { infoRenovacion, normalizarBajas } = require('./lib/renovacion-empresa');

const ONVO_API_BASE = 'https://api.onvopay.com/v1';
const TIPO_CAMBIO_KEY = 'config/tipo-cambio.json';

function getS3Client() {
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('Faltan configurar S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en Netlify.');
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}
async function streamToString(stream) { const c = []; for await (const x of stream) c.push(x); return Buffer.concat(c).toString('utf-8'); }
async function obtenerTipoCambioGuardado(s3) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: TIPO_CAMBIO_KEY }));
  const tc = Number(JSON.parse(await streamToString(obj.Body)).tipoCambio);
  if (!tc || tc <= 0) throw new Error('El tipo de cambio guardado no es válido.');
  return tc;
}
function resp(status, obj) { return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) }; }

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return resp(405, { error: 'Método no permitido.' });
  let e = '', t = '', monedaRecibida = 'USD', accion = 'pagar', bajasTexto = '';
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    e = String(q.e || '').trim().toLowerCase(); t = String(q.t || '').trim();
  } else {
    let p; try { p = JSON.parse(event.body || '{}'); } catch (err) { return resp(400, { error: 'Datos inválidos.' }); }
    e = String(p.e || '').trim().toLowerCase(); t = String(p.t || '').trim(); monedaRecibida = String(p.moneda || 'USD').trim().toUpperCase();
    accion = p.accion === 'calcular' ? 'calcular' : 'pagar';
    bajasTexto = typeof p.bajas === 'string' ? p.bajas.slice(0, 20000) : (Array.isArray(p.bajas) ? p.bajas.slice(0, 500).join('\n') : '');
  }
  const enlaceInvalido = () => resp(404, { error: 'Este enlace de renovación no es válido. Use el que recibió por correo o escríbanos por WhatsApp al 6093-3090.' });
  if (!idEmpresaValido(e) || !firmaEmpresaValida(e, t)) return enlaceInvalido();

  let s3;
  try { s3 = getS3Client(); } catch (err) { return resp(500, { error: err.message }); }

  // freno de abuso (consultas y pagos desde la misma conexión); si S3 falla, no se bloquea a nadie
  const ip = ipDe(event);
  if (await estaBloqueado(s3, BUCKET_RESUMEN, 'renovacion-empresa-ip', ip, (event.httpMethod === 'POST' && accion === 'pagar') ? 10 : 60, 60 * 60 * 1000)) {
    return resp(429, { error: 'Demasiados intentos desde esta conexión. Intente de nuevo en un rato.' });
  }
  await anotar(s3, BUCKET_RESUMEN, 'renovacion-empresa-ip', ip, 60 * 60 * 1000);

  let info;
  try { info = await infoRenovacion(s3, e, undefined, normalizarBajas(bajasTexto)); } catch (err) {
    console.error('renovacion-empresa: error leyendo la empresa —', err);
    return resp(500, { error: 'No se pudo consultar la empresa. Intente de nuevo.' });
  }
  if (!info) return enlaceInvalido();

  const publico = {
    nombre: info.nombre, vencimiento: info.vencimiento, desde: info.desde, finGracia: info.finGracia, activas: info.activas,
    total: info.total, eliminadas: info.eliminadas, abierta: info.abierta, motivo: info.motivo,
    nuevoVencimiento: info.nuevoVencimiento, fichasCobradas: info.precio.fichasCobradas, precioUnitario: info.precio.precioUnitario,
    subtotal: info.precio.subtotal, iva: info.precio.iva, totalUSD: info.precio.totalUSD, prueba: info.prueba,
    activasNetas: info.activasNetas, bajasValidas: info.bajas.validas, bajasIgnoradas: info.bajas.ignoradas, bajasInvalidas: info.bajas.invalidas,
  };
  if (event.httpMethod === 'GET') return resp(200, publico);
  if (accion === 'calcular') return resp(200, publico);

  // ---- POST: crear el pago ----
  if (info.bajas.invalidas.length) {
    const lista = info.bajas.invalidas.map((b) => `${b.folio} (${b.motivo})`).join('; ');
    return resp(400, { error: 'Revise los folios de baja antes de pagar: ' + lista + '.', bajasInvalidas: info.bajas.invalidas });
  }
  if (info.motivo === 'todas-baja') return resp(400, { error: 'Debe quedar al menos una ficha activa para renovar. Si ninguna se renovará, escríbanos por WhatsApp al 6093-3090.' });
  if (!info.abierta) return resp(400, Object.assign({ error: 'Esta empresa no puede renovar en este momento.' }, { motivo: info.motivo, desde: info.desde }));
  const secretKey = process.env.ONVO_SECRET_KEY;
  if (!secretKey) { console.error('renovacion-empresa: falta ONVO_SECRET_KEY en Netlify.'); return resp(500, { error: 'El pago en línea no está configurado todavía. Intente más tarde.' }); }
  const t0 = info.precio;
  const moneda = monedaRecibida === 'CRC' ? 'CRC' : 'USD';
  if (moneda === 'CRC' && process.env.HABILITAR_PAGO_CRC !== 'true') return resp(400, { error: 'El pago en colones todavía no está habilitado. Pague en dólares mientras tanto.' });
  let currencyOnvo = 'USD'; let unitAmount = Math.round(t0.totalUSD * 100); let tipoCambioUsado = null; let totalCRCInformativo = null;
  try { tipoCambioUsado = await obtenerTipoCambioGuardado(s3); totalCRCInformativo = Math.ceil(t0.totalUSD * tipoCambioUsado); } catch (err) {
    if (moneda === 'CRC') { console.error('renovacion-empresa: no se pudo obtener el tipo de cambio para CRC —', err.message); return resp(503, { error: 'El pago en colones no está disponible en este momento. Puede pagar en dólares.' }); }
  }
  if (moneda === 'CRC') { unitAmount = Math.ceil(totalCRCInformativo * Number(process.env.ONVO_CRC_SUBUNIT_MULTIPLIER || '100')); currencyOnvo = 'CRC'; }

  // ---- bajas: se guardan en S3 con un token y solo el token viaja en la metadata del pago ----
  let bajasId = '';
  if (info.bajas.validas.length) {
    bajasId = crypto.randomBytes(8).toString('hex');
    try {
      await escribirJson(s3, BUCKET_RESUMEN, `empresas/${e}/bajas-pendientes/${bajasId}.json`, { folios: info.bajas.validas, creado: new Date().toISOString(), activas: info.activas, fichasCobradas: t0.fichasCobradas, totalUSD: t0.totalUSD });
    } catch (err) {
      console.error('renovacion-empresa: no se pudo guardar el registro de bajas —', err);
      return resp(500, { error: 'No se pudo guardar la lista de bajas. Intente de nuevo.' });
    }
  }

  const base = process.env.URL || 'https://vidavitalqr.com';
  const volver = `${base}/empresas.html?renovar=${encodeURIComponent(e)}&t=${encodeURIComponent(t)}`;
  const bodyReq = {
    customerName: String(info.nombre || '').slice(0, 60),
    customerEmail: info.correo,
    redirectUrl: `${volver}&pago=exitoso`,
    cancelUrl: `${volver}&pago=cancelado`,
    captureMethod: 'automatic',
    lineItems: [{ quantity: 1, unitAmount, currency: currencyOnvo,
      description: `Renovación anual — Identificador QR para empresas — ${t0.fichasCobradas} ficha(s) a $${t0.precioUnitario} c/u (incluye IVA 13%)${info.bajas.validas.length ? ` — ${info.bajas.validas.length} baja(s) sin renovar` : ''}`, priceType: 'one_time' }],
    metadata: {
      renovacionEmpresa: e, origen: 'vidavitalqr-renovacion-empresa', cantidad: String(t0.fichasCobradas), fichasActivas: String(info.activas),
      bajasId, bajasCantidad: String(info.bajas.validas.length),
      moneda: currencyOnvo, tipoCambioUsado: tipoCambioUsado ? String(tipoCambioUsado) : '',
      totalCRCInformativo: totalCRCInformativo ? String(totalCRCInformativo) : '', totalUSD: t0.totalUSD.toFixed(2), correoCliente: info.correo || '',
    },
  };
  try {
    const r = await fetch(ONVO_API_BASE + '/checkout/sessions/one-time-link', {
      method: 'POST', headers: { Authorization: 'Bearer ' + secretKey, 'Content-Type': 'application/json' }, body: JSON.stringify(bodyReq),
    });
    let json = null; try { json = await r.json(); } catch (err) { /* sin JSON */ }
    if (!r.ok || !json || !json.url) { console.error('renovacion-empresa: ONVO Pay rechazó la creación del checkout —', r.status, JSON.stringify(json)); return resp(502, { error: 'No se pudo crear el pago con ONVO Pay.' }); }
    console.log('renovacion-empresa: renovación de', e, '—', info.activas, 'ficha(s) activas,', info.bajas.validas.length, 'baja(s), total USD', t0.totalUSD, '—', json.id);
    return resp(200, { url: json.url, totalUSD: t0.totalUSD });
  } catch (err) {
    console.error('renovacion-empresa: error al contactar a ONVO Pay —', err);
    return resp(502, { error: 'No se pudo contactar a ONVO Pay.' });
  }
};
