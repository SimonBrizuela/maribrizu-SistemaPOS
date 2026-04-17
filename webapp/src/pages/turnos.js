import { collection, getDocs, query, orderBy, limit, where } from 'firebase/firestore';
import { openSaleModal } from '../components/modal.js';

/**
 * Página: Resumen por Turno / Cajero
 * Muestra cuánto vendió cada cajero hoy y en períodos seleccionables.
 * Datos: colección 'ventas' con campo 'cajero' (o 'username').
 */
export async function renderTurnos(container, db) {
  container.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-muted)">
    <div class="spinner"></div><p>Cargando datos de turnos...</p>
  </div>`;

  // Cargar ventas (últimas 1000 para cubrir varios días)
  const snap = await getDocs(
    query(collection(db, 'ventas'), orderBy('created_at', 'desc'), limit(1000))
  );
  const ventas = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Rango de fechas por defecto: hoy en hora Argentina
  const hoy = new Date(todayAR() + 'T00:00:00-03:00');

  container.innerHTML = `
    <div class="filter-bar" style="margin-bottom:16px;flex-wrap:wrap;gap:8px">
      <label style="font-weight:600;color:var(--text-muted);font-size:13px">Período:</label>
      <input type="date" id="filtroDesde" />
      <input type="date" id="filtroHasta" />
      <button id="btnHoy"    class="btn-period active" data-period="hoy">Hoy</button>
      <button id="btnSemana" class="btn-period"        data-period="semana">Esta semana</button>
      <button id="btnMes"    class="btn-period"        data-period="mes">Este mes</button>
    </div>

    <!-- Cards resumen por cajero -->
    <div id="cajeroCards" class="cards-grid" style="margin-bottom:24px"></div>

    <!-- Gráfico de barras por cajero -->
    <div class="chart-card" style="margin-bottom:24px">
      <h3>📊 Comparativo por Cajero</h3>
      <div class="bar-chart" id="cajeroBars"></div>
    </div>

    <!-- Tabla detallada -->
    <div class="table-card">
      <div class="table-card-header">
        <h3>🧾 Ventas por Cajero — Detalle</h3>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" id="filtroCajeroNombre" placeholder="Filtrar cajero..." style="width:160px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px" />
          <span id="ventasCount" style="color:var(--text-muted);font-size:13px"></span>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Cajero / Turno</th>
            <th style="text-align:center"># Ventas</th>
            <th>Total</th>
            <th>Efectivo</th>
            <th>Transferencia</th>
            <th>Ticket Promedio</th>
            <th>% del Total</th>
          </tr></thead>
          <tbody id="turnosBody"></tbody>
        </table>
      </div>
    </div>

    <!-- Ventas individuales del cajero seleccionado -->
    <div id="cajeroDetalle" style="display:none;margin-top:24px">
      <div class="table-card">
        <div class="table-card-header">
          <h3 id="cajeroDetalleTitle">Ventas de...</h3>
          <button id="cerrarDetalle" style="background:none;border:1px solid var(--border);border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px;color:var(--text-muted)">✕ Cerrar</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>#</th><th>Fecha</th><th>Hora</th><th>Productos</th>
              <th>Items</th><th>Total</th><th>Tipo Pago</th>
            </tr></thead>
            <tbody id="cajeroDetalleBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Estilos para botones de período
  const style = document.createElement('style');
  style.textContent = `
    .btn-period {
      padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600;
      cursor: pointer; border: 1.5px solid var(--border);
      background: var(--bg-card); color: var(--text-muted); transition: all 0.15s;
    }
    .btn-period.active, .btn-period:hover {
      background: var(--primary); color: white; border-color: var(--primary);
    }
  `;
  document.head.appendChild(style);

  // ── Fecha actual en inputs ────────────────────────────────────────────
  document.getElementById('filtroDesde').value = todayAR();
  document.getElementById('filtroHasta').value = todayAR();

  // ── Función principal: calcular y renderizar ──────────────────────────
  function calcularYRenderizar() {
    const desde  = new Date(document.getElementById('filtroDesde').value + 'T00:00:00-03:00');
    const hasta  = new Date(document.getElementById('filtroHasta').value + 'T23:59:59-03:00');
    const filtroN = document.getElementById('filtroCajeroNombre').value.toLowerCase();

    // Filtrar ventas por rango de fechas
    const ventasFiltradas = ventas.filter(v => {
      const dt = parseArDate(v.created_at);
      return dt >= desde && dt <= hasta;
    });

    // Agrupar por cajero
    const porCajero = {};
    for (const v of ventasFiltradas) {
      const cajero = v.cajero || v.username || v.user_id || 'Sin nombre';
      if (!porCajero[cajero]) {
        porCajero[cajero] = { ventas: [], total: 0, efectivo: 0, transferencia: 0 };
      }
      porCajero[cajero].ventas.push(v);
      porCajero[cajero].total        += v.total_amount || 0;
      porCajero[cajero].efectivo     += v.payment_type === 'cash' ? (v.total_amount || 0) : 0;
      porCajero[cajero].transferencia+= v.payment_type !== 'cash' ? (v.total_amount || 0) : 0;
    }

    const totalGeneral = Object.values(porCajero).reduce((s, c) => s + c.total, 0);

    // Ordenar por total desc
    const cajerosList = Object.entries(porCajero)
      .map(([nombre, data]) => ({ nombre, ...data }))
      .sort((a, b) => b.total - a.total);

    // Filtrar por nombre si hay texto
    const cajerosFiltrados = filtroN
      ? cajerosList.filter(c => c.nombre.toLowerCase().includes(filtroN))
      : cajerosList;

    // ── Cards resumen ─────────────────────────────────────────────────
    const colores = ['bg-blue','bg-green','bg-purple','bg-orange','bg-teal','bg-red'];
    const iconos  = ['👤','👤','👤','👤','👤','👤'];
    document.getElementById('cajeroCards').innerHTML = cajerosList.slice(0, 6).map((c, i) => `
      <div class="card stat-card" style="cursor:pointer" onclick="window._verCajero('${c.nombre.replace(/'/g,"\\'")}')">
        <div class="icon-wrap ${colores[i % colores.length]}" style="font-size:22px;display:flex;align-items:center;justify-content:center">👤</div>
        <div class="label" style="font-weight:700;font-size:14px;margin-top:6px">${c.nombre}</div>
        <div class="value" style="font-size:20px">$${fmt(c.total)}</div>
        <small style="color:var(--text-muted)">${c.ventas.length} ventas</small>
        <small style="color:#198754;display:block">💵 $${fmt(c.efectivo)}</small>
        <small style="color:#0d6efd;display:block">🏦 $${fmt(c.transferencia)}</small>
      </div>
    `).join('') || `<p style="color:var(--text-muted);padding:20px">Sin ventas en el período seleccionado.</p>`;

    // ── Barras comparativas ───────────────────────────────────────────
    const maxTotal = Math.max(...cajerosList.map(c => c.total), 1);
    document.getElementById('cajeroBars').innerHTML = cajerosList.map((c, i) => `
      <div class="bar-row" style="cursor:pointer" onclick="window._verCajero('${c.nombre.replace(/'/g,"\\'")}')">
        <span class="bar-label" title="${c.nombre}" style="font-weight:600">${c.nombre}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width:${Math.round(c.total / maxTotal * 100)}%;background:${['#1877f2','#2e7d32','#e65100','#6a1b9a','#00695c','#c62828'][i % 6]}"></div>
        </div>
        <span class="bar-val">$${fmt(c.total)} <span style="color:var(--text-muted);font-size:11px">(${c.ventas.length})</span></span>
      </div>
    `).join('') || '<p style="color:var(--text-muted);padding:20px">Sin datos</p>';

    // ── Tabla detallada ───────────────────────────────────────────────
    document.getElementById('ventasCount').textContent =
      `${cajerosFiltrados.length} cajero(s) · ${ventasFiltradas.length} ventas`;

    document.getElementById('turnosBody').innerHTML = cajerosFiltrados.map(c => {
      const pct      = totalGeneral > 0 ? (c.total / totalGeneral * 100).toFixed(1) : '0.0';
      const promedio = c.ventas.length > 0 ? c.total / c.ventas.length : 0;
      return `
        <tr class="clickable-row" style="cursor:pointer" onclick="window._verCajero('${c.nombre.replace(/'/g,"\\'")}')">
          <td><b style="font-size:14px">👤 ${c.nombre}</b></td>
          <td style="text-align:center"><span class="badge badge-gray">${c.ventas.length}</span></td>
          <td><b style="color:var(--success)">$${fmt(c.total)}</b></td>
          <td><span style="color:#198754">💵 $${fmt(c.efectivo)}</span></td>
          <td><span style="color:#0d6efd">🏦 $${fmt(c.transferencia)}</span></td>
          <td>$${fmt(promedio)}</td>
          <td>
            <div style="display:flex;align-items:center;gap:6px">
              <div style="flex:1;background:#e9ecef;border-radius:4px;height:8px;min-width:60px">
                <div style="width:${pct}%;background:var(--primary);border-radius:4px;height:8px"></div>
              </div>
              <span style="font-size:12px;color:var(--text-muted)">${pct}%</span>
            </div>
          </td>
        </tr>`;
    }).join('') || `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">Sin ventas en el período</td></tr>`;

    // Guardar datos filtrados para el detalle
    window._cajeroData = porCajero;
  }

  // ── Ver detalle de un cajero ──────────────────────────────────────────
  window._verCajero = function(nombre) {
    const data = (window._cajeroData || {})[nombre];
    if (!data) return;

    const detalle = document.getElementById('cajeroDetalle');
    detalle.style.display = 'block';
    document.getElementById('cajeroDetalleTitle').textContent =
      `👤 ${nombre} — ${data.ventas.length} ventas · $${fmt(data.total)}`;

    const ventasOrdenadas = [...data.ventas].sort((a, b) => {
      const da = parseArDate(a.created_at);
      const db_ = parseArDate(b.created_at);
      return db_ - da;
    });

    document.getElementById('cajeroDetalleBody').innerHTML = ventasOrdenadas.map((v, i) => {
      const dt = parseArDate(v.created_at);
      const esEfectivo = v.payment_type === 'cash';
      return `<tr class="clickable-row" data-idx="${i}" style="cursor:pointer">
        <td><b>#${v.sale_id || v.id || '-'}</b></td>
        <td>${fmtDate(dt)}</td>
        <td style="color:var(--text-muted)">${fmtTime(dt)}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text-muted)">${v.productos || '—'}</td>
        <td style="text-align:center"><span class="badge badge-gray">${v.items_count || '-'}</span></td>
        <td><b>$${fmt(v.total_amount)}</b></td>
        <td><span class="badge ${esEfectivo ? 'badge-green' : 'badge-blue'}">${esEfectivo ? '💵 Efectivo' : '🏦 Transf.'}</span></td>
      </tr>`;
    }).join('');

    // Click en fila → modal de venta
    document.querySelectorAll('#cajeroDetalleBody .clickable-row').forEach(row => {
      row.addEventListener('click', () => {
        const idx = parseInt(row.dataset.idx);
        openSaleModal(ventasOrdenadas[idx], db);
      });
    });

    // Scroll al detalle
    detalle.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ── Cerrar detalle ────────────────────────────────────────────────────
  document.getElementById('cerrarDetalle').addEventListener('click', () => {
    document.getElementById('cajeroDetalle').style.display = 'none';
  });

  // ── Botones de período rápido ─────────────────────────────────────────
  document.querySelectorAll('.btn-period').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-period').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const hoyStr = todayAR(); // "YYYY-MM-DD" en hora Argentina

      if (btn.dataset.period === 'hoy') {
        document.getElementById('filtroDesde').value = hoyStr;
        document.getElementById('filtroHasta').value = hoyStr;
      } else if (btn.dataset.period === 'semana') {
        const hoyD = new Date(hoyStr + 'T00:00:00-03:00');
        const dow = hoyD.getDay() === 0 ? 6 : hoyD.getDay() - 1; // lunes=0
        const lunes = new Date(hoyD.getTime() - dow * 86400000);
        document.getElementById('filtroDesde').value = lunes.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
        document.getElementById('filtroHasta').value = hoyStr;
      } else if (btn.dataset.period === 'mes') {
        document.getElementById('filtroDesde').value = hoyStr.slice(0, 7) + '-01';
        document.getElementById('filtroHasta').value = hoyStr;
      }
      calcularYRenderizar();
    });
  });

  // ── Listeners de filtros ──────────────────────────────────────────────
  ['filtroDesde', 'filtroHasta', 'filtroCajeroNombre'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      document.querySelectorAll('.btn-period').forEach(b => b.classList.remove('active'));
      calcularYRenderizar();
    });
  });

  // ── Render inicial ────────────────────────────────────────────────────
  calcularYRenderizar();
}

// Fecha actual en Argentina (YYYY-MM-DD)
function todayAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
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
