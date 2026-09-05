// @vitest-environment jsdom
/**
 * Las pantallas de la tienda, abriéndolas: la portada, el catálogo, la ficha de
 * un producto, el seguimiento de un pedido y la cuenta.
 *
 * Es el equivalente de `paginas_panel.test.js` para el lado del cliente. Cada
 * una se monta dos veces: con la tienda cargada de productos y con la tienda
 * vacía, que es como arranca una instalación nueva y como queda cuando una
 * consulta no devuelve nada. Ninguna puede romperse ahí ni mostrar un hueco.
 *
 * Además se prueba lo que cada una tiene que decir: la portada muestra
 * destacados, el catálogo filtra por rubro y busca, y el seguimiento encuentra
 * un pedido por su código.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { datos } = vi.hoisted(() => ({
  datos: { productos: [], rubros: [], config: null, avisos: [], pedidos: {}, vacio: false },
}));

vi.mock('firebase/firestore', async () =>
  (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../src/firebase.js', () => ({ db: {}, app: {} }));

vi.mock('../src/datos.js', async (original) => {
  const real = await original();
  const lista = () => (datos.vacio ? [] : datos.productos);
  return {
    ...real,
    cargarConfig: async () => datos.config,
    cargarAvisos: async () => datos.avisos,
    cargarRubros: async () => (datos.vacio ? [] : datos.rubros),
    subrubrosDe: async () => [],
    traerProductos: async ({ rubro = null } = {}) => ({
      productos: lista().filter(p => !rubro || p.rubro === rubro),
      cursor: null,
    }),
    traerDestacados: async () => lista().slice(0, 4),
    traerMuestra: async () => lista().slice(0, 4),
    traerProducto: async (id) => lista().find(p => p.id === id) || null,
    traerGrupo: async () => [],
    buscar: async (texto) => {
      const q = String(texto || '').toLowerCase();
      return lista().filter(p => p.nombre.toLowerCase().includes(q));
    },
    sugerir: async () => [],
  };
});
vi.mock('../src/pedidos.js', async (original) => {
  const real = await original();
  return {
    ...real,
    traerPedido: async (id) => datos.pedidos[id] || null,
    seguirPedido: (id, alCambiar) => { alCambiar(datos.pedidos[id] || null); return () => {}; },
    pedidosDeLaCuenta: async () => [],
  };
});
vi.mock('../src/cuenta.js', () => ({
  iniciarCuenta: async () => null,
  sesion: () => null,
  alCambiarSesion: () => () => {},
  crearCuenta: async () => ({}),
  entrar: async () => ({}),
  entrarConGoogle: async () => ({}),
  recuperarClave: async () => {},
  salir: async () => {},
  guardarPerfil: async () => {},
  datosParaCompletar: () => null,
  recordarDelPedido: async () => {},
}));
vi.mock('../src/mapa.js', () => ({ montarMapa: () => {} }));
vi.mock('../src/direcciones.js', () => ({ montarDirecciones: () => {} }));

const CONFIG = {
  abierta: true,
  entrega: { retiro_habilitado: true, delivery_habilitado: true, pedido_minimo: 6500,
             demora_texto: 'Listo en 2 horas' },
  pago: { efectivo_habilitado: true, transferencia_habilitada: true, alias: 'liceo.libreria' },
  horarios: { lun: [['09:00', '20:30']], mar: [['09:00', '20:30']], mie: [['09:00', '20:30']],
              jue: [['09:00', '20:30']], vie: [['09:00', '20:30']], sab: [['09:00', '13:00']],
              dom: [] },
};

const PRODUCTOS = [
  { id: 'p1', nombre: 'Cuaderno Rivadavia 48 hojas', precio: 3500, stock: 12,
    rubro: 'LIBRERIA', categoria: 'Cuadernos', marca: 'RIVADAVIA', imagenes: ['a.webp'] },
  { id: 'p2', nombre: 'Lápiz Faber HB', precio: 900, stock: 60,
    rubro: 'LIBRERIA', categoria: 'Escritura', marca: 'FABER', imagenes: ['b.webp'] },
  { id: 'p3', nombre: 'Resma Pampa A4', precio: 18000, stock: 4,
    rubro: 'PAPELERIA', categoria: 'Resmas', marca: 'PAMPA', imagenes: ['c.webp'] },
];

const CARGAR = {
  inicio: () => import('../src/paginas/inicio.js'),
  catalogo: () => import('../src/paginas/catalogo.js'),
  producto: () => import('../src/paginas/producto.js'),
  seguimiento: () => import('../src/paginas/seguimiento.js'),
  cuenta: () => import('../src/paginas/cuenta.js'),
  pedido: () => import('../src/paginas/pedido.js'),
};

let raiz;

/** Monta una pantalla de la tienda y espera a que termine de completarse. */
async function abrir(clave, { params = {}, query = new URLSearchParams() } = {}) {
  const mod = await CARGAR[clave]();
  raiz = document.createElement('div');
  raiz.id = 'app';
  document.body.appendChild(raiz);
  await mod[clave]({ montar: (html) => { raiz.innerHTML = html; }, params, query });
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
  return raiz;
}

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));
const plano = () => document.body.textContent.replace(/\./g, '');

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  datos.productos = PRODUCTOS.map(p => ({ ...p }));
  datos.rubros = [{ nombre: 'LIBRERIA', cantidad: 2 }, { nombre: 'PAPELERIA', cantidad: 1 }];
  datos.config = JSON.parse(JSON.stringify(CONFIG));
  datos.avisos = [];
  datos.pedidos = {};
  datos.vacio = false;
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
  window.history.replaceState({}, '', '/');
  globalThis.IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
  Element.prototype.scrollIntoView = () => {};
});

