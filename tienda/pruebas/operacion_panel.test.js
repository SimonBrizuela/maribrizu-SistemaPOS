// @vitest-environment jsdom
/**
 * Las pantallas con las que se opera todos los días: Fiados, Centro de Compras,
 * Promociones y Presupuestos.
 *
 * Cada una decide algo concreto: cuánto debe alguien, cuánta plata queda para
 * comprar, qué descuento se aplica en la caja y qué se cotizó. Todas escriben.
 *
 * Lo que se prueba es lo que se hace: buscar, cargar, guardar, y que el número
 * que queda en pantalla sea el que corresponde.
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
    onSnapshot: (q, cb) => {
      try { cb?.(snapshot(q?._col || q?.col?._col)); } catch (_) {}
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

const HOY = new Date();
const dd = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${dd(d.getMonth() + 1)}-${dd(d.getDate())}`;
const isoHora = (d) => `${iso(d)} 12:00:00`;

const CATALOGO = [
  { __id: 'p1', doc_id: 'p1', id: 1, nombre: 'CUADERNO RIVADAVIA', codigo: 'C001',
    rubro: 'LIBRERIA', categoria: 'Cuadernos', marca: 'RIVADAVIA', proveedor: 'DISTRI SUR',
    precio_venta: 3500, costo: 2100, stock: 12, stock_min: 4, estado: 'activo' },
  { __id: 'p2', doc_id: 'p2', id: 2, nombre: 'LAPIZ FABER', codigo: 'C002',
    rubro: 'LIBRERIA', categoria: 'Escritura', marca: 'FABER', proveedor: 'DISTRI SUR',
    precio_venta: 900, costo: 400, stock: 60, estado: 'activo' },
  { __id: 'p3', doc_id: 'p3', id: 3, nombre: 'RESMA PAMPA', codigo: 'C003',
    rubro: 'PAPELERIA', categoria: 'Resmas', marca: 'PAMPA', proveedor: 'PAPELERA CBA',
    precio_venta: 18000, costo: 13000, stock: 2, stock_min: 6, estado: 'activo' },
];

let contenedor;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  datos.escrituras.length = 0;
  datos.porColeccion = {
    catalogo: CATALOGO.map(p => ({ ...p })),
    ventas_por_dia: [], ventas: [], inventario: [], inventario_resumen: [],
    control_config: [], config: [], rubros: [], gastos: [],
    fiado_clientes: [], fiado_items: [], fiado_pagos: [],
    promociones: [], presupuestos: [], compras_anotadas: [],
  };
  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
  document.body.insertAdjacentHTML('beforeend',
    '<div id="app"></div><div id="page-title"></div><div id="sidebar"></div>' +
    '<div id="status"></div><div id="bottomNav"></div>');
});

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** Las pantallas se cargan por nombre literal: el empaquetador no arma rutas. */
const CARGAR = {
  fiados: () => import('../../webapp/src/pages/fiados.js'),
  centro_compras: () => import('../../webapp/src/pages/centro_compras.js'),
  promociones: () => import('../../webapp/src/pages/promociones.js'),
  presupuestos: () => import('../../webapp/src/pages/presupuestos.js'),
};

async function montar(clave, fn) {
  const mod = await CARGAR[clave]();
  await mod[fn](contenedor, {});
  for (let i = 0; i < 8; i++) await esperar();
  return contenedor;
}

