// @vitest-environment jsdom
/**
 * Borrar en Ventas la venta con que una caja cobró un pedido de la tienda.
 *
 * El stock de ese pedido salió al entregarlo, no al cobrarlo: borrar la venta
 * no puede devolverlo (quedaría stock de más). Tampoco reabre el cobro: la caja
 * de la PC la sigue sumando y cobrarla de nuevo contaba la plata dos veces. Una
 * venta común o una TIENDA de las de antes siguen devolviendo el stock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { datos } = vi.hoisted(() => ({
  datos: { ventas: [], lotes: [], updates: [], revertir: [], transacciones: 0, confirmar: [] },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  const base = firestoreFalso();
  return {
    ...base,
    collection: (_db, nombre) => ({ _col: nombre }),
    query: (col) => ({ _col: col?._col }),
    getDocs: async (q) => {
      const lista = q._col === 'ventas' ? datos.ventas : [];
      return { docs: lista.map(d => ({ id: d.id, data: () => d })), empty: !lista.length, size: lista.length };
    },
    doc: (_db, col, id) => ({ _col: col, id }),
    runTransaction: async () => { datos.transacciones++; },
    updateDoc: async (ref, cambios) => { datos.updates.push({ ref, cambios }); },
    writeBatch: () => {
      const lote = { cambios: [] };
      datos.lotes.push(lote);
      return { update: (ref, c) => lote.cambios.push({ ref, c }), commit: async () => { lote.hecho = true; } };
    },
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {}, storage: {} }));
vi.mock('../../webapp/src/config.js', () => ({
  getFechaInicioDate: async () => new Date(2020, 0, 1),
  isVentaVarios2: () => false,
}));
vi.mock('../../webapp/src/sale_numbers.js', () => ({
  getSaleNumberMap: async () => ({}), displayNumForVenta: (v) => v.sale_id,
}));
vi.mock('../../webapp/src/cache.js', () => ({ getCached: async (_k, fn) => fn(), invalidateCache: () => {} }));
vi.mock('../../webapp/src/components/modal.js', () => ({ openSaleModal: () => {} }));
vi.mock('../../webapp/src/components/dialogs.js', () => ({
  confirmDialog: async (op) => { datos.confirmar.push(op); return true; },
  alertDialog: vi.fn(),
  escHtml: (s) => String(s ?? ''),
}));
vi.mock('../../webapp/src/stock_revert.js', () => ({
  itemsDeLaVenta: async (_db, venta) => [{ id: `${venta.id}_0`, ref: { id: `${venta.id}_0` } }],
  revertirStockVenta: async (_db, args) => { datos.revertir.push(args); return { omitidos: [], devueltos: [] }; },
}));

const ahora = new Date().toISOString();

beforeEach(() => {
  vi.resetModules();
  Object.assign(datos, { ventas: [], lotes: [], updates: [], revertir: [], transacciones: 0, confirmar: [] });
  document.body.innerHTML = '<div id="content"></div>';
});

async function borrarLaPrimera() {
  const { renderVentas } = await import('../../webapp/src/pages/ventas.js');
  const c = document.getElementById('content');
  await renderVentas(c, {});
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
  c.querySelector('.btn-delete-venta').click();
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
}

describe('borrar el cobro de un pedido', () => {
  it('no devuelve stock, saca los renglones y no toca el pedido', async () => {
    datos.ventas = [{ id: 'CAJA1-aaaa_57', sale_id: 57, pc_id: 'CAJA1-aaaa', created_at: ahora, total_amount: 7000,
                      payment_type: 'transfer', origen: 'tienda', pedido_id: 'k1', pedido_codigo: 'K7M2' }];
    await borrarLaPrimera();
    expect(datos.confirmar[0].message).toContain('el pedido sigue cobrado');
    expect(datos.confirmar[0].message).toContain('Historial del POS');
    expect(datos.revertir).toEqual([]);
    expect(datos.lotes[0].cambios[0].c).toEqual({ deleted: true });
    expect(datos.updates[0]).toMatchObject({ ref: { _col: 'ventas', id: 'CAJA1-aaaa_57' } });
    expect(datos.transacciones).toBe(0);
  });

  it('una venta común sigue devolviendo el stock y no toca pedidos', async () => {
    datos.ventas = [{ id: 'CAJA1-aaaa_58', sale_id: 58, pc_id: 'CAJA1-aaaa', created_at: ahora, total_amount: 500,
                      payment_type: 'cash' }];
    await borrarLaPrimera();
    expect(datos.revertir).toHaveLength(1);
    expect(datos.transacciones).toBe(0);
  });

  it('una venta TIENDA de antes sigue devolviendo el stock', async () => {
    datos.ventas = [{ id: 'TIENDA_K7M2', sale_id: 'K7M2', pc_id: 'TIENDA', created_at: ahora, total_amount: 7000,
                      payment_type: 'transfer', origen: 'tienda', pedido_id: 'k1' }];
    await borrarLaPrimera();
    expect(datos.revertir).toHaveLength(1);
    expect(datos.transacciones).toBe(0);
  });
});
