import { collection, doc, onSnapshot, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { getSession } from '../auth.js';

// ── Constantes ───────────────────────────────────────────────────────────
// Heartbeat del POS es cada 20 min → damos 25 min de margen para "online"
const ONLINE_WINDOW_MS = 25 * 60 * 1000;
const STALE_WINDOW_MS  = 7 * 24 * 60 * 60 * 1000; // > 7 días → sugerir eliminar

const CMD_LABELS = {
  sync_upload:       { text: 'Forzar sync (subir)',   icon: 'cloud_upload',   color: '#0d6efd' },
  sync_download:     { text: 'Forzar sync (bajar)',   icon: 'cloud_download', color: '#198754' },
  reconcile_orphans: { text: 'Limpiar huérfanos',     icon: 'cleaning_services', color: '#fd7e14' },
  purge_by_codes:    { text: 'Borrar eliminados',     icon: 'delete_sweep',   color: '#dc3545' },
  restart:           { text: 'Reiniciar POS',         icon: 'restart_alt',    color: '#dc3545' },
  ping:              { text: 'Ping',                  icon: 'wifi_tethering', color: '#6c757d' },
};

let _unsubPcs = null;
let _unsubCmds = null;
let _pcs = {};         // pc_id -> data
let _cmds = {};        // pc_id -> last command data
let _refreshTimer = null;
let _termOpen     = {};  // pcId -> bool
let _termHistories = {}; // pcId -> [{cmd, output, error, cwd}]
let _termCwds     = {};  // pcId -> string (current dir)
let _termStatus   = {};  // pcId -> status string
let _termUnsubs   = {};  // pcId -> unsubscribe fn
let _termLastAt   = {};  // pcId -> responded_at.seconds (de-dupe)
let _termOpenedAt = {};  // pcId -> seconds when terminal was opened
let _termPendingCmd = {}; // pcId -> last cmd sent (for labeling output)
let _dbRef = null;       // db reference stored for use in handlers

// ── Entry point ──────────────────────────────────────────────────────────
export async function renderPcs(container, db) {
  // Cleanup de listeners de visita anterior
  cleanup();
  _dbRef = db;

  const session = getSession();
  const isAdmin = (session?.role === 'admin');
  if (!isAdmin) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">lock</span>
        <p>Solo el administrador puede ver el estado de las PCs.</p>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="filter-bar" style="margin-bottom:16px;flex-wrap:wrap;gap:8px;align-items:center">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);font-weight:600">
        <input type="checkbox" id="pcOnlineOnly" /> Solo online
      </label>
      <input type="text" id="pcSearch" placeholder="Buscar por hostname / cajero…"
             style="flex:1;min-width:160px;max-width:280px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px" />
      <button id="pcCleanAll" class="pc-btn danger"
              style="padding:7px 14px;font-size:12.5px;gap:6px">
        <span class="material-icons">cleaning_services</span>
        <span>Sincronizar todas con el catálogo</span>
      </button>
      <span id="pcSummary" style="margin-left:auto;color:var(--text-muted);font-size:13px"></span>
    </div>
    <div id="pcCards" class="cards-grid" style="margin-bottom:8px"></div>
    <p id="pcEmpty" style="display:none;text-align:center;color:var(--text-muted);padding:40px">
      Ninguna PC reportó estado todavía. Iniciá el POS en una PC para verla acá.
    </p>
  `;

  // Estilos locales
  if (!document.getElementById('pcs-page-styles')) {
    const style = document.createElement('style');
    style.id = 'pcs-page-styles';
    style.textContent = `
      .pc-card {
        background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px;
        padding: 16px; display: flex; flex-direction: column; gap: 10px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.04); transition: box-shadow 0.15s;
      }
      .pc-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
      .pc-card-header {
        display: flex; align-items: center; gap: 10px;
        padding-bottom: 10px; border-bottom: 1px solid var(--border);
      }
      .pc-dot {
        width: 10px; height: 10px; border-radius: 50%;
        background: #94a3b8; flex-shrink: 0;
        box-shadow: 0 0 0 0 rgba(34,197,94,0.6);
      }
      .pc-dot.online {
        background: #22c55e;
        animation: pcPulse 2s infinite;
      }
      .pc-dot.offline { background: #94a3b8; }
      @keyframes pcPulse {
        0%   { box-shadow: 0 0 0 0 rgba(34,197,94,0.45); }
        70%  { box-shadow: 0 0 0 8px rgba(34,197,94,0); }
        100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
      }
      .pc-title { font-weight: 700; font-size: 15px; color: var(--text); flex: 1; min-width: 0;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-version { font-family: ui-monospace, monospace; font-size: 11px;
                    background: var(--bg); padding: 2px 8px; border-radius: 4px;
                    color: var(--text-muted); }
      .pc-version.outdated { background: #fff3cd; color: #856404; }
      .pc-meta-row { display: flex; justify-content: space-between; align-items: baseline;
                     font-size: 12.5px; gap: 8px; }
      .pc-meta-label { color: var(--text-muted); flex-shrink: 0; }
      .pc-meta-value { color: var(--text); text-align: right; font-weight: 500;
                       overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .pc-actions { display: grid; grid-template-columns: 1fr 1fr;
                    gap: 6px; padding-top: 10px; border-top: 1px solid var(--border); }
      .pc-btn {
        display: flex; align-items: center; justify-content: center; gap: 4px;
        padding: 7px 8px; border-radius: 6px; border: 1px solid var(--border);
        background: var(--card-bg); color: var(--text); font-size: 12px;
        font-weight: 600; cursor: pointer; transition: all 0.15s;
        font-family: inherit;
      }
      .pc-btn:hover:not(:disabled) { background: var(--bg); border-color: var(--text-muted); }
      .pc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .pc-btn .material-icons { font-size: 14px !important; }
      .pc-btn.danger { color: #dc3545; border-color: rgba(220,53,69,0.3); }
      .pc-btn.danger:hover:not(:disabled) { background: rgba(220,53,69,0.08); }
      .pc-cmd-status {
        font-size: 11px; padding: 6px 10px; border-radius: 6px;
        display: flex; align-items: center; gap: 6px; margin-top: 4px;
      }
      .pc-cmd-status.running { background: #fff3cd; color: #856404; }
      .pc-cmd-status.done    { background: #d1e7dd; color: #0f5132; }
      .pc-cmd-status.failed  { background: #f8d7da; color: #842029; }
      .pc-cmd-status .spinner-mini {
        width: 10px; height: 10px; border: 2px solid currentColor;
        border-top-color: transparent; border-radius: 50%;
        animation: pcSpin 0.6s linear infinite;
      }
      @keyframes pcSpin { to { transform: rotate(360deg); } }
      .pc-stale-badge {
        font-size: 10px; padding: 2px 6px; border-radius: 4px;
        background: #f8d7da; color: #842029; font-weight: 600;
      }
      .pc-cmd-cancel {
        background: transparent; border: none; cursor: pointer;
        font-size: 14px; color: currentColor; opacity: 0.6;
        padding: 0 4px; line-height: 1; font-family: inherit;
      }
      .pc-cmd-cancel:hover { opacity: 1; }

      /* ── Terminal ─────────────────────────────────────────────── */
      .pc-terminal {
        display: flex; flex-direction: column;
        background: #0f172a; border-radius: 8px; overflow: hidden;
        border: 1px solid #1e293b; margin-top: 4px;
      }
      .pc-term-out {
        overflow-y: auto; padding: 10px 12px;
        min-height: 140px; max-height: 240px;
        font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
        font-size: 12px; color: #94a3b8; line-height: 1.5;
      }
      .pc-term-entry { margin-bottom: 8px; }
      .pc-term-prompt { color: #4ade80; white-space: pre-wrap; word-break: break-all; }
      .pc-term-pre {
        margin: 2px 0 0 0; white-space: pre-wrap; word-break: break-all;
        color: #cbd5e1; font-size: 11.5px;
      }
      .pc-term-bar {
        display: flex; align-items: center; gap: 6px;
        background: #1e293b; border-top: 1px solid #334155; padding: 6px 10px;
      }
      .pc-term-cwd {
        font-family: ui-monospace, monospace; font-size: 11px;
        color: #4ade80; white-space: nowrap; flex-shrink: 0;
        max-width: 180px; overflow: hidden; text-overflow: ellipsis;
      }
      .pc-term-input {
        flex: 1; background: transparent; border: none; outline: none;
        color: #e2e8f0; font-family: ui-monospace, monospace; font-size: 12px;
        caret-color: #4ade80;
      }
      .pc-term-input::placeholder { color: #475569; }
      .pc-term-send {
        background: transparent; border: none; cursor: pointer;
        color: #4ade80; display: flex; align-items: center; padding: 2px;
        opacity: 0.8; transition: opacity 0.15s;
      }
      .pc-term-send:hover:not(:disabled) { opacity: 1; }
      .pc-term-send:disabled { opacity: 0.3; cursor: not-allowed; }
      .pc-term-send .material-icons { font-size: 16px !important; }

      /* ── Confirm modal ─────────────────────────────────────────── */
      .pc-confirm-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.45);
        backdrop-filter: blur(2px); display: flex;
        align-items: center; justify-content: center;
        z-index: 9999; animation: pcFadeIn 0.15s ease;
      }
      .pc-confirm-box {
        background: var(--card-bg); border-radius: 12px;
        max-width: 420px; width: calc(100% - 32px); padding: 24px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.25);
        animation: pcSlideUp 0.18s ease;
      }
      @keyframes pcFadeIn { from {opacity: 0;} to {opacity: 1;} }
      @keyframes pcSlideUp {
        from { opacity: 0; transform: translateY(12px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .pc-confirm-icon {
        width: 48px; height: 48px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        margin-bottom: 14px; background: rgba(13,110,253,0.12);
      }
      .pc-confirm-icon .material-icons {
        font-size: 26px !important; color: #0d6efd;
      }
      .pc-confirm-icon.danger { background: rgba(220,53,69,0.12); }
      .pc-confirm-icon.danger .material-icons { color: #dc3545; }
      .pc-confirm-title {
        font-size: 18px; font-weight: 700; color: var(--text);
        margin: 0 0 6px;
      }
      .pc-confirm-msg {
        font-size: 13.5px; color: var(--text-muted);
        line-height: 1.5; margin: 0 0 20px; white-space: pre-line;
      }
      .pc-confirm-actions {
        display: flex; gap: 8px; justify-content: flex-end;
      }
      .pc-confirm-btn {
        padding: 9px 18px; border-radius: 7px; border: 1px solid var(--border);
        background: var(--card-bg); color: var(--text); font-size: 13px;
        font-weight: 600; cursor: pointer; transition: all 0.15s;
        font-family: inherit; min-width: 90px;
      }
      .pc-confirm-btn:hover { background: var(--bg); }
      .pc-confirm-btn.primary {
        background: #0d6efd; border-color: #0d6efd; color: white;
      }
      .pc-confirm-btn.primary:hover { background: #0b5ed7; border-color: #0b5ed7; }
      .pc-confirm-btn.danger {
        background: #dc3545; border-color: #dc3545; color: white;
      }
      .pc-confirm-btn.danger:hover { background: #bb2d3b; border-color: #bb2d3b; }
    `;
    document.head.appendChild(style);
  }

  // ── Listener pcs ──────────────────────────────────────────────────────
  _unsubPcs = onSnapshot(collection(db, 'pcs'), snap => {
    _pcs = {};
    snap.forEach(d => { _pcs[d.id] = d.data() || {}; });
    render();
  }, err => {
    console.error('pcs listener error:', err);
    container.innerHTML = `<div class="empty-state"><span class="material-icons">error_outline</span>
      <p>Error escuchando pcs: ${err.message}</p></div>`;
  });

  // ── Listener pc_commands (para mostrar status del último comando) ────
  _unsubCmds = onSnapshot(collection(db, 'pc_commands'), snap => {
    _cmds = {};
    snap.forEach(d => { _cmds[d.id] = d.data() || {}; });
    render();
  });

  // Re-render cada 15s para refrescar "online" y tiempos relativos
  _refreshTimer = setInterval(render, 15000);

  // Filtros
  document.getElementById('pcOnlineOnly').addEventListener('change', render);
  document.getElementById('pcSearch').addEventListener('input', render);

  // Botón global: sincronizar todas las PCs online con el catálogo
  document.getElementById('pcCleanAll').addEventListener('click', async () => {
    const now = Date.now();
    const onlinePcs = Object.entries(_pcs)
      .filter(([_, data]) => {
        const ls = parseDate(data.last_seen);
        return ls && (now - ls.getTime()) < ONLINE_WINDOW_MS;
      })
      .map(([pcId]) => pcId);

    if (onlinePcs.length === 0) {
      alert('No hay PCs online en este momento.');
      return;
    }

    const ok = await showConfirm({
      title:       'Sincronizar con el catálogo',
      message:     `Va a forzar limpieza de huérfanos en ${onlinePcs.length} PC${onlinePcs.length > 1 ? 's' : ''} online.\n\nCada PC compara su DB local contra el catálogo de Firestore y borra cualquier producto viejo que ya no exista (matchea por código de Firebase, código de barras y código alternativo).\n\nLas PCs offline se sincronizarán cuando vuelvan a estar online.`,
      confirmText: 'Sincronizar todas',
      icon:        'cleaning_services',
      danger:      true,
    });
    if (!ok) return;

    const issuedAt = new Date().toISOString();
    const issuedBy = (getSession()?.username || 'admin');
    let okCount = 0;
    let errCount = 0;
    for (const pcId of onlinePcs) {
      try {
        await setDoc(doc(db, 'pc_commands', pcId), {
          command:     'reconcile_orphans',
          issued_at:   issuedAt,
          issued_by:   issuedBy,
          status:      'pending',
          result:      null,
          finished_at: null,
        });
        okCount++;
      } catch (e) {
        console.error(`Enviando reconcile a ${pcId}:`, e);
        errCount++;
      }
    }
    if (errCount === 0) {
      alert(`Comando enviado a ${okCount} PC${okCount > 1 ? 's' : ''}. Mirá los banners en cada card para ver el progreso.`);
    } else {
      alert(`Enviado: ${okCount}, errores: ${errCount}. Revisá la consola para detalles.`);
    }
  });

  // Botón global de comando expone fn al window (callback inline)
  window._pcCommand = async (pcId, command) => {
    let param = null;
    if (command === 'restart') {
      const ok = await showConfirm({
        title:       'Reiniciar POS',
        message:     `Esto va a cerrar y reabrir el sistema en "${pcId}". El cajero verá la ventana parpadear unos segundos.`,
        confirmText: 'Reiniciar',
        icon:        'restart_alt',
        danger:      true,
      });
      if (!ok) return;
    } else if (command === 'purge_by_codes') {
      const ok = await showConfirm({
        title:       'Borrar productos eliminados',
        message:     `Va a borrar de "${pcId}" todos los productos que estén en la lista de eliminados de la webapp (matchea por código de Firebase Y código de barras).\n\nMás exhaustivo que "Limpiar huérfanos" porque alcanza productos viejos sin firebase_id.`,
        confirmText: 'Borrar',
        icon:        'delete_sweep',
        danger:      true,
      });
      if (!ok) return;
      param = { from_tombstones: true };
    }
    try {
      const payload = {
        command,
        issued_at: new Date().toISOString(),
        issued_by: (getSession()?.username || 'admin'),
        status:    'pending',
        result:    null,
        finished_at: null,
      };
      if (param) payload.param = param;
      await setDoc(doc(db, 'pc_commands', pcId), payload);
    } catch (e) {
      alert(`Error enviando comando: ${e.message}`);
    }
  };

  window._pcCancelCmd = async (pcId) => {
    const ok = await showConfirm({
      title:       'Cancelar comando',
      message:     'El banner desaparece y el botón se libera.\nSi el POS ya empezó a ejecutar la acción, puede terminarla igual.',
      confirmText: 'Cancelar comando',
      cancelText:  'Volver',
      icon:        'cancel',
      danger:      true,
    });
    if (!ok) return;
    try {
      // Borramos el doc para que el banner desaparezca y el botón de
      // "ya hay comando en curso" se libere. El POS no aborta el worker
      // a mitad de camino, pero al terminar no tendrá doc para actualizar.
      await deleteDoc(doc(db, 'pc_commands', pcId));
    } catch (e) {
      alert(`Error cancelando: ${e.message}`);
    }
  };

  window._pcDelete = async (pcId) => {
    const ok = await showConfirm({
      title:       'Quitar PC de la lista',
      message:     `"${pcId}" desaparece de la vista. Si la PC vuelve a reportar heartbeat, aparece otra vez automáticamente.`,
      confirmText: 'Quitar',
      icon:        'delete',
      danger:      true,
    });
    if (!ok) return;
    try {
      await deleteDoc(doc(db, 'pcs', pcId));
      await deleteDoc(doc(db, 'pc_commands', pcId)).catch(() => {});
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  };

  window._pcToggleTerm = (pcId) => {
    _termOpen[pcId] = !_termOpen[pcId];
    const termEl = document.getElementById(`term-${pcId}`);
    if (termEl) termEl.style.display = _termOpen[pcId] ? 'flex' : 'none';
    if (_termOpen[pcId] && !_termUnsubs[pcId]) {
      _termOpenedAt[pcId] = Math.floor(Date.now() / 1000);
      setDoc(doc(_dbRef, 'remote_terminal', pcId), { status: 'idle', reset_at: serverTimestamp() }, { merge: true }).catch(() => {});
      _termUnsubs[pcId] = onSnapshot(doc(_dbRef, 'remote_terminal', pcId), snap => {
        if (!snap.exists()) return;
        const data = snap.data() || {};
        const respondedAt = data.responded_at?.seconds || 0;
        const issuedAt = data.issued_at?.seconds || 0;
        const nowSec = Math.floor(Date.now() / 1000);
        const isStale = (nowSec - issuedAt) > 30;
        const busy = !isStale && (data.status === 'pending' || data.status === 'running');
        const inp = document.getElementById(`term-inp-${pcId}`);
        const btn = document.getElementById(`term-btn-${pcId}`);
        if (inp) inp.disabled = busy;
        if (btn) busy ? btn.setAttribute('disabled', '') : btn.removeAttribute('disabled');
        if (data.cwd) {
          _termCwds[pcId] = data.cwd;
          const cwdEl = document.getElementById(`term-cwd-${pcId}`);
          if (cwdEl) cwdEl.textContent = data.cwd + '>';
        }
        if ((data.status === 'done' || data.status === 'error')
            && respondedAt > (_termLastAt[pcId] || 0)) {
          _termLastAt[pcId] = respondedAt;
          if (!_termHistories[pcId]) _termHistories[pcId] = [];
          _termHistories[pcId].push({
            cmd:    _termPendingCmd[pcId] || '',
            output: data.output || '',
            error:  data.status === 'error',
            cwd:    data.cwd || _termCwds[pcId] || '',
          });
          _termPendingCmd[pcId] = null;
          _renderTermOutput(pcId);
        }
        _termStatus[pcId] = data.status || 'idle';
      });
    }
  };

  window._pcSendTerm = async (pcId) => {
    const inp = document.getElementById(`term-inp-${pcId}`);
    if (!inp) return;
    const cmd = inp.value.trim();
    if (!cmd) return;
    _termPendingCmd[pcId] = cmd;
    inp.value = '';
    inp.disabled = true;
    document.getElementById(`term-btn-${pcId}`)?.setAttribute('disabled', '');
    setTimeout(() => {
      const inp2 = document.getElementById(`term-inp-${pcId}`);
      const btn2 = document.getElementById(`term-btn-${pcId}`);
      if (inp2 && inp2.disabled) { inp2.disabled = false; if (btn2) btn2.disabled = false; }
    }, 30000);
    try {
      await setDoc(doc(_dbRef, 'remote_terminal', pcId), {
        cmd,
        cwd:       _termCwds[pcId] || null,
        status:    'pending',
        issued_at: serverTimestamp(),
      });
    } catch (e) {
      if (!_termHistories[pcId]) _termHistories[pcId] = [];
      _termHistories[pcId].push({ cmd, output: `Error enviando: ${e.message}`, error: true, cwd: _termCwds[pcId] || '' });
      _termPendingCmd[pcId] = null;
      _renderTermOutput(pcId);
      inp.disabled = false;
      document.getElementById(`term-btn-${pcId}`)?.removeAttribute('disabled');
    }
  };
}

// ── Render ───────────────────────────────────────────────────────────────
function render() {
  const cardsEl = document.getElementById('pcCards');
  const emptyEl = document.getElementById('pcEmpty');
  const summary = document.getElementById('pcSummary');
  if (!cardsEl) return;

  const onlineOnly = document.getElementById('pcOnlineOnly')?.checked || false;
  const search = (document.getElementById('pcSearch')?.value || '').toLowerCase().trim();

  const now = Date.now();
  const allPcs = Object.entries(_pcs).map(([pcId, data]) => {
    const lastSeen = parseDate(data.last_seen);
    const ageMs = lastSeen ? (now - lastSeen.getTime()) : Infinity;
    const online = ageMs < ONLINE_WINDOW_MS;
    const stale  = ageMs > STALE_WINDOW_MS;
    return { pcId, data, lastSeen, ageMs, online, stale };
  });

  // Última versión vista entre todas las PCs (para marcar las desactualizadas)
  const latestVersion = allPcs
    .map(p => p.data.app_version || '')
    .filter(Boolean)
    .sort(compareSemver)
    .pop() || '';

  // Filtros
  let filtered = allPcs;
  if (onlineOnly) filtered = filtered.filter(p => p.online);
  if (search) {
    filtered = filtered.filter(p => {
      const blob = [
        p.pcId, p.data.hostname, p.data.cajero_actual, p.data.turno_actual,
        p.data.app_version, p.data.os,
      ].filter(Boolean).join(' ').toLowerCase();
      return blob.includes(search);
    });
  }

  // Ordenar: online primero, después por last_seen descendente
  filtered.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (b.lastSeen?.getTime() || 0) - (a.lastSeen?.getTime() || 0);
  });

  // Summary global
  const totalOn = allPcs.filter(p => p.online).length;
  summary.textContent = `${totalOn} online · ${allPcs.length} total`;

  if (filtered.length === 0) {
    cardsEl.innerHTML = '';
    emptyEl.style.display = 'block';
    emptyEl.textContent = allPcs.length === 0
      ? 'Ninguna PC reportó estado todavía. Iniciá el POS en una PC para verla acá.'
      : 'Ninguna PC coincide con el filtro.';
    return;
  }
  emptyEl.style.display = 'none';

  cardsEl.innerHTML = filtered.map(p => renderCard(p, latestVersion)).join('');

  // Restaurar estado de terminales abiertas tras innerHTML rebuild
  filtered.forEach(({ pcId }) => {
    if (!_termOpen[pcId]) return;
    const termEl = document.getElementById(`term-${pcId}`);
    if (termEl) termEl.style.display = 'flex';
    _renderTermOutput(pcId);
    const cwdEl = document.getElementById(`term-cwd-${pcId}`);
    if (cwdEl && _termCwds[pcId]) cwdEl.textContent = _termCwds[pcId] + '>';
    const inp = document.getElementById(`term-inp-${pcId}`);
    const busy = _termStatus[pcId] === 'pending' || _termStatus[pcId] === 'running';
    if (inp && busy) inp.disabled = true;
  });
}

function renderCard(p, latestVersion) {
  const d = p.data;
  const cmd = _cmds[p.pcId] || null;

  const hostname = escapeHtml(d.hostname || p.pcId);
  const version  = String(d.app_version || '—');
  const versionClass = (version !== '—' && latestVersion && compareSemver(version, latestVersion) < 0)
    ? 'outdated' : '';

  const cajero = escapeHtml(d.cajero_actual || d.turno_actual || 'Sin turno');
  const caja   = d.cash_register_id ? `Caja #${d.cash_register_id}` : 'Sin caja abierta';
  const productos = d.productos_locales != null ? d.productos_locales : '—';
  const ultimoSync = formatRelative(parseDate(d.last_sync_at));
  const ultimoSyncSummary = formatSyncSummary(d.last_sync_summary);
  const visto = formatRelative(p.lastSeen);
  const lastError = d.last_error ? escapeHtml(d.last_error) : '';

  const dotClass = p.online ? 'online' : 'offline';
  const status = p.online ? 'Online' : 'Offline';

  const staleBadge = p.stale ? `<span class="pc-stale-badge" title="Sin heartbeat hace más de 7 días">INACTIVA</span>` : '';

  // Estado del último comando
  let cmdBanner = '';
  if (cmd && cmd.command) {
    const cls = cmd.status === 'failed' ? 'failed' : (cmd.status === 'done' ? 'done' : 'running');
    const label = CMD_LABELS[cmd.command]?.text || cmd.command;
    const when = formatRelative(parseDate(cmd.finished_at || cmd.started_at || cmd.issued_at));
    if (cmd.status === 'pending' || cmd.status === 'running') {
      const progressText = cmd.progress ? ` · ${escapeHtml(cmd.progress)}` : '';
      const stepFrac = (cmd.progress_step != null && cmd.progress_total)
        ? ` (${cmd.progress_step}/${cmd.progress_total})` : '';
      cmdBanner = `<div class="pc-cmd-status ${cls}">
        <span class="spinner-mini"></span>
        <span style="flex:1">${escapeHtml(label)}${progressText}${stepFrac}</span>
        <button class="pc-cmd-cancel"
                onclick="window._pcCancelCmd('${escapeAttr(p.pcId)}')"
                title="Cancelar comando">✕</button>
      </div>`;
    } else if (cmd.status === 'done') {
      cmdBanner = `<div class="pc-cmd-status done" title="${escapeHtml(cmd.result || '')}">
        <span class="material-icons" style="font-size:13px">check_circle</span>
        <span>${escapeHtml(label)} ${when ? '· ' + when : ''}${cmd.result ? ' · ' + escapeHtml(String(cmd.result).slice(0, 60)) : ''}</span>
      </div>`;
    } else if (cmd.status === 'failed') {
      cmdBanner = `<div class="pc-cmd-status failed" title="${escapeHtml(cmd.result || '')}">
        <span class="material-icons" style="font-size:13px">error</span>
        <span>${escapeHtml(label)} falló${cmd.result ? ' · ' + escapeHtml(String(cmd.result).slice(0, 60)) : ''}</span>
      </div>`;
    }
  }

  // Botonera: deshabilitar si offline o si ya hay un comando corriendo
  const cmdActive = cmd && (cmd.status === 'pending' || cmd.status === 'running');
  const offlineDisabled = !p.online;
  const buttons = ['sync_upload','sync_download','reconcile_orphans','restart'].map(cmdName => {
    const meta = CMD_LABELS[cmdName];
    const cls = cmdName === 'restart' ? 'danger' : '';
    const disabledNow = offlineDisabled || cmdActive;
    const tip = offlineDisabled ? '(PC offline)'
              : cmdActive       ? `(comando "${cmd.command}" en curso)`
              : '';
    return `<button class="pc-btn ${cls}" ${disabledNow ? 'disabled' : ''}
              onclick="window._pcCommand('${escapeAttr(p.pcId)}', '${cmdName}')"
              title="${meta.text} ${tip}">
      <span class="material-icons">${meta.icon}</span>
      <span>${meta.text}</span>
    </button>`;
  }).join('');

  // Botón extra: "Borrar eliminados" (ancho, matchea por firebase_id + barcode)
  const purgeMeta = CMD_LABELS['purge_by_codes'];
  const purgeDisabled = offlineDisabled || cmdActive;
  const purgeTip = offlineDisabled ? '(PC offline)'
                : cmdActive       ? `(comando "${cmd.command}" en curso)`
                : 'Borra productos eliminados de la webapp, incluso los que perdieron firebase_id';
  const purgeBtn = `<button class="pc-btn danger" style="grid-column:span 2"
              ${purgeDisabled ? 'disabled' : ''}
              onclick="window._pcCommand('${escapeAttr(p.pcId)}', 'purge_by_codes')"
              title="${escapeAttr(purgeTip)}">
      <span class="material-icons">${purgeMeta.icon}</span>
      <span>${purgeMeta.text}</span>
    </button>`;

  const removeBtn = p.stale ? `
    <button class="pc-btn danger" style="grid-column:span 2"
            onclick="window._pcDelete('${escapeAttr(p.pcId)}')">
      <span class="material-icons">delete</span>
      <span>Quitar de la lista</span>
    </button>` : '';

  const termBtn = `
    <button class="pc-btn" style="grid-column:span 2"
            onclick="window._pcToggleTerm('${escapeAttr(p.pcId)}')">
      <span class="material-icons">terminal</span>
      <span>Terminal remota</span>
    </button>`;

  return `
    <div class="pc-card">
      <div class="pc-card-header">
        <span class="pc-dot ${dotClass}" title="${status}"></span>
        <span class="pc-title" title="${escapeAttr(p.pcId)}">${hostname}</span>
        ${staleBadge}
        <span class="pc-version ${versionClass}" title="App version">v${escapeHtml(version)}</span>
      </div>

      <div class="pc-meta-row">
        <span class="pc-meta-label">Estado</span>
        <span class="pc-meta-value">${status} · ${visto || '—'}</span>
      </div>
      <div class="pc-meta-row">
        <span class="pc-meta-label">Cajero</span>
        <span class="pc-meta-value">${cajero}</span>
      </div>
      <div class="pc-meta-row">
        <span class="pc-meta-label">Caja</span>
        <span class="pc-meta-value">${escapeHtml(caja)}</span>
      </div>
      <div class="pc-meta-row">
        <span class="pc-meta-label">Productos locales</span>
        <span class="pc-meta-value">${productos}</span>
      </div>
      <div class="pc-meta-row">
        <span class="pc-meta-label">Último sync</span>
        <span class="pc-meta-value" title="${escapeAttr(ultimoSyncSummary)}">${ultimoSync || 'nunca'}</span>
      </div>
      ${lastError ? `<div class="pc-meta-row" style="background:#fff3cd;padding:6px 8px;border-radius:6px;margin-top:4px">
        <span class="pc-meta-label" style="color:#856404">⚠ Error</span>
        <span class="pc-meta-value" style="color:#856404;font-size:11px" title="${escapeAttr(lastError)}">${lastError.slice(0, 60)}${lastError.length > 60 ? '…' : ''}</span>
      </div>` : ''}

      ${cmdBanner}

      <div class="pc-actions">
        ${buttons}
        ${purgeBtn}
        ${removeBtn}
        ${termBtn}
      </div>

      <div class="pc-terminal" id="term-${escapeAttr(p.pcId)}" style="display:none">
        <div class="pc-term-out" id="term-out-${escapeAttr(p.pcId)}">
          <span style="color:#6b7280;font-size:12px">Terminal lista. Escribí un comando.</span>
        </div>
        <div class="pc-term-bar">
          <span class="pc-term-cwd" id="term-cwd-${escapeAttr(p.pcId)}">&gt;</span>
          <input class="pc-term-input" id="term-inp-${escapeAttr(p.pcId)}" type="text"
                 placeholder="comando…" autocomplete="off" spellcheck="false"
                 onkeydown="if(event.key==='Enter')window._pcSendTerm('${escapeAttr(p.pcId)}')">
          <button class="pc-term-send" id="term-btn-${escapeAttr(p.pcId)}"
                  onclick="window._pcSendTerm('${escapeAttr(p.pcId)}')">
            <span class="material-icons">send</span>
          </button>
        </div>
      </div>
    </div>`;
}

// Confirm modal custom (reemplazo del confirm() nativo del browser)
function showConfirm({ title, message, confirmText = 'Aceptar', cancelText = 'Cancelar',
                       danger = false, icon = 'help_outline' } = {}) {
  return new Promise(resolve => {
    document.querySelector('.pc-confirm-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'pc-confirm-overlay';
    overlay.innerHTML = `
      <div class="pc-confirm-box" role="dialog" aria-modal="true">
        <div class="pc-confirm-icon ${danger ? 'danger' : ''}">
          <span class="material-icons">${icon}</span>
        </div>
        <h3 class="pc-confirm-title">${escapeHtml(title || '¿Confirmar?')}</h3>
        <p class="pc-confirm-msg">${escapeHtml(message || '')}</p>
        <div class="pc-confirm-actions">
          <button class="pc-confirm-btn" data-act="cancel">${escapeHtml(cancelText)}</button>
          <button class="pc-confirm-btn ${danger ? 'danger' : 'primary'}" data-act="ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    const close = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter')  close(true);
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'ok')     close(true);
      if (act === 'cancel') close(false);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    // Focus en el botón primario
    setTimeout(() => overlay.querySelector('[data-act="ok"]')?.focus(), 0);
  });
}

function _renderTermOutput(pcId) {
  const outEl = document.getElementById(`term-out-${pcId}`);
  if (!outEl) return;
  const entries = _termHistories[pcId] || [];
  if (entries.length === 0) {
    outEl.innerHTML = '<span style="color:#6b7280;font-size:12px">Terminal lista. Escribí un comando.</span>';
    return;
  }
  outEl.innerHTML = entries.map(e => {
    const cwdEsc = escapeHtml(e.cwd || '');
    const cmdEsc = escapeHtml(e.cmd || '');
    const outEsc = escapeHtml(e.output || '');
    return `<div class="pc-term-entry">
      <div class="pc-term-prompt">${cwdEsc ? cwdEsc + '>' : '>'} <span style="color:#e2e8f0">${cmdEsc}</span></div>
      <pre class="pc-term-pre"${e.error ? ' style="color:#f87171"' : ''}>${outEsc}</pre>
    </div>`;
  }).join('');
  outEl.scrollTop = outEl.scrollHeight;
}

function cleanup() {
  if (_unsubPcs)  { try { _unsubPcs();  } catch {} _unsubPcs  = null; }
  if (_unsubCmds) { try { _unsubCmds(); } catch {} _unsubCmds = null; }
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  Object.values(_termUnsubs).forEach(fn => { try { fn(); } catch {} });
  _termUnsubs = {}; _termOpen = {}; _termHistories = {}; _termCwds = {};
  _termStatus = {}; _termLastAt = {}; _termOpenedAt = {}; _termPendingCmd = {};
  _dbRef = null;
}

// Cleanup automático cuando se cambia de página (la app re-renderiza el contenedor)
const _origCleanup = window._pcsCleanup;
window._pcsCleanup = cleanup;

// ── Helpers ──────────────────────────────────────────────────────────────
function parseDate(raw) {
  if (!raw) return null;
  if (typeof raw.toDate === 'function') return raw.toDate();
  if (typeof raw === 'object' && raw.seconds !== undefined) {
    return new Date(raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6));
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function formatRelative(d) {
  if (!d) return '';
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return 'recién';
  const s = Math.floor(diffMs / 1000);
  if (s < 5)   return 'ahora';
  if (s < 60)  return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `hace ${h} h`;
  const days = Math.floor(h / 24);
  if (days < 30) return `hace ${days} d`;
  return d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
}

function formatSyncSummary(s) {
  if (!s || typeof s !== 'object') return '';
  if (s.kind === 'reconcile') {
    const parts = [];
    if (s.checked != null)     parts.push(`${s.checked} locales chequeados`);
    if (s.deleted)             parts.push(`${s.deleted} eliminados`);
    if (s.softdeleted)         parts.push(`${s.softdeleted} soft-delete`);
    if (s.updated)             parts.push(`${s.updated} actualizados`);
    return `Reconciliación: ${parts.join(', ') || 'sin cambios'}`;
  }
  if (s.kind === 'upload')   return `Subida ${s.ok ? 'OK' : 'falló'}`;
  if (s.kind === 'download') return `Descarga ${s.ok ? 'OK' : 'falló'}`;
  return JSON.stringify(s);
}

function compareSemver(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function escapeAttr(s) { return escapeHtml(s).replaceAll('`', '&#96;'); }
