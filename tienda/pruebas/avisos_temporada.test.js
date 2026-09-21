// @vitest-environment jsdom
/**
 * "Se viene Halloween, preparate mirando qué artículos."
 *
 * Pedido del dueño (21/09/2026): que el aviso lo vaya a buscar a él y que de un
 * click se abra con toda la info. Lo que cuidan estas pruebas es que el aviso
 * sirva y no moleste: si sale cada vez que se cambia de pantalla, se aprende a
 * ignorarlo y deja de existir.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  avisosPendientes, textoAviso, mostrarAvisosTemporada,
  initAvisosTemporada, detenerAvisosTemporada,
} from '../../webapp/src/avisos_temporada.js';

const fecha = (id, diasFaltan, extra = {}) => ({
  id, nombre: id === 'halloween' ? 'Halloween' : 'Día de la Madre',
  diasFaltan, plazoAviso: 60, enVenta: false, nota: '', ...extra,
});

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  detenerAvisosTemporada();
});
afterEach(() => { detenerAvisosTemporada(); vi.useRealTimers(); });

describe('cuándo avisar', () => {
  it('avisa cuando la fecha recién entra en el plazo', () => {
    const p = avisosPendientes('2026-09-21', [fecha('halloween', 58)]);
    expect(p.map(x => x.id)).toEqual(['halloween']);
  });

  it('no repite el mismo día', () => {
    const lista = [fecha('halloween', 58)];
    expect(avisosPendientes('2026-09-21', lista)).toHaveLength(1);
    mostrarAvisosTemporada({ hoy: '2026-09-21', proximas: lista });   // marca lo de hoy
    // Con la marca puesta, el mismo día ya no vuelve a salir.
    expect(avisosPendientes('2026-09-21', lista)).toHaveLength(0);
  });

  it('no avisa de más de dos fechas juntas', () => {
    const p = avisosPendientes('2026-09-21', [
      fecha('a', 10), fecha('b', 20), fecha('c', 30), fecha('d', 40),
    ]);
    expect(p).toHaveLength(2);
  });

  it('insiste todos los días mientras se está vendiendo', () => {
    const hoy = fecha('halloween', 3, { enVenta: true });
    localStorage.setItem('temporadas:avisadas', JSON.stringify({ halloween: '2026-10-27' }));
    // Ayer se avisó, pero la venta ya arrancó: vuelve a salir igual.
    expect(avisosPendientes('2026-10-28', [hoy])).toHaveLength(1);
  });

  it('en el medio afloja a una vez por semana', () => {
    // Entró al plazo hace rato (faltan 40 de 60) y se avisó anteayer.
    const t = fecha('halloween', 40);
    localStorage.setItem('temporadas:avisadas', JSON.stringify({ halloween: '2026-09-19' }));
    expect(avisosPendientes('2026-09-21', [t])).toHaveLength(0);
    // Pasada la semana, vuelve.
    expect(avisosPendientes('2026-09-27', [t])).toHaveLength(1);
  });

  it('sin localStorage avisa igual, no se rompe', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('storage bloqueado'); },
    });
    try {
      expect(() => avisosPendientes('2026-09-21', [fecha('halloween', 58)])).not.toThrow();
      expect(avisosPendientes('2026-09-21', [fecha('halloween', 58)])).toHaveLength(1);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('qué dice', () => {
  it('cuántos días faltan', () => {
    expect(textoAviso(fecha('halloween', 40))).toBe('Se viene Halloween: faltan 40 días');
  });

  it('cuando ya se está vendiendo, lo dice', () => {
    expect(textoAviso(fecha('halloween', 5, { enVenta: true })))
      .toContain('ya se está vendiendo');
  });

  it('"es hoy" en vez de "faltan 0 días"', () => {
    expect(textoAviso(fecha('halloween', 0, { enVenta: true }))).toBe('Halloween es hoy');
  });
});

describe('el aviso en pantalla', () => {
  it('sale con el botón para ir a ver', () => {
    mostrarAvisosTemporada({ hoy: '2026-09-21' });
    const toast = document.querySelector('.ll-toast');
    expect(toast).toBeTruthy();
    expect(toast.textContent).toContain('Fecha que se viene');
    expect(toast.textContent).toContain('Ver qué conviene comprar');
  });

  it('el click lleva a la fecha y cierra el aviso', () => {
    const ido = [];
    mostrarAvisosTemporada({ hoy: '2026-09-21', navegar: id => ido.push(id) });
    const btn = document.querySelector('.ll-toast [data-act="ver"]');
    expect(btn).toBeTruthy();
    btn.click();
    expect(ido).toHaveLength(1);
    expect(typeof ido[0]).toBe('string');
  });

  it('no se cierra solo: es para decidir, no para mirar de reojo', () => {
    mostrarAvisosTemporada({ hoy: '2026-09-21' });
    // Sin barra de progreso = sin cierre automático.
    expect(document.querySelector('.ll-toast .ll-toast-barra')).toBeNull();
  });

  it('el arranque no avisa al instante: espera a que la pantalla cargue', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="app"></div>';
    initAvisosTemporada({ demoraMs: 2500 });
    expect(document.querySelector('.ll-toast')).toBeNull();
    vi.advanceTimersByTime(2600);
    expect(document.querySelector('.ll-toast')).toBeTruthy();
  });

  it('arrancar dos veces no deja dos temporizadores colgados', () => {
    // Cada arranque del panel llamaba a esto y dejaba su propio aviso pendiente:
    // los avisos se apilaban y, en las pruebas, el temporizador sobrevivía a la
    // prueba y agregaba la pila de avisos a un documento que ya era otro.
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="app"></div>';
    initAvisosTemporada({ demoraMs: 2500 });
    initAvisosTemporada({ demoraMs: 2500 });
    initAvisosTemporada({ demoraMs: 2500 });
    vi.advanceTimersByTime(3000);
    expect(document.querySelectorAll('#llToastStack')).toHaveLength(1);
  });

  it('si el panel ya no está en pantalla, no pinta nada', () => {
    // El temporizador vive 2,5 s: en el medio se puede cerrar sesión o recargar,
    // y el aviso no tiene que aparecer pegado a un documento que ya es otro.
    vi.useFakeTimers();
    document.body.innerHTML = '';          // sin #app
    initAvisosTemporada({ demoraMs: 2500 });
    vi.advanceTimersByTime(3000);
    expect(document.querySelector('.ll-toast')).toBeNull();
  });

  it('se puede cancelar antes de que salga', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="app"></div>';
    initAvisosTemporada({ demoraMs: 2500 });
    detenerAvisosTemporada();
    vi.advanceTimersByTime(3000);
    expect(document.querySelector('.ll-toast')).toBeNull();
  });
});
