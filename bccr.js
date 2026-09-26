// ---- lib/bccr.js ----
// Consulta el tipo de cambio de referencia de VENTA del dólar (indicador 318 — 317 es el de
// compra) publicado por el Banco Central de Costa Rica (BCCR). Se usa "venta" porque es el que
// le conviene a VidaVitalQR como referencia: es la tasa a la que el negocio necesitaría comprar
// dólares con los colones que reciba, así que protege el margen del negocio mejor que "compra".
//
// 2026-09-23: el BCCR tiene DOS servicios distintos para esto, y este archivo intenta primero el
// nuevo y cae al viejo si hace falta:
//
//   1) API NUEVA (SDDE, REST/JSON) — método preferido. Se diagnosticó que el servicio viejo
//      (más abajo) estaba fallando con error 503 de forma intermitente, incluso probado a mano
//      desde un navegador normal fuera de Netlify — es decir, es una falla del propio servidor
//      del BCCR, no de nuestro código. El BCCR migró (o está migrando) a esta API más moderna,
//      alojada en un gateway de APIs (apim.bccr.fi.cr) en vez del servidor IIS viejo, así que es
//      razonable esperar que sea más estable. Requiere un token tipo "Bearer" que se genera
//      desde el portal del BCCR, en "Mi perfil → Generar token" (es un token DISTINTO al
//      correo+token del servicio viejo). Variable de entorno: BCCR_API_TOKEN.
//      Documentación oficial: "Estándar API SDDE" (PDF publicado por el BCCR).
//
//   2) SERVICIO VIEJO (SOAP/ASMX, con binding HTTP GET) — respaldo, por si la API nueva llegara
//      a fallar. Requiere BCCR_CORREO + BCCR_TOKEN (el correo y token de suscripción original).
//      Documentación oficial: "WEBSERVICES DE INDICADORES ECONOMICOS.pdf".
//
// Se consulta un rango de 7 días (no solo "hoy") en ambos casos porque el BCCR no publica dato
// los fines de semana ni los feriados, y se toma el valor más reciente del rango.

const INDICADOR_VENTA = 318;
const DIAS_RANGO_CONSULTA = 7;

function formatearFechaDDMMYYYY(fecha) {
  const dd = String(fecha.getDate()).padStart(2, '0');
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const yyyy = fecha.getFullYear();
  return dd + '/' + mm + '/' + yyyy;
}

function formatearFechaYYYYMMDD(fecha) {
  const dd = String(fecha.getDate()).padStart(2, '0');
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const yyyy = fecha.getFullYear();
  return yyyy + '/' + mm + '/' + dd;
}

function rangoConsulta() {
  const hoy = new Date();
  const desde = new Date(hoy.getTime() - DIAS_RANGO_CONSULTA * 24 * 60 * 60 * 1000);
  return { hoy, desde };
}

// ==== 1) API nueva (SDDE, REST/JSON) ====================================================

const SDDE_BASE = 'https://apim.bccr.fi.cr/SDDE/api/Bccr.GE.SDDE.Publico.Indicadores.API';

async function obtenerTipoCambioVentaAPINueva({ apiToken }) {
  if (!apiToken) {
    throw new Error('Falta BCCR_API_TOKEN (token de la API nueva del BCCR).');
  }

  const { hoy, desde } = rangoConsulta();
  const params = new URLSearchParams({
    fechaInicio: formatearFechaYYYYMMDD(desde),
    fechaFin: formatearFechaYYYYMMDD(hoy),
    idioma: 'es',
  });

  const url = SDDE_BASE + '/indicadoresEconomicos/' + INDICADOR_VENTA + '/series?' + params.toString();

  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + apiToken,
        'Accept': 'application/json',
      },
    });
  } catch (err) {
    throw new Error('No se pudo contactar la API nueva del BCCR (SDDE): ' + err.message);
  }

  if (!resp.ok) {
    let cuerpo = '';
    try { cuerpo = (await resp.text()).slice(0, 300); } catch (e) { /* sin cuerpo legible */ }
    throw new Error('La API nueva del BCCR (SDDE) respondió con estado ' + resp.status + (cuerpo ? ' — cuerpo: ' + cuerpo : ''));
  }

  let json;
  const texto = await resp.text();
  try {
    json = JSON.parse(texto);
  } catch (err) {
    throw new Error('La API nueva del BCCR (SDDE) no devolvió JSON válido — cuerpo: ' + texto.slice(0, 300));
  }

  if (json && json.estado === false) {
    throw new Error('La API nueva del BCCR (SDDE) reportó un error: ' + (json.mensaje || JSON.stringify(json).slice(0, 300)));
  }

  // ---- estructura esperada: { estado, mensaje, datos: [ { codigoIndicador, nombreIndicador,
  // series: [ { fecha: "yyyy-mm-dd", valorDatoPorPeriodo: <numero> }, ... ] } ] } ----
  const datos = (json && Array.isArray(json.datos)) ? json.datos : [];
  const valores = [];
  for (const entradaIndicador of datos) {
    const serie = Array.isArray(entradaIndicador.series) ? entradaIndicador.series : [];
    for (const punto of serie) {
      const v = Number(punto.valorDatoPorPeriodo);
      if (!isNaN(v) && punto.fecha) {
        valores.push({ fecha: String(punto.fecha), valor: v });
      }
    }
  }

  if (!valores.length) {
    throw new Error(
      'La API nueva del BCCR (SDDE) no devolvió ningún valor para el indicador ' + INDICADOR_VENTA +
      ' en los últimos ' + DIAS_RANGO_CONSULTA + ' días (respuesta cruda: ' + texto.slice(0, 300) + ')'
    );
  }

  // ---- se ordena por fecha (formato yyyy-mm-dd ordena bien como texto) y se toma la más reciente ----
  valores.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  return valores[valores.length - 1].valor;
}

