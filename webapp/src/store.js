/**
 * Store global de colecciones realtime.
 *
 * Flujo:
 *   1. Login → prewarmStore(db): solo PIN de los keys, sin abrir listeners.
 *   2. navigate(page) → ensureCollections(pages[page].needs): arranca los
 *      listeners necesarios para esa página (idempotente).
 *   3. Después del primer paint → prewarmRest(): arranca todos los listeners
 *      restantes en background, para que cambiar de página después sea instantáneo.
 *
 * Por qué este patrón: con persistent IndexedDB cache, el primer snapshot de cada
 * colección viene de cache local, pero la deserialización de docs es CPU-bound
 * en el main thread. Arrancar las 6 colecciones a la vez en F5 mete ~25k docs
 * en cola y bloquea 5-9 segundos. Arrancar solo lo que la página necesita evita
 * esa cola.
 *
 * Cada snapshot popula directamente los cache keys que las páginas consultan via
 * getCached() — esos keys quedan "pinned": getCached los devuelve sincrónicamente
 * sin TTL ni fetcher.
 *
 * Las páginas activas también reciben una notificación de cambio (onStoreChange)
 * para auto-rerender cuando llegan cambios desde el server.
 */
import { onSnapshot, collection, query, orderBy, limit, where, getDocs } from 'firebase/firestore';
import { pinCacheKey, setCacheValue, invalidateCache, isHydrated, hydrateCacheValue, updateHydratedValue } from './cache.js';
import { loadSnapshots, schedulePersist } from './snapshot_cache.js';
import { getFechaInicioDate } from './config.js';

// Listeners activos (uno por colección). Idempotencia: si ya está arrancado,
// ensureCollections no duplica.
const _unsubs = new Map();
// Reintentos por colección de un listener que falló, y una época que sube en
// cada teardown para que un reintento programado no reviva listeners viejos.
const _reintentos = new Map();
let _epoca = 0;

// db handle guardado en prewarmStore. ensureCollections / prewarmRest lo usan.
let _db = null;

// Subscribers para enterarse cuando cambia el store (página activa re-renderea).
const _changeListeners = new Set();

/**
 * @param {(collectionName: string) => void} cb
 * @returns {() => void} unsubscribe
 */
export function onStoreChange(cb) {
  _changeListeners.add(cb);
  return () => _changeListeners.delete(cb);
}

function _notify(colName) {
  _changeListeners.forEach(cb => { try { cb(colName); } catch (err) { console.error('[store] listener error', err); } });
}

/**
 * Define qué colecciones se mantienen vivas y a qué cache keys mapean cada una.
 *
 * - `query`: builder opcional (default: oír toda la colección sin orden)
 * - `dateBounded`: nombre de un campo Timestamp. Si está, el listener se acota a
 *   `where(campo >= fecha_inicio) orderBy(campo desc)` en vez de un limit fijo.
 *   Esto evita el bug de "no aparece el mes nuevo": un `limit(N)` por cantidad de
 *   docs termina recortando datos a medida que la colección crece, y si encima se
 *   ordena por un campo string "DD/MM/YYYY" el recorte cae sobre los días 01-09
 *   (arranque de cada mes). Acotando por la fecha de inicio del negocio, el store
 *   trae siempre exactamente la ventana que la app muestra: ningún mes se trunca,
 *   ni nuevo ni viejo, sin importar cuánto crezca el histórico.
 * - `populates`: array de { key, transform(docs) } — `docs` es [{id, ...data}, ...]
 * - `invalidates`: cache keys NO populados pero que dependen de esta colección
 *   (al recibir cambios se invalidan para que el próximo getCached refetchee)
 */
