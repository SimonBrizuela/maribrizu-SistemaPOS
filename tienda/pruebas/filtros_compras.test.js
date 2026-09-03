/**
 * Los filtros de la lista del Centro de Compras.
 *
 * `webapp/src/filtros_compras.js` no toca el DOM: recibe los renglones de la
 * lista y los criterios (selects, lupa, cuaderno) y dice qué pasa y qué
 * opciones ofrece cada select. Acá se fija que los filtros se combinen en Y,
 * que "LIBRERÍA" y "LIBRERIA" sean el mismo rubro, que la lupa busque adentro
 * de lo filtrado con las palabras en cualquier orden, y que las cuentas de
 * cada opción digan cuánto quedaría al elegirla.
 */
import { describe, it, expect } from 'vitest';
import {
  SIN_VALOR, claveFiltro, filtrosVacios, sanearFiltros, cantidadFiltros,
  coincideCompra, opcionesCompras, campoTieneValores, textoBusquedaCompra,
} from '../../webapp/src/filtros_compras.js';

const fila = (over = {}) => {
  const r = {
    nombre: 'GOMA DE BORRAR', codigo: 'G01', rubro: 'LIBRERIA', sub_rubro: 'ESCRITURA',
    proveedor: 'DISTRI SUR', marca: 'MAPED', tier: 'sisi', esVariedad: false, variedad: null,
    anotado: null, registrado: false, producto: null, ...over,
  };
  r.busca = textoBusquedaCompra(r);
  return r;
};

const LISTA = [
  fila(),
  fila({ nombre: 'LAPIZ NEGRO', codigo: 'L01', rubro: 'LIBRERÍA', sub_rubro: 'Escritura', proveedor: 'PAPELERA CBA', marca: 'FABER', tier: 'importante' }),
  fila({ nombre: 'RESMA A4', codigo: 'R01', rubro: 'PAPELERIA', sub_rubro: 'RESMAS', proveedor: 'PAPELERA CBA', marca: '', tier: 'opcional', anotado: '2026-09-01' }),
  fila({ nombre: 'BOTON COCO', codigo: 'B01', rubro: 'MERCERIA', sub_rubro: '', proveedor: '', marca: '', tier: 'sisi' }),
];

const crit = (filtros = {}, extra = {}) => ({ filtros: { ...filtrosVacios(), ...filtros }, busqueda: '', soloAnotados: false, ...extra });

describe('la clave de comparación', () => {
  it('ignora acentos, mayúsculas y espacios de más', () => {
    expect(claveFiltro('  LIBRERÍA ')).toBe('libreria');
    expect(claveFiltro('Papelera   CBA')).toBe('papelera cba');
    expect(claveFiltro(null)).toBe('');
  });
});

describe('qué renglón pasa', () => {
  it('sin criterios pasa todo', () => {
    expect(LISTA.every(r => coincideCompra(r, crit()))).toBe(true);
  });

  it('el rubro con y sin tilde es el mismo rubro', () => {
    const c = crit({ rubro: 'libreria' });
    expect(LISTA.filter(r => coincideCompra(r, c)).map(r => r.nombre)).toEqual(['GOMA DE BORRAR', 'LAPIZ NEGRO']);
  });

  it('los filtros se combinan en Y', () => {
    const c = crit({ rubro: 'libreria', proveedor: 'papelera cba' });
    expect(LISTA.filter(r => coincideCompra(r, c)).map(r => r.nombre)).toEqual(['LAPIZ NEGRO']);
  });

  it('se puede pedir lo que no tiene proveedor cargado', () => {
    const c = crit({ proveedor: SIN_VALOR });
    expect(LISTA.filter(r => coincideCompra(r, c)).map(r => r.nombre)).toEqual(['BOTON COCO']);
  });

  it('el nivel filtra por la prioridad calculada', () => {
    const c = crit({ nivel: 'sisi' });
    expect(LISTA.filter(r => coincideCompra(r, c)).map(r => r.nombre)).toEqual(['GOMA DE BORRAR', 'BOTON COCO']);
  });

  it('la lupa busca adentro de lo filtrado, con las palabras en cualquier orden', () => {
    const c = crit({ proveedor: 'papelera cba' }, { busqueda: 'negro lápiz' });
    expect(LISTA.filter(r => coincideCompra(r, c)).map(r => r.nombre)).toEqual(['LAPIZ NEGRO']);
    // "resma" está en el proveedor filtrado; "goma" no.
    expect(LISTA.filter(r => coincideCompra(r, crit({ proveedor: 'papelera cba' }, { busqueda: 'goma' })))).toEqual([]);
  });

  it('la lupa también encuentra por proveedor, marca y código', () => {
    expect(LISTA.filter(r => coincideCompra(r, crit({}, { busqueda: 'faber' }))).map(r => r.nombre)).toEqual(['LAPIZ NEGRO']);
    expect(LISTA.filter(r => coincideCompra(r, crit({}, { busqueda: 'papelera' }))).length).toBe(2);
    expect(LISTA.filter(r => coincideCompra(r, crit({}, { busqueda: 'b01' }))).map(r => r.nombre)).toEqual(['BOTON COCO']);
  });

  it('el cuaderno se combina con los selects', () => {
    const c = crit({}, { soloAnotados: true });
    expect(LISTA.filter(r => coincideCompra(r, c)).map(r => r.nombre)).toEqual(['RESMA A4']);
    expect(LISTA.filter(r => coincideCompra(r, crit({ rubro: 'libreria' }, { soloAnotados: true })))).toEqual([]);
  });

  it('ignorar un campo lo saca de la evaluación (para armar sus opciones)', () => {
    const c = crit({ rubro: 'papeleria', proveedor: 'distri sur' });
    expect(LISTA.filter(r => coincideCompra(r, c))).toEqual([]);
    expect(LISTA.filter(r => coincideCompra(r, c, 'proveedor')).map(r => r.nombre)).toEqual(['RESMA A4']);
  });
});

