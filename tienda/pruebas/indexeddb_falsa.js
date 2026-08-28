/**
 * Una IndexedDB de mentira, en memoria.
 *
 * jsdom no trae IndexedDB, así que sin esto el snapshot local del panel —lo que
 * hace que el arranque sea instantáneo en vez de esperar 15 segundos— quedaba
 * sin probar. Implementa nada más lo que usa `snapshot_cache.js`: abrir, poner,
 * leer todo, borrar y vaciar.
 *
 * Las transacciones avisan `oncomplete` en un turno posterior, igual que la de
 * verdad: si contestara en el acto, el código que asigna `tx.oncomplete`
 * DESPUÉS de pedir los datos se quedaría esperando para siempre y la prueba
 * pasaría por motivos equivocados.
 */
export function instalarIndexedDB() {
  const bases = new Map();

  function pedido(fn) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try { req.result = fn(); req.onsuccess?.(); }
      catch (e) { req.error = e; req.onerror?.(); }
    });
    return req;
  }

  const idb = {
    /** Acceso directo al contenido, para que la prueba pueda mirar/sembrar. */
    _bases: bases,
    open(nombre) {
      const req = { result: null, error: null, onsuccess: null, onerror: null,
                    onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => {
        const nueva = !bases.has(nombre);
        if (nueva) bases.set(nombre, new Map());
        const almacenes = bases.get(nombre);
        const db = {
          objectStoreNames: { contains: (n) => almacenes.has(n) },
          createObjectStore: (n) => { almacenes.set(n, new Map()); return {}; },
          transaction(n) {
            const kv = almacenes.get(n);
            if (!kv) throw new Error(`no existe el almacén ${n}`);
            const tx = { oncomplete: null, onerror: null, error: null };
            const pendientes = [];
            tx.objectStore = () => ({
              put: (val, key) => pedido(() => { kv.set(String(key), val); }),
              get: (key) => pedido(() => kv.get(String(key))),
              getAll: () => { const r = pedido(() => [...kv.values()]); pendientes.push(r); return r; },
              getAllKeys: () => { const r = pedido(() => [...kv.keys()]); pendientes.push(r); return r; },
              delete: (key) => pedido(() => { kv.delete(String(key)); }),
              clear: () => pedido(() => { kv.clear(); }),
            });
            // Dos turnos: uno para que corran los pedidos, otro para el final.
            queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.())));
            return tx;
          },
        };
        req.result = db;
        if (nueva) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };

  globalThis.indexedDB = idb;
  return idb;
}
