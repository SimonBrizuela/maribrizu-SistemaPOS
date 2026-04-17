import {
  collection, getDocs, doc, addDoc, deleteDoc, getDoc, setDoc,
  query, orderBy, limit, serverTimestamp
} from 'firebase/firestore';
import { getCached, invalidateCacheByPrefix } from '../cache.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  return d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
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

// Límites de período
function periodoRango(periodo) {
  const hoy = todayAR();
  const now = new Date(hoy + 'T00:00:00-03:00');
  if (periodo === 'hoy') {
    return { desde: now, label: 'Hoy' };
  }
  if (periodo === 'semana') {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    return { desde: d, label: 'Últimos 7 días' };
  }
  // mes
  const inicioMes = new Date(hoy.slice(0, 7) + '-01T00:00:00-03:00');
  return { desde: inicioMes, label: 'Este mes' };
}

// ── Render principal ──────────────────────────────────────────────────────────
export async function renderControlTotal(container, db) {
  // Estado de período (persiste en localStorage)
  let periodo = localStorage.getItem('ct:periodo') || 'hoy';

  // Cargar config de cuentas
  const config = await loadConfig(db);

  // Render esqueleto con selector
  container.innerHTML = buildSkeleton(periodo, config);

  // Conectar selector de período
  container.querySelectorAll('.ct-periodo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      periodo = btn.dataset.p;
      localStorage.setItem('ct:periodo', periodo);
      container.querySelectorAll('.ct-periodo-btn').forEach(b => b.classList.toggle('active', b.dataset.p === periodo));
      refreshDatos(container, db, periodo, config);
    });
  });

  // Conectar form de gasto
  setupGastoForm(container, db, periodo, config);

  // Conectar config de cuentas
  setupConfigCuentas(container, db, config);

  // Cargar datos iniciales
  await refreshDatos(container, db, periodo, config);
}

// ── Cargar / guardar config ───────────────────────────────────────────────────
async function loadConfig(db) {
  try {
    const snap = await getDoc(doc(db, 'control_config', 'settings'));
    if (snap.exists()) return snap.data();
  } catch (_) {}
  return { cuenta1_nombre: 'Cuenta 1', cuenta2_nombre: 'Cuenta 2' };
}

async function saveConfig(db, config) {
  await setDoc(doc(db, 'control_config', 'settings'), config);
}

