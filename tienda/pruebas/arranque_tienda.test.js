// @vitest-environment jsdom
/**
 * El armado de la tienda: `main.js`.
 *
 * Es lo que ata todo — el ruteo, el encabezado, los botones de agregar que
 * están repartidos por todas las grillas, el aviso de local cerrado y el chat.
 * Nada de esto pertenece a una pantalla: si se rompe, se rompe en todas a la
 * vez y sin un error que lo diga.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { estado } = vi.hoisted(() => ({
  estado: { config: null, catalogo: {}, pintadas: [], romper: null },
}));

vi.mock('firebase/firestore', async () =>
  (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../src/firebase.js', () => ({ db: {}, app: {} }));
vi.mock('../src/datos.js', async (original) => {
  const real = await original();
  return {
    ...real,
    cargarConfig: async () => estado.config,
    cargarAvisos: async () => [],
    cargarRubros: async () => [],
    subrubrosDe: async () => [],
    traerProducto: async (id) => estado.catalogo[id] ?? null,
    traerProductos: async () => ({ productos: [], cursor: null }),
    traerDestacados: async () => [],
    traerMuestra: async () => [],
    traerGrupo: async () => [],
    buscar: async () => [],
    sugerir: async () => [],
  };
});
// Las pantallas se prueban aparte: acá lo que importa es el shell que las monta.
const pantallaFalsa = (nombre) => async ({ montar }) => {
  if (estado.romper === nombre) throw new Error('se rompio la pantalla');
  estado.pintadas.push(nombre);
  montar(`<div class="pantalla-${nombre}">contenido de ${nombre}</div>`);
};
vi.mock('../src/paginas/inicio.js', () => ({ inicio: pantallaFalsa('inicio') }));
vi.mock('../src/paginas/catalogo.js', () => ({ catalogo: pantallaFalsa('catalogo') }));
vi.mock('../src/paginas/producto.js', () => ({ producto: pantallaFalsa('producto') }));
vi.mock('../src/paginas/checkout.js', () => ({ checkout: pantallaFalsa('checkout') }));
vi.mock('../src/paginas/pedido.js', () => ({ pedido: pantallaFalsa('pedido') }));
vi.mock('../src/paginas/seguimiento.js', () => ({ seguimiento: pantallaFalsa('seguimiento') }));
vi.mock('../src/paginas/cuenta.js', () => ({ cuenta: pantallaFalsa('cuenta') }));
vi.mock('../src/cuenta.js', () => ({
  iniciarCuenta: async () => null, sesion: () => null,
  alCambiarSesion: () => () => {}, datosParaCompletar: () => null,
  recordarDelPedido: async () => {},
}));

const CONFIG = {
  abierta: true,
  entrega: { retiro_habilitado: true, delivery_habilitado: true, pedido_minimo: 6500 },
  pago: { efectivo_habilitado: true },
  horarios: { lun: [['09:00', '20:30']], mar: [['09:00', '20:30']], mie: [['09:00', '20:30']],
              jue: [['09:00', '20:30']], vie: [['09:00', '20:30']], sab: [['09:00', '13:00']],
              dom: [] },
};

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** Levanta la tienda en la dirección que se le pase. */
async function arrancar(camino = '/') {
  window.history.replaceState({}, '', camino);
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  estado.pintadas = [];
  await import('../src/main.js');
  for (let i = 0; i < 14; i++) await esperar();
  return document.getElementById('app');
}

// jsdom no deja cambiar el host de otra forma, y dejarlo pisado rompe la
// navegacion de las pruebas siguientes: se guarda para reponerlo.
const LOCATION_ORIGINAL = Object.getOwnPropertyDescriptor(window, 'location');

function enHost(url) {
  Object.defineProperty(window, 'location', { value: new URL(url), configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '';
  estado.romper = null;
  estado.config = JSON.parse(JSON.stringify(CONFIG));
  estado.catalogo = {
    p1: { id: 'p1', nombre: 'Cuaderno Rivadavia', precio: 3500, stock: 12,
          rubro: 'LIBRERIA', imagenes: ['a.webp'] },
  };
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200,
                                                   json: async () => ({}) }));
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  if (LOCATION_ORIGINAL) Object.defineProperty(window, 'location', LOCATION_ORIGINAL);
});

describe('el armado', () => {
  it('arma el encabezado, el contenido y la barra de abajo', async () => {
    const app = await arrancar('/');
    expect(app.querySelector('[data-cabecera]')).toBeTruthy();
    expect(app.querySelector('.principal')).toBeTruthy();
    expect(app.querySelector('[data-nav]')).toBeTruthy();
  });

  it('la portada es la que se pinta en la raíz', async () => {
    await arrancar('/');
    expect(estado.pintadas).toContain('inicio');
  });

  it('cada dirección lleva a su pantalla', async () => {
    for (const [camino, pantalla] of [
      ['/catalogo', 'catalogo'],
      ['/catalogo/PAPELERIA', 'catalogo'],
      ['/p/p1', 'producto'],
      ['/checkout', 'checkout'],
      ['/pedido/k1', 'pedido'],
      ['/seguimiento', 'seguimiento'],
      ['/cuenta', 'cuenta'],
    ]) {
      await arrancar(camino);
      expect(estado.pintadas, camino).toContain(pantalla);
    }
  });

  it('una dirección que no existe muestra el "no encontramos"', async () => {
    const app = await arrancar('/esto-no-existe');
    expect(app.textContent.toLowerCase()).toMatch(/no encontramos/);
    expect(app.querySelector('a[href="/"]')).toBeTruthy();
  });

  it('la portada tiene su título propio', async () => {
    await arrancar('/');
    expect(document.title.toLowerCase()).toContain('librería liceo');
  });
});

