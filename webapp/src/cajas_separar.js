/**
 * Las escrituras de separar una caja en varios días.
 *
 * La cuenta la hace `cajas_dias.js`; acá se toca Firestore. Separar mueve tres
 * cosas y el orden importa:
 *
 *   1. se marca la caja original con la separación "en curso" — si el navegador
 *      se cierra a la mitad, al volver se sabe qué quedó colgado y se retoma;
 *   2. se reparten los renglones de `ventas_por_dia` y las `ventas` según el día
 *      de cada uno (los renglones borrados y los VARIOS 2 se mueven igual: si
 *      quedaran apuntando a la caja vieja, cualquier recálculo posterior los
 *      volvería a sumar donde no van);
 *   3. recién al final se escriben los documentos de caja con los totales.
 *
 * Todo es reintentable: el reparto se decide por el día del renglón, así que
 * correrlo dos veces deja lo mismo que correrlo una.
 */
import {
  collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, writeBatch, deleteField, Timestamp,
} from 'firebase/firestore';
import { fechaDMYtoYMD, isItemVarios2 } from './config.js';
import { repartoDeItem } from './medios_de_pago.js';
import { diaAR, aFecha } from './cajas_dias.js';

const POR_LOTE = 400;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Todos los números de caja ya usados: doc id y campo `register_id`. */
export function numerosOcupados(cierres) {
  const usados = new Set();
  const agregar = (valor) => {
    if (valor === null || valor === undefined || valor === '') return;
    const n = Number(valor);
    if (Number.isFinite(n)) usados.add(n);
  };
  for (const c of cierres || []) {
    agregar(c.id);
    agregar(c.register_id);
  }
  return usados;
}

/**
 * Un número de caja está libre sólo si no hay documento, ni renglones, ni
 * ventas con ese id. Lo tercero es lo que importa de verdad: un número que
 * alguna PC usó y nunca subió su cierre no tiene documento y parece libre.
 */
export async function chequearIdLibre(db, id) {
  const rid = Number(id);
  const problemas = [];

  const cierre = await getDoc(doc(db, 'cierres_caja', String(rid)));
  if (cierre.exists()) problemas.push(`ya existe el cierre #${rid}`);

  const renglones = await getDocs(query(
    collection(db, 'ventas_por_dia'), where('cash_register_id', '==', rid)));
  if (renglones.size > 0) problemas.push(`hay ${renglones.size} renglones de venta con el número ${rid}`);

  const ventas = await getDocs(query(
    collection(db, 'ventas'), where('cash_register_id', '==', rid)));
  if (ventas.size > 0) problemas.push(`hay ${ventas.size} ventas con el número ${rid}`);

  return { id: rid, libre: problemas.length === 0, problemas };
}

/** La caja que está abierta ahora mismo, según `caja_activa/current`. */
export async function cajaAbiertaAhora(db) {
  const snap = await getDoc(doc(db, 'caja_activa', 'current'));
  if (!snap.exists()) return null;
  const data = snap.data() || {};
  if (data.status !== 'open') return null;
  const id = data.register_id != null ? Number(data.register_id) : Number(data.id);
  return Number.isFinite(id) ? id : null;
}

/**
 * Los controles que se corren con los datos frescos justo antes de escribir.
 * Devuelve `{ ok, problemas: [] }`.
 */
export async function verificarAntesDeEscribir(db, plan, { idsPropios = [] } = {}) {
  const problemas = [];
  const original = plan.cajas[0];

  const abierta = await cajaAbiertaAhora(db);
  if (abierta !== null && plan.cajas.some(c => c.id === abierta)) {
    problemas.push(`la caja #${abierta} está abierta ahora mismo: hay que cerrarla antes de separarla`);
  }

  const snapOriginal = await getDoc(doc(db, 'cierres_caja', String(original.id)));
  if (!snapOriginal.exists()) {
    problemas.push(`no existe el cierre #${original.id}`);
  } else {
    const data = snapOriginal.data() || {};
    if (!data.fecha_cierre) problemas.push(`la caja #${original.id} figura abierta (sin fecha de cierre)`);
  }

  // Los ids nuevos tienen que estar libres. En un reintento, los que ya son
  // nuestros (quedaron escritos en la pasada anterior) no cuentan como ocupados.
  const propios = new Set(idsPropios.map(Number));
  for (const caja of plan.cajas.slice(1)) {
    if (propios.has(caja.id)) continue;
    const chequeo = await chequearIdLibre(db, caja.id);
    if (!chequeo.libre) problemas.push(`el número #${caja.id} no está libre: ${chequeo.problemas.join(', ')}`);
  }

  return { ok: problemas.length === 0, problemas };
}

