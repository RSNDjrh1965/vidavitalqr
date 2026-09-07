// ---- Netlify Function: valida folio + PIN y devuelve los datos guardados de esa ficha ----
// La usa el "panel de acceso" dentro de ficha.html / ficha-mascota.html (la sección de
// renovación) para poder precargar el formulario con los datos ya guardados, en vez de que el
// usuario tenga que volver a escribir todo desde cero.
//
// Nunca revela si el problema fue el folio o el PIN (siempre "Folio o PIN incorrectos.") para no
// facilitarle a alguien ir probando folios válidos uno por uno.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { pinValido } = require('./lib/pin');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';

// ---- carpeta de organización dentro del bucket, según el tipo de ficha (ver la misma función,
// con más detalle, en send-ficha.js) — el folio manda: "VVITALQR..." es persona,
// "VVMASCOTA..." es mascota; el campo "tipo" solo se usa como respaldo ----
function carpetaTipo(tipo, folio) {
  const f = String(folio || '').toUpperCase();
  if (f.startsWith('VVMASCOTA')) return 'mascotas';
  if (f.startsWith('VVITALQR')) return 'personas';
  return tipo === 'Mascota' ? 'mascotas' : 'personas';
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
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
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

  const folio = String(payload.folio || '').trim().toUpperCase();
  const pin = String(payload.pin || '').trim().toUpperCase();
  const carpeta = carpetaTipo(payload.tipo, folio);

  if (!folio || !pin) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Faltan el folio o el PIN.' }) };
  }

  const respuestaInvalida = { statusCode: 401, headers, body: JSON.stringify({ error: 'Folio o PIN incorrectos.' }) };

  try {
    const s3 = getS3Client();
    let registro;
    try {
      const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: `${carpeta}/login/${folio}.json` }));
      registro = JSON.parse(await streamToString(resp.Body));
    } catch (err) {
      const noExiste = err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
      if (!noExiste) throw err;
      // ficha todavía no migrada a la carpeta nueva — se busca en la ubicación anterior
      const respLegacy = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: `login/${folio}.json` }));
      registro = JSON.parse(await streamToString(respLegacy.Body));
    }

    if (!pinValido(pin, registro.pinHash)) {
      return respuestaInvalida;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, folio, datosFormulario: registro.datosFormulario || {} }),
    };
  } catch (err) {
    const noExiste = err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
    if (noExiste) return respuestaInvalida;
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'No se pudo validar el acceso.', detalle: String(err) }) };
  }
};
