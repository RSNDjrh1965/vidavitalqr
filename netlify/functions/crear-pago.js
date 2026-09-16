// ---- crear-pago.js ----
// Crea una Checkout Session alojada por ONVO Pay para el pago de uno o varios productos
// VidaVitalQR (renovaciones anuales y/o presentaciones físicas/digitales: placa, pulsera,
// cadena, Identificador QR, código QR solo digital) y devuelve la URL a la que hay que
// redirigir al cliente.
//
// Segunda fase de la integración real con ONVO Pay (2026-09-15): se extiende el pago real de
// "solo renovaciones" a TODOS los productos del recuadro de pago de index.html. El listado de
// productos y precios de abajo (PRECIOS) debe mantenerse igual al objeto ITEMS del <script> de
// index.html — si se cambia un precio en un lado, hay que cambiarlo también en el otro.
//
// Requiere la variable de entorno ONVO_SECRET_KEY configurada en Netlify (Project configuration
// → Environment variables) — la llave secreta de ONVO Pay nunca debe escribirse en este archivo
// ni en ningún otro que se suba al repositorio.

const ONVO_API_BASE = 'https://api.onvopay.com/v1';

// ---- catálogo de productos: se recalcula el precio aquí SIEMPRE con estos valores, nunca con
// lo que mande el navegador, para que nadie pueda manipular el monto a pagar desde el cliente ----
const PRECIOS = {
  renewal:          { label: 'Renovación anual VidaVitalQR — Persona', price: 7.00, tipo: 'persona', renovacion: true },
  renewal_mascota:  { label: 'Renovación anual VidaVitalQR — Mascota', price: 7.00, tipo: 'mascota', renovacion: true },
  renewal_objeto:   { label: 'Renovación anual VidaVitalQR — Objeto',  price: 7.00, tipo: 'objeto',  renovacion: true },
  qr_only_personal: { label: 'Código QR (solo digital) — Personal',    price: 7.00, tipo: 'persona', renovacion: false },
  qr_only_objeto:   { label: 'Código QR (solo digital) — Objeto',      price: 7.00, tipo: 'objeto',  renovacion: false },
  plate_personal:   { label: 'Placa con código QR — Personal',         price: 13.00, tipo: 'persona', renovacion: false },
  plate_mascota:    { label: 'Placa con código QR — Mascota',          price: 13.00, tipo: 'mascota', renovacion: false },
  plate_objeto:     { label: 'Placa con código QR — Objeto',           price: 13.00, tipo: 'objeto',  renovacion: false },
  bracelet:         { label: 'Pulsera con placa QR',                   price: 16.00, tipo: 'persona', renovacion: false },
  chain:            { label: 'Cadena con incrustación religiosa',      price: 19.00, tipo: 'persona', renovacion: false },
  idcard:           { label: 'Identificador QR',                      price: 12.00, tipo: 'persona', renovacion: false },
};

const IVA_RATE = 0.13;
const MAX_ITEMS_POR_PEDIDO = 20; // límite defensivo, muy por encima de lo que ofrece la página

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

  const email = String(data.email || '').trim();
  const nombre = String(data.nombre || '').trim();
  const itemsRecibidos = Array.isArray(data.items) ? data.items : null;

  if (!email || email.indexOf('@') === -1) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Correo electrónico inválido.' }) };
  }
  if (!itemsRecibidos || itemsRecibidos.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'El carrito está vacío.' }) };
  }
  if (itemsRecibidos.length > MAX_ITEMS_POR_PEDIDO) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Demasiados productos en un solo pedido.' }) };
  }

  // ---- validar cada producto contra el catálogo (PRECIOS) y, si es una renovación, exigir el
  // folio de la ficha que se está renovando — nunca se confía en el precio ni la etiqueta que
  // venga del navegador, solo en el identificador del producto ----
  const items = [];
  for (let i = 0; i < itemsRecibidos.length; i++) {
    const entrada = itemsRecibidos[i] || {};
    const itemId = String(entrada.item || '').trim();
    const catalogo = PRECIOS[itemId];
    if (!catalogo) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Producto no reconocido: ' + itemId }) };
    }
    let folio = '';
    if (catalogo.renovacion) {
      folio = String(entrada.folio || '').trim();
      if (!folio) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Falta el folio de la ficha para: ' + catalogo.label }) };
      }
    }
    items.push({ itemId, folio, label: catalogo.label, price: catalogo.price, tipo: catalogo.tipo, renovacion: catalogo.renovacion });
  }

  const subtotal = items.reduce((sum, it) => sum + it.price, 0);
  const iva = subtotal * IVA_RATE;
  const totalCentavos = Math.round((subtotal + iva) * 100); // USD: la unidad más pequeña es el centavo

  // ---- una sola línea de pago con el total ya calculado (subtotal + IVA una sola vez), para que
  // el monto cobrado por ONVO coincida exactamente con el que se le mostró al cliente en la
  // página — el desglose de qué se compró va en la descripción y en metadata, no en líneas
  // separadas (evita diferencias de centavos por redondeo si se combinan varios productos) ----
  const descripcion = items.map((it) => it.label).join(' + ');
  const folios = items.filter((it) => it.folio).map((it) => it.folio);

  const base = sitioBase();
  const folioQuery = folios.length ? '&folio=' + encodeURIComponent(folios.join(',')) : '';
  const successUrl = base + '/index.html?pago=exitoso' + folioQuery;
  const cancelUrl = base + '/index.html?pago=cancelado' + folioQuery;

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
        description: descripcion + ' (incluye IVA 13%)',
        priceType: 'one_time',
      },
    ],
    metadata: {
      items: JSON.stringify(items.map((it) => ({ item: it.itemId, folio: it.folio, tipo: it.tipo }))),
      folios: folios.join(','),
      origen: 'vidavitalqr-carrito',
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

    console.log('crear-pago: sesión de checkout creada —', items.length, 'producto(s), folios:', folios.join(',') || '(ninguno)', '—', json.id);

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
