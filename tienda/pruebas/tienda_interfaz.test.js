// @vitest-environment jsdom
/**
 * Las piezas de la tienda que el cliente usa sin darse cuenta: los avisos, la
 * cinta para elegir cuántos metros lleva, la barra del pedido, el panel del
 * carrito, los íconos y lo que Google ve de cada pantalla.
 *
 * Son chicas y son las que se rompen en silencio. Un aviso que no aparece deja
 * al cliente sin saber si agregó algo; un `noindex` mal puesto saca la tienda
 * entera de Google, o la mete con la dirección de prueba compitiendo contra la
 * de verdad.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('firebase/firestore', async () =>
  (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../src/firebase.js', () => ({ db: {}, app: {} }));

const seo = await import('../src/seo.js');
const iconos = await import('../src/iconos.js');
const { montarCinta } = await import('../src/cinta.js');
const carrito = await import('../src/carrito.js');
const panel = await import('../src/panel_carrito.js');

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  document.title = '';
  carrito.vaciar();
});

afterEach(() => { vi.useRealTimers(); });

describe('lo que Google ve', () => {
  const enHost = (host) => {
    Object.defineProperty(window, 'location', {
      value: new URL(`https://${host}/catalogo?q=cuaderno`), configurable: true,
    });
  };

  it('la dirección de prueba no se indexa', () => {
    // Aparecer en Google con "beta" en la dirección, compitiendo contra la
    // tienda de verdad, es peor que no aparecer.
    expect(seo.esHostDePrueba('beta.liceolibreria.com')).toBe(true);
    expect(seo.esHostDePrueba('liceo-tienda.netlify.app')).toBe(true);
    expect(seo.esHostDePrueba('localhost')).toBe(true);
    expect(seo.esHostDePrueba('127.0.0.1')).toBe(true);
  });

  it('la de verdad sí', () => {
    expect(seo.esHostDePrueba('liceolibreria.com')).toBe(false);
    expect(seo.esHostDePrueba('www.liceolibreria.com')).toBe(false);
  });

  it('la dirección canónica no lleva lo que se buscó', () => {
    // Sin esto, cada búsqueda es una página distinta para Google y el catálogo
    // aparece partido en cien direcciones que dicen casi lo mismo.
    enHost('liceolibreria.com');
    seo.fijarPantalla();
    const canonica = document.head.querySelector('link[rel="canonical"]').href;
    expect(canonica).toBe('https://liceolibreria.com/catalogo');
    expect(canonica).not.toContain('?');
  });

  it('en la tienda de verdad no pone noindex', () => {
    enHost('liceolibreria.com');
    seo.fijarPantalla();
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });

  it('en beta sí', () => {
    enHost('beta.liceolibreria.com');
    seo.fijarPantalla();
    expect(document.head.querySelector('meta[name="robots"]').content)
      .toContain('noindex');
  });

  it('las pantallas de una sola persona nunca se indexan, ni en la de verdad', () => {
    // Checkout, el pedido y la cuenta: no tienen nada que buscar y muestran
    // datos de alguien.
    enHost('liceolibreria.com');
    seo.fijarPantalla({ privada: true });
    expect(document.head.querySelector('meta[name="robots"]').content)
      .toContain('noindex');
  });

  it('el título también viaja a lo que se comparte por WhatsApp', () => {
    enHost('liceolibreria.com');
    seo.fijarPantalla();
    seo.fijarTitulo('Cuaderno Rivadavia · Librería Liceo');
    expect(document.title).toBe('Cuaderno Rivadavia · Librería Liceo');
    expect(document.head.querySelector('meta[property="og:title"]').content)
      .toBe('Cuaderno Rivadavia · Librería Liceo');
  });

  it('la ficha de un producto publica precio y stock, y nada del costo', () => {
    enHost('liceolibreria.com');
    seo.fijarPantalla();
    seo.fijarProducto({
      id: 'p1', nombre: 'Cuaderno Rivadavia', marca: 'RIVADAVIA', rubro: 'LIBRERIA',
      precio: 3500, costo: 2100, proveedor: 'DISTRI SUR', stock: 12,
      imagenes: ['https://x/a.webp'],
    });
    const todo = document.head.innerHTML;
    expect(todo).toContain('3500');
    expect(todo).not.toContain('2100');
    expect(todo).not.toContain('DISTRI SUR');
  });

  it('cambiar de ficha no deja los datos de la anterior', () => {
    enHost('liceolibreria.com');
    seo.fijarProducto({ id: 'p1', nombre: 'Cuaderno Rivadavia', precio: 3500, stock: 5 });
    seo.fijarProducto({ id: 'p2', nombre: 'Resma Pampa', precio: 18000, stock: 3 });
    expect(document.head.innerHTML).not.toContain('Cuaderno Rivadavia');
    expect(document.head.innerHTML).toContain('Resma Pampa');
  });

  it('un producto sin stock lo dice, no lo esconde', () => {
    enHost('liceolibreria.com');
    seo.fijarProducto({ id: 'p3', nombre: 'Resma Pampa', precio: 18000, stock: 0 });
    expect(document.head.innerHTML.toLowerCase()).toMatch(/sin stock/);
  });
});

describe('los avisos', () => {
  // La zona de avisos se crea una sola vez y queda colgada del `body`: se pide
  // el módulo de nuevo en cada caso para que arranque limpia.
  let avisar;
  beforeEach(async () => {
    vi.resetModules();
    ({ avisar } = await import('../src/avisos.js'));
  });

  it('aparecen con el texto que se les pasa', () => {
    avisar('Agregado al pedido');
    expect(document.body.textContent).toContain('Agregado al pedido');
  });

  it('el de error se ve distinto del de confirmación', () => {
    avisar('Se agregó', { tipo: 'exito' });
    avisar('Faltan datos', { tipo: 'error' });
    expect(document.querySelector('.toast--exito')).toBeTruthy();
    expect(document.querySelector('.toast--error')).toBeTruthy();
  });

  it('se van solos', async () => {
    vi.useFakeTimers();
    avisar('Listo', { duracion: 1000 });
    expect(document.body.textContent).toContain('Listo');
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    // La animación de salida es la que lo saca de la pantalla.
    document.querySelector('.toast--saliendo')?.dispatchEvent(new Event('animationend'));
    expect(document.body.textContent).not.toContain('Listo');
  });

  it('no se apilan más de tres', () => {
    // Con la pantalla tapada de avisos no se ve la tienda.
    for (let i = 0; i < 8; i++) avisar(`Aviso ${i}`);
    expect(document.querySelectorAll('.toast').length).toBeLessThanOrEqual(3);
  });

  it('el de "deshacer" se puede apretar', () => {
    let deshecho = false;
    avisar('Sacaste el cuaderno', {
      accion: { texto: 'Deshacer', alHacer: () => { deshecho = true; } },
    });
    const btn = [...document.querySelectorAll('.toast button')]
      .find(b => /deshacer/i.test(b.textContent));
    expect(btn, 'tiene que ofrecer deshacer').toBeTruthy();
    btn.click();
    expect(deshecho).toBe(true);
  });

  it('el texto de un producto no se cuela como HTML', () => {
    avisar('<img src=x onerror=alert(1)> agregado');
    expect(document.querySelector('.toast img')).toBeNull();
    expect(document.querySelector('.toast').innerHTML).toContain('&lt;img');
  });

  it('se anuncia sin robar el foco', () => {
    // Quien navega con teclado perdería el lugar en el formulario cada vez que
    // agrega algo al pedido.
    const campo = document.createElement('input');
    document.body.appendChild(campo);
    campo.focus();
    avisar('Agregado');
    expect(document.activeElement).toBe(campo);
    expect(document.querySelector('.toast-zona').getAttribute('aria-live')).toBe('polite');
  });
});

describe('los íconos', () => {
  it('cada uno devuelve un dibujo, no un hueco', () => {
    for (const nombre of ['tilde', 'pin', 'hoja', 'atencion', 'carrito', 'buscar']) {
      const html = iconos.icono(nombre);
      expect(typeof html, nombre).toBe('string');
      expect(html.length, nombre).toBeGreaterThan(0);
      expect(html, nombre).toContain('<svg');
    }
  });

  it('uno que no existe no rompe la pantalla', () => {
    expect(() => iconos.icono('no-existe')).not.toThrow();
    expect(typeof iconos.icono('no-existe')).toBe('string');
  });

  it('el tamaño que se pide es el que sale', () => {
    expect(iconos.icono('tilde', { tam: 16 })).toContain('16');
  });

  it('cada rubro tiene su ícono y ninguno queda sin uno', () => {
    for (const rubro of ['LIBRERIA', 'PAPELERIA', 'BAZAR', 'JUGUETERIA', 'RUBRO INVENTADO']) {
      const html = iconos.iconoDeRubro(rubro);
      expect(typeof html, rubro).toBe('string');
      expect(html.length, rubro).toBeGreaterThan(0);
    }
  });
});

describe('la cinta para elegir cuánto se lleva', () => {
  /** Arma la cinta en un contenedor limpio. */
  function armar(opciones) {
    const caja = document.createElement('div');
    document.body.appendChild(caja);
    const api = montarCinta(caja, opciones);
    return { caja, api };
  }

  it('arranca en el valor que se le pide', () => {
    const { caja } = armar({ max: 10, valor: 2.5, paso: 0.5, minimo: 0.5,
                             alCambiar: () => {} });
    expect(caja.querySelector('[data-valor]').value).toMatch(/2[,.]5/);
    expect(caja.querySelector('.cinta').getAttribute('aria-valuenow')).toBe('2.5');
  });

  it('no deja pasarse del stock', () => {
    // Elegir 12 metros de una cinta que tiene 10 arma un pedido que no se puede
    // cumplir.
    const { caja } = armar({ max: 10, valor: 99, paso: 0.5, minimo: 0.5,
                             alCambiar: () => {} });
    const cinta = caja.querySelector('.cinta');
    expect(Number(cinta.getAttribute('aria-valuemax'))).toBeLessThanOrEqual(10);
    expect(Number(cinta.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(10);
  });

  it('respeta el mínimo de venta', () => {
    const { caja } = armar({ max: 10, valor: 0.5, paso: 0.5, minimo: 3,
                             alCambiar: () => {} });
    const cinta = caja.querySelector('.cinta');
    expect(Number(cinta.getAttribute('aria-valuemin'))).toBe(3);
    expect(Number(cinta.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(3);
  });

  it('el mínimo se avisa antes, no cuando el botón deja de responder', () => {
    const { caja } = armar({ max: 10, valor: 3, paso: 0.5, minimo: 3,
                             alCambiar: () => {} });
    expect(caja.querySelector('.cinta-ayuda').textContent).toMatch(/3[,.]0 m/);
  });

  it('los botones de más y de menos mueven de a un paso', () => {
    const cambios = [];
    const { caja } = armar({ max: 10, valor: 2, paso: 0.5, minimo: 0.5,
                             alCambiar: v => cambios.push(v) });
    caja.querySelector('[data-mas]').click();
    caja.querySelector('[data-mas]').click();
    caja.querySelector('[data-menos]').click();
    expect(cambios.at(-1)).toBeCloseTo(2.5);
  });

  it('el de menos no baja del mínimo', () => {
    const cambios = [];
    const { caja } = armar({ max: 10, valor: 1, paso: 0.5, minimo: 1,
                             alCambiar: v => cambios.push(v) });
    caja.querySelector('[data-menos]').click();
    caja.querySelector('[data-menos]').click();
    expect(cambios.at(-1) ?? 1).toBeGreaterThanOrEqual(1);
  });
});

describe('el panel del carrito', () => {
  it('arranca cerrado', () => {
    expect(panel.estaAbierto()).toBe(false);
  });

  it('se abre y se cierra', async () => {
    carrito.agregar({ id: 'p1', nombre: 'Cuaderno', precio: 3500, stock: 10 },
                    { cantidad: 2 });
    panel.abrir();
    await esperar(10);
    expect(panel.estaAbierto()).toBe(true);

    panel.cerrar();
    await esperar(10);
    expect(panel.estaAbierto()).toBe(false);
  });

  it('abrirlo dos veces no deja dos paneles', async () => {
    carrito.agregar({ id: 'p1', nombre: 'Cuaderno', precio: 3500, stock: 10 },
                    { cantidad: 2 });
    panel.abrir();
    panel.abrir();
    await esperar(10);
    expect(document.querySelectorAll('aside.panel').length).toBe(1);
    expect(document.querySelectorAll('.velo').length).toBe(1);
    panel.cerrar();
  });

  it('mientras está abierto la tienda de atrás no se mueve', async () => {
    // En el celular, que la pantalla de atrás siga desplazándose se siente como
    // si la app estuviera rota.
    carrito.agregar({ id: 'p1', nombre: 'Cuaderno', precio: 3500, stock: 10 },
                    { cantidad: 2 });
    panel.abrir();
    await esperar(10);
    expect(document.body.style.overflow).toBe('hidden');

    // Se destraba cuando el panel termina de salir. Con las animaciones
    // apagadas —como en la máquina del local— el `animationend` no llega nunca
    // y lo destraba la red de seguridad de 400 ms.
    panel.cerrar();
    await esperar(500);
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('Escape lo cierra', async () => {
    carrito.agregar({ id: 'p1', nombre: 'Cuaderno', precio: 3500, stock: 10 },
                    { cantidad: 2 });
    panel.abrir();
    await esperar(10);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await esperar(10);
    expect(panel.estaAbierto()).toBe(false);
  });

  it('tocar afuera lo cierra', async () => {
    carrito.agregar({ id: 'p1', nombre: 'Cuaderno', precio: 3500, stock: 10 },
                    { cantidad: 2 });
    panel.abrir();
    await esperar(10);
    document.querySelector('.velo').click();
    await esperar(10);
    expect(panel.estaAbierto()).toBe(false);
  });

  it('muestra lo que hay en el carrito', async () => {
    carrito.agregar({ id: 'p1', nombre: 'Cuaderno Rivadavia', precio: 3500, stock: 10 },
                    { cantidad: 2 });
    panel.abrir();
    await esperar(10);
    const texto = document.querySelector('aside.panel').textContent;
    expect(texto).toContain('Cuaderno Rivadavia');
    expect(texto.replace(/\./g, '')).toContain('7000');
    panel.cerrar();
  });
});

describe('los datos del local para Google', () => {
  const CFG = {
    nombre: 'Libreria Liceo',
    direccion: 'Av. Alfonsina Storni 168, X5019 Cordoba',
    telefono: '3517046684',
    email: 'libreria.liceo@hotmail.com',
    instagram: 'https://www.instagram.com/libreria.liceo/',
    origen: { lat: -31.3540169, lng: -64.1734488 },
    horarios: [
      [{ desde: '09:00', hasta: '13:00' }, { desde: '17:00', hasta: '20:30' }],
      [], [], [], [],
      [{ desde: '09:00', hasta: '13:00' }],
      [],
    ],
  };

  const leer = () => JSON.parse(
    document.head.querySelector('script[data-seo-negocio]').textContent);

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: new URL('https://liceolibreria.com/'), configurable: true,
    });
  });

  // Es lo que hace la diferencia entre aparecer en una lista de resultados y
  // aparecer en el panel de la derecha con el mapa al lado. Para una libreria de
  // barrio, "libreria cerca mio" es la busqueda que mas vende.
  it('publica direccion, telefono y coordenadas', () => {
    seo.fijarNegocio(CFG);
    const d = leer();
    expect(d['@type']).toBe('Store');
    expect(d.address.streetAddress).toBe('Av. Alfonsina Storni 168');
    expect(d.address.postalCode).toBe('X5019');
    expect(d.address.addressLocality).toBe('Cordoba');
    expect(d.telephone).toBe('+543517046684');
    expect(d.geo.latitude).toBe(-31.3540169);
  });

  it('el horario va estructurado, no como el texto del cartel', () => {
    seo.fijarNegocio(CFG);
    const horas = leer().openingHoursSpecification;
    expect(horas).toHaveLength(3);
    expect(horas[0]).toMatchObject({
      dayOfWeek: 'https://schema.org/Monday', opens: '09:00', closes: '13:00',
    });
    expect(horas.at(-1).dayOfWeek).toBe('https://schema.org/Saturday');
  });

  it('una direccion sin coma no se inventa un codigo postal', () => {
    expect(seo.partirDireccion('Alfonsina Storni 168')).toEqual({
      streetAddress: 'Alfonsina Storni 168', addressLocality: 'Córdoba',
    });
  });

  it('sin horario cargado el bloque sale igual, sin la clave vacia', () => {
    seo.fijarNegocio({ ...CFG, horarios: null });
    expect(leer().openingHoursSpecification).toBeUndefined();
  });

  // Los datos del local son de la portada. En una ficha el que manda es el
  // Product; declarar tambien el negocio en cada una es ruido.
  it('al cambiar de pantalla se va', () => {
    seo.fijarNegocio(CFG);
    seo.fijarPantalla();
    expect(document.head.querySelector('script[data-seo-negocio]')).toBeNull();
  });
});
