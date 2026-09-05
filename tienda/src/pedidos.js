/**
 * Pedidos.
 *
 * Se crean sin sesion, pero no desde acá: desde el 05-09-2026 las reglas no
 * dejan que ningún navegador escriba en `tienda_pedidos`, y el pedido lo guarda
 * `netlify/functions/crear-pedido`, que relee los precios de la base. Escrito
 * desde el navegador, el precio de cada renglón salía de la memoria del que
 * paga. Un pedido se puede leer sabiendo su id (veinte caracteres al azar, no
 * se adivina) pero nadie puede listar la coleccion, asi que un cliente no ve
 * los pedidos de otro.
 *
 * Esa misma regla es la razon por la que el seguimiento guarda los pedidos
 * hechos desde este navegador en localStorage: sin permiso de listado no hay
 * forma de buscar "mis pedidos" por telefono, y pedirle al cliente que se cree
 * una cuenta en una libreria de barrio es perder el pedido.
 */
import {
  collection, doc, getDoc, getDocs, limit, onSnapshot,
  orderBy, query, serverTimestamp, setDoc, where,
} from 'firebase/firestore';
import { db } from './firebase.js';

const CLAVE = 'liceo.pedidos.v1';

/** Los estados por los que pasa un pedido, en orden. */
export const ESTADOS = [
  { clave: 'nuevo',      titulo: 'Recibimos tu pedido', detalle: 'Lo vamos a revisar y preparar.' },
  { clave: 'preparando', titulo: 'Lo estamos preparando', detalle: 'Juntando los productos en el local.' },
  { clave: 'listo',      titulo: 'Listo',                detalle: 'Ya podés pasar a retirarlo.' },
  { clave: 'en_camino',  titulo: 'En camino',            detalle: 'Salió para tu dirección.' },
  { clave: 'entregado',  titulo: 'Entregado',            detalle: 'Gracias por comprar acá.' },
];

/** El paso "listo" se lee distinto según cómo lo recibe el cliente. */
export function pasosDe(modo) {
  return ESTADOS
    .filter(e => (modo === 'retiro' ? e.clave !== 'en_camino' : true))
    .map(e => {
      if (e.clave !== 'listo') return e;
      return modo === 'retiro'
        ? e
        : { ...e, titulo: 'Listo para salir', detalle: 'Esperando al repartidor.' };
    });
}

export function indiceDeEstado(estado, modo) {
  return pasosDe(modo).findIndex(e => e.clave === estado);
}

/**
 * Codigo corto para decir por telefono.
 *
 * El id del documento sirve para la URL pero no para dictarlo: veinte
 * caracteres con mayusculas, minusculas y numeros se copian mal. El alfabeto
 * saca I, O, 0 y 1, que son los que se confunden al leerlos en voz alta.
 */
function generarCodigo() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => alfabeto[b % alfabeto.length]).join('');
}

/**
 * Guarda el pedido y devuelve su id y su codigo.
 *
 * `creado` va con la hora del servidor porque las reglas exigen que coincida
 * con la del pedido: el reloj del celular del cliente puede estar corrido de
 * horas y no puede decidir cuando entro un pedido.
 */
/**
 * Reserva el id de un pedido que todavia no existe.
 *
 * Con transferencia, el comprobante se sube ANTES de crear el pedido: es lo que
 * permite que el pedido nazca ya pagado en vez de quedar esperando. Para eso
 * hace falta saber el id de antemano, y Firestore lo da sin escribir nada.
 */
export function nuevoIdDePedido() {
  return doc(collection(db, 'tienda_pedidos')).id;
}

const FUNCION_CREAR = '/.netlify/functions/crear-pedido';

/**
 * Por qué el servidor no aceptó el pedido, dicho para el cliente.
 *
 * El texto sale de acá y no del checkout porque la pantalla de la transferencia
 * también muestra este mensaje: ahí el pedido nace después de subir el
 * comprobante y no hay resumen donde pintar el detalle.
 */
