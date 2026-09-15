/**
 * Los renglones de un pedido, releídos de la base.
 *
 * Lo usan dos funciones: `crear-pedido`, que guarda el pedido con estos
 * precios, y `validar-cupon`, que le muestra al cliente cuánto le descontaría
 * un cupón sobre lo que de verdad cuesta lo que tiene en el carrito. Si cada
 * una armara los renglones a su manera, la vista previa del cupón y el pedido
 * podrían no coincidir.
 *
 * ## Lo que ya está prometido
 *
 * El stock del espejo no baja cuando entra un pedido: baja cuando el local lo
 * marca entregado. Entre una cosa y la otra pasan horas, y en esas horas el
 * último Poxipol se vendía tres veces. Acá se descuenta lo que ya está en
 * pedidos abiertos antes de comparar, y dos renglones del mismo producto se
 * cuentan juntos: el rollo entero y los metros sueltos del mismo color salen
 * del mismo stock.
 */
import { leerDoc, consultar } from './firestore.mjs';
import {
  minimoDe, pasoDe, precioDeRenglon, stockDeRenglon, variedadDe,
  subtotalDeRenglon, redondearCantidad,
} from '../../../src/precios.js';

export const MAX_UNIDADES = 99;
/** Cuántos productos se leen a la vez. Cien en fila eran seis segundos y medio. */
const LECTURAS_A_LA_VEZ = 25;
/** Un pedido en cualquiera de estos estados todavía tiene la mercadería apartada. */
export const ESTADOS_ABIERTOS = ['nuevo', 'preparando', 'listo', 'en_camino'];

/**
 * Cada renglón, releído de la base.
 *
 * Devuelve los renglones armados y la lista de lo que no cerró. Los mismos
 * tipos de cambio que usa `carrito.revalidar()`, así la tienda los muestra con
 * el texto que ya tiene escrito, más el renglón al que van (id, variedad,
 * es_pack) para que `carrito.aplicarCambios()` los aplique.
 *
 * `comprometido` es lo que ya está prometido en pedidos abiertos, por producto
 * y variedad, en unidades sueltas. Con un Map vacío se arma contra el espejo
 * solo, que es lo que hace la vista previa del cupón.
 */
export async function armarRenglones(items, comprometido = new Map()) {
  const lineas = consolidar(items);

  // Todos los productos de una vez y cada uno una sola vez.
  const productos = await leerProductos([...new Set(lineas.map(l => l.id))]);

  const renglones = [];
  const cambios = [];
  // Lo que este mismo pedido va consumiendo, encima de lo ya prometido.
  const usado = new Map(comprometido);
  // El stock del espejo de cada renglón que entró, para la segunda mirada.
  const disponibles = new Map();

  for (const linea of lineas) {
    const { id, variedad, esPack, cantidad: pedida } = linea;
    const producto = productos.get(id);
    const marca = { id, variedad, es_pack: esPack };

    if (!producto) {
      cambios.push({ tipo: 'baja', nombre: linea.nombre || id, ...marca });
      continue;
    }

    const nombre = String(producto.nombre || id);
    const variante = variedadDe(producto, variedad);
    if (variedad && !variante) {
      cambios.push({ tipo: 'baja', nombre: `${nombre} (${variedad})`, ...marca });
      continue;
    }

    // El local puede dejar de vender el rollo entero: el panel tiene un
    // interruptor por producto y el espejo publica `precio_pack: null`.
    if (esPack && !(Number(producto.precio_pack) > 0 && Number(producto.pack_contenido) > 0)) {
      cambios.push({ tipo: 'baja', nombre, ...marca });
      continue;
    }

    const precio = precioDeRenglon(producto, { variedad, esPack });
    if (!(precio > 0)) {
      // Nada sale a cero. Un producto sin precio no se puede cobrar.
      cambios.push({ tipo: 'baja', nombre, ...marca });
      continue;
    }

    // Unidades sueltas que quedan para este renglón, sacando lo prometido en
    // otros pedidos y lo que ya tomó este. Por pack se cuentan packs enteros.
    const contenido = esPack ? Number(producto.pack_contenido) : 1;
    const disponible = redondearCantidad(
      stockDeRenglon(producto, { variedad }) - (usado.get(clave(id, variedad)) || 0));
    const stock = esPack ? Math.floor(disponible / contenido) : disponible;
    const minimo = esPack ? 1 : minimoDe(producto);
    const paso = esPack ? 1 : pasoDe(producto);

    if (stock <= 0 || stock < minimo) {
      cambios.push({ tipo: 'sin_stock', nombre, ...marca });
      continue;
    }

    let cantidad = pedida;
    if (cantidad < minimo) {
      cambios.push({ tipo: 'minimo', nombre, antes: cantidad, ahora: minimo, ...marca });
      cantidad = minimo;
    }
    // Nadie lleva más de 99 desde la pantalla; un POST armado a mano con un
    // millón entraba con 99 y sin aviso. El mínimo que fijó el panel le gana al
    // tope: si algo se vende desde 120, se llevan 120.
    const tope = Math.min(stock, Math.max(MAX_UNIDADES, minimo));
    if (cantidad > tope) {
      cambios.push({ tipo: 'menos_stock', nombre, antes: cantidad, ahora: tope, ...marca });
      cantidad = tope;
    }
    // Lo que se corta del rollo va de a medio metro: pedir 2,3 metros no es una
    // cantidad que el local pueda despachar.
    const enPasos = redondearCantidad(Math.round(cantidad / paso) * paso);
    cantidad = Math.max(minimo, Math.min(tope, enPasos));

    // El precio que el cliente tenía a la vista. Si no coincide se avisa: es el
    // único número del pedido que no puede cambiar sin que lo vea.
    if (linea.precio !== undefined && Number(linea.precio) !== precio) {
      cambios.push({ tipo: 'precio', nombre, antes: Number(linea.precio), ahora: precio, ...marca });
    }

    consumir(usado, id, variedad, cantidad * contenido);
    disponibles.set(clave(id, variedad), stockDeRenglon(producto, { variedad }));

    renglones.push({
      id,
      nombre,
      // La foto viaja adentro del pedido y no se busca después por id: el pedido
      // es una foto de lo que se compró ese día, y el producto puede cambiar de
      // imagen o dejar de publicarse.
      foto: (variante && variante.imagen) || producto.imagenes?.[0] || null,
      // El rubro también: es lo que deja saber si un cupón "de librería" le
      // cae a este renglón, y después contar en qué se usó.
      rubro: String(producto.rubro || ''),
      variedad,
      unidad: esPack ? 'unidad' : (producto.unidad === 'metro' ? 'metro' : 'unidad'),
      es_pack: esPack,
      pack_contenido: esPack ? contenido : null,
      pack_nombre: esPack ? (producto.pack_nombre || producto.pack_tipo || null) : null,
      pack_unidad: producto.unidad === 'metro' ? 'metro' : 'unidad',
      cantidad,
      precio,
      subtotal: subtotalDeRenglon(precio, cantidad),
    });
  }

  return { renglones, cambios, disponibles };
}

