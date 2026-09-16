// @vitest-environment jsdom
/**
 * Entregar un pedido desde el panel y borrar la venta con que lo cobró una caja.
 *
 * Desde el 16-09 el panel no registra ventas de la tienda: al entregar, el
 * stock sale y el pedido queda "a cobrar" para las cajas del POS; lo que
 * entrega el repartidor lo descuentan las cajas abiertas.
 *
 * Lo que no puede pasar:
 *   · que entregar dos veces baje el stock dos veces;
 *   · que un pedido ya descontado por una caja se descuente de nuevo;
 *   · que una venta TIENDA de antes del cambio se toque;
 *   · que borrar el cobro de una caja devuelva stock que salió al entregar, o
 *     reabra un pedido que ya se volvió a cobrar en otra caja.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { datos } = vi.hoisted(() => ({
  datos: { base: {}, escrituras: [], fallar: 0 },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  const base = firestoreFalso({ registro: datos.escrituras });
  const clave = ref => `${ref?._col}/${ref?.id}`;
  const leer = ref => {
    const d = datos.base[clave(ref)];
    return { exists: () => d != null, data: () => d, id: ref?.id };
  };
  const BORRAR = { __borrar: true };
  const escribir = (tipo, ref, cambios) => {
    datos.escrituras.push({ tipo, ref, datos: cambios });
    const actual = { ...(datos.base[clave(ref)] || {}), ...cambios };
    for (const [k, v] of Object.entries(actual)) if (v === BORRAR) delete actual[k];
    datos.base[clave(ref)] = actual;
  };
  return {
    ...base,
    doc: (_db, col, id) => ({ _col: col, id }),
    setDoc: async (ref, cambios) => escribir('set', ref, cambios),
    deleteField: () => BORRAR,
    runTransaction: async (_db, fn) => {
      if (datos.fallar > 0) { datos.fallar--; throw new Error('sin red'); }
      return fn({
        get: async (ref) => leer(ref),
        set: (ref, cambios) => escribir('tx-set', ref, cambios),
        update: (ref, cambios) => escribir('tx-update', ref, cambios),
      });
    },
    serverTimestamp: () => 'AHORA',
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {}, storage: {} }));
vi.mock('../../webapp/src/tienda_espejo.js', () => ({ reflejarSiPublicado: vi.fn(async () => ({ publicado: false })) }));
vi.mock('../../webapp/src/avisos_cliente.js', () => ({ avisarAlCliente: vi.fn(async () => true), urlDeLaTienda: () => 'http://localhost:5180' }));

const ENTREGADO = new Date('2026-09-15T00:40:00Z');
const marca = (d) => ({ toDate: () => d, toMillis: () => d.getTime() });

function preparar(extra = {}) {
  datos.base['tienda_pedidos/k1'] = {
    codigo: 'K7M2', estado: 'entregado', entregado_por: 'reparto', venta_pendiente: true,
    entregado_en: marca(ENTREGADO), entregado_dia: '2026-09-14', creado: marca(new Date('2026-09-14T20:00:00Z')),
    cliente: { nombre: 'Marta Gómez', telefono: '3515550001' },
    entrega: { modo: 'delivery', direccion: 'Colón 1200' }, pago: { modo: 'efectivo', pagado: true },
    items: [{ id: 'p1', nombre: 'Cuaderno Rivadavia', cantidad: 2, precio: 3500, subtotal: 7000 }],
    subtotal: 7000, envio: 0, total: 7000,
    ...extra,
  };
  datos.base['catalogo/p1'] = { nombre: 'CUADERNO RIVADAVIA', rubro: 'LIBRERIA', stock: 12, precio_venta: 3500, estado: 'activo' };
}

const escritas = (tipo, col) => datos.escrituras.filter(e => e.tipo === tipo && e.ref?._col === col);

beforeEach(() => {
  vi.resetModules();
  datos.base = {};
  datos.escrituras.length = 0;
  datos.fallar = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('entregar desde el panel', () => {
  it('lo del repartidor: baja el stock, conserva la hora de la entrega y queda a cobrar', async () => {
    preparar();
    const { registrarEntrega } = await import('../../webapp/src/entregar_pedido.js');
    const r = await registrarEntrega({}, 'k1', { usuario: 'Mari' });
    expect(r.ok).toBe(true);

    expect(datos.base['catalogo/p1'].stock).toBe(10);
    const p = datos.base['tienda_pedidos/k1'];
    expect(p).toMatchObject({
      estado: 'entregado', stock_descontado: true, venta_registrada: true,
      cobro_pendiente: true, venta_pendiente: false,
    });
    expect(p.entregado_en.toDate()).toEqual(ENTREGADO);
    expect(p.stock_descontado_por).toMatchObject({ origen: 'panel', cajero: 'Mari' });
    expect(escritas('tx-set', 'ventas')).toEqual([]);
    expect(escritas('tx-set', 'ventas_por_dia')).toEqual([]);
  });

  it('los movimientos de stock van en la misma transacción, con el pedido', async () => {
    preparar();
    const { registrarEntrega } = await import('../../webapp/src/entregar_pedido.js');
    await registrarEntrega({}, 'k1');
    const movs = escritas('tx-set', 'stock_movimientos');
    expect(movs).toHaveLength(1);
    expect(movs[0].ref.id).toMatch(/^tienda_k1_[0-9a-f]{16}_0$/);
    expect(movs[0].datos).toMatchObject({
      firebase_id: 'p1', motivo: 'venta', cantidad: -2, stock_antes: 12, stock_despues: 10,
      referencia: 'Pedido tienda K7M2', pedido_id: 'k1',
    });
  });

  it('deja el renglón en el registro de eventos', async () => {
    preparar();
    const { registrarEntrega } = await import('../../webapp/src/entregar_pedido.js');
    await registrarEntrega({}, 'k1');
    const ev = escritas('set', 'tienda_pedidos_eventos');
    expect(ev).toHaveLength(1);
    expect(ev[0].datos).toMatchObject({ pedido_id: 'k1', accion: 'entregar', origen: 'panel', detalle: 'descontó el stock' });
    expect(ev[0].datos.stock[0]).toMatchObject({ id: 'p1' });
  });

  it('dos veces no baja el stock dos veces', async () => {
    preparar();
    const { registrarEntrega } = await import('../../webapp/src/entregar_pedido.js');
    await registrarEntrega({}, 'k1');
    const r = await registrarEntrega({}, 'k1');
    expect(r).toMatchObject({ ok: true, yaEstaba: true });
    expect(datos.base['catalogo/p1'].stock).toBe(10);
    expect(escritas('tx-set', 'stock_movimientos')).toHaveLength(1);
  });

  it('lo que ya descontó una caja no se descuenta de nuevo', async () => {
    preparar({ stock_descontado: true, venta_registrada: true, cobro_pendiente: true, venta_pendiente: false });
    const { registrarEntrega } = await import('../../webapp/src/entregar_pedido.js');
    const r = await registrarEntrega({}, 'k1');
    expect(r.yaEstaba).toBe(true);
    expect(datos.base['catalogo/p1'].stock).toBe(12);
    expect(datos.base['tienda_pedidos/k1'].cobro_pendiente).toBe(true);
  });

  it('una venta TIENDA de antes del cambio queda como estaba', async () => {
    preparar({ venta_registrada: true, venta_id: 'TIENDA_K7M2', stock_descontado: true, venta_pendiente: false });
    const { registrarEntrega } = await import('../../webapp/src/entregar_pedido.js');
    await registrarEntrega({}, 'k1');
    const p = datos.base['tienda_pedidos/k1'];
    expect(p.venta_id).toBe('TIENDA_K7M2');
    expect(p.cobro_pendiente).toBeUndefined();
    expect(datos.base['catalogo/p1'].stock).toBe(12);
  });

  it('el botón del panel sobre un pedido listo: entregado ahora y por el panel', async () => {
    preparar({ estado: 'listo', venta_pendiente: undefined, entregado_por: undefined, entregado_en: undefined, entregado_dia: undefined });
    const { registrarEntrega } = await import('../../webapp/src/entregar_pedido.js');
    await registrarEntrega({}, 'k1');
    const p = datos.base['tienda_pedidos/k1'];
    expect(p.entregado_en).toBe('AHORA');
    expect(p.entregado_por).toBe('panel');
    expect(p.entregado_dia).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('un pedido cancelado no se entrega ni baja stock', async () => {
    preparar({ estado: 'cancelado', venta_pendiente: undefined });
    const { registrarEntrega } = await import('../../webapp/src/entregar_pedido.js');
    const r = await registrarEntrega({}, 'k1');
    expect(r).toMatchObject({ ok: false, rechazo: 'está cancelado' });
    expect(datos.base['catalogo/p1'].stock).toBe(12);
  });
});

describe('borrar la venta con que una caja cobró el pedido', () => {
  const venta = { id: 'CAJA1-aaaa_57', pc_id: 'CAJA1-aaaa', origen: 'tienda', pedido_id: 'k1', pedido_codigo: 'K7M2' };

  it('reconoce el cobro de una caja y no una venta TIENDA ni una común', async () => {
    const { esCobroDePedido } = await import('../../webapp/src/cobro_pedido.js');
    expect(esCobroDePedido(venta)).toBe(true);
    expect(esCobroDePedido({ ...venta, pc_id: 'TIENDA' })).toBe(false);
    expect(esCobroDePedido({ id: 'CAJA1_58', pc_id: 'CAJA1' })).toBe(false);
  });

  it('el pedido vuelve a "a cobrar" sin tocar el stock', async () => {
    preparar({
      venta_pendiente: false, stock_descontado: true, venta_registrada: true, cobro_pendiente: false,
      venta_id: 'CAJA1-aaaa_57', cobro: { estado: 'hecho', pc_id: 'CAJA1-aaaa', venta_local: 57 },
    });
    const { reabrirCobro } = await import('../../webapp/src/cobro_pedido.js');
    const r = await reabrirCobro({}, venta);
    expect(r.ok).toBe(true);
    const p = datos.base['tienda_pedidos/k1'];
    expect(p.cobro_pendiente).toBe(true);
    expect(p.cobro).toBeUndefined();
    expect(p.venta_id).toBeUndefined();
    expect(p.stock_descontado).toBe(true);
    expect(datos.base['catalogo/p1'].stock).toBe(12);
  });

  it('si el pedido ya tiene otro cobro, no se toca', async () => {
    preparar({ venta_id: 'CAJA2-bbbb_9', cobro: { estado: 'hecho', pc_id: 'CAJA2-bbbb' } });
    const { reabrirCobro } = await import('../../webapp/src/cobro_pedido.js');
    const r = await reabrirCobro({}, venta);
    expect(r).toMatchObject({ ok: false, rechazo: 'el pedido tiene otro cobro anotado' });
    expect(datos.base['tienda_pedidos/k1'].venta_id).toBe('CAJA2-bbbb_9');
  });
});
