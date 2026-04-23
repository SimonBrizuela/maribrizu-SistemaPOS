import {
  collection, getDocs, doc, addDoc, deleteDoc, getDoc, updateDoc,
  query, orderBy, limit, serverTimestamp
} from 'firebase/firestore';
import { getCached, invalidateCacheByPrefix } from '../cache.js';
import { getFechaInicioDate, saveControlConfig, isVentaVarios2, isItemVarios2 } from '../config.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function todayAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}
function parseArDate(raw) {
  if (!raw) return new Date(NaN);
  if (typeof raw.toDate === 'function') return raw.toDate();
  if (typeof raw === 'object' && raw.seconds !== undefined)
    return new Date(raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6));
  return new Date(raw);
}

function periodoRango(periodo) {
  const hoy = todayAR();
  const now = new Date(hoy + 'T00:00:00-03:00');
  if (periodo === 'hoy')    return { desde: now, label: 'Hoy' };
  if (periodo === 'semana') { const d = new Date(now); d.setDate(d.getDate() - 6); return { desde: d, label: 'Últimos 7 días' }; }
  const inicioMes = new Date(hoy.slice(0, 7) + '-01T00:00:00-03:00');
  return { desde: inicioMes, label: 'Este mes' };
}

// ── Render principal ──────────────────────────────────────────────────────────
export async function renderControlTotal(container, db) {
  let periodo = localStorage.getItem('ct:periodo') || 'hoy';
  const config = await loadConfig(db);

  container.innerHTML = buildSkeleton(periodo, config);

  container.querySelectorAll('.ct-periodo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      periodo = btn.dataset.p;
      localStorage.setItem('ct:periodo', periodo);
      container.querySelectorAll('.ct-periodo-btn').forEach(b => b.classList.toggle('active', b.dataset.p === periodo));
      refreshDatos(container, db, periodo, config);
    });
  });

  setupGastoForm(container, db, periodo, config);
  setupConfigCuentas(container, db, config);

  await refreshDatos(container, db, periodo, config);
}

// ── Config de cuentas ─────────────────────────────────────────────────────────
async function loadConfig(db) {
  try {
    const snap = await getDoc(doc(db, 'control_config', 'settings'));
    if (snap.exists()) return snap.data();
  } catch (_) {}
  return { cuenta1_nombre: 'Cuenta 1', cuenta2_nombre: 'Cuenta 2' };
}

