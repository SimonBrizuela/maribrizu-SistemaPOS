// @vitest-environment jsdom
/**
 * La pantalla del Catálogo, usándola.
 *
 * Es la más grande del panel y la única donde se escribe sobre los productos.
 * Un error acá no se ve en el momento: se ve tres días después, cuando un
 * precio quedó mal o un producto dejó de aparecer en la caja.
 *
 * Lo que se prueba es lo que hace una persona: buscar, filtrar, tocar un precio
 * en la grilla, abrir la ficha, guardar. Y sobre todo QUÉ SE ESCRIBE: el
 * producto que se tocó, con el campo que se tocó, y nada más.
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

const CATALOGO = [
  { __id: 'p1', doc_id: 'p1', id: 1, nombre: 'CUADERNO RIVADAVIA 48 HOJAS', codigo: 'C001',
    cod_barra: '779000001', rubro: 'LIBRERIA', categoria: 'Cuadernos', sub_rubro: 'Cuadernos',
    marca: 'RIVADAVIA', proveedor: 'DISTRI SUR', precio_venta: 3500, costo: 2100,
    stock: 12, stock_min: 4, estado: 'activo' },
  { __id: 'p2', doc_id: 'p2', id: 2, nombre: 'LAPIZ FABER HB', codigo: 'C002',
    rubro: 'LIBRERIA', categoria: 'Escritura', sub_rubro: 'Escritura', marca: 'FABER',
    proveedor: 'DISTRI SUR', precio_venta: 900, costo: 400, stock: 60, estado: 'activo' },
  { __id: 'p3', doc_id: 'p3', id: 3, nombre: 'RESMA PAMPA A4', codigo: 'C003',
    rubro: 'PAPELERIA', categoria: 'Resmas', sub_rubro: 'Resmas', marca: 'PAMPA',
    proveedor: 'PAPELERA CBA', precio_venta: 18000, costo: 13000, stock: 3,
    stock_min: 5, estado: 'activo' },
  { __id: 'p4', doc_id: 'p4', id: 4, nombre: 'FOTOCOPIA SIMPLE', codigo: 'S001',
    rubro: 'SERVICIOS', categoria: 'Servicios', precio_venta: 120, costo: 0, stock: -1,
    stock_ilimitado: true, estado: 'activo' },
  { __id: 'p5', doc_id: 'p5', id: 5, nombre: 'CARPETA N3 DISCONTINUADA', codigo: 'C099',
    rubro: 'LIBRERIA', categoria: 'Carpetas', marca: 'RIVADAVIA', precio_venta: 5000,
    costo: 3000, stock: 0, estado: 'activo' },
];

let contenedor;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  datos.escrituras.length = 0;
  datos.porColeccion = {
    catalogo: CATALOGO.map(p => ({ ...p })),
    ventas_por_dia: [], inventario: [], inventario_resumen: [], rubros: [],
    control_config: [], config: [], stock_movimientos: [], catalogo_deleted: [],
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

/** Abre el Catálogo y espera a que termine de llenarse la tabla. */
async function abrirCatalogo() {
  const mod = await import('../../webapp/src/pages/catalogo.js');
  await mod.renderCatalogo(contenedor, {});
  for (let i = 0; i < 6; i++) await esperar();
  return contenedor;
}

