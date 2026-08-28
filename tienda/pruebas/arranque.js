/**
 * Lo que el navegador da por sentado y Node no tiene.
 *
 * El carrito lee localStorage en el momento de importarse, asi que esto tiene
 * que existir antes que cualquier import de la tienda o del panel.
 */

class Almacen {
  constructor() { this.datos = new Map(); }
  getItem(k) { return this.datos.has(k) ? this.datos.get(k) : null; }
  setItem(k, v) { this.datos.set(k, String(v)); }
  removeItem(k) { this.datos.delete(k); }
  clear() { this.datos.clear(); }
  key(i) { return [...this.datos.keys()][i] ?? null; }
  get length() { return this.datos.size; }
}

globalThis.localStorage = new Almacen();

// `window` a secas.
//
// Varios modulos del panel lo tocan al importarse (`cache.js` prende
// `window.__POS_TRACE__`, `store.js` cuelga ayudantes de diagnostico). No hace
// falta un DOM entero para eso: alcanza con que `window` sea el mismo objeto
// global, que es lo que es en el navegador. Lo que necesite pantalla de verdad
// —las 33 paginas— se prueba con jsdom, no con esto.
if (!globalThis.window) globalThis.window = globalThis;
