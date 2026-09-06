/**
 * Medición de uso de la tienda, del lado del navegador.
 *
 * Junta lo que pasa —una visita que arranca, una pantalla, una búsqueda con
 * cuántos resultados dio, una ficha abierta, algo que entra al carrito, el
 * checkout, un mensaje al chat— y lo manda en tandas a la función `medir`,
 * que lo suma en un documento por día. Las reglas de qué se cuenta viven en
 * `estadisticas.js`; acá está solo el cuándo y el cómo se manda.
 *
 * Lo que NO se manda: ningún identificador de la persona, ni teléfono, ni
 * cuenta, ni lo que escribió en el chat. El único rastro local es un
 * "cuándo fue la última actividad" para saber si esta visita es nueva, y se
 * queda en el navegador.
 *
 * Nunca molesta: nada de esto puede tirar una pantalla ni demorar una
 * compra. Cada llamada está envuelta para que un error se anote en la
 * consola y nada más, y el envío es de fondo (`sendBeacon` al cerrar, `fetch`
 * con `keepalive` en el medio). Sin `iniciarMedicion()` todo es inerte, que
 * es como corre en las pruebas de cada pantalla.
 *
 * Quien no quiere ser contado no lo es: se respetan Do Not Track y Global
 * Privacy Control, y el personal del local puede abrir la tienda una vez con
 * `?medir=0` para que ese aparato no cuente nunca más.
 */
import { limpiarTermino, clasificarOrigen, MAX_EVENTOS } from './estadisticas.js';
import { alAgregar } from './carrito.js';

export const FUNCION = '/.netlify/functions/medir';
const CLAVE = 'liceo.medicion.v1';
const CLAVE_APAGADO = 'll-medir-apagado';

// Una visita nueva es media hora sin tocar nada, lo mismo que cuenta cualquier
// herramienta de tráfico.
const SESION_MS = 30 * 60 * 1000;
// Cuánto se espera para juntar varios eventos en una tanda.
const ESPERA_MS = 4000;
// Dos búsquedas iguales en este lapso son una sola: tipear, ver la sugerencia
// y apretar Enter dispara la misma pregunta por dos caminos.
const REPETIDA_MS = 60 * 1000;

let activo = false;
let cola = [];
let temporizador = null;
let ultimasBusquedas = new Map();
let desengancharCarrito = null;

const ahora = () => Date.now();

/* ── Estado del navegador ─────────────────────────────────────────────────── */

function leerEstado() {
  try {
    const crudo = localStorage.getItem(CLAVE);
    const datos = crudo ? JSON.parse(crudo) : null;
    return datos && typeof datos === 'object' ? datos : {};
  } catch {
    return {};
  }
}

function guardarEstado(estado) {
  try { localStorage.setItem(CLAVE, JSON.stringify(estado)); } catch { /* sin storage */ }
}

/**
 * Lee `?medir=0` (o `?medir=1` para volver) y lo deja guardado, como hace el
 * modo fotos. El parámetro se saca de la barra de direcciones después.
 */
function aplicarApagadoDesdeURL() {
  let valor = null;
  try { valor = new URL(location.href).searchParams.get('medir'); } catch { return; }
  if (valor === null) return;
  try {
    if (valor === '0' || valor === 'no') localStorage.setItem(CLAVE_APAGADO, '1');
    else localStorage.removeItem(CLAVE_APAGADO);
  } catch { /* sin storage: vale para esta sesión */ }
  try {
    const url = new URL(location.href);
    url.searchParams.delete('medir');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch { /* no es grave */ }
}

function apagadoEnEsteAparato() {
  try { return localStorage.getItem(CLAVE_APAGADO) === '1'; } catch { return false; }
}

function pidioNoSerSeguido() {
  const nav = globalThis.navigator || {};
  return nav.doNotTrack === '1' || globalThis.doNotTrack === '1'
    || nav.globalPrivacyControl === true;
}

/** 'movil' o 'escritorio', por cómo se toca la pantalla. */
export function dispositivoActual() {
  try {
    if (globalThis.matchMedia?.('(pointer: coarse)')?.matches) return 'movil';
  } catch { /* sin matchMedia */ }
  const ua = String(globalThis.navigator?.userAgent || '');
  return /Mobi|Android|iPhone|iPad/i.test(ua) ? 'movil' : 'escritorio';
}

/* ── La cola y el envío ───────────────────────────────────────────────────── */

function programar() {
  if (temporizador) return;
  temporizador = setTimeout(() => { temporizador = null; enviar(); }, ESPERA_MS);
}

/**
 * Manda lo que hay en la cola. Al cerrar la pestaña va por `sendBeacon`, que
 * es lo único que el navegador promete entregar cuando la página ya se está
 * yendo; el resto del tiempo, `fetch` con `keepalive`.
 */
export function enviar({ final = false } = {}) {
  if (!cola.length) return;
  const lote = cola.splice(0, MAX_EVENTOS);
  const cuerpo = JSON.stringify({ v: 1, eventos: lote });

  try {
    if (final && typeof navigator?.sendBeacon === 'function') {
      const fue = navigator.sendBeacon(FUNCION, new Blob([cuerpo], { type: 'application/json' }));
      if (fue) return;
    }
    if (typeof fetch !== 'function') return;
    fetch(FUNCION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: cuerpo,
      keepalive: true,
    }).catch(() => { /* la tanda se pierde; no vale la pena reintentar */ });
  } catch (err) {
    console.warn('[medicion] no se pudo mandar:', err);
  }
  // Si quedó más de una tanda, la siguiente sale detrás.
  if (cola.length) programar();
}

