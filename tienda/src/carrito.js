/**
 * Carrito.
 *
 * Vive en localStorage: el cliente arma el pedido, cierra el navegador, vuelve
 * a la noche y lo encuentra igual. Sin cuentas de usuario, que en una libreria
 * de barrio solo sirven para perder pedidos.
 */
import { traerProducto } from './datos.js';

// v2: los renglones ahora guardan la unidad de medida y el paso. Cambiar la
// clave descarta los carritos viejos en vez de intentar migrarlos: un carrito
// abandonado no vale el codigo de migracion.
const CLAVE = 'liceo.carrito.v2';
const MAX_UNIDADES = 99;

/** Cuanto suma o resta un toque, segun como se venda el producto. */
export function pasoDe(unidad) {
  return unidad === 'metro' ? 0.5 : 1;
}

/** 2.5 -> "2,5 m"  ·  3 -> "3" */
export function formatearCantidad(cantidad, unidad) {
  if (unidad === 'metro') return `${cantidad.toFixed(1).replace('.', ',')} m`;
  return String(Math.round(cantidad));
}

const suscriptores = new Set();

/** @typedef {{id:string, variedad:string|null, nombre:string, precio:number,
 *             cantidad:number, foto:string|null, rubro:string, stock:number}} Renglon */

/** @type {Renglon[]} */
let renglones = leerDelDisco();

function leerDelDisco() {
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return [];
    const datos = JSON.parse(crudo);
    if (!Array.isArray(datos)) return [];
    // Se sanea al leer: un localStorage editado a mano no puede romper la app.
    return datos
      .filter(r => r && typeof r.id === 'string')
      .map(r => {
        const unidad = r.unidad === 'metro' ? 'metro' : 'unidad';
        const paso = pasoDe(unidad);
        return {
          id: r.id,
          variedad: r.variedad || null,
          nombre: String(r.nombre || ''),
          precio: Number(r.precio) || 0,
          cantidad: Math.min(MAX_UNIDADES, Math.max(paso, Number(r.cantidad) || paso)),
          unidad,
          es_pack: r.es_pack === true,
          pack_contenido: Number(r.pack_contenido) || null,
          foto: r.foto || null,
          rubro: String(r.rubro || ''),
          stock: Number(r.stock) || 0,
        };
      });
  } catch {
    return [];
  }
}

function guardar() {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(renglones));
  } catch (err) {
    // Modo incognito de Safari, cuota llena. El carrito sigue andando en
    // memoria; solo se pierde al recargar.
    console.warn('[carrito] no se pudo guardar:', err);
  }
  suscriptores.forEach(fn => fn(renglones));
}

/** Un producto con dos variedades distintas son dos renglones. */
function mismaLinea(r, id, variedad, esPack = false) {
  return r.id === id
      && (r.variedad || null) === (variedad || null)
      // Dos metros sueltos y el rollo entero son dos renglones distintos:
      // tienen precios distintos y no se pueden sumar.
      && r.es_pack === esPack;
}

export function suscribir(fn) {
  suscriptores.add(fn);
  fn(renglones);
  return () => suscriptores.delete(fn);
}

export function items() {
  return renglones.slice();
}

/**
 * Cuantos renglones tiene el pedido, no cuantas unidades.
 *
 * Sumar las cantidades daria "2,5 productos" cuando hay dos metros y medio de
 * cinta. El globo del carrito cuenta cosas distintas, que es lo que la persona
 * espera ver ahi.
 */
export function unidades() {
  return renglones.length;
}

export function subtotal() {
  return renglones.reduce((t, r) => t + r.precio * r.cantidad, 0);
}

export function estaVacio() {
  return renglones.length === 0;
}

export function cantidadDe(id, variedad = null, esPack = false) {
  const r = renglones.find(x => mismaLinea(x, id, variedad, esPack));
  return r ? r.cantidad : 0;
}

/**
 * Agrega y devuelve la cantidad resultante.
 *
 * `cantidad` va en la unidad del producto: 2,5 significa dos metros y medio de
 * cinta, o dos boligrafos y medio, que no existe, y por eso el paso lo decide
 * la unidad y no quien llama.
 *
 * El tope es el stock: prometer seis de algo que tiene tres termina en una
 * llamada incomoda al cliente.
 */
