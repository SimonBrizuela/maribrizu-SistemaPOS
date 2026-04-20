import {
  collection, getDocs, doc, setDoc, updateDoc, getDoc,
  query, orderBy, writeBatch, deleteDoc, limit, serverTimestamp
} from 'firebase/firestore';
import { getCached, invalidateCache, invalidateCacheByPrefix } from '../cache.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function slugify(str) {
  return (str || '').toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseNum(str) {
  if (!str || str === 'Costo' || str === '*') return 0;
  return parseFloat(String(str).replace(/\./g, '').replace(',', '.')) || 0;
}


// ── Parsear CSV de librería ───────────────────────────────────────────────────
// ── Normalización de categorías ───────────────────────────────────────────────
// Mapa de sinónimos → categoría canónica
const CATEGORIA_MAP = {
  // Lapiceras / Bolígrafos
  'BOLIGRAFO':        'LAPICERA',
  'BOLIGRAFOS':       'LAPICERA',
  'BOLÍGRAFO':        'LAPICERA',
  'BOLÍGRAFOS':       'LAPICERA',
  'LAPICERA':         'LAPICERA',
  'LAPICERAS':        'LAPICERA',
  'BIROME':           'LAPICERA',
  'BIROMES':          'LAPICERA',
  'LAPICERO':         'LAPICERA',
  'LAPICEROS':        'LAPICERA',
  'BOLIGRAFO BORRABLE': 'LAPICERA',
  'ROLLER':           'LAPICERA',
  'ROLLERS':          'LAPICERA',
  'PLUMA':            'LAPICERA',
  'PLUMAS':           'LAPICERA',

  // Lápices
  'LAPIZ':            'LAPIZ',
  'LAPICES':          'LAPIZ',
  'LÁPIZ':            'LAPIZ',
  'LÁPICES':          'LAPIZ',
  'LAPIZ COLOR':      'LAPIZ COLOR',
  'LAPICES COLOR':    'LAPIZ COLOR',
  'LAPIZ DE COLOR':   'LAPIZ COLOR',
  'LAPIZ BICOLOR':    'LAPIZ COLOR',
  'BICOLOR':          'LAPIZ COLOR',

  // Marcadores
  'MARCADOR':         'MARCADOR',
  'MARCADORES':       'MARCADOR',
  'FIBRA':            'MARCADOR',
  'FIBRAS':           'MARCADOR',
  'MICROFIBRA':       'MARCADOR',
  'MICROFIBRAS':      'MARCADOR',
  'RESALTADOR':       'RESALTADOR',
  'RESALTADORES':     'RESALTADOR',
  'FLUORESCENTE':     'RESALTADOR',

  // Gomas
  'GOMA':             'GOMA DE BORRAR',
  'GOMAS':            'GOMA DE BORRAR',
  'GOMA BORRAR':      'GOMA DE BORRAR',
  'GOMA DE BORRAR':   'GOMA DE BORRAR',
  'BORRADOR':         'GOMA DE BORRAR',
  'BORRADORES':       'GOMA DE BORRAR',

  // Cuadernos
  'CUADERNO':         'CUADERNO',
  'CUADERNOS':        'CUADERNO',
  'LIBRETA':          'CUADERNO',
  'LIBRETAS':         'CUADERNO',
  'BLOCK':            'BLOCK',
  'BLOCKS':           'BLOCK',
  'PORTA-BLOCK':      'BLOCK',
  'PORTA BLOCK':      'BLOCK',

  // Tijeras
  'TIJERA':           'TIJERA',
  'TIJERAS':          'TIJERA',

  // Cintas
  'CINTA':            'CINTA',
  'CINTAS':           'CINTA',
  'CINTA ADHESIVA':   'CINTA',
  'RIBBONETTE':       'CINTA',

  // Papel
  'PAPEL':            'PAPEL',
  'PAPELES':          'PAPEL',
  'HOJA':             'PAPEL',
  'HOJAS':            'PAPEL',
  'RESMA':            'PAPEL',
  'RESMAS':           'PAPEL',

  // Carpetas / Fundas
  'CARPETA':          'CARPETA',
  'CARPETAS':         'CARPETA',
  'FUNDA':            'CARPETA',
  'FUNDAS':           'CARPETA',
  'PORTAFOLIO':       'CARPETA',

  // Broches / Clips
  'BROCHE':           'BROCHE',
  'BROCHES':          'BROCHE',
  'CLIP':             'BROCHE',
  'CLIPS':            'BROCHE',
  'GANCHO':           'BROCHE',

  // Pegamentos
  'ADHESIVO':         'PEGAMENTO',
  'PEGAMENTO':        'PEGAMENTO',
  'PLASTICOLA':       'PEGAMENTO',
  'COLA':             'PEGAMENTO',
  'CINTA DOBLE FAZ':  'PEGAMENTO',
  'CINTA DOBLE FAZ':  'PEGAMENTO',

  // Corrector
  'CORRECTOR':        'CORRECTOR',
  'CORRECTORES':      'CORRECTOR',
  'LIQUID PAPER':     'CORRECTOR',

  // Reglas / Geometría
  'REGLA':            'GEOMETRÍA',
  'REGLAS':           'GEOMETRÍA',
  'ESCUADRA':         'GEOMETRÍA',
  'COMPAS':           'GEOMETRÍA',
  'COMPÁS':           'GEOMETRÍA',
  'TRANSPORTADOR':    'GEOMETRÍA',
  'GEOMETRIA':        'GEOMETRÍA',
  'GEOMETRÍA':        'GEOMETRÍA',

  // Juguetería / Recreación
  'JUGUETE':          'JUGUETERÍA',
  'JUGUETES':         'JUGUETERÍA',
  'JUGUETERIA':       'JUGUETERÍA',
  'JUGUETERÍA':       'JUGUETERÍA',

  // Bazar
  'BAZAR':            'BAZAR',
  'ARTICULO DE BAZAR':'BAZAR',
  'ARTÍCULOS BAZAR':  'BAZAR',

  // Escarapelas / Decoración
  'ESCARAPELA':       'DECORACIÓN',
  'ESCARAPELAS':      'DECORACIÓN',
  'DECORACION':       'DECORACIÓN',
  'DECORACIÓN':       'DECORACIÓN',

  // Sobres / Embalaje
  'SOBRE':            'SOBRE',
  'SOBRES':           'SOBRE',

  // Rollos / Recibos
  'ROLLO':            'ROLLO TÉRMICO',
  'ROLLOS':           'ROLLO TÉRMICO',
  'ROLLO TERMICO':    'ROLLO TÉRMICO',
  'ROLLO TÉRMICO':    'ROLLO TÉRMICO',

  // Stamping / Sellos
  'SELLO':            'SELLO',
  'SELLOS':           'SELLO',
  'TAMPÓN':           'SELLO',
  'TAMPON':           'SELLO',
};

function normalizarCategoria(raw) {
  if (!raw) return 'SIN CATEGORÍA';
  const upper = raw.toUpperCase().trim();
  // Primero intentar match exacto
  if (CATEGORIA_MAP[upper]) return CATEGORIA_MAP[upper];
  // Luego intentar si alguna clave está contenida en el valor
  for (const [key, val] of Object.entries(CATEGORIA_MAP)) {
    if (upper.includes(key)) return val;
  }
  return upper;
}

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function parseCatalogoCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const idx = {
    codigo:    headers.findIndex(h => h === 'Codigo'),
    nombre:    headers.findIndex(h => h === 'Producto'),
    codBarra:  headers.findIndex(h => h === 'Cod Barra'),
    rubro:     headers.findIndex(h => h === 'Rubro'),
    subRubro:  headers.findIndex(h => h === 'Sub Rubro'),
    proveedor: headers.findIndex(h => h === 'Proveedor'),
    marca:     headers.findIndex(h => h === 'Marca'),
    moneda:    headers.findIndex(h => h === 'Moneda'),
    costo:     headers.findIndex(h => h === 'Costo'),
    costoNeo:  headers.findIndex(h => h.includes('Costo Neo') || h === 'Costo Neo'),
    stock:     headers.findIndex(h => h === 'STOCK'),
  };

  const productos = [];
  const seen = new Map(); // nombre normalizado → índice en array

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const nombre = (cols[idx.nombre] || '').trim();
    // Saltar productos vacíos o marcados como *
    if (!nombre || nombre === '*' || nombre === '') continue;

    const codigo = (cols[idx.codigo] || '').trim();
    const costo = parseNum(cols[idx.costo]);
    const costoNeo = parseNum(cols[idx.costoNeo]);
    const precioVenta = costoNeo > 0 ? costoNeo : costo;
    const stock = parseNum(cols[idx.stock]);
    const key = slugify(nombre);

    const margen_original = costoNeo > 0 && costo > 0 ? Math.round(((costoNeo - costo) / costo) * 100) : 0;

    const producto = {
      codigo,
      nombre: nombre.toUpperCase(),
      cod_barra: (cols[idx.codBarra] || '').trim(),
      rubro:     idx.rubro >= 0 ? (cols[idx.rubro] || '').toUpperCase().trim() : '',
      categoria: normalizarCategoria(cols[idx.subRubro] || ''),
      proveedor: (cols[idx.proveedor] || 'SIN PROVEEDOR').trim(),
      marca: (cols[idx.marca] || 'SIN MARCA').toUpperCase().trim(),
      moneda: (cols[idx.moneda] || 'PESOS').trim(),
      costo,
      precio_venta: precioVenta,
      stock: Math.max(0, stock),
      estado: costo === 0 ? 'sin_precio' : 'activo',
      duplicado: false,
      margen_original,
      ultima_actualizacion: serverTimestamp(),
      historial_precios: [],
    };

    if (seen.has(key)) {
      // Marcar ambos como duplicados
      const prevIdx = seen.get(key);
      productos[prevIdx].duplicado = true;
      producto.duplicado = true;
    } else {
      seen.set(key, productos.length);
    }
    productos.push(producto);
  }
  return productos;
}

// ── Subir a Firebase en batches ───────────────────────────────────────────────
async function subirCatalogoFirebase(db, productos, onProgress) {
  const BATCH_SIZE = 400;
  let count = 0;
  for (let i = 0; i < productos.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    const chunk = productos.slice(i, i + BATCH_SIZE);
    for (const p of chunk) {
      const id = p.codigo || slugify(p.nombre) || `prod-${i}-${count}`;
      const ref = doc(collection(db, 'catalogo'), id);
      batch.set(ref, { ...p, doc_id: id });
    }
    await batch.commit();
    count += chunk.length;
    if (onProgress) onProgress(count, productos.length);
  }
  _touchCatalogoMeta(db).catch(() => {});
}

// ── Parsear CSV de proveedor (Montenegro) ─────────────────────────────────────
function parseProveedorCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const idxNombre   = headers.findIndex(h => h === 'Producto' || h === 'producto' || h === 'PRODUCTO');
  const idxCosto    = headers.findIndex(h => h === 'Costo' || h === 'costo' || h === 'COSTO' || h === 'Precio');
  const idxCod      = headers.findIndex(h => h === 'Codigo' || h === 'codigo' || h === 'CODIGO');
  const idxBarra    = headers.findIndex(h => h === 'Cod Barra' || h === 'CodBarra' || h === 'cod_barra');
  const idxSubRubro = headers.findIndex(h => h === 'Sub Rubro' || h === 'sub_rubro' || h === 'SUB RUBRO' || h === 'Categoria' || h === 'categoria');

  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const nombre = (cols[idxNombre >= 0 ? idxNombre : 1] || '').trim();
    if (!nombre || nombre === '*') continue;
    result.push({
      codigo:    idxCod >= 0 ? (cols[idxCod] || '').trim() : '',
      nombre:    nombre.toUpperCase(),
      cod_barra: idxBarra >= 0 ? (cols[idxBarra] || '').trim() : '',
      costo:     idxCosto >= 0 ? parseNum(cols[idxCosto]) : 0,
      categoria: normalizarCategoria(cols[idxSubRubro >= 0 ? idxSubRubro : -1] || ''),
    });
  }
  return result;
}

// ── Render principal ──────────────────────────────────────────────────────────
/**
 * Escribe un timestamp en config/catalogo_meta para que el POS sepa
 * que el catálogo cambió y deba re-sincronizar en el próximo arranque.
 * Fire-and-forget: no bloquea la UI si Firebase está lento.
 */
async function _touchCatalogoMeta(db) {
  try {
    await setDoc(doc(db, 'config', 'catalogo_meta'), {
      last_updated: serverTimestamp(),
    }, { merge: true });
  } catch(e) { /* silently ignore */ }
}

/**
 * Registra un "tombstone" de producto eliminado en catalogo_deleted/{id}.
 * El POS consulta esta colección filtrando por deleted_at > last_sync
 * para eliminar solo los productos borrados desde el último sync.
 */
export async function _registerCatalogoDeleted(db, docId) {
  try {
    await setDoc(doc(db, 'catalogo_deleted', docId), {
      deleted_at: serverTimestamp(),
    });
  } catch(e) { /* silently ignore */ }
}