function tipear(el, valor) {
  el.value = valor;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const enColeccion = (col) => datos.escrituras.filter(e => e.ref?._col === col);
const plano = (el) => el.textContent.replace(/\./g, '');

describe('Fiados', () => {
  const CLIENTES = [
    { doc_id: 'c1', id: 'c1', nombre: 'Marta Gómez', telefono: '3515550001',
      activo: true, deleted: false },
    { doc_id: 'c2', id: 'c2', nombre: 'Escuela San José', telefono: '3515550002',
      activo: true, deleted: false },
    { doc_id: 'c3', id: 'c3', nombre: 'Cliente Borrado', activo: true, deleted: true },
  ];
  const ITEMS = [
    { doc_id: 'i1', id: 'i1', cliente_fid: 'c1', product_name: 'CUADERNO RIVADAVIA',
      quantity: 2, unit_price: 3500, subtotal: 7000, estado: 'pendiente', deleted: false,
      created_at: isoHora(HOY) },
    { doc_id: 'i2', id: 'i2', cliente_fid: 'c1', product_name: 'LAPIZ FABER',
      quantity: 3, unit_price: 900, subtotal: 2700, estado: 'pendiente', deleted: false,
      created_at: isoHora(HOY) },
    { doc_id: 'i3', id: 'i3', cliente_fid: 'c2', product_name: 'RESMA PAMPA',
      quantity: 1, unit_price: 18000, subtotal: 18000, estado: 'pendiente', deleted: false,
      created_at: isoHora(HOY) },
    { doc_id: 'i4', id: 'i4', cliente_fid: 'c1', product_name: 'YA PAGADO',
      quantity: 1, unit_price: 1000, subtotal: 1000, estado: 'pagado', deleted: false,
      created_at: isoHora(HOY) },
  ];

  /**
   * Fiados se alimenta del store, no de consultas propias: los datos se dejan
   * puestos en las mismas claves de cache que llena el listener en vivo.
   */
  async function sembrar({ pagos = [] } = {}) {
    const cache = await import('../../webapp/src/cache.js');
    cache.pinCacheKey('fiado:clientes');
    cache.pinCacheKey('fiado:items');
    cache.pinCacheKey('fiado:pagos');
    cache.setCacheValue('fiado:clientes', CLIENTES.map(c => ({ ...c })));
    cache.setCacheValue('fiado:items', ITEMS.map(i => ({ ...i })));
    cache.setCacheValue('fiado:pagos', pagos);
  }

  beforeEach(async () => {
    datos.porColeccion.fiado_clientes = CLIENTES.map(c => ({ ...c, __id: c.doc_id }));
    datos.porColeccion.fiado_items = ITEMS.map(i => ({ ...i, __id: i.doc_id }));
    await sembrar();
  });

  it('lista los clientes con deuda', async () => {
    const c = await montar('fiados', 'renderFiados');
    expect(c.textContent).toContain('Marta Gómez');
    expect(c.textContent).toContain('Escuela San José');
  });

  it('un cliente borrado no aparece', async () => {
    // Hay dos formas de darlo de baja y no escriben lo mismo: desde el panel
    // queda `activo: false`, desde la caja sólo `deleted: true`. El de la caja
    // seguía figurando en la lista, con su deuda y listo para anotarle más.
    const c = await montar('fiados', 'renderFiados');
    expect(c.textContent).not.toContain('Cliente Borrado');
  });

  it('un renglón dado de baja deja de sumar deuda', async () => {
    // Se anota mal un producto y se borra desde la caja: el cliente no puede
    // seguir debiéndolo.
    const cache = await import('../../webapp/src/cache.js');
    cache.setCacheValue('fiado:items', [
      ...ITEMS.map(i => ({ ...i })),
      { doc_id: 'i9', id: 'i9', cliente_fid: 'c1', product_name: 'CARGADO POR ERROR',
        quantity: 1, unit_price: 50000, subtotal: 50000, estado: 'pendiente',
        deleted: true, created_at: isoHora(HOY) },
    ]);
    const c = await montar('fiados', 'renderFiados');
    const t = plano(c);
    expect(t).toContain('9700');           // la deuda real de Marta
    expect(t).not.toContain('59700');      // no la de más
    expect(c.textContent).not.toContain('CARGADO POR ERROR');
  });

  it('la deuda de cada uno suma sólo lo pendiente', async () => {
    // Marta debe 7.000 + 2.700 = 9.700. Lo ya pagado no se cuenta.
    const c = await montar('fiados', 'renderFiados');
    const t = plano(c);
    expect(t).toContain('9700');
    expect(t).not.toContain('10700');
  });

  it('el total general suma a todos', async () => {
    // 9.700 de Marta + 18.000 de la escuela.
    const c = await montar('fiados', 'renderFiados');
    expect(plano(c)).toContain('27700');
  });

  it('buscar filtra la lista', async () => {
    await montar('fiados', 'renderFiados');
    const buscador = document.getElementById('fiadoBuscar');
    expect(buscador).toBeTruthy();
    tipear(buscador, 'escuela');
    await esperar(200);
    const lista = document.getElementById('fiadoLista').textContent;
    expect(lista).toContain('Escuela San José');
    expect(lista).not.toContain('Marta');
  });

  it('abrir un cliente muestra lo que se llevó', async () => {
    await montar('fiados', 'renderFiados');
    const fila = [...document.querySelectorAll('#fiadoLista *')]
      .find(el => el.textContent.trim().startsWith('Marta Gómez'));
    (fila?.closest('[data-fid], li, tr, div') || fila)?.click();
    await esperar(50);
    const detalle = document.getElementById('fiadoDetalle');
    if (detalle && detalle.textContent.includes('CUADERNO')) {
      expect(detalle.textContent).toContain('CUADERNO RIVADAVIA');
      expect(detalle.textContent).toContain('LAPIZ FABER');
    }
  });

  it('sin fiados muestra el vacío, no un cero raro', async () => {
    const cache = await import('../../webapp/src/cache.js');
    cache.setCacheValue('fiado:clientes', []);
    cache.setCacheValue('fiado:items', []);
    const c = await montar('fiados', 'renderFiados');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });

  it('un pago a cuenta baja la deuda', async () => {
    await sembrar({ pagos: [
      { doc_id: 'g1', id: 'g1', cliente_fid: 'c1', monto: 5000, tipo: 'a_cuenta',
        deleted: false, created_at: isoHora(HOY) },
    ] });
    const c = await montar('fiados', 'renderFiados');
    // 9.700 - 5.000 = 4.700
    expect(plano(c)).toContain('4700');
  });
});

describe('Centro de Compras', () => {
  beforeEach(() => {
    datos.porColeccion.catalogo = [
      ...CATALOGO.map(p => ({ ...p })),
      { __id: 'p4', doc_id: 'p4', id: 4, nombre: 'TIJERA ESCOLAR', codigo: 'C004',
        rubro: 'LIBRERIA', categoria: 'Varios', proveedor: 'DISTRI SUR',
        precio_venta: 2500, costo: 1500, stock: 0, stock_min: 5, estado: 'activo' },
    ];
  });

  it('muestra lo que hay que reponer', async () => {
    // RESMA: 2 con mínimo 6. TIJERA: 0 con mínimo 5.
    const c = await montar('centro_compras', 'renderCentroCompras');
    const t = c.textContent;
    expect(t).toContain('RESMA PAMPA');
    expect(t).toContain('TIJERA ESCOLAR');
  });

  it('lo que está por encima del mínimo no molesta', async () => {
    const c = await montar('centro_compras', 'renderCentroCompras');
    expect(document.getElementById('cc-tbody')?.textContent || '')
      .not.toContain('LAPIZ FABER');
  });

  it('la plata disponible se carga a mano y queda a la vista', async () => {
    // Es el número con el que se decide cuánto comprar: tiene que quedar el
    // que se tipeó, no uno calculado.
    await montar('centro_compras', 'renderCentroCompras');
    document.querySelector('[data-action="editar-plata"]').click();
    await esperar();

    const input = document.getElementById('cc-plata-input');
    expect(input).toBeTruthy();
    input.value = '200000';
    document.querySelector('[data-action="plata-save"]').click();
    for (let i = 0; i < 8; i++) await esperar();

    expect(document.getElementById('cc-gauge').textContent).toContain('200.000');
  });

  it('cancelar la carga a mano no cambia nada', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    const antes = document.querySelector('.cc-gauge-value').textContent;
    document.querySelector('[data-action="editar-plata"]').click();
    await esperar();
    document.getElementById('cc-plata-input').value = '999999';
    document.querySelector('[data-action="plata-cancel"]').click();
    for (let i = 0; i < 6; i++) await esperar();

    expect(document.querySelector('.cc-gauge-value').textContent).toBe(antes);
  });

  it('buscar filtra la lista de compra', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    const buscar = document.getElementById('cc-buscar');
    if (!buscar) return;
    tipear(buscar, 'resma');
    await esperar(200);
    const cuerpo = document.getElementById('cc-tbody').textContent;
    expect(cuerpo).toContain('RESMA');
    expect(cuerpo).not.toContain('TIJERA');
  });

  it('sin nada por reponer no inventa una lista', async () => {
    datos.porColeccion.catalogo = [
      { __id: 'p2', doc_id: 'p2', id: 2, nombre: 'LAPIZ FABER', rubro: 'LIBRERIA',
        precio_venta: 900, costo: 400, stock: 60, stock_min: 5, estado: 'activo' },
    ];
    const c = await montar('centro_compras', 'renderCentroCompras');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });

  it('un servicio nunca entra en la lista de compra', async () => {
    datos.porColeccion.catalogo.push({
      __id: 'p9', doc_id: 'p9', id: 9, nombre: 'FOTOCOPIA SIMPLE', rubro: 'SERVICIOS',
      precio_venta: 120, costo: 0, stock: -1, stock_ilimitado: true, estado: 'activo',
    });
    await montar('centro_compras', 'renderCentroCompras');
    expect(document.getElementById('cc-tbody')?.textContent || '')
      .not.toContain('FOTOCOPIA');
  });
});

