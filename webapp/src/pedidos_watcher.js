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

let _db = null;
let _initialized = false;
let _unsub = null;
let _baselineDone = false;
let _avisados = new Set();     // ids ya avisados en esta sesión
let _toastRoot = null;
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

function _ensureToastRoot() {
  if (_toastRoot && document.body.contains(_toastRoot)) return _toastRoot;
  _toastRoot = document.createElement('div');
  _toastRoot.id = 'pedidosToastRoot';
  _toastRoot.style.cssText = [
    'position:fixed',
    'top:14px',
    'right:14px',
    'z-index:9100',   // por encima de los toasts de stock: un pedido manda más
    'display:flex',
    'flex-direction:column',
    'gap:10px',
    'pointer-events:none',
    'width:min(380px, calc(100vw - 28px))',
  ].join(';');
  document.body.appendChild(_toastRoot);
  return _toastRoot;
}

function _cerrarToast(toast) {
  toast.style.transform = 'translateX(16px)';
  toast.style.opacity = '0';
  setTimeout(() => toast.remove(), 250);
}

/**
 * Toast de pedido nuevo. No se va solo: un pedido es plata esperando, y que el
 * aviso desaparezca mientras se atiende a otra persona es exactamente el caso
 * que este módulo existe para evitar.
 */
function _mostrarToast(p) {
  const root = _ensureToastRoot();
  const toast = document.createElement('div');
  toast.setAttribute('role', 'alert');

  const modo = p?.entrega?.modo === 'delivery' ? 'Envío a domicilio' : 'Retiro en el local';
  const cuantos = (p.items || []).length;

  toast.style.cssText = [
    'pointer-events:auto',
    'background:var(--surface)',
    'border-left:5px solid #2f7a3d',
    'border-radius:12px',
    'box-shadow:0 8px 28px rgba(0,0,0,0.26)',
    'padding:12px 14px',
    'display:flex',
    'align-items:flex-start',
    'gap:10px',
    'font-family:Inter,system-ui,sans-serif',
    'color:var(--text)',
    'transform:translateX(16px)',
    'opacity:0',
    'transition:transform 0.25s ease, opacity 0.25s ease',
  ].join(';');

  toast.innerHTML = `
    <span class="material-icons" style="color:#2f7a3d;font-size:22px;flex-shrink:0">shopping_bag</span>
    <div style="flex:1;min-width:0">
      <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.5px;color:#2f7a3d;margin-bottom:2px">
        Pedido nuevo de la tienda
      </div>
      <div style="font-size:14px;font-weight:700;line-height:1.3;word-wrap:break-word">
        ${_escape(p?.cliente?.nombre || 'Sin nombre')} · ${_escape(p.codigo || '')}
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:3px">
        ${cuantos} ${cuantos === 1 ? 'producto' : 'productos'} · <b>${_pesos(p.total)}</b><br>
        ${_escape(modo)} · tel ${_escape(p?.cliente?.telefono || '')}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button data-act="ver" style="background:#2f7a3d;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
          Ver el pedido
        </button>
        <button data-act="visto" style="background:transparent;color:var(--text-muted);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
          Marcar visto
        </button>
      </div>
    </div>`;

  toast.addEventListener('click', ev => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    // El aviso tiene que terminar en la pantalla donde se trabaja el pedido. Un
    // toast que solo dice que entro algo obliga a buscarlo a mano despues.
    if (act === 'ver') window.navigateToPage?.('pedidos_tienda');
    if (act === 'visto') marcarVisto(p.id);
    _cerrarToast(toast);
  });

  root.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.transform = 'none';
    toast.style.opacity = '1';
  });
}

function _mostrarResumen(cantidad) {
  const root = _ensureToastRoot();
  const toast = document.createElement('div');
  toast.setAttribute('role', 'status');
  toast.style.cssText = [
    'pointer-events:auto',
    'background:var(--surface)',
    'border-left:5px solid #f57c00',
    'border-radius:12px',
    'box-shadow:0 6px 24px rgba(0,0,0,0.18)',
    'padding:12px 14px',
    'display:flex',
    'align-items:center',
    'gap:10px',
    'font-family:Inter,system-ui,sans-serif',
    'color:var(--text)',
    'transform:translateX(16px)',
    'opacity:0',
    'transition:transform 0.25s ease, opacity 0.25s ease',
  ].join(';');
  toast.innerHTML = `
    <span class="material-icons" style="color:#f57c00;font-size:22px">inbox</span>
    <div style="flex:1;font-size:13px;line-height:1.4">
      <b>${cantidad} ${cantidad === 1 ? 'pedido' : 'pedidos'} de la tienda sin ver.</b>
    </div>
    <button data-act="x" aria-label="Cerrar" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:2px;line-height:1">
      <span class="material-icons" style="font-size:18px">close</span>
    </button>`;
  toast.addEventListener('click', () => _cerrarToast(toast));
  root.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.transform = 'none';
    toast.style.opacity = '1';
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
