import { doc, getDoc, getDocFromCache, setDoc, serverTimestamp } from 'firebase/firestore';
import { getCached, invalidateCache, setCacheValue } from './cache.js';

// Default: 2026-04-18 — día que empezamos a usar el sistema en serio.
// Todo lo anterior a esta fecha se considera data de prueba y se oculta.
const DEFAULT_FECHA_INICIO = '2026-04-18';

// Cache clave para la config: TTL 15 min.
// fecha_inicio y demás settings cambian a lo sumo una vez al mes; saveControlConfig
// ya hace invalidateCache(CFG_KEY) explícito al guardar, así que el TTL solo
// importa para refrescar cambios hechos desde otra pestaña/PC. Con 2 min se
// re-fetcheaba cuando el SDK estaba saturado de listeners → picos de 14s.
const CFG_KEY = 'control_config:settings';

export async function loadControlConfig(db) {
  return getCached(CFG_KEY, async () => {
    console.log('[config] getDoc(control_config/settings)');
    const _t0 = performance.now();
    const ref = doc(db, 'control_config', 'settings');
    try {
      // Cache-first: el doc ya vive en el IndexedDB del SDK; leerlo de ahí es
      // ~50ms, ir al server es ~2s. Y este doc GATEA el arranque —
      // ventas_por_dia y ventas (dateBounded) esperan la fecha_inicio de acá
      // antes de abrir sus listeners, así que esos 2s se pagaban en CADA
      // apertura. Revalidamos contra el server en segundo plano (sin bloquear)
      // para no perder frescura si cambió desde otra PC.
      let snap;
      try {
        snap = await getDocFromCache(ref);
        console.log(`[config] ✓ control_config (cache) en ${(performance.now() - _t0).toFixed(0)}ms`);
        getDoc(ref)
          .then(fresh => { if (fresh.exists()) setCacheValue(CFG_KEY, fresh.data()); })
          .catch(() => {});
      } catch (_) {
        // No estaba en cache local (primer uso / cache limpio) → server.
        snap = await getDoc(ref);
        console.log(`[config] ✓ control_config (server) en ${(performance.now() - _t0).toFixed(0)}ms (exists=${snap.exists()})`);
      }
      if (snap.exists()) return snap.data();
    } catch (err) {
      console.error(`[config] ✗ control_config error en ${(performance.now() - _t0).toFixed(0)}ms:`, err);
    }
    return {};
  }, { ttl: 15 * 60 * 1000 });
}

export async function saveControlConfig(db, config) {
  await setDoc(doc(db, 'control_config', 'settings'), config, { merge: true });
  invalidateCache(CFG_KEY);
}

/**
 * Lee un doc de control_config priorizando el cache local del SDK.
 *
 * Un getDoc común va al server y queda encolado detrás de los listeners
 * grandes del store (catálogo 10k + ventas_por_dia 22k docs) y del backfill de
 * índices de Firestore. Medido en un arranque en frío real: **103 segundos
 * para UN documento**, con el Balance mostrando el spinner todo ese tiempo.
 *
 * Cache-first: se lee del IndexedDB del SDK (~50 ms) y se revalida contra el
 * server en segundo plano, refrescando la key cacheada cuando llega. Es el
 * mismo patrón que ya usaba loadControlConfig y que resolvió su cuello de
 * botella.
 *
 * @param {string} docId    id del doc dentro de control_config
 * @param {string} cacheKey key de cache.js a refrescar con el dato del server
 * @param {*} vacio         qué devolver si el doc no existe o falla
 */
async function leerConfigDoc(db, docId, cacheKey, vacio = null) {
  return leerDocRapido(doc(db, 'control_config', docId), { cacheKey, vacio, etiqueta: docId });
}