// ── Cargar datos y renderizar ─────────────────────────────────────────────────
async function refreshDatos(container, db, periodo, config) {
  const { desde: desdePeriodo } = periodoRango(periodo);
  const fechaInicio = await getFechaInicioDate(db);
  // La fecha efectiva = la más reciente entre el período elegido y la fecha_inicio global
  const desde = desdePeriodo > fechaInicio ? desdePeriodo : fechaInicio;

  const zonas = ['ct-stats', 'ct-alertas', 'ct-gastos-lista'];
  zonas.forEach(id => {
    const el = container.querySelector(`#${id}`);
    if (el) el.innerHTML = `<div class="ct-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div>`;
  });

  // Cargar en paralelo — cache compartido con otras páginas
  const [ventas, itemsMap, catalogo, gastos] = await Promise.all([
    getCached('dashboard:ventas', async () => {
      const snap = await getDocs(query(collection(db, 'ventas'), orderBy('created_at', 'desc'), limit(500)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }, { ttl: 60 * 1000 }),
    getCached('ct:items_rich', async () => {
      const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('num_venta', 'asc'), limit(5000)));
      const map = {};
      snap.docs.forEach(d => {
        const data = d.data();
        if (data.deleted === true) return;
        if (isItemVarios2(data)) return;
        const nombre = (data.producto || data.product_name || '').toUpperCase().trim();
        // doc.id = "{pc_id}_{sale_id}_{idx}" → pc_id = todo menos las últimas 2 piezas.
        // Key compuesta pc_id+sale_id evita mezclar items de distintas PCs con mismo num_venta.
        const parts = d.id.split('_');
        const pcId  = parts.length >= 3 ? parts.slice(0, -2).join('_') : '';
        const key   = pcId ? `${pcId}_${data.num_venta}` : String(data.num_venta);
        if (!map[key]) map[key] = [];
        map[key].push({
          nombre,
          cantidad:        data.cantidad || data.quantity || 1,
          precio_unitario: data.precio_unitario || data.unit_price || 0,
          subtotal:        data.subtotal || 0,
        });
      });
      return map;
    }, { ttl: 5 * 60 * 1000, memOnly: true }),
    getCached('catalogo:all', async () => {
      const snap = await getDocs(collection(db, 'catalogo'));
      return snap.docs.map(d => ({ doc_id: d.id, ...d.data() }));
    }, { ttl: 10 * 60 * 1000, memOnly: true }),
    getCached(`ct:gastos:${desde.toISOString().slice(0,10)}`, () => loadGastos(db, desde), { ttl: 30 * 1000 }),
  ]);

  // Índice catálogo por nombre (para costo + doc_id)
  const catalogoPorNombre = {};
  catalogo.forEach(p => {
    const key = (p.nombre || '').toUpperCase().trim();
    if (key) catalogoPorNombre[key] = p;
  });

  // Filtrar ventas por período y excluir eliminadas + Varios 2 (no son ventas reales)
  const ventasPeriodo = ventas.filter(v => {
    if (v.deleted === true) return false;
    if (isVentaVarios2(v)) return false;
    const fecha = parseArDate(v.created_at);
    return fecha >= desde;
  });

  // ── Totales de ventas ──
  const ingresoTotal   = ventasPeriodo.reduce((s, v) => s + (v.total_amount || 0), 0);
  const efectivoTotal  = ventasPeriodo.filter(v => v.payment_type === 'cash').reduce((s, v) => s + (v.total_amount || 0), 0);

  let transCuenta1 = 0, transCuenta2 = 0;
  ventasPeriodo.filter(v => v.payment_type !== 'cash').forEach(v => {
    const cuenta = v.transfer_account || v.cuenta_id || 'cuenta1';
    if (cuenta === 'cuenta2') transCuenta2 += (v.total_amount || 0);
    else transCuenta1 += (v.total_amount || 0);
  });

  // ── CMV con separación items con/sin costo + detección de pérdidas ──
  let cmv = 0;
  let ingresoConCosto = 0;
  let ingresoSinCosto = 0;
  let itemsSinCosto = 0;
  let itemsPerdida = 0;
  let montoPerdida = 0;
  const mapaSinCosto = {};   // { nombre: { cantidad, ingreso, doc_id, precio_venta } }
  const mapaPerdida  = {};   // { nombre: { cantidad, perdida, costo, precio, doc_id } }
  const mapaConCosto = {};   // { nombre: { cantidad, ingreso, cmv, costoUnit, precioUnit } } para detalle por producto

  ventasPeriodo.forEach(v => {
    const saleId = v.sale_id || v.id;
    const key = v.pc_id ? `${v.pc_id}_${saleId}` : String(saleId);
    const items = itemsMap[key] || [];
    items.forEach(item => {
      const cat = catalogoPorNombre[item.nombre];
      const costoUnit = cat?.costo || 0;
      const costoItem = costoUnit * item.cantidad;
      const ingresoItem = item.subtotal || (item.precio_unitario * item.cantidad) || 0;

      if (costoUnit > 0) {
        cmv += costoItem;
        ingresoConCosto += ingresoItem;
        if (!mapaConCosto[item.nombre]) {
          mapaConCosto[item.nombre] = { cantidad: 0, ingreso: 0, cmv: 0, costoUnit, precioUnit: item.precio_unitario };
        }
        mapaConCosto[item.nombre].cantidad += item.cantidad;
        mapaConCosto[item.nombre].ingreso  += ingresoItem;
        mapaConCosto[item.nombre].cmv      += costoItem;
        if (ingresoItem > 0 && ingresoItem < costoItem) {
          const perdidaItem = costoItem - ingresoItem;
          itemsPerdida++;
          montoPerdida += perdidaItem;
          if (!mapaPerdida[item.nombre]) {
            mapaPerdida[item.nombre] = { cantidad: 0, perdida: 0, costo: costoUnit, precio: item.precio_unitario, doc_id: cat?.doc_id };
          }
          mapaPerdida[item.nombre].cantidad += item.cantidad;
          mapaPerdida[item.nombre].perdida += perdidaItem;
        }
      } else {
        ingresoSinCosto += ingresoItem;
        itemsSinCosto++;
        if (!mapaSinCosto[item.nombre]) {
          mapaSinCosto[item.nombre] = {
            cantidad: 0, ingreso: 0,
            doc_id: cat?.doc_id,
            precio_venta: cat?.precio_venta || item.precio_unitario || 0,
            en_catalogo: !!cat,
          };
        }
        mapaSinCosto[item.nombre].cantidad += item.cantidad;
        mapaSinCosto[item.nombre].ingreso  += ingresoItem;
      }
    });
  });

  // ── Gastos por tipo ──
  const gastoEfectivo = gastos.filter(g => g.tipo === 'efectivo').reduce((s, g) => s + (g.monto || 0), 0);
  const gastoCuenta1  = gastos.filter(g => g.tipo === 'cuenta1').reduce((s, g) => s + (g.monto || 0), 0);
  const gastoCuenta2  = gastos.filter(g => g.tipo === 'cuenta2').reduce((s, g) => s + (g.monto || 0), 0);
  const gastoTotal    = gastoEfectivo + gastoCuenta1 + gastoCuenta2;

  // Ganancia bruta SOLO de los items con costo conocido — así no se distorsiona
  const gananciaBruta = ingresoConCosto - cmv;
  const gananciaNeta  = gananciaBruta - gastoTotal;

  const netoEfectivo = efectivoTotal - gastoEfectivo;
  const netoCuenta1  = transCuenta1  - gastoCuenta1;
  const netoCuenta2  = transCuenta2  - gastoCuenta2;

  // ── Render stats ──
  const statsEl = container.querySelector('#ct-stats');
  if (statsEl) {
    const colorNeta = gananciaNeta >= 0 ? '#1b5e20' : '#b71c1c';
    const bgNeta    = gananciaNeta >= 0 ? '#f1f8f1' : '#fff5f5';
    const iconNeta  = gananciaNeta >= 0 ? 'trending_up' : 'trending_down';
    const margen    = ingresoConCosto > 0 ? Math.round((gananciaBruta / ingresoConCosto) * 100) : 0;
    const c1 = config.cuenta1_nombre || 'Cuenta 1';
    const c2 = config.cuenta2_nombre || 'Cuenta 2';
    const pctCubierto = ingresoTotal > 0 ? Math.round((ingresoConCosto / ingresoTotal) * 100) : 0;

    const subCosto = itemsSinCosto > 0
      ? `<span style="color:#e65100;font-weight:700">${itemsSinCosto} items sin costo</span>`
      : `${margen}% margen`;
    const subIngreso = itemsSinCosto > 0
      ? `<span style="color:#e65100">${pctCubierto}% con costo</span>`
      : `${ventasPeriodo.length} ventas`;

    statsEl.innerHTML = `
      <div class="ct-ecuacion">
        <div class="ct-eq-bloque ct-clickable" data-detalle="vendido" title="Ver detalle de productos vendidos con costo">
          <span class="material-icons ct-eq-icon" style="color:#1877f2">point_of_sale</span>
          <div class="ct-eq-num">$${fmt(ingresoConCosto)}</div>
          <div class="ct-eq-lbl">Vendiste con costo</div>
          <div class="ct-eq-sub">${subIngreso}</div>
        </div>
        <div class="ct-eq-op">−</div>
        <div class="ct-eq-bloque ct-clickable" data-detalle="costo" title="Ver detalle de costos">
          <span class="material-icons ct-eq-icon" style="color:#e65100">inventory_2</span>
          <div class="ct-eq-num">$${fmt(cmv)}</div>
          <div class="ct-eq-lbl">Lo que te costó</div>
          <div class="ct-eq-sub">${subCosto}</div>
        </div>
        <div class="ct-eq-op">=</div>
        <div class="ct-eq-bloque ct-clickable" data-detalle="bruta" title="Ver detalle de ganancia por producto">
          <span class="material-icons ct-eq-icon" style="color:#00695c">show_chart</span>
          <div class="ct-eq-num" style="color:${gananciaBruta>=0?'#00695c':'#c62828'}">$${fmt(gananciaBruta)}</div>
          <div class="ct-eq-lbl">Ganancia bruta</div>
          <div class="ct-eq-sub">${margen}% margen</div>
        </div>
        <div class="ct-eq-op">−</div>
        <div class="ct-eq-bloque ct-clickable" data-detalle="gastos" title="Ver detalle de gastos">
          <span class="material-icons ct-eq-icon" style="color:#c62828">receipt_long</span>
          <div class="ct-eq-num">$${fmt(gastoTotal)}</div>
          <div class="ct-eq-lbl">Gastos / Pagos</div>
          <div class="ct-eq-sub">${gastos.length} registros</div>
        </div>
        <div class="ct-eq-op">=</div>
        <div class="ct-eq-bloque ct-eq-neta ct-clickable" data-detalle="neta" title="Ver resumen de cálculo" style="background:${bgNeta};border-color:${colorNeta}">
          <span class="material-icons ct-eq-icon" style="color:${colorNeta}">${iconNeta}</span>
          <div class="ct-eq-num" style="color:${colorNeta};font-size:26px;font-weight:900">$${fmt(gananciaNeta)}</div>
          <div class="ct-eq-lbl" style="color:${colorNeta};font-weight:700">Ganancia neta</div>
          <div class="ct-eq-sub">&nbsp;</div>
        </div>
      </div>

      <!-- Línea de totales reales (todo lo que entró) -->
      <div class="ct-totales-reales">
        <span class="material-icons" style="font-size:16px;color:#65676b">info</span>
        <span>Total ingresado en el período: <b>$${fmt(ingresoTotal)}</b> (${ventasPeriodo.length} ventas)</span>
        ${ingresoSinCosto > 0
          ? `<span class="ct-chip-warn">$${fmt(ingresoSinCosto)} sin costo</span>` : ''}
      </div>

      <!-- Desglose por cuenta -->
      <div class="ct-cuentas-row">
        <div class="ct-cuenta-item">
          <span class="material-icons" style="color:#2e7d32;font-size:18px">payments</span>
          <div class="ct-cuenta-body">
            <div class="ct-cuenta-nombre">Efectivo</div>
            <div class="ct-cuenta-vals">
              <span class="ct-cuenta-ingreso">+$${fmt(efectivoTotal)}</span>
              ${gastoEfectivo > 0 ? `<span class="ct-cuenta-gasto">−$${fmt(gastoEfectivo)}</span>` : ''}
              <span class="ct-cuenta-neto" style="color:${netoEfectivo>=0?'#2e7d32':'#c62828'}">= $${fmt(netoEfectivo)}</span>
            </div>
          </div>
        </div>
        <div class="ct-cuenta-item">
          <span class="material-icons" style="color:#1877f2;font-size:18px">account_balance</span>
          <div class="ct-cuenta-body">
            <div class="ct-cuenta-nombre">${c1}</div>
            <div class="ct-cuenta-vals">
              <span class="ct-cuenta-ingreso">+$${fmt(transCuenta1)}</span>
              ${gastoCuenta1 > 0 ? `<span class="ct-cuenta-gasto">−$${fmt(gastoCuenta1)}</span>` : ''}
              <span class="ct-cuenta-neto" style="color:${netoCuenta1>=0?'#2e7d32':'#c62828'}">= $${fmt(netoCuenta1)}</span>
            </div>
          </div>
        </div>
        <div class="ct-cuenta-item">
          <span class="material-icons" style="color:#6a1b9a;font-size:18px">account_balance</span>
          <div class="ct-cuenta-body">
            <div class="ct-cuenta-nombre">${c2}</div>
            <div class="ct-cuenta-vals">
              <span class="ct-cuenta-ingreso">+$${fmt(transCuenta2)}</span>
              ${gastoCuenta2 > 0 ? `<span class="ct-cuenta-gasto">−$${fmt(gastoCuenta2)}</span>` : ''}
              <span class="ct-cuenta-neto" style="color:${netoCuenta2>=0?'#2e7d32':'#c62828'}">= $${fmt(netoCuenta2)}</span>
            </div>
          </div>
        </div>
      </div>
    `;

    // Click en bloques de la ecuación → modal con detalle
    const detalleData = {
      mapaConCosto, gastos,
      ingresoConCosto, cmv, gananciaBruta, gastoTotal, gananciaNeta,
      gastoEfectivo, gastoCuenta1, gastoCuenta2,
      config, ventasCount: ventasPeriodo.length,
    };
    statsEl.querySelectorAll('.ct-clickable').forEach(el => {
      el.addEventListener('click', () => abrirDetalleControl(el.dataset.detalle, detalleData));
    });
  }

  // ── Banners de alerta: costos faltantes + pérdidas ──
  renderAlertas(container, db, mapaSinCosto, mapaPerdida, itemsSinCosto, montoPerdida, ingresoSinCosto, () => refreshDatos(container, db, periodo, config));

  // ── Lista Ganancia (día/mes) — usa TODAS las ventas del cache, no el período del toolbar ──
  // Filtramos solo eliminadas + Varios2; respeta fecha_inicio global.
  const ventasParaLista = ventas.filter(v => {
    if (v.deleted === true) return false;
    if (isVentaVarios2(v)) return false;
    const f = parseArDate(v.created_at);
    return f >= fechaInicio;
  });
  renderListaGanancia(container, ventasParaLista, itemsMap, catalogoPorNombre);

  // ── Lista de gastos ──
  const gastosEl = container.querySelector('#ct-gastos-lista');
  if (gastosEl) {
    if (gastos.length === 0) {
      gastosEl.innerHTML = `<div class="empty-state" style="padding:32px"><span class="material-icons">receipt_long</span><p>Sin gastos registrados en este período</p></div>`;
    } else {
      const c1 = config.cuenta1_nombre || 'Cuenta 1';
      const c2 = config.cuenta2_nombre || 'Cuenta 2';
      const tipoLabel = { efectivo: 'Efectivo', cuenta1: c1, cuenta2: c2 };
      gastosEl.innerHTML = `
        <table class="ct-gastos-table">
          <thead><tr>
            <th>Fecha</th><th>Descripción</th><th>Tipo</th><th style="text-align:right">Monto</th><th></th>
          </tr></thead>
          <tbody>
            ${gastos.map(g => `
              <tr>
                <td style="white-space:nowrap;color:var(--text-muted)">${g.fecha || ''}</td>
                <td>${g.descripcion || '-'}</td>
                <td><span class="badge ${g.tipo==='efectivo'?'badge-green':'badge-blue'}">${tipoLabel[g.tipo] || g.tipo}</span></td>
                <td style="text-align:right;font-weight:700;color:#c62828">-$${fmt(g.monto)}</td>
                <td><button class="ct-del-btn" data-id="${g._id}" title="Eliminar"><span class="material-icons" style="font-size:16px;pointer-events:none">delete_outline</span></button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      gastosEl.querySelectorAll('.ct-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('¿Eliminar este gasto?')) return;
          btn.disabled = true;
          await deleteDoc(doc(db, 'gastos', btn.dataset.id));
          invalidateCacheByPrefix('ct:gastos');
          await refreshDatos(container, db, periodo, config);
        });
      });
    }
  }
}

