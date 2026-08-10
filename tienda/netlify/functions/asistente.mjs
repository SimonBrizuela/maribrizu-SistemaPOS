/**
 * El asistente de la tienda.
 *
 * Contesta preguntas sobre el catalogo con los precios y el stock de verdad.
 *
 * La idea de fondo: el modelo NO sabe nada del catalogo y no tiene por que
 * saberlo. Se le da una sola herramienta, `buscar_en_catalogo`, y el flujo es
 * siempre el mismo: entiende que esta pidiendo la persona, llama a la
 * herramienta, recibe productos reales y redacta con eso. No puede inventar un
 * precio porque nunca lo tuvo en la cabeza; lo recibio de Firestore.
 *
 * Eso es lo que separa esto de un chatbot que suena bien y miente. Un precio
 * equivocado en una libreria no es un detalle: es una clienta que llega al
 * mostrador con una captura de pantalla.
 *
 * Lo que sí aporta el modelo es entender. "Necesito algo para forrar carpetas"
 * no lo resuelve ningun buscador por palabras; el modelo lo traduce a contact,
 * cartulina o papel araña y busca eso.
 *
 * El catalogo se lee con la API REST de Firestore sin credenciales, igual que
 * en `avisar-pedido.mjs`: `tienda_productos` es publica, es la misma consulta
 * que hace el navegador de cualquier visitante. Por eso no hace falta meter una
 * cuenta de servicio aca.
 *
 * Variables de entorno:
 *
 *   GEMINI_API_KEY   La clave de Google AI Studio (aistudio.google.com/apikey).
 *                    El plan gratuito no pide tarjeta: 15 pedidos por minuto y
 *                    1.000 por dia, que a razon de dos o tres llamadas por
 *                    consulta son unas 300 conversaciones diarias.
 *
 * Sin clave devuelve 503 y la tienda esconde el chat, que es como degradan las
 * otras funciones cuando les falta su clave.
 */
import { normalizar, despiezar as despiezarBase } from '../../src/formato.js';

const PROYECTO = 'mari-d7c71';
const MODELO = 'gemini-3.5-flash-lite';
const API = 'https://generativelanguage.googleapis.com/v1beta';

// Cuantas vueltas de "el modelo pide buscar → se le contesta" se permiten antes
// de cortar. Con dos alcanza para el caso real (buscar una cosa, o dos si la
// primera no dio nada); mas que eso es el modelo dando vueltas y gastando cuota.
const VUELTAS_MAXIMAS = 3;

const MAX_MENSAJES = 12;
const MAX_LARGO = 500;

/* ── Puerta de entrada ────────────────────────────────────────────────────── */

export default async (peticion) => {
  if (peticion.method !== 'POST') {
    return new Response('Método no permitido', { status: 405 });
  }

  const clave = process.env.GEMINI_API_KEY;
  if (!clave) return new Response('Asistente apagado', { status: 503 });

  let mensajes;
  try {
    ({ mensajes } = await peticion.json());
  } catch {
    return new Response('Cuerpo inválido', { status: 400 });
  }

  const limpios = validar(mensajes);
  if (!limpios) return new Response('Mensajes inválidos', { status: 400 });
  if (!limpios.length) return new Response('Sin mensajes', { status: 400 });

  if (demasiadoSeguido(peticion)) {
    return Response.json({
      respuesta: 'Estás yendo muy rápido. Esperá unos segundos y volvé a probar.',
      productos: [],
    });
  }

  try {
    const salida = await conversar(limpios, clave);
    return Response.json(salida);
  } catch (err) {
    console.error('[asistente] falló:', err);
    return Response.json({
      respuesta: 'Se me complicó contestarte. Probá de nuevo en un momento, '
               + 'o escribinos por WhatsApp que te atendemos igual.',
      productos: [],
    });
  }
};

/**
 * Los mensajes que manda el navegador, revisados.
 *
 * Es un endpoint publico: lo que llega no es lo que manda la tienda, es lo que
 * manda cualquiera. Se acota el historial y el largo de cada mensaje porque sin
 * eso alcanza un `curl` con un texto de un megabyte para quemar la cuota diaria
 * del plan gratuito en una sola llamada.
 */
