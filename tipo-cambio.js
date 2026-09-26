// ---- tipo-cambio.js ----
// Endpoint público de SOLO LECTURA: devuelve el último tipo de cambio (con el margen del 2% ya
// aplicado, ver actualizar-tipo-cambio.js) guardado en S3, para que index.html pueda mostrarle al
// cliente el total estimado en colones ANTES de pagar (selector "$ / ₡" del recuadro de pago).
//
// El monto que realmente se cobra SIEMPRE se recalcula de nuevo, de forma independiente y con el
// mismo valor guardado, dentro de crear-pago.js — este endpoint es solo para la vista previa en
// pantalla, nunca la fuente de verdad del cobro.
//
// Usa las mismas variables de entorno S3_* que guardar-envio.js / actualizar-tipo-cambio.js.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const TIPO_CAMBIO_KEY = 'config/tipo-cambio.json';

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
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido.' }) };
  }

  try {
    const s3 = getS3Client();
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: TIPO_CAMBIO_KEY }));
    const json = JSON.parse(await streamToString(obj.Body));
    const tipoCambio = Number(json.tipoCambio);
    if (!tipoCambio || tipoCambio <= 0) throw new Error('valor guardado inválido');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' },
      body: JSON.stringify({ tipoCambio, actualizado: json.actualizado || null }),
    };
  } catch (err) {
    // ---- 503 (no 500): le indica al front-end que el pago en colones no está disponible AHORA
    // (aún no corrió la función programada por primera vez, o hay un problema temporal), no que
    // haya un error de programación -- el front-end debe esconder la opción "₡" en ese caso, no
    // mostrar un mensaje de error alarmante al cliente ----
    console.error('tipo-cambio: no se pudo leer el tipo de cambio guardado —', err.message || err);
    return { statusCode: 503, body: JSON.stringify({ error: 'El tipo de cambio todavía no está disponible.' }) };
  }
};
