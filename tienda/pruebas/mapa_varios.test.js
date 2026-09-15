/**
 * El mapa con varios puntos del repartidor: que entren todos, con aire, y que
 * cada marcador caiga donde está su dirección.
 */
import { describe, it, expect } from 'vitest';
import { vistaQueEntra } from '../src/mapa.js';

const LOCAL = { lat: -31.354, lng: -64.173 };

describe('vistaQueEntra', () => {
  it('todos los puntos caen adentro de la imagen, sin tocar el borde', () => {
    const puntos = [LOCAL, { lat: -31.37, lng: -64.19 }, { lat: -31.40, lng: -64.21 }, { lat: -31.36, lng: -64.15 }];
    const vista = vistaQueEntra(puntos, 640, 400);
    for (const p of puntos) {
      const { x, y } = vista.enPantalla(p);
      expect(x).toBeGreaterThan(4);
      expect(x).toBeLessThan(96);
      expect(y).toBeGreaterThan(8);
      expect(y).toBeLessThan(96);
    }
  });

  it('más separados, más lejos se ve', () => {
    const cerca = vistaQueEntra([LOCAL, { lat: -31.358, lng: -64.176 }], 640, 400);
    const lejos = vistaQueEntra([LOCAL, { lat: -31.45, lng: -64.30 }], 640, 400);
    expect(lejos.zoom).toBeLessThan(cerca.zoom);
  });

  it('con un solo punto queda en el medio y no se acerca de más', () => {
    const vista = vistaQueEntra([LOCAL], 640, 400);
    expect(vista.zoom).toBe(16);
    expect(vista.enPantalla(LOCAL).x).toBeCloseTo(50, 5);
  });

  it('el centro vuelve a caer en el medio de la imagen', () => {
    const vista = vistaQueEntra([LOCAL, { lat: -31.40, lng: -64.21 }], 640, 400);
    const medio = vista.enPantalla(vista.centro);
    expect(medio.x).toBeCloseTo(50, 3);
    expect(medio.y).toBeCloseTo(50, 3);
  });

  it('sin coordenadas no hay vista, y lo que no es coordenada se ignora', () => {
    expect(vistaQueEntra([], 640, 400)).toBeNull();
    expect(vistaQueEntra([null, { lat: 'x' }], 640, 400)).toBeNull();
    expect(vistaQueEntra([LOCAL, null], 640, 400)).not.toBeNull();
  });
});
