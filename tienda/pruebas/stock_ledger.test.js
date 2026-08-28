/**
 * El historial de movimientos de stock, lado panel.
 *
 * Cada entrada y salida deja quién, cuándo y de cuánto a cuánto. Existe porque
 * antes el sistema guardaba sólo el número actual: cuando un producto no
 * cerraba contra la góndola no había forma de saber si faltó registrar una
 * venta, si alguien lo tipeó mal o si el descuento nunca llegó.
 *
 * Dos cosas que tienen que salir bien:
 *   · que NO se anote nada cuando no se movió nada — el historial se lee para
 *     encontrar el momento en que un número dejó de cerrar, y las filas de cero
 *     tapan justamente eso;
 *   · que perder una línea nunca voltee la operación que la generó.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` se eleva por encima del archivo: lo que use adentro tiene que
// existir antes, y para eso está `vi.hoisted`.
const { escrituras, estado } = vi.hoisted(() => ({
  escrituras: [], estado: { falla: false },
}));

vi.mock('firebase/firestore', () => ({
  collection: (_db, nombre) => ({ _col: nombre }),
  addDoc: async (col, datos) => {
    if (estado.falla) throw new Error('Firestore no responde');
    escrituras.push({ col: col._col, datos });
    return { id: 'nuevo' };
  },
  query: (col, ...partes) => ({ col, partes }),
  where: (campo, op, valor) => ({ campo, op, valor }),
  orderBy: (campo, dir) => ({ campo, dir }),
  limit: (n) => ({ limit: n }),
  getDocs: async () => ({
    docs: [{ id: 'm1', data: () => ({ motivo: 'venta', cantidad: -2 }) }],
  }),
  serverTimestamp: () => 'AHORA',
}));
vi.mock('../../webapp/src/auth.js', () => ({
  auth: { currentUser: { displayName: 'Mari', email: 'mari@liceo' } },
}));

const { registrarMovimiento, registrarVarios, movimientosDe, MOTIVOS } =
  await import('../../webapp/src/stock_ledger.js');

beforeEach(() => { escrituras.length = 0; estado.falla = false; });

describe('anotar un movimiento', () => {
  it('guarda de cuánto a cuánto y quién lo hizo', async () => {
    await registrarMovimiento({}, {
      docId: 'p1', nombre: 'CUADERNO', motivo: 'reposicion', antes: 10, despues: 30,
    });
    expect(escrituras.length).toBe(1);
    expect(escrituras[0].col).toBe('stock_movimientos');
    expect(escrituras[0].datos).toMatchObject({
      firebase_id: 'p1', producto_nombre: 'CUADERNO', motivo: 'reposicion',
      stock_antes: 10, stock_despues: 30, cantidad: 20,
      origen: 'webapp', pc_id: 'webapp', usuario: 'Mari',
    });
  });

  it('el signo dice para qué lado se movió', async () => {
    await registrarMovimiento({}, { docId: 'p1', motivo: 'venta', antes: 30, despues: 28 });
    expect(escrituras[0].datos.cantidad).toBe(-2);
  });

  it('se puede anotar sólo la cantidad, sin el antes y el después', async () => {
    // Es el caso del conjunto por variedad: ahí el `stock` plano no aplica.
    await registrarMovimiento({}, { docId: 'p1', motivo: 'variante', cantidad: -3 });
    expect(escrituras[0].datos.cantidad).toBe(-3);
    expect(escrituras[0].datos.stock_antes).toBeNull();
  });

  it('la cantidad explícita le gana a la diferencia', async () => {
    await registrarMovimiento({}, {
      docId: 'p1', motivo: 'venta', antes: 10, despues: 30, cantidad: 5,
    });
    expect(escrituras[0].datos.cantidad).toBe(5);
  });

  it('guarda la referencia y el detalle para poder rastrearlo', async () => {
    await registrarMovimiento({}, {
      docId: 'p1', motivo: 'vinculacion', antes: 100, despues: 99,
      referencia: 'Venta #57', detalle: 'Consumido por IMPRESION A4',
    });
    expect(escrituras[0].datos).toMatchObject({
      referencia: 'Venta #57', detalle: 'Consumido por IMPRESION A4',
    });
  });

  it('se puede firmar a nombre de otro', async () => {
    await registrarMovimiento({}, {
      docId: 'p1', motivo: 'conteo', antes: 1, despues: 2, usuario: 'Ana',
    });
    expect(escrituras[0].datos.usuario).toBe('Ana');
  });

  it('los decimales no se pierden', async () => {
    // Medio metro de una cinta es un movimiento válido.
    await registrarMovimiento({}, { docId: 'p1', motivo: 'venta', antes: 10, despues: 9.5 });
    expect(escrituras[0].datos.cantidad).toBe(-0.5);
  });
});

describe('cuándo NO se anota nada', () => {
  it('sin cambio real', async () => {
    // Guardar la ficha sin tocar el stock no puede ensuciar el historial.
    await registrarMovimiento({}, { docId: 'p1', motivo: 'edicion_manual', antes: 10, despues: 10 });
    expect(escrituras).toEqual([]);
  });

  it('con cantidad cero', async () => {
    await registrarMovimiento({}, { docId: 'p1', motivo: 'venta', cantidad: 0 });
    expect(escrituras).toEqual([]);
  });

  it('sin antes ni después ni cantidad', async () => {
    await registrarMovimiento({}, { docId: 'p1', motivo: 'venta' });
    expect(escrituras).toEqual([]);
  });

  it('sin producto, sin motivo o sin base', async () => {
    await registrarMovimiento({}, { motivo: 'venta', antes: 1, despues: 2 });
    await registrarMovimiento({}, { docId: 'p1', antes: 1, despues: 2 });
    await registrarMovimiento(null, { docId: 'p1', motivo: 'venta', antes: 1, despues: 2 });
    expect(escrituras).toEqual([]);
  });
});

describe('lo que no puede voltear la operación', () => {
  it('si Firestore no responde, no se propaga el error', async () => {
    estado.falla = true;
    await expect(registrarMovimiento({}, {
      docId: 'p1', motivo: 'venta', antes: 1, despues: 2,
    })).resolves.toBeUndefined();
    expect(escrituras).toEqual([]);
  });

  it('un movimiento que falla no corta a los que siguen', async () => {
    // Borrar una venta de 8 renglones anota 8 movimientos: uno que falle no
    // puede dejar los otros siete sin registrar.
    await registrarVarios({}, [
      { docId: 'p1', motivo: 'anulacion', antes: 1, despues: 2 },
      { motivo: 'anulacion', antes: 1, despues: 2 },            // sin docId: se saltea
      { docId: 'p3', motivo: 'anulacion', antes: 5, despues: 9 },
    ]);
    expect(escrituras.map(e => e.datos.firebase_id)).toEqual(['p1', 'p3']);
  });
});

describe('leer el historial de un producto', () => {
  it('trae los movimientos con su id', async () => {
    const movs = await movimientosDe({}, 'p1');
    expect(movs).toEqual([{ id: 'm1', motivo: 'venta', cantidad: -2 }]);
  });

  it('sin producto no consulta nada', async () => {
    expect(await movimientosDe({}, '')).toEqual([]);
    expect(await movimientosDe(null, 'p1')).toEqual([]);
  });
});

describe('los motivos', () => {
  it('tienen nombre legible para la pantalla', () => {
    expect(MOTIVOS.venta).toBe('Venta');
    expect(MOTIVOS.vinculacion).toBe('Consumido por otro producto');
    expect(MOTIVOS.fiado).toBe('Cargado a fiado');
  });
});
