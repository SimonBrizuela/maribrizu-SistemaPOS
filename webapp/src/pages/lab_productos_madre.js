/**
 * LAB · Productos Madre con Variantes (Raíces)
 * ──────────────────────────────────────────────────────────────────────────────
 * Módulo AISLADO. NO toca el POS ni colecciones existentes.
 *
 * Colecciones Firestore (todas con prefijo mp_):
 *   mp_products         producto madre (raíz lógica del árbol)
 *   mp_nodes            nodos del árbol (raíces, sub-raíces, hojas)
 *   mp_presentations    presentaciones por hoja (unidad/pack/caja/...)
 *   mp_discounts        descuentos heredables (override puro: el más específico gana)
 *   mp_stock_movements  auditoría de stock
 *
 * Esta primera versión cubre los pasos 2-4 del plan:
 *   - CRUD de productos madre (mp_products)
 *   - Vista de árbol y CRUD de nodos (mp_nodes) con profundidad arbitraria
 *
 * Presentaciones, descuentos y motor de venta se agregan en pasos siguientes.
 */

import {
  collection, getDocs, getDoc, addDoc, setDoc, updateDoc, deleteDoc,
  doc, query, where, orderBy, writeBatch, serverTimestamp, onSnapshot,
} from 'firebase/firestore';
import { getCached, invalidateCacheByPrefix } from '../cache.js';
import { confirmDialog, alertDialog, promptDialog } from '../components/dialogs.js';

// ── Constantes ───────────────────────────────────────────────────────────────
const COL_PROD  = 'mp_products';
const COL_NODES = 'mp_nodes';
const COL_DISC  = 'mp_discounts';

const TIPOS_DESCUENTO = [
  { value: 'porcentaje',   label: '% Porcentaje',     hint: 'Aplica un porcentaje sobre el precio (ej: 10%)' },
  { value: 'monto_fijo',   label: '$ Monto fijo',     hint: 'Resta un monto fijo al precio (ej: $50)' },
  { value: 'por_cantidad', label: '% por cantidad',   hint: 'Aplica un % cuando la cantidad vendida supera el mínimo' },
  { value: 'por_fecha',    label: '% por fecha',      hint: 'Aplica un % solo dentro de un rango de fechas' },
];

const TIPOS_ATRIBUTO = [
  { value: 'color',   label: 'Color',     hint: 'Texto + hex opcional (#ff0000)',     icon: 'palette',          ejemplo: 'Rojo · Azul · Verde' },
  { value: 'medida',  label: 'Medida',    hint: 'Número + unidad (cm, m, mm)',        icon: 'straighten',       ejemplo: '12 mm · 50 cm' },
  { value: 'tamano',  label: 'Tamaño',    hint: 'Ancho × alto (ej: 50x70 cm)',        icon: 'aspect_ratio',     ejemplo: '50×70 cm' },
  { value: 'gramaje', label: 'Gramaje',   hint: 'Número con unidad (ej: 180 gr)',     icon: 'fitness_center',   ejemplo: '180 gr · 240 gr' },
  { value: 'material', label: 'Material', hint: 'Texto libre',                         icon: 'category',         ejemplo: 'Algodón · Plástico' },
  { value: 'marca',   label: 'Marca',     hint: 'Texto libre',                         icon: 'sell',             ejemplo: 'Bic · Faber-Castell' },
  { value: 'numero',  label: 'Número',    hint: 'Numérico genérico',                   icon: 'tag',              ejemplo: '5 · 12.5' },
  { value: 'texto',   label: 'Texto',     hint: 'Cualquier valor textual',             icon: 'text_fields',      ejemplo: 'libre' },
];

const UNIDADES_MEDIDA = ['cm', 'mm', 'm', 'pulg'];

const TIPOS_PRESENTACION = [
  { value: 'unidad', label: 'Unidad',  unidadBase: 'un' },
  { value: 'pack',   label: 'Pack',    unidadBase: 'un' },
  { value: 'caja',   label: 'Caja',    unidadBase: 'un' },
  { value: 'rollo',  label: 'Rollo',   unidadBase: 'm'  },
  { value: 'metro',  label: 'Metro suelto (corte)', unidadBase: 'm' },
  { value: 'cm',     label: 'Centímetro', unidadBase: 'cm' },
  { value: 'kg',     label: 'Kilo',    unidadBase: 'kg' },
  { value: 'gramo',  label: 'Gramo',   unidadBase: 'g'  },
  { value: 'custom', label: 'Custom',  unidadBase: ''   },
];

const STOCK_MODOS = [
  { value: 'independiente', label: 'Independiente (contador propio)' },
  { value: 'vinculado',     label: 'Vinculado (descuenta de otra)' },
];

// Margen extra al vender por unidad/metro fraccionado de un contenedor
// (ej: vender 1 m del rollo = precio_rollo / equivalencia × 1.15).
// Mismo valor que el POS (`pos_system/ui/conjunto_dialog.py:FRACCION_MARGIN`).
const FRACCION_MARGIN = 1.15;

// Estado en memoria (vida = sesión de página)
// Default rubros — mismo set que el catálogo regular para que el lab
// quede vinculado consistentemente. Se sobrescribe con `config/rubros`
// si el usuario ya editó la lista desde Catálogo.
const RUBROS_DEFAULT = [
  'LIBRERÍA','MERCERÍA','JUGUETERÍA','ARTÍSTICA','COTILLÓN','INFORMÁTICA','TELGOPOR',
  'ACCESORIOS','LENCERIA','NAVIDAD','PAPELERA','PERFUMERIA','REGALERIA','SELLOS','SERVICIOS',
];

let _state = {
  productos: [],            // mp_products cargados
  nodes:     [],            // mp_nodes del producto activo
  descuentos: [],           // mp_discounts del producto activo
  productoActivo: null,     // doc del producto madre actualmente abierto
  nodosColapsados: new Set(),
  rubros:    [...RUBROS_DEFAULT],  // se carga de config/rubros (compartido con Catálogo)
};

async function cargarRubros(db) {
  try {
    const snap = await getDoc(doc(db, 'config', 'rubros'));
    if (snap.exists() && Array.isArray(snap.data().lista) && snap.data().lista.length) {
      _state.rubros = snap.data().lista.slice();
    }
  } catch (e) { /* mantiene defaults */ }
}

// ── Utilidades ───────────────────────────────────────────────────────────────
function slugify(str) {
  return (str || '').toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function nuevoIdLocal() {
  // Generador estable de keys del DOM para listas dinámicas (no se persiste)
  return 'tmp_' + Math.random().toString(36).slice(2, 10);
}

/**
 * Genera un código EAN-8 válido para uso interno.
 * Estructura: [prefijo 2d][5 dígitos random][check digit] = 8 dígitos.
 * Más corto que EAN-13, sigue siendo escaneable por lectores estándar.
 */
function generarCodigoBarras(prefix = '20') {
  let n = prefix.padEnd(2, '0').slice(0, 2);
  while (n.length < 7) n += String(Math.floor(Math.random() * 10));
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const d = parseInt(n[i], 10);
    sum += (i % 2 === 0) ? d * 3 : d;
  }
  const check = (10 - (sum % 10)) % 10;
  return n + check;
}

// ── Render principal ─────────────────────────────────────────────────────────
export async function renderLabProductos(container, db) {
  container.innerHTML = `
    <div style="max-width:1100px;margin:0 auto;padding:8px">
      <div id="labRoot"></div>
    </div>

    <!-- Modal: Producto madre -->
    <div id="lpMadreModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto">
      <div style="background:white;border-radius:16px;padding:24px;width:100%;max-width:640px;box-shadow:0 20px 60px rgba(0,0,0,0.3);margin:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
          <h3 id="lpMadreTitulo" style="margin:0;font-size:18px;font-weight:700">Nuevo producto madre</h3>
          <button data-close="madre" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:28px;line-height:1;padding:0">&times;</button>
        </div>
        <form id="lpMadreForm" style="display:flex;flex-direction:column;gap:14px">
          <input type="hidden" id="lpMadreId" />
          ${campoLabel('Nombre *', '<input id="lpMadreNombre" type="text" placeholder="Ej: Cartulina Escolar" required style="' + estiloInput() + '" />')}
          <div>
            <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">Código de barras (auto)</label>
            <div style="display:flex;gap:6px">
              <input id="lpMadreCodigo" type="text" placeholder="Se genera automáticamente" style="${estiloInput()};flex:1" />
              <button type="button" id="lpMadreCodigoReGen" title="Regenerar código" style="background:#f8f9fa;border:1.5px solid var(--border);border-radius:8px;padding:0 14px;cursor:pointer;display:flex;align-items:center;gap:5px;font-size:13px;font-weight:600;font-family:inherit;color:#495057">
                <span class="material-icons" style="font-size:16px">refresh</span> Regenerar
              </button>
            </div>
            <p style="margin:5px 0 0;font-size:11px;color:var(--text-muted)">EAN-8 válido (8 dígitos, uso interno). Editable si querés ingresar uno escaneado.</p>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
            ${campoLabel('Rubro', '<select id="lpMadreRubro" style="' + estiloInput() + ';font-family:inherit;background:white"><option value="">— Sin rubro —</option></select>')}
            ${campoLabel('Categoría', '<input id="lpMadreCategoria" type="text" placeholder="Ej: Papelería" style="' + estiloInput() + '" />')}
            ${campoLabel('Marca',     '<input id="lpMadreMarca" type="text" placeholder="Ej: Muresco" style="' + estiloInput() + '" />')}
          </div>
          ${campoLabel('Descripción', '<textarea id="lpMadreDescripcion" rows="2" placeholder="Texto libre" style="' + estiloInput() + ';resize:vertical;font-family:inherit"></textarea>')}

          <!-- Atributos definidos -->
          <div>
            <label style="font-size:13px;font-weight:600;color:#495057;display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <span>Atributos definidos</span>
              <button type="button" id="lpMadreAddAttr" style="background:#f8f9fa;border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">+ Agregar atributo</button>
            </label>
            <p style="margin:0 0 8px;font-size:12px;color:var(--text-muted)">Definí qué variantes tendrán los nodos hijos (ej: color, tamaño, gramaje). Podés sobrescribirlos por nodo.</p>
            <div id="lpMadreAttrs" style="display:flex;flex-direction:column;gap:6px"></div>
          </div>

          <!-- Descuentos del producto madre -->
          <div style="background:#faf5ff;border:1px solid #ddd6fe;border-radius:8px;padding:12px">
            <label style="font-size:13px;font-weight:700;color:#5b21b6;display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <span>Descuentos del producto</span>
              <button type="button" id="lpMadreAddDisc" style="background:white;border:1px solid #ddd6fe;color:#5b21b6;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">+ Agregar descuento</button>
            </label>
            <p style="margin:0 0 8px;font-size:11px;color:var(--text-muted)">
              Aplican a todo el producto si ningún nodo o presentación tiene un descuento más específico. Override puro, no se acumulan.
            </p>
            <div id="lpMadreDescuentos" style="display:flex;flex-direction:column;gap:8px"></div>
          </div>

          <div id="lpMadreError" style="display:none;color:#dc3545;font-size:13px;padding:8px 12px;background:#fff0f0;border-radius:6px"></div>

          <div style="display:flex;gap:10px;margin-top:4px">
            <button type="button" data-close="madre" style="${estiloBtnSec()}">Cancelar</button>
            <button type="submit" id="lpMadreGuardar" style="${estiloBtnPri()}">Guardar producto</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Modal: Nodo (raíz / sub-raíz / hoja) -->
    <div id="lpNodoModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto">
      <div style="background:white;border-radius:16px;padding:24px;width:100%;max-width:640px;box-shadow:0 20px 60px rgba(0,0,0,0.3);margin:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <h3 id="lpNodoTitulo" style="margin:0;font-size:18px;font-weight:700">Nuevo nodo</h3>
          <button data-close="nodo" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:28px;line-height:1;padding:0">&times;</button>
        </div>
        <p id="lpNodoBreadcrumb" style="margin:0 0 8px;font-size:12px;color:var(--text-muted)"></p>
        <div id="lpNodoHerenciaHint" style="display:none;align-items:flex-start;gap:8px;background:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:9px 12px;margin-bottom:12px;font-size:12px;color:#5b21b6;line-height:1.4"></div>
        <form id="lpNodoForm" style="display:flex;flex-direction:column;gap:14px">
          <input type="hidden" id="lpNodoId" />
          <input type="hidden" id="lpNodoParentId" />
          ${campoLabel('Nombre *', '<input id="lpNodoNombre" type="text" placeholder="Ej: Cartulina Roja" required style="' + estiloInput() + '" />')}
          ${campoLabel('SKU sufijo', '<input id="lpNodoSku" type="text" placeholder="Ej: ROJ (opcional)" style="' + estiloInput() + '" />')}

          <!-- Atributos heredados/definidos por el madre + custom inline -->
          <div>
            <label style="font-size:13px;font-weight:600;color:#495057;display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <span>Atributos del nodo</span>
              <button type="button" id="lpNodoAddAttr" style="background:#f8f9fa;border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">+ Agregar atributo</button>
            </label>
            <div id="lpNodoAttrs" style="display:flex;flex-direction:column;gap:8px"></div>
          </div>

          <!-- Precio del nodo -->
          <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px">
            <label style="font-size:13px;font-weight:700;color:#0369a1;display:block;margin-bottom:8px">Precio del nodo</label>
            <p id="lpNodoPrecioHint" style="margin:0 0 8px;font-size:11px;color:var(--text-muted)"></p>
            <div style="display:grid;grid-template-columns:1fr 90px 1fr auto;gap:8px;align-items:end">
              <div>
                <label style="font-size:12px;font-weight:600;color:#495057;display:block;margin-bottom:3px">Costo</label>
                <input id="lpNodoPrecioCosto" type="number" step="0.01" min="0" placeholder="0.00" style="${estiloInput()};padding:8px 10px" />
              </div>
              <div>
                <label style="font-size:12px;font-weight:600;color:#7b3fa6;display:block;margin-bottom:3px">% Margen</label>
                <input id="lpNodoPrecioMargen" type="number" step="1" min="0" placeholder="80" style="${estiloInput()};padding:8px 10px;color:#7b3fa6;font-weight:700" />
              </div>
              <div>
                <label style="font-size:12px;font-weight:600;color:#495057;display:block;margin-bottom:3px">Venta <span id="lpNodoPrecioVentaReq" style="color:#dc3545;display:none">*</span></label>
                <input id="lpNodoPrecioVenta" type="number" step="0.01" min="0" placeholder="0.00" style="${estiloInput()};padding:8px 10px;font-weight:700;color:#0369a1" />
              </div>
              <button type="button" id="lpNodoPrecioRedondeo" title="Redondear venta al centenar más cercano" style="height:38px;background:white;border:1.5px solid #bae6fd;color:#0369a1;border-radius:8px;padding:0 12px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:700;display:flex;align-items:center;gap:4px;white-space:nowrap">
                <span class="material-icons" style="font-size:16px">north_east</span> 100
              </button>
            </div>
          </div>

          <!-- Presentaciones de stock -->
          <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:12px">
            <label style="font-size:13px;font-weight:700;color:#92400e;display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <span>Presentaciones de stock</span>
              <button type="button" id="lpNodoAddPres" style="background:white;border:1px solid #fde68a;color:#92400e;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">+ Agregar presentación</button>
            </label>
            <p style="margin:0 0 8px;font-size:11px;color:var(--text-muted)">
              Cada presentación lleva su propio stock y opcionalmente su propio precio. Si no agregás ninguna, el nodo se vende como "1 unidad simple" usando el precio del nodo.
            </p>
            <div id="lpNodoPresentaciones" style="display:flex;flex-direction:column;gap:8px"></div>
          </div>

          <!-- Descuentos del nodo -->
          <div style="background:#faf5ff;border:1px solid #ddd6fe;border-radius:8px;padding:12px">
            <label style="font-size:13px;font-weight:700;color:#5b21b6;display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <span>Descuentos del nodo</span>
              <button type="button" id="lpNodoAddDisc" style="background:white;border:1px solid #ddd6fe;color:#5b21b6;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">+ Agregar descuento</button>
            </label>
            <p style="margin:0 0 8px;font-size:11px;color:var(--text-muted)">
              Override puro: si hay descuento más específico (ej: en la presentación) gana ese; si no, sube por la rama hasta el madre. <strong>Primer match cierra</strong>, no se acumulan.
            </p>
            <div id="lpNodoDescuentos" style="display:flex;flex-direction:column;gap:8px"></div>
          </div>

          <!-- Herencia datos del padre -->
          <div style="background:#f8f9fa;border-radius:8px;padding:10px 12px">
            <label style="font-size:12px;font-weight:600;color:#495057;display:block;margin-bottom:6px">Herencia desde el padre</label>
            <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:13px">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="lpNodoHeredaCat" /> Categoría</label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="lpNodoHeredaMar" /> Marca</label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="lpNodoHeredaDesc" /> Descripción</label>
            </div>
            <div id="lpNodoOverrides" style="margin-top:10px;display:none;flex-direction:column;gap:8px"></div>
          </div>

          <div id="lpNodoError" style="display:none;color:#dc3545;font-size:13px;padding:8px 12px;background:#fff0f0;border-radius:6px"></div>

          <div style="display:flex;gap:10px;margin-top:4px">
            <button type="button" data-close="nodo" style="${estiloBtnSec()}">Cancelar</button>
            <button type="submit" id="lpNodoGuardar" style="${estiloBtnPri()}">Guardar nodo</button>
          </div>
        </form>
      </div>
    </div>
  `;

  setupGlobalEvents(db);
  // Carga rubros (config/rubros) en paralelo con la lista — sincroniza con
  // los rubros del Catálogo regular para que el select del modal los muestre.
  await Promise.all([cargarRubros(db), renderListaMadres(db)]);
}

