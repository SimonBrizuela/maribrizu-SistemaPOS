/**
 * Crea el pedido, con los precios sacados de la base y no del navegador.
 *
 * ## Por qué existe
 *
 * Antes el pedido lo escribía el cliente directo en Firestore. Las reglas
 * validaban la forma del documento —que hubiera nombre, que el total fuera
 * subtotal más envío— pero ningún precio: nada impedía abrir la consola,
 * cambiar `precio: 18000` por `precio: 1` y confirmar. El pedido entraba
 * perfecto, las reglas lo aceptaban, y el local se enteraba al ir a cobrarlo.
 *
 * El envío ya se calculaba del lado del servidor por esta misma razón. Los
 * productos, no.
 *
 * ## Qué manda el cliente y qué no
 *
 * Manda QUÉ quiere: id del producto, variedad, cantidad y si lleva el pack
 * entero. Nada de precios. El precio, el mínimo de venta, el stock, el envío y
 * el total salen de acá, leyendo `tienda_productos` y `tienda_config` igual que
 * los lee la tienda.
 *
 * Si algo cambió mientras el cliente decidía —subió un precio, se agotó un
 * color— no se corrige en silencio: se devuelve 409 con la lista de cambios y
 * la tienda se los muestra antes de volver a preguntar. Confirmar un pedido con
 * otro número del que estaba a la vista es peor que hacerlo revisar. Cada
 * cambio dice a qué renglón va (id, variedad, pack) para que el carrito lo
 * pueda aplicar solo.
 *
 * ## Lo que ya está prometido
 *
 * El stock del espejo no baja cuando entra un pedido: baja cuando el local lo
 * marca entregado. Entre una cosa y la otra pasan horas, y en esas horas el
 * último Poxipol se vendía tres veces: cada pedido miraba el espejo, veía uno,
 * y entraba. Acá se descuenta lo que ya está en pedidos abiertos antes de
 * comparar.
 *
 * Eso deja la ventana de dos pedidos en el mismo instante, que ninguno ve al
 * otro. Para esa, el pedido vuelve a mirar los pedidos abiertos DESPUÉS de
 * escribirse: si con él adentro se pasa el stock, se borra solo y contesta
 * "sin stock". Los dos pueden retirarse a la vez y la última unidad quedar sin
 * vender hasta que uno reintente; es el lado correcto para equivocarse. Las
 * consultas de Firestore son consistentes, así que el que escribió segundo
 * siempre ve al primero.
 *
 * Por lo mismo, dos renglones del mismo producto se cuentan juntos: el
 * carrito no los genera, pero un POST armado a mano con la Poxilina dos veces
 * entraba con el doble del stock.
 *
 * ## El código corto
 *
 * Son cuatro letras de un alfabeto de 32: un millón de combinaciones, que
 * suena a mucho hasta que se hace la cuenta del cumpleaños. Con mil pedidos
 * la probabilidad de que dos compartan código es del 38 %; con dos mil, del
 * 85 %. Y el panel guarda la venta del pedido entregado en `ventas/TIENDA_<código>`,
 * así que dos pedidos con el mismo código se pisan la venta. Antes de guardar
 * se comprueba que el código no exista.
 *
 * ## Sin cuenta de servicio
 *
 * Devuelve 501 y la tienda sigue creando el pedido como antes. Es lo que
 * permite desplegar esto sin cortar las ventas: se prende la variable de
 * entorno, se comprueba que los pedidos entran por acá, y recién entonces las
 * reglas cierran la creación directa. Con las reglas cerradas este camino es el
 * único que queda.
 */
import crypto from 'node:crypto';
import {
  leerDoc, leerConfigTienda, crearDoc, borrarDoc, consultar, hayCredenciales, uidDelToken,
} from './lib/firestore.mjs';
import { coordenadaValida, medirMetros, kmDeMetros } from './lib/rutas.mjs';
import { precioPorDistancia, llegaAEnvioGratis } from '../../src/envio.js';
import { estadoDelLocal } from '../../src/horarios.js';
import {
  minimoDe, pasoDe, precioDeRenglon, stockDeRenglon, variedadDe,
  subtotalDeRenglon, redondearCantidad,
} from '../../src/precios.js';

