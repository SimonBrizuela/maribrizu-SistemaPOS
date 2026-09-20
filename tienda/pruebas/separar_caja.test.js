/**
 * Separar una caja que juntó dos días.
 *
 * Pasa cuando la caja se abre a la noche y nadie la cierra al otro día: la fila
 * de Cierres muestra un día con la plata de dos y el conteo de esa noche no
 * cierra contra nada. Separarla mueve plata de verdad entre cajas, así que lo
 * que se prueba acá es que:
 *
 *   · el corte caiga donde tiene que caer (una caja que abre 20:30 y vende al
 *     otro día es lo NORMAL y no se toca);
 *   · las partes sumen exactamente la caja entera, hasta el centavo;
 *   · no se pise un número de caja que ya esté usado — ni por un cierre, ni por
 *     ventas viejas que nunca subieron su cierre;
 *   · los renglones borrados y los VARIOS 2 se muden igual que los demás: si
 *     quedan apuntando a la caja vieja, el próximo recálculo los suma donde no
 *     van;
 *   · si se corta a la mitad, retomarla termine en el mismo lugar.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ── Una base en memoria que entiende `where(campo == valor)` ─────────────── */

const nube = vi.hoisted(() => ({ col: {}, lotes: 0 }));

vi.mock('firebase/firestore', () => {
  const borrar = { _borrar: true };
  const coleccion = (nombre) => (nube.col[nombre] = nube.col[nombre] || {});
  const aplicar = (ref, datos, { merge }) => {
    const col = coleccion(ref._col);
    const base = merge ? { ...(col[ref.id] || {}) } : {};
    for (const [k, v] of Object.entries(datos)) {
      if (v && v._borrar) delete base[k];
      else base[k] = v;
    }
    col[ref.id] = base;
  };
  const cumple = (datos, partes) => (partes || [])
    .filter(p => p && p.campo !== undefined)
    .every(p => datos[p.campo] === p.valor);

  return {
    collection: (_db, nombre) => ({ _col: nombre }),
    doc: (_db, col, id) => ({ _col: col, id: String(id) }),
    query: (col, ...partes) => ({ _col: col._col, partes }),
    where: (campo, op, valor) => ({ campo, op, valor }),
    orderBy: (campo, dir) => ({ _orden: campo, dir }),
    limit: (n) => ({ _limite: n }),
    getDocs: async (q) => {
      const col = coleccion(q._col);
      const docs = Object.entries(col)
        .filter(([, datos]) => cumple(datos, q.partes))
        .map(([id, datos]) => ({ id, data: () => datos, exists: () => true }));
      return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
    },
    getDoc: async (ref) => {
      const datos = coleccion(ref._col)[ref.id];
      return { id: ref.id, exists: () => datos !== undefined, data: () => datos };
    },
    setDoc: async (ref, datos, opciones = {}) => aplicar(ref, datos, { merge: opciones.merge === true }),
    updateDoc: async (ref, datos) => {
      if (coleccion(ref._col)[ref.id] === undefined) throw new Error('no existe el documento');
      aplicar(ref, datos, { merge: true });
    },
    deleteDoc: async (ref) => { delete coleccion(ref._col)[ref.id]; },
    writeBatch: () => {
      const ops = [];
      return {
        set: (ref, datos, opciones = {}) => ops.push(() => aplicar(ref, datos, { merge: opciones.merge === true })),
        update: (ref, datos) => ops.push(() => aplicar(ref, datos, { merge: true })),
        delete: (ref) => ops.push(() => { delete coleccion(ref._col)[ref.id]; }),
        commit: async () => { nube.lotes++; ops.forEach(fn => fn()); },
      };
    },
    deleteField: () => borrar,
    Timestamp: {
      fromDate: (d) => ({ _ts: true, toDate: () => d, seconds: Math.floor(d.getTime() / 1000) }),
      now: () => ({ toDate: () => new Date() }),
    },
    onSnapshot: () => () => {},
    runTransaction: async (_db, fn) => fn({ get: async () => ({ exists: () => false }), set: () => {}, update: () => {} }),
    serverTimestamp: () => 'AHORA',
    getDocFromCache: async () => { throw new Error('sin cache'); },
    addDoc: async () => ({ id: 'nuevo' }),
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {}, storage: {} }));

const {
  diasDeLaCaja, diaCompleto, cortesSugeridos, cortesDesdeMapa, tieneDiasMezclados,
  armarGrupos, planDeSeparacion, idsLibres, primerIdLibre, controlDeSuma,
} = await import('../../webapp/src/cajas_dias.js');

const {
  numerosOcupados, chequearIdLibre, cajaAbiertaAhora, ejecutarSeparacion,
  separacionPendiente, documentoDeCaja, verificarDespuesDeEscribir,
} = await import('../../webapp/src/cajas_separar.js');

/* ── Los datos: dos jornadas pegadas, como la caja #138 ───────────────────── */

const DIA_A = '2026-09-18';
const DIA_B = '2026-09-19';
const CAJA = 138;

const hora = (ymd, hhmm) => new Date(`${ymd}T${hhmm}:00-03:00`);
const dmy = (ymd) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;

