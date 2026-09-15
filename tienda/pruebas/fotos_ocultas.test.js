/**
 * Fotos pedidas: lo que se oculta de "Les falta la foto".
 *
 * Hay productos a los que no se les va a sacar nunca una foto, y con ellos en
 * la lista los que sí importan quedaban perdidos entre doscientos renglones.
 * Ocultarlos es una decisión del local, no del producto: vive en un documento
 * aparte (`config/fotos_ocultas`, un campo por producto) y no toca ni el
 * catálogo ni la tienda.
 *
 * Lo delicado es que la pantalla se entera en vivo de lo que ocultan otras
 * pestañas, y la base contesta un rato después de cada click: sin cuidar eso,
 * un "Deshacer" rápido hacía que el renglón se fuera, volviera y se fuera de
 * nuevo a medida que llegaban las copias viejas.
 */
import { describe, it, expect } from 'vitest';
import {
  ocultosDelDoc, separarOcultos, cambioOcultar, cambioMostrar, diferencias,
  reconciliar, GRACIA_PENDIENTE_MS,
} from '../../webapp/src/fotos_ocultas.js';
import { armarEscrituras } from '../../webapp/src/tienda_espejo.js';

const fila = (id, nombre = id) => ({ id, nombre });

describe('ocultosDelDoc', () => {
  it('sin documento no hay nada oculto', () => {
    expect(ocultosDelDoc(null).size).toBe(0);
    expect(ocultosDelDoc(undefined).size).toBe(0);
    expect(ocultosDelDoc({}).size).toBe(0);
  });

  it('cada campo es un producto, con su nombre y cuándo se ocultó', () => {
    const cuando = new Date('2026-09-15T13:20:00Z');
    const m = ocultosDelDoc({ '190500000047': { nombre: 'BANDERA', oculto_en: cuando } });

    expect([...m.keys()]).toEqual(['190500000047']);
    expect(m.get('190500000047')).toEqual({ nombre: 'BANDERA', oculto_en: cuando });
  });

  it('entiende la fecha como Timestamp del SDK', () => {
    const cuando = new Date('2026-09-15T13:20:00Z');
    const m = ocultosDelDoc({ p1: { nombre: 'X', oculto_en: { toDate: () => cuando } } });
    expect(m.get('p1').oculto_en).toEqual(cuando);
  });

  it('un campo que no tiene la forma no oculta nada', () => {
    const m = ocultosDelDoc({ p1: null, p2: 'si', p3: { nombre: 'OK' } });
    expect([...m.keys()]).toEqual(['p3']);
    expect(m.get('p3').oculto_en).toBe(null);
  });
});

describe('separarOcultos', () => {
  it('reparte sin cambiar el orden de lo que queda visible', () => {
    const filas = [fila('a'), fila('b'), fila('c'), fila('d')];
    const ocultos = new Map([['b', { nombre: 'b', oculto_en: null }]]);

    const { visibles, ocultas } = separarOcultos(filas, ocultos);
    expect(visibles.map(f => f.id)).toEqual(['a', 'c', 'd']);
    expect(ocultas.map(f => f.id)).toEqual(['b']);
  });

  it('los ocultos van del más reciente al más viejo: el último que se ocultó arriba', () => {
    const filas = [fila('a'), fila('b'), fila('c')];
    const ocultos = new Map([
      ['a', { nombre: 'a', oculto_en: new Date('2026-09-10') }],
      ['b', { nombre: 'b', oculto_en: null }],
      ['c', { nombre: 'c', oculto_en: new Date('2026-09-15') }],
    ]);

    expect(separarOcultos(filas, ocultos).ocultas.map(f => f.id)).toEqual(['c', 'a', 'b']);
  });

  it('lo oculto que ya no le falta la foto no aparece en ninguna de las dos', () => {
    const ocultos = new Map([['ya-tiene', { nombre: 'x', oculto_en: null }]]);
    const { visibles, ocultas } = separarOcultos([fila('a')], ocultos);
    expect(visibles.map(f => f.id)).toEqual(['a']);
    expect(ocultas).toEqual([]);
  });
});

