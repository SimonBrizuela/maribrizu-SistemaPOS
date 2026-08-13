/**
 * Calendario argentino para la librería — UI de la página.
 *
 * Toda la lógica (feriados, fechas comerciales, eventos propios de Firestore,
 * badge del sidebar, próximas fechas) vive en `calendario_core.js`. Este archivo
 * es solo la vista de la página y se carga lazy (chunk aparte).
 *
 * Navegación mes a mes con animación suave. Panel lateral con próximas fechas
 * y gestión de fechas/notas propias.
 */
import {
  MESES, DIAS, TIPOS, COLORES_NOTA, ICONOS_NOTA,
  evColor, evIcon, textoSobre, ymd, addDays, eventosDeAnio,
  ensureSub, subscribeEventos, agregarEvento, borrarEvento,
  customEnFecha, ocurrenciaEnAnio, _custom,
  refreshVencimientos, ensurePagosMes, vencimientosEnFecha,
} from './calendario_core.js';

// ── Estilos (inyectados una sola vez) ────────────────────────────────────────

function ensureStyles() {
  if (document.getElementById('cal-styles')) return;
  const s = document.createElement('style');
  s.id = 'cal-styles';
  s.textContent = `
    .cal-wrap { display:flex; gap:18px; align-items:stretch; overflow:hidden; }
    .cal-main { flex:1; min-width:0; min-height:0; height:100%;
                background:var(--surface);
                border:1px solid var(--border); border-radius:16px;
                box-shadow:0 1px 2px rgba(0,0,0,.04), 0 12px 30px -22px rgba(0,0,0,.5); display:flex; flex-direction:column; overflow:hidden; }
    .cal-head { display:flex; align-items:center; gap:8px; padding:14px 18px; color:var(--text);
                background:var(--surface); border-bottom:1px solid var(--border); position:relative; z-index:1; }
    .cal-title { font-size:20px; font-weight:800; color:var(--text); letter-spacing:-0.2px;
                 text-transform:capitalize; margin:0 auto 0 6px; }
    .cal-nav-btn { width:34px; height:34px; border-radius:10px; border:1px solid var(--border);
                   background:var(--surface-2); color:var(--text); cursor:pointer; display:flex;
                   align-items:center; justify-content:center; transition:border-color .15s, color .15s, transform .1s; }
    .cal-nav-btn:hover { border-color:var(--primary); color:var(--primary); }
    .cal-nav-btn:active { transform:scale(.92); }
    .cal-hoy { padding:8px 15px; border-radius:10px; border:none;
               background:var(--primary); color:#fff; font-weight:800; font-size:13px; cursor:pointer;
               font-family:inherit; transition:filter .15s; }
    .cal-hoy:hover { filter:brightness(1.08); }
    .cal-dow { display:grid; grid-template-columns:repeat(7,1fr); padding:12px 12px 2px; }
    .cal-dow span { text-align:center; font-size:11px; font-weight:800; letter-spacing:.6px;
                    color:var(--text-muted); text-transform:uppercase; padding-bottom:6px; }
    .cal-dow span:nth-child(6), .cal-dow span:nth-child(7) { color:#c06b86; }
    .cal-grid-clip { flex:1; min-height:0; overflow:hidden; padding:0 12px 12px; }
    .cal-grid { display:grid; grid-template-columns:repeat(7,1fr); grid-auto-rows:minmax(48px,1fr); gap:7px; height:100%; }
    .cal-cell { position:relative; border:1px solid var(--border); border-radius:10px; padding:6px 8px;
                background:var(--surface);
                display:flex; flex-direction:column; gap:4px; min-height:0;
                transition:background .15s, border-color .15s; overflow:hidden; }
    .cal-cell:hover { border-color:var(--primary); background:var(--surface-2); }
    .cal-cell-add { position:absolute; top:5px; left:6px; width:21px; height:21px; border:none; border-radius:7px;
                    background:var(--surface-3); color:var(--primary); cursor:pointer; padding:0;
                    display:flex; align-items:center; justify-content:center; opacity:0;
                    transition:opacity .15s, background .15s, color .15s; }
    .cal-cell:hover .cal-cell-add { opacity:1; }
    .cal-cell-add:hover { background:var(--primary); color:#fff; }
    @media (hover:none) { .cal-cell-add { opacity:.55; } }   /* táctil: visible siempre */
    .cal-cell.otro { background:var(--surface-2); }
    .cal-cell.otro .cal-num { color:var(--text-muted); opacity:.6; }
    .cal-cell.finde .cal-num { color:var(--tint-orange-fg); }
    .cal-num { font-size:13px; font-weight:800; color:var(--text); align-self:flex-end; line-height:1; }
    .cal-cell.hoy { border:1.5px solid var(--primary); background:var(--tint-purple-bg); }
    .cal-cell.hoy .cal-num { background:var(--primary); color:#fff; border-radius:50%;
                             width:22px; height:22px; display:flex; align-items:center; justify-content:center; }
    .cal-chip { font-size:11px; font-weight:700; color:#fff; border-radius:6px; padding:3px 7px;
                line-height:1.25; display:flex; align-items:flex-start; gap:4px; }
    .cal-chip-ic { font-size:13px; line-height:1.2; flex-shrink:0; opacity:.95; }
    .cal-chip-tx { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
                   overflow:hidden; word-break:break-word; }
    .cal-mas { font-size:10px; font-weight:800; color:var(--text-muted); padding-left:3px; }
    .cal-grid.enter-next { animation:calNext .3s cubic-bezier(.22,.61,.36,1); }
    .cal-grid.enter-prev { animation:calPrev .3s cubic-bezier(.22,.61,.36,1); }
    @keyframes calNext { from { opacity:0; transform:translateX(30px) scale(.99); } to { opacity:1; transform:translateX(0) scale(1); } }
    @keyframes calPrev { from { opacity:0; transform:translateX(-30px) scale(.99); } to { opacity:1; transform:translateX(0) scale(1); } }

    .cal-side { width:320px; flex-shrink:0; height:100%; min-height:0; overflow-y:auto; overflow-x:hidden;
                display:flex; flex-direction:column; gap:14px; padding-right:2px; }
    .cal-side::-webkit-scrollbar { width:7px; }
    .cal-side::-webkit-scrollbar-thumb { background:var(--tint-purple-bg); border-radius:99px; }
    .cal-card { background:var(--surface);
                border:1px solid var(--border); border-radius:14px;
                box-shadow:0 1px 2px rgba(0,0,0,.04); padding:15px 16px; }
    .cal-card h3 { font-size:12px; font-weight:800; letter-spacing:.6px; text-transform:uppercase;
                   color:var(--primary); margin-bottom:12px; display:flex; align-items:center; gap:6px; }
    .cal-prox { display:flex; flex-direction:column; gap:9px; }
    .cal-prox-item { display:flex; align-items:center; gap:11px; padding:8px 10px; border-radius:10px;
                     background:var(--surface-2); border:1px solid var(--border);
                     transition:border-color .15s; cursor:default; }
    .cal-prox-item:hover { border-color:var(--primary); }
    .cal-prox-fecha { width:46px; flex-shrink:0; text-align:center; border-radius:9px; padding:5px 0; color:#fff;
                      display:flex; flex-direction:column; align-items:center; justify-content:center; }
    .cal-prox-dia { font-size:18px; font-weight:800; line-height:1; }
    .cal-prox-mes { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; opacity:.92; }
    .cal-prox-nombre { font-size:13px; font-weight:700; color:var(--text); line-height:1.25; }
    .cal-prox-cuando { font-size:11px; color:var(--text-muted); margin-top:1px; }
    .cal-add-btn { margin-left:auto; display:inline-flex; align-items:center; gap:4px; padding:5px 11px;
                   border-radius:9px; border:none; background:linear-gradient(135deg,#7b3fa6,#9a55c6); color:#fff;
                   font-size:11.5px; font-weight:800; cursor:pointer; font-family:inherit; text-transform:none;
                   letter-spacing:0; box-shadow:0 3px 9px rgba(123,63,166,.3); transition:filter .15s, transform .1s; }
    .cal-add-btn:hover { filter:brightness(1.08); }
    .cal-add-btn:active { transform:scale(.95); }
    .cal-form { display:flex; flex-direction:column; gap:10px; margin-bottom:12px; padding:12px;
                background:var(--surface-2); border:1px solid var(--border); border-radius:12px; }
    .cal-pick-label { font-size:11px; font-weight:800; letter-spacing:.4px; text-transform:uppercase;
                      color:var(--text-muted); margin-bottom:4px; }
    .cal-swatches { display:flex; flex-wrap:wrap; gap:7px; }
    .cal-swatch { width:24px; height:24px; border-radius:50%; cursor:pointer; border:2px solid transparent;
                  box-shadow:0 0 0 1px var(--border); transition:transform .1s; }
    .cal-swatch:hover { transform:scale(1.12); }
    .cal-swatch.sel { border-color:var(--surface); box-shadow:0 0 0 2px var(--text); }
    .cal-icons { display:flex; flex-wrap:wrap; gap:6px; }
    .cal-iconbtn { width:32px; height:32px; border-radius:9px; border:1px solid var(--border);
                   background:var(--surface); color:var(--text-muted); cursor:pointer; display:flex;
                   align-items:center; justify-content:center; transition:border-color .12s, color .12s, background .12s; }
    .cal-iconbtn .material-icons { font-size:18px; }
    .cal-iconbtn:hover { color:var(--text); border-color:var(--primary); }
    .cal-iconbtn.sel { background:var(--primary); color:#fff; border-color:var(--primary); }
    .cal-form input[type=text], .cal-form input[type=date], .cal-form select {
      width:100%; padding:8px 10px; border:1px solid var(--border); border-radius:9px; font-size:13px;
      font-family:inherit; color:var(--text); background:var(--surface); }
    .cal-form input:focus, .cal-form select:focus { outline:none; border-color:var(--primary); }
    .cal-form-row { display:flex; gap:8px; }
    .cal-form-row > * { flex:1; }
    .cal-form-chk { display:flex; align-items:center; gap:7px; font-size:12.5px; color:var(--text-muted); font-weight:600; cursor:pointer; }
    .cal-form-acc { display:flex; gap:8px; }
    .cal-form-acc button { flex:1; padding:8px; border-radius:9px; font-size:12.5px; font-weight:800;
                           cursor:pointer; font-family:inherit; border:1px solid var(--border); }
    .cal-form-guardar { background:var(--primary); color:#fff; border-color:var(--primary)!important; }
    .cal-form-guardar:hover { background:var(--primary-dark); }
    .cal-form-cancelar { background:var(--surface); color:var(--text-muted); }
    .cal-mis-item { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:10px;
                    background:var(--surface-2); border:1px solid var(--border); }
    .cal-mis-fecha { font-size:11px; font-weight:800; color:#fff; border-radius:7px; padding:3px 8px; white-space:nowrap; flex-shrink:0; }
    .cal-mis-nombre { flex:1; min-width:0; font-size:13px; font-weight:700; color:var(--text);
                      line-height:1.25; overflow-wrap:anywhere; }
    .cal-mis-del { flex-shrink:0; border:none; background:transparent; color:var(--text-muted); cursor:pointer;
                   border-radius:8px; padding:4px; display:flex; transition:color .15s, background .15s; }
    .cal-mis-del:hover { color:var(--danger); background:var(--tint-red-bg); }
    .cal-mis-vacio { font-size:12.5px; color:var(--text-muted); text-align:center; padding:8px 4px; }
    .cal-leyenda { display:flex; flex-wrap:wrap; gap:9px 14px; }
    .cal-leyenda span { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; color:var(--text-muted); font-weight:600; }
    .cal-dot { width:11px; height:11px; border-radius:50%; flex-shrink:0; box-shadow:0 1px 3px rgba(0,0,0,.15); }
    @media (max-width: 920px) {
      .cal-wrap { flex-direction:column; height:auto !important; overflow:visible; }
      .cal-side { width:auto; height:auto; overflow:visible; }
      .cal-main { height:auto; min-height:60vh; }
    }
    @media (max-width: 560px) {
      .cal-wrap { gap:12px; }
      .cal-head { padding:12px 12px; gap:8px; }
      .cal-title { font-size:17px; }
      .cal-nav-btn { width:34px; height:34px; }
      .cal-hoy { padding:7px 12px; }
      .cal-dow { padding:8px 8px 0; }
      .cal-grid-clip { padding:0 8px 8px; }
      .cal-grid { gap:4px; }
      .cal-cell { min-height:54px; border-radius:9px; padding:4px 5px; gap:3px; }
      .cal-num { font-size:12px; }
      .cal-chip { font-size:9.5px; padding:2px 5px; border-radius:6px; gap:3px; }
      .cal-chip-ic { font-size:11px; }
      .cal-chip-tx { -webkit-line-clamp:1; }
    }
    @media (max-width: 380px) {
      .cal-chip-tx { display:none; }   /* pantallas muy chicas: solo el ícono de color */
      .cal-chip { padding:3px 5px; }
    }
  `;
  document.head.appendChild(s);
}

