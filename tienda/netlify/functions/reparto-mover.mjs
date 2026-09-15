/**
 * El repartidor cambia el estado de un pedido.
 *
 * Revisa el link, lee el pedido con su versión, aplica las reglas de
 * `reparto.js` (solo envíos, solo para adelante) y escribe atado a esa versión:
 * si el local lo canceló o lo movió en el medio, no se pisa.
 *
 * "Entregado" deja la venta pendiente (`venta_pendiente`) y no la registra: el
 * stock, la venta y la vidriera los hace el panel con la misma cuenta que usa
 * su botón "Entregado" (`webapp/src/entregar_pedido.js`), así no hay dos
 * versiones de esa cuenta. Mientras tanto el pedido sigue apartando su stock en
 * la tienda (`stockComprometido`).
 *
 * La foto de la entrega va a Storage y a `tienda_entregas`, que solo lee el
 * local: el pedido lo abre cualquiera que tenga el enlace.
 */
import crypto from 'node:crypto';
import { hayCredenciales, leerDocConVersion, escribirJuntos, subirArchivo } from './lib/firestore.mjs';
import { EXTENSIONES, leerFoto } from './lib/fotos.mjs';
import { avisarPedido } from './lib/avisar.mjs';
import { verificarClave } from './lib/reparto_acceso.mjs';
import { validarMovimiento, diaArgentina } from '../../src/reparto.js';

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
  if (!hayCredenciales()) return Response.json({ error: 'sin_credenciales' }, { status: 501 });

  try {
    const acceso = await verificarClave(cuerpo.clave);
    if (!acceso.ok) return Response.json({ error: 'link' }, { status: 401 });

    const leido = await leerDocConVersion('tienda_pedidos', id);
    if (!leido) return Response.json({ error: 'no_existe' }, { status: 404 });
    const pedido = leido.datos;
    const estado = cuerpo.estado;

    const problema = validarMovimiento(pedido, estado);
    if (problema) return Response.json({ error: problema, estado: pedido.estado }, { status: 409 });

    let foto = null;
    if (estado === 'entregado' && cuerpo.foto) {
      const leida = leerFoto(cuerpo.foto);
      if (leida.error) return Response.json({ error: 'foto', mensaje: leida.error }, { status: 400 });
      foto = leida;
    }

    const ahora = new Date();
    const valores = { estado };
    const escrituras = [];

    if (estado === 'entregado') {
      Object.assign(valores, {
        entregado_en: ahora,
        entregado_dia: diaArgentina(ahora),
        entregado_por: 'reparto',
      });
      if (pedido.venta_registrada !== true) valores.venta_pendiente = true;
      const cobrado = cuerpo.cobrado === true;
      if (cobrado && pedido.pago?.modo === 'efectivo') valores.pago = { ...pedido.pago, pagado: true };

      const subida = foto
        ? await subirArchivo(`entregas/${id}/${crypto.randomBytes(4).toString('hex')}.${EXTENSIONES[foto.tipo]}`, foto.bytes, foto.tipo)
        : null;
      escrituras.push({
        coleccion: 'tienda_entregas', id, condicion: 'cualquiera',
        valores: {
          pedido_id: id,
          pedido_codigo: pedido.codigo || null,
          entregado_en: ahora,
          por: 'reparto',
          cobrado: pedido.pago?.modo === 'efectivo' ? cobrado : null,
          monto: Number(pedido.total) || 0,
          foto: subida ? { url: subida.url, ruta: subida.ruta } : null,
        },
      });
    }

    try {
      await escribirJuntos([
        { coleccion: 'tienda_pedidos', id, valores, condicion: { version: leido.version } },
        ...escrituras,
      ]);
    } catch (err) {
      if (err.cambio) return Response.json({ error: 'cambio' }, { status: 409 });
      throw err;
    }

    // El cambio ya está hecho: si el aviso al celular falla, se reintenta con
    // el próximo movimiento o desde el panel, pero no se le dice al repartidor
    // que no se pudo.
    try {
      await avisarPedido(id);
    } catch (err) {
      console.warn('[reparto-mover] no se pudo avisar al cliente:', err?.message || err);
    }

    return Response.json({ ok: true, estado });
  } catch (err) {
    console.error('[reparto-mover]', err);
    return Response.json({ error: 'fallo' }, { status: 502 });
  }
};
