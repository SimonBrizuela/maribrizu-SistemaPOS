import { collection, getDocs, query, orderBy, limit, where, updateDoc, doc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { openSaleModal } from '../components/modal.js';
import { getCached, invalidateCache } from '../cache.js';
import { getFechaInicioDate, isVentaVarios2 } from '../config.js';
import { getSaleNumberMap, displayNumForVenta } from '../sale_numbers.js';
import { confirmDialog, alertDialog, escHtml } from '../components/dialogs.js';
import { revertirStockVenta } from '../stock_revert.js';

export async function renderVentas(container, db) {
  // 1) Shell vacío al toque: filtros + tabla con skeletons en el tbody.
  container.innerHTML = renderVentasShell();
  const tbody0 = container.querySelector('#ventasBody');
  if (tbody0) tbody0.innerHTML = skelRowsVentas(8);

  const fechaInicio = await getFechaInicioDate(db);
  const saleNumMap  = await getSaleNumberMap(db);

  // Cargar ventas e items en paralelo, con cache en memoria
  const [ventasRaw, itemsPorVenta] = await Promise.all([
    getCached('ventas:lista', async () => {
      const snap = await getDocs(query(collection(db, 'ventas'), orderBy('created_at', 'desc'), limit(500)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }),
    getCached('ventas:items', async () => {
      const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('num_venta', 'desc'), limit(3000)));
      // Dos mapas:
      //  - byKey: clave estricta `${pcId}_${num_venta}` (o solo `num_venta` si el doc id no tiene pcId)
      //  - byNum: agrupado solo por num_venta, con el pcId origen de cada item — sirve de fallback
      //    cuando el pc_id de la venta no matchea (machine_id regenerado, ventas legacy, etc).
      const byKey = {};
      const byNum = {};
      snap.docs.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return;
        const parts = d.id.split('_');
        const pcId  = parts.length >= 3 ? parts.slice(0, -2).join('_') : '';
        const numV  = String(data.num_venta);
        const key   = pcId ? `${pcId}_${numV}` : numV;
        const nombre = data.producto || data.product_name || '';
        const cant   = data.cantidad || data.quantity || 1;
        if (!nombre) return;
        const txt = `${nombre}${cant > 1 ? ` x${cant}` : ''}`;
        (byKey[key] = byKey[key] || []).push(txt);
        (byNum[numV] = byNum[numV] || []).push({ pcId, txt });
      });
      return { byKey, byNum };
    })
  ]);

  // Ocultar ventas anteriores a fecha_inicio, borradas y Varios 2 (solo factura AFIP)
  const ventas = ventasRaw.filter(v =>
    v.deleted !== true && !isVentaVarios2(v) && parseArDate(v.created_at) >= fechaInicio
  );

  // Enriquecer cada venta con sus productos. Primero match estricto por
  // (pc_id + sale_id); si queda vacío, fallback por num_venta solo (cubre
  // desincronía cuando los items quedaron con un pc_id distinto al de la venta).
  const { byKey, byNum } = itemsPorVenta;
  ventas.forEach(v => {
    const saleId = String(v.sale_id || v.id);
    const pcId   = v.pc_id || '';
    const strictKey = pcId ? `${pcId}_${saleId}` : saleId;
    let items = byKey[strictKey];
    if (!items || items.length === 0) {
      const lista = byNum[saleId] || [];
      // Si la venta tiene pc_id, prefiero items del mismo pcId o con pcId vacío (legacy);
      // si no, agarro todos los items de ese num_venta.
      const filtrados = pcId
        ? lista.filter(x => x.pcId === pcId || x.pcId === '')
        : lista;
      items = filtrados.map(x => x.txt);
    }
    let texto = (items || []).join(', ');
    // Último fallback: el doc `ventas` guarda un campo `productos` con el resumen
    // armado al momento del sync. Cubre ventas cuyo detalle (`ventas_por_dia`)
    // nunca llegó a sincronizar.
    if (!texto && v.productos) texto = String(v.productos);
    v._productosTexto = texto;
  });

  // Paginación: arranca mostrando PAGE_SIZE y crece de a PAGE_SIZE en cada click
  const PAGE_SIZE = 50;
  let renderedCount = PAGE_SIZE;
  let currentData = [];

  function renderRows(data) {
    currentData = data;
    const tbody = document.getElementById('ventasBody');
    const loadMoreWrap = document.getElementById('ventasLoadMoreWrap');
    const loadMoreInfo = document.getElementById('ventasLoadMoreInfo');

    document.getElementById('ventasCount').textContent = data.length + ' ventas — click en una fila para ver el detalle';
    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-muted)">Sin ventas para mostrar</td></tr>`;
      loadMoreWrap.style.display = 'none';
      return;
    }

    const slice = data.slice(0, renderedCount);
    if (data.length > renderedCount) {
      loadMoreWrap.style.display = 'block';
      loadMoreInfo.textContent = `Mostrando ${slice.length} de ${data.length}`;
    } else {
      loadMoreWrap.style.display = 'none';
    }

    tbody.innerHTML = slice.map((v, i) => {
      const dt = parseArDate(v.created_at);
      const esEfectivo = v.payment_type === 'cash';
      const esMixto    = v.payment_type === 'mixed';
      const tieneDescuento = (v.discount || 0) > 0;

      // Para pago mixto, en la columna efectivo mostramos "X cash + Y transf"
      let efectivoHtml, cambioHtml, badgeHtml;
      if (esMixto) {
        const cashPart = Number(v.cash_received || 0) - Number(v.change_given || 0);
        const transPart = Number(v.transfer_amount || 0);
        efectivoHtml = `<span title="Efectivo: $${fmt(cashPart)} · Transferencia: $${fmt(transPart)}">`
          + `💵 $${fmt(cashPart)}<br/><span style="color:var(--tint-orange-fg);font-size:11px">🏦 $${fmt(transPart)}</span></span>`;
        cambioHtml = `$${fmt(v.change_given)}`;
        badgeHtml = `<span class="badge" style="background:var(--tint-orange-bg);color:var(--tint-orange-fg);border:1px solid #c1521f">🔀 Mixto</span>`;
      } else {
        efectivoHtml = `$${fmt(v.cash_received)}`;
        cambioHtml = `$${fmt(v.change_given)}`;
        badgeHtml = `<span class="badge ${esEfectivo ? 'badge-green' : 'badge-blue'}">${esEfectivo ? '💵 Efectivo' : '🏦 Transferencia'}</span>`;
      }

      // Cobro de fiado: la venta salda una cuenta corriente. Se pinta violeta
      // para distinguirla de la venta de mostrador — la plata entra hoy, pero
      // la mercadería salió otro día.
      const esFiado = v.es_fiado === true;
      const fiadoACuenta = esFiado && v.fiado_tipo === 'a_cuenta';
      const fiadoBadge = esFiado
        ? `<span class="badge badge-fiado" title="${escHtml(v.fiado_cliente || '')}">`
          + `${fiadoACuenta ? 'A cuenta' : 'Fiado'}${v.fiado_cliente ? ' · ' + escHtml(v.fiado_cliente) : ''}</span>`
        : '';

      return `<tr class="clickable-row${esFiado ? ' row-fiado' : ''}" data-idx="${i}" title="${
          esFiado ? 'Cobro de fiado — click para ver detalle' : 'Click para ver detalle'}">
        <td><b>#${displayNumForVenta(v, saleNumMap)}</b></td>
        <td>${fmtDate(dt)}</td>
        <td class="vta-col-hora">${fmtTime(dt)}</td>
        <td class="vta-col-productos" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${v._productosTexto || 'Click para ver detalle'}">
          ${v._productosTexto
            ? `<span style="color:var(--text-muted);font-size:12px">${v._productosTexto}</span>`
            : `<span style="color:var(--primary);font-size:12px;cursor:pointer">🔍 Ver detalle</span>`}
        </td>
        <td class="vta-col-items" style="text-align:center"><span class="badge badge-gray">${v.items_count || '-'}</span></td>
        <td><b>$${fmt(v.total_amount)}</b></td>
        <td class="vta-col-efectivo">${efectivoHtml}</td>
        <td class="vta-col-cambio">${cambioHtml}</td>
        <td>
          ${badgeHtml}
          ${fiadoBadge}
          ${tieneDescuento ? `<span class="badge badge-orange" style="margin-left:4px">🏷️ -$${fmt(v.discount)}</span>` : ''}
        </td>
        <td><b>${v.cajero || v.username || v.user_id || '-'}</b></td>
        <td style="text-align:center">
          <button class="btn-delete-venta" data-idx="${i}" title="Eliminar venta"
            style="background:transparent;border:none;cursor:pointer;font-size:16px;color:var(--tint-red-fg);padding:4px 8px;border-radius:4px"
            onmouseover="this.style.background='#fee'" onmouseout="this.style.background='transparent'">🗑️</button>
        </td>
      </tr>`;
    }).join('');

    // Eventos click en filas (idx es relativo al slice visible)
    tbody.querySelectorAll('.clickable-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-venta')) return;
        const idx = parseInt(row.dataset.idx);
        openSaleModal(slice[idx], db);
      });
    });

    // Eventos click en botones eliminar (idx es relativo al slice visible)
    tbody.querySelectorAll('.btn-delete-venta').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        const venta = slice[idx];
        await handleDeleteVenta(venta, saleNumMap);
      });
    });
  }

  async function handleDeleteVenta(venta, numMap) {
    const numMostrado = displayNumForVenta(venta, numMap);
    const total = fmt(venta.total_amount);
    const ok = await confirmDialog({
      title: 'Eliminar venta',
      message: `¿Eliminar la venta <b>#${numMostrado}</b> por <b>$${total}</b>?<br><br>`
        + `Esta acción la removerá del historial, dashboard, cierres, control total y resúmenes,<br>`
        + `y <b>devolverá el stock de los productos al catálogo</b>.<br>`
        + `<span style="color:var(--text-muted)">No se puede deshacer fácilmente.</span>`,
      confirmText: 'Eliminar',
      danger: true,
    });
    if (!ok) return;

    try {
      const saleId = venta.sale_id || venta.id;
      const pcId = venta.pc_id || '';

      // Items de la venta: sirven para devolver el stock y para marcarlos
      // borrados. Se leen una sola vez y se reusan en ambos pasos.
      let itemDocs = [];
      try {
        const itemsSnap = await getDocs(query(
          collection(db, 'ventas_por_dia'),
          where('num_venta', '==', Number(saleId))
        ));
        itemDocs = pcId
          ? itemsSnap.docs.filter(d => d.id.startsWith(pcId + '_'))
          : itemsSnap.docs;
      } catch (err) {
        console.warn('No se pudieron leer los items de ventas_por_dia:', err);
      }

      // Devolver el stock + marcar los items como borrados (mismo batch).
      let reversion = null;
      if (itemDocs.length) {
        try {
          reversion = await revertirStockVenta(db, { saleId, pcId, itemDocs, marcarDeleted: true });
        } catch (err) {
          console.error('Error devolviendo stock:', err);
          const seguir = await confirmDialog({
            title: 'No se pudo devolver el stock',
            message: `El stock de los productos no se pudo devolver al catálogo:<br>`
              + `<span style="color:var(--text-muted)">${escHtml(err.message || err)}</span><br><br>`
              + `¿Eliminar la venta igual? Vas a tener que ajustar el stock a mano.`,
            confirmText: 'Eliminar igual',
            danger: true,
          });
          if (!seguir) return;
          // Sin reversión: al menos marcar los items como borrados.
          const batch = writeBatch(db);
          itemDocs.forEach(d => batch.update(d.ref, { deleted: true }));
          await batch.commit();
        }
      }

      await updateDoc(doc(db, 'ventas', venta.id), {
        deleted: true,
        deleted_at: serverTimestamp()
      });

      invalidateCache('ventas:lista');
      invalidateCache('ventas:items');
      invalidateCache('dashboard:ventas');
      invalidateCache('cierres:ventas');
      invalidateCache('control_total:ventas');
      invalidateCache('control_total:items');

      const idxOriginal = ventas.findIndex(v => v.id === venta.id);
      if (idxOriginal >= 0) ventas.splice(idxOriginal, 1);
      applyFilters();

      // Sólo se avisa cuando quedó algo sin devolver: el caso normal no
      // interrumpe con un diálogo de "listo".
      if (reversion && reversion.omitidos.length) {
        const lista = reversion.omitidos
          .map(o => `<li><b>${escHtml(o.nombre)}</b> — ${escHtml(o.motivo)}</li>`)
          .join('');
        const devueltos = reversion.devueltos.length
          ? `<p style="margin:0 0 8px">Se devolvió el stock de ${reversion.devueltos.length} producto(s).</p>`
          : '';
        alertDialog({
          title: 'Venta eliminada — revisá el stock',
          message: devueltos
            + `<p style="margin:0 0 6px">Estos no se pudieron devolver automáticamente:</p>`
            + `<ul style="margin:0;padding-left:18px">${lista}</ul>`,
          type: 'warning',
        });
      }
    } catch (err) {
      console.error('Error eliminando venta:', err);
      alertDialog({ title: 'Error', message: 'No se pudo eliminar la venta: ' + escHtml(err.message || err), type: 'error' });
    }
  }

  function applyFilters() {
    // Si los filtros ya no están en el DOM (el usuario navegó a otra página
    // mientras corría un borrado async), no hay nada que re-renderear. Evita
    // el TypeError 'reading value' de null que además hacía reportar como
    // "Error al eliminar la venta" un borrado que en realidad fue exitoso.
    const elDesde = document.getElementById('filtroDesde');
    if (!elDesde) return;
    let data = [...ventas];
    const desde = elDesde.value;
    const hasta = document.getElementById('filtroHasta').value;
    const pago  = document.getElementById('filtroPago').value;
    const cajero = document.getElementById('filtroCajero').value.toLowerCase();
    const producto = document.getElementById('filtroProducto').value.toLowerCase();

    if (desde) data = data.filter(v => {
      const dt = parseArDate(v.created_at);
      return dt >= new Date(desde + 'T00:00:00-03:00');
    });
    if (hasta) data = data.filter(v => {
      const dt = parseArDate(v.created_at);
      return dt <= new Date(hasta + 'T23:59:59-03:00');
    });
    // El filtro de pago comparte el select con los cobros de fiado: son dos
    // ejes distintos (cómo pagó / de dónde venía la deuda) pero en la práctica
    // lo que el usuario quiere es "mostrame sólo los fiados".
    if (pago === 'fiado')        data = data.filter(v => v.es_fiado === true);
    else if (pago === 'fiado_a_cuenta') data = data.filter(v => v.es_fiado === true && v.fiado_tipo === 'a_cuenta');
    else if (pago)               data = data.filter(v => v.payment_type === pago);
    if (cajero) data = data.filter(v =>
      (v.cajero || v.username || '').toLowerCase().includes(cajero)
    );
    if (producto) data = data.filter(v =>
      (v._productosTexto || '').toLowerCase().includes(producto)
    );
    // Cualquier cambio de filtro → resetear paginación
    renderedCount = PAGE_SIZE;
    renderRows(data);
  }

  ['filtroDesde','filtroHasta','filtroPago','filtroCajero','filtroProducto'].forEach(id => {
    document.getElementById(id).addEventListener('input', applyFilters);
  });

  // Botón "Cargar más" → suma PAGE_SIZE filas más
  document.getElementById('ventasLoadMoreBtn').addEventListener('click', () => {
    renderedCount += PAGE_SIZE;
    renderRows(currentData);
  });

  renderRows(ventas);
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

