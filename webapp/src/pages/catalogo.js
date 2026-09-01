import {
  collection, getDocs, doc, setDoc, updateDoc, getDoc, getDocFromCache,
  query, orderBy, writeBatch, deleteDoc, limit, serverTimestamp,
  onSnapshot
} from 'firebase/firestore';
import { getCached, invalidateCache, invalidateCacheByPrefix, peekCacheValue } from '../cache.js';
import { ensureCollections, onStoreChange } from '../store.js';
import { initCatalogoHistory, fieldLabel } from '../catalogo_history.js';
import { registrarMovimiento, movimientosDe, MOTIVOS } from '../stock_ledger.js';
import { avisarStockALaTienda, reflejarSiPublicado } from '../tienda_espejo.js';
import { camposStockRapido, num as numConj } from '../conjunto.js';
import {
  recomputarResumenInventario, resumenEstaVencido, computarResumen,
  sugerirCantidad, valorizarStock, validarInventario,
} from '../inventario_resumen.js';
import { alertDialog, promptDialog } from '../components/dialogs.js';
import { levantarLapida, levantarLapidas } from '../lapidas.js';
import {
  TIPOS_BULTO, bultoDe, labelTipo, aUnidades, aUnidadesEstable, aBultos, textoBultos, alertaPorBulto,
} from '../bulto.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Última modificación ───────────────────────────────────────────────────────
// Cada doc de `catalogo` guarda `ultima_actualizacion` (serverTimestamp) en TODA
// edición — se sincroniza a todas las PCs vía el store realtime, así que mostrarla
// no depende del cache local ni gasta lecturas extra. Acá sólo la formateamos.
function _tsToDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v.toDate === 'function') { try { const d = v.toDate(); return isNaN(d.getTime()) ? null : d; } catch (_) { return null; } }
  if (typeof v === 'object' && typeof v.seconds === 'number') return new Date(v.seconds * 1000);
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') { const d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  // serverTimestamp() sin resolver: tras una edición optimista el campo todavía
  // es un FieldValue (no Timestamp). Ya descartamos Date/Timestamp/{seconds}/
  // número/string arriba, así que un objeto restante es ese sentinel — y para
  // "última modificación" la lectura correcta es "ahora" (recién se editó).
  if (typeof v === 'object') return new Date();
  return null;
}

function _fmtRelativo(date) {
  const diff = Date.now() - date.getTime();
  if (diff < 60000) return 'recién';
  const min = Math.floor(diff / 60000);
  if (min < 60) return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `hace ${hr} h`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'ayer';
  if (day < 30) return `hace ${day} días`;
  // El corte mes/año es por días (365), no por `mon < 12`: con dos umbrales
  // distintos los días 360-364 caían en el hueco y mostraban "hace 0 años".
  if (day < 365) { const mon = Math.floor(day / 30); return `hace ${mon} ${mon === 1 ? 'mes' : 'meses'}`; }
  const yr = Math.floor(day / 365);
  return `hace ${yr} ${yr === 1 ? 'año' : 'años'}`;
}

function _fmtAbsoluto(date) {
  return date.toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// Chip de "última modificación" para una fila del catálogo. Prioriza la fecha de
// edición; cae a la de creación. Color por antigüedad (hoy / semana / más viejo).
function modIndicatorHtml(p) {
  const base = 'display:flex;width:fit-content;align-items:center;gap:3px;margin-top:4px;font-size:10.5px;font-weight:600;line-height:1;white-space:nowrap';
  const editDate = _tsToDate(p && p.ultima_actualizacion);
  const date = editDate || _tsToDate(p && p.fecha_creacion);
  if (!date) {
    return `<div style="${base};color:var(--text-muted);opacity:.5" title="Sin registro de modificación">`
      + `<span class="material-icons" style="font-size:12px">schedule</span><span>—</span></div>`;
  }
  const days = (Date.now() - date.getTime()) / 86400000;
  const color = days < 1 ? 'var(--tint-green-fg)' : days < 7 ? 'var(--tint-blue-fg)' : 'var(--text-muted)';
  const verbo = editDate ? 'Modificado' : 'Creado';
  const icon = editDate ? 'update' : 'add_circle_outline';
  return `<div style="${base};color:${color}" title="${verbo}: ${_fmtAbsoluto(date)}">`
    + `<span class="material-icons" style="font-size:12px">${icon}</span>`
    + `<span>${_fmtRelativo(date)}</span></div>`;
}

// Pseudo-productos: items genéricos que NO son stock real (VARIOS, VARIOS 2,
// productos sin nombre, "*"). Se excluyen de la reposición para no ensuciar la
// lista de compras ni las alertas con ventas varias.
const _PSEUDO_PRODUCTO_RE = /^(\*+|sin nombre|varios(\s*\d+)?)$/i;
function esPseudoProducto(p) {
  const n = (p && p.nombre || '').trim();
  return n === '' || _PSEUDO_PRODUCTO_RE.test(n);
}

// Unidades por pack/rollo de una variedad: el contenido propio si lo tiene, si
// no el global del producto. Sin ninguno de los dos vale 1 (el pack ES la
// unidad), nunca 0: con 0 los packs enteros desaparecían del total y el
// producto figuraba sin stock teniéndolo.
function _contVariedad(c, globalCont) {
  const propio = Number(c && c.contenido) || 0;
  if (propio > 0) return propio;
  const gl = Number(globalCont) || 0;
  return gl > 0 ? gl : 1;
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

// Redondea al múltiplo de 100 más cercano. Si el valor es chico y eso daría 0,
// cae a múltiplo de 10 (24 → 20, 26 → 30) para no romper precios baratos.
function redondearCentena(v) {
  v = Number(v) || 0;
  if (v <= 0) return 0;
  const r100 = Math.round(v / 100) * 100;
  if (r100 > 0) return r100;
  const r10 = Math.round(v / 10) * 10;
  return r10 > 0 ? r10 : Math.round(v);
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

    const codigo = limpiarCodigo(cols[idx.codigo]);
    const costo = parseNum(cols[idx.costo]);
    const costoNeo = parseNum(cols[idx.costoNeo]);
    const precioVenta = costoNeo > 0 ? costoNeo : costo;
    const stock = parseNum(cols[idx.stock]);
    const key = slugify(nombre);

    const margen_original = costoNeo > 0 && costo > 0 ? Math.round(((costoNeo - costo) / costo) * 100) : 0;

    const producto = {
      codigo,
      nombre: nombre.toUpperCase(),
      cod_barra: limpiarCodigo(cols[idx.codBarra]),
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
    const idsSubidos = [];
    for (const p of chunk) {
      const id = p.codigo || slugify(p.nombre) || `prod-${i}-${count}`;
      const ref = doc(collection(db, 'catalogo'), id);
      batch.set(ref, { ...p, doc_id: id });
      idsSubidos.push(id);
    }
    await batch.commit();
    // Si alguno de estos códigos ya tuvo lápida, el POS borraría el producto
    // recién subido en cuanto lo baje.
    await levantarLapidas(db, idsSubidos);
    count += chunk.length;
    if (onProgress) onProgress(count, productos.length);
  }
  _touchCatalogoMeta(db).catch(() => {});
}

// ── Limpia códigos: quita espacios internos y caracteres invisibles ───────────
function limpiarCodigo(s) {
  return (s || '').toString().replace(/\s+/g, '').trim();
}

// ── Generador de códigos internos y de barras únicos ──────────────────────────
// Patrón:
//   - codigo (interno): AUTO-{n}
//   - cod_barra: POS{n}
// Escanea `productosExistentes` (allProductos) para encontrar el próximo n libre.
function _maxNumericoPorPrefijo(productos, campo, regex) {
  let max = 0;
  for (const p of productos) {
    const v = (p?.[campo] || '').toString().trim();
    const m = regex.exec(v);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return max;
}

// Genera un código numérico de 6 dígitos único contra TODOS los códigos del
// catálogo (tanto `codigo` como `cod_barra`). El código interno y el código
// de barras devueltos son el mismo número — así un solo escaneo o tipeo
// resuelve el producto.
function generarCodigosUnicos(productosExistentes, pendientesNuevos = []) {
  const pool = [...productosExistentes, ...pendientesNuevos];
  const usados = new Set();
  for (const p of pool) {
    const c = (p?.codigo ?? '').toString().trim();
    const b = (p?.cod_barra ?? '').toString().trim();
    if (c) usados.add(c);
    if (b) usados.add(b);
  }
  // Arrancamos en el mayor 6-dígitos ya usado + 1, o en 100000 si no hay ninguno.
  let max = 99999;
  for (const v of usados) {
    if (/^\d{6}$/.test(v)) {
      const n = parseInt(v, 10);
      if (n > max) max = n;
    }
  }
  let cand = max + 1;
  while (cand <= 999999 && usados.has(String(cand))) cand++;
  if (cand > 999999) {
    // Pool casi lleno (>900k productos) → buscar primer hueco.
    for (let i = 100000; i <= 999999; i++) {
      if (!usados.has(String(i))) { cand = i; break; }
    }
  }
  const codigo = String(cand);
  return { codigo, cod_barra: codigo };
}

// ── Parser flexible de CSV de proveedor ───────────────────────────────────────
// Soporta formatos variados:
//   - Producto, Codigo, Costo (Montenegro estándar)
//   - Tipo de producto, Marca, Modelo, Descripción, Publico, Revendedor (Sellos Sanchez)
//   - Columnas con variantes de acentos, mayúsculas, etc.
// Detecta filas de sección (todo en mayúscula sin precio) y las usa como categoría.
function _norm(s) {
  return (s || '').toString().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Parsea números tolerando símbolos ($, espacios) y ambos formatos:
//   "2,500.00" (US: coma miles, punto decimal)
//   "2.500,00" (AR/ES: punto miles, coma decimal)
//   "2500", "2500.00", "2,50"
function parseMoneyFlexible(s) {
  if (!s) return 0;
  let c = String(s).replace(/[\$€£¥]/g, '').replace(/\s+/g, '').trim();
  if (!c || c === '*' || c === '-') return 0;
  const hasComma = c.includes(',');
  const hasDot = c.includes('.');
  if (hasComma && hasDot) {
    if (c.lastIndexOf(',') > c.lastIndexOf('.')) {
      c = c.replace(/\./g, '').replace(',', '.');
    } else {
      c = c.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = c.split(',');
    if (parts.length === 2 && parts[1].length === 3) {
      c = c.replace(/,/g, '');
    } else {
      c = c.replace(',', '.');
    }
  }
  const n = parseFloat(c);
  return isNaN(n) ? 0 : n;
}

function parseProveedorFlexible(text) {
  const lines = text.split(/\r?\n/);
  let headerIdx = -1;
  let headers = [];

  // Buscar la primer fila que tenga al menos una columna identificable como nombre
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const cand = parseCSVLine(lines[i]);
    if (!cand.length) continue;
    const normed = cand.map(_norm);
    const hasName = normed.some(h =>
      ['PRODUCTO', 'NOMBRE', 'DESCRIPCION', 'ARTICULO', 'ITEM'].includes(h)
    );
    if (hasName) {
      headerIdx = i;
      headers = cand;
      break;
    }
  }
  if (headerIdx < 0) return [];

  const normed = headers.map(_norm);
  const findCol = (opts) => normed.findIndex(h => opts.includes(h));
  const findColContains = (opts) => normed.findIndex(h => opts.some(o => h.includes(o)));

  const idxNombre    = findCol(['PRODUCTO', 'NOMBRE', 'DESCRIPCION', 'ARTICULO', 'ITEM']);
  const idxDescExtra = findColContains(['DESCRIPCION', 'DETALLE']);
  const idxTipo      = findColContains(['TIPO DE PRODUCTO', 'TIPO', 'RUBRO', 'CATEGORIA']);
  const idxModelo    = findCol(['MODELO', 'CODIGO', 'COD', 'COD PRODUCTO', 'COD. PRODUCTO']);
  const idxBarra     = findCol(['COD BARRA', 'CODBARRA', 'COD_BARRA', 'CODIGO DE BARRAS', 'EAN']);
  const idxMarca     = findCol(['MARCA']);
  const idxSubRubro  = findCol(['SUB RUBRO', 'SUB_RUBRO', 'SUBRUBRO', 'CATEGORIA']);
  const idxCosto     = findCol(['COSTO', 'PRECIO', 'PRECIO COSTO', 'REVENDEDOR', 'REVENTA', 'MAYORISTA']);
  const idxVenta     = findCol(['PUBLICO', 'PRECIO PUBLICO', 'VENTA', 'PRECIO VENTA', 'PRECIO FINAL']);

  const result = [];
  const seen = new Map();
  let currentSection = '';

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const cols = parseCSVLine(raw);

    const nombreBase = idxNombre >= 0 ? (cols[idxNombre] || '').trim() : '';
    const descExtra  = idxDescExtra >= 0 && idxDescExtra !== idxNombre ? (cols[idxDescExtra] || '').trim() : '';
    const modelo     = idxModelo >= 0 ? (cols[idxModelo] || '').trim() : '';

    const costo = idxCosto >= 0 ? parseMoneyFlexible(cols[idxCosto]) : 0;
    const venta = idxVenta >= 0 ? parseMoneyFlexible(cols[idxVenta]) : 0;

    // Fila de sección: un solo campo con valor, sin precios → actualizar sección
    const nonEmptyCount = cols.filter(c => (c || '').trim()).length;
    if (nonEmptyCount === 1 && costo === 0 && venta === 0) {
      const sec = cols.find(c => (c || '').trim()) || '';
      if (sec && !/\d/.test(sec)) {
        currentSection = sec.trim().toUpperCase();
        continue;
      }
    }

    // Sin nombre ni descripción → skip
    if (!nombreBase && !descExtra && !modelo) continue;

    // Sin precios → skip (probablemente header secundario o nota)
    if (costo === 0 && venta === 0) continue;

    // Armar nombre: prioridad descripción > nombre base, anteponiendo tipo y modelo si existen
    const tipo = idxTipo >= 0 ? (cols[idxTipo] || '').trim() : '';
    let nombreFinal;
    if (descExtra && nombreBase) {
      nombreFinal = `${nombreBase} ${descExtra}`.trim();
    } else {
      nombreFinal = descExtra || nombreBase;
    }
    if (modelo && !nombreFinal.toUpperCase().includes(modelo.toUpperCase())) {
      nombreFinal = `${nombreFinal} ${modelo}`.trim();
    }
    if (tipo && !nombreFinal.toUpperCase().includes(tipo.toUpperCase())) {
      nombreFinal = `${tipo} ${nombreFinal}`.trim();
    }
    nombreFinal = nombreFinal.toUpperCase().replace(/\s+/g, ' ').trim();
    if (!nombreFinal || nombreFinal === '*') continue;

    const key = slugify(nombreFinal);
    if (seen.has(key)) continue;
    seen.set(key, result.length);

    const costoFinal = costo > 0 ? costo : venta;
    const precioVenta = venta > 0 ? venta : costo;

    result.push({
      codigo:       limpiarCodigo(modelo),
      nombre:       nombreFinal,
      cod_barra:    idxBarra >= 0 ? limpiarCodigo(cols[idxBarra]) : '',
      rubro:        currentSection || (tipo.toUpperCase()) || '',
      categoria:    normalizarCategoria(
                      (idxSubRubro >= 0 ? cols[idxSubRubro] : '') || currentSection || tipo
                    ),
      proveedor:    'SIN PROVEEDOR',
      marca:        idxMarca >= 0 ? (cols[idxMarca] || 'SIN MARCA').toUpperCase().trim() : 'SIN MARCA',
      moneda:       'PESOS',
      costo:        costoFinal,
      precio_venta: precioVenta,
      stock:        0,
      estado:       costoFinal === 0 ? 'sin_precio' : 'activo',
      duplicado:    false,
      margen_original: costoFinal > 0 && precioVenta > 0
        ? Math.round(((precioVenta - costoFinal) / costoFinal) * 100)
        : 0,
      ultima_actualizacion: serverTimestamp(),
      historial_precios: [],
    });
  }

  return result;
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
      codigo:    idxCod >= 0 ? limpiarCodigo(cols[idxCod]) : '',
      nombre:    nombre.toUpperCase(),
      cod_barra: idxBarra >= 0 ? limpiarCodigo(cols[idxBarra]) : '',
      costo:     idxCosto >= 0 ? parseNum(cols[idxCosto]) : 0,
      categoria: normalizarCategoria(cols[idxSubRubro >= 0 ? idxSubRubro : -1] || ''),
    });
  }
  return result;
}

// ── Render principal ──────────────────────────────────────────────────────────
// Ventana donde el listener de catalogo_meta debe ignorar cambios (causados por
// esta misma pestaña). Evita que un edit/borrado local dispare un re-render del
// tab que pisaría el filtro de búsqueda y la página actual.
let _localMetaTouchUntil = 0;

// Suscripción realtime al resumen de inventario (inv:resumen). Module-level para
// poder desuscribir la instancia previa cuando renderCatalogo se vuelve a montar
// (evita listeners apilados que referencian closures viejos).
let _invStoreUnsub = null;
// Evita repetir el chequeo de consistencia en cada refresco realtime: se corre
// una sola vez por montaje de la página (se resetea en renderCatalogo).
let _invValidado = false;

/**
 * Escribe un timestamp en config/catalogo_meta para que el POS sepa
 * que el catálogo cambió y deba re-sincronizar en el próximo arranque.
 * Fire-and-forget: no bloquea la UI si Firebase está lento.
 */
async function _touchCatalogoMeta(db) {
  _localMetaTouchUntil = Date.now() + 8000;
  // Flag global para que main.js / onStoreChange ignore el re-render automático
  // disparado por nuestro propio updateDoc — preserva búsqueda/scroll/página.
  try { window.__catalogoLocalEditUntil = Date.now() + 8000; } catch(_) {}
  try {
    await setDoc(doc(db, 'config', 'catalogo_meta'), {
      last_updated: serverTimestamp(),
    }, { merge: true });
  } catch(e) { /* silently ignore */ }
}

/**
 * Modal de confirmación estilizado. Reemplaza al confirm() nativo del navegador.
 * Devuelve Promise<boolean>: true = aceptar, false = cancelar/Esc/click afuera.
 */
function _escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

function confirmModal({ title = 'Confirmar', message = '', confirmText = 'Aceptar', cancelText = 'Cancelar', danger = false } = {}) {
  return new Promise(resolve => {
    document.querySelector('.confirm-modal-overlay')?.remove();
    const accent = danger ? '#dc2626' : '#7c3aed';
    const icon   = danger ? 'warning'  : 'help_outline';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:440px">
        <div class="modal-header" style="border-bottom:none;padding-bottom:8px">
          <h3 style="display:flex;align-items:center;gap:10px;margin:0">
            <span class="material-icons" style="color:${accent};font-size:26px">${icon}</span>
            ${_escHtml(title)}
          </h3>
        </div>
        <div class="modal-body" style="padding:4px 24px 20px;font-size:14px;color:var(--text);line-height:1.5">
          ${message}
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--border);background:var(--surface-2)">
          <button class="cm-cancel" style="padding:9px 18px;border-radius:8px;border:1px solid var(--border);background:var(--surface);cursor:pointer;font-size:13px;font-weight:600;color:var(--text-muted)">${_escHtml(cancelText)}</button>
          <button class="cm-ok" style="padding:9px 18px;border-radius:8px;border:none;background:${accent};color:#fff;cursor:pointer;font-size:13px;font-weight:700">${_escHtml(confirmText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const cleanup = (val) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      else if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
    };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.cm-ok').addEventListener('click', () => cleanup(true));
    overlay.querySelector('.cm-cancel').addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(false); });
    setTimeout(() => overlay.querySelector('.cm-ok')?.focus(), 30);
  });
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


// ── JsBarcode lazy load + generador de etiqueta PNG ──────────────────────────
let _jsBarcodePromise = null;
function _ensureJsBarcode() {
  if (window.JsBarcode) return Promise.resolve();
  if (_jsBarcodePromise) return _jsBarcodePromise;
  _jsBarcodePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${import.meta.env.BASE_URL}vendor/jsbarcode.all.min.js`;
    s.onload  = () => resolve();
    s.onerror = () => { _jsBarcodePromise = null; reject(new Error('No se pudo cargar JsBarcode (revisá conexión)')); };
    document.head.appendChild(s);
  });
  return _jsBarcodePromise;
}

async function _descargarEtiqueta(codigo, nombre) {
  const tmp = document.createElement('canvas');
  window.JsBarcode(tmp, String(codigo), {
    format: 'CODE128', width: 2, height: 60, fontSize: 16, margin: 6, displayValue: true,
  });
  const final = document.createElement('canvas');
  const ctx = final.getContext('2d');
  const nombreCorto = (nombre || '').slice(0, 38);
  final.width  = Math.max(tmp.width + 16, 280);
  final.height = tmp.height + 36;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, final.width, final.height);
  ctx.fillStyle = '#000';
  ctx.font = 'bold 13px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(nombreCorto, final.width/2, 20);
  ctx.drawImage(tmp, (final.width - tmp.width)/2, 28);
  const safe = `${codigo}_${(nombre||'').replace(/[^A-Za-z0-9]+/g, '_').slice(0,40)}`;
  const link = document.createElement('a');
  link.download = `${safe}.png`;
  link.href = final.toDataURL('image/png');
  link.click();
}

export async function renderCatalogo(container, db) {
  // Shell vacío al toque: UI real con labels, íconos y filtros visibles.
  const _statShell = (bgClass, icon, label, bgStyle) => `
    <div class="card stat-card">
      <div class="icon-wrap ${bgClass || ''}" ${bgStyle ? `style="${bgStyle}"` : ''}>
        <span class="material-icons">${icon}</span>
      </div>
      <div class="label">${label}</div>
      <div class="value" style="color:var(--text-muted)">—</div>
    </div>`;
  container.innerHTML = `
    <div class="cards-grid" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr));margin-bottom:18px">
      ${_statShell('bg-blue',   'menu_book',             'Total')}
      ${_statShell('bg-green',  'check_circle',          'Con Stock')}
      ${_statShell('',          'sell',                  'Sin Precio',  'background:#f59e0b')}
      ${_statShell('bg-orange', 'content_copy',          'Duplicados')}
      ${_statShell('bg-red',    'remove_shopping_cart',  'Agotados')}
      ${_statShell('',          'pending',               'Decimales',   'background:#7c3aed')}
    </div>
    <div class="filter-bar" style="flex-wrap:wrap;gap:8px">
      <input type="text" placeholder="Buscar por nombre, código o barra..." style="flex:1;min-width:200px;max-width:400px" disabled />
      <select disabled><option>Todas las categorías</option></select>
      <select disabled><option>Todos los proveedores</option></select>
      <select disabled><option>Todas las marcas</option></select>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-top:18px">
      ${Array(10).fill('<div class="skel skel-card" style="height:190px"></div>').join('')}
    </div>
  `;

  // Estado local
  let allProductos = [];
  let filtrados = [];
  let currentPage = 1;
  const PER_PAGE = 50;

  // ── Selección múltiple (borrado en lote) ──
  // selMode: modo activo (muestra checkboxes). selMap: doc_id -> producto
  // completo. Guardar el producto entero permite armar la preview y el
  // historial (undo) aunque el item ya no esté en la página/filtro visible.
  let selMode = false;
  const selMap = new Map();
  let _selBorrando = false;

  // ── Filtro alfabético (temporal — eliminar bloque "ABC FILTER" cuando ya no se use) ──
  const ABC_FILTER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  let letraActiva = '';
  function primeraLetraNombre(nombre) {
    const n = (nombre || '').trim();
    if (!n) return '';
    const c = n.normalize('NFD').replace(/[̀-ͯ]/g, '')[0];
    return (c || '').toUpperCase();
  }

  // Inventario: velocidad de venta (lazy-load cuando se abre la pestaña o el banner)
  let ventasProd = null;      // { 'NOMBRE': { u30, u7 } }
  let ventasPorDia = null;    // { 'dd/mm/yyyy': total_unidades } últimos 14d para el sparkline
  let invEstadoFiltro = '';   // filtro de estado activo en tab Inventario
  let invMovFiltro = '';
  let invNombreFiltro = '';
  let invCatFiltro = '';
  let invListaActual = [];    // productos con estado (refresco progresivo)
  let invFiltradoActual = []; // último resultado filtrado de la tabla (para exportar/imprimir)
  const invReposSel = new Set();   // doc_ids SELECCIONADOS para el pedido (por defecto: ninguno)
  const invReposExtra = new Set(); // doc_ids agregados a mano vía buscador (aparecen aunque no tengan señal)
  const invReposQty = new Map();   // doc_id → cantidad elegida a pedir (default: sugerida)
  let invReposFocus = null;        // doc_id del producto enfocado en el panel de análisis
  let invTablaVisible = false; // tabla detallada colapsada por defecto en el dashboard
  // Días de cobertura objetivo para la sugerencia de compra (cuántos días de
  // venta querés tener en stock). Editable desde la lista de compras.
  let invCoberturaDias = 30;
  // Secciones colapsables del inventario (valorización, sobrestock): guarda los
  // ids cerrados para recordar el estado entre re-renders del tab.
  // Todas las secciones de análisis arrancan cerradas → vista limpia; el usuario
  // expande lo que quiere ver.
  const invSeccionesCerradas = new Set(['invValorizacion', 'invSparkline', 'invTopMovers', 'invVariantesAgotadas', 'invSobrestock', 'invABC', 'invMargen', 'invSalud']);

  // Refresco realtime del inventario: cuando el resumen pinneado cambia (lo
  // regeneramos nosotros o llega desde otra PC / el POS vende), actualizamos la
  // velocidad en memoria y, si la pestaña Inventario está activa, la redibujamos.
  // Desuscribimos cualquier instancia previa para no apilar listeners al re-montar.
  _invValidado = false;
  if (_invStoreUnsub) { try { _invStoreUnsub(); } catch (_) {} _invStoreUnsub = null; }
  _invStoreUnsub = onStoreChange((col) => {
    if (col !== 'inventario_resumen' && col !== 'catalogo') return;
    if (!document.body.contains(container)) {
      try { _invStoreUnsub && _invStoreUnsub(); } catch (_) {}
      _invStoreUnsub = null;
      return;
    }
    // Refresco realtime EN EL LUGAR (sin recargar la página) para no perder la
    // pestaña activa ni el pedido de reposición en curso. main.js no hace
    // loadPage cuando estamos en catálogo justamente por esto.
    const activeTab = document.querySelector('.tab-btn.active')?.dataset?.tab;
    // En pestañas editables (nuevo/importar/config/etc.) no tocamos nada.
    if (activeTab && activeTab !== 'catalogo' && activeTab !== 'inventario') return;

    if (col === 'inventario_resumen') {
      const r = peekCacheValue('inv:resumen');
      if (r && r.por_producto) { ventasProd = r.por_producto; ventasPorDia = r.por_dia || {}; }
    } else if (col === 'catalogo') {
      // Releer el catálogo desde el store (pinneado) sin re-fetch.
      const fresh = peekCacheValue('catalogo:all');
      if (Array.isArray(fresh)) {
        allProductos = fresh.map(p => (typeof p.doc_id === 'string') ? p : { ...p, doc_id: String(p.doc_id) });
      }
    }

    if (activeTab === 'inventario') {
      const tc = document.getElementById('tabContent');
      if (tc) { try { renderTabInventario(tc); } catch (_) {} }
    } else if (activeTab === 'catalogo' && col === 'catalogo') {
      try { aplicarFiltros(); } catch (_) {}
      try { renderStats(); } catch (_) {}
    }
    try { renderBannerCriticos(); } catch (_) {}
  });

  // ── Historial de cambios (undo/redo local, sin costo Firestore) ──
  // Referencia al modal "Editar producto" abierto, para recargarlo tras un undo.
  let _editorActivo = null;
  const _prodKey = p => p.doc_id || p.id;
  const hist = initCatalogoHistory({
    db,
    getProducto: (docId) => allProductos.find(p => _prodKey(p) === docId),
    applyToMemory: (docId, op) => {
      if (op.remove) {
        allProductos = allProductos.filter(p => _prodKey(p) !== docId);
        filtrados    = filtrados.filter(p => _prodKey(p) !== docId);
      } else if (op.recreate) {
        if (!allProductos.some(p => _prodKey(p) === docId)) allProductos.unshift(op.recreate);
      } else if (op.fields) {
        const i = allProductos.findIndex(p => _prodKey(p) === docId);
        if (i !== -1) allProductos[i] = { ...allProductos[i], ...op.fields };
        const j = filtrados.findIndex(p => _prodKey(p) === docId);
        if (j !== -1) filtrados[j] = { ...filtrados[j], ...op.fields };
      }
    },
    refreshUI: (affectedDocIds) => {
      try { renderStats(); } catch (_) {}
      // Re-renderizar la vista activa: la tabla del catálogo se reconstruye con
      // aplicarFiltros (preserva búsqueda/filtros del DOM); la pestaña Inventario
      // tiene su propio render y hay que redibujarla aparte o el valor queda stale.
      const activeTab = document.querySelector('.tab-btn.active')?.dataset?.tab;
      if (activeTab === 'inventario') {
        const tc = document.getElementById('tabContent');
        if (tc) { try { renderTabInventario(tc); } catch (_) {} }
      } else {
        try { aplicarFiltros(); } catch (_) {}
      }
      // Si el modal "Editar producto" está abierto y el undo/redo tocó ese
      // producto, recargarlo con los valores ya revertidos (sus inputs se
      // poblaron una sola vez al abrir y quedarían stale).
      if (_editorActivo && Array.isArray(affectedDocIds) && affectedDocIds.includes(_editorActivo.docId)) {
        try { _editorActivo.reabrir(); } catch (_) {}
      }
      _actualizarBadgeHistorial();
    },
    registerDeleted: _registerCatalogoDeleted,
    touchMeta: _touchCatalogoMeta,
    isActive: () => document.body.contains(container),
    onHistoryChange: () => _actualizarBadgeHistorial(),
  });

  function _actualizarBadgeHistorial() {
    const txt = document.getElementById('btnHistorialTxt');
    if (txt) { const n = hist.pendingCount(); txt.textContent = n ? `Historial (${n})` : 'Historial'; }
  }

  // Rubros disponibles — persistidos en Firebase config
  // Los nuevos rubros se cargan dinámicamente desde config/rubros en Firebase
  const RUBROS_DEFAULT = [
    'LIBRERÍA','MERCERÍA','JUGUETERÍA','ARTÍSTICA','COTILLÓN','INFORMÁTICA','TELGOPOR',
    'ACCESORIOS','LENCERIA','NAVIDAD','PAPELERA','PERFUMERIA','REGALERIA','SELLOS','SERVICIOS',
  ];
  const RUBROS = [...RUBROS_DEFAULT];

  async function cargarRubros() {
    // Cache-first, igual que los docs de control_config: un getDoc al server
    // queda encolado detrás de los listeners grandes (se midió 102s para este
    // documento en un arranque en frío). El de IndexedDB responde en ~50ms y
    // la revalidación va por detrás.
    const ref = doc(db, 'config', 'rubros');
    const aplicar = (snap) => {
      if (snap.exists() && snap.data().lista) {
        RUBROS.length = 0;
        snap.data().lista.forEach(r => RUBROS.push(r));
        return true;
      }
      return false;
    };
    try {
      try {
        aplicar(await getDocFromCache(ref));
        getDoc(ref)
          .then(fresh => {
            if (aplicar(fresh) && document.body.contains(container)) reRenderRubroBar();
          })
          .catch(() => {});
      } catch (_) {
        aplicar(await getDoc(ref));
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
  async function cargarDatos({ silent = false } = {}) {
    if (!silent) mostrarLoader('Conectando con la base de datos...');
    const raw = await getCached('catalogo:all', async () => {
      const snap = await getDocs(query(collection(db, 'catalogo'), orderBy('nombre')));
      if (!silent) actualizarLoader(`Procesando ${snap.docs.length} productos...`);
      return snap.docs.map(d => ({ ...d.data(), doc_id: d.id }));
    }, { ttl: 10 * 60 * 1000, memOnly: true });
    // Documentos viejos guardaron un campo `doc_id` numérico que pisa el id de
    // Firestore. Normalizamos a string para que `p.doc_id === btn.dataset.id`
    // (que siempre es string) matchee.
    allProductos = raw.map(p => (typeof p.doc_id === 'string') ? p : { ...p, doc_id: String(p.doc_id) });
    filtrados = [...allProductos];
  }

  function mostrarLoader(msg) {
    const tc = document.getElementById('tabContent');
    if (!tc) return;
    tc.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;gap:20px">
        <div style="width:48px;height:48px;border:4px solid var(--border);border-top-color:var(--tint-blue-fg);border-radius:50%;animation:spin 0.8s linear infinite"></div>
        <div id="loaderMsg" style="font-size:14px;color:var(--text-muted);font-weight:500">${msg}</div>
        <div style="width:240px;background:var(--border);border-radius:99px;height:6px;overflow:hidden">
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
        <div id="rubroBar" class="rubro-bar-wrap" style="display:flex;gap:8px;flex-wrap:nowrap;align-items:center;padding:12px 16px;background:var(--surface);border-radius:12px;border:1px solid var(--border);box-shadow:0 2px 8px rgba(0,0,0,0.05);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none">
          <span style="font-size:12px;font-weight:700;color:var(--text-muted);margin-right:4px;flex-shrink:0">SECCIÓN:</span>
          <button id="btnAgregarRubro" style="display:none"></button>
          <button id="btnEditarRubros" style="padding:6px 14px;border-radius:20px;border:2px solid var(--border);background:none;color:var(--text-muted);cursor:pointer;font-size:12px;font-weight:600;transition:all 0.2s;flex-shrink:0">Editar</button>
          <span id="rubroCount" style="margin-left:auto;font-size:12px;color:var(--text-muted)"></span>
          <button id="btnHistorial" title="Historial de cambios — deshacer / rehacer (Ctrl+Z / Ctrl+Y)" style="margin-left:8px;padding:6px 14px;border-radius:20px;border:2px solid var(--border);background:none;color:var(--text-muted);cursor:pointer;font-size:12px;font-weight:600;transition:all 0.2s;flex-shrink:0;display:inline-flex;align-items:center;gap:5px">
            <span class="material-icons" style="font-size:15px">history</span><span id="btnHistorialTxt">Historial</span>
          </button>
        </div>

        <!-- BANNER CRÍTICOS (visible en todas las pestañas) -->
        <div id="invBanner"></div>

        <!-- STATS -->
        <div class="cards-grid cat-stats" id="statsGrid"></div>

        <!-- TABS NAVEGACIÓN -->
        <div style="display:flex;gap:0;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;background:var(--surface);border-radius:10px;border:1px solid var(--border);padding:3px;">
          <button class="tab-btn nav-pill active" data-tab="catalogo" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:#1877f2;color:#fff;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">inventory_2</span>Catálogo
          </button>
          <button class="tab-btn nav-pill" data-tab="inventario" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:var(--text-muted);cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">insights</span>Inventario
          </button>
          <button class="tab-btn nav-pill" data-tab="importar" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:var(--text-muted);cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">upload_file</span>Importar
          </button>
          <button class="tab-btn nav-pill" data-tab="proveedor" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:var(--text-muted);cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">compare_arrows</span>Proveedor
          </button>
          <button class="tab-btn nav-pill" data-tab="nuevo" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:var(--text-muted);cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">add_circle</span>Nuevo
          </button>
          <button class="tab-btn nav-pill" data-tab="margenes" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:var(--text-muted);cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">percent</span>Márgenes
          </button>
          <button class="tab-btn nav-pill" data-tab="etiquetas" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:var(--text-muted);cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
            <span class="material-icons" style="font-size:16px">qr_code_2</span>Etiquetas
          </button>
          <button class="tab-btn nav-pill" data-tab="config" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:none;color:var(--text-muted);cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;white-space:nowrap;transition:all 0.2s;flex-shrink:0">
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
          b.style.color = 'var(--text-muted)';
          const icon = b.querySelector('.material-icons');
          if (icon) icon.style.color = 'var(--text-muted)';
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
          b.style.background = 'var(--surface)';
          b.style.color = 'var(--text)';
          b.style.borderColor = 'var(--border)';
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
      panel.style.cssText = 'background:var(--surface);border-radius:16px;padding:24px;max-width:420px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,0.18)';

      const renderRubrosModal = () => {
        panel.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
            <h3 style="margin:0;font-size:16px">Gestionar secciones</h3>
            <button id="cerrarEdRubros" style="background:none;border:none;cursor:pointer;color:var(--text-muted)"><span class="material-icons">close</span></button>
          </div>
          <p style="font-size:13px;color:var(--text-muted);margin:0 0 14px">Tocá la X para eliminar una sección.</p>
          <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
            ${RUBROS.map(r => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bg);border-radius:8px">
                <span style="font-weight:600;font-size:14px">${r.charAt(0)+r.slice(1).toLowerCase()}</span>
                <button class="btn-del-rubro" data-rubro="${r}" style="background:none;border:none;cursor:pointer;color:var(--tint-red-fg);padding:4px;display:flex;align-items:center" title="Eliminar">
                  <span class="material-icons" style="font-size:18px">close</span>
                </button>
              </div>`).join('')}
          </div>
          <div style="display:flex;gap:8px">
            <input id="nuevoRubroInput" type="text" placeholder="Nueva sección..." style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px" />
            <button id="btnAddRubroModal" style="padding:8px 16px;background:#1877f2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">Agregar</button>
          </div>
        `;

        panel.querySelector('#cerrarEdRubros').addEventListener('click', () => overlay.remove());

        panel.querySelectorAll('.btn-del-rubro').forEach(btn => {
          btn.addEventListener('click', async () => {
            const rubro = btn.dataset.rubro;
            if (!await confirmModal({ title: 'Eliminar sección', message: `¿Eliminar la sección <b>"${_escHtml(rubro)}"</b>?`, confirmText: 'Eliminar', danger: true })) return;
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
          if (RUBROS.includes(val)) { alertDialog({ title: 'Sección duplicada', message: 'Esa sección ya existe.', type: 'warning' }); return; }
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
    document.getElementById('btnAgregarRubro')?.addEventListener('click', async () => {
      const nombre = await promptDialog({ title: 'Nueva sección', message: 'Nombre de la nueva sección (ej: BAZAR):', placeholder: 'BAZAR', confirmText: 'Crear' });
      if (!nombre) return;
      const nombreUp = nombre.toUpperCase().trim();
      if (RUBROS.includes(nombreUp)) { alertDialog({ title: 'Sección duplicada', message: 'Esa sección ya existe.', type: 'warning' }); return; }
      RUBROS.push(nombreUp);
      const bar = document.getElementById('rubroBar');
      const addBtn = document.getElementById('btnAgregarRubro');
      const newBtn = document.createElement('button');
      newBtn.className = 'rubro-btn';
      newBtn.dataset.rubro = nombreUp;
      newBtn.textContent = '' + nombreUp.charAt(0) + nombreUp.slice(1).toLowerCase();
      newBtn.style.cssText = 'padding:6px 16px;border-radius:20px;border:2px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;font-size:13px;font-weight:600;transition:all 0.2s';
      newBtn.addEventListener('click', () => {
        rubroActivo = nombreUp;
        document.querySelectorAll('.rubro-btn').forEach(b => { b.style.background='var(--surface)'; b.style.color='var(--text)'; b.style.borderColor='var(--border)'; });
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
    todosBtn.style.cssText = `padding:6px 16px;border-radius:20px;border:2px solid ${rubroActivo==='TODOS'?'#1877f2':'var(--border)'};background:${rubroActivo==='TODOS'?'#1877f2':'var(--surface)'};color:${rubroActivo==='TODOS'?'#fff':'var(--text)'};cursor:pointer;font-size:13px;font-weight:700;transition:all 0.2s;flex-shrink:0`;
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
      btn.style.cssText = `padding:6px 16px;border-radius:20px;border:2px solid ${rubroActivo===r?'#1877f2':'var(--border)'};background:${rubroActivo===r?'#1877f2':'var(--surface)'};color:${rubroActivo===r?'#fff':'var(--text)'};cursor:pointer;font-size:13px;font-weight:600;transition:all 0.2s;flex-shrink:0`;
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
      b.style.background = 'none'; b.style.color = 'var(--text-muted)';
      const icon = b.querySelector('.material-icons'); if (icon) icon.style.color = 'var(--text-muted)';
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
    const conStock   = base.filter(p => p.estado === 'activo' && !p.duplicado && _stockDisplay(p) > 0).length;
    const sinPrecio  = base.filter(p => p.estado === 'sin_precio').length;
    const duplicados = base.filter(p => p.duplicado).length;
    const agotados   = base.filter(p => _stockDisplay(p) === 0 && p.estado === 'activo' && !p.duplicado).length;
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
    if (!tc) return; // DOM en transición (ej: el usuario navegó a otra página antes de que un refresh asíncrono terminara)
    // Salir de selección múltiple al cambiar de pestaña (la barra flotante y los
    // checkboxes solo tienen sentido en el catálogo).
    if (tab !== 'catalogo' && selMode) toggleSelMode(false);
    if (tab === 'catalogo') renderTabCatalogo(tc);
    else if (tab === 'inventario') renderTabInventario(tc);
    else if (tab === 'importar') renderTabImportar(tc);
    else if (tab === 'proveedor') renderTabProveedor(tc);
    else if (tab === 'nuevo') renderTabNuevo(tc);
    else if (tab === 'margenes') renderTabMargenes(tc);
    else if (tab === 'reportes') renderTabReportes(tc);
    else if (tab === 'etiquetas') renderTabEtiquetas(tc);
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
      <div class="cat-toolbar">
        <div class="filter-bar" style="flex-wrap:wrap;gap:8px">
          <div style="position:relative;flex:2;min-width:280px;display:flex;align-items:center">
            <span class="material-icons" style="position:absolute;left:12px;font-size:24px;color:var(--text-muted);pointer-events:none">search</span>
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

        <!-- ABC FILTER (temporal) -->
        <div id="abcBar">
          <span class="abc-lbl">Inicial</span>
          <button data-letra="" class="abc-btn abc-btn--todas on">Todas</button>
          ${ABC_FILTER.map(l => {
            const n = base.filter(p => primeraLetraNombre(p.nombre) === l).length;
            const dis = (n === 0 && letraActiva !== l);
            return `<button data-letra="${l}" class="abc-btn" ${dis?'disabled':''}>${l}<span class="abc-n">${n}</span></button>`;
          }).join('')}
        </div>
        <!-- /ABC FILTER -->
      </div>

      <div class="table-card">
        <div class="table-card-header">
          <h3>Catálogo${rubroActivo !== 'TODOS' ? ' — ' + rubroActivo.charAt(0) + rubroActivo.slice(1).toLowerCase() : ''}</h3>
          <div style="display:flex;align-items:center;gap:12px">
            <span id="catCount" style="color:var(--text-muted);font-size:13px"></span>
            <button id="btnSelMode" title="Seleccionar varios productos para borrarlos juntos" style="padding:7px 13px;border-radius:8px;border:1px solid var(--danger);background:var(--tint-red-bg);cursor:pointer;color:var(--danger);display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:700">
              <span class="material-icons" style="font-size:18px">checklist</span><span class="sel-lbl">Seleccionar</span>
            </button>
            <button id="btnRefrescarCat" title="Refrescar catálogo sin perder la búsqueda" style="padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);cursor:pointer;color:var(--text-muted);display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600">
              <span class="material-icons" style="font-size:18px">refresh</span>
            </button>
            <button id="btnRedondearTodos" style="display:none;padding:8px 16px;border-radius:8px;border:none;background:#7c3aed;color:#fff;cursor:pointer;font-size:13px;font-weight:700;align-items:center;gap:6px">
              <span class="material-icons" style="font-size:16px">auto_fix_high</span>Redondear todos
            </button>
          </div>
        </div>
        <div class="table-wrap">
          <table id="catTable">
            <thead><tr>
              <th class="cat-sel-col"><input type="checkbox" id="selAllPage" title="Seleccionar todos los de esta página" /></th>
              <th class="cat-col-codigo">Código</th>
              <th class="cat-col-producto">Producto</th>
              <th>Categoría</th>
              <th class="cat-col-marca">Marca</th>
              <th class="cat-col-proveedor">Proveedor</th>
              <th>Costo</th>
              <th>Precio Venta</th>
              <th>Precio Und</th>
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

    // Debounce sólo para #buscar: evita rerender de la grilla con 12k+ productos
    // en cada keystroke (causaba que se "comieran" letras al tipear rápido).
    let _buscarDebounce = null;
    document.getElementById('buscar')?.addEventListener('input', () => {
      if (_buscarDebounce) clearTimeout(_buscarDebounce);
      _buscarDebounce = setTimeout(() => { currentPage = 1; aplicarFiltros(); }, 120);
    });
    ['filtroCat','filtroProv','filtroMarca','filtroEstado'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => { currentPage = 1; aplicarFiltros(); });
    });
    document.getElementById('btnLimpiar')?.addEventListener('click', () => {
      ['buscar','filtroCat','filtroProv','filtroMarca','filtroEstado'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      letraActiva = '';
      _pintarABC();
      currentPage = 1;
      aplicarFiltros();
    });

    // Refrescar catálogo en caliente: la store global (store.js) mantiene
    // `catalogo:all` actualizado vía listener realtime. Acá solo releemos el
    // valor pinned de memoria, refrescamos `allProductos` y re-pintamos la
    // tabla. NO se invalida cache ni se reconstruye el tab → la búsqueda y
    // los filtros (que viven en inputs del DOM) quedan intactos.
    document.getElementById('btnRefrescarCat')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const icon = btn.querySelector('.material-icons');
      if (icon) icon.style.animation = 'spin 0.6s linear infinite';
      btn.disabled = true;
      try {
        const fresh = peekCacheValue('catalogo:all');
        if (Array.isArray(fresh) && fresh.length) {
          // Reemplazar en sitio sin re-construir los selects (eso resetearía
          // el valor elegido por el usuario). Si hay categorías nuevas se
          // verán al cambiar de pestaña o al apretar Limpiar.
          allProductos = fresh;
          aplicarFiltros();
        }
      } catch (err) {
        console.error('Refresco manual de catálogo falló:', err);
      } finally {
        // Pequeño delay para que el spin sea perceptible aunque el refresh
        // sea instantáneo (sino el usuario no ve que pasó algo).
        setTimeout(() => {
          if (icon) icon.style.animation = '';
          btn.disabled = false;
        }, 250);
      }
    });

    // ABC FILTER (temporal)
    document.getElementById('abcBar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.abc-btn');
      if (!btn || btn.disabled) return;
      const l = btn.dataset.letra || '';
      letraActiva = (l && letraActiva === l) ? '' : l;
      _pintarABC();
      currentPage = 1;
      aplicarFiltros();
    });
    _pintarABC();

    // ── Selección múltiple ──
    document.getElementById('btnSelMode')?.addEventListener('click', () => toggleSelMode());

    // Delegación en el tbody (sobrevive a los re-render de renderTabla, que solo
    // reemplazan innerHTML; el listener queda en #catBody).
    document.getElementById('catBody')?.addEventListener('change', (e) => {
      const cb = e.target.closest('.row-chk');
      if (!cb) return;
      const id = cb.dataset.id;
      if (cb.checked) {
        const p = allProductos.find(x => x.doc_id === id);
        if (p) selMap.set(id, p);
      } else {
        selMap.delete(id);
      }
      cb.closest('tr')?.classList.toggle('row-selected', cb.checked);
      _syncSelAllChk();
      _updateSelBar();
    });

    // Checkbox maestro: marca/desmarca solo lo visible de la página actual.
    document.getElementById('selAllPage')?.addEventListener('change', (e) => {
      const on = e.target.checked;
      document.querySelectorAll('#catBody .row-chk').forEach(cb => {
        cb.checked = on;
        const id = cb.dataset.id;
        if (on) { const p = allProductos.find(x => x.doc_id === id); if (p) selMap.set(id, p); }
        else selMap.delete(id);
        cb.closest('tr')?.classList.toggle('row-selected', on);
      });
      e.target.indeterminate = false;
      _updateSelBar();
    });

    aplicarFiltros();

    // Si el modo seguía activo (re-mount por cambio de estado/rubro), restaurar
    // el estado visual: clase del table, estilo del botón y barra flotante.
    _paintSelMode();
    _updateSelBar();
  }

  // ABC FILTER (temporal)
  function _pintarABC() {
    document.querySelectorAll('#abcBar .abc-btn').forEach(b => {
      const l = b.dataset.letra || '';
      const activo = (l === letraActiva) || (l === '' && !letraActiva);
      b.classList.toggle('on', activo);
    });
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
      if (letraActiva && primeraLetraNombre(p.nombre) !== letraActiva) return false;
      if (buscar && !fuzzyMatch(buscar, p)) return false;
      if (cat   && (p.categoria || '') !== cat) return false;
      if (prov  && (p.proveedor || '') !== prov) return false;
      if (marca && (p.marca || '') !== marca) return false;
      if (estado) {
        if (estado === 'duplicado'  && !p.duplicado) return false;
        if (estado === 'agotado'    && _stockDisplay(p) > 0) return false;
        if (estado === 'activo'     && (p.estado !== 'activo' || p.duplicado)) return false;
        if (estado === 'sin_precio' && p.estado !== 'sin_precio') return false;
        if (estado === 'con_stock'  && (p.estado !== 'activo' || p.duplicado || _stockDisplay(p) === 0)) return false;
        if (estado === 'decimales'  && !((p.precio_venta > 0) && (p.precio_venta % 100) !== 0)) return false;
      }
      return true;
    });

    // Orden estable: alfabético por nombre (case-insensitive, ignora acentos)
    filtrados.sort((a, b) =>
      (a.nombre || '').localeCompare(b.nombre || '', 'es', { sensitivity: 'base', numeric: true })
    );

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
      tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;padding:40px;color:var(--text-muted)">Sin productos</td></tr>`;
      try { _syncSelAllChk(); } catch(_) {}
      renderPaginacion(pages);
      return;
    }

    // Mapeo unidad larga → corta para badges de productos conjunto
    const _UCONJ_SHORT = {
      metros:'m', cm:'cm', unidades:'u', gramos:'g', kilos:'kg',
      litros:'L', m2:'m²',
    };

    tbody.innerHTML = chunk.map(p => {
      // Producto Conjunto: el stock real se computa en vivo desde las variedades
      // (unidades × contenido_variedad + restante), porque `p.conjunto_total`
      // puede quedar desactualizado en DB tras editar variedades.
      const esConj = !!p.es_conjunto;
      const cContenido = Number(p.conjunto_contenido || 0);
      const cUShort = _UCONJ_SHORT[p.conjunto_unidad_medida] || '';
      const _variedadesGrid = Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [];

      let cTotal = Number(p.conjunto_total || 0);
      let _stockDesglose = null;
      if (esConj && _variedadesGrid.length > 0) {
        _stockDesglose = _variedadesGrid.map(c => {
          const cont = _contVariedad(c, cContenido);
          const u = Number(c.unidades) || 0;
          const r = Number(c.restante) || 0;
          return { color: c.color, u, r, cont, total: u * cont + r };
        });
        cTotal = _stockDesglose.reduce((s, d) => s + d.total, 0);
      }

      // Con separador de miles, como lo muestra la ficha: "49.948 u", no "49948u".
      const _fmtStock = (n) => `${Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 })}${cUShort ? ' ' + cUShort : ''}`;
      // Producto vinculado: la disponibilidad sale del/los producto(s) de stock
      // vinculado(s), no del stock propio. _stockShown clampea negativos
      // (sobrevendido → 0; -1 → ∞ servicio): nunca se muestra stock negativo.
      const _linked = !esConj && _tieneLinks(p);
      const _shown = esConj ? null : _stockShown(p);
      const stockNum = esConj ? cTotal : _shown.num;
      const stockText = esConj ? _fmtStock(cTotal) : _shown.text;

      let estadoBadge;
      if (p.duplicado) {
        estadoBadge = `<span class="badge badge-orange">Duplicado</span>`;
      } else if (p.estado === 'sin_precio') {
        estadoBadge = `<span class="badge" style="background:var(--tint-yellow-bg);color:var(--tint-orange-fg)">Sin Precio</span>`;
      } else if (stockNum <= 0) {
        estadoBadge = `<span class="badge badge-red">Agotado</span>`;
      } else if (esConj) {
        estadoBadge = (cContenido > 0 && cTotal <= cContenido)
          ? `<span class="badge badge-orange">Stock Bajo</span>`
          : `<span class="badge" style="background:var(--tint-purple-bg);color:var(--tint-purple-fg)">Con Stock</span>`;
      } else if (stockNum <= 3) {
        estadoBadge = `<span class="badge badge-orange">Stock Bajo</span>`;
      } else {
        estadoBadge = `<span class="badge badge-green">Con Stock</span>`;
      }

      const stockColor = stockNum <= 0
        ? 'var(--danger)'
        : (esConj
            ? '#7c3aed'
            : (stockNum <= 3 ? 'var(--warning)' : 'var(--text)'));

      // Datos pre-calculados para los tooltips de variedades del producto conjunto.
      // Se usan en 3 columnas (Costo, Precio Venta, Precio Und) — los calculo
      // una vez para no repetir la lógica.
      const _esConj = !!p.es_conjunto;
      // Si el tipo del conjunto es "unidad", no se aplica el 15% al detalle
      // (la venta es directa por unidad, sin margen adicional).
      const FRACCION = (p.conjunto_tipo === 'unidad') ? 1 : 1.15;
      const um = p.conjunto_unidad_medida || 'unidades';
      const umSg = um.endsWith('s') ? um.slice(0, -1) : um;
      const globalPack = Number(p.precio_venta) || 0;
      const globalCont = Number(p.conjunto_contenido) || 0;
      const globalCosto= Number(p.costo) || 0;
      const globalUnit = (Number(p.conjunto_precio_unidad) > 0)
        ? Number(p.conjunto_precio_unidad)
        : (globalPack > 0 && globalCont > 0 ? (globalPack / globalCont) * FRACCION : 0);
      const variedades = Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [];

      // Helper que arma un botoncito violeta con tooltip rich (HTML).
      const tipBtn = (htmlLines) => {
        const tip = htmlLines.join('<br/>').replace(/"/g, '&quot;');
        return `<span class="precio-unit-info" data-tip="${tip}" style="margin-left:4px;display:inline-flex;align-items:center;color:var(--tint-purple-fg);cursor:help" title="">
          <span class="material-icons" style="font-size:14px">info</span>
        </span>`;
      };

      // Tooltip de STOCK por variedad: desglose unidades × contenido + sueltos.
      let stockTipHtml = '';
      if (_esConj && _stockDesglose && _stockDesglose.length > 0) {
        const _fmtN = (n) => Number.isInteger(n) ? n : Number(Number(n).toFixed(2));
        const lineas = _stockDesglose.map(d => {
          const partes = [];
          if (d.u > 0 && d.cont > 0) partes.push(`${_fmtN(d.u)} × ${_fmtN(d.cont)}${cUShort}`);
          if (d.r > 0) partes.push(`${_fmtN(d.r)} sueltos`);
          const sum = partes.length ? partes.join(' + ') : '0';
          return `${_escHtml(d.color)}: ${sum} = <b>${_fmtN(d.total)}${cUShort}</b>`;
        });
        if (lineas.length) stockTipHtml = tipBtn(lineas);
      }

      // Tooltip de STOCK por VÍNCULO: este producto no lleva stock propio, su
      // disponibilidad sale del/los producto(s) de stock vinculado(s).
      let linkTipHtml = '';
      if (_linked) {
        const lineas = _linksDe(p).map(l => {
          const t = allProductos.find(x => x.doc_id === l.doc_id);
          const nom = (t && t.nombre) || l.doc_id;
          const cu = (Number(l.cantidad) === 1) ? '' : ` ×${l.cantidad}`;
          return `↳ ${_escHtml(nom)}${cu}`;
        });
        linkTipHtml = tipBtn(['<b>Stock por vínculo</b>', ...lineas]);
      }

      // Tooltip de COSTO por variedad: muestra el costo propio si lo tiene,
      // o el costo global como fallback.
      let costoTipHtml = '';
      if (_esConj && variedades.length > 0) {
        const lineas = variedades.map(c => {
          const co = (c.costo && c.costo > 0) ? c.costo : globalCosto;
          return co > 0
            ? `${_escHtml(c.color)}: $${fmt(co)}`
            : `${_escHtml(c.color)}: —`;
        });
        if (lineas.length) costoTipHtml = tipBtn(lineas);
      }

      // Tooltip de PRECIO VENTA: muestra el precio del PACK/ROLLO por variedad
      // (precio_pack si lo tiene, si no el global).
      let packTipHtml = '';
      if (_esConj) {
        const lineas = variedades.length > 0
          ? variedades.map(c => {
              const pack = (c.precio_pack && c.precio_pack > 0) ? c.precio_pack : globalPack;
              return pack > 0
                ? `${_escHtml(c.color)}: $${fmt(pack)}/pack`
                : `${_escHtml(c.color)}: —`;
            })
          : (globalPack > 0 ? [`Precio pack: <b>$${fmt(globalPack)}</b>`] : []);
        if (lineas.length) packTipHtml = tipBtn(lineas);
      }

      // Tooltip de PRECIO UND: precio por unidad/metro/etc. de cada variedad.
      let unitTipHtml = '';
      let unitDisplay = '—';
      if (_esConj) {
        if (variedades.length > 0) {
          const valores = variedades.map(c => {
            const pack = (c.precio_pack && c.precio_pack > 0) ? c.precio_pack : globalPack;
            const cont = (c.contenido   && c.contenido   > 0) ? c.contenido   : globalCont;
            const unit = (c.precio      && c.precio      > 0)
              ? c.precio
              : (pack > 0 && cont > 0 ? (pack / cont) * FRACCION : 0);
            return { color: c.color, unit };
          });
          const lineas = valores.map(v => v.unit > 0
            ? `${_escHtml(v.color)}: $${fmt(v.unit)}/${umSg}`
            : `${_escHtml(v.color)}: —`);
          unitTipHtml = tipBtn(lineas);
          // Display compacto en celda: usa el menor precio (representativo "desde")
          const positivos = valores.map(v => v.unit).filter(x => x > 0);
          if (positivos.length) unitDisplay = `desde $${fmt(Math.min(...positivos))}`;
        } else if (globalUnit > 0) {
          unitDisplay = `$${fmt(globalUnit)}`;
          unitTipHtml = tipBtn([`Precio por ${umSg}: <b>$${fmt(globalUnit)}</b>`]);
        }
      }

      return `<tr class="${selMap.has(p.doc_id) ? 'row-selected' : ''}">
        <td class="cat-sel-col"><input type="checkbox" class="row-chk" data-id="${p.doc_id}" ${selMap.has(p.doc_id) ? 'checked' : ''} /></td>
        <td class="cat-col-codigo" style="color:var(--text-muted);font-size:12px">
          <div>${p.codigo || '-'}</div>
        </td>
        <td class="cat-col-producto"><b style="font-size:13px">${p.nombre || '-'}</b><br><span style="color:var(--text-muted);font-size:11px">${p.cod_barra || ''}</span>${modIndicatorHtml(p)}</td>
        <td><span class="badge badge-gray">${p.categoria || '-'}</span></td>
        <td class="cat-col-marca" style="font-size:12px">${p.marca || '-'}</td>
        <td class="cat-col-proveedor" style="font-size:12px">${p.proveedor || '-'}</td>
        <td class="precio-cell" data-id="${p.doc_id}" data-field="costo" style="cursor:pointer" title="Click para editar">
          <div style="display:inline-flex;align-items:center;gap:4px"><span>$${fmt(p.costo)}</span>${costoTipHtml}</div>
        </td>
        <td class="precio-cell" data-id="${p.doc_id}" data-field="precio_venta" style="cursor:pointer" title="Click para editar">
          <div style="display:inline-flex;align-items:center;gap:4px">
            <span>$${fmt(p.precio_venta)}</span>
            ${(() => {
              const margenPct = p.costo > 0 ? Math.round(((p.precio_venta - p.costo)/p.costo)*100) : 0;
              return `<span style="font-size:10px;color:var(--tint-purple-fg);font-weight:700;margin-left:4px">(${margenPct}%)</span>`;
            })()}
            ${packTipHtml}
          </div>
        </td>
        <td style="font-size:13px;color:${_esConj ? 'var(--tint-purple-fg)' : 'var(--text-muted)'};font-weight:${_esConj ? '600' : '400'}">
          <div style="display:inline-flex;align-items:center;gap:4px"><span>${unitDisplay}</span>${unitTipHtml}</div>
        </td>
        <td style="text-align:center;font-weight:700;color:${stockColor}" class="${(esConj || _linked) ? '' : 'precio-cell'}" data-id="${p.doc_id}" data-field="stock" title="${esConj ? 'Stock conjunto — editá desde el modal' : (_linked ? 'Stock del producto vinculado — se gestiona desde el vinculado' : 'Click para editar')}">
          <div style="display:inline-flex;align-items:center;gap:4px;justify-content:center"><span>${stockText}</span>${stockTipHtml}${linkTipHtml}</div>
        </td>
        <td>${estadoBadge}</td>
        <td style="display:flex;gap:4px;align-items:center">
          <button class="btn-editar" data-id="${p.doc_id}" style="background:none;border:none;cursor:pointer;color:var(--primary);padding:4px" title="Editar producto">
            <span class="material-icons" style="font-size:18px">edit</span>
          </button>
          <button class="btn-detalle" data-id="${p.doc_id}" style="background:none;border:none;cursor:pointer;color:var(--text-muted);padding:4px" title="Ver detalle">
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
      cell.addEventListener('click', (e) => {
        // No abrir editor si se clickeó el ícono de info de precio unitario
        if (e.target.closest('.precio-unit-info')) return;
        editarCampo(cell);
      });
    });

    // Tooltip rich (HTML) para los íconos de precio unitario
    _setupPrecioUnitTooltip();

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
        if (btn.classList.contains('is-deleting')) return;
        const id = btn.dataset.id;
        const prev = allProductos.find(p => p.doc_id === id);
        const nombreSafe = _escHtml(prev?.nombre || 'este producto');
        const ok = await confirmModal({
          title: 'Eliminar producto',
          message: `¿Seguro que querés eliminar <b>${nombreSafe}</b> del catálogo?<br><span style="color:var(--text-muted);font-size:12px">Podés deshacerlo desde el historial (Ctrl+Z).</span>`,
          confirmText: 'Eliminar',
          cancelText: 'Cancelar',
          danger: true,
        });
        if (!ok) return;
        const _prodDel = allProductos.find(p => p.doc_id === id);
        const tr = btn.closest('tr');

        // Flag de edit local: bloquea el re-render automático que main.js
        // dispara al recibir el snapshot del server (perdería búsqueda/scroll).
        try { window.__catalogoLocalEditUntil = Date.now() + 8000; } catch(_) {}

        // Feedback visual inmediato + red en paralelo
        btn.classList.add('is-deleting');
        if (tr) tr.classList.add('row-removing');
        const netPromise = Promise.all([
          deleteDoc(doc(db, 'catalogo', id)),
          _registerCatalogoDeleted(db, id),
        ]);

        // Esperar animación corta y luego quitar de memoria + DOM sin re-render
        await new Promise(r => setTimeout(r, 160));
        allProductos = allProductos.filter(p => p.doc_id !== id);
        filtrados = filtrados.filter(p => p.doc_id !== id);
        // Si estaba en la selección múltiple, sacarlo para no dejar un item fantasma.
        if (selMap.delete(id)) { _syncSelAllChk(); _updateSelBar(); }
        invalidateCacheByPrefix('catalogo');
        if (_prodDel) hist.recordDelete(_prodDel, { label: `Borrar ${_prodDel.nombre || _prodDel.name || id}` });

        // Quitar solo la fila del DOM (sin rebuild de la tabla)
        if (tr && tr.parentNode) tr.parentNode.removeChild(tr);

        // Actualizar contador de página
        const countEl = document.getElementById('catCount');
        if (countEl) {
          const total = filtrados.length;
          const pages = Math.max(1, Math.ceil(total / PER_PAGE));
          if (currentPage > pages) currentPage = pages;
          countEl.textContent = `${total} productos (pág ${currentPage}/${pages})`;
        }

        // Si la página quedó vacía, recién ahí re-render (para mostrar siguiente página o "Sin productos")
        const tbody = document.getElementById('catBody');
        if (tbody && !tbody.querySelector('tr:not(.row-removing)')) {
          renderTabla();
        }

        renderStats();

        try {
          await netPromise;
          _touchCatalogoMeta(db).catch(() => {});
        } catch(e) {
          if (prev) {
            allProductos.push(prev);
            aplicarFiltros();
            renderStats();
          }
          alertDialog({ title: 'Error', message: 'No se pudo eliminar: ' + _escHtml(e?.message || e), type: 'error' });
        }
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
          if (!await confirmModal({ title: 'Redondear precios', message: `¿Redondear al centena más cercano los <b>${filtrados.length}</b> productos con precio decimal?`, confirmText: 'Redondear' })) return;
          btnRedondearTodos.disabled = true;
          btnRedondearTodos.innerHTML = '<span class="material-icons" style="font-size:16px;animation:spin 0.8s linear infinite">refresh</span> Redondeando...';
          try {
            const BATCH = 500;
            const ts = serverTimestamp();
            const _changes = [];
            for (let i = 0; i < filtrados.length; i += BATCH) {
              const batch = writeBatch(db);
              filtrados.slice(i, i + BATCH).forEach(p => {
                const redondeado = redondearCentena(p.precio_venta);
                const nuevoMargen = p.costo > 0 ? Math.round(((redondeado - p.costo) / p.costo) * 100) : p.margen || 0;
                _changes.push({
                  docId: p.doc_id, invId: p.id || p.doc_id, syncInv: false,
                  before: { precio_venta: p.precio_venta, margen: (p.margen ?? null) },
                  after:  { precio_venta: redondeado,      margen: nuevoMargen },
                });
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
            if (_changes.length) hist.recordBatch(_changes, { label: `Redondear ${_changes.length} precios` });
            aplicarFiltros();
            renderStats();
          } catch(e) {
            alertDialog({ title: 'Error', message: 'No se pudo redondear: ' + _escHtml(e.message), type: 'error' });
            btnRedondearTodos.disabled = false;
            btnRedondearTodos.innerHTML = '<span class="material-icons" style="font-size:16px">auto_fix_high</span>Redondear todos';
          }
        });
      } else {
        btnRedondearTodos.style.display = 'none';
      }
    }

    try { _syncSelAllChk(); } catch(_) {}
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

  // ── Selección múltiple: helpers ─────────────────────────────────────────────
  // Pinta el estado visual del modo (clase del table + estilo del botón toggle).
  function _paintSelMode() {
    document.getElementById('catTable')?.classList.toggle('sel-on', selMode);
    const btn = document.getElementById('btnSelMode');
    if (btn) {
      // Inactivo: rojo suave (outline) para que se note como acción de borrado.
      // Activo: rojo lleno.
      btn.style.background  = selMode ? 'var(--danger)' : 'var(--tint-red-bg)';
      btn.style.color       = selMode ? '#fff' : 'var(--danger)';
      btn.style.borderColor = 'var(--danger)';
      const l = btn.querySelector('.sel-lbl');
      if (l) l.textContent = selMode ? 'Cancelar selección' : 'Seleccionar';
    }
    // Reservar lugar bajo la paginación para que la barra flotante no la tape.
    const pag = document.getElementById('paginacion');
    if (pag) pag.style.paddingBottom = selMode ? '84px' : '';
  }

  // Entra/sale del modo. force opcional para forzar un estado.
  function toggleSelMode(force) {
    selMode = (typeof force === 'boolean') ? force : !selMode;
    if (!selMode) {
      selMap.clear();
      document.querySelectorAll('#catBody .row-chk').forEach(cb => { cb.checked = false; });
      document.querySelectorAll('#catBody tr.row-selected').forEach(tr => tr.classList.remove('row-selected'));
      const all = document.getElementById('selAllPage');
      if (all) { all.checked = false; all.indeterminate = false; }
    }
    _paintSelMode();
    _syncSelAllChk();
    _updateSelBar();
  }

  // Sincroniza el checkbox maestro (marcado/indeterminado) con lo visible.
  function _syncSelAllChk() {
    const all = document.getElementById('selAllPage');
    if (!all) return;
    const chks = [...document.querySelectorAll('#catBody .row-chk')];
    const sel = chks.filter(c => c.checked).length;
    all.checked = chks.length > 0 && sel === chks.length;
    all.indeterminate = sel > 0 && sel < chks.length;
  }

  // Refleja selMap en los checkboxes/filas visibles (tras editar desde la preview).
  function _reflectSelInTable() {
    document.querySelectorAll('#catBody .row-chk').forEach(cb => {
      const on = selMap.has(cb.dataset.id);
      cb.checked = on;
      cb.closest('tr')?.classList.toggle('row-selected', on);
    });
    _syncSelAllChk();
    _updateSelBar();
  }

  // Crea/actualiza/elimina la barra flotante de acciones.
  function _updateSelBar() {
    let bar = document.getElementById('selBar');
    if (!selMode) { bar?.remove(); return; }
    const n = selMap.size;
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'selBar';
      container.appendChild(bar);
    }
    bar.innerHTML = `
      <span style="font-weight:700;font-size:14px;color:var(--text);white-space:nowrap">
        ${n} seleccionado${n === 1 ? '' : 's'}
      </span>
      <button class="sel-bar-btn" id="selVer" ${n ? '' : 'disabled'}>
        <span class="material-icons" style="font-size:17px">list</span>Ver lista
      </button>
      <button class="sel-bar-btn danger" id="selDel" ${n ? '' : 'disabled'}>
        <span class="material-icons" style="font-size:17px">delete</span>Borrar ${n}
      </button>
      <button class="sel-bar-btn" id="selExit" title="Salir de selección múltiple">
        <span class="material-icons" style="font-size:17px">close</span>
      </button>
    `;
    bar.querySelector('#selVer')?.addEventListener('click', abrirPreviewSeleccion);
    bar.querySelector('#selDel')?.addEventListener('click', borrarSeleccion);
    bar.querySelector('#selExit')?.addEventListener('click', () => toggleSelMode(false));
  }

  // Pone la barra en estado "ocupado" durante el borrado.
  function _setSelBarBusy(txt) {
    const bar = document.getElementById('selBar');
    if (!bar) return;
    bar.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:10px;font-weight:700;font-size:14px;color:var(--text)">
        <span class="material-icons" style="font-size:18px;animation:spin 0.8s linear infinite">refresh</span>${_escHtml(txt)}
      </span>`;
  }

  // Modal de preview: lista editable de lo seleccionado.
  function abrirPreviewSeleccion() {
    document.querySelector('.sel-preview-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay sel-preview-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1300;display:flex;align-items:center;justify-content:center;padding:16px';
    const panel = document.createElement('div');
    panel.style.cssText = 'background:var(--surface);border-radius:16px;width:100%;max-width:560px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,0.25);overflow:hidden';
    overlay.appendChild(panel);

    const pintar = () => {
      const items = [...selMap.values()];
      panel.innerHTML = `
        <div style="padding:18px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px">
          <h3 style="margin:0;font-size:16px">Productos a borrar (${items.length})</h3>
          <button class="sp-close" style="background:none;border:none;cursor:pointer;color:var(--text-muted);display:flex"><span class="material-icons">close</span></button>
        </div>
        <div style="flex:1;overflow-y:auto;min-height:80px">
          ${items.length ? items.map(p => `
            <div style="display:flex;align-items:center;gap:12px;padding:9px 20px;border-bottom:1px solid var(--border)">
              <div style="flex:1;min-width:0">
                <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_escHtml(p.nombre || '-')}</div>
                <div style="font-size:11px;color:var(--text-muted)">${_escHtml(p.codigo || 's/código')} · $${fmt(p.precio_venta)}</div>
              </div>
              <button class="sp-del" data-id="${_escHtml(p.doc_id)}" title="Quitar de la lista" style="background:none;border:none;cursor:pointer;color:var(--text-muted);padding:4px;display:flex">
                <span class="material-icons" style="font-size:18px">close</span>
              </button>
            </div>`).join('') : `<div style="padding:48px 20px;text-align:center;color:var(--text-muted)">No hay productos seleccionados.</div>`}
        </div>
        <div style="padding:14px 20px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px">
          <button class="sp-clear sel-bar-btn" ${items.length ? '' : 'disabled'}>Vaciar lista</button>
          <div style="display:flex;gap:10px">
            <button class="sp-cancel sel-bar-btn">Cerrar</button>
            <button class="sp-confirm sel-bar-btn danger" ${items.length ? '' : 'disabled'}>Borrar ${items.length}</button>
          </div>
        </div>`;
      panel.querySelector('.sp-close')?.addEventListener('click', () => overlay.remove());
      panel.querySelector('.sp-cancel')?.addEventListener('click', () => overlay.remove());
      panel.querySelector('.sp-clear')?.addEventListener('click', () => { selMap.clear(); _reflectSelInTable(); pintar(); });
      panel.querySelectorAll('.sp-del').forEach(b => b.addEventListener('click', () => {
        selMap.delete(b.dataset.id);
        _reflectSelInTable();
        pintar();
      }));
      panel.querySelector('.sp-confirm')?.addEventListener('click', () => { overlay.remove(); borrarSeleccion(); });
    };

    pintar();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    container.appendChild(overlay);
  }

  // Borra en lote todo lo de selMap. Usa writeBatch en chunks (Firestore:
  // máx 500 ops/batch; cada producto = delete catalogo + tombstone = 2 ops).
  async function borrarSeleccion() {
    if (_selBorrando) return;
    const items = [...selMap.values()];
    if (!items.length) return;

    // Tomar el lock ANTES del confirm: cierra la ventana en la que el botón
    // "Borrar" de la barra seguía clickeable mientras el diálogo estaba abierto.
    _selBorrando = true;
    try {
      const ok = await confirmModal({
        title: 'Borrar seleccionados',
        message: `¿Seguro que querés eliminar <b>${items.length}</b> producto(s) del catálogo?<br><span style="color:var(--text-muted);font-size:12px">Podés deshacerlo desde el historial (Ctrl+Z).</span>`,
        confirmText: `Borrar ${items.length}`,
        cancelText: 'Cancelar',
        danger: true,
      });
      if (!ok) return;

      // Bloquear el re-render automático por snapshot del server mientras opera.
      try { window.__catalogoLocalEditUntil = Date.now() + 20000; } catch(_) {}

      const CHUNK = 200;
      const committed = [];
      const errores = [];
      for (let i = 0; i < items.length; i += CHUNK) {
        const slice = items.slice(i, i + CHUNK);
        _setSelBarBusy(`Borrando ${Math.min(i + slice.length, items.length)}/${items.length}...`);
        const batch = writeBatch(db);
        slice.forEach(p => {
          batch.delete(doc(db, 'catalogo', p.doc_id));
          batch.set(doc(db, 'catalogo_deleted', p.doc_id), { deleted_at: serverTimestamp() });
        });
        try { await batch.commit(); committed.push(...slice); }
        catch (e) { errores.push(e); console.error('Batch de borrado falló:', e); }
      }

      // Aplicar a memoria/cache/historial SOLO lo realmente borrado.
      if (committed.length) {
        const ids = new Set(committed.map(p => p.doc_id));
        allProductos = allProductos.filter(p => !ids.has(p.doc_id));
        filtrados = filtrados.filter(p => !ids.has(p.doc_id));
        invalidateCacheByPrefix('catalogo');
        const changes = committed.map(p => ({
          docId: p.doc_id, invId: p.id || null, syncInv: false,
          before: { ...p, doc_id: p.doc_id }, after: null,
        }));
        hist.recordBatch(changes, { label: `Borrar ${changes.length} producto(s)` });
        _touchCatalogoMeta(db).catch(() => {});
        committed.forEach(p => selMap.delete(p.doc_id));
      }

      aplicarFiltros();
      renderStats();

      if (selMap.size === 0) {
        toggleSelMode(false);
      } else {
        _reflectSelInTable();
      }

      if (errores.length) {
        alertDialog({
          title: 'Borrado incompleto',
          message: `Se borraron ${committed.length} producto(s). ${selMap.size} no se pudieron borrar y quedan seleccionados para reintentar.`,
          type: 'error',
        });
      }
    } finally {
      _selBorrando = false;
    }
  }

  // ── Autocomplete custom (dropdown estilizado con filtrado en vivo) ─────────
  // Reemplaza datalists / selects feos: filtra mientras se tipea, soporta
  // teclado (↑/↓/Enter/Esc), y acepta valores nuevos sin pasos extra — si
  // el usuario tipea algo que no está en la lista, queda como nuevo.
  //
  //   input:       <input> al que se le adjunta el dropdown
  //   getOptions:  función → array<string> (se llama por cada apertura/tipeo,
  //                así toma siempre la lista actualizada)
  //   onChange:    callback opcional (valor) — se dispara al seleccionar
  //                opción o al confirmar con Enter/blur
  function _setupAutocomplete(input, getOptions, { onChange } = {}) {
    if (!input || input.dataset.acReady === '1') return;
    input.dataset.acReady = '1';

    // Wrap relativo para posicionar el dropdown debajo
    const parent = input.parentElement;
    if (parent && getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }

    const dd = document.createElement('div');
    dd.className = 'ac-dropdown';
    dd.style.cssText = 'position:absolute;left:0;right:0;top:100%;margin-top:4px;background:var(--surface);border:1.5px solid #1877f2;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.12);max-height:260px;overflow-y:auto;z-index:2100;display:none;font-family:inherit';
    parent.appendChild(dd);

    // Normaliza: quita tildes, lower-case, trim
    const _norm = s => (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

    let cursor = -1;     // índice de la opción resaltada (-1 = ninguna)
    let lastList = [];   // opciones visibles actualmente

    function render() {
      const raw = getOptions() || [];
      const q = _norm(input.value);
      let opts = [];
      if (q === '') {
        opts = raw.slice(0, 200);
      } else {
        // Priorizar las que arrancan con el query, luego las que lo contienen
        const starts = [], contains = [];
        for (const o of raw) {
          const n = _norm(o);
          if (n.startsWith(q)) starts.push(o);
          else if (n.includes(q)) contains.push(o);
        }
        opts = [...starts, ...contains].slice(0, 200);
      }
      lastList = opts;
      cursor = -1;

      const hayMatchExacto = raw.some(o => _norm(o) === q);
      const nuevoTexto = (q !== '' && !hayMatchExacto) ? input.value.trim() : '';

      const rows = opts.map((o, i) => `
        <div class="ac-item" data-i="${i}" style="padding:9px 14px;cursor:pointer;font-size:13.5px;color:var(--text);border-bottom:1px solid var(--border)">${_escHtml(o)}</div>
      `).join('');

      // Pie "Usar como nuevo" cuando lo tipeado no está en la lista
      const pie = nuevoTexto
        ? `<div class="ac-new" style="padding:9px 14px;cursor:pointer;font-size:13px;color:var(--tint-green-fg);font-weight:600;background:var(--tint-green-bg);display:flex;align-items:center;gap:6px;border-top:1px solid var(--border)">
             <span class="material-icons" style="font-size:16px">add_circle</span>
             Usar "${_escHtml(nuevoTexto)}" como nuevo
           </div>`
        : '';

      if (!rows && !pie) {
        dd.innerHTML = `<div style="padding:10px 14px;font-size:13px;color:var(--text-muted);font-style:italic">Sin coincidencias — quedará como nuevo al guardar</div>`;
      } else {
        dd.innerHTML = rows + pie;
      }
    }

    function abrir() { render(); dd.style.display = 'block'; }
    function cerrar() { dd.style.display = 'none'; cursor = -1; }

    function elegir(valor) {
      input.value = valor;
      try { onChange && onChange(valor); } catch (_) {}
      cerrar();
    }

    function setCursor(idx) {
      cursor = idx;
      dd.querySelectorAll('.ac-item').forEach((el, i) => {
        el.style.background = (i === idx) ? '#e7f0ff' : '';
        if (i === idx) el.scrollIntoView({ block: 'nearest' });
      });
    }

    input.addEventListener('focus', abrir);
    input.addEventListener('input', () => { abrir(); });
    input.addEventListener('keydown', (e) => {
      if (dd.style.display === 'none') return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor(Math.min(cursor + 1, lastList.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor(Math.max(cursor - 1, 0));
      } else if (e.key === 'Enter') {
        if (cursor >= 0 && lastList[cursor]) {
          e.preventDefault();
          elegir(lastList[cursor]);
        } else {
          // Tipeado libre — se acepta como nuevo
          cerrar();
          try { onChange && onChange(input.value); } catch (_) {}
        }
      } else if (e.key === 'Escape') {
        cerrar();
      }
    });

    // Click en una opción: usar mousedown para que dispare antes del blur
    dd.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.ac-item');
      if (item) {
        e.preventDefault();
        elegir(lastList[Number(item.dataset.i)]);
        return;
      }
      const nuevo = e.target.closest('.ac-new');
      if (nuevo) {
        e.preventDefault();
        cerrar();
        try { onChange && onChange(input.value); } catch (_) {}
      }
    });

    // Cierre por click fuera
    document.addEventListener('mousedown', (e) => {
      if (e.target !== input && !dd.contains(e.target)) cerrar();
    });

    input.addEventListener('blur', () => {
      // Pequeño delay para permitir que el mousedown del dropdown se procese
      setTimeout(() => { if (document.activeElement !== input) cerrar(); }, 150);
    });
  }

  // ── Modal de edición completa de producto ──────────────────────────────────
  // Soporta modo "editar" (prod con doc_id) y modo "crear" (prod={} o sin
  // doc_id). En modo crear: el header cambia, el botón dice "Crear producto",
  // hay botón "Generar" al lado del código, y el save hace setDoc en vez de
  // updateDoc + push al array local.
  function abrirEditorCompleto(prod) {
    prod = prod || {};
    const esNuevo = !prod.doc_id;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2000;display:flex;align-items:center;justify-content:center;padding:8px;overflow-y:auto';

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
      <style>
        /* Sacar flechas de number input en variedades — más limpio */
        [data-color-row] input[type=number]::-webkit-outer-spin-button,
        [data-color-row] input[type=number]::-webkit-inner-spin-button {
          -webkit-appearance: none; margin: 0;
        }
        [data-color-row] input[type=number] { -moz-appearance: textfield; }
      </style>
      <div style="background:var(--surface);border-radius:18px;padding:0;max-width:760px;width:100%;max-height:96vh;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,0.22);overflow:hidden">

        <!-- Header -->
        <div style="background:linear-gradient(135deg,${esNuevo ? '#16a34a,#15803d' : '#1877f2,#0d5db5'});padding:16px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
          <div>
            <div style="color:rgba(255,255,255,0.75);font-size:11px;font-weight:700;letter-spacing:1px;margin-bottom:4px">${esNuevo ? 'NUEVO PRODUCTO' : 'EDITAR PRODUCTO'}</div>
            <div style="color:#fff;font-size:14px;font-weight:700;line-height:1.3;max-width:380px">${esNuevo ? 'Cargá los datos y guardalo' : (prod.nombre || '')}</div>
          </div>
          <button id="cerrarEditor" style="background:rgba(255,255,255,0.15);border:none;cursor:pointer;color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <span class="material-icons" style="font-size:18px">close</span>
          </button>
        </div>

        <!-- Body -->
        <div style="padding:20px;display:flex;flex-direction:column;gap:14px;flex:1 1 auto;min-height:0;overflow-y:auto">

          <!-- Nombre -->
          <div>
            <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">NOMBRE DEL PRODUCTO</label>
            <input id="ed_nombre" type="text" value="${prod.nombre || ''}" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
          </div>

          <!-- Rubro + Sub-rubro -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">RUBRO</label>
              <input id="ed_rubro" type="text" value="${prod.rubro || ''}" placeholder="Tipeá o elegí..." autocomplete="off" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">SUB-RUBRO</label>
              <input id="ed_subrubro" type="text" value="${prod.sub_rubro || ''}" placeholder="Tipeá para buscar..." autocomplete="off" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
          </div>

          <!-- Marca + Proveedor -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">MARCA</label>
              <input id="ed_marca" type="text" value="${prod.marca && prod.marca !== 'SIN MARCA' ? prod.marca : ''}" placeholder="Tipeá o elegí — si es nueva queda guardada" autocomplete="off" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">PROVEEDOR</label>
              <input id="ed_proveedor" type="text" value="${prod.proveedor && prod.proveedor !== 'SIN PROVEEDOR' ? prod.proveedor : ''}" placeholder="Tipeá o elegí — si es nuevo queda guardado" autocomplete="off" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
          </div>

          <!-- Código + Código de barras -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">CÓDIGO INTERNO</label>
              <div style="display:flex;gap:6px;align-items:stretch">
                <input id="ed_codigo" type="text" value="${prod.codigo || ''}" style="flex:1;min-width:0;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
                ${esNuevo ? `<button id="ed_gen_codes" type="button" title="Generar código único de 6 dígitos (interno = barras)" style="flex-shrink:0;padding:0 12px;border-radius:8px;border:none;background:#7b1fa2;color:#fff;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit">Generar</button>` : ''}
              </div>
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">CÓDIGO DE BARRAS</label>
              <input id="ed_barra" type="text" value="${prod.cod_barra || ''}" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
          </div>

          <!-- Placeholder donde vive el bloque de precio cuando el Conjunto está OFF -->
          <div id="ed_precio_home"></div>
          <!-- Costo + Precio venta (se mueve al bloque Conjunto cuando está activo) -->
          <div id="ed_precio_block" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px">
            <div>
              <label id="lbl_ed_costo" style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">COSTO $</label>
              <input id="ed_costo" type="number" step="0.01" min="0" value="${prod.costo || 0}" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">MARGEN %</label>
              <input id="ed_margen" type="number" step="1" min="0" value="${margenActual}" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
            </div>
            <div>
              <label id="lbl_ed_precio" style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">PRECIO VENTA $</label>
              <div style="display:flex;gap:6px;align-items:center">
                <input id="ed_precio" type="number" step="0.01" min="0" value="${prod.precio_venta || 0}" style="width:100%;padding:10px 12px;border:1.5px solid #1877f2;border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit;font-weight:700" />
                <button id="btn_redondear" type="button" title="Redondear al centena más cercano" style="flex-shrink:0;padding:10px 10px;border-radius:8px;border:1.5px solid var(--border);background:var(--bg);cursor:pointer;font-size:12px;font-weight:700;color:var(--text);white-space:nowrap;line-height:1">±100</button>
              </div>
            </div>
          </div>

          <!-- Stock + Alertas.
               Con "Producto Conjunto" activo el campo STOCK se oculta (se calcula
               del desglose), pero MÍN/MÁX siguen visibles: se comparan contra el
               total disponible en la unidad de medida del conjunto. -->
          <div id="ed_stock_bloque" style="display:flex;flex-direction:column;gap:8px">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;align-items:end">
              <div>
                <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">STOCK</label>
                <input id="ed_stock" type="number" step="1" min="-1" value="${prod.stock ?? 0}" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit" />
              </div>
            </div>
            <!-- Placeholder donde vive el bloque MÍN/MÁX cuando el Conjunto está OFF -->
            <div id="ed_stock_alertas_home"></div>
            <div id="ed_stock_hint" style="color:var(--text-muted);font-size:12px">
              <span style="background:var(--bg);border-radius:6px;padding:8px 12px;display:block">
                💡 <b>STOCK -1</b> = servicio/ilimitado &nbsp;|&nbsp; <b>0</b> = agotado &nbsp;|&nbsp; <b>&gt;0</b> = disponible. Dejá MÍN/MÁX vacío para desactivar alerta.
              </span>
            </div>
          </div>

          <!-- Alertas de reposición. Se mueve adentro del cuadro Conjunto (abajo
               de todo) cuando "Producto Conjunto" está activo, para no obligar a
               scrollear hasta arriba. -->
          <div id="ed_stock_alertas" style="display:flex;flex-direction:column;gap:8px">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;align-items:end">
              <div>
                <label id="lbl_ed_stock_min" style="font-size:11px;font-weight:700;color:var(--tint-orange-fg);letter-spacing:0.5px;display:block;margin-bottom:6px">STOCK MÍN. (avisar)</label>
                <input id="ed_stock_min" type="number" step="any" min="0" placeholder="Sin alerta"
                       value="${prod.stock_min ?? ''}"
                       style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit;background:var(--surface-2)" />
              </div>
              <div>
                <label id="lbl_ed_stock_max" style="font-size:11px;font-weight:700;color:var(--tint-orange-fg);letter-spacing:0.5px;display:block;margin-bottom:6px">STOCK MÁX. (ideal)</label>
                <input id="ed_stock_max" type="number" step="any" min="0" placeholder="Sin tope"
                       value="${prod.stock_max ?? ''}"
                       style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;font-family:inherit;background:var(--surface-2)" />
              </div>
            </div>
            <!-- Avisar por caja/pack/rollo en vez de por unidad suelta. Los
                 umbrales se siguen guardando en unidades; acá sólo se elige la
                 unidad con la que se escriben y se muestran. -->
            <div id="ed_bulto_box" style="background:var(--surface);border:1.5px dashed var(--border);border-radius:10px;padding:10px 12px;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end">
              <div>
                <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">AVISAR EN</label>
                <select id="ed_alerta_um" style="padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--surface-2)">
                  <option value="unidad">Unidades sueltas</option>
                  <option value="bulto">Cajas / packs / rollos</option>
                </select>
              </div>
              <div id="ed_bulto_cfg" style="display:none;align-items:flex-end;gap:8px">
                <div>
                  <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">TIPO</label>
                  <select id="ed_bulto_tipo" style="padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--surface-2)"></select>
                </div>
                <div>
                  <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:6px">UNIDADES POR <span id="ed_bulto_tipo_lbl">CAJA</span></label>
                  <input id="ed_bulto_contenido" type="number" min="2" step="1" placeholder="Ej: 12"
                         style="width:110px;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;box-sizing:border-box;font-family:inherit;background:var(--surface-2)" />
                </div>
              </div>
              <div id="ed_bulto_hint" style="flex:1 1 100%;font-size:12px;color:var(--text-muted);line-height:1.4"></div>
            </div>
            <div id="ed_stock_hint_conj" style="display:none;color:var(--tint-purple-fg);font-size:12px">
              <span style="background:var(--surface);border-radius:6px;padding:8px 12px;display:block;line-height:1.4">
                <b>Stock automático:</b> se calcula del desglose de arriba (cajas × contenido + sueltos), por eso no hay campo STOCK.
                Los umbrales se comparan contra ese <b>total disponible</b> en <b id="ed_stock_alerta_um">unidades</b>, no contra las cajas enteras. Dejá MÍN/MÁX vacío para desactivar la alerta.
                <span id="ed_stock_hint_var" style="display:none;color:var(--tint-orange-fg)"><br/>Este producto tiene variedades: el aviso normal se configura por fila. Vaciá estos campos si querés dejar solo el mínimo por variedad.</span>
              </span>
            </div>
          </div>

          <!-- Aviso cuando el producto está VINCULADO a otro de stock: no lleva
               stock propio, la disponibilidad sale del/los producto(s) fuente. -->
          <div id="ed_stock_vinculo_aviso" style="display:none;background:var(--tint-blue-bg);border:1.5px solid #1565c0;border-radius:10px;padding:10px 14px;color:var(--tint-blue-fg);font-size:12.5px;line-height:1.4">
            <b>Stock por vínculo:</b> este producto no lleva stock propio. Su disponibilidad se calcula desde el/los producto(s) de stock vinculado(s): <b id="ed_stock_vinculo_valor">—</b> disponibles. Para reponer, cargá stock en el producto fuente.
          </div>

          <!-- Vinculado a otros productos (consumibles).
               Visible siempre. En productos NO conjunto, descuenta de cada producto
               fuente por cada unidad vendida. En conjuntos SIN variedades, descuenta
               cada vez que se vende el conjunto. Si el conjunto tiene variedades, el
               watcher prioriza los vínculos per-variedad e ignora éstos. Se admite
               múltiples vinculaciones (ej: Impresión Color → 1 Hoja A4 + 0.05 Tóner). -->
          <div id="ed_vinc_bloque" style="border:1.5px dashed var(--border);border-radius:10px;padding:12px 14px;background:var(--tint-blue-bg)">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <span class="material-icons" style="color:var(--tint-blue-fg);font-size:18px">link</span>
              <div style="flex:1">
                <div style="font-size:13px;font-weight:700;color:var(--tint-blue-fg)">Vincular a productos de stock</div>
                <div style="font-size:11.5px;color:var(--tint-blue-fg);margin-top:1px">Al vender este ítem, se descuenta automáticamente de cada producto vinculado (ej: Impresión → Hojas Pampa + Tóner).</div>
              </div>
            </div>
            <div id="ed_vinc_lista" style="display:flex;flex-direction:column;gap:6px;margin-bottom:6px"></div>
            <button type="button" id="ed_vinc_add" style="align-self:flex-start;padding:6px 12px;border-radius:8px;border:1.5px solid #1565c0;background:#1565c0;color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">+ agregar vinculación</button>
          </div>

          <!-- Producto Conjunto (pack / rollo / caja) -->
          <div style="border:1.5px dashed var(--border);border-radius:10px;padding:14px;background:var(--tint-purple-bg)">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-weight:700;color:var(--tint-purple-fg);font-size:13px;user-select:none">
              <input id="ed_es_conjunto" type="checkbox" ${prod.es_conjunto ? 'checked' : ''} style="width:18px;height:18px;cursor:pointer;accent-color:var(--tint-purple-fg)">
              <span class="material-icons" style="font-size:18px">inventory_2</span>
              PRODUCTO CONJUNTO (pack / rollo / caja / metros)
            </label>
            <!-- Resumen GRANDE arriba: siempre visible para que el usuario vea el desglose -->
            <div id="ed_conj_resumen_top" style="${prod.es_conjunto ? 'display:block' : 'display:none'};margin-top:12px;background:var(--surface);border-left:4px solid #7c3aed;border-radius:8px;padding:12px 14px;font-size:13px;color:var(--text-strong);line-height:1.5"></div>
            <!-- Anchor: cuando el conjunto está activo, acá se inserta el bloque costo/margen/precio del pack -->
            <div id="ed_precio_block_anchor" style="margin-top:12px"></div>

            <div id="ed_conjunto_fields" style="margin-top:12px;${prod.es_conjunto ? 'display:grid' : 'display:none'};grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">
              <div>
                <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:4px">TIPO</label>
                <select id="ed_conj_tipo" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;box-sizing:border-box;font-family:inherit;background:var(--surface)">
                  ${['rollo','pack','caja','bobina','bolsa','plancha','cartulina','papel','carton','goma_eva','cinta','tela','unidad','otro'].map(t => {
                    const labels = {goma_eva:'Goma Eva', carton:'Cartón'};
                    const lbl = labels[t] || (t.charAt(0).toUpperCase()+t.slice(1));
                    return `<option value="${t}" ${ (prod.conjunto_tipo||'rollo') === t ? 'selected':'' }>${lbl}</option>`;
                  }).join('')}
                </select>
              </div>
              <div>
                <label style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:4px">UNIDAD DE MEDIDA</label>
                <select id="ed_conj_unidad_medida" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;box-sizing:border-box;font-family:inherit;background:var(--surface)">
                  ${['metros','unidades','gramos','kilos','litros','cm'].map(u => `<option value="${u}" ${ (prod.conjunto_unidad_medida||'metros') === u ? 'selected':'' }>${u.charAt(0).toUpperCase()+u.slice(1)}</option>`).join('')}
                </select>
              </div>
              <div>
                <label id="lbl_titulo_unidades" style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:4px">ROLLOS ENTEROS <span style="font-weight:500">(sin contar el abierto)</span></label>
                <input id="ed_conj_unidades" type="number" min="0" step="1" value="${prod.conjunto_unidades ?? ''}" placeholder="Ej: 5" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;box-sizing:border-box;font-family:inherit" />
              </div>
              <div>
                <label id="lbl_titulo_contenido" style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:4px">METROS POR ROLLO</label>
                <input id="ed_conj_contenido" type="number" min="0" step="0.01" value="${prod.conjunto_contenido ?? ''}" placeholder="Ej: 100" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;box-sizing:border-box;font-family:inherit" />
              </div>
              <div>
                <label id="lbl_titulo_restante" style="font-size:11px;font-weight:700;color:var(--tint-orange-fg);letter-spacing:0.5px;display:block;margin-bottom:4px">METROS SUELTOS EN ROLLO ABIERTO (opcional)</label>
                <input id="ed_conj_restante" type="number" min="0" step="0.01" value="${prod.conjunto_restante ?? ''}" placeholder="Ej: 35.5" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;box-sizing:border-box;font-family:inherit;background:var(--surface-2)" />
              </div>
              <div>
                <label id="lbl_titulo_punidad" style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:4px">PRECIO POR METRO <span style="color:var(--text-muted);font-weight:500">(auto)</span></label>
                <div style="display:flex;gap:5px;align-items:center">
                  <input id="ed_conj_precio_unidad" type="number" min="0" step="0.01" value="${prod.conjunto_precio_unidad ?? ''}" placeholder="Auto" style="flex:1 1 auto;min-width:0;width:auto;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;box-sizing:border-box;font-family:inherit" />
                  <button id="btn_redondear_pu" type="button" title="Redondear al centena más cercano" style="flex-shrink:0;padding:8px 10px;border-radius:8px;border:1.5px solid var(--border);background:var(--bg);cursor:pointer;font-size:11px;font-weight:700;color:var(--text);white-space:nowrap;line-height:1">±100</button>
                  <button id="ed_aplicar_precio_var" type="button" title="Aplicar este PRECIO POR METRO a todas las variedades" style="flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;padding:8px;border-radius:8px;border:1.5px solid #7c3aed;background:#7c3aed;color:#fff;cursor:pointer;line-height:1;transition:background .15s,border-color .15s">
                    <span class="material-icons" style="font-size:16px">sync_alt</span>
                  </button>
                </div>
                <div id="ed_conj_precio_hint" style="font-size:10px;color:var(--tint-purple-fg);margin-top:4px;line-height:1.3">
                  Se calcula como <b>precio ÷ contenido × 1.15</b> (15 % margen al detalle).<br/>
                  Editalo manualmente si querés un precio distinto.
                </div>
              </div>
              <div style="grid-column:1/-1;background:var(--surface);border-radius:6px;padding:10px 12px;font-size:12px;color:var(--text-muted)">
                <span id="ed_conj_resumen">Completá los campos para ver el total</span>
              </div>

              <!-- Variedades (opcional) -->
              <div style="grid-column:1/-1;display:flex;flex-direction:column;gap:8px">
                <div id="ed_colores_toggle_wrap" style="display:none;align-items:center;gap:8px;background:var(--surface);border:1px dashed var(--border);border-radius:8px;padding:8px 12px;font-size:12px;color:var(--text-muted)">
                  <input id="ed_colores_mismo_precio" type="checkbox" checked style="width:16px;height:16px;cursor:pointer;accent-color:var(--tint-purple-fg);flex-shrink:0">
                  <label for="ed_colores_mismo_precio" style="cursor:pointer;line-height:1.3">
                    <b>Mismo precio del pack para todas las variedades</b>
                    <span style="display:block;color:var(--text-muted);font-size:11.5px;margin-top:2px">Si las variedades tienen precios distintos (rollos diferentes, etc.), destildá esto y cargá el precio por fila.</span>
                  </label>
                </div>
                <div id="ed_colores_buscar_wrap" class="var-search-wrap" style="display:none">
                  <span class="material-icons var-search-ico">search</span>
                  <input id="ed_colores_buscar" type="text" class="var-search-input" placeholder="Buscar variedad..." autocomplete="off" spellcheck="false" />
                  <span id="ed_colores_buscar_count" class="var-search-count"></span>
                  <button id="ed_colores_buscar_clear" type="button" class="var-search-clear" title="Limpiar" style="display:none">
                    <span class="material-icons">close</span>
                  </button>
                </div>
                <div id="ed_colores_dup_warn" style="display:none;align-items:center;gap:10px;background:var(--tint-yellow-bg);border:1.5px solid var(--tint-yellow-fg);border-radius:8px;padding:9px 12px;font-size:12px;color:var(--tint-yellow-fg)">
                  <span class="material-icons" style="font-size:18px;flex-shrink:0">warning_amber</span>
                  <span id="ed_colores_dup_msg" style="flex:1;line-height:1.35"></span>
                  <button id="ed_colores_dup_fix" type="button" title="Agrega un número a las variedades repetidas para que queden distintas. Después podés editarlo." style="flex-shrink:0;display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:6px;border:1.5px solid var(--tint-yellow-fg);background:var(--surface);color:var(--tint-yellow-fg);font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap">
                    <span class="material-icons" style="font-size:14px">auto_fix_high</span>Diferenciar
                  </button>
                </div>
                <div id="ed_colores_list" style="display:none;flex-direction:column;gap:8px"></div>
                <div id="ed_colores_sin_match" class="var-search-empty" style="display:none">
                  <span class="material-icons">search_off</span>
                  <span>Ninguna variedad coincide con la búsqueda</span>
                </div>
                <button id="btn_add_color" type="button" style="align-self:flex-start;padding:4px 8px;border-radius:6px;border:none;background:transparent;color:var(--tint-purple-fg);cursor:pointer;font-size:12px;font-weight:600">
                  + agregar variedad
                </button>
                <span id="ed_colores_empty" style="display:none"></span>
              </div>

              <!-- Anchor: acá se inserta el bloque STOCK MÍN./MÁX. cuando el conjunto está activo -->
              <div id="ed_stock_alertas_anchor" style="grid-column:1/-1;border-top:1px dashed var(--border);padding-top:12px">
                <div id="ed_stock_alertas_nota" style="display:none;font-size:12px;color:var(--text-muted);line-height:1.4">
                  <b style="color:var(--tint-orange-fg)">Stock mínimo por variedad:</b> con variedades cargadas, el aviso se configura en cada fila (<b>Stock mín</b> / <b>máx</b>), no a nivel producto. Se compara contra el stock real de la variedad, packs enteros <b>+</b> sueltos. Si el pack trae más de una unidad, el botón naranja de la fila elige si el umbral se lee en packs o en unidades.
                </div>
              </div>
            </div>
          </div>

        </div>

        <!-- Footer -->
        <div style="padding:14px 20px;border-top:1px solid var(--border);display:flex;gap:10px;justify-content:space-between;align-items:center;background:var(--surface-2);flex-wrap:wrap;flex-shrink:0">
          <button id="ed_etiqueta" type="button" style="padding:10px 16px;border-radius:8px;border:1.5px solid var(--border);background:var(--surface);cursor:pointer;font-size:13px;font-weight:600;color:var(--text-muted);display:flex;align-items:center;gap:6px">
            <span class="material-icons" style="font-size:16px">qr_code_2</span>Descargar etiqueta
          </button>
          <div style="display:flex;gap:10px">
            <button id="ed_cancelar" style="padding:10px 20px;border-radius:8px;border:1.5px solid var(--border);background:var(--surface);cursor:pointer;font-size:14px;font-weight:600;color:var(--text-muted)">Cancelar</button>
            <button id="ed_guardar" style="padding:10px 24px;border-radius:8px;border:none;background:${esNuevo ? '#16a34a' : '#1877f2'};color:#fff;cursor:pointer;font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px">
              <span class="material-icons" style="font-size:16px">${esNuevo ? 'add_circle' : 'save'}</span>${esNuevo ? 'Crear producto' : 'Guardar cambios'}
            </button>
          </div>
        </div>

      </div>
    `;

    document.body.appendChild(overlay);

    // Cálculo automático precio ↔ margen
    const inCosto  = overlay.querySelector('#ed_costo');
    const inMargen = overlay.querySelector('#ed_margen');
    const inPrecio = overlay.querySelector('#ed_precio');

    // Cuando se modifica programáticamente inPrecio (desde costo/margen o ±100),
    // hay que avisarle al resumen del Producto Conjunto. Setear .value no dispara
    // 'input' por sí solo, así que disparamos el evento manualmente.
    function _emitInput(el) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    inCosto.addEventListener('input', () => {
      const c = parseFloat(inCosto.value) || 0;
      const m = parseFloat(inMargen.value) || 0;
      if (c > 0) {
        inPrecio.value = (c * (1 + m / 100)).toFixed(2);
        _emitInput(inPrecio);
      }
    });
    inMargen.addEventListener('input', () => {
      const c = parseFloat(inCosto.value) || 0;
      const m = parseFloat(inMargen.value) || 0;
      if (c > 0) {
        inPrecio.value = (c * (1 + m / 100)).toFixed(2);
        _emitInput(inPrecio);
      }
    });
    inPrecio.addEventListener('input', () => {
      const c = parseFloat(inCosto.value) || 0;
      const p = parseFloat(inPrecio.value) || 0;
      if (c > 0 && p > 0) inMargen.value = Math.round(((p - c) / c) * 100);
    });

    overlay.querySelector('#btn_redondear').addEventListener('click', () => {
      const p = parseFloat(inPrecio.value) || 0;
      if (!p) return;
      const redondeado = redondearCentena(p);
      inPrecio.value = redondeado;
      _emitInput(inPrecio);
      const c = parseFloat(inCosto.value) || 0;
      if (c > 0) inMargen.value = Math.round(((redondeado - c) / c) * 100);
    });

    // Botón ±100 para PRECIO POR METRO (mismo comportamiento que el del precio
    // del rollo). Marca el precio como manual para no auto-recalcular después.
    const btnRedondearPU = overlay.querySelector('#btn_redondear_pu');
    if (btnRedondearPU) {
      btnRedondearPU.addEventListener('click', () => {
        const inPU = overlay.querySelector('#ed_conj_precio_unidad');
        if (!inPU) return;
        const v = parseFloat(inPU.value) || 0;
        if (!v) return;
        inPU.value = redondearCentena(v);
        precioPUManual = true;
        if (typeof _refrescarConjunto === 'function') _refrescarConjunto();
      });
    }

    // ── Producto Conjunto: toggle + etiquetas dinámicas + resumen ──
    const cbConj      = overlay.querySelector('#ed_es_conjunto');
    const conjBox     = overlay.querySelector('#ed_conjunto_fields');
    const conjTipo    = overlay.querySelector('#ed_conj_tipo');
    const conjUM      = overlay.querySelector('#ed_conj_unidad_medida');
    const conjU       = overlay.querySelector('#ed_conj_unidades');
    const conjC       = overlay.querySelector('#ed_conj_contenido');
    const conjR       = overlay.querySelector('#ed_conj_restante');
    const conjPU      = overlay.querySelector('#ed_conj_precio_unidad');
    const conjHint    = overlay.querySelector('#ed_conj_precio_hint');
    const lblTitU     = overlay.querySelector('#lbl_titulo_unidades');
    const lblTitC     = overlay.querySelector('#lbl_titulo_contenido');
    const lblTitR     = overlay.querySelector('#lbl_titulo_restante');
    const lblTitPU    = overlay.querySelector('#lbl_titulo_punidad');
    const conjRes     = overlay.querySelector('#ed_conj_resumen');
    const conjResTop  = overlay.querySelector('#ed_conj_resumen_top');
    const stockBloque = overlay.querySelector('#ed_stock_bloque');
    const stockHint   = overlay.querySelector('#ed_stock_hint');
    const stockHintC  = overlay.querySelector('#ed_stock_hint_conj');
    const stockAlertaUM = overlay.querySelector('#ed_stock_alerta_um');
    const lblStockMin = overlay.querySelector('#lbl_ed_stock_min');
    const lblStockMax = overlay.querySelector('#lbl_ed_stock_max');
    const alertasBlock  = overlay.querySelector('#ed_stock_alertas');
    const alertasHome   = overlay.querySelector('#ed_stock_alertas_home');
    const alertasAnchor = overlay.querySelector('#ed_stock_alertas_anchor');
    const alertasNota   = overlay.querySelector('#ed_stock_alertas_nota');
    const hintVarAlerta = overlay.querySelector('#ed_stock_hint_var');
    const inStockMin    = overlay.querySelector('#ed_stock_min');
    const inStockMax    = overlay.querySelector('#ed_stock_max');
    const stockVincAviso = overlay.querySelector('#ed_stock_vinculo_aviso');
    const stockVincValor = overlay.querySelector('#ed_stock_vinculo_valor');

    // ── Avisar por caja / pack / rollo ───────────────────────────────────────
    // Los umbrales viajan siempre en unidades (el POS y el resto de la webapp
    // los leen así); acá sólo se elige con qué unidad se escriben y se muestran.
    const selAlertaUM   = overlay.querySelector('#ed_alerta_um');
    const bultoCfg      = overlay.querySelector('#ed_bulto_cfg');
    const selBultoTipo  = overlay.querySelector('#ed_bulto_tipo');
    const inBultoCont   = overlay.querySelector('#ed_bulto_contenido');
    const lblBultoTipo  = overlay.querySelector('#ed_bulto_tipo_lbl');
    const bultoHint     = overlay.querySelector('#ed_bulto_hint');

    selBultoTipo.innerHTML = Object.entries(TIPOS_BULTO)
      .map(([k, v]) => `<option value="${k}">${v.sg.charAt(0).toUpperCase() + v.sg.slice(1)}</option>`).join('');

    // Bulto sugerido al abrir: lo guardado, el contenedor del conjunto, o lo que
    // se pueda deducir del nombre ("CAJA X 12", "X 24 UN", "DOCENA").
    const _bultoInicial = bultoDe(prod);
    let _bultoDetectado = _bultoInicial;
    if (_bultoInicial) {
      selBultoTipo.value = TIPOS_BULTO[_bultoInicial.tipo] ? _bultoInicial.tipo : 'caja';
      inBultoCont.value  = _bultoInicial.contenido;
    }
    selAlertaUM.value = (prod.stock_alerta_um === 'bulto' && _bultoInicial) ? 'bulto' : 'unidad';

    // Bulto según lo que hay en pantalla ahora mismo (conjunto activo manda:
    // su contenido es la fuente de verdad y se sincroniza solo).
    function _bultoActual() {
      if (cbConj.checked) {
        const cont = parseFloat((conjC?.value || '').trim());
        if (cont > 1) {
          const tipoConj = conjTipo?.value || '';
          const virtual = bultoDe({ es_conjunto: true, conjunto_contenido: cont, conjunto_tipo: tipoConj });
          if (virtual) return virtual;
        }
        return null;
      }
      const cont = parseFloat((inBultoCont.value || '').trim());
      if (!(cont > 1)) return null;
      const tipo = selBultoTipo.value || 'caja';
      return { tipo, contenido: cont, fuente: 'manual', ...labelTipo(tipo) };
    }

    function _refrescarBulto() {
      const porBulto = selAlertaUM.value === 'bulto';
      const esConj   = cbConj.checked;
      const b        = _bultoActual();
      // Con Conjunto activo el contenido ya se carga arriba: no se duplica el campo.
      bultoCfg.style.display = (porBulto && !esConj) ? 'flex' : 'none';
      if (b) lblBultoTipo.textContent = b.sg.toUpperCase();

      if (!porBulto) {
        bultoHint.innerHTML = _bultoDetectado && !esConj
          ? `Detectado: <b>1 ${_bultoDetectado.sg} = ${_bultoDetectado.contenido} u</b>. Cambiá a "Cajas / packs" para escribir el mínimo en ${_bultoDetectado.pl}.`
          : 'Los umbrales de arriba están en unidades sueltas.';
        bultoHint.style.color = 'var(--text-muted)';
        return;
      }
      if (!b) {
        bultoHint.innerHTML = esConj
          ? 'Cargá el <b>contenido</b> del conjunto arriba (unidades por envase) para poder avisar por envase.'
          : 'Indicá cuántas unidades trae la caja para poder avisar por caja.';
        bultoHint.style.color = 'var(--tint-orange-fg)';
        return;
      }
      const min = parseFloat((inStockMin.value || '').replace(',', '.'));
      const max = parseFloat((inStockMax.value || '').replace(',', '.'));
      const partes = [`1 ${b.sg} = <b>${b.contenido}</b> u.`];
      if (min > 0) partes.push(`Avisa cuando queden <b>${min} ${min === 1 ? b.sg : b.pl}</b> (${aUnidades(min, b)} u).`);
      if (max > 0) partes.push(`Ideal <b>${max} ${max === 1 ? b.sg : b.pl}</b> (${aUnidades(max, b)} u).`);
      bultoHint.innerHTML = partes.join(' ');
      bultoHint.style.color = 'var(--tint-green-fg)';
    }

    // Al cambiar de unidad se convierten los valores ya escritos, para que el
    // usuario no tenga que recalcular de cabeza.
    let _umPrevio = selAlertaUM.value;
    selAlertaUM.addEventListener('change', () => {
      const b = _bultoActual();
      const nuevo = selAlertaUM.value;
      if (b && nuevo !== _umPrevio) {
        const conv = (el) => {
          const v = parseFloat((el.value || '').replace(',', '.'));
          if (!(v > 0)) return;
          const r = nuevo === 'bulto' ? aBultos(v, b) : aUnidades(v, b);
          el.value = Math.round(r * 100) / 100;
        };
        conv(inStockMin);
        conv(inStockMax);
      }
      _umPrevio = nuevo;
      _refrescarBulto();
    });
    [inBultoCont, selBultoTipo].forEach(el => el.addEventListener('input', () => {
      _bultoDetectado = _bultoActual() || _bultoDetectado;
      _refrescarBulto();
    }));
    [inStockMin, inStockMax].forEach(el => el.addEventListener('input', _refrescarBulto));

    // Los umbrales están guardados en unidades: si el producto avisa por bulto,
    // se muestran convertidos a cajas/packs al abrir el editor.
    if (selAlertaUM.value === 'bulto' && _bultoInicial) {
      [inStockMin, inStockMax].forEach(el => {
        const v = parseFloat((el.value || '').replace(',', '.'));
        if (v > 0) el.value = Math.round(aBultos(v, _bultoInicial) * 100) / 100;
      });
    }
    _refrescarBulto();

    // Margen del 15% al detalle aplicado al precio por unidad sugerido.
    // Ej: caja $8000 con 12 unidades → ($8000 / 12) × 1.15 = $766,67 por unidad.
    const FRACCION_MARGIN = 1.15;
    // Trackeo si el usuario tocó manualmente el precio por unidad. Si lo hizo,
    // dejamos de auto-calcular para no pisar su valor.
    let precioPUManual = !!(prod.conjunto_precio_unidad && Number(prod.conjunto_precio_unidad) > 0);
    if (conjPU) {
      conjPU.addEventListener('input', () => {
        precioPUManual = (conjPU.value.trim() !== '');
      });
      // Doble-click sobre el hint vuelve al modo automático (vacía el campo)
      if (conjHint) {
        conjHint.style.cursor = 'pointer';
        conjHint.title = 'Doble-click para volver al cálculo automático';
        conjHint.addEventListener('dblclick', () => {
          conjPU.value = '';
          precioPUManual = false;
          _refrescarConjunto();
        });
      }
    }

    // [plural, singular, género ('m'|'f')]. El género se usa para concordar adjetivos
    // como "ENTERAS"/"ENTEROS", "ABIERTA"/"ABIERTO" en las etiquetas dinámicas.
    const NOMBRES_TIPO = {
      rollo:     ['ROLLOS','ROLLO','m'],
      pack:      ['PACKS','PACK','m'],
      caja:      ['CAJAS','CAJA','f'],
      bobina:    ['BOBINAS','BOBINA','f'],
      bolsa:     ['BOLSAS','BOLSA','f'],
      plancha:   ['PLANCHAS','PLANCHA','f'],
      cartulina: ['CARTULINAS','CARTULINA','f'],
      papel:     ['HOJAS','HOJA','f'],
      carton:    ['CARTONES','CARTÓN','m'],
      goma_eva:  ['PLANCHAS','PLANCHA','f'],
      cinta:     ['ROLLOS','ROLLO','m'],
      tela:      ['ROLLOS','ROLLO','m'],
      unidad:    ['UNIDADES','UNIDAD','f'],
      otro:      ['UNIDADES','UNIDAD','f'],
    };

    // El campo "sueltas en X abierta" sí tiene sentido también cuando UM=unidades:
    // un pack de 15 lápices puede tener 7 sueltos del pack abierto. Por eso lo
    // mostramos siempre (mientras haya contenido > 1).
    function _aplicarVisibilidadFraccion() {
      const wrapR = conjR ? conjR.parentElement : null;
      if (wrapR) wrapR.style.display = '';
    }

    function _refrescarConjunto() {
      const [pl, sg, gen] = NOMBRES_TIPO[conjTipo.value] || NOMBRES_TIPO.otro;
      const um = conjUM.value || 'unidades';
      const umSg = um.endsWith('s') ? um.slice(0, -1) : um;
      const esUnidad = um === 'unidades';
      // Concordancia gramatical: "CAJAS ENTERAS" vs "ROLLOS ENTEROS",
      // "CAJA ABIERTA" vs "ROLLO ABIERTO", "SUELTAS" vs "SUELTOS".
      const enteros = gen === 'f' ? 'ENTERAS' : 'ENTEROS';
      const abierto = gen === 'f' ? 'ABIERTA' : 'ABIERTO';
      const sueltos = gen === 'f' ? 'SUELTAS' : 'SUELTOS';
      const elAbierto = gen === 'f' ? 'la abierta' : 'el abierto';
      // Labels del bloque de inputs ("CAJAS ENTERAS", "UNIDADES POR CAJA", etc.)
      lblTitU.innerHTML    = `${pl} ${enteros} <span style="font-weight:500">(sin contar ${elAbierto})</span>`;
      lblTitC.textContent  = `${um.toUpperCase()} POR ${sg}`;
      lblTitR.innerHTML    = `${um.toUpperCase()} ${sueltos} EN ${sg} ${abierto} <span style="color:var(--text-muted);font-weight:500">(opcional)</span>`;
      lblTitPU.innerHTML   = `PRECIO POR ${umSg.toUpperCase()} <span style="color:var(--text-muted);font-weight:500">(auto)</span>`;
      // Los umbrales de alerta se expresan en la misma unidad de medida.
      if (typeof _aplicarEtiquetasAlertaStock === 'function') _aplicarEtiquetasAlertaStock(cbConj.checked);
      _aplicarVisibilidadFraccion();
      const u = parseFloat(conjU.value) || 0;
      const c = parseFloat(conjC.value) || 0;
      const r = parseFloat(conjR.value) || 0;
      const precioPack = parseFloat(inPrecio.value) || 0;
      const precioU    = parseFloat(conjPU && conjPU.value) || 0;

      // Texto del resumen (versión corta para el campo viejo + versión grande arriba)
      let resumenCorto = '';
      let resumenLargo = '';
      // Si hay variedades, el total se calcula sumando por variedad (cada una
      // puede tener su propio contenido y/o sueltos). Si no, fórmula clásica.
      // Guard: en el primer render, _getColoresFromUI puede no estar disponible
      // todavía (TDZ sobre `coloresList`). Capturamos errores para no romper la UI.
      let variedadesUI = [];
      try {
        if (typeof _getColoresFromUI === 'function') variedadesUI = _getColoresFromUI();
      } catch (_e) {
        variedadesUI = [];
      }
      const hayVariedades = variedadesUI.length > 0;

      if (hayVariedades) {
        let total = 0;
        const lineasVar = variedadesUI.map(v => {
          const vu = Number(v.unidades) || 0;
          const vr = Number(v.restante) || 0;
          const vc = (Number(v.contenido) > 0) ? Number(v.contenido) : c;
          const cerr = Math.max(0, vu);
          const t = cerr * vc + vr;
          total += t;
          return { nombre: v.color, cerr, vc, vr, t };
        });
        resumenCorto = `<b>Total disponible:</b> <b style="color:var(--tint-purple-fg)">${total.toLocaleString('es-AR')} ${um}</b> · ${variedadesUI.length} ${variedadesUI.length === 1 ? 'variedad' : 'variedades'}`;
        const detalleHtml = lineasVar.map(L =>
          `<div style="font-size:12px;color:var(--text-muted)"><b>${_escHtml(L.nombre)}:</b> ${L.cerr} × ${L.vc} ${um}${L.vr > 0 ? ` + ${L.vr} ${sueltos.toLowerCase()}` : ''} = <b style="color:var(--text-strong)">${L.t} ${um}</b></div>`
        ).join('');
        resumenLargo =
          `<div style="font-size:12px;color:var(--tint-purple-fg);font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Tenés disponible</div>` +
          `<div style="font-size:18px;font-weight:800;color:var(--text-strong)">${total.toLocaleString('es-AR')} ${um}</div>` +
          (detalleHtml ? `<div style="margin-top:6px;display:flex;flex-direction:column;gap:2px">${detalleHtml}</div>` : '');
      } else if (u > 0 && c > 0) {
        const cerrados = Math.max(0, u);
        const totalCerrados = cerrados * c;
        const total = totalCerrados + r;
        const detalleR = r > 0 ? ` + ${r} ${um} ${sueltos.toLowerCase()} en ${sg.toLowerCase()} ${abierto.toLowerCase()}` : '';
        resumenCorto = `<b>Total disponible:</b> ${cerrados} ${cerrados === 1 ? sg.toLowerCase() : pl.toLowerCase()} × ${c} ${um}${detalleR} = <b style="color:var(--tint-purple-fg)">${total.toLocaleString('es-AR')} ${um}</b>`;
        const partes = [];
        if (cerrados > 0) partes.push(`<b>${cerrados}</b> ${cerrados === 1 ? sg.toLowerCase() : pl.toLowerCase()} × <b>${c}</b> ${um}`);
        if (r > 0)        partes.push(`<b>${r}</b> ${um} ${sueltos.toLowerCase()} en ${sg.toLowerCase()} ${abierto.toLowerCase()}`);
        const desglose = partes.join(' + ');
        const lineasPrecio = [];
        if (precioPack > 0) lineasPrecio.push(`Precio ${sg.toLowerCase()}: <b>$${precioPack.toLocaleString('es-AR')}</b>`);
        if (precioU    > 0) lineasPrecio.push(`Precio ${umSg}: <b>$${precioU.toLocaleString('es-AR', {minimumFractionDigits:2, maximumFractionDigits:2})}</b>`);
        const lineaPrecio = lineasPrecio.length
          ? `<div style="margin-top:6px;color:var(--text-muted)">${lineasPrecio.join(' &nbsp;·&nbsp; ')}</div>`
          : '';
        resumenLargo =
          `<div style="font-size:12px;color:var(--tint-purple-fg);font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Tenés disponible</div>` +
          `<div style="font-size:18px;font-weight:800;color:var(--text-strong)">${total.toLocaleString('es-AR')} ${um}</div>` +
          (desglose ? `<div style="margin-top:2px;color:var(--text-muted);font-size:12.5px">${desglose}</div>` : '') +
          lineaPrecio;
      } else {
        resumenCorto = 'Completá los campos para ver el total';
        resumenLargo = `<div style="color:var(--text-muted)">Completá <b>${pl.toLowerCase()} ${enteros.toLowerCase()}</b> y <b>${um} por ${sg.toLowerCase()}</b> para ver el total disponible.</div>`;
      }
      conjRes.innerHTML = resumenCorto;
      if (conjResTop) conjResTop.innerHTML = resumenLargo;

      // ── Auto-calcular precio por unidad ──
      // Aplica también al modo "unidades": una caja con 80 lápices a $5000
      // sugiere $5000 / 80 × 1.15 = $71.88 por unidad.
      // Excepción: si TIPO === 'unidad', no se aplica el 15% extra (la venta es
      // directa por unidad, sin margen al detalle).
      if (conjPU && conjHint) {
        const esTipoUnidad  = conjTipo.value === 'unidad';
        const margen        = esTipoUnidad ? 1 : FRACCION_MARGIN;
        const precioPaquete = parseFloat(inPrecio.value) || 0;
        const contenido     = c;
        if (precioPaquete > 0 && contenido > 0) {
          const sugerido = (precioPaquete / contenido) * margen;
          const sugeridoTxt = sugerido.toLocaleString('es-AR', {
            minimumFractionDigits: 2, maximumFractionDigits: 2,
          });
          if (!precioPUManual) {
            conjPU.value = sugerido.toFixed(2);
          }
          const formula = esTipoUnidad
            ? `(${sg.toLowerCase()} $${precioPaquete.toLocaleString('es-AR')} ÷ ${contenido} ${um}, sin 15% detalle).`
            : `(${sg.toLowerCase()} $${precioPaquete.toLocaleString('es-AR')} ÷ ${contenido} ${um} × 1.15).`;
          conjHint.innerHTML =
            `<b>Sugerido:</b> $${sugeridoTxt}/${umSg} ` +
            formula + `<br/>` +
            (precioPUManual
              ? '<span style="color:var(--tint-orange-fg)">Estás usando un precio manual.</span> '
                + 'Doble-click acá para volver al cálculo automático.'
              : 'Editalo si querés un precio distinto.');
        } else {
          const formulaHint = esTipoUnidad
            ? `<b>precio ÷ ${um}</b> (sin 15 % adicional, venta por unidad)`
            : `<b>precio ÷ ${um} × 1.15</b> (15 % margen al detalle)`;
          conjHint.innerHTML =
            `Cargá <b>precio del ${sg.toLowerCase()}</b> y <b>${um} por ${sg.toLowerCase()}</b> ` +
            `para que se calcule automáticamente como ${formulaHint}.`;
        }
      }
    }

    // Mueve el bloque costo/margen/precio entre su "home" (afuera, modo simple)
    // y el anchor adentro del cuadro Conjunto. Renombra labels acorde.
    const precioBlock  = overlay.querySelector('#ed_precio_block');
    const precioHome   = overlay.querySelector('#ed_precio_home');
    const precioAnchor = overlay.querySelector('#ed_precio_block_anchor');
    const lblEdCosto   = overlay.querySelector('#lbl_ed_costo');
    const lblEdPrecio  = overlay.querySelector('#lbl_ed_precio');
    const btnRedondear = overlay.querySelector('#btn_redondear');
    function _aplicarUbicacionPrecio(on) {
      if (on) {
        if (precioBlock.parentElement !== precioAnchor) precioAnchor.appendChild(precioBlock);
        if (lblEdCosto)  lblEdCosto.textContent  = 'COSTO DEL PACK $';
        if (lblEdPrecio) lblEdPrecio.textContent = 'PRECIO DEL PACK $';
      } else {
        if (precioBlock.parentElement !== precioHome) precioHome.appendChild(precioBlock);
        if (lblEdCosto)  lblEdCosto.textContent  = 'COSTO $';
        if (lblEdPrecio) lblEdPrecio.textContent = 'PRECIO VENTA $';
      }
    }

    // Cuando el conjunto está activo y "Mismo precio del pack" está OFF, el
    // bloque de costo/margen/precio queda readonly+gris: el precio se carga
    // por variedad abajo. Cuando está ON (o no aplica), queda editable normal.
    // Además, en modo per-variedad ocultamos los globales que ya no aplican:
    // "Unidades por pack" y "Precio por unidad" (cada variedad tiene los suyos).
    function _aplicarEstadoPrecioGlobal() {
      const conjOn = !!cbConj.checked;
      // Query directo en cada llamada para evitar TDZ (esta función puede correr
      // antes de la declaración de cbMismoPrecio en la función abrirEditor).
      const cbMP   = overlay.querySelector('#ed_colores_mismo_precio');
      const mismo  = cbMP ? !!cbMP.checked : true;
      const disabled = conjOn && !mismo;
      const inputs = [inCosto, inMargen, inPrecio];
      inputs.forEach(inp => {
        if (!inp) return;
        inp.readOnly = disabled;
        inp.style.background = disabled ? 'var(--surface-2)' : '';
        inp.style.color      = disabled ? 'var(--text-muted)' : '';
        inp.style.cursor     = disabled ? 'not-allowed' : '';
        inp.title = disabled ? 'Cargá el precio en cada variedad de abajo' : '';
        // El precio venta tiene borde azul para destacarlo. Cuando se desactiva
        // (modo per-variedad) lo igualamos al gris de los otros para que se vea
        // claramente que está bloqueado.
        if (inp === inPrecio) {
          inp.style.borderColor = disabled ? '#e4e6eb' : '#1877f2';
          inp.style.fontWeight  = disabled ? '400' : '700';
        }
      });
      if (btnRedondear) {
        btnRedondear.disabled = disabled;
        btnRedondear.style.opacity = disabled ? '0.4' : '';
        btnRedondear.style.cursor  = disabled ? 'not-allowed' : 'pointer';
      }
      // Ocultar inputs globales redundantes en modo per-variedad
      const wrapContenido    = conjC  ? conjC.parentElement  : null;
      const wrapPrecioUnidad = conjPU ? conjPU.parentElement?.parentElement : null;
      if (wrapContenido)    wrapContenido.style.display    = disabled ? 'none' : '';
      if (wrapPrecioUnidad) wrapPrecioUnidad.style.display = disabled ? 'none' : '';
    }

    // Etiquetas de STOCK MÍN./MÁX.: en un conjunto los umbrales se comparan
    // contra el total disponible (unidades/metros/…), así que aclaramos la
    // unidad en el label y en el hint para que no se confunda con "cajas".
    function _aplicarEtiquetasAlertaStock(on) {
      const um = on ? (conjUM.value || 'unidades') : '';
      const suf = on
        ? ` <span style="color:var(--tint-purple-fg);font-weight:600;text-transform:none;letter-spacing:0">en ${um}</span>`
        : '';
      if (lblStockMin) lblStockMin.innerHTML = 'STOCK MÍN. (avisar)' + suf;
      if (lblStockMax) lblStockMax.innerHTML = 'STOCK MÁX. (ideal)' + suf;
      if (stockAlertaUM && on) stockAlertaUM.textContent = um;
    }

    // ¿Hay filas de variedad cargadas? Se consulta desde funciones que corren
    // antes de que `coloresList` esté inicializado (TDZ), de ahí el try/catch.
    function _hayVariedadesUI() {
      try {
        return coloresList.querySelectorAll('[data-color-row]').length > 0;
      } catch (_e) {
        return false;
      }
    }

    // Ubicación y visibilidad del bloque STOCK MÍN./MÁX. del producto:
    //   · Conjunto OFF        → junto al campo STOCK (su "home"), arriba.
    //   · Conjunto ON         → al final del cuadro Conjunto, para no scrollear.
    //   · Con variedades      → se oculta: el aviso va por fila. Si el producto
    //                           ya tenía un umbral global cargado se deja visible
    //                           (no escondemos un valor que sigue alertando).
    //   · Vinculado sin conj. → oculto, el stock sale del producto fuente.
    function _aplicarUbicacionAlertas(on, tieneVinc) {
      if (!alertasBlock) return;
      const conVariedades = on && _hayVariedadesUI();
      const tieneUmbral = !!((inStockMin && inStockMin.value.trim()) || (inStockMax && inStockMax.value.trim()));
      const ocultarPorVariedad = conVariedades && !tieneUmbral;
      const destino = on ? alertasAnchor : alertasHome;
      if (destino && alertasBlock.parentElement !== destino) destino.appendChild(alertasBlock);
      alertasBlock.style.display = ((!on && tieneVinc) || ocultarPorVariedad) ? 'none' : 'flex';
      if (alertasAnchor)  alertasAnchor.style.display  = on ? 'block' : 'none';
      if (alertasNota)    alertasNota.style.display    = ocultarPorVariedad ? 'block' : 'none';
      if (hintVarAlerta)  hintVarAlerta.style.display  = (conVariedades && tieneUmbral) ? 'inline' : 'none';
    }

    function _aplicarVisibilidadConjunto() {
      const on = cbConj.checked;
      // Producto vinculado a otro de stock: tampoco lleva stock propio.
      const tieneVinc = (typeof _getProdVincs === 'function') && _getProdVincs().length > 0;
      conjBox.style.display    = on ? 'grid'  : 'none';
      if (conjResTop)  conjResTop.style.display  = on ? 'block' : 'none';
      // Conjunto: el STOCK se calcula del desglose, así que ese bloque se oculta
      // y MÍN./MÁX. se mudan al final del cuadro Conjunto (alertan sobre el total
      // disponible). Vinculado y NO conjunto: el stock sale del producto fuente
      // → se oculta todo, incluidas las alertas.
      if (stockBloque) stockBloque.style.display = (on || tieneVinc) ? 'none' : 'flex';
      _aplicarUbicacionAlertas(on, tieneVinc);
      if (stockHint)   stockHint.style.display   = on ? 'none'  : '';
      if (stockHintC)  stockHintC.style.display  = on ? 'block' : 'none';
      _aplicarEtiquetasAlertaStock(on);
      // Aviso de vínculo: solo cuando hay vínculo y NO es conjunto.
      if (stockVincAviso) stockVincAviso.style.display = (!on && tieneVinc) ? 'block' : 'none';
      // Vinculado a producto: visible siempre. En conjuntos sin variedades
      // funciona a nivel producto; si hay variedades, prioridad al vínculo
      // per-variedad (el watcher lo decide).
      _aplicarUbicacionPrecio(on);
      _aplicarEstadoPrecioGlobal();
      _refrescarBulto();
    }
    cbConj.addEventListener('change', () => {
      _aplicarVisibilidadConjunto();
      if (cbConj.checked) _refrescarConjunto();
    });
    // Si el producto tiene variedades y el usuario vacía el umbral global, el
    // bloque desaparece (queda solo el mínimo por fila). Se evalúa al salir del
    // campo para no ocultarlo mientras se está tipeando.
    [inStockMin, inStockMax].forEach(inp => {
      if (!inp) return;
      inp.addEventListener('change', () => _aplicarVisibilidadConjunto());
    });
    // Estado inicial (cuando el producto ya viene marcado como conjunto)
    _aplicarVisibilidadConjunto();
    [conjTipo, conjUM, conjU, conjC, conjR].forEach(el => el.addEventListener('input', _refrescarConjunto));
    // El contenido del envase es el que manda para avisar por envase.
    [conjTipo, conjC].forEach(el => el.addEventListener('input', _refrescarBulto));
    // Cuando cambia la unidad de medida, reaplicar el layout de las variedades
    // (con/sin "Restante") y refrescar el agregado.
    conjUM.addEventListener('change', () => {
      if (typeof _aplicarUnidadATodasVariedades === 'function') {
        _aplicarUnidadATodasVariedades();
      }
      _refreshColoresState();
    });
    // Cuando cambia el TIPO (rollo/pack/.../unidad), la fórmula del precio
    // por unidad cambia (15% al detalle vs sin 15% si tipo='unidad'). Forzamos
    // recalcular para que los precios viejos guardados con la otra fórmula no
    // queden "pegados" como manual. El usuario puede volver a ponerlo manual
    // si quiere (editando el input).
    conjTipo.addEventListener('change', () => {
      precioPUManual = false;
      if (conjPU) conjPU.value = '';
      coloresList.querySelectorAll('[data-color-row]').forEach(row => {
        row.dataset.precioUnitManual = '0';
      });
      _refrescarConjunto();
      _refreshColoresState();
    });
    // El precio del rollo y el campo de precio por unidad también disparan recalculo
    if (inPrecio) inPrecio.addEventListener('input', _refrescarConjunto);
    if (conjPU)   conjPU.addEventListener('input', _refrescarConjunto);
    if (cbConj.checked) _refrescarConjunto();

    // ── Stock por color ───────────────────────────────────────────────
    const coloresList   = overlay.querySelector('#ed_colores_list');
    const coloresEmpty  = overlay.querySelector('#ed_colores_empty');
    const btnAddColor   = overlay.querySelector('#btn_add_color');
    const togglePrecioWrap = overlay.querySelector('#ed_colores_toggle_wrap');
    const cbMismoPrecio    = overlay.querySelector('#ed_colores_mismo_precio');

    // ── Buscador de variedades ────────────────────────────────────────
    // Aparece solo cuando hay suficientes variedades como para que valga la
    // pena filtrar. Filtra por nombre con un fundido limpio fila por fila.
    const VAR_SEARCH_MIN = 5;
    const buscarVarWrap  = overlay.querySelector('#ed_colores_buscar_wrap');
    const buscarVarInp   = overlay.querySelector('#ed_colores_buscar');
    const buscarVarCount = overlay.querySelector('#ed_colores_buscar_count');
    const buscarVarClear = overlay.querySelector('#ed_colores_buscar_clear');
    const buscarVarEmpty = overlay.querySelector('#ed_colores_sin_match');

    // ── Aviso de variedades repetidas ─────────────────────────────────
    const dupWarn   = overlay.querySelector('#ed_colores_dup_warn');
    const dupMsg    = overlay.querySelector('#ed_colores_dup_msg');
    const dupFixBtn = overlay.querySelector('#ed_colores_dup_fix');

    // Ajusta el ancho del campo de nombre al texto: chico para nombres cortos,
    // crece con el contenido y frena en un máximo (el resto lo cubre el tooltip).
    function _autosizeNombre(inp) {
      const len = (inp.value || inp.placeholder || '').length;
      const ch = Math.min(Math.max(len + 1, 7), 30);
      inp.style.width = ch + 'ch';
    }

    function _filtrarVariedades() {
      const f = (buscarVarInp.value || '').toLowerCase().trim();
      const rows = coloresList.querySelectorAll('[data-color-row]');
      let visibles = 0;
      rows.forEach(row => {
        const nombre = (row.querySelector('.ed_color_nombre')?.value || '').toLowerCase();
        const match = !f || nombre.includes(f);
        if (match) {
          row.style.display = 'flex';
          visibles++;
        } else {
          row.style.display = 'none';
        }
      });
      buscarVarClear.style.display = f ? 'flex' : 'none';
      buscarVarCount.textContent = f ? `${visibles} de ${rows.length}` : `${rows.length}`;
      buscarVarEmpty.style.display = (f && visibles === 0) ? 'flex' : 'none';
    }

    buscarVarInp.addEventListener('input', _filtrarVariedades);
    buscarVarClear.addEventListener('click', () => {
      buscarVarInp.value = '';
      _filtrarVariedades();
      buscarVarInp.focus();
    });

    // Convención de colores para los inputs de variedad:
    // - NARANJA (USER): el usuario tiene que completar (Costo, Margen, U/pack)
    // - BLANCO (AUTO):  se completa solo a partir de los anteriores (Pack, Unit)
    // - VERDE  (MANUAL): tiene un valor cargado por el usuario
    const STYLE_USER   = 'border:1.5px solid var(--border);background:var(--tint-orange-bg)';   // naranja: completar
    const STYLE_AUTO   = 'border:1.5px solid var(--border);background:var(--surface)';     // blanco: automático
    const STYLE_MANUAL = 'border:1.5px solid #16a34a;background:var(--surface)';     // verde: manual

    function _aplicarEstiloAutoManual(input, kind = 'user') {
      // kind: 'user'  → naranja vacío / verde lleno
      //       'auto'  → blanco vacío / verde lleno
      // Modificamos sólo borde/fondo, dejando width/padding/font-size que cada
      // input ya trae en su style inline (importante para el layout de una sola
      // línea de las variedades, donde cada input tiene un ancho fijo distinto).
      const tieneValor = (input.value || '').trim() !== '';
      let border, bg;
      if (tieneValor) {
        border = '1.5px solid var(--tint-green-fg)';
        bg = 'var(--surface)';
      } else if (kind === 'auto') {
        border = '1.5px solid var(--border)';
        bg = 'var(--surface)';
      } else {
        border = '1.5px solid var(--tint-orange-fg)';
        bg = 'var(--tint-orange-bg)';
      }
      input.style.border = border;
      input.style.background = bg;
      input.style.outline = 'none';
    }

    // Modal para elegir un producto fuente al cual descontar stock cuando se
    // vende este (variedad o producto). Devuelve {doc_id, nombre, cantidad}
    // o null si se canceló. Excluye `excludeId` para no vincularse a sí mismo.
    function abrirVinculadorProducto(currentId = '', currentQty = '1', excludeId = '') {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2500;display:flex;align-items:center;justify-content:center;padding:12px';
        const panel = document.createElement('div');
        panel.style.cssText = 'background:var(--surface);border-radius:14px;width:min(560px,100%);max-height:80vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.2)';
        panel.innerHTML = `
          <div style="padding:14px 18px;background:#1565c0;color:#fff;display:flex;align-items:center;gap:10px">
            <span class="material-icons">link</span>
            <div style="flex:1">
              <div style="font-size:15px;font-weight:700">Vincular a producto de stock</div>
              <div style="font-size:11.5px;opacity:0.85;margin-top:1px">Al vender este ítem, se descuenta del producto vinculado.</div>
            </div>
            <button id="vinc_close" style="background:transparent;border:none;color:#fff;cursor:pointer;padding:4px;line-height:1"><span class="material-icons">close</span></button>
          </div>
          <div style="padding:14px 18px;display:flex;flex-direction:column;gap:10px;border-bottom:1px solid var(--border)">
            <input id="vinc_buscar" type="text" placeholder="Buscar producto por nombre, código o marca..." autocomplete="off" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;box-sizing:border-box" />
            <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-muted)">
              <span>Cantidad a descontar por venta:</span>
              <input id="vinc_qty" type="number" min="0" step="any" value="${currentQty}" style="width:80px;padding:6px 10px;border:1.5px solid #1565c0;border-radius:8px;font-size:14px;font-weight:700;color:var(--tint-blue-fg);background:var(--tint-blue-bg);font-family:inherit;box-sizing:border-box" />
              <span style="color:var(--text-muted)">unidades</span>
            </div>
          </div>
          <div id="vinc_lista" style="flex:1;overflow-y:auto;padding:6px 8px"></div>
        `;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const buscarInp = panel.querySelector('#vinc_buscar');
        const qtyInp = panel.querySelector('#vinc_qty');
        const lista = panel.querySelector('#vinc_lista');
        let seleccionId = currentId || '';
        let seleccionNombre = '';

        function _close(result) { overlay.remove(); resolve(result); }
        panel.querySelector('#vinc_close').addEventListener('click', () => _close(null));
        overlay.addEventListener('click', e => { if (e.target === overlay) _close(null); });

        function renderResultados(filtro) {
          const f = (filtro || '').toLowerCase().trim();
          const candidatos = allProductos
            .filter(p => p.doc_id !== excludeId)
            .filter(p => {
              if (!f) return true;
              const blob = ((p.nombre || '') + ' ' + (p.codigo || '') + ' ' + (p.cod_barra || '') + ' ' + (p.marca || '')).toLowerCase();
              return blob.includes(f);
            })
            .slice(0, 80);

          if (candidatos.length === 0) {
            lista.innerHTML = '<div style="text-align:center;padding:30px 12px;color:var(--text-muted);font-size:13px">Sin resultados.</div>';
            return;
          }
          lista.innerHTML = candidatos.map(p => {
            const selected = p.doc_id === seleccionId;
            const stock = Number(p.stock) || 0;
            const stockBadge = stock === -1
              ? '<span style="background:var(--tint-purple-bg);color:var(--tint-purple-fg);padding:2px 6px;border-radius:6px;font-size:10.5px;font-weight:600">∞</span>'
              : `<span style="background:${stock <= 0 ? 'var(--tint-red-bg)' : 'var(--bg)'};color:${stock <= 0 ? 'var(--tint-red-fg)' : 'var(--text)'};padding:2px 6px;border-radius:6px;font-size:10.5px;font-weight:600">${stock}</span>`;
            return `
              <button type="button" data-doc="${p.doc_id}" data-nombre="${(p.nombre || '').replace(/"/g, '&quot;')}" class="vinc-row" style="
                width:100%;text-align:left;background:${selected ? 'var(--tint-blue-bg)' : 'var(--surface)'};
                border:1.5px solid ${selected ? '#1565c0' : '#e4e6eb'};
                border-radius:10px;padding:8px 10px;margin:4px 2px;cursor:pointer;
                display:flex;align-items:center;gap:10px;font-family:inherit
              ">
                <span class="material-icons" style="color:${selected ? 'var(--tint-blue-fg)' : 'var(--text-muted)'};font-size:18px">${selected ? 'check_circle' : 'inventory_2'}</span>
                <div style="flex:1;min-width:0">
                  <div style="font-size:13px;font-weight:700;color:var(--text)">${p.nombre || '(sin nombre)'}</div>
                  <div style="font-size:11px;color:var(--text-muted);margin-top:1px">
                    ${p.codigo ? `#${p.codigo} · ` : ''}${p.marca || 'SIN MARCA'} · ${p.rubro || 'sin rubro'}
                  </div>
                </div>
                ${stockBadge}
              </button>
            `;
          }).join('');
          lista.querySelectorAll('.vinc-row').forEach(btn => {
            btn.addEventListener('click', () => {
              seleccionId = btn.dataset.doc;
              seleccionNombre = btn.dataset.nombre;
              const qty = parseFloat(qtyInp.value) || 1;
              _close({ doc_id: seleccionId, nombre: seleccionNombre, cantidad: qty });
            });
          });
        }

        renderResultados('');
        let _t = null;
        buscarInp.addEventListener('input', () => {
          clearTimeout(_t);
          _t = setTimeout(() => renderResultados(buscarInp.value), 80);
        });
        setTimeout(() => buscarInp.focus(), 50);
      });
    }

    function _addColorRow(nombre = '', unidades = '', restante = '', precio = '', contenido = '', precioPack = '', costo = '', margen = '', codigo = '', stockMin = '', stockMax = '', vinculaciones = [], stockMinUm = '') {
      const row = document.createElement('div');
      row.dataset.colorRow = '1';
      // Preservamos el código existente (si lo trae) sin UI: el campo se sacó
      // para ahorrar espacio, pero no queremos perder los códigos ya cargados
      // al guardar. Si la variedad no tenía código, queda vacío.
      if (codigo) row.dataset.codigo = codigo;
      row.style.cssText = 'background:var(--surface);border:1.5px solid var(--border);border-radius:10px;padding:6px 6px;box-shadow:0 1px 2px rgba(0,0,0,0.03);display:flex;flex-direction:column;gap:4px';

      // Una sola línea con todos los campos. El bloque de PRECIO (costo, margen,
      // pack $, ±100) se oculta cuando el toggle "mismo precio" está activo.
      const linea = document.createElement('div');
      linea.style.cssText = 'display:flex;gap:3px;align-items:center;flex-wrap:nowrap';
      linea.innerHTML = `
        <input class="ed_color_nombre" type="text" placeholder="Variedad" value="${nombre || ''}" title="${(nombre || '').replace(/"/g, '&quot;')}" style="flex:0 1 auto;width:90px;min-width:70px;max-width:320px;padding:5px 6px;border:1.5px solid var(--border);border-radius:6px;font-size:11.5px;box-sizing:border-box;font-family:inherit;transition:width .12s ease" />
        <input class="ed_color_unidades" type="number" min="0" step="1" placeholder="Packs" title="Packs/rollos enteros de esta variedad" value="${unidades !== '' && unidades != null ? unidades : ''}" style="width:44px;padding:5px 4px;border:1.5px solid var(--border);border-radius:6px;font-size:11.5px;box-sizing:border-box;font-family:inherit" />
        <input class="ed_color_restante" type="number" min="0" step="0.01" placeholder="Sueltos" title="Sobrantes en el pack/rollo abierto de esta variedad" value="${restante !== '' && restante != null ? restante : ''}" style="width:48px;padding:5px 4px;border:1.5px solid var(--border);border-radius:6px;font-size:11.5px;box-sizing:border-box;font-family:inherit;background:var(--surface-2)" />
        <span data-sep="costo" style="width:1px;height:20px;background:var(--border);flex-shrink:0;margin:0 1px"></span>
        <input class="ed_color_costo" data-subrow="costo" type="number" min="0" step="0.01" placeholder="Costo" title="Costo por pack de esta variedad." value="${costo !== '' && costo != null ? costo : ''}" style="width:50px;padding:5px 4px;border-radius:6px;font-size:11.5px;box-sizing:border-box;font-family:inherit" />
        <input class="ed_color_margen" data-subrow="costo" type="number" min="0" step="1" placeholder="Marg%" title="Margen de ganancia por variedad. Vacío = hereda del margen global del producto." value="${margen !== '' && margen != null ? margen : ''}" style="width:44px;padding:5px 4px;border-radius:6px;font-size:11.5px;box-sizing:border-box;font-family:inherit" />
        <input class="ed_color_precio_pack" data-subrow="costo" type="number" min="0" step="0.01" placeholder="Pack $" title="Precio del pack. Auto = Costo × (1 + Margen). Naranja = auto, verde = manual." value="${precioPack !== '' && precioPack != null ? precioPack : ''}" style="width:52px;padding:5px 4px;border-radius:6px;font-size:11.5px;box-sizing:border-box;font-family:inherit" />
        <button type="button" class="ed_color_redondear_pack" data-subrow="costo" title="Redondear precio del pack al centena" style="width:28px;height:26px;padding:0;border-radius:5px;border:1.5px solid var(--border);background:var(--tint-orange-bg);cursor:pointer;font-size:9.5px;font-weight:700;color:var(--tint-orange-fg);line-height:1;flex-shrink:0">±100</button>
        <span style="width:1px;height:20px;background:var(--border);flex-shrink:0;margin:0 1px"></span>
        <input class="ed_color_contenido" type="number" min="0" step="0.01" placeholder="U/pack" title="Unidades por pack. Vinculado = sigue al global. Click en la cadena para desvincular." value="${contenido !== '' && contenido != null ? contenido : ''}" style="width:48px;padding:5px 4px;border-radius:6px;font-size:11.5px;box-sizing:border-box;font-family:inherit" />
        <button type="button" class="ed_color_link" title="Vinculado al valor global. Click para desvincular." style="width:22px;height:26px;padding:0;border-radius:5px;border:1.5px solid var(--border);background:var(--tint-purple-bg);cursor:pointer;color:var(--tint-purple-fg);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <span class="material-icons" style="font-size:13px">link</span>
        </button>
        <input class="ed_color_precio" type="number" min="0" step="0.01" placeholder="Unit. $" title="Precio por unidad. Auto = Pack ÷ U/pack × 1.15. Naranja = auto, verde = manual." value="${precio !== '' && precio != null ? precio : ''}" style="width:52px;padding:5px 4px;border-radius:6px;font-size:11.5px;box-sizing:border-box;font-family:inherit" />
        <button type="button" class="ed_color_redondear" title="Redondear precio unitario al centena" style="width:28px;height:26px;padding:0;border-radius:5px;border:1.5px solid var(--border);background:var(--tint-orange-bg);cursor:pointer;font-size:9.5px;font-weight:700;color:var(--tint-orange-fg);line-height:1;flex-shrink:0">±100</button>
        <button type="button" class="ed_color_remove" title="Quitar variedad" style="width:20px;height:20px;border-radius:50%;border:none;background:transparent;color:var(--tint-red-fg);cursor:pointer;font-size:16px;line-height:1;padding:0;flex-shrink:0;margin-left:1px">×</button>
      `;
      row.appendChild(linea);

      // Sub-fila: alertas de stock POR variedad (mín / máx propios).
      // Si la variedad no las tiene, hereda del global del producto.
      const alertaLinea = document.createElement('div');
      alertaLinea.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 4px 0;font-size:10.5px;color:var(--tint-orange-fg);flex-wrap:wrap';
      alertaLinea.innerHTML = `
        <span class="material-icons" style="font-size:13px;color:var(--tint-orange-fg)">notifications_active</span>
        <span style="font-weight:700;letter-spacing:0.3px">Stock mín</span>
        <input class="ed_color_stock_min" type="number" min="0" step="any" placeholder="—" title="Stock mínimo de esta variedad. Avisa cuando el total baja. Vacío = hereda del global." value="${stockMin !== '' && stockMin != null ? stockMin : ''}" style="width:56px;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-size:11px;box-sizing:border-box;font-family:inherit;background:var(--surface-2);color:var(--tint-orange-fg);font-weight:600" />
        <span style="font-weight:700;letter-spacing:0.3px">máx</span>
        <input class="ed_color_stock_max" type="number" min="0" step="any" placeholder="—" title="Stock máximo de esta variedad (ideal). Vacío = sin tope." value="${stockMax !== '' && stockMax != null ? stockMax : ''}" style="width:56px;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;font-size:11px;box-sizing:border-box;font-family:inherit;background:var(--surface-2);color:var(--tint-orange-fg);font-weight:600" />
        <button type="button" class="ed_color_stock_um" data-um="${stockMinUm === 'unidad' || stockMinUm === 'pack' ? stockMinUm : ''}" style="display:none;align-items:center;gap:3px;padding:3px 8px;border-radius:6px;border:1.5px solid var(--tint-orange-fg);background:var(--tint-orange-bg);color:var(--tint-orange-fg);font-size:10.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap">
          <span class="material-icons" style="font-size:12px">swap_horiz</span><span class="ed_color_stock_um_txt">packs</span>
        </button>
      `;
      row.appendChild(alertaLinea);

      // Alterna la unidad en la que se leen los mín/máx de esta variedad.
      alertaLinea.querySelector('.ed_color_stock_um').addEventListener('click', (ev) => {
        const btn = ev.currentTarget;
        btn.dataset.um = _umEfectivaFila(row) === 'pack' ? 'unidad' : 'pack';
        _refrescarUmAlertas();
      });

      // Sub-fila: VINCULAR A OTROS PRODUCTOS de stock (lista N elementos).
      // Cuando se vende esta variedad, el watcher de webapp descuenta unidades
      // de CADA producto vinculado (ej: vender 1 Impresión Color → -1 Hoja + -0.05 Tóner).
      const vincLinea = document.createElement('div');
      vincLinea.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 4px 0;font-size:10.5px;color:var(--tint-blue-fg);flex-wrap:wrap';
      // Estado: array de {doc_id, cantidad, nombre} serializado en dataset.
      const _vincsInitVar = (Array.isArray(vinculaciones) ? vinculaciones : [])
        .filter(v => v && v.doc_id && Number(v.cantidad) > 0)
        .map(v => ({ doc_id: v.doc_id, cantidad: Number(v.cantidad) || 1, nombre: v.nombre || '' }));
      row.dataset.vinculaciones = JSON.stringify(_vincsInitVar);
      vincLinea.innerHTML = `
        <span class="material-icons" style="font-size:13px;color:var(--tint-blue-fg)">link</span>
        <span style="font-weight:700;letter-spacing:0.3px">Vincul.:</span>
        <span class="ed_color_vinc_lista" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap"></span>
        <button type="button" class="ed_color_vinc_add" style="padding:3px 8px;border-radius:6px;border:1.5px solid var(--border);background:var(--tint-blue-bg);color:var(--tint-blue-fg);font-size:10.5px;font-weight:600;cursor:pointer;font-family:inherit">+ vincular</button>
      `;
      row.appendChild(vincLinea);

      const vincListaVar = vincLinea.querySelector('.ed_color_vinc_lista');
      const vincAddVar   = vincLinea.querySelector('.ed_color_vinc_add');

      function _getVarVincs() {
        try { return JSON.parse(row.dataset.vinculaciones || '[]'); } catch { return []; }
      }
      function _setVarVincs(arr) {
        row.dataset.vinculaciones = JSON.stringify(arr || []);
        _renderVarVincList();
      }
      function _renderVarVincList() {
        const arr = _getVarVincs();
        if (arr.length === 0) {
          vincListaVar.innerHTML = '<span style="color:var(--text-muted);font-size:10.5px">descontar stock de otros productos al vender</span>';
          return;
        }
        vincListaVar.innerHTML = arr.map((v, i) => `
          <span class="ed-var-vinc-item" data-idx="${i}" style="display:inline-flex;align-items:center;gap:3px;background:var(--tint-blue-bg);border:1px solid var(--border);border-radius:6px;padding:2px 4px 2px 8px;color:var(--tint-blue-fg);font-weight:600">
            → ${_escHtml((v.nombre || v.doc_id || '').slice(0, 24))}
            <span style="color:var(--tint-blue-fg)">×</span>
            <input class="ed-var-vinc-qty" type="number" min="0" step="any" value="${v.cantidad}" style="width:44px;padding:1px 3px;border:1px solid #1565c0;border-radius:4px;font-size:10.5px;font-weight:700;color:var(--tint-blue-fg);background:var(--surface);font-family:inherit;box-sizing:border-box" />
            <button type="button" class="ed-var-vinc-edit" title="Cambiar producto" style="background:transparent;border:none;cursor:pointer;color:var(--tint-blue-fg);font-size:11px;padding:0 2px">✎</button>
            <button type="button" class="ed-var-vinc-rm" title="Quitar" style="background:transparent;border:none;cursor:pointer;color:var(--tint-red-fg);font-size:14px;line-height:1;padding:0 2px">×</button>
          </span>
        `).join('');
        vincListaVar.querySelectorAll('.ed-var-vinc-item').forEach(chip => {
          const i = Number(chip.dataset.idx);
          chip.querySelector('.ed-var-vinc-qty').addEventListener('input', e => {
            const arr2 = _getVarVincs();
            if (!arr2[i]) return;
            arr2[i].cantidad = parseFloat(e.target.value.replace(',', '.')) || 0;
            row.dataset.vinculaciones = JSON.stringify(arr2);
          });
          chip.querySelector('.ed-var-vinc-edit').addEventListener('click', async () => {
            const arr2 = _getVarVincs();
            const cur = arr2[i] || {};
            const result = await abrirVinculadorProducto(cur.doc_id || '', cur.cantidad || '1', prod.doc_id);
            if (!result) return;
            arr2[i] = { doc_id: result.doc_id || '', cantidad: parseFloat(result.cantidad) || 1, nombre: result.nombre || '' };
            _setVarVincs(arr2);
          });
          chip.querySelector('.ed-var-vinc-rm').addEventListener('click', () => {
            const arr2 = _getVarVincs();
            arr2.splice(i, 1);
            _setVarVincs(arr2);
          });
        });
      }
      _renderVarVincList();

      vincAddVar.addEventListener('click', async () => {
        const result = await abrirVinculadorProducto('', '1', prod.doc_id);
        if (!result || !result.doc_id) return;
        const arr = _getVarVincs();
        if (arr.some(v => v.doc_id === result.doc_id)) {
          alertDialog({ title: 'Ya vinculado', message: 'Ese producto ya está vinculado a esta variedad.', type: 'info' });
          return;
        }
        arr.push({ doc_id: result.doc_id, cantidad: parseFloat(result.cantidad) || 1, nombre: result.nombre || '' });
        _setVarVincs(arr);
      });

      // Aplicar estilo según convención:
      // - 'user' (naranja): inputs que el cajero tiene que cargar.
      // - 'auto' (blanco):  inputs que se calculan a partir de los otros.
      const inpNombre      = linea.querySelector('.ed_color_nombre');
      const inpUnidades    = linea.querySelector('.ed_color_unidades');
      const inpRestante    = linea.querySelector('.ed_color_restante');
      const inpCosto       = linea.querySelector('.ed_color_costo');
      const inpMargen      = linea.querySelector('.ed_color_margen');
      const inpPrecioPack  = linea.querySelector('.ed_color_precio_pack');
      const inpContenido   = linea.querySelector('.ed_color_contenido');
      const inpPrecioUnit  = linea.querySelector('.ed_color_precio');
      const btnLinkContenido = linea.querySelector('.ed_color_link');
      [inpNombre, inpUnidades, inpRestante, inpCosto, inpMargen, inpContenido]
        .forEach(i => _aplicarEstiloAutoManual(i, 'user'));
      [inpPrecioPack, inpPrecioUnit].forEach(i => _aplicarEstiloAutoManual(i, 'auto'));

      // Mantener el filtro del buscador en sintonía cuando cambia el nombre,
      // el tooltip con el nombre completo y el ancho del campo según el texto.
      _autosizeNombre(inpNombre);
      inpNombre.addEventListener('input', () => {
        inpNombre.title = inpNombre.value;
        _autosizeNombre(inpNombre);
        _filtrarVariedades();
      });

      // Vincular UNIDAD al global: por defecto DESVINCULADO. El usuario tiene
      // que clickear la cadena explícitamente para que la fila siga al global.
      row.dataset.contenidoLinked = '0';

      function _aplicarContenidoLinked() {
        const linked = row.dataset.contenidoLinked === '1';
        const icon = btnLinkContenido.querySelector('.material-icons');
        if (linked) {
          const g = parseFloat(conjC.value) || 0;
          inpContenido.value = g > 0 ? g : '';
          inpContenido.readOnly = true;
          // Sólo cambiamos color/borde/fondo: el ancho/padding ya están en el
          // style inline original del input (no queremos pisarlo).
          inpContenido.style.border = '1.5px solid #c4b5fd';
          inpContenido.style.background = 'var(--tint-purple-bg)';
          inpContenido.style.color = 'var(--tint-purple-fg)';
          inpContenido.style.outline = 'none';
          icon.textContent = 'link';
          btnLinkContenido.style.background = 'var(--tint-purple-bg)';
          btnLinkContenido.style.borderColor = 'var(--tint-purple-fg)';
          btnLinkContenido.style.color = 'var(--tint-purple-fg)';
          btnLinkContenido.title = 'Vinculado al valor global. Click para desvincular.';
        } else {
          inpContenido.readOnly = false;
          inpContenido.style.color = '';
          // Re-aplicar el estilo user/manual estándar (naranja vacío, verde lleno)
          _aplicarEstiloAutoManual(inpContenido, 'user');
          icon.textContent = 'link_off';
          btnLinkContenido.style.background = 'var(--tint-orange-bg)';
          btnLinkContenido.style.borderColor = 'var(--tint-orange-fg)';
          btnLinkContenido.style.color = 'var(--tint-orange-fg)';
          btnLinkContenido.title = 'Desvinculado. Click para volver a usar el global.';
        }
      }

      btnLinkContenido.addEventListener('click', () => {
        row.dataset.contenidoLinked = row.dataset.contenidoLinked === '1' ? '0' : '1';
        _aplicarContenidoLinked();
        _refreshColoresState();
      });

      _aplicarContenidoLinked();

      // Trackear si el usuario tocó manualmente Pack$ y/o Unit$.
      // Cualquier `input` del usuario (tipear, borrar) lo marca como manual:
      // así el campo no se re-rellena solo aunque quede vacío. La forma de
      // volver al modo "auto" es modificar Costo, Margen, U/pack, etc.
      row.dataset.precioUnitManual = (precio     !== '' && precio     != null) ? '1' : '0';
      row.dataset.packManual       = (precioPack !== '' && precioPack != null) ? '1' : '0';
      inpPrecioUnit.addEventListener('input', () => {
        row.dataset.precioUnitManual = '1';
      });
      inpPrecioPack.addEventListener('input', () => {
        row.dataset.packManual = '1';
      });

      // Auto-cálculo Costo + Margen → Pack $ → Unit $.
      // Si hay Costo + Margen (local o global heredado), Pack se recalcula
      // SIEMPRE y arrastra el cálculo de Unit. La forma de tener Pack/Unit
      // "manual" es no cargar Costo (o no cargar Margen).
      // Margen: si la variedad trae el suyo, gana; si no, hereda el global.
      const _recalcPackFromCosto = () => {
        const c = parseFloat(inpCosto.value) || 0;
        const mLocal = inpMargen.value.trim();
        const m = mLocal !== '' ? parseFloat(mLocal) : (parseFloat(inMargen.value) || 0);
        if (c > 0 && !isNaN(m) && m >= 0) {
          inpPrecioPack.value = (c * (1 + m / 100)).toFixed(2);
          row.dataset.packManual = '0';
          // También limpiamos el flag manual del unitario para que se recalcule
          // automáticamente desde el nuevo Pack.
          row.dataset.precioUnitManual = '0';
          _aplicarEstiloAutoManual(inpPrecioPack, 'auto');
        }
      };
      inpCosto.addEventListener('input', _recalcPackFromCosto);
      inpMargen.addEventListener('input', _recalcPackFromCosto);

      // Botón redondeo del precio unitario
      linea.querySelector('.ed_color_redondear').addEventListener('click', () => {
        const v = parseFloat(inpPrecioUnit.value) || 0;
        if (!(v > 0)) return;
        inpPrecioUnit.value = redondearCentena(v).toFixed(2);
        row.dataset.precioUnitManual = '1';
        _aplicarEstiloAutoManual(inpPrecioUnit, 'auto');
        _refreshColoresState();
      });

      // Botón redondeo del precio del pack — fija pack como manual y arrastra
      // recalc del unitario desde ese pack redondeado.
      linea.querySelector('.ed_color_redondear_pack').addEventListener('click', () => {
        const v = parseFloat(inpPrecioPack.value) || 0;
        if (!(v > 0)) return;
        inpPrecioPack.value = redondearCentena(v).toFixed(2);
        row.dataset.packManual = '1';
        _aplicarEstiloAutoManual(inpPrecioPack, 'auto');
        _refreshColoresState();
      });

      // Cambios en cualquier input → re-pintar estilos + refrescar
      const _userInputs = [inpNombre, inpUnidades, inpRestante, inpCosto, inpMargen, inpContenido];
      const _autoInputs = [inpPrecioPack, inpPrecioUnit];
      row.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('input', () => {
          if (_userInputs.includes(inp))      _aplicarEstiloAutoManual(inp, 'user');
          else if (_autoInputs.includes(inp)) _aplicarEstiloAutoManual(inp, 'auto');
          _refreshColoresState();
        });
      });

      row.querySelector('.ed_color_remove').addEventListener('click', () => {
        row.remove();
        _refreshColoresState();
      });
      coloresList.appendChild(row);
      _aplicarUnidadAVariedad(row);
      _aplicarTogglePrecioARow(row);
    }

    function _getColoresFromUI() {
      const rows = coloresList.querySelectorAll('[data-color-row]');
      return Array.from(rows).map(r => {
        const precioRaw       = (r.querySelector('.ed_color_precio').value || '').trim();
        const contenidoRaw    = (r.querySelector('.ed_color_contenido').value || '').trim();
        const precioPackRaw   = (r.querySelector('.ed_color_precio_pack').value || '').trim();
        const costoRaw        = (r.querySelector('.ed_color_costo')?.value || '').trim();
        const margenRaw       = (r.querySelector('.ed_color_margen')?.value || '').trim();
        const stockMinRaw     = (r.querySelector('.ed_color_stock_min')?.value || '').trim();
        const stockMaxRaw     = (r.querySelector('.ed_color_stock_max')?.value || '').trim();
        // El input visible de código se sacó: preservamos el valor original
        // si la variedad ya lo traía, así no perdemos códigos al guardar.
        const codigoRaw       = (r.dataset.codigo || '').trim();
        const out = {
          color:    (r.querySelector('.ed_color_nombre').value || '').trim(),
          unidades: parseFloat(r.querySelector('.ed_color_unidades').value) || 0,
          restante: parseFloat(r.querySelector('.ed_color_restante').value) || 0,
        };
        // Campos opcionales: solo se guardan si el usuario puso un valor > 0
        const p  = precioRaw === ''     ? null : (parseFloat(precioRaw) || 0);
        const c  = contenidoRaw === ''  ? null : (parseFloat(contenidoRaw) || 0);
        const pp = precioPackRaw === '' ? null : (parseFloat(precioPackRaw) || 0);
        const co = costoRaw === ''      ? null : (parseFloat(costoRaw) || 0);
        const mg = margenRaw === ''     ? null : (parseFloat(margenRaw) || 0);
        const sMin = stockMinRaw === '' ? null : Math.max(0, parseFloat(stockMinRaw.replace(',', '.')) || 0);
        const sMax = stockMaxRaw === '' ? null : Math.max(0, parseFloat(stockMaxRaw.replace(',', '.')) || 0);
        // Si la variedad está vinculada al global, no guardamos `contenido`
        // (queda usando el global por fallback). Solo se persiste cuando el
        // usuario lo desvinculó y le puso un valor propio.
        const contenidoLinked = r.dataset.contenidoLinked === '1';
        if (p  && p  > 0) out.precio       = p;
        if (!contenidoLinked && c && c > 0) out.contenido = c;
        if (pp && pp > 0) out.precio_pack  = pp;
        if (co && co > 0) out.costo        = co;
        if (mg !== null && mg >= 0) out.margen = mg;
        if (codigoRaw)    out.codigo       = codigoRaw;
        if (sMin !== null && sMin > 0) out.stock_min = sMin;
        if (sMax !== null && sMax > 0) out.stock_max = sMax;
        // Unidad de esos umbrales: sólo se persiste cuando hay ambigüedad real
        // (pack de más de una unidad) y hay algún umbral cargado. Sin este
        // campo, el motor de alertas deduce packs si el pack trae más de 1.
        const umElegida = r.querySelector('.ed_color_stock_um')?.dataset.um || '';
        if ((umElegida === 'pack' || umElegida === 'unidad')
            && ((sMin !== null && sMin > 0) || (sMax !== null && sMax > 0))) {
          out.stock_min_um = umElegida;
        }
        // Productos vinculados (consumibles): cuando se vende esta variedad,
        // el watcher descuenta unidades de CADA producto fuente. Guardamos un
        // array `vinculaciones[]` y replicamos el primer entry en los campos
        // legacy (`vinculado_a/cantidad/nombre`) para compat con código viejo.
        let vincs = [];
        try { vincs = JSON.parse(r.dataset.vinculaciones || '[]'); } catch { vincs = []; }
        vincs = vincs
          .filter(v => v && v.doc_id && Number(v.cantidad) > 0)
          .map(v => ({
            doc_id: String(v.doc_id),
            cantidad: Number(v.cantidad),
            nombre: v.nombre || '',
          }));
        if (vincs.length > 0) {
          out.vinculaciones = vincs;
          // Legacy mirror (primer entry)
          out.vinculado_a = vincs[0].doc_id;
          out.vinculado_cantidad = vincs[0].cantidad;
          if (vincs[0].nombre) out.vinculado_nombre = vincs[0].nombre;
        }
        return out;
      }).filter(c => c.color);
    }

    // El campo "Sueltos" se muestra siempre — placeholder para mantener compat
    // con el resto del código que llama a esta función.
    function _aplicarUnidadAVariedad(row) {
      const restInp = row.querySelector('.ed_color_restante');
      if (restInp) restInp.style.display = '';
    }

    function _aplicarUnidadATodasVariedades() {
      coloresList.querySelectorAll('[data-color-row]').forEach(_aplicarUnidadAVariedad);
    }

    // Si toggle "mismo precio" está ON, ocultar Costo · Margen · Pack $ · ±100
    // (todos los elementos con data-subrow="costo" + el separador previo). El
    // unitario se autocalcula desde el precio global.
    function _aplicarTogglePrecioARow(row) {
      const mismoPrecio = !!cbMismoPrecio.checked;
      const display = mismoPrecio ? 'none' : '';
      row.querySelectorAll('[data-subrow="costo"]').forEach(el => { el.style.display = display; });
      const sep = row.querySelector('[data-sep="costo"]');
      if (sep) sep.style.display = display;
    }

    function _aplicarTogglePrecioATodas() {
      coloresList.querySelectorAll('[data-color-row]').forEach(_aplicarTogglePrecioARow);
    }

    // Recalcula el precio unitario auto de cada fila cuyo dataset.precioUnitManual === '0'.
    // Auto = (precioPack o global) / (contenido o global) × 1.15
    // Si TIPO === 'unidad', no se aplica el 15% extra (venta directa por unidad).
    function _recalcularPrecioUnitarioAuto() {
      const FRACCION = conjTipo.value === 'unidad' ? 1 : 1.15;
      const globalPack       = parseFloat(inPrecio.value) || 0;
      const globalContenido  = parseFloat(conjC.value) || 0;
      coloresList.querySelectorAll('[data-color-row]').forEach(row => {
        if (row.dataset.precioUnitManual === '1') return;
        const pp = parseFloat(row.querySelector('.ed_color_precio_pack').value) || 0;
        const cc = parseFloat(row.querySelector('.ed_color_contenido').value) || 0;
        const pack      = pp > 0 ? pp : globalPack;
        const contenido = cc > 0 ? cc : globalContenido;
        const inpPU = row.querySelector('.ed_color_precio');
        if (pack > 0 && contenido > 0) {
          const sugerido = (pack / contenido) * FRACCION;
          inpPU.value = sugerido.toFixed(2);
        } else {
          inpPU.value = '';
        }
        _aplicarEstiloAutoManual(inpPU, 'auto');
      });
    }

    // Marca en rojo el nombre de una variedad repetida (o lo restaura al estilo
    // normal si deja de estarlo). Solo tocamos el borde/fondo del input de nombre.
    function _setRowDupMark(row, on) {
      const inp = row.querySelector('.ed_color_nombre');
      if (!inp) return;
      if (on) {
        row.dataset.dup = '1';
        inp.style.border = '1.5px solid var(--tint-red-fg)';
        inp.style.background = 'var(--tint-red-bg)';
        inp.title = 'Nombre repetido — diferenciá esta variedad (ej: agregá "claro", "oscuro" o un número).';
      } else if (row.dataset.dup === '1') {
        delete row.dataset.dup;
        inp.title = inp.value || '';
        _aplicarEstiloAutoManual(inp, 'user');
      }
    }

    // Pulso rojo breve sobre una fila para ubicarla al intentar guardar.
    // Solo capturamos la sombra base cuando NO hay un pulso en curso: así dos
    // pulsos seguidos (doble-click en Guardar) no guardan el rojo como "base"
    // y la fila siempre vuelve a su sombra original.
    function _pulseRow(row) {
      if (row._pulseT) clearTimeout(row._pulseT);
      else row._pulseBase = row.style.boxShadow;
      row.style.transition = 'box-shadow .18s ease';
      row.style.boxShadow = '0 0 0 2px var(--tint-red-fg)';
      row._pulseT = setTimeout(() => {
        row.style.boxShadow = row._pulseBase || '';
        row._pulseT = null;
      }, 1100);
    }

    // Detecta nombres de variedad repetidos (case-insensitive, ignora vacíos),
    // pinta las filas afectadas y actualiza el banner de aviso. Devuelve el
    // array de nombres duplicados (vacío = todo OK). No usa popups: avisa en
    // la misma pantalla, arriba de la lista.
    function _marcarVariedadesDuplicadas() {
      const rows = Array.from(coloresList.querySelectorAll('[data-color-row]'));
      const groups = new Map();
      rows.forEach(row => {
        const key = (row.querySelector('.ed_color_nombre')?.value || '').trim().toLowerCase();
        if (!key) { _setRowDupMark(row, false); return; }
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      });
      const dupNames = [];
      groups.forEach(grp => {
        if (grp.length > 1) {
          dupNames.push((grp[0].querySelector('.ed_color_nombre').value || '').trim());
          grp.forEach(r => _setRowDupMark(r, true));
        } else {
          _setRowDupMark(grp[0], false);
        }
      });
      if (dupNames.length > 0) {
        const lista = dupNames.map(n => `<b>"${_escHtml(n)}"</b>`).join(', ');
        dupMsg.innerHTML = dupNames.length === 1
          ? `Hay dos o más variedades con el mismo nombre: ${lista}. Diferencialas para poder guardar.`
          : `Hay ${dupNames.length} nombres de variedad repetidos: ${lista}. Diferencialos para poder guardar.`;
        dupWarn.style.display = 'flex';
      } else {
        dupWarn.style.display = 'none';
      }
      return dupNames;
    }

    // Botón "Diferenciar": a cada variedad repetida (menos la primera de cada
    // grupo) le agrega un sufijo numérico único, dejando todas distintas. Luego
    // enfoca la primera renombrada para que el usuario ponga un nombre mejor.
    dupFixBtn.addEventListener('click', () => {
      if (buscarVarInp.value) { buscarVarInp.value = ''; _filtrarVariedades(); }
      const rows = Array.from(coloresList.querySelectorAll('[data-color-row]'));
      const used = new Set();
      rows.forEach(r => {
        const v = (r.querySelector('.ed_color_nombre').value || '').trim().toLowerCase();
        if (v) used.add(v);
      });
      const seen = new Set();
      let firstRenamed = null;
      rows.forEach(r => {
        const inp = r.querySelector('.ed_color_nombre');
        const base = (inp.value || '').trim();
        const key = base.toLowerCase();
        if (!key) return;
        if (!seen.has(key)) { seen.add(key); return; }
        let n = 2, candidate;
        do { candidate = `${base} ${n}`; n++; } while (used.has(candidate.toLowerCase()));
        used.add(candidate.toLowerCase());
        inp.value = candidate;
        inp.title = candidate;
        _autosizeNombre(inp);
        _aplicarEstiloAutoManual(inp, 'user');
        r.style.transition = 'background .15s';
        r.style.background = 'var(--tint-purple-bg)';
        setTimeout(() => { r.style.background = 'var(--surface)'; }, 500);
        if (!firstRenamed) firstRenamed = inp;
      });
      _refreshColoresState();
      if (firstRenamed) {
        firstRenamed.scrollIntoView({ behavior: 'smooth', block: 'center' });
        firstRenamed.focus();
        firstRenamed.select();
      }
    });

    // ── Unidad de los umbrales por variedad (packs vs unidades) ──────────────
    // Unidades que trae un pack de esta fila: su contenido propio, o el global.
    // Sin ninguno de los dos, el pack ES la unidad (1).
    function _contenidoFila(row) {
      const propio = parseFloat(row.querySelector('.ed_color_contenido')?.value) || 0;
      if (propio > 0) return propio;
      const gl = parseFloat(conjC?.value) || 0;
      return gl > 0 ? gl : 1;
    }
    // Unidad en la que se leen mín/máx: la elegida a mano en la fila o, si no
    // se eligió, la deducida (pack de más de 1 unidad → packs).
    function _umEfectivaFila(row) {
      const elegida = row.querySelector('.ed_color_stock_um')?.dataset.um || '';
      if (elegida === 'pack' || elegida === 'unidad') return elegida;
      return _contenidoFila(row) > 1 ? 'pack' : 'unidad';
    }
    // Etiqueta y visibilidad del botón: sólo aparece cuando hay ambigüedad
    // real (pack de más de una unidad); con pack de 1, packs = unidades.
    function _refrescarUmAlertas() {
      const [plTipo] = NOMBRES_TIPO[conjTipo?.value] || NOMBRES_TIPO.otro;
      const packLabel = plTipo.toLowerCase();
      const unidadLabel = (conjUM?.value || 'unidades').toLowerCase();
      coloresList.querySelectorAll('[data-color-row]').forEach(row => {
        const btn = row.querySelector('.ed_color_stock_um');
        if (!btn) return;
        if (_contenidoFila(row) <= 1) {
          // Con pack de 1 la unidad no aplica, pero la elección guardada se
          // conserva: borrarla acá hacía que guardar la ficha perdiera el
          // stock_min_um de la fila (visto 01-09 con el BRETEL ELASTICO).
          btn.style.display = 'none';
          return;
        }
        btn.style.display = 'inline-flex';
        const um = _umEfectivaFila(row);
        btn.querySelector('.ed_color_stock_um_txt').textContent = um === 'pack' ? packLabel : unidadLabel;
        btn.title = um === 'pack'
          ? `Los mín/máx de esta fila se leen en ${packLabel} enteros. Click para pasarlos a ${unidadLabel}.`
          : `Los mín/máx de esta fila se leen en ${unidadLabel} totales (packs + sueltos). Click para pasarlos a ${packLabel}.`;
      });
    }

    function _refreshColoresState() {
      const colores = _getColoresFromUI();
      const filasTotales = coloresList.children.length;
      const hasColores = colores.length > 0;
      coloresEmpty.style.display = filasTotales === 0 ? 'block' : 'none';
      coloresList.style.display = filasTotales === 0 ? 'none' : 'flex';
      togglePrecioWrap.style.display = filasTotales === 0 ? 'none' : 'flex';
      // Buscador: solo cuando hay suficientes variedades para que sea útil.
      const mostrarBuscador = filasTotales >= VAR_SEARCH_MIN;
      buscarVarWrap.style.display = mostrarBuscador ? 'flex' : 'none';
      if (!mostrarBuscador && buscarVarInp.value) buscarVarInp.value = '';
      _filtrarVariedades();
      // Si hay variedades con nombre, los agregados se calculan como SUMA y los inputs principales quedan readonly.
      if (hasColores) {
        const sumU = colores.reduce((a, c) => a + c.unidades, 0);
        const sumR = colores.reduce((a, c) => a + c.restante, 0);
        conjU.value = sumU;
        conjR.value = sumR;
        conjU.readOnly = true;
        conjR.readOnly = true;
        conjU.style.background = 'var(--surface-2)';
        conjR.style.background = 'var(--surface-2)';
        conjU.title = 'Calculado automáticamente: SUMA de las variedades. Editá las cantidades en cada fila de variedad.';
        conjR.title = 'Calculado automáticamente: SUMA de las variedades. Editá las cantidades en cada fila de variedad.';
      } else {
        conjU.readOnly = false;
        conjR.readOnly = false;
        conjU.style.background = '';
        conjR.style.background = 'var(--surface-2)';
        conjU.title = '';
        conjR.title = '';
      }
      // Recalcular precios unitarios auto antes del resumen
      _recalcularPrecioUnitarioAuto();
      // Refrescar labels y resumen, y luego sufijar las labels de cantidad/sueltas
      // si están bloqueadas por la suma de variedades.
      _refrescarConjunto();
      if (hasColores && lblTitU) {
        lblTitU.innerHTML += ' <span style="color:var(--tint-purple-fg);font-weight:500">(suma de variedades)</span>';
      }
      if (hasColores && lblTitR) {
        lblTitR.innerHTML += ' <span style="color:var(--tint-purple-fg);font-weight:500">(suma de variedades)</span>';
      }
      // Aviso en vivo de nombres de variedad repetidos (banner + filas en rojo).
      _marcarVariedadesDuplicadas();
      // Botón packs/unidades de los umbrales por variedad.
      _refrescarUmAlertas();
      // Con variedades el umbral se configura por fila: sacamos el global.
      const _vinc = (typeof _getProdVincs === 'function') && _getProdVincs().length > 0;
      _aplicarUbicacionAlertas(cbConj.checked, _vinc);
    }

    // Cambiar el tipo de envase, la unidad de medida o el contenido global
    // reetiqueta (o hace irrelevante) el botón packs/unidades de cada fila.
    [conjTipo, conjUM, conjC].forEach(el => el && el.addEventListener('input', _refrescarUmAlertas));

    btnAddColor.addEventListener('click', () => {
      // Si hay un filtro activo lo limpiamos para que la fila nueva (vacía) no
      // quede oculta detrás de la búsqueda.
      if (buscarVarInp.value) buscarVarInp.value = '';
      _addColorRow();
      const last = coloresList.lastElementChild;
      if (last) last.querySelector('.ed_color_nombre').focus();
      _refreshColoresState();
    });

    // Toggle "mismo precio para todas"
    cbMismoPrecio.addEventListener('change', () => {
      _aplicarTogglePrecioATodas();
      // Si volvemos al modo "mismo precio", limpiar overrides de pack por fila
      if (cbMismoPrecio.checked) {
        coloresList.querySelectorAll('[data-color-row]').forEach(row => {
          const inpPP = row.querySelector('.ed_color_precio_pack');
          inpPP.value = '';
          _aplicarEstiloAutoManual(inpPP, 'auto');
        });
      }
      _aplicarEstadoPrecioGlobal();
      _refreshColoresState();
    });

    // Botón "a todas" (al lado del PRECIO POR METRO): copia ese precio por metro
    // a TODAS las variedades, fijándolo como precio unitario manual de cada fila.
    // Si el campo está vacío (modo auto), usa el sugerido = precio ÷ contenido × 1.15
    // (sin el 15 % si el TIPO es "unidad"), igual que el cálculo automático.
    const btnAplicarPrecioVar = overlay.querySelector('#ed_aplicar_precio_var');
    if (btnAplicarPrecioVar) {
      const _origBtnHTML  = btnAplicarPrecioVar.innerHTML;
      const _origBtnTitle = btnAplicarPrecioVar.title;
      let _btnResetTimer = null;
      const _flashBtn = (html, bg) => {
        btnAplicarPrecioVar.innerHTML = html;
        btnAplicarPrecioVar.style.background  = bg;
        btnAplicarPrecioVar.style.borderColor = bg;
        if (_btnResetTimer) clearTimeout(_btnResetTimer);
        _btnResetTimer = setTimeout(() => {
          btnAplicarPrecioVar.innerHTML = _origBtnHTML;
          btnAplicarPrecioVar.title = _origBtnTitle;
          btnAplicarPrecioVar.style.background  = '#7c3aed';
          btnAplicarPrecioVar.style.borderColor = '#7c3aed';
        }, 1500);
      };
      btnAplicarPrecioVar.addEventListener('click', () => {
        const rows = coloresList.querySelectorAll('[data-color-row]');
        // Precio por metro a propagar: valor del campo o el sugerido automático.
        let val = parseFloat(conjPU && conjPU.value) || 0;
        if (!(val > 0)) {
          const FRACCION = conjTipo.value === 'unidad' ? 1 : 1.15;
          const pack = parseFloat(inPrecio.value) || 0;
          const cont = parseFloat(conjC.value) || 0;
          if (pack > 0 && cont > 0) val = (pack / cont) * FRACCION;
        }
        if (!(val > 0)) {
          btnAplicarPrecioVar.title = 'Cargá primero un precio por metro';
          _flashBtn('<span class="material-icons" style="font-size:16px">error_outline</span>', '#dc2626');
          return;
        }
        if (rows.length === 0) {
          btnAplicarPrecioVar.title = 'No hay variedades cargadas';
          _flashBtn('<span class="material-icons" style="font-size:16px">error_outline</span>', '#dc2626');
          return;
        }
        // Sin decimales de relleno: 700 → "700", 700.5 → "700.5".
        const fixed = String(Math.round(val * 100) / 100);
        rows.forEach(row => {
          const inpPU = row.querySelector('.ed_color_precio');
          if (inpPU) {
            inpPU.value = fixed;
            row.dataset.precioUnitManual = '1';
            _aplicarEstiloAutoManual(inpPU, 'auto');
          }
          // Flash visual sobre la fila para que el cambio sea evidente.
          row.style.transition = 'background .15s';
          row.style.background = 'var(--tint-purple-bg)';
          setTimeout(() => { row.style.background = 'var(--surface)'; }, 360);
        });
        _refreshColoresState();
        btnAplicarPrecioVar.title = `Aplicado a ${rows.length} ${rows.length === 1 ? 'variedad' : 'variedades'}`;
        _flashBtn('<span class="material-icons" style="font-size:16px">check</span>', '#16a34a');
      });
    }

    // Propagar el contenido global a todas las variedades vinculadas (linked = 1).
    function _propagarContenidoGlobal() {
      const g = parseFloat(conjC.value) || 0;
      coloresList.querySelectorAll('[data-color-row]').forEach(row => {
        if (row.dataset.contenidoLinked !== '1') return;
        const inp = row.querySelector('.ed_color_contenido');
        if (inp) inp.value = g > 0 ? g : '';
      });
    }

    // Cuando cambia el precio o el contenido global, recalcular los precios unitarios auto
    inPrecio.addEventListener('input', _recalcularPrecioUnitarioAuto);
    conjC.addEventListener('input', () => {
      _propagarContenidoGlobal();
      _recalcularPrecioUnitarioAuto();
    });

    // Cargar colores existentes del producto (si Firestore los trae)
    const coloresExistentes = Array.isArray(prod.conjunto_colores) ? prod.conjunto_colores : [];
    // Si alguna variedad existente trae precio_pack propio, arrancamos con el toggle desactivado
    const algunaConPrecioPack = coloresExistentes.some(c => c && c.precio_pack != null && c.precio_pack > 0);
    if (algunaConPrecioPack) cbMismoPrecio.checked = false;
    coloresExistentes.forEach(c => {
      // Hidratar vinculaciones: priorizar array nuevo, fallback al campo legacy.
      let vincs = [];
      if (c && Array.isArray(c.vinculaciones)) {
        vincs = c.vinculaciones;
      } else if (c && c.vinculado_a && Number(c.vinculado_cantidad) > 0) {
        vincs = [{ doc_id: c.vinculado_a, cantidad: Number(c.vinculado_cantidad), nombre: c.vinculado_nombre || '' }];
      }
      _addColorRow(
        c && c.color ? c.color : '',
        c && c.unidades != null ? c.unidades : '',
        c && c.restante != null ? c.restante : '',
        c && c.precio != null ? c.precio : '',
        c && c.contenido != null ? c.contenido : '',
        c && c.precio_pack != null ? c.precio_pack : '',
        c && c.costo != null ? c.costo : '',
        c && c.margen != null ? c.margen : '',
        c && c.codigo ? c.codigo : '',
        c && c.stock_min != null ? c.stock_min : '',
        c && c.stock_max != null ? c.stock_max : '',
        vincs,
        c && c.stock_min_um ? c.stock_min_um : ''
      );
    });
    _refreshColoresState();
    _aplicarEstadoPrecioGlobal();

    // ── Vincular a productos (nivel producto): N vinculaciones ──────────────
    // Estado: array de {doc_id, cantidad, nombre} guardado en overlay.dataset.vincs
    // como JSON. Carga inicial: prioriza prod.vinculaciones[]; si no existe,
    // hidrata desde campos legacy vinculado_a/cantidad/nombre.
    const vincListaEl = overlay.querySelector('#ed_vinc_lista');
    const vincAddBtn  = overlay.querySelector('#ed_vinc_add');

    function _getProdVincs() {
      try { return JSON.parse(overlay.dataset.vincs || '[]'); } catch { return []; }
    }
    function _setProdVincs(arr) {
      overlay.dataset.vincs = JSON.stringify(arr || []);
      _renderVincProductoLista();
      // Al cambiar los vínculos, ocultar/mostrar el bloque de stock propio y el
      // aviso de "stock por vínculo".
      try { _aplicarVisibilidadConjunto(); } catch (_) {}
    }

    function _renderVincProductoLista() {
      const arr = _getProdVincs();
      if (arr.length === 0) {
        vincListaEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:4px 2px">No hay vinculaciones. Tocá <b>+ agregar vinculación</b>.</div>';
        return;
      }
      vincListaEl.innerHTML = arr.map((v, i) => `
        <div class="ed-vinc-item" data-idx="${i}" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--surface);border:1.5px solid var(--border);border-radius:8px;padding:6px 10px">
          <span style="background:var(--tint-blue-bg);border-radius:6px;padding:3px 8px;color:var(--tint-blue-fg);font-weight:600;font-size:12px">→ ${_escHtml(v.nombre || v.doc_id || '?')}</span>
          <span style="color:var(--text-muted);font-size:11.5px">×</span>
          <input class="ed-vinc-qty" type="number" min="0" step="any" value="${v.cantidad}" style="width:70px;padding:4px 8px;border:1.5px solid #1565c0;border-radius:6px;font-size:12px;font-weight:700;color:var(--tint-blue-fg);background:var(--tint-blue-bg);font-family:inherit;box-sizing:border-box" />
          <span style="color:var(--text-muted);font-size:11px">unid.</span>
          <button type="button" class="ed-vinc-edit" style="margin-left:auto;padding:4px 10px;border-radius:6px;border:1.5px solid var(--border);background:var(--surface);color:var(--tint-blue-fg);font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit">cambiar</button>
          <button type="button" class="ed-vinc-rm" title="Quitar" style="width:24px;height:24px;border-radius:50%;border:none;background:transparent;color:var(--tint-red-fg);cursor:pointer;font-size:18px;line-height:1;padding:0">×</button>
        </div>
      `).join('');

      vincListaEl.querySelectorAll('.ed-vinc-item').forEach(row => {
        const i = Number(row.dataset.idx);
        row.querySelector('.ed-vinc-qty').addEventListener('input', e => {
          const arr2 = _getProdVincs();
          if (!arr2[i]) return;
          arr2[i].cantidad = parseFloat(e.target.value.replace(',', '.')) || 0;
          overlay.dataset.vincs = JSON.stringify(arr2);
        });
        row.querySelector('.ed-vinc-edit').addEventListener('click', async () => {
          const arr2 = _getProdVincs();
          const cur = arr2[i] || {};
          const result = await abrirVinculadorProducto(cur.doc_id || '', cur.cantidad || '1', prod.doc_id);
          if (!result) return;
          arr2[i] = {
            doc_id: result.doc_id || '',
            cantidad: parseFloat(result.cantidad) || 1,
            nombre: result.nombre || '',
          };
          _setProdVincs(arr2);
        });
        row.querySelector('.ed-vinc-rm').addEventListener('click', () => {
          const arr2 = _getProdVincs();
          arr2.splice(i, 1);
          _setProdVincs(arr2);
        });
      });

      // Mostrar el stock efectivo (del/los vinculado/s) en el aviso.
      if (stockVincValor && arr.length) {
        const eff = _stockEfectivoLink({ vinculaciones: arr });
        stockVincValor.textContent = (eff === -1) ? '∞ (servicio)' : String(eff);
      }
    }

    // Hidratación inicial
    let _vincsInit = Array.isArray(prod.vinculaciones) ? prod.vinculaciones.slice() : [];
    if (_vincsInit.length === 0 && prod.vinculado_a && Number(prod.vinculado_cantidad) > 0) {
      _vincsInit = [{
        doc_id: prod.vinculado_a,
        cantidad: Number(prod.vinculado_cantidad) || 1,
        nombre: prod.vinculado_nombre || '',
      }];
    }
    _setProdVincs(_vincsInit);

    vincAddBtn.addEventListener('click', async () => {
      const result = await abrirVinculadorProducto('', '1', prod.doc_id);
      if (!result || !result.doc_id) return;
      const arr = _getProdVincs();
      // Evitar duplicar el mismo target
      if (arr.some(v => v.doc_id === result.doc_id)) {
        alertDialog({ title: 'Ya vinculado', message: 'Ese producto ya está vinculado. Editá su cantidad en la lista.', type: 'info' });
        return;
      }
      arr.push({
        doc_id: result.doc_id,
        cantidad: parseFloat(result.cantidad) || 1,
        nombre: result.nombre || '',
      });
      _setProdVincs(arr);
    });

    // Autocomplete para rubro, sub-rubro, marca y proveedor — dropdown custom
    // con filtrado en vivo. Si el usuario tipea algo nuevo, queda como nuevo
    // sin pasos extra (chip verde "Usar como nuevo" en el pie del dropdown).
    const _rubroInp    = overlay.querySelector('#ed_rubro');
    const _subrubroInp = overlay.querySelector('#ed_subrubro');
    const _marcaInp    = overlay.querySelector('#ed_marca');
    const _provInp     = overlay.querySelector('#ed_proveedor');

    _setupAutocomplete(_rubroInp, () => {
      // Rubros conocidos (constante) + los efectivamente usados por productos.
      const usados = new Set(allProductos.map(p => (p.rubro || '').trim().toUpperCase()).filter(Boolean));
      return [...new Set([...RUBROS, ...usados])].sort();
    });

    _setupAutocomplete(_subrubroInp, () => {
      // Sub-rubros del rubro actualmente seleccionado.
      const rubroSel = (_rubroInp.value || '').trim().toUpperCase();
      const base = rubroSel
        ? allProductos.filter(p => (p.rubro || '').toUpperCase() === rubroSel)
        : allProductos;
      return [...new Set(base.map(p => (p.sub_rubro || '').trim().toUpperCase()).filter(Boolean))].sort();
    });

    _setupAutocomplete(_marcaInp, () => {
      return [...new Set(
        allProductos.map(p => (p.marca || '').trim().toUpperCase())
          .filter(m => m && m !== 'SIN MARCA')
      )].sort();
    });

    _setupAutocomplete(_provInp, () => {
      return [...new Set(
        allProductos.map(p => (p.proveedor || '').trim())
          .filter(pr => pr && pr !== 'SIN PROVEEDOR')
      )].sort();
    });

    const cerrar = () => {
      overlay.remove();
      if (_editorActivo && _editorActivo.overlay === overlay) _editorActivo = null;
    };
    // Registrar el editor abierto (solo edición de producto existente) para que
    // un undo/redo que toque este producto lo recargue con los valores nuevos.
    if (!esNuevo && prod.doc_id) {
      _editorActivo = {
        docId: prod.doc_id,
        overlay,
        reabrir: () => {
          const fresh = allProductos.find(x => x.doc_id === prod.doc_id) || prod;
          overlay.remove();
          _editorActivo = null;
          abrirEditorCompleto(fresh);
        },
      };
    }
    overlay.querySelector('#cerrarEditor').addEventListener('click', cerrar);
    overlay.querySelector('#ed_cancelar').addEventListener('click', cerrar);

    // Botón Generar (sólo en modo crear). Llena código interno + barras con
    // el mismo número de 6 dígitos, único contra todo el catálogo.
    overlay.querySelector('#ed_gen_codes')?.addEventListener('click', () => {
      const { codigo, cod_barra } = generarCodigosUnicos(allProductos);
      const inpCod = overlay.querySelector('#ed_codigo');
      const inpBar = overlay.querySelector('#ed_barra');
      if (inpCod) inpCod.value = codigo;
      if (inpBar) inpBar.value = cod_barra;
    });
    // Cerrar al click fuera, pero sólo si el mousedown también fue en el fondo
    // (evita cierres accidentales al drag-select texto desde el modal hacia afuera).
    let _mdEnFondo = false;
    overlay.addEventListener('mousedown', e => { _mdEnFondo = (e.target === overlay); });
    overlay.addEventListener('click', e => { if (e.target === overlay && _mdEnFondo) cerrar(); });

    // Descargar etiqueta (barcode PNG con nombre + codigo)
    overlay.querySelector('#ed_etiqueta').addEventListener('click', async () => {
      const codigo = (overlay.querySelector('#ed_barra').value || overlay.querySelector('#ed_codigo').value || '').trim();
      if (!codigo) { alertDialog({ title: 'Falta el código', message: 'Cargá primero un código de barras o código interno.', type: 'warning' }); return; }
      const nombre = (overlay.querySelector('#ed_nombre').value || '').trim() || 'producto';
      try {
        await _ensureJsBarcode();
        await _descargarEtiqueta(codigo, nombre);
      } catch (e) {
        alertDialog({ title: 'Error', message: 'No se pudo generar la etiqueta: ' + _escHtml(e.message), type: 'error' });
      }
    });

    // Timer del flash rojo "Variedades repetidas": lo guardamos para poder
    // cancelarlo si el usuario corrige y vuelve a guardar antes de que expire
    // (si no, restauraría el botón en pleno guardado en curso).
    let _dupBtnResetTimer = null;

    overlay.querySelector('#ed_guardar').addEventListener('click', async () => {
      const btn = overlay.querySelector('#ed_guardar');
      // Cancelar un flash de "repetidas" pendiente para que no pise el spinner.
      if (_dupBtnResetTimer) { clearTimeout(_dupBtnResetTimer); _dupBtnResetTimer = null; }
      // Texto del botón para restaurar tras error o validación fallida.
      const _btnLabel = esNuevo
        ? '<span class="material-icons" style="font-size:16px">add_circle</span>Crear producto'
        : '<span class="material-icons" style="font-size:16px">save</span>Guardar cambios';
      btn.disabled = true;
      btn.innerHTML = `<span class="material-icons" style="font-size:16px;animation:spin 0.8s linear infinite">refresh</span> ${esNuevo ? 'Creando...' : 'Guardando...'}`;

      const nuevoNombre   = (overlay.querySelector('#ed_nombre').value || '').trim().toUpperCase();
      const nuevoRubro    = (overlay.querySelector('#ed_rubro').value || '').trim().toUpperCase();
      const nuevoSubRubro = (overlay.querySelector('#ed_subrubro').value || '').trim().toUpperCase();
      const nuevaMarca    = (overlay.querySelector('#ed_marca').value || '').trim().toUpperCase() || 'SIN MARCA';
      const nuevoProv     = (overlay.querySelector('#ed_proveedor').value || '').trim() || 'SIN PROVEEDOR';
      const nuevoCodigo   = limpiarCodigo(overlay.querySelector('#ed_codigo').value);
      const barraRaw      = limpiarCodigo(overlay.querySelector('#ed_barra').value);
      const nuevoBarra    = /^[A-Za-z0-9\-_]{3,50}$/.test(barraRaw) ? barraRaw : '';
      const nuevoCosto    = parseFloat(inCosto.value) || 0;
      const nuevoPrecio   = parseFloat(inPrecio.value) || 0;
      let nuevoStock      = Math.max(0, parseInt(overlay.querySelector('#ed_stock').value) || 0);
      const rawSMin       = overlay.querySelector('#ed_stock_min').value.trim();
      const rawSMax       = overlay.querySelector('#ed_stock_max').value.trim();
      let nuevoStockMin   = rawSMin === '' ? null : Math.max(0, parseFloat(rawSMin.replace(',', '.')) || 0);
      let nuevoStockMax   = rawSMax === '' ? null : Math.max(0, parseFloat(rawSMax.replace(',', '.')) || 0);

      // Umbrales escritos en cajas/packs → se guardan en unidades para que el
      // POS y el resto de la webapp los sigan leyendo igual que siempre.
      const _bultoGuardar = _bultoActual();
      const _avisaPorBulto = selAlertaUM.value === 'bulto' && !!_bultoGuardar;
      if (_avisaPorBulto) {
        // `aUnidadesEstable` y no `aUnidades`: el campo muestra las cajas con
        // dos decimales, así que abrir y guardar sin tocar nada corría el
        // umbral (7 unidades se veían como 0,58 cajas y volvían como 6,96).
        if (nuevoStockMin !== null) {
          nuevoStockMin = aUnidadesEstable(nuevoStockMin, _bultoGuardar, prod.stock_min);
        }
        if (nuevoStockMax !== null) {
          nuevoStockMax = aUnidadesEstable(nuevoStockMax, _bultoGuardar, prod.stock_max);
        }
      }

      if (!nuevoNombre) { alertDialog({ title: 'Falta el nombre', message: 'El nombre no puede estar vacío.', type: 'warning' }); btn.disabled = false; btn.innerHTML = _btnLabel; return; }
      if (barraRaw && !nuevoBarra) { alertDialog({ title: 'Código inválido', message: 'El código de barras solo puede tener letras, números, guiones y guiones bajos (mínimo 3 caracteres).', type: 'warning' }); btn.disabled = false; btn.innerHTML = _btnLabel; return; }
      if (nuevoStockMin !== null && nuevoStockMax !== null && nuevoStockMax > 0 && nuevoStockMax < nuevoStockMin) {
        alertDialog({ title: 'Stock inválido', message: 'El stock máximo no puede ser menor al mínimo.', type: 'warning' });
        btn.disabled = false; btn.innerHTML = _btnLabel;
        return;
      }

      // Producto Conjunto
      const esConjunto = overlay.querySelector('#ed_es_conjunto').checked;
      let conjuntoFields;
      if (esConjunto) {
        const cTipo = overlay.querySelector('#ed_conj_tipo').value || 'rollo';
        const cUM   = overlay.querySelector('#ed_conj_unidad_medida').value || 'unidades';
        const esUnidad = cUM === 'unidades';
        // Contenido y precio unitario funcionan igual en modo "unidades": una caja
        // con 80 lápices tiene contenido = 80 y precio unitario = precio_caja / 80 × 1.15.
        // Si el usuario no carga contenido, asumimos 1 (cada item es una unidad suelta).
        const cCraw = (overlay.querySelector('#ed_conj_contenido').value || '').trim();
        const cC    = cCraw === '' ? 1 : (parseFloat(cCraw) || 1);
        const cPraw = (overlay.querySelector('#ed_conj_precio_unidad').value || '').trim();
        const cP    = cPraw === '' ? null : (parseFloat(cPraw) || 0);

        // Stock por color: si hay colores cargados, los agregados son SUMA.
        const coloresArr = _getColoresFromUI();
        const tieneColores = coloresArr.length > 0;

        // Validar duplicados (case-insensitive). Dos variedades con el mismo
        // nombre rompen el matching del POS al descontar stock. En vez de un
        // popup que tapa la pantalla de carga, avisamos en la misma pantalla:
        // el banner de arriba ya viene mostrándose, marcamos las filas en rojo,
        // scrolleamos a la primera repetida y la enfocamos para que el usuario
        // la diferencie sin que se cierre el diálogo.
        if (tieneColores) {
          const dupNames = _marcarVariedadesDuplicadas();
          if (dupNames.length > 0) {
            if (buscarVarInp.value) { buscarVarInp.value = ''; _filtrarVariedades(); }
            const firstDup = coloresList.querySelector('[data-color-row][data-dup="1"]');
            if (firstDup) {
              firstDup.scrollIntoView({ behavior: 'smooth', block: 'center' });
              _pulseRow(firstDup);
              const inpDup = firstDup.querySelector('.ed_color_nombre');
              if (inpDup) { inpDup.focus(); inpDup.select(); }
            } else if (dupWarn) {
              dupWarn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            const _btnBg = esNuevo ? '#16a34a' : '#1877f2';
            btn.disabled = false;
            btn.innerHTML = '<span class="material-icons" style="font-size:16px">error_outline</span> Variedades repetidas';
            btn.style.background = '#dc2626';
            if (_dupBtnResetTimer) clearTimeout(_dupBtnResetTimer);
            _dupBtnResetTimer = setTimeout(() => { btn.innerHTML = _btnLabel; btn.style.background = _btnBg; _dupBtnResetTimer = null; }, 2600);
            return;
          }
        }

        // Lo tipeado es LITERAL (regla del 31-08): `unidades` son los packs
        // cerrados tal cual, y los sueltos van aparte — el abierto no se cuenta
        // como pack. La resta automática del abierto (regla del estante, vigente
        // del 22-08 al 31-08) se retiró a pedido del dueño: lo que se carga es
        // lo que queda guardado, sin traducciones. Los labels del formulario lo
        // aclaran ("sin contar el abierto"). Ver webapp/src/conjunto.js.
        let cU, cR;
        if (tieneColores) {
          cU = coloresArr.reduce((a, c) => a + (c.unidades || 0), 0);
          cR = coloresArr.reduce((a, c) => a + (c.restante || 0), 0);
        } else {
          const cRraw = overlay.querySelector('#ed_conj_restante').value.trim();
          cR = cRraw === '' ? null : (parseFloat(cRraw) || 0);
          cU = Math.max(0, parseFloat(overlay.querySelector('#ed_conj_unidades').value) || 0);
        }

        // Total = packs cerrados × contenido + unidades sueltas.
        //
        // `unidades` son SOLO los packs cerrados y `restante` las sueltas: los dos
        // se suman sin descontar nada. Cuando se abre un pack, baja de `unidades`
        // y su contenido pasa a `restante`, así que nunca se cuentan dos veces. Si
        // una variedad tiene su propio `contenido`, se usa ese; si no, el global.
        //
        // Antes se restaba un pack cuando había sueltos, dando por hecho que los
        // sueltos salían de una caja ya contada en `unidades`. Por eso el total
        // guardado quedaba corto un pack por variedad —una resma de 500 hojas en
        // los papeles— mientras la grilla, que nunca restó, mostraba otro número.
        let cTotal;
        if (tieneColores) {
          cTotal = coloresArr.reduce((acc, c) => {
            const u = c.unidades || 0;
            const r = c.restante || 0;
            const contenidoFila = (c.contenido && c.contenido > 0) ? c.contenido : cC;
            return acc + (u * contenidoFila) + r;
          }, 0);
        } else {
          cTotal = cU * cC + (cR || 0);
        }

        conjuntoFields = {
          es_conjunto:           true,
          conjunto_packs_cerrados: true,
          conjunto_tipo:         cTipo,
          conjunto_unidad_medida: cUM,
          conjunto_unidades:     cU,
          conjunto_contenido:    cC,
          conjunto_restante:     cR,
          conjunto_precio_unidad: cP,
          conjunto_total:        cTotal,
          conjunto_colores:      tieneColores ? coloresArr : null,
        };
        // Sincronizar el stock clásico con el total calculado del conjunto.
        // Así el POS que aún no soporta "Producto Conjunto" sigue viendo un stock
        // razonable, y el campo no queda con basura del input oculto.
        nuevoStock = Math.max(0, Math.floor(Number(cTotal) || 0));
      } else {
        conjuntoFields = {
          es_conjunto:           false,
          conjunto_packs_cerrados: null,
          conjunto_tipo:         null,
          conjunto_unidad_medida: null,
          conjunto_unidades:     null,
          conjunto_contenido:    null,
          conjunto_restante:     null,
          conjunto_precio_unidad: null,
          conjunto_total:        null,
          conjunto_colores:      null,
        };
      }

      // Vínculos a productos fuente (consumibles, nivel producto).
      // Array `vinculaciones[]` con N entries. Funciona para no-conjunto y para
      // conjuntos sin variedades. Si el conjunto tiene variedades, el watcher
      // prioriza los vínculos per-variedad e ignora éstos — guardamos igual por
      // si después se quitan las variedades y queda como conjunto simple.
      // Replicamos el primer entry en los campos legacy (vinculado_a/...) para
      // compat con código que aún lee single-link.
      let vincsProd = [];
      try { vincsProd = JSON.parse(overlay.dataset.vincs || '[]'); } catch { vincsProd = []; }
      vincsProd = vincsProd
        .filter(v => v && v.doc_id && Number(v.cantidad) > 0)
        .map(v => ({
          doc_id: String(v.doc_id),
          cantidad: Number(v.cantidad),
          nombre: v.nombre || '',
        }));
      const vinculadoFields = vincsProd.length > 0 ? {
        vinculaciones:      vincsProd,
        vinculado_a:        vincsProd[0].doc_id,
        vinculado_cantidad: vincsProd[0].cantidad,
        vinculado_nombre:   vincsProd[0].nombre || null,
      } : {
        vinculaciones:      null,
        vinculado_a:        null,
        vinculado_cantidad: null,
        vinculado_nombre:   null,
      };

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
        stock_alerta_um:      _avisaPorBulto ? 'bulto' : null,
        // Sólo para productos no-conjunto: en los conjuntos el envase ya vive en
        // conjunto_tipo/conjunto_contenido y duplicarlo se desincronizaría.
        bulto_tipo:           (_avisaPorBulto && !esConjunto) ? _bultoGuardar.tipo : null,
        bulto_contenido:      (_avisaPorBulto && !esConjunto) ? _bultoGuardar.contenido : null,
        estado:               nuevoCosto === 0 ? 'sin_precio' : 'activo',
        ...conjuntoFields,
        ...vinculadoFields,
        ultima_actualizacion: serverTimestamp(),
      };

      // Setear el flag de edit local ANTES del updateDoc — el snapshot del
      // server puede llegar mientras el await está pendiente, y necesitamos
      // que main.js ya vea el flag para no re-renderizar la página entera.
      try { window.__catalogoLocalEditUntil = Date.now() + 8000; } catch(_) {}

      try {
        let docIdFinal;
        let idNumFinal;

        if (esNuevo) {
          // Modo CREAR: el doc_id es el código interno. Validamos que sea único
          // contra todo el catálogo en memoria (no debería pasar si usó Generar).
          if (!nuevoCodigo) {
            alertDialog({ title: 'Falta el código', message: 'El código interno es obligatorio. Tocá "Generar" o cargá uno manualmente.', type: 'warning' });
            btn.disabled = false; btn.innerHTML = _btnLabel; return;
          }
          const yaExiste = allProductos.some(p =>
            (p.codigo || '').toString().trim() === nuevoCodigo ||
            (p.cod_barra || '').toString().trim() === nuevoCodigo ||
            (p.doc_id || '').toString().trim() === nuevoCodigo
          );
          if (yaExiste) {
            alertDialog({ title: 'Código repetido', message: `Ya existe un producto con el código <b>"${_escHtml(nuevoCodigo)}"</b>. Tocá "Generar" para obtener uno nuevo.`, type: 'warning' });
            btn.disabled = false; btn.innerHTML = _btnLabel; return;
          }

          // Reservar próximo pos_id_counter (ID numérico que el POS usa).
          idNumFinal = Date.now();
          try {
            const cfgRef = doc(db, 'config', 'pos_id_counter');
            const cfgSnap = await getDoc(cfgRef);
            idNumFinal = (cfgSnap.exists() ? (cfgSnap.data().last_id || 12938) : 12938) + 1;
            await setDoc(cfgRef, { last_id: idNumFinal });
          } catch(e2) {
            console.warn('pos_id_counter no disponible, uso timestamp:', e2.message);
          }

          docIdFinal = nuevoCodigo;
          const createDoc = {
            ...update,
            id:                  idNumFinal,
            fecha_creacion:      serverTimestamp(),
            duplicado:           false,
          };
          await setDoc(doc(db, 'catalogo', docIdFinal), createDoc);
          // El código pudo ser de un producto borrado: si queda su lápida, el
          // POS borra este producto nuevo apenas lo baja.
          await levantarLapida(db, docIdFinal);
        } else {
          docIdFinal = prod.doc_id;
          idNumFinal = prod.id || docIdFinal;
          await updateDoc(doc(db, 'catalogo', docIdFinal), update);
        }

        invalidateCacheByPrefix('catalogo');
        _touchCatalogoMeta(db).catch(() => {});

        // La ficha también mueve stock, y hasta ahora era la única puerta que
        // no dejaba rastro: 366 productos con el stock cambiado por fuera del
        // historial el 22-08, entre ellos las correcciones a mano de los papeles.
        try {
          const antesStk  = esNuevo ? 0 : (esConjunto ? numConj(prod.conjunto_total) : numConj(prod.stock));
          const despuesStk = esConjunto ? numConj(conjuntoFields.conjunto_total) : numConj(nuevoStock);
          if (antesStk !== despuesStk) {
            registrarMovimiento(db, {
              docId: docIdFinal, nombre: nuevoNombre || '',
              motivo: 'edicion_manual', antes: antesStk, despues: despuesStk,
              detalle: esNuevo ? 'Alta desde la ficha' : 'Ficha del producto',
            });
          }
        } catch (_) {}

        // Si está en la tienda, que la tienda lo vea ya: nombre, precio, stock,
        // pack, variedades. Antes esperaba al sync de las 6 horas.
        if (!esNuevo) {
          reflejarSiPublicado(db, docIdFinal, { ...prod, ...update, doc_id: docIdFinal }).catch(() => {});
        }

        // Sincronizar con inventario para que el POS reciba el precio actualizado.
        try {
          const invDocId = String(idNumFinal);
          const invUpdate = { ultima_actualizacion: serverTimestamp(), nombre: nuevoNombre || '' };
          if (nuevoPrecio !== undefined) invUpdate.precio = nuevoPrecio;
          if (nuevoStock !== undefined)  invUpdate.stock  = nuevoStock;
          if (nuevoCosto !== undefined)  invUpdate.costo  = nuevoCosto;
          invUpdate.id = parseInt(invDocId) || invDocId;
          await setDoc(doc(db, 'inventario', invDocId), invUpdate, { merge: true });
        } catch(e2) {
          console.warn('No se pudo actualizar inventario:', e2.message);
        }

        // Actualizar memoria local
        if (esNuevo) {
          const nuevoEnMemoria = {
            ...update,
            doc_id: docIdFinal,
            id:     idNumFinal,
          };
          allProductos.unshift(nuevoEnMemoria);
        } else {
          const idx = allProductos.findIndex(p => p.doc_id === prod.doc_id);
          if (idx !== -1) allProductos[idx] = { ...allProductos[idx], ...update };
          const idxF = filtrados.findIndex(p => p.doc_id === prod.doc_id);
          if (idxF !== -1) filtrados[idxF] = { ...filtrados[idxF], ...update };
        }

        // Registrar en el historial para poder deshacer (alta o edición).
        try {
          const _campos = { ...update };
          delete _campos.ultima_actualizacion;
          if (esNuevo) {
            hist.recordCreate(docIdFinal, { ..._campos, id: idNumFinal }, { label: `Crear ${nuevoNombre || docIdFinal}` });
          } else {
            const _before = {}, _after = {};
            for (const k of Object.keys(_campos)) {
              const ov = (k in prod ? prod[k] : null);
              if (JSON.stringify(ov) !== JSON.stringify(_campos[k])) { _before[k] = ov; _after[k] = _campos[k]; }
            }
            if (Object.keys(_after).length) hist.recordUpdate(docIdFinal, _before, _after, {
              label: `Editar ${nuevoNombre || docIdFinal}`, syncInv: true, invId: idNumFinal,
            });
          }
        } catch (_) {}

        cerrar();
        // Preservar búsqueda/filtros/página/scroll. aplicarFiltros() rebuildea
        // sólo el tbody (no toca el input #buscar ni los selects), así que en
        // teoría no se pierde nada — guardamos por las dudas el scrollY.
        const _scrollPrev = window.scrollY;
        aplicarFiltros();
        renderStats();
        window.scrollTo({ top: _scrollPrev });

      } catch(e) {
        alertDialog({ title: 'Error', message: (esNuevo ? 'No se pudo crear: ' : 'No se pudo guardar: ') + _escHtml(e.message), type: 'error' });
        btn.disabled = false;
        btn.innerHTML = _btnLabel;
      }
    });
  }

  function _setupPrecioUnitTooltip() {
    // Tooltip flotante para los íconos `info` con data-tip (soporta HTML)
    let tip = document.getElementById('cat-tip-precio-unit');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'cat-tip-precio-unit';
      tip.style.cssText = 'position:fixed;display:none;background:#1f2937;color:#fff;padding:8px 12px;border-radius:8px;font-size:12.5px;line-height:1.5;box-shadow:0 6px 20px rgba(0,0,0,0.25);z-index:10001;max-width:260px;pointer-events:none;white-space:nowrap';
      document.body.appendChild(tip);
    }
    document.querySelectorAll('.precio-unit-info').forEach(el => {
      el.addEventListener('mouseenter', () => {
        const html = el.getAttribute('data-tip') || '';
        if (!html) return;
        tip.innerHTML = '<b style="display:block;margin-bottom:4px;color:#c4b5fd">Precio unitario</b>' + html;
        tip.style.display = 'block';
        const r = el.getBoundingClientRect();
        const top = r.bottom + 6;
        const left = Math.min(r.left, window.innerWidth - 280);
        tip.style.top = top + 'px';
        tip.style.left = Math.max(8, left) + 'px';
      });
      el.addEventListener('mouseleave', () => {
        tip.style.display = 'none';
      });
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
      const _before = { [field]: (field in prod ? prod[field] : null) };
      const _after  = { [field]: nuevo };
      if (field === 'costo') {
        _before.estado = prod.estado ?? null;
        _after.estado  = nuevo === 0 ? 'sin_precio' : 'activo';
      }
      const _cambio = (parseFloat(prod[field]) || 0) !== nuevo;
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
        // Precio o stock tocados en la grilla: la tienda los ve al instante.
        if (_cambio && (field === 'precio_venta' || field === 'stock')) {
          reflejarSiPublicado(db, id, { ...allProductos[prodIdx], doc_id: id }).catch(() => {});
        }
        if (_cambio) hist.recordUpdate(id, _before, _after, {
          label: `${fieldLabel(field)} de ${prod.nombre || prod.name || id}`,
          syncInv: (field === 'stock' || field === 'precio_venta' || field === 'costo'),
          invId: prod.id || id,
        });
        aplicarFiltros();
        renderStats();
      } catch(e) {
        alertDialog({ title: 'Error', message: 'No se pudo guardar: ' + _escHtml(e.message), type: 'error' });
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
  // Fallback en vivo: lee los items crudos de ventas_por_dia (key pinned del
  // store) y los computa acá. Sólo se usa si el resumen no está disponible.
  async function _ventasPorDiaCrudo() {
    return getCached('historial:ventas_dia:v3', async () => {
      // orderBy por fecha_dt (Timestamp): el string `fecha` + limit recortaba el mes nuevo.
      const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha_dt', 'desc'), limit(5000))).catch(() => ({ docs: [] }));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    });
  }

  // Carga la velocidad de venta desde el resumen pinneado (inv:resumen) en vez
  // de reescanear miles de docs. Si el resumen está, llena ventasProd/ventasPorDia
  // al instante; si está vencido lo regenera en background; si no existe lo genera
  // bloqueando una vez (con fallback al cómputo en vivo).
  async function cargarVelocidadVentas() {
    if (ventasProd && ventasPorDia) return ventasProd;
    ensureCollections(['ventas_por_dia', 'inventario_resumen']);

    let resumen = peekCacheValue('inv:resumen');

    if (resumen && resumen.por_producto) {
      // Hay resumen → usarlo ya. Si venció, regenerar en background; el listener
      // del store (onStoreChange 'inventario_resumen') refresca cuando termina.
      if (resumenEstaVencido(resumen)) recomputarResumenInventario(db).catch(() => {});
    } else {
      // Sin resumen: generarlo (primera vez). Si falla, cómputo en vivo.
      const fresco = await recomputarResumenInventario(db, { force: true }).catch(() => null);
      if (fresco && fresco.por_producto) {
        resumen = fresco;
      } else {
        // Con el catálogo, para que lo que se vende fraccionado cuente sus
        // unidades reales y no la cantidad de packs.
        resumen = computarResumen(await _ventasPorDiaCrudo(), allProductos);
      }
    }

    ventasProd   = resumen.por_producto || {};
    ventasPorDia = resumen.por_dia || {};
    return ventasProd;
  }

  // ── Helpers de inventario consciente de variantes y vínculos ──────────────
  // Para productos conjunto, el stock real se computa desde las variedades
  // (unidades × contenido + restante por color), no desde p.stock que queda en 0.
  // Para productos VINCULADOS a otro de stock (vinculaciones / vinculado_a), el
  // stock propio no aplica: la disponibilidad sale del/los producto(s) fuente.

  // Vínculos normalizados de un producto: [{doc_id, cantidad}]. Soporta el
  // array nuevo `vinculaciones[]` y los campos legacy vinculado_a/cantidad.
  function _linksDe(p) {
    if (!p) return [];
    if (Array.isArray(p.vinculaciones) && p.vinculaciones.length > 0) {
      return p.vinculaciones
        .filter(v => v && v.doc_id && Number(v.cantidad) > 0)
        .map(v => ({ doc_id: String(v.doc_id), cantidad: Number(v.cantidad) }));
    }
    if (p.vinculado_a && Number(p.vinculado_cantidad) > 0) {
      return [{ doc_id: String(p.vinculado_a), cantidad: Number(p.vinculado_cantidad) }];
    }
    return [];
  }
  function _tieneLinks(p) { return _linksDe(p).length > 0; }

  // Stock físico de un producto conjunto (total de variedades, sin seguir vínculos).
  function _stockConjuntoFisico(p) {
    const variedades = Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [];
    if (variedades.length > 0) {
      const globalCont = Number(p.conjunto_contenido || 0);
      const total = variedades.reduce((acc, c) => {
        const u  = Number(c.unidades) || 0;
        const r  = Number(c.restante) || 0;
        return acc + (u * _contVariedad(c, globalCont) + r);
      }, 0);
      return Math.max(0, Math.round(total));
    }
    return Math.max(0, Math.round(Number(p.conjunto_total || 0)));
  }

  // Servicio sin control de stock (fotocopia, anillado, plastificado).
  // Lo dice la bandera `stock_ilimitado`, NO el número: a -1 llega solo
  // cualquier producto que se venda estando en cero, y mientras eso significaba
  // "servicio" el sistema dejaba de descontarlo para siempre. El -1 se sigue
  // leyendo acá sólo para los productos que todavía no migraron.
  function _esIlimitado(p) {
    if (!p) return false;
    return p.stock_ilimitado === true || Number(p.stock) === -1;
  }

  // Stock "base" de un target (lo que físicamente hay): conjunto → total de
  // variedades; si no, su stock crudo. -1 = servicio/ilimitado. No sigue los
  // vínculos del propio target (evita recursión).
  function _stockBaseDe(t) {
    if (!t) return 0;
    if (t.es_conjunto === true || t.es_conjunto === 1) return _stockConjuntoFisico(t);
    if (_esIlimitado(t)) return -1;
    return Math.max(0, Number(t.stock) || 0);
  }

  // Stock efectivo de un producto vinculado: cuántas unidades de ESTE se pueden
  // vender según sus targets = min( floor(stockTarget / cantidad) ). Devuelve -1
  // si TODOS los targets son ilimitados (servicio). Sin vínculos → su stock crudo.
  function _stockEfectivoLink(p) {
    const links = _linksDe(p);
    if (!links.length) return Math.max(0, Number(p && p.stock) || 0);
    let min = Infinity;
    for (const l of links) {
      const t = allProductos.find(x => x.doc_id === l.doc_id);
      const base = _stockBaseDe(t);
      if (base === -1) continue;             // target ilimitado: no restringe
      const cap = Math.floor(base / l.cantidad);
      if (cap < min) min = cap;
    }
    return (min === Infinity) ? -1 : Math.max(0, min);
  }

  // Para conteos/filtros/grilla: stock numérico a mostrar. Nunca negativo.
  // Vínculo → efectivo del fuente; -1 → Infinity (servicio); sobrevendido (<0) → 0.
  // (El comportamiento de conjunto lo maneja cada llamador por separado.)
  function _stockDisplay(p) {
    if (_tieneLinks(p)) {
      const eff = _stockEfectivoLink(p);
      return eff === -1 ? Infinity : Math.max(0, eff);
    }
    if (_esIlimitado(p)) return Infinity;   // servicio sin control de stock
    return Math.max(0, Number(p && p.stock) || 0);   // sobrevendido/negativo → 0
  }

  // Igual que _stockDisplay pero con el texto listo para mostrar ('∞' = servicio).
  function _stockShown(p) {
    const num = _stockDisplay(p);
    return { num, text: (num === Infinity ? '∞' : String(num)) };
  }

  function _stockEfectivoInv(p) {
    if (_tieneLinks(p)) {
      const eff = _stockEfectivoLink(p);
      return eff === -1 ? 0 : eff;   // valorización/sugeridos: ilimitado no suma capital
    }
    if (p && (p.es_conjunto === true || p.es_conjunto === 1)) return _stockConjuntoFisico(p);
    // Stock negativo (producto vendido sin reponer / sin cargar stock) = 0:
    // físicamente no existe stock negativo. Así estos productos aparecen como
    // "sin stock / a reponer" en vez de mostrar valores negativos y días raros.
    return Math.max(0, Number(p.stock) || 0);
  }

  function _variedadesDesgloseInv(p) {
    if (!p || !(p.es_conjunto === true || p.es_conjunto === 1)) return [];
    const variedades = Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [];
    if (!variedades.length) return [];
    const globalCont = Number(p.conjunto_contenido || 0);
    return variedades.map(c => {
      const cc = _contVariedad(c, globalCont);
      const u  = Number(c.unidades) || 0;
      const r  = Number(c.restante) || 0;
      return { color: c.color || '-', u, r, cont: cc, total: u * cc + r };
    });
  }

  // Devuelve {sg, pl, sym} según el tipo del producto (rollo/pack/caja/metros/items).
  function _unidadInv(p) {
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

  function calcularEstadoInv(p) {
    const stock = _stockEfectivoInv(p);
    const u = _unidadInv(p);
    const nombre = (p.nombre || '').toUpperCase().trim();
    const vData = ventasProd?.[nombre];
    const u30 = vData?.u30 || 0;
    const velocidadDiaria = u30 / 30;
    const stockMin = Math.max(0, Number(p.stock_min) || 0);

    const desglose = _variedadesDesgloseInv(p);
    const varAgotadas = desglose.filter(v => v.total === 0).map(v => v.color);
    // Variantes "cerca de 0": no agotadas pero con total <= 2 (unidades o metros).
    const varCriticas = desglose
      .filter(v => v.total > 0 && v.total <= 2)
      .map(v => ({ color: v.color, total: v.total }));

    const tieneVel = velocidadDiaria > 0;
    const dias = tieneVel ? Math.floor(stock / velocidadDiaria) : null;
    const rellenarPorMin       = stockMin > 0 && stock <= stockMin;
    const rellenarPorVelocidad = tieneVel && dias !== null && dias <= 10;
    const rellenarPorVariedad  = varAgotadas.length > 0 || varCriticas.length > 0;
    const rellenar = rellenarPorMin || rellenarPorVelocidad || rellenarPorVariedad;

    const extra = { unidad: u, rellenar, varAgotadas, varCriticas, stockMin };

    if (stock === 0) return { ...extra, label: `Sin ${u.pl}`, key: 'agotado', cls: 'badge-red', color: '#c62828', dias: 0, velocidad: velocidadDiaria, pct: 0 };

    if (tieneVel) {
      const pct = Math.min(100, Math.round((dias / 30) * 100));
      if (dias <= 3)  return { ...extra, label: `Pocos ${u.pl} · ${dias}d`,  key: 'critico',  cls: 'badge-red',    color: '#c62828', dias, velocidad: velocidadDiaria, pct };
      if (dias <= 10) return { ...extra, label: `Bajo · ${dias}d`,           key: 'bajo',     cls: 'badge-orange', color: '#f57c00', dias, velocidad: velocidadDiaria, pct };
      if (dias <= 20) return { ...extra, label: `Regular · ${dias}d`,        key: 'regular',  cls: 'badge-orange', color: '#e65100', dias, velocidad: velocidadDiaria, pct };
      return                 { ...extra, label: `OK · ${dias}d`,             key: 'ok',       cls: 'badge-green',  color: '#2e7d32', dias, velocidad: velocidadDiaria, pct };
    }
    if (stockMin > 0) {
      // Con aviso por caja/pack, el badge también habla en envases:
      // "Rellenar (1,5 / 3 cajas)" en vez de "Rellenar (18/36)".
      // Configurado por envase → el badge habla en envases. Sin configurar,
      // si el envase se puede deducir, se agrega la equivalencia entre paréntesis.
      const bAlerta = alertaPorBulto(p);
      const bAuto   = bAlerta ? null : bultoDe(p);
      const _lblRellenar = bAlerta
        ? `Rellenar (${textoBultos(stock, bAlerta, { exacto: true })} / ${textoBultos(stockMin, bAlerta, { exacto: true })})`
        : `Rellenar (${stock}/${stockMin})${bAuto && stock >= bAuto.contenido ? ` · ${textoBultos(stock, bAuto)}` : ''}`;
      if (stock <= stockMin)       return { ...extra, label: _lblRellenar, key: 'critico', cls: 'badge-red',    color: '#c62828', dias: null, velocidad: 0, pct: 10 };
      if (stock <= stockMin * 1.5) return { ...extra, label: 'Rellenar pronto',                 key: 'bajo',    cls: 'badge-orange', color: '#f57c00', dias: null, velocidad: 0, pct: 40 };
      return                              { ...extra, label: 'OK',                              key: 'ok',      cls: 'badge-green',  color: '#2e7d32', dias: null, velocidad: 0, pct: 100 };
    }
    if (stock <= 2)  return { ...extra, label: `Pocos ${u.pl}`, key: 'critico', cls: 'badge-red',    color: '#c62828', dias: null, velocidad: 0, pct: 10 };
    if (stock <= 5)  return { ...extra, label: 'Bajo',          key: 'bajo',    cls: 'badge-orange', color: '#f57c00', dias: null, velocidad: 0, pct: 40 };
    if (stock <= 15) return { ...extra, label: 'Regular',       key: 'regular', cls: 'badge-orange', color: '#e65100', dias: null, velocidad: 0, pct: 65 };
    return                 { ...extra, label: 'OK',             key: 'ok',      cls: 'badge-green',  color: '#2e7d32', dias: null, velocidad: 0, pct: 100 };
  }

  // Serie de 14 días en orden cronológico para el sparkline.
  function _serieVentas14d() {
    const out = [];
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    for (let i = 13; i >= 0; i--) {
      const d = new Date(hoy); d.setDate(d.getDate() - i);
      const k = `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
      out.push({ fecha: k, label: `${d.getDate()}/${d.getMonth()+1}`, total: (ventasPorDia && ventasPorDia[k]) || 0 });
    }
    return out;
  }

  function renderBannerCriticos() {
    const host = document.getElementById('invBanner');
    if (!host) return;
    if (!ventasProd) { host.innerHTML = ''; return; }
    const base = getBaseRubro();
    const lista = base.filter(p => !esPseudoProducto(p))
      .map(p => ({ ...p, _estado: calcularEstadoInv(p) }))
      .filter(p => _tieneSenalReposicion(p));
    const agotados = lista.filter(p => p._estado.key === 'agotado').length;
    const criticos = lista.filter(p => p._estado.key === 'critico').length;
    if (agotados + criticos === 0) { host.innerHTML = ''; return; }

    host.innerHTML = `
      <div class="inv-banner">
        <span class="material-icons" style="color:var(--tint-red-fg)">notification_important</span>
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

  // ── Tab Inventario (render progresivo) ──
  async function renderTabInventario(tc) {
    // Primer paint instantáneo: si el store ya tiene el resumen pinneado, poblar
    // la velocidad sincrónicamente para evitar el spinner "Calculando...".
    if (!ventasProd) {
      const r = peekCacheValue('inv:resumen');
      if (r && r.por_producto) { ventasProd = r.por_producto; ventasPorDia = r.por_dia || {}; }
    }
    const velocidadLista = !!ventasProd;

    // Recalcular lista con estados según velocidad actual
    function reconstruirLista() {
      const base = getBaseRubro();
      invListaActual = base.map(p => ({ ...p, _estado: calcularEstadoInv(p) }));
    }

    reconstruirLista();

    // Auto-chequeo de consistencia (una vez por montaje): reporta en consola
    // productos sin doc_id, stock/costo inválidos, conjuntos vacíos, nombres
    // duplicados y resumen vencido. No bloquea ni rompe la UI.
    if (!_invValidado) {
      _invValidado = true;
      try { validarInventario(allProductos, peekCacheValue('inv:resumen')); } catch (_) {}
    }

    const base = getBaseRubro();
    const cats = [...new Set(base.map(p => p.categoria || '').filter(Boolean))].sort();

    tc.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px">

        <!-- A. RESUMEN (stats) -->
        <div style="display:flex;flex-direction:column;gap:6px">
          <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;padding:0 4px">RESUMEN DEL INVENTARIO</div>
          <div class="cards-grid" id="invStatsGrid"></div>
        </div>

        <!-- E. BÚSQUEDA + BOTÓN DETALLE -->
        <div class="filter-bar" style="flex-wrap:wrap;gap:8px;align-items:center">
          <div style="position:relative;flex:1;min-width:220px;display:flex;align-items:center">
            <span class="material-icons" style="position:absolute;left:10px;font-size:20px;color:var(--text-muted);pointer-events:none">search</span>
            <input type="text" id="invFiltroNombre" placeholder="Buscar cualquier producto..." style="width:100%;padding:8px 12px 8px 38px;box-sizing:border-box" value="${invNombreFiltro}" />
          </div>
          <button id="btnInvConteo" type="button" class="inv-conteo-btn" title="Recontar el stock físico de la góndola y corregir diferencias">
            <span class="material-icons" style="font-size:16px">fact_check</span> Conteo físico
          </button>
          <button id="btnInvToggleTabla" type="button" style="padding:8px 14px;border-radius:8px;border:2px solid #1877f2;background:${invTablaVisible?'#1877f2':'var(--surface)'};color:${invTablaVisible?'#fff':'var(--tint-blue-fg)'};cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap;display:flex;align-items:center;gap:6px;font-family:inherit">
            <span class="material-icons" style="font-size:16px">${invTablaVisible?'expand_less':'view_list'}</span>
            ${invTablaVisible?'Ocultar detalle':'Ver detalle completo'}
          </button>
        </div>

        <!-- F. DETALLE: filtros + tabla (collapsable) -->
        <div id="invTablaWrap" style="display:${invTablaVisible?'block':'none'};flex-direction:column;gap:8px">
          <div class="filter-bar" style="flex-wrap:wrap;gap:8px">
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
            <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted)" title="Días de venta que querés cubrir con el stock — define la cantidad sugerida a comprar">
              <span class="material-icons" style="font-size:16px">event_repeat</span>
              <span style="white-space:nowrap">Cobertura</span>
              <select id="invCobertura" style="min-width:auto">
                <option value="15" ${invCoberturaDias===15?'selected':''}>15 días</option>
                <option value="30" ${invCoberturaDias===30?'selected':''}>30 días</option>
                <option value="45" ${invCoberturaDias===45?'selected':''}>45 días</option>
                <option value="60" ${invCoberturaDias===60?'selected':''}>60 días</option>
              </select>
            </div>
            <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
              <button id="invBtnCSV" type="button" class="inv-export-btn" title="Descargar el detalle filtrado en CSV (Excel)">
                <span class="material-icons" style="font-size:16px">file_download</span> CSV
              </button>
              <button id="invBtnPrint" type="button" class="inv-export-btn" title="Imprimir / guardar como PDF el detalle filtrado">
                <span class="material-icons" style="font-size:16px">print</span> Imprimir
              </button>
            </div>
          </div>

          <div class="table-card">
            <div class="table-card-header">
              <h3>Detalle de productos${rubroActivo !== 'TODOS' ? ' — ' + rubroActivo.charAt(0) + rubroActivo.slice(1).toLowerCase() : ''}</h3>
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

        <!-- ACCIÓN PRINCIPAL: REPOSICIÓN -->
        <div id="invListaCompras"></div>

        <!-- ANÁLISIS — secciones colapsables (cerradas por defecto, se expanden a demanda) -->
        <div id="invVelLoading"></div>
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;padding:6px 4px 0">ANÁLISIS</div>
        <div id="invValorizacion"></div>
        <div id="invSparkline"></div>
        <div id="invTopMovers"></div>
        <div id="invVariantesAgotadas"></div>
        <div id="invSobrestock"></div>
        <div id="invABC"></div>
        <div id="invMargen"></div>
        <div id="invSalud"></div>
      </div>
    `;

    // Si todavía no tenemos la velocidad, mostrar indicador no-bloqueante
    if (!velocidadLista) {
      const indic = document.getElementById('invVelLoading');
      if (indic) indic.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--tint-blue-bg);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--tint-blue-fg)">
          <div style="width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--tint-blue-fg);border-radius:50%;animation:spin 0.8s linear infinite"></div>
          Calculando velocidad de ventas... (la tabla y la lista de compras se refrescan automáticamente)
        </div>`;
    }

    renderInvStats();
    renderInvValorizacion();
    renderInvSparkline();
    renderInvTopMovers();
    renderInvVariantesAgotadas();
    renderListaCompras();
    renderInvSobrestock();
    renderInvABC();
    renderInvMargen();
    renderInvSalud();

    // Búsqueda: si hay texto, abrimos la tabla automáticamente (es donde se ve
    // el resultado). Al limpiar la búsqueda no la cerramos, queda como el
    // usuario la dejó.
    const inpBuscar = document.getElementById('invFiltroNombre');
    if (inpBuscar) {
      inpBuscar.addEventListener('input', () => {
        invNombreFiltro = inpBuscar.value || '';
        if (invNombreFiltro.trim() && !invTablaVisible) {
          invTablaVisible = true;
          mostrarTablaInv(true);
        }
        applyInvFilters();
      });
    }

    ['invFiltroCat','invFiltroEstado','invFiltroMov'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => {
        invCatFiltro    = document.getElementById('invFiltroCat')?.value || '';
        invEstadoFiltro = document.getElementById('invFiltroEstado')?.value || '';
        invMovFiltro    = document.getElementById('invFiltroMov')?.value || '';
        applyInvFilters();
      });
    });

    // Cobertura objetivo: recalcula los sugeridos del detalle y de la lista de compras.
    document.getElementById('invCobertura')?.addEventListener('change', (e) => {
      invCoberturaDias = parseInt(e.target.value) || 30;
      applyInvFilters();
      renderListaCompras();
    });
    document.getElementById('invBtnCSV')?.addEventListener('click', exportarInventarioCSV);
    document.getElementById('invBtnPrint')?.addEventListener('click', imprimirInventario);

    // Toggle "Ver detalle completo" — muestra/oculta la tabla detallada.
    document.getElementById('btnInvToggleTabla')?.addEventListener('click', () => {
      invTablaVisible = !invTablaVisible;
      mostrarTablaInv(invTablaVisible);
      if (invTablaVisible) applyInvFilters();
    });
    document.getElementById('btnInvConteo')?.addEventListener('click', abrirConteoFisico);

    if (invTablaVisible) applyInvFilters();

    // Si la velocidad no estaba precargada, la traemos en background y refrescamos
    if (!velocidadLista) {
      cargarVelocidadVentas().then(() => {
        reconstruirLista();
        const indic = document.getElementById('invVelLoading');
        if (indic) indic.innerHTML = '';
        renderInvStats();
        renderInvValorizacion();
        renderInvSparkline();
        renderInvTopMovers();
        renderInvVariantesAgotadas();
        renderListaCompras();
        renderInvSobrestock();
        renderInvABC();
        renderInvMargen();
        renderInvSalud();
        if (invTablaVisible) applyInvFilters();
      });
    }
  }

  function mostrarTablaInv(visible) {
    const wrap = document.getElementById('invTablaWrap');
    const btn  = document.getElementById('btnInvToggleTabla');
    if (wrap) wrap.style.display = visible ? 'flex' : 'none';
    if (btn) {
      btn.style.background = visible ? '#1877f2' : 'var(--surface)';
      btn.style.color      = visible ? '#fff'    : 'var(--tint-blue-fg)';
      btn.innerHTML = `
        <span class="material-icons" style="font-size:16px">${visible?'expand_less':'view_list'}</span>
        ${visible?'Ocultar detalle':'Ver detalle completo'}`;
    }
  }

  function renderInvStats() {
    const grid = document.getElementById('invStatsGrid');
    if (!grid) return;
    const total       = invListaActual.length;
    const enMovim     = invListaActual.filter(p => p._estado.velocidad > 0).length;
    const sinStock    = invListaActual.filter(p => _stockEfectivoInv(p) === 0).length;
    const aRellenar   = invListaActual.filter(p => !esPseudoProducto(p) && p._estado.rellenar).length;
    const variantes0  = invListaActual.reduce((acc, p) => acc + (p._estado.varAgotadas?.length || 0) + (p._estado.varCriticas?.length || 0), 0);
    const cs = 'cursor:pointer;transition:transform 0.15s,box-shadow 0.15s';

    grid.innerHTML = `
      <div class="card stat-card inv-stat" data-filtro="" style="${cs}" title="Ver todos"><div class="icon-wrap bg-blue"><span class="material-icons">inventory_2</span></div><div class="label">Total productos</div><div class="value">${total}</div></div>
      <div class="card stat-card inv-stat" data-filtro="con" style="${cs}" title="Ver en movimiento"><div class="icon-wrap" style="background:#7b1fa2"><span class="material-icons">trending_up</span></div><div class="label">En movimiento</div><div class="value">${enMovim}</div></div>
      <div class="card stat-card inv-stat" data-filtro="rellenar" style="${cs}" title="Productos a rellenar"><div class="icon-wrap bg-orange"><span class="material-icons">notifications_active</span></div><div class="label">A rellenar</div><div class="value">${aRellenar}</div></div>
      <div class="card stat-card inv-stat" data-filtro="agotado" style="${cs}" title="Sin stock"><div class="icon-wrap bg-red"><span class="material-icons">remove_shopping_cart</span></div><div class="label">Sin stock</div><div class="value">${sinStock}</div></div>
      <div class="card stat-card inv-stat" data-filtro="variantes" style="${cs}" title="Variedades en 0 o cerca de 0"><div class="icon-wrap" style="background:#d32f2f"><span class="material-icons">palette</span></div><div class="label">Variantes bajas</div><div class="value">${variantes0}</div></div>
    `;
    grid.querySelectorAll('.inv-stat').forEach(card => {
      card.addEventListener('mouseenter', () => { card.style.transform='translateY(-3px)'; card.style.boxShadow='0 6px 20px rgba(0,0,0,0.1)'; });
      card.addEventListener('mouseleave', () => { card.style.transform=''; card.style.boxShadow=''; });
      card.addEventListener('click', () => {
        const f = card.dataset.filtro;
        if (f === 'variantes') {
          document.getElementById('invVariantesAgotadas')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (f === 'rellenar') {
          document.getElementById('invListaCompras')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        // Otros filtros abren la tabla detallada y aplican el filtro.
        if (!invTablaVisible) { invTablaVisible = true; mostrarTablaInv(true); }
        const selE = document.getElementById('invFiltroEstado');
        const selM = document.getElementById('invFiltroMov');
        if (f === 'con') { if (selE) selE.value=''; if (selM) selM.value='con'; invEstadoFiltro=''; invMovFiltro='con'; }
        else             { if (selE) selE.value=f; if (selM) selM.value=''; invEstadoFiltro=f; invMovFiltro=''; }
        applyInvFilters();
        document.querySelector('.table-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  // Sparkline SVG — barras de ventas por día (14 días). Una sola barra por día,
  // labels solo cada 3 días para no saturar, hover muestra cantidad exacta.
  function renderInvSparkline() {
    const el = document.getElementById('invSparkline');
    if (!el) return;
    const serie = _serieVentas14d();
    const total14d = serie.reduce((a, d) => a + d.total, 0);
    if (total14d === 0) { el.innerHTML = ''; return; }
    const max = Math.max(...serie.map(d => d.total), 1);
    const ult7 = serie.slice(-7).reduce((a, d) => a + d.total, 0);
    const prev7 = serie.slice(0, 7).reduce((a, d) => a + d.total, 0);
    const trendPct = prev7 > 0 ? Math.round(((ult7 - prev7) / prev7) * 100) : 0;
    const tColor = trendPct > 0 ? '#2e7d32' : trendPct < 0 ? '#c62828' : '#65676b';
    const tIco = trendPct > 0 ? 'trending_up' : trendPct < 0 ? 'trending_down' : 'trending_flat';
    const totalFmt = Math.round(total14d).toLocaleString('es-AR');
    const promedio = Math.round(total14d / serie.length).toLocaleString('es-AR');

    // Barras con DOM real (más fáciles de mostrar tooltips en CSS).
    const bars = serie.map((d, i) => {
      const pct = (d.total / max) * 100;
      const isToday = i === serie.length - 1;
      const showLabel = (i === 0) || (i === serie.length - 1) || (i % 3 === 0);
      return `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0" title="${d.label}: ${Math.round(d.total)} items">
          <div style="width:100%;height:60px;display:flex;align-items:flex-end;justify-content:center">
            <div style="width:80%;height:${Math.max(pct, 2)}%;background:${isToday ? '#7b1fa2' : '#c4b5fd'};border-radius:3px 3px 0 0;transition:opacity 0.15s"></div>
          </div>
          <div style="font-size:9px;color:${isToday ? 'var(--tint-purple-fg)' : 'var(--text-muted)'};font-weight:${isToday ? '700' : '500'};line-height:1;height:10px">${showLabel ? d.label : ''}</div>
        </div>`;
    }).join('');

    const body = `
      <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
        <div style="flex-shrink:0;min-width:160px">
          <div style="display:flex;align-items:baseline;gap:6px">
            <div style="font-size:28px;font-weight:800;color:var(--text);line-height:1">${totalFmt}</div>
            <div style="font-size:11px;color:var(--text-muted)">items en 14 días</div>
          </div>
          <div style="display:flex;align-items:center;gap:4px;margin-top:4px;font-size:11px;color:${tColor};font-weight:600">
            <span class="material-icons" style="font-size:14px">${tIco}</span>
            ${trendPct > 0 ? '+' : ''}${trendPct}% vs 7d previos
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:1px">${promedio} items/día promedio</div>
        </div>
        <div style="flex:1;min-width:240px;display:flex;gap:2px;align-items:flex-end;height:80px">
          ${bars}
        </div>
      </div>`;
    el.innerHTML = _invSeccionHTML('invSparkline', {
      icon: 'show_chart', color: 'var(--tint-purple-fg)',
      title: 'Tendencia de ventas (14 días)',
      subtitle: `${totalFmt} items · ${trendPct > 0 ? '+' : ''}${trendPct}% vs semana previa`,
      body,
    });
    _invSeccionWire(el);
  }

  // Cantidad sugerida a comprar = demanda REAL observada en 30 días (no se
  // extrapolan picos de una semana, para no sobre-comprar). La aceleración se
  // muestra como aviso, pero no infla el número.
  function _sugeridoDe(p) {
    const nombre = (p.nombre || '').toUpperCase().trim();
    const u30 = (ventasProd && ventasProd[nombre] ? (ventasProd[nombre].u30 || 0) : 0);
    return sugerirCantidad(u30 / 30, _stockEfectivoInv(p), Number(p.stock_min) || 0, invCoberturaDias);
  }

  // ¿Vale la pena reponerlo? Solo si tiene señal comercial real: se vendió
  // hace poco (velocidad > 0), tiene un stock mínimo configurado, o es un
  // conjunto con alguna variedad agotada/crítica. Esto evita que el catálogo
  // muerto (stock 0 y CERO ventas, nunca stockeado) inunde la reposición.
  function _tieneSenalReposicion(p) {
    const e = p._estado || {};
    return (e.velocidad > 0)
      || (Number(p.stock_min) || 0) > 0
      || (e.varAgotadas?.length || 0) > 0
      || (e.varCriticas?.length || 0) > 0;
  }

  // ── Secciones colapsables (chevron) ───────────────────────────────────────
  function _invSeccionHTML(id, { icon, color, title, subtitle, body, accent }) {
    const cerrada = invSeccionesCerradas.has(id);
    return `
      <div class="inv-section"${accent ? ` style="border-left:4px solid ${accent}"` : ''}>
        <button type="button" class="inv-section-head" data-sec="${id}">
          <span class="material-icons" style="font-size:20px;color:${color || 'var(--text-muted)'}">${icon}</span>
          <span class="inv-section-titles">
            <b>${title}</b>
            ${subtitle ? `<span>${subtitle}</span>` : ''}
          </span>
          <span class="material-icons inv-section-chevron">${cerrada ? 'expand_more' : 'expand_less'}</span>
        </button>
        <div class="inv-section-body" style="display:${cerrada ? 'none' : 'block'}">${body}</div>
      </div>`;
  }
  function _invSeccionWire(host) {
    host.querySelectorAll('.inv-section-head').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.sec;
        const body = btn.parentElement.querySelector('.inv-section-body');
        const chev = btn.querySelector('.inv-section-chevron');
        if (invSeccionesCerradas.has(id)) {
          invSeccionesCerradas.delete(id); if (body) body.style.display = 'block'; if (chev) chev.textContent = 'expand_less';
        } else {
          invSeccionesCerradas.add(id); if (body) body.style.display = 'none'; if (chev) chev.textContent = 'expand_more';
        }
      });
    });
  }

  // ── Valorización de stock (capital invertido / valor a la venta) ──────────
  function renderInvValorizacion() {
    const el = document.getElementById('invValorizacion');
    if (!el) return;
    const val = valorizarStock(invListaActual, _stockEfectivoInv);
    if (val.totalCosto === 0 && val.totalVenta === 0) { el.innerHTML = ''; return; }
    const ganancia = val.totalVenta - val.totalCosto;
    const margen = val.totalCosto > 0 ? Math.round((ganancia / val.totalCosto) * 100) : 0;
    const ambito = rubroActivo !== 'TODOS' ? rubroActivo.charAt(0) + rubroActivo.slice(1).toLowerCase() : 'todas las secciones';

    const cards = `
      <div class="inv-val-cards">
        <div class="inv-val-card">
          <div class="inv-val-label"><span class="material-icons" style="font-size:15px;color:var(--tint-blue-fg)">payments</span> Capital invertido</div>
          <div class="inv-val-num">$${fmt(val.totalCosto)}</div>
          <div class="inv-val-sub">a precio de costo</div>
        </div>
        <div class="inv-val-card">
          <div class="inv-val-label"><span class="material-icons" style="font-size:15px;color:var(--tint-green-fg)">sell</span> Valor a la venta</div>
          <div class="inv-val-num" style="color:var(--tint-green-fg)">$${fmt(val.totalVenta)}</div>
          <div class="inv-val-sub">si se vende todo</div>
        </div>
        <div class="inv-val-card">
          <div class="inv-val-label"><span class="material-icons" style="font-size:15px;color:var(--tint-purple-fg)">trending_up</span> Ganancia potencial</div>
          <div class="inv-val-num" style="color:var(--tint-purple-fg)">$${fmt(ganancia)}</div>
          <div class="inv-val-sub">${margen}% de markup</div>
        </div>
      </div>`;

    // Desglose por rubro solo cuando miramos TODOS (si hay un rubro activo, el
    // total ya está acotado a ese rubro).
    let desglose = '';
    if (rubroActivo === 'TODOS' && val.porRubro.length > 1) {
      const top = val.porRubro.slice(0, 8);
      const maxC = Math.max(...top.map(r => r.costo), 1);
      desglose = `
        <div class="inv-val-rubros">
          ${top.map(r => {
            const w = Math.round((r.costo / maxC) * 100);
            const nombre = r.rubro === 'SIN RUBRO' ? 'Sin rubro' : r.rubro.charAt(0) + r.rubro.slice(1).toLowerCase();
            return `
              <div class="inv-val-rubro-row">
                <div class="inv-val-rubro-name" title="${nombre}">${nombre}</div>
                <div class="inv-val-rubro-bar"><div style="width:${w}%"></div></div>
                <div class="inv-val-rubro-amt">$${fmt(r.costo)}</div>
              </div>`;
          }).join('')}
        </div>`;
    }

    el.innerHTML = _invSeccionHTML('invValorizacion', {
      icon: 'savings', color: 'var(--tint-green-fg)',
      title: 'Valorización de stock',
      subtitle: `$${fmt(val.totalCosto)} invertidos · vale $${fmt(val.totalVenta)} a la venta`,
      accent: '#2e7d32',
      body: cards + desglose,
    });
    _invSeccionWire(el);
  }

  // ── Sobrestock / capital dormido ──────────────────────────────────────────
  // Productos con stock y costo pero SIN ventas en 90 días: plata parada.
  function renderInvSobrestock() {
    const el = document.getElementById('invSobrestock');
    if (!el) return;
    if (!ventasProd) { el.innerHTML = ''; return; } // esperar velocidad

    const lista = invListaActual
      .map(p => {
        const nombre = (p.nombre || '').toUpperCase().trim();
        const u90 = ventasProd[nombre]?.u90 || 0;
        const stk = _stockEfectivoInv(p);
        const capital = stk * (Number(p.costo) || 0);
        return { p, u90, stk, capital };
      })
      .filter(x => x.u90 === 0 && x.stk > 0 && x.capital > 0)
      .sort((a, b) => b.capital - a.capital)
      .slice(0, 20);

    if (!lista.length) { el.innerHTML = ''; return; }
    const totalDormido = lista.reduce((s, x) => s + x.capital, 0);

    const filas = lista.map(({ p, stk, capital }) => {
      const u = p._estado.unidad || _unidadInv(p);
      return `
        <tr style="border-top:1px solid var(--border)">
          <td style="padding:7px 10px"><b style="font-size:12px">${p.nombre || '-'}</b><div style="font-size:10px;color:var(--text-muted)">${p.categoria || p.rubro || '-'}</div></td>
          <td style="padding:7px 10px;text-align:center;font-weight:700">${stk}<span style="font-size:9px;color:var(--text-muted);margin-left:2px">${u.sym}</span></td>
          <td style="padding:7px 10px;text-align:right;color:var(--text-muted)">$${fmt(p.costo || 0)}</td>
          <td style="padding:7px 10px;text-align:right;font-weight:700;color:#1565c0">$${fmt(capital)}</td>
        </tr>`;
    }).join('');

    const body = `
      <div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead style="background:var(--surface-2)">
            <tr>
              <th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--text-muted)">Producto</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;color:var(--text-muted)">Stock</th>
              <th style="padding:8px 10px;text-align:right;font-size:11px;color:var(--text-muted)">Costo un.</th>
              <th style="padding:8px 10px;text-align:right;font-size:11px;color:var(--text-muted)">Capital parado</th>
            </tr>
          </thead>
          <tbody>${filas}</tbody>
        </table>
      </div>`;

    el.innerHTML = _invSeccionHTML('invSobrestock', {
      icon: 'ac_unit', color: '#1565c0',
      title: 'Capital dormido',
      subtitle: `${lista.length} productos con stock y sin ventas en 90 días · $${fmt(totalDormido)} parados`,
      accent: '#1565c0',
      body,
    });
    _invSeccionWire(el);
  }

  // ── Análisis ABC (Pareto) por facturación de 30 días ─────────────────────
  function renderInvABC() {
    const el = document.getElementById('invABC');
    if (!el) return;
    if (!ventasProd) { el.innerHTML = ''; return; }
    const conRev = invListaActual
      .filter(p => !esPseudoProducto(p))
      .map(p => {
        const nombre = (p.nombre || '').toUpperCase().trim();
        const u30 = ventasProd[nombre]?.u30 || 0;
        const precio = Number(p.precio_venta || p.precio) || 0;
        return { p, rev: u30 * precio, u30 };
      })
      .filter(x => x.rev > 0)
      .sort((a, b) => b.rev - a.rev);
    if (!conRev.length) { el.innerHTML = ''; return; }

    const totalRev = conRev.reduce((s, x) => s + x.rev, 0);
    const clases = { A: [], B: [], C: [] };
    let acumAntes = 0;
    conRev.forEach(x => {
      const pctAntes = (acumAntes / totalRev) * 100;
      x.cls = pctAntes < 80 ? 'A' : pctAntes < 95 ? 'B' : 'C';
      clases[x.cls].push(x);
      acumAntes += x.rev;
    });
    const revDe = arr => arr.reduce((s, x) => s + x.rev, 0);
    const card = (cls, color, desc) => {
      const arr = clases[cls];
      const pct = Math.round((revDe(arr) / totalRev) * 100);
      return `
        <div class="inv-val-card" style="border-left:3px solid ${color}">
          <div class="inv-val-label"><b style="color:${color};font-size:14px">${cls}</b> · ${desc}</div>
          <div class="inv-val-num">${arr.length}<span style="font-size:12px;color:var(--text-muted);font-weight:600"> prod.</span></div>
          <div class="inv-val-sub">${pct}% de la facturación</div>
        </div>`;
    };
    const topA = clases.A.slice(0, 6).map((x, i) =>
      `<div class="repos-item" style="cursor:default">
        <div style="width:18px;font-size:11px;font-weight:800;color:#2e7d32;flex-shrink:0">${i + 1}</div>
        <div class="repos-item-main">
          <div class="repos-item-name">${x.p.nombre || '-'}</div>
          <div class="repos-item-figs">${x.u30} vendidos (30d) · facturó $${fmt(x.rev)}</div>
        </div>
      </div>`).join('');

    const body = `
      <div class="inv-val-cards">
        ${card('A', '#2e7d32', 'los que más facturan')}
        ${card('B', '#f57c00', 'intermedios')}
        ${card('C', '#90a4ae', 'cola larga')}
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin:10px 0 6px"><b>${clases.A.length}</b> productos (clase A) concentran la mayor parte de la facturación — priorizá no quedarte sin ellos.</div>
      <div style="display:flex;flex-direction:column;gap:6px">${topA}</div>`;

    el.innerHTML = _invSeccionHTML('invABC', {
      icon: 'leaderboard', color: '#2e7d32',
      title: 'Análisis ABC (dónde está la plata)',
      subtitle: `Por facturación de 30 días · ${conRev.length} productos con ventas`,
      accent: '#2e7d32',
      body,
    });
    _invSeccionWire(el);
  }

  // ── Margen / rentabilidad + alerta de venta a pérdida ─────────────────────
  function renderInvMargen() {
    const el = document.getElementById('invMargen');
    if (!el) return;
    const conCosto = invListaActual
      .filter(p => !esPseudoProducto(p) && Number(p.costo) > 0 && Number(p.precio_venta || p.precio) > 0)
      .map(p => {
        const c = Number(p.costo);
        const v = Number(p.precio_venta || p.precio);
        const nombre = (p.nombre || '').toUpperCase().trim();
        const vel = ventasProd ? (ventasProd[nombre]?.u30 || 0) / 30 : 0;
        return { p, c, v, m: (v - c) / c * 100, vel };
      });
    if (!conCosto.length) { el.innerHTML = ''; return; }

    const perdida = conCosto.filter(x => x.v < x.c);
    const bajo    = conCosto.filter(x => x.v >= x.c && x.m < 15);
    const margenProm = Math.round(conCosto.reduce((s, x) => s + x.m, 0) / conCosto.length);
    // Problemas: pérdida primero (peor margen), luego margen bajo; los que se venden, arriba.
    const orden = (a, b) => (b.vel - a.vel) || (a.m - b.m);
    const problemas = [...perdida.sort(orden), ...bajo.sort(orden)].slice(0, 25);

    if (!problemas.length) {
      el.innerHTML = _invSeccionHTML('invMargen', {
        icon: 'percent', color: '#2e7d32',
        title: 'Margen y rentabilidad',
        subtitle: `Margen promedio ${margenProm}% · sin productos a pérdida`,
        accent: '#2e7d32',
        body: `<div style="font-size:12px;color:var(--text-muted)">Ningún producto se está vendiendo por debajo del costo ni con margen menor al 15%.</div>`,
      });
      _invSeccionWire(el);
      return;
    }

    const filas = problemas.map(x => {
      const esPerdida = x.v < x.c;
      const badge = esPerdida
        ? `<span class="badge badge-red" style="font-size:9px">A pérdida</span>`
        : `<span class="badge badge-orange" style="font-size:9px">Margen bajo</span>`;
      return `
        <tr style="border-top:1px solid var(--border)">
          <td style="padding:7px 10px"><b style="font-size:12px">${x.p.nombre || '-'}</b><div style="font-size:10px;color:var(--text-muted)">${x.p.categoria || x.p.rubro || '-'}</div></td>
          <td style="padding:7px 10px;text-align:right;color:var(--text-muted)">$${fmt(x.c)}</td>
          <td style="padding:7px 10px;text-align:right">$${fmt(x.v)}</td>
          <td style="padding:7px 10px;text-align:right;font-weight:800;color:${esPerdida ? '#c62828' : '#f57c00'}">${Math.round(x.m)}%</td>
          <td style="padding:7px 10px">${badge}</td>
          <td style="padding:7px 10px;text-align:center"><button class="inv-margen-edit" data-id="${x.p.doc_id}" title="Editar precio" style="background:none;border:none;cursor:pointer;color:var(--tint-blue-fg)"><span class="material-icons" style="font-size:16px">edit</span></button></td>
        </tr>`;
    }).join('');

    const body = `
      <div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead style="background:var(--surface-2)"><tr>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--text-muted)">Producto</th>
            <th style="padding:8px 10px;text-align:right;font-size:11px;color:var(--text-muted)">Costo</th>
            <th style="padding:8px 10px;text-align:right;font-size:11px;color:var(--text-muted)">Precio</th>
            <th style="padding:8px 10px;text-align:right;font-size:11px;color:var(--text-muted)">Margen</th>
            <th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--text-muted)">Estado</th>
            <th style="padding:8px 10px;text-align:center;font-size:11px;color:var(--text-muted)"></th>
          </tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>`;

    el.innerHTML = _invSeccionHTML('invMargen', {
      icon: 'percent', color: perdida.length ? '#c62828' : '#f57c00',
      title: 'Margen y rentabilidad',
      subtitle: `${perdida.length} a pérdida · ${bajo.length} margen bajo · promedio ${margenProm}%`,
      accent: perdida.length ? '#c62828' : '#f57c00',
      body,
    });
    _invSeccionWire(el);
    el.querySelectorAll('.inv-margen-edit').forEach(b => {
      b.addEventListener('click', () => {
        const p = allProductos.find(x => x.doc_id === b.dataset.id);
        if (p) abrirEditorCompleto(p);
      });
    });
  }

  // ── Salud de datos del catálogo (accionable) ──────────────────────────────
  function renderInvSalud() {
    const el = document.getElementById('invSalud');
    if (!el) return;
    const base = invListaActual.filter(p => !esPseudoProducto(p));
    const sinCosto  = base.filter(p => !(Number(p.costo) > 0));
    const sinPrecio = base.filter(p => !(Number(p.precio_venta || p.precio) > 0));
    const conjVacio = base.filter(p => (p.es_conjunto === true || p.es_conjunto === 1)
      && !(Array.isArray(p.conjunto_colores) && p.conjunto_colores.length) && !Number(p.conjunto_total));
    // Nombres duplicados (comparten velocidad de venta).
    const cuenta = {};
    base.forEach(p => { const n = (p.nombre || '').toUpperCase().trim(); if (n) cuenta[n] = (cuenta[n] || 0) + 1; });
    const dups = base.filter(p => cuenta[(p.nombre || '').toUpperCase().trim()] > 1);

    const grupos = [
      { key: 'costo',  label: 'Sin costo',         icon: 'money_off',     color: '#c62828', items: sinCosto,  hint: 'No se puede valorizar ni calcular margen.' },
      { key: 'precio', label: 'Sin precio',        icon: 'sell',          color: '#ef6c00', items: sinPrecio, hint: 'No se venden bien desde el POS.' },
      { key: 'dup',    label: 'Nombres duplicados', icon: 'content_copy',  color: '#7b1fa2', items: dups,      hint: 'Comparten/pisan la velocidad de venta.' },
      { key: 'conj',   label: 'Conjunto vacío',    icon: 'category',      color: '#1565c0', items: conjVacio, hint: 'Marcado como conjunto sin variedades cargadas.' },
    ].filter(g => g.items.length);

    if (!grupos.length) {
      el.innerHTML = _invSeccionHTML('invSalud', {
        icon: 'verified', color: '#2e7d32',
        title: 'Salud de datos del catálogo',
        subtitle: 'Sin problemas detectados',
        accent: '#2e7d32',
        body: `<div style="font-size:12px;color:var(--text-muted)">Todos los productos tienen costo, precio y datos consistentes.</div>`,
      });
      _invSeccionWire(el);
      return;
    }

    const body = grupos.map(g => `
      <div style="margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;margin-bottom:5px;color:${g.color}">
          <span class="material-icons" style="font-size:16px">${g.icon}</span>${g.label}
          <span style="background:${g.color};color:#fff;border-radius:99px;padding:0 7px;font-size:10px">${g.items.length}</span>
          <span style="font-weight:400;color:var(--text-muted);font-size:10px">— ${g.hint}</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${g.items.slice(0, 10).map(p => `<button class="inv-salud-edit" data-id="${p.doc_id}" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:5px 9px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:4px"><span class="material-icons" style="font-size:13px;color:var(--tint-blue-fg)">edit</span>${p.nombre || '-'}</button>`).join('')}
          ${g.items.length > 10 ? `<span style="font-size:11px;color:var(--text-muted);align-self:center">+${g.items.length - 10} más</span>` : ''}
        </div>
      </div>`).join('');

    const totalIssues = grupos.reduce((s, g) => s + g.items.length, 0);
    el.innerHTML = _invSeccionHTML('invSalud', {
      icon: 'health_and_safety', color: '#c62828',
      title: 'Salud de datos del catálogo',
      subtitle: `${totalIssues} productos con datos a revisar`,
      accent: '#c62828',
      body,
    });
    _invSeccionWire(el);
    el.querySelectorAll('.inv-salud-edit').forEach(b => {
      b.addEventListener('click', () => {
        const p = allProductos.find(x => x.doc_id === b.dataset.id);
        if (p) abrirEditorCompleto(p);
      });
    });
  }

  // ── Conteo físico / ajuste de stock ───────────────────────────────────────
  // Recontás la góndola por categoría: cargás lo contado, ves la diferencia y
  // aplicás sólo los cambios (escribe a catalogo + inventario, como Rellenar).
  function abrirConteoFisico() {
    // Incluye conjuntos: se cuentan por variedad con un botón aparte.
    const base = getBaseRubro().filter(p => !esPseudoProducto(p));
    const cats = [...new Set(base.map(p => p.categoria || 'Sin categoría'))].sort();
    const conteo = new Map(); // doc_id → contado

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="background:var(--surface);border-radius:16px;max-width:720px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,0.25);overflow:hidden">
        <div style="background:linear-gradient(135deg,#1565c0,#0d47a1);padding:16px 22px;color:#fff;display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:0.9">Conteo físico</div>
            <div style="font-size:16px;font-weight:700;margin-top:2px">Recontá y corregí el stock${rubroActivo !== 'TODOS' ? ' — ' + rubroActivo.charAt(0) + rubroActivo.slice(1).toLowerCase() : ''}</div>
          </div>
          <button id="cf_cerrar" style="background:rgba(255,255,255,0.18);border:none;cursor:pointer;color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center"><span class="material-icons">close</span></button>
        </div>
        <div style="padding:14px 22px;border-bottom:1px solid var(--border);display:flex;gap:10px;flex-wrap:wrap;align-items:center;background:var(--surface-2)">
          <select id="cf_cat" style="min-width:200px">
            <option value="">Elegí una categoría para recontar…</option>
            ${cats.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
          <input type="text" id="cf_buscar" placeholder="o buscar por nombre…" style="flex:1;min-width:160px;padding:8px 12px;box-sizing:border-box" />
          <span id="cf_resumen" style="font-size:12px;color:var(--text-muted);margin-left:auto"></span>
        </div>
        <div id="cf_lista" style="flex:1;overflow-y:auto;padding:8px 22px"></div>
        <div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--surface-2)">
          <span id="cf_diff" style="font-size:12px;color:var(--text-muted)"></span>
          <div style="display:flex;gap:8px">
            <button id="cf_cancel" style="padding:9px 18px;border-radius:8px;border:1.5px solid var(--border);background:var(--surface);cursor:pointer;font-size:13px;font-weight:600;color:var(--text-muted)">Cancelar</button>
            <button id="cf_aplicar" style="padding:9px 22px;border-radius:8px;border:none;background:#1565c0;color:#fff;cursor:pointer;font-size:13px;font-weight:700">Aplicar ajustes</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const listaEl = overlay.querySelector('#cf_lista');
    const catSel  = overlay.querySelector('#cf_cat');
    const buscar  = overlay.querySelector('#cf_buscar');
    const diffEl  = overlay.querySelector('#cf_diff');
    const resumenEl = overlay.querySelector('#cf_resumen');

    function _filtrar() {
      const cat = catSel.value;
      const q = (buscar.value || '').trim().toLowerCase();
      let prods = base;
      if (cat) prods = prods.filter(p => (p.categoria || 'Sin categoría') === cat);
      if (q) {
        const words = q.split(/\s+/).filter(Boolean);
        prods = prods.filter(p => {
          const hay = `${p.nombre||''} ${p.codigo||''} ${p.cod_barra||''}`.toLowerCase();
          return words.every(w => hay.includes(w));
        });
      }
      if (!cat && !q) { listaEl.innerHTML = `<div style="padding:30px;text-align:center;color:var(--text-muted);font-size:13px">Elegí una categoría o buscá un producto para empezar a contar.</div>`; resumenEl.textContent = ''; return; }
      prods = prods.slice(0, 300); // techo de seguridad
      resumenEl.textContent = `${prods.length} productos`;
      listaEl.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead style="position:sticky;top:0;background:var(--surface);z-index:1"><tr>
            <th style="text-align:left;padding:8px 6px;font-size:11px;color:var(--text-muted)">Producto</th>
            <th style="text-align:center;padding:8px 6px;font-size:11px;color:var(--text-muted)">Sistema</th>
            <th style="text-align:center;padding:8px 6px;font-size:11px;color:var(--text-muted)">Contado</th>
            <th style="text-align:center;padding:8px 6px;font-size:11px;color:var(--text-muted)">Dif.</th>
          </tr></thead>
          <tbody>
            ${prods.map(p => {
              const esConj = p.es_conjunto === true || p.es_conjunto === 1;
              if (esConj) {
                const sis = _stockEfectivoInv(p);
                const u = _unidadInv(p);
                return `<tr style="border-top:1px solid var(--border)" data-id="${p.doc_id}">
                  <td style="padding:6px"><b style="font-size:12px">${p.nombre || '-'}</b><div style="font-size:10px;color:var(--tint-purple-fg)">con variantes</div></td>
                  <td style="padding:6px;text-align:center;color:var(--text-muted)">${sis}${u.sym}</td>
                  <td colspan="2" style="padding:6px;text-align:center">
                    <button class="cf_variants" data-id="${p.doc_id}" style="background:#7b1fa2;border:none;color:#fff;cursor:pointer;padding:5px 10px;border-radius:6px;font-size:11px;font-weight:700;display:inline-flex;align-items:center;gap:4px;font-family:inherit"><span class="material-icons" style="font-size:13px">palette</span> Contar variantes</button>
                  </td>
                </tr>`;
              }
              const sis = Number(p.stock) || 0;
              const cont = conteo.has(p.doc_id) ? conteo.get(p.doc_id) : '';
              return `<tr style="border-top:1px solid var(--border)" data-id="${p.doc_id}">
                <td style="padding:6px"><b style="font-size:12px">${p.nombre || '-'}</b></td>
                <td style="padding:6px;text-align:center;color:var(--text-muted)">${sis}</td>
                <td style="padding:6px;text-align:center"><input type="number" class="cf_input" data-id="${p.doc_id}" data-sis="${sis}" value="${cont}" placeholder="${sis}" style="width:72px;text-align:center;padding:5px;border:1.5px solid var(--border);border-radius:6px;font-family:inherit;font-weight:700;box-sizing:border-box" /></td>
                <td class="cf_diff_cell" style="padding:6px;text-align:center;font-weight:700;color:var(--text-muted)">—</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
      listaEl.querySelectorAll('.cf_input').forEach(inp => {
        const sync = () => {
          const id = inp.dataset.id;
          const sis = Number(inp.dataset.sis) || 0;
          const val = inp.value.trim();
          const cell = inp.closest('tr').querySelector('.cf_diff_cell');
          if (val === '') { conteo.delete(id); cell.textContent = '—'; cell.style.color = 'var(--text-muted)'; _actualizarDiff(); return; }
          const n = parseInt(val); if (isNaN(n)) return;
          conteo.set(id, n);
          const d = n - sis;
          cell.textContent = d === 0 ? '0' : (d > 0 ? `+${d}` : `${d}`);
          cell.style.color = d === 0 ? 'var(--text-muted)' : d > 0 ? '#2e7d32' : '#c62828';
          _actualizarDiff();
        };
        inp.addEventListener('input', sync);
      });
      // Conjuntos: contar por variedad con el editor dedicado (sincroniza solo).
      listaEl.querySelectorAll('.cf_variants').forEach(b => {
        b.addEventListener('click', () => abrirModalRellenarInv(b.dataset.id));
      });
    }

    function _actualizarDiff() {
      let cambios = 0, neto = 0;
      conteo.forEach((cont, id) => {
        const p = base.find(x => x.doc_id === id); if (!p) return;
        const sis = Number(p.stock) || 0;
        if (cont !== sis) { cambios += 1; neto += (cont - sis); }
      });
      diffEl.textContent = cambios ? `${cambios} ajustes · neto ${neto > 0 ? '+' : ''}${neto} unidades` : 'Sin cambios cargados';
    }

    catSel.addEventListener('change', _filtrar);
    buscar.addEventListener('input', _filtrar);
    _filtrar();

    const cerrar = () => overlay.remove();
    overlay.querySelector('#cf_cerrar').addEventListener('click', cerrar);
    overlay.querySelector('#cf_cancel').addEventListener('click', cerrar);
    overlay.addEventListener('click', e => { if (e.target === overlay) cerrar(); });

    overlay.querySelector('#cf_aplicar').addEventListener('click', async () => {
      const ajustes = [];
      conteo.forEach((cont, id) => {
        const p = base.find(x => x.doc_id === id); if (!p) return;
        const sis = Number(p.stock) || 0;
        if (cont !== sis) ajustes.push({ p, sis, cont });
      });
      if (!ajustes.length) { alertDialog({ title: 'Sin cambios', message: 'No cargaste ningún conteo distinto al stock del sistema.', type: 'info' }); return; }
      if (!await confirmModal({ title: 'Ajustar stock', message: `Vas a ajustar el stock de <b>${ajustes.length}</b> producto(s) al valor contado. ¿Confirmás?`, confirmText: 'Ajustar' })) return;
      const btn = overlay.querySelector('#cf_aplicar');
      btn.disabled = true; btn.textContent = 'Aplicando…';
      let ok = 0;
      for (const a of ajustes) {
        const _docId = a.p.doc_id || a.p.id;
        try {
          await updateDoc(doc(db, 'catalogo', _docId), { stock: a.cont, ultima_actualizacion: serverTimestamp() });
          try {
            const invDocId = String(a.p.id || _docId);
            await setDoc(doc(db, 'inventario', invDocId), {
              stock: a.cont, nombre: a.p.nombre || '', id: parseInt(invDocId) || invDocId, ultima_actualizacion: serverTimestamp(),
            }, { merge: true });
          } catch (_) {}
          const idx = (allProductos || []).findIndex(x => (x.doc_id || x.id) === _docId);
          if (idx !== -1) allProductos[idx].stock = a.cont;
          await registrarMovimiento(db, {
            docId: _docId, nombre: a.p.nombre || '',
            motivo: 'conteo', antes: a.sis, despues: a.cont,
            detalle: 'Conteo físico',
          });
          avisarStockALaTienda(db, _docId, a.cont);
          ok += 1;
        } catch (e) { console.warn('conteo: error en', _docId, e.message); }
      }
      _touchCatalogoMeta(db).catch(() => {});
      invalidateCacheByPrefix('catalogo');
      btn.textContent = `${ok} ajustados`;
      setTimeout(() => {
        cerrar();
        const tc = document.getElementById('tabContent');
        if (tc) renderTabInventario(tc);
      }, 600);
    });
  }

  // ── Exportar / imprimir el detalle filtrado ───────────────────────────────
  function _invDatosExport() {
    return (invFiltradoActual && invFiltradoActual.length ? invFiltradoActual : invListaActual).map(p => {
      const e = p._estado;
      const stk = _stockEfectivoInv(p);
      const u = e.unidad || _unidadInv(p);
      const vel = e.velocidad || 0;
      const sug = sugerirCantidad(vel, stk, Number(p.stock_min) || 0, invCoberturaDias);
      return {
        nombre: p.nombre || '', categoria: p.categoria || '', rubro: p.rubro || '',
        stock: stk, unidad: u.pl, dias: (e.dias ?? ''), velocidad: vel ? vel.toFixed(2) : '0',
        estado: e.label || '', sugerido: sug,
        costo: Number(p.costo) || 0, precio: Number(p.precio_venta || p.precio) || 0,
        cod_barra: p.cod_barra || '',
      };
    });
  }

  function exportarInventarioCSV() {
    const datos = _invDatosExport();
    if (!datos.length) { alertDialog({ title: 'Sin datos', message: 'No hay productos para exportar.', type: 'info' }); return; }
    const cols = ['nombre','categoria','rubro','stock','unidad','dias','velocidad','estado','sugerido','costo','precio','cod_barra'];
    const head = ['Producto','Categoría','Rubro','Stock','Unidad','Días','Vel/día','Estado','Sugerido','Costo','Precio','Cód. barra'];
    const esc = v => {
      const s = String(v ?? '');
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // ';' como separador: Excel en es-AR lo abre en columnas directamente.
    const filas = datos.map(d => cols.map(c => esc(d[c])).join(';'));
    const csv = '﻿' + [head.join(';'), ...filas].join('\r\n'); // BOM → acentos OK en Excel
    const ambito = rubroActivo !== 'TODOS' ? '_' + rubroActivo.toLowerCase() : '';
    _descargarArchivo(`inventario${ambito}.csv`, csv, 'text/csv;charset=utf-8');
  }

  function _descargarArchivo(nombre, contenido, mime) {
    try {
      const blob = new Blob([contenido], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = nombre;
      document.body.appendChild(a); a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    } catch (e) {
      alertDialog({ title: 'Error', message: 'No se pudo descargar el archivo: ' + _escHtml(e.message), type: 'error' });
    }
  }

  function imprimirInventario() {
    const datos = _invDatosExport();
    if (!datos.length) { alertDialog({ title: 'Sin datos', message: 'No hay productos para imprimir.', type: 'info' }); return; }
    const ambito = rubroActivo !== 'TODOS' ? ' — ' + rubroActivo.charAt(0) + rubroActivo.slice(1).toLowerCase() : '';
    const hoy = new Date();
    const fechaTxt = `${String(hoy.getDate()).padStart(2,'0')}/${String(hoy.getMonth()+1).padStart(2,'0')}/${hoy.getFullYear()}`;
    const filas = datos.map(d => `
      <tr>
        <td>${d.nombre}</td><td>${d.categoria}</td>
        <td style="text-align:center">${d.stock} ${d.unidad}</td>
        <td style="text-align:center">${d.dias !== '' ? d.dias + 'd' : '—'}</td>
        <td style="text-align:center">${d.estado}</td>
        <td style="text-align:center;font-weight:700">${d.sugerido > 0 ? d.sugerido : '—'}</td>
        <td style="text-align:right">$${fmt(d.precio)}</td>
      </tr>`).join('');
    const win = window.open('', '_blank');
    if (!win) { alertDialog({ title: 'Popups bloqueados', message: 'Permití las ventanas emergentes para imprimir.', type: 'warning' }); return; }
    win.document.write(`
      <html><head><title>Inventario${ambito}</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111}
        h1{font-size:18px;margin:0 0 2px} .meta{font-size:12px;color:#666;margin-bottom:14px}
        table{width:100%;border-collapse:collapse;font-size:12px}
        th{background:#f0f0f0;text-align:left;padding:6px 8px;border-bottom:2px solid #999}
        td{padding:5px 8px;border-bottom:1px solid #ddd}
        tr:nth-child(even) td{background:#fafafa}
        @media print{ body{margin:10mm} }
      </style></head><body>
        <h1>Inventario${ambito}</h1>
        <div class="meta">Librería Liceo · ${fechaTxt} · ${datos.length} productos · Cobertura objetivo ${invCoberturaDias} días</div>
        <table>
          <thead><tr><th>Producto</th><th>Categoría</th><th>Stock</th><th>Días</th><th>Estado</th><th>Sugerido</th><th>Precio</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { try { win.print(); } catch (_) {} }, 300);
  }

  function renderInvTopMovers() {
    const el = document.getElementById('invTopMovers');
    if (!el) return;
    const top = invListaActual
      .filter(p => p._estado.velocidad > 0)
      .sort((a, b) => (b._estado.velocidad || 0) - (a._estado.velocidad || 0))
      .slice(0, 10);
    if (!top.length) { el.innerHTML = ''; return; }
    const max = Math.max(...top.map(p => p._estado.velocidad || 0), 0.01);
    const body = `
      <div style="display:flex;flex-direction:column;gap:5px">
        ${top.map((p, i) => {
          const u = p._estado.unidad || _unidadInv(p);
          const stk = _stockEfectivoInv(p);
          const vel = p._estado.velocidad || 0;
          const w = Math.round((vel / max) * 100);
          const lowStock = p._estado.key === 'critico' || p._estado.key === 'agotado';
          return `
          <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;background:${lowStock?'var(--tint-red-bg)':'var(--surface-2)'}">
            <div style="width:18px;font-size:11px;font-weight:700;color:var(--tint-purple-fg);flex-shrink:0">${i+1}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:600;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.nombre}</div>
              <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
                <div style="flex:1;background:var(--tint-purple-bg);border-radius:99px;height:4px;overflow:hidden">
                  <div style="width:${w}%;height:100%;background:#7b1fa2"></div>
                </div>
                <span style="font-size:10px;color:var(--tint-purple-fg);font-weight:700;min-width:46px;text-align:right">${vel.toFixed(1)} ${u.pl}/d</span>
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0;font-size:10px;color:${lowStock?'var(--tint-red-fg)':'var(--text-muted)'};font-weight:${lowStock?'700':'500'}">${stk} ${u.sym}</div>
          </div>`;
        }).join('')}
      </div>`;
    el.innerHTML = _invSeccionHTML('invTopMovers', {
      icon: 'trending_up', color: 'var(--tint-purple-fg)',
      title: 'Top en movimiento',
      subtitle: `Los ${top.length} que más se venden`,
      body,
    });
    _invSeccionWire(el);
  }

  function renderInvVariantesAgotadas() {
    const el = document.getElementById('invVariantesAgotadas');
    if (!el) return;
    const productos = invListaActual
      .filter(p => (p._estado.varAgotadas?.length || 0) > 0 || (p._estado.varCriticas?.length || 0) > 0)
      .sort((a, b) => {
        const aAg = a._estado.varAgotadas?.length || 0;
        const bAg = b._estado.varAgotadas?.length || 0;
        if (aAg !== bAg) return bAg - aAg;
        return (b._estado.varCriticas?.length || 0) - (a._estado.varCriticas?.length || 0);
      })
      .slice(0, 12);
    if (!productos.length) { el.innerHTML = ''; return; }
    const body = `
        <div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-muted);margin-bottom:8px">
          <span style="display:inline-block;width:10px;height:10px;border-radius:99px;background:#c62828"></span> Sin stock
          <span style="display:inline-block;width:10px;height:10px;border-radius:99px;background:#fb8c00;margin-left:6px"></span> Casi sin stock
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${productos.map(p => {
            const agot = p._estado.varAgotadas || [];
            const crit = p._estado.varCriticas || [];
            const um = (p._estado.unidad || _unidadInv(p)).sym;
            const chipsAgot = agot.slice(0, 8).map(v =>
              `<span style="background:var(--tint-red-bg);border:1px solid #c62828;color:var(--tint-red-fg);padding:2px 7px;border-radius:99px;font-size:10px;font-weight:700">${v} · 0</span>`
            ).join('');
            const chipsCrit = crit.slice(0, 8).map(v =>
              `<span style="background:var(--surface);border:1px solid #fb8c00;color:var(--tint-orange-fg);padding:2px 7px;border-radius:99px;font-size:10px;font-weight:600">${v.color} · ${v.total}${um}</span>`
            ).join('');
            const extra = Math.max(0, (agot.length - 8) + (crit.length - 8));
            return `
            <div style="background:var(--tint-yellow-bg);border:1px solid var(--border);border-radius:8px;padding:8px 10px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;font-weight:700;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.nombre}</div>
                <div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px">
                  ${chipsAgot}${chipsCrit}
                  ${extra > 0 ? `<span style="font-size:10px;color:var(--text-muted);align-self:center">+${extra}</span>` : ''}
                </div>
              </div>
              <button class="btn-rellenar-var" data-id="${p.doc_id}" style="background:#2e7d32;border:none;color:#fff;cursor:pointer;padding:5px 10px;border-radius:6px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:4px;font-family:inherit;flex-shrink:0">
                <span class="material-icons" style="font-size:14px">add</span>
                Rellenar
              </button>
            </div>`;
          }).join('')}
        </div>`;
    el.innerHTML = _invSeccionHTML('invVariantesAgotadas', {
      icon: 'palette', color: 'var(--tint-orange-fg)',
      title: 'Variantes bajas',
      subtitle: `${productos.length} productos con algún color/talle agotado o casi`,
      body,
    });
    _invSeccionWire(el);
    el.querySelectorAll('.btn-rellenar-var').forEach(btn => {
      btn.addEventListener('click', () => abrirModalRellenarInv(btn.dataset.id));
    });
  }

  // Agrupa productos de la lista de compras por rubro (orden alfabético).
  // Mantiene el orden de urgencia dentro de cada rubro.
  function agruparPorRubroCompras(items) {
    const mapa = {};
    items.forEach(p => {
      const r = (p.rubro || 'Sin rubro').toUpperCase();
      if (!mapa[r]) mapa[r] = [];
      mapa[r].push(p);
    });
    return Object.keys(mapa).sort((a, b) => {
      if (a === 'SIN RUBRO') return 1;
      if (b === 'SIN RUBRO') return -1;
      return a.localeCompare(b);
    }).map(r => ({ rubro: r, items: mapa[r] }));
  }

  // ── Lista de compras sugerida (agotados + críticos + bajos) ──
  // ── Análisis matemático de reposición por producto ────────────────────────
  // Usa u7/u30/u90 (resumen pinneado) para velocidad, tendencia (semana vs
  // promedio trimestral), días de cobertura, fecha estimada de quiebre y
  // proyección a 30 días.
  function _analisisReposicion(p) {
    const nombre = (p.nombre || '').toUpperCase().trim();
    const v = (ventasProd && ventasProd[nombre]) || { u7: 0, u30: 0, u90: 0 };
    const u7 = v.u7 || 0, u30 = v.u30 || 0, u90 = v.u90 || 0;
    const stock = _stockEfectivoInv(p);
    const u = p._estado.unidad || _unidadInv(p);
    const velDiaria  = u30 / 30;
    const velSemanal = u7 / 7;
    const velTrim    = u90 / 90;
    // Cobertura y proyección al ritmo REAL de 30 días (coherente con la sugerencia).
    const dias = velDiaria > 0 ? Math.floor(stock / velDiaria) : null;
    // Baseline trimestral (más estable); si no hay, comparar vs mensual.
    const base = velTrim > 0 ? velTrim : velDiaria;
    const trendPct = base > 0 ? Math.round((velSemanal / base - 1) * 100) : 0;
    const tendencia = !base ? 'sin-datos' : trendPct > 15 ? 'acelerando' : trendPct < -15 ? 'bajando' : 'estable';
    const proy30 = Math.round(velDiaria * 30);
    const sugerido = _sugeridoDe(p);
    const fechaAgote = (dias != null) ? new Date(Date.now() + dias * 86400000) : null;
    return { nombre, u, u7, u30, u90, stock, velDiaria, velSemanal, velTrim, dias, trendPct, tendencia, proy30, sugerido, fechaAgote };
  }

  // Recomendación escrita (HTML inline) a partir del análisis.
  function _textoRecomendacion(a, p) {
    const u = a.u;
    const f = n => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 1 });
    const fechaTxt = a.fechaAgote ? `${String(a.fechaAgote.getDate()).padStart(2,'0')}/${String(a.fechaAgote.getMonth()+1).padStart(2,'0')}` : null;
    const partes = [];
    if (a.u30 > 0) {
      partes.push(`Vendiste <b>${a.u30} ${a.u30 === 1 ? u.sg : u.pl}</b> en los últimos 30 días${a.u7 > 0 ? ` (<b>${a.u7}</b> en la última semana)` : ''}, un ritmo de ~<b>${f(a.velDiaria)}/día</b>.`);
      if (a.tendencia === 'acelerando')      partes.push(`Esta semana viene <b style="color:#2e7d32">acelerando +${a.trendPct}%</b> — es muy probable que se venda más.`);
      else if (a.tendencia === 'bajando')    partes.push(`Esta semana <b style="color:#c62828">bajó ${Math.abs(a.trendPct)}%</b> — cuidado con sobre-pedir.`);
      else                                   partes.push(`La demanda se mantiene <b>estable</b>.`);
      if (a.stock <= 0)                      partes.push(`Estás <b style="color:#c62828">sin stock</b> con demanda activa: reponé cuanto antes.`);
      else if (a.dias != null)               partes.push(`Con el stock actual (<b>${a.stock} ${u.pl}</b>) te alcanza para <b>~${a.dias} días</b>${fechaTxt ? ` — se agota aprox. el <b>${fechaTxt}</b>` : ''}.`);
      if (a.sugerido > 0) {
        partes.push(`Para cubrir <b>${invCoberturaDias} días</b> al ritmo real (~${f(a.velDiaria)}/día), conviene pedir <b style="color:#1565c0">${a.sugerido} ${a.sugerido === 1 ? u.sg : u.pl}</b>.`);
        if (a.tendencia === 'acelerando') partes.push(`Viene acelerando — si confiás en que el envión sigue, sumá unas pocas de más a mano.`);
      }
    } else {
      if (a.stock <= 0) partes.push(`<b style="color:#c62828">Sin stock</b> y sin ventas en 90 días. Revisá si conviene seguir teniéndolo o pedí lo mínimo.`);
      else              partes.push(`Sin ventas en 90 días — tenés <b>${a.stock} ${u.pl}</b>, probablemente no haga falta reponer.`);
      const stockMin = Number(p.stock_min) || 0;
      if (stockMin > 0 && a.stock <= stockMin) {
        const bAlerta = alertaPorBulto(p);
        partes.push(`Está por debajo del mínimo configurado (<b>${bAlerta ? textoBultos(stockMin, bAlerta, { exacto: true }) : stockMin}</b>).`);
      }
    }
    return partes.join(' ');
  }

  // Cantidad elegida a pedir (override manual o sugerida por defecto).
  function _qtyRepos(p) {
    if (invReposQty.has(p.doc_id)) return Math.max(0, invReposQty.get(p.doc_id));
    return _sugeridoDe(p);
  }
  function _totalReposSeleccionado(lista) {
    return lista.filter(p => invReposSel.has(p.doc_id))
      .reduce((s, p) => s + _qtyRepos(p) * (Number(p.costo) || 0), 0);
  }

  // Panel lateral de análisis para el producto enfocado.
  function _renderReposPanel(docId) {
    const panel = document.getElementById('reposPanel');
    if (!panel) return;
    const p = invListaActual.find(x => x.doc_id === docId);
    if (!p) { panel.innerHTML = `<div class="repos-panel-empty"><span class="material-icons">touch_app</span>Tocá un producto para ver el análisis y la recomendación.</div>`; return; }
    const a = _analisisReposicion(p);
    const u = a.u;
    const qty = _qtyRepos(p);
    const trendColor = a.tendencia === 'acelerando' ? '#2e7d32' : a.tendencia === 'bajando' ? '#c62828' : 'var(--text-muted)';
    const trendIco   = a.tendencia === 'acelerando' ? 'trending_up' : a.tendencia === 'bajando' ? 'trending_down' : 'trending_flat';
    const trendTxt   = a.tendencia === 'acelerando' ? `Acelerando +${a.trendPct}%` : a.tendencia === 'bajando' ? `Bajando ${Math.abs(a.trendPct)}%` : a.tendencia === 'estable' ? 'Demanda estable' : 'Sin datos de venta';
    panel.innerHTML = `
      <div class="repos-panel-head">
        <div class="repos-panel-title">${p.nombre || '-'}</div>
        <div class="repos-panel-sub">${p.categoria || p.rubro || '-'}</div>
      </div>
      <div class="repos-trend" style="color:${trendColor}">
        <span class="material-icons" style="font-size:18px">${trendIco}</span>${trendTxt}
      </div>
      <div class="repos-metrics">
        <div class="repos-metric"><span>7 días</span><b>${a.u7}</b></div>
        <div class="repos-metric"><span>30 días</span><b>${a.u30}</b></div>
        <div class="repos-metric"><span>Vel/día</span><b>${a.velDiaria.toFixed(1)}</b></div>
        <div class="repos-metric"><span>Cobertura</span><b>${a.dias != null ? a.dias + 'd' : '—'}</b></div>
      </div>
      <div class="repos-reco">${_textoRecomendacion(a, p)}</div>
      <div class="repos-order">
        <div><span>Pedido</span><b>${qty} ${qty === 1 ? u.sg : u.pl}</b></div>
        <div class="repos-order-cost">≈ $${fmt(qty * (Number(p.costo) || 0))}</div>
      </div>
      <button id="reposPanelRellenar" class="repos-fill-btn" type="button">
        <span class="material-icons" style="font-size:16px">add_shopping_cart</span> Rellenar stock ahora
      </button>`;
    const btnR = panel.querySelector('#reposPanelRellenar');
    if (btnR) btnR.addEventListener('click', () => abrirModalRellenarInv(p.doc_id));
  }

  function _actualizarTotalRepos(lista) {
    const el = document.getElementById('reposTotal');
    if (el) el.textContent = `$${fmt(_totalReposSeleccionado(lista))}`;
    const cnt = document.getElementById('reposCount');
    if (cnt) cnt.textContent = String(lista.filter(p => invReposSel.has(p.doc_id)).length);
  }

  // Tooltip flotante con la sugerencia (para el buscador de reposición).
  function _reposTooltipEl() {
    let t = document.getElementById('reposTooltip');
    if (!t) {
      t = document.createElement('div');
      t.id = 'reposTooltip';
      t.className = 'repos-tooltip';
      t.style.display = 'none';
      document.body.appendChild(t);
    }
    return t;
  }
  function _mostrarTooltipSug(anchorEl, p) {
    if (!p) return;
    const t = _reposTooltipEl();
    const a = _analisisReposicion(p);
    const u = a.u;
    const head = a.sugerido > 0
      ? `<div class="repos-tt-head"><span class="material-icons">lightbulb</span>Sugerido: pedir ${a.sugerido} ${a.sugerido === 1 ? u.sg : u.pl}</div>`
      : `<div class="repos-tt-head"><span class="material-icons">lightbulb</span>Sin sugerencia automática</div>`;
    t.innerHTML = head + `<div class="repos-tt-body">${_textoRecomendacion(a, p)}</div>`;
    t.style.display = 'block';
    const r = anchorEl.getBoundingClientRect();
    const tw = Math.min(320, window.innerWidth - 20);
    t.style.width = tw + 'px';
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - tw - 10));
    let top = r.top - t.offsetHeight - 8;
    if (top < 10) top = r.bottom + 8; // si no entra arriba, mostrar abajo
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }
  function _ocultarTooltipSug() {
    const t = document.getElementById('reposTooltip');
    if (t) t.style.display = 'none';
  }

  function renderListaCompras() {
    const host = document.getElementById('invListaCompras');
    if (!host) return;

    // Candidatos automáticos: con señal comercial y en estado a reponer.
    // Excluimos productos vinculados a otro de stock: su stock no es propio (sale
    // de la fuente: hojas, etc.), por eso no se sugiere comprarlos — se repone la
    // fuente. El usuario igual puede agregarlos a mano desde el buscador.
    const candidatos = invListaActual
      .filter(p => !esPseudoProducto(p))
      .filter(p => !_tieneLinks(p))
      .filter(p => _tieneSenalReposicion(p))
      .filter(p => p._estado.key === 'agotado' || p._estado.key === 'critico' || p._estado.key === 'bajo')
      .sort((a, b) => {
        const orden = { agotado: 0, critico: 1, bajo: 2 };
        const diff = (orden[a._estado.key] ?? 9) - (orden[b._estado.key] ?? 9);
        if (diff !== 0) return diff;
        return (a._estado.dias ?? 999) - (b._estado.dias ?? 999);
      });

    // Agregados a mano vía buscador (que no estén ya entre los candidatos).
    const enCand = new Set(candidatos.map(p => p.doc_id));
    const extras = invListaActual.filter(p => invReposExtra.has(p.doc_id) && !enCand.has(p.doc_id));
    const lista = [...candidatos, ...extras];

    const agot = candidatos.filter(p => p._estado.key === 'agotado').length;
    const crit = candidatos.filter(p => p._estado.key === 'critico').length;
    const baj  = candidatos.filter(p => p._estado.key === 'bajo').length;
    const titulo = `Reposición inteligente${rubroActivo !== 'TODOS' ? ' · ' + rubroActivo.charAt(0) + rubroActivo.slice(1).toLowerCase() : ''}`;

    // Foco: mantener el actual si sigue en la lista; si no, el primero (o nada).
    if (invReposFocus && !lista.some(p => p.doc_id === invReposFocus)) invReposFocus = null;
    if (!invReposFocus && lista.length) invReposFocus = lista[0].doc_id;

    const _itemHTML = (p) => {
      const sel = invReposSel.has(p.doc_id);
      const esExtra = invReposExtra.has(p.doc_id);
      const on  = p.doc_id === invReposFocus;
      const stk = _stockEfectivoInv(p);
      const u = p._estado.unidad || _unidadInv(p);
      const vel = p._estado.velocidad || 0;
      const a = _analisisReposicion(p);
      const diasTxt = p._estado.dias != null ? `${p._estado.dias}d` : '—';
      const qty = _qtyRepos(p);
      const trendChip = a.tendencia === 'acelerando'
        ? `<span class="repos-trend-chip up"><span class="material-icons">trending_up</span>+${a.trendPct}%</span>`
        : a.tendencia === 'bajando'
        ? `<span class="repos-trend-chip down"><span class="material-icons">trending_down</span>${a.trendPct}%</span>`
        : '';
      const varAgot = p._estado.varAgotadas || [];
      const varTxt = varAgot.length
        ? `<div class="repos-item-warn">Sin: ${varAgot.slice(0, 4).join(', ')}${varAgot.length > 4 ? ` +${varAgot.length - 4}` : ''}</div>`
        : '';
      return `
        <div class="repos-item ${sel ? 'sel' : ''} ${on ? 'on' : ''}" data-id="${p.doc_id}" data-key="${p._estado.key}" data-extra="${esExtra ? '1' : '0'}">
          <input type="checkbox" class="repos-chk" ${sel ? 'checked' : ''} title="Agregar al pedido" />
          <div class="repos-item-main">
            <div class="repos-item-name">${p.nombre || '-'}${esExtra ? ' <span class="repos-extra-tag">agregado</span>' : ''}</div>
            <div class="repos-item-tags">
              <span class="badge ${p._estado.cls}" style="font-size:9px">${p._estado.label}</span>
              <span class="repos-tag">${p.rubro || p.categoria || '-'}</span>
              ${trendChip}
            </div>
            <div class="repos-item-figs">stock <b style="color:${stk === 0 ? '#c62828' : 'inherit'}">${stk}${u.sym}</b> · ${diasTxt} · ${vel > 0 ? vel.toFixed(1) + '/d' : 'sin venta'}</div>
            ${varTxt}
            ${modIndicatorHtml(p)}
          </div>
          <div class="repos-qty">
            <button type="button" class="repos-step" data-step="-1">−</button>
            <input type="number" class="repos-qty-input" min="0" value="${qty}" />
            <button type="button" class="repos-step" data-step="1">+</button>
          </div>
        </div>`;
    };

    const itemsHTML = lista.length
      ? lista.map(_itemHTML).join('')
      : `<div class="repos-list-empty"><span class="material-icons">task_alt</span>No hay productos sugeridos para reponer${rubroActivo !== 'TODOS' ? ' en ' + rubroActivo.charAt(0)+rubroActivo.slice(1).toLowerCase() : ''}. Buscá uno arriba para agregarlo al pedido.</div>`;

    const selCount = lista.filter(p => invReposSel.has(p.doc_id)).length;

    host.innerHTML = `
      <div class="repos-card">
        <div class="repos-head">
          <div class="repos-head-title">
            <span class="repos-head-ico"><span class="material-icons">shopping_cart_checkout</span></span>
            <div>
              <b>${titulo}</b>
              <div class="repos-head-sub">
                <span id="reposCount">${selCount}</span> en el pedido · ${candidatos.length} sugeridos
                ${agot ? ` · <span style="color:#ffd9d9">${agot} agotados</span>` : ''}
                ${crit ? ` · <span style="color:#ffd9d9">${crit} críticos</span>` : ''}
                ${baj ? ` · <span style="color:#ffe9cf">${baj} bajos</span>` : ''}
              </div>
            </div>
          </div>
          <div class="repos-head-right">
            <div class="repos-total-box">
              <span>Costo del pedido</span>
              <b id="reposTotal">$${fmt(_totalReposSeleccionado(lista))}</b>
            </div>
            <button id="reposSelAll" class="repos-ghost-btn" type="button" title="Marcar / desmarcar todos"><span class="material-icons">checklist</span></button>
            <button id="btnCopiarWsp" class="repos-wsp-btn" type="button" title="Copiar pedido para WhatsApp"><span class="material-icons">content_copy</span> WhatsApp</button>
            <button id="btnPdfCompras" class="repos-pdf-btn" type="button" title="Generar PDF imprimible"><span class="material-icons">picture_as_pdf</span> PDF</button>
          </div>
        </div>
        <div class="repos-search">
          <span class="material-icons">search</span>
          <input id="reposSearch" type="text" placeholder="Buscar producto para agregar al pedido..." autocomplete="off" />
          <div id="reposSearchResults" class="repos-search-results" style="display:none"></div>
        </div>
        <div class="repos-body">
          <div class="repos-list">${itemsHTML}</div>
          <div class="repos-panel" id="reposPanel"></div>
        </div>
      </div>`;

    _renderReposPanel(invReposFocus);

    // Enfocar al tocar la card (ignorando checkbox y stepper).
    host.querySelectorAll('.repos-item').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.repos-chk') || e.target.closest('.repos-qty')) return;
        invReposFocus = card.dataset.id;
        host.querySelectorAll('.repos-item.on').forEach(c => c.classList.remove('on'));
        card.classList.add('on');
        _renderReposPanel(invReposFocus);
        if (window.innerWidth <= 900) document.getElementById('reposPanel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
    // Selección: agregar/quitar del pedido. Desmarcar un agregado manual lo saca.
    host.querySelectorAll('.repos-chk').forEach(chk => {
      chk.addEventListener('change', () => {
        const card = chk.closest('.repos-item');
        const id = card && card.dataset.id;
        if (!id) return;
        if (chk.checked) { invReposSel.add(id); }
        else {
          invReposSel.delete(id);
          if (card.dataset.extra === '1') { invReposExtra.delete(id); renderListaCompras(); return; }
        }
        card.classList.toggle('sel', chk.checked);
        _actualizarTotalRepos(lista);
      });
    });
    // Cantidad (stepper + input).
    host.querySelectorAll('.repos-step').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = b.closest('.repos-item');
        const id = card && card.dataset.id;
        const input = b.parentElement.querySelector('.repos-qty-input');
        const next = Math.max(0, (parseInt(input.value) || 0) + parseInt(b.dataset.step));
        input.value = next;
        if (id) invReposQty.set(id, next);
        _actualizarTotalRepos(lista);
        if (id && invReposFocus === id) _renderReposPanel(id);
      });
    });
    host.querySelectorAll('.repos-qty-input').forEach(inp => {
      inp.addEventListener('click', e => e.stopPropagation());
      inp.addEventListener('input', () => {
        const card = inp.closest('.repos-item');
        const id = card && card.dataset.id;
        if (id) invReposQty.set(id, Math.max(0, parseInt(inp.value) || 0));
        _actualizarTotalRepos(lista);
        if (id && invReposFocus === id) _renderReposPanel(id);
      });
    });
    document.getElementById('reposSelAll')?.addEventListener('click', () => {
      const allSel = lista.length && lista.every(p => invReposSel.has(p.doc_id));
      if (allSel) lista.forEach(p => invReposSel.delete(p.doc_id));
      else        lista.forEach(p => invReposSel.add(p.doc_id));
      renderListaCompras();
    });
    document.getElementById('btnPdfCompras')?.addEventListener('click', () => generarPDFCompras(lista));
    document.getElementById('btnCopiarWsp')?.addEventListener('click', () => copiarWhatsAppCompras(lista));

    // Buscador (lupita): agrega cualquier producto del catálogo al pedido.
    const sInp = document.getElementById('reposSearch');
    const sBox = document.getElementById('reposSearchResults');
    if (sInp && sBox) {
      const yaEn = new Set(lista.map(p => p.doc_id));
      const buscar = () => {
        const q = (sInp.value || '').trim().toLowerCase();
        if (q.length < 2) { sBox.style.display = 'none'; sBox.innerHTML = ''; return; }
        const words = q.split(/\s+/).filter(Boolean);
        const res = invListaActual.filter(p => {
          if (yaEn.has(p.doc_id) || esPseudoProducto(p)) return false;
          const hay = `${p.nombre||''} ${p.categoria||''} ${p.rubro||''} ${p.codigo||''} ${p.cod_barra||''}`.toLowerCase();
          return words.every(w => hay.includes(w));
        }).slice(0, 8);
        if (!res.length) { sBox.style.display = 'block'; sBox.innerHTML = `<div class="repos-search-empty">Sin resultados</div>`; return; }
        sBox.style.display = 'block';
        sBox.innerHTML = res.map(p => {
          const stk = _stockEfectivoInv(p); const u = p._estado.unidad || _unidadInv(p);
          return `<div class="repos-search-item" data-id="${p.doc_id}">
            <div><b>${p.nombre || '-'}</b><span>${p.categoria || p.rubro || '-'} · stock ${stk}${u.sym}</span></div>
            <div class="repos-search-actions">
              <span class="material-icons repos-info" data-id="${p.doc_id}" title="Ver sugerencia">info</span>
              <span class="material-icons repos-add">add_circle</span>
            </div>
          </div>`;
        }).join('');
        const resById = new Map(res.map(p => [p.doc_id, p]));
        sBox.querySelectorAll('.repos-search-item').forEach(it => {
          it.addEventListener('mousedown', (e) => {
            if (e.target.closest('.repos-info')) return; // el info no agrega, solo muestra
            e.preventDefault();
            const id = it.dataset.id;
            invReposExtra.add(id); invReposSel.add(id); invReposFocus = id;
            _ocultarTooltipSug();
            renderListaCompras();
          });
        });
        sBox.querySelectorAll('.repos-info').forEach(ic => {
          const p = resById.get(ic.dataset.id);
          ic.addEventListener('mouseenter', () => _mostrarTooltipSug(ic, p));
          ic.addEventListener('mouseleave', _ocultarTooltipSug);
          ic.addEventListener('mousedown', e => e.stopPropagation());
        });
      };
      sInp.addEventListener('input', buscar);
      sInp.addEventListener('focus', buscar);
      sInp.addEventListener('blur', () => setTimeout(() => { sBox.style.display = 'none'; _ocultarTooltipSug(); }, 150));
    }
  }

  // ── Modal de RELLENAR (variant-aware) ─────────────────────────────────────
  // Producto suelto: input con +/- que SUMA al stock actual.
  // Producto conjunto: lista de variedades con "Packs +" y "Sueltos +" por
  // color, agregar variedad nueva, suma al existente sin perder precio/costo.
  function abrirModalRellenarInv(docId) {
    const p = (allProductos || []).find(x => (x.doc_id || x.id) === docId);
    if (!p) return;
    const u = _unidadInv(p);
    const esConj = p.es_conjunto === true || p.es_conjunto === 1;
    const stockActual = _stockEfectivoInv(p);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';

    if (esConj) {
      const desglose = _variedadesDesgloseInv(p);
      const globalCont = Number(p.conjunto_contenido || 0);
      const tipoLabel = (p.conjunto_tipo || 'pack');

      overlay.innerHTML = `
        <div style="background:var(--surface);border-radius:18px;max-width:640px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,0.22);overflow:hidden">
          <div style="background:linear-gradient(135deg,#2e7d32,#1b5e20);padding:18px 22px;color:#fff;display:flex;align-items:center;justify-content:space-between">
            <div>
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:0.9">Rellenar stock</div>
              <div style="font-size:16px;font-weight:700;margin-top:2px">${p.nombre}</div>
              <div style="font-size:11px;opacity:0.9;margin-top:2px">${stockActual} ${stockActual===1?u.sg:u.pl} disponibles · ${desglose.length} ${desglose.length===1?'variedad':'variedades'}</div>
            </div>
            <button id="rellInv_cerrar" style="background:rgba(255,255,255,0.18);border:none;cursor:pointer;color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center">
              <span class="material-icons">close</span>
            </button>
          </div>
          <div style="padding:16px 22px;flex:1;overflow-y:auto">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;background:var(--surface-2);border-radius:8px;padding:10px 12px;line-height:1.4">
              Editá la cantidad actual de cada variedad. ${globalCont > 0 ? `Cada ${tipoLabel} = ${globalCont} ${u.pl}.` : ''} Los ${tipoLabel}s van <b>sin contar el abierto</b>: lo del abierto va en sueltos. Los valores que dejes <b>reemplazan</b> al stock actual.
            </div>
            <div id="rellInv_lista" style="display:flex;flex-direction:column;gap:6px"></div>
            <button id="rellInv_add" type="button" style="margin-top:10px;background:none;border:1.5px dashed var(--border);color:var(--tint-purple-fg);padding:8px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;display:flex;align-items:center;gap:4px;font-family:inherit">
              <span class="material-icons" style="font-size:16px">add</span>
              Agregar variedad nueva
            </button>
            <div id="rellInv_resumen" style="margin-top:14px;padding:10px 12px;background:var(--tint-green-bg);border:1.5px solid #2e7d32;border-radius:8px;font-size:13px;color:var(--tint-green-fg);display:none"></div>
          </div>
          <div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)">
            <button id="rellInv_cancel" style="padding:9px 18px;border-radius:8px;border:1.5px solid var(--border);background:var(--surface);cursor:pointer;font-size:13px;font-weight:600;color:var(--text-muted)">Cancelar</button>
            <button id="rellInv_guardar" style="padding:9px 22px;border-radius:8px;border:none;background:#2e7d32;color:#fff;cursor:pointer;font-size:13px;font-weight:700">Guardar stock</button>
          </div>
        </div>`;

      document.body.appendChild(overlay);
      const lista = overlay.querySelector('#rellInv_lista');
      const resumenEl = overlay.querySelector('#rellInv_resumen');

      function _addRow(color = '', existente = null, esNueva = false) {
        const row = document.createElement('div');
        row.dataset.varRow = '1';
        row.dataset.esNueva = esNueva ? '1' : '0';
        const origSuelt = existente ? (Number(existente.r) || 0) : 0;
        const origPacks = existente ? (Number(existente.u) || 0) : 0;
        row.dataset.origPacks = String(origPacks);
        row.dataset.origSueltos = String(origSuelt);
        row.style.cssText = 'display:grid;grid-template-columns:1fr 90px 90px;gap:8px;align-items:center;background:var(--surface);border:1.5px solid var(--border);border-radius:10px;padding:8px 10px';
        const stkExistente = existente ? `${existente.total} ${u.pl}` : 'nueva';
        const valPacks   = esNueva ? '' : String(origPacks);
        const valSueltos = esNueva ? '' : String(origSuelt);
        row.innerHTML = `
          <div style="min-width:0">
            ${esNueva
              ? `<input class="r_color" type="text" placeholder="Nombre variedad" value="${color}" style="width:100%;padding:6px 8px;border:1.5px solid var(--border);border-radius:6px;font-size:12px;box-sizing:border-box;font-family:inherit;background:var(--tint-orange-bg)" />`
              : `<div style="font-size:13px;font-weight:700">${color}</div>
                 <div style="font-size:10px;color:var(--text-muted)">Actual: ${stkExistente}</div>`}
          </div>
          <div>
            <div style="font-size:9px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;text-align:center">${tipoLabel.toUpperCase()}S CERRADOS</div>
            <input class="r_packs" type="number" min="0" step="1" placeholder="0" value="${valPacks}" style="width:100%;padding:6px;border:1.5px solid var(--border);border-radius:6px;font-size:14px;text-align:center;box-sizing:border-box;font-family:inherit;font-weight:700" />
          </div>
          <div>
            <div style="font-size:9px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;text-align:center">SUELTOS</div>
            <input class="r_sueltos" type="number" min="0" step="0.01" placeholder="0" value="${valSueltos}" style="width:100%;padding:6px;border:1.5px solid var(--border);border-radius:6px;font-size:14px;text-align:center;box-sizing:border-box;font-family:inherit" />
          </div>`;
        lista.appendChild(row);
        row.querySelectorAll('input').forEach(i => i.addEventListener('input', actualizarResumen));
      }

      desglose.forEach(d => _addRow(d.color, d));
      overlay.querySelector('#rellInv_add').addEventListener('click', () => _addRow('', null, true));

      function actualizarResumen() {
        let totP = 0, totS = 0, totCerrados = 0, nuevas = 0, hayCambio = false;
        overlay.querySelectorAll('[data-var-row]').forEach(r => {
          const packs   = parseInt(r.querySelector('.r_packs').value) || 0;
          const sueltos = parseFloat(r.querySelector('.r_sueltos').value) || 0;
          const oP = Number(r.dataset.origPacks)   || 0;
          const oS = Number(r.dataset.origSueltos) || 0;
          if (packs !== oP || sueltos !== oS) hayCambio = true;
          if (r.dataset.esNueva === '1' && (packs > 0 || sueltos > 0)) nuevas += 1;
          totP += packs; totS += sueltos;
          totCerrados += packs;
        });
        const totalUn = (totCerrados * (globalCont || 1)) + totS;
        if (!hayCambio) {
          resumenEl.style.display = 'none';
        } else {
          resumenEl.style.display = 'block';
          resumenEl.innerHTML = `
            <b>Total nuevo:</b> ${totP} ${tipoLabel}${totP===1?'':'s'}${totS>0?` + ${totS} sueltos`:''}
            ${globalCont > 0 ? ` = <b>${totalUn} ${u.pl}</b>` : ''}
            ${nuevas > 0 ? `<br><span style="font-size:11px">(${nuevas} ${nuevas===1?'variedad nueva':'variedades nuevas'})</span>` : ''}`;
        }
      }

      const cerrar = () => overlay.remove();
      overlay.querySelector('#rellInv_cerrar').addEventListener('click', cerrar);
      overlay.querySelector('#rellInv_cancel').addEventListener('click', cerrar);
      overlay.addEventListener('click', e => { if (e.target === overlay) cerrar(); });

      overlay.querySelector('#rellInv_guardar').addEventListener('click', async () => {
        const btn = overlay.querySelector('#rellInv_guardar');
        btn.disabled = true; btn.textContent = 'Guardando...';

        const filas = Array.from(overlay.querySelectorAll('[data-var-row]'));
        const existentesActualizadas = [];
        const nuevasACrear = [];
        let huboCambios = false;

        filas.forEach((r, idx) => {
          const packs   = parseInt(r.querySelector('.r_packs').value) || 0;
          const sueltos = parseFloat(r.querySelector('.r_sueltos').value) || 0;
          const oP = Number(r.dataset.origPacks)   || 0;
          const oS = Number(r.dataset.origSueltos) || 0;
          const esNueva = r.dataset.esNueva === '1';
          if (esNueva) {
            const nombre = (r.querySelector('.r_color')?.value || '').trim();
            if (nombre && (packs > 0 || sueltos > 0)) {
              huboCambios = true;
              nuevasACrear.push({
                color: nombre,
                unidades: packs,
                restante: sueltos,
              });
            }
            return;
          }
          const original = desglose[idx];
          const orig = (Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [])
            .find(c => (c.color || '').toLowerCase() === (original?.color || '').toLowerCase()) || {};
          if (packs !== oP || sueltos !== oS) huboCambios = true;
          existentesActualizadas.push({
            ...orig,
            unidades: packs,
            restante: sueltos,
          });
        });

        if (!huboCambios) {
          alertDialog({ title: 'Sin cambios', message: 'No cambiaste ninguna cantidad.', type: 'info' });
          btn.disabled = false; btn.textContent = 'Guardar stock';
          return;
        }

        const nombresEditados = new Set(existentesActualizadas.map(c => (c.color || '').toLowerCase()));
        const restoOriginal = (Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [])
          .filter(c => !nombresEditados.has((c.color || '').toLowerCase()));
        const nuevoConjunto = [...existentesActualizadas, ...restoOriginal, ...nuevasACrear];

        try {
          const totalNuevo = nuevoConjunto.reduce((acc, c) => {
            const uu = Number(c.unidades) || 0;
            const rr = Number(c.restante) || 0;
            const cc = (Number(c.contenido) > 0) ? Number(c.contenido) : globalCont;
            return acc + (uu * cc + rr);
          }, 0);
          const _docId = p.doc_id || p.id;
          const _before = { conjunto_colores: (p.conjunto_colores ?? null), conjunto_total: (p.conjunto_total ?? null) };
          const _after  = { conjunto_colores: nuevoConjunto, conjunto_total: Math.round(totalNuevo) };
          await updateDoc(doc(db, 'catalogo', _docId), {
            ..._after,
            // Los agregados planos acompañan a las variedades: el POS y la
            // tienda leen el total, pero un número viejo acá confunde al que mira.
            conjunto_unidades: nuevoConjunto.reduce((acc, c) => acc + (Number(c.unidades) || 0), 0),
            conjunto_restante: nuevoConjunto.reduce((acc, c) => acc + (Number(c.restante) || 0), 0),
            conjunto_packs_cerrados: true,
            // El stock plano acompaña al total del conjunto, como en la ficha:
            // dejarlo atrás hacía dudar de los dos números.
            stock: Math.max(0, Math.round(totalNuevo)),
            ultima_actualizacion: serverTimestamp(),
          });
          registrarMovimiento(db, {
            docId: _docId, nombre: p.nombre || p.name || '',
            motivo: 'edicion_manual', antes: numConj(p.conjunto_total), despues: Math.round(totalNuevo),
            detalle: 'Stock por variedad desde Inventario',
          });
          invalidateCacheByPrefix('catalogo');
          // Avisar al POS + sincronizar inventario con el total agregado del conjunto.
          _touchCatalogoMeta(db).catch(() => {});
          try {
            const invDocId = String(p.id || _docId);
            await setDoc(doc(db, 'inventario', invDocId), {
              stock: Math.round(totalNuevo), nombre: p.nombre || p.name || '',
              id: parseInt(invDocId) || invDocId, ultima_actualizacion: serverTimestamp(),
            }, { merge: true });
          } catch (e2) { console.warn('No se pudo actualizar inventario:', e2.message); }
          // Reflejar el cambio en memoria sin re-fetchear todo Firestore.
          const idx2 = (allProductos || []).findIndex(x => (x.doc_id || x.id) === _docId);
          if (idx2 !== -1) {
            allProductos[idx2].conjunto_colores = nuevoConjunto;
            allProductos[idx2].conjunto_total = Math.round(totalNuevo);
            allProductos[idx2].stock = Math.max(0, Math.round(totalNuevo));
          }
          hist.recordUpdate(_docId, _before, _after, { label: `Variantes de ${p.nombre || p.name || _docId}` });
          cerrar();
          // Refrescar dashboard
          const tc = document.getElementById('tabContent');
          if (tc) renderTabInventario(tc);
        } catch (err) {
          alertDialog({ title: 'Error', message: 'No se pudo guardar: ' + _escHtml(err.message), type: 'error' });
          btn.disabled = false; btn.textContent = 'Guardar stock';
        }
      });
      return;
    }

    // === Modal RELLENAR simple (suelto) ======================================
    // Base = stock CRUDO (puede ser negativo si se vendió sin reponer): el
    // relleno suma sobre el negativo (ej. -6 + 10 = 4).
    const stockBase = Number(p.stock) || 0;
    overlay.innerHTML = `
      <div style="background:var(--surface);border-radius:16px;max-width:380px;width:100%;box-shadow:0 12px 48px rgba(0,0,0,0.22);overflow:hidden">
        <div style="background:linear-gradient(135deg,#2e7d32,#1b5e20);padding:16px 20px;color:#fff;display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:0.9">Rellenar stock</div>
            <div style="font-size:15px;font-weight:700;margin-top:2px">${p.nombre}</div>
          </div>
          <button id="rellInv_cerrar2" style="background:rgba(255,255,255,0.18);border:none;cursor:pointer;color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center">
            <span class="material-icons">close</span>
          </button>
        </div>
        <div style="padding:16px 20px">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Stock actual: <b>${stockBase} ${stockBase===1?u.sg:u.pl}</b></div>
          <label style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">¿Cuántos llegaron?</label>
          <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
            <button type="button" data-step="-10" style="width:38px;height:42px;border-radius:8px;border:1.5px solid var(--border);background:var(--surface);cursor:pointer;font-size:11px;font-weight:700">-10</button>
            <button type="button" data-step="-1" style="width:38px;height:42px;border-radius:8px;border:1.5px solid var(--border);background:var(--surface);cursor:pointer;font-size:18px;font-weight:700">−</button>
            <input id="rellInv_qty" type="number" min="0" step="1" value="1" style="flex:1;text-align:center;padding:9px;border:1.5px solid #2e7d32;border-radius:8px;font-size:20px;font-weight:800;font-family:inherit;box-sizing:border-box" />
            <button type="button" data-step="1" style="width:38px;height:42px;border-radius:8px;border:1.5px solid var(--border);background:var(--surface);cursor:pointer;font-size:18px;font-weight:700">+</button>
            <button type="button" data-step="10" style="width:38px;height:42px;border-radius:8px;border:1.5px solid var(--border);background:var(--surface);cursor:pointer;font-size:11px;font-weight:700">+10</button>
          </div>
          <div id="rellInv_resumen2" style="margin-top:12px;padding:10px 12px;background:var(--tint-green-bg);border:1.5px solid #2e7d32;border-radius:8px;font-size:13px;color:var(--tint-green-fg)"></div>
        </div>
        <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)">
          <button id="rellInv_cancel2" style="padding:8px 16px;border-radius:8px;border:1.5px solid var(--border);background:var(--surface);cursor:pointer;font-size:13px;font-weight:600;color:var(--text-muted)">Cancelar</button>
          <button id="rellInv_guardar2" style="padding:8px 18px;border-radius:8px;border:none;background:#2e7d32;color:#fff;cursor:pointer;font-size:13px;font-weight:700">Sumar al stock</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const inp = overlay.querySelector('#rellInv_qty');
    const resumenEl = overlay.querySelector('#rellInv_resumen2');
    const refresh = () => {
      const q = parseInt(inp.value) || 0;
      resumenEl.textContent = q > 0
        ? `Te van a quedar: ${stockBase + q} ${(stockBase + q) === 1 ? u.sg : u.pl}`
        : 'Ingresá una cantidad mayor a 0.';
    };
    inp.addEventListener('input', refresh);
    inp.focus(); inp.select();
    refresh();

    overlay.querySelectorAll('button[data-step]').forEach(b => {
      b.addEventListener('click', () => {
        const cur = parseInt(inp.value) || 0;
        inp.value = Math.max(0, cur + parseInt(b.dataset.step));
        refresh();
      });
    });

    const cerrar = () => overlay.remove();
    overlay.querySelector('#rellInv_cerrar2').addEventListener('click', cerrar);
    overlay.querySelector('#rellInv_cancel2').addEventListener('click', cerrar);
    overlay.addEventListener('click', e => { if (e.target === overlay) cerrar(); });

    overlay.querySelector('#rellInv_guardar2').addEventListener('click', async () => {
      const q = parseInt(inp.value);
      if (!q || q <= 0) { alertDialog({ title: 'Cantidad inválida', message: 'Ingresá una cantidad mayor a 0.', type: 'warning' }); return; }
      const btn = overlay.querySelector('#rellInv_guardar2');
      btn.disabled = true; btn.textContent = 'Guardando...';
      const nuevoStock = stockBase + q;
      const _docId = p.doc_id || p.id;
      try {
        await updateDoc(doc(db, 'catalogo', _docId), { stock: nuevoStock, ultima_actualizacion: serverTimestamp() });
        invalidateCacheByPrefix('catalogo');
        // Avisar al POS que el catálogo cambió + sincronizar la colección
        // `inventario` (que el POS lee por id numérico) para que vea el stock nuevo.
        _touchCatalogoMeta(db).catch(() => {});
        try {
          const invDocId = String(p.id || _docId);
          await setDoc(doc(db, 'inventario', invDocId), {
            stock: nuevoStock, nombre: p.nombre || p.name || '',
            id: parseInt(invDocId) || invDocId, ultima_actualizacion: serverTimestamp(),
          }, { merge: true });
        } catch (e2) { console.warn('No se pudo actualizar inventario:', e2.message); }
        const idx2 = (allProductos || []).findIndex(x => (x.doc_id || x.id) === _docId);
        if (idx2 !== -1) allProductos[idx2].stock = nuevoStock;
        hist.recordUpdate(_docId, { stock: (p.stock ?? null) }, { stock: nuevoStock }, {
          label: `Stock de ${p.nombre || p.name || _docId}`,
        });
        registrarMovimiento(db, {
          docId: _docId, nombre: p.nombre || p.name || '',
          motivo: 'reposicion', antes: stockBase, despues: nuevoStock,
          detalle: 'Reposición desde el panel',
        });
        avisarStockALaTienda(db, _docId, nuevoStock);
        cerrar();
        const tc = document.getElementById('tabContent');
        if (tc) renderTabInventario(tc);
      } catch (err) {
        alertDialog({ title: 'Error', message: 'No se pudo guardar: ' + _escHtml(err.message), type: 'error' });
        btn.disabled = false; btn.textContent = 'Sumar al stock';
      }
    });
  }

  function generarPDFCompras(lista) {
    const items = lista.filter(p => invReposSel.has(p.doc_id));
    if (!items.length) { alertDialog({ title: 'Sin productos', message: 'No seleccionaste productos para el pedido. Marcá los que querés pedir.', type: 'warning' }); return; }
    // Costo del pedido = cantidad elegida × costo unitario.
    const totCosto = items.reduce((s, p) => s + _qtyRepos(p) * Number(p.costo || 0), 0);
    const fecha = new Date().toLocaleDateString('es-AR');
    const rubroTxt = rubroActivo !== 'TODOS' ? ' — ' + rubroActivo.charAt(0) + rubroActivo.slice(1).toLowerCase() : '';

    const grupos = agruparPorRubroCompras(items);
    const agruparVisual = rubroActivo === 'TODOS' && grupos.length > 1;

    let nroGlobal = 0;
    const rows = grupos.map(g => {
      const sub = g.items.reduce((s, p) => s + _qtyRepos(p) * Number(p.costo || 0), 0);
      const header = agruparVisual ? `
        <tr class="rubro-header">
          <td colspan="7">${g.rubro === 'SIN RUBRO' ? 'Sin rubro' : g.rubro.charAt(0)+g.rubro.slice(1).toLowerCase()} — ${g.items.length} ítem${g.items.length!==1?'s':''}</td>
          <td class="r">$${fmt(sub)}</td>
        </tr>` : '';
      const itemRows = g.items.map(p => {
        nroGlobal += 1;
        return `
          <tr>
            <td>${nroGlobal}</td>
            <td><b>${p.nombre || '-'}</b>${p.cod_barra ? `<div style="font-size:9px;color:var(--text-muted)">${p.cod_barra}</div>` : ''}</td>
            <td>${p.rubro || p.categoria || '-'}</td>
            <td class="c">${_stockEfectivoInv(p)}</td>
            <td class="c">${p._estado.dias !== null && p._estado.dias !== undefined ? p._estado.dias + 'd' : '—'}</td>
            <td class="${p._estado.key}">${p._estado.label}</td>
            <td class="c" style="font-weight:700">${_qtyRepos(p) > 0 ? _qtyRepos(p) : '—'}</td>
            <td class="r">$${fmt(_qtyRepos(p) * (Number(p.costo) || 0))}</td>
          </tr>`;
      }).join('');
      return header + itemRows;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><title>Lista de Compras ${fecha}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 24px; color:var(--text); }
  .header { border-bottom: 2px solid #1c1e21; padding-bottom: 12px; margin-bottom: 18px; display:flex; align-items:flex-end; justify-content:space-between; flex-wrap:wrap; gap:8px; }
  h1 { margin: 0; font-size: 20px; }
  .meta { font-size: 12px; color:var(--text-muted); margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 8px 10px; background:var(--bg); border-bottom: 2px solid #1c1e21; font-size: 11px; text-transform: uppercase; }
  td { padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .c { text-align: center; }
  .r { text-align: right; }
  .agotado { color:var(--tint-red-fg); font-weight: 700; }
  .critico { color:var(--tint-red-fg); font-weight: 600; }
  .bajo    { color: var(--tint-orange-fg); font-weight: 600; }
  .rubro-header td { background:var(--tint-blue-bg); border-top:2px solid #1877f2; border-bottom:1px solid var(--border); color:var(--tint-blue-fg); font-weight:800; font-size:12px; text-transform:uppercase; letter-spacing:0.4px; padding:8px 10px; }
  .total-row td { border-top: 2px solid #1c1e21; border-bottom: none; font-weight: 700; padding-top: 12px; background:var(--surface-2); }
  .footer { margin-top: 18px; font-size: 10px; color:var(--text-muted); text-align: right; }
  .no-print button { padding:10px 20px;background:#1877f2;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;font-weight:700;font-family:inherit; }
  @media print { body { padding: 12px; } .no-print { display: none; } }
</style>
</head><body>
<div class="header">
  <div>
    <h1>Lista de Compras${rubroTxt}</h1>
    <div class="meta">Generado el ${fecha} · ${items.length} producto${items.length !== 1 ? 's' : ''}</div>
  </div>
  <div class="meta">Libreria Liceo</div>
</div>
<table>
  <thead>
    <tr>
      <th>#</th>
      <th>Producto</th>
      <th>Rubro</th>
      <th class="c">Stock</th>
      <th class="c">Días</th>
      <th>Estado</th>
      <th class="c">Pedir</th>
      <th class="r">Costo</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
    <tr class="total-row">
      <td colspan="7" class="r">Total del pedido</td>
      <td class="r">$${fmt(totCosto)}</td>
    </tr>
  </tbody>
</table>
<div class="footer">POS Dashboard · ${fecha}</div>
<div class="no-print" style="margin-top:24px;text-align:center">
  <button onclick="window.print()">Imprimir / Guardar como PDF</button>
</div>
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 350));</script>
</body></html>`;

    const w = window.open('', '_blank');
    if (!w) { alertDialog({ title: 'Popups bloqueados', message: 'No se pudo abrir la ventana. Habilitá las pop-ups para este sitio.', type: 'warning' }); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  async function copiarWhatsAppCompras(lista) {
    const items = lista.filter(p => invReposSel.has(p.doc_id));
    if (!items.length) { alertDialog({ title: 'Sin productos', message: 'No seleccionaste productos para el pedido. Marcá los que querés pedir.', type: 'warning' }); return; }
    const rubroTxt = rubroActivo !== 'TODOS' ? ' (' + rubroActivo + ')' : '';
    const fecha = new Date().toLocaleDateString('es-AR');
    const totCosto = items.reduce((s, p) => s + _qtyRepos(p) * Number(p.costo || 0), 0);
    const grupos = agruparPorRubroCompras(items);
    const agruparVisual = rubroActivo === 'TODOS' && grupos.length > 1;

    let txt = `*Pedido de reposición${rubroTxt}*\n${fecha}\n\n`;
    let nro = 0;
    grupos.forEach(g => {
      if (agruparVisual) {
        const nombreRubro = g.rubro === 'SIN RUBRO' ? 'Sin rubro' : g.rubro.charAt(0)+g.rubro.slice(1).toLowerCase();
        const sub = g.items.reduce((s, p) => s + _qtyRepos(p) * Number(p.costo || 0), 0);
        txt += `▸ *${nombreRubro}*  _(${g.items.length} · $${fmt(sub)})_\n`;
      }
      g.items.forEach(p => {
        nro += 1;
        const u = p._estado.unidad || _unidadInv(p);
        const qty = _qtyRepos(p);
        const dias = p._estado.dias !== null && p._estado.dias !== undefined ? ` · quedan ${p._estado.dias}d` : '';
        txt += `${nro}. *${p.nombre}* — pedir *${qty}* ${qty === 1 ? u.sg : u.pl}  (stock ${_stockEfectivoInv(p)}${dias})\n`;
      });
      if (agruparVisual) txt += '\n';
    });
    txt += `\n_Total del pedido: $${fmt(totCosto)}_`;

    const flash = (msg, ok = true) => {
      const btn = document.getElementById('btnCopiarWsp');
      if (!btn) return;
      const orig = btn.innerHTML;
      btn.innerHTML = `<span class="material-icons" style="font-size:16px">${ok?'check':'error'}</span> ${msg}`;
      setTimeout(() => btn.innerHTML = orig, 1500);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(txt)
        .then(() => flash('Copiado'))
        .catch(async () => {
          const ta = document.createElement('textarea');
          ta.value = txt; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); flash('Copiado'); }
          catch { flash('Error', false); await promptDialog({ title: 'Copiar pedido', message: 'No se pudo copiar solo. Seleccioná el texto y copialo:', defaultValue: txt, confirmText: 'Listo' }); }
          document.body.removeChild(ta);
        });
    } else {
      await promptDialog({ title: 'Copiar pedido', message: 'Seleccioná el texto y copialo:', defaultValue: txt, confirmText: 'Listo' });
    }
  }

  function applyInvFilters() {
    let data = [...invListaActual];
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
    invFiltradoActual = data; // recordar para exportar/imprimir
    if (countEl) countEl.textContent = `${data.length} productos`;
    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-muted)">Sin productos</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map(p => {
      const stock = _stockEfectivoInv(p);
      const e = p._estado;
      const bgRow = e.key === 'agotado' ? 'background:var(--tint-red-bg)' : e.key === 'critico' ? 'background:var(--tint-red-bg)' : '';
      const pct = e.pct || 0;
      const barColor = pct <= 20 ? '#c62828' : pct <= 50 ? '#f57c00' : '#2e7d32';
      const barHtml = `
        <div style="display:flex;align-items:center;gap:6px">
          <div style="flex:1;background:var(--border);border-radius:99px;height:6px;overflow:hidden;min-width:50px">
            <div style="width:${pct}%;height:100%;background:${barColor};border-radius:99px"></div>
          </div>
          <span style="font-size:11px;font-weight:700;color:${barColor};width:30px">${pct}%</span>
        </div>`;
      const diasTxt = e.dias !== null && e.dias !== undefined
        ? `<b style="color:${e.color}">${e.dias}d</b>`
        : `<span style="color:var(--text-muted);font-size:11px">—</span>`;
      const velTxt = e.velocidad > 0
        ? `<span style="font-size:12px;color:var(--tint-purple-fg);font-weight:600">${e.velocidad.toFixed(2)}</span>`
        : `<span style="font-size:11px;color:var(--text-muted)">—</span>`;

      return `<tr style="${bgRow}">
        <td><b style="font-size:13px">${p.nombre || '-'}</b><br><span style="color:var(--text-muted);font-size:10px">${p.cod_barra || ''}</span>${modIndicatorHtml(p)}</td>
        <td class="inv-col-categoria"><span class="badge badge-gray">${p.categoria || '-'}</span></td>
        <td class="inv-col-rubro" style="font-size:11px;color:var(--text-muted)">${p.rubro || '-'}</td>
        <td style="text-align:center;font-weight:800;font-size:16px;color:${stock===0?'var(--tint-red-fg)':stock<=3?'var(--tint-orange-fg)':'var(--text)'}">
          <span class="inv-stock-val" data-id="${p.doc_id}" style="cursor:pointer;border-bottom:1px dashed var(--border)" title="Click para editar">${stock}</span>
        </td>
        <td class="inv-col-dias" style="text-align:center">${diasTxt}</td>
        <td class="inv-col-cobertura">${barHtml}</td>
        <td class="inv-col-velocidad" style="text-align:center">${velTxt}</td>
        <td><span class="badge ${e.cls}">${e.label}</span></td>
        <td style="text-align:right;color:var(--tint-green-fg);font-weight:600">$${fmt(p.precio_venta || p.precio || 0)}</td>
        <td>
          <button class="inv-btn-mov" data-id="${p.doc_id}" style="background:none;border:none;cursor:pointer;color:var(--text-muted);padding:4px" title="Ver movimientos de stock">
            <span class="material-icons" style="font-size:16px">history</span>
          </button>
          <button class="inv-btn-edit" data-id="${p.doc_id}" style="background:none;border:none;cursor:pointer;color:var(--tint-blue-fg);padding:4px" title="Editar producto">
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
    tbody.querySelectorAll('.inv-btn-mov').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = allProductos.find(x => x.doc_id === btn.dataset.id);
        if (p) abrirMovimientosStock(p);
      });
    });
    tbody.querySelectorAll('.inv-stock-val').forEach(cell => {
      cell.addEventListener('click', () => editarStockInv(cell.dataset.id));
    });
  }

  // ── Movimientos de stock de un producto ────────────────────────────────
  // La pregunta que contesta esta ventana es "¿por qué el sistema dice 12 si en
  // el mostrador hay 10?". Muestra cada entrada y salida con el antes, el
  // después, quién y desde dónde, del movimiento más nuevo al más viejo.
  async function abrirMovimientosStock(p) {
    const docId = p.doc_id || p.id;
    document.querySelector('.stkmov-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay stkmov-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:720px;width:100%">
        <div class="modal-header">
          <h3 style="margin:0;font-size:16px">Movimientos de stock</h3>
          <button class="stkmov-cerrar" style="background:none;border:none;cursor:pointer;color:var(--text-muted)">
            <span class="material-icons">close</span>
          </button>
        </div>
        <div style="padding:0 20px 8px">
          <div style="font-weight:700;font-size:14px">${_escHtml(p.nombre || '')}</div>
          <div style="font-size:12px;color:var(--text-muted)">
            Código ${_escHtml(String(docId))} · stock hoy: <b>${Number(p.stock) || 0}</b>
          </div>
        </div>
        <div class="stkmov-cuerpo" style="padding:8px 20px 20px;max-height:60vh;overflow:auto">
          <div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">Buscando movimientos…</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cerrar = () => overlay.remove();
    overlay.querySelector('.stkmov-cerrar').addEventListener('click', cerrar);
    overlay.addEventListener('click', e => { if (e.target === overlay) cerrar(); });

    const cuerpo = overlay.querySelector('.stkmov-cuerpo');
    const movs = await movimientosDe(db, docId, 80);

    if (!movs.length) {
      cuerpo.innerHTML = `
        <div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;line-height:1.6">
          Todavía no hay movimientos registrados de este producto.<br>
          El historial arranca desde que se instaló esta versión: lo anterior no quedó guardado.
        </div>`;
      return;
    }

    const fmtFecha = ts => {
      const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null);
      if (!d || isNaN(d)) return '—';
      return d.toLocaleString('es-AR', {
        day: '2-digit', month: '2-digit', year: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    };

    cuerpo.innerHTML = `
      <table class="data-table" style="width:100%;font-size:12px">
        <thead>
          <tr>
            <th style="text-align:left">Cuándo</th>
            <th style="text-align:left">Motivo</th>
            <th style="text-align:right">Cantidad</th>
            <th style="text-align:right">Quedó</th>
            <th style="text-align:left">Quién</th>
          </tr>
        </thead>
        <tbody>
          ${movs.map(m => {
            const cant = Number(m.cantidad) || 0;
            const color = cant < 0 ? 'var(--tint-red-fg)' : 'var(--tint-green-fg)';
            const detalle = [m.referencia, m.detalle].filter(Boolean).join(' · ');
            const paso = (m.stock_antes != null && m.stock_despues != null)
              ? `${m.stock_antes} → <b>${m.stock_despues}</b>` : '—';
            return `<tr>
              <td style="white-space:nowrap;color:var(--text-muted)">${fmtFecha(m.ts)}</td>
              <td>
                ${_escHtml(MOTIVOS[m.motivo] || m.motivo || '—')}
                ${detalle ? `<br><span style="font-size:10px;color:var(--text-muted)">${_escHtml(detalle)}</span>` : ''}
              </td>
              <td style="text-align:right;font-weight:700;color:${color};white-space:nowrap">
                ${cant > 0 ? '+' : ''}${cant}
              </td>
              <td style="text-align:right;white-space:nowrap">${paso}</td>
              <td style="color:var(--text-muted)">
                ${_escHtml(m.usuario || '—')}
                <br><span style="font-size:10px">${m.origen === 'webapp' ? 'panel' : _escHtml(m.pc_id || 'POS')}</span>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  async function editarStockInv(docId) {
    const p = allProductos.find(x => x.doc_id === docId);
    if (!p) return;
    const nuevo = await promptDialog({
      title: 'Editar stock',
      message: `Stock actual de <b>"${_escHtml(p.nombre)}"</b>: ${p.stock || 0}<br>Ingresá el nuevo stock:`,
      defaultValue: String(p.stock || 0),
      confirmText: 'Guardar',
    });
    if (nuevo === null) return;
    const valor = parseInt(nuevo);
    if (isNaN(valor) || valor < 0) { alertDialog({ title: 'Stock inválido', message: 'Ingresá un número válido (0 o mayor).', type: 'warning' }); return; }
    // Un conjunto guarda el mismo stock dos veces (plano + packs/sueltas):
    // se escriben juntos o la carga desaparece en la ficha y en el POS.
    const campos = camposStockRapido(p, valor);
    if (!campos) {
      alertDialog({
        title: 'Producto con variedades',
        message: `El stock de <b>"${_escHtml(p.nombre)}"</b> se reparte entre variedades.<br>Cargalo desde <b>Editar producto</b>, en la fila de la variedad que corresponda, así queda bien repartido.`,
        type: 'warning',
      });
      return;
    }
    const _stockPrev = p.stock ?? null;
    try {
      const antes = {};
      for (const k of Object.keys(campos)) antes[k] = p[k] ?? null;
      await updateDoc(doc(db, 'catalogo', docId), { ...campos, ultima_actualizacion: serverTimestamp() });
      invalidateCacheByPrefix('catalogo');
      Object.assign(p, campos);
      if (_stockPrev !== valor) hist.recordUpdate(docId, antes, { ...campos }, {
        label: `Stock de ${p.nombre || p.name || docId}`,
      });
      registrarMovimiento(db, {
        docId, nombre: p.nombre || p.name || '',
        motivo: valor > (_stockPrev || 0) ? 'reposicion' : 'edicion_manual',
        antes: _stockPrev, despues: valor,
        detalle: 'Editado desde el panel',
      });
      avisarStockALaTienda(db, docId, valor);
      renderTabInventario(document.getElementById('tabContent'));
      renderStats();
      renderBannerCriticos();
    } catch(e) {
      alertDialog({ title: 'Error', message: 'No se pudo guardar: ' + _escHtml(e.message), type: 'error' });
    }
  }

  // ── Tab Importar CSV ──
  function renderTabImportar(tc) {
    tc.innerHTML = `
      <div class="table-card" style="max-width:640px">
        <div class="table-card-header"><h3>Importar Lista de Precios</h3></div>
        <div style="padding:20px;display:flex;flex-direction:column;gap:16px">

          <!-- Selector de sección para la importación -->
          <div style="background:var(--tint-blue-bg);border:1px solid var(--border);border-radius:10px;padding:14px">
            <div style="font-size:12px;font-weight:700;color:var(--tint-blue-fg);margin-bottom:8px">SECCIÓN DE DESTINO</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${['TODOS', ...RUBROS].map(r => `
                <button class="imp-rubro-btn" data-rubro="${r}" style="padding:6px 14px;border-radius:20px;border:2px solid ${r===rubroActivo?'#1877f2':'var(--border)'};background:${r===rubroActivo?'#1877f2':'var(--surface)'};color:${r===rubroActivo?'#fff':'var(--text)'};cursor:pointer;font-size:13px;font-weight:600;transition:all 0.2s">
                  ${r === 'TODOS' ? 'Sin sección' : r.charAt(0)+r.slice(1).toLowerCase()}
                </button>`).join('')}
            </div>
            <div style="margin-top:8px;font-size:12px;color:var(--tint-blue-fg)">
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
          b.style.background = 'var(--surface)'; b.style.color = 'var(--text)'; b.style.borderColor = 'var(--border)';
        });
        btn.style.background = '#1877f2'; btn.style.color = '#fff'; btn.style.borderColor = '#1877f2';
        const label = document.getElementById('imp_rubro_label');
        if (label) label.textContent = rubroImport === 'TODOS' ? 'Sin sección específica' : rubroImport;
      });
    });

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.background = 'var(--bg)'; });
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
          result.innerHTML = `<div style="padding:12px;background:var(--tint-red-bg);border-radius:8px;color:var(--tint-red-fg)">Error: No se encontraron productos válidos en el archivo.</div>`;
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
        await cargarDatos({ silent: true });
        renderStats();

        result.style.display = 'block';
        result.innerHTML = `
          <div style="padding:16px;background:var(--tint-green-bg);border-radius:8px;border:1px solid var(--border)">
            <p style="margin:0 0 8px;font-weight:700;color:var(--tint-green-fg)">Importación exitosa</p>
            <ul style="margin:0;padding-left:20px;font-size:14px;color:var(--tint-green-fg);line-height:1.8">
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
        result.innerHTML = `<div style="padding:12px;background:var(--tint-red-bg);border-radius:8px;color:var(--tint-red-fg)">Error: Error: ${e.message}</div>`;
        prog.style.display = 'none';
      }
    }
  }

  // ── Tab Actualizar Proveedor ──
  function renderTabProveedor(tc) {
    tc.innerHTML = `
      <div class="table-card" style="max-width:100%;width:100%">
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
        // Intentar primero el parser estándar; si trae 0, usar el flexible
        let provProductos = parseCatalogoCSV(text);
        if (!provProductos.length) {
          provProductos = parseProveedorFlexible(text);
        }
        if (!provProductos.length) {
          result.innerHTML = `<div style="padding:14px;background:var(--tint-red-bg);border-radius:8px;color:var(--tint-red-fg)">
            No se pudieron leer productos del CSV. Revisá que el archivo tenga columnas como
            <b>Producto</b>/<b>Descripción</b> y <b>Costo</b>/<b>Precio</b>/<b>Publico</b>.
          </div>`;
          return;
        }
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
            const costoCambio = Math.abs((cat.costo || 0) - (p.costo || 0)) > 0.01;
            const ventaCambio = Math.abs((cat.precio_venta || 0) - (p.precio_venta || 0)) > 0.01 && (p.precio_venta || 0) > 0;
            if (costoCambio || ventaCambio) {
              cambioPrecio.push({
                ...p,
                costo_anterior: cat.costo || 0,
                precio_venta_anterior: cat.precio_venta || 0,
                doc_id: cat.doc_id,
              });
            } else {
              sinCambio.push(p);
            }
          }
        });

        // "Coincidencias": productos del catálogo cuyo nombre aparece en la lista del proveedor.
        // Solo estos se pueden borrar (opcional). No se tocan productos que no estén en la lista.
        const coincidencias = [];
        allProductos.forEach(p => {
          if (provMap.has(slugify(p.nombre))) coincidencias.push(p);
        });

        let pendientes = { nuevos: [...nuevos], cambioPrecio: [...cambioPrecio], coincidencias: [...coincidencias] };

        result.innerHTML = `
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
            <div style="flex:1;min-width:120px;padding:12px;background:var(--tint-green-bg);border-radius:8px;border:1px solid var(--border);text-align:center">
              <div style="font-size:24px;font-weight:700;color:var(--tint-green-fg)">${nuevos.length}</div>
              <div style="font-size:12px;color:var(--tint-green-fg)">Productos nuevos</div>
            </div>
            <div style="flex:1;min-width:120px;padding:12px;background:var(--tint-yellow-bg);border-radius:8px;border:1px solid var(--border);text-align:center">
              <div style="font-size:24px;font-weight:700;color:var(--tint-yellow-fg)">${cambioPrecio.length}</div>
              <div style="font-size:12px;color:var(--tint-orange-fg)">Precios cambiaron</div>
            </div>
            <div style="flex:1;min-width:120px;padding:12px;background:var(--tint-red-bg);border-radius:8px;border:1px solid var(--border);text-align:center">
              <div style="font-size:24px;font-weight:700;color:var(--tint-red-fg)">${coincidencias.length}</div>
              <div style="font-size:12px;color:var(--tint-red-fg)">Coincidencias en catálogo</div>
            </div>
            <div style="flex:1;min-width:120px;padding:12px;background:var(--surface);border-radius:8px;border:1px solid var(--border);text-align:center">
              <div style="font-size:24px;font-weight:700">${sinCambio.length}</div>
              <div style="font-size:12px;color:var(--text-muted)">Sin cambios</div>
            </div>
          </div>

          ${nuevos.length > 0 ? `
          <div class="table-card" style="margin-bottom:12px">
            <div class="table-card-header" style="padding:12px 16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <h4 style="margin:0;flex:1;min-width:200px">Productos nuevos del proveedor</h4>
              <button id="btnGenCodigosTodos" style="padding:6px 12px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">Generar códigos a todos</button>
              <button id="btnAprobarNuevos" style="padding:6px 14px;background:var(--primary);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">✓ Agregar todos (${nuevos.length})</button>
            </div>
            <div class="table-wrap" style="max-height:500px;overflow:auto"><table style="min-width:1200px;table-layout:fixed">
              <thead style="position:sticky;top:0;background:var(--surface);z-index:1"><tr>
                <th style="min-width:420px;white-space:nowrap">Nombre</th>
                <th style="width:100px;white-space:nowrap">Costo</th>
                <th style="width:110px;white-space:nowrap">Precio venta</th>
                <th style="min-width:160px;white-space:nowrap">Categoría</th>
                <th style="width:110px;white-space:nowrap">Código</th>
                <th style="width:110px;white-space:nowrap">Cód. barra</th>
                <th style="width:95px;white-space:nowrap">Acciones</th>
              </tr></thead>
              <tbody id="nuevosTbody">${nuevos.map((p, i) => `
                <tr data-idx="${i}">
                  <td><input class="nv_nom" data-idx="${i}" type="text" value="${(p.nombre || '').replace(/"/g,'&quot;')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--surface);color:var(--text);box-sizing:border-box" /></td>
                  <td><input class="nv_cos" data-idx="${i}" type="number" min="0" step="0.01" value="${p.costo || 0}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--surface);color:var(--text);box-sizing:border-box" /></td>
                  <td><input class="nv_pv"  data-idx="${i}" type="number" min="0" step="0.01" value="${p.precio_venta || 0}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--surface);color:var(--text);box-sizing:border-box" /></td>
                  <td>
                    <select class="nv_cat" data-idx="${i}" style="width:100%;padding:5px 6px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--surface);color:var(--text);box-sizing:border-box">
                      ${[...new Set([p.categoria, ...allProductos.map(x => x.categoria)])].filter(Boolean).sort().map(c => `<option value="${c}"${c === p.categoria ? ' selected' : ''}>${c}</option>`).join('')}
                    </select>
                  </td>
                  <td><input class="nv_cod" data-idx="${i}" type="text" value="${(p.codigo || '').replace(/"/g,'&quot;')}" placeholder="AUTO-..." style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--surface);color:var(--text);box-sizing:border-box" /></td>
                  <td><input class="nv_bar" data-idx="${i}" type="text" value="${(p.cod_barra || '').replace(/"/g,'&quot;')}" placeholder="POS..." style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--surface);color:var(--text);box-sizing:border-box" /></td>
                  <td><button class="nv_gen" data-idx="${i}" style="padding:5px 10px;background:#6366f1;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;white-space:nowrap;width:100%">Generar</button></td>
                </tr>
              `).join('')}</tbody>
            </table></div>
          </div>` : ''}

          ${cambioPrecio.length > 0 ? `
          <div class="table-card" style="margin-bottom:12px">
            <div class="table-card-header" style="padding:12px 16px">
              <h4 style="margin:0">Productos con cambio de precio</h4>
              <button id="btnAprobarPrecios" style="padding:6px 14px;background:#d97706;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">✓ Actualizar todos (${cambioPrecio.length})</button>
            </div>
            <div class="table-wrap" style="max-height:500px;overflow:auto"><table style="min-width:900px">
              <thead style="position:sticky;top:0;background:var(--surface);z-index:1"><tr>
                <th style="min-width:280px">Nombre</th>
                <th style="white-space:nowrap">Costo anterior</th>
                <th style="white-space:nowrap">Nuevo costo</th>
                <th style="white-space:nowrap">P. venta anterior</th>
                <th style="white-space:nowrap">Nuevo p. venta</th>
                <th style="white-space:nowrap">Diferencia</th>
              </tr></thead>
              <tbody>${cambioPrecio.map(p => {
                const diff = (p.costo || 0) - (p.costo_anterior || 0);
                const color = diff > 0 ? '#dc2626' : '#16a34a';
                const sign = diff > 0 ? '+' : '';
                const diffVenta = (p.precio_venta || 0) - (p.precio_venta_anterior || 0);
                const colorVenta = diffVenta > 0 ? '#dc2626' : '#16a34a';
                const signVenta = diffVenta > 0 ? '+' : '';
                return `<tr>
                  <td>${p.nombre}</td>
                  <td>$${fmt(p.costo_anterior)}</td>
                  <td>$${fmt(p.costo)}</td>
                  <td>$${fmt(p.precio_venta_anterior)}</td>
                  <td style="color:${colorVenta};font-weight:700">$${fmt(p.precio_venta)}${diffVenta !== 0 ? ` (${signVenta}$${fmt(diffVenta)})` : ''}</td>
                  <td style="color:${color};font-weight:700">${sign}$${fmt(diff)}</td>
                </tr>`;
              }).join('')}</tbody>
            </table></div>
          </div>` : ''}

          ${coincidencias.length > 0 ? `
          <div class="table-card" style="margin-bottom:12px">
            <div class="table-card-header" style="padding:12px 16px">
              <h4 style="margin:0">Coincidencias en el catálogo (según nombres del proveedor)</h4>
              <button id="btnBorrarCoinc" style="padding:6px 14px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">Borrar seleccionados</button>
            </div>
            <div class="table-wrap" style="max-height:500px;overflow:auto"><table style="min-width:800px">
              <thead style="position:sticky;top:0;background:var(--surface);z-index:1"><tr>
                <th style="width:32px"><input type="checkbox" id="coincSelAll" /></th>
                <th style="min-width:280px">Nombre</th>
                <th style="white-space:nowrap">Costo actual</th>
                <th style="white-space:nowrap">Precio venta</th>
                <th style="min-width:160px">Categoría</th>
              </tr></thead>
              <tbody>${coincidencias.map((p, i) => `<tr>
                <td><input type="checkbox" class="coincChk" data-idx="${i}" /></td>
                <td>${p.nombre}${modIndicatorHtml(p)}</td>
                <td>$${fmt(p.costo)}</td>
                <td>$${fmt(p.precio_venta)}</td>
                <td>${p.categoria}</td>
              </tr>`).join('')}</tbody>
            </table></div>
          </div>` : ''}

          <div id="applyMsg"></div>
        `;

        // Edición inline de filas nuevas: sincronizar input → pendientes.nuevos
        const _bindInput = (cls, prop, transform) => {
          document.querySelectorAll(`.${cls}`).forEach(el => {
            el.addEventListener('input', e => {
              const idx = parseInt(e.target.dataset.idx);
              if (isNaN(idx) || !pendientes.nuevos[idx]) return;
              pendientes.nuevos[idx][prop] = transform ? transform(e.target.value) : e.target.value;
            });
            el.addEventListener('change', e => {
              const idx = parseInt(e.target.dataset.idx);
              if (isNaN(idx) || !pendientes.nuevos[idx]) return;
              pendientes.nuevos[idx][prop] = transform ? transform(e.target.value) : e.target.value;
            });
          });
        };
        _bindInput('nv_nom', 'nombre', v => (v || '').toUpperCase().trim());
        _bindInput('nv_cod', 'codigo', v => limpiarCodigo(v));
        _bindInput('nv_bar', 'cod_barra', v => limpiarCodigo(v));
        _bindInput('nv_cos', 'costo', v => parseFloat(v) || 0);
        _bindInput('nv_pv',  'precio_venta', v => parseFloat(v) || 0);
        _bindInput('nv_cat', 'categoria', v => v);

        // Generar código + barra para una fila
        document.querySelectorAll('.nv_gen').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            if (isNaN(idx) || !pendientes.nuevos[idx]) return;
            // Excluir la fila actual del pool de colisiones para permitir regenerar
            const poolPend = pendientes.nuevos.filter((_, i) => i !== idx);
            const { codigo, cod_barra } = generarCodigosUnicos(allProductos, poolPend);
            pendientes.nuevos[idx].codigo = codigo;
            pendientes.nuevos[idx].cod_barra = cod_barra;
            const codInput = document.querySelector(`.nv_cod[data-idx="${idx}"]`);
            const barInput = document.querySelector(`.nv_bar[data-idx="${idx}"]`);
            if (codInput) codInput.value = codigo;
            if (barInput) barInput.value = cod_barra;
          });
        });

        // Generar códigos a todas las filas que no tengan
        document.getElementById('btnGenCodigosTodos')?.addEventListener('click', () => {
          const poolPend = [];
          pendientes.nuevos.forEach((p, idx) => {
            const tieneCod = (p.codigo || '').toString().trim();
            const tieneBar = (p.cod_barra || '').toString().trim();
            if (tieneCod && tieneBar) { poolPend.push(p); return; }
            const { codigo, cod_barra } = generarCodigosUnicos(allProductos, poolPend);
            if (!tieneCod) p.codigo = codigo;
            if (!tieneBar) p.cod_barra = cod_barra;
            poolPend.push(p);
            const codInput = document.querySelector(`.nv_cod[data-idx="${idx}"]`);
            const barInput = document.querySelector(`.nv_bar[data-idx="${idx}"]`);
            if (codInput && !tieneCod) codInput.value = p.codigo;
            if (barInput && !tieneBar) barInput.value = p.cod_barra;
          });
        });

        document.getElementById('btnAprobarNuevos')?.addEventListener('click', async () => {
          const btn = document.getElementById('btnAprobarNuevos');
          const applyMsg = document.getElementById('applyMsg');
          btn.disabled = true; btn.textContent = 'Agregando...';
          try {
            // Asegurar que todos tengan código (sino, subirCatalogoFirebase puede colisionar con slugify)
            const poolPend = [];
            pendientes.nuevos.forEach(p => {
              if (!(p.codigo || '').toString().trim()) {
                const { codigo } = generarCodigosUnicos(allProductos, poolPend);
                p.codigo = codigo;
              }
              // Sanitizar: Firestore no permite '/' en doc IDs
              p.codigo = (p.codigo || '').toString().replace(/\//g, '-').trim();
              poolPend.push(p);
            });
            const total = pendientes.nuevos.length;
            await subirCatalogoFirebase(db, pendientes.nuevos, (done) => {
              btn.textContent = `Agregando ${done}/${total}...`;
            });
            invalidateCache('catalogo:all');
            await cargarDatos({ silent: true });
            renderStats();
            if (applyMsg) applyMsg.innerHTML = `<div style="padding:10px;background:var(--tint-green-bg);border-radius:8px;color:var(--tint-green-fg)">${total} productos nuevos agregados al catálogo.</div>`;
            btn.textContent = '✓ Hecho';
          } catch(err) {
            console.error('Error agregando productos:', err);
            if (applyMsg) applyMsg.innerHTML = `<div style="padding:10px;background:var(--tint-red-bg);border-radius:8px;color:var(--tint-red-fg)">Error agregando productos: ${err.message || err}</div>`;
            btn.disabled = false;
            btn.textContent = `✗ Reintentar (${pendientes.nuevos.length})`;
          }
        });

        document.getElementById('btnAprobarPrecios')?.addEventListener('click', async () => {
          const btn = document.getElementById('btnAprobarPrecios');
          const applyMsg = document.getElementById('applyMsg');
          btn.disabled = true; btn.textContent = 'Actualizando...';
          try {
            const total = pendientes.cambioPrecio.length;
            let done = 0;
            const _changes = [];
            for (const p of pendientes.cambioPrecio) {
              if (p.doc_id) {
                const _prev = allProductos.find(x => x.doc_id === p.doc_id) || {};
                const _after = { costo: p.costo || 0, estado: (p.costo || 0) === 0 ? 'sin_precio' : 'activo' };
                const _before = { costo: (_prev.costo ?? null), estado: (_prev.estado ?? null) };
                const update = { ..._after, ultima_actualizacion: serverTimestamp() };
                if ((p.precio_venta || 0) > 0) {
                  update.precio_venta = p.precio_venta;
                  _after.precio_venta = p.precio_venta;
                  _before.precio_venta = (_prev.precio_venta ?? null);
                }
                await updateDoc(doc(db, 'catalogo', p.doc_id), update);
                _changes.push({ docId: p.doc_id, invId: _prev.id || p.doc_id, syncInv: false, before: _before, after: _after });
              }
              done++;
              if (done % 10 === 0) btn.textContent = `Actualizando ${done}/${total}...`;
            }
            _touchCatalogoMeta(db).catch(() => {});
            if (_changes.length) hist.recordBatch(_changes, { label: `Actualizar ${_changes.length} precios (proveedor)` });
            invalidateCache('catalogo:all');
            await cargarDatos({ silent: true });
            renderStats();
            if (applyMsg) applyMsg.innerHTML = `<div style="padding:10px;background:var(--tint-yellow-bg);border-radius:8px;color:var(--tint-yellow-fg)">${total} precios actualizados.</div>`;
            btn.textContent = '✓ Hecho';
          } catch(err) {
            console.error('Error actualizando precios:', err);
            if (applyMsg) applyMsg.innerHTML = `<div style="padding:10px;background:var(--tint-red-bg);border-radius:8px;color:var(--tint-red-fg)">Error actualizando precios: ${err.message || err}</div>`;
            btn.disabled = false;
            btn.textContent = `✗ Reintentar (${pendientes.cambioPrecio.length})`;
          }
        });

        document.getElementById('coincSelAll')?.addEventListener('change', (e) => {
          document.querySelectorAll('.coincChk').forEach(cb => { cb.checked = e.target.checked; });
        });

        document.getElementById('btnBorrarCoinc')?.addEventListener('click', async () => {
          const checks = [...document.querySelectorAll('.coincChk:checked')];
          if (!checks.length) {
            alertDialog({ title: 'Sin selección', message: 'No hay productos seleccionados para borrar.', type: 'info' });
            return;
          }
          if (!await confirmModal({ title: 'Borrar productos', message: `¿Borrar <b>${checks.length}</b> producto(s) del catálogo?<br><span style="color:var(--text-muted)">Podés deshacerlo desde el historial (Ctrl+Z).</span>`, confirmText: 'Borrar', danger: true })) {
            return;
          }
          const btn = document.getElementById('btnBorrarCoinc');
          const applyMsg = document.getElementById('applyMsg');
          btn.disabled = true; btn.textContent = 'Borrando...';
          let borrados = 0;
          const _delChanges = [];
          for (const cb of checks) {
            const idx = parseInt(cb.dataset.idx);
            const p = pendientes.coincidencias[idx];
            if (p && p.doc_id) {
              try {
                const _full = allProductos.find(x => x.doc_id === p.doc_id);
                await _registerCatalogoDeleted(db, p.doc_id);
                await deleteDoc(doc(db, 'catalogo', p.doc_id));
                borrados++;
                if (_full) _delChanges.push({ docId: p.doc_id, invId: _full.id || null, syncInv: false, before: { ..._full, doc_id: p.doc_id }, after: null });
              } catch (e) { console.error('Borrando', p.doc_id, e); }
            }
          }
          _touchCatalogoMeta(db).catch(() => {});
          if (_delChanges.length) hist.recordBatch(_delChanges, { label: `Borrar ${_delChanges.length} producto(s)` });
          invalidateCache('catalogo:all');
          try {
            await cargarDatos({ silent: true });
            renderStats();
          } catch(e) { console.error('Recargando catalogo:', e); }
          if (applyMsg) applyMsg.innerHTML = `<div style="padding:10px;background:var(--tint-red-bg);border-radius:8px;color:var(--tint-red-fg)">${borrados} producto(s) borrado(s) del catálogo.</div>`;
          btn.textContent = 'Listo';
        });

      } catch(e) {
        result.innerHTML = `<div style="padding:12px;background:var(--tint-red-bg);border-radius:8px;color:var(--tint-red-fg)">Error: Error: ${e.message}</div>`;
      }
    }
  }

  // ── Editor de Margen ────────────────────────────────────────────────────────
  async function abrirEditorMargen(p) {
    // Overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px';

    const panel = document.createElement('div');
    panel.style.cssText = 'background:var(--surface);border-radius:16px;padding:24px;max-width:480px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,0.18)';
    
    const currentMargenPct = p.costo > 0 ? Math.round(((p.precio_venta - p.costo) / p.costo) * 100) : 0;

    panel.innerHTML = `
      <button id="cerrarEditor" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;color:var(--text-muted)">
        <span class="material-icons">close</span>
      </button>
      <h3 style="margin:0 0 16px;font-size:16px">${p.nombre}</h3>
      
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div style="background:var(--tint-blue-bg);border-radius:10px;padding:12px;border:1px solid var(--border)">
          <div style="font-size:11px;color:var(--tint-blue-fg);font-weight:600;margin-bottom:4px">COSTO</div>
          <div style="font-size:16px;font-weight:800;color:var(--tint-blue-fg)">$${fmt(p.costo)}</div>
        </div>
        <div style="background:var(--tint-green-bg);border-radius:10px;padding:12px;border:1px solid var(--border)">
          <div style="font-size:11px;color:var(--tint-green-fg);font-weight:600;margin-bottom:4px">PRECIO ACTUAL</div>
          <div style="font-size:16px;font-weight:800;color:var(--tint-green-fg)">$${fmt(p.precio_venta)}</div>
        </div>
      </div>

      <div style="background:var(--surface-2);border-radius:10px;padding:12px;margin-bottom:16px;border:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-bottom:4px">MARGEN ACTUAL</div>
        <div style="font-size:18px;font-weight:800;color:var(--tint-purple-fg)">${currentMargenPct}%</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:16px">
        <div>
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">% Margen</label>
          <input type="number" id="qm_pct" value="${currentMargenPct}" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box" />
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px">Precio Venta</label>
          <input type="number" id="qm_precio" value="${p.precio_venta}" step="0.01" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box" />
        </div>
      </div>

      <div style="background:var(--surface-2);border-radius:10px;padding:12px;margin-bottom:16px;border:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-bottom:4px">GANANCIA ESTIMADA</div>
        <div id="ganancia_live" style="font-size:18px;font-weight:800;color:var(--tint-green-fg)">$0.00</div>
      </div>

      <div style="display:flex;gap:10px">
        <button id="btnGuardarMargen" style="flex:1;padding:12px;background:var(--primary);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px">Guardar</button>
        <button id="btnCancelarMargen" style="flex:1;padding:12px;background:var(--bg);color:var(--text);border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px">Cancelar</button>
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
      const _precioPrev = p.precio_venta ?? null;
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
        if (_precioPrev !== nuevoPrecio) hist.recordUpdate(p.doc_id, { precio_venta: _precioPrev }, { precio_venta: nuevoPrecio }, {
          label: `Precio (margen) de ${p.nombre || p.name || p.doc_id}`, syncInv: true, invId: p.id || p.doc_id,
        });
        aplicarFiltros();
        renderStats();
        document.body.removeChild(overlay);
      } catch (e) {
        alertDialog({ title: 'Error', message: 'No se pudo guardar: ' + _escHtml(e.message), type: 'error' });
      }
    });

    document.getElementById('btnCancelarMargen').addEventListener('click', () => {
      document.body.removeChild(overlay);
    });

    document.getElementById('cerrarEditor').addEventListener('click', () => {
      document.body.removeChild(overlay);
    });

    let _mdEnFondoMg = false;
    overlay.addEventListener('mousedown', e => { _mdEnFondoMg = (e.target === overlay); });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && _mdEnFondoMg) document.body.removeChild(overlay);
    });
  }

  // ── Panel de Detalle del Producto ────────────────────────────────────────────
  async function abrirDetalle(p) {
    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'detalle-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px';

    // Stock efectivo a mostrar: si el producto está vinculado a otro de stock,
    // la disponibilidad sale del/los producto(s) fuente, no del stock propio.
    const _detLinked = _tieneLinks(p);
    const _detShown = _stockShown(p);
    const _detNum = _detShown.num;   // Infinity = servicio; nunca negativo
    const _detTxt = _detShown.text;
    // Caja/pack/rollo del producto (cargado, del conjunto, o deducido del nombre)
    // para poder escribir y mostrar los umbrales por envase en vez de por unidad.
    const _detBulto   = bultoDe(p);
    const _detBultoOn = p.stock_alerta_um === 'bulto' && !!_detBulto;

    const panel = document.createElement('div');
    panel.className = 'detalle-panel';
    panel.style.cssText = 'background:var(--surface);border-radius:16px;padding:20px;max-width:620px;width:100%;max-height:90vh;overflow-y:auto;position:relative;box-shadow:0 8px 40px rgba(0,0,0,0.18)';
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
        <div style="background:var(--bg);border-radius:10px;padding:12px;border:1px solid var(--border)">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-bottom:4px">CÓDIGO</div>
          <div style="font-size:15px;font-weight:700;color:var(--text)">${p.codigo || '-'}</div>
        </div>
        <div style="background:var(--bg);border-radius:10px;padding:12px;border:1px solid var(--border)">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-bottom:4px">COD. BARRA</div>
          <div style="font-size:13px;font-weight:700;color:var(--text)">${p.cod_barra || '-'}</div>
        </div>
        <div style="background:var(--tint-blue-bg);border-radius:10px;padding:12px;border:1px solid var(--border)">
          <div style="font-size:11px;color:var(--tint-blue-fg);font-weight:600;margin-bottom:4px">COSTO</div>
          <div style="font-size:16px;font-weight:800;color:var(--tint-blue-fg)">$${fmt(p.costo)}</div>
        </div>
        <div style="background:var(--tint-green-bg);border-radius:10px;padding:12px;border:1px solid var(--border)">
          <div style="font-size:11px;color:var(--tint-green-fg);font-weight:600;margin-bottom:4px">PRECIO VENTA</div>
          <div style="font-size:16px;font-weight:800;color:var(--tint-green-fg)">$${fmt(p.precio_venta)}</div>
        </div>
        <div style="background:${_detNum===0?'var(--tint-red-bg)':_detNum<=3?'var(--tint-yellow-bg)':'var(--bg)'};border-radius:10px;padding:12px;border:1px solid ${_detNum===0?'#ef9a9a':_detNum<=3?'#ffe082':'var(--border)'}">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-bottom:4px">STOCK${_detLinked ? ' (vinculado)' : ''}</div>
          <div style="font-size:22px;font-weight:800;color:${_detNum===0?'var(--tint-red-fg)':_detNum<=3?'var(--tint-orange-fg)':'var(--text)'}">${_detTxt}</div>
        </div>
        <div style="background:var(--tint-purple-bg);border-radius:10px;padding:12px;border:1px solid #ce93d8">
          <div style="font-size:11px;color:var(--tint-purple-fg);font-weight:600;margin-bottom:4px">MARGEN</div>
          <div style="font-size:18px;font-weight:800;color:var(--tint-purple-fg)">${p.costo > 0 ? Math.round(((p.precio_venta - p.costo) / p.costo) * 100) : 0}%</div>
        </div>
      </div>

      <div id="ventasDetalle" style="margin-top:8px">
        <div style="text-align:center;padding:20px;color:var(--text-muted)">Buscando ventas...</div>
      </div>

      <!-- Alertas de stock -->
      <div style="margin-top:12px;background:var(--tint-yellow-bg);border-radius:12px;padding:14px;border:1px solid var(--border)">
        <div style="font-size:13px;font-weight:700;color:var(--tint-orange-fg);margin-bottom:10px">Alertas de stock</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;font-weight:600;color:var(--text-muted)">STOCK MÍNIMO (avisar)</label>
            <input id="det_stock_min" type="number" min="0" step="any" placeholder="Sin alerta"
                   value="${_detBultoOn && _detBulto ? (Math.round(aBultos(Number(p.stock_min) || 0, _detBulto) * 100) / 100) || '' : (p.stock_min ?? '')}"
                   style="width:130px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-weight:700;color:var(--tint-orange-fg);background:var(--surface)" />
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;font-weight:600;color:var(--text-muted)">STOCK MÁXIMO (ideal)</label>
            <input id="det_stock_max" type="number" min="0" step="any" placeholder="Sin tope"
                   value="${_detBultoOn && _detBulto ? (Math.round(aBultos(Number(p.stock_max) || 0, _detBulto) * 100) / 100) || '' : (p.stock_max ?? '')}"
                   style="width:130px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-weight:700;color:var(--tint-orange-fg);background:var(--surface)" />
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;font-weight:600;color:var(--text-muted)">EN</label>
            <select id="det_alerta_um" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--surface)">
              <option value="unidad">Unidades</option>
              <option value="bulto"${_detBultoOn ? ' selected' : ''}${_detBulto ? '' : ' disabled'}>${_detBulto ? _escHtml(_detBulto.pl.charAt(0).toUpperCase() + _detBulto.pl.slice(1)) : 'Cajas'}</option>
            </select>
          </div>
          <button id="det_guardar_stock_alert" style="padding:8px 16px;background:#f59e0b;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px">Guardar alertas</button>
        </div>
        <div id="det_stock_alert_msg" style="margin-top:8px;font-size:12px;color:var(--text-muted)">${
          _detBulto
            ? `1 ${_escHtml(_detBulto.sg)} = <b>${_detBulto.contenido}</b> u${_detBulto.fuente === 'nombre' ? ' (detectado del nombre)' : _detBulto.fuente === 'conjunto' ? ' (del envase del conjunto)' : ''}. Eligiendo "${_escHtml(_detBulto.pl)}" el aviso sale por ${_escHtml(_detBulto.sg)}.`
            : 'Dejá vacío para desactivar el aviso. El POS usa estos valores para avisarte cuando un producto baja del mínimo.'
        }</div>
      </div>

      <!-- Edición de precio por margen -->
      <div style="margin-top:12px;background:var(--bg);border-radius:12px;padding:14px;border:1px solid var(--border)">
        <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:10px">Editar precio por margen</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;font-weight:600;color:var(--text-muted)">COSTO ACTUAL</label>
            <div style="padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-weight:700;color:var(--tint-blue-fg);font-size:14px">$${fmt(p.costo)}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;font-weight:600;color:var(--text-muted)">% MARGEN</label>
            <input id="det_pct" type="number" value="${p.costo > 0 ? Math.round(((p.precio_venta - p.costo)/p.costo)*100) : 0}" min="0" step="1" style="width:90px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-weight:700;color:var(--tint-purple-fg);background:var(--surface)" />
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;font-weight:600;color:var(--text-muted)">PRECIO VENTA</label>
            <input id="det_precio" type="number" value="${p.precio_venta || 0}" min="0" step="0.01" style="width:120px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-weight:700;color:var(--tint-green-fg);background:var(--surface)" />
          </div>
          <button id="det_guardar_precio" style="padding:8px 16px;background:#1877f2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px">Guardar precio</button>
        </div>
        <div id="det_precio_msg" style="margin-top:8px;font-size:12px"></div>
      </div>

      ${(() => {
        const _ed = _tsToDate(p.ultima_actualizacion);
        const _d = _ed || _tsToDate(p.fecha_creacion);
        const _label = _ed ? 'Última modificación' : 'Creado';
        const _val = _d ? `${_fmtAbsoluto(_d)} · ${_fmtRelativo(_d)}` : 'sin registro';
        return `<div style="margin-top:12px;font-size:12px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:10px">${_label}: ${_escHtml(_val)}</div>`;
      })()}
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    document.getElementById('cerrarDetalle').addEventListener('click', () => overlay.remove());
    let _mdEnFondoDet = false;
    overlay.addEventListener('mousedown', e => { _mdEnFondoDet = (e.target === overlay); });
    overlay.addEventListener('click', e => { if (e.target === overlay && _mdEnFondoDet) overlay.remove(); });

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
      let sMin = rawMin === '' ? null : Math.max(0, parseFloat(rawMin.replace(',', '.')) || 0);
      let sMax = rawMax === '' ? null : Math.max(0, parseFloat(rawMax.replace(',', '.')) || 0);
      if (sMin !== null && sMax !== null && sMax > 0 && sMax < sMin) {
        msg.innerHTML = `<span style="color:var(--tint-red-fg)">El máximo no puede ser menor al mínimo.</span>`;
        return;
      }
      // Umbrales escritos en cajas/packs → se guardan en unidades.
      const porBulto = document.getElementById('det_alerta_um').value === 'bulto' && !!_detBulto;
      const enBultos = { min: sMin, max: sMax };
      if (porBulto) {
        // Ver el comentario de `aUnidadesEstable`: guardar sin tocar el campo
        // no puede correr el umbral.
        if (sMin !== null) sMin = aUnidadesEstable(sMin, _detBulto, p.stock_min);
        if (sMax !== null) sMax = aUnidadesEstable(sMax, _detBulto, p.stock_max);
      }
      btn.disabled = true; btn.textContent = 'Guardando...';
      const _alertBefore = { stock_min: (p.stock_min ?? null), stock_max: (p.stock_max ?? null) };
      try {
        await updateDoc(doc(db, 'catalogo', p.doc_id), {
          stock_min: sMin,
          stock_max: sMax,
          stock_alerta_um: porBulto ? 'bulto' : null,
          // El envase deducido del nombre se fija al elegirlo, para que el aviso
          // no cambie si después se edita el nombre del producto.
          ...(porBulto && _detBulto.fuente !== 'conjunto'
            ? { bulto_tipo: _detBulto.tipo, bulto_contenido: _detBulto.contenido }
            : {}),
          ultima_actualizacion: serverTimestamp()
        });
        invalidateCacheByPrefix('catalogo');
        _touchCatalogoMeta(db).catch(() => {});
        const idx = allProductos.findIndex(x => x.doc_id === p.doc_id);
        const _patch = {
          stock_min: sMin, stock_max: sMax,
          stock_alerta_um: porBulto ? 'bulto' : null,
          ...(porBulto && _detBulto.fuente !== 'conjunto'
            ? { bulto_tipo: _detBulto.tipo, bulto_contenido: _detBulto.contenido }
            : {}),
        };
        if (idx !== -1) Object.assign(allProductos[idx], _patch);
        Object.assign(p, _patch);
        if (_alertBefore.stock_min !== sMin || _alertBefore.stock_max !== sMax)
          hist.recordUpdate(p.doc_id, _alertBefore, { stock_min: sMin, stock_max: sMax }, {
            label: `Alertas de stock de ${p.nombre || p.name || p.doc_id}`,
          });
        const _um = porBulto
          ? (v) => `${v} ${v === 1 ? _detBulto.sg : _detBulto.pl}`
          : (v) => `${v}`;
        msg.innerHTML = `<span style="color:var(--tint-green-fg)">Alertas guardadas ${enBultos.min !== null ? `· mín ${_um(enBultos.min)}` : ''} ${enBultos.max !== null ? `· máx ${_um(enBultos.max)}` : ''}</span>`;
      } catch(e) {
        msg.innerHTML = `<span style="color:var(--tint-red-fg)">Error: ${e.message}</span>`;
      }
      btn.disabled = false; btn.textContent = 'Guardar alertas';
    });

    document.getElementById('det_guardar_precio').addEventListener('click', async () => {
      const nuevoPrecio = parseFloat(detPrecio.value) || 0;
      const btn = document.getElementById('det_guardar_precio');
      btn.disabled = true; btn.textContent = 'Guardando...';
      const _precioPrev = p.precio_venta ?? null;
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
        if (_precioPrev !== nuevoPrecio) hist.recordUpdate(p.doc_id, { precio_venta: _precioPrev }, { precio_venta: nuevoPrecio }, {
          label: `Precio de ${p.nombre || p.name || p.doc_id}`, syncInv: true, invId: p.id || p.doc_id,
        });
        detMsg.innerHTML = `<span style="color:var(--tint-green-fg)">Precio actualizado a $${fmt(nuevoPrecio)}</span>`;
        renderStats();
      } catch(e) {
        detMsg.innerHTML = `<span style="color:var(--tint-red-fg)">Error: Error: ${e.message}</span>`;
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
        <h4 style="margin:0 0 12px;font-size:14px;font-weight:700;border-top:1px solid var(--border);padding-top:12px;color:var(--text)">Datos de Ventas</h4>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
          <div style="flex:1;min-width:110px;padding:12px;background:var(--tint-blue-bg);border-radius:10px;text-align:center;border:1px solid var(--border)">
            <div style="font-size:24px;font-weight:800;color:var(--tint-blue-fg)">${totalUnidades}</div>
            <div style="font-size:11px;color:var(--tint-blue-fg);font-weight:500;margin-top:2px">Unidades vendidas</div>
          </div>
          <div style="flex:1;min-width:110px;padding:12px;background:var(--tint-green-bg);border-radius:10px;text-align:center;border:1px solid var(--border)">
            <div style="font-size:20px;font-weight:800;color:var(--tint-green-fg)">$${fmt(totalIngresos)}</div>
            <div style="font-size:11px;color:var(--tint-green-fg);font-weight:500;margin-top:2px">Ingresos totales</div>
          </div>
          <div style="flex:1;min-width:110px;padding:12px;background:var(--surface-2);border-radius:10px;text-align:center;border:1px solid var(--border)">
            <div style="font-size:22px;font-weight:800;color:var(--text)">${ventasProd.length}</div>
            <div style="font-size:11px;color:var(--text-muted);font-weight:500;margin-top:2px">Registros</div>
          </div>
          <div style="flex:1;min-width:110px;padding:12px;background:var(--tint-yellow-bg);border-radius:10px;text-align:center;border:1px solid var(--border)">
            <div style="font-size:14px;font-weight:700;color:var(--tint-orange-fg)">${ultimaVenta || '-'}</div>
            <div style="font-size:11px;color:var(--tint-orange-fg);font-weight:500;margin-top:2px">Última venta</div>
          </div>
        </div>
        ${ventasProd.length > 0 ? `
        <div style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:10px">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="background:var(--bg);position:sticky;top:0">
              <th style="padding:8px 10px;text-align:left;color:var(--text-muted);font-weight:600">Fecha</th>
              <th style="padding:8px 10px;text-align:left;color:var(--text-muted);font-weight:600">Cajero</th>
              <th style="padding:8px 10px;text-align:center;color:var(--text-muted);font-weight:600">Cant.</th>
              <th style="padding:8px 10px;text-align:right;color:var(--text-muted);font-weight:600">Subtotal</th>
            </tr></thead>
            <tbody>${ventasProd.slice(0, 30).map((v, i) => `
              <tr style="border-top:1px solid var(--border);background:${i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)'}">
                <td style="padding:7px 10px;color:var(--text)">${v.fecha || '-'}</td>
                <td style="padding:7px 10px;color:var(--text-muted)">${v.cajero || '-'}</td>
                <td style="padding:7px 10px;text-align:center;font-weight:700;color:var(--tint-blue-fg)">${v.cantidad || 1}</td>
                <td style="padding:7px 10px;text-align:right;font-weight:700;color:var(--tint-green-fg)">$${fmt(v.subtotal)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>` : `<div style="background:var(--surface-2);border-radius:10px;padding:20px;text-align:center;color:var(--text-muted);font-size:13px">Sin registros de venta para este producto.</div>`}
      `;
    } catch(e) {
      const ventasEl = document.getElementById('ventasDetalle');
      if (ventasEl) ventasEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">No se pudieron cargar los datos de ventas.</p>`;
    }
  }

  // ── Tab Nuevo Producto (manual) ───────────────────────────────────────────────
  function renderTabNuevo(tc) {
    // El tab "Nuevo" ahora delega al editor completo en modo crear.
    // Así garantizamos paridad de features (variedades, vinculaciones,
    // producto conjunto, precios redondeados, margen automático, etc.) sin
    // duplicar código entre dos formularios.
    tc.innerHTML = `
      <div class="table-card" style="max-width:560px">
        <div class="table-card-header"><h3>Agregar Producto</h3></div>
        <div style="padding:24px;display:flex;flex-direction:column;gap:14px;align-items:flex-start">
          <div style="font-size:13.5px;color:var(--text-muted);line-height:1.55">
            Creá un producto nuevo con el mismo editor que usás para editar:
            todos los campos disponibles (rubro, marca, código, costo, precio,
            stock, alertas), <b>variedades</b> (Producto Conjunto: packs, rollos
            o cajas con múltiples colores) y <b>vinculaciones a otros productos</b>
            (consumibles que se descuentan automáticamente al vender).
          </div>
          <div style="font-size:13px;color:var(--text-muted);background:var(--surface-2,var(--surface-2));border-radius:8px;padding:10px 14px;line-height:1.5">
            El botón <b style="color:var(--tint-purple-fg)">Generar</b> al lado del código asigna
            un número único de 6 dígitos. El código interno y el código de barras
            quedan iguales — así cualquier escaneo o tipeo resuelve el producto.
          </div>
          <button id="np_abrir_editor" type="button" style="margin-top:6px;padding:12px 22px;background:#16a34a;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:8px;font-family:inherit">
            <span class="material-icons" style="font-size:18px">add_circle</span>Agregar producto
          </button>
        </div>
      </div>
    `;

    document.getElementById('np_abrir_editor')?.addEventListener('click', () => {
      abrirEditorCompleto({});
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
              <label style="font-size:12px;font-weight:600;color:var(--text-muted)">COSTO</label>
              <input id="calc_costo" type="number" placeholder="0.00" step="0.01" style="width:130px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px" />
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:12px;font-weight:600;color:var(--text-muted)">% MARGEN</label>
              <input id="calc_pct" type="number" placeholder="80" step="1" style="width:100px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;color:var(--tint-purple-fg);font-weight:700" />
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:12px;font-weight:600;color:var(--text-muted)">PRECIO VENTA</label>
              <input id="calc_precio" type="number" placeholder="0.00" step="0.01" style="width:130px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;color:var(--tint-green-fg);font-weight:700" />
            </div>
            <div id="calc_result" style="padding:8px 14px;background:var(--bg);border-radius:8px;font-size:13px;color:var(--text-muted);align-self:flex-end"></div>
          </div>
        </div>

        <!-- Aplicación masiva -->
        <div class="table-card">
          <div class="table-card-header"><h3>Aplicar Margen en Lote</h3></div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:14px">
            <p style="font-size:13px;color:var(--text-muted);margin:0">Seleccioná un grupo de productos y aplicá un % de margen sobre el costo. El sistema calculará y actualizará el precio de venta automáticamente.</p>

            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
              <div style="display:flex;flex-direction:column;gap:4px">
                <label style="font-size:12px;font-weight:600;color:var(--text-muted)">APLICAR A</label>
                <select id="mas_tipo" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
                  <option value="todos">Todos los productos</option>
                  <option value="categoria">Por Categoría</option>
                  <option value="proveedor">Por Proveedor</option>
                  <option value="marca">Por Marca</option>
                  <option value="producto">Producto específico</option>
                </select>
              </div>
              <div id="mas_filtro_wrap" style="display:none;flex-direction:column;gap:4px">
                <label id="mas_filtro_label" style="font-size:12px;font-weight:600;color:var(--text-muted)">CATEGORÍA</label>
                <select id="mas_filtro_val" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px"></select>
              </div>
              <div id="mas_prod_wrap" style="display:none;flex-direction:column;gap:6px;grid-column:1/-1">
                <label style="font-size:12px;font-weight:600;color:var(--text-muted)">BUSCAR PRODUCTO</label>
                <input id="mas_prod_buscar" type="text" placeholder="🔍 Escribí el nombre del producto..." style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;width:100%" />
                <div id="mas_prod_lista" style="border:1px solid var(--border);border-radius:8px;max-height:200px;overflow-y:auto;display:none;background:var(--surface)"></div>
                <div id="mas_prod_seleccionado" style="display:none;padding:10px 14px;background:var(--tint-blue-bg);border-radius:8px;border:1px solid var(--border);align-items:center;justify-content:space-between">
                  <div>
                    <div id="mas_prod_nombre" style="font-weight:700;font-size:13px;color:var(--text)"></div>
                    <div id="mas_prod_info" style="font-size:12px;color:var(--text-muted);margin-top:2px"></div>
                  </div>
                  <button id="mas_prod_quitar" style="background:none;border:none;cursor:pointer;color:var(--tint-red-fg);font-size:13px">Quitar</button>
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:4px">
                <label style="font-size:12px;font-weight:600;color:var(--text-muted)">% DE MARGEN SOBRE COSTO</label>
                <input id="mas_pct" type="number" placeholder="Ej: 80" min="0" step="1" style="padding:8px 12px;border:2px solid #7b1fa2;border-radius:8px;font-size:16px;font-weight:700;color:var(--tint-purple-fg);width:120px" />
              </div>
              <div style="display:flex;flex-direction:column;gap:4px">
                <label style="font-size:12px;font-weight:600;color:var(--text-muted)">SOLO PRODUCTOS CON COSTO</label>
                <label style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg);border-radius:8px;cursor:pointer">
                  <input type="checkbox" id="mas_solocosto" checked style="width:16px;height:16px" />
                  <span style="font-size:13px">Ignorar productos sin costo (costo = 0)</span>
                </label>
              </div>
            </div>

            <!-- Preview -->
            <div id="mas_preview" style="display:none;background:var(--bg);border-radius:10px;padding:12px;font-size:13px">
              <b id="mas_preview_count"></b> productos serán actualizados
            </div>

            <div style="display:flex;gap:10px">
              <button id="mas_preview_btn" style="padding:10px 20px;background:var(--bg);border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;color:var(--text)">Vista previa</button>
              <button id="mas_aplicar" style="padding:10px 24px;background:#1877f2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:700" disabled>Aplicar a todos</button>
            </div>

            <div id="mas_progress" style="display:none;flex-direction:column;gap:8px">
              <div style="display:flex;justify-content:space-between;font-size:13px">
                <span id="mas_prog_text">Aplicando...</span>
                <span id="mas_prog_pct">0%</span>
              </div>
              <div style="background:var(--border);border-radius:99px;height:8px;overflow:hidden">
                <div id="mas_prog_bar" style="height:100%;background:#1877f2;width:0%;transition:width 0.3s;border-radius:99px"></div>
              </div>
            </div>

            <div id="mas_result"></div>

            <!-- Tabla preview -->
            <div id="mas_tabla" style="display:none">
              <div class="table-wrap" style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:10px">
                <table style="width:100%;border-collapse:collapse;font-size:12px">
                  <thead><tr style="background:var(--bg);position:sticky;top:0">
                    <th style="padding:8px 10px;text-align:left;color:var(--text-muted)">Producto</th>
                    <th style="padding:8px 10px;text-align:right;color:var(--text-muted)">Costo</th>
                    <th style="padding:8px 10px;text-align:right;color:var(--text-muted)">Precio actual</th>
                    <th style="padding:8px 10px;text-align:right;color:var(--text-muted)">Nuevo precio</th>
                    <th style="padding:8px 10px;text-align:right;color:var(--text-muted)">Diferencia</th>
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
        rCalc.innerHTML = `Ganancia: <b style="color:var(--tint-green-fg)">$${fmt(ganancia)}</b>${sug ? ' &nbsp; ' + sug : ''}`;
      } else if (origen === 'precio' && !isNaN(precio)) {
        precioCalc = precio;
        pCalc.value = Math.round(((precio - costo)/costo)*100);
        const ganancia = precio - costo;
        const sug = sugerirRedondo(costo, precio);
        rCalc.innerHTML = `Ganancia: <b style="color:var(--tint-green-fg)">$${fmt(ganancia)}</b>${sug ? ' &nbsp; ' + sug : ''}`;
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
        <div class="prod-option" data-id="${p.doc_id}" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);transition:background 0.15s">
          <div style="font-weight:600;font-size:13px;color:var(--text)">${p.nombre}</div>
          <div style="font-size:11px;color:var(--text-muted)">${p.categoria} · Costo: $${fmt(p.costo)} · Precio: $${fmt(p.precio_venta)}</div>
        </div>`).join('');
      prodLista.querySelectorAll('.prod-option').forEach(opt => {
        opt.addEventListener('mouseenter', () => opt.style.background = 'var(--bg)');
        opt.addEventListener('mouseleave', () => opt.style.background = '');
        opt.addEventListener('click', () => {
          productoSeleccionado = allProductos.find(p => p.doc_id === opt.dataset.id);
          prodNombre.textContent = productoSeleccionado.nombre;
          prodInfo.textContent = `${productoSeleccionado.categoria} · Costo: $${fmt(productoSeleccionado.costo)} · Precio actual: $${fmt(productoSeleccionado.precio_venta)}`;
          prodSel.style.cssText = 'display:flex;padding:10px 14px;background:var(--tint-blue-bg);border-radius:8px;border:1px solid var(--border);align-items:center;justify-content:space-between';
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
      if (!pct && pct !== 0) { alertDialog({ title: 'Falta el margen', message: 'Ingresá un % de margen.', type: 'warning' }); return; }
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
        return `<tr style="border-top:1px solid var(--border);background:${i%2===0?'var(--surface)':'var(--surface-2)'}">
          <td style="padding:6px 10px;font-size:12px">${p.nombre}</td>
          <td style="padding:6px 10px;text-align:right;color:var(--tint-blue-fg)">$${fmt(p.costo)}</td>
          <td style="padding:6px 10px;text-align:right;color:var(--text-muted)">$${fmt(p.precio_venta)}</td>
          <td style="padding:6px 10px;text-align:right;font-weight:700;color:var(--tint-green-fg)">$${fmt(p.nuevo_precio)}</td>
          <td style="padding:6px 10px;text-align:right;font-weight:700;color:${color}">${sign}$${fmt(diff)}</td>
        </tr>`;
      }).join('') + (afectados.length > 50 ? `<tr><td colspan="5" style="text-align:center;padding:8px;color:var(--text-muted);font-size:12px">... y ${afectados.length-50} más</td></tr>` : '');
    });

    // Aplicar masivamente
    document.getElementById('mas_aplicar').addEventListener('click', async () => {
      const afectados = getAfectados();
      if (!afectados.length) return;
      if (!await confirmModal({ title: 'Actualizar precios', message: `¿Actualizar precio de <b>${afectados.length}</b> productos con el margen indicado?`, confirmText: 'Actualizar' })) return;

      const progWrap = document.getElementById('mas_progress');
      const progBar  = document.getElementById('mas_prog_bar');
      const progText = document.getElementById('mas_prog_text');
      const progPct  = document.getElementById('mas_prog_pct');
      const resEl    = document.getElementById('mas_result');
      progWrap.style.display = 'flex';
      document.getElementById('mas_aplicar').disabled = true;

      const BATCH = 400;
      let done = 0;
      const _changes = [];
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
          _changes.push({
            docId: p.doc_id, invId: p.id || p.doc_id, syncInv: true,
            before: { precio_venta: (p.precio_venta ?? null) },
            after:  { precio_venta: p.nuevo_precio },
          });
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
      if (_changes.length) hist.recordBatch(_changes, { label: `Margen masivo · ${_changes.length} precios` });
      invalidateCache('catalogo:all');
      await cargarDatos();
      renderStats();
      progWrap.style.display = 'none';
      resEl.innerHTML = `<div style="padding:12px;background:var(--tint-green-bg);border-radius:8px;border:1px solid var(--border);color:var(--tint-green-fg);font-weight:600">${afectados.length} productos actualizados correctamente.</div>`;
      document.getElementById('mas_aplicar').disabled = false;
    });
  }


  // ── Tab Reportes ─────────────────────────────────────────────────────────────
  async function renderTabReportes(tc) {
    tc.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">Calculando reportes...</div>`;

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
        <div style="font-size:13px;color:var(--text-muted);padding:4px 0">
          Sección: <b style="color:var(--tint-blue-fg)">${rubroActivo === 'TODOS' ? 'Todas' : rubroActivo}</b> &nbsp;·&nbsp; <b>${base.length}</b> productos
        </div>

        <!-- TARJETAS PRINCIPALES CLICKEABLES -->
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px">
          <div class="rep-card" data-panel="margen" style="${cardClickStyle}background:var(--tint-blue-bg);border-radius:12px;padding:14px;border:1px solid var(--border)">
            <div style="font-size:11px;font-weight:700;color:var(--tint-blue-fg)">PRODUCTOS CON PRECIO</div>
            <div style="font-size:26px;font-weight:800;color:var(--tint-blue-fg);margin-top:4px">${conPrecio.length}</div>
            <div style="font-size:11px;color:var(--tint-blue-fg);margin-top:4px">Ver margen por categoría →</div>
          </div>
          <div class="rep-card" data-panel="ganancia" style="${cardClickStyle}background:var(--tint-green-bg);border-radius:12px;padding:14px;border:1px solid var(--border)">
            <div style="font-size:11px;font-weight:700;color:var(--tint-green-fg)">GANANCIA TEÓRICA</div>
            <div style="font-size:20px;font-weight:800;color:var(--tint-green-fg);margin-top:4px">$${fmt(gananciaTeoric)}</div>
            <div style="font-size:11px;color:var(--tint-green-fg);margin-top:4px">Margen promedio: ${margenPromedio}% →</div>
          </div>
          <div class="rep-card" data-panel="ingresos" style="${cardClickStyle}background:var(--tint-yellow-bg);border-radius:12px;padding:14px;border:1px solid var(--border)">
            <div style="font-size:11px;font-weight:700;color:var(--tint-orange-fg)">INGRESOS REALES</div>
            <div style="font-size:20px;font-weight:800;color:var(--tint-orange-fg);margin-top:4px">$${fmt(totalIngresosReal)}</div>
            <div style="font-size:11px;color:var(--tint-orange-fg);margin-top:4px">Ver por día y mes →</div>
          </div>
          <div class="rep-card" data-panel="unidades" style="${cardClickStyle}background:var(--tint-red-bg);border-radius:12px;padding:14px;border:1px solid #f48fb1">
            <div style="font-size:11px;font-weight:700;color:var(--tint-purple-fg)">UNIDADES VENDIDAS</div>
            <div style="font-size:26px;font-weight:800;color:var(--tint-purple-fg);margin-top:4px">${totalVendidoReal}</div>
            <div style="font-size:11px;color:var(--tint-purple-fg);margin-top:4px">Ver más vendidos →</div>
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
                <span style="font-size:12px;color:var(--text-muted)">${catRows.length} categorías</span>
              </div>
              <div class="table-wrap" style="max-height:350px;overflow-y:auto">
                <table>
                  <thead><tr>
                    <th>Categoría</th><th style="text-align:center">Productos</th>
                    <th style="text-align:right">Costo total</th><th style="text-align:right">Precio total</th>
                    <th style="text-align:right">Ganancia</th><th style="text-align:right">Margen</th>
                  </tr></thead>
                  <tbody>${catRows.map((r,i)=>`
                    <tr style="background:${i%2===0?'var(--surface)':'var(--surface-2)'}">
                      <td><span class="badge badge-gray">${r.cat}</span></td>
                      <td style="text-align:center">${r.productos}</td>
                      <td style="text-align:right;color:var(--tint-blue-fg)">$${fmt(r.costo)}</td>
                      <td style="text-align:right;color:var(--tint-green-fg)">$${fmt(r.venta)}</td>
                      <td style="text-align:right;font-weight:700;color:var(--tint-green-fg)">$${fmt(r.venta-r.costo)}</td>
                      <td style="text-align:right;font-weight:700;color:var(--tint-purple-fg)">${r.margen}%</td>
                    </tr>`).join('')}
                  </tbody>
                </table>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
              <div class="table-card">
                <div class="table-card-header" style="padding:12px 16px"><h4 style="margin:0;font-size:14px">Mayor Margen</h4></div>
                <div class="table-wrap">
                  <table><thead><tr><th>Producto</th><th style="text-align:right">Margen</th></tr></thead>
                  <tbody>${topMargen.map((p,i)=>`<tr style="background:${i%2===0?'var(--surface)':'var(--surface-2)'}"><td style="font-size:12px">${p.nombre}</td><td style="text-align:right;font-weight:700;color:var(--tint-green-fg)">${p.margen.toFixed(1)}%</td></tr>`).join('')}</tbody></table>
                </div>
              </div>
              <div class="table-card">
                <div class="table-card-header" style="padding:12px 16px"><h4 style="margin:0;font-size:14px">Menor Margen</h4></div>
                <div class="table-wrap">
                  <table><thead><tr><th>Producto</th><th style="text-align:right">Margen</th></tr></thead>
                  <tbody>${bottomMargen.map((p,i)=>`<tr style="background:${i%2===0?'var(--surface)':'var(--surface-2)'}"><td style="font-size:12px">${p.nombre}</td><td style="text-align:right;font-weight:700;color:${p.margen<0?'var(--tint-red-fg)':'var(--tint-orange-fg)'}">${p.margen.toFixed(1)}%</td></tr>`).join('')}</tbody></table>
                </div>
              </div>
            </div>
          </div>`;
      }

      else if (tipo === 'ingresos') {
        panel.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:12px">
            <div class="table-card">
              <div class="table-card-header" style="padding:12px 16px"><h3 style="margin:0">Ventas por Día</h3><span style="font-size:12px;color:var(--text-muted)">Últimos 30 días</span></div>
              <div class="table-wrap" style="max-height:300px;overflow-y:auto">
                <table><thead><tr><th>Fecha</th><th style="text-align:center">Ventas</th><th style="text-align:center">Unidades</th><th style="text-align:right">Ingresos</th></tr></thead>
                <tbody>${diasOrdenados.map(([dia,d],i)=>`
                  <tr style="background:${i%2===0?'var(--surface)':'var(--surface-2)'}">
                    <td style="font-weight:600">${dia}</td>
                    <td style="text-align:center;color:var(--text-muted)">${d.ventas}</td>
                    <td style="text-align:center;font-weight:700;color:var(--tint-blue-fg)">${d.unidades}</td>
                    <td style="text-align:right;font-weight:700;color:var(--tint-green-fg)">$${fmt(d.ingresos)}</td>
                  </tr>`).join('')}
                </tbody></table>
              </div>
            </div>
            <div class="table-card">
              <div class="table-card-header" style="padding:12px 16px"><h3 style="margin:0">Ventas por Mes</h3></div>
              <div class="table-wrap">
                <table><thead><tr><th>Mes</th><th style="text-align:center">Transacciones</th><th style="text-align:center">Unidades</th><th style="text-align:right">Ingresos</th></tr></thead>
                <tbody>${mesesOrdenados.map(([mes,d],i)=>`
                  <tr style="background:${i%2===0?'var(--surface)':'var(--surface-2)'}">
                    <td style="font-weight:600">${mes}</td>
                    <td style="text-align:center;color:var(--text-muted)">${d.ventas}</td>
                    <td style="text-align:center;font-weight:700;color:var(--tint-blue-fg)">${d.unidades}</td>
                    <td style="text-align:right;font-weight:700;color:var(--tint-green-fg)">$${fmt(d.ingresos)}</td>
                  </tr>`).join('')}
                </tbody></table>
              </div>
            </div>
          </div>`;
      }

      else if (tipo === 'unidades') {
        panel.innerHTML = `
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
            <div class="table-card">
              <div class="table-card-header" style="padding:12px 16px"><h3 style="margin:0">Más Vendidos por Unidades</h3></div>
              <div class="table-wrap">
                <table><thead><tr><th>Rank</th><th>Producto</th><th style="text-align:right">Unidades</th></tr></thead>
                <tbody>${topVendidos.map((p,i)=>`
                  <tr style="background:${i%2===0?'var(--surface)':'var(--surface-2)'}">
                    <td style="text-align:center;font-weight:700;color:${i===0?'var(--tint-orange-fg)':i===1?'var(--text-muted)':i===2?'var(--tint-purple-fg)':'var(--text)'}">${i+1}</td>
                    <td style="font-size:12px">${p.nombre}</td>
                    <td style="text-align:right;font-weight:800;color:var(--tint-blue-fg)">${p.unidades}</td>
                  </tr>`).join('')}
                </tbody></table>
              </div>
            </div>
            <div class="table-card">
              <div class="table-card-header" style="padding:12px 16px"><h3 style="margin:0">Más Ingresos ($)</h3></div>
              <div class="table-wrap">
                <table><thead><tr><th>Rank</th><th>Producto</th><th style="text-align:right">Ingresos</th></tr></thead>
                <tbody>${topIngresos.map((p,i)=>`
                  <tr style="background:${i%2===0?'var(--surface)':'var(--surface-2)'}">
                    <td style="text-align:center;font-weight:700;color:${i===0?'var(--tint-orange-fg)':i===1?'var(--text-muted)':i===2?'var(--tint-purple-fg)':'var(--text)'}">${i+1}</td>
                    <td style="font-size:12px">${p.nombre}</td>
                    <td style="text-align:right;font-weight:800;color:var(--tint-green-fg)">$${fmt(p.ingresos)}</td>
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


  // ── Tab Etiquetas: selección masiva → PDF imprimible con códigos de barra ──
  // Estado interno (sobrevive a re-renders del tab mientras no se salga de catálogo)
  const etqSel = new Set();           // doc_ids seleccionados
  let   etqOpts = {                   // opciones de layout — persisten en localStorage
    cols: 4, rows: 10, copias: 1,
    mostrarPrecio: false, mostrarCodigo: true,
  };
  try {
    const saved = JSON.parse(localStorage.getItem('cat:etq_opts') || '{}');
    Object.assign(etqOpts, saved);
  } catch (_) {}
  const persistirOpts = () => localStorage.setItem('cat:etq_opts', JSON.stringify(etqOpts));

  function renderTabEtiquetas(tc) {
    const base = getBaseRubro();
    const cats  = [...new Set(base.map(p => p.categoria).filter(Boolean))].sort();
    const provs = [...new Set(base.map(p => p.proveedor).filter(Boolean))].sort();
    let etqBusq = '', etqFiltCat = '', etqFiltProv = '', etqFiltSinCodigo = false;

    tc.innerHTML = `
      <div class="table-card" style="padding:14px 16px;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <span class="material-icons" style="color:var(--tint-blue-fg)">qr_code_2</span>
          <h3 style="margin:0;flex:1;min-width:200px">Etiquetas para imprimir</h3>
          <span id="etqContador" style="font-size:13px;color:var(--text-muted);background:var(--bg);padding:6px 12px;border-radius:8px;font-weight:600">0 seleccionados</span>
        </div>
        <p style="margin:0;font-size:13px;color:var(--text-muted)">Marcá los productos, ajustá el layout y generá una hoja A4 lista para imprimir y recortar.</p>
      </div>

      <!-- FILTROS + OPCIONES -->
      <div class="table-card" style="padding:12px 14px;margin-bottom:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:end">
        <div style="flex:1;min-width:200px">
          <label style="font-size:11px;font-weight:700;color:var(--text-muted);display:block;margin-bottom:4px">Buscar por nombre / código</label>
          <input id="etqBusq" type="search" placeholder="Buscar..." style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit"/>
        </div>
        <div style="min-width:160px">
          <label style="font-size:11px;font-weight:700;color:var(--text-muted);display:block;margin-bottom:4px">Categoría</label>
          <select id="etqFiltCat" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--surface)">
            <option value="">Todas</option>${cats.map(c => `<option value="${escapeHtmlAttr(c)}">${escapeHtmlAttr(c)}</option>`).join('')}
          </select>
        </div>
        <div style="min-width:160px">
          <label style="font-size:11px;font-weight:700;color:var(--text-muted);display:block;margin-bottom:4px">Proveedor</label>
          <select id="etqFiltProv" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--surface)">
            <option value="">Todos</option>${provs.map(p => `<option value="${escapeHtmlAttr(p)}">${escapeHtmlAttr(p)}</option>`).join('')}
          </select>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);font-weight:600;cursor:pointer">
          <input id="etqSoloSinCodigo" type="checkbox"/> Solo sin código
        </label>
      </div>

      <!-- LAYOUT -->
      <div class="table-card" style="padding:12px 14px;margin-bottom:12px;display:flex;gap:14px;flex-wrap:wrap;align-items:end">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);flex:0 0 100%;margin-bottom:-4px;display:flex;align-items:center;gap:6px">
          <span class="material-icons" style="font-size:16px">tune</span> Layout de la hoja A4
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--text-muted);display:block;margin-bottom:4px">Columnas</label>
          <input id="etqCols" type="number" min="1" max="8" value="${etqOpts.cols}" style="width:80px;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit"/>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--text-muted);display:block;margin-bottom:4px">Filas</label>
          <input id="etqRows" type="number" min="1" max="20" value="${etqOpts.rows}" style="width:80px;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit"/>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--text-muted);display:block;margin-bottom:4px">Copias x prod.</label>
          <input id="etqCopias" type="number" min="1" max="50" value="${etqOpts.copias}" style="width:90px;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit"/>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);font-weight:600;cursor:pointer">
          <input id="etqMostrarPrecio" type="checkbox" ${etqOpts.mostrarPrecio?'checked':''}/> Mostrar precio
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);font-weight:600;cursor:pointer">
          <input id="etqMostrarCodigo" type="checkbox" ${etqOpts.mostrarCodigo?'checked':''}/> Mostrar código
        </label>
        <span style="margin-left:auto;font-size:12px;color:var(--text-muted)" id="etqLayoutInfo"></span>
      </div>

      <!-- TABLA DE PRODUCTOS -->
      <div class="table-card">
        <div style="padding:10px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border);flex-wrap:wrap">
          <button id="etqSelTodos" class="btn-sec" style="padding:6px 12px;border-radius:6px;border:1px solid var(--border);background:var(--surface);cursor:pointer;font-size:12px;font-weight:600">Marcar todos los visibles</button>
          <button id="etqDesmTodos" class="btn-sec" style="padding:6px 12px;border-radius:6px;border:1px solid var(--border);background:var(--surface);cursor:pointer;font-size:12px;font-weight:600">Desmarcar todo</button>
          <span id="etqVisibles" style="margin-left:auto;font-size:12px;color:var(--text-muted)"></span>
        </div>
        <div class="table-wrap" style="max-height:540px;overflow:auto">
          <table style="min-width:680px">
            <thead style="position:sticky;top:0;background:var(--surface);z-index:1"><tr>
              <th style="width:42px;text-align:center"><input type="checkbox" id="etqSelHeader" title="Marcar/desmarcar visibles"/></th>
              <th>Producto</th>
              <th style="width:140px">Categoría</th>
              <th style="width:130px">Código</th>
              <th style="width:90px;text-align:right">Precio</th>
            </tr></thead>
            <tbody id="etqTbody"></tbody>
          </table>
        </div>
      </div>

      <!-- BARRA FIJA DE GENERACIÓN -->
      <div id="etqBarra" style="position:sticky;bottom:0;margin-top:14px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;box-shadow:0 -4px 16px rgba(0,0,0,0.06);display:flex;gap:10px;align-items:center;flex-wrap:wrap;z-index:5">
        <span style="font-size:13px;color:var(--text-muted)">Total etiquetas: <b id="etqTotalEt" style="color:var(--text)">0</b></span>
        <span style="font-size:13px;color:var(--text-muted)">Hojas A4: <b id="etqTotalHojas" style="color:var(--text)">0</b></span>
        <button id="etqVistaPrev" style="margin-left:auto;padding:9px 16px;border-radius:8px;border:1.5px solid var(--border);background:var(--surface);cursor:pointer;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px">
          <span class="material-icons" style="font-size:16px">visibility</span> Vista previa
        </button>
        <button id="etqGenerar" style="padding:10px 18px;border-radius:8px;border:none;background:#1877f2;color:#fff;cursor:pointer;font-size:13px;font-weight:700;display:flex;align-items:center;gap:6px">
          <span class="material-icons" style="font-size:16px">print</span> Generar e imprimir
        </button>
      </div>
    `;

    // ── Helpers ──
    const norm = s => (s||'').toString().normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
    const tieneCodigo = p => !!(p.codigo_barra || p.codigo);
    const codigoDe    = p => (p.codigo_barra || p.codigo || '').toString().trim();

    function listaFiltrada() {
      const q = norm(etqBusq);
      return base.filter(p => {
        if (etqFiltCat && p.categoria !== etqFiltCat) return false;
        if (etqFiltProv && p.proveedor !== etqFiltProv) return false;
        if (etqFiltSinCodigo && tieneCodigo(p)) return false;
        if (q) {
          const hay = norm(p.nombre) + ' ' + norm(p.codigo || '') + ' ' + norm(p.codigo_barra || '');
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    }

    function actualizarContadores() {
      const cont = tc.querySelector('#etqContador');
      if (cont) cont.textContent = `${etqSel.size} seleccionado${etqSel.size===1?'':'s'}`;
      const totalEt = etqSel.size * (etqOpts.copias || 1);
      const porHoja = (etqOpts.cols || 1) * (etqOpts.rows || 1);
      const hojas = porHoja > 0 ? Math.ceil(totalEt / porHoja) : 0;
      tc.querySelector('#etqTotalEt').textContent  = totalEt;
      tc.querySelector('#etqTotalHojas').textContent = hojas;
      tc.querySelector('#etqLayoutInfo').textContent = `${porHoja} etiquetas por hoja`;
    }

    function renderTbody() {
      const lista = listaFiltrada();
      const tbody = tc.querySelector('#etqTbody');
      tc.querySelector('#etqVisibles').textContent = `${lista.length} producto${lista.length===1?'':'s'} visible${lista.length===1?'':'s'}`;
      if (!lista.length) {
        tbody.innerHTML = `<tr><td colspan="5" style="padding:30px;text-align:center;color:var(--text-muted)">Sin productos que coincidan con el filtro.</td></tr>`;
        return;
      }
      tbody.innerHTML = lista.map(p => {
        const cod = codigoDe(p);
        const sin = !cod;
        const checked = etqSel.has(p.doc_id) ? 'checked' : '';
        return `
          <tr data-id="${p.doc_id}" style="${sin?'background:var(--tint-yellow-bg)':''}">
            <td style="text-align:center"><input type="checkbox" class="etq-row-chk" data-id="${p.doc_id}" ${checked} ${sin?'disabled title="Sin código de barras"':''}/></td>
            <td><b style="font-size:13px">${escapeHtmlAttr(p.nombre || '')}</b></td>
            <td style="font-size:12px;color:var(--text-muted)">${escapeHtmlAttr(p.categoria || '—')}</td>
            <td style="font-size:12px;font-family:monospace;color:${sin?'var(--tint-red-fg)':'var(--text)'}">${sin?'(sin código)':escapeHtmlAttr(cod)}</td>
            <td style="text-align:right;font-size:12px">${p.precio_venta ? '$'+Number(p.precio_venta).toLocaleString('es-AR',{minimumFractionDigits:0}) : '—'}</td>
          </tr>
        `;
      }).join('');
      tbody.querySelectorAll('.etq-row-chk').forEach(chk => {
        chk.addEventListener('change', () => {
          const id = chk.dataset.id;
          if (chk.checked) etqSel.add(id); else etqSel.delete(id);
          actualizarContadores();
          actualizarSelHeader();
        });
      });
      actualizarSelHeader();
    }

    function actualizarSelHeader() {
      const lista = listaFiltrada().filter(tieneCodigo);
      const header = tc.querySelector('#etqSelHeader');
      if (!header) return;
      const todos = lista.length > 0 && lista.every(p => etqSel.has(p.doc_id));
      const algunos = lista.some(p => etqSel.has(p.doc_id));
      header.checked = todos;
      header.indeterminate = !todos && algunos;
    }

    // ── Listeners ──
    tc.querySelector('#etqBusq').addEventListener('input', e => { etqBusq = e.target.value; renderTbody(); });
    tc.querySelector('#etqFiltCat').addEventListener('change', e => { etqFiltCat = e.target.value; renderTbody(); });
    tc.querySelector('#etqFiltProv').addEventListener('change', e => { etqFiltProv = e.target.value; renderTbody(); });
    tc.querySelector('#etqSoloSinCodigo').addEventListener('change', e => { etqFiltSinCodigo = e.target.checked; renderTbody(); });

    tc.querySelector('#etqSelTodos').addEventListener('click', () => {
      listaFiltrada().filter(tieneCodigo).forEach(p => etqSel.add(p.doc_id));
      renderTbody();
      actualizarContadores();
    });
    tc.querySelector('#etqDesmTodos').addEventListener('click', () => {
      etqSel.clear();
      renderTbody();
      actualizarContadores();
    });
    tc.querySelector('#etqSelHeader').addEventListener('change', e => {
      const lista = listaFiltrada().filter(tieneCodigo);
      if (e.target.checked) lista.forEach(p => etqSel.add(p.doc_id));
      else                  lista.forEach(p => etqSel.delete(p.doc_id));
      renderTbody();
      actualizarContadores();
    });

    const onOptChange = () => {
      etqOpts.cols    = Math.max(1, Math.min(8,  parseInt(tc.querySelector('#etqCols').value)    || 1));
      etqOpts.rows    = Math.max(1, Math.min(20, parseInt(tc.querySelector('#etqRows').value)    || 1));
      etqOpts.copias  = Math.max(1, Math.min(50, parseInt(tc.querySelector('#etqCopias').value)  || 1));
      etqOpts.mostrarPrecio = tc.querySelector('#etqMostrarPrecio').checked;
      etqOpts.mostrarCodigo = tc.querySelector('#etqMostrarCodigo').checked;
      persistirOpts();
      actualizarContadores();
    };
    ['etqCols','etqRows','etqCopias','etqMostrarPrecio','etqMostrarCodigo'].forEach(id => {
      tc.querySelector('#'+id).addEventListener('change', onOptChange);
      tc.querySelector('#'+id).addEventListener('input',  onOptChange);
    });

    tc.querySelector('#etqGenerar').addEventListener('click', () => generarEtiquetasPDF(false));
    tc.querySelector('#etqVistaPrev').addEventListener('click', () => generarEtiquetasPDF(true));

    renderTbody();
    actualizarContadores();
  }

  // Genera la hoja A4 imprimible en una ventana nueva.
  // soloVista=true: no dispara el diálogo de impresión, solo abre la ventana.
  async function generarEtiquetasPDF(soloVista) {
    if (etqSel.size === 0) { alertDialog({ title: 'Sin selección', message: 'Marcá al menos un producto.', type: 'warning' }); return; }

    try { await _ensureJsBarcode(); }
    catch (e) { alertDialog({ title: 'Error', message: 'No se pudo cargar el generador de códigos de barra: ' + _escHtml(e.message), type: 'error' }); return; }

    const seleccionados = allProductos.filter(p => etqSel.has(p.doc_id) && (p.codigo_barra || p.codigo));
    if (!seleccionados.length) { alertDialog({ title: 'Sin códigos', message: 'Ningún producto seleccionado tiene código de barras.', type: 'info' }); return; }

    // Expandir por copias, manteniendo el orden por nombre
    seleccionados.sort((a,b) => (a.nombre||'').localeCompare(b.nombre||'', 'es'));
    const items = [];
    for (const p of seleccionados) {
      for (let i = 0; i < (etqOpts.copias || 1); i++) items.push(p);
    }

    const cols = etqOpts.cols, rows = etqOpts.rows;
    const mostrarPrecio = etqOpts.mostrarPrecio, mostrarCodigo = etqOpts.mostrarCodigo;

    // Renderizar cada barcode a dataURL desde un canvas off-screen
    const cache = new Map(); // codigo → dataURL
    function barcodeDataURL(codigo) {
      if (cache.has(codigo)) return cache.get(codigo);
      const c = document.createElement('canvas');
      try {
        window.JsBarcode(c, String(codigo), {
          format: 'CODE128', width: 2, height: 50, fontSize: 14, margin: 0, displayValue: false,
        });
        const url = c.toDataURL('image/png');
        cache.set(codigo, url);
        return url;
      } catch (_) {
        return '';
      }
    }

    const cells = items.map(p => {
      const cod = (p.codigo_barra || p.codigo || '').toString().trim();
      const img = barcodeDataURL(cod);
      const nombre = (p.nombre || '').toString();
      const precio = p.precio_venta ? '$'+Number(p.precio_venta).toLocaleString('es-AR',{minimumFractionDigits:0}) : '';
      return `
        <div class="cell">
          <div class="cell-name">${escapeHtmlAttr(nombre)}</div>
          ${img ? `<img class="cell-bc" src="${img}" alt=""/>` : '<div class="cell-bc-fallback">sin código</div>'}
          ${mostrarCodigo ? `<div class="cell-code">${escapeHtmlAttr(cod)}</div>` : ''}
          ${mostrarPrecio && precio ? `<div class="cell-price">${precio}</div>` : ''}
        </div>
      `;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"/>
<title>Etiquetas — ${seleccionados.length} productos</title>
<style>
  @page { size: A4; margin: 8mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 0; background:var(--bg); color: var(--text-strong); }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    background: #1877f2; color: #fff; padding: 10px 16px;
    display: flex; align-items: center; gap: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  }
  .toolbar h1 { font-size: 14px; margin: 0; flex: 1; font-weight: 600; }
  .toolbar button {
    padding: 8px 14px; border: none; border-radius: 6px; cursor: pointer;
    font-size: 13px; font-weight: 600; background:var(--surface); color:var(--tint-blue-fg);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .toolbar button.sec { background: rgba(255,255,255,0.15); color: #fff; }
  .sheet {
    width: 210mm; min-height: 297mm; margin: 12px auto;
    background:var(--surface); padding: 8mm;
    display: grid;
    grid-template-columns: repeat(${cols}, 1fr);
    grid-auto-rows: minmax(0, calc((297mm - 16mm) / ${rows}));
    gap: 1mm;
    box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    page-break-after: always;
  }
  .cell {
    border: 1px dashed var(--border); padding: 2mm;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; overflow: hidden;
    page-break-inside: avoid;
  }
  .cell-name { font-size: 9pt; font-weight: 700; line-height: 1.15; max-height: 2.4em; overflow: hidden; margin-bottom: 1mm; word-break: break-word; }
  .cell-bc { max-width: 100%; max-height: 14mm; height: auto; }
  .cell-bc-fallback { font-size: 8pt; color:var(--tint-red-fg); font-style: italic; padding: 4mm 0; }
  .cell-code { font-family: 'Courier New', monospace; font-size: 8pt; margin-top: 0.5mm; letter-spacing: 1px; }
  .cell-price { font-size: 11pt; font-weight: 700; margin-top: 1mm; color: var(--text-strong); }
  @media print {
    body { background:var(--surface); }
    .toolbar { display: none; }
    .sheet { margin: 0; box-shadow: none; padding: 0; }
    .cell { border: 1px dashed #999; }
  }
</style></head>
<body>
  <div class="toolbar">
    <h1>${seleccionados.length} producto${seleccionados.length===1?'':'s'} · ${items.length} etiqueta${items.length===1?'':'s'} · ${cols}×${rows} por hoja</h1>
    <button class="sec" onclick="window.close()">Cerrar</button>
    <button onclick="window.print()">Imprimir / Guardar PDF</button>
  </div>
  <div class="grid-wrap">${wrapInSheets(cells, cols * rows)}</div>
</body></html>`;

    const w = window.open('', '_blank');
    if (!w) { alertDialog({ title: 'Popups bloqueados', message: 'El navegador bloqueó la ventana emergente. Permití pop-ups para esta página.', type: 'warning' }); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    if (!soloVista) {
      // Esperar a que las imágenes terminen de cargar antes de imprimir
      w.addEventListener('load', () => setTimeout(() => w.print(), 250));
    }
  }

  // Divide las celdas en hojas A4 (uno o varios <div class="sheet">) según cant. por hoja.
  function wrapInSheets(cellsHTML, porHoja) {
    // cellsHTML viene como un solo string de N divs ya formados, así que rearmamos en chunks
    const tmp = document.createElement('div');
    tmp.innerHTML = cellsHTML;
    const arr = Array.from(tmp.children);
    const out = [];
    for (let i = 0; i < arr.length; i += porHoja) {
      const chunk = arr.slice(i, i + porHoja).map(el => el.outerHTML).join('');
      out.push(`<section class="sheet">${chunk}</section>`);
    }
    return out.join('');
  }

  // Helper local para escapar atributos en HTML inline (la página usa escapeHtmlAttr de otros tabs;
  // si no existe globalmente, definimos uno seguro acá).
  function escapeHtmlAttr(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
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
            <span style="color:var(--text-muted);font-size:13px">${cats.length} categorías</span>
          </div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;gap:8px">
              <input id="cfg_nueva_cat" type="text" placeholder="Nueva categoría..." style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px" />
              <button id="cfg_add_cat" style="padding:8px 16px;background:#1877f2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">+ Agregar</button>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;max-height:200px;overflow-y:auto">
              ${cats.map(c => `<span style="padding:4px 12px;background:var(--bg);border-radius:20px;font-size:12px;font-weight:600;color:var(--text);border:1px solid var(--border)">${c}</span>`).join('')}
            </div>
          </div>
        </div>

        <!-- Proveedores -->
        <div class="table-card">
          <div class="table-card-header">
            <h3>Proveedores</h3>
            <span style="color:var(--text-muted);font-size:13px">${provs.length} proveedores</span>
          </div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;gap:8px">
              <input id="cfg_nuevo_prov" type="text" placeholder="Nuevo proveedor..." style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px" />
              <button id="cfg_add_prov" style="padding:8px 16px;background:#2e7d32;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">+ Agregar</button>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto">
              ${provs.map(p => `<div style="padding:6px 12px;background:var(--bg);border-radius:8px;font-size:13px;color:var(--text)">${p}</div>`).join('')}
            </div>
          </div>
        </div>

        <!-- Marcas -->
        <div class="table-card">
          <div class="table-card-header">
            <h3>Marcas</h3>
            <span style="color:var(--text-muted);font-size:13px">${marcas.length} marcas</span>
          </div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;gap:8px">
              <input id="cfg_nueva_marca" type="text" placeholder="Nueva marca..." style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px" />
              <button id="cfg_add_marca" style="padding:8px 16px;background:#7b1fa2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">+ Agregar</button>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;max-height:180px;overflow-y:auto">
              ${marcas.map(m => `<span style="padding:4px 12px;background:var(--tint-purple-bg);border-radius:20px;font-size:12px;font-weight:600;color:var(--tint-purple-fg);border:1px solid #ce93d8">${m}</span>`).join('')}
            </div>
          </div>
        </div>

        <!-- Rubros / Secciones -->
        <div class="table-card">
          <div class="table-card-header">
            <h3>Secciones del negocio</h3>
            <span style="color:var(--text-muted);font-size:13px">${RUBROS.length} secciones</span>
          </div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <p style="font-size:13px;color:var(--text-muted);margin:0">Para agregar secciones, usá el botón "+ Agregar sección" en la barra superior.</p>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${RUBROS.map(r => `<span style="padding:6px 16px;background:var(--tint-blue-bg);border-radius:20px;font-size:13px;font-weight:700;color:var(--tint-blue-fg);border:2px solid var(--border)">${r}</span>`).join('')}
            </div>
          </div>
        </div>

        <!-- Mantenimiento -->
        <div class="table-card">
          <div class="table-card-header"><h3>Mantenimiento</h3></div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:12px">
            <div style="display:flex;flex-direction:column;gap:6px">
              <div style="font-size:14px;font-weight:600">Limpiar códigos con espacios</div>
              <p style="font-size:12px;color:var(--text-muted);margin:0">
                Busca productos con código interno o código de barras que tengan espacios y los corrige en Firebase.
              </p>
              <div style="display:flex;gap:8px;align-items:center">
                <button id="cfg_scan_espacios" style="padding:8px 14px;background:#1877f2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px">Escanear</button>
                <button id="cfg_fix_espacios" disabled style="padding:8px 14px;background:#d97706;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px;opacity:0.5">Corregir todos</button>
                <span id="cfg_scan_info" style="font-size:12px;color:var(--text-muted)"></span>
              </div>
              <div id="cfg_scan_list"></div>
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
      document.getElementById('cfg_msg').innerHTML = `<div style="padding:10px;background:var(--tint-green-bg);border-radius:8px;color:var(--tint-green-fg);font-size:13px">Categoría "<b>${normalized}</b>" lista para usar al crear productos.</div>`;
      document.getElementById('cfg_nueva_cat').value = '';
    });

    // Agregar proveedor
    document.getElementById('cfg_add_prov').addEventListener('click', () => {
      const val = document.getElementById('cfg_nuevo_prov').value.trim();
      if (!val) return;
      document.getElementById('cfg_msg').innerHTML = `<div style="padding:10px;background:var(--tint-green-bg);border-radius:8px;color:var(--tint-green-fg);font-size:13px">Proveedor "<b>${val}</b>" listo para usar al crear productos.</div>`;
      document.getElementById('cfg_nuevo_prov').value = '';
    });

    // Agregar marca
    document.getElementById('cfg_add_marca').addEventListener('click', () => {
      const val = document.getElementById('cfg_nueva_marca').value.trim().toUpperCase();
      if (!val) return;
      document.getElementById('cfg_msg').innerHTML = `<div style="padding:10px;background:var(--tint-green-bg);border-radius:8px;color:var(--tint-green-fg);font-size:13px">Marca "<b>${val}</b>" lista para usar al crear productos.</div>`;
      document.getElementById('cfg_nueva_marca').value = '';
    });

    // ── Mantenimiento: limpiar códigos con espacios ──
    let _conEspacios = [];
    document.getElementById('cfg_scan_espacios')?.addEventListener('click', () => {
      _conEspacios = allProductos.filter(p => {
        const cod = (p.codigo || '').toString();
        const bar = (p.cod_barra || '').toString();
        return /\s/.test(cod) || /\s/.test(bar);
      });
      const info   = document.getElementById('cfg_scan_info');
      const listEl = document.getElementById('cfg_scan_list');
      const btnFix = document.getElementById('cfg_fix_espacios');
      info.textContent = `${_conEspacios.length} productos con espacios`;
      if (!_conEspacios.length) {
        listEl.innerHTML = `<div style="padding:10px;background:var(--tint-green-bg);border-radius:8px;color:var(--tint-green-fg);font-size:12px;margin-top:8px">No hay productos con espacios en los códigos.</div>`;
        btnFix.disabled = true; btnFix.style.opacity = '0.5';
        return;
      }
      btnFix.disabled = false; btnFix.style.opacity = '1';
      const rows = _conEspacios.slice(0, 50).map(p => {
        const cod = (p.codigo || '').toString();
        const bar = (p.cod_barra || '').toString();
        return `<tr>
          <td style="padding:4px 8px;font-size:12px">${p.nombre}</td>
          <td style="padding:4px 8px;font-size:12px;font-family:monospace">${cod.replace(/ /g, '·')}</td>
          <td style="padding:4px 8px;font-size:12px;font-family:monospace">${bar.replace(/ /g, '·')}</td>
        </tr>`;
      }).join('');
      listEl.innerHTML = `
        <div style="max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:6px;margin-top:8px">
          <table style="width:100%;border-collapse:collapse">
            <thead style="position:sticky;top:0;background:var(--surface);z-index:1">
              <tr><th style="padding:6px 8px;text-align:left;font-size:11px">Nombre</th><th style="padding:6px 8px;text-align:left;font-size:11px">Código</th><th style="padding:6px 8px;text-align:left;font-size:11px">Cód. barra</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${_conEspacios.length > 50 ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Mostrando primeros 50 de ${_conEspacios.length}</div>` : ''}
      `;
    });

        document.getElementById('cfg_fix_espacios')?.addEventListener('click', async () => {
      if (!_conEspacios.length) return;
      if (!await confirmModal({ title: 'Corregir códigos', message: `¿Corregir <b>${_conEspacios.length}</b> producto(s)?<br><span style="color:var(--text-muted)">Se eliminarán los espacios de los códigos.</span>`, confirmText: 'Corregir' })) return;
      const btn  = document.getElementById('cfg_fix_espacios');
      const info = document.getElementById('cfg_scan_info');
      btn.disabled = true; btn.textContent = 'Corrigiendo...';
      let fixed = 0;
      const _changes = [];
      for (const p of _conEspacios) {
        if (!p.doc_id) continue;
        const newCod = limpiarCodigo(p.codigo);
        const newBar = limpiarCodigo(p.cod_barra);
        const update = { ultima_actualizacion: serverTimestamp() };
        const _before = {}, _after = {};
        if (newCod !== (p.codigo || '')) { update.codigo = newCod; _before.codigo = (p.codigo ?? null); _after.codigo = newCod; }
        if (newBar !== (p.cod_barra || '')) { update.cod_barra = newBar; _before.cod_barra = (p.cod_barra ?? null); _after.cod_barra = newBar; }
        try {
          await updateDoc(doc(db, 'catalogo', p.doc_id), update);
          p.codigo = newCod;
          p.cod_barra = newBar;
          fixed++;
          if (Object.keys(_after).length) _changes.push({ docId: p.doc_id, invId: p.id || p.doc_id, syncInv: false, before: _before, after: _after });
        } catch(e) { console.error('fix código', p.doc_id, e); }
      }
      _touchCatalogoMeta(db).catch(() => {});
      if (_changes.length) hist.recordBatch(_changes, { label: `Limpiar códigos · ${_changes.length} producto(s)` });
      invalidateCache('catalogo:all');
      info.textContent = `${fixed} productos corregidos`;
      btn.textContent = '✓ Hecho';
      document.getElementById('cfg_scan_list').innerHTML = `<div style="padding:10px;background:var(--tint-green-bg);border-radius:8px;color:var(--tint-green-fg);font-size:12px;margin-top:8px">${fixed} productos actualizados en Firebase.</div>`;
    });
  }

  // ── Init ──
  // La lista de rubros NO bloquea el pintado. Es un getDoc de UN documento,
  // pero en el arranque en frío queda encolado detrás de los listeners grandes
  // del store (catalogo 10k docs + ventas_por_dia 22k): medido, la página
  // tardaba ~58s en aparecer y mientras tanto se veía vacía.
  // Pintamos ya con los rubros por defecto y, cuando llega la lista real, se
  // repinta sólo la barra (reRenderRubroBar borra y rehace sus botones, así
  // que es idempotente).
  renderShell();
  reRenderRubroBar();
  const _tRubros = performance.now();
  cargarRubros()
    .then(() => {
      console.log(`[page] catalogo: rubros listos en ${(performance.now() - _tRubros).toFixed(0)}ms`);
      if (document.body.contains(container)) reRenderRubroBar();
    })
    .catch(() => {});
  document.getElementById('btnHistorial')?.addEventListener('click', () => hist.openPanel());
  hist.attachKeyboard();
  _actualizarBadgeHistorial();
  try {
    await cargarDatos();
    renderStats();
    renderTab('catalogo');
    // Banner de alertas: velocity en background → al completar, dibuja banner
    cargarVelocidadVentas().then(() => renderBannerCriticos()).catch(() => {});

    // Deep-link desde Notificaciones / Centro de Compras: si nos pidieron abrir
    // un producto al entrar al catálogo, lo abrimos en el editor completo.
    if (window.__pendingCatalogoOpen) {
      const targetId = window.__pendingCatalogoOpen;
      window.__pendingCatalogoOpen = null;
      const prod = allProductos.find(p => p.doc_id === targetId);
      if (prod) {
        // Dejar el producto también filtrado en la lista de fondo, así al cerrar
        // el editor queda a la vista.
        const buscarInp = document.getElementById('buscar');
        if (buscarInp && prod.nombre) {
          buscarInp.value = prod.nombre;
          aplicarFiltros();
        }
        setTimeout(() => { try { abrirEditorCompleto(prod); } catch (e) { console.warn('Deep-link a editor falló:', e); } }, 50);
      }
    }
    // Si venimos de otra página, botón flotante para pegar la vuelta.
    // Vive dentro del container (navegar a otra página lo elimina solo) pero
    // pinta POR ENCIMA del editor de producto (z-index en CSS > modales).
    const VUELTAS = {
      centro_compras:  'Centro de Compras',
      tienda_catalogo: 'Catálogo de la Tienda',
    };
    if (VUELTAS[window.__catalogoVolverA]) {
      const destino = window.__catalogoVolverA;
      window.__catalogoVolverA = null;
      const volver = document.createElement('button');
      volver.type = 'button';
      volver.className = 'cat-volver-cc';
      volver.innerHTML = `<span class="material-icons">arrow_back</span> Volver a ${VUELTAS[destino]}`;
      volver.addEventListener('click', () => {
        // Los modales del catálogo viven como hijos directos del body: cerrarlos
        // antes de irse para que no queden tapando la otra página.
        document.querySelectorAll('body > div').forEach(el => {
          if (el.classList.contains('modal-overlay') ||
              (el.style && el.style.position === 'fixed' && el.style.inset === '0px')) el.remove();
        });
        volver.remove();
        if (typeof window.navigateToPage === 'function') window.navigateToPage(destino);
      });
      container.appendChild(volver);
    }
  } catch(e) {
    const tc = document.getElementById('tabContent');
    if (tc) tc.innerHTML = `<div style="padding:20px;color:var(--danger)">Error: Error cargando catálogo: ${e.message}<br><br><i>Si el catálogo está vacío, usá la pestaña "Importar CSV" para cargar los productos.</i></div>`;
    renderStats();
    renderTab('catalogo');
  }

  // ── Listener real-time: cuando el POS o cualquier otra PC actualiza el
  // catálogo (ej. venta de producto conjunto descuenta stock), Firestore
  // toca config/catalogo_meta. Refrescamos la vista sin que el usuario
  // tenga que apretar F5 — pero NO si está editando un producto, llenando
  // un input o tiene un modal abierto, para no perder lo que estaba haciendo.
  let _lastMetaTs = null;
  let _refrescoPendiente = false;

  function usuarioInteractuando() {
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return true;
    if (ae?.isContentEditable) return true;
    // Cualquier overlay/modal abierto como hijo directo del body (los modales
    // de catálogo se appendan así, con position:fixed sobre todo).
    for (const c of document.body.children) {
      const id = c.id || '';
      if (id === 'app' || id === 'login' || id === 'sidebarOverlay' ||
          c.tagName === 'SCRIPT' || c.tagName === 'STYLE' || c.tagName === 'NOSCRIPT' ||
          c.tagName === 'LINK' || c.tagName === 'META') continue;
      // Sólo cuenta si está visible
      const cs = getComputedStyle(c);
      if (cs.display !== 'none' && cs.visibility !== 'hidden') return true;
    }
    return false;
  }

  async function refrescarSiCorresponde({ force = false } = {}) {
    const activeTab = document.querySelector('.tab-btn.active')?.dataset?.tab;
    if (activeTab !== 'catalogo' && activeTab !== 'inventario') return;
    if (!force && usuarioInteractuando()) {
      // Reintentar más tarde, cuando ya no esté ocupado
      _refrescoPendiente = true;
      return;
    }
    // Snapshot del estado de filtros + página antes de re-renderizar.
    // El renderTab vuelve a crear el HTML del tab, así que sin esto se
    // pierde el texto del buscador y los selects.
    const filtrosPrev = {
      buscar:       document.getElementById('buscar')?.value       ?? '',
      filtroCat:    document.getElementById('filtroCat')?.value    ?? '',
      filtroProv:   document.getElementById('filtroProv')?.value   ?? '',
      filtroMarca:  document.getElementById('filtroMarca')?.value  ?? '',
      filtroEstado: document.getElementById('filtroEstado')?.value ?? '',
    };
    const pageAnterior = currentPage;
    try {
      invalidateCache('catalogo:all');
      await cargarDatos({ silent: true });
      renderTab(activeTab);
      // Restaurar filtros + página después del re-render
      if (activeTab === 'catalogo') {
        for (const [id, v] of Object.entries(filtrosPrev)) {
          if (!v) continue;
          const el = document.getElementById(id);
          if (el) el.value = v;
        }
        currentPage = pageAnterior;
        aplicarFiltros();
      }
    } catch (err) {
      console.error('Refresco automático de catálogo falló:', err);
    }
  }

  // Reintentar el refresco cuando el usuario libere el foco / cierre el modal.
  document.addEventListener('focusout', () => {
    if (!_refrescoPendiente) return;
    setTimeout(() => {
      if (_refrescoPendiente && !usuarioInteractuando()) {
        _refrescoPendiente = false;
        refrescarSiCorresponde();
      }
    }, 250);
  });

  onSnapshot(doc(db, 'config', 'catalogo_meta'), async (snap) => {
    if (!snap.exists()) return;
    const ts = snap.data().last_updated;
    if (_lastMetaTs === null) { _lastMetaTs = ts; return; }
    if (ts === _lastMetaTs) return;
    _lastMetaTs = ts;
    // Si el cambio fue disparado por esta misma pestaña, ya tenemos el estado
    // actualizado en memoria. Saltamos el refresco para no pisar el filtro/scroll.
    if (Date.now() < _localMetaTouchUntil) return;
    refrescarSiCorresponde();
  }, (err) => console.warn('Listener catalogo_meta:', err));
}
