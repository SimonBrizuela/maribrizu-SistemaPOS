/**
 * Página de notificaciones de stock.
 *
 * Lista todos los productos cuyo stock efectivo está en o por debajo del
 * `stock_min` configurado. Permite activar las notificaciones nativas del
 * navegador y, al apretar una tarjeta, abre el editor del producto en el
 * catálogo para que el usuario pueda actualizar el stock.
 */
import {
  obtenerAlertasActivas,
  onAlertasCambian,
  refrescarAlertas,
  pedirPermisoNotificaciones,
  permisoNotificacion,
  notificacionesSoportadas,
  notificacionesNavegadorActivas,
  setNotificacionesNavegador,
  irACatalogoYAbrir,
  mostrarNotificacionDePrueba,
} from '../notifications.js';

let _unsub = null;

function fmt(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export async function renderNotificaciones(container) {
  if (_unsub) { try { _unsub(); } catch {} _unsub = null; }

  container.innerHTML = `
    <div style="max-width:920px;margin:0 auto;display:flex;flex-direction:column;gap:14px">
      <div id="notifPermisoBox"></div>
      <div id="notifStats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px"></div>
      <div id="notifLista" style="display:flex;flex-direction:column;gap:8px"></div>
    </div>
  `;

  const permisoBox = container.querySelector('#notifPermisoBox');
  const statsBox = container.querySelector('#notifStats');
  const listaBox = container.querySelector('#notifLista');

  function renderPermiso() {
    if (!notificacionesSoportadas()) {
      permisoBox.innerHTML = `
        <div style="background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:14px 16px;font-size:13px;color:#65676b">
          Este navegador no soporta notificaciones nativas. Las alertas seguirán apareciendo arriba de la página.
        </div>`;
      return;
    }
    const perm = permisoNotificacion();
    const activas = notificacionesNavegadorActivas();

    if (perm === 'granted' && activas) {
      permisoBox.innerHTML = `
        <div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="material-icons" style="color:#2e7d32">notifications_active</span>
          <div style="flex:1;min-width:180px;font-size:13px;color:#1b5e20">
            <b>Notificaciones del navegador activadas.</b>
            Vas a recibir un aviso cada vez que un producto baje del mínimo, incluso con la pestaña cerrada.
          </div>
          <button id="notifProbar" style="background:#fff;color:#7b3fa6;border:1px solid #c4b5fd;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
            Probar
          </button>
          <button id="notifDesactivar" style="background:#fff;color:#2e7d32;border:1px solid #a5d6a7;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
            Desactivar
          </button>
        </div>`;
      permisoBox.querySelector('#notifProbar').addEventListener('click', () => {
        mostrarNotificacionDePrueba();
      });
      permisoBox.querySelector('#notifDesactivar').addEventListener('click', () => {
        setNotificacionesNavegador(false);
        renderPermiso();
      });
    } else if (perm === 'granted' && !activas) {
      permisoBox.innerHTML = `
        <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:12px">
          <span class="material-icons" style="color:#b45309">notifications_paused</span>
          <div style="flex:1;font-size:13px;color:#92400e">
            <b>Notificaciones pausadas.</b>
            Las alertas siguen apareciendo arriba de la página, pero no como notificación del navegador.
          </div>
          <button id="notifActivar" style="background:#7b3fa6;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
            Activar
          </button>
        </div>`;
      permisoBox.querySelector('#notifActivar').addEventListener('click', () => {
        setNotificacionesNavegador(true);
        mostrarNotificacionDePrueba();
        renderPermiso();
      });
    } else if (perm === 'denied') {
      permisoBox.innerHTML = `
        <div style="background:#ffebee;border:1px solid #ef9a9a;border-radius:12px;padding:12px 16px;font-size:13px;color:#b71c1c">
          <b>Notificaciones bloqueadas en este navegador.</b>
          Habilitalas desde el ícono del candado en la barra de direcciones para recibir avisos.
        </div>`;
    } else {
      permisoBox.innerHTML = `
        <div style="background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <span class="material-icons" style="color:#7b3fa6;font-size:28px">notifications</span>
          <div style="flex:1;min-width:200px">
            <div style="font-size:14px;font-weight:700;color:#1c1e21">Activar notificaciones del navegador</div>
            <div style="font-size:12px;color:#65676b;margin-top:2px">
              Te avisamos al instante cuando un producto llega al stock mínimo, aunque estés en otra pestaña.
            </div>
          </div>
          <button id="notifActivarBtn" style="background:#7b3fa6;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">
            Activar
          </button>
        </div>`;
      permisoBox.querySelector('#notifActivarBtn').addEventListener('click', async () => {
        const r = await pedirPermisoNotificaciones();
        if (r === 'granted') {
          setNotificacionesNavegador(true);
          mostrarNotificacionDePrueba();
        }
        renderPermiso();
      });
    }
  }

  function renderAlertas(alertas) {
    const criticas = alertas.filter(a => a.critico);
    const bajas = alertas.filter(a => !a.critico);

    statsBox.innerHTML = `
      <div style="background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:14px">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.5px;color:#65676b">TOTAL</div>
        <div style="font-size:26px;font-weight:800;color:#1c1e21;margin-top:4px">${alertas.length}</div>
      </div>
      <div style="background:#fff;border:1px solid #ef9a9a;border-radius:12px;padding:14px">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.5px;color:#c62828">SIN STOCK</div>
        <div style="font-size:26px;font-weight:800;color:#c62828;margin-top:4px">${criticas.length}</div>
      </div>
      <div style="background:#fff;border:1px solid #ffe082;border-radius:12px;padding:14px">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.5px;color:#b45309">STOCK BAJO</div>
        <div style="font-size:26px;font-weight:800;color:#b45309;margin-top:4px">${bajas.length}</div>
      </div>
    `;

    if (alertas.length === 0) {
      listaBox.innerHTML = `
        <div style="background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:30px 20px;text-align:center;color:#65676b">
          <span class="material-icons" style="font-size:42px;color:#a5d6a7">check_circle</span>
          <div style="font-size:15px;font-weight:600;color:#1c1e21;margin-top:8px">Todo en orden</div>
          <div style="font-size:13px;margin-top:4px">No hay productos por debajo del stock mínimo.</div>
        </div>`;
      return;
    }

    listaBox.innerHTML = alertas.map(a => `
      <button data-doc="${escape(a.doc_id)}" data-variedad="${escape(a.variedad || '')}" class="notif-row" style="
        text-align:left;background:#fff;border:1px solid ${a.critico ? '#ef9a9a' : '#ffe082'};
        border-left:5px solid ${a.critico ? '#c62828' : '#f57c00'};
        border-radius:12px;padding:12px 14px;cursor:pointer;display:flex;align-items:center;gap:12px;
        font-family:inherit;width:100%;transition:transform 0.1s, box-shadow 0.2s
      ">
        <span class="material-icons" style="color:${a.critico ? '#c62828' : '#f57c00'};font-size:24px;flex-shrink:0">
          ${a.critico ? 'error' : 'warning'}
        </span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span style="font-size:14px;font-weight:700;color:#1c1e21">${escape(a.nombre)}</span>
            ${a.variedad ? `<span style="font-size:10px;color:#6d28d9;background:#f5f3ff;padding:2px 6px;border-radius:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px">Variedad</span>` : ''}
            ${a.codigo ? `<span style="font-size:11px;color:#65676b;background:#f0f2f5;padding:2px 6px;border-radius:6px">#${escape(a.codigo)}</span>` : ''}
            ${a.rubro ? `<span style="font-size:10px;color:#7b3fa6;background:#f3e5f5;padding:2px 6px;border-radius:6px;font-weight:600">${escape(a.rubro)}</span>` : ''}
          </div>
          <div style="font-size:12px;color:#65676b;margin-top:4px">
            Stock <b style="color:${a.critico ? '#c62828' : '#b45309'}">${fmt(a.stock)}${a.unidad_label ? ' ' + escape(a.unidad_label) : ''}</b>
            <span style="color:#9ca3af">· mín ${fmt(a.stock_min)}</span>
            ${a.stock_max ? `<span style="color:#9ca3af"> · máx ${fmt(a.stock_max)}</span>` : ''}
            ${a.sugerencia ? ` · <span style="color:#7b3fa6;font-weight:600">pedir ~${fmt(a.sugerencia)}</span>` : ''}
          </div>
        </div>
        <span class="material-icons" style="color:#9ca3af;flex-shrink:0">edit</span>
      </button>
    `).join('');

    // Hover sutil + click → editor del catálogo
    listaBox.querySelectorAll('.notif-row').forEach(row => {
      row.addEventListener('mouseenter', () => {
        row.style.boxShadow = '0 4px 14px rgba(0,0,0,0.08)';
        row.style.transform = 'translateY(-1px)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.boxShadow = 'none';
        row.style.transform = 'translateY(0)';
      });
      row.addEventListener('click', () => {
        const id = row.dataset.doc;
        if (id) irACatalogoYAbrir(id);
      });
    });
  }

  renderPermiso();
  renderAlertas(obtenerAlertasActivas());

  // Refresca desde Firestore por si la página se abre antes de que init haya cargado
  refrescarAlertas().then(renderAlertas).catch(() => {});

  _unsub = onAlertasCambian((alertas) => {
    renderAlertas(alertas);
  });
}
