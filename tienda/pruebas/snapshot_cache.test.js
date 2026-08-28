// @vitest-environment jsdom
/**
 * El snapshot local del panel: lo que hace que abra al instante.
 *
 * Sin esto, cada arranque espera a que Firestore le entregue el primer snapshot
 * de cada colección grande — medido en la máquina del local: catálogo ~6,6 s,
 * ventas por día ~10,3 s. Con esto, la última sesión queda guardada en el
 * navegador y las pantallas pintan con esos datos mientras el listener real
 * viene por atrás.
 *
 * El detalle que lo puede arruinar entero: las fechas de Firestore no
 * sobreviven guardarlas y volverlas a leer. Pierden el prototipo y `.toDate()`
 * revienta, así que se guardan a mano y se rearman al cargar. Si eso falla, no
 * falla el cache: fallan todas las pantallas que muestran una fecha.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { instalarIndexedDB } from './indexeddb_falsa.js';

vi.mock('firebase/firestore', () => ({
  // El Timestamp real, en chiquito: lo que importa es que sea una CLASE, para
  // que revivir un dato guardado devuelva algo con `.toDate()` que funcione.
  Timestamp: class {
    constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
    toDate() { return new Date(this.seconds * 1000 + this.nanoseconds / 1e6); }
    toMillis() { return this.seconds * 1000 + Math.round(this.nanoseconds / 1e6); }
  },
}));

const idb = instalarIndexedDB();
const { Timestamp } = await import('firebase/firestore');
const { loadSnapshots, schedulePersist, clearSnapshots } =
  await import('../../webapp/src/snapshot_cache.js');

/** El almacén real, para sembrar y espiar sin pasar por el módulo. */
const almacen = () => idb._bases.get('pos_snapshots')?.get('kv');

/**
 * Deja correr los microtasks de la IndexedDB de mentira. No usa setTimeout a
 * propósito: varias pruebas corren con el reloj congelado.
 */
const asentar = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

/**
 * Guarda de punta a punta: programa, deja pasar el tiempo suficiente para que
 * venza el debounce Y el intervalo mínimo por key, y espera la escritura.
 */
async function guardar(key, data) {
  vi.useFakeTimers();
  schedulePersist(key, data);
  await vi.advanceTimersByTimeAsync(35000);
  await asentar();
  vi.useRealTimers();
}

beforeEach(async () => {
  vi.useRealTimers();
  await clearSnapshots();
});

afterEach(() => { vi.useRealTimers(); });

describe('guardar y volver a leer', () => {
  it('lo guardado vuelve igual', async () => {
    await guardar('col:catalogo', [{ id: 'p1', nombre: 'CUADERNO', precio_venta: 1000 }]);

    const snaps = await loadSnapshots();
    expect(snaps.get('col:catalogo').data).toEqual([
      { id: 'p1', nombre: 'CUADERNO', precio_venta: 1000 },
    ]);
  });

  it('una fecha de Firestore sigue siendo una fecha usable', async () => {
    // Es el punto que rompe todo si sale mal: guardar y leer la deja como un
    // objeto pelado, y cada `.toDate()` de las pantallas revienta.
    await guardar('col:ventas', [{ id: 'v1', created_at: new Timestamp(1756400000, 500000000) }]);

    const revivido = (await loadSnapshots()).get('col:ventas').data[0].created_at;
    expect(typeof revivido.toDate).toBe('function');
    expect(revivido.toDate().getTime()).toBe(1756400000 * 1000 + 500);
  });

  it('una fecha anidada adentro de un renglón también', async () => {
    await guardar('col:cierres', [{
      id: 'c1', caja: { abierta: new Timestamp(1756000000, 0) },
      movimientos: [{ ts: new Timestamp(1756100000, 0) }],
    }]);

    const d = (await loadSnapshots()).get('col:cierres').data[0];
    expect(d.caja.abierta.toDate().getTime()).toBe(1756000000 * 1000);
    expect(d.movimientos[0].ts.toDate().getTime()).toBe(1756100000 * 1000);
  });

  it('null, texto y números pasan sin tocarse', async () => {
    await guardar('col:x', [{ a: null, b: '', c: 0, d: false, e: [1, 2, 3] }]);

    expect((await loadSnapshots()).get('col:x').data[0])
      .toEqual({ a: null, b: '', c: 0, d: false, e: [1, 2, 3] });
  });
});

