// ---- lib/lote-empresa.js (Etapa 2 de tarjetas para empresas, 2026-10-22) ----
// Pedido de tarjetas por la propia empresa (página /empresas.html) + pago por ONVO. Aquí vive todo lo
// que comparten pedido-empresa.js (antes del pago) y onvo-webhook.js (al confirmarse el pago):
// validación de datos y logo, precios por tramos, y la creación automática del lote de folios.
//
// OJO: la creación del lote repite a propósito la lógica de crear-lote de admin-empresas.js (la
// herramienta de James, Etapa 1, que NO se tocó para no arriesgar lo que ya funciona). Usan el MISMO
// contador (empresas/_contador.json) y el MISMO formato de carpetas, así que ambos caminos conviven.
const crypto = require('crypto');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { fechaVencimiento } = require('./vigencia');
const { idEmpresaValido, formatoFolioEmpresa, leerJson, escribirJson, claveLote, claveFolio, CLAVE_CONTADOR } = require('./empresa');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const SITE_URL = process.env.SITE_URL || 'https://vidavitalqr.com';
const PRIMER_FOLIO_REAL = 100;
const PRIMER_FOLIO_PRUEBA = 1;
const ULTIMO_FOLIO_PRUEBA = 99;
const MAX_TARJETAS_POR_PEDIDO = 500;
const MAX_LOGO_BYTES = 400 * 1024;
const TIPOS_LOGO = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };
const IVA_RATE = 0.13;

// ---- precio POR TARJETA según la cantidad del pedido y la modalidad (acordado con James, 2026-10-22; ver
// claude/precios-empresas-propuesta-2026-10-22-vidavitalqr.md). El precio del tramo aplica a TODAS las tarjetas del
// pedido. Debe coincidir con las tablas de index.html y empresas.html.
//   fisica : tarjeta impresa (la imprime y entrega James)      1-10 $12 · 11-50 $11 · 51-100 $10 · 101-500 $9
//   digital: sin impresión (cada colaborador la descarga)       1-10 $8  · 11-50 $7  · 51-500  $6
// Renovación anual de la empresa: $5 por ficha activa, con un mínimo de 5 fichas (para que el cargo fijo de
// ONVO no se coma la renovación de grupos muy pequeños). ----
const MODALIDADES = ['fisica', 'digital'];
const TRAMOS = {
  fisica: [[10, 12], [50, 11], [100, 10], [Infinity, 9]],
  digital: [[10, 8], [50, 7], [Infinity, 6]],
};
const PRECIO_RENOVACION = 5;
const MIN_FICHAS_RENOVACION = 5;

// ---- envío de tarjetas IMPRESAS (2026-10-23, tarifas de James; se cobra la base y el IVA se suma después):
// hasta 100 tarjetas $9.50; más de 100 $12.50. Solo digital: sin envío. Con "retiro en persona": sin envío. ----
const ENVIO_EMPRESA_HASTA_100 = 9.5;
const ENVIO_EMPRESA_MAS_100 = 12.5;
const TOPE_ENVIO_BASE = 100;

function envioEmpresa(cantidad, modalidad, retiroPersona) {
  if (modalidad === 'digital' || retiroPersona === true) return 0;
  return cantidad <= TOPE_ENVIO_BASE ? ENVIO_EMPRESA_HASTA_100 : ENVIO_EMPRESA_MAS_100;
}

function precioPorTarjeta(cantidad, modalidad) {
  const tramos = TRAMOS[modalidad === 'digital' ? 'digital' : 'fisica'];
  for (const [tope, precio] of tramos) if (cantidad <= tope) return precio;
  return tramos[tramos.length - 1][1];
}

function totalesEnCentavos(unit, cantidad, envio) {
  const tarjetasCents = Math.round(unit * cantidad * 100);
  const envioCents = Math.round((envio || 0) * 100);
  const subtotalCents = tarjetasCents + envioCents;
  const ivaCents = Math.round(subtotalCents * IVA_RATE);
  return { precioUnitario: unit, subtotalTarjetas: tarjetasCents / 100, envio: envioCents / 100, subtotal: subtotalCents / 100, iva: ivaCents / 100, totalUSD: (subtotalCents + ivaCents) / 100 };
}