const MAX_RENGLONES = 100;
const MAX_UNIDADES = 99;
/** Cuántos productos se leen a la vez. Cien en fila eran seis segundos y medio. */
const LECTURAS_A_LA_VEZ = 25;
/** Un pedido en cualquiera de estos estados todavía tiene la mercadería apartada. */
const ESTADOS_ABIERTOS = ['nuevo', 'preparando', 'listo', 'en_camino'];
const INTENTOS_DE_CODIGO = 5;

// La apiKey pública de la tienda, la misma que viaja en el bundle. Solo se usa
// para preguntarle a Google de quién es un token de sesión.
const API_KEY = 'AIzaSyDBqPTloSp1MWBFcVMY6mdgyYKoqhTwFRA';

export default async (peticion) => {
  if (peticion.method !== 'POST') {
    return new Response('Método no permitido', { status: 405 });
  }

  if (!hayCredenciales()) {
    // No es un error: es que todavía no está configurada. La tienda lo entiende
    // y crea el pedido por el camino viejo.
    return Response.json({ error: 'sin_credenciales' }, { status: 501 });
  }

  let cuerpo;
  try {
    cuerpo = await peticion.json();
  } catch {
    return new Response('Cuerpo inválido', { status: 400 });
  }

  // Precalentamiento: despierta la instancia y deja la config leída mientras el
  // cliente completa sus datos, igual que las otras funciones del checkout.
  if (cuerpo?.warmup) {
    leerConfigTienda().catch(() => {});
    return new Response(null, { status: 204 });
  }

  const problema = validarForma(cuerpo);
  if (problema) return Response.json({ error: 'forma', detalle: problema }, { status: 400 });

  // Lo prometido en otros pedidos y si este id ya está guardado se buscan
  // mientras se lee la configuración: tres viajes a la base que no dependen
  // uno del otro. Ninguno rechaza.
  const comprometidoPromesa = stockComprometido();
  const existentePromesa = idValido(cuerpo.id)
    ? leerDoc('tienda_pedidos', cuerpo.id).catch(() => null)
    : Promise.resolve(null);

  let cfg;
  try {
    cfg = await leerConfigTienda();
  } catch (err) {
    console.error('[crear-pedido] no se pudo leer la configuración:', err);
    return new Response('No se pudo leer la configuración', { status: 502 });
  }

  // Un reintento del cliente cuya primera respuesta se perdió trae el mismo
  // id. Se contesta antes de mirar el stock: el primer intento ya cuenta como
  // prometido, y si se llevó la última unidad, el reintento vería "sin stock"
  // y el cliente sacaría del carrito algo que ya tiene pedido.
  if (await existentePromesa) {
    return Response.json({ error: 'ya_existe' }, { status: 409 });
  }

  const entrega = cfg.entrega || {};
  const modo = cuerpo.entrega.modo;

  // El horario se controla acá y no solo en la pantalla: la tienda muestra
  // "cerrado" y apaga el botón, pero un POST armado a mano no pasa por la
  // pantalla. Cubre también el interruptor del panel (`abierta: false`).
  const estadoLocal = estadoDelLocal(cfg);
  if (!estadoLocal.abierto) {
    return Response.json(
      { error: 'cerrada', motivo: estadoLocal.motivo, abre: estadoLocal.abre },
      { status: 409 });
  }
  if (modo === 'delivery' && entrega.delivery_habilitado === false) {
    return Response.json({ error: 'sin_delivery' }, { status: 409 });
  }
  if (modo === 'retiro' && entrega.retiro_habilitado === false) {
    return Response.json({ error: 'sin_retiro' }, { status: 409 });
  }
  // El efectivo se prende y se apaga desde el panel. Sin este control, alguien
  // que dejó el checkout abierto desde ayer puede confirmar pagando de una
  // forma que el local ya no acepta.
  if (cuerpo.pago?.modo === 'efectivo' && cfg.pago?.efectivo_habilitado !== true) {
    return Response.json({ error: 'sin_efectivo' }, { status: 409 });
  }

  /* ── Los renglones, con los precios de la base ──────────────────────────── */

  let armado;
  try {
    armado = await armarRenglones(cuerpo.items, await comprometidoPromesa);
  } catch (err) {
    console.error('[crear-pedido] no se pudieron leer los productos:', err);
    return new Response('No se pudieron leer los productos', { status: 502 });
  }

  if (armado.cambios.length) {
    return Response.json({ error: 'cambios', cambios: armado.cambios }, { status: 409 });
  }
  if (!armado.renglones.length) {
    return Response.json({ error: 'vacio' }, { status: 409 });
  }

  const subtotal = armado.renglones.reduce((t, r) => t + r.subtotal, 0);

  // El código y la sesión se resuelven mientras se mide el envío: tres viajes
  // que no dependen entre sí, y el cliente está esperando. Ninguno rechaza.
  const codigoPromesa = codigoLibre();
  const uidPromesa = uidDelToken(cuerpo.idToken, API_KEY);

  /* ── El envío, medido de nuevo ──────────────────────────────────────────── */

  const envioCalculado = modo === 'delivery'
    ? await calcularEnvio({ cfg, entrega, destino: cuerpo.entrega.coordenadas, subtotal })
    : { precio: 0, km: null, a_confirmar: false, fuera_de_radio: false };

  if (envioCalculado.fuera_de_radio) {
    return Response.json({ error: 'fuera_de_radio', km: envioCalculado.km }, { status: 409 });
  }

  const envio = envioCalculado.precio;
  const total = subtotal + envio;

  const minimo = Number(entrega.pedido_minimo) || 0;
  if (minimo > 0 && total < minimo) {
    return Response.json({ error: 'minimo', falta: minimo - total, minimo }, { status: 409 });
  }

  /* ── A la base ──────────────────────────────────────────────────────────── */

  const [codigo, uid] = await Promise.all([codigoPromesa, uidPromesa]);
  const id = idValido(cuerpo.id) ? cuerpo.id : nuevoId();

  const documento = {
    estado: 'nuevo',
    creado: new Date(),
    // Los dos flags operativos nacen en falso y los mueve el local: un pedido no
    // puede entrar diciendo que ya se imprimió.
    impreso: false,
    visto: false,
    codigo,
    cliente: {
      nombre: recortar(cuerpo.cliente.nombre, 80),
      telefono: recortar(cuerpo.cliente.telefono, 30),
    },
    ...(uid ? { uid } : {}),
    entrega: {
      modo,
      direccion: modo === 'delivery' ? recortar(cuerpo.entrega.direccion, 200) : null,
      referencia: modo === 'delivery' ? recortar(cuerpo.entrega.referencia, 200) : null,
      coordenadas: modo === 'delivery' && coordenadaValida(cuerpo.entrega.coordenadas)
        ? { lat: Number(cuerpo.entrega.coordenadas.lat), lng: Number(cuerpo.entrega.coordenadas.lng) }
        : null,
      distancia_km: envioCalculado.km,
      // Le dice al local que el número todavía no es definitivo: sin altura el
      // precio sale del centro de la calle y puede caer en otro tramo.
      envio_a_confirmar: Boolean(envioCalculado.a_confirmar
        || (modo === 'delivery' && cuerpo.entrega.envio_a_confirmar === true && envio > 0)),
      demora_texto: entrega.demora_texto || null,
    },
    pago: {
      modo: cuerpo.pago?.modo === 'efectivo' ? 'efectivo' : 'transferencia',
      pagado: false,
    },
    items: armado.renglones,
    subtotal,
    envio,
    total,
    nota: recortar(cuerpo.nota, 500),
  };

  try {
    await crearDoc('tienda_pedidos', id, documento);
  } catch (err) {
    if (err?.yaExiste) {
      return Response.json({ error: 'ya_existe' }, { status: 409 });
    }
    console.error('[crear-pedido] no se pudo guardar:', err);
    return new Response('No se pudo guardar el pedido', { status: 502 });
  }

  // Segunda mirada, ya escrito: si otro pedido entró en el mismo instante y
  // entre los dos pasan el stock, este se retira.
  const excedidos = await excedidosTrasEscribir(armado);
  if (excedidos.length) {
    try {
      await borrarDoc('tienda_pedidos', id);
    } catch (err) {
      // Quedó escrito y no se pudo sacar: se da por hecho. Decir "falló"
      // sobre un pedido que el local ya ve termina en dos pedidos.
      console.error('[crear-pedido] no se pudo retirar el pedido excedido:', err);
      return Response.json({ id, codigo, subtotal, envio, total });
    }
    console.warn('[crear-pedido] pedido retirado por sobreventa simultánea:',
                 excedidos.map(c => c.nombre).join(', '));
    return Response.json({ error: 'cambios', cambios: excedidos }, { status: 409 });
  }

  return Response.json({ id, codigo, subtotal, envio, total });
};

