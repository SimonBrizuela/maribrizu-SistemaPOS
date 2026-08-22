/**
 * El nombre con que la tienda muestra lo que el catálogo guarda en mayúsculas.
 *
 * La regla está escrita dos veces (panel en JS, sync en Python) y los casos
 * viven en `casos_nombre_bonito.json`: si una cambia sola, la tienda muestra un
 * nombre hasta que corre el sync y otro después.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { nombreBonito } from '../../webapp/src/tienda_espejo.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const { casos } = JSON.parse(readFileSync(join(AQUI, 'casos_nombre_bonito.json'), 'utf-8'));

describe('nombreBonito', () => {
  for (const c of casos) {
    it(c.que, () => {
      expect(nombreBonito(c.entrada)).toBe(c.salida);
    });
  }
  it('es estable: aplicarlo al resultado en mayúsculas devuelve lo mismo', () => {
    for (const c of casos) {
      expect(nombreBonito(c.salida.toUpperCase())).toBe(c.salida);
    }
  });
});