/**
 * La misma lectura cache-first, para cualquier documento suelto.
 *
 * Vale para todo doc de configuración que no tenga un listener del store
 * detrás: `tienda_config/settings`, `tienda_config/publicacion` y los de
 * `control_config`. Todos caían en el mismo pozo — un getDoc al server encolado
 * detrás de los listeners grandes— y todos gatean el pintado de su pantalla.
 *
 * `alRevalidar` es para el caso en que la copia del server llega distinta de la
 * del cache: quien llama decide si repinta o si avisa, porque en una pantalla de
 * edición pisar el formulario mientras alguien escribe es peor que quedarse con
 * un dato viejo un rato.
 *
 * @param {import('firebase/firestore').DocumentReference} ref
 * @param {{cacheKey?: string, vacio?: *, etiqueta?: string,
 *          alRevalidar?: (datos: *) => void}} opciones
 */
export async function leerDocRapido(ref, {
  cacheKey = null, vacio = null, etiqueta = null, alRevalidar = null,
} = {}) {
  const nombre = etiqueta || ref?.path || 'doc';
  const _t0 = performance.now();
  try {
    let snap;
    try {
      snap = await getDocFromCache(ref);
      console.log(`[config] ✓ ${nombre} (cache) en ${(performance.now() - _t0).toFixed(0)}ms`);
      // Revalidación en segundo plano: no bloquea el pintado.
      getDoc(ref)
        .then(fresh => {
          if (!fresh.exists()) return;
          if (cacheKey) setCacheValue(cacheKey, fresh.data());
          alRevalidar?.(fresh.data());
        })
        .catch(() => {});
    } catch (_) {
      // No estaba en el cache local (primer uso / cache limpio) → server.
      snap = await getDoc(ref);
      console.log(`[config] ✓ ${nombre} (server) en ${(performance.now() - _t0).toFixed(0)}ms`);
    }
    if (snap.exists()) return snap.data();
  } catch (err) {
    console.error(`[config] ✗ error cargando ${nombre}:`, err);
  }
  return vacio;
}

// ── Balance Mensual (control_config/balance) ──────────────────────────────────
// Doc separado del settings para no mezclar con cuenta1_nombre/fecha_inicio.
// Estructura: { version, rubros[], agregados[], montosFijos[], meses{YYYY-MM:{...}} }
const BAL_KEY = 'control_config:balance';

/** Carga el doc de balance mensual (o null si no existe todavía). */
export async function loadBalanceConfig(db) {
  return getCached(BAL_KEY, () => leerConfigDoc(db, 'balance', BAL_KEY, null),
    { ttl: 5 * 60 * 1000 });
}

/**
 * Guarda (merge) en control_config/balance. El merge de Firestore es recursivo
 * para mapas, así que pasar { meses: { '2025-03': {...} } } actualiza ese mes
 * sin pisar los demás. Los arrays (ej montosFijos) se reemplazan completos.
 */
export async function saveBalanceConfig(db, partial) {
  await setDoc(
    doc(db, 'control_config', 'balance'),
    { ...partial, updatedAt: serverTimestamp() },
    { merge: true }
  );
  invalidateCache(BAL_KEY);
}

/** Fuerza el refetch del balance (tras importar histórico, etc). */
export function invalidateBalanceConfig() { invalidateCache(BAL_KEY); }

// ── Detalle diario por mes (control_config/dias_<YYYY-MM>) ─────────────────────
// Un doc por mes con { ym, origen, dias: { "DD": { fecha, ingresos[], compras[], cerrado? } } }.
// Doc separado para no inflar control_config/balance y respetar el límite de 1MB.
const diasKey = ym => `control_config:dias_${ym}`;

/** Carga el detalle diario de un mes (o null si no existe). */
export async function loadDiasMes(db, ym) {
  return getCached(diasKey(ym), () => leerConfigDoc(db, `dias_${ym}`, diasKey(ym), null),
    { ttl: 5 * 60 * 1000 });
}

