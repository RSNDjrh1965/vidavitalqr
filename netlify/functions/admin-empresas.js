// ---- admin-empresas.js (Etapa 1 de tarjetas para empresas, 2026-10-20) ----
// Es el "motor" de la herramienta propia de James (el archivo local admin-empresas.html, que NO se
// sube al sitio). Solo responde si la petición trae la clave de administrador correcta (variable
// ADMIN_KEY en Netlify, cabecera "x-admin-key"); con cualquier otra clave responde 401 y, tras 8
// intentos fallidos en 15 minutos desde la misma conexión, bloquea por un rato.
//
// Acciones (POST, JSON, campo "accion"):
//   crear-lote     { nombre, correo, logoDataUrl, cantidad, prueba, fechaPago? }
//                  Crea la empresa, guarda su logo, genera los folios (VVITALQRE#######) y los registra
//                  como "sin activar". Devuelve la lista de enlaces (uno por trabajador).
//   agregar-folios { empresaId, cantidad }       Más folios para una empresa ya existente.
//   estado         { empresaId }                 Folios del lote, su estado y sus enlaces.
//   listar         {}                            Todas las empresas registradas.
//   crear-regalos  { cantidad (1-30), nota? }   FICHAS PERSONALES de obsequio/demostración (sin pago): toma
//                                                los siguientes folios libres del 120 al 450 y devuelve un enlace por folio.
//   listar-regalos {}                            Todos los obsequios con su estado, vencimiento y enlace.
//   (Los obsequios NO se renuevan gratis: al vencer se renuevan pagando como cualquier ficha personal.)
//   renovar        { empresaId, fechaPago }      Renovación POR EMPRESA (un solo pago): reinicia los
//                                                12 meses de todas las fichas activadas y del lote.
//
// Contadores: los folios REALES empiezan en el 100; las PRUEBAS usan del 1 al 99 (máximo 99 folios
// de prueba en total). Nunca se repite un folio: el contador solo avanza.
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { FOLIO_MIN, FOLIO_MAX, formatoFolioPersonal, firmaRegalo, enRangoRegalo, claveRegalo } = require('./lib/regalo');
const crypto = require('crypto');
const { estaBloqueado, anotar, ipDe, claveIgual } = require('./lib/limite');
const { fechaVencimiento } = require('./lib/vigencia');
const {
  idEmpresaValido, formatoFolioEmpresa, leerJson, escribirJson,
  claveLote, claveFolio, CLAVE_CONTADOR,
} = require('./lib/empresa');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const BUCKET_FICHAS = process.env.S3_BUCKET_FICHAS || 'vidavitalqr';
const SITE_URL = process.env.SITE_URL || 'https://vidavitalqr.com';

const PRIMER_FOLIO_REAL = 100;
const PRIMER_FOLIO_PRUEBA = 1;
const ULTIMO_FOLIO_PRUEBA = 99;
const MAX_FOLIOS_POR_LOTE = 500;
const MAX_LOGO_BYTES = 400 * 1024;
const TIPOS_LOGO = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };

function getS3Client() {
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Faltan configurar S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en Netlify.');
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

function emailValido(v) {
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(String(v || '').trim());
}

function slug(texto) {
  const s = String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 30).replace(/-+$/g, '');
  return s || 'empresa';
}

function enlaceDe(empresaId, folio) {
  return `${SITE_URL}/ficha.html?e=${encodeURIComponent(empresaId)}&f=${encodeURIComponent(folio)}`;
}

// "YYYY-MM-DD" -> ISO al mediodía de Costa Rica (UTC-6), para que la fecha no se corra de día
function fechaPagoIso(texto) {
  const t = String(texto || '').trim();
  if (!t) return new Date().toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 18, 0, 0));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Reserva "cantidad" números de folio del contador (real o de prueba) y devuelve la lista de folios.
