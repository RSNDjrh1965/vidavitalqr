// ---- Netlify Function: recupera el folio + PIN de una ficha a partir de tres datos que debe
// aportar el usuario: el folio impreso en su placa/pulsera/código digital, su nombre completo, y
// su fecha de nacimiento (tal como quedaron guardados en la ficha). Los tres datos juntos actúan
// como verificación de identidad — se exige el folio además del nombre y la fecha de nacimiento
// porque estas dos últimas por sí solas son datos que otra persona podría conocer o adivinar, y
// no deben ser suficientes para acceder a información médica privada de alguien más.
//
// Igual que en login-ficha.js, nunca se revela cuál de los tres datos falló (folio inexistente,
// nombre que no coincide, o fecha que no coincide) — siempre el mismo mensaje genérico, para no
// facilitarle a alguien ir probando combinaciones.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';

// ---- carpeta de organización dentro del bucket, según el tipo de ficha (ver la misma función,
// con más detalle, en send-ficha.js) — el folio manda: "VVITALQR..." es persona,
// "VVMASCOTA..." es mascota; el campo "tipo" solo se usa como respaldo ----
function carpetaTipo(tipo, folio) {
  const f = String(folio || '').toUpperCase();
  if (f.startsWith('VVMASCOTA')) return 'mascotas';
  if (f.startsWith('VVITALQR')) return 'personas';
  return tipo === 'Mascota' ? 'mascotas' : 'personas';
}

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

// ---- normaliza un nombre para comparar sin distinguir mayúsculas/minúsculas, acentos, ni
// espacios de más (así "María José Ramírez" y "maria  jose ramirez" se consideran iguales) ----
function normalizarNombre(str) {
  return (str || '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

// ---- enmascara un correo para mostrarlo en pantalla sin revelarlo completo, p.ej.
// "ana.perez@gmail.com" -> "an***@gmail.com" ----
function enmascararCorreo(email) {
  const [usuario, dominio] = String(email || '').split('@');
  if (!usuario || !dominio) return email || '';
  const visible = usuario.slice(0, Math.min(2, usuario.length));
  return `${visible}${'*'.repeat(Math.max(3, usuario.length - visible.length))}@${dominio}`;
}

// ---- envía el folio + PIN por correo a los contactos registrados en la ficha, para la opción
// "enviármelo por correo" del panel de recuperación. No revela el PIN en la respuesta HTTP —
// solo confirma que se envió y a qué correo(s) (enmascarados), a diferencia de la opción "verlo
// en pantalla", que sí devuelve el PIN porque el usuario decidió verlo directamente. ----
async function enviarPinPorCorreo(correos, { folio, pin, nombreCompleto }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Falta configurar RESEND_API_KEY en Netlify.');

  const deQuien = nombreCompleto ? ` de "${nombreCompleto}"` : '';
  const asunto = `Tu PIN de acceso a la ficha VidaVitalQR${deQuien} — ${folio}`;
  const cuerpo = [
    `Este es el PIN de acceso vigente para la ficha${deQuien} en VidaVitalQR (folio ${folio}):`,
    '',
    `Folio: ${folio}`,
    `PIN de acceso: ${pin}`,
    '',
    'Lo solicitaste desde la sección de recuperación de PIN del sitio. Si tú no lo pediste, puedes ignorar este correo — nadie puede acceder a la ficha sin conocer también el folio, tu nombre completo y tu fecha de nacimiento.',
    '',
    'Este es un correo automático de VidaVitalQR.',
  ].join('\n');

  const envios = correos.map((email) =>
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: REMITENTE, to: [email], subject: asunto, text: cuerpo }),
    })
  );
  const resultados = await Promise.allSettled(envios);
  const algunoOk = resultados.some((r) => r.status === 'fulfilled' && r.value && r.value.ok);
  if (!algunoOk) throw new Error('Resend no pudo enviar el correo.');
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

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
  const nombreCompleto = normalizarNombre(payload.nombreCompleto);
  const fnac = String(payload.fnac || '').trim();
  const accion = payload.accion === 'correo' ? 'correo' : 'ver';
  const carpeta = carpetaTipo(payload.tipo, folio);

  const respuestaInvalida = {
    statusCode: 401,
    headers,
    body: JSON.stringify({ error: 'No pudimos verificar los datos. Revisa el código de tu ficha, el nombre completo y la fecha de nacimiento.' }),
  };

  if (!folio || !nombreCompleto || !fnac) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Faltan el código de la ficha, el nombre completo o la fecha de nacimiento.' }) };
  }

  try {
    const s3 = getS3Client();
    let registro;
    try {
      const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: `${carpeta}/login/${folio}.json` }));
      registro = JSON.parse(await streamToString(resp.Body));
    } catch (err) {
      const noExiste = err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
      if (!noExiste) throw err;
      // ficha todavía no migrada a la carpeta nueva — se busca en la ubicación anterior
      const respLegacy = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: `login/${folio}.json` }));
      registro = JSON.parse(await streamToString(respLegacy.Body));
    }

    if (!registro.pin) {
      // registro de una versión anterior sin PIN en texto plano — no hay nada que devolver
      return respuestaInvalida;
    }

    const datos = registro.datosFormulario || {};
    // variantes aceptadas del nombre guardado: "nombres apellidos", "apellidos nombres", y cada
    // uno por separado — esto último para la ficha de mascota, donde "apellidos" en realidad es
    // el alias/sobrenombre (opcional) y no siempre lo escribe el usuario al recuperar el PIN.
    const variantesNombre = [
      `${datos.nombres || ''} ${datos.apellidos || ''}`,
      `${datos.apellidos || ''} ${datos.nombres || ''}`,
      datos.nombres || '',
      datos.apellidos || '',
    ].map(normalizarNombre).filter(Boolean);
    const fnacGuardada = String(datos.fnac || '').trim();

    const coincideNombre = variantesNombre.includes(nombreCompleto);
    const coincideFecha = Boolean(fnacGuardada) && fnac === fnacGuardada;

    if (!coincideNombre || !coincideFecha) {
      return respuestaInvalida;
    }

    // ---- opción "verlo en pantalla": se devuelve el PIN directamente, porque el usuario ya
    // pasó la verificación de tres factores y decidió mostrarlo él mismo ----
    if (accion !== 'correo') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, folio, pin: registro.pin }),
      };
    }

    // ---- opción "enviarlo por correo": nunca se devuelve el PIN en la respuesta — se envía
    // directamente a los correos de contacto guardados en la ficha, y solo se confirma que se
    // envió (con el correo enmascarado, para que el usuario sepa a cuál bandeja revisar) ----
    const correos = Array.from(new Set(
      [datos.emailcontacto1, datos.emailcontacto2]
        .map((e) => (e ? String(e).trim() : ''))
        .filter(Boolean)
    ));
    if (correos.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Esta ficha no tiene un correo de contacto registrado. Usa la opción de verlo en pantalla.' }),
      };
    }

    try {
      await enviarPinPorCorreo(correos, { folio, pin: registro.pin, nombreCompleto: `${datos.nombres || ''} ${datos.apellidos || ''}`.trim() });
    } catch (err) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'No se pudo enviar el correo. Intenta con la opción de verlo en pantalla.', detalle: String(err) }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, correo: correos.map(enmascararCorreo).join(', ') }),
    };
  } catch (err) {
    const noExiste = err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
    if (noExiste) return respuestaInvalida;
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'No se pudo procesar la recuperación.', detalle: String(err) }) };
  }
};
