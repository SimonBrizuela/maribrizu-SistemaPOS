// @vitest-environment jsdom
/**
 * La medición del lado del navegador: cuándo cuenta una visita, cómo junta
 * los eventos en tandas y por qué caminos los manda. Y, sobre todo, cuándo NO
 * mide: sin prenderla, con Do Not Track, o apagada a propósito en el aparato.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('firebase/firestore', async () =>
  (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../src/firebase.js', () => ({ db: {}, app: {} }));

let medicion;
let carrito;

const PRODUCTO = { id: '1035115', nombre: 'Goma Borrar Keyroad', precio: 900, stock: 10,
                   rubro: 'LIBRERIA', unidad: 'unidad', variedades: [] };

/** Lo que salió por fetch, tanda por tanda. */
function tandas() {
  return globalThis.fetch.mock.calls
    .filter(([url]) => String(url).includes('/medir'))
    .map(([, opciones]) => JSON.parse(opciones.body));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T15:00:00Z'));
  localStorage.clear();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 204 }));
  Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
  Object.defineProperty(navigator, 'globalPrivacyControl', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  vi.resetModules();
  medicion = await import('../src/medicion.js');
  carrito = await import('../src/carrito.js');
  carrito.vaciar();
});

afterEach(() => {
  medicion.reiniciarMedicion();
  vi.useRealTimers();
});

describe('sin prender', () => {
  it('no anota nada ni toca la red', () => {
    medicion.medir('ficha', { id: '1' });
    medicion.medirPantalla('/', {});
    vi.advanceTimersByTime(10_000);
    expect(medicion.pendientes()).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('la visita', () => {
  it('la primera pantalla abre una visita nueva, con el aparato y de dónde vino', () => {
    Object.defineProperty(document, 'referrer', { value: 'https://l.instagram.com/', configurable: true });
    expect(medicion.iniciarMedicion()).toBe(true);
    medicion.medirPantalla('/', {});

    const cola = medicion.pendientes();
    expect(cola.map(e => e.tipo)).toEqual(['visita', 'pagina']);
    expect(cola[0]).toMatchObject({ nueva: true, dispositivo: 'escritorio', origen: 'instagram' });
    expect(cola[1]).toMatchObject({ pantalla: 'inicio' });
  });

  it('la segunda pantalla de la misma visita no vuelve a contarla', () => {
    medicion.iniciarMedicion();
    medicion.medirPantalla('/', {});
    medicion.medirPantalla('/catalogo/LIBRERIA', { rubro: 'LIBRERIA' });
    const tipos = medicion.pendientes().map(e => e.tipo);
    expect(tipos).toEqual(['visita', 'pagina', 'pagina']);
    expect(medicion.pendientes()[2]).toMatchObject({ pantalla: 'catalogo', rubro: 'LIBRERIA' });
  });

  it('después de media hora sin tocar nada es otra visita, ya no nueva', () => {
    medicion.iniciarMedicion();
    medicion.medirPantalla('/', {});
    vi.advanceTimersByTime(5000);            // se manda la primera tanda
    vi.advanceTimersByTime(31 * 60 * 1000);
    medicion.medirPantalla('/catalogo', {});
    const cola = medicion.pendientes();
    expect(cola[0]).toMatchObject({ tipo: 'visita', nueva: false });
  });

  it('en el celular dice movil', () => {
    window.matchMedia = () => ({ matches: true });
    expect(medicion.dispositivoActual()).toBe('movil');
  });

  it('la pantalla desconocida no cuenta', () => {
    medicion.iniciarMedicion();
    medicion.medirPantalla('/lo-que-sea', {});
    expect(medicion.pendientes()).toEqual([]);
  });
});

describe('las búsquedas', () => {
  it('la misma palabra dos veces en un minuto es una sola', () => {
    medicion.iniciarMedicion();
    medicion.medir('busqueda', { texto: 'Cuaderno', resultados: 0 });
    medicion.medir('busqueda', { texto: 'cuaderno ', resultados: 8 });
    expect(medicion.pendientes().filter(e => e.tipo === 'busqueda')).toHaveLength(1);
    // Al minuto vuelve a contar. Mientras tanto la primera tanda ya salió.
    vi.advanceTimersByTime(61 * 1000);
    medicion.medir('busqueda', { texto: 'cuaderno', resultados: 8 });
    const mandadas = tandas().flatMap(t => t.eventos).filter(e => e.tipo === 'busqueda');
    const enCola = medicion.pendientes().filter(e => e.tipo === 'busqueda');
    expect(mandadas.length + enCola.length).toBe(2);
  });

  it('un teléfono escrito en el buscador no sale del navegador', () => {
    medicion.iniciarMedicion();
    medicion.medir('busqueda', { texto: '3515550001', resultados: 0 });
    expect(medicion.pendientes().filter(e => e.tipo === 'busqueda')).toHaveLength(0);
  });
});

describe('el carrito', () => {
  it('cada alta cuenta con el producto', () => {
    medicion.iniciarMedicion();
    carrito.agregar(PRODUCTO);
    carrito.agregar(PRODUCTO);
    const altas = medicion.pendientes().filter(e => e.tipo === 'carrito');
    expect(altas).toHaveLength(2);
    expect(altas[0]).toMatchObject({ id: '1035115', nombre: 'Goma Borrar Keyroad', rubro: 'LIBRERIA' });
  });

  it('el oyente que falla no frena la compra', () => {
    const silencio = vi.spyOn(console, 'warn').mockImplementation(() => {});
    carrito.alAgregar(() => { throw new Error('se rompió'); });
    expect(carrito.agregar(PRODUCTO)).toBe(1);
    expect(carrito.unidades()).toBe(1);
    silencio.mockRestore();
  });
});

describe('el envío', () => {
  it('junta los eventos unos segundos y los manda en una tanda', async () => {
    medicion.iniciarMedicion();
    medicion.medirPantalla('/', {});
    const cuando = Date.now();
    medicion.medir('ficha', { id: '1035115', nombre: 'Goma' });
    expect(globalThis.fetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4100);
    const [tanda] = tandas();
    expect(tanda.v).toBe(1);
    expect(tanda.eventos.map(e => e.tipo)).toEqual(['visita', 'pagina', 'ficha']);
    // Cada evento lleva el momento en que pasó, no el del envío.
    expect(tanda.eventos[2].t).toBe(cuando);
    const [, opciones] = globalThis.fetch.mock.calls[0];
    expect(opciones).toMatchObject({ method: 'POST', keepalive: true });
    expect(medicion.pendientes()).toEqual([]);
  });

  it('con cuarenta eventos sale sin esperar', () => {
    medicion.iniciarMedicion();
    for (let i = 0; i < 39; i++) medicion.medir('chat');
    expect(tandas()).toHaveLength(1);
    expect(tandas()[0].eventos).toHaveLength(40);   // la visita más 39
  });

  it('al esconder la pestaña va por sendBeacon', () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    medicion.iniciarMedicion();
    medicion.medir('chat');

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0][0]).toBe('/.netlify/functions/medir');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(medicion.pendientes()).toEqual([]);
  });

  it('si sendBeacon no lo toma, cae a fetch', () => {
    Object.defineProperty(navigator, 'sendBeacon', { value: () => false, configurable: true });
    medicion.iniciarMedicion();
    medicion.medir('chat');
    window.dispatchEvent(new Event('pagehide'));
    expect(tandas()).toHaveLength(1);
  });

  it('una red caída no tira nada', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('sin red')));
    medicion.iniciarMedicion();
    medicion.medir('chat');
    vi.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(medicion.pendientes()).toEqual([]);
  });
});

