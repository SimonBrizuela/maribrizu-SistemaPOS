/**
 * Entregar un pedido de la tienda: la mercadería sale del stock.
 *
 * Desde el 16-09 el panel NO registra la venta. La cobra una caja del POS
 * (pestaña Pedidos web), con la pantalla de cobro de siempre, y la venta entra
 * a la caja del día. Lo que hace el panel al entregar es lo mismo que hace una
 * caja: en una sola transacción marca el pedido entregado, baja cada producto
 * del catálogo (conjuntos, packs y variedades con la misma cuenta que el POS,
 * `planDescuento`), anota los movimientos de stock y deja el pedido "a cobrar".
 *
 * Una sola vez por pedido: si el stock ya salió (lo descontó una caja, o es una
 * venta TIENDA de antes del cambio), solo se marca entregado.
 *
 * Los campos que deja son los que leen las cajas (ver
 * `pos_system/models/pedido_tienda.py`):
 *   stock_descontado, venta_registrada  el stock ya salió; ningún panel viejo
 *                                       tiene que registrar nada
 *   cobro_pendiente                     falta cobrarlo en una caja
 *   venta_pendiente: false              la tienda deja de apartar el stock
 *
 * Lo que entrega el repartidor lo descuentan las cajas abiertas.
 */
import { doc, runTransaction, serverTimestamp, setDoc } from 'firebase/firestore';
import { planDescuento } from './pedido_venta.js';
import { reflejarSiPublicado } from './tienda_espejo.js';
import { avisarAlCliente } from './avisos_cliente.js';
import { diaArgentina } from '../../tienda/src/reparto.js';

function nuevoIntento() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Quién entregó, como puede quedar en el pedido: lo lee cualquiera con el
 * enlace de seguimiento. Primer nombre, nunca un mail (el registro de eventos,
 * que solo lee el local, guarda el nombre entero). Gemela de `marca_publica`.
 */
export function cajeroPublico(usuario) {
  const texto = String(usuario || '').trim();
  if (!texto || texto.includes('@')) return '';
  return texto.split(/\s+/)[0];
}

/** Los renglones que no salieron del stock, como los anota una caja. */
export function saltadosDelPedido(pedido, saltados) {
  const items = pedido?.items || [];
  return (saltados || []).map(x => ({
    renglon: Number.isInteger(x.idx) ? x.idx : null,
    producto_id: x.id || '',
    motivo: x.motivo || '',
    nombre: Number.isInteger(x.idx) && x.idx < items.length ? String(items[x.idx]?.nombre || '') : '',
  }));
}

