/**
 * Cache con dos capas:
 *   1. Memoria (rápido, se pierde al recargar)
 *   2. localStorage (persiste entre recargas, con TTL)
 *
 * Uso:
 *   getCached('key', fetcher)                         → TTL 5min, persiste en localStorage
 *   getCached('key', fetcher, { ttl: 60_000 })        → TTL custom
 *   getCached('key', fetcher, { memOnly: true })      → solo memoria (para datos muy grandes)
 *
 * Cada entrada guarda su propio TTL — peekCache lo usa para decidir si está fresco
 * sin tener que conocer el TTL "afuera". Antes había un bug: peekCache asumía el
 * default 5min y a veces decía "cached" cuando getCached iba a re-fetch igual,
 * dejando la pantalla congelada sin spinner durante el refetch.
 *
 * El botón Refresh invalida con invalidateCacheByPrefix(page).
 */

const LS_PREFIX = 'pos_c_';
const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutos

// Capa 1: memoria (se resetea al recargar, compartida dentro de la sesión)
const _mem = {};

// Fetches en vuelo, para deduplicar llamadas concurrentes a la misma key
const _inflight = {};

// Keys "pinned" — pobladas por store.js vía listeners realtime.
// Mientras esté pinned, getCached nunca llama al fetcher: devuelve _mem[key].data
// sincrónicamente (sin TTL). El store es responsable de mantenerlas frescas.
const _pinned = new Set();
// Esperas (resolve fn) por key cuando getCached encuentra pinned pero sin datos todavía.
const _waiters = {};
// Resolvers de fetchers inflight para keys pinned. setCacheValue los usa para
// abortar el fetcher cuando el listener llega tarde: el fetcher original sigue
// corriendo en background pero su resultado se descarta — el caller recibe
// inmediatamente el valor del store.
const _inflightResolvers = {};

// Keys hidratadas desde el snapshot local (snapshot_cache.js): datos de la
// última sesión, pintan al instante. El primer snapshot real del listener las
// pisa (setCacheValue) y store.js dispara el re-render de la página activa.
const _hydrated = new Set();

// Cuánto esperar al primer snapshot del store antes de caer al fetcher.
// Persistent IndexedDB → snapshot inicial suele llegar en <300 ms en datasets
// chicos. En datasets grandes (catalogo ~12k docs) se midió hasta 32s en
// condiciones patológicas (IndexedDB warm-up post-F5). Damos 45 s como techo
// para no caer al fetcher inútilmente: el listener llega, el fetcher arranca
// un getDocs paralelo que también está congestionado, y el await del page
// queda colgado eternamente (página en blanco).
const STORE_WAIT_MS = 45000;

/**
 * Marca una key como mantenida por store global. getCached siempre devolverá
 * lo que haya en _mem[key], sin TTL. Si todavía no hay datos, espera (resuelve
 * cuando llegue el primer snapshot).
 */
export function pinCacheKey(key) { _pinned.add(key); }

/**
 * Despinea una key (la vuelve normal, con TTL).
 */
export function unpinCacheKey(key) { _pinned.delete(key); }

/**
 * Setter directo para entradas pinned, usado por store.js cuando llega un snapshot.
 * Hace flush de:
 *   - waiters (callers esperando primer snapshot del store)
 *   - inflight resolvers (callers que ya cayeron al fetcher porque el waiter
 *     timeoutó — si el listener llega después, los desbloqueamos con su valor
 *     en vez de dejarlos colgados esperando un getDocs server-side congestionado)
 */
export function setCacheValue(key, data) {
  _mem[key] = { data, ts: Date.now(), ttl: Infinity };
  _hydrated.delete(key);   // llegó el dato real: la key deja de ser "de la sesión anterior"
  if (_waiters[key]) {
    const list = _waiters[key];
    delete _waiters[key];
    list.forEach(resolve => { try { resolve(data); } catch (_) {} });
  }
  if (_inflightResolvers[key]) {
    const list = _inflightResolvers[key];
    delete _inflightResolvers[key];
    delete _inflight[key];
    list.forEach(resolve => { try { resolve(data); } catch (_) {} });
  }
}

/**
 * Lee sincrónicamente lo que haya en memoria para una key (o undefined).
 * No mira TTL — pensado para páginas que quieran pintar al toque desde el store.
 */
export function peekCacheValue(key) {
  return _mem[key]?.data;
}

/**
 * Inyecta el snapshot de la sesión anterior en una key pinned que todavía no
 * tiene datos (hidratación de arranque). Devuelve true si hidrató. NO toca los
 * fetchers inflight: si por algún timeout ya hay un getDocs corriendo, ese
 * flujo se resuelve solo con datos frescos.
 */
