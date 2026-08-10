/**
 * El buscador.
 *
 * Los casos de abajo no son inventados: son los que estuvieron rotos en
 * produccion y los que devolvian basura. Cada uno vale como prueba porque ya
 * fallo una vez.
 */
import { describe, it, expect, vi } from 'vitest';
import { despiezar, VACIAS } from '../src/formato.js';

vi.mock('../src/firebase.js', () => ({ db: {} }));
const { anclasDe, mejores } = await import('../src/datos.js');

/** Un producto como lo indexa el sync: tokens sin conectores. */
function producto(nombre, { stock = 5, tokens = null } = {}) {
  return {
    nombre,
    stock,
    tokens: tokens ?? despiezar(nombre),
  };
}

describe('despiezar', () => {
  it('descarta los conectores, igual que el indice del sync', () => {
    expect(despiezar('goma de borrar')).toEqual(['goma', 'borrar']);
    expect(despiezar('papel para forrar')).toEqual(['papel', 'forrar']);
    expect(despiezar('block con hojas y tapa')).toEqual(['block', 'hojas', 'tapa']);
  });

  it('corta por caracter no alfanumerico, no por espacio', () => {
    // El sync hace lo mismo: "2,5cm" queda como el token "5cm".
    expect(despiezar('cinta 2,5cm')).toEqual(['cinta', '5cm']);
    expect(despiezar('lapiz-color/12')).toEqual(['lapiz', 'color', '12']);
  });

  it('ignora acentos y mayusculas', () => {
    expect(despiezar('BOLÍGRAFO Azul')).toEqual(['boligrafo', 'azul']);
  });

  it('descarta las letras sueltas y devuelve vacio si no queda nada', () => {
    expect(despiezar('a de la')).toEqual([]);
    expect(despiezar('   ')).toEqual([]);
    expect(despiezar(null)).toEqual([]);
  });

  it('acepta palabras de mas para quien las necesite', () => {
    // El asistente le suma las de conversacion; la tienda usa solo las del indice.
    expect(despiezar('hola tenes cartulina', new Set(['hola', 'tenes']))).toEqual(['cartulina']);
    expect(VACIAS.has('de')).toBe(true);
    expect(VACIAS.has('no')).toBe(false);
  });
});

describe('anclasDe', () => {
  it('pregunta primero por la palabra mas larga, que es la mas distintiva', () => {
    expect(anclasDe(['cuaderno', 'rivadavia'])[0]).toBe('rivadavia');
  });

  it('prueba hasta tres, por si el cliente escribio una palabra que no existe', () => {
    // "tijera para chicos": "chicos" no esta en ningun producto, "tijera" si.
    expect(anclasDe(['tijera', 'chicos'])).toEqual(expect.arrayContaining(['tijera', 'chicos']));
    // Con una palabra inventada mas larga adelante, la buena sigue estando.
    expect(anclasDe(['tijera', 'escolares'])).toEqual(['escolares', 'tijera']);
    expect(anclasDe(['aa', 'bbb', 'cccc', 'ddddd', 'eeeeee'])).toHaveLength(3);
  });

  it('deja afuera las de dos letras mientras haya algo mas largo', () => {
    // Con "no" como ancla, "zzzz no existe" devolvia "Abrochadora Kangaro No.
    // 384556": peor que no devolver nada.
    expect(anclasDe(['zzzz', 'no', 'existe'])).not.toContain('no');
  });

  it('usa la corta igual si es lo unico que hay', () => {
    expect(anclasDe(['a4'])).toEqual(['a4']);
  });
});

describe('mejores', () => {
  it('se queda con lo que cumple mas palabras y descarta lo parcial', () => {
    const palabras = ['cuaderno', 'rivadavia', 'abc'];
    const lista = [
      producto('Cuaderno Rivadavia ABC A4 Tapa Dura'),
      producto('Cuaderno Rivadavia Monitor'),
      producto('Cuaderno Gloria'),
    ];
    const salida = mejores(lista, palabras, 'rivadavia');
    expect(salida.map(p => p.nombre)).toEqual(['Cuaderno Rivadavia ABC A4 Tapa Dura']);
  });

  it('devuelve el mejor parcial antes que nada', () => {
    // El color vive en las variedades, no en el nombre: exigir las tres
    // palabras devolvia cero con el producto en el catalogo y con stock.
    const salida = mejores(
      [producto('Cartulina Luma Comun'), producto('Cartulina Fantasia')],
      ['cartulina', 'luma', 'celeste'], 'cartulina');
    expect(salida.map(p => p.nombre)).toEqual(['Cartulina Luma Comun']);
  });

  it('pone primero lo que hay en stock', () => {
    const salida = mejores(
      [producto('Goma Borrar Maped', { stock: 0 }), producto('Goma Borrar Faber')],
      ['goma', 'borrar'], 'borrar');
    expect(salida[0].nombre).toBe('Goma Borrar Faber');
  });

  it('pone antes lo que empieza con lo buscado', () => {
    // Buscando "mochila", "Hebilla para Mochila" no puede ir primero.
    const salida = mejores(
      [producto('Hebilla para Mochila'), producto('Mochila Escolar')],
      ['mochila'], 'mochila');
    expect(salida[0].nombre).toBe('Mochila Escolar');
  });

  it('no rompe con la lista vacia', () => {
    expect(mejores([], ['algo'], 'algo')).toEqual([]);
  });
});
