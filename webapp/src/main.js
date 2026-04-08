import { db } from './firebase.js';
import './styles/login.css';
import { renderDashboard } from './pages/dashboard.js';
import { renderVentas } from './pages/ventas.js';
import { renderProductos } from './pages/productos.js';
import { renderInventario } from './pages/inventario.js';
import { renderHistorial } from './pages/historial.js';
import { renderCierres } from './pages/cierres.js';
import { renderResumenes } from './pages/resumenes.js';
import { renderCatalogo } from './pages/catalogo.js';
import { renderTurnos } from './pages/turnos.js';
import { renderArticulosUnicos } from './pages/articulos_unicos.js';
import { renderPromociones } from './pages/promociones.js';
import { renderLogin } from './pages/login.js';
import { isLoggedIn, getSession, logout } from './auth.js';

// ── Estado global ──
let currentPage = 'dashboard';

const pages = {
  dashboard:  { title: 'Dashboard',              render: renderDashboard },
  ventas:     { title: 'Ventas',                 render: renderVentas },
  productos:  { title: 'Productos Más Vendidos', render: renderProductos },
  inventario: { title: 'Inventario',             render: renderInventario },
  historial:  { title: 'Historial Diario',       render: renderHistorial },
  cierres:    { title: 'Cierres de Caja',        render: renderCierres },
  resumenes:  { title: 'Resúmenes Mensuales',    render: renderResumenes },
  catalogo:   { title: 'Catálogo de Productos',  render: renderCatalogo },
  turnos:          { title: 'Turnos / Cajeros',       render: renderTurnos },
  articulos_unicos:{ title: 'Artículos con Variantes', render: renderArticulosUnicos },
  promociones:     { title: 'Promociones',              render: renderPromociones },
};

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
  // Scroll arriba al cambiar página
  window.scrollTo({ top: 0, behavior: 'smooth' });
  loadPage(page);
}

async function loadPage(page) {
  const content = document.getElementById('pageContent');
  content.innerHTML = `<div class="loader"><div class="spinner"></div><span>Cargando datos...</span></div>`;
  setStatus('connecting');
  try {
    await pages[page].render(content, db);
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
  if (el) el.textContent = 'Actualizado: ' + new Date().toLocaleTimeString('es-AR');
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

  // Refresh button
  document.getElementById('refreshBtn').addEventListener('click', () => {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spinning');
    loadPage(currentPage).finally(() => {
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
