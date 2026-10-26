// ---- lib/regalo.js (2026-10-26) ----
// Fichas PERSONALES de obsequio / demostración (sin pago). Reglas acordadas con James:
//  - Usan folios personales normales (VVITALQR + 8 dígitos) pero SOLO del 120 al 450.
//    (El contador de fichas personales que pagan arranca en 500, ver folio-nuevo.js.)
//  - Cada obsequio se crea con la herramienta de James (admin-empresas.js, acciones *-regalos).
//    Queda registrado en S3: regalos/<folio>.json  { folio, estado: sin_activar | activa, creado, nota }
//  - El enlace que recibe la persona lleva una firma (HMAC con ADMIN_KEY): ficha.html?g=<folio>&k=<firma>.
//    Sin la firma correcta nadie puede llenar un folio de obsequio.
//  - La persona llena su ficha personal normal (sin logo ni cargo); la ficha nace ACTIVA y la
//    vigencia (12 meses) cuenta desde que la activa. Después vence como cualquier ficha personal.
const crypto = require('crypto');

const FOLIO_MIN = 120;
const FOLIO_MAX = 450;
const FOLIO_PERSONAL_RE = /^VVITALQR(\d{8})$/;

function numeroDeFolio(folio) {
  const m = FOLIO_PERSONAL_RE.exec(String(folio || ''));
  return m ? parseInt(m[1], 10) : null;
}

function enRangoRegalo(folio) {
  const n = numeroDeFolio(folio);
  return n !== null && n >= FOLIO_MIN && n <= FOLIO_MAX;
}

function formatoFolioPersonal(n) {
  return 'VVITALQR' + String(n).padStart(8, '0');
}

function firmaRegalo(folio) {
  const secreto = process.env.ADMIN_KEY;
  if (!secreto || secreto.length < 12) return '';
  return crypto.createHmac('sha256', secreto).update('regalo:' + folio).digest('hex').slice(0, 24);
}

function firmaValida(folio, k) {
  const esperada = firmaRegalo(folio);
  const dada = String(k || '');
  if (!esperada || dada.length !== esperada.length) return false;
  return crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(dada));
}

const claveRegalo = (folio) => `regalos/${folio}.json`;

module.exports = { FOLIO_MIN, FOLIO_MAX, numeroDeFolio, enRangoRegalo, formatoFolioPersonal, firmaRegalo, firmaValida, claveRegalo };
