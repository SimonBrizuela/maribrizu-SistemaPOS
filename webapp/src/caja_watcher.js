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
 *   1. No hay ninguna caja abierta y se siguió vendiendo DESPUÉS del último
 *      cierre. Es el caso del sábado. Lo vendido antes del cierre no cuenta:
 *      entró en la caja que se cerró y está donde tiene que estar.
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

  // Desde cuándo hay que mirar las ventas. Son DOS cortes distintos y usar el
  // que no va es lo que hacía saltar el aviso de mentira.
  //
  // Al cerrar, el POS escribe `caja_activa/current` con merge: el doc de una
  // caja cerrada conserva el `opening_date` de esa misma caja y trae el cierre
  // en `updated_at`.
  //
  //   - Sin caja abierta, el corte es el CIERRE más la gracia. Todo lo vendido
  //     antes entró en esa caja y está bien; lo del minuto del cierre también,
  //     que le queda pegado el número de la caja que se acaba de cerrar y cae
  //     igual en ese cierre. Huérfano es lo que sigue saliendo un rato después,
  //     con la caja del día sin abrir.
  //   - Con caja abierta, el corte es la APERTURA. Lo de antes lleva con razón
  //     el número de la caja anterior.
  //
  // Cortando siempre por `opening_date` —lo que se hacía— una caja recién
  // cerrada arrastraba el día entero: la noche del 19/09, con la caja cerrada a
  // las 20:33 y todo en orden, el panel acusó "158 ventas sin caja desde las
  // 09:30" con el total del día. Y sin la gracia sobre la hora de la venta
  // quedaba acusando la 5566, cobrada 21 segundos después del cierre y que está
  // en su caja. Un aviso que miente es peor que no tenerlo.
  const cierreMs = aMillis(cajaActiva && (cajaActiva.updated_at || cajaActiva.opening_date));
  const aperturaMs = aMillis(cajaActiva && (cajaActiva.opening_date || cajaActiva.updated_at));
  const desdeMs = abierta === null
    ? (cierreMs === null ? null : cierreMs + GRACIA_MS)
    : aperturaMs;

  // Y mientras la gracia corre no hay nada que decir: la rotación de todas las
  // noches deja unos minutos sin caja y no es un problema.
  if (abierta === null && cierreMs !== null && (ahora - cierreMs) < GRACIA_MS) return null;

  const posteriores = desdeMs === null
    ? reales
    : reales.filter(it => {
        const t = aMillis(it.fecha_dt);
        // Un renglón sin fecha no se puede ubicar en el tiempo y no alcanza
        // para acusar a nadie. En `ventas_por_dia` los tienen todos.
        return t !== null && t >= desdeMs;
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

  // Cuáles PCs SIGUEN colgadas: las que tienen su última venta en otra caja.
  // Una PC que se equivocó en la primera venta de la mañana y después se
  // acomodó (23/09/2026: tres PCs, una venta cada una, y todo lo demás en la
  // 142) ya no necesita que la reinicien; lo que queda es esa plata mal
  // anotada. Pedirle "reiniciá" a una PC que anda bien es mandar a alguien a
  // hacer algo que no arregla nada.
  const colgadas = [];
  if (abierta !== null) {
    const ultimaPorPc = new Map();   // pc → { t, rid }
    for (const it of posteriores) {
      const pc = it._pc_id || it.pc_id || '';
      const t = aMillis(it.fecha_dt);
      if (!pc || t === null) continue;
      const u = ultimaPorPc.get(pc);
      if (!u || t > u.t) ultimaPorPc.set(pc, { t, rid: _num(it.cash_register_id) });
    }
    for (const [pc, u] of ultimaPorPc) if (u.rid !== null && u.rid !== abierta) colgadas.push(pc);
    colgadas.sort();
  }

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
    colgadas,
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
  const colgadas = Array.isArray(a.colgadas) ? a.colgadas : a.pcs;
  if (!colgadas.length) {
    // Las PCs ya volvieron solas a la caja de hoy: queda la plata de antes
    // anotada en la vieja, que hay que pasar para que el cierre dé.
    return {
      etiqueta: 'Ventas fuera de la caja de hoy',
      titulo: `${cuantas} ${a.ventas === 1 ? 'quedó' : 'quedaron'} en otra caja${desde}`,
      cuerpo: `${_pesos(a.total)} quedaron anotados en una caja vieja. Las PCs ya volvieron `
            + `solas a la ${a.caja}, no hace falta reiniciar: falta pasar esas ventas a la ${a.caja}.`,
    };
  }
  return {
    etiqueta: 'Ventas fuera de la caja de hoy',
    titulo: `${cuantas} con otro número de caja${desde}`,
    cuerpo: `${_pesos(a.total)} están cayendo en una caja vieja en vez de la ${a.caja}. `
          + `Reiniciá el POS en ${colgadas.join(', ')}.`,
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

let _notif = null;

function _notificarNavegador(t) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    _cerrarNotificacion();
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
    _notif = n;
  } catch (e) {
    console.warn('[caja] no se pudo notificar:', e);
  }
}

// La notificación queda pegada en el escritorio hasta que alguien la toca
// (`requireInteraction`). Si el problema se resolvió, que se vaya sola: leerla
// media hora después, con la caja ya abierta, es leer algo que no es cierto.
function _cerrarNotificacion() {
  if (!_notif) return;
  try { _notif.close(); } catch (_) {}
  _notif = null;
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
    _cerrarNotificacion();
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
  _cerrarNotificacion();
  _initialized = false;
  _ultimoAvisoMs = 0;
  _aviso = null;
  for (const cb of _listeners) {
    try { cb(null); } catch (_) {}
  }
}
