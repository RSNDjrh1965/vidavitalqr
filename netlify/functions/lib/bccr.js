// ---- lib/bccr.js ----
// Consulta el servicio web público de indicadores económicos del Banco Central de Costa Rica
// (BCCR) para obtener el tipo de cambio de referencia de VENTA del dólar (indicador 318 —
// 317 es el de compra). Se usa "venta" porque es el que le conviene a VidaVitalQR como
// referencia: es la tasa a la que el negocio necesitaría comprar dólares con los colones que
// reciba, así que protege el margen del negocio mejor que "compra".
//
// El servicio es de solo lectura y gratuito, pero exige registrarse (correo + token) en:
//   https://gee.bccr.fi.cr/indicadoreseconomicos/WebServices/frmServiciosWebHermes.aspx
// Documentación oficial (enlace de "Web Service"):
//   https://gee.bccr.fi.cr/indicadores/Documentos/WEBSERVICES%20DE%20INDICADORES%20ECONOMICOS.pdf
//
// El servicio expone un binding HTTP GET simple (además del SOAP completo) con querystring:
//   .../ObtenerIndicadoresEconomicos?Indicador=318&FechaInicio=dd/mm/yyyy&FechaFinal=dd/mm/yyyy
//   &Nombre=...&SubNiveles=N&CorreoElectronico=...&Token=...
// y devuelve XML con un nodo <INGC011_CAT_INDICADORECONOMIC> por cada fecha, cada uno con
// <DES_FECHA> y <NUM_VALOR>. Se consulta un rango de 7 días (no solo "hoy") porque el BCCR no
// publica dato los fines de semana ni los feriados, y se toma el valor más reciente del rango.
//
// 2026-09-23: se cambió de "ObtenerIndicadoresEconomicosXML" a "ObtenerIndicadoresEconomicos"
// (sin el sufijo "XML") porque el primero daba error 503 en todas las pruebas reales, mientras
// que este segundo nombre es el que se confirmó funcionando en un ejemplo real de integración.
// También se agregó un encabezado de navegador (User-Agent/Accept), por si el sitio del BCCR
// bloquea peticiones que no parecen venir de un navegador normal.

const BCCR_BASE = 'https://gee.bccr.fi.cr/Indicadores/Suscripciones/WS/wsindicadoreseconomicos.asmx/ObtenerIndicadoresEconomicos';
const INDICADOR_VENTA = 318;
const DIAS_RANGO_CONSULTA = 7;

function formatearFechaCR(fecha) {
  const dd = String(fecha.getDate()).padStart(2, '0');
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const yyyy = fecha.getFullYear();
  return dd + '/' + mm + '/' + yyyy;
}

// ---- consulta el tipo de cambio de venta oficial más reciente disponible en los últimos
// DIAS_RANGO_CONSULTA días. Lanza un Error con un mensaje claro si faltan credenciales, si el
// BCCR responde con error HTTP, o si no hay ningún valor en el rango consultado. ----
async function obtenerTipoCambioVentaOficial({ correo, token, nombre }) {
  if (!correo || !token) {
    throw new Error('Faltan el correo y/o el token de suscripción del BCCR.');
  }

  const hoy = new Date();
  const desde = new Date(hoy.getTime() - DIAS_RANGO_CONSULTA * 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    Indicador: String(INDICADOR_VENTA),
    FechaInicio: formatearFechaCR(desde),
    FechaFinal: formatearFechaCR(hoy),
    Nombre: nombre || 'VidaVitalQR',
    SubNiveles: 'N',
    CorreoElectronico: correo,
    Token: token,
  });

  const url = BCCR_BASE + '?' + params.toString();

  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        // ---- algunos sitios del gobierno bloquean peticiones sin apariencia de navegador ----
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/xml,application/xml,*/*',
      },
    });
  } catch (err) {
    throw new Error('No se pudo contactar al servicio del BCCR: ' + err.message);
  }
  if (!resp.ok) {
    // ---- se incluye un fragmento del cuerpo de la respuesta en el error, para poder diagnosticar
    // en los logs de Netlify si el BCCR está devolviendo una página de error/bloqueo en vez de un
    // simple estado HTTP vacío ----
    let cuerpo = '';
    try { cuerpo = (await resp.text()).slice(0, 300); } catch (e) { /* sin cuerpo legible */ }
    throw new Error('El servicio del BCCR respondió con estado ' + resp.status + (cuerpo ? ' — cuerpo: ' + cuerpo : ''));
  }

  const xml = await resp.text();

  // ---- si el correo/token son inválidos, el BCCR normalmente responde igual con estado 200 pero
  // sin nodos de valor (o con un mensaje de error dentro del XML) -- se detecta por la ausencia
  // de NUM_VALOR, en vez de asumir que un XML "válido" siempre trae datos ----
  const valores = [];
  const regex = /<NUM_VALOR>([-\d.]+)<\/NUM_VALOR>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const v = parseFloat(m[1]);
    if (!isNaN(v)) valores.push(v);
  }

  if (!valores.length) {
    throw new Error(
      'El BCCR no devolvió ningún valor para el indicador 318 en los últimos ' + DIAS_RANGO_CONSULTA +
      ' días. Verifique que BCCR_CORREO y BCCR_TOKEN sean correctos (respuesta cruda: ' +
      xml.slice(0, 300) + ')'
    );
  }

  // ---- el rango viene ordenado por fecha ascendente, así que el último valor es el más reciente ----
  return valores[valores.length - 1];
}

module.exports = { obtenerTipoCambioVentaOficial, formatearFechaCR, INDICADOR_VENTA };
