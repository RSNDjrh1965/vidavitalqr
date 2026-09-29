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
// las medidas reales de cada placa del catálogo del usuario (ver bitácora, punto de 2026-09-28) ----
const MEDIDA_QR_MM_POR_PLACA = {
  clasica: 18, // Placa 1, 40 x 20 mm
  llavero: 20, // Placa 2, 40 x 22 mm
  ranuras: 22, // Placa 3, 45 x 25 mm
  dije: 30, // Placa 4, 40 x 40 mm
  pulsera: 16, // Pulsera con placa QR, área grabable 16 x 16 mm (2026-09-29, dato del usuario)
};

// ---- Dimensión mayor real de cada placa física (2026-09-29, dato del usuario) — se usa como
// alto total del diseño para láser: el QR va centrado dentro de ese alto, y el espacio libre que
// queda arriba/abajo (dimensión mayor menos el tamaño del QR, dividido entre 2) se usa para
// grabar el folio debajo del QR, sin agrandar el QR ni salirse del área física de la placa.
// Ejemplo dado por el usuario: placa clásica 40mm de largo, QR de 18mm → 40-18=22mm libres →
// centrado, quedan 11mm arriba y 11mm abajo; el folio se graba en esos 11mm de abajo. ----
const ALTURA_TOTAL_MM_POR_PLACA = {
  clasica: 40, // 40 x 20 mm → 11mm libres arriba/abajo del QR de 18mm
  llavero: 40, // 40 x 22 mm → 10mm libres arriba/abajo del QR de 20mm
  ranuras: 45, // 45 x 25 mm → 11.5mm libres arriba/abajo del QR de 22mm
  dije: 40, // 40 x 40 mm → 5mm libres arriba/abajo del QR de 30mm
  pulsera: 30, // placa de 20 x 30 mm → 7mm libres arriba/abajo del QR de 16mm
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
async function buildQrSvgParaPlaca(targetUrl, placaEstilo, folioText) {
  const sizeMm = MEDIDA_QR_MM_POR_PLACA[placaEstilo];
  if (!sizeMm) return null; // estilo de placa no reconocido o sin medida definida

  // Mayúsculas en toda la URL EXCEPTO el segmento de ruta "/v/", que se conserva en minúscula.
  const urlParaQr = String(targetUrl || '').toUpperCase().replace('/V/', '/v/');
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
  // px). Si no hay alto total definido para esta placa, o no llegó folio, se mantiene el
  // comportamiento anterior (solo el cuadrado del QR, sin folio). ----
  const alturaTotalMm = ALTURA_TOTAL_MM_POR_PLACA[placaEstilo];
  const pxPorMm = qrPixelSize / sizeMm;

  if (!alturaTotalMm || !folioText) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${sizeMm}mm" height="${sizeMm}mm" viewBox="0 0 ${qrPixelSize} ${qrPixelSize}">
  <rect x="0" y="0" width="${qrPixelSize}" height="${qrPixelSize}" fill="#F9F6EF"/>
  <g>${modulesSvg}</g>
  ${centerLabel}
</svg>`;
  }

  const margenMm = (alturaTotalMm - sizeMm) / 2;
  const margenPx = margenMm * pxPorMm;
  const totalHeightPx = qrPixelSize + margenPx * 2;

  // Tamaño de letra del folio: 2026-09-29, corregido después de que James mandó una foto de la
  // placa impresa y el folio se veía "muy alargado". Causa real: el tamaño de letra se elegía
  // SOLO en función del alto disponible (el margen), sin mirar el ancho — y como el QR ahora es
  // mucho más chico que antes (se le quitó el recuadro central y bajó a nivel 'L', ver arriba),
  // ese tamaño de letra resultaba enorme comparado con el ancho real de la placa, y había que
  // comprimirlo muchísimo de ancho para que cupiera — eso es lo que se veía "alargado"/deformado
  // (letras muy angostas y altas). Corrección: el tamaño de letra se calcula primero para que el
  // folio quepa de ANCHO de forma natural (sin comprimir ni estirar nada), y ESE tamaño se limita
  // además a no pasarse del alto disponible. Solo si un folio fuera tan largo que ni reduciendo la
  // letra al mínimo legible cupiera, ahí sí se comprime un poco de ancho como último recurso.
  //
  // 2026-09-29 (más tarde): James mostró una muestra física vieja (otro producto, "adidata.com")
  // donde sintió que el texto se veía muy pequeño, y pidió que el folio se vea más grande — y, si
  // cabe, agregar también el dominio debajo (como en esa muestra: número arriba, dominio abajo).
  // Cambios: (1) el tope por altura del folio sube de 0.55 a 0.88 del margen disponible — antes
  // dejaba el folio innecesariamente chico incluso cuando sobraba espacio vertical; (2) el ancho
  // objetivo sube de 0.88 a 0.92 del ancho del QR; (3) el dominio ("vidavitalqr.com") se agrega
  // como una segunda línea, más chica, SOLO si sobra suficiente alto debajo del folio ya
  // agrandado como para que quede legible (mínimo ~1.1mm reales de alto) — nunca a costa de
  // achicar el folio, que es lo prioritario. Si no cabe, se omite y el folio usa todo el alto
  // disponible igual que antes.
  const textoFolio = String(folioText || '');
  const textoDominio = 'vidavitalqr.com';
  const fontTmp = getFont();
  const opcionesFuente = { kerning: false, features: { liga: false, rlig: false } };
  const folioTargetWidth = qrPixelSize * 0.92;
  const altoDisponible = margenPx * 0.88; // tope por altura, para no salirse del margen

  // Ancho que ocuparía el folio a un tamaño de referencia (100px) — el ancho escala de forma
  // lineal con el tamaño de letra, así que de ahí se despeja el tamaño exacto que llena el ancho
  // disponible sin deformar nada.
  const anchoAReferencia = fontTmp.getAdvanceWidth(textoFolio, 100, opcionesFuente) || 1;
  const folioFontSizePorAncho = (folioTargetWidth / anchoAReferencia) * 100;

  let folioFontSize = Math.min(folioFontSizePorAncho, altoDisponible);
  let folioStretch = null; // null = sin estirar/comprimir (proporción natural de la fuente)

  // Con el tamaño ya elegido, se revisa si de verdad cabe de ancho (debería, salvo un folio
  // excepcionalmente largo en una placa con margen muy angosto) — si no cabe, se comprime un
  // poco como último recurso, nunca se estira más allá de su proporción natural.
  const anchoFinal = fontTmp.getAdvanceWidth(textoFolio, folioFontSize, opcionesFuente);
  if (anchoFinal > folioTargetWidth) {
    folioStretch = folioTargetWidth / anchoFinal;
  }

  // Espacio que le queda al dominio debajo del folio ya agrandado.
  const alturaTextoFolio = (fontTmp.ascender - fontTmp.descender) * (folioFontSize / fontTmp.unitsPerEm);
  const separacionLineas = folioFontSize * 0.15;
  const altoRestante = altoDisponible - alturaTextoFolio - separacionLineas;
  const tamanoMinimoDominioPx = 1.1 * pxPorMm; // ~1.1mm reales, mínimo para que se pueda grabar/leer

  let mostrarDominio = false;
  let dominioFontSize = 0;
  let dominioStretch = null;
  if (altoRestante >= tamanoMinimoDominioPx) {
    const anchoRefDominio = fontTmp.getAdvanceWidth(textoDominio, 100, opcionesFuente) || 1;
    const dominioFontSizePorAncho = (folioTargetWidth / anchoRefDominio) * 100;
    dominioFontSize = Math.min(dominioFontSizePorAncho, altoRestante);
    if (dominioFontSize >= tamanoMinimoDominioPx) {
      mostrarDominio = true;
      const anchoFinalDominio = fontTmp.getAdvanceWidth(textoDominio, dominioFontSize, opcionesFuente);
      if (anchoFinalDominio > folioTargetWidth) {
        dominioStretch = folioTargetWidth / anchoFinalDominio;
      }
    }
  }

  // 2026-09-29 (más tarde): James pidió acercar el texto al QR (moverlo hacia arriba) en vez de
  // centrarlo en todo el margen libre — antes quedaba centrado entre el QR y el borde de la
  // placa, dejando un espacio grande arriba del texto. Ahora el bloque de texto arranca justo
  // debajo del QR, con un espacio chico fijo (12% del margen) en vez de repartirlo por igual
  // arriba y abajo; el espacio que sobra queda abajo, hacia el borde de la placa.
  const gapSuperior = margenPx * 0.05;
  let folioCenterY;
  let dominioCenterY = 0;
  if (mostrarDominio) {
    const inicioBloque = margenPx + qrPixelSize + gapSuperior;
    folioCenterY = inicioBloque + alturaTextoFolio / 2;
    dominioCenterY = inicioBloque + alturaTextoFolio + separacionLineas + dominioFontSize / 2;
  } else {
    folioCenterY = margenPx + qrPixelSize + gapSuperior + alturaTextoFolio / 2;
  }

  const folioLabel = textoComoPath(
    textoFolio,
    qrPixelSize / 2,
    folioCenterY,
    folioFontSize,
    folioStretch ? folioTargetWidth : null
  );

  const dominioLabel = mostrarDominio
    ? textoComoPath(textoDominio, qrPixelSize / 2, dominioCenterY, dominioFontSize, dominioStretch ? folioTargetWidth : null)
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${sizeMm}mm" height="${alturaTotalMm}mm" viewBox="0 0 ${qrPixelSize} ${totalHeightPx}">
  <rect x="0" y="0" width="${qrPixelSize}" height="${totalHeightPx}" fill="#F9F6EF"/>
  <g transform="translate(0 ${margenPx})">
    <g>${modulesSvg}</g>
    ${centerLabel}
  </g>
  ${folioLabel}
  ${dominioLabel}
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
