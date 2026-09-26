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
//
// ---- pago en colones (CRC), agregado 2026-09-23 ----
// El cliente puede pedir pagar en colones (campo "moneda": "CRC" en el body). El monto en CRC se
// recalcula aquí SIEMPRE desde el total en USD (nunca se confía en ningún monto que mande el
// navegador) usando el tipo de cambio guardado por netlify/functions/actualizar-tipo-cambio.js
// (tipo de cambio de venta del BCCR + 2% de margen, redondeado hacia arriba).
//
// Decisión confirmada por el usuario (2026-09-23): el monto en CRC se calcula SIEMPRE en colones
// enteros, sin decimales — se aproxima hacia arriba al entero más cercano, tanto el tipo de
// cambio (2% de margen, ver actualizar-tipo-cambio.js) como el total antes de mandarlo a ONVO Pay.
//
// **Primera prueba real (2026-09-23):** se probó primero con ONVO_CRC_SUBUNIT_MULTIPLIER=1 (es
// decir, mandando el total en colones tal cual, sin multiplicar) y ONVO Pay cobró de menos por un
// factor de 100 (mandamos 3647 y cobró "CRC 36.47" en vez de "CRC 3,647") — confirmando que ONVO
// Pay, igual que hace con USD (centavos), espera el monto en la subunidad más pequeña también
// para CRC (céntimos), no en colones enteros. Por eso el valor por defecto de
// ONVO_CRC_SUBUNIT_MULTIPLIER se dejó en 100 (no en 1) — se puede seguir ajustando por variable de
// entorno si hiciera falta, pero ya no depende de que alguien recuerde configurarla.
//
// Queda protegido por la variable de entorno HABILITAR_PAGO_CRC (debe valer exactamente "true").

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const ONVO_API_BASE = 'https://api.onvopay.com/v1';
const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const TIPO_CAMBIO_KEY = 'config/tipo-cambio.json';

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

// ---- lee el tipo de cambio (con margen) que guardó actualizar-tipo-cambio.js -- lanza si falta
// o si el valor guardado no es un número válido, para nunca cobrar con un tipo de cambio en 0 ----
async function obtenerTipoCambioGuardado() {
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Faltan las credenciales de S3 en Netlify.');
  }
  const s3 = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: TIPO_CAMBIO_KEY }));
  const json = JSON.parse(await streamToString(obj.Body));
  const tipoCambio = Number(json.tipoCambio);
  if (!tipoCambio || tipoCambio <= 0) throw new Error('El tipo de cambio guardado no es válido.');
  return tipoCambio;
}

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

// ---- costo de envío: cargo único de $8.50 cuando el carrito incluye al menos un producto
// físico, cubre hasta 5 productos físicos por dirección (van juntos en el mismo paquete) — nunca
// se cobra un envío aparte por cada producto físico agregado. Debe coincidir siempre con
// SHIPPING_COST/ITEMS_FISICOS de index.html — si se cambia un lado, hay que cambiar el otro. Se
// recalcula aquí siempre desde cero, nunca se confía en ningún monto de envío que mande el
// navegador. ----
const SHIPPING_COST = 8.50;
const ITEMS_FISICOS = ['plate_personal', 'plate_mascota', 'plate_objeto', 'bracelet', 'chain', 'idcard'];

