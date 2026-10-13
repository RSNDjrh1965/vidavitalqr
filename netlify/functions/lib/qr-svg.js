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
// lengthAdjust que usaba el <text> original). `maxScaleX` limita cuánto se puede ESTIRAR (no
// encoger) el texto — sin este límite, un folio corto forzado a ocupar todo el ancho disponible
// queda visiblemente "alargado"/deformado (2026-09-29, reportado por James con foto real de la
// placa impresa). Encoger (folio largo que no cabe) nunca se limita, porque ahí sí hace falta.
function textoComoPath(text, cx, cy, fontSize, targetWidth, maxScaleX) {
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
  let scaleX = targetWidth && advanceWidth ? targetWidth / advanceWidth : 1;
  if (maxScaleX && scaleX > maxScaleX) scaleX = maxScaleX;
  return `<g transform="translate(${cx} 0) scale(${scaleX.toFixed(4)} 1) translate(${-cx} 0)"><path d="${d}" fill="#12282B"/></g>`;
}

// ---- Tamaño de QR (en mm) recomendado para cada estilo de placa física, calculado a partir de
// las medidas reales de cada placa del catálogo del usuario (ver bitácora, punto de 2026-09-28).
//
// 2026-10-02: catálogo actualizado a pedido de James —
//  - "dije" ya NO es 40x40mm, ahora es 30x30mm (corrigió la medida; antes el QR era de 30mm,
//    ahora baja a 18mm para dejar margen libre para el texto del dominio).
//  - "pulsera" ya NO es 20x30mm, ahora es 20x28mm (el QR de 16mm se mantiene igual).
//  - se agregan 2 piezas nuevas de la cadena: "cadenaRect" (rectangular, 22x32mm, QR 18mm según
//    dato del usuario) y "cadenaCirc" (circular, Ø25mm desde 2026-10-12). cadenaCirc NO tiene entrada en
//    ALTURA_TOTAL_MM_POR_PLACA a propósito (ver más abajo): es la pieza más chica de todas, y un
//    QR es siempre una cuadrícula cuadrada — el máximo cuadrado que cabe completo dentro de un
//    círculo de 20mm de diámetro es de ~14mm (diagonal = diámetro), así que se deja en 13mm con
//    margen de seguridad. A pedido de James, esta placa NO lleva ningún texto, solo el QR — no
//    hay espacio real para nada más a ese tamaño (sin probar físico todavía, igual que pasó en su
//    momento con la pulsera de 16mm: confirmar con una grabación de prueba antes de usarla en
//    producción). IMPORTANTE: por ahora "cadenaRect"/"cadenaCirc" no están conectadas a ningún
//    producto comprable en index.html (a pedido de James, 2026-10-02) — solo existen aquí para
//    cuando él las genere manualmente. ----
const MEDIDA_QR_MM_POR_PLACA = {
  clasica: 20.35, // Placa 1, 40 x 20 mm (18 → 20.35 el 2026-10-13: módulo de 0,55 mm exactos = 11 píxeles a 508 dpi; probada en láser, lee bien con Xiaomi. El margen blanco de la placa queda en 2,0 mm)
  llavero: 20, // Placa 2, 40 x 22 mm
  ranuras: 22, // Placa 3, 45 x 25 mm
  dije: 20, // Placa 4, 30 x 30 mm (QR 18 → 20 el 2026-10-12 al pasar a URL en minúsculas, 29 módulos)
  pulsera: 18, // Pulsera 20 x 29 mm (QR 16 → 18 el 2026-10-12 para conservar ~0,49 mm por módulo con 29 módulos)
  cadenaRect: 20, // Cadena rectangular, 22 x 32 mm (QR 18 → 20 el 2026-10-12)
  cadenaCirc: 19, // Cadena circular, Ø25 mm (medida real confirmada 2026-10-12; antes Ø20 con QR 13). El QR incluye su margen blanco: la parte oscura queda de ~15 mm y su esquina más lejana a ~10,5 mm del centro, dentro del radio de 12,5 mm
};

