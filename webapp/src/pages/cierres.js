import { collection, getDocs, query, orderBy, where } from 'firebase/firestore';
import { getCached } from '../cache.js';

export async function renderCierres(container, db) {
  // TTL corto: la caja abierta es crítica y debe reflejarse casi en tiempo real
  const todos = await getCached('cierres:caja', async () => {
    const snap = await getDocs(query(collection(db, 'cierres_caja'), orderBy('fecha_apertura', 'desc')));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }, { ttl: 30 * 1000 });

  // Separar cajas abiertas (sin fecha_cierre) de las cerradas
  const cajasAbiertas = todos.filter(c => !c.fecha_cierre || c.fecha_cierre === null || c.fecha_cierre === '');
  const cierres = todos.filter(c => c.fecha_cierre && c.fecha_cierre !== '');

  // Caja abierta consolidada: calcular totales desde la colección `ventas`
  // para no depender del documento de cierres_caja (que solo se actualiza al cerrar/sincronizar)
  let cajaAbierta = null;
  if (cajasAbiertas.length > 0) {
    const fechaAperturaRaw = cajasAbiertas.reduce(
      (min, c) => (!min || toDate(c.fecha_apertura) < toDate(min) ? c.fecha_apertura : min), null
    );
    const fechaAperturaDate = toDate(fechaAperturaRaw);

    // Leer ventas desde Firebase y filtrar las que ocurrieron después de la apertura.
    // Se resta un buffer de 5 min a fechaAperturaDate para absorber el race condition
    // donde el sync de una venta corre antes que el sync de la apertura de caja.
    const BUFFER_MS = 5 * 60 * 1000;
    const fechaLimite = fechaAperturaDate
      ? new Date(fechaAperturaDate.getTime() - BUFFER_MS)
      : null;
    const ventasSnap = await getDocs(query(collection(db, 'ventas'), orderBy('created_at', 'desc')));
    let totalEfectivo = 0, totalTransferencia = 0, totalTransacciones = 0;
    for (const doc of ventasSnap.docs) {
      const v = doc.data();
      const vDate = toDate(v.created_at);
      if (!vDate) continue;
      if (fechaLimite && vDate < fechaLimite) continue;
      const monto = parseFloat(v.total_amount || 0);
      if (v.payment_type === 'cash') totalEfectivo += monto;
      else if (v.payment_type === 'transfer') totalTransferencia += monto;
      totalTransacciones++;
    }

    cajaAbierta = {
      cajero:              cajasAbiertas.map(c => c.cajero || c.pc_id || 'PC').join(', '),
      fecha_apertura:      fechaAperturaRaw,
      monto_inicial:       cajasAbiertas[0]?.monto_inicial || 0,
      total_ventas:        totalEfectivo + totalTransferencia,
      total_efectivo:      totalEfectivo,
      total_transferencia: totalTransferencia,
      total_retiros:       cajasAbiertas.reduce((s, c) => s + (c.total_retiros || 0), 0),
      total_transacciones: totalTransacciones,
      productos_vendidos:  [],
      retiros:             cajasAbiertas.flatMap(c => c.retiros || []),
      _pcs:                cajasAbiertas.length,
    };
  }

  // Agrupar cierres por session_id (misma sesión = mismo día de cierre)
  // Docs sin session_id se tratan como sesión individual (compatibilidad con datos viejos)
  const sesionesMap = {};
  for (const c of cierres) {
    const key = c.session_id || c.id; // fallback al id del doc para datos sin session_id
    if (!sesionesMap[key]) {
      sesionesMap[key] = {
        session_id:          key,
        fecha_apertura:      c.fecha_apertura,
        fecha_cierre:        c.fecha_cierre,
        cajero:              [],
        pcs:                 [],
        monto_inicial:       c.monto_inicial || 0,  // compartido entre PCs, no se suma
        total_ventas:        0,
        total_efectivo:      0,
        total_transferencia: 0,
        total_retiros:       0,
        total_transacciones: 0,
        num_ventas_efectivo: 0,
        num_ventas_transferencia: 0,
        monto_inicial_sum:   c.monto_inicial || 0,
        monto_esperado:      0,
        monto_final:         0,
        productos_vendidos:  [],
        retiros:             [],
        _docs:               [],
      };
    }
    const s = sesionesMap[key];
    s._docs.push(c);
    if (c.cajero && !s.cajero.includes(c.cajero)) s.cajero.push(c.cajero);
    if (c.pc_id  && !s.pcs.includes(c.pc_id))    s.pcs.push(c.pc_id);
    s.total_ventas        += (c.total_ventas        || 0);
    s.total_efectivo      += (c.total_efectivo      || 0);
    s.total_transferencia += (c.total_transferencia || 0);
    s.total_retiros       += (c.total_retiros       || 0);
    s.total_transacciones += (c.total_transacciones || 0);
    s.num_ventas_efectivo += (c.num_ventas_efectivo || 0);
    s.num_ventas_transferencia += (c.num_ventas_transferencia || 0);
    // monto_inicial es el mismo en todas las PCs (viene de PC1), no se acumula
    s.monto_esperado      += (c.monto_esperado      || 0);
    s.monto_final         += (c.monto_final         || 0);
    // Usar la apertura más temprana y el cierre más tardío
    if (!s.fecha_apertura || toDate(c.fecha_apertura) < toDate(s.fecha_apertura)) s.fecha_apertura = c.fecha_apertura;
    if (!s.fecha_cierre   || toDate(c.fecha_cierre)   > toDate(s.fecha_cierre))   s.fecha_cierre   = c.fecha_cierre;
    s.productos_vendidos.push(...(c.productos_vendidos || []));
    s.retiros.push(...(c.retiros || []));
  }
  // Convertir mapa a array ordenado por fecha_cierre desc
  const sesiones = Object.values(sesionesMap).sort((a, b) => toDate(b.fecha_cierre) - toDate(a.fecha_cierre));
  for (const s of sesiones) {
    s.cajero        = s.cajero.join(', ') || '-';
    s.monto_inicial = s.monto_inicial_sum;
  }

  const totalCierres = sesiones.length;
  const totalVentas  = sesiones.reduce((s, c) => s + (c.total_ventas || 0), 0);
  const totalEfect   = sesiones.reduce((s, c) => s + (c.total_efectivo || 0), 0);
  const totalTransf  = sesiones.reduce((s, c) => s + (c.total_transferencia || 0), 0);

  // Calcular tiempo abierta
  function tiempoAbierto(apertura) {
    if (!apertura) return '-';
    const aDate = toDate(apertura);
    if (!aDate || isNaN(aDate)) return '-';
    const mins = Math.round((new Date() - aDate) / 60000);
    const hrs = Math.floor(mins / 60);
    const min = mins % 60;
    return hrs > 0 ? `${hrs}h ${min}m` : `${min}m`;
  }

  container.innerHTML = `
    ${cajaAbierta ? `
    <!-- CAJA ACTUALMENTE ABIERTA -->
    <div style="background:linear-gradient(135deg,#065f46,#047857);border-radius:16px;padding:20px 24px;margin-bottom:20px;color:#fff;box-shadow:0 4px 20px rgba(4,120,87,0.3)">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:12px;height:12px;border-radius:50%;background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,0.3);animation:pulse 2s infinite"></div>
          <div>
            <div style="font-size:16px;font-weight:800">Caja Abierta</div>
            <div style="font-size:12px;color:#6ee7b7;margin-top:2px">${cajaAbierta._pcs > 1 ? `${cajaAbierta._pcs} cajas activas · ` : `Cajero: ${cajaAbierta.cajero || 'Sin cajero'} · `}Abierta hace ${tiempoAbierto(cajaAbierta.fecha_apertura)}</div>
          </div>
        </div>
        <div style="font-size:11px;color:#6ee7b7">Apertura: ${fmtDT(parseArDate(cajaAbierta.fecha_apertura))}</div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-top:16px">
        <div style="background:rgba(255,255,255,0.1);border-radius:10px;padding:12px;border:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:11px;color:#6ee7b7;font-weight:600">MONTO INICIAL</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px">$${fmt(cajaAbierta.monto_inicial || 0)}</div>
        </div>
        <div style="background:rgba(255,255,255,0.1);border-radius:10px;padding:12px;border:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:11px;color:#6ee7b7;font-weight:600">VENTAS EN CURSO</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px">$${fmt(cajaAbierta.total_ventas || 0)}</div>
        </div>
        <div style="background:rgba(255,255,255,0.1);border-radius:10px;padding:12px;border:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:11px;color:#6ee7b7;font-weight:600">EFECTIVO</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px">$${fmt(cajaAbierta.total_efectivo || 0)}</div>
        </div>
        <div style="background:rgba(255,255,255,0.1);border-radius:10px;padding:12px;border:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:11px;color:#6ee7b7;font-weight:600">TRANSFERENCIAS</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px">$${fmt(cajaAbierta.total_transferencia || 0)}</div>
        </div>
        <div style="background:rgba(255,255,255,0.1);border-radius:10px;padding:12px;border:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:11px;color:#6ee7b7;font-weight:600">TRANSACCIONES</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px">${cajaAbierta.total_transacciones || 0}</div>
        </div>
        <div style="background:rgba(255,255,255,0.1);border-radius:10px;padding:12px;border:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:11px;color:#6ee7b7;font-weight:600">RETIROS</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px;color:${(cajaAbierta.total_retiros||0)>0?'#fca5a5':'#fff'}">-$${fmt(cajaAbierta.total_retiros || 0)}</div>
        </div>
      </div>

      ${(cajaAbierta.productos_vendidos||[]).length > 0 ? `
      <div style="margin-top:16px">
        <div style="font-size:11px;color:#6ee7b7;font-weight:700;margin-bottom:8px">PRODUCTOS VENDIDOS EN ESTE TURNO</div>
        <div style="background:rgba(0,0,0,0.2);border-radius:10px;overflow:hidden;max-height:160px;overflow-y:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="background:rgba(0,0,0,0.2)">
              <th style="padding:8px 12px;text-align:left;color:#6ee7b7">Producto</th>
              <th style="padding:8px 12px;text-align:center;color:#6ee7b7">Cant.</th>
              <th style="padding:8px 12px;text-align:right;color:#6ee7b7">Total</th>
            </tr></thead>
            <tbody>${(cajaAbierta.productos_vendidos||[]).map((p,i)=>`
              <tr style="border-top:1px solid rgba(255,255,255,0.08)">
                <td style="padding:7px 12px;color:#fff">${p.product_name||p.nombre||'-'}</td>
                <td style="padding:7px 12px;text-align:center;color:#6ee7b7">${p.total_quantity||p.cantidad||0}</td>
                <td style="padding:7px 12px;text-align:right;font-weight:700;color:#34d399">$${fmt(p.total_amount||p.total||0)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}

      ${(cajaAbierta.retiros||[]).length > 0 ? `
      <div style="margin-top:12px">
        <div style="font-size:11px;color:#fca5a5;font-weight:700;margin-bottom:8px">RETIROS DE ESTA SESIÓN</div>
        ${(cajaAbierta.retiros||[]).map(r=>`
          <div style="display:flex;justify-content:space-between;background:rgba(239,68,68,0.2);border-radius:8px;padding:8px 12px;margin-bottom:4px;border:1px solid rgba(239,68,68,0.3)">
            <span style="font-size:12px;color:#fca5a5">${r.reason||r.motivo||'Retiro'}</span>
            <span style="font-weight:700;color:#f87171">-$${fmt(r.amount||r.monto||0)}</span>
          </div>`).join('')}
      </div>` : ''}
    </div>
    ` : `
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:12px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;gap:10px">
      <span class="material-icons" style="color:#2e7d32">lock</span>
      <span style="font-size:14px;color:#166534;font-weight:600">No hay ninguna caja abierta en este momento.</span>
    </div>
    `}

    <!-- Tarjetas resumen -->
    <div class="cards-grid" style="margin-bottom:24px">
      <div class="card stat-card">
        <div class="icon-wrap bg-purple"><span class="material-icons">lock_clock</span></div>
        <div class="label">Total Cierres</div>
        <div class="value">${totalCierres}</div>
      </div>
      <div class="card stat-card">
        <div class="icon-wrap bg-green"><span class="material-icons">attach_money</span></div>
        <div class="label">Total Acumulado</div>
        <div class="value">$${fmt(totalVentas)}</div>
      </div>
      <div class="card stat-card">
        <div class="icon-wrap bg-blue"><span class="material-icons">payments</span></div>
        <div class="label">Total Efectivo</div>
        <div class="value">$${fmt(totalEfect)}</div>
      </div>
      <div class="card stat-card">
        <div class="icon-wrap bg-orange"><span class="material-icons">swap_horiz</span></div>
        <div class="label">Total Transferencias</div>
        <div class="value">$${fmt(totalTransf)}</div>
      </div>
    </div>

    <!-- Tabla de cierres -->
    <div class="table-card">
      <div class="table-card-header">
        <h3>🔒 Cierres de Caja</h3>
        <span style="font-size:12px;color:var(--text-muted)">Click en una fila para ver el detalle completo</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Apertura</th><th class="cie-col-cierre">Cierre</th>
            <th style="text-align:center">Ventas</th><th>Total</th><th class="cie-col-efectivo">Efectivo</th>
            <th class="cie-col-transferencia">Transferencia</th><th class="cie-col-retiros">Retiros</th><th>Cajero</th>
          </tr></thead>
          <tbody id="cierresBody">
            ${sesiones.length === 0
              ? `<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-muted)">Sin cierres registrados</td></tr>`
              : sesiones.map((c, i) => {
                  const apertura = parseArDate(c.fecha_apertura);
                  const cierre   = parseArDate(c.fecha_cierre);
                  const retiros  = c.total_retiros || 0;
                  const pcLabel  = c.pcs.length > 1 ? ` <span style="font-size:10px;color:var(--text-muted)">(${c.pcs.length} PCs)</span>` : '';
                  return `<tr class="clickable-row" data-idx="${i}" style="cursor:pointer" title="Ver detalle del cierre">
                    <td><b>${c.session_id || '-'}</b>${pcLabel}</td>
                    <td>${fmtDT(apertura)}</td>
                    <td class="cie-col-cierre">${fmtDT(cierre)}</td>
                    <td style="text-align:center"><span class="badge badge-blue">${c.total_transacciones || 0}</span></td>
                    <td><b style="color:var(--success)">$${fmt(c.total_ventas)}</b></td>
                    <td class="cie-col-efectivo">$${fmt(c.total_efectivo)}</td>
                    <td class="cie-col-transferencia">$${fmt(c.total_transferencia)}</td>
                    <td class="cie-col-retiros" style="color:${retiros > 0 ? 'var(--danger)' : 'var(--text-muted)'}">
                      ${retiros > 0 ? `-$${fmt(retiros)}` : '-'}
                    </td>
                    <td>${c.cajero || '-'}</td>
                  </tr>`;
                }).join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Click en fila → abrir modal detallado
  container.querySelectorAll('.clickable-row').forEach(row => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.idx);
      openCierreModal(sesiones[idx]);
    });
    row.addEventListener('mouseenter', () => row.style.background = 'var(--bg)');
    row.addEventListener('mouseleave', () => row.style.background = '');
  });
}

