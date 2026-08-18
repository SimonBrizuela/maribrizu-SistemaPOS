/**
 * Las lápidas de `catalogo_deleted` vistas desde el panel.
 *
 * Cuando el panel da de alta un producto tiene que levantar la lápida de su
 * código, porque el código pudo ser de un producto borrado. Si la lápida queda,
 * el POS baja el producto nuevo, la ve y lo borra de la base de cada PC: se ve
 * en el panel y en la tienda, y en la caja no aparece nunca. Fue el caso de
 * BLISTER DE CEBITAS (código JUG545000, lápida del 23/07, producto del 27/07).
 *
 * La otra mitad de la regla vive en el POS y tiene sus propias pruebas:
 * `pos_system/tests/test_tombstones.py` y `test_sync_lapidas.py`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  levantarLapida, levantarLapidas, codigosLimpios, POR_LOTE,
} from '../../webapp/src/lapidas.js';

const db = {};
let borrados;   // refs que se borraron, en orden
let lotes;      // tamaño de cada lote que llegó a commit

// Firestore de mentira. Un código 'ROMPE' hace fallar la escritura.
function firestoreFalso() {
  return {
    doc: (_db, coleccion, id) => ({ coleccion, id }),
    deleteDoc: async (ref) => {
      if (ref.id === 'ROMPE') throw new Error('permission-denied');
      borrados.push(ref);
    },
    writeBatch: () => {
      const ops = [];
      return {
        delete: (ref) => ops.push(ref),
        commit: async () => {
          if (ops.some(r => r.id === 'ROMPE')) throw new Error('permission-denied');
          lotes.push(ops.length);
          borrados.push(...ops);
        },
      };
    },
  };
}

beforeEach(() => {
  borrados = [];
  lotes = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('alta de un producto', () => {
  it('levanta la lápida de ese código, en catalogo_deleted', async () => {
    expect(await levantarLapida(db, 'JUG545000', firestoreFalso())).toBe(1);
    expect(borrados).toEqual([{ coleccion: 'catalogo_deleted', id: 'JUG545000' }]);
  });

  it('acepta un código numérico y le saca los espacios', async () => {
    await levantarLapida(db, 987913, firestoreFalso());
    await levantarLapida(db, '  987031  ', firestoreFalso());
    expect(borrados.map(r => r.id)).toEqual(['987913', '987031']);
  });

  it('sin código no toca nada', async () => {
    const fs = firestoreFalso();
    expect(await levantarLapida(db, '', fs)).toBe(0);
    expect(await levantarLapida(db, null, fs)).toBe(0);
    expect(await levantarLapida(db, undefined, fs)).toBe(0);
    expect(borrados).toEqual([]);
  });

  it('si Firestore falla no rompe el alta: el producto ya está guardado', async () => {
    expect(await levantarLapida(db, 'ROMPE', firestoreFalso())).toBe(0);
    expect(borrados).toEqual([]);
  });
});

describe('alta masiva', () => {
  it('levanta la lápida de todos los códigos subidos', async () => {
    expect(await levantarLapidas(db, ['A1', 'B2', 'C3'], firestoreFalso())).toBe(3);
    expect(borrados.map(r => r.id)).toEqual(['A1', 'B2', 'C3']);
    expect(borrados.every(r => r.coleccion === 'catalogo_deleted')).toBe(true);
  });

  it('no repite un código ni manda vacíos', async () => {
    await levantarLapidas(db, ['A1', 'A1', '', null, '  A1  ', 'B2'], firestoreFalso());
    expect(borrados.map(r => r.id)).toEqual(['A1', 'B2']);
  });

  it('parte en lotes de 400, que es el límite de Firestore', async () => {
    const codigos = Array.from({ length: 901 }, (_, i) => `P${i}`);
    expect(await levantarLapidas(db, codigos, firestoreFalso())).toBe(901);
    expect(lotes).toEqual([400, 400, 101]);
    expect(POR_LOTE).toBeLessThan(500);
  });

  it('si un lote falla sigue con los demás', async () => {
    const codigos = ['ROMPE', ...Array.from({ length: 400 }, (_, i) => `P${i}`)];
    expect(await levantarLapidas(db, codigos, firestoreFalso())).toBe(1);
    expect(lotes).toEqual([1]);
  });

  it('sin códigos no abre ningún lote', async () => {
    expect(await levantarLapidas(db, [], firestoreFalso())).toBe(0);
    expect(await levantarLapidas(db, null, firestoreFalso())).toBe(0);
    expect(lotes).toEqual([]);
  });
});

describe('códigos limpios', () => {
  it('saca vacíos, espacios y repetidos, y respeta el orden', () => {
    expect(codigosLimpios([' A1 ', 'A1', '', null, undefined, 987913, 'B2']))
      .toEqual(['A1', '987913', 'B2']);
    expect(codigosLimpios(null)).toEqual([]);
  });
});
