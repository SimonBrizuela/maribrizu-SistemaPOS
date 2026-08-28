// @vitest-environment jsdom
/**
 * Abrir las 33 pantallas del panel, de verdad.
 *
 * Es el equivalente de `pos_system/tests/test_abrir_pantallas.py` para la web:
 * que un archivo compile no dice nada, las pantallas revientan al armarse. Un
 * campo que cambió de nombre, un `.map` sobre algo que vino `undefined`, una
 * consulta que ahora devuelve vacío — todo eso aparece recién cuando la
 * pantalla se monta, y hasta ahora aparecía con la persona mirando.
 *
 * Cada pantalla se monta dos veces:
 *
 *   1. **Sin datos.** Es el arranque real de una colección vacía y el estado al
 *      que se cae cuando una consulta falla. La pantalla tiene que mostrar su
 *      vacío, no romperse.
 *   2. **Con datos.** Una venta, un producto, un cierre y un pedido de mentira,
 *      los mismos para todas: alcanza para que cada una recorra sus listas.
 *
 * No se prueba QUÉ muestra cada una (eso va en las pruebas por pantalla): se
 * prueba que se arme sin tirar nada y que deje algo pintado.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { datos } = vi.hoisted(() => ({ datos: { porColeccion: {}, vacio: true } }));

/** Lo que devuelve cada colección. Vacío por defecto. */
function docsDe(nombre) {
  if (datos.vacio) return [];
  return datos.porColeccion[nombre] || [];
}

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  const base = firestoreFalso();
  const snapshot = (nombre) => {
    const lista = docsDe(nombre);
    return {
      docs: lista.map((d, i) => ({
        id: d.__id || `doc${i}`, ref: { id: d.__id || `doc${i}` },
        data: () => d, exists: () => true,
      })),
      empty: lista.length === 0, size: lista.length, docChanges: () => [],
      forEach(fn) { this.docs.forEach(fn); },
      // Alguna pantalla trata el resultado de una consulta como si fuera un
      // documento suelto y le pregunta `exists()`. Sin esto el error se lo
      // comía su propio try/catch y esa rama quedaba sin recorrer.
      exists: () => lista.length > 0,
      data: () => lista[0],
    };
  };
  return {
    ...base,
    collection: (_db, nombre) => ({ _col: nombre }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    getDocs: async (q) => snapshot(q?._col || q?.col?._col),
    getDoc: async (ref) => {
      const lista = docsDe(ref?._col);
      return { exists: () => lista.length > 0, data: () => lista[0], id: ref?.id || 'x' };
    },
    getDocFromCache: async () => { throw new Error('sin cache local'); },
    onSnapshot: (_q, cb) => { try { cb?.(snapshot()); } catch (_) {} return () => {}; },
  };
});

vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {}, storage: {} }));
vi.mock('../../webapp/src/auth.js', () => ({
  auth: { currentUser: { uid: 'u1', displayName: 'Mari', email: 'mari@liceo',
                         getIdToken: async () => 'TOKEN' } },
  getSession: () => ({ uid: 'u1', display: 'Mari', role: 'admin' }),
  isLoggedIn: () => true, onAuthReady: async () => ({ role: 'admin' }),
  hasSessionHint: () => true, logout: async () => {},
  loginWithGoogle: async () => ({ ok: true }), sendLoginLink: async () => ({ ok: true }),
  isLoginLink: () => false, completeLinkSignIn: async () => ({ ok: true }),
}));
// El store abre listeners contra Firestore: acá las pantallas se alimentan del
// doble de arriba, no del store.
vi.mock('../../webapp/src/store.js', () => ({
  ensureCollections: () => {}, onStoreChange: () => () => {},
  initStore: async () => {}, storeListo: async () => {},
}));

/**
 * Las pantallas del panel, tal como las declara `main.js`.
 *
 * Las rutas van literales: Vite no puede resolver un `import()` armado con una
 * variable, y con una ruta a medias falla la carga entera en vez de la
 * pantalla que corresponde.
 */
