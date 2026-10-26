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
//  - El efecto sobre cada ficha es el mismo de la acción "renovar" de admin-empresas.js (la herramienta de
//    James, Etapa 1, que no se tocó): reinicia "creado" y los avisos de vencimiento de cada ficha activa.
const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { fechaVencimiento, finGracia, sumarMeses, MS_POR_DIA } = require('./vigencia');
const { idEmpresaValido, leerJson, escribirJson, claveLote, claveAvisos } = require('./empresa');
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

// Resumen de la renovación de una empresa. Devuelve null si la empresa no existe.
async function infoRenovacion(s3, empresaId, ahora) {
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
  let abierta = true; let motivo = '';
  if (ahora < desde) { abierta = false; motivo = 'antes'; }
  else if (gracia && ahora >= gracia) { abierta = false; motivo = 'eliminadas'; }
  else if (activas < 1) { abierta = false; motivo = 'sin-activas'; }
  const precio = calcularRenovacion(activas);
  // fecha desde la cual correrán los 12 meses nuevos: el vencimiento actual si todavía no vence
  const inicioNuevo = ahora < venc ? venc : ahora;
  return {
    empresaId, nombre: lote.nombre, correo: lote.correo, prueba: lote.prueba === true,
    vencimiento: venc.toISOString(), desde: desde.toISOString(), finGracia: gracia ? gracia.toISOString() : null,
    total: folios.length, activas, eliminadas, sinActivar: folios.length - activas - eliminadas,
    abierta, motivo, inicioNuevo: inicioNuevo.toISOString(), nuevoVencimiento: sumarMeses(inicioNuevo, 12).toISOString(),
    precio,
  };
}

// Aplica la renovación: el mismo efecto que "renovar" de admin-empresas.js. "fechaPagoIso" = inicio de los 12 meses nuevos.
async function aplicarRenovacion(s3, empresaId, fechaPagoIso) {
  const lote = await leerJson(s3, BUCKET_RESUMEN, claveLote(empresaId));
  if (!lote) throw new Error('No existe la empresa ' + empresaId);
  const venc = sumarMeses(new Date(fechaPagoIso), 12).toISOString();
  const folios = await leerFoliosDeEmpresa(s3, empresaId);
  let renovadas = 0; const errores = [];
  for (const f of folios) {
    if (f.estado !== 'activa') continue;
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
    } catch (err) { errores.push(`${f.folio}: ${err.message}`); }
  }
  lote.fechaPago = fechaPagoIso; lote.vencimiento = venc; lote.renovado = new Date().toISOString();
  await escribirJson(s3, BUCKET_RESUMEN, claveLote(empresaId), lote);
  await escribirJson(s3, BUCKET_RESUMEN, claveAvisos(empresaId), { aviso3: false, aviso9: false });
  return { empresaId, nombre: lote.nombre, fechaPago: fechaPagoIso, vencimiento: venc, fichasRenovadas: renovadas, errores };
}

module.exports = { DIAS_ANTES_RENOVAR, leerFoliosDeEmpresa, infoRenovacion, aplicarRenovacion };