// ── Estilos compartidos (helpers) ────────────────────────────────────────────
function estiloInput() {
  return 'width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;background:white';
}
function estiloBtnPri() {
  return 'flex:2;padding:12px;background:var(--primary);color:white;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit';
}
function estiloBtnSec() {
  return 'flex:1;padding:12px;border:1.5px solid var(--border);border-radius:8px;background:white;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit';
}
function campoLabel(label, html) {
  return `
    <div>
      <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">${label}</label>
      ${html}
    </div>`;
}

// ── Lista de productos madre ─────────────────────────────────────────────────
async function renderListaMadres(db) {
  _state.productoActivo = null;
  const root = document.getElementById('labRoot');
  if (!root) return;

  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
      <div>
        <h2 style="margin:0;font-size:20px;font-weight:700">Productos madre</h2>
        <p style="margin:4px 0 0;color:var(--text-muted);font-size:13px">
          Agrupan variantes en un árbol jerárquico (raíces → sub-raíces → hojas).
        </p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="lpBtnCargarSeed" title="Cargar productos de ejemplo de librería" style="
          background:white;color:#5b21b6;border:1.5px solid #ddd6fe;border-radius:8px;
          padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;
          display:flex;align-items:center;gap:5px;font-family:inherit
        ">
          <span class="material-icons" style="font-size:16px">science</span> Cargar ejemplos
        </button>
        <button id="lpBtnBorrarSeed" title="Borrar solo los productos marcados _seed" style="
          background:white;color:#dc3545;border:1.5px solid #fca5a5;border-radius:8px;
          padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;
          display:flex;align-items:center;gap:5px;font-family:inherit
        ">
          <span class="material-icons" style="font-size:16px">delete_sweep</span> Borrar ejemplos
        </button>
        <button id="lpBtnNuevoMadre" style="
          background:var(--primary);color:white;border:none;border-radius:8px;
          padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;
          display:flex;align-items:center;gap:6px;font-family:inherit
        ">
          <span class="material-icons" style="font-size:18px">add</span> Nuevo producto madre
        </button>
      </div>
    </div>

    <div style="margin-bottom:14px;position:relative">
      <span class="material-icons" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:20px">search</span>
      <input id="lpBuscarMadres" type="text" placeholder="Buscar por nombre, categoría o marca..."
        style="width:100%;box-sizing:border-box;padding:10px 12px 10px 40px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;background:var(--card-bg)" />
    </div>

    <div id="lpListaMadres" style="display:flex;flex-direction:column;gap:10px">
      <div style="text-align:center;padding:40px;color:var(--text-muted)">
        <span class="material-icons" style="font-size:40px;display:block;margin-bottom:8px">hourglass_empty</span>
        Cargando productos madre...
      </div>
    </div>
  `;

  try {
    _state.productos = await getCached('mp:productos', async () => {
      const snap = await getDocs(query(collection(db, COL_PROD), orderBy('nombre')));
      return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    }, { ttl: 60000, memOnly: true });
    pintarListaMadres(_state.productos);
  } catch (err) {
    document.getElementById('lpListaMadres').innerHTML =
      `<div style="color:#dc3545;padding:16px">Error: ${escapeHtml(err.message)}</div>`;
  }

  document.getElementById('lpBtnNuevoMadre').addEventListener('click', () => abrirModalMadre());
  document.getElementById('lpBtnCargarSeed').addEventListener('click', () => cargarSeed(db));
  document.getElementById('lpBtnBorrarSeed').addEventListener('click', () => borrarSeed(db));
  document.getElementById('lpBuscarMadres').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    if (!q) return pintarListaMadres(_state.productos);
    pintarListaMadres(_state.productos.filter(p =>
      (p.nombre || '').toLowerCase().includes(q) ||
      (p.rubro || '').toLowerCase().includes(q) ||
      (p.categoria || '').toLowerCase().includes(q) ||
      (p.marca || '').toLowerCase().includes(q)
    ));
  });

  document.getElementById('lpListaMadres').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const p = _state.productos.find(x => x._id === id);
    if (!p) return;
    if (btn.dataset.action === 'abrir')   return abrirArbol(db, p);
    if (btn.dataset.action === 'stock')   return abrirModalStock(db, p);
    if (btn.dataset.action === 'editar')  return abrirModalMadre(p);
    if (btn.dataset.action === 'borrar')  return borrarMadre(db, p);
  });
}

function pintarListaMadres(productos) {
  const cont = document.getElementById('lpListaMadres');
  if (!cont) return;
  if (!productos.length) {
    cont.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:var(--text-muted);background:white;border-radius:12px;border:2px dashed var(--border)">
        <span class="material-icons" style="font-size:48px;display:block;margin-bottom:12px;opacity:0.4">account_tree</span>
        <p style="margin:0;font-size:15px">Todavía no hay productos madre.</p>
        <p style="margin:6px 0 0;font-size:13px">Creá uno con "Nuevo producto madre" para empezar a armar el árbol.</p>
      </div>`;
    return;
  }

  cont.innerHTML = productos.map(p => {
    const attrs = (p.atributos_definidos || []).map(a =>
      `<span style="background:#f3e8ff;color:#5e2d80;padding:2px 9px;border-radius:10px;font-size:11px;font-weight:600">${escapeHtml(a.label || a.key)}</span>`
    ).join(' ');
    return `
      <div style="background:white;border-radius:12px;padding:14px 18px;box-shadow:0 1px 6px rgba(0,0,0,0.06);border:1px solid var(--border);display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div style="width:44px;height:44px;border-radius:10px;background:var(--primary);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <span class="material-icons" style="color:white;font-size:22px">account_tree</span>
        </div>
        <div style="flex:1;min-width:180px">
          <div style="font-size:15px;font-weight:700">${escapeHtml(p.nombre || '—')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            ${p.rubro ? `<span style="background:#eef4ff;color:#1877f2;border:1px solid #c7d9fc;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700;letter-spacing:.3px">${escapeHtml(p.rubro)}</span>` : ''}
            <span>${[p.categoria, p.marca].filter(Boolean).map(escapeHtml).join(' · ') || 'Sin categoría / marca'}</span>
          </div>
          ${attrs ? `<div style="margin-top:6px;display:flex;gap:5px;flex-wrap:wrap">${attrs}</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap">
          <button data-action="abrir" data-id="${p._id}" style="padding:7px 14px;background:var(--primary);color:white;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px">
            <span class="material-icons" style="font-size:16px">account_tree</span> Abrir árbol
          </button>
          <button data-action="stock" data-id="${p._id}" style="padding:7px 14px;background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px">
            <span class="material-icons" style="font-size:16px">inventory_2</span> Stock
          </button>
          <button data-action="editar" data-id="${p._id}" style="padding:7px 14px;background:#f8f9fa;border:1px solid var(--border);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Editar</button>
          <button data-action="borrar" data-id="${p._id}" style="padding:7px 14px;background:#fff0f0;border:1px solid #fca5a5;color:#dc3545;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Eliminar</button>
        </div>
      </div>`;
  }).join('');
}

// ── Modal: Producto madre ────────────────────────────────────────────────────
function abrirModalMadre(p = null) {
  document.getElementById('lpMadreTitulo').textContent = p ? 'Editar producto madre' : 'Nuevo producto madre';
  document.getElementById('lpMadreId').value          = p?._id || '';
  document.getElementById('lpMadreNombre').value      = p?.nombre || '';
  document.getElementById('lpMadreCodigo').value      = p?.codigo_barras || generarCodigoBarras();
  document.getElementById('lpMadreCategoria').value   = p?.categoria || '';
  document.getElementById('lpMadreMarca').value       = p?.marca || '';
  document.getElementById('lpMadreDescripcion').value = p?.descripcion || '';
  // Poblar el select de rubros con los cargados de config/rubros + el rubro
  // actual del producto (aunque haya sido eliminado de la lista) para no perderlo.
  const sel = document.getElementById('lpMadreRubro');
  const rubroActual = p?.rubro || '';
  const lista = _state.rubros.slice();
  if (rubroActual && !lista.includes(rubroActual)) lista.push(rubroActual);
  sel.innerHTML = '<option value="">— Sin rubro —</option>' +
    lista.map(r => `<option value="${escapeHtml(r)}" ${r === rubroActual ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('');
  document.getElementById('lpMadreError').style.display = 'none';

  // Resetear lista de atributos
  const cont = document.getElementById('lpMadreAttrs');
  cont.innerHTML = '';
  const attrs = p?.atributos_definidos || [];
  if (attrs.length === 0) attrs.push({ key: '', label: '', tipo: 'texto', unidad: '' });
  attrs.forEach(a => cont.appendChild(filaAtributoMadre(a)));

  // Descuentos del producto: filtrar del cache global y renderizar filas
  const discCont = document.getElementById('lpMadreDescuentos');
  discCont.innerHTML = '';
  if (p) {
    const propios = (_state.descuentos || []).filter(d => d.scope_type === 'product' && d.scope_id === p._id);
    propios.forEach(d => discCont.appendChild(filaDescuento(d)));
  }

  document.getElementById('lpMadreModal').style.display = 'flex';
  document.getElementById('lpMadreNombre').focus();
}

function cerrarModal(nombre) {
  const el = document.getElementById('lp' + (nombre === 'madre' ? 'Madre' : 'Nodo') + 'Modal');
  if (el) el.style.display = 'none';
}

function filaAtributoMadre(attr = {}) {
  const div = document.createElement('div');
  div.dataset.localId = nuevoIdLocal();
  div.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 130px 90px 32px;gap:6px;align-items:center';
  const opciones = TIPOS_ATRIBUTO.map(t =>
    `<option value="${t.value}" ${t.value === (attr.tipo || 'texto') ? 'selected' : ''}>${t.label}</option>`
  ).join('');
  div.innerHTML = `
    <input data-attr="key"   type="text" placeholder="key (ej: color)" value="${escapeHtml(attr.key || '')}"   style="${estiloInput()};padding:7px 9px" />
    <input data-attr="label" type="text" placeholder="Etiqueta visible" value="${escapeHtml(attr.label || '')}" style="${estiloInput()};padding:7px 9px" />
    <select data-attr="tipo" style="${estiloInput()};padding:7px 9px">${opciones}</select>
    <input data-attr="unidad" type="text" placeholder="unidad" value="${escapeHtml(attr.unidad || '')}" style="${estiloInput()};padding:7px 9px" />
    <button type="button" data-attr-remove style="background:#fff0f0;border:1px solid #fca5a5;color:#dc3545;border-radius:6px;padding:6px 0;cursor:pointer;font-size:14px">×</button>
  `;
  div.querySelector('[data-attr-remove]').addEventListener('click', () => div.remove());
  return div;
}

function leerAtributosMadre() {
  const filas = document.querySelectorAll('#lpMadreAttrs > div');
  const out = [];
  filas.forEach(f => {
    const key   = f.querySelector('[data-attr="key"]').value.trim();
    const label = f.querySelector('[data-attr="label"]').value.trim();
    const tipo  = f.querySelector('[data-attr="tipo"]').value;
    const unidad = f.querySelector('[data-attr="unidad"]').value.trim();
    if (!key) return; // ignorar filas vacías
    out.push({ key: slugify(key), label: label || key, tipo, unidad: unidad || '' });
  });
  return out;
}

async function guardarMadre(db) {
  const errEl  = document.getElementById('lpMadreError');
  const btn    = document.getElementById('lpMadreGuardar');
  errEl.style.display = 'none';

  const nombre = document.getElementById('lpMadreNombre').value.trim();
  if (!nombre) {
    errEl.textContent = 'El nombre es obligatorio.';
    errEl.style.display = 'block';
    return;
  }
  const atributos = leerAtributosMadre();
  // Validar keys únicas
  const keys = atributos.map(a => a.key);
  if (new Set(keys).size !== keys.length) {
    errEl.textContent = 'Hay atributos con la misma "key". Las keys deben ser únicas.';
    errEl.style.display = 'block';
    return;
  }

  const data = {
    nombre,
    slug:               slugify(nombre),
    codigo_barras:      document.getElementById('lpMadreCodigo').value.trim() || generarCodigoBarras(),
    rubro:              document.getElementById('lpMadreRubro').value.trim(),
    categoria:          document.getElementById('lpMadreCategoria').value.trim(),
    marca:              document.getElementById('lpMadreMarca').value.trim(),
    descripcion:        document.getElementById('lpMadreDescripcion').value.trim(),
    atributos_definidos: atributos,
    actualizado:        serverTimestamp(),
  };

  btn.disabled = true;
  btn.textContent = 'Guardando...';
  try {
    let productoId = document.getElementById('lpMadreId').value;
    if (productoId) {
      await updateDoc(doc(db, COL_PROD, productoId), data);
    } else {
      data.creado = serverTimestamp();
      const ref = await addDoc(collection(db, COL_PROD), data);
      await updateDoc(ref, { id: ref.id });
      productoId = ref.id;
    }

    // Sync descuentos del producto
    const discCont = document.getElementById('lpMadreDescuentos');
    const nuevos = leerDescuentos(discCont, 'product', productoId, productoId);
    const originales = (_state.descuentos || []).filter(d => d.scope_type === 'product' && d.scope_id === productoId);
    await sincronizarDescuentos(db, originales, nuevos);

    invalidateCacheByPrefix('mp:');
    cerrarModal('madre');
    await renderListaMadres(db);
  } catch (err) {
    errEl.textContent = 'Error al guardar: ' + err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar producto';
  }
}

async function borrarMadre(db, p) {
  // Cascade: borra todos los mp_nodes con product_id = p._id
  const nodesSnap = await getDocs(query(collection(db, COL_NODES), where('product_id', '==', p._id)));
  const totalNodos = nodesSnap.size;
  const msg = totalNodos > 0
    ? `¿Eliminar <strong>"${p.nombre}"</strong> y sus <strong>${totalNodos} nodo(s)</strong> del árbol?<br><br>Esta acción no se puede deshacer.`
    : `¿Eliminar <strong>"${p.nombre}"</strong>?`;
  const ok = await confirmDialog({
    title: 'Eliminar producto madre',
    message: msg,
    confirmText: 'Eliminar',
    cancelText: 'Cancelar',
    danger: true,
  });
  if (!ok) return;

  try {
    // Batches de 400 (límite de Firestore por batch = 500)
    const docs = nodesSnap.docs.slice();
    while (docs.length) {
      const chunk = docs.splice(0, 400);
      const batch = writeBatch(db);
      chunk.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    await deleteDoc(doc(db, COL_PROD, p._id));
    invalidateCacheByPrefix('mp:');
    await renderListaMadres(db);
  } catch (err) {
    await alertDialog({ title: 'Error al borrar', message: err.message, type: 'error' });
  }
}

// ── Vista de árbol ───────────────────────────────────────────────────────────
async function abrirArbol(db, producto) {
  _state.productoActivo = producto;
  const root = document.getElementById('labRoot');
  if (!root) return;

  root.innerHTML = `
    <div style="margin-bottom:14px">
      <button id="lpVolver" style="background:none;border:none;color:var(--primary);cursor:pointer;font-size:14px;font-weight:600;display:flex;align-items:center;gap:4px;padding:4px 0;font-family:inherit">
        <span class="material-icons" style="font-size:18px">arrow_back</span> Volver a productos
      </button>
    </div>

    <div style="background:white;border-radius:12px;padding:16px 20px;box-shadow:0 1px 6px rgba(0,0,0,0.06);border:1px solid var(--border);margin-bottom:14px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div style="width:44px;height:44px;border-radius:10px;background:var(--primary);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <span class="material-icons" style="color:white;font-size:22px">account_tree</span>
      </div>
      <div style="flex:1;min-width:180px">
        <div style="font-size:17px;font-weight:700">${escapeHtml(producto.nombre)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${producto.rubro ? `<span style="background:#eef4ff;color:#1877f2;border:1px solid #c7d9fc;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700;letter-spacing:.3px">${escapeHtml(producto.rubro)}</span>` : ''}
          <span>${[producto.categoria, producto.marca].filter(Boolean).map(escapeHtml).join(' · ') || 'Sin categoría / marca'}</span>
        </div>
      </div>
      <button id="lpBtnNuevaRaiz" style="background:var(--primary);color:white;border:none;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;font-family:inherit">
        <span class="material-icons" style="font-size:18px">add</span> Agregar raíz
      </button>
    </div>

    <div style="margin-bottom:10px;position:relative">
      <span class="material-icons" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:20px">search</span>
      <input id="lpBuscarNodos" type="text" placeholder="Buscar nodo por nombre o atributo..." style="width:100%;box-sizing:border-box;padding:10px 12px 10px 40px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;background:var(--card-bg)" />
    </div>

    <div id="lpArbol" style="background:white;border-radius:12px;border:1px solid var(--border);padding:8px 0;min-height:120px"></div>
  `;

  document.getElementById('lpVolver').addEventListener('click', () => renderListaMadres(db));
  document.getElementById('lpBtnNuevaRaiz').addEventListener('click', () => abrirModalNodo(null));
  document.getElementById('lpBuscarNodos').addEventListener('input', e => pintarArbol(e.target.value.toLowerCase().trim()));

  document.getElementById('lpArbol').addEventListener('click', async e => {
    const btn = e.target.closest('[data-naction]');
    if (!btn) return;
    const id = btn.dataset.id;
    const node = _state.nodes.find(n => n._id === id);
    if (btn.dataset.naction === 'toggle') {
      if (_state.nodosColapsados.has(id)) _state.nodosColapsados.delete(id);
      else _state.nodosColapsados.add(id);
      const filtroActual = (document.getElementById('lpBuscarNodos')?.value || '').toLowerCase().trim();
      pintarArbol(filtroActual);
      return;
    }
    if (!node) return;
    if (btn.dataset.naction === 'addChild') return abrirModalNodo(node);
    if (btn.dataset.naction === 'editar')   return abrirModalNodo(node, /*edit*/ true);
    if (btn.dataset.naction === 'borrar')   return borrarNodo(db, node);
  });

  await cargarNodos(db, producto._id);
}

async function cargarNodos(db, productId) {
  const cont = document.getElementById('lpArbol');
  cont.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)"><div class="spinner"></div><p style="margin-top:12px">Cargando árbol...</p></div>`;
  try {
    // Carga paralela: nodos + descuentos del producto
    const [nodes, descuentos] = await Promise.all([
      getCached(`mp:nodes:${productId}`, async () => {
        const snap = await getDocs(query(collection(db, COL_NODES), where('product_id', '==', productId)));
        return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
      }, { ttl: 60000, memOnly: true }),
      getCached(`mp:disc:${productId}`, () => cargarDescuentos(db, productId),
        { ttl: 60000, memOnly: true }),
    ]);
    _state.nodes = nodes;
    _state.descuentos = descuentos;
    pintarArbol();
  } catch (err) {
    cont.innerHTML = `<div style="color:#dc3545;padding:16px">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function pintarArbol(filtro = '') {
  const cont = document.getElementById('lpArbol');
  if (!cont) return;

  if (!_state.nodes.length) {
    cont.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:var(--text-muted)">
        <span class="material-icons" style="font-size:48px;display:block;margin-bottom:12px;opacity:0.4">park</span>
        <p style="margin:0;font-size:15px">El árbol está vacío.</p>
        <p style="margin:6px 0 0;font-size:13px">Usá "Agregar raíz" para crear la primera variante.</p>
      </div>`;
    return;
  }

  // Construir índice padre → hijos
  const porPadre = new Map();
  _state.nodes.forEach(n => {
    const k = n.parent_id || '__root__';
    if (!porPadre.has(k)) porPadre.set(k, []);
    porPadre.get(k).push(n);
  });
  porPadre.forEach(arr => arr.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '')));

  // Filtro: matchea por nombre o atributos. Si matchea, expone todos sus ancestros.
  let nodosVisibles = null;
  if (filtro) {
    const matches = _state.nodes.filter(n => {
      const hay = (s) => (s || '').toLowerCase().includes(filtro);
      if (hay(n.nombre) || hay(n.sku_sufijo)) return true;
      const a = n.atributos || {};
      return Object.values(a).some(v => hay(String(v)));
    });
    const visibles = new Set();
    matches.forEach(n => {
      visibles.add(n._id);
      (n.path || []).forEach(id => { if (id !== _state.productoActivo._id) visibles.add(id); });
    });
    nodosVisibles = visibles;
  }

  const html = renderNodosRecursivo(porPadre, '__root__', 0, nodosVisibles);
  cont.innerHTML = html || `<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:14px">Ningún nodo coincide con "${escapeHtml(filtro)}"</div>`;
}

