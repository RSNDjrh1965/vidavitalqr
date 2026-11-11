// ---- 2026-11-10 (auditoría, hallazgo 14): escritura "optimista" de los Excel guardados en S3 ----
// resumen.xlsx y registro-ingresos.xlsx se descargan, se modifican y se vuelven a subir completos. Si dos guardados
// ocurrían a la vez, el segundo borraba la fila del primero. Ahora cada subida solo se acepta si el archivo en S3
// sigue siendo EXACTAMENTE el que se descargó (cabecera If-Match con el ETag); si otro guardado se coló en medio, S3
// responde 412, se vuelve a descargar el archivo ya actualizado y se repite el cambio (hasta 5 intentos). Si el
// archivo no existía, la subida usa If-None-Match "*" (solo si todavía no existe). Es el mismo mecanismo que ya usa
// folio-nuevo.js. Si S3 no devolviera ETag, la subida es normal (como antes).
function esPrecondicionFallida(err) {
  return !!err && (err.name === 'PreconditionFailed' || err.Code === 'PreconditionFailed' || (err.$metadata && err.$metadata.httpStatusCode === 412));
}

// "etag" y "existia" vienen de leer el archivo (ver cargarOCrearLibro en cada librería)
function condicionDeEscritura(etag, existia) {
  if (existia && etag) return { IfMatch: etag };
  if (!existia) return { IfNoneMatch: '*' };
  return {};
}

async function reintentarSiCambio(fn, intentos = 5) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!esPrecondicionFallida(err)) throw err;
      ultimo = err;
      await new Promise((r) => setTimeout(r, 120 * (i + 1) + Math.floor(Math.random() * 150)));
    }
  }
  throw ultimo;
}

module.exports = { esPrecondicionFallida, condicionDeEscritura, reintentarSiCambio };
