// ---- Netlify Function: ¿existe esta ficha? (2026-11-14) ----
// La usa el "Generador de códigos para placas" (herramienta local de James) para avisarle, ANTES de
// grabar una placa, si el folio escrito no corresponde a ninguna ficha (por ejemplo, un prefijo
// equivocado: VVITALQR00000504 en vez de VVMASCOTA00000504).
//
// Solo responde si la ficha existe y si está activa, y de qué tipo es. NO devuelve ningún dato
// personal (ni nombre, ni contactos, ni foto). Es la misma información que ya se deduce hoy al abrir
// la dirección pública /v/<folio> (existe / no existe / pago pendiente), así que no abre nada nuevo.
// Solo lee de S3: no escribe ni borra nada. Lleva un límite por conexión (60 consultas por hora) y,
// como el resto de limitadores del sitio, si S3 falla nunca bloquea.
// CORS abierto (*) porque el generador se abre desde un archivo local del computador de James.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { calcularEstado } = require('./lib/vigencia');
const { estaBloqueado, anotar, ipDe, folioSeguro } = require('./lib/limite');

const BUCKET_FICHAS = process.env.S3_BUCKET_FICHAS || 'vidavitalqr';
const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function responder(statusCode, obj) {
  return { statusCode, headers: CORS, body: JSON.stringify(obj) };
}

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
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return responder(405, { error: 'Método no permitido.' });

  const folio = folioSeguro(event.queryStringParameters && event.queryStringParameters.folio);
  if (!folio) return responder(400, { error: 'Folio no válido.' });

  // Mismo criterio que ver.js: el prefijo del folio dice en qué carpeta está.
  const tipo = folio.startsWith('VVMASCOTA') ? 'mascota' : folio.startsWith('VVOBJETO') ? 'objeto' : folio.startsWith('VVITALQR') ? 'persona' : '';
  if (!tipo) return responder(200, { folio, existe: false, motivo: 'prefijo' });
  const carpeta = { persona: 'personas', mascota: 'mascotas', objeto: 'objetos' }[tipo];
  const rutas = [`${carpeta}/datos/${folio}.json`, `datos/${folio}.json`];

  let s3;
  try {
    s3 = getS3Client();
  } catch (e) {
    return responder(500, { error: 'No se pudo consultar.' });
  }

  // Límite por conexión (falla "abierta": si S3 o el limitador fallan, igual se responde).
  try {
    const ip = ipDe(event);
    if (await estaBloqueado(s3, BUCKET_RESUMEN, 'existe-ficha-ip', ip, 60, 60 * 60 * 1000)) {
      return responder(429, { error: 'Demasiadas consultas. Intente más tarde.' });
    }
    await anotar(s3, BUCKET_RESUMEN, 'existe-ficha-ip', ip, 60 * 60 * 1000);
  } catch (e) { /* no se bloquea por un fallo del limitador */ }

  let datos = null;
  for (const ruta of rutas) {
    try {
      const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET_FICHAS, Key: ruta }));
      datos = JSON.parse(await streamToString(resp.Body));
      break;
    } catch (err) {
      const noExiste = err && (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404));
      if (!noExiste) return responder(500, { error: 'No se pudo consultar.' });
    }
  }
  if (!datos) return responder(200, { folio, tipo, existe: false });
  // Una ficha ya vencida del todo se trata como inexistente (igual que hace ver.js).
  if (calcularEstado(datos.creado) === 'eliminada') return responder(200, { folio, tipo, existe: false, motivo: 'eliminada' });
  return responder(200, { folio, tipo, existe: true, activa: datos.activo !== false });
};
