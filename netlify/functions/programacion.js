// ---- programacion.js (2026-10-27) ----
// Motor de la página privada programacion.html (diagrama de barras de 8 semanas de James).
// Guarda UN solo archivo en S3 (programacion/estado.json, bucket de resumen) con: fecha de inicio,
// tareas marcadas y notas de "Resultado real". Así el avance es el mismo en el computador y el celular.
// Usa la MISMA clave de las herramientas de administración (variable ADMIN_KEY, cabecera "x-admin-key"),
// con el mismo bloqueo tras 8 intentos fallidos en 15 minutos.
//   { accion:'leer' }                         -> { estado, rev }
//   { accion:'guardar', estado, rev }         -> { ok, rev }   (409 si otro aparato guardó antes: devuelve el estado vigente)
const { S3Client } = require('@aws-sdk/client-s3');
const { estaBloqueado, anotar, ipDe, claveIgual } = require('./lib/limite');
const { leerJson, escribirJson } = require('./lib/empresa');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const CLAVE = 'programacion/estado.json';
const INICIAL = { inicio: '', hechas: [], notas: {} };

function getS3Client() {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('Faltan configurar S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en Netlify.');
  return new S3Client({ region: process.env.S3_REGION || 'us-east-1', credentials: { accessKeyId, secretAccessKey } });
}

// Valida y limpia el estado recibido (nunca se guarda nada que no tenga esta forma).
function limpiar(e) {
  if (!e || typeof e !== 'object') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(e.inicio || ''));
  if (!m) return null;
  const f = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (f.getUTCFullYear() !== +m[1] || f.getUTCMonth() !== +m[2] - 1 || f.getUTCDate() !== +m[3] || +m[1] < 2020 || +m[1] > 2100) return null;
  const hechas = Array.isArray(e.hechas) ? e.hechas.filter((x) => typeof x === 'string' && /^\d{1,2}-\d$/.test(x)).slice(0, 60) : [];
  const notas = {};
  if (e.notas && typeof e.notas === 'object') {
    for (let w = 1; w <= 8; w++) {
      const t = e.notas[w];
      if (typeof t === 'string' && t.trim()) notas[w] = t.slice(0, 2000);
    }
  }
  return { inicio: e.inicio, hechas: Array.from(new Set(hechas)), notas };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
  };
  const r = (codigo, obj) => ({ statusCode: codigo, headers, body: JSON.stringify(obj) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return r(405, { error: 'Método no permitido' });

  const claveReal = process.env.ADMIN_KEY;
  if (!claveReal || claveReal.length < 12) return r(500, { error: 'Falta configurar ADMIN_KEY en Netlify (mínimo 12 caracteres).' });

  let s3;
  try { s3 = getS3Client(); } catch (err) { return r(500, { error: err.message }); }

  const VENTANA = 15 * 60 * 1000;
  const ip = ipDe(event);
  if (await estaBloqueado(s3, BUCKET_RESUMEN, 'admin-ip', ip, 8, VENTANA)) return r(429, { error: 'Demasiados intentos. Espere unos 15 minutos.' });
  const enviada = (event.headers && (event.headers['x-admin-key'] || event.headers['X-Admin-Key'])) || '';
  if (!claveIgual(enviada, claveReal)) {
    await anotar(s3, BUCKET_RESUMEN, 'admin-ip', ip, VENTANA);
    return r(401, { error: 'Clave incorrecta.' });
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch (e) { return r(400, { error: 'JSON inválido.' }); }

  try {
    const actual = await leerJson(s3, BUCKET_RESUMEN, CLAVE);
    const revActual = actual && Number.isInteger(actual.rev) ? actual.rev : 0;
    if (p.accion === 'leer') {
      return r(200, { ok: true, estado: actual ? { inicio: actual.inicio, hechas: actual.hechas || [], notas: actual.notas || {} } : null, rev: revActual });
    }
    if (p.accion === 'guardar') {
      const limpio = limpiar(p.estado);
      if (!limpio) return r(400, { error: 'Datos no válidos.' });
      if (Number(p.rev) !== revActual) {
        return r(409, { error: 'Otro aparato guardó antes.', estado: actual ? { inicio: actual.inicio, hechas: actual.hechas || [], notas: actual.notas || {} } : null, rev: revActual });
      }
      const nuevaRev = revActual + 1;
      await escribirJson(s3, BUCKET_RESUMEN, CLAVE, { ...limpio, rev: nuevaRev, actualizado: new Date().toISOString() });
      return r(200, { ok: true, rev: nuevaRev });
    }
    return r(400, { error: 'Acción desconocida.' });
  } catch (err) {
    console.error('programacion: error', err);
    return r(500, { error: 'Error interno: ' + (err && err.message ? err.message : err) });
  }
};