/** Un renglón ya normalizado, como los arma la pantalla de Cierres. */
function renglon({ ymd, hhmm, num, sub, ef = null, tr = null, producto = 'CUADERNO', pc = 'PC1', caja = CAJA }) {
  return {
    pc_id: pc, num_venta: num, subtotal: sub, cantidad: 1, producto,
    tipo_pago: tr && !ef ? 'Transferencia' : 'Efectivo',
    monto_efectivo: ef === null ? sub : ef,
    monto_transferencia: tr === null ? 0 : tr,
    fecha_dt: hora(ymd, hhmm), fecha_ymd: ymd, cash_register_id: caja,
  };
}

/**
 * Dos días con la misma forma que la caja real: el 18 abre a la mañana y el 19
 * cierra a la noche, con efectivo, transferencia y una venta mixta en cada uno.
 */
function itemsDeDosDias() {
  return [
    renglon({ ymd: DIA_A, hhmm: '08:10', num: 1, sub: 10000 }),
    renglon({ ymd: DIA_A, hhmm: '11:30', num: 2, sub: 5000, ef: 0, tr: 5000 }),
    renglon({ ymd: DIA_A, hhmm: '16:00', num: 3, sub: 20000, ef: 8000, tr: 12000, producto: 'RESMA' }),
    renglon({ ymd: DIA_A, hhmm: '19:55', num: 4, sub: 3000 }),
    renglon({ ymd: DIA_A, hhmm: '20:10', num: 5, sub: 1000 }),
    renglon({ ymd: DIA_A, hhmm: '20:20', num: 6, sub: 2000 }),
    renglon({ ymd: DIA_A, hhmm: '20:25', num: 7, sub: 4000 }),
    renglon({ ymd: DIA_A, hhmm: '20:28', num: 8, sub: 6000 }),
    renglon({ ymd: DIA_B, hhmm: '08:30', num: 9, sub: 7000 }),
    renglon({ ymd: DIA_B, hhmm: '09:00', num: 10, sub: 30000, ef: 0, tr: 30000, producto: 'RESMA' }),
    renglon({ ymd: DIA_B, hhmm: '12:00', num: 11, sub: 12000, ef: 2000, tr: 10000 }),
    renglon({ ymd: DIA_B, hhmm: '15:00', num: 12, sub: 9000 }),
    renglon({ ymd: DIA_B, hhmm: '17:00', num: 13, sub: 1000 }),
    renglon({ ymd: DIA_B, hhmm: '18:00', num: 14, sub: 2000 }),
    renglon({ ymd: DIA_B, hhmm: '19:00', num: 15, sub: 3000 }),
    renglon({ ymd: DIA_B, hhmm: '20:30', num: 16, sub: 5000 }),
  ];
}

/** Un día armado a mano, para probar los cortes sin inventar renglones. */
function diaSuelto(ymd, tx, total) {
  return {
    ymd, tx, total, sinFecha: false, efectivo: total, transferencia: 0, renglones: tx,
    ventas: new Set(Array.from({ length: tx }, (_, i) => `${ymd}|${i}`)),
    ventasEf: new Set(), ventasTr: new Set(), productos: new Map(),
    primera: null, ultima: null,
  };
}

const sumar = (items, campo) => items.reduce((s, it) => s + (campo === 'ef' ? it.monto_efectivo
  : campo === 'tr' ? it.monto_transferencia : it.subtotal), 0);

