// ---- lib/vigencia.js ----
// Reglas de vigencia anual de cada ficha (persona, mascota u objeto) — punto de la bitácora sobre
// "vencimiento automático de fichas" (2026-09-25). Se agrupan aquí para que las use por igual:
//  - send-ficha.js         (al guardar/renovar, para calcular y guardar la fecha de vencimiento)
//  - lib/xlsx-resumen.js   (para las columnas "Estado" y "Fecha de vencimiento" del cuadro resumen)
//  - ver.js                (para decidir qué se muestra/oculta al escanear el código QR)
//  - revisar-vigencia.js   (función programada diaria que envía los avisos y elimina lo vencido)
//
// Reglas (aprobadas por James, 2026-09-25 — ver el documento "Política de vigencia y eliminación
// de fichas" del Proyecto ADJDATA):
//  - Cada ficha es válida por 12 meses desde su fecha "creado" (que se reinicia solo cuando se
//    paga una renovación real — ver send-ficha.js).
//  - Al vencer, pasa a "vencida": sigue por 2 meses más mostrando la información esencial de
//    emergencia (nunca se bloquea del todo por falta de pago).
//  - Pasados esos 2 meses de gracia sin renovar, la ficha se considera "eliminada": se borra por
//    completo de S3 (PDF, foto, tarjeta, código QR y los datos guardados).

const MS_POR_DIA = 24 * 60 * 60 * 1000;

// ---- suma "meses" meses de calendario a una fecha, respetando el día del mes cuando el mes de
// destino lo permite (y ajustando al último día del mes de destino si no lo permite, ej. 31 de
// enero + 1 mes = 28/29 de febrero, no 3 de marzo) ----
function sumarMeses(fecha, meses) {
  const d = new Date(fecha.getTime());
  const dia = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + meses);
  const ultimoDiaMesDestino = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(dia, ultimoDiaMesDestino));
  return d;
}

// ---- fecha de vencimiento (12 meses después de "creado") — null si "creadoIso" no es una fecha
// válida (fichas muy antiguas guardadas antes de que existiera este campo) ----
function fechaVencimiento(creadoIso) {
  if (!creadoIso) return null;
  const creado = new Date(creadoIso);
  if (isNaN(creado.getTime())) return null;
  return sumarMeses(creado, 12);
}

// ---- fin del período de gracia (2 meses después del vencimiento) ----
function finGracia(creadoIso) {
  const venc = fechaVencimiento(creadoIso);
  if (!venc) return null;
  return sumarMeses(venc, 2);
}

// ---- estado actual de la ficha: 'vigente' | 'vencida' | 'eliminada' ----
// Si no se puede determinar la fecha de vencimiento (ficha sin campo "creado" válido, de antes de
// este cambio), se trata como "vigente" — nunca se oculta ni se elimina información por un dato
// faltante que la propia ficha nunca llegó a tener.
function calcularEstado(creadoIso, ahora) {
  ahora = ahora instanceof Date ? ahora : new Date();
  const venc = fechaVencimiento(creadoIso);
  if (!venc) return 'vigente';
  if (ahora < venc) return 'vigente';
  const gracia = finGracia(creadoIso);
  if (!gracia || ahora < gracia) return 'vencida';
  return 'eliminada';
}

function diasEntre(desde, hasta) {
  return Math.floor((hasta.getTime() - desde.getTime()) / MS_POR_DIA);
}

module.exports = { sumarMeses, fechaVencimiento, finGracia, calcularEstado, diasEntre, MS_POR_DIA };
