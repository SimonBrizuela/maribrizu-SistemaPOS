/**
 * Notificaciones globales de stock bajo.
 *
 * Detecta productos cuyo stock efectivo ya está en o por debajo de `stock_min`,
 * y dispara dos avisos: un toast in-app que aparece arriba en cualquier página,
 * y (si el usuario lo permite) una notificación nativa del navegador. Desde
 * cualquiera de los dos, el click lleva al editor del producto en el catálogo
 * para que el usuario pueda rellenar.
 *
 * Eventos:
 *   - Init: subscribe a config/catalogo_meta y carga el catálogo una vez para
 *           establecer el baseline (no spam-ea toasts por estado inicial).
 *   - Cambio: re-carga, diff vs estado anterior, dispara toasts SÓLO para
 *             productos que recién cruzaron el umbral.
 *
 * Persistencia:
 *   - `notif:browser_enabled` (localStorage): preferencia del usuario.
 *   - `notif:silenced_until` (localStorage): timestamp hasta el que se silencia
 *     todo (no implementado todavía, dejado para futuro).
 */
import { collection, getDocs, doc, onSnapshot, query, orderBy } from 'firebase/firestore';

// ── Estado interno ───────────────────────────────────────────────────────────
let _db = null;
let _initialized = false;
let _productos = [];           // último snapshot del catálogo
let _activeIds = new Set();    // doc_ids actualmente en alerta (stock <= stock_min)
let _lastStockPorKey = new Map(); // key → último stock notificado, para re-alertar si baja más
let _listeners = new Set();    // suscriptores (página /notificaciones)
let _toastRoot = null;
let _unsubMeta = null;
let _lastMetaTs = null;
let _refreshing = false;
let _pendingRefresh = false;
let _baselineDone = false;

const LS_BROWSER_ENABLED = 'notif:browser_enabled';
const TOAST_DURATION_MS = 9000;

// ── Helpers de catálogo ──────────────────────────────────────────────────────
function _stockTotalVariedad(c, globalCont) {
  const u  = Number(c.unidades) || 0;
  const r  = Number(c.restante) || 0;
  const cc = (Number(c.contenido) > 0) ? Number(c.contenido) : Number(globalCont) || 0;
  return u * cc + r;
}

function _unidadProducto(p) {
  if (!p) return { sg: 'unidad', pl: 'unidades' };
  const esConjunto = (p.es_conjunto === true || p.es_conjunto === 1);
  if (!esConjunto) return { sg: 'unidad', pl: 'unidades' };
  const um = (p.conjunto_unidad_medida || '').toLowerCase();
  if (um === 'metros' || um === 'metro') return { sg: 'metro', pl: 'metros' };
  const tipo = (p.conjunto_tipo || '').toLowerCase();
  if (tipo === 'rollo') return { sg: 'rollo', pl: 'rollos' };
  if (tipo === 'pack')  return { sg: 'pack',  pl: 'packs' };
  if (tipo === 'caja')  return { sg: 'caja',  pl: 'cajas' };
  if (tipo === 'bobina') return { sg: 'bobina', pl: 'bobinas' };
  if (tipo === 'bolsa') return { sg: 'bolsa', pl: 'bolsas' };
  return { sg: 'unidad', pl: 'unidades' };
}

function _stockEfectivo(p) {
  if (p && (p.es_conjunto === true || p.es_conjunto === 1)) {
    const variedades = Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [];
    if (variedades.length > 0) {
      const globalCont = Number(p.conjunto_contenido || 0);
      const total = variedades.reduce((acc, c) => acc + _stockTotalVariedad(c, globalCont), 0);
      return total;
    }
    return Number(p.conjunto_total || 0);
  }
  return Number(p.stock) || 0;
}

