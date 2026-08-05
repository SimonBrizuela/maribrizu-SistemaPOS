/**
 * Carrito.
 *
 * Vive en localStorage: el cliente arma el pedido, cierra el navegador, vuelve
 * a la noche y lo encuentra igual. Sin cuentas de usuario, que en una libreria
 * de barrio solo sirven para perder pedidos.
 */
import { traerProducto } from './datos.js';

const CLAVE = 'liceo.carrito.v1';
const MAX_UNIDADES = 99;

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
      .map(r => ({
        id: r.id,
        variedad: r.variedad || null,
        nombre: String(r.nombre || ''),
        precio: Number(r.precio) || 0,
        cantidad: Math.min(MAX_UNIDADES, Math.max(1, Number(r.cantidad) || 1)),
        foto: r.foto || null,
        rubro: String(r.rubro || ''),
        stock: Number(r.stock) || 0,
      }));
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
function mismaLinea(r, id, variedad) {
  return r.id === id && (r.variedad || null) === (variedad || null);
}

export function suscribir(fn) {
  suscriptores.add(fn);
  fn(renglones);
  return () => suscriptores.delete(fn);
}

export function items() {
  return renglones.slice();
}

export function unidades() {
  return renglones.reduce((t, r) => t + r.cantidad, 0);
}

export function subtotal() {
  return renglones.reduce((t, r) => t + r.precio * r.cantidad, 0);
}

export function estaVacio() {
  return renglones.length === 0;
}

export function cantidadDe(id, variedad = null) {
  const r = renglones.find(x => mismaLinea(x, id, variedad));
  return r ? r.cantidad : 0;
}

/**
 * Agrega y devuelve la cantidad resultante.
 * El tope es el stock: prometer seis de algo que tiene tres termina en una
 * llamada incomoda al cliente.
 */
export function agregar(producto, { variedad = null, cantidad = 1 } = {}) {
  const variante = variedad
    ? (producto.variedades || []).find(v => v.nombre === variedad)
    : null;

  const precio = variante && variante.precio ? Number(variante.precio) : producto.precio;
  const stock  = variante ? Number(variante.stock ?? 0) : producto.stock;
  const tope   = stock > 0 ? Math.min(stock, MAX_UNIDADES) : MAX_UNIDADES;

  const existente = renglones.find(r => mismaLinea(r, producto.id, variedad));
  if (existente) {
    existente.cantidad = Math.min(tope, existente.cantidad + cantidad);
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
    cantidad: Math.min(tope, cantidad),
    foto: producto.imagenes?.[0] || null,
    rubro: producto.rubro || '',
    stock,
  });
  guardar();
  return cantidad;
}

export function cambiarCantidad(id, variedad, cantidad) {
  const r = renglones.find(x => mismaLinea(x, id, variedad));
  if (!r) return;
  const tope = r.stock > 0 ? Math.min(r.stock, MAX_UNIDADES) : MAX_UNIDADES;
  r.cantidad = Math.max(1, Math.min(tope, cantidad));
  guardar();
}

/** Devuelve lo sacado para poder deshacer. */
export function sacar(id, variedad = null) {
  const i = renglones.findIndex(x => mismaLinea(x, id, variedad));
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

export function posicionDe(id, variedad = null) {
  return renglones.findIndex(x => mismaLinea(x, id, variedad));
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

    const stock  = variante ? Number(variante.stock ?? 0) : producto.stock;
    const precio = variante && variante.precio ? Number(variante.precio) : producto.precio;

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
