// ---- Registro de Ingresos: agrega automáticamente cada pago confirmado por ONVO Pay (tarjeta o
// SINPE Móvil) como una fila nueva en un Excel (registro-ingresos.xlsx), guardado en el mismo
// bucket privado que resumen.xlsx (BUCKET_RESUMEN, nunca se expone como URL pública). Lo llama
// onvo-webhook.js cada vez que llega el evento "payment-intent.succeeded". Ver bitácora punto 71
// y el documento del Proyecto ADJDATA sobre el Registro de Ingresos.
//
// Cada fila calcula con FÓRMULAS de Excel (nunca valores fijos, para que se recalculen solas si
// se corrige algún dato) los costos de ONVO, el IVA y las referencias de utilidad/impuesto, según
// los supuestos que confirmó James (2026-09-25/26):
//   - Comisión ONVO: 3% del monto bruto + $0.35 fijo por transacción. El $0.35 se convierte a
//     colones con el tipo de cambio de esa fila cuando el pago fue en CRC.
//   - IVA sobre esa comisión: 0.777% del monto bruto cobrado.
//   - Total costos ONVO: comisión + ese IVA.
//   - Monto neto (valor libre): monto bruto - total costos ONVO.
//   - IVA neto a trasladar a Hacienda: 13% del monto bruto - el IVA que ya cobró ONVO.
//   - Utilidad neta aproximada: monto neto - IVA neto.
//   - Pago de impuesto aproximado: 10% de esa utilidad neta aproximada.
// IMPORTANTE: estas son referencias de estimación para que James lleve control, no un cálculo
// fiscal oficial — así quedó explícitamente anotado en la propia hoja (ver notas al final) y
// conversado con él: debe confirmarlas con su contador antes de usarlas para declarar.
//
// Idempotencia: cada fila guarda el ID del Payment Intent de ONVO en una columna al final
// (COL_PAYMENT_INTENT_ID). Si ONVO reintenta la entrega del mismo webhook (les pasa cuando la
// primera respuesta tarda o falla), no se duplica la fila — se detecta y se omite.

const ExcelJS = require('exceljs');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const HEADER_FILL = 'FF12282B';
const HEADER_FONT = 'FFF9F6EF';
const BORDER = { style: 'thin', color: { argb: 'FFB9B2A0' } };
const FECHA_FORMATO = 'dd/mm/yyyy hh:mm';
const MONEDA_FORMATO = '#,##0.00';

// ---- índices de columna (1-based, como los usa exceljs) ----
const COL_FECHA = 1;
const COL_FOLIO = 2;
const COL_CLIENTE = 3;
const COL_MEDIO = 4;
const COL_MONEDA = 5;
const COL_BRUTO = 6;
const COL_TC = 7;
const COL_COMISION = 8;
const COL_IVA_ONVO = 9;
const COL_TOTAL_COSTOS = 10;
const COL_NETO = 11;
const COL_IVA_NETO = 12;
const COL_UTILIDAD = 13;
const COL_IMPUESTO = 14;
const COL_ESTADO = 15;
const COL_REFERENCIA = 16; // "refNumber" que da ONVO — sirve para conciliar contra el estado de cuenta
const COL_PAYMENT_INTENT_ID = 17; // ID interno de ONVO — solo para detectar duplicados, no pensado para leerse a simple vista

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ---- convierte un índice de columna (1-based) a su letra de Excel (1→A, 27→AA, …) ----
function colALetra(indice1based) {
  let s = '';
  let n = indice1based;
  while (n > 0) {
    const resto = (n - 1) % 26;
    s = String.fromCharCode(65 + resto) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function nuevaHojaConEstilo(workbook) {
  const sheet = workbook.addWorksheet('Registro de Ingresos', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = [
    { header: 'Fecha', key: 'fecha', width: 18 },
    { header: 'Folio / Ficha', key: 'folio', width: 16 },
    { header: 'Cliente', key: 'cliente', width: 24 },
    { header: 'Medio de pago', key: 'medio', width: 16 },
    { header: 'Moneda', key: 'moneda', width: 9 },
    { header: 'Monto bruto cobrado', key: 'bruto', width: 18 },
    { header: 'Tipo de cambio aplicado', key: 'tc', width: 16 },
    { header: 'Comisión ONVO (3% + $0.35)', key: 'comision', width: 20 },
    { header: 'IVA s/comisión (0.777%)', key: 'ivaOnvo', width: 18 },
    { header: 'Total costos ONVO', key: 'totalCostos', width: 16 },
    { header: 'Monto neto (valor libre)', key: 'neto', width: 18 },
    { header: 'IVA neto (13% bruto − IVA ONVO)', key: 'ivaNeto', width: 24 },
    { header: 'Utilidad neta aproximada', key: 'utilidad', width: 20 },
    { header: 'Pago de impuesto aproximado (10%)', key: 'impuesto', width: 24 },
    { header: 'Estado', key: 'estado', width: 13 },
    { header: 'Referencia ONVO', key: 'referencia', width: 16 },
    { header: 'ID de pago (interno)', key: 'paymentIntentId', width: 24 },
  ];
  const headerRow = sheet.getRow(1);
  headerRow.height = 30;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_FONT } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
  });
  return sheet;
}

