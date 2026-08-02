/**
 * Autenticación de la webapp contra Firebase Auth — sin contraseñas.
 *
 * Dos formas de entrar, las dos sin nada que recordar:
 *   1. Google (un click, sesión persistente).
 *   2. Enlace por correo (magic link), para direcciones que no son de Google.
 *
 * Reemplaza al esquema anterior de usuarios hardcodeados, que viajaba en el
 * bundle público y no protegía Firestore.
 *
 * AUTORIZACIÓN — importante:
 * Con login por Google cualquiera con una cuenta de Google puede autenticarse.
 * Por eso "estar logueado" no otorga nada: el acceso depende de un custom
 * claim (`admin` o `staff`) que solo se setea con el Admin SDK desde
 * scripts/auth_admin.py. Las rules de Firestore exigen ese claim, y acá
 * cerramos la sesión de cualquiera que entre sin él.
 */

import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  GoogleAuthProvider,
  signInWithPopup,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { app } from './firebase.js';

export const auth = getAuth(app);

// Persistencia local (IndexedDB): la sesión sobrevive al F5 y al cierre de la
// app. Mari entra una vez y no se le vuelve a pedir.
setPersistence(auth, browserLocalPersistence).catch(err => {
  console.warn('[auth] no se pudo fijar la persistencia local:', err);
});

// Pista sincrónica de sesión. Firebase resuelve el estado de auth de forma
// asíncrona (lee IndexedDB), pero el arranque de main.js necesita decidir YA
// si pinta el shell o el login para no perder la precarga de datos.
//
// Es solo una pista de UI: no otorga ningún permiso. Falsificarla muestra un
// shell vacío que Firestore rechaza, porque quien manda es el ID token.
const HINT_KEY  = 'pos_auth_hint';
// El magic link se abre en una pestaña nueva, donde hay que recordar a qué
// dirección se pidió para completar el ingreso.
const EMAIL_KEY = 'pos_auth_email';

let _session  = null;
let _resolved = false;
const _waiters = [];

function buildSession(user, claims) {
  return {
    uid:     user.uid,
    email:   user.email,
    display: user.displayName || (user.email || '').split('@')[0],
    photo:   user.photoURL || null,
    role:    claims.admin ? 'admin' : 'staff',
  };
}

/** Traduce el usuario de Firebase a una sesión, o null si no está autorizado. */
async function resolveUser(user) {
  if (!user) return null;

  let claims = {};
  try {
    const res = await user.getIdTokenResult();
    claims = res.claims || {};
  } catch (err) {
    console.warn('[auth] no se pudieron leer los claims:', err);
    return null;
  }

  // Sin claim no hay acceso, por más que la cuenta de Google sea válida.
  if (!claims.admin && !claims.staff) return null;

  return buildSession(user, claims);
}

onAuthStateChanged(auth, async user => {
  _session = await resolveUser(user);

  if (_session) {
    try { localStorage.setItem(HINT_KEY, _session.uid); } catch (_) {}
  } else {
    try { localStorage.removeItem(HINT_KEY); } catch (_) {}
    // Usuario de Google válido pero sin permiso: cerramos para que no quede
    // una sesión fantasma que solo genera errores de Firestore.
    if (user) { try { await signOut(auth); } catch (_) {} }
  }

  if (!_resolved) {
    _resolved = true;
    _waiters.splice(0).forEach(fn => fn(_session));
  }
});

/**
 * Pista sincrónica: ¿esta máquina tenía sesión abierta la última vez?
 * Sirve para arrancar la precarga y pintar el shell sin esperar a Firebase.
 * Si termina siendo mentira, onAuthReady() devuelve null y se cae al login.
 */
export function hasSessionHint() {
  try { return !!localStorage.getItem(HINT_KEY); } catch (_) { return false; }
}

/** Promesa que resuelve con la sesión real (o null) cuando Firebase decide. */
export function onAuthReady() {
  if (_resolved) return Promise.resolve(_session);
  return new Promise(resolve => _waiters.push(resolve));
}

