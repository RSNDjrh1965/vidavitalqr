// ---- Netlify Function: aprueba o rechaza una opinión pendiente, desde el panel privado
// admin-opiniones.html. Requiere la misma contraseña de administración que
// list-pending-testimonials.js (variable de entorno ADMIN_OPINIONES_PASSWORD).
//
//  - "aprobar": agrega la opinión a testimonios/aprobados.json (lo que ve el público en el
//    sitio, a través de get-testimonials.js) y marca el archivo original con estado "aprobado".
//  - "rechazar": solo marca el archivo original con estado "rechazado" — no se publica, y deja
//    de aparecer como pendiente en el panel.
//
// Ninguna de las dos acciones requiere desplegar el sitio: el cambio se ve de inmediato (o en
// un par de minutos, por el cache de get-testimonials.js) porque los datos viven en S3, no en
// el código del sitio.

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

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

function idValido(id) {
  // Mismo formato que genera submittestimonial.js: fecha ISO con ":" y "." reemplazados por
  // "-", seguido de "-" y unos caracteres al azar. Se valida para no permitir rutas raras en
  // la clave de S3.
  return typeof id === 'string' && /^[A-Za-z0-9_-]{10,80}$/.test(id);
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

  const id = payload.id;
  const accion = payload.accion;
  if (!idValido(id) || (accion !== 'aprobar' && accion !== 'rechazar')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Datos inválidos.' }) };
  }

  const key = `${PREFIJO}${id}.json`;

  try {
    const s3 = getS3Client();

    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: key }));
    const texto = await streamToString(obj.Body);
    const datos = JSON.parse(texto);

    datos.estado = accion === 'aprobar' ? 'aprobado' : 'rechazado';

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_RESUMEN,
      Key: key,
      Body: JSON.stringify(datos, null, 2),
      ContentType: 'application/json',
    }));

    if (accion === 'aprobar') {
      let aprobados = [];
      try {
        const objAprobados = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: APROBADOS_KEY }));
        const textoAprobados = await streamToString(objAprobados.Body);
        const lista = JSON.parse(textoAprobados);
        if (Array.isArray(lista)) aprobados = lista;
      } catch (errLeer) {
        // Si todavía no existe el archivo de aprobados (primera opinión que se aprueba), se
        // crea desde cero — no es un error.
      }

      // Evita duplicar si ya estaba aprobado antes (por ejemplo, un doble clic accidental).
      aprobados = aprobados.filter((t) => t && t.id !== id);
      aprobados.push({
        id,
        nombre: datos.nombre || '',
        rol: datos.rol || '',
        texto: datos.texto || '',
        fecha: datos.fecha || '',
      });

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_RESUMEN,
        Key: APROBADOS_KEY,
        Body: JSON.stringify(aprobados, null, 2),
        ContentType: 'application/json',
      }));
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('Error al moderar testimonio', key, err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'No se pudo actualizar la opinión. Intente de nuevo.' }) };
  }
};
