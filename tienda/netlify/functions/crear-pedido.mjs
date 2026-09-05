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
 * otro número del que estaba a la vista es peor que hacerlo revisar.
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
  leerDoc, leerConfigTienda, crearDoc, hayCredenciales, uidDelToken,
} from './lib/firestore.mjs';
import { coordenadaValida, medirMetros, kmDeMetros } from './lib/rutas.mjs';
import { precioPorDistancia, llegaAEnvioGratis } from '../../src/envio.js';
import {
  minimoDe, pasoDe, precioDeRenglon, stockDeRenglon, variedadDe,
  subtotalDeRenglon, redondearCantidad,
} from '../../src/precios.js';

const MAX_RENGLONES = 100;
const MAX_UNIDADES = 99;

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

  let cfg;
  try {
    cfg = await leerConfigTienda();
  } catch (err) {
    console.error('[crear-pedido] no se pudo leer la configuración:', err);
    return new Response('No se pudo leer la configuración', { status: 502 });
  }

  const entrega = cfg.entrega || {};
  const modo = cuerpo.entrega.modo;

  if (cfg.abierta === false) {
    return Response.json({ error: 'cerrada' }, { status: 409 });
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
    armado = await armarRenglones(cuerpo.items);
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

  const codigo = generarCodigo();
  const uid = await uidDelToken(cuerpo.idToken, API_KEY);
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

  return Response.json({ id, codigo, subtotal, envio, total });
};

/* ── Validación ───────────────────────────────────────────────────────────── */

function validarForma(c) {
  if (!c || typeof c !== 'object') return 'cuerpo';
  if (!c.cliente || typeof c.cliente !== 'object') return 'cliente';

  const nombre = String(c.cliente.nombre || '').trim();
  const telefono = String(c.cliente.telefono || '').trim();
  if (nombre.length < 2 || nombre.length > 80) return 'nombre';
  if (telefono.length < 6 || telefono.length > 30) return 'telefono';

  if (!c.entrega || !['delivery', 'retiro'].includes(c.entrega.modo)) return 'entrega';
  if (c.entrega.modo === 'delivery' && !String(c.entrega.direccion || '').trim()) {
    return 'direccion';
  }

  if (!Array.isArray(c.items) || !c.items.length || c.items.length > MAX_RENGLONES) {
    return 'items';
  }
  for (const i of c.items) {
    if (!i || typeof i.id !== 'string' || !i.id) return 'item';
    if (!(Number(i.cantidad) > 0)) return 'cantidad';
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
 * el texto que ya tiene escrito.
 */
async function armarRenglones(items) {
  const renglones = [];
  const cambios = [];

  for (const pedido of items) {
    const producto = await leerDoc('tienda_productos', pedido.id);
    const esPack = pedido.es_pack === true;
    const variedad = pedido.variedad ? String(pedido.variedad) : null;

    if (!producto) {
      cambios.push({ tipo: 'baja', nombre: pedido.nombre || pedido.id });
      continue;
    }

    const nombre = String(producto.nombre || pedido.id);
    const variante = variedadDe(producto, variedad);
    if (variedad && !variante) {
      cambios.push({ tipo: 'baja', nombre: `${nombre} (${variedad})` });
      continue;
    }

    // El local puede dejar de vender el rollo entero: el panel tiene un
    // interruptor por producto y el espejo publica `precio_pack: null`.
    if (esPack && !(Number(producto.precio_pack) > 0 && Number(producto.pack_contenido) > 0)) {
      cambios.push({ tipo: 'baja', nombre });
      continue;
    }

    const precio = precioDeRenglon(producto, { variedad, esPack });
    if (!(precio > 0)) {
      // Nada sale a cero. Un producto sin precio no se puede cobrar.
      cambios.push({ tipo: 'baja', nombre });
      continue;
    }

    const stock = stockDeRenglon(producto, { variedad, esPack });
    const minimo = esPack ? 1 : minimoDe(producto);
    const paso = esPack ? 1 : pasoDe(producto);

    if (stock <= 0 || stock < minimo) {
      cambios.push({ tipo: 'sin_stock', nombre });
      continue;
    }

    let cantidad = redondearCantidad(Math.min(Number(pedido.cantidad), MAX_UNIDADES));
    if (cantidad < minimo) {
      cambios.push({ tipo: 'minimo', nombre, antes: cantidad, ahora: minimo });
      cantidad = minimo;
    }
    if (cantidad > stock) {
      cambios.push({ tipo: 'menos_stock', nombre, antes: cantidad, ahora: stock });
      cantidad = stock;
    }
    // Lo que se corta del rollo va de a medio metro: pedir 2,3 metros no es una
    // cantidad que el local pueda despachar.
    const enPasos = redondearCantidad(Math.round(cantidad / paso) * paso);
    cantidad = Math.max(minimo, Math.min(stock, enPasos));

    // El precio que el cliente tenía a la vista. Si no coincide se avisa: es el
    // único número del pedido que no puede cambiar sin que lo vea.
    if (pedido.precio !== undefined && Number(pedido.precio) !== precio) {
      cambios.push({ tipo: 'precio', nombre, antes: Number(pedido.precio), ahora: precio });
    }

    const contenido = Number(producto.pack_contenido) || null;

    renglones.push({
      id: pedido.id,
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

  return { renglones, cambios };
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

/** Un id con la misma forma que los que genera Firestore. */
function nuevoId() {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => alfabeto[b % alfabeto.length]).join('');
}
