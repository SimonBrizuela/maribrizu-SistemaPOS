/**
 * Cache en memoria por sesión para datos de Firebase.
 * Las páginas usan getCached() para evitar lecturas repetidas.
 * El botón Refresh de main.js llama a invalidate(page) para forzar recarga.
 */

const _cache = {};

/**
 * Obtiene datos cacheados o ejecuta el fetcher y los guarda.
 * @param {string} key - Clave única (ej: 'ventas', 'catalogo')
 * @param {Function} fetcher - async function que retorna los datos
 * @returns {Promise<any>}
 */
export async function getCached(key, fetcher) {
  if (_cache[key] !== undefined) {
    return _cache[key];
  }
  const data = await fetcher();
  _cache[key] = data;
  return data;
}

/**
 * Invalida una clave del cache (o todo el cache si no se pasa key).
 * @param {string} [key]
 */
export function invalidateCache(key) {
  if (key) {
    delete _cache[key];
  } else {
    Object.keys(_cache).forEach(k => delete _cache[k]);
  }
}

/**
 * Invalida todas las claves que empiecen con el prefijo dado.
 * Útil para invalidar una página que usa múltiples colecciones.
 * @param {string} prefix
 */
export function invalidateCacheByPrefix(prefix) {
  Object.keys(_cache).filter(k => k.startsWith(prefix)).forEach(k => delete _cache[k]);
}
