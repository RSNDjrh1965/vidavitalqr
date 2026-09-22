// ---- Netlify Function: procesa cada ficha enviada desde el landing page ----
// Recibe (POST, JSON): { folio, filename, pdfBase64, nombreCompleto, tipo, fotoBase64 }
//
// Hace, en orden:
//  1) Sube el PDF de la ficha al bucket S3 "vidavitalqr".
//  2) Si vino foto, la sube también al bucket "vidavitalqr" (carpeta fotos/).
//  3) Genera un código QR (SVG) que apunta a la URL del PDF, con "VIDAVITALQR" en el centro
//     y el folio debajo, y lo sube al bucket S3 de códigos QR.
//  4) Agrega una fila a la tabla "resumen.csv" dentro del bucket de resumen, con las columnas:
//     contador, nombre completo, url del objeto, fotografía, código QR.
//  5) Envía el correo con el PDF adjunto (igual que antes), usando Resend.
//
// Todas las credenciales (Resend y AWS) se leen de variables de entorno de Netlify —
// nunca quedan escritas en este archivo.
//
// IMPORTANTE sobre nombres de variables de entorno de AWS:
// Netlify NO permite usar los nombres AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION
// (son reservados por el propio entorno de ejecución). Por eso aquí se usan nombres propios:
// S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION.

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { buildQrSvg } = require('./lib/qr-svg');
const { actualizarResumenXlsx } = require('./lib/xlsx-resumen');
const { generarPin, hashPin } = require('./lib/pin');

const DESTINATARIO = 'vidavitalqr@zohomail.com';
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';

// Nombres de los buckets (se pueden sobreescribir con variables de entorno si algún día cambian).
const BUCKET_FICHAS = process.env.S3_BUCKET_FICHAS || 'vidavitalqr';
const BUCKET_QR = process.env.S3_BUCKET_QR || 'vidavitalqr-qr';
const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const RESUMEN_KEY = 'resumen.xlsx';

