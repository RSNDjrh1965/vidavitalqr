// ---- Netlify Function: devuelve la dirección de envío guardada para un folio (persona/mascota/
// objeto), para el panel privado admin-envios.html (imprimir la etiqueta de envío tamaño tarjeta
// de crédito). Requiere la misma contraseña de administración que admin-opiniones.html.
//
// Configurar en Netlify (Site settings -> Environment variables):
//   ADMIN_OPINIONES_PASSWORD = la contraseña que usted elija para entrar a los paneles privados

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';

function getS3Client() {
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Faltan configurar S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en Netlify.');
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

function carpetaTipo(tipo, folio) {
  const f = String(folio || '').toUpperCase();
  if (f.startsWith('VVMASCOTA')) return 'mascotas';
  if (f.startsWith('VVOBJETO')) return 'objetos';
  if (f.startsWith('VVITALQR')) return 'personas';
  const t = String(tipo || '').toLowerCase();
  if (t === 'mascota') return 'mascotas';
  if (t === 'objeto') return 'objetos';
  return 'personas';
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido.' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  const passwordEsperada = process.env.ADMIN_OPINIONES_PASSWORD;
  if (!passwordEsperada) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Falta configurar ADMIN_OPINIONES_PASSWORD en Netlify.' }) };
  }
  if (payload.password !== passwordEsperada) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Contraseña incorrecta.' }) };
  }

  const folio = String(payload.folio || '').trim();
  if (!folio) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta el folio.' }) };
  }

  try {
    const s3 = getS3Client();
    const carpeta = carpetaTipo(payload.tipo, folio);
    const key = `${carpeta}/envio/${folio}.json`;
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: key }));
    const datos = JSON.parse(await streamToString(obj.Body));
    return { statusCode: 200, headers, body: JSON.stringify(datos) };
  } catch (err) {
    if (err && (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404)) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No hay una dirección de envío guardada para ese folio.' }) };
    }
    console.error('Error obteniendo dirección de envío:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'No se pudo consultar la dirección de envío.' }) };
  }
};
