// ---- Mantiene el "cuadro resumen" como un archivo Excel (.xlsx) real en S3 ----
// Reemplaza al antiguo resumen.csv: usa exceljs para poder darle formato de verdad
// (encabezados con color, columnas con ancho fijo, bordes en cada celda) y para poder
// incrustar la fotografía directamente dentro de la celda correspondiente.
//
// Columnas (en este orden):
//  1) Actualización          — contador de cuántas veces se ha guardado esta ficha (1, 2, 3…)
//  2) Contador                — folio/código de la ficha
//  3) PIN                     — el PIN de acceso vigente de esa ficha, en texto plano. Se
//                               guarda aquí (además de su hash en login/<folio>.json) para que
//                               se pueda recuperar manualmente si el usuario pierde su PIN y
//                               escribe pidiendo ayuda (por ejemplo, por el botón de WhatsApp).
//  4) Nombre completo
//  5) Fecha de inicio         — fecha de la primera vez que se guardó la ficha
//  6) Fecha de actualización  — fecha del guardado más reciente (la renovación reinicia el conteo)
//  7) Meses transcurridos     — fórmula de Excel: meses completos desde "Fecha de actualización"
//                               hasta hoy — se recalcula solo cada vez que se abre el archivo,
//                               así siempre queda claro cuándo se vence la renovación (1 año).
//  8) URL del objeto (PDF)
//  9) Fotografía
// 10) Código QR
//
// Comportamiento:
//  - Si el archivo resumen.xlsx no existe todavía en el bucket, lo crea con el
//    encabezado y el formato ya aplicado.
//  - Si el "Contador" (folio) de la ficha que se está subiendo YA existe en una fila
//    anterior (esto pasa cuando el cliente renueva/actualiza su ficha), esa fila se
//    ACTUALIZA en su lugar en vez de crear una fila duplicada, y "Actualización" sube
//    en 1 respecto al valor que ya tenía.
//  - Si no existe todavía, se agrega como una fila nueva al final, con Actualización = 1.

const ExcelJS = require('exceljs');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const HEADER_FILL = 'FF12282B';
const HEADER_FONT = 'FFF9F6EF';
const BORDER = { style: 'thin', color: { argb: 'FFB9B2A0' } };
const FECHA_FORMATO = 'dd/mm/yyyy';

// ---- índices de columna (1-based, como los usa exceljs) ----
const COL_ACTUALIZACION = 1;
const COL_CONTADOR = 2;
const COL_PIN = 3;
const COL_NOMBRE = 4;
const COL_FECHA_INICIO = 5;
const COL_FECHA_ACTUALIZACION = 6;
const COL_MESES = 7;
const COL_PDF = 8;
const COL_FOTO = 9;
const COL_QR = 10;

const FOTO_ANCHO_PX = 74;
const FOTO_ALTO_PX = 74;
const FOTO_COL_WIDTH = 16; // en "caracteres" (unidad de ancho de columna de Excel)
const FILA_ALTO_PT = 60;

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
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
  const sheet = workbook.addWorksheet('Resumen', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = [
    { header: 'Actualización', key: 'actualizacion', width: 14 },
    { header: 'Contador', key: 'contador', width: 20 },
    { header: 'PIN', key: 'pin', width: 12 },
    { header: 'Nombre completo', key: 'nombre', width: 28 },
    { header: 'Fecha de inicio', key: 'fecha', width: 15 },
    { header: 'Fecha de actualización', key: 'fechaActualizacion', width: 18 },
    { header: 'Meses transcurridos', key: 'meses', width: 16 },
    { header: 'URL del objeto (PDF)', key: 'pdf', width: 14 },
    { header: 'Fotografía', key: 'foto', width: FOTO_COL_WIDTH },
    { header: 'Código QR', key: 'qr', width: 16 },
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

// ---- intenta recuperar el PIN en texto plano guardado en login/<folio>.json, para poder ----
// ---- rellenar la columna "PIN" al migrar filas que no la tenían todavía ----
async function buscarPinDesdeLogin(s3, bucket, folio) {
  if (!folio) return '';
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `login/${String(folio).trim()}.json` }));
    const texto = await streamToString(resp.Body);
    const registro = JSON.parse(texto);
    return registro && registro.pin ? String(registro.pin) : '';
  } catch (err) {
    return ''; // no existe login guardado para ese folio, o no se pudo leer — se deja en blanco
  }
}

