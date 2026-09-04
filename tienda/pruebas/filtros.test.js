/**
 * El orden de las pastillas de filtro del catálogo.
 *
 * El sync manda los rubros por facturación y los subrubros por cantidad; en la
 * fila de filtros todo sale de la A a la Z. Acá se prueba la lógica pura de
 * tienda/src/filtros.js: el orden, qué queda a la vista cuando hay panel, y
 * que el elegido nunca se pierda.
 */
import { describe, it, expect } from 'vitest';
import { ordenarAz, filaDeSubrubros } from '../src/filtros.js';

const sub = (nombre, cantidad) => ({ nombre, clave: nombre.toLowerCase(), cantidad });
const nombres = lista => lista.map(s => s.nombre);

describe('ordenarAz', () => {
  it('ordena por nombre de la A a la Z sin que pesen la tilde ni la mayúscula', () => {
    const lista = [
      sub('Pilas', 31), sub('Lápices de Colores', 32), sub('adhesivo', 13),
      sub('Libros', 33), sub('Marcadores', 26), sub('Marcador', 15),
    ];
    expect(nombres(ordenarAz(lista))).toEqual([
      'adhesivo', 'Lápices de Colores', 'Libros', 'Marcador', 'Marcadores', 'Pilas',
    ]);
  });

  it('no toca la lista original', () => {
    const lista = [sub('Sobres', 25), sub('Block', 14)];
    ordenarAz(lista);
    expect(nombres(lista)).toEqual(['Sobres', 'Block']);
  });

  it('a los rubros no se les cuela el orden por facturación del sync', () => {
    const rubros = [
      { nombre: 'Librería', clave: 'LIBRERÍA' }, { nombre: 'Papelera', clave: 'PAPELERA' },
      { nombre: 'Lencería', clave: 'LENCERÍA' }, { nombre: 'Accesorios', clave: 'ACCESORIOS' },
      { nombre: 'Cotillón', clave: 'COTILLÓN' },
    ];
    expect(nombres(ordenarAz(rubros))).toEqual([
      'Accesorios', 'Cotillón', 'Lencería', 'Librería', 'Papelera',
    ]);
  });
});

describe('filaDeSubrubros', () => {
  const pocos = [sub('Tijeras', 12), sub('Adhesivo', 13), sub('Block', 14)];

  it('con pocos van todos a la fila, de la A a la Z, y no hay panel', () => {
    const fila = filaDeSubrubros(pocos, { aLaVista: 14 });
    expect(fila.hayPanel).toBe(false);
    expect(nombres(fila.visibles)).toEqual(['Adhesivo', 'Block', 'Tijeras']);
    expect(nombres(fila.todos)).toEqual(['Adhesivo', 'Block', 'Tijeras']);
  });

  const muchos = [
    sub('Cuadernos', 39), sub('Libros', 33), sub('Pilas', 31), sub('Sobres', 25),
    sub('Bolígrafo', 21), sub('Goma Borrar', 16), sub('Acuarela', 2), sub('Zócalo', 1),
  ];

  it('con muchos quedan a la vista los de más productos, pero de la A a la Z', () => {
    const fila = filaDeSubrubros(muchos, { aLaVista: 4 });
    expect(fila.hayPanel).toBe(true);
    expect(nombres(fila.visibles)).toEqual(['Cuadernos', 'Libros', 'Pilas', 'Sobres']);
  });

  it('no depende de que el sync los mande ordenados por cantidad', () => {
    const desordenados = muchos.slice().reverse();
    const fila = filaDeSubrubros(desordenados, { aLaVista: 4 });
    expect(nombres(fila.visibles)).toEqual(['Cuadernos', 'Libros', 'Pilas', 'Sobres']);
  });

  it('el panel lista todos de la A a la Z', () => {
    const fila = filaDeSubrubros(muchos, { aLaVista: 4 });
    expect(nombres(fila.todos)).toEqual([
      'Acuarela', 'Bolígrafo', 'Cuadernos', 'Goma Borrar', 'Libros', 'Pilas', 'Sobres', 'Zócalo',
    ]);
  });

  it('el elegido entra a la fila aunque tenga pocos productos, en su lugar alfabético', () => {
    const fila = filaDeSubrubros(muchos, { elegido: 'Acuarela', aLaVista: 4 });
    expect(nombres(fila.visibles)).toEqual(['Acuarela', 'Cuadernos', 'Libros', 'Pilas', 'Sobres']);
  });

  it('el elegido que ya estaba a la vista no se repite', () => {
    const fila = filaDeSubrubros(muchos, { elegido: 'Pilas', aLaVista: 4 });
    expect(nombres(fila.visibles)).toEqual(['Cuadernos', 'Libros', 'Pilas', 'Sobres']);
  });

  it('un elegido que no existe en el rubro no agrega nada', () => {
    const fila = filaDeSubrubros(muchos, { elegido: 'Fantasma', aLaVista: 4 });
    expect(nombres(fila.visibles)).toEqual(['Cuadernos', 'Libros', 'Pilas', 'Sobres']);
  });

  it('sin subrubros no hay fila ni panel', () => {
    const fila = filaDeSubrubros([]);
    expect(fila.hayPanel).toBe(false);
    expect(fila.visibles).toEqual([]);
    expect(fila.todos).toEqual([]);
  });
});
