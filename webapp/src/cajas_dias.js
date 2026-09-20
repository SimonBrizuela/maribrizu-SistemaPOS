/**
 * Separar una caja que quedó con ventas de varios días.
 *
 * Pasa seguido: la caja se abre a la noche, nadie la cierra al otro día y sigue
 * juntando ventas. La fila de Cierres muestra entonces un día con el doble de
 * plata y el conteo de esa noche no cierra contra nada.
 *
 * Acá vive SOLO la cuenta: agrupar los renglones por día, decidir dónde va el
 * corte y armar cómo tiene que quedar cada caja. No toca Firestore ni el DOM, así
 * que se puede probar entero (`tienda/pruebas/separar_caja.test.js`). Las
 * escrituras viven en `cajas_separar.js` y la pantalla en `pages/cierres.js`.
 *
 * Ojo con una caja abierta a las 20:30 que vende hasta el otro día: ESO es lo
 * normal y no hay que separarlo. Días mezclados de verdad = dos días con
 * actividad real, y de eso se encarga `diaCompleto`.
 */
import { repartoDeItem } from './medios_de_pago.js';

export const TZ_AR = 'America/Argentina/Buenos_Aires';

// Cuándo un día cuenta como jornada propia y no como la cola de la anterior.
// Los dos criterios sirven para lo mismo por caminos distintos: un día flojo de
// ocho tickets es un día igual, y un día de tres ventas que se lleva la mitad de
// la caja también.
export const MIN_VENTAS_DIA = 8;
export const PARTE_MINIMA_DIA = 0.12;

const MINUTO = 60 * 1000;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Una fecha cualquiera (Timestamp, {seconds}, ISO, Date) como Date, o null. */
export function aFecha(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return isNaN(valor) ? null : valor;
  if (typeof valor.toDate === 'function') {
    const d = valor.toDate();
    return d && !isNaN(d) ? d : null;
  }
  if (typeof valor === 'object' && valor.seconds !== undefined) {
    return new Date(valor.seconds * 1000 + Math.floor((valor.nanoseconds || 0) / 1e6));
  }
  const d = new Date(valor);
  return isNaN(d) ? null : d;
}

/** El día argentino ('YYYY-MM-DD') de una fecha. */
export function diaAR(valor) {
  const d = aFecha(valor);
  if (!d) return '';
  return d.toLocaleDateString('en-CA', { timeZone: TZ_AR });
}

/** Las 20:30 de ese día, para cuando no hay ni una venta con hora. */
export function finDelDia(ymd) {
  return new Date(`${ymd}T20:30:00-03:00`);
}

/**
 * Los renglones de `ventas_por_dia` de una caja, agrupados por día.
 *
 * `items` son los renglones ya normalizados por la pantalla de Cierres (sin
 * borrados ni VARIOS 2, con `fecha_ymd` y el reparto de pago resuelto).
 * `ids` es el id de la caja o la lista de ids cuando una separación quedó a
 * medio hacer y hay que mirar los dos lados.
 */
export function diasDeLaCaja(items, ids) {
  const buscados = new Set((Array.isArray(ids) ? ids : [ids])
    .map(Number).filter(Number.isFinite));
  const porDia = new Map();

  for (const it of items || []) {
    const rid = Number(it.cash_register_id);
    if (!Number.isFinite(rid) || !buscados.has(rid)) continue;

    // Un renglón sin fecha no se puede mandar a ningún día: queda con el
    // primero, que es la caja que conserva el número original.
    const ymd = it.fecha_ymd || '';
    if (!porDia.has(ymd)) {
      porDia.set(ymd, {
        ymd,
        sinFecha: ymd === '',
        total: 0,
        efectivo: 0,
        transferencia: 0,
        ventas: new Set(),
        ventasEf: new Set(),
        ventasTr: new Set(),
        renglones: 0,
        primera: null,
        ultima: null,
        productos: new Map(),
      });
    }
    const dia = porDia.get(ymd);
    const parte = repartoDeItem(it);
    const clave = `${it.pc_id || ''}|${it.num_venta}`;

    dia.total          += num(it.subtotal);
    dia.efectivo       += parte.efectivo;
    dia.transferencia  += parte.transferencia;
    dia.renglones      += 1;
    dia.ventas.add(clave);
    if (parte.efectivo)      dia.ventasEf.add(clave);
    if (parte.transferencia) dia.ventasTr.add(clave);

    const nombre = (it.producto || '').trim();
    if (nombre) {
      const p = dia.productos.get(nombre)
        || { product_name: nombre, total_quantity: 0, total_amount: 0 };
      p.total_quantity += num(it.cantidad) || 1;
      p.total_amount   += num(it.subtotal);
      dia.productos.set(nombre, p);
    }

    const f = aFecha(it.fecha_dt);
    if (f) {
      if (!dia.primera || f < dia.primera) dia.primera = f;
      if (!dia.ultima   || f > dia.ultima)  dia.ultima  = f;
    }
  }

  return [...porDia.values()]
    .map(d => ({ ...d, tx: d.ventas.size }))
    .sort((a, b) => (a.ymd || '').localeCompare(b.ymd || ''));
}

