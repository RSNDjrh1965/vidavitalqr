// ---- preparar-impresion.js (Automatización de tarjetas de empresa, 2026-10-23) ----
// Función PROGRAMADA (una vez al día, ver netlify.toml). Calendario acordado con James, contado desde el pago:
//   - Semanas 1-2 (hasta el día 14): la empresa y sus colaboradores completan las fichas.
//   - Día 10: recordatorio a la empresa con los folios que siguen sin activar (solo folios, nunca datos personales).
//   - Día 14 (semana 3): se arma el PDF "listo para imprenta" con las tarjetas de las fichas ya activadas y se le
//     envía a James por correo (adjunto). También queda copia en S3: empresas/<id>/imprenta/. Aviso a la empresa.
//   - Día 21 (semana 4): aviso a la empresa (envío en curso / listo para retirar) y recordatorio a James de enviar o entregar.
//   - Después: las fichas activadas tarde se imprimen en un lote extra como máximo una vez por semana.
// Solo lotes FÍSICOS reales (no digitales ni de prueba). Es idempotente: lo ya hecho se anota en empresas/<id>/impresion.json.
// Para no pasarse del tiempo de una función programada, cada ejecución arma como máximo UN PDF (hasta 60 tarjetas);
// si una empresa tiene más, el resto sale en las ejecuciones de los días siguientes.
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { MS_POR_DIA } = require('./lib/vigencia');
const { idEmpresaValido, leerJson, escribirJson, claveLote, claveTarjeta, esNoExiste, streamToBuffer } = require('./lib/empresa');
const { construirPdf, MAX_TARJETAS_POR_PDF } = require('./lib/impresion-empresa');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const REMITENTE = 'VidaVitalQR <ficha@vidavitalqr.com>';
const DESTINATARIO_JAMES = 'roljamher@hotmail.com';
const WHATSAPP = '+506 6093-3090';
const DIA_RECORDATORIO = 10, DIA_IMPRESION = 14, DIA_ENTREGA = 21, DIAS_ENTRE_LOTES_EXTRA = 7;
const LIMITE_MS = 20000;

const claveImpresion = (id) => `empresas/${id}/impresion.json`;

function getS3Client() {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID, secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('Faltan configurar S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en Netlify.');
  return new S3Client({ region: process.env.S3_REGION || 'us-east-1', credentials: { accessKeyId, secretAccessKey } });
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

async function leerBuffer(s3, key) {
  try { const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: key })); return await streamToBuffer(r.Body); }
  catch (err) { if (esNoExiste(err)) return null; throw err; }
}

async function enviar(apiKey, { to, bcc, asunto, texto, adjuntos }) {
  if (!apiKey) return false;
  try {
    const body = { from: REMITENTE, to: [to], subject: asunto, text: texto };
    if (bcc) body.bcc = [bcc];
    if (adjuntos && adjuntos.length) body.attachments = adjuntos;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) console.error('preparar-impresion: Resend rechazó el envío', r.status, await r.text());
    return r.ok;
  } catch (err) { console.error('preparar-impresion: error enviando correo', err); return false; }
}

const fechaCorta = (d) => new Date(d).toLocaleDateString('es-CR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Costa_Rica' });
const aEmpresa = (apiKey, lote, asunto, lineas) => enviar(apiKey, {
  to: lote.correo, bcc: DESTINATARIO_JAMES, asunto,
  texto: [`Hola, equipo de ${lote.nombre}:`, '', ...lineas, '', `Cualquier consulta: WhatsApp ${WHATSAPP}.`, '', 'Este correo fue generado automáticamente por VidaVitalQR.'].join('\n'),
});
const aJames = (apiKey, asunto, lineas, adjuntos) => enviar(apiKey, { to: DESTINATARIO_JAMES, asunto, texto: lineas.join('\n'), adjuntos });