function _alertasProducto(p) {
  const out = [];
  // -1 = ilimitado/servicio: nunca alertar.
  const stockRaw = Number(p.stock);
  if (stockRaw === -1) return out;

  const nombreBase = p.nombre || '(sin nombre)';
  const esConjunto = p && (p.es_conjunto === true || p.es_conjunto === 1);
  const variedades = esConjunto && Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [];

  // 1) Alerta por variedad (cada color con su propio stock_min).
  // El stock_min de la variedad se compara contra el contador de
  // packs/rollos/cajas/unidades que el usuario ve en el editor (`c.unidades`),
  // NO contra el total en unidades sueltas. Así "1 pack mínimo" funciona
  // sin importar cuántas unidades trae cada pack, y se adapta a cualquier
  // tipo de producto (rollo, pack, caja, unidad, metro).
  if (variedades.length > 0) {
    const globalCont = Number(p.conjunto_contenido || 0);
    for (const c of variedades) {
      const sMinVar = Number(c.stock_min) || 0;
      if (!(sMinVar > 0)) continue;
      const cantidadVar = Number(c.unidades) || 0;
      if (cantidadVar > sMinVar) continue;
      const sMaxVar = Number(c.stock_max) || 0;
      const sugerencia = sMaxVar > sMinVar ? Math.max(0, sMaxVar - cantidadVar) : null;
      const totalUnitsVar = _stockTotalVariedad(c, globalCont);
      const u = _unidadProducto(p);
      out.push({
        key: p.doc_id + '|var:' + (c.color || ''),
        doc_id: p.doc_id,
        variedad: c.color || '',
        nombre: nombreBase + ' · ' + (c.color || ''),
        codigo: p.codigo || '',
        rubro: p.rubro || '',
        sub_rubro: p.sub_rubro || '',
        marca: p.marca || '',
        stock: cantidadVar,
        stock_total_unidades: totalUnitsVar,
        stock_min: sMinVar,
        stock_max: sMaxVar || null,
        unidad_label: cantidadVar === 1 ? u.sg : u.pl,
        sugerencia,
        critico: cantidadVar === 0,
        producto: p,
      });
    }
  }

  // 2) Alerta global del producto (stock_min a nivel producto)
  const stockMin = Number(p.stock_min) || 0;
  if (stockMin > 0) {
    const stock = _stockEfectivo(p);
    if (stock <= stockMin) {
      const stockMax = Number(p.stock_max) || 0;
      const sugerencia = stockMax > stockMin ? Math.max(0, stockMax - stock) : null;
      out.push({
        key: p.doc_id,
        doc_id: p.doc_id,
        variedad: null,
        nombre: nombreBase,
        codigo: p.codigo || '',
        rubro: p.rubro || '',
        sub_rubro: p.sub_rubro || '',
        marca: p.marca || '',
        stock,
        stock_min: stockMin,
        stock_max: stockMax || null,
        sugerencia,
        critico: stock === 0,
        producto: p,
      });
    }
  }

  return out;
}

function _calcularAlertas(productos) {
  const out = [];
  for (const p of productos) {
    const arr = _alertasProducto(p);
    for (const a of arr) out.push(a);
  }
  // Más crítico primero (stock = 0), luego por mayor déficit relativo
  out.sort((a, b) => {
    if (a.critico !== b.critico) return a.critico ? -1 : 1;
    const da = (a.stock_min - a.stock) / Math.max(a.stock_min, 1);
    const db = (b.stock_min - b.stock) / Math.max(b.stock_min, 1);
    return db - da;
  });
  return out;
}

// ── Fetch del catálogo ───────────────────────────────────────────────────────
async function _fetchCatalogo() {
  const snap = await getDocs(query(collection(_db, 'catalogo'), orderBy('nombre')));
  return snap.docs.map(d => ({ doc_id: d.id, ...d.data() }));
}

