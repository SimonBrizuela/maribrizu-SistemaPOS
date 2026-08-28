/**
 * La numeración de ventas que ve el panel.
 *
 * Cada PC lleva su propio contador, así que sin esto la web muestra dos ventas
 * "#4" (una de cada PC) y quien llama por teléfono dictando un número no se
 * puede encontrar. El número global es SÓLO para mostrar: el interno sigue
 * siendo el de la PC, y es el que abre el detalle y busca los renglones.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase/firestore', async () => (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {} }));
vi.mock('../../webapp/src/cache.js', () => ({
  getCached: async (_k, fn) => fn(), invalidateCache: () => {}, setCacheValue: () => {},
}));

const { displayNumForVenta, displayNumForItem } =
  await import('../../webapp/src/sale_numbers.js');

// El mapa lo arma `getSaleNumberMap` recorriendo las ventas en orden
// cronológico: la clave es "PC|número de esa PC".
const MAPA = { 'PC1|4': 1, 'PC2|4': 2, 'PC1|5': 3, 'TIENDA|K7M2': 4 };

describe('el número de venta que se muestra', () => {
  it('dos ventas #4 de PCs distintas son números distintos', () => {
    expect(displayNumForVenta({ pc_id: 'PC1', sale_id: 4 }, MAPA)).toBe(1);
    expect(displayNumForVenta({ pc_id: 'PC2', sale_id: 4 }, MAPA)).toBe(2);
  });

  it('un pedido de la tienda entra en la misma numeración', () => {
    expect(displayNumForVenta({ pc_id: 'TIENDA', sale_id: 'K7M2' }, MAPA)).toBe(4);
  });

  it('un renglón se numera igual que su venta', () => {
    // El renglón trae el pc en `_pc_id` (sacado del id del documento) o en
    // `pc_id`: las dos formas tienen que llevar al mismo número.
    expect(displayNumForItem({ _pc_id: 'PC1', num_venta: 5 }, MAPA)).toBe(3);
    expect(displayNumForItem({ pc_id: 'PC2', num_venta: 4 }, MAPA)).toBe(2);
  });

  it('una venta que no está en el mapa muestra su número interno', () => {
    // Es lo único que se puede mostrar, y es mejor que un hueco.
    expect(displayNumForVenta({ pc_id: 'PC9', sale_id: 77 }, MAPA)).toBe(77);
    expect(displayNumForItem({ pc_id: 'PC9', num_venta: 77 }, MAPA)).toBe(77);
  });

  it('el id del documento sirve de respaldo', () => {
    expect(displayNumForVenta({ pc_id: 'PC1', id: 'abc' }, {})).toBe('abc');
  });

  it('sin nada que mostrar pone una raya, no "undefined"', () => {
    expect(displayNumForVenta({}, {})).toBe('-');
    expect(displayNumForItem({}, {})).toBe('-');
  });

  it('una venta sin PC no se confunde con las de una PC', () => {
    // Las ventas viejas no traen pc_id: su clave es "|numero".
    expect(displayNumForVenta({ sale_id: 4 }, { '|4': 9 })).toBe(9);
    expect(displayNumForVenta({ sale_id: 4 }, MAPA)).toBe(4);   // no toma el de PC1
  });
});
