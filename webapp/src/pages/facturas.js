/**
 * Página: Facturación Electrónica AFIP
 * ─────────────────────────────────────
 * Permite emitir facturas electrónicas (FAC. ELEC. A/B/C) obteniendo el CAE
 * desde la Netlify Function /api/afip-cae, luego guarda el registro en
 * Firestore (colección "facturas") y genera un comprobante imprimible con QR.
 */

import { collection, addDoc, getDocs, query, orderBy, limit } from 'firebase/firestore';
import { getCached, invalidateCache } from '../cache.js';

async function loadCatalogo(db) {
  return getCached('catalogo:all', async () => {
    const snap = await getDocs(query(collection(db, 'catalogo'), orderBy('nombre')));
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    return list;
  }, { ttl: 10 * 60 * 1000, memOnly: true });
}

function norm(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function buscarProductos(catalogo, texto) {
  if (!texto || texto.length < 2) return [];
  const palabras = norm(texto).split(/\s+/).filter(Boolean);
  return catalogo
    .filter(p => {
      const haystack = norm(
        `${p.nombre||''} ${p.codigo||''} ${p.cod_barra||''} ${p.categoria||''} ${p.marca||''} ${p.proveedor||''}`
      );
      return palabras.every(w => haystack.includes(w));
    })
    .slice(0, 8);
}

// ── Config AFIP (datos del emisor — se cargan desde Firestore doc "config/afip") ──
let _emisorConfig = null;

async function loadEmisorConfig(db) {
  if (_emisorConfig) return _emisorConfig;
  try {
    const { doc, getDoc } = await import('firebase/firestore');
    const snap = await getDoc(doc(db, 'config', 'afip'));
    _emisorConfig = snap.exists() ? snap.data() : {};
  } catch { _emisorConfig = {}; }
  return _emisorConfig;
}

// ── Render principal ──────────────────────────────────────────────────────────
export async function renderFacturas(container, db) {
  const emisor = await loadEmisorConfig(db);

  container.innerHTML = `
    <div class="facturas-page">

      <!-- TABS -->
      <div class="fact-tabs">
        <button class="fact-tab active" data-tab="emitir">
          <span class="material-icons">add_circle_outline</span> Nueva Factura
        </button>
        <button class="fact-tab" data-tab="resumen">
          <span class="material-icons">bar_chart</span> Resumen
        </button>
        <button class="fact-tab" data-tab="historial">
          <span class="material-icons">receipt_long</span> Historial
        </button>
        <button class="fact-tab" data-tab="config">
          <span class="material-icons">settings</span> Configuración
        </button>
      </div>

      <!-- TAB: EMITIR -->
      <div class="fact-panel" id="tab-emitir">
        ${buildEmitirForm(emisor)}
      </div>

      <!-- TAB: RESUMEN -->
      <div class="fact-panel hidden" id="tab-resumen">
        <div class="fact-resumen-header">
          <div class="fact-section-title" style="margin:0">Resumen de facturación</div>
          <div style="display:flex;gap:8px;align-items:center;">
            <label style="font-size:13px;color:#6c757d;">Desde</label>
            <input type="date" id="resumenDesde" style="padding:4px 8px;border:1px solid #dee2e6;border-radius:6px;font-size:13px;" />
            <label style="font-size:13px;color:#6c757d;">Hasta</label>
            <input type="date" id="resumenHasta" style="padding:4px 8px;border:1px solid #dee2e6;border-radius:6px;font-size:13px;" />
            <button id="resumenBuscar" style="padding:5px 14px;background:#0d6efd;color:white;border:none;border-radius:6px;font-size:13px;cursor:pointer;">Actualizar</button>
          </div>
        </div>
        <div id="factResumen">
          <div class="loader"><div class="spinner"></div><span>Cargando...</span></div>
        </div>
      </div>

      <!-- TAB: HISTORIAL -->
      <div class="fact-panel hidden" id="tab-historial">
        <div class="fact-section-title">Historial de comprobantes</div>
        <div id="factHistorial">
          <div class="loader"><div class="spinner"></div><span>Cargando...</span></div>
        </div>
      </div>

      <!-- TAB: CONFIG -->
      <div class="fact-panel hidden" id="tab-config">
        ${buildConfigForm(emisor)}
      </div>

    </div>
  `;

  // Tab switching
  container.querySelectorAll('.fact-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.fact-tab').forEach(b => b.classList.remove('active'));
      container.querySelectorAll('.fact-panel').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      const panel = container.querySelector(`#tab-${btn.dataset.tab}`);
      panel.classList.remove('hidden');
      if (btn.dataset.tab === 'historial') loadHistorial(db, container);
      if (btn.dataset.tab === 'resumen') loadResumen(db, container);
    });
  });

  // Formulario emisión
  bindEmitirForm(container, db, emisor);
  bindConfigForm(container, db);
}

// ── Formulario Emitir ─────────────────────────────────────────────────────────

