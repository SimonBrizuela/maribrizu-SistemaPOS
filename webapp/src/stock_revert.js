/**
 * Reversión de stock al eliminar una venta desde la webapp.
 *
 * Al vender, el POS descuenta stock en tres formas distintas según el producto:
 *   1. Producto plano        → `catalogo.stock -= cantidad`
 *   2. Producto conjunto     → recalcula `conjunto_total/unidades/restante`
 *                              (por variedad si el item trae `conjunto_color`)
 *   3. Producto vinculado    → NO toca su stock propio; descuenta de los targets
 *                              y deja el detalle en el item de `ventas_por_dia`
 *                              (`consumibles_descuentos`). Lo mismo hace el
 *                              watcher web (consumibles_watcher.js).
 *
 * Este módulo revierte exactamente esas tres formas leyendo los items de la
 * venta en `ventas_por_dia`, y marca cada item con `stock_revertido: true` para
 * que la operación sea idempotente (re-eliminar no duplica la devolución).
 *
 * Escribe en `catalogo` (fuente del webapp) y en `inventario` (lo que lee el POS
 * de escritorio por id numérico), y toca `config/catalogo_meta` +
 * `config/inventario_meta` para que las PCs detecten el cambio.
 *
 * Lo que NO se puede revertir automáticamente queda listado en `omitidos` con el
 * motivo, para avisarle al usuario que lo ajuste a mano.
 */
import {
  collection, query, where, getDocs, doc, writeBatch, runTransaction,
  serverTimestamp, increment, setDoc,
} from 'firebase/firestore';
import { getCached, invalidateCacheByPrefix } from './cache.js';
import { registrarMovimiento } from './stock_ledger.js';

const MAX_OPS_POR_BATCH = 400;

function _num(n) { return Number(n) || 0; }
function _redondear(n) { return Math.round(_num(n) * 10000) / 10000; }

/** Vínculos de un producto: formato nuevo `vinculaciones[]` + fallback legacy. */
function _linksDe(p) {
  if (!p) return [];
  if (Array.isArray(p.vinculaciones) && p.vinculaciones.length) {
    return p.vinculaciones
      .filter(v => v && v.doc_id && _num(v.cantidad) > 0)
      .map(v => ({ doc_id: String(v.doc_id), cantidad: _num(v.cantidad) }));
  }
  if (p.vinculado_a && _num(p.vinculado_cantidad) > 0) {
    return [{ doc_id: String(p.vinculado_a), cantidad: _num(p.vinculado_cantidad) }];
  }
  return [];
}

function _esConjunto(p) { return p && (p.es_conjunto === true || p.es_conjunto === 1); }

// ── Nombre del item en `ventas_por_dia` ──────────────────────────────────────
// El POS guarda el nombre "decorado" cuando la venta salió del diálogo de
// producto conjunto:  "[Verde]  GOMA EVA 40X60  ·  2 u"  /  "PAPEL A4  ·  1 pack(s)".
// Hay que separar variante, nombre real y presentación para poder ubicar el
// producto en el catálogo y saber cuánto stock (en unidad base) devolver.
const SEPARADOR = '·';

// Espejo de TIPOS / UNIDADES de pos_system/ui/conjunto_dialog.py
const CONJ_TIPOS = {
  rollo: 'rollo', pack: 'pack', caja: 'caja', bobina: 'bobina', bolsa: 'bolsa',
  plancha: 'plancha', cartulina: 'cartulina', papel: 'papel', carton: 'cartón',
  goma_eva: 'goma eva', cinta: 'cinta', tela: 'tela', unidad: 'unidad', otro: 'otro',
};
const CONJ_UNIDADES = {
  m:  { short: 'm',  base: 'longitud', factor: 1 },
  cm: { short: 'cm', base: 'longitud', factor: 0.01 },
  u:  { short: 'u',  base: 'cuenta',   factor: 1 },
  g:  { short: 'g',  base: 'masa',     factor: 0.001 },
  kg: { short: 'kg', base: 'masa',     factor: 1 },
  l:  { short: 'l',  base: 'volumen',  factor: 1 },
  ml: { short: 'ml', base: 'volumen',  factor: 0.001 },
  m2: { short: 'm²', base: 'area',     factor: 1 },
};
const UNIDAD_WEBAPP = {
  metros: 'm', m: 'm', centimetros: 'cm', 'centímetros': 'cm', cm: 'cm',
  unidades: 'u', u: 'u', gramos: 'g', g: 'g', kilos: 'kg', kilogramos: 'kg', kg: 'kg',
  litros: 'l', l: 'l', mililitros: 'ml', ml: 'ml', m2: 'm2', 'm²': 'm2',
};