async function _refrescar({ silent = false } = {}) {
  if (_refreshing) { _pendingRefresh = true; return; }
  _refreshing = true;
  try {
    const productos = await _fetchCatalogo();
    _productos = productos;
    const alertas = _calcularAlertas(productos);
    // Cada alerta tiene una key única (doc_id o doc_id|var:Color) para
    // distinguir aviso global del producto de los avisos por variedad.
    const nuevasIds = new Set(alertas.map(a => a.key));
    const esInicial = !_baselineDone;

    if (!silent) {
      // Diff: dispara cuando (a) la alerta es nueva o (b) el stock bajó más
      // que la última vez que avisamos. Así, si el usuario edita un producto
      // que ya estaba en alerta y vende otro item, vuelve a saltar el aviso.
      const aDisparar = alertas.filter(a => {
        const prevStock = _lastStockPorKey.get(a.key);
        if (prevStock === undefined) return true;        // alerta nueva
        if (Number(a.stock) < Number(prevStock)) return true; // bajó más
        return false;
      });
      console.info(`[notificaciones] refresh → ${alertas.length} activas, ${aDisparar.length} a notificar`);
      for (const a of aDisparar) _mostrarToast(a);
      if (aDisparar.length && _browserEnabled() && _permPermitida()) {
        _mostrarNotifNavegador(aDisparar);
      }
    } else if (esInicial && alertas.length > 0 && _browserEnabled() && _permPermitida()) {
      // Carga inicial: si ya hay alertas pendientes y el usuario activó las
      // notificaciones, mostramos un toast + notif resumen para confirmar que
      // hay cosas por rellenar. Sin esto, sólo avisaríamos las que cambian
      // DESPUÉS de abrir la página.
      _mostrarToastResumen(alertas);
      _mostrarNotifResumen(alertas);
    }

    _activeIds = nuevasIds;
    // Actualizar registro: para alertas vigentes guardamos el stock actual;
    // las que dejaron de alertar (subió el stock o sacaron el mín) se borran
    // para que si vuelven a bajar disparen de cero.
    const nuevaMapa = new Map();
    for (const a of alertas) nuevaMapa.set(a.key, Number(a.stock) || 0);
    _lastStockPorKey = nuevaMapa;
    _baselineDone = true;
    _emitChange(alertas);
  } catch (err) {
    console.warn('[notificaciones] error refrescando catálogo:', err);
  } finally {
    _refreshing = false;
    if (_pendingRefresh) {
      _pendingRefresh = false;
      setTimeout(() => _refrescar({ silent: false }), 100);
    }
  }
}

// ── Suscriptores externos ────────────────────────────────────────────────────
function _emitChange(alertas) {
  for (const cb of _listeners) {
    try { cb(alertas); } catch (e) { console.warn('[notificaciones] listener error:', e); }
  }
}

// ── Permiso navegador ────────────────────────────────────────────────────────
export function notificacionesSoportadas() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function permisoNotificacion() {
  if (!notificacionesSoportadas()) return 'unsupported';
  return Notification.permission;
}

export async function pedirPermisoNotificaciones() {
  if (!notificacionesSoportadas()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    const r = await Notification.requestPermission();
    if (r === 'granted') localStorage.setItem(LS_BROWSER_ENABLED, '1');
    return r;
  } catch (e) {
    return Notification.permission;
  }
}

function _permPermitida() {
  return notificacionesSoportadas() && Notification.permission === 'granted';
}

export function notificacionesNavegadorActivas() {
  return _browserEnabled() && _permPermitida();
}

function _browserEnabled() {
  return localStorage.getItem(LS_BROWSER_ENABLED) === '1';
}

export function setNotificacionesNavegador(activas) {
  if (activas) localStorage.setItem(LS_BROWSER_ENABLED, '1');
  else localStorage.removeItem(LS_BROWSER_ENABLED);
}

function _mostrarNotifNavegador(alertas) {
  try {
    if (alertas.length === 1) {
      const a = alertas[0];
      const unidad = a.unidad_label ? ' ' + a.unidad_label : '';
      const n = new Notification('Stock bajo · ' + a.nombre, {
        body: `Quedan ${_fmt(a.stock)}${unidad} (mínimo ${_fmt(a.stock_min)}). Tocá para rellenar.`,
        icon: '/libreria-liceo-512.png',
        tag: 'stock-' + a.key,
      });
      n.onclick = () => { window.focus(); _irACatalogo(a.doc_id); n.close(); };
    } else {
      const n = new Notification(`${alertas.length} productos en stock bajo`, {
        body: alertas.slice(0, 4).map(a => `· ${a.nombre} (${_fmt(a.stock)}/${_fmt(a.stock_min)})`).join('\n'),
        icon: '/libreria-liceo-512.png',
        tag: 'stock-multi',
      });
      n.onclick = () => { window.focus(); _irANotificaciones(); n.close(); };
    }
  } catch (e) {
    console.warn('[notificaciones] error mostrando notificación del navegador:', e);
  }
}

