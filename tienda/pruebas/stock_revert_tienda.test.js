/**
 * Borrar una venta desde el panel también tiene que avisarle a la tienda.
 *
 * El caso que motiva todo esto: se vende la última unidad, el POS deja el
 * producto en cero y lo saca del espejo que lee la tienda. Al rato el local se
 * da cuenta de que la venta estaba mal y la borra desde Ventas. El stock vuelve
 * al catálogo, pero el documento del espejo ya no existe: hasta ahora el
 * producto no volvía a la vidriera hasta la corrida siguiente del sync, seis
 * horas después.
 *
 * Por eso acá `webapp/src/tienda_espejo.js` corre de verdad, con sus reglas de
 * publicación reales: lo único falso es Firestore, que es un objeto en memoria.
 * Probar contra un doble del espejo no serviría, porque lo que se está
 * probando es justamente por qué puerta del espejo hay que entrar (`espejar()`,
 * la única que sabe CREAR el documento; `avisarStockALaTienda()` y
 * `reflejarSiPublicado()` dan por sentado que el producto ya está publicado).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const firestore = vi.hoisted(() => {
  // Lo que "hay" en Firestore. Cada colección es {id: documento}.
  const nube = {};
  // Colecciones que rechazan escrituras en esta prueba.
  const fallan = new Set();

  const instantanea = (col, id) => {
    const datos = nube[col]?.[id];
    return {
      id, ref: { col, id },
      exists: () => datos !== undefined,
      data: () => datos,
      get: (campo) => datos?.[campo],
    };
  };

  const aplicar = (op) => {
    const { col, id } = op.ref;
    if (fallan.has(col)) throw new Error(`sin permiso para escribir ${col}`);
    nube[col] = nube[col] || {};
    if (op.tipo === 'borrar') { delete nube[col][id]; return; }
    // `merge` deja lo que había; sin merge se reemplaza el documento entero,
    // que es lo que hace el espejo al publicar.
    const datos = op.merge ? { ...(nube[col][id] || {}) } : {};
    for (const [clave, valor] of Object.entries(op.datos || {})) {
      datos[clave] = (valor && typeof valor === 'object' && '_incremento' in valor)
        ? (Number(datos[clave]) || 0) + valor._incremento
        : valor;
    }
    nube[col][id] = datos;
  };

  return { nube, fallan, instantanea, aplicar };
});

vi.mock('firebase/firestore', () => {
  const { nube, instantanea, aplicar } = firestore;
  return {
    doc: (_db, col, id) => ({ col, id }),
    collection: (_db, col) => ({ col }),
    query: (ref) => ref,
    where: () => ({}), orderBy: () => ({}), limit: () => ({}),
    getDocs: async (ref) => ({
      docs: Object.keys(nube[ref.col] || {}).map(id => instantanea(ref.col, id)),
    }),
    getDoc: async (ref) => instantanea(ref.col, ref.id),
    getDocFromCache: async () => { throw new Error('no está en el cache'); },
    setDoc: async (ref, datos, opciones) =>
      aplicar({ tipo: 'set', ref, datos, merge: !!opciones?.merge }),
    updateDoc: async (ref, datos) => aplicar({ tipo: 'set', ref, datos, merge: true }),
    deleteDoc: async (ref) => aplicar({ tipo: 'borrar', ref }),
    writeBatch: () => {
      const pendientes = [];
      return {
        set: (ref, datos, opciones) =>
          pendientes.push({ tipo: 'set', ref, datos, merge: !!opciones?.merge }),
        update: (ref, datos) => pendientes.push({ tipo: 'set', ref, datos, merge: true }),
        delete: (ref) => pendientes.push({ tipo: 'borrar', ref }),
        commit: async () => { pendientes.forEach(aplicar); },
      };
    },
    runTransaction: async (_db, fn) => {
      const pendientes = [];
      await fn({
        get: async (ref) => instantanea(ref.col, ref.id),
        set: (ref, datos, opciones) =>
          pendientes.push({ tipo: 'set', ref, datos, merge: !!opciones?.merge }),
      });
      pendientes.forEach(aplicar);
    },
    serverTimestamp: () => ({ _methodName: 'serverTimestamp' }),
    deleteField: () => ({ _methodName: 'deleteField' }),
    increment: (n) => ({ _incremento: n }),
  };
});

// Sin sesión: las escrituras por REST se saltean y todo cae al SDK, que es el
// doble de arriba. Lo que importa acá es QUÉ queda escrito.
vi.mock('../../webapp/src/auth.js', () => ({ auth: { currentUser: null } }));
vi.mock('../../webapp/src/cache.js', () => ({
  getCached: async (_clave, traer) => traer(), invalidateCacheByPrefix: () => {},
}));
vi.mock('../../webapp/src/stock_ledger.js', () => ({ registrarMovimiento: () => {} }));

import { revertirStockVenta } from '../../webapp/src/stock_revert.js';
import {
  olvidarPublicacion, olvidarDescuentosVigentes,
  usarCatalogoParaRecontar, esperarRecuento,
} from '../../webapp/src/tienda_espejo.js';

const { nube, fallan } = firestore;
const db = {};

// Producto suelto que se quedó en cero: el POS lo sacó del espejo al vender la
// última unidad.
const GOMA = {
  id: 101, nombre: 'GOMA MOOVING', estado: 'activo',
  rubro: 'LIBRERÍA', sub_rubro: 'GOMAS', precio_venta: 500, stock: 0,
  tienda_imagenes: ['goma.webp'],
};

// Rubro apagado en la configuración de la tienda: devolverle stock no lo tiene
// que hacer aparecer en la vidriera.
const BENGALA = {
  id: 202, nombre: 'BENGALA CHICA', estado: 'activo',
  rubro: 'COTILLON', sub_rubro: 'BENGALAS', precio_venta: 800, stock: 0,
  tienda_imagenes: ['bengala.webp'],
};

// Conjunto con variedades, todas en cero.
const CARTULINA = {
  id: 303, nombre: 'CARTULINA LUMA', estado: 'activo',
  rubro: 'LIBRERÍA', sub_rubro: 'PAPELES', precio_venta: 5600,
  conjunto_precio_unidad: 600, tienda_imagenes: ['cartulina.webp'],
  es_conjunto: true, conjunto_tipo: 'pack', conjunto_contenido: 10,
  conjunto_unidad_medida: 'unidades',
  conjunto_colores: [
    { color: 'CELESTE', unidades: 0, restante: 0 },
    { color: 'ROSA VIEJO', unidades: 0, restante: 0 },
  ],
};

/** Un renglón de `ventas_por_dia` como lo escribe el POS. */
const renglon = (id, datos) => ({
  id, ref: { col: 'ventas_por_dia', id }, data: () => datos,
});

