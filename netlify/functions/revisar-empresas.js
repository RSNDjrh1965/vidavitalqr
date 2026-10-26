// ---- revisar-empresas.js (Etapa 1 de tarjetas para empresas, 2026-10-20) ----
// Función PROGRAMADA (una vez al día, ver netlify.toml). Recorre las empresas registradas con
// admin-empresas.js y envía avisos por correo A LA EMPRESA, con copia oculta a James:
//   - a los 3 meses del pago:  lista de folios que siguen "sin activar" (recordatorio para sus trabajadores)
//   - a los 9 meses del pago:  lo mismo, con aviso de que faltan 3 meses para el vencimiento
//   - 2026-10-22 (Etapa 3): a 30 días de vencer, y otra vez cuando vence (período de gracia), un aviso de RENOVACIÓN con el
//     enlace para renovar y pagar en línea por ONVO (/empresas.html?renovar=...). Se anotan como renov30 / renovVenc.
// Los avisos de VENCIMIENTO no se tocan: son los mismos de siempre (revisar-vigencia.js, a 30 y 7
// días, vencida, gracia y eliminación) y también aplican a las fichas de empresa.
// Cada aviso se envía UNA sola vez por año de vigencia (se anota en empresas/<id>/avisos.json; la
// acción "renovar" de admin-empresas.js reinicia las marcas). La lista lleva SOLO folios: nunca
// nombres ni datos de los trabajadores. Los lotes de PRUEBA no envían avisos.
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { sumarMeses, finGracia, MS_POR_DIA } = require('./lib/vigencia');
const { firmarEmpresa } = require('./lib/enlace-qr');
const { calcularRenovacion, PRECIO_RENOVACION, MIN_FICHAS_RENOVACION } = require('./lib/lote-empresa');
const { idEmpresaValido, leerJson, escribirJson, claveLote, claveAvisos } = require('./lib/empresa');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';
const DESTINATARIO_JAMES = 'roljamher@hotmail.com';
const WHATSAPP = '+506 6093-3090';

function getS3Client() {
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('Faltan configurar S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en Netlify.');
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

async function listar(s3, prefijo, delimitador) {
  const claves = []; const prefijos = []; let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET_RESUMEN, Prefix: prefijo, Delimiter: delimitador, ContinuationToken: token }));
    (r.Contents || []).forEach((o) => { if (o.Key) claves.push(o.Key); });
    (r.CommonPrefixes || []).forEach((p) => { if (p.Prefix) prefijos.push(p.Prefix); });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return { claves, prefijos };
}

function fechaCorta(d) {
  return new Date(d).toLocaleDateString('es-CR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Costa_Rica' });
}

async function enviar(apiKey, { to, asunto, texto }) {
  if (!apiKey) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: REMITENTE, to: [to], bcc: [DESTINATARIO_JAMES], subject: asunto, text: texto }),
    });
    if (!r.ok) console.error('revisar-empresas: Resend rechazó el envío', r.status, await r.text());
    return r.ok;
  } catch (err) {
    console.error('revisar-empresas: error enviando correo', err);
    return false;
  }
}

function enlaceRenovacion(id) {
  const firma = firmarEmpresa(id);
  return firma ? `${process.env.SITE_URL || 'https://vidavitalqr.com'}/empresas.html?renovar=${encodeURIComponent(id)}&t=${firma}` : '';
}

function textoRenovacion(lote, id, activas, vencida, venc) {
  const pr = calcularRenovacion(activas);
  const enlace = enlaceRenovacion(id);
  return [
    `Hola, equipo de ${lote.nombre}:`,
    '',
    vencida
      ? `La vigencia de sus Identificadores QR de VidaVitalQR venció el ${fechaCorta(venc)}. Las fichas siguen mostrando la información esencial de emergencia durante 2 meses más; después se eliminan. Para mantenerlas, renueven ahora.`
      : `La vigencia de sus Identificadores QR de VidaVitalQR vence el ${fechaCorta(venc)} (en unos 30 días). Pueden renovar desde ya y no se pierde ningún día: los 12 meses nuevos se suman al vencimiento actual.`,
    '',
    `Renovación anual de la empresa: $${PRECIO_RENOVACION} por ficha activa (mínimo ${MIN_FICHAS_RENOVACION} fichas) + IVA, con un solo pago por todo el grupo. Hoy tienen ${activas} ficha(s) activa(s): ${pr.fichasCobradas} × $${pr.precioUnitario} + IVA = $${pr.totalUSD.toFixed(2)}.`,
    '',
    ...(enlace ? ['Renueven aquí (pago seguro con ONVO Pay):', enlace, ''] : []),
    `Cualquier consulta: WhatsApp ${WHATSAPP}.`,
    '',
    'Este correo fue generado automáticamente por VidaVitalQR.',
  ].join('\n');
}

function textoSinActivar(lote, sinActivar, meses) {
  const restante = meses === 9
    ? 'Faltan 3 meses para que venza la vigencia de este lote.'
    : 'Su vigencia es de 12 meses contados desde el día del pago.';
  return [
    `Hola, equipo de ${lote.nombre}:`,
    '',
    `Han pasado ${meses} meses desde el pago de sus Identificadores QR de VidaVitalQR, y estos folios todavía no han sido activados (la ficha no se ha llenado):`,
    '',
    ...sinActivar.map((f) => `  - ${f}`),
    '',
    `Les recordamos hacerlo llegar a las personas que aún no llenan su ficha. ${restante}`,
    'Cada trabajador usa el enlace que se les entregó; su información médica y su PIN son personales y la empresa no tiene acceso a ellos.',
    '',
    `Cualquier consulta: WhatsApp ${WHATSAPP}.`,
    '',
    'Este correo fue generado automáticamente por VidaVitalQR.',
  ].join('\n');
}

