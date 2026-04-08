/**
 * Artículos Únicos / Variantes
 * Detecta productos que son variantes del mismo artículo base
 * (mismo nombre pero diferente código, número o sufijo al final)
 * y los agrupa para edición rápida.
 *
 * Colección Firebase: 'catalogo'
 * Edición individual: igual al lápiz del catálogo
 */
import {
  collection, getDocs, doc, updateDoc, deleteDoc, writeBatch, serverTimestamp,
} from 'firebase/firestore';
import { invalidateCacheByPrefix } from '../cache.js';

function fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Extrae el "nombre base" de un producto quitando:
 *   - Códigos alfanuméricos al final (ej: 34UC2631, 67B1025)
 *   - Números sueltos al final
 *   - Referencias de proveedor al final
 * Retorna el nombre base normalizado en mayúsculas.
 */
function extraerBase(nombre) {
  if (!nombre) return '';
  let base = nombre.trim().toUpperCase();

  // Quitar sufijos típicos de variante:
  // Ejemplo: "BANDOLERA LA CHAPELLE 34UC2631" → "BANDOLERA LA CHAPELLE"
  // Patrones: códigos alfanuméricos, números puros, referencias con letras y números mezclados
  base = base
    // Quitar código al final: secuencia de letras+números o solo números (mín 3 chars)
    .replace(/\s+[A-Z]{0,4}\d{2,}[A-Z0-9]*\s*$/i, '')
    // Quitar números puros al final
    .replace(/\s+\d{2,}\s*$/, '')
    // Quitar códigos tipo "67.B916" al final
    .replace(/\s+[\d]+\.[A-Z]\d+\s*$/i, '')
    // Quitar referencias tipo "REF-123" al final
    .replace(/\s+REF[:\-\s]\S+\s*$/i, '')
    .trim();

  return base || nombre.trim().toUpperCase();
}

/**
 * Dado un grupo de productos con el mismo base, decide si son "variantes reales":
 * - Mínimo 2 productos
 * - El nombre base debe tener al menos 10 chars (evitar falsos positivos)
 * - Los nombres individuales deben diferir del base (confirmar que hay sufijo distinto)
 */
function esGrupoVariantes(base, items) {
  if (items.length < 2) return false;
  if (base.length < 8) return false;
  // Al menos un item debe tener nombre más largo que el base
  return items.some(p => (p.nombre || '').trim().toUpperCase() !== base);
}

