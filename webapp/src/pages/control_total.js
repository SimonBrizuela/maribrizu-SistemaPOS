import {
  collection, getDocs, doc, addDoc, deleteDoc, getDoc, setDoc, updateDoc,
  query, orderBy, limit, serverTimestamp
} from 'firebase/firestore';
import { getCached, invalidateCache, invalidateCacheByPrefix } from '../cache.js';
import { getFechaInicioDate, saveControlConfig, isVentaVarios2, isItemVarios2 } from '../config.js';

// ── Categorías de gastos/ingresos ─────────────────────────────────────────────
// Doc: { nombre, tipo: 'gasto'|'ingreso'|'ambos', color, parent_id? }
const CATS_CACHE_KEY = 'ct:categorias';
async function loadCategorias(db) {
  return getCached(CATS_CACHE_KEY, async () => {
    const snap = await getDocs(collection(db, 'gasto_categorias'));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es'));
  }, { ttl: 5 * 60 * 1000 });
}
function invalidateCategorias() { invalidateCache(CATS_CACHE_KEY); }

const CAT_COLORS = ['#1877f2', '#2e7d32', '#e65100', '#6a1b9a', '#c62828', '#00695c', '#ef6c00', '#455a64', '#5d4037', '#827717'];
function colorForCat(cat) { return (cat && cat.color) || '#78909c'; }

// Lista de rubros (la misma que usa el catálogo) — config/rubros.lista
const RUBROS_CACHE_KEY = 'ct:rubros';
async function loadRubros(db) {
  return getCached(RUBROS_CACHE_KEY, async () => {
    try {
      const snap = await getDoc(doc(db, 'config', 'rubros'));
      if (snap.exists() && Array.isArray(snap.data().lista)) return snap.data().lista;
    } catch (_) {}
    return [
      'LIBRERÍA','MERCERÍA','JUGUETERÍA','ARTÍSTICA','COTILLÓN','INFORMÁTICA','TELGOPOR',
      'ACCESORIOS','LENCERIA','NAVIDAD','PAPELERA','PERFUMERIA','REGALERIA','SELLOS','SERVICIOS',
    ];
  }, { ttl: 10 * 60 * 1000 });
}

