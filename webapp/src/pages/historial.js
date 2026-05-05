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

  // Agregar "Resumen por Día" desde ventasDia.
  // Ordenamos por fecha real (YMD) desc — Firestore viene ordenado por string DD/MM/YYYY,
  // que rompe en el cambio de mes ("30/04" > "02/05" alfabéticamente).
  const resumenMap = {};
  for (const v of ventasDia) {
    const f = v.fecha || 'Sin fecha';
    if (!(f in resumenMap)) {
      resumenMap[f] = { fecha: f, total: 0, efectivo: 0, transferencia: 0, _ventas: new Set() };
    }
    const r = resumenMap[f];
    const sub = Number(v.subtotal || 0);
    r.total += sub;
    if ((v.tipo_pago || '') === 'Transferencia') r.transferencia += sub;
    else r.efectivo += sub;
    r._ventas.add(`${v._pc_id || ''}|${v.num_venta}`);
  }
  const historial = Object.values(resumenMap)
    .sort((a, b) => ymdFromDMY(b.fecha).localeCompare(ymdFromDMY(a.fecha)))
    .map(r => {
      const n = r._ventas.size;
      return {
        fecha: r.fecha,
        mes: mesDesdeFecha(r.fecha),
        num_ventas: n,
        total: r.total,
        efectivo: r.efectivo,
        transferencia: r.transferencia,
        ticket_promedio: n > 0 ? r.total / n : 0,
      };
    });

  // Agrupar por mes (YYYY-MM). Mes más reciente expandido, anteriores colapsados.
  const resumenMeses = [];
  const idxResumenByMes = {};
  for (const h of historial) {
    const k = mesAnioKey(h.fecha);
    if (!(k in idxResumenByMes)) {
      idxResumenByMes[k] = resumenMeses.length;
      resumenMeses.push({ key: k, label: mesAnioLabel(k), rows: [] });
    }
    resumenMeses[idxResumenByMes[k]].rows.push(h);
  }

  const resumenRowsHTML = (rows) => rows.map(h => `<tr>
    <td>
      <div style="font-weight:600">${h.fecha || '-'}</div>
      <div style="font-size:11px;color:var(--text-muted);text-transform:capitalize">${h.mes || ''}</div>
    </td>
    <td style="text-align:center"><b>${h.num_ventas || 0}</b></td>
    <td style="text-align:right"><b style="color:var(--success);font-size:14px">$${fmt(h.total)}</b></td>
    <td class="hist-col-efectivo" style="text-align:right;color:#2e7d32">$${fmt(h.efectivo)}</td>
    <td class="hist-col-transferencia" style="text-align:right;color:#1565c0">$${fmt(h.transferencia)}</td>
    <td class="hist-col-ticket" style="text-align:right;color:var(--text-muted)">$${fmt(h.ticket_promedio)}</td>
  </tr>`).join('');

  const resumenTableHTML = (rows) => `
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
        <tbody>${resumenRowsHTML(rows)}</tbody>
      </table>
    </div>`;

  // Totales por mes (para mostrar en el header colapsado)
  const totalMes = (rows) => rows.reduce((acc, h) => {
    acc.total += h.total; acc.efectivo += h.efectivo; acc.transferencia += h.transferencia;
    acc.num_ventas += h.num_ventas;
    return acc;
  }, { total: 0, efectivo: 0, transferencia: 0, num_ventas: 0 });

  const resumenMesesHTML = resumenMeses.map((mg, i) => {
    const t = totalMes(mg.rows);
    const expanded = i === 0 ? ' expanded' : '';
    return `
      <div class="month-group${expanded}" data-mg="resumen">
        <div class="month-group-header">
          <div class="mgh-left">
            <span class="material-icons mgh-caret">chevron_right</span>
            <div>
              <div class="mgh-title">${mg.label}</div>
              <div class="mgh-meta">${mg.rows.length} ${mg.rows.length === 1 ? 'día' : 'días'} · ${t.num_ventas} ${t.num_ventas === 1 ? 'venta' : 'ventas'}</div>
            </div>
          </div>
          <div class="mgh-stats">
            <div class="mgh-stat efectivo"><span class="mgh-stat-label">Efectivo</span><span class="mgh-stat-val">$${fmt(t.efectivo)}</span></div>
            <div class="mgh-stat transf"><span class="mgh-stat-label">Transferencia</span><span class="mgh-stat-val">$${fmt(t.transferencia)}</span></div>
            <div class="mgh-stat total"><span class="mgh-stat-label">Total</span><span class="mgh-stat-val">$${fmt(t.total)}</span></div>
          </div>
        </div>
        <div class="month-group-body">${resumenTableHTML(mg.rows)}</div>
      </div>`;
  }).join('') || `<div style="text-align:center;padding:40px;color:var(--text-muted)">Sin datos</div>`;

  container.innerHTML = `
    <!-- Resumen por Día -->
    <div class="table-card" style="margin-bottom:24px">
      <div class="table-card-header">
        <h3>Resumen por Día</h3>
        <span style="font-size:12px;color:var(--text-muted)">${historial.length} ${historial.length === 1 ? 'día' : 'días'}</span>
      </div>
      <div class="month-groups">${resumenMesesHTML}</div>
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

  // Estructura armada en el último renderVentasDia (compartida entre helpers de lazy render).
  let _meses = [];

  function renderVentasDia(data) {
    const cont = document.getElementById('ventasDiaContainer');
    if (!data.length) {
      _meses = [];
      cont.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">Sin datos para mostrar</div>`;
      return;
    }

    // Agrupar por fecha. Firestore viene ordenado por string DD/MM/YYYY que rompe en
    // cambio de mes ("30/04" > "02/05"), así que reordenamos por YMD desc.
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
    groups.sort((a, b) => ymdFromDMY(b.fecha).localeCompare(ymdFromDMY(a.fecha)));

    // Dentro de cada día: ordenar por (# global asc, hora asc, producto).
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

    // Pre-computar totales (rápido, evita rehacerlo en cada render lazy)
    for (const g of groups) {
      g._totalDay      = g.rows.reduce((s, r) => s + Number(r.subtotal || 0), 0);
      g._totalQty      = g.rows.reduce((s, r) => s + Number(r.cantidad || 0), 0);
      g._efectivoMonto = g.rows.filter(r => (r.tipo_pago || '') !== 'Transferencia').reduce((s, r) => s + Number(r.subtotal || 0), 0);
      g._transfMonto   = g.rows.filter(r => (r.tipo_pago || '') === 'Transferencia').reduce((s, r) => s + Number(r.subtotal || 0), 0);
      g._numVentas     = new Set(g.rows.map(r => `${r._pc_id || ''}|${r.num_venta}`)).size;
    }

    // Agrupar por mes
    const meses = [];
    const idxByMes = {};
    for (const g of groups) {
      const k = mesAnioKey(g.fecha);
      if (!(k in idxByMes)) {
        idxByMes[k] = meses.length;
        meses.push({ key: k, label: mesAnioLabel(k), days: [] });
      }
      meses[idxByMes[k]].days.push(g);
    }
    _meses = meses;

    cont.innerHTML = meses.map((m, mIdx) => {
      const allRows = m.days.flatMap(d => d.rows);
      const totalMes    = allRows.reduce((s, r) => s + Number(r.subtotal || 0), 0);
      const efectivoMes = allRows.filter(r => (r.tipo_pago || '') !== 'Transferencia').reduce((s, r) => s + Number(r.subtotal || 0), 0);
      const transfMes   = allRows.filter(r => (r.tipo_pago || '') === 'Transferencia').reduce((s, r) => s + Number(r.subtotal || 0), 0);
      const ventasMes   = new Set(allRows.map(r => `${r._pc_id || ''}|${r.num_venta}|${r.fecha}`)).size;
      const isFirstMonth = mIdx === 0;
      // Mes más reciente: render headers de todos los días + body de la primera tabla.
      // Resto de meses: body vacío, se renderiza al expandir.
      const bodyHTML = isFirstMonth
        ? m.days.map((g, dIdx) => dayGroupHTML(g, mIdx, dIdx, dIdx === 0)).join('')
        : '';
      const needsRender = isFirstMonth ? '0' : '1';
      return `
        <div class="month-group${isFirstMonth ? ' expanded' : ''}" data-mg="detalle" data-mes-idx="${mIdx}" data-needs-render="${needsRender}">
          <div class="month-group-header">
            <div class="mgh-left">
              <span class="material-icons mgh-caret">chevron_right</span>
              <div>
                <div class="mgh-title">${m.label}</div>
                <div class="mgh-meta">${m.days.length} ${m.days.length === 1 ? 'día' : 'días'} · ${ventasMes} ${ventasMes === 1 ? 'venta' : 'ventas'}</div>
              </div>
            </div>
            <div class="mgh-stats">
              <div class="mgh-stat efectivo"><span class="mgh-stat-label">Efectivo</span><span class="mgh-stat-val">$${fmt(efectivoMes)}</span></div>
              <div class="mgh-stat transf"><span class="mgh-stat-label">Transferencia</span><span class="mgh-stat-val">$${fmt(transfMes)}</span></div>
              <div class="mgh-stat total"><span class="mgh-stat-label">Total</span><span class="mgh-stat-val">$${fmt(totalMes)}</span></div>
            </div>
          </div>
          <div class="month-group-body">${bodyHTML}</div>
        </div>
      `;
    }).join('');
  }

  // ── HTML helpers para render lazy ──
  // Header del día (totales pre-computados → barato)
  function dayHeaderHTML(g) {
    return `
      <div class="day-group-header">
        <div class="dgh-left">
          <span class="material-icons dgh-caret">chevron_right</span>
          <div>
            <div class="dgh-date">${g.fecha}</div>
            <div class="dgh-meta">${g._numVentas} ${g._numVentas === 1 ? 'venta' : 'ventas'} · ${g.rows.length} productos · ${g._totalQty} ${g._totalQty === 1 ? 'unidad' : 'unidades'}</div>
          </div>
        </div>
        <div class="dgh-stats">
          <div class="dgh-stat efectivo"><span class="dgh-stat-label">Efectivo</span><span class="dgh-stat-val">$${fmt(g._efectivoMonto)}</span></div>
          <div class="dgh-stat transf"><span class="dgh-stat-label">Transferencia</span><span class="dgh-stat-val">$${fmt(g._transfMonto)}</span></div>
          <div class="dgh-stat total"><span class="dgh-stat-label">Total</span><span class="dgh-stat-val">$${fmt(g._totalDay)}</span></div>
        </div>
      </div>
    `;
  }

  // Tabla con todas las filas del día (parte cara → solo se arma cuando se expande)
  function dayBodyTableHTML(g) {
    const productRows = g.rows.map(v => {
      const esTransf  = (v.tipo_pago || '') === 'Transferencia';
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
    `;
  }

  function dayGroupHTML(g, mIdx, dIdx, expanded) {
    return `
      <div class="day-group${expanded ? ' expanded' : ''}" data-day-key="${mIdx}_${dIdx}" data-needs-render="${expanded ? '0' : '1'}">
        ${dayHeaderHTML(g)}
        <div class="day-group-body">${expanded ? dayBodyTableHTML(g) : ''}</div>
      </div>
    `;
  }

  // Expande un día renderizando su tabla on-demand
  function ensureDayBody(dg) {
    if (dg.dataset.needsRender !== '1') return;
    const [mIdx, dIdx] = dg.dataset.dayKey.split('_').map(Number);
    const g = _meses[mIdx]?.days[dIdx];
    if (!g) return;
    dg.querySelector('.day-group-body').innerHTML = dayBodyTableHTML(g);
    dg.dataset.needsRender = '0';
  }

  // Expande un mes renderizando todos sus días (solo headers, sin tablas) on-demand
  function ensureMonthBody(mg) {
    if (mg.dataset.needsRender !== '1') return;
    const mIdx = parseInt(mg.dataset.mesIdx);
    const m = _meses[mIdx];
    if (!m) return;
    mg.querySelector('.month-group-body').innerHTML =
      m.days.map((g, dIdx) => dayGroupHTML(g, mIdx, dIdx, false)).join('');
    mg.dataset.needsRender = '0';
  }

  // ── Event delegation: día + click en fila ──
  // Toggle de día: lazy-render del body al expandir, stopPropagation para no togglear el mes padre.
  // Click en fila: abre la venta (desambigua por pc_id cuando hay colisión entre PCs).
  const ventasDiaContainer = document.getElementById('ventasDiaContainer');
  ventasDiaContainer.addEventListener('click', async (e) => {
    const row = e.target.closest('.clickable-row');
    if (row) {
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
      return;
    }

    const dayHeader = e.target.closest('.day-group-header');
    if (dayHeader && ventasDiaContainer.contains(dayHeader)) {
      e.stopPropagation();
      const dg = dayHeader.parentElement;
      if (!dg.classList.contains('expanded')) ensureDayBody(dg);
      dg.classList.toggle('expanded');
    }
  });

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

  // Toggle de meses — aplica tanto al Resumen como al Detalle.
  // En el Detalle, el body de meses no-iniciales se renderiza on-demand al expandir.
  container.addEventListener('click', (e) => {
    const header = e.target.closest('.month-group-header');
    if (!header || !container.contains(header)) return;
    const mg = header.parentElement;
    if (mg.dataset.mg === 'detalle' && !mg.classList.contains('expanded')) {
      ensureMonthBody(mg);
    }
    mg.classList.toggle('expanded');
  });

  renderVentasDia(ventasDia);
}

function fmt(n) { return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

const MESES_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

// "DD/MM/YYYY" → "abril 2026"
function mesDesdeFecha(f) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(f || '');
  if (!m) return '';
  return `${MESES_ES[parseInt(m[2],10)-1]} ${m[3]}`;
}

// "DD/MM/YYYY" → "YYYY-MM-DD" (para sort cronológico real)
function ymdFromDMY(f) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(f || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

// "DD/MM/YYYY" → "YYYY-MM" (clave de mes para agrupar)
function mesAnioKey(f) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(f || '');
  return m ? `${m[3]}-${m[2]}` : '0000-00';
}

// "YYYY-MM" → "Abril 2026" (label capitalizado)
function mesAnioLabel(key) {
  const [y, mo] = (key || '').split('-');
  const idx = parseInt(mo, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx > 11) return key || '';
  const nombre = MESES_ES[idx];
  return `${nombre.charAt(0).toUpperCase()}${nombre.slice(1)} ${y}`;
}
