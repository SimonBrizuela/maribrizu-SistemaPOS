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
    expect(r.porMedio.mp).toEqual({ ingresos: 1300, egresos: 150, cambios: 0, neto: 1150 });
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
    expect(por['mp:MP JOSE']).toEqual({ clave: 'mp:MP JOSE', nombre: 'MP JOSE', base: 622594, ingresos: 1100, egresos: 200, cambios: 0, saldo: 623494 });
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

describe('cambios entre cuentas', () => {
  // Le dieron 150.000 en efectivo y los devolvió por transferencia desde
  // MP JOSE: el efectivo sube, MP JOSE baja y el total queda igual.
  const cambio = (de, a, monto, extra = {}) => ({ de, a, monto, ...extra });
  const conCambio = {
    ingresos: [ing('Caja hoy', 'efectivo', 100000), ing('MP JOSE', 'mp', 40000)],
    compras: [com('Luz', 'Gastos fijos', 'mp', 10000, 'MP JOSE')],
    cambios: [cambio('mp', 'efectivo', 150000, { de_cuenta: 'MP JOSE', nota: 'cambio a Pedro' })],
  };

  it('mueve la plata de un medio al otro sin tocar el total', () => {
    const n = netoDia(conCambio);
    expect(n).toEqual({ efectivo: 250000, mp: -120000, lapos: 0, sin: 0 });
    expect(n.efectivo + n.mp + n.lapos + n.sin).toBe(130000);   // 140.000 − 10.000
  });
  it('un día con solo un cambio cuenta como cargado; con monto cero, no', () => {
    expect(diaCargado({ ingresos: [], compras: [], cambios: [cambio('efectivo', 'lapos', 500)] })).toBe(true);
    expect(diaCargado({ ingresos: [], compras: [], cambios: [cambio('efectivo', 'lapos', 0)] })).toBe(false);
  });
  it('en la cadena el cierre del mes lo refleja y el total no cambia', () => {
    const docs = { '2026-09': { apertura: { efectivo: 1000, mp: 5000, lapos: 0 }, dias: { '02': conCambio } } };
    const c = cadenaMeses({ meses: ['2026-09'], docs, hoy: '2026-09-02' })['2026-09'];
    expect(c.cierre).toEqual({ efectivo: 251000, mp: -115000, lapos: 0, sin: 0 });
  });
  it('por cuenta: sale de MP JOSE y entra en Efectivo, sin sumar ingresos ni egresos', () => {
    const r = cuentasDelPeriodo({ docs: { '2026-09': { dias: { '02': conCambio } } }, desde: '2026-09-01', hasta: '2026-09-30' });
    const ef = r.cuentas.find(c => c.clave === 'efectivo');
    const jose = r.cuentas.find(c => c.clave === 'mp:MP JOSE');
    expect(ef).toMatchObject({ ingresos: 100000, egresos: 0, cambios: 150000, neto: 250000 });
    expect(jose).toMatchObject({ ingresos: 40000, egresos: 10000, cambios: -150000, neto: -120000 });
    expect(r.porMedio.efectivo).toEqual({ ingresos: 100000, egresos: 0, cambios: 150000, neto: 250000 });
    expect(r.porMedio.mp).toEqual({ ingresos: 40000, egresos: 10000, cambios: -150000, neto: -120000 });
    // Cada cuenta ve el movimiento con la otra punta y la nota.
    expect(ef.movimientos.find(m => m.tipo === 'cambio')).toMatchObject({ iso: '2026-09-02', monto: 150000, contra: 'MP JOSE', nota: 'cambio a Pedro' });
    expect(jose.movimientos.find(m => m.tipo === 'cambio')).toMatchObject({ monto: -150000, contra: 'Efectivo' });
  });
  it('la caja por cuenta de Mercado Pago descuenta lo que salió por cambio', () => {
    const det = mpPorCuentaAlDia({
      baseYm: '2026-08', baseMp: { 'MP JOSE': 622594, 'MP AGUSTIN': 357033 },
      docs: { '2026-09': { dias: { '02': conCambio } } }, hoy: '2026-09-02',
    });
    const jose = det.cuentas.find(c => c.clave === 'mp:MP JOSE');
    expect(jose).toMatchObject({ base: 622594, ingresos: 40000, egresos: 10000, cambios: -150000, saldo: 502594 });
    expect(det.cuentas.find(c => c.clave === 'mp:MP AGUSTIN').saldo).toBe(357033);
    expect(det.total).toBe(859627);
  });
  it('un cambio entre dos cuentas de Mercado Pago no mueve el medio, solo las cuentas', () => {
    const d = { ingresos: [], compras: [], cambios: [cambio('mp', 'mp', 20000, { de_cuenta: 'MP JOSE', a_cuenta: 'MP AGUSTIN' })] };
    expect(netoDia(d)).toEqual({ efectivo: 0, mp: 0, lapos: 0, sin: 0 });
    const r = cuentasDelPeriodo({ docs: { '2026-09': { dias: { '02': d } } }, desde: '2026-09-01', hasta: '2026-09-30' });
    expect(r.cuentas.find(c => c.clave === 'mp:MP JOSE').cambios).toBe(-20000);
    expect(r.cuentas.find(c => c.clave === 'mp:MP AGUSTIN').cambios).toBe(20000);
    expect(r.porMedio.mp.cambios).toBe(0);
  });
});
