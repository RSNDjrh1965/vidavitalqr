// ---- Netlify Function: sube el PDF de una ficha ya existente en un idioma ADICIONAL ----
// Recibe (POST, JSON): { folio, idioma, filename, pdfBase64 }
//
// Contexto: el PDF de la ficha (persona/mascota/objeto) se genera en el navegador tomando
// capturas de pantalla del formulario ya lleno (ver ficha.html / ficha-mascota.html /
// ficha-objeto.html, función generatePdfBlob) — por eso solo existe, de entrada, en el idioma
// con el que se llenó el formulario. Para que la persona que ESCANEA el código pueda también
// ver el PDF completo en su propio idioma (no solo el texto de la pantalla del visor, que ya
// se traduce con ver.js), el formulario, después de guardar la ficha con normalidad, cambia su
// propio idioma tres veces más (una por cada idioma restante), genera un PDF nuevo cada vez, y
// llama a esta función una vez por idioma para subirlo.
//
// Esta función es deliberadamente pequeña e independiente de send-ficha.js: solo agrega un PDF
// más a una ficha que YA EXISTE (creada por send-ficha.js momentos antes) — no toca foto,
// contactos, tarjeta, correo ni resumen.xlsx. Si esta llamada falla por cualquier motivo (folio
// no encontrado, PDF pesado, error de red, etc.), la ficha principal ya quedó guardada y
// funcionando con normalidad — ver.js simplemente sigue mostrando el PDF en el idioma original
// para el/los idiomas que no se hayan podido subir (ver la función paginaVisor en ver.js, que
// usa datos.pdfUrls[idioma] si existe y si no, cae a datos.pdfUrl). Por eso el navegador llama a
// esta función en un bucle "mejor esfuerzo": cada idioma se intenta por separado y cualquier
// error se ignora sin afectar a los demás ni a la ficha ya guardada.

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET_FICHAS = process.env.S3_BUCKET_FICHAS || 'vidavitalqr';
const IDIOMAS_VALIDOS = ['es', 'en', 'fr', 'pt'];

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

// ---- misma lógica que carpetaTipo() en send-ficha.js — se duplica aquí (en vez de compartir un
// módulo) para que esta función quede totalmente autocontenida y no dependa de cambios futuros
// en send-ficha.js. Si algún día se comparte, hay que mantener ambas en sync. ----
function carpetaTipo(folio) {
  const f = String(folio || '').toUpperCase();
  if (f.startsWith('VVMASCOTA')) return 'mascotas';
  if (f.startsWith('VVOBJETO')) return 'objetos';
  return 'personas';
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...headers, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido' }) };
  }

  const { folio, idioma, filename, pdfBase64 } = payload;

  if (!folio || !IDIOMAS_VALIDOS.includes(idioma) || !filename || !pdfBase64) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Faltan datos: folio, idioma (es/en/fr/pt), filename y pdfBase64 son obligatorios.' }),
    };
  }

  try {
    const region = process.env.S3_REGION || 'us-east-1';
    const s3 = getS3Client();
    const carpeta = carpetaTipo(folio);

    // 1) sube el PDF en este idioma como un archivo adicional (no reemplaza el PDF original)
    const pdfKey = `${carpeta}/${filename}`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_FICHAS,
      Key: pdfKey,
      Body: Buffer.from(base64PayloadOf(pdfBase64), 'base64'),
      ContentType: 'application/pdf',
    }));
    const pdfUrl = publicUrlFor(BUCKET_FICHAS, region, pdfKey);

    // 2) agrega la URL a datos/<folio>.json, dentro de un campo "pdfUrls" nuevo — lee lo que ya
    // existe y solo agrega/actualiza la entrada de este idioma, sin tocar el resto de la ficha
    // (contactos, foto, idioma de llenado, etc.). Si la ficha no existe todavía (por ejemplo, si
    // esta función se llamó antes de que send-ficha.js terminara), se responde con error 404 sin
    // subir nada huérfano.
    const datosKey = `${carpeta}/datos/${folio}.json`;
    let datos;
    try {
      const actual = await s3.send(new GetObjectCommand({ Bucket: BUCKET_FICHAS, Key: datosKey }));
      datos = JSON.parse(await streamToString(actual.Body));
    } catch (errLectura) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'No se encontró la ficha ' + folio + ' — no se guardó el PDF en este idioma.' }),
      };
    }

    datos.pdfUrls = (datos.pdfUrls && typeof datos.pdfUrls === 'object') ? datos.pdfUrls : {};
    datos.pdfUrls[idioma] = pdfUrl;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_FICHAS,
      Key: datosKey,
      Body: Buffer.from(JSON.stringify(datos), 'utf-8'),
      ContentType: 'application/json',
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, pdfUrl }) };
  } catch (err) {
    console.error('subir-pdf-idioma: error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error interno: ' + (err && err.message ? err.message : err) }) };
  }
};