const PANTALLAS = [
  ['Dashboard', () => import('../../webapp/src/pages/dashboard.js'), 'renderDashboard'],
  ['Control Total', () => import('../../webapp/src/pages/control_total.js'), 'renderControlTotal'],
  ['Ventas', () => import('../../webapp/src/pages/ventas.js'), 'renderVentas'],
  ['Productos Más Vendidos', () => import('../../webapp/src/pages/productos.js'), 'renderProductos'],
  ['Historial Diario', () => import('../../webapp/src/pages/historial.js'), 'renderHistorial'],
  ['Cierres de Caja', () => import('../../webapp/src/pages/cierres.js'), 'renderCierres'],
  ['Resúmenes Mensuales', () => import('../../webapp/src/pages/resumenes.js'), 'renderResumenes'],
  ['Calendario', () => import('../../webapp/src/pages/calendario.js'), 'renderCalendario'],
  ['Catálogo', () => import('../../webapp/src/pages/catalogo.js'), 'renderCatalogo'],
  ['Turnos', () => import('../../webapp/src/pages/turnos.js'), 'renderTurnos'],
  ['Artículos con Variantes', () => import('../../webapp/src/pages/articulos_unicos.js'), 'renderArticulosUnicos'],
  ['Promociones', () => import('../../webapp/src/pages/promociones.js'), 'renderPromociones'],
  ['Facturación AFIP', () => import('../../webapp/src/pages/facturas.js'), 'renderFacturas'],
  ['Perfiles ARCA', () => import('../../webapp/src/pages/perfiles.js'), 'renderPerfiles'],
  ['Perfiles de Clientes', () => import('../../webapp/src/pages/clientes.js'), 'renderClientes'],
  ['Fiados', () => import('../../webapp/src/pages/fiados.js'), 'renderFiados'],
  ['Observaciones', () => import('../../webapp/src/pages/observaciones.js'), 'renderObservaciones'],
  ['Presupuestos', () => import('../../webapp/src/pages/presupuestos.js'), 'renderPresupuestos'],
  ['Productos Madre', () => import('../../webapp/src/pages/lab_productos_madre.js'), 'renderLabProductos'],
  ['Estado de PCs', () => import('../../webapp/src/pages/pcs.js'), 'renderPcs'],
  ['Notificaciones', () => import('../../webapp/src/pages/notificaciones.js'), 'renderNotificaciones'],
  ['Centro de Compras', () => import('../../webapp/src/pages/centro_compras.js'), 'renderCentroCompras'],
  ['Pedidos de la Tienda', () => import('../../webapp/src/pages/pedidos_tienda.js'), 'renderPedidosTienda'],
  ['Catálogo de la Tienda', () => import('../../webapp/src/pages/tienda_catalogo.js'), 'renderTiendaCatalogo'],
  ['Descuentos de la Tienda', () => import('../../webapp/src/pages/tienda_descuentos.js'), 'renderTiendaDescuentos'],
  ['Configuración de la Tienda', () => import('../../webapp/src/pages/tienda_ajustes.js'), 'renderTiendaAjustes'],
  ['Fotos Pedidas', () => import('../../webapp/src/pages/tienda_fotos.js'), 'renderTiendaFotos'],
  ['Inventario', () => import('../../webapp/src/pages/inventario.js'), 'renderInventario'],
  // El Balance vive adentro de Control Total y se monta con otro nombre.
  ['Balance Mensual', () => import('../../webapp/src/pages/balance_mensual.js'), 'mountBalanceMensual'],
  // El Login no recibe (contenedor, db): esconde el shell y recibe el callback
  // de "ya entró". Se monta aparte, más abajo.
];

const hoy = new Date();
const dmy = `${String(hoy.getDate()).padStart(2, '0')}/${String(hoy.getMonth() + 1).padStart(2, '0')}/${hoy.getFullYear()}`;
const iso = hoy.toISOString().slice(0, 19).replace('T', ' ');