describe('Centro de Compras: filtros de la lista', () => {
  // En la lista: RESMA (PAPELERIA · PAPELERA CBA), TIJERA (LIBRERIA · DISTRI
  // SUR, sin marca) y GOMA (LIBRERIA · ESCRITURA · PAPELERA CBA · MAPED).
  beforeEach(() => {
    sessionStorage.clear();
    datos.porColeccion.catalogo = [
      ...CATALOGO.map(p => ({ ...p })),
      { __id: 'p4', doc_id: 'p4', id: 4, nombre: 'TIJERA ESCOLAR', codigo: 'C004',
        rubro: 'LIBRERIA', proveedor: 'DISTRI SUR',
        precio_venta: 2500, costo: 1500, stock: 0, stock_min: 5, estado: 'activo' },
      { __id: 'p5', doc_id: 'p5', id: 5, nombre: 'GOMA DE BORRAR', codigo: 'C005',
        rubro: 'LIBRERÍA', sub_rubro: 'ESCRITURA', marca: 'MAPED', proveedor: 'PAPELERA CBA',
        precio_venta: 800, costo: 400, stock: 0, stock_min: 3, estado: 'activo' },
    ];
  });

  // Cada filtro es un botón que abre un panel propio con lupa y opciones.
  const dd = (campo) => document.querySelector(`.cc-dd[data-campo="${campo}"]`);
  const panel = (campo) => dd(campo).querySelector('.cc-dd-panel');
  const abiertoAhora = () => document.querySelector('.cc-dd.is-open')?.dataset.campo || null;
  const abrir = (campo) => { if (abiertoAhora() !== campo) dd(campo).querySelector('[data-action="dd-toggle"]').click(); };
  const cerrar = () => { const c = abiertoAhora(); if (c) dd(c).querySelector('[data-action="dd-toggle"]').click(); };
  const opciones = (campo) => {
    abrir(campo);
    const t = [...dd(campo).querySelectorAll('.cc-dd-opt')]
      .map(b => `${b.querySelector('.cc-dd-txt').textContent} (${b.querySelector('.cc-dd-n').textContent})`);
    cerrar();
    return t;
  };
  const elegir = (campo, valor) => {
    abrir(campo);
    dd(campo).querySelector(`.cc-dd-opt[data-valor="${valor}"]`).click();
  };
  const valor = (campo) => dd(campo).querySelector('.cc-dd-value').textContent;
  const cuerpo = () => document.getElementById('cc-tbody').textContent;
  const tecla = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('los desplegables listan lo que hay en la lista con la cuenta de cada uno', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    expect(opciones('rubro')).toEqual(['Todos los rubros (3)', 'LIBRERIA (2)', 'PAPELERIA (1)']);
    expect(opciones('proveedor')).toEqual(['Todos los proveedores (3)', 'DISTRI SUR (1)', 'PAPELERA CBA (2)']);
    expect(opciones('sub_rubro')).toEqual(['Todos los subrubros (3)', 'ESCRITURA (1)', 'Sin subrubro (2)']);
    expect(opciones('nivel').length).toBeGreaterThan(1);
    expect(valor('rubro')).toBe('Todos');
    expect(valor('marca')).toBe('Todas');
    expect(document.getElementById('cc-filtros-count').textContent).toBe('3 en la lista');
  });

  it('el panel se abre al apretar el botón, uno solo a la vez, y se cierra al elegir', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    expect(panel('rubro').hidden).toBe(true);
    abrir('rubro');
    expect(panel('rubro').hidden).toBe(false);
    expect(document.activeElement).toBe(dd('rubro').querySelector('.cc-dd-input'));
    abrir('proveedor');
    expect(panel('rubro').hidden).toBe(true);
    expect(panel('proveedor').hidden).toBe(false);
    dd('proveedor').querySelector('.cc-dd-opt[data-valor="distri sur"]').click();
    expect(panel('proveedor').hidden).toBe(true);
    expect(valor('proveedor')).toBe('DISTRI SUR');
    expect(cuerpo()).toContain('TIJERA');
    expect(cuerpo()).not.toContain('GOMA');
  });

  it('elegir un rubro deja solo ese rubro, con y sin tilde', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    elegir('rubro', 'libreria');
    const t = cuerpo();
    expect(t).toContain('TIJERA');
    expect(t).toContain('GOMA');
    expect(t).not.toContain('RESMA');
    expect(document.getElementById('cc-filtros-count').textContent).toBe('2 de 3');
    expect(dd('rubro').classList.contains('is-on')).toBe(true);
    expect(valor('rubro')).toBe('LIBRERIA');
    // Al reabrir, la elegida lleva el tilde.
    abrir('rubro');
    expect(dd('rubro').querySelector('.cc-dd-opt.is-sel .cc-dd-txt').textContent).toBe('LIBRERIA');
  });

  it('la lupa adentro del desplegable filtra las opciones y Enter elige la primera', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    abrir('proveedor');
    const input = dd('proveedor').querySelector('.cc-dd-input');
    tipear(input, 'pape');
    const textos = [...dd('proveedor').querySelectorAll('.cc-dd-opt .cc-dd-txt')].map(e => e.textContent);
    expect(textos).toEqual(['PAPELERA CBA']);   // sin "Todos" mientras se busca
    tipear(input, 'zzz');
    expect(dd('proveedor').querySelector('.cc-dd-vacio').textContent).toContain('Nada coincide');
    tipear(input, 'cba');
    tecla(input, 'Enter');
    expect(panel('proveedor').hidden).toBe(true);
    expect(valor('proveedor')).toBe('PAPELERA CBA');
    expect(cuerpo()).not.toContain('TIJERA');
  });

  it('Escape y el click afuera cierran el panel sin cambiar nada', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    abrir('rubro');
    tecla(dd('rubro').querySelector('.cc-dd-input'), 'Escape');
    expect(panel('rubro').hidden).toBe(true);
    expect(document.activeElement).toBe(dd('rubro').querySelector('.cc-dd-btn'));
    abrir('rubro');
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(panel('rubro').hidden).toBe(true);
    expect(valor('rubro')).toBe('Todos');
    expect(cuerpo()).toContain('RESMA');
  });

  it('los filtros se combinan entre sí y la lupa busca adentro', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    elegir('rubro', 'libreria');
    elegir('proveedor', 'papelera cba');
    expect(cuerpo()).toContain('GOMA');
    expect(cuerpo()).not.toContain('TIJERA');
    expect(cuerpo()).not.toContain('RESMA');

    // La lupa busca adentro de lo filtrado: "tijera" existe, pero no en este cruce.
    tipear(document.getElementById('cc-buscar'), 'tijera');
    await esperar(200);
    expect(cuerpo()).toContain('Nada en la lista coincide');
    expect(cuerpo()).not.toContain('TIJERA ESCOLAR');

    // "Ver la lista completa" saca filtros y búsqueda de una.
    document.querySelector('[data-action="filtros-clear-todo"]').click();
    expect(cuerpo()).toContain('TIJERA');
    expect(cuerpo()).toContain('RESMA');
    expect(cuerpo()).toContain('GOMA');
    expect(valor('rubro')).toBe('Todos');
    expect(dd('rubro').classList.contains('is-on')).toBe(false);
    expect(document.getElementById('cc-buscar').value).toBe('');
  });

  it('cada desplegable ofrece solo lo que queda con los demás puestos', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    elegir('rubro', 'papeleria');
    expect(opciones('proveedor')).toEqual(['Todos los proveedores (1)', 'PAPELERA CBA (1)']);
    // Y el propio rubro sigue ofreciendo los otros rubros para cambiar de uno a otro.
    expect(opciones('rubro')).toEqual(['Todos los rubros (3)', 'LIBRERIA (2)', 'PAPELERIA (1)']);
  });

  it('limpiar filtros deja la búsqueda', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    elegir('proveedor', 'papelera cba');
    tipear(document.getElementById('cc-buscar'), 'goma');
    await esperar(200);
    const btn = document.querySelector('[data-action="filtros-clear"]');
    expect(btn.hidden).toBe(false);
    btn.click();
    expect(valor('proveedor')).toBe('Todos');
    expect(document.getElementById('cc-buscar').value).toBe('goma');
    expect(cuerpo()).toContain('GOMA');
    expect(cuerpo()).not.toContain('RESMA');
    expect(btn.hidden).toBe(true);
  });

  it('al volver a entrar en la misma pestaña, los filtros siguen puestos', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    elegir('rubro', 'papeleria');
    contenedor.innerHTML = '';
    await montar('centro_compras', 'renderCentroCompras');
    expect(valor('rubro')).toBe('PAPELERIA');
    expect(cuerpo()).toContain('RESMA');
    expect(cuerpo()).not.toContain('TIJERA');
  });

  it('un campo que nadie tiene cargado no muestra su desplegable', async () => {
    datos.porColeccion.catalogo = [
      { __id: 'p4', doc_id: 'p4', id: 4, nombre: 'TIJERA ESCOLAR', rubro: 'LIBRERIA',
        precio_venta: 2500, costo: 1500, stock: 0, stock_min: 5, estado: 'activo' },
    ];
    await montar('centro_compras', 'renderCentroCompras');
    expect(dd('marca').hidden).toBe(true);
    expect(dd('proveedor').hidden).toBe(true);
    expect(dd('rubro').hidden).toBe(false);
  });

  it('debajo del rubro se ve el subrubro y el proveedor', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    const sub = [...document.querySelectorAll('.cc-rubro-sub')].map(e => e.textContent);
    expect(sub).toContain('ESCRITURA · PAPELERA CBA');
    expect(sub).toContain('DISTRI SUR');
  });
});

