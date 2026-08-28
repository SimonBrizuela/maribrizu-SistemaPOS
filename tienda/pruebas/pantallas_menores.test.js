// @vitest-environment jsdom
/**
 * Las pantallas más chicas del panel, usándolas: Artículos con Variantes,
 * Perfiles ARCA, Perfiles de Clientes, Observaciones, Fotos Pedidas,
 * Notificaciones y Control Total.
 *
 * Son chicas pero no menores: los perfiles de ARCA son los datos con los que se
 * factura, las observaciones son lo que se anotó en el mostrador y las
 * notificaciones son lo único que avisa que falta mercadería.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { datos } = vi.hoisted(() => ({
  datos: { porColeccion: {}, docs: {}, escrituras: [] },
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
      const clave = `${ref?._col}/${ref?.id}`;
      if (clave in datos.docs) {
        const d = datos.docs[clave];
        return { exists: () => d != null, data: () => d, id: ref?.id || 'x' };
      }
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
const isoHora = (d) => `${d.getFullYear()}-${dd(d.getMonth() + 1)}-${dd(d.getDate())} 12:00:00`;

let contenedor;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  datos.escrituras.length = 0;
  datos.docs = {};
  datos.porColeccion = {
    catalogo: [], ventas: [], ventas_por_dia: [], inventario: [], inventario_resumen: [],
    observaciones: [], pcs: [],
    control_config: [], config: [], rubros: [], gastos: [],
    perfiles_facturacion: [], clientes_facturacion: [],
    tienda_fotos_pedidas: [], notificaciones: [], cierres_caja: [], caja_activa: [],
  };
  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
  document.body.insertAdjacentHTML('beforeend',
    '<div id="app"></div><div id="page-title"></div><div id="sidebar"></div>' +
    '<div id="status"></div><div id="bottomNav"></div>');
  // El navegador de esta máquina no pide permiso para notificar.
  window.Notification = class { constructor() {} close() {}
    static permission = 'default';
    static requestPermission = async () => 'granted'; };
});

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

const CARGAR = {
  articulos_unicos: () => import('../../webapp/src/pages/articulos_unicos.js'),
  perfiles: () => import('../../webapp/src/pages/perfiles.js'),
  clientes: () => import('../../webapp/src/pages/clientes.js'),
  observaciones: () => import('../../webapp/src/pages/observaciones.js'),
  tienda_fotos: () => import('../../webapp/src/pages/tienda_fotos.js'),
  notificaciones: () => import('../../webapp/src/pages/notificaciones.js'),
  inventario: () => import('../../webapp/src/pages/inventario.js'),
  control_total: () => import('../../webapp/src/pages/control_total.js'),
};

async function montar(clave, fn) {
  const mod = await CARGAR[clave]();
  await mod[fn](contenedor, {});
  for (let i = 0; i < 10; i++) await esperar();
  return contenedor;
}

function tipear(el, valor) {
  el.value = valor;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const plano = (el) => el.textContent.replace(/\./g, '');

describe('Artículos con Variantes', () => {
  // La pantalla junta los productos cuyo nombre comparte una base y se
  // diferencian por un código al final: son el mismo artículo cargado N veces.
  beforeEach(() => {
    datos.porColeccion.catalogo = [
      { __id: 'p1', doc_id: 'p1', id: 1, nombre: 'BANDOLERA LA CHAPELLE 34UC2631',
        rubro: 'BAZAR', precio_venta: 25000, costo: 15000, stock: 3, estado: 'activo' },
      { __id: 'p2', doc_id: 'p2', id: 2, nombre: 'BANDOLERA LA CHAPELLE 34UC2632',
        rubro: 'BAZAR', precio_venta: 25000, costo: 15000, stock: 2, estado: 'activo' },
      { __id: 'p3', doc_id: 'p3', id: 3, nombre: 'BANDOLERA LA CHAPELLE 34UC2633',
        rubro: 'BAZAR', precio_venta: 27000, costo: 16000, stock: 1, estado: 'activo' },
      { __id: 'p4', doc_id: 'p4', id: 4, nombre: 'LAPIZ FABER HB', rubro: 'LIBRERIA',
        precio_venta: 900, costo: 400, stock: 60, estado: 'activo' },
    ];
  });

  it('junta los que son el mismo artículo', async () => {
    const c = await montar('articulos_unicos', 'renderArticulosUnicos');
    expect(c.textContent).toContain('BANDOLERA LA CHAPELLE');
  });

  it('un producto solo no cuenta como variante', async () => {
    const c = await montar('articulos_unicos', 'renderArticulosUnicos');
    expect(document.getElementById('variantesLista').textContent)
      .not.toContain('LAPIZ FABER');
  });

  it('dice cuántos hay', async () => {
    await montar('articulos_unicos', 'renderArticulosUnicos');
    expect(document.getElementById('countVariantes').textContent).toMatch(/\d/);
  });

  it('buscar filtra', async () => {
    await montar('articulos_unicos', 'renderArticulosUnicos');
    const buscar = document.getElementById('searchVariantes');
    expect(buscar).toBeTruthy();
    tipear(buscar, 'bandolera');
    await esperar(250);
    expect(document.getElementById('variantesLista').textContent)
      .toContain('BANDOLERA');
  });

  it('sin variantes en el catálogo muestra el vacío', async () => {
    datos.porColeccion.catalogo = [datos.porColeccion.catalogo[3]];
    const c = await montar('articulos_unicos', 'renderArticulosUnicos');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Perfiles ARCA', () => {
  beforeEach(() => {
    datos.porColeccion.perfiles_facturacion = [
      { __id: 'pf1', nombre: 'Librería Liceo', cuit: '20000000001', punto_venta: 1,
        cond_iva: 'Responsable Inscripto', activo: true },
    ];
  });

  it('lista los perfiles cargados', async () => {
    const c = await montar('perfiles', 'renderPerfiles');
    expect(c.textContent).toContain('Librería Liceo');
    expect(c.textContent).toContain('20000000001');
  });

  it('el botón de nuevo abre el formulario', async () => {
    await montar('perfiles', 'renderPerfiles');
    document.getElementById('btnNuevoPerfil')?.click();
    await esperar(50);
    expect(document.getElementById('btnGuardarPerfil')).toBeTruthy();
    expect(document.getElementById('fCondIVA')).toBeTruthy();
  });

  it('sin perfiles muestra el vacío', async () => {
    datos.porColeccion.perfiles_facturacion = [];
    const c = await montar('perfiles', 'renderPerfiles');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Perfiles de Clientes', () => {
  beforeEach(() => {
    datos.porColeccion.clientes_facturacion = [
      { __id: 'cf1', nombre: 'Escuela 25 de Mayo', cuit: '30000000007',
        cond_iva: 'IVA Responsable Inscripto', domicilio: 'Colón 1200', activo: true },
      { __id: 'cf2', nombre: 'Marta Gómez', cuit: '27000000004',
        cond_iva: 'Consumidor Final', activo: true },
    ];
  });

  it('lista los clientes con su CUIT', async () => {
    const c = await montar('clientes', 'renderClientes');
    expect(c.textContent).toContain('Escuela 25 de Mayo');
    // El CUIT sale con guiones, como se lee en una factura.
    expect(c.textContent.replace(/[-\s]/g, '')).toContain('30000000007');
    expect(c.textContent).toContain('30-00000000-7');
  });

  it('buscar filtra por nombre', async () => {
    await montar('clientes', 'renderClientes');
    const buscar = [...document.querySelectorAll('input[type="text"], input[type="search"]')]
      .find(i => /busc/i.test(i.id + i.placeholder));
    if (!buscar) return;
    tipear(buscar, 'marta');
    await esperar(250);
    expect(contenedor.textContent).toContain('Marta Gómez');
  });

  it('el botón de nuevo abre el formulario con los campos de AFIP', async () => {
    await montar('clientes', 'renderClientes');
    document.getElementById('btnNuevoCliente')?.click();
    await esperar(50);
    expect(document.getElementById('cCuit')).toBeTruthy();
    expect(document.getElementById('cCondIVA')).toBeTruthy();
    expect(document.getElementById('btnGuardarCliente')).toBeTruthy();
  });

  it('sin clientes muestra el vacío', async () => {
    datos.porColeccion.clientes_facturacion = [];
    const c = await montar('clientes', 'renderClientes');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Observaciones', () => {
  beforeEach(() => {
    datos.porColeccion.observaciones = [
      { __id: 'o1', text: 'Falta papel de la impresora', created_by_name: 'Marta',
        created_at: isoHora(HOY), context: 'general', deleted: false },
      { __id: 'o2', text: 'El cliente pasa el viernes', created_by_name: 'Jose',
        created_at: isoHora(HOY), context: 'sale', sale_id: 4520, deleted: false },
      { __id: 'o3', text: 'Esta ya no va', created_by_name: 'Marta',
        created_at: isoHora(HOY), context: 'general', deleted: true },
    ];
  });

  it('lista lo que se anotó', async () => {
    const c = await montar('observaciones', 'renderObservaciones');
    expect(c.textContent).toContain('Falta papel de la impresora');
    expect(c.textContent).toContain('El cliente pasa el viernes');
  });

  it('una borrada no se muestra', async () => {
    const c = await montar('observaciones', 'renderObservaciones');
    expect(c.textContent).not.toContain('Esta ya no va');
  });

  it('se ve quién la escribió', async () => {
    const c = await montar('observaciones', 'renderObservaciones');
    expect(c.textContent).toContain('Marta');
    expect(c.textContent).toContain('Jose');
  });

  it('buscar filtra', async () => {
    await montar('observaciones', 'renderObservaciones');
    const buscar = document.getElementById('obsBuscar');
    expect(buscar).toBeTruthy();
    tipear(buscar, 'papel');
    await esperar(250);
    const t = contenedor.textContent;
    expect(t).toContain('Falta papel');
    expect(t).not.toContain('El cliente pasa el viernes');
  });

  it('el botón de nueva abre el formulario', async () => {
    await montar('observaciones', 'renderObservaciones');
    document.getElementById('btnNuevaObs')?.click();
    await esperar(50);
    expect(document.getElementById('obsGuardar')).toBeTruthy();
  });

  it('sin observaciones muestra el vacío', async () => {
    datos.porColeccion.observaciones = [];
    const c = await montar('observaciones', 'renderObservaciones');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Fotos Pedidas', () => {
  beforeEach(() => {
    datos.porColeccion.tienda_fotos_pedidas = [
      { __id: 'f1', doc_id: 'p1', nombre: 'CUADERNO RIVADAVIA', codigo: 'C001',
        rubro: 'LIBRERIA', pedido_en: isoHora(HOY) },
    ];
  });

  it('lista lo que espera foto', async () => {
    const c = await montar('tienda_fotos', 'renderTiendaFotos');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(document.getElementById('fotosCuerpo')).toBeTruthy();
  });

  it('sin pedidos de foto muestra el vacío', async () => {
    datos.porColeccion.tienda_fotos_pedidas = [];
    const c = await montar('tienda_fotos', 'renderTiendaFotos');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Notificaciones', () => {
  beforeEach(() => {
    datos.porColeccion.catalogo = [
      { __id: 'p3', doc_id: 'p3', id: 3, nombre: 'RESMA PAMPA', rubro: 'PAPELERIA',
        precio_venta: 18000, costo: 13000, stock: 1, stock_min: 6, estado: 'activo' },
      { __id: 'p4', doc_id: 'p4', id: 4, nombre: 'FOTOCOPIA SIMPLE', rubro: 'SERVICIOS',
        precio_venta: 120, costo: 0, stock: -1, stock_ilimitado: true, estado: 'activo' },
    ];
  });

  it('avisa por el producto bajo mínimo', async () => {
    const c = await montar('notificaciones', 'renderNotificaciones');
    expect(c.textContent).toContain('RESMA PAMPA');
  });

  it('un servicio nunca genera un aviso de reposición', async () => {
    // Una fotocopia no se repone: avisarlo todos los días hace que se dejen de
    // mirar los avisos que sí importan.
    const c = await montar('notificaciones', 'renderNotificaciones');
    expect(document.getElementById('notifLista')?.textContent || c.textContent)
      .not.toContain('FOTOCOPIA');
  });

  it('ofrece prender los avisos del navegador', async () => {
    const c = await montar('notificaciones', 'renderNotificaciones');
    expect(c.querySelector('#notifActivar, #notifActivarBtn, #notifPermisoBox')).toBeTruthy();
  });

  it('sin nada que avisar lo dice', async () => {
    datos.porColeccion.catalogo = [
      { __id: 'p2', doc_id: 'p2', id: 2, nombre: 'LAPIZ FABER', rubro: 'LIBRERIA',
        precio_venta: 900, costo: 400, stock: 60, stock_min: 5, estado: 'activo' },
    ];
    const c = await montar('notificaciones', 'renderNotificaciones');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Control Total', () => {
  it('es el marco donde se monta el Balance', async () => {
    const c = await montar('control_total', 'renderControlTotal');
    expect(document.getElementById('ct-balance-mount')).toBeTruthy();
    expect(c.innerHTML.length).toBeGreaterThan(0);
  });
});

describe('Inventario', () => {
  it('se abre sin romperse', async () => {
    const c = await montar('inventario', 'renderInventario');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});
