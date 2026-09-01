/**
 * El editor rapido de stock del inventario.
 *
 * Bug real del 27-08 (ALFILER ERIZO, art. secundario 987415): el editor rapido
 * escribia solo el `stock` plano, la caja cargada a mano nunca entraba al
 * conjunto y la ficha seguia mostrando el numero viejo.
 *
 * Desde el 31-08 el formulario de la ficha es literal (packs cerrados +
 * sueltos, sin resta del abierto), asi que `formularioIncluyeAbierto` y
 * `packsCerradosTipeados` ya no existen.
 */
import { describe, it, expect } from 'vitest';
import { camposStockRapido } from '../../webapp/src/conjunto.js';

describe('camposStockRapido', () => {
  it('un producto comun escribe solo el stock plano', () => {
    expect(camposStockRapido({ es_conjunto: false }, 40)).toEqual({ stock: 40 });
  });

  it('un conjunto sin variedades escribe los dos contadores juntos', () => {
    // La reposicion del ALFILER: cargaron 112 y el conjunto tiene que quedar
    // en 2 cajas de 48 + 16 sueltas, no en el numero del dia anterior.
    const campos = camposStockRapido(
      { es_conjunto: true, conjunto_contenido: 48 }, 112);
    expect(campos).toEqual({
      stock: 112,
      conjunto_unidades: 2,
      conjunto_restante: 16,
      conjunto_total: 112,
      conjunto_packs_cerrados: true,
    });
  });

  it('el reparto queda en packs enteros', () => {
    const campos = camposStockRapido(
      { es_conjunto: true, conjunto_contenido: 50 }, 305);
    expect(campos.conjunto_unidades).toBe(6);
    expect(campos.conjunto_restante).toBe(5);
    expect(campos.conjunto_total).toBe(305);
  });

  it('un conjunto con variedades no se puede editar rapido', () => {
    const p = { es_conjunto: true, conjunto_contenido: 50,
                conjunto_colores: [{ color: 'Azul', unidades: 1, restante: 0 }] };
    expect(camposStockRapido(p, 99)).toBeNull();
  });

  it('un conjunto sin contenido guarda todo como sueltas', () => {
    const campos = camposStockRapido({ es_conjunto: true }, 25);
    expect(campos.conjunto_unidades).toBe(0);
    expect(campos.conjunto_restante).toBe(25);
    expect(campos.stock).toBe(25);
  });

  it('no baja de cero', () => {
    const campos = camposStockRapido(
      { es_conjunto: true, conjunto_contenido: 10 }, -5);
    expect(campos.stock).toBe(0);
    expect(campos.conjunto_total).toBe(0);
  });
});