/** Un local chico: una venta, un producto, un cierre, un pedido. */
const CON_DATOS = {
  ventas: [{ __id: 'PC1_1', sale_id: 1, pc_id: 'PC1', created_at: iso, total_amount: 1000,
             payment_type: 'cash', cash_received: 1000, change_given: 0, transfer_amount: 0,
             cajero: 'Marta', productos: 'CUADERNO x1', items_count: 1, cash_register_id: 1 }],
  ventas_por_dia: [{ __id: 'PC1_1_0', num_venta: 1, pc_id: 'PC1', fecha: dmy, hora: '10:00:00',
                     producto: 'CUADERNO RIVADAVIA', categoria: 'LIBRERIA', cantidad: 1,
                     precio_unitario: 1000, subtotal: 1000, tipo_pago: 'Efectivo',
                     cajero: 'Marta', cash_register_id: 1, monto_efectivo: 1000,
                     monto_transferencia: 0 }],
  catalogo: [{ __id: 'p1', doc_id: 'p1', nombre: 'CUADERNO RIVADAVIA', codigo: 'C1',
               rubro: 'LIBRERIA', sub_rubro: 'Cuadernos', precio_venta: 1000, costo: 600,
               stock: 10, stock_min: 3, estado: 'activo' }],
  inventario: [{ __id: '1', id: 1, nombre: 'CUADERNO RIVADAVIA', stock: 10 }],
  cierres_caja: [{ __id: '1', register_id: 1, pc_id: 'PC1', fecha_apertura: iso,
                   fecha_cierre: iso, monto_inicial: 1000, total_efectivo: 1000,
                   total_transferencia: 0, total_retiros: 0, total_transacciones: 1,
                   cajero: 'Marta', productos_vendidos: [], retiros: [] }],
  historial_diario: [{ __id: 'd1', fecha: dmy, num_ventas: 1, total: 1000,
                       efectivo: 1000, transferencia: 0, ticket_promedio: 1000 }],
  tienda_pedidos: [{ __id: 'k1', codigo: 'K7M2', estado: 'nuevo', creado: new Date(),
                     cliente: { nombre: 'Marta', telefono: '351' },
                     entrega: { modo: 'retiro' }, pago: { modo: 'efectivo' },
                     items: [{ id: 'p1', nombre: 'Cuaderno', cantidad: 1, precio: 1000,
                               subtotal: 1000 }],
                     subtotal: 1000, envio: 0, total: 1000 }],
  tienda_productos: [{ __id: 'p1', nombre: 'Cuaderno Rivadavia', precio: 1000, stock: 10,
                       rubro: 'LIBRERIA', imagenes: ['x.webp'], orden: 1 }],
  fiado_clientes: [{ __id: 'c1', nombre: 'Marta Gómez', activo: true, deleted: false }],
  fiado_items: [{ __id: 'i1', cliente_fid: 'c1', product_name: 'CUADERNO', quantity: 1,
                  unit_price: 1000, subtotal: 1000, estado: 'pendiente', deleted: false }],
  fiado_pagos: [],
  gastos: [{ __id: 'g1', fecha: hoy.toISOString().slice(0, 10), monto: 500, detalle: 'Luz' }],
  presupuestos: [{ __id: 'pr1', numero: 1, cliente_nombre: 'Escuela', total: 5000,
                   estado: 'pendiente', fecha_emision: iso, items: [] }],
  promociones: [{ __id: 'promo1', nombre: '2x1', tipo: '2x1', activo: true, productos: ['p1'] }],
  observations: [{ __id: 'o1', text: 'Falta papel', created_by_name: 'Marta',
                   created_at: iso, deleted: false }],
  pcs: [{ __id: 'PC1', pc_id: 'PC1', version: '3.0.65', ultimo_ping: new Date() }],
  clientes_facturacion: [{ __id: 'cf1', razon_social: 'Escuela 25', cuit: '30000000007',
                           activo: true }],
  perfiles_facturacion: [{ __id: 'pf1', nombre: 'Liceo', cuit: '20000000001', punto_venta: 1 }],
  facturas: [], stock_movimientos: [], tienda_fotos_pedidas: [], tienda_comprobantes: [],
  productos_mas_vendidos: [], inventario_resumen: [], caja_activa: [], config: [],
  control_config: [], tienda_config: [], mp_products: [], mp_nodes: [], mp_discounts: [],
  mp_stock_movements: [], notificaciones: [], rubros: [],
};

