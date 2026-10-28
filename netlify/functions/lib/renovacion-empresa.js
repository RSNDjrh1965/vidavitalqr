// ---- lib/renovacion-empresa.js (Etapa 3: renovación de empresas con pago por ONVO, 2026-10-22) ----
// Lógica compartida por renovacion-empresa.js (la página: resumen + creación del pago), onvo-webhook.js
// (al confirmarse el pago) y revisar-empresas.js (aviso con el enlace de renovación).
//
// Reglas (acordadas con James, 2026-10-22):
//  - La empresa renueva TODAS sus fichas activas con un solo pago: $5 por ficha (mínimo 5 fichas) + IVA.
//  - Solo se puede renovar desde 60 días antes del vencimiento hasta el fin del período de gracia (2 meses
//    después de vencer; después las fichas se eliminan, igual que las personales).
//  - Si se renueva ANTES de vencer, no se pierden los meses que quedaban: la nueva vigencia suma 12 meses
//    al vencimiento actual. Si ya venció (período de gracia), los 12 meses cuentan desde el día del pago.
//  - BAJAS (2026-10-28): la empresa puede anotar los folios de quienes ya no trabajan en ella. Esas fichas NO se
//    renuevan ni se cobran; siguen su cronología normal de vencimiento (avisos al titular, gracia y eliminación) y,
//    si el trabajador quiere continuar, adquiere su código de forma individual. El precio se calcula con las
//    fichas activas MENOS las bajas (el mínimo de 5 fichas se mantiene).
//  - El efecto sobre cada ficha es el mismo de la acción "renovar" de admin-empresas.js (la herramienta de
//    James, Etapa 1, que no se tocó): reinicia "creado" y los avisos de vencimiento de cada ficha activa.
const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { fechaVencimiento, finGracia, sumarMeses, MS_POR_DIA } = require('./vigencia');
const { idEmpresaValido, esFolioEmpresa, leerJson, escribirJson, claveLote, claveAvisos, claveFolio } = require('./empresa');
const { BUCKET_RESUMEN, calcularRenovacion } = require('./lote-empresa');

const BUCKET_FICHAS = process.env.S3_BUCKET_FICHAS || 'vidavitalqr';
const DIAS_ANTES_RENOVAR = 60;

async function leerFoliosDeEmpresa(s3, empresaId) {
  const claves = []; let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET_RESUMEN, Prefix: `empresas/${empresaId}/folios/`, ContinuationToken: token }));
    (r.Contents || []).forEach((o) => { if (o.Key && o.Key.endsWith('.json')) claves.push(o.Key); });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  const lista = [];
  for (const k of claves) { const f = await leerJson(s3, BUCKET_RESUMEN, k); if (f) lista.push(f); }
  return lista;
}

const MAX_BAJAS = 300;
// Texto o lista -> folios en mayúsculas, sin repetir (acepta saltos de línea, espacios, comas o punto y coma).
function normalizarBajas(entrada) {
  const partes = Array.isArray(entrada) ? entrada : String(entrada || '').split(/[\s,;]+/);
  const vistos = new Set(); const lista = [];
  for (const p of partes) {
    const f = String(p || '').trim().toUpperCase();
    if (!f || vistos.has(f)) continue;
    vistos.add(f); lista.push(f);
    if (lista.length >= MAX_BAJAS) break;
  }
  return lista;
}
// Clasifica los folios de baja contra los folios REALES de la empresa:
//  - validas: folios de esta empresa que están activos (se excluyen de la renovación)
//  - ignoradas: folios de esta empresa que no están activos (sin activar o eliminados): no se cobran ni se renuevan de todos modos
//  - invalidas: no tienen el formato de folio de empresa o no existen en ESTA empresa (el pago se rechaza para que lo corrijan)
function clasificarBajas(folios, bajas) {
  const porFolio = new Map(folios.map((f) => [String(f.folio || '').toUpperCase(), f]));
  const validas = []; const ignoradas = []; const invalidas = [];
  for (const b of bajas) {
    if (!esFolioEmpresa(b)) { invalidas.push({ folio: b, motivo: 'no tiene el formato de un folio de empresa (VVITALQRE y 7 números)' }); continue; }
    const f = porFolio.get(b);
    if (!f) { invalidas.push({ folio: b, motivo: 'no se encontró en su empresa' }); continue; }
    if (f.estado === 'activa') validas.push(b); else ignoradas.push(b);
  }
  return { validas, ignoradas, invalidas };
}

