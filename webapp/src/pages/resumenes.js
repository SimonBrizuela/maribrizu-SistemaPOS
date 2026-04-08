import { collection, getDocs, query, orderBy, where } from 'firebase/firestore';
import { getCached } from '../cache.js';

export async function renderResumenes(container, db) {
  const meses = await getCached('resumenes:mensuales', async () => {
    const snap = await getDocs(query(collection(db, 'resumenes_mensuales'), orderBy('anio', 'desc')));
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => b.anio - a.anio || b.mes_num - a.mes_num);
  });

  // Totales generales
  const totalGeneral = meses.reduce((a, m) => a + (m.total || 0), 0);
  const totalVentas  = meses.reduce((a, m) => a + (m.num_ventas || 0), 0);
  const mejorMes     = meses.reduce((best, m) => (!best || m.total > best.total) ? m : best, null);

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
      <h2 style="margin:0;font-size:20px;font-weight:700;color:#1e293b">📊 Resúmenes Mensuales</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="btnExportCSV" style="background:#198754;color:white;border:none;border-radius:8px;padding:8px 18px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;font-size:13px">
          <span class="material-icons" style="font-size:16px">table_chart</span> Exportar Excel
        </button>
        <button id="btnExportPDF" style="background:#dc3545;color:white;border:none;border-radius:8px;padding:8px 18px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;font-size:13px">
          <span class="material-icons" style="font-size:16px">picture_as_pdf</span> Exportar PDF
        </button>
      </div>
    </div>

    <!-- Tarjetas resumen -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:24px">
      <div style="background:white;border-radius:12px;padding:18px;box-shadow:0 1px 4px rgba(0,0,0,0.08);border-left:4px solid #0d6efd">
        <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Total Acumulado</div>
        <div style="font-size:24px;font-weight:700;color:#1e293b;margin-top:6px">$${fmt(totalGeneral)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px">${meses.length} meses registrados</div>
      </div>
      <div style="background:white;border-radius:12px;padding:18px;box-shadow:0 1px 4px rgba(0,0,0,0.08);border-left:4px solid #198754">
        <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Total Ventas</div>
        <div style="font-size:24px;font-weight:700;color:#198754;margin-top:6px">${totalVentas.toLocaleString('es-AR')}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px">transacciones totales</div>
      </div>
      <div style="background:white;border-radius:12px;padding:18px;box-shadow:0 1px 4px rgba(0,0,0,0.08);border-left:4px solid #f59e0b">
        <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Mejor Mes</div>
        <div style="font-size:20px;font-weight:700;color:#1e293b;margin-top:6px">${mejorMes ? mejorMes.mes_nombre : '-'}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px">${mejorMes ? '$' + fmt(mejorMes.total) : '-'}</div>
      </div>
    </div>

    <!-- Tabla de meses -->
    <div class="table-card" id="printable">
      <div class="table-card-header">
        <h3>📅 Detalle por Mes</h3>
      </div>
      <div class="table-wrap">
        <table id="tablaResumenes">
          <thead><tr>
            <th>Mes</th>
            <th style="text-align:center"># Ventas</th>
            <th>Total</th>
            <th>Efectivo</th>
            <th>Transferencia</th>
            <th>Descuentos</th>
            <th>Ticket Prom.</th>
          </tr></thead>
          <tbody>
            ${meses.length === 0 ? `<tr><td colspan="7" style="text-align:center;padding:40px;color:#94a3b8">Sin datos mensuales aún. Los resúmenes se generan automáticamente al realizar ventas.</td></tr>` :
            meses.map((m, i) => `
              <tr class="mes-row" data-idx="${i}" style="cursor:pointer" title="Click para ver top productos">
                <td><b style="color:#1e293b">${capFirst(m.mes_nombre || '-')}</b></td>
                <td style="text-align:center"><span class="badge badge-blue">${m.num_ventas || 0}</span></td>
                <td><b style="color:#198754">$${fmt(m.total)}</b></td>
                <td>$${fmt(m.efectivo)}</td>
                <td>$${fmt(m.transferencia)}</td>
                <td style="color:#dc3545">${(m.descuentos_total || 0) > 0 ? '-$' + fmt(m.descuentos_total) : '-'}</td>
                <td>$${fmt(m.ticket_promedio)}</td>
              </tr>
              <tr class="mes-detail" id="detail-${i}" style="display:none">
                <td colspan="7" style="background:#f8fafc;padding:16px">
                  <b style="color:#475569">🏆 Top productos de ${capFirst(m.mes_nombre || '')}:</b>
                  <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:8px">
                    ${(m.top_productos || []).length === 0 ? '<span style="color:#94a3b8">Sin datos</span>' :
                    (m.top_productos || []).map((p, j) => `
                      <div style="background:white;border:1px solid #e2e8f0;border-radius:8px;padding:8px 14px;min-width:140px">
                        <div style="font-size:11px;color:#64748b">#${j+1}</div>
                        <div style="font-weight:600;color:#1e293b;font-size:13px">${p.producto || '-'}</div>
                        <div style="font-size:12px;color:#198754;margin-top:2px">$${fmt(p.total)} · ${p.cantidad} un.</div>
                      </div>
                    `).join('')}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Toggle detalles al hacer click en fila de mes
  container.querySelectorAll('.mes-row').forEach(row => {
    row.addEventListener('click', () => {
      const idx = row.dataset.idx;
      const detail = document.getElementById(`detail-${idx}`);
      const isOpen = detail.style.display !== 'none';
      // Cerrar todos
      container.querySelectorAll('.mes-detail').forEach(d => d.style.display = 'none');
      container.querySelectorAll('.mes-row').forEach(r => r.style.background = '');
      if (!isOpen) {
        detail.style.display = '';
        row.style.background = '#eff6ff';
      }
    });
  });

  // Exportar CSV/Excel
  document.getElementById('btnExportCSV').addEventListener('click', () => {
    const headers = ['Mes','Num Ventas','Total','Efectivo','Transferencia','Descuentos','Ticket Promedio'];
    const rows = meses.map(m => [
      m.mes_nombre || '',
      m.num_ventas || 0,
      (m.total || 0).toFixed(2),
      (m.efectivo || 0).toFixed(2),
      (m.transferencia || 0).toFixed(2),
      (m.descuentos_total || 0).toFixed(2),
      (m.ticket_promedio || 0).toFixed(2),
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `resumenes_mensuales_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Exportar PDF profesional
  document.getElementById('btnExportPDF').addEventListener('click', async () => {
    const btn = document.getElementById('btnExportPDF');
    btn.disabled = true;
    btn.innerHTML = '<span class="material-icons" style="font-size:16px;vertical-align:middle">hourglass_top</span> Generando...';

    try {
      const [ventas, ventasDia] = await Promise.all([
        getCached('ventas:lista', async () => {
          const snap = await getDocs(query(collection(db, 'ventas'), orderBy('created_at', 'desc')));
          return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        }),
        getCached('historial:ventas_dia', async () => {
          const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha', 'desc')));
          return snap.docs.map(d => d.data());
        })
      ]);

      // Agrupar items por num_venta
      const itemsPorVenta = {};
      ventasDia.forEach(v => {
        const key = String(v.num_venta);
        if (!itemsPorVenta[key]) itemsPorVenta[key] = [];
        itemsPorVenta[key].push(v);
      });

      // Agrupar ventas por mes
      const ventasPorMes = {};
      ventas.forEach(v => {
        const dt = v.created_at?.toDate ? v.created_at.toDate() : new Date(v.created_at);
        const mesKey = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
        if (!ventasPorMes[mesKey]) ventasPorMes[mesKey] = [];
        ventasPorMes[mesKey].push({ ...v, _dt: dt });
      });

      const ahora = new Date().toLocaleString('es-AR');
      const totalGeneral2 = meses.reduce((a, m) => a + (m.total || 0), 0);
      const totalVentas2  = meses.reduce((a, m) => a + (m.num_ventas || 0), 0);
      const periodoStr = meses.length > 0
        ? `${capFirst(meses[meses.length-1].mes_nombre)} ${meses[meses.length-1].anio} — ${capFirst(meses[0].mes_nombre)} ${meses[0].anio}`
        : 'Todos los períodos';

      let html = `<!DOCTYPE html><html><head>
      <meta charset="UTF-8">
      <title>Reporte de Ventas - Sistema POS</title>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Segoe UI',Arial,sans-serif; color:#1e293b; background:white; }
        .portada { page-break-after:always; min-height:100vh; display:flex; flex-direction:column; justify-content:center; align-items:center; background:linear-gradient(135deg,#1e293b 0%,#0f4c8a 100%); color:white; padding:60px 40px; text-align:center; }
        .portada .logo { font-size:64px; margin-bottom:20px; }
        .portada h1 { font-size:36px; font-weight:800; margin-bottom:8px; }
        .portada h2 { font-size:20px; font-weight:400; opacity:0.8; margin-bottom:40px; }
        .portada .divider { width:60px; height:4px; background:#3b82f6; border-radius:2px; margin:24px auto; }
        .portada .stats-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:20px; margin-top:40px; width:100%; max-width:600px; }
        .portada .stat-box { background:rgba(255,255,255,0.1); border-radius:12px; padding:20px; }
        .portada .stat-label { font-size:11px; opacity:0.7; text-transform:uppercase; letter-spacing:1px; margin-bottom:8px; }
        .portada .stat-value { font-size:22px; font-weight:700; }
        .portada .footer { margin-top:60px; font-size:12px; opacity:0.5; }
        .page { padding:30px 35px; }
        .section-title { font-size:15px; font-weight:700; color:#1e293b; border-bottom:3px solid #3b82f6; padding-bottom:8px; margin:24px 0 14px; }
        .summary-table { width:100%; border-collapse:collapse; font-size:12px; margin-bottom:8px; }
        .summary-table th { background:#1e293b; color:white; padding:10px 12px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; }
        .summary-table th:not(:first-child) { text-align:right; }
        .summary-table td { padding:9px 12px; border-bottom:1px solid #e2e8f0; }
        .summary-table td:not(:first-child) { text-align:right; }
        .summary-table tr:nth-child(even) td { background:#f8fafc; }
        .summary-table .total-row td { background:#eff6ff; font-weight:700; border-top:2px solid #3b82f6; }
        .mes-header { background:linear-gradient(90deg,#1e293b,#334155); color:white; border-radius:10px; padding:14px 20px; margin:24px 0 12px; display:flex; justify-content:space-between; align-items:center; page-break-before:always; }
        .mes-header h3 { font-size:16px; font-weight:700; }
        .mes-totales { display:flex; gap:20px; font-size:12px; opacity:0.9; }
        .mes-totales span { display:flex; flex-direction:column; align-items:flex-end; }
        .mes-totales .val { font-size:15px; font-weight:700; }
        .top-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin:10px 0 20px; }
        .top-card { background:white; border:1px solid #e2e8f0; border-radius:8px; padding:10px 14px; }
        .top-card .rank { font-size:10px; color:#94a3b8; margin-bottom:2px; }
        .top-card .nombre { font-weight:700; font-size:12px; margin-bottom:4px; }
        .top-card .datos { font-size:11px; color:#198754; }
        .ventas-table { width:100%; border-collapse:collapse; font-size:11px; margin-bottom:4px; }
        .ventas-table th { background:#475569; color:white; padding:7px 10px; text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:0.3px; }
        .ventas-table th.r { text-align:right; }
        .ventas-table td { padding:6px 10px; border-bottom:1px solid #f1f5f9; vertical-align:top; }
        .ventas-table td.r { text-align:right; }
        .ventas-table .venta-row td { background:#f8fafc; font-weight:600; }
        .ventas-table .item-row td { color:#475569; padding-left:20px; }
        .ventas-table .subtotal-row td { background:#f0fdf4; font-weight:700; color:#166534; border-top:1px solid #bbf7d0; }
        .ventas-table .total-mes td { background:#1e293b; color:white; font-weight:700; padding:10px; }
        .bv { background:#dcfce7; color:#166534; border-radius:4px; padding:1px 6px; font-size:10px; font-weight:600; }
        .bt { background:#dbeafe; color:#1e40af; border-radius:4px; padding:1px 6px; font-size:10px; font-weight:600; }
        .bc { background:#f1f5f9; color:#475569; border-radius:4px; padding:1px 6px; font-size:10px; }
        .page-footer { margin-top:24px; padding-top:10px; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between; font-size:10px; color:#94a3b8; }
        @media print { .portada { min-height:100vh; } }
      </style></head><body>`;

      // PORTADA
      html += `<div class="portada">
        <div class="logo">📊</div>
        <h1>Reporte de Ventas</h1>
        <h2>Sistema POS — Informe Completo</h2>
        <div class="divider"></div>
        <div style="font-size:14px;opacity:0.7;margin-top:8px">${periodoStr}</div>
        <div class="stats-grid">
          <div class="stat-box"><div class="stat-label">Total Recaudado</div><div class="stat-value">$${fmt(totalGeneral2)}</div></div>
          <div class="stat-box"><div class="stat-label">Ventas Realizadas</div><div class="stat-value">${totalVentas2.toLocaleString('es-AR')}</div></div>
          <div class="stat-box"><div class="stat-label">Meses Registrados</div><div class="stat-value">${meses.length}</div></div>
        </div>
        <div class="footer">Generado el ${ahora} · Sistema POS v2.0</div>
      </div>`;

      // RESUMEN POR MES
      html += `<div class="page">
        <div class="section-title">📅 Resumen por Mes</div>
        <table class="summary-table"><thead><tr>
          <th>Mes / Año</th><th># Ventas</th><th>Total</th><th>Efectivo</th><th>Transferencia</th><th>Descuentos</th><th>Ticket Prom.</th>
        </tr></thead><tbody>
        ${meses.map(m => `<tr>
          <td><b>${capFirst(m.mes_nombre||'-')} ${m.anio||''}</b></td>
          <td style="text-align:right">${m.num_ventas||0}</td>
          <td style="text-align:right"><b style="color:#198754">$${fmt(m.total)}</b></td>
          <td style="text-align:right">$${fmt(m.efectivo)}</td>
          <td style="text-align:right">$${fmt(m.transferencia)}</td>
          <td style="text-align:right;color:#dc3545">${(m.descuentos_total||0)>0?'-$'+fmt(m.descuentos_total):'-'}</td>
          <td style="text-align:right">$${fmt(m.ticket_promedio)}</td>
        </tr>`).join('')}
        <tr class="total-row">
          <td>TOTAL GENERAL</td>
          <td style="text-align:right">${totalVentas2}</td>
          <td style="text-align:right;color:#198754">$${fmt(totalGeneral2)}</td>
          <td style="text-align:right">$${fmt(meses.reduce((a,m)=>a+(m.efectivo||0),0))}</td>
          <td style="text-align:right">$${fmt(meses.reduce((a,m)=>a+(m.transferencia||0),0))}</td>
          <td style="text-align:right;color:#dc3545">-$${fmt(meses.reduce((a,m)=>a+(m.descuentos_total||0),0))}</td>
          <td style="text-align:right">$${fmt(totalGeneral2/(totalVentas2||1))}</td>
        </tr></tbody></table>
        <div class="page-footer"><span>Sistema POS — Reporte de Ventas</span><span>Generado: ${ahora}</span></div>
      </div>`;

      // DETALLE POR MES
      for (const mes of meses) {
        const mesKey = `${mes.anio}-${String(mes.mes_num).padStart(2,'0')}`;
        const ventasDelMes = (ventasPorMes[mesKey] || []).sort((a,b) => a._dt - b._dt);

        html += `<div class="page">
          <div class="mes-header">
            <h3>📅 ${capFirst(mes.mes_nombre||'-')} ${mes.anio||''}</h3>
            <div class="mes-totales">
              <span><small>Total</small><span class="val">$${fmt(mes.total)}</span></span>
              <span><small>Ventas</small><span class="val">${mes.num_ventas||0}</span></span>
              <span><small>Ticket Prom.</small><span class="val">$${fmt(mes.ticket_promedio)}</span></span>
            </div>
          </div>`;

        if ((mes.top_productos||[]).length > 0) {
          html += `<div class="section-title" style="font-size:13px;margin-top:16px">🏆 Top Productos</div>
          <div class="top-grid">${mes.top_productos.slice(0,6).map((p,j) => `
            <div class="top-card">
              <div class="rank">#${j+1}</div>
              <div class="nombre">${p.producto||'-'}</div>
              <div class="datos">$${fmt(p.total)} · ${p.cantidad} unidades</div>
            </div>`).join('')}</div>`;
        }

        html += `<div class="section-title" style="font-size:13px">🧾 Detalle de Ventas</div>`;

        if (!ventasDelMes.length) {
          html += `<p style="color:#94a3b8;font-size:12px;padding:12px 0">Sin ventas registradas.</p>`;
        } else {
          html += `<table class="ventas-table"><thead><tr>
            <th># Vta</th><th>Fecha</th><th>Hora</th><th>Producto</th><th>Categoría</th>
            <th class="r">Cant.</th><th class="r">P.Unit.</th><th class="r">Subtotal</th><th>Pago</th><th>Cajero</th>
          </tr></thead><tbody>`;

          for (const v of ventasDelMes) {
            const saleId = v.sale_id || v.id;
            const items  = itemsPorVenta[String(saleId)] || [];
            const dt     = v._dt;
            const fecha  = dt.toLocaleDateString('es-AR');
            const hora   = dt.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});
            const pago   = v.payment_type === 'cash' ? 'Efectivo' : 'Transf.';
            const badgePago = v.payment_type === 'cash' ? 'bv' : 'bt';
            const cajero = v.cajero || v.username || '-';

            if (items.length > 0) {
              items.forEach((item, idx) => {
                html += `<tr class="${idx===0?'venta-row':'item-row'}">
                  <td>${idx===0?`<b>#${saleId}</b>`:''}</td>
                  <td>${idx===0?fecha:''}</td>
                  <td>${idx===0?hora:''}</td>
                  <td>${item.producto||item.product_name||'-'}</td>
                  <td><span class="bc">${item.categoria||'-'}</span></td>
                  <td class="r">${item.cantidad||1}</td>
                  <td class="r">$${fmt(item.precio_unitario||item.unit_price)}</td>
                  <td class="r">$${fmt(item.subtotal)}</td>
                  <td>${idx===0?`<span class="${badgePago}">${pago}</span>`:''}</td>
                  <td>${idx===0?cajero:''}</td>
                </tr>`;
              });
              html += `<tr class="subtotal-row">
                <td colspan="7" style="text-align:right">Total venta #${saleId}</td>
                <td class="r">$${fmt(v.total_amount)}</td><td colspan="2"></td>
              </tr>`;
            } else {
              html += `<tr class="venta-row">
                <td><b>#${saleId}</b></td><td>${fecha}</td><td>${hora}</td>
                <td colspan="4" style="color:#94a3b8;font-style:italic">Sin detalle</td>
                <td class="r">$${fmt(v.total_amount)}</td>
                <td><span class="${badgePago}">${pago}</span></td><td>${cajero}</td>
              </tr>`;
            }
          }

          html += `<tr class="total-mes">
            <td colspan="7" style="text-align:right">TOTAL ${(mes.mes_nombre||'').toUpperCase()} ${mes.anio||''}</td>
            <td style="text-align:right">$${fmt(mes.total)}</td><td colspan="2"></td>
          </tr></tbody></table>`;
        }

        html += `<div class="page-footer">
          <span>Sistema POS — ${capFirst(mes.mes_nombre||'')} ${mes.anio||''}</span>
          <span>Generado: ${ahora}</span>
        </div></div>`;
      }

      html += `</body></html>`;

      const win = window.open('', '_blank');
      win.document.write(html);
      win.document.close();
      win.addEventListener('load', () => setTimeout(() => win.print(), 500));

    } catch(e) {
      alert('Error generando PDF: ' + e.message);
      console.error(e);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-icons" style="font-size:16px">picture_as_pdf</span> Exportar PDF';
    }
  });
}

function fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function capFirst(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}
