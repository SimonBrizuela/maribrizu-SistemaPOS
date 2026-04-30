/**
 * Página: Presupuestos
 * Lista de cotizaciones generadas desde el POS o el webapp.
 * Sincronización en tiempo real con Firestore (collection `presupuestos`).
 *
 * El PDF se genera en el browser con un layout HTML imprimible (window.print)
 * que respeta la identidad de marca (mismo diseño que el PDF del POS).
 */

import {
  collection, query, orderBy, limit, onSnapshot, doc, updateDoc,
} from 'firebase/firestore';

import { getSession } from '../auth.js';

const COL = 'presupuestos';
let _unsub = null;

const ESTADO_LABEL = {
  pendiente:  'Pendiente',
  vencido:    'Vencido',
  convertido: 'Convertido',
  anulado:    'Anulado',
};
const ESTADO_COLOR = {
  pendiente:  { bg: '#fff8ee', fg: '#c1521f' },
  vencido:    { bg: '#f0f0f0', fg: '#65676b' },
  convertido: { bg: '#e8f6ec', fg: '#2e7d32' },
  anulado:    { bg: '#fff0f0', fg: '#c0392b' },
};

function fmtMoney(v) {
  const n = Number(v || 0);
  return '$ ' + n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtNum(v) {
  return 'P-' + String(v || 0).padStart(5, '0');
}
function fmtDate(s) {
  if (!s) return '—';
  const d = String(s).slice(0, 10);
  const parts = d.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return s;
}
function fmtDateTime(s) {
  if (!s) return '—';
  const raw = String(s);
  const d = raw.slice(0, 10);
  const t = raw.slice(11, 16);
  const parts = d.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]} ${t}`.trim();
  return raw.slice(0, 16);
}
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function fmtQty(q) {
  const n = Number(q || 0);
  return n === Math.floor(n) ? String(Math.floor(n)) : String(n).replace('.', ',');
}

export async function renderPresupuestos(container, db) {
  if (_unsub) { try { _unsub(); } catch(_){} _unsub = null; }

  const session = getSession() || {};
  const myName = session.display || session.username || 'Web';

  let allPresupuestos = [];
  let estadoFilter = null; // null = todos
  let searchText = '';

  container.innerHTML = `
    <div class="presupuestos-page">
      <div class="pres-header">
        <div>
          <h2 class="pres-title">Presupuestos</h2>
          <p class="pres-sub">Cotizaciones generadas desde el POS y el webapp.</p>
        </div>
        <div class="pres-search-wrap">
          <input id="presSearch" class="pres-search" type="text" placeholder="Buscar por cliente o número…" />
        </div>
      </div>

      <div class="pres-chips" id="presChips"></div>

      <div class="pres-stats" id="presStats"></div>

      <div class="pres-table-wrap">
        <table class="pres-table">
          <thead>
            <tr>
              <th>Número</th>
              <th>Fecha</th>
              <th>Cliente</th>
              <th class="num">Items</th>
              <th class="num">Total</th>
              <th>Validez</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="presBody">
            <tr><td colspan="8" class="pres-empty">Cargando…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <style>
      .presupuestos-page { max-width: 1280px; margin: 0 auto; padding: 8px 4px 24px; }
      .pres-header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; margin-bottom:14px; }
      .pres-title { margin:0; font-size:22px; font-weight:700; color:var(--text); }
      .pres-sub { margin:4px 0 0; color:var(--text-muted); font-size:13px; }
      .pres-search { padding:9px 12px; border:1px solid var(--border); border-radius:8px; font-size:13px; min-width:280px; font-family:inherit; }
      .pres-search:focus { outline:none; border-color:var(--primary); }

      .pres-chips { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
      .pres-chip { padding:7px 16px; border-radius:18px; font-size:12px; font-weight:600; cursor:pointer; border:1px solid var(--border); background:#f0f2f5; color:var(--text); user-select:none; transition:all .15s; }
      .pres-chip:hover { background:#e4e6eb; }
      .pres-chip.active { background:var(--primary); color:white; border-color:var(--primary); font-weight:700; }
      .pres-chip-count { background:rgba(255,255,255,.25); padding:1px 7px; border-radius:10px; margin-left:6px; font-size:10px; }
      .pres-chip:not(.active) .pres-chip-count { background:rgba(0,0,0,0.08); color:var(--text-muted); }

      .pres-stats { color:var(--text-muted); font-size:12px; margin-bottom:8px; }

      .pres-table-wrap { background:white; border:1px solid var(--border); border-radius:10px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.04); }
      .pres-table { width:100%; border-collapse:collapse; font-size:13px; }
      .pres-table thead tr { background:#fafafa; border-bottom:1px solid var(--border); }
      .pres-table th { padding:10px 12px; text-align:left; font-weight:600; color:var(--text-muted); font-size:11px; text-transform:uppercase; letter-spacing:.3px; }
      .pres-table th.num, .pres-table td.num { text-align:right; }
      .pres-table tbody tr { border-bottom:1px solid var(--border); cursor:pointer; transition:background .1s; }
      .pres-table tbody tr:hover { background:#faf6ff; }
      .pres-table tbody tr:last-child { border-bottom:none; }
      .pres-table td { padding:10px 12px; }
      .pres-num { font-weight:700; color:var(--primary); }
      .pres-empty { text-align:center; padding:40px 16px; color:var(--text-muted); }
      .pres-estado { display:inline-block; padding:3px 9px; border-radius:11px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.3px; }

      .pres-row-action { background:none; border:none; cursor:pointer; padding:4px 8px; color:var(--primary); border-radius:5px; font-size:12px; font-family:inherit; font-weight:600; }
      .pres-row-action:hover { background:#faf6ff; }

      /* Modal detalle */
      .pres-modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:1000; padding:20px; }
      .pres-modal { background:white; border-radius:14px; max-width:780px; width:100%; max-height:90vh; overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,0.3); }
      .pres-modal-header { padding:18px 22px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
      .pres-modal-title { font-size:20px; font-weight:700; color:var(--primary); margin:0; }
      .pres-modal-close { background:none; border:none; font-size:22px; cursor:pointer; color:var(--text-muted); padding:4px 10px; border-radius:6px; }
      .pres-modal-close:hover { background:#f0f2f5; color:var(--text); }
      .pres-modal-body { padding:18px 22px; }

      .pres-meta { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px 18px; margin-bottom:14px; }
      .pres-meta-item { font-size:12px; }
      .pres-meta-item span { display:block; color:var(--text-muted); font-size:10px; text-transform:uppercase; letter-spacing:.4px; margin-bottom:1px; }
      .pres-meta-item b { font-size:13px; color:var(--text); }

      .pres-cliente-box { background:#faf6ff; border-left:3px solid var(--primary); padding:10px 14px; border-radius:6px; margin-bottom:14px; }
      .pres-cliente-box h4 { margin:0 0 4px; font-size:11px; color:var(--primary); text-transform:uppercase; letter-spacing:.4px; }
      .pres-cliente-box .name { font-size:14px; font-weight:700; color:var(--text); }
      .pres-cliente-box .extra { font-size:12px; color:var(--text-muted); margin-top:2px; }

      .pres-items-table { width:100%; border-collapse:collapse; font-size:12px; margin-bottom:14px; }
      .pres-items-table thead { background:var(--primary); color:white; }
      .pres-items-table th { padding:7px 10px; text-align:left; font-weight:600; font-size:11px; }
      .pres-items-table th.num, .pres-items-table td.num { text-align:right; }
      .pres-items-table td { padding:7px 10px; border-bottom:1px solid #f0f0f0; }
      .pres-items-table tbody tr:nth-child(even) { background:#faf6ff; }

      .pres-totales { text-align:right; font-size:14px; }
      .pres-totales .total-final { font-size:18px; font-weight:700; color:var(--primary); margin-top:4px; }

      .pres-modal-actions { padding:14px 22px; border-top:1px solid var(--border); display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap; }
      .pres-btn { padding:9px 18px; border-radius:7px; font-size:13px; font-weight:600; cursor:pointer; border:none; font-family:inherit; }
      .pres-btn-primary { background:var(--primary); color:white; }
      .pres-btn-primary:hover { background:#6a1b9a; }
      .pres-btn-secondary { background:#f0f2f5; color:var(--text); border:1px solid var(--border); }
      .pres-btn-secondary:hover { background:#e4e6eb; }
      .pres-btn-danger { background:#fff0f0; color:#c0392b; border:1px solid #f5c6cb; }
      .pres-btn-danger:hover { background:#ffd9d9; }
      .pres-btn-danger-outline { background:white; color:#c0392b; border:1px solid #c0392b; }
      .pres-btn-danger-outline:hover { background:#c0392b; color:white; }

      @media (max-width:768px) {
        .pres-header { flex-direction:column; }
        .pres-search { min-width:auto; width:100%; }
        .pres-table-wrap { overflow-x:auto; }
        .pres-table { min-width:780px; }
      }
    </style>
  `;

  // ── Subscribe en tiempo real ─────────────────────────────────────────────
  const q = query(
    collection(db, COL),
    orderBy('fecha_emision', 'desc'),
    limit(500),
  );
  _unsub = onSnapshot(q, (snap) => {
    allPresupuestos = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p => !p.deleted);
    render();
  }, (err) => {
    console.error('Error suscribiendo a presupuestos:', err);
    document.getElementById('presBody').innerHTML =
      `<tr><td colspan="8" class="pres-empty">Error: ${escHtml(err.message)}</td></tr>`;
  });

  // ── Render con filtros ───────────────────────────────────────────────────
  function render() {
    // Aplicar filtros
    const term = searchText.toLowerCase();
    let filtered = allPresupuestos;
    if (estadoFilter) {
      filtered = filtered.filter(p => p.estado === estadoFilter);
    }
    if (term) {
      filtered = filtered.filter(p => {
        const num = String(p.numero || '');
        const cli = String(p.cliente_nombre || '').toLowerCase();
        return num.includes(term) || cli.includes(term);
      });
    }

    renderChips();
    renderStats(filtered.length);
    renderRows(filtered);
  }

  function renderChips() {
    const counts = { all: allPresupuestos.length };
    ['pendiente','vencido','convertido','anulado'].forEach(e => {
      counts[e] = allPresupuestos.filter(p => p.estado === e).length;
    });
    const chips = [
      { key: null,         label: 'Todos',       count: counts.all },
      { key: 'pendiente',  label: 'Pendientes',  count: counts.pendiente },
      { key: 'vencido',    label: 'Vencidos',    count: counts.vencido },
      { key: 'convertido', label: 'Convertidos', count: counts.convertido },
      { key: 'anulado',    label: 'Anulados',    count: counts.anulado },
    ];
    document.getElementById('presChips').innerHTML = chips.map(c => {
      const active = c.key === estadoFilter;
      return `<span class="pres-chip ${active ? 'active' : ''}" data-estado="${c.key ?? ''}">
        ${c.label}<span class="pres-chip-count">${c.count}</span>
      </span>`;
    }).join('');
    document.querySelectorAll('.pres-chip').forEach(el => {
      el.addEventListener('click', () => {
        const k = el.dataset.estado;
        estadoFilter = k === '' ? null : k;
        render();
      });
    });
  }

  function renderStats(n) {
    document.getElementById('presStats').textContent = `${n} resultados`;
  }

  function renderRows(rows) {
    const body = document.getElementById('presBody');
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="8" class="pres-empty">Sin presupuestos para mostrar.</td></tr>`;
      return;
    }
    body.innerHTML = rows.map(p => {
      const e = p.estado || 'pendiente';
      const c = ESTADO_COLOR[e] || ESTADO_COLOR.pendiente;
      const itemsCount = (p.items || []).length;
      return `<tr data-id="${p.id}">
        <td><span class="pres-num">${fmtNum(p.numero)}</span></td>
        <td>${fmtDateTime(p.fecha_emision)}</td>
        <td>${escHtml(p.cliente_nombre || 'Consumidor Final')}</td>
        <td class="num">${itemsCount}</td>
        <td class="num"><b>${fmtMoney(p.total)}</b></td>
        <td>${fmtDate(p.fecha_validez)}</td>
        <td><span class="pres-estado" style="background:${c.bg};color:${c.fg}">${ESTADO_LABEL[e] || e}</span></td>
        <td><button class="pres-row-action" data-action="open" data-id="${p.id}">Ver detalle</button></td>
      </tr>`;
    }).join('');

    // Click en fila o en botón → abrir modal
    body.querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', (ev) => {
        const id = tr.dataset.id;
        const pres = allPresupuestos.find(p => p.id === id);
        if (pres) openModal(pres);
        ev.stopPropagation();
      });
    });
  }

  // Búsqueda
  document.getElementById('presSearch').addEventListener('input', (ev) => {
    searchText = ev.target.value.trim();
    render();
  });
}

// ── Modal de detalle ────────────────────────────────────────────────────────
function openModal(pres) {
  // Cerrar otros modales si los hubiera
  document.querySelectorAll('.pres-modal-overlay').forEach(el => el.remove());

  const e = pres.estado || 'pendiente';
  const c = ESTADO_COLOR[e] || ESTADO_COLOR.pendiente;
  const items = pres.items || [];

  const cliExtras = [];
  if (pres.cliente_telefono) cliExtras.push(`📞 ${escHtml(pres.cliente_telefono)}`);
  if (pres.cliente_email)    cliExtras.push(`✉ ${escHtml(pres.cliente_email)}`);

  const overlay = document.createElement('div');
  overlay.className = 'pres-modal-overlay';
  overlay.innerHTML = `
    <div class="pres-modal" id="presModalContent">
      <div class="pres-modal-header">
        <h3 class="pres-modal-title">${fmtNum(pres.numero)}</h3>
        <span class="pres-estado" style="background:${c.bg};color:${c.fg}">${ESTADO_LABEL[e] || e}</span>
        <button class="pres-modal-close" id="presModalClose">×</button>
      </div>
      <div class="pres-modal-body">
        <div class="pres-meta">
          <div class="pres-meta-item"><span>Emitido</span><b>${fmtDateTime(pres.fecha_emision)}</b></div>
          <div class="pres-meta-item"><span>Válido hasta</span><b>${fmtDate(pres.fecha_validez)}</b></div>
          <div class="pres-meta-item"><span>Cajero</span><b>${escHtml(pres.cajero_nombre || '—')}</b></div>
          ${pres.venta_id ? `<div class="pres-meta-item"><span>Venta</span><b>#${pres.venta_id}</b></div>` : ''}
        </div>

        <div class="pres-cliente-box">
          <h4>Presupuestado para</h4>
          <div class="name">${escHtml(pres.cliente_nombre || 'Consumidor Final')}</div>
          ${cliExtras.length ? `<div class="extra">${cliExtras.join(' &nbsp;·&nbsp; ')}</div>` : ''}
        </div>

        <table class="pres-items-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Producto</th>
              <th class="num">Cant.</th>
              <th class="num">P. Unit.</th>
              <th class="num">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((it, i) => `
              <tr>
                <td>${i + 1}</td>
                <td>${escHtml(it.product_name || '—')}</td>
                <td class="num">${fmtQty(it.quantity)}</td>
                <td class="num">${fmtMoney(it.unit_price)}</td>
                <td class="num"><b>${fmtMoney(it.subtotal)}</b></td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <div class="pres-totales">
          ${pres.descuento && Number(pres.descuento) > 0
            ? `<div>Subtotal: ${fmtMoney(pres.subtotal)}</div>
               <div style="color:#c1521f">Descuento: -${fmtMoney(pres.descuento)}</div>`
            : ''}
          <div class="total-final">TOTAL: ${fmtMoney(pres.total)}</div>
        </div>

        ${pres.notas ? `
          <div style="margin-top:14px;padding:10px 12px;background:#fffbe6;border-left:3px solid #f0c674;border-radius:4px;font-size:12px;color:#7a5c11">
            <b>Notas:</b> ${escHtml(pres.notas)}
          </div>
        ` : ''}
      </div>
      <div class="pres-modal-actions">
        ${(e === 'pendiente' || e === 'vencido') ? `
          <button class="pres-btn pres-btn-danger" id="presBtnAnular">Anular</button>
        ` : ''}
        <button class="pres-btn pres-btn-danger-outline" id="presBtnDelete">Eliminar</button>
        <button class="pres-btn pres-btn-secondary" id="presBtnClose2">Cerrar</button>
        <button class="pres-btn pres-btn-primary" id="presBtnPrint">Imprimir / Guardar PDF</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  document.getElementById('presModalClose').addEventListener('click', close);
  document.getElementById('presBtnClose2').addEventListener('click', close);

  document.getElementById('presBtnPrint').addEventListener('click', () => {
    openPrintView(pres);
  });

  const btnAnular = document.getElementById('presBtnAnular');
  if (btnAnular) {
    btnAnular.addEventListener('click', async () => {
      if (!confirm(`¿Anular el presupuesto ${fmtNum(pres.numero)}?\n\nEsta acción no se puede deshacer.`)) return;
      try {
        const { doc: dref, updateDoc: u } = await import('firebase/firestore');
        const { db } = await import('../firebase.js');
        await u(dref(db, 'presupuestos', pres.id), {
          estado: 'anulado',
          updated_at: new Date().toISOString().slice(0, 19),
        });
        close();
      } catch (err) {
        alert('Error anulando: ' + err.message);
      }
    });
  }

  const btnDelete = document.getElementById('presBtnDelete');
  if (btnDelete) {
    btnDelete.addEventListener('click', async () => {
      if (!confirm(`¿Eliminar el presupuesto ${fmtNum(pres.numero)} del listado?\n\nSe quita de la web y del POS. La numeración no se reutiliza.`)) return;
      try {
        const { doc: dref, updateDoc: u } = await import('firebase/firestore');
        const { db } = await import('../firebase.js');
        await u(dref(db, 'presupuestos', pres.id), {
          deleted: true,
          updated_at: new Date().toISOString().slice(0, 19),
        });
        close();
      } catch (err) {
        alert('Error eliminando: ' + err.message);
      }
    });
  }

  // Esc para cerrar
  const onKey = (ev) => { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

// ── Vista imprimible (window.print → PDF) ───────────────────────────────────
function openPrintView(pres) {
  const items = pres.items || [];
  const itemsHtml = items.map((it, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td>${escHtml(it.product_name || '—')}</td>
      <td class="c">${fmtQty(it.quantity)}</td>
      <td class="r">${fmtMoney(it.unit_price)}</td>
      <td class="r"><b>${fmtMoney(it.subtotal)}</b></td>
    </tr>
  `).join('');

  const cliExtras = [];
  if (pres.cliente_telefono) cliExtras.push(`<b>Tel:</b> ${escHtml(pres.cliente_telefono)}`);
  if (pres.cliente_email)    cliExtras.push(`<b>Email:</b> ${escHtml(pres.cliente_email)}`);

  const html = `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8" />
<title>Presupuesto ${fmtNum(pres.numero)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica', 'Arial', sans-serif; color: #1c1e21; margin: 0; line-height: 1.4; position: relative; }
  body::before {
    content: "PRESUPUESTO";
    position: fixed; top: 50%; left: 50%;
    transform: translate(-50%, -50%) rotate(-35deg);
    font-size: 110px; font-weight: 900; color: #7b3fa6;
    opacity: 0.05; pointer-events: none; z-index: 0;
    white-space: nowrap;
  }
  .content { position: relative; z-index: 1; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 12px; }
  .h-left { flex: 1; }
  .brand { font-size: 22px; font-weight: bold; color: #7b3fa6; margin: 0 0 2px; }
  .tag { font-style: italic; color: #65676b; font-size: 10px; margin-bottom: 6px; }
  .data-line { font-size: 10px; margin: 1px 0; }
  .nro-box { background: #7b3fa6; color: white; border-radius: 6px; padding: 8px 14px; text-align: center; min-width: 160px; }
  .nro-box .lbl { font-size: 10px; font-weight: 700; letter-spacing: .5px; }
  .nro-box .num { font-size: 24px; font-weight: 900; line-height: 1.1; margin: 2px 0; }
  .nro-box .date { font-size: 9px; }
  hr.brand-line { border: none; border-top: 2px solid #7b3fa6; margin: 12px 0; }
  .validez {
    background: #f39c12; color: white; padding: 8px 14px; border-radius: 6px;
    display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 14px; font-size: 11px;
  }
  .validez .vlbl { font-size: 10px; font-weight: 700; }
  .validez .vbig { font-size: 14px; font-weight: 900; }
  .cliente { background: #faf6ff; border-left: 3px solid #7b3fa6; padding: 10px 14px; border-radius: 4px; margin-bottom: 14px; }
  .cliente h4 { margin: 0 0 3px; font-size: 10px; color: #7b3fa6; text-transform: uppercase; letter-spacing: .5px; }
  .cliente .name { font-size: 13px; font-weight: 700; }
  .cliente .extra { font-size: 10px; color: #65676b; margin-top: 2px; }
  table.items { width: 100%; border-collapse: collapse; font-size: 10px; }
  table.items thead { background: #7b3fa6; color: white; }
  table.items th { padding: 7px 8px; font-weight: 700; }
  table.items th.c, table.items td.c { text-align: center; }
  table.items th.r, table.items td.r { text-align: right; }
  table.items td { padding: 6px 8px; border-bottom: 0.5px solid #e4e6eb; }
  table.items tbody tr:nth-child(even) td { background: #faf6ff; }
  .totales { margin-top: 8px; display: flex; justify-content: flex-end; }
  .totales-box { width: 220px; }
  .tot-row { display: flex; justify-content: space-between; padding: 5px 10px; font-size: 11px; }
  .tot-row.muted { color: #65676b; }
  .tot-row.final { background: #7b3fa6; color: white; font-size: 14px; font-weight: 700; padding: 9px 12px; border-radius: 4px; margin-top: 3px; }
  .conditions { margin-top: 18px; font-size: 9px; color: #65676b; }
  .conditions h5 { font-size: 10px; color: #7b3fa6; margin: 0 0 4px; text-transform: uppercase; letter-spacing: .4px; }
  .footer { position: fixed; bottom: 5mm; left: 14mm; right: 14mm; font-size: 8px; color: #65676b; border-top: 1px solid #e4e6eb; padding-top: 4px; display:flex; justify-content:space-between; }
  .firma-box { margin-top: 24px; text-align: center; font-size: 9px; color: #65676b; }
  .firma-box .line { border-top: 0.6px solid #1c1e21; width: 180px; margin: 0 auto 3px; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print { display: none; } }
  .no-print { padding: 14px; text-align: center; background: #fafafa; border-bottom: 1px solid #e4e6eb; }
  .btn-print { background: #7b3fa6; color: white; padding: 10px 22px; font-weight: 700; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
</style>
</head>
<body>
  <div class="no-print">
    <button class="btn-print" onclick="window.print()">Imprimir / Guardar como PDF</button>
  </div>

  <div class="content">
    <div class="header">
      <div class="h-left">
        <div class="brand">LIBRERIA LICEO</div>
        <div class="tag">Librería · Papelería · Juguetería · Mercería</div>
        <div class="data-line"><b>CUIT:</b> 20-14921040-8</div>
        <div class="data-line"><b>Domicilio:</b> Alfonsina Storni 168 — Córdoba</div>
        <div class="data-line"><b>Tel:</b> 3517046684 &nbsp;·&nbsp; <b>Email:</b> libreria.liceo@hotmail.com</div>
      </div>
      <div class="nro-box">
        <div class="lbl">PRESUPUESTO</div>
        <div class="num">${fmtNum(pres.numero)}</div>
        <div class="date">Emitido ${fmtDateTime(pres.fecha_emision)}</div>
      </div>
    </div>
    <hr class="brand-line"/>

    <div class="validez">
      <div><div class="vlbl">VÁLIDO HASTA</div><div class="vbig">${fmtDate(pres.fecha_validez)}</div></div>
      <div style="font-size:9px; max-width:340px;">Precios sujetos a stock disponible al momento de la compra. Pasada la fecha indicada los valores podrían modificarse.</div>
    </div>

    <div class="cliente">
      <h4>Presupuestado para</h4>
      <div class="name">${escHtml(pres.cliente_nombre || 'Consumidor Final')}</div>
      ${cliExtras.length ? `<div class="extra">${cliExtras.join(' &nbsp;·&nbsp; ')}</div>` : ''}
    </div>

    <table class="items">
      <thead>
        <tr>
          <th class="c" style="width:8%">#</th>
          <th>Descripción</th>
          <th class="c" style="width:10%">Cant.</th>
          <th class="r" style="width:18%">P. Unit.</th>
          <th class="r" style="width:18%">Subtotal</th>
        </tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>

    <div class="totales">
      <div class="totales-box">
        <div class="tot-row muted"><span>Subtotal</span><span><b>${fmtMoney(pres.subtotal)}</b></span></div>
        ${pres.descuento && Number(pres.descuento) > 0
          ? `<div class="tot-row muted"><span>Descuento</span><span>- ${fmtMoney(pres.descuento)}</span></div>` : ''}
        <div class="tot-row final"><span>TOTAL</span><span>${fmtMoney(pres.total)}</span></div>
      </div>
    </div>

    <div class="conditions">
      <h5>Condiciones</h5>
      • Este documento <b>NO es válido como factura ni comprobante de pago</b>.<br/>
      • Validez del presupuesto: hasta el ${fmtDate(pres.fecha_validez)} (sujeto a stock).<br/>
      • Los precios pueden modificarse sin previo aviso fuera del período de validez.<br/>
      • Para concretar la compra acercate al local con este presupuesto.
      ${pres.notas ? `<br/><br/><h5>Observaciones</h5>${escHtml(pres.notas)}` : ''}
    </div>

    <div class="firma-box">
      <div class="line"></div>
      Firma y aclaración
    </div>

    <div class="footer">
      <span>LIBRERIA LICEO · CUIT 20-14921040-8 · Alfonsina Storni 168, Córdoba</span>
      <span>${pres.cajero_nombre ? `Atendido por ${escHtml(pres.cajero_nombre)}  ·  ` : ''}${fmtNum(pres.numero)}</span>
    </div>
  </div>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) {
    alert('No se pudo abrir la ventana de impresión. Habilitá los popups para este sitio.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
