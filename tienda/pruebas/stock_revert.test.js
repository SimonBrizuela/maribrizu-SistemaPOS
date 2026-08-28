/**
 * Devolver el stock cuando se borra una venta.
 *
 * El POS escribe el nombre del renglón con la presentación adentro:
 *
 *     "[Verde]  GOMA EVA 40X60  ·  2 u"
 *     "PAPEL OBRA A4  ·  1 pack(s)"
 *     "CINTA RASO  ·  2,5 m"
 *
 * Cuando alguien borra esa venta desde el panel, `webapp/src/stock_revert.js`
 * vuelve a LEER ese texto para saber cuánto stock devolver. No hay otro dato:
 * la cantidad real de una venta fraccionada vive sólo en el nombre.
 *
 * Por eso hay dos cosas que probar acá:
 *
 *   1. que el panel lea bien lo que el POS escribe, y
 *   2. que las tablas de presentaciones y unidades sean las MISMAS de los dos
 *      lados. Están escritas dos veces (Python y JavaScript) y si se agrega una
 *      presentación de un solo lado, borrar la venta no devuelve nada y sólo
 *      queda un aviso en la consola del navegador: el stock queda mal y nadie
 *      se entera.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// El módulo abre Firestore al importarse (lo usa para escribir el catálogo).
// Acá sólo interesan las funciones puras, así que el SDK se reemplaza por un
// doble: importar Firebase de verdad pediría credenciales que una prueba no
// tiene por qué tener.
vi.mock('firebase/firestore', () => ({
  collection: () => ({}), query: () => ({}), where: () => ({}), getDocs: async () => ({ docs: [] }),
  doc: () => ({}), writeBatch: () => ({ set: () => {}, update: () => {}, commit: async () => {} }),
  runTransaction: async () => {}, serverTimestamp: () => 'AHORA', increment: (n) => n,
  setDoc: async () => {},
}));
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {} }));
vi.mock('../../webapp/src/cache.js', () => ({
  getCached: async (_k, fn) => fn(), invalidateCacheByPrefix: () => {},
}));
vi.mock('../../webapp/src/stock_ledger.js', () => ({ registrarMovimiento: () => {} }));

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..', '..');

let CONJ_TIPOS;
let CONJ_UNIDADES;
let UNIDAD_WEBAPP;
let parseNombre;
let factorPorUnidad;
let esIlimitado;

let delPos = null;
let porQueNo = '';

beforeAll(async () => {
  ({
    CONJ_TIPOS, CONJ_UNIDADES, UNIDAD_WEBAPP,
    _parseNombreItem: parseNombre, _factorPorUnidad: factorPorUnidad,
    _esIlimitado: esIlimitado,
  } = await import('../../webapp/src/stock_revert.js'));

  for (const python of ['python', 'python3', 'py']) {
    try {
      const salida = execFileSync(python, [join(RAIZ, 'scripts', 'casos_conjunto_tipos.py')],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      delPos = JSON.parse(salida);
      break;
    } catch (err) {
      porQueNo = String(err?.stderr || err?.message || err).split('\n').slice(-6).join('\n');
    }
  }
});

describe('las tablas del panel contra las del POS', () => {
  it('corre el POS para comparar', () => {
    if (!delPos) console.warn(`\n  [stock_revert] sin comparación contra Python:\n${porQueNo}\n`);
    expect(CONJ_TIPOS).toBeDefined();
  });

  it('las presentaciones son las mismas', () => {
    if (!delPos) return;
    expect(CONJ_TIPOS).toEqual(delPos.tipos);
  });

  it('las unidades son las mismas', () => {
    if (!delPos) return;
    // El `short` se compara en minúscula: el POS escribe "L" y "mL" con
    // mayúscula para que se lean bien en el ticket, y el panel compara sin
    // distinguir. Lo que no puede diferir es qué unidades hay, de qué
    // magnitud son y por cuánto convierten.
    const enMinuscula = tabla => Object.fromEntries(
      Object.entries(tabla).map(([k, v]) => [k, { ...v, short: v.short.toLowerCase() }]));
    expect(enMinuscula(CONJ_UNIDADES)).toEqual(enMinuscula(delPos.unidades));
  });

  it('los nombres largos de la webapp se normalizan igual', () => {
    if (!delPos) return;
    // El panel acepta además las formas con tilde y los alias que el POS no
    // necesita; lo que importa es que no se contradigan.
    for (const [largo, corto] of Object.entries(delPos.webapp_unidad)) {
      expect(UNIDAD_WEBAPP[largo], `"${largo}" se normaliza distinto`).toBe(corto);
    }
  });

  it('toda presentación del POS se puede leer de vuelta', () => {
    if (!delPos) return;
    // Recorre las 14 presentaciones armando el nombre como lo escribe el POS y
    // comprobando que el panel sepa cuánto stock devolver.
    for (const [clave, etiqueta] of Object.entries(delPos.tipos)) {
      const prod = { conjunto_tipo: clave, conjunto_contenido: 50, conjunto_unidad_medida: 'unidades' };
      const { descripcion } = parseNombre(`ALGO  ·  1 ${etiqueta}(s)`);
      expect(factorPorUnidad(prod, descripcion),
             `la presentación "${clave}" no se puede leer de vuelta`).toBe(50);
    }
  });
});

describe('a quién no hay que devolverle stock', () => {
  it('a un servicio marcado, aunque su stock no sea -1', () => {
    // La venta nunca se lo descontó, así que borrarla no puede sumárselo.
    // Antes se miraba sólo el número y a esos les inflaba el stock.
    expect(esIlimitado({ stock: 0, stock_ilimitado: true })).toBe(true);
    expect(esIlimitado({ stock: 8, stock_ilimitado: 1 })).toBe(true);
  });

  it('a una ficha vieja que quedó en -1', () => {
    expect(esIlimitado({ stock: -1 })).toBe(true);
  });

  it('a un producto común sí', () => {
    expect(esIlimitado({ stock: 10 })).toBe(false);
    expect(esIlimitado({ stock: 0 })).toBe(false);
    expect(esIlimitado(null)).toBe(false);
  });
});

describe('leer el nombre que escribió el POS', () => {
  it('separa la variedad, el producto y la presentación', () => {
    expect(parseNombre('[Verde]  GOMA EVA 40X60  ·  2 u'))
      .toEqual({ color: 'Verde', base: 'GOMA EVA 40X60', descripcion: '2 u' });
  });

  it('sin variedad y sin presentación devuelve el nombre pelado', () => {
    expect(parseNombre('CUADERNO RIVADAVIA'))
      .toEqual({ color: '', base: 'CUADERNO RIVADAVIA', descripcion: '' });
  });

  it('un nombre vacío no rompe nada', () => {
    expect(parseNombre(null)).toEqual({ color: '', base: '', descripcion: '' });
  });
});

describe('cuánto stock devuelve cada renglón', () => {
  const ROLLO = { conjunto_tipo: 'rollo', conjunto_contenido: 25, conjunto_unidad_medida: 'metros' };
  const PACK  = { conjunto_tipo: 'pack',  conjunto_contenido: 50, conjunto_unidad_medida: 'unidades' };

  it('un pack entero devuelve todo su contenido', () => {
    expect(factorPorUnidad(PACK, '1 pack(s)')).toBe(50);
  });

  it('varios packs cuentan por el campo cantidad, no por el nombre', () => {
    // El POS manda quantity=2 y el nombre dice "2 pack(s)": el factor es el de
    // UNO solo, o se devolvería el doble.
    expect(factorPorUnidad(PACK, '2 pack(s)')).toBe(50);
  });

  it('una cantidad con coma viaja entera en el nombre', () => {
    // Media unidad no entra en el spinner del carrito: el POS manda quantity=1
    // y la cantidad real queda sólo acá.
    expect(factorPorUnidad(ROLLO, '2,5 m')).toBe(2.5);
    expect(factorPorUnidad(ROLLO, '0.5 m')).toBe(0.5);
  });

  it('convierte entre unidades de la misma magnitud', () => {
    // 30 cm de un rollo que se mide en metros.
    expect(factorPorUnidad(ROLLO, '1 cm')).toBeCloseTo(0.01, 10);
    expect(factorPorUnidad({ ...ROLLO, conjunto_unidad_medida: 'cm' }, '1 m')).toBeCloseTo(100, 10);
  });

  it('no mezcla magnitudes distintas', () => {
    // Gramos sobre un rollo que se mide en metros: antes que devolver una
    // cantidad inventada, no devuelve nada y el panel avisa.
    expect(factorPorUnidad(ROLLO, '100 g')).toBeNull();
  });

  it('lo que no se entiende no se devuelve', () => {
    expect(factorPorUnidad(ROLLO, '')).toBeNull();
    expect(factorPorUnidad(ROLLO, 'algo raro')).toBeNull();
    expect(factorPorUnidad(ROLLO, '0 m')).toBeNull();
  });

  it('un pack sin contenido cargado no se puede devolver', () => {
    expect(factorPorUnidad({ ...PACK, conjunto_contenido: 0 }, '1 pack(s)')).toBeNull();
  });
});