const SPECS = [
  {
    name: 'ventas',
    dateBounded: 'created_at',
    populates: [
      { key: 'dashboard:ventas', transform: docs => docs },
      { key: 'ventas:lista',     transform: docs => docs.slice(0, 500) },
    ],
    invalidates: [],
  },
  {
    name: 'ventas_por_dia',
    // Acotado por `fecha_dt` (Timestamp, 100% de cobertura). Antes era
    // orderBy('fecha', 'desc') + limit(8000): `fecha` es string "DD/MM/YYYY", el
    // sort alfabético mandaba los días 01-09 al fondo y el limit los recortaba →
    // el mes nuevo no aparecía. Ver nota de `dateBounded` arriba.
    dateBounded: 'fecha_dt',
    populates: [
      // historial.js + resumenes.js + cierres.js usan esta forma:
      { key: 'historial:ventas_dia:v3', transform: docs => docs.map(d => {
          const parts = (d.id || '').split('_');
          const pcId = parts.length >= 3 ? parts.slice(0, -2).join('_') : '';
          return { ...d, _pc_id: pcId };
      })},
      // dashboard.js: shape compacto sólo con los campos que usa
      { key: 'dashboard:items_full', transform: docs => docs.map(it => ({
          fecha:        it.fecha,
          producto:     it.producto || it.product_name || '',
          categoria:    it.categoria,
          subtotal:     Number(it.subtotal || 0),
          cantidad:     Number(it.cantidad || it.quantity || 0),
          deleted:      it.deleted === true,
          is_varios_2:  it.is_varios_2 === true,
          venta_id:     it.venta_id,
          payment_type: it.payment_type,
      }))},
      // productos.js: docs raw
      { key: 'productos:items_rich', transform: docs => docs.slice(0, 5000).map(d => {
          const { id, ...data } = d;
          return data;
      })},
      // ventas.js: agrupado por key (pc_id+num_venta) y por num_venta
      { key: 'ventas:items', transform: docs => {
          const byKey = {};
          const byNum = {};
          docs.slice(0, 3000).forEach(d => {
            if (d.deleted === true) return;
            const parts = (d.id || '').split('_');
            const pcId  = parts.length >= 3 ? parts.slice(0, -2).join('_') : '';
            const numV  = String(d.num_venta);
            const key   = pcId ? `${pcId}_${numV}` : numV;
            const nombre = d.producto || d.product_name || '';
            const cant   = d.cantidad || d.quantity || 1;
            if (!nombre) return;
            const txt = `${nombre}${cant > 1 ? ` x${cant}` : ''}`;
            (byKey[key] = byKey[key] || []).push(txt);
            (byNum[numV] = byNum[numV] || []).push({ pcId, txt });
          });
          return { byKey, byNum };
      }},
    ],
    // control_total.js usa ct:items_rich que es similar pero con otra transformación
    // y filtros distintos → más fácil invalidar y dejar que se re-fetchee.
    invalidates: ['ct:items_rich'],
  },
  {
    name: 'catalogo',
    populates: [
      // doc_id ya viene seteado al firestore document ID por _startListener
      // (no sobrescribible por el campo `id` numérico interno del doc).
      // Mantenemos también `id` (numérico interno del POS) si el doc lo trae.
      { key: 'catalogo:all', transform: docs => docs },
    ],
    invalidates: ['inv:productos', 'promos:catalogo_min_v3', 'artUnicos:catalogo', 'mp:productos'],
  },
  {
    name: 'historial_diario',
    // Mismo motivo que ventas_por_dia (antes: orderBy('fecha') string + limit(30)).
    dateBounded: 'fecha_dt',
    populates: [
      { key: 'dashboard:historial', transform: docs => docs.map(d => { const { id, ...data } = d; return data; }) },
    ],
    invalidates: [],
  },
  {
    name: 'cierres_caja',
    q: col => query(col, orderBy('fecha_apertura', 'desc'), limit(500)),
    populates: [
      { key: 'cierres:caja', transform: docs => docs },
    ],
    invalidates: [],
  },
  {
    // caja_activa/current es la fuente de verdad de "¿hay caja abierta?". Antes
    // cierres.js la leía con un getDoc one-shot (cache-first del SDK persistente)
    // → mostraba "no hay caja abierta" stale hasta que el usuario recargaba. Como
    // listener realtime, la tarjeta "Caja Abierta" se actualiza en vivo y el primer
    // paint recibe el snapshot del server. Es 1 solo doc → oír toda la colección
    // es trivial; seleccionamos el doc 'current' por su firestore id (doc_id),
    // no por `id` (que el mapeo del store pisa con el id interno del POS).
    name: 'caja_activa',
    populates: [
      { key: 'caja_activa:current', transform: docs => docs.find(d => d.doc_id === 'current') || null },
    ],
    invalidates: [],
  },
  {
    // inventario_resumen/current: agregado de velocidad de venta por producto
    // (u7/u30/u90) + serie por día, mantenido por la webapp. Es 1 solo doc →
    // oír toda la colección es trivial; seleccionamos 'current' por su doc_id
    // (no por `id`, que el mapeo del store pisa con el id interno). Pinneado
    // como 'inv:resumen' → la pestaña Inventario lo lee sincrónico en vez de
    // reescanear ventas_por_dia en cada apertura.
    name: 'inventario_resumen',
    populates: [
      // `por_producto` / `por_dia` se guardan serializados como string: como
      // mapas, sus ~5000 claves superaban el tope de 40.000 entradas de índice
      // por documento de Firestore y el resumen dejaba de poder escribirse
      // (ver aPayloadFirestore en inventario_resumen.js). Acá se deserializan
      // para que las páginas los sigan leyendo como objetos.
      { key: 'inv:resumen', transform: docs => {
          const d = docs.find(x => x.doc_id === 'current');
          if (!d) return null;
          const parse = (s, vacio) => {
            if (!s) return vacio;
            try { return JSON.parse(s); } catch (_) { return vacio; }
          };
          return {
            ...d,
            por_producto: d.por_producto || parse(d.por_producto_json, {}),
            por_dia:      d.por_dia      || parse(d.por_dia_json, {}),
          };
      }},
    ],
    invalidates: [],
  },
  {
    // Fiado: cuenta corriente de clientes. Tres colecciones chicas que el POS
    // y la webapp comparten. Como listeners realtime, cargar un producto acá
    // aparece en el POS al instante (y al revés, cuando el cajero fía).
    name: 'fiado_clientes',
    populates: [
      { key: 'fiado:clientes', transform: docs => docs.filter(d => d.deleted !== true) },
    ],
    invalidates: [],
  },
  {
    name: 'fiado_items',
    populates: [
      { key: 'fiado:items', transform: docs => docs.filter(d => d.deleted !== true) },
    ],
    invalidates: [],
  },
  {
    name: 'fiado_pagos',
    populates: [
      { key: 'fiado:pagos', transform: docs => docs.filter(d => d.deleted !== true) },
    ],
    invalidates: [],
  },
  {
    name: 'gastos',
    q: col => query(col, orderBy('created_at', 'desc'), limit(1000)),
    populates: [
      { key: 'gastos:all', transform: docs => docs.map(d => { const { id, ...data } = d; return data; }) },
    ],
    // ct:gastos:<rango> es per-rango → invalidamos todos los que arranquen así
    invalidates: [],
    invalidatePrefixes: ['ct:gastos:'],
  },
];

