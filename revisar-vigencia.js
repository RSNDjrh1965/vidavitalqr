// ---- revisar-vigencia.js ----
// Función PROGRAMADA (una vez al día, ver netlify.toml — mismo patrón que
// actualizar-tipo-cambio.js) que recorre TODAS las fichas (personas, mascotas y objetos) y:
//  1) Envía los correos de la cronología de avisos de vigencia aprobada por James (ver el
//     documento "Política de vigencia y eliminación de fichas" del Proyecto ADJDATA):
//       - 30 días antes de vencer, y 7 días antes de vencer: recordatorios de renovación.
//       - Al vencer (día 0): aviso de que pasó a "vencida" (información esencial de emergencia
//         se sigue mostrando; tiene 2 meses de gracia).
//       - 30 días después de vencer: aviso intermedio.
//       - 55 días después de vencer (5 días antes de eliminarse): aviso final.
//       - 60 días después de vencer: se elimina la ficha por completo y se confirma por correo.
//  2) Marca en el propio registro (login/<folio>.json, bucket privado) cuáles de esos avisos ya
//     se enviaron (vigencia.avisos), para nunca repetir un correo aunque esta función no corra
//     exactamente el día del umbral (por ejemplo, si Netlify tuvo un problema un día, al día
//     siguiente igual se envía el aviso pendiente — los umbrales se revisan con "ya pasó y no se
//     ha enviado", nunca con "es exactamente hoy").
//  3) A los 60 días de vencida, borra por completo los datos de la ficha en S3 (ficha en PDF —en
//     todos los idiomas que se hayan generado—, foto, tarjeta "Identificador QR", código QR y el
//     propio registro de acceso). La fila correspondiente en el cuadro resumen (resumen.xlsx) NO
//     se borra — queda como registro histórico de que la ficha existió, con su columna "Estado"
//     mostrando "Eliminada" automáticamente (ver lib/xlsx-resumen.js).
//
// El estado de vigencia de cada ficha (vigente / vencida / eliminada) nunca lo "decide" ni lo
// guarda esta función — se calcula siempre a partir de la fecha "creado" con lib/vigencia.js, la
// misma que usan ver.js (para el visor público) y xlsx-resumen.js (para el cuadro resumen). Esta
// función solo actúa sobre las consecuencias de ese estado: enviar el correo que corresponda y,
// llegado el caso, borrar los datos.
//
// IMPORTANTE (decisión de alcance, 2026-09-25, confirmada con James): esta primera versión NO
// conecta el webhook de pago de ONVO (onvo-webhook.js) para marcar una ficha como renovada — sigue
// usando el mecanismo que ya existía (el formulario marca "esRenovacionPago" al guardar una
// renovación, lo que reinicia el campo "creado" en send-ficha.js). Conectar el webhook de ONVO
// directamente queda señalado como una mejora aparte, pendiente para más adelante.
//
// Correo del titular: se usa "correoTitular" (campo agregado 2026-09-25 a los 3 formularios) si
// existe; si la ficha es de antes de ese cambio y no lo tiene, se usa como respaldo el correo del
// contacto de emergencia 1 (datosFormulario.emailcontacto1) — así ninguna ficha existente se queda
// sin ningún aviso solo por haberse creado antes de que existiera el campo nuevo.

const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { fechaVencimiento, finGracia, calcularEstado, diasEntre } = require('./lib/vigencia');

const BUCKET_FICHAS = process.env.S3_BUCKET_FICHAS || 'vidavitalqr';
const BUCKET_QR = process.env.S3_BUCKET_QR || 'vidavitalqr-qr';
const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';
const SITE_URL = process.env.SITE_URL || 'https://vidavitalqr.com';
const CARPETAS = ['personas', 'mascotas', 'objetos'];
const IDIOMAS_PDF = ['en', 'fr', 'pt']; // "es" es el PDF por defecto (folio.pdf); los demás llevan sufijo

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

function esNoExiste(err) {
  return err && (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404);
}

