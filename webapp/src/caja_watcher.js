/**
 * Aviso de "se está vendiendo sin caja abierta".
 *
 * El sábado 05/09/2026 nadie abrió caja. El viernes se había cerrado la 126 a
 * las 20:29 y desde ahí no se abrió ninguna, así que las 127 ventas del sábado
 * se fueron pegando a las cajas que cada PC tenía guardadas de días
 * anteriores — la 113, la 123 y la 125, cerradas hace una semana. Nadie se dio
 * cuenta hasta el lunes: el POS no avisa nada porque cree que su caja vieja
 * sigue abierta, y en el panel el sábado directamente no existía como cierre.
 *
 * Este módulo mira dos cosas que ya están en el store (no agrega ni una lectura
 * a Firestore) y avisa apenas pasa:
 *
 *   1. No hay ninguna caja abierta y se siguió vendiendo. Es el caso del sábado.
 *   2. Hay caja abierta pero una PC le está poniendo otro número a sus ventas.
 *      Es la misma falla vista desde la otra punta: esa PC quedó colgada de una
 *      caja vieja y su plata no va a aparecer en el cierre de hoy.
 *
 * El aviso no se va solo: si desaparece a los cinco segundos mientras se está
 * cobrando, el día entero se pierde igual. Se repite cada media hora mientras
 * el problema siga, y se corta solo apenas alguien abre la caja.
 */
import { peekCacheValue, isHydrated } from './cache.js';
import { onStoreChange } from './store.js';
import { mostrarToast } from './components/toasts.js';
import { fechaDMYtoYMD, isItemVarios2 } from './config.js';

// Cuánto tiempo sin caja abierta se tolera antes de avisar. Todas las noches
// hay unos segundos entre el cierre de una caja y la apertura de la siguiente:
// avisar ahí sería ruido puro. Diez minutos no los cubre ninguna rotación
// normal y siguen siendo pocas ventas de daño.
const GRACIA_MS = 10 * 60 * 1000;
// Cada cuánto se vuelve a avisar mientras el problema siga sin resolverse.
const REPETIR_MS = 30 * 60 * 1000;
const REVISAR_MS = 60 * 1000;

/* ── Decisión ────────────────────────────────────────────────────────────── */