// ---- Dimensión mayor real de cada placa física — se usa como alto total del diseño para láser:
// el QR va centrado dentro de ese alto, y el espacio libre que queda arriba/abajo (dimensión
// mayor menos el tamaño del QR, dividido entre 2) se usa para grabar el texto del dominio debajo
// del QR, sin agrandar el QR ni salirse del área física de la placa.
//
// 2026-10-02, a pedido de James: se quita el folio del grabado por completo (ver comentario en
// buildQrSvgParaPlaca). cadenaCirc no tiene entrada aquí a propósito: sin alto total definido, la
// función deja esa placa solo con el QR, sin texto. ----
const ALTURA_TOTAL_MM_POR_PLACA = {
  clasica: 40, // 40 x 20 mm → 11mm libres arriba/abajo del QR de 18mm
  llavero: 40, // 40 x 22 mm → 10mm libres arriba/abajo del QR de 20mm
  ranuras: 45, // 45 x 25 mm → 11.5mm libres arriba/abajo del QR de 22mm
  dije: 30, // 30 x 30 mm (corregido 2026-10-02) → 6mm libres arriba/abajo del QR de 18mm
  pulsera: 29, // placa de 20 x 29 mm (medida real confirmada 2026-10-12; antes 28) → 6,5mm libres arriba/abajo del QR de 16mm
  cadenaRect: 32, // 22 x 32 mm → 7mm libres arriba/abajo del QR de 18mm
};

// ---- 2026-10-12: tamaño real de cada placa en la plantilla de acrílico del láser. El archivo para
// grabar ahora mide EXACTAMENTE lo que mide la placa (ancho x alto, o diámetro en la circular), con
// el QR centrado, así el cero del láser (G92 X0 Y0) se pone siempre en la esquina inferior izquierda
// de la ventana y el diseño cae centrado en la placa. Lo que se agrega es solo espacio en blanco:
// el QR y el texto no cambian de tamaño. ----
const LADO_CORTO_MM_POR_PLACA = {
  clasica: 20, llavero: 22, ranuras: 25, dije: 30, pulsera: 20, cadenaRect: 22, cadenaCirc: 25,
};
// Placas que en la plantilla del láser quedan "acostadas" (el lado largo en horizontal): el diseño
// se gira 90° a la izquierda → el QR queda centrado en el lado largo, a la izquierda del texto, y
// el texto (pegado al QR, a su derecha) se lee de abajo hacia arriba. Las demás quedan de pie:
// QR arriba y texto abajo, como siempre.
const PLACAS_HORIZONTALES = ['clasica', 'llavero', 'ranuras'];

// ---- 2026-10-13: ajustes finos confirmados con pruebas de láser ----
// Llavero 40 x 22: el hueco para la argolla queda a la izquierda; el QR se corre 3 mm hacia la
// derecha (lejos del hueco) y el texto 3,3 mm, así ya no queda pegado al hueco ni descentrado.
const DESPLAZ_QR_MM_POR_PLACA = { llavero: 3, clasica: -0.025, pulsera: -2.35 };
// Corrimiento del QR en el otro eje (lado corto), para que los bordes de los módulos caigan en
// píxeles enteros a 508 dpi (clásica: +0,025 mm = medio píxel).
const DESPLAZ_QR_LADO_CORTO_MM_POR_PLACA = { clasica: 0.025 };
const DESPLAZ_TEXTO_MM_POR_PLACA = { llavero: 3.3, clasica: -1.1, pulsera: -2.35 };
// Ancho del texto del dominio (mm) cuando no debe crecer con el QR (clásica: se conserva el mismo
// texto que ya se probó con el QR de 18 mm = 92 % de 18 mm).
const ANCHO_TEXTO_MM_POR_PLACA = { clasica: 16.56 };

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

