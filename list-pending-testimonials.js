// ---- Netlify Function: lista las opiniones PENDIENTES de revisión (las que llegaron desde el
// formulario "Comparta su experiencia" en el landing page), para el panel privado
// admin-opiniones.html. Requiere la contraseña de administración.
//
// Configurar en Netlify (Site settings -> Environment variables):
//   ADMIN_OPINIONES_PASSWORD = la contraseña que usted elija para entrar al panel

const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const PREFIJO = 'testimonios/';
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

  try {
    const s3 = getS3Client();
    const listado = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET_RESUMEN, Prefix: PREFIJO }));
    const claves = (listado.Contents || [])
      .map((obj) => obj.Key)
      .filter((key) => key && key !== APROBADOS_KEY && key.endsWith('.json'));

    const pendientes = [];
    for (const key of claves) {
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: key }));
        const texto = await streamToString(obj.Body);
        const datos = JSON.parse(texto);
        if (datos && datos.estado === 'pendiente') {
          const id = key.slice(PREFIJO.length, -'.json'.length);
          pendientes.push({
            id,
            nombre: datos.nombre || '',
            rol: datos.rol || '',
            texto: datos.texto || '',
            fecha: datos.fecha || '',
          });
        }
      } catch (errItem) {
        // Un archivo individual dañado o ilegible no debe tumbar el listado completo.
        console.error('No se pudo leer el testimonio', key, errItem);
      }
    }

    // Más recientes primero.
    pendientes.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, pendientes }) };
  } catch (err) {
    console.error('Error listando testimonios pendientes:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'No se pudo obtener la lista de opiniones pendientes.' }) };
  }
};
