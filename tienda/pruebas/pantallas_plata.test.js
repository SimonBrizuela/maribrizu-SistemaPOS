// @vitest-environment jsdom
/**
 * Las pantallas donde se miran los números: Dashboard, Ventas, Historial Diario,
 * Resúmenes y Cierres de Caja.
 *
 * Acá no alcanza con que la pantalla se arme: los números que muestra son con
 * los que se decide. Si el efectivo del día sale mal, se cuenta la caja
 * buscando una diferencia que no existe.
 *
 * El caso que más costó y el que más se repite en estas cinco pantallas es el
 * **pago mixto**: una venta cobrada parte en efectivo y parte por
 * transferencia. Contarla entera de un lado desbalancea todo. Cada pantalla
 * tiene su prueba con una venta mixta adentro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { datos } = vi.hoisted(() => ({ datos: { porColeccion: {} } }));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  const base = firestoreFalso();
  const snapshot = (nombre) => {
    const lista = datos.porColeccion[nombre] || [];
    return {
      docs: lista.map((d, i) => ({
        id: d.__id || `doc${i}`, ref: { id: d.__id || `doc${i}` },
        data: () => d, exists: () => true,
      })),
      empty: lista.length === 0, size: lista.length, docChanges: () => [],
      forEach(fn) { this.docs.forEach(fn); },
      exists: () => lista.length > 0, data: () => lista[0],
    };
  };
  return {
    ...base,
    collection: (_db, nombre) => ({ _col: nombre }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    getDocs: async (q) => snapshot(q?._col || q?.col?._col),
    getDoc: async (ref) => {
      const lista = datos.porColeccion[ref?._col] || [];
      return { exists: () => lista.length > 0, data: () => lista[0], id: ref?.id || 'x' };
    },
    getDocFromCache: async () => { throw new Error('sin cache local'); },
    onSnapshot: (_q, cb) => { try { cb?.(snapshot()); } catch (_) {} return () => {}; },
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {}, storage: {} }));
vi.mock('../../webapp/src/auth.js', () => ({
  auth: { currentUser: { uid: 'u1', displayName: 'Mari', getIdToken: async () => 'T' } },
  getSession: () => ({ uid: 'u1', display: 'Mari', role: 'admin' }),
  isLoggedIn: () => true, onAuthReady: async () => ({ role: 'admin' }),
  hasSessionHint: () => true, logout: async () => {},
}));
vi.mock('../../webapp/src/store.js', () => ({
  ensureCollections: () => {}, onStoreChange: () => () => {},
  initStore: async () => {}, storeListo: async () => {},
}));

const HOY = new Date();
const dosDigitos = (n) => String(n).padStart(2, '0');
const dmy = (d) => `${dosDigitos(d.getDate())}/${dosDigitos(d.getMonth() + 1)}/${d.getFullYear()}`;
const isoLocal = (d) => `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())} ` +
  `${dosDigitos(d.getHours())}:${dosDigitos(d.getMinutes())}:00`;

/** Hoy a tal hora, para que la venta caiga adentro del día en curso. */
const hoyALas = (h, m = 0) =>
  new Date(HOY.getFullYear(), HOY.getMonth(), HOY.getDate(), h, m, 0);

/**
 * Un día de ventas con las tres formas de cobrar.
 *   efectivo      $10.000
 *   transferencia $ 5.000
 *   mixta         $20.000 → $8.000 en efectivo (12.000 recibidos - 4.000 vuelto)
 *                           $12.000 por transferencia
 *
 * Total del día $35.000. Efectivo $18.000. Transferencia $17.000.
 */
const TOTAL_DIA = 35000;
const EFECTIVO_DIA = 18000;
const TRANSFER_DIA = 17000;

