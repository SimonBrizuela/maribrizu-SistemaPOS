import { collection, getDocs, query, orderBy, where, doc, updateDoc, getDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { getCached, peekCache, invalidateCacheByPrefix } from '../cache.js';

// Mapa de subcategorías por rubro cargado desde Firebase sub_categories
// Se llena en initSubCats()
const SUBCATS_POR_RUBRO = {};

async function initSubCats(db) {
  try {
    // Leer colección 'sub_categories' desde Firebase
    const snap = await getDocs(collection(db, 'sub_categories'));
    snap.forEach(d => {
      const data = d.data();
      const rubro = (data.rubro || '').toUpperCase().trim();
      const name  = (data.name || '').trim();
      if (rubro && name) {
        if (!SUBCATS_POR_RUBRO[rubro]) SUBCATS_POR_RUBRO[rubro] = [];
        if (!SUBCATS_POR_RUBRO[rubro].includes(name))
          SUBCATS_POR_RUBRO[rubro].push(name);
      }
    });
    // Ordenar cada lista alfabéticamente
    Object.keys(SUBCATS_POR_RUBRO).forEach(r => SUBCATS_POR_RUBRO[r].sort());
  } catch(e) {
    console.warn('sub_categories no disponible:', e);
  }
}

/**
 * Retorna las categorías del rubro activo.
 * Prioridad: 1) sub_categories de Firebase, 2) categorías reales en los productos.
 */
function getCatsDelRubro(rubro, base) {
  if (rubro === 'TODOS') {
    // Mostrar todas las categorías de los productos actuales
    return [...new Set(base.map(p => p.categoria || '').filter(Boolean))].sort();
  }
  const rubroNorm = rubro.toUpperCase().trim();
  // Si tenemos subcategorías pre-cargadas para este rubro, usarlas
  if (SUBCATS_POR_RUBRO[rubroNorm] && SUBCATS_POR_RUBRO[rubroNorm].length > 0) {
    return SUBCATS_POR_RUBRO[rubroNorm];
  }
  // Fallback: extraer de los productos del rubro
  return [...new Set(base.map(p => p.categoria || '').filter(Boolean))].sort();
}

function fmt(n) { return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Rubros se cargan dinámicamente desde Firebase config/rubros
let RUBROS = ['ACCESORIOS','JUGUETERÍA','LENCERÍA','LIBRERÍA','MERCERÍA',
  'NAVIDAD','PAPELERA','PERFUMERÍA','REGALERÍA','SELLOS','SERVICIOS','TELGOPOR'];

// RUBRO_CATS ya no se usa — el campo 'rubro' viene directo de Firebase/catalogo
const RUBRO_CATS = {};

export async function renderInventario(container, db) {

  const hayCache = peekCache('inv:productos', 10 * 60 * 1000) && peekCache('inv:ventas_por_dia', 10 * 60 * 1000);
  if (!hayCache) {
    container.innerHTML = `<div class="loader"><div class="spinner"></div><span>Analizando inventario...</span></div>`;
  }

  // ── Cargar rubros y subcategorías en paralelo ─────────────────────────────
  await Promise.all([
    // Rubros dinámicos desde Firebase
    getDoc(doc(db, 'config', 'rubros')).then(snap => {
      if (snap.exists() && snap.data().lista?.length) RUBROS = snap.data().lista;
    }).catch(() => {}),
    // Subcategorías por rubro
    initSubCats(db),
  ]);

  // ── Cargar catálogo y ventas en paralelo (cacheado 10 min en memoria) ─────
  // TTL más largo para que pasar entre tabs no re-fetche todo Firestore
  // (el inventario es la página más pesada). El botón Refresh y los edits
  // explícitos invalidan con invalidateCacheByPrefix('inv:').
  const [productos, ventasRaw] = await Promise.all([
    getCached('inv:productos', async () => {
      const snap = await getDocs(query(collection(db, 'catalogo'), orderBy('nombre')));
      return snap.docs.map(d => ({ id: d.id, doc_id: d.id, ...d.data() }));
    }, { ttl: 10 * 60 * 1000, memOnly: true }),
    getCached('inv:ventas_por_dia', async () => {
      try {
        // Solo últimos 90 días: la velocidad de venta se calcula sobre 30 y 7 días.
        // 90d cubre con margen y reduce ~80% las lecturas en historicos largos.
        const hace90d = new Date();
        hace90d.setDate(hace90d.getDate() - 90);
        const snap = await getDocs(query(
          collection(db, 'ventas_por_dia'),
          where('fecha_dt', '>=', Timestamp.fromDate(hace90d)),
          orderBy('fecha_dt', 'desc')
        ));
        return snap.docs.map(d => d.data());
      } catch (e) {
        // Fallback: si fecha_dt no existe en docs viejos, intenta sin filtro
        console.warn('inv:ventas_por_dia con fecha_dt falló, fallback a fecha:', e?.message);
        try {
          const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha', 'desc')));
          return snap.docs.map(d => d.data());
        } catch { return []; }
      }
    }, { ttl: 10 * 60 * 1000, memOnly: true }),
  ]);

  // ── Calcular velocidad de venta ───────────────────────────────────────────
  const hace30 = new Date(); hace30.setDate(hace30.getDate() - 30);
  const hace14 = new Date(); hace14.setDate(hace14.getDate() - 14);
  const hace7  = new Date(); hace7.setDate(hace7.getDate() - 7);

  const ventasProd = {};
  // Acumulador para el sparkline: total de unidades vendidas por día (últimos 14d).
  // El sparkline pinta la tendencia general del local, no por producto.
  const ventasPorDia = {};
  ventasRaw.forEach(v => {
    const nombre = (v.producto || '').toUpperCase().trim();
    const parts = (v.fecha || '').split('/');
    let fechaV = null;
    if (parts.length === 3) fechaV = new Date(`${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`);
    if (!fechaV) return;
    if (fechaV >= hace14) {
      const k = v.fecha;
      ventasPorDia[k] = (ventasPorDia[k] || 0) + (v.cantidad || 1);
    }
    if (!nombre) return;
    if (!ventasProd[nombre]) ventasProd[nombre] = { u30: 0, u7: 0 };
    if (fechaV >= hace30) {
      ventasProd[nombre].u30 += (v.cantidad || 1);
      if (fechaV >= hace7) ventasProd[nombre].u7 += (v.cantidad || 1);
    }
  });

  // Serie de 14 días en orden cronológico para el sparkline.
  function _serieVentas14d() {
    const out = [];
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    for (let i = 13; i >= 0; i--) {
      const d = new Date(hoy); d.setDate(d.getDate() - i);
      const k = `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
      out.push({ fecha: k, label: `${d.getDate()}/${d.getMonth()+1}`, total: ventasPorDia[k] || 0 });
    }
    return out;
  }

  // ── Stock efectivo: para productos conjunto el "stock" real se calcula
  // EN VIVO desde las variedades (unidades × contenido + restante por color),
  // porque `p.conjunto_total` puede quedar desactualizado en DB cuando se
  // editan colores y nadie recalcula el agregado. Si no hay variedades,
  // fallback a `conjunto_total`. Si no es conjunto, `stock` plano.
  function _stockEfectivo(p) {
    if (p && (p.es_conjunto === true || p.es_conjunto === 1)) {
      const variedades = Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [];
      if (variedades.length > 0) {
        const globalCont = Number(p.conjunto_contenido || 0);
        const total = variedades.reduce((acc, c) => {
          const u = Number(c.unidades) || 0;
          const r = Number(c.restante) || 0;
          const cont = (Number(c.contenido) > 0) ? Number(c.contenido) : globalCont;
          return acc + (u * cont + r);
        }, 0);
        return Math.round(total);
      }
      return Math.round(Number(p.conjunto_total || 0));
    }
    return Number(p.stock) || 0;
  }

  // Variedades del producto con sus subtotales — para mostrar cuáles están bajas.
  // Devuelve [] si el producto no es conjunto o no tiene colores cargados.
  function _variedadesDesglose(p) {
    if (!p || !(p.es_conjunto === true || p.es_conjunto === 1)) return [];
    const variedades = Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [];
    if (!variedades.length) return [];
    const globalCont = Number(p.conjunto_contenido || 0);
    return variedades.map(c => {
      const u = Number(c.unidades) || 0;
      const r = Number(c.restante) || 0;
      const cont = (Number(c.contenido) > 0) ? Number(c.contenido) : globalCont;
      return { color: c.color || '-', u, r, cont, total: u * cont + r };
    });
  }

  // ── Unidad del producto: usado en alertas y badges para que digan
  // "pocos rollos / pocos metros / pocos items" en lugar de un genérico.
  function _unidad(p) {
    if (p && (p.es_conjunto === true || p.es_conjunto === 1)) {
      const um = (p.conjunto_unidad_medida || '').toLowerCase();
      if (um === 'metros' || um === 'metro') return { sg: 'metro',  pl: 'metros',   sym: 'm' };
      const tipo = (p.conjunto_tipo || '').toLowerCase();
      if (tipo === 'rollo') return { sg: 'rollo', pl: 'rollos', sym: 'r' };
      if (tipo === 'pack')  return { sg: 'pack',  pl: 'packs',  sym: 'p' };
      if (tipo === 'caja')  return { sg: 'caja',  pl: 'cajas',  sym: 'c' };
      return { sg: 'unidad', pl: 'unidades', sym: 'u' };
    }
    return { sg: 'item', pl: 'items', sym: 'u' };
  }

  // ── Estado inteligente ────────────────────────────────────────────────────
  // Devuelve además:
  //   - rellenar:      true si el producto está debajo de stock_min, tiene
  //                    velocidad > 0 con poco stock, o si alguna variedad está
  //                    en 0 (caso conjunto).
  //   - varAgotadas:   array de nombres de variedades en 0 (solo conjunto).
  function calcularEstado(p) {
    const stock = _stockEfectivo(p);
    const u = _unidad(p);
    const nombre = (p.nombre || '').toUpperCase().trim();
    const vData = ventasProd[nombre];
    const u30 = vData?.u30 || 0;
    const velocidadDiaria = u30 / 30;
    const stockMin = Math.max(0, Number(p.stock_min) || 0);

    // Variedades en 0 (solo conjunto con colores cargados).
    const desglose = _variedadesDesglose(p);
    const varAgotadas = desglose.filter(v => v.total === 0).map(v => v.color);

    // ¿Hay que rellenar? (cualquiera de estas condiciones).
    const tieneVelocidad = velocidadDiaria > 0;
    const diasRestantes = tieneVelocidad ? Math.floor(stock / velocidadDiaria) : null;
    const rellenarPorMin       = stockMin > 0 && stock <= stockMin;
    const rellenarPorVelocidad = tieneVelocidad && diasRestantes !== null && diasRestantes <= 10;
    const rellenarPorVariedad  = varAgotadas.length > 0;
    const rellenar = rellenarPorMin || rellenarPorVelocidad || rellenarPorVariedad;

    const baseExtra = { unidad: u, rellenar, varAgotadas, stockMin };

    if (stock === 0) return { ...baseExtra, label: `Sin ${u.pl}`, key: 'agotado', cls: 'badge-red', color: '#c62828', dias: 0, velocidad: velocidadDiaria, pct: 0 };

    if (tieneVelocidad) {
      const pct = Math.min(100, Math.round((diasRestantes / 30) * 100));
      if (diasRestantes <= 3)  return { ...baseExtra, label: `Pocos ${u.pl} · ${diasRestantes}d`,  key: 'critico',  cls: 'badge-red',    color: '#c62828', dias: diasRestantes, velocidad: velocidadDiaria, pct };
      if (diasRestantes <= 10) return { ...baseExtra, label: `Bajo · ${diasRestantes}d`,           key: 'bajo',     cls: 'badge-orange', color: '#f57c00', dias: diasRestantes, velocidad: velocidadDiaria, pct };
      if (diasRestantes <= 20) return { ...baseExtra, label: `Regular · ${diasRestantes}d`,        key: 'regular',  cls: 'badge-orange', color: '#e65100', dias: diasRestantes, velocidad: velocidadDiaria, pct };
      return                         { ...baseExtra, label: `OK · ${diasRestantes}d`,              key: 'ok',       cls: 'badge-green',  color: '#2e7d32', dias: diasRestantes, velocidad: velocidadDiaria, pct };
    } else {
      // Sin velocidad de ventas: nos guiamos por stock_min si está cargado;
      // si no, por umbrales fijos. Si stock_min está, todo lo que esté por
      // encima del 50% del min se considera OK.
      if (stockMin > 0) {
        if (stock <= stockMin)            return { ...baseExtra, label: `Rellenar (${stock}/${stockMin})`, key: 'critico', cls: 'badge-red',    color: '#c62828', dias: null, velocidad: 0, pct: 10 };
        if (stock <= stockMin * 1.5)      return { ...baseExtra, label: 'Rellenar pronto',                 key: 'bajo',    cls: 'badge-orange', color: '#f57c00', dias: null, velocidad: 0, pct: 40 };
        return                                   { ...baseExtra, label: 'OK',                              key: 'ok',      cls: 'badge-green',  color: '#2e7d32', dias: null, velocidad: 0, pct: 100 };
      }
      if (stock <= 2)  return { ...baseExtra, label: `Pocos ${u.pl}`, key: 'critico', cls: 'badge-red',    color: '#c62828', dias: null, velocidad: 0, pct: 10 };
      if (stock <= 5)  return { ...baseExtra, label: 'Bajo',          key: 'bajo',    cls: 'badge-orange', color: '#f57c00', dias: null, velocidad: 0, pct: 40 };
      if (stock <= 15) return { ...baseExtra, label: 'Regular',       key: 'regular', cls: 'badge-orange', color: '#e65100', dias: null, velocidad: 0, pct: 65 };
      return                 { ...baseExtra, label: 'OK',             key: 'ok',      cls: 'badge-green',  color: '#2e7d32', dias: null, velocidad: 0, pct: 100 };
    }
  }

  const prods = productos.map(p => ({ ...p, estado: calcularEstado(p) }));

  // ── Estado activo de rubro ─────────────────────────────────────────────────
  let rubroActivo = 'TODOS';
  // Por defecto el inventario muestra solo lo "importante": productos que hay
  // que rellenar (debajo de stock_min, pocos días o variedades en 0) o que se
  // están vendiendo. Es la vista accionable. La búsqueda por nombre desactiva
  // automáticamente este filtro así no "desaparece" lo que buscás.
  let soloRelevantes = true;

  function normalize(s) {
    return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
  }

  function getBase() {
    if (rubroActivo === 'TODOS') return prods;
    const rubroNorm = normalize(rubroActivo);
    return prods.filter(p => normalize(p.rubro || '') === rubroNorm);
  }

  // ── Render shell (dashboard) ──────────────────────────────────────────────
  // Estado de visibilidad de la tabla detallada: por defecto colapsada para
  // no abrumar; se abre al buscar o cuando el usuario clickea "Ver detalle".
  let tablaVisible = false;

  function renderShell() {
    const base = getBase();

    // Alertas: productos que hay que rellenar (variedades en 0, debajo de
    // stock_min, o pocos días). Solo cosas accionables — no llenamos el panel
    // con catálogo viejo en cero.
    const alertas = base
      .filter(p => (p.estado.velocidad > 0 || _stockEfectivo(p) > 0 || (Number(p.stock_min) || 0) > 0))
      .filter(p => p.estado.rellenar || p.estado.key === 'critico' || p.estado.key === 'agotado')
      .sort((a,b) => {
        const aVar = (a.estado.varAgotadas?.length || 0) > 0 ? 0 : 1;
        const bVar = (b.estado.varAgotadas?.length || 0) > 0 ? 0 : 1;
        if (aVar !== bVar) return aVar - bVar;
        const aMin = a.estado.stockMin > 0 && _stockEfectivo(a) <= a.estado.stockMin ? 0 : 1;
        const bMin = b.estado.stockMin > 0 && _stockEfectivo(b) <= b.estado.stockMin ? 0 : 1;
        if (aMin !== bMin) return aMin - bMin;
        return (a.estado.dias ?? 999) - (b.estado.dias ?? 999);
      })
      .slice(0, 8);

    // Top en movimiento: los que más se vendieron en últimos 30 días.
    const topMovers = base
      .filter(p => p.estado.velocidad > 0)
      .sort((a, b) => (b.estado.velocidad || 0) - (a.estado.velocidad || 0))
      .slice(0, 10);

    // Variantes agotadas: lista plana de productos con al menos una variedad en 0.
    const variantesEnCero = base
      .filter(p => (p.estado.varAgotadas?.length || 0) > 0)
      .slice(0, 12);

    const cats = getCatsDelRubro(rubroActivo, base);
    const serie = _serieVentas14d();

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px">

        <!-- SELECTOR DE RUBRO -->
        <div class="rubro-bar-wrap" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 14px;background:#fff;border-radius:12px;border:1px solid #e4e6eb;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
          <span style="font-size:12px;font-weight:700;color:#65676b;white-space:nowrap;margin-right:4px">SECCIÓN:</span>
          <button class="inv-rubro-btn ${rubroActivo==='TODOS'?'active':''}" data-rubro="TODOS" style="padding:5px 14px;border-radius:20px;border:2px solid ${rubroActivo==='TODOS'?'#1877f2':'#e4e6eb'};background:${rubroActivo==='TODOS'?'#1877f2':'#fff'};color:${rubroActivo==='TODOS'?'#fff':'#1c1e21'};cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap;flex-shrink:0">Todos</button>
          ${RUBROS.map(r => `<button class="inv-rubro-btn ${rubroActivo===r?'active':''}" data-rubro="${r}" style="padding:5px 14px;border-radius:20px;border:2px solid ${rubroActivo===r?'#1877f2':'#e4e6eb'};background:${rubroActivo===r?'#1877f2':'#fff'};color:${rubroActivo===r?'#fff':'#1c1e21'};cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;flex-shrink:0">${r.charAt(0)+r.slice(1).toLowerCase()}</button>`).join('')}
        </div>

        <!-- STATS -->
        <div class="cards-grid" id="invStats"></div>

        <!-- GRÁFICO DE TENDENCIA -->
        <div id="invSparkline"></div>

        <!-- DOS COLUMNAS: ALERTAS + TOP MOVERS -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(360px, 1fr));gap:14px">
          <div id="invAlertas"></div>
          <div id="invTopMovers"></div>
        </div>

        <!-- VARIANTES EN 0 -->
        <div id="invVariantesAgotadas"></div>

        <!-- BUSCADOR + BOTÓN DETALLE -->
        <div class="filter-bar" style="flex-wrap:wrap;gap:8px;align-items:center">
          <div style="position:relative;flex:1;min-width:220px;display:flex;align-items:center">
            <span class="material-icons" style="position:absolute;left:10px;font-size:20px;color:#65676b;pointer-events:none">search</span>
            <input type="text" id="filtroNombre" placeholder="Buscar cualquier producto..." style="width:100%;padding:8px 12px 8px 38px;box-sizing:border-box" />
          </div>
          <button id="btnToggleTabla" type="button" style="padding:8px 14px;border-radius:8px;border:2px solid #1877f2;background:${tablaVisible?'#1877f2':'#fff'};color:${tablaVisible?'#fff':'#1877f2'};cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap;display:flex;align-items:center;gap:6px;font-family:inherit">
            <span class="material-icons" style="font-size:16px">${tablaVisible?'expand_less':'view_list'}</span>
            ${tablaVisible?'Ocultar detalle':'Ver detalle completo'}
          </button>
        </div>

        <!-- TABLA DETALLADA (colapsable) -->
        <div id="invTablaWrap" style="display:${tablaVisible?'block':'none'}">
          <div class="filter-bar" style="flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px">
            <button id="toggleSoloRelevantes" type="button" title="Mostrar solo lo accionable. Se desactiva al buscar." style="padding:8px 14px;border-radius:8px;border:2px solid ${soloRelevantes?'#7b1fa2':'#e4e6eb'};background:${soloRelevantes?'#7b1fa2':'#fff'};color:${soloRelevantes?'#fff':'#65676b'};cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap;display:flex;align-items:center;gap:6px">
              <span class="material-icons" style="font-size:16px">${soloRelevantes?'priority_high':'list'}</span>
              Solo importante
            </button>
            <select id="filtroCategoria">
              <option value="">Todas las categorías</option>
              ${cats.map(c => `<option value="${c}">${c}</option>`).join('')}
            </select>
            <select id="filtroEstado">
              <option value="">Todos los estados</option>
              <option value="ok">OK</option>
              <option value="regular">Regular</option>
              <option value="bajo">Bajo</option>
              <option value="critico">Crítico</option>
              <option value="agotado">Agotado</option>
            </select>
            <select id="filtroMovimiento">
              <option value="">Todo</option>
              <option value="con">Con movimiento</option>
              <option value="sin">Sin movimiento</option>
            </select>
          </div>
          <div class="table-card">
            <div class="table-card-header">
              <h3>Detalle de productos</h3>
              <span id="invCount" style="color:var(--text-muted);font-size:13px"></span>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr>
                  <th>Producto</th>
                  <th class="inv-col-categoria">Categoría</th>
                  <th class="inv-col-rubro">Rubro</th>
                  <th style="text-align:center">Stock</th>
                  <th class="inv-col-dias" style="text-align:center">Días</th>
                  <th class="inv-col-cobertura">Cobertura</th>
                  <th class="inv-col-velocidad" style="text-align:center">Vel./día</th>
                  <th>Estado</th>
                  <th style="text-align:right">Precio</th>
                  <th>Acciones</th>
                </tr></thead>
                <tbody id="invBody"></tbody>
              </table>
            </div>
          </div>
        </div>

      </div>
    `;

    renderStats(base);
    renderSparkline(serie);
    renderAlertas(alertas);
    renderTopMovers(topMovers);
    renderVariantesAgotadas(variantesEnCero);
    if (tablaVisible) applyFilters();

    // Listeners de rubros: re-renderiza todo el dashboard al cambiar de rubro.
    document.querySelectorAll('.inv-rubro-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        rubroActivo = btn.dataset.rubro;
        renderShell();
      });
    });

    // Búsqueda: si hay texto, abrimos la tabla automáticamente — porque el
    // resultado de la búsqueda solo se ve ahí. Al limpiar, vuelve al estado
    // anterior.
    const inpBuscar = document.getElementById('filtroNombre');
    if (inpBuscar) {
      inpBuscar.addEventListener('input', () => {
        const q = inpBuscar.value.trim();
        if (q && !tablaVisible) {
          tablaVisible = true;
          mostrarTabla(true);
        }
        applyFilters();
      });
    }

    // Listeners de filtros (existen en el DOM aunque la tabla esté oculta).
    ['filtroCategoria','filtroEstado','filtroMovimiento'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', applyFilters);
    });

    // Toggle "Ver detalle completo" — muestra/oculta la tabla.
    const btnDetalle = document.getElementById('btnToggleTabla');
    if (btnDetalle) {
      btnDetalle.addEventListener('click', () => {
        tablaVisible = !tablaVisible;
        mostrarTabla(tablaVisible);
        if (tablaVisible) applyFilters();
      });
    }

    // Toggle "Solo importante": ON → muestra solo lo accionable.
    const btnToggle = document.getElementById('toggleSoloRelevantes');
    if (btnToggle) {
      btnToggle.addEventListener('click', () => {
        soloRelevantes = !soloRelevantes;
        btnToggle.style.borderColor = soloRelevantes ? '#7b1fa2' : '#e4e6eb';
        btnToggle.style.background  = soloRelevantes ? '#7b1fa2' : '#fff';
        btnToggle.style.color       = soloRelevantes ? '#fff'    : '#65676b';
        const ico = btnToggle.querySelector('.material-icons');
        if (ico) ico.textContent = soloRelevantes ? 'priority_high' : 'list';
        applyFilters();
      });
    }
  }

  function mostrarTabla(visible) {
    const wrap = document.getElementById('invTablaWrap');
    const btn  = document.getElementById('btnToggleTabla');
    if (wrap) wrap.style.display = visible ? 'block' : 'none';
    if (btn) {
      btn.style.background = visible ? '#1877f2' : '#fff';
      btn.style.color      = visible ? '#fff'    : '#1877f2';
      btn.innerHTML = `
        <span class="material-icons" style="font-size:16px">${visible?'expand_less':'view_list'}</span>
        ${visible?'Ocultar detalle':'Ver detalle completo'}`;
    }
  }

  function renderStats(base) {
    const grid = document.getElementById('invStats');
    if (!grid) return;
    const total     = base.length;
    const enMovimiento = base.filter(p => p.estado.velocidad > 0).length;
    const sinStock  = base.filter(p => _stockEfectivo(p) === 0).length;
    const rellenar  = base.filter(p => p.estado.rellenar).length;
    // Cantidad TOTAL de variedades en cero (sumando todas las del catálogo).
    const variantesEnCero = base.reduce((acc, p) => acc + (p.estado.varAgotadas?.length || 0), 0);

    const cs = 'cursor:pointer;transition:transform 0.15s,box-shadow 0.15s';
    grid.innerHTML = `
      <div class="card stat-card inv-stat" data-filtro="" style="${cs}" title="Ver todos"><div class="icon-wrap bg-blue"><span class="material-icons">inventory_2</span></div><div class="label">Total productos</div><div class="value">${total}</div></div>
      <div class="card stat-card inv-stat" data-filtro="con" style="${cs}" title="Ver en movimiento"><div class="icon-wrap" style="background:#7b1fa2"><span class="material-icons">trending_up</span></div><div class="label">En movimiento</div><div class="value">${enMovimiento}</div></div>
      <div class="card stat-card inv-stat" data-filtro="rellenar" style="${cs}" title="Ver los que hay que rellenar"><div class="icon-wrap bg-orange"><span class="material-icons">notifications_active</span></div><div class="label">A rellenar</div><div class="value">${rellenar}</div></div>
      <div class="card stat-card inv-stat" data-filtro="agotado" style="${cs}" title="Ver sin stock"><div class="icon-wrap bg-red"><span class="material-icons">remove_shopping_cart</span></div><div class="label">Sin stock</div><div class="value">${sinStock}</div></div>
      <div class="card stat-card inv-stat" data-filtro="variantes" style="${cs}" title="Variedades específicas en 0"><div class="icon-wrap" style="background:#d32f2f"><span class="material-icons">palette</span></div><div class="label">Variantes en 0</div><div class="value">${variantesEnCero}</div></div>
    `;

    grid.querySelectorAll('.inv-stat').forEach(card => {
      card.addEventListener('mouseenter', () => { card.style.transform='translateY(-3px)'; card.style.boxShadow='0 6px 20px rgba(0,0,0,0.1)'; });
      card.addEventListener('mouseleave', () => { card.style.transform=''; card.style.boxShadow=''; });
      card.addEventListener('click', () => {
        const filtro = card.dataset.filtro;
        // Para variantes y rellenar, simplemente hacemos scroll al panel correspondiente.
        if (filtro === 'variantes') {
          document.getElementById('invVariantesAgotadas')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (filtro === 'rellenar') {
          document.getElementById('invAlertas')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        // El resto abren la tabla (si está cerrada) y aplican el filtro.
        if (!tablaVisible) { tablaVisible = true; mostrarTabla(true); }
        const selEstado = document.getElementById('filtroEstado');
        const selMov    = document.getElementById('filtroMovimiento');
        if (filtro === 'con') {
          if (selEstado) selEstado.value = '';
          if (selMov) selMov.value = 'con';
        } else {
          if (selEstado) selEstado.value = filtro;
          if (selMov) selMov.value = '';
        }
        applyFilters();
        document.querySelector('.table-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  // Sparkline SVG simple — barras finas de ventas por día (14 días). Sin
  // dependencias externas, se renderiza inline.
  function renderSparkline(serie) {
    const el = document.getElementById('invSparkline');
    if (!el) return;
    const total14d = serie.reduce((a, d) => a + d.total, 0);
    if (total14d === 0) { el.innerHTML = ''; return; }
    const max = Math.max(...serie.map(d => d.total), 1);
    const W = 100, H = 28; // viewBox proporcional, escala con CSS
    const barW = W / serie.length;
    const bars = serie.map((d, i) => {
      const h = (d.total / max) * H;
      const x = i * barW + 0.5;
      const y = H - h;
      const isToday = i === serie.length - 1;
      return `<rect x="${x}" y="${y}" width="${barW - 1}" height="${h}" fill="${isToday ? '#7b1fa2' : '#a78bfa'}" rx="0.6"></rect>
              <text x="${x + (barW - 1)/2}" y="${H + 6}" font-size="3" fill="#9ca3af" text-anchor="middle">${d.label}</text>`;
    }).join('');
    const promedio = (total14d / serie.length).toFixed(1);
    const ultimos7 = serie.slice(-7).reduce((a, d) => a + d.total, 0);
    const previos7 = serie.slice(0, 7).reduce((a, d) => a + d.total, 0);
    const trendPct = previos7 > 0 ? Math.round(((ultimos7 - previos7) / previos7) * 100) : 0;
    const trendColor = trendPct > 0 ? '#2e7d32' : trendPct < 0 ? '#c62828' : '#65676b';
    const trendIco = trendPct > 0 ? 'trending_up' : trendPct < 0 ? 'trending_down' : 'trending_flat';

    el.innerHTML = `
      <div style="background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:14px;display:flex;align-items:center;gap:18px;flex-wrap:wrap">
        <div style="flex-shrink:0">
          <div style="font-size:11px;font-weight:700;color:#65676b;text-transform:uppercase;letter-spacing:0.5px">Ventas últimos 14 días</div>
          <div style="display:flex;align-items:baseline;gap:8px;margin-top:4px">
            <div style="font-size:24px;font-weight:800;color:#1c1e21">${total14d}</div>
            <div style="font-size:11px;color:#65676b">items vendidos</div>
          </div>
          <div style="display:flex;align-items:center;gap:4px;margin-top:2px;font-size:11px;color:${trendColor};font-weight:600">
            <span class="material-icons" style="font-size:14px">${trendIco}</span>
            ${Math.abs(trendPct)}% vs 7d previos · ${promedio}/día prom
          </div>
        </div>
        <div style="flex:1;min-width:240px">
          <svg viewBox="0 0 ${W} ${H + 8}" preserveAspectRatio="none" style="width:100%;height:60px;display:block">
            ${bars}
          </svg>
        </div>
      </div>`;
  }

  function renderTopMovers(top) {
    const el = document.getElementById('invTopMovers');
    if (!el) return;
    if (!top.length) {
      el.innerHTML = `
        <div style="background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:14px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span class="material-icons" style="color:#7b1fa2;font-size:18px">trending_up</span>
            <b style="font-size:13px;color:#7b1fa2">Top en movimiento</b>
          </div>
          <div style="font-size:12px;color:#65676b">Sin ventas registradas todavía.</div>
        </div>`;
      return;
    }
    const max = Math.max(...top.map(p => p.estado.velocidad || 0), 0.01);
    el.innerHTML = `
      <div style="background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span class="material-icons" style="color:#7b1fa2;font-size:18px">trending_up</span>
          <b style="font-size:13px;color:#7b1fa2">Top en movimiento</b>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px">
          ${top.map((p, i) => {
            const u = p.estado.unidad || _unidad(p);
            const stk = _stockEfectivo(p);
            const vel = p.estado.velocidad || 0;
            const w = Math.round((vel / max) * 100);
            const lowStock = p.estado.key === 'critico' || p.estado.key === 'agotado';
            return `
            <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;background:${lowStock?'#fff3f3':'#fafafa'}">
              <div style="width:18px;font-size:11px;font-weight:700;color:#7b1fa2;flex-shrink:0">${i+1}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:600;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.nombre}</div>
                <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
                  <div style="flex:1;background:#ede9fe;border-radius:99px;height:4px;overflow:hidden">
                    <div style="width:${w}%;height:100%;background:#7b1fa2"></div>
                  </div>
                  <span style="font-size:10px;color:#7b1fa2;font-weight:700;min-width:46px;text-align:right">${vel.toFixed(1)} ${u.pl}/d</span>
                </div>
              </div>
              <div style="text-align:right;flex-shrink:0;font-size:10px;color:${lowStock?'#c62828':'#65676b'};font-weight:${lowStock?'700':'500'}">${stk} ${u.sym}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  function renderVariantesAgotadas(productos) {
    const el = document.getElementById('invVariantesAgotadas');
    if (!el) return;
    if (!productos.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div style="background:#fff;border:1.5px solid #ffcc80;border-radius:12px;padding:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span class="material-icons" style="color:#e65100;font-size:18px">palette</span>
          <b style="font-size:13px;color:#e65100">Variantes en cero</b>
          <span style="font-size:11px;color:#65676b">— qué color/talle reponer</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${productos.map(p => {
            const vars = p.estado.varAgotadas || [];
            return `
            <div style="background:#fff8e1;border:1px solid #ffcc80;border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;min-width:200px;max-width:280px;flex:1">
              <div style="font-size:12px;font-weight:700;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.nombre}</div>
              <div style="display:flex;flex-wrap:wrap;gap:3px">
                ${vars.slice(0, 8).map(v => `<span style="background:#fff;border:1px solid #fb8c00;color:#e65100;padding:2px 7px;border-radius:99px;font-size:10px;font-weight:600">${v}</span>`).join('')}
                ${vars.length > 8 ? `<span style="font-size:10px;color:#65676b;align-self:center">+${vars.length - 8}</span>` : ''}
              </div>
              <button class="btn-rellenar-var" data-id="${p.doc_id}" style="margin-top:4px;background:#2e7d32;border:none;color:#fff;cursor:pointer;padding:5px;border-radius:6px;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:4px;font-family:inherit">
                <span class="material-icons" style="font-size:14px">add</span>
                Rellenar variedades
              </button>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    el.querySelectorAll('.btn-rellenar-var').forEach(btn => {
      btn.addEventListener('click', () => abrirModalRellenar(btn.dataset.id));
    });
  }

  function renderAlertas(alertas) {
    const el = document.getElementById('invAlertas');
    if (!el) return;
    if (!alertas.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div style="background:#fff3f3;border:1px solid #ef9a9a;border-radius:12px;padding:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span class="material-icons" style="color:#c62828;font-size:18px">notification_important</span>
          <b style="font-size:13px;color:#c62828">Tenés que rellenar</b>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${alertas.map(p => {
            const stk = _stockEfectivo(p);
            const u = p.estado.unidad || _unidad(p);
            const varAgotadas = p.estado.varAgotadas || [];
            const stockMin = p.estado.stockMin || 0;

            const qtyTxt = stk === 0
              ? `<span style="color:#c62828;font-weight:700">Sin ${u.pl}</span>`
              : `Quedan: <b style="color:#c62828">${stk} ${stk === 1 ? u.sg : u.pl}</b>${stockMin > 0 ? ` <span style="color:#9c27b0">(min ${stockMin})</span>` : ''}`;

            // Variedades en 0: las mostramos para que el usuario sepa qué color/talle reponer.
            const varTxt = varAgotadas.length > 0
              ? `<div style="font-size:11px;color:#c62828;margin-top:3px;font-weight:600">⚠ Sin: ${varAgotadas.slice(0, 5).join(', ')}${varAgotadas.length > 5 ? ` +${varAgotadas.length - 5}` : ''}</div>`
              : '';

            const velTxt = p.estado.velocidad > 0
              ? `<div style="font-size:11px;color:#65676b;margin-top:2px">${p.estado.velocidad.toFixed(1)} ${u.pl}/día</div>`
              : '';

            return `
            <div style="display:flex;align-items:center;justify-content:space-between;background:#fff;border-radius:8px;padding:8px 12px;border:1px solid #ef9a9a;gap:10px">
              <div style="flex:1;min-width:0">
                <div style="font-weight:700;font-size:13px">${p.nombre}</div>
                <div style="font-size:11px;color:#65676b">${p.rubro || p.categoria || '-'} · ${qtyTxt}</div>
                ${varTxt}
              </div>
              <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
                <span class="badge badge-red">${p.estado.label}</span>
                ${velTxt}
                <button class="btn-alert-rellenar" data-id="${p.doc_id}" style="background:#2e7d32;border:none;color:#fff;cursor:pointer;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:4px;font-family:inherit;margin-top:2px">
                  <span class="material-icons" style="font-size:14px">add</span>
                  Rellenar
                </button>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`;

    // Botones "Rellenar" desde el panel de alertas
    el.querySelectorAll('.btn-alert-rellenar').forEach(btn => {
      btn.addEventListener('click', () => abrirModalRellenar(btn.dataset.id));
    });
  }

  function applyFilters() {
    let data = getBase();
    const nombre = (document.getElementById('filtroNombre')?.value || '').trim();
    const cat    = document.getElementById('filtroCategoria')?.value || '';
    const estado = document.getElementById('filtroEstado')?.value || '';
    const mov    = document.getElementById('filtroMovimiento')?.value || '';

    // Filtro "Solo importante": cuando está ON y el usuario NO está buscando,
    // limitamos a lo accionable — productos que hay que rellenar o que se
    // están vendiendo. La búsqueda por nombre/código bypassea el filtro y
    // recorre el catálogo entero.
    if (soloRelevantes && !nombre) {
      data = data.filter(p => p.estado.rellenar || p.estado.velocidad > 0);
    }

    if (nombre) {
      // Búsqueda fuzzy: cada palabra debe aparecer en algún campo del producto
      const palabras = nombre.toLowerCase().split(/\s+/).filter(Boolean);
      data = data.filter(p => {
        const haystack = `${p.nombre||''} ${p.categoria||''} ${p.rubro||''} ${p.codigo||''} ${p.cod_barra||''}`.toLowerCase();
        return palabras.every(w => haystack.includes(w));
      });
    }
    if (cat)    data = data.filter(p => (p.categoria || 'Sin categoría') === cat);
    if (estado) data = data.filter(p => p.estado.key === estado);
    if (mov === 'con') data = data.filter(p => p.estado.velocidad > 0);
    if (mov === 'sin') data = data.filter(p => p.estado.velocidad === 0);

    data.sort((a,b) => {
      const orden = { agotado:0, critico:1, bajo:2, regular:3, ok:4 };
      return (orden[a.estado.key] ?? 5) - (orden[b.estado.key] ?? 5);
    });

    renderRows(data);
  }

  function renderRows(data) {
    const tbody = document.getElementById('invBody');
    const countEl = document.getElementById('invCount');
    if (!tbody) return;
    if (countEl) countEl.textContent = `${data.length} productos`;
    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-muted)">Sin productos</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map(p => {
      const stock = _stockEfectivo(p);
      const e = p.estado;
      const bgRow = e.key === 'agotado' ? 'background:#fff8f8' : e.key === 'critico' ? 'background:#fff3f3' : '';
      const pct = e.pct || 0;
      const barColor = pct <= 20 ? '#c62828' : pct <= 50 ? '#f57c00' : '#2e7d32';
      const barHtml = `
        <div style="display:flex;align-items:center;gap:6px">
          <div style="flex:1;background:#e4e6eb;border-radius:99px;height:6px;overflow:hidden;min-width:50px">
            <div style="width:${pct}%;height:100%;background:${barColor};border-radius:99px"></div>
          </div>
          <span style="font-size:11px;font-weight:700;color:${barColor};width:30px">${pct}%</span>
        </div>`;
      const diasTxt = e.dias !== null && e.dias !== undefined
        ? `<b style="color:${e.color}">${e.dias}d</b>`
        : `<span style="color:#bbb;font-size:11px">—</span>`;
      const velTxt = e.velocidad > 0
        ? `<span style="font-size:12px;color:#7b1fa2;font-weight:600">${e.velocidad.toFixed(2)}</span>`
        : `<span style="font-size:11px;color:#bbb">—</span>`;

      return `<tr style="${bgRow}">
        <td><b style="font-size:13px">${p.nombre || '-'}</b><br><span style="color:#65676b;font-size:10px">${p.cod_barra || ''}</span></td>
        <td class="inv-col-categoria"><span class="badge badge-gray">${p.categoria || '-'}</span></td>
        <td class="inv-col-rubro" style="font-size:11px;color:#65676b">${p.rubro || '-'}</td>
        <td style="text-align:center;font-weight:800;font-size:16px;color:${stock===0?'#c62828':stock<=3?'#f57c00':'#1c1e21'}">
          <span class="stock-val" data-id="${p.doc_id}" style="cursor:pointer;border-bottom:1px dashed #ccc" title="Click para editar">${stock}</span>
          <span style="font-size:10px;color:#65676b;font-weight:500;margin-left:2px">${(e.unidad?.sym) || 'u'}</span>
        </td>
        <td class="inv-col-dias" style="text-align:center">${diasTxt}</td>
        <td class="inv-col-cobertura">${barHtml}</td>
        <td class="inv-col-velocidad" style="text-align:center">${velTxt}</td>
        <td><span class="badge ${e.cls}">${e.label}</span></td>
        <td style="text-align:right;color:#2e7d32;font-weight:600">$${fmt(p.precio_venta || p.precio || 0)}</td>
        <td>
          <div style="display:flex;gap:4px;align-items:center">
            <button class="btn-rellenar" data-id="${p.doc_id}" style="background:${e.rellenar?'#2e7d32':'#fff'};border:1.5px solid ${e.rellenar?'#2e7d32':'#cfd8dc'};color:${e.rellenar?'#fff':'#2e7d32'};cursor:pointer;padding:5px 10px;border-radius:6px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:4px;font-family:inherit" title="Rellenar stock">
              <span class="material-icons" style="font-size:14px">add</span>
              Rellenar
            </button>
            <button class="btn-edit-stock" data-id="${p.doc_id}" style="background:none;border:none;cursor:pointer;color:#1877f2;padding:4px" title="Editar stock manualmente">
              <span class="material-icons" style="font-size:16px">edit</span>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');

    // Editar stock inline (popover anclado al elemento clickeado)
    document.querySelectorAll('.btn-edit-stock').forEach(btn => {
      btn.addEventListener('click', () => editarStock(btn.dataset.id, data, btn));
    });
    document.querySelectorAll('.stock-val').forEach(cell => {
      cell.addEventListener('click', () => editarStock(cell.dataset.id, data, cell));
    });
    document.querySelectorAll('.btn-rellenar').forEach(btn => {
      btn.addEventListener('click', () => abrirModalRellenar(btn.dataset.id, data));
    });
  }

  // Modal de RELLENAR — el flujo principal del inventario.
  // - Producto suelto: ingresás cuántos llegaron y se SUMAN al stock actual.
  // - Producto conjunto: lista de variedades con +/-, podés sumar packs/rollos
  //   por variedad y "sueltos". También permite sumar a una variedad nueva.
  function abrirModalRellenar(docId, data) {
    const fuente = data || prods;
    const p = fuente.find(x => x.doc_id === docId);
    if (!p) return;
    const u = _unidad(p);
    const esConj = p.es_conjunto === true || p.es_conjunto === 1;
    const stockActual = _stockEfectivo(p);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';

    if (esConj) {
      // === Modal de RELLENAR variantes (producto conjunto) ==================
      const desglose = _variedadesDesglose(p);
      const globalCont = Number(p.conjunto_contenido || 0);
      const tipoLabel = (p.conjunto_tipo || 'pack');

      overlay.innerHTML = `
        <div style="background:#fff;border-radius:18px;max-width:640px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,0.22);overflow:hidden">
          <div style="background:linear-gradient(135deg,#2e7d32,#1b5e20);padding:18px 22px;color:#fff;display:flex;align-items:center;justify-content:space-between">
            <div>
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:0.9">Rellenar stock</div>
              <div style="font-size:16px;font-weight:700;margin-top:2px">${p.nombre}</div>
              <div style="font-size:11px;opacity:0.9;margin-top:2px">${stockActual} ${stockActual===1?u.sg:u.pl} disponibles · ${desglose.length} ${desglose.length===1?'variedad':'variedades'}</div>
            </div>
            <button id="rell_cerrar" style="background:rgba(255,255,255,0.18);border:none;cursor:pointer;color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center">
              <span class="material-icons">close</span>
            </button>
          </div>

          <div style="padding:16px 22px;flex:1;overflow-y:auto">
            <div style="font-size:12px;color:#65676b;margin-bottom:10px;background:#f5f5f5;border-radius:8px;padding:10px 12px;line-height:1.4">
              Sumá los <b>${tipoLabel}s</b> que recibiste por variedad. ${globalCont > 0 ? `Cada ${tipoLabel} = ${globalCont} ${u.pl}.` : ''} Lo que cargues acá se <b>suma</b> al stock actual.
            </div>

            <div id="rell_lista" style="display:flex;flex-direction:column;gap:6px"></div>

            <button id="rell_add_var" type="button" style="margin-top:10px;background:none;border:1.5px dashed #cfd8dc;color:#7b1fa2;padding:8px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;display:flex;align-items:center;gap:4px;font-family:inherit">
              <span class="material-icons" style="font-size:16px">add</span>
              Agregar variedad nueva
            </button>

            <div id="rell_resumen" style="margin-top:14px;padding:10px 12px;background:#e8f5e9;border:1.5px solid #2e7d32;border-radius:8px;font-size:13px;color:#1b5e20;display:none"></div>
          </div>

          <div style="padding:14px 22px;border-top:1px solid #e4e6eb;display:flex;justify-content:flex-end;gap:8px;background:#fafafa">
            <button id="rell_cancel" style="padding:9px 18px;border-radius:8px;border:1.5px solid #e4e6eb;background:#fff;cursor:pointer;font-size:13px;font-weight:600;color:#65676b">Cancelar</button>
            <button id="rell_guardar" style="padding:9px 22px;border-radius:8px;border:none;background:#2e7d32;color:#fff;cursor:pointer;font-size:13px;font-weight:700">Sumar al stock</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      const lista = overlay.querySelector('#rell_lista');
      const resumenEl = overlay.querySelector('#rell_resumen');

      // Render una fila por variedad existente. Cada fila tiene:
      //   color (readonly) · packs +/- · sueltos +/-
      // El usuario solo escribe lo que LLEGÓ (no el stock final).
      function _addVariedadRow(color = '', existente = null, esNueva = false) {
        const row = document.createElement('div');
        row.dataset.varRow = '1';
        row.dataset.esNueva = esNueva ? '1' : '0';
        row.style.cssText = 'display:grid;grid-template-columns:1fr 90px 90px;gap:8px;align-items:center;background:#fff;border:1.5px solid #e5e7eb;border-radius:10px;padding:8px 10px';
        const stockExistente = existente ? `${existente.total} ${u.pl}` : 'nueva';
        row.innerHTML = `
          <div style="min-width:0">
            ${esNueva
              ? `<input class="r_color" type="text" placeholder="Nombre variedad" value="${color}" style="width:100%;padding:6px 8px;border:1.5px solid #fb923c;border-radius:6px;font-size:12px;box-sizing:border-box;font-family:inherit;background:#fff7ed" />`
              : `<div style="font-size:13px;font-weight:700">${color}</div>
                 <div style="font-size:10px;color:#65676b">Tenés: ${stockExistente}</div>`}
          </div>
          <div>
            <div style="font-size:9px;font-weight:700;color:#9ca3af;letter-spacing:0.5px;text-align:center">${tipoLabel.toUpperCase()}S +</div>
            <input class="r_packs" type="number" min="0" step="1" placeholder="0" style="width:100%;padding:6px;border:1.5px solid #cfd8dc;border-radius:6px;font-size:14px;text-align:center;box-sizing:border-box;font-family:inherit;font-weight:700" />
          </div>
          <div>
            <div style="font-size:9px;font-weight:700;color:#9ca3af;letter-spacing:0.5px;text-align:center">SUELTOS +</div>
            <input class="r_sueltos" type="number" min="0" step="0.01" placeholder="0" style="width:100%;padding:6px;border:1.5px solid #cfd8dc;border-radius:6px;font-size:14px;text-align:center;box-sizing:border-box;font-family:inherit" />
          </div>
        `;
        lista.appendChild(row);
        row.querySelectorAll('input').forEach(i => i.addEventListener('input', actualizarResumen));
      }

      // Variedades existentes
      desglose.forEach(d => _addVariedadRow(d.color, d));
      // Si no hay variedades, dejamos vacío y mostramos botón para agregar.

      overlay.querySelector('#rell_add_var').addEventListener('click', () => {
        _addVariedadRow('', null, true);
      });

      function actualizarResumen() {
        let totalPacks = 0;
        let totalSueltos = 0;
        let nuevasVariedades = 0;
        overlay.querySelectorAll('[data-var-row]').forEach(r => {
          const packs   = parseInt(r.querySelector('.r_packs').value) || 0;
          const sueltos = parseFloat(r.querySelector('.r_sueltos').value) || 0;
          const esNueva = r.dataset.esNueva === '1';
          if (esNueva && (packs > 0 || sueltos > 0)) nuevasVariedades += 1;
          totalPacks   += packs;
          totalSueltos += sueltos;
        });
        const totalUnidades = (totalPacks * (globalCont || 1)) + totalSueltos;
        if (totalPacks === 0 && totalSueltos === 0) {
          resumenEl.style.display = 'none';
        } else {
          resumenEl.style.display = 'block';
          resumenEl.innerHTML = `
            <b>Vas a sumar:</b> ${totalPacks} ${tipoLabel}${totalPacks===1?'':'s'}${totalSueltos>0?` + ${totalSueltos} sueltos`:''}
            ${globalCont > 0 ? ` = <b>${totalUnidades} ${u.pl}</b>` : ''}
            ${nuevasVariedades > 0 ? `<br><span style="font-size:11px">(${nuevasVariedades} ${nuevasVariedades===1?'variedad nueva':'variedades nuevas'})</span>` : ''}
          `;
        }
      }

      const cerrar = () => overlay.remove();
      overlay.querySelector('#rell_cerrar').addEventListener('click', cerrar);
      overlay.querySelector('#rell_cancel').addEventListener('click', cerrar);
      overlay.addEventListener('click', e => { if (e.target === overlay) cerrar(); });

      overlay.querySelector('#rell_guardar').addEventListener('click', async () => {
        const btn = overlay.querySelector('#rell_guardar');
        btn.disabled = true;
        btn.textContent = 'Guardando...';

        // Construir el nuevo array de conjunto_colores: las variedades existentes
        // conservan TODO (precio, costo, codigo, margen, contenido) y solo se les
        // suman packs + sueltos a unidades/restante. Las nuevas se agregan con
        // los datos básicos.
        const filas = Array.from(overlay.querySelectorAll('[data-var-row]'));
        const existentesActualizadas = [];
        const nuevasACrear = [];
        let huboCambios = false;

        filas.forEach((r, idx) => {
          const packs   = parseInt(r.querySelector('.r_packs').value) || 0;
          const sueltos = parseFloat(r.querySelector('.r_sueltos').value) || 0;
          const esNueva = r.dataset.esNueva === '1';

          if (esNueva) {
            const nombre = (r.querySelector('.r_color')?.value || '').trim();
            if (nombre && (packs > 0 || sueltos > 0)) {
              huboCambios = true;
              nuevasACrear.push({ color: nombre, unidades: packs, restante: sueltos });
            }
            return;
          }

          // Existente: tomamos el original y le sumamos lo nuevo.
          const original = desglose[idx];
          const orig = (Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [])
            .find(c => (c.color || '').toLowerCase() === (original?.color || '').toLowerCase()) || {};
          if (packs > 0 || sueltos > 0) huboCambios = true;
          existentesActualizadas.push({
            ...orig,
            unidades: (Number(orig.unidades) || 0) + packs,
            restante: (Number(orig.restante) || 0) + sueltos,
          });
        });

        // Conservar variedades del producto que no aparecieron en el modal (no
        // las pisamos). Esto cubre desglose vacío fallback.
        const nombresEditados = new Set(existentesActualizadas.map(c => (c.color || '').toLowerCase()));
        const restoOriginal = (Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [])
          .filter(c => !nombresEditados.has((c.color || '').toLowerCase()));

        const nuevoConjunto = [...existentesActualizadas, ...restoOriginal, ...nuevasACrear];

        if (!huboCambios) {
          alert('No cargaste nada para sumar.');
          btn.disabled = false;
          btn.textContent = 'Sumar al stock';
          return;
        }

        try {
          // Recalcular conjunto_total para que la UI vea el nuevo total al instante.
          const totalNuevo = nuevoConjunto.reduce((acc, c) => {
            const uu = Number(c.unidades) || 0;
            const rr = Number(c.restante) || 0;
            const cc = (Number(c.contenido) > 0) ? Number(c.contenido) : globalCont;
            return acc + (uu * cc + rr);
          }, 0);
          await updateDoc(doc(db, 'catalogo', p.doc_id), {
            conjunto_colores: nuevoConjunto,
            conjunto_total: Math.round(totalNuevo),
            ultima_actualizacion: serverTimestamp(),
          });
          invalidateCacheByPrefix('catalogo');
          invalidateCacheByPrefix('inv:');
          const idx = prods.findIndex(x => x.doc_id === p.doc_id);
          if (idx !== -1) {
            prods[idx].conjunto_colores = nuevoConjunto;
            prods[idx].conjunto_total = Math.round(totalNuevo);
            prods[idx].estado = calcularEstado(prods[idx]);
          }
          cerrar();
          applyFilters();
        } catch (err) {
          alert('Error al guardar: ' + err.message);
          btn.disabled = false;
          btn.textContent = 'Sumar al stock';
        }
      });

      return;
    }

    // === Modal de RELLENAR simple (producto suelto) ==========================
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;max-width:380px;width:100%;box-shadow:0 12px 48px rgba(0,0,0,0.22);overflow:hidden">
        <div style="background:linear-gradient(135deg,#2e7d32,#1b5e20);padding:16px 20px;color:#fff;display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:0.9">Rellenar stock</div>
            <div style="font-size:15px;font-weight:700;margin-top:2px">${p.nombre}</div>
          </div>
          <button id="rell_cerrar2" style="background:rgba(255,255,255,0.18);border:none;cursor:pointer;color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center">
            <span class="material-icons">close</span>
          </button>
        </div>
        <div style="padding:16px 20px">
          <div style="font-size:12px;color:#65676b;margin-bottom:8px">Stock actual: <b>${stockActual} ${stockActual===1?u.sg:u.pl}</b></div>
          <label style="font-size:11px;font-weight:700;color:#65676b;text-transform:uppercase;letter-spacing:0.5px">¿Cuántos llegaron?</label>
          <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
            <button type="button" data-step="-10" style="width:38px;height:42px;border-radius:8px;border:1.5px solid #e4e6eb;background:#fff;cursor:pointer;font-size:11px;font-weight:700">-10</button>
            <button type="button" data-step="-1" style="width:38px;height:42px;border-radius:8px;border:1.5px solid #e4e6eb;background:#fff;cursor:pointer;font-size:18px;font-weight:700">−</button>
            <input id="rell_qty" type="number" min="0" step="1" value="1" style="flex:1;text-align:center;padding:9px;border:1.5px solid #2e7d32;border-radius:8px;font-size:20px;font-weight:800;font-family:inherit;box-sizing:border-box" />
            <button type="button" data-step="1" style="width:38px;height:42px;border-radius:8px;border:1.5px solid #e4e6eb;background:#fff;cursor:pointer;font-size:18px;font-weight:700">+</button>
            <button type="button" data-step="10" style="width:38px;height:42px;border-radius:8px;border:1.5px solid #e4e6eb;background:#fff;cursor:pointer;font-size:11px;font-weight:700">+10</button>
          </div>
          <div id="rell_resumen2" style="margin-top:12px;padding:10px 12px;background:#e8f5e9;border:1.5px solid #2e7d32;border-radius:8px;font-size:13px;color:#1b5e20"></div>
        </div>
        <div style="padding:12px 20px;border-top:1px solid #e4e6eb;display:flex;justify-content:flex-end;gap:8px;background:#fafafa">
          <button id="rell_cancel2" style="padding:8px 16px;border-radius:8px;border:1.5px solid #e4e6eb;background:#fff;cursor:pointer;font-size:13px;font-weight:600;color:#65676b">Cancelar</button>
          <button id="rell_guardar2" style="padding:8px 18px;border-radius:8px;border:none;background:#2e7d32;color:#fff;cursor:pointer;font-size:13px;font-weight:700">Sumar al stock</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const inp = overlay.querySelector('#rell_qty');
    const resumenEl = overlay.querySelector('#rell_resumen2');
    const refreshResumen = () => {
      const q = parseInt(inp.value) || 0;
      resumenEl.textContent = q > 0
        ? `Te van a quedar: ${stockActual + q} ${(stockActual + q) === 1 ? u.sg : u.pl}`
        : 'Ingresá una cantidad mayor a 0.';
    };
    inp.addEventListener('input', refreshResumen);
    inp.focus(); inp.select();
    refreshResumen();

    overlay.querySelectorAll('button[data-step]').forEach(b => {
      b.addEventListener('click', () => {
        const cur = parseInt(inp.value) || 0;
        inp.value = Math.max(0, cur + parseInt(b.dataset.step));
        refreshResumen();
      });
    });

    const cerrar = () => overlay.remove();
    overlay.querySelector('#rell_cerrar2').addEventListener('click', cerrar);
    overlay.querySelector('#rell_cancel2').addEventListener('click', cerrar);
    overlay.addEventListener('click', e => { if (e.target === overlay) cerrar(); });

    overlay.querySelector('#rell_guardar2').addEventListener('click', async () => {
      const q = parseInt(inp.value);
      if (!q || q <= 0) { alert('Cantidad inválida.'); return; }
      const btn = overlay.querySelector('#rell_guardar2');
      btn.disabled = true; btn.textContent = 'Guardando...';
      const nuevoStock = stockActual + q;
      try {
        await updateDoc(doc(db, 'catalogo', p.doc_id), { stock: nuevoStock, ultima_actualizacion: serverTimestamp() });
        invalidateCacheByPrefix('catalogo');
        invalidateCacheByPrefix('inv:');
        const idx = prods.findIndex(x => x.doc_id === p.doc_id);
        if (idx !== -1) {
          prods[idx].stock = nuevoStock;
          prods[idx].estado = calcularEstado(prods[idx]);
        }
        cerrar();
        applyFilters();
      } catch (err) {
        alert('Error al guardar: ' + err.message);
        btn.disabled = false; btn.textContent = 'Sumar al stock';
      }
    });
  }

  async function editarStock(docId, data, anchorEl) {
    const p = data.find(x => x.doc_id === docId);
    if (!p) return;
    // Productos conjunto: no se puede editar con un popover simple (tienen
    // unidades cerradas, restante y eventualmente colores). El editor real
    // está en Catálogo.
    if (p.es_conjunto === true || p.es_conjunto === 1) {
      alert(
        `"${p.nombre}" es un producto conjunto (rollo/pack/caja).\n\n` +
        'Editá su stock desde Catálogo → abrí el producto y usá el bloque "PRODUCTO CONJUNTO".'
      );
      return;
    }
    abrirPopoverStock(p, anchorEl);
  }

  // Popover inline para editar stock: [- N +] [✓ Guardar] [✕]
  // Aparece pegado al elemento clickeado y se cierra al click afuera, Esc o
  // tras guardar. Se usa solo para productos NO-conjunto.
  function abrirPopoverStock(p, anchorEl) {
    // Cerrar cualquier popover previo
    document.querySelectorAll('.stock-popover').forEach(el => el.remove());

    const u = _unidad(p);
    const valorInicial = Number(p.stock) || 0;

    const pop = document.createElement('div');
    pop.className = 'stock-popover';
    pop.style.cssText = 'position:absolute;z-index:1000;background:#fff;border:1.5px solid #1877f2;border-radius:10px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,0.18);display:flex;flex-direction:column;gap:8px;min-width:240px;font-family:inherit';
    pop.innerHTML = `
      <div style="font-size:12px;color:#65676b;font-weight:600;line-height:1.3">
        ${p.nombre}<br>
        <span style="color:#1877f2">Stock actual: ${valorInicial} ${valorInicial === 1 ? u.sg : u.pl}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <button type="button" data-step="-10" style="width:36px;height:36px;border-radius:8px;border:1.5px solid #e4e6eb;background:#fff;cursor:pointer;font-size:11px;font-weight:700;color:#c62828">-10</button>
        <button type="button" data-step="-1"  style="width:36px;height:36px;border-radius:8px;border:1.5px solid #e4e6eb;background:#fff;cursor:pointer;font-size:18px;font-weight:700;color:#c62828">−</button>
        <input type="number" min="0" step="1" value="${valorInicial}" class="sp-input" style="flex:1;text-align:center;padding:8px;border:1.5px solid #1877f2;border-radius:8px;font-size:18px;font-weight:800;font-family:inherit;box-sizing:border-box" />
        <button type="button" data-step="1"   style="width:36px;height:36px;border-radius:8px;border:1.5px solid #e4e6eb;background:#fff;cursor:pointer;font-size:18px;font-weight:700;color:#2e7d32">+</button>
        <button type="button" data-step="10"  style="width:36px;height:36px;border-radius:8px;border:1.5px solid #e4e6eb;background:#fff;cursor:pointer;font-size:11px;font-weight:700;color:#2e7d32">+10</button>
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end">
        <button type="button" class="sp-cancel" style="padding:7px 14px;border-radius:8px;border:1.5px solid #e4e6eb;background:#fff;cursor:pointer;font-size:13px;font-weight:600;color:#65676b">Cancelar</button>
        <button type="button" class="sp-save" style="padding:7px 14px;border-radius:8px;border:none;background:#1877f2;color:#fff;cursor:pointer;font-size:13px;font-weight:700">Guardar</button>
      </div>
    `;

    document.body.appendChild(pop);

    // Posicionar el popover pegado al elemento ancla
    const rect = (anchorEl || document.body).getBoundingClientRect();
    const top  = rect.bottom + window.scrollY + 6;
    let left   = rect.left + window.scrollX;
    // Evitar que se vaya fuera de la ventana por la derecha
    const popW = 260;
    if (left + popW > window.innerWidth - 12) left = window.innerWidth - popW - 12;
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(12, left)}px`;

    const input = pop.querySelector('.sp-input');
    input.focus();
    input.select();

    pop.querySelectorAll('button[data-step]').forEach(b => {
      b.addEventListener('click', () => {
        const cur = parseInt(input.value) || 0;
        const nuevo = Math.max(0, cur + parseInt(b.dataset.step));
        input.value = nuevo;
        input.focus();
      });
    });

    const cerrar = () => pop.remove();
    pop.querySelector('.sp-cancel').addEventListener('click', cerrar);
    pop.querySelector('.sp-save').addEventListener('click', async () => {
      const valor = parseInt(input.value);
      if (isNaN(valor) || valor < 0) { alert('Stock inválido'); return; }
      const btn = pop.querySelector('.sp-save');
      btn.disabled = true;
      btn.textContent = 'Guardando...';
      try {
        await updateDoc(doc(db, 'catalogo', p.doc_id), { stock: valor, ultima_actualizacion: serverTimestamp() });
        invalidateCacheByPrefix('catalogo');
        invalidateCacheByPrefix('inv:');
        const idx = prods.findIndex(x => x.doc_id === p.doc_id);
        if (idx !== -1) {
          prods[idx].stock = valor;
          prods[idx].estado = calcularEstado(prods[idx]);
        }
        cerrar();
        applyFilters();
      } catch(e) {
        alert('Error al guardar: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Guardar';
      }
    });

    // Click afuera o Escape → cerrar
    const onDocClick = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchorEl) {
        cerrar();
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onKey);
      }
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        cerrar();
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onKey);
      } else if (ev.key === 'Enter' && pop.contains(document.activeElement)) {
        ev.preventDefault();
        pop.querySelector('.sp-save').click();
      }
    };
    setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey);
    }, 0);
  }

  renderShell();
}