function validar(mensajes) {
  if (!Array.isArray(mensajes)) return null;

  const salida = [];
  for (const m of mensajes.slice(-MAX_MENSAJES)) {
    if (!m || typeof m.texto !== 'string') return null;
    const texto = m.texto.trim().slice(0, MAX_LARGO);
    if (!texto) continue;
    salida.push({ rol: m.rol === 'tienda' ? 'tienda' : 'cliente', texto });
  }
  return salida;
}

/**
 * Freno por IP.
 *
 * Vive en memoria, asi que solo cubre la instancia caliente que atiende el
 * pedido: no es un limite de verdad, es un badén. Alcanza para que alguien
 * curioso no deje sin cuota a la libreria desde una consola, y no vale la pena
 * montar un almacen aparte para algo que todavia nadie ataco.
 */
const VISITAS = new Map();
const VENTANA_MS = 60_000;
const TOPE_POR_VENTANA = 8;

function demasiadoSeguido(peticion) {
  const ip = peticion.headers.get('x-nf-client-connection-ip')
          || peticion.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          || 'desconocida';

  const ahora = Date.now();
  const previas = (VISITAS.get(ip) || []).filter(t => ahora - t < VENTANA_MS);
  previas.push(ahora);
  VISITAS.set(ip, previas);

  // La tabla se limpia sola: sin esto una instancia de larga vida acumula una
  // entrada por visitante para siempre.
  if (VISITAS.size > 500) {
    for (const [otra, marcas] of VISITAS) {
      if (!marcas.some(t => ahora - t < VENTANA_MS)) VISITAS.delete(otra);
    }
  }

  return previas.length > TOPE_POR_VENTANA;
}

/* ── La conversación ──────────────────────────────────────────────────────── */

const HERRAMIENTA = {
  name: 'buscar_en_catalogo',
  description:
    'Busca productos en el catálogo real de la librería y devuelve nombre, '
  + 'precio, stock y colores disponibles. Es la única forma de saber un precio '
  + 'o si hay stock de algo.',
  parameters: {
    type: 'object',
    properties: {
      consulta: {
        type: 'string',
        description:
          'Las palabras con las que buscar, en singular y sin artículos. '
        + 'Ejemplos: "cartulina luma", "cuaderno rivadavia", "tijera". '
        + 'Si la persona describe para qué lo necesita en vez de nombrar el '
        + 'producto, traducilo primero al nombre que tendría en una librería.',
      },
    },
    required: ['consulta'],
  },
};

async function conversar(mensajes, clave) {
  const cfg = await cargarConfig();

  const contenidos = mensajes.map(m => ({
    role: m.rol === 'tienda' ? 'model' : 'user',
    parts: [{ text: m.texto }],
  }));

  const encontrados = [];

  for (let vuelta = 0; vuelta < VUELTAS_MAXIMAS; vuelta++) {
    const respuesta = await pedirleAGemini({ contenidos, cfg, clave });
    const partes = respuesta?.candidates?.[0]?.content?.parts || [];
    const llamadas = partes.filter(p => p.functionCall).map(p => p.functionCall);

    if (!llamadas.length) {
      const texto = partes.map(p => p.text).filter(Boolean).join('').trim();
      const respuesta = texto || 'No te entendí bien. ¿Me lo decís de otra manera?';
      return { respuesta, productos: aVitrina(encontrados, respuesta) };
    }

    // El turno del modelo se agrega tal cual vino: si no, en la vuelta
    // siguiente Gemini ve una respuesta a una pregunta que nunca hizo.
    contenidos.push({ role: 'model', parts: partes });

    const respuestasDeHerramienta = [];
    for (const llamada of llamadas) {
      const productos = await buscarEnCatalogo(llamada.args?.consulta || '');
      encontrados.push(...productos);
      respuestasDeHerramienta.push({
        functionResponse: {
          name: llamada.name,
          response: { productos: productos.map(paraElModelo) },
        },
      });
    }
    contenidos.push({ role: 'user', parts: respuestasDeHerramienta });
  }

  // Se acabaron las vueltas con el modelo todavía pidiendo buscar. Pasa cuando
  // la persona pregunta por diez cosas juntas. Acá no hay respuesta contra la
  // cual cruzar, así que no se muestran cards: es preferible una fila menos que
  // cuatro productos sueltos abajo de un texto que no habla de ninguno.
  return {
    respuesta: 'Encontré varias cosas pero se me hizo largo. '
             + '¿Me preguntás de a un producto por vez?',
    productos: [],
  };
}

