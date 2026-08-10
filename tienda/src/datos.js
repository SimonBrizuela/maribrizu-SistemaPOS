/**
 * Capa de datos de la tienda.
 *
 * Lee `tienda_productos` y `tienda_config`, que son las dos unicas colecciones
 * publicas. Nunca toca `catalogo`: ahi viven costo, margen y proveedor.
 */
import {
  collection, doc, getDoc, getDocs, query, where, orderBy,
  limit, startAfter, documentId,
} from 'firebase/firestore';
import { db } from './firebase.js';
import { normalizar, despiezar, VACIAS } from './formato.js';

export const POR_PAGINA = 24;

// Cache en memoria por sesion. La tienda es de una sola carga de pagina, asi
// que alcanza con esto: volver a un rubro ya visitado es instantaneo y no
// gasta lecturas.
const _cache = new Map();

async function cacheado(clave, obtener) {
  if (_cache.has(clave)) return _cache.get(clave);
  const valor = await obtener();
  _cache.set(clave, valor);
  return valor;
}

export function limpiarCache() {
  _cache.clear();
}

/**
 * La config ya cargada, o null si todavia no llego.
 *
 * Sirve para pintar una pantalla sin esperar a la red. La portada la pide en el
 * arranque, asi que a partir de la segunda pantalla siempre esta.
 */
export function configEnCache() {
  return _cache.get('config') || null;
}

/* ── Configuracion ───────────────────────────────────────────────────────── */

const CONFIG_POR_DEFECTO = {
  abierta: true,
  nombre: 'Librería Liceo',
  telefono: '3517046684',
  whatsapp: '5493517046684',
  email: 'libreria.liceo@hotmail.com',
  direccion: 'Av. Alfonsina Storni 168, X5019 Córdoba',
  // Coordenada del local, verificada contra Places sobre la dirección completa.
  // Está acá y no solo en Firestore porque el mapa del checkout la necesita
  // para dibujarse, y un mapa con un solo marcador no dice nada.
  origen: { lat: -31.3540169, lng: -64.1734488 },
  // Los del perfil de WhatsApp Business del local, que son los de verdad. Este
  // valor es sólo el de arranque: el que manda es el de `tienda_config`.
  horarios_texto: 'Lunes a viernes de 9 a 13 y de 17 a 20:30 · '
                + 'Sábados de 9 a 13 y de 17:30 a 20:30 · Domingos cerrado',
  entrega: {
    retiro_habilitado: true,
    delivery_habilitado: true,
    radio_max_km: 12,
    tramos: [
      { hasta_km: 3,  precio: 1500 },
      { hasta_km: 6,  precio: 2500 },
      { hasta_km: 12, precio: 3500 },
    ],
    envio_gratis_desde: null,
    demora_texto: '24 a 48 hs',
    // Monto mínimo del pedido. Preparar uno cuesta lo mismo valga $500 o
    // $50.000: leerlo, juntar las cosas, embalarlo, avisar. Sin un piso, los
    // pedidos chicos dejan pérdida. En cero no se exige nada.
    pedido_minimo: 0,
  },
  // Datos para transferir. Mientras no estén cargados el checkout dice que se
  // pasan al confirmar, en vez de mostrar un alias vacío.
  pago: {
    alias: null,
    titular: null,
  },
  banner: null,
};

/**
 * La config gatea el primer pintado, asi que si el documento todavia no existe
 * la tienda arranca con valores por defecto en vez de quedarse en blanco. Es lo
 * que permite levantar el sitio antes de cargar nada en el panel.
 */
export async function cargarConfig() {
  return cacheado('config', async () => {
    try {
      const snap = await getDoc(doc(db, 'tienda_config', 'settings'));
      if (!snap.exists()) return { ...CONFIG_POR_DEFECTO };
      const datos = snap.data();
      return {
        ...CONFIG_POR_DEFECTO,
        ...datos,
        entrega: { ...CONFIG_POR_DEFECTO.entrega, ...(datos.entrega || {}) },
        pago: { ...CONFIG_POR_DEFECTO.pago, ...(datos.pago || {}) },
      };
    } catch (err) {
      console.error('[datos] no se pudo leer la config:', err);
      return { ...CONFIG_POR_DEFECTO };
    }
  });
}

