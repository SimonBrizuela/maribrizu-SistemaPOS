/**
 * La hoja imprimible de la lista de compras del cuaderno.
 *
 * `webapp/src/lista_cuaderno.js` no toca el DOM: recibe los renglones anotados
 * y devuelve el HTML de la hoja A4. Acá se fija el agrupado por rubro, el
 * orden (lo "sí o sí" primero), las sumas estimadas y que lo sin costo no
 * ensucie los totales.
 */
import { describe, it, expect } from 'vitest';
import { agruparCuaderno, listaCuadernoHtml } from '../../webapp/src/lista_cuaderno.js';

const item = (over = {}) => ({
  nombre: 'BOTON COCO 18', variedad: null, esVariedad: false, rubro: 'MERCERÍA',
  tier: 'sisi', qty: 10, cost: 65, sinCosto: false, packSize: 1,
  stockTexto: '0 u.', ritmo: '~11/sem', ...over,
});

describe('el agrupado por rubro', () => {
  const items = [
    item({ nombre: 'PILA AZ312', rubro: 'LIBRERÍA', tier: 'importante', qty: 16, cost: 11830 }),
    item({ nombre: 'CINTA NARANJA', rubro: 'COTILLON', qty: 1, cost: 91800 }),
    item({ nombre: 'BOTON URANO', rubro: 'MERCERÍA', tier: 'opcional', qty: 4, cost: 170 }),
    item(),
    item({ nombre: 'AGUJA CROCHET', rubro: 'MERCERÍA', tier: 'importante', qty: 2, cost: 0, sinCosto: true }),
  ];
  const grupos = agruparCuaderno(items);

  it('rubros alfabéticos y adentro lo sí o sí primero', () => {
    expect(grupos.map(g => g.rubro)).toEqual(['COTILLON', 'LIBRERÍA', 'MERCERÍA']);
    expect(grupos[2].items.map(i => i.nombre)).toEqual(['BOTON COCO 18', 'AGUJA CROCHET', 'BOTON URANO']);
  });
  it('el estimado del rubro suma cantidad por costo, sin lo que no tiene costo', () => {
    expect(grupos[2].estimado).toBe(10 * 65 + 4 * 170);
    expect(grupos[2].conCosto).toBe(2);
    expect(grupos[1].estimado).toBe(16 * 11830);
  });
});

describe('la hoja completa', () => {
  it('trae el total estimado, el conteo y las columnas para anotar a mano', () => {
    const html = listaCuadernoHtml({
      items: [item(), item({ nombre: 'CINTA LILA', rubro: 'COTILLON', qty: 1, cost: 91800 })],
      fecha: '2026-09-01',
    });
    const plano = html.replace(/\./g, '');
    expect(html).toContain('LISTA DE COMPRAS');
    expect(html).toContain('01/09/2026');
    expect(plano).toContain('$ 92450');            // 650 + 91.800
    expect(html).toContain('Compré');
    expect(html).toContain('Pagué $');
    expect(html).toContain('Cierre de la compra');
    expect(html).toContain('de <b>2</b> productos');
  });
  it('la variante y el sí o sí se ven en el renglón; lo sin costo va con guión', () => {
    const html = listaCuadernoHtml({
      items: [
        item({ nombre: 'CINTA RIBBONETTE 10 MM', variedad: 'NARANJA', esVariedad: true, packSize: 50 }),
        item({ nombre: 'AGUJA CROCHET', sinCosto: true, tier: 'importante' }),
      ],
      fecha: '2026-09-01',
    });
    expect(html).toContain('NARANJA');
    expect(html).toContain('sí o sí');
    expect(html).toContain('packs de 50 u');
    expect(html).toContain('stock 0 u.');
    expect(html).toContain('vende ~11/sem');
    expect((html.match(/>—</g) || []).length).toBeGreaterThanOrEqual(2);   // costo y estimado sin inventar
  });
  it('escapa lo que viene del catálogo', () => {
    const html = listaCuadernoHtml({ items: [item({ nombre: 'CINTA <b>x</b> & "rara"' })], fecha: '2026-09-01' });
    expect(html).toContain('CINTA &lt;b&gt;x&lt;/b&gt; &amp; &quot;rara&quot;');
    expect(html).not.toContain('CINTA <b>x</b>');
  });
  it('sin renglones lo dice en vez de imprimir una hoja rota', () => {
    const html = listaCuadernoHtml({ items: [], fecha: '2026-09-01' });
    expect(html).toContain('No hay nada marcado en el cuaderno');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });
});