function getS3Client() {
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Faltan configurar S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en Netlify.');
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

function publicUrlFor(bucket, region, key) {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
}

function base64PayloadOf(dataUrlOrBase64) {
  if (!dataUrlOrBase64) return null;
  return dataUrlOrBase64.includes(',') ? dataUrlOrBase64.split(',')[1] : dataUrlOrBase64;
}

function contentTypeFromDataUrl(dataUrl, fallback) {
  const m = /^data:([^;]+);base64,/.exec(dataUrl || '');
  return m ? m[1] : fallback;
}

// URL pública del "visor" que se abre al escanear el código QR (en vez de abrir el PDF
// directamente). Esa página es la que dispara el aviso por correo a los contactos de
// emergencia y la que muestra el botón de idioma. Se puede sobreescribir con una variable de
// entorno si el dominio cambia.
const SITE_URL = process.env.SITE_URL || 'https://vidavitalqr.com';

function urlDelVisor(folio) {
  return `${SITE_URL}/.netlify/functions/ver?folio=${encodeURIComponent(folio)}`;
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

// ---- carpeta de organización dentro de cada bucket, según el tipo de ficha ----
// El folio mismo ya distingue el tipo sin ambigüedad — el de persona siempre empieza con
// "VVITALQR" y el de mascota con "VVMASCOTA" (son prefijos distintos, con contadores
// independientes) — así que se usa el folio como fuente de verdad, y el campo "tipo" que manda
// el formulario solo como respaldo para el caso raro de que todavía no exista folio.
// Esto también es lo que permite que ver.js (la página que abre el código QR) sepa en qué
// carpeta buscar sin tener que adivinar ni revisar las dos.
//
// Solo afecta a lo que se guarda de aquí en adelante — lo ya guardado antes de este cambio
// permanece en su ubicación anterior (sin carpeta) y se sigue pudiendo leer con normalidad
// (login-ficha.js, recuperar-ficha.js y ver.js revisan ahí como respaldo si no encuentran el
// dato en la carpeta nueva). Así cada ficha que se crea o se renueva a partir de ahora queda
// ordenada, sin necesidad de mover de golpe todo lo que ya existía.
function carpetaTipo(tipo, folio) {
  const f = String(folio || '').toUpperCase();
  if (f.startsWith('VVMASCOTA')) return 'mascotas';
  if (f.startsWith('VVOBJETO')) return 'objetos';
  if (f.startsWith('VVITALQR')) return 'personas';
  if (tipo === 'Mascota') return 'mascotas';
  if (tipo === 'Objeto') return 'objetos';
  return 'personas';
}

// ---- crea o actualiza el "registro de acceso" (folio + PIN) que permite entrar al panel de
// edición sin volver a llenar el formulario completo ----
// Se guarda en el bucket de resumen (BUCKET_RESUMEN), que nunca se expone como URL pública —
// a diferencia de BUCKET_FICHAS, donde el PDF/foto/QR sí son públicos a propósito. Para poder
// recuperar el acceso de un usuario que perdió su PIN (por ejemplo, si escribe por WhatsApp), el
// PIN también se guarda en texto plano aquí (además de su hash, que es lo que se usa para
// validar el ingreso) — nunca se expone en una URL pública, así que esto no reduce la seguridad
// de cara al público. Si la ficha ya tenía un PIN guardado en texto plano, se conserva el mismo
// — nunca se cambia solo, para no dejar al usuario sin acceso. Si el registro es de una versión
// anterior que solo guardaba el hash (sin el texto plano), se genera un PIN nuevo esta vez, para
// que a partir de ahora también quede recuperable.
async function cargarOCrearLogin(s3, folio, datosFormulario, carpeta, resetCreado) {
  const key = `${carpeta}/login/${folio}.json`;
  const keyLegacy = `login/${folio}.json`;
  let registro = null;
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: key }));
    const texto = await streamToString(resp.Body);
    registro = JSON.parse(texto);
  } catch (err) {
    const noExiste = err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
    if (!noExiste) throw err;
    // todavía no se ha tocado esta ficha desde que existe la organización por carpetas —
    // se busca en la ubicación anterior para conservar su PIN y sus datos ya guardados
    try {
      const respLegacy = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: keyLegacy }));
      const textoLegacy = await streamToString(respLegacy.Body);
      registro = JSON.parse(textoLegacy);
    } catch (err2) {
      const noExisteLegacy = err2.name === 'NoSuchKey' || err2.Code === 'NoSuchKey' || err2.$metadata?.httpStatusCode === 404;
      if (!noExisteLegacy) throw err2;
    }
  }

  // Se trata como "nuevo" tanto si no existía registro como si existía pero de una versión
  // anterior que no guardaba el PIN en texto plano (solo el hash) — en ambos casos hay que
  // generar (o regenerar) un PIN y mostrárselo al usuario en el modal.
  const esNuevo = !registro || !registro.pin;
  const pin = esNuevo ? generarPin() : registro.pin;
  const nuevoRegistro = {
    folio,
    pin,
    pinHash: esNuevo ? hashPin(pin) : registro.pinHash,
    datosFormulario: datosFormulario && typeof datosFormulario === 'object' ? datosFormulario : {},
    // "creado" marca el inicio de la vigencia anual (12 meses). Se conserva tal cual en una
    // actualización normal de datos; solo se reinicia a "ahora" cuando el envío viene marcado
    // explícitamente como una renovación pagada (resetCreado === true) — así vuelve a contar
    // los 12 meses desde ese pago.
    creado: resetCreado ? new Date().toISOString() : ((registro && registro.creado) ? registro.creado : new Date().toISOString()),
    actualizado: new Date().toISOString(),
  };

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_RESUMEN,
    Key: key,
    Body: Buffer.from(JSON.stringify(nuevoRegistro), 'utf-8'),
    ContentType: 'application/json',
  }));

  // "pin" siempre viene relleno (con el PIN actual, nuevo o ya existente) — se usa tanto para
  // mostrarlo en el modal (solo cuando esNuevo) como para registrarlo en la columna "PIN" de
  // resumen.xlsx (siempre, para que James pueda recuperarlo si el usuario escribe por WhatsApp).
  return { esNuevo, pin };
}

