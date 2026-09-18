// ---- Netlify Function: página pública que se abre al escanear el código QR ----
// Reemplaza el enlace directo al PDF. Al abrirse:
//  1) Busca los datos de la ficha (folio) guardados en S3 por send-ficha.js.
//  2) Devuelve una página HTML con la información esencial, un botón para ver/descargar la
//     ficha completa en PDF, y un selector de idioma (Español / English / Français /
//     Português) que traduce las etiquetas fijas de esta página — el texto que la persona
//     escribió en su ficha (comentarios, nombres, etc.) se muestra tal como fue ingresado,
//     porque traducirlo automáticamente no sería confiable para información médica.
//  3) Desde el navegador de quien escaneó, se le pide permiso para compartir su ubicación
//     actual (aplica tanto para fichas de persona como de mascota) y, con el resultado
//     (coordenadas exactas si lo permite, o nada si lo rechaza), se llama en segundo plano a
//     la función `avisar-escaneo.js`, que es la que arma y envía el correo de aviso a los
//     contactos de emergencia — incluyendo la ubicación cuando fue posible obtenerla. Esta
//     página ya no envía el aviso ella misma, para no bloquear la carga esperando el permiso
//     del navegador.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET_FICHAS = process.env.S3_BUCKET_FICHAS || 'vidavitalqr';

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