function renderNodosRecursivo(porPadre, padreKey, depth, nodosVisibles) {
  const hijos = porPadre.get(padreKey) || [];
  if (!hijos.length) return '';
  return hijos.map(n => {
    if (nodosVisibles && !nodosVisibles.has(n._id)) return '';
    const tieneHijos = porPadre.has(n._id);
    const colapsado = _state.nodosColapsados.has(n._id);
    const subhtml = (tieneHijos && !colapsado) ? renderNodosRecursivo(porPadre, n._id, depth + 1, nodosVisibles) : '';

    const padding = 12 + depth * 22;
    const arrow = tieneHijos
      ? `<button data-naction="toggle" data-id="${n._id}" title="${colapsado ? 'Expandir' : 'Colapsar'}" style="background:none;border:none;cursor:pointer;padding:2px;color:var(--text-muted);display:flex;align-items:center"><span class="material-icons" style="font-size:18px">${colapsado ? 'chevron_right' : 'expand_more'}</span></button>`
      : `<span style="display:inline-block;width:22px"></span>`;

    const badgeHoja = !tieneHijos
      ? `<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:9px;font-size:10px;font-weight:700;letter-spacing:0.4px">HOJA</span>`
      : '';

    const attrs = renderResumenAtributos(n.atributos || {});

    // Precio + descuento efectivo (badges) — solo en hojas
    let precioBadge = '';
    if (n.precio && typeof n.precio.venta === 'number' && n.precio.venta > 0) {
      const desc = !tieneHijos ? descuentoEfectivo(_state.productoActivo, n, null, _state.nodes, _state.descuentos || [], 1) : null;
      const fmtMoney = v => `$${Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      if (desc) {
        const { precioFinal, etiqueta } = aplicarDescuento(n.precio.venta, desc, 1);
        precioBadge = `
          <span style="background:#dbeafe;color:#94a3b8;padding:2px 7px;border-radius:9px;font-size:11px;font-weight:600;text-decoration:line-through">${fmtMoney(n.precio.venta)}</span>
          <span style="background:#dcfce7;color:#166534;padding:2px 9px;border-radius:9px;font-size:11px;font-weight:700">${fmtMoney(precioFinal)}</span>
          <span title="${escapeHtml(desc.etiqueta || '')}" style="background:#faf5ff;color:#7c3aed;padding:2px 8px;border-radius:9px;font-size:10px;font-weight:700;letter-spacing:0.3px">${etiqueta}</span>`;
      } else {
        precioBadge = `<span style="background:#dbeafe;color:#1e40af;padding:2px 9px;border-radius:9px;font-size:11px;font-weight:700">${fmtMoney(n.precio.venta)}</span>`;
      }
    } else if (!tieneHijos) {
      precioBadge = `<span title="Falta precio en este nodo hoja" style="background:#fef2f2;color:#b91c1c;padding:2px 9px;border-radius:9px;font-size:11px;font-weight:600">sin precio</span>`;
    }

    const presList = Array.isArray(n.presentaciones) ? n.presentaciones : [];
    const presBadge = presList.length > 0
      ? `<span style="background:#fef3c7;color:#92400e;padding:2px 9px;border-radius:9px;font-size:11px;font-weight:600">${presList.length} present.</span>`
      : '';
    // Resumen de stock por presentación (incluyendo sueltos cuando aplica)
    const stockBadges = presList.map(p => {
      const tipoLbl = (TIPOS_PRESENTACION.find(t => t.value === p.tipo)?.label || p.tipo || '').toLowerCase();
      const principal = (typeof p.stock === 'number' && p.stock > 0)
        ? `${p.stock} ${tipoLbl}`
        : '';
      const sueltos = (typeof p.stock_sueltos === 'number' && p.stock_sueltos > 0)
        ? `${p.stock_sueltos}${p.unidad_medida || ''} sueltos`
        : '';
      const txt = [principal, sueltos].filter(Boolean).join(' + ');
      if (!txt) return '';
      return `<span style="background:#ecfdf5;color:#065f46;padding:2px 9px;border-radius:9px;font-size:11px;font-weight:500">${escapeHtml(txt)}</span>`;
    }).filter(Boolean).join(' ');

    return `
      <div style="border-bottom:1px solid #f0f1f3;padding:8px ${padding}px 8px ${padding}px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        ${arrow}
        <div style="flex:1;min-width:160px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <strong style="font-size:14px">${escapeHtml(n.nombre || '—')}</strong>
            ${n.sku_sufijo ? `<code style="background:#f3f4f6;padding:1px 6px;border-radius:4px;font-size:11px">${escapeHtml(n.sku_sufijo)}</code>` : ''}
            ${badgeHoja}
            ${precioBadge}
            ${presBadge}
          </div>
          ${attrs || stockBadges ? `<div style="margin-top:3px;display:flex;gap:5px;flex-wrap:wrap">${attrs}${stockBadges}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button data-naction="addChild" data-id="${n._id}" title="Agregar sub-raíz" style="background:#f8f9fa;border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:4px">
            <span class="material-icons" style="font-size:14px">add</span> Hijo
          </button>
          <button data-naction="editar" data-id="${n._id}" style="background:#f8f9fa;border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Editar</button>
          <button data-naction="borrar" data-id="${n._id}" style="background:#fff0f0;border:1px solid #fca5a5;color:#dc3545;border-radius:6px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Borrar</button>
        </div>
      </div>
      ${subhtml}
    `;
  }).join('');
}

function renderResumenAtributos(atributos) {
  const entries = Object.entries(atributos || {});
  if (!entries.length) return '';
  return entries.map(([k, v]) => {
    if (v === null || v === undefined || v === '') return '';

    // Detectar color por ESTRUCTURA (tiene .hex), no por nombre de key.
    // Así funciona aunque la key sea "rojo", "color_principal", etc.
    if (typeof v === 'object' && 'hex' in v) {
      const txt = (v.label || v.value || '').trim();
      if (!txt) return ''; // color sin valor → no mostrar nada
      return `<span style="display:inline-flex;align-items:center;gap:4px;background:#f8f9fa;padding:1px 8px;border-radius:9px;font-size:11px;border:1px solid var(--border)">
        <span style="width:11px;height:11px;border-radius:50%;background:${escapeHtml(v.hex || '#000')};border:1px solid #ccc"></span>
        ${escapeHtml(txt)}
      </span>`;
    }

    // Otros objetos: extraer label/value/ancho×alto. Si está vacío, no mostrar.
    let txt;
    if (typeof v === 'object') {
      txt = (v.label || v.value || '').toString().trim();
      if (!txt && (v.ancho || v.alto)) txt = `${v.ancho ?? ''}x${v.alto ?? ''}${v.unidad ? ' ' + v.unidad : ''}`;
      if (!txt) return ''; // objeto sin contenido legible → ocultar
    } else {
      txt = String(v);
    }
    return `<span style="background:#f3e8ff;color:#5e2d80;padding:1px 8px;border-radius:9px;font-size:11px;font-weight:500">${escapeHtml(k)}: ${escapeHtml(txt)}</span>`;
  }).filter(Boolean).join(' ');
}

// ── Modal: Nodo ──────────────────────────────────────────────────────────────
function abrirModalNodo(parentNode = null, edit = false) {
  const producto = _state.productoActivo;
  if (!producto) return;
  const esEdicion = edit && parentNode;        // si edit=true, parentNode es el nodo a editar
  const nodoEditando = esEdicion ? parentNode : null;
  const padreEfectivo = esEdicion
    ? (parentNode.parent_id ? _state.nodes.find(n => n._id === parentNode.parent_id) : null)
    : parentNode;

  document.getElementById('lpNodoTitulo').textContent = esEdicion ? 'Editar nodo' : (parentNode ? 'Agregar sub-raíz' : 'Agregar raíz');
  document.getElementById('lpNodoId').value       = nodoEditando?._id || '';
  document.getElementById('lpNodoParentId').value = padreEfectivo?._id || '';
  document.getElementById('lpNodoNombre').value   = nodoEditando?.nombre || '';
  document.getElementById('lpNodoSku').value      = nodoEditando?.sku_sufijo || '';
  document.getElementById('lpNodoError').style.display = 'none';

  // Breadcrumb del path
  const camino = [producto.nombre];
  if (padreEfectivo) {
    const pathIds = (padreEfectivo.path || []).slice(1); // sacar product_id inicial
    pathIds.forEach(id => {
      const x = _state.nodes.find(nn => nn._id === id);
      if (x) camino.push(x.nombre);
    });
  }
  if (esEdicion) camino.push(nodoEditando.nombre || '(este nodo)');
  document.getElementById('lpNodoBreadcrumb').textContent = '> ' + camino.filter(Boolean).join('  ›  ');

  // ¿Es un hijo nuevo? Si sí, heredamos defaults del padre (precio + atributos)
  // como punto de partida editable. El usuario los modifica si la variante difiere.
  const nuevoHijo = !esEdicion && padreEfectivo;

  // Mostrar un cartel sutil si estamos heredando del padre
  const hintEl = document.getElementById('lpNodoHerenciaHint');
  if (hintEl) {
    if (nuevoHijo) {
      hintEl.style.display = 'flex';
      hintEl.innerHTML = `
        <span class="material-icons" style="font-size:18px;color:#7b3fa6">subdirectory_arrow_right</span>
        <span>Hereda de <strong>${escapeHtml(padreEfectivo.nombre)}</strong>: precio y atributos cargados como punto de partida. Modificá lo que cambia en esta variante.</span>
      `;
    } else {
      hintEl.style.display = 'none';
    }
  }

  // Atributos: render filas según los definidos en el madre + custom inline.
  const cont = document.getElementById('lpNodoAttrs');
  cont.innerHTML = '';
  const definidos = producto.atributos_definidos || [];
  // Si es nuevo hijo, partimos de los atributos del padre; si edita, usa los propios
  const valoresActuales = nodoEditando?.atributos || (nuevoHijo ? (padreEfectivo.atributos || {}) : {});
  const keysDefinidos = new Set(definidos.map(d => d.key));

  // 1) Filas de atributos definidos por el madre (no removibles)
  definidos.forEach(def => cont.appendChild(filaAtributoNodo(def, valoresActuales[def.key])));

  // 2) Filas custom: cualquier key del nodo que no esté en los definidos del madre
  Object.entries(valoresActuales).forEach(([k, v]) => {
    if (!keysDefinidos.has(k)) cont.appendChild(filaAtributoCustomNodo(k, '', v));
  });

  if (!definidos.length && !cont.children.length) {
    const hint = document.createElement('p');
    hint.style.cssText = 'margin:0;font-size:12px;color:var(--text-muted);font-style:italic';
    hint.textContent = 'El producto madre no define atributos. Podés agregar atributos custom solo para este nodo con "+ Agregar atributo".';
    cont.appendChild(hint);
  }

  // Precio del nodo. Al crear hijo, hereda el precio del padre como default editable.
  const precio = nodoEditando?.precio || (nuevoHijo ? (padreEfectivo.precio || {}) : {});
  document.getElementById('lpNodoPrecioCosto').value = precio.costo ?? '';
  document.getElementById('lpNodoPrecioVenta').value = precio.venta ?? '';
  // Margen: si hay costo y venta cargados, lo derivamos; si no, lo dejamos vacío
  const _c = parseFloat(precio.costo);
  const _v = parseFloat(precio.venta);
  document.getElementById('lpNodoPrecioMargen').value =
    (_c > 0 && _v > 0) ? ((_v - _c) / _c * 100).toFixed(1) : '';
  // Indicador visual: en nodos hoja el precio venta es obligatorio
  const esHojaPotencial = nodoEditando ? (nodoEditando.es_hoja !== false) : true; // nodo nuevo siempre arranca hoja
  document.getElementById('lpNodoPrecioVentaReq').style.display = esHojaPotencial ? 'inline' : 'none';
  document.getElementById('lpNodoPrecioHint').textContent = esHojaPotencial
    ? 'Este nodo es una hoja vendible: el precio de venta es obligatorio.'
    : 'Nodo agrupador (tiene hijos). El precio queda como referencia, no se exige.';

  // Presentaciones embebidas
  const presCont = document.getElementById('lpNodoPresentaciones');
  presCont.innerHTML = '';
  const presentaciones = nodoEditando?.presentaciones || [];
  presentaciones.forEach(p => presCont.appendChild(filaPresentacion(p)));

  // Descuentos del nodo (si está editando un nodo existente)
  const discCont = document.getElementById('lpNodoDescuentos');
  discCont.innerHTML = '';
  if (nodoEditando) {
    const propios = (_state.descuentos || []).filter(d => d.scope_type === 'node' && d.scope_id === nodoEditando._id);
    propios.forEach(d => discCont.appendChild(filaDescuento(d)));
  }

  // Herencia
  const hereda = nodoEditando?.hereda_de_padre || { categoria: true, marca: true, descripcion: true };
  document.getElementById('lpNodoHeredaCat').checked  = hereda.categoria  !== false;
  document.getElementById('lpNodoHeredaMar').checked  = hereda.marca      !== false;
  document.getElementById('lpNodoHeredaDesc').checked = hereda.descripcion !== false;
  pintarOverrides(nodoEditando?.overrides || {});

  document.getElementById('lpNodoModal').style.display = 'flex';
  document.getElementById('lpNodoNombre').focus();
}

function filaAtributoNodo(def, valor) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
  wrap.dataset.attrKey  = def.key;
  wrap.dataset.attrTipo = def.tipo;

  const label = `<label style="min-width:100px;font-size:13px;font-weight:600;color:#495057">${escapeHtml(def.label || def.key)}</label>`;
  let input = '';

  if (def.tipo === 'color') {
    const labelV = valor?.label || valor?.value || (typeof valor === 'string' ? valor : '');
    const hexV   = valor?.hex || '#000000';
    input = `
      <input data-field="value" type="text" placeholder="ej: Rojo" value="${escapeHtml(labelV)}" style="${estiloInput()};flex:1;min-width:120px;padding:7px 10px" />
      <input data-field="hex"   type="color" value="${escapeHtml(hexV)}" style="width:42px;height:36px;border:1.5px solid var(--border);border-radius:8px;cursor:pointer;padding:2px;background:white" />
    `;
  } else if (def.tipo === 'medida' || def.tipo === 'gramaje' || def.tipo === 'numero') {
    const numV = (valor && typeof valor === 'object') ? valor.value : (valor ?? '');
    const unidadOpts = (def.tipo === 'medida'
      ? UNIDADES_MEDIDA
      : (def.unidad ? [def.unidad] : [])
    ).map(u => `<option ${u === (valor?.unidad || def.unidad || '') ? 'selected' : ''}>${u}</option>`).join('');
    input = `
      <input data-field="value" type="number" step="any" placeholder="0" value="${escapeHtml(String(numV))}" style="${estiloInput()};flex:1;min-width:90px;padding:7px 10px" />
      ${unidadOpts ? `<select data-field="unidad" style="${estiloInput()};width:90px;padding:7px 10px">${unidadOpts}</select>` : ''}
    `;
  } else if (def.tipo === 'tamano') {
    const ancho = valor?.ancho ?? '';
    const alto  = valor?.alto  ?? '';
    const unidad = valor?.unidad || 'cm';
    const unidadOpts = UNIDADES_MEDIDA.map(u => `<option ${u === unidad ? 'selected' : ''}>${u}</option>`).join('');
    input = `
      <input data-field="ancho" type="number" step="any" placeholder="ancho" value="${escapeHtml(String(ancho))}" style="${estiloInput()};width:80px;padding:7px 10px" />
      <span style="color:var(--text-muted);font-size:13px">×</span>
      <input data-field="alto"  type="number" step="any" placeholder="alto"  value="${escapeHtml(String(alto))}"  style="${estiloInput()};width:80px;padding:7px 10px" />
      <select data-field="unidad" style="${estiloInput()};width:80px;padding:7px 10px">${unidadOpts}</select>
    `;
  } else {
    const v = (valor && typeof valor === 'object') ? (valor.value || '') : (valor || '');
    input = `<input data-field="value" type="text" placeholder="${escapeHtml(def.hint || '')}" value="${escapeHtml(String(v))}" style="${estiloInput()};flex:1;min-width:150px;padding:7px 10px" />`;
  }

  // Botón × para quitar el atributo del producto madre. Cuando se confirma,
  // desaparece de TODAS las variantes (handler en setupGlobalEvents via delegación).
  const removeBtn = `<button type="button" data-attr-remove-from-madre="${escapeHtml(def.key)}" data-attr-label="${escapeHtml(def.label || def.key)}" title="Quitar este atributo del producto madre (afecta a todas las variantes)" style="background:#fff0f0;border:1px solid #fca5a5;color:#dc3545;border-radius:6px;width:30px;height:30px;cursor:pointer;font-size:14px;font-weight:bold;padding:0">×</button>`;

  wrap.innerHTML = label + input + removeBtn;
  return wrap;
}

/**
 * Abre/cierra un panel inline al final de lpNodoAttrs que permite elegir entre:
 *  - Agregar atributo solo en este nodo (custom texto)
 *  - Agregar atributo al producto madre (con tipo y unidad → todas las variantes lo heredan)
 */
function mostrarPanelAddAttr(db) {
  const cont = document.getElementById('lpNodoAttrs');
  if (!cont) return;
  // Si ya existe el panel, cerrarlo (toggle)
  const existing = cont.querySelector('[data-attr-panel]');
  if (existing) { existing.remove(); return; }

  // Quitar el placeholder "no define atributos" si está
  cont.querySelectorAll('p').forEach(p => p.remove());

  const inp = `${estiloInput()};padding:8px 11px;font-size:13px`;

  // Cards visuales de tipos: una grilla de 4 columnas con ícono + label + ejemplo
  const tipoCards = TIPOS_ATRIBUTO.map((t, i) => `
    <button type="button" data-tipo-card="${t.value}" title="${escapeHtml(t.hint)}" style="
      ${i === 0 ? 'border:2px solid #7c3aed;background:#ede9fe' : 'border:1.5px solid #e9d5ff;background:white'};
      border-radius:8px;padding:10px 6px;cursor:pointer;font-family:inherit;
      display:flex;flex-direction:column;align-items:center;gap:3px;
      transition:all 0.15s;min-height:78px
    ">
      <span class="material-icons" style="font-size:22px;color:#7c3aed">${t.icon}</span>
      <span style="font-size:12px;font-weight:700;color:#5b21b6">${escapeHtml(t.label)}</span>
      <span style="font-size:10px;color:var(--text-muted);text-align:center;line-height:1.2">${escapeHtml(t.ejemplo)}</span>
    </button>
  `).join('');

  const panel = document.createElement('div');
  panel.dataset.attrPanel = '1';
  panel.style.cssText = 'background:#faf5ff;border:1.5px dashed #c4b5fd;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:12px';
  panel.innerHTML = `
    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="material-icons" style="color:#7c3aed;font-size:20px">add_circle</span>
        <span style="font-size:14px;font-weight:800;color:#5b21b6">Nuevo atributo</span>
      </div>
      <button type="button" data-attr-cancel title="Cancelar" style="background:none;border:none;color:var(--text-muted);font-size:24px;line-height:1;padding:0;cursor:pointer">&times;</button>
    </div>

    <!-- Selector de alcance: tabs visuales grandes -->
    <div>
      <div style="font-size:11px;font-weight:700;color:#5b21b6;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:6px">¿Dónde lo agregás?</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <button type="button" data-attr-tab="madre" style="
          border:2px solid #7c3aed;background:#ede9fe;border-radius:10px;padding:12px;
          cursor:pointer;font-family:inherit;text-align:left;transition:all 0.15s
        ">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span class="material-icons" style="font-size:20px;color:#7c3aed">account_tree</span>
            <strong style="font-size:13px;color:#5b21b6">Al producto madre</strong>
            <span class="material-icons" data-attr-check style="margin-left:auto;color:#7c3aed;font-size:18px">check_circle</span>
          </div>
          <div style="font-size:11px;color:#78350f;line-height:1.35">
            Aparece en TODAS las variantes del producto. Lo más común si querés cargar color, tamaño, gramaje, etc.
          </div>
        </button>
        <button type="button" data-attr-tab="nodo" style="
          border:1.5px solid #e9d5ff;background:white;border-radius:10px;padding:12px;
          cursor:pointer;font-family:inherit;text-align:left;transition:all 0.15s
        ">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span class="material-icons" style="font-size:20px;color:#7c3aed">label</span>
            <strong style="font-size:13px;color:#5b21b6">Solo este nodo</strong>
            <span class="material-icons" data-attr-check style="margin-left:auto;color:#7c3aed;font-size:18px;visibility:hidden">check_circle</span>
          </div>
          <div style="font-size:11px;color:#78350f;line-height:1.35">
            Texto libre extra, solo para esta variante puntual (ej: "serie: invierno-2026").
          </div>
        </button>
      </div>
    </div>

    <!-- Modo MADRE -->
    <div data-attr-mode="madre" style="display:flex;flex-direction:column;gap:10px">
      <div>
        <div style="font-size:11px;font-weight:700;color:#5b21b6;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:6px">Tipo de atributo</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">${tipoCards}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 110px;gap:6px">
        <div>
          <div style="font-size:10px;font-weight:700;color:#5b21b6;letter-spacing:0.4px;text-transform:uppercase;margin-bottom:3px">Nombre del atributo *</div>
          <input data-fpa="mlabel" type="text" placeholder="Ej: Color" style="${inp}" />
          <div style="font-size:10px;color:var(--text-muted);margin-top:3px;font-style:italic">
            Es el <strong>nombre</strong> del atributo (ej: "Color"), no el valor (ej: "Rojo"). El valor se carga después en cada variante.
          </div>
        </div>
        <div>
          <div style="font-size:10px;font-weight:700;color:#5b21b6;letter-spacing:0.4px;text-transform:uppercase;margin-bottom:3px" title="Solo aplica a tipos numéricos (medida, gramaje, número)">Unidad</div>
          <input data-fpa="munidad" type="text" placeholder="opcional" style="${inp}" />
        </div>
      </div>
    </div>

    <!-- Modo NODO -->
    <div data-attr-mode="nodo" style="display:none;flex-direction:column;gap:6px">
      <div style="font-size:11px;color:#78350f">Texto libre, solo aplica a esta variante.</div>
      <div style="display:grid;grid-template-columns:130px 1fr;gap:6px">
        <input data-fpa="nkey"   type="text" placeholder="key (ej: serie)"           style="${inp}" />
        <input data-fpa="nvalor" type="text" placeholder="valor (ej: invierno-2026)" style="${inp}" />
      </div>
    </div>

    <!-- Acciones -->
    <div style="display:flex;gap:6px;justify-content:flex-end;border-top:1px dashed #c4b5fd;padding-top:10px">
      <button type="button" data-attr-cancel style="background:white;border:1.5px solid #c4b5fd;color:#5b21b6;border-radius:8px;padding:9px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Cancelar</button>
      <button type="button" data-attr-add    style="background:#7c3aed;border:none;color:white;border-radius:8px;padding:9px 22px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px">
        <span class="material-icons" style="font-size:16px">add</span> Agregar atributo
      </button>
    </div>
  `;
  cont.appendChild(panel);

  // Estado local del panel
  let alcance = 'madre';
  let tipoSeleccionado = TIPOS_ATRIBUTO[0].value;

  const refrescarTabs = () => {
    panel.querySelectorAll('[data-attr-tab]').forEach(tab => {
      const isSelected = tab.dataset.attrTab === alcance;
      tab.style.border     = isSelected ? '2px solid #7c3aed' : '1.5px solid #e9d5ff';
      tab.style.background = isSelected ? '#ede9fe' : 'white';
      tab.querySelector('[data-attr-check]').style.visibility = isSelected ? 'visible' : 'hidden';
    });
    panel.querySelector('[data-attr-mode="madre"]').style.display = alcance === 'madre' ? 'flex' : 'none';
    panel.querySelector('[data-attr-mode="nodo"]').style.display  = alcance === 'nodo'  ? 'flex' : 'none';
  };

  panel.querySelectorAll('[data-attr-tab]').forEach(tab => {
    tab.onclick = () => { alcance = tab.dataset.attrTab; refrescarTabs(); };
  });

  // Sugerencias de nombre del atributo según el tipo seleccionado
  const sugerenciasNombre = {
    color:   'Ej: Color',
    medida:  'Ej: Ancho, Largo, Espesor',
    tamano:  'Ej: Tamaño, Dimensiones',
    gramaje: 'Ej: Gramaje, Grosor',
    material: 'Ej: Material, Acabado',
    marca:   'Ej: Marca',
    numero:  'Ej: Número, Talla',
    texto:   'Ej: Estilo, Edición',
  };
  const sugerenciasUnidad = {
    color: '', medida: 'mm / cm / m', tamano: 'cm', gramaje: 'gr', material: '', marca: '', numero: '', texto: '',
  };

  // Selección de tipo
  panel.querySelectorAll('[data-tipo-card]').forEach(card => {
    card.onclick = () => {
      tipoSeleccionado = card.dataset.tipoCard;
      panel.querySelectorAll('[data-tipo-card]').forEach(c => {
        const sel = c.dataset.tipoCard === tipoSeleccionado;
        c.style.border     = sel ? '2px solid #7c3aed' : '1.5px solid #e9d5ff';
        c.style.background = sel ? '#ede9fe' : 'white';
      });
      // Actualizar placeholders al elegir tipo
      const lblInp = panel.querySelector('[data-fpa="mlabel"]');
      const uniInp = panel.querySelector('[data-fpa="munidad"]');
      if (lblInp) lblInp.placeholder = sugerenciasNombre[tipoSeleccionado] || 'Ej: Nombre del atributo';
      if (uniInp) uniInp.placeholder = sugerenciasUnidad[tipoSeleccionado] || 'opcional';
    };
  });

  // Cancelar
  panel.querySelectorAll('[data-attr-cancel]').forEach(b => b.onclick = () => panel.remove());

  // Agregar
  panel.querySelector('[data-attr-add]').onclick = async () => {
    if (alcance === 'nodo') {
      const k = panel.querySelector('[data-fpa="nkey"]').value.trim();
      const v = panel.querySelector('[data-fpa="nvalor"]').value.trim();
      if (!k) return alertDialog({ title: 'Falta la key', message: 'La key es obligatoria.', type: 'warning' });
      cont.appendChild(filaAtributoCustomNodo(k, '', v));
      panel.remove();
      return;
    }

    // alcance === 'madre' → persistir en producto.atributos_definidos
    const labelV  = panel.querySelector('[data-fpa="mlabel"]').value.trim();
    const unidad  = panel.querySelector('[data-fpa="munidad"]').value.trim();
    if (!labelV) return alertDialog({ title: 'Falta la etiqueta', message: 'Ingresá una etiqueta visible (ej: <em>Ancho</em>, <em>Color</em>).', type: 'warning' });

    const producto = _state.productoActivo;
    if (!producto) return alertDialog({ title: 'Sin producto', message: 'No hay producto activo.', type: 'warning' });
    const keySlug = slugify(labelV);
    if (!keySlug) return alertDialog({ title: 'Etiqueta inválida', message: 'La etiqueta tiene que tener al menos una letra o número.', type: 'warning' });
    const yaExiste = (producto.atributos_definidos || []).some(a => a.key === keySlug);
    if (yaExiste) return alertDialog({ title: 'Atributo duplicado', message: `Ya existe un atributo con la key <strong>"${keySlug}"</strong> en este producto.`, type: 'warning' });

    const nuevo = { key: keySlug, label: labelV, tipo: tipoSeleccionado, unidad };
    const nuevosDefs = [...(producto.atributos_definidos || []), nuevo];

    const btn = panel.querySelector('[data-attr-add]');
    btn.disabled = true;
    btn.innerHTML = '<span class="material-icons" style="font-size:16px;animation:spin 1s linear infinite">refresh</span> Guardando...';
    try {
      await updateDoc(doc(db, COL_PROD, producto._id), {
        atributos_definidos: nuevosDefs,
        actualizado: serverTimestamp(),
      });
      // Actualizar estado local
      producto.atributos_definidos = nuevosDefs;
      const idxList = _state.productos.findIndex(p => p._id === producto._id);
      if (idxList >= 0) _state.productos[idxList].atributos_definidos = nuevosDefs;
      invalidateCacheByPrefix('mp:');
      // Renderizar la nueva fila en el modal del nodo
      cont.appendChild(filaAtributoNodo(nuevo));
      panel.remove();
    } catch (err) {
      await alertDialog({ title: 'Error', message: 'Error guardando atributo en el producto: ' + err.message, type: 'error' });
      btn.disabled = false;
      btn.innerHTML = '<span class="material-icons" style="font-size:16px">add</span> Agregar atributo';
    }
  };
}

function filaAtributoCustomNodo(key = '', label = '', valor = '') {
  const wrap = document.createElement('div');
  wrap.dataset.attrSource = 'custom';
  wrap.dataset.attrTipo   = 'texto';
  wrap.style.cssText = 'display:grid;grid-template-columns:130px 1fr 32px;gap:6px;align-items:center';
  const valorTxt = (valor && typeof valor === 'object') ? (valor.value || valor.label || JSON.stringify(valor)) : (valor || '');
  wrap.innerHTML = `
    <input data-field="key"   type="text" placeholder="key (ej: marca)" value="${escapeHtml(key)}" style="${estiloInput()};padding:7px 9px" />
    <input data-field="value" type="text" placeholder="valor"            value="${escapeHtml(String(valorTxt))}" style="${estiloInput()};padding:7px 9px" />
    <button type="button" data-attr-remove style="background:#fff0f0;border:1px solid #fca5a5;color:#dc3545;border-radius:6px;padding:6px 0;cursor:pointer;font-size:14px">×</button>
  `;
  wrap.querySelector('[data-attr-remove]').addEventListener('click', () => wrap.remove());
  return wrap;
}

// ── Fila de descuento (UI) ───────────────────────────────────────────────────
function filaDescuento(d = {}) {
  const wrap = document.createElement('div');
  wrap.dataset.discRow = '1';
  wrap.dataset.discId  = d._id || '';        // vacío = descuento nuevo
  wrap.style.cssText = 'background:white;border:1px solid #ddd6fe;border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:7px';
  const tipoOpts = TIPOS_DESCUENTO.map(t =>
    `<option value="${t.value}" ${t.value === (d.tipo || 'porcentaje') ? 'selected' : ''}>${t.label}</option>`
  ).join('');
  const inp = `${estiloInput()};padding:6px 9px;font-size:13px`;
  const lblD = (txt, hint = '') => `
    <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;color:#5b21b6;text-transform:uppercase;margin-bottom:2px"${hint ? ` title="${escapeHtml(hint)}"` : ''}>
      ${escapeHtml(txt)}${hint ? ' <span style="opacity:0.5;text-transform:none">ⓘ</span>' : ''}
    </div>`;
  const tipoActual = d.tipo || 'porcentaje';
  const showCant   = tipoActual === 'por_cantidad';
  const showFechas = tipoActual === 'por_fecha';

  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:160px 1fr 90px 80px 30px;gap:6px;align-items:end">
      <div>
        ${lblD('Tipo', 'Cómo se aplica el descuento.')}
        <select data-df="tipo" style="${inp}">${tipoOpts}</select>
      </div>
      <div>
        ${lblD('Etiqueta', 'Descripción visible (ej: "Promo verano", "Pack ahorro 15%").')}
        <input data-df="etiqueta" type="text" placeholder="opcional" value="${escapeHtml(d.etiqueta || '')}" style="${inp}" />
      </div>
      <div>
        ${lblD('Valor', 'Monto o porcentaje según tipo.')}
        <input data-df="valor" type="number" step="any" min="0" placeholder="ej: 10" value="${d.valor ?? ''}" style="${inp};font-weight:700;color:#5b21b6" />
      </div>
      <div>
        ${lblD('Prioridad', 'Mayor prioridad gana si hay varios activos en el mismo scope.')}
        <input data-df="prioridad" type="number" step="1" placeholder="0" value="${d.prioridad ?? 0}" style="${inp}" />
      </div>
      <button type="button" data-df-remove title="Eliminar descuento" style="background:#fff0f0;border:1px solid #fca5a5;color:#dc3545;border-radius:6px;padding:0;cursor:pointer;font-size:16px;height:30px">×</button>
    </div>

    <div data-df-cant style="display:${showCant ? 'block' : 'none'}">
      ${lblD('Cantidad mín. para aplicar', 'El descuento se activa cuando la venta supera esta cantidad.')}
      <input data-df="cantidad_min" type="number" step="any" min="0" placeholder="ej: 5" value="${d.cantidad_min ?? ''}" style="${inp}" />
    </div>

    <div data-df-fechas style="display:${showFechas ? 'grid' : 'none'};grid-template-columns:1fr 1fr;gap:6px;align-items:end">
      <div>
        ${lblD('Desde', 'Fecha de inicio (inclusive). Vacío = sin límite.')}
        <input data-df="desde" type="date" value="${escapeHtml(d.desde || '')}" style="${inp}" />
      </div>
      <div>
        ${lblD('Hasta', 'Fecha de fin (inclusive). Vacío = sin límite.')}
        <input data-df="hasta" type="date" value="${escapeHtml(d.hasta || '')}" style="${inp}" />
      </div>
    </div>

    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#5b21b6;cursor:pointer;margin-top:2px">
      <input data-df="activo" type="checkbox" ${d.activo === false ? '' : 'checked'} /> Activo
    </label>
  `;

  // Mostrar/ocultar campos condicionales según el tipo
  wrap.querySelector('[data-df="tipo"]').onchange = (e) => {
    const t = e.target.value;
    wrap.querySelector('[data-df-cant]').style.display   = t === 'por_cantidad' ? 'block' : 'none';
    wrap.querySelector('[data-df-fechas]').style.display = t === 'por_fecha'    ? 'grid'  : 'none';
  };
  wrap.querySelector('[data-df-remove]').onclick = async (e) => {
    e.stopPropagation();
    const ok = await confirmDialog({
      title: 'Eliminar descuento',
      message: '¿Querés eliminar este descuento de la lista?',
      confirmText: 'Eliminar',
      danger: true,
    });
    if (ok) wrap.remove();
  };
  wrap.addEventListener('click', e => e.stopPropagation());
  return wrap;
}

function leerDescuentos(scopeContEl, scopeType, scopeId, productoId) {
  const out = [];
  scopeContEl.querySelectorAll('[data-disc-row]').forEach(row => {
    const get = sel => row.querySelector(`[data-df="${sel}"]`);
    const numOrNull = el => { const s = (el?.value || '').trim(); if (s === '') return null; const n = parseFloat(s); return isNaN(n) ? null : n; };
    const tipo = get('tipo')?.value || 'porcentaje';
    const valor = numOrNull(get('valor'));
    if (valor === null) return; // sin valor no se persiste
    const obj = {
      _id:        row.dataset.discId || null,
      product_id: productoId,
      scope_type: scopeType,
      scope_id:   scopeId,
      tipo,
      valor,
      etiqueta:   get('etiqueta')?.value.trim() || '',
      prioridad:  numOrNull(get('prioridad')) ?? 0,
      activo:     !!get('activo')?.checked,
      stackable:  false,
    };
    if (tipo === 'por_cantidad') obj.cantidad_min = numOrNull(get('cantidad_min')) ?? 1;
    if (tipo === 'por_fecha') {
      obj.desde = get('desde')?.value || '';
      obj.hasta = get('hasta')?.value || '';
    }
    out.push(obj);
  });
  return out;
}

/**
 * Sincroniza la lista de descuentos del scope contra Firestore.
 * Borra los que ya no están, crea los nuevos, actualiza los modificados.
 */
async function sincronizarDescuentos(db, originales, nuevos) {
  const idsNuevos = new Set(nuevos.filter(n => n._id).map(n => n._id));
  const aBorrar   = originales.filter(o => !idsNuevos.has(o._id));

  // Borrar removidos
  for (const o of aBorrar) {
    await deleteDoc(doc(db, COL_DISC, o._id));
  }
  // Crear / actualizar
  for (const n of nuevos) {
    const data = { ...n };
    delete data._id;
    data.actualizado = serverTimestamp();
    if (n._id) {
      await updateDoc(doc(db, COL_DISC, n._id), data);
    } else {
      data.creado = serverTimestamp();
      const ref = await addDoc(collection(db, COL_DISC), data);
      await updateDoc(ref, { id: ref.id });
    }
  }
}

function seccionTitulo(txt, hint = '') {
  return `
    <div style="display:flex;align-items:center;gap:6px;margin:0 0 6px;padding:0 0 4px;border-bottom:1px dashed #fde68a">
      <span style="font-size:10px;font-weight:800;letter-spacing:0.7px;color:#78350f;text-transform:uppercase">${escapeHtml(txt)}</span>
      ${hint ? `<span title="${escapeHtml(hint)}" style="opacity:0.45;font-size:11px;cursor:help">ⓘ</span>` : ''}
    </div>`;
}

function filaPresentacion(p = {}) {
  const wrap = document.createElement('div');
  wrap.dataset.presRow = '1';
  wrap.style.cssText = 'background:white;border:1px solid #fde68a;border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:7px';
  const tipoOpts = TIPOS_PRESENTACION.map(t =>
    `<option value="${t.value}" ${t.value === (p.tipo || 'unidad') ? 'selected' : ''}>${t.label}</option>`
  ).join('');
  const modoOpts = STOCK_MODOS.map(m =>
    `<option value="${m.value}" ${m.value === (p.stock_modo || 'independiente') ? 'selected' : ''}>${m.label}</option>`
  ).join('');
  const codigoInicial = p.codigo_barras || generarCodigoBarras();
  const margenCalc = (typeof p.precio_costo === 'number' && p.precio_costo > 0 && typeof p.precio_venta === 'number' && p.precio_venta > 0)
    ? ((p.precio_venta - p.precio_costo) / p.precio_costo * 100).toFixed(1)
    : '';
  // Avanzado abierto si el usuario ya cargó algún campo no-esencial
  const tieneAvanzado = !!(p.sku_sufijo || p.unidad_medida || p.equivalencia_base || p.stock_minimo || p.stock_minimo_sueltos || (p.stock_modo && p.stock_modo !== 'independiente') || p.precio_costo);
  const inp = `${estiloInput()};padding:6px 9px;font-size:13px`;

  // Estilo del mini-label arriba de cada campo
  const lbl = (txt, hint = '') => `
    <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;color:#92400e;text-transform:uppercase;margin-bottom:2px"${hint ? ` title="${escapeHtml(hint)}"` : ''}>
      ${escapeHtml(txt)}${hint ? ' <span style="opacity:0.5;text-transform:none">ⓘ</span>' : ''}
    </div>`;

  wrap.innerHTML = `
    <!-- Línea 1: tipo · etiqueta · código + acciones -->
    <div style="display:grid;grid-template-columns:120px 1fr 130px 30px 30px;gap:6px;align-items:end">
      <div>
        ${lbl('Tipo', 'Cómo se vende: por unidad, pack, caja, rollo, metro, kg, etc.')}
        <select data-pf="tipo" style="${inp}">${tipoOpts}</select>
      </div>
      <div>
        ${lbl('Etiqueta', 'Texto visible en el ticket (ej: "Pack x10", "Por metro").')}
        <input data-pf="label" type="text" placeholder="ej: Pack x10" value="${escapeHtml(p.label || '')}" style="${inp}" />
      </div>
      <div>
        ${lbl('Código', 'Código de barras (8 dígitos, auto-generado).')}
        <div style="display:flex;gap:3px">
          <input data-pf="codigo_barras" type="text" placeholder="auto" value="${escapeHtml(codigoInicial)}" style="${inp};flex:1;font-family:'Courier New',monospace" />
          <button type="button" data-pf-regen title="Regenerar código" style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:6px;padding:0 6px;cursor:pointer;font-size:13px;line-height:1">↻</button>
        </div>
      </div>
      <button type="button" data-pf-toggle-adv title="Más opciones (SKU, unidad medida, equivalencia, mínimos, modo, costo, margen)" style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:6px;padding:0;cursor:pointer;font-size:18px;height:30px;line-height:1">⋯</button>
      <button type="button" data-pres-remove title="Eliminar esta presentación" style="background:#fff0f0;border:1px solid #fca5a5;color:#dc3545;border-radius:6px;padding:0;cursor:pointer;font-size:16px;height:30px">×</button>
    </div>

    <!-- Línea 2: stock principal · sueltos · precio venta · ↗100 -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 36px;gap:6px;align-items:end">
      <div>
        ${lbl('Stock', 'Cantidad en stock de esta presentación (ej: 5 rollos enteros).')}
        <input data-pf="stock" type="number" step="any" min="0" placeholder="0" value="${p.stock ?? ''}" style="${inp}" />
      </div>
      <div>
        ${lbl('Sueltos (opc.)', 'Cantidad ya abierta del último contenedor (ej: 60 m sueltos del rollo abierto). Al vender se descuenta primero de acá.')}
        <input data-pf="stock_sueltos" type="number" step="any" min="0" placeholder="0" value="${p.stock_sueltos ?? ''}" style="${inp}" />
      </div>
      <div>
        ${lbl('Precio venta', 'Precio al que se cobra esta presentación. Si lo dejás vacío, usa el precio del nodo.')}
        <input data-pf="precio_venta" type="number" step="0.01" min="0" placeholder="$ usa nodo" value="${p.precio_venta ?? ''}" style="${inp};font-weight:700" />
      </div>
      <div style="display:flex;flex-direction:column">
        <div style="font-size:10px;height:14px;margin-bottom:2px"></div>
        <button type="button" data-pf-redondeo title="Redondear precio venta al centenar más cercano" style="width:100%;height:30px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:6px;padding:0;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center">↗</button>
      </div>
    </div>

    <!-- Avanzado: secciones agrupadas por propósito -->
    <div data-pf-adv style="background:#fffbeb;border-radius:6px;padding:10px;display:${tieneAvanzado ? 'flex' : 'none'};flex-direction:column;gap:12px">

      <!-- Sección: Identificación + Medida -->
      <div>
        ${seccionTitulo('Identificación y medida')}
        <div style="display:grid;grid-template-columns:1fr 110px 110px 1fr;gap:6px;align-items:end">
          <div>
            ${lbl('SKU sufijo', 'Identificador interno opcional (ej: ROJ-50). Útil para reportes.')}
            <input data-pf="sku_sufijo" type="text" placeholder="opcional" value="${escapeHtml(p.sku_sufijo || '')}" style="${inp}" />
          </div>
          <div>
            ${lbl('Unidad', 'Unidad base que se vende (un, m, cm, kg, g).')}
            <input data-pf="unidad_medida" type="text" placeholder="un / m / kg" value="${escapeHtml(p.unidad_medida || '')}" style="${inp}" />
          </div>
          <div>
            ${lbl('Equivalencia', 'Cuánto contiene un contenedor (ej: 50 si 1 rollo = 50 m, 100 si 1 caja = 100 un).')}
            <input data-pf="equivalencia_base" type="number" step="any" min="0" placeholder="ej: 50" value="${p.equivalencia_base ?? ''}" style="${inp}" />
          </div>
          <div>
            ${lbl('Modo stock', 'Independiente: contador propio. Vinculado: descuenta de otra presentación al vender.')}
            <select data-pf="stock_modo" style="${inp}">${modoOpts}</select>
          </div>
        </div>
      </div>

      <!-- Sección: Vinculación (corte a medida desde un contenedor) -->
      <div>
        ${seccionTitulo('Vinculada a otra presentación', 'Para presentaciones de "corte a medida" (por metro / unidad suelta) que descuentan stock de un contenedor (rollo / caja). El precio se calcula automático con +15% de margen al detalle si lo dejás vacío.')}
        <div style="display:grid;grid-template-columns:1fr;gap:6px">
          <div>
            ${lbl('Contenedor fuente', 'La presentación contenedora (rollo, caja, pack) de la cual esta saca el stock al vender.')}
            <select data-pf="vinculada_a" style="${inp}">
              <option value="">— Ninguna (independiente) —</option>
            </select>
            <p data-pf-vinculada-hint style="margin:4px 0 0;font-size:11px;color:#92400e;font-style:italic"></p>
          </div>
        </div>
      </div>

      <!-- Sección: Avisos de stock bajo -->
      <div>
        ${seccionTitulo('Avisos de stock bajo', 'Te avisa cuando el stock cae por debajo del mínimo configurado.')}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;align-items:end">
          <div>
            ${lbl('Stock mín.', 'Mínimo del stock principal (ej: rollos enteros).')}
            <input data-pf="stock_minimo" type="number" step="any" min="0" placeholder="0" value="${p.stock_minimo ?? ''}" style="${inp}" />
          </div>
          <div>
            ${lbl('Sueltos mín.', 'Mínimo de los sueltos (ej: metros sueltos del rollo abierto).')}
            <input data-pf="stock_minimo_sueltos" type="number" step="any" min="0" placeholder="0" value="${p.stock_minimo_sueltos ?? ''}" style="${inp}" />
          </div>
        </div>
      </div>

      <!-- Sección: Costo y margen -->
      <div>
        ${seccionTitulo('Costo y margen propios (opcional)')}
        <div style="display:grid;grid-template-columns:1fr 100px;gap:6px;align-items:end">
          <div>
            ${lbl('Costo', 'Costo propio de esta presentación. Si vacío, usa el costo del nodo.')}
            <input data-pf="precio_costo" type="number" step="0.01" min="0" placeholder="usa nodo" value="${p.precio_costo ?? ''}" style="${inp}" />
          </div>
          <div>
            ${lbl('% Margen', 'Margen sobre el costo. Cambiar costo o margen recalcula el precio venta.')}
            <input data-pf="precio_margen" type="number" step="1" min="0" placeholder="80" value="${margenCalc}" style="${inp};color:#7b3fa6;font-weight:700" />
          </div>
        </div>
      </div>
    </div>
  `;

  // Confirmar antes de eliminar para evitar borrados accidentales
  wrap.querySelector('[data-pres-remove]').onclick = async (e) => {
    e.stopPropagation();
    const lbl = wrap.querySelector('[data-pf="label"]')?.value.trim() || 'esta presentación';
    const ok = await confirmDialog({
      title: 'Eliminar presentación',
      message: `¿Eliminar <strong>"${lbl}"</strong>?<br><br>Se va a perder el stock y precio cargados.`,
      confirmText: 'Eliminar',
      danger: true,
    });
    if (ok) wrap.remove();
  };
  wrap.querySelector('[data-pf-regen]').onclick = (e) => {
    e.stopPropagation();
    wrap.querySelector('[data-pf="codigo_barras"]').value = generarCodigoBarras();
  };
  wrap.querySelector('[data-pf-toggle-adv]').onclick = (e) => {
    e.stopPropagation();
    const adv = wrap.querySelector('[data-pf-adv]');
    const opening = adv.style.display === 'none';
    adv.style.display = opening ? 'flex' : 'none';
    // Re-poblar el dropdown "Vinculada a" al abrir, por si se agregaron filas nuevas
    if (opening) refreshVinculadaSelect(wrap);
  };
  // Evitar que clicks dentro del row burbujeen al modal (que cerraría el dropdown nativo)
  wrap.addEventListener('click', e => e.stopPropagation());
  // Cálculo automático costo↔margen↔venta + redondeo a centenar para esta presentación
  setupCostoMargenVenta(
    wrap.querySelector('[data-pf="precio_costo"]'),
    wrap.querySelector('[data-pf="precio_margen"]'),
    wrap.querySelector('[data-pf="precio_venta"]'),
    wrap.querySelector('[data-pf-redondeo]'),
  );
  // Persiste el id local para mantener la fila estable entre re-renders
  wrap.dataset.presId = p.id || nuevoIdLocal();
  // Vinculación: al cambiar la fuente, actualizar modo y placeholder de precio venta
  const vincSel = wrap.querySelector('[data-pf="vinculada_a"]');
  if (vincSel) {
    // Setear el valor actual si ya existe (al editar nodo guardado)
    if (p.vinculada_a) vincSel.dataset.preselect = p.vinculada_a;
    refreshVinculadaSelect(wrap);
    vincSel.onchange = () => onVinculadaChange(wrap);
    // Re-pulsar la lista cada vez que el usuario abre el dropdown.
    // Esto cubre el caso "agregué otra presentación después de haber abierto este avanzado":
    // sin esto, el select se quedaba con las opciones viejas y mostraba "no hay otras".
    vincSel.onmousedown = () => refreshVinculadaSelect(wrap);
    vincSel.onfocus     = () => refreshVinculadaSelect(wrap);
    onVinculadaChange(wrap);  // pinta placeholder inicial
  }
  return wrap;
}

/**
 * Llena el <select data-pf="vinculada_a"> con las hermanas (otras presentaciones
 * del mismo nodo). La opción actual se conserva. Llamar al abrir el panel
 * avanzado o cuando agreguemos/quitamos filas.
 */
function refreshVinculadaSelect(wrap) {
  const sel = wrap.querySelector('[data-pf="vinculada_a"]');
  if (!sel) return;
  const meId = wrap.dataset.presId;
  const cont = document.getElementById('lpNodoPresentaciones');
  if (!cont) return;
  // Valor actual a preservar
  const actual = sel.value || sel.dataset.preselect || '';
  sel.innerHTML = '<option value="">— Ninguna (independiente) —</option>';
  let hermanas = 0;
  cont.querySelectorAll('[data-pres-row]').forEach(row => {
    const id = row.dataset.presId;
    if (!id || id === meId) return;
    const tipo  = row.querySelector('[data-pf="tipo"]')?.value || '';
    const label = (row.querySelector('[data-pf="label"]')?.value || '').trim() || tipo;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    if (id === actual) opt.selected = true;
    sel.appendChild(opt);
    hermanas++;
  });
  delete sel.dataset.preselect;
  // Si no hay otras presentaciones, hint claro al usuario
  const hintEl = wrap.querySelector('[data-pf-vinculada-hint]');
  if (hermanas === 0 && hintEl && !sel.value) {
    hintEl.textContent = 'No hay otras presentaciones en este nodo. Agregá primero una fuente (rollo / pack / caja) con su precio y equivalencia, y después esta podrá vincularse.';
  }
}

/**
 * Reacciona al cambio del select "Vinculada a":
 *   - Si hay fuente, fuerza stock_modo='vinculado' y muestra hint con el cálculo
 *     de precio auto = fuente.precio_venta / fuente.equivalencia × FRACCION_MARGIN.
 *   - Si no, vuelve a 'independiente'.
 */
function onVinculadaChange(wrap) {
  const fuenteId = wrap.querySelector('[data-pf="vinculada_a"]')?.value || '';
  const modoSel  = wrap.querySelector('[data-pf="stock_modo"]');
  const ventaInp = wrap.querySelector('[data-pf="precio_venta"]');
  const hint     = wrap.querySelector('[data-pf-vinculada-hint]');
  if (!fuenteId) {
    if (modoSel && modoSel.value === 'vinculado') modoSel.value = 'independiente';
    if (ventaInp) ventaInp.placeholder = '$ usa nodo';
    if (hint) hint.textContent = '';
    return;
  }
  if (modoSel) modoSel.value = 'vinculado';
  // Buscar la fuente en el DOM para leer su precio_venta y equivalencia actuales
  const cont = document.getElementById('lpNodoPresentaciones');
  const src  = cont?.querySelector(`[data-pres-row][data-pres-id="${fuenteId}"]`);
  const srcPrecio = parseFloat(src?.querySelector('[data-pf="precio_venta"]')?.value || '0') || 0;
  const srcEquiv  = parseFloat(src?.querySelector('[data-pf="equivalencia_base"]')?.value || '0') || 0;
  const srcUnidad = src?.querySelector('[data-pf="unidad_medida"]')?.value || '';
  if (srcPrecio > 0 && srcEquiv > 0) {
    const auto = srcPrecio / srcEquiv * FRACCION_MARGIN;
    if (ventaInp) ventaInp.placeholder = `auto: $${auto.toFixed(2)}`;
    if (hint) hint.textContent = `Auto: $${srcPrecio.toFixed(2)} ÷ ${srcEquiv}${srcUnidad} × ${FRACCION_MARGIN} = $${auto.toFixed(2)} por ${srcUnidad || 'unidad'}. Si dejás Precio venta vacío, se usa este valor.`;
  } else {
    if (ventaInp) ventaInp.placeholder = '$ (cargá precio + equivalencia en la fuente)';
    if (hint) hint.textContent = 'Cargá Precio venta y Equivalencia en la presentación fuente para calcular el precio automático.';
  }
}

function leerPresentaciones() {
  const out = [];
  document.querySelectorAll('#lpNodoPresentaciones [data-pres-row]').forEach(row => {
    const get = sel => row.querySelector(`[data-pf="${sel}"]`)?.value ?? '';
    const numOrNull = v => { const s = String(v).trim(); if (s === '') return null; const n = parseFloat(s); return isNaN(n) ? null : n; };
    const tipo = get('tipo');
    const label = get('label').trim();
    if (!tipo) return;
    out.push({
      id:                row.dataset.presId,
      tipo,
      label:             label || tipo,
      codigo_barras:     get('codigo_barras').trim(),
      sku_sufijo:        get('sku_sufijo').trim(),
      unidad_medida:     get('unidad_medida').trim() || (TIPOS_PRESENTACION.find(t => t.value === tipo)?.unidadBase || ''),
      equivalencia_base: numOrNull(get('equivalencia_base')),
      stock:             numOrNull(get('stock'))                ?? 0,
      stock_minimo:      numOrNull(get('stock_minimo'))         ?? 0,
      stock_sueltos:        numOrNull(get('stock_sueltos'))         ?? 0,
      stock_minimo_sueltos: numOrNull(get('stock_minimo_sueltos')) ?? 0,
      precio_costo:      numOrNull(get('precio_costo')),
      precio_venta:      numOrNull(get('precio_venta')),
      stock_modo:        get('stock_modo') || 'independiente',
      vinculada_a:       get('vinculada_a') || null,
      activo:            true,
    });
  });
  return out;
}

/**
 * Conecta tres inputs (costo, margen%, venta) y un botón de redondeo a centenar.
 * Misma lógica que la pantalla Catálogo: cambiar costo o margen recalcula venta;
 * cambiar venta recalcula margen. El botón redondea venta al centenar más cercano
 * y reajusta el margen.
 */
function setupCostoMargenVenta(costoEl, margenEl, ventaEl, redondeoBtn) {
  if (!costoEl || !margenEl || !ventaEl) return;
  let actualizando = null;
  const recalc = (source) => {
    if (actualizando && actualizando !== source) return;
    const c = parseFloat(costoEl.value);
    const m = parseFloat(margenEl.value);
    const v = parseFloat(ventaEl.value);
    actualizando = source;
    if ((source === 'costo' || source === 'margen') && c > 0 && !isNaN(m)) {
      ventaEl.value = (c * (1 + m / 100)).toFixed(2);
    } else if (source === 'venta' && c > 0 && v > 0) {
      margenEl.value = ((v - c) / c * 100).toFixed(1);
    }
    actualizando = null;
  };
  // Asignación directa para que no se apilen listeners si setupGlobalEvents re-ejecuta
  costoEl.oninput  = () => recalc('costo');
  margenEl.oninput = () => recalc('margen');
  ventaEl.oninput  = () => recalc('venta');
  if (redondeoBtn) {
    redondeoBtn.onclick = () => {
      const v = parseFloat(ventaEl.value);
      if (!(v > 0)) return;
      ventaEl.value = (Math.round(v / 100) * 100).toFixed(2);
      recalc('venta'); // recalcula margen tras el redondeo
    };
  }
}

// ── Descuentos: load + resolución override puro ─────────────────────────────
/**
 * Carga todos los descuentos asociados a un producto madre y a sus nodos.
 * Devuelve un array indexable por scope_id.
 */
async function cargarDescuentos(db, productoId) {
  // Descuentos del producto madre (scope_type='product', scope_id=productoId)
  const qP = query(collection(db, COL_DISC), where('product_id', '==', productoId));
  const snap = await getDocs(qP);
  return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

function descuentoVigenteHoy(d, hoy = new Date()) {
  if (d.activo === false) return false;
  if (d.desde) {
    const desde = new Date(d.desde + 'T00:00:00');
    if (hoy < desde) return false;
  }
  if (d.hasta) {
    const hasta = new Date(d.hasta + 'T23:59:59');
    if (hoy > hasta) return false;
  }
  return true;
}

/**
 * Resuelve qué descuento aplica para una venta concreta. Override puro:
 * presentación → nodo (hoja) → ancestros → producto. Primer match cierra,
 * NO se acumulan descuentos. Si hay varios activos en el mismo scope,
 * gana el de mayor prioridad.
 *
 * @param {object} producto      doc de mp_products
 * @param {object} nodo          doc de mp_nodes (la hoja vendida)
 * @param {object} presentacion  presentación específica (opcional)
 * @param {Array}  todosLosNodos array de todos los mp_nodes del producto (para subir el path)
 * @param {Array}  descuentos    lista cargada de mp_discounts del producto
 * @param {number} cantidad      cantidad vendida (para evaluar 'por_cantidad')
 * @returns {object|null}        el descuento que aplica, o null
 */
function descuentoEfectivo(producto, nodo, presentacion, todosLosNodos, descuentos, cantidad = 1) {
  if (!descuentos?.length) return null;

  const aplicaA = (d, scopeType, scopeId) => {
    if (d.scope_type !== scopeType || d.scope_id !== scopeId) return false;
    if (!descuentoVigenteHoy(d)) return false;
    if (d.tipo === 'por_cantidad' && cantidad < (d.cantidad_min || 1)) return false;
    return true;
  };

  const elegirGanador = (candidatos) => {
    if (!candidatos.length) return null;
    return candidatos.slice().sort((a, b) => (b.prioridad || 0) - (a.prioridad || 0))[0];
  };

  // 1) Presentación específica
  if (presentacion?.id) {
    const cand = descuentos.filter(d => aplicaA(d, 'presentation', presentacion.id));
    const g = elegirGanador(cand);
    if (g) return g;
  }

  // 2) Nodo + ancestros (subiendo por el path)
  if (nodo) {
    const path = nodo.path || [];
    // path es [productId, ancestor1, ..., self]. Recorrer de hoja → ancestros excl. productId
    for (let i = path.length - 1; i >= 1; i--) {
      const id = path[i];
      const cand = descuentos.filter(d => aplicaA(d, 'node', id));
      const g = elegirGanador(cand);
      if (g) return g;
    }
  }

  // 3) Producto madre
  const candP = descuentos.filter(d => aplicaA(d, 'product', producto._id));
  const g = elegirGanador(candP);
  return g || null;
}

/**
 * Aplica un descuento sobre un precio base. Devuelve { precioFinal, descuentoMonto, etiqueta }.
 */
function aplicarDescuento(precioBase, descuento, cantidad = 1) {
  if (!descuento || !precioBase) return { precioFinal: precioBase, descuentoMonto: 0, etiqueta: '' };
  let precioFinal = precioBase;
  let etiqueta = '';
  switch (descuento.tipo) {
    case 'porcentaje':
    case 'por_cantidad':
    case 'por_fecha':
      precioFinal = precioBase * (1 - (descuento.valor || 0) / 100);
      etiqueta = `−${descuento.valor}%`;
      break;
    case 'monto_fijo':
      precioFinal = Math.max(0, precioBase - (descuento.valor || 0));
      etiqueta = `−$${descuento.valor}`;
      break;
  }
  return { precioFinal, descuentoMonto: precioBase - precioFinal, etiqueta };
}

function leerPrecioNodo() {
  const numOrNull = v => { const s = String(v).trim(); if (s === '') return null; const n = parseFloat(s); return isNaN(n) ? null : n; };
  return {
    costo: numOrNull(document.getElementById('lpNodoPrecioCosto').value),
    venta: numOrNull(document.getElementById('lpNodoPrecioVenta').value),
  };
}

function leerAtributosNodo() {
  const out = {};
  document.querySelectorAll('#lpNodoAttrs > div').forEach(row => {
    // Filas custom: tienen data-attr-source="custom"
    if (row.dataset.attrSource === 'custom') {
      const k = row.querySelector('[data-field="key"]')?.value.trim();
      const v = row.querySelector('[data-field="value"]')?.value.trim();
      if (k && v) out[slugify(k)] = v;
      return;
    }
    const key = row.dataset.attrKey;
    const tipo = row.dataset.attrTipo;
    if (!key) return;
    if (tipo === 'color') {
      const v   = row.querySelector('[data-field="value"]')?.value.trim() || '';
      const hex = row.querySelector('[data-field="hex"]')?.value || '';
      // Solo persistir si hay un nombre/valor; el hex por sí solo (default #000000) no cuenta
      if (v) out[key] = { value: v, label: v, hex };
    } else if (tipo === 'tamano') {
      const ancho  = parseFloat(row.querySelector('[data-field="ancho"]')?.value) || null;
      const alto   = parseFloat(row.querySelector('[data-field="alto"]')?.value)  || null;
      const unidad = row.querySelector('[data-field="unidad"]')?.value || 'cm';
      if (ancho !== null && alto !== null) {
        out[key] = { ancho, alto, unidad, label: `${ancho}x${alto} ${unidad}` };
      }
    } else if (tipo === 'medida' || tipo === 'gramaje' || tipo === 'numero') {
      const valStr = row.querySelector('[data-field="value"]')?.value.trim() || '';
      const unidad = row.querySelector('[data-field="unidad"]')?.value || '';
      if (valStr !== '') {
        const v = parseFloat(valStr);
        out[key] = isNaN(v) ? { value: valStr, unidad } : { value: v, unidad };
      }
    } else {
      const v = row.querySelector('[data-field="value"]')?.value.trim() || '';
      if (v) out[key] = v;
    }
  });
  return out;
}

function pintarOverrides(overrides) {
  const cont = document.getElementById('lpNodoOverrides');
  if (!cont) return;
  const heredaCat  = document.getElementById('lpNodoHeredaCat').checked;
  const heredaMar  = document.getElementById('lpNodoHeredaMar').checked;
  const heredaDesc = document.getElementById('lpNodoHeredaDesc').checked;

  const filas = [];
  if (!heredaCat)  filas.push({ key: 'categoria',  label: 'Categoría',  val: overrides.categoria  ?? '' });
  if (!heredaMar)  filas.push({ key: 'marca',      label: 'Marca',      val: overrides.marca      ?? '' });
  if (!heredaDesc) filas.push({ key: 'descripcion', label: 'Descripción', val: overrides.descripcion ?? '' });

  if (!filas.length) {
    cont.style.display = 'none';
    cont.innerHTML = '';
    return;
  }
  cont.style.display = 'flex';
  cont.innerHTML = filas.map(f =>
    `<div>
      <label style="font-size:12px;font-weight:600;color:#495057;display:block;margin-bottom:3px">${f.label} (override)</label>
      <input data-override="${f.key}" type="text" value="${escapeHtml(f.val)}" style="${estiloInput()};padding:7px 10px" />
    </div>`
  ).join('');
}

function leerOverrides() {
  const out = {};
  document.querySelectorAll('#lpNodoOverrides [data-override]').forEach(inp => {
    const k = inp.dataset.override;
    const v = inp.value.trim();
    if (v) out[k] = v;
  });
  return out;
}

async function guardarNodo(db) {
  const errEl = document.getElementById('lpNodoError');
  const btn   = document.getElementById('lpNodoGuardar');
  errEl.style.display = 'none';

  const producto = _state.productoActivo;
  const nombre = document.getElementById('lpNodoNombre').value.trim();
  if (!nombre) {
    errEl.textContent = 'El nombre es obligatorio.';
    errEl.style.display = 'block';
    return;
  }

  const idEditando = document.getElementById('lpNodoId').value;
  const parentId   = document.getElementById('lpNodoParentId').value || null;
  const padre      = parentId ? _state.nodes.find(n => n._id === parentId) : null;

  const path = padre
    ? [...(padre.path || [producto._id]), '__SELF__']
    : [producto._id, '__SELF__'];
  const depth = path.length - 2; // raíz directa = 0

  // Precio + presentaciones embebidos
  const precio = leerPrecioNodo();
  const presentaciones = leerPresentaciones();

  // Determinar si el nodo es (o seguirá siendo) hoja para validar precio venta
  const actual = idEditando ? _state.nodes.find(n => n._id === idEditando) : null;
  const seraHoja = idEditando ? (actual?.es_hoja ?? true) : true; // nodo nuevo arranca hoja

  if (seraHoja && (precio.venta === null || precio.venta < 0)) {
    errEl.textContent = 'El precio de venta es obligatorio en nodos hoja (los que se venden).';
    errEl.style.display = 'block';
    return;
  }

  const data = {
    product_id: producto._id,
    parent_id:  parentId,
    nombre,
    sku_sufijo: document.getElementById('lpNodoSku').value.trim(),
    atributos:  leerAtributosNodo(),
    precio,
    presentaciones,
    hereda_de_padre: {
      categoria:   document.getElementById('lpNodoHeredaCat').checked,
      marca:       document.getElementById('lpNodoHeredaMar').checked,
      descripcion: document.getElementById('lpNodoHeredaDesc').checked,
    },
    overrides:  leerOverrides(),
    depth,
    actualizado: serverTimestamp(),
  };

  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    let nodoId = idEditando;
    if (idEditando) {
      // Mantener path existente (solo cambiamos atributos del nodo, no la posición)
      data.path    = actual?.path || path.map(p => p === '__SELF__' ? idEditando : p);
      data.es_hoja = actual?.es_hoja ?? true;
      await updateDoc(doc(db, COL_NODES, idEditando), data);
    } else {
      // Crear: pre-generar id para construir el path
      const ref = doc(collection(db, COL_NODES));
      data.id      = ref.id;
      data.path    = path.map(p => p === '__SELF__' ? ref.id : p);
      data.es_hoja = true;          // todo nuevo nodo arranca como hoja
      data.creado  = serverTimestamp();
      await setDoc(ref, data);
      nodoId = ref.id;

      // Si el padre era hoja, ya no lo es
      if (padre && padre.es_hoja) {
        await updateDoc(doc(db, COL_NODES, padre._id), { es_hoja: false });
      }
    }

    // Sync descuentos del nodo
    const discCont = document.getElementById('lpNodoDescuentos');
    const nuevos = leerDescuentos(discCont, 'node', nodoId, producto._id);
    const originales = (_state.descuentos || []).filter(d => d.scope_type === 'node' && d.scope_id === nodoId);
    await sincronizarDescuentos(db, originales, nuevos);

    invalidateCacheByPrefix('mp:');
    cerrarModal('nodo');
    await cargarNodos(db, producto._id);
  } catch (err) {
    errEl.textContent = 'Error al guardar: ' + err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar nodo';
  }
}

async function borrarNodo(db, nodo) {
  // Subárbol = todos los nodos cuyo path contiene nodo._id
  const subarbol = _state.nodes.filter(n => (n.path || []).includes(nodo._id));
  const totalDescendientes = subarbol.length - 1; // sin contar al propio nodo
  const msg = totalDescendientes > 0
    ? `¿Eliminar <strong>"${nodo.nombre}"</strong> y sus <strong>${totalDescendientes} descendiente(s)</strong>?<br><br>Esta acción no se puede deshacer.`
    : `¿Eliminar <strong>"${nodo.nombre}"</strong>?`;
  const ok = await confirmDialog({
    title: 'Eliminar nodo',
    message: msg,
    confirmText: 'Eliminar',
    danger: true,
  });
  if (!ok) return;

  try {
    const docs = subarbol.slice();
    while (docs.length) {
      const chunk = docs.splice(0, 400);
      const batch = writeBatch(db);
      chunk.forEach(n => batch.delete(doc(db, COL_NODES, n._id)));
      await batch.commit();
    }

    // Si el padre se queda sin hijos, vuelve a ser hoja
    if (nodo.parent_id) {
      const tieneHermanos = _state.nodes.some(n =>
        n.parent_id === nodo.parent_id &&
        n._id !== nodo._id &&
        !(n.path || []).includes(nodo._id)
      );
      if (!tieneHermanos) {
        await updateDoc(doc(db, COL_NODES, nodo.parent_id), { es_hoja: true });
      }
    }

    invalidateCacheByPrefix('mp:');
    await cargarNodos(db, _state.productoActivo._id);
  } catch (err) {
    await alertDialog({ title: 'Error al borrar', message: err.message, type: 'error' });
  }
}

// ── Eventos globales (modales, formularios) ──────────────────────────────────
// IMPORTANTE: usamos asignación directa (.onclick = / .onsubmit =) en lugar de
// addEventListener para los botones y formularios estáticos del modal. Si por
// algún motivo setupGlobalEvents corre más de una vez (HMR raro, navegación
// rápida), la asignación directa sobrescribe el handler anterior en vez de
// apilar varios — evita bugs como "click agrega 2 filas".
function setupGlobalEvents(db) {
  // Cierre de modales
  document.querySelectorAll('[data-close]').forEach(b => {
    b.onclick = () => cerrarModal(b.dataset.close);
  });
  // Click fuera del modal
  ['lpMadreModal', 'lpNodoModal'].forEach(mid => {
    const m = document.getElementById(mid);
    if (m) m.onclick = (e) => { if (e.target === m) m.style.display = 'none'; };
  });

  // Form madre
  document.getElementById('lpMadreForm').onsubmit = (e) => {
    e.preventDefault();
    guardarMadre(db);
  };
  document.getElementById('lpMadreAddAttr').onclick = () => {
    document.getElementById('lpMadreAttrs').appendChild(filaAtributoMadre());
  };
  document.getElementById('lpMadreCodigoReGen').onclick = () => {
    document.getElementById('lpMadreCodigo').value = generarCodigoBarras();
  };
  document.getElementById('lpMadreAddDisc').onclick = () => {
    document.getElementById('lpMadreDescuentos').appendChild(filaDescuento());
  };

  // Form nodo
  document.getElementById('lpNodoForm').onsubmit = (e) => {
    e.preventDefault();
    guardarNodo(db);
  };
  document.getElementById('lpNodoAddAttr').onclick = () => mostrarPanelAddAttr(db);
  // Handler delegado: × en una fila de atributo → quitar del schema del producto madre.
  // Usamos asignación directa en lpNodoAttrs para que no se apile si re-ejecuta.
  document.getElementById('lpNodoAttrs').onclick = async (e) => {
    const btn = e.target.closest('[data-attr-remove-from-madre]');
    if (!btn) return;
    e.stopPropagation();
    const key = btn.dataset.attrRemoveFromMadre;
    const lblTxt = btn.dataset.attrLabel || key;
    const producto = _state.productoActivo;
    if (!producto || !key) return;
    const ok = await confirmDialog({
      title: 'Quitar atributo del producto madre',
      message: `¿Quitar el atributo <strong>"${lblTxt}"</strong> del producto madre?<br><br>Va a desaparecer en <strong>TODAS</strong> las variantes y se borrará el valor cargado en cada una.`,
      confirmText: 'Quitar',
      danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const nuevosDefs = (producto.atributos_definidos || []).filter(a => a.key !== key);
      await updateDoc(doc(db, COL_PROD, producto._id), {
        atributos_definidos: nuevosDefs,
        actualizado: serverTimestamp(),
      });
      producto.atributos_definidos = nuevosDefs;
      const idxList = _state.productos.findIndex(p => p._id === producto._id);
      if (idxList >= 0) _state.productos[idxList].atributos_definidos = nuevosDefs;
      invalidateCacheByPrefix('mp:');
      // Quitar la fila visual del modal del nodo
      btn.closest('div[data-attr-key]')?.remove();
    } catch (err) {
      await alertDialog({ title: 'Error al quitar atributo', message: err.message, type: 'error' });
      btn.disabled = false;
      btn.textContent = '×';
    }
  };
  document.getElementById('lpNodoAddPres').onclick = () => {
    document.getElementById('lpNodoPresentaciones').appendChild(filaPresentacion());
  };
  document.getElementById('lpNodoAddDisc').onclick = () => {
    document.getElementById('lpNodoDescuentos').appendChild(filaDescuento());
  };
  // Cálculo automático costo↔margen↔venta + botón redondeo a centenar (precio del nodo)
  setupCostoMargenVenta(
    document.getElementById('lpNodoPrecioCosto'),
    document.getElementById('lpNodoPrecioMargen'),
    document.getElementById('lpNodoPrecioVenta'),
    document.getElementById('lpNodoPrecioRedondeo'),
  );
  ['lpNodoHeredaCat', 'lpNodoHeredaMar', 'lpNodoHeredaDesc'].forEach(id => {
    // Al togglear herencia, preservar lo que el usuario ya haya tipeado en los overrides
    document.getElementById(id).onchange = () => pintarOverrides(leerOverrides());
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SEED DE DATOS DE LIBRERÍA
// Crea productos madre típicos para probar el módulo end-to-end. Todo lo creado
// lleva _seed: true para que se pueda limpiar con un solo click.
// ═════════════════════════════════════════════════════════════════════════════

const SEED_DATA = [
  {
    nombre: 'Cartulina Escolar',
    rubro: 'LIBRERÍA',
    categoria: 'Papelería',
    marca: 'Genérica',
    descripcion: 'Cartulinas para trabajos escolares y manualidades.',
    atributos_definidos: [
      { key: 'color',   label: 'Color',   tipo: 'color',   unidad: '' },
      { key: 'tamano',  label: 'Tamaño',  tipo: 'tamano',  unidad: 'cm' },
      { key: 'gramaje', label: 'Gramaje', tipo: 'gramaje', unidad: 'gr' },
    ],
    raices: [
      {
        nombre: 'Roja',
        atributos: { color: { value: 'Rojo', label: 'Rojo', hex: '#dc2626' } },
        hijos: [
          {
            nombre: '50x70cm 180gr',
            atributos: {
              color: { value: 'Rojo', label: 'Rojo', hex: '#dc2626' },
              tamano: { ancho: 50, alto: 70, unidad: 'cm', label: '50x70 cm' },
              gramaje: { value: 180, unidad: 'gr' },
            },
            precio: { costo: 280, venta: 500 },
            presentaciones: [
              { tipo: 'unidad', label: 'Unidad', unidad_medida: 'un', stock: 80, stock_minimo: 10, equivalencia_base: null, stock_modo: 'independiente' },
            ],
          },
          {
            nombre: '70x100cm 180gr',
            atributos: {
              color: { value: 'Rojo', label: 'Rojo', hex: '#dc2626' },
              tamano: { ancho: 70, alto: 100, unidad: 'cm', label: '70x100 cm' },
              gramaje: { value: 180, unidad: 'gr' },
            },
            precio: { costo: 480, venta: 850 },
            presentaciones: [
              { tipo: 'unidad', label: 'Unidad', unidad_medida: 'un', stock: 40, stock_minimo: 5, equivalencia_base: null, stock_modo: 'independiente' },
            ],
          },
        ],
      },
      {
        nombre: 'Azul',
        atributos: { color: { value: 'Azul', label: 'Azul', hex: '#2563eb' } },
        hijos: [
          {
            nombre: '50x70cm 180gr',
            atributos: {
              color: { value: 'Azul', label: 'Azul', hex: '#2563eb' },
              tamano: { ancho: 50, alto: 70, unidad: 'cm', label: '50x70 cm' },
              gramaje: { value: 180, unidad: 'gr' },
            },
            precio: { costo: 280, venta: 500 },
            presentaciones: [
              { tipo: 'unidad', label: 'Unidad', unidad_medida: 'un', stock: 60, stock_minimo: 10, equivalencia_base: null, stock_modo: 'independiente' },
            ],
          },
          {
            nombre: '50x70cm 240gr',
            atributos: {
              color: { value: 'Azul', label: 'Azul', hex: '#2563eb' },
              tamano: { ancho: 50, alto: 70, unidad: 'cm', label: '50x70 cm' },
              gramaje: { value: 240, unidad: 'gr' },
            },
            precio: { costo: 380, venta: 650 },
            presentaciones: [
              { tipo: 'unidad', label: 'Unidad', unidad_medida: 'un', stock: 35, stock_minimo: 5, equivalencia_base: null, stock_modo: 'independiente' },
            ],
          },
        ],
      },
      {
        nombre: 'Amarilla',
        atributos: { color: { value: 'Amarillo', label: 'Amarillo', hex: '#eab308' } },
        hijos: [
          {
            nombre: '50x70cm 180gr',
            atributos: {
              color: { value: 'Amarillo', label: 'Amarillo', hex: '#eab308' },
              tamano: { ancho: 50, alto: 70, unidad: 'cm', label: '50x70 cm' },
              gramaje: { value: 180, unidad: 'gr' },
            },
            precio: { costo: 280, venta: 500 },
            presentaciones: [
              { tipo: 'unidad', label: 'Unidad', unidad_medida: 'un', stock: 25, stock_minimo: 10, equivalencia_base: null, stock_modo: 'independiente' },
            ],
          },
        ],
      },
    ],
    descuentos: [
      // Descuento al producto madre: 10% en toda la cartulina
      { scope_type: 'product', tipo: 'porcentaje', valor: 10, etiqueta: 'Promo cartulinas', prioridad: 0, activo: true },
    ],
  },

  {
    nombre: 'Cinta Adhesiva',
    rubro: 'LIBRERÍA',
    categoria: 'Papelería',
    marca: 'Tapeware',
    descripcion: 'Cinta adhesiva transparente, vendida por rollo o por metro suelto.',
    atributos_definidos: [
      { key: 'ancho', label: 'Ancho', tipo: 'medida', unidad: 'mm' },
    ],
    raices: [
      {
        nombre: '12mm',
        atributos: { ancho: { value: 12, unidad: 'mm' } },
        precio: { costo: 800, venta: 1500 },
        presentaciones: [
          // 5 rollos enteros + 30 m sueltos del último rollo abierto
          { id: 'seed_b1_rollo', tipo: 'rollo', label: 'Rollo entero', unidad_medida: 'm', stock: 5, stock_minimo: 2, stock_sueltos: 30, stock_minimo_sueltos: 5, equivalencia_base: 50, stock_modo: 'independiente', precio_venta: 1500 },
          // Por metro: vinculada al rollo, precio auto = 1500/50 * 1.15 ≈ 34.50 (campo vacío = auto)
          { id: 'seed_b1_metro', tipo: 'metro', label: 'Por metro (corte)', unidad_medida: 'm', stock: 0, stock_minimo: 0, equivalencia_base: null, stock_modo: 'vinculado', vinculada_a: 'seed_b1_rollo' },
        ],
      },
      {
        nombre: '24mm',
        atributos: { ancho: { value: 24, unidad: 'mm' } },
        precio: { costo: 1200, venta: 2200 },
        presentaciones: [
          { id: 'seed_b2_rollo', tipo: 'rollo', label: 'Rollo entero', unidad_medida: 'm', stock: 3, stock_minimo: 2, stock_sueltos: 12, stock_minimo_sueltos: 5, equivalencia_base: 50, stock_modo: 'independiente', precio_venta: 2200 },
          { id: 'seed_b2_metro', tipo: 'metro', label: 'Por metro (corte)', unidad_medida: 'm', stock: 0, stock_minimo: 0, equivalencia_base: null, stock_modo: 'vinculado', vinculada_a: 'seed_b2_rollo' },
        ],
      },
    ],
  },

  {
    nombre: 'Marcador Permanente',
    rubro: 'LIBRERÍA',
    categoria: 'Escritura',
    marca: 'Sharpie',
    descripcion: 'Marcadores permanentes de punta media.',
    atributos_definidos: [
      { key: 'color', label: 'Color', tipo: 'color', unidad: '' },
    ],
    raices: [
      {
        nombre: 'Negro',
        atributos: { color: { value: 'Negro', label: 'Negro', hex: '#1c1e21' } },
        precio: { costo: 250, venta: 480 },
        presentaciones: [
          { tipo: 'unidad', label: 'Unidad', unidad_medida: 'un', stock: 60, stock_minimo: 12, equivalencia_base: null, stock_modo: 'independiente' },
          { tipo: 'pack',   label: 'Pack x4',  unidad_medida: 'un', stock: 8,  stock_minimo: 2,  equivalencia_base: 4, stock_modo: 'independiente', precio_venta: 1750 },
        ],
      },
      {
        nombre: 'Rojo',
        atributos: { color: { value: 'Rojo', label: 'Rojo', hex: '#dc2626' } },
        precio: { costo: 250, venta: 480 },
        presentaciones: [
          { tipo: 'unidad', label: 'Unidad', unidad_medida: 'un', stock: 40, stock_minimo: 10, equivalencia_base: null, stock_modo: 'independiente' },
          { tipo: 'pack',   label: 'Pack x4',  unidad_medida: 'un', stock: 6,  stock_minimo: 2,  equivalencia_base: 4, stock_modo: 'independiente', precio_venta: 1750 },
        ],
      },
      {
        nombre: 'Azul',
        atributos: { color: { value: 'Azul', label: 'Azul', hex: '#2563eb' } },
        precio: { costo: 250, venta: 480 },
        presentaciones: [
          { tipo: 'unidad', label: 'Unidad', unidad_medida: 'un', stock: 45, stock_minimo: 10, equivalencia_base: null, stock_modo: 'independiente' },
        ],
      },
      {
        nombre: 'Verde',
        atributos: { color: { value: 'Verde', label: 'Verde', hex: '#16a34a' } },
        precio: { costo: 250, venta: 480 },
        presentaciones: [
          { tipo: 'unidad', label: 'Unidad', unidad_medida: 'un', stock: 30, stock_minimo: 10, equivalencia_base: null, stock_modo: 'independiente' },
        ],
      },
    ],
    descuentos: [
      // Descuento por cantidad en el madre: 15% si lleva 5+ marcadores
      { scope_type: 'product', tipo: 'por_cantidad', valor: 15, cantidad_min: 5, etiqueta: 'Promo 5+ marcadores', prioridad: 0, activo: true },
    ],
  },
];

async function cargarSeed(db) {
  const cant = SEED_DATA.length;
  const ok = await confirmDialog({
    title: 'Cargar productos de ejemplo',
    message: `¿Cargar <strong>${cant} producto(s)</strong> de ejemplo?<br><br>Quedan marcados como <code>_seed</code> para borrarlos juntos después.`,
    confirmText: 'Cargar',
  });
  if (!ok) return;

  const btn = document.getElementById('lpBtnCargarSeed');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-icons" style="font-size:18px;animation:spin 1s linear infinite">refresh</span> Cargando...'; }

  try {
    for (const p of SEED_DATA) {
      // 1) Crear producto madre
      const codigo = generarCodigoBarras();
      const prodRef = await addDoc(collection(db, COL_PROD), {
        nombre: p.nombre,
        slug: slugify(p.nombre),
        codigo_barras: codigo,
        rubro: p.rubro || '',
        categoria: p.categoria || '',
        marca: p.marca || '',
        descripcion: p.descripcion || '',
        atributos_definidos: p.atributos_definidos || [],
        _seed: true,
        creado: serverTimestamp(),
        actualizado: serverTimestamp(),
      });
      await updateDoc(prodRef, { id: prodRef.id });

      // 2) Crear raíces y sus hijos recursivamente
      for (const raiz of (p.raices || [])) {
        await crearNodoSeed(db, prodRef.id, null, [prodRef.id], raiz);
      }

      // 3) Descuentos del producto
      for (const d of (p.descuentos || [])) {
        await addDoc(collection(db, COL_DISC), {
          ...d,
          product_id: prodRef.id,
          scope_id: prodRef.id,
          stackable: false,
          _seed: true,
          creado: serverTimestamp(),
        });
      }
    }

    invalidateCacheByPrefix('mp:');
    await alertDialog({
      title: 'Productos cargados',
      message: `Se cargaron <strong>${cant}</strong> productos de ejemplo correctamente.`,
      type: 'success',
    });
    await renderListaMadres(db);
  } catch (err) {
    await alertDialog({ title: 'Error cargando seed', message: err.message, type: 'error' });
  }
}

async function crearNodoSeed(db, productId, parentId, parentPath, nodoSpec) {
  const tieneHijos = Array.isArray(nodoSpec.hijos) && nodoSpec.hijos.length > 0;
  // Inyectar id en cada presentación (necesario para descuentos por presentación)
  const presentaciones = (nodoSpec.presentaciones || []).map(pp => ({
    ...pp,
    id: pp.id || nuevoIdLocal(),
    codigo_barras: pp.codigo_barras || generarCodigoBarras(),
    activo: pp.activo !== false,
  }));

  const ref = doc(collection(db, COL_NODES));
  const path = [...parentPath, ref.id];
  const nodoData = {
    id: ref.id,
    product_id: productId,
    parent_id:  parentId,
    nombre:     nodoSpec.nombre,
    sku_sufijo: nodoSpec.sku_sufijo || '',
    atributos:  nodoSpec.atributos || {},
    precio:     nodoSpec.precio || { costo: null, venta: null },
    presentaciones,
    hereda_de_padre: nodoSpec.hereda_de_padre || { categoria: true, marca: true, descripcion: true },
    overrides:  nodoSpec.overrides || {},
    es_hoja:    !tieneHijos,
    depth:      path.length - 2,
    path,
    _seed:      true,
    creado:     serverTimestamp(),
    actualizado: serverTimestamp(),
  };
  await setDoc(ref, nodoData);

  // Descuentos del nodo (si los trae)
  for (const d of (nodoSpec.descuentos || [])) {
    await addDoc(collection(db, COL_DISC), {
      ...d,
      product_id: productId,
      scope_type: 'node',
      scope_id:   ref.id,
      stackable:  false,
      _seed:      true,
      creado:     serverTimestamp(),
    });
  }

  // Recursión a hijos
  for (const h of (nodoSpec.hijos || [])) {
    await crearNodoSeed(db, productId, ref.id, path, h);
  }
}

async function borrarSeed(db) {
  const ok = await confirmDialog({
    title: 'Borrar productos de ejemplo',
    message: '¿Borrar <strong>TODOS</strong> los productos de ejemplo (marcados <code>_seed</code>)?<br><br>No afecta a los productos cargados a mano.',
    confirmText: 'Borrar todos',
    danger: true,
  });
  if (!ok) return;

  const btn = document.getElementById('lpBtnBorrarSeed');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-icons" style="font-size:16px;animation:spin 1s linear infinite">refresh</span> Borrando...'; }

  try {
    // Cada colección por separado
    const cols = [COL_PROD, COL_NODES, COL_DISC];
    let total = 0;
    for (const col of cols) {
      const snap = await getDocs(query(collection(db, col), where('_seed', '==', true)));
      const docs = snap.docs.slice();
      while (docs.length) {
        const chunk = docs.splice(0, 400);
        const batch = writeBatch(db);
        chunk.forEach(d => batch.delete(d.ref));
        await batch.commit();
        total += chunk.length;
      }
    }
    invalidateCacheByPrefix('mp:');
    await alertDialog({
      title: 'Seed eliminado',
      message: `Se eliminaron <strong>${total}</strong> documento(s) seed.`,
      type: 'success',
    });
    await renderListaMadres(db);
  } catch (err) {
    await alertDialog({ title: 'Error borrando seed', message: err.message, type: 'error' });
  }
}

// ── Modal: Stock ────────────────────────────────────────────────────────────
// Vista consolidada de stock por presentación de cada hoja del producto madre.
// Sincronizada en tiempo real con Firestore (onSnapshot) para que cuando el
// POS venda y descuente stock, esta vista se actualice automáticamente.
//
// Editar stock acá emite también un mp_stock_movements con motivo='ajuste_web'
// para que la auditoría quede unificada con las ventas del POS.
async function abrirModalStock(db, producto) {
  // Cleanup previo si existía
  document.querySelector('#lpStockModal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'lpStockModal';
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'display:flex';
  overlay.innerHTML = `
    <div class="modal" style="max-width:980px;width:100%;max-height:88vh;display:flex;flex-direction:column">
      <div class="modal-header" style="display:flex;align-items:center;gap:14px">
        <span class="material-icons" style="color:#047857;font-size:28px">inventory_2</span>
        <div style="flex:1">
          <h3 style="margin:0;font-size:17px;font-weight:700">Stock — ${escapeHtml(producto.nombre)}</h3>
          <p style="margin:2px 0 0;font-size:12px;color:var(--text-muted)">
            Cambios sincronizados en tiempo real con el POS. Cada ajuste queda registrado en <code>mp_stock_movements</code>.
          </p>
        </div>
        <button id="lpStockClose" type="button" style="background:transparent;border:none;cursor:pointer;font-size:24px;color:#64748b;line-height:1">×</button>
      </div>
      <div id="lpStockBody" style="overflow-y:auto;padding:16px 20px;flex:1">
        <div style="display:flex;align-items:center;justify-content:center;padding:60px 20px;color:var(--text-muted)">
          <span class="material-icons" style="animation:spin 1s linear infinite;margin-right:8px">refresh</span>
          Cargando stock...
        </div>
      </div>
      <div style="border-top:1px solid var(--border);padding:12px 20px;display:flex;justify-content:space-between;align-items:center;background:#f8fafc;gap:10px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted)">
          <span id="lpStockSyncDot" style="width:8px;height:8px;border-radius:50%;background:#16a34a;display:inline-block"></span>
          <span id="lpStockSyncTxt">Conectado · auto-actualizando</span>
        </div>
        <button type="button" id="lpStockCloseFooter" style="${estiloBtnSec()}">Cerrar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const usuarioActual = (window.__currentUser?.nombre || window.__currentUser?.email || 'web') + '';

  // Cache de stocks "snapshot" para detectar cambios y poder reportar deltas.
  // Key: `${nodeId}:${presentationId}`, value: { stock, stock_sueltos }
  let stockSnapshot = new Map();
  let nodosCache = [];

  // Subscribe en tiempo real a los mp_nodes del producto. Cuando POS venda
  // o cuando el usuario edite acá, se re-renderiza con valores frescos.
  const qNodes = query(collection(db, COL_NODES), where('product_id', '==', producto._id));
  const unsubscribe = onSnapshot(qNodes, snap => {
    nodosCache = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    rebuildSnapshot(nodosCache);
    pintarStock(nodosCache);
    pingSync();
  }, (err) => {
    document.getElementById('lpStockSyncDot').style.background = '#dc2626';
    document.getElementById('lpStockSyncTxt').textContent = 'Error de conexión: ' + err.message;
  });

  function rebuildSnapshot(nodos) {
    stockSnapshot = new Map();
    for (const n of nodos) {
      for (const p of (n.presentaciones || [])) {
        if (!p.id) continue;
        stockSnapshot.set(`${n._id}:${p.id}`, {
          stock: Number(p.stock) || 0,
          stock_sueltos: Number(p.stock_sueltos) || 0,
          stock_minimo: Number(p.stock_minimo) || 0,
          precio_venta: Number(p.precio_venta) || null,
        });
      }
    }
  }

  function pingSync() {
    const txt = document.getElementById('lpStockSyncTxt');
    const dot = document.getElementById('lpStockSyncDot');
    if (!txt || !dot) return;
    dot.style.background = '#16a34a';
    txt.textContent = `Sincronizado · ${new Date().toLocaleTimeString('es-AR')}`;
  }

  function pintarStock(nodos) {
    const body = document.getElementById('lpStockBody');
    if (!body) return;
    // Solo hojas (es_hoja=true) o nodos sin hijos cargados que tengan presentaciones.
    const hojas = nodos.filter(n => n.es_hoja !== false || (n.presentaciones || []).length > 0)
      .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));

    if (hojas.length === 0) {
      body.innerHTML = `
        <div style="text-align:center;padding:40px 20px;color:var(--text-muted)">
          <span class="material-icons" style="font-size:48px;color:#cbd5e1;display:block;margin-bottom:8px">inventory_2</span>
          Este producto madre todavía no tiene variantes (hojas) cargadas.<br>
          Abrí el árbol y agregá variantes para poder gestionar su stock.
        </div>`;
      return;
    }

    body.innerHTML = hojas.map(n => filaStockHoja(n)).join('');

    // Eventos: cada botón guardar / quitar / agregar
    body.querySelectorAll('[data-stock-save]').forEach(btn => {
      btn.onclick = () => guardarPresStock(db, producto, btn.dataset.nodeId, btn.dataset.presId, usuarioActual, stockSnapshot);
    });
    body.querySelectorAll('[data-stock-remove]').forEach(btn => {
      btn.onclick = () => quitarPresStock(db, producto, btn.dataset.nodeId, btn.dataset.presId);
    });
    body.querySelectorAll('[data-stock-add]').forEach(btn => {
      btn.onclick = () => agregarPresStock(db, producto, btn.dataset.nodeId);
    });
    // Enter en cualquier input dispara el guardar de su fila
    body.querySelectorAll('input[data-stock-input]').forEach(inp => {
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const row = inp.closest('[data-pres-row]');
          row?.querySelector('[data-stock-save]')?.click();
        }
      };
    });
  }

  function filaStockHoja(nodo) {
    const presentaciones = nodo.presentaciones || [];
    const presHtml = presentaciones.length > 0
      ? presentaciones.map(p => filaPresStock(nodo._id, p)).join('')
      : `<div style="padding:14px 16px;color:var(--text-muted);font-size:13px;font-style:italic">Sin presentaciones cargadas. Agregá una con el botón de la derecha.</div>`;
    return `
      <div style="background:white;border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:10px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:200px">
            <span class="material-icons" style="color:#7c3aed;font-size:18px">eco</span>
            <strong style="font-size:14px">${escapeHtml(nodo.nombre || '—')}</strong>
            ${(nodo.atributos && Object.keys(nodo.atributos).length)
              ? `<span style="font-size:11px;color:var(--text-muted)">${escapeHtml(_resumenAtributos(nodo.atributos))}</span>`
              : ''}
          </div>
          <button type="button" data-stock-add data-node-id="${nodo._id}"
            style="background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;border-radius:6px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:4px">
            <span class="material-icons" style="font-size:14px">add</span> Presentación
          </button>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${presHtml}
        </div>
      </div>`;
  }

  function filaPresStock(nodeId, p) {
    const stockBajo = (Number(p.stock) || 0) <= (Number(p.stock_minimo) || 0) && (Number(p.stock_minimo) || 0) > 0;
    const bgRow = stockBajo ? '#fef2f2' : '#fafaf7';
    const bordRow = stockBajo ? '#fecaca' : '#e5e7eb';
    const um = p.unidad_medida || '';
    const vinculadaInfo = (p.stock_modo === 'vinculado' && p.vinculada_a)
      ? `<div style="font-size:10px;color:#7c3aed;margin-top:2px;display:flex;align-items:center;gap:3px"><span class="material-icons" style="font-size:11px">link</span> Vinculada — su stock viene de la fuente</div>`
      : '';
    return `
      <div data-pres-row data-node-id="${nodeId}" data-pres-id="${escapeHtml(p.id || '')}"
        style="display:grid;grid-template-columns:minmax(120px,1.4fr) repeat(4,minmax(85px,1fr)) auto auto;gap:8px;align-items:center;background:${bgRow};border:1px solid ${bordRow};border-radius:8px;padding:8px 10px">
        <div>
          <div style="font-size:13px;font-weight:600;color:var(--text)">${escapeHtml(p.label || p.tipo || '—')}</div>
          <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(p.tipo || '')}${um ? ` · ${escapeHtml(um)}` : ''}</div>
          ${vinculadaInfo}
        </div>
        ${campoStockInput('stock',         'Stock',    p.stock,         p.stock_modo === 'vinculado')}
        ${campoStockInput('stock_sueltos', 'Sueltos',  p.stock_sueltos, false, true)}
        ${campoStockInput('stock_minimo',  'Mín.',     p.stock_minimo,  false)}
        ${campoStockInput('precio_venta',  'Precio',   p.precio_venta,  false, true)}
        <button type="button" data-stock-save data-node-id="${nodeId}" data-pres-id="${escapeHtml(p.id || '')}"
          title="Guardar cambios"
          style="background:var(--primary);color:white;border:none;border-radius:6px;width:36px;height:36px;cursor:pointer;display:flex;align-items:center;justify-content:center">
          <span class="material-icons" style="font-size:18px">save</span>
        </button>
        <button type="button" data-stock-remove data-node-id="${nodeId}" data-pres-id="${escapeHtml(p.id || '')}"
          title="Eliminar presentación"
          style="background:#fff0f0;border:1px solid #fca5a5;color:#dc3545;border-radius:6px;width:36px;height:36px;cursor:pointer;display:flex;align-items:center;justify-content:center">
          <span class="material-icons" style="font-size:18px">delete_outline</span>
        </button>
      </div>`;
  }

  function campoStockInput(field, label, value, disabled = false, allowDecimal = false) {
    const v = (value === null || value === undefined || value === '') ? '' : value;
    return `
      <label style="display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--text-muted);font-weight:600">
        ${label}
        <input data-stock-input data-field="${field}" type="number" ${allowDecimal ? 'step="0.01"' : 'step="1"'} value="${v}"
          ${disabled ? 'disabled title="Stock vinculado — se controla desde la fuente"' : ''}
          style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px;text-align:right;font-family:'Consolas','Menlo',monospace;${disabled ? 'background:#f1f5f9;color:#94a3b8' : 'background:white'}" />
      </label>`;
  }

  // Cierre y cleanup
  const cleanup = () => {
    unsubscribe();
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
  document.getElementById('lpStockClose').onclick = cleanup;
  document.getElementById('lpStockCloseFooter').onclick = cleanup;
  overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });
  document.addEventListener('keydown', onKey);
}

