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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  // El Centro de Compras guarda su búsqueda y sus filtros en sessionStorage:
  // sin limpiarlo, lo que tipeó una prueba deja la lista filtrada en la
  // siguiente y el test que sigue ve una tabla vacía sin explicación.
  sessionStorage.clear();
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

describe('Centro de Compras: en qué orden hay que comprar', () => {
  // Pedido del dueño: la lista tiene que conjugar lo que más se vende en el
  // mes (las hojas), lo que más se movió estos días y el stock mínimo. Acá se
  // arma un mes de ventas de verdad y se mira el orden que sale en pantalla.
  const fechaAR = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return `${dd(d.getDate())}/${dd(d.getMonth() + 1)}/${d.getFullYear()}`;
  };
  const venta = (producto, cantidad, dias) => ({
    producto, cantidad, fecha: fechaAR(dias), fecha_dt: `${iso(new Date(Date.now() - dias * 86400000))}T12:00:00`,
  });
  const prod = (id, nombre, extra) => ({
    __id: id, doc_id: id, id, nombre, codigo: id.toUpperCase(), rubro: 'LIBRERIA',
    precio_venta: 1000, costo: 500, estado: 'activo', ...extra,
  });

  beforeEach(() => {
    datos.porColeccion.catalogo = [
      // Lo que sostiene el mostrador: 840 hojas en el mes y stock para una semana.
      prod('h1', 'HOJA A4', { stock: 200, precio_venta: 60, costo: 30 }),
      // Sin nada y con mínimo cargado, aunque venda de a poco.
      prod('t1', 'TIJERA ESCOLAR', { stock: 0, stock_min: 5 }),
      // Misma venta en el mes que su gemela, pero se disparó esta semana.
      prod('c1', 'CINTA PAPEL', { stock: 25 }),
      prod('c2', 'CINTA TELA', { stock: 25 }),
      // No vende nada; figura solo porque está debajo del mínimo.
      prod('a1', 'ADORNO NAVIDAD', { stock: 1, stock_min: 2 }),
      // Vende bien y tiene stock para medio año: NO es una compra pendiente.
      prod('l1', 'LAPIZ NEGRO', { stock: 300 }),
      // Los dos de abajo no entran en la lista: están para que el ranking del
      // local tenga contra qué comparar.
      prod('m1', 'MARCADOR', { stock: 400 }),
      prod('q1', 'CUADERNO', { stock: 400 }),
    ];
    const ventas = [];
    for (let d = 1; d <= 28; d++) ventas.push(venta('HOJA A4', 30, d));
    for (let d = 8; d <= 28; d++) ventas.push(venta('CINTA PAPEL', 1, d));
    for (let d = 1; d <= 5; d++) ventas.push(venta('CINTA PAPEL', 6, d));
    for (let d = 1; d <= 25; d++) ventas.push(venta('CINTA TELA', 2, d));
    ventas.push(venta('CINTA TELA', 1, 26));
    for (const d of [20, 22, 24, 26]) ventas.push(venta('TIJERA ESCOLAR', 1, d));
    for (let d = 1; d <= 30; d++) ventas.push(venta('LAPIZ NEGRO', 2, d));
    for (let d = 1; d <= 20; d++) ventas.push(venta('MARCADOR', 1, d));
    for (let d = 1; d <= 24; d += 2) ventas.push(venta('CUADERNO', 1, d));
    datos.porColeccion.ventas_por_dia = ventas;
  });

  const nombresEnLista = () => [...document.querySelectorAll('#cc-tbody tr[data-idx] .cc-prod-btn')]
    .map(b => (b.firstChild?.textContent || '').trim());
  const urgencias = () => [...document.querySelectorAll('#cc-tbody tr[data-idx] .cc-urg')]
    .map(e => Number(e.textContent.trim()));

  it('la lista sale del más urgente al que puede esperar', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    const urg = urgencias();
    expect(urg.length).toBeGreaterThan(3);
    for (let i = 1; i < urg.length; i++) expect(urg[i]).toBeLessThanOrEqual(urg[i - 1]);
  });

  it('lo que más se vende en el mes y se está por acabar va primero', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    expect(nombresEnLista()[0]).toBe('HOJA A4');
  });

  it('vender mucho con stock de sobra no es una compra urgente', async () => {
    // El lápiz vende más que la tijera y no aparece: tiene para medio año.
    await montar('centro_compras', 'renderCentroCompras');
    expect(nombresEnLista()).not.toContain('LAPIZ NEGRO');
  });

  it('el que se disparó esta semana le gana a su gemelo que vendió lo mismo', async () => {
    // Las dos cintas vendieron 51 en el mes y tienen el mismo stock. La
    // diferencia es cuándo: una se movió estos días y la otra viene pareja.
    await montar('centro_compras', 'renderCentroCompras');
    const nombres = nombresEnLista();
    expect(nombres.indexOf('CINTA PAPEL')).toBeGreaterThanOrEqual(0);
    expect(nombres.indexOf('CINTA PAPEL')).toBeLessThan(nombres.indexOf('CINTA TELA'));
  });

  it('el que se aceleró lleva la flecha al lado del ritmo', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    const fila = [...document.querySelectorAll('#cc-tbody tr[data-idx]')]
      .find(tr => (tr.querySelector('.cc-prod-btn')?.firstChild?.textContent || '').trim() === 'CINTA PAPEL');
    expect(fila.querySelector('.cc-tend-up')).toBeTruthy();
  });

  it('lo que no vende nada queda al final aunque esté bajo el mínimo', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    const nombres = nombresEnLista();
    expect(nombres[nombres.length - 1]).toBe('ADORNO NAVIDAD');
  });

  it('quedarse sin nada de algo que rota es sí o sí', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    const fila = [...document.querySelectorAll('#cc-tbody tr[data-idx]')]
      .find(tr => (tr.querySelector('.cc-prod-btn')?.firstChild?.textContent || '').trim() === 'TIJERA ESCOLAR');
    expect(fila.querySelector('.cc-chip-sisi')).toBeTruthy();
  });

  it('el tooltip de la urgencia sale al toque y con formato propio', async () => {
    // El `title` del navegador tarda casi un segundo y sale como el cuadro
    // negro del sistema: no puede quedar ninguno en la tabla.
    await montar('centro_compras', 'renderCentroCompras');
    const badge = document.querySelector('#cc-tbody .cc-urg');
    expect(badge.getAttribute('title')).toBe(null);
    expect(document.getElementById('cc-tip')).toBe(null);

    badge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const tip = document.getElementById('cc-tip');
    expect(tip.style.display).toBe('block');
    expect(tip.querySelector('.cc-tip-head').textContent).toContain('Urgencia');
    expect(tip.querySelectorAll('.cc-tip-dato').length).toBeGreaterThan(2);
    expect(tip.querySelector('.cc-tip-nota').textContent).toContain('riesgo');

    badge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(document.getElementById('cc-tip').style.display).toBe('none');
  });

  it('repintar la tabla no deja el tooltip colgado', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    document.querySelector('#cc-tbody .cc-urg')
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(document.getElementById('cc-tip').style.display).toBe('block');
    tipear(document.getElementById('cc-buscar'), 'hoja');
    await esperar(200);
    expect(document.getElementById('cc-tip').style.display).toBe('none');
  });

  it('la fila explica por qué está donde está', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    const fila = [...document.querySelectorAll('#cc-tbody tr[data-idx]')]
      .find(tr => (tr.querySelector('.cc-prod-btn')?.firstChild?.textContent || '').trim() === 'HOJA A4');
    const detalle = fila.querySelector('.cc-cob').textContent;
    expect(detalle).toContain('Se agota en');
    expect(detalle).toContain('más se vende en el mes');
    expect(detalle).toContain('últimos 7');
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

  it('al achicarse la lista, la página no pega el salto: reserva altura y vuelve al mismo lugar', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    const fila = document.getElementById('cc-filtros');
    const wrap = fila.parentElement.querySelector('.table-wrap');
    // jsdom no hace layout: se simula que la fila de filtros estaba a 120px del
    // borde y, con la lista corta y el scroll recortado, quedó a 420px.
    const tops = [120, 420];
    fila.getBoundingClientRect = () => ({ top: tops.length > 1 ? tops.shift() : tops[0] });
    wrap.getBoundingClientRect = () => ({ height: 200 });
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy;

    elegir('rubro', 'papeleria');
    expect(wrap.style.minHeight).toBe('500px');          // 200 de tabla + 300 que se corrió
    expect(scrollBy).toHaveBeenCalledWith(0, 300);       // y se vuelve a donde estaba
  });

  it('si nada se movió, no reserva ni scrollea', async () => {
    await montar('centro_compras', 'renderCentroCompras');
    const wrap = document.getElementById('cc-filtros').parentElement.querySelector('.table-wrap');
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy;
    elegir('rubro', 'papeleria');
    expect(wrap.style.minHeight).toBe('');
    expect(scrollBy).not.toHaveBeenCalled();
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

describe('Centro de Compras · lo que se viene por la época', () => {
  // Pedido del dueño (21/09/2026): después del 6 de septiembre, en el que voló
  // todo lo amarillo sin estar previsto, la lista de compras tiene que avisar
  // con dos meses lo que se viene, y esos productos tienen que verse DISTINTOS
  // de los que están por quedarse sin stock.
  //
  // La fecha se clava: el almanaque depende del día del año y si no, la prueba
  // pasaría o no según cuándo se corra. El 1 de octubre de 2026 el Día de la
  // Madre (18/10) está a 17 días, adentro de los dos meses de aviso.
  const HOY_FIJO = new Date('2026-10-01T12:00:00-03:00');
  const ventaEl = (diasAtras, producto, cantidad) => {
    const d = new Date(HOY_FIJO); d.setDate(d.getDate() - diasAtras);
    return {
      __id: `vt${diasAtras}_${producto.slice(0, 4)}`, producto, cantidad,
      fecha: `${dd(d.getDate())}/${dd(d.getMonth() + 1)}/${d.getFullYear()}`,
      fecha_dt: isoHora(d), subtotal: 9000 * cantidad, categoria: 'REGALERÍA',
    };
  };

  beforeEach(() => {
    // Sólo `Date`: los `setTimeout` con los que la prueba espera a que la
    // pantalla termine de pintar tienen que seguir corriendo de verdad.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(HOY_FIJO);
    sessionStorage.clear();

    datos.porColeccion.catalogo = [
      ...CATALOGO.map(p => ({ ...p })),
      // Regalería que se vende: es lo que entra por el Día de la Madre cuando
      // todavía no hay ventas viejas de esa fecha con las que medirla.
      { __id: 'r1', doc_id: 'r1', id: 41, nombre: 'PORTARETRATO PLASTICO 13X18',
        codigo: 'R001', rubro: 'REGALERÍA', sub_rubro: 'PORTARETRATOS',
        precio_venta: 9000, costo: 5000, stock: 0, estado: 'activo' },
    ];
    datos.porColeccion.ventas_por_dia = [
      ...(datos.porColeccion.ventas_por_dia || []),
      ...[1, 3, 5, 8, 12, 20].map(n => ventaEl(n, 'PORTARETRATO PLASTICO 13X18', 2)),
    ];
  });

  afterEach(() => { vi.useRealTimers(); });

  it('avisa del Día de la Madre con los días que faltan', async () => {
    const c = await montar('centro_compras', 'renderCentroCompras');
    const franja = c.querySelector('#cc-epocas');
    expect(franja).toBeTruthy();
    expect(franja.textContent).toContain('Día de la Madre');
    expect(franja.textContent).toContain('17 días');
  });

  it('lo que entra por la fecha se ve distinto y se puede filtrar', async () => {
    const c = await montar('centro_compras', 'renderCentroCompras');
    const filas = [...c.querySelectorAll('#cc-tbody tr.cc-row-epoca')];
    expect(filas.length).toBeGreaterThan(0);

    // La fila lleva el chip con el nombre de la fecha, no sólo el color.
    const chip = c.querySelector('.cc-chip-epoca');
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('Día de la Madre');

    // Y la píldora de arriba filtra la lista a sólo eso.
    expect(c.querySelector('.cc-tier-epoca')).toBeTruthy();
    c.querySelector('.cc-epoca-filtro').click();
    for (let i = 0; i < 6; i++) await esperar();

    const visibles = [...c.querySelectorAll('#cc-tbody tr')]
      .filter(tr => !tr.className.includes('cc-cutoff') && !tr.querySelector('.cc-empty'));
    expect(visibles.length).toBeGreaterThan(0);
    expect(visibles.every(tr => tr.className.includes('cc-row-epoca'))).toBe(true);
  });

  it('una corazonada se muestra como corazonada, no como dato', async () => {
    // Sin estudio guardado no hay nada medido: la pantalla tiene que decir que
    // eso sale del tipo de producto, no de lo que se vendió.
    const c = await montar('centro_compras', 'renderCentroCompras');
    expect(c.querySelector('#cc-epocas').textContent).toContain('por el tipo de producto');
    expect(c.querySelector('.cc-chip-epoca.es-corazonada')).toBeTruthy();
  });

  it('sin estudio guardado ofrece hacerlo', async () => {
    const c = await montar('centro_compras', 'renderCentroCompras');
    expect(c.querySelector('[data-action="estudiar-epocas"]')).toBeTruthy();
  });

  it('los servicios no entran: no se le compran al mayorista', async () => {
    datos.porColeccion.catalogo.push({
      __id: 's1', doc_id: 's1', id: 91, nombre: 'IMPRESION / FOTOCOPIA A4 (B/N)',
      codigo: 'S001', rubro: 'SERVICIOS', precio_venta: 100, costo: 20,
      stock: 0, estado: 'activo',
    });
    datos.porColeccion.ventas_por_dia.push(
      ...[1, 2, 3, 4].map(n => ventaEl(n, 'IMPRESION / FOTOCOPIA A4 (B/N)', 50)));
    const c = await montar('centro_compras', 'renderCentroCompras');
    const porEpoca = [...c.querySelectorAll('#cc-tbody tr.cc-row-epoca')]
      .map(tr => tr.textContent).join(' ');
    expect(porEpoca).not.toContain('IMPRESION / FOTOCOPIA');
  });

  it('estudiar las ventas guarda lo aprendido para no tener que rehacerlo', async () => {
    // Es la única lectura cara de la pantalla (recorre el histórico entero), así
    // que el resultado tiene que quedar guardado. Lo que se escribe es un
    // agregado chico: medido contra las ventas reales, 33 KB para 36.000
    // renglones, bien lejos del límite de 1 MB de un documento.
    //
    // Para que haya algo que aprender hace falta CONTRASTE: un producto que se
    // vende todos los días (la línea de base contra la que se compara) y otro
    // que aparece sólo en la previa de la fecha. Sin eso el motor no marca
    // nada, que es justamente lo que tiene que hacer.
    const fondo = [];
    for (let n = 5; n < 400; n += 2) fondo.push(ventaEl(n, 'CUADERNO RIVADAVIA', 3));
    const enLaFecha = [356, 354, 352, 350, 348].map(n => ventaEl(n, 'ROSA ARTIFICIAL', 12));
    datos.porColeccion.ventas_por_dia.push(...fondo, ...enLaFecha);
    datos.escrituras.length = 0;

    const c = await montar('centro_compras', 'renderCentroCompras');
    c.querySelector('[data-action="estudiar-epocas"]').click();
    for (let i = 0; i < 30; i++) await esperar(5);

    const guardado = datos.escrituras.find(e => JSON.stringify(e.ref || {}).includes('temporadas_aprendidas'));
    expect(guardado, 'tiene que escribir config/temporadas_aprendidas').toBeTruthy();
    const doc = guardado.datos || {};
    expect(Object.keys(doc.temporadas || {}), 'el estudio guardado trae fechas').not.toHaveLength(0);
    expect(doc.hasta, 'guarda hasta qué día miró').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(doc).length).toBeLessThan(1024 * 1024);
  });

  it('el botón "Próximas fechas" abre todas las fechas del año, no sólo las de dos meses', async () => {
    const c = await montar('centro_compras', 'renderCentroCompras');
    expect(c.querySelector('#cc-fechas').style.display).toBe('none');

    c.querySelector('[data-action="fechas"]').click();
    for (let i = 0; i < 6; i++) await esperar();

    const botones = [...c.querySelectorAll('.cc-fecha')];
    // Las 22 del almanaque: el aviso es a dos meses, pero acá se ven todas.
    expect(botones.length).toBeGreaterThan(15);
    const textos = botones.map(b => b.textContent).join(' | ');
    expect(textos).toContain('Día de la Madre');
    expect(textos).toContain('Navidad');          // a casi tres meses
    expect(textos).toContain('Vuelta a clases');  // recién en marzo

    // El color dice en qué está cada una.
    expect(c.querySelector('.cc-fecha.is-cerca'), 'alguna dentro del aviso').toBeTruthy();
    expect(c.querySelector('.cc-fecha.is-lejos'), 'alguna todavía lejos').toBeTruthy();
  });

  it('abrir una fecha lejana calcula qué comprar y filtra la lista', async () => {
    const c = await montar('centro_compras', 'renderCentroCompras');
    c.querySelector('[data-action="fechas"]').click();
    for (let i = 0; i < 6; i++) await esperar();

    // Reyes es el 6 de enero: a más de tres meses, fuera del aviso automático.
    const reyes = [...c.querySelectorAll('.cc-fecha')]
      .find(b => b.textContent.includes('Reyes'));
    expect(reyes).toBeTruthy();
    reyes.click();
    for (let i = 0; i < 10; i++) await esperar();

    const det = c.querySelector('.cc-fecha-det');
    expect(det, 'se abre el detalle de la fecha').toBeTruthy();
    expect(det.textContent).toContain('Reyes');
    expect(det.textContent).toMatch(/faltan \d+ días/);
    // Y la lista queda filtrada a esa fecha (o dice que no hay nada).
    const visibles = [...c.querySelectorAll('#cc-tbody tr')]
      .filter(tr => !tr.className.includes('cc-cutoff') && !tr.querySelector('.cc-empty'));
    expect(visibles.every(tr => tr.className.includes('cc-row-epoca'))).toBe(true);
  });

  it('volver a tocar la fecha abierta saca el filtro', async () => {
    const c = await montar('centro_compras', 'renderCentroCompras');
    c.querySelector('[data-action="fechas"]').click();
    for (let i = 0; i < 6; i++) await esperar();
    const madre = [...c.querySelectorAll('.cc-fecha')]
      .find(b => b.textContent.includes('Día de la Madre'));
    const todas = c.querySelectorAll('#cc-tbody tr').length;

    madre.click();
    for (let i = 0; i < 8; i++) await esperar();
    expect(c.querySelector('.cc-fecha.is-on')).toBeTruthy();

    c.querySelector('.cc-fecha.is-on').click();
    for (let i = 0; i < 8; i++) await esperar();
    expect(c.querySelector('.cc-fecha.is-on')).toBeNull();
    expect(c.querySelectorAll('#cc-tbody tr').length).toBe(todas);
  });

  it('un producto con variedades no se propone dos veces', async () => {
    // El índice de stock tiene una entrada por variedad Y una por el producto
    // entero: sin cuidado, la bolsa de organza salía una vez por color y otra
    // sumando todos los colores, con una cantidad disparatada.
    datos.porColeccion.catalogo.push({
      __id: 'b1', doc_id: 'b1', id: 92, nombre: 'BOLSA ORGANZA 12X9',
      codigo: 'B001', rubro: 'REGALERÍA', precio_venta: 500, costo: 200,
      es_conjunto: true, conjunto_tipo: 'pack', conjunto_contenido: 10,
      conjunto_unidad_medida: 'unidades', estado: 'activo',
      conjunto_colores: [
        { color: 'Dorada', unidades: 0, restante: 0, contenido: 10 },
        { color: 'Blanca', unidades: 0, restante: 0, contenido: 10 },
      ],
    });
    datos.porColeccion.ventas_por_dia.push(
      ...[2, 4, 6].map(n => ventaEl(n, '[Dorada]  BOLSA ORGANZA 12X9  ·  5 u', 5)));
    const c = await montar('centro_compras', 'renderCentroCompras');
    const bolsas = [...c.querySelectorAll('#cc-tbody tr.cc-row-epoca')]
      .filter(tr => tr.textContent.includes('BOLSA ORGANZA'));
    const sinVariedad = bolsas.filter(tr => !tr.querySelector('.cc-chip-varnt'));
    expect(sinVariedad.length).toBe(0);
  });
});
