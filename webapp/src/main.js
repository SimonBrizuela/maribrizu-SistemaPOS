import { db } from './firebase.js';
import { invalidateCacheByPrefix, peekCacheValue } from './cache.js';
import { prewarmStore, ensureCollections, prewarmRest, onStoreChange, hydrateStore } from './store.js';
import { loadControlConfig, loadBalanceConfig, loadComprasConfig, loadDiasMes } from './config.js';
import './styles/login.css';
import './styles/skeleton.css';
import { renderLogin } from './pages/login.js';
import { hasSessionHint, onAuthReady, isLoginLink, completeLinkSignIn, logout } from './auth.js';
import { initTheme, toggleTheme, getTheme } from './theme.js';
import { initNotifications, obtenerAlertasActivas, onAlertasCambian, refrescarAlertas } from './notifications.js';
import { initConsumiblesWatcher } from './consumibles_watcher.js';
import { initPedidosWatcher, onPedidosCambian } from './pedidos_watcher.js';
import { initCalendarioBadge, proximosEventos, textoSobre } from './pages/calendario_core.js';
import { renderSkeleton } from './skeletons.js';
import { initAutostart, getAutostart, setAutostart, isTauriApp } from './autostart.js';
import { initUpdater } from './updater.js';

// ── Diagnóstico de carga (solo dentro del .exe/Tauri) ──
// Espeja los logs [store]/[config]/[cache] a un archivo (logs/webapp.log en el
// AppData de la app) para medir la carga desde afuera sin abrir DevTools. Buffer
// síncrono hasta que carga el plugin, así no se pierde ningún timing del arranque.
if (window.__TAURI_INTERNALS__) {
  const _logBuf = [];
  const _origLog = console.log.bind(console);
  let _logSink = (m) => _logBuf.push(m);
  console.log = (...a) => {
    _origLog(...a);
    let m; try { m = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); } catch (_) { m = String(a[0]); }
    if (/^\[(store|config|cache|perf|notifications|snap|page)\]/.test(m)) _logSink(m);
  };
  import('@tauri-apps/plugin-log').then(({ info }) => {
    _logBuf.forEach((m) => info(m).catch(() => {}));
    _logBuf.length = 0;
    _logSink = (m) => info(m).catch(() => {});
  }).catch(() => {});
}

// ── Estado global ──
let currentPage = 'dashboard';

// Cada página se carga on-demand con dynamic import.
// `cacheKey` permite saltarse el spinner si hay datos ya cacheados.
// `needs` lista las colecciones del store que esta página necesita: se
// arrancan al navegar (ensureCollections). Páginas sin `needs` no disparan
// listeners — el background prewarmRest() las trae después igual.
// `loader` resuelve al módulo; la función render se toma de `render` en ese módulo.
const pages = {
  dashboard:       { title: 'Dashboard',               loader: () => import('./pages/dashboard.js'),        render: 'renderDashboard',       cacheKey: 'dashboard:ventas',       needs: ['ventas_por_dia', 'ventas', 'historial_diario', 'catalogo'] },
  control_total:   { title: 'Control Total',           loader: () => import('./pages/control_total.js'),    render: 'renderControlTotal',    cacheKey: null,                      needs: ['ventas_por_dia', 'ventas', 'gastos', 'catalogo'] },
  ventas:          { title: 'Ventas',                  loader: () => import('./pages/ventas.js'),           render: 'renderVentas',          cacheKey: 'ventas:lista',           needs: ['ventas_por_dia', 'ventas'] },
  productos:       { title: 'Productos Más Vendidos',  loader: () => import('./pages/productos.js'),        render: 'renderProductos',       cacheKey: 'productos:mas_vendidos', needs: ['ventas_por_dia'] },
  historial:       { title: 'Historial Diario',        loader: () => import('./pages/historial.js'),        render: 'renderHistorial',       cacheKey: 'historial:diario',       needs: ['ventas_por_dia', 'ventas'] },
  cierres:         { title: 'Cierres de Caja',         loader: () => import('./pages/cierres.js'),          render: 'renderCierres',         cacheKey: 'cierres:caja',           needs: ['cierres_caja', 'caja_activa', 'ventas_por_dia', 'catalogo', 'gastos'] },
  resumenes:       { title: 'Resúmenes Mensuales',     loader: () => import('./pages/resumenes.js'),        render: 'renderResumenes',       cacheKey: 'resumenes:mensuales',    needs: ['ventas_por_dia', 'ventas'] },
  calendario:      { title: 'Calendario',              loader: () => import('./pages/calendario.js'),       render: 'renderCalendario',      cacheKey: null,                      needs: [] },
  catalogo:        { title: 'Catálogo de Productos',   loader: () => import('./pages/catalogo.js'),         render: 'renderCatalogo',        cacheKey: null,                      needs: ['catalogo', 'ventas_por_dia', 'inventario_resumen'] },
  turnos:          { title: 'Turnos / Cajeros',        loader: () => import('./pages/turnos.js'),           render: 'renderTurnos',          cacheKey: null,                      needs: [] },
  articulos_unicos:{ title: 'Artículos con Variantes', loader: () => import('./pages/articulos_unicos.js'), render: 'renderArticulosUnicos', cacheKey: null,                      needs: ['catalogo'] },
  promociones:     { title: 'Promociones',             loader: () => import('./pages/promociones.js'),      render: 'renderPromociones',     cacheKey: null,                      needs: ['catalogo'] },
  facturas:        { title: 'Facturación AFIP',        loader: () => import('./pages/facturas.js'),         render: 'renderFacturas',        cacheKey: null,                      needs: ['ventas', 'catalogo'] },
  perfiles:        { title: 'Perfiles ARCA',           loader: () => import('./pages/perfiles.js'),         render: 'renderPerfiles',        cacheKey: null,                      needs: [] },
  clientes:        { title: 'Perfiles de Clientes',    loader: () => import('./pages/clientes.js'),         render: 'renderClientes',        cacheKey: null,                      needs: [] },
  fiados:          { title: 'Fiados',                  loader: () => import('./pages/fiados.js'),           render: 'renderFiados',          cacheKey: null,                      needs: ['fiado_clientes', 'fiado_items', 'fiado_pagos', 'catalogo'] },
  observaciones:   { title: 'Observaciones',           loader: () => import('./pages/observaciones.js'),    render: 'renderObservaciones',   cacheKey: null,                      needs: [] },
  presupuestos:    { title: 'Presupuestos',            loader: () => import('./pages/presupuestos.js'),     render: 'renderPresupuestos',    cacheKey: null,                      needs: ['catalogo'] },
  lab_productos:   { title: 'Productos Madre',         loader: () => import('./pages/lab_productos_madre.js'), render: 'renderLabProductos', cacheKey: null,                      needs: ['catalogo'] },
  pcs:             { title: 'Estado de PCs',           loader: () => import('./pages/pcs.js'),              render: 'renderPcs',             cacheKey: null,                      needs: [] },
  notificaciones:  { title: 'Notificaciones',          loader: () => import('./pages/notificaciones.js'),   render: 'renderNotificaciones',  cacheKey: null,                      needs: ['catalogo'] },
  centro_compras:  { title: 'Centro de Compras',        loader: () => import('./pages/centro_compras.js'),   render: 'renderCentroCompras',   cacheKey: null,                      needs: ['catalogo', 'ventas_por_dia'] },
  pedidos_tienda:  { title: 'Pedidos de la Tienda',     loader: () => import('./pages/pedidos_tienda.js'),   render: 'renderPedidosTienda',   cacheKey: null,                      needs: [] },
  tienda_catalogo: { title: 'Catálogo de la Tienda',    loader: () => import('./pages/tienda_catalogo.js'),  render: 'renderTiendaCatalogo',  cacheKey: null,                      needs: ['catalogo'] },
  tienda_ajustes:  { title: 'Configuración de la Tienda', loader: () => import('./pages/tienda_ajustes.js'), render: 'renderTiendaAjustes',   cacheKey: null,                      needs: ['catalogo'] },
};