// Mapa nombre → spec para lookup O(1) en ensureCollections.
const _specByName = new Map(SPECS.map(s => [s.name, s]));

/**
 * Arranca el listener de una spec si todavía no está activo.
 * @param {object} spec
 */
async function _startListener(spec) {
  if (_unsubs.has(spec.name)) {
    console.log(`[store] ${spec.name} ya tiene listener — skip`);
    return;
  }
  if (!_db) {
    console.warn('[store] _startListener antes de prewarmStore', spec.name);
    return;
  }

  // Placeholder síncrono: marca la spec como "arrancando" para que llamadas
  // concurrentes (ensureCollections + prewarmRest) no dupliquen el listener
  // mientras resolvemos la fecha de inicio (await).
  _unsubs.set(spec.name, () => {});

  const colRef = collection(_db, spec.name);
  let q;
  if (spec.dateBounded) {
    // Acotar por fecha_inicio en vez de por limit fijo. getFechaInicioDate usa
    // getCached sobre control_config (precargado en login) → resuelve rápido.
    try {
      const desde = await getFechaInicioDate(_db);
      q = query(colRef, where(spec.dateBounded, '>=', desde), orderBy(spec.dateBounded, 'desc'));
    } catch (err) {
      // Fallback defensivo: si no se pudo leer fecha_inicio, oír toda la
      // colección ordenada por el mismo campo (sin limit → no se trunca nada).
      console.warn(`[store] ${spec.name}: fecha_inicio no disponible, fallback sin acotar`, err);
      q = query(colRef, orderBy(spec.dateBounded, 'desc'));
    }
  } else {
    q = spec.q ? spec.q(colRef) : colRef;
  }

  // Si se hizo teardown durante el await, abortar sin abrir el listener.
  if (!_unsubs.has(spec.name)) {
    console.log(`[store] ${spec.name} torn down durante arranque — abort`);
    return;
  }

  const _t0 = performance.now();
  let _firstSnap = true;
  console.log(`[store] arrancando listener: ${spec.name}`);
  const unsub = onSnapshot(
    q,
    (snap) => {
      const esPrimero = _firstSnap;
      if (_firstSnap) {
        console.log(`[store] PRIMER SNAPSHOT ${spec.name} en ${(performance.now() - _t0).toFixed(0)}ms (fromCache=${snap.metadata.fromCache}, docs=${snap.docs.length})`);
        _firstSnap = false;
      }
      // ¿La página pintó con datos hidratados de la sesión anterior? Chequear
      // ANTES de setCacheValue (que limpia el flag): si sí, el primer snapshot
      // real —aunque venga fromCache— es más fresco y merece re-render.
      const veniaHidratado = esPrimero && (spec.populates || []).some(p => isHydrated(p.key));
      // Aceptamos tanto fromCache como server: el primer pintado sale del
      // cache local del SDK; el segundo snapshot (server) trae confirmación
      // y dispara rerender via _notify.
      // doc_id: SIEMPRE el firestore document ID (no sobrescribible).
      // id: comportamiento histórico — si el doc tiene un campo `id` interno
      // (ej: catálogo guarda un id numérico del POS), prevalece ese; si no,
      // queda el firestore id. Los transforms que necesiten el firestore id
      // real (ej: catalogo) DEBEN usar `doc_id`, no `id`.
      // serverTimestamps: 'estimate' → para un doc con escritura pendiente (lo
      // acabamos de escribir y el server no confirmó), los campos serverTimestamp
      // devuelven una estimación local en vez de null. Sin esto, el snapshot
      // optimista entrega null y, p.ej., el chip de "última modificación" del
      // catálogo parpadeaba a la fecha de creación hasta que el server confirmaba.
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }), doc_id: d.id }));
      if (esPrimero) _hydratedRaw.delete(spec.name);   // el SDK ya es la fuente — liberar el snapshot en memoria
      _applyTransforms(spec, docs, setCacheValue);
      // Snapshot local (docs crudos, una entrada por colección) para la
      // hidratación instantánea del próximo arranque.
      schedulePersist('col:' + spec.name, docs);
      (spec.invalidates || []).forEach(k => invalidateCache(k));
      (spec.invalidatePrefixes || []).forEach(prefix => {
        try {
          Object.keys(localStorage)
            .filter(k => k.startsWith('pos_c_' + prefix))
            .forEach(k => localStorage.removeItem(k));
        } catch (_) {}
      });
      // Notificar re-render cuando el snapshot viene del server. Los fromCache
      // son el primer pintado y la página ya se renderiza con ellos — EXCEPTO
      // si la página pintó antes con datos hidratados de la sesión anterior:
      // ahí el primer snapshot (fromCache o no) es más fresco → re-render.
      if (!snap.metadata.fromCache) _reintentos.delete(spec.name);
      if (!snap.metadata.fromCache || veniaHidratado) _notify(spec.name);
    },
    (err) => {
      // Un listener que falla no vuelve a avisar nunca: la pestaña seguía
      // mostrando el catálogo de cuando se abrió, sin saberlo. Se vuelve a
      // enganchar con espera creciente (5 s, 10 s, 20 s… tope 2 min) mientras
      // el store siga vivo (teardownStore lo apaga).
      console.warn('[store] listener error en', spec.name, err);
      if (_unsubs.get(spec.name) !== unsub) return;
      _unsubs.delete(spec.name);
      const epoca = _epoca;
      const intento = (_reintentos.get(spec.name) || 0) + 1;
      _reintentos.set(spec.name, intento);
      const espera = Math.min(5000 * 2 ** (intento - 1), 120000);
      console.warn(`[store] ${spec.name}: reintento ${intento} en ${Math.round(espera / 1000)} s`);
      setTimeout(() => {
        if (epoca === _epoca && _db && !_unsubs.has(spec.name)) _startListener(spec).catch(() => {});
      }, espera);
    }
  );
  _unsubs.set(spec.name, unsub);
}

