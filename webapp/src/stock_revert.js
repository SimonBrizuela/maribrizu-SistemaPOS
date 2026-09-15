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
 * `config/inventario_meta` para que las PCs detecten el cambio. La tienda online
 * lee su propio espejo y también se entera: ver `_avisarALaTienda()` al final.
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
import { unidadesBase, PC_TIENDA } from './pedido_venta.js';

const MAX_OPS_POR_BATCH = 400;

/**
 * Los renglones de `ventas_por_dia` de una venta.
 *
 * El POS guarda `num_venta` como número y la tienda como texto (el código del
 * pedido, "Y73U"). Buscar solo como número no encontraba ningún renglón de una
 * venta de la tienda: no se devolvía el stock y el renglón seguía contando en
 * el balance. Se busca con los dos tipos y se queda con los de esa PC, porque
 * el número de venta se repite entre PCs.
 *
 * @param {{id?: string, sale_id?: string|number, pc_id?: string}} venta
 */
export async function itemsDeLaVenta(db, venta) {
  const saleId = venta?.sale_id ?? venta?.id;
  const pcId = String(venta?.pc_id || '');
  if (saleId === undefined || saleId === null || saleId === '') return [];

  const valores = new Set([saleId]);
  const texto = String(saleId).trim();
  valores.add(texto);
  if (/^\d+$/.test(texto)) valores.add(Number(texto));

  const snap = await getDocs(query(collection(db, 'ventas_por_dia'), where('num_venta', 'in', [...valores])));
  return pcId ? snap.docs.filter(d => d.id.startsWith(pcId + '_')) : snap.docs;
}

/** Un renglón que escribió la tienda al entregar un pedido (`pedido_venta.js`). */
function _esDeLaTienda(item) {
  return item?.origen === 'tienda' || item?.pc_id === PC_TIENDA;
}

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

/**
 * Un producto sin control de stock, al que no hay nada que devolverle: la venta
 * nunca se lo descontó. Manda la bandera, igual que en el POS; el -1 suelto es
 * el fallback legacy de las fichas sin migrar. Antes se miraba sólo el número,
 * así que borrar una venta le SUMABA stock a un servicio marcado cuyo stock no
 * era exactamente -1.
 */
export function _esIlimitado(p) {
  if (!p) return false;
  if (p.stock_ilimitado === true || p.stock_ilimitado === 1) return true;
  return _num(p.stock) === -1;
}

// ── Nombre del item en `ventas_por_dia` ──────────────────────────────────────
// El POS guarda el nombre "decorado" cuando la venta salió del diálogo de
// producto conjunto:  "[Verde]  GOMA EVA 40X60  ·  2 u"  /  "PAPEL A4  ·  1 pack(s)".
// Separar variante, nombre real y presentación para ubicar el producto en el
// catálogo y saber cuánto stock (en unidad base) devolver. La lectura del
// nombre vive en `nombre_item.js`: la usa también la velocidad de venta del
// Inventario, y las tablas de ahí son gemelas de las del POS.
import {
  CONJ_TIPOS, CONJ_UNIDADES, UNIDAD_WEBAPP, parseNombreItem, factorPorUnidad,
} from './nombre_item.js';

// Se siguen exportando con los nombres de antes: los usa la prueba que compara
// las tablas contra las del POS.
export { CONJ_TIPOS, CONJ_UNIDADES, UNIDAD_WEBAPP };
export const _parseNombreItem = parseNombreItem;
export const _factorPorUnidad = factorPorUnidad;

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
 *
 * Devuelve los campos que quedaron escritos en el catálogo. El total y el
 * reparto entre packs cerrados y sueltos salen de leer el documento adentro de
 * la transacción, así que afuera no hay forma de calcularlos; el espejo de la
 * tienda los necesita para publicar el stock de cada variedad.
 */