// Caché de módulos ya descargados (evita repetir import() tras la primera carga)
const pageModules = {};
async function loadPageModule(page) {
  if (!pageModules[page]) pageModules[page] = await pages[page].loader();
  return pageModules[page];
}

// Reload automático cuando un chunk lazy ya no existe en el deploy actual
// (sesión vieja en caché + deploy nuevo invalidó los hashes de los assets).
// Se limita a un reload por sesión para evitar loops si el error es por otra causa.
function reloadIfStaleChunk(err) {
  const msg = String((err && (err.message || err)) || '');
  const isChunkError =
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /MIME type of ("|')text\/html/i.test(msg);
  if (!isChunkError) return false;
  if (sessionStorage.getItem('staleChunkReloaded') === '1') return false;
  sessionStorage.setItem('staleChunkReloaded', '1');
  location.reload();
  return true;
}
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  reloadIfStaleChunk(event.payload || event);
});

// Páginas con tablas que suelen necesitar scroll horizontal en mobile
const PAGES_CON_TABLA_ANCHA = new Set([
  'catalogo', 'historial', 'ventas', 'cierres', 'resumenes',
  'productos', 'articulos_unicos', 'clientes', 'observaciones',
  'facturas', 'perfiles', 'turnos'
]);

// ── Aviso "Nuevo" del Centro de Compras ──
// Se muestra en el sidebar hasta que el usuario entra por primera vez a la
// página (por PC/navegador); después no se avisa más.
const LS_CC_NUEVO = 'cc:nuevo_visto';
function initAvisoCentroCompras() {
  const badge = document.getElementById('navCCNuevo');
  if (badge && !localStorage.getItem(LS_CC_NUEVO)) badge.style.display = '';
  refrescarBadgesGrupo();
}
function marcarCentroComprasVisto() {
  if (localStorage.getItem(LS_CC_NUEVO)) return;
  try { localStorage.setItem(LS_CC_NUEVO, '1'); } catch (e) { /* modo privado */ }
  const badge = document.getElementById('navCCNuevo');
  if (badge) badge.style.display = 'none';
  refrescarBadgesGrupo();
  renderPinned();
}

// ── Navegación ──
// `abrirGrupo: false` para entradas que no viven en el árbol de secciones (los
// accesos rápidos): ir por ahí no tiene que desplegar la sección de origen.
function navigate(page, { abrirGrupo = true } = {}) {
  currentPage = page;
  localStorage.setItem('lastPage', page);
  if (page === 'centro_compras') marcarCentroComprasVisto();
  // Sidebar links
  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.page === page);
  });
  // Bottom nav
  document.querySelectorAll('.bottom-nav-item').forEach(l => {
    l.classList.toggle('active', l.dataset.page === page);
  });
  document.getElementById('pageTitle').textContent = pages[page].title;
  // Refresh hint solo en páginas con tabla ancha (y solo mobile por CSS)
  const hint = document.querySelector('.refresh-hint');
  if (hint) hint.classList.toggle('show', PAGES_CON_TABLA_ANCHA.has(page));
  // Abrir el grupo que contiene la página activa
  if (abrirGrupo) openGroupForPage(page);
  else refrescarBadgesGrupo();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  loadPage(page);
}

// ── Grupos colapsables del sidebar ──
// Acordeón exclusivo: sólo una sección abierta a la vez. Con las 4 abiertas la
// lista mide más que la pantalla y siempre queda algo cortado; así el menú
// entra completo sin scrollear.
const LS_NAV_GROUP = 'nav:openGroup';

function leerGrupoAbierto() {
  try {
    const uno = localStorage.getItem(LS_NAV_GROUP);
    if (uno) return uno;
    // Compat con el formato viejo (array de grupos abiertos): se queda con el último
    const viejo = JSON.parse(localStorage.getItem('nav:openGroups') || '[]');
    return viejo.length ? viejo[viejo.length - 1] : null;
  } catch (_) { return null; }
}

function aplicarGrupoAbierto(groupId, persistir = true) {
  document.querySelectorAll('.nav-group').forEach(group => {
    const abrir = group.dataset.group === groupId;
    group.querySelector('.nav-group-items')?.classList.toggle('open', abrir);
    group.querySelector('.nav-group-arrow')?.classList.toggle('rotated', abrir);
  });
  if (persistir) {
    try {
      if (groupId) localStorage.setItem(LS_NAV_GROUP, groupId);
      else localStorage.removeItem(LS_NAV_GROUP);
      localStorage.removeItem('nav:openGroups');
    } catch (_) { /* modo privado */ }
  }
  refrescarBadgesGrupo();
}

function initNavGroups() {
  aplicarGrupoAbierto(leerGrupoAbierto(), false);

  document.querySelectorAll('.nav-group').forEach(group => {
    const header = group.querySelector('.nav-group-header');
    const items  = group.querySelector('.nav-group-items');
    if (!header || !items) return;
    header.addEventListener('click', () => {
      // En rail el icono no colapsa nada: abre el panel lateral (para touch y
      // para quien no llega con el hover).
      if (enModoRail()) { abrirRailFlyout(group); return; }
      const abriendo = !items.classList.contains('open');
      aplicarGrupoAbierto(abriendo ? group.dataset.group : null);
    });
  });
}

function openGroupForPage(page) {
  const link = document.querySelector(`.nav-group .nav-link[data-page="${page}"]`);
  const group = link?.closest('.nav-group');
  if (!group) return;
  const items = group.querySelector('.nav-group-items');
  if (!items.classList.contains('open')) aplicarGrupoAbierto(group.dataset.group);
}

// Badge agregado del grupo: mientras está cerrado suma los avisos de sus ítems.
// Sin esto, "Productos" colapsado esconde las 99 notificaciones sin dar señal.
function refrescarBadgesGrupo() {
  document.querySelectorAll('.nav-group').forEach(group => {
    const header = group.querySelector('.nav-group-header');
    const items  = group.querySelector('.nav-group-items');
    if (!header || !items) return;

    // En rail los ítems no se ven nunca: el badge del grupo es la única señal,
    // así que se muestra siempre (no sólo con la sección cerrada).
    const abierto = !enModoRail() && items.classList.contains('open');
    let total = 0, hayChip = false;
    items.querySelectorAll('.nav-badge, .nav-nuevo').forEach(b => {
      if (b.style.display === 'none') return;
      const n = parseInt(String(b.textContent).replace(/\D/g, ''), 10);
      if (Number.isFinite(n) && n > 0) total += n;
      else hayChip = true;
    });

    let badge = header.querySelector('.nav-group-badge');
    if (abierto || (total === 0 && !hayChip)) { badge?.remove(); return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-group-badge';
      header.insertBefore(badge, header.querySelector('.nav-group-arrow'));
    }
    badge.classList.toggle('dot', total === 0);
    badge.textContent = total > 0 ? (total > 99 ? '99+' : String(total)) : '';
  });
}

