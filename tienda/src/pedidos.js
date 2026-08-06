/**
 * Pedidos.
 *
 * Se crean sin sesion: las reglas de `tienda_pedidos` validan la forma del
 * documento en vez de pedir un usuario. Un pedido se puede leer sabiendo su id
 * (veinte caracteres al azar, no se adivina) pero nadie puede listar la
 * coleccion, asi que un cliente no ve los pedidos de otro.
 *
 * Esa misma regla es la razon por la que el seguimiento guarda los pedidos
 * hechos desde este navegador en localStorage: sin permiso de listado no hay
 * forma de buscar "mis pedidos" por telefono, y pedirle al cliente que se cree
 * una cuenta en una libreria de barrio es perder el pedido.
 */
import {
  collection, doc, addDoc, getDoc, onSnapshot, serverTimestamp,
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
export async function crearPedido({ cliente, entrega, pago, items, subtotal, envio, nota = '' }) {
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
    entrega,
    pago,
    items,
    subtotal,
    envio,
    total: subtotal + envio,
    nota: String(nota || '').slice(0, 500),
  };

  const referencia = await addDoc(collection(db, 'tienda_pedidos'), documento);

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
export function seguirPedido(id, alCambiar) {
  return onSnapshot(
    doc(db, 'tienda_pedidos', id),
    snap => alCambiar(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    err => console.warn('[pedidos] se cortó el seguimiento:', err),
  );
}

/* ── Los pedidos de este navegador ───────────────────────────────────────── */

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
