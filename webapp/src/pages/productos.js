import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore';
import { getCached, peekCacheValue } from '../cache.js';
import { getFechaInicio, getFechaInicioDate, fechaDMYtoYMD, parseArDate } from '../config.js';
// Lo que se vende fraccionado llega con el nombre decorado y la cantidad en la
// presentación vendida: sin leerlo, el mismo producto se parte en varias filas
// y ninguna rankea donde le corresponde.
import { parseNombreItem, buscarPorNombre, unidadesDelRenglon } from '../nombre_item.js';

export async function renderProductos(container, db) {
  // 1) Shell vacío al toque — labels visibles, filtros funcionales, tabla con encabezados.
  container.innerHTML = renderProductosShell();
  const tbody = container.querySelector('#prodBody');
  if (tbody) tbody.innerHTML = skelRowsHtml(8);

  const fechaInicioStr = await getFechaInicio(db);
  const fechaInicio = await getFechaInicioDate(db);

  // El ranking se recalcula desde `ventas_por_dia` filtradas por fecha_inicio,
  // porque `productos_mas_vendidos` es un agregado histórico que incluye datos viejos.
  const itemsVentas = await getCached('productos:items_rich', async () => {
    // orderBy por fecha_dt (Timestamp): el string `fecha` + limit recortaba el mes nuevo.
    const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha_dt', 'desc'), limit(5000)));
    return snap.docs.map(d => d.data());
  }, { ttl: 5 * 60 * 1000, memOnly: true });

  // El catálogo, para traducir las presentaciones ("1 pack(s)" son 500 hojas).
  // Se toma del store si ya está; si no, el ranking sale igual y sólo queda sin
  // convertir lo fraccionado.
  const catalogo = peekCacheValue('catalogo:all');
  const porNombre = {};
  for (const p of (Array.isArray(catalogo) ? catalogo : [])) {
    const n = String(p?.nombre || '').toUpperCase().trim();
    if (n && !porNombre[n]) porNombre[n] = p;
  }

  const mapa = {};
  for (const it of itemsVentas) {
    if (it.deleted === true) continue;
    if (fechaDMYtoYMD(it.fecha) < fechaInicioStr) continue;
    // Por el nombre limpio: el renglón de una venta fraccionada llega decorado
    // ("[Verde]  CARTULINA  ·  2 u") y agrupaba por ese texto, así que un mismo
    // producto salía repartido en varias filas y ninguna rankeaba por el total.
    const crudo = it.producto || it.product_name || '-';
    const nombre = String(parseNombreItem(crudo).base || crudo).trim() || '-';
    if (!mapa[nombre]) {
      mapa[nombre] = {
        nombre,
        categoria: it.categoria || 'Sin categoría',
        total_vendido: 0,
        ingresos: 0,
        ultima_venta: '',
      };
    }
    // Y las unidades traducidas, o sumar un rollo con un metro daría "3".
    mapa[nombre].total_vendido += unidadesDelRenglon(
      { producto: crudo, cantidad: it.cantidad ?? it.quantity ?? 0 },
      buscarPorNombre(porNombre, crudo),
    );
    mapa[nombre].ingresos      += Number(it.subtotal || 0);
    const f = it.fecha || '';
    if (f > mapa[nombre].ultima_venta) mapa[nombre].ultima_venta = f;
  }
  const productos = Object.values(mapa)
    .map(p => ({ ...p, total_vendido: Math.round(p.total_vendido * 100) / 100 }))
    .sort((a, b) => b.total_vendido - a.total_vendido);

  const totalUnidades = productos.reduce((s, p) => s + (p.total_vendido || 0), 0);
  const totalIngresos = productos.reduce((s, p) => s + (p.ingresos || 0), 0);

  // 2) Patch stat cards in-place — el valor "—" se reemplaza con el número real
  const statValues = [
    ['total-productos',  String(productos.length)],
    ['unidades',         String(totalUnidades)],
    ['ingresos',         '$' + fmt(totalIngresos)],
  ];
  // Todos los valores aparecen juntos con fade-in sutil (sin stagger)
  statValues.forEach(([id, val]) => {
    const card = container.querySelector(`[data-stat="${id}"]`);
    if (!card) return;
    const valEl = card.querySelector('.value');
    if (!valEl) return;
    valEl.style.color = '';
    valEl.textContent = val;
    valEl.classList.add('val-fill');
  });

  // 3) Poblar select de categorías dinámicamente (sin reemplazar el filter-bar entero)
  const selCat = container.querySelector('#filtroCategoria');
  if (selCat) {
    const cats = [...new Set(productos.map(p => p.categoria || 'Sin categoría'))].sort();
    selCat.innerHTML = `<option value="">Todas las categorías</option>` +
      cats.map(c => `<option value="${c}">${c}</option>`).join('');
  }

  // 4) Render filas junto con los stats — todo aparece a la vez
  renderRows(container, productos);

  // Filtros
  ['filtroNombre', 'filtroCategoria'].forEach(id => {
    const el = container.querySelector('#' + id);
    if (!el) return;
    el.addEventListener('input', () => applyFilters(container, productos));
  });
}

