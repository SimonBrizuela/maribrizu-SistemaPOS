/**
 * Manda al celular del cliente el aviso de cómo está su pedido.
 *
 * La llama el panel cada vez que mueve un pedido o un reclamo. No recibe el
 * texto: recibe el id, lee el pedido de la base y arma el aviso con
 * `avisos_estado.js`. Así el endpoint, que es público, no sirve para mandarle
 * cualquier cosa al celular de nadie: lo peor que se puede hacer con él es
 * pedir que se avise un paso que igual se iba a avisar.
 *
 * Cada paso se avisa una sola vez (`estado_avisado` en `tienda_avisos`): si dos
 * PCs mueven el pedido a la vez, o el panel reintenta, no llega repetido. Si
 * Google no contesta, el paso NO queda como avisado y el próximo intento lo
 * manda.
 */
import { hayCredenciales } from './lib/firestore.mjs';
import { avisarPedido } from './lib/avisar.mjs';
import { responder } from './lib/cors.mjs';

const RE_ID = /^[A-Za-z0-9]{15,40}$/;

export default async (peticion) => {
  if (peticion.method === 'OPTIONS') return responder(peticion, null, 204);
  if (peticion.method !== 'POST') return responder(peticion, { error: 'metodo' }, 405);

  let id;
  try {
    ({ id } = await peticion.json());
  } catch {
    return responder(peticion, { error: 'cuerpo' }, 400);
  }
  if (typeof id !== 'string' || !RE_ID.test(id)) return responder(peticion, { error: 'id' }, 400);
  if (!hayCredenciales()) return responder(peticion, { error: 'sin_credenciales' }, 501);

  try {
    const { status, enviados } = await avisarPedido(id);
    if (status === 404) return responder(peticion, { error: 'no_existe' }, 404);
    if (status === 204) return responder(peticion, null, 204);
    return responder(peticion, { enviados });
  } catch (err) {
    // Google no contestó: no se anota nada, así el próximo intento lo manda.
    console.error('[avisar-estado]', err);
    return responder(peticion, { error: 'fallo' }, 502);
  }
};
