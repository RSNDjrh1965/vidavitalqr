// ---- Netlify Function: página "Mi código QR" para el producto "Código QR (solo digital)" ----
// 2026-10-02, a pedido de James: automatizar la entrega del QR a quien compra el producto
// "Código QR (solo digital)" (qr_only_personal / qr_only_objeto) — antes no se enviaba nada
// (ver comentario histórico en index.html junto a PRECIOS). onvo-webhook.js envía por correo un
// enlace a esta página en cuanto se confirma el pago (ver avisarClienteQrDigital en
// onvo-webhook.js). Esta página:
//   1) Muestra una tarjeta simple (sin foto) con el código QR ya existente de la ficha — el
//      mismo que usa el visor público (datos.qrUrl, generado por send-ficha.js). No genera un
//      QR nuevo ni distinto: siempre es exactamente el código real de la ficha.
//   2) Ofrece descargar ese mismo código como imagen (PNG) o como PDF, generados al momento
//      (sin depender de ningún servicio externo ni de CDNs en el navegador del cliente).
//
// A propósito, esta página NUNCA muestra datos médicos ni de contactos de emergencia — eso
// sigue siendo exclusivo del visor público (/v/:folio, ver.js), que requiere escanear el QR
// físico/digital real. Aquí solo se expone folio, nombre (si existe) y el propio QR.
//
// Reutiliza tal cual la lógica de búsqueda de la ficha en S3 que ya usa ver.js (misma
// convención de carpetas por tipo de folio), para no duplicar bugs ya resueltos ahí.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const QRCode = require('qrcode');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { calcularEstado } = require('./lib/vigencia');

const BUCKET_FICHAS = process.env.S3_BUCKET_FICHAS || 'vidavitalqr';
const SITE_URL = process.env.SITE_URL || 'https://vidavitalqr.com';

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

function urlDelVisor(folio) {
  return `${SITE_URL}/v/${encodeURIComponent(folio)}`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- busca datos/<folio>.json igual que ver.js (mismas rutas/carpetas posibles) ----
async function buscarFicha(folio) {
  const folioMayus = folio.toUpperCase();
  const carpetaPreferida = folioMayus.startsWith('VVMASCOTA') ? 'mascotas' : (folioMayus.startsWith('VVOBJETO') ? 'objetos' : (folioMayus.startsWith('VVITALQR') ? 'personas' : null));
  const rutasPosibles = carpetaPreferida
    ? [`${carpetaPreferida}/datos/${folioMayus}.json`, `datos/${folioMayus}.json`]
    : [`datos/${folioMayus}.json`, `personas/datos/${folioMayus}.json`, `mascotas/datos/${folioMayus}.json`, `objetos/datos/${folioMayus}.json`];

  const s3 = getS3Client();
  const bucket = process.env.S3_BUCKET_FICHAS || BUCKET_FICHAS;
  for (const ruta of rutasPosibles) {
    try {
      const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: ruta }));
      const texto = await streamToString(resp.Body);
      const datos = JSON.parse(texto);
      datos.folio = datos.folio || folioMayus;
      return datos;
    } catch (err) {
      const noExiste = err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
      if (!noExiste) throw err;
    }
  }
  return null;
}

// ---- QR en PNG, generado al momento con la misma librería y el mismo destino (la URL del
// visor) que usa qr-svg.js para el QR "normal" (no el ajustado a placas de láser) — así el
// contenido codificado es idéntico al de datos.qrUrl, solo que en formato de imagen (PNG) en
// vez de vectorial (SVG). ----
async function generarPngQr(folio) {
  return QRCode.toBuffer(urlDelVisor(folio), { type: 'png', errorCorrectionLevel: 'H', width: 1200, margin: 2, color: { dark: '#12282B', light: '#F9F6EF' } });
}

async function generarPdfTarjeta(datos) {
  const pngBytes = await generarPngQr(datos.folio);
  const pdfDoc = await PDFDocument.create();
  const pagina = pdfDoc.addPage([320, 440]);
  const fuenteTitulo = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fuenteTexto = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const img = await pdfDoc.embedPng(pngBytes);

  const colorInk = rgb(18 / 255, 40 / 255, 43 / 255);
  const colorPapel = rgb(249 / 255, 246 / 255, 239 / 255);

  pagina.drawRectangle({ x: 0, y: 0, width: 320, height: 440, color: colorPapel });
  pagina.drawText('VidaVitalQR', { x: 24, y: 400, size: 18, font: fuenteTitulo, color: colorInk });
  pagina.drawText('Código QR digital', { x: 24, y: 380, size: 11, font: fuenteTexto, color: colorInk });

  const qrLado = 240;
  pagina.drawImage(img, { x: (320 - qrLado) / 2, y: 110, width: qrLado, height: qrLado });

  if (datos.nombreCompleto) {
    pagina.drawText(String(datos.nombreCompleto), { x: 24, y: 80, size: 12, font: fuenteTitulo, color: colorInk });
  }
  pagina.drawText(`Folio: ${datos.folio}`, { x: 24, y: datos.nombreCompleto ? 62 : 80, size: 11, font: fuenteTexto, color: colorInk });
  pagina.drawText('vidavitalqr.com', { x: 24, y: datos.nombreCompleto ? 46 : 64, size: 10, font: fuenteTexto, color: colorInk });

  return pdfDoc.save();
}