/* ── Rubros ──────────────────────────────────────────────────────────────── */

/**
 * Los rubros con su cantidad de productos salen de un documento agregado que
 * escribe el sync, no de contar la coleccion. Contar 3.000 documentos para
 * pintar seis fichas en la portada seria absurdo.
 */
export async function cargarRubros() {
  return cacheado('rubros', async () => {
    try {
      const snap = await getDoc(doc(db, 'tienda_config', 'rubros'));
      if (!snap.exists()) return [];
      return (snap.data().lista || []).filter(r => r.cantidad > 0);
    } catch (err) {
      console.error('[datos] no se pudieron leer los rubros:', err);
      return [];
    }
  });
}

/* ── Productos ───────────────────────────────────────────────────────────── */

function armarProducto(snap) {
  const d = snap.data();
  return {
    id: snap.id,
    nombre: d.nombre || '',
    descripcion: d.descripcion || '',
    // Precio de UNA unidad: un metro de cinta, un boligrafo suelto.
    precio: Number(d.precio) || 0,
    precio_anterior: d.precio_anterior ? Number(d.precio_anterior) : null,
    // 'metro' para lo que se corta del rollo, 'unidad' para el resto.
    unidad: d.unidad === 'metro' ? 'metro' : 'unidad',
    // De a cuanto se vende. Lo decide el panel por producto; sin configurar
    // queda en uno, o medio metro para lo que se mide.
    minimo: Number(d.minimo) > 0 ? Number(d.minimo) : null,
    paso: Number(d.paso) > 0 ? Number(d.paso) : null,
    // Lo que sale el rollo o la caja entera, cuando existe.
    precio_pack: d.precio_pack ? Number(d.precio_pack) : null,
    pack_tipo: d.pack_tipo || null,
    // Como se llama el pack de cara al cliente. Lo pone el panel; sin eso se
    // cae al tipo del POS, que a veces no dice nada ("carton").
    pack_nombre: d.pack_nombre || null,
    pack_contenido: Number(d.pack_contenido) || null,
    stock: Number(d.stock) || 0,
    rubro: d.rubro || '',
    categoria: d.categoria || '',
    sub_rubro: d.sub_rubro || '',
    marca: d.marca || '',
    imagenes: Array.isArray(d.imagenes) ? d.imagenes : [],
    variedades: Array.isArray(d.variedades) ? d.variedades : [],
    destacado: d.destacado === true,
    tokens: Array.isArray(d.tokens) ? d.tokens : [],
  };
}

/**
 * Trae una pagina de productos.
 *
 * `orden` es un numero que el sync ya calculo mezclando destacado, stock y
 * nombre. Ordenar por el en Firestore evita traer la coleccion entera para
 * ordenarla en el navegador.
 *
 * Filtrar por rubro Y ordenar por `orden` necesita un indice compuesto. Si el
 * indice todavia no esta desplegado, Firestore devuelve failed-precondition; en
 * ese caso se cae a una consulta sin orden y se ordena del lado del cliente, que
 * es peor pero deja la tienda funcionando en vez de mostrar un error.
 */
