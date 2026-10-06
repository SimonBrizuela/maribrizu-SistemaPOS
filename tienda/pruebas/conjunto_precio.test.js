/**
 * Precio del producto cuando la ficha se guarda con el precio cargado solo en
 * las variedades. Sin esto quedaba en 0 / 'sin_precio' y las cajas no lo
 * bajaban (REPUESTO DIBUJO DOBLE OFICIO, 06-10).
 */
import { describe, it, expect } from 'vitest';
import { precioDesdeVariedades } from '../../webapp/src/conjunto.js';

describe('precioDesdeVariedades', () => {
  it('toma la variedad más barata y su costo', () => {
    const colores = [
      { color: 'Blanco x 8', precio: 1800, precio_pack: 1800, costo: 1013 },
      { color: 'Color x 6', precio: 2300, precio_pack: 2300, costo: 1241 },
      { color: 'Sueltas Color', precio: 400, precio_pack: 400, costo: 237.86 },
    ];
    expect(precioDesdeVariedades(colores)).toEqual({ precio_venta: 400, costo: 237.86 });
  });

  it('usa el precio unitario si la variedad no tiene precio de pack', () => {
    expect(precioDesdeVariedades([{ precio: 250, costo: 120 }, { precio_pack: 0, precio: 300 }]))
      .toEqual({ precio_venta: 250, costo: 120 });
  });

  it('sin costo cargado, el costo es el precio para que no quede sin_precio', () => {
    expect(precioDesdeVariedades([{ precio_pack: 950 }])).toEqual({ precio_venta: 950, costo: 950 });
  });

  it('null si ninguna variedad tiene precio', () => {
    expect(precioDesdeVariedades([{ color: 'Rojo', precio: 0 }, null])).toBeNull();
    expect(precioDesdeVariedades(null)).toBeNull();
  });
});
