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
import { collection, addDoc, doc, query, where, orderBy, limit, getDocs, serverTimestamp } from 'firebase/firestore';
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
  correccion:     'Corrección de auditoría',
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

function _azar() {
  return Math.random().toString(36).slice(2, 8);
}

function _guardado(almacen, clave) {
  try {
    const st = globalThis[almacen];
    if (!st) return null;
    let v = st.getItem(clave);
    if (!v) { v = _azar() + _azar().slice(0, 2); st.setItem(clave, v); }
    return v;
  } catch (_) {
    return null;   // modo privado o almacenamiento bloqueado
  }
}

/**
 * Navegador y sistema en pocas palabras ("Chrome/Windows", "Safari/iPhone"),
 * para que en el historial se distinga la PC del mostrador del celular.
 */
export function agenteCorto(ua = '') {
  const s = String(ua || '');
  const nav = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : 'otro';
  const so = /Android/.test(s) ? 'Android'
    : /iPhone|iPad|iPod/.test(s) ? 'iPhone'
    : /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'Mac'
    : /Linux/.test(s) ? 'Linux'
    : 'otro';
  return `${nav}/${so}`;
}

/**
 * Quién movió, más allá del usuario: la misma cuenta se usa en la PC del
 * mostrador, en la notebook y en el celular, y cuando un stock no cierra hace
 * falta saber desde cuál. `pestana` vive en sessionStorage (una por pestaña) y
 * `navegador` en localStorage (uno por navegador, sobrevive al F5).
 */
export function origenPanel() {
  return {
    pestana:   _guardado('sessionStorage', 'liceo_panel_pestana'),
    navegador: _guardado('localStorage', 'liceo_panel_navegador'),
    agente:    agenteCorto(globalThis.navigator?.userAgent || ''),
  };
}

/**
 * Arma la fila del historial, o null si no se movió nada. Es lo que escriben
 * `registrarMovimiento` (suelto) y quien anota adentro de una transacción.
 */
export function armarMovimiento({
  docId, nombre = '', motivo, antes = null, despues = null,
  cantidad = null, referencia = '', detalle = '', usuario = null,
} = {}) {
  if (!docId || !motivo) return null;
  const a = _num(antes);
  const d = _num(despues);
  const delta = cantidad !== null ? _num(cantidad)
              : (a !== null && d !== null) ? _num(d - a)
              : null;
  if (!delta) return null;   // sin cambio real no hay nada que contar
  const o = origenPanel();
  return {
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
    panel_pestana:   o.pestana,
    panel_navegador: o.navegador,
    panel_agente:    o.agente,
  };
}

/**
 * Referencia con id propio para anotar un movimiento dentro de una
 * transacción. Se pide UNA vez afuera del callback: si la transacción se
 * reintenta, el `set` cae en el mismo documento y no se duplica.
 */
export function refMovimientoNuevo(db) {
  const o = origenPanel();
  const id = `webapp_${o.pestana || 'sin-pestana'}_${Date.now()}_${_azar()}`;
  return doc(db, 'stock_movimientos', id);
}

/**
 * Anota un movimiento. `antes` y `despues` son el stock del producto a cada
 * lado del cambio: sin esos dos números el historial dice que algo se movió
 * pero no desde dónde, que es la mitad inútil del dato.
 */
export async function registrarMovimiento(db, mov = {}) {
  try {
    if (!db) return;
    const fila = armarMovimiento(mov);
    if (!fila) return;
    await addDoc(collection(db, 'stock_movimientos'), fila);
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
