/**
 * Autocompletado y resolucion de direcciones.
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
 * Tres operaciones:
 *   POST { q, sesion }        -> sugerencias  [{ id, titulo, detalle }]
 *   POST { placeId, sesion }  -> coordenadas  { direccion, lat, lng }
 *   POST { texto }            -> coordenadas de una direccion escrita a mano
 *
 * La tercera existe porque mucha gente escribe la direccion entera y le da a
 * confirmar sin tocar el desplegable. Antes ese pedido entraba sin coordenadas y
 * el envio quedaba "a confirmar" aunque la direccion fuera perfecta.
 */

const PROYECTO = 'mari-d7c71';

let _configCache = null;
let _configCacheAt = 0;
const CONFIG_TTL_MS = 10 * 60_000;

// Radio del area donde se aceptan direcciones, en metros. Es mas grande que el
// radio de reparto a proposito: al que vive apenas afuera se le muestra su
// direccion y el checkout le dice "fuera de radio", que es una respuesta. No
// mostrarsela lo deja pensando que escribio mal la calle.
const RADIO_MINIMO_M = 10_000;
const RADIO_MAXIMO_M = 50_000;  // tope de la API

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

  // El token de sesion lo genera el navegador y agrupa las consultas de un
  // mismo campo con el detalle final. Google factura la sesion entera como una
  // sola busqueda en vez de una por tecla, y ademas devuelve mejores
  // sugerencias porque sabe que las teclas vienen de la misma persona.
  const sesion = tokenValido(cuerpo.sesion) ? cuerpo.sesion : undefined;

  try {
    if (cuerpo.placeId) {
      return Response.json(await resolver(String(cuerpo.placeId), clave, sesion));
    }
    if (cuerpo.texto) {
      return Response.json(await geocodificar(String(cuerpo.texto), clave, sesion));
    }
    return Response.json({ sugerencias: await sugerir(String(cuerpo.q || ''), clave, sesion) });
  } catch (err) {
    console.error('[direcciones] falló:', err);
    return new Response('No se pudo consultar', { status: 502 });
  }
};

/** Un uuid v4 y nada mas: lo que llega del navegador va derecho a Google. */
function tokenValido(t) {
  return typeof t === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t);
}

/* ── Sugerencias ──────────────────────────────────────────────────────────── */

