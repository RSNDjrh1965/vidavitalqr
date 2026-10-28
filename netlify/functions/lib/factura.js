// ---- lib/factura.js (2026-10-28) ----
// Datos para la FACTURA ELECTRÓNICA que James emite en Hacienda (Costa Rica). Cualquier cliente (persona o empresa) puede
// solicitarla; el sitio solo recoge los datos y los pasa a los avisos de pago de James (el sitio NO emite la factura).
// Campos: cédula (física o jurídica), nombre o razón social, correo para el envío de la factura, teléfono y
// código de actividad económica (el de la actividad que registra el cliente ante Hacienda, 4 a 7 dígitos).
// Todo es texto libre del navegador: se valida y se limpia aquí, nunca se arma una ruta ni un monto con él.
function limpio(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function emailOk(v) { return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(v); }

// Devuelve { factura } si es válida o { error } con un mensaje para el cliente.
function validarFactura(f) {
  if (!f || typeof f !== 'object') return { error: 'Faltan los datos para la factura electrónica.' };
  const cedula = limpio(f.cedula, 30).replace(/[\s-]/g, '');
  const nombre = limpio(f.nombre, 100);
  const correo = limpio(f.correo, 80);
  const telefono = limpio(f.telefono, 25);
  const actividad = limpio(f.actividad, 12).replace(/[\s.-]/g, '');
  if (!/^\d{9,12}$/.test(cedula)) return { error: 'La cédula para la factura no es válida (solo números, de 9 a 12 dígitos).' };
  if (nombre.length < 3) return { error: 'Escriba el nombre o la razón social para la factura.' };
  if (!emailOk(correo)) return { error: 'El correo para enviar la factura no es válido.' };
  if (telefono.replace(/\D/g, '').length < 8) return { error: 'El teléfono para la factura no es válido.' };
  if (!/^\d{4,7}$/.test(actividad)) return { error: 'El código de actividad económica debe tener de 4 a 7 números.' };
  return { factura: { cedula, nombre, correo, telefono, actividad } };
}

// ¿el navegador marcó que quiere factura? (para compras de personas es opcional)
function pideFactura(p) { return !!p && (p.facturaSolicitada === true || p.facturaSolicitada === 'si'); }

// Recupera la factura de la metadata de ONVO (solo la escribe crear-pago.js ya validada). Devuelve null si no hay o no es válida.
function facturaDeMetadata(texto) {
  if (!texto) return null;
  try { const r = validarFactura(JSON.parse(String(texto))); return r.factura || null; } catch (e) { return null; }
}

function lineasFactura(f) {
  if (!f) return [];
  return [
    'FACTURA ELECTRÓNICA SOLICITADA — datos para emitirla:',
    `  Cédula: ${f.cedula}`,
    `  Nombre o razón social: ${f.nombre}`,
    `  Correo para enviar la factura: ${f.correo}`,
    `  Teléfono: ${f.telefono}`,
    `  Código de actividad económica: ${f.actividad}`,
  ];
}

module.exports = { validarFactura, pideFactura, facturaDeMetadata, lineasFactura };
