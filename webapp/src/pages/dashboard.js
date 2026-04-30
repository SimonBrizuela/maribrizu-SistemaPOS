import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore';
import { openSaleModal } from '../components/modal.js';
import { getCached } from '../cache.js';
import { getFechaInicioDate, isVentaVarios2, isItemVarios2, fechaDMYtoYMD } from '../config.js';
import { getSaleNumberMap, displayNumForVenta } from '../sale_numbers.js';

// ──────────────────────────────────────────────────────────────────────────────
// CARGA DINÁMICA DE CHART.JS (vía CDN, una sola vez)
// ──────────────────────────────────────────────────────────────────────────────
let _chartLoader = null;
function loadChartJs() {
  if (window.Chart) return Promise.resolve(window.Chart);
  if (_chartLoader) return _chartLoader;
  _chartLoader = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
    s.async = true;
    s.onload = () => resolve(window.Chart);
    s.onerror = () => reject(new Error('No se pudo cargar Chart.js'));
    document.head.appendChild(s);
  });
  return _chartLoader;
}

// Mantener referencias para destruir cuando se re-renderice (evita leaks)
const _chartRefs = new Map();
function destroyAllCharts() {
  _chartRefs.forEach(ch => { try { ch.destroy(); } catch (_) {} });
  _chartRefs.clear();
}

// ──────────────────────────────────────────────────────────────────────────────
// COLORES (usa la paleta de la marca)
// ──────────────────────────────────────────────────────────────────────────────
const COLORS = {
  primary: '#7b3fa6',
  primaryLight: '#b07acc',
  green: '#2e7d32',
  greenLight: '#8ec63f',
  orange: '#f39c12',
  orangeDark: '#e65100',
  cyan: '#29abca',
  red: '#e63946',
  blue: '#1877f2',
  purple: '#6a1b9a',
  teal: '#00695c',
  gray: '#90a4ae',
};
const PALETTE = [
  COLORS.primary, COLORS.greenLight, COLORS.orange,
  COLORS.cyan, COLORS.red, COLORS.green, COLORS.blue,
  COLORS.purple, COLORS.teal, '#ef6c00', '#827717', '#5d4037',
];

