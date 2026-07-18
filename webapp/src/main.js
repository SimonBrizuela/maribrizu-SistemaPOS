import { db } from './firebase.js';
import { invalidateCacheByPrefix } from './cache.js';
import { prewarmStore, ensureCollections, prewarmRest, onStoreChange, hydrateStore } from './store.js';
import { loadControlConfig } from './config.js';
import './styles/login.css';
import './styles/skeleton.css';
import { renderLogin } from './pages/login.js';
import { isLoggedIn, getSession, logout } from './auth.js';
import { initTheme, toggleTheme, getTheme } from './theme.js';
import { initNotifications, obtenerAlertasActivas, onAlertasCambian, refrescarAlertas } from './notifications.js';
import { initConsumiblesWatcher } from './consumibles_watcher.js';
import { initCalendarioBadge, proximosEventos, textoSobre } from './pages/calendario_core.js';
import { renderSkeleton } from './skeletons.js';
import { initAutostart, getAutostart, setAutostart, isTauriApp } from './autostart.js';
import { initUpdater } from './updater.js';
import { initDownloadBanner } from './download_banner.js';

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
  observaciones:   { title: 'Observaciones',           loader: () => import('./pages/observaciones.js'),    render: 'renderObservaciones',   cacheKey: null,                      needs: [] },
  presupuestos:    { title: 'Presupuestos',            loader: () => import('./pages/presupuestos.js'),     render: 'renderPresupuestos',    cacheKey: null,                      needs: ['catalogo'] },
  lab_productos:   { title: 'Productos Madre',         loader: () => import('./pages/lab_productos_madre.js'), render: 'renderLabProductos', cacheKey: null,                      needs: ['catalogo'] },
  pcs:             { title: 'Estado de PCs',           loader: () => import('./pages/pcs.js'),              render: 'renderPcs',             cacheKey: null,                      needs: [] },
  notificaciones:  { title: 'Notificaciones',          loader: () => import('./pages/notificaciones.js'),   render: 'renderNotificaciones',  cacheKey: null,                      needs: ['catalogo'] },
  centro_compras:  { title: 'Centro de Compras',        loader: () => import('./pages/centro_compras.js'),   render: 'renderCentroCompras',   cacheKey: null,                      needs: ['catalogo', 'ventas_por_dia'] },
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
}
function marcarCentroComprasVisto() {
  if (localStorage.getItem(LS_CC_NUEVO)) return;
  try { localStorage.setItem(LS_CC_NUEVO, '1'); } catch (e) { /* modo privado */ }
  const badge = document.getElementById('navCCNuevo');
  if (badge) badge.style.display = 'none';
}

// ── Navegación ──
function navigate(page) {
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
  openGroupForPage(page);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  loadPage(page);
}

// ── Grupos colapsables del sidebar ──
function initNavGroups() {
  const saved = JSON.parse(localStorage.getItem('nav:openGroups') || '[]');

  document.querySelectorAll('.nav-group').forEach(group => {
    const groupId = group.dataset.group;
    const header  = group.querySelector('.nav-group-header');
    const items   = group.querySelector('.nav-group-items');
    const arrow   = group.querySelector('.nav-group-arrow');

    // Restaurar estado guardado
    const isOpen = saved.includes(groupId);
    if (isOpen) {
      items.classList.add('open');
      arrow.classList.add('rotated');
    }

    header.addEventListener('click', () => {
      const opening = !items.classList.contains('open');
      items.classList.toggle('open', opening);
      arrow.classList.toggle('rotated', opening);

      // Persistir en localStorage
      const current = JSON.parse(localStorage.getItem('nav:openGroups') || '[]');
      const updated = opening
        ? [...new Set([...current, groupId])]
        : current.filter(g => g !== groupId);
      localStorage.setItem('nav:openGroups', JSON.stringify(updated));
    });
  });
}