async function reservarFolios(s3, cantidad, prueba) {
  const c = (await leerJson(s3, BUCKET_RESUMEN, CLAVE_CONTADOR)) || {};
  const siguienteReal = Number.isInteger(c.siguienteReal) ? c.siguienteReal : PRIMER_FOLIO_REAL;
  const siguientePrueba = Number.isInteger(c.siguientePrueba) ? c.siguientePrueba : PRIMER_FOLIO_PRUEBA;
  const inicio = prueba ? siguientePrueba : siguienteReal;
  const fin = inicio + cantidad - 1;
  if (prueba && fin > ULTIMO_FOLIO_PRUEBA) {
    const quedan = Math.max(0, ULTIMO_FOLIO_PRUEBA - inicio + 1);
    throw Object.assign(new Error(`Solo quedan ${quedan} folios de prueba (del 1 al 99).`), { codigo: 400 });
  }
  if (fin > 9999999) throw Object.assign(new Error('Se agotaron los folios de empresa.'), { codigo: 400 });
  const nuevo = {
    siguienteReal: prueba ? siguienteReal : fin + 1,
    siguientePrueba: prueba ? fin + 1 : siguientePrueba,
    actualizado: new Date().toISOString(),
  };
  // el contador se guarda ANTES de registrar los folios: si algo falla después, se pierden números
  // (queda un hueco), pero nunca se reparte el mismo folio dos veces
  await escribirJson(s3, BUCKET_RESUMEN, CLAVE_CONTADOR, nuevo);
  const folios = [];
  for (let n = inicio; n <= fin; n++) folios.push(formatoFolioEmpresa(n));
  return folios;
}

async function registrarFolios(s3, empresaId, folios) {
  const ahora = new Date().toISOString();
  for (const folio of folios) {
    await escribirJson(s3, BUCKET_RESUMEN, claveFolio(empresaId, folio), { folio, estado: 'sin_activar', creado: ahora });
  }
}

async function listarClaves(s3, prefijo, delimitador) {
  const claves = [];
  const prefijos = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET_RESUMEN, Prefix: prefijo, Delimiter: delimitador, ContinuationToken: token }));
    (r.Contents || []).forEach((o) => { if (o.Key) claves.push(o.Key); });
    (r.CommonPrefixes || []).forEach((p) => { if (p.Prefix) prefijos.push(p.Prefix); });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return { claves, prefijos };
}

async function leerFolios(s3, empresaId) {
  const { claves } = await listarClaves(s3, `empresas/${empresaId}/folios/`);
  const lista = [];
  for (const k of claves) {
    if (!k.endsWith('.json')) continue;
    const r = await leerJson(s3, BUCKET_RESUMEN, k);
    if (r) lista.push(r);
  }
  lista.sort((a, b) => String(a.folio).localeCompare(String(b.folio)));
  return lista;
}

async function crearLote(s3, p) {
  const nombre = String(p.nombre || '').trim();
  const correo = String(p.correo || '').trim();
  const cantidad = parseInt(p.cantidad, 10);
  const prueba = p.prueba === true;
  if (nombre.length < 2 || nombre.length > 80) throw Object.assign(new Error('Escriba el nombre de la empresa (entre 2 y 80 letras).'), { codigo: 400 });
  if (!emailValido(correo)) throw Object.assign(new Error('El correo de la empresa no es válido.'), { codigo: 400 });
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_FOLIOS_POR_LOTE) throw Object.assign(new Error(`La cantidad debe estar entre 1 y ${MAX_FOLIOS_POR_LOTE}.`), { codigo: 400 });
  const fechaPago = fechaPagoIso(p.fechaPago);
  if (!fechaPago) throw Object.assign(new Error('La fecha de pago no es válida (use AAAA-MM-DD).'), { codigo: 400 });
  // teléfono / correo que se muestran en la tarjeta de los colaboradores (opcionales, independientes)
  const tarjetaTelefono = String(p.tarjetaTelefono || '').replace(/\s+/g, ' ').trim();
  const tarjetaCorreo = String(p.tarjetaCorreo || '').trim();
  if (tarjetaTelefono && !/^[0-9+()\-. ]{6,20}$/.test(tarjetaTelefono)) throw Object.assign(new Error('El teléfono para la tarjeta no es válido (solo números, espacios, guion o +).'), { codigo: 400 });
  if (tarjetaCorreo && (tarjetaCorreo.length > 50 || !emailValido(tarjetaCorreo))) throw Object.assign(new Error('El correo para la tarjeta no es válido (máximo 50 caracteres).'), { codigo: 400 });

  const m = /^data:([a-z+\/]+);base64,([A-Za-z0-9+\/=]+)$/.exec(String(p.logoDataUrl || ''));
  if (!m || !TIPOS_LOGO[m[1]]) throw Object.assign(new Error('El logo debe ser un archivo PNG, JPG o SVG.'), { codigo: 400 });
  const logoBuf = Buffer.from(m[2], 'base64');
  if (!logoBuf.length || logoBuf.length > MAX_LOGO_BYTES) throw Object.assign(new Error('El logo pesa demasiado (máximo 400 KB).'), { codigo: 400 });
  if (m[1] === 'image/svg+xml' && /<script|onload\s*=|onerror\s*=|javascript:/i.test(logoBuf.toString('utf-8'))) {
    throw Object.assign(new Error('El SVG del logo contiene código no permitido.'), { codigo: 400 });
  }

  const empresaId = `${slug(nombre)}-${crypto.randomBytes(2).toString('hex')}`;
  if (!idEmpresaValido(empresaId)) throw Object.assign(new Error('No se pudo crear un identificador válido para la empresa.'), { codigo: 400 });

  // primero se reservan los folios (si no alcanzan, se rechaza sin haber guardado nada más)
  const folios = await reservarFolios(s3, cantidad, prueba);
  const logoKey = `empresas/${empresaId}/logo.${TIPOS_LOGO[m[1]]}`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET_RESUMEN, Key: logoKey, Body: logoBuf, ContentType: m[1] }));
  await registrarFolios(s3, empresaId, folios);
  await escribirJson(s3, BUCKET_RESUMEN, claveLote(empresaId), {
    id: empresaId, nombre, correo, logoKey, prueba, tarjetaTelefono, tarjetaCorreo,
    fechaPago, vencimiento: fechaVencimiento(fechaPago).toISOString(),
    totalFolios: folios.length, creado: new Date().toISOString(),
    autorizaLogo: p.autorizaLogo === true,
  });
  return { empresaId, nombre, prueba, fechaPago, folios, enlaces: folios.map((f) => ({ folio: f, enlace: enlaceDe(empresaId, f) })) };
}

