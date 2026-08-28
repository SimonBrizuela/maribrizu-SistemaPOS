/**
 * Los filtros que comparten TODAS las pantallas del panel.
 *
 * `parseArDate`, `fechaDMYtoYMD` y los dos `isVarios2` los usan Cierres,
 * Historial, Resúmenes, Balance, Dashboard y Turnos. Una equivocación acá no
 * rompe una pantalla: corre los números de todas a la vez, y en la misma
 * dirección, así que ni siquiera se contradicen entre ellas. Por eso se prueban
 * aparte.
 *
 * "VARIOS 2" es el producto centinela de las facturas de AFIP: no es una venta
 * real y no puede sumar a la caja ni al historial.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase/firestore', async () => (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../../webapp/src/cache.js', () => ({
  getCached: async (_k, fn) => fn(), invalidateCache: () => {}, setCacheValue: () => {},
}));

const { parseArDate, fechaDMYtoYMD, isVentaVarios2, isItemVarios2 } =
  await import('../../webapp/src/config.js');

describe('leer la fecha venga como venga', () => {
  it('el texto que escribe el POS', () => {
    const d = parseArDate('2026-08-28 15:15:56');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);      // agosto
    expect(d.getDate()).toBe(28);
  });

  it('un Timestamp de Firestore', () => {
    const fijo = new Date('2026-08-28T18:15:56Z');
    expect(parseArDate({ toDate: () => fijo }).getTime()).toBe(fijo.getTime());
  });

  it('la forma cruda {seconds, nanoseconds}', () => {
    // Es como llega cuando el documento viaja serializado, sin el SDK adelante.
    const d = parseArDate({ seconds: 1756400156, nanoseconds: 500000000 });
    expect(d.getTime()).toBe(1756400156 * 1000 + 500);
  });

  it('sin fecha devuelve una fecha inválida, no el día de hoy', () => {
    // Inventar "hoy" mete la venta en el día equivocado y ahí no se nota nunca.
    expect(Number.isNaN(parseArDate(null).getTime())).toBe(true);
    expect(Number.isNaN(parseArDate('').getTime())).toBe(true);
    expect(Number.isNaN(parseArDate(undefined).getTime())).toBe(true);
  });
});

describe('pasar la fecha del POS al orden que se puede comparar', () => {
  it('"28/08/2026" queda "2026-08-28"', () => {
    expect(fechaDMYtoYMD('28/08/2026')).toBe('2026-08-28');
  });

  it('rellena el día y el mes de una cifra', () => {
    expect(fechaDMYtoYMD('8/9/2026')).toBe('2026-09-08');
  });

  it('ordena bien en el cambio de mes', () => {
    // El error que esto evita: como texto "30/04" es mayor que "02/05", y el
    // resumen por día ponía abril arriba de mayo.
    const abril = fechaDMYtoYMD('30/04/2026');
    const mayo = fechaDMYtoYMD('02/05/2026');
    expect(abril < mayo).toBe(true);
  });

  it('lo que ya viene en ISO se deja como está', () => {
    expect(fechaDMYtoYMD('2026-08-28')).toBe('2026-08-28');
  });

  it('lo que no es una fecha no rompe el filtro', () => {
    expect(fechaDMYtoYMD(null)).toBe('');
    expect(fechaDMYtoYMD(12345)).toBe('');
  });
});

describe('las facturas VARIOS 2 no son ventas', () => {
  it('la marca explícita alcanza', () => {
    expect(isVentaVarios2({ is_varios_2: true })).toBe(true);
    expect(isItemVarios2({ is_varios_2: true })).toBe(true);
  });

  it('y si no llegó, se la reconoce por el texto', () => {
    // El flag no siempre se sincroniza desde el POS.
    expect(isVentaVarios2({ productos: 'VARIOS 2 x1' })).toBe(true);
    expect(isVentaVarios2({ productos: 'varios 2' })).toBe(true);
  });

  it('un item por su nombre o por su rubro', () => {
    expect(isItemVarios2({ producto: 'VARIOS 2' })).toBe(true);
    expect(isItemVarios2({ product_name: 'varios 2' })).toBe(true);
    expect(isItemVarios2({ producto: 'CUADERNO', categoria: 'VARIOS 2' })).toBe(true);
  });

  it('una venta de verdad no se descarta', () => {
    expect(isVentaVarios2({ productos: 'CUADERNO RIVADAVIA x2' })).toBe(false);
    expect(isItemVarios2({ producto: 'CUADERNO RIVADAVIA' })).toBe(false);
  });

  it('un producto que apenas se parece tampoco', () => {
    // "VARIOS" a secas es un ítem libre del mostrador: ese SÍ es una venta.
    expect(isVentaVarios2({ productos: 'VARIOS x1' })).toBe(false);
    expect(isItemVarios2({ producto: 'VARIOS' })).toBe(false);
    expect(isItemVarios2({ producto: 'VARIOS 20 HOJAS' })).toBe(false);
  });

  it('sin datos no se descarta nada', () => {
    expect(isVentaVarios2(null)).toBe(false);
    expect(isItemVarios2(undefined)).toBe(false);
    expect(isVentaVarios2({})).toBe(false);
  });
});
