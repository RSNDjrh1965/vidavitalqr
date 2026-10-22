// ---- pedido-empresa.js (Etapa 2 de tarjetas para empresas, 2026-10-22) ----
// Recibe el pedido que la empresa llena en /empresas.html (nombre, correo, cantidad, logo y casilla de
// autorización), lo GUARDA como "pendiente" en el bucket privado (empresas/_pedidos/<id>.json) y crea
// el pago en ONVO Pay. El total se recalcula SIEMPRE aquí, con la tabla de precios por tramos de
// lib/lote-empresa.js (nunca con un monto que mande el navegador). Cuando ONVO confirma el pago,
// onvo-webhook.js (metadata.pedidoEmpresa) crea el lote de folios y envía los enlaces a la empresa.
// Todo pago va por ONVO (decisión de James: control, impuestos e IVA).
const crypto = require('crypto');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { estaBloqueado, anotar, ipDe } = require('./lib/limite');
const { escribirJson } = require('./lib/empresa');
const { BUCKET_RESUMEN, validarPedido, calcularTotales, clavePedido } = require('./lib/lote-empresa');

const ONVO_API_BASE = 'https://api.onvopay.com/v1';
const TIPO_CAMBIO_KEY = 'config/tipo-cambio.json';

function getS3Client() {
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('Faltan configurar S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en Netlify.');
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function obtenerTipoCambioGuardado(s3) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: TIPO_CAMBIO_KEY }));
  const tc = Number(JSON.parse(await streamToString(obj.Body)).tipoCambio);
  if (!tc || tc <= 0) throw new Error('El tipo de cambio guardado no es válido.');
  return tc;
}

function resp(status, obj) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Método no permitido.' });
  const secretKey = process.env.ONVO_SECRET_KEY;
  if (!secretKey) {
    console.error('pedido-empresa: falta ONVO_SECRET_KEY en Netlify.');
    return resp(500, { error: 'El pago en línea no está configurado todavía. Intente más tarde.' });
  }
  let p;
  try { p = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'Datos inválidos.' }); }

  let datos;
  try { datos = validarPedido(p); } catch (err) {
    return resp(err.codigo || 400, { error: err.message });
  }

  let s3;
  try { s3 = getS3Client(); } catch (err) { return resp(500, { error: err.message }); }

  // freno de abuso: máximo 10 pedidos por hora desde la misma conexión (falla "abierta" si S3 falla)
  const VENTANA = 60 * 60 * 1000;
  const ip = ipDe(event);
  if (await estaBloqueado(s3, BUCKET_RESUMEN, 'pedido-empresa-ip', ip, 10, VENTANA)) {
    return resp(429, { error: 'Demasiados pedidos desde esta conexión. Intente de nuevo en un rato o escríbanos por WhatsApp.' });
  }
  await anotar(s3, BUCKET_RESUMEN, 'pedido-empresa-ip', ip, VENTANA);

  const t = calcularTotales(datos.cantidad);
  const monedaRecibida = String(p.moneda || 'USD').trim().toUpperCase();
  const moneda = monedaRecibida === 'CRC' ? 'CRC' : 'USD';
  if (moneda === 'CRC' && process.env.HABILITAR_PAGO_CRC !== 'true') {
    return resp(400, { error: 'El pago en colones todavía no está habilitado. Pague en dólares mientras tanto.' });
  }

  let currencyOnvo = 'USD';
  let unitAmount = Math.round(t.totalUSD * 100);
  let tipoCambioUsado = null;
  let totalCRCInformativo = null;
  try {
    tipoCambioUsado = await obtenerTipoCambioGuardado(s3);
    totalCRCInformativo = Math.ceil(t.totalUSD * tipoCambioUsado);
  } catch (err) {
    if (moneda === 'CRC') {
      console.error('pedido-empresa: no se pudo obtener el tipo de cambio para CRC —', err.message);
      return resp(503, { error: 'El pago en colones no está disponible en este momento. Puede pagar en dólares, o intentarlo de nuevo más tarde.' });
    }
  }
  if (moneda === 'CRC') {
    const subunit = Number(process.env.ONVO_CRC_SUBUNIT_MULTIPLIER || '100');
    unitAmount = Math.ceil(totalCRCInformativo * subunit);
    currencyOnvo = 'CRC';
  }

  const pedidoId = crypto.randomBytes(12).toString('hex'); // 24 caracteres, imposible de adivinar
  const base = process.env.URL || 'https://vidavitalqr.com';
  const nombrePago = datos.nombre.slice(0, 60);

  // se guarda el pedido ANTES de crear el pago (con el logo adentro), para que el webhook lo encuentre
  try {
    await escribirJson(s3, BUCKET_RESUMEN, clavePedido(pedidoId), {
      id: pedidoId, estado: 'pendiente', creado: new Date().toISOString(),
      nombre: datos.nombre, correo: datos.correo, telefono: datos.telefono, cantidad: datos.cantidad,
      precioUnitario: t.precioUnitario, subtotal: t.subtotal, iva: t.iva, totalUSD: t.totalUSD,
      logoTipo: datos.logoTipo, logoBase64: datos.logoBase64,
      autorizaLogo: true, autorizaLogoFecha: new Date().toISOString(),
    });
  } catch (err) {
    console.error('pedido-empresa: no se pudo guardar el pedido —', err);
    return resp(500, { error: 'No se pudo registrar el pedido. Intente de nuevo.' });
  }

  const bodyReq = {
    customerName: nombrePago,
    customerEmail: datos.correo,
    redirectUrl: `${base}/empresas.html?pago=exitoso`,
    cancelUrl: `${base}/empresas.html?pago=cancelado`,
    captureMethod: 'automatic',
    lineItems: [{
      quantity: 1, unitAmount, currency: currencyOnvo,
      description: `Identificador QR para empresas — ${datos.cantidad} tarjeta(s) a $${t.precioUnitario} c/u (incluye IVA 13%)`,
      priceType: 'one_time',
    }],
    metadata: {
      pedidoEmpresa: pedidoId,
      origen: 'vidavitalqr-empresas',
      cantidad: String(datos.cantidad),
      moneda: currencyOnvo,
      tipoCambioUsado: tipoCambioUsado ? String(tipoCambioUsado) : '',
      totalCRCInformativo: totalCRCInformativo ? String(totalCRCInformativo) : '',
      totalUSD: t.totalUSD.toFixed(2),
      correoCliente: datos.correo,
    },
  };

  try {
    const r = await fetch(ONVO_API_BASE + '/checkout/sessions/one-time-link', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + secretKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyReq),
    });
    let json = null;
    try { json = await r.json(); } catch (e) { /* sin JSON */ }
    if (!r.ok || !json || !json.url) {
      console.error('pedido-empresa: ONVO Pay rechazó la creación del checkout —', r.status, JSON.stringify(json));
      return resp(502, { error: 'No se pudo crear el pago con ONVO Pay.' });
    }
    console.log('pedido-empresa: pedido', pedidoId, '—', datos.cantidad, 'tarjeta(s), total USD', t.totalUSD, '—', json.id);
    return resp(200, { url: json.url, pedidoId, totalUSD: t.totalUSD });
  } catch (err) {
    console.error('pedido-empresa: error al contactar a ONVO Pay —', err);
    return resp(502, { error: 'No se pudo contactar a ONVO Pay.' });
  }
};
