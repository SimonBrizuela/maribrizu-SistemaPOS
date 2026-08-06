/**
 * Autocompletado de direcciones.
 *
 * Le pasa las busquedas a la Places API (New) desde el servidor en vez de
 * cargar la libreria de Maps en el navegador. Tres motivos, en orden de peso:
 *
 *   · La clave se queda en el servidor. Cargar Places en el navegador obliga a
 *     publicar una clave y restringirla por dominio, y esa restriccion no sirve
 *     para Routes, que se llama desde el servidor. Una clave por lado significa
 *     dos claves para mantener; asi es una sola y no viaja nunca.
 *   · No se le agrega la libreria de Maps al bundle. Son cientos de kilobytes
 *     para un campo de texto de una sola pantalla.
 *   · Las sugerencias se pintan con el mismo desplegable que las del catalogo,
 *     en vez de meter un componente de Google con su propio estilo en medio del
 *     formulario.
 *
 * Dos operaciones:
 *   POST { q }        -> sugerencias  [{ id, titulo, detalle }]
 *   POST { placeId }  -> coordenadas  { direccion, lat, lng }
 *
 * La segunda es la que cuesta: `places:autocomplete` es barata y
 * `places/{id}` con el campo `location` entra en el tramo mas barato de la
 * tarifa. Por eso solo se resuelve el lugar que el cliente eligio, no cada
 * sugerencia que se muestra.
 */

const PROYECTO = 'mari-d7c71';

let _origenCache = null;
let _origenCacheAt = 0;
const ORIGEN_TTL_MS = 10 * 60_000;

export default async (peticion) => {
  if (peticion.method !== 'POST') {
    return new Response('Método no permitido', { status: 405 });
  }

  const clave = process.env.GOOGLE_PLACES_KEY || process.env.GOOGLE_ROUTES_KEY;
  if (!clave) {
    console.warn('[direcciones] falta GOOGLE_PLACES_KEY');
    return new Response('Sin clave de Places', { status: 503 });
  }

  let cuerpo;
  try {
    cuerpo = await peticion.json();
  } catch {
    return new Response('Cuerpo inválido', { status: 400 });
  }

  try {
    if (cuerpo.placeId) return Response.json(await resolver(String(cuerpo.placeId), clave));
    return Response.json({ sugerencias: await sugerir(String(cuerpo.q || ''), clave) });
  } catch (err) {
    console.error('[direcciones] falló:', err);
    return new Response('No se pudo consultar', { status: 502 });
  }
};

/* ── Sugerencias ──────────────────────────────────────────────────────────── */

async function sugerir(texto, clave) {
  const q = texto.trim();
  // Menos de tres letras trae medio Córdoba y cuesta una consulta igual.
  if (q.length < 3) return [];

  const origen = await leerOrigen();

  const respuesta = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': clave,
    },
    body: JSON.stringify({
      input: q,
      includedRegionCodes: ['ar'],
      languageCode: 'es-419',
      // Solo direcciones: sin esto las primeras sugerencias son negocios y
      // barrios, que no sirven para llevarle un paquete a nadie.
      includedPrimaryTypes: ['street_address', 'premise', 'subpremise', 'route'],
      // Alrededor del local, que es donde se reparte. Sin sesgo, "Belgrano 100"
      // trae primero el de Buenos Aires.
      locationBias: origen ? {
        circle: {
          center: { latitude: origen.lat, longitude: origen.lng },
          radius: 20000,
        },
      } : undefined,
    }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Places autocomplete devolvió ${respuesta.status}: ${detalle.slice(0, 300)}`);
  }

  const datos = await respuesta.json();
  return (datos.suggestions || [])
    .map(s => s.placePrediction)
    .filter(Boolean)
    .slice(0, 6)
    .map(p => ({
      id: p.placeId,
      titulo: p.structuredFormat?.mainText?.text || p.text?.text || '',
      detalle: p.structuredFormat?.secondaryText?.text || '',
    }))
    .filter(s => s.titulo);
}

/* ── Coordenadas del lugar elegido ────────────────────────────────────────── */

async function resolver(placeId, clave) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
  const respuesta = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': clave,
      'X-Goog-FieldMask': 'location,formattedAddress',
    },
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Places details devolvió ${respuesta.status}: ${detalle.slice(0, 300)}`);
  }

  const datos = await respuesta.json();
  const lat = datos?.location?.latitude;
  const lng = datos?.location?.longitude;

  return {
    direccion: datos?.formattedAddress || '',
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

/* ── Origen ───────────────────────────────────────────────────────────────── */

async function leerOrigen() {
  if (_origenCache && Date.now() - _origenCacheAt < ORIGEN_TTL_MS) return _origenCache;

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

    _origenCache = { lat, lng };
    _origenCacheAt = Date.now();
    return _origenCache;
  } catch (err) {
    // El sesgo es una mejora, no un requisito: sin él las sugerencias siguen
    // saliendo, solo que menos ordenadas.
    console.warn('[direcciones] no se pudo leer el origen:', err);
    return null;
  }
}