function _mostrarNotifResumen(alertas) {
  if (!_permPermitida()) return;
  try {
    const n = new Notification(`Stock bajo: ${alertas.length} ${alertas.length === 1 ? 'producto' : 'productos'}`, {
      body: alertas.slice(0, 4).map(a => `· ${a.nombre} (${_fmt(a.stock)}/${_fmt(a.stock_min)})`).join('\n') + (alertas.length > 4 ? `\n... y ${alertas.length - 4} más` : ''),
      icon: '/libreria-liceo-512.png',
      tag: 'stock-resumen-inicial',
    });
    n.onclick = () => { window.focus(); _irANotificaciones(); n.close(); };
  } catch (e) {
    console.warn('[notificaciones] error mostrando resumen:', e);
  }
}

export function mostrarNotificacionDePrueba() {
  if (!_permPermitida()) return false;
  try {
    const n = new Notification('Notificaciones activadas ✓', {
      body: 'Vas a recibir un aviso cada vez que un producto baje del stock mínimo.',
      icon: '/libreria-liceo-512.png',
      tag: 'stock-prueba',
    });
    n.onclick = () => { window.focus(); _irANotificaciones(); n.close(); };
    return true;
  } catch (e) {
    console.warn('[notificaciones] error en prueba:', e);
    return false;
  }
}

// ── Toasts in-app ────────────────────────────────────────────────────────────
function _ensureToastRoot() {
  if (_toastRoot && document.body.contains(_toastRoot)) return _toastRoot;
  _toastRoot = document.createElement('div');
  _toastRoot.id = 'notifToastRoot';
  _toastRoot.style.cssText = [
    'position:fixed',
    'top:14px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:9000',
    'display:flex',
    'flex-direction:column',
    'gap:10px',
    'pointer-events:none',
    'width:min(440px, calc(100vw - 28px))',
  ].join(';');
  document.body.appendChild(_toastRoot);
  return _toastRoot;
}

function _fmt(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

function _mostrarToast(a) {
  const root = _ensureToastRoot();
  const toast = document.createElement('div');
  toast.setAttribute('role', 'alert');
  toast.style.cssText = [
    'pointer-events:auto',
    'background:#ffffff',
    `border-left:4px solid ${a.critico ? '#c62828' : '#f57c00'}`,
    'border-radius:12px',
    'box-shadow:0 6px 24px rgba(0,0,0,0.18)',
    'padding:12px 14px',
    'display:flex',
    'align-items:flex-start',
    'gap:10px',
    'font-family:Inter,system-ui,sans-serif',
    'color:#1c1e21',
    'transform:translateY(-12px)',
    'opacity:0',
    'transition:transform 0.25s ease, opacity 0.25s ease',
  ].join(';');

  toast.innerHTML = `
    <span class="material-icons" style="color:${a.critico ? '#c62828' : '#f57c00'};font-size:22px;flex-shrink:0">${a.critico ? 'error' : 'warning'}</span>
    <div style="flex:1;min-width:0">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${a.critico ? '#c62828' : '#b45309'};margin-bottom:2px">
        ${a.critico ? 'Sin stock' : 'Stock bajo'}
      </div>
      <div style="font-size:14px;font-weight:700;line-height:1.3;word-wrap:break-word">${_escape(a.nombre)}</div>
      <div style="font-size:12px;color:#65676b;margin-top:3px">
        Quedan <b style="color:${a.critico ? '#c62828' : '#b45309'}">${_fmt(a.stock)}${a.unidad_label ? ' ' + a.unidad_label : ''}</b>
        <span style="color:#9ca3af">/ mín ${_fmt(a.stock_min)}</span>
        ${a.sugerencia ? ` · <span style="color:#7b3fa6">pedir ~${_fmt(a.sugerencia)}</span>` : ''}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button data-act="rellenar" style="background:#7b3fa6;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
          Rellenar
        </button>
        <button data-act="cerrar" style="background:transparent;color:#65676b;border:1px solid #e4e6eb;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
          Cerrar
        </button>
      </div>
    </div>
    <button data-act="x" aria-label="Cerrar" style="background:none;border:none;color:#9ca3af;cursor:pointer;padding:2px;line-height:1;flex-shrink:0">
      <span class="material-icons" style="font-size:18px">close</span>
    </button>
  `;

  let timer = setTimeout(() => _cerrarToast(toast), TOAST_DURATION_MS);
  toast.addEventListener('mouseenter', () => { clearTimeout(timer); });
  toast.addEventListener('mouseleave', () => { timer = setTimeout(() => _cerrarToast(toast), TOAST_DURATION_MS); });

  toast.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'rellenar') {
      _cerrarToast(toast);
      _irACatalogo(a.doc_id);
    } else {
      _cerrarToast(toast);
    }
  });

  root.appendChild(toast);
  // Animar entrada
  requestAnimationFrame(() => {
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';
  });
}