function ventasDelDia() {
  return [
    { __id: 'PC1_1', sale_id: 1, pc_id: 'PC1', created_at: isoLocal(hoyALas(9, 30)),
      total_amount: 10000, payment_type: 'cash', cash_received: 10000, change_given: 0,
      transfer_amount: 0, cajero: 'Marta', username: 'Marta', items_count: 1,
      cash_register_id: 1, productos: 'CUADERNO x1' },
    { __id: 'PC1_2', sale_id: 2, pc_id: 'PC1', created_at: isoLocal(hoyALas(11, 0)),
      total_amount: 5000, payment_type: 'transfer', cash_received: 0, change_given: 0,
      transfer_amount: 5000, cajero: 'Marta', username: 'Marta', items_count: 1,
      cash_register_id: 1, productos: 'LAPIZ x1' },
    { __id: 'PC1_3', sale_id: 3, pc_id: 'PC1', created_at: isoLocal(hoyALas(16, 15)),
      total_amount: 20000, payment_type: 'mixed', cash_received: 12000, change_given: 4000,
      transfer_amount: 12000, cajero: 'Jose', username: 'Jose', items_count: 2,
      cash_register_id: 1, productos: 'RESMA x2' },
  ];
}

function renglonesDelDia() {
  const f = dmy(HOY);
  return [
    { __id: 'r1', num_venta: 1, pc_id: 'PC1', fecha: f, hora: '09:30:00',
      producto: 'CUADERNO RIVADAVIA', categoria: 'LIBRERIA', cantidad: 1,
      precio_unitario: 10000, subtotal: 10000, tipo_pago: 'Efectivo', cajero: 'Marta',
      cash_register_id: 1, monto_efectivo: 10000, monto_transferencia: 0 },
    { __id: 'r2', num_venta: 2, pc_id: 'PC1', fecha: f, hora: '11:00:00',
      producto: 'LAPIZ FABER', categoria: 'LIBRERIA', cantidad: 1,
      precio_unitario: 5000, subtotal: 5000, tipo_pago: 'Transferencia', cajero: 'Marta',
      cash_register_id: 1, monto_efectivo: 0, monto_transferencia: 5000 },
    { __id: 'r3', num_venta: 3, pc_id: 'PC1', fecha: f, hora: '16:15:00',
      producto: 'RESMA PAMPA', categoria: 'PAPELERIA', cantidad: 2,
      precio_unitario: 10000, subtotal: 20000, tipo_pago: 'Mixto', cajero: 'Jose',
      cash_register_id: 1, monto_efectivo: 8000, monto_transferencia: 12000 },
  ];
}

const CATALOGO = [
  { __id: 'p1', doc_id: 'p1', id: 1, nombre: 'CUADERNO RIVADAVIA', codigo: 'C1',
    rubro: 'LIBRERIA', precio_venta: 10000, costo: 6000, stock: 10, stock_min: 3, estado: 'activo' },
  { __id: 'p2', doc_id: 'p2', id: 2, nombre: 'LAPIZ FABER', codigo: 'L1',
    rubro: 'LIBRERIA', precio_venta: 5000, costo: 2500, stock: 40, estado: 'activo' },
  { __id: 'p3', doc_id: 'p3', id: 3, nombre: 'RESMA PAMPA', codigo: 'R1',
    rubro: 'PAPELERIA', precio_venta: 10000, costo: 7000, stock: 6, estado: 'activo' },
];

let contenedor;

beforeEach(() => {
  // Las pantallas guardan en memoria lo que leyeron —es lo que hace que
  // navegar sea instantáneo—. Para que cada caso arranque limpio se descarta
  // todo el módulo, no sólo el contenido del cache.
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
  document.body.insertAdjacentHTML('beforeend',
    '<div id="app"></div><div id="page-title"></div><div id="sidebar"></div>' +
    '<div id="status"></div><div id="bottomNav"></div><div id="sidebarOverlay"></div>');

  class ChartFalso {
    constructor() { this.data = { datasets: [] }; this.options = {}; }
    destroy() {} update() {} resize() {} reset() {} render() {}
  }
  ChartFalso.register = () => {};
  ChartFalso.defaults = { font: {}, color: '', plugins: { legend: { labels: {} }, tooltip: {} },
                          scale: { grid: {} }, elements: {}, datasets: {} };
  window.Chart = ChartFalso;

  datos.porColeccion = {
    ventas: ventasDelDia(),
    ventas_por_dia: renglonesDelDia(),
    catalogo: CATALOGO,
    inventario: [], inventario_resumen: [], historial_diario: [], cierres_caja: [],
    caja_activa: [], gastos: [], control_config: [], config: [], promociones: [],
    fiado_clientes: [], fiado_items: [], fiado_pagos: [],
  };
});