// ---- envía el código de acceso (folio + PIN) por correo a TODOS los contactos de emergencia
// que tengan un correo registrado (contacto 1 y, si también tiene correo, contacto 2), cada vez
// que se crea o actualiza una ficha — así cualquiera de los dos contactos siempre tiene a mano el
// código vigente para poder actualizar la ficha en el futuro, sin depender de que la persona
// titular lo guarde por su cuenta. No bloquea ni interrumpe el resto del guardado si falla (por
// ejemplo, si no hay RESEND_API_KEY configurado).
// Nota: este correo lleva solo el folio y el PIN — el código QR nunca se envía por correo, solo
// se muestra en pantalla al momento de generar o renovar la ficha (a petición explícita del
// usuario, 2026-09-11).
// Devuelve { intentados, fallidos: [{email, status, detalle}] } para que quien la llama pueda
// registrar/avisar si Resend rechazó el envío a algún contacto (antes esto se perdía en
// silencio: un fetch() que responde con un error HTTP —por ejemplo 403 "dominio no
// verificado" o "solo se puede enviar a tu propio correo mientras el dominio no esté
// verificado"— NO hace que la promesa de fetch() se rechace, así que el .catch() de antes
// nunca se disparaba y el problema quedaba invisible, tanto para quien revisa los logs de
// Netlify como en el correo de aviso al administrador).
// ---- textos del correo de código de acceso en los 4 idiomas del sitio (ES/EN/FR/PT) — el
// idioma se elige por lo que la persona tenía seleccionado en el formulario al momento de
// enviarlo (ver punto 54 de la bitácora); si no se reconoce, cae a español. ----
const TEXTOS_CODIGO_CORREO = {
  es: {
    asunto: (deQuien, folio) => `Código de acceso a la ficha VidaVitalQR${deQuien} — ${folio}`,
    intro: (deQuien, folio) => `Este es el código de acceso vigente para la ficha${deQuien} en VidaVitalQR (folio ${folio}):`,
    folioLbl: 'Folio', pinLbl: 'PIN de acceso',
    explicacion: 'Este código es necesario para poder actualizar la ficha en el futuro (por ejemplo, para renovarla o corregir algún dato). Guárdalo en un lugar seguro — nunca queda visible en ninguna página pública del sitio.',
    motivo: 'Recibes este correo porque quedaste registrado(a) como contacto de emergencia de esta ficha. Este mensaje se envía automáticamente cada vez que la ficha se crea o se actualiza, para que siempre tengas a la mano el código más reciente.',
    firma: 'Este es un correo automático de VidaVitalQR.',
  },
  en: {
    asunto: (deQuien, folio) => `Access code for the VidaVitalQR record${deQuien} — ${folio}`,
    intro: (deQuien, folio) => `This is the current access code for the record${deQuien} in VidaVitalQR (folio ${folio}):`,
    folioLbl: 'Folio', pinLbl: 'Access PIN',
    explicacion: 'This code is needed to update the record in the future (for example, to renew it or fix a detail). Keep it somewhere safe — it never appears on any public page of the site.',
    motivo: 'You are receiving this email because you are registered as an emergency contact for this record. This message is sent automatically every time the record is created or updated, so you always have the latest code on hand.',
    firma: 'This is an automated email from VidaVitalQR.',
  },
  fr: {
    asunto: (deQuien, folio) => `Code d'accès à la fiche VidaVitalQR${deQuien} — ${folio}`,
    intro: (deQuien, folio) => `Voici le code d'accès actuel pour la fiche${deQuien} sur VidaVitalQR (numéro de dossier ${folio}) :`,
    folioLbl: 'Numéro de dossier', pinLbl: "Code PIN d'accès",
    explicacion: "Ce code est nécessaire pour pouvoir mettre à jour la fiche à l'avenir (par exemple pour la renouveler ou corriger une donnée). Gardez-le en lieu sûr — il n'apparaît jamais sur aucune page publique du site.",
    motivo: "Vous recevez cet e-mail car vous êtes enregistré(e) comme contact d'urgence de cette fiche. Ce message est envoyé automatiquement chaque fois que la fiche est créée ou mise à jour, afin que vous ayez toujours le code le plus récent à portée de main.",
    firma: "Ceci est un e-mail automatique de VidaVitalQR.",
  },
  pt: {
    asunto: (deQuien, folio) => `Código de acesso à ficha VidaVitalQR${deQuien} — ${folio}`,
    intro: (deQuien, folio) => `Este é o código de acesso vigente para a ficha${deQuien} no VidaVitalQR (folio ${folio}):`,
    folioLbl: 'Folio', pinLbl: 'PIN de acesso',
    explicacion: 'Este código é necessário para poder atualizar a ficha no futuro (por exemplo, para renová-la ou corrigir algum dado). Guarde-o em um lugar seguro — ele nunca aparece em nenhuma página pública do site.',
    motivo: 'Você está recebendo este e-mail porque ficou registrado(a) como contato de emergência desta ficha. Esta mensagem é enviada automaticamente sempre que a ficha é criada ou atualizada, para que você sempre tenha o código mais recente à mão.',
    firma: 'Este é um e-mail automático do VidaVitalQR.',
  },
};