// ==== 2) Servicio viejo (SOAP/ASMX, binding HTTP GET) — respaldo ========================

const ASMX_BASE = 'https://gee.bccr.fi.cr/Indicadores/Suscripciones/WS/wsindicadoreseconomicos.asmx/ObtenerIndicadoresEconomicos';

async function obtenerTipoCambioVentaServicioViejo({ correo, token, nombre }) {
  if (!correo || !token) {
    throw new Error('Faltan BCCR_CORREO / BCCR_TOKEN (credenciales del servicio viejo del BCCR).');
  }

  const { hoy, desde } = rangoConsulta();
  const params = new URLSearchParams({
    Indicador: String(INDICADOR_VENTA),
    FechaInicio: formatearFechaDDMMYYYY(desde),
    FechaFinal: formatearFechaDDMMYYYY(hoy),
    Nombre: nombre || 'VidaVitalQR',
    SubNiveles: 'N',
    CorreoElectronico: correo,
    Token: token,
  });

  const url = ASMX_BASE + '?' + params.toString();

  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/xml,application/xml,*/*',
      },
    });
  } catch (err) {
    throw new Error('No se pudo contactar al servicio viejo del BCCR: ' + err.message);
  }
  if (!resp.ok) {
    let cuerpo = '';
    try { cuerpo = (await resp.text()).slice(0, 300); } catch (e) { /* sin cuerpo legible */ }
    throw new Error('El servicio viejo del BCCR respondió con estado ' + resp.status + (cuerpo ? ' — cuerpo: ' + cuerpo : ''));
  }

  const xml = await resp.text();

  const valores = [];
  const regex = /<NUM_VALOR>([-\d.]+)<\/NUM_VALOR>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const v = parseFloat(m[1]);
    if (!isNaN(v)) valores.push(v);
  }

  if (!valores.length) {
    throw new Error(
      'El servicio viejo del BCCR no devolvió ningún valor para el indicador ' + INDICADOR_VENTA +
      ' en los últimos ' + DIAS_RANGO_CONSULTA + ' días (respuesta cruda: ' + xml.slice(0, 300) + ')'
    );
  }

  return valores[valores.length - 1];
}

// ==== Función pública: intenta la API nueva primero, y si falla, cae al servicio viejo =====

async function obtenerTipoCambioVentaOficial({ apiToken, correo, token, nombre }) {
  const errores = [];

  if (apiToken) {
    try {
      return await obtenerTipoCambioVentaAPINueva({ apiToken });
    } catch (err) {
      errores.push('API nueva (SDDE): ' + err.message);
    }
  } else {
    errores.push('API nueva (SDDE): no configurada (falta BCCR_API_TOKEN).');
  }

  if (correo && token) {
    try {
      return await obtenerTipoCambioVentaServicioViejo({ correo, token, nombre });
    } catch (err) {
      errores.push('Servicio viejo (ASMX): ' + err.message);
    }
  } else {
    errores.push('Servicio viejo (ASMX): no configurado (falta BCCR_CORREO / BCCR_TOKEN).');
  }

  throw new Error('No se pudo obtener el tipo de cambio del BCCR por ningún método. ' + errores.join(' | '));
}

module.exports = {
  obtenerTipoCambioVentaOficial,
  obtenerTipoCambioVentaAPINueva,
  obtenerTipoCambioVentaServicioViejo,
  formatearFechaCR: formatearFechaDDMMYYYY,
  INDICADOR_VENTA,
};