/**
 * La llamada a Gemini.
 *
 * Aislada a proposito: es lo unico que sabe de Google en todo el archivo. Si
 * mañana conviene otro proveedor (Groq, o Claude si la libreria decide pagar),
 * se reescribe esta funcion y nada mas.
 */
async function pedirleAGemini({ contenidos, cfg, clave }) {
  const respuesta = await fetch(
    `${API}/models/${MODELO}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': clave, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instrucciones(cfg) }] },
        contents: contenidos,
        tools: [{ functionDeclarations: [HERRAMIENTA] }],
        generationConfig: { maxOutputTokens: 400 },
      }),
    },
  );

  if (respuesta.status === 429) {
    throw new Error('Se acabó la cuota del plan gratuito de Gemini por hoy');
  }
  if (!respuesta.ok) {
    throw new Error(`Gemini devolvió ${respuesta.status}: `
                  + (await respuesta.text()).slice(0, 300));
  }
  return respuesta.json();
}

function instrucciones(cfg) {
  const entrega = cfg.entrega || {};
  const tramos = (entrega.tramos || [])
    .map(t => `hasta ${t.hasta_km} km ${pesos(t.precio)}`)
    .join(', ');

  return `Sos quien atiende el chat de ${cfg.nombre}, una librería, mercería y \
regalería de barrio en Córdoba, Argentina.

CÓMO HABLÁS
Español rioplatense, de vos. Dos o tres renglones como máximo: esto es un chat, \
no un mail. Sin emojis y sin saludos efusivos. Hablás como quien atiende el \
mostrador: directo, amable y sin vueltas.

DE DÓNDE SALEN LOS DATOS
Los precios, el stock y los colores salen únicamente de buscar_en_catalogo. \
Nunca los inventes, ni los estimes, ni los redondees. Si no buscaste, no sabés.

No nombres NUNCA un producto que no haya vuelto de una búsqueda, ni siquiera \
para ofrecer buscarlo o para sugerir una alternativa. Si se te ocurre que la \
librería podría tener algo, buscalo primero y recién nombralo si aparece. Este \
catálogo tiene huecos que no se adivinan: no hay papel contact y no hay \
mochilas, y prometer cualquiera de los dos termina con alguien viniendo al \
local a buscar algo que no existe.

Cuando la búsqueda no devuelve nada, decilo derecho: "eso no lo tengo". No \
digas que capaz llega la semana que viene ni nada que no sepas.

Si la persona describe para qué lo necesita en vez de nombrar el producto, \
hacé DOS búsquedas antes de contestar: una con la palabra que usó ella tal cual \
("forrar") y otra con el nombre que tendría en una librería ("cartulina"). \
Quedarte con una sola te hace perder el producto exacto, que muchas veces se \
llama igual que lo que la persona dijo.

Los precios que te devuelve la herramienta son por unidad. Cuando un producto \
también se vende por rollo o caja entera, la herramienta te lo dice aparte: \
mencioná las dos cosas, que es lo que la gente pregunta después.

QUÉ NO HACÉS
No tomás pedidos, no reservás y no anotás nada. Si quieren comprar, se agrega \
al carrito desde la tienda y se elige envío o retiro en el momento de cerrar.
No prometés plazos, descuentos ni cambios que no estén acá abajo.
No opinás de otros temas: si te preguntan algo que no es la librería, decís que \
de eso no sabés y volvés al catálogo.

DATOS DE LA LIBRERÍA
Dirección: ${cfg.direccion}
Horarios: ${cfg.horarios_texto}
Retiro en el local: ${entrega.retiro_habilitado === false ? 'no disponible' : 'sí, sin costo'}
Envíos: ${entrega.delivery_habilitado === false
  ? 'no hacemos por ahora'
  : `a Córdoba, hasta ${entrega.radio_max_km} km${tramos ? ` (${tramos})` : ''}`}
Demora del envío: ${entrega.demora_texto}
Formas de pago: efectivo o transferencia, al recibir el pedido.`;
}

/* ── El catálogo ──────────────────────────────────────────────────────────── */

/**
 * La misma busqueda que usa el buscador de la tienda, del lado del servidor.
 *
 * Firestore no tiene busqueda de texto completo. El sync guarda en cada producto
 * un arreglo `tokens` con las palabras de su nombre normalizadas; se consulta
 * por la palabra mas larga (la mas distintiva: en "cuaderno rivadavia" filtrar
 * por "rivadavia" descarta muchisimo mas que filtrar por "cuaderno") y el resto
 * se filtra sobre ese resultado.
 *
 * Es el gemelo de `buscar()` en src/datos.js. Estan separadas porque una corre
 * con el SDK de Firebase en el navegador y la otra contra la API REST sin
 * credenciales; si se toca el criterio hay que tocar las dos.
 *
 * Va exportada aparte del handler para poder probarla sin clave de Gemini: es
 * la mitad del asistente que se puede verificar contra datos reales.
 */
export async function buscarEnCatalogo(consulta) {
  const palabras = despiezar(consulta);
  if (!palabras.length) return [];

  // De la palabra mas distintiva a la menos: en "cuaderno rivadavia" preguntar
  // por "rivadavia" descarta muchisimo mas que preguntar por "cuaderno". Si esa
  // no existe en el catalogo se prueba la siguiente, porque la gente escribe
  // como habla y mete palabras que no son de ningun producto ("una tijera para
  // chicos": "chicos" no existe, "tijera" si).
  const porLargo = palabras.slice().sort((a, b) => b.length - a.length);

  for (const ancla of porLargo.slice(0, 3)) {
    const candidatos = await porToken(ancla);
    if (candidatos.length) return ordenar(candidatos, palabras, ancla).slice(0, 6);
  }
  return [];
}

async function porToken(token) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROYECTO}`
            + '/databases/(default)/documents:runQuery';

  const respuesta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'tienda_productos' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'tokens' },
            op: 'ARRAY_CONTAINS',
            value: { stringValue: token },
          },
        },
        // Se traen 50 y se recortan a 6 despues de ordenar. Mas alto afina el
        // ranking pero cada documento es una lectura de Firestore, y esto corre
        // hasta dos veces por consulta: 50 deja el gasto en el orden de los
        // miles de lecturas por dia, no de las decenas de miles.
        limit: 50,
      },
    }),
  });

  if (!respuesta.ok) throw new Error(`Firestore devolvió ${respuesta.status}`);

  return (await respuesta.json())
    .filter(fila => fila.document)
    .map(fila => armarProducto(fila.document));
}