async function agregarFolios(s3, p) {
  const empresaId = String(p.empresaId || '').trim().toLowerCase();
  const cantidad = parseInt(p.cantidad, 10);
  if (!idEmpresaValido(empresaId)) throw Object.assign(new Error('Empresa no válida.'), { codigo: 400 });
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_FOLIOS_POR_LOTE) throw Object.assign(new Error(`La cantidad debe estar entre 1 y ${MAX_FOLIOS_POR_LOTE}.`), { codigo: 400 });
  const lote = await leerJson(s3, BUCKET_RESUMEN, claveLote(empresaId));
  if (!lote) throw Object.assign(new Error('No existe esa empresa.'), { codigo: 404 });
  const folios = await reservarFolios(s3, cantidad, lote.prueba === true);
  await registrarFolios(s3, empresaId, folios);
  lote.totalFolios = (lote.totalFolios || 0) + folios.length;
  await escribirJson(s3, BUCKET_RESUMEN, claveLote(empresaId), lote);
  return { empresaId, nombre: lote.nombre, folios, enlaces: folios.map((f) => ({ folio: f, enlace: enlaceDe(empresaId, f) })) };
}

async function estadoLote(s3, p) {
  const empresaId = String(p.empresaId || '').trim().toLowerCase();
  if (!idEmpresaValido(empresaId)) throw Object.assign(new Error('Empresa no válida.'), { codigo: 400 });
  const lote = await leerJson(s3, BUCKET_RESUMEN, claveLote(empresaId));
  if (!lote) throw Object.assign(new Error('No existe esa empresa.'), { codigo: 404 });
  const folios = await leerFolios(s3, empresaId);
  const activas = folios.filter((f) => f.estado === 'activa').length;
  const eliminadas = folios.filter((f) => f.estado === 'eliminada').length;
  return {
    empresaId, nombre: lote.nombre, correo: lote.correo, prueba: lote.prueba === true,
    fechaPago: lote.fechaPago, vencimiento: lote.vencimiento,
    total: folios.length, activas, eliminadas, sinActivar: folios.length - activas - eliminadas,
    folios: folios.map((f) => ({ folio: f.folio, estado: f.estado, activadoEn: f.activadoEn || null, enlace: enlaceDe(empresaId, f.folio) })),
  };
}