// ---- migración del esquema antiguo (6 columnas) al esquema con "PIN" (10 columnas) ----
// El archivo resumen.xlsx pudo haberse creado ANTES de que existieran las columnas
// "Actualización", "Fecha de actualización", "Meses transcurridos" y "PIN". Esa hoja antigua
// tiene como encabezados, en orden: Contador | Nombre completo | Fecha de inicio |
// URL del objeto (PDF) | Fotografía | Código QR.
// Si se detecta ese encabezado, se reconstruye la hoja completa con el formato nuevo,
// trasladando cada fila existente (datos, enlaces y fotografías incrustadas) antes de
// continuar con el guardado que disparó esta actualización. El PIN se intenta recuperar desde
// login/<folio>.json; si no existe (fichas muy antiguas, de antes del sistema de PIN), queda en
// blanco hasta que esa ficha se vuelva a guardar.

function esEsquemaAntiguo(sheet) {
  const encabezado1 = sheet.getRow(1).getCell(1).value;
  return String(encabezado1 || '').trim() === 'Contador';
}

// ---- esquema intermedio (9 columnas, sin "PIN") — el que existía justo antes de agregar esta
// columna. Se distingue del esquema más nuevo porque la tercera columna es "Nombre completo" en
// vez de "PIN".
function esEsquemaSinPin(sheet) {
  if (esEsquemaAntiguo(sheet)) return false;
  const encabezado3 = sheet.getRow(1).getCell(3).value;
  return String(encabezado3 || '').trim() !== 'PIN';
}

function parseFechaLegacy(valor) {
  if (valor instanceof Date) return valor;
  if (typeof valor === 'string') {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(valor.trim());
    if (m) {
      const d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
      return new Date(y, mo - 1, d, 12, 0, 0);
    }
  }
  return new Date();
}

function extraerHyperlink(valor) {
  if (!valor) return '';
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'object' && valor.hyperlink) return valor.hyperlink;
  if (typeof valor === 'object' && valor.text) return valor.text;
  return '';
}

function estilizarFilaMigrada(row, rowNumber, { pdfUrl, qrUrl }) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });
  [COL_ACTUALIZACION, COL_PIN, COL_FECHA_INICIO, COL_FECHA_ACTUALIZACION, COL_MESES].forEach((col) => {
    row.getCell(col).alignment = { vertical: 'middle', horizontal: 'center' };
  });
  [COL_PDF, COL_QR].forEach((col) => {
    const cell = row.getCell(col);
    if (cell.value) cell.font = { color: { argb: 'FF1155CC' }, underline: true };
  });
}

function colocarFoto(sheetNueva, rowNumber, imageId) {
  const colFotoIdx0 = COL_FOTO - 1;
  if (imageId !== undefined) {
    const { offX, offY } = offsetParaCentrar(FOTO_COL_WIDTH, FILA_ALTO_PT, FOTO_ANCHO_PX, FOTO_ALTO_PX);
    sheetNueva.addImage(imageId, {
      tl: { col: colFotoIdx0 + offX, row: rowNumber - 1 + offY },
      ext: { width: FOTO_ANCHO_PX, height: FOTO_ALTO_PX },
      editAs: 'oneCell',
    });
    sheetNueva.getRow(rowNumber).getCell(COL_FOTO).value = '';
  } else {
    sheetNueva.getRow(rowNumber).getCell(COL_FOTO).value = 'Sin foto';
    sheetNueva.getRow(rowNumber).getCell(COL_FOTO).alignment = { vertical: 'middle', horizontal: 'center' };
  }
}

