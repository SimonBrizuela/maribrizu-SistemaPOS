/**
 * La cuenta del cliente.
 *
 * Crear una cuenta no es obligatorio para comprar y no va a serlo: pedir
 * registro antes de vender es la forma más rápida de perder un pedido. Sirve
 * para lo que la gente pide de verdad — que la tienda se acuerde de sus datos y
 * que sus pedidos aparezcan aunque cambie de teléfono.
 *
 * Es correo y contraseña, con "olvidé mi contraseña" incluido: Firebase manda
 * el mail de recuperación y nosotros no guardamos ni vemos ninguna contraseña.
 * También se puede entrar con Google, que evita tener una contraseña más.
 *
 * Por SMS al teléfono sería más natural para una librería de barrio, pero
 * Firebase cobra cada mensaje y obliga a poner tarjeta en el proyecto. El
 * teléfono se pide igual dentro del perfil, que es donde hace falta: para
 * avisar del pedido.
 *
 * El perfil vive en `tienda_clientes/{uid}` y las reglas dejan leerlo y
 * escribirlo únicamente a su dueño. Esa es la diferencia con guardar los datos
 * bajo el número de teléfono: un documento por teléfono, sin contraseña, es un
 * directorio abierto — cualquiera prueba números y se lleva nombres y
 * direcciones.
 */
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db, app } from './firebase.js';
import * as local from './cliente.js';

let auth = null;
let usuario = null;
let perfilCargado = null;
const oyentes = new Set();

/**
 * El SDK de Auth se carga cuando hace falta, no al abrir la tienda.
 *
 * Son unos 40 kB que no necesita quien entra a mirar cuadernos. Se carga al
 * primer uso: abrir la pantalla de la cuenta, o el arranque si ya había sesión.
 */
async function sdk() {
  if (auth) return auth;
  const { getAuth, setPersistence, browserLocalPersistence } = await import('firebase/auth');
  auth = getAuth(app);
  // La sesión sobrevive al cierre del navegador: nadie quiere volver a entrar
  // cada vez que abre la tienda.
  await setPersistence(auth, browserLocalPersistence).catch(() => {});
  return auth;
}

/* ── Sesión ───────────────────────────────────────────────────────────────── */

/**
 * Arranca el seguimiento de la sesión.
 *
 * Solo si hay rastro de una sesión anterior: sin eso, alguien que nunca creó
 * cuenta se descargaría el SDK de Auth para nada.
 */
export async function iniciarCuenta({ forzar = false } = {}) {
  if (!forzar && !huboSesion()) return;

  const a = await sdk();
  const { onAuthStateChanged } = await import('firebase/auth');

  onAuthStateChanged(a, async u => {
    usuario = u;
    marcarSesion(!!u);
    perfilCargado = u ? await leerPerfil(u.uid) : null;
    avisar();
  });
}

// Una marca liviana en el navegador para saber si vale la pena cargar el SDK.
const MARCA = 'liceo.sesion';
function huboSesion() {
  try { return localStorage.getItem(MARCA) === '1'; } catch { return false; }
}
function marcarSesion(hay) {
  try {
    if (hay) localStorage.setItem(MARCA, '1');
    else localStorage.removeItem(MARCA);
  } catch { /* modo privado */ }
}

/** Toma la sesión ya, sin esperar el aviso del SDK, que llega un rato después. */
function adoptar(u) {
  usuario = u;
  marcarSesion(!!u);
}

export function sesion() {
  return usuario ? { uid: usuario.uid, email: usuario.email } : null;
}

/**
 * El token de la sesión, para que el servidor pueda comprobar quién es.
 *
 * El pedido se firma con la cuenta para que después aparezca en "Mis pedidos"
 * desde cualquier teléfono. Mandar el `uid` pelado no serviría: cualquiera
 * escribiría el de otro y le metería pedidos en el historial.
 */
export async function tokenDeSesion() {
  if (!usuario) return null;
  try {
    return await usuario.getIdToken();
  } catch (err) {
    // Sin token el pedido entra igual, sin firmar: firmar es un extra.
    console.warn('[cuenta] no se pudo obtener el token:', err);
    return null;
  }
}

export function alCambiarSesion(fn) {
  oyentes.add(fn);
  fn(sesion());
  return () => oyentes.delete(fn);
}

function avisar() {
  oyentes.forEach(fn => { try { fn(sesion()); } catch (err) { console.error(err); } });
}

/* ── Entrar y salir ───────────────────────────────────────────────────────── */

