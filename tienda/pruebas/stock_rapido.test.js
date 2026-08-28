/**
 * El editor rapido de stock y el cartel "Tenes disponible" respetan la
 * convencion de cada producto.
 *
 * Dos bugs reales del 27-08 (ALFILER ERIZO, art. secundario 987415):
 *  1. El editor rapido del inventario escribia solo el `stock` plano: la caja
 *     cargada a mano nunca entraba al conjunto y la ficha seguia mostrando el
 *     numero viejo.
 *  2. El cartel de la ficha restaba el pack abierto tambien en productos
 *     guardados con la convencion vieja (sin `conjunto_packs_cerrados`),
 *     donde `unidades` ya son los cerrados que el POS vende: mostraba
 *     64 cuando habia 112.
 */
import { describe, it, expect } from 'vitest';
import {
  camposStockRapido, formularioIncluyeAbierto, packsCerradosTipeados,
} from '../../webapp/src/conjunto.js';

describe('formularioIncluyeAbierto', () => {
  it('los productos nuevos siempre tipean packs vistos', () => {
    expect(formularioIncluyeAbierto({}, true)).toBe(true);
  });

  it('un producto que no era conjunto arranca con la regla nueva', () => {
    expect(formularioIncluyeAbierto({ es_conjunto: false }, false)).toBe(true);
  });

  it('un conjunto ya migrado usa la regla nueva', () => {
    expect(formularioIncluyeAbierto(
      { es_conjunto: true, conjunto_packs_cerrados: true }, false)).toBe(true);
  });

  it('un conjunto viejo muestra los cerrados tal cual', () => {
    expect(formularioIncluyeAbierto({ es_conjunto: true }, false)).toBe(false);
    expect(formularioIncluyeAbierto({ es_conjunto: 1 }, false)).toBe(false);
  });
});

describe('packsCerradosTipeados', () => {
  it('regla nueva: con sueltos, uno de los packs vistos es el abierto', () => {
    expect(packsCerradosTipeados(2, 16, true)).toBe(1);
    expect(packsCerradosTipeados(2, 0, true)).toBe(2);
  });

  it('regla vieja: lo tipeado ya son cerrados y no se resta nada', () => {
    // ALFILER ERIZO: 2 cajas de 48 + 16 sueltas son 112, no 64.
    expect(packsCerradosTipeados(2, 16, false)).toBe(2);
    expect(2 * 48 + 16).toBe(112);
  });

  it('nunca devuelve negativo', () => {
    expect(packsCerradosTipeados(0, 5, true)).toBe(0);
    expect(packsCerradosTipeados(-3, 0, false)).toBe(0);
  });
});

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
