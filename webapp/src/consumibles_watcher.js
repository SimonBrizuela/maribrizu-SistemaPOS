/**
 * Watcher de "consumibles": cuando se vende un producto que está vinculado a
 * otro (ej: "Fotocopia A4" → "Hojas A4"), descuenta automáticamente unidades
 * del producto fuente.
 *
 * Cómo funciona:
 *  - Escucha en tiempo real la colección `ventas_por_dia` (limitado a las
 *    últimas 24h para no leer toda la historia).
 *  - Para cada item nuevo:
 *      1. Encuentra el producto del catálogo por nombre (case-insensitive).
 *      2. Si el producto es conjunto Y el item trae conjunto_color, busca la
 *         variedad y usa su `vinculado_a` / `vinculado_cantidad`. Si la
 *         variedad no tiene link propio, cae al producto.
 *      3. Si el producto no es conjunto, usa `vinculado_a` / `vinculado_cantidad`
 *         del producto.
 *      4. Si hay link, corre una transacción Firestore: lee el doc del item,
 *         si todavía no fue procesado descuenta del producto fuente y marca
 *         el item con `consumibles_procesado: true`. La transacción previene
 *         doble-descuento cuando hay varias pestañas/clientes abiertos.
 *
 * Notas:
 *  - El producto fuente es CUALQUIER doc del catálogo. Si es no-conjunto,
 *    actualiza `stock`. Si es conjunto con variedades, no podemos saber a
 *    qué variedad descontar — por ahora actualizamos `stock` igualmente
 *    como flag, pero el cálculo real del conjunto va a seguir devolviendo
 *    su total de variedades. En la práctica esto sólo es útil para no-conjunto.
 *  - El cache del catálogo se invalida después del descuento para que la
 *    pantalla de catálogo refleje el cambio en el próximo render.
 */
import {
  collection, query, where, orderBy, onSnapshot,
  doc, getDocs, runTransaction, serverTimestamp, Timestamp, setDoc
} from 'firebase/firestore';
import { invalidateCacheByPrefix } from './cache.js';

let _db = null;
let _initialized = false;
let _unsubVentas = null;
let _catalogoPorNombre = new Map();   // nombreUpper → producto del catálogo
let _catalogoCargadoAt = 0;
const CATALOGO_TTL_MS = 5 * 60 * 1000; // 5 min: refresca el lookup periódicamente

async function _asegurarCatalogo() {
  if (_catalogoCargadoAt && Date.now() - _catalogoCargadoAt < CATALOGO_TTL_MS) return;
  const snap = await getDocs(collection(_db, 'catalogo'));
  const map = new Map();
  snap.docs.forEach(d => {
    const data = d.data();
    const nombre = (data.nombre || '').toUpperCase().trim();
    if (!nombre) return;
    map.set(nombre, { doc_id: d.id, ...data });
  });
  _catalogoPorNombre = map;
  _catalogoCargadoAt = Date.now();
}

function _buscarVariedad(producto, color) {
  if (!producto || !color) return null;
  const variedades = Array.isArray(producto.conjunto_colores) ? producto.conjunto_colores : [];
  if (variedades.length === 0) return null;
  const colorUpper = String(color).trim().toLowerCase();
  return variedades.find(v => (v.color || '').toLowerCase().trim() === colorUpper) || null;
}

function _resolverLink(producto, conjuntoColor) {
  // Conjunto con variedades + color del item → buscar link de la variedad.
  if (producto && (producto.es_conjunto === true || producto.es_conjunto === 1) && conjuntoColor) {
    const variedad = _buscarVariedad(producto, conjuntoColor);
    if (variedad && variedad.vinculado_a && Number(variedad.vinculado_cantidad) > 0) {
      return {
        target_id: variedad.vinculado_a,
        cantidad_por_venta: Number(variedad.vinculado_cantidad),
        contexto: `${producto.nombre} · ${variedad.color}`,
      };
    }
    // Si la variedad no tiene link propio, no caemos al producto: el caso
    // típico es que cada variedad vincule a algo distinto.
    return null;
  }
  // No-conjunto o conjunto sin color: usar link a nivel producto.
  if (producto && producto.vinculado_a && Number(producto.vinculado_cantidad) > 0) {
    return {
      target_id: producto.vinculado_a,
      cantidad_por_venta: Number(producto.vinculado_cantidad),
      contexto: producto.nombre || producto.doc_id,
    };
  }
  return null;
}

