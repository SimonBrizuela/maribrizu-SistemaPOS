import {
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, query, orderBy, serverTimestamp, Timestamp
} from 'firebase/firestore';
import { getCached, peekCache, invalidateCacheByPrefix } from '../cache.js';
import { confirmDialog, alertDialog, escHtml } from '../components/dialogs.js';

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
  // Shell vacío al toque: header con título real + grilla de placeholders.
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
      <h3 style="margin:0">
        <span class="material-icons" style="vertical-align:middle;margin-right:6px;color:var(--tint-blue-fg)">local_offer</span>
        Promociones
      </h3>
      <button class="btn-primary" disabled style="opacity:0.6">
        <span class="material-icons" style="font-size:18px">add</span> Nueva Promoción
      </button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px">
      ${Array(6).fill('<div class="skel skel-card" style="height:200px"></div>').join('')}
    </div>
  `;

  // ── Cargar datos (cache 60s promos, 2 min catálogo) ───────────────────────
  const [promosCacheadas, catalogoMap] = await Promise.all([
    getCached('promos:lista', async () => {
      const snap = await getDocs(query(collection(db, 'promociones'), orderBy('created_at', 'desc')));
      return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    }, { ttl: 60000, memOnly: true }),
    // v3 agrega detección de modos de venta (pack/unidad) por producto y variante.
    getCached('promos:catalogo_min_v3', async () => {
      const snap = await getDocs(collection(db, 'catalogo'));
      const map = {};
      snap.docs.forEach(d => {
        const data = d.data();
        const variedades = Array.isArray(data.conjunto_colores) ? data.conjunto_colores : [];
        const esConjunto = !!data.es_conjunto;
        // Modos disponibles a nivel producto. Para no-conjunto siempre es ['unidad'].
        // Para conjunto: 'pack' si hay precio_venta o alguna variante con precio_pack;
        //                'unidad' si hay precio unitario propio o por variante o contenido > 0.
        let modosProd = ['unidad'];
        if (esConjunto) {
          const tienePack = Number(data.precio_venta) > 0
            || variedades.some(v => Number(v && v.precio_pack) > 0);
          const tieneUnid = Number(data.conjunto_precio_unidad) > 0
            || Number(data.conjunto_contenido) > 0
            || variedades.some(v => Number(v && v.precio) > 0);
          modosProd = [];
          if (tienePack) modosProd.push('pack');
          if (tieneUnid) modosProd.push('unidad');
          if (modosProd.length === 0) modosProd = ['pack'];
        }
        map[d.id] = {
          id: d.id,
          nombre: data.nombre || data.name || d.id,
          codigo: data.codigo || '',
          es_conjunto: esConjunto,
          modos: modosProd,
          variantes: variedades
            .filter(v => v && v.color)
            .map(v => {
              // Modos por variante: ajusta a los precios de la fila.
              const tienePackV = Number(v.precio_pack) > 0 || Number(data.precio_venta) > 0;
              const tieneUnidV = Number(v.precio) > 0 || Number(data.conjunto_precio_unidad) > 0 || Number(data.conjunto_contenido) > 0;
              const ms = [];
              if (tienePackV) ms.push('pack');
              if (tieneUnidV) ms.push('unidad');
              return {
                color: String(v.color),
                codigo: v.codigo || '',
                modos: ms.length ? ms : modosProd,
              };
            }),
        };
      });
      return map;
    }, { ttl: 120000, memOnly: true }),
  ]);

  // Copia local mutable: la vista modifica esta lista (toggle, delete, add)
  let promociones = [...promosCacheadas];
  const catalogoList = Object.values(catalogoMap).sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));

  // Construyo un índice plano para buscar productos + variantes en una sola pasada.
  // Cada item: { kind: 'producto'|'variante', key, productoId, color?, nombre, subtitulo, codigo }
  // - key: identificador único usado en la lista de seleccionados (productoId o productoId::var::Color)
  // - subtitulo: texto auxiliar para mostrar en el resultado de búsqueda
  const VAR_SEP = '::var::';
  const searchIndex = [];
  catalogoList.forEach(p => {
    searchIndex.push({
      kind: 'producto',
      key: p.id,
      productoId: p.id,
      nombre: p.nombre,
      subtitulo: p.codigo ? `[${p.codigo}]` : '',
      codigo: p.codigo,
      modos: p.modos || ['unidad'],
      es_conjunto: !!p.es_conjunto,
    });
    (p.variantes || []).forEach(v => {
      searchIndex.push({
        kind: 'variante',
        key: `${p.id}${VAR_SEP}${v.color}`,
        productoId: p.id,
        color: v.color,
        nombre: p.nombre,
        subtitulo: `· ${v.color}${v.codigo ? ` [${v.codigo}]` : ''}`,
        codigo: v.codigo,
        modos: v.modos || p.modos || ['unidad'],
        es_conjunto: true,
      });
    });
  });

  function labelForKey(key) {
    if (!key) return key;
    if (key.includes(VAR_SEP)) {
      const [pid, color] = key.split(VAR_SEP);
      const nombre = catalogoMap[pid]?.nombre || pid;
      return `${nombre} · ${color}`;
    }
    return catalogoMap[key]?.nombre || key;
  }

  // Modos disponibles para una key seleccionada (producto entero o variante).
  function modosForKey(key) {
    if (!key) return ['unidad'];
    if (key.includes(VAR_SEP)) {
      const [pid, color] = key.split(VAR_SEP);
      const p = catalogoMap[pid];
      const v = (p?.variantes || []).find(x => x.color === color);
      return v?.modos || p?.modos || ['unidad'];
    }
    return catalogoMap[key]?.modos || ['unidad'];
  }

  // ── Shell ─────────────────────────────────────────────────────────────────
  container.innerHTML = `
  <style>
    .promo-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:10px; }
    .promo-header h3 { margin:0; font-size:1.2rem; color:var(--text-strong); }
    .btn-primary { background:var(--primary); color:#fff; border:none; border-radius:10px; padding:9px 18px; font-size:14px; font-weight:600; cursor:pointer; display:flex; align-items:center; gap:6px; }
    .btn-primary:hover { background:var(--primary-dark); }
    .btn-sm { padding:6px 11px; font-size:12px; border-radius:8px; border:1px solid transparent; cursor:pointer; font-weight:600; display:inline-flex; align-items:center; gap:4px; }
    .btn-edit { background:var(--surface); color:var(--text); border-color:var(--border); }
    .btn-edit:hover { border-color:var(--border-strong); }
    .btn-delete { background:var(--surface); color:var(--tint-red-fg); border-color:var(--border); }
    .btn-delete:hover { background:var(--tint-red-bg); border-color:var(--tint-red-fg); }
    .btn-toggle-on  { background:var(--surface); color:var(--text-muted); border-color:var(--border); }
    .btn-toggle-on:hover, .btn-toggle-off:hover { border-color:var(--border-strong); }
    .btn-toggle-off { background:var(--surface); color:var(--tint-green-fg); border-color:var(--border); }
    .promo-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap:16px; }
    .promo-card { background:var(--card-bg); border-radius:12px; border:1px solid var(--border); padding:16px 18px; box-shadow:var(--shadow-sm); display:flex; flex-direction:column; }
    .promo-card:hover { border-color:var(--border-strong); }
    .promo-card.inactive { opacity:.55; }
    .promo-card-header { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:10px; }
    .promo-name { font-size:15px; font-weight:700; color:var(--text-strong); margin:0 0 6px; }
    .promo-state { font-size:11px; padding:3px 9px; border-radius:999px; font-weight:700; white-space:nowrap; flex:none; }
    .promo-state.on  { background:var(--tint-green-bg); color:var(--tint-green-fg); }
    .promo-state.off { background:var(--surface-2); color:var(--text-muted); }
    .promo-type-badge { background:var(--tint-purple-bg); color:var(--tint-purple-fg); border-radius:6px; padding:2px 8px; font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
    .promo-type-badge .material-icons { font-size:13px !important; }
    .promo-desc { font-size:12px; color:var(--text-muted); margin-bottom:10px; }
    .promo-detail { font-size:13px; color:var(--text); margin-bottom:5px; display:flex; align-items:center; gap:7px; }
    .promo-detail b { color:var(--text-strong); }
    .promo-detail .material-icons { font-size:15px !important; color:var(--text-muted); }
    .promo-products-lbl { font-size:11px; color:var(--text-muted); margin:10px 0 4px; font-weight:700; text-transform:uppercase; letter-spacing:.3px; }
    .promo-products { display:flex; flex-wrap:wrap; gap:4px; }
    .promo-product-tag { background:var(--tint-gray-bg); color:var(--tint-gray-fg); border-radius:5px; padding:2px 7px; font-size:11.5px; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .promo-actions { display:flex; gap:6px; margin-top:auto; padding-top:14px; flex-wrap:wrap; }
    .empty-state { text-align:center; padding:60px 20px; color:var(--text-muted); }
    .empty-state .material-icons { font-size:48px; display:block; margin-bottom:12px; color:var(--border-strong); }

    /* ── Modal (clases propias para que ningún CSS global lo pise) ── */
    .promo-modal { position:fixed; inset:0; background:var(--overlay); z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px; }
    .promo-modal .modal-box { background:var(--card-bg); border:1px solid var(--border); border-radius:14px; padding:24px 26px; width:100%; max-width:600px; max-height:92vh; overflow-y:auto; box-shadow:var(--shadow-modal); }
    .promo-modal .modal-title { font-size:1.1rem; font-weight:700; color:var(--text-strong); margin:0 0 18px; display:flex; align-items:center; gap:8px; }
    .promo-modal .modal-title .material-icons { color:var(--primary); }
    .promo-modal .form-group { margin-bottom:14px; }
    .promo-modal label { display:block; font-size:12.5px; font-weight:600; color:var(--text-muted); margin-bottom:5px; text-transform:none; letter-spacing:0; }
    .promo-modal input[type="text"], .promo-modal input[type="number"]:not(.modo-min-input),
    .promo-modal select, .promo-modal textarea {
      width:100%; padding:9px 12px; border:1.5px solid var(--border); border-radius:8px;
      background:var(--surface); color:var(--text); font-size:14px; box-sizing:border-box;
      font-family:inherit; outline:none; transition:border-color .15s;
    }
    .promo-modal input:focus, .promo-modal select:focus, .promo-modal textarea:focus { border-color:var(--primary); }
    .promo-modal input::placeholder, .promo-modal textarea::placeholder { color:var(--text-muted); opacity:.8; }
    .form-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .form-hint { font-size:11.5px; color:var(--text-muted); margin-top:4px; line-height:1.45; }
    .product-search-box { position:relative; }
    .product-search-results { position:absolute; top:100%; left:0; right:0; background:var(--card-bg); border:1.5px solid var(--border); border-radius:8px; max-height:220px; overflow-y:auto; z-index:100; box-shadow:var(--shadow-lg); display:none; }
    .product-search-results.visible { display:block; }
    .product-result-item { padding:8px 12px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border); color:var(--text); }
    .product-result-item:last-child { border-bottom:none; }
    .product-result-item:hover { background:var(--surface-hover); }
    .pm-kind { border-radius:4px; padding:1px 6px; font-size:10px; font-weight:700; margin-right:6px; }
    .pm-kind.prod { background:var(--tint-gray-bg); color:var(--tint-gray-fg); }
    .pm-kind.var  { background:var(--tint-purple-bg); color:var(--tint-purple-fg); }

    /* Productos/variantes elegidos: una fila por item. Arriba el nombre, abajo
       en qué modo de venta aplica la promo (Pack / Unidad) con su mínimo. */
    .selected-products-list { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
    .pm-chip { background:var(--surface-2); border:1px solid var(--border); border-radius:10px; padding:9px 12px; }
    .pm-chip-head { display:flex; align-items:center; gap:7px; }
    .pm-chip-name { font-weight:600; font-size:13px; color:var(--text); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pm-chip.is-var .pm-chip-name { color:var(--tint-purple-fg); }
    .pm-chip .material-icons.pm-var-ic { font-size:15px !important; color:var(--tint-purple-fg); }
    .pm-chip .pm-x { margin-left:auto; background:none; border:none; cursor:pointer; color:var(--text-muted); padding:2px 6px; line-height:1; font-size:16px; border-radius:6px; flex:none; }
    .pm-chip .pm-x:hover { color:var(--tint-red-fg); background:var(--tint-red-bg); }
    .pm-chip-modos { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:8px; padding-top:9px; border-top:1px dashed var(--border); }
    .pm-modos-lbl { font-size:11.5px; color:var(--text-muted); font-weight:600; }
    .pm-modo { display:inline-flex; align-items:center; gap:5px; font-size:12px; font-weight:600; padding:4px 11px; border-radius:999px; border:1.5px solid var(--border); cursor:pointer; background:var(--surface); color:var(--text-muted); user-select:none; line-height:1.6; }
    .pm-modo .material-icons { font-size:14px !important; }
    .pm-modo:hover { border-color:var(--border-strong); }
    .pm-modo.on { background:var(--primary); border-color:var(--primary); color:#fff; }
    .pm-modo.off .pm-off-txt { font-weight:500; font-size:11px; }
    .promo-modal .pm-modo input.modo-min-input {
      width:58px; font-size:12px; padding:1px 4px; margin:0 1px; border-radius:6px;
      border:1px solid rgba(255,255,255,.5); background:rgba(255,255,255,.16); color:#fff;
      font-weight:700; text-align:center; outline:none; -moz-appearance:textfield; font-family:inherit;
    }
    .promo-modal .pm-modo input.modo-min-input:focus { background:rgba(255,255,255,.28); }

    .modal-footer { display:flex; justify-content:flex-end; gap:10px; margin-top:20px; padding-top:16px; border-top:1px solid var(--border); }
    .btn-cancel { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:9px 18px; font-size:14px; cursor:pointer; font-weight:600; color:var(--text-muted); }
    .btn-cancel:hover { border-color:var(--border-strong); color:var(--text); }
    .btn-save { background:var(--primary); color:#fff; border:none; border-radius:8px; padding:9px 22px; font-size:14px; font-weight:700; cursor:pointer; }
    .btn-save:hover { background:var(--primary-dark); }
    .field-hide { display:none; }
    /* Mini input dentro del toggle de modo: sin spinners nativos */
    .modo-min-input::-webkit-outer-spin-button,
    .modo-min-input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
    .modo-min-input::placeholder { color:rgba(255,255,255,.75); font-weight:500; }
  </style>

  <div class="promo-header">
    <h3><span class="material-icons" style="vertical-align:middle;margin-right:6px;color:var(--tint-blue-fg)">local_offer</span>Promociones</h3>
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
      const variantesArr = Array.isArray(p.variantes) ? p.variantes : [];
      const modosGuardados = (p.modos && typeof p.modos === 'object') ? p.modos : {};
      const modoSuffix = (key) => {
        const raw = modosGuardados[key];
        if (!raw) return '';
        const map = { pack: 'Pack', unidad: 'Unidad' };
        // raw puede ser array (legacy) o objeto {mode: {min}}
        let parts = [];
        if (Array.isArray(raw)) {
          parts = raw.map(m => map[m] || m);
        } else if (typeof raw === 'object') {
          parts = Object.keys(raw).map(m => {
            const mv = raw[m];
            const min = (typeof mv === 'number') ? mv : (mv && Number(mv.min) || 0);
            return min > 0 ? `${map[m] || m}≥${min}` : (map[m] || m);
          });
        }
        if (!parts.length) return '';
        return ` <small style="color:var(--tint-purple-fg);font-weight:700">[${parts.join('/')}]</small>`;
      };
      const productosNombres = productosIds.map(id => (catalogoMap[id]?.nombre || id) + modoSuffix(id));
      const variantesNombres = variantesArr.map(v => {
        const n = catalogoMap[v.producto_id]?.nombre || v.producto_id;
        const key = `${v.producto_id}${VAR_SEP}${v.color}`;
        return `${n} · ${v.color}${modoSuffix(key)}`;
      });
      const itemsNombres = [...productosNombres, ...variantesNombres];

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
      const cantMaxHtml = (p.cantidad_maxima && p.cantidad_maxima > 0)
        ? `<div class="promo-detail"><span class="material-icons">block</span>Tope: hasta <b>${p.cantidad_maxima}</b> ${(p.tipo === '2x1' || p.tipo === 'nxm' || p.tipo === 'bundle') ? 'packs' : 'unidades'} con descuento</div>`
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
          <span class="promo-state ${activo ? 'on' : 'off'}">${activo ? 'Activa' : 'Inactiva'}</span>
        </div>
        ${p.descripcion ? `<div class="promo-desc">${p.descripcion}</div>` : ''}
        ${detalleHtml}
        ${cantMinHtml}
        ${cantMaxHtml}
        ${itemsNombres.length > 0 ? `
          <div class="promo-products-lbl">
            Productos (${productosNombres.length})${variantesNombres.length ? ` · Variantes (${variantesNombres.length})` : ''}
          </div>
          <div class="promo-products">
            ${itemsNombres.slice(0, 5).map(n => `<span class="promo-product-tag" title="${n}">${n}</span>`).join('')}
            ${itemsNombres.length > 5 ? `<span class="promo-product-tag">+${itemsNombres.length - 5} más</span>` : ''}
          </div>` : `<div class="promo-detail" style="color:var(--tint-orange-fg)">
            <span class="material-icons" style="color:var(--tint-orange-fg)">warning_amber</span>Sin productos asignados</div>`
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
      if (!await confirmDialog({ title: 'Eliminar promoción', message: `¿Eliminar la promoción <b>"${escHtml(promo.nombre)}"</b>?<br><span style="color:var(--text-muted)">Esta acción no se puede deshacer.</span>`, confirmText: 'Eliminar', danger: true })) return;
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
    // selectedItems unifica productos y variantes usando la misma key:
    //   - "productoId"                       → producto entero
    //   - "productoId::var::ColorName"       → variante específica
    const selectedItems = [];
    // modosPorItem: key → { mode: { min: N } } donde mode ∈ {'pack','unidad'}.
    // - Mode presente en el objeto = está ACTIVO para esa key.
    // - Mode ausente = INACTIVO (no aplica).
    // - min = 0 → usa el mínimo global de la promo. min > 0 → override por modo.
    // Si la key no existe en el map, se asume "todos los modos disponibles, min=0".
    const modosPorItem = {};
    if (promo) {
      (promo.productos || []).forEach(id => selectedItems.push(id));
      (Array.isArray(promo.variantes) ? promo.variantes : []).forEach(v => {
        if (v && v.producto_id && v.color) {
          selectedItems.push(`${v.producto_id}${VAR_SEP}${v.color}`);
        }
      });
      const modosGuardados = (promo.modos && typeof promo.modos === 'object') ? promo.modos : {};
      Object.keys(modosGuardados).forEach(k => {
        const raw = modosGuardados[k];
        const obj = {};
        if (Array.isArray(raw)) {
          // Forma legacy: ['pack', 'unidad']
          raw.forEach(m => { obj[m] = { min: 0 }; });
        } else if (raw && typeof raw === 'object') {
          // Forma nueva: { pack: {min:N} | N, unidad: ... }
          Object.keys(raw).forEach(m => {
            const mv = raw[m];
            if (typeof mv === 'number') obj[m] = { min: mv };
            else if (mv && typeof mv === 'object') obj[m] = { min: Number(mv.min) || 0 };
            else obj[m] = { min: 0 };
          });
        }
        if (Object.keys(obj).length) modosPorItem[k] = obj;
      });
    }
    // Para items recién agregados, default = todos los modos disponibles, min=0 (usa global).
    function ensureModos(key) {
      if (!modosPorItem[key]) {
        const obj = {};
        modosForKey(key).forEach(m => { obj[m] = { min: 0 }; });
        modosPorItem[key] = obj;
      }
    }
    selectedItems.forEach(ensureModos);

    const modal = document.createElement('div');
    modal.className = 'promo-modal';
    modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-title"><span class="material-icons">local_offer</span>${isEdit ? 'Editar promoción' : 'Nueva promoción'}</div>

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

      <!-- Cantidad mínima y máxima -->
      <div class="form-row">
        <div class="form-group">
          <label>Cantidad mínima para activar</label>
          <input id="mCantMin" type="number" min="1" step="1" placeholder="1" value="${promo?.cantidad_minima ?? 1}">
          <div class="form-hint">Si compra menos, NO se aplica el descuento.</div>
        </div>
        <div class="form-group">
          <label id="lblCantMax">Tope máximo (opcional)</label>
          <input id="mCantMax" type="number" min="0" step="1" placeholder="Sin tope" value="${promo?.cantidad_maxima ?? ''}">
          <div class="form-hint" id="hintCantMax">0 o vacío = sin tope. Si lo ponés, el descuento se corta al alcanzar esa cantidad.</div>
        </div>
      </div>

      <!-- Productos y variantes -->
      <div class="form-group">
        <label>Buscar y agregar productos o variantes *</label>
        <div class="product-search-box">
          <input id="mProductoSearch" type="text" placeholder="Escribí nombre, color o código...">
          <div class="product-search-results" id="mProductoResults"></div>
        </div>
        <div class="selected-products-list" id="mSelectedProducts"></div>
        <div class="form-hint">En productos que se venden por pack <b>y</b> por unidad, tocá cada botón para elegir
          en qué modo aplica la promo. "Desde" es la cantidad mínima de ese modo; vacío usa la mínima global.
          Ojo: con <b>Unidad</b> activa, la mínima global también se cumple con unidades sueltas.</div>
      </div>

      <div class="modal-footer">
        <button class="btn-cancel" id="mBtnCancel">Cancelar</button>
        <button class="btn-save" id="mBtnSave">${isEdit ? 'Guardar cambios' : 'Crear promoción'}</button>
      </div>
    </div>`;

    document.body.appendChild(modal);

    // Render chips de productos/variantes ya seleccionados.
    // Cada chip muestra los modos de venta disponibles (pack/unidad) con toggles.
    // Cuando un toggle está ACTIVO, además aparece un mini input para fijar la cantidad
    // mínima a partir de la cual se dispara la promo en ESE modo (override del global).
    function renderSelectedChips() {
      const container2 = modal.querySelector('#mSelectedProducts');
      const MODO_LABEL = { pack: 'Pack', unidad: 'Unidad' };
      const PLURAL = { pack: 'packs', unidad: 'unidades' };
      container2.innerHTML = selectedItems.map(key => {
        const esVariante = key.includes(VAR_SEP);
        const nombre = labelForKey(key);
        const disponibles = modosForKey(key);
        const activos = modosPorItem[key] || {};
        const icon = esVariante ? '<span class="material-icons pm-var-ic">palette</span>' : '';
        // Los modos solo aparecen si el item se vende de más de una forma.
        // Cada modo se lee solo: "✓ Pack · desde 10 packs" aplica; "✕ Unidad
        // — no aplica" está apagado. Tocar el botón lo prende/apaga.
        const modosHtml = (disponibles.length > 1) ? `
          <div class="pm-chip-modos">
            <span class="pm-modos-lbl">La promo aplica vendiendo por:</span>
            ${disponibles.map(m => {
              const on = !!activos[m];
              const minVal = on ? (activos[m].min || 0) : 0;
              if (on) {
                return `<span class="pm-modo on" data-modo-toggle="${key}|${m}"
                    title="Aplica vendiendo por ${PLURAL[m]}. Tocá para que NO aplique.">
                    <span class="material-icons">check</span>${MODO_LABEL[m]} · desde
                    <input type="number" min="0" step="1" class="modo-min-input" data-modo-min="${key}|${m}"
                      value="${minVal || ''}" placeholder="global"
                      title="Cantidad mínima de ${PLURAL[m]} para que arranque la promo. Vacío = usa la mínima global de arriba.">
                    ${PLURAL[m]}
                  </span>`;
              }
              return `<span class="pm-modo off" data-modo-toggle="${key}|${m}"
                  title="NO aplica vendiendo por ${PLURAL[m]}. Tocá para activarla.">
                  <span class="material-icons">close</span>${MODO_LABEL[m]} <span class="pm-off-txt">— no aplica</span>
                </span>`;
            }).join('')}
          </div>` : '';
        return `<div class="pm-chip${esVariante ? ' is-var' : ''}">
          <div class="pm-chip-head">
            ${icon}<span class="pm-chip-name" title="${nombre}">${nombre}</span>
            <button data-remove="${key}" class="pm-x" title="Quitar de la promo">×</button>
          </div>
          ${modosHtml}
        </div>`;
      }).join('');

      container2.querySelectorAll('button[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          const rid = btn.dataset.remove;
          const idx = selectedItems.indexOf(rid);
          if (idx > -1) selectedItems.splice(idx, 1);
          delete modosPorItem[rid];
          renderSelectedChips();
        });
      });

      // Toggle de modo (click en el "botón" — span con cursor:pointer)
      container2.querySelectorAll('[data-modo-toggle]').forEach(el => {
        el.addEventListener('click', (e) => {
          // No togglear si el click salió del input numérico interno
          if (e.target.matches('input[data-modo-min]')) return;
          const [key, modo] = el.dataset.modoToggle.split('|');
          const obj = modosPorItem[key] || {};
          if (obj[modo]) {
            // No permitir quedarse sin modos
            if (Object.keys(obj).length > 1) delete obj[modo];
          } else {
            obj[modo] = { min: 0 };
          }
          modosPorItem[key] = obj;
          renderSelectedChips();
        });
      });

      // Cambio del mini input de mínimo por modo
      container2.querySelectorAll('input[data-modo-min]').forEach(input => {
        // El click en el input no debe disparar el toggle del padre
        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('input', e => {
          const [key, modo] = input.dataset.modoMin.split('|');
          const obj = modosPorItem[key] || {};
          if (!obj[modo]) return; // no debería pasar
          obj[modo].min = Math.max(0, parseInt(input.value) || 0);
          modosPorItem[key] = obj;
          // No re-render para no perder el foco mientras tipea.
        });
      });
    }
    renderSelectedChips();

    // Búsqueda unificada (productos + variantes)
    const searchInput = modal.querySelector('#mProductoSearch');
    const resultsDiv  = modal.querySelector('#mProductoResults');

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (q.length < 2) { resultsDiv.classList.remove('visible'); return; }
      const matches = searchIndex.filter(it => {
        if (selectedItems.includes(it.key)) return false;
        const hay = `${it.nombre || ''} ${it.color || ''} ${it.codigo || ''}`.toLowerCase();
        return hay.includes(q);
      }).slice(0, 25);
      if (matches.length === 0) { resultsDiv.classList.remove('visible'); return; }
      resultsDiv.innerHTML = matches.map(it => {
        const tag = it.kind === 'variante'
          ? `<span class="pm-kind var">VAR</span>`
          : `<span class="pm-kind prod">PROD</span>`;
        const sub = it.subtitulo ? ` <small style="color:var(--text-muted)">${it.subtitulo}</small>` : '';
        return `<div class="product-result-item" data-key="${it.key}">${tag}${it.nombre}${sub}</div>`;
      }).join('');
      resultsDiv.classList.add('visible');
      resultsDiv.querySelectorAll('.product-result-item').forEach(item => {
        item.addEventListener('click', () => {
          const k = item.dataset.key;
          selectedItems.push(k);
          ensureModos(k);
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
      const lblCantMax  = modal.querySelector('#lblCantMax');
      const hintCantMax = modal.querySelector('#hintCantMax');
      // El tope se interpreta como "packs" para promos por grupo y "unidades" para descuentos lineales
      const esPorPack = (tipo === '2x1' || tipo === 'nxm' || tipo === 'bundle');
      lblCantMax.textContent  = esPorPack ? 'Tope de packs con descuento' : 'Tope de unidades con descuento';
      hintCantMax.textContent = esPorPack
        ? '0 o vacío = sin tope. Si lo ponés, solo esa cantidad de packs recibe el descuento.'
        : '0 o vacío = sin tope. Si lo ponés, solo esas unidades reciben el descuento.';

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
      const cantMaxRaw= modal.querySelector('#mCantMax').value;
      const cantMax   = (cantMaxRaw === '' || cantMaxRaw == null) ? 0 : (parseInt(cantMaxRaw) || 0);

      if (!nombre) { alertDialog({ title: 'Falta el nombre', message: 'El nombre es obligatorio.', type: 'warning' }); return; }
      if (selectedItems.length === 0) { alertDialog({ title: 'Sin productos', message: 'Debés seleccionar al menos un producto o variante.', type: 'warning' }); return; }
      if ((tipo === 'percentage' || tipo === 'fixed' || tipo === 'bundle') && valor <= 0) {
        alertDialog({ title: 'Valor inválido', message: 'Ingresá un valor mayor a 0.', type: 'warning' }); return;
      }
      if (tipo === 'nxm' && cantReq <= cantPaga) {
        alertDialog({ title: 'Cantidades inválidas', message: 'La cantidad que lleva (N) debe ser mayor que la que paga (M).', type: 'warning' }); return;
      }

      // Divido selectedItems en productos (parent) y variantes específicas
      const productosArr = [];
      const variantesArr = [];
      selectedItems.forEach(k => {
        if (k.includes(VAR_SEP)) {
          const [pid, color] = k.split(VAR_SEP);
          variantesArr.push({ producto_id: pid, color });
        } else {
          productosArr.push(k);
        }
      });
      // Map de modos por key. Sólo guardamos entradas que difieran del default
      // (todos los modos activos con min=0). Así no inflamos el doc si el usuario no toca nada.
      // Forma persistida: { key: { mode: { min: N }, ... } }
      const modosMap = {};
      selectedItems.forEach(k => {
        const disponibles = modosForKey(k);
        const activos = modosPorItem[k] || {};
        const activeKeys = Object.keys(activos);
        const todosActivos = (activeKeys.length === disponibles.length)
          && disponibles.every(m => activeKeys.includes(m));
        const algunOverride = activeKeys.some(m => (activos[m]?.min || 0) > 0);
        if (!todosActivos || algunOverride) {
          const entry = {};
          activeKeys.forEach(m => {
            entry[m] = { min: Math.max(0, activos[m]?.min || 0) };
          });
          modosMap[k] = entry;
        }
      });

      const data = {
        nombre,
        tipo,
        descripcion: desc,
        valor,
        cantidad_requerida: cantReq,
        cantidad_paga:      cantPaga,
        cantidad_minima:    cantMin,
        cantidad_maxima:    cantMax,
        productos:          productosArr,
        variantes:          variantesArr,
        modos:              modosMap,
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
        alertDialog({ title: 'Error', message: 'No se pudo guardar: ' + escHtml(err.message), type: 'error' });
      }
    });
  }
}