function paginaError(mensaje) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>VidaVitalQR</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F7F4EE;color:#12282B;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center;}
.box{max-width:440px;background:#FFFFFF;border:1px solid #DAD3C4;border-radius:14px;padding:32px 26px;}</style></head>
<body><div class="box"><p>${escapeHtml(mensaje)}</p></div></body></html>`;
}

function paginaPagoPendiente() {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>VidaVitalQR</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F7F4EE;color:#12282B;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center;}
.box{max-width:440px;background:#FFFFFF;border:1px solid #DAD3C4;border-radius:14px;padding:32px 26px;}</style></head>
<body><div class="box"><p>Su pago todavía se está confirmando. En cuanto quede confirmado, esta página mostrará su código QR automáticamente — puede volver a abrir este mismo enlace en unos minutos.</p></div></body></html>`;
}

function paginaTarjeta(datos) {
  const folio = escapeHtml(datos.folio);
  const nombre = escapeHtml(datos.nombreCompleto || '');
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mi código QR — VidaVitalQR</title>
<style>
  :root{ --ink:#12282B; --ink-soft:#2C4247; --paper:#F7F4EE; --card:#FFFFFF; --teal-deep:#1F4448; --line:#DAD3C4; --muted:#6C7A76; }
  body{margin:0;background:var(--paper);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;}
  .wrap{max-width:420px;width:100%;}
  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px 24px;text-align:center;box-shadow:0 20px 50px -30px rgba(18,40,43,0.35);}
  .card h1{font-size:1.2rem;margin:0 0 4px;}
  .card .sub{color:var(--muted);font-size:0.85rem;margin:0 0 20px;}
  .card .nombre{font-weight:700;font-size:1.05rem;margin:14px 0 2px;}
  .card .folio{color:var(--ink-soft);font-size:0.9rem;margin:0 0 20px;}
  .qrBox{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:16px;display:inline-block;}
  .qrBox img{width:220px;height:220px;display:block;}
  .botones{display:flex;gap:10px;margin-top:22px;}
  .botones a{flex:1;display:block;text-align:center;border-radius:10px;padding:12px 10px;font-weight:700;font-size:0.9rem;text-decoration:none;border:1px solid var(--teal-deep);}
  .botones a.primario{background:var(--teal-deep);color:#fff;}
  .botones a.secundario{background:var(--card);color:var(--teal-deep);}
  .nota{color:var(--muted);font-size:0.78rem;margin-top:18px;line-height:1.5;}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>Mi código QR</h1>
    <p class="sub">VidaVitalQR</p>
    <div class="qrBox"><img src="${escapeHtml(datos.qrUrl || '')}" alt="Código QR"></div>
    ${nombre ? `<p class="nombre">${nombre}</p>` : ''}
    <p class="folio">Folio: ${folio}</p>
    <div class="botones">
      <a class="primario" href="?folio=${folio}&descargar=png">Descargar imagen</a>
      <a class="secundario" href="?folio=${folio}&descargar=pdf">Descargar PDF</a>
    </div>
    <p class="nota">Este es su código QR real — el mismo que da acceso a su ficha de VidaVitalQR. Guárdelo en un lugar seguro; puede volver a esta página cuando quiera con el mismo enlace.</p>
  </div>
</div>
</body>
</html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: paginaError('Método no permitido.') };
  }

  const partesRuta = (event.path || '').split('/').filter(Boolean);
  const ultimaParte = partesRuta.length ? decodeURIComponent(partesRuta[partesRuta.length - 1]) : '';
  const folioDeRuta = (ultimaParte && !['qr-digital', 'qr'].includes(ultimaParte.toLowerCase())) ? ultimaParte : '';
  const qs = event.queryStringParameters || {};
  const folio = folioDeRuta || qs.folio || '';

  if (!folio) {
    return { statusCode: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: paginaError('Falta el código de la ficha.') };
  }

  let datos;
  try {
    datos = await buscarFicha(folio);
  } catch (err) {
    console.error('qr-digital: error consultando S3 —', err);
    return { statusCode: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: paginaError('Ocurrió un error consultando la información. Intente de nuevo en unos minutos.') };
  }

  if (!datos) {
    return { statusCode: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: paginaError('No se encontró información para este código.') };
  }

  if (calcularEstado(datos.creado) === 'eliminada') {
    return { statusCode: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: paginaError('Esta ficha ya no existe: se eliminó por falta de renovación.') };
  }

  if (datos.activo === false) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: paginaPagoPendiente() };
  }

  const descargar = (qs.descargar || '').toLowerCase();
  if (descargar === 'png') {
    const png = await generarPngQr(datos.folio);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="qr-${datos.folio}.png"` },
      body: png.toString('base64'),
      isBase64Encoded: true,
    };
  }
  if (descargar === 'pdf') {
    const pdfBytes = await generarPdfTarjeta(datos);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="qr-${datos.folio}.pdf"` },
      body: Buffer.from(pdfBytes).toString('base64'),
      isBase64Encoded: true,
    };
  }

  return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: paginaTarjeta(datos) };
};