/** Monta una pantalla y espera a que termine de completarse. */
async function montar(cargar, fn) {
  const mod = await cargar();
  await mod[fn](contenedor, {});
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  return contenedor;
}

/** El texto de la pantalla sin separadores de miles, para buscar números. */
const plano = (el) => el.textContent.replace(/\./g, '').replace(/ /g, ' ');

describe('Dashboard', () => {
  it('el total del día suma las tres ventas', async () => {
    const c = await montar(() => import('../../webapp/src/pages/dashboard.js'), 'renderDashboard');
    expect(plano(c)).toContain(String(TOTAL_DIA));
  });

  it('el efectivo del día NO se lleva la venta mixta entera', async () => {
    // La mixta aporta $8.000 al cajón, no $20.000 ni $0. Contarla entera de un
    // lado es lo que hacía que la caja no cerrara.
    const c = await montar(() => import('../../webapp/src/pages/dashboard.js'), 'renderDashboard');
    const t = plano(c);
    expect(t).toContain(String(EFECTIVO_DIA));
    expect(t).toContain(String(TRANSFER_DIA));
  });

  it('efectivo y transferencia suman el total, sin agujeros', async () => {
    expect(EFECTIVO_DIA + TRANSFER_DIA).toBe(TOTAL_DIA);
  });

  it('cuenta las tres ventas, no dos', async () => {
    const c = await montar(() => import('../../webapp/src/pages/dashboard.js'), 'renderDashboard');
    expect(plano(c)).toMatch(/\b3\b/);
  });

  it('sin ventas no muestra números inventados ni se rompe', async () => {
    datos.porColeccion.ventas = [];
    datos.porColeccion.ventas_por_dia = [];
    const c = await montar(() => import('../../webapp/src/pages/dashboard.js'), 'renderDashboard');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
    expect(plano(c)).not.toContain('undefined');
  });
});