function redondear(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

/**
 * @param {object} [opciones]
 * @param {string} [opciones.usuario] quién tocó el botón, para el historial
 * @returns {Promise<
 *   {ok: true, yaEstaba?: boolean, saltados: Array} |
 *   {ok: false, rechazo: string, pedido: object}
 * >}
 * @throws si la transacción no se pudo hacer (sin red, sin permiso)
 */
export async function registrarEntrega(db, id, { usuario = 'Panel' } = {}) {
  const ref = doc(db, 'tienda_pedidos', id);
  const intento = nuevoIntento();

  const resultado = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('el pedido ya no existe');
    const pedido = snap.data() || {};
    // La tarjeta puede ser vieja: si otra PC lo canceló mientras acá seguía
    // en "listo", entregarlo es sacar del stock lo que el cliente ya no quiere.
    if (pedido.estado === 'cancelado') return { rechazo: 'está cancelado', pedido };

    const ahora = new Date();
    const marcarEntregado = pedido.estado !== 'entregado'
      ? { estado: 'entregado', entregado_en: serverTimestamp(), entregado_dia: diaArgentina(ahora), entregado_por: 'panel' }
      : {};

    if (pedido.stock_descontado === true || pedido.venta_registrada === true) {
      tx.update(ref, { ...marcarEntregado, visto: true, venta_pendiente: false });
      return { yaEstaba: true, pedido };
    }

    // Todas las lecturas antes de la primera escritura (lo exige Firestore).
    const ids = [...new Set((pedido.items || []).map(i => String(i?.id || '').trim()).filter(Boolean))];
    const catalogo = {};
    for (const pid of ids) {
      const s = await tx.get(doc(db, 'catalogo', pid));
      catalogo[pid] = s.exists() ? { ...s.data(), doc_id: pid } : null;
    }
    const plan = planDescuento(pedido.items || [], catalogo);
    const referencia = `Pedido tienda ${pedido.codigo || id}`;

    let n = 0;
    for (const p of plan.productos) {
      if (p.saltado || !Object.keys(p.campos).length) continue;
      tx.set(doc(db, 'catalogo', p.id), { ...p.campos, ultima_actualizacion: serverTimestamp() }, { merge: true });
      // Los movimientos van en la misma transacción que el stock, con el
      // intento en el id: nunca queda un movimiento de algo que no pasó, y si
      // el mismo pedido descontara dos veces se verían dos grupos.
      for (const m of p.movimientos) {
        tx.set(doc(db, 'stock_movimientos', `tienda_${id}_${intento}_${n++}`), {
          ts: serverTimestamp(), origen: 'webapp', pc_id: 'webapp', usuario,
          producto_id: null, firebase_id: p.id, producto_nombre: p.nombre || '',
          motivo: 'venta', cantidad: redondear(m.cantidad),
          stock_antes: redondear(m.antes), stock_despues: redondear(m.despues),
          referencia, detalle: m.detalle || '', pedido_id: id, intento,
        });
      }
    }
    tx.update(ref, {
      ...marcarEntregado,
      visto: true,
      venta_pendiente: false,
      stock_descontado: true,
      venta_registrada: true,
      cobro_pendiente: true,
      stock_saltados: saltadosDelPedido(pedido, plan.saltados),
      stock_descontado_por: { origen: 'panel', pc_id: 'webapp', pc_nombre: 'Panel', cajero: cajeroPublico(usuario), en: ahora },
    });
    return { pedido, plan, catalogo };
  });

  if (resultado.rechazo) return { ok: false, rechazo: resultado.rechazo, pedido: resultado.pedido };
  avisarAlCliente(id);
  anotarEvento(db, id, resultado.pedido, intento, usuario, resultado.plan);
  if (resultado.yaEstaba) return { ok: true, yaEstaba: true, saltados: [] };

  const { plan, catalogo } = resultado;
  for (const p of plan.productos) {
    if (p.saltado) continue;
    // La vidriera con el stock que quedó (y sin el producto, si llegó a cero).
    reflejarSiPublicado(db, p.id, { ...(catalogo[p.id] || {}), ...p.campos }).catch(() => {});
  }
  if (plan.saltados.length) console.warn('[pedidos] renglones sin descontar:', plan.saltados);
  // Semáforo del catálogo: las PCs bajan el stock nuevo en el próximo sync.
  setDoc(doc(db, 'config', 'catalogo_meta'), { last_updated: serverTimestamp() }, { merge: true }).catch(() => {});
  return { ok: true, saltados: plan.saltados };
}

/**
 * El renglón del registro de eventos que también escriben las cajas. Va fuera
 * de la transacción a propósito: si la regla de esa colección todavía no está
 * publicada, se pierde el renglón y no la entrega.
 */
function anotarEvento(db, id, pedido, intento, usuario, plan) {
  const stock = plan
    ? plan.productos.filter(p => !p.saltado && Object.keys(p.campos).length)
      .map(p => ({ id: p.id, nombre: p.nombre || '', movimientos: p.movimientos }))
    : null;
  setDoc(doc(db, 'tienda_pedidos_eventos', `${id}__entregar__${intento}`), {
    pedido_id: id,
    codigo: String(pedido?.codigo || ''),
    accion: 'entregar',
    resultado: 'hecho',
    detalle: plan ? 'descontó el stock' : 'el stock ya había salido',
    origen: 'panel',
    pc_id: 'webapp', pc_nombre: 'Panel', cajero: usuario,
    intento,
    en: serverTimestamp(),
    dia: diaArgentina(new Date()),
    estado_antes: pedido?.estado || null,
    estado_despues: 'entregado',
    ...(stock ? { stock, saltados: plan.saltados } : {}),
  }).catch(err => console.warn('[pedidos] evento sin anotar:', err?.code || err));
}