async function enviarCodigoPorCorreo(contactos, { folio, pin, nombreCompleto, tipo, idioma }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !folio || !pin) return { intentados: 0, fallidos: [] };

  const correos = Array.from(new Set(
    (Array.isArray(contactos) ? contactos : [])
      .map((c) => (c && c.email ? String(c.email).trim() : ''))
      .filter(Boolean)
  ));
  if (correos.length === 0) return { intentados: 0, fallidos: [] };

  const t = TEXTOS_CODIGO_CORREO[idioma] || TEXTOS_CODIGO_CORREO.es;
  const deQuien = nombreCompleto ? ` de "${nombreCompleto}"` : '';
  const asunto = t.asunto(deQuien, folio);

  const cuerpo = [
    t.intro(deQuien, folio),
    '',
    `${t.folioLbl}: ${folio}`,
    `${t.pinLbl}: ${pin}`,
    '',
    t.explicacion,
    '',
    t.motivo,
    '',
    t.firma,
  ].join('\n');

  const fallidos = [];

  const envios = correos.map((email) =>
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: REMITENTE, to: [email], subject: asunto, text: cuerpo }),
    })
      .then(async (resp) => {
        if (!resp.ok) {
          let detalle = '';
          try { detalle = JSON.stringify(await resp.json()); } catch (e) { try { detalle = await resp.text(); } catch (e2) {} }
          console.error('Resend rechazó el código de acceso para', email, '— status', resp.status, detalle);
          fallidos.push({ email, status: resp.status, detalle });
        }
      })
      .catch((err) => {
        console.error('No se pudo enviar el código a', email, err);
        fallidos.push({ email, status: null, detalle: String(err && err.message ? err.message : err) });
      })
  );

  await Promise.allSettled(envios);
  return { intentados: correos.length, fallidos };
}

