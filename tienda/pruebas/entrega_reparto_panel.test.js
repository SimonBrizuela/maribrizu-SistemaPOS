// @vitest-environment jsdom
/**
 * Lo que el repartidor marca como entregado, del lado del panel.
 *
 * La función `reparto-mover` deja el pedido entregado con `venta_pendiente` y
 * no registra la venta: la registra el panel con la misma cuenta que usa su
 * botón "Entregado" (`entregar_pedido.js`). Así el stock, la venta y la
 * vidriera salen de un solo lugar.
 *
 * Lo que no puede pasar:
 *   · que la venta quede con la fecha de cuando se abrió el panel y no con la de
 *     la entrega: el repartidor cobró ayer, la plata es de ayer;
 *   · que dos PCs con el panel abierto la registren dos veces;
 *   · que un fallo de red la deje pendiente para siempre.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { datos } = vi.hoisted(() => ({
  datos: { base: {}, escrituras: [], fallar: 0, escuchas: [] },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  const base = firestoreFalso({ registro: datos.escrituras });
  const clave = ref => `${ref?._col}/${ref?.id}`;
  const leer = ref => {
    const d = datos.base[clave(ref)];
    return { exists: () => d != null, data: () => d, id: ref?.id, get: (c) => d?.[c] };
  };
  const escribir = (tipo, ref, cambios) => {
    datos.escrituras.push({ tipo, ref, datos: cambios });
    datos.base[clave(ref)] = { ...(datos.base[clave(ref)] || {}), ...cambios };
  };
  return {
    ...base,
    doc: (_db, col, id) => ({ _col: col, id }),
    collection: (_db, nombre) => ({ _col: nombre }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    where: (campo, op, valor) => ({ campo, op, valor }),
    getDoc: async (ref) => leer(ref),
    setDoc: async (ref, cambios) => escribir('set', ref, cambios),
    updateDoc: async (ref, cambios) => escribir('update', ref, cambios),
    onSnapshot: (q, cb) => {
      const escucha = {
        q, activa: true,
        avisar() {
          const filtro = q.partes?.find(p => p?.campo);
          const docs = Object.entries(datos.base)
            .filter(([k]) => k.startsWith(`${q._col}/`))
            .filter(([, d]) => !filtro || d[filtro.campo] === filtro.valor)
            .map(([k, d]) => ({ id: k.split('/')[1], data: () => d, exists: () => true }));
          cb({ docs, empty: !docs.length, size: docs.length, docChanges: () => [] });
        },
      };
      datos.escuchas.push(escucha);
      escucha.avisar();
      return () => { escucha.activa = false; };
    },
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
vi.mock('../../webapp/src/stock_ledger.js', () => ({ registrarMovimiento: () => {} }));
vi.mock('../../webapp/src/tienda_espejo.js', () => ({ reflejarSiPublicado: async () => ({ publicado: false }) }));
vi.mock('../../webapp/src/avisos_cliente.js', () => ({ avisarAlCliente: vi.fn(async () => true), urlDeLaTienda: () => 'http://localhost:5180' }));

// Ayer a las 21:40 de Argentina.
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

const esperar = () => new Promise(r => setTimeout(r, 0));
const respirar = async () => { for (let i = 0; i < 20; i++) await esperar(); };

beforeEach(() => {
  vi.resetModules();
  datos.base = {};
  datos.escrituras.length = 0;
  datos.fallar = 0;
  datos.escuchas = [];
  vi.stubGlobal('alert', vi.fn());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => { vi.useRealTimers(); });

describe('registrarEntrega de lo que entregó el repartidor', () => {
  it('registra la venta con la fecha de la entrega, no con la de ahora', async () => {
    preparar();
    const { registrarEntrega } = await import('../../webapp/src/entregar_pedido.js');
    const r = await registrarEntrega({}, 'k1');
    expect(r.ok).toBe(true);

    expect(datos.base['catalogo/p1'].stock).toBe(10);
    const renglon = datos.base['ventas_por_dia/TIENDA_K7M2_0'];
    expect(renglon).toMatchObject({ fecha: '14/09/2026', hora: '21:40:00' });
    expect(datos.base['ventas/TIENDA_K7M2'].created_at).toEqual(ENTREGADO);

    const p = datos.base['tienda_pedidos/k1'];
    expect(p).toMatchObject({ venta_registrada: true, venta_id: 'TIENDA_K7M2', venta_pendiente: false, estado: 'entregado' });
    // La hora de la entrega del repartidor se conserva.
    expect(p.entregado_en.toDate()).toEqual(ENTREGADO);
  });

  it('dos veces no registra dos ventas ni baja el stock dos veces', async () => {
    preparar();
    const { registrarEntrega } = await import('../../webapp/src/entregar_pedido.js');
    await registrarEntrega({}, 'k1');
    const r = await registrarEntrega({}, 'k1');
    expect(r).toMatchObject({ ok: true, yaEstaba: true });
    expect(datos.base['catalogo/p1'].stock).toBe(10);
    expect(datos.escrituras.filter(e => e.tipo === 'tx-set' && e.ref._col === 'ventas')).toHaveLength(1);
  });

  it('el botón del panel sigue igual: fecha de ahora y hora de entrega de ahora', async () => {
    preparar({ estado: 'listo', venta_pendiente: undefined, entregado_por: undefined, entregado_en: undefined, entregado_dia: undefined });
    const { registrarEntrega } = await import('../../webapp/src/entregar_pedido.js');
    await registrarEntrega({}, 'k1');
    const p = datos.base['tienda_pedidos/k1'];
    expect(p.entregado_en).toBe('AHORA');
    expect(p.entregado_dia).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(datos.base['ventas/TIENDA_K7M2'].created_at).toBe('AHORA');
  });
});

describe('el vigía de ventas pendientes', () => {
  it('registra solo lo que el repartidor dejó pendiente', async () => {
    preparar();
    datos.base['tienda_pedidos/k2'] = { codigo: 'OTRO', estado: 'listo', items: [] };
    const { iniciarVentasPendientes } = await import('../../webapp/src/ventas_pendientes_watcher.js');
    iniciarVentasPendientes({});
    await respirar();
    expect(datos.base['tienda_pedidos/k1'].venta_registrada).toBe(true);
    expect(datos.base['tienda_pedidos/k2'].venta_registrada).toBeUndefined();
  });

  it('si falla, lo vuelve a intentar solo', async () => {
    vi.useFakeTimers();
    preparar();
    datos.fallar = 1;
    const { iniciarVentasPendientes } = await import('../../webapp/src/ventas_pendientes_watcher.js');
    iniciarVentasPendientes({});
    await vi.advanceTimersByTimeAsync(10);
    expect(datos.base['tienda_pedidos/k1'].venta_registrada).toBeUndefined();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(datos.base['tienda_pedidos/k1'].venta_registrada).toBe(true);
  });

  it('no arranca dos veces la misma registración mientras la primera sigue en curso', async () => {
    preparar();
    const { iniciarVentasPendientes } = await import('../../webapp/src/ventas_pendientes_watcher.js');
    iniciarVentasPendientes({});
    // El mismo aviso llega de nuevo antes de que termine la primera.
    datos.escuchas.forEach(e => e.avisar());
    await respirar();
    expect(datos.escrituras.filter(e => e.tipo === 'tx-set' && e.ref._col === 'ventas')).toHaveLength(1);
  });
});