export async function traerProductos({ rubro = null, cursor = null, desde = 0,
                                      cantidad = POR_PAGINA } = {}) {
  const col = collection(db, 'tienda_productos');

  // Dentro de un rubro se ordena por `orden_rubro`, que numera de cero en cada
  // rubro. El orden global tiene los rubros entremezclados, asi que no permite
  // saltar a un punto concreto de un rubro sin caer en otro.
  const campoOrden = rubro ? 'orden_rubro' : 'orden';

  const partes = [];
  if (rubro) partes.push(where('rubro', '==', rubro));
  if (desde > 0) partes.push(where(campoOrden, '>=', desde));
  partes.push(orderBy(campoOrden), orderBy(documentId()));
  if (cursor) partes.push(startAfter(...cursor));
  partes.push(limit(cantidad));

  try {
    const snap = await getDocs(query(col, ...partes));
    return leerPagina(snap, cantidad, campoOrden);
  } catch (err) {
    if (err?.code !== 'failed-precondition') throw err;

    // Se imprime el mensaje de Firestore tal cual: trae el indice exacto que
    // falta y un enlace para crearlo. Adivinar cual era mando a buscar el
    // equivocado mas de una vez.
    console.warn('[datos] falta un indice compuesto, ordenando en el cliente.\n' +
                 (err?.message || ''));
    const alternativa = rubro
      ? query(col, where('rubro', '==', rubro), limit(300))
      : query(col, limit(300));
    const snap = await getDocs(alternativa);
    const todos = snap.docs.map(armarProducto)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    return { productos: todos.slice(0, cantidad), cursor: null, hayMas: false };
  }
}

function leerPagina(snap, cantidad, campoOrden = 'orden') {
  const productos = snap.docs.map(armarProducto);
  const ultimo = snap.docs[snap.docs.length - 1];
  return {
    productos,
    cursor: ultimo ? [ultimo.get(campoOrden), ultimo.id] : null,
    hayMas: snap.docs.length === cantidad,
  };
}

/** Los destacados de la portada. */
export async function traerDestacados(cantidad = 8) {
  return cacheado(`destacados:${cantidad}`, async () => {
    try {
      const snap = await getDocs(query(
        collection(db, 'tienda_productos'),
        where('destacado', '==', true),
        limit(cantidad),
      ));
      return snap.docs.map(armarProducto);
    } catch (err) {
      console.error('[datos] destacados:', err);
      return [];
    }
  });
}

/**
 * Una tanda variada del catalogo, para cuando todavia no hay destacados
 * marcados.
 *
 * Traer "los primeros N" da los primeros alfabeticamente, y el catalogo real
 * arranca con Abecedario, Abrojal, Abrochadora, Abrochadora: la portada
 * mostraba cuatro productos casi identicos y parecia rota. Se salta a un punto
 * al azar del orden y se toma de ahi, asi cada visita ve cosas distintas.
 */
export async function traerMuestra(cantidad = 10) {
  const rubros = await cargarRubros();
  const total = rubros.reduce((t, r) => t + (r.cantidad || 0), 0);
  // Se deja margen al final para no caer en el ultimo tramo y volver con menos
  // productos de los pedidos.
  const desde = total > cantidad * 3
    ? Math.floor(Math.random() * (total - cantidad * 2))
    : 0;

  try {
    const snap = await getDocs(query(
      collection(db, 'tienda_productos'),
      where('orden', '>=', desde),
      orderBy('orden'),
      limit(cantidad),
    ));
    return snap.docs.map(armarProducto);
  } catch (err) {
    console.error('[datos] muestra:', err);
    return [];
  }
}

export async function traerProducto(id) {
  return cacheado(`producto:${id}`, async () => {
    const snap = await getDoc(doc(db, 'tienda_productos', id));
    return snap.exists() ? armarProducto(snap) : null;
  });
}

/**
 * Busqueda por palabras.
 *
 * Firestore no tiene busqueda de texto completo. El sync guarda en cada
 * producto un arreglo `tokens` con las palabras de su nombre normalizadas; se
 * consulta por una de las palabras que escribio el cliente (la mas larga es la
 * mas distintiva: en "cuaderno rivadavia" filtrar por "rivadavia" descarta
 * muchisimo mas que filtrar por "cuaderno") y el resto se puntua sobre ese
 * resultado.
 *
 * Dos cosas que esta busqueda tuvo mal y devolvian cero con el producto en el
 * catalogo y con stock:
 *
 *   · La consulta se partia por espacios y se exigian todas las palabras. El
 *     indice no guarda los conectores, asi que "goma de borrar" pedia un token
 *     "de" que no tiene ningun producto. Ahora se despieza igual que el sync.
 *   · Exigir todas las palabras tambien fallaba cuando una era un color:
 *     "cartulina luma celeste" no encontraba nada porque el color vive en las
 *     variedades, no en el nombre. Ahora se puntua cuantas coinciden y se
 *     devuelve el mejor grupo.
 *
 * Es suficiente para un catalogo de libreria y no cuesta un servicio aparte.
 * Si algun dia el catalogo crece mucho, el reemplazo natural es un indice
 * externo, pero no antes de necesitarlo.
 */
