/**
 * La cadena de saldos del Balance y la plata por cuenta.
 *
 * `webapp/src/balance_cadena.js` no toca Firebase ni el DOM. Acá se fija la
 * regla "lo tipeado manda y lo que falta se calcula" con los casos reales del
 * 2026-08-22: junio con cierre tipeado, julio con apertura tipeada y días,
 * agosto sin apertura y con días cargados hasta el 22.
 */
import { describe, it, expect } from 'vitest';
import {
  cadenaMeses, cajaAlDia, netoDia, netoMes, rangoMeses, diaCargado,
  cuentasDelPeriodo, cuentaDeIngreso, cuentaDeCompra, etiquetaCuenta, cuentasMpDe,
} from '../../webapp/src/balance_cadena.js';

const dia = (ingresos, compras = []) => ({ ingresos, compras });
const ing = (motivo, medio, monto) => ({ motivo, medio, monto });
const com = (proveedor, rubro, medio, monto, cuenta) => ({ proveedor, rubro, medio, monto, ...(cuenta ? { cuenta } : {}) });

describe('neto de un día y de un mes', () => {
  it('resta compras a ingresos por medio, y lo sin medio va aparte', () => {
    const d = dia([ing('Caja hoy', 'efectivo', 1000), ing('MP JOSE', 'mp', 500), ing('x', '', 20)],
                  [com('Anita', 'Sueldos', 'efectivo', 300), com('Luz', 'Gastos fijos', 'mp', 100)]);
    expect(netoDia(d)).toEqual({ efectivo: 700, mp: 400, lapos: 0, sin: 20 });
  });
  it('un día plantilla (todo en cero) no cuenta como cargado', () => {
    expect(diaCargado(dia([ing('Caja hoy', 'efectivo', 0)]))).toBe(false);
    expect(diaCargado(dia([], [com('x', 'y', 'efectivo', 0)]))).toBe(true);
    expect(diaCargado(null)).toBe(false);
  });
  it('netoMes suma solo hasta el día pedido y cuenta los cargados', () => {
    const dias = { '01': dia([ing('c', 'efectivo', 100)]), '02': dia([ing('c', 'efectivo', 0)]), '03': dia([ing('c', 'lapos', 50)]) };
    expect(netoMes(dias, '02')).toEqual({ neto: { efectivo: 100, mp: 0, lapos: 0, sin: 0 }, cargados: 1, ultDd: '01' });
    expect(netoMes(dias).cargados).toBe(2);
    expect(netoMes(dias).ultDd).toBe('03');
  });
  it('rangoMeses cruza el año', () => {
    expect(rangoMeses('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('la cadena de meses', () => {
  const HOY = '2026-08-22';
  const tipeados = { '2026-06': { efectivo: 4721931.61, mp: 7578062.3, lapos: 1937097 } };
  const docs = {
    '2026-06': { apertura: { efectivo: 2879224.61, mp: 7764835.48, lapos: 2018937 }, dias: { '01': dia([ing('Caja hoy', 'efectivo', 100)]) } },
    '2026-07': { apertura: { efectivo: 1405040, mp: 4707364.02, lapos: 707885.7 },
                 dias: { '01': dia([ing('Caja hoy', 'efectivo', 1000), ing('MP JOSE', 'mp', 500)], [com('a', 'b', 'lapos', 200)]) } },
    '2026-08': { apertura: null,
                 dias: { '01': dia([ing('Caja hoy', 'efectivo', 300)]), '22': dia([ing('MP AGUSTIN', 'mp', 50)], [com('Anita', 'Sueldos', 'efectivo', 100)]) } },
  };
  const cad = cadenaMeses({ meses: ['2026-06', '2026-07', '2026-08'], tipeados, docs, hoy: HOY });

  it('un mes pasado con saldos tipeados cierra con lo tipeado, no con lo calculado', () => {
    expect(cad['2026-06'].cierreOrigen).toBe('tipeado');
    expect(cad['2026-06'].cierre.mp).toBe(7578062.3);
  });
  it('la apertura tipeada manda aunque no coincida con el cierre anterior', () => {
    expect(cad['2026-07'].aperturaOrigen).toBe('tipeada');
    expect(cad['2026-07'].apertura.mp).toBe(4707364.02);
  });
  it('sin saldos tipeados el cierre es apertura + días', () => {
    expect(cad['2026-07'].cierreOrigen).toBe('calculado');
    expect(cad['2026-07'].cierre).toEqual({ efectivo: 1406040, mp: 4707864.02, lapos: 707685.7, sin: 0 });
  });
  it('sin apertura tipeada el mes arranca del cierre del anterior', () => {
    expect(cad['2026-08'].aperturaOrigen).toBe('cierre_anterior');
    expect(cad['2026-08'].apertura.mp).toBe(4707864.02);
    expect(cad['2026-08'].cierre.efectivo).toBe(1406040 + 300 - 100);
    expect(cad['2026-08'].ultDd).toBe('22');
    expect(cad['2026-08'].cargados).toBe(2);
  });
  it('la caja de hoy es el acumulado del mes en curso al último día cargado', () => {
    const caja = cajaAlDia(cad, HOY);
    expect(caja.ym).toBe('2026-08');
    expect(caja.dd).toBe('22');
    expect(caja.origen).toBe('calculado');
    expect(caja.total).toBe(1406240 + 4707914.02 + 707685.7);
  });
  it('si el mes en curso no tiene días, la caja es el cierre del mes anterior', () => {
    const c2 = cadenaMeses({ meses: ['2026-06', '2026-07', '2026-08'], tipeados, docs: { ...docs, '2026-08': null }, hoy: HOY });
    const caja = cajaAlDia(c2, HOY);
    // Agosto sin días hereda el cierre de julio como apertura y como cierre (nada se movió).
    expect(caja.ym).toBe('2026-08');
    expect(caja.dd).toBe(null);
    expect(caja.saldos.mp).toBe(4707864.02);
  });
  it('sin nada de dónde arrancar, el mes queda sin cierre y no rompe los que siguen', () => {
    const c3 = cadenaMeses({ meses: ['2026-07', '2026-08'], tipeados: {}, docs: { '2026-07': { dias: docs['2026-07'].dias }, '2026-08': docs['2026-08'] }, hoy: HOY });
    expect(c3['2026-07'].cierreOrigen).toBe('ninguno');
    expect(c3['2026-08'].aperturaOrigen).toBe('ninguna');
    expect(cajaAlDia(c3, HOY)).toBe(null);
  });
  it('saldos tipeados en el mes en curso pierden contra los días cargados', () => {
    const c4 = cadenaMeses({ meses: ['2026-07', '2026-08'], tipeados: { ...tipeados, '2026-08': { efectivo: 1, mp: 1, lapos: 1 } }, docs, hoy: HOY });
    expect(c4['2026-08'].cierreOrigen).toBe('calculado');
  });
});

describe('la plata por cuenta', () => {
  const docs = {
    '2026-08': { dias: {
      '01': dia([ing('Caja hoy', 'efectivo', 1000), ing('MP JOSE', 'mp', 500), ing('MP AGUSTIN', 'mp', 700), ing('Lapos', 'lapos', 200)],
                [com('Anita', 'Sueldos', 'efectivo', 300), com('Luz', 'Gastos fijos', 'mp', 100, 'MP JOSE'), com('Papelera', 'Papelera', 'mp', 50)]),
      '02': dia([ing('mp jose ', 'mp', 100)], [com('Anita', 'Sueldos', 'efectivo', 300)]),
      '03': dia([ing('Caja hoy', 'efectivo', 0)]),
    } },
    '2026-09': { dias: { '01': dia([ing('Caja hoy', 'efectivo', 99999)]) } },
  };
  const r = cuentasDelPeriodo({ docs, desde: '2026-08-01', hasta: '2026-08-31' });

  it('clasifica por cuenta: MP por nombre del motivo, compras MP por `cuenta`', () => {
    expect(cuentaDeIngreso(ing('MP JOSE', 'mp', 1))).toBe('mp:MP JOSE');
    expect(cuentaDeIngreso(ing('mp  jose ', 'mp', 1))).toBe('mp:MP JOSE');
    expect(cuentaDeIngreso(ing('Caja hoy', 'efectivo', 1))).toBe('efectivo');
    expect(cuentaDeCompra(com('x', 'y', 'mp', 1, 'MP JOSE'))).toBe('mp:MP JOSE');
    expect(cuentaDeCompra(com('x', 'y', 'mp', 1))).toBe('mp:');
    expect(etiquetaCuenta('mp:')).toBe('Mercado Pago (sin asignar)');
    expect(etiquetaCuenta('mp:MP AGUSTIN')).toBe('MP AGUSTIN');
  });
  it('suma ingresos y egresos por cuenta dentro del período', () => {
    const por = Object.fromEntries(r.cuentas.map(c => [c.clave, c]));
    expect(por['efectivo'].ingresos).toBe(1000);
    expect(por['efectivo'].egresos).toBe(600);
    expect(por['efectivo'].neto).toBe(400);
    expect(por['mp:MP JOSE'].ingresos).toBe(600);
    expect(por['mp:MP JOSE'].egresos).toBe(100);
    expect(por['mp:MP AGUSTIN'].ingresos).toBe(700);
    expect(por['mp:'].egresos).toBe(50);
    expect(por['lapos'].ingresos).toBe(200);
    expect(r.dias).toBe(2);
  });
  it('el detalle agrupa por motivo, rubro y proveedor', () => {
    const ef = r.cuentas.find(c => c.clave === 'efectivo');
    expect(ef.ingPorMotivo).toEqual([{ motivo: 'Caja hoy', total: 1000, veces: 1 }]);
    expect(ef.egrPorRubro).toEqual([{ rubro: 'Sueldos', total: 600, veces: 2 }]);
    expect(ef.egrPorProveedor).toEqual([{ proveedor: 'Anita', total: 600, veces: 2 }]);
    expect(ef.movimientos[0].iso).toBe('2026-08-02');   // del más nuevo al más viejo
  });
  it('los totales por medio juntan todas las cuentas MP', () => {
    expect(r.porMedio.mp).toEqual({ ingresos: 1300, egresos: 150, neto: 1150 });
  });
  it('las cuentas MP conocidas salen de los ingresos', () => {
    expect(cuentasMpDe(docs)).toEqual(['MP AGUSTIN', 'MP JOSE']);
  });
});