async function _procesarItem(itemRef, itemData) {
  if (itemData.consumibles_procesado === true) return;
  if (itemData.deleted === true) return;

  const nombreVendido = (itemData.producto || '').toUpperCase().trim();
  if (!nombreVendido) return;

  await _asegurarCatalogo();
  const producto = _catalogoPorNombre.get(nombreVendido);
  if (!producto) {
    console.debug('[consumibles] producto no encontrado en catálogo:', nombreVendido);
    return;
  }

  const link = _resolverLink(producto, itemData.conjunto_color);
  if (!link) return;

  const cantidadVendida = Number(itemData.cantidad) || 1;
  const totalDescontar = cantidadVendida * link.cantidad_por_venta;
  if (totalDescontar <= 0) return;

  const targetRef = doc(_db, 'catalogo', link.target_id);

  let nuevoStock = null;
  let nombreTarget = null;
  let targetId = link.target_id;
  try {
    await runTransaction(_db, async (tx) => {
      const itemSnap = await tx.get(itemRef);
      if (!itemSnap.exists() || itemSnap.data().consumibles_procesado === true) return;

      const targetSnap = await tx.get(targetRef);
      if (!targetSnap.exists()) {
        // Producto fuente borrado: igual marcamos procesado para no reintentar.
        tx.update(itemRef, { consumibles_procesado: true, consumibles_procesado_at: serverTimestamp(), consumibles_error: 'target_no_existe' });
        return;
      }
      const targetData = targetSnap.data();
      const stockActual = Number(targetData.stock) || 0;
      // Stock -1 = servicio/ilimitado: no descontar.
      if (stockActual === -1) {
        tx.update(itemRef, { consumibles_procesado: true, consumibles_procesado_at: serverTimestamp(), consumibles_skip: 'stock_ilimitado' });
        return;
      }
      nuevoStock = Math.max(0, stockActual - totalDescontar);
      nombreTarget = targetData.nombre || '';
      if (targetData.id != null) targetId = String(targetData.id);

      tx.update(targetRef, {
        stock: nuevoStock,
        ultima_actualizacion: serverTimestamp(),
      });
      tx.update(itemRef, {
        consumibles_procesado: true,
        consumibles_procesado_at: serverTimestamp(),
        consumibles_origen: link.contexto,
        consumibles_descuento: totalDescontar,
      });
    });

    if (nuevoStock !== null) {
      // Sincronizar con `inventario` (la colección que lee el POS escritorio
      // para mantener el stock local actualizado). Best-effort, fuera de la tx.
      try {
        await setDoc(doc(_db, 'inventario', String(targetId)), {
          stock: nuevoStock,
          nombre: nombreTarget,
          ultima_actualizacion: serverTimestamp(),
        }, { merge: true });
      } catch (e) { /* silently ignore: si falla, el catálogo ya quedó actualizado */ }

      // Tocar meta-doc del catálogo para que otras pestañas/PCs refresquen.
      try {
        await setDoc(doc(_db, 'config', 'catalogo_meta'), {
          last_updated: serverTimestamp(),
        }, { merge: true });
      } catch (e) { /* idem */ }

      invalidateCacheByPrefix('catalogo');
      console.info(`[consumibles] ${link.contexto} → -${totalDescontar} de ${link.target_id} (stock ahora: ${nuevoStock})`);
    }
  } catch (err) {
    console.warn('[consumibles] error procesando item:', err);
  }
}

export function initConsumiblesWatcher(db) {
  if (_initialized) return;
  _initialized = true;
  _db = db;

  // Ventana: items con fecha_dt en las últimas 24h. Cualquier item viejo se
  // asume ya procesado o demasiado tarde para descontarse.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cutoffTs = Timestamp.fromDate(cutoff);

  const q = query(
    collection(_db, 'ventas_por_dia'),
    where('fecha_dt', '>=', cutoffTs),
    orderBy('fecha_dt', 'desc')
  );

  _unsubVentas = onSnapshot(q, async (snap) => {
    // Procesa sólo los cambios "added" o "modified" — los "removed" no nos
    // interesan (el item ya fue eliminado de la venta, no descontamos nada).
    const cambios = snap.docChanges().filter(c => c.type === 'added' || c.type === 'modified');
    if (cambios.length === 0) return;
    for (const c of cambios) {
      await _procesarItem(c.doc.ref, c.doc.data());
    }
  }, (err) => console.warn('[consumibles] listener error:', err));
}

export function stopConsumiblesWatcher() {
  if (_unsubVentas) { try { _unsubVentas(); } catch {} _unsubVentas = null; }
  _initialized = false;
  _catalogoPorNombre = new Map();
  _catalogoCargadoAt = 0;
}