// ---- estilos válidos de "Placa con código QR — Personal" (numerados 1-4 en el landing, ver
// bitácora punto 39) -- cualquier otro valor recibido del navegador se ignora, para que el aviso
// de pago al administrador siempre muestre un estilo real o ninguno, nunca texto inventado ----
const ESTILOS_PLACA_VALIDOS = ['clasica', 'llavero', 'ranuras', 'dije'];

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
    // ---- estilo de placa elegido (solo aplica a "plate_personal" -- ver bitácora punto 39):
    // se acepta únicamente si es uno de los 4 valores reales, para que el aviso de pago al
    // administrador siempre reporte cuál de las 4 placas hay que fabricar ----
    let placaEstilo = '';
    if (itemId === 'plate_personal') {
      const estiloRecibido = String(entrada.placaEstilo || '').trim();
      if (ESTILOS_PLACA_VALIDOS.indexOf(estiloRecibido) !== -1) { placaEstilo = estiloRecibido; }
    }
    items.push({ itemId, folio, placaEstilo, label: catalogo.label, price: catalogo.price, tipo: catalogo.tipo, renovacion: catalogo.renovacion });
  }

  // ---- costo de envío: se agrega una sola vez si el pedido incluye algún producto físico,
  // nunca por separado por cada uno (cubre hasta 5 productos físicos por dirección) ----
  const incluyeFisico = items.some((it) => ITEMS_FISICOS.indexOf(it.itemId) !== -1);
  const envio = incluyeFisico ? SHIPPING_COST : 0;

  const subtotalProductos = items.reduce((sum, it) => sum + it.price, 0);
  const subtotal = subtotalProductos + envio;
  const iva = subtotal * IVA_RATE;
  const totalUSD = subtotal + iva;

  // ---- moneda elegida por el cliente: "USD" (por defecto, como siempre) o "CRC" -- cualquier
  // otro valor recibido se ignora y se cobra en USD ----
  const monedaRecibida = String(data.moneda || 'USD').trim().toUpperCase();
  const moneda = monedaRecibida === 'CRC' ? 'CRC' : 'USD';

  if (moneda === 'CRC' && process.env.HABILITAR_PAGO_CRC !== 'true') {
    return { statusCode: 400, body: JSON.stringify({ error: 'El pago en colones todavía no está habilitado. Pague en dólares mientras tanto.' }) };
  }

  let currencyOnvo = 'USD';
  let unitAmount = Math.round(totalUSD * 100); // USD: la unidad más pequeña es el centavo
  let tipoCambioUsado = null;
  // ---- equivalente informativo en colones (agregado 2026-09-23): aunque el cliente pague en
  // dólares, se calcula igual (best-effort, nunca bloquea el pago si falla) para que el aviso de
  // pago al administrador (onvo-webhook.js) pueda mostrar "esto son tantos colones al tipo de
  // cambio de hoy" como referencia — es solo informativo, nunca cambia lo que realmente se cobra. ----
  let totalCRCInformativo = null;

  if (moneda === 'CRC') {
    try {
      tipoCambioUsado = await obtenerTipoCambioGuardado();
    } catch (err) {
      console.error('crear-pago: no se pudo obtener el tipo de cambio para CRC —', err.message);
      return {
        statusCode: 503,
        body: JSON.stringify({ error: 'El pago en colones no está disponible en este momento. Puede pagar en dólares, o intentarlo de nuevo más tarde.' }),
      };
    }
    // ---- decisión confirmada por el usuario: siempre colones ENTEROS, redondeando hacia ARRIBA
    // (nunca hacia el más cercano) -- así nunca se cobra de menos por un redondeo ----
    const totalCRC = Math.ceil(totalUSD * tipoCambioUsado);
    totalCRCInformativo = totalCRC;
    // ---- multiplicador de subunidad: 100 = céntimos (confirmado con una prueba real el
    // 2026-09-23 — ver la nota al inicio del archivo). El total en colones sigue siendo siempre
    // un entero (totalCRC); lo que cambia es que ONVO Pay espera ese entero expresado en céntimos. ----
    const subunitMultiplier = Number(process.env.ONVO_CRC_SUBUNIT_MULTIPLIER || '100');
    unitAmount = Math.ceil(totalCRC * subunitMultiplier);
    currencyOnvo = 'CRC';
  } else {
    // ---- pago en USD: se intenta obtener el tipo de cambio solo para mostrarlo en el correo de
    // aviso — si el BCCR/S3 fallara por cualquier motivo, no se bloquea el pago en dólares, solo se
    // omite ese dato informativo del correo (igual que cuando el pago en CRC todavía no está
    // disponible, pero aquí sin devolver ningún error al cliente) ----
    try {
      tipoCambioUsado = await obtenerTipoCambioGuardado();
      totalCRCInformativo = Math.ceil(totalUSD * tipoCambioUsado);
    } catch (err) {
      console.log('crear-pago: no se pudo obtener el tipo de cambio informativo para el aviso (pago sigue en USD) —', err.message);
    }
  }

  // ---- una sola línea de pago con el total ya calculado (subtotal + envío + IVA una sola vez),
  // para que el monto cobrado por ONVO coincida exactamente con el que se le mostró al cliente en
  // la página — el desglose de qué se compró va en la descripción y en metadata, no en líneas
  // separadas (evita diferencias de centavos por redondeo si se combinan varios productos) ----
  const descripcion = items.map((it) => it.label).join(' + ') + (envio > 0 ? ' + Envío' : '');
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
        unitAmount: unitAmount,
        currency: currencyOnvo,
        description: descripcion + ' (incluye IVA 13%)',
        priceType: 'one_time',
      },
    ],
    metadata: {
      items: JSON.stringify(items.map((it) => ({ item: it.itemId, folio: it.folio, tipo: it.tipo, placaEstilo: it.placaEstilo || undefined }))),
      moneda: currencyOnvo,
      tipoCambioUsado: tipoCambioUsado ? String(tipoCambioUsado) : '',
      totalCRCInformativo: totalCRCInformativo ? String(totalCRCInformativo) : '',
      totalUSD: totalUSD.toFixed(2),
      folios: folios.join(','),
      envio: envio > 0 ? envio.toFixed(2) : '',
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