describe('quien no quiere ser contado', () => {
  it('con Do Not Track no se mide', () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    expect(medicion.iniciarMedicion()).toBe(false);
    medicion.medirPantalla('/', {});
    expect(medicion.pendientes()).toEqual([]);
  });

  it('con Global Privacy Control tampoco', () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    expect(medicion.iniciarMedicion()).toBe(false);
  });

  it('?medir=0 apaga el aparato y saca el parámetro de la barra', () => {
    window.history.replaceState({}, '', '/catalogo?medir=0&q=hilo');
    expect(medicion.iniciarMedicion()).toBe(false);
    expect(window.location.search).toBe('?q=hilo');
    expect(localStorage.getItem('ll-medir-apagado')).toBe('1');
  });

  it('el aparato apagado sigue apagado en la visita siguiente, y ?medir=1 lo vuelve', async () => {
    localStorage.setItem('ll-medir-apagado', '1');
    expect(medicion.iniciarMedicion()).toBe(false);
    medicion.reiniciarMedicion();
    window.history.replaceState({}, '', '/?medir=1');
    expect(medicion.iniciarMedicion()).toBe(true);
    expect(localStorage.getItem('ll-medir-apagado')).toBeNull();
  });
});

describe('lo que queda en el navegador', () => {
  it('es solo la marca de actividad: ningún identificador', () => {
    medicion.iniciarMedicion();
    medicion.medirPantalla('/', {});
    const guardado = JSON.parse(localStorage.getItem('liceo.medicion.v1'));
    expect(Object.keys(guardado).sort()).toEqual(['ultima', 'visto']);
  });

  it('y ningún evento lleva teléfono, cuenta ni texto del chat', () => {
    medicion.iniciarMedicion();
    medicion.medirPantalla('/', {});
    medicion.medir('chat');
    medicion.medir('checkout');
    for (const ev of medicion.pendientes()) {
      expect(Object.keys(ev).some(k => /telefono|uid|texto|mensaje|email/.test(k))).toBe(false);
    }
  });
});
