import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore';
import { openSaleModal } from '../components/modal.js';
import { getCached } from '../cache.js';

export async function renderDashboard(container, db) {
  // Obtener ventas de hoy (medianoche en hora Argentina)
  const hoy = new Date(todayAR() + 'T00:00:00-03:00');

  const [ventas, catalogo, topProds, historial] = await Promise.all([
    // Ventas: TTL 1 min (se ven datos de hoy, queremos relativamente fresco)
    getCached('dashboard:ventas', async () => {
      const snap = await getDocs(query(collection(db, 'ventas'), orderBy('created_at', 'desc'), limit(500)));
      return snap.docs.map(d => d.data());
    }, { ttl: 60 * 1000 }),
    // Catálogo completo: TTL 10 min, solo en memoria (12k+ docs, demasiado para localStorage)
    getCached('catalogo:all', async () => {
      const snap = await getDocs(collection(db, 'catalogo'));
      return snap.docs.map(d => d.data());
    }, { ttl: 10 * 60 * 1000, memOnly: true }),
    // Top productos: TTL 3 min
    getCached('dashboard:top_productos', async () => {
      const snap = await getDocs(query(collection(db, 'productos_mas_vendidos'), orderBy('total_vendido', 'desc'), limit(5)));
      return snap.docs.map(d => d.data());
    }, { ttl: 3 * 60 * 1000 }),
    // Historial diario: TTL 3 min
    getCached('dashboard:historial', async () => {
      const snap = await getDocs(query(collection(db, 'historial_diario'), orderBy('fecha', 'desc'), limit(7)));
      return snap.docs.map(d => d.data());
    }, { ttl: 3 * 60 * 1000 }),
  ]);

  // Stats de hoy (en hora Argentina)
  const ventasHoy = ventas.filter(v => {
    const fecha = parseArDate(v.created_at);
    return fecha >= hoy;
  });

  const totalHoy = ventasHoy.reduce((s, v) => s + (v.total_amount || 0), 0);
  const efectivoHoy = ventasHoy.filter(v => v.payment_type === 'cash').reduce((s, v) => s + (v.total_amount || 0), 0);
  const transferenciaHoy = totalHoy - efectivoHoy;

  // Stats catálogo (usa catálogo completo, no inventario del POS)
  const stockCritico = catalogo.filter(p => (p.stock || 0) <= 3 && (p.stock || 0) > 0).length;
  const stockAgotado = catalogo.filter(p => (p.stock || 0) === 0).length;

  // Total mes
  const inicioMes = new Date(todayAR().slice(0, 7) + '-01T00:00:00-03:00');
  const ventasMes = ventas.filter(v => {
    const fecha = parseArDate(v.created_at);
    return fecha >= inicioMes;
  });
  const totalMes = ventasMes.reduce((s, v) => s + (v.total_amount || 0), 0);

  container.innerHTML = `
    <!-- Stats -->
    <div class="cards-grid">
      <div class="card stat-card">
        <div class="icon-wrap bg-blue"><span class="material-icons">today</span></div>
        <div class="label">Ventas Hoy</div>
        <div class="value">$${fmt(totalHoy)}</div>
        <small style="color:var(--text-muted)">${ventasHoy.length} transacciones</small>
      </div>
      <div class="card stat-card">
        <div class="icon-wrap bg-green"><span class="material-icons">payments</span></div>
        <div class="label">Efectivo Hoy</div>
        <div class="value">$${fmt(efectivoHoy)}</div>
      </div>
      <div class="card stat-card">
        <div class="icon-wrap bg-purple"><span class="material-icons">swap_horiz</span></div>
        <div class="label">Transferencia Hoy</div>
        <div class="value">$${fmt(transferenciaHoy)}</div>
      </div>
      <div class="card stat-card">
        <div class="icon-wrap bg-orange"><span class="material-icons">calendar_month</span></div>
        <div class="label">Total del Mes</div>
        <div class="value">$${fmt(totalMes)}</div>
        <small style="color:var(--text-muted)">${ventasMes.length} ventas</small>
      </div>
      <div class="card stat-card">
        <div class="icon-wrap bg-red"><span class="material-icons">warning</span></div>
        <div class="label">Stock Crítico</div>
        <div class="value">${stockCritico}</div>
        <small style="color:var(--text-muted)">${stockAgotado} agotados</small>
      </div>
      <div class="card stat-card">
        <div class="icon-wrap bg-teal"><span class="material-icons">inventory_2</span></div>
        <div class="label">Productos</div>
        <div class="value">${catalogo.length}</div>
      </div>
    </div>

    <!-- Charts -->
    <div class="chart-section">
      <div class="chart-card">
        <h3>📊 Últimos 7 días</h3>
        <div class="bar-chart" id="barChart"></div>
      </div>
      <div class="chart-card">
        <h3>🏆 Top 5 Productos</h3>
        <div class="bar-chart" id="topProdChart"></div>
      </div>
    </div>

    <!-- Ultimas ventas -->
    <div class="table-card">
      <div class="table-card-header">
        <h3>🧾 Últimas Ventas</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Fecha</th><th>Hora</th><th>Total</th><th>Tipo Pago</th><th>Cajero</th>
          </tr></thead>
          <tbody>
            ${ventas.slice(0, 10).map((v, i) => {
              const dt = parseArDate(v.created_at);
              const esEfectivo = v.payment_type === 'cash';
              const tieneDescuento = (v.discount || 0) > 0;
              return `<tr class="clickable-row" data-idx="${i}" title="Click para ver detalle">
                <td><b>#${v.sale_id || v.id || '-'}</b></td>
                <td>${fmtDate(dt)}</td>
                <td>${fmtTime(dt)}</td>
                <td><b>$${fmt(v.total_amount)}</b>${tieneDescuento ? ` <span class="badge badge-orange" style="font-size:10px">-$${fmt(v.discount)}</span>` : ''}</td>
                <td><span class="badge ${esEfectivo ? 'badge-green' : 'badge-blue'}">${esEfectivo ? '💵 Efectivo' : '🏦 Transferencia'}</span></td>
                <td><b>${v.cajero || v.username || v.user_id || '-'}</b></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Click en filas del dashboard
  const recentVentas = ventas.slice(0, 10);
  document.querySelectorAll('#pageContent .clickable-row').forEach(row => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.idx);
      openSaleModal(recentVentas[idx], db);
    });
  });

  // Renderizar gráfico de últimos 7 días
  const barChart = document.getElementById('barChart');
  const maxHist = Math.max(...historial.map(h => h.total || 0), 1);
  barChart.innerHTML = historial.slice(0, 7).reverse().map(h => `
    <div class="bar-row">
      <span class="bar-label">${h.fecha || ''}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round((h.total || 0) / maxHist * 100)}%"></div></div>
      <span class="bar-val">$${fmt(h.total)}</span>
    </div>
  `).join('');

  // Top productos
  const topChart = document.getElementById('topProdChart');
  const maxProd = Math.max(...topProds.map(p => p.total_vendido || 0), 1);
  topChart.innerHTML = topProds.map((p, i) => `
    <div class="bar-row">
      <span class="bar-label" title="${p.nombre}">${p.nombre}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round((p.total_vendido || 0) / maxProd * 100)}%;background:${['#1877f2','#2e7d32','#e65100','#6a1b9a','#00695c'][i]}"></div></div>
      <span class="bar-val">${p.total_vendido}</span>
    </div>
  `).join('');
}

// Fecha actual en Argentina (YYYY-MM-DD)
function todayAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}
// Maneja tres formas: Timestamp live (.toDate), Timestamp de localStorage ({ seconds, nanoseconds }), ISO string
function parseArDate(raw) {
  if (!raw) return new Date(NaN);
  if (typeof raw.toDate === 'function') return raw.toDate();
  if (typeof raw === 'object' && raw.seconds !== undefined)
    return new Date(raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6));
  return new Date(raw);
}
function fmt(n) { return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDate(d) { return d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }); }
function fmtTime(d) { return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' }); }
