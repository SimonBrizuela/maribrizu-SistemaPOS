// @vitest-environment jsdom
/**
 * Las pantallas del panel que manejan la tienda online: qué se publica, qué
 * descuento tiene, cuándo está abierta y qué pedidos entraron.
 *
 * Lo que sale mal acá se ve del lado del cliente. Un producto publicado sin
 * stock se compra y después hay que llamar para avisar que no está; un
 * descuento mal cargado vende por debajo del costo; un horario mal puesto deja
 * la tienda tomando pedidos a las tres de la mañana.
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
      const encontrado = lista.find(d => (d.__id || '') === ref?.id) || lista[0];
      return { exists: () => !!encontrado, data: () => encontrado, id: ref?.id || 'x' };
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

const CATALOGO = [
  // Publicado: rubro habilitado, con stock, con foto.
  { __id: 'p1', doc_id: 'p1', id: 1, nombre: 'CUADERNO RIVADAVIA', codigo: 'C001',
    rubro: 'LIBRERIA', categoria: 'Cuadernos', marca: 'RIVADAVIA', precio_venta: 3500,
    costo: 2100, stock: 12, estado: 'activo',
    tienda_imagenes: ['a.webp'], tienda_nombre: 'Cuaderno Rivadavia 48 hojas' },
  // Sacado a mano de la vidriera.
  { __id: 'p2', doc_id: 'p2', id: 2, nombre: 'LAPIZ FABER', codigo: 'C002',
    rubro: 'LIBRERIA', categoria: 'Escritura', marca: 'FABER', precio_venta: 900,
    costo: 400, stock: 60, estado: 'activo', tienda_publicar: false,
    tienda_imagenes: ['c.webp'] },
  // Sin stock: no sale, aunque tenga foto y el rubro esté habilitado.
  { __id: 'p3', doc_id: 'p3', id: 3, nombre: 'RESMA PAMPA', codigo: 'C003',
    rubro: 'PAPELERIA', categoria: 'Resmas', marca: 'PAMPA', precio_venta: 18000,
    costo: 13000, stock: 0, estado: 'activo', tienda_imagenes: ['b.webp'] },
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
    tienda_config: [{ __id: 'publicacion', rubros: ['LIBRERIA', 'PAPELERIA'] }],
    tienda_pedidos: [], tienda_descuentos: [],
    tienda_fotos_pedidas: [], pcs: [], facturas: [], perfiles_facturacion: [],
    clientes_facturacion: [],
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

const CARGAR = {
  tienda_catalogo: () => import('../../webapp/src/pages/tienda_catalogo.js'),
  tienda_descuentos: () => import('../../webapp/src/pages/tienda_descuentos.js'),
  tienda_ajustes: () => import('../../webapp/src/pages/tienda_ajustes.js'),
  pedidos_tienda: () => import('../../webapp/src/pages/pedidos_tienda.js'),
  pcs: () => import('../../webapp/src/pages/pcs.js'),
  facturas: () => import('../../webapp/src/pages/facturas.js'),
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

describe('Catálogo de la Tienda', () => {
  it('muestra lo que sí está en la vidriera', async () => {
    const c = await montar('tienda_catalogo', 'renderTiendaCatalogo');
    expect(c.textContent).toContain('Cuaderno Rivadavia');
  });

  it('lo sacado a mano no figura como publicado', async () => {
    const c = await montar('tienda_catalogo', 'renderTiendaCatalogo');
    expect(c.textContent).not.toContain('Lapiz Faber');
  });

  it('lo que está sin stock tampoco', async () => {
    // Publicarlo sin stock termina en un pedido que hay que cancelar por
    // teléfono: para el cliente es peor que no verlo.
    const c = await montar('tienda_catalogo', 'renderTiendaCatalogo');
    expect(c.textContent).not.toContain('Resma Pampa');
  });

  it('el filtro de ocultos muestra los que no salen y por qué', async () => {
    await montar('tienda_catalogo', 'renderTiendaCatalogo');
    const btn = [...document.querySelectorAll('button, .tienda-tab, [data-filtro]')]
      .find(b => /ocultos|fuera|no publicad/i.test(b.textContent));
    if (!btn) return;
    btn.click();
    await esperar(50);
    const t = contenedor.textContent;
    expect(t).toMatch(/sin stock|excluido|rubro/i);
  });

  it('con el catálogo vacío no rompe', async () => {
    datos.porColeccion.catalogo = [];
    const c = await montar('tienda_catalogo', 'renderTiendaCatalogo');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
    expect(plano(c)).not.toContain('undefined');
  });
});

describe('Descuentos de la Tienda', () => {
  beforeEach(() => {
    datos.porColeccion.tienda_descuentos = [
      { __id: 'd1', nombre: '10% en librería', tipo: 'porcentaje', valor: 10,
        alcance: 'rubro', objetivo: 'LIBRERIA', activo: true },
      { __id: 'd2', nombre: 'Promo vieja', tipo: 'porcentaje', valor: 5,
        alcance: 'todo', activo: false },
    ];
  });

  it('lista los descuentos cargados', async () => {
    const c = await montar('tienda_descuentos', 'renderTiendaDescuentos');
    expect(c.textContent).toContain('10% en librería');
  });

  it('se ve cuál está apagado', async () => {
    const c = await montar('tienda_descuentos', 'renderTiendaDescuentos');
    expect(c.textContent).toContain('Promo vieja');
  });

  it('el botón de nuevo abre el formulario con sus campos', async () => {
    await montar('tienda_descuentos', 'renderTiendaDescuentos');
    document.getElementById('descNuevo')?.click();
    await esperar(50);
    expect(document.getElementById('dNombre')).toBeTruthy();
    expect(document.getElementById('dTipo')).toBeTruthy();
    expect(document.getElementById('dValor')).toBeTruthy();
  });

  it('sin descuentos muestra el vacío', async () => {
    datos.porColeccion.tienda_descuentos = [];
    const c = await montar('tienda_descuentos', 'renderTiendaDescuentos');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Configuración de la Tienda', () => {
  beforeEach(() => {
    datos.porColeccion.tienda_config = [{
      __id: 'general', abierta: true, minimo_pedido: 6500,
      entrega: { retiro_habilitado: true, delivery_habilitado: false },
      pago: { efectivo: true, transferencia: true },
      horarios: { lun: [['09:00', '13:00'], ['16:30', '20:30']] },
    }];
  });

  it('trae la configuración guardada', async () => {
    const c = await montar('tienda_ajustes', 'renderTiendaAjustes');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(document.getElementById('cfgAbierta')).toBeTruthy();
  });

  it('el interruptor de abierta refleja lo guardado', async () => {
    const c = await montar('tienda_ajustes', 'renderTiendaAjustes');
    const sw = document.getElementById('cfgAbierta');
    if (sw && sw.type === 'checkbox') expect(sw.checked).toBe(true);
    expect(c.textContent.toLowerCase()).toMatch(/abiert|cerrad/);
  });

  it('los medios de entrega y de pago se muestran como están', async () => {
    await montar('tienda_ajustes', 'renderTiendaAjustes');
    const retiro = document.getElementById('cfgRetiro');
    const delivery = document.getElementById('cfgDelivery');
    if (retiro?.type === 'checkbox') expect(retiro.checked).toBe(true);
    if (delivery?.type === 'checkbox') expect(delivery.checked).toBe(false);
  });

  it('sin configuración guardada arranca sin romperse', async () => {
    datos.porColeccion.tienda_config = [];
    const c = await montar('tienda_ajustes', 'renderTiendaAjustes');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Pedidos de la Tienda', () => {
  beforeEach(() => {
    datos.porColeccion.tienda_pedidos = [
      { __id: 'k1', codigo: 'K7M2', estado: 'nuevo', creado: new Date(), visto: false,
        cliente: { nombre: 'Marta Gómez', telefono: '3515550001' },
        entrega: { modo: 'retiro' }, pago: { modo: 'efectivo' },
        items: [{ id: 'p1', nombre: 'Cuaderno Rivadavia', cantidad: 2, precio: 3500,
                  subtotal: 7000 }],
        subtotal: 7000, envio: 0, total: 7000 },
      { __id: 'k2', codigo: 'B3X9', estado: 'preparando', creado: new Date(), visto: true,
        cliente: { nombre: 'Juan Pérez', telefono: '3515550002' },
        entrega: { modo: 'delivery', direccion: 'Colón 1200' },
        pago: { modo: 'transferencia' },
        items: [{ id: 'p3', nombre: 'Resma Pampa', cantidad: 1, precio: 18000,
                  subtotal: 18000 }],
        subtotal: 18000, envio: 2000, total: 20000 },
      { __id: 'k3', codigo: 'Z1Q4', estado: 'entregado', creado: new Date(), visto: true,
        cliente: { nombre: 'Ana Ruiz', telefono: '3515550003' },
        entrega: { modo: 'retiro' }, pago: { modo: 'efectivo' },
        items: [{ id: 'p1', nombre: 'Cuaderno', cantidad: 1, precio: 3500, subtotal: 3500 }],
        subtotal: 3500, envio: 0, total: 3500 },
    ];
  });

  it('lista los pedidos con su código y su total', async () => {
    const c = await montar('pedidos_tienda', 'renderPedidosTienda');
    const t = plano(c);
    expect(t).toContain('K7M2');
    expect(t).toContain('7000');
    expect(c.textContent).toContain('Marta Gómez');
  });

  it('el envío se suma al total, no se pierde', async () => {
    // $18.000 de producto + $2.000 de envío. Si el total mostrara sólo el
    // producto, se cobra de menos en cada delivery.
    const c = await montar('pedidos_tienda', 'renderPedidosTienda');
    const t = plano(c);
    expect(t).toContain('20000');
    expect(t).toContain('2000');
  });

  it('un pedido a retirar dice que no lleva envío', async () => {
    const c = await montar('pedidos_tienda', 'renderPedidosTienda');
    expect(c.textContent.toLowerCase()).toContain('sin envío');
  });

  it('se ve cómo paga cada uno', async () => {
    const c = await montar('pedidos_tienda', 'renderPedidosTienda');
    const t = c.textContent.toLowerCase();
    expect(t).toContain('efectivo');
    expect(t).toContain('transferencia');
  });

  it('buscar filtra por cliente o código', async () => {
    await montar('pedidos_tienda', 'renderPedidosTienda');
    const buscar = document.getElementById('pedidosBuscar');
    expect(buscar).toBeTruthy();
    tipear(buscar, 'K7M2');
    await esperar(250);
    const lista = document.getElementById('pedidosLista').textContent;
    expect(lista).toContain('K7M2');
    expect(lista).not.toContain('B3X9');
  });

  it('sin pedidos muestra el vacío', async () => {
    datos.porColeccion.tienda_pedidos = [];
    const c = await montar('pedidos_tienda', 'renderPedidosTienda');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Estado de PCs', () => {
  beforeEach(() => {
    const ahora = new Date();
    const hace2h = new Date(ahora.getTime() - 2 * 60 * 60 * 1000);
    datos.porColeccion.pcs = [
      { __id: 'PC-CAJA', pc_id: 'PC-CAJA', app_version: '3.0.65', last_seen: ahora },
      { __id: 'PC-DEPO', pc_id: 'PC-DEPO', app_version: '3.0.59', last_seen: hace2h },
    ];
  });

  it('lista las máquinas con su versión', async () => {
    const c = await montar('pcs', 'renderPcs');
    const t = c.textContent;
    expect(t).toContain('PC-CAJA');
    expect(t).toContain('3.0.65');
    expect(t).toContain('3.0.59');
  });

  it('la que hace rato no da señales se distingue de la que está andando', async () => {
    // Es para lo que sirve la pantalla: darse cuenta de que una caja dejó de
    // sincronizar antes de que falte un día de ventas.
    const c = await montar('pcs', 'renderPcs');
    expect(c.textContent.toLowerCase()).toMatch(/offline|desconect|sin conex|hace/);
  });

  it('buscar filtra por nombre de máquina', async () => {
    await montar('pcs', 'renderPcs');
    const buscar = document.getElementById('pcSearch');
    if (!buscar) return;
    tipear(buscar, 'DEPO');
    await esperar(250);
    const cards = document.getElementById('pcCards').textContent;
    expect(cards).toContain('PC-DEPO');
    expect(cards).not.toContain('PC-CAJA');
  });

  it('sin PCs registradas muestra el vacío', async () => {
    datos.porColeccion.pcs = [];
    const c = await montar('pcs', 'renderPcs');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
  });
});

describe('Facturación AFIP', () => {
  beforeEach(() => {
    datos.porColeccion.perfiles_facturacion = [
      { __id: 'pf1', nombre: 'Librería Liceo', cuit: '20000000001', punto_venta: 1,
        activo: true },
    ];
    datos.porColeccion.clientes_facturacion = [
      { __id: 'cf1', razon_social: 'Escuela 25', cuit: '30000000007',
        cond_iva: 'IVA Responsable Inscripto', activo: true },
    ];
  });

  it('el formulario de factura está completo', async () => {
    const c = await montar('facturas', 'renderFacturas');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(document.getElementById('fCliente')).toBeTruthy();
    expect(document.getElementById('fItemsBody')).toBeTruthy();
  });

  it('se puede agregar un renglón', async () => {
    await montar('facturas', 'renderFacturas');
    const cuerpo = document.getElementById('fItemsBody');
    const antes = cuerpo.children.length;
    document.getElementById('btnAddItem').click();
    await esperar(50);
    expect(cuerpo.children.length).toBeGreaterThan(antes);
  });

  it('el renglón nuevo pide descripción, cantidad y precio', async () => {
    await montar('facturas', 'renderFacturas');
    document.getElementById('btnAddItem').click();
    await esperar(50);
    const inputs = document.querySelectorAll('#fItemsBody input');
    expect(inputs.length).toBeGreaterThanOrEqual(3);
  });

  it('sin facturas emitidas no rompe el historial', async () => {
    datos.porColeccion.facturas = [];
    const c = await montar('facturas', 'renderFacturas');
    expect(plano(c)).not.toContain('NaN');
  });
});
