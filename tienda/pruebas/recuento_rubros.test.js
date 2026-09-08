/**
 * El conteo de la portada (`tienda_config/rubros`: qué rubros y subrubros hay
 * y cuántos productos tiene cada uno) se rehace solo después de un cambio
 * suelto del panel.
 *
 * Hasta el 2026-09-08 lo rehacía únicamente el sync, cada seis horas. Mover un
 * producto de "Aros" a "Aros Carpeta" desde la ficha dejaba en la tienda el
 * filtro "Aros 1" con nada adentro hasta la próxima corrida; lo mismo al
 * dejarlo sin stock, borrarlo o publicarlo a mano.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Sin sesión: la escritura por REST se saltea y todo cae al SDK, que acá son
// espías. Lo que se prueba es QUÉ se escribe y CUÁNDO, no Firebase.
vi.mock('../../webapp/src/auth.js', () => ({ auth: { currentUser: null } }));

const lote = { update: vi.fn(), set: vi.fn(), delete: vi.fn(), commit: vi.fn(async () => {}) };
const sdk = { updateDoc: vi.fn(async () => {}), deleteDoc: vi.fn(async () => {}) };
// Lo que "hay" en Firestore para las lecturas sueltas.
const nube = { tienda_config: {}, tienda_productos: {} };

vi.mock('firebase/firestore', () => ({
  doc: (_db, col, id) => ({ col, id }),
  getDoc: vi.fn(async ref => {
    const datos = nube[ref.col]?.[ref.id];
    return { exists: () => !!datos, data: () => datos, get: campo => datos?.[campo] };
  }),
  getDocFromCache: vi.fn(), collection: vi.fn(), query: vi.fn(), orderBy: vi.fn(),
  limit: vi.fn(), getDocs: vi.fn(async () => ({ docs: [] })),
  writeBatch: () => lote,
  updateDoc: (...a) => sdk.updateDoc(...a),
  deleteDoc: (...a) => sdk.deleteDoc(...a),
  serverTimestamp: () => ({ _methodName: 'serverTimestamp' }),
  deleteField: () => ({ _methodName: 'deleteField' }),
}));

import {
  usarCatalogoParaRecontar, programarRecuentoDeRubros, esperarRecuento,
  reflejarSiPublicado, avisarStockALaTienda, sacarDeLaTienda, recomputarRubros,
} from '../../webapp/src/tienda_espejo.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..', '..');

// Un conjunto con colores: el stock sale de sumar las variedades.
const CARTULINA = {
  estado: 'activo', nombre: 'CARTULINA LUMA', rubro: 'LIBRERÍA', sub_rubro: 'PAPELES',
  precio_venta: 5600, conjunto_precio_unidad: 600, tienda_imagenes: ['foto.jpg'],
  es_conjunto: true, conjunto_tipo: 'pack', conjunto_contenido: 10,
  conjunto_colores: [
    { color: 'CELESTE', unidades: 1, restante: 2 },
    { color: 'ROSA VIEJO', unidades: 0, restante: 5 },
  ],
};

const db = {};
const ESPERA = 3000;

const base = { estado: 'activo', precio_venta: 100, stock: 5, tienda_imagenes: ['foto.jpg'] };
const catalogo = () => [
  { ...base, doc_id: 'A', nombre: 'AROS DE METAL', rubro: 'LIBRERÍA', sub_rubro: 'AROS CARPETA' },
  { ...base, doc_id: 'B', nombre: 'CUADERNO', rubro: 'LIBRERÍA', sub_rubro: 'CUADERNOS' },
  // Publicado a mano en un rubro apagado: NO cuenta. Desde el 2026-09-08 el
  // rubro destildado en Configuración de la Tienda le gana a "Publicar
  // siempre", así que estos tampoco están en la tienda ni en la portada.
  { ...base, doc_id: 'C', nombre: 'BENGALA', rubro: 'COTILLON', sub_rubro: 'BENGALAS',
    tienda_publicar: true },
  // Rubro apagado y sin marca: no cuenta.
  { ...base, doc_id: 'D', nombre: 'LANA', rubro: 'MERCERÍA', sub_rubro: 'LANA' },
];

/** Las escrituras del conteo de la portada, en orden. */
const recuentos = () => lote.set.mock.calls
  .filter(([ref]) => ref.col === 'tienda_config' && ref.id === 'rubros')
  .map(([, datos]) => datos);

