// ---- regalo-info.js (2026-10-26) ----
// GET ?g=<folio>&k=<firma>  ->  { ok: true, estado: 'sin_activar' | 'activa' }
// Lo usa ficha.html para saber si un enlace de obsequio es válido ANTES de dejar llenar la ficha.
// Responde 404 genérico si el folio no es de obsequio o la firma no coincide. Límite: 40 consultas
// por 15 minutos por conexión.
const { S3Client } = require('@aws-sdk/client-s3');
const { estaBloqueado, anotar, ipDe, folioSeguro } = require('./lib/limite');
const { leerJson } = require('./lib/empresa');
const { enRangoRegalo, firmaValida, claveRegalo } = require('./lib/regalo');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';

function getS3Client() {
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('Faltan S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY.');
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

exports.handler = async (event) => {
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const noValido = { statusCode: 404, headers: h, body: JSON.stringify({ error: 'Enlace no válido.' }) };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: h, body: JSON.stringify({ error: 'Método no permitido.' }) };
  try {
    const q = event.queryStringParameters || {};
    const folio = folioSeguro(q.g);
    if (!folio || !enRangoRegalo(folio) || !firmaValida(folio, q.k)) return noValido;
    const s3 = getS3Client();
    const ip = ipDe(event);
    if (await estaBloqueado(s3, BUCKET_RESUMEN, 'regalo-info', ip, 40, 15 * 60 * 1000)) {
      return { statusCode: 429, headers: h, body: JSON.stringify({ error: 'Demasiadas consultas. Intente más tarde.' }) };
    }
    await anotar(s3, BUCKET_RESUMEN, 'regalo-info', ip, 15 * 60 * 1000);
    const reg = await leerJson(s3, BUCKET_RESUMEN, claveRegalo(folio));
    if (!reg) return noValido;
    return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, estado: reg.estado === 'sin_activar' ? 'sin_activar' : 'activa' }) };
  } catch (err) {
    console.error('regalo-info: error', err);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'Error interno.' }) };
  }
};