export async function buscar(texto, { cantidad = 60 } = {}) {
  const palabras = despiezar(texto);
  if (!palabras.length) return [];

  const clave = `buscar:${palabras.slice().sort().join('+')}`;
  return cacheado(clave, async () => {
    for (const ancla of anclasDe(palabras)) {
      try {
        const snap = await getDocs(query(
          collection(db, 'tienda_productos'),
          where('tokens', 'array-contains', ancla),
          limit(cantidad * 4),
        ));
        if (!snap.docs.length) continue;
        return mejores(snap.docs.map(armarProducto), palabras, ancla).slice(0, cantidad);
      } catch (err) {
        console.error('[datos] busqueda:', err);
        return [];
      }
    }
    return [];
  });
}

/**
 * Por que palabra se pregunta al indice, y en que orden.
 *
 * Se prueban las tres mas largas, no solo la primera: la gente escribe como
 * habla y mete palabras que no son de ningun producto ("tijera para chicos":
 * "chicos" no existe en el catalogo, "tijera" si). Con una sola ancla, una
 * palabra inventada devolvia cero.
 *
 * Las de dos letras quedan afuera mientras haya otra mas larga. Son las que
 * enganchan cualquier cosa: "zzzz no existe" devolvia "Abrochadora Kangaro No.
 * 384556" por el token "no", que es peor que no devolver nada. Si el cliente
 * escribio solo eso ("a4"), se usa igual: es todo lo que hay.
 */
export function anclasDe(palabras) {
  const porLargo = palabras.slice().sort((a, b) => b.length - a.length);
  const fuertes = porLargo.filter(p => p.length >= 3);
  return (fuertes.length ? fuertes : porLargo).slice(0, 3);
}

/**
 * Ordena por relevancia y se queda con el grupo que mas palabras cumple.
 *
 * Cuando algo coincide con todo lo escrito, lo que coincide a medias sobra y
 * ensucia: buscando "cuaderno rivadavia abc" no tiene sentido listar los otros
 * cuarenta cuadernos. Pero si nada cumple todo, mostrar el mejor parcial es
 * infinitamente mejor que "no se encontro nada".
 */
export function mejores(productos, palabras, ancla) {
  const escrito = palabras.join(' ');

  const cuantas = p => palabras.filter(w => p.tokens.some(t => t.startsWith(w))).length;
  const tope = productos.reduce((m, p) => Math.max(m, cuantas(p)), 0);

  return productos
    .filter(p => cuantas(p) === tope)
    .sort((a, b) => {
      // Lo que hay en stock primero: ofrecer algo agotado como primer resultado
      // es la peor respuesta posible.
      if ((a.stock > 0) !== (b.stock > 0)) return a.stock > 0 ? -1 : 1;
      // Lo que EMPIEZA con lo buscado. Sin esto "mochila" trae primero
      // "Hebilla para Mochila": en el catalogo la palabra aparece igual de
      // valida en el medio del nombre.
      const na = normalizar(a.nombre);
      const nb = normalizar(b.nombre);
      const ea = na.startsWith(escrito) ? 0 : na.startsWith(ancla) ? 1 : 2;
      const eb = nb.startsWith(escrito) ? 0 : nb.startsWith(ancla) ? 1 : 2;
      if (ea !== eb) return ea - eb;
      return a.nombre.localeCompare(b.nombre, 'es');
    });
}