/** ¿Ese día es una jornada propia o la cola de la anterior? */
export function diaCompleto(dia, totalCaja) {
  if (!dia || dia.sinFecha) return false;
  if (dia.tx >= MIN_VENTAS_DIA) return true;
  return totalCaja > 0 && (dia.total / totalCaja) >= PARTE_MINIMA_DIA;
}

/**
 * Dónde conviene cortar. Devuelve un booleano por día: `true` = ahí arranca una
 * caja nueva. El primero nunca corta (es la caja que ya existe) y un día flojo
 * tampoco: se queda pegado al grupo anterior.
 */
export function cortesSugeridos(dias) {
  const totalCaja = (dias || []).reduce((s, d) => s + d.total, 0);
  const cortes = (dias || []).map(() => false);
  let huboCompleto = false;
  (dias || []).forEach((dia, i) => {
    const completo = diaCompleto(dia, totalCaja);
    if (i > 0 && completo && huboCompleto) cortes[i] = true;
    if (completo) huboCompleto = true;
  });
  return cortes;
}

/** ¿Esta caja tiene dos jornadas de verdad adentro? */
export function tieneDiasMezclados(dias) {
  return cortesSugeridos(dias).some(Boolean);
}

/**
 * Los cortes que reproducen un reparto ya decidido (`día -> número de caja`).
 * Es lo que permite retomar una separación que quedó a medio hacer con el mismo
 * criterio que la primera vez. Un día que no figura en el mapa —una venta que
 * sincronizó tarde— se queda pegado al grupo anterior.
 */
export function cortesDesdeMapa(dias, mapaDias, idOriginal) {
  const cortes = (dias || []).map(() => false);
  let anterior = Number(idOriginal);
  (dias || []).forEach((dia, i) => {
    const destino = (mapaDias || {})[dia.ymd];
    if (destino == null) return;
    if (i > 0 && Number(destino) !== anterior) cortes[i] = true;
    anterior = Number(destino);
  });
  return cortes;
}

/**
 * Arma los grupos de días según los cortes. El grupo 0 es siempre la caja que
 * conserva el número original.
 */
export function armarGrupos(dias, cortes) {
  const grupos = [];
  (dias || []).forEach((dia, i) => {
    if (grupos.length === 0 || (i > 0 && (cortes || [])[i])) grupos.push(nuevoGrupo());
    sumarDia(grupos[grupos.length - 1], dia);
  });
  return grupos.map(cerrarGrupo);
}

function nuevoGrupo() {
  return {
    dias: [],
    ymds: [],
    total: 0,
    efectivo: 0,
    transferencia: 0,
    ventas: new Set(),
    ventasEf: new Set(),
    ventasTr: new Set(),
    renglones: 0,
    primera: null,
    ultima: null,
    productos: new Map(),
  };
}

// Los días llegan de `diasDeLaCaja`, pero la pantalla también arma resúmenes
// livianos (día, total y cantidad) para el cartelito de la fila. Que un
// resumen así no rompa el agrupado es gratis y evita una pantalla en blanco.
const conjunto = (v) => (v instanceof Set ? v : new Set());

