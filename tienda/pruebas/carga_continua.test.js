// @vitest-environment jsdom
/**
 * Cargar más solo, al acercarse al final de una lista.
 *
 * Se usa hacia abajo en el catálogo y hacia el costado en las tiras de la
 * portada. Lo que no puede pasar: pedir la misma tanda dos veces (duplica
 * cards y gasta lecturas), quedarse quieto con el final a la vista (el cliente
 * ve "nada más" cuando hay más), seguir escuchando cuando ya no queda nada, o
 * morir en silencio si falla la red.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cargaContinua } from '../src/carga_continua.js';

let observadores;

/** Un IntersectionObserver de mentira: la prueba decide qué está a la vista. */
class ObservadorFalso {
  constructor(alCambiar, opciones) {
    this.alCambiar = alCambiar;
    this.opciones = opciones;
    this.mirando = new Set();
    this.desconectado = false;
    observadores.push(this);
  }
  observe(el) { this.mirando.add(el); }
  unobserve(el) { this.mirando.delete(el); }
  disconnect() { this.desconectado = true; this.mirando.clear(); }
  /** Avisa que el centinela entró (o salió) de la vista. */
  ver(visible = true) {
    this.alCambiar([...this.mirando].map(target => ({ target, isIntersecting: visible })));
  }
}

const esperar = () => new Promise(r => setTimeout(r, 0));

let centinela;

beforeEach(() => {
  observadores = [];
  globalThis.IntersectionObserver = ObservadorFalso;
  document.body.innerHTML = '<div id="lista"></div><div id="centinela"></div>';
  centinela = document.getElementById('centinela');
});

describe('cargaContinua', () => {
  it('pide la tanda siguiente cuando el final se acerca', async () => {
    const cargar = vi.fn(async () => true);
    cargaContinua({ centinela, cargar });

    observadores[0].ver();
    await esperar();
    expect(cargar).toHaveBeenCalledTimes(1);
  });

  it('se adelanta: empieza a cargar antes de llegar al final', () => {
    cargaContinua({ centinela, cargar: async () => true, margen: '800px' });
    expect(observadores[0].opciones.rootMargin).toContain('800px');
  });

  it('hacia el costado mira el borde derecho de su propia tira', () => {
    const tira = document.createElement('div');
    cargaContinua({ centinela, cargar: async () => true, raiz: tira, horizontal: true, margen: '400px' });
    expect(observadores[0].opciones.root).toBe(tira);
    expect(observadores[0].opciones.rootMargin).toBe('0px 400px 0px 0px');
  });

  it('no pide dos tandas a la vez', async () => {
    let soltar;
    const cargar = vi.fn(() => new Promise(r => { soltar = r; }));
    cargaContinua({ centinela, cargar });

    observadores[0].ver();
    observadores[0].ver();
    observadores[0].ver();
    expect(cargar).toHaveBeenCalledTimes(1);
    soltar(true);
    await esperar();
  });

  it('si después de cargar el final sigue a la vista, carga otra sin esperar a que se mueva', async () => {
    const cargar = vi.fn(async () => true);
    cargaContinua({ centinela, cargar });

    observadores[0].ver();
    await esperar();
    // Volver a observar hace que el navegador avise de nuevo con el estado
    // actual: si el centinela sigue a la vista, entra otra tanda.
    expect(observadores[0].mirando.has(centinela)).toBe(true);
    observadores[0].ver();
    await esperar();
    expect(cargar).toHaveBeenCalledTimes(2);
  });

  it('cuando ya no queda nada deja de mirar', async () => {
    const alTerminar = vi.fn();
    cargaContinua({ centinela, cargar: async () => false, alTerminar });

    observadores[0].ver();
    await esperar();
    expect(observadores[0].desconectado).toBe(true);
    expect(alTerminar).toHaveBeenCalled();
  });

  it('salir de la vista no carga nada', async () => {
    const cargar = vi.fn(async () => true);
    cargaContinua({ centinela, cargar });
    observadores[0].ver(false);
    await esperar();
    expect(cargar).not.toHaveBeenCalled();
  });

  it('si falla avisa con una forma de reintentar, y reintentar sigue cargando', async () => {
    let falla = true;
    const cargar = vi.fn(async () => {
      if (falla) throw new Error('sin red');
      return true;
    });
    let reintentar = null;
    cargaContinua({ centinela, cargar, alFallar: (_err, otraVez) => { reintentar = otraVez; } });

    observadores[0].ver();
    await esperar();
    expect(reintentar).toBeTypeOf('function');

    falla = false;
    reintentar();
    await esperar();
    expect(cargar).toHaveBeenCalledTimes(2);
  });

  it('con la lista ya desmontada no carga ni revienta', async () => {
    const cargar = vi.fn(async () => true);
    cargaContinua({ centinela, cargar });
    centinela.remove();
    observadores[0].ver();
    await esperar();
    expect(cargar).not.toHaveBeenCalled();
    expect(observadores[0].desconectado).toBe(true);
  });

  it('sin IntersectionObserver devuelve null: quien llama deja el botón', () => {
    delete globalThis.IntersectionObserver;
    expect(cargaContinua({ centinela, cargar: async () => true })).toBeNull();
  });
});