// ---- Versión del QR lista para grabar con láser: con el ancho/alto ya en milímetros según la
// placa elegida. El QR queda centrado dentro del alto total de la placa (ver
// ALTURA_TOTAL_MM_POR_PLACA) y, en el espacio libre que queda debajo, se graba el folio —
// 2026-09-29, a pedido del usuario, con las medidas reales de cada placa. El texto (tanto
// "VIDAVITALQR" como el folio) va como trazado vectorial, no como <text>, para que el software
// del láser lo pueda grabar. Si la placa no tiene alto total definido, se mantiene el
// comportamiento anterior: el SVG queda recortado justo al cuadrado del QR, sin folio.
//
// 2026-09-29 (mismo día, más tarde): en las placas más chicas (pulsera 16mm, clásica 18mm,
// llavero 20mm) el QR no se podía leer una vez grabado con el láser — probado por el usuario en
// físico. Causa: con nivel de corrección de errores 'H' (el más alto, elegido para poder tapar el
// centro con "VIDAVITALQR"), la URL necesitaba una cuadrícula de 37x37 módulos; en una placa de
// 16-20mm cada módulo quedaba de apenas ~0.35-0.45mm, demasiado chico para que el láser (con el
// producto de marcado encima) lo grabe con el contraste/nitidez suficiente para que la cámara del
// celular lo distinga.
//
// Primer intento (descartado): además de subir a mayúsculas, se bajó el nivel de corrección de
// 'H' a 'Q' (37 -> 29 módulos). Se probó en físico y de los 5 tamaños, los 3 más grandes SÍ
// escaneaban pero la página NO abría (bug de mayúsculas en la ruta "/v/", ver abajo), y los 2 más
// chicos seguían sin leerse en absoluto. Diagnóstico posterior (verificado con pruebas de
// decodificación automatizada): el recuadro "VIDAVITALQR" del centro, aunque solo tapa ~11-12%
// del área del QR, cae como un bloque compacto sobre pocos bloques de corrección de errores —
// con nivel 'Q' (25% de tolerancia nominal) eso ya era insuficiente en la práctica para que un
// lector real decodifique el código de forma confiable, aunque a simple vista se viera bien.
// Con nivel 'H' (30%, y sobre todo más bloques de corrección al ser una cuadrícula mayor) el
// mismo recuadro se decodifica sin problema.
//
// Solución final: mantener el nivel de corrección en 'H' (no bajarlo), pero sí aprovechar el
// modo alfanumérico del QR subiendo la URL a MAYÚSCULAS — el navegador no distingue mayúsculas/
// minúsculas en el dominio, así que sigue abriendo exactamente la misma ficha. Esto por sí solo
// ya baja la cuadrícula de 37x37 a 33x33 módulos (más chica, sin tocar el nivel de corrección),
// verificado que decodifica de forma confiable con el recuadro central incluido.
//
// IMPORTANTE: el segmento de ruta "/v/" de la URL (ej. vidavitalqr.com/v/VVITALQR00000118) debe
// quedar en minúscula — el redirect de netlify.toml (from = "/v/:folio") es sensible a
// mayúsculas/minúsculas, y poner "/V/" rompe la redirección: el celular lee el QR pero la página
// no abre la ficha (esto es justo lo que pasó en el primer intento con los 3 tamaños grandes). ----
//
// 2026-09-29 (más tarde todavía): James probó las 5 placas IMPRESAS a tamaño real (la prueba más
// parecida a la placa física real) con el arreglo de arriba (mayúsculas + nivel 'H', 33 módulos).
// Resultado: las 4 placas más grandes (18mm en adelante) ya leían bien. La pulsera (16mm, la placa
// más chica de todas) seguía sin leerse — a ese tamaño cada módulo mide apenas ~0.485mm, todavía
// al límite. Primero se le quitó el recuadro "VIDAVITALQR" del centro SOLO a la pulsera (bajando a
// nivel 'L'), y James confirmó en físico (impreso a tamaño real) que así sí leía perfecto.
//
// 2026-09-29 (más tarde aún): James pidió, con esa confirmación en mano, quitar el recuadro
// "VIDAVITALQR" del centro en LAS 5 PLACAS por igual (no solo la pulsera) — "es mas importante que
// se pueda leer el código" — para que las 5 tengan el mismo margen extra de lectura, aunque eso
// signifique perder el texto de marca en el centro del QR en todas. Por eso ya NO hay ninguna
// condición: ninguna placa dibuja el recuadro central, y todas usan nivel 'L' (el más compacto),
// sin ningún riesgo de ilegibilidad porque ya no hay ninguna obstrucción que tolerar.
// 2026-10-02, a pedido de James: se quita el folio del grabado por completo (antes de esto, el
// número de folio de cada ficha se grababa debajo del QR). Motivo: evitar los problemas de
// espacio/legibilidad que daba el folio (texto de largo variable, distinto en cada ficha) y
// dejar en su lugar un texto fijo y corto del dominio (vidavitalqr.com) en una sola línea.
//
// Se probó también partir ese texto en varias líneas (p. ej. "VIDA" / "VITAL" / "QR.com"),
// pensando que cada palabra podría verse más grande al no tener que compartir el ancho — pero
// una comparación real de tamaños (mm de alto de letra) en las 6 placas con texto mostró lo
// contrario: el margen disponible debajo del QR es angosto en ALTO, no en ancho, así que varias
// líneas compiten por ese poco alto y cada una queda más chica que una sola línea completa (hasta
// 3 veces más chica en algunos casos). Por eso se mantiene en una sola línea.
//
// La placa circular de cadena (cadenaCirc, Ø25mm) no tiene entrada en ALTURA_TOTAL_MM_POR_PLACA
// a propósito: a pedido de James, esa placa no lleva ningún texto, solo el QR — es la pieza más
// chica del catálogo y no hay margen real para nada más.
async function buildQrSvgParaPlaca(targetUrl, placaEstilo) {
  const sizeMm = MEDIDA_QR_MM_POR_PLACA[placaEstilo];
  if (!sizeMm) return null; // estilo de placa no reconocido o sin medida definida

  // 2026-10-12: la URL se codifica TAL CUAL (https://vidavitalqr.com/v/<FOLIO>), con "https" en
  // minúsculas. Antes se pasaba todo a mayúsculas para ahorrar módulos, pero algunos lectores de
  // Android (confirmado en un Xiaomi) leían "HTTPS://..." como URL y luego NO la abrían en el
  // navegador, porque el esquema en mayúsculas no es reconocido. Costo: el QR pasa de 25 a 29
  // módulos por lado, y por eso se agrandó un poco el QR de las placas donde cabe (ver tabla).
  const urlParaQr = String(targetUrl || '').trim();
  // Nivel de corrección 'L' (el más compacto): ya no se dibuja el recuadro "VIDAVITALQR" en
  // ninguna placa, así que no hace falta margen extra para tolerar una obstrucción central.
  const qr = QRCode.create(urlParaQr, { errorCorrectionLevel: 'L' });
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

  // Ya no se dibuja el recuadro "VIDAVITALQR" del centro en ninguna placa (a pedido de James,
  // 2026-09-29 — prioriza que el código se lea bien por encima del detalle de marca en el centro).
  const centerLabel = '';

  // ---- Alto total de la placa (mm) y margen libre arriba/abajo del QR, convertidos a la misma
  // escala de píxeles que usa el QR (qrPixelSize px = sizeMm mm, así que 1mm = qrPixelSize/sizeMm
  // px). Si no hay alto total definido para esta placa (caso de cadenaCirc), se deja solo el
  // cuadrado del QR, sin ningún texto. ----
  const alturaTotalMm = ALTURA_TOTAL_MM_POR_PLACA[placaEstilo];
  const pxPorMm = qrPixelSize / sizeMm;

  const ladoCortoMm = LADO_CORTO_MM_POR_PLACA[placaEstilo] || sizeMm;
  const ladoCortoPx = ladoCortoMm * pxPorMm;

  if (!alturaTotalMm) {
    // Placa circular: archivo cuadrado del tamaño del diámetro, con el QR centrado y sin texto.
    const off = (ladoCortoPx - qrPixelSize) / 2;
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${ladoCortoMm}mm" height="${ladoCortoMm}mm" viewBox="0 0 ${ladoCortoPx} ${ladoCortoPx}">
  <rect x="0" y="0" width="${ladoCortoPx}" height="${ladoCortoPx}" fill="#F9F6EF"/>
  <g transform="translate(${off} ${off})">
    <g>${modulesSvg}</g>
    ${centerLabel}
  </g>
</svg>`;
  }

  const margenMm = (alturaTotalMm - sizeMm) / 2;
  const margenPx = margenMm * pxPorMm;
  const totalHeightPx = qrPixelSize + margenPx * 2;

  // Texto fijo del dominio, en una sola línea — ocupa todo el margen disponible (ya no lo
  // comparte con ningún folio). El tamaño de letra se calcula primero para que quepa de ANCHO de
  // forma natural (sin comprimir ni estirar), y ese tamaño se limita además a no pasarse del alto
  // disponible. Solo si hiciera falta (no debería pasar con un texto fijo y corto como este) se
  // comprime un poco de ancho como último recurso, nunca se estira más allá de su proporción
  // natural.
  const textoDominio = 'vidavitalqr.com';
  const fontTmp = getFont();
  const opcionesFuente = { kerning: false, features: { liga: false, rlig: false } };
  const anchoTextoMm = ANCHO_TEXTO_MM_POR_PLACA[placaEstilo];
  const dominioTargetWidth = anchoTextoMm ? anchoTextoMm * (qrPixelSize / sizeMm) : qrPixelSize * 0.92;
  const altoDisponible = margenPx * 0.88; // tope por altura, para no salirse del margen

  const anchoAReferencia = fontTmp.getAdvanceWidth(textoDominio, 100, opcionesFuente) || 1;
  const dominioFontSizePorAncho = (dominioTargetWidth / anchoAReferencia) * 100;

  let dominioFontSize = Math.min(dominioFontSizePorAncho, altoDisponible);
  let dominioStretch = null; // null = sin estirar/comprimir (proporción natural de la fuente)

  const anchoFinal = fontTmp.getAdvanceWidth(textoDominio, dominioFontSize, opcionesFuente);
  if (anchoFinal > dominioTargetWidth) {
    dominioStretch = dominioTargetWidth / anchoFinal;
  }

  // El texto arranca justo debajo del QR, con un espacio chico fijo (5% del margen) en vez de
  // centrarlo en todo el margen libre — el espacio que sobra queda abajo, hacia el borde de la
  // placa (mismo criterio que ya se usaba para el folio).
  const alturaTextoDominio = (fontTmp.ascender - fontTmp.descender) * (dominioFontSize / fontTmp.unitsPerEm);
  const gapSuperior = margenPx * 0.05;
  const dominioCenterY = margenPx + qrPixelSize + gapSuperior + alturaTextoDominio / 2 + (DESPLAZ_TEXTO_MM_POR_PLACA[placaEstilo] || 0) * pxPorMm;

  const esHorizontal = PLACAS_HORIZONTALES.includes(placaEstilo);
  // Vertical: el texto va centrado en el ancho de la placa, debajo del QR. Horizontal: el mismo
  // texto se gira -90° (abajo hacia arriba) y queda a la derecha del QR, centrado en el lado corto.
  const textoCx = ladoCortoPx / 2;
  const dominioLabelVertical = textoComoPath(
    textoDominio,
    textoCx,
    dominioCenterY,
    dominioFontSize,
    dominioStretch ? dominioTargetWidth : null
  );

  const qrX = (ladoCortoPx - qrPixelSize) / 2 + (DESPLAZ_QR_LADO_CORTO_MM_POR_PLACA[placaEstilo] || 0) * pxPorMm;
  const qrY = margenPx + (DESPLAZ_QR_MM_POR_PLACA[placaEstilo] || 0) * pxPorMm;

  if (esHorizontal) {
    // Archivo de (lado largo x lado corto) mm. Se gira el diseño vertical 90° a la izquierda:
    // el punto (x, y) del diseño vertical pasa a (y, anchoVertical - x).
    const anchoHorizPx = totalHeightPx; // lado largo en px
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${alturaTotalMm}mm" height="${ladoCortoMm}mm" viewBox="0 0 ${anchoHorizPx} ${ladoCortoPx}">
  <rect x="0" y="0" width="${anchoHorizPx}" height="${ladoCortoPx}" fill="#F9F6EF"/>
  <g transform="translate(0 ${ladoCortoPx}) rotate(-90)">
    <g transform="translate(${qrX} ${qrY})">
      <g>${modulesSvg}</g>
      ${centerLabel}
    </g>
    ${dominioLabelVertical}
  </g>
</svg>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${ladoCortoMm}mm" height="${alturaTotalMm}mm" viewBox="0 0 ${ladoCortoPx} ${totalHeightPx}">
  <rect x="0" y="0" width="${ladoCortoPx}" height="${totalHeightPx}" fill="#F9F6EF"/>
  <g transform="translate(${qrX} ${qrY})">
    <g>${modulesSvg}</g>
    ${centerLabel}
  </g>
  ${dominioLabelVertical}
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
