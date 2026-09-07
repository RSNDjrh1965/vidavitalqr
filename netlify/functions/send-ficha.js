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

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { buildQrSvg } = require('./lib/qr-svg');
const { actualizarResumenXlsx } = require('./lib/xlsx-resumen');
const { generarPin, hashPin } = require('./lib/pin');

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

// URL pública del "visor" que se abre al escanear el código QR (en vez de abrir el PDF
// directamente). Esa página es la que dispara el aviso por correo a los contactos de
// emergencia y la que muestra el botón de idioma. Se puede sobreescribir con una variable de
// entorno si el dominio cambia.
const SITE_URL = process.env.SITE_URL || 'https://vidavitalqr.com';

function urlDelVisor(folio) {
  return `${SITE_URL}/.netlify/functions/ver?folio=${encodeURIComponent(folio)}`;
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

// ---- crea o actualiza el "registro de acceso" (folio + PIN) que permite entrar al panel de
// edición sin volver a llenar el formulario completo ----
// Se guarda en el bucket de resumen (BUCKET_RESUMEN), que nunca se expone como URL pública —
// a diferencia de BUCKET_FICHAS, donde el PDF/foto/QR sí son públicos a propósito. Para poder
// recuperar el acceso de un usuario que perdió su PIN (por ejemplo, si escribe por WhatsApp), el
// PIN también se guarda en texto plano aquí (además de su hash, que es lo que se usa para
// validar el ingreso) — nunca se expone en una URL pública, así que esto no reduce la seguridad
// de cara al público. Si la ficha ya tenía un PIN guardado en texto plano, se conserva el mismo
// — nunca se cambia solo, para no dejar al usuario sin acceso. Si el registro es de una versión
// anterior que solo guardaba el hash (sin el texto plano), se genera un PIN nuevo esta vez, para
// que a partir de ahora también quede recuperable.
async function cargarOCrearLogin(s3, folio, datosFormulario) {
  const key = `login/${folio}.json`;
  let registro = null;
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: key }));
    const texto = await streamToString(resp.Body);
    registro = JSON.parse(texto);
  } catch (err) {
    const noExiste = err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
    if (!noExiste) throw err;
  }

  // Se trata como "nuevo" tanto si no existía registro como si existía pero de una versión
  // anterior que no guardaba el PIN en texto plano (solo el hash) — en ambos casos hay que
  // generar (o regenerar) un PIN y mostrárselo al usuario en el modal.
  const esNuevo = !registro || !registro.pin;
  const pin = esNuevo ? generarPin() : registro.pin;
  const nuevoRegistro = {
    folio,
    pin,
    pinHash: esNuevo ? hashPin(pin) : registro.pinHash,
    datosFormulario: datosFormulario && typeof datosFormulario === 'object' ? datosFormulario : {},
    creado: (registro && registro.creado) ? registro.creado : new Date().toISOString(),
    actualizado: new Date().toISOString(),
  };

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_RESUMEN,
    Key: key,
    Body: Buffer.from(JSON.stringify(nuevoRegistro), 'utf-8'),
    ContentType: 'application/json',
  }));

  // "pin" siempre viene relleno (con el PIN actual, nuevo o ya existente) — se usa tanto para
  // mostrarlo en el modal (solo cuando esNuevo) como para registrarlo en la columna "PIN" de
  // resumen.xlsx (siempre, para que James pueda recuperarlo si el usuario escribe por WhatsApp).
  return { esNuevo, pin };
}

// ---- envía el código de acceso (folio + PIN) por correo al o los contactos de emergencia que
// tengan un correo registrado, cada vez que se crea o actualiza una ficha — así el contacto
// siempre tiene a mano el código vigente para poder actualizar la ficha en el futuro, sin
// depender de que la persona titular guarde el PIN por su cuenta. No bloquea ni interrumpe el
// resto del guardado si falla (por ejemplo, si no hay RESEND_API_KEY configurado).
async function enviarCodigoPorCorreo(contactos, { folio, pin, nombreCompleto, tipo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !folio || !pin) return;

  const correos = Array.from(new Set(
    (Array.isArray(contactos) ? contactos : [])
      .map((c) => (c && c.email ? String(c.email).trim() : ''))
      .filter(Boolean)
  ));
  if (correos.length === 0) return;

  const deQuien = nombreCompleto ? ` de "${nombreCompleto}"` : '';
  const asunto = `Código de acceso a la ficha VidaVitalQR${deQuien} — ${folio}`;

  const cuerpo = [
    `Este es el código de acceso vigente para la ficha${deQuien} en VidaVitalQR (folio ${folio}):`,
    '',
    `Folio: ${folio}`,
    `PIN de acceso: ${pin}`,
    '',
    'Este código es necesario para poder actualizar la ficha en el futuro (por ejemplo, para renovarla o corregir algún dato). Guárdalo en un lugar seguro — nunca queda visible en ninguna página pública del sitio.',
    '',
    'Recibes este correo porque quedaste registrado(a) como contacto de emergencia de esta ficha. Este mensaje se envía automáticamente cada vez que la ficha se crea o se actualiza, para que siempre tengas a la mano el código más reciente.',
    '',
    'Este es un correo automático de VidaVitalQR.',
  ].join('\n');

  const envios = correos.map((email) =>
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: REMITENTE, to: [email], subject: asunto, text: cuerpo }),
    }).catch((err) => {
      console.error('No se pudo enviar el código a', email, err);
    })
  );

  await Promise.allSettled(envios);
}

