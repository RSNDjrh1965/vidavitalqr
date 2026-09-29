// ---- Genera un código QR como SVG (sin dependencias nativas tipo canvas/sharp) ----
// - Codifica una URL en el QR (nivel de corrección de errores alto, para poder tapar el centro).
// - Dibuja "VIDAVITALQR" centrado y legible dentro del propio QR.
// - Debajo del QR (fuera del área escaneable) dibuja el folio/contador de la ficha.
const QRCode = require('qrcode');
const opentype = require('opentype.js');
const path = require('path');

// ---- Fuente para convertir el texto "VIDAVITALQR" en trazado vectorial (<path>) en vez de
// <text> — necesario porque el software del láser (LaserGRBL) usado para grabar las placas no
// interpreta elementos <text> de SVG, solo formas vectoriales. Se usa la misma técnica que se
// verificó manualmente (2026-09-28): convertir el texto a un dibujo de líneas/curvas real. ----
let _fontCache = null;
function getFont() {
  if (!_fontCache) {
    const fs = require('fs');
    const buf = fs.readFileSync(path.join(__dirname, 'fonts', 'LiberationSans-Bold.ttf'));
    _fontCache = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  return _fontCache;
}

// Devuelve { d, path } de un <path> SVG con el texto centrado en (cx, cy), estirado
// horizontalmente para ocupar exactamente targetWidth (misma idea que el textLength/
// lengthAdjust que usaba el <text> original).
function textoComoPath(text, cx, cy, fontSize, targetWidth) {
  const font = getFont();
  const opts = { kerning: false, features: { liga: false, rlig: false } };
  const unitsPerEm = font.unitsPerEm;
  const advanceWidth = font.getAdvanceWidth(text, fontSize, opts);
  const ascender = font.ascender * (fontSize / unitsPerEm);
  const descender = font.descender * (fontSize / unitsPerEm); // negativo
  const x = cx - advanceWidth / 2;
  const y = cy + (ascender + descender) / 2; // aproximación de dominant-baseline="central"
  const p = font.getPath(text, x, y, fontSize, opts);
  const d = p.toPathData(2);
  const scaleX = targetWidth && advanceWidth ? targetWidth / advanceWidth : 1;
  return `<g transform="translate(${cx} 0) scale(${scaleX.toFixed(4)} 1) translate(${-cx} 0)"><path d="${d}" fill="#12282B"/></g>`;
}

// ---- Tamaño de QR (en mm) recomendado para cada estilo de placa física, calculado a partir de
// las medidas reales de cada placa del catálogo del usuario (ver bitácora, punto de 2026-09-28) ----
const MEDIDA_QR_MM_POR_PLACA = {
  clasica: 18, // Placa 1, 40 x 20 mm
  llavero: 20, // Placa 2, 40 x 22 mm
  ranuras: 22, // Placa 3, 45 x 25 mm
  dije: 30, // Placa 4, 40 x 40 mm
  pulsera: 16, // Pulsera con placa QR, área grabable 16 x 16 mm (2026-09-29, dato del usuario)
};

async function buildQrSvg(targetUrl, folioText) {
  const qr = QRCode.create(targetUrl, { errorCorrectionLevel: 'H' });
  const modules = qr.modules;
  const size = modules.size; // número de módulos por lado
  const moduleSize = 10; // px por módulo
  const quietZone = 4; // módulos de margen blanco alrededor del QR
  const qrPixelSize = (size + quietZone * 2) * moduleSize;
  const captionHeight = 70; // espacio para el texto del folio debajo del QR
  const totalWidth = qrPixelSize;
  const totalHeight = qrPixelSize + captionHeight;

  let modulesSvg = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules.get(row, col)) {
        const x = (col + quietZone) * moduleSize;
        const y = (row + quietZone) * moduleSize;
        modulesSvg += `<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}" fill="#12282B"/>`;
      }
    }
  }

  // Bloque blanco central para el texto "VIDAVITALQR" (nivel H tolera hasta ~30% de obstrucción;
  // este bloque cubre bastante menos que eso).
  const labelBoxWidthModules = Math.round(size * 0.72);
  const labelBoxHeightModules = Math.round(size * 0.16);
  const labelBoxWidth = labelBoxWidthModules * moduleSize;
  const labelBoxHeight = labelBoxHeightModules * moduleSize;
  const labelBoxX = (qrPixelSize - labelBoxWidth) / 2;
  const labelBoxY = (qrPixelSize - labelBoxHeight) / 2;
  const labelFontSize = Math.round(labelBoxHeight * 0.48);

  const centerLabel = `
    <rect x="${labelBoxX}" y="${labelBoxY}" width="${labelBoxWidth}" height="${labelBoxHeight}" rx="6" fill="#F9F6EF" stroke="#12282B" stroke-width="2"/>
    <text x="${qrPixelSize / 2}" y="${labelBoxY + labelBoxHeight / 2}" text-anchor="middle" dominant-baseline="central"
      font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${labelFontSize}" fill="#12282B" textLength="${labelBoxWidth - 24}" lengthAdjust="spacingAndGlyphs">VIDAVITALQR</text>
  `;

  const captionFontSize = 30;
  const caption = `
    <text x="${totalWidth / 2}" y="${qrPixelSize + captionHeight / 2}" text-anchor="middle" dominant-baseline="central"
      font-family="'Courier New', monospace" font-weight="700" font-size="${captionFontSize}" fill="#12282B">${escapeXml(folioText || '')}</text>
  `;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}">
  <rect x="0" y="0" width="${totalWidth}" height="${totalHeight}" fill="#F9F6EF"/>
  <g>${modulesSvg}</g>
  ${centerLabel}
  ${caption}