/** Escribe en un campo y avisa como lo haría el teclado. */
function tipear(el, valor) {
  el.value = valor;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Escribe en el buscador y espera a que la grilla se rearme (va con retardo). */
async function buscar(texto) {
  tipear(document.getElementById('buscar'), texto);
  await esperar(200);
}

/** Las filas de la tabla como texto. */
const filas = () => [...document.querySelectorAll('#catBody tr')]
  .map(tr => tr.textContent.replace(/\s+/g, ' ').trim());

/** La fila de un producto por su nombre. */
const filaDe = (texto) => [...document.querySelectorAll('#catBody tr')]
  .find(tr => tr.textContent.includes(texto));

/** Lo que se escribió en una colección. */
const enColeccion = (col) => datos.escrituras.filter(e => e.ref?._col === col);

describe('la tabla', () => {
  it('lista los productos', async () => {
    await abrirCatalogo();
    const t = filas().join(' | ');
    expect(t).toContain('CUADERNO RIVADAVIA');
    expect(t).toContain('RESMA PAMPA');
  });

  it('dice cuántos hay', async () => {
    await abrirCatalogo();
    expect(document.getElementById('catCount').textContent).toMatch(/\d/);
  });

  it('muestra precio, costo y margen', async () => {
    await abrirCatalogo();
    const fila = filaDe('RESMA PAMPA').textContent;
    expect(fila).toContain('18.000');
    expect(fila).toContain('13.000');
    expect(fila).toMatch(/38%/);     // (18000-13000)/13000
  });

  it('un catálogo vacío no rompe la pantalla', async () => {
    datos.porColeccion.catalogo = [];
    const c = await abrirCatalogo();
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(c.textContent).not.toContain('NaN');
    expect(c.textContent).not.toContain('undefined');
  });
});

describe('buscar', () => {
  it('por nombre deja sólo lo que coincide', async () => {
    await abrirCatalogo();
    await buscar('resma');
    const t = filas().join(' | ');
    expect(t).toContain('RESMA PAMPA');
    expect(t).not.toContain('LAPIZ FABER');
  });

  it('no distingue mayúsculas', async () => {
    await abrirCatalogo();
    await buscar('lapiz');
    expect(filas().join(' | ')).toContain('LAPIZ FABER');
  });

  it('por código encuentra el producto exacto', async () => {
    await abrirCatalogo();
    await buscar('C003');
    const t = filas().join(' | ');
    expect(t).toContain('RESMA PAMPA');
    expect(t).not.toContain('CUADERNO');
  });

  it('por código de barras también', async () => {
    // Es como se busca con el lector en la mano.
    await abrirCatalogo();
    await buscar('779000001');
    expect(filas().join(' | ')).toContain('CUADERNO RIVADAVIA');
  });

  it('algo que no existe deja la lista vacía', async () => {
    await abrirCatalogo();
    await buscar('zzzz-no-existe');
    const t = filas().join(' | ');
    expect(t).not.toContain('CUADERNO');
    expect(t).not.toContain('RESMA');
  });

  it('limpiar la búsqueda devuelve todo', async () => {
    await abrirCatalogo();
    await buscar('resma');
    const conFiltro = filas().length;
    await buscar('');
    expect(filas().length).toBeGreaterThan(conFiltro);
  });

  it('el botón de limpiar borra búsqueda y filtros de una', async () => {
    await abrirCatalogo();
    await buscar('resma');
    tipear(document.getElementById('filtroMarca'), 'PAMPA');
    await esperar();

    document.getElementById('btnLimpiar').click();
    await esperar(200);

    expect(document.getElementById('buscar').value).toBe('');
    expect(document.getElementById('filtroMarca').value).toBe('');
    expect(filas().join(' | ')).toContain('LAPIZ FABER');
  });
});

describe('filtrar', () => {
  it('por categoría deja sólo esa categoría', async () => {
    await abrirCatalogo();
    tipear(document.getElementById('filtroCat'), 'Resmas');
    await esperar(50);
    const t = filas().join(' | ');
    expect(t).toContain('RESMA PAMPA');
    expect(t).not.toContain('LAPIZ FABER');
  });

  it('por marca también', async () => {
    await abrirCatalogo();
    tipear(document.getElementById('filtroMarca'), 'FABER');
    await esperar(50);
    const t = filas().join(' | ');
    expect(t).toContain('LAPIZ FABER');
    expect(t).not.toContain('RESMA PAMPA');
  });

  it('por proveedor también', async () => {
    await abrirCatalogo();
    tipear(document.getElementById('filtroProv'), 'PAPELERA CBA');
    await esperar(50);
    expect(filas().join(' | ')).toContain('RESMA PAMPA');
    expect(filas().join(' | ')).not.toContain('CUADERNO');
  });

  it('el desplegable de agotados muestra los que están en cero', async () => {
    await abrirCatalogo();
    tipear(document.getElementById('filtroEstado'), 'agotado');
    await esperar(50);
    const t = filas().join(' | ');
    expect(t).toContain('CARPETA N3');
    expect(t).not.toContain('LAPIZ FABER');
  });

  it('los desplegables salen de los productos, sin repetidos', async () => {
    await abrirCatalogo();
    for (const id of ['filtroCat', 'filtroProv', 'filtroMarca']) {
      const valores = [...document.querySelectorAll(`#${id} option`)]
        .map(o => o.value).filter(Boolean);
      expect(new Set(valores).size, id).toBe(valores.length);
    }
    const cats = [...document.querySelectorAll('#filtroCat option')].map(o => o.value);
    expect(cats).toContain('Resmas');
    expect(cats).toContain('Cuadernos');
  });

  it('dos filtros a la vez se combinan, no se pisan', async () => {
    await abrirCatalogo();
    tipear(document.getElementById('filtroProv'), 'DISTRI SUR');
    tipear(document.getElementById('filtroMarca'), 'FABER');
    await esperar(50);
    const t = filas().join(' | ');
    expect(t).toContain('LAPIZ FABER');
    expect(t).not.toContain('CUADERNO RIVADAVIA');
  });
});

describe('tocar un precio en la grilla', () => {
  /** Hace click en una celda editable y devuelve el campo que aparece. */
  async function editarCelda(nombre, campo) {
    const celda = filaDe(nombre).querySelector(`.precio-cell[data-field="${campo}"]`);
    expect(celda, `no hay celda editable de ${campo}`).toBeTruthy();
    celda.click();
    await esperar();
    const input = celda.querySelector('input');
    expect(input, 'la celda tiene que volverse editable').toBeTruthy();
    return input;
  }

  it('cambiar el precio escribe SÓLO ese producto y ese campo', async () => {
    await abrirCatalogo();
    const input = await editarCelda('RESMA PAMPA', 'precio_venta');
    input.value = '19500';
    input.dispatchEvent(new Event('blur'));
    for (let i = 0; i < 8; i++) await esperar();

    const escrito = enColeccion('catalogo');
    expect(escrito.length).toBeGreaterThan(0);
    expect(escrito.every(e => e.ref.id === 'p3'), 'no puede tocar otros productos').toBe(true);
    expect(escrito.at(-1).datos.precio_venta).toBe(19500);
    expect(escrito.at(-1).datos.stock, 'no puede escribir campos que nadie tocó').toBeUndefined();
  });

  it('el precio nuevo también va al inventario que lee la caja', async () => {
    // Si esto no sale, el panel muestra el precio nuevo y el POS sigue
    // cobrando el viejo.
    await abrirCatalogo();
    const input = await editarCelda('RESMA PAMPA', 'precio_venta');
    input.value = '19500';
    input.dispatchEvent(new Event('blur'));
    for (let i = 0; i < 8; i++) await esperar();

    const inv = enColeccion('inventario').at(-1);
    expect(inv, 'tiene que escribir inventario').toBeTruthy();
    expect(inv.datos.precio).toBe(19500);
    expect(inv.ref.id).toBe('3');            // el id numérico, no el doc_id
  });

  it('cambiar el stock escribe el stock, no el precio', async () => {
    await abrirCatalogo();
    const input = await editarCelda('RESMA PAMPA', 'stock');
    input.value = '20';
    input.dispatchEvent(new Event('blur'));
    for (let i = 0; i < 8; i++) await esperar();

    const escrito = enColeccion('catalogo').at(-1);
    expect(escrito.datos.stock).toBe(20);
    expect(escrito.datos.precio_venta).toBeUndefined();
  });

  it('Escape cancela sin escribir nada', async () => {
    await abrirCatalogo();
    const input = await editarCelda('RESMA PAMPA', 'precio_venta');
    input.value = '99999';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    for (let i = 0; i < 6; i++) await esperar();

    expect(enColeccion('catalogo').length).toBe(0);
  });

  it('poner el costo en cero marca el producto como sin precio', async () => {
    await abrirCatalogo();
    const input = await editarCelda('RESMA PAMPA', 'costo');
    input.value = '0';
    input.dispatchEvent(new Event('blur'));
    for (let i = 0; i < 8; i++) await esperar();

    expect(enColeccion('catalogo').at(-1).datos.estado).toBe('sin_precio');
  });

  it('el mismo valor de siempre no ensucia el historial', async () => {
    // Entrar a la celda y salir sin cambiar nada no es un cambio: si contara,
    // el deshacer se llenaría de pasos que no hicieron nada.
    await abrirCatalogo();
    const input = await editarCelda('RESMA PAMPA', 'precio_venta');
    input.value = '18000';
    input.dispatchEvent(new Event('blur'));
    for (let i = 0; i < 8; i++) await esperar();

    const hist = JSON.parse(localStorage.getItem('pos_catalogo_history_v1') || '{"undo":[]}');
    expect(hist.undo.length).toBe(0);
  });
});

describe('la ficha del producto', () => {
  /** Abre la ficha con el botón de editar de la fila. */
  async function abrirFicha(nombre) {
    filaDe(nombre).querySelector('.btn-editar').click();
    for (let i = 0; i < 6; i++) await esperar();
    return document.getElementById('ed_nombre');
  }

  it('se abre con los datos del producto', async () => {
    await abrirCatalogo();
    const nombre = await abrirFicha('RESMA PAMPA');
    expect(nombre).toBeTruthy();
    expect(nombre.value).toContain('RESMA PAMPA');
    expect(document.getElementById('ed_precio').value).toBe('18000');
    expect(document.getElementById('ed_costo').value).toBe('13000');
    expect(document.getElementById('ed_codigo').value).toBe('C003');
  });

  it('trae también el rubro y la marca', async () => {
    await abrirCatalogo();
    await abrirFicha('RESMA PAMPA');
    expect(document.getElementById('ed_rubro').value).toBe('PAPELERIA');
    expect(document.getElementById('ed_marca').value).toBe('PAMPA');
  });

  it('guardar un precio nuevo lo escribe en ese producto', async () => {
    await abrirCatalogo();
    await abrirFicha('RESMA PAMPA');
    tipear(document.getElementById('ed_precio'), '19500');
    document.getElementById('ed_guardar').click();
    for (let i = 0; i < 10; i++) await esperar();

    const escrito = enColeccion('catalogo');
    expect(escrito.length).toBeGreaterThan(0);
    expect(escrito.every(e => e.ref.id === 'p3')).toBe(true);
    expect(escrito.at(-1).datos.precio_venta).toBe(19500);
  });

  it('el mínimo y el máximo de stock se guardan', async () => {
    await abrirCatalogo();
    await abrirFicha('RESMA PAMPA');
    tipear(document.getElementById('ed_stock_min'), '8');
    tipear(document.getElementById('ed_stock_max'), '30');
    document.getElementById('ed_guardar').click();
    for (let i = 0; i < 10; i++) await esperar();

    const d = enColeccion('catalogo').at(-1).datos;
    expect(d.stock_min).toBe(8);
    expect(d.stock_max).toBe(30);
  });

  it('cerrar la ficha la saca de pantalla', async () => {
    await abrirCatalogo();
    await abrirFicha('LAPIZ FABER');
    document.getElementById('ed_cancelar')?.click();
    document.getElementById('cerrarEditor')?.click();
    await esperar();
    expect(document.getElementById('ed_nombre')).toBeNull();
  });

  it('abrir la ficha de otro producto no arrastra los datos del anterior', async () => {
    await abrirCatalogo();
    await abrirFicha('RESMA PAMPA');
    document.getElementById('cerrarEditor')?.click();
    await esperar();
    const nombre = await abrirFicha('LAPIZ FABER');
    expect(nombre.value).toContain('LAPIZ FABER');
    expect(document.getElementById('ed_precio').value).toBe('900');
  });
});

describe('lo que se ve de un vistazo', () => {
  it('el producto bajo mínimo se marca en color', async () => {
    // RESMA PAMPA: 3 en stock con mínimo 5.
    await abrirCatalogo();
    expect(filaDe('RESMA PAMPA').innerHTML)
      .toMatch(/danger|warning|f59e|dc35|ef44|c62|b45|d97/i);
  });

  it('un servicio no aparece como agotado', async () => {
    // Una fotocopia no tiene stock: marcarla como agotada la mete en la lista
    // de reposición todos los días.
    await abrirCatalogo();
    const fila = filaDe('FOTOCOPIA');
    expect(fila).toBeTruthy();
    expect(fila.textContent.toLowerCase()).not.toContain('agotado');
  });

  it('el que está en cero sí dice agotado', async () => {
    await abrirCatalogo();
    expect(filaDe('CARPETA N3').textContent.toLowerCase()).toContain('agotado');
  });

  it('cada fila ofrece editar, ver detalle y borrar', async () => {
    await abrirCatalogo();
    const fila = filaDe('RESMA PAMPA');
    expect(fila.querySelector('.btn-editar')).toBeTruthy();
    expect(fila.querySelector('.btn-detalle')).toBeTruthy();
    expect(fila.querySelector('.btn-eliminar')).toBeTruthy();
  });
});
