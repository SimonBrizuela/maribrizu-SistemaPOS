/**
 * La zona de reparto: si una dirección cae adentro o afuera.
 *
 * Es la regla que decide si alguien puede pedir con envío, y la usan cuatro
 * lados a la vez (checkout, `envio`, `crear-pedido` y el editor del panel).
 * Lo que se prueba acá es la regla sola, con formas como las que salen de
 * arrastrar puntos a mano: cóncavas, con recortes, en pedazos separados y con
 * basura de un documento editado a mano.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sanearZona, zonaActiva, puntoEnPoligono, dentroDeZona, evaluarZona,
  kmEntre, alcanceKm, areaKm2, circulo, escalar, centroDe, MAX_PUNTOS,
} from '../src/zona_reparto.js';
import { CUENTA, crearMundo, fetchFalso } from './rest_falso.js';

// El local, de verdad: Av. Alfonsina Storni 168.
const LOCAL = { lat: -31.3540169, lng: -64.1734488 };

const cuadrado = (centro, lado, tipo = 'incluir') => ({
  tipo,
  puntos: [
    { lat: centro.lat - lado, lng: centro.lng - lado },
    { lat: centro.lat - lado, lng: centro.lng + lado },
    { lat: centro.lat + lado, lng: centro.lng + lado },
    { lat: centro.lat + lado, lng: centro.lng - lado },
  ],
});

describe('adentro o afuera de un polígono', () => {
  const L = [   // una L: cóncava, como sale al arrastrar un punto para adentro
    { lat: 0, lng: 0 }, { lat: 0, lng: 4 }, { lat: 1, lng: 4 },
    { lat: 1, lng: 1 }, { lat: 4, lng: 1 }, { lat: 4, lng: 0 },
  ];

  it('reconoce lo de adentro y lo de afuera de una forma cóncava', () => {
    expect(puntoEnPoligono({ lat: 0.5, lng: 3 }, L)).toBe(true);   // brazo horizontal
    expect(puntoEnPoligono({ lat: 3, lng: 0.5 }, L)).toBe(true);   // brazo vertical
    expect(puntoEnPoligono({ lat: 3, lng: 3 }, L)).toBe(false);    // el hueco de la L
    expect(puntoEnPoligono({ lat: -1, lng: 2 }, L)).toBe(false);
  });

  it('no se deja engañar por un punto sin coordenadas', () => {
    expect(puntoEnPoligono({ lat: 'x', lng: 1 }, L)).toBe(false);
    expect(puntoEnPoligono(null, L)).toBe(false);
  });
});

describe('la zona con varias áreas y recortes', () => {
  const zona = {
    activa: true,
    areas: [
      cuadrado(LOCAL, 0.05),                                         // alrededor del local
      cuadrado({ lat: -31.45, lng: -64.30 }, 0.01),                  // un barrio suelto, lejos
      cuadrado({ lat: LOCAL.lat + 0.03, lng: LOCAL.lng }, 0.01, 'excluir'), // un recorte adentro
    ],
  };

  it('el local está adentro', () => {
    expect(dentroDeZona(LOCAL, zona)).toBe(true);
  });

  it('el barrio suelto también, aunque no toque el área principal', () => {
    expect(dentroDeZona({ lat: -31.45, lng: -64.30 }, zona)).toBe(true);
    expect(dentroDeZona({ lat: -31.42, lng: -64.27 }, zona)).toBe(false);   // entre los dos
  });

  it('el recorte deja afuera aunque caiga adentro del área', () => {
    expect(dentroDeZona({ lat: LOCAL.lat + 0.03, lng: LOCAL.lng }, zona)).toBe(false);
    expect(dentroDeZona({ lat: LOCAL.lat + 0.03, lng: LOCAL.lng + 0.02 }, zona)).toBe(true);
  });

  it('un recorte solo, sin área de reparto, no deja adentro nada', () => {
    expect(dentroDeZona(LOCAL, { activa: true, areas: [cuadrado(LOCAL, 0.05, 'excluir')] }))
      .toBe(false);
  });
});

describe('cuándo manda la zona', () => {
  it('prendida y con un área de reparto', () => {
    expect(zonaActiva({ zona: { activa: true, areas: [cuadrado(LOCAL, 0.05)] } })).toBe(true);
  });

  it('apagada, sin áreas, o con solo recortes, no manda: decide el radio', () => {
    expect(zonaActiva({ zona: { activa: false, areas: [cuadrado(LOCAL, 0.05)] } })).toBe(false);
    expect(zonaActiva({ zona: { activa: true, areas: [] } })).toBe(false);
    expect(zonaActiva({ zona: { activa: true, areas: [cuadrado(LOCAL, 0.05, 'excluir')] } })).toBe(false);
    expect(zonaActiva({})).toBe(false);
    expect(zonaActiva(undefined)).toBe(false);
  });

  it('"activa" tiene que ser true de verdad, no un texto', () => {
    expect(zonaActiva({ zona: { activa: 'false', areas: [cuadrado(LOCAL, 0.05)] } })).toBe(false);
  });

  it('evaluar devuelve las cuatro respuestas', () => {
    const entrega = { zona: { activa: true, areas: [cuadrado(LOCAL, 0.05)] } };
    expect(evaluarZona(LOCAL, entrega)).toBe('adentro');
    expect(evaluarZona({ lat: -31.6, lng: -64.4 }, entrega)).toBe('afuera');
    expect(evaluarZona(null, entrega)).toBe('sin_ubicacion');
    expect(evaluarZona({ lat: NaN, lng: 1 }, entrega)).toBe('sin_ubicacion');
    expect(evaluarZona(LOCAL, {})).toBe('sin_zona');
  });
});

describe('la zona saneada', () => {
  it('descarta áreas de menos de tres puntos y puntos sin coordenadas', () => {
    const zona = sanearZona({ activa: true, areas: [
      { tipo: 'incluir', puntos: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }] },
      { tipo: 'incluir', puntos: [{ lat: 1, lng: 1 }, { lat: 'x' }, { lat: 1, lng: 2 }, { lat: 2, lng: 2 }] },
    ] });
    expect(zona.areas).toHaveLength(1);
    expect(zona.areas[0].puntos).toHaveLength(3);
  });

  it('saca el punto de cierre repetido y los repetidos seguidos', () => {
    const zona = sanearZona({ activa: true, areas: [{ tipo: 'incluir', puntos: [
      { lat: 1, lng: 1 }, { lat: 1, lng: 2 }, { lat: 1, lng: 2 }, { lat: 2, lng: 2 }, { lat: 1, lng: 1 },
    ] }] });
    expect(zona.areas[0].puntos).toEqual([{ lat: 1, lng: 1 }, { lat: 1, lng: 2 }, { lat: 2, lng: 2 }]);
  });

  it('un tipo desconocido cuenta como área de reparto, no como recorte', () => {
    const zona = sanearZona({ activa: true, areas: [{ ...cuadrado(LOCAL, 0.01), tipo: 'otro' }] });
    expect(zona.areas[0].tipo).toBe('incluir');
  });

  it('redondea a seis decimales y respeta el tope de puntos', () => {
    const muchos = circulo(LOCAL, 3, MAX_PUNTOS + 50);
    const zona = sanearZona({ activa: true, areas: [{ tipo: 'incluir', puntos: muchos }] });
    expect(zona.areas[0].puntos).toHaveLength(MAX_PUNTOS);
    const [p] = sanearZona({ activa: true, areas: [{ tipo: 'incluir', puntos: [
      { lat: -31.12345678, lng: -64.1 }, { lat: -31.2, lng: -64.2 }, { lat: -31.3, lng: -64.1 },
    ] }] }).areas[0].puntos;
    expect(p.lat).toBe(-31.123457);
  });

  it('lo que no se entiende se descarta sin romper', () => {
    expect(sanearZona(null)).toEqual({ activa: false, areas: [] });
    expect(sanearZona({ activa: true, areas: 'x' })).toEqual({ activa: true, areas: [] });
  });
});

describe('las formas y medidas del editor', () => {
  it('el círculo tiene el radio pedido en cualquier dirección', () => {
    const puntos = circulo(LOCAL, 5, 36);
    expect(puntos).toHaveLength(36);
    for (const p of puntos) expect(kmEntre(LOCAL, p)).toBeCloseTo(5, 1);
  });

  it('un círculo de 5 km tiene la superficie de un círculo', () => {
    expect(areaKm2(circulo(LOCAL, 5, 72))).toBeCloseTo(Math.PI * 25, 0);
  });

  it('escalar agranda desde el centro sin moverlo ni deformarlo', () => {
    const puntos = circulo(LOCAL, 4, 36);
    const grande = escalar(puntos, 1.5);
    const c1 = centroDe(puntos);
    const c2 = centroDe(grande);
    expect(c2.lat).toBeCloseTo(c1.lat, 5);
    expect(c2.lng).toBeCloseTo(c1.lng, 5);
    for (const p of grande) expect(kmEntre(LOCAL, p)).toBeCloseTo(6, 1);
  });

  it('el alcance es el punto de reparto más lejano, sin contar recortes', () => {
    const entrega = { zona: { activa: true, areas: [
      { tipo: 'incluir', puntos: circulo(LOCAL, 6) },
      { tipo: 'excluir', puntos: circulo({ lat: LOCAL.lat - 0.2, lng: LOCAL.lng }, 1) },
    ] } };
    expect(alcanceKm(LOCAL, entrega)).toBeCloseTo(6, 0);
    expect(alcanceKm(LOCAL, {})).toBeNull();
  });

  it('la distancia entre dos puntos conocidos', () => {
    // El local y el Patio Olmos: unos 7,3 km en línea recta.
    expect(kmEntre(LOCAL, { lat: -31.4190, lng: -64.1885 })).toBeCloseTo(7.3, 0);
  });
});

/* ── La función `envio` del servidor ──────────────────────────────────────── */

