/**
 * Anota un celular para que le lleguen los avisos de un pedido.
 *
 * La pantalla del pedido la llama cuando el cliente acepta las notificaciones
 * (o solo, si ya las había aceptado en otro pedido). El token del celular va a
 * `tienda_avisos/{pedido}`, una colección que ninguna regla deja leer ni
 * escribir desde afuera: la escriben y la leen únicamente estas funciones, con
 * la cuenta de servicio.
 *
 * Se guarda el estado que el pedido tiene en este momento como ya avisado: el
 * cliente lo está mirando en la pantalla y no hace falta que le llegue.
 */
import { hayCredenciales, leerDoc, leerDocPrivado, escribirCampos } from './lib/firestore.mjs';

const RE_ID = /^[A-Za-z0-9]{15,40}$/;
// Los tokens de FCM son base64url con dos puntos; con este tope entran de sobra.
const RE_TOKEN = /^[A-Za-z0-9:_-]{100,4096}$/;
// Un pedido lo pueden seguir el celular y la computadora de la misma persona,
// y alguien más de la casa. Más que esto no tiene sentido.
const MAX_DISPOSITIVOS = 5;
const TERMINADOS = new Set(['entregado', 'cancelado']);

export default async (peticion) => {
  if (peticion.method !== 'POST') return new Response('Método no permitido', { status: 405 });

  let cuerpo;
  try {
    cuerpo = await peticion.json();
  } catch {
    return new Response('Cuerpo inválido', { status: 400 });
  }
  const id = cuerpo?.pedido;
  const token = cuerpo?.token;
  if (typeof id !== 'string' || !RE_ID.test(id)) return new Response('Pedido inválido', { status: 400 });
  if (typeof token !== 'string' || !RE_TOKEN.test(token)) return new Response('Token inválido', { status: 400 });

  // Sin la cuenta de servicio no hay dónde guardarlo. La pantalla lo toma como
  // "avisos no disponibles" y sigue funcionando igual.
  if (!hayCredenciales()) return Response.json({ error: 'sin_credenciales' }, { status: 501 });

  try {
    const pedido = await leerDoc('tienda_pedidos', id);
    if (!pedido) return Response.json({ error: 'no_existe' }, { status: 404 });
    if (TERMINADOS.has(pedido.estado)) return Response.json({ error: 'terminado' }, { status: 409 });

    const anterior = await leerDocPrivado('tienda_avisos', id);
    const tokens = Array.isArray(anterior?.tokens) ? anterior.tokens : [];
    if (tokens.includes(token)) return Response.json({ ok: true });

    const ahora = new Date();
    await escribirCampos('tienda_avisos', id, {
      tokens: [...tokens, token].slice(-MAX_DISPOSITIVOS),
      estado_avisado: anterior?.estado_avisado ?? pedido.estado ?? null,
      reclamo_avisado: anterior?.reclamo_avisado ?? pedido.reclamo?.estado ?? null,
      creado: anterior?.creado ? new Date(anterior.creado) : ahora,
      actualizado: ahora,
    }, { crear: true });

    return Response.json({ ok: true });
  } catch (err) {
    console.error('[suscribir-avisos]', err);
    return Response.json({ error: 'fallo' }, { status: 502 });
  }
};