// ── Cargar datos y renderizar secciones dinámicas ────────────────────────────
async function refreshDatos(container, db, periodo, config) {
  const { desde } = periodoRango(periodo);

  // Mostrar loading en zonas dinámicas
  const zonas = ['ct-stats', 'ct-cuentas', 'ct-gastos-lista'];
  zonas.forEach(id => {
    const el = container.querySelector(`#${id}`);
    if (el) el.innerHTML = `<div class="ct-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div>`;
  });

  // Cargar todo en paralelo — reutiliza caches del dashboard y ventas cuando ya están calientes
  const [ventas, itemsMap, catalogo, gastos] = await Promise.all([
    getCached('dashboard:ventas', async () => {
      const snap = await getDocs(query(collection(db, 'ventas'), orderBy('created_at', 'desc'), limit(500)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }, { ttl: 60 * 1000 }),
    getCached('ventas:items', async () => {
      const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('num_venta', 'asc'), limit(5000)));
      const map = {};
      snap.docs.forEach(d => {
        const data = d.data();
        const key = String(data.num_venta);
        if (!map[key]) map[key] = [];
        map[key].push({
          nombre: (data.producto || data.product_name || '').toUpperCase().trim(),
          cantidad: data.cantidad || data.quantity || 1,
        });
      });
      return map;
    }, { ttl: 5 * 60 * 1000, memOnly: true }),
    getCached('catalogo:all', async () => {
      const snap = await getDocs(collection(db, 'catalogo'));
      return snap.docs.map(d => d.data());
    }, { ttl: 10 * 60 * 1000, memOnly: true }),
    getCached(`ct:gastos:${desde.toISOString().slice(0,10)}`, () => loadGastos(db, desde), { ttl: 30 * 1000 }),
  ]);

  // Índice de costo por nombre de producto
  const costoPorNombre = {};
  catalogo.forEach(p => {
    const key = (p.nombre || '').toUpperCase().trim();
    if (key) costoPorNombre[key] = p.costo || 0;
  });

  // Filtrar ventas por período
  const ventasPeriodo = ventas.filter(v => {
    const fecha = parseArDate(v.created_at);
    return fecha >= desde;
  });

  // Calcular totales de ventas
  const ingresoTotal   = ventasPeriodo.reduce((s, v) => s + (v.total_amount || 0), 0);
  const efectivoTotal  = ventasPeriodo.filter(v => v.payment_type === 'cash').reduce((s, v) => s + (v.total_amount || 0), 0);
  const transTotal     = ingresoTotal - efectivoTotal;

  // Separar transferencia por cuenta (basado en campo cuenta_id o transfer_account)
  // Si no hay distinción guardada, todo transfer va a cuenta1
  let transCuenta1 = 0, transCuenta2 = 0;
  ventasPeriodo.filter(v => v.payment_type !== 'cash').forEach(v => {
    const cuenta = v.transfer_account || v.cuenta_id || 'cuenta1';
    if (cuenta === 'cuenta2') transCuenta2 += (v.total_amount || 0);
    else transCuenta1 += (v.total_amount || 0);
  });

  // Calcular costo de mercadería vendida (CMV)
  let cmv = 0;
  ventasPeriodo.forEach(v => {
    const key = String(v.sale_id || v.id);
    const items = itemsMap[key] || [];
    items.forEach(item => {
      const costo = costoPorNombre[item.nombre] || 0;
      cmv += costo * item.cantidad;
    });
  });

  // Ventas sin costo (para mostrar advertencia)
  let ventasSinCosto = 0;
  ventasPeriodo.forEach(v => {
    const key = String(v.sale_id || v.id);
    const items = itemsMap[key] || [];
    items.forEach(item => {
      if (!(costoPorNombre[item.nombre] || 0)) ventasSinCosto++;
    });
  });

  // Gastos por tipo
  const gastoEfectivo   = gastos.filter(g => g.tipo === 'efectivo').reduce((s, g) => s + (g.monto || 0), 0);
  const gastoCuenta1    = gastos.filter(g => g.tipo === 'cuenta1').reduce((s, g) => s + (g.monto || 0), 0);
  const gastoCuenta2    = gastos.filter(g => g.tipo === 'cuenta2').reduce((s, g) => s + (g.monto || 0), 0);
  const gastoTotal      = gastoEfectivo + gastoCuenta1 + gastoCuenta2;

  const gananciaBruta   = ingresoTotal - cmv;
  const gananciaNeta    = gananciaBruta - gastoTotal;

  // Neto por método
  const netoEfectivo  = efectivoTotal - gastoEfectivo;
  const netoCuenta1   = transCuenta1  - gastoCuenta1;
  const netoCuenta2   = transCuenta2  - gastoCuenta2;

  // ── Render stats ─────────────────────────────────────────────────────────
  const statsEl = container.querySelector('#ct-stats');
  if (statsEl) {
    const colorNeta = gananciaNeta >= 0 ? '#1b5e20' : '#b71c1c';
    const bgNeta    = gananciaNeta >= 0 ? '#f1f8f1' : '#fff5f5';
    const iconNeta  = gananciaNeta >= 0 ? 'trending_up' : 'trending_down';
    const margen    = ingresoTotal > 0 ? Math.round((gananciaBruta / ingresoTotal) * 100) : 0;
    const c1 = config.cuenta1_nombre || 'Cuenta 1';
    const c2 = config.cuenta2_nombre || 'Cuenta 2';

    statsEl.innerHTML = `
      <!-- Ecuación de resultado -->
      <div class="ct-ecuacion">
        <div class="ct-eq-bloque">
          <span class="material-icons ct-eq-icon" style="color:#1877f2">point_of_sale</span>
          <div class="ct-eq-num">$${fmt(ingresoTotal)}</div>
          <div class="ct-eq-lbl">Vendiste</div>
          <div class="ct-eq-sub">${ventasPeriodo.length} ventas</div>
        </div>
        <div class="ct-eq-op">−</div>
        <div class="ct-eq-bloque">
          <span class="material-icons ct-eq-icon" style="color:#e65100">inventory_2</span>
          <div class="ct-eq-num">$${fmt(cmv)}</div>
          <div class="ct-eq-lbl">Lo que te costó</div>
          <div class="ct-eq-sub">${ventasSinCosto > 0 ? `<span style="color:#e65100">${ventasSinCosto} sin costo cargado</span>` : `${margen}% de margen`}</div>
        </div>
        <div class="ct-eq-op">=</div>
        <div class="ct-eq-bloque">
          <span class="material-icons ct-eq-icon" style="color:#00695c">show_chart</span>
          <div class="ct-eq-num">$${fmt(gananciaBruta)}</div>
          <div class="ct-eq-lbl">Ganancia bruta</div>
          <div class="ct-eq-sub">&nbsp;</div>
        </div>
        <div class="ct-eq-op">−</div>
        <div class="ct-eq-bloque">
          <span class="material-icons ct-eq-icon" style="color:#c62828">receipt_long</span>
          <div class="ct-eq-num">$${fmt(gastoTotal)}</div>
          <div class="ct-eq-lbl">Gastos / Pagos</div>
          <div class="ct-eq-sub">${gastos.length} registros</div>
        </div>
        <div class="ct-eq-op">=</div>
        <div class="ct-eq-bloque ct-eq-neta" style="background:${bgNeta};border-color:${colorNeta}">
          <span class="material-icons ct-eq-icon" style="color:${colorNeta}">${iconNeta}</span>
          <div class="ct-eq-num" style="color:${colorNeta};font-size:26px;font-weight:900">$${fmt(gananciaNeta)}</div>
          <div class="ct-eq-lbl" style="color:${colorNeta};font-weight:700">Ganancia neta</div>
          <div class="ct-eq-sub">&nbsp;</div>
        </div>
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
  }

  // ct-cuentas ya no se usa (integrado en ct-stats)
  const cuentasEl = container.querySelector('#ct-cuentas');
  if (cuentasEl) cuentasEl.innerHTML = '';

  // ── Render lista de gastos ────────────────────────────────────────────────
  const gastosEl = container.querySelector('#ct-gastos-lista');
  if (gastosEl) {
    if (gastos.length === 0) {
      gastosEl.innerHTML = `<div class="empty-state" style="padding:32px"><span class="material-icons">receipt_long</span><p>Sin gastos registrados en este período</p></div>`;
    } else {
      const c1 = config.cuenta1_nombre || 'Cuenta 1';
      const c2 = config.cuenta2_nombre || 'Cuenta 2';
      const tipoLabel = { efectivo: '💵 Efectivo', cuenta1: `🏦 ${c1}`, cuenta2: `🏦 ${c2}` };
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

      // Eliminar gasto
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

// ── Cargar gastos del período ─────────────────────────────────────────────────
async function loadGastos(db, desde) {
  // Los gastos tienen campo "fecha" (YYYY-MM-DD string) y "created_at" Timestamp
  // Filtro por fecha string en cliente (no requiere índice compuesto)
  const snap = await getDocs(query(collection(db, 'gastos'), orderBy('created_at', 'desc')));
  const desdeStr = desde.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  return snap.docs
    .map(d => ({ _id: d.id, ...d.data() }))
    .filter(g => (g.fecha || '') >= desdeStr);
}

// ── Form agregar gasto ────────────────────────────────────────────────────────
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
      btn.textContent = 'Registrar gasto';
    }
  });
}

// ── Config de nombres de cuentas ──────────────────────────────────────────────
function setupConfigCuentas(container, db, config) {
  const btnConfig = container.querySelector('#ct-config-btn');
  const formConfig = container.querySelector('#ct-config-form');
  if (!btnConfig || !formConfig) return;

  btnConfig.addEventListener('click', () => {
    formConfig.style.display = formConfig.style.display === 'none' ? 'flex' : 'none';
  });

  formConfig.addEventListener('submit', async e => {
    e.preventDefault();
    const c1 = formConfig.querySelector('#cfg-cuenta1').value.trim() || 'Cuenta 1';
    const c2 = formConfig.querySelector('#cfg-cuenta2').value.trim() || 'Cuenta 2';
    const btn = formConfig.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Guardando...';

    try {
      const newConfig = { ...config, cuenta1_nombre: c1, cuenta2_nombre: c2 };
      await saveConfig(db, newConfig);
      Object.assign(config, newConfig);
      formConfig.style.display = 'none';
      // Recargar página para reflejar nuevos nombres
      location.reload();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Guardar';
    }
  });
}

// ── HTML esqueleto ────────────────────────────────────────────────────────────
function buildSkeleton(periodo, config) {
  const c1 = config.cuenta1_nombre || 'Cuenta 1';
  const c2 = config.cuenta2_nombre || 'Cuenta 2';
  const periodos = ['hoy', 'semana', 'mes'];
  const labels   = { hoy: 'Hoy', semana: '7 días', mes: 'Este mes' };

  return `
    <div class="ct-wrap">

      <!-- Período -->
      <div class="ct-toolbar">
        <div class="ct-periodo">
          ${periodos.map(p => `<button class="ct-periodo-btn${p===periodo?' active':''}" data-p="${p}">${labels[p]}</button>`).join('')}
        </div>
        <button id="ct-config-btn" class="ct-config-btn" title="Configurar cuentas">
          <span class="material-icons" style="font-size:18px">settings</span> Configurar cuentas
        </button>
      </div>

      <!-- Config form (oculto por defecto) -->
      <form id="ct-config-form" style="display:none;gap:10px;align-items:flex-end;flex-wrap:wrap;background:var(--card-bg);padding:16px;border-radius:var(--radius);margin-bottom:16px;box-shadow:var(--shadow)">
        <div>
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Nombre Cuenta 1 (transferencia)</label>
          <input id="cfg-cuenta1" type="text" value="${c1}" placeholder="Ej: Mercado Pago" style="padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;width:200px" />
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Nombre Cuenta 2 (transferencia)</label>
          <input id="cfg-cuenta2" type="text" value="${c2}" placeholder="Ej: Banco Galicia" style="padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;width:200px" />
        </div>
        <button type="submit" class="btn-primary" style="padding:8px 20px;background:var(--primary);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px">Guardar</button>
      </form>

      <!-- Stats + cuentas (dinámico) -->
      <div id="ct-stats">
        <div class="ct-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div>
      </div>
      <div id="ct-cuentas"></div>

      <!-- Formulario de gasto -->
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

      <!-- Lista gastos (dinámico) -->
      <div class="ct-gastos-card">
        <div class="ct-section-title">
          <span class="material-icons" style="font-size:16px;vertical-align:middle">receipt_long</span>
          Gastos anotados
        </div>
        <div id="ct-gastos-lista">
          <div class="ct-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div>
        </div>
      </div>

    </div>
  `;
}
