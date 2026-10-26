// ---- lib/enlace-qr.js (2026-10-22) ----
// Firma (token) del enlace "Mi identificador QR" (/qr/<folio>?t=<firma>) del producto "Identificador
// QR digital". La página /qr/<folio> existía solo para mostrar el código QR; con este producto
// también muestra la tarjeta con FOTO, y como los folios son consecutivos (adivinables), esa parte
// solo se muestra si el enlace trae una firma válida, que solo se genera en onvo-webhook.js al
// confirmarse el pago y se envía por correo al comprador. Sin firma (o con una inválida) la página
// sigue siendo exactamente la de siempre (QR + nombre), así que los enlaces de compras anteriores
// no cambian.
//
// La firma es un HMAC-SHA256 del folio. La clave es QR_LINK_SECRET (variable de Netlify); si no
// existe, se usa S3_SECRET_ACCESS_KEY, que ya está configurada y la tienen ambas funciones.
const crypto = require('crypto');

function claveSecreta() {
  return process.env.QR_LINK_SECRET || process.env.S3_SECRET_ACCESS_KEY || '';
}

function firmarFolio(folio) {
  const clave = claveSecreta();
  if (!clave) return '';
  return crypto.createHmac('sha256', clave).update('qr-tarjeta:' + String(folio || '').toUpperCase()).digest('hex').slice(0, 32);
}

function firmaValida(folio, firma) {
  const esperada = firmarFolio(folio);
  const recibida = String(firma || '');
  if (!esperada || recibida.length !== esperada.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(recibida));
  } catch (e) {
    return false;
  }
}

// ---- 2026-10-22 (Etapa 3): enlace permanente de RENOVACIÓN de una empresa (/empresas.html?renovar=<id>&t=<firma>).
// Solo permite ver el resumen de la renovación y pagarla por ONVO; no da acceso a ningún dato de los colaboradores. ----
function firmarEmpresa(empresaId) {
  const clave = claveSecreta();
  if (!clave) return '';
  return crypto.createHmac('sha256', clave).update('empresa-renovar:' + String(empresaId || '').toLowerCase()).digest('hex').slice(0, 32);
}

function firmaEmpresaValida(empresaId, firma) {
  const esperada = firmarEmpresa(empresaId);
  const recibida = String(firma || '');
  if (!esperada || recibida.length !== esperada.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(recibida)); } catch (e) { return false; }
}

module.exports = { firmarFolio, firmaValida, firmarEmpresa, firmaEmpresaValida };
