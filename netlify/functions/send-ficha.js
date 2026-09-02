// ---- Netlify Function: envía la ficha médica en PDF automáticamente por correo usando Resend ----
// Recibe (POST, JSON): { folio, filename, pdfBase64 }
// Envía el PDF adjunto a vidavitalqr@zohomail.com usando la API de Resend.
// La clave RESEND_API_KEY se lee de las variables de entorno de Netlify (nunca queda en el código).

const DESTINATARIO = 'vidavitalqr@zohomail.com';
// Dirección remitente: debe pertenecer al dominio ya verificado en Resend (vidavitalqr.com).
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Falta configurar RESEND_API_KEY en Netlify.' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  const { folio, filename, pdfBase64 } = payload;

  if (!pdfBase64 || !filename) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Faltan datos: filename y pdfBase64 son obligatorios.' }),
    };
  }

  // pdfBase64 puede venir como data URL ("data:application/pdf;base64,....") o como base64 puro.
  const base64Content = pdfBase64.includes(',') ? pdfBase64.split(',')[1] : pdfBase64;

  const asunto = folio
    ? `Nueva ficha médica VidaVitalQR — ${folio}`
    : 'Nueva ficha médica VidaVitalQR';

  const cuerpoTexto = folio
    ? `Se generó y envió automáticamente la ficha médica de emergencia con número de identificación ${folio}.\n\nEste correo fue generado automáticamente por el sistema de VidaVitalQR.`
    : 'Se generó y envió automáticamente una ficha médica de emergencia.\n\nEste correo fue generado automáticamente por el sistema de VidaVitalQR.';

  try {
    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: REMITENTE,
        to: [DESTINATARIO],
        subject: asunto,
        text: cuerpoTexto,
        attachments: [
          {
            filename: filename,
            content: base64Content,
          },
        ],
      }),
    });

    const resultado = await resendResp.json();

    if (!resendResp.ok) {
      return {
        statusCode: resendResp.status,
        headers,
        body: JSON.stringify({ error: 'Resend rechazó el envío.', detalle: resultado }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, id: resultado.id }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Error al contactar a Resend.', detalle: String(err) }),
    };
  }
};
