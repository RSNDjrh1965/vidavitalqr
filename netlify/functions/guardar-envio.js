// ---- Netlify Function: guarda la dirección de envío de una ficha (persona/mascota/objeto),
// usada únicamente para el envío postal de productos físicos (placa, pulsera, cadena,
// Identificador QR). Se pide en el landing justo antes de procesar el pago (ver el modal
// "Dirección de envío" en index.html) y se guarda AQUÍ, en el bucket PRIVADO de resumen
// (BUCKET_RESUMEN) — nunca en el bucket "vidavitalqr" (BUCKET_FICHAS), que es público a
// propósito para el PDF/foto/QR. Así el nombre, la dirección exacta y el teléfono del
// destinatario nunca quedan expuestos junto con la información médica que se muestra al
// escanear el código QR.
//
// Recibe (POST, JSON):
//   { folio, tipo, datosEnvio: { nombreEnvio, provincia, canton, distrito, senas, telefono, correo } }
//
// Credenciales de AWS leídas de variables de entorno de Netlify (mismas que usa send-ficha.js):
// S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION, S3_BUCKET_RESUMEN.

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

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

// ---- misma lógica que carpetaTipo() en send-ficha.js: el folio ya distingue el tipo sin
// ambigüedad (el de persona empieza con "VVITALQR", el de mascota con "VVMASCOTA" y el de
// objeto con "VVOBJETO"), así que se usa como fuente de verdad y "tipo" solo como respaldo. ----
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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  const folio = String(body.folio || '').trim();
  const tipo = String(body.tipo || '').trim();
  const datosEnvio = body.datosEnvio && typeof body.datosEnvio === 'object' ? body.datosEnvio : {};

  const nombreEnvio = String(datosEnvio.nombreEnvio || '').trim();
  const provincia = String(datosEnvio.provincia || '').trim();
  const canton = String(datosEnvio.canton || '').trim();
  const distrito = String(datosEnvio.distrito || '').trim();
  const senas = String(datosEnvio.senas || '').trim();
  const telefono = String(datosEnvio.telefono || '').trim();
  const correo = String(datosEnvio.correo || '').trim();

  if (!folio) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta el folio.' }) };
  }
  if (!nombreEnvio || !provincia || !canton || !distrito || !telefono) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Faltan datos obligatorios de la dirección de envío (nombre, provincia, cantón, distrito o teléfono).' }) };
  }

  try {
    const s3 = getS3Client();
    const carpeta = carpetaTipo(tipo, folio);
    const key = `${carpeta}/envio/${folio}.json`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_RESUMEN,
      Key: key,
      Body: Buffer.from(JSON.stringify({
        folio,
        tipo: tipo || '',
        nombreEnvio,
        provincia,
        canton,
        distrito,
        senas,
        telefono,
        correo,
        actualizado: new Date().toISOString(),
      }), 'utf-8'),
      ContentType: 'application/json',
    }));

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('Error guardando dirección de envío:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'No se pudo guardar la dirección de envío. Intente de nuevo.' }) };
  }
};
