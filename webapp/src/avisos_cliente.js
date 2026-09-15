/**
 * Le pide a la tienda que avise al celular del cliente que su pedido cambió.
 *
 * El aviso lo manda la función `avisar-estado` de la tienda, que lee el pedido
 * de la base y arma el texto: acá solo va el id. Se llama después de cada
 * cambio de estado y de cada movimiento de un reclamo, sin esperar la
 * respuesta: si la tienda no contesta, el cambio ya está hecho y el local sigue
 * trabajando. La función avisa cada paso una sola vez, así que llamarla de más
 * no repite nada.
 *
 * El panel y la tienda son dos sitios distintos: en local se le habla a la
 * tienda local, así probar el panel en la computadora nunca le manda
 * notificaciones a un cliente de verdad.
 */

const TIENDA_PUBLICADA = 'https://beta.liceolibreria.com';
const TIENDA_LOCAL = 'http://localhost:5180';

export function urlDeLaTienda(origen = globalThis.location?.origin || '') {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origen) ? TIENDA_LOCAL : TIENDA_PUBLICADA;
}

/**
 * @param {string} pedidoId
 * @param {{pedir?: Function, origen?: string}} [opciones]  para las pruebas
 * @returns {Promise<boolean>} si la tienda contestó bien; nadie tiene que esperarlo
 */
export async function avisarAlCliente(pedidoId, { pedir = globalThis.fetch, origen } = {}) {
  if (!pedidoId || typeof pedir !== 'function') return false;
  try {
    const respuesta = await pedir(`${urlDeLaTienda(origen)}/.netlify/functions/avisar-estado`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pedidoId }),
      // Que el pedido llegue aunque se cambie de pantalla justo después.
      keepalive: true,
    });
    return Boolean(respuesta?.ok);
  } catch (err) {
    console.warn('[avisos] la tienda no contestó el aviso al cliente:', err?.message || err);
    return false;
  }
}
