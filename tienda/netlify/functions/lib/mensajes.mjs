/**
 * Notificaciones al celular del cliente, por Firebase Cloud Messaging.
 *
 * Se manda un mensaje de datos (no de notificación): el service worker de la
 * tienda (`public/avisos-sw.js`) arma la notificación con esos datos. Así se
 * controla la etiqueta que hace que cada aviso reemplace al anterior, la imagen
 * del recorrido y a dónde lleva tocarla, en vez de dejarlo a lo que decida el
 * navegador.
 */
import { PROYECTO, PERMISOS, tokenPara } from './firestore.mjs';

const URL_FCM = `https://fcm.googleapis.com/v1/projects/${PROYECTO}/messages:send`;

/**
 * Manda un aviso a un celular.
 *
 * @param {string} dispositivo  el token que dio el navegador al suscribirse
 * @param {{titulo, cuerpo, tag, url, imagen}} aviso
 * @returns {Promise<{ok: boolean, invalido?: boolean}>} `invalido`: ese celular
 *          ya no existe (desinstaló, borró los datos) y hay que olvidarlo
 * @throws si Google no contesta: el aviso no se da por mandado
 */
export async function mandarAviso(dispositivo, aviso) {
  const token = await tokenPara(PERMISOS.mensajes);
  const respuesta = await fetch(URL_FCM, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: dispositivo,
        webpush: {
          // Alta urgencia: que llegue aunque el celular esté ahorrando batería.
          // Un día de vida: un "listo para retirar" de ayer ya no sirve.
          headers: { Urgency: 'high', TTL: '86400' },
          // Los datos de FCM son todos texto.
          data: {
            titulo: String(aviso.titulo || ''),
            cuerpo: String(aviso.cuerpo || ''),
            tag: String(aviso.tag || ''),
            url: String(aviso.url || '/'),
            imagen: String(aviso.imagen || ''),
          },
        },
      },
    }),
  });

  if (respuesta.ok) return { ok: true };
  const detalle = await respuesta.json().catch(() => ({}));
  const codigos = (detalle?.error?.details || []).map(d => d.errorCode);
  // Token vencido o de otra app: no tiene sentido volver a intentarlo.
  const invalido = respuesta.status === 404 || codigos.includes('UNREGISTERED')
    || (respuesta.status === 400 && codigos.includes('INVALID_ARGUMENT'));
  if (invalido) return { ok: false, invalido: true };
  throw new Error(`FCM devolvió ${respuesta.status}: ${JSON.stringify(detalle).slice(0, 300)}`);
}