// ── Hidratación instantánea + delta de arranque ───────────────────────────────
// Docs crudos hidratados por colección: base para mergear el delta. Se libera
// apenas el listener real entrega su primer snapshot.
const _hydratedRaw = new Map();

// Aplica todos los transforms de una spec sobre los docs, entregando cada
// resultado via `apply` (setCacheValue / hydrateCacheValue / updateHydratedValue).
function _applyTransforms(spec, docs, apply) {
  (spec.populates || []).forEach(p => {
    try {
      apply(p.key, p.transform(docs));
    } catch (err) {
      console.error('[store] transform error en', p.key, err);
    }
  });
}

/**
 * Hidratación de arranque. 1) Carga el snapshot local (docs de la última
 * sesión) y puebla las cache keys al instante (~100-300ms) — las páginas
 * pintan sin esperar al SDK. 2) Para las colecciones acotadas por fecha,
 * trae del server SOLO lo que cambió desde el snapshot (query chica, ~1s)
 * y lo mergea → datos al día casi al toque. El listener completo del SDK
 * sigue su curso en background y pisa todo cuando llega (fuente de verdad).
 *
 * Llamar después de prewarmStore(db) (necesita las keys pinneadas).
 */
export async function hydrateStore(db) {
  let entries;
  try {
    entries = await loadSnapshots();
  } catch (err) {
    console.warn('[snap] hydrate falló (la app sigue sin snapshot):', err);
    return;
  }
  const t0 = performance.now();
  let n = 0;
  for (const spec of SPECS) {
    const e = entries.get('col:' + spec.name);
    if (!e || !Array.isArray(e.data)) continue;
    _hydratedRaw.set(spec.name, e);
    _applyTransforms(spec, e.data, hydrateCacheValue);
    n++;
  }
  console.log(`[snap] hidratadas ${n} colecciones en ${(performance.now() - t0).toFixed(0)}ms`);
  if (n) _deltaSync(db);
}

