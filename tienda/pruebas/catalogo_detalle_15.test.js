// @vitest-environment jsdom
/**
 * El 15% de venta suelta de un conjunto, desde la ficha del producto.
 *
 * Hasta el 09-10-2026 el precio por unidad era pack ÷ contenido × 1.15: el 15%
 * se multiplicaba sobre un precio que ya traía su margen, y un bulto al 65%
 * dejaba la unidad al 89,75%. El dueño lo piensa sumado: 65 + 15 = 80. Desde
 * ese día los productos NUEVOS calculan (pack + 15% del costo) ÷ contenido y
 * quedan marcados con `conjunto_detalle_sobre_costo`.
 *
 * Lo que no se puede romper: los productos que ya estaban cargados siguen con
 * la cuenta vieja aunque se abran y se guarden.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { datos } = vi.hoisted(() => ({
  datos: { porColeccion: {}, escrituras: [] },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  const base = firestoreFalso({ registro: datos.escrituras });
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
    onSnapshot: (_ref, cb) => {
      try { cb?.(snapshot()); } catch (_) {}
      return () => {};
    },
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

// Bulto de 10 a costo $10.000 y 65% de margen: $16.500.
const ROLLO = {
  rubro: 'MERCERIA', categoria: 'Cintas', marca: 'SIN MARCA', proveedor: 'SIN PROVEEDOR',
  costo: 10000, precio_venta: 16500, stock: 2, estado: 'activo',
  es_conjunto: true, conjunto_tipo: 'rollo', conjunto_unidad_medida: 'metros',
  conjunto_contenido: 10, conjunto_unidades: 2, conjunto_restante: 0, conjunto_total: 20,
};

// Como el Talonario Obelisco 2007: un conjunto "unidad" con una variedad que
// trae su propio bulto de 50, costo $83.300 al 65% → pack $137.400.
const TALONARIO = {
  rubro: 'LIBRERIA', categoria: 'Talonarios', marca: 'OBELISCO', proveedor: 'SIN PROVEEDOR',
  costo: 500, precio_venta: 900, stock: 10, estado: 'activo',
  es_conjunto: true, conjunto_tipo: 'unidad', conjunto_unidad_medida: 'unidades',
  conjunto_contenido: 1, conjunto_unidades: 0, conjunto_restante: 0, conjunto_total: 32,
  conjunto_colores: [
    { color: '2007', unidades: 0, restante: 32, contenido: 50,
      costo: 83300, margen: 65, precio_pack: 137400 },
  ],
};

const CATALOGO = [
  { __id: 'v1', doc_id: 'v1', id: 1, nombre: 'CINTA VIEJA', codigo: '900001', ...ROLLO },
  { __id: 'n1', doc_id: 'n1', id: 2, nombre: 'CINTA MARCADA', codigo: '900002', ...ROLLO,
    conjunto_detalle_sobre_costo: true },
  { __id: 'v2', doc_id: 'v2', id: 3, nombre: 'TALONARIO VIEJO', codigo: '900003', ...TALONARIO },
  { __id: 'n2', doc_id: 'n2', id: 4, nombre: 'TALONARIO MARCADO', codigo: '900004', ...TALONARIO,
    conjunto_detalle_sobre_costo: true },
];

let contenedor;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  datos.escrituras.length = 0;
  datos.porColeccion = {
    catalogo: CATALOGO.map(p => JSON.parse(JSON.stringify(p))),
    ventas_por_dia: [], inventario: [], inventario_resumen: [], rubros: [],
    control_config: [], config: [], stock_movimientos: [], catalogo_deleted: [],
  };
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('la prueba no sale a internet'); }));
  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
  document.body.insertAdjacentHTML('beforeend',
    '<div id="app"></div><div id="page-title"></div><div id="sidebar"></div>' +
    '<div id="status"></div><div id="bottomNav"></div>');
});

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

async function abrirCatalogo() {
  const mod = await import('../../webapp/src/pages/catalogo.js');
  await mod.renderCatalogo(contenedor, {});
  for (let i = 0; i < 8; i++) await esperar();
}

function tipear(el, valor) {
  el.value = valor;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const filaDe = (texto) => [...document.querySelectorAll('#catBody tr')]
  .find(tr => tr.textContent.includes(texto));

async function abrirFicha(nombre) {
  filaDe(nombre).querySelector('.btn-editar').click();
  for (let i = 0; i < 8; i++) await esperar();
}

async function abrirNuevo() {
  document.querySelector('.tab-btn[data-tab="nuevo"]').click();
  for (let i = 0; i < 4; i++) await esperar();
  document.getElementById('np_abrir_editor').click();
  for (let i = 0; i < 8; i++) await esperar();
}

async function guardar() {
  document.getElementById('ed_guardar').click();
  for (let i = 0; i < 12; i++) await esperar();
}

const precioUnidad = () => parseFloat(document.getElementById('ed_conj_precio_unidad').value);
const precioFila = () => parseFloat(document.querySelector('[data-color-row] .ed_color_precio').value);
const ultimoGuardado = () => datos.escrituras.filter(e => e.ref?._col === 'catalogo').at(-1)?.datos;

describe('productos que ya estaban cargados', () => {
  it('siguen con pack ÷ contenido × 1.15', async () => {
    await abrirCatalogo();
    await abrirFicha('CINTA VIEJA');
    // 16.500 ÷ 10 × 1.15
    expect(precioUnidad()).toBeCloseTo(1897.5, 2);
  });

  it('al guardarlos no se les pone la marca nueva', async () => {
    await abrirCatalogo();
    await abrirFicha('CINTA VIEJA');
    await guardar();
    const g = ultimoGuardado();
    expect(g).toBeTruthy();
    expect(g.conjunto_detalle_sobre_costo).toBeUndefined();
    expect(g.conjunto_precio_unidad).toBeCloseTo(1897.5, 2);
  });

  it('la variedad con bulto propio sigue con el × 1.15', async () => {
    await abrirCatalogo();
    await abrirFicha('TALONARIO VIEJO');
    // 137.400 ÷ 50 × 1.15
    expect(precioFila()).toBeCloseTo(3160.2, 2);
  });
});

describe('productos con la cuenta nueva', () => {
  it('suman 15 puntos sobre el costo: 65% en el bulto da 80% por unidad', async () => {
    await abrirCatalogo();
    await abrirFicha('CINTA MARCADA');
    // 10.000 ÷ 10 × 1,80
    expect(precioUnidad()).toBeCloseTo(1800, 2);
    expect(document.getElementById('ed_conj_precio_hint').textContent).toContain('margen 80%');
  });

  it('al reabrirlos y guardarlos conservan la marca', async () => {
    await abrirCatalogo();
    await abrirFicha('CINTA MARCADA');
    await guardar();
    const g = ultimoGuardado();
    expect(g.conjunto_detalle_sobre_costo).toBe(true);
    expect(g.conjunto_precio_unidad).toBeCloseTo(1800, 2);
  });

  it('la variedad con bulto propio usa su costo: el 2007 queda en 80% por unidad', async () => {
    await abrirCatalogo();
    await abrirFicha('TALONARIO MARCADO');
    // (137.400 + 15% de 83.300) ÷ 50 = 2.997,90 → margen real del pack + 15 puntos
    expect(precioFila()).toBeCloseTo(2997.9, 2);
    expect(precioFila() / (83300 / 50) - 1).toBeCloseTo((137400 / 83300 - 1) + 0.15, 6);
  });
});

describe('un producto nuevo', () => {
  it('nace con la cuenta nueva y queda marcado', async () => {
    await abrirCatalogo();
    await abrirNuevo();
    tipear(document.getElementById('ed_nombre'), 'CINTA NUEVA DE PRUEBA');
    const cb = document.getElementById('ed_es_conjunto');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await esperar();
    const tipo = document.getElementById('ed_conj_tipo');
    tipo.value = 'rollo';
    tipo.dispatchEvent(new Event('change', { bubbles: true }));
    tipear(document.getElementById('ed_conj_contenido'), '10');
    tipear(document.getElementById('ed_costo'), '10000');
    tipear(document.getElementById('ed_margen'), '65');
    await esperar();
    expect(parseFloat(document.getElementById('ed_precio').value)).toBeCloseTo(16500, 2);
    expect(precioUnidad()).toBeCloseTo(1800, 2);
  });
});