function renderProductosShell() {
  return `
    <div class="cards-grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr));margin-bottom:24px">
      ${statCardShell('total-productos',  'trending_up',  'bg-orange', 'Total Productos')}
      ${statCardShell('unidades',         'shopping_cart', 'bg-blue',  'Unidades Vendidas')}
      ${statCardShell('ingresos',         'attach_money', 'bg-green', 'Ingresos Totales')}
    </div>

    <div class="filter-bar">
      <input type="text" id="filtroNombre" placeholder="Buscar producto..." style="width:200px" />
      <select id="filtroCategoria">
        <option value="">Todas las categorías</option>
      </select>
    </div>

    <div class="table-card">
      <div class="table-card-header">
        <h3>🏆 Ranking de Productos Más Vendidos</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Rank</th><th>Producto</th><th>Categoría</th>
            <th>Unidades</th><th>Ingresos</th><th>Última Venta</th>
          </tr></thead>
          <tbody id="prodBody"></tbody>
        </table>
      </div>
    </div>
  `;
}

function statCardShell(id, icon, bgClass, label) {
  return `
    <div class="card stat-card" data-stat="${id}">
      <div class="icon-wrap ${bgClass}"><span class="material-icons">${icon}</span></div>
      <div class="label">${label}</div>
      <div class="value" style="color:var(--text-muted)">—</div>
    </div>`;
}
function statCard(icon, bgClass, label, value) {
  return `
    <div class="card stat-card">
      <div class="icon-wrap ${bgClass}"><span class="material-icons">${icon}</span></div>
      <div class="label">${label}</div>
      <div class="value">${value}</div>
    </div>`;
}
function skelRowsHtml(n) {
  return Array(n).fill(`
    <tr><td colspan="6" style="padding:6px 12px"><div class="skel" style="height:24px;border-radius:6px"></div></td></tr>
  `).join('');
}

function renderRows(container, data) {
  const tbody = container.querySelector('#prodBody');
  if (!tbody) return;
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted)">Sin datos</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((p, i) => {
    const rank = i + 1;
    const rankClass = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : '';
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
    return `<tr>
      <td class="${rankClass}" style="text-align:center;font-size:16px">${medal}</td>
      <td><b>${p.nombre || '-'}</b></td>
      <td><span class="badge badge-gray">${p.categoria || 'Sin categoría'}</span></td>
      <td style="text-align:center"><b>${p.total_vendido || 0}</b></td>
      <td><b style="color:var(--success)">$${fmt(p.ingresos)}</b></td>
      <td style="color:var(--text-muted)">${p.ultima_venta || '-'}</td>
    </tr>`;
  }).join('');
}

function applyFilters(container, productos) {
  let data = [...productos];
  const nombre = (container.querySelector('#filtroNombre')?.value || '').toLowerCase();
  const cat    = container.querySelector('#filtroCategoria')?.value || '';
  if (nombre) data = data.filter(p => (p.nombre || '').toLowerCase().includes(nombre));
  if (cat)    data = data.filter(p => (p.categoria || 'Sin categoría') === cat);
  renderRows(container, data);
}

function fmt(n) { return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
