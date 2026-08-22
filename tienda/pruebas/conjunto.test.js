/**
 * Las cuentas de un producto conjunto, lado panel.
 *
 * `webapp/src/conjunto.js` es el espejo de `pos_system/models/conjunto.py`.
 * Los casos viven en `casos_conjunto.json` y los corren las dos pruebas: si
 * una regla cambia y la otra no, acá se nota.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  packsAGuardar, packsAMostrar, repartirTotal, totalConjunto, totalVariedad,
  guardaCerrados,
} from '../../webapp/src/conjunto.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const CASOS = JSON.parse(readFileSync(join(AQUI, 'casos_conjunto.json'), 'utf-8'));

describe('packs a guardar: lo que tipea el personal pasa a packs cerrados', () => {
  for (const caso of CASOS.packs_a_guardar) {
    it(caso.nombre, () => {
      expect(packsAGuardar(caso.packs, caso.sueltos)).toBe(caso.esperado);
    });
  }
});

describe('packs a mostrar: los cerrados vuelven a verse con el abierto', () => {
  for (const caso of CASOS.packs_a_mostrar) {
    it(caso.nombre, () => {
      expect(packsAMostrar(caso.cerrados, caso.sueltos)).toBe(caso.esperado);
    });
  }
  for (const caso of CASOS.ida_y_vuelta) {
    it(caso.nombre, () => {
      const cerrados = packsAGuardar(caso.packs, caso.sueltos);
      expect(packsAMostrar(cerrados, caso.sueltos)).toBe(caso.packs);
    });
  }
});

describe('repartir un total en cerrados y sueltos', () => {
  for (const caso of CASOS.repartir_total) {
    it(caso.nombre, () => {
      const r = repartirTotal(caso.total, caso.contenido);
      expect(r.unidades).toBe(caso.unidades);
      expect(r.restante).toBe(caso.restante);
    });
  }
  it('es la inversa exacta del total', () => {
    for (const total of [0, 1, 35, 59, 60, 61, 120, 158, 328, 786]) {
      for (const contenido of [1, 10, 12, 50, 60, 250]) {
        const r = repartirTotal(total, contenido);
        expect(totalVariedad({ unidades: r.unidades, restante: r.restante }, contenido)).toBe(total);
      }
    }
  });
});

describe('total de un conjunto con variedades', () => {
  for (const caso of CASOS.total_conjunto) {
    it(caso.nombre, () => {
      expect(totalConjunto(caso.colores, caso.contenido)).toBe(caso.esperado);
    });
  }
});

describe('el pack fantasma del papel', () => {
  it('3 packs y 36 sueltas de 250 son 536 hojas, no 786', () => {
    const cerrados = packsAGuardar(3, 36);
    expect(totalVariedad({ unidades: cerrados, restante: 36 }, 250)).toBe(536);
  });
  it('al vender una hoja el formulario sigue mostrando 3 packs', () => {
    const r = repartirTotal(535, 250);
    expect(packsAMostrar(r.unidades, r.restante)).toBe(3);
  });
  it('solo los productos migrados llevan la marca', () => {
    expect(guardaCerrados({ conjunto_packs_cerrados: true })).toBe(true);
    expect(guardaCerrados({})).toBe(false);
    expect(guardaCerrados(null)).toBe(false);
  });
});
