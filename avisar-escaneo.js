// ---- Netlify Function: envía el aviso de escaneo a los contactos de emergencia ----
// La llama, desde el navegador de quien escaneó, la página de `ver.js` — una vez que ese
// navegador ya resolvió el permiso de ubicación (lo aceptó o lo rechazó). Aplica igual para
// fichas de persona y de mascota.
//
// No se confía en el folio del cliente para nada más que buscar la ficha: los contactos, el
// nombre y el enlace al PDF siempre se vuelven a leer de S3 aquí, nunca se reciben del navegador.
//
// Ubicación que se incluye en el correo:
//  - Si el permiso fue concedido: la ubicación exacta (coordenadas) que envió el navegador.
//  - Si fue rechazado, no respondió a tiempo, o el navegador no soporta geolocalización: una
//    ubicación aproximada calculada a partir de la IP de la conexión, dejando explícito que es
//    aproximada y puede no ser exacta. Si ni siquiera eso se puede determinar, el correo se
//    envía igual, sin sección de ubicación.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET_FICHAS = process.env.S3_BUCKET_FICHAS || 'vidavitalqr';
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';

function getS3Client() {
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Faltan configurar S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en Netlify.');
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

// ---- fecha/hora legible en zona horaria de Costa Rica, para el correo de aviso — el idioma solo
// cambia el formato de fecha/hora (nombres de mes, orden, etc.), la hora sigue siendo siempre la
// de Costa Rica sin importar el idioma elegido ----
const LOCALES_FECHA_AVISO = { es: 'es-CR', en: 'en-US', fr: 'fr-FR', pt: 'pt-BR' };
function fechaHoraCR(idioma) {
  const locale = LOCALES_FECHA_AVISO[idioma] || LOCALES_FECHA_AVISO.es;
  try {
    return new Date().toLocaleString(locale, { timeZone: 'America/Costa_Rica', dateStyle: 'long', timeStyle: 'short' });
  } catch (err) {
    return new Date().toISOString();
  }
}

// ---- IP real de quien escaneó, a partir de los encabezados que reenvía Netlify ----
function obtenerIp(event) {
  const headers = event.headers || {};
  const directa = headers['x-nf-client-connection-ip'] || headers['client-ip'];
  if (directa) return directa.trim();
  const reenviada = headers['x-forwarded-for'];
  if (reenviada) return reenviada.split(',')[0].trim();
  return null;
}

// ---- ubicación aproximada a partir de la IP, usando un servicio gratuito sin llave de API ----
async function ubicacionPorIp(ip) {
  if (!ip) return null;
  try {
    const resp = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || data.success === false) return null;
    if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number') return null;
    return {
      lat: data.latitude,
      lng: data.longitude,
      etiqueta: [data.city, data.region, data.country].filter(Boolean).join(', '),
    };
  } catch (err) {
    console.error('No se pudo obtener ubicación aproximada por IP:', err);
    return null;
  }
}