function openGroupForPage(page) {
  const link = document.querySelector(`.nav-link[data-page="${page}"]`);
  if (!link) return;
  const group = link.closest('.nav-group');
  if (!group) return;
  const groupId = group.dataset.group;
  const items   = group.querySelector('.nav-group-items');
  const arrow   = group.querySelector('.nav-group-arrow');
  if (!items.classList.contains('open')) {
    items.classList.add('open');
    arrow.classList.add('rotated');
    const current = JSON.parse(localStorage.getItem('nav:openGroups') || '[]');
    localStorage.setItem('nav:openGroups', JSON.stringify([...new Set([...current, groupId])]));
  }
}

async function loadPage(page, forceRefresh = false, fromLiveUpdate = false) {
  const content = document.getElementById('pageContent');

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
    const syncIcon = () => {
      const dark = getTheme() === 'dark';
      themeBtn.title = dark ? 'Modo claro' : 'Modo oscuro';
      themeBtn.innerHTML = `<span class="material-icons" style="font-size:16px!important">${dark ? 'light_mode' : 'dark_mode'}</span>`;
    };
    themeBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.5);display:flex;align-items:center;gap:4px;font-size:12px;margin-left:auto;padding:4px 8px;border-radius:6px;transition:background 0.2s;font-family:inherit';
    themeBtn.addEventListener('mouseenter', () => themeBtn.style.background = 'rgba(255,255,255,0.1)');
    themeBtn.addEventListener('mouseleave', () => themeBtn.style.background = 'none');
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
    logoutBtn.title = 'Cerrar sesión';
    logoutBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.5);display:flex;align-items:center;gap:4px;font-size:12px;padding:4px 8px;border-radius:6px;transition:background 0.2s;font-family:inherit';
    logoutBtn.innerHTML = '<span class="material-icons" style="font-size:16px!important">logout</span>';
    logoutBtn.addEventListener('mouseenter', () => logoutBtn.style.background = 'rgba(255,255,255,0.1)');
    logoutBtn.addEventListener('mouseleave', () => logoutBtn.style.background = 'none');
    logoutBtn.addEventListener('click', () => { logout(); location.reload(); });
    sidebarFooter.appendChild(logoutBtn);
  }

  // Toggle "Iniciar con Windows" — solo dentro del .exe (Tauri); en la web no aplica.
  const sidebarFooterAs = document.querySelector('.sidebar-footer');
  if (isTauriApp() && sidebarFooterAs && !document.getElementById('autostartBtn')) {
    const asBtn = document.createElement('button');
    asBtn.id = 'autostartBtn';
    asBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.5);display:flex;align-items:center;gap:4px;font-size:12px;padding:4px 8px;border-radius:6px;transition:background 0.2s;font-family:inherit';
    const syncAs = (on) => {
      asBtn.title = on ? 'Iniciar con Windows: activado (clic para desactivar)' : 'Iniciar con Windows: desactivado (clic para activar)';
      asBtn.innerHTML = `<span class="material-icons" style="font-size:16px!important">${on ? 'power_settings_new' : 'power_off'}</span>`;
      asBtn.style.color = on ? 'rgba(142,198,63,0.95)' : 'rgba(255,255,255,0.5)';
    };
    getAutostart().then(syncAs);
    asBtn.addEventListener('mouseenter', () => asBtn.style.background = 'rgba(255,255,255,0.1)');
    asBtn.addEventListener('mouseleave', () => asBtn.style.background = 'none');
    asBtn.addEventListener('click', async () => {
      const next = !(await getAutostart());
      try { await setAutostart(next); syncAs(next); }
      catch (err) { console.warn('[autostart] toggle', err); }
    });
    sidebarFooterAs.appendChild(asBtn);
  }

  // Colapsar/expandir sidebar en desktop (slide suave), estado recordado.
  // Dos botones: el de adentro del sidebar (arriba del logo) OCULTA; el del
  // topbar reaparece sólo cuando está colapsado para volver a MOSTRARLO.
  const collapseBtn = document.getElementById('sidebarCollapseBtn');
  const collapseInner = document.getElementById('sidebarCollapseInner');
  if (collapseBtn || collapseInner) {
    const appEl = document.getElementById('app');
    let collapsed = false;
    try { collapsed = localStorage.getItem('ll-sidebar-collapsed') === '1'; } catch (_) {}
    const syncCollapse = () => {
      appEl.classList.toggle('sidebar-collapsed', collapsed);
      if (collapseBtn) {
        const ic = collapseBtn.querySelector('.material-icons');
        if (ic) ic.textContent = 'menu';
        collapseBtn.title = 'Mostrar menú';
      }
    };
    syncCollapse();
    const toggle = () => {
      collapsed = !collapsed;
      try { localStorage.setItem('ll-sidebar-collapsed', collapsed ? '1' : '0'); } catch (_) {}
      syncCollapse();
    };
    collapseBtn?.addEventListener('click', toggle);
    collapseInner?.addEventListener('click', toggle);
  }

  // Grupos colapsables del sidebar
  initNavGroups();

  // Chip "Nuevo" en Centro de Compras (solo si nunca entró)
  initAvisoCentroCompras();

  // Nav links (sidebar)
  document.querySelectorAll('.nav-link').forEach(link => {
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

  // Aviso "HOY" en el sidebar si hoy es feriado/fecha comercial o tiene una nota.
  initCalendarioBadge(db, actualizarBadgeCalendario);

  // Orden crítico para el primer load en frío:
  //   1) prewarmStore pinea TODAS las cache keys (sin abrir listeners).
  //   2) Precargar control_config: es 1 doc chico que todas las páginas usan
  //      (getFechaInicio). Si lo dejamos a que se pida desde una página, queda
  //      atrás de los listeners en la cola serializada del SDK (medimos 17s).
  //      Disparado AHORA con el SDK libre, tarda <500ms.
  //   3) ensureCollections arranca el listener de `catalogo` (lo más pesado
  //      y compartido por muchas páginas + por el watcher de notificaciones).
  //   4) initNotifications usa getCached('catalogo:all') → reusa el listener
  //      en vez de disparar un getDocs propio que duplicaría la descarga.
  prewarmStore(db);
  // Hidratación instantánea + delta: pinta al toque con el snapshot local de la
  // última sesión (~100-300ms vs 6-10s del primer snapshot del SDK) y en ~1s
  // mergea del server lo que cambió desde entonces. No se espera: getCached()
  // de las páginas queda colgado del waiter y se destraba apenas la hidratación
  // (o el listener, lo que llegue primero) puebla la key.
  hydrateStore(db);
  loadControlConfig(db); // fire-and-forget — cachea adentro de getCached
  ensureCollections(['catalogo']);
  initNotifications(db);

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
  if (n === 0) { badge.style.display = 'none'; return; }
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.style.display = 'inline-flex';
}

function actualizarBadgeCalendario(info) {
  const badge = document.getElementById('navCalBadge');
  const link = document.querySelector('.nav-link[data-page="calendario"]');
  const hay = !!(info && info.hay);
  if (badge) {
    badge.style.display = hay ? 'inline-flex' : 'none';
    if (hay && info.items && info.items.length) {
      badge.title = info.items.map(e => e.nombre).join(' · ');
    }
  }
  if (link) link.classList.toggle('alerta-hoy', hay);
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
  if (isLoggedIn()) {
    // Ya está logueado → mostrar app
    document.getElementById('app').style.display = 'flex';
    const bn = document.getElementById('bottomNav');
    if (bn) bn.classList.add('visible');
    initApp(getSession());
  } else {
    // Mostrar login
    renderLogin((session) => {
      initApp(session);
    });
  }
  initAutostart();       // registra el arranque con Windows la primera vez (solo en el .exe)
  initUpdater();         // chequea actualizaciones del .exe contra el GitHub Release (solo en el .exe)
  initDownloadBanner();  // cartel de descarga del .exe (solo en la web por navegador)
});