async function procesarEmpresa(s3, apiKey, id, lote, ahora, presupuesto) {
  const dias = Math.floor((ahora.getTime() - new Date(lote.fechaPago).getTime()) / MS_POR_DIA);
  if (dias < DIA_RECORDATORIO) return { accion: 'espera' };
  const imp = (await leerJson(s3, BUCKET_RESUMEN, claveImpresion(id))) || { impresas: {}, lotes: [], hitos: {} };
  imp.impresas = imp.impresas || {}; imp.lotes = imp.lotes || []; imp.hitos = imp.hitos || {};
  const h = imp.hitos;
  let cambio = false; let accion = 'nada';

  const { claves } = await listar(s3, `empresas/${id}/folios/`);
  const folios = [];
  for (const k of claves) { if (k.endsWith('.json')) { const r = await leerJson(s3, BUCKET_RESUMEN, k); if (r && r.folio) folios.push(r); } }
  const sinActivar = folios.filter((f) => f.estado === 'sin_activar').map((f) => f.folio).sort();
  const activas = folios.filter((f) => f.estado === 'activa').map((f) => f.folio).sort();
  const entrega = lote.retiroPersona ? 'RETIRO EN PERSONA (la empresa pasa a retirarlas; hay que avisarle cuando estén listas)' : 'ENVÍO (coordinar dirección con la empresa por correo o WhatsApp)';

  // Día 10: recordatorio de fichas pendientes (solo si hay)
  if (dias >= DIA_RECORDATORIO && !h.dia10) {
    if (sinActivar.length && dias < DIA_IMPRESION) {
      const ok = await aEmpresa(apiKey, lote, 'Recordatorio: faltan fichas por completar — VidaVitalQR', [
        `Les quedan unos días para que sus colaboradores completen la ficha: las tarjetas se mandan a imprimir el ${fechaCorta(new Date(new Date(lote.fechaPago).getTime() + DIA_IMPRESION * MS_POR_DIA))} (a las 2 semanas del pago).`,
        '', `Folios que siguen sin activar (${sinActivar.length}):`, '', ...sinActivar.map((f) => `  - ${f}`), '',
        'Las fichas que se completen después de esa fecha no se pierden: se imprimen en un lote adicional (como máximo uno por semana), por lo que su entrega se atrasa.',
      ]);
      if (ok) { h.dia10 = ahora.toISOString(); cambio = true; accion = 'recordatorio'; }
    } else { h.dia10 = ahora.toISOString(); cambio = true; }
  }

  // Día 14 en adelante: lote de impresión (un PDF por ejecución)
  if (dias >= DIA_IMPRESION && presupuesto.pdfs > 0) {
    const primera = !h.primera;
    const ultimo = imp.lotes.length ? new Date(imp.lotes[imp.lotes.length - 1].fecha) : null;
    const puedeExtra = primera || !h.primeraCompleta || !ultimo || (ahora.getTime() - ultimo.getTime()) >= DIAS_ENTRE_LOTES_EXTRA * MS_POR_DIA;
    const nuevas = activas.filter((f) => !imp.impresas[f]);
    if (nuevas.length && puedeExtra) {
      const tomar = [];
      const jpgs = []; const sinTarjeta = [];
      for (const f of nuevas) {
        if (tomar.length >= MAX_TARJETAS_POR_PDF) break;
        const buf = await leerBuffer(s3, claveTarjeta(id, f));
        if (buf) { tomar.push(f); jpgs.push(buf); } else sinTarjeta.push(f);
      }
      if (tomar.length) {
        const pdf = await construirPdf(jpgs);
        const n = imp.lotes.length + 1;
        const nombre = `tarjetas-${id}-lote${n}-${ahora.toISOString().slice(0, 10)}.pdf`;
        await s3.send(new PutObjectCommand({ Bucket: BUCKET_RESUMEN, Key: `empresas/${id}/imprenta/${nombre}`, Body: pdf, ContentType: 'application/pdf' }));
        const restantes = nuevas.length - tomar.length - sinTarjeta.length;
        const ok = await aJames(apiKey, `🖨 Tarjetas para imprimir — ${lote.nombre} (lote ${n}, ${tomar.length} tarjetas)`, [
          `Empresa: ${lote.nombre}   (${id})`, `Correo: ${lote.correo}${lote.telefono ? '   Teléfono: ' + lote.telefono : ''}`,
          `Pago: ${fechaCorta(lote.fechaPago)} (día ${dias})`, `Entrega: ${entrega}`, '',
          `Este PDF trae ${tomar.length} tarjeta(s), una por página: tarjeta final 54 × 85.6 mm (vertical) centrada en hoja de 68 × 99.6 mm, con sangrado de 3 mm y marcas de corte.`,
          `Folios: ${tomar.join(', ')}`, '',
          `Resumen del lote de la empresa: ${activas.length} activa(s) · ${sinActivar.length} sin activar · ${Object.keys(imp.impresas).length + tomar.length} ya enviadas a imprenta.`,
          ...(restantes > 0 ? [`Quedan ${restantes} tarjeta(s) por armar: llegan en el correo de mañana.`] : []),
          ...(sinTarjeta.length ? [`⚠ Fichas activas SIN imagen de tarjeta en S3 (revisar a mano): ${sinTarjeta.join(', ')}`] : []),
          '', 'Reenvíe el PDF a la imprenta. Si la imprenta pide otro sangrado o formato, avíseme y lo ajusto.',
        ], [{ filename: nombre, content: pdf.toString('base64') }]);
        if (ok) {
          tomar.forEach((f) => { imp.impresas[f] = nombre; });
          imp.lotes.push({ n, fecha: ahora.toISOString(), cantidad: tomar.length, pdf: nombre });
          presupuesto.pdfs--; cambio = true; accion = 'pdf';
          if (primera) h.primera = ahora.toISOString();
          if (restantes <= 0) {
            if (!h.primeraCompleta) h.primeraCompleta = ahora.toISOString();
            if (!h.avisoImpresion) {
              const okE = await aEmpresa(apiKey, lote, 'Sus tarjetas ya van a imprenta — VidaVitalQR', [
                `Ya enviamos a imprimir ${imp.lotes.reduce((a, l) => a + l.cantidad, 0)} tarjeta(s) con las fichas completadas.`,
                lote.retiroPersona ? 'Cuando estén listas les avisamos para que pasen a retirarlas (semana 4 desde el pago).' : 'El envío se realiza en la semana 4 desde el pago; les escribiremos para confirmar la dirección y darles el seguimiento.',
                ...(sinActivar.length ? ['', `Quedan ${sinActivar.length} folio(s) sin activar; si se completan después se imprimen en un lote adicional (como máximo uno por semana).`] : []),
              ]);
              if (okE) h.avisoImpresion = ahora.toISOString();
            }
          }
        }
      } else if (sinTarjeta.length && !h.alertaSinTarjeta) {
        await aJames(apiKey, `⚠ ${lote.nombre}: fichas activas sin imagen de tarjeta`, [`No se encontró la imagen de tarjeta en S3 para: ${sinTarjeta.join(', ')}`, 'Revise empresas/' + id + '/tarjetas/ en el bucket.']);
        h.alertaSinTarjeta = ahora.toISOString(); cambio = true;
      }
    } else if (primera && !nuevas.length) {
      // día 14 sin ninguna ficha activa: se avisa una vez a James
      const ok = await aJames(apiKey, `⚠ ${lote.nombre}: llegó el día 14 y NO hay fichas activas`, [
        `Empresa: ${lote.nombre} (${id}). Pago ${fechaCorta(lote.fechaPago)}. No hay nada que imprimir todavía (${sinActivar.length} folio(s) sin activar).`,
        'Las fichas que se activen después se armarán en un lote extra (como máximo uno por semana).']);
      if (ok) { h.primera = ahora.toISOString(); h.primeraCompleta = ahora.toISOString(); cambio = true; accion = 'sin-activas'; }
    }
  }

  // Día 21: aviso a la empresa y recordatorio a James (solo cuando ya se armó el primer lote completo)
  if (dias >= DIA_ENTREGA && h.primeraCompleta && !h.dia21 && imp.lotes.length) {
    const okE = await aEmpresa(apiKey, lote, lote.retiroPersona ? 'Sus tarjetas estarán listas para retirar — VidaVitalQR' : 'Sus tarjetas están por enviarse — VidaVitalQR', [
      lote.retiroPersona
        ? 'Estamos en la semana de entrega: les avisaremos por correo o WhatsApp en cuanto las tarjetas estén listas para que pasen a retirarlas.'
        : 'Estamos en la semana de envío: les escribiremos para confirmar la dirección y enviarles el número de seguimiento.',
    ]);
    const okJ = await aJames(apiKey, `📦 Semana de entrega: ${lote.nombre}`, [
      `Ya es el día ${dias} del pago de ${lote.nombre} (${id}). Toca ${lote.retiroPersona ? 'dejar listas las tarjetas para retiro y avisarles' : 'enviar las tarjetas y pasarles el seguimiento'}.`,
      `Entrega: ${entrega}`, `Contacto: ${lote.correo}${lote.telefono ? ' · ' + lote.telefono : ''}`,
      `Tarjetas enviadas a imprenta: ${Object.keys(imp.impresas).length}.`,
    ]);
    if (okE || okJ) { h.dia21 = ahora.toISOString(); cambio = true; }
  }

  if (cambio) await escribirJson(s3, BUCKET_RESUMEN, claveImpresion(id), imp);
  return { accion };
}

