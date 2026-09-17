/**
 * La venta con que una caja cobró un pedido de la tienda, vista desde el panel.
 *
 * Desde el 16-09 el stock de un pedido sale al ENTREGARLO y la venta nace al
 * COBRARLO en una caja (`pos_system/ui/pedidos_web_view.py`). Por eso borrar esa
 * venta en Ventas no devuelve stock: la mercadería ya está en la casa del
 * cliente.
 *
 * Tampoco reabre el cobro. La venta sigue sumando en la caja de la PC que la
 * cobró (su base local no se entera del borrado), y volver a cobrarla en otra
 * caja contaba la plata dos veces. Un cobro mal hecho se corrige editando la
 * venta en el Historial del POS; una devolución se anula desde la caja
 * (Anular entrega).
 *
 * Las ventas TIENDA de antes (pc `TIENDA`, stock y venta juntos) siguen
 * borrándose como siempre, devolviendo el stock.
 */

/** ¿Es el cobro de un pedido hecho en una caja? */
export function esCobroDePedido(venta) {
  return venta?.origen === 'tienda' && String(venta?.pc_id || '') !== 'TIENDA' && !!venta?.pedido_id;
}
