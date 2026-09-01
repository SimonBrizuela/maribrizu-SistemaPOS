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
  mpPorCuentaAlDia, mesSiguiente,
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
    // Agosto sin días ni saldos propios pasa de largo: la caja se nombra por el
    // mes que tiene los datos (antes decía "al cierre de Agosto" con 0 días).
    expect(caja.ym).toBe('2026-07');
    expect(caja.dd).toBe(null);
    expect(caja.esApertura).toBe(false);
    expect(caja.saldos.mp).toBe(4707864.02);
  });
  it('el mes en curso con apertura contada a mano y sin días es la caja, marcada como apertura', () => {
    const docsAp = { ...docs, '2026-08': { apertura: { efectivo: 2779000, mp: 979627, lapos: 1085218 }, dias: {} } };
    const caja = cajaAlDia(cadenaMeses({ meses: ['2026-06', '2026-07', '2026-08'], tipeados, docs: docsAp, hoy: HOY }), HOY);
    expect(caja.ym).toBe('2026-08');
    expect(caja.dd).toBe(null);
    expect(caja.esApertura).toBe(true);
    expect(caja.saldos).toEqual({ efectivo: 2779000, mp: 979627, lapos: 1085218, sin: 0 });
  });
  it('con días cargados en el mes en curso, la caja vuelve a ser el acumulado y no la apertura', () => {
    const caja = cajaAlDia(cad, HOY);
    expect(caja.esApertura).toBe(false);
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

describe('la plata de cada Mercado Pago hoy (mpPorCuentaAlDia)', () => {
  // El caso real del 01-09: cierre de agosto contado a mano con el desglose,
  // y septiembre va sumando lo que se carga en el Día por día.
  const baseYm = '2026-08';
  const baseMp = { 'MP JOSE': 622594, 'MP AGUSTIN': 357033 };
  const docs = {
    '2026-08': { dias: { '31': dia([ing('MP JOSE', 'mp', 99999)]) } },   // anterior al cierre: no cuenta
    '2026-09': { dias: {
      '01': dia([ing('MP JOSE', 'mp', 1000), ing('MP AGUSTIN', 'mp', 500), ing('Caja hoy', 'efectivo', 777)],
                [com('Luz', 'Gastos fijos', 'mp', 200, 'MP JOSE')]),
      '02': dia([ing('mp jose', 'mp', 100)], [com('Papelera', 'Papelera', 'mp', 50)]),
    } },
  };

  it('mesSiguiente cruza el año', () => {
    expect(mesSiguiente('2026-08')).toBe('2026-09');
    expect(mesSiguiente('2026-12')).toBe('2027-01');
  });
  it('cada cuenta arranca del cierre fijado y suma solo lo posterior', () => {
    const r = mpPorCuentaAlDia({ baseYm, baseMp, docs, hoy: '2026-09-02' });
    const por = Object.fromEntries(r.cuentas.map(c => [c.clave, c]));
    expect(r.desde).toBe('2026-09-01');
    expect(por['mp:MP JOSE']).toEqual({ clave: 'mp:MP JOSE', nombre: 'MP JOSE', base: 622594, ingresos: 1100, egresos: 200, saldo: 623494 });
    expect(por['mp:MP AGUSTIN'].saldo).toBe(357533);
    // La compra MP sin cuenta va a su propio renglón, no desaparece.
    expect(por['mp:'].saldo).toBe(-50);
    expect(r.total).toBe(623494 + 357533 - 50);
  });
  it('una cuenta del cierre sin movimientos igual aparece, con su base', () => {
    const r = mpPorCuentaAlDia({ baseYm, baseMp, docs: {}, hoy: '2026-09-02' });
    expect(r.cuentas.map(c => [c.nombre, c.saldo])).toEqual([['MP JOSE', 622594], ['MP AGUSTIN', 357033]]);
  });
  it('el efectivo y lapos no se cuelan en el desglose MP', () => {
    const r = mpPorCuentaAlDia({ baseYm, baseMp, docs, hoy: '2026-09-02' });
    expect(r.cuentas.every(c => c.clave.startsWith('mp:'))).toBe(true);
  });
  it('sin base suma solo el período (reparto, no plata total)', () => {
    const r = mpPorCuentaAlDia({ baseYm: null, baseMp: {}, docs, hoy: '2026-09-02' });
    const por = Object.fromEntries(r.cuentas.map(c => [c.clave, c]));
    expect(r.desde).toBe(null);
    expect(por['mp:MP JOSE'].saldo).toBe(99999 + 1100 - 200);
  });
});
