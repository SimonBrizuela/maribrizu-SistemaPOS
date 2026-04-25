import {
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, query, orderBy, serverTimestamp, Timestamp
} from 'firebase/firestore';
import { getCached, peekCache, invalidateCacheByPrefix } from '../cache.js';

const TIPOS_PROMO = {
  percentage: { label: 'Descuento %',           icon: 'percent' },
  fixed:      { label: 'Descuento fijo $',       icon: 'remove_circle_outline' },
  '2x1':      { label: '2x1 (lleva 2, paga 1)',  icon: 'filter_2' },
  nxm:        { label: 'NxM (lleva N, paga M)',  icon: 'swap_horiz' },
  bundle:     { label: 'Pack / Combo',           icon: 'inventory' },
};

function fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function renderPromociones(container, db) {
  // ── Cargar datos (cache 60s promos, 2 min catálogo) ───────────────────────
  const [promosCacheadas, catalogoMap] = await Promise.all([
    getCached('promos:lista', async () => {
      const snap = await getDocs(query(collection(db, 'promociones'), orderBy('created_at', 'desc')));
      return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    }, { ttl: 60000, memOnly: true }),
    getCached('promos:catalogo_min', async () => {
      const snap = await getDocs(collection(db, 'catalogo'));
      const map = {};
      snap.docs.forEach(d => {
        const data = d.data();
        map[d.id] = { id: d.id, nombre: data.nombre || data.name || d.id, codigo: data.codigo || '' };
      });
      return map;
    }, { ttl: 120000, memOnly: true }),
  ]);

  // Copia local mutable: la vista modifica esta lista (toggle, delete, add)
  let promociones = [...promosCacheadas];
  const catalogoList = Object.values(catalogoMap).sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));

  // ── Shell ─────────────────────────────────────────────────────────────────
  container.innerHTML = `
  <style>
    .promo-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:10px; }
    .promo-header h3 { margin:0; font-size:1.2rem; color:#1a1a2e; }
    .btn-primary { background:#4361ee; color:#fff; border:none; border-radius:8px; padding:9px 18px; font-size:14px; font-weight:600; cursor:pointer; display:flex; align-items:center; gap:6px; }
    .btn-primary:hover { background:#3a56d4; }
    .btn-sm { padding:5px 10px; font-size:12px; border-radius:6px; border:none; cursor:pointer; font-weight:600; display:inline-flex; align-items:center; gap:4px; }
    .btn-edit { background:#fff3cd; color:#856404; }
    .btn-edit:hover { background:#ffe69c; }
    .btn-delete { background:#f8d7da; color:#842029; }
    .btn-delete:hover { background:#f1aeb5; }
    .btn-toggle-on  { background:#d1e7dd; color:#0f5132; }
    .btn-toggle-on:hover  { background:#a3cfbb; }
    .btn-toggle-off { background:#e9ecef; color:#6c757d; }
    .btn-toggle-off:hover { background:#dee2e6; }
    .promo-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap:16px; }
    .promo-card { background:#fff; border-radius:12px; border:1px solid #e0e4ef; padding:18px; box-shadow:0 2px 8px rgba(0,0,0,.05); }
    .promo-card.inactive { opacity:.6; border-style:dashed; }
    .promo-card-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px; }
    .promo-name { font-size:1rem; font-weight:700; color:#1a1a2e; margin:0 0 4px; }
    .promo-type-badge { background:#eef2ff; color:#4361ee; border-radius:6px; padding:2px 8px; font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:3px; white-space:nowrap; }
    .promo-type-badge .material-icons { font-size:13px !important; }
    .promo-desc { font-size:12px; color:#6c757d; margin-bottom:10px; }
    .promo-detail { font-size:13px; color:#495057; margin-bottom:6px; display:flex; align-items:center; gap:6px; }
    .promo-detail .material-icons { font-size:15px !important; color:#4361ee; }
    .promo-products { display:flex; flex-wrap:wrap; gap:4px; margin-top:8px; }
    .promo-product-tag { background:#f0f4ff; color:#4361ee; border-radius:4px; padding:2px 6px; font-size:11px; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .promo-actions { display:flex; gap:6px; margin-top:14px; flex-wrap:wrap; }
    .empty-state { text-align:center; padding:60px 20px; color:#6c757d; }
    .empty-state .material-icons { font-size:48px; display:block; margin-bottom:12px; color:#adb5bd; }

    /* Modal */
    .modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px; }
    .modal-box { background:#fff; border-radius:14px; padding:28px; width:100%; max-width:560px; max-height:90vh; overflow-y:auto; box-shadow:0 8px 32px rgba(0,0,0,.18); }
    .modal-title { font-size:1.1rem; font-weight:700; color:#1a1a2e; margin:0 0 20px; }
    .form-group { margin-bottom:14px; }
    .form-group label { display:block; font-size:13px; font-weight:600; color:#495057; margin-bottom:5px; }
    .form-group input, .form-group select, .form-group textarea {
      width:100%; padding:8px 12px; border:1.5px solid #dee2e6; border-radius:8px;
      font-size:14px; box-sizing:border-box; font-family:inherit; outline:none; transition:border .2s;
    }
    .form-group input:focus, .form-group select:focus, .form-group textarea:focus { border-color:#4361ee; }
    .form-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .form-hint { font-size:11px; color:#6c757d; margin-top:3px; }
    .product-search-box { position:relative; }
    .product-search-results { position:absolute; top:100%; left:0; right:0; background:#fff; border:1.5px solid #dee2e6; border-radius:8px; max-height:200px; overflow-y:auto; z-index:100; box-shadow:0 4px 16px rgba(0,0,0,.1); display:none; }
    .product-search-results.visible { display:block; }
    .product-result-item { padding:8px 12px; cursor:pointer; font-size:13px; border-bottom:1px solid #f0f0f0; }
    .product-result-item:hover { background:#f0f4ff; }
    .selected-products-list { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; min-height:24px; }
    .selected-product-tag { background:#eef2ff; color:#4361ee; border-radius:6px; padding:3px 8px; font-size:12px; display:inline-flex; align-items:center; gap:4px; }
    .selected-product-tag button { background:none; border:none; cursor:pointer; color:#4361ee; padding:0; line-height:1; font-size:14px; }
    .modal-footer { display:flex; justify-content:flex-end; gap:10px; margin-top:20px; padding-top:16px; border-top:1px solid #e9ecef; }
    .btn-cancel { background:#f8f9fa; border:1px solid #dee2e6; border-radius:8px; padding:8px 18px; font-size:14px; cursor:pointer; font-weight:600; color:#495057; }
    .btn-cancel:hover { background:#e9ecef; }
    .btn-save { background:#4361ee; color:#fff; border:none; border-radius:8px; padding:9px 22px; font-size:14px; font-weight:700; cursor:pointer; }
    .btn-save:hover { background:#3a56d4; }
    .field-hide { display:none; }
  </style>

  <div class="promo-header">
    <h3><span class="material-icons" style="vertical-align:middle;margin-right:6px;color:#4361ee">local_offer</span>Promociones</h3>
    <button class="btn-primary" id="btnNuevaPromo">
      <span class="material-icons" style="font-size:18px">add</span> Nueva Promoción
    </button>
  </div>

  <div id="promoGrid" class="promo-grid"></div>
  `;

  const grid = container.querySelector('#promoGrid');

  // ── Render tarjetas ──────────────────────────────────────────────────────
  function renderGrid() {
    if (promociones.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <span class="material-icons">local_offer</span>
          <p>No hay promociones creadas todavía.</p>
          <p style="font-size:12px">Hacé clic en <b>Nueva Promoción</b> para crear la primera.</p>
        </div>`;
      return;
    }

    grid.innerHTML = promociones.map(p => {
      const tipo  = TIPOS_PROMO[p.tipo] || { label: p.tipo, icon: 'label' };
      const activo = p.activo !== false;
      const productosIds = p.productos || [];
      const productosNombres = productosIds.map(id => catalogoMap[id]?.nombre || id);

      let detalleHtml = '';
      if (p.tipo === 'percentage') {
        detalleHtml = `<div class="promo-detail"><span class="material-icons">percent</span>${p.valor}% de descuento</div>`;
      } else if (p.tipo === 'fixed') {
        detalleHtml = `<div class="promo-detail"><span class="material-icons">attach_money</span>$${fmt(p.valor)} de descuento por unidad</div>`;
      } else if (p.tipo === '2x1') {
        detalleHtml = `<div class="promo-detail"><span class="material-icons">filter_2</span>Llevá 2, pagá 1</div>`;
      } else if (p.tipo === 'nxm') {
        detalleHtml = `<div class="promo-detail"><span class="material-icons">swap_horiz</span>Llevá ${p.cantidad_requerida}, pagá ${p.cantidad_paga}</div>`;
      } else if (p.tipo === 'bundle') {
        detalleHtml = `<div class="promo-detail"><span class="material-icons">inventory</span>Pack de ${p.cantidad_requerida} unidades por $${fmt(p.valor)}</div>`;
      }

      const cantMinHtml = (p.cantidad_minima && p.cantidad_minima > 1)
        ? `<div class="promo-detail"><span class="material-icons">production_quantity_limits</span>Aplica desde <b>${p.cantidad_minima}</b> unidades</div>`
        : '';

      return `
      <div class="promo-card${activo ? '' : ' inactive'}" data-id="${p._id}">
        <div class="promo-card-header">
          <div>
            <div class="promo-name">${p.nombre}</div>
            <span class="promo-type-badge">
              <span class="material-icons">${tipo.icon}</span>${tipo.label}
            </span>
          </div>
          <span style="font-size:11px;padding:3px 8px;border-radius:20px;font-weight:700;${activo ? 'background:#d1e7dd;color:#0f5132' : 'background:#e9ecef;color:#6c757d'}">
            ${activo ? 'Activa' : 'Inactiva'}
          </span>
        </div>
        ${p.descripcion ? `<div class="promo-desc">${p.descripcion}</div>` : ''}
        ${detalleHtml}
        ${cantMinHtml}
        ${productosNombres.length > 0 ? `
          <div style="font-size:12px;color:#6c757d;margin-top:8px;margin-bottom:4px;font-weight:600">
            Productos (${productosNombres.length}):
          </div>
          <div class="promo-products">
            ${productosNombres.slice(0, 5).map(n => `<span class="promo-product-tag" title="${n}">${n}</span>`).join('')}
            ${productosNombres.length > 5 ? `<span class="promo-product-tag">+${productosNombres.length - 5} más</span>` : ''}
          </div>` : '<div class="promo-desc" style="margin-top:8px">⚠️ Sin productos asignados</div>'
        }
        <div class="promo-actions">
          <button class="btn-sm btn-edit" data-action="edit" data-id="${p._id}">
            <span class="material-icons" style="font-size:14px">edit</span>Editar
          </button>
          <button class="btn-sm ${activo ? 'btn-toggle-on' : 'btn-toggle-off'}" data-action="toggle" data-id="${p._id}">
            <span class="material-icons" style="font-size:14px">${activo ? 'toggle_on' : 'toggle_off'}</span>
            ${activo ? 'Desactivar' : 'Activar'}
          </button>
          <button class="btn-sm btn-delete" data-action="delete" data-id="${p._id}">
            <span class="material-icons" style="font-size:14px">delete</span>Eliminar
          </button>
        </div>
      </div>`;
    }).join('');
  }

  renderGrid();

  // ── Delegación de eventos en tarjetas ────────────────────────────────────
  grid.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id     = btn.dataset.id;
    const promo  = promociones.find(p => p._id === id);
    if (!promo) return;

    if (action === 'edit') {
      openModal(promo);
    } else if (action === 'toggle') {
      const newActivo = promo.activo === false ? true : false;
      await updateDoc(doc(db, 'promociones', id), { activo: newActivo });
      invalidateCacheByPrefix('promociones');
      invalidateCacheByPrefix('promos:');
      promo.activo = newActivo;
      renderGrid();
    } else if (action === 'delete') {
      if (!confirm(`¿Eliminar la promoción "${promo.nombre}"?\nEsta acción no se puede deshacer.`)) return;
      await deleteDoc(doc(db, 'promociones', id));
      invalidateCacheByPrefix('promociones');
      invalidateCacheByPrefix('promos:');
      promociones = promociones.filter(p => p._id !== id);
      renderGrid();
    }
  });

  // ── Nueva promo ──────────────────────────────────────────────────────────
  container.querySelector('#btnNuevaPromo').addEventListener('click', () => openModal(null));

  // ── Modal ────────────────────────────────────────────────────────────────
  function openModal(promo) {
    const isEdit = !!promo;
    const selectedProducts = promo ? [...(promo.productos || [])] : [];

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">${isEdit ? 'Editar Promoción' : 'Nueva Promoción'}</div>

      <div class="form-group">
        <label>Nombre *</label>
        <input id="mNombre" type="text" placeholder="Ej: 3x2 en shampú" value="${promo?.nombre || ''}">
      </div>
      <div class="form-group">
        <label>Tipo de promoción *</label>
        <select id="mTipo">
          ${Object.entries(TIPOS_PROMO).map(([k, v]) =>
            `<option value="${k}" ${(promo?.tipo === k) ? 'selected' : ''}>${v.label}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Descripción (opcional)</label>
        <textarea id="mDesc" rows="2" placeholder="Descripción visible para el vendedor">${promo?.descripcion || ''}</textarea>
      </div>

      <!-- Valor / descuento -->
      <div class="form-group" id="grpValor">
        <label id="lblValor">Valor del descuento *</label>
        <input id="mValor" type="number" min="0" step="0.01" placeholder="0" value="${promo?.valor ?? ''}">
        <div class="form-hint" id="hintValor"></div>
      </div>

      <!-- Cantidad requerida (NxM, bundle) -->
      <div class="form-row">
        <div class="form-group" id="grpCantReq">
          <label id="lblCantReq">Cantidad que lleva (N)</label>
          <input id="mCantReq" type="number" min="1" step="1" placeholder="3" value="${promo?.cantidad_requerida ?? ''}">
        </div>
        <div class="form-group" id="grpCantPaga">
          <label>Cantidad que paga (M)</label>
          <input id="mCantPaga" type="number" min="1" step="1" placeholder="2" value="${promo?.cantidad_paga ?? ''}">
        </div>
      </div>

      <!-- Cantidad mínima para que aplique -->
      <div class="form-group">
        <label>Cantidad mínima para activar la promo</label>
        <input id="mCantMin" type="number" min="1" step="1" placeholder="1" value="${promo?.cantidad_minima ?? 1}">
        <div class="form-hint">Si el cliente compra menos de esta cantidad, NO se aplica el descuento.</div>
      </div>

      <!-- Productos -->
      <div class="form-group">
        <label>Buscar y agregar productos *</label>
        <div class="product-search-box">
          <input id="mProductoSearch" type="text" placeholder="Escribí el nombre del producto...">
          <div class="product-search-results" id="mProductoResults"></div>
        </div>
        <div class="selected-products-list" id="mSelectedProducts"></div>
        <div class="form-hint">El POS aplicará esta promo automáticamente cuando se agregue cualquiera de estos productos al carrito.</div>
      </div>

      <div class="modal-footer">
        <button class="btn-cancel" id="mBtnCancel">Cancelar</button>
        <button class="btn-save" id="mBtnSave">${isEdit ? 'Guardar cambios' : 'Crear promoción'}</button>
      </div>
    </div>`;

    document.body.appendChild(modal);

    // Render chips de productos ya seleccionados
    function renderSelectedChips() {
      const container2 = modal.querySelector('#mSelectedProducts');
      container2.innerHTML = selectedProducts.map(id => {
        const nombre = catalogoMap[id]?.nombre || id;
        return `<span class="selected-product-tag">
          ${nombre}
          <button data-remove="${id}" title="Quitar">×</button>
        </span>`;
      }).join('');
      container2.querySelectorAll('button[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          const rid = btn.dataset.remove;
          const idx = selectedProducts.indexOf(rid);
          if (idx > -1) selectedProducts.splice(idx, 1);
          renderSelectedChips();
        });
      });
    }
    renderSelectedChips();

    // Búsqueda de productos
    const searchInput = modal.querySelector('#mProductoSearch');
    const resultsDiv  = modal.querySelector('#mProductoResults');

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (q.length < 2) { resultsDiv.classList.remove('visible'); return; }
      const matches = catalogoList.filter(p =>
        (p.nombre || '').toLowerCase().includes(q) && !selectedProducts.includes(p.id)
      ).slice(0, 20);
      if (matches.length === 0) { resultsDiv.classList.remove('visible'); return; }
      resultsDiv.innerHTML = matches.map(p =>
        `<div class="product-result-item" data-id="${p.id}">${p.nombre}${p.codigo ? ` <small style="color:#aaa">[${p.codigo}]</small>` : ''}</div>`
      ).join('');
      resultsDiv.classList.add('visible');
      resultsDiv.querySelectorAll('.product-result-item').forEach(item => {
        item.addEventListener('click', () => {
          selectedProducts.push(item.dataset.id);
          searchInput.value = '';
          resultsDiv.classList.remove('visible');
          renderSelectedChips();
        });
      });
    });
    document.addEventListener('click', e => {
      if (!modal.querySelector('.product-search-box').contains(e.target)) {
        resultsDiv.classList.remove('visible');
      }
    }, { once: false });

    // Lógica dinámica según tipo
    function updateFieldsByTipo() {
      const tipo = modal.querySelector('#mTipo').value;
      const grpValor   = modal.querySelector('#grpValor');
      const grpCantReq = modal.querySelector('#grpCantReq');
      const grpCantPaga= modal.querySelector('#grpCantPaga');
      const lblValor   = modal.querySelector('#lblValor');
      const lblCantReq = modal.querySelector('#lblCantReq');
      const hintValor  = modal.querySelector('#hintValor');

      // Reset
      grpValor.classList.remove('field-hide');
      grpCantReq.classList.remove('field-hide');
      grpCantPaga.classList.remove('field-hide');

      if (tipo === 'percentage') {
        lblValor.textContent   = 'Porcentaje de descuento (%) *';
        hintValor.textContent  = 'Ej: 15 → 15% de descuento';
        grpCantReq.classList.add('field-hide');
        grpCantPaga.classList.add('field-hide');
      } else if (tipo === 'fixed') {
        lblValor.textContent   = 'Monto de descuento ($) *';
        hintValor.textContent  = 'Se restará este monto al precio de cada unidad';
        grpCantReq.classList.add('field-hide');
        grpCantPaga.classList.add('field-hide');
      } else if (tipo === '2x1') {
        grpValor.classList.add('field-hide');
        grpCantReq.classList.add('field-hide');
        grpCantPaga.classList.add('field-hide');
      } else if (tipo === 'nxm') {
        grpValor.classList.add('field-hide');
        lblCantReq.textContent = 'Cantidad que lleva (N)';
      } else if (tipo === 'bundle') {
        lblValor.textContent   = 'Precio especial del pack ($) *';
        hintValor.textContent  = 'Precio total por el pack de N unidades';
        lblCantReq.textContent = 'Unidades en el pack (N)';
        grpCantPaga.classList.add('field-hide');
      }
    }

    modal.querySelector('#mTipo').addEventListener('change', updateFieldsByTipo);
    updateFieldsByTipo();

    // Cerrar
    modal.querySelector('#mBtnCancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    // Guardar
    modal.querySelector('#mBtnSave').addEventListener('click', async () => {
      const nombre    = modal.querySelector('#mNombre').value.trim();
      const tipo      = modal.querySelector('#mTipo').value;
      const desc      = modal.querySelector('#mDesc').value.trim();
      const valor     = parseFloat(modal.querySelector('#mValor').value) || 0;
      const cantReq   = parseInt(modal.querySelector('#mCantReq').value) || 1;
      const cantPaga  = parseInt(modal.querySelector('#mCantPaga').value) || 1;
      const cantMin   = parseInt(modal.querySelector('#mCantMin').value) || 1;

      if (!nombre) { alert('El nombre es obligatorio'); return; }
      if (selectedProducts.length === 0) { alert('Debés seleccionar al menos un producto'); return; }
      if ((tipo === 'percentage' || tipo === 'fixed' || tipo === 'bundle') && valor <= 0) {
        alert('Ingresá un valor mayor a 0'); return;
      }
      if (tipo === 'nxm' && cantReq <= cantPaga) {
        alert('La cantidad que lleva (N) debe ser mayor que la que paga (M)'); return;
      }

      const data = {
        nombre,
        tipo,
        descripcion: desc,
        valor,
        cantidad_requerida: cantReq,
        cantidad_paga:      cantPaga,
        cantidad_minima:    cantMin,
        productos:          selectedProducts,
        activo:             isEdit ? (promo.activo !== false) : true,
        updated_at:         serverTimestamp(),
      };
      if (!isEdit) data.created_at = serverTimestamp();

      try {
        if (isEdit) {
          await updateDoc(doc(db, 'promociones', promo._id), data);
          Object.assign(promo, data);
          // actualizar localmente (timestamps no resueltos aún, no importa para render)
        } else {
          const ref = await addDoc(collection(db, 'promociones'), data);
          promociones.unshift({ _id: ref.id, ...data });
        }
        invalidateCacheByPrefix('promos:');
        modal.remove();
        renderGrid();
      } catch (err) {
        alert('Error guardando: ' + err.message);
      }
    });
  }
}