function _parseNombreItem(txt) {
  let s = String(txt || '').trim();
  let color = '';
  const m = s.match(/^\[([^\]]*)\]\s*(.+)$/);
  if (m) { color = m[1].trim(); s = m[2].trim(); }
  let descripcion = '';
  if (s.includes(SEPARADOR)) {
    const partes = s.split(SEPARADOR);
    descripcion = partes.pop().trim();
    s = partes.join(SEPARADOR).trim();
  }
  return { color, base: s, descripcion };
}

/**
 * Cuánto stock (en unidad base del conjunto) representa UNA unidad del campo
 * `cantidad` del item, según la presentación escrita en el nombre ("1 pack(s)",
 * "2 u", "0.5 m").
 *
 * El POS arma el carrito así: si la cantidad vendida es entera, va como
 * `quantity = N` con el nombre diciendo "N <unidad>"; si es decimal, va como
 * `quantity = 1` y la cantidad real queda sólo en el nombre ("0.5 m"). Por eso
 * el factor incluye N cuando N no es entero.
 *
 * Devuelve null si la unidad no se puede interpretar: es preferible no devolver
 * nada y avisar, antes que devolver una cantidad equivocada.
 */
function _factorPorUnidad(prod, descripcion) {
  const m = String(descripcion || '').trim().match(/^([\d]+(?:[.,][\d]+)?)\s*(.+)$/);
  if (!m) return null;
  const n = Number(String(m[1]).replace(',', '.'));
  if (!(n > 0)) return null;
  const unidadTxt = m[2].trim().toLowerCase();
  const porItem = Number.isInteger(n) ? 1 : n;

  // Vendido por contenedor entero: "1 pack(s)", "2 rollo(s)".
  const tipo = CONJ_TIPOS[String(prod.conjunto_tipo || '').toLowerCase()];
  const contenido = _num(prod.conjunto_contenido);
  if (tipo && unidadTxt === `${tipo}(s)`) {
    return contenido > 0 ? porItem * contenido : null;
  }

  // Vendido por unidad base o por una unidad convertible (cm→m, g→kg, …).
  const baseKey  = UNIDAD_WEBAPP[String(prod.conjunto_unidad_medida || '').toLowerCase()] || 'u';
  const specBase = CONJ_UNIDADES[baseKey];
  const spec = Object.values(CONJ_UNIDADES).find(u => u.short.toLowerCase() === unidadTxt);
  if (!spec || !specBase || spec.base !== specBase.base) return null;
  return porItem * (spec.factor / specBase.factor);
}

function _variedadesDe(p) {
  return Array.isArray(p?.conjunto_colores) ? p.conjunto_colores : [];
}

function _contenidoVariedad(v, contenidoGlobal) {
  return _num(v?.contenido) > 0 ? _num(v.contenido) : contenidoGlobal;
}

function _totalVariedad(v, contenidoGlobal) {
  return _num(v?.unidades) * _contenidoVariedad(v, contenidoGlobal) + _num(v?.restante);
}

/**
 * Reparte un total en (unidades cerradas + restante suelto) manteniendo el
 * invariante que usa el webapp: total = unidades × contenido + restante.
 */
function _repartirTotal(total, contenido) {
  const t = Math.max(0, _redondear(total));
  if (!(contenido > 0)) return { unidades: 0, restante: t, total: t };
  const cerrados = Math.floor(t / contenido);
  const resto = _redondear(t - cerrados * contenido);
  return { unidades: cerrados, restante: resto, total: t };
}

/**
 * Devuelve stock a un producto conjunto leyendo su estado real dentro de una
 * transacción. `a` es el ajuste acumulado: `variedades` (Map color→cantidad)
 * y/o `conjunto` (cantidad al total, para conjuntos sin variantes).
 */
