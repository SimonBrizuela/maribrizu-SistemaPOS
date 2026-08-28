/**
 * Qué productos aparecen en "hay que reponer".
 *
 * Es la lista que el local mira para decidir qué comprar. Los dos errores que
 * cuestan plata son opuestos y los dos silenciosos:
 *
 *   · avisar de más (servicios, insumos que se descuentan solos, variedades
 *     que en realidad tienen stock) y la lista se vuelve ruido que nadie mira;
 *   · avisar de menos, y el producto se agota en la góndola sin que salte nada.
 *
 * `_alertasProducto` es la que decide. Vive en `webapp/src/notifications.js` y
 * hasta acá no tenía ninguna prueba.
 */
import { describe, it, expect, vi } from 'vitest';

// El módulo abre Firestore al importarse; acá sólo interesa la decisión.
vi.mock('firebase/firestore', async () => (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {} }));
vi.mock('../../webapp/src/cache.js', () => ({ getCached: async (_k, fn) => fn() }));

const { _alertasProducto } = await import('../../webapp/src/notifications.js');

const producto = (extra = {}) => ({
  doc_id: 'p1', nombre: 'CUADERNO RIVADAVIA', codigo: 'C1',
  rubro: 'LIBRERIA', stock: 10, ...extra,
});

describe('lo que no se repone nunca', () => {
  it('un servicio marcado como tal', () => {
    // El que se descuenta solo no se compra: se compra su insumo. Antes se
    // miraba únicamente el número -1, así que un servicio marcado con stock 0
    // aparecía igual en la lista. Medidos 10 así en el catálogo.
    expect(_alertasProducto(producto({ stock: 0, stock_min: 5, stock_ilimitado: true })))
      .toEqual([]);
    expect(_alertasProducto(producto({ stock: 0, stock_min: 5, stock_ilimitado: 1 })))
      .toEqual([]);
  });

  it('una ficha vieja que quedó en -1 sin migrar', () => {
    expect(_alertasProducto(producto({ stock: -1, stock_min: 5 }))).toEqual([]);
  });

  it('un producto que consume a otro al venderse', () => {
    // "Impresión A3" descuenta del papel: lo que se repone es el papel.
    const vinculado = producto({
      nombre: 'IMPRESION A3', stock: 0, stock_min: 10,
      vinculaciones: [{ doc_id: 'papel', cantidad: 1 }],
    });
    expect(_alertasProducto(vinculado)).toEqual([]);
  });

  it('un servicio reconocido por el nombre', () => {
    for (const nombre of ['FOTOCOPIA A4', 'PLASTIFICADO', 'ANILLADO CHICO', 'ESCANEO']) {
      expect(_alertasProducto(producto({ nombre, stock: 0, stock_min: 5 })), nombre).toEqual([]);
    }
  });

  it('pero el insumo del servicio SI se repone', () => {
    // "Hoja para fotocopias" nombra el servicio y no es uno: es lo que se compra.
    for (const nombre of ['HOJA PARA FOTOCOPIAS A4', 'RESMA PARA IMPRESION', 'PAPEL FOTOCOPIA']) {
      const avisos = _alertasProducto(producto({ nombre, stock: 2, stock_min: 5 }));
      expect(avisos.length, nombre).toBe(1);
    }
  });

  it('un producto sin mínimo configurado y con stock no molesta', () => {
    expect(_alertasProducto(producto({ stock: 40 }))).toEqual([]);
  });

  it('con stock por encima del mínimo tampoco', () => {
    expect(_alertasProducto(producto({ stock: 40, stock_min: 10 }))).toEqual([]);
  });
});

describe('el aviso del producto', () => {
  it('salta al llegar al mínimo, no después', () => {
    expect(_alertasProducto(producto({ stock: 10, stock_min: 10 })).length).toBe(1);
    expect(_alertasProducto(producto({ stock: 11, stock_min: 10 })).length).toBe(0);
  });

  it('en cero es crítico', () => {
    const [a] = _alertasProducto(producto({ stock: 0, stock_min: 5 }));
    expect(a.critico).toBe(true);
  });

  it('con algo todavía no es crítico', () => {
    const [a] = _alertasProducto(producto({ stock: 3, stock_min: 5 }));
    expect(a.critico).toBe(false);
  });

  it('sugiere cuánto comprar para llegar al máximo', () => {
    const [a] = _alertasProducto(producto({ stock: 4, stock_min: 10, stock_max: 30 }));
    expect(a.sugerencia).toBe(26);
  });

  it('sin máximo no inventa una sugerencia', () => {
    const [a] = _alertasProducto(producto({ stock: 4, stock_min: 10 }));
    expect(a.sugerencia).toBeNull();
  });

  it('lleva el código y el rubro para poder buscarlo', () => {
    const [a] = _alertasProducto(producto({ stock: 1, stock_min: 5, marca: 'RIVADAVIA' }));
    expect(a).toMatchObject({ doc_id: 'p1', codigo: 'C1', rubro: 'LIBRERIA', marca: 'RIVADAVIA' });
  });
});

