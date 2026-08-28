/**
 * Historial de movimientos de stock — lado panel.
 *
 * El POS escribe en esta misma colección desde `pos_system/utils/stock_ledger.py`.
 * Acá anotamos lo que se mueve desde la web: una reposición cargada a mano, un
 * ajuste por conteo, la devolución al borrar una venta, el consumo que aplica el
 * watcher de consumibles.
 *
 * Por qué existe: hasta ahora el sistema guardaba únicamente el número actual de
 * stock. Cuando un producto no cerraba contra la góndola no había forma de saber
 * si faltó registrar una venta, si alguien lo tipeó mal o si el descuento nunca
 * llegó. Con esto cada unidad que entra o sale deja quién, cuándo y de cuánto a
 * cuánto.
 *
 * Regla del signo: negativo = salió mercadería, positivo = entró.
 *
 * Nunca tira error hacia arriba. Perder una línea de historial no puede voltear
 * la operación que la generó: si falla, queda en consola y la edición sigue.
 */
import { collection, addDoc, query, where, orderBy, limit, getDocs, serverTimestamp } from 'firebase/firestore';
import { auth } from './auth.js';

export const MOTIVOS = {
  venta:          'Venta',
  anulacion:      'Venta anulada',
  fiado:          'Cargado a fiado',
  fiado_quitado:  'Quitado de un fiado',
  vinculacion:    'Consumido por otro producto',
  edicion_manual: 'Editado a mano',
  reposicion:     'Reposición',
  conteo:         'Ajuste por conteo',
  importacion:    'Importación',
  variante:       'Variante / conjunto',
};

function _num(v) {
  // Sin dato es null, no cero. `Number(null)` da 0 y es finito, así que un
  // movimiento anotado sólo con la cantidad —el caso del conjunto por
  // variedad, donde el `stock` plano no aplica— quedaba guardado como "de 0 a
  // 0" moviendo tres unidades: el historial afirmaba un punto de partida que
  // nunca existió, que es peor que no decir nada.
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null;
}

/** Quién está operando el panel, para firmar el movimiento. */
function _usuario() {
  const u = auth?.currentUser;
  return String(u?.displayName || u?.email || 'panel');
}

/**
 * Anota un movimiento. `antes` y `despues` son el stock del producto a cada
 * lado del cambio: sin esos dos números el historial dice que algo se movió
 * pero no desde dónde, que es la mitad inútil del dato.
 */
export async function registrarMovimiento(db, {
  docId, nombre = '', motivo, antes = null, despues = null,
  cantidad = null, referencia = '', detalle = '', usuario = null,
} = {}) {
  try {
    if (!db || !docId || !motivo) return;
    const a = _num(antes);
    const d = _num(despues);
    const delta = cantidad !== null ? _num(cantidad)
                : (a !== null && d !== null) ? _num(d - a)
                : null;
    if (!delta) return;   // sin cambio real no hay nada que contar
    await addDoc(collection(db, 'stock_movimientos'), {
      ts:              serverTimestamp(),
      origen:          'webapp',
      pc_id:           'webapp',
      usuario:         usuario || _usuario(),
      producto_id:     null,
      firebase_id:     String(docId),
      producto_nombre: String(nombre || ''),
      motivo:          String(motivo),
      cantidad:        delta,
      stock_antes:     a,
      stock_despues:   d,
      referencia:      String(referencia || ''),
      detalle:         String(detalle || ''),
    });
  } catch (e) {
    console.warn('Historial de stock: no se pudo registrar el movimiento:', e?.message || e);
  }
}

/** Varios movimientos de una sola operación (ej: borrar una venta de 8 items). */
export async function registrarVarios(db, movimientos = []) {
  for (const m of movimientos) {
    // En serie a propósito: son pocos y así un fallo suelto no corta el resto.
    await registrarMovimiento(db, m);
  }
}

/** Últimos movimientos de un producto, del más nuevo al más viejo. */
export async function movimientosDe(db, docId, tope = 60) {
  if (!db || !docId) return [];
  try {
    const q = query(
      collection(db, 'stock_movimientos'),
      where('firebase_id', '==', String(docId)),
      orderBy('ts', 'desc'),
      limit(tope),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
  } catch (e) {
    console.warn('Historial de stock: no se pudo leer:', e?.message || e);
    return [];
  }
}