// ---- lista TODAS las claves login/<folio>.json bajo un prefijo (con paginación) ----
async function listarClaves(s3, bucket, prefijo) {
  const claves = [];
  let continuationToken;
  do {
    const resp = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefijo, ContinuationToken: continuationToken }));
    (resp.Contents || []).forEach((o) => { if (o.Key && o.Key.endsWith('.json')) claves.push(o.Key); });
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
  return claves;
}

function carpetaDesdeFolio(folio) {
  const f = String(folio || '').toUpperCase();
  if (f.startsWith('VVMASCOTA')) return 'mascotas';
  if (f.startsWith('VVOBJETO')) return 'objetos';
  return 'personas';
}

function folioDesdeClave(clave) {
  const archivo = clave.split('/').pop() || '';
  return archivo.replace(/\.json$/i, '');
}

// ---- convierte una URL pública (https://<bucket>.s3.<region>.amazonaws.com/<key>) en su Key de
// S3 — para poder borrar exactamente el objeto que corresponde a esa URL sin tener que adivinar
// su extensión o ruta ----
function keyDesdeUrlPublica(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch (err) {
    return null;
  }
}

function urlRenovacion(carpeta) {
  const pagina = carpeta === 'mascotas' ? 'ficha-mascota.html' : (carpeta === 'objetos' ? 'ficha-objeto.html' : 'ficha.html');
  return `${SITE_URL}/${pagina}?renovar=1`;
}

function tipoFichaTexto(carpeta) {
  return carpeta === 'mascotas' ? 'ficha de mascota' : (carpeta === 'objetos' ? 'ficha de objeto' : 'ficha médica');
}

function formatearFechaCR(fecha) {
  try {
    return fecha.toLocaleDateString('es-CR', { timeZone: 'America/Costa_Rica', day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (err) {
    return fecha.toISOString().slice(0, 10);
  }
}

function nombreDesdeDatosFormulario(datosFormulario, carpeta) {
  const df = datosFormulario || {};
  if (carpeta === 'personas') return [df.nombres, df.apellidos].filter(Boolean).join(' ') || 'cliente de VidaVitalQR';
  return df.nombres || 'cliente de VidaVitalQR';
}

// ---- textos de los correos de la cronología (aprobados por James, 2026-09-25 — ver el
// documento "Política de vigencia y eliminación de fichas" del Proyecto ADJDATA). Solo en
// español, igual que se aprobaron (a diferencia del aviso de escaneo y el código de acceso, que
// sí son multi-idioma). ----
function correoAviso30(nombre, tipo, folio, fechaVenc, enlace) {
  return {
    asunto: 'Su ficha VidaVitalQR vence en 30 días',
    texto: `Hola ${nombre},\n\nLe escribimos para avisarle que la vigencia de su ficha VidaVitalQR (${tipo} — folio ${folio}) vence el ${fechaVenc}, dentro de 30 días.\n\nPara que el código QR siga mostrando su información de emergencia sin interrupciones, puede renovarla ahora mismo aquí: ${enlace}\n\nSi no renueva a tiempo, la ficha no se elimina de inmediato: pasa a un estado de "vencida" en el que se sigue mostrando la información básica de emergencia (contactos y datos médicos críticos), pero tendrá 2 meses para renovarla antes de que se elimine por completo.\n\nGracias por confiar en VidaVitalQR.`,
  };
}
function correoAviso7(nombre, tipo, folio, fechaVenc, enlace) {
  return {
    asunto: 'Quedan 7 días para renovar su ficha VidaVitalQR',
    texto: `Hola ${nombre},\n\nSu ficha (${tipo} — folio ${folio}) vence el ${fechaVenc}, en solo 7 días.\n\nRenuévela aquí en un par de minutos: ${enlace}\n\nRecuerde: si no renueva, la ficha queda vencida (con la información básica de emergencia aún visible) por 2 meses más, antes de eliminarse definitivamente.`,
  };
}
function correoVencida(nombre, tipo, folio, fechaVenc, fechaLimite, enlace) {
  return {
    asunto: 'Su ficha VidaVitalQR venció — información básica aún activa',
    texto: `Hola ${nombre},\n\nLa vigencia anual de su ficha (${tipo} — folio ${folio}) venció hoy, ${fechaVenc}.\n\nPara que quien la encuentre en una emergencia real no se quede sin ayuda, su información de emergencia esencial (contactos y datos médicos críticos) sigue visible al escanear el código. El resto de la información (foto, notas adicionales) queda oculto temporalmente.\n\nTiene hasta el ${fechaLimite} para renovar y que la ficha vuelva a mostrarse completa: ${enlace}\n\nSi no renueva antes de esa fecha, la ficha —y toda su información— se eliminará por completo de nuestro sistema.`,
  };
}
function correoGracia30(nombre, tipo, folio, fechaVenc, enlace) {
  return {
    asunto: 'Le quedan 30 días antes de que se elimine su ficha VidaVitalQR',
    texto: `Hola ${nombre},\n\nSu ficha (${tipo} — folio ${folio}) sigue vencida desde el ${fechaVenc}. Le quedan 30 días para renovarla antes de que se elimine definitivamente, junto con toda la información guardada.\n\nRenuévela aquí: ${enlace}`,
  };
}
function correoFinal55(nombre, tipo, folio, fechaElim, enlace) {
  return {
    asunto: 'Últimos 5 días antes de eliminar su ficha VidaVitalQR',
    texto: `Hola ${nombre},\n\nEste es el último aviso: su ficha (${tipo} — folio ${folio}) se eliminará el ${fechaElim} si no la renueva antes.\n\nUna vez eliminada, no podremos recuperar la información — tendría que crear una ficha nueva desde cero.\n\nRenuévela ahora: ${enlace}`,
  };
}
function correoEliminada(nombre, tipo, folio, enlaceSitio) {
  return {
    asunto: 'Su ficha VidaVitalQR fue eliminada',
    texto: `Hola ${nombre},\n\nComo le informamos previamente, su ficha (${tipo} — folio ${folio}) se eliminó hoy por falta de renovación durante el período de gracia.\n\nSi desea volver a contar con VidaVitalQR, puede crear una ficha nueva cuando quiera aquí: ${enlaceSitio}\n\nGracias por haber sido parte de VidaVitalQR.`,
  };
}

async function enviarCorreo(apiKey, destinatario, { asunto, texto }) {
  if (!apiKey || !destinatario) return false;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: REMITENTE, to: [destinatario], subject: asunto, text: texto }),
    });
    if (!resp.ok) {
      let detalle = '';
      try { detalle = JSON.stringify(await resp.json()); } catch (e) { try { detalle = await resp.text(); } catch (e2) {} }
      console.error('revisar-vigencia: Resend rechazó un correo a', destinatario, '— status', resp.status, detalle);
      return false;
    }
    return true;
  } catch (err) {
    console.error('revisar-vigencia: no se pudo enviar correo a', destinatario, err);
    return false;
  }
}