// cálculo en centavos enteros (igual que crear-pago.js)
function calcularTotales(cantidad, modalidad, retiroPersona) {
  return totalesEnCentavos(precioPorTarjeta(cantidad, modalidad), cantidad, envioEmpresa(cantidad, modalidad, retiroPersona));
}

// renovación: se cobra por cada ficha activa, con un mínimo de MIN_FICHAS_RENOVACION
function calcularRenovacion(fichasActivas) {
  const cobradas = Math.max(Number(fichasActivas) || 0, MIN_FICHAS_RENOVACION);
  return Object.assign({ fichasCobradas: cobradas }, totalesEnCentavos(PRECIO_RENOVACION, cobradas));
}

function error400(msg) { return Object.assign(new Error(msg), { codigo: 400 }); }

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

// 2026-10-26: teléfono y correo que la empresa (RR. HH.) decide mostrar en las tarjetas de todos sus colaboradores.
// Ambos son opcionales e independientes: si se dejan en blanco, no aparecen en la tarjeta.
function validarContactoTarjeta(p) {
  const tarjetaTelefono = String(p.tarjetaTelefono || '').replace(/\s+/g, ' ').trim();
  const tarjetaCorreo = String(p.tarjetaCorreo || '').trim();
  if (tarjetaTelefono && (tarjetaTelefono.length > 20 || !/^[0-9+()\-. ]{6,20}$/.test(tarjetaTelefono))) throw error400('El teléfono para la tarjeta no es válido (solo números, espacios, guion o +; máximo 20 caracteres).');
  if (tarjetaCorreo && (tarjetaCorreo.length > 50 || !emailValido(tarjetaCorreo))) throw error400('El correo para la tarjeta no es válido (máximo 50 caracteres).');
  return { tarjetaTelefono, tarjetaCorreo };
}

// Valida y normaliza los datos del pedido. Lanza error {codigo:400} con un mensaje claro.
function validarPedido(p) {
  const nombre = String(p.nombre || '').trim();
  const correo = String(p.correo || '').trim();
  const telefono = String(p.telefono || '').trim().slice(0, 30);
  const cantidad = parseInt(p.cantidad, 10);
  const contactoTarjeta = validarContactoTarjeta(p);
  if (nombre.length < 2 || nombre.length > 80) throw error400('Escriba el nombre de la empresa (entre 2 y 80 letras).');
  if (!emailValido(correo)) throw error400('El correo de la empresa no es válido.');
  if (!Number.isInteger(cantidad) || cantidad < 1) throw error400('Indique cuántas tarjetas necesita (mínimo 1).');
  if (cantidad > MAX_TARJETAS_POR_PEDIDO) throw error400(`Para más de ${MAX_TARJETAS_POR_PEDIDO} tarjetas escríbanos por WhatsApp para coordinar el pedido.`);
  if (p.autorizaLogo !== true) throw error400('Debe confirmar que su empresa autoriza el uso del logo en las tarjetas.');
  const m = /^data:([a-z+\/]+);base64,([A-Za-z0-9+\/=]+)$/.exec(String(p.logoDataUrl || ''));
  if (!m || !TIPOS_LOGO[m[1]]) throw error400('El logo debe ser un archivo PNG, JPG o SVG.');
  const logoBuf = Buffer.from(m[2], 'base64');
  if (!logoBuf.length || logoBuf.length > MAX_LOGO_BYTES) throw error400('El logo pesa demasiado (máximo 400 KB).');
  if (m[1] === 'image/svg+xml' && /<script|onload\s*=|onerror\s*=|javascript:/i.test(logoBuf.toString('utf-8'))) {
    throw error400('El SVG del logo contiene código no permitido.');
  }
  const modalidad = String(p.modalidad || 'fisica').trim().toLowerCase();
  if (MODALIDADES.indexOf(modalidad) === -1) throw error400('Elija si desea la tarjeta impresa o solo digital.');
  // retiro en persona: solo con tarjeta impresa (en digital no hay envío que evitar)
  const retiroPersona = modalidad === 'fisica' && p.retiroPersona === true;
  return { nombre, correo, telefono, tarjetaTelefono: contactoTarjeta.tarjetaTelefono, tarjetaCorreo: contactoTarjeta.tarjetaCorreo, cantidad, modalidad, retiroPersona, logoTipo: m[1], logoBase64: m[2] };
}

