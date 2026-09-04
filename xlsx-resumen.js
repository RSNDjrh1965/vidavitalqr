// ---- Mantiene el "cuadro resumen" como un archivo Excel (.xlsx) real en S3 ----
// Reemplaza al antiguo resumen.csv: usa exceljs para poder darle formato de verdad
// (encabezados con color, columnas con ancho fijo, bordes en cada celda) y para poder
// incrustar la fotografía directamente dentro de la celda correspondiente.
//
// Comportamiento:
//  - Si el archivo resumen.xlsx no existe todavía en el bucket, lo crea con el
//    encabezado y el formato ya aplicado.
//  - Si el "Contador" (folio) de la ficha que se está subiendo YA existe en una fila
//    anterior (esto pasa cuando el cliente renueva/actualiza su ficha), esa fila se
//    ACTUALIZA en su lugar en vez de crear una fila duplicada.
//  - Si no existe todavía, se agrega como una fila nueva al final.

const ExcelJS = require('exceljs');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const HEADER_FILL = 'FF12282B';
const HEADER_FONT = 'FFF9F6EF';
const BORDER = { style: 'thin', color: { argb: 'FFB9B2A0' } };

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function nuevaHojaConEstilo(workbook) {
  const sheet = workbook.addWorksheet('Resumen', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = [
    { header: 'Contador', key: 'contador', width: 20 },
    { header: 'Nombre completo', key: 'nombre', width: 30 },
    { header: 'Fecha de inicio', key: 'fecha', width: 16 },
    { header: 'URL del objeto (PDF)', key: 'pdf', width: 46 },
    { header: 'Fotografía', key: 'foto', width: 16 },
    { header: 'Código QR', key: 'qr', width: 46 },
  ];
  const headerRow = sheet.getRow(1);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_FONT } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
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
    sheet = workbook.getWorksheet('Resumen');
    if (!sheet) sheet = nuevaHojaConEstilo(workbook);
  } catch (err) {
    const noExiste = err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
    if (!noExiste) throw err;
    sheet = nuevaHojaConEstilo(workbook);
  }
  return { workbook, sheet };
}

function buscarFilaPorContador(sheet, contador) {
  let filaEncontrada = null;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // encabezado
    const valor = row.getCell(1).value;
    if (valor !== null && valor !== undefined && String(valor).trim() === String(contador).trim()) {
      filaEncontrada = rowNumber;
    }
  });
  return filaEncontrada;
}

// ---- convierte un data-URL (data:image/jpeg;base64,....) en {buffer, extension} para exceljs ----
function imagenDesdeDataUrl(dataUrl) {
  const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  let extension = m[1].toLowerCase();
  if (extension === 'jpg') extension = 'jpeg';
  if (!['jpeg', 'png', 'gif'].includes(extension)) extension = 'jpeg';
  return { buffer: Buffer.from(m[2], 'base64'), extension };
}

async function actualizarResumenXlsx(s3, bucket, key, fila) {
  const { contador, nombre, fecha, pdfUrl, fotoBase64, qrUrl } = fila;
  const { workbook, sheet } = await cargarOCrearLibro(s3, bucket, key);

  let rowNumber = buscarFilaPorContador(sheet, contador);
  const esNueva = !rowNumber;
  if (esNueva) {
    rowNumber = Math.max(sheet.rowCount, 1) + 1;
  }

  const row = sheet.getRow(rowNumber);
  row.height = 60;
  row.getCell(1).value = contador || '';
  row.getCell(2).value = nombre || '';
  row.getCell(3).value = fecha || '';
  row.getCell(4).value = pdfUrl ? { text: 'Ver PDF', hyperlink: pdfUrl } : '';
  row.getCell(6).value = qrUrl ? { text: 'Ver código QR', hyperlink: qrUrl } : '';

  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });
  [4, 6].forEach((col) => {
    const cell = row.getCell(col);
    if (cell.value) cell.font = { color: { argb: 'FF1155CC' }, underline: true };
  });

  // Si esta fila ya tenía una foto incrustada (caso típico de una renovación que vuelve a
  // usar el mismo Contador), hay que quitarla antes de poner la nueva — si no, quedarían
  // dos fotos superpuestas en la misma celda.
  if (typeof sheet._media !== 'undefined') {
    sheet._media = sheet._media.filter((m) => !(m.type === 'image' && m.range && m.range.tl && m.range.tl.col === 4 && Math.floor(m.range.tl.row) === rowNumber - 1));
  }

  const imagen = imagenDesdeDataUrl(fotoBase64);
  if (imagen) {
    const imageId = workbook.addImage({ buffer: imagen.buffer, extension: imagen.extension });
    sheet.addImage(imageId, {
      tl: { col: 4, row: rowNumber - 1 + 0.05 },
      ext: { width: 74, height: 74 },
      editAs: 'oneCell',
    });
    row.getCell(5).value = '';
  } else {
    row.getCell(5).value = 'Sin foto';
    row.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' };
  }

  row.commit();

  const buffer = await workbook.xlsx.writeBuffer();
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));
}

module.exports = { actualizarResumenXlsx };