async function dejarPasar(ms = ESPERA) {
  await vi.advanceTimersByTimeAsync(ms);
  await esperarRecuento();
}

// `leerPublicacion` recuerda la configuración un minuto. El reloj falso
// arranca en la hora real en cada prueba, así que se corre un poco más cada
// vez para que cada una lea la suya.
let saltos = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.advanceTimersByTime(61_000 * ++saltos);
  // Sin red: las lecturas por REST no responden y el código cae al SDK.
  globalThis.fetch = vi.fn(async () => { throw new Error('sin red'); });
  lote.set.mockClear(); lote.update.mockClear(); lote.delete.mockClear(); lote.commit.mockClear();
  sdk.updateDoc.mockClear(); sdk.deleteDoc.mockClear();
  nube.tienda_config = { publicacion: { rubros: ['LIBRERÍA'], subrubros_excluidos: {} } };
  nube.tienda_productos = {};
  usarCatalogoParaRecontar(catalogo);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('programar el recuento', () => {
  it('varias llamadas seguidas terminan en UNA escritura, con rubros y subrubros contados', async () => {
    programarRecuentoDeRubros(db);
    programarRecuentoDeRubros(db);
    programarRecuentoDeRubros(db);
    expect(recuentos()).toHaveLength(0);

    await dejarPasar();

    expect(recuentos()).toHaveLength(1);
    const { lista, actualizado } = recuentos()[0];
    expect(actualizado).toEqual({ _methodName: 'serverTimestamp' });
    expect(lista.map(r => [r.clave, r.cantidad])).toEqual([['LIBRERÍA', 2]]);
    expect(lista[0].subrubros.map(s => [s.clave, s.cantidad]))
      .toEqual([['AROS CARPETA', 1], ['CUADERNOS', 1]]);
    // Ni Mercería ni Cotillón: los dos rubros están apagados, y a Cotillón no
    // lo salva la marca a mano de la bengala.
    expect(lista.some(r => r.clave === 'MERCERÍA')).toBe(false);
    expect(lista.some(r => r.clave === 'COTILLON')).toBe(false);
  });

  it('un cambio después del plazo vuelve a contar', async () => {
    programarRecuentoDeRubros(db);
    await dejarPasar();
    programarRecuentoDeRubros(db);
    await dejarPasar();
    expect(recuentos()).toHaveLength(2);
  });

  it('sin la lista de rubros habilitados no escribe nada: eso queda para el sync', async () => {
    nube.tienda_config = { publicacion: {} };
    programarRecuentoDeRubros(db);
    await dejarPasar();
    expect(recuentos()).toHaveLength(0);
  });

  it('sin nadie que preste el catálogo no hace nada', async () => {
    usarCatalogoParaRecontar(null);
    programarRecuentoDeRubros(db);
    await dejarPasar();
    expect(recuentos()).toHaveLength(0);
  });
});

describe('qué cambios lo disparan', () => {
  it('dejar un producto sin stock lo saca de la tienda y recuenta', async () => {
    await avisarStockALaTienda(db, 'A', 0);
    expect(sdk.deleteDoc).toHaveBeenCalledWith({ col: 'tienda_productos', id: 'A' });
    await dejarPasar();
    expect(recuentos()).toHaveLength(1);
  });

  it('reponer stock solo actualiza el número: el conteo no cambia', async () => {
    await avisarStockALaTienda(db, 'A', 7);
    expect(sdk.updateDoc).toHaveBeenCalledWith({ col: 'tienda_productos', id: 'A' }, { stock: 7 });
    await dejarPasar();
    expect(recuentos()).toHaveLength(0);
  });

  it('borrar un producto del catálogo lo saca de la tienda en el momento y recuenta', async () => {
    await sacarDeLaTienda(db, 'B');
    expect(lote.delete).toHaveBeenCalledWith({ col: 'tienda_productos', id: 'B' });
    await dejarPasar();
    expect(recuentos()).toHaveLength(1);
  });

  it('mover un producto publicado de subrubro recuenta (el caso "Aros 1")', async () => {
    // En la tienda estaba en "Aros"; la ficha lo pasa a "Aros Carpeta".
    nube.tienda_productos.A = { rubro: 'LIBRERÍA', sub_rubro: 'Aros', orden: 10, orden_rubro: 3 };
    const r = await reflejarSiPublicado(db, 'A', catalogo()[0]);
    expect(r.publicado).toBe(true);
    await dejarPasar();
    expect(recuentos()).toHaveLength(1);
    expect(recuentos()[0].lista[0].subrubros.map(s => s.clave)).toContain('AROS CARPETA');
  });

  it('cambiarle el precio a un producto publicado no recuenta', async () => {
    nube.tienda_productos.B = { rubro: 'LIBRERÍA', sub_rubro: 'Cuadernos', orden: 11, orden_rubro: 4 };
    const r = await reflejarSiPublicado(db, 'B', { ...catalogo()[1], precio_venta: 250 });
    expect(r.publicado).toBe(true);
    await dejarPasar();
    expect(recuentos()).toHaveLength(0);
  });

  it('un producto publicado que se queda sin stock desde la ficha recuenta', async () => {
    nube.tienda_productos.B = { rubro: 'LIBRERÍA', sub_rubro: 'Cuadernos', orden: 11, orden_rubro: 4 };
    const r = await reflejarSiPublicado(db, 'B', { ...catalogo()[1], stock: 0 });
    expect(r.publicado).toBe(false);
    expect(lote.delete).toHaveBeenCalledWith({ col: 'tienda_productos', id: 'B' });
    await dejarPasar();
    expect(recuentos()).toHaveLength(1);
  });

  it('un producto que no está en la tienda no dispara nada', async () => {
    const r = await reflejarSiPublicado(db, 'D', catalogo()[3]);
    expect(r.motivo).toBe('no está en la tienda');
    await dejarPasar();
    expect(recuentos()).toHaveLength(0);
  });
});