async function listarEmpresas(s3) {
  const { prefijos } = await listarClaves(s3, 'empresas/', '/');
  const empresas = [];
  for (const pref of prefijos) {
    const id = pref.replace(/^empresas\//, '').replace(/\/$/, '');
    if (!idEmpresaValido(id)) continue;
    const lote = await leerJson(s3, BUCKET_RESUMEN, claveLote(id));
    if (lote) empresas.push({ empresaId: id, nombre: lote.nombre, prueba: lote.prueba === true, fechaPago: lote.fechaPago, vencimiento: lote.vencimiento, totalFolios: lote.totalFolios || 0 });
  }
  empresas.sort((a, b) => String(b.fechaPago).localeCompare(String(a.fechaPago)));
  return { empresas };
}

// Renovación por empresa (un solo pago): nueva fecha de pago para todo el lote. A cada ficha YA
// activada se le reinicia "creado" (registro de acceso privado) y "creado/fechaVencimiento" (datos
// públicos que lee ver.js). Las fichas todavía sin activar toman la nueva fecha al activarse.
async function renovar(s3, p) {
  const empresaId = String(p.empresaId || '').trim().toLowerCase();
  if (!idEmpresaValido(empresaId)) throw Object.assign(new Error('Empresa no válida.'), { codigo: 400 });
  const fechaPago = fechaPagoIso(p.fechaPago);
  if (!fechaPago || !String(p.fechaPago || '').trim()) throw Object.assign(new Error('Escriba la fecha del nuevo pago (AAAA-MM-DD).'), { codigo: 400 });
  const lote = await leerJson(s3, BUCKET_RESUMEN, claveLote(empresaId));
  if (!lote) throw Object.assign(new Error('No existe esa empresa.'), { codigo: 404 });
  const venc = fechaVencimiento(fechaPago).toISOString();

  const folios = await leerFolios(s3, empresaId);
  let renovadas = 0; const errores = [];
  for (const f of folios) {
    if (f.estado !== 'activa') continue;
    try {
      const keyLogin = `personas/login/${f.folio}.json`;
      const login = await leerJson(s3, BUCKET_RESUMEN, keyLogin);
      if (!login || login.empresa !== empresaId) { errores.push(`${f.folio}: registro de acceso no encontrado o de otra empresa`); continue; }
      login.creado = fechaPago;
      // se reinician los avisos de vencimiento de la ficha para el nuevo año (los mismos de siempre)
      login.vigencia = { avisos: { aviso30: false, aviso7: false, avisoVencida: false, avisoGracia30: false, avisoFinal55: false } };
      await escribirJson(s3, BUCKET_RESUMEN, keyLogin, login);
      const keyDatos = `personas/datos/${f.folio}.json`;
      const datos = await leerJson(s3, BUCKET_FICHAS, keyDatos);
      if (datos) {
        datos.creado = fechaPago; datos.fechaVencimiento = venc; datos.activo = true;
        await escribirJson(s3, BUCKET_FICHAS, keyDatos, datos);
      }
      renovadas++;
    } catch (err) {
      errores.push(`${f.folio}: ${err.message}`);
    }
  }
  lote.fechaPago = fechaPago; lote.vencimiento = venc; lote.renovado = new Date().toISOString();
  await escribirJson(s3, BUCKET_RESUMEN, claveLote(empresaId), lote);
  // se reinician los avisos de 3 / 9 meses / vencimiento para el nuevo año
  await escribirJson(s3, BUCKET_RESUMEN, `empresas/${empresaId}/avisos.json`, { aviso3: false, aviso9: false });
  return { empresaId, nombre: lote.nombre, fechaPago, vencimiento: venc, fichasRenovadas: renovadas, errores };
}

// ---------- Fichas personales de OBSEQUIO / DEMOSTRACIÓN (2026-10-26) — ver lib/regalo.js ----------
function enlaceRegalo(folio) {
  return `${SITE_URL}/ficha.html?g=${encodeURIComponent(folio)}&k=${firmaRegalo(folio)}`;
}

async function existeJson(s3, key) {
  return !!(await leerJson(s3, BUCKET_RESUMEN, key));
}

// ¿el folio ya tiene ficha (registro de acceso) en alguna de las dos ubicaciones?
async function folioConFicha(s3, folio) {
  return (await existeJson(s3, `personas/login/${folio}.json`)) || (await existeJson(s3, `login/${folio}.json`));
}

async function crearRegalos(s3, p) {
  if (!firmaRegalo('VVITALQR00000120')) throw Object.assign(new Error('Falta configurar ADMIN_KEY (mínimo 12 caracteres).'), { codigo: 500 });
  const cantidad = parseInt(p.cantidad, 10);
  if (!(cantidad >= 1 && cantidad <= 30)) throw Object.assign(new Error('La cantidad debe estar entre 1 y 30.'), { codigo: 400 });
  const nota = String(p.nota || '').trim().slice(0, 80);
  const ahora = new Date().toISOString();
  const creados = [];
  for (let n = FOLIO_MIN; n <= FOLIO_MAX && creados.length < cantidad; n++) {
    const folio = formatoFolioPersonal(n);
    if (await existeJson(s3, claveRegalo(folio))) continue;       // ya es un obsequio
    if (await folioConFicha(s3, folio)) continue;                  // lo usa una ficha real
    try {
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_RESUMEN, Key: claveRegalo(folio), ContentType: 'application/json', IfNoneMatch: '*',
        Body: Buffer.from(JSON.stringify({ folio, estado: 'sin_activar', creado: ahora, nota }), 'utf-8'),
      }));
      creados.push(folio);
    } catch (err) {
      if (err && (err.name === 'PreconditionFailed' || (err.$metadata && err.$metadata.httpStatusCode === 412))) continue;
      throw err;
    }
  }
  if (!creados.length) throw Object.assign(new Error(`Ya no quedan folios de obsequio libres (${FOLIO_MIN} a ${FOLIO_MAX}).`), { codigo: 400 });
  return { folios: creados, enlaces: creados.map((f) => ({ folio: f, enlace: enlaceRegalo(f) })), solicitados: cantidad };
}

