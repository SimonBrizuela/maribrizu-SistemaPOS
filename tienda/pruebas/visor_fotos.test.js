// @vitest-environment jsdom
/**
 * El visor de fotos de la ficha: la foto a pantalla completa para verla bien.
 *
 * Quien compra útiles lo hace casi siempre desde el celular, y en la ficha la
 * foto es chica: una cartulina de 29 colores no se distingue sin acercarse.
 * Acá se prueba lo que se hace con los botones, el teclado y el historial; las
 * cuentas del pellizco y el arrastre están en `zoom.test.js`.
 *
 * Lo más delicado es el botón "atrás" del celular: con el visor abierto tiene
 * que cerrarlo, no sacar al cliente de la ficha. Y cerrarlo con la cruz no
 * puede dejar una entrada de más en el historial ni repintar la página.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { abrirVisorFotos, cerrarVisorFotos } from '../src/visor_fotos.js';
import { alNavegar, iniciar } from '../src/router.js';

const FOTOS = ['https://x/a.webp', 'https://x/b.webp', 'https://x/c.webp'];
const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

let repintadas;
let disparador;

// El router escucha `popstate` una sola vez por archivo, como en la tienda.
iniciar();

beforeEach(() => {
  repintadas = 0;
  alNavegar(() => { repintadas++; });
  document.body.innerHTML = '<button id="foto">Foto</button>';
  disparador = document.getElementById('foto');
  disparador.focus();
  document.documentElement.style.overflow = '';
  window.history.replaceState({}, '', '/p/cartulina');
});

afterEach(async () => {
  cerrarVisorFotos();
  await esperar(20);
});

const visor = () => document.querySelector('.visor-fotos');
const imagen = () => visor()?.querySelector('[data-visor-imagen]');
const cuenta = () => visor()?.querySelector('[data-visor-cuenta]')?.textContent.trim();
const tecla = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
const escala = () => Number((imagen().style.transform.match(/scale\(([\d.]+)\)/) || [])[1] ?? 1);

function abrir(indice = 1, fotos = FOTOS) {
  return abrirVisorFotos({ fotos, indice, nombre: 'Cartulina Luma', disparador });
}

describe('abrir', () => {
  it('muestra la foto pedida con cuántas hay', () => {
    abrir(1);
    expect(visor().getAttribute('role')).toBe('dialog');
    expect(visor().getAttribute('aria-modal')).toBe('true');
    expect(visor().getAttribute('aria-label')).toContain('Cartulina Luma');
    expect(imagen().getAttribute('src')).toBe(FOTOS[1]);
    expect(cuenta()).toBe('2 / 3');
  });

  it('el foco pasa al visor y la página de atrás no se mueve', () => {
    abrir(0);
    expect(visor().contains(document.activeElement)).toBe(true);
    expect(document.documentElement.style.overflow).toBe('hidden');
  });

  it('con una sola foto no hay flechas ni contador', () => {
    abrir(0, [FOTOS[0]]);
    expect(visor().querySelector('[data-visor-anterior]')).toBeNull();
    expect(visor().querySelector('[data-visor-siguiente]')).toBeNull();
    expect(cuenta()).toBeUndefined();
  });

  it('abrir otro cierra el que estaba: nunca hay dos', () => {
    abrir(0);
    abrir(2);
    expect(document.querySelectorAll('.visor-fotos')).toHaveLength(1);
    expect(cuenta()).toBe('3 / 3');
  });
});

describe('pasar de foto', () => {
  it('las flechas pasan de foto y en las puntas se apagan', () => {
    abrir(0);
    const anterior = visor().querySelector('[data-visor-anterior]');
    const siguiente = visor().querySelector('[data-visor-siguiente]');
    expect(anterior.disabled).toBe(true);

    siguiente.click();
    siguiente.click();
    expect(imagen().getAttribute('src')).toBe(FOTOS[2]);
    expect(cuenta()).toBe('3 / 3');
    expect(siguiente.disabled).toBe(true);
    expect(anterior.disabled).toBe(false);
  });

  it('con las flechas del teclado también', () => {
    abrir(1);
    tecla('ArrowRight');
    expect(cuenta()).toBe('3 / 3');
    tecla('ArrowLeft');
    tecla('ArrowLeft');
    expect(cuenta()).toBe('1 / 3');
    tecla('ArrowLeft');
    expect(cuenta()).toBe('1 / 3');
  });

  it('la foto nueva arranca sin zoom', () => {
    abrir(0);
    imagen().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 0, clientY: 0 }));
    expect(escala()).toBeGreaterThan(1);
    tecla('ArrowRight');
    expect(escala()).toBe(1);
  });
});

describe('acercar', () => {
  it('doble clic acerca y otro doble clic vuelve', () => {
    abrir(0);
    expect(escala()).toBe(1);
    imagen().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 0, clientY: 0 }));
    expect(escala()).toBe(2);
    imagen().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 0, clientY: 0 }));
    expect(escala()).toBe(1);
  });

  it('la rueda acerca de a poco y nunca pasa del máximo', () => {
    abrir(0);
    const escenario = visor().querySelector('[data-visor-escenario]');
    escenario.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }));
    const una = escala();
    expect(una).toBeGreaterThan(1);
    for (let i = 0; i < 40; i++) {
      escenario.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }));
    }
    expect(escala()).toBe(3);
  });

  it('el botón de la lupa acerca y aleja, para quien no sabe del doble clic', () => {
    abrir(0);
    const boton = visor().querySelector('[data-visor-zoom]');
    boton.click();
    expect(escala()).toBe(2);
    expect(boton.getAttribute('aria-label')).toBe('Alejar');
    boton.click();
    expect(escala()).toBe(1);
    expect(boton.getAttribute('aria-label')).toBe('Acercar');
  });

  it('con + y - del teclado', () => {
    abrir(0);
    tecla('+');
    expect(escala()).toBeGreaterThan(1);
    tecla('0');
    expect(escala()).toBe(1);
  });
});

describe('cerrar', () => {
  it('con Escape: se va, devuelve el foco a la foto y la página vuelve a moverse', async () => {
    abrir(0);
    tecla('Escape');
    await esperar(20);
    expect(visor()).toBeNull();
    expect(document.activeElement).toBe(disparador);
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('con la cruz', async () => {
    abrir(0);
    visor().querySelector('[data-visor-cerrar]').click();
    await esperar(20);
    expect(visor()).toBeNull();
  });

  it('tocando el fondo, pero no la foto', async () => {
    abrir(0);
    imagen().click();
    expect(visor()).not.toBeNull();
    visor().querySelector('[data-visor-escenario]').click();
    await esperar(20);
    expect(visor()).toBeNull();
  });

  it('con zoom, Escape primero aleja: cerrar de golpe perdía lo que se estaba mirando', async () => {
    abrir(0);
    imagen().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 0, clientY: 0 }));
    tecla('Escape');
    expect(visor()).not.toBeNull();
    expect(escala()).toBe(1);
    tecla('Escape');
    await esperar(20);
    expect(visor()).toBeNull();
  });
});

describe('el botón atrás del celular', () => {
  it('cierra el visor y deja al cliente en la ficha, sin repintarla', async () => {
    abrir(0);
    // La entrada del visor: el "atrás" la saca a ella y no a la ficha.
    expect(window.history.state?.capa).toBe(true);

    window.history.back();
    await esperar(30);

    expect(visor()).toBeNull();
    expect(window.location.pathname).toBe('/p/cartulina');
    expect(repintadas, 'el router repintó la página').toBe(0);
  });

  it('cerrar con la cruz saca la entrada que había puesto, sin repintar', async () => {
    abrir(0);
    visor().querySelector('[data-visor-cerrar]').click();
    await esperar(30);

    expect(visor()).toBeNull();
    expect(repintadas).toBe(0);
    // El siguiente atrás es de verdad: la navegación sigue andando.
    const antes = repintadas;
    window.history.pushState({}, '', '/catalogo');
    window.history.back();
    await esperar(30);
    expect(repintadas).toBe(antes + 1);
  });
});
