// ---- Convierte el SVG de una placa (el que arma buildQrSvgParaPlaca) en un PNG de grabado ----
// 2026-10-13. LaserGRBL NO graba bien los SVG de las placas (solo toma el recuadro exterior: los
// rectángulos rellenos y el texto no los importa), pero sí graba perfecto un PNG en blanco y negro.
// Por eso cada compra ahora guarda también este PNG: 1 bit (negro = grabar), 508 dpi (20 px/mm)
// y con el tamaño EXACTO de la placa, tal como se probó en el láser con las 7 placas.
//
// Sin dependencias nativas (nada de sharp/canvas/resvg, que pueden fallar en Netlify): es un
// rasterizador mínimo hecho a la medida del SVG que genera qr-svg.js, que solo contiene:
//   <rect> (fondo y módulos del QR), <g transform="translate/rotate/scale"> anidados y <path>
//   con comandos M L C Q Z absolutos (el texto del dominio). Cualquier otra cosa se ignora.
// Se dibuja con sobremuestreo 4x4 y se decide negro/blanco por mayoría, que da bordes limpios.
const zlib = require('zlib');

const PX_POR_MM = 20; // 508 dpi
const SS = 4; // sobremuestreo por eje

// ---------- transformaciones afines [a b c d e f] ----------
const IDENT = [1, 0, 0, 1, 0, 0];
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function parseTransform(texto) {
  let m = IDENT;
  if (!texto) return m;
  const re = /(translate|rotate|scale)\(([^)]*)\)/g;
  let r;
  while ((r = re.exec(texto))) {
    const v = r[2].trim().split(/[\s,]+/).map(Number);
    let t = IDENT;
    if (r[1] === 'translate') t = [1, 0, 0, 1, v[0] || 0, v.length > 1 ? v[1] : 0];
    else if (r[1] === 'scale') t = [v[0], 0, 0, v.length > 1 ? v[1] : v[0], 0, 0];
    else {
      const a = ((v[0] || 0) * Math.PI) / 180;
      t = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
    }
    m = mul(m, t);
  }
  return m;
}
const aplicar = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// ---------- trazado (path) → polilíneas ----------
function polilineasDePath(d, m) {
  const tokens = d.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  const polis = [];
  let actual = null;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let i = 0;
  const num = () => parseFloat(tokens[i++]);
  const pt = (x, y) => aplicar(m, x, y);
  let cmd = '';
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === 'M') {
      cx = num(); cy = num(); sx = cx; sy = cy;
      actual = [pt(cx, cy)]; polis.push(actual); cmd = 'L';
    } else if (cmd === 'L') {
      cx = num(); cy = num(); actual.push(pt(cx, cy));
    } else if (cmd === 'Q') {
      const x1 = num(), y1 = num(), x = num(), y = num();
      for (let k = 1; k <= 12; k++) {
        const t = k / 12, u = 1 - t;
        actual.push(pt(u * u * cx + 2 * u * t * x1 + t * t * x, u * u * cy + 2 * u * t * y1 + t * t * y));
      }
      cx = x; cy = y;
    } else if (cmd === 'C') {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        actual.push(pt(
          u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
          u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y
        ));
      }
      cx = x; cy = y;
    } else if (cmd === 'Z' || cmd === 'z') {
      cx = sx; cy = sy; actual = null; cmd = '';
    } else {
      i++; // comando no soportado: se salta
    }
  }
  return polis;
}

// ---------- máscara sobremuestreada ----------
function rellenarRect(mask, W, H, x0, y0, x1, y1) {
  const ax = Math.max(0, Math.round(Math.min(x0, x1))), bx = Math.min(W, Math.round(Math.max(x0, x1)));
  const ay = Math.max(0, Math.round(Math.min(y0, y1))), by = Math.min(H, Math.round(Math.max(y0, y1)));
  for (let y = ay; y < by; y++) mask.fill(1, y * W + ax, y * W + bx);
}