// ── Accesos rápidos ──
// Páginas fijadas arriba del menú. Se fijan/quitan con clic derecho sobre
// cualquier ítem. Los ítems se clonan del original, así heredan icono, badge y
// estado de aviso sin duplicar lógica (se les sacan los id para no repetirlos).
const LS_PINNED = 'nav:pinned';
const LS_PINNED_SEED = 'nav:pinned:seed';
const PINNED_MAX = 6;
const PINNED_DEFAULT = ['control_total', 'catalogo', 'ventas'];
// Accesos rápidos FIJOS: siempre arriba de todo y no se pueden quitar con clic
// derecho. Fiados es una cuenta abierta con plata de por medio — tiene que
// estar a un clic desde cualquier pantalla, no escondido en una sección.
// No ocupan lugar del tope de 6 que puede fijar el usuario.
const PINNED_FIJOS = ['fiados'];

function getPinned() {
  try {
    return JSON.parse(localStorage.getItem(LS_PINNED) || '[]')
      .filter(p => pages[p] && !PINNED_FIJOS.includes(p));
  } catch (_) { return []; }
}

/** Orden final de los accesos rápidos: primero los fijos, después los del usuario. */
function listaPinned() {
  return [...PINNED_FIJOS.filter(p => pages[p]), ...getPinned()];
}

function setPinned(lista) {
  try { localStorage.setItem(LS_PINNED, JSON.stringify(lista.slice(0, PINNED_MAX))); } catch (_) {}
  renderPinned();
}

function togglePinned(page) {
  if (!pages[page]) return;
  if (PINNED_FIJOS.includes(page)) return;   // fijo: no se quita
  const lista = getPinned();
  const i = lista.indexOf(page);
  if (i >= 0) lista.splice(i, 1);
  else if (lista.length < PINNED_MAX) lista.push(page);
  else return; // tope alcanzado
  setPinned(lista);
}

function renderPinned() {
  const host = document.getElementById('navPinned');
  const cont = document.getElementById('navPinnedItems');
  const links = document.getElementById('navLinks');
  if (!host || !cont) return;

  cont.innerHTML = '';
  listaPinned().forEach(page => {
    const src = document.querySelector(`.nav-group .nav-link[data-page="${page}"]`);
    if (!src) return;
    const clon = src.cloneNode(true);
    clon.classList.add('nav-link-pin');
    clon.classList.toggle('nav-link-pin-fijo', PINNED_FIJOS.includes(page));
    clon.classList.toggle('active', page === currentPage);
    clon.removeAttribute('id');
    clon.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    cont.appendChild(clon);
  });

  const hay = cont.children.length > 0;
  host.style.display = hay ? '' : 'none';
  links?.classList.toggle('has-pinned', hay);
}

function initPinned() {
  // Semilla la primera vez: si arrancara vacío, la función sería invisible.
  // Se quita entera con clic derecho y no vuelve a sembrarse.
  try {
    if (!localStorage.getItem(LS_PINNED_SEED)) {
      localStorage.setItem(LS_PINNED_SEED, '1');
      if (!localStorage.getItem(LS_PINNED)) {
        localStorage.setItem(LS_PINNED, JSON.stringify(PINNED_DEFAULT));
      }
    }
  } catch (_) { /* modo privado */ }

  const host = document.getElementById('navPinned');
  host?.addEventListener('click', e => {
    const a = e.target.closest('.nav-link');
    if (!a) return;
    e.preventDefault();
    navigate(a.dataset.page, { abrirGrupo: false });
    closeSidebar();
  });

  // Clic derecho en cualquier ítem del menú → fijar / quitar
  document.getElementById('navLinks')?.addEventListener('contextmenu', e => {
    const a = e.target.closest('.nav-link');
    if (!a || !a.dataset.page) return;
    e.preventDefault();
    togglePinned(a.dataset.page);
  });

  renderPinned();
}

// Generación de carga. Cada loadPage se queda con la suya; si mientras estaba
// esperando datos arrancó otra, la vieja se da cuenta y no toca nada global.
let _loadGen = 0;

/**
 * Reemplaza #pageContent por un nodo nuevo, vacío y con los mismos id/clases.
 *
 * Las páginas reciben el contenedor por parámetro y varias escriben en él
 * DESPUÉS de esperar sus datos (catálogo tarda segundos: pinta su shell, hace
 * `await cargarDatos()` y recién ahí `renderShell()`). Si en el medio el
 * usuario se fue a otra página, esa escritura tardía pisaba la pantalla nueva
 * — se veía como que la app "salta sola" a la página con la que entraste.
 *
 * Al cambiar el nodo, el render viejo conserva la referencia al contenedor
 * anterior, que ya está fuera del DOM: sigue escribiendo, pero sobre algo
 * invisible que después se descarta. De paso, las suscripciones que se
 * autolimpian con `document.body.contains(container)` (catálogo, fiados) se
 * dan de baja solas.
 */
function nuevoPageContent() {
  const viejo = document.getElementById('pageContent');
  if (!viejo) return null;
  const fresco = viejo.cloneNode(false);   // mismo tag, id y clases; sin hijos
  viejo.replaceWith(fresco);
  return fresco;
}

async function loadPage(page, forceRefresh = false, fromLiveUpdate = false) {
  const gen = ++_loadGen;
  // En refrescos en vivo se reusa el nodo actual: cambiarlo vaciaría la
  // pantalla y se vería un parpadeo con cada venta que entra. Si el usuario
  // navega mientras ese refresco corre, el próximo loadPage sí cambia el nodo
  // y la escritura tardía cae en el viejo, ya desconectado.
  const content = fromLiveUpdate
    ? document.getElementById('pageContent')
    : nuevoPageContent();
  if (!content) return;

  // Si la página anterior expuso un cleanup (ej. pcs.js cancela onSnapshot), ejecutarlo
  // La nueva página la vuelve a inicializar si la necesita.
  if (typeof window._pcsCleanup === 'function') {
    try { window._pcsCleanup(); } catch {}
  }

  // Arrancar listeners realtime que esta página necesita (idempotente).
  // Si ya están corriendo, no-op. Si no, dispara su primer snapshot — getCached()
  // de la página espera al waiter del store en vez de hacer getDocs() al server.
  ensureCollections(pages[page].needs);

  // Si se fuerza refresh → limpiar cache de datos de esa página
  if (forceRefresh) {
    invalidateCacheByPrefix(page);
  }

  // Skeleton DIFERIDO: si el render termina rápido (cache hit), no se muestra y
  // no hay flash. Si tarda más de 80ms, pintamos un skeleton con shimmer que
  // sugiere la estructura típica (stat cards + tabla). Cuando renderFn reemplaza
  // el contenedor, los hijos entran con fade-in (.page-content > * en skeleton.css).
  // En live updates no tocamos nada: el contenido viejo queda visible.
  let _spinnerTimer = null;
  if (!fromLiveUpdate) {
    _spinnerTimer = setTimeout(() => {
      content.innerHTML = renderSkeleton(page);
      _spinnerTimer = null;
    }, 80);
  }

  if (!fromLiveUpdate) setStatus('connecting');
  const _tPage = performance.now();
  console.log(`[page] === ${page} loadPage start ===`);
  try {
    const mod = await loadPageModule(page);
    const renderFn = mod[pages[page].render];
    // renderFn es async — al llamarla, su parte sincrónica corre antes del
    // primer await. Si esa parte pintó un "shell" propio (UI vacía con
    // labels), no queremos que el skeleton genérico (timer 80ms) la pise.
    const renderPromise = renderFn(content, db);
    if (content.children.length > 0 && _spinnerTimer) {
      clearTimeout(_spinnerTimer); _spinnerTimer = null;
    }
    await renderPromise;
    if (_spinnerTimer) { clearTimeout(_spinnerTimer); _spinnerTimer = null; }
    // El usuario ya navegó a otra página: esta carga llegó tarde y su
    // contenedor está fuera del DOM. No tocamos el estado ni disparamos nada.
    if (gen !== _loadGen) {
      console.log(`[page] ${page} terminó tarde (ya se navegó a ${currentPage}) — descartado`);
      return;
    }
    console.log(`[page] === ${page} loadPage DONE en ${(performance.now() - _tPage).toFixed(0)}ms ===`);
    setStatus('online');
    updateLastTime();
    // La primera vez que una página completa su carga, arrancamos las
    // colecciones restantes (cierres_caja, gastos, etc) en background.
    // Antes de esto, evitamos meter listeners extra en la cola del SDK
    // mientras el usuario espera ver los datos de la página actual.
    if (!window.__firstPageDoneOnce) {
      window.__firstPageDoneOnce = true;
      setTimeout(() => {
        console.log('[page] primera página lista → prewarmRest');
        prewarmRest();
      }, 800);
    }
  } catch (err) {
    if (_spinnerTimer) { clearTimeout(_spinnerTimer); _spinnerTimer = null; }
    console.error(err);
    // Una carga abandonada suele romper justamente porque su DOM ya no está.
    // No es un error que le importe al usuario: no se muestra ni se marca
    // "sin conexión" (la página que sí está viendo puede haber cargado bien).
    if (gen !== _loadGen) return;
    if (reloadIfStaleChunk(err)) return;
    // En re-renders por store, NO pisar el contenido válido que ya está pintado.
    if (!fromLiveUpdate) {
      content.innerHTML = `<div class="empty-state"><span class="material-icons">error_outline</span><p>Error cargando datos: ${err.message}</p></div>`;
    }
    setStatus('offline');
  }
}