async function subirABuckets(s3, region, { folio, filename, pdfBase64, fotoBase64, nombreCompleto, tipo, contactos, datosVisor }) {
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

  // 2) Foto (opcional). Si esta actualización no trae una foto nueva (por ejemplo, una
  // renovación donde el usuario no volvió a adjuntarla), se conserva la URL de la foto que ya
  // tenía guardada, en vez de borrarla del visor público.
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
  } else {
    try {
      const anterior = await s3.send(new GetObjectCommand({ Bucket: BUCKET_FICHAS, Key: `datos/${folio}.json` }));
      const texto = await streamToString(anterior.Body);
      const datosAnteriores = JSON.parse(texto);
      if (datosAnteriores && datosAnteriores.fotoUrl) fotoUrl = datosAnteriores.fotoUrl;
    } catch (err) {
      // sin foto anterior que conservar (ficha nueva, o nunca tuvo foto) — no es un error
    }
  }

  // 3) Datos estructurados para el visor público (lo que se muestra y traduce cuando alguien
  // escanea el código) y para saber a quién avisar. Se guarda como JSON, separado del PDF, para
  // no tener que volver a interpretar el PDF cada vez que alguien escanea.
  const datosKey = `datos/${folio}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_FICHAS,
    Key: datosKey,
    Body: Buffer.from(JSON.stringify({
      folio,
      nombreCompleto: nombreCompleto || '',
      tipo: tipo || 'Persona',
      pdfUrl,
      fotoUrl,
      contactos: Array.isArray(contactos) ? contactos : [],
      datosVisor: datosVisor && typeof datosVisor === 'object' ? datosVisor : {},
      actualizado: new Date().toISOString(),
    }), 'utf-8'),
    ContentType: 'application/json',
  }));

  // 4) Código QR — apunta al visor público (no directamente al PDF), para poder avisar a los
  // contactos cuando se escanee y para poder mostrar el botón de idioma.
  const qrSvg = await buildQrSvg(urlDelVisor(folio), folio);
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

// ---- fecha de hoy (zona horaria de Costa Rica), como objeto Date real ----
// Se construye a partir del año/mes/día calendario de Costa Rica (no de la hora UTC del
// servidor) y se fija al mediodía para evitar que un cambio de zona horaria la corra un día.
// Se necesita como Date real (no como texto ya formateado) para que Excel pueda calcular con
// ella la columna "Meses transcurridos" en xlsx-resumen.js.
function fechaInicioHoy() {
  try {
    const iso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' }); // 'YYYY-MM-DD'
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  } catch (err) {
    return new Date();
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

  const { folio, filename, pdfBase64, nombreCompleto, tipo, fotoBase64, contactos, datosVisor, datosFormulario } = payload;

  if (!pdfBase64 || !filename) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Faltan datos: filename y pdfBase64 son obligatorios.' }),
    };
  }

  // ---- Paso 1: subir a S3 (PDF + foto + código QR), actualizar la tabla resumen, y crear o
  // actualizar el acceso con PIN para el panel de edición ----
  let pdfUrl = '', fotoUrl = '', qrUrl = '';
  let s3Error = null;
  let pinNuevo = null;
  try {
    const region = process.env.S3_REGION || 'us-east-1';
    const s3 = getS3Client();
    const subido = await subirABuckets(s3, region, { folio, filename, pdfBase64, fotoBase64, nombreCompleto, tipo, contactos, datosVisor });
    pdfUrl = subido.pdfUrl; fotoUrl = subido.fotoUrl; qrUrl = subido.qrUrl;

    // El login (y su PIN) se resuelve ANTES de escribir el resumen, para poder incluir el PIN
    // vigente en la columna "PIN" de resumen.xlsx en el mismo guardado.
    let pinActual = '';
    if (folio) {
      const login = await cargarOCrearLogin(s3, folio, datosFormulario);
      pinActual = login.pin || '';
      if (login.esNuevo) pinNuevo = login.pin;
      // se envía en cada guardado (ficha nueva o actualización), no solo cuando el PIN es nuevo,
      // para que el contacto de emergencia siempre tenga a la mano el código vigente
      await enviarCodigoPorCorreo(contactos, { folio, pin: pinActual, nombreCompleto, tipo });
    }

    await actualizarResumenXlsx(s3, BUCKET_RESUMEN, RESUMEN_KEY, {
      contador: folio || '',
      pin: pinActual,
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
        body: JSON.stringify({ error: 'Resend rechazó el envío.', detalle: resultado, s3Error, pdfUrl, fotoUrl, qrUrl, pin: pinNuevo }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, id: resultado.id, s3Error, pdfUrl, fotoUrl, qrUrl, pin: pinNuevo }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Error al contactar a Resend.', detalle: String(err), s3Error, pdfUrl, fotoUrl, qrUrl, pin: pinNuevo }),
    };
  }
};