async function cargarOCrearLibro(s3, bucket, key) {
  const workbook = new ExcelJS.Workbook();
  let sheet;
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const buf = await streamToBuffer(resp.Body);
    await workbook.xlsx.load(buf);
    sheet = workbook.getWorksheet('Registro de Ingresos');
    if (!sheet) sheet = nuevaHojaConEstilo(workbook);
  } catch (err) {
    const noExiste = err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
    if (!noExiste) throw err;
    sheet = nuevaHojaConEstilo(workbook);
  }
  return { workbook, sheet };
}

function yaExisteFila(sheet, paymentIntentId) {
  if (!paymentIntentId) return false;
  let encontrada = false;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // encabezado
    const valor = row.getCell(COL_PAYMENT_INTENT_ID).value;
    if (valor !== null && valor !== undefined && String(valor).trim() === String(paymentIntentId).trim()) {
      encontrada = true;
    }
  });
  return encontrada;
}

// ---- agrega una fila nueva al Registro de Ingresos. Nunca actualiza una fila existente (a
// diferencia de resumen.xlsx): cada pago confirmado es un evento propio, no algo que se "renueve"
// ----
// datos: { paymentIntentId, fecha (Date), folio, cliente, medioPago, moneda ("CRC"/"USD"),
//          montoBruto (número), tipoCambio (número, solo si moneda==CRC), referencia, estado }
// Devuelve { duplicado: true } sin escribir nada si ese paymentIntentId ya tenía una fila.
async function agregarIngreso(s3, bucket, key, datos) {
  const {
    paymentIntentId, fecha, folio, cliente, medioPago, moneda,
    montoBruto, tipoCambio, referencia, estado,
  } = datos;

  const { workbook, sheet } = await cargarOCrearLibro(s3, bucket, key);

  if (yaExisteFila(sheet, paymentIntentId)) {
    return { duplicado: true };
  }

  const rowNumber = Math.max(sheet.rowCount, 1) + 1;
  const row = sheet.getRow(rowNumber);

  row.getCell(COL_FECHA).value = fecha instanceof Date && !isNaN(fecha.getTime()) ? fecha : new Date();
  row.getCell(COL_FECHA).numFmt = FECHA_FORMATO;
  row.getCell(COL_FOLIO).value = folio || '';
  row.getCell(COL_CLIENTE).value = cliente || '';
  row.getCell(COL_MEDIO).value = medioPago || 'Desconocido';
  row.getCell(COL_MONEDA).value = moneda || 'USD';
  row.getCell(COL_BRUTO).value = typeof montoBruto === 'number' ? montoBruto : 0;
  row.getCell(COL_BRUTO).numFmt = MONEDA_FORMATO;

  if (moneda === 'CRC' && typeof tipoCambio === 'number' && tipoCambio > 0) {
    row.getCell(COL_TC).value = tipoCambio;
    row.getCell(COL_TC).numFmt = MONEDA_FORMATO;
  }

  const eLetra = colALetra(COL_MONEDA);
  const fLetra = colALetra(COL_BRUTO);
  const gLetra = colALetra(COL_TC);
  const hLetra = colALetra(COL_COMISION);
  const iLetra = colALetra(COL_IVA_ONVO);
  const jLetra = colALetra(COL_TOTAL_COSTOS);
  const kLetra = colALetra(COL_NETO);
  const lLetra = colALetra(COL_IVA_NETO);
  const mLetra = colALetra(COL_UTILIDAD);

  // H: Comisión ONVO = 3% del bruto + $0.35 (convertido a colones con el tipo de cambio de la
  // fila cuando la moneda es CRC)
  row.getCell(COL_COMISION).value = {
    formula: `${fLetra}${rowNumber}*0.03+IF(${eLetra}${rowNumber}="CRC",0.35*${gLetra}${rowNumber},0.35)`,
  };
  // I: IVA sobre el monto bruto (0.777%)
  row.getCell(COL_IVA_ONVO).value = { formula: `${fLetra}${rowNumber}*0.00777` };
  // J: Total costos ONVO = comisión + IVA
  row.getCell(COL_TOTAL_COSTOS).value = { formula: `${hLetra}${rowNumber}+${iLetra}${rowNumber}` };
  // K: Monto neto = bruto - total costos
  row.getCell(COL_NETO).value = { formula: `${fLetra}${rowNumber}-${jLetra}${rowNumber}` };
  // L: IVA neto = 13% del bruto - IVA de ONVO
  row.getCell(COL_IVA_NETO).value = { formula: `${fLetra}${rowNumber}*0.13-${iLetra}${rowNumber}` };
  // M: Utilidad neta aproximada = Monto neto - IVA neto
  row.getCell(COL_UTILIDAD).value = { formula: `${kLetra}${rowNumber}-${lLetra}${rowNumber}` };
  // N: Pago de impuesto aproximado = 10% de la utilidad neta aproximada
  row.getCell(COL_IMPUESTO).value = { formula: `${mLetra}${rowNumber}*0.10` };

  [COL_COMISION, COL_IVA_ONVO, COL_TOTAL_COSTOS, COL_NETO, COL_IVA_NETO, COL_UTILIDAD, COL_IMPUESTO].forEach((col) => {
    row.getCell(col).numFmt = MONEDA_FORMATO;
  });

  row.getCell(COL_ESTADO).value = estado || 'Confirmado';
  row.getCell(COL_REFERENCIA).value = referencia || '';
  row.getCell(COL_PAYMENT_INTENT_ID).value = paymentIntentId || '';

  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  row.getCell(COL_CLIENTE).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };

  row.commit();

  const buffer = await workbook.xlsx.writeBuffer();
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));

  return { duplicado: false, rowNumber };
}

module.exports = { agregarIngreso };