async function _revertirConjunto(db, docId, invDocId, nombre, a) {
  const catRef = doc(db, 'catalogo', docId);
  const invRef = doc(db, 'inventario', invDocId);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(catRef);
    if (!snap.exists()) throw new Error('el producto ya no existe en el catálogo');
    const p = snap.data() || {};
    const contGlobal = _num(p.conjunto_contenido);
    const variedades = _variedadesDe(p);

    if (a.variedades.size && variedades.length) {
      const nuevas = variedades.map(v => {
        const delta = a.variedades.get(String(v.color || '').trim().toLowerCase());
        if (!delta) return { ...v };
        const cont = _contenidoVariedad(v, contGlobal);
        const r = _repartirTotal(_totalVariedad(v, contGlobal) + delta, cont);
        return { ...v, unidades: r.unidades, restante: r.restante };
      });
      const total = nuevas.reduce((acc, v) => acc + _totalVariedad(v, contGlobal), 0);
      tx.set(catRef, {
        conjunto_colores:  nuevas,
        conjunto_unidades: nuevas.reduce((acc, v) => acc + _num(v.unidades), 0),
        conjunto_restante: _redondear(nuevas.reduce((acc, v) => acc + _num(v.restante), 0)),
        conjunto_total:    _redondear(total),
        ultima_actualizacion: serverTimestamp(),
      }, { merge: true });
      tx.set(invRef, {
        stock: Math.round(total), nombre,
        id: parseInt(invDocId) || invDocId,
        ultima_actualizacion: serverTimestamp(),
      }, { merge: true });
      return;
    }

    // Conjunto sin variantes: total plano + espejo entero en `stock` (igual que el POS).
    const r = _repartirTotal(_num(p.conjunto_total) + a.conjunto, contGlobal);
    tx.set(catRef, {
      conjunto_total:    r.total,
      conjunto_unidades: r.unidades,
      conjunto_restante: r.restante,
      stock:             Math.round(r.total),
      ultima_actualizacion: serverTimestamp(),
    }, { merge: true });
    tx.set(invRef, {
      stock: Math.round(r.total), nombre,
      id: parseInt(invDocId) || invDocId,
      ultima_actualizacion: serverTimestamp(),
    }, { merge: true });
  });
}

/**
 * Devuelve el stock de una venta eliminada.
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {object} opts
 * @param {string|number} opts.saleId    número de venta (`num_venta`)
 * @param {string}        [opts.pcId]    pc_id de la venta (filtra los items)
 * @param {Array}         [opts.itemDocs] snapshots ya leídos de `ventas_por_dia`
 * @param {boolean}       [opts.marcarDeleted] marcar los items como `deleted`
 *                        en el mismo batch (evita que el watcher de consumibles
 *                        los procese tras la modificación)
 * @returns {Promise<{devueltos: Array, omitidos: Array, items: number}>}
 */