// ── Status ──
function setStatus(state) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  if (!dot || !txt) return;
  dot.className = 'status-dot ' + state;
  txt.textContent = state === 'online' ? 'Conectado' : state === 'offline' ? 'Sin conexión' : 'Conectando...';
}

function updateLastTime() {
  const el = document.getElementById('lastUpdate');
  if (el) el.textContent = 'Actualizado: ' + new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false });
}

// ── Tooltips del modo rail ──
// Se montan en <body> y no dentro del sidebar: el sidebar tiene overflow:hidden
// y cualquier tooltip interno quedaría recortado contra su borde.
let _railTip = null;

function ocultarRailTip() {
  if (_railTip) _railTip.classList.remove('show');
}

function initRailTooltips() {
  const sidebar = document.getElementById('sidebar');
  const app = document.getElementById('app');
  if (!sidebar || !app) return;

  const enRail = () => app.classList.contains('sidebar-collapsed') && window.innerWidth > 768;

  const mostrar = (link) => {
    const texto = link.querySelector('.nav-label')?.textContent?.trim();
    if (!texto) return;
    if (!_railTip) {
      _railTip = document.createElement('div');
      _railTip.className = 'rail-tooltip';
      document.body.appendChild(_railTip);
    }
    _railTip.textContent = texto;
    const r = link.getBoundingClientRect();
    _railTip.style.left = `${r.right + 10}px`;
    _railTip.style.top  = `${r.top + r.height / 2}px`;
    _railTip.classList.add('show');
  };

  sidebar.addEventListener('mouseover', e => {
    if (!enRail()) return;
    const link = e.target.closest('.nav-link');
    if (link) mostrar(link); else ocultarRailTip();
  });
  sidebar.addEventListener('mouseleave', ocultarRailTip);
  sidebar.addEventListener('click', ocultarRailTip);
  document.getElementById('navLinks')?.addEventListener('scroll', ocultarRailTip, { passive: true });
  window.addEventListener('resize', ocultarRailTip);
}

// ── Panel lateral del rail ──
// En rail cada sección es un solo icono; sus páginas se despliegan en un panel
// flotante al pasar el mouse. Así la tira queda en ~7 iconos en vez de 21.
let _railFlyout = null;
let _railFlyoutGroup = null;
let _railFlyoutTimer = null;

function cerrarRailFlyout() {
  clearTimeout(_railFlyoutTimer);
  _railFlyout?.classList.remove('show');
  _railFlyoutGroup?.querySelector('.nav-group-header')?.classList.remove('flyout-open');
  _railFlyoutGroup = null;
}

function abrirRailFlyout(group) {
  clearTimeout(_railFlyoutTimer);
  const header = group.querySelector('.nav-group-header');
  const items  = group.querySelector('.nav-group-items');
  if (!header || !items) return;

  if (!_railFlyout) {
    _railFlyout = document.createElement('div');
    _railFlyout.className = 'rail-flyout';
    document.body.appendChild(_railFlyout);
    _railFlyout.addEventListener('mouseenter', () => clearTimeout(_railFlyoutTimer));
    _railFlyout.addEventListener('mouseleave', () => {
      _railFlyoutTimer = setTimeout(cerrarRailFlyout, 120);
    });
    _railFlyout.addEventListener('click', e => {
      const a = e.target.closest('.nav-link');
      if (!a) return;
      e.preventDefault();
      cerrarRailFlyout();
      navigate(a.dataset.page);
    });
  }

  if (_railFlyoutGroup && _railFlyoutGroup !== group) {
    _railFlyoutGroup.querySelector('.nav-group-header')?.classList.remove('flyout-open');
  }
  _railFlyoutGroup = group;
  header.classList.add('flyout-open');

  // Los ítems se clonan (no se mueven) para no romper los listeners directos
  // del sidebar; se les sacan los id para no duplicarlos en el documento.
  _railFlyout.innerHTML = '';
  const titulo = document.createElement('div');
  titulo.className = 'rail-flyout-title';
  titulo.textContent = group.querySelector('.nav-group-label')?.textContent || '';
  _railFlyout.appendChild(titulo);
  items.querySelectorAll('.nav-link').forEach(src => {
    const clon = src.cloneNode(true);
    clon.removeAttribute('id');
    clon.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    _railFlyout.appendChild(clon);
  });

  // Posición: al costado del icono, sin salirse de la pantalla. Se mide antes
  // de mostrarlo (con opacity 0 ya tiene layout) para que no pegue un salto.
  const r = header.getBoundingClientRect();
  _railFlyout.style.left = `${r.right + 10}px`;
  _railFlyout.style.top = '0px';
  const alto = _railFlyout.offsetHeight;
  const top = Math.min(r.top - 10, window.innerHeight - alto - 8);
  _railFlyout.style.top = `${Math.max(8, top)}px`;
  _railFlyout.classList.add('show');
}

