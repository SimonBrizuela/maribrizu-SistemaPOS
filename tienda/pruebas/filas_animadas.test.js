// @vitest-environment jsdom
/**
 * Filas que se van y llegan sin saltos.
 *
 * Un renglón que desaparece de golpe hace saltar la tabla entera: lo que estaba
 * debajo del mouse pasa a ser otro producto y se pierde el hilo. Acá el renglón
 * se desvanece y después se cierra el hueco que dejó, de a poco, así lo de abajo
 * sube acompañando. Al entrar es al revés: se abre el lugar y aparece.
 *
 * jsdom no dibuja, así que lo que se prueba es lo que no puede fallar nunca: que
 * la fila se vaya aunque el navegador no anime o la animación no termine (una
 * fila invisible que sigue ocupando lugar es peor que un salto), que no se
 * pueda apretar dos veces mientras sale, que no quede ningún hueco colgado y
 * que con movimiento reducido nada se desplace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sacarFila, meterFila, desplegar, plegar,
} from '../../webapp/src/components/filas_animadas.js';

let tbody;

function armarTabla(ids) {
  document.body.innerHTML = `<table><tbody>${ids.map(id =>
    `<tr data-fila="${id}"><td>${id}</td><td><button>Ocultar</button></td></tr>`).join('')}</tbody></table>`;
  tbody = document.querySelector('tbody');
}

const ids = () => [...tbody.rows].map(r => r.dataset.fila ?? `(${r.className})`);

/** Cada fila mide 40 px. */
function conAlturas() {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 40, height: 40, left: 0, right: 100, width: 100 });
  return () => { Element.prototype.getBoundingClientRect = original; };
}

/** Un `animate` que registra lo que se le pide y termina al toque. */
function conAnimate() {
  const llamadas = [];
  Element.prototype.animate = function (cuadros, opciones) {
    // Lo que se ve en el momento de animar: si la fila ya está en la tabla, si
    // el hueco está puesto.
    llamadas.push({ nodo: this, cuadros, opciones, tabla: ids() });
    return { finished: Promise.resolve(), cancel() {} };
  };
  Element.prototype.getAnimations = function () { return []; };
  return llamadas;
}

beforeEach(() => {
  armarTabla(['a', 'b', 'c']);
  window.matchMedia = undefined;
});

afterEach(() => {
  delete Element.prototype.animate;
  delete Element.prototype.getAnimations;
  vi.useRealTimers();
});

describe('sacarFila', () => {
  it('sin soporte de animaciones la fila se va igual', async () => {
    await sacarFila(tbody.querySelector('[data-fila="b"]'));
    expect(ids()).toEqual(['a', 'c']);
  });

  it('si la animación no termina nunca, la fila se va igual', async () => {
    vi.useFakeTimers();
    Element.prototype.animate = () => ({ finished: new Promise(() => {}), cancel() {} });
    Element.prototype.getAnimations = () => [];

    const saliendo = sacarFila(tbody.querySelector('[data-fila="b"]'));
    await vi.advanceTimersByTimeAsync(3000);
    await saliendo;

    expect(ids()).toEqual(['a', 'c']);
  });

  it('mientras sale queda marcada y sin botones: no se aprieta dos veces', () => {
    Element.prototype.animate = () => ({ finished: new Promise(() => {}), cancel() {} });
    const b = tbody.querySelector('[data-fila="b"]');

    sacarFila(b);

    expect(b.hasAttribute('data-saliendo')).toBe(true);
    expect(b.querySelector('button').disabled).toBe(true);
  });

  it('primero se desvanece y después se cierra el hueco, del alto de la fila a cero', async () => {
    const restaurar = conAlturas();
    const llamadas = conAnimate();
    try {
      const b = tbody.querySelector('[data-fila="b"]');
      await sacarFila(b);

      const [salida, cierre] = llamadas;
      expect(salida.nodo).toBe(b);
      expect(salida.cuadros.at(-1).opacity).toBe(0);

      // El hueco ocupa el lugar de la fila mientras se cierra.
      expect(cierre.tabla).toEqual(['a', '(fila-hueco)', 'c']);
      expect(cierre.cuadros[0].height).toBe('40px');
      expect(cierre.cuadros.at(-1).height).toBe('0px');

      expect(ids(), 'quedó el hueco colgado').toEqual(['a', 'c']);
    } finally {
      restaurar();
    }
  });

  it('el hueco ocupa todas las columnas: la tabla no se descuadra', async () => {
    const restaurar = conAlturas();
    const llamadas = conAnimate();
    try {
      await sacarFila(tbody.querySelector('[data-fila="b"]'));
      const celda = llamadas[1].nodo.closest('td');
      expect(celda.colSpan).toBe(2);
    } finally {
      restaurar();
    }
  });

  it('con movimiento reducido solo se desvanece: nada se desplaza ni se achica', async () => {
    const restaurar = conAlturas();
    const llamadas = conAnimate();
    window.matchMedia = (q) => ({ matches: q.includes('reduce') });
    try {
      const b = tbody.querySelector('[data-fila="b"]');
      await sacarFila(b);

      expect(llamadas).toHaveLength(1);
      expect(Object.keys(llamadas[0].cuadros.at(-1))).toEqual(['opacity']);
      expect(ids()).toEqual(['a', 'c']);
    } finally {
      restaurar();
    }
  });
});