exports.handler = async () => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) console.error('preparar-impresion: falta RESEND_API_KEY — no se enviará nada.');
  let s3;
  try { s3 = getS3Client(); } catch (err) { console.error('preparar-impresion:', err.message); return { statusCode: 500, body: JSON.stringify({ error: err.message }) }; }
  const ahora = new Date(); const t0 = Date.now();
  const presupuesto = { pdfs: 1 };
  const resumen = { empresas: 0, pdfs: 0, recordatorios: 0, errores: [] };
  let prefijos = [];
  try { prefijos = (await listar(s3, 'empresas/', '/')).prefijos; } catch (err) {
    console.error('preparar-impresion: no se pudo listar empresas', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
  for (const pref of prefijos) {
    if (Date.now() - t0 > LIMITE_MS) break;
    const id = pref.replace(/^empresas\//, '').replace(/\/$/, '');
    if (!idEmpresaValido(id)) continue;
    try {
      const lote = await leerJson(s3, BUCKET_RESUMEN, claveLote(id));
      if (!lote || lote.prueba === true || lote.modalidad === 'digital' || !lote.fechaPago || !lote.correo) continue;
      resumen.empresas++;
      const r = await procesarEmpresa(s3, apiKey, id, lote, ahora, presupuesto);
      if (r.accion === 'pdf') resumen.pdfs++;
      if (r.accion === 'recordatorio') resumen.recordatorios++;
    } catch (err) {
      console.error('preparar-impresion: error con la empresa', id, err);
      resumen.errores.push(`${id}: ${err.message}`);
    }
  }
  console.log('preparar-impresion:', JSON.stringify(resumen));
  return { statusCode: 200, body: JSON.stringify(resumen) };
};
