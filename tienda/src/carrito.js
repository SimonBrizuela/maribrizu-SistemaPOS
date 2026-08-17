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

/**
 * Cuanto suma o resta un toque.
 *
 * Se acepta el producto entero o solo su unidad: el panel puede fijar un paso
 * propio por producto ("de a 6"), y cuando no lo hizo vale el natural — medio
 * metro para lo que se corta del rollo, uno para el resto.
 */
export function pasoDe(productoOUnidad) {
  if (typeof productoOUnidad === 'object' && productoOUnidad) {
    const propio = Number(productoOUnidad.paso);
    if (propio > 0) return propio;
    return productoOUnidad.unidad === 'metro' ? 0.5 : 1;
  }
  return productoOUnidad === 'metro' ? 0.5 : 1;
}

/**
 * Lo minimo que se puede llevar de este producto.
 *
 * Un pedido online cuesta trabajo aunque sea de $100: hay que leerlo, buscar la
 * cosa entre dos mil cuatrocientas, contarla, embalarla. Por eso hay productos
 * que en el mostrador se venden de a uno y por la web no: medido, un mapa de
 * $100 deja $40 y eso no paga ni el minuto de ir a buscarlo.
 *
 * Sin configurar es un paso, o sea como estaba siempre.
 */
export function minimoDe(producto) {
  const propio = Number(producto?.minimo);
  const paso = pasoDe(producto);
  return propio > 0 ? Math.max(propio, paso) : paso;
}

/** 2.5 -> "2,5 m"  ·  3 -> "3" */
export function formatearCantidad(cantidad, unidad) {
  if (unidad === 'metro') return `${cantidad.toFixed(1).replace('.', ',')} m`;
  return String(Math.round(cantidad));
}

/**
 * Arriba de este porcentaje el ahorro no se muestra.
 *
 * Una resma de 500 hojas a $7.800 contra la hoja suelta a $50 da "Ahorrás
 * 69%", y es cierto: la hoja de a una se cobra como se cobra en el mostrador.
 * Pero dicho asi suena a que lo suelto esta caro, no a que el pack conviene.
 * De ahi para arriba se muestra el precio del pack y listo.
 */
const TOPE_AHORRO_PACK = 50;

/**
 * Cuanto se ahorra llevando el pack en vez de lo mismo suelto.
 *
 * Una sola cuenta para la ficha, el carrito y el checkout: si en la ficha dice
 * 12%, en el resumen del pedido no puede decir otra cosa. Devuelve null cuando
 * no hay ahorro que mostrar (no conviene, o conviene tanto que no se dice).
 *
 * @returns {{ pesos: number, porcentaje: number } | null}
 */
export function ahorroDePack({ precioSuelto, precioPack, contenido, cantidad = 1 }) {
  const suelto = Number(precioSuelto) * Number(contenido) * Number(cantidad);
  const pack = Number(precioPack) * Number(cantidad);
  if (!(suelto > 0) || !(pack > 0)) return null;
  const pesos = suelto - pack;
  const porcentaje = Math.round((pesos / suelto) * 100);
  if (pesos <= 0 || porcentaje <= 0 || porcentaje > TOPE_AHORRO_PACK) return null;
  return { pesos, porcentaje };
}

/**
 * Como se describe un renglon de pack: "Rollo de 50 m", "Caja de 12",
 * "Pack de 50".
 *
 * Usa el nombre que le pusieron en el panel (o el tipo que trae el POS), igual
 * que la ficha del producto: si ahi dice "rollo", en el carrito no puede decir
 * "pack". El contenido va en metros cuando lo suelto se vende por metro.
 */