async function migrarEsquemaAntiguo(workbook, sheetAntigua, s3, bucket) {
  // Esquema antiguo (1-based): 1 Contador, 2 Nombre completo, 3 Fecha de inicio,
  // 4 URL del objeto (PDF), 5 Fotografía, 6 Código QR.
  const filasLegacy = [];
  sheetAntigua.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // encabezado
    const contador = row.getCell(1).value;
    if (contador === null || contador === undefined || String(contador).trim() === '') return;
    filasLegacy.push({
      rowNumber,
      contador,
      nombre: row.getCell(2).value,
      fecha: row.getCell(3).value,
      pdfUrl: extraerHyperlink(row.getCell(4).value),
      qrUrl: extraerHyperlink(row.getCell(6).value),
    });
  });

  // capturar qué imagen (por su imageId dentro del workbook) va con cada fila, ANTES de
  // quitar la hoja antigua
  const imagenesPorFila = {};
  if (typeof sheetAntigua.getImages === 'function') {
    sheetAntigua.getImages().forEach((img) => {
      const filaAsociada = Math.round(img.range.tl.row) + 1;
      imagenesPorFila[filaAsociada] = img.imageId;
    });
  }

  workbook.removeWorksheet(sheetAntigua.id);
  const sheetNueva = nuevaHojaConEstilo(workbook);

  for (const legacy of filasLegacy) {
    const rowNumber = sheetNueva.rowCount + 1;
    const fechaInicio = parseFechaLegacy(legacy.fecha);
    const pin = await buscarPinDesdeLogin(s3, bucket, legacy.contador);
    const row = sheetNueva.getRow(rowNumber);
    row.height = FILA_ALTO_PT;
    row.getCell(COL_ACTUALIZACION).value = 1;
    row.getCell(COL_CONTADOR).value = legacy.contador || '';
    row.getCell(COL_PIN).value = pin;
    row.getCell(COL_NOMBRE).value = legacy.nombre || '';
    row.getCell(COL_FECHA_INICIO).value = fechaInicio;
    row.getCell(COL_FECHA_INICIO).numFmt = FECHA_FORMATO;
    row.getCell(COL_FECHA_ACTUALIZACION).value = fechaInicio;
    row.getCell(COL_FECHA_ACTUALIZACION).numFmt = FECHA_FORMATO;
    const celdaFechaActualizacion = `${colALetra(COL_FECHA_ACTUALIZACION)}${rowNumber}`;
    row.getCell(COL_MESES).value = { formula: `IFERROR(DATEDIF(${celdaFechaActualizacion},TODAY(),"m"),"")` };
    row.getCell(COL_PDF).value = legacy.pdfUrl ? { text: 'Ver PDF', hyperlink: legacy.pdfUrl } : '';
    row.getCell(COL_QR).value = legacy.qrUrl ? { text: 'Ver código QR', hyperlink: legacy.qrUrl } : '';

    estilizarFilaMigrada(row, rowNumber, legacy);
    colocarFoto(sheetNueva, rowNumber, imagenesPorFila[legacy.rowNumber]);
    row.commit();
  }

  return sheetNueva;
}

// ---- migración del esquema intermedio (9 columnas, sin "PIN") al esquema actual (10 columnas) ----
// Traslada cada fila (y sus fotos) una columna a la derecha a partir de "Nombre completo", y
// rellena la nueva columna "PIN" buscando el PIN en texto plano guardado en login/<folio>.json.
async function migrarAgregarColumnaPin(workbook, sheetVieja, s3, bucket) {
  // Esquema viejo (1-based, sin PIN): 1 Actualización, 2 Contador, 3 Nombre completo,
  // 4 Fecha de inicio, 5 Fecha de actualización, 6 Meses transcurridos, 7 PDF, 8 Foto, 9 QR.
  const filasViejas = [];
  sheetVieja.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // encabezado
    const contador = row.getCell(2).value;
    if (contador === null || contador === undefined || String(contador).trim() === '') return;
    filasViejas.push({
      rowNumber,
      actualizacion: row.getCell(1).value,
      contador,
      nombre: row.getCell(3).value,
      fechaInicio: row.getCell(4).value,
      fechaActualizacion: row.getCell(5).value,
      pdfUrl: extraerHyperlink(row.getCell(7).value),
      qrUrl: extraerHyperlink(row.getCell(9).value),
    });
  });

  const imagenesPorFila = {};
  if (typeof sheetVieja.getImages === 'function') {
    sheetVieja.getImages().forEach((img) => {
      const filaAsociada = Math.round(img.range.tl.row) + 1;
      imagenesPorFila[filaAsociada] = img.imageId;
    });
  }

  workbook.removeWorksheet(sheetVieja.id);
  const sheetNueva = nuevaHojaConEstilo(workbook);

  for (const vieja of filasViejas) {
    const rowNumber = sheetNueva.rowCount + 1;
    const pin = await buscarPinDesdeLogin(s3, bucket, vieja.contador);
    const row = sheetNueva.getRow(rowNumber);
    row.height = FILA_ALTO_PT;
    row.getCell(COL_ACTUALIZACION).value = vieja.actualizacion || 1;
    row.getCell(COL_CONTADOR).value = vieja.contador || '';
    row.getCell(COL_PIN).value = pin;
    row.getCell(COL_NOMBRE).value = vieja.nombre || '';
    row.getCell(COL_FECHA_INICIO).value = vieja.fechaInicio || new Date();
    row.getCell(COL_FECHA_INICIO).numFmt = FECHA_FORMATO;
    row.getCell(COL_FECHA_ACTUALIZACION).value = vieja.fechaActualizacion || new Date();
    row.getCell(COL_FECHA_ACTUALIZACION).numFmt = FECHA_FORMATO;
    const celdaFechaActualizacion = `${colALetra(COL_FECHA_ACTUALIZACION)}${rowNumber}`;
    row.getCell(COL_MESES).value = { formula: `IFERROR(DATEDIF(${celdaFechaActualizacion},TODAY(),"m"),"")` };
    row.getCell(COL_PDF).value = vieja.pdfUrl ? { text: 'Ver PDF', hyperlink: vieja.pdfUrl } : '';
    row.getCell(COL_QR).value = vieja.qrUrl ? { text: 'Ver código QR', hyperlink: vieja.qrUrl } : '';

    estilizarFilaMigrada(row, rowNumber, vieja);
    colocarFoto(sheetNueva, rowNumber, imagenesPorFila[vieja.rowNumber]);
    row.commit();
  }

  return sheetNueva;
}

