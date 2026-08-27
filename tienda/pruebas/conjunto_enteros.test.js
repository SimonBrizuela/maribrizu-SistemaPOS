/**
 * Los packs cerrados de un conjunto son SIEMPRE un numero entero, lado panel.
 *
 * Espejo de `pos_system/tests/test_conjunto_enteros.py`. La regla del conjunto
 * esta escrita dos veces (Python y JS) y este archivo cubre en el panel el
 * mismo invariante que alla: `unidades` son cajas fisicas del estante, asi que
 * 5,92 no significa nada.
 *
 * El bug que motiva esto: al vender UNA unidad suelta, un codigo viejo le
 * restaba una fraccion de pack (`packs -= 1 / contenido`) en vez de bajar una
 * suelta. El total seguia dando bien, por eso paso meses sin que nadie lo
 * viera, pero el reparto interno quedaba sin sentido y podia cruzar a negativo.
 */
import { describe, it, expect } from 'vitest';
import {
  repartirTotal, descontarDeTotal, packsAGuardar, packsAMostrar, totalVariedad,
} from '../../webapp/src/conjunto.js';

// Presentaciones reales del catalogo: 50 es la caja de boligrafos donde
// aparecio el bug, 100 el paquete de limpia pipas, 6 el blister de aros.
const CONTENIDOS = [1, 5, 6, 10, 12, 24, 25, 50, 60, 100, 250, 500];

const esEntero = v => Math.abs(Number(v) - Math.round(Number(v))) < 1e-9;

describe('repartir un total nunca deja packs fraccionarios', () => {
  for (const contenido of CONTENIDOS) {
    it(`packs de ${contenido}`, () => {
      for (let total = 0; total <= 3 * contenido + 2; total++) {
        const { unidades: packs, restante: sueltas } = repartirTotal(total, contenido);
        expect(esEntero(packs), `${total} en packs de ${contenido} dio ${packs}`).toBe(true);
        expect(packs).toBeGreaterThanOrEqual(0);
        expect(sueltas).toBeGreaterThanOrEqual(0);
        // Si las sueltas llegan al tamano del pack, es un pack cerrado.
        expect(sueltas).toBeLessThan(contenido);
      }
    });
  }
});

describe('descontar de un total mantiene los packs enteros', () => {
  for (const contenido of [6, 50, 100, 250]) {
    it(`packs de ${contenido}`, () => {
      for (const delta of [0.5, 1, 2, 7, 13, 50, 99]) {
        const { unidades } = descontarDeTotal(5 * contenido, delta, contenido);
        expect(esEntero(unidades), `delta ${delta} dio ${unidades}`).toBe(true);
        expect(unidades).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it('no baja de cero aunque se pida de mas', () => {
    const r = descontarDeTotal(10, 999, 50);
    expect(r.total).toBe(0);
    expect(r.unidades).toBe(0);
    expect(r.restante).toBe(0);
  });
});

describe('vender de a una unidad muchas veces no ensucia los packs', () => {
  it('caja de 50 vendida unidad por unidad hasta vaciarla', () => {
    const contenido = 50;
    let total = totalVariedad({ unidades: 6, restante: 9 }, contenido);
    const inicial = total;

    for (let i = 1; i <= inicial; i++) {
      const r = descontarDeTotal(total, 1, contenido);
      total = r.total;
      expect(esEntero(r.unidades), `venta ${i} dejo ${r.unidades} packs`).toBe(true);
      expect(r.unidades, `venta ${i} dejo packs negativos`).toBeGreaterThanOrEqual(0);
      expect(r.restante).toBeGreaterThanOrEqual(0);
      expect(total).toBe(inicial - i);
      // El invariante que nunca se rompio, por si acaso.
      expect(totalVariedad({ unidades: r.unidades, restante: r.restante }, contenido)).toBe(total);
    }
    expect(total).toBe(0);
  });
});

describe('los valores rotos que quedaron en el catalogo', () => {
  // Tal cual estaban guardados en Firestore antes de corregirlos a mano.
  const ROTOS = [
    ['BIC 1 MM Azul', 5.92, 9, 50],
    ['BIC 1 MM Roja', -0.06000000000000005, 21, 50],
    ['BIC 1 MM Verde', 0.8400000000000001, 35, 50],
    ['BIC 1 MM Negra', 3.6999999999999993, 40, 50],
    ['LIMPIA PIPA CBX', 105.12, 1136, 100],
    ['ACCESORIO ARO', 3.666666666666667, 0, 6],
    ['PAPEL ILUSTRACION', 0.98, 0, 250],
  ];

  for (const [nombre, packs, sueltas, contenido] of ROTOS) {
    it(`${nombre}: repartir de nuevo arregla el reparto sin mover el total`, () => {
      const total = totalVariedad({ unidades: packs, restante: sueltas }, contenido);
      const { unidades: nuevosPacks, restante: nuevasSueltas } = repartirTotal(total, contenido);

      expect(esEntero(nuevosPacks)).toBe(true);
      expect(nuevosPacks).toBeGreaterThanOrEqual(0);
      expect(nuevasSueltas).toBeLessThan(contenido);
      // No se inventa ni se pierde mercaderia. Con tolerancia porque el valor
      // guardado ya venia con ruido de float (-0,06 x 50 + 21 da 17,99999...),
      // y repartirTotal justamente lo limpia al redondear.
      expect(totalVariedad({ unidades: nuevosPacks, restante: nuevasSueltas }, contenido))
        .toBeCloseTo(total, 6);
    });
  }

  it('la variedad Roja escondia 3 unidades vendidas de mas', () => {
    // -0,06 packs de 50 son -3 unidades, tapadas por un total de 18 positivo.
    expect(totalVariedad({ unidades: -0.06, restante: 21 }, 50)).toBe(18);
    expect(-0.06 * 50).toBe(-3);
  });

  it('Azul quedo con 52 sueltas en packs de 50: son 13 packs y 2', () => {
    const total = totalVariedad({ unidades: 12, restante: 52 }, 50);
    expect(total).toBe(652);
    const r = repartirTotal(total, 50);
    expect(r.unidades).toBe(13);
    expect(r.restante).toBe(2);
  });
});

describe('lo que tipea el personal tampoco queda fraccionario', () => {
  it('packsAGuardar con enteros devuelve enteros', () => {
    for (let vistos = 0; vistos < 30; vistos++) {
      for (const sueltos of [0, 1, 7, 49]) {
        expect(esEntero(packsAGuardar(vistos, sueltos))).toBe(true);
      }
    }
  });

  it('packsAMostrar con enteros devuelve enteros', () => {
    for (let cerrados = 0; cerrados < 30; cerrados++) {
      for (const sueltos of [0, 1, 7, 49]) {
        expect(esEntero(packsAMostrar(cerrados, sueltos))).toBe(true);
      }
    }
  });

  it('packsAGuardar nunca es negativo', () => {
    expect(packsAGuardar(0, 36)).toBe(0);
    expect(packsAGuardar(-5, 36)).toBe(0);
  });
});
