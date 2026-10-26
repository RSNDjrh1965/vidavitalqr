// ---- lib/impresion-empresa.js (Automatización de impresión de tarjetas de empresa, 2026-10-23) ----
// Construye el PDF "listo para imprenta": una tarjeta por página, tarjeta final (corte) de 54 × 85.6 mm en
// VERTICAL (diseño aprobado por James el 2026-10-26) centrada en una hoja de 68 × 99.6 mm, con SANGRADO de 3 mm
// (se genera estirando el borde de la tarjeta, así no queda filo blanco si el corte se corre) y MARCAS DE CORTE
// en las 4 esquinas. Si una imagen de tarjeta es horizontal (tarjetas antiguas), esa página sale horizontal.
// Medidas ajustables aquí abajo si la imprenta pide otras.
const { PDFDocument, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } = require('pdf-lib');

const MM = 72 / 25.4;
const CARD_W_MM = 54, CARD_H_MM = 85.6;     // corte final, vertical
const BLEED_MM = 3;
const MARGEN_MM = 7;                         // espacio libre alrededor del corte (sangrado + marcas)
const MAX_TARJETAS_POR_PDF = 60;             // ~14 MB: cabe holgado en un correo (Resend admite ~40 MB tras base64)

// lee el ancho y alto de un JPEG (marcador SOF); devuelve null si no se puede
function dimensionesJpeg(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

async function construirPdf(jpgs) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Tarjetas VidaVitalQR para imprenta');
  const B = BLEED_MM * MM;
  const S = 64; // factor de estiramiento del píxel de borde (debe cubrir el sangrado)
  for (const buf of jpgs) {
    const d = dimensionesJpeg(buf);
    const horizontal = !!d && d.w > d.h;
    const W = (horizontal ? CARD_H_MM : CARD_W_MM) * MM, H = (horizontal ? CARD_W_MM : CARD_H_MM) * MM;
    const PW = W + 2 * MARGEN_MM * MM, PH = H + 2 * MARGEN_MM * MM;
    const x0 = (PW - W) / 2, y0 = (PH - H) / 2; // esquina inferior izquierda del corte
    const img = await pdf.embedJpg(buf);
    const page = pdf.addPage([PW, PH]);
    const clipped = (rx, ry, rw, rh, dx, dy, dw, dh) => {
      page.pushOperators(pushGraphicsState(), rectangle(rx, ry, rw, rh), clip(), endPath());
      page.drawImage(img, { x: dx, y: dy, width: dw, height: dh });
      page.pushOperators(popGraphicsState());
    };
    // 1) tarjeta en tamaño real
    page.drawImage(img, { x: x0, y: y0, width: W, height: H });
    // 2) sangrado: se estira el píxel del borde (lados) y de la esquina (esquinas)
    clipped(x0 - B, y0, B, H, x0 - B, y0, W * S, H);                                        // izquierda
    clipped(x0 + W, y0, B, H, x0 + W + B - W * S, y0, W * S, H);                           // derecha
    clipped(x0, y0 + H, W, B, x0, y0 + H + B - H * S, W, H * S);                            // arriba
    clipped(x0, y0 - B, W, B, x0, y0 - B, W, H * S);                                        // abajo
    clipped(x0 - B, y0 + H, B, B, x0 - B, y0 + H + B - H * S, W * S, H * S);                // arriba-izq
    clipped(x0 + W, y0 + H, B, B, x0 + W + B - W * S, y0 + H + B - H * S, W * S, H * S);    // arriba-der
    clipped(x0 - B, y0 - B, B, B, x0 - B, y0 - B, W * S, H * S);                            // abajo-izq
    clipped(x0 + W, y0 - B, B, B, x0 + W + B - W * S, y0 - B, W * S, H * S);                // abajo-der
    // 3) marcas de corte (fuera del sangrado, 0.5 mm de separación)
    const g = (B + 0.5 * MM), L = 3 * MM, col = rgb(0, 0, 0), t = 0.3;
    for (const x of [x0, x0 + W]) {
      page.drawLine({ start: { x, y: y0 - g }, end: { x, y: y0 - g - L }, thickness: t, color: col });
      page.drawLine({ start: { x, y: y0 + H + g }, end: { x, y: y0 + H + g + L }, thickness: t, color: col });
    }
    for (const y of [y0, y0 + H]) {
      page.drawLine({ start: { x: x0 - g, y }, end: { x: x0 - g - L, y }, thickness: t, color: col });
      page.drawLine({ start: { x: x0 + W + g, y }, end: { x: x0 + W + g + L, y }, thickness: t, color: col });
    }
  }
  return Buffer.from(await pdf.save());
}

module.exports = { construirPdf, dimensionesJpeg, MAX_TARJETAS_POR_PDF, CARD_W_MM, CARD_H_MM, BLEED_MM };