// ── Banner de costos faltantes + pérdidas ─────────────────────────────────────
function renderAlertas(container, db, mapaSinCosto, mapaPerdida, itemsSinCosto, montoPerdida, ingresoSinCosto, onRefresh) {
  const el = container.querySelector('#ct-alertas');
  if (!el) return;

  const sinCostoList = Object.entries(mapaSinCosto)
    .sort((a, b) => b[1].ingreso - a[1].ingreso);
  const perdidaList = Object.entries(mapaPerdida)
    .sort((a, b) => b[1].perdida - a[1].perdida);

  let html = '';

  if (sinCostoList.length > 0) {
    html += `
      <div class="ct-alert ct-alert-warn">
        <div class="ct-alert-header">
          <span class="material-icons" style="color:#e65100">sell</span>
          <div>
            <div class="ct-alert-title">${sinCostoList.length} productos sin costo cargado</div>
            <div class="ct-alert-sub">Cubren <b>$${fmt(ingresoSinCosto)}</b> en ventas del período. La ganancia bruta no los incluye hasta que cargues el costo.</div>
          </div>
          <button class="ct-alert-btn" id="ct-open-costos">
            <span class="material-icons" style="font-size:16px">edit</span> Cargar costos
          </button>
        </div>
      </div>
    `;
  }

  if (perdidaList.length > 0) {
    html += `
      <div class="ct-alert ct-alert-loss">
        <div class="ct-alert-header">
          <span class="material-icons" style="color:#c62828">trending_down</span>
          <div>
            <div class="ct-alert-title">Vendiste ${perdidaList.length} productos por debajo del costo</div>
            <div class="ct-alert-sub">Pérdida acumulada: <b style="color:#c62828">$${fmt(montoPerdida)}</b></div>
          </div>
          <button class="ct-alert-btn" id="ct-open-perdidas" style="background:#ffebee;color:#c62828;border-color:#ef9a9a">
            <span class="material-icons" style="font-size:16px">visibility</span> Ver detalle
          </button>
        </div>
      </div>
    `;
  }

  el.innerHTML = html;

  const btnCostos = el.querySelector('#ct-open-costos');
  if (btnCostos) btnCostos.addEventListener('click', () => abrirPanelCostos(db, sinCostoList, onRefresh));

  const btnPerdidas = el.querySelector('#ct-open-perdidas');
  if (btnPerdidas) btnPerdidas.addEventListener('click', () => abrirPanelPerdidas(db, perdidaList, onRefresh));
}