describe('el aviso contado en cajas', () => {
  const enCajas = (extra) => producto({
    nombre: 'LAPIZ NEGRO CAJA X 12', stock_alerta_um: 'bulto', ...extra,
  });

  it('dice cuántas cajas quedan y cuántas es el mínimo', () => {
    const [a] = _alertasProducto(enCajas({ stock: 29, stock_min: 36 }));
    expect(a.stock_texto).toBe('2 cajas + 5 u');
    expect(a.min_texto).toBe('3 cajas');
  });

  it('sin el interruptor, el aviso va en unidades pero muestra la equivalencia', () => {
    const [a] = _alertasProducto(producto({
      nombre: 'LAPIZ NEGRO CAJA X 12', stock: 18, stock_min: 20,
    }));
    expect(a.stock_texto).toBeNull();
    expect(a.stock_equiv).toBe('1 caja + 6 u');
  });

  it('menos de una caja no agrega una equivalencia que no dice nada', () => {
    const [a] = _alertasProducto(producto({
      nombre: 'LAPIZ NEGRO CAJA X 12', stock: 5, stock_min: 20,
    }));
    expect(a.stock_equiv).toBeNull();
  });
});

describe('el aviso por variedad', () => {
  const conColores = (colores, extra = {}) => producto({
    nombre: 'CARTULINA LUMA', stock: 0, es_conjunto: true,
    conjunto_contenido: 50, conjunto_colores: colores, ...extra,
  });

  it('una variedad con mínimo propio avisa sola', () => {
    const avisos = _alertasProducto(conColores([
      { color: 'Rojo', unidades: 0, restante: 4, stock_min: 1 },
      { color: 'Azul', unidades: 6, restante: 0, stock_min: 1 },
    ]));
    expect(avisos.map(a => a.variedad)).toEqual(['Rojo']);
  });

  it('un pack abierto no es una variedad agotada', () => {
    // 0 packs cerrados y 15 sueltas son 15, no cero. Mirar sólo el contador de
    // packs marcaba como agotado lo que estaba a mitad de camino.
    const avisos = _alertasProducto(conColores([
      { color: 'Rojo', unidades: 0, restante: 15 },
    ]));
    expect(avisos).toEqual([]);
  });

  it('con dos sueltas o menos avisa sin que nadie configure nada', () => {
    const avisos = _alertasProducto(conColores([
      { color: 'Rojo', unidades: 0, restante: 2 },
      { color: 'Azul', unidades: 3, restante: 0 },
    ]));
    expect(avisos.map(a => a.variedad)).toEqual(['Rojo']);
    expect(avisos[0].auto).toBe(true);
  });

  it('la variedad puede venir en otra presentación que el producto', () => {
    // Los azules por caja de 50 y los violetas por caja de 12: cada una cuenta
    // con SU contenido.
    const avisos = _alertasProducto(conColores([
      { color: 'Azul', unidades: 2, restante: 0 },
      { color: 'Violeta', unidades: 0, restante: 2, contenido: 12 },
    ]));
    expect(avisos.map(a => a.variedad)).toEqual(['Violeta']);
  });

  it('el mínimo en packs se compara en packs', () => {
    // 90 unidades de un pack de 100 son 0,9 packs: sigue por debajo de "1 pack".
    const avisos = _alertasProducto(conColores([
      { color: 'Rojo', unidades: 0, restante: 90, stock_min: 1, stock_min_um: 'pack' },
    ], { conjunto_contenido: 100 }));
    expect(avisos.length).toBe(1);
    // Y se aclara cuántas unidades hay, para que no parezca un "sin stock" falso.
    expect(avisos[0].stock_equiv).toContain('90');
    expect(avisos[0].critico).toBe(false);
  });
});