describe('la cotización del servidor con la zona', () => {
  let mundo;

  async function cargar() {
    vi.resetModules();
    return (await import('../netlify/functions/envio.mjs')).default;
  }
  const cotizar = (destino) => new Request('https://beta.liceolibreria.com/.netlify/functions/envio', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destino }),
  });
  const preguntoARoutes = () => fetch.mock.calls.some(c => String(c[0]).includes('routes.googleapis'));

  beforeEach(() => {
    mundo = crearMundo();
    mundo.config.entrega.zona = { activa: true, areas: [cuadrado(mundo.config.origen, 0.03)] };
    process.env.FIREBASE_SERVICE_ACCOUNT = CUENTA;
    process.env.GOOGLE_ROUTES_KEY = 'clave-de-prueba';
    vi.stubGlobal('fetch', vi.fn(fetchFalso(mundo)));
  });

  it('afuera contesta "fuera de zona" sin gastar una consulta de Routes', async () => {
    const envio = await cargar();
    const res = await envio(cotizar({ lat: -31.45, lng: -64.19 }));
    expect(await res.json()).toEqual({ km: null, precio: null, fuera_de_zona: true });
    expect(preguntoARoutes()).toBe(false);
  });

  it('adentro mide y cobra el tramo', async () => {
    mundo.metros = 2500;
    const envio = await cargar();
    const res = await envio(cotizar({ lat: -31.36, lng: -64.18 }));
    expect(await res.json()).toEqual({ km: 2.5, precio: 1500 });
    expect(preguntoARoutes()).toBe(true);
  });

  it('adentro pero con mucho recorrido no corta por el radio: paga el último tramo', async () => {
    mundo.metros = 25000;
    const envio = await cargar();
    const res = await envio(cotizar({ lat: -31.36, lng: -64.18 }));
    expect(await res.json()).toEqual({ km: 25, precio: 3500 });
  });

  it('con la zona apagada vuelve el radio de siempre', async () => {
    mundo.config.entrega.zona.activa = false;
    mundo.metros = 25000;
    const envio = await cargar();
    const res = await envio(cotizar({ lat: -31.45, lng: -64.19 }));
    expect(await res.json()).toEqual({ km: 25, precio: null, fuera_de_radio: true });
  });
});
