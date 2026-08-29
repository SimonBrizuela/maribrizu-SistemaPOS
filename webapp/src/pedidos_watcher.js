/**
 * Watcher de pedidos de la tienda online.
 *
 * Un pedido que entra por la web no lo ve nadie hasta que alguien se acuerda de
 * mirar. Este módulo lo avisa solo, en el momento, con tres capas que se apoyan
 * entre sí porque cada una falla en un caso distinto:
 *
 *   1. Sonido. Es lo único que funciona con la pestaña de fondo y la persona
 *      atendiendo el mostrador.
 *   2. Toast in-app, que queda hasta que lo cierran: un aviso que se va solo a
 *      los cinco segundos se pierde si en ese momento estaban cobrando.
 *   3. Notificación del navegador, que sale aunque la ventana esté minimizada.
 *
 * La primera carga no dispara avisos uno por uno: si había cuatro pedidos sin
 * ver, cuatro sonidos seguidos al abrir la página son ruido. Sale un único
 * resumen y desde ahí sí, cada pedido nuevo avisa solo.
 */
import { collection, query, orderBy, limit, onSnapshot, doc, updateDoc } from 'firebase/firestore';
import { mostrarToast } from './components/toasts.js';

let _db = null;
let _initialized = false;
let _unsub = null;
let _baselineDone = false;
let _avisados = new Set();     // ids ya avisados en esta sesión
let _audioCtx = null;

const LS_SONIDO = 'pedidos:sonido';
const MAX_PEDIDOS = 25;

/* ── Sonido ──────────────────────────────────────────────────────────────── */

export function sonidoActivo() {
  return localStorage.getItem(LS_SONIDO) !== '0';
}

export function setSonido(activo) {
  if (activo) localStorage.removeItem(LS_SONIDO);
  else localStorage.setItem(LS_SONIDO, '0');
}

/**
 * Campanita de dos notas, sintetizada.
 *
 * Sin archivo de audio a propósito: un mp3 hay que servirlo, cachearlo y puede
 * fallar la descarga justo cuando hace falta. Dos osciladores no fallan y pesan
 * cero.
 */
function _sonar() {
  if (!sonidoActivo()) return;
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    // Los navegadores dejan el contexto suspendido hasta que hay una
    // interacción; si ya la hubo, esto lo reanuda.
    if (_audioCtx.state === 'suspended') _audioCtx.resume();

    const ahora = _audioCtx.currentTime;
    [[880, 0], [1174.7, 0.14]].forEach(([hz, retraso]) => {
      const osc = _audioCtx.createOscillator();
      const vol = _audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      // Ataque corto y caída larga: suena a campana, no a alarma de horno.
      vol.gain.setValueAtTime(0, ahora + retraso);
      vol.gain.linearRampToValueAtTime(0.25, ahora + retraso + 0.01);
      vol.gain.exponentialRampToValueAtTime(0.001, ahora + retraso + 0.6);
      osc.connect(vol).connect(_audioCtx.destination);
      osc.start(ahora + retraso);
      osc.stop(ahora + retraso + 0.65);
    });
  } catch (e) {
    console.warn('[pedidos] no se pudo sonar:', e);
  }
}

/* ── Avisos ──────────────────────────────────────────────────────────────── */

