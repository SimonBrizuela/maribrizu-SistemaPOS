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
  ignorarProducto,
  restaurarTodos,
  obtenerIgnorados,
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

  // Estado de "ver todas" de la sección urgente, persistente entre re-renders.
  let urgExpanded = false;
  let ultimasAlertas = [];

  function renderPermiso() {
    if (!notificacionesSoportadas()) {
      permisoBox.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;font-size:13px;color:var(--text-muted)">
          Este navegador no soporta notificaciones nativas. Las alertas seguirán apareciendo arriba de la página.
        </div>`;
      return;
    }
    const perm = permisoNotificacion();
    const activas = notificacionesNavegadorActivas();

    if (perm === 'granted' && activas) {
      permisoBox.innerHTML = `
        <div style="background:var(--tint-green-bg);border:1px solid var(--border);border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="material-icons" style="color:var(--tint-green-fg)">notifications_active</span>
          <div style="flex:1;min-width:180px;font-size:13px;color:var(--tint-green-fg)">
            <b>Notificaciones del navegador activadas.</b>
            Vas a recibir un aviso cada vez que un producto baje del mínimo, incluso con la pestaña cerrada.
          </div>
          <button id="notifProbar" style="background:var(--surface);color:var(--primary);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
            Probar
          </button>
          <button id="notifDesactivar" style="background:var(--surface);color:var(--tint-green-fg);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
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
        <div style="background:var(--tint-yellow-bg);border:1px solid var(--border);border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:12px">
          <span class="material-icons" style="color:var(--tint-orange-fg)">notifications_paused</span>
          <div style="flex:1;font-size:13px;color:var(--tint-orange-fg)">
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
        <div style="background:var(--tint-red-bg);border:1px solid var(--border);border-radius:12px;padding:12px 16px;font-size:13px;color:var(--tint-red-fg)">
          <b>Notificaciones bloqueadas en este navegador.</b>
          Habilitalas desde el ícono del candado en la barra de direcciones para recibir avisos.
        </div>`;
    } else {
      permisoBox.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <span class="material-icons" style="color:var(--primary);font-size:28px">notifications</span>
          <div style="flex:1;min-width:200px">
            <div style="font-size:14px;font-weight:700;color:var(--text)">Activar notificaciones del navegador</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
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
    ultimasAlertas = alertas;
    // Particionar:
    //  - producto (no-variedad, no-auto)   → "STOCK BAJO" / "SIN STOCK"
    //  - variedad con stock_min cargado    → mismo grupo (alerta configurada)
    //  - variedad auto-detectada (auto:true) → "VARIANTES BAJAS"
    // Particiones por ORIGEN: ritmo de venta (urgente, sin importar mínimo) vs
    // mínimo configurado (sección aparte) vs variantes auto-detectadas.
    const urgentesRitmo = alertas.filter(a => a.origen === 'ritmo');
    const alertasConfig = alertas.filter(a => !a.auto && a.origen !== 'ritmo');
    const alertasAuto   = alertas.filter(a => a.auto);
    const criticas = alertasConfig.filter(a => a.critico);
    const bajas    = alertasConfig.filter(a => !a.critico);

    statsBox.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.5px;color:var(--text-muted)">TOTAL</div>
        <div style="font-size:26px;font-weight:800;color:var(--text);margin-top:4px">${alertas.length}</div>
      </div>
      ${urgentesRitmo.length > 0 ? `
      <div style="background:var(--tint-red-bg);border:1px solid var(--border);border-radius:12px;padding:14px">
        <div style="font-size:11px;font-weight:800;letter-spacing:0.5px;color:var(--tint-red-fg);display:flex;align-items:center;gap:4px"><span class="material-icons" style="font-size:14px">priority_high</span>REPONER YA</div>
        <div style="font-size:26px;font-weight:800;color:var(--tint-red-fg);margin-top:4px">${urgentesRitmo.length}</div>
      </div>` : ''}
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.5px;color:var(--tint-red-fg)">SIN STOCK</div>
        <div style="font-size:26px;font-weight:800;color:var(--tint-red-fg);margin-top:4px">${criticas.length}</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.5px;color:var(--tint-orange-fg)">STOCK BAJO</div>
        <div style="font-size:26px;font-weight:800;color:var(--tint-orange-fg);margin-top:4px">${bajas.length}</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.5px;color:var(--tint-orange-fg)">VARIANTES BAJAS</div>
        <div style="font-size:26px;font-weight:800;color:var(--tint-orange-fg);margin-top:4px">${alertasAuto.length}</div>
      </div>
    `;

    if (alertas.length === 0) {
      const nOcultos0 = obtenerIgnorados().length;
      listaBox.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:30px 20px;text-align:center;color:var(--text-muted)">
          <span class="material-icons" style="font-size:42px;color:#a5d6a7">check_circle</span>
          <div style="font-size:15px;font-weight:600;color:var(--text);margin-top:8px">Todo en orden</div>
          <div style="font-size:13px;margin-top:4px">No hay productos por debajo del stock mínimo.</div>
          ${nOcultos0 > 0 ? `<button id="notifRestaurar" style="margin-top:14px;background:var(--surface);color:var(--primary);border:1px solid var(--border);border-radius:8px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Mostrar ${nOcultos0} ${nOcultos0 === 1 ? 'producto oculto' : 'ocultos'}</button>` : ''}
        </div>`;
      const r = listaBox.querySelector('#notifRestaurar');
      if (r) r.addEventListener('click', () => restaurarTodos());
      return;
    }

    // ── Sección 1: alertas configuradas (stock_min manual a nivel producto o variedad) ──
    const filaConfig = (a) => {
      const urgente = !!a.urgente;
      const acento  = urgente ? 'var(--tint-red-fg)' : a.critico ? 'var(--tint-red-fg)' : 'var(--tint-orange-fg)';
      const acentoTxt = urgente ? 'var(--tint-red-fg)' : a.critico ? 'var(--tint-red-fg)' : 'var(--tint-orange-fg)';
      const borde   = 'var(--border)';
      const icono   = urgente ? 'priority_high' : a.critico ? 'error' : 'warning';
      const fondo   = urgente ? 'var(--tint-red-bg)' : 'var(--surface)';
      const cobertura = a.cobertura_texto || '';
      return `
      <button data-doc="${escape(a.doc_id)}" data-variedad="${escape(a.variedad || '')}" class="notif-row" style="
        text-align:left;background:${fondo};border:1px solid ${borde};
        border-left:5px solid ${acento};
        border-radius:12px;padding:12px 14px;cursor:pointer;display:flex;align-items:center;gap:12px;
        font-family:inherit;width:100%;transition:transform 0.1s, box-shadow 0.2s
      ">
        <span class="material-icons" style="color:${acento};font-size:24px;flex-shrink:0">
          ${icono}
        </span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span style="font-size:14px;font-weight:700;color:var(--text)">${escape(a.nombre)}</span>
            ${a.es_top ? `<span style="font-size:9px;color:var(--tint-red-fg);background:var(--tint-red-bg);border:1px solid var(--border);padding:2px 7px;border-radius:99px;font-weight:800;text-transform:uppercase;letter-spacing:0.3px">Top ventas</span>` : ''}
            ${a.variedad ? `<span style="font-size:10px;color:var(--tint-purple-fg);background:var(--tint-purple-bg);padding:2px 6px;border-radius:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px">Variedad</span>` : ''}
            ${a.codigo ? `<span style="font-size:11px;color:var(--text-muted);background:var(--bg);padding:2px 6px;border-radius:6px">#${escape(a.codigo)}</span>` : ''}
            ${a.rubro ? `<span style="font-size:10px;color:var(--primary);background:var(--tint-purple-bg);padding:2px 6px;border-radius:6px;font-weight:600">${escape(a.rubro)}</span>` : ''}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
            ${a.stock <= 0
              ? `<b style="color:${acentoTxt}">Sin stock${a.stock < 0 ? ` (figura ${fmt(a.stock)})` : ''}</b>`
              : `Stock <b style="color:${acentoTxt}">${a.stock_texto ? escape(a.stock_texto) : `${fmt(a.stock)}${a.unidad_label ? ' ' + escape(a.unidad_label) : ''}`}</b>${a.stock_equiv ? ` <span style="color:var(--text-muted)">(${escape(a.stock_equiv)})</span>` : ''}`}
            ${a.stock_min > 0 ? `<span style="color:var(--text-muted)">· mín ${a.min_texto ? escape(a.min_texto) : fmt(a.stock_min)}</span>` : ''}
            ${a.stock_max ? `<span style="color:var(--text-muted)"> · máx ${a.max_texto ? escape(a.max_texto) : fmt(a.stock_max)}</span>` : ''}
            ${a.sugerencia ? ` · <span style="color:var(--primary);font-weight:600">pedir ~${a.sugerencia_texto ? escape(a.sugerencia_texto) : fmt(a.sugerencia)}</span>` : ''}
          </div>
          ${cobertura ? `<div style="font-size:11.5px;font-weight:600;color:${urgente ? 'var(--tint-red-fg)' : 'var(--primary)'};margin-top:3px;display:flex;align-items:center;gap:4px">
            <span class="material-icons" style="font-size:14px">trending_up</span>${escape(cobertura)}
          </div>` : ''}
        </div>
        <span class="notif-ocultar material-icons" data-ocultar="${escape(a.doc_id)}" title="No mostrar este producto acá"
          style="color:var(--text-muted);flex-shrink:0;border-radius:8px;padding:4px;font-size:20px">visibility_off</span>
        <span class="material-icons" style="color:var(--text-muted);flex-shrink:0">edit</span>
      </button>
    `;
    };

    // ── Sección 2: variantes auto-detectadas (agrupadas por producto padre) ──
    // Cada producto agrupa sus variedades en chips: rojo si crítico (=0), naranja si bajo (≤2).
    const variantesPorDoc = new Map();
    for (const a of alertasAuto) {
      if (!variantesPorDoc.has(a.doc_id)) {
        variantesPorDoc.set(a.doc_id, {
          doc_id: a.doc_id,
          nombre: (a.producto?.nombre) || a.nombre.split(' · ')[0],
          codigo: a.codigo,
          rubro: a.rubro,
          unidad_label_pl: a.unidad_label,
          variedades: [],
        });
      }
      variantesPorDoc.get(a.doc_id).variedades.push(a);
    }
    // Productos con más variedades agotadas (críticas) primero; luego total de variedades alertadas.
    const gruposAuto = Array.from(variantesPorDoc.values())
      .map(g => {
        g.variedades.sort((a, b) => a.stock - b.stock); // críticas primero dentro del grupo
        g._criticas = g.variedades.filter(v => v.critico).length;
        g._bajas = g.variedades.length - g._criticas;
        return g;
      })
      .sort((a, b) => {
        if (a._criticas !== b._criticas) return b._criticas - a._criticas;
        return b.variedades.length - a.variedades.length;
      });

    const cardGrupo = (g) => `
      <div data-doc="${escape(g.doc_id)}" class="notif-group" style="
        background:var(--surface);border:1.5px solid var(--border);border-left:5px solid #e65100;
        border-radius:12px;padding:12px 14px;cursor:pointer;font-family:inherit;
        transition:transform 0.1s, box-shadow 0.2s
      ">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span class="material-icons" style="color:var(--tint-orange-fg);font-size:22px;flex-shrink:0">palette</span>
          <div style="flex:1;min-width:160px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span style="font-size:14px;font-weight:700;color:var(--text)">${escape(g.nombre)}</span>
              ${g.codigo ? `<span style="font-size:11px;color:var(--text-muted);background:var(--bg);padding:2px 6px;border-radius:6px">#${escape(g.codigo)}</span>` : ''}
              ${g.rubro ? `<span style="font-size:10px;color:var(--primary);background:var(--tint-purple-bg);padding:2px 6px;border-radius:6px;font-weight:600">${escape(g.rubro)}</span>` : ''}
            </div>
            <div style="font-size:11.5px;color:var(--text-muted);margin-top:3px">
              ${g._criticas > 0 ? `<b style="color:var(--tint-red-fg)">${g._criticas} sin stock</b>` : ''}
              ${g._criticas > 0 && g._bajas > 0 ? ' · ' : ''}
              ${g._bajas > 0 ? `<b style="color:var(--tint-orange-fg)">${g._bajas} casi sin stock</b>` : ''}
            </div>
          </div>
          <span class="material-icons" style="color:var(--text-muted);flex-shrink:0">edit</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:10px">
          ${g.variedades.map(v => {
            const isCrit = v.critico;
            const bg = isCrit ? 'var(--tint-red-bg)' : 'var(--tint-orange-bg)';
            const bd = isCrit ? 'var(--tint-red-fg)' : 'var(--tint-orange-fg)';
            const fg = isCrit ? 'var(--tint-red-fg)' : 'var(--tint-orange-fg)';
            const label = v.variedad || 'Sin nombre';
            return `<span style="background:${bg};border:1px solid ${bd};color:${fg};padding:3px 9px;border-radius:99px;font-size:11px;font-weight:700;white-space:nowrap">
              ${escape(label)} · ${fmt(v.stock)}
            </span>`;
          }).join('')}
        </div>
      </div>
    `;

    // Render
    const partes = [];
    if (urgentesRitmo.length > 0) {
      // Ya vienen ordenados por más vendido desde el motor. Mostramos un tope
      // y dejamos el resto detrás de un botón "Ver todas" para no abrumar.
      const TOPE = 30;
      const visibles = urgExpanded ? urgentesRitmo : urgentesRitmo.slice(0, TOPE);
      const resto = urgentesRitmo.length - visibles.length;
      partes.push(`
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <span class="material-icons" style="color:var(--tint-red-fg);font-size:18px">priority_high</span>
          <b style="font-size:13px;color:var(--tint-red-fg);letter-spacing:0.3px">Reponer urgente</b>
          <span style="font-size:11.5px;color:var(--text-muted)">— de los más vendidos, en cero o por agotarse · ordenados por ventas</span>
        </div>`);
      partes.push(visibles.map(filaConfig).join(''));
      if (resto > 0) {
        partes.push(`
          <button id="urgVerTodas" style="width:100%;background:var(--tint-red-bg);color:var(--tint-red-fg);border:1px solid var(--border);border-radius:10px;padding:9px 14px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:6px;transition:background 0.15s">
            <span class="material-icons" style="font-size:18px">expand_more</span>Ver las ${resto} restantes que faltan reponer
          </button>`);
      } else if (urgExpanded && urgentesRitmo.length > TOPE) {
        partes.push(`
          <button id="urgVerMenos" style="width:100%;background:var(--surface);color:var(--text-muted);border:1px solid var(--border);border-radius:10px;padding:9px 14px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:6px;transition:background 0.15s">
            <span class="material-icons" style="font-size:18px">expand_less</span>Ver menos
          </button>`);
      }
    }
    if (alertasConfig.length > 0) {
      partes.push(`
        <div style="display:flex;align-items:center;gap:8px;margin-top:${urgentesRitmo.length > 0 ? '14' : '4'}px">
          <span class="material-icons" style="color:var(--tint-orange-fg);font-size:18px">warning</span>
          <b style="font-size:13px;color:var(--text);letter-spacing:0.3px">Stock bajo configurado</b>
          <span style="font-size:11.5px;color:var(--text-muted)">— ${alertasConfig.length} ${alertasConfig.length === 1 ? 'producto' : 'productos'} con mínimo cargado</span>
        </div>`);
      partes.push(alertasConfig.map(filaConfig).join(''));
    }
    if (gruposAuto.length > 0) {
      partes.push(`
        <div style="display:flex;align-items:center;gap:8px;margin-top:${alertasConfig.length > 0 ? '14' : '4'}px">
          <span class="material-icons" style="color:var(--tint-orange-fg);font-size:18px">palette</span>
          <b style="font-size:13px;color:var(--text);letter-spacing:0.3px">Variantes bajas</b>
          <span style="font-size:11.5px;color:var(--text-muted)">— colores/talles con stock 0 o cerca de cero</span>
          <span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--text-muted);margin-left:auto">
            <span style="display:inline-block;width:10px;height:10px;border-radius:99px;background:#c62828"></span> Sin stock
            <span style="display:inline-block;width:10px;height:10px;border-radius:99px;background:#fb8c00;margin-left:6px"></span> Casi sin stock
          </span>
        </div>`);
      partes.push(gruposAuto.map(cardGrupo).join(''));
    }
    // Pie: productos ocultos por el usuario (con opción de restaurarlos).
    const nOcultos = obtenerIgnorados().length;
    if (nOcultos > 0) {
      partes.push(`
        <div style="display:flex;align-items:center;gap:8px;margin-top:14px;padding:10px 14px;background:var(--surface);border:1px dashed #d8dadf;border-radius:12px">
          <span class="material-icons" style="color:var(--text-muted);font-size:18px">visibility_off</span>
          <span style="flex:1;font-size:12.5px;color:var(--text-muted)">${nOcultos} ${nOcultos === 1 ? 'producto oculto' : 'productos ocultos'} de estas alertas</span>
          <button id="notifRestaurar" style="background:var(--surface);color:var(--primary);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">
            Mostrar de nuevo
          </button>
        </div>`);
    }

    listaBox.innerHTML = partes.join('');

    // Botones ver todas / ver menos de la sección urgente
    const btnTodas = listaBox.querySelector('#urgVerTodas');
    if (btnTodas) {
      btnTodas.addEventListener('mouseenter', () => { btnTodas.style.background = 'var(--tint-red-bg)'; });
      btnTodas.addEventListener('mouseleave', () => { btnTodas.style.background = 'var(--tint-red-bg)'; });
      btnTodas.addEventListener('click', () => { urgExpanded = true; renderAlertas(ultimasAlertas); });
    }
    const btnMenos = listaBox.querySelector('#urgVerMenos');
    if (btnMenos) {
      btnMenos.addEventListener('click', () => {
        urgExpanded = false;
        renderAlertas(ultimasAlertas);
        listaBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    // Hover sutil + click → editor del catálogo
    listaBox.querySelectorAll('.notif-row, .notif-group').forEach(row => {
      row.addEventListener('mouseenter', () => {
        row.style.boxShadow = '0 4px 14px rgba(0,0,0,0.08)';
        row.style.transform = 'translateY(-1px)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.boxShadow = 'none';
        row.style.transform = 'translateY(0)';
      });
      row.addEventListener('click', (e) => {
        const oc = e.target.closest('[data-ocultar]');
        if (oc) {                       // tocó el ojo: ocultar, no navegar
          e.preventDefault();
          e.stopPropagation();
          ignorarProducto(oc.dataset.ocultar);
          return;
        }
        const id = row.dataset.doc;
        if (id) irACatalogoYAbrir(id);
      });
    });

    // Hover del ícono ocultar (resalta sin disparar el hover de la fila)
    listaBox.querySelectorAll('.notif-ocultar').forEach(ic => {
      ic.addEventListener('mouseenter', () => { ic.style.color = 'var(--tint-red-fg)'; ic.style.background = 'var(--tint-red-bg)'; });
      ic.addEventListener('mouseleave', () => { ic.style.color = 'var(--text-muted)'; ic.style.background = 'transparent'; });
    });

    // Control de restaurar ocultos
    const btnRestaurar = listaBox.querySelector('#notifRestaurar');
    if (btnRestaurar) btnRestaurar.addEventListener('click', () => restaurarTodos());
  }

  renderPermiso();
  renderAlertas(obtenerAlertasActivas());

  // Refresca desde Firestore por si la página se abre antes de que init haya cargado
  refrescarAlertas().then(renderAlertas).catch(() => {});

  _unsub = onAlertasCambian((alertas) => {
    renderAlertas(alertas);
  });
}