export function hydrateCacheValue(key, data) {
  if (!_pinned.has(key)) return false;   // key que ya no existe en el store — ignorar
  if (_mem[key]) return false;           // el listener llegó primero — no pisar
  _mem[key] = { data, ts: Date.now(), ttl: Infinity };
  _hydrated.add(key);
  if (_waiters[key]) {
    const list = _waiters[key];
    delete _waiters[key];
    list.forEach(resolve => { try { resolve(data); } catch (_) {} });
  }
  return true;
}

/** ¿La key sigue mostrando datos hidratados (aún sin snapshot real del listener)? */
export function isHydrated(key) { return _hydrated.has(key); }

/**
 * Actualiza una key que sigue en estado hidratado (delta de arranque: docs
 * frescos del server mergeados sobre el snapshot local). No-op si el listener
 * real ya la pisó — el listener siempre gana. Devuelve true si actualizó.
 */
export function updateHydratedValue(key, data) {
  if (!_hydrated.has(key)) return false;
  _mem[key] = { data, ts: Date.now(), ttl: Infinity };
  return true;
}

/**
 * Devuelve datos del cache si son frescos, o los fetchea y los guarda.
 * @param {string} key
 * @param {() => Promise<any>} fetcher
 * @param {{ ttl?: number, memOnly?: boolean }} options
 */
// Log timing global para detectar cuellos de botella.
// Cada llamada a getCached deja rastro: pinned, mem, localStorage o fetcher.
function _log(...args) { if (window.__POS_DEBUG__ || window.__POS_TRACE__) console.log(...args); }
// Por default los logs de cache/store SIEMPRE están activos (no requieren ?debug=1):
// son baratos y críticos para diagnosticar.
window.__POS_TRACE__ = true;

export async function getCached(key, fetcher, { ttl = DEFAULT_TTL, memOnly = false } = {}) {
  // 0. Key pinned por store global. Con persistent IndexedDB cache, el primer
  // snapshot llega muy rápido (cache local del SDK). Esperarlo evita disparar
  // un getDocs() paralelo contra el server que duplicaría tráfico y daría
  // datos potencialmente desincronizados con el store.
  //
  // Si ya hay datos en _mem → devolver al toque.
  // Si no → esperar al snapshot vía waiter, con timeout. Si vence el timeout
  // (caso anómalo: cache corrupto, IndexedDB bloqueada), caer al flujo normal.
  if (_pinned.has(key)) {
    if (_mem[key]) {
      return _mem[key].data;
    }
    console.log(`[cache] ${key} → esperando snapshot del store (timeout ${STORE_WAIT_MS}ms)`);
    const _t0 = performance.now();
    const fromStore = await new Promise((resolve) => {
      (_waiters[key] = _waiters[key] || []).push(resolve);
      setTimeout(() => resolve(undefined), STORE_WAIT_MS);
    });
    if (fromStore !== undefined) {
      console.log(`[cache] ${key} ✓ resuelto via waiter en ${(performance.now() - _t0).toFixed(0)}ms`);
      return fromStore;
    }
    console.warn(`[cache] ${key} ✗ TIMEOUT ${STORE_WAIT_MS}ms — cayendo a fetcher`);
    // timeout: seguir al flujo normal (localStorage / fetcher).
  }

  // 1. Memoria
  const mem = _mem[key];
  if (mem && Date.now() - mem.ts < (mem.ttl || ttl)) {
    return mem.data;
  }

  // 2. localStorage (solo si no es memOnly)
  if (!memOnly) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      if (raw) {
        const entry = JSON.parse(raw);
        if (Date.now() - entry.ts < (entry.ttl || ttl)) {
          _mem[key] = entry; // calentar memoria también
          return entry.data;
        }
      }
    } catch (_) {}
  }

  // 3. Fetch desde Firebase — deduplicar concurrentes
  if (_inflight[key]) {
    console.log(`[cache] ${key} → deduplicado, esperando inflight`);
    return _inflight[key];
  }

  console.log(`[cache] ${key} → fetcher arrancando (Firestore directo)`);
  const _tFetch = performance.now();
  // Promise wrap explícito: para keys pinned, registramos el `resolve` en
  // _inflightResolvers. Si el listener del store llega antes que el fetcher
  // (típico cuando el waiter timeoutó por SDK congestionado), setCacheValue
  // resuelve esta Promise con los datos del listener — el fetcher sigue
  // corriendo en background, pero el caller ya no espera.
  _inflight[key] = new Promise((resolve, reject) => {
    if (_pinned.has(key)) {
      (_inflightResolvers[key] = _inflightResolvers[key] || []).push(resolve);
    }
    (async () => {
      try {
        const data = await fetcher();
        // Si setCacheValue ya resolvió esto vía listener, _inflight ya no
        // referencia a esta Promise — descartamos el resultado para no pisar
        // los datos del store (más frescos).
        if (!_inflightResolvers[key] && _pinned.has(key) && _mem[key]) {
          console.log(`[cache] ${key} ✓ fetcher OK pero store ya pobló _mem — descarto`);
          resolve(_mem[key].data);
          return;
        }
        const entry = { data, ts: Date.now(), ttl };
        _mem[key] = entry;
        if (!memOnly) {
          try {
            localStorage.setItem(LS_PREFIX + key, JSON.stringify(entry));
          } catch (_) {
            // Quota exceeded u otro error → silenciar, la memoria ya tiene los datos
          }
        }
        console.log(`[cache] ${key} ✓ fetcher OK en ${(performance.now() - _tFetch).toFixed(0)}ms`);
        delete _inflight[key];
        delete _inflightResolvers[key];
        resolve(data);
      } catch (err) {
        console.error(`[cache] ${key} ✗ fetcher ERROR en ${(performance.now() - _tFetch).toFixed(0)}ms:`, err);
        delete _inflight[key];
        delete _inflightResolvers[key];
        reject(err);
      }
    })();
  });

  return _inflight[key];
}