// relleno de polígonos con regla de "no cero" (como SVG por defecto), una pasada por subfila
function rellenarPolis(mask, W, H, polis) {
  const aristas = [];
  let minY = Infinity, maxY = -Infinity;
  for (const p of polis) {
    if (p.length < 2) continue;
    for (let k = 0; k < p.length; k++) {
      const a = p[k], b = p[(k + 1) % p.length];
      if (a[1] === b[1]) continue;
      aristas.push(a[1] < b[1] ? { x0: a[0], y0: a[1], x1: b[0], y1: b[1], dir: 1 } : { x0: b[0], y0: b[1], x1: a[0], y1: a[1], dir: -1 });
      minY = Math.min(minY, a[1], b[1]); maxY = Math.max(maxY, a[1], b[1]);
    }
  }
  if (!aristas.length) return;
  const yIni = Math.max(0, Math.floor(minY)), yFin = Math.min(H - 1, Math.ceil(maxY));
  for (let y = yIni; y <= yFin; y++) {
    const yc = y + 0.5;
    const cruces = [];
    for (const e of aristas) {
      if (yc >= e.y0 && yc < e.y1) cruces.push([e.x0 + ((yc - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), e.dir]);
    }
    cruces.sort((a, b) => a[0] - b[0]);
    let w = 0;
    for (let k = 0; k < cruces.length - 1; k++) {
      w += cruces[k][1];
      if (w !== 0) {
        const xa = Math.max(0, Math.round(cruces[k][0])), xb = Math.min(W, Math.round(cruces[k + 1][0]));
        if (xb > xa) mask.fill(1, y * W + xa, y * W + xb);
      }
    }
  }
}

// ---------- lectura del SVG ----------
function esFondo(fill) {
  return /^#f/i.test(fill || ''); // el fondo crema (#F9F6EF) es claro: no se graba
}

function rasterizarSvg(svg) {
  const cab = /<svg[^>]*width="([\d.]+)mm"[^>]*height="([\d.]+)mm"[^>]*viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!cab) throw new Error('png-placa: no se pudo leer el tamaño del SVG');
  const anchoMm = parseFloat(cab[1]), altoMm = parseFloat(cab[2]);
  const vbW = parseFloat(cab[3]), vbH = parseFloat(cab[4]);
  const wPx = Math.round(anchoMm * PX_POR_MM), hPx = Math.round(altoMm * PX_POR_MM);
  const W = wPx * SS, H = hPx * SS;
  const mask = new Uint8Array(W * H);
  const base = [(W / vbW), 0, 0, (H / vbH), 0, 0];

  const pila = [base];
  const re = /<(\/?)(g|rect|path)\b([^>]*?)(\/?)>/g;
  let r;
  while ((r = re.exec(svg))) {
    const [, cierra, tag, attrs, autocierre] = r;
    if (tag === 'g') {
      if (cierra) pila.pop();
      else {
        const t = /transform="([^"]*)"/.exec(attrs);
        pila.push(mul(pila[pila.length - 1], parseTransform(t && t[1])));
        if (autocierre) pila.pop();
      }
      continue;
    }
    const fill = (/fill="([^"]*)"/.exec(attrs) || [])[1];
    if (!fill || esFondo(fill)) continue;
    const m = pila[pila.length - 1];
    if (tag === 'rect') {
      const g = (n) => parseFloat((new RegExp(`\\b${n}="([^"]*)"`).exec(attrs) || [])[1]);
      const x = g('x') || 0, y = g('y') || 0, w = g('width'), h = g('height');
      const p1 = aplicar(m, x, y), p2 = aplicar(m, x + w, y + h);
      rellenarRect(mask, W, H, p1[0], p1[1], p2[0], p2[1]);
    } else {
      const d = (/\bd="([^"]*)"/.exec(attrs) || [])[1];
      if (d) rellenarPolis(mask, W, H, polilineasDePath(d, m));
    }
  }

  // reducir SS x SS → 1 píxel: negro si al menos la mitad de las muestras están rellenas
  const negro = new Uint8Array(wPx * hPx);
  const umbral = (SS * SS) / 2;
  for (let y = 0; y < hPx; y++) {
    for (let x = 0; x < wPx; x++) {
      let s = 0;
      for (let j = 0; j < SS; j++) {
        const fila = (y * SS + j) * W + x * SS;
        for (let i = 0; i < SS; i++) s += mask[fila + i];
      }
      negro[y * wPx + x] = s >= umbral ? 1 : 0;
    }
  }
  return { wPx, hPx, negro };
}

// ---------- codificador PNG (1 bit, escala de grises, con 508 dpi) ----------
const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(tipo, datos) {
  const len = Buffer.alloc(4); len.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([len, cuerpo, crc]);
}
function codificarPng1bit({ wPx, hPx, negro }) {
  const bytesFila = Math.ceil(wPx / 8);
  const crudo = Buffer.alloc((bytesFila + 1) * hPx); // cada fila empieza con el byte de filtro 0
  for (let y = 0; y < hPx; y++) {
    const o = y * (bytesFila + 1);
    for (let x = 0; x < wPx; x++) {
      if (!negro[y * wPx + x]) crudo[o + 1 + (x >> 3)] |= 0x80 >> (x & 7); // 1 = blanco, 0 = negro
    }
    // relleno del último byte (bits sobrantes) en blanco
    for (let x = wPx; x < bytesFila * 8; x++) crudo[o + 1 + (x >> 3)] |= 0x80 >> (x & 7);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(wPx, 0); ihdr.writeUInt32BE(hPx, 4);
  ihdr[8] = 1; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 1 bit, grises, sin entrelazado
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(20000, 0); phys.writeUInt32BE(20000, 4); phys[8] = 1; // 20000 px/m = 508 dpi
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('pHYs', phys),
    chunk('IDAT', zlib.deflateSync(crudo, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Recibe el SVG de una placa (texto) y devuelve un Buffer PNG listo para LaserGRBL, o null si no
// hay SVG. Nunca debe tumbar el guardado de la ficha: quien lo llama lo envuelve en try/catch.
function svgPlacaAPng(svg) {
  if (!svg) return null;
  return codificarPng1bit(rasterizarSvg(svg));
}

module.exports = { svgPlacaAPng };
