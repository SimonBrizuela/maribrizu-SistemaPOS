/**
 * Las cuentas del zoom de las fotos: cuánto se acerca, hasta dónde se puede
 * correr la foto y qué hace un deslizamiento.
 *
 * Todo esto se siente con el dedo y no se ve en una prueba de pantalla, así que
 * se prueba acá, sin DOM: que el punto que se pellizca quede debajo del dedo,
 * que la foto nunca deje un borde vacío al arrastrarla, y que un toque torcido
 * no cierre el visor ni cambie de foto sin querer.
 */
import { describe, it, expect } from 'vitest';
import {
  ESCALA_MAX, ESCALA_DOBLE, limitar, zoomEnPunto, escalaConRueda, origenLupa,
  fotosDelVisor, gestoAlSoltar,
} from '../src/zoom.js';

// Un celular: el marco es la pantalla y la foto cuadrada entra de ancho.
const MARCO = { ancho: 400, alto: 800 };
const FOTO = { ancho: 400, alto: 400 };

describe('limitar', () => {
  it('sin zoom la foto queda centrada, no se puede correr', () => {
    expect(limitar({ escala: 1, x: 80, y: -50 }, MARCO, FOTO)).toEqual({ escala: 1, x: 0, y: 0 });
  });

  it('con zoom se corre hasta el borde de la foto y no más', () => {
    // A 2x la foto mide 800 × 800: sobra 200 de cada lado a lo ancho; a lo
    // alto mide lo mismo que la pantalla y no sobra nada.
    expect(limitar({ escala: 2, x: 500, y: 300 }, MARCO, FOTO)).toEqual({ escala: 2, x: 200, y: 0 });
    expect(limitar({ escala: 2, x: -500, y: 0 }, MARCO, FOTO)).toEqual({ escala: 2, x: -200, y: 0 });
    expect(limitar({ escala: 2, x: 120, y: 0 }, MARCO, FOTO)).toEqual({ escala: 2, x: 120, y: 0 });
  });

  it('la escala no baja de 1 ni pasa del máximo', () => {
    expect(limitar({ escala: 0.3, x: 0, y: 0 }, MARCO, FOTO).escala).toBe(1);
    expect(limitar({ escala: 40, x: 0, y: 0 }, MARCO, FOTO).escala).toBe(ESCALA_MAX);
  });

  it('sin medidas (la foto todavía no cargó) no revienta ni corre nada', () => {
    expect(limitar({ escala: 2, x: 90, y: 90 }, { ancho: 0, alto: 0 }, { ancho: 0, alto: 0 }))
      .toEqual({ escala: 2, x: 0, y: 0 });
  });
});

describe('zoomEnPunto', () => {
  // El punto de la foto que está debajo del dedo, relativo al centro del marco.
  const debajo = (estado, punto) => ({
    x: (punto.x - estado.x) / estado.escala,
    y: (punto.y - estado.y) / estado.escala,
  });

  it('lo que está debajo del dedo sigue debajo del dedo después de acercar', () => {
    const antes = { escala: 1, x: 0, y: 0 };
    const punto = { x: 100, y: 50 };
    const despues = zoomEnPunto(antes, 2, punto, MARCO, { ancho: 400, alto: 800 });
    expect(debajo(despues, punto)).toEqual(debajo(antes, punto));
  });

  it('acercar en el centro no corre la foto', () => {
    expect(zoomEnPunto({ escala: 1, x: 0, y: 0 }, ESCALA_DOBLE, { x: 0, y: 0 }, MARCO, FOTO))
      .toEqual({ escala: ESCALA_DOBLE, x: 0, y: 0 });
  });

  it('acercar en una punta no deja un borde vacío', () => {
    const r = zoomEnPunto({ escala: 1, x: 0, y: 0 }, 2, { x: -200, y: 0 }, MARCO, FOTO);
    expect(r.x).toBe(200);
  });

  it('alejar hasta 1 vuelve al centro', () => {
    expect(zoomEnPunto({ escala: 2.5, x: 150, y: 0 }, 1, { x: 30, y: 30 }, MARCO, FOTO))
      .toEqual({ escala: 1, x: 0, y: 0 });
  });
});