function sumarDia(grupo, dia) {
  grupo.dias.push(dia);
  if (dia.ymd) grupo.ymds.push(dia.ymd);
  grupo.total         += num(dia.total);
  grupo.efectivo      += num(dia.efectivo);
  grupo.transferencia += num(dia.transferencia);
  grupo.renglones     += num(dia.renglones);
  conjunto(dia.ventas).forEach(v => grupo.ventas.add(v));
  conjunto(dia.ventasEf).forEach(v => grupo.ventasEf.add(v));
  conjunto(dia.ventasTr).forEach(v => grupo.ventasTr.add(v));
  for (const [nombre, p] of (dia.productos instanceof Map ? dia.productos : new Map())) {
    const acum = grupo.productos.get(nombre)
      || { product_name: nombre, total_quantity: 0, total_amount: 0 };
    acum.total_quantity += p.total_quantity;
    acum.total_amount   += p.total_amount;
    grupo.productos.set(nombre, acum);
  }
  if (dia.primera && (!grupo.primera || dia.primera < grupo.primera)) grupo.primera = dia.primera;
  if (dia.ultima  && (!grupo.ultima  || dia.ultima  > grupo.ultima))  grupo.ultima  = dia.ultima;
}

function cerrarGrupo(grupo) {
  return {
    ...grupo,
    tx: grupo.ventas.size,
    txEfectivo: grupo.ventasEf.size,
    txTransferencia: grupo.ventasTr.size,
    productos_vendidos: [...grupo.productos.values()]
      .sort((a, b) => b.total_amount - a.total_amount),
  };
}

/**
 * Reparte los retiros del turno entre los grupos, por el día en que se hicieron.
 * El que no tiene fecha usable queda en la caja original.
 */
export function repartirRetiros(retiros, grupos) {
  const porGrupo = grupos.map(() => []);
  const deQuienEs = new Map();
  grupos.forEach((g, i) => g.ymds.forEach(ymd => deQuienEs.set(ymd, i)));

  for (const r of retiros || []) {
    const ymd = diaAR(r?.created_at || r?.fecha || r?.fecha_dt);
    const idx = deQuienEs.has(ymd) ? deQuienEs.get(ymd) : 0;
    porGrupo[idx].push(r);
  }
  return porGrupo;
}

export function montoDeRetiro(r) {
  return num(r?.amount ?? r?.monto);
}

/** El primer número de caja libre desde `desde` hacia arriba. */
export function primerIdLibre(usados, desde) {
  const tomados = new Set([...(usados || [])].map(Number).filter(Number.isFinite));
  let id = Math.max(1, Math.floor(Number(desde) || 1));
  while (tomados.has(id)) id++;
  return id;
}

/** Varios números libres seguidos, sin repetirse entre ellos. */
export function idsLibres(usados, desde, cuantos) {
  const tomados = new Set([...(usados || [])].map(Number).filter(Number.isFinite));
  const salida = [];
  let id = Math.max(1, Math.floor(Number(desde) || 1));
  while (salida.length < cuantos) {
    while (tomados.has(id)) id++;
    salida.push(id);
    tomados.add(id);
    id++;
  }
  return salida;
}

/**
 * Cómo queda cada caja después de separar.
 *
 * Reglas:
 *   · el grupo 0 conserva el número, la apertura real y pasa a cerrar con su
 *     última venta;
 *   · cada grupo siguiente abre un minuto después del cierre del anterior (o en
 *     su primera venta si fue antes) y estrena número;
 *   · el último grupo hereda el cierre real y, salvo que se cargue otro, el
 *     efectivo contado esa noche — que es el único conteo que existió;
 *   · el que no tiene conteo queda pendiente, igual que una caja recién cerrada
 *     desde la web.
 */
