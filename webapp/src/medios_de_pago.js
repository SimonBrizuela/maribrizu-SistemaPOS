/**
 * Cómo se reparte la plata de una venta entre efectivo y transferencia.
 *
 * Gemelo de `pos_system/utils/medios_de_pago.py`. La regla está escrita dos
 * veces porque el cierre de caja se arma en los dos lados: el POS lo sube a
 * `cierres_caja` y esta página lo recalcula desde `ventas_por_dia`. Si se
 * separan, el ticket dice un número y el panel otro.
 *
 * `tienda/pruebas/medios_pago.test.js` corre las dos sobre los mismos casos y
 * las compara. Regla nueva → va en los DOS lados + caso en la prueba.
 *
 * El porqué de todo esto es el Pago Mixto: una venta que cobra una parte en
 * mano y otra por transferencia. Contarla entera como efectivo hacía que el
 * cierre pidiera en el cajón una plata que había entrado por el banco.
 *
 * Sin Firebase adentro a propósito: lo importan las pruebas.
 */

export const EFECTIVO = 'Efectivo';
export const TRANSFERENCIA = 'Transferencia';
export const MIXTO = 'Mixto';

function num(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

/** Redondeo a dos decimales, igual que el `round()` de Python sobre pesos. */
function centavos(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** El `payment_type` del POS ('cash'/'transfer'/'mixed') como etiqueta. */
export function etiquetaDePago(paymentType) {
  const tipo = String(paymentType || '').trim().toLowerCase();
  if (tipo === 'cash') return EFECTIVO;
  if (tipo === 'mixed') return MIXTO;
  return TRANSFERENCIA;
}

/**
 * Cuánto de una venta entró en efectivo y cuánto por transferencia.
 *
 * Toma un documento de `ventas`. En una mixta el efectivo es lo recibido menos
 * el vuelto: el vuelto sale del cajón, así que no es plata que entró.
 *
 * Una mixta sin desglose se cuenta entera como transferencia. Es la mitad que
 * no inventa efectivo: equivocarse para ese lado deja un sobrante que se ve, y
 * para el otro manda a contar la caja buscando algo que no falta.
 */
export function partesDeVenta(venta) {
  const total = num(venta?.total_amount);
  const tipo = String(venta?.payment_type || '').trim().toLowerCase();

  if (tipo === 'cash') return { efectivo: total, transferencia: 0 };
  if (tipo !== 'mixed') return { efectivo: 0, transferencia: total };

  let efectivo = Math.max(0, num(venta?.cash_received) - num(venta?.change_given));
  let transferencia = Math.max(0, num(venta?.transfer_amount));
  const suma = efectivo + transferencia;
  if (suma <= 0) return { efectivo: 0, transferencia: total };
  // Una venta editada puede haber quedado con las partes desfasadas del total.
  // Se respeta la proporción cobrada y se ajusta al total.
  if (Math.abs(suma - total) > 0.01) {
    efectivo = (total * efectivo) / suma;
    transferencia = total - efectivo;
  }
  return { efectivo, transferencia };
}

/**
 * Prorratea el efectivo y la transferencia de una venta entre sus renglones.
 * El último se lleva el resto para que la suma dé exactamente lo cobrado.
 */
export function repartirSubtotales(subtotales, efectivo, transferencia) {
  const subs = (subtotales || []).map(num);
  if (!subs.length) return [];

  const total = subs.reduce((t, s) => t + s, 0);
  if (total <= 0) {
    return subs.map((_, i) => (i === 0
      ? { efectivo: centavos(efectivo), transferencia: centavos(transferencia) }
      : { efectivo: 0, transferencia: 0 }));
  }

  const salida = [];
  let efDado = 0;
  let trDado = 0;
  for (let i = 0; i < subs.length; i++) {
    if (i === subs.length - 1) {
      salida.push({ efectivo: centavos(efectivo - efDado), transferencia: centavos(transferencia - trDado) });
      break;
    }
    const ef = centavos((efectivo * subs[i]) / total);
    const tr = centavos((transferencia * subs[i]) / total);
    efDado += ef;
    trDado += tr;
    salida.push({ efectivo: ef, transferencia: tr });
  }
  return salida;
}

/**
 * Cuánto aporta a efectivo y cuánto a transferencia un renglón de
 * `ventas_por_dia`.
 *
 * Los renglones nuevos traen el reparto hecho por el POS. Los viejos no, y
 * para esos vale el `tipo_pago`: igual que siempre, salvo el 'Mixto', que va
 * entero a transferencia por lo que explica `partesDeVenta`.
 */
export function repartoDeItem(item) {
  const sub = num(item?.subtotal);
  const me = item?.monto_efectivo;
  const mt = item?.monto_transferencia;
  const traeReparto = (me !== undefined && me !== null) || (mt !== undefined && mt !== null);
  if (traeReparto) return { efectivo: num(me), transferencia: num(mt) };

  const tipo = String(item?.tipo_pago || '').trim().toLowerCase();
  if (tipo === 'transferencia') return { efectivo: 0, transferencia: sub };
  if (tipo === 'mixto') return { efectivo: 0, transferencia: sub };
  return { efectivo: sub, transferencia: 0 };
}

/**
 * Los totales de una caja a partir de sus renglones de `ventas_por_dia`.
 *
 * Una venta mixta cuenta en las dos listas —aportó a las dos— así que
 * `transacciones` NO es la suma de las otras dos: es cuántas ventas distintas
 * hubo, que es lo que la palabra quiere decir.
 */
export function resumirItems(items, claveVenta = null) {
  const clave = claveVenta || (it => `${it?.pc_id || ''}|${it?.num_venta}`);

  let efectivo = 0;
  let transferencia = 0;
  const ventasEf = new Set();
  const ventasTr = new Set();
  const ventas = new Set();

  for (const it of (items || [])) {
    const parte = repartoDeItem(it);
    const k = clave(it);
    efectivo += parte.efectivo;
    transferencia += parte.transferencia;
    ventas.add(k);
    if (parte.efectivo) ventasEf.add(k);
    if (parte.transferencia) ventasTr.add(k);
  }

  return {
    efectivo: centavos(efectivo),
    transferencia: centavos(transferencia),
    ventasEfectivo: ventasEf,
    ventasTransferencia: ventasTr,
    ventas,
    numVentasEfectivo: ventasEf.size,
    numVentasTransferencia: ventasTr.size,
    transacciones: ventas.size,
  };
}
