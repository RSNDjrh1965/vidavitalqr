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
const { firmaValida } = require('./lib/enlace-qr');

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

// ---- 2026-10-22: "Identificador QR digital" — tarjeta con foto (la misma imagen que send-ficha.js
// guarda en <personas>/identificador-qr/<folio>.jpg al guardar la ficha). Solo se muestra con un
// enlace firmado (?t=, ver lib/enlace-qr.js) y solo para fichas de persona que tengan tarjeta; en
// cualquier otro caso la página sigue siendo la de siempre (solo QR + nombre). ----
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function leerTarjetaJpg(folio) {
  const s3 = getS3Client();
  const bucket = process.env.S3_BUCKET_FICHAS || BUCKET_FICHAS;
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `personas/identificador-qr/${folio}.jpg` }));
    return await streamToBuffer(resp.Body);
  } catch (err) {
    const noExiste = err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
    if (noExiste) return null;
    throw err;
  }
}

// PDF a tamaño real de tarjeta: 54 mm de ancho (153,07 pt) y el alto que corresponda a la proporción
// de la imagen (la tarjeta es vertical, tamaño CR80 girado: 54 x 85,6 mm)
async function generarPdfTarjetaConFoto(jpgBuffer) {
  const pdfDoc = await PDFDocument.create();
  const img = await pdfDoc.embedJpg(jpgBuffer);
  const ancho = 153.07;
  const alto = ancho * (img.height / img.width);
  const pagina = pdfDoc.addPage([ancho, alto]);
  pagina.drawImage(img, { x: 0, y: 0, width: ancho, height: alto });
  return pdfDoc.save();
}