function enlaceMapa(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

// ---- versión "acortada" del enlace al PDF que se muestra en el correo, para no exponer la URL
// completa del bucket de S3 (dominio + carpeta interna) — el enlace real (href) sigue siendo el
// completo, esto solo cambia lo que se ve escrito. Ej: https://vidavitalqr............/VVITALQR00000091.pdf
function urlAcortada(url) {
  try {
    const u = new URL(url);
    const archivo = u.pathname.split('/').filter(Boolean).pop() || '';
    return `https://vidavitalqr............/${archivo}`;
  } catch (err) {
    return url;
  }
}

function escaparHtml(texto) {
  return String(texto == null ? '' : texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- textos del aviso de escaneo en los 4 idiomas del sitio (ES/EN/FR/PT) — punto 54 de la
// bitácora. El idioma se toma de `datos.idioma`, guardado junto con la ficha por send-ficha.js
// (el idioma que la persona tenía seleccionado al llenar o renovar su ficha), nunca del
// navegador de quien escaneó, ya que ese navegador puede ser cualquier persona ajena. ----
const TEXTOS_AVISO_ESCANEO = {
  es: {
    asunto: (tipo, nombre) => (tipo === 'Mascota' || tipo === 'Objeto')
      ? `⚠️ Alguien escaneó el código QR de ${nombre}`
      : `⚠️ Alguien escaneó el código QR de emergencia de ${nombre}`,
    descTipo: (tipo) => tipo === 'Mascota' ? 'la mascota' : (tipo === 'Objeto' ? 'el objeto' : 'la ficha de emergencia de'),
    // "de" + descTipo ya contraído (del), para evitar "de el objeto" en vez de "del objeto".
    descTipoContraido: (tipo) => tipo === 'Objeto' ? 'del objeto' : `de ${TEXTOS_AVISO_ESCANEO.es.descTipo(tipo)}`,
    intro: (tipo, nombre, folio, fecha) => `El código QR ${TEXTOS_AVISO_ESCANEO.es.descTipoContraido(tipo)} "${nombre}" (folio ${folio}) fue escaneado el ${fecha} (hora de Costa Rica).`,
    explicacion: (tipo) => tipo === 'Objeto'
      ? 'Esto puede significar que el objeto fue encontrado por alguien.'
      : 'Esto puede significar que alguien está tratando de contactarlo(a) por una emergencia, o que la mascota fue encontrada.',
    notaFinal: 'Este es un aviso automático de VidaVitalQR. Si usted mismo(a) escaneó el código para probarlo, puede ignorar este mensaje.',
    ubicExacta: 'Ubicación compartida por quien escaneó el código',
    ubicExactaNota: '(Precisión según el dispositivo de quien escaneó — puede no ser exacta.)',
    ubicAprox: (detalle) => `Ubicación aproximada de quien escaneó el código${detalle}`,
    ubicAproxNota: '(Esta ubicación es aproximada, calculada a partir de la conexión a internet — no es exacta, y quien escaneó no compartió su ubicación real.)',
    aproxEnLbl: (etiqueta) => ` (aproximadamente en ${etiqueta})`,
    fichaLbl: 'Ficha completa',
    hola: 'Hola',
  },
  en: {
    asunto: (tipo, nombre) => (tipo === 'Mascota' || tipo === 'Objeto')
      ? `⚠️ Someone scanned the QR code of ${nombre}`
      : `⚠️ Someone scanned the emergency QR code of ${nombre}`,
    descTipo: (tipo) => tipo === 'Mascota' ? 'the pet' : (tipo === 'Objeto' ? 'the object' : 'the emergency profile of'),
    intro: (tipo, nombre, folio, fecha) => `The QR code of ${TEXTOS_AVISO_ESCANEO.en.descTipo(tipo)} "${nombre}" (folio ${folio}) was scanned on ${fecha} (Costa Rica time).`,
    explicacion: (tipo) => tipo === 'Objeto'
      ? 'This may mean the object was found by someone.'
      : 'This may mean someone is trying to contact you about an emergency, or that the pet was found.',
    notaFinal: 'This is an automatic notice from VidaVitalQR. If you scanned the code yourself to test it, you can ignore this message.',
    ubicExacta: 'Location shared by the person who scanned the code',
    ubicExactaNota: '(Accuracy depends on the scanning device — may not be exact.)',
    ubicAprox: (detalle) => `Approximate location of the person who scanned the code${detalle}`,
    ubicAproxNota: '(This location is approximate, calculated from the internet connection — it is not exact, and the person who scanned did not share their real location.)',
    aproxEnLbl: (etiqueta) => ` (approximately in ${etiqueta})`,
    fichaLbl: 'Full profile',
    hola: 'Hello',
  },
  fr: {
    asunto: (tipo, nombre) => (tipo === 'Mascota' || tipo === 'Objeto')
      ? `⚠️ Quelqu'un a scanné le code QR de ${nombre}`
      : `⚠️ Quelqu'un a scanné le code QR d'urgence de ${nombre}`,
    descTipo: (tipo) => tipo === 'Mascota' ? "l'animal" : (tipo === 'Objeto' ? "l'objet" : "la fiche d'urgence de"),
    intro: (tipo, nombre, folio, fecha) => `Le code QR de ${TEXTOS_AVISO_ESCANEO.fr.descTipo(tipo)} « ${nombre} » (dossier ${folio}) a été scanné le ${fecha} (heure du Costa Rica).`,
    explicacion: (tipo) => tipo === 'Objeto'
      ? "Cela peut signifier que l'objet a été trouvé par quelqu'un."
      : "Cela peut signifier que quelqu'un essaie de vous contacter pour une urgence, ou que l'animal a été retrouvé.",
    notaFinal: "Ceci est un avis automatique de VidaVitalQR. Si vous avez scanné le code vous-même pour le tester, vous pouvez ignorer ce message.",
    ubicExacta: 'Position partagée par la personne qui a scanné le code',
    ubicExactaNota: "(Précision selon l'appareil utilisé — peut ne pas être exacte.)",
    ubicAprox: (detalle) => `Position approximative de la personne qui a scanné le code${detalle}`,
    ubicAproxNota: "(Cette position est approximative, calculée à partir de la connexion internet — elle n'est pas exacte, et la personne n'a pas partagé sa position réelle.)",
    aproxEnLbl: (etiqueta) => ` (environ à ${etiqueta})`,
    fichaLbl: 'Fiche complète',
    hola: 'Bonjour',
  },
  pt: {
    asunto: (tipo, nombre) => (tipo === 'Mascota' || tipo === 'Objeto')
      ? `⚠️ Alguém escaneou o código QR de ${nombre}`
      : `⚠️ Alguém escaneou o código QR de emergência de ${nombre}`,
    descTipo: (tipo) => tipo === 'Mascota' ? 'o animal de estimação' : (tipo === 'Objeto' ? 'o objeto' : 'a ficha de emergência de'),
    // "de" + descTipo ya contraído (do/da), para evitar "de o"/"de a" — la ficha de emergencia
    // ("a ficha...") ya no necesita otra contracción porque no empieza justo después del "de".
    descTipoContraido: (tipo) => tipo === 'Mascota' ? 'do animal de estimação' : (tipo === 'Objeto' ? 'do objeto' : 'da ficha de emergência de'),
    intro: (tipo, nombre, folio, fecha) => `O código QR ${TEXTOS_AVISO_ESCANEO.pt.descTipoContraido(tipo)} "${nombre}" (protocolo ${folio}) foi escaneado em ${fecha} (horário da Costa Rica).`,
    explicacion: (tipo) => tipo === 'Objeto'
      ? 'Isso pode significar que o objeto foi encontrado por alguém.'
      : 'Isso pode significar que alguém está tentando contatá-lo(a) por uma emergência, ou que o animal foi encontrado.',
    notaFinal: 'Este é um aviso automático da VidaVitalQR. Se você mesmo(a) escaneou o código para testá-lo, pode ignorar esta mensagem.',
    ubicExacta: 'Localização compartilhada por quem escaneou o código',
    ubicExactaNota: '(Precisão de acordo com o dispositivo de quem escaneou — pode não ser exata.)',
    ubicAprox: (detalle) => `Localização aproximada de quem escaneou o código${detalle}`,
    ubicAproxNota: '(Esta localização é aproximada, calculada a partir da conexão à internet — não é exata, e quem escaneou não compartilhou sua localização real.)',
    aproxEnLbl: (etiqueta) => ` (aproximadamente em ${etiqueta})`,
    fichaLbl: 'Ficha completa',
    hola: 'Olá',
  },
};
const IDIOMAS_VALIDOS_AVISO = ['es', 'en', 'fr', 'pt'];

// ---- envía el aviso de escaneo, con la ubicación que se haya podido determinar ----
// `ubicacionInfo`, si existe, trae { tipo: 'exacta'|'aproximada', url, etiqueta? } — datos crudos,
// no texto ya armado — para que el prefijo y la nota se puedan construir aquí mismo en el idioma
// de `datos.idioma` (ver TEXTOS_AVISO_ESCANEO arriba), y para poder armar el enlace de Google Maps
// como un <a href> real en la versión HTML del correo — ver la corrección de este mismo bug en
// el punto 53 de la bitácora: antes, al agregarse la versión HTML (punto 48), la ubicación
// quedaba como texto plano sin envolver en <a>, así que dejaba de ser clickeable ahí (aunque en
// la versión de solo texto plano de antes sí se veía clickeable, porque el propio cliente de
// correo detecta y enlaza automáticamente URLs sueltas dentro de texto plano — no dentro de HTML).
async function avisarContactos(datos, ubicacionInfo) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return; // si no hay Resend configurado, simplemente no se avisa (no debe romper nada)

  const contactosConCorreo = (Array.isArray(datos.contactos) ? datos.contactos : []).filter((c) => c && c.email);
  if (contactosConCorreo.length === 0) return;

  const idioma = IDIOMAS_VALIDOS_AVISO.includes(datos.idioma) ? datos.idioma : 'es';
  const t = TEXTOS_AVISO_ESCANEO[idioma];

  const tipo = datos.tipo;
  const nombre = datos.nombreCompleto || (idioma === 'es' ? 'Sin nombre' : (idioma === 'en' ? 'Unnamed' : (idioma === 'fr' ? 'Sans nom' : 'Sem nome')));
  const asunto = t.asunto(tipo, nombre);
  const introTexto = t.intro(tipo, nombre, datos.folio, fechaHoraCR(idioma));
  const explicacionTexto = t.explicacion(tipo);
  const notaFinalTexto = t.notaFinal;

  // ---- arma el prefijo y la nota de ubicación en el idioma correspondiente, a partir de los
  // datos crudos que llegaron en ubicacionInfo ----
  let ubicacionArmada = null;
  if (ubicacionInfo && ubicacionInfo.tipo === 'exacta') {
    ubicacionArmada = { prefijo: t.ubicExacta, url: ubicacionInfo.url, nota: t.ubicExactaNota };
  } else if (ubicacionInfo && ubicacionInfo.tipo === 'aproximada') {
    const detalle = ubicacionInfo.etiqueta ? t.aproxEnLbl(ubicacionInfo.etiqueta) : '';
    ubicacionArmada = { prefijo: t.ubicAprox(detalle), url: ubicacionInfo.url, nota: t.ubicAproxNota };
  }

  // ---- texto de ubicación en una sola línea (con la URL completa del mapa incrustada, como
  // antes) — para la versión en texto plano, donde el propio cliente de correo la detecta y la
  // vuelve clickeable automáticamente ----
  const ubicacionTexto = ubicacionArmada
    ? `${ubicacionArmada.prefijo}: ${ubicacionArmada.url}\n${ubicacionArmada.nota}`
    : '';

  // ---- versión en texto plano: se muestra la URL acortada del PDF (no queda como enlace
  // clickeable en texto plano, pero ya no se expone la ruta completa del bucket de S3); la
  // ubicación mantiene su URL completa de Google Maps, igual que siempre ----
  const cuerpo = [
    introTexto,
    '',
    explicacionTexto,
    '',
    ubicacionTexto || '',
    datos.pdfUrl ? `${t.fichaLbl}: ${urlAcortada(datos.pdfUrl)}` : '',
    '',
    notaFinalTexto,
  ].filter(Boolean).join('\n');

  // ---- versión en HTML: la ubicación ahora se arma con su URL de Google Maps envuelta en un
  // <a href> real (antes quedaba como texto plano sin enlazar dentro del HTML, y por eso dejaba
  // de poder abrirse con un clic aunque en la versión de solo texto plano de antes sí funcionaba
  // — ver punto 53). El enlace de la ficha ya se arma igual (con su propio <a href>) desde el
  // punto 48, sin cambios aquí.
  const ubicacionHtml = ubicacionArmada
    ? `<p>${escaparHtml(ubicacionArmada.prefijo)}: <a href="${escaparHtml(ubicacionArmada.url)}">${escaparHtml(ubicacionArmada.url)}</a><br>${escaparHtml(ubicacionArmada.nota)}</p>`
    : '';
  const fichaHtml = datos.pdfUrl
    ? `<p><strong>${escaparHtml(t.fichaLbl)}:</strong> <a href="${escaparHtml(datos.pdfUrl)}">${escaparHtml(urlAcortada(datos.pdfUrl))}</a></p>`
    : '';
  const cuerpoHtml = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5;">',
    `<p>${escaparHtml(introTexto)}</p>`,
    `<p>${escaparHtml(explicacionTexto)}</p>`,
    ubicacionHtml,
    fichaHtml,
    `<p style="color:#777;font-size:12px;margin-top:18px;">${escaparHtml(notaFinalTexto)}</p>`,
    '</div>',
  ].filter(Boolean).join('');

  const envios = contactosConCorreo.map((c) =>
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: REMITENTE,
        to: [c.email],
        subject: asunto,
        text: `${t.hola} ${c.nombre || ''},\n\n${cuerpo}`,
        html: `<p>${t.hola} ${escaparHtml(c.nombre || '')},</p>${cuerpoHtml}`,
      }),
    }).catch((err) => {
      console.error('No se pudo avisar a', c.email, err);
    })
  );

  await Promise.allSettled(envios);
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido.' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  const folio = String(payload.folio || '').trim().toUpperCase();
  if (!folio) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta el folio.' }) };
  }

  const permitido = payload.permitido === true;
  const lat = permitido && typeof payload.lat === 'number' ? payload.lat : null;
  const lng = permitido && typeof payload.lng === 'number' ? payload.lng : null;

  // ---- vuelve a leer la ficha completa de S3 a partir del folio — nunca se confía en datos de
  // contacto ni PDF que pudieran venir del navegador, solo en el folio para ubicarla ----
  const carpetaPreferida = folio.startsWith('VVMASCOTA') ? 'mascotas' : (folio.startsWith('VVOBJETO') ? 'objetos' : (folio.startsWith('VVITALQR') ? 'personas' : null));
  const rutasPosibles = carpetaPreferida
    ? [`${carpetaPreferida}/datos/${folio}.json`, `datos/${folio}.json`]
    : [`datos/${folio}.json`, `personas/datos/${folio}.json`, `mascotas/datos/${folio}.json`, `objetos/datos/${folio}.json`];

  let datos;
  try {
    const s3 = getS3Client();
    const bucket = process.env.S3_BUCKET_FICHAS || BUCKET_FICHAS;
    let encontrado = null;
    for (const ruta of rutasPosibles) {
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: ruta }));
        encontrado = await streamToString(resp.Body);
        break;
      } catch (err) {
        const noExiste = err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
        if (!noExiste) throw err;
      }
    }
    if (!encontrado) throw new Error('No encontrado en ninguna ubicación.');
    datos = JSON.parse(encontrado);
    datos.folio = datos.folio || folio;
  } catch (err) {
    // no se le puede avisar a nadie de una ficha que no existe — se responde 200 igual, para no
    // darle a quien llame esta función ninguna pista sobre qué folios sí existen
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // ---- arma los datos crudos de ubicación para el correo (tipo/url/etiqueta, sin traducir
  // todavía) — avisarContactos() arma el prefijo y la nota ya traducidos al idioma de la ficha
  // (datos.idioma), y también puede armar tanto la línea de texto plano como el <a href> real de
  // la versión HTML — ver punto 53 y punto 54 de la bitácora) ----
  let ubicacionInfo = null;
  if (lat !== null && lng !== null) {
    ubicacionInfo = { tipo: 'exacta', url: enlaceMapa(lat, lng) };
  } else {
    const ip = obtenerIp(event);
    const aprox = await ubicacionPorIp(ip);
    if (aprox) {
      ubicacionInfo = { tipo: 'aproximada', url: enlaceMapa(aprox.lat, aprox.lng), etiqueta: aprox.etiqueta || '' };
    }
  }

  try {
    await avisarContactos(datos, ubicacionInfo);
  } catch (err) {
    console.error('Error avisando a los contactos:', err);
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