describe('las pantallas de la tienda, con productos', () => {
  for (const [clave, params] of [
    ['inicio', {}], ['catalogo', {}], ['producto', { id: 'p1' }],
    ['seguimiento', {}], ['cuenta', {}],
  ]) {
    it(clave, async () => {
      const c = await abrir(clave, { params });
      expect(c.innerHTML.length, 'no pintó nada').toBeGreaterThan(0);
      const t = plano();
      expect(t, clave).not.toContain('NaN');
      expect(t, clave).not.toContain('undefined');
      expect(t, clave).not.toContain('[object Object]');
    });
  }
});

describe('las pantallas de la tienda, sin nada cargado', () => {
  // Es el arranque de una instalación nueva y el estado al que se cae cuando
  // una consulta devuelve vacío.
  for (const [clave, params] of [
    ['inicio', {}], ['catalogo', {}], ['producto', { id: 'no-existe' }],
    ['seguimiento', {}], ['cuenta', {}],
  ]) {
    it(clave, async () => {
      datos.vacio = true;
      const c = await abrir(clave, { params });
      expect(c.innerHTML.length, 'no pintó nada').toBeGreaterThan(0);
      const t = plano();
      expect(t, clave).not.toContain('NaN');
      expect(t, clave).not.toContain('undefined');
    });
  }
});

describe('la portada', () => {
  it('muestra productos y precios', async () => {
    const c = await abrir('inicio');
    const t = plano();
    expect(c.textContent).toContain('Cuaderno Rivadavia');
    expect(t).toContain('3500');
  });

  it('muestra los horarios del local', async () => {
    // El cartel de "cerrado" lo pone el encabezado, no la portada: acá lo que
    // tiene que estar es cuándo se puede ir.
    const c = await abrir('inicio');
    expect(c.textContent.toLowerCase()).toMatch(/horario|lunes|20:30|9 a/);
  });
});