async function _revertirConjunto(db, docId, invDocId, nombre, a) {
  const catRef = doc(db, 'catalogo', docId);
  const invRef = doc(db, 'inventario', invDocId);
  let escrito = null;

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
      escrito = {
        conjunto_colores:  nuevas,
        conjunto_unidades: nuevas.reduce((acc, v) => acc + _num(v.unidades), 0),
        conjunto_restante: _redondear(nuevas.reduce((acc, v) => acc + _num(v.restante), 0)),
        conjunto_total:    _redondear(total),
        // El espejo entero del total, igual que el conjunto sin variantes de
        // abajo y que la venta al descontar. Sin esto el total volvía y `stock`
        // se quedaba con el número de después de la venta.
        stock:             Math.round(total),
      };
      tx.set(catRef, { ...escrito, ultima_actualizacion: serverTimestamp() }, { merge: true });
      tx.set(invRef, {
        stock: Math.round(total), nombre,
        id: parseInt(invDocId) || invDocId,
        ultima_actualizacion: serverTimestamp(),
      }, { merge: true });
      return;
    }

    // Conjunto sin variantes: total plano + espejo entero en `stock` (igual que el POS).
    const r = _repartirTotal(_num(p.conjunto_total) + a.conjunto, contGlobal);
    escrito = {
      conjunto_total:    r.total,
      conjunto_unidades: r.unidades,
      conjunto_restante: r.restante,
      stock:             Math.round(r.total),
    };
    tx.set(catRef, { ...escrito, ultima_actualizacion: serverTimestamp() }, { merge: true });
    tx.set(invRef, {
      stock: Math.round(r.total), nombre,
      id: parseInt(invDocId) || invDocId,
      ultima_actualizacion: serverTimestamp(),
    }, { merge: true });
  });

  return escrito;
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
  if (!docs) docs = await itemsDeLaVenta(db, { sale_id: saleId, pc_id: pcId });
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
      if (_esIlimitado(target)) continue;   // servicio/ilimitado: nunca se descontó
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

    let prod;
    let cantBase;
    let parsed = { color: '' };

    if (_esDeLaTienda(it)) {
      // 3.b (tienda) — Inversa exacta de `planDescuento` (pedido_venta.js), que
      // es lo que descontó al entregar: el producto viene por id, la cantidad
      // por `es_pack` × `pack_contenido` (el nombre no trae "· 1 Caja") y el
      // stock propio baja aunque el producto tenga vínculos.
      const productoId = String(it.producto_id || '').trim();
      // Sin producto es el renglón del envío: no hay stock que devolver.
      if (!productoId) continue;
      prod = porDocId.get(productoId) || porNombre.get(nombre);
      if (!prod) { _omitir(nombreOriginal, 'no se encontró en el catálogo'); continue; }
      if (prod.stock_ilimitado === true || prod.stock_ilimitado === 1) continue;
      cantBase = _redondear(unidadesBase(it));
    } else {
      // 3.b — Stock propio del producto vendido. Primero por nombre exacto; si no
      // aparece, se reintenta con el nombre limpio (sin variante ni presentación).
      parsed = _parseNombreItem(nombreOriginal);
      prod = porNombre.get(nombre);
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
      if (_esIlimitado(prod)) continue;                       // servicio/ilimitado
      if (_linksDe(prod).length > 0) continue;                // el stock vive en los targets

      cantBase = cantidad;
      if (_esConjunto(prod) && parsed.descripcion) {
        const factor = _factorPorUnidad(prod, parsed.descripcion);
        if (factor === null) {
          _omitir(prod.nombre || nombreOriginal, `no se pudo interpretar "${parsed.descripcion}" — ajustá el stock a mano`);
          continue;
        }
        cantBase = _redondear(cantidad * factor);
      }
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
  // Los productos que quedaron con stock nuevo, ya con el cambio aplicado
  // encima: es lo que necesita el espejo de la tienda (ver `_avisarALaTienda`).
  const cambiados = [];

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
        const escrito = await _revertirConjunto(db, docId, invDocId, nombre, a);
        if (escrito) cambiados.push({ docId, datos: { ...p, ...escrito } });
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
      // El número lo escribe Firestore con `increment()` sobre el valor real;
      // acá se suma sobre el que tiene el panel en memoria. Si justo otra PC
      // vendió en el mismo segundo la vidriera queda un pelo desfasada, y eso
      // lo corrige la próxima venta o la corrida del sync. Lo que no se puede
      // perder es que el producto vuelva a estar.
      cambiados.push({ docId, datos: { ...p, stock: _redondear(_num(p.stock) + a.plano) } });
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

  await _avisarALaTienda(db, cambiados);

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

/**
 * Vuelve a poner en la vidriera lo que la venta borrada devolvió.
 *
 * El caso real: se vendió la última unidad, el POS dejó el producto en cero y
 * lo sacó del espejo; el local se da cuenta de que la venta estaba mal y la
 * borra. El stock vuelve al catálogo, pero el documento del espejo ya no
 * existe.
 *
 * Por eso acá no sirve `avisarStockALaTienda()`, que es lo que usa el resto del
 * panel (la ficha, el conteo físico, la reposición, el editor rápido): sabe
 * actualizar el stock del espejo o borrarlo, y las dos puertas dan por sentado
 * que el producto ya está publicado. Su `updateDoc` sobre un documento que no
 * está falla y el error se traga en silencio. `reflejarSiPublicado()` tampoco:
 * se planta antes justamente si el producto no está en la tienda.
 *
 * La puerta que corresponde es `espejar()`, la misma del guardado de la ficha:
 * escribe el documento —lo cree si hace falta— cuando el producto tiene que
 * estar, y lo borra cuando no. Necesita el producto entero (precio, fotos,
 * rubro, variedades) y no solo el stock, así que se le pasa el del catálogo que
 * el panel ya tiene en memoria con la devolución aplicada encima.
 *
 * Sin la lista de rubros habilitados no se toca nada. `motivoDeNoPublicar()`
 * con `null` saltea el rubro apagado y la falta de foto, así que espejar así
 * publicaría cosas que la tienda no muestra. Mismo criterio que el recuento de
 * la portada: si la configuración no se pudo leer, lo arregla el sync.
 *
 * Nada de esto puede tirar error hacia arriba: el stock ya se devolvió, y
 * Ventas trata el error de esta función como "no se pudo devolver el stock" y
 * le pregunta al usuario si borra la venta igual. Que la vidriera se entere seis
 * horas más tarde no justifica esa pregunta.
 *
 * @param {Array<{docId: string, datos: object}>} cambiados
 */
async function _avisarALaTienda(db, cambiados) {
  if (!db || !cambiados.length) return;
  try {
    // Tarde y por dinámico: quien borra una venta no tiene por qué haber
    // cargado el módulo del espejo, y así este archivo se sigue pudiendo
    // importar sin arrastrar Firebase Storage ni la tienda entera.
    const { espejar, leerPublicacion, programarRecuentoDeRubros } =
      await import('./tienda_espejo.js');

    const { rubros, subrubrosExcluidos } = await leerPublicacion(db);
    if (!Array.isArray(rubros)) return;

    let hayEnLaVidriera = false;
    for (const { docId, datos } of cambiados) {
      try {
        const { publicado } = await espejar(db, docId, datos, rubros, subrubrosExcluidos);
        if (publicado) hayEnLaVidriera = true;
      } catch (err) {
        console.warn('[tienda] no se pudo actualizar el espejo de', docId, err?.message || err);
      }
    }

    // Un producto que vuelve a la vidriera cambia el número que la portada
    // muestra en su rubro y en su subrubro. Si ya estaba publicado el conteo da
    // igual que antes: es una escritura sola, agrupada con las demás de los
    // próximos segundos, y es más barato eso que leer el espejo de cada
    // producto para saber si hacía falta.
    if (hayEnLaVidriera) programarRecuentoDeRubros(db);
  } catch (err) {
    console.warn('[tienda] no se le pudo avisar a la tienda:', err?.message || err);
  }
}