exports.handler = async () => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) console.error('revisar-empresas: falta RESEND_API_KEY — no se enviarán avisos.');
  let s3;
  try { s3 = getS3Client(); } catch (err) {
    console.error('revisar-empresas:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
  const ahora = new Date();
  const resumen = { empresas: 0, aviso3: 0, aviso9: 0, renov30: 0, renovVenc: 0, errores: [] };

  let prefijos = [];
  try { prefijos = (await listar(s3, 'empresas/', '/')).prefijos; } catch (err) {
    console.error('revisar-empresas: no se pudo listar empresas', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  for (const pref of prefijos) {
    const id = pref.replace(/^empresas\//, '').replace(/\/$/, '');
    if (!idEmpresaValido(id)) continue;
    try {
      const lote = await leerJson(s3, BUCKET_RESUMEN, claveLote(id));
      if (!lote || lote.prueba === true || !lote.fechaPago || !lote.correo) continue;
      resumen.empresas++;
      const avisos = (await leerJson(s3, BUCKET_RESUMEN, claveAvisos(id))) || {};
      const pago = new Date(lote.fechaPago);
      const hito3 = sumarMeses(pago, 3);
      const hito9 = sumarMeses(pago, 9);
      const venc = new Date(lote.vencimiento || sumarMeses(pago, 12));

      // folios del lote (se lee solo si hay algún aviso por evaluar)
      const gracia = finGracia(lote.fechaPago);
      const hayRenov30 = ahora >= new Date(venc.getTime() - 30 * MS_POR_DIA) && ahora < venc && !avisos.renov30;
      const hayRenovVenc = ahora >= venc && (!gracia || ahora < gracia) && !avisos.renovVenc;
      const hayPendiente = (ahora >= hito3 && !avisos.aviso3) || (ahora >= hito9 && !avisos.aviso9) || hayRenov30 || hayRenovVenc;
      if (!hayPendiente) continue;
      const { claves } = await listar(s3, `empresas/${id}/folios/`);
      const folios = [];
      for (const k of claves) { if (k.endsWith('.json')) { const r = await leerJson(s3, BUCKET_RESUMEN, k); if (r) folios.push(r); } }
      const sinActivar = folios.filter((f) => f.estado === 'sin_activar').map((f) => f.folio).sort();
      let cambio = false;

      // aviso de RENOVACIÓN (Etapa 3): si se despliega tarde y ya venció, solo se manda el de vencimiento
      if (hayRenov30 || hayRenovVenc) {
        const activas = folios.filter((f) => f.estado === 'activa').length;
        if (activas > 0 && firmarEmpresa(id)) {
          const vencida = hayRenovVenc;
          const ok = await enviar(apiKey, { to: lote.correo, asunto: vencida ? `Venció la vigencia — renueve sus Identificadores QR — ${lote.nombre}` : `Renueve sus Identificadores QR (vencen en 30 días) — ${lote.nombre}`, texto: textoRenovacion(lote, id, activas, vencida, venc) });
          if (ok) { if (vencida) { avisos.renovVenc = true; avisos.renov30 = true; resumen.renovVenc++; } else { avisos.renov30 = true; resumen.renov30++; } cambio = true; }
        } else { if (hayRenovVenc) avisos.renovVenc = true; avisos.renov30 = true; cambio = true; }
      }

      // a los 9 meses se evalúa primero: si el sistema se despliega tarde, no se mandan dos avisos seguidos
      if (ahora >= hito9 && !avisos.aviso9) {
        if (ahora < venc && sinActivar.length) {
          const ok = await enviar(apiKey, { to: lote.correo, asunto: `Folios sin activar — ${lote.nombre} (9 meses)`, texto: textoSinActivar(lote, sinActivar, 9) });
          if (ok) { avisos.aviso9 = true; avisos.aviso3 = true; resumen.aviso9++; cambio = true; }
        } else { avisos.aviso9 = true; avisos.aviso3 = true; cambio = true; }
      } else if (ahora >= hito3 && ahora < hito9 && !avisos.aviso3) {
        if (sinActivar.length) {
          const ok = await enviar(apiKey, { to: lote.correo, asunto: `Folios sin activar — ${lote.nombre} (3 meses)`, texto: textoSinActivar(lote, sinActivar, 3) });
          if (ok) { avisos.aviso3 = true; resumen.aviso3++; cambio = true; }
        } else { avisos.aviso3 = true; cambio = true; }
      }

      if (cambio) await escribirJson(s3, BUCKET_RESUMEN, claveAvisos(id), avisos);
    } catch (err) {
      console.error('revisar-empresas: error con la empresa', id, err);
      resumen.errores.push(`${id}: ${err.message}`);
    }
  }
  console.log('revisar-empresas:', JSON.stringify(resumen));
  return { statusCode: 200, body: JSON.stringify({ ok: true, ...resumen }) };
};