/** Los campos del documento de caja, tal como los espera la webapp y el POS. */
export function documentoDeCaja(caja, { esNuevo }) {
  const datos = {
    register_id:              caja.id,
    session_id:               caja.session_id || '',
    estado:                   'cerrada',
    fecha_apertura:           Timestamp.fromDate(caja.fecha_apertura),
    fecha_cierre:             Timestamp.fromDate(caja.fecha_cierre),
    monto_inicial:            num(caja.monto_inicial),
    monto_esperado:           num(caja.monto_esperado),
    monto_final:              num(caja.monto_final),
    pendiente_conteo:         caja.pendiente_conteo === true,
    total_ventas:             num(caja.total_ventas),
    total_efectivo:           num(caja.total_efectivo),
    total_transferencia:      num(caja.total_transferencia),
    total_transacciones:      num(caja.total_transacciones),
    num_ventas_efectivo:      num(caja.num_ventas_efectivo),
    num_ventas_transferencia: num(caja.num_ventas_transferencia),
    total_retiros:            num(caja.total_retiros),
    retiros:                  caja.retiros || [],
    productos_vendidos:       caja.productos_vendidos || [],
    cerrado_desde:            'ajuste-dias',
    updated_at:               caja.updated_at,
  };
  if (esNuevo) datos.abierto_desde = 'ajuste-dias';
  // La PC y el cajero sólo se escriben si se saben. El documento de la caja que
  // conserva el número se mergea, y un vacío acá le borraba la PC que ya tenía.
  if (caja.pc_id || esNuevo)  datos.pc_id  = caja.pc_id || '';
  if (caja.cajero || esNuevo) datos.cajero = caja.cajero || '';
  // Una caja sin conteo no tiene diferencia que mostrar: la vieja tiene que
  // desaparecer, no quedar en cero (cero también es un resultado posible).
  datos.diferencia = caja.pendiente_conteo ? deleteField() : num(caja.diferencia);
  return datos;
}

/**
 * Reparte los documentos de una colección entre las cajas del plan.
 * `diaDelDoc` saca el día argentino de cada documento.
 */
async function repartirColeccion(db, nombre, ids, mapaDias, idOriginal, diaDelDoc, avisar) {
  let batch = writeBatch(db);
  let pendientes = 0;
  let movidos = 0;
  let mirados = 0;
  const sinDia = [];
  const fueraDelPlan = [];

  const flush = async (forzar) => {
    if (pendientes && (forzar || pendientes >= POR_LOTE)) {
      await batch.commit();
      batch = writeBatch(db);
      pendientes = 0;
    }
  };

  for (const id of ids) {
    const snap = await getDocs(query(collection(db, nombre), where('cash_register_id', '==', Number(id))));
    for (const d of snap.docs) {
      mirados++;
      const datos = d.data() || {};
      const ymd = diaDelDoc(datos);
      if (!ymd) { sinDia.push(d.id); continue; }
      // Un día que no está en el plan se queda donde está. Pasa con lo que la
      // pantalla no mira —un renglón borrado de un día suelto— y moverlo "por
      // las dudas" a la caja vieja sería inventar a dónde va.
      if (mapaDias[ymd] == null) { fueraDelPlan.push(d.id); continue; }
      const destino = Number(mapaDias[ymd]);
      if (Number(datos.cash_register_id) === destino) continue;
      batch.update(doc(db, nombre, d.id), { cash_register_id: destino });
      pendientes++;
      movidos++;
      await flush(false);
      if (avisar && movidos % 100 === 0) avisar({ coleccion: nombre, movidos, mirados });
    }
  }
  await flush(true);
  return { movidos, mirados, sinDia, fueraDelPlan };
}

/**
 * Lo que quedó en la base contra lo que el plan prometía.
 *
 * Se corre DESPUÉS de escribir y lee de vuelta los renglones de cada caja con
 * las mismas reglas que la pantalla. Es el único control que ve lo que pasó de
 * verdad: un renglón que la consulta no encontró, una venta que sincronizó una
 * PC en el medio de la separación, un lote que no entró. Sin esto, el diálogo
 * promete una cosa y nadie chequea que la base haya quedado así.
 */
