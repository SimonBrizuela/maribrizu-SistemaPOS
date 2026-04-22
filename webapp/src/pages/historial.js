import { collection, getDocs, query, orderBy, where } from 'firebase/firestore';
import { openSaleModal } from '../components/modal.js';
import { getCached } from '../cache.js';
import { getFechaInicio, fechaDMYtoYMD, isItemVarios2 } from '../config.js';
import { getSaleNumberMap, displayNumForItem } from '../sale_numbers.js';

export async function renderHistorial(container, db) {
  const fechaInicioStr = await getFechaInicio(db);

  // Fuente única: `ventas_por_dia`. Resumen y Detalle se derivan de ese mismo dataset
  // → siempre consistentes entre sí y con Caja Abierta (TTL 60s, como dashboard/cierres).
  // Antes se leía `historial_diario` aparte, pero ese snapshot lo genera el backend
  // solo en full-sync / edición → quedaba stale y mostraba totales distintos.
  const [ventasDiaRaw, saleNumMap] = await Promise.all([
    getCached('historial:ventas_dia:v3', async () => {
      const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha', 'desc')));
      return snap.docs.map(d => {
        const data  = d.data();
        const parts = d.id.split('_');
        const pcId  = parts.length >= 3 ? parts.slice(0, -2).join('_') : '';
        return { ...data, _pc_id: pcId };
      });
    }, { ttl: 60 * 1000 }),
    getSaleNumberMap(db),
  ]);

  // Ocultar todo lo anterior a fecha_inicio (fechas vienen "DD/MM/YYYY") y lo eliminado.
  // VARIOS 2 = item de factura AFIP, no es venta real → se excluye del total y del conteo.
  const ventasDia  = ventasDiaRaw.filter(v => {
    if (v.deleted === true) return false;
    if (isItemVarios2(v)) return false;
    return fechaDMYtoYMD(v.fecha) >= fechaInicioStr;
  });

  // Agregar "Resumen por Día" desde ventasDia (preserva orden desc ya que Firestore viene así)
  const resumenMap = {};
  const ordenFechas = [];
  for (const v of ventasDia) {
    const f = v.fecha || 'Sin fecha';
    if (!(f in resumenMap)) {
      resumenMap[f] = { fecha: f, total: 0, efectivo: 0, transferencia: 0, _ventas: new Set() };
      ordenFechas.push(f);
    }
    const r = resumenMap[f];
    const sub = Number(v.subtotal || 0);
    r.total += sub;
    if ((v.tipo_pago || '') === 'Transferencia') r.transferencia += sub;
    else r.efectivo += sub;
    r._ventas.add(`${v._pc_id || ''}|${v.num_venta}`);
  }
  const historial = ordenFechas.map(f => {
    const r = resumenMap[f];
    const n = r._ventas.size;
    return {
      fecha: f,
      mes: mesDesdeFecha(f),
      num_ventas: n,
      total: r.total,
      efectivo: r.efectivo,
      transferencia: r.transferencia,
      ticket_promedio: n > 0 ? r.total / n : 0,
    };
  });

  container.innerHTML = `
    <!-- Resumen por Día -->
    <div class="table-card" style="margin-bottom:24px">
      <div class="table-card-header">
        <h3>Resumen por Día</h3>
        <span style="font-size:12px;color:var(--text-muted)">${historial.length} ${historial.length === 1 ? 'día' : 'días'}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Fecha</th>
            <th style="text-align:center"># Ventas</th>
            <th style="text-align:right">Total</th>
            <th class="hist-col-efectivo" style="text-align:right">Efectivo</th>
            <th class="hist-col-transferencia" style="text-align:right">Transferencia</th>
            <th class="hist-col-ticket" style="text-align:right">Ticket Promedio</th>
          </tr></thead>
          <tbody>
            ${historial.map(h => `<tr>
              <td>
                <div style="font-weight:600">${h.fecha || '-'}</div>
                <div style="font-size:11px;color:var(--text-muted);text-transform:capitalize">${h.mes || ''}</div>
              </td>
              <td style="text-align:center"><b>${h.num_ventas || 0}</b></td>
              <td style="text-align:right"><b style="color:var(--success);font-size:14px">$${fmt(h.total)}</b></td>
              <td class="hist-col-efectivo" style="text-align:right;color:#2e7d32">$${fmt(h.efectivo)}</td>
              <td class="hist-col-transferencia" style="text-align:right;color:#1565c0">$${fmt(h.transferencia)}</td>
              <td class="hist-col-ticket" style="text-align:right;color:var(--text-muted)">$${fmt(h.ticket_promedio)}</td>
            </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted)">Sin datos</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Detalle por día (agrupado) -->
    <div class="table-card">
      <div class="table-card-header">
        <h3>Detalle de Productos Vendidos por Día</h3>
        <div class="filter-bar" style="margin:0">
          <input type="date" id="filtroDia" />
          <input type="text" id="filtroProducto" placeholder="Producto..." style="width:160px" />
        </div>
      </div>
      <div id="ventasDiaContainer" class="day-groups"></div>
    </div>
  `;

  function renderVentasDia(data) {
    const cont = document.getElementById('ventasDiaContainer');
    if (!data.length) {
      cont.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">Sin datos para mostrar</div>`;
      return;
    }

    // Agrupar por fecha preservando orden (Firebase ya viene desc)
    const groups = [];
    const idxByDate = {};
    for (const v of data) {
      const key = v.fecha || 'Sin fecha';
      if (!(key in idxByDate)) {
        idxByDate[key] = groups.length;
        groups.push({ fecha: key, rows: [] });
      }
      groups[idxByDate[key]].rows.push(v);
    }

    // Dentro de cada día: ordenar por (# global asc, hora asc, producto).
    // Así los items de la misma venta quedan juntos y las ventas siguen
    // el orden cronológico real (venta #1 arriba, #N abajo).
    for (const g of groups) {
      g.rows.sort((a, b) => {
        const numA = displayNumForItem(a, saleNumMap);
        const numB = displayNumForItem(b, saleNumMap);
        if (numA !== numB) return Number(numA) - Number(numB);
        const horaA = a.hora || '';
        const horaB = b.hora || '';
        if (horaA !== horaB) return horaA.localeCompare(horaB);
        return (a.producto || '').localeCompare(b.producto || '');
      });
    }

    cont.innerHTML = groups.map((g, idx) => {
      const rows = g.rows;
      const totalDay = rows.reduce((s, r) => s + Number(r.subtotal || 0), 0);
      const totalQty = rows.reduce((s, r) => s + Number(r.cantidad || 0), 0);
      const efectivoMonto = rows.filter(r => (r.tipo_pago || '') !== 'Transferencia')
                                .reduce((s, r) => s + Number(r.subtotal || 0), 0);
      const transfMonto   = rows.filter(r => (r.tipo_pago || '') === 'Transferencia')
                                .reduce((s, r) => s + Number(r.subtotal || 0), 0);
      // Contar ventas únicas por (pc_id, num_venta) — un mismo num_venta en dos PCs son 2 ventas distintas
      const numVentas = new Set(rows.map(r => `${r._pc_id || ''}|${r.num_venta}`)).size;
      const expanded = idx === 0 ? ' expanded' : '';

      const productRows = rows.map(v => {
        const esTransf = (v.tipo_pago || '') === 'Transferencia';
        const numGlobal = displayNumForItem(v, saleNumMap);
        return `<tr class="clickable-row" data-ventaid="${v.num_venta || ''}" data-pcid="${v._pc_id || ''}" title="Ver venta completa">
          <td class="dpt-hora">${v.hora || '-'}</td>
          <td class="dpt-venta"><b>#${numGlobal}</b></td>
          <td class="dpt-prod"><b>${v.producto || '-'}</b></td>
          <td class="dpt-cant">${v.cantidad || '-'}</td>
          <td class="dpt-precio">$${fmt(v.precio_unitario)}</td>
          <td class="dpt-sub"><b>$${fmt(v.subtotal)}</b></td>
          <td class="dpt-pago"><span class="badge ${esTransf ? 'badge-blue' : 'badge-green'}">${v.tipo_pago || '-'}</span></td>
          <td class="dpt-cajero">${v.cajero || '-'}</td>
        </tr>`;
      }).join('');

      return `
        <div class="day-group${expanded}">
          <div class="day-group-header">
            <div class="dgh-left">
              <span class="material-icons dgh-caret">chevron_right</span>
              <div>
                <div class="dgh-date">${g.fecha}</div>
                <div class="dgh-meta">${numVentas} ${numVentas === 1 ? 'venta' : 'ventas'} · ${rows.length} productos · ${totalQty} ${totalQty === 1 ? 'unidad' : 'unidades'}</div>
              </div>
            </div>
            <div class="dgh-stats">
              <div class="dgh-stat efectivo">
                <span class="dgh-stat-label">Efectivo</span>
                <span class="dgh-stat-val">$${fmt(efectivoMonto)}</span>
              </div>
              <div class="dgh-stat transf">
                <span class="dgh-stat-label">Transferencia</span>
                <span class="dgh-stat-val">$${fmt(transfMonto)}</span>
              </div>
              <div class="dgh-stat total">
                <span class="dgh-stat-label">Total</span>
                <span class="dgh-stat-val">$${fmt(totalDay)}</span>
              </div>
            </div>
          </div>
          <div class="day-group-body">
            <div class="table-wrap">
              <table class="dpt-table">
                <thead><tr>
                  <th class="dpt-hora">Hora</th>
                  <th class="dpt-venta">Venta</th>
                  <th class="dpt-prod">Producto</th>
                  <th class="dpt-cant">Cant.</th>
                  <th class="dpt-precio">Precio</th>
                  <th class="dpt-sub">Subtotal</th>
                  <th class="dpt-pago">Pago</th>
                  <th class="dpt-cajero">Cajero</th>
                </tr></thead>
                <tbody>${productRows}</tbody>
              </table>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Toggle al clickear header
    cont.querySelectorAll('.day-group-header').forEach(header => {
      header.addEventListener('click', () => {
        header.parentElement.classList.toggle('expanded');
      });
    });

    // Click en fila → abrir venta (desambigua por pc_id cuando hay colisión entre PCs)
    cont.querySelectorAll('.clickable-row').forEach(row => {
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ventaId = row.dataset.ventaid;
        const pcId    = row.dataset.pcid || '';
        if (!ventaId) return;
        const pickByPc = (docs) => {
          if (!pcId) return docs[0];
          return docs.find(d => (d.data().pc_id || '') === pcId) || docs[0];
        };
        try {
          const snap = await getDocs(query(collection(db, 'ventas'), where('sale_id', '==', parseInt(ventaId))));
          if (!snap.empty) {
            openSaleModal(pickByPc(snap.docs).data(), db);
          } else {
            const snap2 = await getDocs(query(collection(db, 'ventas'), where('sale_id', '==', ventaId)));
            if (!snap2.empty) openSaleModal(pickByPc(snap2.docs).data(), db);
          }
        } catch (err) { console.error(err); }
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

// "DD/MM/YYYY" → "abril 2026"
function mesDesdeFecha(f) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(f || '');
  if (!m) return '';
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  return `${meses[parseInt(m[2],10)-1]} ${m[3]}`;
}