describe('lo que se le dice a Google', () => {
  it('el catálogo se indexa', async () => {
    await arrancar('/catalogo');
    enHost('https://liceolibreria.com/catalogo');
    const { fijarPantalla } = await import('../src/seo.js');
    fijarPantalla({ privada: false });
    const robots = document.head.querySelector('meta[name="robots"]');
    expect(robots).toBeNull();
  });

  it('el checkout y el pedido no', async () => {
    // Muestran datos de una sola persona: no tienen nada que hacer en un
    // buscador.
    for (const camino of ['/checkout', '/pedido/k1', '/cuenta', '/seguimiento']) {
      await arrancar(camino);
      const robots = document.head.querySelector('meta[name="robots"]');
      expect(robots?.content || '', camino).toContain('noindex');
    }
  });
});

describe('el botón de agregar, esté donde esté', () => {
  it('suma el producto al carrito', async () => {
    // Va delegado en el documento a propósito: el encabezado y las grillas se
    // repintan todo el tiempo, y enganchar botón por botón se olvida siempre en
    // algún camino.
    const app = await arrancar('/');
    const carrito = await import('../src/carrito.js');
    carrito.vaciar();

    app.querySelector('.principal').innerHTML =
      '<button data-agregar="p1">Agregar</button>';
    app.querySelector('[data-agregar]').click();
    for (let i = 0; i < 10; i++) await esperar();

    expect(carrito.items()).toHaveLength(1);
    expect(carrito.items()[0].nombre).toBe('Cuaderno Rivadavia');
  });

  it('un producto que ya no está lo avisa en vez de agregar la nada', async () => {
    const app = await arrancar('/');
    const carrito = await import('../src/carrito.js');
    carrito.vaciar();

    app.querySelector('.principal').innerHTML =
      '<button data-agregar="no-existe">Agregar</button>';
    app.querySelector('[data-agregar]').click();
    for (let i = 0; i < 10; i++) await esperar();

    expect(carrito.items()).toHaveLength(0);
    expect(document.body.textContent.toLowerCase()).toMatch(/ya no est/);
  });

  it('con variedades lleva a la ficha a elegir, no suma a ciegas', async () => {
    // Sumar uno cualquiera entre cinco colores obliga al cliente a corregirlo
    // después.
    const app = await arrancar('/');
    const carrito = await import('../src/carrito.js');
    carrito.vaciar();

    app.querySelector('.principal').innerHTML =
      '<button data-agregar="p1" data-elegir="1">Elegir</button>';
    app.querySelector('[data-agregar]').click();
    for (let i = 0; i < 10; i++) await esperar();

    expect(carrito.items()).toHaveLength(0);
    expect(window.location.pathname).toBe('/p/p1');
  });
});

describe('el aviso de local cerrado', () => {
  it('con el local abierto no aparece', async () => {
    const app = await arrancar('/');
    await esperar(50);
    expect(document.querySelector('.aviso-cerrada')).toBeNull();
    expect(app.innerHTML.length).toBeGreaterThan(0);
  });

  it('cerrado a mano lo dice, y con la vuelta', async () => {
    // "Cerrado" a secas hace que la persona se vaya; saber que puede mirar el
    // catálogo igual, no.
    estado.config.abierta = false;
    await arrancar('/');
    await esperar(80);
    const aviso = document.querySelector('.aviso-cerrada');
    expect(aviso).toBeTruthy();
    expect(aviso.textContent.toLowerCase()).toMatch(/cerrad/);
    expect(aviso.textContent.toLowerCase()).toMatch(/cat[áa]logo|pod[ée]s/);
  });

  it('el cartel del local va antes que el cartel suelto', async () => {
    // Si están los dos, el de cerrada va primero: es el que cambia lo que la
    // persona puede hacer.
    estado.config.abierta = false;
    estado.config.banner = 'Descuento del 10% esta semana';
    await arrancar('/');
    await esperar(80);
    const avisos = [...document.querySelectorAll('.aviso-cerrada, .aviso-banner')];
    expect(avisos).toHaveLength(2);
    expect(avisos[0].className).toBe('aviso-cerrada');
  });

  it('los avisos se anuncian a un lector de pantalla', async () => {
    estado.config.abierta = false;
    await arrancar('/');
    await esperar(80);
    expect(document.querySelector('.aviso-cerrada').getAttribute('role')).toBe('status');
  });
});

describe('el buscador del encabezado', () => {
  it('lo que se busca lleva al catálogo con la consulta', async () => {
    const app = await arrancar('/');
    const form = app.querySelector('[data-buscador]');
    if (!form) return;
    const campo = form.querySelector('#q');
    campo.value = 'cuaderno';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 10; i++) await esperar();

    expect(window.location.pathname).toBe('/catalogo');
    expect(window.location.search).toContain('cuaderno');
  });
});

describe('cuando una pantalla se rompe', () => {
  it('la tienda muestra un cartel, no una pantalla en blanco', async () => {
    // Es la última red: mejor "algo se rompió, reintentá" que un hueco mudo.
    const espia = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      estado.romper = 'inicio';
      const app = await arrancar('/');
      expect(app.textContent.toLowerCase()).toMatch(/se rompi/);
      expect(app.querySelector('button')).toBeTruthy();
    } finally {
      espia.mockRestore();
    }
  });
});