describe('el catálogo', () => {
  it('lista todo cuando no se filtra nada', async () => {
    const c = await abrir('catalogo');
    const t = c.textContent;
    expect(t).toContain('Cuaderno Rivadavia');
    expect(t).toContain('Resma Pampa');
  });

  it('filtrado por rubro muestra sólo ese rubro', async () => {
    const c = await abrir('catalogo', { params: { rubro: 'PAPELERIA' } });
    const t = c.textContent;
    expect(t).toContain('Resma Pampa');
    expect(t).not.toContain('Cuaderno Rivadavia');
  });

  it('una búsqueda por la dirección muestra lo que coincide', async () => {
    const c = await abrir('catalogo', { query: new URLSearchParams('q=resma') });
    const t = c.textContent;
    expect(t).toContain('Resma Pampa');
    expect(t).not.toContain('Lápiz Faber');
  });

  it('una búsqueda sin resultados lo dice, no deja la pantalla en blanco', async () => {
    const c = await abrir('catalogo', { query: new URLSearchParams('q=zzzzz') });
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(c.textContent.toLowerCase()).toMatch(/no encontr|sin resultado|nada/);
  });
});

describe('la ficha de un producto', () => {
  it('muestra nombre, precio y que hay stock', async () => {
    const c = await abrir('producto', { params: { id: 'p1' } });
    const t = plano();
    expect(c.textContent).toContain('Cuaderno Rivadavia');
    expect(t).toContain('3500');
  });

  it('un producto que no existe no deja la pantalla vacía', async () => {
    const c = await abrir('producto', { params: { id: 'no-existe' } });
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(c.textContent.toLowerCase()).toMatch(/no (lo )?encontr|no existe|no est/);
  });

  it('deja lo que Google necesita para mostrar el precio en el resultado', async () => {
    await abrir('producto', { params: { id: 'p1' } });
    expect(document.head.innerHTML).toContain('3500');
  });
});

describe('mis pedidos', () => {
  it('sin ninguno lo dice, no deja la pantalla en blanco', async () => {
    const c = await abrir('seguimiento');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(c.textContent.toLowerCase()).toMatch(/pedido/);
  });

  // Con cero pedidos el primer pintado es el cartelito de "buscando los de tu
  // cuenta". Despues se lo sacaba y se cortaba antes de repintar, asi que el
  // estado vacio no llegaba a aparecer nunca: quedaba el titulo y una lista
  // vacia. Es lo que ve cualquiera que entra a "Mis pedidos" sin haber comprado.
  it('sin ninguno muestra el estado vacio de verdad, no el esqueleto', async () => {
    // La pantalla descarta lo que llega tarde comparando la ruta, asi que el
    // segundo pintado solo ocurre estando parado en ella.
    window.history.replaceState({}, '', '/seguimiento');
    const c = await abrir('seguimiento');
    expect(c.textContent).toContain('Todavía no hiciste ningún pedido');
    expect(c.querySelector('.vacio')).not.toBeNull();
    expect(c.querySelector('[data-buscando]')).toBeNull();
    // Y una salida: sin esto el estado vacio es un cartel y nada mas.
    expect(c.querySelector('a[href="/catalogo"]')).not.toBeNull();
  });

  it('lista los que hizo este teléfono', async () => {
    // Se guardan al confirmar: es lo que permite volver a mirar el estado sin
    // tener cuenta.
    localStorage.setItem('liceo.pedidos.v1', JSON.stringify([
      { id: 'k1', codigo: 'K7M2', total: 7000, cuando: Date.now(), modo: 'retiro' },
    ]));
    const c = await abrir('seguimiento');
    expect(c.textContent).toContain('K7M2');
    expect(plano()).toContain('7000');
  });
});

