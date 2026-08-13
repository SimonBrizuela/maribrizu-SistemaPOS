/**
 * Historial de cambios del Catálogo: undo / redo 100% local.
 *
 * Por qué local: guardar el historial NO debe costar lecturas/escrituras de
 * Firestore. Cada entrada (qué estaba antes / qué quedó después) vive en memoria
 * y se espeja en localStorage, así sobrevive al F5. Lo único que toca Firestore es
 * APLICAR un deshacer/rehacer (es inevitable: revertir un valor implica escribirlo).
 *
 * Modelo: una "entrada" es un comando reversible:
 *   { id, ts, label, kind: 'update'|'create'|'delete'|'batch',
 *     changes: [ { docId, invId, syncInv, before, after } ] }
 *   - before=null  → fue un alta        → undo = borrar el doc
 *   - after=null   → fue un borrado     → before = doc completo, undo = recrear
 *   - update       → before/after = solo los campos tocados
 *
 * `ultima_actualizacion` (serverTimestamp) nunca entra en el diff: el motor la
 * agrega siempre al escribir. Inventario es derivado: en cada apply se re-sincroniza
 * desde precio_venta/stock/costo del estado resultante, no se snapshotea aparte.
 */
import {
  doc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp,
} from 'firebase/firestore';
import { invalidateCacheByPrefix } from './cache.js';

const STORAGE_KEY = 'pos_catalogo_history_v1';
const MAX_ENTRIES = 80;            // tope de pasos guardados
const MAX_BYTES   = 1_000_000;     // guarda de tamaño (~1 MB) para localStorage
const BATCH_SIZE  = 400;           // límite firme de writeBatch de Firestore

function _escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Etiqueta legible para un campo del catálogo.
const FIELD_LABELS = {
  precio_venta: 'Precio', costo: 'Costo', stock: 'Stock',
  stock_min: 'Stock mín.', stock_max: 'Stock máx.', margen: 'Margen',
  nombre: 'Nombre', rubro: 'Rubro', sub_rubro: 'Sub-rubro', marca: 'Marca',
  proveedor: 'Proveedor', codigo: 'Código', cod_barra: 'Cód. barra',
  estado: 'Estado', conjunto_total: 'Total conjunto',
  conjunto_colores: 'Variantes', es_conjunto: 'Es conjunto',
};
export function fieldLabel(k) { return FIELD_LABELS[k] || k; }