function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Un valor de Firestore/JS a milisegundos, o null si no se puede. */
export function aMillis(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return isNaN(v) ? null : v.getTime();
  if (typeof v.toDate === 'function') {
    const d = v.toDate();
    return d && !isNaN(d) ? d.getTime() : null;
  }
  if (typeof v.seconds === 'number') {
    return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.getTime();
}

/** El id de la caja realmente abierta, o null si no hay ninguna. */
export function cajaAbiertaId(cajaActiva) {
  if (!cajaActiva || cajaActiva.status !== 'open') return null;
  return _num(cajaActiva.id) ?? _num(cajaActiva.register_id);
}

/**
 * Qué está mal con la caja, si algo está mal.
 *
 * Devuelve null cuando no hay nada que avisar, o el aviso ya armado:
 *   { tipo, ventas, total, pcs, caja, desde }
 *
 * `items` son renglones de `ventas_por_dia` del día de hoy; `ahora` en ms.
 * Se exporta aparte del watcher justamente para poder probarla:
 * `tienda/pruebas/caja_watcher.test.js`.
 */
export function evaluarCaja({ cajaActiva, items = [], ahora = Date.now() } = {}) {
  const abierta = cajaAbiertaId(cajaActiva);

  // Los borrados y los VARIOS 2 no cuentan para nada, tampoco acá.
  const reales = items.filter(it => it && it.deleted !== true && !isItemVarios2(it));
  if (reales.length === 0) return null;

  // Desde cuándo hay que mirar: si no hay caja, desde que se cerró la última;
  // si hay, desde que se abrió. Las ventas anteriores llevan con razón el
  // número de la caja de antes y no son ningún error.
  const desdeMs = aMillis(cajaActiva && (cajaActiva.opening_date || cajaActiva.updated_at));

  const posteriores = desdeMs === null
    ? reales
    : reales.filter(it => {
        const t = aMillis(it.fecha_dt);
        return t === null ? true : t >= desdeMs;
      });
  if (posteriores.length === 0) return null;

  const sospechosos = abierta === null
    ? posteriores
    // Con caja abierta, el problema es la PC que le pone otro número. Los
    // renglones viejos sin `cash_register_id` no acusan a nadie.
    : posteriores.filter(it => {
        const rid = _num(it.cash_register_id);
        return rid !== null && rid !== abierta;
      });
  if (sospechosos.length === 0) return null;

  // Sin caja abierta se espera la gracia: la rotación de todas las noches deja
  // unos segundos sin caja y no es un problema.
  if (abierta === null && desdeMs !== null && (ahora - desdeMs) < GRACIA_MS) return null;

  const ventas = new Set();
  const pcs = new Set();
  let total = 0;
  let primera = null;
  for (const it of sospechosos) {
    ventas.add(`${it._pc_id || it.pc_id || ''}|${it.num_venta}`);
    const pc = it._pc_id || it.pc_id || '';
    if (pc) pcs.add(pc);
    total += Number(it.subtotal || 0);
    const t = aMillis(it.fecha_dt);
    if (t !== null && (primera === null || t < primera)) primera = t;
  }

  return {
    tipo: abierta === null ? 'sin_caja' : 'caja_ajena',
    ventas: ventas.size,
    total,
    pcs: [...pcs].sort(),
    caja: abierta,
    desde: primera,
  };
}

/* ── Aviso ───────────────────────────────────────────────────────────────── */

function _pesos(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

function _escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function _hora(ms) {
  if (ms === null || ms === undefined) return '';
  const d = new Date(ms);
  return isNaN(d) ? '' : d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

export function textoDelAviso(a) {
  const cuantas = `${a.ventas} ${a.ventas === 1 ? 'venta' : 'ventas'}`;
  const desde = a.desde ? ` desde las ${_hora(a.desde)}` : '';
  if (a.tipo === 'sin_caja') {
    return {
      etiqueta: 'Nadie abrió la caja',
      titulo: `${cuantas} sin caja${desde}`,
      cuerpo: `Van ${_pesos(a.total)} que no van a entrar en ningún cierre. Abrí la caja del día.`,
    };
  }
  const cuales = a.pcs.length ? a.pcs.join(', ') : 'una PC';
  return {
    etiqueta: 'Ventas fuera de la caja de hoy',
    titulo: `${cuantas} con otro número de caja${desde}`,
    cuerpo: `${_pesos(a.total)} están cayendo en una caja vieja en vez de la ${a.caja}. `
          + `Reiniciá el POS en ${cuales}.`,
  };
}

let _toast = null;

function _avisar(a) {
  const t = textoDelAviso(a);
  if (_toast) { try { _toast.cerrar(); } catch (_) {} }
  _toast = mostrarToast({
    tono: 'rojo',
    etiqueta: t.etiqueta,
    icono: 'point_of_sale',
    titulo: t.titulo,
    detalleHtml: `<div class="ll-toast-nota"><span class="material-icons">warning</span>${_escape(t.cuerpo)}</div>`,
    acciones: [{ id: 'ir', texto: 'Ir a Cierres de Caja', principal: true }],
    duracion: 0,
    prioritario: true,
    onAccion: (id, api) => {
      if (id === 'ir') window.navigateToPage?.('cierres');
      api.cerrar();
    },
  });
  _notificarNavegador(t);
}

function _notificarNavegador(t) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(t.etiqueta, {
      body: `${t.titulo}. ${t.cuerpo}`,
      tag: 'caja-sin-abrir',
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      window.navigateToPage?.('cierres');
      n.close();
    };
  } catch (e) {
    console.warn('[caja] no se pudo notificar:', e);
  }
}

/* ── Suscriptores ────────────────────────────────────────────────────────── */

const _listeners = new Set();
let _aviso = null;

/** El aviso vigente (null si está todo bien), para el badge del menú. */
export function avisoDeCaja() {
  return _aviso;
}

export function onCajaCambia(cb) {
  _listeners.add(cb);
  cb(_aviso);
  return () => _listeners.delete(cb);
}

/* ── Arranque ────────────────────────────────────────────────────────────── */

let _initialized = false;
let _unsubStore = null;
let _timer = null;
let _ultimoAvisoMs = 0;

function _hoyYmd(ahora) {
  // El panel se usa en Córdoba; el store guarda `fecha` como "DD/MM/YYYY" en
  // hora local del negocio, así que la comparación va contra la fecha local.
  const d = new Date(ahora);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function _revisar() {
  const ahora = Date.now();
  const hoy = _hoyYmd(ahora);
  // Al arrancar, el store rellena estas keys con el snapshot de la sesión
  // anterior para pintar al toque. Ese estado es de ayer: acusar con él sería
  // gritar "no hay caja" justo cuando la acaban de abrir. Se espera al
  // snapshot real del listener.
  if (isHydrated('caja_activa:current') || isHydrated('historial:ventas_dia:v3')) return;

  const cajaActiva = peekCacheValue('caja_activa:current');
  const todos = peekCacheValue('historial:ventas_dia:v3');
  // Sin los datos del store todavía no se puede decidir nada. Callar es lo
  // correcto: un aviso disparado por un cache vacío sería un falso positivo.
  if (!Array.isArray(todos)) return;

  const items = todos.filter(it => fechaDMYtoYMD(it.fecha) === hoy);
  const nuevo = evaluarCaja({ cajaActiva, items, ahora });

  const cambio = JSON.stringify(nuevo) !== JSON.stringify(_aviso);
  _aviso = nuevo;
  if (cambio) {
    for (const cb of _listeners) {
      try { cb(_aviso); } catch (e) { console.warn('[caja] listener:', e); }
    }
  }

  if (!nuevo) {
    // Se resolvió: el aviso se cierra solo, no hay que pedirle a nadie que lo
    // baje a mano después de abrir la caja.
    _ultimoAvisoMs = 0;
    if (_toast) { try { _toast.cerrar(); } catch (_) {} _toast = null; }
    return;
  }
  if (cambio || ahora - _ultimoAvisoMs >= REPETIR_MS) {
    _ultimoAvisoMs = ahora;
    _avisar(nuevo);
  }
}

export function initCajaWatcher() {
  if (_initialized) return;
  _initialized = true;

  // Se apoya en los listeners que el store ya tiene abiertos sobre
  // `caja_activa` y `ventas_por_dia`: cero lecturas extra a Firestore.
  _unsubStore = onStoreChange(col => {
    if (col === 'caja_activa' || col === 'ventas_por_dia') _revisar();
  });
  // Y un reloj propio, porque el caso "no abrieron la caja" no genera ningún
  // cambio en Firestore hasta que alguien vende: sin esto el aviso llegaría
  // recién con la primera venta después de que venza la gracia.
  _timer = setInterval(_revisar, REVISAR_MS);
  _revisar();
}

export function detenerCajaWatcher() {
  _unsubStore?.();
  _unsubStore = null;
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_toast) { try { _toast.cerrar(); } catch (_) {} _toast = null; }
  _initialized = false;
  _ultimoAvisoMs = 0;
  _aviso = null;
  for (const cb of _listeners) {
    try { cb(null); } catch (_) {}
  }
}