/*
 * El aviso de stock decide con `motivoDeNoPublicar()`, la misma regla que corre
 * el sync, y no comparando contra cero. Comparar contra cero dejaba ofrecido lo
 * que no se puede comprar: con venta mínima 50 y 42 en góndola el producto
 * seguía en la vidriera, entraba al pedido y desaparecía al confirmarlo.
 */
describe('avisar el stock nuevo con el producto en la mano', () => {
  const simple = { ...base, nombre: 'OJOS MOVILES', rubro: 'LIBRERÍA', sub_rubro: 'APLIQUES' };

  it('lo que queda por debajo de la venta mínima sale de la vidriera y recuenta', async () => {
    await avisarStockALaTienda(db, 'A', 42, { ...simple, stock: 42, tienda_minimo: 50 });
    expect(sdk.deleteDoc).toHaveBeenCalledWith({ col: 'tienda_productos', id: 'A' });
    expect(sdk.updateDoc).not.toHaveBeenCalled();
    await dejarPasar();
    expect(recuentos()).toHaveLength(1);
  });

  it('con stock justo para la venta mínima se queda', async () => {
    await avisarStockALaTienda(db, 'A', 50, { ...simple, stock: 50, tienda_minimo: 50 });
    expect(sdk.updateDoc).toHaveBeenCalledWith({ col: 'tienda_productos', id: 'A' },
      { stock: 50, variedades: [] });
    expect(sdk.deleteDoc).not.toHaveBeenCalled();
  });

  it('un producto con colores manda el stock de cada uno, no solo el total', async () => {
    await avisarStockALaTienda(db, 'A', 17, CARTULINA);
    expect(sdk.updateDoc).toHaveBeenCalledWith({ col: 'tienda_productos', id: 'A' }, {
      stock: 17,
      variedades: [
        { nombre: 'Celeste', stock: 12, precio: null, imagen: null },
        { nombre: 'Rosa Viejo', stock: 5, precio: null, imagen: null },
      ],
    });
  });

  it('sin el producto se mira solo el cero, como antes', async () => {
    await avisarStockALaTienda(db, 'A', 7);
    expect(sdk.updateDoc).toHaveBeenCalledWith({ col: 'tienda_productos', id: 'A' }, { stock: 7 });
  });
});

/*
 * La portada tiene que quedar en el orden que ya tenía.
 *
 * El sync ordena los rubros por lo que factura cada uno (Papelera vende $2,3
 * millones con 244 productos; Regalería $947 mil con 594). El recuento del
 * panel ordenaba por cantidad de productos: cada guardado daba vuelta la
 * portada y la corrida siguiente del sync la devolvía a su lugar.
 */
