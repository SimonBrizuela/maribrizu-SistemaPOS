import { collection, getDocs, query, orderBy, where, doc, updateDoc, getDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { getCached, peekCache, invalidateCacheByPrefix } from '../cache.js';

// Mapa de subcategorías por rubro cargado desde Firebase sub_categories
// Se llena en initSubCats()
const SUBCATS_POR_RUBRO = {};

async function initSubCats(db) {
  try {
    // Leer colección 'sub_categories' desde Firebase
    const snap = await getDocs(collection(db, 'sub_categories'));
    snap.forEach(d => {
      const data = d.data();
      const rubro = (data.rubro || '').toUpperCase().trim();
      const name  = (data.name || '').trim();
      if (rubro && name) {
        if (!SUBCATS_POR_RUBRO[rubro]) SUBCATS_POR_RUBRO[rubro] = [];
        if (!SUBCATS_POR_RUBRO[rubro].includes(name))
          SUBCATS_POR_RUBRO[rubro].push(name);
      }
    });
    // Ordenar cada lista alfabéticamente
    Object.keys(SUBCATS_POR_RUBRO).forEach(r => SUBCATS_POR_RUBRO[r].sort());
  } catch(e) {
    console.warn('sub_categories no disponible:', e);
  }
}

/**
 * Retorna las categorías del rubro activo.
 * Prioridad: 1) sub_categories de Firebase, 2) categorías reales en los productos.
 */
function getCatsDelRubro(rubro, base) {
  if (rubro === 'TODOS') {
    // Mostrar todas las categorías de los productos actuales
    return [...new Set(base.map(p => p.categoria || '').filter(Boolean))].sort();
  }
  const rubroNorm = rubro.toUpperCase().trim();
  // Si tenemos subcategorías pre-cargadas para este rubro, usarlas
  if (SUBCATS_POR_RUBRO[rubroNorm] && SUBCATS_POR_RUBRO[rubroNorm].length > 0) {
    return SUBCATS_POR_RUBRO[rubroNorm];
  }
  // Fallback: extraer de los productos del rubro
  return [...new Set(base.map(p => p.categoria || '').filter(Boolean))].sort();
}

function fmt(n) { return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Rubros se cargan dinámicamente desde Firebase config/rubros
let RUBROS = ['ACCESORIOS','JUGUETERÍA','LENCERÍA','LIBRERÍA','MERCERÍA',
  'NAVIDAD','PAPELERA','PERFUMERÍA','REGALERÍA','SELLOS','SERVICIOS','TELGOPOR'];

// RUBRO_CATS ya no se usa — el campo 'rubro' viene directo de Firebase/catalogo
const RUBRO_CATS = {};

export async function renderInventario(container, db) {

  const hayCache = peekCache('inv:productos', 120000) && peekCache('inv:ventas_por_dia', 120000);
  if (!hayCache) {
    container.innerHTML = `<div class="loader"><div class="spinner"></div><span>Analizando inventario...</span></div>`;
  }

  // ── Cargar rubros y subcategorías en paralelo ─────────────────────────────
  await Promise.all([
    // Rubros dinámicos desde Firebase
    getDoc(doc(db, 'config', 'rubros')).then(snap => {
      if (snap.exists() && snap.data().lista?.length) RUBROS = snap.data().lista;
    }).catch(() => {}),
    // Subcategorías por rubro
    initSubCats(db),
  ]);

  // ── Cargar catálogo y ventas en paralelo (cacheado 2 min) ─────────────────
  const [productos, ventasRaw] = await Promise.all([
    getCached('inv:productos', async () => {
      const snap = await getDocs(query(collection(db, 'catalogo'), orderBy('nombre')));
      return snap.docs.map(d => ({ id: d.id, doc_id: d.id, ...d.data() }));
    }, { ttl: 120000, memOnly: true }),
    getCached('inv:ventas_por_dia', async () => {
      try {
        // Solo últimos 90 días: la velocidad de venta se calcula sobre 30 y 7 días.
        // 90d cubre con margen y reduce ~80% las lecturas en historicos largos.
        const hace90d = new Date();
        hace90d.setDate(hace90d.getDate() - 90);
        const snap = await getDocs(query(
          collection(db, 'ventas_por_dia'),
          where('fecha_dt', '>=', Timestamp.fromDate(hace90d)),
          orderBy('fecha_dt', 'desc')
        ));
        return snap.docs.map(d => d.data());
      } catch (e) {
        // Fallback: si fecha_dt no existe en docs viejos, intenta sin filtro
        console.warn('inv:ventas_por_dia con fecha_dt falló, fallback a fecha:', e?.message);
        try {
          const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha', 'desc')));
          return snap.docs.map(d => d.data());
        } catch { return []; }
      }
    }, { ttl: 120000, memOnly: true }),
  ]);

  // ── Calcular velocidad de venta ───────────────────────────────────────────
  const hace30 = new Date(); hace30.setDate(hace30.getDate() - 30);
  const hace7  = new Date(); hace7.setDate(hace7.getDate() - 7);

  const ventasProd = {};
  ventasRaw.forEach(v => {
    const nombre = (v.producto || '').toUpperCase().trim();
    if (!nombre) return;
    if (!ventasProd[nombre]) ventasProd[nombre] = { u30: 0, u7: 0 };
    const parts = (v.fecha || '').split('/');
    let fechaV = null;
    if (parts.length === 3) fechaV = new Date(`${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`);
    if (fechaV && fechaV >= hace30) {
      ventasProd[nombre].u30 += (v.cantidad || 1);
      if (fechaV >= hace7) ventasProd[nombre].u7 += (v.cantidad || 1);
    }
  });

  // ── Stock efectivo: para productos conjunto el "stock" real vive en
  // conjunto_total (suma de unidades cerradas × contenido + restante). El
  // campo `stock` queda en 0 para esos productos y haría que se vean como
  // "Agotado" si no lo derivamos.
  function _stockEfectivo(p) {
    if (p && (p.es_conjunto === true || p.es_conjunto === 1)) {
      return Math.round(Number(p.conjunto_total || 0));
    }
    return Number(p.stock) || 0;
  }

  // ── Estado inteligente ────────────────────────────────────────────────────
  function calcularEstado(p) {
    const stock = _stockEfectivo(p);
    const nombre = (p.nombre || '').toUpperCase().trim();
    const vData = ventasProd[nombre];
    const u30 = vData?.u30 || 0;
    const velocidadDiaria = u30 / 30;

    if (stock === 0) return { label: 'Agotado', key: 'agotado', cls: 'badge-red', color: '#c62828', dias: 0, velocidad: velocidadDiaria, pct: 0 };

    if (velocidadDiaria > 0) {
      const diasRestantes = Math.floor(stock / velocidadDiaria);
      const pct = Math.min(100, Math.round((diasRestantes / 30) * 100));
      if (diasRestantes <= 3)  return { label: `Crítico (${diasRestantes}d)`,  key: 'critico',  cls: 'badge-red',    color: '#c62828', dias: diasRestantes, velocidad: velocidadDiaria, pct };
      if (diasRestantes <= 10) return { label: `Bajo (${diasRestantes}d)`,     key: 'bajo',     cls: 'badge-orange', color: '#f57c00', dias: diasRestantes, velocidad: velocidadDiaria, pct };
      if (diasRestantes <= 20) return { label: `Regular (${diasRestantes}d)`,  key: 'regular',  cls: 'badge-orange', color: '#e65100', dias: diasRestantes, velocidad: velocidadDiaria, pct };
      return                         { label: `OK (${diasRestantes}d)`,        key: 'ok',       cls: 'badge-green',  color: '#2e7d32', dias: diasRestantes, velocidad: velocidadDiaria, pct };
    } else {
      if (stock <= 2)  return { label: 'Crítico', key: 'critico', cls: 'badge-red',    color: '#c62828', dias: null, velocidad: 0, pct: 10 };
      if (stock <= 5)  return { label: 'Bajo',    key: 'bajo',    cls: 'badge-orange', color: '#f57c00', dias: null, velocidad: 0, pct: 40 };
      if (stock <= 15) return { label: 'Regular', key: 'regular', cls: 'badge-orange', color: '#e65100', dias: null, velocidad: 0, pct: 65 };
      return                 { label: 'OK',       key: 'ok',      cls: 'badge-green',  color: '#2e7d32', dias: null, velocidad: 0, pct: 100 };
    }
  }

  const prods = productos.map(p => ({ ...p, estado: calcularEstado(p) }));

  // ── Estado activo de rubro ─────────────────────────────────────────────────
  let rubroActivo = 'TODOS';

  function normalize(s) {
    return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
  }

  function getBase() {
    if (rubroActivo === 'TODOS') return prods;
    const rubroNorm = normalize(rubroActivo);
    return prods.filter(p => normalize(p.rubro || '') === rubroNorm);
  }

  // ── Render shell ──────────────────────────────────────────────────────────
  function renderShell() {
    const base = getBase();
    const total    = base.length;
    const agotados = base.filter(p => p.estado.key === 'agotado').length;
    const criticos = base.filter(p => p.estado.key === 'critico').length;
    const bajos    = base.filter(p => p.estado.key === 'bajo' || p.estado.key === 'regular').length;
    const ok       = base.filter(p => p.estado.key === 'ok').length;
    const conVentas = base.filter(p => p.estado.velocidad > 0).length;

    const alertas = base
      .filter(p => p.estado.key === 'critico' || p.estado.key === 'agotado')
      .sort((a,b) => (a.estado.dias ?? 0) - (b.estado.dias ?? 0))
      .slice(0, 5);

    const cats = getCatsDelRubro(rubroActivo, base);

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px">

        <!-- SELECTOR DE RUBRO -->
        <div class="rubro-bar-wrap" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 14px;background:#fff;border-radius:12px;border:1px solid #e4e6eb;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
          <span style="font-size:12px;font-weight:700;color:#65676b;white-space:nowrap;margin-right:4px">SECCIÓN:</span>
          <button class="inv-rubro-btn ${rubroActivo==='TODOS'?'active':''}" data-rubro="TODOS" style="padding:5px 14px;border-radius:20px;border:2px solid ${rubroActivo==='TODOS'?'#1877f2':'#e4e6eb'};background:${rubroActivo==='TODOS'?'#1877f2':'#fff'};color:${rubroActivo==='TODOS'?'#fff':'#1c1e21'};cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap;flex-shrink:0">Todos</button>
          ${RUBROS.map(r => `<button class="inv-rubro-btn ${rubroActivo===r?'active':''}" data-rubro="${r}" style="padding:5px 14px;border-radius:20px;border:2px solid ${rubroActivo===r?'#1877f2':'#e4e6eb'};background:${rubroActivo===r?'#1877f2':'#fff'};color:${rubroActivo===r?'#fff':'#1c1e21'};cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;flex-shrink:0">${r.charAt(0)+r.slice(1).toLowerCase()}</button>`).join('')}
        </div>

        <!-- STATS -->
        <div class="cards-grid" id="invStats"></div>

        <!-- ALERTAS URGENTES -->
        <div id="invAlertas"></div>

        <!-- FILTROS -->
        <div class="filter-bar" style="flex-wrap:wrap;gap:8px">
          <input type="text" id="filtroNombre" placeholder="Buscar producto..." style="min-width:200px;flex:1" />
          <select id="filtroCategoria">
            <option value="">Todas las categorías</option>
            ${cats.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
          <select id="filtroEstado">
            <option value="">Todos los estados</option>
            <option value="ok">OK</option>
            <option value="regular">Regular</option>
            <option value="bajo">Bajo</option>
            <option value="critico">Crítico</option>
            <option value="agotado">Agotado</option>
          </select>
          <select id="filtroMovimiento">
            <option value="">Todo</option>
            <option value="con">Con movimiento</option>
            <option value="sin">Sin movimiento</option>
          </select>
        </div>

        <!-- TABLA -->
        <div class="table-card">
          <div class="table-card-header">
            <h3>Inventario Inteligente</h3>
            <span id="invCount" style="color:var(--text-muted);font-size:13px"></span>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th>Producto</th>
                <th class="inv-col-categoria">Categoría</th>
                <th class="inv-col-rubro">Rubro</th>
                <th style="text-align:center">Stock</th>
                <th class="inv-col-dias" style="text-align:center">Días</th>
                <th class="inv-col-cobertura">Cobertura</th>
                <th class="inv-col-velocidad" style="text-align:center">Vel./día</th>
                <th>Estado</th>
                <th style="text-align:right">Precio</th>
                <th>Acciones</th>
              </tr></thead>
              <tbody id="invBody"></tbody>
            </table>
          </div>
        </div>

      </div>
    `;

    renderStats(base);
    renderAlertas(alertas);
    applyFilters();

    // Listeners de rubros
    document.querySelectorAll('.inv-rubro-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        rubroActivo = btn.dataset.rubro;
        document.querySelectorAll('.inv-rubro-btn').forEach(b => {
          b.style.background = '#fff'; b.style.color = '#1c1e21'; b.style.borderColor = '#e4e6eb';
          b.classList.remove('active');
        });
        btn.style.background = '#1877f2'; btn.style.color = '#fff'; btn.style.borderColor = '#1877f2';
        btn.classList.add('active');
        // Actualizar filtro de categorías — SOLO las del rubro activo
        const base2 = getBase();
        const cats2 = getCatsDelRubro(rubroActivo, base2);
        const sel = document.getElementById('filtroCategoria');
        if (sel) {
          sel.innerHTML = `<option value="">Todas las categorías</option>${cats2.map(c=>`<option value="${c}">${c}</option>`).join('')}`;
          sel.value = ''; // reset selección
        }
        renderStats(base2);
        renderAlertas(base2.filter(p => p.estado.key==='critico'||p.estado.key==='agotado').slice(0,5));
        applyFilters();
      });
    });

    // Listeners de filtros
    ['filtroNombre','filtroCategoria','filtroEstado','filtroMovimiento'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', applyFilters);
    });
  }

  function renderStats(base) {
    const grid = document.getElementById('invStats');
    if (!grid) return;
    const total     = base.length;
    const ok        = base.filter(p => p.estado.key === 'ok').length;
    const bajos     = base.filter(p => p.estado.key === 'bajo' || p.estado.key === 'regular').length;
    const criticos  = base.filter(p => p.estado.key === 'critico').length;
    const agotados  = base.filter(p => p.estado.key === 'agotado').length;
    const conVentas = base.filter(p => p.estado.velocidad > 0).length;

    const cs = 'cursor:pointer;transition:transform 0.15s,box-shadow 0.15s';
    grid.innerHTML = `
      <div class="card stat-card inv-stat" data-filtro="" style="${cs}" title="Ver todos"><div class="icon-wrap bg-blue"><span class="material-icons">inventory_2</span></div><div class="label">Total</div><div class="value">${total}</div></div>
      <div class="card stat-card inv-stat" data-filtro="ok" style="${cs}" title="Ver stock OK"><div class="icon-wrap bg-green"><span class="material-icons">check_circle</span></div><div class="label">Stock OK</div><div class="value">${ok}</div></div>
      <div class="card stat-card inv-stat" data-filtro="bajo" style="${cs}" title="Ver stock bajo"><div class="icon-wrap bg-orange"><span class="material-icons">warning</span></div><div class="label">Stock Bajo</div><div class="value">${bajos}</div></div>
      <div class="card stat-card inv-stat" data-filtro="critico" style="${cs}" title="Ver críticos"><div class="icon-wrap bg-red"><span class="material-icons">error</span></div><div class="label">Críticos</div><div class="value">${criticos}</div></div>
      <div class="card stat-card inv-stat" data-filtro="agotado" style="${cs}" title="Ver agotados"><div class="icon-wrap" style="background:#424242"><span class="material-icons">remove_shopping_cart</span></div><div class="label">Agotados</div><div class="value">${agotados}</div></div>
      <div class="card stat-card inv-stat" data-filtro="con" style="${cs}" title="Ver en movimiento"><div class="icon-wrap" style="background:#7b1fa2"><span class="material-icons">trending_up</span></div><div class="label">En movimiento</div><div class="value">${conVentas}</div></div>
    `;

    grid.querySelectorAll('.inv-stat').forEach(card => {
      card.addEventListener('mouseenter', () => { card.style.transform='translateY(-3px)'; card.style.boxShadow='0 6px 20px rgba(0,0,0,0.1)'; });
      card.addEventListener('mouseleave', () => { card.style.transform=''; card.style.boxShadow=''; });
      card.addEventListener('click', () => {
        const filtro = card.dataset.filtro;
        const selEstado = document.getElementById('filtroEstado');
        const selMov    = document.getElementById('filtroMovimiento');
        if (filtro === 'con') {
          if (selEstado) selEstado.value = '';
          if (selMov) selMov.value = 'con';
        } else {
          if (selEstado) selEstado.value = filtro;
          if (selMov) selMov.value = '';
        }
        applyFilters();
        // Scroll a la tabla
        document.querySelector('.table-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function renderAlertas(alertas) {
    const el = document.getElementById('invAlertas');
    if (!el) return;
    if (!alertas.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div style="background:#fff3f3;border:1px solid #ef9a9a;border-radius:12px;padding:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span class="material-icons" style="color:#c62828;font-size:18px">notification_important</span>
          <b style="font-size:13px;color:#c62828">Requieren atención inmediata</b>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${alertas.map(p => `
            <div style="display:flex;align-items:center;justify-content:space-between;background:#fff;border-radius:8px;padding:8px 12px;border:1px solid #ef9a9a">
              <div>
                <div style="font-weight:700;font-size:13px">${p.nombre}</div>
                <div style="font-size:11px;color:#65676b">${p.rubro || p.categoria || '-'} · Stock: <b style="color:#c62828">${_stockEfectivo(p)}</b></div>
              </div>
              <div style="text-align:right">
                <span class="badge badge-red">${p.estado.label}</span>
                ${p.estado.velocidad > 0 ? `<div style="font-size:11px;color:#65676b;margin-top:2px">${p.estado.velocidad.toFixed(1)} u/día</div>` : ''}
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  }

  function applyFilters() {
    let data = getBase();
    const nombre = (document.getElementById('filtroNombre')?.value || '').trim();
    const cat    = document.getElementById('filtroCategoria')?.value || '';
    const estado = document.getElementById('filtroEstado')?.value || '';
    const mov    = document.getElementById('filtroMovimiento')?.value || '';

    if (nombre) {
      // Búsqueda fuzzy: cada palabra debe aparecer en algún campo del producto
      const palabras = nombre.toLowerCase().split(/\s+/).filter(Boolean);
      data = data.filter(p => {
        const haystack = `${p.nombre||''} ${p.categoria||''} ${p.rubro||''} ${p.codigo||''} ${p.cod_barra||''}`.toLowerCase();
        return palabras.every(w => haystack.includes(w));
      });
    }
    if (cat)    data = data.filter(p => (p.categoria || 'Sin categoría') === cat);
    if (estado) data = data.filter(p => p.estado.key === estado);
    if (mov === 'con') data = data.filter(p => p.estado.velocidad > 0);
    if (mov === 'sin') data = data.filter(p => p.estado.velocidad === 0);

    data.sort((a,b) => {
      const orden = { agotado:0, critico:1, bajo:2, regular:3, ok:4 };
      return (orden[a.estado.key] ?? 5) - (orden[b.estado.key] ?? 5);
    });

    renderRows(data);
  }

  function renderRows(data) {
    const tbody = document.getElementById('invBody');
    const countEl = document.getElementById('invCount');
    if (!tbody) return;
    if (countEl) countEl.textContent = `${data.length} productos`;
    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-muted)">Sin productos</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map(p => {
      const stock = _stockEfectivo(p);
      const e = p.estado;
      const bgRow = e.key === 'agotado' ? 'background:#fff8f8' : e.key === 'critico' ? 'background:#fff3f3' : '';
      const pct = e.pct || 0;
      const barColor = pct <= 20 ? '#c62828' : pct <= 50 ? '#f57c00' : '#2e7d32';
      const barHtml = `
        <div style="display:flex;align-items:center;gap:6px">
          <div style="flex:1;background:#e4e6eb;border-radius:99px;height:6px;overflow:hidden;min-width:50px">
            <div style="width:${pct}%;height:100%;background:${barColor};border-radius:99px"></div>
          </div>
          <span style="font-size:11px;font-weight:700;color:${barColor};width:30px">${pct}%</span>
        </div>`;
      const diasTxt = e.dias !== null && e.dias !== undefined
        ? `<b style="color:${e.color}">${e.dias}d</b>`
        : `<span style="color:#bbb;font-size:11px">—</span>`;
      const velTxt = e.velocidad > 0
        ? `<span style="font-size:12px;color:#7b1fa2;font-weight:600">${e.velocidad.toFixed(2)}</span>`
        : `<span style="font-size:11px;color:#bbb">—</span>`;

      return `<tr style="${bgRow}">
        <td><b style="font-size:13px">${p.nombre || '-'}</b><br><span style="color:#65676b;font-size:10px">${p.cod_barra || ''}</span></td>
        <td class="inv-col-categoria"><span class="badge badge-gray">${p.categoria || '-'}</span></td>
        <td class="inv-col-rubro" style="font-size:11px;color:#65676b">${p.rubro || '-'}</td>
        <td style="text-align:center;font-weight:800;font-size:16px;color:${stock===0?'#c62828':stock<=3?'#f57c00':'#1c1e21'}">
          <span class="stock-val" data-id="${p.doc_id}" style="cursor:pointer;border-bottom:1px dashed #ccc" title="Click para editar">${stock}</span>
        </td>
        <td class="inv-col-dias" style="text-align:center">${diasTxt}</td>
        <td class="inv-col-cobertura">${barHtml}</td>
        <td class="inv-col-velocidad" style="text-align:center">${velTxt}</td>
        <td><span class="badge ${e.cls}">${e.label}</span></td>
        <td style="text-align:right;color:#2e7d32;font-weight:600">$${fmt(p.precio_venta || p.precio || 0)}</td>
        <td>
          <button class="btn-edit-stock" data-id="${p.doc_id}" style="background:none;border:none;cursor:pointer;color:#1877f2;padding:4px" title="Editar stock">
            <span class="material-icons" style="font-size:16px">edit</span>
          </button>
        </td>
      </tr>`;
    }).join('');

    // Editar stock inline
    document.querySelectorAll('.btn-edit-stock').forEach(btn => {
      btn.addEventListener('click', () => editarStock(btn.dataset.id, data));
    });
    document.querySelectorAll('.stock-val').forEach(cell => {
      cell.addEventListener('click', () => editarStock(cell.dataset.id, data));
    });
  }

  async function editarStock(docId, data) {
    const p = data.find(x => x.doc_id === docId);
    if (!p) return;
    // Productos conjunto: no se puede editar con un prompt simple (tienen
    // unidades cerradas, restante y eventualmente colores). El editor real
    // está en Catálogo.
    if (p.es_conjunto === true || p.es_conjunto === 1) {
      alert(
        `"${p.nombre}" es un producto conjunto (rollo/pack/caja).\n\n` +
        'Editá su stock desde Catálogo → abrí el producto y usá el bloque "PRODUCTO CONJUNTO".'
      );
      return;
    }
    const nuevoStock = prompt(`Stock actual de "${p.nombre}": ${p.stock || 0}\n\nIngresá el nuevo stock:`);
    if (nuevoStock === null) return;
    const valor = parseInt(nuevoStock);
    if (isNaN(valor) || valor < 0) { alert('Stock inválido'); return; }
    try {
      await updateDoc(doc(db, 'catalogo', docId), { stock: valor, ultima_actualizacion: serverTimestamp() });
      invalidateCacheByPrefix('catalogo');
      invalidateCacheByPrefix('inv:');
      const idx = prods.findIndex(x => x.doc_id === docId);
      if (idx !== -1) {
        prods[idx].stock = valor;
        prods[idx].estado = calcularEstado(prods[idx]);
      }
      applyFilters();
    } catch(e) {
      alert('Error al guardar: ' + e.message);
    }
  }

  renderShell();
}