// Margen hacia atrás del delta: además de lo NUEVO desde el snapshot, re-trae
// los últimos días para captar ediciones/borrados lógicos sobre docs recientes
// (ej: venta eliminada, día corregido). Docs más viejos quedan como en el
// snapshot hasta que el listener completo los reconcilie.
const DELTA_MARGIN_MS = 3 * 24 * 60 * 60 * 1000;

function _deltaSync(db) {
  for (const spec of SPECS) {
    if (!spec.dateBounded) continue;
    const base = _hydratedRaw.get(spec.name);
    if (!base) continue;
    const cutoff = new Date(base.ts - DELTA_MARGIN_MS);
    const t0 = performance.now();
    getDocs(query(collection(db, spec.name), where(spec.dateBounded, '>=', cutoff)))
      .then(snap => {
        const cur = _hydratedRaw.get(spec.name);
        if (!cur) return;   // el listener ya entregó su snapshot — el delta sobra
        const byId = new Map(cur.data.map(d => [d.doc_id || d.id, d]));
        snap.docs.forEach(d => byId.set(d.id, { id: d.id, ...d.data(), doc_id: d.id }));
        const f = spec.dateBounded;
        const ms = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : (v instanceof Date ? v.getTime() : 0);
        const merged = [...byId.values()].sort((a, b) => ms(b[f]) - ms(a[f]));
        cur.data = merged;
        let updated = false;
        _applyTransforms(spec, merged, (key, val) => { if (updateHydratedValue(key, val)) updated = true; });
        console.log(`[snap] delta ${spec.name}: ${snap.docs.length} docs frescos en ${(performance.now() - t0).toFixed(0)}ms`);
        if (updated) _notify(spec.name);
      })
      .catch(err => console.warn('[snap] delta', spec.name, err));
  }
}

/**
 * Pin de todos los keys conocidos. No abre listeners — eso lo hacen
 * ensureCollections() y prewarmRest().
 *
 * Pinear primero garantiza que getCached() de cualquier página espere via
 * waiter al primer snapshot en vez de irse al fetcher con getDocs().
 *
 * @param {import('firebase/firestore').Firestore} db
 */
export function prewarmStore(db) {
  _db = db;
  for (const spec of SPECS) {
    (spec.populates || []).forEach(p => pinCacheKey(p.key));
  }
}

/**
 * Garantiza que estas colecciones tengan listener activo. Idempotente.
 * Llamar desde navigate() con los `needs` de la página antes del renderFn.
 *
 * @param {string[]} names
 */
export function ensureCollections(names) {
  if (!names || !names.length) return;
  console.log(`[store] ensureCollections: ${names.join(', ')}`);
  for (const name of names) {
    const spec = _specByName.get(name);
    if (spec) _startListener(spec).catch(err => console.error('[store] _startListener', name, err));
  }
}

/**
 * Arranca todas las colecciones del store que aún no tengan listener.
 * Llamar después del primer paint para tener todo caliente en background.
 */
export function prewarmRest() {
  console.log('[store] prewarmRest (arrancando colecciones restantes)');
  for (const spec of SPECS) _startListener(spec).catch(err => console.error('[store] _startListener', spec.name, err));
}

/**
 * Detiene todos los listeners. Para logout.
 */
export function teardownStore() {
  _epoca += 1;
  _reintentos.clear();
  _unsubs.forEach(u => { try { u(); } catch (_) {} });
  _unsubs.clear();
}