function buildEmitirForm(emisor) {
  const noConfig = !emisor.cuit;
  return `
    ${noConfig ? `<div class="fact-warn">
      <span class="material-icons">warning</span>
      Configurá los datos del emisor en la pestaña <b>Configuración</b> antes de emitir.
    </div>` : ''}

    <div class="fact-grid">
      <!-- Columna izquierda -->
      <div>
        <div class="fact-card">
          <div class="fact-card-title">Comprobante</div>
          <div class="fact-row">
            <label>Tipo</label>
            <select id="fTipo">
              <option>FAC. ELEC. B</option>
              <option>FAC. ELEC. A</option>
              <option>FAC. ELEC. C</option>
              <option>NOTA CRED. B</option>
              <option>NOTA CRED. A</option>
              <option>NOTA DEB. B</option>
              <option>NOTA DEB. A</option>
            </select>
          </div>
          <div class="fact-row">
            <label>Concepto</label>
            <select id="fConcepto">
              <option value="1">Productos</option>
              <option value="2">Servicios</option>
              <option value="3">Productos y Servicios</option>
            </select>
          </div>
          <div class="fact-row">
            <label>Forma de pago</label>
            <input type="text" id="fPago" value="Efectivo" />
          </div>
          <div class="fact-row">
            <label>Fecha</label>
            <input type="date" id="fFecha" value="${todayISO()}" />
          </div>
        </div>

        <div class="fact-card">
          <div class="fact-card-title">Cliente / Receptor</div>
          <div class="fact-row">
            <label>Nombre / Cliente</label>
            <input type="text" id="fCliente" value="CONSUMIDOR FINAL" />
          </div>
          <div class="fact-row">
            <label>CUIT (vacío = Cons. Final)</label>
            <input type="text" id="fCuitCliente" placeholder="20123456789" />
          </div>
          <div class="fact-row">
            <label>Razón Social</label>
            <input type="text" id="fRazonSocialCliente" placeholder="Razón Social legal del receptor" />
          </div>
          <div class="fact-row">
            <label>Domicilio</label>
            <input type="text" id="fDomCliente" placeholder="Opcional" />
          </div>
          <div class="fact-row">
            <label>Condición IVA</label>
            <select id="fCondIva">
              <option>Consumidor Final</option>
              <option>Responsable Inscripto</option>
              <option>Monotributista</option>
              <option>Exento</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Columna derecha -->
      <div>
        <div class="fact-card">
          <div class="fact-card-title">Ítems</div>
          <div class="fact-items-header">
            <span>Descripción</span><span>Cant.</span><span>Precio</span><span>Importe</span><span></span>
          </div>
          <div id="fItemsBody"></div>
          <button class="fact-btn-add-item" id="btnAddItem">
            <span class="material-icons">add</span> Agregar ítem
          </button>
        </div>

        <div class="fact-card">
          <div class="fact-card-title">Totales</div>
          <div class="fact-totales">
            <div class="fact-row">
              <label>IVA incluido (21%)</label>
              <div class="fact-iva-row">
                <input type="number" id="fIva" step="0.01" value="0" min="0" />
                <button class="fact-btn-calc" id="btnCalcIva" title="Calcular 21%">21%</button>
              </div>
            </div>
            <div class="fact-row">
              <label>Otros impuestos</label>
              <input type="number" id="fOtros" step="0.01" value="0" min="0" />
            </div>
            <div class="fact-total-box">
              <span>TOTAL</span>
              <span id="fTotalDisplay">$0,00</span>
            </div>
          </div>
        </div>

        <div class="fact-actions">
          <button class="fact-btn-afip" id="btnSolicitarCAE">
            <span class="material-icons">verified</span>
            Solicitar CAE a AFIP y Generar Factura
          </button>
          <button class="fact-btn-secondary" id="btnSoloPDF">
            <span class="material-icons">picture_as_pdf</span>
            Solo imprimir (sin AFIP)
          </button>
        </div>

        <div id="factStatus" class="fact-status hidden"></div>
      </div>
    </div>
  `;
}

function bindEmitirForm(container, db, emisor) {
  // Precargar catálogo en segundo plano
  loadCatalogo(db);

  // Primer ítem
  addItemRow(container, db);

  container.querySelector('#btnAddItem').addEventListener('click', () => addItemRow(container, db));

  // Calcular IVA 21%
  container.querySelector('#btnCalcIva').addEventListener('click', () => {
    const total = calcTotal(container);
    const iva = Math.round((total - total / 1.21) * 100) / 100;
    container.querySelector('#fIva').value = iva.toFixed(2);
  });

  // Actualizar total al cambiar ítems
  container.querySelector('#fItemsBody').addEventListener('input', () => {
    recalcItems(container);
    updateTotalDisplay(container);
  });
  ['fIva', 'fOtros'].forEach(id => {
    container.querySelector(`#${id}`)?.addEventListener('input', () => updateTotalDisplay(container));
  });

  // Solicitar CAE
  container.querySelector('#btnSolicitarCAE').addEventListener('click', async () => {
    await emitirFactura(container, db, emisor, true);
  });

  // Solo PDF
  container.querySelector('#btnSoloPDF').addEventListener('click', async () => {
    await emitirFactura(container, db, emisor, false);
  });
}