// Resumen de la renovación de una empresa. Devuelve null si la empresa no existe.
// "bajas" (opcional): folios que la empresa quiere excluir de la renovación.
async function infoRenovacion(s3, empresaId, ahora, bajas) {
  ahora = ahora || new Date();
  if (!idEmpresaValido(empresaId)) return null;
  const lote = await leerJson(s3, BUCKET_RESUMEN, claveLote(empresaId));
  if (!lote || !lote.fechaPago) return null;
  const venc = new Date(lote.vencimiento || fechaVencimiento(lote.fechaPago));
  const gracia = finGracia(lote.fechaPago);
  const desde = new Date(venc.getTime() - DIAS_ANTES_RENOVAR * MS_POR_DIA);
  const folios = await leerFoliosDeEmpresa(s3, empresaId);
  const activas = folios.filter((f) => f.estado === 'activa').length;
  const eliminadas = folios.filter((f) => f.estado === 'eliminada').length;
  const clas = clasificarBajas(folios, normalizarBajas(bajas));
  const activasNetas = activas - clas.validas.length;
  let abierta = true; let motivo = '';
  if (ahora < desde) { abierta = false; motivo = 'antes'; }
  else if (gracia && ahora >= gracia) { abierta = false; motivo = 'eliminadas'; }
  else if (activas < 1) { abierta = false; motivo = 'sin-activas'; }
  else if (activasNetas < 1) { abierta = false; motivo = 'todas-baja'; }
  const precio = calcularRenovacion(activasNetas);
  // fecha desde la cual correrán los 12 meses nuevos: el vencimiento actual si todavía no vence
  const inicioNuevo = ahora < venc ? venc : ahora;
  return {
    empresaId, nombre: lote.nombre, correo: lote.correo, prueba: lote.prueba === true,
    vencimiento: venc.toISOString(), desde: desde.toISOString(), finGracia: gracia ? gracia.toISOString() : null,
    total: folios.length, activas, eliminadas, sinActivar: folios.length - activas - eliminadas,
    activasNetas, bajas: clas,
    abierta, motivo, inicioNuevo: inicioNuevo.toISOString(), nuevoVencimiento: sumarMeses(inicioNuevo, 12).toISOString(),
    precio,
  };
}

// Aplica la renovación: el mismo efecto que "renovar" de admin-empresas.js. "fechaPagoIso" = inicio de los 12 meses nuevos.
// "excluir" (opcional): folios de baja — no se tocan (conservan su vigencia y su cronología de vencimiento).
async function aplicarRenovacion(s3, empresaId, fechaPagoIso, excluir, pagoId) {
  const sinRenovar = new Set(normalizarBajas(excluir));
  const lote = await leerJson(s3, BUCKET_RESUMEN, claveLote(empresaId));
  if (!lote) throw new Error('No existe la empresa ' + empresaId);
  const venc = sumarMeses(new Date(fechaPagoIso), 12).toISOString();
  const folios = await leerFoliosDeEmpresa(s3, empresaId);
  let renovadas = 0; const errores = []; const noRenovadas = [];
  for (const f of folios) {
    if (f.estado !== 'activa') continue;
    if (sinRenovar.has(String(f.folio || '').toUpperCase())) {
      noRenovadas.push(f.folio);
      // se anota la baja en el registro del folio de la empresa (el visor, los avisos de vencimiento y la ficha la consultan)
      try { await escribirJson(s3, BUCKET_RESUMEN, claveFolio(empresaId, f.folio), Object.assign({}, f, { baja: { fecha: new Date().toISOString(), pago: pagoId || '' } })); }
      catch (err) { errores.push(`${f.folio}: no se pudo anotar la baja — ${err.message}`); }
      continue;
    }
    try {
      const keyLogin = `personas/login/${f.folio}.json`;
      const login = await leerJson(s3, BUCKET_RESUMEN, keyLogin);
      if (!login || login.empresa !== empresaId) { errores.push(`${f.folio}: registro de acceso no encontrado o de otra empresa`); continue; }
      login.creado = fechaPagoIso;
      login.vigencia = { avisos: { aviso30: false, aviso7: false, avisoVencida: false, avisoGracia30: false, avisoFinal55: false } };
      await escribirJson(s3, BUCKET_RESUMEN, keyLogin, login);
      const keyDatos = `personas/datos/${f.folio}.json`;
      const datos = await leerJson(s3, BUCKET_FICHAS, keyDatos);
      if (datos) { datos.creado = fechaPagoIso; datos.fechaVencimiento = venc; datos.activo = true; await escribirJson(s3, BUCKET_FICHAS, keyDatos, datos); }
      renovadas++;
      if (f.baja) { // una ficha que antes se dio de baja y ahora sí se renueva: se quita la marca
        const limpio = Object.assign({}, f); delete limpio.baja;
        try { await escribirJson(s3, BUCKET_RESUMEN, claveFolio(empresaId, f.folio), limpio); } catch (err) { errores.push(`${f.folio}: no se pudo quitar la marca de baja — ${err.message}`); }
      }
    } catch (err) { errores.push(`${f.folio}: ${err.message}`); }
  }
  lote.fechaPago = fechaPagoIso; lote.vencimiento = venc; lote.renovado = new Date().toISOString();
  await escribirJson(s3, BUCKET_RESUMEN, claveLote(empresaId), lote);
  await escribirJson(s3, BUCKET_RESUMEN, claveAvisos(empresaId), { aviso3: false, aviso9: false });
  return { empresaId, nombre: lote.nombre, fechaPago: fechaPagoIso, vencimiento: venc, fichasRenovadas: renovadas, fichasNoRenovadas: noRenovadas, errores };
}

module.exports = { DIAS_ANTES_RENOVAR, MAX_BAJAS, normalizarBajas, clasificarBajas, leerFoliosDeEmpresa, infoRenovacion, aplicarRenovacion };
