/**
 * Lo que el navegador da por sentado y Node no tiene.
 *
 * El carrito lee localStorage en el momento de importarse, asi que esto tiene
 * que existir antes que cualquier import de la tienda.
 */

class Almacen {
  constructor() { this.datos = new Map(); }
  getItem(k) { return this.datos.has(k) ? this.datos.get(k) : null; }
  setItem(k, v) { this.datos.set(k, String(v)); }
  removeItem(k) { this.datos.delete(k); }
  clear() { this.datos.clear(); }
}

globalThis.localStorage = new Almacen();
