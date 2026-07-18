/**
 * Resumen de inventario — agregado de velocidad de venta mantenido por la webapp.
 *
 * Problema: la pestaña Inventario calculaba la velocidad de venta reescaneando
 * hasta 5000 docs de `ventas_por_dia` en el navegador CADA vez que se abría.
 *
 * Solución: un único doc `inventario_resumen/current` con la velocidad ya
 * computada (u7/u30/u90 por producto + serie por día). El store lo deja pinneado
 * como `inv:resumen` (ver store.js) → la pestaña lo lee sincrónico (1 doc) en vez
 * de procesar miles. Se regenera solo cuando está vencido (> 6h) o ausente,
 * reusando los datos de `ventas_por_dia` que el store YA tiene en memoria
 * (key pinned `historial:ventas_dia:v3`) — no baja nada nuevo de Firestore.
 *
 * Lo mantiene la webapp (no el POS): evita un release del .exe y un backfill.
 * El shape soporta que en el futuro el POS incremente contadores por venta.
 */
import { collection, getDocs, query, orderBy, limit, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { getCached, peekCacheValue } from './cache.js';
import { ensureCollections } from './store.js';

// Cada cuánto se considera "vencido" el resumen. 6h: el inventario es una vista
// de gestión, no necesita el dato al segundo; entre regeneraciones igual hay
// fallback en vivo. El que abre con el doc viejo lo regenera para los demás.
export const RESUMEN_TTL_MS = 6 * 60 * 60 * 1000;

// Guardas de concurrencia: una sola regeneración a la vez, y no martillar
// Firestore si varias cosas piden recompute seguido.
let _recomputando = false;
let _ultimoRecompute = 0;

/** Date desde Timestamp / {seconds} / ISO. Devuelve null si no se puede. */
function _toDate(raw) {
  if (!raw) return null;
  try {
    if (typeof raw.toDate === 'function') return raw.toDate();
    if (typeof raw === 'object' && raw.seconds !== undefined) return new Date(raw.seconds * 1000);
    const d = new Date(raw);
    return isNaN(d) ? null : d;
  } catch (_) { return null; }
}

/** "dd/mm/yyyy" → Date local (00:00). null si el formato no matchea. */
function _fechaDMY(str) {
  const parts = (str || '').split('/');
  if (parts.length !== 3) return null;
  const d = new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`);
  return isNaN(d) ? null : d;
}

/**
 * ¿El resumen está ausente o vencido? Usado para decidir si vale la pena
 * regenerarlo. Tolerante: si no hay generado_at, se considera vencido.
 */
export function resumenEstaVencido(resumen, ttl = RESUMEN_TTL_MS) {
  if (!resumen || !resumen.por_producto) return true;
  const gen = _toDate(resumen.generado_at);
  if (!gen) return true;
  return (Date.now() - gen.getTime()) > ttl;
}

/**
 * Computa el agregado de velocidad desde los items crudos de ventas_por_dia.
 * Pura: recibe los docs y devuelve el shape del resumen (sin generado_at).
 * @param {Array<{producto?:string, fecha?:string, cantidad?:number}>} docs
 */
export function computarResumen(docs) {
  const porProducto = {};
  const porDia = {};
  const hace90 = new Date(); hace90.setDate(hace90.getDate() - 90);
  const hace30 = new Date(); hace30.setDate(hace30.getDate() - 30);
  const hace14 = new Date(); hace14.setDate(hace14.getDate() - 14);
  const hace7  = new Date(); hace7.setDate(hace7.getDate() - 7);

  let unidades30 = 0;
  let items14 = 0;

  (docs || []).forEach(v => {
    const fechaV = _fechaDMY(v.fecha);
    if (!fechaV) return;
    const cant = Number(v.cantidad) || 1;

    if (fechaV >= hace14) {
      porDia[v.fecha] = (porDia[v.fecha] || 0) + cant;
      items14 += cant;
    }

    const nombre = (v.producto || '').toUpperCase().trim();
    if (!nombre) return;
    if (fechaV < hace90) return;

    const slot = porProducto[nombre] || (porProducto[nombre] = { u7: 0, u30: 0, u90: 0 });
    slot.u90 += cant;
    if (fechaV >= hace30) {
      slot.u30 += cant;
      unidades30 += cant;
      if (fechaV >= hace7) slot.u7 += cant;
    }
  });

  return {
    ventana_dias: 90,
    por_producto: porProducto,
    por_dia: porDia,
    totales: { unidades_30d: Math.round(unidades30), items_14d: Math.round(items14) },
  };
}

/**
 * Lee los items crudos de ventas_por_dia. Prioriza la key pinned del store
 * (`historial:ventas_dia:v3`, ya en memoria) y cae a getDocs sólo si no está.
 */
async function _leerVentasPorDia(db) {
  return getCached('historial:ventas_dia:v3', async () => {
    const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha_dt', 'desc'), limit(5000)))
      .catch(() => ({ docs: [] }));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  });
}

/**
 * Regenera inventario_resumen/current si está vencido/ausente (o force).
 * Idempotente y debounced: una sola escritura a la vez. No lanza — devuelve el
 * resumen calculado o null si no hizo falta / falló.
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {{ force?: boolean }} opts
 */
export async function recomputarResumenInventario(db, { force = false } = {}) {
  if (_recomputando) return null;
  // Anti-martilleo: no regenerar más de una vez por minuto salvo force.
  if (!force && (Date.now() - _ultimoRecompute) < 60 * 1000) return null;

  const actual = peekCacheValue('inv:resumen');
  if (!force && !resumenEstaVencido(actual)) return actual;

  _recomputando = true;
  try {
    ensureCollections(['ventas_por_dia']);
    const docs = await _leerVentasPorDia(db);

    // No pisar un resumen bueno con uno vacío por un snapshot transitorio:
    // si no llegaron docs pero ya existe un resumen, dejar el existente.
    if ((!docs || !docs.length) && actual && actual.por_producto) return actual;

    const computed = computarResumen(docs);
    const payload = { ...computed, generado_at: serverTimestamp() };
    await setDoc(doc(db, 'inventario_resumen', 'current'), payload, { merge: false });
    _ultimoRecompute = Date.now();
    // El listener del store repoblará `inv:resumen` con el doc escrito (incluye
    // el serverTimestamp resuelto). Devolvemos una copia con timestamp local
    // para que el caller pueda usarla de inmediato sin esperar el round-trip.
    return { ...computed, generado_at: new Date() };
  } catch (err) {
    console.warn('[inv-resumen] recompute falló:', err?.message || err);
    return null;
  } finally {
    _recomputando = false;
  }
}

/**
 * Cantidad sugerida a comprar para cubrir `coberturaDias` de venta.
 * sugerido = max(stock_min, ceil(velocidadDiaria × coberturaDias)) − stock.
 * Nunca negativo. Si no hay velocidad ni stock_min, devuelve 0 (no sugerimos a
 * ciegas). Redondea hacia arriba: es mejor pedir de más que quedar corto.
 */
export function sugerirCantidad(velocidadDiaria, stock, stockMin = 0, coberturaDias = 30) {
  const vel = Math.max(0, Number(velocidadDiaria) || 0);
  const stk = Math.max(0, Number(stock) || 0);
  const min = Math.max(0, Number(stockMin) || 0);
  const objetivo = Math.max(min, Math.ceil(vel * coberturaDias));
  if (objetivo <= 0) return 0;
  return Math.max(0, objetivo - stk);
}

/**
 * Valorización de stock: capital invertido (stock × costo) y valor a la venta
 * (stock × precio), total y desglosado por rubro.
 * @param {Array} prods
 * @param {(p:any)=>number} stockOf  accessor de stock efectivo (conjunto-aware)
 */
export function valorizarStock(prods, stockOf) {
  let totalCosto = 0, totalVenta = 0;
  const porRubro = {};
  (prods || []).forEach(p => {
    const stk = Math.max(0, Number(stockOf ? stockOf(p) : p.stock) || 0);
    if (!stk) return;
    const costo  = Math.max(0, Number(p.costo) || 0) * stk;
    const precio = Math.max(0, Number(p.precio_venta || p.precio) || 0) * stk;
    totalCosto += costo;
    totalVenta += precio;
    const r = (p.rubro || 'Sin rubro').toUpperCase();
    const slot = porRubro[r] || (porRubro[r] = { rubro: r, costo: 0, venta: 0, items: 0, unidades: 0 });
    slot.costo += costo;
    slot.venta += precio;
    slot.items += 1;
    slot.unidades += stk;
  });
  const rubros = Object.values(porRubro).sort((a, b) => b.costo - a.costo);
  return { totalCosto, totalVenta, porRubro: rubros };
}

/**
 * Chequeo de consistencia: detecta datos que romperían los cálculos del
 * inventario y los reporta en consola (no bloquea). Devuelve la lista de
 * issues para que el caller pueda mostrar un aviso si quiere.
 */
export function validarInventario(prods, resumen) {
  const issues = [];
  const vistos = new Map(); // nombre_upper → cantidad

  (prods || []).forEach(p => {
    const id = p.doc_id || p.id;
    if (!id) issues.push({ tipo: 'sin_doc_id', nombre: p.nombre || '(sin nombre)' });

    // Solo marcamos stock NO numérico (dato roto). El stock negativo es un
    // estado normal (producto vendido sin reponer) que el inventario clampea a 0.
    if (p.stock !== undefined && p.stock !== null && p.stock !== '' && isNaN(Number(p.stock))) {
      issues.push({ tipo: 'stock_no_numerico', nombre: p.nombre, valor: p.stock });
    }
    if (p.costo !== undefined && p.costo !== null && p.costo !== '' && isNaN(Number(p.costo))) {
      issues.push({ tipo: 'costo_invalido', nombre: p.nombre, valor: p.costo });
    }

    const esConj = p.es_conjunto === true || p.es_conjunto === 1;
    if (esConj && !(Array.isArray(p.conjunto_colores) && p.conjunto_colores.length) && !Number(p.conjunto_total)) {
      issues.push({ tipo: 'conjunto_vacio', nombre: p.nombre });
    }

    const nombre = (p.nombre || '').toUpperCase().trim();
    if (nombre) vistos.set(nombre, (vistos.get(nombre) || 0) + 1);
  });

  // Nombres duplicados: la velocidad se matchea por nombre, así que dos
  // productos con el mismo nombre comparten (y se pisan) la velocidad.
  vistos.forEach((n, nombre) => {
    if (n > 1) issues.push({ tipo: 'nombre_duplicado', nombre, veces: n });
  });

  if (resumen && resumenEstaVencido(resumen)) {
    issues.push({ tipo: 'resumen_vencido', generado_at: resumen.generado_at || null });
  }

  if (issues.length) {
    const resumenPorTipo = issues.reduce((acc, i) => { acc[i.tipo] = (acc[i.tipo] || 0) + 1; return acc; }, {});
    // Desglose legible directo (sin tener que expandir el objeto en consola).
    const desglose = Object.entries(resumenPorTipo).map(([t, n]) => `${t}: ${n}`).join(' · ');
    console.warn(`[inv-validacion] ${issues.length} anomalías → ${desglose}`);
    // Ejemplos concretos por tipo (hasta 3 de cada uno) para poder ubicarlos.
    // Incluye el valor crudo (y su tipo JS) cuando aplica, para distinguir un
    // dato roto de un falso positivo (ej. "1,5" con coma → NaN).
    Object.keys(resumenPorTipo).forEach(tipo => {
      const ejemplos = issues.filter(i => i.tipo === tipo).slice(0, 3).map(i => {
        const val = ('valor' in i) ? ` = ${JSON.stringify(i.valor)} (${typeof i.valor})` : '';
        return `${i.nombre || i.generado_at || '(?)'}${val}`;
      });
      console.warn(`   • ${tipo}: ${ejemplos.join('  |  ')}${resumenPorTipo[tipo] > 3 ? ' …' : ''}`);
    });
  }
  return issues;
}
