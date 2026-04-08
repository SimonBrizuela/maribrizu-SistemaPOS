/**
 * Modal de detalle de venta
 * Muestra todos los items, descuentos, pagos y datos del ticket
 */
import { collection, getDocs, query, where } from 'firebase/firestore';

export function openSaleModal(venta, db) {
  // Eliminar modal previo si existe
  document.querySelector('.modal-overlay')?.remove();

  const dt = venta.created_at?.toDate ? venta.created_at.toDate() : new Date(venta.created_at);
  const esEfectivo = venta.payment_type === 'cash';
  const saleId = venta.sale_id || venta.id;

  // Crear overlay
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" id="saleModal">
      <div class="modal-header">
        <h3>🧾 Venta #${saleId}</h3>
        <button class="modal-close"><span class="material-icons">close</span></button>
      </div>
      <div class="modal-body">

        <!-- Info general -->
        <div class="modal-section">
          <h4>Información General</h4>
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">Fecha</span>
              <span class="detail-value">${dt.toLocaleDateString('es-AR')}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Hora</span>
              <span class="detail-value">${dt.toLocaleTimeString('es-AR', {hour:'2-digit',minute:'2-digit'})}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Cajero</span>
              <span class="detail-value">${venta.username || venta.user_id || '-'}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Tipo de Pago</span>
              <span class="detail-value">
                <span class="badge ${esEfectivo ? 'badge-green' : 'badge-blue'}">
                  ${esEfectivo ? '💵 Efectivo' : '🏦 Transferencia'}
                </span>
              </span>
            </div>
            ${esEfectivo ? `
            <div class="detail-item">
              <span class="detail-label">Efectivo Recibido</span>
              <span class="detail-value">$${fmt(venta.cash_received)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">Cambio</span>
              <span class="detail-value" style="color:var(--warning)">$${fmt(venta.change_given)}</span>
            </div>` : ''}
            ${(venta.discount || 0) > 0 ? `
            <div class="detail-item">
              <span class="detail-label">🏷️ Descuento Aplicado</span>
              <span class="detail-value" style="color:var(--danger)">-$${fmt(venta.discount)}</span>
            </div>` : ''}
          </div>
        </div>

        <!-- Productos -->
        <div class="modal-section">
          <h4>Productos Vendidos</h4>
          <div id="modalItems">
            <div class="loader"><div class="spinner"></div><span>Cargando items...</span></div>
          </div>
        </div>

        <!-- Total -->
        <div class="modal-total">
          <span class="total-label">TOTAL DE LA VENTA</span>
          <span class="total-value">$${fmt(venta.total_amount)}</span>
        </div>

      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Cerrar modal
  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
  });

  // Cargar items de ventas_por_dia
  loadSaleItems(saleId, db).then(items => {
    const container = document.getElementById('modalItems');
    if (!container) return;
    if (!items.length) {
      container.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:20px">Sin detalle de productos disponible</p>`;
      return;
    }
    // Calcular total de descuentos
    const totalDescuentos = items.reduce((a, i) => a + (i.descuento_monto || i.discount_amount || 0), 0);

    container.innerHTML = items.map(item => {
      const precioUnit = item.precio_unitario || item.unit_price || 0;
      const precioOrig = item.precio_original || item.original_price || precioUnit;
      const descMonto  = item.descuento_monto || item.discount_amount || 0;
      const descTipo   = item.descuento_tipo  || item.discount_type  || '';
      const descValor  = item.descuento_valor || item.discount_value || 0;
      const tieneDesc  = descMonto > 0;
      const cantidad   = item.cantidad || item.quantity || 1;
      const precioOrigTotal = precioOrig * cantidad;

      let descLabel = '';
      let descDesc  = '';
      if (tieneDesc) {
        if (descTipo === 'percentage') { descLabel = `${descValor}% OFF`;      descDesc = `Descuento del ${descValor}%`; }
        else if (descTipo === '2x1')   { descLabel = `2x1`;                    descDesc = `Promoción 2x1`; }
        else if (descTipo === 'nxm')   { descLabel = `Promo NxM`;              descDesc = `Promoción especial`; }
        else if (descTipo === 'bundle') { descLabel = `Combo`;                  descDesc = `Precio de combo`; }
        else if (descTipo === 'fixed') { descLabel = `Desc. fijo`;             descDesc = `Descuento fijo`; }
        else                           { descLabel = `Descuento`;              descDesc = `Descuento aplicado`; }
      }

      return `
        <div style="margin-bottom:12px;border:1px solid ${tieneDesc ? '#fed7aa' : '#e2e8f0'};border-radius:10px;overflow:hidden;background:${tieneDesc ? '#fffbf5' : 'white'}">
          <!-- Encabezado del item -->
          <div style="padding:12px 14px;display:flex;justify-content:space-between;align-items:flex-start">
            <div>
              <div style="font-weight:700;color:#1e293b;font-size:14px">${item.producto || item.product_name || '-'}</div>
              <div style="margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span class="badge badge-gray" style="font-size:11px">${item.categoria || item.category || 'Sin categoría'}</span>
                <span style="color:#64748b;font-size:12px">× ${cantidad} unidad${cantidad > 1 ? 'es' : ''}</span>
                ${tieneDesc ? `<span style="background:#fef3c7;color:#d97706;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px">🏷️ ${descLabel}</span>` : ''}
              </div>
            </div>
            <div style="text-align:right;min-width:90px">
              <div style="font-size:16px;font-weight:700;color:#1e293b">$${fmt(item.subtotal)}</div>
            </div>
          </div>

          <!-- Desglose de precio -->
          <div style="background:${tieneDesc ? '#fff7ed' : '#f8fafc'};border-top:1px solid ${tieneDesc ? '#fed7aa' : '#e2e8f0'};padding:8px 14px">
            <div style="display:flex;justify-content:space-between;color:#64748b;font-size:12px;margin-bottom:3px">
              <span>Precio unitario${tieneDesc ? ' (original)' : ''}</span>
              <span>${tieneDesc ? `<span style="text-decoration:line-through;color:#94a3b8">$${fmt(precioOrig)}</span>` : `$${fmt(precioUnit)}`}</span>
            </div>
            ${tieneDesc ? `
            <div style="display:flex;justify-content:space-between;color:#64748b;font-size:12px;margin-bottom:3px">
              <span>Precio con descuento</span>
              <span style="color:#198754;font-weight:600">$${fmt(precioUnit)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
              <span style="color:#d97706;font-weight:600">🏷️ ${descDesc}</span>
              <span style="color:#dc3545;font-weight:700">-$${fmt(descMonto)}</span>
            </div>` : ''}
            <div style="display:flex;justify-content:space-between;font-size:12px;border-top:1px dashed #e2e8f0;margin-top:4px;padding-top:4px">
              <span style="color:#475569;font-weight:600">Subtotal (${cantidad} u.)</span>
              <span style="font-weight:700;color:#1e293b">$${fmt(item.subtotal)}</span>
            </div>
          </div>
        </div>
      `;
    }).join('') + (totalDescuentos > 0 ? `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;margin-top:4px">
        <span style="color:#dc3545;font-weight:600;font-size:13px">🏷️ Total descuentos aplicados</span>
        <span style="color:#dc3545;font-weight:700;font-size:15px">-$${fmt(totalDescuentos)}</span>
      </div>
    ` : '');
  });
}

async function loadSaleItems(saleId, db) {
  try {
    // Buscar en ventas_por_dia filtrando por num_venta
    const snap = await getDocs(
      query(collection(db, 'ventas_por_dia'), where('num_venta', '==', saleId))
    );
    if (!snap.empty) {
      return snap.docs.map(d => d.data());
    }
    // También intentar con string
    const snap2 = await getDocs(
      query(collection(db, 'ventas_por_dia'), where('num_venta', '==', String(saleId)))
    );
    return snap2.docs.map(d => d.data());
  } catch (e) {
    console.error('Error cargando items:', e);
    return [];
  }
}

function fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