// ---- borra por completo los datos de una ficha (llamado únicamente al llegar a "eliminada") ----
// Nunca lanza si algún objeto individual ya no existe (borrado parcial de un intento anterior, o
// una ficha que nunca llegó a tener foto/tarjeta) — solo registra el error y continúa con el resto.
async function borrarFichaCompleta(s3, carpeta, folio, datosPublicos) {
  const clavesABorrar = [];

  // JSON público (visor) — ubicación nueva y, por si acaso, la antigua (legacy, sin carpeta)
  clavesABorrar.push({ bucket: BUCKET_FICHAS, key: `${carpeta}/datos/${folio}.json` });
  clavesABorrar.push({ bucket: BUCKET_FICHAS, key: `datos/${folio}.json` });

  // PDF en español (el que siempre se genera) + posibles PDFs en otros idiomas
  clavesABorrar.push({ bucket: BUCKET_FICHAS, key: `${carpeta}/${folio}.pdf` });
  IDIOMAS_PDF.forEach((lang) => {
    clavesABorrar.push({ bucket: BUCKET_FICHAS, key: `${carpeta}/${folio}-${lang}.pdf` });
  });

  // Foto y tarjeta "Identificador QR" — se derivan de la URL guardada en el JSON público, para no
  // tener que adivinar la extensión del archivo
  const fotoKey = datosPublicos ? keyDesdeUrlPublica(datosPublicos.fotoUrl) : null;
  if (fotoKey) clavesABorrar.push({ bucket: BUCKET_FICHAS, key: fotoKey });
  const tarjetaKey = datosPublicos ? keyDesdeUrlPublica(datosPublicos.tarjetaUrl) : null;
  if (tarjetaKey) clavesABorrar.push({ bucket: BUCKET_FICHAS, key: tarjetaKey });

  // Código QR
  clavesABorrar.push({ bucket: BUCKET_QR, key: `${carpeta}/${folio}.svg` });

  // Registro de acceso (login/PIN) — ubicación nueva y la antigua (legacy)
  clavesABorrar.push({ bucket: BUCKET_RESUMEN, key: `${carpeta}/login/${folio}.json` });
  clavesABorrar.push({ bucket: BUCKET_RESUMEN, key: `login/${folio}.json` });

  for (const { bucket, key } of clavesABorrar) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
      if (!esNoExiste(err)) {
        console.error('revisar-vigencia: no se pudo borrar', bucket, key, err);
      }
    }
  }
}