export async function revertirStockVenta(db, { saleId, pcId = '', itemDocs = null, marcarDeleted = true } = {}) {
  const resumen = { devueltos: [], omitidos: [], items: 0 };

  // ── 1. Items de la venta ────────────────────────────────────────────────
  let docs = itemDocs;
  if (!docs) {
    const snap = await getDocs(query(
      collection(db, 'ventas_por_dia'),
      where('num_venta', '==', Number(saleId))
    ));
    docs = snap.docs;
    if (pcId) docs = docs.filter(d => d.id.startsWith(pcId + '_'));
  }
  const pendientes = docs.filter(d => (d.data() || {}).stock_revertido !== true);
  resumen.items = pendientes.length;
  if (!pendientes.length) return resumen;

  // ── 2. Catálogo (pinneado por el store; si no, una sola lectura) ─────────
  const productos = await getCached('catalogo:all', async () => {
    const snap = await getDocs(collection(db, 'catalogo'));
    return snap.docs.map(d => ({ id: d.id, ...d.data(), doc_id: d.id }));
  });
  const porNombre = new Map();
  const porDocId  = new Map();
  (productos || []).forEach(p => {
    const docId = p.doc_id || p.id;
    if (docId) porDocId.set(String(docId), p);
    const nombre = String(p.nombre || p.name || '').toUpperCase().trim();
    if (nombre && !porNombre.has(nombre)) porNombre.set(nombre, p);
  });

  // ── 3. Acumular ajustes por producto ────────────────────────────────────
  // Un mismo producto puede aparecer en varios items del ticket (o ser target
  // de varias vinculaciones): Firestore no admite dos escrituras al mismo doc
  // dentro de un batch, así que se agrupa antes de escribir.
  const ajustes = new Map();   // doc_id → { prod, plano, conjunto, variedades:Map }
  const detallePorItem = new Map(); // item doc id → [{...}]

  function _ajuste(prod) {
    const docId = String(prod.doc_id || prod.id);
    if (!ajustes.has(docId)) {
      ajustes.set(docId, { prod, plano: 0, conjunto: 0, variedades: new Map() });
    }
    return ajustes.get(docId);
  }
  function _anotar(itemId, entry) {
    if (!detallePorItem.has(itemId)) detallePorItem.set(itemId, []);
    detallePorItem.get(itemId).push(entry);
  }
  function _omitir(nombre, motivo) {
    resumen.omitidos.push({ nombre, motivo });
  }

  for (const d of pendientes) {
    const it = d.data() || {};
    const nombreOriginal = String(it.producto || it.product_name || '').trim();
    const nombre = nombreOriginal.toUpperCase();
    const cantidad = _num(it.cantidad ?? it.quantity);

    // 3.a — Vinculaciones ya aplicadas (POS o watcher web): devolver a cada target.
    const descuentos = Array.isArray(it.consumibles_descuentos) ? it.consumibles_descuentos : [];
    let huboVinculaciones = false;
    for (const dd of descuentos) {
      if (!dd || dd.skip || dd.error) continue;
      const targetId = String(dd.target_id || '').trim();
      const cant = _num(dd.cantidad);
      if (!targetId || cant <= 0) continue;
      huboVinculaciones = true;
      const target = porDocId.get(targetId);
      if (!target) { _omitir(dd.contexto || targetId, 'el producto vinculado ya no está en el catálogo'); continue; }
      const nombreTarget = target.nombre || target.name || targetId;
      if (_num(target.stock) === -1) continue;   // servicio/ilimitado: nunca se descontó
      if (_esConjunto(target)) {
        if (_variedadesDe(target).length) {
          _omitir(nombreTarget, 'conjunto con variantes vinculado — ajustá el stock a mano');
          continue;
        }
        _ajuste(target).conjunto += cant;
      } else {
        _ajuste(target).plano += cant;
      }
      _anotar(d.id, { tipo: 'vinculacion', target_id: targetId, nombre: nombreTarget, cantidad: cant });
      resumen.devueltos.push({ nombre: nombreTarget, cantidad: cant, tipo: 'vinculado' });
    }

    if (!nombreOriginal || cantidad <= 0) continue;

    // 3.b — Stock propio del producto vendido. Primero por nombre exacto; si no
    // aparece, se reintenta con el nombre limpio (sin variante ni presentación).
    const parsed = _parseNombreItem(nombreOriginal);
    let prod = porNombre.get(nombre);
    let porParseo = false;
    if (!prod && parsed.base && parsed.base.toUpperCase() !== nombre) {
      prod = porNombre.get(parsed.base.toUpperCase());
      porParseo = true;
    }
    if (!prod) {
      // Productos Madre (mp_*), "Varios" y productos borrados caen acá: el item
      // sólo guarda el nombre, no el id del producto.
      if (!huboVinculaciones) _omitir(nombreOriginal, 'no se encontró en el catálogo');
      continue;
    }
    // El nombre limpio sólo se acepta si el producto es conjunto: un nombre
    // compuesto de Producto Madre ("Madre Nodo · presentación") podría matchear
    // por casualidad otro producto del catálogo y devolverle stock que no es suyo.
    if (porParseo && !_esConjunto(prod)) {
      _omitir(nombreOriginal, 'vendido por variante o presentación — ajustá el stock a mano');
      continue;
    }
    if (_num(prod.stock) === -1) continue;                  // servicio/ilimitado
    if (_linksDe(prod).length > 0) continue;                // el stock vive en los targets

    let cantBase = cantidad;
    if (_esConjunto(prod) && parsed.descripcion) {
      const factor = _factorPorUnidad(prod, parsed.descripcion);
      if (factor === null) {
        _omitir(prod.nombre || nombreOriginal, `no se pudo interpretar "${parsed.descripcion}" — ajustá el stock a mano`);
        continue;
      }
      cantBase = _redondear(cantidad * factor);
    }

    if (_esConjunto(prod)) {
      const color = String(it.conjunto_color || '').trim() || parsed.color;
      const variedades = _variedadesDe(prod);
      if (color && variedades.length) {
        const existe = variedades.some(v => String(v.color || '').trim().toLowerCase() === color.toLowerCase());
        if (!existe) { _omitir(prod.nombre || nombreOriginal, `la variante "${color}" ya no existe`); continue; }
        const a = _ajuste(prod);
        const k = color.toLowerCase();
        a.variedades.set(k, _num(a.variedades.get(k)) + cantBase);
      } else if (variedades.length) {
        _omitir(prod.nombre || nombreOriginal, 'no se sabe de qué variante descontó — ajustá el stock a mano');
        continue;
      } else {
        _ajuste(prod).conjunto += cantBase;
      }
    } else {
      _ajuste(prod).plano += cantBase;
    }
    _anotar(d.id, { tipo: 'producto', doc_id: String(prod.doc_id || prod.id), nombre: prod.nombre || nombreOriginal, cantidad: cantBase });
    resumen.devueltos.push({ nombre: prod.nombre || nombreOriginal, cantidad: cantBase, tipo: 'producto' });
  }

  // ── 4. Escribir ─────────────────────────────────────────────────────────
  // Stock plano → increment() en batch (atómico, inmune a ventas simultáneas).
  // Conjuntos → valor absoluto, así que se recalculan dentro de una transacción
  // sobre el doc leído en el momento: si otra PC vendió mientras tanto, la
  // devolución se aplica sobre el estado real y no lo pisa.
  const ops = [];

  for (const [docId, a] of ajustes) {
    const p = a.prod;
    const invDocId = String(p.id ?? docId);
    const nombre   = p.nombre || p.name || '';

    // Lo que se devuelve queda anotado en el historial: si mañana el stock no
    // cierra, tiene que verse que acá entró mercadería por una venta borrada.
    const _devuelto = _redondear(_num(a.plano)
      + _num(a.conjunto)
      + [...a.variedades.values()].reduce((s, v) => s + _num(v), 0));
    if (_devuelto > 0) {
      registrarMovimiento(db, {
        docId, nombre, motivo: 'anulacion', cantidad: _devuelto,
        antes: _num(p.stock), despues: _num(p.stock) + _devuelto,
        referencia: `Venta #${saleId}`, detalle: 'Venta borrada desde el panel',
      });
    }

    if (a.variedades.size || a.conjunto > 0) {
      try {
        await _revertirConjunto(db, docId, invDocId, nombre, a);
      } catch (err) {
        console.warn('[stock] no se pudo devolver el conjunto', nombre, err);
        _omitir(nombre || docId, `no se pudo actualizar el stock (${err.message || err})`);
        resumen.devueltos = resumen.devueltos.filter(x => x.nombre !== nombre);
      }
      continue;
    }

    if (a.plano > 0) {
      ops.push({ ref: doc(db, 'catalogo', docId), data: {
        stock: increment(a.plano),
        ultima_actualizacion: serverTimestamp(),
      }, merge: true });
      ops.push({ ref: doc(db, 'inventario', invDocId), data: {
        stock: increment(a.plano), nombre,
        id: parseInt(invDocId) || invDocId,
        ultima_actualizacion: serverTimestamp(),
      }, merge: true });
    }
  }

  // Marca de reversión en cada item (idempotencia) + `deleted` en el mismo batch:
  // el watcher de consumibles ignora los items marcados como borrados, así que
  // escribir ambas cosas juntas evita que reprocese el item al verlo modificado.
  for (const d of pendientes) {
    const data = { stock_revertido: true, stock_revertido_at: serverTimestamp() };
    const det = detallePorItem.get(d.id);
    if (det && det.length) data.stock_revertido_detalle = det;
    if (marcarDeleted) data.deleted = true;
    ops.push({ ref: d.ref, data, merge: true });
  }

  for (let i = 0; i < ops.length; i += MAX_OPS_POR_BATCH) {
    const batch = writeBatch(db);
    ops.slice(i, i + MAX_OPS_POR_BATCH).forEach(op => batch.set(op.ref, op.data, { merge: true }));
    await batch.commit();
  }

  // ── 5. Avisar al resto (POS + otras pestañas) ───────────────────────────
  if (ajustes.size) {
    invalidateCacheByPrefix('catalogo');
    invalidateCacheByPrefix('inv:');
    const meta = { last_updated: serverTimestamp() };
    await Promise.all([
      setDoc(doc(db, 'config', 'catalogo_meta'), meta, { merge: true }).catch(() => {}),
      setDoc(doc(db, 'config', 'inventario_meta'), meta, { merge: true }).catch(() => {}),
    ]);
  }

  // Consolidar devoluciones repetidas del mismo producto para el resumen visual.
  const agrupado = new Map();
  resumen.devueltos.forEach(x => {
    const prev = agrupado.get(x.nombre);
    if (prev) prev.cantidad = _redondear(prev.cantidad + x.cantidad);
    else agrupado.set(x.nombre, { ...x });
  });
  resumen.devueltos = [...agrupado.values()];

  return resumen;
}