export async function renderCatalogo(container, db) {
  // Estado local
  let allProductos = [];
  let filtrados = [];
  let currentPage = 1;
  const PER_PAGE = 50;

  // Inventario: velocidad de venta (lazy-load cuando se abre la pestaña o el banner)
  let ventasProd = null;      // { 'NOMBRE': { u30, u7 } }
  let invEstadoFiltro = '';   // filtro de estado activo en tab Inventario
  let invMovFiltro = '';
  let invNombreFiltro = '';
  let invCatFiltro = '';

  // Rubros disponibles — persistidos en Firebase config
  // Los nuevos rubros se cargan dinámicamente desde config/rubros en Firebase
  const RUBROS_DEFAULT = [
    'LIBRERÍA','MERCERÍA','JUGUETERÍA','ARTÍSTICA','COTILLÓN','INFORMÁTICA','TELGOPOR',
    'ACCESORIOS','LENCERIA','NAVIDAD','PAPELERA','PERFUMERIA','REGALERIA','SELLOS','SERVICIOS',
  ];
  const RUBROS = [...RUBROS_DEFAULT];

  async function cargarRubros() {
    try {
      const snap = await getDoc(doc(db, 'config', 'rubros'));
      if (snap.exists() && snap.data().lista) {
        RUBROS.length = 0;
        snap.data().lista.forEach(r => RUBROS.push(r));
      }
    } catch(e) {}
  }

  async function guardarRubros() {
    try {
      await setDoc(doc(db, 'config', 'rubros'), { lista: [...RUBROS] });
    } catch(e) {}
  }
  let rubroActivo = 'TODOS';

  // Mapa de categorías por rubro (orientativo, extendible)
  // Para rubros nuevos cargados desde CSV se usa el campo 'rubro' directamente.
  const RUBRO_CATS = {
    'LIBRERÍA':    ['LAPICERA','LAPIZ','LAPIZ COLOR','MARCADOR','RESALTADOR','GOMA DE BORRAR','CUADERNO','BLOCK','TIJERA','CINTA','PAPEL','CARPETA','BROCHE','PEGAMENTO','CORRECTOR','GEOMETRÍA','ROLLO TÉRMICO','SELLO','SOBRE','DECORACIÓN'],
    'MERCERÍA':    ['AGUJA','HILO','BOTÓN','TELA','CINTA MERCERÍA','CIERRE','ELÁSTICO','IMPERDIBLE','TIJERA MERCERÍA','DEDAL','LANA'],
    'JUGUETERÍA':  ['JUGUETERÍA','MUÑECA','AUTO','ROMPECABEZAS','JUEGO DE MESA','PELUCHE','DIDÁCTICO','ARTE Y MANUALIDADES'],
    'ACCESORIOS':  [],   // filtrado por campo rubro
    'LENCERIA':    [],
    'NAVIDAD':     [],
    'PAPELERA':    [],
    'PERFUMERIA':  [],
    'REGALERIA':   [],
    'SELLOS':      [],
    'SERVICIOS':   [],
  };

  // Cargar datos de Firebase con loader (con cache compartido con dashboard)
  async function cargarDatos() {
    mostrarLoader('Conectando con la base de datos...');
    allProductos = await getCached('catalogo:all', async () => {
      const snap = await getDocs(query(collection(db, 'catalogo'), orderBy('nombre')));
      actualizarLoader(`Procesando ${snap.docs.length} productos...`);
      return snap.docs.map(d => ({ doc_id: d.id, ...d.data() }));
    }, { ttl: 10 * 60 * 1000, memOnly: true });
    filtrados = [...allProductos];
  }

  function mostrarLoader(msg) {
    const tc = document.getElementById('tabContent');
    if (!tc) return;
    tc.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;gap:20px">
        <div style="width:48px;height:48px;border:4px solid #e4e6eb;border-top-color:#1877f2;border-radius:50%;animation:spin 0.8s linear infinite"></div>
        <div id="loaderMsg" style="font-size:14px;color:#65676b;font-weight:500">${msg}</div>
        <div style="width:240px;background:#e4e6eb;border-radius:99px;height:6px;overflow:hidden">
          <div id="loaderBar" style="height:100%;background:#1877f2;border-radius:99px;width:20%;transition:width 0.4s"></div>
        </div>
      </div>
    `;
  }

  function actualizarLoader(msg, pct) {
    const el = document.getElementById('loaderMsg');
    const bar = document.getElementById('loaderBar');
    if (el) el.textContent = msg;
    if (bar && pct) bar.style.width = pct + '%';
  }

  function renderShell() {
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:20px">

        <!-- SELECTOR DE RUBRO -->
        <div id="rubroBar" class="rubro-bar-wrap" style="display:flex;gap:8px;flex-wrap:nowrap;align-items:center;padding:12px 16px;background:#fff;border-radius:12px;border:1px solid #e4e6eb;box-shadow:0 2px 8px rgba(0,0,0,0.05);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none">
          <span style="font-size:12px;font-weight:700;color:#65676b;margin-right:4px;flex-shrink:0">SECCIÓN:</span>
          <button id="btnAgregarRubro" style="display:none"></button>
          <button id="btnEditarRubros" style="padding:6px 14px;border-radius:20px;border:2px solid #e4e6eb;background:none;color:#65676b;cursor:pointer;font-size:12px;font-weight:600;transition:all 0.2s;flex-shrink:0">Editar</button>
          <span id="rubroCount" style="margin-left:auto;font-size:12px;color:#65676b"></span>
        </div>

        <!-- BANNER CRÍTICOS (visible en todas las pestañas) -->
        <div id="invBanner"></div>

        <!-- STATS -->
        <div class="cards-grid" id="statsGrid" style="margin-bottom:4px"></div>

        <!-- TABS NAVEGACIÓN -->
        <div style="display:flex;gap:0;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;background:#fff;border-radius:10px;border:1px solid #e4e6eb;padding:3px;">
          <button class="tab-btn nav-pill active" data-tab="catalogo" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:#1877f2;color:#fff;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">inventory_2</span>Catálogo
          </button>
          <button class="tab-btn nav-pill" data-tab="inventario" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:#65676b;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">insights</span>Inventario
          </button>
          <button class="tab-btn nav-pill" data-tab="importar" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:#65676b;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">upload_file</span>Importar
          </button>
          <button class="tab-btn nav-pill" data-tab="proveedor" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:#65676b;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">compare_arrows</span>Proveedor
          </button>
          <button class="tab-btn nav-pill" data-tab="nuevo" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:#65676b;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">add_circle</span>Nuevo
          </button>
          <button class="tab-btn nav-pill" data-tab="margenes" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:#65676b;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">percent</span>Márgenes
          </button>
          <button class="tab-btn nav-pill" data-tab="reportes" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:#65676b;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">bar_chart</span>Reportes
          </button>
          <button class="tab-btn nav-pill" data-tab="config" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:#65676b;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">settings</span>Config.
          </button>
        </div>

        <!-- TAB CONTENT -->
        <div id="tabContent"></div>
      </div>
    `;
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => {
          b.classList.remove('active');
          b.style.background = 'none';
          b.style.color = '#65676b';
          const icon = b.querySelector('.material-icons');
          if (icon) icon.style.color = '#65676b';
        });
        btn.classList.add('active');
        btn.style.background = '#1877f2';
        btn.style.color = '#fff';
        const icon = btn.querySelector('.material-icons');
        if (icon) icon.style.color = '#fff';
        renderTab(btn.dataset.tab);
      });
    });

    // Rubros
    document.querySelectorAll('.rubro-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        rubroActivo = btn.dataset.rubro;
        document.querySelectorAll('.rubro-btn').forEach(b => {
          b.style.background = '#fff';
          b.style.color = '#1c1e21';
          b.style.borderColor = '#e4e6eb';
        });
        btn.style.background = '#1877f2';
        btn.style.color = '#fff';
        btn.style.borderColor = '#1877f2';
        renderStats();
        // Si está en catálogo, refiltrar
        if (document.getElementById('catBody')) { currentPage = 1; aplicarFiltros(); }
      });
    });

    // Editar/borrar rubros
    document.getElementById('btnEditarRubros')?.addEventListener('click', () => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px';
      const panel = document.createElement('div');
      panel.style.cssText = 'background:#fff;border-radius:16px;padding:24px;max-width:420px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,0.18)';

      const renderRubrosModal = () => {
        panel.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <h3 style="margin:0;font-size:16px">Gestionar secciones</h3>
            <button id="cerrarEdRubros" style="background:none;border:none;cursor:pointer;color:#65676b"><span class="material-icons">close</span></button>
          </div>
          <p style="font-size:13px;color:#65676b;margin:0 0 14px">Tocá la X para eliminar una sección.</p>
          <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
            ${RUBROS.map(r => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#f0f2f5;border-radius:8px">
                <span style="font-weight:600;font-size:14px">${r.charAt(0)+r.slice(1).toLowerCase()}</span>
                <button class="btn-del-rubro" data-rubro="${r}" style="background:none;border:none;cursor:pointer;color:#c62828;padding:4px;display:flex;align-items:center" title="Eliminar">
                  <span class="material-icons" style="font-size:18px">close</span>
                </button>
              </div>`).join('')}
          </div>
          <div style="display:flex;gap:8px">
            <input id="nuevoRubroInput" type="text" placeholder="Nueva sección..." style="flex:1;padding:8px 12px;border:1px solid #e4e6eb;border-radius:8px;font-size:14px" />
            <button id="btnAddRubroModal" style="padding:8px 16px;background:#1877f2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">Agregar</button>
          </div>
        `;

        panel.querySelector('#cerrarEdRubros').addEventListener('click', () => overlay.remove());

        panel.querySelectorAll('.btn-del-rubro').forEach(btn => {
          btn.addEventListener('click', async () => {
            const rubro = btn.dataset.rubro;
            if (!confirm(`¿Eliminar la sección "${rubro}"?`)) return;
            const idx = RUBROS.indexOf(rubro);
            if (idx !== -1) RUBROS.splice(idx, 1);
            await guardarRubros();
            // Si estaba activo, volver a Todos
            if (rubroActivo === rubro) {
              rubroActivo = 'TODOS';
              if (document.getElementById('catBody')) { currentPage=1; aplicarFiltros(); }
            }
            // Re-renderizar barra de rubros completa
            reRenderRubroBar();
            renderStats();
            renderRubrosModal();
          });
        });

        panel.querySelector('#btnAddRubroModal').addEventListener('click', async () => {
          const val = document.getElementById('nuevoRubroInput').value.trim().toUpperCase();
          if (!val) return;
          if (RUBROS.includes(val)) { alert('Esa sección ya existe'); return; }
          RUBROS.push(val);
          await guardarRubros();
          reRenderRubroBar();
          renderRubrosModal();
        });
      };

      renderRubrosModal();
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    });

    // Agregar nueva sección
    document.getElementById('btnAgregarRubro')?.addEventListener('click', () => {
      const nombre = prompt('Nombre de la nueva sección (ej: BAZAR):');
      if (!nombre) return;
      const nombreUp = nombre.toUpperCase().trim();
      if (RUBROS.includes(nombreUp)) { alert('Esa sección ya existe'); return; }
      RUBROS.push(nombreUp);
      const bar = document.getElementById('rubroBar');
      const addBtn = document.getElementById('btnAgregarRubro');
      const newBtn = document.createElement('button');
      newBtn.className = 'rubro-btn';
      newBtn.dataset.rubro = nombreUp;
      newBtn.textContent = '' + nombreUp.charAt(0) + nombreUp.slice(1).toLowerCase();
      newBtn.style.cssText = 'padding:6px 16px;border-radius:20px;border:2px solid #e4e6eb;background:#fff;color:#1c1e21;cursor:pointer;font-size:13px;font-weight:600;transition:all 0.2s';
      newBtn.addEventListener('click', () => {
        rubroActivo = nombreUp;
        document.querySelectorAll('.rubro-btn').forEach(b => { b.style.background='#fff'; b.style.color='#1c1e21'; b.style.borderColor='#e4e6eb'; });
        newBtn.style.background='#1877f2'; newBtn.style.color='#fff'; newBtn.style.borderColor='#1877f2';
        renderStats();
        if (document.getElementById('catBody')) { currentPage=1; aplicarFiltros(); }
      });
      bar.insertBefore(newBtn, addBtn);
    });
  }

  function reRenderRubroBar() {
    const bar = document.getElementById('rubroBar');
    if (!bar) return;
    // Preservar botones fijos (Todos, + Sección, Editar, span)
    const btnFijos = ['btnAgregarRubro', 'btnEditarRubros', 'rubroCount'];
    // Quitar todos los rubro-btn existentes
    bar.querySelectorAll('.rubro-btn').forEach(b => b.remove());
    // Re-agregar Todos
    const todosBtn = document.createElement('button');
    todosBtn.className = 'rubro-btn' + (rubroActivo === 'TODOS' ? ' active' : '');
    todosBtn.dataset.rubro = 'TODOS';
    todosBtn.textContent = 'Todos';
    todosBtn.style.cssText = `padding:6px 16px;border-radius:20px;border:2px solid ${rubroActivo==='TODOS'?'#1877f2':'#e4e6eb'};background:${rubroActivo==='TODOS'?'#1877f2':'#fff'};color:${rubroActivo==='TODOS'?'#fff':'#1c1e21'};cursor:pointer;font-size:13px;font-weight:700;transition:all 0.2s;flex-shrink:0`;
    bar.insertBefore(todosBtn, bar.querySelector('#btnAgregarRubro'));
    todosBtn.addEventListener('click', () => {
      rubroActivo = 'TODOS';
      reRenderRubroBar();
      renderStats();
      if (document.getElementById('catBody')) {
        currentPage = 1;
        _actualizarSelectsFiltros();
        aplicarFiltros();
      }
    });
    // Re-agregar cada rubro
    RUBROS.forEach(r => {
      const btn = document.createElement('button');
      btn.className = 'rubro-btn' + (rubroActivo === r ? ' active' : '');
      btn.dataset.rubro = r;
      btn.textContent = r.charAt(0) + r.slice(1).toLowerCase();
      btn.style.cssText = `padding:6px 16px;border-radius:20px;border:2px solid ${rubroActivo===r?'#1877f2':'#e4e6eb'};background:${rubroActivo===r?'#1877f2':'#fff'};color:${rubroActivo===r?'#fff':'#1c1e21'};cursor:pointer;font-size:13px;font-weight:600;transition:all 0.2s;flex-shrink:0`;
      bar.insertBefore(btn, bar.querySelector('#btnAgregarRubro'));
      btn.addEventListener('click', () => {
        rubroActivo = r;
        reRenderRubroBar();
        renderStats();
        if (document.getElementById('catBody')) {
          currentPage = 1;
          // Actualizar selects con valores del rubro seleccionado
          _actualizarSelectsFiltros();
          aplicarFiltros();
        }
      });
    });
  }

  function activarFiltroEstado(valor) {
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.remove('active');
      b.style.background = 'none'; b.style.color = '#65676b';
      const icon = b.querySelector('.material-icons'); if (icon) icon.style.color = '#65676b';
    });
    const tabCat = document.querySelector('.tab-btn[data-tab="catalogo"]');
    if (tabCat) {
      tabCat.classList.add('active');
      tabCat.style.background = '#1877f2'; tabCat.style.color = '#fff';
      const icon = tabCat.querySelector('.material-icons'); if (icon) icon.style.color = '#fff';
    }
    const tc = document.getElementById('tabContent');
    renderTabCatalogo(tc);
    // Aplicar filtro después de renderizar
    const sel = document.getElementById('filtroEstado');
    if (sel) { sel.value = valor; currentPage = 1; aplicarFiltros(); }
  }

  function renderStats() {
    const base = getBaseRubro();

    const total      = base.length;
    const conStock   = base.filter(p => p.estado === 'activo' && !p.duplicado && (p.stock||0) > 0).length;
    const sinPrecio  = base.filter(p => p.estado === 'sin_precio').length;
    const duplicados = base.filter(p => p.duplicado).length;
    const agotados   = base.filter(p => (p.stock||0) === 0 && p.estado === 'activo' && !p.duplicado).length;
    const decimales  = base.filter(p => p.precio_venta > 0 && (p.precio_venta % 100) !== 0).length;
    const grid = document.getElementById('statsGrid');
    if (!grid) return;

    const cardStyle = 'cursor:pointer;transition:transform 0.15s,box-shadow 0.15s';
    grid.innerHTML = `
      <div class="card stat-card" data-filtro="" style="${cardStyle}" title="Ver todos">
        <div class="icon-wrap bg-blue"><span class="material-icons">menu_book</span></div>
        <div class="label">Total</div><div class="value">${total}</div>
      </div>
      <div class="card stat-card" data-filtro="con_stock" style="${cardStyle}" title="Ver activos con stock">
        <div class="icon-wrap bg-green"><span class="material-icons">check_circle</span></div>
        <div class="label">Con Stock</div><div class="value">${conStock}</div>
      </div>
      <div class="card stat-card" data-filtro="sin_precio" style="${cardStyle}" title="Ver sin precio">
        <div class="icon-wrap" style="background:#f59e0b"><span class="material-icons">sell</span></div>
        <div class="label">Sin Precio</div><div class="value">${sinPrecio}</div>
      </div>
      <div class="card stat-card" data-filtro="duplicado" style="${cardStyle}" title="Ver duplicados">
        <div class="icon-wrap bg-orange"><span class="material-icons">content_copy</span></div>
        <div class="label">Duplicados</div><div class="value">${duplicados}</div>
      </div>
      <div class="card stat-card" data-filtro="agotado" style="${cardStyle}" title="Ver agotados">
        <div class="icon-wrap bg-red"><span class="material-icons">remove_shopping_cart</span></div>
        <div class="label">Agotados</div><div class="value">${agotados}</div>
      </div>
      <div class="card stat-card" data-filtro="decimales" style="${cardStyle}" title="Ver precios no redondeados">
        <div class="icon-wrap" style="background:#7c3aed"><span class="material-icons">pending</span></div>
        <div class="label">Decimales</div><div class="value">${decimales}</div>
      </div>
    `;

    grid.querySelectorAll('.stat-card').forEach(card => {
      card.addEventListener('mouseenter', () => { card.style.transform = 'translateY(-3px)'; card.style.boxShadow = '0 6px 20px rgba(0,0,0,0.12)'; });
      card.addEventListener('mouseleave', () => { card.style.transform = ''; card.style.boxShadow = ''; });
      card.addEventListener('click', () => activarFiltroEstado(card.dataset.filtro));
    });

    // Banner de alertas (solo si ya tenemos velocidad cargada)
    renderBannerCriticos();
  }

  function renderTab(tab) {
    const tc = document.getElementById('tabContent');
    if (tab === 'catalogo') renderTabCatalogo(tc);
    else if (tab === 'inventario') renderTabInventario(tc);
    else if (tab === 'importar') renderTabImportar(tc);
    else if (tab === 'proveedor') renderTabProveedor(tc);
    else if (tab === 'nuevo') renderTabNuevo(tc);
    else if (tab === 'margenes') renderTabMargenes(tc);
    else if (tab === 'reportes') renderTabReportes(tc);
    else if (tab === 'config') renderTabConfig(tc);
  }

  // ── Actualiza selects de filtros según el rubro activo ──────────────────
  function _actualizarSelectsFiltros() {
    const base  = getBaseRubro();
    const cats  = [...new Set(base.map(p => p.categoria).filter(Boolean))].sort();
    const provs = [...new Set(base.map(p => p.proveedor).filter(Boolean))].sort();
    const marcas= [...new Set(base.map(p => p.marca).filter(Boolean))].sort();

    const selCat  = document.getElementById('filtroCat');
    const selProv = document.getElementById('filtroProv');
    const selMarca= document.getElementById('filtroMarca');

    if (selCat)  { selCat.innerHTML  = `<option value="">Todas las categorías</option>${cats.map(c=>`<option value="${c}">${c}</option>`).join('')}`; selCat.value  = ''; }
    if (selProv) { selProv.innerHTML = `<option value="">Todos los proveedores</option>${provs.map(p=>`<option value="${p}">${p}</option>`).join('')}`; selProv.value = ''; }
    if (selMarca){ selMarca.innerHTML= `<option value="">Todas las marcas</option>${marcas.map(m=>`<option value="${m}">${m}</option>`).join('')}`; selMarca.value= ''; }
  }

  // ── Helper: base filtrada por rubro activo ──
  function getBaseRubro() {
    if (rubroActivo === 'TODOS') return allProductos;
    const norm = rubroActivo.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
    return allProductos.filter(p => {
      const r = (p.rubro || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
      return r === norm;
    });
  }

  // ── Tab Catálogo ──
  function renderTabCatalogo(tc) {
    const base = getBaseRubro();
    // Solo mostrar categorías/proveedores/marcas del rubro activo
    const cats  = [...new Set(base.map(p => p.categoria).filter(Boolean))].sort();
    const provs = [...new Set(base.map(p => p.proveedor).filter(Boolean))].sort();
    const marcas= [...new Set(base.map(p => p.marca).filter(Boolean))].sort();

    tc.innerHTML = `
      <div class="filter-bar" style="flex-wrap:wrap;gap:8px">
        <div style="position:relative;flex:2;min-width:280px;display:flex;align-items:center">
          <span class="material-icons" style="position:absolute;left:12px;font-size:24px;color:#65676b;pointer-events:none">search</span>
          <input type="text" id="buscar" placeholder="Buscar por nombre, código o barra..." style="width:100%;padding:10px 14px 10px 44px;font-size:14px;box-sizing:border-box" />
        </div>
        <select id="filtroCat"><option value="">Todas las categorías</option>${cats.map(c=>`<option value="${c}">${c}</option>`).join('')}</select>
        <select id="filtroProv"><option value="">Todos los proveedores</option>${provs.map(p=>`<option value="${p}">${p}</option>`).join('')}</select>
        <select id="filtroMarca"><option value="">Todas las marcas</option>${marcas.map(m=>`<option value="${m}">${m}</option>`).join('')}</select>
        <select id="filtroEstado">
          <option value="">Todos los estados</option>
          <option value="con_stock">Con Stock</option>
          <option value="activo">Activo (todos)</option>
          <option value="sin_precio">Sin Precio</option>
          <option value="duplicado">Duplicado</option>
          <option value="agotado">Agotado</option>
          <option value="decimales">Precio Decimal</option>
        </select>
        <button id="btnLimpiar" style="padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:none;cursor:pointer;color:var(--text-muted);font-size:13px">Limpiar</button>
      </div>
      <div class="table-card">
        <div class="table-card-header">
          <h3>Catálogo${rubroActivo !== 'TODOS' ? ' — ' + rubroActivo.charAt(0) + rubroActivo.slice(1).toLowerCase() : ''}</h3>
          <div style="display:flex;align-items:center;gap:12px">
            <span id="catCount" style="color:var(--text-muted);font-size:13px"></span>
            <button id="btnRedondearTodos" style="display:none;padding:8px 16px;border-radius:8px;border:none;background:#7c3aed;color:#fff;cursor:pointer;font-size:13px;font-weight:700;align-items:center;gap:6px">
              <span class="material-icons" style="font-size:16px">auto_fix_high</span>Redondear todos
            </button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th class="cat-col-codigo">Código</th>
              <th>Producto</th>
              <th>Categoría</th>
              <th class="cat-col-marca">Marca</th>
              <th class="cat-col-proveedor">Proveedor</th>
              <th>Costo</th>
              <th>Precio Venta</th>
              <th>Stock</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr></thead>
            <tbody id="catBody"></tbody>
          </table>
        </div>
        <div id="paginacion" style="display:flex;align-items:center;justify-content:center;gap:12px;padding:16px;flex-wrap:wrap"></div>
      </div>
    `;

    ['buscar','filtroCat','filtroProv','filtroMarca','filtroEstado'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => { currentPage = 1; aplicarFiltros(); });
    });
    document.getElementById('btnLimpiar')?.addEventListener('click', () => {
      ['buscar','filtroCat','filtroProv','filtroMarca','filtroEstado'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      currentPage = 1;
      aplicarFiltros();
    });

    aplicarFiltros();
  }

  // Búsqueda fuzzy: cada palabra del texto debe aparecer en algún campo del producto
  function fuzzyMatch(texto, producto) {
    if (!texto) return true;
    const haystack = `${producto.nombre||''} ${producto.codigo||''} ${producto.cod_barra||''} ${producto.categoria||''} ${producto.marca||''} ${producto.proveedor||''}`.toLowerCase();
    const palabras = texto.toLowerCase().split(/\s+/).filter(Boolean);
    return palabras.every(p => haystack.includes(p));
  }

  function aplicarFiltros() {
    const buscar = (document.getElementById('buscar')?.value || '').trim();
    const cat    = document.getElementById('filtroCat')?.value || '';
    const prov   = document.getElementById('filtroProv')?.value || '';
    const marca  = document.getElementById('filtroMarca')?.value || '';
    const estado = document.getElementById('filtroEstado')?.value || '';

    // Partir siempre de la base del rubro activo
    const base = getBaseRubro();

    filtrados = base.filter(p => {
      if (buscar && !fuzzyMatch(buscar, p)) return false;
      if (cat   && (p.categoria || '') !== cat) return false;
      if (prov  && (p.proveedor || '') !== prov) return false;
      if (marca && (p.marca || '') !== marca) return false;
      if (estado) {
        if (estado === 'duplicado'  && !p.duplicado) return false;
        if (estado === 'agotado'    && (p.stock || 0) > 0) return false;
        if (estado === 'activo'     && (p.estado !== 'activo' || p.duplicado)) return false;
        if (estado === 'sin_precio' && p.estado !== 'sin_precio') return false;
        if (estado === 'con_stock'  && (p.estado !== 'activo' || p.duplicado || (p.stock||0) === 0)) return false;
        if (estado === 'decimales'  && !((p.precio_venta > 0) && (p.precio_venta % 100) !== 0)) return false;
      }
      return true;
    });

    renderTabla();
  }

  function renderTabla() {
    const tbody = document.getElementById('catBody');
    const countEl = document.getElementById('catCount');
    if (!tbody) return;

    const total = filtrados.length;
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    if (currentPage > pages) currentPage = 1;

    const start = (currentPage - 1) * PER_PAGE;
    const chunk = filtrados.slice(start, start + PER_PAGE);

    if (countEl) countEl.textContent = `${total} productos (pág ${currentPage}/${pages})`;

    if (!chunk.length) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-muted)">Sin productos</td></tr>`;
      renderPaginacion(pages);
      return;
    }

    tbody.innerHTML = chunk.map(p => {
      const estadoBadge = p.duplicado
        ? `<span class="badge badge-orange">Duplicado</span>`
        : p.estado === 'sin_precio'
          ? `<span class="badge" style="background:#fef3c7;color:#92400e">Sin Precio</span>`
          : (p.stock || 0) === 0
            ? `<span class="badge badge-red">Agotado</span>`
            : (p.stock || 0) <= 3
              ? `<span class="badge badge-orange">Stock Bajo</span>`
              : `<span class="badge badge-green">Con Stock</span>`;

      const stockColor = (p.stock || 0) === 0 ? 'var(--danger)' : (p.stock || 0) <= 3 ? 'var(--warning)' : 'var(--text)';

      return `<tr>
        <td class="cat-col-codigo" style="color:var(--text-muted);font-size:12px">${p.codigo || '-'}</td>
        <td><b style="font-size:13px">${p.nombre || '-'}</b><br><span style="color:var(--text-muted);font-size:11px">${p.cod_barra || ''}</span></td>
        <td><span class="badge badge-gray">${p.categoria || '-'}</span></td>
        <td class="cat-col-marca" style="font-size:12px">${p.marca || '-'}</td>
        <td class="cat-col-proveedor" style="font-size:12px">${p.proveedor || '-'}</td>
        <td class="precio-cell" data-id="${p.doc_id}" data-field="costo" style="cursor:pointer" title="Click para editar">$${fmt(p.costo)}</td>
        <td class="precio-cell" data-id="${p.doc_id}" data-field="precio_venta" style="cursor:pointer;display:flex;align-items:center;gap:4px" title="Click para editar">
          <span>$${fmt(p.precio_venta)}</span>
          ${(() => {
            const margenPct = p.costo > 0 ? Math.round(((p.precio_venta - p.costo)/p.costo)*100) : 0;
            return `<span style="font-size:10px;color:#7b1fa2;font-weight:700;margin-left:4px">(${margenPct}%)</span>`;
          })()}
        </td>
        <td style="text-align:center;font-weight:700;color:${stockColor}" class="precio-cell" data-id="${p.doc_id}" data-field="stock" title="Click para editar">${p.stock || 0}</td>
        <td>${estadoBadge}</td>
        <td style="display:flex;gap:4px;align-items:center">
          <button class="btn-editar" data-id="${p.doc_id}" style="background:none;border:none;cursor:pointer;color:var(--primary);padding:4px" title="Editar producto">
            <span class="material-icons" style="font-size:18px">edit</span>
          </button>
          <button class="btn-detalle" data-id="${p.doc_id}" style="background:none;border:none;cursor:pointer;color:#65676b;padding:4px" title="Ver detalle">
            <span class="material-icons" style="font-size:18px">info</span>
          </button>
          <button class="btn-eliminar" data-id="${p.doc_id}" style="background:none;border:none;cursor:pointer;color:var(--danger);padding:4px" title="Eliminar">
            <span class="material-icons" style="font-size:18px">delete</span>
          </button>
        </td>
      </tr>`;
    }).join('');

    // Edición inline
    document.querySelectorAll('.precio-cell').forEach(cell => {
      cell.addEventListener('click', () => editarCampo(cell));
    });

    // Editar producto completo
    document.querySelectorAll('.btn-editar').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = allProductos.find(p => p.doc_id === btn.dataset.id);
        if (p) abrirEditorCompleto(p);
      });
    });

    // Detalle
    document.querySelectorAll('.btn-detalle').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = allProductos.find(p => p.doc_id === btn.dataset.id);
        if (p) abrirDetalle(p);
      });
    });

    // Eliminar
    document.querySelectorAll('.btn-eliminar').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este producto del catálogo?')) return;
        const id = btn.dataset.id;
        await deleteDoc(doc(db, 'catalogo', id));
        await _registerCatalogoDeleted(db, id);
        invalidateCacheByPrefix('catalogo');
        _touchCatalogoMeta(db).catch(() => {});
        allProductos = allProductos.filter(p => p.doc_id !== id);
        aplicarFiltros();
        renderStats();
      });
    });

    // Mostrar botón "Redondear todos" solo cuando el filtro activo es decimales
    const btnRedondearTodos = document.getElementById('btnRedondearTodos');
    if (btnRedondearTodos) {
      const estadoActivo = document.getElementById('filtroEstado')?.value || '';
      if (estadoActivo === 'decimales' && filtrados.length > 0) {
        btnRedondearTodos.style.display = 'flex';
        btnRedondearTodos.onclick = null;
        btnRedondearTodos.addEventListener('click', async () => {
          if (!confirm(`¿Redondear al centena más cercano los ${filtrados.length} productos con precio decimal?`)) return;
          btnRedondearTodos.disabled = true;
          btnRedondearTodos.innerHTML = '<span class="material-icons" style="font-size:16px;animation:spin 0.8s linear infinite">refresh</span> Redondeando...';
          try {
            const BATCH = 500;
            const ts = serverTimestamp();
            for (let i = 0; i < filtrados.length; i += BATCH) {
              const batch = writeBatch(db);
              filtrados.slice(i, i + BATCH).forEach(p => {
                const redondeado = Math.round(p.precio_venta / 100) * 100;
                const nuevoMargen = p.costo > 0 ? Math.round(((redondeado - p.costo) / p.costo) * 100) : p.margen || 0;
                batch.update(doc(db, 'catalogo', p.doc_id), {
                  precio_venta: redondeado,
                  margen: nuevoMargen,
                  ultima_actualizacion: ts,
                });
                // Actualizar en memoria
                p.precio_venta = redondeado;
                p.margen = nuevoMargen;
              });
              await batch.commit();
            }
            invalidateCacheByPrefix('catalogo');
            _touchCatalogoMeta(db).catch(() => {});
            aplicarFiltros();
            renderStats();
          } catch(e) {
            alert('Error al redondear: ' + e.message);
            btnRedondearTodos.disabled = false;
            btnRedondearTodos.innerHTML = '<span class="material-icons" style="font-size:16px">auto_fix_high</span>Redondear todos';
          }
        });
      } else {
        btnRedondearTodos.style.display = 'none';
      }
    }

    renderPaginacion(pages);
  }

  function renderPaginacion(pages) {
    const pag = document.getElementById('paginacion');
    if (!pag) return;
    if (pages <= 1) { pag.innerHTML = ''; return; }

    let btns = '';
    btns += `<button ${currentPage===1?'disabled':''} style="padding:6px 14px;border-radius:6px;border:1px solid var(--border);background:none;cursor:pointer" id="prevPage">← Anterior</button>`;
    const start = Math.max(1, currentPage - 2);
    const end = Math.min(pages, currentPage + 2);
    for (let i = start; i <= end; i++) {
      btns += `<button data-pg="${i}" style="padding:6px 12px;border-radius:6px;border:1px solid var(--border);cursor:pointer;${i===currentPage?'background:var(--primary);color:#fff':'background:none'}">${i}</button>`;
    }
    btns += `<button ${currentPage===pages?'disabled':''} style="padding:6px 14px;border-radius:6px;border:1px solid var(--border);background:none;cursor:pointer" id="nextPage">Siguiente →</button>`;
    pag.innerHTML = btns;

    pag.querySelector('#prevPage')?.addEventListener('click', () => { currentPage--; renderTabla(); });
    pag.querySelector('#nextPage')?.addEventListener('click', () => { currentPage++; renderTabla(); });
    pag.querySelectorAll('[data-pg]').forEach(b => {
      b.addEventListener('click', () => { currentPage = parseInt(b.dataset.pg); renderTabla(); });
    });
  }

  // ── Modal de edición completa de producto ──────────────────────────────────
  function abrirEditorCompleto(prod) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto';

    const subRubrosDisponibles = [...new Set(
      allProductos
        .filter(p => (p.rubro||'').toUpperCase() === (prod.rubro||'').toUpperCase())
        .map(p => p.sub_rubro || '')
        .filter(Boolean)
    )].sort();

    const optsRubro   = ['', ...RUBROS].map(r => `<option value="${r}" ${r === (prod.rubro||'') ? 'selected' : ''}>${r || '— Sin rubro —'}</option>`).join('');
    const optsSubRub  = ['', ...subRubrosDisponibles].map(s => `<option value="${s}" ${s === (prod.sub_rubro||'') ? 'selected' : ''}>${s || '— Sin sub-rubro —'}</option>`).join('');

    const margenActual = prod.costo > 0 ? Math.round(((prod.precio_venta - prod.costo) / prod.costo) * 100) : 0;

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:18px;padding:0;max-width:520px;width:100%;box-shadow:0 12px 48px rgba(0,0,0,0.22);overflow:hidden">

        <!-- Header -->
        <div style="background:linear-gradient(135deg,#1877f2,#0d5db5);padding:20px 24px;display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="color:rgba(255,255,255,0.75);font-size:11px;font-weight:700;letter-spacing:1px;margin-bottom:4px">EDITAR PRODUCTO</div>
            <div style="color:#fff;font-size:14px;font-weight:700;line-height:1.3;max-width:380px">${prod.nombre}</div>
          </div>
          <button id="cerrarEditor" style="background:rgba(255,255,255,0.15);border:none;cursor:pointer;color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <span class="material-icons" style="font-size:18px">close</span>
          </button>
        </div>

        <!-- Body -->
        <div style="padding:24px;display:flex;flex-direction:column;gap:16px;max-height:70vh;overflow-y:auto">

          <!-- Nombre -->
          <div>
            <label style="font-size:11px;font-weight:700;color:#65676b;letter-spacing:0.5px;display:block;margin-bottom:6px">NOMBRE DEL PRODUCTO</label>
            <input id="ed_nombre" type="text" value="${prod.nombre || ''}" style="width:100%;padding:10px 12px;border:1.5px solid #e4e6eb;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
          </div>

          <!-- Rubro + Sub-rubro -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="font-size:11px;font-weight:700;color:#65676b;letter-spacing:0.5px;display:block;margin-bottom:6px">RUBRO</label>
              <select id="ed_rubro" style="width:100%;padding:10px 12px;border:1.5px solid #e4e6eb;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit;background:#fff">
                ${optsRubro}
              </select>
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:#65676b;letter-spacing:0.5px;display:block;margin-bottom:6px">SUB-RUBRO</label>
              <input id="ed_subrubro" type="text" value="${prod.sub_rubro || ''}" list="subrubro-list" style="width:100%;padding:10px 12px;border:1.5px solid #e4e6eb;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
              <datalist id="subrubro-list">${optsSubRub}</datalist>
            </div>
          </div>

          <!-- Marca + Proveedor -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="font-size:11px;font-weight:700;color:#65676b;letter-spacing:0.5px;display:block;margin-bottom:6px">MARCA</label>
              <input id="ed_marca" type="text" value="${prod.marca && prod.marca !== 'SIN MARCA' ? prod.marca : ''}" placeholder="Ej: RIVADAVIA" style="width:100%;padding:10px 12px;border:1.5px solid #e4e6eb;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:#65676b;letter-spacing:0.5px;display:block;margin-bottom:6px">PROVEEDOR</label>
              <input id="ed_proveedor" type="text" value="${prod.proveedor && prod.proveedor !== 'SIN PROVEEDOR' ? prod.proveedor : ''}" placeholder="Ej: MAYORISTA SA" style="width:100%;padding:10px 12px;border:1.5px solid #e4e6eb;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
          </div>

          <!-- Código + Código de barras -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="font-size:11px;font-weight:700;color:#65676b;letter-spacing:0.5px;display:block;margin-bottom:6px">CÓDIGO INTERNO</label>
              <input id="ed_codigo" type="text" value="${prod.codigo || ''}" style="width:100%;padding:10px 12px;border:1.5px solid #e4e6eb;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:#65676b;letter-spacing:0.5px;display:block;margin-bottom:6px">CÓDIGO DE BARRAS</label>
              <input id="ed_barra" type="text" value="${prod.cod_barra || ''}" style="width:100%;padding:10px 12px;border:1.5px solid #e4e6eb;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
          </div>

          <!-- Costo + Precio venta -->
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
            <div>
              <label style="font-size:11px;font-weight:700;color:#65676b;letter-spacing:0.5px;display:block;margin-bottom:6px">COSTO $</label>
              <input id="ed_costo" type="number" step="0.01" min="0" value="${prod.costo || 0}" style="width:100%;padding:10px 12px;border:1.5px solid #e4e6eb;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:#65676b;letter-spacing:0.5px;display:block;margin-bottom:6px">MARGEN %</label>
              <input id="ed_margen" type="number" step="1" min="0" value="${margenActual}" style="width:100%;padding:10px 12px;border:1.5px solid #e4e6eb;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:#65676b;letter-spacing:0.5px;display:block;margin-bottom:6px">PRECIO VENTA $</label>
              <div style="display:flex;gap:6px;align-items:center">
                <input id="ed_precio" type="number" step="0.01" min="0" value="${prod.precio_venta || 0}" style="width:100%;padding:10px 12px;border:1.5px solid #1877f2;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit;font-weight:700" />
                <button id="btn_redondear" type="button" title="Redondear al centena más cercano" style="flex-shrink:0;padding:10px 10px;border-radius:8px;border:1.5px solid #e4e6eb;background:#f0f2f5;cursor:pointer;font-size:12px;font-weight:700;color:#444;white-space:nowrap;line-height:1">±100</button>
              </div>
            </div>
          </div>

          <!-- Stock + Alertas -->
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;align-items:end">
            <div>
              <label style="font-size:11px;font-weight:700;color:#65676b;letter-spacing:0.5px;display:block;margin-bottom:6px">STOCK</label>
              <input id="ed_stock" type="number" step="1" min="-1" value="${prod.stock ?? 0}" style="width:100%;padding:10px 12px;border:1.5px solid #e4e6eb;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:#b45309;letter-spacing:0.5px;display:block;margin-bottom:6px">STOCK MÍN. (avisar)</label>
              <input id="ed_stock_min" type="number" step="1" min="0" placeholder="Sin alerta"
                     value="${prod.stock_min ?? ''}"
                     style="width:100%;padding:10px 12px;border:1.5px solid #ffe082;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit;background:#fffef7" />
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:#b45309;letter-spacing:0.5px;display:block;margin-bottom:6px">STOCK MÁX. (ideal)</label>
              <input id="ed_stock_max" type="number" step="1" min="0" placeholder="Sin tope"
                     value="${prod.stock_max ?? ''}"
                     style="width:100%;padding:10px 12px;border:1.5px solid #ffe082;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit;background:#fffef7" />
            </div>
          </div>
          <div style="color:#65676b;font-size:12px;margin-top:-8px">
            <span style="background:#f0f2f5;border-radius:6px;padding:8px 12px;display:block">
              💡 <b>STOCK -1</b> = servicio/ilimitado &nbsp;|&nbsp; <b>0</b> = agotado &nbsp;|&nbsp; <b>&gt;0</b> = disponible. Dejá MÍN/MÁX vacío para desactivar alerta.
            </span>
          </div>

        </div>

        <!-- Footer -->
        <div style="padding:16px 24px;border-top:1px solid #e4e6eb;display:flex;gap:10px;justify-content:flex-end;background:#f9fafb">
          <button id="ed_cancelar" style="padding:10px 20px;border-radius:8px;border:1.5px solid #e4e6eb;background:#fff;cursor:pointer;font-size:14px;font-weight:600;color:#65676b">Cancelar</button>
          <button id="ed_guardar" style="padding:10px 24px;border-radius:8px;border:none;background:#1877f2;color:#fff;cursor:pointer;font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px">
            <span class="material-icons" style="font-size:16px">save</span>Guardar cambios
          </button>
        </div>

      </div>
    `;

    document.body.appendChild(overlay);

    // Cálculo automático precio ↔ margen
    const inCosto  = overlay.querySelector('#ed_costo');
    const inMargen = overlay.querySelector('#ed_margen');
    const inPrecio = overlay.querySelector('#ed_precio');

    inCosto.addEventListener('input', () => {
      const c = parseFloat(inCosto.value) || 0;
      const m = parseFloat(inMargen.value) || 0;
      if (c > 0) inPrecio.value = (c * (1 + m / 100)).toFixed(2);
    });
    inMargen.addEventListener('input', () => {
      const c = parseFloat(inCosto.value) || 0;
      const m = parseFloat(inMargen.value) || 0;
      if (c > 0) inPrecio.value = (c * (1 + m / 100)).toFixed(2);
    });
    inPrecio.addEventListener('input', () => {
      const c = parseFloat(inCosto.value) || 0;
      const p = parseFloat(inPrecio.value) || 0;
      if (c > 0 && p > 0) inMargen.value = Math.round(((p - c) / c) * 100);
    });

    overlay.querySelector('#btn_redondear').addEventListener('click', () => {
      const p = parseFloat(inPrecio.value) || 0;
      if (!p) return;
      const redondeado = Math.round(p / 100) * 100;
      inPrecio.value = redondeado;
      const c = parseFloat(inCosto.value) || 0;
      if (c > 0) inMargen.value = Math.round(((redondeado - c) / c) * 100);
    });

    // Actualizar sub-rubros disponibles al cambiar rubro
    overlay.querySelector('#ed_rubro').addEventListener('change', (e) => {
      const nuevoRubro = e.target.value.toUpperCase();
      const subs = [...new Set(
        allProductos
          .filter(p => (p.rubro||'').toUpperCase() === nuevoRubro)
          .map(p => p.sub_rubro || '')
          .filter(Boolean)
      )].sort();
      const dl = overlay.querySelector('#subrubro-list');
      dl.innerHTML = ['', ...subs].map(s => `<option value="${s}">`).join('');
    });

    const cerrar = () => overlay.remove();
    overlay.querySelector('#cerrarEditor').addEventListener('click', cerrar);
    overlay.querySelector('#ed_cancelar').addEventListener('click', cerrar);
    overlay.addEventListener('click', e => { if (e.target === overlay) cerrar(); });

    overlay.querySelector('#ed_guardar').addEventListener('click', async () => {
      const btn = overlay.querySelector('#ed_guardar');
      btn.disabled = true;
      btn.innerHTML = '<span class="material-icons" style="font-size:16px;animation:spin 0.8s linear infinite">refresh</span> Guardando...';

      const nuevoNombre   = (overlay.querySelector('#ed_nombre').value || '').trim().toUpperCase();
      const nuevoRubro    = (overlay.querySelector('#ed_rubro').value || '').trim().toUpperCase();
      const nuevoSubRubro = (overlay.querySelector('#ed_subrubro').value || '').trim().toUpperCase();
      const nuevaMarca    = (overlay.querySelector('#ed_marca').value || '').trim().toUpperCase() || 'SIN MARCA';
      const nuevoProv     = (overlay.querySelector('#ed_proveedor').value || '').trim() || 'SIN PROVEEDOR';
      const nuevoCodigo   = (overlay.querySelector('#ed_codigo').value || '').trim();
      const barraRaw      = (overlay.querySelector('#ed_barra').value || '').trim();
      const nuevoBarra    = /^[A-Za-z0-9\-_]{3,50}$/.test(barraRaw) ? barraRaw : '';
      const nuevoCosto    = parseFloat(inCosto.value) || 0;
      const nuevoPrecio   = parseFloat(inPrecio.value) || 0;
      const nuevoStock    = Math.max(0, parseInt(overlay.querySelector('#ed_stock').value) || 0);
      const rawSMin       = overlay.querySelector('#ed_stock_min').value.trim();
      const rawSMax       = overlay.querySelector('#ed_stock_max').value.trim();
      const nuevoStockMin = rawSMin === '' ? null : Math.max(0, parseInt(rawSMin) || 0);
      const nuevoStockMax = rawSMax === '' ? null : Math.max(0, parseInt(rawSMax) || 0);

      if (!nuevoNombre) { alert('El nombre no puede estar vacío'); btn.disabled = false; btn.innerHTML = '<span class="material-icons" style="font-size:16px">save</span>Guardar cambios'; return; }
      if (barraRaw && !nuevoBarra) { alert('El código de barras solo puede tener letras, números, guiones y guiones bajos (mínimo 3 caracteres).'); btn.disabled = false; btn.innerHTML = '<span class="material-icons" style="font-size:16px">save</span>Guardar cambios'; return; }
      if (nuevoStockMin !== null && nuevoStockMax !== null && nuevoStockMax > 0 && nuevoStockMax < nuevoStockMin) {
        alert('El stock máximo no puede ser menor al mínimo.');
        btn.disabled = false; btn.innerHTML = '<span class="material-icons" style="font-size:16px">save</span>Guardar cambios';
        return;
      }

      const update = {
        nombre:               nuevoNombre,
        rubro:                nuevoRubro,
        sub_rubro:            nuevoSubRubro,
        marca:                nuevaMarca,
        proveedor:            nuevoProv,
        codigo:               nuevoCodigo,
        cod_barra:            nuevoBarra,
        costo:                nuevoCosto,
        precio_venta:         nuevoPrecio,
        stock:                nuevoStock,
        stock_min:            nuevoStockMin,
        stock_max:            nuevoStockMax,
        estado:               nuevoCosto === 0 ? 'sin_precio' : 'activo',
        ultima_actualizacion: serverTimestamp(),
      };

      try {
        await updateDoc(doc(db, 'catalogo', prod.doc_id), update);
        invalidateCacheByPrefix('catalogo');
        _touchCatalogoMeta(db).catch(() => {});

        // Sincronizar con inventario para que el POS reciba el precio actualizado
        try {
          const invDocId = String(prod.id || prod.doc_id);
          const invUpdate = { ultima_actualizacion: serverTimestamp(), nombre: prod.nombre || '' };
          if (nuevoPrecio !== undefined) invUpdate.precio = nuevoPrecio;
          if (nuevoStock !== undefined) invUpdate.stock = nuevoStock;
          if (nuevoCosto !== undefined) invUpdate.costo = nuevoCosto;
          invUpdate.id = parseInt(invDocId) || invDocId;
          await setDoc(doc(db, 'inventario', invDocId), invUpdate, { merge: true });
        } catch(e2) {
          console.warn('No se pudo actualizar inventario:', e2.message);
        }

        // Actualizar en memoria local
        const idx = allProductos.findIndex(p => p.doc_id === prod.doc_id);
        if (idx !== -1) allProductos[idx] = { ...allProductos[idx], ...update };

        cerrar();
        aplicarFiltros();
        renderStats();

        // Toast de confirmación
        const toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1877f2;color:#fff;padding:12px 24px;border-radius:10px;font-weight:600;font-size:14px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.2);display:flex;align-items:center;gap:8px';
        toast.innerHTML = '<span class="material-icons" style="font-size:18px">check_circle</span> Producto actualizado en Firebase ✓';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);

      } catch(e) {
        alert('Error al guardar: ' + e.message);
        btn.disabled = false;
        btn.innerHTML = '<span class="material-icons" style="font-size:16px">save</span>Guardar cambios';
      }
    });
  }

  async function editarCampo(cell) {
    const id = cell.dataset.id;
    const field = cell.dataset.field;
    const prodIdx = allProductos.findIndex(p => p.doc_id === id);
    if (prodIdx === -1) return;
    const prod = allProductos[prodIdx];
    const valorActual = prod[field] || 0;

    const input = document.createElement('input');
    input.type = 'number';
    input.value = valorActual;
    input.step = '0.01';
    input.style.cssText = 'width:90px;padding:4px;border:1px solid var(--primary);border-radius:4px;font-size:13px';
    cell.innerHTML = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    const guardar = async () => {
      let nuevo = parseFloat(input.value) || 0;
      if (field === 'stock') nuevo = Math.max(0, Math.round(nuevo));
      const update = { [field]: nuevo, ultima_actualizacion: serverTimestamp() };
      if (field === 'costo') update.estado = nuevo === 0 ? 'sin_precio' : 'activo';
      try {
        await updateDoc(doc(db, 'catalogo', id), update);
        _touchCatalogoMeta(db).catch(() => {});
        // Si se editó el stock o el precio, también actualizar inventario
        // para que el POS lo reciba en tiempo real via listener.
        // inventario usa el ID numérico del producto (campo 'id'), no el doc_id del catálogo.
        if (field === 'stock' || field === 'precio_venta' || field === 'costo') {
          try {
            const invUpdate = { ultima_actualizacion: serverTimestamp() };
            if (field === 'stock') invUpdate.stock = nuevo;
            if (field === 'precio_venta') invUpdate.precio = nuevo;
            if (field === 'costo') invUpdate.costo = nuevo;
            invUpdate.nombre = prod.nombre || prod.name || '';
            // El doc en inventario usa el ID numérico como doc_id (ej: "12360")
            // Usamos prod.id si existe, sino el doc_id del catalogo
            const invDocId = String(prod.id || id);
            invUpdate.id = parseInt(invDocId) || invDocId;
            // setDoc con merge:true crea el doc si no existe, o actualiza si existe
            await setDoc(doc(db, 'inventario', invDocId), invUpdate, { merge: true });
          } catch(e2) {
            console.warn('No se pudo actualizar inventario:', e2.message);
          }
        }
        allProductos[prodIdx] = { ...prod, ...update };
        aplicarFiltros();
        renderStats();
      } catch(e) {
        alert('Error al guardar: ' + e.message);
        renderTabla();
      }
    };

    input.addEventListener('blur', guardar);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { renderTabla(); }
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // ── Inventario integrado: velocidad + estado + tab ──
  // ══════════════════════════════════════════════════════════════════
  async function cargarVelocidadVentas() {
    if (ventasProd) return ventasProd;
    ventasProd = await getCached('inventario:velocidad', async () => {
      const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha', 'desc'), limit(5000))).catch(() => ({ docs: [] }));
      const map = {};
      const hace30 = new Date(); hace30.setDate(hace30.getDate() - 30);
      const hace7  = new Date(); hace7.setDate(hace7.getDate() - 7);
      snap.docs.forEach(d => {
        const v = d.data();
        const nombre = (v.producto || '').toUpperCase().trim();
        if (!nombre) return;
        if (!map[nombre]) map[nombre] = { u30: 0, u7: 0 };
        const parts = (v.fecha || '').split('/');
        let fechaV = null;
        if (parts.length === 3) fechaV = new Date(`${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`);
        if (fechaV && fechaV >= hace30) {
          map[nombre].u30 += (v.cantidad || 1);
          if (fechaV >= hace7) map[nombre].u7 += (v.cantidad || 1);
        }
      });
      return map;
    }, { ttl: 5 * 60 * 1000, memOnly: true });
    return ventasProd;
  }

  function calcularEstadoInv(p) {
    const stock = p.stock || 0;
    const nombre = (p.nombre || '').toUpperCase().trim();
    const vData = ventasProd?.[nombre];
    const u30 = vData?.u30 || 0;
    const velocidadDiaria = u30 / 30;

    if (stock === 0) return { label: 'Agotado', key: 'agotado', cls: 'badge-red', color: '#c62828', dias: 0, velocidad: velocidadDiaria, pct: 0 };

    if (velocidadDiaria > 0) {
      const dias = Math.floor(stock / velocidadDiaria);
      const pct  = Math.min(100, Math.round((dias / 30) * 100));
      if (dias <= 3)  return { label: `Crítico (${dias}d)`,  key: 'critico',  cls: 'badge-red',    color: '#c62828', dias, velocidad: velocidadDiaria, pct };
      if (dias <= 10) return { label: `Bajo (${dias}d)`,     key: 'bajo',     cls: 'badge-orange', color: '#f57c00', dias, velocidad: velocidadDiaria, pct };
      if (dias <= 20) return { label: `Regular (${dias}d)`,  key: 'regular',  cls: 'badge-orange', color: '#e65100', dias, velocidad: velocidadDiaria, pct };
      return                 { label: `OK (${dias}d)`,        key: 'ok',       cls: 'badge-green',  color: '#2e7d32', dias, velocidad: velocidadDiaria, pct };
    }
    if (stock <= 2)  return { label: 'Crítico', key: 'critico', cls: 'badge-red',    color: '#c62828', dias: null, velocidad: 0, pct: 10 };
    if (stock <= 5)  return { label: 'Bajo',    key: 'bajo',    cls: 'badge-orange', color: '#f57c00', dias: null, velocidad: 0, pct: 40 };
    if (stock <= 15) return { label: 'Regular', key: 'regular', cls: 'badge-orange', color: '#e65100', dias: null, velocidad: 0, pct: 65 };
    return                 { label: 'OK',       key: 'ok',      cls: 'badge-green',  color: '#2e7d32', dias: null, velocidad: 0, pct: 100 };
  }

  function renderBannerCriticos() {
    const host = document.getElementById('invBanner');
    if (!host) return;
    if (!ventasProd) { host.innerHTML = ''; return; }
    const base = getBaseRubro();
    const lista = base.map(p => ({ ...p, _estado: calcularEstadoInv(p) }));
    const agotados = lista.filter(p => p._estado.key === 'agotado').length;
    const criticos = lista.filter(p => p._estado.key === 'critico').length;
    if (agotados + criticos === 0) { host.innerHTML = ''; return; }

    host.innerHTML = `
      <div class="inv-banner">
        <span class="material-icons" style="color:#c62828">notification_important</span>
        <div class="inv-banner-body">
          <b>${agotados + criticos} productos requieren atención</b>
          <span class="inv-banner-sub">${agotados} agotados · ${criticos} críticos${rubroActivo !== 'TODOS' ? ` · ${rubroActivo}` : ''}</span>
        </div>
        <button class="inv-banner-btn" id="invBannerBtn">
          <span class="material-icons" style="font-size:16px">visibility</span> Ver inventario
        </button>
      </div>
    `;
    document.getElementById('invBannerBtn')?.addEventListener('click', () => {
      const btn = document.querySelector('.tab-btn[data-tab="inventario"]');
      if (btn) btn.click();
    });
  }

  // ── Tab Inventario ──
  async function renderTabInventario(tc) {
    tc.innerHTML = `<div class="loader"><div class="spinner"></div><span>Analizando inventario...</span></div>`;
    await cargarVelocidadVentas();

    const base = getBaseRubro();
    const lista = base.map(p => ({ ...p, _estado: calcularEstadoInv(p) }));

    const total     = lista.length;
    const ok        = lista.filter(p => p._estado.key === 'ok').length;
    const bajos     = lista.filter(p => p._estado.key === 'bajo' || p._estado.key === 'regular').length;
    const criticos  = lista.filter(p => p._estado.key === 'critico').length;
    const agotados  = lista.filter(p => p._estado.key === 'agotado').length;
    const conVentas = lista.filter(p => p._estado.velocidad > 0).length;

    const alertas = lista
      .filter(p => p._estado.key === 'critico' || p._estado.key === 'agotado')
      .sort((a,b) => (a._estado.dias ?? 0) - (b._estado.dias ?? 0))
      .slice(0, 5);

    const cats = [...new Set(base.map(p => p.categoria || '').filter(Boolean))].sort();

    const cs = 'cursor:pointer;transition:transform 0.15s,box-shadow 0.15s';

    tc.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="cards-grid" id="invStatsGrid">
          <div class="card stat-card inv-stat" data-filtro="" style="${cs}" title="Ver todos"><div class="icon-wrap bg-blue"><span class="material-icons">inventory_2</span></div><div class="label">Total</div><div class="value">${total}</div></div>
          <div class="card stat-card inv-stat" data-filtro="ok" style="${cs}"><div class="icon-wrap bg-green"><span class="material-icons">check_circle</span></div><div class="label">Stock OK</div><div class="value">${ok}</div></div>
          <div class="card stat-card inv-stat" data-filtro="bajo" style="${cs}"><div class="icon-wrap bg-orange"><span class="material-icons">warning</span></div><div class="label">Stock Bajo</div><div class="value">${bajos}</div></div>
          <div class="card stat-card inv-stat" data-filtro="critico" style="${cs}"><div class="icon-wrap bg-red"><span class="material-icons">error</span></div><div class="label">Críticos</div><div class="value">${criticos}</div></div>
          <div class="card stat-card inv-stat" data-filtro="agotado" style="${cs}"><div class="icon-wrap" style="background:#424242"><span class="material-icons">remove_shopping_cart</span></div><div class="label">Agotados</div><div class="value">${agotados}</div></div>
          <div class="card stat-card inv-stat" data-filtro="con" style="${cs}"><div class="icon-wrap" style="background:#7b1fa2"><span class="material-icons">trending_up</span></div><div class="label">En movimiento</div><div class="value">${conVentas}</div></div>
        </div>

        <div id="invAlertasHost">
          ${alertas.length ? `
            <div style="background:#fff3f3;border:1px solid #ef9a9a;border-radius:12px;padding:14px">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                <span class="material-icons" style="color:#c62828;font-size:18px">notification_important</span>
                <b style="font-size:13px;color:#c62828">Requieren atención inmediata</b>
              </div>
              <div style="display:flex;flex-direction:column;gap:6px">
                ${alertas.map(p => `
                  <div style="display:flex;align-items:center;justify-content:space-between;background:#fff;border-radius:8px;padding:8px 12px;border:1px solid #ef9a9a">
                    <div>
                      <div style="font-weight:700;font-size:13px">${p.nombre}</div>
                      <div style="font-size:11px;color:#65676b">${p.rubro || p.categoria || '-'} · Stock: <b style="color:#c62828">${p.stock || 0}</b></div>
                    </div>
                    <div style="text-align:right">
                      <span class="badge badge-red">${p._estado.label}</span>
                      ${p._estado.velocidad > 0 ? `<div style="font-size:11px;color:#65676b;margin-top:2px">${p._estado.velocidad.toFixed(1)} u/día</div>` : ''}
                    </div>
                  </div>`).join('')}
              </div>
            </div>` : ''}
        </div>

        <div class="filter-bar" style="flex-wrap:wrap;gap:8px">
          <input type="text" id="invFiltroNombre" placeholder="Buscar producto..." style="min-width:200px;flex:1" value="${invNombreFiltro}" />
          <select id="invFiltroCat">
            <option value="">Todas las categorías</option>
            ${cats.map(c => `<option value="${c}" ${invCatFiltro===c?'selected':''}>${c}</option>`).join('')}
          </select>
          <select id="invFiltroEstado">
            <option value="">Todos los estados</option>
            <option value="ok" ${invEstadoFiltro==='ok'?'selected':''}>OK</option>
            <option value="regular" ${invEstadoFiltro==='regular'?'selected':''}>Regular</option>
            <option value="bajo" ${invEstadoFiltro==='bajo'?'selected':''}>Bajo</option>
            <option value="critico" ${invEstadoFiltro==='critico'?'selected':''}>Crítico</option>
            <option value="agotado" ${invEstadoFiltro==='agotado'?'selected':''}>Agotado</option>
          </select>
          <select id="invFiltroMov">
            <option value="">Todo</option>
            <option value="con" ${invMovFiltro==='con'?'selected':''}>Con movimiento</option>
            <option value="sin" ${invMovFiltro==='sin'?'selected':''}>Sin movimiento</option>
          </select>
        </div>

        <div class="table-card">
          <div class="table-card-header">
            <h3>Inventario Inteligente${rubroActivo !== 'TODOS' ? ' — ' + rubroActivo.charAt(0) + rubroActivo.slice(1).toLowerCase() : ''}</h3>
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
    `;

    // Clicks en stat-cards
    tc.querySelectorAll('.inv-stat').forEach(card => {
      card.addEventListener('mouseenter', () => { card.style.transform='translateY(-3px)'; card.style.boxShadow='0 6px 20px rgba(0,0,0,0.1)'; });
      card.addEventListener('mouseleave', () => { card.style.transform=''; card.style.boxShadow=''; });
      card.addEventListener('click', () => {
        const f = card.dataset.filtro;
        const selE = document.getElementById('invFiltroEstado');
        const selM = document.getElementById('invFiltroMov');
        if (f === 'con') { if (selE) selE.value=''; if (selM) selM.value='con'; invEstadoFiltro=''; invMovFiltro='con'; }
        else             { if (selE) selE.value=f; if (selM) selM.value=''; invEstadoFiltro=f; invMovFiltro=''; }
        applyInvFilters(lista);
        document.querySelector('.table-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    ['invFiltroNombre','invFiltroCat','invFiltroEstado','invFiltroMov'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => {
        invNombreFiltro = document.getElementById('invFiltroNombre')?.value || '';
        invCatFiltro    = document.getElementById('invFiltroCat')?.value || '';
        invEstadoFiltro = document.getElementById('invFiltroEstado')?.value || '';
        invMovFiltro    = document.getElementById('invFiltroMov')?.value || '';
        applyInvFilters(lista);
      });
    });

    applyInvFilters(lista);
  }

  function applyInvFilters(lista) {
    let data = [...lista];
    if (invNombreFiltro) {
      const words = invNombreFiltro.toLowerCase().split(/\s+/).filter(Boolean);
      data = data.filter(p => {
        const hay = `${p.nombre||''} ${p.categoria||''} ${p.rubro||''} ${p.codigo||''} ${p.cod_barra||''}`.toLowerCase();
        return words.every(w => hay.includes(w));
      });
    }
    if (invCatFiltro)     data = data.filter(p => (p.categoria || 'Sin categoría') === invCatFiltro);
    if (invEstadoFiltro)  data = data.filter(p => p._estado.key === invEstadoFiltro);
    if (invMovFiltro === 'con') data = data.filter(p => p._estado.velocidad > 0);
    if (invMovFiltro === 'sin') data = data.filter(p => p._estado.velocidad === 0);

    data.sort((a,b) => {
      const orden = { agotado:0, critico:1, bajo:2, regular:3, ok:4 };
      return (orden[a._estado.key] ?? 5) - (orden[b._estado.key] ?? 5);
    });

    renderInvRows(data);
  }

  function renderInvRows(data) {
    const tbody = document.getElementById('invBody');
    const countEl = document.getElementById('invCount');
    if (!tbody) return;
    if (countEl) countEl.textContent = `${data.length} productos`;
    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-muted)">Sin productos</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map(p => {
      const stock = p.stock || 0;
      const e = p._estado;
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
          <span class="inv-stock-val" data-id="${p.doc_id}" style="cursor:pointer;border-bottom:1px dashed #ccc" title="Click para editar">${stock}</span>
        </td>
        <td class="inv-col-dias" style="text-align:center">${diasTxt}</td>
        <td class="inv-col-cobertura">${barHtml}</td>
        <td class="inv-col-velocidad" style="text-align:center">${velTxt}</td>
        <td><span class="badge ${e.cls}">${e.label}</span></td>
        <td style="text-align:right;color:#2e7d32;font-weight:600">$${fmt(p.precio_venta || p.precio || 0)}</td>
        <td>
          <button class="inv-btn-edit" data-id="${p.doc_id}" style="background:none;border:none;cursor:pointer;color:#1877f2;padding:4px" title="Editar producto">
            <span class="material-icons" style="font-size:16px">edit</span>
          </button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.inv-btn-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = allProductos.find(x => x.doc_id === btn.dataset.id);
        if (p) abrirEditorCompleto(p);
      });
    });
    tbody.querySelectorAll('.inv-stock-val').forEach(cell => {
      cell.addEventListener('click', () => editarStockInv(cell.dataset.id));
    });
  }

  async function editarStockInv(docId) {
    const p = allProductos.find(x => x.doc_id === docId);
    if (!p) return;
    const nuevo = prompt(`Stock actual de "${p.nombre}": ${p.stock || 0}\n\nIngresá el nuevo stock:`);
    if (nuevo === null) return;
    const valor = parseInt(nuevo);
    if (isNaN(valor) || valor < 0) { alert('Stock inválido'); return; }
    try {
      await updateDoc(doc(db, 'catalogo', docId), { stock: valor, ultima_actualizacion: serverTimestamp() });
      invalidateCacheByPrefix('catalogo');
      p.stock = valor;
      renderTabInventario(document.getElementById('tabContent'));
      renderStats();
      renderBannerCriticos();
    } catch(e) {
      alert('Error al guardar: ' + e.message);
    }
  }

  // ── Tab Importar CSV ──
  function renderTabImportar(tc) {
    tc.innerHTML = `
      <div class="table-card" style="max-width:640px">
        <div class="table-card-header"><h3>Importar Lista de Precios</h3></div>
        <div style="padding:20px;display:flex;flex-direction:column;gap:16px">

          <!-- Selector de sección para la importación -->
          <div style="background:#eef4ff;border:1px solid #c7d9fc;border-radius:10px;padding:14px">
            <div style="font-size:12px;font-weight:700;color:#1458c2;margin-bottom:8px">SECCIÓN DE DESTINO</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${['TODOS', ...RUBROS].map(r => `
                <button class="imp-rubro-btn" data-rubro="${r}" style="padding:6px 14px;border-radius:20px;border:2px solid ${r===rubroActivo?'#1877f2':'#e4e6eb'};background:${r===rubroActivo?'#1877f2':'#fff'};color:${r===rubroActivo?'#fff':'#1c1e21'};cursor:pointer;font-size:13px;font-weight:600;transition:all 0.2s">
                  ${r === 'TODOS' ? 'Sin sección' : r.charAt(0)+r.slice(1).toLowerCase()}
                </button>`).join('')}
            </div>
            <div style="margin-top:8px;font-size:12px;color:#1877f2">
              Los productos importados quedarán marcados como: <b id="imp_rubro_label">${rubroActivo === 'TODOS' ? 'Sin sección específica' : rubroActivo}</b>
            </div>
          </div>

          <p style="color:var(--text-muted);font-size:14px;margin:0">
            Seleccioná el archivo CSV de lista de precios. El sistema limpiará automáticamente
            los productos sin nombre (<b>*</b>), marcará duplicados y subirá todo a Firebase.
          </p>
          <div id="dropZone" style="border:2px dashed var(--border);border-radius:12px;padding:40px;text-align:center;cursor:pointer;transition:background 0.2s">
            <span class="material-icons" style="font-size:48px;color:var(--text-muted)">upload_file</span>
            <p style="margin:8px 0 4px;font-weight:600">Arrastrá el CSV acá o hacé click</p>
            <p style="color:var(--text-muted);font-size:13px">Archivo .csv de la lista de precios</p>
            <input type="file" id="fileInput" accept=".csv" style="display:none" />
          </div>
          <div id="importProgress" style="display:none;flex-direction:column;gap:10px">
            <div style="display:flex;justify-content:space-between;font-size:13px">
              <span id="progText">Procesando...</span>
              <span id="progPct">0%</span>
            </div>
            <div style="background:var(--border);border-radius:99px;height:8px;overflow:hidden">
              <div id="progBar" style="height:100%;background:var(--primary);width:0%;transition:width 0.3s;border-radius:99px"></div>
            </div>
          </div>
          <div id="importResult" style="display:none"></div>
        </div>
      </div>
    `;

    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');

    // Selector de rubro en importar
    let rubroImport = rubroActivo;
    tc.querySelectorAll('.imp-rubro-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        rubroImport = btn.dataset.rubro;
        tc.querySelectorAll('.imp-rubro-btn').forEach(b => {
          b.style.background = '#fff'; b.style.color = '#1c1e21'; b.style.borderColor = '#e4e6eb';
        });
        btn.style.background = '#1877f2'; btn.style.color = '#fff'; btn.style.borderColor = '#1877f2';
        const label = document.getElementById('imp_rubro_label');
        if (label) label.textContent = rubroImport === 'TODOS' ? 'Sin sección específica' : rubroImport;
      });
    });

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.background = '#f0f2f5'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.background = ''; });
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.style.background = '';
      const file = e.dataTransfer.files[0];
      if (file) procesarImport(file);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) procesarImport(fileInput.files[0]);
    });

    async function procesarImport(file) {
      const prog = document.getElementById('importProgress');
      const result = document.getElementById('importResult');
      const progBar = document.getElementById('progBar');
      const progText = document.getElementById('progText');
      const progPct = document.getElementById('progPct');

      prog.style.display = 'flex';
      result.style.display = 'none';
      progText.textContent = 'Leyendo archivo...';
      progBar.style.width = '5%';
      progPct.textContent = '5%';

      try {
        const text = await file.text();
        let productos = parseCatalogoCSV(text);

        // Marcar rubro de importación
        if (rubroImport && rubroImport !== 'TODOS') {
          productos = productos.map(p => ({ ...p, rubro: rubroImport }));
        }

        if (productos.length === 0) {
          result.style.display = 'block';
          result.innerHTML = `<div style="padding:12px;background:#fef2f2;border-radius:8px;color:#dc2626">Error: No se encontraron productos válidos en el archivo.</div>`;
          prog.style.display = 'none';
          return;
        }

        progText.textContent = `Subiendo ${productos.length} productos a Firebase...`;
        progBar.style.width = '15%';
        progPct.textContent = '15%';

        const activos = productos.filter(p => p.estado === 'activo' && !p.duplicado).length;
        const sinPrecio = productos.filter(p => p.estado === 'sin_precio').length;
        const duplicados = productos.filter(p => p.duplicado).length;

        await subirCatalogoFirebase(db, productos, (done, total) => {
          const pct = Math.round(15 + (done / total) * 80);
          progBar.style.width = pct + '%';
          progPct.textContent = pct + '%';
          progText.textContent = `Subiendo... ${done}/${total}`;
        });

        progBar.style.width = '100%';
        progPct.textContent = '100%';
        progText.textContent = '¡Listo!';

        // Recargar datos locales (invalidar cache para ver los cambios)
        invalidateCache('catalogo:all');
        await cargarDatos();
        renderStats();

        result.style.display = 'block';
        result.innerHTML = `
          <div style="padding:16px;background:#f0fdf4;border-radius:8px;border:1px solid #86efac">
            <p style="margin:0 0 8px;font-weight:700;color:#166534">Importación exitosa</p>
            <ul style="margin:0;padding-left:20px;font-size:14px;color:#15803d;line-height:1.8">
              <li><b>${productos.length}</b> productos procesados</li>
              <li>Sección: <b>${rubroImport === 'TODOS' ? 'Sin sección específica' : rubroImport}</b></li>
              <li><b>${activos}</b> activos con precio</li>
              <li><b>${sinPrecio}</b> sin precio (costo = 0)</li>
              <li><b>${duplicados}</b> marcados como duplicados</li>
            </ul>
          </div>`;
        prog.style.display = 'none';
      } catch(e) {
        result.style.display = 'block';
        result.innerHTML = `<div style="padding:12px;background:#fef2f2;border-radius:8px;color:#dc2626">Error: Error: ${e.message}</div>`;
        prog.style.display = 'none';
      }
    }
  }

  // ── Tab Actualizar Proveedor ──
  function renderTabProveedor(tc) {
    tc.innerHTML = `
      <div class="table-card" style="max-width:700px">
        <div class="table-card-header"><h3>Comparar con Lista de Proveedor</h3></div>
        <div style="padding:20px;display:flex;flex-direction:column;gap:16px">
          <p style="color:var(--text-muted);font-size:14px;margin:0">
            Subí el CSV que te manda el proveedor (ej: Montenegro). El sistema lo compara contra el catálogo
            actual y te muestra qué productos son nuevos, cuáles ya no están y qué precios cambiaron.
          </p>
          <div id="dropZoneProv" style="border:2px dashed var(--border);border-radius:12px;padding:40px;text-align:center;cursor:pointer;transition:background 0.2s">
            <span class="material-icons" style="font-size:48px;color:var(--text-muted)">compare_arrows</span>
            <p style="margin:8px 0 4px;font-weight:600">Subí el CSV del proveedor</p>
            <p style="color:var(--text-muted);font-size:13px">Compatible con el formato de lista de precios</p>
            <input type="file" id="fileInputProv" accept=".csv" style="display:none" />
          </div>
          <div id="compareResult"></div>
        </div>
      </div>
    `;

    const dropZone = document.getElementById('dropZoneProv');
    const fileInput = document.getElementById('fileInputProv');
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.background = 'var(--surface-2)'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.background = ''; });
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.style.background = '';
      if (e.dataTransfer.files[0]) compararProveedor(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) compararProveedor(fileInput.files[0]);
    });

    async function compararProveedor(file) {
      const result = document.getElementById('compareResult');
      result.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted)">Comparando...</div>`;
      try {
        const text = await file.text();
        const provProductos = parseCatalogoCSV(text);
        const provMap = new Map();
        provProductos.forEach(p => provMap.set(slugify(p.nombre), p));

        const catMap = new Map();
        allProductos.forEach(p => catMap.set(slugify(p.nombre), p));

        const nuevos = [];
        const sinCambio = [];
        const cambioPrecio = [];
        provProductos.forEach(p => {
          const key = slugify(p.nombre);
          if (!catMap.has(key)) {
            nuevos.push(p);
          } else {
            const cat = catMap.get(key);
            if (Math.abs((cat.costo || 0) - (p.costo || 0)) > 0.01) {
              cambioPrecio.push({ ...p, costo_anterior: cat.costo, doc_id: cat.doc_id });
            } else {
              sinCambio.push(p);
            }
          }
        });

        const yaNoEstan = [];
        allProductos.forEach(p => {
          if (!provMap.has(slugify(p.nombre))) yaNoEstan.push(p);
        });

        // Cambios pendientes de aprobación
        let pendientes = { nuevos: [...nuevos], cambioPrecio: [...cambioPrecio], yaNoEstan: [...yaNoEstan] };

        result.innerHTML = `
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
            <div style="flex:1;min-width:120px;padding:12px;background:#f0fdf4;border-radius:8px;border:1px solid #86efac;text-align:center">
              <div style="font-size:24px;font-weight:700;color:#166534">${nuevos.length}</div>
              <div style="font-size:12px;color:#15803d">Productos nuevos</div>
            </div>
            <div style="flex:1;min-width:120px;padding:12px;background:#fefce8;border-radius:8px;border:1px solid #fde047;text-align:center">
              <div style="font-size:24px;font-weight:700;color:#854d0e">${cambioPrecio.length}</div>
              <div style="font-size:12px;color:#92400e">Precios cambiaron</div>
            </div>
            <div style="flex:1;min-width:120px;padding:12px;background:#fef2f2;border-radius:8px;border:1px solid #fca5a5;text-align:center">
              <div style="font-size:24px;font-weight:700;color:#991b1b">${yaNoEstan.length}</div>
              <div style="font-size:12px;color:#dc2626">Ya no están</div>
            </div>
            <div style="flex:1;min-width:120px;padding:12px;background:var(--surface);border-radius:8px;border:1px solid var(--border);text-align:center">
              <div style="font-size:24px;font-weight:700">${sinCambio.length}</div>
              <div style="font-size:12px;color:var(--text-muted)">Sin cambios</div>
            </div>
          </div>

          ${nuevos.length > 0 ? `
          <div class="table-card" style="margin-bottom:12px">
            <div class="table-card-header" style="padding:12px 16px">
              <h4 style="margin:0">Productos nuevos del proveedor</h4>
              <button id="btnAprobarNuevos" style="padding:6px 14px;background:var(--primary);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">✓ Agregar todos (${nuevos.length})</button>
            </div>
            <div class="table-wrap"><table>
              <thead><tr><th>Nombre</th><th>Costo</th><th>Categoría</th></tr></thead>
              <tbody>${nuevos.slice(0,20).map(p => `<tr><td>${p.nombre}</td><td>$${fmt(p.costo)}</td><td>${p.categoria}</td></tr>`).join('')}
              ${nuevos.length > 20 ? `<tr><td colspan="3" style="text-align:center;color:var(--text-muted);font-size:12px">... y ${nuevos.length-20} más</td></tr>` : ''}
              </tbody>
            </table></div>
          </div>` : ''}

          ${cambioPrecio.length > 0 ? `
          <div class="table-card" style="margin-bottom:12px">
            <div class="table-card-header" style="padding:12px 16px">
              <h4 style="margin:0">Productos con cambio de precio</h4>
              <button id="btnAprobarPrecios" style="padding:6px 14px;background:#d97706;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">✓ Actualizar todos (${cambioPrecio.length})</button>
            </div>
            <div class="table-wrap"><table>
              <thead><tr><th>Nombre</th><th>Costo anterior</th><th>Nuevo costo</th><th>Diferencia</th></tr></thead>
              <tbody>${cambioPrecio.slice(0,20).map(p => {
                const diff = p.costo - p.costo_anterior;
                const color = diff > 0 ? '#dc2626' : '#16a34a';
                const sign = diff > 0 ? '+' : '';
                return `<tr><td>${p.nombre}</td><td>$${fmt(p.costo_anterior)}</td><td>$${fmt(p.costo)}</td><td style="color:${color};font-weight:700">${sign}$${fmt(diff)}</td></tr>`;
              }).join('')}
              ${cambioPrecio.length > 20 ? `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);font-size:12px">... y ${cambioPrecio.length-20} más</td></tr>` : ''}
              </tbody>
            </table></div>
          </div>` : ''}

          ${yaNoEstan.length > 0 ? `
          <div class="table-card" style="margin-bottom:12px">
            <div class="table-card-header" style="padding:12px 16px">
              <h4 style="margin:0">Productos que ya no están en la lista del proveedor</h4>
            </div>
            <div class="table-wrap"><table>
              <thead><tr><th>Nombre</th><th>Costo actual</th><th>Categoría</th></tr></thead>
              <tbody>${yaNoEstan.slice(0,20).map(p => `<tr style="opacity:0.7"><td>${p.nombre}</td><td>$${fmt(p.costo)}</td><td>${p.categoria}</td></tr>`).join('')}
              ${yaNoEstan.length > 20 ? `<tr><td colspan="3" style="text-align:center;color:var(--text-muted);font-size:12px">... y ${yaNoEstan.length-20} más</td></tr>` : ''}
              </tbody>
            </table></div>
          </div>` : ''}

          <div id="applyMsg"></div>
        `;

        document.getElementById('btnAprobarNuevos')?.addEventListener('click', async () => {
          const btn = document.getElementById('btnAprobarNuevos');
          btn.disabled = true; btn.textContent = 'Agregando...';
          await subirCatalogoFirebase(db, pendientes.nuevos, null);
          invalidateCache('catalogo:all');
          await cargarDatos();
          renderStats();
          document.getElementById('applyMsg').innerHTML = `<div style="padding:10px;background:#f0fdf4;border-radius:8px;color:#166534">${pendientes.nuevos.length} productos nuevos agregados al catálogo.</div>`;
          btn.textContent = '✓ Hecho';
        });

        document.getElementById('btnAprobarPrecios')?.addEventListener('click', async () => {
          const btn = document.getElementById('btnAprobarPrecios');
          btn.disabled = true; btn.textContent = 'Actualizando...';
          for (const p of pendientes.cambioPrecio) {
            if (p.doc_id) {
              await updateDoc(doc(db, 'catalogo', p.doc_id), {
                costo: p.costo,
                estado: p.costo === 0 ? 'sin_precio' : 'activo',
                ultima_actualizacion: serverTimestamp()
              });
            }
          }
          _touchCatalogoMeta(db).catch(() => {});
          invalidateCache('catalogo:all');
          await cargarDatos();
          renderStats();
          document.getElementById('applyMsg').innerHTML = `<div style="padding:10px;background:#fefce8;border-radius:8px;color:#854d0e">${pendientes.cambioPrecio.length} precios actualizados.</div>`;
          btn.textContent = '✓ Hecho';
        });

      } catch(e) {
        result.innerHTML = `<div style="padding:12px;background:#fef2f2;border-radius:8px;color:#dc2626">Error: Error: ${e.message}</div>`;
      }
    }
  }

  // ── Editor de Margen ────────────────────────────────────────────────────────
  async function abrirEditorMargen(p) {
    // Overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px';

    const panel = document.createElement('div');
    panel.style.cssText = 'background:#fff;border-radius:16px;padding:24px;max-width:480px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,0.18)';
    
    const currentMargenPct = p.costo > 0 ? Math.round(((p.precio_venta - p.costo) / p.costo) * 100) : 0;

    panel.innerHTML = `
      <button id="cerrarEditor" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;color:var(--text-muted)">
        <span class="material-icons">close</span>
      </button>
      <h3 style="margin:0 0 16px;font-size:16px">${p.nombre}</h3>
      
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div style="background:#eef4ff;border-radius:10px;padding:12px;border:1px solid #c7d9fc">
          <div style="font-size:11px;color:#1458c2;font-weight:600;margin-bottom:4px">COSTO</div>
          <div style="font-size:16px;font-weight:800;color:#1877f2">$${fmt(p.costo)}</div>
        </div>
        <div style="background:#e8f5e9;border-radius:10px;padding:12px;border:1px solid #a5d6a7">
          <div style="font-size:11px;color:#2e7d32;font-weight:600;margin-bottom:4px">PRECIO ACTUAL</div>
          <div style="font-size:16px;font-weight:800;color:#2e7d32">$${fmt(p.precio_venta)}</div>
        </div>
      </div>

      <div style="background:#f5f5f5;border-radius:10px;padding:12px;margin-bottom:16px;border:1px solid #e0e0e0">
        <div style="font-size:11px;color:#666;font-weight:600;margin-bottom:4px">MARGEN ACTUAL</div>
        <div style="font-size:18px;font-weight:800;color:#7b1fa2">${currentMargenPct}%</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:16px">
        <div>
          <label style="display:block;font-size:12px;font-weight:600;color:#65676b;margin-bottom:6px">% Margen</label>
          <input type="number" id="qm_pct" value="${currentMargenPct}" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box" />
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:600;color:#65676b;margin-bottom:6px">Precio Venta</label>
          <input type="number" id="qm_precio" value="${p.precio_venta}" step="0.01" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box" />
        </div>
      </div>

      <div style="background:#f9f9f9;border-radius:10px;padding:12px;margin-bottom:16px;border:1px solid #e0e0e0">
        <div style="font-size:11px;color:#666;font-weight:600;margin-bottom:4px">GANANCIA ESTIMADA</div>
        <div id="ganancia_live" style="font-size:18px;font-weight:800;color:#16a34a">$0.00</div>
      </div>

      <div style="display:flex;gap:10px">
        <button id="btnGuardarMargen" style="flex:1;padding:12px;background:var(--primary);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px">Guardar</button>
        <button id="btnCancelarMargen" style="flex:1;padding:12px;background:#f0f2f5;color:#1c1e21;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px">Cancelar</button>
      </div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const pctInput = document.getElementById('qm_pct');
    const precioInput = document.getElementById('qm_precio');
    const gananciaDisplay = document.getElementById('ganancia_live');

    function updateGanancia() {
      const pct = parseFloat(pctInput.value) || 0;
      const ganancia = p.costo * pct / 100;
      gananciaDisplay.textContent = `$${fmt(ganancia)}`;
    }

    function syncFromPct() {
      const pct = parseFloat(pctInput.value) || 0;
      const nuevoPrecio = p.costo * (1 + pct / 100);
      precioInput.value = Math.round(nuevoPrecio * 100) / 100;
      updateGanancia();
    }

    function syncFromPrecio() {
      const precio = parseFloat(precioInput.value) || 0;
      const pct = precio > 0 && p.costo > 0 ? Math.round(((precio - p.costo) / p.costo) * 100) : 0;
      pctInput.value = pct;
      updateGanancia();
    }

    pctInput.addEventListener('input', syncFromPct);
    precioInput.addEventListener('input', syncFromPrecio);
    updateGanancia();

    document.getElementById('btnGuardarMargen').addEventListener('click', async () => {
      const nuevoPrecio = parseFloat(precioInput.value) || p.precio_venta;
      try {
        await updateDoc(doc(db, 'catalogo', p.doc_id), {
          precio_venta: nuevoPrecio,
          ultima_actualizacion: serverTimestamp()
        });
        _touchCatalogoMeta(db).catch(() => {});
        // Sincronizar con inventario para que el POS reciba el precio actualizado
        try {
          const invDocId = String(p.id || p.doc_id);
          await setDoc(doc(db, 'inventario', invDocId), {
            precio: nuevoPrecio, nombre: p.nombre || '', id: parseInt(invDocId) || invDocId,
            ultima_actualizacion: serverTimestamp()
          }, { merge: true });
        } catch(e2) { console.warn('No se pudo actualizar inventario:', e2.message); }
        // Update local array
        const idx = allProductos.findIndex(x => x.doc_id === p.doc_id);
        if (idx >= 0) {
          allProductos[idx].precio_venta = nuevoPrecio;
        }
        aplicarFiltros();
        renderStats();
        document.body.removeChild(overlay);
        // Show success message
        const msg = document.createElement('div');
        msg.style.cssText = 'position:fixed;top:20px;right:20px;background:#4caf50;color:#fff;padding:16px 20px;border-radius:8px;z-index:2000;box-shadow:0 4px 12px rgba(0,0,0,0.15)';
        msg.textContent = '✓ Margen actualizado';
        document.body.appendChild(msg);
        setTimeout(() => document.body.removeChild(msg), 3000);
      } catch (e) {
        alert('Error al guardar: ' + e.message);
      }
    });

    document.getElementById('btnCancelarMargen').addEventListener('click', () => {
      document.body.removeChild(overlay);
    });

    document.getElementById('cerrarEditor').addEventListener('click', () => {
      document.body.removeChild(overlay);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) document.body.removeChild(overlay);
    });
  }

  // ── Panel de Detalle del Producto ────────────────────────────────────────────
  async function abrirDetalle(p) {
    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'detalle-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px';

    const panel = document.createElement('div');
    panel.className = 'detalle-panel';
    panel.style.cssText = 'background:#ffffff;border-radius:16px;padding:20px;max-width:620px;width:100%;max-height:90vh;overflow-y:auto;position:relative;box-shadow:0 8px 40px rgba(0,0,0,0.18)';
    panel.innerHTML = `
      <button id="cerrarDetalle" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;color:var(--text-muted)">
        <span class="material-icons">close</span>
      </button>
      <h3 style="margin:0 0 4px;font-size:16px">${p.nombre}</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <span class="badge badge-gray">${p.categoria || '-'}</span>
        <span class="badge badge-gray">${p.marca || '-'}</span>
        <span class="badge badge-gray">${p.proveedor || '-'}</span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:16px">
        <div style="background:#f0f2f5;border-radius:10px;padding:12px;border:1px solid #e4e6eb">
          <div style="font-size:11px;color:#65676b;font-weight:600;margin-bottom:4px">CÓDIGO</div>
          <div style="font-size:15px;font-weight:700;color:#1c1e21">${p.codigo || '-'}</div>
        </div>
        <div style="background:#f0f2f5;border-radius:10px;padding:12px;border:1px solid #e4e6eb">
          <div style="font-size:11px;color:#65676b;font-weight:600;margin-bottom:4px">COD. BARRA</div>
          <div style="font-size:13px;font-weight:700;color:#1c1e21">${p.cod_barra || '-'}</div>
        </div>
        <div style="background:#eef4ff;border-radius:10px;padding:12px;border:1px solid #c7d9fc">
          <div style="font-size:11px;color:#1458c2;font-weight:600;margin-bottom:4px">COSTO</div>
          <div style="font-size:16px;font-weight:800;color:#1877f2">$${fmt(p.costo)}</div>
        </div>
        <div style="background:#e8f5e9;border-radius:10px;padding:12px;border:1px solid #a5d6a7">
          <div style="font-size:11px;color:#2e7d32;font-weight:600;margin-bottom:4px">PRECIO VENTA</div>
          <div style="font-size:16px;font-weight:800;color:#2e7d32">$${fmt(p.precio_venta)}</div>
        </div>
        <div style="background:${(p.stock||0)===0?'#ffebee':(p.stock||0)<=3?'#fff8e1':'#f0f2f5'};border-radius:10px;padding:12px;border:1px solid ${(p.stock||0)===0?'#ef9a9a':(p.stock||0)<=3?'#ffe082':'#e4e6eb'}">
          <div style="font-size:11px;color:#65676b;font-weight:600;margin-bottom:4px">STOCK</div>
          <div style="font-size:22px;font-weight:800;color:${(p.stock||0)===0?'#c62828':(p.stock||0)<=3?'#f57c00':'#1c1e21'}">${p.stock || 0}</div>
        </div>
        <div style="background:#f3e5f5;border-radius:10px;padding:12px;border:1px solid #ce93d8">
          <div style="font-size:11px;color:#7b1fa2;font-weight:600;margin-bottom:4px">MARGEN</div>
          <div style="font-size:18px;font-weight:800;color:#7b1fa2">${p.costo > 0 ? Math.round(((p.precio_venta - p.costo) / p.costo) * 100) : 0}%</div>
        </div>
      </div>

      <div id="ventasDetalle" style="margin-top:8px">
        <div style="text-align:center;padding:20px;color:#65676b">Buscando ventas...</div>
      </div>

      <!-- Alertas de stock -->
      <div style="margin-top:12px;background:#fff8e1;border-radius:12px;padding:14px;border:1px solid #ffe082">
        <div style="font-size:13px;font-weight:700;color:#b45309;margin-bottom:10px">Alertas de stock</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;font-weight:600;color:#65676b">STOCK MÍNIMO (avisar)</label>
            <input id="det_stock_min" type="number" min="0" step="1" placeholder="Sin alerta"
                   value="${p.stock_min ?? ''}"
                   style="width:130px;padding:8px 12px;border:1px solid #ffe082;border-radius:8px;font-size:14px;font-weight:700;color:#b45309;background:#fff" />
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;font-weight:600;color:#65676b">STOCK MÁXIMO (ideal)</label>
            <input id="det_stock_max" type="number" min="0" step="1" placeholder="Sin tope"
                   value="${p.stock_max ?? ''}"
                   style="width:130px;padding:8px 12px;border:1px solid #ffe082;border-radius:8px;font-size:14px;font-weight:700;color:#b45309;background:#fff" />
          </div>
          <button id="det_guardar_stock_alert" style="padding:8px 16px;background:#f59e0b;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px">Guardar alertas</button>
        </div>
        <div id="det_stock_alert_msg" style="margin-top:8px;font-size:12px;color:#65676b">Dejá vacío para desactivar el aviso. El POS usa estos valores para avisarte cuando un producto baja del mínimo.</div>
      </div>

      <!-- Edición de precio por margen -->
      <div style="margin-top:12px;background:#f0f2f5;border-radius:12px;padding:14px;border:1px solid #e4e6eb">
        <div style="font-size:13px;font-weight:700;color:#1c1e21;margin-bottom:10px">Editar precio por margen</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;font-weight:600;color:#65676b">COSTO ACTUAL</label>
            <div style="padding:8px 12px;background:#ffffff;border:1px solid #e4e6eb;border-radius:8px;font-weight:700;color:#1877f2;font-size:14px">$${fmt(p.costo)}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;font-weight:600;color:#65676b">% MARGEN</label>
            <input id="det_pct" type="number" value="${p.costo > 0 ? Math.round(((p.precio_venta - p.costo)/p.costo)*100) : 0}" min="0" step="1" style="width:90px;padding:8px 12px;border:1px solid #e4e6eb;border-radius:8px;font-size:14px;font-weight:700;color:#7b1fa2;background:#fff" />
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;font-weight:600;color:#65676b">PRECIO VENTA</label>
            <input id="det_precio" type="number" value="${p.precio_venta || 0}" min="0" step="0.01" style="width:120px;padding:8px 12px;border:1px solid #e4e6eb;border-radius:8px;font-size:14px;font-weight:700;color:#2e7d32;background:#fff" />
          </div>
          <button id="det_guardar_precio" style="padding:8px 16px;background:#1877f2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px">Guardar precio</button>
        </div>
        <div id="det_precio_msg" style="margin-top:8px;font-size:12px"></div>
      </div>

      <div style="margin-top:12px;font-size:12px;color:#65676b;border-top:1px solid #e4e6eb;padding-top:10px">Última actualización: ${p.ultima_actualizacion || '-'}</div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    document.getElementById('cerrarDetalle').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    // Sincronización % ↔ precio
    const detPct    = document.getElementById('det_pct');
    const detPrecio = document.getElementById('det_precio');
    const detMsg    = document.getElementById('det_precio_msg');

    const detSug = document.getElementById('det_precio_msg');
    const sugerirEnDetalle = (precio) => {
      const sug = sugerirRedondo(p.costo, precio);
      if (detSug && sug) detSug.innerHTML = sug;
      else if (detSug) detSug.innerHTML = '';
    };

    detPct.addEventListener('input', () => {
      const pct = parseFloat(detPct.value) || 0;
      if (p.costo > 0) {
        const nuevoPrecio = p.costo * (1 + pct / 100);
        detPrecio.value = nuevoPrecio.toFixed(2);
        sugerirEnDetalle(nuevoPrecio);
      }
    });
    detPrecio.addEventListener('input', () => {
      const precio = parseFloat(detPrecio.value) || 0;
      if (p.costo > 0) {
        detPct.value = Math.round(((precio - p.costo) / p.costo) * 100);
        sugerirEnDetalle(precio);
      }
    });

    document.getElementById('det_guardar_stock_alert').addEventListener('click', async () => {
      const btn = document.getElementById('det_guardar_stock_alert');
      const msg = document.getElementById('det_stock_alert_msg');
      const rawMin = document.getElementById('det_stock_min').value.trim();
      const rawMax = document.getElementById('det_stock_max').value.trim();
      const sMin = rawMin === '' ? null : Math.max(0, parseInt(rawMin) || 0);
      const sMax = rawMax === '' ? null : Math.max(0, parseInt(rawMax) || 0);
      if (sMin !== null && sMax !== null && sMax > 0 && sMax < sMin) {
        msg.innerHTML = `<span style="color:#c62828">El máximo no puede ser menor al mínimo.</span>`;
        return;
      }
      btn.disabled = true; btn.textContent = 'Guardando...';
      try {
        await updateDoc(doc(db, 'catalogo', p.doc_id), {
          stock_min: sMin,
          stock_max: sMax,
          ultima_actualizacion: serverTimestamp()
        });
        invalidateCacheByPrefix('catalogo');
        _touchCatalogoMeta(db).catch(() => {});
        const idx = allProductos.findIndex(x => x.doc_id === p.doc_id);
        if (idx !== -1) {
          allProductos[idx].stock_min = sMin;
          allProductos[idx].stock_max = sMax;
        }
        p.stock_min = sMin;
        p.stock_max = sMax;
        msg.innerHTML = `<span style="color:#2e7d32">Alertas guardadas ${sMin !== null ? `· mín ${sMin}` : ''} ${sMax !== null ? `· máx ${sMax}` : ''}</span>`;
      } catch(e) {
        msg.innerHTML = `<span style="color:#c62828">Error: ${e.message}</span>`;
      }
      btn.disabled = false; btn.textContent = 'Guardar alertas';
    });

    document.getElementById('det_guardar_precio').addEventListener('click', async () => {
      const nuevoPrecio = parseFloat(detPrecio.value) || 0;
      const btn = document.getElementById('det_guardar_precio');
      btn.disabled = true; btn.textContent = 'Guardando...';
      try {
        await updateDoc(doc(db, 'catalogo', p.doc_id), {
          precio_venta: nuevoPrecio,
          ultima_actualizacion: serverTimestamp()
        });
        invalidateCacheByPrefix('catalogo');
        _touchCatalogoMeta(db).catch(() => {});
        // Sincronizar con inventario para que el POS reciba el precio actualizado
        try {
          const invDocId = String(p.id || p.doc_id);
          await setDoc(doc(db, 'inventario', invDocId), {
            precio: nuevoPrecio, nombre: p.nombre || '', id: parseInt(invDocId) || invDocId,
            ultima_actualizacion: serverTimestamp()
          }, { merge: true });
        } catch(e2) { console.warn('No se pudo actualizar inventario:', e2.message); }
        const idx = allProductos.findIndex(x => x.doc_id === p.doc_id);
        if (idx !== -1) allProductos[idx].precio_venta = nuevoPrecio;
        p.precio_venta = nuevoPrecio;
        detMsg.innerHTML = `<span style="color:#2e7d32">Precio actualizado a $${fmt(nuevoPrecio)}</span>`;
        renderStats();
      } catch(e) {
        detMsg.innerHTML = `<span style="color:#c62828">Error: Error: ${e.message}</span>`;
      }
      btn.disabled = false; btn.textContent = 'Guardar precio';
    });

    // Buscar ventas de este producto en ventas_por_dia
    try {
      const { getDocs: gd, collection: col, query: q, where } = await import('firebase/firestore');
      const nombreLower = (p.nombre || '').toLowerCase();
      const snap = await getDocs(query(
        collection(db, 'ventas_por_dia'),
        orderBy('fecha', 'desc')
      ));

      const ventasProd = snap.docs
        .map(d => d.data())
        .filter(v => (v.producto || '').toLowerCase().includes(nombreLower.substring(0, 20)));

      const totalUnidades = ventasProd.reduce((s, v) => s + (v.cantidad || 1), 0);
      const totalIngresos = ventasProd.reduce((s, v) => s + (v.subtotal || 0), 0);
      const ultimaVenta = ventasProd.length > 0 ? ventasProd[0].fecha : null;

      const ventasEl = document.getElementById('ventasDetalle');
      if (!ventasEl) return;

      ventasEl.innerHTML = `
        <h4 style="margin:0 0 12px;font-size:14px;font-weight:700;border-top:1px solid #e4e6eb;padding-top:12px;color:#1c1e21">Datos de Ventas</h4>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
          <div style="flex:1;min-width:110px;padding:12px;background:#eef4ff;border-radius:10px;text-align:center;border:1px solid #c7d9fc">
            <div style="font-size:24px;font-weight:800;color:#1877f2">${totalUnidades}</div>
            <div style="font-size:11px;color:#1458c2;font-weight:500;margin-top:2px">Unidades vendidas</div>
          </div>
          <div style="flex:1;min-width:110px;padding:12px;background:#e8f5e9;border-radius:10px;text-align:center;border:1px solid #a5d6a7">
            <div style="font-size:20px;font-weight:800;color:#2e7d32">$${fmt(totalIngresos)}</div>
            <div style="font-size:11px;color:#2e7d32;font-weight:500;margin-top:2px">Ingresos totales</div>
          </div>
          <div style="flex:1;min-width:110px;padding:12px;background:#f5f5f5;border-radius:10px;text-align:center;border:1px solid #e0e0e0">
            <div style="font-size:22px;font-weight:800;color:#1c1e21">${ventasProd.length}</div>
            <div style="font-size:11px;color:#65676b;font-weight:500;margin-top:2px">Registros</div>
          </div>
          <div style="flex:1;min-width:110px;padding:12px;background:#fff8e1;border-radius:10px;text-align:center;border:1px solid #ffe082">
            <div style="font-size:14px;font-weight:700;color:#f57c00">${ultimaVenta || '-'}</div>
            <div style="font-size:11px;color:#e65100;font-weight:500;margin-top:2px">Última venta</div>
          </div>
        </div>
        ${ventasProd.length > 0 ? `
        <div style="max-height:220px;overflow-y:auto;border:1px solid #e4e6eb;border-radius:10px">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="background:#f0f2f5;position:sticky;top:0">
              <th style="padding:8px 10px;text-align:left;color:#65676b;font-weight:600">Fecha</th>
              <th style="padding:8px 10px;text-align:left;color:#65676b;font-weight:600">Cajero</th>
              <th style="padding:8px 10px;text-align:center;color:#65676b;font-weight:600">Cant.</th>
              <th style="padding:8px 10px;text-align:right;color:#65676b;font-weight:600">Subtotal</th>
            </tr></thead>
            <tbody>${ventasProd.slice(0, 30).map((v, i) => `
              <tr style="border-top:1px solid #e4e6eb;background:${i % 2 === 0 ? '#ffffff' : '#fafafa'}">
                <td style="padding:7px 10px;color:#1c1e21">${v.fecha || '-'}</td>
                <td style="padding:7px 10px;color:#65676b">${v.cajero || '-'}</td>
                <td style="padding:7px 10px;text-align:center;font-weight:700;color:#1877f2">${v.cantidad || 1}</td>
                <td style="padding:7px 10px;text-align:right;font-weight:700;color:#2e7d32">$${fmt(v.subtotal)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>` : `<div style="background:#f5f5f5;border-radius:10px;padding:20px;text-align:center;color:#65676b;font-size:13px">Sin registros de venta para este producto.</div>`}
      `;
    } catch(e) {
      const ventasEl = document.getElementById('ventasDetalle');
      if (ventasEl) ventasEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">No se pudieron cargar los datos de ventas.</p>`;
    }
  }

  // ── Tab Nuevo Producto (manual) ───────────────────────────────────────────────
  function renderTabNuevo(tc) {
    const cats = [...new Set([
      ...Object.values(CATEGORIA_MAP),
      ...allProductos.map(p => p.categoria)
    ])].filter(Boolean).sort();
    const provs = [...new Set(allProductos.map(p => p.proveedor).filter(Boolean))].sort();

    tc.innerHTML = `
      <div class="table-card" style="max-width:640px">
        <div class="table-card-header"><h3>Agregar Producto</h3></div>
        <div style="padding:20px;display:flex;flex-direction:column;gap:14px">

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:13px;font-weight:600">Nombre del producto *</label>
              <input id="np_nombre" type="text" placeholder="Ej: LAPICERA BIC AZUL X 1" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)" />
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:13px;font-weight:600">Código interno</label>
              <input id="np_codigo" type="text" placeholder="Ej: 300001" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)" />
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:13px;font-weight:600">Código de barras</label>
              <input id="np_barra" type="text" placeholder="Ej: 7891234567890" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)" />
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:13px;font-weight:600">Categoría *</label>
              <select id="np_cat" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)">
                <option value="">Seleccioná una categoría</option>
                ${cats.map(c => `<option value="${c}">${c}</option>`).join('')}
                <option value="__nueva__">+ Nueva categoría...</option>
              </select>
            </div>
            <div id="np_cat_nueva_wrap" style="display:none;flex-direction:column;gap:4px">
              <label style="font-size:13px;font-weight:600">Nueva categoría</label>
              <input id="np_cat_nueva" type="text" placeholder="Ej: BAZAR" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)" />
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:13px;font-weight:600">Proveedor</label>
              <input id="np_prov" type="text" placeholder="Ej: ESTELA MONTENEGRO S.R.L." list="provList" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)" />
              <datalist id="provList">${provs.map(p => `<option value="${p}">`).join('')}</datalist>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:13px;font-weight:600">Marca</label>
              <input id="np_marca" type="text" placeholder="Ej: BIC" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)" />
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:13px;font-weight:600">Costo *</label>
              <input id="np_costo" type="number" placeholder="0.00" min="0" step="0.01" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)" />
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:13px;font-weight:600">% Margen</label>
              <input id="np_margen_pct" type="number" placeholder="Ej: 80" min="0" step="1" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text);font-weight:700;color:#7b1fa2" />
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:13px;font-weight:600">Precio de Venta *</label>
              <input id="np_precio" type="number" placeholder="0.00" min="0" step="0.01" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)" />
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:13px;font-weight:600">Stock inicial</label>
              <input id="np_stock" type="number" placeholder="0" min="0" step="1" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;background:var(--surface);color:var(--text)" />
            </div>
          </div>

          <!-- Preview margen -->
          <div id="np_margen" style="padding:10px 14px;background:var(--surface-2,#f8fafc);border-radius:8px;font-size:13px;color:var(--text-muted);display:none">
            Margen: <b id="np_margen_val" style="color:var(--success)"></b>
          </div>

          <div id="np_msg"></div>

          <button id="np_guardar" style="padding:12px;background:var(--primary);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;transition:opacity 0.2s">
            Guardar Producto
          </button>
        </div>
      </div>
    `;

    // Mostrar campo nueva categoría
    document.getElementById('np_cat').addEventListener('change', e => {
      const wrap = document.getElementById('np_cat_nueva_wrap');
      wrap.style.display = e.target.value === '__nueva__' ? 'flex' : 'none';
    });

    // Preview y cálculo de margen en tiempo real
    const sugerirRedondo = (costo, precio) => {
      if (!costo || costo <= 0) return '';
      const bases = [1, 5, 10, 50, 100, 200, 500, 1000, 2000, 5000];
      const base = bases.find(b => precio < b * 20 && b >= Math.max(1, precio * 0.02)) || 100;
      const redondoArriba = Math.ceil(precio / base) * base;
      const redondoAbajo  = Math.floor(precio / base) * base;
      const candidato = (redondoArriba - precio) <= (precio - redondoAbajo) ? redondoArriba : redondoAbajo;
      if (candidato === precio) return '';
      const pctCandidato = ((candidato - costo) / costo * 100).toFixed(1);
      const diff = candidato - precio;
      const signo = diff > 0 ? '+' : '';
      return `<span style="font-size:11px;color:#7b1fa2;font-style:italic">Con ${pctCandidato}% el precio queda en $${fmt(candidato)} (${signo}$${fmt(diff)})</span>`;
    };

    let _actualizandoDesdeMargen = false;
    let _actualizandoDesde = null;

    const actualizarPreview = (costo, precio) => {
      const margenEl  = document.getElementById('np_margen');
      const margenVal = document.getElementById('np_margen_val');
      if (costo > 0 && precio > 0) {
        const pct      = ((precio - costo) / costo * 100).toFixed(1);
        const ganancia = precio - costo;
        const sugerencia = sugerirRedondo(costo, precio);
        margenVal.innerHTML = `${pct}% ($${fmt(ganancia)} por unidad)${sugerencia ? '<br>' + sugerencia : ''}`;
        margenVal.style.color = parseFloat(pct) >= 0 ? 'var(--success)' : 'var(--danger)';
        margenEl.style.display = 'block';
      } else {
        margenEl.style.display = 'none';
      }
    };

    // Costo o margen% → calcula precio
    const onCostoOMargen = () => {
      if (_actualizandoDesde === 'precio') return;
      const costo = parseFloat(document.getElementById('np_costo').value) || 0;
      const pct   = parseFloat(document.getElementById('np_margen_pct').value);
      if (costo > 0 && !isNaN(pct)) {
        _actualizandoDesde = 'margen';
        document.getElementById('np_precio').value = (costo * (1 + pct / 100)).toFixed(2);
        _actualizandoDesde = null;
      }
      const precio = parseFloat(document.getElementById('np_precio').value) || 0;
      actualizarPreview(costo, precio);
    };

    // Precio → calcula margen%
    const onPrecio = () => {
      if (_actualizandoDesde === 'margen') return;
      const costo  = parseFloat(document.getElementById('np_costo').value) || 0;
      const precio = parseFloat(document.getElementById('np_precio').value) || 0;
      if (costo > 0 && precio > 0) {
        _actualizandoDesde = 'precio';
        document.getElementById('np_margen_pct').value = ((precio - costo) / costo * 100).toFixed(1);
        _actualizandoDesde = null;
      }
      actualizarPreview(costo, precio);
    };

    document.getElementById('np_costo').addEventListener('input', onCostoOMargen);
    document.getElementById('np_margen_pct').addEventListener('input', onCostoOMargen);
    document.getElementById('np_precio').addEventListener('input', onPrecio);

    // Guardar
    document.getElementById('np_guardar').addEventListener('click', async () => {
      const nombre = document.getElementById('np_nombre').value.trim().toUpperCase();
      const catSelect = document.getElementById('np_cat').value;
      const catNueva  = document.getElementById('np_cat_nueva').value.trim().toUpperCase();
      const categoria = catSelect === '__nueva__' ? normalizarCategoria(catNueva) : catSelect;
      const costo     = parseFloat(document.getElementById('np_costo').value) || 0;
      const precio    = parseFloat(document.getElementById('np_precio').value) || 0;
      const msgEl     = document.getElementById('np_msg');

      if (!nombre) { msgEl.innerHTML = `<div style="padding:10px;background:#fef2f2;border-radius:8px;color:#dc2626">Error: El nombre es obligatorio.</div>`; return; }
      if (!categoria || categoria === '') { msgEl.innerHTML = `<div style="padding:10px;background:#fef2f2;border-radius:8px;color:#dc2626">Error: Seleccioná una categoría.</div>`; return; }

      const codigo = document.getElementById('np_codigo').value.trim() || slugify(nombre);

      // Obtener el próximo pos_id único consultando el config
      let nextPosId = Date.now(); // fallback: timestamp como ID único
      try {
        const configRef = doc(db, 'config', 'pos_id_counter');
        const configSnap = await getDoc(configRef);
        if (configSnap.exists()) {
          nextPosId = (configSnap.data().last_id || 12938) + 1;
        } else {
          nextPosId = 12939; // siguiente al último asignado en batch
        }
        // Guardar el nuevo contador
        await setDoc(configRef, { last_id: nextPosId });
      } catch(e) {
        console.warn('No se pudo obtener pos_id_counter:', e.message);
      }

      const barraRawNuevo = document.getElementById('np_barra').value.trim();
      const codBarraNuevo = /^[A-Za-z0-9\-_]{3,50}$/.test(barraRawNuevo) ? barraRawNuevo : '';

      const nuevo = {
        doc_id: codigo,
        codigo,
        nombre,
        cod_barra: codBarraNuevo,
        categoria,
        proveedor: document.getElementById('np_prov').value.trim() || 'SIN PROVEEDOR',
        marca: document.getElementById('np_marca').value.trim().toUpperCase() || 'SIN MARCA',
        moneda: 'PESOS',
        costo,
        precio_venta: precio,
        stock: Math.max(0, parseInt(document.getElementById('np_stock').value) || 0),
        estado: costo === 0 ? 'sin_precio' : 'activo',
        duplicado: false,
        pos_id: nextPosId,
        ultima_actualizacion: serverTimestamp(),
        historial_precios: [],
      };

      const btn = document.getElementById('np_guardar');
      btn.disabled = true; btn.textContent = 'Guardando...';
      try {
        await setDoc(doc(db, 'catalogo', codigo), nuevo);
        invalidateCacheByPrefix('catalogo');
        _touchCatalogoMeta(db).catch(() => {});

        // Agregar al array local sin re-fetchear Firestore
        const nuevoLocal = { ...nuevo, ultima_actualizacion: new Date() };
        allProductos.push(nuevoLocal);
        allProductos.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
        filtrados = [...allProductos];
        renderStats();

        msgEl.innerHTML = `<div style="padding:12px;background:#f0fdf4;border-radius:8px;color:#166534">Producto <b>${nombre}</b> guardado correctamente.</div>`;
        // Limpiar formulario
        ['np_nombre','np_codigo','np_barra','np_prov','np_marca','np_costo','np_precio','np_stock','np_margen_pct'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
        document.getElementById('np_cat').value = '';
        document.getElementById('np_margen').style.display = 'none';
      } catch(e) {
        msgEl.innerHTML = `<div style="padding:10px;background:#fef2f2;border-radius:8px;color:#dc2626">Error: ${e.message}</div>`;
      }
      btn.disabled = false; btn.textContent = 'Guardar Producto';
    });
  }

  // ── Tab Márgenes masivos ─────────────────────────────────────────────────────
  function renderTabMargenes(tc) {
    const cats  = [...new Set(allProductos.map(p => p.categoria).filter(Boolean))].sort();
    const provs = [...new Set(allProductos.map(p => p.proveedor).filter(Boolean))].sort();
    const marcas= [...new Set(allProductos.map(p => p.marca).filter(Boolean))].sort();

    tc.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px;max-width:700px">

        <!-- Calculadora individual -->
        <div class="table-card">
          <div class="table-card-header"><h3>Calculadora de Margen</h3></div>
          <div style="padding:16px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:12px;font-weight:600;color:#65676b">COSTO</label>
              <input id="calc_costo" type="number" placeholder="0.00" step="0.01" style="width:130px;padding:8px 12px;border:1px solid #e4e6eb;border-radius:8px;font-size:14px" />
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:12px;font-weight:600;color:#65676b">% MARGEN</label>
              <input id="calc_pct" type="number" placeholder="80" step="1" style="width:100px;padding:8px 12px;border:1px solid #e4e6eb;border-radius:8px;font-size:14px;color:#7b1fa2;font-weight:700" />
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:12px;font-weight:600;color:#65676b">PRECIO VENTA</label>
              <input id="calc_precio" type="number" placeholder="0.00" step="0.01" style="width:130px;padding:8px 12px;border:1px solid #e4e6eb;border-radius:8px;font-size:14px;color:#2e7d32;font-weight:700" />
            </div>
            <div id="calc_result" style="padding:8px 14px;background:#f0f2f5;border-radius:8px;font-size:13px;color:#65676b;align-self:flex-end"></div>
          </div>
        </div>

        <!-- Aplicación masiva -->
        <div class="table-card">
          <div class="table-card-header"><h3>Aplicar Margen en Lote</h3></div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:14px">
            <p style="font-size:13px;color:#65676b;margin:0">Seleccioná un grupo de productos y aplicá un % de margen sobre el costo. El sistema calculará y actualizará el precio de venta automáticamente.</p>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div style="display:flex;flex-direction:column;gap:4px">
                <label style="font-size:12px;font-weight:600;color:#65676b">APLICAR A</label>
                <select id="mas_tipo" style="padding:8px 12px;border:1px solid #e4e6eb;border-radius:8px;font-size:14px">
                  <option value="todos">Todos los productos</option>
                  <option value="categoria">Por Categoría</option>
                  <option value="proveedor">Por Proveedor</option>
                  <option value="marca">Por Marca</option>
                  <option value="producto">Producto específico</option>
                </select>
              </div>
              <div id="mas_filtro_wrap" style="display:none;flex-direction:column;gap:4px">
                <label id="mas_filtro_label" style="font-size:12px;font-weight:600;color:#65676b">CATEGORÍA</label>
                <select id="mas_filtro_val" style="padding:8px 12px;border:1px solid #e4e6eb;border-radius:8px;font-size:14px"></select>
              </div>
              <div id="mas_prod_wrap" style="display:none;flex-direction:column;gap:6px;grid-column:1/-1">
                <label style="font-size:12px;font-weight:600;color:#65676b">BUSCAR PRODUCTO</label>
                <input id="mas_prod_buscar" type="text" placeholder="🔍 Escribí el nombre del producto..." style="padding:8px 12px;border:1px solid #e4e6eb;border-radius:8px;font-size:14px;width:100%" />
                <div id="mas_prod_lista" style="border:1px solid #e4e6eb;border-radius:8px;max-height:200px;overflow-y:auto;display:none;background:#fff"></div>
                <div id="mas_prod_seleccionado" style="display:none;padding:10px 14px;background:#eef4ff;border-radius:8px;border:1px solid #c7d9fc;align-items:center;justify-content:space-between">
                  <div>
                    <div id="mas_prod_nombre" style="font-weight:700;font-size:13px;color:#1c1e21"></div>
                    <div id="mas_prod_info" style="font-size:12px;color:#65676b;margin-top:2px"></div>
                  </div>
                  <button id="mas_prod_quitar" style="background:none;border:none;cursor:pointer;color:#c62828;font-size:13px">Quitar</button>
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:4px">
                <label style="font-size:12px;font-weight:600;color:#65676b">% DE MARGEN SOBRE COSTO</label>
                <input id="mas_pct" type="number" placeholder="Ej: 80" min="0" step="1" style="padding:8px 12px;border:2px solid #7b1fa2;border-radius:8px;font-size:16px;font-weight:700;color:#7b1fa2;width:120px" />
              </div>
              <div style="display:flex;flex-direction:column;gap:4px">
                <label style="font-size:12px;font-weight:600;color:#65676b">SOLO PRODUCTOS CON COSTO</label>
                <label style="display:flex;align-items:center;gap:8px;padding:8px;background:#f0f2f5;border-radius:8px;cursor:pointer">
                  <input type="checkbox" id="mas_solocosto" checked style="width:16px;height:16px" />
                  <span style="font-size:13px">Ignorar productos sin costo (costo = 0)</span>
                </label>
              </div>
            </div>

            <!-- Preview -->
            <div id="mas_preview" style="display:none;background:#f0f2f5;border-radius:10px;padding:12px;font-size:13px">
              <b id="mas_preview_count"></b> productos serán actualizados
            </div>

            <div style="display:flex;gap:10px">
              <button id="mas_preview_btn" style="padding:10px 20px;background:#f0f2f5;border:1px solid #e4e6eb;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;color:#1c1e21">Vista previa</button>
              <button id="mas_aplicar" style="padding:10px 24px;background:#1877f2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:700" disabled>Aplicar a todos</button>
            </div>

            <div id="mas_progress" style="display:none;flex-direction:column;gap:8px">
              <div style="display:flex;justify-content:space-between;font-size:13px">
                <span id="mas_prog_text">Aplicando...</span>
                <span id="mas_prog_pct">0%</span>
              </div>
              <div style="background:#e4e6eb;border-radius:99px;height:8px;overflow:hidden">
                <div id="mas_prog_bar" style="height:100%;background:#1877f2;width:0%;transition:width 0.3s;border-radius:99px"></div>
              </div>
            </div>

            <div id="mas_result"></div>

            <!-- Tabla preview -->
            <div id="mas_tabla" style="display:none">
              <div class="table-wrap" style="max-height:300px;overflow-y:auto;border:1px solid #e4e6eb;border-radius:10px">
                <table style="width:100%;border-collapse:collapse;font-size:12px">
                  <thead><tr style="background:#f0f2f5;position:sticky;top:0">
                    <th style="padding:8px 10px;text-align:left;color:#65676b">Producto</th>
                    <th style="padding:8px 10px;text-align:right;color:#65676b">Costo</th>
                    <th style="padding:8px 10px;text-align:right;color:#65676b">Precio actual</th>
                    <th style="padding:8px 10px;text-align:right;color:#65676b">Nuevo precio</th>
                    <th style="padding:8px 10px;text-align:right;color:#65676b">Diferencia</th>
                  </tr></thead>
                  <tbody id="mas_tbody"></tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Calculadora individual - sincronización % ↔ precio
    const cCalc = document.getElementById('calc_costo');
    const pCalc = document.getElementById('calc_pct');
    const vCalc = document.getElementById('calc_precio');
    const rCalc = document.getElementById('calc_result');

    const actualizarCalc = (origen) => {
      const costo = parseFloat(cCalc.value) || 0;
      const pct   = parseFloat(pCalc.value);
      const precio= parseFloat(vCalc.value);
      if (costo <= 0) { rCalc.innerHTML = ''; return; }
      let precioCalc = 0;
      if (origen === 'pct' && !isNaN(pct)) {
        precioCalc = costo * (1 + pct/100);
        vCalc.value = precioCalc.toFixed(2);
        const ganancia = precioCalc - costo;
        const sug = sugerirRedondo(costo, precioCalc);
        rCalc.innerHTML = `Ganancia: <b style="color:#2e7d32">$${fmt(ganancia)}</b>${sug ? ' &nbsp; ' + sug : ''}`;
      } else if (origen === 'precio' && !isNaN(precio)) {
        precioCalc = precio;
        pCalc.value = Math.round(((precio - costo)/costo)*100);
        const ganancia = precio - costo;
        const sug = sugerirRedondo(costo, precio);
        rCalc.innerHTML = `Ganancia: <b style="color:#2e7d32">$${fmt(ganancia)}</b>${sug ? ' &nbsp; ' + sug : ''}`;
      }
    };
    cCalc.addEventListener('input', () => actualizarCalc('pct'));
    pCalc.addEventListener('input', () => actualizarCalc('pct'));
    vCalc.addEventListener('input', () => actualizarCalc('precio'));

    // Aplicación masiva - mostrar/ocultar filtro
    const masTipo = document.getElementById('mas_tipo');
    const masFiltroWrap = document.getElementById('mas_filtro_wrap');
    const masFiltroLabel = document.getElementById('mas_filtro_label');
    const masFiltroVal = document.getElementById('mas_filtro_val');

    let productoSeleccionado = null;

    masTipo.addEventListener('change', () => {
      const tipo = masTipo.value;
      const prodWrap = document.getElementById('mas_prod_wrap');
      if (tipo === 'todos') {
        masFiltroWrap.style.display = 'none';
        prodWrap.style.display = 'none';
        return;
      }
      if (tipo === 'producto') {
        masFiltroWrap.style.display = 'none';
        prodWrap.style.display = 'flex';
        return;
      }
      prodWrap.style.display = 'none';
      masFiltroWrap.style.display = 'flex';
      masFiltroLabel.textContent = tipo === 'categoria' ? 'CATEGORÍA' : tipo === 'proveedor' ? 'PROVEEDOR' : 'MARCA';
      const opciones = tipo === 'categoria' ? cats : tipo === 'proveedor' ? provs : marcas;
      masFiltroVal.innerHTML = opciones.map(o => `<option value="${o}">${o}</option>`).join('');
    });

    // Búsqueda de producto específico
    const prodBuscar = document.getElementById('mas_prod_buscar');
    const prodLista  = document.getElementById('mas_prod_lista');
    const prodSel    = document.getElementById('mas_prod_seleccionado');
    const prodNombre = document.getElementById('mas_prod_nombre');
    const prodInfo   = document.getElementById('mas_prod_info');

    prodBuscar.addEventListener('input', () => {
      const q = prodBuscar.value.toLowerCase().trim();
      if (q.length < 2) { prodLista.style.display = 'none'; return; }

      // Resolver sinónimos: si el usuario escribe "boligrafo", buscar también "lapicera"
      const qNorm = normalizarCategoria(q);
      const matches = allProductos.filter(p => {
        const haystack = `${p.nombre} ${p.codigo} ${p.cod_barra} ${p.categoria}`.toLowerCase();
        // Match directo en nombre/código
        if (haystack.includes(q)) return true;
        // Match por categoría normalizada (ej: buscar "birome" encuentra categoría LAPICERA)
        if (qNorm !== q.toUpperCase() && (p.categoria || '').toUpperCase() === qNorm) return true;
        // Match si la búsqueda es un sinónimo y el nombre contiene la categoría canónica
        const catNorm = normalizarCategoria(q.toUpperCase());
        if (catNorm !== q.toUpperCase() && (p.categoria || '').toUpperCase() === catNorm) return true;
        return false;
      }).slice(0, 15);
      if (!matches.length) { prodLista.style.display = 'none'; return; }
      prodLista.style.display = 'block';
      prodLista.innerHTML = matches.map(p => `
        <div class="prod-option" data-id="${p.doc_id}" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid #f0f2f5;transition:background 0.15s">
          <div style="font-weight:600;font-size:13px;color:#1c1e21">${p.nombre}</div>
          <div style="font-size:11px;color:#65676b">${p.categoria} · Costo: $${fmt(p.costo)} · Precio: $${fmt(p.precio_venta)}</div>
        </div>`).join('');
      prodLista.querySelectorAll('.prod-option').forEach(opt => {
        opt.addEventListener('mouseenter', () => opt.style.background = '#f0f2f5');
        opt.addEventListener('mouseleave', () => opt.style.background = '');
        opt.addEventListener('click', () => {
          productoSeleccionado = allProductos.find(p => p.doc_id === opt.dataset.id);
          prodNombre.textContent = productoSeleccionado.nombre;
          prodInfo.textContent = `${productoSeleccionado.categoria} · Costo: $${fmt(productoSeleccionado.costo)} · Precio actual: $${fmt(productoSeleccionado.precio_venta)}`;
          prodSel.style.cssText = 'display:flex;padding:10px 14px;background:#eef4ff;border-radius:8px;border:1px solid #c7d9fc;align-items:center;justify-content:space-between';
          prodLista.style.display = 'none';
          prodBuscar.value = '';
        });
      });
    });

    document.getElementById('mas_prod_quitar').addEventListener('click', () => {
      productoSeleccionado = null;
      prodSel.style.display = 'none';
      prodBuscar.value = '';
    });

    // Función para obtener productos a afectar
    const getAfectados = () => {
      const tipo = masTipo.value;
      const val  = masFiltroVal.value;
      const pct  = parseFloat(document.getElementById('mas_pct').value) || 0;
      const soloCosto = document.getElementById('mas_solocosto').checked;

      // Producto específico
      if (tipo === 'producto') {
        if (!productoSeleccionado) return [];
        const p = productoSeleccionado;
        if (soloCosto && (p.costo || 0) <= 0) return [];
        return [{ ...p, nuevo_precio: parseFloat((p.costo * (1 + pct/100)).toFixed(2)) }];
      }

      let lista = [...allProductos];
      if (soloCosto) lista = lista.filter(p => (p.costo || 0) > 0);
      if (tipo === 'categoria') lista = lista.filter(p => p.categoria === val);
      else if (tipo === 'proveedor') lista = lista.filter(p => p.proveedor === val);
      else if (tipo === 'marca') lista = lista.filter(p => p.marca === val);
      return lista.map(p => ({ ...p, nuevo_precio: parseFloat((p.costo * (1 + pct/100)).toFixed(2)) }));
    };

    // Vista previa
    document.getElementById('mas_preview_btn').addEventListener('click', () => {
      const pct = parseFloat(document.getElementById('mas_pct').value);
      if (!pct && pct !== 0) { alert('Ingresá un % de margen'); return; }
      const afectados = getAfectados();
      const preview = document.getElementById('mas_preview');
      const tabla = document.getElementById('mas_tabla');
      const tbody = document.getElementById('mas_tbody');
      preview.style.display = 'block';
      document.getElementById('mas_preview_count').textContent = afectados.length;
      tabla.style.display = 'block';
      document.getElementById('mas_aplicar').disabled = afectados.length === 0;

      tbody.innerHTML = afectados.slice(0, 50).map((p, i) => {
        const diff = p.nuevo_precio - (p.precio_venta || 0);
        const color = diff > 0 ? '#2e7d32' : diff < 0 ? '#c62828' : '#65676b';
        const sign  = diff > 0 ? '+' : '';
        return `<tr style="border-top:1px solid #e4e6eb;background:${i%2===0?'#fff':'#fafafa'}">
          <td style="padding:6px 10px;font-size:12px">${p.nombre}</td>
          <td style="padding:6px 10px;text-align:right;color:#1877f2">$${fmt(p.costo)}</td>
          <td style="padding:6px 10px;text-align:right;color:#65676b">$${fmt(p.precio_venta)}</td>
          <td style="padding:6px 10px;text-align:right;font-weight:700;color:#2e7d32">$${fmt(p.nuevo_precio)}</td>
          <td style="padding:6px 10px;text-align:right;font-weight:700;color:${color}">${sign}$${fmt(diff)}</td>
        </tr>`;
      }).join('') + (afectados.length > 50 ? `<tr><td colspan="5" style="text-align:center;padding:8px;color:#65676b;font-size:12px">... y ${afectados.length-50} más</td></tr>` : '');
    });

    // Aplicar masivamente
    document.getElementById('mas_aplicar').addEventListener('click', async () => {
      const afectados = getAfectados();
      if (!afectados.length) return;
      if (!confirm(`¿Actualizar precio de ${afectados.length} productos con el margen indicado?`)) return;

      const progWrap = document.getElementById('mas_progress');
      const progBar  = document.getElementById('mas_prog_bar');
      const progText = document.getElementById('mas_prog_text');
      const progPct  = document.getElementById('mas_prog_pct');
      const resEl    = document.getElementById('mas_result');
      progWrap.style.display = 'flex';
      document.getElementById('mas_aplicar').disabled = true;

      const BATCH = 400;
      let done = 0;
      for (let i = 0; i < afectados.length; i += BATCH) {
        const batch = writeBatch(db);
        const batchInv = writeBatch(db);
        const chunk = afectados.slice(i, i + BATCH);
        for (const p of chunk) {
          batch.update(doc(db, 'catalogo', p.doc_id), {
            precio_venta: p.nuevo_precio,
            ultima_actualizacion: serverTimestamp()
          });
          // Sincronizar con inventario para que el POS reciba el precio actualizado
          const invDocId = String(p.id || p.doc_id);
          batchInv.set(doc(db, 'inventario', invDocId), {
            precio: p.nuevo_precio, nombre: p.nombre || '', id: parseInt(invDocId) || invDocId,
            ultima_actualizacion: serverTimestamp()
          }, { merge: true });
        }
        await batch.commit();
        try { await batchInv.commit(); } catch(e2) { console.warn('No se pudo actualizar inventario batch:', e2.message); }
        done += chunk.length;
        const pct = Math.round((done / afectados.length) * 100);
        progBar.style.width = pct + '%';
        progPct.textContent = pct + '%';
        progText.textContent = `Actualizando... ${done}/${afectados.length}`;
      }
      _touchCatalogoMeta(db).catch(() => {});
      invalidateCache('catalogo:all');
      await cargarDatos();
      renderStats();
      progWrap.style.display = 'none';
      resEl.innerHTML = `<div style="padding:12px;background:#e8f5e9;border-radius:8px;border:1px solid #a5d6a7;color:#2e7d32;font-weight:600">${afectados.length} productos actualizados correctamente.</div>`;
      document.getElementById('mas_aplicar').disabled = false;
    });
  }


  // ── Tab Reportes ─────────────────────────────────────────────────────────────
  async function renderTabReportes(tc) {
    tc.innerHTML = `<div style="text-align:center;padding:40px;color:#65676b">Calculando reportes...</div>`;

    const base = rubroActivo === 'TODOS' ? allProductos : allProductos.filter(p => {
      const cats = RUBRO_CATS[rubroActivo] || [];
      return (p.rubro||'').toUpperCase()===rubroActivo || cats.includes((p.categoria||'').toUpperCase());
    });

    const conPrecio = base.filter(p => p.costo > 0 && p.precio_venta > 0);
    const totalCosto = conPrecio.reduce((s,p) => s + p.costo, 0);
    const totalVenta = conPrecio.reduce((s,p) => s + p.precio_venta, 0);
    const gananciaTeoric = totalVenta - totalCosto;
    const margenPromedio = totalCosto > 0 ? ((gananciaTeoric/totalCosto)*100).toFixed(1) : 0;

    const topMargen = [...conPrecio].map(p => ({ ...p, margen: ((p.precio_venta-p.costo)/p.costo*100) })).sort((a,b)=>b.margen-a.margen).slice(0,10);
    const bottomMargen = [...conPrecio].map(p => ({ ...p, margen: ((p.precio_venta-p.costo)/p.costo*100) })).sort((a,b)=>a.margen-b.margen).slice(0,10);

    const porCat = {};
    conPrecio.forEach(p => {
      const c = p.categoria || 'SIN CATEGORÍA';
      if (!porCat[c]) porCat[c] = { productos:0, costo:0, venta:0 };
      porCat[c].productos++; porCat[c].costo += p.costo; porCat[c].venta += p.precio_venta;
    });
    const catRows = Object.entries(porCat).map(([cat,d]) => ({ cat, ...d, margen:((d.venta-d.costo)/d.costo*100).toFixed(1) })).sort((a,b)=>b.venta-a.venta);

    // Cargar ventas reales
    let ventasReales = [];
    let totalVendidoReal = 0, totalIngresosReal = 0;
    let ventasPorDia = {}, ventasPorMes = {};
    let prodVentas = {};
    try {
      const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha','desc')));
      ventasReales = snap.docs.map(d => d.data());
      totalVendidoReal = ventasReales.reduce((s,v) => s+(v.cantidad||1), 0);
      totalIngresosReal = ventasReales.reduce((s,v) => s+(v.subtotal||0), 0);

      // Agrupar por día
      ventasReales.forEach(v => {
        const d = v.fecha || 'Sin fecha';
        if (!ventasPorDia[d]) ventasPorDia[d] = { ingresos:0, unidades:0, ventas:0 };
        ventasPorDia[d].ingresos += (v.subtotal||0);
        ventasPorDia[d].unidades += (v.cantidad||1);
        ventasPorDia[d].ventas++;
      });

      // Agrupar por mes
      ventasReales.forEach(v => {
        const fecha = v.fecha || '';
        const parts = fecha.split('/');
        const mes = parts.length >= 2 ? `${parts[1]}/${parts[2]||''}`.replace(/\/$/, '') : fecha.substring(0,7);
        if (!ventasPorMes[mes]) ventasPorMes[mes] = { ingresos:0, unidades:0, ventas:0 };
        ventasPorMes[mes].ingresos += (v.subtotal||0);
        ventasPorMes[mes].unidades += (v.cantidad||1);
        ventasPorMes[mes].ventas++;
      });

      // Top productos
      ventasReales.forEach(v => {
        const k = (v.producto||'').toUpperCase().trim();
        if (!k) return;
        if (!prodVentas[k]) prodVentas[k] = { nombre:v.producto, unidades:0, ingresos:0 };
        prodVentas[k].unidades += (v.cantidad||1);
        prodVentas[k].ingresos += (v.subtotal||0);
      });
    } catch(e) {}

    const topVendidos = Object.values(prodVentas).sort((a,b)=>b.unidades-a.unidades).slice(0,10);
    const topIngresos = Object.values(prodVentas).sort((a,b)=>b.ingresos-a.ingresos).slice(0,10);
    const diasOrdenados = Object.entries(ventasPorDia).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,30);
    const mesesOrdenados = Object.entries(ventasPorMes).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,12);

    const cardClickStyle = 'cursor:pointer;transition:transform 0.15s,box-shadow 0.15s;';

    tc.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div style="font-size:13px;color:#65676b;padding:4px 0">
          Sección: <b style="color:#1877f2">${rubroActivo === 'TODOS' ? 'Todas' : rubroActivo}</b> &nbsp;·&nbsp; <b>${base.length}</b> productos
        </div>

        <!-- TARJETAS PRINCIPALES CLICKEABLES -->
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px">
          <div class="rep-card" data-panel="margen" style="${cardClickStyle}background:#eef4ff;border-radius:12px;padding:14px;border:1px solid #c7d9fc">
            <div style="font-size:11px;font-weight:700;color:#1458c2">PRODUCTOS CON PRECIO</div>
            <div style="font-size:26px;font-weight:800;color:#1877f2;margin-top:4px">${conPrecio.length}</div>
            <div style="font-size:11px;color:#1877f2;margin-top:4px">Ver margen por categoría →</div>
          </div>
          <div class="rep-card" data-panel="ganancia" style="${cardClickStyle}background:#e8f5e9;border-radius:12px;padding:14px;border:1px solid #a5d6a7">
            <div style="font-size:11px;font-weight:700;color:#2e7d32">GANANCIA TEÓRICA</div>
            <div style="font-size:20px;font-weight:800;color:#2e7d32;margin-top:4px">$${fmt(gananciaTeoric)}</div>
            <div style="font-size:11px;color:#2e7d32;margin-top:4px">Margen promedio: ${margenPromedio}% →</div>
          </div>
          <div class="rep-card" data-panel="ingresos" style="${cardClickStyle}background:#fff8e1;border-radius:12px;padding:14px;border:1px solid #ffe082">
            <div style="font-size:11px;font-weight:700;color:#f57c00">INGRESOS REALES</div>
            <div style="font-size:20px;font-weight:800;color:#f57c00;margin-top:4px">$${fmt(totalIngresosReal)}</div>
            <div style="font-size:11px;color:#e65100;margin-top:4px">Ver por día y mes →</div>
          </div>
          <div class="rep-card" data-panel="unidades" style="${cardClickStyle}background:#fce4ec;border-radius:12px;padding:14px;border:1px solid #f48fb1">
            <div style="font-size:11px;font-weight:700;color:#c2185b">UNIDADES VENDIDAS</div>
            <div style="font-size:26px;font-weight:800;color:#c2185b;margin-top:4px">${totalVendidoReal}</div>
            <div style="font-size:11px;color:#c2185b;margin-top:4px">Ver más vendidos →</div>
          </div>
        </div>

        <!-- PANEL DE DETALLE DINÁMICO -->
        <div id="repPanel" style="display:none"></div>

      </div>
    `;

    // Función para abrir panel de detalle
    function mostrarPanel(tipo) {
      const panel = document.getElementById('repPanel');
      panel.style.display = 'block';
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

      if (tipo === 'margen' || tipo === 'ganancia') {
        panel.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:12px">
            <div class="table-card">
              <div class="table-card-header" style="padding:12px 16px">
                <h3 style="margin:0">Margen por Categoría</h3>
                <span style="font-size:12px;color:#65676b">${catRows.length} categorías</span>
              </div>
              <div class="table-wrap" style="max-height:350px;overflow-y:auto">
                <table>
                  <thead><tr>
                    <th>Categoría</th><th style="text-align:center">Productos</th>
                    <th style="text-align:right">Costo total</th><th style="text-align:right">Precio total</th>
                    <th style="text-align:right">Ganancia</th><th style="text-align:right">Margen</th>
                  </tr></thead>
                  <tbody>${catRows.map((r,i)=>`
                    <tr style="background:${i%2===0?'#fff':'#fafafa'}">
                      <td><span class="badge badge-gray">${r.cat}</span></td>
                      <td style="text-align:center">${r.productos}</td>
                      <td style="text-align:right;color:#1877f2">$${fmt(r.costo)}</td>
                      <td style="text-align:right;color:#2e7d32">$${fmt(r.venta)}</td>
                      <td style="text-align:right;font-weight:700;color:#2e7d32">$${fmt(r.venta-r.costo)}</td>
                      <td style="text-align:right;font-weight:700;color:#7b1fa2">${r.margen}%</td>
                    </tr>`).join('')}
                  </tbody>
                </table>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div class="table-card">
                <div class="table-card-header" style="padding:12px 16px"><h4 style="margin:0;font-size:14px">Mayor Margen</h4></div>
                <div class="table-wrap">
                  <table><thead><tr><th>Producto</th><th style="text-align:right">Margen</th></tr></thead>
                  <tbody>${topMargen.map((p,i)=>`<tr style="background:${i%2===0?'#fff':'#fafafa'}"><td style="font-size:12px">${p.nombre}</td><td style="text-align:right;font-weight:700;color:#2e7d32">${p.margen.toFixed(1)}%</td></tr>`).join('')}</tbody></table>
                </div>
              </div>
              <div class="table-card">
                <div class="table-card-header" style="padding:12px 16px"><h4 style="margin:0;font-size:14px">Menor Margen</h4></div>
                <div class="table-wrap">
                  <table><thead><tr><th>Producto</th><th style="text-align:right">Margen</th></tr></thead>
                  <tbody>${bottomMargen.map((p,i)=>`<tr style="background:${i%2===0?'#fff':'#fafafa'}"><td style="font-size:12px">${p.nombre}</td><td style="text-align:right;font-weight:700;color:${p.margen<0?'#c62828':'#f57c00'}">${p.margen.toFixed(1)}%</td></tr>`).join('')}</tbody></table>
                </div>
              </div>
            </div>
          </div>`;
      }

      else if (tipo === 'ingresos') {
        panel.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:12px">
            <div class="table-card">
              <div class="table-card-header" style="padding:12px 16px"><h3 style="margin:0">Ventas por Día</h3><span style="font-size:12px;color:#65676b">Últimos 30 días</span></div>
              <div class="table-wrap" style="max-height:300px;overflow-y:auto">
                <table><thead><tr><th>Fecha</th><th style="text-align:center">Ventas</th><th style="text-align:center">Unidades</th><th style="text-align:right">Ingresos</th></tr></thead>
                <tbody>${diasOrdenados.map(([dia,d],i)=>`
                  <tr style="background:${i%2===0?'#fff':'#fafafa'}">
                    <td style="font-weight:600">${dia}</td>
                    <td style="text-align:center;color:#65676b">${d.ventas}</td>
                    <td style="text-align:center;font-weight:700;color:#1877f2">${d.unidades}</td>
                    <td style="text-align:right;font-weight:700;color:#2e7d32">$${fmt(d.ingresos)}</td>
                  </tr>`).join('')}
                </tbody></table>
              </div>
            </div>
            <div class="table-card">
              <div class="table-card-header" style="padding:12px 16px"><h3 style="margin:0">Ventas por Mes</h3></div>
              <div class="table-wrap">
                <table><thead><tr><th>Mes</th><th style="text-align:center">Transacciones</th><th style="text-align:center">Unidades</th><th style="text-align:right">Ingresos</th></tr></thead>
                <tbody>${mesesOrdenados.map(([mes,d],i)=>`
                  <tr style="background:${i%2===0?'#fff':'#fafafa'}">
                    <td style="font-weight:600">${mes}</td>
                    <td style="text-align:center;color:#65676b">${d.ventas}</td>
                    <td style="text-align:center;font-weight:700;color:#1877f2">${d.unidades}</td>
                    <td style="text-align:right;font-weight:700;color:#2e7d32">$${fmt(d.ingresos)}</td>
                  </tr>`).join('')}
                </tbody></table>
              </div>
            </div>
          </div>`;
      }

      else if (tipo === 'unidades') {
        panel.innerHTML = `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="table-card">
              <div class="table-card-header" style="padding:12px 16px"><h3 style="margin:0">Más Vendidos por Unidades</h3></div>
              <div class="table-wrap">
                <table><thead><tr><th>Rank</th><th>Producto</th><th style="text-align:right">Unidades</th></tr></thead>
                <tbody>${topVendidos.map((p,i)=>`
                  <tr style="background:${i%2===0?'#fff':'#fafafa'}">
                    <td style="text-align:center;font-weight:700;color:${i===0?'#f57c00':i===1?'#65676b':i===2?'#c2185b':'#1c1e21'}">${i+1}</td>
                    <td style="font-size:12px">${p.nombre}</td>
                    <td style="text-align:right;font-weight:800;color:#1877f2">${p.unidades}</td>
                  </tr>`).join('')}
                </tbody></table>
              </div>
            </div>
            <div class="table-card">
              <div class="table-card-header" style="padding:12px 16px"><h3 style="margin:0">Más Ingresos ($)</h3></div>
              <div class="table-wrap">
                <table><thead><tr><th>Rank</th><th>Producto</th><th style="text-align:right">Ingresos</th></tr></thead>
                <tbody>${topIngresos.map((p,i)=>`
                  <tr style="background:${i%2===0?'#fff':'#fafafa'}">
                    <td style="text-align:center;font-weight:700;color:${i===0?'#f57c00':i===1?'#65676b':i===2?'#c2185b':'#1c1e21'}">${i+1}</td>
                    <td style="font-size:12px">${p.nombre}</td>
                    <td style="text-align:right;font-weight:800;color:#2e7d32">$${fmt(p.ingresos)}</td>
                  </tr>`).join('')}
                </tbody></table>
              </div>
            </div>
          </div>`;
      }
    }

    // Listeners en tarjetas
    tc.querySelectorAll('.rep-card').forEach(card => {
      card.addEventListener('mouseenter', () => { card.style.transform='translateY(-3px)'; card.style.boxShadow='0 6px 20px rgba(0,0,0,0.1)'; });
      card.addEventListener('mouseleave', () => { card.style.transform=''; card.style.boxShadow=''; });
      card.addEventListener('click', () => {
        tc.querySelectorAll('.rep-card').forEach(c => c.style.outline='none');
        card.style.outline='2px solid #1877f2';
        mostrarPanel(card.dataset.panel);
      });
    });

    // Mostrar ingresos por defecto
    mostrarPanel('ingresos');
    tc.querySelector('[data-panel="ingresos"]').style.outline='2px solid #1877f2';
  }


  // ── Tab Configuración ─────────────────────────────────────────────────────────
  function renderTabConfig(tc) {
    const cats   = [...new Set(allProductos.map(p => p.categoria).filter(Boolean))].sort();
    const provs  = [...new Set(allProductos.map(p => p.proveedor).filter(Boolean))].sort();
    const marcas = [...new Set(allProductos.map(p => p.marca).filter(Boolean))].sort();

    tc.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px;max-width:700px">

        <!-- Categorías -->
        <div class="table-card">
          <div class="table-card-header">
            <h3>Categorías</h3>
            <span style="color:#65676b;font-size:13px">${cats.length} categorías</span>
          </div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;gap:8px">
              <input id="cfg_nueva_cat" type="text" placeholder="Nueva categoría..." style="flex:1;padding:8px 12px;border:1px solid #e4e6eb;border-radius:8px;font-size:14px" />
              <button id="cfg_add_cat" style="padding:8px 16px;background:#1877f2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">+ Agregar</button>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;max-height:200px;overflow-y:auto">
              ${cats.map(c => `<span style="padding:4px 12px;background:#f0f2f5;border-radius:20px;font-size:12px;font-weight:600;color:#1c1e21;border:1px solid #e4e6eb">${c}</span>`).join('')}
            </div>
          </div>
        </div>

        <!-- Proveedores -->
        <div class="table-card">
          <div class="table-card-header">
            <h3>Proveedores</h3>
            <span style="color:#65676b;font-size:13px">${provs.length} proveedores</span>
          </div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;gap:8px">
              <input id="cfg_nuevo_prov" type="text" placeholder="Nuevo proveedor..." style="flex:1;padding:8px 12px;border:1px solid #e4e6eb;border-radius:8px;font-size:14px" />
              <button id="cfg_add_prov" style="padding:8px 16px;background:#2e7d32;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">+ Agregar</button>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto">
              ${provs.map(p => `<div style="padding:6px 12px;background:#f0f2f5;border-radius:8px;font-size:13px;color:#1c1e21">${p}</div>`).join('')}
            </div>
          </div>
        </div>

        <!-- Marcas -->
        <div class="table-card">
          <div class="table-card-header">
            <h3>Marcas</h3>
            <span style="color:#65676b;font-size:13px">${marcas.length} marcas</span>
          </div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;gap:8px">
              <input id="cfg_nueva_marca" type="text" placeholder="Nueva marca..." style="flex:1;padding:8px 12px;border:1px solid #e4e6eb;border-radius:8px;font-size:14px" />
              <button id="cfg_add_marca" style="padding:8px 16px;background:#7b1fa2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">+ Agregar</button>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;max-height:180px;overflow-y:auto">
              ${marcas.map(m => `<span style="padding:4px 12px;background:#f3e5f5;border-radius:20px;font-size:12px;font-weight:600;color:#7b1fa2;border:1px solid #ce93d8">${m}</span>`).join('')}
            </div>
          </div>
        </div>

        <!-- Rubros / Secciones -->
        <div class="table-card">
          <div class="table-card-header">
            <h3>Secciones del negocio</h3>
            <span style="color:#65676b;font-size:13px">${RUBROS.length} secciones</span>
          </div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <p style="font-size:13px;color:#65676b;margin:0">Para agregar secciones, usá el botón "+ Agregar sección" en la barra superior.</p>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${RUBROS.map(r => `<span style="padding:6px 16px;background:#eef4ff;border-radius:20px;font-size:13px;font-weight:700;color:#1877f2;border:2px solid #c7d9fc">${r}</span>`).join('')}
            </div>
          </div>
        </div>

        <div id="cfg_msg"></div>
      </div>
    `;

    // Agregar categoría
    document.getElementById('cfg_add_cat').addEventListener('click', () => {
      const val = document.getElementById('cfg_nueva_cat').value.trim().toUpperCase();
      if (!val) return;
      const normalized = normalizarCategoria(val);
      document.getElementById('cfg_msg').innerHTML = `<div style="padding:10px;background:#e8f5e9;border-radius:8px;color:#2e7d32;font-size:13px">Categoría "<b>${normalized}</b>" lista para usar al crear productos.</div>`;
      document.getElementById('cfg_nueva_cat').value = '';
    });

    // Agregar proveedor
    document.getElementById('cfg_add_prov').addEventListener('click', () => {
      const val = document.getElementById('cfg_nuevo_prov').value.trim();
      if (!val) return;
      document.getElementById('cfg_msg').innerHTML = `<div style="padding:10px;background:#e8f5e9;border-radius:8px;color:#2e7d32;font-size:13px">Proveedor "<b>${val}</b>" listo para usar al crear productos.</div>`;
      document.getElementById('cfg_nuevo_prov').value = '';
    });

    // Agregar marca
    document.getElementById('cfg_add_marca').addEventListener('click', () => {
      const val = document.getElementById('cfg_nueva_marca').value.trim().toUpperCase();
      if (!val) return;
      document.getElementById('cfg_msg').innerHTML = `<div style="padding:10px;background:#e8f5e9;border-radius:8px;color:#2e7d32;font-size:13px">Marca "<b>${val}</b>" lista para usar al crear productos.</div>`;
      document.getElementById('cfg_nueva_marca').value = '';
    });
  }

  // ── Init ──
  await cargarRubros();
  renderShell();
  reRenderRubroBar();
  try {
    await cargarDatos();
    renderStats();
    renderTab('catalogo');
    // Banner de alertas: velocity en background → al completar, dibuja banner
    cargarVelocidadVentas().then(() => renderBannerCriticos()).catch(() => {});
  } catch(e) {
    const tc = document.getElementById('tabContent');
    if (tc) tc.innerHTML = `<div style="padding:20px;color:var(--danger)">Error: Error cargando catálogo: ${e.message}<br><br><i>Si el catálogo está vacío, usá la pestaña "Importar CSV" para cargar los productos.</i></div>`;
    renderStats();
    renderTab('catalogo');
  }
}