function buildCatSelectOptions(categorias, tipoFiltro, selectedId) {
  // tipoFiltro: 'gasto' | 'ingreso' → filtra catálogo por tipo + 'ambos'
  // Construye lista jerárquica (padres primero, hijos indentados)
  const filtradas = categorias.filter(c => !tipoFiltro || c.tipo === 'ambos' || c.tipo === tipoFiltro);
  const porPadre = {};
  filtradas.forEach(c => {
    const k = c.parent_id || '__root__';
    (porPadre[k] = porPadre[k] || []).push(c);
  });
  const emit = (padreId, nivel) => {
    const hijos = porPadre[padreId] || [];
    return hijos.map(c => {
      const prefix = '  '.repeat(nivel) + (nivel > 0 ? '↳ ' : '');
      const sel = c.id === selectedId ? 'selected' : '';
      return `<option value="${c.id}" ${sel}>${escapeHtmlCt(prefix + (c.nombre || ''))}</option>` + emit(c.id, nivel + 1);
    }).join('');
  };
  return '<option value="">— Sin categoría —</option>' + emit('__root__', 0);
}

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
  const [categorias, rubros] = await Promise.all([loadCategorias(db), loadRubros(db)]);

  container.innerHTML = buildSkeleton(periodo, config, categorias, rubros);

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
  setupCategoriasBtn(container, db, periodo, config);

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
  const [ventas, itemsMap, catalogo, gastos, categorias] = await Promise.all([
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
    loadCategorias(db),
  ]);
  const catById = Object.fromEntries(categorias.map(c => [c.id, c]));

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

  // ── Separar gastos e ingresos manuales ──
  const soloGastos   = gastos.filter(g => !g.es_ingreso);
  const soloIngresos = gastos.filter(g =>  g.es_ingreso);

  const gastoEfectivo = soloGastos.filter(g => g.tipo === 'efectivo').reduce((s, g) => s + (g.monto || 0), 0);
  const gastoCuenta1  = soloGastos.filter(g => g.tipo === 'cuenta1').reduce((s, g) => s + (g.monto || 0), 0);
  const gastoCuenta2  = soloGastos.filter(g => g.tipo === 'cuenta2').reduce((s, g) => s + (g.monto || 0), 0);
  const gastoTotal    = gastoEfectivo + gastoCuenta1 + gastoCuenta2;

  const ingManualEfectivo = soloIngresos.filter(g => g.tipo === 'efectivo').reduce((s, g) => s + (g.monto || 0), 0);
  const ingManualCuenta1  = soloIngresos.filter(g => g.tipo === 'cuenta1').reduce((s, g) => s + (g.monto || 0), 0);
  const ingManualCuenta2  = soloIngresos.filter(g => g.tipo === 'cuenta2').reduce((s, g) => s + (g.monto || 0), 0);
  const ingManualTotal    = ingManualEfectivo + ingManualCuenta1 + ingManualCuenta2;

  // Resumen por categoría (gastos e ingresos)
  const porCategoria = {};   // { id|'__sin__': { nombre, color, tipo, gasto, ingreso, count } }
  for (const g of gastos) {
    const key = g.categoria_id || '__sin__';
    const cat = g.categoria_id ? catById[g.categoria_id] : null;
    const nombre = cat?.nombre || g.categoria_nombre || 'Sin categoría';
    if (!porCategoria[key]) {
      porCategoria[key] = { id: key, nombre, color: colorForCat(cat), gasto: 0, ingreso: 0, count: 0 };
    }
    if (g.es_ingreso) porCategoria[key].ingreso += (g.monto || 0);
    else              porCategoria[key].gasto   += (g.monto || 0);
    porCategoria[key].count++;
  }

  // Ganancia bruta SOLO de los items con costo conocido — así no se distorsiona
  const gananciaBruta = ingresoConCosto - cmv;
  // Ganancia neta: bruta − gastos + ingresos manuales
  const gananciaNeta  = gananciaBruta - gastoTotal + ingManualTotal;

  const netoEfectivo = efectivoTotal - gastoEfectivo + ingManualEfectivo;
  const netoCuenta1  = transCuenta1  - gastoCuenta1  + ingManualCuenta1;
  const netoCuenta2  = transCuenta2  - gastoCuenta2  + ingManualCuenta2;

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
              ${ingManualEfectivo > 0 ? `<span class="ct-cuenta-ingreso">+$${fmt(ingManualEfectivo)} <small style="color:#65676b">extra</small></span>` : ''}
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
              ${ingManualCuenta1 > 0 ? `<span class="ct-cuenta-ingreso">+$${fmt(ingManualCuenta1)} <small style="color:#65676b">extra</small></span>` : ''}
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
              ${ingManualCuenta2 > 0 ? `<span class="ct-cuenta-ingreso">+$${fmt(ingManualCuenta2)} <small style="color:#65676b">extra</small></span>` : ''}
              ${gastoCuenta2 > 0 ? `<span class="ct-cuenta-gasto">−$${fmt(gastoCuenta2)}</span>` : ''}
              <span class="ct-cuenta-neto" style="color:${netoCuenta2>=0?'#2e7d32':'#c62828'}">= $${fmt(netoCuenta2)}</span>
            </div>
          </div>
        </div>
      </div>
    `;

    // Click en bloques de la ecuación → modal con detalle
    const detalleData = {
      mapaConCosto, gastos, soloGastos, soloIngresos,
      ingresoConCosto, cmv, gananciaBruta, gastoTotal, gananciaNeta,
      ingManualTotal, ingManualEfectivo, ingManualCuenta1, ingManualCuenta2,
      gastoEfectivo, gastoCuenta1, gastoCuenta2,
      porCategoria, categorias, catById,
      config, ventasCount: ventasPeriodo.length,
    };
    statsEl.querySelectorAll('.ct-clickable').forEach(el => {
      el.addEventListener('click', () => abrirDetalleControl(el.dataset.detalle, detalleData));
    });
  }

  // ── Resumen por categoría (bloque visible bajo la ecuación) ──
  renderResumenCategorias(container, porCategoria);

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

  // ── Lista de gastos (con filtros: tipo mov., categoría, búsqueda) ──
  renderGastosLista(container, db, gastos, categorias, catById, config, () => refreshDatos(container, db, periodo, config));
}

// ── Render de la lista de gastos con filtros ──────────────────────────────────
function renderGastosLista(container, db, gastos, categorias, catById, config, onRefresh) {
  const gastosEl = container.querySelector('#ct-gastos-lista');
  if (!gastosEl) return;

  if (gastos.length === 0) {
    gastosEl.innerHTML = `<div class="empty-state" style="padding:32px"><span class="material-icons">receipt_long</span><p>Sin gastos ni ingresos registrados en este período</p></div>`;
    return;
  }

  const c1 = config.cuenta1_nombre || 'Cuenta 1';
  const c2 = config.cuenta2_nombre || 'Cuenta 2';
  const tipoLabel = { efectivo: 'Efectivo', cuenta1: c1, cuenta2: c2 };

  // Estado de filtros persistido
  const state = {
    mov: localStorage.getItem('ct:flt_mov') || 'todo',   // 'todo' | 'gasto' | 'ingreso'
    cat: localStorage.getItem('ct:flt_cat') || '',        // '' | categoria_id | '__sin__'
    rubro: localStorage.getItem('ct:flt_rubro') || '',   // '' | rubro | '__sin__'
    q:   '',
  };

  const catOpts = ['<option value="">Todas las categorías</option>',
    '<option value="__sin__">Sin categoría</option>',
    ...categorias.map(c => `<option value="${c.id}">${escapeHtmlCt(c.nombre)}</option>`)].join('');

  // Rubros presentes en los gastos actuales
  const rubrosSet = new Set();
  gastos.forEach(g => { if (g.rubro) rubrosSet.add(g.rubro); });
  const rubroOpts = ['<option value="">Todos los rubros</option>',
    '<option value="__sin__">Sin rubro</option>',
    ...[...rubrosSet].sort().map(r => `<option value="${escapeHtmlCt(r)}">${escapeHtmlCt(r)}</option>`)].join('');

  gastosEl.innerHTML = `
    <div class="ct-gastos-filtros">
      <div class="ct-flt-mov" role="tablist">
        <button type="button" class="ct-flt-btn" data-m="todo">Todos</button>
        <button type="button" class="ct-flt-btn" data-m="gasto">Gastos</button>
        <button type="button" class="ct-flt-btn" data-m="ingreso">Ingresos</button>
      </div>
      <select class="ct-flt-cat">${catOpts}</select>
      <select class="ct-flt-rubro">${rubroOpts}</select>
      <div class="ct-flt-search">
        <span class="material-icons">search</span>
        <input type="text" class="ct-flt-q" placeholder="Buscar descripción..." />
      </div>
    </div>
    <div class="ct-gastos-lista-body"></div>
  `;

  const body = gastosEl.querySelector('.ct-gastos-lista-body');
  const btns = gastosEl.querySelectorAll('.ct-flt-btn');
  const selCat = gastosEl.querySelector('.ct-flt-cat');
  const selRubro = gastosEl.querySelector('.ct-flt-rubro');
  const inpQ   = gastosEl.querySelector('.ct-flt-q');

  selCat.value = state.cat;
  if (selRubro) selRubro.value = state.rubro;
  btns.forEach(b => b.classList.toggle('active', b.dataset.m === state.mov));

  const paint = () => {
    const filtrados = gastos.filter(g => {
      if (state.mov === 'gasto'  && g.es_ingreso) return false;
      if (state.mov === 'ingreso' && !g.es_ingreso) return false;
      if (state.cat) {
        if (state.cat === '__sin__' && g.categoria_id) return false;
        if (state.cat !== '__sin__' && g.categoria_id !== state.cat) return false;
      }
      if (state.rubro) {
        if (state.rubro === '__sin__' && g.rubro) return false;
        if (state.rubro !== '__sin__' && g.rubro !== state.rubro) return false;
      }
      if (state.q) {
        const q = state.q.toLowerCase();
        const descHit = (g.descripcion || '').toLowerCase().includes(q);
        const catName = (catById[g.categoria_id]?.nombre || g.categoria_nombre || '').toLowerCase();
        const catHit = catName.includes(q);
        const rubroHit = (g.rubro || '').toLowerCase().includes(q);
        if (!descHit && !catHit && !rubroHit) return false;
      }
      return true;
    });

    if (filtrados.length === 0) {
      body.innerHTML = `<div class="empty-state" style="padding:24px"><span class="material-icons">filter_alt_off</span><p>Sin resultados para el filtro actual</p></div>`;
      return;
    }

    body.innerHTML = `
      <table class="ct-gastos-table">
        <thead><tr>
          <th>Fecha</th><th>Descripción</th><th>Categoría</th><th>Rubro</th><th>Cuenta</th>
          <th style="text-align:right">Monto</th><th></th>
        </tr></thead>
        <tbody>
          ${filtrados.map(g => {
            const cat = g.categoria_id ? catById[g.categoria_id] : null;
            const catNombre = cat?.nombre || g.categoria_nombre || '';
            const catColor = colorForCat(cat);
            const signo  = g.es_ingreso ? '+' : '-';
            const color  = g.es_ingreso ? '#2e7d32' : '#c62828';
            return `
              <tr>
                <td style="white-space:nowrap;color:var(--text-muted)">${g.fecha || ''}</td>
                <td>
                  ${g.es_ingreso ? '<span class="ct-mov-tag ct-mov-ingreso" title="Ingreso">Ingreso</span> ' : ''}${escapeHtmlCt(g.descripcion || '-')}
                </td>
                <td>${catNombre ? `<span class="ct-cat-badge" style="--cat-color:${catColor}">${escapeHtmlCt(catNombre)}</span>` : '<span style="color:#94a3b8;font-size:11px">—</span>'}</td>
                <td>${g.rubro ? `<span class="ct-rubro-badge">${escapeHtmlCt(g.rubro)}</span>` : '<span style="color:#94a3b8;font-size:11px">—</span>'}</td>
                <td><span class="badge ${g.tipo==='efectivo'?'badge-green':'badge-blue'}">${tipoLabel[g.tipo] || g.tipo}</span></td>
                <td style="text-align:right;font-weight:700;color:${color}">${signo}$${fmt(g.monto)}</td>
                <td><button class="ct-del-btn" data-id="${g._id}" title="Eliminar"><span class="material-icons" style="font-size:16px;pointer-events:none">delete_outline</span></button></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
    body.querySelectorAll('.ct-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este registro?')) return;
        btn.disabled = true;
        await deleteDoc(doc(db, 'gastos', btn.dataset.id));
        invalidateCacheByPrefix('ct:gastos');
        await onRefresh();
      });
    });
  };

  btns.forEach(b => b.addEventListener('click', () => {
    state.mov = b.dataset.m;
    localStorage.setItem('ct:flt_mov', state.mov);
    btns.forEach(x => x.classList.toggle('active', x.dataset.m === state.mov));
    paint();
  }));
  selCat.addEventListener('change', () => {
    state.cat = selCat.value;
    localStorage.setItem('ct:flt_cat', state.cat);
    paint();
  });
  if (selRubro) {
    selRubro.addEventListener('change', () => {
      state.rubro = selRubro.value;
      localStorage.setItem('ct:flt_rubro', state.rubro);
      paint();
    });
  }
  let qTimer = null;
  inpQ.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.q = inpQ.value.trim(); paint(); }, 120);
  });

  paint();
}

// ── Resumen por categoría (bloque arriba) ─────────────────────────────────────
function renderResumenCategorias(container, porCategoria) {
  const el = container.querySelector('#ct-resumen-categorias');
  if (!el) return;
  const lista = Object.values(porCategoria)
    .map(c => ({ ...c, neto: c.ingreso - c.gasto }))
    .sort((a, b) => (Math.abs(b.gasto) + Math.abs(b.ingreso)) - (Math.abs(a.gasto) + Math.abs(a.ingreso)));
  if (lista.length === 0) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="ct-section-title">
      <span class="material-icons" style="font-size:16px;vertical-align:middle">local_offer</span>
      Resumen por categoría
    </div>
    <div class="ct-cat-chips">
      ${lista.map(c => `
        <div class="ct-cat-chip" style="--cat-color:${c.color}">
          <div class="ct-cat-chip-head">
            <span class="ct-cat-dot"></span>
            <b>${escapeHtmlCt(c.nombre)}</b>
            <span class="ct-cat-chip-count">${c.count}</span>
          </div>
          <div class="ct-cat-chip-nums">
            ${c.gasto > 0 ? `<span style="color:#c62828">−$${fmt(c.gasto)}</span>` : ''}
            ${c.ingreso > 0 ? `<span style="color:#2e7d32">+$${fmt(c.ingreso)}</span>` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  `;
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
    mapaConCosto, gastos, soloGastos, soloIngresos,
    ingresoConCosto, cmv, gananciaBruta, gastoTotal, gananciaNeta,
    ingManualTotal,
    gastoEfectivo, gastoCuenta1, gastoCuenta2,
    porCategoria, catById,
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
    desc   = `Gasto total: <b style="color:#c62828">$${fmt(gastoTotal)}</b> · Ingresos manuales: <b style="color:#2e7d32">$${fmt(ingManualTotal || 0)}</b> · ${gastos.length} registros.`;

    // Resumen por categoría (solo con movimiento)
    const porCatArr = Object.values(porCategoria || {})
      .map(c => ({ ...c, total: (c.gasto || 0) + (c.ingreso || 0) }))
      .filter(c => c.total > 0)
      .sort((a, b) => b.total - a.total);

    body = (soloGastos.length === 0 && (soloIngresos || []).length === 0)
      ? `<div class="empty-state" style="padding:32px"><span class="material-icons">receipt_long</span><p>Sin registros en el período</p></div>`
      : `
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
          <div class="ct-mini-stat"><span style="color:#65676b;font-size:12px">Efectivo</span><b style="color:#c62828">$${fmt(gastoEfectivo)}</b></div>
          <div class="ct-mini-stat"><span style="color:#65676b;font-size:12px">${c1}</span><b style="color:#c62828">$${fmt(gastoCuenta1)}</b></div>
          <div class="ct-mini-stat"><span style="color:#65676b;font-size:12px">${c2}</span><b style="color:#c62828">$${fmt(gastoCuenta2)}</b></div>
          ${ingManualTotal > 0 ? `<div class="ct-mini-stat"><span style="color:#65676b;font-size:12px">Ingresos extra</span><b style="color:#2e7d32">$${fmt(ingManualTotal)}</b></div>` : ''}
        </div>

        ${porCatArr.length > 0 ? `
        <div style="padding:12px 20px 4px 20px">
          <div style="font-size:11px;font-weight:700;color:#65676b;text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">Por categoría</div>
          <div class="ct-cat-chips">
            ${porCatArr.map(c => `
              <div class="ct-cat-chip" style="--cat-color:${c.color}">
                <div class="ct-cat-chip-head">
                  <span class="ct-cat-dot"></span>
                  <b>${escapeHtmlCt(c.nombre)}</b>
                  <span class="ct-cat-chip-count">${c.count}</span>
                </div>
                <div class="ct-cat-chip-nums">
                  ${c.gasto > 0 ? `<span style="color:#c62828">−$${fmt(c.gasto)}</span>` : ''}
                  ${c.ingreso > 0 ? `<span style="color:#2e7d32">+$${fmt(c.ingreso)}</span>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>` : ''}

        <table class="ct-costos-table">
          <thead><tr>
            <th>Fecha</th>
            <th>Descripción</th>
            <th>Categoría</th>
            <th>Cuenta</th>
            <th style="text-align:right">Monto</th>
          </tr></thead>
          <tbody>
            ${gastos.map(g => {
              const cat = g.categoria_id ? catById[g.categoria_id] : null;
              const catColor = colorForCat(cat);
              const catNombre = cat?.nombre || g.categoria_nombre || '';
              const signo = g.es_ingreso ? '+' : '-';
              const col   = g.es_ingreso ? '#2e7d32' : '#c62828';
              return `
                <tr>
                  <td style="white-space:nowrap;color:#65676b">${g.fecha || ''}</td>
                  <td><b style="font-size:13px">${escapeHtmlCt(g.descripcion || '-')}</b></td>
                  <td>${catNombre ? `<span class="ct-cat-badge" style="--cat-color:${catColor}">${escapeHtmlCt(catNombre)}</span>` : '<span style="color:#94a3b8">—</span>'}</td>
                  <td><span class="badge ${g.tipo==='efectivo'?'badge-green':'badge-blue'}">${tipoLabel[g.tipo] || g.tipo}</span></td>
                  <td style="text-align:right;font-weight:700;color:${col}">${signo}$${fmt(g.monto)}</td>
                </tr>
              `;
            }).join('')}
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
        ${ingManualTotal > 0 ? `
        <div class="ct-neta-row ct-neta-sub">
          <div class="ct-neta-lbl"><span class="material-icons" style="color:#2e7d32">add_circle</span> Ingresos manuales</div>
          <div class="ct-neta-val" style="color:#2e7d32">+ $${fmt(ingManualTotal)}</div>
        </div>` : ''}
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

  const movBtns = container.querySelectorAll('.ct-mov-btn');
  const selCat  = form.querySelector('#gasto-categoria');
  const btnSubmit = form.querySelector('button[type=submit]');
  const btnLabel  = form.querySelector('.ct-submit-label');
  const iconSubmit = form.querySelector('.ct-submit-icon');

  // Estado del modo del form
  let mov = 'gasto'; // 'gasto' | 'ingreso'
  const applyMov = () => {
    movBtns.forEach(b => b.classList.toggle('active', b.dataset.mov === mov));
    form.classList.toggle('ct-form-ingreso', mov === 'ingreso');
    if (mov === 'ingreso') {
      btnSubmit.style.background = '#2e7d32';
      iconSubmit.textContent = 'add_circle';
      btnLabel.textContent = 'Sumar ingreso';
    } else {
      btnSubmit.style.background = '#c62828';
      iconSubmit.textContent = 'remove_circle_outline';
      btnLabel.textContent = 'Descontar';
    }
    // Refrescar select de categorías según tipo
    refillCats();
  };

  const refillCats = async () => {
    const cats = await loadCategorias(db);
    const current = selCat.value;
    selCat.innerHTML = buildCatSelectOptions(cats, mov, current);
  };

  movBtns.forEach(b => b.addEventListener('click', () => { mov = b.dataset.mov; applyMov(); }));
  applyMov();

  // Al elegir una categoría con rubro asociado, pre-seleccionar ese rubro en el form
  selCat.addEventListener('change', async () => {
    if (!selCat.value) return;
    const cats = await loadCategorias(db);
    const cat = cats.find(c => c.id === selCat.value);
    const selRubro = form.querySelector('#gasto-rubro');
    if (cat?.rubro && selRubro && !selRubro.value) selRubro.value = cat.rubro;
  });

  // Atajo: crear categoría desde el form (modal propio)
  const btnNueva = form.querySelector('#ct-cat-nueva');
  if (btnNueva) {
    btnNueva.addEventListener('click', () => abrirModalNuevaCategoria(db, mov, async (nuevoId, rubroCat) => {
      await refillCats();
      if (nuevoId) selCat.value = nuevoId;
      // Si la categoría nueva tiene un rubro asociado, pre-seleccionar el rubro en el form
      const selRubro = form.querySelector('#gasto-rubro');
      if (selRubro && rubroCat) selRubro.value = rubroCat;
    }));
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const desc  = form.querySelector('#gasto-desc').value.trim();
    const monto = parseFloat(form.querySelector('#gasto-monto').value) || 0;
    const tipo  = form.querySelector('#gasto-tipo').value;
    const catId = selCat.value || null;
    const rubro = form.querySelector('#gasto-rubro')?.value || null;

    if (!desc || monto <= 0) return;

    btnSubmit.disabled = true;
    btnLabel.textContent = 'Guardando...';

    try {
      const cats = await loadCategorias(db);
      const cat = catId ? cats.find(c => c.id === catId) : null;
      await addDoc(collection(db, 'gastos'), {
        descripcion: desc,
        monto,
        tipo,
        es_ingreso: mov === 'ingreso',
        categoria_id: catId,
        categoria_nombre: cat?.nombre || null,
        rubro: rubro || null,
        fecha: todayAR(),
        created_at: serverTimestamp(),
      });
      form.reset();
      applyMov();
      invalidateCacheByPrefix('ct:gastos');
      await refreshDatos(container, db, periodo, config);
    } finally {
      btnSubmit.disabled = false;
      applyMov();
    }
  });
}

// ── Gestor de categorías (modal CRUD) ─────────────────────────────────────────
function setupCategoriasBtn(container, db, periodo, config) {
  const btn = container.querySelector('#ct-cat-gestionar-btn');
  if (!btn) return;
  btn.addEventListener('click', () => abrirGestorCategorias(container, db, periodo, config));
}

async function abrirGestorCategorias(container, db, periodo, config) {
  const cats = await loadCategorias(db);
  const overlay = document.createElement('div');
  overlay.className = 'ct-modal-overlay';
  overlay.innerHTML = `
    <div class="ct-modal" role="dialog" style="max-width:720px">
      <div class="ct-modal-header">
        <span class="material-icons" style="color:#6a1b9a">local_offer</span>
        <h3>Categorías de gastos e ingresos</h3>
        <button class="ct-modal-close" title="Cerrar"><span class="material-icons">close</span></button>
      </div>
      <div class="ct-modal-desc">
        Creá categorías (rubros, proveedores, marcas...) y vinculalas con una categoría padre si querés agruparlas.
      </div>
      <div class="ct-modal-body" style="padding:16px 20px">
        <form id="ct-cat-form" class="ct-cat-form">
          <input type="text" id="ct-cat-nombre" placeholder="Nombre (ej: Proveedor X, Servicios, Alquiler)" required
            style="flex:1;min-width:180px;padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:13px" />
          <select id="ct-cat-tipo" style="padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;background:#fff">
            <option value="ambos">Gasto e ingreso</option>
            <option value="gasto">Solo gasto</option>
            <option value="ingreso">Solo ingreso</option>
          </select>
          <select id="ct-cat-padre" style="padding:9px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;background:#fff">
            <option value="">Sin categoría padre</option>
            ${cats.map(c => `<option value="${c.id}">${escapeHtmlCt(c.nombre)}</option>`).join('')}
          </select>
          <input type="color" id="ct-cat-color" value="#6a1b9a" title="Color" style="width:44px;height:38px;padding:0;border:1.5px solid var(--border);border-radius:8px;cursor:pointer" />
          <button type="submit" class="ct-btn-primary"><span class="material-icons" style="font-size:16px">add</span> Crear</button>
        </form>

        <div id="ct-cat-lista" style="margin-top:16px"></div>
      </div>
      <div class="ct-modal-footer">
        <span style="color:#65676b;font-size:12px">Eliminar una categoría no borra los gastos; quedan como "Sin categoría".</span>
        <button class="ct-btn-primary" id="ct-cat-cerrar">Cerrar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeAndRefresh = async () => {
    overlay.remove();
    // Refrescar select del form y datos
    const selForm = container.querySelector('#gasto-categoria');
    if (selForm) {
      const activoMov = container.querySelector('.ct-mov-btn.active')?.dataset?.mov || 'gasto';
      const updated = await loadCategorias(db);
      selForm.innerHTML = buildCatSelectOptions(updated, activoMov, selForm.value);
    }
    refreshDatosTrigger(container, db, periodo, config);
  };
  overlay.querySelector('.ct-modal-close').addEventListener('click', closeAndRefresh);
  overlay.querySelector('#ct-cat-cerrar').addEventListener('click', closeAndRefresh);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeAndRefresh(); });

  const listaEl   = overlay.querySelector('#ct-cat-lista');
  const selPadre  = overlay.querySelector('#ct-cat-padre');
  const inpColor  = overlay.querySelector('#ct-cat-color');
  inpColor.value  = CAT_COLORS[Math.floor(Math.random() * CAT_COLORS.length)];

  const pintarLista = (categorias) => {
    if (categorias.length === 0) {
      listaEl.innerHTML = `<div class="empty-state" style="padding:24px"><span class="material-icons">local_offer</span><p>Sin categorías creadas aún.</p></div>`;
      return;
    }
    // Jerarquía: padres con hijos anidados
    const byId = Object.fromEntries(categorias.map(c => [c.id, c]));
    const porPadre = {};
    categorias.forEach(c => {
      const k = c.parent_id || '__root__';
      (porPadre[k] = porPadre[k] || []).push(c);
    });
    const render = (padreId, nivel) => {
      const hijos = (porPadre[padreId] || []).sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es'));
      return hijos.map(c => {
        const tipoBadge = c.tipo === 'gasto' ? '<span class="ct-cat-tipo-badge" style="color:#c62828">Gasto</span>'
                        : c.tipo === 'ingreso' ? '<span class="ct-cat-tipo-badge" style="color:#2e7d32">Ingreso</span>'
                        : '<span class="ct-cat-tipo-badge">Ambos</span>';
        return `
          <div class="ct-cat-row" data-id="${c.id}" style="padding-left:${12 + nivel * 20}px">
            <span class="ct-cat-swatch" style="background:${c.color || '#94a3b8'}"></span>
            <b class="ct-cat-nombre">${escapeHtmlCt(c.nombre || '(sin nombre)')}</b>
            ${tipoBadge}
            ${c.parent_id && byId[c.parent_id] ? `<span class="ct-cat-parent-hint">↳ ${escapeHtmlCt(byId[c.parent_id].nombre)}</span>` : ''}
            <div class="ct-cat-actions">
              <button class="ct-cat-edit" title="Editar"><span class="material-icons" style="font-size:16px">edit</span></button>
              <button class="ct-cat-del"  title="Eliminar"><span class="material-icons" style="font-size:16px">delete_outline</span></button>
            </div>
          </div>
        ` + render(c.id, nivel + 1);
      }).join('');
    };
    listaEl.innerHTML = render('__root__', 0);

    listaEl.querySelectorAll('.ct-cat-row').forEach(row => {
      const id = row.dataset.id;
      const c  = byId[id];
      row.querySelector('.ct-cat-del').addEventListener('click', async () => {
        if (!confirm(`¿Eliminar la categoría "${c.nombre}"?`)) return;
        await deleteDoc(doc(db, 'gasto_categorias', id));
        invalidateCategorias();
        const updated = await loadCategorias(db);
        pintarLista(updated);
        refrescarOpcionesPadre(updated);
      });
      row.querySelector('.ct-cat-edit').addEventListener('click', () => editarCategoriaInline(row, c, db, async () => {
        const updated = await loadCategorias(db);
        pintarLista(updated);
        refrescarOpcionesPadre(updated);
      }, categorias));
    });
  };

  const refrescarOpcionesPadre = (categorias) => {
    selPadre.innerHTML = '<option value="">Sin categoría padre</option>' +
      categorias.map(c => `<option value="${c.id}">${escapeHtmlCt(c.nombre)}</option>`).join('');
  };

  pintarLista(cats);

  overlay.querySelector('#ct-cat-form').addEventListener('submit', async e => {
    e.preventDefault();
    const nombre  = overlay.querySelector('#ct-cat-nombre').value.trim();
    const tipo    = overlay.querySelector('#ct-cat-tipo').value;
    const parent  = overlay.querySelector('#ct-cat-padre').value || null;
    const color   = overlay.querySelector('#ct-cat-color').value || '#6a1b9a';
    if (!nombre) return;
    await addDoc(collection(db, 'gasto_categorias'), {
      nombre, tipo, color, parent_id: parent, created_at: serverTimestamp(),
    });
    invalidateCategorias();
    const updated = await loadCategorias(db);
    pintarLista(updated);
    refrescarOpcionesPadre(updated);
    overlay.querySelector('#ct-cat-form').reset();
    inpColor.value = CAT_COLORS[Math.floor(Math.random() * CAT_COLORS.length)];
  });

}

function editarCategoriaInline(row, cat, db, onDone, todasCats) {
  const nombreEl = row.querySelector('.ct-cat-nombre');
  const original = nombreEl.textContent;
  const parentOpts = ['<option value="">Sin padre</option>',
    ...todasCats.filter(c => c.id !== cat.id).map(c =>
      `<option value="${c.id}" ${cat.parent_id===c.id?'selected':''}>${escapeHtmlCt(c.nombre)}</option>`)].join('');
  row.innerHTML = `
    <input type="text" class="ct-cat-edit-nombre" value="${escapeHtmlCt(cat.nombre || '')}"
      style="flex:1;padding:6px 10px;border:1.5px solid var(--primary);border-radius:6px;font-size:13px;font-weight:700" />
    <input type="color" class="ct-cat-edit-color" value="${cat.color || '#6a1b9a'}" style="width:38px;height:30px;padding:0;border:1.5px solid var(--border);border-radius:6px;cursor:pointer" />
    <select class="ct-cat-edit-tipo" style="padding:6px 8px;border:1.5px solid var(--border);border-radius:6px;font-size:12px">
      <option value="ambos"   ${cat.tipo==='ambos'?'selected':''}>Ambos</option>
      <option value="gasto"   ${cat.tipo==='gasto'?'selected':''}>Gasto</option>
      <option value="ingreso" ${cat.tipo==='ingreso'?'selected':''}>Ingreso</option>
    </select>
    <select class="ct-cat-edit-padre" style="padding:6px 8px;border:1.5px solid var(--border);border-radius:6px;font-size:12px;max-width:140px">${parentOpts}</select>
    <div class="ct-cat-actions">
      <button class="ct-cat-save" title="Guardar"><span class="material-icons" style="font-size:16px;color:#2e7d32">check</span></button>
      <button class="ct-cat-cancel" title="Cancelar"><span class="material-icons" style="font-size:16px">close</span></button>
    </div>
  `;
  row.style.flexWrap = 'wrap';
  const inp   = row.querySelector('.ct-cat-edit-nombre');
  const col   = row.querySelector('.ct-cat-edit-color');
  const tipo  = row.querySelector('.ct-cat-edit-tipo');
  const padre = row.querySelector('.ct-cat-edit-padre');
  inp.focus(); inp.select();

  row.querySelector('.ct-cat-cancel').addEventListener('click', async () => {
    await onDone();
  });
  row.querySelector('.ct-cat-save').addEventListener('click', async () => {
    const nuevo = inp.value.trim();
    if (!nuevo) { inp.focus(); return; }
    await updateDoc(doc(db, 'gasto_categorias', cat.id), {
      nombre: nuevo,
      color: col.value || cat.color,
      tipo: tipo.value,
      parent_id: padre.value || null,
    });
    invalidateCategorias();
    await onDone();
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') row.querySelector('.ct-cat-save').click();
    if (e.key === 'Escape') row.querySelector('.ct-cat-cancel').click();
  });
}

// Hack: trigger refreshDatos desde fuera sin importar el scope (al cerrar gestor).
function refreshDatosTrigger(container, db, periodo, config) {
  // Llamamos a un re-render completo simulando cambio de período
  const btnActivo = container.querySelector('.ct-periodo-btn.active');
  if (btnActivo) btnActivo.click();
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

// ── Modal compacto: crear categoría rápida desde el form ──────────────────────
async function abrirModalNuevaCategoria(db, movActual, onCreated) {
  const [cats, rubros] = await Promise.all([loadCategorias(db), loadRubros(db)]);
  const overlay = document.createElement('div');
  overlay.className = 'ct-modal-overlay';
  const colorInicial = CAT_COLORS[Math.floor(Math.random() * CAT_COLORS.length)];
  overlay.innerHTML = `
    <div class="ct-modal ct-modal-compact" role="dialog">
      <div class="ct-modal-header">
        <span class="material-icons" style="color:#6a1b9a">new_label</span>
        <h3>Nueva categoría</h3>
        <button class="ct-modal-close" title="Cerrar"><span class="material-icons">close</span></button>
      </div>
      <div class="ct-modal-body" style="padding:18px 20px;overflow:visible">
        <label class="ct-field-label">Nombre</label>
        <input type="text" id="ct-nc-nombre" autofocus maxlength="40"
          placeholder="Ej: Alquiler, Proveedor X, Servicios..."
          class="ct-field-input" />

        <label class="ct-field-label" style="margin-top:14px">Tipo</label>
        <div class="ct-nc-tipo-row">
          <label class="ct-nc-tipo-opt"><input type="radio" name="nc-tipo" value="ambos" checked><span>Gasto e ingreso</span></label>
          <label class="ct-nc-tipo-opt"><input type="radio" name="nc-tipo" value="gasto"><span>Solo gasto</span></label>
          <label class="ct-nc-tipo-opt"><input type="radio" name="nc-tipo" value="ingreso"><span>Solo ingreso</span></label>
        </div>

        <label class="ct-field-label" style="margin-top:14px">Rubro <span style="color:#94a3b8;font-weight:400;font-size:11px">(opcional)</span></label>
        <select id="ct-nc-rubro" class="ct-field-input">
          <option value="">— Ninguno —</option>
          ${(rubros || []).map(r => `<option value="${escapeHtmlCt(r)}">${escapeHtmlCt(r)}</option>`).join('')}
        </select>

        <label class="ct-field-label" style="margin-top:14px">Color</label>
        <div class="ct-nc-colors">
          ${CAT_COLORS.map((col, i) => `
            <button type="button" class="ct-nc-color${col === colorInicial ? ' selected' : ''}" data-color="${col}" style="background:${col}" title="${col}"></button>
          `).join('')}
        </div>

        ${cats.length > 0 ? `
          <label class="ct-field-label" style="margin-top:14px">Categoría padre <span style="color:#94a3b8;font-weight:400;font-size:11px">(opcional)</span></label>
          <select id="ct-nc-parent" class="ct-field-input">
            <option value="">— Ninguna —</option>
            ${cats.map(c => `<option value="${c.id}">${escapeHtmlCt(c.nombre)}</option>`).join('')}
          </select>` : ''}
      </div>
      <div class="ct-modal-footer">
        <button type="button" class="ct-btn-ghost" id="ct-nc-cancel">Cancelar</button>
        <button type="button" class="ct-btn-primary" id="ct-nc-save"><span class="material-icons" style="font-size:16px">check</span> Crear categoría</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.ct-modal-close').addEventListener('click', close);
  overlay.querySelector('#ct-nc-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  // Swatch de colores: seleccionar
  let colorSel = colorInicial;
  overlay.querySelectorAll('.ct-nc-color').forEach(sw => {
    sw.addEventListener('click', () => {
      colorSel = sw.dataset.color;
      overlay.querySelectorAll('.ct-nc-color').forEach(x => x.classList.toggle('selected', x === sw));
    });
  });

  // Pre-seleccionar tipo acorde al modo activo del form
  const tipoPre = (movActual === 'ingreso' || movActual === 'gasto') ? 'ambos' : 'ambos';
  const preRadio = overlay.querySelector(`input[name="nc-tipo"][value="${tipoPre}"]`);
  if (preRadio) preRadio.checked = true;

  const inpNombre = overlay.querySelector('#ct-nc-nombre');
  setTimeout(() => inpNombre.focus(), 50);

  const guardar = async () => {
    const nombre = inpNombre.value.trim();
    if (!nombre) { inpNombre.focus(); inpNombre.classList.add('ct-field-err'); return; }
    const tipo = overlay.querySelector('input[name="nc-tipo"]:checked')?.value || 'ambos';
    const parent = overlay.querySelector('#ct-nc-parent')?.value || null;
    const rubro = overlay.querySelector('#ct-nc-rubro')?.value || null;
    const btnSave = overlay.querySelector('#ct-nc-save');
    btnSave.disabled = true;
    btnSave.innerHTML = '<span class="material-icons" style="font-size:16px">hourglass_empty</span> Creando...';
    try {
      const ref = await addDoc(collection(db, 'gasto_categorias'), {
        nombre, tipo, color: colorSel, parent_id: parent, rubro, created_at: serverTimestamp(),
      });
      invalidateCategorias();
      close();
      if (onCreated) onCreated(ref.id, rubro);
    } catch (e) {
      alert('Error al crear: ' + e.message);
      btnSave.disabled = false;
      btnSave.innerHTML = '<span class="material-icons" style="font-size:16px">check</span> Crear categoría';
    }
  };

  overlay.querySelector('#ct-nc-save').addEventListener('click', guardar);
  inpNombre.addEventListener('keydown', e => {
    if (e.key === 'Enter') guardar();
    if (e.key === 'Escape') close();
  });
  inpNombre.addEventListener('input', () => inpNombre.classList.remove('ct-field-err'));
}

// ── Esqueleto HTML ────────────────────────────────────────────────────────────
function buildSkeleton(periodo, config, categorias, rubros) {
  const c1 = config.cuenta1_nombre || 'Cuenta 1';
  const c2 = config.cuenta2_nombre || 'Cuenta 2';
  const fi = config.fecha_inicio || '2026-04-18';
  const periodos = ['hoy', 'semana', 'mes'];
  const labels   = { hoy: 'Hoy', semana: '7 días', mes: 'Este mes' };
  const catOpts  = buildCatSelectOptions(categorias || [], 'gasto', '');
  const rubroOpts = '<option value="">— Sin rubro —</option>' +
    (rubros || []).map(r => `<option value="${escapeHtmlCt(r)}">${escapeHtmlCt(r)}</option>`).join('');

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

      <div id="ct-resumen-categorias"></div>

      <div class="ct-gasto-section">
        <div class="ct-section-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div>
            <span class="material-icons" style="font-size:16px;vertical-align:middle">add_circle_outline</span>
            Anotar gasto o ingreso
          </div>
          <button type="button" id="ct-cat-gestionar-btn" class="ct-config-btn" style="text-transform:none;letter-spacing:0">
            <span class="material-icons" style="font-size:16px">local_offer</span> Gestionar categorías
          </button>
        </div>

        <div class="ct-mov-toggle" role="tablist" style="margin-top:10px;margin-bottom:10px">
          <button type="button" class="ct-mov-btn active" data-mov="gasto"><span class="material-icons" style="font-size:16px">remove_circle_outline</span> Gasto</button>
          <button type="button" class="ct-mov-btn" data-mov="ingreso"><span class="material-icons" style="font-size:16px">add_circle_outline</span> Ingreso</button>
        </div>

        <form id="ct-gasto-form" class="ct-gasto-form">
          <input id="gasto-desc" type="text" placeholder="Descripción (ej: proveedor, alquiler, venta fuera de caja...)" required
            style="flex:1;min-width:180px;padding:10px 14px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit" />
          <input id="gasto-monto" type="number" placeholder="$ Monto" min="0.01" step="0.01" required
            style="width:130px;padding:10px 14px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit" />
          <select id="gasto-tipo"
            style="padding:10px 14px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;background:#fff">
            <option value="efectivo">Efectivo</option>
            <option value="cuenta1">${c1}</option>
            <option value="cuenta2">${c2}</option>
          </select>
          <div class="ct-cat-field">
            <select id="gasto-categoria">
              ${catOpts}
            </select>
            <button type="button" id="ct-cat-nueva" class="ct-cat-nueva-btn" title="Crear nueva categoría">
              <span class="material-icons">add</span>
              <span>Nueva</span>
            </button>
          </div>
          <select id="gasto-rubro" title="Rubro"
            style="padding:10px 14px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;background:#fff;max-width:180px">
            ${rubroOpts}
          </select>
          <button type="submit" style="padding:10px 20px;background:#c62828;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:700;font-size:14px;white-space:nowrap;display:flex;align-items:center;gap:6px;font-family:inherit">
            <span class="material-icons ct-submit-icon" style="font-size:16px">remove_circle_outline</span>
            <span class="ct-submit-label">Descontar</span>
          </button>
        </form>
      </div>

      <div class="ct-gastos-card">
        <div class="ct-section-title">
          <span class="material-icons" style="font-size:16px;vertical-align:middle">receipt_long</span>
          Movimientos anotados
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
