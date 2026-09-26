// ---- Netlify Function: devuelve la lista de opiniones YA APROBADAS, para mostrarlas en el
// landing page (vidavitalqr.com). Es información pública (la misma que ya se ve en el sitio),
// así que no requiere contraseña.
//
// Lee el archivo testimonios/aprobados.json del bucket privado de resumen. Ese archivo lo
// escribe moderar-testimonial.js cada vez que se aprueba una opinión desde el panel privado
// admin-opiniones.html. Si todavía no se ha aprobado ninguna, simplemente devuelve una lista
// vacía (no es un error).

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const APROBADOS_KEY = 'testimonios/aprobados.json';

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

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    // Se cachea 2 minutos para no golpear S3 en cada visita, pero que una opinión recién
    // aprobada se vea en el sitio casi de inmediato (sin necesidad de desplegar nada).
    'Cache-Control': 'public, max-age=120',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido.' }) };
  }

  try {
    const s3 = getS3Client();
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: APROBADOS_KEY }));
    const texto = await streamToString(obj.Body);
    const lista = JSON.parse(texto);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, testimonios: Array.isArray(lista) ? lista : [] }),
    };
  } catch (err) {
    // Si el archivo todavía no existe (ninguna opinión aprobada aún) no es un error real, y
    // tampoco lo tratamos como error visible si algo más falla: la página pública nunca debe
    // romperse por esto, simplemente no muestra opiniones.
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, testimonios: [] }) };
  }
};
