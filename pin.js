// ---- Genera y valida el PIN de acceso de cada ficha (folio + PIN) ----
// El PIN NO se guarda en texto plano: se guarda su hash (SHA-256) en el archivo de acceso
// (`login/<folio>.json`, en el bucket privado de resumen, nunca expuesto por una URL pública).
// Formato del PIN: 6 caracteres alfanuméricos — 3 letras y 3 números, en orden mezclado (no
// siempre letras-primero) para que sea un poco más difícil de adivinar. Se excluyen caracteres
// fácilmente confundibles entre sí (I, O, 0, 1) para que sea cómodo de transcribir a mano.
const crypto = require('crypto');

const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin I, O
const DIGITOS = '23456789'; // sin 0, 1

function elegir(charset) {
  return charset[crypto.randomInt(charset.length)];
}

function generarPin() {
  const caracteres = [
    elegir(LETRAS), elegir(LETRAS), elegir(LETRAS),
    elegir(DIGITOS), elegir(DIGITOS), elegir(DIGITOS),
  ];
  // mezclar el orden (Fisher-Yates) para no quedar siempre como "LLLNNN"
  for (let i = caracteres.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [caracteres[i], caracteres[j]] = [caracteres[j], caracteres[i]];
  }
  return caracteres.join('');
}

function normalizarPin(pin) {
  return String(pin || '').trim().toUpperCase();
}

function hashPin(pin) {
  return crypto.createHash('sha256').update(normalizarPin(pin)).digest('hex');
}

function pinValido(pin, hashGuardado) {
  if (!pin || !hashGuardado) return false;
  const hashIngresado = hashPin(pin);
  // comparación en tiempo constante para no filtrar información por temporización
  const a = Buffer.from(hashIngresado, 'hex');
  const b = Buffer.from(hashGuardado, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { generarPin, hashPin, pinValido, normalizarPin };