export function agregar(producto, { variedad = null, cantidad = null, esPack = false } = {}) {
  const variante = variedad
    ? (producto.variedades || []).find(v => v.nombre === variedad)
    : null;

  const unidad = esPack ? 'unidad' : (producto.unidad || 'unidad');
  const paso = pasoDe(unidad);
  let cuanto = cantidad ?? paso;

  // Llevar el rollo entero es otro producto a efectos del carrito: otro precio,
  // otra unidad, y descuenta del stock tantas unidades como trae el pack.
  const precio = esPack
    ? Number(producto.precio_pack || 0)
    : (variante && variante.precio ? Number(variante.precio) : producto.precio);

  const stockUnidades = variante ? Number(variante.stock ?? 0) : producto.stock;
  const contenido = Number(producto.pack_contenido) || 1;
  const stock = esPack ? Math.floor(stockUnidades / contenido) : stockUnidades;

  const tope = stock > 0 ? Math.min(stock, MAX_UNIDADES) : MAX_UNIDADES;

  const existente = renglones.find(r => mismaLinea(r, producto.id, variedad, esPack));
  if (existente) {
    existente.cantidad = redondear(Math.min(tope, existente.cantidad + cuanto));
    existente.precio = precio;
    existente.stock = stock;
    guardar();
    return existente.cantidad;
  }

  renglones.push({
    id: producto.id,
    variedad,
    nombre: producto.nombre,
    precio,
    cantidad: redondear(Math.min(tope, cuanto)),
    unidad,
    es_pack: esPack,
    pack_contenido: esPack ? contenido : null,
    foto: producto.imagenes?.[0] || null,
    rubro: producto.rubro || '',
    stock,
  });
  guardar();
  return cuanto;
}

/**
 * Los flotantes dejan restos tipo 2.4000000000000004 al sumar de a 0,5. Un
 * decimal alcanza para medio metro y evita que el total salga con centavos
 * fantasma.
 */
function redondear(n) {
  return Math.round(n * 10) / 10;
}

export function cambiarCantidad(id, variedad, cantidad, esPack = false) {
  const r = renglones.find(x => mismaLinea(x, id, variedad, esPack));
  if (!r) return;
  const paso = pasoDe(r.unidad);
  const tope = r.stock > 0 ? Math.min(r.stock, MAX_UNIDADES) : MAX_UNIDADES;
  r.cantidad = redondear(Math.max(paso, Math.min(tope, cantidad)));
  guardar();
}

/** Devuelve lo sacado para poder deshacer. */
export function sacar(id, variedad = null, esPack = false) {
  const i = renglones.findIndex(x => mismaLinea(x, id, variedad, esPack));
  if (i === -1) return null;
  const [fuera] = renglones.splice(i, 1);
  guardar();
  return fuera;
}

/** Vuelve a poner un renglon en su lugar original (deshacer). */
export function restaurar(renglon, posicion = null) {
  if (!renglon) return;
  if (posicion === null || posicion > renglones.length) renglones.push(renglon);
  else renglones.splice(posicion, 0, renglon);
  guardar();
}

export function posicionDe(id, variedad = null, esPack = false) {
  return renglones.findIndex(x => mismaLinea(x, id, variedad, esPack));
}

export function vaciar() {
  renglones = [];
  guardar();
}

/**
 * Revalida precios y stock contra la base antes de confirmar.
 *
 * Entre que el cliente arma el carrito y confirma pueden pasar horas, y en el
 * medio el POS del local vendio, repuso y cambio precios. Confirmar con los
 * datos viejos genera un pedido que no se puede cumplir.
 *
 * Devuelve la lista de cambios para avisarle al cliente antes de que confirme,
 * nunca en silencio.
 */
export async function revalidar() {
  const cambios = [];
  const vivos = [];

  for (const r of renglones) {
    const producto = await traerProducto(r.id);

    if (!producto) {
      cambios.push({ tipo: 'baja', nombre: r.nombre });
      continue;
    }

    const variante = r.variedad
      ? (producto.variedades || []).find(v => v.nombre === r.variedad)
      : null;

    if (r.variedad && !variante) {
      cambios.push({ tipo: 'baja', nombre: `${r.nombre} (${r.variedad})` });
      continue;
    }

    const contenido = Number(producto.pack_contenido) || 1;
    const stockUnidades = variante ? Number(variante.stock ?? 0) : producto.stock;

    const stock = r.es_pack ? Math.floor(stockUnidades / contenido) : stockUnidades;
    const precio = r.es_pack
      ? Number(producto.precio_pack || 0)
      : (variante && variante.precio ? Number(variante.precio) : producto.precio);

    if (stock <= 0) {
      cambios.push({ tipo: 'sin_stock', nombre: r.nombre });
      continue;
    }

    if (stock < r.cantidad) {
      cambios.push({ tipo: 'menos_stock', nombre: r.nombre, antes: r.cantidad, ahora: stock });
      r.cantidad = stock;
    }

    if (precio !== r.precio) {
      cambios.push({ tipo: 'precio', nombre: r.nombre, antes: r.precio, ahora: precio });
      r.precio = precio;
    }

    r.stock = stock;
    r.nombre = producto.nombre;
    vivos.push(r);
  }

  renglones = vivos;
  guardar();
  return cambios;
}
