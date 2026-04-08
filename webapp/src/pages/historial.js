import { collection, getDocs, query, orderBy, where } from 'firebase/firestore';
import { openSaleModal } from '../components/modal.js';

export async function renderHistorial(container, db) {
  const [histSnap, ventasDiaSnap] = await Promise.all([
    getDocs(query(collection(db, 'historial_diario'), orderBy('fecha', 'desc'))),
    getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha', 'desc'))),
  ]);

  const historial   = histSnap.docs.map(d => d.data());
  const ventasDia   = ventasDiaSnap.docs.map(d => d.data());

  container.innerHTML = `
    <!-- Historial Diario -->
    <div class="table-card" style="margin-bottom:24px">
      <div class="table-card-header">
        <h3>📅 Resumen por Día</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Fecha</th><th class="hist-col-mes">Mes</th><th># Ventas</th>
            <th>Total</th><th class="hist-col-efectivo">Efectivo</th><th class="hist-col-transferencia">Transferencia</th><th class="hist-col-ticket">Ticket Promedio</th>
          </tr></thead>
          <tbody>
            ${historial.map(h => `<tr>
              <td><b>${h.fecha || '-'}</b></td>
              <td class="hist-col-mes"><span class="badge badge-blue">${h.mes || '-'}</span></td>
              <td style="text-align:center">${h.num_ventas || 0}</td>
              <td><b style="color:var(--success)">$${fmt(h.total)}</b></td>
              <td class="hist-col-efectivo">$${fmt(h.efectivo)}</td>
              <td class="hist-col-transferencia">$${fmt(h.transferencia)}</td>
              <td class="hist-col-ticket">$${fmt(h.ticket_promedio)}</td>
            </tr>`).join('') || `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">Sin datos</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Detalle por producto del día -->
    <div class="table-card">
      <div class="table-card-header">
        <h3>🛒 Detalle de Productos Vendidos por Día</h3>
        <div class="filter-bar" style="margin:0">
          <input type="date" id="filtroDia" />
          <input type="text" id="filtroProducto" placeholder="Producto..." style="width:160px" />
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Fecha</th><th class="hist-col-hora">Hora</th><th># Venta</th><th>Producto</th>
            <th class="hist-col-categoria">Categoría</th><th>Cant.</th><th class="hist-col-precio">Precio Unit.</th><th>Subtotal</th><th>Tipo Pago</th><th class="hist-col-cajero">Cajero</th>
          </tr></thead>
          <tbody id="ventasDiaBody"></tbody>
        </table>
      </div>
    </div>
  `;

  function renderVentasDia(data) {
    const tbody = document.getElementById('ventasDiaBody');
    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-muted)">Sin datos para mostrar</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map((v, i) => {
      const esTransf = (v.tipo_pago || '') === 'Transferencia';
      return `<tr class="clickable-row" data-idx="${i}" data-ventaid="${v.num_venta || ''}" style="${esTransf ? 'background:#f3f8ff' : ''}" title="Click para ver venta completa">
        <td><b>${v.fecha || '-'}</b></td>
        <td class="hist-col-hora" style="color:var(--text-muted)">${v.hora || '-'}</td>
        <td style="text-align:center"><b>#${v.num_venta || '-'}</b></td>
        <td><b>${v.producto || '-'}</b></td>
        <td class="hist-col-categoria"><span class="badge badge-gray">${v.categoria || '-'}</span></td>
        <td style="text-align:center">${v.cantidad || '-'}</td>
        <td class="hist-col-precio">$${fmt(v.precio_unitario)}</td>
        <td><b>$${fmt(v.subtotal)}</b></td>
        <td><span class="badge ${esTransf ? 'badge-blue' : 'badge-green'}">${v.tipo_pago || '-'}</span></td>
        <td class="hist-col-cajero"><b>${v.cajero || '-'}</b></td>
      </tr>`;
    }).join('');

    // Click en fila → abrir venta relacionada desde coleccion ventas
    tbody.querySelectorAll('.clickable-row').forEach(row => {
      row.addEventListener('click', async () => {
        const ventaId = row.dataset.ventaid;
        if (!ventaId) return;
        try {
          // Buscar la venta por sale_id
          const snap = await getDocs(query(collection(db, 'ventas'), where('sale_id', '==', parseInt(ventaId))));
          if (!snap.empty) {
            openSaleModal(snap.docs[0].data(), db);
          } else {
            const snap2 = await getDocs(query(collection(db, 'ventas'), where('sale_id', '==', ventaId)));
            if (!snap2.empty) openSaleModal(snap2.docs[0].data(), db);
          }
        } catch(e) { console.error(e); }
      });
    });
  }

  function applyFilters() {
    let data = [...ventasDia];
    const dia      = document.getElementById('filtroDia').value;
    const producto = document.getElementById('filtroProducto').value.toLowerCase();
    if (dia)      data = data.filter(v => (v.fecha || '').includes(dia.split('-').reverse().join('/')));
    if (producto) data = data.filter(v => (v.producto || '').toLowerCase().includes(producto));
    renderVentasDia(data);
  }

  ['filtroDia','filtroProducto'].forEach(id => {
    document.getElementById(id).addEventListener('input', applyFilters);
  });

  renderVentasDia(ventasDia);
}

function fmt(n) { return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
