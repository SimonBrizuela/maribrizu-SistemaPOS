import { collection, getDocs, query, orderBy, where, limit, doc, updateDoc, setDoc, getDoc, runTransaction, Timestamp } from 'firebase/firestore';
import { getCached, invalidateCache } from '../cache.js';
import { getFechaInicioDate, isVentaVarios2 } from '../config.js';

export async function renderCierres(container, db) {
  const fechaInicio = await getFechaInicioDate(db);

  // TTL corto: la caja abierta es crítica y debe reflejarse casi en tiempo real.
  // Catálogo + gastos se usan en el modal de cierre para calcular rentabilidad.
  const [todosRaw, catalogo, gastosAll] = await Promise.all([
    getCached('cierres:caja', async () => {
      const snap = await getDocs(query(collection(db, 'cierres_caja'), orderBy('fecha_apertura', 'desc')));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }, { ttl: 30 * 1000 }),
    getCached('catalogo:all', async () => {
      const snap = await getDocs(collection(db, 'catalogo'));
      return snap.docs.map(d => d.data());
    }, { ttl: 10 * 60 * 1000, memOnly: true }),
    getCached('gastos:all', async () => {
      const snap = await getDocs(query(collection(db, 'gastos'), orderBy('created_at', 'desc')));
      return snap.docs.map(d => d.data());
    }, { ttl: 60 * 1000 }),
  ]);

  // Índice catálogo por nombre (para obtener costo al calcular CMV del turno)
  const catByName = {};
  for (const p of catalogo) {
    const key = (p.nombre || '').toUpperCase().trim();
    if (key) catByName[key] = p;
  }

  // Ocultar cierres cerrados anteriores a fecha_inicio.
  // Las cajas abiertas se muestran siempre (para poder cerrarlas aunque sean viejas).
  const todos = todosRaw.filter(c => {
    const estaAbierta = !c.fecha_cierre || c.fecha_cierre === '';
    if (estaAbierta) return true;
    const d = toDate(c.fecha_apertura);
    return d && d >= fechaInicio;
  });

  // Separar cajas abiertas (sin fecha_cierre) de las cerradas
  const cajasAbiertasRaw = todos.filter(c => !c.fecha_cierre || c.fecha_cierre === null || c.fecha_cierre === '');
  // Deduplicar por register_id: hoy hay UN solo doc compartido por caja, pero
  // pueden quedar docs viejos en formato "{pc_id}_{register_id}" del esquema
  // anterior → si vemos el mismo register_id en varios docs, nos quedamos con uno.
  const _seenReg = new Set();
  const cajasAbiertas = [];
  for (const c of cajasAbiertasRaw) {
    const key = c.register_id != null ? String(c.register_id) : `_doc_${c.id}`;
    if (_seenReg.has(key)) continue;
    _seenReg.add(key);
    cajasAbiertas.push(c);
  }
  const cierres = todos.filter(c => c.fecha_cierre && c.fecha_cierre !== '');

  // Caja abierta consolidada: calcular totales desde la colección `ventas`
  // para no depender del documento de cierres_caja (que solo se actualiza al cerrar/sincronizar)
  let cajaAbierta = null;
  if (cajasAbiertas.length > 0) {
    const fechaAperturaRaw = cajasAbiertas.reduce(
      (min, c) => (!min || toDate(c.fecha_apertura) < toDate(min) ? c.fecha_apertura : min), null
    );
    const fechaAperturaDate = toDate(fechaAperturaRaw);

    // "Ventas en curso" = ventas desde la apertura del turno (con buffer).
    // Una caja que quedó abierta cruzando medianoche sigue siendo el mismo turno:
    // hay que mostrar TODAS sus ventas, no cortarlas al inicio del día actual.
    const BUFFER_MS = 5 * 60 * 1000;
    let fechaLimite = fechaAperturaDate ? new Date(fechaAperturaDate.getTime() - BUFFER_MS) : null;
    if (fechaInicio && (!fechaLimite || fechaLimite < fechaInicio)) {
      fechaLimite = fechaInicio;
    }
    // Reutilizar cache compartido con dashboard/control_total (500 ventas recientes).
    // Cubre holgadamente las ventas del día actual; TTL corto = datos casi en vivo.
    const ventasCache = await getCached('dashboard:ventas', async () => {
      const snap = await getDocs(query(collection(db, 'ventas'), orderBy('created_at', 'desc'), limit(500)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }, { ttl: 60 * 1000 });
    // Sumar SOLO ventas pertenecientes a cajas actualmente abiertas. Si no filtramos
    // por register_id, una caja vieja sin cerrar arrastra ventas de cajas ya cerradas
    // (Historial 22/04 ≠ Caja Abierta porque ésta sumaba 20, 21 y 22).
    const idsAbiertos = new Set(
      cajasAbiertas
        .map(c => (c.register_id != null ? String(c.register_id) : null))
        .filter(Boolean)
    );
    let totalEfectivo = 0, totalTransferencia = 0, totalTransacciones = 0;
    for (const v of ventasCache) {
      if (v.deleted === true) continue;
      if (isVentaVarios2(v)) continue;
      if (idsAbiertos.size > 0) {
        const regId = v.cash_register_id != null ? String(v.cash_register_id) : '';
        if (!idsAbiertos.has(regId)) continue;
      }
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
        pendiente_conteo:    false,
        _docs:               [],
      };
    }
    const s = sesionesMap[key];
    s._docs.push(c);
    if (c.pendiente_conteo === true) s.pendiente_conteo = true;
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

  // ID de la caja abierta (para cerrarla desde la web). Si hay varias PCs con
  // distinto register_id (raro tras la migracion), tomamos el primero.
  const cajaAbiertaId = cajaAbierta && cajasAbiertas.length > 0
    ? (cajasAbiertas[0].register_id != null ? cajasAbiertas[0].register_id : null)
    : null;
  // Próximo register_id sugerido para apertura (max actual + 1).
  const maxRegId = todos.reduce((m, c) => {
    const r = parseInt(c.register_id);
    return Number.isFinite(r) && r > m ? r : m;
  }, 0);
  const proximoRegId = maxRegId + 1;

  container.innerHTML = `
    ${cajaAbierta ? `
    <!-- CAJA ACTUALMENTE ABIERTA -->
    <div style="background:linear-gradient(135deg,#065f46,#047857);border-radius:16px;padding:20px 24px;margin-bottom:20px;color:#fff;box-shadow:0 4px 20px rgba(4,120,87,0.3)">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:12px;height:12px;border-radius:50%;background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,0.3);animation:pulse 2s infinite"></div>
          <div>
            <div style="font-size:16px;font-weight:800">Caja Abierta${cajaAbiertaId != null ? ` #${cajaAbiertaId}` : ''}</div>
            <div style="font-size:12px;color:#6ee7b7;margin-top:2px">${cajaAbierta._pcs > 1 ? `${cajaAbierta._pcs} cajas activas · ` : `Cajero: ${cajaAbierta.cajero || 'Sin cajero'} · `}Abierta hace ${tiempoAbierto(cajaAbierta.fecha_apertura)}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div style="font-size:11px;color:#6ee7b7">Apertura: ${fmtDT(parseArDate(cajaAbierta.fecha_apertura))}</div>
          ${cajaAbiertaId != null ? `
          <button id="btn-cerrar-caja-web" style="background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:8px;padding:8px 14px;font-weight:700;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
            <span class="material-icons" style="font-size:16px">lock</span>Cerrar caja
          </button>` : ''}
        </div>
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
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:12px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="material-icons" style="color:#2e7d32">lock</span>
        <span style="font-size:14px;color:#166534;font-weight:600">No hay ninguna caja abierta. La próxima será la <b>#${proximoRegId}</b>.</span>
      </div>
      <button id="btn-abrir-caja-web" style="background:#15803d;color:#fff;border:none;border-radius:8px;padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px">
        <span class="material-icons" style="font-size:16px">lock_open</span>Abrir caja #${proximoRegId}
      </button>
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
                  const pendBadge = c.pendiente_conteo ? ` <span style="background:#fef3c7;color:#92400e;font-size:9px;padding:2px 7px;border-radius:6px;font-weight:800;letter-spacing:.3px;border:1px solid #fcd34d">PENDIENTE</span>` : '';
                  return `<tr class="clickable-row" data-idx="${i}" style="cursor:pointer" title="${c.pendiente_conteo ? 'Cierre pendiente de conteo — click para cargar' : 'Ver detalle del cierre'}">
                    <td><b>${c.session_id || '-'}</b>${pcLabel}${pendBadge}</td>
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
      openCierreModal(sesiones[idx], catByName, gastosAll, db, () => renderCierres(container, db));
    });
    row.addEventListener('mouseenter', () => row.style.background = 'var(--bg)');
    row.addEventListener('mouseleave', () => row.style.background = '');
  });

  // Botón cerrar caja desde web — pasamos el monto_inicial y los retiros del doc
  // de cierres_caja para calcular monto_esperado correctamente.
  const btnCerrarWeb = container.querySelector('#btn-cerrar-caja-web');
  if (btnCerrarWeb && cajaAbiertaId != null) {
    btnCerrarWeb.addEventListener('click', () => {
      const cajaCtx = {
        registerId:    cajaAbiertaId,
        monto_inicial: cajasAbiertas[0]?.monto_inicial || 0,
        cajero:        cajasAbiertas[0]?.cajero || '',
        retiros:       cajaAbierta?.retiros || [],
        total_retiros: cajaAbierta?.total_retiros || 0,
      };
      openCerrarCajaModal(db, cajaCtx, () => {
        invalidateCache('cierres:caja');
        renderCierres(container, db);
      });
    });
  }

  // Botón abrir caja desde web
  const btnAbrirWeb = container.querySelector('#btn-abrir-caja-web');
  if (btnAbrirWeb) {
    btnAbrirWeb.addEventListener('click', () => {
      openAbrirCajaModal(db, proximoRegId, () => {
        invalidateCache('cierres:caja');
        renderCierres(container, db);
      });
    });
  }
}

// ─── Modal: Cerrar caja desde web ─────────────────────────────────────────
// Lee `ventas` filtradas por cash_register_id, calcula totales (efectivo,
// transferencia, transacciones, productos_vendidos) y los escribe a
// cierres_caja/{id} junto con fecha_cierre y pendiente_conteo:true.
// Después marca caja_activa/current como cerrada — los listeners desktop
// detectan y, si tienen la caja abierta local, mergean también su reporte.
// Cuando NO hay PCs online, los stats igual aparecen porque la web los calcula.
function openCerrarCajaModal(db, ctx, onDone) {
  const { registerId, monto_inicial = 0, cajero = '', retiros = [], total_retiros = 0 } = ctx;
  document.querySelector('.modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div class="modal-header" style="background:linear-gradient(135deg,#7c2d12,#9a3412);color:#fff;border-radius:12px 12px 0 0;padding:16px 22px;display:flex;justify-content:space-between;align-items:center">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="material-icons">lock</span>
          <h3 style="color:#fff;margin:0;font-size:16px">Cerrar caja #${registerId}</h3>
        </div>
        <button class="modal-close" style="color:#fff;background:rgba(255,255,255,0.15);border-radius:8px;width:30px;height:30px;display:flex;align-items:center;justify-content:center"><span class="material-icons" style="font-size:18px">close</span></button>
      </div>
      <div class="modal-body" style="padding:20px 22px">
        <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;gap:10px">
          <span class="material-icons" style="color:#b45309">info</span>
          <div style="font-size:12.5px;color:#92400e;line-height:1.45">
            La web calculará los totales desde las ventas y cerrará la caja.
            Las PCs conectadas también la marcarán como cerrada.
            Quedará <b>pendiente de conteo</b>: cargá después el efectivo real.
          </div>
        </div>
        <div style="font-size:13px;color:#475569;margin-bottom:14px">¿Confirmás cerrar la caja <b>#${registerId}</b>?</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="btn-cancel-cerrar" style="background:#e5e7eb;color:#374151;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer">Cancelar</button>
          <button id="btn-confirm-cerrar" style="background:#b91c1c;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px">
            <span class="material-icons" style="font-size:16px">lock</span>Cerrar caja
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('#btn-cancel-cerrar').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  const btn = overlay.querySelector('#btn-confirm-cerrar');
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.innerHTML = '<span class="material-icons" style="font-size:16px">hourglass_empty</span>Calculando...';
    try {
      const nowDate = new Date();
      const nowIso = nowDate.toISOString();
      const nowTs = Timestamp.fromDate(nowDate);
      const sessionId = nowDate.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

      // 1. Calcular y escribir todos los stats al doc cierres_caja/{id}
      await calcularYMergearStatsCaja(db, registerId, {
        monto_inicial, cajero, retiros, total_retiros,
        fecha_cierre: nowTs, session_id: sessionId,
        pendiente_conteo: true, cerrado_desde: 'web', updated_at: nowIso,
      });

      // 2. Marcar caja_activa/current como cerrada → dispara listeners desktop.
      //    Las PCs con la caja abierta local también van a mergear su reporte,
      //    pero los stats principales ya están escritos por la web.
      await setDoc(doc(db, 'caja_activa', 'current'), {
        status:      'closed',
        id:          Number(registerId),
        register_id: Number(registerId),
        session_id:  sessionId,
        updated_at:  nowIso,
      }, { merge: true });

      close();
      if (typeof onDone === 'function') onDone();
    } catch (e) {
      btn.disabled = false; btn.innerHTML = '<span class="material-icons" style="font-size:16px">lock</span>Cerrar caja';
      alert('Error al cerrar caja: ' + (e?.message || e));
    }
  });
}

// ─── Helper: calcular stats desde ventas + ventas_por_dia y mergear ───────
// Usado al cerrar caja desde web Y al recalcular un cierre con stats vacíos.
// extras: campos extra a mergear al doc (fecha_cierre, pendiente_conteo, etc.)
async function calcularYMergearStatsCaja(db, registerId, extras = {}) {
  // ── Ventas filtradas por cash_register_id ──
  // 500 docs cubren turnos largos sin paginar. Si una caja gigantesca necesita
  // más, habría que paginar — caso raro en operación normal.
  const ventasSnap = await getDocs(query(
    collection(db, 'ventas'),
    orderBy('created_at', 'desc'),
    limit(500)
  ));
  const ventasCaja = ventasSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(v => {
      if (v.deleted === true) return false;
      if (isVentaVarios2(v)) return false;
      const reg = v.cash_register_id != null ? String(v.cash_register_id) : '';
      return reg === String(registerId);
    });

  let total_efectivo = 0, total_transferencia = 0;
  let num_ventas_efectivo = 0, num_ventas_transferencia = 0;
  const saleIds = new Set();
  for (const v of ventasCaja) {
    const monto = parseFloat(v.total_amount || 0);
    if (v.payment_type === 'cash') { total_efectivo += monto; num_ventas_efectivo++; }
    else                            { total_transferencia += monto; num_ventas_transferencia++; }
    saleIds.add(String(v.sale_id || v.id));
  }
  const total_ventas        = total_efectivo + total_transferencia;
  const total_transacciones = ventasCaja.length;
  const monto_inicial = Number(extras.monto_inicial) || 0;
  const total_retiros = Number(extras.total_retiros) || 0;
  const monto_esperado = monto_inicial + total_efectivo - total_retiros;

  // ── Productos vendidos: cruzar ventas_por_dia por num_venta ──
  const productosMap = {};
  if (saleIds.size > 0) {
    try {
      const itemsSnap = await getDocs(query(
        collection(db, 'ventas_por_dia'),
        orderBy('num_venta', 'desc'),
        limit(2000)
      ));
      for (const d of itemsSnap.docs) {
        const it = d.data();
        if (it.deleted === true) continue;
        if (!saleIds.has(String(it.num_venta))) continue;
        const nombre = (it.producto || it.product_name || '').trim();
        if (!nombre) continue;
        if (!productosMap[nombre]) productosMap[nombre] = { product_name: nombre, total_quantity: 0, total_amount: 0 };
        productosMap[nombre].total_quantity += Number(it.cantidad || it.quantity || 0);
        productosMap[nombre].total_amount   += Number(it.subtotal || 0);
      }
    } catch (_) { /* si falla, productos_vendidos queda vacío */ }
  }
  const productos_vendidos = Object.values(productosMap).sort((a, b) => b.total_amount - a.total_amount);

  // Mergear todos los campos calculados + cualquier extra que vino del caller
  await setDoc(doc(db, 'cierres_caja', String(registerId)), {
    register_id:               Number(registerId),
    monto_inicial:             monto_inicial,
    monto_esperado:            monto_esperado,
    total_ventas:              total_ventas,
    total_efectivo:            total_efectivo,
    total_transferencia:       total_transferencia,
    total_transacciones:       total_transacciones,
    num_ventas_efectivo:       num_ventas_efectivo,
    num_ventas_transferencia:  num_ventas_transferencia,
    total_retiros:             total_retiros,
    retiros:                   extras.retiros || [],
    productos_vendidos:        productos_vendidos,
    cajero:                    extras.cajero || '',
    ...extras,
  }, { merge: true });

  return { total_ventas, total_efectivo, total_transferencia, total_transacciones };
}

// ─── Modal: Abrir caja desde web ──────────────────────────────────────────
// Crea caja_activa/current con status='open' y cierres_caja/{id} con esquema
// base. Las PCs reciben el snapshot via listener y crean la fila en su SQLite
// local (cash_register) con el mismo id, así las próximas ventas usan ese
// cash_register_id automáticamente.
// Usa runTransaction para evitar colisiones si una PC abre una caja al mismo
// tiempo: si la caja_activa/current ya está 'open', se aborta y reintenta.
function openAbrirCajaModal(db, sugerenciaId, onDone) {
  document.querySelector('.modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div class="modal-header" style="background:linear-gradient(135deg,#065f46,#047857);color:#fff;border-radius:12px 12px 0 0;padding:16px 22px;display:flex;justify-content:space-between;align-items:center">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="material-icons">lock_open</span>
          <h3 style="color:#fff;margin:0;font-size:16px">Abrir caja #${sugerenciaId}</h3>
        </div>
        <button class="modal-close" style="color:#fff;background:rgba(255,255,255,0.15);border-radius:8px;width:30px;height:30px;display:flex;align-items:center;justify-content:center"><span class="material-icons" style="font-size:18px">close</span></button>
      </div>
      <div class="modal-body" style="padding:20px 22px">
        <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;gap:10px">
          <span class="material-icons" style="color:#047857">info</span>
          <div style="font-size:12.5px;color:#065f46;line-height:1.45">
            Esto abrirá la caja <b>#${sugerenciaId}</b> en todas las PCs.
            Las ventas que hagan se vincularán automáticamente a esta caja.
          </div>
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:12px;color:#475569;font-weight:700;display:block;margin-bottom:6px">Monto inicial ($)</label>
          <input type="number" step="0.01" id="abrir-monto" placeholder="0.00" value="0" style="width:100%;padding:10px 12px;font-size:14px;border:1.5px solid #cbd5e1;border-radius:8px;outline:none;font-family:inherit">
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:12px;color:#475569;font-weight:700;display:block;margin-bottom:6px">Cajero / Notas (opcional)</label>
          <input type="text" id="abrir-notas" placeholder="Ej: Turno mañana - María" style="width:100%;padding:10px 12px;font-size:14px;border:1.5px solid #cbd5e1;border-radius:8px;outline:none;font-family:inherit">
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="btn-cancel-abrir" style="background:#e5e7eb;color:#374151;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer">Cancelar</button>
          <button id="btn-confirm-abrir" style="background:#15803d;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px">
            <span class="material-icons" style="font-size:16px">lock_open</span>Abrir caja
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('#btn-cancel-abrir').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  const btn = overlay.querySelector('#btn-confirm-abrir');
  const inputMonto = overlay.querySelector('#abrir-monto');
  const inputNotas = overlay.querySelector('#abrir-notas');
  setTimeout(() => { inputMonto.focus(); inputMonto.select(); }, 50);

  btn.addEventListener('click', async () => {
    const monto = parseFloat(inputMonto.value);
    if (isNaN(monto) || monto < 0) { inputMonto.focus(); return; }
    const notas = (inputNotas.value || '').trim();
    btn.disabled = true; btn.textContent = 'Abriendo...';
    try {
      const nowDate = new Date();
      const nowIso = nowDate.toISOString();
      const nowTs = Timestamp.fromDate(nowDate);
      const sessionId = nowDate.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

      // Recalcular max(register_id) ANTES de la transaction.
      // Las queries con collection() no se permiten dentro de runTransaction
      // (solo tx.get sobre un documento). El lock fuerte se hace sobre
      // caja_activa/current dentro de la transaction.
      let nextId = sugerenciaId;
      try {
        const cierresSnap = await getDocs(query(collection(db, 'cierres_caja'), orderBy('register_id', 'desc'), limit(1)));
        if (!cierresSnap.empty) {
          const top = parseInt(cierresSnap.docs[0].data().register_id);
          if (Number.isFinite(top)) nextId = Math.max(nextId, top + 1);
        }
      } catch (_) { /* si falla, usamos sugerenciaId */ }

      // Transaction: lockea caja_activa/current. Si una PC ya abrió una caja
      // entre el render y el click, vemos status='open' y abortamos.
      const cajaActivaRef = doc(db, 'caja_activa', 'current');
      const newId = await runTransaction(db, async (tx) => {
        const snap = await tx.get(cajaActivaRef);
        if (snap.exists()) {
          const data = snap.data();
          if (data.status === 'open') {
            throw new Error(`Ya hay una caja abierta (#${data.id}) — refrescá la página.`);
          }
        }

        // Escritura 1: caja_activa/current → dispara listener apertura en PCs
        // opening_date como Timestamp → desktop lo recibe como datetime y lo
        // pasa a SQLite vía _to_ar_str (acepta datetime nativamente).
        tx.set(cajaActivaRef, {
          id:             nextId,
          initial_amount: monto,
          opening_date:   nowTs,
          notes:          notas,
          status:         'open',
          updated_at:     nowIso,
        });

        // Escritura 2: cierres_caja/{id} con esquema base (igual que sync_open_register)
        tx.set(doc(db, 'cierres_caja', String(nextId)), {
          register_id:               nextId,
          pc_id:                     'WEB',
          session_id:                sessionId,
          fecha_apertura:            nowTs,
          fecha_cierre:              '',
          cajero:                    notas || 'Web',
          monto_inicial:             monto,
          total_ventas:              0,
          total_efectivo:            0,
          total_transferencia:       0,
          total_retiros:             0,
          total_transacciones:       0,
          num_ventas_efectivo:       0,
          num_ventas_transferencia:  0,
          monto_esperado:            monto,
          monto_final:               0,
          productos_vendidos:        [],
          retiros:                   [],
          abierto_desde:             'web',
        });

        return nextId;
      });

      close();
      if (typeof onDone === 'function') onDone();
      // Pequeño delay para que el listener del desktop alcance a procesar
      setTimeout(() => {
        alert(`Caja #${newId} abierta. Las PCs conectadas la detectarán en unos segundos.`);
      }, 300);
    } catch (e) {
      btn.disabled = false; btn.innerHTML = '<span class="material-icons" style="font-size:16px">lock_open</span>Abrir caja';
      alert('Error al abrir caja: ' + (e?.message || e));
    }
  });
}