// ──────────────────────────────────────────────────────────────────────────────
// RENDER PRINCIPAL
// ──────────────────────────────────────────────────────────────────────────────
export async function renderDashboard(container, db) {
  destroyAllCharts();

  const hoyStr = todayAR();
  const hoy = new Date(hoyStr + 'T00:00:00-03:00');
  const ayer = new Date(hoy); ayer.setDate(ayer.getDate() - 1);
  const inicioSemana = new Date(hoy); inicioSemana.setDate(inicioSemana.getDate() - 6);
  const inicioMes = new Date(hoyStr.slice(0, 7) + '-01T00:00:00-03:00');
  const inicioMesAnt = new Date(inicioMes); inicioMesAnt.setMonth(inicioMesAnt.getMonth() - 1);
  const finMesAnt = new Date(inicioMes); finMesAnt.setSeconds(finMesAnt.getSeconds() - 1);
  const hace30 = new Date(hoy); hace30.setDate(hace30.getDate() - 29);

  const fechaInicio = await getFechaInicioDate(db);
  const fechaInicioStr = fechaInicio.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

  // ── Lanzar Chart.js en paralelo con la carga de datos ──
  const chartPromise = loadChartJs().catch(() => null);

  const [ventasRaw, itemsRaw, catalogo, historialRaw, saleNumMap] = await Promise.all([
    // Ventas: TTL 1 min
    getCached('dashboard:ventas', async () => {
      const snap = await getDocs(query(collection(db, 'ventas'), orderBy('created_at', 'desc'), limit(1500)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }, { ttl: 60 * 1000 }),
    // Items por día (para análisis por producto / categoría / costos)
    getCached('dashboard:items_full', async () => {
      const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha', 'desc'), limit(8000)));
      return snap.docs.map(d => d.data());
    }, { ttl: 5 * 60 * 1000, memOnly: true }),
    // Catálogo completo
    getCached('catalogo:all', async () => {
      const snap = await getDocs(collection(db, 'catalogo'));
      return snap.docs.map(d => ({ doc_id: d.id, ...d.data() }));
    }, { ttl: 10 * 60 * 1000, memOnly: true }),
    // Historial diario (para legacy bar chart si chart.js falla)
    getCached('dashboard:historial', async () => {
      const snap = await getDocs(query(collection(db, 'historial_diario'), orderBy('fecha', 'desc'), limit(60)));
      return snap.docs.map(d => d.data());
    }, { ttl: 3 * 60 * 1000 }),
    getSaleNumberMap(db),
  ]);

  // ── Filtrar fuentes ──
  const ventas = ventasRaw.filter(v => {
    if (v.deleted === true) return false;
    if (isVentaVarios2(v)) return false;
    const dt = parseArDate(v.created_at);
    return dt >= fechaInicio;
  });
  const items = itemsRaw.filter(i => {
    if (i.deleted === true) return false;
    if (isItemVarios2(i)) return false;
    return fechaDMYtoYMD(i.fecha) >= fechaInicioStr;
  });

  // ── Índice catálogo por nombre normalizado (para costos) ──
  const catPorNombre = {};
  catalogo.forEach(p => {
    const k = (p.nombre || '').toUpperCase().trim();
    if (k) catPorNombre[k] = p;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // KPIs
  // ──────────────────────────────────────────────────────────────────────────
  const ventasHoy = ventas.filter(v => parseArDate(v.created_at) >= hoy);
  const ventasAyer = ventas.filter(v => {
    const dt = parseArDate(v.created_at);
    return dt >= ayer && dt < hoy;
  });
  const ventasSemana = ventas.filter(v => parseArDate(v.created_at) >= inicioSemana);
  const ventasMes = ventas.filter(v => parseArDate(v.created_at) >= inicioMes);
  const ventasMesAnt = ventas.filter(v => {
    const dt = parseArDate(v.created_at);
    return dt >= inicioMesAnt && dt < inicioMes;
  });

  const totalHoy = sum(ventasHoy, 'total_amount');
  const totalAyer = sum(ventasAyer, 'total_amount');
  const totalSemana = sum(ventasSemana, 'total_amount');
  const totalMes = sum(ventasMes, 'total_amount');
  const totalMesAnt = sum(ventasMesAnt, 'total_amount');

  const efectivoHoy = sum(ventasHoy.filter(v => v.payment_type === 'cash'), 'total_amount');
  const transferHoy = totalHoy - efectivoHoy;

  const ticketProm = ventasMes.length > 0 ? totalMes / ventasMes.length : 0;
  const ticketPromAnt = ventasMesAnt.length > 0 ? totalMesAnt / ventasMesAnt.length : 0;

  // Variaciones (null si no hay base anterior para comparar)
  // Hoy vs misma hora ayer: comparar vs lo que ayer había acumulado a esta hora
  const ahora = new Date();
  const horaAhora = parseInt(ahora.toLocaleTimeString('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }).slice(0, 2));
  const minAhora = parseInt(ahora.toLocaleTimeString('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', minute: '2-digit', hour12: false }).slice(3, 5));
  const ayerHasta = new Date(ayer);
  ayerHasta.setHours(horaAhora, minAhora, 0, 0);
  const totalAyerHastaAhora = sum(ventas.filter(v => {
    const dt = parseArDate(v.created_at);
    return dt >= ayer && dt < ayerHasta;
  }), 'total_amount');
  const deltaHoyVsAyer = totalAyerHastaAhora > 0 ? ((totalHoy - totalAyerHastaAhora) / totalAyerHastaAhora) * 100 : null;
  const deltaMes = totalMesAnt > 0 ? ((totalMes - totalMesAnt) / totalMesAnt) * 100 : null;
  const deltaTicket = ticketPromAnt > 0 ? ((ticketProm - ticketPromAnt) / ticketPromAnt) * 100 : null;

  // Forecast fin de mes: proyección lineal según ritmo del mes hasta hoy
  const diasMesTotal = lastDayOfMonth(inicioMes);
  const diasTranscurridosMes = totalDiasDesde(inicioMes, hoy) + 1;
  const ritmoDiarioMes = diasTranscurridosMes > 0 ? totalMes / diasTranscurridosMes : 0;
  const forecastMes = Math.round(ritmoDiarioMes * diasMesTotal);
  const deltaForecast = totalMesAnt > 0 ? ((forecastMes - totalMesAnt) / totalMesAnt) * 100 : null;

  // Stock
  const stockCritico = catalogo.filter(p => (p.stock || 0) > 0 && (p.stock || 0) <= 3).length;
  const stockAgotado = catalogo.filter(p => (p.stock || 0) === 0).length;

  // ── Ganancia / margen estimado (mes actual) ──
  const itemsMes = items.filter(i => fechaDMYtoYMD(i.fecha) >= isoDate(inicioMes));
  let ingresoConCostoMes = 0, cmvMes = 0, ingresoSinCostoMes = 0;
  itemsMes.forEach(it => {
    const nombre = (it.producto || it.product_name || '').toUpperCase().trim();
    const cat = catPorNombre[nombre];
    const sub = Number(it.subtotal || 0);
    const cant = Number(it.cantidad || it.quantity || 0);
    const costoUnit = cat?.costo || 0;
    if (costoUnit > 0) {
      ingresoConCostoMes += sub;
      cmvMes += costoUnit * cant;
    } else {
      ingresoSinCostoMes += sub;
    }
  });
  const gananciaBrutaMes = ingresoConCostoMes - cmvMes;
  const margenPct = ingresoConCostoMes > 0 ? (gananciaBrutaMes / ingresoConCostoMes) * 100 : 0;
  const pctConCosto = (ingresoConCostoMes + ingresoSinCostoMes) > 0
    ? (ingresoConCostoMes / (ingresoConCostoMes + ingresoSinCostoMes)) * 100 : 0;

  // ──────────────────────────────────────────────────────────────────────────
  // SERIES PARA CHARTS
  // ──────────────────────────────────────────────────────────────────────────

  // Tendencia 30 días — línea
  const labels30 = [];
  const totales30 = [];
  const counts30 = [];
  const totalesPorDia = {};
  const countsPorDia = {};
  ventas.forEach(v => {
    const dt = parseArDate(v.created_at);
    if (dt < hace30) return;
    const k = isoDate(dt);
    totalesPorDia[k] = (totalesPorDia[k] || 0) + (v.total_amount || 0);
    countsPorDia[k] = (countsPorDia[k] || 0) + 1;
  });
  for (let i = 29; i >= 0; i--) {
    const d = new Date(hoy); d.setDate(d.getDate() - i);
    const k = isoDate(d);
    labels30.push(d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }));
    totales30.push(Math.round(totalesPorDia[k] || 0));
    counts30.push(countsPorDia[k] || 0);
  }

  // Distribución por método de pago (mes)
  const efMes = sum(ventasMes.filter(v => v.payment_type === 'cash'), 'total_amount');
  const trMes = totalMes - efMes;

  // Distribución por categoría/rubro (mes en curso)
  const porCategoria = {};
  itemsMes.forEach(it => {
    const cat = (it.categoria || 'Sin categoría').trim() || 'Sin categoría';
    if (!porCategoria[cat]) porCategoria[cat] = { ingreso: 0, unidades: 0 };
    porCategoria[cat].ingreso += Number(it.subtotal || 0);
    porCategoria[cat].unidades += Number(it.cantidad || it.quantity || 0);
  });
  const categoriasOrden = Object.entries(porCategoria)
    .sort((a, b) => b[1].ingreso - a[1].ingreso)
    .slice(0, 8);

  // Distribución por hora del día (último mes)
  const porHora = Array(24).fill(0);
  ventasMes.forEach(v => {
    const dt = parseArDate(v.created_at);
    if (isNaN(dt)) return;
    // Convertimos a hora Argentina explícitamente
    const horaAR = parseInt(dt.toLocaleTimeString('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }).slice(0, 2));
    if (!isNaN(horaAR)) porHora[horaAR] += v.total_amount || 0;
  });

  // Día de la semana (último mes) — Lun, Mar, Mié, Jue, Vie, Sáb, Dom
  const diaSemanaLabels = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const porDiaSemana = Array(7).fill(0);
  const countsDiaSemana = Array(7).fill(0);
  ventasMes.forEach(v => {
    const dt = parseArDate(v.created_at);
    if (isNaN(dt)) return;
    const dow = dt.getDay(); // 0=Dom ... 6=Sáb
    const idx = dow === 0 ? 6 : dow - 1;
    porDiaSemana[idx] += v.total_amount || 0;
    countsDiaSemana[idx]++;
  });

  // Top 10 productos (mes)
  const porProducto = {};
  itemsMes.forEach(it => {
    const nombre = (it.producto || it.product_name || '-').trim();
    if (!nombre || nombre === '-') return;
    if (!porProducto[nombre]) porProducto[nombre] = { unidades: 0, ingreso: 0 };
    porProducto[nombre].unidades += Number(it.cantidad || it.quantity || 0);
    porProducto[nombre].ingreso += Number(it.subtotal || 0);
  });
  const top10Productos = Object.entries(porProducto)
    .sort((a, b) => b[1].ingreso - a[1].ingreso)
    .slice(0, 10);

  // Comparativa Mes Actual vs Mes Anterior por día
  const diasMesActual = totalDiasDesde(inicioMes, hoy) + 1;
  const seriesMesAct = Array(31).fill(null);
  const seriesMesAnt = Array(31).fill(null);
  ventasMes.forEach(v => {
    const dt = parseArDate(v.created_at);
    const d = parseInt(dt.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).slice(8, 10));
    seriesMesAct[d - 1] = (seriesMesAct[d - 1] || 0) + (v.total_amount || 0);
  });
  ventasMesAnt.forEach(v => {
    const dt = parseArDate(v.created_at);
    const d = parseInt(dt.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).slice(8, 10));
    seriesMesAnt[d - 1] = (seriesMesAnt[d - 1] || 0) + (v.total_amount || 0);
  });
  // Llenar mes actual con ceros sólo hasta el día de hoy (para que el gráfico no caiga)
  for (let i = 0; i < 31; i++) {
    if (i + 1 <= diasMesActual && seriesMesAct[i] === null) seriesMesAct[i] = 0;
  }
  // Mes anterior: llenar con 0 todos los días que existieron
  const diasMesAnt = lastDayOfMonth(inicioMesAnt);
  for (let i = 0; i < diasMesAnt; i++) {
    if (seriesMesAnt[i] === null) seriesMesAnt[i] = 0;
  }

  // Top cajeros (mes actual)
  const porCajero = {};
  ventasMes.forEach(v => {
    const c = v.cajero || v.username || v.user_id || '—';
    if (!porCajero[c]) porCajero[c] = { ingreso: 0, ventas: 0 };
    porCajero[c].ingreso += v.total_amount || 0;
    porCajero[c].ventas++;
  });
  const topCajeros = Object.entries(porCajero)
    .sort((a, b) => b[1].ingreso - a[1].ingreso)
    .slice(0, 6);

  // Heatmap semanal hora × día (mes en curso)
  const heatmapData = Array.from({ length: 7 }, () => Array(24).fill(0));
  ventasMes.forEach(v => {
    const dt = parseArDate(v.created_at);
    if (isNaN(dt)) return;
    const dow = dt.getDay();
    const di = dow === 0 ? 6 : dow - 1;
    const hh = parseInt(dt.toLocaleTimeString('en-GB', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }).slice(0, 2));
    if (!isNaN(hh)) heatmapData[di][hh] += v.total_amount || 0;
  });
  const heatmapMax = Math.max(1, ...heatmapData.flat());
  // Detectar rango de horas con actividad para no mostrar 24 columnas vacías
  let heatHoraMin = 23, heatHoraMax = 0;
  for (let h = 0; h < 24; h++) {
    const colSum = heatmapData.reduce((s, row) => s + row[h], 0);
    if (colSum > 0) { if (h < heatHoraMin) heatHoraMin = h; if (h > heatHoraMax) heatHoraMax = h; }
  }
  if (heatHoraMin > heatHoraMax) { heatHoraMin = 8; heatHoraMax = 21; }

  // Margen por categoría (mes)
  const margenPorCategoria = {};
  itemsMes.forEach(it => {
    const cat = (it.categoria || 'Sin categoría').trim() || 'Sin categoría';
    const nombre = (it.producto || it.product_name || '').toUpperCase().trim();
    const prod = catPorNombre[nombre];
    const sub = Number(it.subtotal || 0);
    const cant = Number(it.cantidad || it.quantity || 0);
    const costoUnit = prod?.costo || 0;
    if (!margenPorCategoria[cat]) margenPorCategoria[cat] = { ingreso: 0, costo: 0 };
    if (costoUnit > 0) {
      margenPorCategoria[cat].ingreso += sub;
      margenPorCategoria[cat].costo += costoUnit * cant;
    }
  });
  const categoriasMargen = Object.entries(margenPorCategoria)
    .filter(([_, v]) => v.ingreso > 0)
    .map(([cat, v]) => ({ cat, margen: ((v.ingreso - v.costo) / v.ingreso) * 100, ingreso: v.ingreso }))
    .sort((a, b) => b.ingreso - a.ingreso)
    .slice(0, 8);

  // Días de cobertura de stock: top 10 productos más urgentes
  // velocidadDia ya se calcula en el bloque de recomendaciones — replicamos acá
  // antes para tenerlo disponible (usa items30 / ventasPorProducto30 que se
  // computa abajo, así que reordeno: muevo el cálculo de items30/ventasPorProducto30
  // antes de cobertura).
  const items30 = items.filter(i => fechaDMYtoYMD(i.fecha) >= isoDate(hace30));
  const ventasPorProducto30 = {};
  items30.forEach(it => {
    const k = (it.producto || it.product_name || '').toUpperCase().trim();
    if (!k) return;
    if (!ventasPorProducto30[k]) ventasPorProducto30[k] = { unidades: 0, ingreso: 0 };
    ventasPorProducto30[k].unidades += Number(it.cantidad || it.quantity || 0);
    ventasPorProducto30[k].ingreso += Number(it.subtotal || 0);
  });
  const coberturaUrgente = catalogo.map(p => {
    const k = (p.nombre || '').toUpperCase().trim();
    const v30 = ventasPorProducto30[k]?.unidades || 0;
    const velocidadDia = v30 / 30;
    const stock = Number(p.stock || 0);
    const dias = velocidadDia > 0 ? stock / velocidadDia : Infinity;
    return { nombre: p.nombre, stock, velocidadDia: round2(velocidadDia), dias: Math.round(dias), v30, rubro: p.rubro || p.categoria || '—' };
  }).filter(p => p.velocidadDia > 0 && p.dias <= 30 && p.stock > 0)
    .sort((a, b) => a.dias - b.dias)
    .slice(0, 10);

  // Productos sin rotación: stock > 0 y sin venta en >= 30 días
  const ultimaVentaPorProducto = {};
  items.forEach(it => {
    const k = (it.producto || it.product_name || '').toUpperCase().trim();
    if (!k) return;
    const fIso = fechaDMYtoYMD(it.fecha);
    if (!ultimaVentaPorProducto[k] || fIso > ultimaVentaPorProducto[k]) {
      ultimaVentaPorProducto[k] = fIso;
    }
  });
  const sinRotacion = catalogo.map(p => {
    const k = (p.nombre || '').toUpperCase().trim();
    const stock = Number(p.stock || 0);
    if (!k || stock <= 0) return null;
    const ultima = ultimaVentaPorProducto[k];
    let dias;
    if (!ultima) {
      dias = 999;
    } else {
      const fechaUlt = new Date(ultima + 'T00:00:00-03:00');
      dias = totalDiasDesde(fechaUlt, hoy);
    }
    const precio = Number(p.precio_venta || p.precio || 0);
    const costo = Number(p.costo || 0);
    return {
      nombre: p.nombre,
      rubro: p.rubro || p.categoria || '—',
      stock,
      dias,
      ultima: ultima || null,
      capitalParado: stock * (costo > 0 ? costo : precio * 0.6),
    };
  }).filter(p => p && p.dias >= 30)
    .sort((a, b) => b.capitalParado - a.capitalParado)
    .slice(0, 8);

  // ──────────────────────────────────────────────────────────────────────────
  // RECOMENDACIONES INTELIGENTES
  // ──────────────────────────────────────────────────────────────────────────
  // items30 / ventasPorProducto30 ya calculados arriba (se usan en cobertura también)

  // 1) Reabastecer urgente: stock bajo + alta velocidad
  const reabastecer = [];
  // 2) Estrellas: alto ingreso + buen margen + buena rotación
  const estrellas = [];
  // 3) Lentos: alto stock, baja rotación
  const lentos = [];
  // 4) Promocionar: buen margen, baja rotación
  const promocionar = [];

  catalogo.forEach(p => {
    const nombreKey = (p.nombre || '').toUpperCase().trim();
    if (!nombreKey) return;
    const stock = Number(p.stock || 0);
    const costo = Number(p.costo || 0);
    const precio = Number(p.precio_venta || p.precio || 0);
    const v = ventasPorProducto30[nombreKey] || { unidades: 0, ingreso: 0 };
    const velocidadDia = v.unidades / 30;
    const margenPctP = (precio > 0 && costo > 0) ? ((precio - costo) / precio) * 100 : null;
    const diasRest = velocidadDia > 0 ? stock / velocidadDia : Infinity;

    // Reabastecer: vendió ≥3 últimos 30d y le quedan ≤14 días, o stock <=3 con cualquier venta
    if (v.unidades >= 3 && diasRest <= 14) {
      reabastecer.push({
        nombre: p.nombre,
        rubro: p.rubro || p.categoria || '—',
        stock,
        vendidos30d: v.unidades,
        velocidadDia: round2(velocidadDia),
        diasRestantes: Math.round(diasRest),
        ingreso30d: v.ingreso,
        sugerirComprar: Math.max(Math.ceil(velocidadDia * 30) - stock, 0),
        urgencia: diasRest <= 5 ? 'alta' : diasRest <= 10 ? 'media' : 'baja',
      });
    } else if (stock > 0 && stock <= 3 && v.unidades >= 1) {
      reabastecer.push({
        nombre: p.nombre,
        rubro: p.rubro || p.categoria || '—',
        stock,
        vendidos30d: v.unidades,
        velocidadDia: round2(velocidadDia),
        diasRestantes: Math.round(diasRest),
        ingreso30d: v.ingreso,
        sugerirComprar: Math.max(Math.ceil(velocidadDia * 30), 5) - stock,
        urgencia: 'alta',
      });
    }

    // Estrellas: ingreso top + buen margen
    if (v.unidades >= 5 && v.ingreso > 0) {
      estrellas.push({
        nombre: p.nombre,
        rubro: p.rubro || p.categoria || '—',
        stock,
        vendidos30d: v.unidades,
        ingreso30d: v.ingreso,
        margen: margenPctP,
      });
    }

    // Lentos: stock >= 8 y vendió <=1 en 30 días
    if (stock >= 8 && v.unidades <= 1) {
      lentos.push({
        nombre: p.nombre,
        rubro: p.rubro || p.categoria || '—',
        stock,
        vendidos30d: v.unidades,
        precio,
        capitalParado: stock * (costo > 0 ? costo : precio * 0.6),
      });
    }

    // Promocionar: margen alto, rotación media-baja
    if (margenPctP !== null && margenPctP >= 35 && v.unidades >= 1 && v.unidades <= 6 && stock >= 4) {
      promocionar.push({
        nombre: p.nombre,
        rubro: p.rubro || p.categoria || '—',
        stock,
        vendidos30d: v.unidades,
        margen: margenPctP,
        precio,
      });
    }
  });

  reabastecer.sort((a, b) => a.diasRestantes - b.diasRestantes);
  estrellas.sort((a, b) => b.ingreso30d - a.ingreso30d);
  lentos.sort((a, b) => b.capitalParado - a.capitalParado);
  promocionar.sort((a, b) => b.margen - a.margen);

  // Mejor hora y mejor día (insights)
  let mejorHora = -1, mejorHoraVal = 0;
  porHora.forEach((v, h) => { if (v > mejorHoraVal) { mejorHoraVal = v; mejorHora = h; } });
  let mejorDia = -1, mejorDiaVal = 0;
  porDiaSemana.forEach((v, i) => { if (v > mejorDiaVal) { mejorDiaVal = v; mejorDia = i; } });

  // Mejor categoría
  const mejorCategoria = categoriasOrden[0]?.[0] || '—';
  const mejorCategoriaIngreso = categoriasOrden[0]?.[1].ingreso || 0;

  // ──────────────────────────────────────────────────────────────────────────
  // RENDER HTML
  // ──────────────────────────────────────────────────────────────────────────
  container.innerHTML = `
    <!-- KPIs principales -->
    <div class="dash-kpis">
      ${kpiCard('Ventas Hoy', '$' + fmt(totalHoy), `${ventasHoy.length} ventas`, 'today', 'kpi-blue', deltaHoyVsAyer, 'vs misma hora ayer')}
      ${kpiCard('Efectivo Hoy', '$' + fmt(efectivoHoy), pctTexto(efectivoHoy, totalHoy) + ' del día', 'payments', 'kpi-green')}
      ${kpiCard('Transferencia Hoy', '$' + fmt(transferHoy), pctTexto(transferHoy, totalHoy) + ' del día', 'swap_horiz', 'kpi-purple')}
      ${kpiCard('Esta Semana', '$' + fmt(totalSemana), `${ventasSemana.length} ventas`, 'date_range', 'kpi-cyan')}
      ${kpiCard('Mes en Curso', '$' + fmt(totalMes), `${ventasMes.length} ventas`, 'calendar_month', 'kpi-orange', deltaMes, 'vs mes anterior')}
      ${kpiCard('Forecast Mes', '$' + fmt(forecastMes), `proyección día ${diasMesTotal}`, 'insights', 'kpi-purple', deltaForecast, 'vs mes ant.')}
      ${kpiCard('Ticket Promedio', '$' + fmt(ticketProm), 'mes en curso', 'receipt_long', 'kpi-teal', deltaTicket, 'vs mes ant.')}
      ${kpiCard('Ganancia Bruta', '$' + fmt(gananciaBrutaMes), `${margenPct.toFixed(1)}% margen`, 'trending_up', 'kpi-success')}
      ${kpiCard('Stock Crítico', String(stockCritico), `${stockAgotado} agotados · ${catalogo.length} prods`, 'warning', 'kpi-red')}
    </div>

    <!-- Resumen visual del negocio -->
    <div class="insight-bar">
      <div class="insight-item"><span class="insight-icon" style="background:${COLORS.cyan}"><span class="material-icons">schedule</span></span>
        <div><div class="insight-label">Mejor hora</div><div class="insight-val">${mejorHora >= 0 ? formatHora(mejorHora) : '—'}</div></div>
      </div>
      <div class="insight-item"><span class="insight-icon" style="background:${COLORS.orange}"><span class="material-icons">event</span></span>
        <div><div class="insight-label">Mejor día</div><div class="insight-val">${mejorDia >= 0 ? diaSemanaLabels[mejorDia] : '—'}</div></div>
      </div>
      <div class="insight-item"><span class="insight-icon" style="background:${COLORS.purple}"><span class="material-icons">category</span></span>
        <div><div class="insight-label">Top categoría</div><div class="insight-val" title="${escapeHtml(mejorCategoria)}">${escapeHtml(mejorCategoria.length > 18 ? mejorCategoria.slice(0, 17) + '…' : mejorCategoria)}</div></div>
      </div>
      <div class="insight-item"><span class="insight-icon" style="background:${COLORS.green}"><span class="material-icons">payments</span></span>
        <div><div class="insight-label">% con costo conocido</div><div class="insight-val">${pctConCosto.toFixed(0)}%</div></div>
      </div>
      <div class="insight-item"><span class="insight-icon" style="background:${COLORS.red}"><span class="material-icons">inventory_2</span></span>
        <div><div class="insight-label">A reabastecer</div><div class="insight-val">${reabastecer.length}</div></div>
      </div>
      <div class="insight-item"><span class="insight-icon" style="background:${COLORS.greenLight}"><span class="material-icons">star</span></span>
        <div><div class="insight-label">Estrellas activas</div><div class="insight-val">${Math.min(estrellas.length, 99)}</div></div>
      </div>
    </div>

    <!-- Charts row 1: tendencia y métodos de pago -->
    <div class="dash-charts dash-charts-2-1">
      <div class="chart-card">
        <div class="chart-card-header">
          <h3>📈 Tendencia · Últimos 30 días</h3>
          <span class="chart-sub">Ingresos diarios (línea) y nº de transacciones (barras)</span>
        </div>
        <div class="chart-canvas-wrap" style="height:300px"><canvas id="chTendencia"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-header"><h3>💳 Método de Pago · Mes</h3></div>
        <div class="chart-canvas-wrap" style="height:300px"><canvas id="chPago"></canvas></div>
      </div>
    </div>

    <!-- Charts row 2: hora del día + día de la semana -->
    <div class="dash-charts dash-charts-2">
      <div class="chart-card">
        <div class="chart-card-header"><h3>🕐 Ventas por Hora · Mes</h3><span class="chart-sub">Cuándo se vende más</span></div>
        <div class="chart-canvas-wrap" style="height:260px"><canvas id="chHora"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-header"><h3>📅 Por Día de la Semana · Mes</h3></div>
        <div class="chart-canvas-wrap" style="height:260px"><canvas id="chDia"></canvas></div>
      </div>
    </div>

    <!-- Charts row 3: top productos + categorías -->
    <div class="dash-charts dash-charts-2">
      <div class="chart-card">
        <div class="chart-card-header"><h3>🏆 Top 10 Productos por Ingresos · Mes</h3></div>
        <div class="chart-canvas-wrap" style="height:340px"><canvas id="chTopProd"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-header"><h3>📚 Ventas por Categoría · Mes</h3></div>
        <div class="chart-canvas-wrap" style="height:340px"><canvas id="chCategoria"></canvas></div>
      </div>
    </div>

    <!-- Charts row 4: comparativa mes vs mes + top cajeros -->
    <div class="dash-charts dash-charts-2-1">
      <div class="chart-card">
        <div class="chart-card-header"><h3>📊 Mes Actual vs Mes Anterior</h3><span class="chart-sub">Comparación día por día</span></div>
        <div class="chart-canvas-wrap" style="height:300px"><canvas id="chMesVsMes"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-header"><h3>👤 Top Cajeros · Mes</h3></div>
        <div class="chart-canvas-wrap" style="height:300px"><canvas id="chCajeros"></canvas></div>
      </div>
    </div>

    <!-- Charts row 5: ganancia y composición -->
    <div class="dash-charts dash-charts-2">
      <div class="chart-card">
        <div class="chart-card-header"><h3>💰 Ingresos · Costo · Ganancia (mes)</h3></div>
        <div class="chart-canvas-wrap" style="height:280px"><canvas id="chGanancia"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-header"><h3>📦 Stock por Estado</h3></div>
        <div class="chart-canvas-wrap" style="height:280px"><canvas id="chStock"></canvas></div>
      </div>
    </div>

    <!-- Heatmap semanal hora × día -->
    <div class="chart-card" style="margin-bottom:18px">
      <div class="chart-card-header">
        <h3>🔥 Mapa de Calor · Hora × Día (mes)</h3>
        <span class="chart-sub">Cuándo se concentra la actividad</span>
      </div>
      ${renderHeatmap(heatmapData, heatmapMax, heatHoraMin, heatHoraMax, diaSemanaLabels)}
    </div>

    <!-- Charts row 6: margen por categoría + cobertura de stock -->
    <div class="dash-charts dash-charts-2">
      <div class="chart-card">
        <div class="chart-card-header">
          <h3>💹 Margen por Categoría · Mes</h3>
          <span class="chart-sub">% sobre ingresos con costo cargado</span>
        </div>
        <div class="chart-canvas-wrap" style="height:340px"><canvas id="chMargenCat"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-header">
          <h3>⏳ Cobertura de Stock · Top 10 más urgentes</h3>
          <span class="chart-sub">Días que duraría el stock al ritmo actual</span>
        </div>
        ${renderCobertura(coberturaUrgente)}
      </div>
    </div>

    <!-- RECOMENDACIONES INTELIGENTES -->
    <div class="reco-section">
      <h2 class="reco-title">🤖 Recomendaciones Inteligentes</h2>
      <p class="reco-subtitle">Basadas en tus ventas de los últimos 30 días, costos cargados y stock actual.</p>

      <div class="reco-grid">
        ${recoBlock({
          title: 'Reabastecer ya',
          icon: 'shopping_cart',
          color: COLORS.red,
          subtitle: `${reabastecer.length} productos por agotarse`,
          empty: 'Tu stock está saludable, no urge comprar nada.',
          items: reabastecer.slice(0, 8).map(r => ({
            nombre: r.nombre,
            rubro: r.rubro,
            badge: r.urgencia === 'alta' ? '🔴 URGENTE' : r.urgencia === 'media' ? '🟠 Pronto' : '🟡 Próx.',
            badgeClass: r.urgencia === 'alta' ? 'b-red' : r.urgencia === 'media' ? 'b-orange' : 'b-yellow',
            line1: `Stock: <b>${r.stock}</b> · Vendiste ${r.vendidos30d} (≈ ${r.velocidadDia}/día)`,
            line2: `Quedan ~<b>${r.diasRestantes === Infinity ? '∞' : r.diasRestantes}</b> días · Comprar ≈ <b>${r.sugerirComprar}</b>`,
            ingresos: r.ingreso30d,
          })),
        })}

        ${recoBlock({
          title: 'Productos estrella',
          icon: 'star',
          color: COLORS.orange,
          subtitle: `Top ingresos · cuídalos`,
          empty: 'Aún no hay datos suficientes para detectar estrellas.',
          items: estrellas.slice(0, 8).map(e => ({
            nombre: e.nombre,
            rubro: e.rubro,
            badge: e.margen !== null ? `${e.margen.toFixed(0)}% margen` : 'sin costo',
            badgeClass: e.margen !== null && e.margen >= 30 ? 'b-green' : 'b-blue',
            line1: `Vendiste <b>${e.vendidos30d}</b> en 30 días · Stock ${e.stock}`,
            line2: e.margen !== null
              ? (e.margen >= 30 ? '✅ Margen sano · mantener stock' : '⚠️ Margen ajustado · revisar precio')
              : 'ℹ️ Cargá costo para ver margen',
            ingresos: e.ingreso30d,
          })),
        })}

        ${recoBlock({
          title: 'Lentos · capital parado',
          icon: 'inventory_2',
          color: COLORS.gray,
          subtitle: 'Mucho stock, poca venta',
          empty: 'No tenés productos que estén girando lento.',
          items: lentos.slice(0, 8).map(l => ({
            nombre: l.nombre,
            rubro: l.rubro,
            badge: `Stock ${l.stock}`,
            badgeClass: 'b-gray',
            line1: `Vendiste solo <b>${l.vendidos30d}</b> en 30 días`,
            line2: `≈ <b>$${fmt(l.capitalParado)}</b> de capital inmovilizado`,
            ingresos: null,
          })),
        })}

        ${recoBlock({
          title: 'Para promocionar',
          icon: 'local_offer',
          color: COLORS.greenLight,
          subtitle: 'Buen margen pero rotación media',
          empty: 'No hay candidatos claros para promociones.',
          items: promocionar.slice(0, 8).map(p => ({
            nombre: p.nombre,
            rubro: p.rubro,
            badge: `${p.margen.toFixed(0)}% margen`,
            badgeClass: 'b-green',
            line1: `Stock <b>${p.stock}</b> · Vendiste ${p.vendidos30d}/mes`,
            line2: `Precio $${fmt(p.precio)} · una promo lo movería`,
            ingresos: null,
          })),
        })}

        ${recoBlock({
          title: 'Sin rotación',
          icon: 'hourglass_empty',
          color: COLORS.purple,
          subtitle: 'Stock parado >30 días',
          empty: 'Todo tu stock con stock>0 tuvo movimiento reciente.',
          items: sinRotacion.map(s => ({
            nombre: s.nombre,
            rubro: s.rubro,
            badge: s.dias >= 999 ? 'Nunca' : `${s.dias}d`,
            badgeClass: s.dias >= 90 || s.dias >= 999 ? 'b-red' : s.dias >= 60 ? 'b-orange' : 'b-yellow',
            line1: `Stock <b>${s.stock}</b> · Última venta ${s.ultima ? s.ultima : '—'}`,
            line2: `Capital parado ≈ <b>$${fmt(s.capitalParado)}</b>`,
            ingresos: null,
          })),
        })}
      </div>
    </div>

    <!-- Últimas ventas -->
    <div class="table-card">
      <div class="table-card-header"><h3>🧾 Últimas Ventas</h3></div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Fecha</th><th>Hora</th><th>Total</th><th>Tipo Pago</th><th>Cajero</th>
          </tr></thead>
          <tbody>
            ${ventas.slice(0, 10).map((v, i) => {
              const dt = parseArDate(v.created_at);
              const esEfectivo = v.payment_type === 'cash';
              const tieneDescuento = (v.discount || 0) > 0;
              return `<tr class="clickable-row" data-idx="${i}" title="Click para ver detalle">
                <td><b>#${displayNumForVenta(v, saleNumMap)}</b></td>
                <td>${fmtDate(dt)}</td>
                <td>${fmtTime(dt)}</td>
                <td><b>$${fmt(v.total_amount)}</b>${tieneDescuento ? ` <span class="badge badge-orange" style="font-size:10px">-$${fmt(v.discount)}</span>` : ''}</td>
                <td><span class="badge ${esEfectivo ? 'badge-green' : 'badge-blue'}">${esEfectivo ? '💵 Efectivo' : '🏦 Transferencia'}</span></td>
                <td><b>${v.cajero || v.username || v.user_id || '-'}</b></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Click en filas
  const recentVentas = ventas.slice(0, 10);
  document.querySelectorAll('#pageContent .clickable-row').forEach(row => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.idx);
      openSaleModal(recentVentas[idx], db);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // RENDERIZAR CHARTS
  // ──────────────────────────────────────────────────────────────────────────
  const Chart = await chartPromise;
  if (!Chart) {
    // Fallback: si no se pudo cargar Chart.js (sin internet), mostrar mensaje en cada canvas
    document.querySelectorAll('.chart-canvas-wrap').forEach(w => {
      w.innerHTML = '<div class="chart-fallback"><span class="material-icons">cloud_off</span><span>Conexión limitada — los gráficos no se pueden cargar</span></div>';
    });
    return;
  }

  // Defaults globales
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = '#65676b';

  // 1. Tendencia 30 días
  mkChart('chTendencia', {
    type: 'bar',
    data: {
      labels: labels30,
      datasets: [
        {
          type: 'line',
          label: 'Ingresos',
          data: totales30,
          borderColor: COLORS.primary,
          backgroundColor: hexA(COLORS.primary, 0.15),
          fill: true,
          tension: 0.35,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 5,
          yAxisID: 'y',
          order: 0,
        },
        {
          type: 'bar',
          label: 'Transacciones',
          data: counts30,
          backgroundColor: hexA(COLORS.cyan, 0.5),
          borderRadius: 4,
          yAxisID: 'y1',
          order: 1,
        },
      ],
    },
    options: {
      ...commonOpts(),
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false } },
        y: {
          position: 'left',
          beginAtZero: true,
          ticks: { callback: v => '$' + abbr(v) },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
        y1: {
          position: 'right',
          beginAtZero: true,
          grid: { display: false },
          ticks: { precision: 0 },
        },
      },
      plugins: { ...commonPlugins(), tooltip: tooltipMoney(['Ingresos']) },
    },
  });

  // 2. Método de pago (donut)
  mkChart('chPago', {
    type: 'doughnut',
    data: {
      labels: ['💵 Efectivo', '🏦 Transferencia'],
      datasets: [{
        data: [Math.round(efMes), Math.round(trMes)],
        backgroundColor: [COLORS.green, COLORS.primary],
        borderColor: '#fff',
        borderWidth: 3,
      }],
    },
    options: {
      ...commonOpts(),
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 14, boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx => `${ctx.label}: $${fmt(ctx.parsed)} (${pctTexto(ctx.parsed, efMes + trMes)})` } },
      },
    },
  });

  // 3. Hora del día
  mkChart('chHora', {
    type: 'bar',
    data: {
      labels: porHora.map((_, h) => `${String(h).padStart(2, '0')}h`),
      datasets: [{
        label: 'Ingresos',
        data: porHora.map(v => Math.round(v)),
        backgroundColor: porHora.map((v, h) => h === mejorHora ? COLORS.orange : hexA(COLORS.primary, 0.7)),
        borderRadius: 4,
      }],
    },
    options: {
      ...commonOpts(),
      scales: {
        x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, font: { size: 9 } } },
        y: { beginAtZero: true, ticks: { callback: v => '$' + abbr(v) }, grid: { color: 'rgba(0,0,0,0.05)' } },
      },
      plugins: { ...commonPlugins(), legend: { display: false }, tooltip: tooltipMoney(['Ingresos']) },
    },
  });

  // 4. Día de la semana
  mkChart('chDia', {
    type: 'bar',
    data: {
      labels: diaSemanaLabels,
      datasets: [{
        label: 'Ingresos',
        data: porDiaSemana.map(v => Math.round(v)),
        backgroundColor: porDiaSemana.map((_, i) => i === mejorDia ? COLORS.orange : hexA(COLORS.cyan, 0.85)),
        borderRadius: 6,
      }],
    },
    options: {
      ...commonOpts(),
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { callback: v => '$' + abbr(v) }, grid: { color: 'rgba(0,0,0,0.05)' } },
      },
      plugins: { ...commonPlugins(), legend: { display: false }, tooltip: tooltipMoney(['Ingresos']) },
    },
  });

  // 5. Top productos (horizontal)
  mkChart('chTopProd', {
    type: 'bar',
    data: {
      labels: top10Productos.map(([n]) => truncate(n, 32)),
      datasets: [{
        label: 'Ingresos',
        data: top10Productos.map(([_, v]) => Math.round(v.ingreso)),
        backgroundColor: top10Productos.map((_, i) => PALETTE[i % PALETTE.length]),
        borderRadius: 4,
      }],
    },
    options: {
      ...commonOpts(),
      indexAxis: 'y',
      scales: {
        x: { beginAtZero: true, ticks: { callback: v => '$' + abbr(v) }, grid: { color: 'rgba(0,0,0,0.05)' } },
        y: { grid: { display: false } },
      },
      plugins: {
        ...commonPlugins(), legend: { display: false },
        tooltip: { callbacks: { label: ctx => {
          const [, v] = top10Productos[ctx.dataIndex];
          return `Ingresos $${fmt(ctx.parsed.x)} · ${v.unidades} u.`;
        } } },
      },
    },
  });

  // 6. Categorías (donut)
  mkChart('chCategoria', {
    type: 'doughnut',
    data: {
      labels: categoriasOrden.map(([n]) => n),
      datasets: [{
        data: categoriasOrden.map(([_, v]) => Math.round(v.ingreso)),
        backgroundColor: categoriasOrden.map((_, i) => PALETTE[i % PALETTE.length]),
        borderColor: '#fff', borderWidth: 2,
      }],
    },
    options: {
      ...commonOpts(),
      cutout: '55%',
      plugins: {
        legend: { position: 'right', labels: { padding: 10, boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: {
          label: ctx => {
            const total = categoriasOrden.reduce((s, [_, v]) => s + v.ingreso, 0);
            return `${ctx.label}: $${fmt(ctx.parsed)} (${pctTexto(ctx.parsed, total)})`;
          },
        } },
      },
    },
  });

  // 7. Mes vs mes
  mkChart('chMesVsMes', {
    type: 'line',
    data: {
      labels: Array.from({ length: 31 }, (_, i) => String(i + 1)),
      datasets: [
        {
          label: 'Mes anterior',
          data: seriesMesAnt,
          borderColor: COLORS.gray,
          backgroundColor: hexA(COLORS.gray, 0.1),
          borderDash: [4, 4],
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: 'Mes actual',
          data: seriesMesAct,
          borderColor: COLORS.primary,
          backgroundColor: hexA(COLORS.primary, 0.18),
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2.5,
        },
      ],
    },
    options: {
      ...commonOpts(),
      scales: {
        x: { grid: { display: false }, title: { display: true, text: 'Día del mes', color: '#999', font: { size: 10 } } },
        y: { beginAtZero: true, ticks: { callback: v => '$' + abbr(v) }, grid: { color: 'rgba(0,0,0,0.05)' } },
      },
      plugins: { ...commonPlugins(), tooltip: tooltipMoney(['Mes anterior', 'Mes actual']) },
    },
  });

  // 8. Top cajeros
  mkChart('chCajeros', {
    type: 'bar',
    data: {
      labels: topCajeros.map(([n]) => truncate(n, 16)),
      datasets: [{
        label: 'Ingresos',
        data: topCajeros.map(([_, v]) => Math.round(v.ingreso)),
        backgroundColor: topCajeros.map((_, i) => PALETTE[i % PALETTE.length]),
        borderRadius: 6,
      }],
    },
    options: {
      ...commonOpts(),
      indexAxis: 'y',
      scales: {
        x: { beginAtZero: true, ticks: { callback: v => '$' + abbr(v) }, grid: { color: 'rgba(0,0,0,0.05)' } },
        y: { grid: { display: false } },
      },
      plugins: {
        ...commonPlugins(), legend: { display: false },
        tooltip: { callbacks: { label: ctx => {
          const [, v] = topCajeros[ctx.dataIndex];
          return `$${fmt(ctx.parsed.x)} · ${v.ventas} ventas`;
        } } },
      },
    },
  });

  // 9. Ganancia (Ingresos vs Costo vs Ganancia)
  mkChart('chGanancia', {
    type: 'bar',
    data: {
      labels: ['Ingresos (con costo)', 'Costo de mercadería', 'Ganancia bruta'],
      datasets: [{
        label: '$',
        data: [Math.round(ingresoConCostoMes), Math.round(cmvMes), Math.round(gananciaBrutaMes)],
        backgroundColor: [COLORS.primary, COLORS.red, COLORS.green],
        borderRadius: 8,
      }],
    },
    options: {
      ...commonOpts(),
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { callback: v => '$' + abbr(v) }, grid: { color: 'rgba(0,0,0,0.05)' } },
      },
      plugins: { ...commonPlugins(), legend: { display: false }, tooltip: tooltipMoney(['$']) },
    },
  });

  // 10. Stock por estado (donut)
  const stockOk = catalogo.filter(p => (p.stock || 0) > 3).length;
  // 11. Margen por categoría (barras horizontales)
  if (categoriasMargen.length > 0) {
    mkChart('chMargenCat', {
      type: 'bar',
      data: {
        labels: categoriasMargen.map(c => c.cat.length > 22 ? c.cat.slice(0, 21) + '…' : c.cat),
        datasets: [{
          label: '% margen',
          data: categoriasMargen.map(c => round2(c.margen)),
          backgroundColor: categoriasMargen.map(c =>
            c.margen >= 40 ? COLORS.green :
            c.margen >= 25 ? COLORS.greenLight :
            c.margen >= 10 ? COLORS.orange : COLORS.red),
          borderRadius: 6,
        }],
      },
      options: {
        ...commonOpts(),
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, ticks: { callback: v => v + '%' }, grid: { color: 'rgba(0,0,0,0.05)' } },
          y: { grid: { display: false } },
        },
        plugins: {
          ...commonPlugins(),
          legend: { display: false },
          tooltip: { callbacks: {
            label: ctx => `${ctx.parsed.x.toFixed(1)}% margen · Ingresos $${fmt(categoriasMargen[ctx.dataIndex].ingreso)}`,
          } },
        },
      },
    });
  }
  mkChart('chStock', {
    type: 'doughnut',
    data: {
      labels: ['Stock OK (>3)', 'Stock crítico (1-3)', 'Agotados'],
      datasets: [{
        data: [stockOk, stockCritico, stockAgotado],
        backgroundColor: [COLORS.green, COLORS.orange, COLORS.red],
        borderColor: '#fff', borderWidth: 3,
      }],
    },
    options: {
      ...commonOpts(),
      cutout: '60%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 14, boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed} productos` } },
      },
    },
  });

  // Forzar re-medición de TODOS los charts después de que el browser
  // termine el layout. Sin esto, charts creados con contenedores aún
  // sin tamaño quedan en blanco hasta el primer hover/resize.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      _chartRefs.forEach(ch => { try { ch.resize(); } catch (_) {} });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS DE RENDER
