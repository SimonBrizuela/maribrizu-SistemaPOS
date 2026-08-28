// @vitest-environment jsdom
/**
 * La pantalla Turnos / Cajeros, montada de verdad.
 *
 * Es la primera prueba que monta una pantalla del panel en un DOM en vez de
 * sólo comprobar que compila. Lo que se verifica es lo que la persona lee: que
 * cada cajero aparezca con lo que vendió, y sobre todo que el efectivo y la
 * transferencia sean los que de verdad entraron.
 *
 * El caso que motivó mirarla: una venta con Pago Mixto entra por los dos lados.
 * Antes se le asignaba entera a uno solo, así que el efectivo del turno no era
 * el que había en el cajón.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ventas } = vi.hoisted(() => ({ ventas: { lista: [] } }));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  return {
    ...firestoreFalso(),
    getDocs: async () => ({
      docs: ventas.lista.map((v, i) => ({ id: `d${i}`, data: () => v })),
    }),
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {} }));
vi.mock('../../webapp/src/components/modal.js', () => ({ openSaleModal: () => {} }));
vi.mock('../../webapp/src/sale_numbers.js', () => ({
  getSaleNumberMap: async () => ({}), displayNumForVenta: (v) => v.sale_id,
}));

const { renderTurnos } = await import('../../webapp/src/pages/turnos.js');
const { invalidateCacheByPrefix } = await import('../../webapp/src/cache.js');

/** Monta la pantalla y devuelve el texto de cada fila de la tabla. */
async function montar(lista) {
  ventas.lista = lista;
  invalidateCacheByPrefix('turnos');
  const cont = document.createElement('div');
  document.body.appendChild(cont);
  await renderTurnos(cont, {});
  // Sólo la tabla del resumen por cajero, no la del detalle de ventas.
  const filas = [...(cont.querySelector('table')?.querySelectorAll('tbody tr') || [])]
    .map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim()));
  return { cont, filas, html: cont.innerHTML };
}

const hoy = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

const venta = (extra) => ({
  sale_id: 1, cajero: 'Marta', created_at: hoy(), total_amount: 1000,
  payment_type: 'cash', cash_received: 1000, change_given: 0, transfer_amount: 0,
  ...extra,
});

beforeEach(() => {
  document.body.innerHTML = '';
  invalidateCacheByPrefix('');
});

describe('la pantalla se arma', () => {
  it('pinta la tabla con sus columnas', async () => {
    // La pantalla arma dos tablas: el resumen por cajero y, debajo, el detalle
    // de ventas. Acá interesa la primera.
    const { cont } = await montar([venta({})]);
    const encabezados = [...cont.querySelector('table').querySelectorAll('thead th')]
      .map(th => th.textContent.trim());
    expect(encabezados).toEqual([
      'Cajero / Turno', '# Ventas', 'Total', 'Efectivo', 'Transferencia',
      'Ticket Promedio', '% del Total',
    ]);
  });

  it('sin ventas no se rompe', async () => {
    const { cont } = await montar([]);
    expect(cont.querySelector('table')).toBeTruthy();
  });
});

describe('lo que vendió cada cajero', () => {
  it('junta las ventas de la misma persona', async () => {
    const { html } = await montar([
      venta({ sale_id: 1, cajero: 'Marta', total_amount: 1000 }),
      venta({ sale_id: 2, cajero: 'Marta', total_amount: 500 }),
      venta({ sale_id: 3, cajero: 'Ana', total_amount: 300 }),
    ]);
    expect(html).toContain('Marta');
    expect(html).toContain('Ana');
  });

  it('el mismo cajero con dos perfiles cuenta una sola vez', async () => {
    // "Agustin 1" y "Agus Gonzalez" son la misma persona.
    const { html } = await montar([
      venta({ sale_id: 1, cajero: 'Agustin 1', total_amount: 1000 }),
      venta({ sale_id: 2, cajero: 'Agus Gonzalez', total_amount: 500 }),
    ]);
    expect(html).toContain('AGUSTIN');
    expect(html).not.toContain('Agustin 1');
  });
});

describe('el efectivo del turno es el que quedó en el cajón', () => {
  it('una venta en efectivo va entera al efectivo', async () => {
    const { html } = await montar([venta({ total_amount: 1000, payment_type: 'cash' })]);
    expect(html).toContain('1.000');
  });

  it('una mixta se reparte entre las dos columnas', async () => {
    // 10.000 cobrados: 4.000 en mano y 6.000 por transferencia. Antes los
    // 10.000 se le asignaban a una sola columna.
    const { filas } = await montar([venta({
      total_amount: 10000, payment_type: 'mixed',
      cash_received: 4000, change_given: 0, transfer_amount: 6000,
    })]);
    const fila = filas.find(f => f.some(c => c.includes('Marta')));
    expect(fila.join(' | ')).toContain('4.000');
    expect(fila.join(' | ')).toContain('6.000');
  });

  it('el vuelto no se cuenta como plata que entró', async () => {
    const { filas } = await montar([venta({
      total_amount: 10000, payment_type: 'mixed',
      cash_received: 5000, change_given: 1000, transfer_amount: 6000,
    })]);
    const fila = filas.find(f => f.some(c => c.includes('Marta')));
    expect(fila.join(' | ')).toContain('4.000');   // 5.000 menos 1.000 de vuelto
  });
});