describe('el pedido confirmado', () => {
  beforeEach(() => {
    datos.pedidos.k1 = {
      id: 'k1', codigo: 'K7M2', estado: 'preparando',
      cliente: { nombre: 'Marta Gómez', telefono: '3515550001' },
      entrega: { modo: 'retiro' }, pago: { modo: 'efectivo', pagado: false },
      items: [{ id: 'p1', nombre: 'Cuaderno Rivadavia', cantidad: 2, precio: 3500,
                subtotal: 7000 }],
      subtotal: 7000, envio: 0, total: 7000,
      creado: { toMillis: () => Date.now(), toDate: () => new Date() },
    };
  });

  it('muestra el código, lo que se pidió y el total', async () => {
    const c = await abrir('pedido', { params: { id: 'k1' } });
    const t = plano();
    expect(t).toContain('K7M2');
    expect(c.textContent).toContain('Cuaderno Rivadavia');
    expect(t).toContain('7000');
  });

  it('muestra en qué paso está', async () => {
    const c = await abrir('pedido', { params: { id: 'k1' } });
    expect(c.textContent.toLowerCase()).toMatch(/prepar/);
  });

  it('un pedido que no existe lo dice', async () => {
    const c = await abrir('pedido', { params: { id: 'no-existe' } });
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(c.textContent.toLowerCase()).toMatch(/no (lo )?encontr|no existe/);
  });

});

describe('la cuenta', () => {
  it('sin sesión ofrece entrar', async () => {
    const c = await abrir('cuenta');
    expect(c.textContent.toLowerCase()).toMatch(/entrar|ingres|correo|cuenta/);
  });
});

describe('las direcciones que no se indexan', () => {
  // Quién decide esto es el shell (`main.js`), no cada pantalla: la lista vive
  // en un solo lugar y tiene que cubrir todo lo que muestra datos de alguien.
  const PRIVADAS = ['/checkout', '/pedido', '/seguimiento', '/cuenta'];

  it('están las cuatro pantallas de una sola persona', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fuente = readFileSync(join(process.cwd(), 'src', 'main.js'), 'utf8');
    for (const camino of PRIVADAS) {
      expect(fuente, `${camino} tiene que estar en la lista de privadas`)
        .toContain(`'${camino}'`);
    }
  });

  it('marcada como privada, la pantalla queda fuera de Google', async () => {
    const { fijarPantalla } = await import('../src/seo.js');
    Object.defineProperty(window, 'location', {
      value: new URL('https://liceolibreria.com/pedido/k1'), configurable: true,
    });
    fijarPantalla({ privada: true });
    expect(document.head.querySelector('meta[name="robots"]').content)
      .toContain('noindex');
  });
});

describe('la portada', () => {
  // Las fichas de rubro son el menu, no la vidriera. Antes se les aplicaba el
  // mismo corte que a las tiras y la portada ofrecia seis rubros contra los
  // ocho del catalogo: Cotillon y Merceria no estaban por ningun lado.
  it('las fichas listan todos los rubros del catalogo', async () => {
    datos.rubros = [
      { clave: 'LIBRERIA', nombre: 'Libreria', cantidad: 880, con_stock: 880 },
      { clave: 'PAPELERIA', nombre: 'Papeleria', cantidad: 120, con_stock: 120 },
      { clave: 'MERCERIA', nombre: 'Merceria', cantidad: 30, con_stock: 2 },
      { clave: 'COTILLON', nombre: 'Cotillon', cantidad: 8, con_stock: 1 },
    ];
    const c = await abrir('inicio');
    const fichas = [...c.querySelectorAll('.rubro-ficha')];
    expect(fichas).toHaveLength(4);
    expect([...c.querySelectorAll('.rubro-ficha__nombre')].map(n => n.textContent))
      .toEqual(['Libreria', 'Papeleria', 'Merceria', 'Cotillon']);
  });

  // "Perfumeria - 6" al lado de "Libreria - 888" no informa: avisa que ahi no
  // hay nada. El rubro sigue estando, sin el cartelito que lo hunde.
  it('el contador solo sale cuando el numero juega a favor', async () => {
    datos.rubros = [
      { clave: 'LIBRERIA', nombre: 'Libreria', cantidad: 880, con_stock: 880 },
      { clave: 'PERFUMERIA', nombre: 'Perfumeria', cantidad: 9, con_stock: 6 },
    ];
    const c = await abrir('inicio');
    const cuentas = [...c.querySelectorAll('.rubro-ficha__cuenta')].map(n => n.textContent);
    expect(cuentas).toHaveLength(1);
    expect(cuentas[0]).toContain('880');
  });
});