function paginaTarjetaConFoto(datos, firma, jpgBuffer) {
  const folio = escapeHtml(datos.folio);
  const nombre = escapeHtml(datos.nombreCompleto || '');
  const t = encodeURIComponent(firma);
  const dataUri = 'data:image/jpeg;base64,' + jpgBuffer.toString('base64');
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Mi identificador QR — VidaVitalQR</title>
<style>
  :root{ --ink:#12282B; --ink-soft:#2C4247; --paper:#F7F4EE; --card:#FFFFFF; --teal-deep:#1F4448; --line:#DAD3C4; --muted:#6C7A76; }
  body{margin:0;background:var(--paper);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px 16px;box-sizing:border-box;}
  .wrap{max-width:420px;width:100%;}
  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:26px 22px;text-align:center;box-shadow:0 20px 50px -30px rgba(18,40,43,0.35);}
  .card h1{font-size:1.2rem;margin:0 0 4px;}
  .card .sub{color:var(--muted);font-size:0.85rem;margin:0 0 18px;}
  .tarjeta{max-width:260px;width:100%;height:auto;border-radius:12px;border:1px solid var(--line);display:block;margin:0 auto;}
  .card .folio{color:var(--ink-soft);font-size:0.9rem;margin:14px 0 0;}
  .botones{display:flex;flex-direction:column;gap:10px;margin-top:20px;}
  .botones a{display:block;text-align:center;border-radius:10px;padding:12px 10px;font-weight:700;font-size:0.92rem;text-decoration:none;border:1px solid var(--teal-deep);}
  .botones a.primario{background:var(--teal-deep);color:#fff;}
  .botones a.secundario{background:var(--card);color:var(--teal-deep);}
  .nota{color:var(--muted);font-size:0.78rem;margin-top:18px;line-height:1.5;text-align:left;}
  .bloqueo{margin-top:22px;padding-top:18px;border-top:1px solid var(--line);text-align:left;}
  .bloqueo h2{font-size:1rem;margin:0 0 6px;text-align:center;}
  .bloqueo,.bloqueo p,.bloqueo ol{text-align:left;}
  .bloqueo p{font-size:0.84rem;line-height:1.5;color:var(--ink-soft);margin:0 0 10px;}
  .bloqueo button{width:100%;border-radius:10px;padding:12px 10px;font-weight:700;font-size:0.92rem;border:1px solid var(--teal-deep);background:var(--teal-deep);color:#fff;cursor:pointer;}
  .bloqueo .vista{display:none;margin-top:14px;text-align:center;}
  .bloqueo .vista img{width:100%;max-width:220px;height:auto;border-radius:14px;border:1px solid var(--line);display:block;margin:0 auto 10px;}
  .bloqueo .vista a{display:block;text-align:center;border-radius:10px;padding:11px 10px;font-weight:700;font-size:0.9rem;text-decoration:none;border:1px solid var(--teal-deep);color:var(--teal-deep);background:var(--card);margin-bottom:12px;}
  .bloqueo ol{margin:0 0 10px;padding-left:20px;font-size:0.82rem;line-height:1.55;color:var(--ink-soft);}
  .bloqueo .aviso{background:#F7F4EE;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:0.78rem;color:var(--muted);}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>Mi identificador QR</h1>
    <p class="sub">VidaVitalQR</p>
    <img class="tarjeta" id="tarjetaImg" src="${dataUri}" alt="Identificador QR${nombre ? ' de ' + nombre : ''}">
    <p class="folio">Folio: ${folio}</p>
    <div class="botones">
      <a class="primario" href="?folio=${folio}&t=${t}&descargar=tarjeta">Descargar tarjeta (imagen)</a>
      <a class="secundario" href="?folio=${folio}&t=${t}&descargar=tarjetapdf">Descargar PDF a tamaño de tarjeta</a>
      <a class="secundario" href="?folio=${folio}&t=${t}&descargar=png">Descargar solo el código QR</a>
    </div>
    <div class="bloqueo" id="bloqueo">
      <h2>Úsela como pantalla de bloqueo</h2>
      <p>Para que su identificador esté siempre a la vista, aun con el celular bloqueado, descargue la imagen para pantalla de bloqueo. <strong>Al descargarla, la imagen queda guardada en su celular lista para usarse como pantalla de bloqueo; para activarla siga los pasos de abajo</strong> (el celular no permite cambiarla automáticamente).</p>
      <button type="button" id="btnBloqueo">Descargar para pantalla de bloqueo</button>
      <div class="vista" id="vistaBloqueo">
        <img id="imgBloqueo" alt="Identificador QR para pantalla de bloqueo">
        <a id="lnkBloqueo" download="identificador-${folio}-pantalla-de-bloqueo.png" href="#">Guardar la imagen en mi celular</a>
        <p><strong>iPhone:</strong></p>
        <ol>
          <li>Mantenga presionada la imagen de arriba y elija "Añadir a Fotos" (o toque "Guardar la imagen").</li>
          <li>Abra la app Fotos, toque la imagen y luego el botón Compartir.</li>
          <li>Elija "Usar como fondo de pantalla" y toque "Pantalla de bloqueo". No la amplíe ni la recorte, para no tapar el código QR.</li>
        </ol>
        <p><strong>Android:</strong></p>
        <ol>
          <li>Toque "Guardar la imagen en mi celular" (o mantenga presionada la imagen y elija "Descargar imagen").</li>
          <li>Abra la Galería o Google Fotos y abra la imagen.</li>
          <li>Toque el menú (⋮) y elija "Establecer como fondo de pantalla" o "Usar como", y escoja "Pantalla de bloqueo".</li>
        </ol>
        <div class="aviso">Privacidad: con la pantalla bloqueada se verán su foto y su código QR. Úsela así solo si está de acuerdo; es justamente para que cualquier persona pueda escanear el código en una emergencia.</div>
      </div>
    </div>
    <script>
    (function(){
      var btn = document.getElementById('btnBloqueo');
      var img = document.getElementById('tarjetaImg');
      if (!btn || !img) return;
      btn.addEventListener('click', function(){
        var W = 1170, H = 2532;                       // tamaño típico de pantalla de celular (vertical)
        var c = document.createElement('canvas'); c.width = W; c.height = H;
        var x = c.getContext('2d');
        function dibujar(){
          var g = x.createLinearGradient(0, 0, 0, H);
          g.addColorStop(0, '#1F4448'); g.addColorStop(1, '#12282B');
          x.fillStyle = g; x.fillRect(0, 0, W, H);
          var cw = 920, ch = Math.round(cw * img.naturalHeight / img.naturalWidth);
          var cx = Math.round((W - cw) / 2), cy = 780;   // deja libre arriba para la hora y la fecha
          x.save();
          x.beginPath();
          var r = 44;
          x.moveTo(cx + r, cy); x.arcTo(cx + cw, cy, cx + cw, cy + ch, r); x.arcTo(cx + cw, cy + ch, cx, cy + ch, r);
          x.arcTo(cx, cy + ch, cx, cy, r); x.arcTo(cx, cy, cx + cw, cy, r); x.closePath(); x.clip();
          x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
          x.drawImage(img, cx, cy, cw, ch);
          x.restore();
          var url = c.toDataURL('image/png');
          document.getElementById('imgBloqueo').src = url;
          document.getElementById('lnkBloqueo').href = url;
          document.getElementById('vistaBloqueo').style.display = 'block';
          document.getElementById('vistaBloqueo').scrollIntoView({behavior:'smooth', block:'start'});
        }
        if (img.complete && img.naturalWidth) dibujar(); else img.onload = dibujar;
      });
    })();
    </script>
    <p class="nota">Para imprimirla, use el PDF y elija "tamaño real" o "100%" (no "ajustar a la página"); la tarjeta mide 54 x 85,6 mm. Guárdela también en su celular: así la tiene a mano. Este es su código real, el mismo que da acceso a su ficha de VidaVitalQR. Este enlace es personal: no lo comparta, porque muestra su foto.</p>
  </div>
</div>
</body>
</html>`;
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

  // ---- Identificador QR digital: tarjeta con foto, solo con enlace firmado y ficha de persona ----
  let jpgTarjeta = null;
  const firmaRecibida = qs.t || '';
  if (firmaRecibida && String(datos.folio || '').toUpperCase().startsWith('VVITALQR') && datos.tarjetaUrl && firmaValida(datos.folio, firmaRecibida)) {
    try {
      jpgTarjeta = await leerTarjetaJpg(datos.folio);
    } catch (err) {
      console.error('qr-digital: no se pudo leer la tarjeta —', err);
    }
  }

  const descargar = (qs.descargar || '').toLowerCase();
  if (jpgTarjeta && descargar === 'tarjeta') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Disposition': `attachment; filename="identificador-${datos.folio}.jpg"`, 'Cache-Control': 'private, no-store' },
      body: jpgTarjeta.toString('base64'),
      isBase64Encoded: true,
    };
  }
  if (jpgTarjeta && descargar === 'tarjetapdf') {
    const pdfTarjeta = await generarPdfTarjetaConFoto(jpgTarjeta);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="identificador-${datos.folio}.pdf"`, 'Cache-Control': 'private, no-store' },
      body: Buffer.from(pdfTarjeta).toString('base64'),
      isBase64Encoded: true,
    };
  }
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

  if (jpgTarjeta) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' }, body: paginaTarjetaConFoto(datos, firmaRecibida, jpgTarjeta) };
  }
  return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: paginaTarjeta(datos) };
};
