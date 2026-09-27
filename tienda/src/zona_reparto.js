/**
 * La zona de reparto: hasta dónde llega el envío, dibujada en un mapa.
 *
 * Reemplaza al radio en kilómetros cuando está prendida. Un radio es un
 * círculo perfecto alrededor del local, y la ciudad no es un círculo: del otro
 * lado de la Circunvalación hay barrios a cuatro kilómetros a los que no se
 * llega, y en la dirección de la avenida se llega a diez sin problema.
 *
 * La zona son una o más áreas:
 *
 *   · `incluir` — donde se reparte. Puede haber varias, separadas.
 *   · `excluir` — un recorte: aunque caiga adentro de un área de reparto, ahí
 *     no se llega (un country cerrado, una villa, una isla de calles cortadas).
 *
 * Un punto está adentro si cae en alguna `incluir` y en ninguna `excluir`.
 *
 * Este archivo es la ÚNICA copia de la regla. Lo importan el checkout, las
 * funciones `envio` y `crear-pedido` del servidor y el editor del panel: si
 * cada uno decidiera a su manera, el panel mostraría "llegamos" en una esquina
 * donde la tienda después no deja pedir. Por lo mismo no puede importar nada
 * de Firebase ni del DOM.
 *
 * Forma en `tienda_config/settings`:
 *
 *   entrega.zona = {
 *     activa: true,
 *     areas: [{ tipo: 'incluir', puntos: [{ lat, lng }, …] }, …],
 *   }
 *
 * Un arreglo de mapas con un arreglo adentro, y no un arreglo de arreglos:
 * Firestore no admite arreglos anidados y rechaza el documento entero.
 */

export const TIPOS = ['incluir', 'excluir'];

// Topes para que un documento editado a mano, o un editor con un bug, no deje
// la configuración pública de la tienda en varios megas. Una zona a mano rara
// vez pasa de cuarenta puntos.
export const MAX_AREAS = 30;
export const MAX_PUNTOS = 400;

// Kilómetros por grado de latitud. En Córdoba el error de tratar la Tierra
// como esfera es de metros en toda la ciudad, muy debajo de lo que se dibuja
// con el dedo.
const KM_POR_GRADO = 111.32;

/* ── Forma ────────────────────────────────────────────────────────────────── */