describe('la ficha, cuando falta elegir el color', () => {
  const conColores = {
    id: 'v1', nombre: 'Cartulina Luma', precio: 800, stock: 30,
    rubro: 'LIBRERIA', categoria: 'Papeles', marca: 'LUMA', imagenes: ['a.webp'],
    variedades: [
      { nombre: 'Rojo', stock: 10 },
      { nombre: 'Celeste', stock: 12 },
    ],
  };

  // Tocar "Agregar" sin color elegido no agrega nada. El aviso flotante dura
  // cuatro segundos y era la unica senal: quien no llegaba a leerlo veia un
  // boton que no hace nada, que se lee como que la pagina esta rota.
  it('el selector queda marcado y el motivo se queda a la vista', async () => {
    datos.productos = [conColores];
    const c = await abrir('producto', { params: { id: 'v1' } });

    const falta = c.querySelector('[data-falta-variedad]');
    expect(falta.hidden).toBe(true);

    c.querySelector('[data-agregar]').click();
    expect(falta.hidden).toBe(false);
    expect(c.querySelector('[data-variedades]').className).toContain('variedades--falta');
    expect(falta.textContent).toContain('Eleg');
  });

  it('elegir el color lo limpia', async () => {
    datos.productos = [conColores];
    const c = await abrir('producto', { params: { id: 'v1' } });

    c.querySelector('[data-agregar]').click();
    expect(c.querySelector('[data-falta-variedad]').hidden).toBe(false);

    c.querySelector('[data-variedad="Celeste"]').click();
    expect(c.querySelector('[data-falta-variedad]').hidden).toBe(true);
    expect(c.querySelector('[data-variedades]').className).not.toContain('variedades--falta');
  });

  it('sin variedades el boton agrega y no marca nada', async () => {
    const c = await abrir('producto', { params: { id: 'p1' } });
    expect(c.querySelector('[data-falta-variedad]')).toBeNull();
    c.querySelector('[data-agregar]').click();
    const carrito = await import('../src/carrito.js');
    expect(carrito.items().map(r => r.id)).toContain('p1');
    carrito.vaciar();
  });
});

describe('una busqueda sin resultados', () => {
  // Los nombres del catalogo salen del POS ("Abrojo 100MM X Mt"), asi que "no
  // tenemos nada con esas palabras" muchas veces quiere decir "lo tenemos con
  // otro nombre". El chat busca por lo que la cosa ES, y a esa altura el
  // cliente ya se estaba yendo.
  it('ofrece preguntarle al chat con lo que se busco', async () => {
    const c = await abrir('catalogo', { query: new URLSearchParams('q=zzzz') });
    const boton = c.querySelector('[data-preguntar]');
    expect(boton).not.toBeNull();
    expect(boton.dataset.preguntar).toBe('zzzz');
    expect(boton.textContent).toContain('zzzz');
  });

  it('el boton abre el chat con la pregunta ya escrita', async () => {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const c = await abrir('catalogo', { query: new URLSearchParams('q=zzzz') });
    c.querySelector('[data-preguntar]').click();

    const panel = document.querySelector('.asistente-panel');
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('zzzz');
    panel.remove();
    document.body.style.overflow = '';
  });

  it('el WhatsApp sigue estando', async () => {
    const c = await abrir('catalogo', { query: new URLSearchParams('q=zzzz') });
    expect(c.querySelector('a[href*="wa.me"]')).not.toBeNull();
  });
});