async function sugerir(texto, clave, sesion) {
  const q = texto.trim().slice(0, 120);
  // Menos de tres letras trae medio Córdoba y cuesta una consulta igual.
  if (q.length < 3) return [];

  const area = await areaDeReparto();

  const respuesta = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': clave,
    },
    body: JSON.stringify({
      input: q,
      languageCode: 'es-419',
      regionCode: 'AR',
      includedRegionCodes: ['ar'],
      sessionToken: sesion,
      // Solo direcciones: sin esto las primeras sugerencias son negocios y
      // barrios, que no sirven para llevarle un paquete a nadie.
      includedPrimaryTypes: ['street_address', 'premise', 'subpremise', 'route'],
      // Restriccion y no sesgo. Con `locationBias` la lista salia igual pero
      // ordenada por su cuenta: escribir la direccion del propio local traia
      // primero la calle homonima de Villa Carlos Paz, a 35 km. El sesgo es una
      // sugerencia que Google puede ignorar; la restriccion no.
      locationRestriction: area ? {
        circle: {
          center: { latitude: area.lat, longitude: area.lng },
          radius: area.radio,
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

async function resolver(placeId, clave, sesion) {
  // El mismo token que las sugerencias: es lo que cierra la sesion y hace que
  // todas las teclas de este campo cuenten como una sola busqueda.
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`
            + (sesion ? `?sessionToken=${encodeURIComponent(sesion)}` : '');

  // `addressComponents` es lo unico que dice con certeza si la direccion tiene
  // altura. Sin ella, la coordenada es el centro de la calle: "Zorrilla de San
  // Martin" son diez cuadras y la tienda cotizaba $1.500 con total confianza
  // sobre un punto que el cliente no eligio. Mirar si el texto tiene un numero
  // no alcanza — "9 de Julio" tiene uno y no es la altura.
  const respuesta = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': clave,
      'X-Goog-FieldMask': 'location,formattedAddress,addressComponents',
    },
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Places details devolvió ${respuesta.status}: ${detalle.slice(0, 300)}`);
  }

  const datos = await respuesta.json();
  const tieneAltura = (datos?.addressComponents || [])
    .some(c => (c.types || []).includes('street_number'));

  return { ...conCoordenadas(datos?.formattedAddress, datos?.location), altura: tieneAltura };
}

/* ── Direccion escrita a mano ─────────────────────────────────────────────── */

/**
 * Resuelve una direccion escrita entera, sin pasar por el desplegable.
 *
 * Va por el mismo autocompletado y no por la Geocoding API ni por
 * `places:searchText`. Las dos alternativas se probaron y ninguna sirve:
 * Geocoding es otra API que hay que habilitar aparte en el proyecto, y
 * `searchText` busca lugares, no direcciones — "Av. Alfonsina Storni 168"
 * devuelve la libreria que esta en esa esquina, y "San Martín 500" devuelve una
 * parada de colectivo.
 *
 * La primera sugerencia se acepta solo si dice lo mismo que escribio el
 * cliente: la misma altura y todas las palabras que puso. Cuando el texto es
 * ambiguo, en vez de elegir una direccion por el se devuelve sin coordenadas y
 * el envio queda a confirmar, que es como entra hoy un pedido por telefono.
 *
 * Lo que sale de aca viaja marcado como `aproximada`, y el checkout se lo
 * muestra con el mapa. Una coordenada que el cliente no eligio decide cuanto
 * paga de envio: tiene que poder verla.
 */
async function geocodificar(texto, clave, sesion) {
  const q = texto.trim().slice(0, 160);
  if (q.length < 6) return { direccion: '', lat: null, lng: null };

  // Con el mismo token que las teclas que el cliente ya escribio: esto es el
  // final de esa sesion, no una busqueda nueva.
  const sugerencias = await sugerir(q, clave, sesion);
  const primera = sugerencias[0];
  if (!primera || !diceLoMismo(q, primera.titulo, primera.detalle)) {
    return { direccion: '', lat: null, lng: null };
  }

  return { ...await resolver(primera.id, clave, sesion), aproximada: true };
}

/** Sin acentos, sin puntos y sin las abreviaturas que cambian de una fuente a otra. */
const ABREVIATURAS = {
  av: 'avenida', avda: 'avenida', ave: 'avenida',
  bv: 'bulevar', blv: 'bulevar', bvard: 'bulevar', boulevard: 'bulevar',
  gral: 'general', pje: 'pasaje', dr: 'doctor', pte: 'presidente',
  sta: 'santa', sto: 'santo', ntra: 'nuestra',
};

function palabrasDe(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(p => ABREVIATURAS[p] || p);
}

/**
 * Si la sugerencia dice la misma direccion que el texto escrito.
 *
 * Manda la altura, que es lo unico que distingue una casa de la de la otra
 * cuadra, y sale de la calle sola: el detalle trae el codigo postal y la
 * localidad, y ahi hay numeros que no son alturas.
 *
 * Despues, que todas las palabras escritas aparezcan en la calle o en el
 * detalle; al reves no, porque Google completa lo que el cliente abrevio. Es lo
 * que deja pasar "av. alfonsina storni 168, cordoba": la ciudad la escribio el
 * cliente y Google la puso en el detalle, no en la calle.
 */
function diceLoMismo(escrito, calle, detalle) {
  const escritas = palabrasDe(escrito);
  const deLaCalle = palabrasDe(calle);
  const todas = deLaCalle.concat(palabrasDe(detalle));

  const esAltura = p => /^\d+$/.test(p);
  const alturaEscrita = escritas.filter(esAltura).pop();
  const alturaDeLaCalle = deLaCalle.filter(esAltura).pop();
  if (!alturaEscrita || alturaEscrita !== alturaDeLaCalle) return false;

  return escritas.every(p => todas.includes(p));
}

function conCoordenadas(direccion, ubicacion) {
  const lat = ubicacion?.latitude;
  const lng = ubicacion?.longitude;
  return {
    direccion: direccion || '',
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

/* ── Area de reparto ──────────────────────────────────────────────────────── */

/**
 * El centro y el radio donde se buscan direcciones, sacados de la config.
 *
 * Si no se puede leer se devuelve null y las dos consultas salen sin
 * restriccion: peor ordenadas, pero salen. La restriccion es una mejora, no un
 * requisito, y el checkout no se puede romper por no poder leer un documento.
 */
async function areaDeReparto() {
  if (_configCache && Date.now() - _configCacheAt < CONFIG_TTL_MS) return _configCache;

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

    const entrega = crudo?.fields?.entrega?.mapValue?.fields;
    const radioKm = Number(entrega?.radio_max_km?.doubleValue
                        ?? entrega?.radio_max_km?.integerValue);

    // El doble del radio de reparto: alcanza para que el que vive afuera vea su
    // direccion y reciba un "fuera de radio" en vez de una lista vacia.
    const radio = Math.min(RADIO_MAXIMO_M,
                           Math.max(RADIO_MINIMO_M,
                                    (Number.isFinite(radioKm) ? radioKm : 12) * 2000));

    _configCache = { lat, lng, radio };
    _configCacheAt = Date.now();
    return _configCache;
  } catch (err) {
    console.warn('[direcciones] no se pudo leer el área de reparto:', err);
    return null;
  }
}
