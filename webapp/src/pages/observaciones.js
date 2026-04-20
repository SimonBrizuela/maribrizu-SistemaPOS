/**
 * Página: Observaciones
 * Notas compartidas entre cajeros (POS + web) en tiempo real.
 * Cualquier usuario puede crear y leer; admin puede eliminar cualquiera.
 */

import {
  collection, addDoc, doc, updateDoc,
  query, orderBy, onSnapshot,
} from 'firebase/firestore';

import { getSession } from '../auth.js';

const COL = 'observaciones';
let _unsub = null;

export async function renderObservaciones(container, db) {
  // Stop previous listener si se re-renderiza
  if (_unsub) { try { _unsub(); } catch(_){} _unsub = null; }

  const session = getSession() || {};
  const isAdmin = String(session.role || '') === 'admin';
  const myName  = session.display || session.username || 'Web';

  container.innerHTML = `
    <div style="max-width:880px;margin:0 auto;padding:16px 8px">

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
        <div>
          <h2 style="margin:0;font-size:20px;font-weight:700">Observaciones</h2>
          <p style="margin:4px 0 0;color:var(--text-muted);font-size:13px">
            Notas compartidas entre cajeros (POS + web). Sincronización en tiempo real.
          </p>
        </div>
        <button id="btnNuevaObs" style="
          background:var(--primary);color:white;border:none;border-radius:8px;
          padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;
          display:flex;align-items:center;gap:6px;font-family:inherit
        ">
          <span class="material-icons" style="font-size:18px">edit_note</span> Nueva observación
        </button>
      </div>

      <!-- Filtros -->
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <input id="obsBuscar" type="text" placeholder="Buscar en las observaciones..."
          style="flex:1;min-width:220px;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;background:var(--card-bg)" />
        <select id="obsFiltroContexto" style="padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;background:var(--card-bg)">
          <option value="">Todos</option>
          <option value="general">General</option>
          <option value="sale">Ventas (Varios)</option>
        </select>
      </div>

      <div id="obsCount" style="color:var(--text-muted);font-size:13px;margin-bottom:8px">—</div>

      <div id="obsLista" style="display:flex;flex-direction:column;gap:10px">
        <div style="text-align:center;padding:40px;color:var(--text-muted)">
          <span class="material-icons" style="font-size:40px;display:block;margin-bottom:8px">hourglass_empty</span>
          Cargando observaciones...
        </div>
      </div>

      <!-- Modal nueva observación -->
      <div id="obsModal" style="
        display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);
        z-index:1000;align-items:center;justify-content:center;padding:16px
      ">
        <div style="background:var(--card-bg);border-radius:12px;max-width:520px;width:100%;padding:22px;box-shadow:0 20px 50px rgba(0,0,0,0.3)">
          <h3 style="margin:0 0 12px;font-size:18px">Nueva observación</h3>
          <textarea id="obsTextarea" placeholder="Ej: falta tijera escolar, llegó pedido del proveedor…"
            style="width:100%;box-sizing:border-box;min-height:140px;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-family:inherit;font-size:14px;resize:vertical;background:var(--card-bg)"></textarea>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
            <button id="obsCancelar" style="background:transparent;border:1px solid var(--border);color:var(--text);padding:9px 16px;border-radius:8px;cursor:pointer;font-family:inherit">Cancelar</button>
            <button id="obsGuardar" style="background:var(--primary);border:none;color:white;padding:9px 18px;border-radius:8px;cursor:pointer;font-family:inherit;font-weight:600">Guardar</button>
          </div>
        </div>
      </div>

    </div>
  `;

  let items = [];

  const render = () => {
    const search   = (document.getElementById('obsBuscar').value || '').toLowerCase().trim();
    const ctxFil   = document.getElementById('obsFiltroContexto').value;
    const filtered = items.filter(o => {
      if (o.deleted) return false;
      if (ctxFil && String(o.context || 'general') !== ctxFil) return false;
      if (search) {
        const blob = `${o.text || ''} ${o.created_by_name || ''}`.toLowerCase();
        if (!blob.includes(search)) return false;
      }
      return true;
    });

    const cntEl = document.getElementById('obsCount');
    cntEl.textContent = `${filtered.length} observación${filtered.length === 1 ? '' : 'es'}`;

    const list = document.getElementById('obsLista');
    if (!filtered.length) {
      list.innerHTML = `<div style="text-align:center;padding:36px;color:var(--text-muted);background:var(--card-bg);border-radius:10px;border:1px dashed var(--border)">
        <span class="material-icons" style="font-size:42px;display:block;margin-bottom:6px;opacity:0.6">sticky_note_2</span>
        No hay observaciones.
      </div>`;
      return;
    }

    list.innerHTML = filtered.map(o => {
      const ctx = String(o.context || 'general');
      const border = ctx === 'sale' ? '#f59e0b' : 'var(--border)';
      const tag    = ctx === 'sale' ? 'Venta (Varios)' : 'General';
      const when   = o.created_at || '';
      const author = o.created_by_name || 'Cajero';
      const pc     = o.pc_id ? `<span style="color:var(--text-muted)"> · ${o.pc_id}</span>` : '';
      const saleRef = (ctx === 'sale' && o.sale_id)
        ? `<div style="color:#b45309;font-size:12px;margin-top:4px">Venta #${o.sale_id}</div>` : '';
      const delBtn = isAdmin
        ? `<button class="obs-del" data-id="${o.id}" style="background:transparent;color:#dc2626;border:1px solid #fecaca;padding:3px 10px;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit">Eliminar</button>`
        : '';
      return `
        <div style="background:var(--card-bg);border:1px solid ${border};border-radius:10px;padding:12px 14px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px">
            <div style="font-size:12px;color:var(--text-muted)">
              <b style="color:var(--text)">${escapeHtml(author)}</b> · ${escapeHtml(when)}${pc}
              <span style="margin-left:8px;padding:1px 8px;border-radius:4px;background:rgba(0,0,0,0.05);font-size:11px">${tag}</span>
            </div>
            ${delBtn}
          </div>
          <div style="font-size:14px;color:var(--text);white-space:pre-wrap">${escapeHtml(o.text || '')}</div>
          ${saleRef}
        </div>`;
    }).join('');

    if (isAdmin) {
      list.querySelectorAll('.obs-del').forEach(btn => {
        btn.addEventListener('click', () => softDelete(btn.dataset.id));
      });
    }
  };

  const softDelete = async (id) => {
    if (!confirm('¿Eliminar esta observación?')) return;
    try {
      await updateDoc(doc(db, COL, id), { deleted: true });
    } catch (e) {
      alert('No se pudo eliminar: ' + e.message);
    }
  };

  // Listener en tiempo real
  const q = query(collection(db, COL), orderBy('created_at', 'desc'));
  _unsub = onSnapshot(q, (snap) => {
    items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => {
    console.error('Observaciones listener:', err);
    document.getElementById('obsLista').innerHTML =
      `<div style="text-align:center;padding:30px;color:#dc2626">Error cargando observaciones.</div>`;
  });

  // Eventos
  document.getElementById('obsBuscar').addEventListener('input', render);
  document.getElementById('obsFiltroContexto').addEventListener('change', render);

  const modal = document.getElementById('obsModal');
  const ta    = document.getElementById('obsTextarea');
  document.getElementById('btnNuevaObs').addEventListener('click', () => {
    ta.value = '';
    modal.style.display = 'flex';
    setTimeout(() => ta.focus(), 30);
  });
  document.getElementById('obsCancelar').addEventListener('click', () => {
    modal.style.display = 'none';
  });
  document.getElementById('obsGuardar').addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    try {
      const now = new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
      await addDoc(collection(db, COL), {
        text,
        context: 'general',
        sale_id: null,
        sale_item_id: null,
        created_by_id: null,
        created_by_name: myName,
        pc_id: 'web',
        created_at: now,
        deleted: false,
      });
      modal.style.display = 'none';
    } catch (e) {
      alert('No se pudo guardar: ' + e.message);
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