describe('escalaConRueda', () => {
  it('para arriba acerca y para abajo aleja, de a poco', () => {
    const arriba = escalaConRueda(1.5, -100);
    const abajo = escalaConRueda(1.5, 100);
    expect(arriba).toBeGreaterThan(1.5);
    expect(abajo).toBeLessThan(1.5);
    // Un golpe de rueda no lleva al máximo de una.
    expect(arriba).toBeLessThan(2.2);
  });

  it('se queda entre 1 y el máximo', () => {
    expect(escalaConRueda(1, 5000)).toBe(1);
    expect(escalaConRueda(ESCALA_MAX, -5000)).toBe(ESCALA_MAX);
  });
});

describe('origenLupa', () => {
  const rect = { left: 100, top: 200, width: 400, height: 400 };

  it('el punto del mouse en porcentaje de la foto', () => {
    expect(origenLupa({ x: 300, y: 300 }, rect)).toEqual({ x: 50, y: 25 });
  });

  it('afuera del marco se queda en el borde', () => {
    expect(origenLupa({ x: 0, y: 900 }, rect)).toEqual({ x: 0, y: 100 });
  });

  it('sin tamaño, al centro', () => {
    expect(origenLupa({ x: 10, y: 10 }, { left: 0, top: 0, width: 0, height: 0 }))
      .toEqual({ x: 50, y: 50 });
  });
});

describe('fotosDelVisor', () => {
  const P = { imagenes: ['a.webp', ' b.webp ', '', 'c.webp'] };

  it('abre la galería del producto en la foto que se estaba viendo', () => {
    expect(fotosDelVisor(P, 'b.webp')).toEqual({ fotos: ['a.webp', 'b.webp', 'c.webp'], indice: 1 });
  });

  it('la foto de un color, que no es de la galería, va primero y después la galería', () => {
    expect(fotosDelVisor(P, 'rojo.webp'))
      .toEqual({ fotos: ['rojo.webp', 'a.webp', 'b.webp', 'c.webp'], indice: 0 });
  });

  it('sin saber cuál se veía, arranca en la portada', () => {
    expect(fotosDelVisor(P, null)).toEqual({ fotos: ['a.webp', 'b.webp', 'c.webp'], indice: 0 });
  });

  it('sin fotos no hay nada para abrir', () => {
    expect(fotosDelVisor({ imagenes: [] }, null)).toEqual({ fotos: [], indice: 0 });
    expect(fotosDelVisor({}, null)).toEqual({ fotos: [], indice: 0 });
  });
});

describe('gestoAlSoltar', () => {
  const base = { escala: 1, hayAnterior: true, haySiguiente: true };

  it('deslizar a la izquierda pasa a la siguiente y a la derecha vuelve', () => {
    expect(gestoAlSoltar({ ...base, dx: -90, dy: 10 })).toBe('siguiente');
    expect(gestoAlSoltar({ ...base, dx: 90, dy: -10 })).toBe('anterior');
  });

  it('en la primera o la última no hay a dónde ir', () => {
    expect(gestoAlSoltar({ ...base, haySiguiente: false, dx: -90, dy: 0 })).toBe(null);
    expect(gestoAlSoltar({ ...base, hayAnterior: false, dx: 90, dy: 0 })).toBe(null);
  });

  it('deslizar para abajo cierra; para arriba no', () => {
    expect(gestoAlSoltar({ ...base, dx: 10, dy: 130 })).toBe('cerrar');
    expect(gestoAlSoltar({ ...base, dx: 10, dy: -130 })).toBe(null);
  });

  it('un toque corto o torcido no hace nada', () => {
    expect(gestoAlSoltar({ ...base, dx: -20, dy: 5 })).toBe(null);
    // En diagonal parejo no se sabe qué quiso: no se adivina.
    expect(gestoAlSoltar({ ...base, dx: -80, dy: 75 })).toBe(null);
  });

  it('con zoom, arrastrar es mirar la foto, no cambiarla ni cerrar', () => {
    expect(gestoAlSoltar({ ...base, escala: 2, dx: -200, dy: 0 })).toBe(null);
    expect(gestoAlSoltar({ ...base, escala: 2, dx: 0, dy: 300 })).toBe(null);
  });
});