async function procesarFicha(s3, apiKey, ahora, carpeta, key, contadores) {
  let registro;
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: key }));
    registro = JSON.parse(await streamToString(resp.Body));
  } catch (err) {
    if (!esNoExiste(err)) console.error('revisar-vigencia: no se pudo leer', key, err);
    return;
  }

  const folio = registro.folio || folioDesdeClave(key);
  const creado = registro.creado;
  if (!creado) return; // ficha sin fecha de vigencia registrada (de antes de este cambio) — no se procesa

  const venc = fechaVencimiento(creado);
  const gracia = finGracia(creado);
  if (!venc || !gracia) return;

  const estado = calcularEstado(creado, ahora);
  const avisosPrevios = (registro.vigencia && registro.vigencia.avisos) || {};
  const nuevosAvisos = { ...avisosPrevios };
  let huboAvisoNuevo = false;

  const correoDestino = (registro.correoTitular && String(registro.correoTitular).trim())
    || (registro.datosFormulario && registro.datosFormulario.emailcontacto1)
    || '';
  const nombre = nombreDesdeDatosFormulario(registro.datosFormulario, carpeta);
  const tipo = tipoFichaTexto(carpeta);
  const enlace = urlRenovacion(carpeta);
  const fechaVencTexto = formatearFechaCR(venc);
  const fechaGraciaTexto = formatearFechaCR(gracia);

  async function intentarAviso(flag, contenido) {
    if (avisosPrevios[flag]) return;
    const enviado = correoDestino ? await enviarCorreo(apiKey, correoDestino, contenido) : false;
    // si no hay correo destino registrado (ficha muy antigua sin ningún correo utilizable), se
    // marca igual como "enviado" para no reintentar por siempre algo que nunca va a poder
    // enviarse — pero si SÍ hay correo y Resend falló, no se marca, para reintentar mañana.
    if (enviado || !correoDestino) {
      nuevosAvisos[flag] = true;
      huboAvisoNuevo = true;
      if (contadores) contadores[flag] = (contadores[flag] || 0) + 1;
    }
  }

  if (estado === 'vigente') {
    const diasParaVencer = diasEntre(ahora, venc);
    if (diasParaVencer <= 30) {
      await intentarAviso('aviso30', correoAviso30(nombre, tipo, folio, fechaVencTexto, enlace));
    }
    if (diasParaVencer <= 7) {
      await intentarAviso('aviso7', correoAviso7(nombre, tipo, folio, fechaVencTexto, enlace));
    }
  } else if (estado === 'vencida') {
    await intentarAviso('avisoVencida', correoVencida(nombre, tipo, folio, fechaVencTexto, fechaGraciaTexto, enlace));
    const diasVencida = diasEntre(venc, ahora);
    if (diasVencida >= 30) {
      await intentarAviso('avisoGracia30', correoGracia30(nombre, tipo, folio, fechaVencTexto, enlace));
    }
    if (diasVencida >= 55) {
      await intentarAviso('avisoFinal55', correoFinal55(nombre, tipo, folio, fechaGraciaTexto, enlace));
    }
  } else if (estado === 'eliminada') {
    // ---- Eliminación definitiva (pasados los 2 meses de gracia) ----
    // Se envía primero la confirmación (si hay a quién), y solo después se borran los datos —
    // así, si el envío del correo falla, el borrado tampoco se ejecuta en esta corrida y se
    // reintenta mañana en vez de borrar en silencio sin haber podido avisar.
    if (avisosPrevios.eliminada) return; // ya se procesó en una corrida anterior; nada más que hacer
    const confirmado = correoDestino ? await enviarCorreo(apiKey, correoDestino, correoEliminada(nombre, tipo, folio, SITE_URL)) : true;
    if (!confirmado) return; // se reintenta mañana

    let datosPublicos = null;
    try {
      const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET_FICHAS, Key: `${carpeta}/datos/${folio}.json` }));
      datosPublicos = JSON.parse(await streamToString(resp.Body));
    } catch (err) {
      if (!esNoExiste(err)) console.error('revisar-vigencia: no se pudo leer el JSON público antes de borrar', folio, err);
    }

    await borrarFichaCompleta(s3, carpeta, folio, datosPublicos);
    if (contadores) contadores.eliminadas = (contadores.eliminadas || 0) + 1;
    return; // el registro de login ya se borró — no hay nada más que guardar
  }

  if (huboAvisoNuevo) {
    const nuevoRegistro = { ...registro, vigencia: { avisos: nuevosAvisos } };
    try {
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_RESUMEN,
        Key: key,
        Body: Buffer.from(JSON.stringify(nuevoRegistro), 'utf-8'),
        ContentType: 'application/json',
      }));
    } catch (err) {
      console.error('revisar-vigencia: no se pudo guardar las banderas de aviso para', folio, err);
    }
  }
}