function addItemRow(container, db) {
  const body = container.querySelector('#fItemsBody');
  const row  = document.createElement('div');
  row.className = 'fact-item-row';
  row.innerHTML = `
    <div class="fi-desc-wrap">
      <input type="text"   class="fi-desc"    placeholder="Buscar producto o escribir descripción..." autocomplete="off" />
      <div class="fi-dropdown hidden"></div>
    </div>
    <input type="number" class="fi-cant"    value="1"   step="0.001" min="0" />
    <input type="number" class="fi-precio"  value="0"   step="0.01"  min="0" />
    <input type="number" class="fi-importe" value="0"   step="0.01"  readonly />
    <button class="fi-del" title="Eliminar"><span class="material-icons">close</span></button>
  `;

  const descInput = row.querySelector('.fi-desc');
  const dropdown  = row.querySelector('.fi-dropdown');
  let ddVisible = false;

  // Búsqueda en catálogo al escribir
  descInput.addEventListener('input', async () => {
    recalcRow(row);
    updateTotalDisplay(container);
    const texto = descInput.value.trim();
    const catalogo = await loadCatalogo(db);
    const resultados = buscarProductos(catalogo, texto);
    if (!resultados.length || !texto) {
      dropdown.classList.add('hidden');
      ddVisible = false;
      return;
    }
    dropdown.innerHTML = resultados.map(p => `
      <div class="fi-dd-item" data-precio="${p.precio_venta || 0}">
        <span class="fi-dd-nombre">${p.nombre || ''}</span>
        <span class="fi-dd-precio">$${Number(p.precio_venta || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
    ddVisible = true;

    dropdown.querySelectorAll('.fi-dd-item').forEach((item, i) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        descInput.value = resultados[i].nombre || '';
        row.querySelector('.fi-precio').value = Number(resultados[i].precio_venta || 0).toFixed(2);
        recalcRow(row);
        updateTotalDisplay(container);
        dropdown.classList.add('hidden');
        ddVisible = false;
        row.querySelector('.fi-cant').focus();
      });
    });
  });

  // Cerrar dropdown al perder foco
  descInput.addEventListener('blur', () => {
    setTimeout(() => { dropdown.classList.add('hidden'); ddVisible = false; }, 150);
  });

  // Recalcular al cambiar cant/precio
  ['fi-cant', 'fi-precio'].forEach(cls => {
    row.querySelector(`.${cls}`).addEventListener('input', () => {
      recalcRow(row);
      updateTotalDisplay(container);
    });
  });

  row.querySelector('.fi-del').addEventListener('click', () => {
    row.remove();
    updateTotalDisplay(container);
  });

  body.appendChild(row);
  descInput.focus();
}

function recalcRow(row) {
  const cant   = parseFloat(row.querySelector('.fi-cant').value) || 0;
  const precio = parseFloat(row.querySelector('.fi-precio').value) || 0;
  row.querySelector('.fi-importe').value = (cant * precio).toFixed(2);
}

function recalcItems(container) {
  container.querySelectorAll('.fact-item-row').forEach(recalcRow);
}

function calcTotal(container) {
  let sum = 0;
  container.querySelectorAll('.fi-importe').forEach(i => { sum += parseFloat(i.value) || 0; });
  return Math.round(sum * 100) / 100;
}

function updateTotalDisplay(container) {
  const total = calcTotal(container);
  container.querySelector('#fTotalDisplay').textContent = '$' + total.toLocaleString('es-AR', { minimumFractionDigits: 2 });
}

function getFormData(container, emisor) {
  const tipo        = container.querySelector('#fTipo').value;
  const concepto    = parseInt(container.querySelector('#fConcepto').value);
  const pago        = container.querySelector('#fPago').value.trim();
  const fecha       = container.querySelector('#fFecha').value;  // YYYY-MM-DD
  const cliente     = container.querySelector('#fCliente').value.trim() || 'CONSUMIDOR FINAL';
  const cuitCliente = container.querySelector('#fCuitCliente').value.trim().replace(/[-\s]/g, '');
  const razonSocialEl = container.querySelector('#fRazonSocialCliente');
  const razonSocial = razonSocialEl ? razonSocialEl.value.trim() : '';
  const domCliente  = container.querySelector('#fDomCliente').value.trim();
  const condIva     = container.querySelector('#fCondIva').value;
  const iva         = parseFloat(container.querySelector('#fIva').value) || 0;
  const otros       = parseFloat(container.querySelector('#fOtros').value) || 0;
  const total       = calcTotal(container);
  const neto        = Math.round((total - iva - otros) * 100) / 100;

  const items = [];
  container.querySelectorAll('.fact-item-row').forEach((row, i) => {
    const desc    = row.querySelector('.fi-desc').value.trim();
    const cant    = parseFloat(row.querySelector('.fi-cant').value) || 0;
    const precio  = parseFloat(row.querySelector('.fi-precio').value) || 0;
    const importe = parseFloat(row.querySelector('.fi-importe').value) || 0;
    if (desc || cant || precio) items.push({ idx: i + 1, desc, cant, precio, importe });
  });

  return { tipo, concepto, pago, fecha, cliente, cuitCliente, razonSocial, domCliente, condIva, iva, otros, total, neto, items, emisor };
}

async function getNextNro(db, tipo) {
  try {
    const q = query(collection(db, 'facturas'), orderBy('nro_comprobante', 'desc'), limit(1));
    // Filtrar por tipo no es necesario para numeración global por tipo — usamos el máximo general por tipo
    const snap = await getDocs(query(
      collection(db, 'facturas'),
      orderBy('created_at', 'desc'),
      limit(100)
    ));
    let max = 0;
    snap.forEach(d => {
      if (d.data().tipo_comprobante === tipo) {
        const n = d.data().nro_comprobante || 0;
        if (n > max) max = n;
      }
    });
    return max + 1;
  } catch { return 1; }
}

async function emitirFactura(container, db, emisor, conAfip) {
  const data = getFormData(container, emisor);

  if (!data.items.length) {
    showStatus(container, 'error', 'Agregá al menos un ítem antes de emitir.');
    return;
  }
  if (data.total <= 0) {
    showStatus(container, 'error', 'El total debe ser mayor a 0.');
    return;
  }

  const nro = await getNextNro(db, data.tipo);
  let cae = '', vtoCae = '';

  if (conAfip) {
    showStatus(container, 'loading', 'Conectando con AFIP...');
    container.querySelector('#btnSolicitarCAE').disabled = true;

    try {
      const res = await fetch('/api/afip-cae', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipo_comprobante:     data.tipo,
          punto_venta:          emisor.punto_venta || 1,
          nro_comprobante:      nro,
          importe_total:        data.total,
          importe_neto_gravado: data.neto,
          importe_iva:          data.iva,
          importe_otros:        data.otros,
          fecha_comprobante:    data.fecha.replace(/-/g, ''),
          concepto:             data.concepto,
          cuit_receptor:        data.cuitCliente || null,
          condicion_iva_receptor: data.condIva,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || 'Error desconocido');
      cae     = json.cae;
      vtoCae  = json.vto_cae;
      showStatus(container, 'success', `CAE obtenido: ${cae}`);
    } catch (err) {
      showStatus(container, 'error', 'Error AFIP: ' + err.message);
      container.querySelector('#btnSolicitarCAE').disabled = false;
      return;
    }
    container.querySelector('#btnSolicitarCAE').disabled = false;
  }

  // Guardar en Firestore (incluye snapshot del emisor para poder reimprimir sin
  // depender de perfiles_facturacion en el momento)
  try {
    await addDoc(collection(db, 'facturas'), {
      tipo_comprobante:  data.tipo,
      punto_venta:       emisor.punto_venta || 1,
      nro_comprobante:   nro,
      fecha:             data.fecha,
      cliente:              data.cliente,
      cuit_cliente:         data.cuitCliente,
      razon_social_receptor: data.razonSocial || data.cliente,
      domicilio_cliente:    data.domCliente,
      cond_iva_receptor:    data.condIva,
      concepto:          data.concepto,
      pago:              data.pago,
      items:             data.items,
      total:             data.total,
      iva_contenido:     data.iva,
      otros_impuestos:   data.otros,
      cae,
      vto_cae:           vtoCae,
      con_afip:          conAfip,
      // Snapshot del emisor al momento de emisión (reimpresiones fiables)
      emisor:            {
        razon_social:       emisor.razon_social || '',
        cuit:               emisor.cuit || '',
        domicilio:          emisor.domicilio || '',
        localidad:          emisor.localidad || '',
        telefono:           emisor.telefono || '',
        email:              emisor.email || '',
        ing_brutos:         emisor.ing_brutos || '',
        inicio_actividades: emisor.inicio_actividades || '',
        condicion_iva:      emisor.condicion_iva || '',
        punto_venta:        emisor.punto_venta || 1,
      },
      created_at:        new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' }).replace(' ', 'T'),
    });
    invalidateCache('facturas:all:2000');
  } catch (e) {
    console.warn('No se pudo guardar en Firestore:', e.message);
  }

  // Generar e imprimir factura
  printFactura({ ...data, nro, cae, vtoCae, emisor });
}

function showStatus(container, type, msg) {
  const el = container.querySelector('#factStatus');
  if (!el) return;
  el.className = `fact-status ${type}`;
  el.classList.remove('hidden');
  const icon = type === 'loading' ? 'hourglass_top' : type === 'success' ? 'check_circle' : 'error';
  el.innerHTML = `<span class="material-icons">${icon}</span> ${msg}`;
}

// ── Historial ─────────────────────────────────────────────────────────────────

async function loadHistorial(db, container) {
  const el = container.querySelector('#factHistorial');
  el.innerHTML = '<div class="loader"><div class="spinner"></div><span>Cargando...</span></div>';
  try {
    const all = await getCached('facturas:all:2000', async () => {
      const snap = await getDocs(query(collection(db, 'facturas'), orderBy('created_at', 'desc'), limit(2000)));
      const arr = [];
      snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
      return arr;
    }, { ttl: 60 * 1000 });
    const rows = all.slice(0, 100);

    if (!rows.length) {
      el.innerHTML = '<div class="empty-state"><span class="material-icons">receipt_long</span><p>Sin comprobantes emitidos aún.</p></div>';
      return;
    }

    // Totales por Punto de Venta (suma de 'total' agrupado por punto_venta)
    const porPV = {};
    rows.forEach(r => {
      const pv = parseInt(r.punto_venta) || 1;
      if (!porPV[pv]) porPV[pv] = { total: 0, count: 0 };
      porPV[pv].total += Number(r.total || 0);
      porPV[pv].count++;
    });
    const pvsOrdenados = Object.keys(porPV).map(n => parseInt(n)).sort((a, b) => a - b);
    const totalGeneral = rows.reduce((s, r) => s + Number(r.total || 0), 0);

    const resumenPV = `
      <div class="fact-pv-resumen">
        ${pvsOrdenados.map(pv => `
          <div class="fact-pv-card">
            <div class="fact-pv-label">PV ${pv}</div>
            <div class="fact-pv-total">$${porPV[pv].total.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            <div class="fact-pv-count">${porPV[pv].count} ${porPV[pv].count === 1 ? 'comprobante' : 'comprobantes'}</div>
          </div>
        `).join('')}
        <div class="fact-pv-card fact-pv-total-general">
          <div class="fact-pv-label">Total general</div>
          <div class="fact-pv-total">$${totalGeneral.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div class="fact-pv-count">${rows.length} comprobantes</div>
        </div>
      </div>
    `;

    el.innerHTML = `
      ${resumenPV}
      <div class="table-wrapper">
        <table class="fact-table">
          <thead><tr>
            <th>#</th><th>Tipo</th><th>Nro.</th><th>Fecha</th>
            <th>Cliente</th><th>Total</th><th>CAE</th><th></th>
          </tr></thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr>
                <td>${i + 1}</td>
                <td><span class="fact-badge">${r.tipo_comprobante || ''}</span></td>
                <td>${String(r.punto_venta || 1).padStart(5, '0')}-${String(r.nro_comprobante || 0).padStart(8, '0')}</td>
                <td>${fmtFecha(r.fecha)}</td>
                <td>${r.cliente || '—'}</td>
                <td class="text-right"><b>$${Number(r.total || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</b></td>
                <td><span class="${r.cae ? 'cae-ok' : 'cae-no'}">${r.cae ? r.cae.slice(0, 6) + '…' : 'Sin CAE'}</span></td>
                <td>
                  <button class="fact-btn-reprint" data-id="${r.id}" title="Reimprimir">
                    <span class="material-icons">print</span>
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    el.querySelectorAll('.fact-btn-reprint').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = rows.find(r => r.id === btn.dataset.id);
        if (!row) return;
        // Facturas viejas no tienen `emisor` snapshot → reconstruir desde los
        // campos root que sync_factura del POS subió flat.
        const emisor = row.emisor || {
          razon_social:       row.razon_social       || '',
          cuit:               row.cuit               || '',
          domicilio:          row.domicilio          || '',
          localidad:          row.localidad          || '',
          telefono:           row.telefono           || '',
          email:              row.email              || '',
          ing_brutos:         row.ing_brutos         || '',
          inicio_actividades: row.inicio_actividades || '',
          condicion_iva:      row.condicion_iva      || '',
          punto_venta:        row.punto_venta        || 1,
        };
        printFactura({ ...row, vtoCae: row.vto_cae, emisor });
      });
    });
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><span class="material-icons">error_outline</span><p>Error: ${err.message}</p></div>`;
  }
}

function fmtFecha(f) {
  if (!f) return '—';
  if (f.includes('-')) {
    const [y, m, d] = f.split('-');
    return `${d}/${m}/${y}`;
  }
  return f;
}

// ── Config ────────────────────────────────────────────────────────────────────

function buildConfigForm(emisor) {
  const fields = [
    ['CUIT',                'cuit',               'Ej: 20123456789'],
    ['Razón Social',        'razon_social',        'Nombre legal del negocio'],
    ['Domicilio',           'domicilio',           'Ej: Av. Colón 123'],
    ['Localidad',           'localidad',           'Ej: CÓRDOBA (5000) - CBA'],
    ['Teléfono',            'telefono',            'Ej: 3511234567'],
    ['Ingresos Brutos',     'ing_brutos',          'Número de Ingresos Brutos'],
    ['Inicio Actividades',  'inicio_actividades',  'Ej: 01/01/2020'],
    ['Condición IVA',       'condicion_iva',       'Ej: Responsable Inscripto'],
    ['Punto de Venta',      'punto_venta',         'Número de PV AFIP (ej: 1)'],
  ];

  return `
    <div class="fact-card">
      <div class="fact-card-title">Datos del Emisor (aparecen en todas las facturas)</div>
      ${fields.map(([lbl, key, ph]) => `
        <div class="fact-row">
          <label>${lbl}</label>
          <input type="text" id="cfg_${key}" value="${emisor[key] || ''}" placeholder="${ph}" />
        </div>
      `).join('')}
      <div class="fact-row">
        <label style="color:#dc3545;font-weight:600">Las credenciales AFIP (certificado y clave) se configuran
        como variables de entorno en el panel de Netlify — nunca se guardan aquí.</label>
      </div>
      <button class="fact-btn-afip" id="btnSaveConfig">
        <span class="material-icons">save</span> Guardar datos del emisor
      </button>
      <div id="cfgStatus" class="fact-status hidden"></div>
    </div>
    <div class="fact-card" style="background:#fff8e1;border-color:#ffe082">
      <div class="fact-card-title" style="color:#b45309">Variables de entorno Netlify (configurar en el panel)</div>
      <ul style="font-size:13px;line-height:2;margin:0;padding-left:18px;color:#555">
        <li><b>AFIP_CUIT</b> — CUIT del emisor sin guiones</li>
        <li><b>AFIP_CERT_PEM</b> — Contenido del .crt (reemplazar saltos de línea por \\n)</li>
        <li><b>AFIP_KEY_PEM</b> — Contenido del .key (reemplazar saltos de línea por \\n)</li>
        <li><b>AFIP_PUNTO_VENTA</b> — Número de punto de venta (ej: 1)</li>
        <li><b>AFIP_PRODUCCION</b> — "1" para producción, vacío para homologación</li>
      </ul>
    </div>
  `;
}

function bindConfigForm(container, db) {
  container.querySelector('#btnSaveConfig')?.addEventListener('click', async () => {
    const btn = container.querySelector('#btnSaveConfig');
    const st  = container.querySelector('#cfgStatus');
    btn.disabled = true;

    const data = {};
    ['cuit','razon_social','domicilio','localidad','telefono',
     'ing_brutos','inicio_actividades','condicion_iva','punto_venta'].forEach(key => {
      const el = container.querySelector(`#cfg_${key}`);
      if (el) data[key] = el.value.trim();
    });
    data.punto_venta = parseInt(data.punto_venta) || 1;

    try {
      const { doc, setDoc } = await import('firebase/firestore');
      await setDoc(doc(db, 'config', 'afip'), data, { merge: true });
      _emisorConfig = data;
      st.className = 'fact-status success';
      st.classList.remove('hidden');
      st.innerHTML = '<span class="material-icons">check_circle</span> Configuración guardada';
    } catch (err) {
      st.className = 'fact-status error';
      st.classList.remove('hidden');
      st.innerHTML = '<span class="material-icons">error</span> Error: ' + err.message;
    }
    btn.disabled = false;
  });
}

