/**
 * El cuaderno del Centro de Compras se refresca una vez por semana: lo que se
 * anotó para un viaje y no se consiguió vuelve a su lugar en la lista en vez de
 * quedar enterrado al fondo (pedido del 03/11/2026).
 */
import { describe, it, expect } from 'vitest';
import {
  diaDeRefresco, ultimoDiaDeRefresco, planRefrescoCuaderno, textoCorte,
  DIA_REFRESCO_DEFAULT, SIN_REFRESCO,
} from '../../webapp/src/cuaderno_refresco.js';

// 2026-11-02 es lunes; 2026-11-05 jueves.
describe('qué día toca', () => {
  it('sin elegir nada es el lunes', () => {
    expect(diaDeRefresco({})).toBe(DIA_REFRESCO_DEFAULT);
    expect(DIA_REFRESCO_DEFAULT).toBe(1);
  });

  it('respeta el día elegido y el apagado', () => {
    expect(diaDeRefresco({ cuaderno_refresco_dia: 3 })).toBe(3);
    expect(diaDeRefresco({ cuaderno_refresco_dia: 0 })).toBe(0);
    expect(diaDeRefresco({ cuaderno_refresco_dia: SIN_REFRESCO })).toBe(SIN_REFRESCO);
    expect(diaDeRefresco({ cuaderno_refresco_dia: 'cualquiera' })).toBe(DIA_REFRESCO_DEFAULT);
  });

  it('el último lunes que ya pasó, o hoy si es lunes', () => {
    expect(ultimoDiaDeRefresco('2026-11-02', 1)).toBe('2026-11-02');
    expect(ultimoDiaDeRefresco('2026-11-05', 1)).toBe('2026-11-02');
    expect(ultimoDiaDeRefresco('2026-11-08', 1)).toBe('2026-11-02');   // domingo
    expect(ultimoDiaDeRefresco('2026-11-09', 1)).toBe('2026-11-09');
    expect(ultimoDiaDeRefresco('2026-11-01', 1)).toBe('2026-10-26');   // cruza de mes
  });

  it('apagado no da ningún día', () => {
    expect(ultimoDiaDeRefresco('2026-11-05', SIN_REFRESCO)).toBe('');
  });
});

describe('qué se desmarca', () => {
  const anotados = {
    viejo: '2026-10-29',          // anotado para el viaje del jueves pasado
    'goma|Rojo': '2026-10-30',    // una variedad, el viernes
    hoy: '2026-11-02',            // anotado el mismo lunes: es para este viaje
    yaRepuesto: '2026-10-28',     // salió de la lista: entró stock
  };
  const enLista = new Set(['viejo', 'goma|Rojo', 'hoy']);

  it('el lunes, lo anotado antes que sigue faltando vuelve a la lista', () => {
    const p = planRefrescoCuaderno({ anotados, enLista, hoyYmd: '2026-11-02', dia: 1 });
    expect(p.corte).toBe('2026-11-02');
    expect(p.desmarcar).toEqual({ viejo: '2026-10-29', 'goma|Rojo': '2026-10-30' });
  });

  it('lo anotado desde el lunes en adelante no se toca', () => {
    const p = planRefrescoCuaderno({ anotados, enLista, hoyYmd: '2026-11-04', dia: 1 });
    expect(p.desmarcar.hoy).toBeUndefined();
  });

  it('lo que ya no está en la lista no se toca: entró stock', () => {
    const p = planRefrescoCuaderno({ anotados, enLista, hoyYmd: '2026-11-02', dia: 1 });
    expect(p.desmarcar.yaRepuesto).toBeUndefined();
  });

  it('una sola vez por semana', () => {
    const p = planRefrescoCuaderno({ anotados, enLista, hoyYmd: '2026-11-05', dia: 1, refrescadoHasta: '2026-11-02' });
    expect(p.corte).toBe('');
    expect(p.desmarcar).toEqual({});
  });

  it('si nadie entró el lunes, el martes hace lo mismo', () => {
    const lunes = planRefrescoCuaderno({ anotados, enLista, hoyYmd: '2026-11-02', dia: 1, refrescadoHasta: '2026-10-26' });
    const martes = planRefrescoCuaderno({ anotados, enLista, hoyYmd: '2026-11-03', dia: 1, refrescadoHasta: '2026-10-26' });
    expect(martes).toEqual(lunes);
  });

  it('apagado no desmarca nada', () => {
    const p = planRefrescoCuaderno({ anotados, enLista, hoyYmd: '2026-11-02', dia: SIN_REFRESCO });
    expect(p.desmarcar).toEqual({});
  });

  it('marcas raras o vacías no rompen nada', () => {
    const p = planRefrescoCuaderno({
      anotados: { a: null, b: 5, c: '' }, enLista: new Set(['a', 'b', 'c']), hoyYmd: '2026-11-02', dia: 1,
    });
    expect(p.desmarcar).toEqual({});
  });
});

it('el aviso nombra el día', () => {
  expect(textoCorte('2026-11-02')).toBe('el lunes 02/11');
});
