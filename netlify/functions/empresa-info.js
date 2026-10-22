// ---- empresa-info.js (Etapa 1 de tarjetas para empresas, 2026-10-20) ----
// La ficha (ficha.html) la llama al abrirse con un enlace de empresa (?e=<empresa>&f=<folio>) para
// mostrar el recuadro verde de arriba: logo, nombre y correo de la empresa. También devuelve si el
// folio todavía está "sin activar" (se puede llenar la ficha) o ya está "activa".
//
// Responde SOLO si el par empresa+folio existe en el registro que creó James con su herramienta;
// con cualquier otra combinación responde 404 genérico (no revela si existe la empresa).
// Nunca devuelve PIN, datos del trabajador, ni la lista de folios de la empresa.
// El logo viaja como data URL (base64) leído desde el bucket privado de resumen, para que la
// tarjeta que se arma en el navegador lo pueda incrustar sin problemas de permisos (CORS).
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { folioSeguro, estaBloqueado, anotar, ipDe } = require('./lib/limite');
const { cargarFolioDeEmpresa, streamToBuffer } = require('./lib/empresa');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';

function getS3Client() {
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Faltan configurar S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en Netlify.');
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

const TIPOS = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  const q = event.queryStringParameters || {};
  const empresaId = String(q.e || '').trim().toLowerCase();
  const folio = folioSeguro(q.f);
  const noEncontrado = { statusCode: 404, headers, body: JSON.stringify({ error: 'Enlace no válido.' }) };
  if (!empresaId || !folio) return noEncontrado;

  try {
    const s3 = getS3Client();
    // límite contra quien pruebe muchos enlaces al azar: 60 consultas por conexión cada 15 minutos
    const ip = ipDe(event);
    if (await estaBloqueado(s3, BUCKET_RESUMEN, 'empresa-info-ip', ip, 60, 15 * 60 * 1000)) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Demasiadas consultas. Espere unos minutos.' }) };
    }
    await anotar(s3, BUCKET_RESUMEN, 'empresa-info-ip', ip, 15 * 60 * 1000);

    const encontrado = await cargarFolioDeEmpresa(s3, BUCKET_RESUMEN, empresaId, folio);
    if (!encontrado) return noEncontrado;
    const { lote, registroFolio } = encontrado;

    let logo = '';
    if (lote.logoKey) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RESUMEN, Key: lote.logoKey }));
        const buf = await streamToBuffer(r.Body);
        const ext = String(lote.logoKey.split('.').pop() || '').toLowerCase();
        const tipo = TIPOS[ext] || 'image/png';
        logo = `data:${tipo};base64,${buf.toString('base64')}`;
      } catch (err) {
        console.error('empresa-info: no se pudo leer el logo', lote.logoKey, err);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        empresaId,
        folio,
        nombre: lote.nombre || '',
        correo: lote.correo || '',
        logo,
        // 'sin_activar' es el único estado que deja llenar la ficha; 'activa' y 'eliminada' no
        estado: registroFolio.estado === 'sin_activar' ? 'sin_activar' : 'activa',
        prueba: lote.prueba === true,
      }),
    };
  } catch (err) {
    console.error('empresa-info: error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'No se pudo consultar la empresa.' }) };
  }
};