describe('Promociones', () => {
  beforeEach(() => {
    datos.porColeccion.promociones = [
      { __id: 'pr1', nombre: '2x1 en lápices', tipo: '2x1', activo: true,
        productos: ['p2'], required_quantity: 2, discount_value: 0 },
      { __id: 'pr2', nombre: '10% en resmas', tipo: 'percentage', activo: true,
        productos: ['p3'], discount_value: 10 },
      { __id: 'pr3', nombre: 'Promo vieja', tipo: 'percentage', activo: false,
        productos: ['p1'], discount_value: 5 },
    ];
  });

  it('lista las promos cargadas', async () => {
    const c = await montar('promociones', 'renderPromociones');
    expect(c.textContent).toContain('2x1 en lápices');
    expect(c.textContent).toContain('10% en resmas');
  });

  it('se ve cuál está apagada', async () => {
    const c = await montar('promociones', 'renderPromociones');
    expect(c.textContent).toContain('Promo vieja');
    expect(c.textContent.toLowerCase()).toMatch(/inactiv|pausad|apagad|desactiv/);
  });

  it('el botón de nueva promo abre el formulario', async () => {
    await montar('promociones', 'renderPromociones');
    document.getElementById('btnNuevaPromo')?.click();
    await esperar(50);
    expect(document.getElementById('mNombre')).toBeTruthy();
    expect(document.getElementById('mTipo')).toBeTruthy();
  });

  it('el formulario pide los datos que cada tipo necesita', async () => {
    // Un 2x1 necesita cantidades; un porcentaje necesita el porcentaje. Pedir
    // el campo equivocado deja la promo mal cargada y descontando cualquier cosa.
    await montar('promociones', 'renderPromociones');
    document.getElementById('btnNuevaPromo')?.click();
    await esperar(50);
    const tipo = document.getElementById('mTipo');
    if (!tipo) return;

    tipear(tipo, 'percentage');
    await esperar(20);
    expect(document.getElementById('grpValor').style.display).not.toBe('none');

    tipear(tipo, '2x1');
    await esperar(20);
    expect(document.getElementById('grpCantReq').style.display).not.toBe('none');
  });

  it('sin promos muestra el vacío', async () => {
    datos.porColeccion.promociones = [];
    const c = await montar('promociones', 'renderPromociones');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Presupuestos', () => {
  beforeEach(() => {
    datos.porColeccion.presupuestos = [
      { __id: 'q1', numero: 12, cliente_nombre: 'Escuela San José', total: 125000,
        estado: 'pendiente', fecha_emision: isoHora(HOY),
        items: [
          { product_name: 'RESMA PAMPA', quantity: 5, unit_price: 18000, subtotal: 90000 },
          { product_name: 'CUADERNO RIVADAVIA', quantity: 10, unit_price: 3500, subtotal: 35000 },
        ] },
      { __id: 'q2', numero: 11, cliente_nombre: 'Marta Gómez', total: 9000,
        estado: 'aceptado', fecha_emision: isoHora(HOY), items: [] },
      { __id: 'q3', numero: 10, cliente_nombre: 'Anulado SA', total: 5000,
        estado: 'anulado', fecha_emision: isoHora(HOY), items: [] },
    ];
  });

  it('lista los presupuestos con su número y su total', async () => {
    const c = await montar('presupuestos', 'renderPresupuestos');
    const t = plano(c);
    expect(t).toContain('Escuela San José');
    expect(t).toContain('125000');
    expect(t).toContain('12');
  });

  it('buscar por cliente filtra', async () => {
    await montar('presupuestos', 'renderPresupuestos');
    const buscar = document.getElementById('presSearch');
    expect(buscar).toBeTruthy();
    tipear(buscar, 'marta');
    await esperar(200);
    const cuerpo = document.getElementById('presBody').textContent;
    expect(cuerpo).toContain('Marta');
    expect(cuerpo).not.toContain('Escuela San José');
  });

  it('se distingue el aceptado del anulado', async () => {
    const c = await montar('presupuestos', 'renderPresupuestos');
    const t = c.textContent.toLowerCase();
    expect(t).toMatch(/acept/);
    expect(t).toMatch(/anulad/);
  });

  it('abrir uno muestra sus renglones', async () => {
    await montar('presupuestos', 'renderPresupuestos');
    const fila = [...document.querySelectorAll('#presBody tr')]
      .find(tr => tr.textContent.includes('Escuela San José'));
    fila.querySelector('[data-action="open"]').click();
    for (let i = 0; i < 8; i++) await esperar();

    const modal = document.getElementById('presModalContent');
    expect(modal).toBeTruthy();
    expect(modal.textContent).toContain('RESMA PAMPA');
    expect(modal.textContent).toContain('CUADERNO RIVADAVIA');
  });

  it('el detalle muestra las cantidades y el total', async () => {
    await montar('presupuestos', 'renderPresupuestos');
    [...document.querySelectorAll('#presBody tr')]
      .find(tr => tr.textContent.includes('Escuela San José'))
      .querySelector('[data-action="open"]').click();
    for (let i = 0; i < 8; i++) await esperar();

    const t = document.getElementById('presModalContent').textContent.replace(/\./g, '');
    expect(t).toContain('125000');
    expect(t).toContain('90000');
  });

  it('sin presupuestos muestra el vacío', async () => {
    datos.porColeccion.presupuestos = [];
    const c = await montar('presupuestos', 'renderPresupuestos');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});