// ── Generar factura imprimible ────────────────────────────────────────────────

function printFactura(data) {
  const { tipo, nro, fecha, cliente, cuitCliente, razonSocial, domCliente, condIva, pago,
          items, total, iva, otros, cae, vtoCae, emisor } = normalizeData(data);

  const letra    = tipo.includes(' A') ? 'A' : tipo.includes(' C') ? 'C' : 'B';
  const codAfip  = letra === 'A' ? 'COD. 01' : letra === 'C' ? 'COD. 11' : 'COD. 06';
  const codTipo  = letra === 'A' ? 1 : letra === 'C' ? 11 : 6;
  const nomComp  = tipo.includes('NOTA CRED') ? 'NOTA DE CRÉDITO' :
                   tipo.includes('NOTA DEB')  ? 'NOTA DE DÉBITO'  : 'FACTURA';
  const ptoStr   = String(emisor.punto_venta || 1).padStart(5, '0');
  const nroStr   = String(nro || 1).padStart(8, '0');
  const fechaFmt = fmtFecha(fecha);
  const vtoCaeFmt = vtoCae && vtoCae.length === 8
    ? `${vtoCae.slice(6)}/${vtoCae.slice(4, 6)}/${vtoCae.slice(0, 4)}`
    : vtoCae;

  // QR AFIP
  let qrHtml = '';
  if (cae) {
    const cuitInt = parseInt((emisor.cuit || '0').replace(/[-\s]/g, '')) || 0;
    const caeInt  = parseInt(cae) || 0;
    const cuitRecInt = parseInt((cuitCliente || '0').replace(/[-\s]/g, '')) || 0;
    const qrData  = JSON.stringify({
      ver: 1, fecha: fecha ? fecha.replace(/-/g, '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '',
      cuit: cuitInt, ptoVta: parseInt(emisor.punto_venta || 1),
      tipoCmp: codTipo, nroCmp: parseInt(nro || 1),
      importe: Math.round(total * 100) / 100,
      moneda: 'PES', ctz: 1,
      tipoDocRec: cuitCliente ? 80 : 99,
      nroDocRec: cuitRecInt,
      tipoCodAut: 'E', codAut: caeInt,
    });
    const qrB64 = btoa(unescape(encodeURIComponent(qrData)));
    const qrUrl = `https://www.afip.gob.ar/fe/qr/?p=${qrB64}`;
    // Usamos Google Charts API para generar el QR (no requiere librería)
    qrHtml = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=90x90&data=${encodeURIComponent(qrUrl)}" width="90" height="90" alt="QR AFIP" class="qr-img" />`;
  }

  const neto = Math.round((total - iva - otros) * 100) / 100;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <title>${nomComp} ${ptoStr}-${nroStr}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, sans-serif; font-size: 11px; }
    body { background: #f0f0f0; }
    .page { width: 210mm; min-height: 297mm; background: white; margin: 0 auto;
            padding: 12mm 12mm 20mm; position: relative; }
    /* Header 3 col */
    .hdr { display: grid; grid-template-columns: 1fr 32mm 1fr;
           border: 1.5px solid #000; }
    .hdr-col { padding: 6px 8px; }
    .hdr-center { border-left: 1px solid #000; border-right: 1px solid #000;
                  display: flex; flex-direction: column; align-items: center;
                  justify-content: center; text-align: center; }
    .letra-grande { font-size: 36px; font-weight: bold; line-height: 1; }
    .cod-afip { font-size: 7px; font-weight: bold; margin-top: 2px; }
    /* Logo + texto del emisor lado a lado (mismo layout que el PDF del POS) */
    .emisor-inner { display: flex; align-items: center; gap: 6px; }
    .emisor-logo-col { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; }
    .emisor-text-col { flex: 1 1 auto; min-width: 0; }
    .fact-logo { display: block; width: 22mm; height: auto; object-fit: contain; }
    .emisor-name { font-size: 12px; font-weight: bold; margin-bottom: 4px; }
    .row-lbl { font-weight: bold; font-size: 8px; }
    .row-val { font-size: 8px; margin-bottom: 2px; }
    .comp-title { font-size: 13px; font-weight: bold; margin-bottom: 6px; text-align: center; }
    /* Receptor */
    .receptor { border: 1px solid #000; border-top: none; }
    .rec-row { display: grid; grid-template-columns: 1fr 1fr; padding: 4px 8px;
               border-bottom: 0.5px solid #ccc; }
    .rec-row:last-child { border-bottom: none; }
    /* Forma de pago */
    .pago-bar { border: 0.5px solid #000; border-top: none;
                padding: 3px 8px; background: #fafafa; }
    /* Items */
    .items-tbl { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .items-tbl th { background: #f0f0f0; border-top: 1px solid #000; border-bottom: 1px solid #000;
                    padding: 4px 6px; text-align: center; font-size: 8px; }
    .items-tbl td { padding: 3px 6px; border-bottom: 0.3px solid #ddd; font-size: 8.5px; }
    .items-tbl td.right { text-align: right; }
    .items-tbl td.center { text-align: center; }
    /* Totales */
    .totales { display: flex; justify-content: flex-end; margin-top: 6px; }
    .total-box { border: 1px solid #000; padding: 6px 12px; display: flex;
                 gap: 20px; align-items: center; font-size: 12px; font-weight: bold; }
    /* Transparencia */
    .transp { border: 0.5px solid #aaa; background: #fafafa; padding: 4px 8px;
              margin-top: 6px; font-size: 7.5px; }
    /* Footer */
    .footer { display: grid; grid-template-columns: 24mm 36mm 1fr;
              border: 1px solid #000; margin-top: 10px; }
    .footer-col { padding: 6px 8px; }
    .footer-sep { border-left: 0.5px solid #ccc; border-right: 0.5px solid #ccc; }
    .afip-logo { font-size: 18px; font-weight: bold; color: #1a3a6b; text-align: center; }
    .afip-auth { font-size: 7px; text-align: center; color: #333; margin-top: 2px; }
    .cae-num { font-weight: bold; font-size: 9px; margin-bottom: 3px; }
    .cae-vto { font-size: 8px; margin-bottom: 6px; }
    .cae-disc { font-size: 6.5px; color: #555; line-height: 1.4; }
    .no-cae { color: #999; font-style: italic; font-size: 9px; }
    @media print {
      body { background: white; }
      .page { padding: 8mm 8mm 12mm; box-shadow: none; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
<div class="page">

  <!-- BOTÓN IMPRIMIR (no se imprime) -->
  <div class="no-print" style="text-align:center;margin-bottom:12px">
    <button onclick="window.print()" style="padding:10px 28px;background:#0d6efd;color:white;
      border:none;border-radius:8px;font-size:14px;cursor:pointer;font-weight:600">
      🖨️ Imprimir / Guardar PDF
    </button>
    <button onclick="window.close()" style="margin-left:12px;padding:10px 20px;background:#6c757d;
      color:white;border:none;border-radius:8px;font-size:14px;cursor:pointer">
      Cerrar
    </button>
  </div>

  <!-- HEADER 3 COLUMNAS -->
  <div class="hdr">
    <div class="hdr-col">
      <div class="emisor-inner">
        <div class="emisor-logo-col">
          <img src="${window.location.origin}/logo-liceo.png" alt="Libreria Liceo" class="fact-logo" onerror="this.style.display='none'"/>
        </div>
        <div class="emisor-text-col">
          <div class="emisor-name">${emisor.razon_social || ''}</div>
          <div class="row-val"><span class="row-lbl">Razon Social:</span> ${emisor.razon_social || ''}</div>
          <div class="row-val"><span class="row-lbl">Domicilio Comercial:</span> ${emisor.domicilio || ''}</div>
          ${emisor.localidad ? `<div class="row-val">${emisor.localidad}</div>` : ''}
          <div class="row-val" style="font-weight:bold">Condicion frente al IVA: ${emisor.condicion_iva || 'Resp. Inscripto'}</div>
          ${emisor.telefono ? `<div class="row-val"><span class="row-lbl">Tel:</span> ${emisor.telefono}</div>` : ''}
          ${emisor.email ? `<div class="row-val">${emisor.email}</div>` : ''}
        </div>
      </div>
    </div>
    <div class="hdr-center">
      <div class="letra-grande">${letra}</div>
      <div class="cod-afip">${codAfip}</div>
    </div>
    <div class="hdr-col">
      <div class="comp-title">${nomComp}</div>
      <div class="row-val"><span class="row-lbl">Compr. Nro:</span> ${ptoStr}-${nroStr}</div>
      <div class="row-val"><span class="row-lbl">Fecha de Emision:</span> ${fechaFmt}</div>
      <br/>
      <div class="row-val"><span class="row-lbl">CUIT:</span> ${emisor.cuit || ''}</div>
      <div class="row-val"><span class="row-lbl">Ingresos Brutos:</span> ${emisor.ing_brutos || ''}</div>
      <div class="row-val"><span class="row-lbl">Inicio de Actividades:</span> ${emisor.inicio_actividades || ''}</div>
    </div>
  </div>

  <!-- RECEPTOR -->
  <div class="receptor">
    <div class="rec-row">
      <div><span class="row-lbl">Senor(es):</span> ${cliente}</div>
      <div><span class="row-lbl">CUIT:</span> ${cuitCliente || '—'}</div>
    </div>
    <div class="rec-row">
      <div><span class="row-lbl">Razon Social:</span> ${razonSocial || cliente}</div>
      <div><span class="row-lbl">Condicion frente al IVA:</span> ${condIva}</div>
    </div>
    <div class="rec-row">
      <div><span class="row-lbl">Domicilio:</span> ${domCliente || '—'}</div>
      <div></div>
    </div>
  </div>

  <!-- FORMA DE PAGO -->
  <div class="pago-bar"><span class="row-lbl">Forma de Pago:</span> ${pago}</div>

  <!-- ITEMS -->
  <table class="items-tbl">
    <thead>
      <tr>
        <th>Item</th><th style="text-align:left">Descripcion</th>
        <th>Cantidad</th><th>Precio Unit. ($)</th><th>Total por Item ($)</th>
      </tr>
    </thead>
    <tbody>
      ${(items || []).map((it, i) => `
        <tr>
          <td class="center">${String(i + 1).padStart(4, '0')}</td>
          <td>${it.desc || it.descripcion || ''}</td>
          <td class="center">${Number(it.cant || it.cantidad || 1).toFixed(6)}</td>
          <td class="center">${Number(it.precio || it.unit_price || 0).toFixed(6)}</td>
          <td class="center">${Number(it.importe || 0).toFixed(2)}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <!-- TOTAL -->
  <div class="totales">
    <div class="total-box">
      <span>Importe Total:</span>
      <span>$${Number(total).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span>
    </div>
  </div>

  <!-- TRANSPARENCIA FISCAL -->
  <div class="transp">
    Regimen de Transparencia Fiscal al Consumidor (Ley 27.743) —
    IVA Contenido: <b>$${Number(iva).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</b> —
    Otros Imp. Nac. Indirectos: <b>$${Number(otros).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</b>
  </div>

  <!-- FOOTER: QR + AFIP + CAE -->
  <div class="footer">
    <div class="footer-col" style="display:flex;align-items:center;justify-content:center">
      ${cae ? qrHtml : '<span class="no-cae">Sin QR<br/>(sin CAE)</span>'}
    </div>
    <div class="footer-col footer-sep" style="display:flex;flex-direction:column;align-items:center;justify-content:center">
      <div class="afip-logo">AFIP</div>
      <div class="afip-auth">Comprobante Autorizado</div>
    </div>
    <div class="footer-col">
      ${cae ? `
        <div class="cae-num">CAE Nro: ${cae}</div>
        <div class="cae-vto">Fecha de Vto. de CAE: ${vtoCaeFmt}</div>
        <div class="cae-disc">Esta Administracion Federal no se responsabiliza por la veracidad
        de los datos ingresados en el detalle de la operacion.</div>
      ` : `
        <div class="no-cae">Comprobante sin CAE — no tiene validez fiscal oficial.</div>
      `}
    </div>
  </div>

</div>
<script>
  // Auto-abrir diálogo de impresión
  window.onload = () => { window.print(); };
</script>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) {
    alert('Bloqueaste las ventanas emergentes. Habilitala para este sitio para imprimir.');
    return;
  }
  win.document.write(html);
  win.document.close();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeData(d) {
  return {
    tipo:        d.tipo       || d.tipo_comprobante || 'FAC. ELEC. B',
    nro:         d.nro        || d.nro_comprobante  || 1,
    fecha:       d.fecha,
    cliente:     d.cliente    || 'CONSUMIDOR FINAL',
    cuitCliente: d.cuitCliente || d.cuit_cliente    || '',
    razonSocial: d.razonSocial || d.razon_social_receptor || d.razon_social_cliente || '',
    domCliente:  d.domCliente  || d.domicilio_cliente || '',
    condIva:     d.condIva     || d.cond_iva_receptor || 'Consumidor Final',
    pago:        d.pago        || 'Efectivo',
    items:       d.items       || [],
    total:       d.total       || 0,
    iva:         d.iva         || d.iva_contenido   || 0,
    otros:       d.otros       || d.otros_impuestos || 0,
    cae:         d.cae         || '',
    vtoCae:      d.vtoCae      || d.vto_cae         || '',
    emisor:      d.emisor      || {},
  };
}

function todayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

// ── Resumen por emisor ────────────────────────────────────────────────────────

async function loadResumen(db, container) {
  const el = container.querySelector('#factResumen');
  if (!el) return;

  // Leer fechas del filtro
  const desdeInput = container.querySelector('#resumenDesde');
  const hastaInput = container.querySelector('#resumenHasta');
  if (!desdeInput.value) desdeInput.value = todayISO();
  if (!hastaInput.value) hastaInput.value = todayISO();
  const desde = desdeInput.value;
  const hasta = hastaInput.value;

  el.innerHTML = '<div class="loader"><div class="spinner"></div><span>Calculando...</span></div>';

  try {
    const { collection, getDocs, query, orderBy, limit } = await import('firebase/firestore');

    // Cache del listado de facturas (compartido entre Historial y Resumen) —
    // bajamos hasta 2000 y filtramos client-side. `fecha` viene como "DD/MM/YYYY"
    // desde el POS, así que parseamos a ISO para comparar con el rango.
    const todas = await getCached('facturas:all:2000', async () => {
      const snap = await getDocs(query(
        collection(db, 'facturas'),
        orderBy('created_at', 'desc'),
        limit(2000),
      ));
      const arr = [];
      snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
      return arr;
    }, { ttl: 60 * 1000 });

    const toIso = raw => {
      if (!raw) return '';
      if (raw && typeof raw === 'object' && typeof raw.toDate === 'function') {
        return raw.toDate().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
      }
      const s = String(raw);
      // "DD/MM/YYYY..." → "YYYY-MM-DD"
      const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}`;
      // "YYYY-MM-DD..." → ya está
      return s.slice(0, 10);
    };

    const filtered = todas.filter(f => {
      const iso = toIso(f.fecha) || toIso(f.created_at);
      return iso >= desde && iso <= hasta;
    });

    if (!filtered.length) {
      el.innerHTML = `<div style="padding:32px;text-align:center;color:#6c757d;">
        No hay facturas en el período seleccionado.
      </div>`;
      // Bind botón de nuevo
      container.querySelector('#resumenBuscar')?.addEventListener('click', () => loadResumen(db, container));
      return;
    }

    // Agrupar por emisor (nombre_perfil o razon_social)
    const porEmisor = {};
    let totalGeneral = 0;

    for (const f of filtered) {
      const emisorKey = f.nombre_perfil || f.razon_social || f.emisor?.razon_social || 'Sin emisor';
      const total = parseFloat(f.total || 0);
      const tipo = f.tipo || f.tipo_comprobante || 'FAC. ELEC. C';
      const cliente = f.cliente || 'CONSUMIDOR FINAL';
      const esConsumidor = !f.cuit_receptor && (!cliente || cliente.toUpperCase().includes('CONSUMIDOR'));

      if (!porEmisor[emisorKey]) {
        porEmisor[emisorKey] = {
          total: 0, count: 0, consumidorFinal: 0, conCuit: 0,
          porTipo: {}, facturas: []
        };
      }
      porEmisor[emisorKey].total += total;
      porEmisor[emisorKey].count += 1;
      if (esConsumidor) porEmisor[emisorKey].consumidorFinal += total;
      else porEmisor[emisorKey].conCuit += total;
      porEmisor[emisorKey].porTipo[tipo] = (porEmisor[emisorKey].porTipo[tipo] || 0) + total;
      porEmisor[emisorKey].facturas.push(f);
      totalGeneral += total;
    }

    const fmt = n => '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const cards = Object.entries(porEmisor).map(([nombre, data]) => {
      const tiposHtml = Object.entries(data.porTipo)
        .map(([t, v]) => `<span class="res-badge">${t.replace('FAC. ELEC. ', '')}: ${fmt(v)}</span>`)
        .join('');

      return `
        <div class="res-card">
          <div class="res-card-header">
            <span class="res-emisor">${nombre}</span>
            <span class="res-total">${fmt(data.total)}</span>
          </div>
          <div class="res-stats">
            <div class="res-stat">
              <span class="res-stat-label">Facturas</span>
              <span class="res-stat-val">${data.count}</span>
            </div>
            <div class="res-stat">
              <span class="res-stat-label">Consumidor Final</span>
              <span class="res-stat-val">${fmt(data.consumidorFinal)}</span>
            </div>
            <div class="res-stat">
              <span class="res-stat-label">Con CUIT</span>
              <span class="res-stat-val">${fmt(data.conCuit)}</span>
            </div>
          </div>
          <div class="res-tipos">${tiposHtml}</div>
        </div>`;
    }).join('');

    el.innerHTML = `
      <div class="res-summary-bar">
        <span>Total periodo: <strong>${fmt(totalGeneral)}</strong></span>
        <span style="color:#6c757d;font-size:12px;">${filtered.length} comprobante${filtered.length !== 1 ? 's' : ''} · ${desde === hasta ? desde : desde + ' → ' + hasta}</span>
      </div>
      <div class="res-cards">${cards}</div>
    `;
  } catch (e) {
    el.innerHTML = `<div style="padding:20px;color:#dc3545;">Error cargando datos: ${e.message}</div>`;
  }

  // Bind botón actualizar
  container.querySelector('#resumenBuscar')?.addEventListener('click', () => loadResumen(db, container));
}
