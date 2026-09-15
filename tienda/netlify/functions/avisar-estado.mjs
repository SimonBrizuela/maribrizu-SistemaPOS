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
import {
  hayCredenciales, leerDoc, leerDocPrivado, escribirCampos, leerConfigTienda,
} from './lib/firestore.mjs';
import { mandarAviso } from './lib/mensajes.mjs';
import { responder } from './lib/cors.mjs';
import { avisoDeEstado, avisoDeReclamo } from '../../src/avisos_estado.js';

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
    const leido = await leerDoc('tienda_pedidos', id);
    if (!leido) return responder(peticion, { error: 'no_existe' }, 404);
    const pedido = { id, ...leido };

    const suscripcion = await leerDocPrivado('tienda_avisos', id);
    const tokens = Array.isArray(suscripcion?.tokens) ? suscripcion.tokens : [];
    if (!tokens.length) return responder(peticion, null, 204);

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
    if (reclamo?.estado && reclamo.estado !== suscripcion.reclamo_avisado) {
      const aviso = avisoDeReclamo(pedido, reclamo);
      if (aviso) pendientes.push(aviso);
      cambios.reclamo_avisado = reclamo.estado;
    }

    if (!Object.keys(cambios).length) return responder(peticion, { enviados: 0 });

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
    return responder(peticion, { enviados });
  } catch (err) {
    // Google no contestó: no se anota nada, así el próximo intento lo manda.
    console.error('[avisar-estado]', err);
    return responder(peticion, { error: 'fallo' }, 502);
  }
};