async function cargarOCrearLibro(s3, bucket, key) {
  const workbook = new ExcelJS.Workbook();
  let sheet;
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const buf = await streamToBuffer(resp.Body);
    await workbook.xlsx.load(buf);
    sheet = workbook.getWorksheet('Resumen');
    if (!sheet) {
      sheet = nuevaHojaConEstilo(workbook);
    } else if (esEsquemaAntiguo(sheet)) {
      sheet = await migrarEsquemaAntiguo(workbook, sheet, s3, bucket);
    } else if (esEsquemaSinPin(sheet)) {
      sheet = await migrarAgregarColumnaPin(workbook, sheet, s3, bucket);
    }
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
    const valor = row.getCell(COL_CONTADOR).value;
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

// ---- fracción de desplazamiento para centrar la fotografía dentro de su celda ----
// exceljs posiciona la imagen con "tl.col"/"tl.row" como número de columna/fila con una
// parte decimal que representa qué tan adentro de esa celda empieza la imagen (0 = borde
// izquierdo/superior). Se estima el ancho/alto de la celda en píxeles a partir del ancho de
// columna (en "caracteres") y del alto de fila (en puntos) para centrar la imagen fija de
// 74x74 px dentro de ella. La conversión es aproximada (Excel no expone el tamaño real en
// píxeles), pero deja la foto centrada de forma consistente en Excel/Google Sheets/LibreOffice.
function offsetParaCentrar(colWidthChars, rowHeightPt, imgWidthPx, imgHeightPx) {
  const colWidthPx = Math.round(colWidthChars * 7 + 5);
  const rowHeightPx = Math.round(rowHeightPt * (96 / 72));
  const offX = Math.max(0, (colWidthPx - imgWidthPx) / 2 / colWidthPx);
  const offY = Math.max(0, (rowHeightPx - imgHeightPx) / 2 / rowHeightPx);
  return { offX, offY };
}

async function actualizarResumenXlsx(s3, bucket, key, fila) {
  const { contador, pin, nombre, fecha, pdfUrl, fotoBase64, qrUrl } = fila;
  const { workbook, sheet } = await cargarOCrearLibro(s3, bucket, key);

  let rowNumber = buscarFilaPorContador(sheet, contador);
  const esNueva = !rowNumber;

  // "fecha" llega como un objeto Date real (ver fechaInicioHoy() en send-ficha.js) para que
  // Excel lo trate como fecha de verdad y la columna de "Meses transcurridos" pueda calcularse
  // con una fórmula en vez de quedar congelada en el valor que tenía al momento de guardar.
  const fechaActualizacion = fecha instanceof Date ? fecha : new Date();

  // ---- número de actualización: 1 en la primera vez; +1 sobre el valor anterior en cada renovación ----
  let numeroActualizacion = 1;
  let fechaInicioFinal = fechaActualizacion;
  if (!esNueva) {
    const filaExistente = sheet.getRow(rowNumber);
    const valorPrevio = parseInt(filaExistente.getCell(COL_ACTUALIZACION).value, 10);
    numeroActualizacion = Number.isFinite(valorPrevio) && valorPrevio > 0 ? valorPrevio + 1 : 2;
    // la fecha de inicio no cambia en una renovación — se conserva la que ya tenía la fila
    const fechaInicioPrevia = filaExistente.getCell(COL_FECHA_INICIO).value;
    if (fechaInicioPrevia) fechaInicioFinal = fechaInicioPrevia;
  }
  if (esNueva) {
    rowNumber = Math.max(sheet.rowCount, 1) + 1;
  }

  const row = sheet.getRow(rowNumber);
  row.height = FILA_ALTO_PT;
  row.getCell(COL_ACTUALIZACION).value = numeroActualizacion;
  row.getCell(COL_CONTADOR).value = contador || '';
  row.getCell(COL_PIN).value = pin || '';
  row.getCell(COL_NOMBRE).value = nombre || '';
  row.getCell(COL_FECHA_INICIO).value = fechaInicioFinal;
  row.getCell(COL_FECHA_INICIO).numFmt = FECHA_FORMATO;
  row.getCell(COL_FECHA_ACTUALIZACION).value = fechaActualizacion;
  row.getCell(COL_FECHA_ACTUALIZACION).numFmt = FECHA_FORMATO;
  // meses completos transcurridos desde la última actualización hasta hoy (se recalcula cada
  // vez que se abre el archivo — así siempre refleja cuánto falta para el año de vigencia)
  const celdaFechaActualizacion = `${colALetra(COL_FECHA_ACTUALIZACION)}${rowNumber}`;
  row.getCell(COL_MESES).value = { formula: `IFERROR(DATEDIF(${celdaFechaActualizacion},TODAY(),"m"),"")` };
  row.getCell(COL_PDF).value = pdfUrl ? { text: 'Ver PDF', hyperlink: pdfUrl } : '';
  row.getCell(COL_QR).value = qrUrl ? { text: 'Ver código QR', hyperlink: qrUrl } : '';

  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });
  [COL_ACTUALIZACION, COL_PIN, COL_FECHA_INICIO, COL_FECHA_ACTUALIZACION, COL_MESES].forEach((col) => {
    row.getCell(col).alignment = { vertical: 'middle', horizontal: 'center' };
  });
  [COL_PDF, COL_QR].forEach((col) => {
    const cell = row.getCell(col);
    if (cell.value) cell.font = { color: { argb: 'FF1155CC' }, underline: true };
  });

  // Si esta fila ya tenía una foto incrustada (caso típico de una renovación que vuelve a
  // usar el mismo Contador), hay que quitarla antes de poner la nueva — si no, quedarían
  // dos fotos superpuestas en la misma celda.
  const colFotoIdx0 = COL_FOTO - 1; // exceljs guarda el "range" de la imagen con columna 0-based
  if (typeof sheet._media !== 'undefined') {
    sheet._media = sheet._media.filter((m) => !(m.type === 'image' && m.range && m.range.tl && Math.floor(m.range.tl.col) === colFotoIdx0 && Math.floor(m.range.tl.row) === rowNumber - 1));
  }

  const imagen = imagenDesdeDataUrl(fotoBase64);
  if (imagen) {
    const imageId = workbook.addImage({ buffer: imagen.buffer, extension: imagen.extension });
    const { offX, offY } = offsetParaCentrar(FOTO_COL_WIDTH, FILA_ALTO_PT, FOTO_ANCHO_PX, FOTO_ALTO_PX);
    sheet.addImage(imageId, {
      tl: { col: colFotoIdx0 + offX, row: rowNumber - 1 + offY },
      ext: { width: FOTO_ANCHO_PX, height: FOTO_ALTO_PX },
      editAs: 'oneCell',
    });
    row.getCell(COL_FOTO).value = '';
  } else {
    row.getCell(COL_FOTO).value = 'Sin foto';
    row.getCell(COL_FOTO).alignment = { vertical: 'middle', horizontal: 'center' };
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
