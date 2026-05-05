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

/**
 * Devuelve datos del cache si son frescos, o los fetchea y los guarda.
 * @param {string} key
 * @param {() => Promise<any>} fetcher
 * @param {{ ttl?: number, memOnly?: boolean }} options
 */
export async function getCached(key, fetcher, { ttl = DEFAULT_TTL, memOnly = false } = {}) {
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
  if (_inflight[key]) return _inflight[key];

  _inflight[key] = (async () => {
    try {
      const data = await fetcher();
      const entry = { data, ts: Date.now(), ttl };
      _mem[key] = entry;
      if (!memOnly) {
        try {
          localStorage.setItem(LS_PREFIX + key, JSON.stringify(entry));
        } catch (_) {
          // Quota exceeded u otro error → silenciar, la memoria ya tiene los datos
        }
      }
      return data;
    } finally {
      delete _inflight[key];
    }
  })();

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
 * @param {string} [key] — si se omite, limpia todo el cache
 */
export function invalidateCache(key) {
  if (key) {
    delete _mem[key];
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
 * @param {string} prefix
 */
export function invalidateCacheByPrefix(prefix) {
  Object.keys(_mem).filter(k => k.startsWith(prefix)).forEach(k => delete _mem[k]);
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith(LS_PREFIX + prefix))
      .forEach(k => localStorage.removeItem(k));
  } catch (_) {}
}