export function describirPack(r) {
  const contenido = Number(r?.pack_contenido) || 0;
  let nombre = String(r?.pack_nombre || 'pack').toLowerCase().trim()
    .replace(/^(el|la|los|las)\s+/, '');
  nombre = nombre.charAt(0).toUpperCase() + nombre.slice(1);
  if (!contenido) return nombre;
  // "Caja de 12" ya escrito en el panel: no se repite el contenido.
  if (/\bde\s+\d/.test(nombre)) return nombre;
  return `${nombre} de ${contenido}${r?.pack_unidad === 'metro' ? ' m' : ''}`;
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
        const paso = Number(r.paso) > 0 ? Number(r.paso) : pasoDe(unidad);
        const minimo = Number(r.minimo) > 0 ? Math.max(Number(r.minimo), paso) : paso;
        return {
          id: r.id,
          variedad: r.variedad || null,
          nombre: String(r.nombre || ''),
          precio: Number(r.precio) || 0,
          cantidad: Math.min(MAX_UNIDADES, Math.max(minimo, Number(r.cantidad) || minimo)),
          unidad,
          paso,
          minimo,
          es_pack: r.es_pack === true,
          pack_contenido: Number(r.pack_contenido) || null,
          pack_nombre: r.pack_nombre ? String(r.pack_nombre) : null,
          pack_unidad: r.pack_unidad === 'metro' ? 'metro' : 'unidad',
          precio_suelto: Number(r.precio_suelto) || null,
          foto: r.foto || null,
          rubro: String(r.rubro || ''),
          sub_rubro: String(r.sub_rubro || ''),
          aviso: r.aviso ? String(r.aviso) : null,
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

  // El pack entero se lleva de a uno: el minimo y el paso del producto son de
  // la unidad suelta (medio metro de cinta), no del rollo.
  const unidad = esPack ? 'unidad' : (producto.unidad || 'unidad');
  const paso = esPack ? 1 : pasoDe(producto);
  const minimo = esPack ? 1 : minimoDe(producto);
  let cuanto = cantidad ?? minimo;

  // Llevar el rollo entero es otro producto a efectos del carrito: otro precio,
  // otra unidad, y descuenta del stock tantas unidades como trae el pack.
  const precio = esPack
    ? Number(producto.precio_pack || 0)
    : (variante && variante.precio ? Number(variante.precio) : producto.precio);

  // Precio de a uno del mismo producto: es contra lo que se compara el pack
  // para mostrar cuánto se ahorra, misma cuenta que en la ficha.
  const precioSuelto = esPack ? Number(producto.precio || 0) : null;

  const stockUnidades = variante ? Number(variante.stock ?? 0) : producto.stock;
  const contenido = Number(producto.pack_contenido) || 1;
  const stock = esPack ? Math.floor(stockUnidades / contenido) : stockUnidades;

  const tope = stock > 0 ? Math.min(stock, MAX_UNIDADES) : MAX_UNIDADES;

  const existente = renglones.find(r => mismaLinea(r, producto.id, variedad, esPack));
  if (existente) {
    existente.cantidad = redondear(Math.min(tope, existente.cantidad + cuanto));
    existente.precio = precio;
    existente.precio_suelto = precioSuelto;
    existente.stock = stock;
    existente.minimo = minimo;
    existente.paso = paso;
    guardar();
    return existente.cantidad;
  }

  // El primero entra directo en el minimo. Sumar de a un paso desde cero
  // obligaria a tocar el boton diez veces antes de poder comprar.
  const inicial = Math.max(minimo, cuanto);

  renglones.push({
    id: producto.id,
    variedad,
    nombre: producto.nombre,
    precio,
    cantidad: redondear(Math.min(tope, inicial)),
    unidad,
    paso,
    minimo,
    es_pack: esPack,
    pack_contenido: esPack ? contenido : null,
    pack_nombre: esPack ? (producto.pack_nombre || producto.pack_tipo || null) : null,
    pack_unidad: producto.unidad === 'metro' ? 'metro' : 'unidad',
    precio_suelto: precioSuelto,
    // La foto del color que se lleva, si la tiene; si no, la portada. Es la
    // que se ve en el carrito, en el checkout y en el pedido que imprime el
    // local: con la portada sola, tres cartulinas de colores distintos son
    // tres renglones con la misma foto.
    foto: (variante && variante.imagen) || producto.imagenes?.[0] || null,
    rubro: producto.rubro || '',
    // Se guardan para poder mostrar el aviso del local en el checkout sin
    // volver a leer el producto: ahi es donde el cliente confirma y donde
    // "no hay devolucion" tiene que estar a la vista.
    sub_rubro: producto.sub_rubro || '',
    aviso: producto.aviso || null,
    stock,
  });
  guardar();
  return redondear(Math.min(tope, inicial));
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
  const piso = r.minimo || pasoDe(r.unidad);
  const tope = r.stock > 0 ? Math.min(r.stock, MAX_UNIDADES) : MAX_UNIDADES;
  r.cantidad = redondear(Math.max(piso, Math.min(tope, cantidad)));
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

    // El minimo puede haber cambiado desde el panel mientras el carrito
    // esperaba, asi que se relee y se aplica antes de comparar contra el stock.
    const paso = r.es_pack ? 1 : pasoDe(producto);
    const minimo = r.es_pack ? 1 : minimoDe(producto);
    r.paso = paso;
    r.minimo = minimo;

    if (stock <= 0) {
      cambios.push({ tipo: 'sin_stock', nombre: r.nombre });
      continue;
    }

    // Quedan tres cuando el minimo son cinco: no alcanza para venderlo. Es un
    // "sin stock" desde donde lo mira el cliente.
    if (stock < minimo) {
      cambios.push({ tipo: 'sin_stock', nombre: r.nombre });
      continue;
    }

    if (r.cantidad < minimo) {
      cambios.push({ tipo: 'minimo', nombre: r.nombre, antes: r.cantidad, ahora: minimo });
      r.cantidad = minimo;
    }

    if (stock < r.cantidad) {
      cambios.push({ tipo: 'menos_stock', nombre: r.nombre, antes: r.cantidad, ahora: stock });
      r.cantidad = stock;
    }

    if (precio !== r.precio) {
      cambios.push({ tipo: 'precio', nombre: r.nombre, antes: r.precio, ahora: precio });
      r.precio = precio;
    }

    if (r.es_pack) {
      r.precio_suelto = Number(producto.precio || 0);
      r.pack_nombre = producto.pack_nombre || producto.pack_tipo || null;
      r.pack_unidad = producto.unidad === 'metro' ? 'metro' : 'unidad';
    }
    r.stock = stock;
    r.nombre = producto.nombre;
    vivos.push(r);
  }

  renglones = vivos;
  guardar();
  return cambios;
}
