
// ---- Genera un código QR como SVG (sin dependencias nativas tipo canvas/sharp) ----
// - Codifica una URL en el QR (nivel de corrección de errores alto, para poder tapar el centro).
// - Dibuja "VIDAVITALQR" centrado y legible dentro del propio QR.
// - Debajo del QR (fuera del área escaneable) dibuja el folio/contador de la ficha.
const QRCode = require('grcode');
 
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
 
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
 
module.exports = { buildQrSvg };