/** Guarda (merge) el detalle diario de un mes. El merge recursivo no pisa otros días. */
export async function saveDiasMes(db, ym, partial) {
  await setDoc(
    doc(db, 'control_config', `dias_${ym}`),
    { ym, ...partial, updatedAt: serverTimestamp() },
    { merge: true }
  );
  invalidateCache(diasKey(ym));
}

/** Invalida el cache del detalle diario de un mes (tras restaurar por undo/redo). */
export function invalidateDiasMes(ym) { invalidateCache(diasKey(ym)); }

// ── Centro de Compras (control_config/compras) ────────────────────────────────
// Doc propio para no mezclar con settings ni balance. Guarda la política de
// presupuesto de inversión: rentabilidad a separar (monto fijo + piso %) y la
// cobertura objetivo para sugerir cantidades. { rentabilidad_monto,
// rentabilidad_piso_pct, cobertura_dias_objetivo, medio_default, proveedor_default,
// rubros_excluidos }.
const COMPRAS_KEY = 'control_config:compras';

/** Carga la config del Centro de Compras (o {} si no existe todavía). */
export async function loadComprasConfig(db) {
  return getCached(COMPRAS_KEY, () => leerConfigDoc(db, 'compras', COMPRAS_KEY, {}),
    { ttl: 15 * 60 * 1000 });
}

/** Guarda (merge) la config del Centro de Compras. */
export async function saveComprasConfig(db, partial) {
  await setDoc(
    doc(db, 'control_config', 'compras'),
    { ...partial, updatedAt: serverTimestamp() },
    { merge: true }
  );
  invalidateCache(COMPRAS_KEY);
}

/** Devuelve la fecha de inicio como string "YYYY-MM-DD" */
export async function getFechaInicio(db) {
  const cfg = await loadControlConfig(db);
  return cfg.fecha_inicio || DEFAULT_FECHA_INICIO;
}

/** Devuelve la fecha de inicio como Date (00:00 hora Argentina) */
export async function getFechaInicioDate(db) {
  const str = await getFechaInicio(db);
  return new Date(str + 'T00:00:00-03:00');
}

/** Convierte un timestamp Firestore / ISO / {seconds} a Date AR */
export function parseArDate(raw) {
  if (!raw) return new Date(NaN);
  if (typeof raw.toDate === 'function') return raw.toDate();
  if (typeof raw === 'object' && raw.seconds !== undefined)
    return new Date(raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6));
  return new Date(raw);
}

/**
 * Detecta si una venta (de la coleccion `ventas`) es una factura VARIOS 2 AFIP.
 * Esas no son ventas reales — no suman a caja ni a historial.
 * El flag is_varios_2 no siempre se sincroniza desde el POS, pero la string
 * `productos` arranca con "VARIOS 2 x..." si lo es (no se mezclan con items normales).
 */
export function isVentaVarios2(v) {
  if (!v) return false;
  if (v.is_varios_2 === true) return true;
  const prods = (v.productos || '').toUpperCase();
  return prods.startsWith('VARIOS 2 X') || prods === 'VARIOS 2';
}

/**
 * Detecta si un item (de `ventas_por_dia`) es VARIOS 2.
 * Ahi cada item tiene su nombre en `producto` y rubro en `categoria`.
 */
export function isItemVarios2(v) {
  if (!v) return false;
  if (v.is_varios_2 === true) return true;
  const nombre = (v.producto || v.product_name || '').toUpperCase().trim();
  if (nombre === 'VARIOS 2' || nombre.startsWith('VARIOS 2 ')) return true;
  const cat = (v.categoria || '').toUpperCase().trim();
  return cat === 'VARIOS 2';
}

/** "DD/MM/YYYY" → "YYYY-MM-DD" para comparar con fecha_inicio */
export function fechaDMYtoYMD(dmy) {
  if (!dmy || typeof dmy !== 'string') return '';
  const parts = dmy.split('/');
  if (parts.length !== 3) return dmy; // ya viene en ISO o formato raro
  const [d, m, y] = parts;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
