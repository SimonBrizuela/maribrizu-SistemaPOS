/**
 * El panel y la caja tienen que descontar IGUAL el stock de un pedido.
 *
 * `webapp/src/pedido_venta.js` (el botón "Entregado" del panel) y
 * `pos_system/models/pedido_tienda.py` (la caja, que entrega en el mostrador y
 * descuenta lo que entregó el repartidor) escriben el mismo catálogo. Si se
 * separan, el mismo pedido deja otro stock según quién lo entregó, y no hay
 * forma de saberlo mirando el número.
 *
 * Corre las dos sobre `casos_pedido_venta.json` y las compara campo por campo.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { planDescuento } from '../../webapp/src/pedido_venta.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..', '..');

const casos = JSON.parse(readFileSync(join(AQUI, 'casos_pedido_venta.json'), 'utf-8'));

let delPos = null;
let porQueNo = '';

beforeAll(() => {
  for (const python of ['python', 'python3', 'py']) {
    try {
      const salida = execFileSync(python, [join(RAIZ, 'scripts', 'casos_pedido_venta.py')],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      delPos = JSON.parse(salida);
      break;
    } catch (err) {
      porQueNo = String(err?.stderr || err?.message || err).split('\n').slice(-6).join('\n');
    }
  }
});

/** Lo que se escribe y lo que se anota; `datos` es la copia de trabajo del panel. */
function comparable(plan) {
  return {
    productos: plan.productos.map(p => ({
      id: p.id, nombre: p.nombre, saltado: p.saltado ?? null, campos: p.campos, movimientos: p.movimientos,
    })),
    saltados: plan.saltados,
  };
}

describe('el stock de un pedido: panel contra caja', () => {
  it('corre la caja para comparar', () => {
    if (!delPos) console.warn(`\n  [pedido venta] sin comparación contra Python:\n${porQueNo}\n`);
    expect(casos.plan.length).toBeGreaterThan(0);
    // Sin Python en la máquina no se compara, pero en esta PC tiene que haber.
    if (process.env.EXIGIR_PYTHON === '1') expect(delPos).not.toBe(null);
  });

  casos.plan.forEach((caso, i) => {
    it(caso.que_prueba, () => {
      const catalogo = JSON.parse(JSON.stringify(caso.catalogo));
      const mio = comparable(planDescuento(caso.items, catalogo));
      if (!delPos) return;
      expect(delPos.plan[i].que_prueba).toBe(caso.que_prueba);
      expect(delPos.plan[i].plan).toEqual(mio);
    });
  });
});