// ──────────────────────────────────────────────────────────────────────────────
function renderHeatmap(data, max, hMin, hMax, diaLabels) {
  const horas = [];
  for (let h = hMin; h <= hMax; h++) horas.push(h);
  const cellColor = (val) => {
    if (val <= 0) return '#f3f4f6';
    const t = Math.min(1, val / max);
    // gradiente entre lila claro y primary
    const r = Math.round(243 + (123 - 243) * t);
    const g = Math.round(232 + (63 - 232) * t);
    const b = Math.round(247 + (166 - 247) * t);
    return `rgb(${r},${g},${b})`;
  };
  let html = `<div class="heatmap-wrap"><div class="heatmap-grid" style="grid-template-columns: 50px repeat(${horas.length}, minmax(20px, 1fr));">`;
  // Header
  html += `<div></div>`;
  horas.forEach(h => { html += `<div class="heatmap-hour-label">${String(h).padStart(2, '0')}</div>`; });
  // Filas
  diaLabels.forEach((dia, di) => {
    html += `<div class="heatmap-day-label">${dia}</div>`;
    horas.forEach(h => {
      const v = data[di][h];
      const tip = `${dia} ${String(h).padStart(2, '0')}:00 — $${fmt(Math.round(v))}`;
      html += `<div class="heatmap-cell" style="background:${cellColor(v)}" title="${tip}"></div>`;
    });
  });
  html += `</div></div>`;
  return html;
}

