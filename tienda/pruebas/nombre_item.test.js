/**
 * Leer el nombre del renglón que escribió el POS.
 *
 * Cuando la venta sale del diálogo de producto conjunto, el POS guarda el
 * nombre decorado: "[Verde]  GOMA EVA  ·  2 u", "PAPEL A4  ·  1 pack(s)". Ese
 * texto es lo único que viaja: la cantidad real de una venta fraccionada NO
 * está en el campo `cantidad` (dice 1 cuando se vendieron 2,5 metros, y dice 1
 * cuando se vendió un rollo de 25).
 *
 * De acá dependen cuatro cosas del panel, y las cuatro estaban rotas o a medias
 * antes de que esto existiera:
 *   · cuánto stock devolver al borrar una venta,
 *   · la velocidad de venta del Inventario,
 *   · el costo de la mercadería vendida en la rentabilidad del turno,
 *   · y el margen del mes en el Dashboard.
 */
import { describe, it, expect } from 'vitest';

import {
  parseNombreItem, factorPorUnidad, unidadesDelRenglon, buscarPorNombre,
} from '../../webapp/src/nombre_item.js';

const ROLLO = {
  nombre: 'CINTA RASO 10MM', conjunto_tipo: 'rollo',
  conjunto_contenido: 25, conjunto_unidad_medida: 'metros',
};
const RESMA = {
  nombre: 'PAPEL OBRA A4', conjunto_tipo: 'pack',
  conjunto_contenido: 500, conjunto_unidad_medida: 'unidades',
};

describe('partir el nombre', () => {
  it('variedad, producto y presentación', () => {
    expect(parseNombreItem('[Verde]  GOMA EVA 40X60  ·  2 u'))
      .toEqual({ color: 'Verde', base: 'GOMA EVA 40X60', descripcion: '2 u' });
  });

  it('sin variedad', () => {
    expect(parseNombreItem('PAPEL OBRA A4  ·  1 pack(s)'))
      .toEqual({ color: '', base: 'PAPEL OBRA A4', descripcion: '1 pack(s)' });
  });

  it('un producto común vuelve tal cual', () => {
    expect(parseNombreItem('CUADERNO RIVADAVIA'))
      .toEqual({ color: '', base: 'CUADERNO RIVADAVIA', descripcion: '' });
  });

  it('nada no rompe nada', () => {
    expect(parseNombreItem(null)).toEqual({ color: '', base: '', descripcion: '' });
  });
});

describe('cuántas unidades se llevó el renglón', () => {
  it('un producto común: la cantidad tal cual', () => {
    expect(unidadesDelRenglon({ producto: 'CUADERNO', cantidad: 3 })).toBe(3);
  });

  it('un rollo entero son sus metros', () => {
    expect(unidadesDelRenglon(
      { producto: 'CINTA RASO 10MM  ·  1 rollo(s)', cantidad: 1 }, ROLLO)).toBe(25);
  });

  it('dos resmas son mil hojas', () => {
    expect(unidadesDelRenglon(
      { producto: 'PAPEL OBRA A4  ·  2 pack(s)', cantidad: 2 }, RESMA)).toBe(1000);
  });

  it('una cantidad con coma viaja sólo en el nombre', () => {
    expect(unidadesDelRenglon(
      { producto: 'CINTA RASO 10MM  ·  2,5 m', cantidad: 1 }, ROLLO)).toBe(2.5);
  });

  it('sin el producto no se puede traducir: vale la cantidad', () => {
    expect(unidadesDelRenglon(
      { producto: 'CINTA RASO 10MM  ·  1 rollo(s)', cantidad: 1 })).toBe(1);
  });

  it('una presentación que no se entiende tampoco inventa nada', () => {
    expect(unidadesDelRenglon(
      { producto: 'CINTA RASO 10MM  ·  2 gruesas', cantidad: 2 }, ROLLO)).toBe(2);
  });

  it('una unidad de otra magnitud no se mezcla', () => {
    // Gramos sobre algo que se mide en metros: no se convierte.
    expect(factorPorUnidad(ROLLO, '100 g')).toBeNull();
  });
});

describe('encontrar el producto en el catálogo', () => {
  const INDICE = {
    'CINTA RASO 10MM': ROLLO,
    'PAPEL OBRA A4': RESMA,
    'PAPEL · OBRA': { nombre: 'PAPEL · OBRA', costo: 1 },
  };

  it('el nombre pelado', () => {
    expect(buscarPorNombre(INDICE, 'CINTA RASO 10MM')).toBe(ROLLO);
  });

  it('el nombre decorado encuentra al producto igual', () => {
    expect(buscarPorNombre(INDICE, '[Verde]  CINTA RASO 10MM  ·  2 m')).toBe(ROLLO);
    expect(buscarPorNombre(INDICE, 'PAPEL OBRA A4  ·  1 pack(s)')).toBe(RESMA);
  });

  it('no distingue mayúsculas ni espacios de los bordes', () => {
    expect(buscarPorNombre(INDICE, '  cinta raso 10mm  ')).toBe(ROLLO);
  });

  it('un producto que lleva "·" en su nombre de verdad gana', () => {
    // Se prueba el nombre completo primero, así limpiar no puede romper una
    // coincidencia que ya funcionaba.
    expect(buscarPorNombre(INDICE, 'PAPEL · OBRA').costo).toBe(1);
  });

  it('lo que no está no aparece', () => {
    expect(buscarPorNombre(INDICE, 'NO EXISTE')).toBeNull();
    expect(buscarPorNombre(INDICE, '')).toBeNull();
    expect(buscarPorNombre(null, 'CINTA RASO 10MM')).toBeNull();
  });
});
