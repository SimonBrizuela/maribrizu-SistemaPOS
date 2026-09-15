/**
 * Manda al celular del cliente lo que cambió en su pedido.
 *
 * Lo usan `avisar-estado` (que llama el panel) y `reparto-mover` (el
 * repartidor): el texto sale siempre de la base y de `avisos_estado.js`, nunca
 * de quien pide el aviso.
 *
 * Cada paso se avisa una sola vez (`estado_avisado` y `reclamo_avisado` en
 * `tienda_avisos`): si dos PCs mueven el pedido a la vez, o se reintenta, no
 * llega repetido. Si Google no contesta tira error y el paso NO queda como
 * avisado, así el próximo intento lo manda.
 */
import { leerDoc, leerDocPrivado, escribirCampos, leerConfigTienda } from './firestore.mjs';
import { mandarAviso } from './mensajes.mjs';
import { avisoDeEstado, avisoDeReclamo, claveDeReclamo } from '../../../src/avisos_estado.js';

/**
 * @returns {Promise<{status: 200|204|404, enviados?: number}>}
 * @throws si Google no contesta
 */
export async function avisarPedido(id) {
  const leido = await leerDoc('tienda_pedidos', id);
  if (!leido) return { status: 404 };
  const pedido = { id, ...leido };

  const suscripcion = await leerDocPrivado('tienda_avisos', id);
  const tokens = Array.isArray(suscripcion?.tokens) ? suscripcion.tokens : [];
  if (!tokens.length) return { status: 204 };

  const pendientes = [];
  const cambios = {};

  if (pedido.estado && pedido.estado !== suscripcion.estado_avisado) {
    const config = await leerConfigTienda().catch(() => ({}));
    const aviso = avisoDeEstado(pedido, { direccionLocal: config?.direccion || '' });
    if (aviso) pendientes.push(aviso);
    // Un estado sin aviso (volvió a "nuevo") también queda anotado: no hay
    // nada que reintentar.
    cambios.estado_avisado = pedido.estado;
  }

  const reclamo = pedido.reclamo;
  const claveReclamo = claveDeReclamo(reclamo);
  if (claveReclamo && claveReclamo !== suscripcion.reclamo_avisado) {
    const aviso = avisoDeReclamo(pedido, reclamo);
    if (aviso) pendientes.push(aviso);
    cambios.reclamo_avisado = claveReclamo;
  }

  if (!Object.keys(cambios).length) return { status: 200, enviados: 0 };

  let enviados = 0;
  const vigentes = new Set(tokens);
  for (const aviso of pendientes) {
    for (const token of tokens) {
      if (!vigentes.has(token)) continue;
      const resultado = await mandarAviso(token, aviso);
      if (resultado.ok) enviados++;
      else if (resultado.invalido) vigentes.delete(token);
    }
  }

  await escribirCampos('tienda_avisos', id, {
    ...cambios,
    tokens: [...vigentes],
    ultimo_aviso: new Date(),
  });
  return { status: 200, enviados };
}