function renderCobertura(items) {
  if (!items || items.length === 0) {
    return `<div class="cobertura-empty">Sin productos por agotarse al ritmo actual.</div>`;
  }
  return `
    <div class="cobertura-list">
      ${items.map(p => {
        const cls = p.dias <= 5 ? 'cob-red' : p.dias <= 10 ? 'cob-orange' : 'cob-yellow';
        return `
          <div class="cobertura-item ${cls}">
            <div class="cobertura-top">
              <span class="cobertura-nombre" title="${escapeHtml(p.nombre)}">${escapeHtml(truncate(p.nombre, 32))}</span>
              <span class="cobertura-dias"><b>${p.dias}</b>d</span>
            </div>
            <div class="cobertura-meta">
              Stock <b>${p.stock}</b> · ${p.velocidadDia}/día · ${escapeHtml(truncate(p.rubro, 20))}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function kpiCard(label, value, sub, icon, themeClass, delta, deltaLabel) {
  let deltaHtml = '';
  if (typeof delta === 'number' && isFinite(delta)) {
    const positive = delta >= 0;
    const arrow = positive ? '▲' : '▼';
    const cls = positive ? 'kpi-delta-up' : 'kpi-delta-down';
    deltaHtml = `<div class="kpi-delta ${cls}">${arrow} ${Math.abs(delta).toFixed(1)}% <span style="opacity:.7">${deltaLabel || ''}</span></div>`;
  }
  return `
    <div class="kpi-card ${themeClass || ''}">
      <div class="kpi-icon"><span class="material-icons">${icon}</span></div>
      <div class="kpi-body">
        <div class="kpi-label">${label}</div>
        <div class="kpi-value">${value}</div>
        ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
        ${deltaHtml}
      </div>
    </div>
  `;
}

function recoBlock({ title, icon, color, subtitle, empty, items }) {
  if (!items || items.length === 0) {
    return `
      <div class="reco-card">
        <div class="reco-card-header" style="--reco-color:${color}">
          <span class="reco-icon"><span class="material-icons">${icon}</span></span>
          <div><h4>${title}</h4><span class="reco-card-sub">${subtitle}</span></div>
        </div>
        <div class="reco-empty">${empty}</div>
      </div>
    `;
  }
  return `
    <div class="reco-card">
      <div class="reco-card-header" style="--reco-color:${color}">
        <span class="reco-icon"><span class="material-icons">${icon}</span></span>
        <div><h4>${title} <span class="reco-count">${items.length}</span></h4><span class="reco-card-sub">${subtitle}</span></div>
      </div>
      <ul class="reco-list">
        ${items.map(it => `
          <li class="reco-item">
            <div class="reco-item-top">
              <span class="reco-item-name" title="${escapeHtml(it.nombre)}">${escapeHtml(it.nombre)}</span>
              <span class="reco-badge ${it.badgeClass}">${it.badge}</span>
            </div>
            <div class="reco-item-meta">${it.line1}</div>
            <div class="reco-item-meta">${it.line2}</div>
            ${it.ingresos != null ? `<div class="reco-item-meta reco-ingresos">Ingresos 30d: <b>$${fmt(it.ingresos)}</b></div>` : ''}
            <div class="reco-rubro">${escapeHtml(it.rubro || '—')}</div>
          </li>
        `).join('')}
      </ul>
    </div>
  `;
}

// ──────────────────────────────────────────────────────────────────────────────
// CHART HELPERS
// ──────────────────────────────────────────────────────────────────────────────
function mkChart(canvasId, config) {
  const el = document.getElementById(canvasId);
  if (!el || !window.Chart) return null;
  const ch = new window.Chart(el.getContext('2d'), config);
  _chartRefs.set(canvasId, ch);
  // Forzar re-medición tras el layout del browser:
  // sin esto, si el contenedor todavía tiene width 0 al crearse,
  // el canvas queda en blanco hasta que un evento (hover/resize) lo despierta.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { try { ch.resize(); } catch (_) {} });
  });
  return ch;
}
function commonOpts() {
  return { responsive: true, maintainAspectRatio: false, animation: { duration: 600 } };
}
function commonPlugins() {
  return {
    legend: { position: 'top', align: 'end', labels: { padding: 10, boxWidth: 12, font: { size: 11 } } },
    tooltip: {
      backgroundColor: 'rgba(28,30,33,0.95)', titleColor: '#fff', bodyColor: '#fff',
      titleFont: { weight: '600' }, padding: 10, cornerRadius: 8, displayColors: true, boxPadding: 4,
    },
  };
}
function tooltipMoney(labels) {
  return {
    backgroundColor: 'rgba(28,30,33,0.95)', titleColor: '#fff', bodyColor: '#fff',
    padding: 10, cornerRadius: 8,
    callbacks: { label: ctx => `${ctx.dataset.label || ''}: ${labels.includes(ctx.dataset.label) ? '$' + fmt(ctx.parsed.y ?? ctx.parsed.x ?? ctx.parsed) : ctx.parsed.y ?? ctx.parsed}` },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// UTILS
// ──────────────────────────────────────────────────────────────────────────────
function todayAR() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); }
function isoDate(d) { return d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); }
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
function abbr(n) {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(v));
}
function sum(arr, key) { return arr.reduce((s, v) => s + (Number(v[key]) || 0), 0); }
function pctTexto(part, total) {
  if (!total) return '0%';
  return ((part / total) * 100).toFixed(1) + '%';
}
function round2(n) { return Math.round(n * 100) / 100; }
function truncate(s, n) { return (s && s.length > n) ? s.slice(0, n - 1) + '…' : s; }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function hexA(hex, alpha) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function formatHora(h) { return `${String(h).padStart(2, '0')}:00 — ${String(h + 1).padStart(2, '0')}:00`; }
function totalDiasDesde(desde, hasta) {
  return Math.floor((hasta.getTime() - desde.getTime()) / (1000 * 60 * 60 * 24));
}
function lastDayOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}
