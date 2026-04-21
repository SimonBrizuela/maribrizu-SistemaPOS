import { collection, getDocs, query, orderBy, limit, where, updateDoc, doc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { openSaleModal } from '../components/modal.js';
import { getCached, invalidateCache } from '../cache.js';
import { getFechaInicioDate } from '../config.js';
import { getSaleNumberMap, displayNumForVenta } from '../sale_numbers.js';

export async function renderVentas(container, db) {
  const fechaInicio = await getFechaInicioDate(db);
  const saleNumMap  = await getSaleNumberMap(db);

  // Cargar ventas e items en paralelo, con cache en memoria
  const [ventasRaw, itemsPorVenta] = await Promise.all([
    getCached('ventas:lista', async () => {
      const snap = await getDocs(query(collection(db, 'ventas'), orderBy('created_at', 'desc'), limit(500)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }),
    getCached('ventas:items', async () => {
      const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('num_venta', 'asc'), limit(2000)));
      const map = {};
      snap.docs.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return;
        const parts = d.id.split('_');
        const pcId  = parts.length >= 3 ? parts.slice(0, -2).join('_') : '';
        const key   = pcId ? `${pcId}_${data.num_venta}` : String(data.num_venta);
        if (!map[key]) map[key] = [];
        const nombre = data.producto || data.product_name || '';
        const cant   = data.cantidad || data.quantity || 1;
        if (nombre) map[key].push(`${nombre}${cant > 1 ? ` x${cant}` : ''}`);
      });
      return map;
    })
  ]);

  // Ocultar ventas anteriores a fecha_inicio, borradas y Varios 2 (solo factura AFIP)
  const ventas = ventasRaw.filter(v =>
    v.deleted !== true && v.is_varios_2 !== true && parseArDate(v.created_at) >= fechaInicio
  );

  // Enriquecer cada venta con sus productos
  ventas.forEach(v => {
    const saleId = v.sale_id || v.id;
    const key = v.pc_id ? `${v.pc_id}_${saleId}` : String(saleId);
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
            <th>Tipo Pago</th><th>Cajero</th><th></th>
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
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-muted)">Sin ventas para mostrar</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map((v, i) => {
      const dt = parseArDate(v.created_at);
      const esEfectivo = v.payment_type === 'cash';
      const tieneDescuento = (v.discount || 0) > 0;
      return `<tr class="clickable-row" data-idx="${i}" title="Click para ver detalle">
        <td><b>#${displayNumForVenta(v, saleNumMap)}</b></td>
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
        <td style="text-align:center">
          <button class="btn-delete-venta" data-idx="${i}" title="Eliminar venta"
            style="background:transparent;border:none;cursor:pointer;font-size:16px;color:#dc3545;padding:4px 8px;border-radius:4px"
            onmouseover="this.style.background='#fee'" onmouseout="this.style.background='transparent'">🗑️</button>
        </td>
      </tr>`;
    }).join('');

    // Eventos click en filas
    tbody.querySelectorAll('.clickable-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-venta')) return;
        const idx = parseInt(row.dataset.idx);
        openSaleModal(data[idx], db);
      });
    });

    // Eventos click en botones eliminar
    tbody.querySelectorAll('.btn-delete-venta').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        const venta = data[idx];
        await handleDeleteVenta(venta, saleNumMap);
      });
    });
  }

  async function handleDeleteVenta(venta, numMap) {
    const numMostrado = displayNumForVenta(venta, numMap);
    const total = fmt(venta.total_amount);
    const ok = confirm(
      `¿Eliminar la venta #${numMostrado} por $${total}?\n\n` +
      `Esta acción la removerá del historial, dashboard, cierres, control total y resúmenes.\n` +
      `No se puede deshacer fácilmente.`
    );
    if (!ok) return;

    try {
      await updateDoc(doc(db, 'ventas', venta.id), {
        deleted: true,
        deleted_at: serverTimestamp()
      });

      // Marcar también los items correspondientes en ventas_por_dia
      const saleId = venta.sale_id || venta.id;
      const pcId = venta.pc_id || '';
      try {
        const itemsSnap = await getDocs(query(
          collection(db, 'ventas_por_dia'),
          where('num_venta', '==', Number(saleId))
        ));
        let docsToMark = itemsSnap.docs;
        if (pcId) {
          docsToMark = docsToMark.filter(d => d.id.startsWith(pcId + '_'));
        }
        if (docsToMark.length) {
          const batch = writeBatch(db);
          docsToMark.forEach(d => batch.update(d.ref, { deleted: true }));
          await batch.commit();
        }
      } catch (err) {
        console.warn('No se pudieron marcar items de ventas_por_dia:', err);
      }

      invalidateCache('ventas:lista');
      invalidateCache('ventas:items');
      invalidateCache('dashboard:ventas');
      invalidateCache('cierres:ventas');
      invalidateCache('control_total:ventas');
      invalidateCache('control_total:items');

      const idxOriginal = ventas.findIndex(v => v.id === venta.id);
      if (idxOriginal >= 0) ventas.splice(idxOriginal, 1);
      applyFilters();
    } catch (err) {
      console.error('Error eliminando venta:', err);
      alert('Error al eliminar la venta: ' + (err.message || err));
    }
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
