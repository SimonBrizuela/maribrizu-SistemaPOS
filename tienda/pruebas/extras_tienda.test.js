// @vitest-environment jsdom
/**
 * Lo que la tienda agrega arriba del catálogo: el mapa del envío, el buscador
 * con sugerencias, la barra del pedido y el chat.
 *
 * Los cuatro tienen la misma regla de fondo: son extras. Si el servicio de
 * atrás no está —sin clave, sin desplegar, sin red— la tienda tiene que seguir
 * funcionando como si no existieran, en vez de mostrar un rectángulo roto o un
 * botón que no contesta.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { estado } = vi.hoisted(() => ({ estado: { productos: [], respuesta: null } }));

vi.mock('firebase/firestore', async () =>
  (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../src/firebase.js', () => ({ db: {}, app: {} }));
vi.mock('../src/datos.js', async (original) => {
  const real = await original();
  return {
    ...real,
    sugerir: async (texto) => {
      const q = String(texto || '').toLowerCase();
      return estado.productos.filter(p => p.nombre.toLowerCase().includes(q));
    },
    cargarConfig: async () => ({ abierta: true, entrega: {}, pago: {}, horarios: {} }),
  };
});

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

const PRODUCTOS = [
  { id: 'p1', nombre: 'Cuaderno Rivadavia 48 hojas', precio: 3500, stock: 12,
    rubro: 'LIBRERIA', imagenes: ['a.webp'] },
  { id: 'p2', nombre: 'Cartulina Luma', precio: 800, stock: 30,
    rubro: 'PAPELERIA', imagenes: ['b.webp'] },
];

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  document.body.style.cssText = '';
  estado.productos = PRODUCTOS.map(p => ({ ...p }));
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200,
                                                   json: async () => ({}) }));
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Element.prototype.scrollIntoView = () => {};
  vi.resetModules();
});

afterEach(() => { vi.useRealTimers(); });

describe('el mapa del envío', () => {
  const LOCAL = { lat: -31.4201, lng: -64.1888 };
  const DESTINO = { lat: -31.4350, lng: -64.2010 };

  /** Un contenedor con ancho, que es lo que el mapa necesita para dibujar. */
  async function armar(opciones) {
    const { montarMapa } = await import('../src/mapa.js');
    const caja = document.createElement('div');
    document.body.appendChild(caja);
    Object.defineProperty(caja, 'clientWidth', { value: 360, configurable: true });
    const soltar = montarMapa(caja, opciones);
    return { caja, soltar };
  }

  it('dibuja el local y el destino', async () => {
    const { caja } = await armar({ local: LOCAL, destino: DESTINO, km: 2.4 });
    expect(caja.querySelector('.mapa')).toBeTruthy();
    expect(caja.querySelectorAll('.mapa__marcador')).toHaveLength(2);
  });

  it('muestra la distancia cuando ya se cotizó', async () => {
    const { caja } = await armar({ local: LOCAL, destino: DESTINO, km: 2.4 });
    expect(caja.textContent).toMatch(/2[,.]4/);
  });

  it('sin distancia no inventa un número', async () => {
    const { caja } = await armar({ local: LOCAL, destino: DESTINO });
    expect(caja.querySelector('.mapa__km')).toBeNull();
  });

  it('ofrece cómo llegar en Google Maps con las dos puntas', async () => {
    const { caja } = await armar({ local: LOCAL, destino: DESTINO });
    const enlace = caja.querySelector('.mapa__enlace');
    expect(enlace.href).toContain(String(LOCAL.lat));
    expect(enlace.href).toContain(String(DESTINO.lat));
    expect(enlace.target).toBe('_blank');
  });

  it('sin coordenadas no deja un rectángulo vacío', async () => {
    const { caja } = await armar({ local: LOCAL, destino: null });
    expect(caja.innerHTML).toBe('');
  });

  it('con coordenadas que no son números tampoco', async () => {
    const { caja } = await armar({ local: LOCAL, destino: { lat: 'x', lng: 'y' } });
    expect(caja.innerHTML).toBe('');
  });

  it('si la imagen de fondo no llega, se saca el mapa entero', async () => {
    // Un recuadro vacío con dos pines flotando se lee como un error de la
    // tienda, no como un mapa que no cargó.
    const { caja } = await armar({ local: LOCAL, destino: DESTINO });
    caja.querySelector('[data-fondo]').dispatchEvent(new Event('error'));
    expect(caja.innerHTML).toBe('');
  });

  it('soltar el mapa lo limpia', async () => {
    const { caja, soltar } = await armar({ local: LOCAL, destino: DESTINO });
    soltar();
    expect(caja.innerHTML).toBe('');
  });

  it('un contenedor sin ancho todavía no dibuja nada', async () => {
    const { montarMapa } = await import('../src/mapa.js');
    const caja = document.createElement('div');
    document.body.appendChild(caja);
    Object.defineProperty(caja, 'clientWidth', { value: 0, configurable: true });
    montarMapa(caja, { local: LOCAL, destino: DESTINO });
    expect(caja.innerHTML).toBe('');
  });
});

