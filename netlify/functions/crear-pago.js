// ---- crear-pago.js ----
// Crea una Checkout Session alojada por ONVO Pay para el pago de la renovación anual de una
// ficha (persona / mascota / objeto) y devuelve la URL a la que hay que redirigir al cliente.
//
// Primera fase de la integración real con ONVO Pay (2026-09-15): solo cubre renovaciones
// anuales. Los productos físicos (placas, pulsera, cadena, Identificador QR) siguen usando el
// mockup de checkout de index.html sin cambios, por ahora.
//
// Requiere la variable de entorno ONVO_SECRET_KEY configurada en Netlify (Project configuration
// → Environment variables) — la llave secreta de ONVO Pay nunca debe escribirse en este archivo
// ni en ningún otro que se suba al repositorio.

const ONVO_API_BASE = 'https://api.onvopay.com/v1';

const RENOVACION = {
  persona: { label: 'Renovación anual VidaVitalQR — Persona' },
  mascota: { label: 'Renovación anual VidaVitalQR — Mascota' },
  objeto: { label: 'Renovación anual VidaVitalQR — Objeto' },
};

const PRECIO_RENOVACION_USD = 7.0; // antes de IVA, igual al mockup de index.html
const IVA_RATE = 0.13;

function sitioBase() {
  // Netlify define automáticamente la variable de entorno URL con el dominio del sitio
  // publicado; se deja vidavitalqr.com como respaldo por si no estuviera disponible.
  return process.env.URL || 'https://vidavitalqr.com';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido.' }) };
  }

  const secretKey = process.env.ONVO_SECRET_KEY;
  if (!secretKey) {
    console.error('crear-pago: falta la variable de entorno ONVO_SECRET_KEY en Netlify.');
    return { statusCode: 500, body: JSON.stringify({ error: 'El pago en línea no está configurado todavía. Intente más tarde.' }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Datos inválidos.' }) };
  }

  const tipo = String(data.tipo || '').trim();
  const folio = String(data.folio || '').trim();
  const email = String(data.email || '').trim();
  const nombre = String(data.nombre || '').trim();

  if (!tipoRenovacionValido(tipo)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Tipo de renovación no reconocido.' }) };
  }
  if (!folio) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta el folio de la ficha.' }) };
  }
  if (!email || email.indexOf('@') === -1) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Correo electrónico inválido.' }) };
  }

  const subtotal = PRECIO_RENOVACION_USD;
  const iva = subtotal * IVA_RATE;
  const totalCentavos = Math.round((subtotal + iva) * 100); // USD: la unidad más pequeña es el centavo

  const base = sitioBase();
  const successUrl = base + '/index.html?pago=exitoso&folio=' + encodeURIComponent(folio);
  const cancelUrl = base + '/index.html?pago=cancelado&folio=' + encodeURIComponent(folio);

  const bodyReq = {
    customerName: nombre || 'Cliente VidaVitalQR',
    customerEmail: email,
    redirectUrl: successUrl,
    cancelUrl,
    captureMethod: 'automatic',
    lineItems: [
      {
        quantity: 1,
        unitAmount: totalCentavos,
        currency: 'USD',
        description: RENOVACION[tipo].label + ' (incluye IVA 13%)',
        priceType: 'one_time',
      },
    ],
    metadata: {
      folio,
      tipo,
      origen: 'vidavitalqr-renovacion',
    },
  };

  try {
    const resp = await fetch(ONVO_API_BASE + '/checkout/sessions/one-time-link', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secretKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyReq),
    });

    let json = null;
    try { json = await resp.json(); } catch (e) { /* respuesta sin JSON */ }

    if (!resp.ok || !json || !json.url) {
      console.error('crear-pago: ONVO Pay rechazó la creación del checkout —', resp.status, JSON.stringify(json));
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'No se pudo crear el pago con ONVO Pay.' }),
      };
    }

    console.log('crear-pago: sesión de checkout creada para folio', folio, '(tipo', tipo + ') —', json.id);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: json.url, id: json.id }),
    };
  } catch (err) {
    console.error('crear-pago: error al contactar a ONVO Pay —', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo contactar a ONVO Pay.' }) };
  }
};

function tipoRenovacionValido(tipo) {
  return Object.prototype.hasOwnProperty.call(RENOVACION, tipo);
}