function _resumenAtributos(atributos) {
  // "color: Rojo · tamaño: 50x70 · gramaje: 180 gr"
  return Object.entries(atributos || {}).map(([k, v]) => {
    if (v && typeof v === 'object') {
      if ('hex' in v) return `${k}: ${v.label || v.value || ''}`;
      if ('ancho' in v && 'alto' in v) return `${k}: ${v.ancho}×${v.alto}${v.unidad ? ' ' + v.unidad : ''}`;
      return `${k}: ${v.label || v.value || ''}`;
    }
    return `${k}: ${v}`;
  }).filter(s => s.endsWith(': ') === false).join(' · ');
}

// ── Acciones del modal de stock ──────────────────────────────────────────────

async function guardarPresStock(db, producto, nodeId, presId, usuario, snapshot) {
  const row = document.querySelector(`[data-pres-row][data-node-id="${nodeId}"][data-pres-id="${presId}"]`);
  if (!row) return;
  const inputs = row.querySelectorAll('input[data-stock-input]');
  const cambios = {};
  inputs.forEach(inp => {
    const f = inp.dataset.field;
    const raw = inp.value.trim();
    cambios[f] = raw === '' ? null : Number(raw);
    if (Number.isNaN(cambios[f])) cambios[f] = null;
  });

  // Validaciones simples
  if (cambios.stock !== null && cambios.stock < 0) {
    return alertDialog({ title: 'Stock inválido', message: 'El stock no puede ser negativo.', type: 'warning' });
  }

  const btn = row.querySelector('[data-stock-save]');
  const ogHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="material-icons" style="font-size:16px;animation:spin 1s linear infinite">refresh</span>';

  try {
    // Releer el nodo desde Firestore para no pisar cambios concurrentes del POS.
    const ref = doc(db, COL_NODES, nodeId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error('El nodo ya no existe.');
    const nodo = snap.data();
    const presentaciones = (nodo.presentaciones || []).slice();
    const idx = presentaciones.findIndex(pp => (pp.id || '') === presId);
    if (idx < 0) throw new Error('La presentación ya no existe.');

    const prev = snapshot.get(`${nodeId}:${presId}`) || {};
    const presActualizada = {
      ...presentaciones[idx],
      stock:          cambios.stock          ?? presentaciones[idx].stock          ?? 0,
      stock_sueltos:  cambios.stock_sueltos  ?? presentaciones[idx].stock_sueltos  ?? 0,
      stock_minimo:   cambios.stock_minimo   ?? presentaciones[idx].stock_minimo   ?? 0,
      precio_venta:   cambios.precio_venta   ?? presentaciones[idx].precio_venta   ?? null,
    };
    presentaciones[idx] = presActualizada;

    await updateDoc(ref, { presentaciones, actualizado: serverTimestamp() });

    // Audit: si cambió stock o stock_sueltos, registrar el delta exacto en
    // mp_stock_movements (mismo formato que escribe el POS al vender).
    const deltaStock   = (Number(presActualizada.stock)         || 0) - (Number(prev.stock)         || 0);
    const deltaSueltos = (Number(presActualizada.stock_sueltos) || 0) - (Number(prev.stock_sueltos) || 0);
    if (deltaStock !== 0 || deltaSueltos !== 0) {
      try {
        await addDoc(collection(db, 'mp_stock_movements'), {
          product_id:      producto._id,
          node_id:         nodeId,
          presentation_id: presId,
          delta:           deltaStock,            // contenedor (rollos/packs/unidades)
          delta_sueltos:   deltaSueltos,          // sueltos (metros, gramos…)
          motivo:          'ajuste_web',
          usuario,
          ts:              serverTimestamp(),
        });
      } catch (e) { /* no bloquear el guardado por la auditoría */ }
    }

    // Feedback visual
    btn.innerHTML = '<span class="material-icons" style="font-size:18px;color:#16a34a">check</span>';
    setTimeout(() => { btn.innerHTML = ogHtml; btn.disabled = false; }, 700);
    invalidateCacheByPrefix('mp:');
  } catch (err) {
    btn.innerHTML = ogHtml;
    btn.disabled = false;
    await alertDialog({ title: 'Error guardando stock', message: err.message, type: 'error' });
  }
}

async function quitarPresStock(db, producto, nodeId, presId) {
  const ref = doc(db, COL_NODES, nodeId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const nodo = snap.data();
  const pres = (nodo.presentaciones || []).find(pp => (pp.id || '') === presId);
  const lbl = pres?.label || pres?.tipo || 'esta presentación';

  const ok = await confirmDialog({
    title: 'Eliminar presentación',
    message: `¿Eliminar la presentación <strong>"${lbl}"</strong> de <strong>"${nodo.nombre}"</strong>?<br><br>Se va a perder el stock cargado y la auditoría futura referenciará un id que ya no existe.`,
    confirmText: 'Eliminar',
    danger: true,
  });
  if (!ok) return;

  try {
    const presentaciones = (nodo.presentaciones || []).filter(pp => (pp.id || '') !== presId);
    await updateDoc(ref, { presentaciones, actualizado: serverTimestamp() });
    invalidateCacheByPrefix('mp:');
    // No hace falta repintar — onSnapshot lo refresca automáticamente.
  } catch (err) {
    await alertDialog({ title: 'Error al eliminar', message: err.message, type: 'error' });
  }
}

async function agregarPresStock(db, producto, nodeId) {
  const tipo = await promptDialog({
    title: 'Nueva presentación',
    message: 'Tipo (ej: <em>unidad</em>, <em>pack</em>, <em>caja</em>, <em>rollo</em>, <em>metro</em>):',
    placeholder: 'unidad',
    defaultValue: 'unidad',
  });
  if (tipo === null) return;
  const tipoNorm = tipo.trim().toLowerCase() || 'unidad';

  const label = await promptDialog({
    title: 'Etiqueta visible',
    message: 'Texto que ve el cajero (ej: <em>Pack x4</em>, <em>Por metro</em>):',
    placeholder: 'Unidad',
    defaultValue: tipoNorm.charAt(0).toUpperCase() + tipoNorm.slice(1),
  });
  if (label === null) return;

  try {
    const ref = doc(db, COL_NODES, nodeId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error('El nodo ya no existe.');
    const nodo = snap.data();
    const nueva = {
      id:              nuevoIdLocal(),
      tipo:            tipoNorm,
      label:           label.trim() || tipoNorm,
      codigo_barras:   generarCodigoBarras(),
      unidad_medida:   tipoNorm === 'unidad' || tipoNorm === 'pack' || tipoNorm === 'caja' ? 'un' : '',
      stock:           0,
      stock_sueltos:   0,
      stock_minimo:    0,
      equivalencia_base: null,
      stock_modo:      'independiente',
      vinculada_a:     null,
      precio_venta:    null,
      precio_costo:    null,
      activo:          true,
    };
    const presentaciones = [...(nodo.presentaciones || []), nueva];
    await updateDoc(ref, { presentaciones, actualizado: serverTimestamp() });
    invalidateCacheByPrefix('mp:');
  } catch (err) {
    await alertDialog({ title: 'Error al agregar presentación', message: err.message, type: 'error' });
  }
}