async function subirABuckets(s3, region, { folio, filename, pdfBase64, fotoBase64, tarjetaBase64, placaEstilo, nombreCompleto, tipo, contactos, datosVisor, idioma }) {
  const region_ = region;
  const carpeta = carpetaTipo(tipo, folio);

  // 1) PDF de la ficha — ahora dentro de personas/ o mascotas/, según corresponda.
  const pdfKey = `${carpeta}/${filename}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_FICHAS,
    Key: pdfKey,
    Body: Buffer.from(base64PayloadOf(pdfBase64), 'base64'),
    ContentType: 'application/pdf',
  }));
  const pdfUrl = publicUrlFor(BUCKET_FICHAS, region_, pdfKey);

  // 2) Foto (opcional). Si esta actualización no trae una foto nueva (por ejemplo, una
  // renovación donde el usuario no volvió a adjuntarla), se conserva la URL de la foto que ya
  // tenía guardada, en vez de borrarla del visor público.
  let fotoUrl = '';
  if (fotoBase64) {
    const ext = (contentTypeFromDataUrl(fotoBase64, 'image/jpeg').split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const fotoKey = `${carpeta}/fotos/${folio}.${ext}`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_FICHAS,
      Key: fotoKey,
      Body: Buffer.from(base64PayloadOf(fotoBase64), 'base64'),
      ContentType: contentTypeFromDataUrl(fotoBase64, 'image/jpeg'),
    }));
    fotoUrl = publicUrlFor(BUCKET_FICHAS, region_, fotoKey);
  } else {
    // busca la foto anterior primero en la carpeta nueva y, si esta ficha todavía no se había
    // tocado desde que existe la organización por carpetas, en la ubicación antigua (sin carpeta)
    let datosAnteriores = null;
    try {
      const anterior = await s3.send(new GetObjectCommand({ Bucket: BUCKET_FICHAS, Key: `${carpeta}/datos/${folio}.json` }));
      datosAnteriores = JSON.parse(await streamToString(anterior.Body));
    } catch (err) {
      try {
        const anteriorLegacy = await s3.send(new GetObjectCommand({ Bucket: BUCKET_FICHAS, Key: `datos/${folio}.json` }));
        datosAnteriores = JSON.parse(await streamToString(anteriorLegacy.Body));
      } catch (err2) {
        // sin foto anterior que conservar (ficha nueva, o nunca tuvo foto) — no es un error
      }
    }
    if (datosAnteriores && datosAnteriores.fotoUrl) fotoUrl = datosAnteriores.fotoUrl;
  }

  // 2.5) Tarjeta "Identificador QR" (foto + código QR real + identificador), generada en el
  // propio navegador al guardar la ficha (en ficha.html, función generateTarjetaBlob). Solo
  // aplica a fichas de PERSONA — las de mascota u objeto no envían este campo, así que aquí
  // nunca se sube nada para ellas. Si por algún motivo no llegó (por ejemplo, si el navegador
  // del usuario no pudo generarla), simplemente se omite este paso sin afectar el resto del
  // guardado.
  let tarjetaUrl = '';
  if (tarjetaBase64 && carpeta === 'personas') {
    const tarjetaKey = `${carpeta}/identificador-qr/${folio}.jpg`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_FICHAS,
      Key: tarjetaKey,
      Body: Buffer.from(base64PayloadOf(tarjetaBase64), 'base64'),
      ContentType: 'image/jpeg',
    }));
    tarjetaUrl = publicUrlFor(BUCKET_FICHAS, region_, tarjetaKey);
  }

  // 3) Datos estructurados para el visor público (lo que se muestra y traduce cuando alguien
  // escanea el código) y para saber a quién avisar. Se guarda como JSON, separado del PDF, para
  // no tener que volver a interpretar el PDF cada vez que alguien escanea.
  const datosKey = `${carpeta}/datos/${folio}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_FICHAS,
    Key: datosKey,
    Body: Buffer.from(JSON.stringify({
      folio,
      nombreCompleto: nombreCompleto || '',
      tipo: tipo || 'Persona',
      pdfUrl,
      fotoUrl,
      tarjetaUrl,
      placaEstilo: placaEstilo || '',
      contactos: Array.isArray(contactos) ? contactos : [],
      datosVisor: datosVisor && typeof datosVisor === 'object' ? datosVisor : {},
      // idioma elegido al llenar/renovar la ficha (ES/EN/FR/PT) — lo lee avisar-escaneo.js para
      // enviar el aviso de escaneo en el mismo idioma que usó quien registró la ficha
      idioma: idioma || 'es',
      actualizado: new Date().toISOString(),
    }), 'utf-8'),
    ContentType: 'application/json',
  }));

  // 4) Código QR — apunta al visor público (no directamente al PDF), para poder avisar a los
  // contactos cuando se escanee y para poder mostrar el botón de idioma.
  const qrSvg = await buildQrSvg(urlDelVisor(folio), folio);
  const qrKey = `${carpeta}/${folio}.svg`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_QR,
    Key: qrKey,
    Body: Buffer.from(qrSvg, 'utf-8'),
    ContentType: 'image/svg+xml',
  }));
  const qrUrl = publicUrlFor(BUCKET_QR, region_, qrKey);

  return { pdfUrl, fotoUrl, qrUrl, qrSvg, tarjetaUrl };
}

// ---- Nombre legible del estilo de "Placa con código QR" elegido en la página principal ----
// (código -> lo que se ve en el correo / resumen). Si llega un código que no se reconoce,
// se muestra tal cual llegó en vez de perder la información.
// ---- número (1-4, tal como se numeran en el landing, izquierda a derecha) y medidas de cada
// estilo de placa, para que el correo de aviso al administrador deje claro cuál de las 4 exactas
// eligió el comprador, sin tener que adivinarlo por el nombre del estilo ----
function etiquetaPlacaEstilo(codigo) {
  const nombres = {
    clasica: 'Placa 1 — Clásica (rectangular), 40 x 20 mm',
    llavero: 'Placa 2 — Llavero (con orificio), 40 x 22 mm',
    ranuras: 'Placa 3 — Con ranuras laterales, 45 x 25 mm',
    dije: 'Placa 4 — Dije / colgante (con argolla), 40 x 40 mm',
  };
  return nombres[codigo] || codigo;
}

