// ---- Netlify Function: página pública que se abre al escanear el código QR ----
// Reemplaza el enlace directo al PDF. Al abrirse:
//  1) Busca los datos de la ficha (folio) guardados en S3 por send-ficha.js.
//  2) Envía, en segundo plano y sin bloquear la respuesta al visitante, un aviso por correo a
//     cada contacto de emergencia que tenga un correo registrado, indicando que su código QR
//     fue escaneado.
//  3) Devuelve una página HTML con la información esencial, un botón para ver/descargar la
//     ficha completa en PDF, y un selector de idioma (Español / English / Français /
//     Português) que traduce las etiquetas fijas de esta página — el texto que la persona
//     escribió en su ficha (comentarios, nombres, etc.) se muestra tal como fue ingresado,
//     porque traducirlo automáticamente no sería confiable para información médica.

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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- fecha/hora legible en zona horaria de Costa Rica, para el correo de aviso ----
function fechaHoraCR() {
  try {
    return new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica', dateStyle: 'long', timeStyle: 'short' });
  } catch (err) {
    return new Date().toISOString();
  }
}

// ---- envía el aviso de escaneo a los contactos que tengan correo, sin bloquear la página ----
async function avisarContactos(datos) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return; // si no hay Resend configurado, simplemente no se avisa (no debe romper la página)

  const contactosConCorreo = (Array.isArray(datos.contactos) ? datos.contactos : []).filter((c) => c && c.email);
  if (contactosConCorreo.length === 0) return;

  const esTipoMascota = datos.tipo === 'Mascota';
  const asunto = esTipoMascota
    ? `⚠️ Alguien escaneó el código QR de ${datos.nombreCompleto || 'su mascota'}`
    : `⚠️ Alguien escaneó el código QR de emergencia de ${datos.nombreCompleto || 'un usuario'}`;

  const cuerpo = [
    `El código QR de ${esTipoMascota ? 'la mascota' : 'la ficha de emergencia de'} "${datos.nombreCompleto || 'Sin nombre'}" (folio ${datos.folio}) fue escaneado el ${fechaHoraCR()} (hora de Costa Rica).`,
    '',
    'Esto puede significar que alguien está tratando de contactarlo(a) por una emergencia, o que la mascota fue encontrada.',
    '',
    datos.pdfUrl ? `Ficha completa: ${datos.pdfUrl}` : '',
    '',
    'Este es un aviso automático de VidaVitalQR. Si usted mismo(a) escaneó el código para probarlo, puede ignorar este mensaje.',
  ].filter(Boolean).join('\n');

  const envios = contactosConCorreo.map((c) =>
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: REMITENTE,
        to: [c.email],
        subject: asunto,
        text: `Hola ${c.nombre || ''},\n\n${cuerpo}`,
      }),
    }).catch((err) => {
      // no se debe interrumpir la carga de la página por un correo que falle
      console.error('No se pudo avisar a', c.email, err);
    })
  );

  await Promise.allSettled(envios);
}

// ---- diccionario de textos fijos de la página, por idioma ----
const TEXTOS = {
  es: {
    tituloPersona: 'Información de emergencia',
    tituloMascota: 'Mascota — información de emergencia',
    subtitulo: 'Este código pertenece a una ficha de VidaVitalQR.',
    nombre: 'Nombre',
    sangre: 'Tipo de sangre',
    especie: 'Especie',
    raza: 'Raza',
    veterinario: 'Veterinario de confianza',
    pais: 'País',
    comentarios: 'Comentarios importantes',
    contactos: 'Contactos de emergencia',
    telefono: 'Tel.',
    sinDatos: 'Sin datos registrados.',
    botonPdf: 'Ver ficha completa (PDF)',
    notaOriginal: 'Texto ingresado por el usuario, tal como fue escrito.',
    notaAviso: 'Se notificó automáticamente a los contactos de emergencia registrados.',
    noEncontrado: 'No se encontró información para este código.',
    idioma: 'Idioma',
  },
  en: {
    tituloPersona: 'Emergency information',
    tituloMascota: 'Pet — emergency information',
    subtitulo: 'This code belongs to a VidaVitalQR record.',
    nombre: 'Name',
    sangre: 'Blood type',
    especie: 'Species',
    raza: 'Breed',
    veterinario: 'Trusted veterinarian',
    pais: 'Country',
    comentarios: 'Important notes',
    contactos: 'Emergency contacts',
    telefono: 'Phone',
    sinDatos: 'No data on file.',
    botonPdf: 'View full record (PDF)',
    notaOriginal: 'Text entered by the user, shown exactly as written.',
    notaAviso: 'The registered emergency contacts were automatically notified.',
    noEncontrado: 'No information was found for this code.',
    idioma: 'Language',
  },
  fr: {
    tituloPersona: "Informations d'urgence",
    tituloMascota: "Animal de compagnie — informations d'urgence",
    subtitulo: 'Ce code appartient à une fiche VidaVitalQR.',
    nombre: 'Nom',
    sangre: 'Groupe sanguin',
    especie: 'Espèce',
    raza: 'Race',
    veterinario: 'Vétérinaire de confiance',
    pais: 'Pays',
    comentarios: 'Remarques importantes',
    contactos: "Contacts d'urgence",
    telefono: 'Tél.',
    sinDatos: 'Aucune donnée enregistrée.',
    botonPdf: 'Voir la fiche complète (PDF)',
    notaOriginal: "Texte saisi par l'utilisateur, affiché tel quel.",
    notaAviso: "Les contacts d'urgence enregistrés ont été notifiés automatiquement.",
    noEncontrado: "Aucune information trouvée pour ce code.",
    idioma: 'Langue',
  },
  pt: {
    tituloPersona: 'Informações de emergência',
    tituloMascota: 'Animal de estimação — informações de emergência',
    subtitulo: 'Este código pertence a uma ficha VidaVitalQR.',
    nombre: 'Nome',
    sangre: 'Tipo sanguíneo',
    especie: 'Espécie',
    raza: 'Raça',
    veterinario: 'Veterinário de confiança',
    pais: 'País',
    comentarios: 'Observações importantes',
    contactos: 'Contatos de emergência',
    telefono: 'Tel.',
    sinDatos: 'Sem dados registrados.',
    botonPdf: 'Ver ficha completa (PDF)',
    notaOriginal: 'Texto inserido pelo usuário, exibido como foi escrito.',
    notaAviso: 'Os contatos de emergência registrados foram notificados automaticamente.',
    noEncontrado: 'Nenhuma informação foi encontrada para este código.',
    idioma: 'Idioma',
  },
};