export function planDeSeparacion({ caja, grupos, idsNuevos = [], montosIniciales = [],
                                   conteos = [], ahoraIso = new Date().toISOString() }) {
  if (!grupos || grupos.length < 2) {
    throw new Error('Para separar hacen falta al menos dos grupos de días.');
  }
  if (idsNuevos.length < grupos.length - 1) {
    throw new Error('Faltan números de caja para los grupos nuevos.');
  }

  const aperturaOriginal = aFecha(caja.fecha_apertura);
  const cierreOriginal   = aFecha(caja.fecha_cierre);
  const retirosPorGrupo  = repartirRetiros(caja.retiros || [], grupos);
  const heredaConteo     = !caja.pendiente_conteo && num(caja.monto_final) > 0;

  const cajas = [];
  const mapaDias = {};
  let cierreAnterior = null;

  grupos.forEach((grupo, i) => {
    const esUltimo = i === grupos.length - 1;
    const id = i === 0 ? Number(caja.register_id) : Number(idsNuevos[i - 1]);

    // Apertura
    let apertura;
    if (i === 0) {
      apertura = aperturaOriginal || grupo.primera || finDelDia(grupo.ymds[0] || '');
    } else {
      apertura = new Date(cierreAnterior.getTime() + MINUTO);
      if (grupo.primera && grupo.primera > cierreAnterior && grupo.primera < apertura) {
        apertura = new Date(grupo.primera.getTime());
      }
    }

    // Cierre: el último se queda con el real; los demás cierran en su última venta.
    let cierre;
    if (esUltimo) {
      cierre = cierreOriginal || grupo.ultima || finDelDia(grupo.ymds[grupo.ymds.length - 1] || '');
    } else {
      cierre = grupo.ultima || finDelDia(grupo.ymds[grupo.ymds.length - 1] || '');
      if (cierre <= apertura) cierre = new Date(apertura.getTime() + MINUTO);
    }
    cierreAnterior = cierre;

    const retiros = retirosPorGrupo[i] || [];
    const totalRetiros = retiros.reduce((s, r) => s + montoDeRetiro(r), 0);
    const inicial = num(montosIniciales[i] ?? caja.monto_inicial);
    const esperado = inicial + grupo.efectivo - totalRetiros;

    // Conteo: `null` es pendiente a propósito (nadie contó esa caja) y
    // `undefined` es "decidilo vos" — ahí el último hereda el conteo de la
    // noche en que se cerró de verdad, que es el único que existió.
    let contado = conteos[i];
    const heredado = contado === undefined && esUltimo && heredaConteo;
    if (contado === undefined) contado = heredado ? num(caja.monto_final) : null;

    grupo.ymds.forEach(ymd => { mapaDias[ymd] = id; });

    cajas.push({
      id,
      esNuevo: i !== 0,
      esUltimo,
      ymds: [...grupo.ymds],
      fecha_apertura: apertura,
      fecha_cierre: cierre,
      monto_inicial: inicial,
      monto_esperado: esperado,
      monto_final: contado === null ? 0 : num(contado),
      diferencia: contado === null ? null : num(contado) - esperado,
      pendiente_conteo: contado === null,
      hereda_conteo: heredado,
      retiros,
      total_retiros: totalRetiros,
      total_efectivo: grupo.efectivo,
      total_transferencia: grupo.transferencia,
      total_ventas: grupo.efectivo + grupo.transferencia,
      total_transacciones: grupo.tx,
      num_ventas_efectivo: grupo.txEfectivo,
      num_ventas_transferencia: grupo.txTransferencia,
      productos_vendidos: grupo.productos_vendidos,
      session_id: grupo.ymds[grupo.ymds.length - 1] || caja.session_id || '',
      pc_id: caja.pc_id || '',
      cajero: caja.cajero || '',
      updated_at: ahoraIso,
    });
  });

  return { cajas, mapaDias, control: controlDeSuma(caja, cajas) };
}

/**
 * Las partes tienen que dar la caja entera. Si la plata no da, algo se perdió
 * por el camino y no hay que escribir nada.
 *
 * La cantidad de ventas va aparte: se cuentan ventas distintas por `PC|número`,
 * y si a una PC le resetearon la base el mismo número puede repetirse en dos
 * días. Ahí las partes suman una de más sin que falte un peso, así que eso se
 * avisa pero no frena la separación.
 */
export function controlDeSuma(caja, cajas) {
  const suma = (campo) => cajas.reduce((s, c) => s + num(c[campo]), 0);
  const cerca = (a, b) => Math.abs(a - b) < 0.01;

  const efectivo      = { partes: suma('total_efectivo'),      caja: num(caja.total_efectivo) };
  const transferencia = { partes: suma('total_transferencia'), caja: num(caja.total_transferencia) };
  const ventas        = { partes: suma('total_ventas'),        caja: num(caja.total_ventas) };
  const tx            = { partes: suma('total_transacciones'), caja: num(caja.total_transacciones) };

  return {
    ok: cerca(efectivo.partes, efectivo.caja)
        && cerca(transferencia.partes, transferencia.caja)
        && cerca(ventas.partes, ventas.caja),
    txIgual: tx.partes === tx.caja,
    efectivo, transferencia, ventas, tx,
  };
}
