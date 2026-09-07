// ---- Netlify Function: recibe opiniones/testimonios enviados por usuarios desde el landing ----
//
// NO publica nada automáticamente en el sitio. Cada opinión recibida:
//  1) Se guarda como respaldo en el bucket privado de resumen (BUCKET_RESUMEN, carpeta
//     "testimonios/"), que nunca se expone como URL pública.
//  2) Se envía por correo (Resend) al equipo interno para que la revise y decida si se agrega
//     manualmente a la sección de prueba social del landing page.
//
// Incluye un campo "trampa" (honeypot) para descartar envíos automáticos de robots sin
// avisarles que fueron detectados (se responde 200 igual, pero no se guarda ni se envía nada).

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const DESTINATARIO = 'vidavitalqr@zohomail.com';
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';
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

function escaparHtml(texto) {
  return String(texto || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function limpiar(valor, maxLen) {
  return String(valor || '').trim().slice(0, maxLen);
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

  // Campo trampa: si un robot lo llenó, respondemos éxito falso sin procesar nada.
  if (limpiar(payload.empresa, 200)) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const nombre = limpiar(payload.nombre, 80);
  const rol = limpiar(payload.rol, 80);
  const texto = limpiar(payload.texto, 500);

  if (!nombre || !texto) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta el nombre o el comentario.' }) };
  }

  const fecha = new Date().toISOString();
  const idUnico = fecha.replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8);

  // 1) Respaldo en S3 (bucket privado) — así no se pierde nada aunque falle el correo.
  try {
    const s3 = getS3Client();
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_RESUMEN,
      Key: `testimonios/${idUnico}.json`,
      Body: JSON.stringify({ nombre, rol, texto, fecha, estado: 'pendiente' }, null, 2),
      ContentType: 'application/json',
    }));
  } catch (err) {
    // No se detiene el flujo si falla el respaldo en S3 — se intenta igual enviar el correo.
    console.error('No se pudo guardar el testimonio en S3:', err);
  }

  // 2) Aviso por correo para revisión manual.
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    try {
      const htmlBody = `
        <p>Se recibió una nueva opinión de usuario en vidavitalqr.com, pendiente de revisión.</p>
        <p><strong>Nombre:</strong> ${escaparHtml(nombre)}</p>
        <p><strong>Rol / relación:</strong> ${escaparHtml(rol) || '(no indicado)'}</p>
        <p><strong>Opinión:</strong><br>${escaparHtml(texto)}</p>
        <p style="color:#888; font-size:12px;">Recibido: ${fecha}<br>Referencia: ${idUnico}</p>
        <p>Esta opinión NO se publicó automáticamente. Si desea incluirla en la sección de prueba
        social del landing page, indíquelo para agregarla manualmente.</p>
      `;
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: REMITENTE,
          to: [DESTINATARIO],
          subject: 'Nueva opinión de usuario — VidaVitalQR (pendiente de revisión)',
          html: htmlBody,
        }),
      });
    } catch (err) {
      console.error('No se pudo enviar el correo de aviso de testimonio:', err);
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
