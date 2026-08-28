/**
 * La velocidad de venta: cuánto se vendió de cada producto en 7, 30 y 90 días.
 *
 * De este número salen dos decisiones: qué aparece "sin movimiento" en el
 * Inventario y cuánto propone comprar el Centro de Compras. Si un producto
 * figura con cero ventas teniéndolas, no se repone y se agota en la góndola.
 *
 * El caso que lo rompía: todo lo que se vende fraccionado (rollos, packs,
 * cartulinas por color) NO viaja con el nombre pelado. El POS escribe el
 * renglón decorado ("[Verde]  GOMA EVA  ·  2 u", "PAPEL A4  ·  1 pack(s)") y
 * la búsqueda se hacía con ese texto, que no coincide con ningún producto del
 * catálogo. Encima la cantidad viene en la presentación vendida: "1 pack(s)"
 * es un 1 que son 500 hojas.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase/firestore', async () => (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../../webapp/src/cache.js', () => ({
  getCached: async (_k, fn) => fn(), peekCacheValue: () => null,
}));
vi.mock('../../webapp/src/store.js', () => ({ ensureCollections: () => {} }));

const { computarResumen, sugerirCantidad, resumenEstaVencido } =
  await import('../../webapp/src/inventario_resumen.js');

/** Una fecha de hace N días, en el formato "dd/mm/yyyy" que guarda el POS. */
function haceDias(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

const renglon = (producto, cantidad, dias) => ({ producto, cantidad, fecha: haceDias(dias) });

const ROLLO = {
  nombre: 'CINTA RASO 10MM', es_conjunto: true, conjunto_tipo: 'rollo',
  conjunto_contenido: 25, conjunto_unidad_medida: 'metros',
};
const RESMA = {
  nombre: 'PAPEL OBRA A4', es_conjunto: true, conjunto_tipo: 'pack',
  conjunto_contenido: 500, conjunto_unidad_medida: 'unidades',
};

describe('el producto común', () => {
  it('suma sus unidades en las tres ventanas', () => {
    const r = computarResumen([
      renglon('CUADERNO RIVADAVIA', 2, 1),
      renglon('CUADERNO RIVADAVIA', 3, 20),
      renglon('CUADERNO RIVADAVIA', 5, 60),
    ]);
    expect(r.por_producto['CUADERNO RIVADAVIA']).toEqual({ u7: 2, u30: 5, u90: 10 });
  });

  it('lo de hace más de 90 días no cuenta', () => {
    const r = computarResumen([renglon('CUADERNO', 9, 120)]);
    expect(r.por_producto['CUADERNO']).toBeUndefined();
  });

  it('un renglón sin cantidad cuenta como uno', () => {
    const r = computarResumen([{ producto: 'CUADERNO', fecha: haceDias(1) }]);
    expect(r.por_producto['CUADERNO'].u7).toBe(1);
  });

  it('una fecha ilegible se saltea sin romper el resto', () => {
    const r = computarResumen([
      { producto: 'CUADERNO', cantidad: 3, fecha: 'ayer' },
      renglon('BIROME', 2, 1),
    ]);
    expect(r.por_producto['CUADERNO']).toBeUndefined();
    expect(r.por_producto['BIROME'].u7).toBe(2);
  });
});

describe('el producto que se vende fraccionado', () => {
  it('se encuentra por su nombre, no por el renglón decorado', () => {
    const r = computarResumen([
      renglon('[Verde]  CINTA RASO 10MM  ·  2 m', 2, 3),
      renglon('[Rojo]  CINTA RASO 10MM  ·  3 m', 3, 3),
    ], [ROLLO]);
    // Antes quedaban dos claves distintas, ninguna igual al nombre del
    // catálogo, y el producto figuraba con cero ventas.
    expect(Object.keys(r.por_producto)).toEqual(['CINTA RASO 10MM']);
    expect(r.por_producto['CINTA RASO 10MM'].u7).toBe(5);
  });

  it('un rollo entero cuenta sus metros, no un "1"', () => {
    const r = computarResumen([renglon('CINTA RASO 10MM  ·  1 rollo(s)', 1, 2)], [ROLLO]);
    expect(r.por_producto['CINTA RASO 10MM'].u7).toBe(25);
  });

  it('dos resmas son mil hojas', () => {
    const r = computarResumen([renglon('PAPEL OBRA A4  ·  2 pack(s)', 2, 2)], [RESMA]);
    expect(r.por_producto['PAPEL OBRA A4'].u7).toBe(1000);
  });

  it('una venta con decimales viaja entera en el nombre', () => {
    // El POS manda cantidad 1 y los 2,5 metros quedan sólo en el texto.
    const r = computarResumen([
      { producto: 'CINTA RASO 10MM  ·  2,5 m', cantidad: 1, fecha: haceDias(1) },
    ], [ROLLO]);
    expect(r.por_producto['CINTA RASO 10MM'].u7).toBe(2.5);
  });

  it('convierte entre unidades de la misma magnitud', () => {
    const r = computarResumen([renglon('CINTA RASO 10MM  ·  50 cm', 50, 1)], [ROLLO]);
    expect(r.por_producto['CINTA RASO 10MM'].u7).toBeCloseTo(0.5, 10);
  });

  it('sin catálogo igual limpia el nombre', () => {
    // Es lo más importante de las dos cosas: sin esto el producto no existe
    // para el Inventario. La conversión de presentaciones queda sin hacer.
    const r = computarResumen([renglon('[Verde]  CINTA RASO 10MM  ·  2 m', 2, 1)]);
    expect(r.por_producto['CINTA RASO 10MM'].u7).toBe(2);
  });

  it('una presentación que no se entiende no inventa un número', () => {
    const r = computarResumen([renglon('CINTA RASO 10MM  ·  2 gruesas', 2, 1)], [ROLLO]);
    expect(r.por_producto['CINTA RASO 10MM'].u7).toBe(2);   // la cantidad tal cual
  });
});

describe('el total de los últimos días', () => {
  it('el sparkline agrupa por fecha', () => {
    const hoy = haceDias(0);
    const r = computarResumen([
      { producto: 'A', cantidad: 2, fecha: hoy },
      { producto: 'B', cantidad: 3, fecha: hoy },
      renglon('C', 4, 20),
    ]);
    expect(r.por_dia[hoy]).toBe(5);
    expect(r.totales.items_14d).toBe(5);
  });

  it('las unidades de 30 días juntan todo', () => {
    const r = computarResumen([renglon('A', 2, 1), renglon('B', 3, 25), renglon('C', 9, 60)]);
    expect(r.totales.unidades_30d).toBe(5);
  });
});

describe('cuánto comprar', () => {
  it('cubre los días pedidos menos lo que ya hay', () => {
    // Vende 2 por día, quedan 10, se quieren 30 días de cobertura: 60 - 10.
    expect(sugerirCantidad(2, 10, 0, 30)).toBe(50);
  });

  it('con stock de sobra no propone comprar', () => {
    expect(sugerirCantidad(1, 100, 0, 30)).toBe(0);
  });

  it('sin ventas no propone nada', () => {
    expect(sugerirCantidad(0, 0, 0, 30)).toBe(0);
  });
});

describe('cuándo hay que rehacer el resumen', () => {
  it('sin resumen o sin fecha, siempre', () => {
    expect(resumenEstaVencido(null)).toBe(true);
    expect(resumenEstaVencido({})).toBe(true);
    expect(resumenEstaVencido({ por_producto: {} })).toBe(true);
  });

  it('uno recién hecho sirve', () => {
    expect(resumenEstaVencido({ por_producto: {}, generado_at: new Date() })).toBe(false);
  });

  it('uno de ayer ya no', () => {
    const ayer = new Date(Date.now() - 25 * 60 * 60 * 1000);
    expect(resumenEstaVencido({ por_producto: {}, generado_at: ayer })).toBe(true);
  });
});
