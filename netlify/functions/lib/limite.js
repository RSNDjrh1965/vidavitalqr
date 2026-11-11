// ---- Limitador de intentos sencillo, guardado en S3 (2026-10-09, revisión de seguridad) ----
// Sirve para frenar el adivinar PIN / fechas de nacimiento por fuerza bruta y el abuso de envío
// de correos, sin necesitar ningún servicio nuevo: guarda las marcas de tiempo de los últimos
// intentos de cada "clave" (por ejemplo un folio, o una IP) en un archivito dentro del bucket
// PRIVADO de resumen (carpeta limites/). Si S3 falla, NUNCA se bloquea al cliente (falla "abierta"):
// es una protección extra, no un requisito para que el sitio funcione.
const crypto = require('crypto');
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

function claveObjeto(ambito, id) {
  const h = crypto.createHash('sha256').update(String(id || '')).digest('hex').slice(0, 32);
  return `limites/${String(ambito).replace(/[^a-z0-9_-]/gi, '')}/${h}.json`;
}

async function leerConEtag(s3, bucket, key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const d = JSON.parse(await streamToString(r.Body));
    return { t: Array.isArray(d.t) ? d.t.filter((x) => typeof x === 'number') : [], etag: r.ETag || null, existia: true };
  } catch (e) {
    return { t: [], etag: null, existia: false };
  }
}

async function leer(s3, bucket, key) {
  return (await leerConEtag(s3, bucket, key)).t;
}

// ¿Ya se alcanzó el máximo de intentos dentro de la ventana? (solo consulta, no anota nada)
async function estaBloqueado(s3, bucket, ambito, id, max, ventanaMs) {
  try {
    const ahora = Date.now();
    const t = (await leer(s3, bucket, claveObjeto(ambito, id))).filter((x) => ahora - x < ventanaMs);
    return t.length >= max;
  } catch (e) {
    return false;
  }
}

// Anota un intento (por ejemplo, un PIN incorrecto o un envío) y devuelve cuántos van en la ventana.
// 2026-11-10 (auditoría, hallazgo 17): antes se leía, se sumaba y se guardaba sin ningún control, así que muchas
// peticiones simultáneas pisaban el contador unas a otras y solo contaba una. Ahora la subida es condicional (solo si
// el contador sigue igual a como se leyó; si no, S3 responde 412 y se repite con el valor nuevo, hasta 6 veces).
// Sigue siendo una protección extra: si S3 falla de otra forma, NUNCA se bloquea al cliente.
async function anotar(s3, bucket, ambito, id, ventanaMs) {
  const key = claveObjeto(ambito, id);
  for (let intento = 0; intento < 6; intento++) {
    try {
      const ahora = Date.now();
      const actual = await leerConEtag(s3, bucket, key);
      const t = actual.t.filter((x) => ahora - x < ventanaMs);
      t.push(ahora);
      const condicion = actual.existia ? (actual.etag ? { IfMatch: actual.etag } : {}) : { IfNoneMatch: '*' };
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: Buffer.from(JSON.stringify({ t: t.slice(-50) }), 'utf-8'), ContentType: 'application/json', ...condicion,
      }));
      return t.length;
    } catch (e) {
      const fallida = e && (e.name === 'PreconditionFailed' || e.Code === 'PreconditionFailed' || (e.$metadata && e.$metadata.httpStatusCode === 412));
      if (!fallida) return 0;
      await new Promise((r) => setTimeout(r, 40 * (intento + 1) + Math.floor(Math.random() * 60)));
    }
  }
  return 0;
}

// Limpia el contador (por ejemplo tras un ingreso correcto).
async function reiniciar(s3, bucket, ambito, id) {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: claveObjeto(ambito, id), Body: Buffer.from('{"t":[]}', 'utf-8'), ContentType: 'application/json',
    }));
  } catch (e) { /* no crítico */ }
}

function ipDe(event) {
  const h = (event && event.headers) || {};
  return String(h['x-nf-client-connection-ip'] || h['client-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || 'desconocida').trim();
}

// Valida que el folio tenga solo letras y números (sin "/", "..", "<", comillas, etc.), para que
// nunca pueda usarse para armar rutas de S3 raras ni inyectar texto en páginas.
function folioSeguro(folio) {
  const f = String(folio || '').trim().toUpperCase();
  return /^[A-Z0-9]{6,30}$/.test(f) ? f : '';
}

// Comparación de contraseñas en tiempo constante (no revela por temporización cuántas letras acertó).
function claveIgual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { estaBloqueado, anotar, reiniciar, ipDe, folioSeguro, claveIgual };
