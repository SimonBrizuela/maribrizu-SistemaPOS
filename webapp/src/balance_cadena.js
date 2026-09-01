/**
 * La cadena de saldos del Balance: de dónde arranca cada mes y con cuánto cierra.
 *
 * Sin DOM ni Firebase: recibe lo tipeado y los días cargados, devuelve números.
 * Lo prueba `tienda/pruebas/balance_cadena.test.js`.
 *
 * Regla: lo tipeado manda y lo que falta se calcula.
 *   · apertura del mes = la tipeada en el doc de días; si no hay, el cierre del
 *     mes anterior (un recuento a mano al arrancar el mes pisa la cadena, que
 *     es lo que uno espera cuando cuenta la plata de verdad).
 *   · cierre del mes = los saldos tipeados en el Resumen (el histórico del
 *     Excel o un "Fijar cierre") si el mes ya pasó; si no, apertura + neto de
 *     los días cargados.
 * Hasta el 2026-08-22 "Caja actual" era el último mes con saldos tipeados: se
 * quedaba en junio aunque agosto tuviera 18 días cargados.
 */

export const MEDIOS = ['efectivo', 'mp', 'lapos'];

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
export function r2(v) { return Math.round(num(v) * 100) / 100; }

/** Ingresos y compras de un día por medio (efectivo/mp/lapos + 'sin' para el medio vacío). */
export function diaPorMedio(dia) {
  const ing = { efectivo: 0, mp: 0, lapos: 0, sin: 0 };
  const com = { efectivo: 0, mp: 0, lapos: 0, sin: 0 };
  (dia?.ingresos || []).forEach(x => { const m = x.medio && ing[x.medio] != null ? x.medio : 'sin'; ing[m] += num(x.monto); });
  (dia?.compras || []).forEach(x => { const m = x.medio && com[x.medio] != null ? x.medio : 'sin'; com[m] += num(x.monto); });
  return { ing, com };
}

/** Neto de un día por medio (ingresos − compras). */
export function netoDia(dia) {
  const { ing, com } = diaPorMedio(dia);
  return { efectivo: ing.efectivo - com.efectivo, mp: ing.mp - com.mp, lapos: ing.lapos - com.lapos, sin: ing.sin - com.sin };
}

/** Un día cuenta como cargado si tiene algún ingreso con monto o alguna compra. */
export function diaCargado(dia) {
  return !!(dia && ((dia.ingresos || []).some(x => num(x.monto) > 0) || (dia.compras || []).length));
}

/** Si hay algún medio tipeado (null/undefined en los tres = nada). */
export function hayMontos(obj) {
  return !!obj && MEDIOS.some(k => obj[k] != null && obj[k] !== '');
}

function copia(obj) {
  return { efectivo: num(obj?.efectivo), mp: num(obj?.mp), lapos: num(obj?.lapos) };
}

/** Suma los netos de los días de un mes hasta `ddHasta` (inclusive; sin tope = todos). */
export function netoMes(dias, ddHasta = '99') {
  const o = { efectivo: 0, mp: 0, lapos: 0, sin: 0 };
  let cargados = 0, ultDd = null;
  Object.keys(dias || {}).sort().forEach(dd => {
    if (dd > ddHasta || !diaCargado(dias[dd])) return;
    const n = netoDia(dias[dd]);
    o.efectivo += n.efectivo; o.mp += n.mp; o.lapos += n.lapos; o.sin += n.sin;
    cargados++; ultDd = dd;
  });
  return { neto: o, cargados, ultDd };
}