</svg>`;
}

// ---- Versión del QR lista para grabar con láser: mismo QR (nivel H), recortada en cuadrado
// exacto (sin el espacio del folio debajo, que ahí no se necesita) y con el ancho/alto ya en
// milímetros según la placa elegida. El texto "VIDAVITALQR" va como trazado vectorial, no como
// <text>, para que el software del láser lo pueda grabar. ----
async function buildQrSvgParaPlaca(targetUrl, placaEstilo) {
  const sizeMm = MEDIDA_QR_MM_POR_PLACA[placaEstilo];
  if (!sizeMm) return null; // estilo de placa no reconocido o sin medida definida

  const qr = QRCode.create(targetUrl, { errorCorrectionLevel: 'H' });
  const modules = qr.modules;
  const size = modules.size;
  const moduleSize = 10;
  const quietZone = 4;
  const qrPixelSize = (size + quietZone * 2) * moduleSize;

  let modulesSvg = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules.get(row, col)) {
        const x = (col + quietZone) * moduleSize;
        const y = (row + quietZone) * moduleSize;
        modulesSvg += `<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}" fill="#12282B"/>`;
      }
    }
  }

  const labelBoxWidthModules = Math.round(size * 0.72);
  const labelBoxHeightModules = Math.round(size * 0.16);
  const labelBoxWidth = labelBoxWidthModules * moduleSize;
  const labelBoxHeight = labelBoxHeightModules * moduleSize;
  const labelBoxX = (qrPixelSize - labelBoxWidth) / 2;
  const labelBoxY = (qrPixelSize - labelBoxHeight) / 2;
  const labelFontSize = Math.round(labelBoxHeight * 0.48);

  const centerLabel = `
    <rect x="${labelBoxX}" y="${labelBoxY}" width="${labelBoxWidth}" height="${labelBoxHeight}" rx="6" fill="#F9F6EF" stroke="#12282B" stroke-width="2"/>
    ${textoComoPath('VIDAVITALQR', qrPixelSize / 2, labelBoxY + labelBoxHeight / 2, labelFontSize, labelBoxWidth - 24)}
  `;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${sizeMm}mm" height="${sizeMm}mm" viewBox="0 0 ${qrPixelSize} ${qrPixelSize}">
  <rect x="0" y="0" width="${qrPixelSize}" height="${qrPixelSize}" fill="#F9F6EF"/>
  <g>${modulesSvg}</g>
  ${centerLabel}
</svg>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { buildQrSvg, buildQrSvgParaPlaca, MEDIDA_QR_MM_POR_PLACA };