describe('lo que se escribe', () => {
  it('ocultar escribe un solo campo, el del producto', () => {
    const cuando = new Date('2026-09-15T13:20:00Z');
    expect(cambioOcultar({ id: 'p1', nombre: 'TIJERA' }, cuando))
      .toEqual({ p1: { nombre: 'TIJERA', oculto_en: cuando } });
  });

  it('mostrar borra ese campo y nada más', () => {
    expect(cambioMostrar('p1')).toEqual({ p1: undefined });
  });

  it('por REST la máscara lleva solo ese producto: dos pestañas no se pisan', () => {
    const cuando = new Date('2026-09-15T13:20:00Z');
    const [ocultar] = armarEscrituras([{
      tipo: 'actualizar', col: 'config', id: 'fotos_ocultas', crearSiFalta: true,
      datos: cambioOcultar({ id: '190500000047', nombre: 'BANDERA' }, cuando),
    }]);
    // Un código que empieza con número va entre acentos graves en la máscara.
    expect(ocultar.updateMask.fieldPaths).toEqual(['`190500000047`']);
    expect(Object.keys(ocultar.update.fields)).toEqual(['190500000047']);
    // El documento se crea con el primer oculto.
    expect(ocultar.currentDocument).toBeUndefined();

    const [mostrar] = armarEscrituras([{
      tipo: 'actualizar', col: 'config', id: 'fotos_ocultas', crearSiFalta: true,
      datos: cambioMostrar('190500000047'),
    }]);
    expect(mostrar.updateMask.fieldPaths).toEqual(['`190500000047`']);
    expect(mostrar.update.fields).toEqual({});
  });
});

describe('diferencias', () => {
  it('dice qué se ocultó y qué volvió', () => {
    const antes = new Map([['a', {}], ['b', {}]]);
    const despues = new Map([['b', {}], ['c', {}]]);
    expect(diferencias(antes, despues)).toEqual({ ocultados: ['c'], mostrados: ['a'] });
  });

  it('sin cambios, las dos listas vacías', () => {
    const m = new Map([['a', {}]]);
    expect(diferencias(m, new Map(m))).toEqual({ ocultados: [], mostrados: [] });
  });
});

describe('reconciliar lo que dice la base con lo que se acaba de tocar', () => {
  const entrada = { nombre: 'TIJERA', oculto_en: new Date('2026-09-15T13:20:00Z') };
  const AHORA = 1_000_000;

  it('sin nada pendiente manda la base', () => {
    const servidor = new Map([['a', entrada]]);
    const { efectivo, resueltos } = reconciliar(servidor, new Map(), AHORA);
    expect([...efectivo.keys()]).toEqual(['a']);
    expect(resueltos).toEqual([]);
  });

  it('recién ocultado y la base todavía no se enteró: sigue oculto', () => {
    const pendientes = new Map([['p1', { entrada, guardadoEn: null }]]);
    const { efectivo, resueltos } = reconciliar(new Map(), pendientes, AHORA);
    expect(efectivo.get('p1')).toBe(entrada);
    expect(resueltos).toEqual([]);
  });

  it('recién mostrado y llega una copia vieja que lo tenía oculto: sigue a la vista', () => {
    const servidor = new Map([['p1', entrada]]);
    const pendientes = new Map([['p1', { entrada: null, guardadoEn: AHORA - 500 }]]);
    const { efectivo } = reconciliar(servidor, pendientes, AHORA);
    expect(efectivo.has('p1')).toBe(false);
  });

  it('cuando la base confirma, deja de estar pendiente', () => {
    const servidor = new Map([['p1', entrada]]);
    const pendientes = new Map([['p1', { entrada, guardadoEn: AHORA - 200 }]]);
    const { efectivo, resueltos } = reconciliar(servidor, pendientes, AHORA);
    expect(efectivo.has('p1')).toBe(true);
    expect(resueltos).toEqual(['p1']);
  });

  it('guardado hace rato y la base dice otra cosa: la cambió otra pestaña, manda la base', () => {
    const pendientes = new Map([['p1', { entrada, guardadoEn: AHORA - GRACIA_PENDIENTE_MS - 1 }]]);
    const { efectivo, resueltos } = reconciliar(new Map(), pendientes, AHORA);
    expect(efectivo.has('p1')).toBe(false);
    expect(resueltos).toEqual(['p1']);
  });

  it('todavía guardándose no vence nunca, por más que tarde', () => {
    const pendientes = new Map([['p1', { entrada, guardadoEn: null }]]);
    const { efectivo, resueltos } = reconciliar(new Map(), pendientes, AHORA * 50);
    expect(efectivo.has('p1')).toBe(true);
    expect(resueltos).toEqual([]);
  });

  it('no modifica los mapas que recibe', () => {
    const servidor = new Map([['a', entrada]]);
    const pendientes = new Map([['a', { entrada: null, guardadoEn: null }]]);
    reconciliar(servidor, pendientes, AHORA);
    expect(servidor.has('a')).toBe(true);
    expect(pendientes.has('a')).toBe(true);
  });
});
