/**
 * El POS y el panel tienen que repartir la plata IGUAL.
 *
 * `pos_system/utils/medios_de_pago.py` (Python, corre en la PC del local y sube
 * el cierre a `cierres_caja`) y `webapp/src/medios_de_pago.js` (JavaScript,
 * corre en el panel y recalcula el cierre desde `ventas_por_dia`) deciden los
 * dos cuánta plata de una caja entró en efectivo y cuánta por transferencia. Si
 * se separan, el ticket de cierre dice un número y la pantalla otro, y no hay
 * forma de saber cuál de los dos mirar.
 *
 * Esta prueba corre las dos sobre los mismos casos y las compara. Es la única
 * forma de que la duplicación sea segura.
 *
 * Lo que está en juego: una venta con Pago Mixto cobra una parte en mano y otra
 * por transferencia. Contarla entera como efectivo hacía que el cierre pidiera
 * en el cajón una plata que había entrado por el banco.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  etiquetaDePago, partesDeVenta, repartirSubtotales, repartoDeItem, resumirItems,
} from '../../webapp/src/medios_de_pago.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..', '..');

const casos = JSON.parse(readFileSync(join(AQUI, 'casos_medios_pago.json'), 'utf-8'));

let delPos = null;   // lo que decidió Python
let porQueNo = '';

beforeAll(() => {
  // Sin Python no se puede comparar. No se falla la prueba por eso: en una
  // máquina sin Python el resto de la suite tiene que poder correr igual.
  for (const python of ['python', 'python3', 'py']) {
    try {
      const salida = execFileSync(python, [join(RAIZ, 'scripts', 'casos_medios_pago.py')],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      delPos = JSON.parse(salida);
      break;
    } catch (err) {
      porQueNo = String(err?.stderr || err?.message || err).split('\n').slice(-6).join('\n');
    }
  }
});

describe('el reparto del panel contra el del POS', () => {
  it('corre el POS para comparar', () => {
    if (!delPos) console.warn(`\n  [medios de pago] sin comparación contra Python:\n${porQueNo}\n`);
    expect(casos.ventas.length).toBeGreaterThan(0);
  });

  casos.ventas.forEach((caso, i) => {
    it(`venta · ${caso.que_prueba}`, () => {
      const mio = partesDeVenta(caso.venta);
      if (!delPos) return;
      const suyo = delPos.ventas[i];
      expect(suyo.que_prueba).toBe(caso.que_prueba);
      expect(mio.efectivo).toBeCloseTo(suyo.efectivo, 2);
      expect(mio.transferencia).toBeCloseTo(suyo.transferencia, 2);
    });
  });

  casos.repartos.forEach((caso, i) => {
    it(`reparto · ${caso.que_prueba}`, () => {
      const mio = repartirSubtotales(caso.subtotales, caso.efectivo, caso.transferencia);
      if (!delPos) return;
      const suyo = delPos.repartos[i];
      expect(suyo.que_prueba).toBe(caso.que_prueba);
      expect(mio.length).toBe(suyo.partes.length);
      mio.forEach((parte, j) => {
        expect(parte.efectivo).toBeCloseTo(suyo.partes[j].efectivo, 2);
        expect(parte.transferencia).toBeCloseTo(suyo.partes[j].transferencia, 2);
      });
    });
  });

  casos.items.forEach((caso, i) => {
    it(`renglón · ${caso.que_prueba}`, () => {
      const mio = repartoDeItem(caso.item);
      if (!delPos) return;
      const suyo = delPos.items[i];
      expect(suyo.que_prueba).toBe(caso.que_prueba);
      expect(mio.efectivo).toBeCloseTo(suyo.efectivo, 2);
      expect(mio.transferencia).toBeCloseTo(suyo.transferencia, 2);
    });
  });

  casos.cajas.forEach((caso, i) => {
    it(`caja · ${caso.que_prueba}`, () => {
      const mio = resumirItems(caso.items);
      if (!delPos) return;
      const suyo = delPos.cajas[i];
      expect(suyo.que_prueba).toBe(caso.que_prueba);
      expect(mio.efectivo).toBeCloseTo(suyo.efectivo, 2);
      expect(mio.transferencia).toBeCloseTo(suyo.transferencia, 2);
      expect(mio.numVentasEfectivo).toBe(suyo.num_ventas_efectivo);
      expect(mio.numVentasTransferencia).toBe(suyo.num_ventas_transferencia);
      expect(mio.transacciones).toBe(suyo.transacciones);
      expect([...mio.ventas].sort()).toEqual(suyo.ventas);
    });
  });

  it('la etiqueta del medio de pago es la misma en los dos lados', () => {
    if (!delPos) return;
    for (const { payment_type: pt, etiqueta } of delPos.etiquetas) {
      expect(etiquetaDePago(pt)).toBe(etiqueta);
    }
  });
});

/*
 * Lo de abajo no depende de Python: son las cuentas que tienen que dar sí o sí,
 * escritas a mano. Si el generador de casos se rompe, esto sigue defendiendo el
 * comportamiento.
 */
describe('las cuentas que no pueden fallar', () => {
  it('una mixta no cuenta como efectivo la parte que entró por el banco', () => {
    const { efectivo, transferencia } = partesDeVenta({
      payment_type: 'mixed', total_amount: 10000, cash_received: 4000, transfer_amount: 6000,
    });
    expect(efectivo).toBe(4000);
    expect(transferencia).toBe(6000);
  });

  it('el vuelto sale del cajón: no es plata que entró', () => {
    const { efectivo } = partesDeVenta({
      payment_type: 'cash', total_amount: 5000, cash_received: 10000, change_given: 5000,
    });
    expect(efectivo).toBe(5000);
  });

  it('una mixta sin desglose no inventa efectivo en el cajón', () => {
    // Errar para este lado deja un sobrante que se ve. Para el otro, manda a
    // contar la caja tres veces buscando algo que no falta.
    expect(repartoDeItem({ tipo_pago: 'Mixto', subtotal: 3000 }))
      .toEqual({ efectivo: 0, transferencia: 3000 });
  });

  it('un renglón viejo sin tipo de pago se sigue contando como efectivo', () => {
    // No se toca el pasado: los cierres de meses anteriores tienen que seguir
    // dando lo mismo que dieron cuando se firmaron.
    expect(repartoDeItem({ subtotal: 800 })).toEqual({ efectivo: 800, transferencia: 0 });
  });

  it('el prorrateo no pierde ni inventa un centavo', () => {
    const partes = repartirSubtotales([1, 1, 1], 1, 2);
    const sumaEf = partes.reduce((t, p) => t + p.efectivo, 0);
    const sumaTr = partes.reduce((t, p) => t + p.transferencia, 0);
    expect(sumaEf).toBeCloseTo(1, 10);
    expect(sumaTr).toBeCloseTo(2, 10);
  });

  it('las transacciones son ventas distintas, no la suma de las dos listas', () => {
    // La mixta aporta a las dos columnas; contarla dos veces daría 3 ventas
    // donde hubo 2.
    const r = resumirItems([
      { pc_id: 'PC1', num_venta: 1, tipo_pago: 'Efectivo', subtotal: 100 },
      { pc_id: 'PC1', num_venta: 2, tipo_pago: 'Mixto', subtotal: 200, monto_efectivo: 80, monto_transferencia: 120 },
    ]);
    expect(r.numVentasEfectivo).toBe(2);
    expect(r.numVentasTransferencia).toBe(1);
    expect(r.transacciones).toBe(2);
  });
});
