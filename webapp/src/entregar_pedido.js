/**
 * Entregar un pedido de la tienda es venderlo.
 *
 * En una sola transacción: el pedido pasa a "entregado", cada producto baja del
 * stock del catálogo (conjuntos, packs y variedades incluidos, con la misma
 * cuenta que el POS) y la venta queda en `ventas` y `ventas_por_dia` como PC
 * "TIENDA", así Historial, Cierres y Control Total la ven como una más. Una sola
 * vez por pedido: si ya se registró, no se repite.
 *
 * Después, fuera de la transacción: el historial de movimientos, el espejo de
 * la tienda con el stock nuevo y el semáforo para que las PCs bajen el cambio.
 *
 * Lo usan el botón "Entregado" de Pedidos y el vigía de las entregas del
 * repartidor (`ventas_pendientes_watcher.js`). Para esas, la venta lleva la
 * fecha y la hora en que el repartidor lo entregó, no la de cuando el panel la
 * registró: la plata se cobró ese día.
 */
import { doc, runTransaction, serverTimestamp, setDoc } from 'firebase/firestore';
import { planDescuento, documentosDeVenta } from './pedido_venta.js';
import { registrarMovimiento } from './stock_ledger.js';
import { reflejarSiPublicado } from './tienda_espejo.js';
import { avisarAlCliente } from './avisos_cliente.js';
import { diaArgentina } from '../../tienda/src/reparto.js';

function fechaDe(marca) {
  if (!marca) return null;
  if (typeof marca.toDate === 'function') return marca.toDate();
  const fecha = new Date(marca);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/**
 * @returns {Promise<
 *   {ok: true, yaEstaba?: boolean, saltados: Array} |
 *   {ok: false, rechazo: string, pedido: object}
 * >}
 * @throws si la transacción no se pudo hacer (sin red, sin permiso)
 */
export async function registrarEntrega(db, id) {
  const ref = doc(db, 'tienda_pedidos', id);

  const resultado = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('el pedido ya no existe');
    const pedido = snap.data() || {};
    // La tarjeta puede ser vieja: si otra PC lo canceló mientras acá seguía
    // en "listo", entregarlo es vender lo que el cliente ya no quiere.
    if (pedido.estado === 'cancelado') return { rechazo: 'está cancelado', pedido };
    if (pedido.venta_registrada) {
      tx.update(ref, { estado: 'entregado', visto: true, venta_pendiente: false });
      return { yaEstaba: true };
    }

    // Lo que entregó el repartidor se vende con la hora de la entrega.
    const delRepartidor = pedido.venta_pendiente === true ? fechaDe(pedido.entregado_en) : null;
    const fecha = delRepartidor || new Date();

    // Todas las lecturas antes de la primera escritura (lo exige Firestore).
    const ids = [...new Set((pedido.items || []).map(i => String(i?.id || '').trim()).filter(Boolean))];
    const catalogo = {};
    for (const pid of ids) {
      const s = await tx.get(doc(db, 'catalogo', pid));
      catalogo[pid] = s.exists() ? { ...s.data(), doc_id: pid } : null;
    }
    const plan = planDescuento(pedido.items || [], catalogo);
    const docs = documentosDeVenta(pedido, id, catalogo, fecha);
    const cuando = delRepartidor || serverTimestamp();

    for (const p of plan.productos) {
      if (p.saltado || !Object.keys(p.campos).length) continue;
      tx.set(doc(db, 'catalogo', p.id), { ...p.campos, ultima_actualizacion: serverTimestamp() }, { merge: true });
    }
    tx.set(doc(db, 'ventas', docs.ventaId), { ...docs.venta, created_at: cuando });
    for (const l of docs.lineas) {
      tx.set(doc(db, 'ventas_por_dia', l.docId), { ...l.datos, fecha_dt: cuando });
    }
    tx.update(ref, {
      estado: 'entregado', visto: true,
      venta_registrada: true, venta_id: docs.ventaId, stock_descontado: true,
      venta_pendiente: false,
      ...(delRepartidor ? {} : { entregado_en: serverTimestamp(), entregado_dia: diaArgentina(fecha) }),
    });
    return { pedido, plan, catalogo };
  });

  if (resultado.rechazo) return { ok: false, rechazo: resultado.rechazo, pedido: resultado.pedido };
  // La notificación al celular del cliente, sin esperarla. Si ya se la avisó
  // el repartidor, la tienda no la repite.
  avisarAlCliente(id);
  if (resultado.yaEstaba) return { ok: true, yaEstaba: true, saltados: [] };

  const { pedido, plan, catalogo } = resultado;
  const referencia = `Pedido tienda ${pedido.codigo || id}`;
  for (const p of plan.productos) {
    if (p.saltado) continue;
    for (const m of p.movimientos) {
      registrarMovimiento(db, {
        docId: p.id, nombre: p.nombre, motivo: 'venta',
        antes: m.antes, despues: m.despues, cantidad: m.cantidad,
        referencia, detalle: m.detalle, usuario: 'Tienda online',
      });
    }
    // La vidriera con el stock que quedó (y sin el producto, si llegó a cero).
    reflejarSiPublicado(db, p.id, { ...(catalogo[p.id] || {}), ...p.campos }).catch(() => {});
  }
  if (plan.saltados.length) console.warn('[pedidos] renglones sin descontar:', plan.saltados);
  // Semáforo del catálogo: las PCs bajan el stock nuevo en el próximo sync.
  setDoc(doc(db, 'config', 'catalogo_meta'), { last_updated: serverTimestamp() }, { merge: true }).catch(() => {});
  return { ok: true, saltados: plan.saltados };
}