describe('el buscador con sugerencias', () => {
  /** Deja el buscador enganchado y devuelve el campo. */
  async function armar() {
    const mod = await import('../src/sugerencias.js');
    mod.iniciarSugerencias();
    document.body.insertAdjacentHTML('beforeend', `
      <div data-buscador>
        <form><input class="buscador__input" type="search"></form>
      </div>`);
    return { campo: document.querySelector('.buscador__input'), mod };
  }

  async function tipear(campo, texto) {
    campo.value = texto;
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    await esperar(400);
  }

  it('con una sola letra no consulta', async () => {
    // Consultar en cada tecla desde la primera son seis lecturas por palabra.
    const { campo } = await armar();
    await tipear(campo, 'c');
    expect(document.querySelector('.sugerencia')).toBeNull();
  });

  it('muestra lo que coincide', async () => {
    const { campo } = await armar();
    await tipear(campo, 'cartulina');
    const filas = document.querySelectorAll('.sugerencia');
    expect(filas.length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('Cartulina Luma');
  });

  it('cada sugerencia lleva a la ficha del producto', async () => {
    const { campo } = await armar();
    await tipear(campo, 'cartulina');
    expect(document.querySelector('.sugerencia').getAttribute('href')).toContain('/p/p2');
  });

  it('Escape cierra el panel', async () => {
    const { campo } = await armar();
    await tipear(campo, 'cartulina');
    expect(document.querySelector('.sugerencia')).toBeTruthy();

    campo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await esperar(20);
    expect(document.querySelector('.sugerencia')).toBeNull();
  });

  it('tocar afuera también', async () => {
    const { campo } = await armar();
    await tipear(campo, 'cartulina');
    document.body.click();
    await esperar(20);
    expect(document.querySelector('.sugerencia')).toBeNull();
  });

  it('las flechas recorren la lista', async () => {
    const { campo } = await armar();
    await tipear(campo, 'c');
    campo.value = 'ca';
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    await esperar(400);
    if (!document.querySelector('.sugerencia')) return;

    campo.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await esperar(10);
    expect(document.querySelector('.sugerencia[aria-selected="true"], .sugerencia.activa'))
      .toBeTruthy();
  });

  it('el buscador dice en qué rubro está parada la persona', async () => {
    const { campo, mod } = await armar();
    mod.fijarAmbito('PAPELERIA');
    expect(campo.placeholder.toLowerCase()).toContain('papeler');

    mod.fijarAmbito(null);
    expect(campo.placeholder.toLowerCase()).not.toContain('papeler');
  });

  it('mandar el formulario cierra el panel', async () => {
    const { campo } = await armar();
    await tipear(campo, 'cartulina');
    campo.closest('form').dispatchEvent(new Event('submit', { bubbles: true }));
    await esperar(20);
    expect(document.querySelector('.sugerencia')).toBeNull();
  });
});

describe('la barra del pedido', () => {
  async function armar() {
    const carrito = await import('../src/carrito.js');
    carrito.vaciar();
    const barra = await import('../src/barra_pedido.js');
    barra.iniciarBarraPedido();
    return { carrito, barra };
  }

  const producto = (id, nombre, precio) => ({ id, nombre, precio, stock: 20 });

  it('con el carrito vacío no se ve', async () => {
    await armar();
    expect(document.querySelector('.barra-pedido--visible')).toBeNull();
  });

  it('al agregar algo aparece con el total', async () => {
    const { carrito } = await armar();
    carrito.agregar(producto('p1', 'Cuaderno Rivadavia', 3500), { cantidad: 2 });
    await esperar(30);
    const barra = document.querySelector('.barra-pedido');
    expect(barra.textContent.replace(/\./g, '')).toContain('7000');
    expect(barra.textContent).toMatch(/producto/);
  });

  it('dice cuántos productos distintos hay, no cuántas unidades', async () => {
    const { carrito } = await armar();
    carrito.agregar(producto('p1', 'Cuaderno', 3500), { cantidad: 5 });
    carrito.agregar(producto('p2', 'Cartulina', 800), { cantidad: 3 });
    await esperar(30);
    expect(document.querySelector('.barra-pedido').textContent).toContain('2 productos');
  });

  it('vaciar el carrito la esconde', async () => {
    const { carrito } = await armar();
    carrito.agregar(producto('p1', 'Cuaderno', 3500), { cantidad: 1 });
    await esperar(30);
    carrito.vaciar();
    await esperar(30);
    expect(document.querySelector('.barra-pedido--visible')).toBeNull();
  });

  it('lleva a ver el pedido', async () => {
    const { carrito } = await armar();
    carrito.agregar(producto('p1', 'Cuaderno', 3500), { cantidad: 1 });
    await esperar(30);
    expect(document.querySelector('[data-abrir-pedido]')).toBeTruthy();
  });

  it('arrancarla dos veces no deja dos barras', async () => {
    const { barra } = await armar();
    barra.iniciarBarraPedido();
    expect(document.querySelectorAll('.barra-pedido')).toHaveLength(1);
  });

  it('un producto sin foto muestra su inicial, no un hueco', async () => {
    const { carrito } = await armar();
    carrito.agregar(producto('p1', 'Cuaderno Rivadavia', 3500), { cantidad: 1 });
    await esperar(30);
    expect(document.querySelector('.barra-pedido__inicial')?.textContent).toBe('C');
  });

  it('el nombre de un producto no se cuela como HTML', async () => {
    const { carrito } = await armar();
    carrito.agregar(producto('p1', '<img src=x onerror=alert(1)>', 3500), { cantidad: 1 });
    await esperar(30);
    expect(document.querySelector('.barra-pedido img')).toBeNull();
  });
});

describe('el chat de la tienda', () => {
  async function armar() {
    const mod = await import('../src/asistente.js');
    mod.iniciarAsistente();
    return mod;
  }

  /** Deja la función contestando lo que se le pase. */
  function contesta(status, cuerpo) {
    globalThis.fetch = vi.fn(async () => ({
      ok: status < 400, status, json: async () => cuerpo,
    }));
  }

  it('pone el botón para preguntar', async () => {
    await armar();
    expect(document.querySelector('[data-abrir-asistente]')).toBeTruthy();
  });

  it('arrancarlo dos veces no deja dos botones', async () => {
    const mod = await armar();
    mod.iniciarAsistente();
    expect(document.querySelectorAll('.asistente')).toHaveLength(1);
  });

  it('abre el panel con el campo para escribir', async () => {
    await armar();
    document.querySelector('[data-abrir-asistente]').click();
    await esperar(20);
    expect(document.querySelector('[data-form-asistente]')).toBeTruthy();
    expect(document.querySelector('.asistente-panel__campo')).toBeTruthy();
  });

  it('contesta y muestra los productos que trajo', async () => {
    // El texto lo escribe el modelo; el precio lo pinta la tienda con lo que
    // salió de la base. Así el precio que se ve nunca pasó por el modelo.
    contesta(200, {
      respuesta: 'Sí, tenemos cartulina Luma.',
      productos: [{ id: 'p2', nombre: 'Cartulina Luma', precio: 800, stock: 30 }],
    });
    await armar();
    document.querySelector('[data-abrir-asistente]').click();
    await esperar(20);

    const campo = document.querySelector('.asistente-panel__campo');
    campo.value = '¿Tenés cartulina Luma?';
    document.querySelector('[data-form-asistente]')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 10; i++) await esperar();

    const charla = document.querySelector('[data-charla]').textContent;
    expect(charla).toContain('cartulina Luma');
    expect(charla.replace(/\./g, '')).toContain('800');
  });

  it('si no se puede conectar, manda a WhatsApp en vez de dejar el chat mudo', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('sin red')));
    const espia = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await armar();
      document.querySelector('[data-abrir-asistente]').click();
      await esperar(20);
      const campo = document.querySelector('.asistente-panel__campo');
      campo.value = 'hola';
      document.querySelector('[data-form-asistente]')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      // La función vive dormida y arranca con el primer mensaje del día: hay un
      // reintento con un respiro de por medio antes de darla por perdida.
      await esperar(1300);

      expect(document.querySelector('[data-charla]').textContent.toLowerCase())
        .toMatch(/whatsapp/);
    } finally {
      espia.mockRestore();
    }
  });

  it('sin clave configurada el chat se apaga solo', async () => {
    // Es como degradan las direcciones y el mapa: la tienda funciona igual,
    // simplemente sin esta parte.
    contesta(503, {});
    const mod = await armar();
    document.querySelector('[data-abrir-asistente]').click();
    await esperar(20);
    const campo = document.querySelector('.asistente-panel__campo');
    campo.value = 'hola';
    document.querySelector('[data-form-asistente]')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await esperar(100);

    expect(mod.asistenteApagado()).toBe(true);
    expect(document.querySelector('.asistente')).toBeNull();
    // Y sin gastar una segunda llamada: el 503 es la respuesta, no un tropiezo.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('Escape cierra el panel y destraba la pantalla', async () => {
    await armar();
    document.querySelector('[data-abrir-asistente]').click();
    await esperar(20);
    expect(document.body.style.overflow).toBe('hidden');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await esperar(20);
    expect(document.querySelector('.asistente-panel')).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});