function initRailFlyout() {
  const sidebar = document.getElementById('sidebar');
  const app = document.getElementById('app');
  if (!sidebar || !app) return;

  const enRail = () => app.classList.contains('sidebar-collapsed') && window.innerWidth > 768;

  sidebar.addEventListener('mouseover', e => {
    if (!enRail()) return;
    const header = e.target.closest('.nav-group-header');
    if (header && !header.classList.contains('nav-pinned-header')) {
      abrirRailFlyout(header.closest('.nav-group'));
    } else if (e.target.closest('.nav-link') || e.target.closest('.sidebar-footer')) {
      // Pasar a un acceso rápido o al footer cierra el panel de la sección
      _railFlyoutTimer = setTimeout(cerrarRailFlyout, 120);
    }
  });
  sidebar.addEventListener('mouseleave', () => {
    _railFlyoutTimer = setTimeout(cerrarRailFlyout, 120);
  });

  document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarRailFlyout(); });
  window.addEventListener('resize', cerrarRailFlyout);
  document.getElementById('navLinks')?.addEventListener('scroll', cerrarRailFlyout, { passive: true });
}

function enModoRail() {
  const app = document.getElementById('app');
  return !!app && app.classList.contains('sidebar-collapsed') && window.innerWidth > 768;
}

// ── Helpers mobile ──
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  const overlay = document.getElementById('sidebarOverlay');
  if (overlay) overlay.classList.remove('visible');
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  const overlay = document.getElementById('sidebarOverlay');
  if (overlay) overlay.classList.add('visible');
}

