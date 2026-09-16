/**
 * La venta con que una caja cobró un pedido de la tienda, vista desde el panel.
 *
 * Desde el 16-09 el stock de un pedido sale al ENTREGARLO y la venta nace al
 * COBRARLO en una caja (`pos_system/ui/pedidos_web_view.py`). Por eso borrar esa
 * venta en Ventas no devuelve stock —la mercadería ya está en la casa del
 * cliente— sino que deshace el cobro: el pedido vuelve a "a cobrar" en las
 * cajas, que es lo que corresponde cuando se cobró mal (otro medio de pago, el
 * pedido equivocado).
 *
 * Las ventas TIENDA de antes (pc `TIENDA`, stock y venta juntos) siguen
 * borrándose como siempre, devolviendo el stock.
 */
import { doc, runTransaction, deleteField, setDoc, serverTimestamp } from 'firebase/firestore';

/** ¿Es el cobro de un pedido hecho en una caja? */
export function esCobroDePedido(venta) {
  return venta?.origen === 'tienda' && String(venta?.pc_id || '') !== 'TIENDA' && !!venta?.pedido_id;
}

/**
 * Deshace el cobro en el pedido, solo si el pedido sigue apuntando a ESTA
 * venta: si mientras tanto se cobró de nuevo en otra caja, no se toca.
 * @returns {Promise<{ok: boolean, rechazo?: string}>}
 */
export async function reabrirCobro(db, venta) {
  const pedidoId = String(venta.pedido_id);
  const ref = doc(db, 'tienda_pedidos', pedidoId);
  const r = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return { ok: false, rechazo: 'el pedido ya no existe' };
    const pedido = snap.data() || {};
    if (String(pedido.venta_id || '') !== String(venta.id)) {
      return { ok: false, rechazo: 'el pedido tiene otro cobro anotado' };
    }
    tx.update(ref, { cobro_pendiente: true, cobro: deleteField(), venta_id: deleteField() });
    return { ok: true, codigo: pedido.codigo || '' };
  });
  if (r.ok) {
    setDoc(doc(db, 'tienda_pedidos_eventos', `${pedidoId}__reabrir_cobro__${venta.id}`), {
      pedido_id: pedidoId, codigo: r.codigo, accion: 'reabrir_cobro', resultado: 'hecho',
      detalle: `se borró la venta ${venta.id} desde el panel`, origen: 'panel',
      pc_id: 'webapp', pc_nombre: 'Panel', cajero: '', en: serverTimestamp(),
      venta_id: String(venta.id),
    }).catch(err => console.warn('[ventas] evento sin anotar:', err?.code || err));
  }
  return r;
}