const MOTIVOS = {
  cambios: 'Cambió algo de tu pedido. Revisalo antes de confirmar.',
  minimo: 'El pedido no llega al mínimo. Agregá algo más.',
  cerrada: 'Ahora no estamos tomando pedidos. Tu carrito queda guardado.',
  sin_efectivo: 'Ya no estamos tomando efectivo. Elegí transferencia.',
  sin_delivery: 'El envío a domicilio no está disponible. Podés retirarlo del local.',
  sin_retiro: 'El retiro en el local no está disponible por ahora.',
  fuera_de_radio: 'Tu dirección queda fuera del radio de reparto.',
  vacio: 'Se agotó todo lo que tenías en el pedido.',
  ya_existe: 'Este pedido ya lo teníamos cargado.',
};

/**
 * Guarda el pedido.
 *
 * Primero por el servidor, que relee los precios de la base y rehace el total:
 * escribiendo desde acá, el precio de cada renglón sale de la memoria del
 * navegador del que paga, y cambiarlo es abrir la consola.
 *
 * Mientras la función no esté configurada (le falta la cuenta de servicio)
 * contesta 501 y se escribe como siempre. Es lo que permite desplegar el
 * cambio sin cortar las ventas: se prende la variable, se comprueba que los
 * pedidos entran por el servidor, y recién ahí las reglas cierran esta puerta.
 *
 * El id se reserva siempre de este lado. Así, si la respuesta se pierde en el
 * camino y se reintenta, el segundo intento escribe en el mismo lugar en vez de
 * dejar el pedido duplicado.
 */
export async function crearPedido({ cliente, entrega, pago, items, subtotal, envio,
                                   nota = '', uid = null, id = null,
                                   idToken = null }) {
  const referenciaId = id || nuevoIdDePedido();

  const porServidor = await crearEnElServidor({
    id: referenciaId, cliente, entrega, pago, items, nota, idToken,
  });
  if (porServidor) {
    recordar({
      id: porServidor.id,
      codigo: porServidor.codigo,
      total: porServidor.total,
      cuando: Date.now(),
      modo: entrega.modo,
    });
    avisarAlLocal(porServidor.id);
    return { id: porServidor.id, codigo: porServidor.codigo };
  }

  return crearDesdeElNavegador({
    cliente, entrega, pago, items, subtotal, envio, nota, uid, id: referenciaId,
  });
}

/**
 * @returns {Promise<{id, codigo, total}|null>} null si la función todavía no
 *   está configurada y hay que escribir desde el navegador.
 * @throws {Error & {cambios?: Array, motivo?: string}}
 */