const borrarVenta = (itemDocs) =>
  revertirStockVenta(db, { saleId: 4516, itemDocs, marcarDeleted: true });

beforeEach(() => {
  for (const col of Object.keys(nube)) delete nube[col];
  fallan.clear();
  nube.catalogo = { A: { ...GOMA }, B: { ...BENGALA }, C: { ...CARTULINA } };
  nube.tienda_productos = {};
  nube.tienda_config = { publicacion: { rubros: ['LIBRERÍA'], subrubros_excluidos: {} } };
  nube.tienda_descuentos = {};
  // Los dos módulos recuerdan la configuración un minuto; cada prueba pone la
  // suya.
  olvidarPublicacion();
  olvidarDescuentosVigentes();
  // Sin red: las lecturas y escrituras por REST no responden y todo cae al SDK.
  globalThis.fetch = vi.fn(async () => { throw new Error('sin red'); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  usarCatalogoParaRecontar(null);
});

describe('la venta borrada devuelve el producto a la vidriera', () => {
  it('re-publica el producto que el POS había sacado del espejo', async () => {
    const resumen = await borrarVenta([
      renglon('PC1_1', { num_venta: 4516, producto: 'GOMA MOOVING', cantidad: 1 }),
    ]);

    expect(resumen.devueltos).toEqual([{ nombre: 'GOMA MOOVING', cantidad: 1, tipo: 'producto' }]);
    expect(nube.catalogo.A.stock).toBe(1);

    // Lo que se está probando: el documento del espejo NO existía y hay que
    // crearlo. Un `updateDoc` sobre esto no hace nada y falla en silencio.
    const espejo = nube.tienda_productos.A;
    expect(espejo, 'el producto no volvió a la tienda').toBeTruthy();
    expect(espejo.stock).toBe(1);
    expect(espejo.nombre).toBe('Goma Mooving');
    expect(espejo.rubro).toBe('LIBRERÍA');
    expect(espejo.precio).toBe(500);
  });

  it('actualiza el stock del que ya estaba publicado sin moverlo de lugar', async () => {
    // `orden`, `orden_rubro` y `destacado` los decide el sync mirando el
    // catálogo entero: el panel no los puede recalcular y los tiene que
    // conservar.
    nube.catalogo.A.stock = 3;
    nube.tienda_productos.A = {
      nombre: 'Goma Mooving', stock: 3, precio: 500, rubro: 'LIBRERÍA',
      orden: 7, orden_rubro: 2, destacado: true,
    };

    await borrarVenta([
      renglon('PC1_1', { num_venta: 4516, producto: 'GOMA MOOVING', cantidad: 2 }),
    ]);

    const espejo = nube.tienda_productos.A;
    expect(espejo.stock).toBe(5);
    expect(espejo.orden).toBe(7);
    expect(espejo.orden_rubro).toBe(2);
    expect(espejo.destacado).toBe(true);
  });

  it('publica el stock que quedó por variedad, no el que tenía el catálogo en memoria', async () => {
    // El total de un conjunto se recalcula adentro de una transacción, sobre el
    // documento leído en el momento. Si el espejo se armara con el producto que
    // el panel tiene cacheado, la cartulina saldría con sus dos colores en cero
    // y el espejo la borraría en vez de publicarla.
    await borrarVenta([
      renglon('PC1_1', {
        num_venta: 4516, producto: '[CELESTE]  CARTULINA LUMA  ·  2 u', cantidad: 2,
      }),
    ]);

    expect(nube.catalogo.C.conjunto_total).toBe(2);

    const espejo = nube.tienda_productos.C;
    expect(espejo, 'la cartulina no volvió a la tienda').toBeTruthy();
    expect(espejo.stock).toBe(2);
    expect(espejo.variedades.map(v => [v.nombre, v.stock]))
      .toEqual([['Celeste', 2], ['Rosa Viejo', 0]]);
    // El pack se sigue ofreciendo con el precio del pack entero, y la unidad
    // con el suyo: eso lo arma la misma regla que usa el sync.
    expect(espejo.precio).toBe(600);
    expect(espejo.precio_pack).toBe(5600);
  });

  it('no devuelve a la vidriera un producto de un rubro apagado', async () => {
    const resumen = await borrarVenta([
      renglon('PC1_1', { num_venta: 4516, producto: 'BENGALA CHICA', cantidad: 4 }),
    ]);

    expect(resumen.devueltos).toEqual([{ nombre: 'BENGALA CHICA', cantidad: 4, tipo: 'producto' }]);
    expect(nube.catalogo.B.stock).toBe(4);
    expect(nube.tienda_productos.B).toBeUndefined();
  });

  it('sin la lista de rubros no toca el espejo', async () => {
    // `motivoDeNoPublicar()` sin la lista saltea el rubro apagado y la falta de
    // foto: espejar así publicaría cosas que la tienda no muestra. Mejor
    // dejarlo para el sync.
    nube.tienda_config.publicacion = {};
    olvidarPublicacion();

    await borrarVenta([
      renglon('PC1_1', { num_venta: 4516, producto: 'GOMA MOOVING', cantidad: 1 }),
      renglon('PC1_2', { num_venta: 4516, producto: 'BENGALA CHICA', cantidad: 1 }),
    ]);

    expect(nube.catalogo.A.stock).toBe(1);
    expect(nube.catalogo.B.stock).toBe(1);
    expect(nube.tienda_productos).toEqual({});
  });

  it('el stock se devuelve igual aunque el espejo rechace la escritura', async () => {
    // Ventas trata el error de la devolución como "no se pudo devolver el
    // stock" y pregunta si borra la venta igual. Que la tienda no se entere no
    // puede llegar a esa pregunta: el stock ya volvió al catálogo.
    fallan.add('tienda_productos');

    const resumen = await borrarVenta([
      renglon('PC1_1', { num_venta: 4516, producto: 'GOMA MOOVING', cantidad: 1 }),
    ]);

    expect(resumen.devueltos).toEqual([{ nombre: 'GOMA MOOVING', cantidad: 1, tipo: 'producto' }]);
    expect(nube.catalogo.A.stock).toBe(1);
    expect(nube.tienda_productos.A).toBeUndefined();
  });

  it('marca los renglones para no devolver el stock dos veces', async () => {
    const item = renglon('PC1_1', { num_venta: 4516, producto: 'GOMA MOOVING', cantidad: 1 });
    await borrarVenta([item]);
    expect(nube.catalogo.A.stock).toBe(1);
    expect(nube.ventas_por_dia.PC1_1.stock_revertido).toBe(true);
    expect(nube.ventas_por_dia.PC1_1.deleted).toBe(true);

    // El mismo renglón, ya marcado: no se devuelve de nuevo ni se vuelve a
    // tocar la tienda.
    delete nube.tienda_productos.A;
    const otra = await borrarVenta([
      renglon('PC1_1', { ...item.data(), stock_revertido: true }),
    ]);
    expect(otra.items).toBe(0);
    expect(nube.catalogo.A.stock).toBe(1);
    expect(nube.tienda_productos.A).toBeUndefined();
  });
});

describe('el conteo de la portada', () => {
  it('se rehace cuando el producto vuelve a la vidriera', async () => {
    // La portada dice cuántos productos tiene cada rubro y cada subrubro. Uno
    // que vuelve cambia ese número, y el conteo se rehace unos segundos después
    // del último cambio, con el catálogo que la pantalla ya tiene en memoria.
    vi.useFakeTimers();
    try {
      usarCatalogoParaRecontar(() => Object.values(nube.catalogo));

      await borrarVenta([
        renglon('PC1_1', { num_venta: 4516, producto: 'GOMA MOOVING', cantidad: 1 }),
      ]);
      expect(nube.tienda_config.rubros).toBeUndefined();

      await vi.advanceTimersByTimeAsync(3000);
      await esperarRecuento();

      const lista = nube.tienda_config.rubros?.lista;
      expect(lista, 'no se rehizo el conteo de la portada').toBeTruthy();
      expect(lista.map(r => [r.clave, r.cantidad])).toEqual([['LIBRERÍA', 1]]);
      expect(lista[0].subrubros.map(s => [s.clave, s.cantidad])).toEqual([['GOMAS', 1]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