/**
 * Sugerencias mientras se escribe.
 *
 * Se combinan dos consultas porque ninguna sola alcanza:
 *
 *   · Por prefijo del nombre. "abro" trae Abrojo y Abrochadora. Es lo que
 *     resuelve el caso de escribir las primeras letras, que es como busca
 *     casi todo el mundo. No sirve para palabras del medio: "faz" no
 *     encuentra "Cinta Doble Faz".
 *   · Por palabra completa, con el arreglo `tokens`. Eso si encuentra "faz",
 *     pero solo cuando la palabra esta entera.
 *
 * Juntas cubren las dos formas de tipear. Se piden en paralelo: encadenarlas
 * duplicaria la espera en cada tecla.
 *
 * @param {string} texto
 * @param {string|null} rubro  acota al rubro que se esta mirando
 */
export async function sugerir(texto, { rubro = null, cantidad = 6 } = {}) {
  const q = normalizar(texto);
  if (q.length < 2) return [];

  return cacheado(`sugerir:${rubro || ''}:${q}`, async () => {
    const col = collection(db, 'tienda_productos');
    const base = rubro ? [where('rubro', '==', rubro)] : [];

    //  es practicamente el ultimo caracter del rango Unicode usable, asi
    // que el rango [q, q+] es "todo lo que empieza con q".
    const porPrefijo = getDocs(query(col, ...base,
      where('nombre_busqueda', '>=', q),
      where('nombre_busqueda', '<=', q + ''),
      limit(cantidad * 2)));

    // La ultima palabra puede estar a medio escribir, asi que se trata aparte:
    // de ella solo se pide que sea el comienzo de algo. Las anteriores se
    // despiezan igual que en el indice, sin conectores — pedir el token "de"
    // de "goma de borrar" no sugeria nada, porque no existe en ningun producto.
    const partes = q.split(/[^0-9a-z]+/).filter(Boolean);
    const parcial = partes[partes.length - 1] || '';
    const completas = despiezar(partes.slice(0, -1).join(' '));

    // Para el array-contains hace falta una palabra entera: la ultima completa
    // que haya, y si el cliente escribio una sola, esa misma.
    const completa = completas.length
      ? completas[completas.length - 1]
      : (VACIAS.has(parcial) ? '' : parcial);

    const porPalabra = completa && completa.length >= 3
      ? getDocs(query(col, ...base,
          where('tokens', 'array-contains', completa), limit(cantidad * 3)))
      : Promise.resolve({ docs: [] });

    let resultados;
    try {
      resultados = await Promise.all([porPrefijo, porPalabra]);
    } catch (err) {
      // Si falta el indice del rubro, se sugiere sobre todo el catalogo antes
      // que no sugerir nada.
      console.warn('[datos] sugerencias:', err?.message || err);
      if (!rubro) return [];
      return sugerir(texto, { rubro: null, cantidad });
    }

    const vistos = new Set();
    const salida = [];
    for (const snap of resultados) {
      for (const d of snap.docs) {
        if (vistos.has(d.id)) continue;
        vistos.add(d.id);
        const p = armarProducto(d);
        // Todas las palabras escritas tienen que aparecer, en cualquier orden.
        // La ultima suele estar a medio escribir, por eso alcanza con que sea
        // el comienzo de alguna palabra del producto.
        const exigidas = parcial && !VACIAS.has(parcial)
          ? [...completas, parcial]
          : completas;
        const entra = exigidas.every(w =>
          p.tokens.some(t => t.startsWith(w)) || normalizar(p.nombre).includes(w));
        if (!entra) continue;
        salida.push(p);
      }
    }

    return salida
      .sort((a, b) => {
        // Lo que hay en stock primero, y despues lo que empieza con lo escrito:
        // es lo que la persona tenia en la cabeza al empezar a tipear.
        if ((a.stock > 0) !== (b.stock > 0)) return a.stock > 0 ? -1 : 1;
        const ea = normalizar(a.nombre).startsWith(q) ? 0 : 1;
        const eb = normalizar(b.nombre).startsWith(q) ? 0 : 1;
        if (ea !== eb) return ea - eb;
        return a.nombre.length - b.nombre.length;
      })
      .slice(0, cantidad);
  });
}