describe('lo que NO se hidrata', () => {
  it('un snapshot de hace un mes se descarta y se borra', async () => {
    // Levantar el catálogo de hace un mes hace que la primera pantalla muestre
    // precios viejos. Vencido es peor que vacío.
    const viejo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    almacen().set('col:catalogo', { v: 1, ts: viejo, data: [{ id: 'p1' }] });

    expect((await loadSnapshots()).has('col:catalogo')).toBe(false);
    expect(almacen().has('col:catalogo')).toBe(false);
  });

  it('uno de una versión anterior tampoco', async () => {
    almacen().set('col:catalogo', { v: 0, ts: Date.now(), data: [{ id: 'p1' }] });
    expect((await loadSnapshots()).has('col:catalogo')).toBe(false);
  });

  it('una entrada que no es de una colección se ignora', async () => {
    almacen().set('otra_cosa', { v: 1, ts: Date.now(), data: [1] });
    expect((await loadSnapshots()).has('otra_cosa')).toBe(false);
  });

  it('con la base vacía devuelve vacío, no rompe', async () => {
    expect((await loadSnapshots()).size).toBe(0);
  });
});

describe('cuántas veces escribe', () => {
  it('una ráfaga de snapshots se guarda una sola vez', async () => {
    // El listener del catálogo re-emite con cada venta: sin agrupar, se
    // reescribirían 12.000 productos por cada producto vendido.
    vi.useFakeTimers();
    schedulePersist('col:rafaga', [{ id: 'a' }]);
    schedulePersist('col:rafaga', [{ id: 'a' }, { id: 'b' }]);
    schedulePersist('col:rafaga', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await vi.advanceTimersByTimeAsync(2000);
    await asentar();
    vi.useRealTimers();

    expect(almacen().get('col:rafaga').data.length).toBe(3);   // el último gana
  });

  it('recién guardado, lo próximo espera el intervalo mínimo', async () => {
    // Sin este techo, cada venta que entra reescribe el catálogo entero en el
    // disco de la máquina del local.
    vi.useFakeTimers();
    schedulePersist('col:techo', [{ id: 'v1' }]);
    await vi.advanceTimersByTimeAsync(2000);
    await asentar();
    expect(almacen().get('col:techo').data.length).toBe(1);

    schedulePersist('col:techo', [{ id: 'v1' }, { id: 'v2' }]);
    await vi.advanceTimersByTimeAsync(3000);   // el debounce corto ya pasó
    await asentar();
    expect(almacen().get('col:techo').data.length).toBe(1);

    await vi.advanceTimersByTimeAsync(30000);  // recién ahora
    await asentar();
    vi.useRealTimers();
    expect(almacen().get('col:techo').data.length).toBe(2);
  });

  it('cada colección lleva su propio ritmo', async () => {
    vi.useFakeTimers();
    schedulePersist('col:ritmo_a', [{ id: 'a' }]);
    schedulePersist('col:ritmo_b', [{ id: 'v' }]);
    await vi.advanceTimersByTimeAsync(2000);
    await asentar();
    vi.useRealTimers();

    expect(almacen().has('col:ritmo_a')).toBe(true);
    expect(almacen().has('col:ritmo_b')).toBe(true);
  });
});

describe('cerrar la pestaña', () => {
  it('lo que estaba por guardarse se guarda igual', async () => {
    // Se cierra el panel a los 3 segundos de una venta: sin esto, ese snapshot
    // se pierde y el próximo arranque levanta el de antes.
    vi.useFakeTimers();
    schedulePersist('col:cierre_pestania', [{ id: 'a' }, { id: 'b' }]);
    window.dispatchEvent(new Event('pagehide'));
    await asentar();
    vi.useRealTimers();

    expect(almacen().get('col:cierre_pestania').data.length).toBe(2);
  });
});

describe('borrar todo', () => {
  it('deja la base vacía', async () => {
    await guardar('col:para_borrar', [{ id: 'a' }]);
    expect(almacen().size).toBeGreaterThan(0);

    await clearSnapshots();
    expect(almacen().size).toBe(0);
    expect((await loadSnapshots()).size).toBe(0);
  });
});