function updateBottomNav(page) {
  document.querySelectorAll('.bottom-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });
}

// ── Precalentamiento de datos ──
// Corre en el DOMContentLoaded, ANTES del login. La intro del login dura ~1.9s
// (tiles cayendo + tagline + form) en los que el usuario sólo mira la
// animación: esa ventana se aprovecha para hidratar el store, cachear
// control_config y arrancar el listener de catalogo. Cuando el usuario termina
// de tipear, los datos ya están en memoria y el dashboard pinta al toque.
//
// Sólo se dispara cuando hay (o se presume) sesión: las rules de Firestore
// exigen usuario autenticado, así que sin token los listeners rebotan con
// permission-denied. El SDK resuelve el token de forma perezosa —si la sesión
// se está restaurando desde IndexedDB, la petición espera sola a que esté—,
// por eso alcanza con la pista sincrónica de auth.js para arrancar acá.
//
// Las animaciones del login son transform/opacity puras → corren en el
// compositor, no en el main thread. El trabajo de deserialización no las traba.
//
// Idempotente: initApp lo vuelve a llamar y la segunda vez es un no-op.
// `force` re-arma los listeners cuando la pista de sesión resultó falsa y los
// primeros los rechazó Firestore: sin esto, el login posterior quedaría con el
// store vacío y sin nadie que lo vuelva a poblar.
let _bootPreloadDone = false;
function bootPreload(force = false) {
  if (_bootPreloadDone && !force) return;
  _bootPreloadDone = true;
  console.log('[perf] bootPreload — precarga arrancada en paralelo al login');

  // Orden crítico para el primer load en frío:
  //   1) prewarmStore pinea TODAS las cache keys (sin abrir listeners).
  //   2) hydrateStore pinta con el snapshot local de la última sesión.
  //   3) Precargar control_config: es 1 doc chico que todas las páginas usan
  //      (getFechaInicio). Si lo dejamos a que se pida desde una página, queda
  //      atrás de los listeners en la cola serializada del SDK (medimos 17s).
  //      Disparado ACÁ con el SDK libre, tarda <500ms.
  //   4) ensureCollections arranca el listener de `catalogo` (lo más pesado
  //      y compartido por muchas páginas + por el watcher de notificaciones).
  prewarmStore(db);
  // Hidratación instantánea + delta: pinta al toque con el snapshot local de la
  // última sesión (~100-300ms vs 6-10s del primer snapshot del SDK) y en ~1s
  // mergea del server lo que cambió desde entonces. No se espera: getCached()
  // de las páginas queda colgado del waiter y se destraba apenas la hidratación
  // (o el listener, lo que llegue primero) puebla la key.
  hydrateStore(db);
  loadControlConfig(db); // fire-and-forget — cachea adentro de getCached

  // Los otros 3 docs de control_config (balance, dias del mes corriente y
  // compras) van ACÁ y no cuando la página los pide. Son 1 doc cada uno, pero
  // pedidos tarde quedan atrás de los listeners en la cola del SDK: medido en
  // el arranque real, `settings` disparado temprano tardó 570ms y estos tres,
  // disparados desde la página, 5.2s / 6.7s / 6.7s. Con el SDK libre resuelven
  // en cientos de ms y el Balance / Centro de Compras abren sin esperarlos.
  const hoy = new Date();
  const ym = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
  loadBalanceConfig(db).catch(() => {});
  loadDiasMes(db, ym).catch(() => {});
  loadComprasConfig(db).catch(() => {});

  // El primer snapshot de `catalogo` es lo más caro del arranque (~12k docs,
  // 6-7s de deserialización en el main thread). En idle para que no compita con
  // el tipeo del usuario en el form; el `timeout` garantiza que arranque igual
  // si el hilo nunca queda libre.
  const runIdle = window.requestIdleCallback || (cb => setTimeout(cb, 150));
  runIdle(() => ensureCollections(['catalogo']), { timeout: 600 });

  // Chunk de la página que se va a abrir. NO es siempre el dashboard: al entrar
  // se restaura `lastPage` (ver navigate/initApp), así que prefetcheamos esa
  // misma para que su módulo ya esté parseado cuando termine el login.
  let primera = 'dashboard';
  try {
    const last = localStorage.getItem('lastPage');
    if (last && pages[last]) primera = last;
  } catch (_) {}
  loadPageModule(primera).catch(() => {});
}

// ── Inicializar app principal ──
function initApp(session) {
  // Mostrar nombre de usuario en sidebar
  const statusText = document.getElementById('statusText');
  if (statusText) statusText.textContent = session.display;

  // Inicializar tema (claro por defecto) + botón toggle en el footer
  initTheme();
  const sidebarFooterTheme = document.querySelector('.sidebar-footer');
  if (sidebarFooterTheme && !document.getElementById('themeToggleBtn')) {
    const themeBtn = document.createElement('button');
    themeBtn.id = 'themeToggleBtn';
    themeBtn.className = 'sidebar-foot-btn';
    const syncIcon = () => {
      const dark = getTheme() === 'dark';
      themeBtn.title = dark ? 'Modo claro' : 'Modo oscuro';
      themeBtn.innerHTML = `<span class="material-icons">${dark ? 'light_mode' : 'dark_mode'}</span>`;
    };
    themeBtn.addEventListener('click', () => {
      toggleTheme();
      syncIcon();
      // El resto de la UI usa tokens CSS y se actualiza solo; los charts y el
      // heatmap hornean el color en el canvas/markup, así que re-renderizamos
      // esas páginas para que tomen la nueva paleta.
      if (currentPage === 'dashboard' || currentPage === 'control_total') {
        loadPage(currentPage, false);
      }
    });
    syncIcon();
    sidebarFooterTheme.appendChild(themeBtn);
  }

  // Agregar botón logout al sidebar
  const sidebarFooter = document.querySelector('.sidebar-footer');
  if (sidebarFooter && !document.getElementById('logoutBtn')) {
    const logoutBtn = document.createElement('button');
    logoutBtn.id = 'logoutBtn';
    logoutBtn.className = 'sidebar-foot-btn';
    logoutBtn.title = 'Cerrar sesión';
    logoutBtn.innerHTML = '<span class="material-icons">logout</span>';
    logoutBtn.addEventListener('click', () => { logout(); location.reload(); });
    sidebarFooter.appendChild(logoutBtn);
  }

  // Toggle "Iniciar con Windows" — solo dentro del .exe (Tauri); en la web no aplica.
  const sidebarFooterAs = document.querySelector('.sidebar-footer');
  if (isTauriApp() && sidebarFooterAs && !document.getElementById('autostartBtn')) {
    const asBtn = document.createElement('button');
    asBtn.id = 'autostartBtn';
    asBtn.className = 'sidebar-foot-btn';
    const syncAs = (on) => {
      asBtn.title = on ? 'Iniciar con Windows: activado (clic para desactivar)' : 'Iniciar con Windows: desactivado (clic para activar)';
      asBtn.innerHTML = `<span class="material-icons">${on ? 'power_settings_new' : 'power_off'}</span>`;
      asBtn.classList.toggle('on', !!on);
    };
    getAutostart().then(syncAs);
    asBtn.addEventListener('click', async () => {
      const next = !(await getAutostart());
      try { await setAutostart(next); syncAs(next); }
      catch (err) { console.warn('[autostart] toggle', err); }
    });
    sidebarFooterAs.appendChild(asBtn);
  }

  // Colapsar/expandir sidebar en desktop. Colapsado = modo rail (columna de
  // iconos), no oculto: la navegación sigue disponible. Estado recordado.
  const collapseBtn = document.getElementById('sidebarCollapseBtn');
  const collapseInner = document.getElementById('sidebarCollapseInner');
  if (collapseBtn || collapseInner) {
    const appEl = document.getElementById('app');
    let collapsed = false;
    try { collapsed = localStorage.getItem('ll-sidebar-collapsed') === '1'; } catch (_) {}
    const syncCollapse = () => {
      appEl.classList.toggle('sidebar-collapsed', collapsed);
      [collapseBtn, collapseInner].forEach(btn => {
        if (!btn) return;
        const ic = btn.querySelector('.material-icons');
        if (ic) ic.textContent = collapsed ? 'menu' : 'menu_open';
        btn.title = collapsed ? 'Expandir menú' : 'Contraer menú';
      });
      ocultarRailTip();
      cerrarRailFlyout();
      refrescarBadgesGrupo();
    };
    syncCollapse();
    // El ancho cambia de golpe (animarlo relayoutea la página entera en cada
    // frame). El fade corto del contenido del sidebar tapa el salto sin costo.
    const sidebarEl = document.getElementById('sidebar');
    let swapTimer = null;
    const toggle = () => {
      collapsed = !collapsed;
      try { localStorage.setItem('ll-sidebar-collapsed', collapsed ? '1' : '0'); } catch (_) {}
      syncCollapse();
      if (sidebarEl) {
        sidebarEl.classList.remove('sidebar-swap');
        void sidebarEl.offsetWidth; // reinicia la animación si se togglea rápido
        sidebarEl.classList.add('sidebar-swap');
        clearTimeout(swapTimer);
        swapTimer = setTimeout(() => sidebarEl.classList.remove('sidebar-swap'), 220);
      }
    };
    collapseBtn?.addEventListener('click', toggle);
    collapseInner?.addEventListener('click', toggle);
  }

  // Modo rail: tooltips en los accesos rápidos + panel lateral por sección
  initRailTooltips();
  initRailFlyout();

  // Grupos colapsables del sidebar
  initNavGroups();

  // Chip "Nuevo" en Centro de Compras (solo si nunca entró)
  initAvisoCentroCompras();

  // Accesos rápidos fijados
  initPinned();

  // Nav links (sidebar). Scope a .nav-group: los ítems de accesos rápidos se
  // recrean al vuelo y se manejan por delegación desde initPinned().
  document.querySelectorAll('.nav-group .nav-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      navigate(link.dataset.page);
      closeSidebar();
    });
  });

  // Bottom nav (mobile)
  document.querySelectorAll('.bottom-nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      navigate(item.dataset.page);
    });
  });

  // Menu button → abrir sidebar
  document.getElementById('menuBtn').addEventListener('click', openSidebar);

  // Overlay → cerrar sidebar
  const overlay = document.getElementById('sidebarOverlay');
  if (overlay) overlay.addEventListener('click', closeSidebar);

  // Refresh button → fuerza recarga desde Firebase invalidando el cache
  document.getElementById('refreshBtn').addEventListener('click', () => {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spinning');
    loadPage(currentPage, true).finally(() => {
      setTimeout(() => btn.classList.remove('spinning'), 500);
    });
  });

  // Swipe para cerrar sidebar en mobile
  let touchStartX = 0;
  document.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  document.addEventListener('touchend', e => {
    if (window.innerWidth > 768) return; // ignorar en desktop
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (dx < -60) closeSidebar(); // swipe izquierda = cerrar
    if (dx > 60 && touchStartX < 30) openSidebar(); // swipe derecha desde el borde = abrir
  }, { passive: true });

  // Cerrar sidebar si se redimensiona a desktop
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeSidebar();
  });

  window.navigateToPage = navigate;
  actualizarBadgeNotif(obtenerAlertasActivas());
  onAlertasCambian(actualizarBadgeNotif);
  actualizarBadgeFiados();

  // Aviso "HOY" en el sidebar si hoy es feriado/fecha comercial o tiene una nota.
  initCalendarioBadge(db, actualizarBadgeCalendario);

  // La precarga de datos (store + control_config + catalogo) ya arrancó en el
  // DOMContentLoaded, durante la intro del login. Acá es un no-op: se llama
  // igual por si initApp entra por otra vía.
  bootPreload();
  // initNotifications usa getCached('catalogo:all') → reusa el listener que
  // abrió bootPreload en vez de disparar un getDocs propio que duplicaría la
  // descarga. Queda fuera de bootPreload porque pinta badge y toasts: no deben
  // aparecer sobre la pantalla de login.
  initNotifications(db);

  // Pedidos de la tienda online. Va acá y no dentro de bootPreload por lo
  // mismo que las notificaciones: suena y pinta toasts, y no puede hacerlo
  // sobre la pantalla de login.
  initPedidosWatcher(db);
  onPedidosCambian(actualizarBadgePedidos);

  // Cuando cualquier colección del store recibe cambios desde el server,
  // re-renderizar la página activa sin spinner (datos ya están en cache).
  // Debounce 250 ms para agrupar bursts de cambios.
  let _storeRefreshTimer = null;
  let _notifRefreshTimer = null;
  let _pendingRerender = false;

  // ¿El usuario está interactuando con la UI? Si sí, NO destruir el DOM:
  // se perdería el texto de un input, una selección, un modal abierto,
  // un formulario a medio llenar, etc. El refresh queda diferido y se
  // ejecuta cuando el usuario libere el foco / cierre el modal.
  function userBusy() {
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return true;
    if (ae && ae.isContentEditable) return true;

    // Overlay/modal abierto. Los modales se appendan como hijos directos
    // del <body> con position:fixed sobre todo. Excluimos los elementos
    // estructurales (#app, #login, #sidebarOverlay) y los no-visuales.
    for (const c of document.body.children) {
      const id = c.id || '';
      // notifToastRoot = contenedor de toasts in-app (notifications.js). Vive fuera
      // de #app, así que un re-render de la página no lo destruye → no debe contar
      // como "ocupado", o un toast visible (ej. "Stock bajo") bloquearía los
      // refrescos en vivo del store hasta que se cierre.
      if (id === 'app' || id === 'login' || id === 'sidebarOverlay' ||
          id === 'notifToastRoot' ||
          c.tagName === 'SCRIPT' || c.tagName === 'STYLE' ||
          c.tagName === 'NOSCRIPT' || c.tagName === 'LINK' ||
          c.tagName === 'META') continue;
      const cs = getComputedStyle(c);
      if (cs.display !== 'none' && cs.visibility !== 'hidden') return true;
    }

    // Input de búsqueda del catálogo con texto (aunque no tenga foco).
    const buscar = document.getElementById('buscar');
    if (buscar && buscar.value && buscar.value.trim() !== '') return true;

    // Tabs editables del catálogo (nuevo, importar, config, margenes, reportes,
    // etiquetas, proveedor): re-renderizar perdería el form a medio llenar.
    // Sólo dejamos que los tabs "catalogo" e "inventario" se refresquen — esos
    // tienen sus propios listeners internos que preservan el estado UI.
    const activeTab = document.querySelector('.tab-btn.active')?.dataset?.tab;
    if (activeTab && activeTab !== 'catalogo' && activeTab !== 'inventario') return true;

    return false;
  }

  onStoreChange((col) => {
    if (col === 'fiado_items') actualizarBadgeFiados();
    if (_storeRefreshTimer) clearTimeout(_storeRefreshTimer);
    _storeRefreshTimer = setTimeout(() => {
      _storeRefreshTimer = null;
      // Si la página actual acaba de hacer un edit local (ej. catálogo: editar
      // producto), no re-renderizar la página entera — perderíamos búsqueda,
      // scroll y filtros. La página ya actualizó su estado en memoria.
      // El chequeo va acá (no antes del setTimeout) porque la página puede
      // setear el flag justo después de que el snapshot llegue.
      if (col === 'catalogo' && Date.now() < (window.__catalogoLocalEditUntil || 0)) return;

      // inventario_resumen: lo consume sólo la pestaña Inventario del catálogo,
      // que se suscribe internamente y refresca su propio tabContent. Un
      // loadPage completo acá resetearía a la pestaña Catálogo y perdería el
      // estado del inventario — lo dejamos pasar sin re-render global.
      if (col === 'inventario_resumen') return;

      // Página Catálogo: se auto-refresca EN EL LUGAR (catalogo.js se suscribe a
      // 'catalogo' e 'inventario_resumen'). Un loadPage completo saltaría de la
      // pestaña Inventario a Catálogo y borraría el pedido de reposición en curso
      // cada vez que entra una venta del POS. La página maneja su propio refresh.
      if (currentPage === 'catalogo') return;

      // Control Total: el cajero está mirando análisis y métricas; cada venta
      // que llega no debe destruir el DOM ni resetear scroll/filtros. Los datos
      // del store se mantienen frescos en memoria — al volver a la página se
      // ven actualizados; mientras se está adentro, refresh manual con los
      // botones de período.
      if (currentPage === 'control_total') return;

      // Centro de Compras: el usuario está armando un plan (checks, cantidades,
      // tope, costos a medio cargar) — cada venta del POS no debe resetear la
      // página. El botón "Actualizar" de la página refresca stock y ritmo.
      if (currentPage === 'centro_compras') return;

      // Fiados: la página se refresca sola cuando cambian las colecciones de
      // fiado (se suscribe al store por su cuenta). Sin esta exclusión, cada
      // venta del POS —que no tiene nada que ver con las cuentas corrientes—
      // destruía el DOM y reseteaba el cliente elegido y el scroll.
      if (currentPage === 'fiados') return;

      // Configuración de la Tienda: es un formulario. Cada venta del POS toca
      // `catalogo`, y sin esta exclusión la página se repintaba con el cliente
      // escribiendo adentro: el alias a medio tipear desaparecía y, al guardar,
      // se guardaba el campo vacío. Medido contra la base: el titular quedó
      // grabado y el alias no.
      if (currentPage === 'tienda_ajustes') return;

      // Catálogo de la Tienda: guarda filtros, búsqueda y scroll, y actualiza
      // sus propias filas después de cada cambio. Un re-render completo por una
      // venta ajena tira todo eso.
      if (currentPage === 'tienda_catalogo') return;

      // Si el usuario está interactuando, diferimos el refresh para no
      // pisar lo que está haciendo (buscar, editar, llenar un form).
      if (userBusy()) {
        _pendingRerender = true;
        return;
      }
      loadPage(currentPage, false, true);
    }, 250);
    // Cuando cambia el catálogo, recalcular alertas de stock. El listener
    // viejo dependía de config/catalogo_meta.last_updated — si el POS vendía
    // pero no editaba el catálogo, ese meta no se actualizaba y los toasts
    // no aparecían. Acá nos enteramos del cambio real del catálogo.
    if (col === 'catalogo') {
      if (_notifRefreshTimer) clearTimeout(_notifRefreshTimer);
      _notifRefreshTimer = setTimeout(() => {
        _notifRefreshTimer = null;
        refrescarAlertas({ silent: false }).catch(() => {});
      }, 400);
    }
  });

  // Cuando el usuario libera el foco (sale de un input, cierra un modal),
  // ejecutamos el refresh diferido — pero sólo si ya nadie más está
  // interactuando, para no caer en un loop "blur → refresh → blur".
  document.addEventListener('focusout', () => {
    if (!_pendingRerender) return;
    setTimeout(() => {
      if (_pendingRerender && !userBusy()) {
        _pendingRerender = false;
        loadPage(currentPage, false, true);
      }
    }, 400);
  });

  // Cargar última página visitada o dashboard
  const lastPage = localStorage.getItem('lastPage');
  navigate(lastPage && pages[lastPage] ? lastPage : 'dashboard');

  // El resto de las colecciones se arrancan SOLO después de que la página
  // actual terminó de cargar. Si prewarmRest se dispara antes, mete listeners
  // en la cola serializada del SDK y compite con los datos que el usuario está
  // esperando ver — eso explicaba los 60-70s de espera en cold load incógnito.
  window.__firstPageDoneOnce = false;

  // Prefetch en idle de las páginas más usadas (no bloquea la carga inicial)
  prefetchPageModules(['ventas', 'historial', 'control_total', 'catalogo']);

  // Watcher de consumibles: DESHABILITADO desde POS v3.0.43 — el descuento
  // por vinculaciones ahora lo hace el POS de escritorio en sale.py
  // (`_aplicar_vinculaciones_local` + `sync_vinculaciones_after_sale`).
  // El POS marca cada item de ventas_por_dia con `consumibles_procesado: true`,
  // por lo que el watcher web ya no es necesario y mantenerlo activo correría
  // riesgo de doble descuento si la PC sin webapp abierto vendiera con un
  // build viejo de POS. Se deja el código por si se necesita reactivar como
  // fallback.
  // const initWatcher = () => initConsumiblesWatcher(db);
  // if (window.requestIdleCallback) {
  //   window.requestIdleCallback(initWatcher, { timeout: 5000 });
  // } else {
  //   setTimeout(initWatcher, 2000);
  // }
}