/** Login con Google. Un click, sin contraseña. */
export async function loginWithGoogle() {
  try {
    const provider = new GoogleAuthProvider();
    // Fuerza el selector de cuenta: en una PC compartida evita entrar sin
    // querer con la sesión de Google que quedó abierta.
    provider.setCustomParameters({ prompt: 'select_account' });

    const cred    = await signInWithPopup(auth, provider);
    const session = await resolveUser(cred.user);

    if (!session) {
      await signOut(auth);
      return {
        ok: false,
        error: `La cuenta ${cred.user.email} no tiene acceso a este sistema.`,
      };
    }

    _session  = session;
    _resolved = true;
    try { localStorage.setItem(HINT_KEY, session.uid); } catch (_) {}
    return { ok: true, session };
  } catch (err) {
    return { ok: false, error: describeAuthError(err) };
  }
}

/** Manda el enlace de ingreso a un correo. No hay contraseña de por medio. */
export async function sendLoginLink(email) {
  const clean = email.trim();
  try {
    await sendSignInLinkToEmail(auth, clean, {
      url: window.location.origin + window.location.pathname,
      handleCodeInApp: true,
    });
    try { localStorage.setItem(EMAIL_KEY, clean); } catch (_) {}
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeAuthError(err) };
  }
}

/**
 * ¿La URL actual es un enlace de ingreso? Se chequea en el arranque, antes
 * de decidir si mostrar el login.
 */
export function isLoginLink() {
  try { return isSignInWithEmailLink(auth, window.location.href); } catch (_) { return false; }
}

/** Completa el ingreso cuando el usuario abre el enlace del correo. */
export async function completeLinkSignIn() {
  let email = null;
  try { email = localStorage.getItem(EMAIL_KEY); } catch (_) {}

  // El enlace puede abrirse en otro dispositivo o navegador, donde no quedó
  // guardada la dirección. En ese caso hay que pedirla de nuevo.
  if (!email) {
    email = window.prompt('Confirmá tu correo para completar el ingreso:');
    if (!email) return { ok: false, error: 'Ingreso cancelado.' };
  }

  try {
    const cred    = await signInWithEmailLink(auth, email.trim(), window.location.href);
    const session = await resolveUser(cred.user);

    try { localStorage.removeItem(EMAIL_KEY); } catch (_) {}
    // Saca el código de la barra de direcciones para que no quede en el
    // historial ni se reutilice en un F5.
    try {
      window.history.replaceState({}, document.title,
        window.location.origin + window.location.pathname);
    } catch (_) {}

    if (!session) {
      await signOut(auth);
      return { ok: false, error: `La cuenta ${email} no tiene acceso a este sistema.` };
    }

    _session  = session;
    _resolved = true;
    try { localStorage.setItem(HINT_KEY, session.uid); } catch (_) {}
    return { ok: true, session };
  } catch (err) {
    return { ok: false, error: describeAuthError(err) };
  }
}

export async function logout() {
  try { localStorage.removeItem(HINT_KEY); } catch (_) {}
  _session = null;
  await signOut(auth);
}

export function getSession() {
  return _session;
}

export function isLoggedIn() {
  return _session !== null;
}

/** Traduce los códigos de Firebase a algo que se pueda mostrar en pantalla. */
function describeAuthError(err) {
  const code = (err && err.code) || '';
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Cerraste la ventana de Google antes de terminar.';
    case 'auth/popup-blocked':
      return 'El navegador bloqueó la ventana de Google. Permitila e intentá de nuevo.';
    case 'auth/invalid-email':
      return 'El correo no tiene un formato válido.';
    case 'auth/user-disabled':
      return 'Esta cuenta está deshabilitada.';
    case 'auth/invalid-action-code':
    case 'auth/expired-action-code':
      return 'El enlace ya venció o se usó. Pedí uno nuevo.';
    case 'auth/too-many-requests':
      return 'Demasiados intentos. Esperá unos minutos.';
    case 'auth/network-request-failed':
      return 'Sin conexión. Revisá la red e intentá de nuevo.';
    case 'auth/unauthorized-domain':
      return 'Este dominio no está autorizado en Firebase Auth.';
    case 'auth/operation-not-allowed':
      return 'Este método de ingreso no está habilitado en el proyecto.';
    default:
      console.error('[auth]', err);
      return 'No se pudo iniciar sesión. Intentá de nuevo.';
  }
}
