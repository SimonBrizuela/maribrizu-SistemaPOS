import { collection, getDocs, query, orderBy, limit, where } from 'firebase/firestore';
import { openSaleModal } from '../components/modal.js';
import { getCached } from '../cache.js';

export async function renderVentas(container, db) {
  // Cargar ventas e items en paralelo, con cache en memoria
  const [ventas, itemsPorVenta] = await Promise.all([
    getCached('ventas:lista', async () => {
      const snap = await getDocs(query(collection(db, 'ventas'), orderBy('created_at', 'desc'), limit(500)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }),
    getCached('ventas:items', async () => {
      const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('num_venta', 'asc'), limit(2000)));
      const map = {};
      snap.docs.forEach(d => {
        const data = d.data();
        const key = String(data.num_venta);
        if (!map[key]) map[key] = [];
        const nombre = data.producto || data.product_name || '';
        const cant   = data.cantidad || data.quantity || 1;
        if (nombre) map[key].push(`${nombre}${cant > 1 ? ` x${cant}` : ''}`);
      });
      return map;
    })
  ]);

  // Enriquecer cada venta con sus productos
  ventas.forEach(v => {
    const key = String(v.sale_id || v.id);
    v._productosTexto = (itemsPorVenta[key] || []).join(', ');
  });

  container.innerHTML = `
    <div class="filter-bar">
      <input type="date" id="filtroDesde" placeholder="Desde" />
      <input type="date" id="filtroHasta" placeholder="Hasta" />
      <select id="filtroPago">
        <option value="">Todos los pagos</option>
        <option value="cash">Efectivo</option>
        <option value="transfer">Transferencia</option>
      </select>
      <input type="text" id="filtroCajero" placeholder="Cajero..." style="width:140px" />
    </div>
    <div class="table-card">
      <div class="table-card-header">
        <h3>🧾 Todas las Ventas</h3>
        <span id="ventasCount" style="color:var(--text-muted);font-size:13px"></span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Fecha</th><th class="vta-col-hora">Hora</th><th class="vta-col-productos">Productos</th>
            <th class="vta-col-items">Items</th><th>Total</th><th class="vta-col-efectivo">Efectivo</th><th class="vta-col-cambio">Cambio</th>
            <th>Tipo Pago</th><th>Cajero</th>
          </tr></thead>
          <tbody id="ventasBody"></tbody>
        </table>
      </div>
    </div>
  `;

  function renderRows(data) {
    const tbody = document.getElementById('ventasBody');
    document.getElementById('ventasCount').textContent = data.length + ' ventas — click en una fila para ver el detalle';
    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-muted)">Sin ventas para mostrar</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map((v, i) => {
      const dt = parseArDate(v.created_at);
      const esEfectivo = v.payment_type === 'cash';
      const tieneDescuento = (v.discount || 0) > 0;
      return `<tr class="clickable-row" data-idx="${i}" title="Click para ver detalle">
        <td><b>#${v.sale_id || v.id || '-'}</b></td>
        <td>${fmtDate(dt)}</td>
        <td class="vta-col-hora">${fmtTime(dt)}</td>
        <td class="vta-col-productos" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${v._productosTexto || 'Click para ver detalle'}">
          ${v._productosTexto
            ? `<span style="color:var(--text-muted);font-size:12px">${v._productosTexto}</span>`
            : `<span style="color:var(--primary);font-size:12px;cursor:pointer">🔍 Ver detalle</span>`}
        </td>
        <td class="vta-col-items" style="text-align:center"><span class="badge badge-gray">${v.items_count || '-'}</span></td>
        <td><b>$${fmt(v.total_amount)}</b></td>
        <td class="vta-col-efectivo">$${fmt(v.cash_received)}</td>
        <td class="vta-col-cambio">$${fmt(v.change_given)}</td>
        <td>
          <span class="badge ${esEfectivo ? 'badge-green' : 'badge-blue'}">${esEfectivo ? '💵 Efectivo' : '🏦 Transferencia'}</span>
          ${tieneDescuento ? `<span class="badge badge-orange" style="margin-left:4px">🏷️ -$${fmt(v.discount)}</span>` : ''}
        </td>
        <td><b>${v.cajero || v.username || v.user_id || '-'}</b></td>
      </tr>`;
    }).join('');

    // Eventos click en filas
    tbody.querySelectorAll('.clickable-row').forEach(row => {
      row.addEventListener('click', () => {
        const idx = parseInt(row.dataset.idx);
        openSaleModal(data[idx], db);
      });
    });
  }

  function applyFilters() {
    let data = [...ventas];
    const desde = document.getElementById('filtroDesde').value;
    const hasta = document.getElementById('filtroHasta').value;
    const pago  = document.getElementById('filtroPago').value;
    const cajero = document.getElementById('filtroCajero').value.toLowerCase();

    if (desde) data = data.filter(v => {
      const dt = parseArDate(v.created_at);
      return dt >= new Date(desde + 'T00:00:00-03:00');
    });
    if (hasta) data = data.filter(v => {
      const dt = parseArDate(v.created_at);
      return dt <= new Date(hasta + 'T23:59:59-03:00');
    });
    if (pago) data = data.filter(v => v.payment_type === pago);
    if (cajero) data = data.filter(v =>
      (v.cajero || v.username || '').toLowerCase().includes(cajero)
    );
    renderRows(data);
  }

  ['filtroDesde','filtroHasta','filtroPago','filtroCajero'].forEach(id => {
    document.getElementById(id).addEventListener('input', applyFilters);
  });

  renderRows(ventas);
}

// created_at se guarda con timezone AR (-03:00) → Firestore lo almacena como UTC correcto → no necesita compensación
// Maneja: Timestamp live (.toDate), Timestamp de localStorage ({ seconds, nanoseconds }), ISO string
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