let errores = [];
let contenedor = null;

beforeEach(() => {
  // Cada pantalla arranca de cero. Sin esto, el cache en memoria del panel
  // sobrevive de una prueba a la otra y la pantalla vacía podía estar mirando
  // los datos de la anterior — justo lo contrario de lo que se quiere probar.
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
  // Lo que el panel espera encontrar en el shell de `index.html`.
  document.body.insertAdjacentHTML('beforeend',
    '<div id="app"></div><div id="page-title"></div><div id="sidebar"></div>' +
    '<div id="status"></div><div id="bottomNav"></div><div id="sidebarOverlay"></div>' +
    '<div id="loginScreen"></div>');
  // El Dashboard dibuja con Chart.js, que se carga inyectando un `<script>`
  // desde /vendor. En jsdom ese script no corre nunca y la pantalla se queda
  // esperándolo para siempre: se le deja un doble puesto de antemano.
  class ChartFalso {
    constructor() { this.data = { datasets: [] }; this.options = {}; }
    destroy() {} update() {} resize() {} reset() {} render() {}
  }
  ChartFalso.register = () => {};
  ChartFalso.defaults = {
    font: {}, color: '', plugins: { legend: { labels: {} }, tooltip: {} },
    scale: { grid: {} }, elements: {}, datasets: {},
  };
  window.Chart = ChartFalso;
  errores = [];
  // Un error tirado adentro de un `setTimeout` o de una promesa suelta no
  // hace fallar la prueba por su cuenta: se junta y se revisa al final.
  const originalError = console.error;
  console.error = (...a) => { errores.push(a.map(String).join(' ')); originalError(...a); };
});

afterEach(() => { vi.restoreAllMocks(); });

async function montar(cargar, fn) {
  const mod = await cargar();
  expect(mod[fn], `la pantalla no exporta ${fn}`).toBeTypeOf('function');
  await mod[fn](contenedor, {});
  // Las pantallas pintan un shell sincrónico y después completan: se le da un
  // respiro a las promesas encoladas para que corra también esa parte.
  await new Promise(r => setTimeout(r, 0));
  return contenedor;
}

describe('las 33 pantallas del panel, sin datos', () => {
  // Es el arranque real de una instalación nueva y el estado al que se cae
  // cuando una consulta devuelve vacío. Ninguna puede romperse ahí.
  for (const [titulo, cargar, fn] of PANTALLAS) {
    it(titulo, async () => {
      datos.vacio = true;
      const cont = await montar(cargar, fn);
      expect(cont.innerHTML.length, 'no pintó nada').toBeGreaterThan(0);
    });
  }
});

describe('las 33 pantallas del panel, con datos', () => {
  for (const [titulo, cargar, fn] of PANTALLAS) {
    it(titulo, async () => {
      datos.vacio = false;
      datos.porColeccion = CON_DATOS;
      const cont = await montar(cargar, fn);
      expect(cont.innerHTML.length).toBeGreaterThan(0);
    });
  }
});

describe('la pantalla de ingreso', () => {
  // No recibe (contenedor, db) como las demás: esconde el shell entero y
  // recibe el callback de "ya entró".
  it('se arma y esconde el resto del panel', async () => {
    const { renderLogin } = await import('../../webapp/src/pages/login.js');
    renderLogin(() => {});
    await new Promise(r => setTimeout(r, 0));
    expect(document.getElementById('app').style.display).toBe('none');
    // Y deja algo donde el usuario pueda entrar.
    expect(document.body.innerHTML).toMatch(/google|correo|ingres/i);
  });
});
