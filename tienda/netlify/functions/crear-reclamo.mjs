/**
 * Recibe el reclamo de un cliente sobre su pedido, con fotos si quiere.
 *
 * La pantalla del pedido lo manda con las fotos ya achicadas y en base64. Acá
 * se vuelven a aplicar las reglas de `reclamos.js` (lo que llega lo puede
 * haber armado cualquiera), se sube cada foto a Storage y se escriben, en un
 * solo commit, el reclamo en `tienda_reclamos` y su resumen en el pedido.
 *
 * El reclamo completo (detalle, fotos, datos del cliente) queda en una
 * colección que solo lee el panel. En el pedido, que se abre con el enlace,
 * queda nada más lo que el cliente necesita ver: el estado y la respuesta.
 *
 * El número de reclamo sale de `reclamos_cantidad` del pedido. Si dos envíos
 * llegan a la vez piden el mismo número, y la creación con condición deja
 * entrar a uno solo: el otro recibe "ya tenés un reclamo abierto".
 */
import crypto from 'node:crypto';
import { hayCredenciales, leerDoc, escribirJuntos, subirArchivo } from './lib/firestore.mjs';
import { EXTENSIONES, leerFoto } from './lib/fotos.mjs';
import { LIMITES, puedeReclamar, validarReclamo, resumenDelReclamo } from '../../src/reclamos.js';

const RE_ID = /^[A-Za-z0-9]{15,40}$/;

export default async (peticion) => {
  if (peticion.method !== 'POST') return Response.json({ error: 'metodo' }, { status: 405 });

  let cuerpo;
  try {
    cuerpo = await peticion.json();
  } catch {
    return Response.json({ error: 'cuerpo' }, { status: 400 });
  }
  const id = cuerpo?.pedido;
  if (typeof id !== 'string' || !RE_ID.test(id)) return Response.json({ error: 'pedido' }, { status: 400 });

  // Sin la cuenta de servicio no hay dónde guardarlo. La pantalla ofrece
  // escribir por WhatsApp en su lugar.
  if (!hayCredenciales()) return Response.json({ error: 'sin_credenciales' }, { status: 501 });

  try {
    const pedido = await leerDoc('tienda_pedidos', id);
    if (!pedido) return Response.json({ error: 'no_existe' }, { status: 404 });

    const permitido = puedeReclamar(pedido);
    if (!permitido.puede) return Response.json({ error: permitido.motivo }, { status: 409 });
    const anteriores = Number(pedido.reclamos_cantidad) || 0;
    if (anteriores >= LIMITES.reclamosPorPedido) return Response.json({ error: 'limite' }, { status: 409 });

    const entrada = {
      motivo: cuerpo.motivo,
      renglones: cuerpo.renglones,
      detalle: typeof cuerpo.detalle === 'string' ? cuerpo.detalle : '',
      fotos: Array.isArray(cuerpo.fotos) ? cuerpo.fotos : [],
    };
    const invalido = validarReclamo(entrada, pedido);
    if (invalido) return Response.json({ error: 'invalido', ...invalido }, { status: 400 });

    const fotos = [];
    for (const foto of entrada.fotos) {
      const leida = leerFoto(foto);
      if (leida.error) return Response.json({ error: 'foto', mensaje: leida.error }, { status: 400 });
      fotos.push(leida);
    }

    const numero = anteriores + 1;
    const reclamoId = `${id}-${numero}`;
    // Cada archivo lleva una marca al azar: si dos envíos piden el mismo número,
    // el que pierde no pisa las fotos del que entró.
    const subidas = await Promise.all(fotos.map((f, i) => subirArchivo(
      `reclamos/${reclamoId}/${i + 1}-${crypto.randomBytes(4).toString('hex')}.${EXTENSIONES[f.tipo]}`,
      f.bytes, f.tipo)));

    const ahora = new Date();
    const items = Array.isArray(pedido.items) ? pedido.items : [];
    const reclamo = {
      id: reclamoId,
      pedido_id: id,
      pedido_codigo: pedido.codigo || null,
      cliente: { nombre: pedido.cliente?.nombre || '', telefono: pedido.cliente?.telefono || '' },
      entrega_modo: pedido.entrega?.modo || null,
      motivo: entrada.motivo,
      productos: entrada.renglones.map(n => ({
        renglon: n,
        id: items[n].id ?? null,
        nombre: items[n].nombre || '',
        variedad: items[n].variedad || null,
        cantidad: items[n].cantidad ?? null,
      })),
      detalle: entrada.detalle.trim(),
      fotos: subidas.map((s, i) => ({ url: s.url, ruta: s.ruta, tipo: fotos[i].tipo, bytes: fotos[i].bytes.length })),
      estado: 'nuevo',
      respuesta: null,
      creado: ahora,
      actualizado: ahora,
    };
    const resumen = resumenDelReclamo(reclamo);

    try {
      await escribirJuntos([
        { coleccion: 'tienda_reclamos', id: reclamoId, valores: reclamo, condicion: 'nuevo' },
        { coleccion: 'tienda_pedidos', id, valores: { reclamo: resumen, reclamos_cantidad: numero } },
      ]);
    } catch (err) {
      if (err.yaExiste) return Response.json({ error: 'abierto' }, { status: 409 });
      throw err;
    }

    return Response.json({ ok: true, reclamo: resumen });
  } catch (err) {
    console.error('[crear-reclamo]', err);
    return Response.json({ error: 'fallo' }, { status: 502 });
  }
};
