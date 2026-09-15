/**
 * Las reglas de los reclamos.
 *
 * Las usan el formulario de la tienda (para decir qué falta antes de mandar),
 * la función `crear-reclamo` (que las vuelve a aplicar: lo que llega al
 * servidor lo puede haber armado cualquiera) y el panel. No pueden depender de
 * Firebase ni del DOM.
 *
 * Un reclamo está siempre atado a un pedido. En el pedido queda un resumen
 * (`pedido.reclamo`) con lo que el cliente puede ver: el estado y la respuesta
 * del local. El detalle y las fotos viven en `tienda_reclamos`, que solo lee el
 * panel.
 */

export const MOTIVOS = [
  { clave: 'roto', texto: 'Llegó roto o con fallas', conProductos: true },
  { clave: 'falta', texto: 'Faltó algo', conProductos: true },
  { clave: 'otro_producto', texto: 'Vino otro producto o color', conProductos: true },
  { clave: 'cobro', texto: 'Me cobraron mal', conProductos: false },
  { clave: 'no_llego', texto: 'No me llegó', conProductos: false, soloEnvio: true },
  { clave: 'otro', texto: 'Otra cosa', conProductos: false },
];

export const LIMITES = {
  detalleMin: 10,
  detalleMax: 600,
  fotos: 3,
  // Ya achicada en el celular (1600 px en JPEG): una foto así pesa unos 300 kB.
  // El tope deja entrar las tres en un solo envío sin pasar el límite de las
  // funciones de Netlify (6 MB, y en base64 pesan un tercio más).
  bytesFoto: 1_000_000,
  diasParaReclamar: 30,
  // Un pedido admite pocos reclamos: más que esto ya es una charla por WhatsApp.
  reclamosPorPedido: 3,
};

/** Los que el local todavía tiene que mirar. */
export const ABIERTOS = ['nuevo', 'revisando'];

// Recién entrado no hay nada que reclamar, y cancelado tampoco.
const RECLAMABLES = new Set(['preparando', 'listo', 'en_camino', 'entregado']);

const LEGIBLES = {
  nuevo: 'Recibido',
  revisando: 'Lo estamos revisando',
  resuelto: 'Resuelto',
  rechazado: 'Revisado',
};

export function estadoLegible(estado) {
  return LEGIBLES[estado] || 'Recibido';
}

export function motivoLegible(clave) {
  return MOTIVOS.find(m => m.clave === clave)?.texto || 'Otra cosa';
}

/** Los motivos que tienen sentido para este pedido. */
export function motivosPara(pedido) {
  const conEnvio = pedido?.entrega?.modo === 'delivery';
  return MOTIVOS.filter(m => !m.soloEnvio || conEnvio);
}

/** Una fecha de Firestore (Timestamp, texto ISO o Date) como Date, o null. */
export function fechaDe(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor;
  if (typeof valor.toDate === 'function') return valor.toDate();
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/**
 * Si este pedido admite un reclamo ahora.
 * @returns {{puede: boolean, motivo: null|'estado'|'plazo'|'abierto'}}
 */
export function puedeReclamar(pedido, ahora = new Date()) {
  if (!RECLAMABLES.has(pedido?.estado)) return { puede: false, motivo: 'estado' };
  if (ABIERTOS.includes(pedido.reclamo?.estado)) return { puede: false, motivo: 'abierto' };
  if (pedido.estado === 'entregado') {
    const desde = fechaDe(pedido.entregado_en) || fechaDe(pedido.creado);
    const limite = LIMITES.diasParaReclamar * 86400000;
    if (desde && ahora.getTime() - desde.getTime() > limite) return { puede: false, motivo: 'plazo' };
  }
  return { puede: true, motivo: null };
}

/**
 * Qué le falta a un reclamo para poder mandarse, o null si está completo.
 *
 * @param {{motivo, renglones, detalle, fotos}} entrada
 * @returns {{campo: string, mensaje: string}|null}
 */
export function validarReclamo(entrada, pedido) {
  const motivo = motivosPara(pedido).find(m => m.clave === entrada?.motivo);
  if (!motivo) return { campo: 'motivo', mensaje: 'Elegí qué pasó con el pedido.' };

  // Los productos van por número de renglón y no por id: el mismo producto
  // puede venir en dos colores, o suelto y por pack, en el mismo pedido.
  const renglones = Array.isArray(entrada.renglones) ? entrada.renglones : [];
  const cantidad = (pedido?.items || []).length;
  if (motivo.conProductos && !renglones.length) {
    return { campo: 'renglones', mensaje: 'Marcá con qué producto fue el problema.' };
  }
  const validos = renglones.every(n => Number.isInteger(n) && n >= 0 && n < cantidad);
  if (!validos || new Set(renglones).size !== renglones.length) {
    return { campo: 'renglones', mensaje: 'Ese producto no está en este pedido.' };
  }

  const detalle = String(entrada.detalle ?? '').trim();
  if (detalle.length < LIMITES.detalleMin) {
    return { campo: 'detalle', mensaje: 'Contanos un poco más qué pasó, así lo resolvemos más rápido.' };
  }
  if (detalle.length > LIMITES.detalleMax) {
    return { campo: 'detalle', mensaje: `Es un poco largo: hasta ${LIMITES.detalleMax} letras.` };
  }

  const fotos = Array.isArray(entrada.fotos) ? entrada.fotos : [];
  if (fotos.length > LIMITES.fotos) {
    return { campo: 'fotos', mensaje: `Podés mandar hasta ${LIMITES.fotos} fotos.` };
  }
  return null;
}

/** Lo que queda escrito en el pedido: lo que el cliente puede ver, nada más. */
export function resumenDelReclamo(reclamo) {
  return {
    id: reclamo.id,
    estado: reclamo.estado,
    motivo: reclamo.motivo,
    respuesta: reclamo.respuesta ?? null,
    creado: reclamo.creado,
    actualizado: reclamo.actualizado,
  };
}
