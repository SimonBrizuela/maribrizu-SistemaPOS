// @vitest-environment jsdom
/**
 * El store del panel: los listeners en vivo que alimentan todas las pantallas.
 *
 * Es lo que hace que navegar entre páginas sea instantáneo (los datos ya están
 * en memoria) y que lo que se vende en el POS aparezca solo, sin recargar. Cada
 * colección se pinea como key del cache: mientras esté pineada, `getCached`
 * nunca consulta, devuelve lo que trajo el listener.
 *
 * Lo que tiene que salir bien:
 *   · abrir un listener una sola vez por colección, aunque se pida mil veces;
 *   · que lo que llega del listener quede disponible para las pantallas;
 *   · y que al cerrar sesión se corten todos, sin dejar nada escuchando.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { estado } = vi.hoisted(() => ({
  estado: { suscripciones: [], emisores: {} },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  return {
    ...firestoreFalso(),
    collection: (_db, nombre) => ({ _col: nombre }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    onSnapshot: (q, cb) => {
      const nombre = q?._col || q?.col?._col || 'sin_nombre';
      estado.suscripciones.push(nombre);
      estado.emisores[nombre] = (docs) => cb({
        docs: docs.map((d, i) => ({ id: d.__id || `d${i}`, data: () => d })),
        docChanges: () => [],
        metadata: { fromCache: false },
      });
      return () => { delete estado.emisores[nombre]; };
    },
    getDocs: async () => ({ docs: [] }),
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {} }));
// El snapshot local vive en IndexedDB, que jsdom no tiene: se neutraliza para
// que lo que se prueba sean los listeners y no el almacenamiento del navegador.
vi.mock('../../webapp/src/snapshot_cache.js', () => ({
  loadSnapshots: async () => ({}), schedulePersist: () => {}, clearSnapshots: async () => {},
}));

const store = await import('../../webapp/src/store.js');
const cache = await import('../../webapp/src/cache.js');

beforeEach(() => {
  estado.suscripciones.length = 0;
  estado.emisores = {};
  cache.invalidateCacheByPrefix('');
});

afterEach(() => { store.teardownStore(); });

describe('abrir los listeners', () => {
  it('una colección pedida abre su listener', () => {
    store.prewarmStore({});
    store.ensureCollections(['catalogo']);
    expect(estado.suscripciones).toContain('catalogo');
  });

  it('pedirla de nuevo no abre otro', () => {
    // Cada pantalla declara lo que necesita y varias comparten colecciones: sin
    // esto se abrirían tantos listeners como navegaciones.
    store.prewarmStore({});
    store.ensureCollections(['catalogo']);
    store.ensureCollections(['catalogo']);
    store.ensureCollections(['catalogo', 'ventas']);
    expect(estado.suscripciones.filter(n => n === 'catalogo').length).toBe(1);
  });

  it('una colección que no existe en el store se ignora sin romper', () => {
    store.prewarmStore({});
    expect(() => store.ensureCollections(['inventada'])).not.toThrow();
  });

  it('sin nombres no hace nada', () => {
    store.prewarmStore({});
    store.ensureCollections([]);
    store.ensureCollections(null);
    expect(estado.suscripciones.length).toBe(0);
  });

  it('prewarmRest abre todas las que falten', () => {
    store.prewarmStore({});
    store.ensureCollections(['catalogo']);
    const antes = estado.suscripciones.length;
    store.prewarmRest();
    expect(estado.suscripciones.length).toBeGreaterThan(antes);
    expect(estado.suscripciones.filter(n => n === 'catalogo').length).toBe(1);
  });
});

describe('lo que llega del listener queda disponible', () => {
  it('la pantalla lo lee sin consultar nada', async () => {
    store.prewarmStore({});
    store.ensureCollections(['catalogo']);
    estado.emisores['catalogo']([
      { __id: 'p1', nombre: 'CUADERNO', precio_venta: 1000 },
    ]);

    // `catalogo:all` está pineada: getCached devuelve lo del listener y el
    // fetcher no se llama nunca.
    const consultar = vi.fn(async () => ['no deberia usarse']);
    const datos = await cache.getCached('catalogo:all', consultar);
    expect(consultar).not.toHaveBeenCalled();
    expect(datos.map(p => p.nombre)).toEqual(['CUADERNO']);
  });

  it('avisa a las pantallas cuando cambia', () => {
    const avisos = [];
    const soltar = store.onStoreChange(nombre => avisos.push(nombre));
    store.prewarmStore({});
    store.ensureCollections(['catalogo']);
    estado.emisores['catalogo']([{ __id: 'p1', nombre: 'CUADERNO' }]);
    soltar();
    expect(avisos).toContain('catalogo');
  });

  it('un suscriptor que revienta no corta a los demás', () => {
    const vistos = [];
    const soltar1 = store.onStoreChange(() => { throw new Error('roto'); });
    const soltar2 = store.onStoreChange(n => vistos.push(n));
    store.prewarmStore({});
    store.ensureCollections(['catalogo']);
    estado.emisores['catalogo']([{ __id: 'p1', nombre: 'X' }]);
    soltar1(); soltar2();
    expect(vistos).toContain('catalogo');
  });
});

describe('cerrar sesión', () => {
  it('corta todos los listeners', () => {
    store.prewarmStore({});
    store.ensureCollections(['catalogo', 'ventas']);
    expect(Object.keys(estado.emisores).length).toBeGreaterThan(0);

    store.teardownStore();
    expect(Object.keys(estado.emisores).length).toBe(0);
  });
});