function renderVentasShell() {
  return `
    <style>
      /* Cobros de fiado: franja violeta a la izquierda + fondo tenue. */
      tr.row-fiado > td:first-child { box-shadow: inset 3px 0 0 var(--primary) }
      tr.row-fiado > td { background: var(--tint-purple-bg) }
      tr.row-fiado:hover > td { filter: brightness(0.97) }
      html[data-theme="dark"] tr.row-fiado:hover > td { filter: brightness(1.25) }
      .badge-fiado { margin-left:4px; background: var(--tint-purple-bg);
        color: var(--tint-purple-fg); border: 1px solid var(--tint-purple-fg);
        max-width: 190px; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; vertical-align: middle; display: inline-block }
    </style>
    <div class="filter-bar">
      <input type="date" id="filtroDesde" placeholder="Desde" />
      <input type="date" id="filtroHasta" placeholder="Hasta" />
      <select id="filtroPago">
        <option value="">Todos los pagos</option>
        <option value="cash">Efectivo</option>
        <option value="transfer">Transferencia</option>
        <option value="mixed">Mixto</option>
        <option value="fiado">Solo cobros de fiado</option>
        <option value="fiado_a_cuenta">Solo pagos a cuenta</option>
      </select>
      <input type="text" id="filtroCajero" placeholder="Cajero..." style="width:140px" />
      <input type="text" id="filtroProducto" placeholder="Buscar producto..." style="width:200px" />
    </div>
    <div class="table-card">
      <div class="table-card-header">
        <h3>🧾 Todas las Ventas</h3>
        <span id="ventasCount" style="color:var(--text-muted);font-size:13px"></span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Fecha</th><th class="vta-col-hora">Hora</th><th class="vta-col-productos">Productos</th>
            <th class="vta-col-items">Items</th><th>Total</th><th class="vta-col-efectivo">Efectivo</th><th class="vta-col-cambio">Cambio</th>
            <th>Tipo Pago</th><th>Cajero</th><th></th>
          </tr></thead>
          <tbody id="ventasBody"></tbody>
        </table>
      </div>
      <div id="ventasLoadMoreWrap" style="display:none;text-align:center;padding:16px">
        <button id="ventasLoadMoreBtn" class="btn-secondary" style="background:var(--primary);color:#fff;border:none;padding:10px 24px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600">
          Cargar más ventas
        </button>
        <div id="ventasLoadMoreInfo" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>
      </div>
    </div>`;
}

function skelRowsVentas(n) {
  return Array(n).fill(`
    <tr><td colspan="11" style="padding:6px 12px"><div class="skel" style="height:28px;border-radius:6px"></div></td></tr>
  `).join('');
}