export async function verificarDespuesDeEscribir(db, plan) {
  const cerca = (a, b) => Math.abs(num(a) - num(b)) < 0.01;
  const detalles = [];

  for (const caja of plan.cajas) {
    const snap = await getDocs(query(
      collection(db, 'ventas_por_dia'), where('cash_register_id', '==', Number(caja.id))));

    let efectivo = 0, transferencia = 0;
    const ventas = new Set();
    for (const d of snap.docs) {
      const it = d.data() || {};
      if (it.deleted === true) continue;
      if (isItemVarios2(it)) continue;
      // Los renglones sin fecha no son de ningún día: el plan no los cuenta y
      // la separación no los mueve. Contarlos acá haría saltar la alarma
      // siempre, por algo que ya estaba así antes de tocar nada.
      if (!fechaDMYtoYMD(it.fecha)) continue;
      const parte = repartoDeItem(it);
      efectivo += parte.efectivo;
      transferencia += parte.transferencia;
      const partes = d.id.split('_');
      const pc = partes.length >= 3 ? partes.slice(0, -2).join('_') : '';
      ventas.add(`${pc}|${it.num_venta}`);
    }

    const ok = cerca(efectivo, caja.total_efectivo)
            && cerca(transferencia, caja.total_transferencia)
            && ventas.size === Number(caja.total_transacciones);
    detalles.push({
      id: caja.id,
      ok,
      efectivo:      { base: efectivo,      plan: num(caja.total_efectivo) },
      transferencia: { base: transferencia, plan: num(caja.total_transferencia) },
      ventas:        { base: ventas.size,   plan: Number(caja.total_transacciones) },
    });
  }

  return { ok: detalles.every(d => d.ok), detalles };
}

/**
 * Separa la caja. `plan` es lo que devuelve `planDeSeparacion`.
 *
 * `onProgreso(texto)` se llama en cada tramo para que el diálogo cuente lo que
 * está pasando: una caja con 900 renglones tarda unos segundos.
 */
export async function ejecutarSeparacion(db, { plan, onProgreso = () => {}, idsPropios = [] }) {
  const original = plan.cajas[0];
  const idsNuevos = plan.cajas.slice(1).map(c => c.id);
  const idsInvolucrados = [original.id, ...idsNuevos];

  onProgreso('Verificando que no choque con otra caja...');
  const verificacion = await verificarAntesDeEscribir(db, plan, { idsPropios });
  if (!verificacion.ok) {
    const error = new Error(verificacion.problemas.join(' · '));
    error.problemas = verificacion.problemas;
    throw error;
  }

  // Marca de "en curso": si esto se corta a la mitad, la pantalla lo ve y
  // ofrece retomar en vez de dejar renglones repartidos sin cierre que los
  // muestre.
  const marca = {
    estado: 'en_curso',
    ts: new Date().toISOString(),
    ids_nuevos: idsNuevos,
    dias: plan.mapaDias,
  };
  await updateDoc(doc(db, 'cierres_caja', String(original.id)), { separacion: marca });

  onProgreso('Repartiendo los renglones de venta por día...');
  const renglones = await repartirColeccion(
    db, 'ventas_por_dia', idsInvolucrados, plan.mapaDias, original.id,
    (datos) => fechaDMYtoYMD(datos.fecha) || diaAR(datos.fecha_dt),
    ({ movidos }) => onProgreso(`Repartiendo los renglones de venta por día... (${movidos})`),
  );

  onProgreso('Repartiendo las ventas por día...');
  const ventas = await repartirColeccion(
    db, 'ventas', idsInvolucrados, plan.mapaDias, original.id,
    (datos) => diaAR(datos.created_at),
    ({ movidos }) => onProgreso(`Repartiendo las ventas por día... (${movidos})`),
  );

  onProgreso('Escribiendo las cajas...');
  for (const caja of plan.cajas) {
    const esNuevo = caja.id !== original.id;
    await setDoc(doc(db, 'cierres_caja', String(caja.id)),
                 documentoDeCaja(caja, { esNuevo }), { merge: true });
  }

  onProgreso('Verificando cómo quedó...');
  const quedoBien = await verificarDespuesDeEscribir(db, plan);

  // La marca sólo dice "hecha" si la base quedó como el plan. Si no coincide
  // queda en "revisar": la pantalla lo muestra y la separación se puede
  // retomar, en vez de dar por buena una cuenta que no cierra.
  await updateDoc(doc(db, 'cierres_caja', String(original.id)), {
    separacion: {
      ...marca,
      estado: quedoBien.ok ? 'hecha' : 'revisar',
      terminado: new Date().toISOString(),
    },
  });

  return {
    ids: idsInvolucrados,
    idsNuevos,
    renglones,
    ventas,
    verificacion: quedoBien,
  };
}

/**
 * La marca de una separación que no terminó bien, si quedó alguna: cortada a
 * la mitad (`en_curso`) o terminada con los números sin cerrar (`revisar`).
 * Sirve para retomarla con el mismo reparto de días.
 */
export function separacionPendiente(cierreDoc) {
  const s = cierreDoc?.separacion;
  if (!s || (s.estado !== 'en_curso' && s.estado !== 'revisar')) return null;
  return {
    estado: s.estado,
    ids_nuevos: (s.ids_nuevos || []).map(Number),
    dias: s.dias || {},
    ts: aFecha(s.ts),
  };
}