/** La caja tal como la arma la pantalla, con los totales ya recalculados. */
function cajaDeDosDias(extra = {}) {
  const items = itemsDeDosDias();
  return {
    register_id: CAJA,
    fecha_apertura: hora(DIA_A, '07:58'),
    fecha_cierre: hora(DIA_B, '20:33'),
    monto_inicial: 30000,
    monto_final: 0,
    pendiente_conteo: true,
    retiros: [],
    total_retiros: 0,
    cajero: 'Marta',
    pc_id: 'DESKTOP-1',
    session_id: DIA_B,
    total_efectivo: sumar(items, 'ef'),
    total_transferencia: sumar(items, 'tr'),
    total_ventas: sumar(items, 'total'),
    total_transacciones: 16,
    ...extra,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   La cuenta de los días
   ═══════════════════════════════════════════════════════════════════════════ */

describe('los días que tiene adentro una caja', () => {
  it('agrupa los renglones por día y reparte efectivo y transferencia', () => {
    const dias = diasDeLaCaja(itemsDeDosDias(), CAJA);
    expect(dias.map(d => d.ymd)).toEqual([DIA_A, DIA_B]);

    const [a, b] = dias;
    expect(a.tx).toBe(8);
    expect(a.total).toBe(51000);
    expect(a.efectivo).toBe(34000);       // la mixta aporta 8.000, no 20.000
    expect(a.transferencia).toBe(17000);
    expect(b.tx).toBe(8);
    expect(b.total).toBe(69000);
    expect(b.efectivo).toBe(29000);
    expect(b.transferencia).toBe(40000);
  });

  it('cada día se queda con su primera y su última venta', () => {
    const [a, b] = diasDeLaCaja(itemsDeDosDias(), CAJA);
    expect(a.primera).toEqual(hora(DIA_A, '08:10'));
    expect(a.ultima).toEqual(hora(DIA_A, '20:28'));
    expect(b.primera).toEqual(hora(DIA_B, '08:30'));
    expect(b.ultima).toEqual(hora(DIA_B, '20:30'));
  });

  it('sólo mira los renglones de esa caja', () => {
    const items = [...itemsDeDosDias(), renglon({ ymd: DIA_B, hhmm: '10:00', num: 99, sub: 50000, caja: 136 })];
    const dias = diasDeLaCaja(items, CAJA);
    expect(dias.find(d => d.ymd === DIA_B).total).toBe(69000);
  });

  it('cuando una separación quedó a medias, mira los dos números', () => {
    const items = itemsDeDosDias().map(it => (it.fecha_ymd === DIA_B ? { ...it, cash_register_id: 139 } : it));
    expect(diasDeLaCaja(items, [CAJA, 139]).map(d => d.ymd)).toEqual([DIA_A, DIA_B]);
    expect(diasDeLaCaja(items, CAJA).map(d => d.ymd)).toEqual([DIA_A]);
  });

  it('el renglón sin fecha queda aparte y primero', () => {
    const items = [...itemsDeDosDias(), { ...renglon({ ymd: DIA_A, hhmm: '10:00', num: 50, sub: 800 }), fecha_ymd: '', fecha_dt: null }];
    const dias = diasDeLaCaja(items, CAJA);
    expect(dias[0].sinFecha).toBe(true);
    expect(dias[0].total).toBe(800);
  });
});

describe('cuándo un día es una jornada de verdad', () => {
  const dia = (tx, total) => ({ ymd: DIA_B, tx, total, sinFecha: false });

  it('ocho ventas ya son un día', () => {
    expect(diaCompleto(dia(8, 1000), 100000)).toBe(true);
    expect(diaCompleto(dia(7, 1000), 100000)).toBe(false);
  });

  it('pocas ventas pero mucha plata también', () => {
    expect(diaCompleto(dia(3, 20000), 100000)).toBe(true);   // 20% de la caja
    expect(diaCompleto(dia(3, 5000), 100000)).toBe(false);
  });

  it('abrir de noche y vender al otro día NO es una caja mezclada', () => {
    // El caso real de la caja #137: una venta el 16 a las 20:34 y todo el 17.
    const dias = [
      diaSuelto('2026-09-16', 1, 2200),
      diaSuelto('2026-09-17', 163, 1095080),
    ];
    expect(tieneDiasMezclados(dias)).toBe(false);
    expect(armarGrupos(dias, cortesSugeridos(dias))).toHaveLength(1);
  });

  it('una venta suelta días después tampoco parte la caja', () => {
    // El caso real de la caja #136: todo el 16 y una venta el 19.
    const dias = [
      { ymd: '2026-09-16', tx: 154, total: 1157701, sinFecha: false },
      { ymd: '2026-09-19', tx: 1, total: 16400, sinFecha: false },
    ];
    expect(tieneDiasMezclados(dias)).toBe(false);
  });

  it('dos jornadas enteras sí se marcan', () => {
    // El caso real de la caja #138, el que hay que separar.
    const dias = [
      { ymd: DIA_A, tx: 131, total: 858670, sinFecha: false },
      { ymd: DIA_B, tx: 158, total: 1258130, sinFecha: false },
    ];
    expect(tieneDiasMezclados(dias)).toBe(true);
    expect(cortesSugeridos(dias)).toEqual([false, true]);
  });

  it('el día sin fecha nunca abre una caja nueva', () => {
    const dias = [
      { ymd: '', tx: 20, total: 50000, sinFecha: true },
      { ymd: DIA_A, tx: 100, total: 800000, sinFecha: false },
      { ymd: DIA_B, tx: 100, total: 800000, sinFecha: false },
    ];
    expect(cortesSugeridos(dias)).toEqual([false, false, true]);
  });
});

describe('armar los grupos', () => {
  it('sin cortes queda una sola caja', () => {
    const dias = diasDeLaCaja(itemsDeDosDias(), CAJA);
    const grupos = armarGrupos(dias, [false, false]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].total).toBe(120000);
  });

  it('el corte parte los totales y los productos', () => {
    const dias = diasDeLaCaja(itemsDeDosDias(), CAJA);
    const [a, b] = armarGrupos(dias, [false, true]);
    expect(a.total + b.total).toBe(120000);
    expect(a.efectivo + b.efectivo).toBe(63000);
    expect(a.tx).toBe(8);
    expect(b.tx).toBe(8);
    expect(a.productos_vendidos.find(p => p.product_name === 'RESMA').total_amount).toBe(20000);
    expect(b.productos_vendidos.find(p => p.product_name === 'RESMA').total_amount).toBe(30000);
  });

  it('tres días se pueden partir en tres o en dos', () => {
    const dias = [
      diaSuelto('2026-09-17', 50, 500000),
      diaSuelto(DIA_A, 50, 500000),
      diaSuelto(DIA_B, 50, 500000),
    ];
    expect(armarGrupos(dias, [false, true, true])).toHaveLength(3);
    const dos = armarGrupos(dias, [false, false, true]);
    expect(dos).toHaveLength(2);
    expect(dos[0].ymds).toEqual(['2026-09-17', DIA_A]);
  });

  it('los cortes de un reparto ya decidido se reconstruyen igual', () => {
    const dias = diasDeLaCaja(itemsDeDosDias(), CAJA);
    const cortes = cortesDesdeMapa(dias, { [DIA_A]: 138, [DIA_B]: 139 }, 138);
    expect(cortes).toEqual([false, true]);
    expect(armarGrupos(dias, cortes)).toHaveLength(2);
  });

  it('un día que no figura en el reparto viejo se pega al grupo anterior', () => {
    const dias = diasDeLaCaja(itemsDeDosDias(), CAJA);
    expect(cortesDesdeMapa(dias, { [DIA_A]: 138 }, 138)).toEqual([false, false]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   El plan: cómo queda cada caja
   ═══════════════════════════════════════════════════════════════════════════ */

function planDeDosDias(extraCaja = {}, opciones = {}) {
  const caja = cajaDeDosDias(extraCaja);
  const dias = diasDeLaCaja(itemsDeDosDias(), CAJA);
  const grupos = armarGrupos(dias, [false, true]);
  return planDeSeparacion({
    caja, grupos, idsNuevos: [139],
    montosIniciales: [30000, 30000],
    ahoraIso: '2026-09-19T23:59:00.000Z',
    ...opciones,
  });
}

describe('el plan de separación', () => {
  it('la primera caja conserva el número y la apertura real', () => {
    const { cajas } = planDeDosDias();
    expect(cajas[0].id).toBe(CAJA);
    expect(cajas[0].esNuevo).toBe(false);
    expect(cajas[0].fecha_apertura).toEqual(hora(DIA_A, '07:58'));
  });

  it('la primera cierra en su última venta, no a la medianoche', () => {
    const { cajas } = planDeDosDias();
    expect(cajas[0].fecha_cierre).toEqual(hora(DIA_A, '20:28'));
  });

  it('la caja nueva abre un minuto después del cierre de la anterior', () => {
    const { cajas } = planDeDosDias();
    expect(cajas[1].id).toBe(139);
    expect(cajas[1].esNuevo).toBe(true);
    expect(cajas[1].fecha_apertura).toEqual(hora(DIA_A, '20:29'));
    expect(cajas[1].fecha_cierre).toEqual(hora(DIA_B, '20:33'));
  });

  it('la caja nueva no puede abrir después de su primera venta', () => {
    // Un día que arranca 30 segundos después del cierre anterior: la apertura
    // se adelanta a esa venta en vez de dejarla fuera de la caja.
    const caja = cajaDeDosDias();
    const items = [
      renglon({ ymd: DIA_A, hhmm: '23:59', num: 1, sub: 1000 }),
      { ...renglon({ ymd: DIA_B, hhmm: '00:00', num: 2, sub: 2000 }), fecha_dt: new Date(hora(DIA_A, '23:59').getTime() + 30000) },
    ];
    const grupos = armarGrupos(diasDeLaCaja(items, CAJA), [false, true]);
    const { cajas } = planDeSeparacion({ caja, grupos, idsNuevos: [139], montosIniciales: [0, 0] });
    expect(cajas[1].fecha_apertura.getTime()).toBeLessThanOrEqual(cajas[1].primera_venta ?? Infinity);
    expect(cajas[1].fecha_apertura.getTime()).toBe(hora(DIA_A, '23:59').getTime() + 30000);
    expect(cajas[0].fecha_cierre.getTime()).toBeLessThan(cajas[1].fecha_apertura.getTime());
  });

  it('las partes suman exactamente la caja entera', () => {
    const { control } = planDeDosDias();
    expect(control.ok).toBe(true);
    expect(control.txIgual).toBe(true);
    expect(control.efectivo.partes).toBe(control.efectivo.caja);
    expect(control.ventas.partes).toBe(control.ventas.caja);
  });

  it('si la plata no da, el control lo dice', () => {
    const caja = cajaDeDosDias({ total_efectivo: 999999 });
    const control = controlDeSuma(caja, planDeDosDias().cajas);
    expect(control.ok).toBe(false);
  });

  it('el esperado de cada caja es su inicial más su efectivo', () => {
    const { cajas } = planDeDosDias();
    expect(cajas[0].monto_esperado).toBe(30000 + 34000);
    expect(cajas[1].monto_esperado).toBe(30000 + 29000);
  });

  it('el monto inicial que se carga en el diálogo es el que se guarda', () => {
    const { cajas } = planDeDosDias({}, { montosIniciales: [30000, 50000] });
    expect(cajas[1].monto_inicial).toBe(50000);
    expect(cajas[1].monto_esperado).toBe(50000 + 29000);
  });

  it('el conteo de esa noche se lo queda la última caja', () => {
    // La caja se contó una sola vez, al cerrarla: ese número es de la última.
    const { cajas } = planDeDosDias({ monto_final: 90000, pendiente_conteo: false });
    expect(cajas[0].pendiente_conteo).toBe(true);
    expect(cajas[0].monto_final).toBe(0);
    expect(cajas[1].pendiente_conteo).toBe(false);
    expect(cajas[1].monto_final).toBe(90000);
    expect(cajas[1].hereda_conteo).toBe(true);
    expect(cajas[1].diferencia).toBe(90000 - 59000);
  });

  it('un conteo cargado a mano gana sobre el heredado', () => {
    const { cajas } = planDeDosDias(
      { monto_final: 90000, pendiente_conteo: false },
      { conteos: [64000, 58000] });
    expect(cajas[0].monto_final).toBe(64000);
    expect(cajas[0].diferencia).toBe(0);
    expect(cajas[1].monto_final).toBe(58000);
    expect(cajas[1].diferencia).toBe(-1000);
    expect(cajas[1].hereda_conteo).toBe(false);
  });

  it('dejar una caja pendiente a propósito no hereda nada', () => {
    const { cajas } = planDeDosDias(
      { monto_final: 90000, pendiente_conteo: false },
      { conteos: [null, null] });
    expect(cajas[1].pendiente_conteo).toBe(true);
    expect(cajas[1].monto_final).toBe(0);
    expect(cajas[1].diferencia).toBe(null);
  });

  it('cada retiro va a la caja del día en que se hizo', () => {
    const retiros = [
      { amount: 5000, reason: 'Pago flete', created_at: hora(DIA_A, '12:00').toISOString() },
      { amount: 2000, reason: 'Vuelto', created_at: hora(DIA_B, '16:00').toISOString() },
      { amount: 1000, reason: 'Sin fecha' },
    ];
    const { cajas } = planDeDosDias({ retiros, total_retiros: 8000 });
    expect(cajas[0].total_retiros).toBe(6000);   // el del 18 y el que no tiene fecha
    expect(cajas[1].total_retiros).toBe(2000);
    expect(cajas[0].monto_esperado).toBe(30000 + 34000 - 6000);
    expect(cajas[1].monto_esperado).toBe(30000 + 29000 - 2000);
  });

  it('el reparto de días dice a qué caja va cada uno', () => {
    const { mapaDias } = planDeDosDias();
    expect(mapaDias).toEqual({ [DIA_A]: CAJA, [DIA_B]: 139 });
  });

  it('sin dos grupos no hay nada que separar', () => {
    const caja = cajaDeDosDias();
    const grupos = armarGrupos(diasDeLaCaja(itemsDeDosDias(), CAJA), [false, false]);
    expect(() => planDeSeparacion({ caja, grupos, idsNuevos: [139] })).toThrow();
  });

  it('sin números para las cajas nuevas tampoco', () => {
    const caja = cajaDeDosDias();
    const grupos = armarGrupos(diasDeLaCaja(itemsDeDosDias(), CAJA), [false, true]);
    expect(() => planDeSeparacion({ caja, grupos, idsNuevos: [] })).toThrow();
  });
});

describe('elegir el número de la caja nueva', () => {
  it('toma el primero libre de ahí para arriba', () => {
    expect(primerIdLibre([138, 139, 140], 139)).toBe(141);
    expect(primerIdLibre(new Set([138]), 139)).toBe(139);
  });

  it('varios números seguidos no se repiten entre ellos', () => {
    expect(idsLibres(new Set([139, 141]), 139, 3)).toEqual([140, 142, 143]);
  });

  it('los números ocupados salen del doc y del campo', () => {
    const usados = numerosOcupados([
      { id: '138', register_id: 138 },
      { id: 'DESKTOP_12', register_id: 12 },
      { id: 'sintetico_2026-04-18', register_id: null },
    ]);
    expect(usados.has(138)).toBe(true);
    expect(usados.has(12)).toBe(true);
    expect(usados.size).toBe(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Las escrituras
   ═══════════════════════════════════════════════════════════════════════════ */

function sembrarNube({ conBorrados = true } = {}) {
  nube.col = { cierres_caja: {}, ventas_por_dia: {}, ventas: {}, caja_activa: {} };

  nube.col.cierres_caja['138'] = {
    register_id: 138, fecha_apertura: { _ts: true }, fecha_cierre: { _ts: true },
    monto_inicial: 30000, monto_final: 90000, diferencia: -1000, pendiente_conteo: false,
    total_ventas: 120000, cajero: 'Marta', pc_id: 'DESKTOP-1',
  };
  nube.col.caja_activa['current'] = { status: 'closed', id: 138, register_id: 138 };

  itemsDeDosDias().forEach((it, i) => {
    nube.col.ventas_por_dia[`PC1_${it.num_venta}_${i}`] = {
      num_venta: it.num_venta, pc_id: 'PC1', fecha: dmy(it.fecha_ymd), hora: '12:00:00',
      producto: it.producto, subtotal: it.subtotal, cantidad: 1,
      monto_efectivo: it.monto_efectivo, monto_transferencia: it.monto_transferencia,
      cash_register_id: 138,
    };
    nube.col.ventas[`v${it.num_venta}`] = {
      sale_id: it.num_venta, pc_id: 'PC1', total_amount: it.subtotal,
      created_at: it.fecha_dt.toISOString(), cash_register_id: 138,
    };
  });

  if (conBorrados) {
    // Un renglón borrado y un VARIOS 2 del segundo día: no cuentan para los
    // totales, pero si no se mudan quedan colgados de la caja vieja.
    nube.col.ventas_por_dia['PC1_90_0'] = {
      num_venta: 90, pc_id: 'PC1', fecha: dmy(DIA_B), producto: 'ANULADO',
      subtotal: 7777, cash_register_id: 138, deleted: true,
    };
    nube.col.ventas_por_dia['PC1_91_0'] = {
      num_venta: 91, pc_id: 'PC1', fecha: dmy(DIA_B), producto: 'VARIOS 2',
      categoria: 'VARIOS 2', subtotal: 5555, cash_register_id: 138,
    };
    // Y uno sin fecha, que no se puede mandar a ningún día.
    nube.col.ventas_por_dia['PC1_92_0'] = {
      num_venta: 92, pc_id: 'PC1', producto: 'SIN FECHA', subtotal: 100, cash_register_id: 138,
    };
  }
}

const filaEn = (col, id) => nube.col[col][id];
const renglonesDe = (id) => Object.values(nube.col.ventas_por_dia).filter(r => r.cash_register_id === id);
const ventasDe = (id) => Object.values(nube.col.ventas).filter(v => v.cash_register_id === id);

describe('separar de verdad', () => {
  beforeEach(() => { sembrarNube(); nube.lotes = 0; });

  it('mueve al día siguiente todo lo suyo y deja lo del primer día quieto', async () => {
    const plan = planDeDosDias();
    const r = await ejecutarSeparacion({}, { plan });

    expect(renglonesDe(139)).toHaveLength(10);   // 8 ventas + el borrado + el VARIOS 2
    expect(renglonesDe(138)).toHaveLength(9);    // 8 del día 18 + el que no tiene fecha
    expect(ventasDe(139)).toHaveLength(8);
    expect(r.renglones.movidos).toBe(10);
    expect(r.ventas.movidos).toBe(8);
    expect(r.renglones.sinDia).toEqual(['PC1_92_0']);
  });

  it('el renglón borrado y el VARIOS 2 se van con su día', async () => {
    await ejecutarSeparacion({}, { plan: planDeDosDias() });
    expect(filaEn('ventas_por_dia', 'PC1_90_0').cash_register_id).toBe(139);
    expect(filaEn('ventas_por_dia', 'PC1_91_0').cash_register_id).toBe(139);
  });

  it('escribe las dos cajas con sus totales', async () => {
    await ejecutarSeparacion({}, { plan: planDeDosDias() });

    const vieja = filaEn('cierres_caja', '138');
    const nueva = filaEn('cierres_caja', '139');
    expect(vieja.total_ventas).toBe(51000);
    expect(vieja.total_efectivo).toBe(34000);
    expect(vieja.total_transacciones).toBe(8);
    expect(vieja.cerrado_desde).toBe('ajuste-dias');
    expect(nueva.register_id).toBe(139);
    expect(nueva.total_ventas).toBe(69000);
    expect(nueva.abierto_desde).toBe('ajuste-dias');
    expect(nueva.pc_id).toBe('DESKTOP-1');
    expect(vieja.total_ventas + nueva.total_ventas).toBe(120000);
  });

  it('la caja que queda sin contar pierde la diferencia vieja', async () => {
    await ejecutarSeparacion({}, { plan: planDeDosDias({ monto_final: 90000, pendiente_conteo: false }) });
    const vieja = filaEn('cierres_caja', '138');
    expect(vieja.pendiente_conteo).toBe(true);
    expect(vieja.monto_final).toBe(0);
    expect('diferencia' in vieja).toBe(false);
  });

  it('relee las cajas y confirma que quedaron como el plan', async () => {
    const plan = planDeDosDias();
    const r = await ejecutarSeparacion({}, { plan });
    expect(r.verificacion.ok).toBe(true);
    expect(r.verificacion.detalles.map(d => d.id)).toEqual([138, 139]);
    expect(r.verificacion.detalles[1].efectivo.base).toBe(r.verificacion.detalles[1].efectivo.plan);
  });

  it('si la base no quedó como la cuenta, lo dice y marca para revisar', async () => {
    // Una venta del día 19 que una PC sincroniza DESPUÉS de que el diálogo
    // armó la cuenta: la separación la manda a la caja nueva, así que la #139
    // termina con $4.000 más de los que el plan prometía.
    const plan = planDeDosDias();
    nube.col.ventas_por_dia['tardia'] = {
      num_venta: 777, pc_id: 'PC1', fecha: dmy(DIA_B), producto: 'LAPIZ',
      subtotal: 4000, monto_efectivo: 4000, monto_transferencia: 0,
      cash_register_id: 138,
    };
    const r = await ejecutarSeparacion({}, { plan });
    expect(r.verificacion.ok).toBe(false);
    const flojo = r.verificacion.detalles.find(d => !d.ok);
    expect(flojo.id).toBe(139);
    expect(flojo.efectivo.base - flojo.efectivo.plan).toBe(4000);
    expect(filaEn('cierres_caja', '138').separacion.estado).toBe('revisar');
    expect(separacionPendiente(filaEn('cierres_caja', '138')).estado).toBe('revisar');
  });

  it('un día que no está en el plan se queda donde está', async () => {
    // Un renglón borrado de otro día: la pantalla no lo ve, así que el plan no
    // lo menciona. Moverlo a la caja vieja sería inventar a dónde va.
    nube.col.ventas_por_dia['otroDia'] = {
      num_venta: 500, pc_id: 'PC1', fecha: '20/09/2026', producto: 'ANULADO',
      subtotal: 999, cash_register_id: 138, deleted: true,
    };
    const r = await ejecutarSeparacion({}, { plan: planDeDosDias() });
    expect(filaEn('ventas_por_dia', 'otroDia').cash_register_id).toBe(138);
    expect(r.renglones.fueraDelPlan).toEqual(['otroDia']);
  });

  it('la verificación se puede correr sola', async () => {
    const plan = planDeDosDias();
    const antes = await verificarDespuesDeEscribir({}, plan);
    expect(antes.ok).toBe(false);          // todavía no se movió nada
    await ejecutarSeparacion({}, { plan });
    const despues = await verificarDespuesDeEscribir({}, plan);
    expect(despues.ok).toBe(true);
  });

  it('deja la separación marcada como hecha', async () => {
    await ejecutarSeparacion({}, { plan: planDeDosDias() });
    const marca = filaEn('cierres_caja', '138').separacion;
    expect(marca.estado).toBe('hecha');
    expect(marca.ids_nuevos).toEqual([139]);
    expect(marca.dias).toEqual({ [DIA_A]: 138, [DIA_B]: 139 });
    expect(separacionPendiente(filaEn('cierres_caja', '138'))).toBe(null);
  });

  it('va contando lo que hace', async () => {
    const pasos = [];
    await ejecutarSeparacion({}, { plan: planDeDosDias(), onProgreso: (t) => pasos.push(t) });
    expect(pasos.length).toBeGreaterThan(2);
    expect(pasos.join(' ')).toContain('Verificando');
  });
});

describe('los controles antes de escribir', () => {
  beforeEach(() => { sembrarNube(); });

  it('no separa si el número nuevo ya tiene un cierre', async () => {
    nube.col.cierres_caja['139'] = { register_id: 139 };
    await expect(ejecutarSeparacion({}, { plan: planDeDosDias() })).rejects.toThrow(/139/);
    expect(renglonesDe(139)).toHaveLength(0);
    expect(filaEn('cierres_caja', '138').separacion).toBeUndefined();
  });

  it('no separa si el número nuevo tiene ventas viejas sin cierre', async () => {
    // El caso que no se ve mirando la lista de cierres: una PC usó ese número
    // y nunca subió el cierre.
    nube.col.ventas['vieja'] = { sale_id: 500, cash_register_id: 139, total_amount: 1000 };
    await expect(ejecutarSeparacion({}, { plan: planDeDosDias() })).rejects.toThrow(/139/);
    expect(ventasDe(139)).toHaveLength(1);      // sólo la que ya estaba
    expect(renglonesDe(139)).toHaveLength(0);
  });

  it('no separa la caja que está abierta ahora mismo', async () => {
    nube.col.caja_activa['current'] = { status: 'open', id: 138, register_id: 138 };
    await expect(ejecutarSeparacion({}, { plan: planDeDosDias() })).rejects.toThrow(/abierta/);
    expect(renglonesDe(139)).toHaveLength(0);
  });

  it('no separa una caja que no existe', async () => {
    delete nube.col.cierres_caja['138'];
    await expect(ejecutarSeparacion({}, { plan: planDeDosDias() })).rejects.toThrow(/138/);
  });

  it('no separa una caja sin fecha de cierre', async () => {
    nube.col.cierres_caja['138'].fecha_cierre = '';
    await expect(ejecutarSeparacion({}, { plan: planDeDosDias() })).rejects.toThrow(/abierta/);
  });

  it('el número libre se mide contra cierres, renglones y ventas', async () => {
    expect(await chequearIdLibre({}, 139)).toMatchObject({ libre: true, problemas: [] });
    nube.col.ventas_por_dia['x'] = { cash_register_id: 139, fecha: dmy(DIA_B) };
    const r = await chequearIdLibre({}, 139);
    expect(r.libre).toBe(false);
    expect(r.problemas[0]).toContain('renglones');
  });

  it('sabe cuál caja está abierta', async () => {
    expect(await cajaAbiertaAhora({})).toBe(null);
    nube.col.caja_activa['current'] = { status: 'open', register_id: 141 };
    expect(await cajaAbiertaAhora({})).toBe(141);
  });
});

describe('retomar una separación cortada a la mitad', () => {
  beforeEach(() => { sembrarNube(); });

  it('terminar lo que quedó a medias deja todo igual que hacerlo de una', async () => {
    // Primera pasada completa, para tener el resultado bueno con el que comparar.
    await ejecutarSeparacion({}, { plan: planDeDosDias() });
    const bueno = {
      renglones139: renglonesDe(139).length,
      ventas139: ventasDe(139).length,
      caja138: { ...filaEn('cierres_caja', '138') },
      caja139: { ...filaEn('cierres_caja', '139') },
    };

    // Ahora el corte: se marca en curso, se mueven sólo algunos renglones y se
    // cae antes de escribir las cajas.
    sembrarNube();
    nube.col.cierres_caja['138'].separacion = {
      estado: 'en_curso', ts: '2026-09-19T23:00:00.000Z',
      ids_nuevos: [139], dias: { [DIA_A]: 138, [DIA_B]: 139 },
    };
    nube.col.ventas_por_dia['PC1_9_8'].cash_register_id = 139;
    nube.col.ventas['v9'].cash_register_id = 139;

    const aMedias = separacionPendiente(filaEn('cierres_caja', '138'));
    expect(aMedias.ids_nuevos).toEqual([139]);

    // Retomar: los renglones ya movidos son nuestros, así que #139 no se
    // considera ocupado y se sigue con el mismo reparto.
    const items = itemsDeDosDias().map(it => (it.num_venta === 9 ? { ...it, cash_register_id: 139 } : it));
    const dias = diasDeLaCaja(items, [138, 139]);
    const cortes = cortesDesdeMapa(dias, aMedias.dias, 138);
    const plan = planDeSeparacion({
      caja: cajaDeDosDias(), grupos: armarGrupos(dias, cortes),
      idsNuevos: aMedias.ids_nuevos, montosIniciales: [30000, 30000],
    });
    await ejecutarSeparacion({}, { plan, idsPropios: aMedias.ids_nuevos });

    expect(renglonesDe(139)).toHaveLength(bueno.renglones139);
    expect(ventasDe(139)).toHaveLength(bueno.ventas139);
    expect(filaEn('cierres_caja', '139').total_ventas).toBe(bueno.caja139.total_ventas);
    expect(filaEn('cierres_caja', '138').total_ventas).toBe(bueno.caja138.total_ventas);
    expect(filaEn('cierres_caja', '138').separacion.estado).toBe('hecha');
  });

  it('correr la separación dos veces seguidas no cambia nada', async () => {
    await ejecutarSeparacion({}, { plan: planDeDosDias() });
    const antes = JSON.stringify(nube.col.ventas_por_dia);
    await ejecutarSeparacion({}, { plan: planDeDosDias(), idsPropios: [139] });
    expect(JSON.stringify(nube.col.ventas_por_dia)).toBe(antes);
    expect(filaEn('cierres_caja', '139').total_ventas).toBe(69000);
  });
});

describe('el documento que se guarda', () => {
  it('tiene todos los campos que la pantalla y el POS esperan', () => {
    const { cajas } = planDeDosDias();
    const doc = documentoDeCaja(cajas[1], { esNuevo: true });
    for (const campo of ['register_id', 'pc_id', 'cajero', 'session_id', 'fecha_apertura',
                         'fecha_cierre', 'monto_inicial', 'monto_esperado', 'monto_final',
                         'pendiente_conteo', 'total_ventas', 'total_efectivo', 'total_transferencia',
                         'total_transacciones', 'num_ventas_efectivo', 'num_ventas_transferencia',
                         'total_retiros', 'retiros', 'productos_vendidos', 'abierto_desde',
                         'cerrado_desde', 'updated_at']) {
      expect(doc[campo], campo).not.toBe(undefined);
    }
    expect(doc.fecha_apertura._ts).toBe(true);
    expect(doc.session_id).toBe(DIA_B);
  });

  it('la caja que conserva el número no dice que se abrió por un ajuste', () => {
    const { cajas } = planDeDosDias();
    expect(documentoDeCaja(cajas[0], { esNuevo: false }).abierto_desde).toBe(undefined);
  });

  it('la caja nueva hereda la PC y el cajero de la original', () => {
    const { cajas } = planDeDosDias();
    const doc = documentoDeCaja(cajas[1], { esNuevo: true });
    expect(doc.pc_id).toBe('DESKTOP-1');
    expect(doc.cajero).toBe('Marta');
  });

  it('sin PC conocida no le borra la que ya tenía la caja vieja', () => {
    // El merge escribe encima: un `pc_id: ''` acá le borraba al cierre la PC
    // que tenía guardada desde que se abrió.
    const caja = cajaDeDosDias({ pc_id: '', cajero: '' });
    const grupos = armarGrupos(diasDeLaCaja(itemsDeDosDias(), CAJA), [false, true]);
    const { cajas } = planDeSeparacion({ caja, grupos, idsNuevos: [139], montosIniciales: [0, 0] });
    const doc = documentoDeCaja(cajas[0], { esNuevo: false });
    expect('pc_id' in doc).toBe(false);
    expect('cajero' in doc).toBe(false);
  });
});