function openCierreModal(c) {
  document.querySelector('.modal-overlay')?.remove();

  const apertura  = parseArDate(c.fecha_apertura);
  const cierre    = parseArDate(c.fecha_cierre);
  const retiros   = c.total_retiros || 0;
  const efectivo  = c.total_efectivo || 0;
  const transf    = c.total_transferencia || 0;
  const total     = c.total_ventas || 0;
  const inicial   = c.monto_inicial || 0;
  const esperado  = c.monto_esperado || (inicial + efectivo - retiros);
  const final_amt = c.monto_final || 0;
  const diff      = final_amt - esperado;
  const productos = c.productos_vendidos || [];
  const retiros_lista = c.retiros || [];

  // Calcular duración del turno
  let duracion = '-';
  if (apertura && cierre && !isNaN(apertura) && !isNaN(cierre)) {
    const mins = Math.round((cierre - apertura) / 60000);
    const hrs  = Math.floor(mins / 60);
    const min  = mins % 60;
    duracion = hrs > 0 ? `${hrs}h ${min}m` : `${min}m`;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" id="cierreModal" style="max-width:680px">
      <div class="modal-header" style="background:linear-gradient(135deg,#1e293b,#334155);color:white;border-radius:12px 12px 0 0">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="material-icons" style="color:#94a3b8">lock_clock</span>
          <div>
            <h3 style="color:white;margin:0">Cierre ${c.session_id || c.register_id || '-'}${c.pcs && c.pcs.length > 1 ? ` (${c.pcs.length} PCs)` : ''}</h3>
            <div style="font-size:11px;color:#94a3b8;margin-top:2px">${c.cajero || 'Sin cajero'} · Duración: ${duracion}</div>
          </div>
        </div>
        <button class="modal-close" style="color:white"><span class="material-icons">close</span></button>
      </div>

      <div class="modal-body" style="padding:20px">

        <!-- Fechas -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
          <div style="background:#f8fafc;border-radius:10px;padding:12px 16px;border-left:3px solid #0d6efd">
            <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Apertura</div>
            <div style="font-size:14px;font-weight:700;color:#1e293b;margin-top:4px">${fmtDT(apertura)}</div>
          </div>
          <div style="background:#f8fafc;border-radius:10px;padding:12px 16px;border-left:3px solid #198754">
            <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Cierre</div>
            <div style="font-size:14px;font-weight:700;color:#1e293b;margin-top:4px">${fmtDT(cierre)}</div>
          </div>
        </div>

        <!-- Resumen financiero -->
        <div style="margin-bottom:20px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#64748b;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0">💰 Resumen Financiero</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            ${fila('Monto Inicial de Caja', `$${fmt(inicial)}`, '#475569')}
            ${fila('Ventas en Efectivo', `+$${fmt(efectivo)}`, '#198754')}
            ${fila('Ventas por Transferencia', `$${fmt(transf)}`, '#0d6efd')}
            ${retiros > 0 ? fila('Retiros de Caja', `-$${fmt(retiros)}`, '#dc3545') : ''}
            ${fila('Efectivo Esperado en Caja', `$${fmt(esperado)}`, '#1e293b', true)}
            ${final_amt > 0 ? fila('Efectivo Contado', `$${fmt(final_amt)}`, '#1e293b', true) : ''}
            ${final_amt > 0 ? `
              <div style="grid-column:1/-1;background:${diff >= 0 ? '#f0fdf4' : '#fef2f2'};border:1px solid ${diff >= 0 ? '#bbf7d0' : '#fecaca'};border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center">
                <span style="font-weight:600;color:${diff >= 0 ? '#166534' : '#991b1b'};font-size:13px">
                  ${diff >= 0 ? '✅ Sobrante' : '⚠️ Faltante'}
                </span>
                <span style="font-weight:700;font-size:15px;color:${diff >= 0 ? '#198754' : '#dc3545'}">
                  ${diff >= 0 ? '+' : '-'}$${fmt(Math.abs(diff))}
                </span>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Ventas por tipo de pago -->
        <div style="margin-bottom:20px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#64748b;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0">🧾 Ventas por Tipo de Pago</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px;text-align:center">
              <div style="font-size:11px;color:#166534;font-weight:600">💵 Efectivo</div>
              <div style="font-size:18px;font-weight:700;color:#198754;margin-top:4px">$${fmt(efectivo)}</div>
              <div style="font-size:12px;color:#64748b">${c.num_ventas_efectivo || 0} ventas</div>
            </div>
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px;text-align:center">
              <div style="font-size:11px;color:#1e40af;font-weight:600">🏦 Transferencia</div>
              <div style="font-size:18px;font-weight:700;color:#0d6efd;margin-top:4px">$${fmt(transf)}</div>
              <div style="font-size:12px;color:#64748b">${c.num_ventas_transferencia || 0} ventas</div>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;text-align:center">
              <div style="font-size:11px;color:#475569;font-weight:600">📊 Total</div>
              <div style="font-size:18px;font-weight:700;color:#1e293b;margin-top:4px">$${fmt(total)}</div>
              <div style="font-size:12px;color:#64748b">${c.total_transacciones || 0} ventas</div>
            </div>
          </div>
        </div>

        <!-- Productos vendidos -->
        ${productos.length > 0 ? `
        <div style="margin-bottom:20px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#64748b;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0">📦 Productos Vendidos en el Turno</div>
          <div style="max-height:200px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr style="background:#f8fafc;position:sticky;top:0">
                  <th style="padding:8px 12px;text-align:left;font-weight:600;color:#475569;border-bottom:1px solid #e2e8f0">Producto</th>
                  <th style="padding:8px 12px;text-align:center;font-weight:600;color:#475569;border-bottom:1px solid #e2e8f0">Cant.</th>
                  <th style="padding:8px 12px;text-align:right;font-weight:600;color:#475569;border-bottom:1px solid #e2e8f0">Total</th>
                </tr>
              </thead>
              <tbody>
                ${productos.map((p, i) => `
                  <tr style="background:${i % 2 === 0 ? 'white' : '#f8fafc'}">
                    <td style="padding:8px 12px;color:#1e293b;font-weight:500">${p.product_name || p.nombre || '-'}</td>
                    <td style="padding:8px 12px;text-align:center;color:#475569">${p.total_quantity || p.cantidad || 0}</td>
                    <td style="padding:8px 12px;text-align:right;font-weight:600;color:#198754">$${fmt(p.total_amount || p.total || 0)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
        ` : ''}

        <!-- Retiros -->
        ${retiros_lista.length > 0 ? `
        <div style="margin-bottom:20px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#64748b;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0">💸 Retiros de Caja</div>
          ${retiros_lista.map(r => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;margin-bottom:6px">
              <div>
                <div style="font-size:12px;font-weight:600;color:#991b1b">${r.reason || r.motivo || 'Retiro'}</div>
                <div style="font-size:11px;color:#64748b">${r.created_at ? fmtDT(parseArDate(r.created_at)) : ''}</div>
              </div>
              <div style="font-size:15px;font-weight:700;color:#dc3545">-$${fmt(r.amount || r.monto || 0)}</div>
            </div>
          `).join('')}
        </div>
        ` : ''}

        <!-- Total final -->
        <div style="background:linear-gradient(135deg,#1e293b,#334155);border-radius:10px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center">
          <span style="color:#94a3b8;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Total del Turno</span>
          <span style="color:white;font-size:24px;font-weight:700">$${fmt(total)}</span>
        </div>

      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });
}

function fila(label, valor, color = '#1e293b', bold = false) {
  return `
    <div style="background:#f8fafc;border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:12px;color:#64748b">${label}</span>
      <span style="font-size:13px;font-weight:${bold ? '700' : '600'};color:${color}">${valor}</span>
    </div>
  `;
}

// Maneja: Timestamp live (.toDate), Timestamp de localStorage ({ seconds, nanoseconds }), ISO string
function toDate(val) {
  if (!val) return null;
  if (typeof val.toDate === 'function') return val.toDate();
  if (typeof val === 'object' && val.seconds !== undefined)
    return new Date(val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1e6));
  return new Date(val);
}

// Para display: compensar naive hora AR guardada como UTC → sumar 3h
function parseArDate(val) {
  if (!val) return null;
  if (typeof val.toDate === 'function') return new Date(val.toDate().getTime() + 3 * 60 * 60 * 1000);
  if (typeof val === 'object' && val.seconds !== undefined)
    return new Date(val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1e6) + 3 * 60 * 60 * 1000);
  return new Date(val);
}

function fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDT(d) {
  if (!d || isNaN(d)) return '-';
  const opts = { timeZone: 'America/Argentina/Buenos_Aires' };
  return d.toLocaleDateString('es-AR', opts) + ' ' + d.toLocaleTimeString('es-AR', { ...opts, hour: '2-digit', minute: '2-digit' });
}