function coordenada(p) {
  const lat = Number(p?.lat);
  const lng = Number(p?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // Seis decimales son once centímetros: más es ruido que ocupa lugar.
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

/**
 * La zona en una sola forma, venga de donde venga: sin áreas de menos de tres
 * puntos, sin puntos repetidos seguidos, sin el punto de cierre repetido y con
 * los topes aplicados. Lo que no se entiende se descarta en vez de romper.
 */
export function sanearZona(crudo) {
  const areas = [];
  for (const area of Array.isArray(crudo?.areas) ? crudo.areas : []) {
    if (areas.length >= MAX_AREAS) break;
    const tipo = TIPOS.includes(area?.tipo) ? area.tipo : 'incluir';

    const puntos = [];
    for (const p of Array.isArray(area?.puntos) ? area.puntos : []) {
      const c = coordenada(p);
      if (!c) continue;
      const anterior = puntos[puntos.length - 1];
      if (anterior && anterior.lat === c.lat && anterior.lng === c.lng) continue;
      puntos.push(c);
      if (puntos.length >= MAX_PUNTOS) break;
    }
    // El polígono se cierra solo: si el último repite al primero, sobra.
    const [primero] = puntos;
    const ultimo = puntos[puntos.length - 1];
    if (puntos.length > 1 && primero.lat === ultimo.lat && primero.lng === ultimo.lng) puntos.pop();

    if (puntos.length >= 3) areas.push({ tipo, puntos });
  }
  return { activa: crudo?.activa === true, areas };
}

/** Si la zona manda: prendida y con al menos un área de reparto. */
export function zonaActiva(entrega) {
  const zona = sanearZona(entrega?.zona);
  return zona.activa && zona.areas.some(a => a.tipo === 'incluir');
}

/* ── Adentro o afuera ─────────────────────────────────────────────────────── */

/**
 * Cruce de rayos: se tira una línea horizontal desde el punto y se cuentan los
 * bordes que corta. Impar es adentro. Anda con polígonos cóncavos y con los
 * que se cruzan a sí mismos, que es lo que sale de arrastrar puntos a mano.
 * En coordenadas planas: a la escala de una ciudad la curvatura no se nota.
 */
export function puntoEnPoligono(punto, puntos) {
  const x = Number(punto?.lng);
  const y = Number(punto?.lat);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

  let adentro = false;
  for (let i = 0, j = puntos.length - 1; i < puntos.length; j = i++) {
    const xi = puntos[i].lng, yi = puntos[i].lat;
    const xj = puntos[j].lng, yj = puntos[j].lat;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      adentro = !adentro;
    }
  }
  return adentro;
}

/** Si un punto cae en la zona: en algún área de reparto y en ningún recorte. */
export function dentroDeZona(punto, zonaCruda) {
  const zona = sanearZona(zonaCruda);
  const incluido = zona.areas.some(a => a.tipo === 'incluir' && puntoEnPoligono(punto, a.puntos));
  if (!incluido) return false;
  return !zona.areas.some(a => a.tipo === 'excluir' && puntoEnPoligono(punto, a.puntos));
}

/**
 * La decisión que toman el checkout y el servidor con la config de la tienda.
 *
 * @returns {'sin_zona'|'adentro'|'afuera'|'sin_ubicacion'}
 *   `sin_zona` quiere decir que la zona no manda y decide el radio en km, como
 *   siempre. `sin_ubicacion` es una dirección sin coordenadas: con la zona
 *   prendida no se puede saber si se llega, así que no se acepta el envío.
 */
export function evaluarZona(destino, entrega) {
  if (!zonaActiva(entrega)) return 'sin_zona';
  if (!coordenada(destino)) return 'sin_ubicacion';
  return dentroDeZona(destino, entrega.zona) ? 'adentro' : 'afuera';
}

/* ── Medidas ──────────────────────────────────────────────────────────────── */

/** Distancia en línea recta entre dos puntos, en km (haversine). */
export function kmEntre(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Hasta dónde llega la zona desde el local, en línea recta: el punto de
 * reparto más lejano. Sirve para el texto "hasta X km" y para acotar la
 * búsqueda de direcciones. null si la zona no manda o no hay origen.
 */
export function alcanceKm(origen, entrega) {
  if (!zonaActiva(entrega) || !coordenada(origen)) return null;
  const zona = sanearZona(entrega.zona);
  let maximo = 0;
  for (const area of zona.areas) {
    if (area.tipo !== 'incluir') continue;
    for (const p of area.puntos) maximo = Math.max(maximo, kmEntre(origen, p));
  }
  return Math.round(maximo * 10) / 10;
}

/** El centro de un polígono como promedio de sus puntos: alcanza para escalarlo. */
export function centroDe(puntos) {
  const n = puntos.length || 1;
  return {
    lat: puntos.reduce((t, p) => t + p.lat, 0) / n,
    lng: puntos.reduce((t, p) => t + p.lng, 0) / n,
  };
}

/** Superficie en km², con la fórmula del cordón sobre coordenadas planas. */
export function areaKm2(puntos) {
  if (!puntos?.length || puntos.length < 3) return 0;
  const { lat: lat0 } = centroDe(puntos);
  const kx = KM_POR_GRADO * Math.cos(lat0 * Math.PI / 180);
  let doble = 0;
  for (let i = 0, j = puntos.length - 1; i < puntos.length; j = i++) {
    doble += (puntos[j].lng * kx) * (puntos[i].lat * KM_POR_GRADO)
           - (puntos[i].lng * kx) * (puntos[j].lat * KM_POR_GRADO);
  }
  return Math.abs(doble) / 2;
}

/* ── Formas para el editor ────────────────────────────────────────────────── */

/**
 * Un círculo como polígono: el punto de partida del editor. Con 36 lados se ve
 * redondo y cada punto queda a mano para arrastrarlo.
 */
export function circulo(centro, radioKm, lados = 36) {
  const dLat = radioKm / KM_POR_GRADO;
  const dLng = radioKm / (KM_POR_GRADO * Math.cos(centro.lat * Math.PI / 180));
  const puntos = [];
  for (let i = 0; i < lados; i++) {
    const angulo = (2 * Math.PI * i) / lados;
    puntos.push(coordenada({
      lat: centro.lat + dLat * Math.sin(angulo),
      lng: centro.lng + dLng * Math.cos(angulo),
    }));
  }
  return puntos;
}

/**
 * Agranda o achica un área sin cambiarle la forma, desde su centro. Las dos
 * distancias al centro se multiplican por lo mismo, así que las proporciones
 * se mantienen aunque un grado de longitud mida menos que uno de latitud.
 */
export function escalar(puntos, factor, centro = centroDe(puntos)) {
  return puntos.map(p => coordenada({
    lat: centro.lat + (p.lat - centro.lat) * factor,
    lng: centro.lng + (p.lng - centro.lng) * factor,
  }));
}
