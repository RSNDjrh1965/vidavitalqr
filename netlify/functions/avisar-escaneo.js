// ---- Netlify Function: envía el aviso de escaneo a los contactos de emergencia ----
// La llama, desde el navegador de quien escaneó, la página de `ver.js` — una vez que ese
// navegador ya resolvió el permiso de ubicación (lo aceptó o lo rechazó). Aplica igual para
// fichas de persona y de mascota.
//
// No se confía en el folio del cliente para nada más que buscar la ficha: los contactos, el
// nombre y el enlace al PDF siempre se vuelven a leer de S3 aquí, nunca se reciben del navegador.
//
// Ubicación que se incluye en el correo:
//  - Si el permiso fue concedido: la ubicación exacta (coordenadas) que envió el navegador.
//  - Si fue rechazado, no respondió a tiempo, o el navegador no soporta geolocalización: una
//    ubicación aproximada calculada a partir de la IP de la conexión, dejando explícito que es
//    aproximada y puede no ser exacta. Si ni siquiera eso se puede determinar, el correo se
//    envía igual, sin sección de ubicación.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET_FICHAS = process.env.S3_BUCKET_FICHAS || 'vidavitalqr';
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';

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

// ---- fecha/hora legible en zona horaria de Costa Rica, para el correo de aviso ----
function fechaHoraCR() {
  try {
    return new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica', dateStyle: 'long', timeStyle: 'short' });
  } catch (err) {
    return new Date().toISOString();
  }
}

// ---- IP real de quien escaneó, a partir de los encabezados que reenvía Netlify ----
function obtenerIp(event) {
  const headers = event.headers || {};
  const directa = headers['x-nf-client-connection-ip'] || headers['client-ip'];
  if (directa) return directa.trim();
  const reenviada = headers['x-forwarded-for'];
  if (reenviada) return reenviada.split(',')[0].trim();
  return null;
}

// ---- ubicación aproximada a partir de la IP, usando un servicio gratuito sin llave de API ----
async function ubicacionPorIp(ip) {
  if (!ip) return null;
  try {
    const resp = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || data.success === false) return null;
    if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number') return null;
    return {
      lat: data.latitude,
      lng: data.longitude,
      etiqueta: [data.city, data.region, data.country].filter(Boolean).join(', '),
    };
  } catch (err) {
    console.error('No se pudo obtener ubicación aproximada por IP:', err);
    return null;
  }
}

function enlaceMapa(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

// ---- envía el aviso de escaneo, con la ubicación que se haya podido determinar ----
async function avisarContactos(datos, ubicacionTexto) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return; // si no hay Resend configurado, simplemente no se avisa (no debe romper nada)

  const contactosConCorreo = (Array.isArray(datos.contactos) ? datos.contactos : []).filter((c) => c && c.email);
  if (contactosConCorreo.length === 0) return;

  const esTipoMascota = datos.tipo === 'Mascota';
  const asunto = esTipoMascota
    ? `⚠️ Alguien escaneó el código QR de ${datos.nombreCompleto || 'su mascota'}`
    : `⚠️ Alguien escaneó el código QR de emergencia de ${datos.nombreCompleto || 'un usuario'}`;

  const cuerpo = [
    `El código QR de ${esTipoMascota ? 'la mascota' : 'la ficha de emergencia de'} "${datos.nombreCompleto || 'Sin nombre'}" (folio ${datos.folio}) fue escaneado el ${fechaHoraCR()} (hora de Costa Rica).`,
    '',
    'Esto puede significar que alguien está tratando de contactarlo(a) por una emergencia, o que la mascota fue encontrada.',
    '',
    ubicacionTexto || '',
    datos.pdfUrl ? `Ficha completa: ${datos.pdfUrl}` : '',
    '',
    'Este es un aviso automático de VidaVitalQR. Si usted mismo(a) escaneó el código para probarlo, puede ignorar este mensaje.',
  ].filter(Boolean).join('\n');

  const envios = contactosConCorreo.map((c) =>
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: REMITENTE,
        to: [c.email],
        subject: asunto,
        text: `Hola ${c.nombre || ''},\n\n${cuerpo}`,
      }),
    }).catch((err) => {
      console.error('No se pudo avisar a', c.email, err);
    })
  );

  await Promise.allSettled(envios);
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

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

  const folio = String(payload.folio || '').trim().toUpperCase();
  if (!folio) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta el folio.' }) };
  }

  const permitido = payload.permitido === true;
  const lat = permitido && typeof payload.lat === 'number' ? payload.lat : null;
  const lng = permitido && typeof payload.lng === 'number' ? payload.lng : null;

  // ---- vuelve a leer la ficha completa de S3 a partir del folio — nunca se confía en datos de
  // contacto ni PDF que pudieran venir del navegador, solo en el folio para ubicarla ----
  const carpetaPreferida = folio.startsWith('VVMASCOTA') ? 'mascotas' : (folio.startsWith('VVITALQR') ? 'personas' : null);
  const rutasPosibles = carpetaPreferida
    ? [`${carpetaPreferida}/datos/${folio}.json`, `datos/${folio}.json`]
    : [`datos/${folio}.json`, `personas/datos/${folio}.json`, `mascotas/datos/${folio}.json`];

  let datos;
  try {
    const s3 = getS3Client();
    const bucket = process.env.S3_BUCKET_FICHAS || BUCKET_FICHAS;
    let encontrado = null;
    for (const ruta of rutasPosibles) {
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: ruta }));
        encontrado = await streamToString(resp.Body);
        break;
      } catch (err) {
        const noExiste = err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
        if (!noExiste) throw err;
      }
    }
    if (!encontrado) throw new Error('No encontrado en ninguna ubicación.');
    datos = JSON.parse(encontrado);
    datos.folio = datos.folio || folio;
  } catch (err) {
    // no se le puede avisar a nadie de una ficha que no existe — se responde 200 igual, para no
    // darle a quien llame esta función ninguna pista sobre qué folios sí existen
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // ---- arma el texto de ubicación para el correo ----
  let ubicacionTexto = '';
  if (lat !== null && lng !== null) {
    ubicacionTexto = `Ubicación compartida por quien escaneó el código: ${enlaceMapa(lat, lng)}\n(Precisión según el dispositivo de quien escaneó — puede no ser exacta.)`;
  } else {
    const ip = obtenerIp(event);
    const aprox = await ubicacionPorIp(ip);
    if (aprox) {
      const detalle = aprox.etiqueta ? ` (aproximadamente en ${aprox.etiqueta})` : '';
      ubicacionTexto = `Ubicación aproximada de quien escaneó el código${detalle}: ${enlaceMapa(aprox.lat, aprox.lng)}\n(Esta ubicación es aproximada, calculada a partir de la conexión a internet — no es exacta, y quien escaneó no compartió su ubicación real.)`;
    }
  }

  try {
    await avisarContactos(datos, ubicacionTexto);
  } catch (err) {
    console.error('Error avisando a los contactos:', err);
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