// Formateo de valores para el panel (antes → después).
function fmtVal(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v.toLocaleString('es-AR')
      : v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  if (Array.isArray(v)) return `${v.length} ítem${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object') return '(detalle)';
  const s = String(v);
  return s.length > 40 ? s.slice(0, 39) + '…' : s;
}

/**
 * Crea un gestor de historial atado a la página de catálogo.
 *
 * @param {object} deps
 * @param {import('firebase/firestore').Firestore} deps.db
 * @param {(docId: string) => object|undefined} deps.getProducto  Lee el producto vivo de allProductos.
 * @param {(docId: string, op: {fields?: object, remove?: boolean, recreate?: object}) => void} deps.applyToMemory
 * @param {() => void} deps.refreshUI       Re-renderiza tabla + stats.
 * @param {(db: any, docId: string) => Promise<void>} deps.registerDeleted  _registerCatalogoDeleted.
 * @param {(db: any) => Promise<void>} deps.touchMeta  _touchCatalogoMeta.
 * @param {() => boolean} [deps.isActive]    True si la página catálogo está visible (para los atajos).
 */
export function initCatalogoHistory(deps) {
  const { db, getProducto, applyToMemory, refreshUI, registerDeleted, touchMeta } = deps;
  const isActive = deps.isActive || (() => true);
  const onHistoryChange = deps.onHistoryChange || (() => {});

  let undoStack = [];
  let redoStack = [];
  let _seq = 0;
  let panelEl = null;

  // ── Persistencia local ──────────────────────────────────────────────────
  function _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      undoStack = Array.isArray(data.undo) ? data.undo : [];
      redoStack = Array.isArray(data.redo) ? data.redo : [];
      _seq = data.seq || undoStack.reduce((m, e) => Math.max(m, e.id || 0), 0);
    } catch (_) { undoStack = []; redoStack = []; }
  }

  function _persist() {
    try {
      // Cap por cantidad: descartar las entradas más viejas.
      if (undoStack.length > MAX_ENTRIES) undoStack = undoStack.slice(-MAX_ENTRIES);
      let payload = JSON.stringify({ undo: undoStack, redo: redoStack, seq: _seq });
      // Guarda de tamaño: ir recortando las más viejas hasta entrar en MAX_BYTES.
      while (payload.length > MAX_BYTES && undoStack.length > 1) {
        undoStack = undoStack.slice(1);
        payload = JSON.stringify({ undo: undoStack, redo: redoStack, seq: _seq });
      }
      localStorage.setItem(STORAGE_KEY, payload);
    } catch (_) { /* localStorage lleno o no disponible: ignorar */ }
  }

  // ── Registro de entradas ────────────────────────────────────────────────
  function _pushEntry(kind, label, changes, ts) {
    const entry = { id: ++_seq, ts: ts || 0, label, kind, changes };
    undoStack.push(entry);
    redoStack = [];               // cualquier acción nueva invalida el redo
    _persist();
    _renderPanelIfOpen();
    try { onHistoryChange(); } catch (_) {}
    _flash(label, 'do');
    return entry;
  }

  // ── Motor de apply (inventario derivado + memoria + cache + meta) ─────────
  async function _writeOne(change, direction) {
    const { docId, invId, syncInv } = change;
    const target = direction === 'undo' ? change.before : change.after;
    const counterpart = direction === 'undo' ? change.after : change.before;

    // Alta (before=null): undo borra, redo recrea.
    if (change.before === null || change.after === null) {
      const isCreateDoc = change.before === null; // doc nuevo
      const removing = (isCreateDoc && direction === 'undo') || (!isCreateDoc && direction === 'redo');
      if (removing) {
        await deleteDoc(doc(db, 'catalogo', docId));
        try { await registerDeleted(db, docId); } catch (_) {}
        applyToMemory(docId, { remove: true });
      } else {
        const full = isCreateDoc ? change.after : change.before; // doc completo
        const body = { ...full };
        delete body.doc_id;
        await setDoc(doc(db, 'catalogo', docId), { ...body, ultima_actualizacion: serverTimestamp() });
        // Limpiar el tombstone para que el POS no vuelva a ocultar el producto recreado.
        try { await deleteDoc(doc(db, 'catalogo_deleted', docId)); } catch (_) {}
        applyToMemory(docId, { recreate: { ...full, doc_id: docId } });
      }
      return;
    }

    // Update normal: escribir solo los campos del target.
    await updateDoc(doc(db, 'catalogo', docId), { ...target, ultima_actualizacion: serverTimestamp() });
    applyToMemory(docId, { fields: target });

    // Sincronizar inventario (POS) si el change lo pide y tocó precio/stock/costo.
    if (syncInv && invId != null) {
      const invFields = {};
      if ('precio_venta' in target) invFields.precio = target.precio_venta;
      if ('stock' in target)        invFields.stock  = target.stock;
      if ('costo' in target)        invFields.costo  = target.costo;
      if (Object.keys(invFields).length) {
        try {
          const prod = getProducto(docId) || {};
          const invDocId = String(invId);
          await setDoc(doc(db, 'inventario', invDocId), {
            ...invFields,
            nombre: prod.nombre || prod.name || '',
            id: parseInt(invDocId) || invDocId,
            ultima_actualizacion: serverTimestamp(),
          }, { merge: true });
        } catch (_) { /* inventario es best-effort, igual que en el resto del catálogo */ }
      }
    }
  }

  async function _applyChangeSet(changes, direction) {
    // Flag para que main.js/onStoreChange no re-renderice por nuestro propio write.
    try { window.__catalogoLocalEditUntil = Date.now() + 8000; } catch (_) {}

    // Updates puros se agrupan en writeBatch; altas/borrados van sueltos.
    const simple = changes.filter(c => c.before !== null && c.after !== null);
    const special = changes.filter(c => c.before === null || c.after === null);

    // Altas/borrados: agrupar en writeBatch igual que los updates. Antes era
    // serial y deshacer un borrado masivo disparaba 2N round-trips (lento /
    // parecía colgado). Cada cambio = 2 ops (catalogo + catalogo_deleted), así
    // que entran BATCH_SIZE/2 docs por lote. La memoria se aplica recién tras
    // un commit OK (queda consistente con la DB si el lote falla).
    const SPECIAL_PER_BATCH = Math.floor(BATCH_SIZE / 2);
    for (let i = 0; i < special.length; i += SPECIAL_PER_BATCH) {
      const slice = special.slice(i, i + SPECIAL_PER_BATCH);
      if (slice.length === 1) {
        try { await _writeOne(slice[0], direction); } catch (e) { console.error('[hist] writeOne', e); }
        continue;
      }
      const batch = writeBatch(db);
      const ts = serverTimestamp();
      const memOps = [];
      for (const c of slice) {
        const isCreateDoc = c.before === null;
        const removing = (isCreateDoc && direction === 'undo') || (!isCreateDoc && direction === 'redo');
        if (removing) {
          batch.delete(doc(db, 'catalogo', c.docId));
          batch.set(doc(db, 'catalogo_deleted', c.docId), { deleted_at: ts });
          memOps.push(() => applyToMemory(c.docId, { remove: true }));
        } else {
          const full = isCreateDoc ? c.after : c.before;
          const body = { ...full };
          delete body.doc_id;
          batch.set(doc(db, 'catalogo', c.docId), { ...body, ultima_actualizacion: ts });
          batch.delete(doc(db, 'catalogo_deleted', c.docId));
          memOps.push(() => applyToMemory(c.docId, { recreate: { ...full, doc_id: c.docId } }));
        }
      }
      try { await batch.commit(); memOps.forEach(fn => fn()); }
      catch (e) { console.error('[hist] batch special', e); }
    }

    for (let i = 0; i < simple.length; i += BATCH_SIZE) {
      const slice = simple.slice(i, i + BATCH_SIZE);
      if (slice.length === 1) {
        try { await _writeOne(slice[0], direction); } catch (e) { console.error('[hist] writeOne', e); }
        continue;
      }
      const batch = writeBatch(db);
      const ts = serverTimestamp();
      for (const c of slice) {
        const target = direction === 'undo' ? c.before : c.after;
        batch.update(doc(db, 'catalogo', c.docId), { ...target, ultima_actualizacion: ts });
        applyToMemory(c.docId, { fields: target });
      }
      try { await batch.commit(); } catch (e) { console.error('[hist] batch', e); }
      // Sync inventario fuera del batch (colección distinta).
      for (const c of slice) {
        const target = direction === 'undo' ? c.before : c.after;
        if (!c.syncInv || c.invId == null) continue;
        const invFields = {};
        if ('precio_venta' in target) invFields.precio = target.precio_venta;
        if ('stock' in target)        invFields.stock  = target.stock;
        if ('costo' in target)        invFields.costo  = target.costo;
        if (!Object.keys(invFields).length) continue;
        try {
          const prod = getProducto(c.docId) || {};
          const invDocId = String(c.invId);
          await setDoc(doc(db, 'inventario', invDocId), {
            ...invFields, nombre: prod.nombre || prod.name || '',
            id: parseInt(invDocId) || invDocId, ultima_actualizacion: serverTimestamp(),
          }, { merge: true });
        } catch (_) {}
      }
    }

    invalidateCacheByPrefix('catalogo');
    try { await touchMeta(db); } catch (_) {}
    refreshUI(changes.map(c => c.docId));
  }

  // ── Operaciones públicas: undo / redo ─────────────────────────────────────
  async function undo() {
    const entry = undoStack.pop();
    if (!entry) return null;
    await _applyChangeSet(entry.changes, 'undo');
    redoStack.push(entry);
    _persist();
    _renderPanelIfOpen();
    _flash(`Deshecho: ${entry.label}`, 'undo');
    return entry;
  }

  async function redo() {
    const entry = redoStack.pop();
    if (!entry) return null;
    await _applyChangeSet(entry.changes, 'redo');
    undoStack.push(entry);
    _persist();
    _renderPanelIfOpen();
    _flash(`Rehecho: ${entry.label}`, 'redo');
    return entry;
  }

  async function undoTo(entryId) {
    const idx = undoStack.findIndex(e => e.id === entryId);
    if (idx === -1) return;
    const n = undoStack.length - idx; // deshacer desde el más nuevo hasta éste inclusive
    for (let i = 0; i < n; i++) await undo();
  }

  // ── Helpers de commit (escriben + registran en una sola llamada) ──────────

  // Captura el subconjunto `before` con exactamente las keys de `afterFields`.
  function _captureBefore(prod, afterFields) {
    const before = {};
    for (const k of Object.keys(afterFields)) {
      before[k] = prod ? (k in prod ? prod[k] : null) : null;
    }
    return before;
  }

  /**
   * Update de un solo doc. Escribe catálogo (+inventario si syncInv) y registra.
   * `afterFields` NO debe incluir ultima_actualizacion (la agrega el motor).
   */
  async function commitFields(prod, afterFields, { label, syncInv = false, ts = 0 } = {}) {
    const docId = prod.doc_id || prod.id;
    const invId = syncInv ? (prod.id || docId) : null;
    const before = _captureBefore(prod, afterFields);
    const change = { docId, invId, syncInv, before, after: { ...afterFields } };
    await _applyChangeSet([change], 'redo');
    const entry = _pushEntry('update', label || 'Editar producto', [change], ts);
    return entry;
  }

  /**
   * Alta de producto. `fullDoc` = doc completo creado (con doc_id).
   * El alta ya la hizo el caller (necesita reservar pos_id_counter, etc.);
   * acá sólo registramos para poder deshacer (= borrar).
   */
  function recordCreate(docId, fullDoc, { label, ts = 0 } = {}) {
    const change = { docId, invId: null, syncInv: false, before: null, after: { ...fullDoc, doc_id: docId } };
    const entry = _pushEntry('create', label || 'Crear producto', [change], ts);
    return entry;
  }

  /**
   * Update de un solo doc ya escrito por el caller (cuando el caller necesita
   * lógica propia). Sólo registra el diff before→after.
   */
  function recordUpdate(docId, before, after, { label, syncInv = false, invId = null, ts = 0 } = {}) {
    const change = { docId, invId, syncInv, before: { ...before }, after: { ...after } };
    return _pushEntry('update', label || 'Editar producto', [change], ts);
  }

  /**
   * Borrado: registra el doc completo para poder recrearlo. El borrado en
   * Firestore lo hace el caller (mantiene su animación/flujo); acá registramos.
   */
  function recordDelete(prod, { label, ts = 0 } = {}) {
    const docId = prod.doc_id || prod.id;
    const full = { ...prod, doc_id: docId };
    const change = { docId, invId: prod.id || null, syncInv: false, before: full, after: null };
    return _pushEntry('delete', label || `Borrar ${prod.nombre || prod.name || docId}`, [change], ts);
  }

  /**
   * Operación bulk ya escrita por el caller. `changes` = [{docId, invId, syncInv, before, after}].
   * Registra una sola entrada con N changes.
   */
  function recordBatch(changes, { label, ts = 0 } = {}) {
    if (!changes || !changes.length) return null;
    return _pushEntry('batch', label || `${changes.length} cambios`, changes, ts);
  }

  // ── UI: toast + panel ─────────────────────────────────────────────────────
  function _flash(msg, kind) {
    const colors = { do: '#1877f2', undo: '#b45309', redo: '#0e7490' };
    const toast = document.createElement('div');
    toast.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:${colors[kind] || '#1877f2'};color:#fff;padding:12px 18px;border-radius:10px;font-weight:600;font-size:14px;z-index:10050;box-shadow:0 4px 20px rgba(0,0,0,0.25);display:flex;align-items:center;gap:12px`;
    const showUndo = kind === 'do';
    toast.innerHTML = `<span class="material-icons" style="font-size:18px">${kind === 'undo' ? 'undo' : kind === 'redo' ? 'redo' : 'check_circle'}</span><span>${_escHtml(msg)}</span>`;
    if (showUndo) {
      const btn = document.createElement('button');
      btn.textContent = 'Deshacer';
      btn.style.cssText = 'background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.5);color:#fff;border-radius:7px;padding:5px 12px;font-weight:700;font-size:13px;cursor:pointer';
      btn.addEventListener('click', () => { toast.remove(); undo(); });
      toast.appendChild(btn);
    }
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), showUndo ? 5000 : 3000);
  }

  // Stock legible de una variante: "3×50 + 2 suelt." (unidades×contenido + sueltos).
  function _varStock(c) {
    if (!c) return '—';
    const u = Number(c.unidades) || 0;
    const r = Number(c.restante) || 0;
    const cont = Number(c.contenido) || 0;
    const parts = [];
    if (u) parts.push(cont ? `${u}×${cont}` : `${u}`);
    if (r) parts.push(`${r} suelt.`);
    return parts.length ? parts.join(' + ') : '0';
  }

  function _money(v) { const n = Number(v) || 0; return n ? '$' + n.toLocaleString('es-AR') : '—'; }

  function _varRow(label, oldTxt, newTxt) {
    return `<div class="ch-row"><span class="ch-f">${_escHtml(label)}</span><span class="ch-v"><b class="ch-old">${_escHtml(oldTxt)}</b> → <b class="ch-new">${_escHtml(newTxt)}</b></span></div>`;
  }

  // Diff de variantes (conjunto_colores) por color: muestra qué variante cambió
  // (stock, precio del pack y costo) y de cuánto a cuánto. Detecta agregadas /
  // eliminadas / modificadas.
  function _variantesDiffRows(beforeArr, afterArr) {
    const norm = arr => new Map((Array.isArray(arr) ? arr : [])
      .map(c => [String(c.color || '').toLowerCase().trim(), c]));
    const bi = norm(beforeArr), ai = norm(afterArr);
    const keys = [...new Set([...bi.keys(), ...ai.keys()])];
    const rows = [];
    for (const k of keys) {
      const b = bi.get(k), a = ai.get(k);
      const name = (a && a.color) || (b && b.color) || k || '(sin nombre)';
      if (b && !a)      { rows.push(_varRow(name, _varStock(b), 'eliminada')); continue; }
      if (!b && a)      { rows.push(_varRow(name, 'nueva', _varStock(a))); continue; }
      // Modificada: comparar stock, precio del pack y costo por separado.
      const sb = _varStock(b), sa = _varStock(a);
      if (sb !== sa) rows.push(_varRow(`${name} · stock`, sb, sa));
      const pb = Number(b.precio_pack) || 0, pa = Number(a.precio_pack) || 0;
      if (pb !== pa) rows.push(_varRow(`${name} · precio`, _money(pb), _money(pa)));
      const cb = Number(b.costo) || 0, ca = Number(a.costo) || 0;
      if (cb !== ca) rows.push(_varRow(`${name} · costo`, _money(cb), _money(ca)));
    }
    if (!rows.length) rows.push(`<div class="ch-row"><span class="ch-f">Variantes</span><span class="ch-v">sin cambios</span></div>`);
    return rows.join('');
  }

  function _changeRowsHtml(entry) {
    return entry.changes.slice(0, 8).map(c => {
      if (c.before === null) return `<div class="ch-row"><span class="ch-f">Alta</span><span class="ch-v">producto creado</span></div>`;
      if (c.after === null)  return `<div class="ch-row"><span class="ch-f">Baja</span><span class="ch-v">producto borrado</span></div>`;
      return Object.keys(c.after).map(k => {
        if (k === 'conjunto_colores') return _variantesDiffRows(c.before[k], c.after[k]);
        return `
        <div class="ch-row">
          <span class="ch-f">${_escHtml(fieldLabel(k))}</span>
          <span class="ch-v"><b class="ch-old">${_escHtml(fmtVal(c.before[k]))}</b> → <b class="ch-new">${_escHtml(fmtVal(c.after[k]))}</b></span>
        </div>`;
      }).join('');
    }).join('') + (entry.changes.length > 8 ? `<div class="ch-row ch-more">+${entry.changes.length - 8} más…</div>` : '');
  }

  function _renderPanelIfOpen() { if (panelEl && panelEl.isConnected) _fillPanel(); }

  function _fillPanel() {
    const undos = [...undoStack].reverse();
    const redos = [...redoStack].reverse();
    panelEl.querySelector('#hist-body').innerHTML = `
      ${undos.length ? '' : `<div class="hist-empty"><span class="material-icons" style="font-size:34px;opacity:.4">history</span><p>Sin cambios para deshacer todavía.</p></div>`}
      ${undos.map(e => `
        <div class="hist-card">
          <div class="hist-card-head">
            <div class="hist-label">${_escHtml(e.label)}</div>
            <button class="hist-undo-btn" data-id="${e.id}"><span class="material-icons" style="font-size:15px">undo</span>Deshacer</button>
          </div>
          <div class="hist-changes">${_changeRowsHtml(e)}</div>
        </div>`).join('')}
      ${redos.length ? `<div class="hist-sep">Rehacer disponibles</div>` : ''}
      ${redos.map(e => `
        <div class="hist-card hist-card-redo">
          <div class="hist-card-head">
            <div class="hist-label">${_escHtml(e.label)}</div>
            <button class="hist-redo-btn"><span class="material-icons" style="font-size:15px">redo</span>Rehacer</button>
          </div>
        </div>`).join('')}
    `;
    panelEl.querySelectorAll('.hist-undo-btn').forEach(b =>
      b.addEventListener('click', () => undoTo(parseInt(b.dataset.id))));
    panelEl.querySelectorAll('.hist-redo-btn').forEach(b =>
      b.addEventListener('click', () => redo()));
  }

  function openPanel() {
    closePanel();
    panelEl = document.createElement('div');
    panelEl.className = 'hist-overlay';
    panelEl.innerHTML = `
      <div class="hist-drawer">
        <div class="hist-head">
          <h3><span class="material-icons" style="font-size:20px">history</span> Historial de cambios</h3>
          <button id="hist-close" class="hist-close"><span class="material-icons">close</span></button>
        </div>
        <div id="hist-body" class="hist-bodylist"></div>
      </div>`;
    document.body.appendChild(panelEl);
    _injectStyles();
    _fillPanel();
    panelEl.querySelector('#hist-close').addEventListener('click', closePanel);
    panelEl.addEventListener('click', e => { if (e.target === panelEl) closePanel(); });
  }

  function closePanel() {
    if (panelEl) { panelEl.remove(); panelEl = null; }
  }

  function _injectStyles() {
    if (document.getElementById('hist-styles')) return;
    const st = document.createElement('style');
    st.id = 'hist-styles';
    st.textContent = `
      .hist-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:10040;display:flex;justify-content:flex-end}
      .hist-drawer{width:420px;max-width:92vw;height:100%;background:var(--surface,#fff);box-shadow:-8px 0 30px rgba(0,0,0,0.2);display:flex;flex-direction:column;animation:histIn .18s ease}
      @keyframes histIn{from{transform:translateX(30px);opacity:.4}to{transform:none;opacity:1}}
      .hist-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--border,#e5e7eb)}
      .hist-head h3{margin:0;display:flex;align-items:center;gap:8px;font-size:16px;color:var(--text,#111)}
      .hist-close{background:none;border:none;cursor:pointer;color:var(--text-muted,#6b7280);display:flex}
      .hist-bodylist{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
      .hist-empty{text-align:center;color:var(--text-muted,#9ca3af);padding:40px 10px;font-size:13px}
      .hist-card{border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:11px 13px;background:var(--surface,#fff)}
      .hist-card-redo{opacity:.8;border-style:dashed}
      .hist-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
      .hist-label{font-weight:700;font-size:13.5px;color:var(--text,#111)}
      .hist-undo-btn,.hist-redo-btn{display:flex;align-items:center;gap:4px;border:1px solid var(--border,#d1d5db);background:var(--surface-2,#f3f4f6);color:var(--text,#111);border-radius:7px;padding:5px 10px;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap}
      .hist-undo-btn:hover{background:#fde68a;border-color:#f59e0b}
      .hist-redo-btn:hover{background:#cffafe;border-color:#06b6d4}
      .hist-changes{margin-top:8px;display:flex;flex-direction:column;gap:3px}
      .ch-row{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:2px 0;border-top:1px dashed var(--border,#eee)}
      .ch-row:first-child{border-top:none}
      .ch-f{color:var(--text-muted,#6b7280);flex-shrink:0}
      .ch-v{text-align:right}
      .ch-old{color:#b91c1c;font-weight:600}
      .ch-new{color:#15803d;font-weight:700}
      .ch-more{color:var(--text-muted,#9ca3af);font-style:italic;justify-content:center}
      .hist-sep{margin:6px 0 2px;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted,#9ca3af);font-weight:700}
    `;
    document.head.appendChild(st);
  }

  // ── Atajos de teclado ─────────────────────────────────────────────────────
  function _onKey(e) {
    if (!isActive()) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (typing) return;
    const z = e.key === 'z' || e.key === 'Z';
    const y = e.key === 'y' || e.key === 'Y';
    if ((e.ctrlKey || e.metaKey) && z && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (y || (z && e.shiftKey))) { e.preventDefault(); redo(); }
  }
  function attachKeyboard() {
    // Dedupe: al re-entrar a la página se crea una instancia nueva; quitamos el
    // handler de la instancia anterior para no acumular listeners en document.
    try {
      if (window.__catHistKeyHandler) document.removeEventListener('keydown', window.__catHistKeyHandler);
      window.__catHistKeyHandler = _onKey;
    } catch (_) {}
    document.addEventListener('keydown', _onKey);
  }
  function detachKeyboard() {
    document.removeEventListener('keydown', _onKey);
    try { if (window.__catHistKeyHandler === _onKey) window.__catHistKeyHandler = null; } catch (_) {}
    closePanel();
  }

  function canUndo() { return undoStack.length > 0; }
  function pendingCount() { return undoStack.length; }

  _load();

  return {
    commitFields, recordCreate, recordUpdate, recordDelete, recordBatch,
    undo, redo, undoTo, openPanel, closePanel,
    attachKeyboard, detachKeyboard, canUndo, pendingCount,
  };
}