function actualizarBadgeNotif(alertas) {
  const badge = document.getElementById('navNotifBadge');
  if (!badge) return;
  const n = (alertas || []).length;
  if (n === 0) {
    badge.style.display = 'none';
  } else {
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.style.display = 'inline-flex';
  }
  refrescarBadgesGrupo();
  renderPinned();
}

// Badge de Fiados: cuántos clientes tienen productos sin pagar. Se recalcula
// desde el store, así el cajero ve del sidebar que hay cuentas abiertas.
function actualizarBadgeFiados() {
  const badge = document.getElementById('navFiadoBadge');
  if (!badge) return;
  const items = peekCacheValue('fiado:items') || [];
  const claves = new Set();
  items.forEach(it => {
    if (it.estado !== 'pendiente' || it.deleted === true) return;
    const k = String(it.cliente_fid || '') || `local:${it.cliente_local_id}`;
    if (k && k !== 'local:null') claves.add(k);
  });
  const n = claves.size;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.style.display = n > 0 ? 'inline-flex' : 'none';
  refrescarBadgesGrupo();
  renderPinned();
}

// Pedidos de la tienda sin ver. Es el unico badge que cuenta plata de alguien
// esperando del otro lado, asi que va aunque el grupo este colapsado: el badge
// del grupo lo suma solo.
function actualizarBadgePedidos(pendientes) {
  const badge = document.getElementById('navPedidosBadge');
  if (!badge) return;
  const n = (pendientes || []).length;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.style.display = n > 0 ? 'inline-flex' : 'none';
  refrescarBadgesGrupo();
  renderPinned();
}