/* ── Validación ───────────────────────────────────────────────────────────── */

const esTexto = x => typeof x === 'string';
/** Un texto que puede faltar, pero si viene tiene que ser texto. */
const esTextoOpcional = x => x === undefined || x === null || esTexto(x);

function validarForma(c) {
  if (!c || typeof c !== 'object') return 'cuerpo';
  if (!c.cliente || typeof c.cliente !== 'object') return 'cliente';

  // Texto de verdad: un objeto pasaba como "[object Object]" y un número como
  // su cifra, y el local recibía un pedido a nombre de "12345678".
  if (!esTexto(c.cliente.nombre)) return 'nombre';
  if (!esTexto(c.cliente.telefono)) return 'telefono';
  const nombre = c.cliente.nombre.trim();
  const telefono = c.cliente.telefono.trim();
  if (nombre.length < 2 || nombre.length > 80) return 'nombre';
  if (telefono.length < 6 || telefono.length > 30) return 'telefono';

  if (!c.entrega || !['delivery', 'retiro'].includes(c.entrega.modo)) return 'entrega';
  if (c.entrega.modo === 'delivery' && !(esTexto(c.entrega.direccion) && c.entrega.direccion.trim())) {
    return 'direccion';
  }
  if (!esTextoOpcional(c.entrega.referencia)) return 'referencia';
  if (!esTextoOpcional(c.nota)) return 'nota';

  if (!Array.isArray(c.items) || !c.items.length || c.items.length > MAX_RENGLONES) {
    return 'items';
  }
  for (const i of c.items) {
    if (!i || typeof i !== 'object' || !esTexto(i.id) || !i.id) return 'item';
    // Número o texto numérico. `1e400` en JSON es Infinity y `[5]` es cinco:
    // ninguno de los dos es una cantidad.
    if (!['number', 'string'].includes(typeof i.cantidad)) return 'cantidad';
    const cantidad = Number(i.cantidad);
    if (!Number.isFinite(cantidad) || !(cantidad > 0)) return 'cantidad';
    if (!esTextoOpcional(i.variedad)) return 'variedad';
  }

  if (c.id !== undefined && c.id !== null && !idValido(c.id)) return 'id';
  return null;
}