async function crearEnElServidor({ id, cliente, entrega, pago, items, nota, idToken }) {
  const cuerpo = JSON.stringify({
    id,
    cliente,
    entrega,
    pago,
    // Va el QUÉ, no el cuánto sale: el precio lo pone el servidor. El que se
    // manda es solo el que el cliente tenía a la vista, para que la función
    // pueda avisar si cambió en vez de cobrar otra cosa.
    items: items.map(i => ({
      id: i.id,
      nombre: i.nombre,
      variedad: i.variedad,
      cantidad: i.cantidad,
      es_pack: i.es_pack,
      precio: i.precio,
    })),
    nota,
    ...(idToken ? { idToken } : {}),
  });

  const llamar = () => fetch(FUNCION_CREAR, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: cuerpo,
  });

  let respuesta;
  try {
    respuesta = await llamar();

    // Arranque en frío. La función vive dormida y el primer pedido del día se
    // la encuentra levantándose: medido en el chat, los dos primeros intentos
    // devolvían 502. Antes ese 502 caía al camino viejo y el pedido entraba
    // igual; con las reglas cerradas ya no hay camino viejo, así que un
    // tropiezo del servidor le costaría la compra al primer cliente del día.
    //
    // Se reintenta una sola vez y solo ante un error del servidor: un 400, un
    // 409 o un 501 son respuestas, no tropiezos.
    if (respuesta.status >= 500 && respuesta.status !== 501) {
      console.warn('[pedidos] la función tropezó, reintentando:', respuesta.status);
      await new Promise(listo => setTimeout(listo, 900));
      respuesta = await llamar();
    }
  } catch (err) {
    // Sin internet, o la función no existe en este entorno. Un reintento acá
    // vale lo mismo que el primero: la red no vuelve en 900 ms.
    console.warn('[pedidos] no se pudo llamar a la función:', err);
    return null;
  }

  if (respuesta.ok) {
    let datos = null;
    try { datos = await respuesta.json(); } catch { /* cuerpo ilegible */ }
    // Un 200 sin id no es un pedido guardado: es un proxy contestando cualquier
    // cosa. Dar el pedido por hecho ahí sería mandar al cliente a una pantalla
    // de seguimiento que no existe.
    if (datos?.id && datos?.codigo) return datos;
    console.warn('[pedidos] la función contestó 200 sin pedido, se escribe desde el navegador');
    return null;
  }

  // 409 son respuestas, no tropiezos: cambió un precio, se agotó algo, no llega
  // al mínimo. Repetirlo desde el navegador daría un pedido que el local no
  // puede cumplir, así que sube para que el checkout lo muestre.
  if (respuesta.status === 409) {
    let datos = {};
    try { datos = await respuesta.json(); } catch { /* cuerpo vacío */ }
    const motivo = datos.error || 'cambios';

    // "Ya existe" es el reintento encontrando el pedido que hizo el primer
    // intento: la respuesta se perdió en el camino, pero el pedido está. Se
    // lee de la base y se sigue como si hubiera salido bien; decirle al
    // cliente que algo falló cuando su pedido ya está cargado lo deja
    // mandando otro.
    if (motivo === 'ya_existe') {
      const guardado = await traerPedido(id).catch(() => null);
      if (guardado?.codigo) {
        return { id, codigo: guardado.codigo, total: guardado.total };
      }
    }

    const err = new Error(MOTIVOS[motivo] || MOTIVOS.cambios);
    err.motivo = motivo;
    err.cambios = datos.cambios || [];
    err.datos = datos;
    throw err;
  }

  if (respuesta.status !== 501) {
    console.warn('[pedidos] la función falló, se escribe desde el navegador:',
                 respuesta.status);
  }
  return null;
}

/**
 * El camino viejo: el navegador escribe el pedido y las reglas validan su
 * forma. Queda como red mientras la función no esté configurada; con las reglas
 * cerradas esto falla, que es exactamente lo que tiene que pasar.
 */
async function crearDesdeElNavegador({ cliente, entrega, pago, items, subtotal, envio,
                                       nota = '', uid = null, id = null }) {
  const codigo = generarCodigo();

  const documento = {
    estado: 'nuevo',
    creado: serverTimestamp(),
    // Los dos flags operativos nacen en falso y los mueve el local. Las reglas
    // los fuerzan asi: un pedido no puede entrar diciendo que ya se imprimio.
    impreso: false,
    visto: false,
    codigo,
    cliente,
    // Firmado con la cuenta cuando hay una: es lo que despues deja pedir "mis
    // pedidos" desde cualquier aparato. Las reglas exigen que sea la cuenta de
    // quien esta creando el pedido, no una cualquiera.
    ...(uid ? { uid } : {}),
    entrega,
    pago,
    items,
    subtotal,
    envio,
    total: subtotal + envio,
    nota: String(nota || '').slice(0, 500),
  };

  // Con un id reservado se escribe en ese lugar; sin el, lo elige Firestore.
  const referencia = id ? doc(db, 'tienda_pedidos', id)
                        : doc(collection(db, 'tienda_pedidos'));
  await setDoc(referencia, documento);

  recordar({
    id: referencia.id,
    codigo,
    total: documento.total,
    cuando: Date.now(),
    modo: entrega.modo,
  });

  avisarAlLocal(referencia.id);

  return { id: referencia.id, codigo };
}

