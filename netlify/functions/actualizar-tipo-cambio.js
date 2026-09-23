// ---- actualizar-tipo-cambio.js ----
// Función PROGRAMADA (una vez al día, ver netlify.toml) que consulta el tipo de cambio de
// referencia de VENTA del dólar publicado por el Banco Central de Costa Rica (ver
// lib/bccr.js), le suma un margen del 2% y redondea siempre hacia ARRIBA al colón entero, y
// guarda el resultado en el bucket privado de resumen (el mismo que usa guardar-envio.js) para
// que crear-pago.js y el front-end (tipo-cambio.js) lo usen sin tener que volver a consultar al
// BCCR en cada pago.
//
// Por qué se suma el margen y se redondea hacia arriba: el BCCR solo publica el dato una vez al
// día (días hábiles), así que puede pasar hasta 24 horas (o más, en fin de semana/feriados) entre
// que se actualiza este valor y el momento en que un cliente realmente paga. El margen del 2% y
// el redondeo hacia arriba evitan que el negocio reciba menos dólares de los que debería si el
// tipo de cambio sube mientras tanto.
//
// Requiere estas variables de entorno en Netlify (Project configuration → Environment variables):
//   BCCR_API_TOKEN — token "Bearer" de la API nueva del BCCR (SDDE), generado en el portal del
//                    BCCR en "Mi perfil → Generar token". Es el método preferido — ver lib/bccr.js.
//   BCCR_CORREO / BCCR_TOKEN — correo y token del servicio viejo del BCCR (respaldo automático,
//                    si la API nueva llegara a fallar; puede faltar y la función sigue intentando
//                    con la API nueva).
//   (además de las mismas S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_REGION / S3_BUCKET_RESUMEN
//   que ya usa guardar-envio.js).
// Ninguna debe escribirse en este archivo ni en ningún otro que se suba al repositorio.
//
// Se programa en netlify.toml con [functions."actualizar-tipo-cambio"] schedule = "...". También
// se puede llamar a mano (GET o POST a /.netlify/functions/actualizar-tipo-cambio) para probarla
// o para forzar una actualización inmediata sin esperar al horario programado.

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { obtenerTipoCambioVentaOficial } = require('./lib/bccr');

const BUCKET_RESUMEN = process.env.S3_BUCKET_RESUMEN || 'resumen-vidavitalqr';
const TIPO_CAMBIO_KEY = 'config/tipo-cambio.json';
const MARGEN = 0.02; // 2% de margen sobre el tipo de cambio oficial de venta del BCCR

function getS3Client() {
  const region = process.env.S3_REGION || 'us-east-1';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Faltan configurar S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en Netlify.');
  }
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

exports.handler = async () => {
  const apiToken = process.env.BCCR_API_TOKEN;
  const correo = process.env.BCCR_CORREO;
  const token = process.env.BCCR_TOKEN;
  if (!apiToken && !(correo && token)) {
    console.error('actualizar-tipo-cambio: faltan las variables de entorno del BCCR en Netlify (BCCR_API_TOKEN, o BCCR_CORREO + BCCR_TOKEN).');
    return { statusCode: 500, body: JSON.stringify({ error: 'Falta configurar BCCR_API_TOKEN (o BCCR_CORREO + BCCR_TOKEN) en Netlify.' }) };
  }

  let oficial;
  try {
    oficial = await obtenerTipoCambioVentaOficial({ apiToken, correo, token, nombre: 'VidaVitalQR' });
  } catch (err) {
    console.error('actualizar-tipo-cambio: no se pudo consultar el BCCR —', err.message);
    return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo consultar el tipo de cambio del BCCR: ' + err.message }) };
  }

  // ---- se suma el margen y se redondea SIEMPRE hacia arriba, al colón entero ----
  const conMargen = Math.ceil(oficial * (1 + MARGEN));

  const registro = {
    tipoCambioOficialVenta: oficial,
    margen: MARGEN,
    tipoCambio: conMargen,
    fuente: 'BCCR — indicador 318 (tipo de cambio de referencia de venta) + 2% de margen, redondeado hacia arriba',
    actualizado: new Date().toISOString(),
  };

  try {
    const s3 = getS3Client();
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_RESUMEN,
      Key: TIPO_CAMBIO_KEY,
      Body: Buffer.from(JSON.stringify(registro, null, 2), 'utf-8'),
      ContentType: 'application/json',
    }));
  } catch (err) {
    console.error('actualizar-tipo-cambio: no se pudo guardar el resultado en S3 —', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'No se pudo guardar el tipo de cambio en S3: ' + err.message }) };
  }

  console.log('actualizar-tipo-cambio: oficial(venta)=', oficial, '→ con margen (2%, redondeado hacia arriba)=', conMargen);
  return { statusCode: 200, body: JSON.stringify(registro) };
};
