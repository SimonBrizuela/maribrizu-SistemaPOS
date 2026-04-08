import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { getCached } from '../cache.js';

export async function renderProductos(container, db) {
  const productos = await getCached('productos:mas_vendidos', async () => {
    const snap = await getDocs(query(collection(db, 'productos_mas_vendidos'), orderBy('total_vendido', 'desc')));
    return snap.docs.map(d => d.data());
  });

  const totalUnidades = productos.reduce((s, p) => s + (p.total_vendido || 0), 0);
  const totalIngresos = productos.reduce((s, p) => s + (p.ingresos || 0), 0);

  container.innerHTML = `
    <div class="cards-grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr));margin-bottom:24px">
      <div class="card stat-card">
        <div class="icon-wrap bg-orange"><span class="material-icons">trending_up</span></div>
        <div class="label">Total Productos</div>
        <div class="value">${productos.length}</div>
      </div>
      <div class="card stat-card">
        <div class="icon-wrap bg-blue"><span class="material-icons">shopping_cart</span></div>
        <div class="label">Unidades Vendidas</div>
        <div class="value">${totalUnidades}</div>
      </div>
      <div class="card stat-card">
        <div class="icon-wrap bg-green"><span class="material-icons">attach_money</span></div>
        <div class="label">Ingresos Totales</div>
        <div class="value">$${fmt(totalIngresos)}</div>
      </div>
    </div>

    <div class="filter-bar">
      <input type="text" id="filtroNombre" placeholder="Buscar producto..." style="width:200px" />
      <select id="filtroCategoria">
        <option value="">Todas las categorías</option>
        ${[...new Set(productos.map(p => p.categoria || 'Sin categoría'))].map(c => `<option value="${c}">${c}</option>`).join('')}
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

  function renderRows(data) {
    const tbody = document.getElementById('prodBody');
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

  function applyFilters() {
    let data = [...productos];
    const nombre = document.getElementById('filtroNombre').value.toLowerCase();
    const cat    = document.getElementById('filtroCategoria').value;
    if (nombre) data = data.filter(p => (p.nombre || '').toLowerCase().includes(nombre));
    if (cat)    data = data.filter(p => (p.categoria || 'Sin categoría') === cat);
    renderRows(data);
  }

  ['filtroNombre','filtroCategoria'].forEach(id => {
    document.getElementById(id).addEventListener('input', applyFilters);
  });

  renderRows(productos);
}

function fmt(n) { return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