function openCierreModal(c, catByName, gastosAll, db, onSaved) {
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
  const numVentas = c.total_transacciones || 0;
  const ticketPromedio = numVentas > 0 ? total / numVentas : 0;
  const productosRaw  = c.productos_vendidos || [];
  const retiros_lista = c.retiros || [];

  // Calcular duración del turno
  let duracion = '-';
  let duracionMins = 0;
  if (apertura && cierre && !isNaN(apertura) && !isNaN(cierre)) {
    duracionMins = Math.round((cierre - apertura) / 60000);
    const hrs  = Math.floor(duracionMins / 60);
    const min  = duracionMins % 60;
    duracion = hrs > 0 ? `${hrs}h ${min}m` : `${min}m`;
  }
  const ventasPorHora = duracionMins > 0 ? (numVentas / (duracionMins / 60)) : 0;

  // ── Rentabilidad del turno (misma lógica que Control Total) ────────────
  // Cruza cada producto vendido con el catálogo para obtener su costo.
  // Lo que no tiene costo cargado queda fuera del CMV y se avisa aparte.
  let cmv = 0, ingresoConCosto = 0, ingresoSinCosto = 0, itemsSinCosto = 0;
  const productos = productosRaw.map(p => {
    const nombre    = (p.product_name || p.nombre || '').toUpperCase().trim();
    const cat       = (catByName || {})[nombre];
    const cantidad  = Number(p.total_quantity || p.cantidad || 0);
    const ingreso   = Number(p.total_amount || p.total || 0);
    const costoUnit = Number(cat?.costo || 0);
    const costoTot  = costoUnit * cantidad;
    if (costoUnit > 0) {
      cmv             += costoTot;
      ingresoConCosto += ingreso;
    } else {
      ingresoSinCosto += ingreso;
      if (cantidad > 0) itemsSinCosto++;
    }
    return {
      ...p,
      _nombre:     p.product_name || p.nombre || '-',
      _cantidad:   cantidad,
      _ingreso:    ingreso,
      _costoUnit:  costoUnit,
      _costoTot:   costoTot,
      _ganancia:   costoUnit > 0 ? ingreso - costoTot : null,
      _margenPct:  costoUnit > 0 && ingreso > 0 ? ((ingreso - costoTot) / ingreso) * 100 : null,
    };
  }).sort((a, b) => b._ingreso - a._ingreso);

  // Gastos registrados en el rango apertura→cierre del turno
  let gastosTurno = [];
  if (apertura && cierre && !isNaN(apertura) && !isNaN(cierre)) {
    const aperturaStr = apertura.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const cierreStr   = cierre.toLocaleDateString('en-CA',   { timeZone: 'America/Argentina/Buenos_Aires' });
    gastosTurno = (gastosAll || []).filter(g => (g.fecha || '') >= aperturaStr && (g.fecha || '') <= cierreStr);
  }
  const gastoTotal    = gastosTurno.reduce((s, g) => s + Number(g.monto || 0), 0);
  const gananciaBruta = ingresoConCosto - cmv;
  const gananciaNeta  = gananciaBruta - gastoTotal;
  const margenPct     = ingresoConCosto > 0 ? (gananciaBruta / ingresoConCosto) * 100 : 0;
  const pctConCosto   = total > 0 ? (ingresoConCosto / total) * 100 : 0;

  // Salud del turno segun margen
  let salud = { color: '#64748b', bg: '#f1f5f9', label: 'S/D', icon: 'help_outline' };
  if (ingresoConCosto > 0) {
    if (margenPct >= 40)      salud = { color: '#047857', bg: '#d1fae5', label: 'Excelente', icon: 'trending_up' };
    else if (margenPct >= 25) salud = { color: '#15803d', bg: '#dcfce7', label: 'Bueno',     icon: 'check_circle' };
    else if (margenPct >= 10) salud = { color: '#b45309', bg: '#fef3c7', label: 'Bajo',      icon: 'warning' };
    else                      salud = { color: '#b91c1c', bg: '#fee2e2', label: 'Critico',   icon: 'error' };
  }

  // Top 3 productos por ingreso
  const top3 = productos.slice(0, 3);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" id="cierreModal" style="max-width:760px">
      <!-- Header con gradiente + metadatos -->
      <div class="modal-header" style="background:linear-gradient(135deg,#0f172a,#1e293b,#334155);color:white;border-radius:12px 12px 0 0;padding:18px 24px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:14px">
            <div style="width:44px;height:44px;border-radius:12px;background:rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,0.15)">
              <span class="material-icons" style="color:#cbd5e1">receipt_long</span>
            </div>
            <div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <h3 style="color:white;margin:0;font-size:18px">Cierre #${c.session_id || c.register_id || '-'}</h3>
                ${c.pcs && c.pcs.length > 1 ? `<span style="background:rgba(148,163,184,0.25);color:#e2e8f0;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600">${c.pcs.length} PCs</span>` : ''}
                <span style="background:${salud.bg};color:${salud.color};font-size:10px;padding:3px 10px;border-radius:10px;font-weight:700;display:inline-flex;align-items:center;gap:4px">
                  <span class="material-icons" style="font-size:12px">${salud.icon}</span>${salud.label}
                </span>
              </div>
              <div style="font-size:12px;color:#94a3b8;margin-top:4px">${c.cajero || 'Sin cajero'} · ${duracion} de operacion · ${numVentas} ${numVentas === 1 ? 'venta' : 'ventas'}</div>
            </div>
          </div>
          <button class="modal-close" style="color:white;background:rgba(255,255,255,0.1);border-radius:8px;width:32px;height:32px;display:flex;align-items:center;justify-content:center"><span class="material-icons">close</span></button>
        </div>

        <!-- KPIs destacados -->
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px">
          <div style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px 12px">
            <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Total vendido</div>
            <div style="font-size:18px;font-weight:800;color:#fff;margin-top:3px">$${fmt(total)}</div>
          </div>
          <div style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px 12px">
            <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Ticket promedio</div>
            <div style="font-size:18px;font-weight:800;color:#fff;margin-top:3px">$${fmt(ticketPromedio)}</div>
          </div>
          <div style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px 12px">
            <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Margen</div>
            <div style="font-size:18px;font-weight:800;color:${ingresoConCosto > 0 ? (margenPct >= 25 ? '#34d399' : margenPct >= 10 ? '#fbbf24' : '#f87171') : '#94a3b8'};margin-top:3px">${ingresoConCosto > 0 ? margenPct.toFixed(1) + '%' : '—'}</div>
          </div>
          <div style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px 12px">
            <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Ganancia neta</div>
            <div style="font-size:18px;font-weight:800;color:${gananciaNeta >= 0 ? '#34d399' : '#f87171'};margin-top:3px">${gananciaNeta >= 0 ? '$' : '-$'}${fmt(Math.abs(gananciaNeta))}</div>
          </div>
        </div>
      </div>

      <div class="modal-body" style="padding:22px 24px">

        ${c.pendiente_conteo ? `
        <!-- Banner: cierre pendiente de conteo -->
        <div id="pendiente-banner" style="background:linear-gradient(135deg,#fef3c7,#fde68a);border:1.5px solid #f59e0b;border-radius:12px;padding:14px 18px;margin-bottom:18px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:10px">
              <span class="material-icons" style="color:#b45309">pending_actions</span>
              <div>
                <div style="font-size:13px;font-weight:800;color:#92400e">Cierre pendiente de conteo</div>
                <div style="font-size:11px;color:#a16207;margin-top:2px">${total === 0 ? 'Stats vacíos: recalculá desde ventas y después cargá el efectivo contado.' : 'Cargá el efectivo real contado para finalizar el cierre.'}</div>
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${total === 0 ? `
              <button id="btn-recalc-stats" style="background:#475569;color:white;border:none;border-radius:8px;padding:9px 14px;font-weight:700;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
                <span class="material-icons" style="font-size:16px">calculate</span>Recalcular stats
              </button>` : ''}
              <button id="btn-cargar-conteo" style="background:#d97706;color:white;border:none;border-radius:8px;padding:9px 16px;font-weight:700;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
                <span class="material-icons" style="font-size:16px">payments</span>Cargar efectivo contado
              </button>
            </div>
          </div>
          <div id="conteo-form" style="display:none;margin-top:12px;padding-top:12px;border-top:1px dashed #f59e0b">
            <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
              <div style="flex:1;min-width:180px">
                <label style="font-size:11px;color:#92400e;font-weight:700;display:block;margin-bottom:4px">Efectivo contado ($)</label>
                <input type="number" step="0.01" id="input-conteo" placeholder="0.00" value="${esperado.toFixed(2)}" style="width:100%;padding:10px 12px;font-size:14px;border:2px solid #d97706;border-radius:8px;outline:none;font-family:inherit">
                <div style="font-size:10px;color:#a16207;margin-top:4px">Esperado: $${fmt(esperado)}</div>
              </div>
              <button id="btn-guardar-conteo" style="background:#15803d;color:white;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer">Guardar</button>
              <button id="btn-cancelar-conteo" style="background:#e5e7eb;color:#374151;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer">Cancelar</button>
            </div>
          </div>
        </div>
        ` : ''}

        <!-- Linea temporal del turno -->
        <div style="background:#f8fafc;border-radius:12px;padding:14px 18px;margin-bottom:22px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:180px">
            <div style="width:10px;height:10px;border-radius:50%;background:#0d6efd"></div>
            <div>
              <div style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Apertura</div>
              <div style="font-size:13px;font-weight:700;color:#1e293b">${fmtDT(apertura)}</div>
            </div>
          </div>
          <div style="flex:2;min-width:120px;display:flex;align-items:center;gap:8px;justify-content:center">
            <div style="flex:1;height:2px;background:linear-gradient(90deg,#0d6efd,#198754);border-radius:2px"></div>
            <div style="font-size:11px;color:#475569;font-weight:600;white-space:nowrap">${duracion}${ventasPorHora > 0 ? ` · ${ventasPorHora.toFixed(1)} v/h` : ''}</div>
            <div style="flex:1;height:2px;background:linear-gradient(90deg,#0d6efd,#198754);border-radius:2px"></div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:180px;justify-content:flex-end">
            <div style="text-align:right">
              <div style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Cierre</div>
              <div style="font-size:13px;font-weight:700;color:#1e293b">${fmtDT(cierre)}</div>
            </div>
            <div style="width:10px;height:10px;border-radius:50%;background:#198754"></div>
          </div>
        </div>

        <!-- Ventas por tipo de pago -->
        <div style="margin-bottom:22px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#64748b;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0">Ventas por tipo de pago</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center">
              <div>
                <div style="font-size:11px;color:#166534;font-weight:700">Efectivo</div>
                <div style="font-size:11px;color:#64748b;margin-top:2px">${c.num_ventas_efectivo || 0} ${(c.num_ventas_efectivo || 0) === 1 ? 'venta' : 'ventas'}${total > 0 ? ` · ${Math.round((efectivo/total)*100)}%` : ''}</div>
              </div>
              <div style="font-size:18px;font-weight:800;color:#198754">$${fmt(efectivo)}</div>
            </div>
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center">
              <div>
                <div style="font-size:11px;color:#1e40af;font-weight:700">Transferencia</div>
                <div style="font-size:11px;color:#64748b;margin-top:2px">${c.num_ventas_transferencia || 0} ${(c.num_ventas_transferencia || 0) === 1 ? 'venta' : 'ventas'}${total > 0 ? ` · ${Math.round((transf/total)*100)}%` : ''}</div>
              </div>
              <div style="font-size:18px;font-weight:800;color:#0d6efd">$${fmt(transf)}</div>
            </div>
          </div>
        </div>

        <!-- Rentabilidad del turno -->
        <div style="margin-bottom:22px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#64748b;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0">Rentabilidad del turno</div>
          <div style="background:#fafbfc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px">
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
              <div>
                <div style="font-size:10px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Ingreso c/costo</div>
                <div style="font-size:16px;font-weight:700;color:#1e293b;margin-top:3px">$${fmt(ingresoConCosto)}</div>
                <div style="font-size:10px;color:#94a3b8">${Math.round(pctConCosto)}% del total</div>
              </div>
              <div>
                <div style="font-size:10px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Costo (CMV)</div>
                <div style="font-size:16px;font-weight:700;color:#c2410c;margin-top:3px">-$${fmt(cmv)}</div>
                <div style="font-size:10px;color:#94a3b8">costo de los productos</div>
              </div>
              <div>
                <div style="font-size:10px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Ganancia bruta</div>
                <div style="font-size:16px;font-weight:700;color:${gananciaBruta>=0?'#15803d':'#b91c1c'};margin-top:3px">$${fmt(gananciaBruta)}</div>
                <div style="font-size:10px;color:#94a3b8">margen ${margenPct.toFixed(1)}%</div>
              </div>
            </div>
            <div style="border-top:1px dashed #cbd5e1;margin:12px 0 10px"></div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                <span style="font-size:12px;color:#475569">Bruta <b style="color:${gananciaBruta>=0?'#15803d':'#b91c1c'}">$${fmt(gananciaBruta)}</b></span>
                ${gastoTotal > 0 ? `<span style="font-size:12px;color:#475569">− Gastos <b style="color:#dc2626">$${fmt(gastoTotal)}</b></span>` : ''}
                <span style="font-size:12px;color:#475569">=</span>
              </div>
              <div style="background:${gananciaNeta>=0?'#ecfdf5':'#fef2f2'};border:2px solid ${gananciaNeta>=0?'#10b981':'#ef4444'};border-radius:10px;padding:8px 14px;display:flex;align-items:center;gap:8px">
                <span style="font-size:10px;font-weight:700;color:${gananciaNeta>=0?'#047857':'#991b1b'};text-transform:uppercase;letter-spacing:.4px">Ganancia neta</span>
                <span style="font-size:17px;font-weight:800;color:${gananciaNeta>=0?'#047857':'#b91c1c'}">${gananciaNeta>=0?'$':'-$'}${fmt(Math.abs(gananciaNeta))}</span>
              </div>
            </div>
          </div>
          ${itemsSinCosto > 0 ? `
          <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:8px 12px;display:flex;align-items:center;gap:8px;font-size:12px;color:#92400e;margin-top:10px">
            <span class="material-icons" style="font-size:16px;color:#d97706">warning</span>
            <span><b>${itemsSinCosto}</b> producto${itemsSinCosto===1?'':'s'} sin costo cargado ($${fmt(ingresoSinCosto)} en ventas). Cargalos en Control Total para mejorar el calculo.</span>
          </div>` : ''}
        </div>

        <!-- Resumen de efectivo -->
        <div style="margin-bottom:22px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#64748b;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0">Resumen de efectivo</div>
          <div style="background:#fafbfc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 20px">
              ${lineaEf('Monto inicial', `$${fmt(inicial)}`, '#475569')}
              ${lineaEf('+ Ventas efectivo', `$${fmt(efectivo)}`, '#198754')}
              ${retiros > 0 ? lineaEf('− Retiros', `$${fmt(retiros)}`, '#dc3545') : ''}
              ${lineaEf('= Efectivo esperado', `$${fmt(esperado)}`, '#1e293b', true)}
            </div>
            ${final_amt > 0 ? `
              <div style="border-top:1px dashed #cbd5e1;margin:12px 0 10px"></div>
              <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
                <div>
                  <div style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.4px">Efectivo contado</div>
                  <div style="font-size:16px;font-weight:700;color:#1e293b">$${fmt(final_amt)}</div>
                </div>
                <div style="background:${diff >= 0 ? '#f0fdf4' : '#fef2f2'};border:1px solid ${diff >= 0 ? '#bbf7d0' : '#fecaca'};border-radius:10px;padding:8px 14px;display:flex;align-items:center;gap:8px">
                  <span class="material-icons" style="font-size:16px;color:${diff >= 0 ? '#15803d' : '#b91c1c'}">${diff >= 0 ? 'check_circle' : 'error'}</span>
                  <div>
                    <div style="font-size:10px;font-weight:700;color:${diff >= 0 ? '#15803d' : '#b91c1c'};text-transform:uppercase">${diff === 0 ? 'Exacto' : diff > 0 ? 'Sobrante' : 'Faltante'}</div>
                    <div style="font-size:14px;font-weight:800;color:${diff >= 0 ? '#15803d' : '#b91c1c'}">${diff === 0 ? '$0,00' : (diff > 0 ? '+' : '-') + '$' + fmt(Math.abs(diff))}</div>
                  </div>
                </div>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Productos vendidos -->
        ${productos.length > 0 ? `
        <div style="margin-bottom:22px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#64748b">Productos vendidos <span style="color:#94a3b8;font-weight:600">(${productos.length})</span></div>
            <div style="font-size:11px;color:#94a3b8">Ordenados por ingreso</div>
          </div>
          ${top3.length > 0 ? `
          <div style="display:grid;grid-template-columns:repeat(${Math.min(top3.length,3)},1fr);gap:8px;margin-bottom:10px">
            ${top3.map((p, i) => {
              const medal = ['#fbbf24','#94a3b8','#d97706'][i];
              return `
              <div style="background:#fafbfc;border:1px solid #e2e8f0;border-left:3px solid ${medal};border-radius:8px;padding:8px 12px">
                <div style="font-size:10px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.4px">#${i+1} mas vendido</div>
                <div style="font-size:12px;font-weight:700;color:#1e293b;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${p._nombre}">${p._nombre}</div>
                <div style="font-size:11px;color:#475569;margin-top:2px">${p._cantidad} u. · <b style="color:#198754">$${fmt(p._ingreso)}</b></div>
              </div>`;
            }).join('')}
          </div>` : ''}
          <div style="max-height:280px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:10px">
            <table style="width:100%;border-collapse:collapse;font-size:12.5px">
              <thead>
                <tr style="background:#f8fafc;position:sticky;top:0;z-index:1">
                  <th style="padding:9px 10px;text-align:left;font-weight:700;color:#475569;border-bottom:1px solid #e2e8f0">Producto</th>
                  <th style="padding:9px 10px;text-align:center;font-weight:700;color:#475569;border-bottom:1px solid #e2e8f0">Cant.</th>
                  <th style="padding:9px 10px;text-align:right;font-weight:700;color:#475569;border-bottom:1px solid #e2e8f0">Ingreso</th>
                  <th style="padding:9px 10px;text-align:right;font-weight:700;color:#475569;border-bottom:1px solid #e2e8f0">Costo</th>
                  <th style="padding:9px 10px;text-align:right;font-weight:700;color:#475569;border-bottom:1px solid #e2e8f0">Ganancia</th>
                </tr>
              </thead>
              <tbody>
                ${productos.map((p, i) => {
                  const sinCosto = p._costoUnit === 0;
                  return `
                  <tr style="background:${i % 2 === 0 ? 'white' : '#f8fafc'}">
                    <td style="padding:8px 10px;color:#1e293b;font-weight:500">${p._nombre}</td>
                    <td style="padding:8px 10px;text-align:center;color:#475569">${p._cantidad}</td>
                    <td style="padding:8px 10px;text-align:right;font-weight:700;color:#198754">$${fmt(p._ingreso)}</td>
                    <td style="padding:8px 10px;text-align:right;color:${sinCosto?'#d97706':'#64748b'};${sinCosto?'font-style:italic':''}">
                      ${sinCosto ? '—' : '$'+fmt(p._costoTot)}
                    </td>
                    <td style="padding:8px 10px;text-align:right;font-weight:700;color:${sinCosto?'#94a3b8':(p._ganancia>=0?'#15803d':'#b91c1c')}">
                      ${sinCosto ? '<span title="sin costo cargado">s/c</span>' : `$${fmt(p._ganancia)}${p._margenPct!=null?` <span style="font-size:10px;color:#94a3b8;font-weight:600">(${p._margenPct.toFixed(0)}%)</span>`:''}`}
                    </td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
        ` : ''}

        <!-- Gastos + Retiros (side by side si ambos existen) -->
        ${(gastosTurno.length > 0 || retiros_lista.length > 0) ? `
        <div style="display:grid;grid-template-columns:${(gastosTurno.length > 0 && retiros_lista.length > 0) ? '1fr 1fr' : '1fr'};gap:16px;margin-bottom:22px">
          ${gastosTurno.length > 0 ? `
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#64748b;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0">Gastos del turno <span style="color:#94a3b8;font-weight:600">(${gastosTurno.length})</span></div>
            ${gastosTurno.map(g => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;margin-bottom:6px">
                <div style="min-width:0;flex:1">
                  <div style="font-size:12px;font-weight:600;color:#991b1b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${g.descripcion || '-'}</div>
                  <div style="font-size:10px;color:#64748b">${g.fecha || ''}${g.tipo ? ' · ' + g.tipo : ''}</div>
                </div>
                <div style="font-size:14px;font-weight:700;color:#dc3545;white-space:nowrap;margin-left:8px">-$${fmt(g.monto)}</div>
              </div>
            `).join('')}
          </div>` : ''}
          ${retiros_lista.length > 0 ? `
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#64748b;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0">Retiros de caja <span style="color:#94a3b8;font-weight:600">(${retiros_lista.length})</span></div>
            ${retiros_lista.map(r => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;margin-bottom:6px">
                <div style="min-width:0;flex:1">
                  <div style="font-size:12px;font-weight:600;color:#991b1b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.reason || r.motivo || 'Retiro'}</div>
                  <div style="font-size:10px;color:#64748b">${r.created_at ? fmtDT(parseArDate(r.created_at)) : ''}</div>
                </div>
                <div style="font-size:14px;font-weight:700;color:#dc3545;white-space:nowrap;margin-left:8px">-$${fmt(r.amount || r.monto || 0)}</div>
              </div>
            `).join('')}
          </div>` : ''}
        </div>
        ` : ''}

      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });

  // Wire-up: cargar efectivo contado (solo si pendiente_conteo)
  const btnCargar = overlay.querySelector('#btn-cargar-conteo');
  if (btnCargar && db) {
    const formEl = overlay.querySelector('#conteo-form');
    const inputEl = overlay.querySelector('#input-conteo');
    btnCargar.addEventListener('click', () => {
      formEl.style.display = 'block';
      btnCargar.style.display = 'none';
      inputEl.focus();
      inputEl.select();
    });
    overlay.querySelector('#btn-cancelar-conteo').addEventListener('click', () => {
      formEl.style.display = 'none';
      btnCargar.style.display = 'flex';
    });
    const btnGuardar = overlay.querySelector('#btn-guardar-conteo');
    const guardar = async () => {
      const val = parseFloat(inputEl.value);
      if (isNaN(val) || val < 0) { inputEl.focus(); return; }
      btnGuardar.disabled = true; btnGuardar.textContent = 'Guardando...';
      try {
        const docs = c._docs || [];
        const diferencia = val - esperado;
        const nowIso = new Date().toISOString();
        for (let i = 0; i < docs.length; i++) {
          const d = docs[i];
          if (!d.id) continue;
          await updateDoc(doc(db, 'cierres_caja', d.id), {
            monto_final:      i === 0 ? val : 0,
            diferencia:       i === 0 ? diferencia : 0,
            pendiente_conteo: false,
            updated_at:       nowIso,
          });
        }
        invalidateCache('cierres:caja');
        overlay.remove();
        if (typeof onSaved === 'function') onSaved();
      } catch (e) {
        btnGuardar.disabled = false; btnGuardar.textContent = 'Guardar';
        alert('Error al guardar: ' + (e?.message || e));
      }
    };
    btnGuardar.addEventListener('click', guardar);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') guardar(); });
  }

  // Wire-up: recalcular stats (solo si total_ventas == 0 y pendiente_conteo)
  const btnRecalc = overlay.querySelector('#btn-recalc-stats');
  if (btnRecalc && db) {
    btnRecalc.addEventListener('click', async () => {
      if (!confirm('Esto va a recalcular ingreso, transferencia, transacciones y productos vendidos desde la colección ventas. ¿Continuar?')) return;
      btnRecalc.disabled = true;
      btnRecalc.innerHTML = '<span class="material-icons" style="font-size:16px">hourglass_empty</span>Recalculando...';
      try {
        // El register_id puede venir en c.register_id o en algun doc del session.
        // Para sesiones agrupadas tomamos el primer doc con register_id.
        const docCierre = (c._docs || []).find(d => d.register_id != null) || c;
        const regId = docCierre.register_id;
        if (!regId) throw new Error('No se encontró register_id en este cierre.');
        const result = await calcularYMergearStatsCaja(db, regId, {
          monto_inicial: docCierre.monto_inicial || 0,
          cajero:        docCierre.cajero || '',
          retiros:       docCierre.retiros || [],
          total_retiros: docCierre.total_retiros || 0,
          updated_at:    new Date().toISOString(),
        });
        invalidateCache('cierres:caja');
        overlay.remove();
        if (typeof onSaved === 'function') onSaved();
        setTimeout(() => {
          alert(`Stats recalculados: $${fmt(result.total_ventas)} en ${result.total_transacciones} ventas.`);
        }, 200);
      } catch (e) {
        btnRecalc.disabled = false;
        btnRecalc.innerHTML = '<span class="material-icons" style="font-size:16px">calculate</span>Recalcular stats';
        alert('Error al recalcular: ' + (e?.message || e));
      }
    });
  }
}

function lineaEf(label, valor, color = '#1e293b', bold = false) {
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;${bold ? 'padding-top:6px;border-top:1px dashed #e2e8f0;' : ''}">
      <span style="font-size:12px;color:#64748b;${bold ? 'font-weight:700;color:#475569' : ''}">${label}</span>
      <span style="font-size:${bold ? '14px' : '13px'};font-weight:${bold ? '800' : '600'};color:${color}">${valor}</span>
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

// Fechas guardadas por Python con timezone AR → Firestore las almacena como UTC correcto → no necesita compensación
function parseArDate(val) {
  if (!val) return null;
  if (typeof val.toDate === 'function') return val.toDate();
  if (typeof val === 'object' && val.seconds !== undefined)
    return new Date(val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1e6));
  return new Date(val);
}

function fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDT(d) {
  if (!d || isNaN(d)) return '-';
  const opts = { timeZone: 'America/Argentina/Buenos_Aires' };
  return d.toLocaleDateString('es-AR', opts) + ' ' + d.toLocaleTimeString('es-AR', { ...opts, hour: '2-digit', minute: '2-digit', hour12: false });
}