describe('las opciones de cada select', () => {
  it('cuentan lo que quedaría al elegirlas y juntan las variantes de escritura', () => {
    const ops = opcionesCompras(LISTA, crit(), 'rubro');
    expect(ops.map(o => [o.valor, o.n])).toEqual([['libreria', 2], ['merceria', 1], ['papeleria', 1]]);
    // "LIBRERIA" y "LIBRERÍA" aparecen una vez cada una: gana la primera por orden alfabético.
    expect(['LIBRERIA', 'LIBRERÍA']).toContain(ops[0].label);
  });

  it('la etiqueta es la variante más usada', () => {
    const lista = [fila({ rubro: 'Librería' }), fila({ rubro: 'LIBRERIA' }), fila({ rubro: 'LIBRERIA' })];
    expect(opcionesCompras(lista, crit(), 'rubro')[0].label).toBe('LIBRERIA');
  });

  it('responden a los otros criterios: el proveedor solo ofrece los del rubro elegido', () => {
    const ops = opcionesCompras(LISTA, crit({ rubro: 'papeleria' }), 'proveedor');
    expect(ops.map(o => [o.valor, o.n])).toEqual([['papelera cba', 1]]);
  });

  it('responden a la lupa', () => {
    const ops = opcionesCompras(LISTA, crit({}, { busqueda: 'goma' }), 'proveedor');
    expect(ops.map(o => [o.valor, o.n])).toEqual([['distri sur', 1]]);
  });

  it('lo que no tiene valor va al final como "Sin ..."', () => {
    const ops = opcionesCompras(LISTA, crit(), 'proveedor');
    expect(ops.at(-1)).toEqual({ valor: SIN_VALOR, label: 'Sin proveedor', n: 1 });
    expect(opcionesCompras(LISTA, crit(), 'marca').at(-1)).toMatchObject({ valor: SIN_VALOR, label: 'Sin marca', n: 2 });
  });

  it('el elegido se mantiene aunque quede en cero, para poder sacarlo', () => {
    const ops = opcionesCompras(LISTA, crit({ rubro: 'papeleria', proveedor: 'distri sur' }), 'proveedor');
    expect(ops.map(o => [o.valor, o.n])).toEqual([['distri sur', 0], ['papelera cba', 1]]);
  });

  it('el nivel va en orden de prioridad con su nombre', () => {
    const ops = opcionesCompras(LISTA, crit(), 'nivel');
    expect(ops.map(o => [o.valor, o.label, o.n])).toEqual([
      ['sisi', 'Sí o sí', 2], ['importante', 'Importante', 1], ['opcional', 'Puede esperar', 1],
    ]);
  });

  it('un campo sin valores en toda la lista no se ofrece', () => {
    expect(campoTieneValores(LISTA, 'marca')).toBe(true);
    expect(campoTieneValores([fila({ marca: '' })], 'marca')).toBe(false);
    expect(campoTieneValores([], 'rubro')).toBe(true);
  });
});

describe('lo que vuelve del storage', () => {
  it('se limpia a los campos conocidos', () => {
    expect(sanearFiltros({ rubro: ' libreria ', nivel: 'sisi', otro: 'x', marca: 3 }))
      .toEqual({ rubro: 'libreria', sub_rubro: '', proveedor: '', marca: '', nivel: 'sisi' });
    expect(sanearFiltros('basura')).toEqual(filtrosVacios());
    expect(cantidadFiltros({ rubro: 'a', marca: '' })).toBe(1);
  });
});
