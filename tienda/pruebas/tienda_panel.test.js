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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { aCampos } from '../netlify/functions/lib/firestore.mjs';
import { claveDeDia } from '../src/estadisticas.js';

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
    tienda_pedidos: [], tienda_descuentos: [], tienda_cupones: [],
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
  tienda_cupones: () => import('../../webapp/src/pages/tienda_cupones.js'),
  tienda_estadisticas: () => import('../../webapp/src/pages/tienda_estadisticas.js'),
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

// Los dos lugares donde el Catálogo de la Tienda muestra números: la tarjeta de
// arriba y el chip de cada filtro, uno pegado al otro.
const delResumen = (etiqueta) => {
  const dato = [...contenedor.querySelectorAll('#tiendaResumen .tienda-dato')]
    .find(d => d.querySelector('span')?.textContent.trim() === etiqueta);
  return Number(String(dato?.querySelector('b')?.textContent || '').replace(/\./g, ''));
};
const delChip = (clave) => Number(String(
  contenedor.querySelector(`#tiendaFiltros [data-filtro="${clave}"] .pc-btn__n`)
    ?.textContent || '').replace(/\./g, ''));

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

  /*
   * La tarjeta de arriba y los chips de abajo están pegados y usan las mismas
   * palabras. Al elegir un rubro, la tarjeta contaba el catálogo entero y los
   * chips el rubro: "en la tienda" decía 3 arriba y "En la tienda 1" abajo,
   * sin nada que dijera cuál era cuál. Dos números que se contradicen en la
   * misma pantalla hacen dudar de los dos.
   */
  it('el resumen cuenta lo mismo que los chips cuando se elige un rubro', async () => {
    datos.porColeccion.catalogo.push(
      // De otro rubro: suma a los números globales y no a los de Librería.
      { __id: 'p6', doc_id: 'p6', id: 6, nombre: 'CARTULINA BLANCA', codigo: 'C006',
        rubro: 'PAPELERIA', categoria: 'Papeles', marca: 'MURESCO', precio_venta: 700,
        costo: 300, stock: 40, estado: 'activo', tienda_imagenes: ['f.webp'] },
      // Forzado a mano y sin foto: el único "publicado sin foto" del catálogo.
      { __id: 'p7', doc_id: 'p7', id: 7, nombre: 'SOBRE OFICIO', codigo: 'C007',
        rubro: 'PAPELERIA', categoria: 'Sobres', marca: 'GENERICO', precio_venta: 200,
        costo: 90, stock: 300, estado: 'activo', tienda_publicar: true },
    );

    await montar('tienda_catalogo', 'renderTiendaCatalogo');
    // Sin rubro elegido ya tienen que coincidir.
    expect(delResumen('en la tienda')).toBe(delChip('publicados'));
    expect(delResumen('publicados sin foto')).toBe(delChip('sin_foto'));
    expect(delResumen('con stock')).toBe(delChip('todos'));

    tipear(document.getElementById('tiendaRubro'), 'LIBRERIA');
    await esperar(30);

    // Librería tiene dos con stock: el cuaderno publicado y el lápiz que
    // sacaron a mano. La cartulina y el sobre son de Papelería.
    expect(delResumen('en la tienda')).toBe(delChip('publicados'));
    expect(delResumen('en la tienda')).toBe(1);
    expect(delResumen('publicados sin foto')).toBe(delChip('sin_foto'));
    expect(delResumen('publicados sin foto')).toBe(0);
    expect(delResumen('destacados')).toBe(delChip('destacados'));
    expect(delResumen('con stock')).toBe(delChip('todos'));
    expect(delResumen('con stock')).toBe(2);
    // Lo sacado a mano es parte de lo que está fuera de la tienda: nunca puede
    // ser más.
    expect(delResumen('sacados a mano')).toBeLessThanOrEqual(delChip('ocultos'));
  });

  it('buscar también acota la tarjeta de arriba, no solo la lista', async () => {
    await montar('tienda_catalogo', 'renderTiendaCatalogo');
    const buscador = document.getElementById('tiendaBuscar');
    buscador.value = 'rivadavia';
    buscador.dispatchEvent(new Event('input', { bubbles: true }));
    await esperar(30);

    expect(delResumen('con stock')).toBe(delChip('todos'));
    expect(delResumen('con stock')).toBe(1);
    expect(delResumen('en la tienda')).toBe(delChip('publicados'));
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

  /*
   * Guardar un descuento tiene que rebajar el precio en la vidriera AHORA, no
   * en la próxima corrida del sync: el cartel de la oferta ya está puesto y el
   * cliente entra a mirar en el momento.
   */
  it('crear un descuento rebaja el precio en la tienda sin esperar al sync', async () => {
    // Sin otros descuentos cargados: el que se crea es el único que manda.
    datos.porColeccion.tienda_descuentos = [];
    // El espejo, con los precios de lista.
    datos.porColeccion.tienda_productos = [
      { __id: 'p1', rubro: 'LIBRERIA', sub_rubro: 'Cuadernos', precio: 3500 },
      { __id: 'p3', rubro: 'PAPELERIA', sub_rubro: 'Resmas', precio: 18000 },
    ];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('sin red')));
    try {
      await montar('tienda_descuentos', 'renderTiendaDescuentos');
      document.getElementById('descNuevo').click();
      await esperar(20);
      tipear(document.getElementById('dNombre'), 'Semana del cuaderno');
      tipear(document.getElementById('dValor'), '20');
      // El alcance arranca en "un rubro entero" con el primero de la lista
      // elegido, que acá es Librería.
      document.querySelector('.desc-guardar').click();
      await esperar(120);
    } finally {
      globalThis.fetch = original;
    }

    const alEspejo = datos.escrituras.filter(e => e.ref?._col === 'tienda_productos');
    expect(alEspejo.map(e => e.ref.id)).toEqual(['p1']);
    expect(alEspejo[0].datos).toMatchObject({
      precio: 2800, precio_anterior: 3500,
      descuento: { nombre: 'Semana del cuaderno', porcentaje: 20 },
    });
    // La resma es de otro rubro: no se le toca el precio ni se paga la
    // escritura.
    expect(alEspejo.some(e => e.ref.id === 'p3')).toBe(false);
  });

  /*
   * Un monto fijo más grande que el precio no rebaja: ese producto queda a
   * precio de lista. Antes quedaba a $1, que se lee como error y deja pasar
   * pedidos que después no se pueden cobrar. Se puede guardar igual, pero
   * sabiéndolo antes de apretar.
   */
  it('avisa cuando el monto supera el precio del más barato del alcance', async () => {
    await montar('tienda_descuentos', 'renderTiendaDescuentos');
    document.getElementById('descNuevo').click();
    await esperar(20);
    tipear(document.getElementById('dTipo'), 'monto');
    tipear(document.getElementById('dValor'), '5000');
    await esperar(20);

    const aviso = document.getElementById('dPreview').textContent;
    expect(aviso).toContain('menos que el monto');
    expect(aviso).toContain('Cuaderno Rivadavia');
    expect(aviso).toContain('precio de lista');
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

  // 2026-09-08: la dueña destildó Cotillón y la tienda lo seguía mostrando,
  // porque una bengala estaba marcada "Publicar siempre" desde su ficha. Se
  // arregló donde tenía que arreglarse: el rubro apagado le gana a la marca
  // por producto. Acá se comprueba que la pantalla no siga prometiendo lo
  // contrario, y que el número que muestra sea el que entraría al prenderlo.
  it('un rubro apagado no promete que nada salga igual, ni con "Publicar siempre"', async () => {
    datos.porColeccion.tienda_config.push({ __id: 'publicacion', rubros: ['LIBRERIA', 'PAPELERIA'] });
    datos.porColeccion.catalogo.push(
      { __id: 'p4', doc_id: 'p4', id: 4, nombre: 'BENGALA FANTASIA', codigo: 'C004',
        rubro: 'COTILLON', sub_rubro: 'BENGALAS', precio_venta: 1200, costo: 600, stock: 14,
        estado: 'activo', tienda_publicar: true, tienda_imagenes: ['d.webp'] },
      { __id: 'p5', doc_id: 'p5', id: 5, nombre: 'GLOBO LISO', codigo: 'C005',
        rubro: 'COTILLON', sub_rubro: 'GLOBOS', precio_venta: 300, costo: 100, stock: 40,
        estado: 'activo', tienda_imagenes: ['e.webp'] },
    );
    const c = await montar('tienda_ajustes', 'renderTiendaAjustes');
    const cotillon = c.querySelector('[data-rubro="COTILLON"]')?.closest('.tienda-rubro-caja');
    expect(cotillon).toBeTruthy();
    expect(cotillon.querySelector('[data-rubro]').checked).toBe(false);
    expect(cotillon.textContent).not.toMatch(/en la tienda igual/);
    expect(cotillon.textContent).not.toMatch(/a mano/);
    // Los dos entrarían si se prende el rubro: la bengala marcada a mano y el
    // globo, que tiene foto y stock.
    expect(cotillon.textContent).toMatch(/2 con stock de 2/);
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

  it('el teléfono y el botón de avisar arman el mismo número de WhatsApp', async () => {
    // "+54 351 619 4411" copiado de un contacto: el enlace del teléfono lo
    // mandaba sin el 9 (a un celular que no existe) y el de "Avisarle" con el
    // 9. Dos reglas para el mismo número en la misma tarjeta.
    datos.porColeccion.tienda_pedidos[1].cliente.telefono = '+54 351 619 4411';
    const c = await montar('pedidos_tienda', 'renderPedidosTienda');
    const tarjeta = c.querySelector('[data-id="k2"]');
    const enlaces = [...tarjeta.querySelectorAll('a[href^="https://wa.me/"]')]
      .map(a => a.getAttribute('href'));
    expect(enlaces).toHaveLength(2);
    for (const href of enlaces) expect(href.startsWith('https://wa.me/5493516194411?')).toBe(true);
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

describe('Cupones de la Tienda', () => {
  const CUPON = {
    __id: 'BIENVENIDA', codigo: 'BIENVENIDA', nombre: 'Cupón de bienvenida', tipo: 'porcentaje',
    valor: 10, tope: 3000, minimo_compra: 15000, aplica: { modo: 'rubros', rubros: ['LIBRERIA'], etiqueta: 'Librería' },
    usos_por_persona: 1, usos_totales: null, desde: null, hasta: null,
    solo_primera_compra: false, entrega: 'cualquiera', activo: true,
  };
  const PEDIDO = {
    __id: 'ped1', codigo: 'K7M2', estado: 'entregado', total: 16200, creado: '2026-09-05T15:00:00Z',
    cliente: { nombre: 'Marta Gómez', telefono: '3515550001' },
    cupon: { codigo: 'BIENVENIDA', descuento: 1800, renglones: [{ id: 'p1', variedad: null, es_pack: false, descuento: 1800 }] },
    items: [{ id: 'p1', nombre: 'Cuaderno Rivadavia 48 hojas', cantidad: 2 }],
  };

  beforeEach(() => {
    datos.porColeccion.tienda_cupones = [{ ...CUPON }, {
      __id: 'VIEJO', codigo: 'VIEJO', nombre: 'Promo vieja', tipo: 'monto', valor: 2000,
      aplica: { modo: 'todo' }, activo: false,
    }];
    datos.porColeccion.tienda_pedidos = [{ ...PEDIDO }];
  });

  it('lista los cupones con lo que descuentan, las condiciones y los usos', async () => {
    const c = await montar('tienda_cupones', 'renderTiendaCupones');
    const t = plano(c);
    expect(t).toContain('BIENVENIDA');
    expect(t).toContain('10% de descuento (hasta $3000)');
    expect(t).toContain('compras desde $15000');
    expect(t).toContain('una vez por persona');
    expect(t).toContain('1 pedido · 1 persona · $1800 descontados');
    expect(t).toContain('Promo vieja');
    expect(t).toContain('Apagado');
    expect(t).not.toContain('NaN');
  });

  it('el botón de nuevo abre el formulario con todos los campos', async () => {
    await montar('tienda_cupones', 'renderTiendaCupones');
    document.getElementById('cupNuevo')?.click();
    await esperar(50);
    for (const id of ['cuCodigo', 'cuNombre', 'cuTipo', 'cuValor', 'cuTope', 'cuMinimo', 'cuAlcance',
                      'cuPorPersona', 'cuTotales', 'cuDesde', 'cuHasta', 'cuEntrega', 'cuPrimera', 'cuNota']) {
      expect(document.getElementById(id), id).toBeTruthy();
    }
  });

  it('un producto dado de alta con la pantalla abierta aparece en el buscador', async () => {
    // La copia del catálogo que se leyó al entrar se quedaba vieja: la pantalla
    // no se redibuja con cada venta, y lo nuevo no aparecía hasta volver a entrar.
    await montar('tienda_cupones', 'renderTiendaCupones');
    const { setCacheValue } = await import('../../webapp/src/cache.js');
    setCacheValue('catalogo:all', [
      ...CATALOGO.map(p => ({ ...p })),
      { doc_id: 'p9', nombre: 'MARCADOR FLUO NUEVO', rubro: 'LIBRERIA', precio_venta: 1500,
        stock: 3, estado: 'activo' },
    ]);

    document.getElementById('cupNuevo')?.click();
    await esperar(50);
    document.getElementById('cuAlcance').value = 'productos';
    document.getElementById('cuAlcance').dispatchEvent(new Event('change', { bubbles: true }));
    tipear(document.getElementById('cuBuscar'), 'marcador fluo');
    await esperar(20);

    expect(document.querySelector('#cuResultados [data-prod="p9"]')).toBeTruthy();
  });

  it('"Generar" arma un código que se puede dictar', async () => {
    await montar('tienda_cupones', 'renderTiendaCupones');
    document.getElementById('cupNuevo')?.click();
    await esperar(50);
    document.getElementById('cuGenerar').click();
    expect(document.getElementById('cuCodigo').value).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it('guarda el cupón con el código como id y todo lo elegido', async () => {
    await montar('tienda_cupones', 'renderTiendaCupones');
    document.getElementById('cupNuevo')?.click();
    await esperar(50);
    tipear(document.getElementById('cuCodigo'), 'primavera 25');
    tipear(document.getElementById('cuNombre'), 'Primavera');
    document.getElementById('cuTipo').value = 'porcentaje';
    document.getElementById('cuTipo').dispatchEvent(new Event('change', { bubbles: true }));
    tipear(document.getElementById('cuValor'), '25');
    tipear(document.getElementById('cuTope'), '5000');
    tipear(document.getElementById('cuMinimo'), '20000');
    tipear(document.getElementById('cuPorPersona'), '2');
    document.getElementById('cuAlcance').value = 'rubros';
    document.getElementById('cuAlcance').dispatchEvent(new Event('change', { bubbles: true }));
    const rubro = document.querySelector('#cuCajaRubros input[value="LIBRERIA"]');
    rubro.checked = true;
    rubro.dispatchEvent(new Event('change', { bubbles: true }));

    expect(plano(document.body)).toContain('25% de descuento (hasta $5000)');

    document.querySelector('.cup-guardar').click();
    for (let i = 0; i < 6; i++) await esperar();

    const escritura = datos.escrituras.find(e => e.ref?._col === 'tienda_cupones');
    expect(escritura).toBeTruthy();
    expect(escritura.ref.id).toBe('PRIMAVERA25');
    expect(escritura.datos).toMatchObject({
      codigo: 'PRIMAVERA25', nombre: 'Primavera', tipo: 'porcentaje', valor: 25, tope: 5000,
      minimo_compra: 20000, usos_por_persona: 2, usos_totales: null, activo: true,
      aplica: { modo: 'rubros', rubros: ['LIBRERIA'], etiqueta: 'Librería' },
    });
    expect(plano(document.body)).toContain('PRIMAVERA25');
  });

  it('no deja guardar un porcentaje imposible ni un código repetido', async () => {
    await montar('tienda_cupones', 'renderTiendaCupones');
    document.getElementById('cupNuevo')?.click();
    await esperar(50);
    tipear(document.getElementById('cuCodigo'), 'NUEVO1');
    tipear(document.getElementById('cuNombre'), 'Nuevo');
    tipear(document.getElementById('cuValor'), '150');
    expect(plano(document.body)).toContain('El porcentaje va de 1 a 100');

    tipear(document.getElementById('cuValor'), '10');
    tipear(document.getElementById('cuCodigo'), 'bienvenida');
    expect(plano(document.body)).toContain('Ya hay un cupón con ese código');

    document.querySelector('.cup-guardar').click();
    for (let i = 0; i < 4; i++) await esperar();
    expect(datos.escrituras.some(e => e.ref?._col === 'tienda_cupones')).toBe(false);
  });

  it('un cupón de plata fija más grande que la compra mínima no se guarda', async () => {
    await montar('tienda_cupones', 'renderTiendaCupones');
    document.getElementById('cupNuevo')?.click();
    await esperar(50);
    tipear(document.getElementById('cuCodigo'), 'REGALO');
    tipear(document.getElementById('cuNombre'), 'Regalo');
    document.getElementById('cuTipo').value = 'monto';
    document.getElementById('cuTipo').dispatchEvent(new Event('change', { bubbles: true }));
    tipear(document.getElementById('cuValor'), '5000');
    tipear(document.getElementById('cuMinimo'), '4000');
    expect(plano(document.body)).toContain('menor que la compra mínima');
  });

  it('apagar escribe el cambio y la tarjeta lo muestra', async () => {
    const c = await montar('tienda_cupones', 'renderTiendaCupones');
    c.querySelector('[data-accion="alternar"][data-id="BIENVENIDA"]').click();
    for (let i = 0; i < 4; i++) await esperar();
    const escritura = datos.escrituras.find(e => e.ref?._col === 'tienda_cupones' && e.ref.id === 'BIENVENIDA');
    expect(escritura?.datos?.activo).toBe(false);
    expect(c.querySelector('[data-accion="alternar"][data-id="BIENVENIDA"]').textContent).toContain('Activar');
  });

  it('"Ver usos" muestra quién lo usó y en qué', async () => {
    const c = await montar('tienda_cupones', 'renderTiendaCupones');
    c.querySelector('[data-accion="usos"][data-id="BIENVENIDA"]').click();
    for (let i = 0; i < 8; i++) await esperar();
    const t = plano(document.body);
    expect(t).toContain('Marta Gómez');
    expect(t).toContain('K7M2');
    expect(t).toContain('Cuaderno Rivadavia 48 hojas');
    expect(t).toContain('Entregado');
    expect(t).toContain('$1800');
  });

  it('sin cupones muestra el vacío sin NaN', async () => {
    datos.porColeccion.tienda_cupones = [];
    const c = await montar('tienda_cupones', 'renderTiendaCupones');
    expect(plano(c)).toContain('Todavía no hay cupones');
    expect(plano(c)).not.toContain('NaN');
  });
});

/* ── Estadísticas de la Tienda ────────────────────────────────────────────── */

const DIA = 24 * 60 * 60 * 1000;
const hoy = () => claveDeDia(Date.now());
const hace = (dias) => claveDeDia(Date.now() - dias * DIA);

/** Tres días de movimiento, como los escribe la función `medir`. */
function diasDeMuestra() {
  return [
    { dia: hoy(), visitas: 6, visitantes_nuevos: 2, paginas: 20, busquedas: 4, busquedas_sin_resultado: 2,
      fichas: 9, carrito: 3, checkouts: 1, chat: 1,
      horas: { 10: 8, 18: 12 }, dispositivos: { movil: 5, escritorio: 1 },
      origenes: { directo: 4, instagram: 2 },
      rubros: { LIBRERIA: { vistas: 7 }, MERCERIA: { vistas: 2 } },
      terminos: { cuaderno: { n: 2 }, mochila: { n: 2, sin: 2 } },
      productos: { 1035115: { vistas: 6, carrito: 2, nombre: 'Goma Borrar Keyroad', rubro: 'LIBRERIA' },
                   7: { vistas: 3, carrito: 1, nombre: 'Resma Pampa A4', rubro: 'PAPELERIA' } } },
    { dia: hace(1), visitas: 8, paginas: 25, busquedas: 3, busquedas_sin_resultado: 0,
      fichas: 10, carrito: 2, checkouts: 2,
      horas: { 11: 25 }, dispositivos: { movil: 8 }, origenes: { directo: 8 },
      rubros: { LIBRERIA: { vistas: 9 } },
      terminos: { cuaderno: { n: 3 } },
      productos: { 1035115: { vistas: 4, nombre: 'Goma Borrar Keyroad', rubro: 'LIBRERIA' } } },
    // Fuera de "7 días" pero adentro de "30".
    { dia: hace(12), visitas: 100, paginas: 300, busquedas: 50, fichas: 80, carrito: 10,
      horas: { 9: 300 }, dispositivos: { escritorio: 100 }, origenes: { google: 100 },
      terminos: { tijera: { n: 50 } },
      productos: { 9: { vistas: 80, nombre: 'Tijera Maped', rubro: 'LIBRERIA' } } },
  ];
}

function pedidosDeMuestra() {
  return [
    { estado: 'entregado', total: 12000, creado: new Date(Date.now() - 3600_000),
      items: [{ id: '1035115', cantidad: 2 }, { id: '7', cantidad: 1 }] },
    { estado: 'nuevo', total: 5000, creado: new Date(Date.now() - 2 * 3600_000),
      items: [{ id: '1035115', cantidad: 1 }] },
    { estado: 'cancelado', total: 90000, creado: new Date(Date.now() - 3 * 3600_000),
      items: [{ id: '1035115', cantidad: 9 }] },
  ];
}

/**
 * Contesta las consultas por REST del panel con lo de arriba, respetando el
 * filtro de `dia` para que se note cuando cambia el rango.
 */
function restDeEstadisticas({ dias = diasDeMuestra(), pedidos = pedidosDeMuestra(), registro = [] } = {}) {
  return vi.fn(async (url, opciones = {}) => {
    const consulta = JSON.parse(opciones.body || '{}').structuredQuery || {};
    const coleccion = consulta.from?.[0]?.collectionId;
    registro.push({ url: String(url), coleccion, consulta, token: opciones.headers?.Authorization });
    const filtros = consulta.where?.compositeFilter?.filters
      || (consulta.where ? [consulta.where] : []);
    let docs = [];
    if (coleccion === 'tienda_estadisticas') {
      const desde = filtros.find(f => f.fieldFilter.op === 'GREATER_THAN_OR_EQUAL')?.fieldFilter.value.stringValue;
      const hasta = filtros.find(f => f.fieldFilter.op === 'LESS_THAN_OR_EQUAL')?.fieldFilter.value.stringValue;
      docs = dias.filter(d => (!desde || d.dia >= desde) && (!hasta || d.dia <= hasta))
        .map(d => ({ id: d.dia, datos: d }));
    } else if (coleccion === 'tienda_pedidos') {
      const desde = filtros[0]?.fieldFilter.value.timestampValue;
      docs = pedidos.filter(p => !desde || p.creado.toISOString() >= desde)
        .map((p, i) => ({ id: `ped${i}`, datos: p }));
    }
    const filas = docs.length
      ? docs.map(d => ({ document: { name: `projects/x/databases/(default)/documents/${coleccion}/${d.id}`, fields: aCampos(d.datos) } }))
      : [{ readTime: 'x' }];
    return { ok: true, status: 200, json: async () => filas };
  });
}

describe('Estadísticas de la Tienda', () => {
  const original = globalThis.fetch;
  afterEach(() => { globalThis.fetch = original; });

  it('muestra los totales del período y los rankings', async () => {
    globalThis.fetch = restDeEstadisticas();
    const c = await montar('tienda_estadisticas', 'renderTiendaEstadisticas');
    const texto = plano(c);

    // Con "30 días" (el rango por defecto) entran los tres documentos.
    expect(texto).toContain('114');                       // visitas: 6 + 8 + 100
    expect(texto).toContain('Buscaron y no encontraron');
    expect(texto).toContain('mochila');
    expect(texto).toContain('Goma Borrar Keyroad');
    expect(texto).toContain('Tijera Maped');
    expect(texto).toContain('Instagram');
    expect(texto).toContain('Celular');
    expect(texto).toContain('Librería');
    expect(texto).not.toContain('NaN');
    expect(texto).not.toContain('undefined');
    // La hoja de estilos tiene que sobrevivir al pintado con datos: si se va
    // con el esqueleto, la pantalla se ve como texto suelto sin barras.
    expect(c.querySelector('style')).toBeTruthy();
    expect(c.querySelector('.est-fila__barra > span')).toBeTruthy();

    if (process.env.CAPTURA_DIR) {
      fs.writeFileSync(`${process.env.CAPTURA_DIR}/estadisticas.html`, c.innerHTML);
    }
  });

  it('los pedidos salen de tienda_pedidos y los cancelados no cuentan', async () => {
    globalThis.fetch = restDeEstadisticas();
    const c = await montar('tienda_estadisticas', 'renderTiendaEstadisticas');
    const tarjeta = [...c.querySelectorAll('.stat-card')].find(x => x.textContent.includes('Pedidos'));
    expect(tarjeta.querySelector('.value').textContent).toBe('2');
    expect(plano(tarjeta)).toContain('$17000');
    // En la tabla de productos, la goma está en dos pedidos vivos, no en tres.
    const filaGoma = [...c.querySelectorAll('.est-tabla tbody tr')].find(tr => tr.textContent.includes('Goma Borrar'));
    const celdas = [...filaGoma.querySelectorAll('td')].map(td => td.textContent.trim());
    expect(celdas[celdas.length - 1]).toBe('2');
  });

  it('cambiar el rango vuelve a leer desde otro día y lo recuerda', async () => {
    const registro = [];
    globalThis.fetch = restDeEstadisticas({ registro });
    const c = await montar('tienda_estadisticas', 'renderTiendaEstadisticas');
    expect(plano(c)).toContain('Tijera Maped');

    c.querySelector('[data-rango="7"]').click();
    for (let i = 0; i < 10; i++) await esperar();

    expect(plano(c)).not.toContain('Tijera Maped');
    expect(plano(c)).toContain('14');                     // visitas: 6 + 8
    expect(c.querySelector('[data-rango="7"]').getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('tienda_estadisticas.rango')).toBe('7');

    const lecturas = registro.filter(r => r.coleccion === 'tienda_estadisticas');
    expect(lecturas).toHaveLength(2);
    const desde = lecturas[1].consulta.where.compositeFilter.filters[0].fieldFilter.value.stringValue;
    expect(desde).toBe(hace(6));
    // Va con el token de la sesión: la colección no se lee sin él.
    expect(lecturas[1].token).toBe('Bearer T');
  });

  it('con "Hoy" no dibuja el día por día, sí las horas', async () => {
    localStorage.setItem('tienda_estadisticas.rango', 'hoy');
    globalThis.fetch = restDeEstadisticas();
    const c = await montar('tienda_estadisticas', 'renderTiendaEstadisticas');
    expect(plano(c)).not.toContain('Visitas por día');
    expect(plano(c)).toContain('A qué hora entran');
    expect(plano(c)).toContain('Hoy,');
  });

  it('sin movimiento explica que la tienda cuenta sola', async () => {
    globalThis.fetch = restDeEstadisticas({ dias: [], pedidos: [] });
    const c = await montar('tienda_estadisticas', 'renderTiendaEstadisticas');
    expect(plano(c)).toContain('Todavía no hay movimiento');
    expect(c.querySelector('.stat-card')).toBeNull();
  });

  it('si la REST no responde, cae al SDK', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('sin red')));
    datos.porColeccion.tienda_estadisticas = diasDeMuestra().map(d => ({ __id: d.dia, ...d }));
    datos.porColeccion.tienda_pedidos = [];
    const silencio = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = await montar('tienda_estadisticas', 'renderTiendaEstadisticas');
    silencio.mockRestore();
    expect(plano(c)).toContain('Goma Borrar Keyroad');
    expect(plano(c)).toContain('114');
  });

  it('un error de lectura se muestra con reintento, sin dejar el esqueleto', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('sin red')));
    const mod = await import('firebase/firestore');
    const getDocsOriginal = mod.getDocs;
    mod.getDocs = async () => { throw new Error('permiso denegado'); };
    const silencio = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const silencioError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const c = await montar('tienda_estadisticas', 'renderTiendaEstadisticas');
      expect(plano(c)).toContain('No se pudieron leer las estadísticas');
      expect(c.querySelector('[data-reintentar]')).toBeTruthy();
    } finally {
      mod.getDocs = getDocsOriginal;
      silencio.mockRestore();
      silencioError.mockRestore();
    }
  });
});
