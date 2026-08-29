// @vitest-environment jsdom
/**
 * La pila de avisos flotantes del panel (stock y pedidos de la tienda).
 *
 * Antes cada módulo armaba la suya: los de stock caían en el medio de la
 * pantalla tapando la búsqueda y los filtros del catálogo, y los de pedidos
 * vivían aparte arriba a la derecha. Cuando entraban juntos se superponían,
 * que es justo cuando más importa poder leerlos.
 *
 * Lo que esta prueba cuida:
 *   · una sola pila para toda la app, al costado, no en el medio;
 *   · un pedido nuevo (prioritario) queda arriba de los avisos de stock;
 *   · la pila no crece sin fin: veinte avisos apilados no los lee nadie;
 *   · lo que queda hasta que lo cierran no se va solo, y lo demás sí;
 *   · el nombre de un producto no puede inyectar HTML.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mostrarToast, cerrarToast, _resetToasts } =
  await import('../../webapp/src/components/toasts.js');

const pila = () => document.getElementById('llToastStack');
const avisos = () => [...(pila()?.children || [])];

beforeEach(() => {
  _resetToasts();
  document.body.innerHTML = '';
});

afterEach(() => { vi.useRealTimers(); });

describe('dónde aparecen', () => {
  it('hay una sola pila para todos los avisos', () => {
    mostrarToast({ titulo: 'uno' });
    mostrarToast({ titulo: 'dos' });
    expect(document.querySelectorAll('#llToastStack').length).toBe(1);
    expect(avisos().length).toBe(2);
  });

  it('la pila cuelga del body, no de la página que se está mirando', () => {
    // Un re-render del catálogo no puede llevarse puesto un aviso abierto.
    mostrarToast({ titulo: 'uno' });
    expect(pila().parentElement).toBe(document.body);
  });

  it('cuando no queda ninguno, la pila se va del DOM', () => {
    const a = mostrarToast({ titulo: 'uno' });
    a.cerrar();
    document.querySelector('.ll-toast')?.dispatchEvent(new Event('transitionend'));
    expect(pila()).toBeNull();
  });
});

describe('el orden', () => {
  it('un pedido nuevo se pone arriba de los avisos de stock', () => {
    mostrarToast({ titulo: 'stock bajo' });
    mostrarToast({ titulo: 'pedido nuevo', prioritario: true });
    expect(avisos()[0].textContent).toContain('pedido nuevo');
  });

  it('entre iguales, el que llega después va abajo', () => {
    mostrarToast({ titulo: 'primero' });
    mostrarToast({ titulo: 'segundo' });
    expect(avisos().map(e => e.textContent.includes('primero'))).toEqual([true, false]);
  });
});

describe('la pila no tapa la pantalla', () => {
  it('con más de cuatro, se van los más viejos', () => {
    for (let i = 0; i < 8; i++) mostrarToast({ titulo: 'p' + i });
    expect(avisos().filter(e => e.dataset.cerrando !== '1').length).toBeLessThanOrEqual(4);
  });

  it('ni siquiera los prioritarios se acumulan sin fin', () => {
    // Una importación puede cruzar el mínimo de veinte productos de una.
    for (let i = 0; i < 9; i++) mostrarToast({ titulo: 'p' + i, prioritario: true });
    expect(avisos().filter(e => e.dataset.cerrando !== '1').length).toBeLessThanOrEqual(4);
  });
});

describe('cuánto duran', () => {
  it('el que tiene duración se va solo', () => {
    vi.useFakeTimers();
    mostrarToast({ titulo: 'stock bajo', duracion: 5000 });
    vi.advanceTimersByTime(5100);
    expect(avisos()[0].dataset.cerrando).toBe('1');
  });

  it('el pedido nuevo se queda hasta que alguien lo cierre', () => {
    vi.useFakeTimers();
    mostrarToast({ titulo: 'pedido nuevo', duracion: 0, prioritario: true });
    vi.advanceTimersByTime(120000);
    expect(avisos()[0].dataset.cerrando).toBeUndefined();
  });
});

describe('los botones', () => {
  it('el botón propio avisa quién lo apretó', () => {
    const vistos = [];
    mostrarToast({
      titulo: 'stock bajo',
      acciones: [{ id: 'rellenar', texto: 'Rellenar', principal: true }],
      onAccion: (id) => vistos.push(id),
    });
    avisos()[0].querySelector('[data-act="rellenar"]').click();
    expect(vistos).toEqual(['rellenar']);
  });

  it('la cruz cierra sin llamar a la acción', () => {
    const vistos = [];
    mostrarToast({ titulo: 'stock bajo', onAccion: (id) => vistos.push(id) });
    avisos()[0].querySelector('.ll-toast-x').click();
    expect(vistos).toEqual([]);
    expect(avisos()[0].dataset.cerrando).toBe('1');
  });

  it('cerrar dos veces no rompe nada', () => {
    const a = mostrarToast({ titulo: 'uno' });
    a.cerrar();
    expect(() => { a.cerrar(); cerrarToast(a.el); }).not.toThrow();
  });
});

describe('el texto que viene de los datos', () => {
  it('un nombre con HTML no inyecta nada', () => {
    mostrarToast({ titulo: '<img src=x onerror=alert(1)>', etiqueta: '<b>x</b>' });
    expect(document.querySelector('.ll-toast img')).toBeNull();
    expect(document.querySelector('.ll-toast-titulo').innerHTML).toContain('&lt;img');
    expect(document.querySelector('.ll-toast-etiqueta').innerHTML).toContain('&lt;b&gt;');
  });

  it('el detalle sí acepta HTML, porque lo arma la app', () => {
    mostrarToast({ titulo: 'x', detalleHtml: 'Quedan <b>0</b>' });
    expect(document.querySelector('.ll-toast-detalle b').textContent).toBe('0');
  });
});