// ---- diccionario de textos fijos de la página, por idioma ----
const TEXTOS = {
  es: {
    tituloPersona: 'Información de emergencia',
    tituloMascota: 'Mascota — información de emergencia',
    tituloObjeto: 'Objeto — información de contacto',
    subtitulo: 'Este código pertenece a una ficha de VidaVitalQR.',
    nombre: 'Nombre',
    sangre: 'Tipo de sangre',
    especie: 'Especie',
    raza: 'Raza',
    veterinario: 'Veterinario de confianza',
    tipoObjeto: 'Tipo de objeto',
    marca: 'Marca',
    senas: 'Señas particulares',
    pais: 'País',
    comentarios: 'Comentarios importantes',
    contactos: 'Contactos de emergencia',
    telefono: 'Tel.',
    sinDatos: 'Sin datos registrados.',
    botonPdf: 'Ver ficha completa (PDF)',
    notaOriginal: 'Texto ingresado por el usuario, tal como fue escrito.',
    noEncontrado: 'No se encontró información para este código.',
    idioma: 'Idioma',
    avisoSolicitud: 'Se solicita su permiso para enviar a la persona de contacto la ubicación actual de la persona y/o mascota en aprietos.',
    avisoUbicPrecisa: 'Gracias. Se notificó a los contactos de emergencia junto con su ubicación.',
    avisoUbicAprox: 'No se compartió su ubicación exacta. Se notificó a los contactos de emergencia con una ubicación aproximada según su conexión a internet.',
    ubicPreguntaTexto: '¿Autoriza compartir su ubicación exacta con los contactos de emergencia registrados en esta ficha? Si no autoriza, se les notificará igual, pero con una ubicación solo aproximada.',
    btnUbicSi: 'Sí, compartir ubicación exacta',
    btnUbicNo: 'No, usar solo aproximada',
  },
  en: {
    tituloPersona: 'Emergency information',
    tituloMascota: 'Pet — emergency information',
    tituloObjeto: 'Object — contact information',
    subtitulo: 'This code belongs to a VidaVitalQR record.',
    nombre: 'Name',
    sangre: 'Blood type',
    especie: 'Species',
    raza: 'Breed',
    veterinario: 'Trusted veterinarian',
    tipoObjeto: 'Object type',
    marca: 'Brand',
    senas: 'Distinguishing marks',
    pais: 'Country',
    comentarios: 'Important notes',
    contactos: 'Emergency contacts',
    telefono: 'Phone',
    sinDatos: 'No data on file.',
    botonPdf: 'View full record (PDF)',
    notaOriginal: 'Text entered by the user, shown exactly as written.',
    noEncontrado: 'No information was found for this code.',
    idioma: 'Language',
    avisoSolicitud: 'We are requesting your permission to send the contact person the current location of the person and/or pet in distress.',
    avisoUbicPrecisa: 'Thank you. The emergency contacts were notified along with your location.',
    avisoUbicAprox: 'Your exact location was not shared. The emergency contacts were notified with an approximate location based on your internet connection.',
    ubicPreguntaTexto: 'Do you authorize sharing your exact location with the emergency contacts registered on this record? If you do not authorize it, they will still be notified, but only with an approximate location.',
    btnUbicSi: 'Yes, share exact location',
    btnUbicNo: 'No, use approximate only',
  },
  fr: {
    tituloPersona: "Informations d'urgence",
    tituloMascota: "Animal de compagnie — informations d'urgence",
    tituloObjeto: "Objet — informations de contact",
    subtitulo: 'Ce code appartient à une fiche VidaVitalQR.',
    nombre: 'Nom',
    sangre: 'Groupe sanguin',
    especie: 'Espèce',
    raza: 'Race',
    veterinario: 'Vétérinaire de confiance',
    tipoObjeto: "Type d'objet",
    marca: 'Marque',
    senas: 'Signes distinctifs',
    pais: 'Pays',
    comentarios: 'Remarques importantes',
    contactos: "Contacts d'urgence",
    telefono: 'Tél.',
    sinDatos: 'Aucune donnée enregistrée.',
    botonPdf: 'Voir la fiche complète (PDF)',
    notaOriginal: "Texte saisi par l'utilisateur, affiché tel quel.",
    noEncontrado: "Aucune information trouvée pour ce code.",
    idioma: 'Langue',
    avisoSolicitud: "Nous vous demandons la permission d'envoyer à la personne de contact la localisation actuelle de la personne et/ou de l'animal en détresse.",
    avisoUbicPrecisa: "Merci. Les contacts d'urgence ont été notifiés avec votre localisation.",
    avisoUbicAprox: "Votre localisation exacte n'a pas été partagée. Les contacts d'urgence ont été notifiés avec une localisation approximative basée sur votre connexion internet.",
    ubicPreguntaTexto: "Autorisez-vous le partage de votre localisation exacte avec les contacts d'urgence enregistrés sur cette fiche ? Si vous ne l'autorisez pas, ils seront tout de même notifiés, mais avec une localisation seulement approximative.",
    btnUbicSi: 'Oui, partager la localisation exacte',
    btnUbicNo: 'Non, utiliser seulement l\'approximative',
  },
  pt: {
    tituloPersona: 'Informações de emergência',
    tituloMascota: 'Animal de estimação — informações de emergência',
    tituloObjeto: 'Objeto — informações de contato',
    subtitulo: 'Este código pertence a uma ficha VidaVitalQR.',
    nombre: 'Nome',
    sangre: 'Tipo sanguíneo',
    especie: 'Espécie',
    raza: 'Raça',
    veterinario: 'Veterinário de confiança',
    tipoObjeto: 'Tipo de objeto',
    marca: 'Marca',
    senas: 'Sinais particulares',
    pais: 'País',
    comentarios: 'Observações importantes',
    contactos: 'Contatos de emergência',
    telefono: 'Tel.',
    sinDatos: 'Sem dados registrados.',
    botonPdf: 'Ver ficha completa (PDF)',
    notaOriginal: 'Texto inserido pelo usuário, exibido como foi escrito.',
    noEncontrado: 'Nenhuma informação foi encontrada para este código.',
    idioma: 'Idioma',
    avisoSolicitud: 'Solicitamos sua permissão para enviar ao contato a localização atual da pessoa e/ou animal em apuros.',
    avisoUbicPrecisa: 'Obrigado. Os contatos de emergência foram notificados junto com sua localização.',
    avisoUbicAprox: 'Sua localização exata não foi compartilhada. Os contatos de emergência foram notificados com uma localização aproximada baseada na sua conexão à internet.',
    ubicPreguntaTexto: 'Você autoriza compartilhar sua localização exata com os contatos de emergência registrados nesta ficha? Se não autorizar, eles ainda serão notificados, mas com uma localização apenas aproximada.',
    btnUbicSi: 'Sim, compartilhar localização exata',
    btnUbicNo: 'Não, usar apenas a aproximada',
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
  const esTipoObjeto = datos.tipo === 'Objeto';
  const dv = datos.datosVisor || {};
  const contactos = Array.isArray(datos.contactos) ? datos.contactos.filter((c) => c && (c.nombre || c.telefono)) : [];

  const filasExtra = esTipoMascota
    ? [
        ['especie', dv.especie],
        ['raza', dv.raza],
        ['veterinario', dv.veterinario],
      ]
    : esTipoObjeto
    ? [
        ['tipoObjeto', dv.tipoObjeto],
        ['marca', dv.marca],
        ['senas', dv.senas],
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
  .ubicPrompt{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:16px;text-align:center;}
  .ubicPrompt p{font-size:0.85rem;color:var(--ink-soft);margin:0 0 12px;}
  .ubicPrompt .fila{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}
  .ubicPrompt button{flex:1;min-width:150px;border-radius:8px;padding:10px 12px;font-size:0.85rem;font-weight:700;cursor:pointer;border:1px solid var(--teal-deep);}
  .ubicPrompt .btnSi{background:var(--teal-deep);color:#fff;}
  .ubicPrompt .btnNo{background:var(--card);color:var(--teal-deep);}
  .oculto{display:none !important;}
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
    <h1 data-i18n="${esTipoMascota ? 'tituloMascota' : (esTipoObjeto ? 'tituloObjeto' : 'tituloPersona')}"></h1>
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
  <div class="ubicPrompt" id="ubicPrompt">
    <p data-i18n="ubicPreguntaTexto"></p>
    <div class="fila">
      <button type="button" class="btnSi" id="btnUbicSi" data-i18n="btnUbicSi"></button>
      <button type="button" class="btnNo" id="btnUbicNo" data-i18n="btnUbicNo"></button>
    </div>
  </div>
  <p class="avisoFooter oculto" id="avisoUbicacion"></p>
</div>
<script>
  var TEXTOS = ${JSON.stringify(TEXTOS)};
  var FOLIO = ${JSON.stringify(datos.folio || '')};
  var idiomaActual = 'es';
  // estadoUbicacion: 'pendiente' mientras se espera la respuesta del navegador al permiso de
  // ubicación; 'concedida' si la persona que escaneó aceptó compartirla; 'denegada' si la
  // rechazó, no respondió a tiempo, o su navegador no soporta geolocalización.
  var estadoUbicacion = 'pendiente';

  function actualizarAvisoUbicacion(){
    var dic = TEXTOS[idiomaActual] || TEXTOS.es;
    var el = document.getElementById('avisoUbicacion');
    if (!el) return;
    if (estadoUbicacion === 'concedida') el.textContent = dic.avisoUbicPrecisa;
    else if (estadoUbicacion === 'denegada') el.textContent = dic.avisoUbicAprox;
    else el.textContent = dic.avisoSolicitud;
  }

  function aplicarIdioma(lang){
    idiomaActual = TEXTOS[lang] ? lang : 'es';
    var dic = TEXTOS[idiomaActual];
    document.querySelectorAll('[data-i18n]').forEach(function(el){
      var clave = el.getAttribute('data-i18n');
      if (dic[clave] !== undefined) el.textContent = dic[clave];
    });
    document.documentElement.lang = idiomaActual;
    document.querySelectorAll('.langbar button').forEach(function(b){
      b.classList.toggle('activo', b.getAttribute('data-lang') === idiomaActual);
    });
    actualizarAvisoUbicacion();
    try { localStorage.setItem('vidavitalqr_lang', idiomaActual); } catch(e){}
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

  // ---- pregunta explícitamente, dentro de la propia página (no solo el permiso nativo del
  // navegador, que una vez concedido/rechazado una vez ya no vuelve a preguntar en visitas
  // posteriores), si la persona que escaneó autoriza compartir su ubicación exacta. Solo si
  // responde "Sí" se le pide el permiso de geolocalización al navegador (que sí muestra su
  // propio diálogo nativo en ese momento, la primera vez); si responde "No", se avisa de una
  // vez con ubicación aproximada, sin siquiera intentar obtener coordenadas. Aplica igual para
  // fichas de persona, mascota y objeto. ----
  function avisarEscaneo(lat, lng, permitido){
    if (!FOLIO) return;
    try {
      fetch('/.netlify/functions/avisar-escaneo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({ folio: FOLIO, lat: lat, lng: lng, permitido: !!permitido }),
      }).catch(function(){});
    } catch (e) {}
  }

  function ocultarPromptUbicacion(){
    var prompt = document.getElementById('ubicPrompt');
    var aviso = document.getElementById('avisoUbicacion');
    if (prompt) prompt.classList.add('oculto');
    if (aviso) aviso.classList.remove('oculto');
  }

  function pedirUbicacionExacta(){
    if (!navigator.geolocation) {
      estadoUbicacion = 'denegada';
      ocultarPromptUbicacion();
      actualizarAvisoUbicacion();
      avisarEscaneo(null, null, false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        estadoUbicacion = 'concedida';
        ocultarPromptUbicacion();
        actualizarAvisoUbicacion();
        avisarEscaneo(pos.coords.latitude, pos.coords.longitude, true);
      },
      function () {
        // el navegador rechazó el permiso (o no respondió a tiempo) aunque la persona haya
        // aceptado en nuestra propia pregunta — se avisa igual, con ubicación aproximada.
        estadoUbicacion = 'denegada';
        ocultarPromptUbicacion();
        actualizarAvisoUbicacion();
        avisarEscaneo(null, null, false);
      },
      { timeout: 6000, maximumAge: 0, enableHighAccuracy: false }
    );
  }

  var btnUbicSi = document.getElementById('btnUbicSi');
  var btnUbicNo = document.getElementById('btnUbicNo');
  if (btnUbicSi) btnUbicSi.addEventListener('click', pedirUbicacionExacta);
  if (btnUbicNo) btnUbicNo.addEventListener('click', function(){
    estadoUbicacion = 'denegada';
    ocultarPromptUbicacion();
    actualizarAvisoUbicacion();
    avisarEscaneo(null, null, false);
  });
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
  const carpetaPreferida = folioMayus.startsWith('VVMASCOTA') ? 'mascotas' : (folioMayus.startsWith('VVOBJETO') ? 'objetos' : (folioMayus.startsWith('VVITALQR') ? 'personas' : null));
  const rutasPosibles = carpetaPreferida
    ? [`${carpetaPreferida}/datos/${folio}.json`, `datos/${folio}.json`]
    : [`datos/${folio}.json`, `personas/datos/${folio}.json`, `mascotas/datos/${folio}.json`, `objetos/datos/${folio}.json`]; // folio con formato desconocido — se revisan todas por si acaso

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
    datos.folio = datos.folio || folio; // por si el JSON guardado no trae el folio explícito
  } catch (err) {
    return { statusCode: 404, headers, body: paginaError('No se encontró información para este código.') };
  }

  // El aviso a los contactos ya no se envía desde aquí: se dispara desde el navegador de quien
  // escaneó, después de pedirle permiso de ubicación (ver `avisar-escaneo.js`). Así la página se
  // muestra de inmediato, sin esperar a que el navegador resuelva el permiso ni a que se envíe
  // el correo.

  return { statusCode: 200, headers, body: paginaVisor(datos) };
};