/** Serie de meses 'YYYY-MM' entre dos, inclusive. */
export function rangoMeses(ymD, ymH) {
  const out = [];
  let [y, m] = ymD.split('-').map(Number);
  const [yh, mh] = ymH.split('-').map(Number);
  while (y < yh || (y === yh && m <= mh)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Encadena los meses.
 *   meses:   ['YYYY-MM', ...] en orden (los que haya que considerar)
 *   tipeados: ym → saldos tipeados en el Resumen ({efectivo, mp, lapos}) o nada
 *   docs:    ym → doc de días ({apertura, dias}) o null
 *   hoy:     'YYYY-MM-DD'
 * Devuelve ym → { apertura, aperturaOrigen, cierre, cierreOrigen, cargados, ultDd }
 *   aperturaOrigen: 'tipeada' | 'cierre_anterior' | 'ninguna'
 *   cierreOrigen:   'tipeado' | 'calculado' | 'ninguno'
 */
export function cadenaMeses({ meses, tipeados = {}, docs = {}, hoy }) {
  const ymHoy = String(hoy || '').slice(0, 7);
  const out = {};
  let cierrePrev = null;
  [...meses].sort().forEach(ym => {
    const doc = docs[ym] || null;
    const dias = (doc && doc.dias) || {};
    const { neto, cargados, ultDd } = netoMes(dias);
    const tip = tipeados[ym];

    let apertura, aperturaOrigen;
    if (hayMontos(doc && doc.apertura)) { apertura = copia(doc.apertura); aperturaOrigen = 'tipeada'; }
    else if (cierrePrev) { apertura = copia(cierrePrev); aperturaOrigen = 'cierre_anterior'; }
    else { apertura = null; aperturaOrigen = 'ninguna'; }

    let cierre, cierreOrigen;
    const pasado = ym < ymHoy;
    if (hayMontos(tip) && (pasado || !cargados)) {
      cierre = copia(tip); cierre.sin = 0; cierreOrigen = 'tipeado';
    } else if (apertura) {
      cierre = {
        efectivo: r2(apertura.efectivo + neto.efectivo),
        mp:       r2(apertura.mp + neto.mp),
        lapos:    r2(apertura.lapos + neto.lapos),
        sin:      r2(neto.sin),
      };
      cierreOrigen = 'calculado';
    } else if (hayMontos(tip)) {
      cierre = copia(tip); cierre.sin = 0; cierreOrigen = 'tipeado';
    } else {
      cierre = null; cierreOrigen = 'ninguno';
    }

    out[ym] = { ym, apertura, aperturaOrigen, cierre, cierreOrigen, cargados, ultDd, neto };
    cierrePrev = cierre;
  });
  return out;
}

/**
 * La plata de hoy: el cierre del último mes que tenga uno, con el día al que
 * llega. Para el mes en curso es el acumulado al último día cargado. Un mes sin
 * días ni saldos propios (su cierre es el del anterior pasado de largo) no
 * cuenta: se baja hasta el mes que tiene los datos de verdad, así la etiqueta
 * dice "al cierre de Agosto" y no el mes en curso recién arrancado.
 */
export function cajaAlDia(cadena, hoy) {
  const ymHoy = String(hoy || '').slice(0, 7);
  const yms = Object.keys(cadena).filter(ym => ym <= ymHoy).sort();
  for (let i = yms.length - 1; i >= 0; i--) {
    const m = cadena[yms[i]];
    if (!m.cierre) continue;
    if (i > 0 && !m.cargados && m.cierreOrigen === 'calculado' && m.aperturaOrigen === 'cierre_anterior') continue;
    const enCurso = m.ym === ymHoy && m.cierreOrigen === 'calculado';
    const total = r2(m.cierre.efectivo + m.cierre.mp + m.cierre.lapos + num(m.cierre.sin));
    return {
      ym: m.ym,
      dd: enCurso ? m.ultDd : null,
      saldos: m.cierre,
      total,
      origen: m.cierreOrigen,
      aperturaOrigen: m.aperturaOrigen,
      // Sin días cargados pero con apertura contada a mano: la caja es esa
      // apertura, no un "cierre" (cambia cómo se etiqueta).
      esApertura: m.cierreOrigen === 'calculado' && !m.cargados && m.aperturaOrigen === 'tipeada',
    };
  }
  return null;
}

/** Apertura efectiva de un mes según la cadena (o null si no hay de dónde sacarla). */
export function aperturaDe(cadena, ym) {
  const m = cadena && cadena[ym];
  return m && m.apertura ? m.apertura : null;
}

// ── Cuentas: la plata por cuenta en un período ────────────────────────────────
// Una "cuenta" es algo más fino que el medio: Efectivo y Lapos son una sola
// cada uno, pero Mercado Pago son varias (MP JOSE, MP AGUSTIN...), que se
// distinguen por el motivo del ingreso y, en las compras, por `cuenta`.

export function normCuenta(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Clave de cuenta de un ingreso: el medio, y para MP el nombre del motivo. */
export function cuentaDeIngreso(x) {
  const m = x?.medio;
  if (m === 'mp') return 'mp:' + normCuenta(x.motivo);
  if (m === 'efectivo' || m === 'lapos') return m;
  return 'sin';
}

/** Clave de cuenta de una compra: el medio, y para MP la `cuenta` si la tiene. */
export function cuentaDeCompra(x) {
  const m = x?.medio;
  if (m === 'mp') return 'mp:' + normCuenta(x.cuenta);
  if (m === 'efectivo' || m === 'lapos') return m;
  return 'sin';
}

export function etiquetaCuenta(clave) {
  if (clave === 'efectivo') return 'Efectivo';
  if (clave === 'lapos') return 'Lapos';
  if (clave === 'sin') return 'Sin medio';
  if (clave === 'mp:') return 'Mercado Pago (sin asignar)';
  if (clave.startsWith('mp:')) return clave.slice(3);
  return clave;
}

export function medioDeCuenta(clave) {
  if (clave.startsWith('mp:')) return 'mp';
  return clave;
}

/** Nombres de cuentas MP vistos en los ingresos (para ofrecerlos en las compras). */
export function cuentasMpDe(docs) {
  const set = new Set();
  Object.values(docs || {}).forEach(doc => {
    Object.values((doc && doc.dias) || {}).forEach(d => {
      (d.ingresos || []).forEach(x => {
        if (x.medio === 'mp' && normCuenta(x.motivo)) set.add(normCuenta(x.motivo));
      });
    });
  });
  return [...set].sort();
}

/**
 * Ingresos, egresos y detalle por cuenta entre dos fechas (inclusive).
 *   docs: ym → doc de días
 * Devuelve { cuentas: [...], porMedio: {efectivo, mp, lapos, sin}, dias }
 * Cada cuenta: { clave, label, medio, ingresos, egresos, neto,
 *                ingPorMotivo: [{motivo, total, veces}],
 *                egrPorRubro:  [{rubro, total, veces}],
 *                egrPorProveedor: [{proveedor, total, veces}],
 *                movimientos: [{iso, tipo, motivo|proveedor, rubro, monto}] }
 */
export function cuentasDelPeriodo({ docs, desde, hasta }) {
  const cuentas = new Map();
  const porMedio = {
    efectivo: { ingresos: 0, egresos: 0 }, mp: { ingresos: 0, egresos: 0 },
    lapos: { ingresos: 0, egresos: 0 }, sin: { ingresos: 0, egresos: 0 },
  };
  let dias = 0;

  const get = (clave) => {
    if (!cuentas.has(clave)) {
      cuentas.set(clave, {
        clave, label: etiquetaCuenta(clave), medio: medioDeCuenta(clave),
        ingresos: 0, egresos: 0, neto: 0,
        _mot: new Map(), _rub: new Map(), _prov: new Map(), movimientos: [],
      });
    }
    return cuentas.get(clave);
  };
  const suma = (map, k, v) => {
    const cur = map.get(k) || { total: 0, veces: 0 };
    cur.total += v; cur.veces += 1; map.set(k, cur);
  };

  Object.keys(docs || {}).sort().forEach(ym => {
    const dd = (docs[ym] && docs[ym].dias) || {};
    Object.keys(dd).sort().forEach(d => {
      const iso = `${ym}-${d}`;
      if (iso < desde || iso > hasta || !diaCargado(dd[d])) return;
      dias++;
      (dd[d].ingresos || []).forEach(x => {
        const v = num(x.monto); if (!(v > 0)) return;
        const c = get(cuentaDeIngreso(x));
        c.ingresos += v; porMedio[c.medio].ingresos += v;
        suma(c._mot, String(x.motivo || '').trim() || '(sin motivo)', v);
        c.movimientos.push({ iso, tipo: 'ingreso', motivo: String(x.motivo || ''), monto: v });
      });
      (dd[d].compras || []).forEach(x => {
        const v = num(x.monto); if (!(v > 0)) return;
        const c = get(cuentaDeCompra(x));
        c.egresos += v; porMedio[c.medio].egresos += v;
        suma(c._rub, String(x.rubro || '').trim() || '(sin rubro)', v);
        suma(c._prov, String(x.proveedor || '').trim() || '(sin proveedor)', v);
        c.movimientos.push({ iso, tipo: 'egreso', proveedor: String(x.proveedor || ''), rubro: String(x.rubro || ''), monto: v });
      });
    });
  });

  const lista = (map, campo) => [...map.entries()]
    .map(([k, v]) => ({ [campo]: k, total: r2(v.total), veces: v.veces }))
    .sort((a, b) => b.total - a.total);
  const orden = { efectivo: 0, mp: 1, lapos: 2, sin: 3 };
  const out = [...cuentas.values()].map(c => ({
    clave: c.clave, label: c.label, medio: c.medio,
    ingresos: r2(c.ingresos), egresos: r2(c.egresos), neto: r2(c.ingresos - c.egresos),
    ingPorMotivo: lista(c._mot, 'motivo'),
    egrPorRubro: lista(c._rub, 'rubro'),
    egrPorProveedor: lista(c._prov, 'proveedor'),
    movimientos: c.movimientos.sort((a, b) => a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0),
  })).sort((a, b) => (orden[a.medio] - orden[b.medio]) || a.label.localeCompare(b.label));

  Object.keys(porMedio).forEach(k => {
    porMedio[k].ingresos = r2(porMedio[k].ingresos);
    porMedio[k].egresos = r2(porMedio[k].egresos);
    porMedio[k].neto = r2(porMedio[k].ingresos - porMedio[k].egresos);
  });
  return { cuentas: out, porMedio, dias };
}

/** '2026-08' → '2026-09' (para arrancar a contar después de un cierre). */
export function mesSiguiente(ym) {
  let [y, m] = String(ym).split('-').map(Number);
  m++; if (m > 12) { m = 1; y++; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * La plata de cada cuenta de Mercado Pago hoy: el desglose fijado en el último
 * cierre (`saldosMp` del Resumen) más lo que se movió por cuenta desde entonces
 * (ingresos por el nombre del motivo, compras por la `cuenta` elegida).
 *   baseYm: mes del cierre con desglose ('2026-08') o null si no hay ninguno
 *   baseMp: { 'MP JOSE': 622594, 'MP AGUSTIN': 357033 } (saldos de ese cierre)
 *   docs:   ym → doc de días (alcanza con los meses posteriores a baseYm)
 *   hoy:    'YYYY-MM-DD'
 * Devuelve { cuentas: [{clave, nombre, base, ingresos, egresos, saldo}], total, desde }
 * con las compras MP sin cuenta asignada en su propio renglón. Sin base, los
 * saldos son solo el neto del período (sirven de reparto, no de plata total).
 */
export function mpPorCuentaAlDia({ baseYm, baseMp = {}, docs, hoy }) {
  const desde = baseYm ? `${mesSiguiente(baseYm)}-01` : '0000-01-01';
  const r = cuentasDelPeriodo({ docs, desde, hasta: hoy });
  const filas = new Map();
  Object.entries(baseMp || {}).forEach(([nombre, v]) => {
    if (normCuenta(nombre)) filas.set('mp:' + normCuenta(nombre), { base: num(v), ingresos: 0, egresos: 0 });
  });
  r.cuentas.filter(c => c.medio === 'mp').forEach(c => {
    const f = filas.get(c.clave) || { base: 0, ingresos: 0, egresos: 0 };
    f.ingresos = c.ingresos; f.egresos = c.egresos;
    filas.set(c.clave, f);
  });
  const cuentas = [...filas.entries()].map(([clave, f]) => ({
    clave,
    nombre: etiquetaCuenta(clave),
    base: r2(f.base),
    ingresos: r2(f.ingresos),
    egresos: r2(f.egresos),
    saldo: r2(f.base + f.ingresos - f.egresos),
  })).sort((a, b) => b.saldo - a.saldo);
  const total = r2(cuentas.reduce((s, c) => s + c.saldo, 0));
  return { cuentas, total, desde: baseYm ? desde : null };
}