export async function renderArticulosUnicos(container, db) {
  container.innerHTML = `
    <div style="text-align:center;padding:60px;color:var(--text-muted)">
      <div class="spinner"></div>
      <p>Detectando artículos con variantes...</p>
    </div>`;

  // ── Cargar colección completa ─────────────────────────────────────────
  const snap = await getDocs(collection(db, 'catalogo'));
  const todos = snap.docs.map(d => ({ _id: d.id, ...d.data() }));

  // ── Agrupar por nombre base ───────────────────────────────────────────
  const grupos = {};
  for (const p of todos) {
    const base = extraerBase(p.nombre || '');
    if (!grupos[base]) grupos[base] = [];
    grupos[base].push(p);
  }

  // ── Filtrar solo grupos con variantes reales ──────────────────────────
  const variantes = Object.entries(grupos)
    .filter(([base, items]) => esGrupoVariantes(base, items))
    .sort((a, b) => b[1].length - a[1].length); // Más variantes primero

  const totalProductos = variantes.reduce((s, [, items]) => s + items.length, 0);

  // ── Render principal ──────────────────────────────────────────────────
  container.innerHTML = `
    <style>
      .variantes-header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:20px; }
      .variantes-stats  { display:flex; gap:16px; flex-wrap:wrap; }
      .var-stat { background:white; border:1px solid var(--border); border-radius:10px; padding:12px 20px; text-align:center; }
      .var-stat .n { font-size:22px; font-weight:700; color:var(--primary); }
      .var-stat .l { font-size:11px; color:var(--text-muted); margin-top:2px; }

      .grupo-card { background:white; border:1px solid var(--border); border-radius:12px; margin-bottom:16px; overflow:hidden; }
      .grupo-header {
        display:flex; align-items:center; justify-content:space-between;
        padding:12px 18px; background:#f8fafc; border-bottom:1px solid var(--border);
        cursor:pointer; user-select:none;
      }
      .grupo-header:hover { background:#f1f5f9; }
      .grupo-nombre { font-weight:700; font-size:14px; color:#1e293b; }
      .grupo-badge  { background:#e0e7ff; color:#4338ca; font-size:11px; font-weight:700;
                      padding:2px 10px; border-radius:12px; }
      .grupo-body   { display:none; }
      .grupo-body.open { display:block; }

      .variante-row {
        display:grid;
        grid-template-columns: 2fr 80px 100px 100px 80px 120px;
        gap:8px; align-items:center;
        padding:10px 18px; border-bottom:1px solid #f1f5f9;
        font-size:13px;
      }
      .variante-row:last-child { border-bottom:none; }
      .variante-row:hover { background:#f8fafc; }
      .var-nombre { font-weight:600; color:#334155; word-break:break-word; }
      .var-precio { color:#198754; font-weight:700; }
      .var-stock  { text-align:center; }
      .var-rubro  { color:var(--text-muted); font-size:12px; }

      .btn-edit-var {
        background:#e8f0fe; border:none; border-radius:6px;
        padding:5px 12px; cursor:pointer; font-size:12px;
        color:#1877f2; font-weight:600;
        display:flex; align-items:center; gap:4px;
      }
      .btn-edit-var:hover { background:#d2e3fc; }

      .btn-edit-all {
        background:var(--primary); color:white; border:none;
        border-radius:8px; padding:6px 14px; cursor:pointer;
        font-size:12px; font-weight:700;
      }
      .btn-edit-all:hover { opacity:0.88; }

      .variante-row-header {
        display:grid;
        grid-template-columns: 2fr 80px 100px 100px 80px 120px;
        gap:8px; padding:8px 18px;
        font-size:11px; font-weight:700; color:var(--text-muted);
        text-transform:uppercase; background:#f8fafc;
        border-bottom:1px solid #e2e8f0;
      }

      .search-variantes {
        padding:8px 14px; border:1.5px solid var(--border); border-radius:8px;
        font-size:13px; width:280px;
      }
      .search-variantes:focus { border-color:var(--primary); outline:none; }

      /* Editor inline */
      .editor-inline {
        background:#f0fdf4; border:1.5px solid #86efac;
        border-radius:10px; padding:16px 18px; margin:8px 18px 12px;
      }
      .editor-inline h4 { font-size:13px; font-weight:700; color:#166534; margin-bottom:10px; }
      .editor-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:10px; }
      .editor-field label { font-size:11px; color:#475569; font-weight:600; display:block; margin-bottom:3px; }
      .editor-field input, .editor-field select {
        width:100%; padding:7px 10px; border:1.5px solid #ced4da;
        border-radius:6px; font-size:13px; box-sizing:border-box;
      }
      .editor-field input:focus { border-color:var(--primary); outline:none; }
      .editor-btns { display:flex; gap:8px; margin-top:12px; }
      .btn-save-var { background:#198754; color:white; border:none; border-radius:6px;
                      padding:8px 20px; cursor:pointer; font-weight:700; font-size:13px; }
      .btn-save-var:hover { background:#157347; }
      .btn-cancel-var { background:#f8f9fa; border:1px solid #dee2e6; border-radius:6px;
                        padding:8px 16px; cursor:pointer; font-size:13px; color:#495057; }
      .btn-cancel-var:hover { background:#e9ecef; }
      .btn-del-var { background:#fee2e2; color:#dc3545; border:1px solid #fecaca;
                     border-radius:6px; padding:8px 14px; cursor:pointer; font-size:12px; font-weight:600; }
      .btn-del-var:hover { background:#fecaca; }
    </style>

    <div class="variantes-header">
      <div>
        <h2 style="margin:0;font-size:20px;font-weight:700">🔗 Artículos con Variantes</h2>
        <p style="color:var(--text-muted);font-size:13px;margin:4px 0 0">
          Productos que comparten el mismo nombre base con variantes de código o referencia
        </p>
      </div>
      <div class="variantes-stats">
        <div class="var-stat"><div class="n">${variantes.length}</div><div class="l">Grupos</div></div>
        <div class="var-stat"><div class="n">${totalProductos}</div><div class="l">Productos</div></div>
      </div>
    </div>

    <!-- Búsqueda -->
    <div style="margin-bottom:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <input type="text" id="searchVariantes" class="search-variantes" placeholder="🔍 Buscar grupo o artículo..." />
      <span id="countVariantes" style="color:var(--text-muted);font-size:13px">${variantes.length} grupos</span>
    </div>

    <!-- Lista de grupos -->
    <div id="variantesLista"></div>
  `;

  // ── Render grupos ──────────────────────────────────────────────────────
  function renderGrupos(filtro = '') {
    const lista = document.getElementById('variantesLista');
    const filtroUp = filtro.trim().toUpperCase();

    const filtrados = filtro
      ? variantes.filter(([base, items]) =>
          base.includes(filtroUp) ||
          items.some(p => (p.nombre || '').toUpperCase().includes(filtroUp))
        )
      : variantes;

    document.getElementById('countVariantes').textContent =
      `${filtrados.length} grupos · ${filtrados.reduce((s,[,i])=>s+i.length,0)} productos`;

    if (!filtrados.length) {
      lista.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-muted)">
        Sin resultados para "${filtro}"
      </div>`;
      return;
    }

    lista.innerHTML = filtrados.map(([base, items], gi) => {
      const precios = items.map(p => p.precio || p.precio_venta || 0).filter(Boolean);
      const precioMin = Math.min(...precios);
      const precioMax = Math.max(...precios);
      const rango = precios.length > 1 && precioMin !== precioMax
        ? `$${fmt(precioMin)} – $${fmt(precioMax)}`
        : precios.length ? `$${fmt(precioMin)}` : '—';
      const rubroEj = items[0]?.rubro || items[0]?.categoria || items[0]?.category || '';

      return `
        <div class="grupo-card" id="grupo-${gi}">
          <div class="grupo-header" onclick="toggleGrupo(${gi})">
            <div>
              <div class="grupo-nombre">📦 ${base}</div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:3px">
                ${rubroEj ? `<span style="margin-right:8px">📂 ${rubroEj}</span>` : ''}
                <span>${rango}</span>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px">
              <span class="grupo-badge">${items.length} variantes</span>
              <button class="btn-edit-all" onclick="event.stopPropagation();editarTodoElGrupo(${gi})">
                ✏️ Editar precio grupo
              </button>
              <span id="chevron-${gi}" style="color:var(--text-muted);font-size:18px;transition:transform 0.2s">▼</span>
            </div>
          </div>
          <div class="grupo-body" id="body-${gi}">
            <div class="variante-row-header">
              <div>Nombre completo</div>
              <div>Stock</div>
              <div>Precio Venta</div>
              <div>Precio Costo</div>
              <div>Rubro</div>
              <div>Acciones</div>
            </div>
            ${items.map((p, ii) => `
              <div class="variante-row" id="vrow-${gi}-${ii}">
                <div class="var-nombre" title="${p.nombre || ''}">${p.nombre || '—'}</div>
                <div class="var-stock" style="text-align:center">
                  <span class="badge ${(p.stock||0) > 0 ? 'badge-green' : 'badge-gray'}">${p.stock ?? '—'}</span>
                </div>
                <div class="var-precio">$${fmt(p.precio || p.precio_venta)}</div>
                <div style="color:#64748b">$${fmt(p.costo || p.cost_price)}</div>
                <div class="var-rubro">${p.rubro || p.categoria || '—'}</div>
                <div>
                  <button class="btn-edit-var" onclick="editarVariante(${gi},${ii})">
                    ✏️ Editar
                  </button>
                </div>
              </div>
              <div id="editor-${gi}-${ii}" style="display:none"></div>
            `).join('')}
          </div>
        </div>`;
    }).join('');
  }

  // ── Funciones globales ─────────────────────────────────────────────────
  window.toggleGrupo = function(gi) {
    const body    = document.getElementById(`body-${gi}`);
    const chevron = document.getElementById(`chevron-${gi}`);
    const open    = body.classList.toggle('open');
    chevron.textContent = open ? '▲' : '▼';
  };

  window.editarVariante = function(gi, ii) {
    const [, items] = variantes[gi];
    const p = items[ii];
    const edId = `editor-${gi}-${ii}`;

    // Cerrar otros editores abiertos
    document.querySelectorAll('[id^="editor-"]').forEach(el => {
      if (el.id !== edId) el.style.display = 'none';
    });

    const ed = document.getElementById(edId);
    if (ed.style.display === 'block') { ed.style.display = 'none'; return; }

    ed.style.display = 'block';
    ed.innerHTML = `
      <div class="editor-inline">
        <h4>✏️ Editando: ${p.nombre || '—'}</h4>
        <div class="editor-grid">
          <div class="editor-field">
            <label>Nombre</label>
            <input id="ev-nombre-${gi}-${ii}" value="${p.nombre || ''}" />
          </div>
          <div class="editor-field">
            <label>Precio Venta</label>
            <input id="ev-precio-${gi}-${ii}" type="number" step="0.01" value="${p.precio || p.precio_venta || ''}" />
          </div>
          <div class="editor-field">
            <label>Precio Costo</label>
            <input id="ev-costo-${gi}-${ii}" type="number" step="0.01" value="${p.costo || p.cost_price || ''}" />
          </div>
          <div class="editor-field">
            <label>Stock</label>
            <input id="ev-stock-${gi}-${ii}" type="number" value="${p.stock ?? ''}" />
          </div>
          <div class="editor-field">
            <label>Rubro</label>
            <input id="ev-rubro-${gi}-${ii}" value="${p.rubro || p.categoria || ''}" />
          </div>
          <div class="editor-field">
            <label>Código/Barcode</label>
            <input id="ev-codigo-${gi}-${ii}" value="${p.codigo || p.barcode || ''}" />
          </div>
        </div>
        <div class="editor-btns">
          <button class="btn-save-var" onclick="guardarVariante(${gi},${ii})">💾 Guardar</button>
          <button class="btn-cancel-var" onclick="document.getElementById('${edId}').style.display='none'">Cancelar</button>
          <button class="btn-del-var" onclick="eliminarVariante(${gi},${ii})">🗑️ Eliminar</button>
        </div>
      </div>`;
  };

  window.guardarVariante = async function(gi, ii) {
    const [, items] = variantes[gi];
    const p = items[ii];
    const get = (id) => document.getElementById(id)?.value;

    const datos = {
      nombre:      get(`ev-nombre-${gi}-${ii}`),
      precio:      parseFloat(get(`ev-precio-${gi}-${ii}`)) || 0,
      precio_venta:parseFloat(get(`ev-precio-${gi}-${ii}`)) || 0,
      costo:       parseFloat(get(`ev-costo-${gi}-${ii}`)) || 0,
      cost_price:  parseFloat(get(`ev-costo-${gi}-${ii}`)) || 0,
      stock:       parseInt(get(`ev-stock-${gi}-${ii}`)) || 0,
      rubro:       get(`ev-rubro-${gi}-${ii}`),
      categoria:   get(`ev-rubro-${gi}-${ii}`),
      codigo:      get(`ev-codigo-${gi}-${ii}`),
      ultima_actualizacion: serverTimestamp(),
    };

    try {
      const ref = doc(db, 'catalogo', p._id);
      await updateDoc(ref, datos);
      // Actualizar datos locales
      Object.assign(p, datos);
      document.getElementById(`editor-${gi}-${ii}`).style.display = 'none';
      // Refrescar la fila
      const row = document.getElementById(`vrow-${gi}-${ii}`);
      if (row) {
        row.querySelector('.var-nombre').textContent = datos.nombre;
        row.querySelector('.var-precio').textContent = `$${fmt(datos.precio)}`;
        row.querySelector('.var-stock .badge').textContent = datos.stock;
      }
      mostrarToast('✅ Guardado correctamente');
    } catch (e) {
      mostrarToast('❌ Error al guardar: ' + e.message, 'error');
    }
  };

  window.eliminarVariante = async function(gi, ii) {
    const [, items] = variantes[gi];
    const p = items[ii];
    if (!confirm(`¿Eliminar "${p.nombre}"?\nEsta acción no se puede deshacer.`)) return;
    try {
      await deleteDoc(doc(db, 'catalogo', p._id));
      invalidateCacheByPrefix('catalogo');
      items.splice(ii, 1);
      renderGrupos(document.getElementById('searchVariantes').value);
      mostrarToast('🗑️ Producto eliminado');
    } catch (e) {
      mostrarToast('❌ Error al eliminar: ' + e.message, 'error');
    }
  };

  window.editarTodoElGrupo = function(gi) {
    const [base, items] = variantes[gi];
    // Abrir el primer grupo y mostrar un editor de precio masivo
    window.toggleGrupo(gi);
    const body = document.getElementById(`body-${gi}`);
    const existing = body.querySelector('.editor-grupo');
    if (existing) { existing.remove(); return; }

    const precioEj = items[0]?.precio || items[0]?.precio_venta || 0;
    const edDiv = document.createElement('div');
    edDiv.className = 'editor-inline editor-grupo';
    edDiv.style.margin = '0 18px 12px';
    edDiv.innerHTML = `
      <h4>✏️ Editar TODOS los precios del grupo: ${base}</h4>
      <p style="font-size:12px;color:#64748b;margin-bottom:10px">
        Esto actualizará el precio de venta y costo de las ${items.length} variantes a la vez.
      </p>
      <div class="editor-grid">
        <div class="editor-field">
          <label>Nuevo Precio de Venta (todas)</label>
          <input id="eg-precio-${gi}" type="number" step="0.01" placeholder="${fmt(precioEj)}" />
        </div>
        <div class="editor-field">
          <label>Nuevo Precio de Costo (todas)</label>
          <input id="eg-costo-${gi}" type="number" step="0.01" placeholder="" />
        </div>
        <div class="editor-field">
          <label>Nuevo Rubro (todas)</label>
          <input id="eg-rubro-${gi}" value="${items[0]?.rubro || ''}" />
        </div>
      </div>
      <div class="editor-btns">
        <button class="btn-save-var" onclick="guardarGrupo(${gi})">💾 Guardar grupo (${items.length} variantes)</button>
        <button class="btn-cancel-var" onclick="this.closest('.editor-grupo').remove()">Cancelar</button>
      </div>`;
    body.prepend(edDiv);
  };

  window.guardarGrupo = async function(gi) {
    const [, items] = variantes[gi];
    const precio = parseFloat(document.getElementById(`eg-precio-${gi}`)?.value) || null;
    const costo  = parseFloat(document.getElementById(`eg-costo-${gi}`)?.value) || null;
    const rubro  = document.getElementById(`eg-rubro-${gi}`)?.value.trim() || null;

    if (!precio && !costo && !rubro) {
      alert('Completá al menos un campo para actualizar.');
      return;
    }

    const batch = writeBatch(db);
    for (const p of items) {
      const datos = { ultima_actualizacion: serverTimestamp() };
      if (precio) { datos.precio = precio; datos.precio_venta = precio; }
      if (costo)  { datos.costo = costo;   datos.cost_price = costo; }
      if (rubro)  { datos.rubro = rubro;    datos.categoria = rubro; }
      batch.update(doc(db, 'catalogo', p._id), datos);
    }

    try {
      await batch.commit();
      // Actualizar local
      for (const p of items) {
        if (precio) { p.precio = precio; p.precio_venta = precio; }
        if (costo)  { p.costo = costo;   p.cost_price = costo; }
        if (rubro)  { p.rubro = rubro;    p.categoria = rubro; }
      }
      renderGrupos(document.getElementById('searchVariantes').value);
      mostrarToast(`✅ ${items.length} variantes actualizadas`);
    } catch (e) {
      mostrarToast('❌ Error: ' + e.message, 'error');
    }
  };

  // ── Toast de feedback ──────────────────────────────────────────────────
  function mostrarToast(msg, tipo = 'ok') {
    const existing = document.querySelector('.variante-toast');
    existing?.remove();
    const t = document.createElement('div');
    t.className = 'variante-toast';
    t.textContent = msg;
    t.style.cssText = `
      position:fixed; bottom:24px; right:24px; z-index:9999;
      background:${tipo === 'error' ? '#fee2e2' : '#dcfce7'};
      color:${tipo === 'error' ? '#dc3545' : '#166534'};
      border:1px solid ${tipo === 'error' ? '#fecaca' : '#86efac'};
      border-radius:10px; padding:12px 20px; font-size:14px; font-weight:600;
      box-shadow:0 4px 12px rgba(0,0,0,0.15);
      animation:fadeIn 0.2s ease;
    `;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ── Búsqueda en tiempo real ────────────────────────────────────────────
  document.getElementById('searchVariantes').addEventListener('input', e => {
    renderGrupos(e.target.value);
  });

  // ── Render inicial ────────────────────────────────────────────────────
  renderGrupos();
}
