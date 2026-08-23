/**
 * El mapa del checkout.
 *
 * Devuelve una imagen de la Maps Static API con el area que le pide el
 * navegador. Existe por lo mismo que las otras dos funciones: la clave de
 * Google se queda del lado del servidor. Una clave de Maps en el bundle publico
 * se puede restringir por dominio, pero seria una segunda clave para mantener y
 * la misma no sirve para Routes, que se llama desde el servidor.
 *
 * La imagen es solo el fondo. Los marcadores los dibuja el navegador encima con
 * los colores de la marca, en vez de los pines rojos de Google: el centro y el
 * zoom los calcula `src/mapa.js`, asi que sabe exactamente donde cae cada punto.
 *
 * A este volumen no se paga. La Maps Static API tiene 10.000 llamadas gratis por
 * mes y una libreria de barrio no se acerca; ademas cada imagen se cachea un dia
 * y las que se repiten no vuelven a pedirse.
 */

const PROYECTO = 'mari-d7c71';

let _areaCache = null;
let _areaCacheAt = 0;
const AREA_TTL_MS = 10 * 60_000;

// Tope de la API en el tramo sin costo por imagen. Se pide hasta esto y el
// navegador la estira: con `scale=2` llegan 1.280 px de ancho reales, de sobra
// para los 700 y pico que mide el bloque en una pantalla grande.
const LADO_MAXIMO = 640;

// Hasta donde puede alejarse el centro del local. No es por seguridad de los
// datos —el mapa es publico— sino por la factura: sin esto la funcion es un
// generador de mapas de cualquier parte del mundo con nuestra clave.
const RADIO_PERMITIDO_KM = 60;

export default async (peticion) => {
  // Aviso de precalentamiento del checkout: despertarse ya, para que la
  // imagen de verdad no pague el arranque en frío. Sin pedirle nada a Google.
  if (new URL(peticion.url).searchParams.has('warmup')) {
    return new Response(null, { status: 204 });
  }

  const clave = process.env.GOOGLE_MAPS_STATIC_KEY
             || process.env.GOOGLE_PLACES_KEY
             || process.env.GOOGLE_ROUTES_KEY;
  if (!clave) {
    console.warn('[mapa] falta la clave de Google');
    return new Response('Sin clave de Maps', { status: 503 });
  }

  const parametros = new URL(peticion.url).searchParams;
  const pedido = validar(parametros);
  if (!pedido) return new Response('Parámetros inválidos', { status: 400 });

  const area = await areaDeReparto();
  if (area && lejosDe(area, pedido)) {
    return new Response('Fuera del área', { status: 400 });
  }

  const url = new URL('https://maps.googleapis.com/maps/api/staticmap');
  url.searchParams.set('center', `${pedido.lat},${pedido.lng}`);
  url.searchParams.set('zoom', String(pedido.zoom));
  url.searchParams.set('size', `${pedido.ancho}x${pedido.alto}`);
  url.searchParams.set('scale', '2');
  url.searchParams.set('maptype', 'roadmap');
  url.searchParams.set('language', 'es-419');
  url.searchParams.set('region', 'AR');
  url.searchParams.set('key', clave);

  // Se apagan los puntos de interes y el transporte. El mapa esta para ubicar
  // dos direcciones, y cada restaurante y cada parada de colectivo dibujados
  // encima compiten con los dos marcadores que importan.
  for (const estilo of [
    'feature:poi|visibility:off',
    'feature:transit|visibility:off',
    'feature:road|element:labels.icon|visibility:off',
  ]) {
    url.searchParams.append('style', estilo);
  }

  let respuesta;
  try {
    respuesta = await fetch(url);
  } catch (err) {
    console.error('[mapa] no se pudo pedir la imagen:', err);
    return new Response('No se pudo generar el mapa', { status: 502 });
  }

  if (!respuesta.ok) {
    // Google manda el motivo en texto plano y es el unico lugar donde se lee:
    // el caso tipico es la API sin habilitar en el proyecto.
    const detalle = await respuesta.text();
    console.error(`[mapa] Static Maps devolvió ${respuesta.status}: ${detalle.slice(0, 300)}`);
    return new Response('No se pudo generar el mapa', { status: 502 });
  }

  return new Response(await respuesta.arrayBuffer(), {
    headers: {
      'Content-Type': respuesta.headers.get('Content-Type') || 'image/png',
      // El mapa de una direccion no cambia. Se cachea en el navegador y en el
      // CDN, asi volver al checkout no vuelve a gastar una llamada.
      'Cache-Control': 'public, max-age=86400, s-maxage=604800, immutable',
    },
  });
};

/* ── Entrada ──────────────────────────────────────────────────────────────── */

function validar(p) {
  const lat = Number(p.get('lat'));
  const lng = Number(p.get('lng'));
  const zoom = Number(p.get('zoom'));
  const ancho = Number(p.get('ancho'));
  const alto = Number(p.get('alto'));

  const entero = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

  if (!Number.isFinite(lat) || Math.abs(lat) > 85) return null;
  if (!Number.isFinite(lng) || Math.abs(lng) > 180) return null;
  if (!entero(zoom, 1, 20)) return null;
  if (!entero(ancho, 80, LADO_MAXIMO)) return null;
  if (!entero(alto, 80, LADO_MAXIMO)) return null;

  return { lat, lng, zoom, ancho, alto };
}

/** Distancia en linea recta, para el control de area. Alcanza y sobra. */
function lejosDe(area, punto) {
  const R = 6371;
  const aRad = g => g * Math.PI / 180;
  const dLat = aRad(punto.lat - area.lat);
  const dLng = aRad(punto.lng - area.lng);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(aRad(area.lat)) * Math.cos(aRad(punto.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a)) > RADIO_PERMITIDO_KM;
}

/* ── Origen ───────────────────────────────────────────────────────────────── */

async function areaDeReparto() {
  if (_areaCache && Date.now() - _areaCacheAt < AREA_TTL_MS) return _areaCache;

  try {
    const url = `https://firestore.googleapis.com/v1/projects/${PROYECTO}` +
                '/databases/(default)/documents/tienda_config/settings';
    const respuesta = await fetch(url);
    if (!respuesta.ok) return null;

    const crudo = await respuesta.json();
    const origen = crudo?.fields?.origen?.mapValue?.fields;
    const lat = Number(origen?.lat?.doubleValue ?? origen?.lat?.integerValue);
    const lng = Number(origen?.lng?.doubleValue ?? origen?.lng?.integerValue);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    _areaCache = { lat, lng };
    _areaCacheAt = Date.now();
    return _areaCache;
  } catch (err) {
    // Sin el control de area el mapa igual sale. Es un cerrojo contra el abuso,
    // no algo de lo que dependa el checkout.
    console.warn('[mapa] no se pudo leer el origen:', err);
    return null;
  }
}