exports.handler = async () => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('revisar-vigencia: falta configurar RESEND_API_KEY en Netlify — no se podrán enviar los avisos (sí se seguirá calculando/borrando lo vencido).');
  }

  let s3;
  try {
    s3 = getS3Client();
  } catch (err) {
    console.error('revisar-vigencia:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  const ahora = new Date();
  const contadores = {};
  let revisadas = 0;
  const errores = [];

  for (const carpeta of CARPETAS) {
    let claves = [];
    try {
      claves = await listarClaves(s3, BUCKET_RESUMEN, `${carpeta}/login/`);
    } catch (err) {
      console.error('revisar-vigencia: no se pudo listar', carpeta, err);
      errores.push(`${carpeta}: ${err.message}`);
      continue;
    }
    for (const key of claves) {
      try {
        await procesarFicha(s3, apiKey, ahora, carpeta, key, contadores);
        revisadas++;
      } catch (err) {
        console.error('revisar-vigencia: error procesando', key, err);
        errores.push(`${key}: ${err.message}`);
      }
    }
  }

  // ---- ubicación antigua (legacy, de antes de organizar por carpetas) — el folio mismo dice el
  // tipo real, así que se resuelve caso por caso dentro de procesarFicha (vía carpetaDesdeFolio al
  // leer datosFormulario/contactos no hace falta aquí; la carpeta correcta para derivar las URLs
  // de S3 sí importa, así que se pasa la que corresponde según el folio) ----
  let clavesLegacy = [];
  try {
    clavesLegacy = await listarClaves(s3, BUCKET_RESUMEN, 'login/');
  } catch (err) {
    console.error('revisar-vigencia: no se pudo listar login/ (legacy)', err);
    errores.push(`login/ (legacy): ${err.message}`);
  }
  for (const key of clavesLegacy) {
    const folio = folioDesdeClave(key);
    const carpeta = carpetaDesdeFolio(folio);
    try {
      await procesarFicha(s3, apiKey, ahora, carpeta, key, contadores);
      revisadas++;
    } catch (err) {
      console.error('revisar-vigencia: error procesando (legacy)', key, err);
      errores.push(`${key}: ${err.message}`);
    }
  }

  console.log('revisar-vigencia: fichas revisadas =', revisadas, '— avisos/acciones =', JSON.stringify(contadores), errores.length ? `— errores: ${errores.length}` : '');
  return { statusCode: 200, body: JSON.stringify({ ok: true, revisadas, contadores, errores }) };
};
