// ---- folio-nuevo.js (2026-10-26) ----
// Entrega el número del folio que se le muestra a quien abre una ficha NUEVA (persona, mascota u
// objeto). Antes ese número lo daba un contador externo gratuito (abacus.jasoncameron.dev); desde
// que el sitio no depende de terceros lo da el propio servidor, guardado en el bucket PRIVADO de
// resumen (carpeta contadores/).
//
// GET /.netlify/functions/folio-nuevo?tipo=persona|mascota|objeto   ->   { value: <número> }
//
// Garantías:
//  - Cada número se "reserva" creando un archivito contadores/<tipo>/reservas/<n>.json con
//    IfNoneMatch '*' (solo si no existía). Dos personas simultáneas NUNCA reciben el mismo número.
//  - Nunca entrega un número cuyo folio ya tenga registro de acceso (login) en S3.
//  - Arranca en el folio 500 (acordado con James). Si un folio ya tiene ficha, se salta.
//  - Límite por conexión: 40 folios por hora.

const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { estaBloqueado, anotar, ipDe } = require('./lib/limite');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';

const TIPOS = {
  persona: { prefijo: 'VVITALQR', carpeta: 'personas' },
  mascota: { prefijo: 'VVMASCOTA', carpeta: 'mascotas' },
  objeto: { prefijo: 'VVOBJETO', carpeta: 'objetos' },
};
// Acordado con James (2026-10-26): las fichas personales que pagan arrancan en el folio 500; los
// folios 120 a 450 quedan reservados para fichas de obsequio (lib/regalo.js). Mascotas y objetos
// arrancan también en 500.
const PRIMER_FOLIO = 500;

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

function noExiste(err) {
  return err && (err.name === 'NoSuchKey' || err.name === 'NotFound' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404);
}

async function leerContador(s3, key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: key }));
    const n = parseInt(JSON.parse(await streamToString(r.Body)).valor, 10);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    if (noExiste(e)) return null;
    throw e;
  }
}

async function existeLogin(s3, tipo, folio) {
  const { carpeta } = TIPOS[tipo];
  for (const key of [`${carpeta}/login/${folio}.json`, `login/${folio}.json`]) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET_RESUMEN, Key: key }));
      return true;
    } catch (e) {
      if (!noExiste(e)) throw e;
    }
  }
  return false;
}

async function reservar(s3, tipo, n) {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_RESUMEN,
      Key: `contadores/${tipo}/reservas/${n}.json`,
      Body: Buffer.from(JSON.stringify({ t: Date.now() }), 'utf-8'),
      ContentType: 'application/json',
      IfNoneMatch: '*',
    }));
    return true;
  } catch (e) {
    const st = e.$metadata?.httpStatusCode;
    if (st === 412 || st === 409 || e.name === 'PreconditionFailed' || e.name === 'ConditionalRequestConflict') return false;
    throw e;
  }
}

async function siguienteNumero(s3, tipo) {
  const keyContador = `contadores/${tipo}.json`;
  let sugerido = await leerContador(s3, keyContador);
  if (sugerido === null) sugerido = PRIMER_FOLIO - 1;
  let n = Math.max(PRIMER_FOLIO, sugerido + 1);
  for (let intento = 0; intento < 400; intento++, n++) {
    if (n > 99999999) throw new Error('Contador agotado.');
    if (!(await reservar(s3, tipo, n))) continue;
    const folio = TIPOS[tipo].prefijo + String(n).padStart(8, '0');
    if (await existeLogin(s3, tipo, folio)) continue;
    try {
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_RESUMEN, Key: keyContador, Body: Buffer.from(JSON.stringify({ valor: n }), 'utf-8'), ContentType: 'application/json',
      }));
    } catch (e) { /* solo es una pista para la próxima vez; las reservas son la garantía */ }
    return n;
  }
  throw new Error('No se pudo reservar un folio.');
}

exports.handler = async (event) => {
  const cab = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: cab, body: JSON.stringify({ error: 'Método no permitido.' }) };
  const tipo = String((event.queryStringParameters || {}).tipo || 'persona');
  if (!TIPOS[tipo]) return { statusCode: 400, headers: cab, body: JSON.stringify({ error: 'Tipo no válido.' }) };
  try {
    const s3 = getS3Client();
    const ip = ipDe(event);
    if (await estaBloqueado(s3, BUCKET_RESUMEN, 'folionuevo', ip, 40, 60 * 60 * 1000)) {
      return { statusCode: 429, headers: cab, body: JSON.stringify({ error: 'Demasiadas solicitudes. Intente más tarde.' }) };
    }
    await anotar(s3, BUCKET_RESUMEN, 'folionuevo', ip, 60 * 60 * 1000);
    const n = await siguienteNumero(s3, tipo);
    return { statusCode: 200, headers: cab, body: JSON.stringify({ value: n }) };
  } catch (err) {
    console.error('folio-nuevo: error', err);
    return { statusCode: 500, headers: cab, body: JSON.stringify({ error: 'No se pudo asignar el folio.' }) };
  }
};
