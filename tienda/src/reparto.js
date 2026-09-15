/**
 * Las reglas del reparto.
 *
 * Qué puede hacer el repartidor con cada pedido, en qué orden conviene
 * llevarlos y cómo se arma el viaje en Google Maps. Las usan la pantalla del
 * repartidor (`reparto/`) y la función `reparto-mover`, que las vuelve a
 * aplicar. No pueden depender de Firebase ni del DOM.
 */
import { pesos } from './formato.js';

export const ESTADOS_EN_CURSO = ['nuevo', 'preparando', 'listo', 'en_camino'];

const ORDEN = ['nuevo', 'preparando', 'listo', 'en_camino', 'entregado'];

const PASOS = {
  nuevo:      { estado: 'preparando', texto: 'Empezar a preparar' },
  preparando: { estado: 'listo',      texto: 'Está listo' },
  listo:      { estado: 'en_camino',  texto: 'Salgo a entregarlo' },
  en_camino:  { estado: 'entregado',  texto: 'Lo entregué' },
};

export const ETIQUETAS = {
  nuevo: 'Nuevo',
  preparando: 'Preparando',
  listo: 'Listo para llevar',
  en_camino: 'En camino',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};

const esEnvio = (p) => p?.entrega?.modo === 'delivery';

/** El botón que corresponde al estado del pedido, o null si ya terminó. */
export function siguientePaso(pedido) {
  return PASOS[pedido?.estado] || null;
}

/**
 * Si el repartidor puede pasar este pedido a ese estado, o por qué no.
 * Para adelante y salteando pasos, sí (lo entregó sin marcar que salió); para
 * atrás, no: eso se corrige desde el panel. Cancelar también es del panel.
 *
 * @returns {null|'no_es_envio'|'terminado'|'hacia_atras'|'estado_invalido'}
 */
export function validarMovimiento(pedido, estado) {
  const destino = ORDEN.indexOf(estado);
  if (destino < 1) return 'estado_invalido';
  if (!esEnvio(pedido)) return 'no_es_envio';
  if (!ESTADOS_EN_CURSO.includes(pedido?.estado)) return 'terminado';
  if (destino <= ORDEN.indexOf(pedido.estado)) return 'hacia_atras';
  return null;
}

/**
 * Si el pedido ya está en ese paso o más adelante. La pantalla lo usa para no
 * esperar la respuesta de `reparto-mover` cuando la base ya muestra el cambio.
 * Un pedido cancelado no llegó a ningún paso.
 */
export function yaLlego(pedido, estado) {
  const destino = ORDEN.indexOf(estado);
  const actual = ORDEN.indexOf(pedido?.estado);
  return destino >= 1 && actual >= destino;
}

/* ── Distancias y ruta ────────────────────────────────────────────────────── */

const esCoordenada = (c) => Number.isFinite(Number(c?.lat)) && Number.isFinite(Number(c?.lng))
  && !(Number(c.lat) === 0 && Number(c.lng) === 0);

const RADIO_TIERRA_KM = 6371;
const rad = (g) => (g * Math.PI) / 180;