/** Los ids de Firestore son veinte caracteres alfanuméricos. */
function idValido(id) {
  return typeof id === 'string' && /^[A-Za-z0-9]{15,40}$/.test(id);
}

function recortar(texto, largo) {
  return String(texto ?? '').trim().slice(0, largo);
}

/* ── Renglones ────────────────────────────────────────────────────────────── */

/**
 * Cada renglón, releído de la base.
 *
 * Devuelve los renglones armados y la lista de lo que no cerró. Los mismos
 * tipos de cambio que usa `carrito.revalidar()`, así la tienda los muestra con
 * el texto que ya tiene escrito, más el renglón al que van (id, variedad,
 * es_pack) para que `carrito.aplicarCambios()` los aplique.
 *
 * `comprometido` es lo que ya está prometido en pedidos abiertos, por producto
 * y variedad, en unidades sueltas.
 */
async function armarRenglones(items, comprometido) {
  const lineas = consolidar(items);

  // Todos los productos de una vez y cada uno una sola vez.
  const productos = await leerProductos([...new Set(lineas.map(l => l.id))]);

  const renglones = [];
  const cambios = [];
  // Lo que este mismo pedido va consumiendo, encima de lo ya prometido: el
  // rollo entero y los metros sueltos del mismo color salen del mismo stock.
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
async function excedidosTrasEscribir(armado) {
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
    const k = `${i.id} ${variedad || ''} ${esPack ? 'pack' : 'suelto'}`;
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
 * Si la lectura falla, el pedido entra igual mirando solo el espejo, que es lo
 * que hacía siempre: perder una venta por no poder leer los pedidos abiertos
 * es peor que arriesgar una sobreventa.
 */
async function stockComprometido() {
  let abiertos;
  try {
    abiertos = await consultar('tienda_pedidos', {
      where: [['estado', 'IN', ESTADOS_ABIERTOS]],
      limite: 500,
      campos: ['items'],
    });
  } catch (err) {
    console.warn('[crear-pedido] no se pudieron leer los pedidos abiertos:', err);
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

const clave = (id, variedad) => `${id} ${variedad || ''}`;

function consumir(usado, id, variedad, unidades) {
  sumar(usado, clave(id, variedad), unidades);
  if (variedad) sumar(usado, clave(id, null), unidades);
}

function sumar(mapa, k, n) {
  mapa.set(k, redondearCantidad((mapa.get(k) || 0) + n));
}

/* ── Envío ────────────────────────────────────────────────────────────────── */

/**
 * El precio del envío, medido de nuevo contra Routes.
 *
 * No se confía en el número que trae el cliente aunque lo haya calculado esta
 * misma casa un minuto antes: entre el navegador y acá pasó por la consola de
 * alguien.
 *
 * Sin clave de Routes, o si Google no contesta, el pedido entra con envío en
 * cero y marcado "a confirmar", que es como degrada la tienda desde siempre: el
 * local ajusta el número al preparar el pedido, igual que cuando entra por
 * teléfono.
 */
async function calcularEnvio({ cfg, entrega, destino, subtotal }) {
  if (llegaAEnvioGratis(subtotal, entrega)) {
    return { precio: 0, km: null, a_confirmar: false, fuera_de_radio: false };
  }

  const clave = process.env.GOOGLE_ROUTES_KEY;
  const origen = cfg.origen;

  if (!clave || !coordenadaValida(origen) || !coordenadaValida(destino)) {
    return { precio: 0, km: null, a_confirmar: true, fuera_de_radio: false };
  }

  let metros;
  try {
    metros = await medirMetros(origen, destino, clave);
  } catch (err) {
    console.error('[crear-pedido] Routes falló:', err);
    return { precio: 0, km: null, a_confirmar: true, fuera_de_radio: false };
  }

  if (metros === null) {
    return { precio: 0, km: null, a_confirmar: true, fuera_de_radio: false };
  }

  const km = kmDeMetros(metros);
  const radio = Number(entrega.radio_max_km) || 0;
  if (radio > 0 && km > radio) {
    return { precio: 0, km, a_confirmar: false, fuera_de_radio: true };
  }

  const precio = precioPorDistancia(km, entrega);
  if (precio === null) return { precio: 0, km, a_confirmar: false, fuera_de_radio: true };

  return { precio, km, a_confirmar: false, fuera_de_radio: false };
}

/* ── Identificadores ──────────────────────────────────────────────────────── */

/**
 * Codigo corto para decir por telefono.
 *
 * El id del documento sirve para la URL pero no para dictarlo. El alfabeto saca
 * I, O, 0 y 1, que son los que se confunden al leerlos en voz alta.
 */
function generarCodigo() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => alfabeto[b % alfabeto.length]).join('');
}

/**
 * Un código que ningún pedido tenga todavía.
 *
 * Si la base no se puede consultar se usa el primero igual: es el
 * comportamiento de siempre, y no vale frenar la venta por esto.
 */
async function codigoLibre() {
  let codigo = generarCodigo();
  for (let intento = 0; intento < INTENTOS_DE_CODIGO; intento++) {
    let ocupado;
    try {
      const iguales = await consultar('tienda_pedidos', {
        where: [['codigo', 'EQUAL', codigo]],
        limite: 1,
        campos: ['codigo'],
      });
      ocupado = iguales.length > 0;
    } catch (err) {
      console.warn('[crear-pedido] no se pudo comprobar el código, se usa igual:', err);
      return codigo;
    }
    if (!ocupado) return codigo;
    console.warn(`[crear-pedido] el código ${codigo} ya existe, se genera otro`);
    codigo = generarCodigo();
  }
  return codigo;
}

/** Un id con la misma forma que los que genera Firestore. */
function nuevoId() {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => alfabeto[b % alfabeto.length]).join('');
}