// ── Render ────────────────────────────────────────────────────────────────────

export async function renderCalendario(container, db) {
  ensureStyles();
  ensureSub(db);   // setea _db en el core + arranca la suscripción si hace falta

  const hoy = new Date();
  const hoyYmd = ymd(hoy);
  let viewY = hoy.getFullYear();
  let viewM = hoy.getMonth();   // 0-indexado

  container.innerHTML = `
    <div class="cal-wrap">
      <div class="cal-main">
        <div class="cal-head">
          <button class="cal-nav-btn" id="calPrev" aria-label="Mes anterior"><span class="material-icons">chevron_left</span></button>
          <button class="cal-nav-btn" id="calNext" aria-label="Mes siguiente"><span class="material-icons">chevron_right</span></button>
          <div class="cal-title" id="calTitulo"></div>
          <button class="cal-hoy" id="calHoy">Hoy</button>
        </div>
        <div class="cal-dow">${DIAS.map(d => `<span>${d}</span>`).join('')}</div>
        <div class="cal-grid-clip"><div class="cal-grid" id="calGrid"></div></div>
      </div>
      <div class="cal-side">
        <div class="cal-card">
          <h3>
            <span class="material-icons" style="font-size:16px">star</span>Mis fechas / notas
            <button class="cal-add-btn" id="calAddBtn"><span class="material-icons" style="font-size:15px">add</span>Agregar</button>
          </h3>
          <div class="cal-form" id="calForm" style="display:none">
            <input type="text" id="calEvNombre" placeholder="Nota o fecha importante…" maxlength="80" />
            <input type="date" id="calEvFecha" />
            <div>
              <div class="cal-pick-label">Color</div>
              <div class="cal-swatches" id="calSwatches"></div>
            </div>
            <div>
              <div class="cal-pick-label">Ícono</div>
              <div class="cal-icons" id="calIcons"></div>
            </div>
            <label class="cal-form-chk"><input type="checkbox" id="calEvAnual" /> Se repite todos los años</label>
            <div class="cal-form-acc">
              <button class="cal-form-cancelar" id="calEvCancelar">Cancelar</button>
              <button class="cal-form-guardar" id="calEvGuardar">Guardar</button>
            </div>
          </div>
          <div class="cal-prox" id="calMis"></div>
        </div>
        <div class="cal-card">
          <h3><span class="material-icons" style="font-size:16px">event_upcoming</span>Próximas fechas</h3>
          <div class="cal-prox" id="calProx"></div>
        </div>
        <div class="cal-card">
          <h3><span class="material-icons" style="font-size:16px">palette</span>Referencias</h3>
          <div class="cal-leyenda">
            ${Object.values(TIPOS).map(t => `<span><span class="cal-dot" style="background:${t.color}"></span>${t.label}</span>`).join('')}
          </div>
        </div>
      </div>
    </div>
  `;

  const grid = container.querySelector('#calGrid');
  const titulo = container.querySelector('#calTitulo');
  const wrap = container.querySelector('.cal-wrap');

  // Ajusta la altura del calendario al espacio real disponible para que entre
  // todo sin scroll de página, en cualquier pantalla. En layout apilado
  // (≤920px) se deja crecer natural.
  function ajustarAltura() {
    if (!document.body.contains(wrap)) return;
    if (window.innerWidth <= 920) { wrap.style.height = 'auto'; return; }
    const top = wrap.getBoundingClientRect().top;          // distancia desde el tope del viewport
    const h = window.innerHeight - top - 18;               // respiro inferior
    wrap.style.height = Math.max(440, h) + 'px';
  }
  const onResize = () => ajustarAltura();
  window.addEventListener('resize', onResize);

  function pintarMes(dir) {
    const mapa = eventosDeAnio(viewY);
    titulo.textContent = `${MESES[viewM]} ${viewY}`;

    // Estado pagado/pendiente de los vencimientos del mes visto: se carga una
    // sola vez por mes (doc de días del Balance) y se repinta al llegar.
    const ymView = `${viewY}-${String(viewM + 1).padStart(2, '0')}`;
    ensurePagosMes(ymView).then(fresh => {
      if (fresh && ymView === `${viewY}-${String(viewM + 1).padStart(2, '0')}`) pintarMes(0);
    });

    // Primer día de la grilla: lunes de la semana del día 1.
    const primero = new Date(viewY, viewM, 1);
    const desplaz = (primero.getDay() + 6) % 7;   // 0=lunes
    const inicio = addDays(primero, -desplaz);

    let html = '';
    for (let i = 0; i < 42; i++) {
      const d = addDays(inicio, i);
      const esOtro = d.getMonth() !== viewM;
      const finde = d.getDay() === 0 || d.getDay() === 6;
      const key = ymd(d);
      // Vencimientos primero: son accionables y no pueden quedar tapados por chips de feriados.
      const evs = [...vencimientosEnFecha(key), ...(mapa.get(key) || []), ...customEnFecha(key)];
      const clases = ['cal-cell'];
      if (esOtro) clases.push('otro');
      if (finde) clases.push('finde');
      if (key === hoyYmd) clases.push('hoy');

      const chips = evs.slice(0, 2).map(e => {
        const c = evColor(e);
        return `<span class="cal-chip" style="background:${c};color:${textoSobre(c)}" title="${escapeAttr(e.nombre)}">`
          + `<span class="material-icons cal-chip-ic">${evIcon(e)}</span>`
          + `<span class="cal-chip-tx">${escapeHtml(e.nombre)}</span></span>`;
      }).join('');
      const extra = evs.length > 2 ? `<span class="cal-mas">+${evs.length - 2} más</span>` : '';

      html += `<div class="${clases.join(' ')}" data-fecha="${key}">
        <button class="cal-cell-add" data-add="${key}" title="Agregar nota / fecha acá" tabindex="-1"><span class="material-icons" style="font-size:15px">add</span></button>
        <span class="cal-num">${d.getDate()}</span>
        ${chips}${extra}
      </div>`;
    }
    grid.innerHTML = html;

    // Animación de entrada según dirección
    grid.classList.remove('enter-next', 'enter-prev');
    if (dir) {
      void grid.offsetWidth;   // reflow para reiniciar la animación
      grid.classList.add(dir > 0 ? 'enter-next' : 'enter-prev');
    }
  }

  function diffTexto(fechaStr) {
    const [y, m, d] = fechaStr.split('-').map(Number);
    const f = new Date(y, m - 1, d);
    const base = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    const dias = Math.round((f - base) / 86400000);
    if (dias === 0) return 'Hoy';
    if (dias === 1) return 'Mañana';
    if (dias < 0) return `Hace ${-dias} días`;
    if (dias < 7) return `En ${dias} días`;
    if (dias < 30) return `En ${Math.round(dias / 7)} sem.`;
    return `En ${Math.round(dias / 30)} meses`;
  }

  function pintarProximas() {
    const box = container.querySelector('#calProx');
    // Junta eventos de este año y el próximo (oficiales + propios), toma los 8 desde hoy.
    const todos = [];
    const vistos = new Set();
    const push = (e) => {
      const k = e.fecha + '|' + e.nombre;
      if (vistos.has(k)) return;   // evita duplicar (eventos no anuales se repetían por año)
      vistos.add(k); todos.push(e);
    };
    for (const y of [hoy.getFullYear(), hoy.getFullYear() + 1]) {
      for (const evs of eventosDeAnio(y).values()) for (const e of evs) push(e);
      for (const e of _custom) push({ fecha: ocurrenciaEnAnio(e, y), nombre: e.nombre, tipo: e.tipo, color: e.color, icon: e.icon, nota: e.anual ? 'Cada año' : '' });
    }
    // Vencimientos de gastos fijos de los próximos 60 días (los pagados no se listan).
    const base = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    for (let i = 0; i < 60; i++) {
      for (const v of vencimientosEnFecha(ymd(addDays(base, i)))) if (!v.pagado) push(v);
    }
    const prox = todos
      .filter(e => e.fecha >= hoyYmd)
      .sort((a, b) => a.fecha.localeCompare(b.fecha))
      .slice(0, 8);

    box.innerHTML = prox.map(e => {
      const [yy, mm, dd] = e.fecha.split('-');
      const c = evColor(e);
      return `<div class="cal-prox-item">
        <div class="cal-prox-fecha" style="background:${c};color:${textoSobre(c)}">
          <div class="cal-prox-dia">${Number(dd)}</div>
          <div class="cal-prox-mes">${MESES[Number(mm) - 1].slice(0, 3)}</div>
        </div>
        <div style="min-width:0">
          <div class="cal-prox-nombre">${escapeHtml(e.nombre)}</div>
          <div class="cal-prox-cuando">${diffTexto(e.fecha)}${e.nota ? ' · ' + escapeHtml(e.nota) : ''}</div>
        </div>
      </div>`;
    }).join('');
  }

  function pintarMisFechas() {
    const box = container.querySelector('#calMis');
    if (!box) return;
    if (_custom.length === 0) {
      box.innerHTML = `<div class="cal-mis-vacio">Todavía no agregaste fechas ni notas.<br>Tocá un día o "Agregar".</div>`;
      return;
    }
    // Orden por próxima ocurrencia (anual → este año/el que viene; única → su fecha).
    const conFecha = _custom.map(e => {
      const occ = e.anual ? ocurrenciaEnAnio(e, hoy.getFullYear()) : e.fecha;
      const occOrd = (occ >= hoyYmd || !e.anual) ? occ : ocurrenciaEnAnio(e, hoy.getFullYear() + 1);
      return { e, occOrd };
    }).sort((a, b) => a.occOrd.localeCompare(b.occOrd));

    box.innerHTML = conFecha.map(({ e }) => {
      const [, mm, dd] = (e.anual ? ('0000-' + e.fecha) : e.fecha).split('-');
      const c = evColor(e);
      return `<div class="cal-mis-item">
        <span class="cal-mis-fecha" style="background:${c};color:${textoSobre(c)};display:inline-flex;align-items:center;gap:4px">
          <span class="material-icons" style="font-size:13px">${evIcon(e)}</span>${Number(dd)} ${MESES[Number(mm) - 1].slice(0, 3)}${e.anual ? ' ·↻' : ''}</span>
        <span class="cal-mis-nombre">${escapeHtml(e.nombre)}</span>
        <button class="cal-mis-del" data-del="${escapeAttr(e.id)}" title="Borrar"><span class="material-icons" style="font-size:18px">delete_outline</span></button>
      </div>`;
    }).join('');

    box.querySelectorAll('.cal-mis-del').forEach(b => {
      b.addEventListener('click', () => borrarEvento(b.dataset.del));   // el listener re-renderiza
    });
  }

  function refrescarTodo() {
    pintarMes(0);
    pintarProximas();
    pintarMisFechas();
  }

  // ── Formulario de agregar ──
  const form = container.querySelector('#calForm');
  const inpNombre = container.querySelector('#calEvNombre');
  const inpFecha = container.querySelector('#calEvFecha');
  const inpAnual = container.querySelector('#calEvAnual');
  const swatchesBox = container.querySelector('#calSwatches');
  const iconsBox = container.querySelector('#calIcons');

  // Selector de color e ícono para la nota.
  let selColor = COLORES_NOTA[0];
  let selIcon = ICONOS_NOTA[0];
  swatchesBox.innerHTML = COLORES_NOTA.map(c =>
    `<button type="button" class="cal-swatch${c === selColor ? ' sel' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('');
  iconsBox.innerHTML = ICONOS_NOTA.map(ic =>
    `<button type="button" class="cal-iconbtn${ic === selIcon ? ' sel' : ''}" data-icon="${ic}"><span class="material-icons">${ic}</span></button>`).join('');
  swatchesBox.querySelectorAll('.cal-swatch').forEach(b => b.addEventListener('click', () => {
    selColor = b.dataset.color;
    swatchesBox.querySelectorAll('.cal-swatch').forEach(x => x.classList.toggle('sel', x === b));
  }));
  iconsBox.querySelectorAll('.cal-iconbtn').forEach(b => b.addEventListener('click', () => {
    selIcon = b.dataset.icon;
    iconsBox.querySelectorAll('.cal-iconbtn').forEach(x => x.classList.toggle('sel', x === b));
  }));

  function abrirForm(fechaStr) {
    form.style.display = 'flex';
    inpFecha.value = fechaStr || ymd(hoy);
    inpNombre.focus();
  }
  function cerrarForm() {
    form.style.display = 'none';
    inpNombre.value = '';
    inpAnual.checked = false;
  }
  container.querySelector('#calAddBtn').addEventListener('click', () => {
    if (form.style.display !== 'none') { cerrarForm(); return; }
    // Default: hoy si estamos en el mes actual; si no, el día 1 del mes mirado.
    const enMesActual = (viewY === hoy.getFullYear() && viewM === hoy.getMonth());
    abrirForm(enMesActual ? ymd(hoy) : ymd(new Date(viewY, viewM, 1)));
  });
  container.querySelector('#calEvCancelar').addEventListener('click', cerrarForm);
  container.querySelector('#calEvGuardar').addEventListener('click', () => {
    const nombre = inpNombre.value.trim();
    const fecha = inpFecha.value;
    if (!nombre) { inpNombre.focus(); return; }
    if (!fecha) { inpFecha.focus(); return; }
    agregarEvento({ nombre, fecha, tipo: 'personal', anual: inpAnual.checked, color: selColor, icon: selIcon });
    cerrarForm();   // el listener de Firestore re-renderiza al confirmar el guardado
  });
  inpNombre.addEventListener('keydown', (e) => { if (e.key === 'Enter') container.querySelector('#calEvGuardar').click(); });

  // Solo el botón "+" de cada celda abre el form (tocar el día NO hace nada,
  // para no abrirlo sin querer).
  grid.addEventListener('click', (e) => {
    const add = e.target.closest('.cal-cell-add');
    if (!add) return;
    abrirForm(add.dataset.add);
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  function ir(delta) {
    viewM += delta;
    if (viewM < 0) { viewM = 11; viewY--; }
    else if (viewM > 11) { viewM = 0; viewY++; }
    pintarMes(delta);
  }

  container.querySelector('#calPrev').addEventListener('click', () => ir(-1));
  container.querySelector('#calNext').addEventListener('click', () => ir(1));
  container.querySelector('#calHoy').addEventListener('click', () => {
    const dir = (viewY * 12 + viewM) > (hoy.getFullYear() * 12 + hoy.getMonth()) ? -1 : 1;
    viewY = hoy.getFullYear(); viewM = hoy.getMonth();
    pintarMes(dir);
  });

  // Teclado: flechas para navegar meses
  const onKey = (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (e.key === 'ArrowLeft') ir(-1);
    else if (e.key === 'ArrowRight') ir(1);
  };
  document.addEventListener('keydown', onKey);
  // Limpieza al salir de la página (el contenedor se vacía al navegar)
  const obs = new MutationObserver(() => {
    if (!document.body.contains(grid)) {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      offEventos();   // saca solo este render; el listener global sigue para el aviso del sidebar
      obs.disconnect();
    }
  });
  obs.observe(container, { childList: true });

  // Primer pintado con lo que haya en cache; el listener de Firestore vuelve a
  // pintar al traer/actualizar los eventos propios (en vivo entre PCs).
  const offEventos = subscribeEventos(refrescarTodo);
  refrescarTodo();
  // Vencimientos de gastos fijos (Balance): carga async → notifica y repinta.
  refreshVencimientos(db);
  ajustarAltura();
  // Reajuste tras el layout inicial (fuentes/scrollbars ya asentados).
  requestAnimationFrame(ajustarAltura);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