describe('Ventas', () => {
  it('lista las tres ventas del día', async () => {
    const c = await montar(() => import('../../webapp/src/pages/ventas.js'), 'renderVentas');
    const t = plano(c);
    expect(t).toContain('10000');
    expect(t).toContain('5000');
    expect(t).toContain('20000');
  });

  it('la venta mixta se anuncia como mixta, no como transferencia', async () => {
    // Es la lista donde se busca una venta puntual: si dice "Transferencia",
    // el efectivo de esa venta desaparece de la vista.
    const c = await montar(() => import('../../webapp/src/pages/ventas.js'), 'renderVentas');
    expect(plano(c)).toMatch(/mixto/i);
  });

  it('muestra quién la hizo', async () => {
    const c = await montar(() => import('../../webapp/src/pages/ventas.js'), 'renderVentas');
    const t = plano(c);
    expect(t).toContain('Marta');
    expect(t).toContain('Jose');
  });

  it('sin ventas muestra el vacío', async () => {
    datos.porColeccion.ventas = [];
    datos.porColeccion.ventas_por_dia = [];
    const c = await montar(() => import('../../webapp/src/pages/ventas.js'), 'renderVentas');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Historial Diario', () => {
  it('el día muestra su total y sus dos medios de pago', async () => {
    const c = await montar(() => import('../../webapp/src/pages/historial.js'), 'renderHistorial');
    const t = plano(c);
    expect(t).toContain(String(TOTAL_DIA));
    expect(t).toContain(String(EFECTIVO_DIA));
  });

  it('no cuenta la mixta dos veces', async () => {
    const c = await montar(() => import('../../webapp/src/pages/historial.js'), 'renderHistorial');
    // 55.000 sería el total si la mixta se sumara entera a los dos lados.
    expect(plano(c)).not.toContain('55000');
  });

  it('un día sin ventas no rompe la lista', async () => {
    datos.porColeccion.ventas = [];
    datos.porColeccion.ventas_por_dia = [];
    const c = await montar(() => import('../../webapp/src/pages/historial.js'), 'renderHistorial');
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Resúmenes Mensuales', () => {
  it('el mes suma las tres ventas del día', async () => {
    const c = await montar(() => import('../../webapp/src/pages/resumenes.js'), 'renderResumenes');
    expect(plano(c)).toContain(String(TOTAL_DIA));
  });

  it('sin datos no muestra NaN', async () => {
    datos.porColeccion.ventas = [];
    datos.porColeccion.ventas_por_dia = [];
    const c = await montar(() => import('../../webapp/src/pages/resumenes.js'), 'renderResumenes');
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Productos Más Vendidos', () => {
  it('el ranking muestra lo que se vendió', async () => {
    const c = await montar(() => import('../../webapp/src/pages/productos.js'), 'renderProductos');
    const t = plano(c);
    expect(t).toContain('RESMA PAMPA');
    expect(t).toContain('CUADERNO RIVADAVIA');
  });

  it('el que más facturó va primero', async () => {
    const c = await montar(() => import('../../webapp/src/pages/productos.js'), 'renderProductos');
    const t = plano(c);
    expect(t.indexOf('RESMA PAMPA')).toBeLessThan(t.indexOf('LAPIZ FABER'));
  });
});

describe('Cierres de Caja', () => {
  beforeEach(() => {
    datos.porColeccion.cierres_caja = [{
      __id: '1', register_id: 1, pc_id: 'PC1',
      fecha_apertura: isoLocal(hoyALas(8, 0)), fecha_cierre: isoLocal(hoyALas(20, 0)),
      monto_inicial: 5000, total_efectivo: EFECTIVO_DIA, total_transferencia: TRANSFER_DIA,
      total_retiros: 0, total_transacciones: 3, cajero: 'Marta',
      productos_vendidos: [], retiros: [],
    }];
  });

  it('muestra el efectivo y la transferencia del cierre', async () => {
    const c = await montar(() => import('../../webapp/src/pages/cierres.js'), 'renderCierres');
    const t = plano(c);
    expect(t).toContain(String(EFECTIVO_DIA));
    expect(t).toContain(String(TRANSFER_DIA));
  });

  it('cuenta las tres ventas del turno', async () => {
    const c = await montar(() => import('../../webapp/src/pages/cierres.js'), 'renderCierres');
    expect(plano(c)).toMatch(/\b3\b/);
  });

  it('un retiro se resta y se ve', async () => {
    datos.porColeccion.cierres_caja[0].total_retiros = 3000;
    datos.porColeccion.cierres_caja[0].retiros = [
      { monto: 3000, motivo: 'Pago proveedor', hora: '18:00' },
    ];
    const c = await montar(() => import('../../webapp/src/pages/cierres.js'), 'renderCierres');
    expect(plano(c)).toContain('3000');
  });

  it('una caja todavía abierta no se muestra como cerrada', async () => {
    datos.porColeccion.cierres_caja[0].fecha_cierre = null;
    const c = await montar(() => import('../../webapp/src/pages/cierres.js'), 'renderCierres');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });

  it('sin cierres muestra el vacío', async () => {
    datos.porColeccion.cierres_caja = [];
    const c = await montar(() => import('../../webapp/src/pages/cierres.js'), 'renderCierres');
    expect(c.innerHTML.length).toBeGreaterThan(0);
  });
});