async function listarRegalos(s3) {
  const { claves } = await listarClaves(s3, 'regalos/');
  const lista = [];
  for (const k of claves) {
    if (!k.endsWith('.json')) continue;
    const r = await leerJson(s3, BUCKET_RESUMEN, k);
    if (!r || !enRangoRegalo(r.folio)) continue;
    let estado = r.estado === 'activa' ? 'activa' : 'sin_activar';
    let vencimiento = '';
    if (estado === 'activa') {
      const login = (await leerJson(s3, BUCKET_RESUMEN, `personas/login/${r.folio}.json`)) || (await leerJson(s3, BUCKET_RESUMEN, `login/${r.folio}.json`));
      if (login && login.creado) vencimiento = fechaVencimiento(login.creado).toISOString();
      else estado = 'eliminada';
    }
    lista.push({ folio: r.folio, estado, nota: r.nota || '', creado: r.creado || '', activadoEn: r.activadoEn || '', vencimiento, enlace: enlaceRegalo(r.folio) });
  }
  lista.sort((a, b) => String(a.folio).localeCompare(String(b.folio)));
  return { regalos: lista, rango: `${FOLIO_MIN} a ${FOLIO_MAX}` };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };

  const claveReal = process.env.ADMIN_KEY;
  if (!claveReal || claveReal.length < 12) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Falta configurar ADMIN_KEY en Netlify (mínimo 12 caracteres).' }) };
  }

  let s3;
  try { s3 = getS3Client(); } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }

  const VENTANA = 15 * 60 * 1000;
  const ip = ipDe(event);
  if (await estaBloqueado(s3, BUCKET_RESUMEN, 'admin-ip', ip, 8, VENTANA)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Demasiados intentos. Espere unos 15 minutos.' }) };
  }
  const claveEnviada = (event.headers && (event.headers['x-admin-key'] || event.headers['X-Admin-Key'])) || '';
  if (!claveIgual(claveEnviada, claveReal)) {
    await anotar(s3, BUCKET_RESUMEN, 'admin-ip', ip, VENTANA);
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Clave de administrador incorrecta.' }) };
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  try {
    let resultado;
    switch (p.accion) {
      case 'crear-lote': resultado = await crearLote(s3, p); break;
      case 'agregar-folios': resultado = await agregarFolios(s3, p); break;
      case 'estado': resultado = await estadoLote(s3, p); break;
      case 'listar': resultado = await listarEmpresas(s3); break;
      case 'renovar': resultado = await renovar(s3, p); break;
      case 'crear-regalos': resultado = await crearRegalos(s3, p); break;
      case 'listar-regalos': resultado = await listarRegalos(s3); break;
      default: return { statusCode: 400, headers, body: JSON.stringify({ error: 'Acción desconocida.' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...resultado }) };
  } catch (err) {
    if (err && err.codigo) return { statusCode: err.codigo, headers, body: JSON.stringify({ error: err.message }) };
    console.error('admin-empresas: error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error interno: ' + (err && err.message ? err.message : err) }) };
  }
};
