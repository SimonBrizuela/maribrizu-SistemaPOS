import { db } from './firebase.js';
import { invalidateCacheByPrefix, peekCache } from './cache.js';
import { prewarmStore, onStoreChange } from './store.js';
import './styles/login.css';
import { renderLogin } from './pages/login.js';
import { isLoggedIn, getSession, logout } from './auth.js';
import { initNotifications, obtenerAlertasActivas, onAlertasCambian, refrescarAlertas } from './notifications.js';
import { initConsumiblesWatcher } from './consumibles_watcher.js';

// ── Estado global ──
let currentPage = 'dashboard';

// Cada página se carga on-demand con dynamic import.
// `cacheKey` permite saltarse el spinner si hay datos ya cacheados.
// `loader` resuelve al módulo; la función render se toma de `render` en ese módulo.
const pages = {
  dashboard:       { title: 'Dashboard',               loader: () => import('./pages/dashboard.js'),        render: 'renderDashboard',       cacheKey: 'dashboard:ventas' },
  control_total:   { title: 'Control Total',           loader: () => import('./pages/control_total.js'),    render: 'renderControlTotal',    cacheKey: null },
  ventas:          { title: 'Ventas',                  loader: () => import('./pages/ventas.js'),           render: 'renderVentas',          cacheKey: 'ventas:lista' },
  productos:       { title: 'Productos Más Vendidos',  loader: () => import('./pages/productos.js'),        render: 'renderProductos',       cacheKey: 'productos:mas_vendidos' },
  historial:       { title: 'Historial Diario',        loader: () => import('./pages/historial.js'),        render: 'renderHistorial',       cacheKey: 'historial:diario' },
  cierres:         { title: 'Cierres de Caja',         loader: () => import('./pages/cierres.js'),          render: 'renderCierres',         cacheKey: 'cierres:caja' },
  resumenes:       { title: 'Resúmenes Mensuales',     loader: () => import('./pages/resumenes.js'),        render: 'renderResumenes',       cacheKey: 'resumenes:mensuales' },
  catalogo:        { title: 'Catálogo de Productos',   loader: () => import('./pages/catalogo.js'),         render: 'renderCatalogo',        cacheKey: null },
  turnos:          { title: 'Turnos / Cajeros',        loader: () => import('./pages/turnos.js'),           render: 'renderTurnos',          cacheKey: null },
  articulos_unicos:{ title: 'Artículos con Variantes', loader: () => import('./pages/articulos_unicos.js'), render: 'renderArticulosUnicos', cacheKey: null },
  promociones:     { title: 'Promociones',             loader: () => import('./pages/promociones.js'),      render: 'renderPromociones',     cacheKey: null },
  facturas:        { title: 'Facturación AFIP',        loader: () => import('./pages/facturas.js'),         render: 'renderFacturas',        cacheKey: null },
  perfiles:        { title: 'Perfiles ARCA',           loader: () => import('./pages/perfiles.js'),         render: 'renderPerfiles',        cacheKey: null },
  clientes:        { title: 'Perfiles de Clientes',    loader: () => import('./pages/clientes.js'),         render: 'renderClientes',        cacheKey: null },
  observaciones:   { title: 'Observaciones',           loader: () => import('./pages/observaciones.js'),    render: 'renderObservaciones',   cacheKey: null },
  presupuestos:    { title: 'Presupuestos',            loader: () => import('./pages/presupuestos.js'),     render: 'renderPresupuestos',    cacheKey: null },
  lab_productos:   { title: 'Productos Madre',          loader: () => import('./pages/lab_productos_madre.js'), render: 'renderLabProductos', cacheKey: null },
  pcs:             { title: 'Estado de PCs',           loader: () => import('./pages/pcs.js'),              render: 'renderPcs',             cacheKey: null },
  notificaciones:  { title: 'Notificaciones',          loader: () => import('./pages/notificaciones.js'),   render: 'renderNotificaciones',  cacheKey: null },
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

// ── Navegación ──
function navigate(page) {
  currentPage = page;
  localStorage.setItem('lastPage', page);
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

  // Si se fuerza refresh → limpiar cache de datos de esa página
  if (forceRefresh) {
    invalidateCacheByPrefix(page);
  }

  // Mostrar spinner solo si no hay datos cacheados válidos
  // (si hay cache, render() termina en <10ms y el contenido aparece directo)
  // En re-renders por live update no mostramos spinner: el contenido viejo queda visible
  // mientras se re-pinta — evita el "flash" que mata la sensación de tiempo real.
  const { cacheKey } = pages[page];
  const hasCached = !forceRefresh && cacheKey && peekCache(cacheKey);
  if (!hasCached && !fromLiveUpdate) {
    content.innerHTML = `<div class="loader"><div class="spinner"></div><span>Cargando datos...</span></div>`;
  }

  if (!fromLiveUpdate) setStatus('connecting');
  try {
    const mod = await loadPageModule(page);
    const renderFn = mod[pages[page].render];
    await renderFn(content, db);
    setStatus('online');
    updateLastTime();
  } catch (err) {
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

  // Agregar botón logout al sidebar
  const sidebarFooter = document.querySelector('.sidebar-footer');
  if (sidebarFooter && !document.getElementById('logoutBtn')) {
    const logoutBtn = document.createElement('button');
    logoutBtn.id = 'logoutBtn';
    logoutBtn.title = 'Cerrar sesión';
    logoutBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.5);display:flex;align-items:center;gap:4px;font-size:12px;margin-left:auto;padding:4px 8px;border-radius:6px;transition:background 0.2s;font-family:inherit';
    logoutBtn.innerHTML = '<span class="material-icons" style="font-size:16px!important">logout</span>';
    logoutBtn.addEventListener('mouseenter', () => logoutBtn.style.background = 'rgba(255,255,255,0.1)');
    logoutBtn.addEventListener('mouseleave', () => logoutBtn.style.background = 'none');
    logoutBtn.addEventListener('click', () => { logout(); location.reload(); });
    sidebarFooter.appendChild(logoutBtn);
  }

  // Grupos colapsables del sidebar
  initNavGroups();

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

  // Notificaciones globales de stock: se inicializan ANTES del store para que
  // _db esté listo cuando el onStoreChange dispare refrescarAlertas.
  initNotifications(db);
  window.navigateToPage = navigate;
  actualizarBadgeNotif(obtenerAlertasActivas());
  onAlertasCambian(actualizarBadgeNotif);

  // Arrancar listeners realtime globales ANTES de la primera navegación.
  // Los cache keys quedan pinned: las páginas leerán sincrónicamente de memoria
  // ni bien lleguen los primeros snapshots (en milisegundos).
  prewarmStore(db);

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
      if (id === 'app' || id === 'login' || id === 'sidebarOverlay' ||
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

  // Prefetch en idle de las páginas más usadas (no bloquea la carga inicial)
  prefetchPageModules(['ventas', 'historial', 'control_total', 'catalogo']);

  // Watcher de consumibles: escucha ventas y descuenta stock de productos
  // vinculados (ej: vender "Fotocopia A4" descuenta automáticamente "Hojas A4").
  // Se difiere a idle para no apilar dos fetches pesados del catálogo (~12k
  // docs) con notifications al arrancar — eso ralentizaba la carga inicial.
  const initWatcher = () => initConsumiblesWatcher(db);
  if (window.requestIdleCallback) {
    window.requestIdleCallback(initWatcher, { timeout: 5000 });
  } else {
    setTimeout(initWatcher, 2000);
  }
}

function actualizarBadgeNotif(alertas) {
  const badge = document.getElementById('navNotifBadge');
  if (!badge) return;
  const n = (alertas || []).length;
  if (n === 0) { badge.style.display = 'none'; return; }
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.style.display = 'inline-flex';
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
});