function _cerrarToast(toast) {
  if (!toast || !toast.parentNode) return;
  toast.style.transform = 'translateY(-12px)';
  toast.style.opacity = '0';
  setTimeout(() => { toast.remove(); }, 250);
}

// Toast resumen: una sola tarjeta con cuántos productos hay y un botón a la
// página de notificaciones. Se usa al cargar la app, sin spam-ear con uno
// por producto.
function _mostrarToastResumen(alertas) {
  const root = _ensureToastRoot();
  const toast = document.createElement('div');
  toast.setAttribute('role', 'alert');
  toast.style.cssText = [
    'pointer-events:auto',
    'background:#ffffff',
    'border-left:4px solid #7b3fa6',
    'border-radius:12px',
    'box-shadow:0 6px 24px rgba(0,0,0,0.18)',
    'padding:12px 14px',
    'display:flex',
    'align-items:center',
    'gap:10px',
    'font-family:Inter,system-ui,sans-serif',
    'color:#1c1e21',
    'transform:translateY(-12px)',
    'opacity:0',
    'transition:transform 0.25s ease, opacity 0.25s ease',
  ].join(';');
  const criticas = alertas.filter(a => a.critico).length;
  toast.innerHTML = `
    <span class="material-icons" style="color:#7b3fa6;font-size:24px;flex-shrink:0">inventory_2</span>
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;font-weight:700;color:#1c1e21">${alertas.length} ${alertas.length === 1 ? 'producto' : 'productos'} con stock bajo</div>
      <div style="font-size:11.5px;color:#65676b;margin-top:2px">
        ${criticas > 0 ? `<b style="color:#c62828">${criticas} sin stock</b> · ` : ''}revisá la lista para rellenar.
      </div>
    </div>
    <button data-act="ver" style="background:#7b3fa6;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Ver</button>
    <button data-act="x" aria-label="Cerrar" style="background:none;border:none;color:#9ca3af;cursor:pointer;padding:2px;line-height:1;flex-shrink:0">
      <span class="material-icons" style="font-size:18px">close</span>
    </button>
  `;
  let timer = setTimeout(() => _cerrarToast(toast), TOAST_DURATION_MS + 3000);
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', () => { timer = setTimeout(() => _cerrarToast(toast), TOAST_DURATION_MS); });
  toast.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.act === 'ver') { _cerrarToast(toast); _irANotificaciones(); }
    else _cerrarToast(toast);
  });
  root.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';
  });
}

function _escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ── Navegación (delegada a main.js) ──────────────────────────────────────────
function _irACatalogo(docId) {
  window.__pendingCatalogoOpen = docId;
  if (typeof window.navigateToPage === 'function') {
    window.navigateToPage('catalogo');
  } else {
    location.hash = '#catalogo';
  }
}

function _irANotificaciones() {
  if (typeof window.navigateToPage === 'function') {
    window.navigateToPage('notificaciones');
  }
}

// ── API pública ──────────────────────────────────────────────────────────────
export function initNotifications(db) {
  if (_initialized) return;
  _initialized = true;
  _db = db;

  // 1. Carga inicial (silenciosa: no spam-ear al login)
  _refrescar({ silent: true });

  // 2. Escuchar cambios del catálogo via meta-doc
  try {
    _unsubMeta = onSnapshot(doc(_db, 'config', 'catalogo_meta'), (snap) => {
      if (!snap.exists()) return;
      const ts = snap.data().last_updated;
      if (_lastMetaTs === null) { _lastMetaTs = ts; return; }
      if (ts === _lastMetaTs) return;
      _lastMetaTs = ts;
      _refrescar({ silent: false });
    }, (err) => console.warn('[notificaciones] meta listener:', err));
  } catch (e) {
    console.warn('[notificaciones] no se pudo subscribir a meta:', e);
  }
}

export function obtenerAlertasActivas() {
  return _calcularAlertas(_productos);
}

export function onAlertasCambian(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

export async function refrescarAlertas() {
  await _refrescar({ silent: true });
  return obtenerAlertasActivas();
}

export function irACatalogoYAbrir(docId) {
  _irACatalogo(docId);
}