/**
 * Ordena por relevancia, sin exigir que esten todas las palabras.
 *
 * Exigirlas todas devolvia cero demasiado seguido: "cartulina luma celeste" no
 * encontraba nada porque el color es una variedad y no un token del nombre, y
 * cero es la peor respuesta posible cuando el producto esta y hasta hay stock
 * del color. Se puntua cuantas palabras coinciden y se muestran las seis
 * mejores; el modelo recibe los nombres y los colores completos, asi que puede
 * elegir el que corresponde y decir cual es.
 */
function ordenar(productos, palabras, ancla) {
  const escrito = palabras.join(' ');

  const puntos = p => {
    const nombre = normalizar(p.nombre);
    const coinciden = palabras.filter(w => p.tokens.some(t => t.startsWith(w))).length;
    return [
      -coinciden,               // mas palabras en comun, mas arriba
      p.stock > 0 ? 0 : 1,      // ofrecer algo agotado primero es la peor respuesta
      // Lo que EMPIEZA con lo buscado. Sin esto "mochila" trae primero
      // "Hebilla para Mochila" y "Pasador para Mochila": en el catalogo la
      // palabra aparece igual de valida en el medio del nombre.
      nombre.startsWith(escrito) ? 0 : 1,
      nombre.startsWith(ancla) ? 0 : 1,
    ];
  };

  return productos.sort((a, b) => {
    const pa = puntos(a);
    const pb = puntos(b);
    for (let i = 0; i < pa.length; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return a.nombre.localeCompare(b.nombre, 'es');
  });
}

/**
 * Palabras de conversacion, solo del lado de la consulta.
 *
 * Las del indice (los conectores que el sync no guarda) viven en
 * `formato.js` y las comparte la busqueda de la tienda: tienen que ser las
 * mismas o la busqueda miente. Estas son de mas y solo tienen sentido aca: el
 * sync no necesita filtrarlas porque no aparecen en el nombre de un producto,
 * pero alguna vez coinciden por casualidad. Sin ellas "zzzz no existe" devolvia
 * "Juego de Mesa Uno No Mercy" y "Abrochadora Kangaro No. 384556", enganchadas
 * del token "no", y el asistente pasaba de no encontrar nada a ofrecer dos
 * productos cualquiera.
 */
const CHARLA = new Set([
  'no', 'si', 'que', 'me', 'mi', 'te', 'lo', 'le', 'se', 'es', 'al',
  'hay', 'tenes', 'tienen', 'tiene', 'hola', 'buenas',
  'quiero', 'necesito', 'busco', 'buscaba', 'queria', 'cuanto', 'como',
]);

function despiezar(texto) {
  return despiezarBase(texto, CHARLA);
}

function armarProducto(documento) {
  const d = aplanar(documento.fields || {});
  return {
    id: documento.name.split('/').pop(),
    nombre: d.nombre || '',
    precio: Number(d.precio) || 0,
    unidad: d.unidad === 'metro' ? 'metro' : 'unidad',
    precio_pack: d.precio_pack ? Number(d.precio_pack) : null,
    pack_tipo: d.pack_tipo || null,
    pack_contenido: Number(d.pack_contenido) || null,
    stock: Number(d.stock) || 0,
    rubro: d.rubro || '',
    marca: d.marca || '',
    imagenes: Array.isArray(d.imagenes) ? d.imagenes : [],
    variedades: Array.isArray(d.variedades) ? d.variedades : [],
    tokens: Array.isArray(d.tokens) ? d.tokens : [],
  };
}

/**
 * La API REST devuelve cada valor envuelto en su tipo (`{stringValue: "..."}`),
 * asi que hay que desenvolverlo para poder usarlo.
 */
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

/**
 * El producto reducido a lo que el modelo necesita para contestar.
 *
 * No se le manda el documento entero: cada campo de mas es contexto que hay que
 * pagar en cada vuelta y una cosa mas sobre la que el modelo puede divagar. Los
 * ids y las fotos no entran porque las cards las pinta la tienda, no el texto.
 */
function paraElModelo(p) {
  const salida = {
    nombre: p.nombre,
    precio: `${pesos(p.precio)} por ${p.unidad}`,
    hay_stock: p.stock > 0,
  };

  if (p.marca) salida.marca = p.marca;

  if (p.precio_pack) {
    salida.precio_por_paquete =
      `${pesos(p.precio_pack)} el ${p.pack_tipo || 'paquete'}`
    + (p.pack_contenido ? ` de ${p.pack_contenido}` : '');
  }

  // Los colores con su stock propio: "¿tenés cartulina celeste?" se contesta
  // con esto, no con el stock total del producto.
  const conStock = p.variedades.filter(v => Number(v.stock) > 0).map(v => v.nombre);
  if (p.variedades.length) {
    salida.colores_disponibles = conStock.length ? conStock : 'ninguno, están agotados';
  }

  return salida;
}

/**
 * Los productos que se le muestran a la persona como cards.
 *
 * Solo los que el modelo nombro en su respuesta. Mostrar todo lo que devolvio
 * la busqueda parece razonable hasta que se prueba: a "¿tenés papel contact?"
 * el modelo contestaba bien —"eso no lo tengo"— y abajo aparecian cuatro
 * papeles con precio y boton de agregar. La respuesta y las cards decian cosas
 * distintas, y la que se mira primero es la card.
 *
 * Se cruza contra el texto: un producto entra si al menos dos de sus palabras
 * aparecen en la respuesta (o todas, cuando tiene menos de dos). Con una sola
 * alcanzaba para colar cualquier cosa que compartiera el termino de la busqueda;
 * con dos, "Cinta Floral para Forrar" ya no se cuela en una respuesta que solo
 * hablaba de papel y nylon.
 *
 * Ademas solo los que tienen stock: una card con boton de agregar sobre algo
 * agotado es una promesa que la tienda no puede cumplir. Se corta en cuatro,
 * que es lo que entra abajo del chat sin hacer scroll.
 */
function aVitrina(productos, respuesta) {
  const texto = normalizar(respuesta);
  const vistos = new Set();
  const salida = [];

  for (const p of productos) {
    if (p.stock <= 0 || vistos.has(p.id)) continue;
    vistos.add(p.id);

    // Las palabras cortas no cuentan: "un", "x", "cm" aparecen en cualquier
    // frase y harian pasar productos que nadie nombro.
    const largas = p.tokens.filter(t => t.length >= 4);
    const nombradas = largas.filter(t => texto.includes(t)).length;
    if (nombradas < Math.min(2, largas.length)) continue;

    salida.push({
      id: p.id,
      nombre: p.nombre,
      precio: p.precio,
      unidad: p.unidad,
      stock: p.stock,
      rubro: p.rubro,
      imagenes: p.imagenes.slice(0, 1),
      variedades: p.variedades,
    });
    if (salida.length === 4) break;
  }
  return salida;
}

/* ── Config de la tienda ──────────────────────────────────────────────────── */

const POR_DEFECTO = {
  nombre: 'Librería Liceo',
  direccion: 'Av. Alfonsina Storni 168, Córdoba',
  horarios_texto: 'Lunes a viernes de 9 a 13 y de 17 a 20:30 · '
                + 'Sábados de 9 a 13 y de 17:30 a 20:30 · Domingos cerrado',
  entrega: {
    retiro_habilitado: true, delivery_habilitado: true,
    radio_max_km: 12, tramos: [], demora_texto: '24 a 48 hs',
  },
};

// La config cambia una vez cada muchos meses y se necesita en cada mensaje. Se
// guarda en memoria por media hora: la instancia caliente atiende varias
// consultas seguidas y no tiene sentido releerla en cada una.
let configCacheada = null;
let configVence = 0;

async function cargarConfig() {
  if (configCacheada && Date.now() < configVence) return configCacheada;

  try {
    const url = `https://firestore.googleapis.com/v1/projects/${PROYECTO}`
              + '/databases/(default)/documents/tienda_config/settings';
    const respuesta = await fetch(url);
    if (!respuesta.ok) throw new Error(`Firestore devolvió ${respuesta.status}`);

    const datos = aplanar((await respuesta.json()).fields || {});
    configCacheada = {
      ...POR_DEFECTO,
      ...datos,
      entrega: { ...POR_DEFECTO.entrega, ...(datos.entrega || {}) },
    };
  } catch (err) {
    // Sin config el asistente igual puede hablar del catálogo, que es para lo
    // que está. Se cae a los valores de siempre en vez de no contestar.
    console.warn('[asistente] no se pudo leer la config:', err?.message || err);
    configCacheada = { ...POR_DEFECTO };
  }

  configVence = Date.now() + 30 * 60_000;
  return configCacheada;
}

function pesos(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}
