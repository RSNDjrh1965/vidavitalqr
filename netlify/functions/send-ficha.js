// ---- Netlify Function: procesa cada ficha enviada desde el landing page ----
// Recibe (POST, JSON): { folio, filename, pdfBase64, nombreCompleto, tipo, fotoBase64 }
//
// Hace, en orden:
//  1) Sube el PDF de la ficha al bucket S3 "vidavitalqr".
//  2) Si vino foto, la sube también al bucket "vidavitalqr" (carpeta fotos/).
//  3) Genera un código QR (SVG) que apunta a la URL del PDF, con "VIDAVITALQR" en el centro
//     y el folio debajo, y lo sube al bucket S3 de códigos QR.
//  4) Agrega una fila a la tabla "resumen.csv" dentro del bucket de resumen, con las columnas:
//     contador, nombre completo, url del objeto, fotografía, código QR.
//  5) Envía el correo con el PDF adjunto (igual que antes), usando Resend.
//
// Todas las credenciales (Resend y AWS) se leen de variables de entorno de Netlify —
// nunca quedan escritas en este archivo.
//
// IMPORTANTE sobre nombres de variables de entorno de AWS:
// Netlify NO permite usar los nombres AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION
// (son reservados por el propio entorno de ejecución). Por eso aquí se usan nombres propios:
// S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION.

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { buildQrSvg } = require('./lib/qr-svg');
const { actualizarResumenXlsx } = require('./lib/xlsx-resumen');

const DESTINATARIO = 'vidavitalqr@zohomail.com';
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';

// Nombres de los buckets (se pueden sobreescribir con variables de entorno si algún día cambian).
const BUCKET_FICHAS = process.env.S3_BUCKET_FICHAS || 'vidavitalqr';
const BUCKET_QR = process.env.S3_BUCKET_QR || 'vidavitalqr-qr';
const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const RESUMEN_KEY = 'resumen.xlsx';

function getS3Client() {
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Faltan configurar S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en Netlify.');
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

function publicUrlFor(bucket, region, key) {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
}

function base64PayloadOf(dataUrlOrBase64) {
  if (!dataUrlOrBase64) return null;
  return dataUrlOrBase64.includes(',') ? dataUrlOrBase64.split(',')[1] : dataUrlOrBase64;
}

function contentTypeFromDataUrl(dataUrl, fallback) {
  const m = /^data:([^;]+);base64,/.exec(dataUrl || '');
  return m ? m[1] : fallback;
}

async function subirABuckets(s3, region, { folio, filename, pdfBase64, fotoBase64 }) {
  const region_ = region;

  // 1) PDF de la ficha
  const pdfKey = filename;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_FICHAS,
    Key: pdfKey,
    Body: Buffer.from(base64PayloadOf(pdfBase64), 'base64'),
    ContentType: 'application/pdf',
  }));
  const pdfUrl = publicUrlFor(BUCKET_FICHAS, region_, pdfKey);

  // 2) Foto (opcional)
  let fotoUrl = '';
  if (fotoBase64) {
    const ext = (contentTypeFromDataUrl(fotoBase64, 'image/jpeg').split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const fotoKey = `fotos/${folio}.${ext}`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_FICHAS,
      Key: fotoKey,
      Body: Buffer.from(base64PayloadOf(fotoBase64), 'base64'),
      ContentType: contentTypeFromDataUrl(fotoBase64, 'image/jpeg'),
    }));
    fotoUrl = publicUrlFor(BUCKET_FICHAS, region_, fotoKey);
  }

  // 3) Código QR apuntando al PDF, con folio debajo
  const qrSvg = await buildQrSvg(pdfUrl, folio);
  const qrKey = `${folio}.svg`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_QR,
    Key: qrKey,
    Body: Buffer.from(qrSvg, 'utf-8'),
    ContentType: 'image/svg+xml',
  }));
  const qrUrl = publicUrlFor(BUCKET_QR, region_, qrKey);

  return { pdfUrl, fotoUrl, qrUrl };
}

// ---- fecha de inicio de vigencia (formato legible, zona horaria de Costa Rica) ----
function fechaInicioHoy() {
  try {
    return new Date().toLocaleDateString('es-CR', {
      timeZone: 'America/Costa_Rica', year: 'numeric', month: '2-digit', day: '2-digit',
    });
  } catch (err) {
    return new Date().toISOString().slice(0, 10);
  }
}

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

  const { folio, filename, pdfBase64, nombreCompleto, tipo, fotoBase64 } = payload;

  if (!pdfBase64 || !filename) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Faltan datos: filename y pdfBase64 son obligatorios.' }),
    };
  }

  // ---- Paso 1: subir a S3 (PDF + foto + código QR) y actualizar la tabla resumen ----
  let pdfUrl = '', fotoUrl = '', qrUrl = '';
  let s3Error = null;
  try {
    const region = process.env.S3_REGION || 'us-east-1';
    const s3 = getS3Client();
    const subido = await subirABuckets(s3, region, { folio, filename, pdfBase64, fotoBase64 });
    pdfUrl = subido.pdfUrl; fotoUrl = subido.fotoUrl; qrUrl = subido.qrUrl;

    await actualizarResumenXlsx(s3, BUCKET_RESUMEN, RESUMEN_KEY, {
      contador: folio || '',
      nombre: nombreCompleto || '',
      fecha: fechaInicioHoy(),
      pdfUrl,
      fotoBase64,
      qrUrl,
    });
  } catch (err) {
    // No bloqueamos el envío del correo si falla la parte de S3 — se reporta en la respuesta
    // para poder diagnosticarlo, pero la ficha igual llega por correo.
    s3Error = String(err && err.message ? err.message : err);
  }

  // ---- Paso 2: enviar el correo (igual que antes), con los enlaces de S3 si se generaron ----
  const base64Content = base64PayloadOf(pdfBase64);

  const tipoTexto = tipo === 'Mascota' ? 'ficha de mascota' : 'ficha médica';
  const asunto = folio
    ? `Nueva ${tipoTexto} VidaVitalQR — ${folio}`
    : `Nueva ${tipoTexto} VidaVitalQR`;

  const lineasExtra = [];
  if (nombreCompleto) lineasExtra.push(`Nombre completo: ${nombreCompleto}`);
  if (pdfUrl) lineasExtra.push(`PDF en la nube: ${pdfUrl}`);
  if (fotoUrl) lineasExtra.push(`Fotografía: ${fotoUrl}`);
  if (qrUrl) lineasExtra.push(`Código QR: ${qrUrl}`);
  if (s3Error) lineasExtra.push(`(Aviso: no se pudo subir a S3 / actualizar el resumen — ${s3Error})`);

  const cuerpoTexto = [
    folio
      ? `Se generó y envió automáticamente la ${tipoTexto} de emergencia con número de identificación ${folio}.`
      : `Se generó y envió automáticamente una ${tipoTexto} de emergencia.`,
    ...lineasExtra,
    '',
    'Este correo fue generado automáticamente por el sistema de VidaVitalQR.',
  ].join('\n');

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
        body: JSON.stringify({ error: 'Resend rechazó el envío.', detalle: resultado, s3Error, pdfUrl, fotoUrl, qrUrl }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, id: resultado.id, s3Error, pdfUrl, fotoUrl, qrUrl }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Error al contactar a Resend.', detalle: String(err), s3Error, pdfUrl, fotoUrl, qrUrl }),
    };
  }
};