function paginaError(mensaje) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VidaVitalQR</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F7F4EE;color:#12282B;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center;}
.box{max-width:420px;}h1{font-size:1.3rem;}</style></head>
<body><div class="box"><h1>VidaVitalQR</h1><p>${escapeHtml(mensaje)}</p></div></body></html>`;
}

function paginaVisor(datos) {
  const esTipoMascota = datos.tipo === 'Mascota';
  const dv = datos.datosVisor || {};
  const contactos = Array.isArray(datos.contactos) ? datos.contactos.filter((c) => c && (c.nombre || c.telefono)) : [];

  const filasExtra = esTipoMascota
    ? [
        ['especie', dv.especie],
        ['raza', dv.raza],
        ['veterinario', dv.veterinario],
      ]
    : [['sangre', dv.sangre]];

  const filasExtraHtml = filasExtra
    .filter(([, valor]) => valor)
    .map(([clave, valor]) => `<div class="dato"><span class="etiqueta" data-i18n="${clave}"></span><span class="valor">${escapeHtml(valor)}</span></div>`)
    .join('');

  const paisHtml = dv.pais ? `<div class="dato"><span class="etiqueta" data-i18n="pais"></span><span class="valor">${escapeHtml(dv.pais)}</span></div>` : '';

  const comentariosHtml = dv.comentarios
    ? `<div class="bloque"><h3 data-i18n="comentarios"></h3><p class="valor-libre">${escapeHtml(dv.comentarios)}</p><p class="nota" data-i18n="notaOriginal"></p></div>`
    : '';

  const contactosHtml = contactos.length
    ? contactos.map((c) => `<div class="contacto"><strong>${escapeHtml(c.nombre || '')}</strong>${c.parentesco ? ` — ${escapeHtml(c.parentesco)}` : ''}${c.telefono ? `<br><span class="etiqueta" data-i18n="telefono"></span> ${escapeHtml(c.telefono)}` : ''}</div>`).join('')
    : `<p class="valor-libre" data-i18n="sinDatos"></p>`;

  const fotoHtml = datos.fotoUrl
    ? `<img class="foto" src="${escapeHtml(datos.fotoUrl)}" alt="${escapeHtml(datos.nombreCompleto || '')}">`
    : '';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VidaVitalQR — ${escapeHtml(datos.nombreCompleto || '')}</title>
<style>
  :root{ --ink:#12282B; --ink-soft:#2C4247; --paper:#F7F4EE; --card:#FFFFFF; --teal-deep:#1F4448; --signal:#C1552F; --line:#DAD3C4; --muted:#6C7A76; }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
  .wrap{max-width:560px;margin:0 auto;padding:28px 20px 60px;}
  .langbar{display:flex;justify-content:flex-end;gap:6px;margin-bottom:18px;}
  .langbar button{border:1px solid var(--line);background:var(--card);color:var(--ink-soft);border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer;font-weight:600;}
  .langbar button.activo{background:var(--teal-deep);color:#fff;border-color:var(--teal-deep);}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;box-shadow:0 20px 50px -30px rgba(18,40,43,0.35);}
  .card h1{font-size:1.35rem;margin:0 0 4px;color:var(--teal-deep);}
  .subtitulo{color:var(--muted);font-size:0.92rem;margin:0 0 18px;}
  .foto{width:88px;height:88px;border-radius:50%;object-fit:cover;float:right;margin-left:14px;border:2px solid var(--line);overflow:hidden;background:var(--paper);color:transparent;font-size:0;}
  .nombre-usuario{font-size:1.15rem;font-weight:700;margin:0 0 14px;}
  .dato{display:flex;gap:8px;padding:8px 0;border-top:1px solid var(--line);font-size:0.95rem;}
  .dato .etiqueta{color:var(--muted);min-width:130px;}
  .bloque{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);}
  .bloque h3{font-size:1rem;margin:0 0 6px;color:var(--teal-deep);}
  .valor-libre{white-space:pre-wrap;font-size:0.95rem;margin:0;}
  .nota{color:var(--muted);font-size:0.78rem;margin:6px 0 0;font-style:italic;}
  .contacto{padding:8px 0;border-top:1px solid var(--line);font-size:0.95rem;}
  .btnPdf{display:block;text-align:center;margin-top:22px;background:var(--signal);color:#fff;text-decoration:none;font-weight:700;padding:14px;border-radius:10px;}
  .avisoFooter{color:var(--muted);font-size:0.8rem;text-align:center;margin-top:16px;}
</style>
</head>
<body>
<div class="wrap">
  <div class="langbar">
    <button data-lang="es">ES</button>
    <button data-lang="en">EN</button>
    <button data-lang="fr">FR</button>
    <button data-lang="pt">PT</button>
  </div>
  <div class="card">
    ${fotoHtml}
    <h1 data-i18n="${esTipoMascota ? 'tituloMascota' : 'tituloPersona'}"></h1>
    <p class="subtitulo" data-i18n="subtitulo"></p>
    <p class="nombre-usuario">${escapeHtml(datos.nombreCompleto || '')}</p>
    ${filasExtraHtml}
    ${paisHtml}
    ${comentariosHtml}
    <div class="bloque">
      <h3 data-i18n="contactos"></h3>
      ${contactosHtml}
    </div>
    ${datos.pdfUrl ? `<a class="btnPdf" href="${escapeHtml(datos.pdfUrl)}" target="_blank" rel="noopener" data-i18n="botonPdf"></a>` : ''}
  </div>
  <p class="avisoFooter" data-i18n="notaAviso"></p>
</div>
<script>
  var TEXTOS = ${JSON.stringify(TEXTOS)};
  function aplicarIdioma(lang){
    var dic = TEXTOS[lang] || TEXTOS.es;
    document.querySelectorAll('[data-i18n]').forEach(function(el){
      var clave = el.getAttribute('data-i18n');
      if (dic[clave] !== undefined) el.textContent = dic[clave];
    });
    document.documentElement.lang = lang;
    document.querySelectorAll('.langbar button').forEach(function(b){
      b.classList.toggle('activo', b.getAttribute('data-lang') === lang);
    });
    try { localStorage.setItem('vidavitalqr_lang', lang); } catch(e){}
  }
  document.querySelectorAll('.langbar button').forEach(function(b){
    b.addEventListener('click', function(){ aplicarIdioma(b.getAttribute('data-lang')); });
  });
  var preferido = 'es';
  try {
    var guardado = localStorage.getItem('vidavitalqr_lang');
    if (guardado && TEXTOS[guardado]) preferido = guardado;
    else {
      var nav = (navigator.language || 'es').slice(0,2).toLowerCase();
      if (TEXTOS[nav]) preferido = nav;
    }
  } catch(e){}
  aplicarIdioma(preferido);
</script>
</body>
</html>`;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: paginaError('Método no permitido.') };
  }

  const folio = (event.queryStringParameters && event.queryStringParameters.folio) || '';
  if (!folio) {
    return { statusCode: 400, headers, body: paginaError('Falta el código de la ficha.') };
  }

  // El folio mismo ya dice el tipo sin ambigüedad: el de persona siempre empieza con
  // "VVITALQR" y el de mascota con "VVMASCOTA" — así que se busca directo en la carpeta que
  // corresponde. La ubicación antigua (sin carpeta, de antes de organizar por carpetas) se
  // revisa como respaldo, para las fichas que todavía no se han vuelto a guardar desde ese
  // cambio.
  const folioMayus = folio.toUpperCase();
  const carpetaPreferida = folioMayus.startsWith('VVMASCOTA') ? 'mascotas' : (folioMayus.startsWith('VVITALQR') ? 'personas' : null);
  const rutasPosibles = carpetaPreferida
    ? [`${carpetaPreferida}/datos/${folio}.json`, `datos/${folio}.json`]
    : [`datos/${folio}.json`, `personas/datos/${folio}.json`, `mascotas/datos/${folio}.json`]; // folio con formato desconocido — se revisan todas por si acaso

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
  } catch (err) {
    return { statusCode: 404, headers, body: paginaError('No se encontró información para este código.') };
  }

  // el aviso a los contactos se espera antes de responder (los Netlify Functions no garantizan
  // que el código siga corriendo después de devolver la respuesta), pero nunca debe impedir que
  // la página se muestre si el envío falla
  try {
    await avisarContactos(datos);
  } catch (err) {
    console.error('Error avisando a los contactos:', err);
  }

  return { statusCode: 200, headers, body: paginaVisor(datos) };
};
