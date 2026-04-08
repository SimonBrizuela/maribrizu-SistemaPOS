import { collection, getDocs, query, orderBy } from 'firebase/firestore';

export async function renderResumenes(container, db) {
  const snap = await getDocs(
    query(collection(db, 'resumenes_mensuales'), orderBy('anio', 'desc'))
  );
  // Ordenar también por mes_num en el cliente para evitar índice compuesto
  const meses = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => b.anio - a.anio || b.mes_num - a.mes_num);

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

  // Exportar PDF (print)
  document.getElementById('btnExportPDF').addEventListener('click', () => {
    const printContent = document.getElementById('printable').innerHTML;
    const win = window.open('', '_blank');
    win.document.write(`
      <!DOCTYPE html><html><head>
      <meta charset="UTF-8">
      <title>Resúmenes Mensuales - POS</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; color: #1e293b; }
        h2 { color: #1e293b; margin-bottom: 16px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th { background: #1e293b; color: white; padding: 10px 12px; text-align: left; font-size: 12px; }
        td { padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 12px; }
        tr:nth-child(even) { background: #f8fafc; }
        .mes-detail { display: none !important; }
        @media print { button { display: none; } }
      </style>
      </head><body>
      <h2>📊 Resúmenes Mensuales</h2>
      <p style="color:#64748b;font-size:12px">Generado: ${new Date().toLocaleString('es-AR')}</p>
      ${printContent}
      </body></html>
    `);
    win.document.close();
    win.print();
  });
}

function fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function capFirst(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}