function actualizarBadgeCalendario(info) {
  const badge = document.getElementById('navCalBadge');
  // Scope a .nav-group: el ítem clonado en accesos rápidos también matchea
  const link = document.querySelector('.nav-group .nav-link[data-page="calendario"]');
  const hay = !!(info && info.hay);
  if (badge) {
    badge.style.display = hay ? 'inline-flex' : 'none';
    if (hay && info.items && info.items.length) {
      badge.title = info.items.map(e => e.nombre).join(' · ');
    }
  }
  if (link) link.classList.toggle('alerta-hoy', hay);
  refrescarBadgesGrupo();
  renderPinned();
  // Recalcular el aviso de fechas próximas (se llama también al cargar eventos).
  actualizarAvisoFechas();
}

// Banner superior: avisa apenas entrás si se viene una fecha en ≤3 días.
// Se descarta por el día (no molesta en cada navegación).
function actualizarAvisoFechas() {
  const host = document.getElementById('calAviso');
  if (!host) return;
  const d = new Date();
  const ymdOf = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const hoyKey = ymdOf(d);
  const mañanaKey = ymdOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));

  // Avisar cuando falten 2 o 1 días, y también el mismo día (recordatorio final).
  let prox = [];
  try { prox = (proximosEventos(2) || []).filter(e => e.dias >= 0 && e.dias <= 2); } catch (_) {}

  // "Snooze" por evento: al cerrar, no vuelve a aparecer hasta la fecha del evento
  // (el día llega → reaparece como recordatorio). Mapa { "fecha|nombre": mostrarDesde }.
  let snooze = {};
  try { snooze = JSON.parse(localStorage.getItem('ll-cal-aviso-snooze') || '{}') || {}; } catch (_) { snooze = {}; }
  // Podar eventos ya pasados.
  let podado = false;
  for (const k in snooze) { if ((k.split('|')[0] || '') < hoyKey) { delete snooze[k]; podado = true; } }
  if (podado) { try { localStorage.setItem('ll-cal-aviso-snooze', JSON.stringify(snooze)); } catch (_) {} }

  const visibles = prox.filter(e => {
    const k = e.fecha + '|' + e.nombre;
    return !snooze[k] || hoyKey >= snooze[k];   // oculto hasta la fecha en que se permite mostrar de nuevo
  });
  if (!visibles.length) { host.style.display = 'none'; host.innerHTML = ''; return; }

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cuando = n => n === 0 ? 'hoy' : n === 1 ? 'mañana' : `en ${n} días`;
  const chips = visibles.slice(0, 6).map(e => `
    <span class="cal-aviso-chip" style="background:${e.color};color:${textoSobre(e.color)}">
      <span class="material-icons" style="font-size:14px">${e.icon}</span>
      ${esc(e.nombre)} <b>· ${cuando(e.dias)}</b>
    </span>`).join('');
  const titulo = visibles.length === 1
    ? '¡Atención! Se viene una fecha'
    : `¡Atención! Se vienen ${visibles.length} fechas`;
  host.innerHTML = `
    <span class="material-icons cal-aviso-ico">notifications_active</span>
    <div class="cal-aviso-body">
      <b>${titulo}</b>
      <div class="cal-aviso-chips">${chips}</div>
    </div>
    <button class="cal-aviso-ver" id="calAvisoVer">Ver calendario</button>
    <button class="cal-aviso-x" id="calAvisoX" title="No mostrar hasta la fecha"><span class="material-icons">close</span></button>`;
  host.style.display = 'flex';
  document.getElementById('calAvisoVer')?.addEventListener('click', () => navigate('calendario'));
  document.getElementById('calAvisoX')?.addEventListener('click', () => {
    try {
      const cur = JSON.parse(localStorage.getItem('ll-cal-aviso-snooze') || '{}') || {};
      // Antes del día del evento → ocultar hasta su fecha. El mismo día → ocultar hasta mañana.
      visibles.forEach(e => { cur[e.fecha + '|' + e.nombre] = e.dias === 0 ? mañanaKey : e.fecha; });
      localStorage.setItem('ll-cal-aviso-snooze', JSON.stringify(cur));
    } catch (_) {}
    host.style.display = 'none';
  });
}

// Precarga los módulos JS de páginas pasadas, en idle, sin bloquear nada.
function prefetchPageModules(pageList) {
  const runIdle = window.requestIdleCallback || (cb => setTimeout(cb, 1500));
  runIdle(() => {
    pageList.forEach(p => {
      if (pages[p] && !pageModules[p]) loadPageModule(p).catch(() => {});
    });
  });
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  // Firebase resuelve el estado de sesión de forma asíncrona (lee IndexedDB),
  // pero esperar ese round-trip antes de pintar costaría el arranque en frío.
  // Con la pista sincrónica de auth.js apostamos a que la sesión sigue viva:
  // mostramos el shell y arrancamos la precarga en paralelo a la verificación.
  // Si la apuesta falla, se cae al login y no se perdió nada.
  const presumeSession = hasSessionHint();

  function showShell() {
    document.getElementById('app').style.display = 'flex';
    const bn = document.getElementById('bottomNav');
    if (bn) bn.classList.add('visible');
  }

  function hideShell() {
    document.getElementById('app').style.display = 'none';
    const bn = document.getElementById('bottomNav');
    if (bn) bn.classList.remove('visible');
  }

  if (presumeSession) {
    showShell();
    bootPreload();
  }

  function entrar(session) {
    showShell();
    // force: si presumeSession era falso positivo, los listeners que abrió
    // bootPreload murieron con permission-denied y hay que rearmarlos.
    bootPreload(presumeSession);
    initApp(session);
  }

  function alLogin() {
    // Si habíamos pintado el shell de más, lo escondemos antes de que se vea.
    if (presumeSession) hideShell();
    renderLogin(entrar);
  }

  if (isLoginLink()) {
    // La pestaña se abrió desde el enlace que llegó por correo: hay que
    // canjearlo antes de mirar el estado de sesión, porque todavía no existe.
    completeLinkSignIn().then(res => {
      if (res.ok) entrar(res.session);
      else alLogin();
    });
  } else {
    onAuthReady().then(session => {
      if (session) entrar(session);
      else alLogin();
    });
  }
  initAutostart();  // registra el arranque con Windows la primera vez (solo en el .exe)
  initUpdater();    // chequea actualizaciones del .exe contra el GitHub Release (solo en el .exe)
  // El cartel de descarga del .exe se saca: se usa la web. El .exe corre desde
  // tauri.localhost y el login con Google no funciona bien dentro del WebView2.
});
