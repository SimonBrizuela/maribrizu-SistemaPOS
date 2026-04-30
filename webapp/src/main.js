import { db } from './firebase.js';
import { invalidateCacheByPrefix, peekCache } from './cache.js';
import './styles/login.css';
import { renderLogin } from './pages/login.js';
import { isLoggedIn, getSession, logout } from './auth.js';

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
};

// Caché de módulos ya descargados (evita repetir import() tras la primera carga)
const pageModules = {};
async function loadPageModule(page) {
  if (!pageModules[page]) pageModules[page] = await pages[page].loader();
  return pageModules[page];
}

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

async function loadPage(page, forceRefresh = false) {
  const content = document.getElementById('pageContent');

  // Si se fuerza refresh → limpiar cache de datos de esa página
  if (forceRefresh) {
    invalidateCacheByPrefix(page);
  }

  // Mostrar spinner solo si no hay datos cacheados válidos
  // (si hay cache, render() termina en <10ms y el contenido aparece directo)
  const { cacheKey } = pages[page];
  const hasCached = !forceRefresh && cacheKey && peekCache(cacheKey);
  if (!hasCached) {
    content.innerHTML = `<div class="loader"><div class="spinner"></div><span>Cargando datos...</span></div>`;
  }

  setStatus('connecting');
  try {
    const mod = await loadPageModule(page);
    const renderFn = mod[pages[page].render];
    await renderFn(content, db);
    setStatus('online');
    updateLastTime();
  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="empty-state"><span class="material-icons">error_outline</span><p>Error cargando datos: ${err.message}</p></div>`;
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

  // Cargar última página visitada o dashboard
  const lastPage = localStorage.getItem('lastPage');
  navigate(lastPage && pages[lastPage] ? lastPage : 'dashboard');

  // Prefetch en idle de las páginas más usadas (no bloquea la carga inicial)
  const prefetch = ['ventas', 'historial', 'control_total', 'catalogo'];
  const runIdle = window.requestIdleCallback || (cb => setTimeout(cb, 1500));
  runIdle(() => { prefetch.forEach(p => { if (!pageModules[p]) loadPageModule(p).catch(() => {}); }); });
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