describe('el orden de los rubros en la portada', () => {
  const conTodos = () => {
    nube.tienda_config.publicacion = {
      rubros: ['LIBRERÍA', 'MERCERÍA', 'COTILLON'], subrubros_excluidos: {},
    };
  };

  it('conserva el orden anterior aunque las cantidades digan otra cosa', async () => {
    conTodos();
    // Como lo dejó el sync: Mercería primero por lo que vende, con un solo
    // producto contra los dos de Librería.
    nube.tienda_config.rubros = { lista: [{ clave: 'MERCERÍA' }, { clave: 'LIBRERÍA' }] };

    programarRecuentoDeRubros(db);
    await dejarPasar();

    expect(recuentos()[0].lista.map(r => r.clave))
      .toEqual(['MERCERÍA', 'LIBRERÍA', 'COTILLON']);
  });

  it('sin orden anterior ordena por cantidad, y el rubro que desapareció se va', async () => {
    conTodos();
    nube.tienda_config.rubros = { lista: [{ clave: 'JUGUETERIA' }] };

    programarRecuentoDeRubros(db);
    await dejarPasar();

    const claves = recuentos()[0].lista.map(r => r.clave);
    // Ninguno de los tres estaba en la lista vieja: quedan por cantidad.
    expect(claves[0]).toBe('LIBRERÍA');
    expect(claves).toHaveLength(3);
    expect(claves).not.toContain('JUGUETERIA');
  });
});

/*
 * El conteo del panel contra el del sync.
 *
 * `tienda_config/rubros` lo escriben los dos: `contar_rubros()` en cada corrida
 * del sync y `recomputarRubros()` acá, unos segundos después de cada cambio
 * suelto del panel. Nadie los comparaba, y estaban separados: el sync agrupa
 * los subrubros por el nombre que PUBLICA ("BOLIGRAFO" y "BOLÍGRAFO" son el
 * mismo cajón de la librería) y el panel lo hacía por el texto crudo del
 * catálogo. La segunda fila de filtros de la tienda mostraba el mismo subrubro
 * dos veces, con la mitad de los productos en cada uno, hasta la corrida
 * siguiente del sync, que los volvía a juntar.
 *
 * Los casos viven en scripts/casos_espejo.py, que es también el que corre la
 * versión Python: así no hay forma de agregar un caso para uno solo de los dos.
 */
describe('el conteo de la portada contra el del sync', () => {
  let delSync = null;
  let porQueNo = '';

  beforeAll(() => {
    // Sin Python no se puede comparar. No se falla por eso: en una máquina sin
    // Python el resto de la suite tiene que poder correr igual.
    for (const python of ['python', 'python3', 'py']) {
      try {
        const salida = execFileSync(python, [join(RAIZ, 'scripts', 'casos_espejo.py')],
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        delSync = JSON.parse(salida).conteo;
        break;
      } catch (err) {
        porQueNo = String(err?.stderr || err?.message || err).split('\n').slice(-6).join('\n');
      }
    }
  });

  /** El conteo del panel, en la misma forma que lo devuelve el puente. */
  const conElPanel = async (caso) => {
    const lista = await recomputarRubros(
      db, caso.productos.map(p => ({ datos: p.datos })), caso.rubros, caso.excluidos);
    return lista.map(r => ({
      clave: r.clave, nombre: r.nombre, cantidad: r.cantidad, con_stock: r.con_stock,
      subrubros: r.subrubros.map(s => ({ clave: s.clave, nombre: s.nombre, cantidad: s.cantidad })),
    }));
  };

  // El ORDEN de los rubros es lo único que a propósito no coincide: el sync los
  // pone por lo que factura cada uno y el panel conserva el que ya tenía la
  // portada. Comparados por clave, los números tienen que ser los mismos.
  const porClave = (filas) => [...filas].sort((a, b) => a.clave.localeCompare(b.clave));

  it('corre el sync para comparar', () => {
    if (!delSync) console.warn(`\n  [recuento] sin comparación contra Python:\n${porQueNo}\n`);
    expect(delSync?.length ?? 0).toBeGreaterThan(0);
  });

  it('cuenta lo mismo que el sync, rubro por rubro y subrubro por subrubro', async () => {
    if (!delSync) return;

    // Todos los casos en una sola comparación: así el diff de la prueba
    // muestra en qué caso se separaron y en qué subrubro, no solo el primero.
    const esperado = [];
    const obtenido = [];
    for (const caso of delSync) {
      esperado.push({ caso: caso.que_prueba, rubros: porClave(caso.rubros_contados) });
      obtenido.push({ caso: caso.que_prueba, rubros: porClave(await conElPanel(caso)) });
    }
    expect(obtenido).toEqual(esperado);
  });
});