// ---- fecha de hoy (zona horaria de Costa Rica), como objeto Date real ----
// Se construye a partir del año/mes/día calendario de Costa Rica (no de la hora UTC del
// servidor) y se fija al mediodía para evitar que un cambio de zona horaria la corra un día.
// Se necesita como Date real (no como texto ya formateado) para que Excel pueda calcular con
// ella la columna "Meses transcurridos" en xlsx-resumen.js.
function fechaInicioHoy() {
  try {
    const iso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' }); // 'YYYY-MM-DD'
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  } catch (err) {
    return new Date();
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Falta configurar RESEND_API_KEY en Netlify.' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  const { folio, filename, pdfBase64, nombreCompleto, tipo, fotoBase64, tarjetaBase64, placaEstilo, contactos, datosVisor, datosFormulario, esRenovacionPago } = payload;
  // ---- idioma elegido por quien llenó la ficha (ES/EN/FR/PT) — se guarda junto con la ficha
  // para que los correos automáticos que lleguen después (código de acceso aquí mismo, y el
  // aviso de escaneo en avisar-escaneo.js) puedan enviarse en ese mismo idioma. Solo se aceptan
  // los 4 códigos reales; cualquier otro valor (o su ausencia) cae a español por defecto —
  // nunca se confía ciegamente en lo que mande el navegador para construir texto del correo. ----
  const IDIOMAS_VALIDOS = ['es', 'en', 'fr', 'pt'];
  const idioma = IDIOMAS_VALIDOS.includes(payload.idioma) ? payload.idioma : 'es';

  if (!pdfBase64 || !filename) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Faltan datos: filename y pdfBase64 son obligatorios.' }),
    };
  }

  // ---- Paso 1: subir a S3 (PDF + foto + tarjeta Identificador QR + código QR), actualizar la
  // tabla resumen, y crear o actualizar el acceso con PIN para el panel de edición ----
  let pdfUrl = '', fotoUrl = '', qrUrl = '', qrSvg = '', tarjetaUrl = '';
  let s3Error = null;
  let pinNuevo = null;
  let codigoCorreoFallidos = [];
  const carpeta = carpetaTipo(tipo, folio);
  try {
    const region = process.env.S3_REGION || 'us-east-1';
    const s3 = getS3Client();
    const subido = await subirABuckets(s3, region, { folio, filename, pdfBase64, fotoBase64, tarjetaBase64, placaEstilo, nombreCompleto, tipo, contactos, datosVisor, idioma });
    pdfUrl = subido.pdfUrl; fotoUrl = subido.fotoUrl; qrUrl = subido.qrUrl; qrSvg = subido.qrSvg; tarjetaUrl = subido.tarjetaUrl;

    // El login (y su PIN) se resuelve ANTES de escribir el resumen, para poder incluir el PIN
    // vigente en la columna "PIN" de resumen.xlsx en el mismo guardado.
    let pinActual = '';
    if (folio) {
      const login = await cargarOCrearLogin(s3, folio, datosFormulario, carpeta, esRenovacionPago === true);
      pinActual = login.pin || '';
      if (login.esNuevo) pinNuevo = login.pin;
      // se envía en cada guardado (ficha nueva o actualización), no solo cuando el PIN es nuevo,
      // para que los contactos de emergencia siempre tengan a la mano el folio y el PIN vigentes
      // (el código QR no se envía por correo — solo se muestra en pantalla)
      const resultadoCodigo = await enviarCodigoPorCorreo(contactos, { folio, pin: pinActual, nombreCompleto, tipo, idioma });
      if (resultadoCodigo && resultadoCodigo.fallidos && resultadoCodigo.fallidos.length) {
        codigoCorreoFallidos = resultadoCodigo.fallidos;
      }
    }

    // resumen.xlsx separado por tipo (personas/resumen.xlsx y mascotas/resumen.xlsx), para
    // poder revisarlos por separado. El resumen.xlsx combinado que ya existía en la raíz del
    // bucket queda como respaldo histórico — deja de actualizarse a partir de este cambio.
    await actualizarResumenXlsx(s3, BUCKET_RESUMEN, `${carpeta}/${RESUMEN_KEY}`, {
      contador: folio || '',
      pin: pinActual,
      nombre: nombreCompleto || '',
      fecha: fechaInicioHoy(),
      pdfUrl,
      fotoBase64,
      qrUrl,
      // NOTA: este campo solo se verá como columna en la hoja de resumen si lib/xlsx-resumen.js
      // también se actualiza para leerlo y escribirlo (no forma parte de este cambio). Mientras
      // tanto, el estilo elegido igual queda visible en el correo de notificación y en
      // personas/datos/<folio>.json.
      placaEstiloTexto: placaEstilo ? etiquetaPlacaEstilo(placaEstilo) : '',
    });
  } catch (err) {
    // No bloqueamos el envío del correo si falla la parte de S3 — se reporta en la respuesta
    // para poder diagnosticarlo, pero la ficha igual llega por correo.
    s3Error = String(err && err.message ? err.message : err);
  }

  // ---- Paso 2: enviar el correo (igual que antes), con los enlaces de S3 si se generaron ----
  const base64Content = base64PayloadOf(pdfBase64);

  const tipoTexto = tipo === 'Mascota' ? 'ficha de mascota' : (tipo === 'Objeto' ? 'ficha de objeto' : 'ficha médica');
  const asunto = folio
    ? `Nueva ${tipoTexto} VidaVitalQR — ${folio}`
    : `Nueva ${tipoTexto} VidaVitalQR`;

  const lineasExtra = [];
  if (nombreCompleto) lineasExtra.push(`Nombre completo: ${nombreCompleto}`);
  if (pdfUrl) lineasExtra.push(`PDF en la nube: ${pdfUrl}`);
  if (fotoUrl) lineasExtra.push(`Fotografía: ${fotoUrl}`);
  if (qrUrl) lineasExtra.push(`Código QR: ${qrUrl}`);
  if (tarjetaUrl) lineasExtra.push(`Tarjeta Identificador QR: ${tarjetaUrl}`);
  if (placaEstilo) lineasExtra.push(`Estilo de placa elegido: ${etiquetaPlacaEstilo(placaEstilo)}`);
  if (s3Error) lineasExtra.push(`(Aviso: no se pudo subir a S3 / actualizar el resumen — ${s3Error})`);
  if (codigoCorreoFallidos.length) {
    lineasExtra.push('(Aviso: el correo con el folio y el PIN NO se pudo enviar a los siguientes contactos:');
    codigoCorreoFallidos.forEach((f) => {
      lineasExtra.push(`  - ${f.email}: ${f.status ? 'HTTP ' + f.status + ' — ' : ''}${f.detalle || 'sin detalle'}`);
    });
    lineasExtra.push('Si el detalle menciona el dominio o "domain is not verified", hay que verificar el dominio vidavitalqr.com en la cuenta de Resend.)');
  }

  const cuerpoTexto = [
    folio
      ? `Se generó y envió automáticamente la ${tipoTexto} de emergencia con número de identificación ${folio}.`
      : `Se generó y envió automáticamente una ${tipoTexto} de emergencia.`,
    ...lineasExtra,
    '',
    'Este correo fue generado automáticamente por el sistema de VidaVitalQR.',
  ].join('\n');

  try {
    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: REMITENTE,
        to: [DESTINATARIO],
        subject: asunto,
        text: cuerpoTexto,
        attachments: [
          {
            filename: filename,
            content: base64Content,
          },
        ],
      }),
    });

    const resultado = await resendResp.json();

    if (!resendResp.ok) {
      return {
        statusCode: resendResp.status,
        headers,
        body: JSON.stringify({ error: 'Resend rechazó el envío.', detalle: resultado, s3Error, pdfUrl, fotoUrl, qrUrl, tarjetaUrl, placaEstilo: placaEstilo || '', pin: pinNuevo }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, id: resultado.id, s3Error, pdfUrl, fotoUrl, qrUrl, tarjetaUrl, placaEstilo: placaEstilo || '', pin: pinNuevo }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Error al contactar a Resend.', detalle: String(err), s3Error, pdfUrl, fotoUrl, qrUrl, tarjetaUrl, placaEstilo: placaEstilo || '', pin: pinNuevo }),
    };
  }
};