/** Distancia en línea recta (haversine), en km. */
export function distanciaKm(a, b) {
  const dLat = rad(Number(b.lat) - Number(a.lat));
  const dLng = rad(Number(b.lng) - Number(a.lng));
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(Number(a.lat))) * Math.cos(rad(Number(b.lat))) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const fechaDe = (v) => {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/**
 * El orden en que conviene llevarlos: siempre el más cercano al punto anterior,
 * arrancando desde donde está el repartidor. No es el recorrido óptimo, pero con
 * los cinco o seis pedidos de una salida da casi lo mismo y se entiende: "el que
 * te queda más cerca".
 *
 * Sin posición se arranca por el que entró primero. Los que no tienen
 * coordenadas (dirección que no se pudo ubicar) van al final.
 *
 * @returns {Array<{pedido, km: number|null, kmDesdeAnterior: number|null}>}
 *          `km`: desde el punto de partida hasta esa parada, en línea recta
 */
export function ordenarRuta(pedidos, desde) {
  const porLlegada = [...(pedidos || [])].sort((a, b) => fechaDe(a.creado) - fechaDe(b.creado));
  const conMapa = porLlegada.filter(p => esCoordenada(p?.entrega?.coordenadas));
  const sinMapa = porLlegada.filter(p => !esCoordenada(p?.entrega?.coordenadas));

  const ruta = [];
  let punto = esCoordenada(desde) ? desde : null;
  const origen = punto;
  const pendientes = [...conMapa];
  while (pendientes.length) {
    let elegido = 0;
    if (punto) {
      let mejor = Infinity;
      pendientes.forEach((p, i) => {
        const d = distanciaKm(punto, p.entrega.coordenadas);
        if (d < mejor) { mejor = d; elegido = i; }
      });
    }
    const [p] = pendientes.splice(elegido, 1);
    const coordenadas = p.entrega.coordenadas;
    ruta.push({
      pedido: p,
      km: origen ? distanciaKm(origen, coordenadas) : null,
      kmDesdeAnterior: punto ? distanciaKm(punto, coordenadas) : null,
    });
    punto = coordenadas;
  }
  return [...ruta, ...sinMapa.map(p => ({ pedido: p, km: null, kmDesdeAnterior: null }))];
}

/** Los que ya se pueden llevar. */
export function paraLlevar(pedidos) {
  return (pedidos || []).filter(p => p.estado === 'listo' || p.estado === 'en_camino');
}

/** Los que todavía se están armando en el local. */
export function enPreparacion(pedidos) {
  return (pedidos || []).filter(p => p.estado === 'nuevo' || p.estado === 'preparando');
}

/* ── Google Maps ──────────────────────────────────────────────────────────── */

const URL_MAPS = 'https://www.google.com/maps/dir/';

function destinoDe(pedido) {
  const c = pedido?.entrega?.coordenadas;
  if (esCoordenada(c)) return `${Number(c.lat)},${Number(c.lng)}`;
  const direccion = String(pedido?.entrega?.direccion || '').trim();
  return direccion ? `${direccion}, Córdoba, Argentina` : null;
}

function armar(parametros) {
  const url = new URL(URL_MAPS);
  url.searchParams.set('api', '1');
  for (const [k, v] of Object.entries(parametros)) if (v) url.searchParams.set(k, v);
  url.searchParams.set('travelmode', 'driving');
  return url.toString();
}

/**
 * El viaje a un pedido. Sin `origin`: Google Maps arranca desde donde está el
 * celular, que es lo que quiere el repartidor.
 */
export function enlaceNavegar(pedido) {
  const destino = destinoDe(pedido);
  return destino ? armar({ destination: destino }) : null;
}

// Google Maps acepta hasta nueve paradas intermedias en el enlace.
const MAX_PARADAS = 9;

/** La ruta pasando por todos, en el orden dado. */
export function enlaceRuta(pedidos) {
  const destinos = (pedidos || []).map(destinoDe).filter(Boolean);
  if (!destinos.length) return null;
  if (destinos.length === 1) return enlaceNavegar(pedidos.find(p => destinoDe(p)));
  const final = destinos.slice(0, MAX_PARADAS + 1);
  return armar({
    destination: final[final.length - 1],
    waypoints: final.slice(0, -1).join('|'),
  });
}

/* ── Cobro y resumen ──────────────────────────────────────────────────────── */

/** Qué tiene que hacer el repartidor con la plata de este pedido. */
export function cobroDe(pedido) {
  const efectivo = pedido?.pago?.modo === 'efectivo';
  const pagado = pedido?.pago?.pagado === true;
  const monto = Number(pedido?.total) || 0;
  let texto;
  if (efectivo) texto = pagado ? 'Cobrado en efectivo' : `Cobrar ${pesos(monto)} en efectivo`;
  else texto = pagado ? 'Pagó por transferencia' : 'Transferencia sin confirmar: consultá al local';
  if (efectivo && !pagado && pedido?.entrega?.envio_a_confirmar) texto += ' (más el envío a confirmar)';
  return { efectivo, monto, pagado, texto };
}

/** 'AAAA-MM-DD' en hora de Argentina: el día en que se entregó para el local. */
export function diaArgentina(fecha = new Date()) {
  // en-CA escribe las fechas como AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(fecha);
}

/** Cuántos entregó y cuánta plata en efectivo tiene que rendir. */
export function resumenDelDia(entregados) {
  const lista = (entregados || []).filter(p => p.estado === 'entregado');
  return {
    entregados: lista.length,
    efectivo: lista.filter(p => p.pago?.modo === 'efectivo' && p.pago?.pagado === true)
      .reduce((s, p) => s + (Number(p.total) || 0), 0),
  };
}
