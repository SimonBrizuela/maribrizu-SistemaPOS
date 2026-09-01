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
  repartirTotal, totalConjunto, totalVariedad,
  guardaCerrados, descontarDeTotal,
} from '../../webapp/src/conjunto.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const CASOS = JSON.parse(readFileSync(join(AQUI, 'casos_conjunto.json'), 'utf-8'));

// La traducción del estante (`packs_a_guardar` / `packs_a_mostrar`) quedó solo
// del lado Python, para la migración histórica del 31-08: el panel guarda y
// muestra literal desde esa fecha. Sus casos del JSON los corre
// `pos_system/tests/test_conjunto.py`.

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

describe('descontar de un total (lo que hace el watcher y el reconciliador)', () => {
  for (const caso of CASOS.descontar_de_total) {
    it(caso.nombre, () => {
      const r = descontarDeTotal(caso.total, caso.delta, caso.contenido);
      expect(r.total).toBe(caso.esp_total);
      expect(r.unidades).toBe(caso.unidades);
      expect(r.restante).toBe(caso.restante);
    });
  }
});

describe('total de un conjunto con variedades', () => {
  for (const caso of CASOS.total_conjunto) {
    it(caso.nombre, () => {
      expect(totalConjunto(caso.colores, caso.contenido)).toBe(caso.esperado);
    });
  }
});

describe('la carga literal del formulario', () => {
  it('2 packs cerrados y 36 sueltas de 250 son 536 hojas, tal cual se tipea', () => {
    expect(totalVariedad({ unidades: 2, restante: 36 }, 250)).toBe(536);
  });
  it('al vender una hoja quedan 2 packs cerrados y 35 sueltas', () => {
    const r = repartirTotal(535, 250);
    expect(r.unidades).toBe(2);
    expect(r.restante).toBe(35);
  });
  it('solo los productos migrados llevan la marca', () => {
    expect(guardaCerrados({ conjunto_packs_cerrados: true })).toBe(true);
    expect(guardaCerrados({})).toBe(false);
    expect(guardaCerrados(null)).toBe(false);
  });
});
