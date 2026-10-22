// ---- lib/empresa.js (Etapa 1 de tarjetas para empresas, 2026-10-20) ----
// Utilidades compartidas por send-ficha.js, empresa-info.js, admin-empresas.js, login-ficha.js y
// revisar-empresas.js para el producto "Identificador QR para empresas".
//
// Reglas (acordadas con James, 2026-10-20):
//  - Folio de empresa: VVITALQRE + 7 dígitos (los personales siguen siendo VVITALQR + 8 dígitos).
//    Ambos miden 16 caracteres. Las pruebas usan del 1 al 99; los reales empiezan en el 100.
//  - Un folio de empresa SOLO se puede llenar si fue registrado antes con la herramienta de James.
//  - Todo se guarda en el bucket PRIVADO de resumen (S3), bajo "empresas/<id-empresa>/...":
//        empresas/_contador.json                  contador de folios (reales y de prueba)
//        empresas/<id>/lote.json                  datos de la empresa y del pedido (nombre, correo, fecha de pago, folios)
//        empresas/<id>/logo.<ext>                 logo de la empresa
//        empresas/<id>/folios/<folio>.json        estado de CADA folio: sin_activar | activa
//        empresas/<id>/tarjetas/<folio>.jpg       tarjeta lista para imprimir (se copia aquí al activarse la ficha)
//        empresas/<id>/avisos.json                qué avisos (3 y 9 meses, vencimiento) ya se enviaron
//    Se guarda un archivo por folio (y no una sola lista) para que dos trabajadores que llenen su
//    ficha al mismo tiempo nunca se pisen el uno al otro.
//  - El PIN NO existe hasta que el trabajador llena su ficha, y nunca se guarda en esta carpeta:
//    queda solo en el registro de acceso de la ficha (personas/login/<folio>.json), igual que hoy.
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const FOLIO_EMPRESA_RE = /^VVITALQRE\d{7}$/;
const ID_EMPRESA_RE = /^[a-z0-9][a-z0-9-]{2,47}$/;

function esFolioEmpresa(folio) {
  return FOLIO_EMPRESA_RE.test(String(folio || ''));
}

function idEmpresaValido(id) {
  return ID_EMPRESA_RE.test(String(id || ''));
}

function formatoFolioEmpresa(n) {
  return 'VVITALQRE' + String(n).padStart(7, '0');
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function esNoExiste(err) {
  return !!err && (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404);
}

// Lee un JSON; devuelve null si no existe (cualquier otro error SÍ se propaga).
async function leerJson(s3, bucket, key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await streamToString(r.Body));
  } catch (err) {
    if (esNoExiste(err)) return null;
    throw err;
  }
}

async function escribirJson(s3, bucket, key, objeto) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: Buffer.from(JSON.stringify(objeto), 'utf-8'),
    ContentType: 'application/json',
  }));
}

const claveLote = (id) => `empresas/${id}/lote.json`;
const claveFolio = (id, folio) => `empresas/${id}/folios/${folio}.json`;
const claveAvisos = (id) => `empresas/${id}/avisos.json`;
const claveTarjeta = (id, folio) => `empresas/${id}/tarjetas/${folio}.jpg`;
// Copia ordenada de la ficha del trabajador (2026-10-20): empresas/<id>/fichas/<folio>/<archivo>.
// Es solo una COPIA de consulta; la ficha que usa el visor/login sigue en personas/.
// El PIN y el registro de acceso NUNCA se copian aquí.
const claveFichaCopia = (id, folio, archivo) => `empresas/${id}/fichas/${folio}/${archivo}`;
const ARCHIVOS_FICHA_COPIA = ['ficha.pdf', 'datos.json', 'qr.svg', 'foto.jpg', 'foto.png', 'foto.webp'];
const CLAVE_CONTADOR = 'empresas/_contador.json';

// Devuelve { lote, registroFolio } si el folio pertenece de verdad a esa empresa; si no, null.
async function cargarFolioDeEmpresa(s3, bucket, empresaId, folio) {
  if (!idEmpresaValido(empresaId) || !esFolioEmpresa(folio)) return null;
  const registroFolio = await leerJson(s3, bucket, claveFolio(empresaId, folio));
  if (!registroFolio || registroFolio.folio !== folio) return null;
  const lote = await leerJson(s3, bucket, claveLote(empresaId));
  if (!lote) return null;
  return { lote, registroFolio };
}

module.exports = {
  FOLIO_EMPRESA_RE, esFolioEmpresa, idEmpresaValido, formatoFolioEmpresa,
  streamToString, streamToBuffer, esNoExiste, leerJson, escribirJson,
  claveLote, claveFolio, claveAvisos, claveTarjeta, claveFichaCopia, ARCHIVOS_FICHA_COPIA, CLAVE_CONTADOR,
  cargarFolioDeEmpresa,
};
