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
        const dt = parseArDate(v.created_at);
        const arStr = dt.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
        const mesKey = arStr.slice(0, 7); // "YYYY-MM"
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
      <title>Informe de Ventas</title>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Segoe UI',Arial,sans-serif; color:#222; background:white; font-size:12px; }

        /* PORTADA */
        .portada { page-break-after:always; padding:80px 60px; display:flex; flex-direction:column; height:100vh; }
        .portada .top-bar { width:100%; height:6px; background:#1a3a5c; margin-bottom:60px; }
        .portada .empresa { font-size:13px; color:#555; letter-spacing:1px; text-transform:uppercase; margin-bottom:6px; }
        .portada h1 { font-size:32px; font-weight:700; color:#1a3a5c; margin-bottom:4px; letter-spacing:-0.5px; }
        .portada .subtitulo { font-size:14px; color:#666; margin-bottom:50px; }
        .portada .info-bloque { border-left:4px solid #1a3a5c; padding-left:20px; margin-bottom:40px; }
        .portada .info-bloque p { font-size:13px; color:#444; margin-bottom:6px; }
        .portada .info-bloque p b { color:#1a3a5c; }
        .portada .resumen-tabla { width:100%; border-collapse:collapse; margin-top:20px; }
        .portada .resumen-tabla td { padding:12px 16px; border:1px solid #dde3eb; font-size:13px; }
        .portada .resumen-tabla td:first-child { color:#555; width:50%; }
        .portada .resumen-tabla td:last-child { font-weight:700; color:#1a3a5c; font-size:15px; }
        .portada .resumen-tabla tr:nth-child(odd) td { background:#f7f9fb; }
        .portada .bottom { margin-top:auto; font-size:10px; color:#aaa; border-top:1px solid #e0e0e0; padding-top:14px; display:flex; justify-content:space-between; }

        /* PÁGINAS */
        .page { padding:28px 35px; }
        .page-header { display:flex; justify-content:space-between; align-items:flex-end; border-bottom:2px solid #1a3a5c; padding-bottom:10px; margin-bottom:20px; }
        .page-header .titulo { font-size:16px; font-weight:700; color:#1a3a5c; }
        .page-header .meta { font-size:10px; color:#888; text-align:right; }

        .section-label { font-size:10px; font-weight:700; color:#1a3a5c; text-transform:uppercase; letter-spacing:1px; margin:20px 0 8px; border-bottom:1px solid #dde3eb; padding-bottom:4px; }

        /* TABLA RESUMEN */
        .t { width:100%; border-collapse:collapse; font-size:11px; }
        .t th { background:#1a3a5c; color:white; padding:8px 10px; text-align:left; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.4px; }
        .t th.r { text-align:right; }
        .t td { padding:8px 10px; border-bottom:1px solid #eaecef; }
        .t td.r { text-align:right; }
        .t tr:nth-child(even) td { background:#f7f9fb; }
        .t .tot td { background:#e8eef5; font-weight:700; border-top:1px solid #b0bec5; }

        /* MES ENCABEZADO */
        .mes-hdr { page-break-before:always; margin-bottom:16px; padding:14px 18px; background:#f7f9fb; border-left:5px solid #1a3a5c; display:flex; justify-content:space-between; align-items:center; }
        .mes-hdr .mes-nombre { font-size:15px; font-weight:700; color:#1a3a5c; }
        .mes-hdr .mes-stats { display:flex; gap:28px; }
        .mes-hdr .mes-stats div { text-align:right; }
        .mes-hdr .mes-stats .lbl { font-size:9px; color:#888; text-transform:uppercase; letter-spacing:0.5px; }
        .mes-hdr .mes-stats .val { font-size:13px; font-weight:700; color:#1a3a5c; }

        /* TOP PRODUCTOS */
        .top-tabla { width:100%; border-collapse:collapse; font-size:11px; margin-bottom:16px; }
        .top-tabla th { background:#3d5a80; color:white; padding:6px 10px; text-align:left; font-size:10px; }
        .top-tabla th.r { text-align:right; }
        .top-tabla td { padding:6px 10px; border-bottom:1px solid #eaecef; }
        .top-tabla td.r { text-align:right; }
        .top-tabla tr:nth-child(even) td { background:#f7f9fb; }

        /* TABLA VENTAS */
        .vt { width:100%; border-collapse:collapse; font-size:10.5px; }
        .vt th { background:#3d5a80; color:white; padding:6px 9px; text-align:left; font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:0.3px; }
        .vt th.r { text-align:right; }
        .vt td { padding:5px 9px; border-bottom:1px solid #f0f0f0; vertical-align:top; }
        .vt td.r { text-align:right; }
        .vt .vr td { background:#eef2f7; font-weight:600; color:#1a3a5c; border-top:1px solid #d0d8e4; }
        .vt .ir td { color:#555; padding-left:22px; font-size:10px; }
        .vt .sr td { background:#f0f7f0; font-weight:700; color:#2d6a4f; font-size:10px; border-top:1px dashed #b7d7c2; }
        .vt .tmr td { background:#1a3a5c; color:white; font-weight:700; font-size:11px; padding:8px 9px; }
        .ef { color:#2d6a4f; font-weight:600; }
        .tr2 { color:#1a3a5c; font-weight:600; }

        .page-footer { margin-top:20px; padding-top:8px; border-top:1px solid #e0e0e0; display:flex; justify-content:space-between; font-size:9px; color:#aaa; }
        @media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
      </style></head><body>`;

      // PORTADA
      html += `<div class="portada">
        <div class="top-bar"></div>
        <div class="empresa">Sistema de Punto de Venta</div>
        <h1>Informe de Ventas</h1>
        <div class="subtitulo">Reporte consolidado por período</div>
        <div class="info-bloque">
          <p><b>Período:</b> ${periodoStr}</p>
          <p><b>Fecha de emisión:</b> ${ahora}</p>
          <p><b>Meses incluidos:</b> ${meses.length}</p>
        </div>
        <table class="resumen-tabla">
          <tr><td>Total recaudado</td><td>$${fmt(totalGeneral2)}</td></tr>
          <tr><td>Total de ventas realizadas</td><td>${totalVentas2.toLocaleString('es-AR')}</td></tr>
          <tr><td>Ticket promedio general</td><td>$${fmt(totalGeneral2/(totalVentas2||1))}</td></tr>
          <tr><td>Total cobrado en efectivo</td><td>$${fmt(meses.reduce((a,m)=>a+(m.efectivo||0),0))}</td></tr>
          <tr><td>Total cobrado por transferencia</td><td>$${fmt(meses.reduce((a,m)=>a+(m.transferencia||0),0))}</td></tr>
        </table>
        <div class="bottom">
          <span>Documento generado automáticamente — uso interno</span>
          <span>${ahora}</span>
        </div>
      </div>`;

      // RESUMEN POR MES
      html += `<div class="page">
        <div class="page-header">
          <div class="titulo">Resumen por Mes</div>
          <div class="meta">Período: ${periodoStr}<br>Emitido: ${ahora}</div>
        </div>
        <table class="t"><thead><tr>
          <th>Mes</th><th>Año</th><th class="r"># Ventas</th><th class="r">Total</th><th class="r">Efectivo</th><th class="r">Transferencia</th><th class="r">Descuentos</th><th class="r">Ticket Prom.</th>
        </tr></thead><tbody>
        ${meses.map(m => `<tr>
          <td><b>${capFirst(m.mes_nombre||'-')}</b></td>
          <td>${m.anio||''}</td>
          <td class="r">${m.num_ventas||0}</td>
          <td class="r"><b>$${fmt(m.total)}</b></td>
          <td class="r">$${fmt(m.efectivo)}</td>
          <td class="r">$${fmt(m.transferencia)}</td>
          <td class="r">${(m.descuentos_total||0)>0?'-$'+fmt(m.descuentos_total):'-'}</td>
          <td class="r">$${fmt(m.ticket_promedio)}</td>
        </tr>`).join('')}
        <tr class="tot">
          <td colspan="2"><b>TOTAL GENERAL</b></td>
          <td class="r"><b>${totalVentas2}</b></td>
          <td class="r"><b>$${fmt(totalGeneral2)}</b></td>
          <td class="r">$${fmt(meses.reduce((a,m)=>a+(m.efectivo||0),0))}</td>
          <td class="r">$${fmt(meses.reduce((a,m)=>a+(m.transferencia||0),0))}</td>
          <td class="r">-$${fmt(meses.reduce((a,m)=>a+(m.descuentos_total||0),0))}</td>
          <td class="r">$${fmt(totalGeneral2/(totalVentas2||1))}</td>
        </tr></tbody></table>
        <div class="page-footer"><span>Informe de Ventas — uso interno</span><span>${ahora}</span></div>
      </div>`;

      // DETALLE POR MES
      for (const mes of meses) {
        const mesKey = `${mes.anio}-${String(mes.mes_num).padStart(2,'0')}`;
        const ventasDelMes = (ventasPorMes[mesKey] || []).sort((a,b) => a._dt - b._dt);

        html += `<div class="page">
          <div class="page-header">
            <div class="titulo">${capFirst(mes.mes_nombre||'-')} ${mes.anio||''}</div>
            <div class="meta">
              Total: <b>$${fmt(mes.total)}</b> &nbsp;|&nbsp;
              Ventas: <b>${mes.num_ventas||0}</b> &nbsp;|&nbsp;
              Ticket prom.: <b>$${fmt(mes.ticket_promedio)}</b>
            </div>
          </div>`;

        if ((mes.top_productos||[]).length > 0) {
          html += `<div class="section-label">Productos más vendidos</div>
          <table class="top-tabla"><thead><tr>
            <th>#</th><th>Producto</th><th class="r">Unidades</th><th class="r">Total</th>
          </tr></thead><tbody>
          ${mes.top_productos.slice(0,6).map((p,j) => `<tr>
            <td>${j+1}</td>
            <td>${p.producto||'-'}</td>
            <td class="r">${p.cantidad}</td>
            <td class="r">$${fmt(p.total)}</td>
          </tr>`).join('')}
          </tbody></table>`;
        }

        html += `<div class="section-label">Detalle de ventas</div>`;

        if (!ventasDelMes.length) {
          html += `<p style="color:#aaa;font-size:11px;padding:10px 0">Sin ventas registradas para este período.</p>`;
        } else {
          html += `<table class="vt"><thead><tr>
            <th># Vta</th><th>Fecha</th><th>Hora</th><th>Producto</th><th>Categoría</th>
            <th class="r">Cant.</th><th class="r">P. Unit.</th><th class="r">Subtotal</th><th>Pago</th><th>Cajero</th>
          </tr></thead><tbody>`;

          for (const v of ventasDelMes) {
            const saleId = v.sale_id || v.id;
            const items  = itemsPorVenta[String(saleId)] || [];
            const dt     = v._dt;
            const fecha  = dt.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
            const hora   = dt.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
            const esCash = v.payment_type === 'cash';
            const pago   = esCash ? 'Efectivo' : 'Transferencia';
            const cajero = v.cajero || v.username || '-';

            if (items.length > 0) {
              items.forEach((item, idx) => {
                html += `<tr class="${idx===0?'vr':'ir'}">
                  <td>${idx===0?`#${saleId}`:''}</td>
                  <td>${idx===0?fecha:''}</td>
                  <td>${idx===0?hora:''}</td>
                  <td>${item.producto||item.product_name||'-'}</td>
                  <td>${item.categoria||'-'}</td>
                  <td class="r">${item.cantidad||1}</td>
                  <td class="r">$${fmt(item.precio_unitario||item.unit_price)}</td>
                  <td class="r">$${fmt(item.subtotal)}</td>
                  <td>${idx===0?`<span class="${esCash?'ef':'tr2'}">${pago}</span>`:''}</td>
                  <td>${idx===0?cajero:''}</td>
                </tr>`;
              });
              html += `<tr class="sr">
                <td colspan="7" class="r">Subtotal venta #${saleId}</td>
                <td class="r">$${fmt(v.total_amount)}</td><td colspan="2"></td>
              </tr>`;
            } else {
              html += `<tr class="vr">
                <td>#${saleId}</td><td>${fecha}</td><td>${hora}</td>
                <td colspan="4" style="color:#aaa;font-style:italic;font-weight:400">Sin detalle de productos</td>
                <td class="r">$${fmt(v.total_amount)}</td>
                <td><span class="${esCash?'ef':'tr2'}">${pago}</span></td><td>${cajero}</td>
              </tr>`;
            }
          }

          html += `<tr class="tmr">
            <td colspan="7" class="r">TOTAL ${(mes.mes_nombre||'').toUpperCase()} ${mes.anio||''}</td>
            <td class="r">$${fmt(mes.total)}</td><td colspan="2"></td>
          </tr></tbody></table>`;
        }

        html += `<div class="page-footer">
          <span>Informe de Ventas — ${capFirst(mes.mes_nombre||'')} ${mes.anio||''}</span>
          <span>${ahora}</span>
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

// Compensar: created_at fue guardado como naive hora AR → Firestore lo trata como UTC → sumar 3h
// Maneja: Timestamp live (.toDate), Timestamp de localStorage ({ seconds, nanoseconds }), ISO string
function parseArDate(raw) {
  if (!raw) return new Date(NaN);
  if (typeof raw.toDate === 'function') return new Date(raw.toDate().getTime() + 3 * 60 * 60 * 1000);
  if (typeof raw === 'object' && raw.seconds !== undefined)
    return new Date(raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6) + 3 * 60 * 60 * 1000);
  return new Date(raw);
}

function fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function capFirst(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}
