/**
 * Watcher de "consumibles": cuando se vende un producto que está vinculado a
 * uno o más productos (ej: "Impresión Color" → "Hojas Pampa" + "Tóner"),
 * descuenta automáticamente stock de TODOS los productos fuente.
 *
 * Cómo funciona:
 *  - Escucha en tiempo real la colección `ventas_por_dia` (limitado a las
 *    últimas 24h para no leer toda la historia).
 *  - Para cada item nuevo:
 *      1. Encuentra el producto del catálogo por nombre (case-insensitive).
 *      2. Si el producto es conjunto Y el item trae conjunto_color, busca la
 *         variedad y usa sus `vinculaciones[]`. Si la variedad no tiene links
 *         propios, NO cae al producto (cada variedad decide su descuento).
 *      3. Si el producto no es conjunto, usa `vinculaciones[]` del producto.
 *      4. Si hay 1+ links, corre UNA transacción Firestore atómica: lee el doc
 *         del item + todos los targets, si el item no fue procesado descuenta
 *         de cada target y marca el item con `consumibles_procesado: true`.
 *
 * Formato `vinculaciones[]`: Array<{doc_id, cantidad, nombre}>.
 * Fallback legacy: si el campo no existe pero hay `vinculado_a` / `vinculado_cantidad`,
 * se sintetiza un array de 1 entry. El save del catálogo además replica el primer
 * entry en los campos legacy para compat doble-vía.
 */
import {
  collection, query, where, orderBy, onSnapshot,
  doc, getDocs, runTransaction, serverTimestamp, Timestamp, setDoc
} from 'firebase/firestore';
import { invalidateCacheByPrefix } from './cache.js';
import { registrarMovimiento } from './stock_ledger.js';

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
    map.set(nombre, { ...data, doc_id: d.id });
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

// Devuelve array de {target_id, cantidad_por_venta, contexto}.
// Acepta formato nuevo (vinculaciones[]) y legacy (vinculado_a/cantidad/nombre).
function _extraerLinks(obj, contexto) {
  const out = [];
  if (!obj) return out;
  if (Array.isArray(obj.vinculaciones) && obj.vinculaciones.length > 0) {
    for (const v of obj.vinculaciones) {
      if (v && v.doc_id && Number(v.cantidad) > 0) {
        out.push({
          target_id: String(v.doc_id),
          cantidad_por_venta: Number(v.cantidad),
          contexto,
        });
      }
    }
    return out;
  }
  if (obj.vinculado_a && Number(obj.vinculado_cantidad) > 0) {
    out.push({
      target_id: String(obj.vinculado_a),
      cantidad_por_venta: Number(obj.vinculado_cantidad),
      contexto,
    });
  }
  return out;
}

function _resolverLinks(producto, conjuntoColor) {
  // Conjunto con variedades + color del item → buscar links de la variedad.
  if (producto && (producto.es_conjunto === true || producto.es_conjunto === 1) && conjuntoColor) {
    const variedad = _buscarVariedad(producto, conjuntoColor);
    if (!variedad) return [];
    return _extraerLinks(variedad, `${producto.nombre} · ${variedad.color}`);
  }
  // No-conjunto o conjunto sin color: usar links a nivel producto.
  return _extraerLinks(producto, producto?.nombre || producto?.doc_id || '');
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

  const links = _resolverLinks(producto, itemData.conjunto_color);
  if (!links.length) return;

  const cantidadVendida = Number(itemData.cantidad) || 1;
  // Calcular el descuento total por link y filtrar inválidos / duplicados.
  const seen = new Set();
  const work = [];
  for (const l of links) {
    if (seen.has(l.target_id)) continue;
    seen.add(l.target_id);
    const total = cantidadVendida * l.cantidad_por_venta;
    if (total > 0) work.push({ ...l, total });
  }
  if (!work.length) return;

  const targetRefs = work.map(l => doc(_db, 'catalogo', l.target_id));
  // Resultados a sincronizar con `inventario` fuera de la tx.
  const updates = [];
  // Para log/auditoría
  const procesados = [];

  try {
    await runTransaction(_db, async (tx) => {
      const itemSnap = await tx.get(itemRef);
      if (!itemSnap.exists() || itemSnap.data().consumibles_procesado === true) return;

      // Leer todos los targets primero (Firestore exige todas las lecturas antes
      // de cualquier escritura dentro de la transacción).
      const targetSnaps = [];
      for (let i = 0; i < targetRefs.length; i++) {
        targetSnaps.push(await tx.get(targetRefs[i]));
      }

      // Limpiar acumuladores en caso de retry de la transacción.
      updates.length = 0;
      procesados.length = 0;

      for (let i = 0; i < work.length; i++) {
        const w = work[i];
        const snap = targetSnaps[i];
        if (!snap.exists()) {
          procesados.push({ ...w, error: 'no_existe' });
          continue;
        }
        const data = snap.data();
        const stockActual = Number(data.stock) || 0;
        // Stock -1 = servicio/ilimitado: no descontar.
        if (stockActual === -1) {
          procesados.push({ ...w, skip: 'stock_ilimitado' });
          continue;
        }
        const nuevoStock = Math.max(0, stockActual - w.total);
        const nombreTarget = data.nombre || '';
        const targetIdInv = data.id != null ? String(data.id) : w.target_id;

        tx.update(targetRefs[i], {
          stock: nuevoStock,
          ultima_actualizacion: serverTimestamp(),
        });
        updates.push({ id: targetIdInv, stock: nuevoStock, nombre: nombreTarget });
        procesados.push({ ...w, nuevoStock, stockAntes: stockActual, nombreTarget });
      }

      tx.update(itemRef, {
        consumibles_procesado: true,
        consumibles_procesado_at: serverTimestamp(),
        consumibles_descuentos: procesados.map(p => ({
          contexto: p.contexto,
          target_id: p.target_id,
          cantidad: p.total,
          ...(p.skip ? { skip: p.skip } : {}),
          ...(p.error ? { error: p.error } : {}),
        })),
        // Legacy: si hubo un único descuento real, replicar campos viejos.
        ...(procesados.filter(p => !p.skip && !p.error).length === 1 ? {
          consumibles_origen:    procesados[0].contexto,
          consumibles_descuento: procesados[0].total,
        } : {}),
      });
    });

    if (updates.length > 0) {
      // Lo que consumió la impresión también va al historial: es stock que sale
      // sin que nadie lo venda de forma directa, y es el que más desconcierta
      // después cuando el número no cierra.
      for (const p of procesados) {
        if (p.skip || p.error || p.nuevoStock == null) continue;
        registrarMovimiento(_db, {
          docId: p.target_id, nombre: p.nombreTarget || '',
          motivo: 'vinculacion', antes: p.stockAntes, despues: p.nuevoStock,
          detalle: `Consumido por ${p.contexto || ''}`.trim(),
        });
      }
      // Sincronizar `inventario` (lo lee el POS de escritorio). Best-effort.
      for (const u of updates) {
        try {
          await setDoc(doc(_db, 'inventario', u.id), {
            stock: u.stock,
            nombre: u.nombre,
            ultima_actualizacion: serverTimestamp(),
          }, { merge: true });
        } catch (e) { /* silently ignore */ }
      }
      // Tocar meta-doc para que otras pestañas refresquen.
      try {
        await setDoc(doc(_db, 'config', 'catalogo_meta'), {
          last_updated: serverTimestamp(),
        }, { merge: true });
      } catch (e) { /* idem */ }

      invalidateCacheByPrefix('catalogo');
      console.info(`[consumibles] ${updates.length} descuento(s) aplicados para "${nombreVendido}"`);
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
