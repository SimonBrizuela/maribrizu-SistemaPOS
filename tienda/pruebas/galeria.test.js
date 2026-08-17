/**
 * La galería de la ficha.
 *
 * Lo que importa: que al elegir un color con foto propia se vea ESA foto, que
 * elegir uno sin foto no cambie nada, que soltarlo vuelva a la portada, y que
 * las miniaturas sean la galería del producto y no las fotos de los colores.
 * El DOM se reemplaza por elementos de mentira: lo que se prueba es qué foto
 * queda puesta, no el navegador.
 */
import { describe, it, expect } from 'vitest';
import {
  fotoDeVariedad, portada, miniaturas, fotoAlElegir, htmlGaleria, montarGaleria,
} from '../src/galeria.js';

const PORTADA = 'https://x/portada.webp';
const DETALLE = 'https://x/detalle.webp';
const CAJA = 'https://x/caja.webp';
const ROJO = 'https://x/rojo.webp';

const LAPIZ = {
  id: 'l1', nombre: 'Lápiz Faber 2B', precio: 500, stock: 30, imagenes: [PORTADA, DETALLE, CAJA],
  variedades: [
    { nombre: 'Rojo', stock: 15, precio: null, imagen: ROJO },
    { nombre: 'Azul', stock: 7, precio: null, imagen: null },
    // La foto del verde es una de la galería: la miniatura tiene que marcarse.
    { nombre: 'Verde', stock: 8, precio: null, imagen: CAJA },
  ],
};

describe('qué foto corresponde', () => {
  it('la portada es la primera de la galería', () => {
    expect(portada(LAPIZ)).toBe(PORTADA);
    expect(portada({ imagenes: [] })).toBeNull();
    expect(portada({ imagenes: ['', '  ', DETALLE] })).toBe(DETALLE);
    expect(portada({})).toBeNull();
  });

  it('cada variedad sabe su foto, y sin foto da null', () => {
    expect(fotoDeVariedad(LAPIZ, 'Rojo')).toBe(ROJO);
    expect(fotoDeVariedad(LAPIZ, 'Azul')).toBeNull();
    expect(fotoDeVariedad(LAPIZ, 'Fucsia')).toBeNull();
    expect(fotoDeVariedad(LAPIZ, null)).toBeNull();
    // Documentos viejos del espejo no traen el campo: no revienta.
    expect(fotoDeVariedad({ variedades: [{ nombre: 'Rojo', stock: 1 }] }, 'Rojo')).toBeNull();
  });

  it('las miniaturas son la galería del producto, solo con más de una foto', () => {
    expect(miniaturas(LAPIZ)).toEqual([PORTADA, DETALLE, CAJA]);
    expect(miniaturas({ imagenes: [PORTADA] })).toEqual([]);
    expect(miniaturas({ imagenes: [] })).toEqual([]);
    // La foto del rojo no se cuela entre las del producto.
    expect(miniaturas(LAPIZ)).not.toContain(ROJO);
  });

  it('elegir un color con foto propia muestra esa foto', () => {
    expect(fotoAlElegir(LAPIZ, 'Rojo', PORTADA)).toBe(ROJO);
    expect(fotoAlElegir(LAPIZ, 'Verde', ROJO)).toBe(CAJA);
  });

  it('elegir un color sin foto propia deja la que se estaba viendo', () => {
    expect(fotoAlElegir(LAPIZ, 'Azul', DETALLE)).toBe(DETALLE);
    // Recién abierta la ficha (sin "actual") cae a la portada.
    expect(fotoAlElegir(LAPIZ, 'Azul', null)).toBe(PORTADA);
  });

  it('soltar el color vuelve a la portada', () => {
    expect(fotoAlElegir(LAPIZ, null, ROJO)).toBe(PORTADA);
  });

  it('un producto sin fotos no inventa ninguna', () => {
    const sinFotos = { ...LAPIZ, imagenes: [], variedades: [{ nombre: 'Rojo', stock: 1 }] };
    expect(fotoAlElegir(sinFotos, 'Rojo', null)).toBeNull();
    expect(fotoAlElegir(sinFotos, null, null)).toBeNull();
  });
});