// ── Modal: detalle de los bloques de la ecuación ──────────────────────────────
function abrirDetalleControl(tipo, data) {
  const {
    mapaConCosto, gastos,
    ingresoConCosto, cmv, gananciaBruta, gastoTotal, gananciaNeta,
    gastoEfectivo, gastoCuenta1, gastoCuenta2,
    config, ventasCount,
  } = data;

  const c1 = config.cuenta1_nombre || 'Cuenta 1';
  const c2 = config.cuenta2_nombre || 'Cuenta 2';
  const tipoLabel = { efectivo: 'Efectivo', cuenta1: c1, cuenta2: c2 };

  let titulo = '', icono = '', color = '', desc = '', body = '';
  const productos = Object.entries(mapaConCosto);

  if (tipo === 'vendido') {
    titulo = 'Vendiste con costo';
    icono  = 'point_of_sale';
    color  = '#1877f2';
    desc   = `Productos con costo conocido, ordenados por ingreso. Total: <b>$${fmt(ingresoConCosto)}</b> en ${ventasCount} ventas.`;
    const lista = productos.sort((a, b) => b[1].ingreso - a[1].ingreso);
    body = lista.length === 0
      ? `<div class="empty-state" style="padding:32px"><span class="material-icons">info</span><p>Sin productos con costo cargado en el período</p></div>`
      : `
        <table class="ct-costos-table">
          <thead><tr>
            <th>Producto</th>
            <th style="text-align:right">Vendidos</th>
            <th style="text-align:right">Precio unit.</th>
            <th style="text-align:right">Ingreso</th>
            <th style="text-align:right">% del total</th>
          </tr></thead>
          <tbody>
            ${lista.map(([nombre, d]) => `
              <tr>
                <td><b style="font-size:13px">${nombre}</b></td>
                <td style="text-align:right">${d.cantidad}</td>
                <td style="text-align:right">$${fmt(d.precioUnit)}</td>
                <td style="text-align:right;font-weight:700">$${fmt(d.ingreso)}</td>
                <td style="text-align:right;color:#65676b">${ingresoConCosto > 0 ? Math.round((d.ingreso / ingresoConCosto) * 100) : 0}%</td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
  }
  else if (tipo === 'costo') {
    titulo = 'Lo que te costó (CMV)';
    icono  = 'inventory_2';
    color  = '#e65100';
    desc   = `Costo de mercadería vendida por producto. Total: <b>$${fmt(cmv)}</b>.`;
    const lista = productos.sort((a, b) => b[1].cmv - a[1].cmv);
    body = lista.length === 0
      ? `<div class="empty-state" style="padding:32px"><span class="material-icons">info</span><p>Sin costos registrados en el período</p></div>`
      : `
        <table class="ct-costos-table">
          <thead><tr>
            <th>Producto</th>
            <th style="text-align:right">Vendidos</th>
            <th style="text-align:right">Costo unit.</th>
            <th style="text-align:right">Costo total</th>
            <th style="text-align:right">% del total</th>
          </tr></thead>
          <tbody>
            ${lista.map(([nombre, d]) => `
              <tr>
                <td><b style="font-size:13px">${nombre}</b></td>
                <td style="text-align:right">${d.cantidad}</td>
                <td style="text-align:right">$${fmt(d.costoUnit)}</td>
                <td style="text-align:right;font-weight:700;color:#e65100">$${fmt(d.cmv)}</td>
                <td style="text-align:right;color:#65676b">${cmv > 0 ? Math.round((d.cmv / cmv) * 100) : 0}%</td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
  }
  else if (tipo === 'bruta') {
    titulo = 'Ganancia bruta por producto';
    icono  = 'show_chart';
    color  = '#00695c';
    const margenTot = ingresoConCosto > 0 ? Math.round((gananciaBruta / ingresoConCosto) * 100) : 0;
    desc   = `Ingreso − costo por producto. Total: <b style="color:${gananciaBruta>=0?'#00695c':'#c62828'}">$${fmt(gananciaBruta)}</b> (${margenTot}% margen).`;
    const lista = productos
      .map(([nombre, d]) => [nombre, { ...d, ganancia: d.ingreso - d.cmv, margen: d.ingreso > 0 ? (d.ingreso - d.cmv) / d.ingreso * 100 : 0 }])
      .sort((a, b) => b[1].ganancia - a[1].ganancia);
    body = lista.length === 0
      ? `<div class="empty-state" style="padding:32px"><span class="material-icons">info</span><p>Sin datos suficientes para calcular ganancia</p></div>`
      : `
        <table class="ct-costos-table">
          <thead><tr>
            <th>Producto</th>
            <th style="text-align:right">Ingreso</th>
            <th style="text-align:right">Costo</th>
            <th style="text-align:right">Ganancia</th>
            <th style="text-align:right">Margen</th>
          </tr></thead>
          <tbody>
            ${lista.map(([nombre, d]) => `
              <tr>
                <td><b style="font-size:13px">${nombre}</b></td>
                <td style="text-align:right">$${fmt(d.ingreso)}</td>
                <td style="text-align:right;color:#e65100">$${fmt(d.cmv)}</td>
                <td style="text-align:right;font-weight:700;color:${d.ganancia>=0?'#00695c':'#c62828'}">$${fmt(d.ganancia)}</td>
                <td style="text-align:right;color:${d.margen>=0?'#00695c':'#c62828'}">${Math.round(d.margen)}%</td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
  }
  else if (tipo === 'gastos') {
    titulo = 'Gastos / Pagos del período';
    icono  = 'receipt_long';
    color  = '#c62828';
    desc   = `Total descontado: <b style="color:#c62828">$${fmt(gastoTotal)}</b> en ${gastos.length} registros.`;
    body = gastos.length === 0
      ? `<div class="empty-state" style="padding:32px"><span class="material-icons">receipt_long</span><p>Sin gastos registrados en el período</p></div>`
      : `
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
          <div class="ct-mini-stat"><span style="color:#65676b;font-size:12px">Efectivo</span><b style="color:#c62828">$${fmt(gastoEfectivo)}</b></div>
          <div class="ct-mini-stat"><span style="color:#65676b;font-size:12px">${c1}</span><b style="color:#c62828">$${fmt(gastoCuenta1)}</b></div>
          <div class="ct-mini-stat"><span style="color:#65676b;font-size:12px">${c2}</span><b style="color:#c62828">$${fmt(gastoCuenta2)}</b></div>
        </div>
        <table class="ct-costos-table">
          <thead><tr>
            <th>Fecha</th>
            <th>Descripción</th>
            <th>Tipo</th>
            <th style="text-align:right">Monto</th>
          </tr></thead>
          <tbody>
            ${gastos.map(g => `
              <tr>
                <td style="white-space:nowrap;color:#65676b">${g.fecha || ''}</td>
                <td><b style="font-size:13px">${g.descripcion || '-'}</b></td>
                <td><span class="badge ${g.tipo==='efectivo'?'badge-green':'badge-blue'}">${tipoLabel[g.tipo] || g.tipo}</span></td>
                <td style="text-align:right;font-weight:700;color:#c62828">-$${fmt(g.monto)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
  }
  else if (tipo === 'neta') {
    titulo = 'Cómo se calcula la ganancia neta';
    icono  = gananciaNeta >= 0 ? 'trending_up' : 'trending_down';
    color  = gananciaNeta >= 0 ? '#1b5e20' : '#b71c1c';
    desc   = `El resultado final del período, después de descontar costos y gastos.`;
    const margenTot = ingresoConCosto > 0 ? Math.round((gananciaBruta / ingresoConCosto) * 100) : 0;
    body = `
      <div class="ct-neta-breakdown">
        <div class="ct-neta-row">
          <div class="ct-neta-lbl"><span class="material-icons" style="color:#1877f2">point_of_sale</span> Vendiste con costo</div>
          <div class="ct-neta-val">+ $${fmt(ingresoConCosto)}</div>
        </div>
        <div class="ct-neta-row ct-neta-sub">
          <div class="ct-neta-lbl"><span class="material-icons" style="color:#e65100">inventory_2</span> Lo que te costó</div>
          <div class="ct-neta-val" style="color:#e65100">− $${fmt(cmv)}</div>
        </div>
        <div class="ct-neta-sep"></div>
        <div class="ct-neta-row ct-neta-result">
          <div class="ct-neta-lbl"><span class="material-icons" style="color:#00695c">show_chart</span> Ganancia bruta <span style="color:#65676b;font-weight:400;font-size:12px">(${margenTot}% margen)</span></div>
          <div class="ct-neta-val" style="color:${gananciaBruta>=0?'#00695c':'#c62828'}">= $${fmt(gananciaBruta)}</div>
        </div>
        <div class="ct-neta-row ct-neta-sub">
          <div class="ct-neta-lbl"><span class="material-icons" style="color:#c62828">receipt_long</span> Gastos / Pagos</div>
          <div class="ct-neta-val" style="color:#c62828">− $${fmt(gastoTotal)}</div>
        </div>
        <div class="ct-neta-sep"></div>
        <div class="ct-neta-row ct-neta-final" style="background:${gananciaNeta>=0?'#f1f8f1':'#fff5f5'}">
          <div class="ct-neta-lbl"><span class="material-icons" style="color:${color}">${icono}</span> <b>Ganancia neta</b></div>
          <div class="ct-neta-val" style="color:${color};font-size:22px;font-weight:900">$${fmt(gananciaNeta)}</div>
        </div>
      </div>
      <div style="margin-top:16px;padding:12px;background:#f7f8fa;border-radius:8px;font-size:12px;color:#65676b;line-height:1.6">
        <b>Nota:</b> la ganancia bruta solo considera productos con costo cargado. Ventas sin costo conocido no se descuentan acá — aparecen en el banner de alerta de arriba.
      </div>`;
  }
  else {
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'ct-modal-overlay';
  overlay.innerHTML = `
    <div class="ct-modal" role="dialog">
      <div class="ct-modal-header">
        <span class="material-icons" style="color:${color}">${icono}</span>
        <h3>${titulo}</h3>
        <button class="ct-modal-close" title="Cerrar"><span class="material-icons">close</span></button>
      </div>
      <div class="ct-modal-desc">${desc}</div>
      <div class="ct-modal-body">${body}</div>
      <div class="ct-modal-footer">
        <button class="ct-btn-primary" id="ct-close-detalle">Cerrar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  overlay.querySelector('.ct-modal-close').addEventListener('click', closeModal);
  overlay.querySelector('#ct-close-detalle').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
}

// ── Panel modal: cargar costos faltantes ──────────────────────────────────────
function abrirPanelCostos(db, list, onRefresh) {
  const overlay = document.createElement('div');
  overlay.className = 'ct-modal-overlay';
  overlay.innerHTML = `
    <div class="ct-modal" role="dialog">
      <div class="ct-modal-header">
        <span class="material-icons" style="color:#e65100">sell</span>
        <h3>Cargar costos faltantes</h3>
        <button class="ct-modal-close" title="Cerrar"><span class="material-icons">close</span></button>
      </div>
      <div class="ct-modal-desc">
        Ordenados por ingreso del período. Cargá el costo y se actualiza el catálogo al instante.
      </div>
      <div class="ct-modal-body">
        <table class="ct-costos-table">
          <thead>
            <tr>
              <th>Producto</th>
              <th style="text-align:right">Vendidos</th>
              <th style="text-align:right">Precio</th>
              <th style="text-align:right">Ingreso</th>
              <th style="text-align:right">Costo unit.</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${list.map(([nombre, d]) => `
              <tr data-nombre="${encodeURIComponent(nombre)}" data-docid="${d.doc_id || ''}">
                <td>
                  <b style="font-size:13px">${nombre}</b>
                  ${!d.en_catalogo ? '<div style="color:#c62828;font-size:11px">no está en el catálogo</div>' : ''}
                </td>
                <td style="text-align:right">${d.cantidad}</td>
                <td style="text-align:right">$${fmt(d.precio_venta)}</td>
                <td style="text-align:right;font-weight:700">$${fmt(d.ingreso)}</td>
                <td style="text-align:right">
                  <input type="number" step="0.01" min="0" class="ct-costo-input" placeholder="$"
                    style="width:90px;padding:6px 8px;border:1.5px solid #e4e6eb;border-radius:6px;text-align:right;font-size:13px" />
                </td>
                <td>
                  <button class="ct-save-costo" ${!d.doc_id ? 'disabled title="No está en el catálogo"' : ''}>
                    <span class="material-icons" style="font-size:16px">save</span>
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="ct-modal-footer">
        <span style="color:#65676b;font-size:12px">Tip: Enter en el input guarda el costo.</span>
        <button class="ct-btn-primary" id="ct-refresh-modal">
          <span class="material-icons" style="font-size:16px">refresh</span> Actualizar Control Total
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  overlay.querySelector('.ct-modal-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  overlay.querySelectorAll('tr[data-nombre]').forEach(tr => {
    const input = tr.querySelector('.ct-costo-input');
    const btn   = tr.querySelector('.ct-save-costo');
    const docId = tr.dataset.docid;

    const save = async () => {
      if (!docId) return;
      const val = parseFloat(input.value);
      if (isNaN(val) || val < 0) { input.focus(); return; }
      btn.disabled = true;
      btn.innerHTML = '<span class="material-icons" style="font-size:16px">hourglass_empty</span>';
      try {
        await updateDoc(doc(db, 'catalogo', docId), {
          costo: val,
          estado: val === 0 ? 'sin_precio' : 'activo',
          ultima_actualizacion: serverTimestamp(),
        });
        invalidateCacheByPrefix('catalogo');
        tr.style.background = '#e8f5e9';
        tr.style.transition = 'background 0.3s';
        btn.innerHTML = '<span class="material-icons" style="font-size:16px;color:#2e7d32">check_circle</span>';
      } catch (e) {
        alert('Error al guardar: ' + e.message);
        btn.disabled = false;
        btn.innerHTML = '<span class="material-icons" style="font-size:16px">save</span>';
      }
    };

    if (btn && !btn.disabled) btn.addEventListener('click', save);
    input?.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  });

  overlay.querySelector('#ct-refresh-modal').addEventListener('click', async () => {
    closeModal();
    await onRefresh();
  });
}

// ── Panel modal: detalle de pérdidas ──────────────────────────────────────────
function abrirPanelPerdidas(db, list, onRefresh) {
  const overlay = document.createElement('div');
  overlay.className = 'ct-modal-overlay';
  overlay.innerHTML = `
    <div class="ct-modal" role="dialog">
      <div class="ct-modal-header">
        <span class="material-icons" style="color:#c62828">trending_down</span>
        <h3>Ventas por debajo del costo</h3>
        <button class="ct-modal-close" title="Cerrar"><span class="material-icons">close</span></button>
      </div>
      <div class="ct-modal-desc">
        El precio de venta quedó menor al costo. Revisá estos productos en el catálogo.
      </div>
      <div class="ct-modal-body">
        <table class="ct-costos-table">
          <thead>
            <tr>
              <th>Producto</th>
              <th style="text-align:right">Vendidos</th>
              <th style="text-align:right">Costo</th>
              <th style="text-align:right">Precio</th>
              <th style="text-align:right">Pérdida</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(([nombre, d]) => `
              <tr>
                <td><b style="font-size:13px">${nombre}</b></td>
                <td style="text-align:right">${d.cantidad}</td>
                <td style="text-align:right">$${fmt(d.costo)}</td>
                <td style="text-align:right">$${fmt(d.precio)}</td>
                <td style="text-align:right;font-weight:700;color:#c62828">-$${fmt(d.perdida)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="ct-modal-footer">
        <span style="color:#65676b;font-size:12px">Usá el Catálogo para ajustar precios de venta o costos.</span>
        <button class="ct-btn-primary" id="ct-close-perdidas">Cerrar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  overlay.querySelector('.ct-modal-close').addEventListener('click', closeModal);
  overlay.querySelector('#ct-close-perdidas').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
}

// ── Gastos ────────────────────────────────────────────────────────────────────
async function loadGastos(db, desde) {
  const snap = await getDocs(query(collection(db, 'gastos'), orderBy('created_at', 'desc')));
  const desdeStr = desde.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  return snap.docs
    .map(d => ({ _id: d.id, ...d.data() }))
    .filter(g => (g.fecha || '') >= desdeStr);
}

function setupGastoForm(container, db, periodo, config) {
  const form = container.querySelector('#ct-gasto-form');
  if (!form) return;

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const desc  = form.querySelector('#gasto-desc').value.trim();
    const monto = parseFloat(form.querySelector('#gasto-monto').value) || 0;
    const tipo  = form.querySelector('#gasto-tipo').value;

    if (!desc || monto <= 0) return;

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Guardando...';

    try {
      await addDoc(collection(db, 'gastos'), {
        descripcion: desc,
        monto,
        tipo,
        fecha: todayAR(),
        created_at: serverTimestamp(),
      });
      form.reset();
      invalidateCacheByPrefix('ct:gastos');
      await refreshDatos(container, db, periodo, config);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-icons" style="font-size:16px">remove_circle_outline</span> Descontar';
    }
  });
}

function setupConfigCuentas(container, db, config) {
  const btnConfig  = container.querySelector('#ct-config-btn');
  const formConfig = container.querySelector('#ct-config-form');
  if (!btnConfig || !formConfig) return;

  btnConfig.addEventListener('click', () => {
    formConfig.style.display = formConfig.style.display === 'none' ? 'flex' : 'none';
  });

  formConfig.addEventListener('submit', async e => {
    e.preventDefault();
    const c1 = formConfig.querySelector('#cfg-cuenta1').value.trim() || 'Cuenta 1';
    const c2 = formConfig.querySelector('#cfg-cuenta2').value.trim() || 'Cuenta 2';
    const fi = formConfig.querySelector('#cfg-fecha-inicio').value || '2026-04-18';
    const btn = formConfig.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Guardando...';

    try {
      const newConfig = { ...config, cuenta1_nombre: c1, cuenta2_nombre: c2, fecha_inicio: fi };
      await saveControlConfig(db, newConfig);
      Object.assign(config, newConfig);
      formConfig.style.display = 'none';
      location.reload();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Guardar';
    }
  });
}

// ── Lista Ganancia: agrega por día y por mes ──────────────────────────────────
// Calcula ingreso, CMV y ganancia bruta por fecha. Click en una fila abre un
// modal con el "detalle" (mejor producto, mejor categoría, hora pico, etc).
// Los items VARIOS no tienen costo cargado → no contribuyen al CMV ni a la
// ganancia bruta (se cuentan en ingreso total pero quedan marcados como s/c).
function renderListaGanancia(container, ventas, itemsMap, catalogoPorNombre) {
  const el = container.querySelector('#ct-ganancia-lista');
  if (!el) return;

  // ── Agregación por día (YYYY-MM-DD en zona AR) ──
  const porDia = {};   // { '2026-04-23': {fecha, ingreso, cmv, ventas:[], items:[]} }
  for (const v of ventas) {
    const f = parseArDate(v.created_at);
    if (isNaN(f)) continue;
    const key = f.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    if (!porDia[key]) porDia[key] = { fecha: key, ingreso: 0, cmv: 0, ingresoConCosto: 0, ventas: [], items: [] };
    const d = porDia[key];
    d.ingreso += (v.total_amount || 0);
    d.ventas.push(v);

    const saleId = v.sale_id || v.id;
    const itemKey = v.pc_id ? `${v.pc_id}_${saleId}` : String(saleId);
    const items = itemsMap[itemKey] || [];
    for (const it of items) {
      const cat = catalogoPorNombre[it.nombre];
      const costoUnit = cat?.costo || 0;
      const ingresoItem = it.subtotal || (it.precio_unitario * it.cantidad) || 0;
      if (costoUnit > 0) {
        d.cmv += costoUnit * it.cantidad;
        d.ingresoConCosto += ingresoItem;
      }
      d.items.push({ ...it, costoUnit, categoria: cat?.categoria || null, hora: f.getHours() });
    }
  }
  const dias = Object.values(porDia).sort((a, b) => b.fecha.localeCompare(a.fecha));

  // ── Agregación por mes (YYYY-MM) ──
  const porMes = {};
  for (const d of dias) {
    const k = d.fecha.slice(0, 7);
    if (!porMes[k]) porMes[k] = { mes: k, ingreso: 0, cmv: 0, ingresoConCosto: 0, ventas: [], items: [], dias: [] };
    porMes[k].ingreso         += d.ingreso;
    porMes[k].cmv             += d.cmv;
    porMes[k].ingresoConCosto += d.ingresoConCosto;
    porMes[k].ventas.push(...d.ventas);
    porMes[k].items.push(...d.items);
    porMes[k].dias.push(d);
  }
  const meses = Object.values(porMes).sort((a, b) => b.mes.localeCompare(a.mes));

  // Estado de la vista (día/mes) — persistido en localStorage
  let vista = localStorage.getItem('ct:lg_vista') || 'dia';
  const renderTabla = () => {
    const data = vista === 'mes' ? meses : dias;
    if (!data.length) {
      el.innerHTML = `<div class="empty-state" style="padding:32px"><span class="material-icons">insights</span><p>Sin ventas en el rango configurado.</p></div>`;
      return;
    }

    el.innerHTML = `
      <div style="overflow-x:auto">
        <table class="ct-costos-table" style="margin-top:6px">
          <thead><tr>
            <th>${vista === 'mes' ? 'Mes' : 'Día'}</th>
            <th style="text-align:right">Ingreso</th>
            <th style="text-align:right">CMV</th>
            <th style="text-align:right">Ganancia bruta</th>
            <th style="text-align:right">Margen</th>
            <th style="text-align:right">Ventas</th>
            <th style="text-align:center">Detalle</th>
          </tr></thead>
          <tbody>
            ${data.map((row, i) => {
              const ganancia = row.ingresoConCosto - row.cmv;
              const margen = row.ingresoConCosto > 0 ? Math.round((ganancia / row.ingresoConCosto) * 100) : 0;
              const labelFecha = vista === 'mes' ? formatMes(row.mes) : formatDia(row.fecha);
              return `
                <tr class="ct-lg-row" data-idx="${i}" style="cursor:pointer">
                  <td><b style="font-size:13px">${labelFecha}</b></td>
                  <td style="text-align:right;font-weight:600">$${fmt(row.ingreso)}</td>
                  <td style="text-align:right;color:#e65100">$${fmt(row.cmv)}</td>
                  <td style="text-align:right;font-weight:700;color:${ganancia>=0?'#00695c':'#c62828'}">$${fmt(ganancia)}</td>
                  <td style="text-align:right;color:${margen>=0?'#00695c':'#c62828'}">${margen}%</td>
                  <td style="text-align:right;color:#65676b">${row.ventas.length}</td>
                  <td style="text-align:center"><span class="material-icons" style="font-size:18px;color:#65676b">chevron_right</span></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    el.querySelectorAll('.ct-lg-row').forEach(tr => {
      tr.addEventListener('click', () => {
        const idx = parseInt(tr.dataset.idx);
        abrirDetalleGanancia(data[idx], vista);
      });
      tr.addEventListener('mouseenter', () => tr.style.background = '#f7f8fa');
      tr.addEventListener('mouseleave', () => tr.style.background = '');
    });
  };

  // Tabs
  container.querySelectorAll('.ct-lg-tab').forEach(btn => {
    btn.onclick = () => {
      vista = btn.dataset.vista;
      localStorage.setItem('ct:lg_vista', vista);
      container.querySelectorAll('.ct-lg-tab').forEach(b => {
        const active = b.dataset.vista === vista;
        b.classList.toggle('active', active);
        b.style.background = active ? '#fff' : 'transparent';
        b.style.color      = active ? '#1c1e21' : '#65676b';
        b.style.fontWeight = active ? '700' : '600';
        b.style.boxShadow  = active ? '0 1px 2px rgba(0,0,0,0.05)' : 'none';
      });
      renderTabla();
    };
  });

  renderTabla();
}

function formatDia(yyyymmdd) {
  // 2026-04-23 → "Jue 23/04/2026"
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dia = dt.toLocaleDateString('es-AR', { weekday: 'short', timeZone: 'UTC' });
  return `${dia.charAt(0).toUpperCase() + dia.slice(1, 3)} ${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`;
}

function formatMes(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  return `${meses[m-1]} ${y}`;
}

// ── Modal: detalle de un día/mes (lo mejor del período) ───────────────────────
function abrirDetalleGanancia(row, vista) {
  const titulo  = vista === 'mes' ? formatMes(row.mes) : formatDia(row.fecha);
  const ganancia = row.ingresoConCosto - row.cmv;
  const margen   = row.ingresoConCosto > 0 ? (ganancia / row.ingresoConCosto) * 100 : 0;

  // Agregación de items: por nombre, cantidad y ingreso total
  const porProducto = {};
  const porCategoria = {};
  let itemsConCosto = 0, itemsSinCosto = 0;
  for (const it of row.items) {
    const nombre = it.nombre || '(sin nombre)';
    if (!porProducto[nombre]) {
      porProducto[nombre] = { nombre, cantidad: 0, ingreso: 0, cmv: 0, costoUnit: it.costoUnit, categoria: it.categoria };
    }
    porProducto[nombre].cantidad += it.cantidad;
    porProducto[nombre].ingreso  += (it.subtotal || it.precio_unitario * it.cantidad || 0);
    if (it.costoUnit > 0) {
      porProducto[nombre].cmv += it.costoUnit * it.cantidad;
      itemsConCosto++;
    } else {
      itemsSinCosto++;
    }
    const cat = it.categoria || 'Sin categoría';
    if (!porCategoria[cat]) porCategoria[cat] = { nombre: cat, ingreso: 0, cantidad: 0 };
    porCategoria[cat].ingreso  += (it.subtotal || it.precio_unitario * it.cantidad || 0);
    porCategoria[cat].cantidad += it.cantidad;
  }
  const productos = Object.values(porProducto).map(p => ({
    ...p, ganancia: p.cmv > 0 ? p.ingreso - p.cmv : null,
  }));
  const top5Ingreso  = [...productos].sort((a, b) => b.ingreso - a.ingreso).slice(0, 5);
  const top5Cantidad = [...productos].sort((a, b) => b.cantidad - a.cantidad).slice(0, 5);
  const top5Ganancia = productos.filter(p => p.ganancia != null).sort((a, b) => b.ganancia - a.ganancia).slice(0, 5);
  const topCategorias = Object.values(porCategoria).sort((a, b) => b.ingreso - a.ingreso).slice(0, 3);

  // Hora pico (solo en vista por día) — agrupar ventas por hora
  let horaPico = null;
  if (vista !== 'mes') {
    const porHora = {};
    for (const v of row.ventas) {
      const f = parseArDate(v.created_at);
      if (isNaN(f)) continue;
      const h = f.getHours();
      if (!porHora[h]) porHora[h] = { hora: h, ventas: 0, ingreso: 0 };
      porHora[h].ventas++;
      porHora[h].ingreso += (v.total_amount || 0);
    }
    horaPico = Object.values(porHora).sort((a, b) => b.ingreso - a.ingreso)[0];
  }

  // Mejor venta individual
  const mejorVenta = [...row.ventas].sort((a, b) => (b.total_amount || 0) - (a.total_amount || 0))[0];
  const ticketProm = row.ventas.length > 0 ? row.ingreso / row.ventas.length : 0;
  const ventasEfectivo  = row.ventas.filter(v => v.payment_type === 'cash').length;
  const ventasTransfer  = row.ventas.length - ventasEfectivo;

  // Mejor día (solo en vista por mes)
  let mejorDia = null;
  if (vista === 'mes' && row.dias) {
    mejorDia = [...row.dias].map(d => ({
      ...d,
      ganancia: d.ingresoConCosto - d.cmv,
    })).sort((a, b) => b.ganancia - a.ganancia)[0];
  }

  const overlay = document.createElement('div');
  overlay.className = 'ct-modal-overlay';
  overlay.innerHTML = `
    <div class="ct-modal" role="dialog" style="max-width:780px">
      <div class="ct-modal-header">
        <span class="material-icons" style="color:#00695c">insights</span>
        <h3>${vista === 'mes' ? 'Mes:' : ''} ${titulo}</h3>
        <button class="ct-modal-close" title="Cerrar"><span class="material-icons">close</span></button>
      </div>

      <div class="ct-modal-desc">
        <b style="color:${ganancia>=0?'#00695c':'#c62828'}">$${fmt(ganancia)}</b> de ganancia bruta
        (${Math.round(margen)}% margen) sobre <b>$${fmt(row.ingreso)}</b> en ventas.
      </div>

      <div class="ct-modal-body">

        <!-- KPIs principales -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px">
          <div class="ct-mini-stat"><span style="color:#65676b;font-size:12px">Ingreso total</span><b style="color:#1877f2">$${fmt(row.ingreso)}</b></div>
          <div class="ct-mini-stat"><span style="color:#65676b;font-size:12px">CMV</span><b style="color:#e65100">$${fmt(row.cmv)}</b></div>
          <div class="ct-mini-stat"><span style="color:#65676b;font-size:12px">Ganancia bruta</span><b style="color:${ganancia>=0?'#00695c':'#c62828'}">$${fmt(ganancia)}</b></div>
          <div class="ct-mini-stat"><span style="color:#65676b;font-size:12px">Margen</span><b style="color:${margen>=0?'#00695c':'#c62828'}">${Math.round(margen)}%</b></div>
          <div class="ct-mini-stat"><span style="color:#65676b;font-size:12px">Ventas</span><b>${row.ventas.length}</b></div>
          <div class="ct-mini-stat"><span style="color:#65676b;font-size:12px">Ticket prom.</span><b>$${fmt(ticketProm)}</b></div>
        </div>

        <!-- Highlights -->
        <div style="background:#f7f8fa;border-radius:10px;padding:14px;margin-bottom:16px">
          <div style="font-size:12px;font-weight:700;color:#1c1e21;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">Lo mejor del ${vista === 'mes' ? 'mes' : 'día'}</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
            ${top5Ingreso[0] ? `
            <div style="background:#fff;border-radius:8px;padding:10px 12px;border-left:3px solid #fbbf24">
              <div style="font-size:10px;color:#65676b;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Top en ingreso</div>
              <div style="font-size:13px;font-weight:700;color:#1c1e21;margin-top:2px">${escapeHtmlCt(top5Ingreso[0].nombre)}</div>
              <div style="font-size:11px;color:#475569;margin-top:2px">$${fmt(top5Ingreso[0].ingreso)} · ${top5Ingreso[0].cantidad} u.</div>
            </div>` : ''}
            ${top5Cantidad[0] ? `
            <div style="background:#fff;border-radius:8px;padding:10px 12px;border-left:3px solid #94a3b8">
              <div style="font-size:10px;color:#65676b;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Más vendido (unidades)</div>
              <div style="font-size:13px;font-weight:700;color:#1c1e21;margin-top:2px">${escapeHtmlCt(top5Cantidad[0].nombre)}</div>
              <div style="font-size:11px;color:#475569;margin-top:2px">${top5Cantidad[0].cantidad} u. · $${fmt(top5Cantidad[0].ingreso)}</div>
            </div>` : ''}
            ${top5Ganancia[0] ? `
            <div style="background:#fff;border-radius:8px;padding:10px 12px;border-left:3px solid #00695c">
              <div style="font-size:10px;color:#65676b;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Mayor ganancia</div>
              <div style="font-size:13px;font-weight:700;color:#1c1e21;margin-top:2px">${escapeHtmlCt(top5Ganancia[0].nombre)}</div>
              <div style="font-size:11px;color:#475569;margin-top:2px">$${fmt(top5Ganancia[0].ganancia)} de ganancia</div>
            </div>` : ''}
            ${topCategorias[0] ? `
            <div style="background:#fff;border-radius:8px;padding:10px 12px;border-left:3px solid #6a1b9a">
              <div style="font-size:10px;color:#65676b;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Mejor categoría</div>
              <div style="font-size:13px;font-weight:700;color:#1c1e21;margin-top:2px">${escapeHtmlCt(topCategorias[0].nombre)}</div>
              <div style="font-size:11px;color:#475569;margin-top:2px">$${fmt(topCategorias[0].ingreso)} · ${topCategorias[0].cantidad} u.</div>
            </div>` : ''}
            ${horaPico ? `
            <div style="background:#fff;border-radius:8px;padding:10px 12px;border-left:3px solid #1877f2">
              <div style="font-size:10px;color:#65676b;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Hora pico</div>
              <div style="font-size:13px;font-weight:700;color:#1c1e21;margin-top:2px">${String(horaPico.hora).padStart(2,'0')}:00 — ${String(horaPico.hora+1).padStart(2,'0')}:00</div>
              <div style="font-size:11px;color:#475569;margin-top:2px">${horaPico.ventas} ventas · $${fmt(horaPico.ingreso)}</div>
            </div>` : ''}
            ${mejorVenta ? `
            <div style="background:#fff;border-radius:8px;padding:10px 12px;border-left:3px solid #c62828">
              <div style="font-size:10px;color:#65676b;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Mejor venta</div>
              <div style="font-size:13px;font-weight:700;color:#1c1e21;margin-top:2px">$${fmt(mejorVenta.total_amount)}</div>
              <div style="font-size:11px;color:#475569;margin-top:2px">${mejorVenta.payment_type === 'cash' ? 'Efectivo' : 'Transferencia'}${mejorVenta.username ? ' · ' + escapeHtmlCt(mejorVenta.username) : ''}</div>
            </div>` : ''}
            ${mejorDia ? `
            <div style="background:#fff;border-radius:8px;padding:10px 12px;border-left:3px solid #fbbf24">
              <div style="font-size:10px;color:#65676b;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Mejor día del mes</div>
              <div style="font-size:13px;font-weight:700;color:#1c1e21;margin-top:2px">${formatDia(mejorDia.fecha)}</div>
              <div style="font-size:11px;color:#475569;margin-top:2px">$${fmt(mejorDia.ganancia)} de ganancia</div>
            </div>` : ''}
            <div style="background:#fff;border-radius:8px;padding:10px 12px;border-left:3px solid #94a3b8">
              <div style="font-size:10px;color:#65676b;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Mix de pago</div>
              <div style="font-size:13px;font-weight:700;color:#1c1e21;margin-top:2px">${ventasEfectivo} ef · ${ventasTransfer} tr</div>
              <div style="font-size:11px;color:#475569;margin-top:2px">${row.ventas.length > 0 ? Math.round(ventasEfectivo / row.ventas.length * 100) : 0}% efectivo</div>
            </div>
          </div>
        </div>

        <!-- Top 5 productos por ingreso -->
        ${top5Ingreso.length > 0 ? `
        <div style="margin-bottom:16px">
          <div style="font-size:12px;font-weight:700;color:#1c1e21;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Top 5 productos por ingreso</div>
          <table class="ct-costos-table">
            <thead><tr>
              <th>Producto</th>
              <th style="text-align:right">Cant.</th>
              <th style="text-align:right">Ingreso</th>
              <th style="text-align:right">Costo</th>
              <th style="text-align:right">Ganancia</th>
            </tr></thead>
            <tbody>
              ${top5Ingreso.map(p => `
                <tr>
                  <td><b style="font-size:13px">${escapeHtmlCt(p.nombre)}</b></td>
                  <td style="text-align:right">${p.cantidad}</td>
                  <td style="text-align:right;font-weight:700">$${fmt(p.ingreso)}</td>
                  <td style="text-align:right;color:${p.cmv>0?'#e65100':'#94a3b8'}">${p.cmv>0?'$'+fmt(p.cmv):'s/c'}</td>
                  <td style="text-align:right;font-weight:700;color:${p.ganancia==null?'#94a3b8':(p.ganancia>=0?'#00695c':'#c62828')}">${p.ganancia==null?'—':'$'+fmt(p.ganancia)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>` : ''}

        ${itemsSinCosto > 0 ? `
        <div style="background:#fff8e1;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;display:flex;align-items:center;gap:8px;font-size:12px;color:#92400e">
          <span class="material-icons" style="font-size:16px;color:#d97706">warning</span>
          <span><b>${itemsSinCosto}</b> items sin costo cargado en este ${vista === 'mes' ? 'mes' : 'día'}. La ganancia bruta no los incluye.</span>
        </div>` : ''}

      </div>
      <div class="ct-modal-footer">
        <button class="ct-btn-primary" id="ct-close-lg-detalle">Cerrar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  overlay.querySelector('.ct-modal-close').addEventListener('click', closeModal);
  overlay.querySelector('#ct-close-lg-detalle').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
}

function escapeHtmlCt(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ── Esqueleto HTML ────────────────────────────────────────────────────────────
function buildSkeleton(periodo, config) {
  const c1 = config.cuenta1_nombre || 'Cuenta 1';
  const c2 = config.cuenta2_nombre || 'Cuenta 2';
  const fi = config.fecha_inicio || '2026-04-18';
  const periodos = ['hoy', 'semana', 'mes'];
  const labels   = { hoy: 'Hoy', semana: '7 días', mes: 'Este mes' };

  return `
    <div class="ct-wrap">

      <div class="ct-toolbar">
        <div class="ct-periodo">
          ${periodos.map(p => `<button class="ct-periodo-btn${p===periodo?' active':''}" data-p="${p}">${labels[p]}</button>`).join('')}
        </div>
        <button id="ct-config-btn" class="ct-config-btn" title="Configurar cuentas">
          <span class="material-icons" style="font-size:18px">settings</span> Configurar cuentas
        </button>
      </div>

      <form id="ct-config-form" style="display:none;gap:10px;align-items:flex-end;flex-wrap:wrap;background:var(--card-bg);padding:16px;border-radius:var(--radius);margin-bottom:16px;box-shadow:var(--shadow)">
        <div>
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Nombre Cuenta 1 (transferencia)</label>
          <input id="cfg-cuenta1" type="text" value="${c1}" placeholder="Ej: Mercado Pago" style="padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;width:100%;max-width:220px;min-width:0" />
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Nombre Cuenta 2 (transferencia)</label>
          <input id="cfg-cuenta2" type="text" value="${c2}" placeholder="Ej: Banco Galicia" style="padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;width:100%;max-width:220px;min-width:0" />
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px" title="Oculta todas las ventas, gastos e historial anteriores a esta fecha">
            Fecha de inicio real
            <span class="material-icons" style="font-size:13px;color:#65676b;vertical-align:middle">help_outline</span>
          </label>
          <input id="cfg-fecha-inicio" type="date" value="${fi}" style="padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;width:100%;max-width:200px;min-width:0" />
          <div style="font-size:11px;color:#65676b;margin-top:4px;max-width:220px">Todo lo anterior no se borra, solo se oculta.</div>
        </div>
        <button type="submit" class="btn-primary" style="padding:8px 20px;background:var(--primary);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px">Guardar</button>
      </form>

      <div id="ct-stats">
        <div class="ct-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div>
      </div>

      <div id="ct-alertas"></div>

      <div class="ct-gasto-section">
        <div class="ct-section-title">
          <span class="material-icons" style="font-size:16px;vertical-align:middle">add_circle_outline</span>
          Anotar gasto o pago
        </div>
        <form id="ct-gasto-form" class="ct-gasto-form">
          <input id="gasto-desc" type="text" placeholder="¿Qué pagaste? (ej: proveedor, alquiler...)" required
            style="flex:1;min-width:180px;padding:10px 14px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit" />
          <input id="gasto-monto" type="number" placeholder="$ Monto" min="0.01" step="0.01" required
            style="width:130px;padding:10px 14px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit" />
          <select id="gasto-tipo"
            style="padding:10px 14px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;background:#fff">
            <option value="efectivo">Efectivo</option>
            <option value="cuenta1">${c1}</option>
            <option value="cuenta2">${c2}</option>
          </select>
          <button type="submit" style="padding:10px 20px;background:#c62828;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:700;font-size:14px;white-space:nowrap;display:flex;align-items:center;gap:6px;font-family:inherit">
            <span class="material-icons" style="font-size:16px">remove_circle_outline</span> Descontar
          </button>
        </form>
      </div>

      <div class="ct-gastos-card">
        <div class="ct-section-title">
          <span class="material-icons" style="font-size:16px;vertical-align:middle">receipt_long</span>
          Gastos anotados
        </div>
        <div id="ct-gastos-lista">
          <div class="ct-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div>
        </div>
      </div>

      <!-- Lista Ganancia: agregaciones por día / mes -->
      <div class="ct-gastos-card" style="margin-top:16px">
        <div class="ct-section-title" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>
            <span class="material-icons" style="font-size:16px;vertical-align:middle">insights</span>
            Lista de Ganancia
            <span style="font-size:11px;color:#65676b;margin-left:8px;font-weight:400">Click en una fila para ver el detalle</span>
          </div>
          <div class="ct-lg-tabs" style="display:flex;gap:4px;background:#f0f2f5;padding:3px;border-radius:8px">
            <button class="ct-lg-tab active" data-vista="dia" style="padding:5px 14px;border:none;background:#fff;border-radius:6px;font-weight:700;font-size:12px;cursor:pointer;color:#1c1e21;box-shadow:0 1px 2px rgba(0,0,0,0.05)">Por día</button>
            <button class="ct-lg-tab" data-vista="mes" style="padding:5px 14px;border:none;background:transparent;border-radius:6px;font-weight:600;font-size:12px;cursor:pointer;color:#65676b">Por mes</button>
          </div>
        </div>
        <div id="ct-ganancia-lista">
          <div class="ct-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div>
        </div>
      </div>

    </div>
  `;
}