export async function crearCuenta({ email, clave, nombre, telefono }) {
  const a = await sdk();
  const { createUserWithEmailAndPassword, updateProfile } = await import('firebase/auth');
  const cred = await createUserWithEmailAndPassword(a, email.trim(), clave);

  if (nombre) await updateProfile(cred.user, { displayName: nombre }).catch(() => {});
  // El usuario se toma de acá y no se espera a `onAuthStateChanged`: ese aviso
  // llega un instante después, y en ese instante `guardarPerfil` veía la sesión
  // vacía y no guardaba nada.
  adoptar(cred.user);

  // Lo que ya había escrito en este teléfono se sube a la cuenta: quien compró
  // como invitado y después se registra no tiene por qué volver a cargar su
  // dirección.
  const guardado = local.perfil();
  await guardarPerfil({
    nombre: nombre || guardado?.nombre || '',
    telefono: telefono || guardado?.telefono || '',
    direcciones: local.domicilios(),
  });

  return sesion();
}

export async function entrar({ email, clave }) {
  const a = await sdk();
  const { signInWithEmailAndPassword } = await import('firebase/auth');
  const cred = await signInWithEmailAndPassword(a, email.trim(), clave);
  adoptar(cred.user);
  perfilCargado = await leerPerfil(cred.user.uid);
  avisar();
  return sesion();
}

export async function entrarConGoogle() {
  const a = await sdk();
  const { GoogleAuthProvider, signInWithPopup } = await import('firebase/auth');
  const cred = await signInWithPopup(a, new GoogleAuthProvider());
  adoptar(cred.user);
  perfilCargado = await leerPerfil(cred.user.uid);
  avisar();
  return sesion();
}

/**
 * "Me olvidé la contraseña".
 *
 * Lo manda Firebase, no nosotros: el correo sale de Google con un enlace que
 * vence, y la contraseña nueva nunca pasa por la tienda.
 *
 * No dice si el correo existe o no. Contestar "esa cuenta no existe" convierte
 * el formulario en una forma de averiguar quién compra en la librería.
 */
export async function recuperarClave(email) {
  const a = await sdk();
  const { sendPasswordResetEmail } = await import('firebase/auth');
  try {
    await sendPasswordResetEmail(a, email.trim());
  } catch (err) {
    if (err?.code !== 'auth/user-not-found') throw err;
  }
}

export async function salir() {
  const a = await sdk();
  const { signOut } = await import('firebase/auth');
  await signOut(a);
  usuario = null;
  perfilCargado = null;
  marcarSesion(false);
  avisar();
}

/* ── El perfil ────────────────────────────────────────────────────────────── */

async function leerPerfil(uid) {
  try {
    const snap = await getDoc(doc(db, 'tienda_clientes', uid));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      nombre: String(d.nombre || ''),
      telefono: String(d.telefono || ''),
      direcciones: Array.isArray(d.direcciones) ? d.direcciones : [],
    };
  } catch (err) {
    console.warn('[cuenta] no se pudo leer el perfil:', err);
    return null;
  }
}

/**
 * Guarda el perfil. Devuelve si pudo.
 *
 * No revienta hacia arriba a propósito: se llama al confirmar un pedido, y un
 * pedido no se puede caer porque no se pudo guardar una dirección. Pero tampoco
 * miente: quien llama recibe `false` y decide.
 */
export async function guardarPerfil({ nombre, telefono, direcciones }) {
  if (!usuario) return false;

  const datos = {
    nombre: String(nombre || '').trim(),
    telefono: String(telefono || '').trim(),
    direcciones: (direcciones || []).slice(0, 4),
    actualizado: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'tienda_clientes', usuario.uid), datos, { merge: true });
    perfilCargado = { ...datos };
    return true;
  } catch (err) {
    console.warn('[cuenta] no se pudo guardar el perfil:', err?.code || err);
    return false;
  }
}

/**
 * Los datos para completar el checkout.
 *
 * Con sesión salen de la cuenta, que viaja entre teléfonos. Sin sesión, de este
 * navegador. Los dos tienen la misma forma a propósito: al checkout no le
 * importa de dónde vinieron.
 */
export function datosParaCompletar() {
  if (usuario && perfilCargado) {
    return {
      nombre: perfilCargado.nombre || usuario.displayName || '',
      telefono: perfilCargado.telefono || '',
      direcciones: perfilCargado.direcciones || [],
      deLaCuenta: true,
    };
  }
  const guardado = local.perfil();
  if (!guardado) return null;
  return { ...guardado, direcciones: local.domicilios(), deLaCuenta: false };
}

/**
 * Guarda lo que se usó en un pedido confirmado, donde corresponda.
 *
 * Siempre en este navegador —así el autocompletado anda aunque después cierre
 * sesión— y además en la cuenta si hay una.
 */
export async function recordarDelPedido(datos) {
  local.recordarDelPedido(datos);
  if (usuario) {
    await guardarPerfil({
      nombre: datos.nombre,
      telefono: datos.telefono,
      direcciones: local.domicilios(),
    });
  }
}