describe('meterFila', () => {
  const nuevaFila = () => {
    const tr = document.createElement('tr');
    tr.dataset.fila = 'x';
    tr.innerHTML = '<td>x</td><td></td>';
    return tr;
  };

  it('abre el lugar y después aparece, en la posición que le toca', async () => {
    const restaurar = conAlturas();
    const llamadas = conAnimate();
    try {
      const nueva = nuevaFila();
      await meterFila(nueva, () => tbody.insertBefore(nueva, tbody.rows[1]));

      const [apertura, aparicion] = llamadas;
      expect(apertura.tabla).toEqual(['a', '(fila-hueco)', 'b', 'c']);
      expect(apertura.cuadros[0].height).toBe('0px');
      expect(apertura.cuadros.at(-1).height).toBe('40px');

      expect(aparicion.nodo).toBe(nueva);
      expect(aparicion.cuadros[0].opacity).toBe(0);
      expect(aparicion.tabla).toEqual(['a', 'x', 'b', 'c']);

      expect(ids()).toEqual(['a', 'x', 'b', 'c']);
    } finally {
      restaurar();
    }
  });

  it('sin soporte de animaciones queda puesta igual', async () => {
    const nueva = nuevaFila();
    await meterFila(nueva, () => tbody.appendChild(nueva));
    expect(ids()).toEqual(['a', 'b', 'c', 'x']);
  });

  it('con movimiento reducido aparece sin abrir lugar de a poco', async () => {
    const llamadas = conAnimate();
    window.matchMedia = (q) => ({ matches: q.includes('reduce') });

    const nueva = nuevaFila();
    await meterFila(nueva, () => tbody.appendChild(nueva));

    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].nodo).toBe(nueva);
    expect(Object.keys(llamadas[0].cuadros[0])).toEqual(['opacity']);
  });
});

describe('desplegar y plegar una caja', () => {
  it('plegar vacía la caja al terminar y no la deja trabada en alto cero', async () => {
    const cancelada = vi.fn();
    Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel: cancelada });
    Element.prototype.getAnimations = function () { return [{ cancel: cancelada }]; };

    const caja = document.createElement('div');
    caja.innerHTML = '<p>algo</p>';
    document.body.appendChild(caja);

    await plegar(caja, () => { caja.innerHTML = ''; });

    expect(caja.innerHTML).toBe('');
    expect(cancelada).toHaveBeenCalled();
  });

  it('sin soporte de animaciones, desplegar y plegar no traban nada', async () => {
    const caja = document.createElement('div');
    caja.innerHTML = '<p>algo</p>';
    await desplegar(caja);
    let vaciada = false;
    await plegar(caja, () => { vaciada = true; });
    expect(vaciada).toBe(true);
  });
});