/** Renueva la marca de actividad; si la visita venció, abre otra. */
function tocar() {
  const t = ahora();
  const estado = leerEstado();
  const vencida = !estado.ultima || t - estado.ultima > SESION_MS;
  if (vencida) {
    const nueva = !estado.visto;
    cola.push({
      t, tipo: 'visita', nueva,
      dispositivo: dispositivoActual(),
      origen: clasificarOrigen({
        referrer: globalThis.document?.referrer || '',
        url: globalThis.location?.href || '',
      }),
    });
    estado.visto = true;
  }
  estado.ultima = t;
  guardarEstado(estado);
}

/* ── Lo que se llama desde la tienda ──────────────────────────────────────── */

/**
 * Anota un evento. Inerte hasta `iniciarMedicion()`.
 *
 * @param {'pagina'|'busqueda'|'ficha'|'carrito'|'checkout'|'chat'} tipo
 * @param {object} [datos]
 */
export function medir(tipo, datos = {}) {
  if (!activo) return;
  try {
    if (tipo === 'busqueda') {
      const termino = limpiarTermino(datos.texto);
      if (!termino) return;
      const t = ahora();
      const antes = ultimasBusquedas.get(termino);
      if (antes && t - antes < REPETIDA_MS) return;
      ultimasBusquedas.set(termino, t);
      if (ultimasBusquedas.size > 200) {
        ultimasBusquedas = new Map([...ultimasBusquedas].slice(-100));
      }
    }
    tocar();
    cola.push({ t: ahora(), tipo, ...datos });
    if (cola.length >= MAX_EVENTOS) enviar();
    else programar();
  } catch (err) {
    console.warn('[medicion] no se pudo anotar:', err);
  }
}

/** La pantalla que se acaba de abrir, desde el router. */
export function medirPantalla(camino, params = {}) {
  const pantalla = camino === '/' ? 'inicio'
    : camino.startsWith('/catalogo') ? 'catalogo'
    : camino.startsWith('/p/') || camino === '/p' ? 'producto'
    : camino.startsWith('/checkout') ? 'checkout'
    : camino.startsWith('/pedido') ? 'pedido'
    : camino.startsWith('/seguimiento') ? 'seguimiento'
    : camino.startsWith('/cuenta') ? 'cuenta'
    : null;
  if (!pantalla) return;
  const datos = { pantalla };
  if (pantalla === 'catalogo' && params.rubro) {
    try { datos.rubro = decodeURIComponent(params.rubro); } catch { datos.rubro = params.rubro; }
  }
  medir('pagina', datos);
}

/**
 * Prende la medición. Se llama una vez al arrancar, antes del primer pintado.
 *
 * @returns {boolean} si quedó midiendo
 */
export function iniciarMedicion() {
  try {
    aplicarApagadoDesdeURL();
    if (apagadoEnEsteAparato() || pidioNoSerSeguido()) {
      activo = false;
      return false;
    }
    activo = true;

    desengancharCarrito?.();
    desengancharCarrito = alAgregar((producto) => {
      medir('carrito', { id: producto.id, nombre: producto.nombre, rubro: producto.rubro || null });
    });

    // Lo que queda en la cola sale cuando la persona se va o cambia de
    // pestaña: es el único momento en que se puede prometer que se manda.
    const irse = () => enviar({ final: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') irse();
    });
    window.addEventListener('pagehide', irse);
    return true;
  } catch (err) {
    console.warn('[medicion] no se pudo iniciar:', err);
    activo = false;
    return false;
  }
}

/** Si está midiendo. */
export function midiendo() {
  return activo;
}

/** Para las pruebas: vuelve todo al estado inicial. */
export function reiniciarMedicion() {
  activo = false;
  cola = [];
  clearTimeout(temporizador);
  temporizador = null;
  ultimasBusquedas = new Map();
  desengancharCarrito?.();
  desengancharCarrito = null;
}

/** Para las pruebas: lo que todavía no se mandó. */
export function pendientes() {
  return cola.slice();
}
