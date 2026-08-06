/**
 * Cotizacion del envio.
 *
 * Mide la distancia real de manejo hasta el domicilio con la Routes API y le
 * aplica los tramos de precio configurados en `tienda_config`.
 *
 * Vive en el servidor por dos razones distintas, y las dos importan:
 *
 *   · La clave de Routes no puede restringirse por dominio, porque la llamada
 *     no sale de un navegador. Una clave asi en el bundle publico es una
 *     factura de Google esperando a que alguien la encuentre.
 *   · El precio lo decide el servidor. Del lado del cliente, el envio es un
 *     numero en la memoria del navegador y cualquiera lo pone en cero.
 *
 * Distancia de manejo y no en linea recta: en Cordoba el rio y las vias hacen
 * que dos puntos a tres kilometros de distancia esten a siete de recorrido, y
 * el que maneja hace los siete.
 */

const PROYECTO = 'mari-d7c71';

// La configuracion cambia poco y esta funcion puede ejecutarse muchas veces
// seguidas. La instancia se reusa entre invocaciones mientras siga caliente.
let _configCache = null;
let _configCacheAt = 0;
const CONFIG_TTL_MS = 5 * 60_000;

export default async (peticion) => {
  if (peticion.method !== 'POST') {
    return new Response('Método no permitido', { status: 405 });
  }

  const clave = process.env.GOOGLE_ROUTES_KEY;
  if (!clave) {
    // Sin clave la tienda cotiza "a confirmar" y el pedido entra igual.
    console.warn('[envio] falta GOOGLE_ROUTES_KEY');
    return new Response('Sin clave de Routes', { status: 503 });
  }

  let destino;
  try {
    ({ destino } = await peticion.json());
  } catch {
    return new Response('Cuerpo inválido', { status: 400 });
  }

  if (!coordenadaValida(destino)) {
    return new Response('Destino inválido', { status: 400 });
  }

  let config;
  try {
    config = await leerConfig();
  } catch (err) {
    console.error('[envio] no se pudo leer la configuración:', err);
    return new Response('No se pudo leer la configuración', { status: 502 });
  }

  const origen = config.origen;
  if (!coordenadaValida(origen)) {
    console.error('[envio] la configuración no tiene un origen válido');
    return new Response('Sin origen configurado', { status: 500 });
  }

  let metros;
  try {
    metros = await medir(origen, destino, clave);
  } catch (err) {
    console.error('[envio] Routes falló:', err);
    return new Response('No se pudo medir la distancia', { status: 502 });
  }

  if (metros === null) {
    // Google no encontró camino. Pasa con coordenadas caídas en el medio del
    // campo o del otro lado de un río sin puente.
    return Response.json({ km: null, precio: null, motivo: 'sin_ruta' });
  }

  const km = Math.round((metros / 1000) * 100) / 100;
  const entrega = config.entrega || {};
  const radio = Number(entrega.radio_max_km) || 0;

  if (radio > 0 && km > radio) {
    return Response.json({ km, precio: null, fuera_de_radio: true });
  }

  return Response.json({ km, precio: precioPorDistancia(km, entrega.tramos) });
};

/* ── Datos ────────────────────────────────────────────────────────────────── */

function coordenadaValida(c) {
  return c
    && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))
    && Math.abs(Number(c.lat)) <= 90 && Math.abs(Number(c.lng)) <= 180;
}

function precioPorDistancia(km, tramos) {
  const lista = (tramos || [])
    .filter(t => Number(t?.hasta_km) > 0 && Number(t?.precio) >= 0)
    .map(t => ({ hasta_km: Number(t.hasta_km), precio: Number(t.precio) }))
    .sort((a, b) => a.hasta_km - b.hasta_km);

  const tramo = lista.find(t => km <= t.hasta_km);
  return tramo ? tramo.precio : null;
}

/**
 * La config se lee sin credenciales: `tienda_config` es publico por reglas, que
 * es lo mismo que ve la tienda en el navegador.
 */
async function leerConfig() {
  if (_configCache && Date.now() - _configCacheAt < CONFIG_TTL_MS) return _configCache;

  const url = `https://firestore.googleapis.com/v1/projects/${PROYECTO}` +
              '/databases/(default)/documents/tienda_config/settings';
  const respuesta = await fetch(url);
  if (!respuesta.ok) throw new Error(`Firestore devolvió ${respuesta.status}`);

  const crudo = await respuesta.json();
  _configCache = aplanar(crudo.fields || {});
  _configCacheAt = Date.now();
  return _configCache;
}

function aplanar(campos) {
  const salida = {};
  for (const [clave, valor] of Object.entries(campos)) salida[clave] = valorDe(valor);
  return salida;
}

function valorDe(v) {
  if (v == null) return null;
  if ('stringValue'    in v) return v.stringValue;
  if ('integerValue'   in v) return Number(v.integerValue);
  if ('doubleValue'    in v) return Number(v.doubleValue);
  if ('booleanValue'   in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue'      in v) return null;
  if ('mapValue'       in v) return aplanar(v.mapValue.fields || {});
  if ('arrayValue'     in v) return (v.arrayValue.values || []).map(valorDe);
  return null;
}

/* ── Routes API ───────────────────────────────────────────────────────────── */

async function medir(origen, destino, clave) {
  const respuesta = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': clave,
      // Routes cobra segun los campos que se piden. Pidiendo solo la distancia
      // se queda en el tramo mas barato de la tarifa.
      'X-Goog-FieldMask': 'routes.distanceMeters',
    },
    body: JSON.stringify({
      origin:      { location: { latLng: { latitude: Number(origen.lat),  longitude: Number(origen.lng) } } },
      destination: { location: { latLng: { latitude: Number(destino.lat), longitude: Number(destino.lng) } } },
      travelMode: 'DRIVE',
      // Sin tráfico en vivo: el reparto no sale en el momento, así que el
      // estado del tránsito de ahora no dice nada y encarece la consulta.
      routingPreference: 'TRAFFIC_UNAWARE',
      units: 'METRIC',
      regionCode: 'AR',
    }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Routes devolvió ${respuesta.status}: ${detalle.slice(0, 300)}`);
  }

  const datos = await respuesta.json();
  const metros = datos?.routes?.[0]?.distanceMeters;
  return Number.isFinite(metros) ? metros : null;
}