async function reservarFolios(s3, cantidad, prueba) {
  const c = (await leerJson(s3, BUCKET_RESUMEN, CLAVE_CONTADOR)) || {};
  const siguienteReal = Number.isInteger(c.siguienteReal) ? c.siguienteReal : PRIMER_FOLIO_REAL;
  const siguientePrueba = Number.isInteger(c.siguientePrueba) ? c.siguientePrueba : PRIMER_FOLIO_PRUEBA;
  const inicio = prueba ? siguientePrueba : siguienteReal;
  const fin = inicio + cantidad - 1;
  if (prueba && fin > ULTIMO_FOLIO_PRUEBA) {
    const quedan = Math.max(0, ULTIMO_FOLIO_PRUEBA - inicio + 1);
    throw error400(`Solo quedan ${quedan} folios de prueba (del 1 al 99).`);
  }
  if (fin > 9999999) throw error400('Se agotaron los folios de empresa.');
  await escribirJson(s3, BUCKET_RESUMEN, CLAVE_CONTADOR, {
    siguienteReal: prueba ? siguienteReal : fin + 1,
    siguientePrueba: prueba ? fin + 1 : siguientePrueba,
    actualizado: new Date().toISOString(),
  });
  const folios = [];
  for (let n = inicio; n <= fin; n++) folios.push(formatoFolioEmpresa(n));
  return folios;
}

// Crea el lote de la empresa: logo, folios "sin activar" y lote.json. "datos" = salida de validarPedido.
// opciones: { prueba, fechaPago (ISO), pedidoId, autorizaLogoFecha }
async function crearLoteDePedido(s3, datos, opciones) {
  const empresaId = `${slug(datos.nombre)}-${crypto.randomBytes(2).toString('hex')}`;
  if (!idEmpresaValido(empresaId)) throw error400('No se pudo crear un identificador válido para la empresa.');
  const prueba = opciones.prueba === true;
  const fechaPago = opciones.fechaPago || new Date().toISOString();
  const folios = await reservarFolios(s3, datos.cantidad, prueba);
  const logoKey = `empresas/${empresaId}/logo.${TIPOS_LOGO[datos.logoTipo]}`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET_RESUMEN, Key: logoKey, Body: Buffer.from(datos.logoBase64, 'base64'), ContentType: datos.logoTipo }));
  const ahora = new Date().toISOString();
  for (const folio of folios) {
    await escribirJson(s3, BUCKET_RESUMEN, claveFolio(empresaId, folio), { folio, estado: 'sin_activar', creado: ahora });
  }
  await escribirJson(s3, BUCKET_RESUMEN, claveLote(empresaId), {
    id: empresaId, nombre: datos.nombre, correo: datos.correo, logoKey, prueba,
    fechaPago, vencimiento: fechaVencimiento(fechaPago).toISOString(),
    totalFolios: folios.length, creado: ahora,
    autorizaLogo: true, autorizaLogoFecha: opciones.autorizaLogoFecha || ahora,
    origen: 'pedido-web', pedidoId: opciones.pedidoId || null, telefono: datos.telefono || '',
    tarjetaTelefono: datos.tarjetaTelefono || '', tarjetaCorreo: datos.tarjetaCorreo || '',
    modalidad: datos.modalidad === 'digital' ? 'digital' : 'fisica',
    retiroPersona: datos.retiroPersona === true,
  });
  return { empresaId, folios, fechaPago, enlaces: folios.map((f) => ({ folio: f, enlace: enlaceDe(empresaId, f) })) };
}

const clavePedido = (id) => `empresas/_pedidos/${id}.json`;
const PEDIDO_ID_RE = /^[a-z0-9]{12,40}$/;

module.exports = {
  BUCKET_RESUMEN, MAX_TARJETAS_POR_PEDIDO, MODALIDADES, PRECIO_RENOVACION, MIN_FICHAS_RENOVACION, precioPorTarjeta, envioEmpresa, ENVIO_EMPRESA_HASTA_100, ENVIO_EMPRESA_MAS_100, calcularTotales, calcularRenovacion, validarPedido, validarContactoTarjeta, crearLoteDePedido,
  enlaceDe, emailValido, clavePedido, PEDIDO_ID_RE,
};
