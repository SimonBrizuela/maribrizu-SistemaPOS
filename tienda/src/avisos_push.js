/**
 * Los avisos al celular: pedir permiso y anotar este celular para un pedido.
 *
 * El aviso lo manda el servidor cuando el local mueve el pedido; acá solo se
 * consigue el token del celular (Firebase Cloud Messaging) y se lo manda a
 * `suscribir-avisos`. La notificación la muestra `public/avisos-sw.js`.
 *
 * Reglas que valen más que el código:
 *   · El permiso se pide solo cuando el cliente toca "Activar avisos". Si se
 *     pide solo y lo rechaza, el navegador no deja volver a preguntar nunca.
 *   · Si ya lo dio en otro pedido, se activa solo, sin preguntar.
 *   · En iPhone los avisos web andan únicamente con la tienda agregada a la
 *     pantalla de inicio: ahí se explica cómo, en vez de ofrecer un botón que
 *     no haría nada.
 *   · Si algo falla, se dice que no se pudo y la pantalla del pedido sigue
 *     igual: el aviso es un extra.
 *
 * El navegador se puede inyectar (`navegador`, `ventana`, `fetch`,
 * `obtenerToken`) para probarlo; en la tienda se usan los de verdad.
 */

const CLAVE = 'liceo.avisos.v1';
const SW = '/avisos-sw.js';
const FUNCION = '/.netlify/functions/suscribir-avisos';

function entornoReal() {
  return {
    navegador: typeof navigator !== 'undefined' ? navigator : {},
    ventana: typeof window !== 'undefined' ? window : {},
    fetch: typeof fetch === 'function' ? fetch.bind(globalThis) : null,
    obtenerToken: tokenDeFirebase,
  };
}

const esIphone = (nav) => /iPhone|iPad|iPod/.test(nav.userAgent || '')
  // Los iPad nuevos se presentan como Mac: se los reconoce por la pantalla táctil.
  || (/Macintosh/.test(nav.userAgent || '') && Number(nav.maxTouchPoints) > 1);

/**
 * Si este navegador puede recibir avisos.
 * @returns {'ok'|'iphone_sin_instalar'|'sin_soporte'|'bloqueado'}
 */
export function soporteDeAvisos(opciones = {}) {
  const { navegador: nav, ventana: win } = { ...entornoReal(), ...opciones };
  const puede = Boolean(nav?.serviceWorker && win?.PushManager && win?.Notification);
  if (!puede) {
    const instalada = win?.matchMedia?.('(display-mode: standalone)')?.matches || nav?.standalone === true;
    return esIphone(nav || {}) && !instalada ? 'iphone_sin_instalar' : 'sin_soporte';
  }
  if (win.Notification.permission === 'denied') return 'bloqueado';
  return 'ok';
}

/** Si el permiso ya está dado: con eso los avisos se activan solos. */
export function permisoDado(opciones = {}) {
  const { ventana: win } = { ...entornoReal(), ...opciones };
  return win?.Notification?.permission === 'granted';
}

function leer() {
  try {
    const datos = JSON.parse(localStorage.getItem(CLAVE) || '{}');
    return Array.isArray(datos.pedidos) ? datos : { pedidos: [] };
  } catch {
    return { pedidos: [] };
  }
}

function guardar(datos) {
  try { localStorage.setItem(CLAVE, JSON.stringify(datos)); } catch { /* sin almacenamiento */ }
}

/** Si en este celular ya están activos los avisos de ese pedido. */
export function avisosActivos(pedidoId) {
  return leer().pedidos.includes(pedidoId);
}

export function olvidarAvisos(pedidoId) {
  const datos = leer();
  guardar({ ...datos, pedidos: datos.pedidos.filter(id => id !== pedidoId) });
}

/**
 * Activa los avisos de un pedido en este celular.
 *
 * @param {string} pedidoId
 * @param {object} [opciones]  `preguntar: false` para la activación sola: si el
 *        permiso no está dado, no pregunta
 * @returns {Promise<'activos'|'rechazado'|'sin_soporte'|'no_disponible'|'error'>}
 */
export async function activarAvisos(pedidoId, opciones = {}) {
  const entorno = { ...entornoReal(), ...opciones };
  const { navegador: nav, ventana: win, preguntar = true } = entorno;

  if (soporteDeAvisos(entorno) !== 'ok') return 'sin_soporte';

  let permiso = win.Notification.permission;
  if (permiso === 'default' && preguntar) {
    try {
      permiso = await win.Notification.requestPermission();
    } catch {
      permiso = 'default';
    }
  }
  if (permiso !== 'granted') return 'rechazado';

  try {
    const registro = await nav.serviceWorker.register(SW, { scope: '/' });
    const token = await entorno.obtenerToken(registro);
    if (!token) return 'error';

    const respuesta = await entorno.fetch(FUNCION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pedido: pedidoId, token }),
    });
    if (respuesta.ok) {
      const datos = leer();
      guardar({ ...datos, pedidos: [pedidoId, ...datos.pedidos.filter(id => id !== pedidoId)].slice(0, 20) });
      return 'activos';
    }
    // Función apagada, pedido terminado o inexistente: no hay nada que activar.
    if ([501, 404, 409].includes(respuesta.status)) return 'no_disponible';
    return 'error';
  } catch (err) {
    console.warn('[avisos] no se pudieron activar:', err?.message || err);
    return 'error';
  }
}

/**
 * El token del celular, con el SDK de Firebase cargado recién acá: son unos
 * 20 kB que no tiene por qué descargar quien solo mira el catálogo.
 */
async function tokenDeFirebase(registro) {
  const [{ getMessaging, getToken, isSupported }, { app }] = await Promise.all([
    import('firebase/messaging'),
    import('./firebase.js'),
  ]);
  if (!(await isSupported())) return null;
  return getToken(getMessaging(app), { serviceWorkerRegistration: registro });
}
