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
import { normalizar } from './formato.js';

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

/* ── Configuracion ───────────────────────────────────────────────────────── */

const CONFIG_POR_DEFECTO = {
  abierta: true,
  nombre: 'Librería Liceo',
  telefono: '3517046684',
  whatsapp: '5493517046684',
  email: 'libreria.liceo@hotmail.com',
  direccion: 'Av. Alfonsina Storni 168, X5019 Córdoba',
  horarios_texto: 'Lunes a viernes de 9 a 13 y de 16:30 a 20:30 · Sábados de 9 a 13',
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
    precio: Number(d.precio) || 0,
    precio_anterior: d.precio_anterior ? Number(d.precio_anterior) : null,
    stock: Number(d.stock) || 0,
    rubro: d.rubro || '',
    categoria: d.categoria || '',
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
export async function traerProductos({ rubro = null, cursor = null, cantidad = POR_PAGINA } = {}) {
  const col = collection(db, 'tienda_productos');

  const partes = [];
  if (rubro) partes.push(where('rubro', '==', rubro));
  partes.push(orderBy('orden'), orderBy(documentId()));
  if (cursor) partes.push(startAfter(...cursor));
  partes.push(limit(cantidad));

  try {
    const snap = await getDocs(query(col, ...partes));
    return leerPagina(snap, cantidad);
  } catch (err) {
    if (err?.code !== 'failed-precondition') throw err;

    console.warn('[datos] falta el indice compuesto (rubro, orden). Ordenando en el cliente.');
    const alternativa = rubro
      ? query(col, where('rubro', '==', rubro), limit(300))
      : query(col, limit(300));
    const snap = await getDocs(alternativa);
    const todos = snap.docs.map(armarProducto)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    return { productos: todos.slice(0, cantidad), cursor: null, hayMas: false };
  }
}

function leerPagina(snap, cantidad) {
  const productos = snap.docs.map(armarProducto);
  const ultimo = snap.docs[snap.docs.length - 1];
  return {
    productos,
    cursor: ultimo ? [ultimo.get('orden'), ultimo.id] : null,
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
 * consulta por la palabra mas larga que escribio el cliente (la mas
 * distintiva: en "cuaderno rivadavia" filtrar por "rivadavia" descarta muchisimo
 * mas que filtrar por "cuaderno") y el resto se filtra sobre ese resultado.
 *
 * Es suficiente para un catalogo de libreria y no cuesta un servicio aparte.
 * Si algun dia el catalogo crece mucho, el reemplazo natural es un indice
 * externo, pero no antes de necesitarlo.
 */
export async function buscar(texto, { cantidad = 60 } = {}) {
  const palabras = normalizar(texto).split(/\s+/).filter(p => p.length >= 2);
  if (!palabras.length) return [];

  const clave = `buscar:${palabras.slice().sort().join('+')}`;
  return cacheado(clave, async () => {
    const ancla = palabras.slice().sort((a, b) => b.length - a.length)[0];
    const resto = palabras.filter(p => p !== ancla);

    try {
      const snap = await getDocs(query(
        collection(db, 'tienda_productos'),
        where('tokens', 'array-contains', ancla),
        limit(cantidad * 4),
      ));

      return snap.docs
        .map(armarProducto)
        .filter(p => resto.every(r => p.tokens.some(t => t.startsWith(r))))
        .sort((a, b) => {
          // Lo que hay en stock primero: ofrecer algo agotado como primer
          // resultado de una busqueda es la peor respuesta posible.
          if ((a.stock > 0) !== (b.stock > 0)) return a.stock > 0 ? -1 : 1;
          return a.nombre.localeCompare(b.nombre, 'es');
        })
        .slice(0, cantidad);
    } catch (err) {
      console.error('[datos] busqueda:', err);
      return [];
    }
  });
}