/**
 * Comprueba sincrónicamente si hay datos válidos en cache (sin fetchear).
 * Usa el TTL guardado con la entrada (si existe), si no usa el TTL pasado.
 * @param {string} key
 * @param {number} [fallbackTtl]
 * @returns {boolean}
 */
export function peekCache(key, fallbackTtl = DEFAULT_TTL) {
  // Key pinned por store con datos en memoria → siempre considerada fresh
  if (_pinned.has(key) && _mem[key]) return true;
  const mem = _mem[key];
  if (mem && Date.now() - mem.ts < (mem.ttl || fallbackTtl)) return true;
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw) {
      const entry = JSON.parse(raw);
      return Date.now() - entry.ts < (entry.ttl || fallbackTtl);
    }
  } catch (_) {}
  return false;
}

/**
 * Invalida una clave específica (memoria + localStorage).
 *
 * IMPORTANTE: una key pinned (mantenida por el store global vía listener
 * realtime) NO se borra de memoria. El listener es dueño de esos datos —
 * si los borrásemos, el próximo getCached caería al waiter esperando un
 * snapshot que puede no llegar (la colección no cambió). En catalogo.js
 * varias acciones de edit llamaban invalidateCache('catalogo:all') después
 * de un setDoc → la tabla quedaba en blanco hasta que llegaba un snapshot.
 *
 * El localStorage sí se limpia: para keys pinned no se usa (el flujo pinned
 * solo lee _mem), así borrar es no-op pero higieniza restos de builds viejos.
 *
 * @param {string} [key] — si se omite, limpia todo el cache (incluso pinned).
 */
export function invalidateCache(key) {
  if (key) {
    if (!_pinned.has(key)) delete _mem[key];
    try { localStorage.removeItem(LS_PREFIX + key); } catch (_) {}
  } else {
    Object.keys(_mem).forEach(k => delete _mem[k]);
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith(LS_PREFIX))
        .forEach(k => localStorage.removeItem(k));
    } catch (_) {}
  }
}

/**
 * Invalida todas las claves que empiezan con el prefijo dado.
 *
 * IMPORTANTE: las keys pinned (mantenidas por el store global vía listener
 * realtime) NO se borran de memoria. El listener es dueño de esos datos —
 * si los borrásemos, getCached caería al waiter esperando un snapshot que
 * podría no llegar (la colección no cambió). El botón Refresh dejaba la
 * página colgada 15s + fetcher por este motivo.
 *
 * El localStorage sí se limpia siempre: para keys pinned no se usa (el flujo
 * pinned solo lee _mem), así borrar es no-op pero ayuda a higienizar restos
 * de builds viejos.
 *
 * @param {string} prefix
 */
export function invalidateCacheByPrefix(prefix) {
  Object.keys(_mem)
    .filter(k => k.startsWith(prefix) && !_pinned.has(k))
    .forEach(k => delete _mem[k]);
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith(LS_PREFIX + prefix))
      .forEach(k => localStorage.removeItem(k));
  } catch (_) {}
}
