import { collection, getDocs, query, orderBy, where, limit, doc, updateDoc, setDoc, getDoc, runTransaction, Timestamp, writeBatch } from 'firebase/firestore';
import { getCached, invalidateCache } from '../cache.js';
import { getFechaInicioDate, getFechaInicio, isVentaVarios2, isItemVarios2, fechaDMYtoYMD } from '../config.js';
import { confirmDialog, alertDialog, escHtml } from '../components/dialogs.js';
// Cómo se reparte cada renglón entre efectivo y transferencia. La regla vive
// ahí y tiene gemelo en `pos_system/utils/medios_de_pago.py`, que es el que
// arma el mismo cierre desde el POS. Ver tienda/pruebas/medios_pago.test.js.
import { repartoDeItem } from '../medios_de_pago.js';
// Los renglones fraccionados llegan con el nombre decorado y no cruzan contra
// el catálogo si se los busca tal cual.
import { buscarPorNombre } from '../nombre_item.js';

export async function renderCierres(container, db) {
  // Shell vacío al toque: filtros + tabla con headers reales.
  container.innerHTML = `
    <div class="filter-bar">
      <input type="text" placeholder="Buscar cajero..." style="width:200px" disabled />
      <input type="date" disabled />
      <input type="date" disabled />
      <select disabled><option>Todas las cajas</option></select>
    </div>
    <div class="table-card">
      <div class="table-card-header">
        <h3>Cierres de Caja</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Apertura</th><th>Cierre</th>
            <th style="text-align:center">Ventas</th>
            <th>Total</th><th>Efectivo</th>
            <th>Transferencia</th><th>Retiros</th><th>Cajero</th>
          </tr></thead>
          <tbody>
            ${Array(8).fill('<tr><td colspan="9" style="padding:6px 12px"><div class="skel" style="height:28px;border-radius:6px"></div></td></tr>').join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  const fechaInicio    = await getFechaInicioDate(db);
  const fechaInicioStr = await getFechaInicio(db);

  // TTL corto: la caja abierta es crítica y debe reflejarse casi en tiempo real.
  // Catálogo + gastos se usan en el modal de cierre para calcular rentabilidad.
  // `ventas_por_dia` es la fuente de verdad para los totales (misma que Historial):
  // los campos total_* guardados en cierres_caja pueden quedar stale si una caja
  // multi-PC se cierra desde una sola PC y las demás siguen vendiendo → acá los
  // ignoramos y recomputamos por rango [apertura, cierre] contra los items.
  const [todosRaw, catalogo, gastosAll, itemsRaw, cajaActivaSnap] = await Promise.all([
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
    getCached('historial:ventas_dia:v3', async () => {
      const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha', 'desc')));
      return snap.docs.map(d => {
        const data  = d.data();
        const parts = d.id.split('_');
        const pcId  = parts.length >= 3 ? parts.slice(0, -2).join('_') : '';
        return { ...data, _pc_id: pcId };
      });
    }, { ttl: 60 * 1000 }),
    // caja_activa/current es la fuente de verdad sobre cuál caja está REALMENTE
    // abierta. Si un doc fantasma de cierres_caja quedó con fecha_cierre vacía
    // (bug: una PC desktop reabre su caja vieja pisando un cierre), la ignoramos.
    // Se lee del store (key pinned 'caja_activa:current', listener realtime) para
    // que el estado abierta/cerrada se refleje en vivo y el primer paint salga del
    // snapshot del server, no del cache stale del getDoc one-shot. El fetcher de
    // abajo es solo fallback si el store todavía no respondió.
    getCached('caja_activa:current', async () => {
      const s = await getDoc(doc(db, 'caja_activa', 'current'));
      return s.exists() ? s.data() : null;
    }, { ttl: 30 * 1000 }),
  ]);

  // ── Items normalizados ────────────────────────────────────────────────
  // Cada item de `ventas_por_dia` lleva su `cash_register_id` (las ventas
  // nuevas) → permite atribuir el item a SU caja sin doble suma cuando hay
  // cajas que se solapan. Items viejos no tienen ese campo → fallback al
  // rango temporal por día.
  const items = itemsRaw
    .filter(it => {
      if (it.deleted === true) return false;
      if (isItemVarios2(it)) return false;
      return fechaDMYtoYMD(it.fecha) >= fechaInicioStr;
    })
    .map(it => {
      let dt = null;
      if (it.fecha_dt) {
        dt = typeof it.fecha_dt.toDate === 'function' ? it.fecha_dt.toDate()
           : it.fecha_dt.seconds !== undefined
             ? new Date(it.fecha_dt.seconds * 1000 + Math.floor((it.fecha_dt.nanoseconds || 0) / 1e6))
             : new Date(it.fecha_dt);
        if (dt && isNaN(dt)) dt = null;
      }
      if (!dt) {
        const ymd = fechaDMYtoYMD(it.fecha);
        const hora = (it.hora || '00:00:00').padEnd(8, ':00').slice(0, 8);
        if (ymd) {
          const parsed = new Date(`${ymd}T${hora}-03:00`);
          if (!isNaN(parsed)) dt = parsed;
        }
      }
      // cash_register_id puede venir como number, string, o ausente (ventas viejas).
      let crId = it.cash_register_id;
      if (crId !== null && crId !== undefined && crId !== '') {
        const n = Number(crId);
        crId = Number.isFinite(n) ? n : null;
      } else {
        crId = null;
      }
      return {
        pc_id:             it._pc_id || it.pc_id || '',
        num_venta:         it.num_venta,
        subtotal:          Number(it.subtotal || 0),
        cantidad:          Number(it.cantidad || 0),
        tipo_pago:         it.tipo_pago || '',
        // Reparto entre los dos medios de pago, tal como lo dejó el POS. Los
        // renglones viejos no lo traen y `repartoDeItem` cae al tipo_pago.
        monto_efectivo:      it.monto_efectivo,
        monto_transferencia: it.monto_transferencia,
        producto:          it.producto || it.product_name || '-',
        fecha_dt:          dt,
        fecha_ymd:         fechaDMYtoYMD(it.fecha),  // 'YYYY-MM-DD' del día de la venta
        cash_register_id:  crId,
      };
    });

  // Agrega items cuyo `fecha_dt` cae en [apertura, cierre] (caja abierta actual).
  // Solo se usa para la tarjeta "Caja Abierta" — ahí sí queremos rango temporal.
  function aggregateInRange(apertura, cierre) {
    const ini = apertura && !isNaN(apertura) ? apertura.getTime() : -Infinity;
    const fin = cierre   && !isNaN(cierre)   ? cierre.getTime()   : Infinity;
    let total_efectivo = 0, total_transferencia = 0;
    const ventasEf = new Set();
    const ventasTr = new Set();
    const ventas   = new Set();
    const prodMap  = {};
    for (const it of items) {
      if (!it.fecha_dt) continue;
      const t = it.fecha_dt.getTime();
      if (t < ini || t > fin) continue;
      const parte = repartoDeItem(it);
      const key   = `${it.pc_id}|${it.num_venta}`;
      total_efectivo      += parte.efectivo;
      total_transferencia += parte.transferencia;
      ventas.add(key);
      if (parte.efectivo)      ventasEf.add(key);
      if (parte.transferencia) ventasTr.add(key);
      if (!prodMap[it.producto]) {
        prodMap[it.producto] = { product_name: it.producto, total_quantity: 0, total_amount: 0 };
      }
      prodMap[it.producto].total_quantity += it.cantidad || 1;
      prodMap[it.producto].total_amount   += it.subtotal;
    }
    return {
      total_ventas:             total_efectivo + total_transferencia,
      total_efectivo,
      total_transferencia,
      num_ventas_efectivo:      ventasEf.size,
      num_ventas_transferencia: ventasTr.size,
      // Ventas distintas, no la suma: una mixta figura en las dos listas
      // porque dejó plata en las dos.
      total_transacciones:      ventas.size,
      productos_vendidos:       Object.values(prodMap).sort((a, b) => b.total_amount - a.total_amount),
    };
  }

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

  // Separar cajas abiertas (sin fecha_cierre) de las cerradas.
  // Filtro adicional: solo aceptamos como "abierta" la que matchea
  // caja_activa/current.id. Así, si un doc fantasma quedó sin fecha_cierre (bug
  // de PC vieja que reabre su caja pisando un cierre), lo tratamos como
  // cerrada para la UI (no se suma a la tarjeta "Caja Abierta").
  const cajaActivaId = (cajaActivaSnap && cajaActivaSnap.status === 'open')
    ? (cajaActivaSnap.register_id != null ? String(cajaActivaSnap.register_id)
        : (cajaActivaSnap.id != null ? String(cajaActivaSnap.id) : null))
    : null;
  const cajasAbiertasRaw = todos.filter(c => {
    const sinCierre = !c.fecha_cierre || c.fecha_cierre === null || c.fecha_cierre === '';
    if (!sinCierre) return false;
    // Si caja_activa/current dice que la única abierta es otra, descartamos.
    if (cajaActivaId && c.register_id != null && String(c.register_id) !== cajaActivaId) {
      return false;
    }
    return true;
  });
  const _seenReg = new Set();
  const cajasAbiertas = [];
  for (const c of cajasAbiertasRaw) {
    const key = c.register_id != null ? String(c.register_id) : `_doc_${c.id}`;
    if (_seenReg.has(key)) continue;
    _seenReg.add(key);
    cajasAbiertas.push(c);
  }
  // Los docs filtrados (fantasmas reabiertos) los contamos como cerrados igual,
  // para que no desaparezcan de la tabla — usamos su fecha_cierre original si
  // la tienen, o la apertura como fallback (caso raro).
  const cierres = todos.filter(c => {
    if (c.fecha_cierre && c.fecha_cierre !== '') return true;
    if (cajaActivaId && c.register_id != null && String(c.register_id) !== cajaActivaId) {
      return true;  // fantasma: tratarla como cerrada para que aparezca en la tabla
    }
    return false;
  });

  // Caja abierta consolidada: totales computados desde `ventas_por_dia` en el
  // rango [apertura_mas_temprana, ahora]. Ignora los totales guardados en los
  // docs de cierres_caja (que pueden estar stale si no sincronizó una PC).
  let cajaAbierta = null;
  if (cajasAbiertas.length > 0) {
    const fechaAperturaRaw = cajasAbiertas.reduce(
      (min, c) => (!min || toDate(c.fecha_apertura) < toDate(min) ? c.fecha_apertura : min), null
    );
    const fechaAperturaDate = toDate(fechaAperturaRaw);
    const agg = aggregateInRange(fechaAperturaDate, null);

    cajaAbierta = {
      cajero:              cajasAbiertas.map(c => c.cajero || c.pc_id || 'PC').join(', '),
      fecha_apertura:      fechaAperturaRaw,
      monto_inicial:       cajasAbiertas[0]?.monto_inicial || 0,
      total_ventas:        agg.total_ventas,
      total_efectivo:      agg.total_efectivo,
      total_transferencia: agg.total_transferencia,
      total_retiros:       cajasAbiertas.reduce((s, c) => s + (c.total_retiros || 0), 0),
      total_transacciones: agg.total_transacciones,
      productos_vendidos:  agg.productos_vendidos,
      retiros:             cajasAbiertas.flatMap(c => c.retiros || []),
      _pcs:                cajasAbiertas.length,
    };
  }

  // Una fila por caja-doc (sin agrupar). El total proviene de los items
  // atribuidos a esa caja vía cash_register_id en ventas_por_dia — así una
  // caja multi-PC con su propio register_id se ve aparte y los totales no
  // se mezclan.
  // Para datos viejos (cierres_caja sin register_id consolidado), conservamos
  // los stats guardados en el doc; los recomputamos solo cuando hay un
  // register_id válido para filtrar.
  const sesiones = cierres.map(c => {
    const registerId = (c.register_id != null && c.register_id !== '') ? Number(c.register_id) : null;
    const s = {
      register_id:      registerId,
      fecha_apertura:   c.fecha_apertura,
      fecha_cierre:     c.fecha_cierre,
      cajero:           c.cajero || '-',
      pcs:              c.pc_id ? [c.pc_id] : [],
      monto_inicial:    Number(c.monto_inicial || 0),
      total_retiros:    Number(c.total_retiros || 0),
      monto_final:      Number(c.monto_final || 0),
      retiros:          c.retiros || [],
      pendiente_conteo: c.pendiente_conteo === true,
      _docs:            [c],
    };
    // Recomputar stats desde ventas_por_dia por register_id (fuente correcta:
    // las ventas llevan el cash_register_id que se setteó al momento de venta).
    // Si la caja no tiene register_id, caemos a los stats guardados en el doc.
    let dayOfMostVentas = null;
    if (registerId != null && Number.isFinite(registerId)) {
      let total_efectivo = 0, total_transferencia = 0;
      const ventasEf = new Set();
      const ventasTr = new Set();
      const ventas   = new Set();
      const prodMap  = {};
      const ventasPorDia = {};  // ymd -> total
      for (const it of items) {
        if (it.cash_register_id !== registerId) continue;
        const parte = repartoDeItem(it);
        const key   = `${it.pc_id}|${it.num_venta}`;
        total_efectivo      += parte.efectivo;
        total_transferencia += parte.transferencia;
        ventas.add(key);
        if (parte.efectivo)      ventasEf.add(key);
        if (parte.transferencia) ventasTr.add(key);
        if (!prodMap[it.producto]) prodMap[it.producto] = { product_name: it.producto, total_quantity: 0, total_amount: 0 };
        prodMap[it.producto].total_quantity += it.cantidad || 1;
        prodMap[it.producto].total_amount   += it.subtotal;
        if (it.fecha_ymd) ventasPorDia[it.fecha_ymd] = (ventasPorDia[it.fecha_ymd] || 0) + it.subtotal;
      }
      s.total_efectivo           = total_efectivo;
      s.total_transferencia      = total_transferencia;
      s.total_ventas             = total_efectivo + total_transferencia;
      s.num_ventas_efectivo      = ventasEf.size;
      s.num_ventas_transferencia = ventasTr.size;
      s.total_transacciones      = ventas.size;
      s.productos_vendidos       = Object.values(prodMap).sort((a, b) => b.total_amount - a.total_amount);
      // Día operacional = el de mayor venta dentro de los items de esta caja.
      const top = Object.entries(ventasPorDia).sort((a, b) => b[1] - a[1])[0];
      if (top) dayOfMostVentas = top[0];
    } else {
      // Compat: usar los stats del doc cuando no hay register_id para filtrar
      s.total_efectivo           = Number(c.total_efectivo || 0);
      s.total_transferencia      = Number(c.total_transferencia || 0);
      s.total_ventas             = Number(c.total_ventas || 0);
      s.num_ventas_efectivo      = Number(c.num_ventas_efectivo || 0);
      s.num_ventas_transferencia = Number(c.num_ventas_transferencia || 0);
      s.total_transacciones      = Number(c.total_transacciones || 0);
      s.productos_vendidos       = c.productos_vendidos || [];
    }
    s.monto_esperado = (s.monto_inicial || 0) + s.total_efectivo - (s.total_retiros || 0);
    // Label de la fila: día con más ventas. Si no hay ventas, apertura. Si no, session_id.
    s.session_id = dayOfMostVentas || aperturaDayKey(c.fecha_apertura) || c.session_id || c.id;
    return s;
  })
  // Sort por DÍA OPERACIONAL (label) DESC; desempate por cierre DESC.
  // Así "2026-05-20" siempre queda arriba de "2026-05-16" aunque ambas cajas
  // hayan cerrado en el mismo minuto del 20/5.
  .sort((a, b) => {
    if (a.session_id !== b.session_id) {
      return (b.session_id || '').localeCompare(a.session_id || '');
    }
    return (toDate(b.fecha_cierre) || 0) - (toDate(a.fecha_cierre) || 0);
  });

  const totalCierres = sesiones.length;
  // Tarjetas "TOTAL ACUMULADO": suma directa de las filas (ya sin overlap,
  // cada item entra una sola vez vía su cash_register_id único).
  let totalVentas = 0, totalEfect = 0, totalTransf = 0;
  for (const s of sesiones) {
    totalVentas += s.total_ventas;
    totalEfect  += s.total_efectivo;
    totalTransf += s.total_transferencia;
  }

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
            <div style="font-size:12px;color:var(--tint-green-fg);margin-top:2px">${cajaAbierta._pcs > 1 ? `${cajaAbierta._pcs} cajas activas · ` : `Cajero: ${cajaAbierta.cajero || 'Sin cajero'} · `}Abierta hace ${tiempoAbierto(cajaAbierta.fecha_apertura)}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div style="font-size:11px;color:var(--tint-green-fg)">Apertura: ${fmtDT(parseArDate(cajaAbierta.fecha_apertura))}</div>
          ${cajaAbiertaId != null ? `
          <button id="btn-cerrar-caja-web" style="background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:8px;padding:8px 14px;font-weight:700;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
            <span class="material-icons" style="font-size:16px">lock</span>Cerrar caja
          </button>` : ''}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-top:16px">
        <div style="background:rgba(255,255,255,0.1);border-radius:10px;padding:12px;border:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:11px;color:var(--tint-green-fg);font-weight:600">MONTO INICIAL</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px">$${fmt(cajaAbierta.monto_inicial || 0)}</div>
        </div>
        <div style="background:rgba(255,255,255,0.1);border-radius:10px;padding:12px;border:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:11px;color:var(--tint-green-fg);font-weight:600">VENTAS EN CURSO</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px">$${fmt(cajaAbierta.total_ventas || 0)}</div>
        </div>
        <div style="background:rgba(255,255,255,0.1);border-radius:10px;padding:12px;border:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:11px;color:var(--tint-green-fg);font-weight:600">EFECTIVO</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px">$${fmt(cajaAbierta.total_efectivo || 0)}</div>
        </div>
        <div style="background:rgba(255,255,255,0.1);border-radius:10px;padding:12px;border:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:11px;color:var(--tint-green-fg);font-weight:600">TRANSFERENCIAS</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px">$${fmt(cajaAbierta.total_transferencia || 0)}</div>
        </div>
        <div style="background:rgba(255,255,255,0.1);border-radius:10px;padding:12px;border:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:11px;color:var(--tint-green-fg);font-weight:600">TRANSACCIONES</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px">${cajaAbierta.total_transacciones || 0}</div>
        </div>
        <div style="background:rgba(255,255,255,0.1);border-radius:10px;padding:12px;border:1px solid rgba(255,255,255,0.15)">
          <div style="font-size:11px;color:var(--tint-green-fg);font-weight:600">RETIROS</div>
          <div style="font-size:20px;font-weight:800;margin-top:4px;color:${(cajaAbierta.total_retiros||0)>0?'#fca5a5':'var(--surface)'}">-$${fmt(cajaAbierta.total_retiros || 0)}</div>
        </div>
      </div>

      ${(cajaAbierta.retiros||[]).length > 0 ? `
      <div style="margin-top:12px">
        <div style="font-size:11px;color:#fca5a5;font-weight:700;margin-bottom:8px">RETIROS DE ESTA SESIÓN</div>
        ${(cajaAbierta.retiros||[]).map(r=>`
          <div style="display:flex;justify-content:space-between;background:rgba(239,68,68,0.2);border-radius:8px;padding:8px 12px;margin-bottom:4px;border:1px solid rgba(239,68,68,0.3)">
            <span style="font-size:12px;color:#fca5a5">${r.reason||r.motivo||'Retiro'}</span>
            <span style="font-weight:700;color:var(--tint-red-fg)">-$${fmt(r.amount||r.monto||0)}</span>
          </div>`).join('')}
      </div>` : ''}
    </div>
    ` : `
    <div style="background:var(--tint-green-bg);border:1px solid var(--border);border-radius:12px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="material-icons" style="color:var(--tint-green-fg)">lock</span>
        <span style="font-size:14px;color:var(--tint-green-fg);font-weight:600">No hay ninguna caja abierta. La próxima será la <b>#${proximoRegId}</b>.</span>
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
                  const pendBadge = c.pendiente_conteo ? ` <span style="background:var(--tint-yellow-bg);color:var(--tint-orange-fg);font-size:9px;padding:2px 7px;border-radius:6px;font-weight:800;letter-spacing:.3px;border:1px solid var(--border)">PENDIENTE</span>` : '';
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
        <div style="background:var(--tint-yellow-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;gap:10px">
          <span class="material-icons" style="color:var(--tint-orange-fg)">info</span>
          <div style="font-size:12.5px;color:var(--tint-orange-fg);line-height:1.45">
            La web calculará los totales desde las ventas y cerrará la caja.
            Las PCs conectadas también la marcarán como cerrada.
            Quedará <b>pendiente de conteo</b>: cargá después el efectivo real.
          </div>
        </div>
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px">¿Confirmás cerrar la caja <b>#${registerId}</b>?</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="btn-cancel-cerrar" style="background:var(--border);color:var(--text-muted);border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer">Cancelar</button>
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
      alertDialog({ title: 'Error', message: 'No se pudo cerrar la caja: ' + escHtml(e?.message || e), type: 'error' });
    }
  });
}

// ─── Helper: calcular stats desde ventas + ventas_por_dia y mergear ───────
// Usado al cerrar caja desde web Y al recalcular un cierre con stats vacíos.
// extras: campos extra a mergear al doc (fecha_cierre, pendiente_conteo, etc.)
async function calcularYMergearStatsCaja(db, registerId, extras = {}) {
  // ── Items de la caja desde `ventas_por_dia` ──
  // Antes leíamos `ventas` con limit(500): para una caja vieja (fuera de las
  // 500 más recientes) los stats salían 0 → cierre con 0 ventas falso.
  // Ahora vamos directo a `ventas_por_dia` filtrando por cash_register_id —
  // es la fuente con atribución correcta y sin limit artificial.
  const itemsSnap = await getDocs(query(
    collection(db, 'ventas_por_dia'),
    where('cash_register_id', '==', Number(registerId))
  ));

  let total_efectivo = 0, total_transferencia = 0;
  const ventasEf = new Set();
  const ventasTr = new Set();
  const ventas   = new Set();
  const productosMap = {};
  let lastItemDt = null;
  for (const d of itemsSnap.docs) {
    const it = d.data();
    if (it.deleted === true) continue;
    if (isItemVarios2(it)) continue;
    const subtotal = Number(it.subtotal || 0);
    // Clave única de venta: incluye pc del doc id para no colisionar entre PCs
    const parts = d.id.split('_');
    const pcId = parts.length >= 3 ? parts.slice(0, -2).join('_') : '';
    const nvKey = `${pcId}|${it.num_venta}`;
    const parte = repartoDeItem(it);
    total_efectivo      += parte.efectivo;
    total_transferencia += parte.transferencia;
    ventas.add(nvKey);
    if (parte.efectivo)      ventasEf.add(nvKey);
    if (parte.transferencia) ventasTr.add(nvKey);
    const nombre = (it.producto || it.product_name || '').trim();
    if (nombre) {
      if (!productosMap[nombre]) productosMap[nombre] = { product_name: nombre, total_quantity: 0, total_amount: 0 };
      productosMap[nombre].total_quantity += Number(it.cantidad || it.quantity || 0);
      productosMap[nombre].total_amount   += subtotal;
    }
    // Trackear hora del último item, para usar como fecha_cierre en auto-orphan
    let itDt = null;
    if (it.fecha_dt) {
      itDt = typeof it.fecha_dt.toDate === 'function' ? it.fecha_dt.toDate()
           : it.fecha_dt.seconds !== undefined
             ? new Date(it.fecha_dt.seconds * 1000)
             : new Date(it.fecha_dt);
    }
    if (!itDt && it.fecha) {
      const ymd = fechaDMYtoYMD(it.fecha);
      const hora = (it.hora || '20:00:00').padEnd(8, ':00').slice(0, 8);
      if (ymd) {
        const parsed = new Date(`${ymd}T${hora}-03:00`);
        if (!isNaN(parsed)) itDt = parsed;
      }
    }
    if (itDt && (!lastItemDt || itDt > lastItemDt)) lastItemDt = itDt;
  }
  const num_ventas_efectivo      = ventasEf.size;
  const num_ventas_transferencia = ventasTr.size;
  const total_ventas             = total_efectivo + total_transferencia;
  // Ventas distintas: una mixta aportó a las dos columnas y sumarlas la
  // contaría dos veces.
  const total_transacciones      = ventas.size;
  const monto_inicial = Number(extras.monto_inicial) || 0;
  const total_retiros = Number(extras.total_retiros) || 0;
  const monto_esperado = monto_inicial + total_efectivo - total_retiros;

  const productos_vendidos = Object.values(productosMap).sort((a, b) => b.total_amount - a.total_amount);

  // En auto-orphan: usar la hora de la última venta como fecha_cierre real
  // (no `now`). Refleja cuándo dejó de operar la caja, no cuándo se limpió.
  const finalExtras = { ...extras };
  if (extras.cerrado_desde === 'auto-orphan' && lastItemDt) {
    finalExtras.fecha_cierre = Timestamp.fromDate(lastItemDt);
  }

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
    ...finalExtras,
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
        <div style="background:var(--tint-green-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;gap:10px">
          <span class="material-icons" style="color:var(--tint-green-fg)">info</span>
          <div style="font-size:12.5px;color:var(--tint-green-fg);line-height:1.45">
            Esto abrirá la caja <b>#${sugerenciaId}</b> en todas las PCs.
            Las ventas que hagan se vincularán automáticamente a esta caja.
          </div>
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:12px;color:var(--text-muted);font-weight:700;display:block;margin-bottom:6px">Monto inicial ($)</label>
          <input type="number" step="0.01" id="abrir-monto" placeholder="0.00" value="0" style="width:100%;padding:10px 12px;font-size:14px;border:1.5px solid var(--border);border-radius:8px;outline:none;font-family:inherit">
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:12px;color:var(--text-muted);font-weight:700;display:block;margin-bottom:6px">Cajero / Notas (opcional)</label>
          <input type="text" id="abrir-notas" placeholder="Ej: Turno mañana - María" style="width:100%;padding:10px 12px;font-size:14px;border:1.5px solid var(--border);border-radius:8px;outline:none;font-family:inherit">
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="btn-cancel-abrir" style="background:var(--border);color:var(--text-muted);border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer">Cancelar</button>
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

      // Auto-cerrar huérfanos: docs en cierres_caja con fecha_cierre vacío y
      // register_id != newId. Quedan así si una caja se abandona sin cerrar
      // (PC offline, cierre fallido, etc.). Cada huérfano recibe stats
      // recalculados desde ventas_por_dia + fecha_cierre = ahora, así no
      // queda como fantasma con $0.
      try {
        const orphSnap = await getDocs(query(
          collection(db, 'cierres_caja'),
          where('fecha_cierre', '==', '')
        ));
        const orphans = orphSnap.docs.filter(d => {
          const data = d.data();
          const rid = data.register_id != null ? Number(data.register_id) : null;
          return rid !== null && rid !== Number(newId);
        });
        for (const d of orphans) {
          const data = d.data();
          await calcularYMergearStatsCaja(db, Number(data.register_id), {
            monto_inicial:    Number(data.monto_inicial) || 0,
            cajero:           data.cajero || '',
            retiros:          data.retiros || [],
            total_retiros:    Number(data.total_retiros) || 0,
            fecha_cierre:     nowTs,
            cerrado_desde:    'auto-orphan',
            pendiente_conteo: false,
            updated_at:       nowIso,
          });
        }
        if (orphans.length > 0) {
          console.log(`Auto-cerradas ${orphans.length} caja(s) huérfana(s) con stats recalculados:`,
            orphans.map(d => d.id));
        }
      } catch (e) {
        console.warn('No se pudieron auto-cerrar huérfanos:', e);
      }

      close();
      if (typeof onDone === 'function') onDone();
      // Pequeño delay para que el listener del desktop alcance a procesar
      setTimeout(() => {
        alertDialog({ title: 'Caja abierta', message: `Caja <b>#${escHtml(newId)}</b> abierta. Las PCs conectadas la detectarán en unos segundos.`, type: 'success' });
      }, 300);
    } catch (e) {
      btn.disabled = false; btn.innerHTML = '<span class="material-icons" style="font-size:16px">lock_open</span>Abrir caja';
      alertDialog({ title: 'Error', message: 'No se pudo abrir la caja: ' + escHtml(e?.message || e), type: 'error' });
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
    // Por el nombre limpio: lo que se vende fraccionado llega decorado
    // ("PAPEL A4 · 1 pack(s)") y no cruzaba contra el catálogo. Su costo
    // quedaba en cero y el turno lo contaba como "ingreso sin costo cargado"
    // teniendo el costo cargado desde siempre.
    const cat       = buscarPorNombre(catByName, p.product_name || p.nombre);
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
  let salud = { color: 'var(--text-muted)', bg: 'var(--surface-2)', label: 'S/D', icon: 'help_outline' };
  if (ingresoConCosto > 0) {
    if (margenPct >= 40)      salud = { color: 'var(--tint-green-fg)', bg: 'var(--tint-green-bg)', label: 'Excelente', icon: 'trending_up' };
    else if (margenPct >= 25) salud = { color: 'var(--tint-green-fg)', bg: 'var(--tint-green-bg)', label: 'Bueno',     icon: 'check_circle' };
    else if (margenPct >= 10) salud = { color: 'var(--tint-yellow-fg)', bg: 'var(--tint-yellow-bg)', label: 'Bajo',      icon: 'warning' };
    else                      salud = { color: 'var(--tint-red-fg)', bg: 'var(--tint-red-bg)', label: 'Critico',   icon: 'error' };
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
              <span class="material-icons" style="color:var(--text-muted)">receipt_long</span>
            </div>
            <div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <h3 style="color:white;margin:0;font-size:18px">Cierre #${c.session_id || c.register_id || '-'}</h3>
                ${c.pcs && c.pcs.length > 1 ? `<span style="background:rgba(148,163,184,0.25);color:#e2e8f0;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600">${c.pcs.length} PCs</span>` : ''}
                <span style="background:${salud.bg};color:${salud.color};font-size:10px;padding:3px 10px;border-radius:10px;font-weight:700;display:inline-flex;align-items:center;gap:4px">
                  <span class="material-icons" style="font-size:12px">${salud.icon}</span>${salud.label}
                </span>
              </div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${c.cajero || 'Sin cajero'} · ${duracion} de operacion · ${numVentas} ${numVentas === 1 ? 'venta' : 'ventas'}</div>
            </div>
          </div>
          <button class="modal-close" style="color:white;background:rgba(255,255,255,0.1);border-radius:8px;width:32px;height:32px;display:flex;align-items:center;justify-content:center"><span class="material-icons">close</span></button>
        </div>

        <!-- KPIs destacados -->
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px">
          <div style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px 12px">
            <div style="font-size:10px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px">Total vendido</div>
            <div style="font-size:18px;font-weight:800;color:#fff;margin-top:3px">$${fmt(total)}</div>
          </div>
          <div style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px 12px">
            <div style="font-size:10px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px">Ticket promedio</div>
            <div style="font-size:18px;font-weight:800;color:#fff;margin-top:3px">$${fmt(ticketPromedio)}</div>
          </div>
          <div style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px 12px">
            <div style="font-size:10px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px">Margen</div>
            <div style="font-size:18px;font-weight:800;color:${ingresoConCosto > 0 ? (margenPct >= 25 ? '#34d399' : margenPct >= 10 ? 'var(--tint-yellow-fg)' : 'var(--tint-red-fg)') : 'var(--text-muted)'};margin-top:3px">${ingresoConCosto > 0 ? margenPct.toFixed(1) + '%' : '—'}</div>
          </div>
          <div style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px 12px">
            <div style="font-size:10px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px">Ganancia neta</div>
            <div style="font-size:18px;font-weight:800;color:${gananciaNeta >= 0 ? '#34d399' : 'var(--tint-red-fg)'};margin-top:3px">${gananciaNeta >= 0 ? '$' : '-$'}${fmt(Math.abs(gananciaNeta))}</div>
          </div>
        </div>
      </div>

      <div class="modal-body" style="padding:22px 24px">

        ${c.pendiente_conteo ? `
        <!-- Banner: cierre pendiente de conteo -->
        <div id="pendiente-banner" style="background:linear-gradient(135deg,var(--tint-yellow-bg),var(--tint-yellow-bg));border:1.5px solid #f59e0b;border-radius:12px;padding:14px 18px;margin-bottom:18px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:10px">
              <span class="material-icons" style="color:var(--tint-orange-fg)">pending_actions</span>
              <div>
                <div style="font-size:13px;font-weight:800;color:var(--tint-orange-fg)">Cierre pendiente de conteo</div>
                <div style="font-size:11px;color:var(--tint-yellow-fg);margin-top:2px">${total === 0 ? 'Stats vacíos: recalculá desde ventas y después cargá el efectivo contado.' : 'Cargá el efectivo real contado para finalizar el cierre.'}</div>
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
                <label style="font-size:11px;color:var(--tint-orange-fg);font-weight:700;display:block;margin-bottom:4px">Efectivo contado ($)</label>
                <input type="number" step="0.01" id="input-conteo" placeholder="0.00" value="${esperado.toFixed(2)}" style="width:100%;padding:10px 12px;font-size:14px;border:2px solid #d97706;border-radius:8px;outline:none;font-family:inherit">
                <div style="font-size:10px;color:var(--tint-yellow-fg);margin-top:4px">Esperado: $${fmt(esperado)}</div>
              </div>
              <button id="btn-guardar-conteo" style="background:#15803d;color:white;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer">Guardar</button>
              <button id="btn-cancelar-conteo" style="background:var(--border);color:var(--text-muted);border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer">Cancelar</button>
            </div>
          </div>
        </div>
        ` : ''}

        <!-- Linea temporal del turno -->
        <div style="background:var(--surface-2);border-radius:12px;padding:14px 18px;margin-bottom:22px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:180px">
            <div style="width:10px;height:10px;border-radius:50%;background:#0d6efd"></div>
            <div>
              <div style="font-size:10px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px">Apertura</div>
              <div style="font-size:13px;font-weight:700;color:var(--text-strong)">${fmtDT(apertura)}</div>
            </div>
          </div>
          <div style="flex:2;min-width:120px;display:flex;align-items:center;gap:8px;justify-content:center">
            <div style="flex:1;height:2px;background:linear-gradient(90deg,#0d6efd,#198754);border-radius:2px"></div>
            <div style="font-size:11px;color:var(--text-muted);font-weight:600;white-space:nowrap">${duracion}${ventasPorHora > 0 ? ` · ${ventasPorHora.toFixed(1)} v/h` : ''}</div>
            <div style="flex:1;height:2px;background:linear-gradient(90deg,#0d6efd,#198754);border-radius:2px"></div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:180px;justify-content:flex-end">
            <div style="text-align:right">
              <div style="font-size:10px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px">Cierre</div>
              <div style="font-size:13px;font-weight:700;color:var(--text-strong)">${fmtDT(cierre)}</div>
            </div>
            <div style="width:10px;height:10px;border-radius:50%;background:#198754"></div>
          </div>
        </div>

        <!-- Ventas por tipo de pago -->
        <div style="margin-bottom:22px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)">Ventas por tipo de pago</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div style="background:var(--tint-green-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center">
              <div>
                <div style="font-size:11px;color:var(--tint-green-fg);font-weight:700">Efectivo</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${c.num_ventas_efectivo || 0} ${(c.num_ventas_efectivo || 0) === 1 ? 'venta' : 'ventas'}${total > 0 ? ` · ${Math.round((efectivo/total)*100)}%` : ''}</div>
              </div>
              <div style="font-size:18px;font-weight:800;color:var(--tint-green-fg)">$${fmt(efectivo)}</div>
            </div>
            <div style="background:var(--tint-blue-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center">
              <div>
                <div style="font-size:11px;color:var(--tint-blue-fg);font-weight:700">Transferencia</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${c.num_ventas_transferencia || 0} ${(c.num_ventas_transferencia || 0) === 1 ? 'venta' : 'ventas'}${total > 0 ? ` · ${Math.round((transf/total)*100)}%` : ''}</div>
              </div>
              <div style="font-size:18px;font-weight:800;color:var(--tint-blue-fg)">$${fmt(transf)}</div>
            </div>
          </div>
        </div>

        <!-- Rentabilidad del turno -->
        <div style="margin-bottom:22px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)">Rentabilidad del turno</div>
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:14px 16px">
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
              <div>
                <div style="font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Ingreso c/costo</div>
                <div style="font-size:16px;font-weight:700;color:var(--text-strong);margin-top:3px">$${fmt(ingresoConCosto)}</div>
                <div style="font-size:10px;color:var(--text-muted)">${Math.round(pctConCosto)}% del total</div>
              </div>
              <div>
                <div style="font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Costo (CMV)</div>
                <div style="font-size:16px;font-weight:700;color:var(--tint-orange-fg);margin-top:3px">-$${fmt(cmv)}</div>
                <div style="font-size:10px;color:var(--text-muted)">costo de los productos</div>
              </div>
              <div>
                <div style="font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Ganancia bruta</div>
                <div style="font-size:16px;font-weight:700;color:${gananciaBruta>=0?'var(--tint-green-fg)':'var(--tint-red-fg)'};margin-top:3px">$${fmt(gananciaBruta)}</div>
                <div style="font-size:10px;color:var(--text-muted)">margen ${margenPct.toFixed(1)}%</div>
              </div>
            </div>
            <div style="border-top:1px dashed var(--border);margin:12px 0 10px"></div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                <span style="font-size:12px;color:var(--text-muted)">Bruta <b style="color:${gananciaBruta>=0?'var(--tint-green-fg)':'var(--tint-red-fg)'}">$${fmt(gananciaBruta)}</b></span>
                ${gastoTotal > 0 ? `<span style="font-size:12px;color:var(--text-muted)">− Gastos <b style="color:var(--tint-red-fg)">$${fmt(gastoTotal)}</b></span>` : ''}
                <span style="font-size:12px;color:var(--text-muted)">=</span>
              </div>
              <div style="background:${gananciaNeta>=0?'var(--tint-green-bg)':'var(--tint-red-bg)'};border:2px solid ${gananciaNeta>=0?'#10b981':'#ef4444'};border-radius:10px;padding:8px 14px;display:flex;align-items:center;gap:8px">
                <span style="font-size:10px;font-weight:700;color:${gananciaNeta>=0?'var(--tint-green-fg)':'var(--tint-red-fg)'};text-transform:uppercase;letter-spacing:.4px">Ganancia neta</span>
                <span style="font-size:17px;font-weight:800;color:${gananciaNeta>=0?'var(--tint-green-fg)':'var(--tint-red-fg)'}">${gananciaNeta>=0?'$':'-$'}${fmt(Math.abs(gananciaNeta))}</span>
              </div>
            </div>
          </div>
          ${itemsSinCosto > 0 ? `
          <div style="background:var(--tint-yellow-bg);border:1px solid var(--border);border-radius:8px;padding:8px 12px;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--tint-orange-fg);margin-top:10px">
            <span class="material-icons" style="font-size:16px;color:var(--tint-orange-fg)">warning</span>
            <span><b>${itemsSinCosto}</b> producto${itemsSinCosto===1?'':'s'} sin costo cargado ($${fmt(ingresoSinCosto)} en ventas). Cargalos en Control Total para mejorar el calculo.</span>
          </div>` : ''}
        </div>

        <!-- Resumen de efectivo -->
        <div style="margin-bottom:22px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)">Resumen de efectivo</div>
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:14px 16px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 20px">
              ${lineaEf('Monto inicial', `$${fmt(inicial)}`, '#475569')}
              ${lineaEf('+ Ventas efectivo', `$${fmt(efectivo)}`, '#198754')}
              ${retiros > 0 ? lineaEf('− Retiros', `$${fmt(retiros)}`, '#dc3545') : ''}
              ${lineaEf('= Efectivo esperado', `$${fmt(esperado)}`, '#1e293b', true)}
            </div>
            ${final_amt > 0 ? `
              <div style="border-top:1px dashed var(--border);margin:12px 0 10px"></div>
              <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
                <div>
                  <div style="font-size:10px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.4px">Efectivo contado</div>
                  <div style="font-size:16px;font-weight:700;color:var(--text-strong)">$${fmt(final_amt)}</div>
                </div>
                <div style="background:${diff >= 0 ? 'var(--tint-green-bg)' : 'var(--tint-red-bg)'};border:1px solid ${diff >= 0 ? '#bbf7d0' : '#fecaca'};border-radius:10px;padding:8px 14px;display:flex;align-items:center;gap:8px">
                  <span class="material-icons" style="font-size:16px;color:${diff >= 0 ? 'var(--tint-green-fg)' : 'var(--tint-red-fg)'}">${diff >= 0 ? 'check_circle' : 'error'}</span>
                  <div>
                    <div style="font-size:10px;font-weight:700;color:${diff >= 0 ? 'var(--tint-green-fg)' : 'var(--tint-red-fg)'};text-transform:uppercase">${diff === 0 ? 'Exacto' : diff > 0 ? 'Sobrante' : 'Faltante'}</div>
                    <div style="font-size:14px;font-weight:800;color:${diff >= 0 ? 'var(--tint-green-fg)' : 'var(--tint-red-fg)'}">${diff === 0 ? '$0,00' : (diff > 0 ? '+' : '-') + '$' + fmt(Math.abs(diff))}</div>
                  </div>
                </div>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Productos vendidos -->
        ${productos.length > 0 ? `
        <div style="margin-bottom:22px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted)">Productos vendidos <span style="color:var(--text-muted);font-weight:600">(${productos.length})</span></div>
            <div style="font-size:11px;color:var(--text-muted)">Ordenados por ingreso</div>
          </div>
          ${top3.length > 0 ? `
          <div style="display:grid;grid-template-columns:repeat(${Math.min(top3.length,3)},1fr);gap:8px;margin-bottom:10px">
            ${top3.map((p, i) => {
              const medal = ['#fbbf24','#94a3b8','#d97706'][i];
              return `
              <div style="background:var(--surface-2);border:1px solid var(--border);border-left:3px solid ${medal};border-radius:8px;padding:8px 12px">
                <div style="font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">#${i+1} mas vendido</div>
                <div style="font-size:12px;font-weight:700;color:var(--text-strong);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${p._nombre}">${p._nombre}</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${p._cantidad} u. · <b style="color:var(--tint-green-fg)">$${fmt(p._ingreso)}</b></div>
              </div>`;
            }).join('')}
          </div>` : ''}
          <div style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:10px">
            <table style="width:100%;border-collapse:collapse;font-size:12.5px">
              <thead>
                <tr style="background:var(--surface-2);position:sticky;top:0;z-index:1">
                  <th style="padding:9px 10px;text-align:left;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">Producto</th>
                  <th style="padding:9px 10px;text-align:center;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">Cant.</th>
                  <th style="padding:9px 10px;text-align:right;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">Ingreso</th>
                  <th style="padding:9px 10px;text-align:right;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">Costo</th>
                  <th style="padding:9px 10px;text-align:right;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">Ganancia</th>
                </tr>
              </thead>
              <tbody>
                ${productos.map((p, i) => {
                  const sinCosto = p._costoUnit === 0;
                  return `
                  <tr style="background:${i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)'}">
                    <td style="padding:8px 10px;color:var(--text-strong);font-weight:500">${p._nombre}</td>
                    <td style="padding:8px 10px;text-align:center;color:var(--text-muted)">${p._cantidad}</td>
                    <td style="padding:8px 10px;text-align:right;font-weight:700;color:var(--tint-green-fg)">$${fmt(p._ingreso)}</td>
                    <td style="padding:8px 10px;text-align:right;color:${sinCosto?'var(--tint-orange-fg)':'var(--text-muted)'};${sinCosto?'font-style:italic':''}">
                      ${sinCosto ? '—' : '$'+fmt(p._costoTot)}
                    </td>
                    <td style="padding:8px 10px;text-align:right;font-weight:700;color:${sinCosto?'var(--text-muted)':(p._ganancia>=0?'var(--tint-green-fg)':'var(--tint-red-fg)')}">
                      ${sinCosto ? '<span title="sin costo cargado">s/c</span>' : `$${fmt(p._ganancia)}${p._margenPct!=null?` <span style="font-size:10px;color:var(--text-muted);font-weight:600">(${p._margenPct.toFixed(0)}%)</span>`:''}`}
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
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)">Gastos del turno <span style="color:var(--text-muted);font-weight:600">(${gastosTurno.length})</span></div>
            ${gastosTurno.map(g => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--tint-red-bg);border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
                <div style="min-width:0;flex:1">
                  <div style="font-size:12px;font-weight:600;color:var(--tint-red-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${g.descripcion || '-'}</div>
                  <div style="font-size:10px;color:var(--text-muted)">${g.fecha || ''}${g.tipo ? ' · ' + g.tipo : ''}</div>
                </div>
                <div style="font-size:14px;font-weight:700;color:var(--tint-red-fg);white-space:nowrap;margin-left:8px">-$${fmt(g.monto)}</div>
              </div>
            `).join('')}
          </div>` : ''}
          ${retiros_lista.length > 0 ? `
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)">Retiros de caja <span style="color:var(--text-muted);font-weight:600">(${retiros_lista.length})</span></div>
            ${retiros_lista.map(r => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--tint-red-bg);border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
                <div style="min-width:0;flex:1">
                  <div style="font-size:12px;font-weight:600;color:var(--tint-red-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.reason || r.motivo || 'Retiro'}</div>
                  <div style="font-size:10px;color:var(--text-muted)">${r.created_at ? fmtDT(parseArDate(r.created_at)) : ''}</div>
                </div>
                <div style="font-size:14px;font-weight:700;color:var(--tint-red-fg);white-space:nowrap;margin-left:8px">-$${fmt(r.amount || r.monto || 0)}</div>
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
        alertDialog({ title: 'Error', message: 'No se pudo guardar: ' + escHtml(e?.message || e), type: 'error' });
      }
    };
    btnGuardar.addEventListener('click', guardar);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') guardar(); });
  }

  // Wire-up: recalcular stats (solo si total_ventas == 0 y pendiente_conteo)
  const btnRecalc = overlay.querySelector('#btn-recalc-stats');
  if (btnRecalc && db) {
    btnRecalc.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Recalcular stats', message: 'Esto va a recalcular ingreso, transferencia, transacciones y productos vendidos desde la colección ventas. ¿Continuar?', confirmText: 'Recalcular' })) return;
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
          alertDialog({ title: 'Stats recalculados', message: `<b>$${fmt(result.total_ventas)}</b> en <b>${result.total_transacciones}</b> ventas.`, type: 'success' });
        }, 200);
      } catch (e) {
        btnRecalc.disabled = false;
        btnRecalc.innerHTML = '<span class="material-icons" style="font-size:16px">calculate</span>Recalcular stats';
        alertDialog({ title: 'Error', message: 'No se pudo recalcular: ' + escHtml(e?.message || e), type: 'error' });
      }
    });
  }
}

function lineaEf(label, valor, color = '#1e293b', bold = false) {
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;${bold ? 'padding-top:6px;border-top:1px dashed var(--border);' : ''}">
      <span style="font-size:12px;color:var(--text-muted);${bold ? 'font-weight:700;color:var(--text-muted)' : ''}">${label}</span>
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

// Returns 'YYYY-MM-DD' in AR timezone from a fecha_apertura value.
// Strings (naive AR local time) are sliced directly; Firestore Timestamps
// se restan 3h (AR = UTC-3) para que el slice del ISO devuelva el día AR.
function aperturaDayKey(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.slice(0, 10);
  if (typeof val.toDate === 'function') {
    const ar = new Date(val.toDate().getTime() - 3 * 3600000);
    return ar.toISOString().slice(0, 10);
  }
  if (typeof val === 'object' && val.seconds !== undefined) {
    const ar = new Date(val.seconds * 1000 - 3 * 3600000);
    return ar.toISOString().slice(0, 10);
  }
  return '';
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