function _escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _pesos(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

/**
 * Toast de pedido nuevo. No se va solo: un pedido es plata esperando, y que el
 * aviso desaparezca mientras se atiende a otra persona es exactamente el caso
 * que este módulo existe para evitar. Por eso además va arriba de la pila,
 * encima de cualquier aviso de stock.
 */
function _mostrarToast(p) {
  const modo = p?.entrega?.modo === 'delivery' ? 'Envío a domicilio' : 'Retiro en el local';
  const cuantos = (p.items || []).length;
  const tel = p?.cliente?.telefono || '';

  mostrarToast({
    tono: 'verde',
    etiqueta: 'Pedido nuevo de la tienda',
    icono: 'shopping_bag',
    titulo: `${p?.cliente?.nombre || 'Sin nombre'} · ${p.codigo || ''}`.trim(),
    detalleHtml: `
      ${cuantos} ${cuantos === 1 ? 'producto' : 'productos'}<span class="ll-toast-sep">·</span><b>${_pesos(p.total)}</b>
      <div class="ll-toast-nota"><span class="material-icons">${p?.entrega?.modo === 'delivery' ? 'local_shipping' : 'storefront'}</span>${_escape(modo)}${tel ? ` · tel ${_escape(tel)}` : ''}</div>
    `,
    acciones: [
      { id: 'ver', texto: 'Ver el pedido', principal: true },
      { id: 'visto', texto: 'Marcar visto' },
    ],
    duracion: 0,
    prioritario: true,
    onAccion: (id, api) => {
      // El aviso tiene que terminar en la pantalla donde se trabaja el pedido.
      // Uno que solo dice que entró algo obliga a buscarlo a mano después.
      if (id === 'ver') window.navigateToPage?.('pedidos_tienda');
      if (id === 'visto') marcarVisto(p.id);
      api.cerrar();
    },
  });
}

function _mostrarResumen(cantidad) {
  mostrarToast({
    tono: 'naranja',
    etiqueta: 'Tienda',
    icono: 'inbox',
    titulo: `${cantidad} ${cantidad === 1 ? 'pedido' : 'pedidos'} sin ver`,
    detalleHtml: 'Entraron mientras la página estaba cerrada.',
    acciones: [{ id: 'ver', texto: 'Ver los pedidos', principal: true }],
    duracion: 0,
    prioritario: true,
    onAccion: (id, api) => {
      if (id === 'ver') window.navigateToPage?.('pedidos_tienda');
      api.cerrar();
    },
  });
}

function _notificarNavegador(p) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const modo = p?.entrega?.modo === 'delivery' ? 'Envío' : 'Retiro';
    const n = new Notification(`Pedido nuevo · ${_pesos(p.total)}`, {
      body: `${p?.cliente?.nombre || 'Sin nombre'} · ${modo} · ${(p.items || []).length} productos`,
      tag: `pedido-${p.id}`,
      // No se cierra sola: si el aviso se desvanece mientras se atiende a
      // alguien en el mostrador, el pedido queda sin ver.
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      window.navigateToPage?.('pedidos_tienda');
      n.close();
    };
  } catch (e) {
    console.warn('[pedidos] no se pudo notificar:', e);
  }
}

/* ── Estado de un pedido ─────────────────────────────────────────────────── */

export async function marcarVisto(id) {
  try {
    await updateDoc(doc(_db, 'tienda_pedidos', id), { visto: true });
  } catch (e) {
    console.warn('[pedidos] no se pudo marcar visto:', e);
  }
}

/* ── Suscriptores ────────────────────────────────────────────────────────── */

const _listeners = new Set();
let _pendientes = [];

/** Los pedidos sin ver, para el badge del menú. */
export function pedidosPendientes() {
  return _pendientes.slice();
}

export function onPedidosCambian(cb) {
  _listeners.add(cb);
  cb(_pendientes.slice());
  return () => _listeners.delete(cb);
}

/* ── Arranque ────────────────────────────────────────────────────────────── */

export function initPedidosWatcher(db) {
  if (_initialized) return;
  _db = db;
  _initialized = true;

  // Se ordena por fecha y se filtra acá en vez de consultar por `visto`: la
  // consulta compuesta pediría un índice y este listener tiene que andar sin
  // depender de un despliegue.
  const consulta = query(
    collection(_db, 'tienda_pedidos'),
    orderBy('creado', 'desc'),
    limit(MAX_PEDIDOS),
  );

  _unsub = onSnapshot(consulta, snap => {
    const todos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _pendientes = todos.filter(p => p.visto !== true && p.estado !== 'cancelado');

    if (!_baselineDone) {
      _baselineDone = true;
      _pendientes.forEach(p => _avisados.add(p.id));
      if (_pendientes.length) {
        _mostrarResumen(_pendientes.length);
        _sonar();
      }
    } else {
      const nuevos = _pendientes.filter(p => !_avisados.has(p.id));
      nuevos.forEach(p => {
        _avisados.add(p.id);
        _mostrarToast(p);
        _notificarNavegador(p);
      });
      if (nuevos.length) _sonar();
    }

    for (const cb of _listeners) {
      try { cb(_pendientes.slice()); } catch (e) { console.warn('[pedidos] listener:', e); }
    }
  }, err => {
    console.warn('[pedidos] se cortó la escucha:', err);
  });
}

export function detenerPedidosWatcher() {
  _unsub?.();
  _unsub = null;
  _initialized = false;
  _baselineDone = false;
  _avisados = new Set();
  // La lista también se vacía, y se avisa. Sin esto el badge del menú se queda
  // con los pedidos del que acaba de salir: ya no hay nadie escuchando la
  // colección, pero el número sigue ahí como si fuera de ahora.
  _pendientes = [];
  for (const cb of _listeners) {
    try { cb([]); } catch (_) {}
  }
}