/**
 * Le toca el timbre al local.
 *
 * No se espera la respuesta ni se propaga el error: el pedido ya esta guardado
 * y el cliente tiene que ver su confirmacion ahora, no cuando conteste un
 * servidor de WhatsApp. Si el aviso no sale, el local igual ve el pedido por la
 * webapp de gestion y por el POS, que escuchan la coleccion en vivo.
 *
 * `keepalive` es lo que hace que la llamada sobreviva al cambio de pantalla:
 * sin eso el navegador cancela la peticion al navegar y el aviso se pierde
 * justo en el unico momento en que importa.
 */
function avisarAlLocal(id) {
  try {
    fetch('/.netlify/functions/avisar-pedido', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      keepalive: true,
    }).catch(() => {});
  } catch (err) {
    console.warn('[pedidos] no se pudo avisar al local:', err);
  }
}

export async function traerPedido(id) {
  const snap = await getDoc(doc(db, 'tienda_pedidos', id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Sigue un pedido en vivo.
 *
 * El cliente deja la pantalla abierta mientras espera; que el estado cambie
 * solo, sin recargar, es la diferencia entre una pagina de seguimiento y una
 * captura de pantalla.
 */
export function seguirPedido(id, alCambiar, alFallar = null) {
  return onSnapshot(
    doc(db, 'tienda_pedidos', id),
    snap => alCambiar(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    err => {
      // La pantalla pinta con la primera respuesta de esta suscripcion, asi que
      // si falla hay que avisarle: sin esto se queda con el esqueleto puesto
      // para siempre.
      console.warn('[pedidos] se cortó el seguimiento:', err);
      alFallar?.(err);
    },
  );
}

/* ── Los pedidos de este navegador ───────────────────────────────────────── */

/**
 * Los pedidos de la cuenta, traidos de la base.
 *
 * Es lo que hace que "Mis pedidos" funcione desde otro telefono. Las reglas
 * dejan listar solo los que llevan el uid de quien pregunta, asi que esta
 * consulta tiene que filtrar por uid o Firestore la rechaza entera — no
 * devuelve "los que puede": no devuelve nada.
 *
 * Sin cuenta devuelve vacio y la pantalla se queda con los de este navegador.
 */
export async function pedidosDeLaCuenta(uid, cantidad = 50) {
  if (!uid) return [];
  try {
    // Sin `orderBy`: filtrar por uno y ordenar por otro necesita un indice
    // compuesto, y crear indices pide permisos que la tienda no tiene que
    // tener. Se ordena de este lado, que sobre cincuenta pedidos de una persona
    // no se nota.
    const snap = await getDocs(query(
      collection(db, 'tienda_pedidos'),
      where('uid', '==', uid),
      limit(cantidad),
    ));
    return snap.docs.map(d => ({
      id: d.id,
      codigo: d.data().codigo,
      total: d.data().total,
      estado: d.data().estado,
      modo: d.data().entrega?.modo,
      cuando: d.data().creado?.toMillis?.() || 0,
      deLaCuenta: true,
    })).sort((a, b) => (b.cuando || 0) - (a.cuando || 0));
  } catch (err) {
    // Falta el indice compuesto, o se cayo la conexion. La pantalla igual
    // muestra los de este navegador: es peor una lista vacia que una corta.
    console.warn('[pedidos] no se pudieron leer los de la cuenta:', err?.code || err);
    return [];
  }
}

export function misPedidos() {
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return [];
    const datos = JSON.parse(crudo);
    if (!Array.isArray(datos)) return [];
    return datos
      .filter(p => p && typeof p.id === 'string')
      .sort((a, b) => (b.cuando || 0) - (a.cuando || 0));
  } catch {
    return [];
  }
}

function recordar(pedido) {
  try {
    // Se guardan los ultimos diez. Un historial mas largo no lo mira nadie y
    // localStorage no es lugar para acumular.
    const lista = [pedido, ...misPedidos().filter(p => p.id !== pedido.id)].slice(0, 10);
    localStorage.setItem(CLAVE, JSON.stringify(lista));
  } catch (err) {
    // Modo incognito, cuota llena. El pedido ya esta guardado en la base: lo
    // unico que se pierde es el acceso rapido desde este telefono.
    console.warn('[pedidos] no se pudo recordar el pedido:', err);
  }
}