describe('el HTML de la galería', () => {
  it('lleva la portada grande y una miniatura por foto, la primera marcada', () => {
    const html = htmlGaleria(LAPIZ);
    expect(html).toContain(`data-galeria-grande src="${PORTADA}"`);
    expect(html.match(/data-galeria-mini=/g)).toHaveLength(3);
    expect(html).toContain(`data-galeria-mini="${PORTADA}"\n                  aria-pressed="true"`);
    expect(html).toContain(`data-galeria-mini="${DETALLE}"\n                  aria-pressed="false"`);
    // Las fotos de los colores no son miniaturas.
    expect(html).not.toContain(ROJO);
  });

  it('con una sola foto no hay miniaturas', () => {
    const html = htmlGaleria({ ...LAPIZ, imagenes: [PORTADA] });
    expect(html).toContain('data-galeria-grande');
    expect(html).not.toContain('data-galeria-mini');
  });

  it('sin fotos, la placa con la inicial', () => {
    const html = htmlGaleria({ ...LAPIZ, imagenes: [] });
    expect(html).toContain('card-producto__placa');
    expect(html).toContain('>L<');
    expect(html).not.toContain('data-galeria-grande');
  });

  it('escapa el nombre y las urls', () => {
    const html = htmlGaleria({ nombre: 'Lápiz "2B" <fino>', imagenes: ['https://x/a.webp?b=1&c=2'] });
    expect(html).toContain('alt="Lápiz &quot;2B&quot; &lt;fino&gt;"');
    expect(html).toContain('src="https://x/a.webp?b=1&amp;c=2"');
  });
});

/* ── Un DOM de mentira, lo justo para montarGaleria ─────────────────────── */
function elemento(atributos = {}) {
  const attrs = { ...atributos };
  const oyentes = {};
  return {
    dataset: Object.fromEntries(Object.entries(attrs)
      .filter(([k]) => k.startsWith('data-'))
      .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase()), v])),
    getAttribute: k => attrs[k] ?? null,
    setAttribute: (k, v) => { attrs[k] = String(v); },
    addEventListener: (tipo, fn) => { (oyentes[tipo] ||= []).push(fn); },
    disparar: tipo => (oyentes[tipo] || []).forEach(fn => fn()),
  };
}

function galeriaDeMentira(p) {
  const grande = elemento({ src: portada(p) });
  const minis = miniaturas(p).map((url, i) =>
    elemento({ 'data-galeria-mini': url, 'aria-pressed': String(i === 0) }));
  const raiz = {
    querySelector: sel => (sel === '[data-galeria-grande]' ? grande : null),
    querySelectorAll: sel => (sel === '[data-galeria-mini]' ? minis : []),
  };
  return { raiz, grande, minis };
}

describe('montada en la ficha', () => {
  it('elegir Rojo pone su foto grande y desmarca las miniaturas', () => {
    const { raiz, grande, minis } = galeriaDeMentira(LAPIZ);
    const g = montarGaleria(raiz, LAPIZ);

    g.alElegirVariedad('Rojo');
    expect(grande.getAttribute('src')).toBe(ROJO);
    expect(minis.map(m => m.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false']);
  });

  it('elegir Verde (foto de la galería) marca esa miniatura', () => {
    const { raiz, grande, minis } = galeriaDeMentira(LAPIZ);
    const g = montarGaleria(raiz, LAPIZ);

    g.alElegirVariedad('Verde');
    expect(grande.getAttribute('src')).toBe(CAJA);
    expect(minis.map(m => m.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
  });

  it('elegir Azul (sin foto) no cambia nada; soltar vuelve a la portada', () => {
    const { raiz, grande, minis } = galeriaDeMentira(LAPIZ);
    const g = montarGaleria(raiz, LAPIZ);

    g.alElegirVariedad('Rojo');
    g.alElegirVariedad('Azul');
    expect(grande.getAttribute('src')).toBe(ROJO);

    g.alElegirVariedad(null);
    expect(grande.getAttribute('src')).toBe(PORTADA);
    expect(minis.map(m => m.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
  });

  it('tocar una miniatura la muestra sin tocar el color elegido', () => {
    const { raiz, grande, minis } = galeriaDeMentira(LAPIZ);
    montarGaleria(raiz, LAPIZ);

    minis[1].disparar('click');
    expect(grande.getAttribute('src')).toBe(DETALLE);
    expect(minis.map(m => m.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
  });

  it('sin fotos no hay nada que montar y las funciones no revientan', () => {
    const raiz = { querySelector: () => null, querySelectorAll: () => [] };
    const g = montarGaleria(raiz, { ...LAPIZ, imagenes: [] });
    expect(() => { g.mostrar(ROJO); g.alElegirVariedad('Rojo'); }).not.toThrow();
    expect(() => montarGaleria(null, LAPIZ).alElegirVariedad('Rojo')).not.toThrow();
  });
});