/**
 * Los renglones de este pedido que, con todos los pedidos abiertos contados
 * (este incluido), pasan el stock del espejo. Vacío si no se pudo leer: ahí
 * el pedido queda, que es lo que hacía siempre.
 */
export async function excedidosTrasEscribir(armado) {
  const usado = await stockComprometido();
  if (!usado.size) return [];
  return armado.renglones
    .filter(r => {
      const k = clave(r.id, r.variedad);
      return (usado.get(k) || 0) > (armado.disponibles.get(k) ?? Infinity);
    })
    .map(r => ({ tipo: 'sin_stock', nombre: r.nombre, id: r.id, variedad: r.variedad, es_pack: r.es_pack }));
}

/**
 * Los renglones del pedido, uno por producto + variedad + pack.
 *
 * El carrito nunca manda dos veces la misma línea, pero un POST armado a mano
 * sí, y cada una se comparaba sola contra el stock. Juntas, la cantidad se
 * controla una vez.
 */
function consolidar(items) {
  const porClave = new Map();
  for (const i of items) {
    const variedad = i.variedad ? String(i.variedad).trim() || null : null;
    const esPack = i.es_pack === true;
    const k = `${i.id} ${variedad || ''} ${esPack ? 'pack' : 'suelto'}`;
    const cantidad = redondearCantidad(Number(i.cantidad));
    const previa = porClave.get(k);
    if (previa) {
      previa.cantidad = redondearCantidad(previa.cantidad + cantidad);
    } else {
      porClave.set(k, { id: i.id, variedad, esPack, cantidad, nombre: i.nombre, precio: i.precio });
    }
  }
  return [...porClave.values()];
}

/** Los productos de la base, de a tandas en paralelo. */
async function leerProductos(ids) {
  const productos = new Map();
  for (let i = 0; i < ids.length; i += LECTURAS_A_LA_VEZ) {
    const tanda = ids.slice(i, i + LECTURAS_A_LA_VEZ);
    const leidos = await Promise.all(tanda.map(id => leerDoc('tienda_productos', id)));
    tanda.forEach((id, j) => productos.set(id, leidos[j]));
  }
  return productos;
}

/* ── Lo prometido en otros pedidos ────────────────────────────────────────── */

/**
 * Unidades ya prometidas en pedidos abiertos, por producto y por variedad.
 *
 * Un pack cuenta por su contenido. Lo que sale de un color también sale del
 * producto: un renglón sin variedad se compara contra el total.
 *
 * También apartan los que entregó el repartidor y todavía no tienen la venta
 * registrada (`venta_pendiente`): el stock de la vidriera baja recién cuando el
 * panel la registra, y si dejaran de apartar en ese rato se venderían dos veces.
 *
 * Si la lectura falla, el pedido entra igual mirando solo el espejo, que es lo
 * que hacía siempre: perder una venta por no poder leer los pedidos abiertos
 * es peor que arriesgar una sobreventa.
 */
export async function stockComprometido() {
  let abiertos;
  try {
    const [enCurso, pendientes] = await Promise.all([
      consultar('tienda_pedidos', {
        where: [['estado', 'IN', ESTADOS_ABIERTOS]],
        limite: 500,
        campos: ['items'],
      }),
      consultar('tienda_pedidos', {
        where: [['venta_pendiente', 'EQUAL', true]],
        limite: 200,
        campos: ['items'],
      }),
    ]);
    abiertos = [...enCurso, ...pendientes];
  } catch (err) {
    console.warn('[renglones] no se pudieron leer los pedidos abiertos:', err);
    return new Map();
  }

  const usado = new Map();
  for (const pedido of abiertos) {
    for (const r of pedido.items || []) {
      if (!r || typeof r.id !== 'string') continue;
      const contenido = r.es_pack ? Number(r.pack_contenido) || 1 : 1;
      const unidades = Number(r.cantidad) * contenido;
      if (unidades > 0) consumir(usado, r.id, r.variedad || null, unidades);
    }
  }
  return usado;
}

export const clave = (id, variedad) => `${id} ${variedad || ''}`;

function consumir(usado, id, variedad, unidades) {
  sumar(usado, clave(id, variedad), unidades);
  if (variedad) sumar(usado, clave(id, null), unidades);
}

function sumar(mapa, k, n) {
  mapa.set(k, redondearCantidad((mapa.get(k) || 0) + n));
}
