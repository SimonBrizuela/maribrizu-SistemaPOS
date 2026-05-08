/**
 * LAB · Productos Madre — UI simplificada
 * ──────────────────────────────────────────────────────────────────────────────
 * Dos niveles fijos visibles:
 *    Categoría  (mp_products)         ← agrupa
 *    Variante   (mp_nodes, raíz)      ← se vende
 *
 * El modelo Firestore se mantiene compatible con el POS PyQt:
 *   - nodos creados desde acá: parent_id=null, depth=0, es_hoja=true,
 *     path=[product_id, node_id], hereda_de_padre={categoria,marca,descripcion:true}
 *   - nodos legacy con parent_id≠null o depth>0 se siguen viendo y editando.
 *
 * Colecciones:
 *   mp_products         categoría / producto madre
 *   mp_nodes            variantes (raíces y, legacy, sub-niveles)
 *   mp_discounts        descuentos heredables (override puro)
 *   mp_stock_movements  auditoría de stock
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

// Margen extra al vender por unidad/metro fraccionado de un contenedor.
// Mismo valor que el POS (`pos_system/ui/conjunto_dialog.py:FRACCION_MARGIN`).
const FRACCION_MARGIN = 1.15;

const TIPOS_DESCUENTO = [
  { value: 'porcentaje',   label: '% Porcentaje',     hint: 'Aplica un porcentaje sobre el precio (ej: 10%)' },
  { value: 'monto_fijo',   label: '$ Monto fijo',     hint: 'Resta un monto fijo al precio (ej: $50)' },
  { value: 'por_cantidad', label: '% por cantidad',   hint: 'Aplica un % cuando la cantidad vendida supera el mínimo' },
  { value: 'por_fecha',    label: '% por fecha',      hint: 'Aplica un % solo dentro de un rango de fechas' },
];

// Características posibles. La UI usa solo el subset "popular" como chips
// rápidos; el resto queda accesible en "Más" para no abrumar.
const TIPOS_ATRIBUTO = [
  { value: 'color',    label: 'Color',    icon: 'palette',        ejemplo: 'Rojo · Azul · Verde',  popular: true },
  { value: 'tamano',   label: 'Tamaño',   icon: 'aspect_ratio',   ejemplo: '50×70 cm',             popular: true },
  { value: 'gramaje',  label: 'Gramaje',  icon: 'fitness_center', ejemplo: '180 gr · 240 gr',      popular: true },
  { value: 'medida',   label: 'Medida',   icon: 'straighten',     ejemplo: '12 mm · 50 cm',        popular: true },
  { value: 'numero',   label: 'Número',   icon: 'tag',            ejemplo: 'HB · 2H · 4B',         popular: false },
  { value: 'material', label: 'Material', icon: 'category',       ejemplo: 'Algodón · Plástico',   popular: false },
  { value: 'marca',    label: 'Marca',    icon: 'sell',           ejemplo: 'Bic · Faber-Castell',  popular: false },
  { value: 'texto',    label: 'Texto',    icon: 'text_fields',    ejemplo: 'libre',                popular: false },
];

const UNIDADES_MEDIDA = ['cm', 'mm', 'm', 'pulg'];

// Tipos de presentación (cómo se vende). Cada uno con un ícono y si pide
// "contenido" (cuánto contiene un pack/caja/rollo).
const TIPOS_PRESENTACION = [
  { value: 'unidad', label: 'Unidad',  icon: 'package_2',       unidadBase: 'un', wantsContent: false, hint: 'Una pieza individual' },
  { value: 'pack',   label: 'Pack',    icon: 'inventory',        unidadBase: 'un', wantsContent: true,  hint: 'Conjunto de varias unidades' },
  { value: 'caja',   label: 'Caja',    icon: 'inventory_2',      unidadBase: 'un', wantsContent: true,  hint: 'Caja con varias unidades' },
  { value: 'rollo',  label: 'Rollo',   icon: 'all_inclusive',    unidadBase: 'm',  wantsContent: true,  hint: 'Rollo de N metros (se puede cortar)' },
  { value: 'metro',  label: 'Metro',   icon: 'straighten',       unidadBase: 'm',  wantsContent: false, hint: 'Por metro suelto (corte de rollo)' },
  { value: 'cm',     label: 'Cm',      icon: 'square_foot',      unidadBase: 'cm', wantsContent: false, hint: 'Por centímetro' },
  { value: 'kg',     label: 'Kilo',    icon: 'scale',            unidadBase: 'kg', wantsContent: false, hint: 'Por kilo' },
  { value: 'gramo',  label: 'Gramo',   icon: 'monitor_weight',   unidadBase: 'g',  wantsContent: false, hint: 'Por gramo' },
  { value: 'custom', label: 'Otro',    icon: 'tune',             unidadBase: '',   wantsContent: false, hint: 'Definí tu unidad' },
];

const STOCK_MODOS = [
  { value: 'independiente', label: 'Independiente (contador propio)' },
  { value: 'vinculado',     label: 'Vinculado (descuenta de otra)' },
];

// Default rubros — mismo set que el catálogo regular.
const RUBROS_DEFAULT = [
  'LIBRERÍA','MERCERÍA','JUGUETERÍA','ARTÍSTICA','COTILLÓN','INFORMÁTICA','TELGOPOR',
  'ACCESORIOS','LENCERIA','NAVIDAD','PAPELERA','PERFUMERIA','REGALERIA','SELLOS','SERVICIOS',
];

// Estado en memoria (vida = sesión)
let _state = {
  productos: [],
  nodes: [],
  descuentos: [],
  productoActivo: null,
  rubros: [...RUBROS_DEFAULT],
};

// ── Datos de ejemplo (seed) ─────────────────────────────────────────────────
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
        nombre: 'Roja 50x70 180gr',
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
        nombre: 'Roja 70x100 180gr',
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
      {
        nombre: 'Azul 50x70 180gr',
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
        nombre: 'Amarilla 50x70 180gr',
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
    descuentos: [
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
          { id: 'seed_b1_rollo', tipo: 'rollo', label: 'Rollo entero', unidad_medida: 'm', stock: 5, stock_minimo: 2, stock_sueltos: 30, stock_minimo_sueltos: 5, equivalencia_base: 50, stock_modo: 'independiente', precio_venta: 1500 },
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
      { scope_type: 'product', tipo: 'por_cantidad', valor: 15, cantidad_min: 5, etiqueta: 'Promo 5+ marcadores', prioridad: 0, activo: true },
    ],
  },
];

// ── Helpers genéricos ────────────────────────────────────────────────────────
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
  return 'tmp_' + Math.random().toString(36).slice(2, 10);
}

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

function fmtMoney(v) {
  return `$${Number(v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function _resumenAtributos(atributos) {
  return Object.entries(atributos || {}).map(([k, v]) => {
    if (v && typeof v === 'object') {
      if ('hex' in v)                  return v.label || v.value || '';
      if ('ancho' in v && 'alto' in v) return `${v.ancho}×${v.alto}${v.unidad ? ' ' + v.unidad : ''}`;
      const val = v.label || v.value || '';
      return v.unidad ? `${val} ${v.unidad}` : val;
    }
    return v;
  }).filter(Boolean).join(' · ');
}

async function cargarRubros(db) {
  try {
    const snap = await getDoc(doc(db, 'config', 'rubros'));
    if (snap.exists() && Array.isArray(snap.data().lista) && snap.data().lista.length) {
      _state.rubros = snap.data().lista.slice();
    }
  } catch (e) { /* mantiene defaults */ }
}

// ── Estilos compartidos ──────────────────────────────────────────────────────
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
function seccionTitulo(txt, hint = '') {
  return `
    <div style="display:flex;align-items:center;gap:6px;margin:0 0 6px;padding:0 0 4px;border-bottom:1px dashed #fde68a">
      <span style="font-size:10px;font-weight:800;letter-spacing:0.7px;color:#78350f;text-transform:uppercase">${escapeHtml(txt)}</span>
      ${hint ? `<span title="${escapeHtml(hint)}" style="opacity:0.45;font-size:11px;cursor:help">ⓘ</span>` : ''}
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────
export async function renderLabProductos(container, db) {
  container.innerHTML = `
    <div style="max-width:1100px;margin:0 auto;padding:8px">
      <div id="labRoot"></div>
    </div>

    <!-- Modal: Categoría -->
    <div id="lpCatModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto">
      <div style="background:white;border-radius:16px;padding:24px;width:100%;max-width:560px;box-shadow:0 20px 60px rgba(0,0,0,0.3);margin:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
          <h3 id="lpCatTitulo" style="margin:0;font-size:20px;font-weight:700">Nueva categoría</h3>
          <button data-close="cat" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:28px;line-height:1;padding:0">&times;</button>
        </div>
        <form id="lpCatForm" style="display:flex;flex-direction:column;gap:14px">
          <input type="hidden" id="lpCatId" />
          <div>
            <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">Nombre de la categoría *</label>
            <input id="lpCatNombre" type="text" placeholder="Ej: Cartulina Escolar" required
              style="${estiloInput()};font-size:17px;padding:14px 14px;font-weight:600" />
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            ${campoLabel('Rubro', '<select id="lpCatRubro" style="' + estiloInput() + '"><option value="">— Sin rubro —</option></select>')}
            ${campoLabel('Marca (opcional)', '<input id="lpCatMarca" type="text" placeholder="Ej: Muresco" style="' + estiloInput() + '" />')}
          </div>

          <details id="lpCatDetalles" style="background:#f8f9fa;border:1px solid var(--border);border-radius:10px">
            <summary style="padding:11px 14px;cursor:pointer;font-size:13px;color:#495057;font-weight:600;list-style:none;display:flex;align-items:center;gap:8px">
              <span class="material-icons" style="font-size:16px;color:#9ca3af">tune</span>
              Más detalles (opcional)
            </summary>
            <div style="padding:0 14px 14px;display:flex;flex-direction:column;gap:10px">
              ${campoLabel('Categoría / sub-rubro', '<input id="lpCatCategoria" type="text" placeholder="Ej: Papelería" style="' + estiloInput() + '" />')}
              ${campoLabel('Descripción', '<textarea id="lpCatDescripcion" rows="2" placeholder="Texto libre" style="' + estiloInput() + ';resize:vertical;font-family:inherit"></textarea>')}
              <div>
                <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">Código de barras (auto)</label>
                <div style="display:flex;gap:6px">
                  <input id="lpCatCodigo" type="text" style="${estiloInput()};flex:1;font-family:'Courier New',monospace" />
                  <button type="button" id="lpCatCodigoReGen" title="Regenerar"
                    style="background:white;border:1.5px solid var(--border);border-radius:8px;padding:0 14px;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit">↻</button>
                </div>
                <p style="margin:5px 0 0;font-size:11px;color:var(--text-muted)">EAN-8 (8 dígitos). Editable si querés escanear uno real.</p>
              </div>
            </div>
          </details>

          <details style="background:#faf5ff;border:1px solid #ddd6fe;border-radius:10px">
            <summary style="padding:11px 14px;cursor:pointer;font-size:13px;color:#5b21b6;font-weight:700;list-style:none;display:flex;align-items:center;gap:8px">
              <span class="material-icons" style="font-size:16px">local_offer</span>
              Descuentos (opcional)
              <span style="margin-left:auto;font-weight:500;font-size:11px;color:#7c3aed">aplican a toda la categoría</span>
            </summary>
            <div style="padding:0 14px 14px;display:flex;flex-direction:column;gap:8px">
              <button type="button" id="lpCatAddDisc" style="background:white;border:1px dashed #ddd6fe;color:#5b21b6;border-radius:8px;padding:8px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit">+ Agregar descuento</button>
              <div id="lpCatDescuentos" style="display:flex;flex-direction:column;gap:8px"></div>
            </div>
          </details>

          <div id="lpCatError" style="display:none;color:#dc3545;font-size:13px;padding:8px 12px;background:#fff0f0;border-radius:6px"></div>

          <div style="display:flex;gap:10px;margin-top:4px">
            <button type="button" data-close="cat" style="${estiloBtnSec()}">Cancelar</button>
            <button type="submit" id="lpCatGuardar" style="${estiloBtnPri()}">Guardar categoría</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Modal: Variante -->
    <div id="lpVarModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto">
      <div style="background:white;border-radius:16px;padding:24px;width:100%;max-width:720px;box-shadow:0 20px 60px rgba(0,0,0,0.3);margin:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <h3 id="lpVarTitulo" style="margin:0;font-size:20px;font-weight:700">Nueva variante</h3>
          <button data-close="var" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:28px;line-height:1;padding:0">&times;</button>
        </div>
        <p id="lpVarBreadcrumb" style="margin:0 0 14px;font-size:12px;color:var(--text-muted)"></p>

        <div id="lpVarLegacyHint" style="display:none;align-items:flex-start;gap:8px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:9px 12px;margin-bottom:12px;font-size:12px;color:#92400e;line-height:1.4"></div>

        <form id="lpVarForm" style="display:flex;flex-direction:column;gap:14px">
          <input type="hidden" id="lpVarId" />
          <input type="hidden" id="lpVarParentId" />

          <div>
            <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">Nombre de la variante *</label>
            <input id="lpVarNombre" type="text" placeholder="Ej: Roja 50x70 180gr" required
              style="${estiloInput()};font-size:16px;padding:12px 14px;font-weight:600" />
            <button type="button" id="lpVarNombreSugerido" style="display:none;margin-top:6px;background:#f0fdf4;border:1px dashed #86efac;color:#166534;border-radius:8px;padding:7px 11px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;align-items:center;gap:6px;width:100%;text-align:left">
              <span class="material-icons" style="font-size:15px">auto_awesome</span>
              <span>Usar <strong id="lpVarNombreSugeridoTxt"></strong></span>
            </button>
          </div>

          <!-- 1) Características -->
          <div style="background:#fdf4ff;border:1px solid #f5d0fe;border-radius:10px;padding:12px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <div style="font-size:12px;font-weight:800;color:#86198f;letter-spacing:0.4px;text-transform:uppercase;display:flex;align-items:center;gap:6px">
                <span class="material-icons" style="font-size:16px">style</span> Características
              </div>
              <button type="button" id="lpVarAddAttr" style="background:white;border:1px solid #f5d0fe;color:#86198f;border-radius:6px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:4px">
                <span class="material-icons" style="font-size:14px">add</span> Agregar
              </button>
            </div>
            <div id="lpVarAttrs" style="display:flex;flex-direction:column;gap:8px"></div>
            <p id="lpVarAttrsEmpty" style="margin:8px 0 0;font-size:11.5px;color:#9333ea;font-style:italic">
              Agregá Color, Tamaño, Gramaje, etc. para describir esta variante. Es opcional.
            </p>
          </div>

          <!-- 2) Precio -->
          <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:12px">
            <div style="font-size:12px;font-weight:800;color:#0369a1;letter-spacing:0.4px;text-transform:uppercase;margin-bottom:8px;display:flex;align-items:center;gap:6px">
              <span class="material-icons" style="font-size:16px">payments</span> Precio
            </div>
            <div style="display:grid;grid-template-columns:1fr 90px 1fr auto;gap:8px;align-items:end">
              <div>
                <label style="font-size:11px;font-weight:600;color:#0369a1;display:block;margin-bottom:3px">Costo</label>
                <input id="lpVarPrecioCosto" type="number" step="0.01" min="0" placeholder="0.00" style="${estiloInput()};padding:9px 11px" />
              </div>
              <div>
                <label style="font-size:11px;font-weight:600;color:#7b3fa6;display:block;margin-bottom:3px">% Margen</label>
                <input id="lpVarPrecioMargen" type="number" step="1" min="0" placeholder="80" style="${estiloInput()};padding:9px 11px;color:#7b3fa6;font-weight:700" />
              </div>
              <div>
                <label style="font-size:11px;font-weight:600;color:#0369a1;display:block;margin-bottom:3px">Venta *</label>
                <input id="lpVarPrecioVenta" type="number" step="0.01" min="0" placeholder="0.00" style="${estiloInput()};padding:9px 11px;font-weight:700;color:#0369a1" />
              </div>
              <button type="button" id="lpVarPrecioRedondeo" title="Redondear venta al centenar"
                style="height:38px;background:white;border:1.5px solid #bae6fd;color:#0369a1;border-radius:8px;padding:0 10px;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:700;display:flex;align-items:center;gap:3px">↗ 100</button>
            </div>
          </div>

          <!-- 3) Cómo se vende (presentaciones) -->
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <div style="font-size:12px;font-weight:800;color:#92400e;letter-spacing:0.4px;text-transform:uppercase;display:flex;align-items:center;gap:6px">
                <span class="material-icons" style="font-size:16px">storefront</span> Cómo se vende
              </div>
              <button type="button" id="lpVarAddPres" style="background:white;border:1px solid #fde68a;color:#92400e;border-radius:6px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:4px">
                <span class="material-icons" style="font-size:14px">add</span> Otra forma
              </button>
            </div>
            <p style="margin:0 0 8px;font-size:11.5px;color:#a16207">
              Cada forma lleva su propio stock y precio. Ej: <strong>rollo</strong> + <strong>por metro</strong>.
            </p>
            <div id="lpVarPresentaciones" style="display:flex;flex-direction:column;gap:10px"></div>
          </div>

          <!-- 4) Avanzado -->
          <details style="background:#f8f9fa;border:1px solid var(--border);border-radius:10px">
            <summary style="padding:11px 14px;cursor:pointer;font-size:13px;color:#495057;font-weight:600;list-style:none;display:flex;align-items:center;gap:8px">
              <span class="material-icons" style="font-size:16px;color:#9ca3af">tune</span>
              Avanzado · descuentos · SKU
            </summary>
            <div style="padding:0 14px 14px;display:flex;flex-direction:column;gap:10px">
              <div>
                <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">SKU sufijo (opcional)</label>
                <input id="lpVarSku" type="text" placeholder="Ej: ROJ-50 (interno)" style="${estiloInput()}" />
              </div>
              <div style="background:#faf5ff;border:1px solid #ddd6fe;border-radius:8px;padding:10px 12px">
                <label style="font-size:12.5px;font-weight:700;color:#5b21b6;display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
                  <span style="display:flex;align-items:center;gap:6px"><span class="material-icons" style="font-size:14px">local_offer</span> Descuentos solo de esta variante</span>
                  <button type="button" id="lpVarAddDisc" style="background:white;border:1px solid #ddd6fe;color:#5b21b6;border-radius:6px;padding:3px 8px;font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit">+ Agregar</button>
                </label>
                <p style="margin:0 0 6px;font-size:11px;color:var(--text-muted)">
                  Si hay descuento más específico (en una presentación) gana ese; si no, sube hacia la categoría.
                </p>
                <div id="lpVarDescuentos" style="display:flex;flex-direction:column;gap:8px"></div>
              </div>
            </div>
          </details>

          <div id="lpVarError" style="display:none;color:#dc3545;font-size:13px;padding:8px 12px;background:#fff0f0;border-radius:6px"></div>

          <div style="display:flex;gap:10px;margin-top:4px">
            <button type="button" data-close="var" style="${estiloBtnSec()}">Cancelar</button>
            <button type="submit" id="lpVarGuardar" style="${estiloBtnPri()}">Guardar variante</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Modal: Modo rápido (lote) -->
    <div id="lpLoteModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto">
      <div style="background:white;border-radius:16px;padding:24px;width:100%;max-width:600px;box-shadow:0 20px 60px rgba(0,0,0,0.3);margin:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <h3 style="margin:0;font-size:20px;font-weight:800;display:flex;align-items:center;gap:8px">
            <span class="material-icons" style="color:#16a34a">bolt</span> Crear varias rápido
          </h3>
          <button data-close="lote" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:28px;line-height:1;padding:0">&times;</button>
        </div>
        <p id="lpLoteBreadcrumb" style="margin:0 0 16px;font-size:12px;color:var(--text-muted)"></p>

        <form id="lpLoteForm" style="display:flex;flex-direction:column;gap:14px">
          <!-- 1) Característica que cambia -->
          <div id="lpLoteCharSection">
            <label style="font-size:12px;font-weight:800;color:#86198f;letter-spacing:0.4px;text-transform:uppercase;display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span>¿En qué se diferencian?</span>
              <span id="lpLoteCharOptional" style="display:none;background:#f0fdf4;color:#15803d;border:1px solid #86efac;border-radius:6px;padding:1px 7px;font-size:9.5px;font-weight:600;letter-spacing:0.3px">solo 1 variante · opcional</span>
            </label>
            <div id="lpLoteCharChips" style="display:flex;gap:6px;flex-wrap:wrap"></div>
            <input id="lpLoteCharCustom" type="text" placeholder="Nombre del tipo (Ej: Talle, Sabor, Modelo)"
              style="${estiloInput()};margin-top:8px;font-size:13px;padding:8px 11px;display:none" />
            <p id="lpLoteCharCustomHint" style="display:none;margin:5px 2px 0;font-size:11.5px;color:#86198f;font-style:italic">
              ¿Qué tipo de cosa cambia entre las variantes? (no el valor)
            </p>
          </div>

          <!-- 2) Valores (uno por línea o coma) -->
          <div>
            <label style="font-size:12px;font-weight:800;color:#86198f;letter-spacing:0.4px;text-transform:uppercase;display:block;margin-bottom:4px">Valores</label>
            <textarea id="lpLoteValores" rows="3" placeholder="Azul, Amarillo, Naranja&#10;(uno por línea o separados por coma)"
              style="${estiloInput()};font-size:14px;padding:10px 12px;resize:vertical;font-family:inherit"></textarea>
            <p id="lpLoteCount" style="margin:5px 0 0;font-size:11.5px;color:var(--text-muted)">0 variantes</p>
          </div>

          <!-- 3) Cómo se venden (chips) -->
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px">
            <label style="font-size:12px;font-weight:800;color:#92400e;letter-spacing:0.4px;text-transform:uppercase;display:block;margin-bottom:8px">¿Cómo se venden?</label>
            <div id="lpLoteTipoChips" style="display:flex;gap:6px;flex-wrap:wrap"></div>

            <!-- Cuando es pack/caja/rollo: pide "trae" -->
            <div id="lpLoteEquivWrap" style="display:none;margin-top:10px">
              <label id="lpLoteEquivLabel" style="font-size:11px;font-weight:700;color:#92400e;display:block;margin-bottom:3px">Cada uno trae</label>
              <div style="display:grid;grid-template-columns:1fr 80px;gap:6px">
                <input id="lpLoteEquiv" type="number" step="any" min="0" placeholder="ej: 15" style="${estiloInput()};padding:9px 11px" />
                <input id="lpLoteEquivUnidad" type="text" placeholder="m / un" style="${estiloInput()};padding:9px 11px" />
              </div>
            </div>

            <!-- Costo · margen · venta del rollo/pack/unidad -->
            <div style="margin-top:10px">
              <div style="display:grid;grid-template-columns:1fr 80px 1fr auto;gap:6px;align-items:end">
                <div>
                  <label style="font-size:11px;font-weight:700;color:#92400e;display:block;margin-bottom:3px">Costo (opcional)</label>
                  <input id="lpLoteCosto" type="number" step="0.01" min="0" placeholder="0.00" style="${estiloInput()};padding:9px 11px" />
                </div>
                <div>
                  <label style="font-size:11px;font-weight:700;color:#7b3fa6;display:block;margin-bottom:3px">% Margen</label>
                  <input id="lpLoteMargen" type="number" step="1" min="0" placeholder="80" style="${estiloInput()};padding:9px 11px;color:#7b3fa6;font-weight:700" />
                </div>
                <div>
                  <label id="lpLotePrecioLabel" style="font-size:11px;font-weight:700;color:#92400e;display:block;margin-bottom:3px">Precio venta</label>
                  <input id="lpLotePrecio" type="number" step="0.01" min="0" placeholder="0.00" style="${estiloInput()};padding:9px 11px;font-weight:700" />
                </div>
                <button type="button" id="lpLotePrecioRedondeo" title="Redondear al centenar"
                  style="height:38px;background:white;border:1.5px solid #fde68a;color:#a16207;border-radius:8px;padding:0 10px;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:700;display:flex;align-items:center">↗ 100</button>
              </div>
              <p style="margin:5px 2px 0;font-size:11px;color:#a16207;font-style:italic">Cargá costo + margen → la venta se calcula sola. O pone la venta directo.</p>
            </div>

            <!-- Stock (común a todas, con override individual cuando hay >=2 valores) -->
            <div style="margin-top:10px">
              <label style="font-size:11px;font-weight:700;color:#92400e;display:block;margin-bottom:3px">Stock por defecto (opcional)</label>
              <input id="lpLoteStock" type="number" step="any" min="0" placeholder="0" style="${estiloInput()};padding:9px 11px" />
              <p style="margin:4px 2px 0;font-size:11px;color:#a16207;font-style:italic">Se aplica a todas. Si querés cargar uno distinto a alguna, usá la lista de abajo.</p>
            </div>
            <!-- Override individual: una fila por variante -->
            <div id="lpLoteStockIndivWrap" style="display:none;margin-top:8px;background:white;border:1px dashed #fde68a;border-radius:8px;padding:8px 10px">
              <div style="font-size:11px;font-weight:700;color:#92400e;letter-spacing:0.3px;text-transform:uppercase;margin-bottom:6px">Stock individual</div>
              <div id="lpLoteStockIndivLista" style="display:flex;flex-direction:column;gap:4px;max-height:160px;overflow-y:auto"></div>
            </div>

            <!-- Pack/Caja/Rollo: checkbox para auto-crear la complementaria -->
            <div id="lpLoteAutoMetroWrap" style="display:none;margin-top:12px;background:white;border:1px solid #fde68a;border-radius:8px;padding:10px">
              <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
                <input id="lpLoteAutoMetro" type="checkbox" checked style="margin-top:3px" />
                <div style="flex:1;font-size:12.5px;color:#78350f">
                  <strong id="lpLoteAutoMetroTitle" style="display:block;margin-bottom:2px">Vender también suelto</strong>
                  <span id="lpLoteAutoMetroHint" style="font-size:11.5px;color:#a16207"></span>
                </div>
              </label>
              <div id="lpLoteAutoPrecioWrap" style="margin-top:9px;padding-top:9px;border-top:1px dashed #fde68a">
                <label id="lpLoteAutoPrecioLabel" style="font-size:11px;font-weight:700;color:#92400e;display:block;margin-bottom:3px">Precio por unidad (vacío = auto)</label>
                <div style="display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center">
                  <input id="lpLoteAutoPrecio" type="number" step="0.01" min="0" placeholder="auto: $—" style="${estiloInput()};padding:8px 10px;font-size:13px" />
                  <button type="button" id="lpLoteAutoPrecioRedondeo" title="Redondear al centenar"
                    style="height:36px;background:white;border:1.5px solid #fde68a;color:#a16207;border-radius:8px;padding:0 10px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700">↗ 100</button>
                </div>
              </div>
            </div>
          </div>

          <div id="lpLoteError" style="display:none;color:#dc3545;font-size:13px;padding:8px 12px;background:#fff0f0;border-radius:6px"></div>

          <div style="display:flex;gap:10px;margin-top:4px">
            <button type="button" data-close="lote" style="${estiloBtnSec()}">Cancelar</button>
            <button type="submit" id="lpLoteCrear" style="${estiloBtnPri()};background:#16a34a">
              <span id="lpLoteCrearTxt">Crear variantes</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  setupGlobalEvents(db);
  await Promise.all([cargarRubros(db), renderListaCategorias(db)]);
}

// ─────────────────────────────────────────────────────────────────────────────
// PANTALLA 1 · LISTA DE CATEGORÍAS
// ─────────────────────────────────────────────────────────────────────────────
async function renderListaCategorias(db) {
  _state.productoActivo = null;
  const root = document.getElementById('labRoot');
  if (!root) return;

  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
      <div>
        <h2 style="margin:0;font-size:22px;font-weight:800">Categorías</h2>
        <p style="margin:4px 0 0;color:var(--text-muted);font-size:13px">
          Tocá una categoría para ver y editar sus variantes (colores, tamaños, packs, rollos…).
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
        <button id="lpBtnNuevaCat" style="
          background:var(--primary);color:white;border:none;border-radius:8px;
          padding:11px 18px;font-size:14px;font-weight:700;cursor:pointer;
          display:flex;align-items:center;gap:6px;font-family:inherit
        ">
          <span class="material-icons" style="font-size:18px">add</span> Nueva categoría
        </button>
      </div>
    </div>

    <div style="margin-bottom:14px;position:relative">
      <span class="material-icons" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:20px">search</span>
      <input id="lpBuscarCats" type="text" placeholder="Buscar por nombre, rubro o marca..."
        style="width:100%;box-sizing:border-box;padding:11px 12px 11px 40px;border:1.5px solid var(--border);border-radius:10px;font-size:14px;font-family:inherit;background:var(--card-bg)" />
    </div>

    <div id="lpListaCats" style="display:flex;flex-direction:column;gap:10px">
      <div style="text-align:center;padding:40px;color:var(--text-muted)">
        <span class="material-icons" style="font-size:40px;display:block;margin-bottom:8px">hourglass_empty</span>
        Cargando categorías...
      </div>
    </div>
  `;

  try {
    _state.productos = await getCached('mp:productos', async () => {
      const snap = await getDocs(query(collection(db, COL_PROD), orderBy('nombre')));
      return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    }, { ttl: 60000, memOnly: true });
    // Conteo de variantes por categoría — onenshot, sin bloquear UI
    cargarConteoVariantes(db, _state.productos);
    pintarListaCategorias(_state.productos);
  } catch (err) {
    document.getElementById('lpListaCats').innerHTML =
      `<div style="color:#dc3545;padding:16px">Error: ${escapeHtml(err.message)}</div>`;
  }

  document.getElementById('lpBtnNuevaCat').addEventListener('click', () => abrirModalCategoria(null, db));
  document.getElementById('lpBtnCargarSeed').addEventListener('click', () => cargarSeed(db));
  document.getElementById('lpBtnBorrarSeed').addEventListener('click', () => borrarSeed(db));
  document.getElementById('lpBuscarCats').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    if (!q) return pintarListaCategorias(_state.productos);
    pintarListaCategorias(_state.productos.filter(p =>
      (p.nombre || '').toLowerCase().includes(q) ||
      (p.rubro || '').toLowerCase().includes(q) ||
      (p.categoria || '').toLowerCase().includes(q) ||
      (p.marca || '').toLowerCase().includes(q)
    ));
  });

  document.getElementById('lpListaCats').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const p = _state.productos.find(x => x._id === id);
    if (!p) return;
    if (btn.dataset.action === 'abrir')   return abrirCategoria(db, p);
    if (btn.dataset.action === 'stock')   return abrirModalStock(db, p);
    if (btn.dataset.action === 'editar')  return abrirModalCategoria(p, db);
    if (btn.dataset.action === 'borrar')  return borrarCategoria(db, p);
  });
}

async function cargarConteoVariantes(db, productos) {
  for (const p of productos) {
    try {
      const snap = await getCached(`mp:count:${p._id}`, async () => {
        const s = await getDocs(query(collection(db, COL_NODES), where('product_id', '==', p._id)));
        return s.size;
      }, { ttl: 60000, memOnly: true });
      const el = document.querySelector(`[data-cat-count="${p._id}"]`);
      if (el) el.textContent = `${snap} ${snap === 1 ? 'variante' : 'variantes'}`;
    } catch (e) { /* ignore */ }
  }
}

function pintarListaCategorias(productos) {
  const cont = document.getElementById('lpListaCats');
  if (!cont) return;
  if (!productos.length) {
    cont.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:var(--text-muted);background:white;border-radius:14px;border:2px dashed var(--border)">
        <span class="material-icons" style="font-size:48px;display:block;margin-bottom:12px;opacity:0.4">category</span>
        <p style="margin:0;font-size:16px;font-weight:600;color:var(--text)">Todavía no hay categorías.</p>
        <p style="margin:6px 0 0;font-size:13px">Tocá <strong>"Nueva categoría"</strong> para empezar. O cargá los ejemplos para ver cómo funciona.</p>
      </div>`;
    return;
  }

  cont.innerHTML = productos.map(p => `
    <div style="background:white;border-radius:12px;padding:14px 18px;box-shadow:0 1px 6px rgba(0,0,0,0.06);border:1px solid var(--border);display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,var(--primary),#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <span class="material-icons" style="color:white;font-size:24px">category</span>
      </div>
      <div style="flex:1;min-width:200px">
        <div style="font-size:16px;font-weight:700">${escapeHtml(p.nombre || '—')}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:3px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${p.rubro ? `<span style="background:#eef4ff;color:#1877f2;border:1px solid #c7d9fc;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700;letter-spacing:.3px">${escapeHtml(p.rubro)}</span>` : ''}
          ${p.marca ? `<span>${escapeHtml(p.marca)}</span>` : ''}
          <span data-cat-count="${p._id}" style="background:#f3e8ff;color:#7c3aed;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700">…</span>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap">
        <button data-action="abrir" data-id="${p._id}" style="padding:8px 16px;background:var(--primary);color:white;border:none;border-radius:8px;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px">
          <span class="material-icons" style="font-size:16px">arrow_forward</span> Abrir
        </button>
        <button data-action="stock" data-id="${p._id}" title="Ver / editar stock"
          style="padding:8px 12px;background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px">
          <span class="material-icons" style="font-size:16px">inventory_2</span>
        </button>
        <button data-action="editar" data-id="${p._id}" title="Editar categoría"
          style="padding:8px 12px;background:#f8f9fa;border:1px solid var(--border);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">
          <span class="material-icons" style="font-size:16px">edit</span>
        </button>
        <button data-action="borrar" data-id="${p._id}" title="Eliminar"
          style="padding:8px 12px;background:#fff0f0;border:1px solid #fca5a5;color:#dc3545;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">
          <span class="material-icons" style="font-size:16px">delete_outline</span>
        </button>
      </div>
    </div>
  `).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// MODAL · CATEGORÍA
// ─────────────────────────────────────────────────────────────────────────────
function abrirModalCategoria(p = null, db = null) {
  document.getElementById('lpCatTitulo').textContent = p ? 'Editar categoría' : 'Nueva categoría';
  document.getElementById('lpCatId').value          = p?._id || '';
  document.getElementById('lpCatNombre').value      = p?.nombre || '';
  document.getElementById('lpCatCodigo').value      = p?.codigo_barras || generarCodigoBarras();
  document.getElementById('lpCatCategoria').value   = p?.categoria || '';
  document.getElementById('lpCatMarca').value       = p?.marca || '';
  document.getElementById('lpCatDescripcion').value = p?.descripcion || '';
  document.getElementById('lpCatError').style.display = 'none';

  const sel = document.getElementById('lpCatRubro');
  const rubroActual = p?.rubro || '';
  const lista = _state.rubros.slice();
  if (rubroActual && !lista.includes(rubroActual)) lista.push(rubroActual);
  sel.innerHTML = '<option value="">— Sin rubro —</option>' +
    lista.map(r => `<option value="${escapeHtml(r)}" ${r === rubroActual ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('');

  // Cargar descuentos del producto (lazy si no están en cache)
  const discCont = document.getElementById('lpCatDescuentos');
  discCont.innerHTML = '';
  if (p && db) {
    cargarDescuentos(db, p._id).then(ds => {
      _state.descuentos = ds;
      ds.filter(d => d.scope_type === 'product' && d.scope_id === p._id)
        .forEach(d => discCont.appendChild(filaDescuento(d)));
    }).catch(() => {});
  }

  document.getElementById('lpCatModal').style.display = 'flex';
  setTimeout(() => document.getElementById('lpCatNombre').focus(), 50);
}

async function guardarCategoria(db) {
  const errEl = document.getElementById('lpCatError');
  const btn   = document.getElementById('lpCatGuardar');
  errEl.style.display = 'none';

  const nombre = document.getElementById('lpCatNombre').value.trim();
  if (!nombre) {
    errEl.textContent = 'El nombre es obligatorio.';
    errEl.style.display = 'block';
    return;
  }

  const id = document.getElementById('lpCatId').value;
  const productoExistente = id ? _state.productos.find(x => x._id === id) : null;
  // Mantener atributos_definidos existentes (los administra el modal de variante)
  const atributos = productoExistente?.atributos_definidos || [];

  const data = {
    nombre,
    slug:                slugify(nombre),
    codigo_barras:       document.getElementById('lpCatCodigo').value.trim() || generarCodigoBarras(),
    rubro:               document.getElementById('lpCatRubro').value.trim(),
    categoria:           document.getElementById('lpCatCategoria').value.trim(),
    marca:               document.getElementById('lpCatMarca').value.trim(),
    descripcion:         document.getElementById('lpCatDescripcion').value.trim(),
    atributos_definidos: atributos,
    actualizado:         serverTimestamp(),
  };

  btn.disabled = true;
  btn.textContent = 'Guardando...';
  try {
    let productoId = id;
    if (id) {
      await updateDoc(doc(db, COL_PROD, id), data);
    } else {
      data.creado = serverTimestamp();
      const ref = await addDoc(collection(db, COL_PROD), data);
      await updateDoc(ref, { id: ref.id });
      productoId = ref.id;
    }

    // Sync descuentos del producto
    const discCont = document.getElementById('lpCatDescuentos');
    const nuevos = leerDescuentos(discCont, 'product', productoId, productoId);
    const originales = (_state.descuentos || []).filter(d => d.scope_type === 'product' && d.scope_id === productoId);
    await sincronizarDescuentos(db, originales, nuevos);

    invalidateCacheByPrefix('mp:');
    cerrarModal('cat');
    await renderListaCategorias(db);
  } catch (err) {
    errEl.textContent = 'Error al guardar: ' + err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar categoría';
  }
}

async function borrarCategoria(db, p) {
  const nodesSnap = await getDocs(query(collection(db, COL_NODES), where('product_id', '==', p._id)));
  const total = nodesSnap.size;
  const msg = total > 0
    ? `¿Eliminar <strong>"${p.nombre}"</strong> y sus <strong>${total} variante(s)</strong>?<br><br>Esta acción no se puede deshacer.`
    : `¿Eliminar <strong>"${p.nombre}"</strong>?`;
  const ok = await confirmDialog({
    title: 'Eliminar categoría',
    message: msg,
    confirmText: 'Eliminar',
    cancelText: 'Cancelar',
    danger: true,
  });
  if (!ok) return;

  try {
    const docs = nodesSnap.docs.slice();
    while (docs.length) {
      const chunk = docs.splice(0, 400);
      const batch = writeBatch(db);
      chunk.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    await deleteDoc(doc(db, COL_PROD, p._id));
    invalidateCacheByPrefix('mp:');
    await renderListaCategorias(db);
  } catch (err) {
    await alertDialog({ title: 'Error al borrar', message: err.message, type: 'error' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PANTALLA 2 · CATEGORÍA ABIERTA (lista plana de variantes)
// ─────────────────────────────────────────────────────────────────────────────
async function abrirCategoria(db, producto) {
  _state.productoActivo = producto;
  const root = document.getElementById('labRoot');
  if (!root) return;

  root.innerHTML = `
    <div style="margin-bottom:14px">
      <button id="lpVolver" style="background:none;border:none;color:var(--primary);cursor:pointer;font-size:14px;font-weight:600;display:flex;align-items:center;gap:4px;padding:4px 0;font-family:inherit">
        <span class="material-icons" style="font-size:18px">arrow_back</span> Volver a categorías
      </button>
    </div>

    <div style="background:white;border-radius:14px;padding:18px 22px;box-shadow:0 1px 8px rgba(0,0,0,0.06);border:1px solid var(--border);margin-bottom:14px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div style="width:52px;height:52px;border-radius:13px;background:linear-gradient(135deg,var(--primary),#a855f7);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <span class="material-icons" style="color:white;font-size:26px">category</span>
      </div>
      <div style="flex:1;min-width:200px">
        <div style="font-size:18px;font-weight:800">${escapeHtml(producto.nombre)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:3px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${producto.rubro ? `<span style="background:#eef4ff;color:#1877f2;border:1px solid #c7d9fc;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700;letter-spacing:.3px">${escapeHtml(producto.rubro)}</span>` : ''}
          <span>${[producto.categoria, producto.marca].filter(Boolean).map(escapeHtml).join(' · ') || 'Sin categoría / marca'}</span>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="lpBtnEditarCat" title="Editar categoría"
          style="padding:9px 12px;background:#f8f9fa;border:1px solid var(--border);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px">
          <span class="material-icons" style="font-size:16px">edit</span>
        </button>
        <button id="lpBtnStock" title="Stock en tiempo real"
          style="padding:9px 14px;background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px">
          <span class="material-icons" style="font-size:16px">inventory_2</span> Stock
        </button>
        <button id="lpBtnLote" title="Crear varias parecidas en un solo paso" style="background:#dcfce7;color:#15803d;border:1.5px solid #86efac;border-radius:8px;padding:10px 14px;font-size:13.5px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;font-family:inherit">
          <span class="material-icons" style="font-size:18px">bolt</span> + Varios
        </button>
        <button id="lpBtnNuevaVar" style="background:var(--primary);color:white;border:none;border-radius:8px;padding:10px 18px;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;font-family:inherit">
          <span class="material-icons" style="font-size:18px">add</span> Nueva variante
        </button>
      </div>
    </div>

    <div id="lpLegacyBanner" style="display:none;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 14px;margin-bottom:12px;font-size:13px;color:#92400e;line-height:1.5"></div>

    <div style="margin-bottom:10px;position:relative">
      <span class="material-icons" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:20px">search</span>
      <input id="lpBuscarVars" type="text" placeholder="Buscar variante por nombre o característica..."
        style="width:100%;box-sizing:border-box;padding:11px 12px 11px 40px;border:1.5px solid var(--border);border-radius:10px;font-size:14px;font-family:inherit;background:var(--card-bg)" />
    </div>

    <div id="lpListaVars" style="display:flex;flex-direction:column;gap:10px"></div>
  `;

  document.getElementById('lpVolver').addEventListener('click', () => renderListaCategorias(db));
  document.getElementById('lpBtnNuevaVar').addEventListener('click', () => abrirModalVariante(null, db));
  document.getElementById('lpBtnLote').addEventListener('click', () => abrirModoRapido(db));
  document.getElementById('lpBtnEditarCat').addEventListener('click', () => abrirModalCategoria(producto, db));
  document.getElementById('lpBtnStock').addEventListener('click', () => abrirModalStock(db, producto));
  document.getElementById('lpBuscarVars').addEventListener('input', e => pintarVariantes(e.target.value.toLowerCase().trim()));
  document.getElementById('lpListaVars').addEventListener('click', async e => {
    const btn = e.target.closest('[data-vaction]');
    if (!btn) return;
    const id = btn.dataset.id;
    const node = _state.nodes.find(n => n._id === id);
    if (!node) return;
    if (btn.dataset.vaction === 'editar') return abrirModalVariante(node, db);
    if (btn.dataset.vaction === 'borrar') return borrarVariante(db, node);
  });

  await cargarVariantes(db, producto._id);
}

async function cargarVariantes(db, productId) {
  const cont = document.getElementById('lpListaVars');
  cont.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)"><div class="spinner"></div><p style="margin-top:12px">Cargando variantes...</p></div>`;
  try {
    const [nodes, descuentos] = await Promise.all([
      getCached(`mp:nodes:${productId}`, async () => {
        const snap = await getDocs(query(collection(db, COL_NODES), where('product_id', '==', productId)));
        return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
      }, { ttl: 60000, memOnly: true }),
      getCached(`mp:disc:${productId}`, () => cargarDescuentos(db, productId), { ttl: 60000, memOnly: true }),
    ]);
    _state.nodes = nodes;
    _state.descuentos = descuentos;
    pintarVariantes();
  } catch (err) {
    cont.innerHTML = `<div style="color:#dc3545;padding:16px">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function pintarVariantes(filtro = '') {
  const cont = document.getElementById('lpListaVars');
  if (!cont) return;

  // Detectar nodos legacy (sub-niveles, no raíces directas)
  const legacy = _state.nodes.filter(n => n.parent_id || (n.depth || 0) > 0);
  const banner = document.getElementById('lpLegacyBanner');
  if (banner) {
    if (legacy.length) {
      banner.style.display = 'block';
      banner.innerHTML = `
        <strong>Estructura antigua detectada:</strong> ${legacy.length} variante(s) anidadas.
        Se siguen viendo y editando, pero las nuevas se crean planas (un solo nivel).
      `;
    } else {
      banner.style.display = 'none';
    }
  }

  if (!_state.nodes.length) {
    cont.innerHTML = `
      <div style="text-align:center;padding:54px 20px;color:var(--text-muted);background:white;border-radius:14px;border:2px dashed var(--border)">
        <span class="material-icons" style="font-size:54px;display:block;margin-bottom:12px;opacity:0.4">style</span>
        <p style="margin:0;font-size:16px;font-weight:600;color:var(--text)">Esta categoría está vacía.</p>
        <p style="margin:6px 0 0;font-size:13px">Tocá <strong>"Nueva variante"</strong> para crear el primer color, tamaño o medida.</p>
      </div>`;
    return;
  }

  // Filtrar por nombre / atributos
  let visibles = _state.nodes;
  if (filtro) {
    visibles = _state.nodes.filter(n => {
      const hay = (s) => (s || '').toLowerCase().includes(filtro);
      if (hay(n.nombre) || hay(n.sku_sufijo)) return true;
      const a = n.atributos || {};
      return Object.values(a).some(v => {
        if (v && typeof v === 'object') {
          return hay(v.label) || hay(String(v.value)) || hay(v.unidad);
        }
        return hay(String(v));
      });
    });
  }

  // Ordenar: raíces directas primero, después legacy
  visibles = visibles.slice().sort((a, b) => {
    const aLeg = a.parent_id ? 1 : 0;
    const bLeg = b.parent_id ? 1 : 0;
    if (aLeg !== bLeg) return aLeg - bLeg;
    return (a.nombre || '').localeCompare(b.nombre || '');
  });

  if (!visibles.length) {
    cont.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:14px">Ninguna variante coincide con "${escapeHtml(filtro)}"</div>`;
    return;
  }

  cont.innerHTML = visibles.map(n => cardVariante(n)).join('');
}

function cardVariante(n) {
  const atrTxt = _resumenAtributos(n.atributos || {});
  const colorHex = n.atributos?.color?.hex || null;
  const isLegacy = !!n.parent_id;
  const tieneHijos = _state.nodes.some(x => x.parent_id === n._id);

  // Precio + descuento efectivo (si es hoja)
  let precioBadge = '';
  if (n.precio && typeof n.precio.venta === 'number' && n.precio.venta > 0) {
    const desc = !tieneHijos ? descuentoEfectivo(_state.productoActivo, n, null, _state.nodes, _state.descuentos || [], 1) : null;
    if (desc) {
      const { precioFinal, etiqueta } = aplicarDescuento(n.precio.venta, desc, 1);
      precioBadge = `
        <span style="background:#dbeafe;color:#94a3b8;padding:2px 7px;border-radius:9px;font-size:11px;font-weight:600;text-decoration:line-through">${fmtMoney(n.precio.venta)}</span>
        <span style="background:#dcfce7;color:#166534;padding:2px 9px;border-radius:9px;font-size:12px;font-weight:700">${fmtMoney(precioFinal)}</span>
        <span title="${escapeHtml(desc.etiqueta || '')}" style="background:#faf5ff;color:#7c3aed;padding:2px 8px;border-radius:9px;font-size:10px;font-weight:700">${etiqueta}</span>`;
    } else {
      precioBadge = `<span style="background:#dbeafe;color:#1e40af;padding:3px 10px;border-radius:9px;font-size:12px;font-weight:700">${fmtMoney(n.precio.venta)}</span>`;
    }
  } else if (!tieneHijos) {
    precioBadge = `<span title="Falta precio" style="background:#fef2f2;color:#b91c1c;padding:3px 10px;border-radius:9px;font-size:11px;font-weight:600">sin precio</span>`;
  }

  // Presentaciones — chips por tipo (solo identificación, sin stock para no
  // duplicar lo del panel)
  const presList = Array.isArray(n.presentaciones) ? n.presentaciones : [];
  const presChips = presList.map(p => {
    const tipo = TIPOS_PRESENTACION.find(t => t.value === p.tipo);
    const lbl = p.label || tipo?.label || p.tipo || '';
    return `<span style="background:#fffbeb;color:#92400e;border:1px solid #fde68a;padding:2px 9px;border-radius:9px;font-size:11px;font-weight:600;display:inline-flex;align-items:center;gap:3px">
      <span class="material-icons" style="font-size:12px">${tipo?.icon || 'package_2'}</span>${escapeHtml(lbl)}
    </span>`;
  }).join(' ');

  // Panel de stock — una línea por presentación con su stock (y sueltos si rollo)
  let stockPanel = '';
  if (presList.length) {
    const lineas = presList.map(p => {
      const tipoDef = TIPOS_PRESENTACION.find(t => t.value === p.tipo);
      const lbl = p.label || tipoDef?.label || p.tipo || '—';
      const um  = p.unidad_medida || tipoDef?.unidadBase || '';
      const stkN = Number(p.stock) || 0;
      const minN = Number(p.stock_minimo) || 0;
      const suelN = Number(p.stock_sueltos) || 0;

      // Vinculada: su stock viene de otra; muestro hint pero no número
      if (p.stock_modo === 'vinculado' && p.vinculada_a) {
        const fuente = presList.find(x => x.id === p.vinculada_a);
        const fuenteLbl = fuente?.label || fuente?.tipo || '';
        return `<div style="display:flex;align-items:center;gap:5px;font-size:11.5px;color:#7c3aed;line-height:1.5">
          <span class="material-icons" style="font-size:11px">link</span>
          <span><strong>${escapeHtml(lbl)}</strong>: corte de ${escapeHtml(fuenteLbl)}</span>
        </div>`;
      }

      const bajo = minN > 0 && stkN <= minN;
      const stockColor = stkN === 0 ? '#dc2626' : (bajo ? '#d97706' : '#0f172a');
      const stockTxt = `<strong style="color:${stockColor};font-weight:800">${stkN}</strong>`;

      // Total agregado: si la presentación es contenedora (rollo/pack/caja),
      // calcular cuánto hay en total = stock × equiv + sueltos (en unidad base).
      const equiv = Number(p.equivalencia_base) || 0;
      let total = '';
      if (equiv > 0 && (stkN > 0 || suelN > 0)) {
        const totalN = stkN * equiv + suelN;
        const um2 = um || 'un';
        total = `<div style="font-size:11px;color:#16a34a;font-weight:700;padding-left:14px;margin-top:1px">= ${totalN}${um2} total</div>`;
      }

      let sueltos = '';
      if (p.tipo === 'rollo' && suelN > 0) {
        sueltos = `<div style="font-size:10.5px;color:#475569;padding-left:14px">+ ${suelN}${um || 'm'} sueltos</div>`;
      }

      return `<div>
        <div style="display:flex;align-items:center;gap:5px;font-size:11.5px;color:#0f172a;line-height:1.4">
          ${stockTxt}<span style="color:#475569">${escapeHtml(lbl)}</span>
        </div>
        ${sueltos}
        ${total}
      </div>`;
    }).join('');

    stockPanel = `
      <div style="background:#f8fafc;border:1px solid var(--border);border-radius:9px;padding:7px 10px;min-width:130px;max-width:200px;flex-shrink:0">
        <div style="font-size:9.5px;font-weight:800;letter-spacing:0.5px;color:#64748b;text-transform:uppercase;margin-bottom:4px">Stock</div>
        <div style="display:flex;flex-direction:column;gap:3px">${lineas}</div>
      </div>`;
  }

  const avatarStyle = colorHex
    ? `background:${colorHex};border:2px solid white;box-shadow:0 0 0 1px var(--border)`
    : `background:linear-gradient(135deg,#e9d5ff,#c4b5fd)`;
  const iconColor = colorHex && esColorOscuro(colorHex) ? 'white' : '#5b21b6';

  return `
    <div style="background:white;border-radius:12px;padding:14px 16px;box-shadow:0 1px 6px rgba(0,0,0,0.06);border:1px solid var(--border);display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div style="width:46px;height:46px;border-radius:11px;${avatarStyle};display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <span class="material-icons" style="color:${iconColor};font-size:22px">style</span>
      </div>
      <div style="flex:1;min-width:200px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <div style="font-size:15px;font-weight:700">${escapeHtml(n.nombre || '—')}</div>
          ${isLegacy ? '<span style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:1px 7px;border-radius:8px;font-size:10px;font-weight:700;letter-spacing:0.3px">LEGACY</span>' : ''}
          ${tieneHijos ? '<span style="background:#f3e8ff;color:#7c3aed;padding:1px 7px;border-radius:8px;font-size:10px;font-weight:700">CON HIJOS</span>' : ''}
        </div>
        ${atrTxt ? `<div style="font-size:12px;color:var(--text-muted);margin-top:3px">${escapeHtml(atrTxt)}</div>` : ''}
        <div style="margin-top:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${precioBadge}
          ${presChips}
        </div>
      </div>
      ${stockPanel}
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button data-vaction="editar" data-id="${n._id}" title="Editar"
          style="padding:8px 12px;background:#f8f9fa;border:1px solid var(--border);border-radius:8px;cursor:pointer;font-family:inherit">
          <span class="material-icons" style="font-size:18px;color:#475569">edit</span>
        </button>
        <button data-vaction="borrar" data-id="${n._id}" title="Eliminar"
          style="padding:8px 12px;background:#fff0f0;border:1px solid #fca5a5;border-radius:8px;cursor:pointer;font-family:inherit">
          <span class="material-icons" style="font-size:18px;color:#dc3545">delete_outline</span>
        </button>
      </div>
    </div>
  `;
}

function esColorOscuro(hex) {
  // Devuelve true si el hex es lo bastante oscuro como para necesitar texto claro encima.
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return false;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 130;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODAL · VARIANTE
// ─────────────────────────────────────────────────────────────────────────────
function abrirModalVariante(nodoExistente, db) {
  const producto = _state.productoActivo;
  if (!producto) return;

  document.getElementById('lpVarTitulo').textContent = nodoExistente ? 'Editar variante' : 'Nueva variante';
  document.getElementById('lpVarBreadcrumb').innerHTML =
    `<span style="color:var(--text-muted)">Categoría:</span> <strong>${escapeHtml(producto.nombre)}</strong>`;
  document.getElementById('lpVarId').value = nodoExistente?._id || '';
  document.getElementById('lpVarParentId').value = nodoExistente?.parent_id || '';
  document.getElementById('lpVarNombre').value = nodoExistente?.nombre || '';
  document.getElementById('lpVarSku').value = nodoExistente?.sku_sufijo || '';
  document.getElementById('lpVarPrecioCosto').value = nodoExistente?.precio?.costo ?? '';
  document.getElementById('lpVarPrecioVenta').value = nodoExistente?.precio?.venta ?? '';
  const c = parseFloat(nodoExistente?.precio?.costo ?? '');
  const v = parseFloat(nodoExistente?.precio?.venta ?? '');
  document.getElementById('lpVarPrecioMargen').value = (c > 0 && v > 0) ? ((v - c) / c * 100).toFixed(1) : '';
  document.getElementById('lpVarError').style.display = 'none';

  // Banner si es legacy
  const legacyHint = document.getElementById('lpVarLegacyHint');
  if (nodoExistente && (nodoExistente.parent_id || (nodoExistente.depth || 0) > 0)) {
    legacyHint.style.display = 'flex';
    legacyHint.innerHTML = `
      <span class="material-icons" style="font-size:16px;color:#92400e">warning</span>
      <div>Esta variante usa la <strong>estructura antigua</strong> (anidada). Podés editarla, pero no se puede mover a la nueva estructura plana sin recrearla.</div>
    `;
  } else {
    legacyHint.style.display = 'none';
  }

  // Características: si edita, cargar las que tenía. Si no, pre-cargar las del madre.
  const attrCont = document.getElementById('lpVarAttrs');
  attrCont.innerHTML = '';
  const empty = document.getElementById('lpVarAttrsEmpty');
  if (nodoExistente) {
    // Reconstruir filas desde los atributos guardados, usando los tipos del madre como guía
    const definidos = producto.atributos_definidos || [];
    Object.entries(nodoExistente.atributos || {}).forEach(([key, val]) => {
      const def = definidos.find(d => d.key === key);
      attrCont.appendChild(filaAtributoVariante(key, def, val));
    });
  } else {
    // Nueva variante: pre-cargar las características del madre (vacías)
    (producto.atributos_definidos || []).forEach(def => {
      attrCont.appendChild(filaAtributoVariante(def.key, def, null));
    });
  }
  empty.style.display = attrCont.children.length === 0 ? 'block' : 'none';

  // Presentaciones
  const presCont = document.getElementById('lpVarPresentaciones');
  presCont.innerHTML = '';
  const presList = (nodoExistente?.presentaciones || []).slice();
  if (!presList.length) {
    presList.push({ tipo: 'unidad', label: 'Unidad', unidad_medida: 'un', stock: 0 });
  }
  presList.forEach(p => presCont.appendChild(filaPresentacion(p)));

  // Descuentos del nodo
  const discCont = document.getElementById('lpVarDescuentos');
  discCont.innerHTML = '';
  if (nodoExistente) {
    (_state.descuentos || [])
      .filter(d => d.scope_type === 'node' && d.scope_id === nodoExistente._id)
      .forEach(d => discCont.appendChild(filaDescuento(d)));
  }

  // Conectar costo↔margen↔venta
  setupCostoMargenVenta(
    document.getElementById('lpVarPrecioCosto'),
    document.getElementById('lpVarPrecioMargen'),
    document.getElementById('lpVarPrecioVenta'),
    document.getElementById('lpVarPrecioRedondeo'),
  );

  // Reset del marker de "sugerido aceptado": cada apertura empieza limpia
  delete document.getElementById('lpVarNombre').dataset.sugeridoUsado;
  actualizarNombreSugerido();

  document.getElementById('lpVarModal').style.display = 'flex';
  setTimeout(() => document.getElementById('lpVarNombre').focus(), 50);
}

async function guardarVariante(db) {
  const errEl = document.getElementById('lpVarError');
  const btn   = document.getElementById('lpVarGuardar');
  errEl.style.display = 'none';

  const producto = _state.productoActivo;
  const nombre = document.getElementById('lpVarNombre').value.trim();
  if (!nombre) {
    errEl.textContent = 'El nombre es obligatorio.';
    errEl.style.display = 'block';
    return;
  }

  const idEditando = document.getElementById('lpVarId').value;
  const parentIdLegacy = document.getElementById('lpVarParentId').value || null; // solo si edita un legacy
  const padre = parentIdLegacy ? _state.nodes.find(n => n._id === parentIdLegacy) : null;

  // Atributos: leer + sincronizar atributos_definidos del madre con las características usadas
  const { atributos, definidosNuevos } = leerAtributosVariante(producto.atributos_definidos || []);

  const precio = {
    costo: numOrNull(document.getElementById('lpVarPrecioCosto').value),
    venta: numOrNull(document.getElementById('lpVarPrecioVenta').value),
  };

  if (precio.venta === null || precio.venta < 0) {
    errEl.textContent = 'Cargá un precio de venta para poder vender esta variante.';
    errEl.style.display = 'block';
    return;
  }

  const presentaciones = leerPresentacionesVariante();

  // Path/depth/es_hoja: respetar legacy si existe, si no plano (raíz directa)
  const seraHoja = padre || !idEditando ? true : (_state.nodes.find(n => n._id === idEditando)?.es_hoja ?? true);

  const data = {
    product_id: producto._id,
    parent_id:  parentIdLegacy,  // null para nuevas; legacy mantiene su parent
    nombre,
    sku_sufijo: document.getElementById('lpVarSku').value.trim(),
    atributos,
    precio,
    presentaciones,
    hereda_de_padre: { categoria: true, marca: true, descripcion: true },
    overrides: {},
    actualizado: serverTimestamp(),
  };

  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    let nodoId = idEditando;
    if (idEditando) {
      const actual = _state.nodes.find(n => n._id === idEditando);
      data.path    = actual?.path || [producto._id, idEditando];
      data.depth   = actual?.depth ?? 0;
      data.es_hoja = actual?.es_hoja ?? seraHoja;
      await updateDoc(doc(db, COL_NODES, idEditando), data);
    } else {
      const ref = doc(collection(db, COL_NODES));
      data.id      = ref.id;
      data.path    = [producto._id, ref.id];
      data.depth   = 0;
      data.es_hoja = true;
      data.creado  = serverTimestamp();
      await setDoc(ref, data);
      nodoId = ref.id;
    }

    // Sincronizar atributos_definidos del madre (si hay nuevos)
    if (definidosNuevos.length) {
      const merged = mergeAtributosDefinidos(producto.atributos_definidos || [], definidosNuevos);
      await updateDoc(doc(db, COL_PROD, producto._id), {
        atributos_definidos: merged,
        actualizado: serverTimestamp(),
      });
      producto.atributos_definidos = merged;
    }

    // Sync descuentos del nodo
    const discCont = document.getElementById('lpVarDescuentos');
    const nuevos = leerDescuentos(discCont, 'node', nodoId, producto._id);
    const originales = (_state.descuentos || []).filter(d => d.scope_type === 'node' && d.scope_id === nodoId);
    await sincronizarDescuentos(db, originales, nuevos);

    invalidateCacheByPrefix('mp:');
    cerrarModal('var');
    await cargarVariantes(db, producto._id);
  } catch (err) {
    errEl.textContent = 'Error al guardar: ' + err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar variante';
  }
}

async function borrarVariante(db, nodo) {
  const subarbol = _state.nodes.filter(n => (n.path || []).includes(nodo._id));
  const totalDescend = subarbol.length - 1;
  const msg = totalDescend > 0
    ? `¿Eliminar <strong>"${nodo.nombre}"</strong> y sus <strong>${totalDescend} descendiente(s)</strong>?<br><br>Esta acción no se puede deshacer.`
    : `¿Eliminar <strong>"${nodo.nombre}"</strong>?`;
  const ok = await confirmDialog({
    title: 'Eliminar variante',
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
    invalidateCacheByPrefix('mp:');
    await cargarVariantes(db, _state.productoActivo._id);
  } catch (err) {
    await alertDialog({ title: 'Error al borrar', message: err.message, type: 'error' });
  }
}

function numOrNull(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODO RÁPIDO · crear N variantes que solo difieren en una característica
// ─────────────────────────────────────────────────────────────────────────────

let _lote = null;

// Mapping de colores comunes → hex, para que crear "Azul, Rojo, Verde" salga
// con su color visual asignado sin que el usuario lo elija.
const COLORES_COMUNES = {
  'rojo': '#dc2626', 'roja': '#dc2626', 'colorado': '#dc2626',
  'azul': '#2563eb', 'celeste': '#38bdf8',
  'amarillo': '#eab308', 'amarilla': '#eab308',
  'verde': '#16a34a',
  'naranja': '#f97316', 'naranjo': '#f97316',
  'negro': '#1c1e21', 'negra': '#1c1e21',
  'blanco': '#f8fafc', 'blanca': '#f8fafc',
  'rosa': '#ec4899', 'rosado': '#ec4899',
  'violeta': '#a855f7', 'morado': '#a855f7', 'lila': '#c084fc',
  'gris': '#6b7280',
  'marron': '#92400e', 'marrón': '#92400e', 'cafe': '#92400e',
  'dorado': '#facc15',
  'plateado': '#cbd5e1', 'plata': '#cbd5e1',
  'turquesa': '#14b8a6', 'aqua': '#06b6d4',
  'fucsia': '#d946ef',
  'beige': '#fde68a',
};

function colorHexParaNombre(nombre) {
  const k = (nombre || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return COLORES_COMUNES[k] || '#9ca3af';
}

function abrirModoRapido(db) {
  const producto = _state.productoActivo;
  if (!producto) return;

  _lote = {
    db,
    charKey: 'color',
    charLabel: 'Color',
    charTipo: 'color',
    charUnidadDefault: '',
    tipoPres: 'unidad',
  };

  document.getElementById('lpLoteBreadcrumb').innerHTML =
    `<span style="color:var(--text-muted)">En:</span> <strong>${escapeHtml(producto.nombre)}</strong>`;
  document.getElementById('lpLoteValores').value = '';
  document.getElementById('lpLoteEquiv').value = '';
  document.getElementById('lpLoteEquivUnidad').value = '';
  document.getElementById('lpLoteCosto').value = '';
  document.getElementById('lpLoteMargen').value = '';
  document.getElementById('lpLotePrecio').value = '';
  document.getElementById('lpLoteStock').value = '';
  document.getElementById('lpLoteAutoMetro').checked = true;
  document.getElementById('lpLoteAutoPrecio').value = '';
  document.getElementById('lpLoteCharCustom').value = '';
  document.getElementById('lpLoteCharCustom').style.display = 'none';
  document.getElementById('lpLoteError').style.display = 'none';

  // Conectar costo↔margen↔venta (mismo widget que el modal de variante)
  setupCostoMargenVenta(
    document.getElementById('lpLoteCosto'),
    document.getElementById('lpLoteMargen'),
    document.getElementById('lpLotePrecio'),
    document.getElementById('lpLotePrecioRedondeo'),
  );

  pintarLoteCharChips();
  pintarLoteTipoChips();
  loteAjustarLayoutTipo();
  loteActualizarConteo();

  document.getElementById('lpLoteModal').style.display = 'flex';
  setTimeout(() => document.getElementById('lpLoteValores').focus(), 50);
}

function pintarLoteCharChips() {
  const cont = document.getElementById('lpLoteCharChips');
  if (!cont || !_lote) return;
  // Atajos populares + opción "otro"
  const opciones = TIPOS_ATRIBUTO.filter(t => t.popular).concat([
    { value: '_otro', label: 'Otro…', icon: 'tune', popular: false },
  ]);
  cont.innerHTML = opciones.map(t => {
    const sel = t.value === _lote.charKey || (t.value === '_otro' && _lote.charKey === '_otro');
    return `<button type="button" data-lote-char="${t.value}" style="
      background:${sel ? '#a855f7' : 'white'};border:1.5px solid ${sel ? '#9333ea' : '#e9d5ff'};
      color:${sel ? 'white' : '#86198f'};border-radius:8px;padding:7px 11px;font-size:12.5px;
      font-weight:${sel ? 800 : 600};cursor:pointer;font-family:inherit;
      display:inline-flex;align-items:center;gap:5px">
      <span class="material-icons" style="font-size:15px">${t.icon}</span>${escapeHtml(t.label)}
    </button>`;
  }).join('');

  cont.querySelectorAll('[data-lote-char]').forEach(b => {
    b.onclick = () => {
      const v = b.dataset.loteChar;
      _lote.charKey = v;
      const customInp = document.getElementById('lpLoteCharCustom');
      const customHint = document.getElementById('lpLoteCharCustomHint');
      if (v === '_otro') {
        _lote.charTipo = 'texto';
        _lote.charLabel = '';
        customInp.style.display = 'block';
        if (customHint) customHint.style.display = 'block';
        customInp.focus();
      } else {
        const def = TIPOS_ATRIBUTO.find(t => t.value === v);
        _lote.charTipo = v;
        _lote.charLabel = def?.label || v;
        _lote.charUnidadDefault = (v === 'tamano') ? 'cm' : (v === 'gramaje' ? 'gr' : '');
        customInp.style.display = 'none';
        if (customHint) customHint.style.display = 'none';
      }
      pintarLoteCharChips();
    };
  });
}

function pintarLoteTipoChips() {
  const cont = document.getElementById('lpLoteTipoChips');
  if (!cont || !_lote) return;
  cont.innerHTML = TIPOS_PRESENTACION.map(t => {
    const sel = t.value === _lote.tipoPres;
    return `<button type="button" data-lote-tipo="${t.value}" title="${escapeHtml(t.hint)}" style="
      background:${sel ? '#fbbf24' : 'white'};border:1.5px solid ${sel ? '#f59e0b' : '#fde68a'};
      color:${sel ? '#78350f' : '#a16207'};border-radius:8px;padding:7px 10px;font-size:12px;
      font-weight:${sel ? 800 : 600};cursor:pointer;font-family:inherit;
      display:inline-flex;align-items:center;gap:4px">
      <span class="material-icons" style="font-size:14px">${t.icon}</span>${escapeHtml(t.label)}
    </button>`;
  }).join('');

  cont.querySelectorAll('[data-lote-tipo]').forEach(b => {
    b.onclick = () => {
      _lote.tipoPres = b.dataset.loteTipo;
      pintarLoteTipoChips();
      loteAjustarLayoutTipo();
    };
  });
}

function loteAjustarLayoutTipo() {
  if (!_lote) return;
  const def = TIPOS_PRESENTACION.find(t => t.value === _lote.tipoPres);
  const equivWrap = document.getElementById('lpLoteEquivWrap');
  const equivLbl  = document.getElementById('lpLoteEquivLabel');
  const equivUnid = document.getElementById('lpLoteEquivUnidad');
  const precioLbl = document.getElementById('lpLotePrecioLabel');
  const autoWrap  = document.getElementById('lpLoteAutoMetroWrap');

  if (def?.wantsContent) {
    equivWrap.style.display = 'block';
    if (_lote.tipoPres === 'rollo')      { equivLbl.textContent = 'Cada rollo mide';  equivUnid.placeholder = 'm';  if (!equivUnid.value) equivUnid.value = 'm'; }
    else if (_lote.tipoPres === 'caja')  { equivLbl.textContent = 'Cada caja trae';   equivUnid.placeholder = 'un'; if (!equivUnid.value) equivUnid.value = 'un'; }
    else                                 { equivLbl.textContent = 'Cada pack trae';   equivUnid.placeholder = 'un'; if (!equivUnid.value) equivUnid.value = 'un'; }
  } else {
    equivWrap.style.display = 'none';
  }

  if (_lote.tipoPres === 'rollo') precioLbl.textContent = 'Precio del rollo';
  else if (_lote.tipoPres === 'pack') precioLbl.textContent = 'Precio del pack';
  else if (_lote.tipoPres === 'caja') precioLbl.textContent = 'Precio de la caja';
  else if (_lote.tipoPres === 'metro') precioLbl.textContent = 'Precio por metro';
  else if (_lote.tipoPres === 'kg') precioLbl.textContent = 'Precio por kilo';
  else if (_lote.tipoPres === 'gramo') precioLbl.textContent = 'Precio por gramo';
  else if (_lote.tipoPres === 'cm') precioLbl.textContent = 'Precio por cm';
  else precioLbl.textContent = 'Precio por unidad';

  // Auto-complementaria: para pack/caja/rollo
  const t = _lote.tipoPres;
  const aplica = (t === 'pack' || t === 'caja' || t === 'rollo');
  autoWrap.style.display = aplica ? 'block' : 'none';
  // Texto según tipo
  const title = document.getElementById('lpLoteAutoMetroTitle');
  const subLabel = document.getElementById('lpLoteAutoPrecioLabel');
  if (title && subLabel) {
    if (t === 'rollo') {
      title.textContent = 'Vender también por metro suelto';
      subLabel.textContent = 'Precio por metro (vacío = auto)';
    } else {
      title.textContent = 'Vender también por unidad';
      subLabel.textContent = 'Precio por unidad (vacío = auto)';
    }
  }
  loteActualizarVisibilidadPrecioAuto();
  loteActualizarHintAutoMetro();
}

function loteActualizarVisibilidadPrecioAuto() {
  const wrap = document.getElementById('lpLoteAutoPrecioWrap');
  const chk  = document.getElementById('lpLoteAutoMetro');
  if (!wrap || !chk) return;
  wrap.style.display = chk.checked ? 'block' : 'none';
}

function loteActualizarHintAutoMetro() {
  const hint = document.getElementById('lpLoteAutoMetroHint');
  const subInput = document.getElementById('lpLoteAutoPrecio');
  if (!hint || !_lote) return;
  const equiv = parseFloat(document.getElementById('lpLoteEquiv').value) || 0;
  const precio = parseFloat(document.getElementById('lpLotePrecio').value) || 0;
  const t = _lote.tipoPres;
  const subUnidad = (t === 'rollo')
    ? (document.getElementById('lpLoteEquivUnidad').value.trim() || 'm')
    : 'unidad';
  if (equiv > 0 && precio > 0) {
    const auto = precio / equiv * FRACCION_MARGIN;
    hint.textContent = `Auto: $${precio.toFixed(2)} ÷ ${equiv} × ${FRACCION_MARGIN} = $${auto.toFixed(2)} por ${subUnidad}`;
    if (subInput) subInput.placeholder = `auto: $${auto.toFixed(2)}`;
  } else {
    hint.textContent = `Cargá precio y "${t === 'rollo' ? 'mide' : 'trae'}" para calcular automáticamente.`;
    if (subInput) subInput.placeholder = 'auto: $—';
  }
}

function loteParsearValores(raw) {
  return (raw || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean);
}

function loteActualizarConteo() {
  const txt = document.getElementById('lpLoteCount');
  const btn = document.getElementById('lpLoteCrearTxt');
  const opt = document.getElementById('lpLoteCharOptional');
  if (!txt || !btn) return;
  const vals = loteParsearValores(document.getElementById('lpLoteValores').value);
  const n = vals.length;
  txt.textContent = n === 0 ? '0 variantes' : (n === 1 ? '1 variante' : `${n} variantes`);
  btn.textContent = n === 0 ? 'Crear variantes' : (n === 1 ? 'Crear 1 variante' : `Crear ${n} variantes`);
  if (opt) opt.style.display = n <= 1 ? 'inline-block' : 'none';
  loteRepintarStockIndividual(vals);
}

// Pinta una fila por variante con su input de stock individual.
// Mantiene los valores ya tipeados si la lista de valores cambia (matchea por nombre).
function loteRepintarStockIndividual(vals) {
  const wrap = document.getElementById('lpLoteStockIndivWrap');
  const lista = document.getElementById('lpLoteStockIndivLista');
  if (!wrap || !lista) return;

  // Solo mostrar cuando hay 2+ variantes
  if (vals.length < 2) {
    wrap.style.display = 'none';
    return;
  }

  // Preservar lo que el usuario ya tipeó (por nombre)
  const previos = {};
  lista.querySelectorAll('[data-stock-row]').forEach(r => {
    const k = r.dataset.stockKey;
    const v = r.querySelector('input')?.value || '';
    if (k) previos[k] = v;
  });

  const placeholderGlobal = document.getElementById('lpLoteStock').value || '0';
  const inp = `${estiloInput()};padding:6px 9px;font-size:12.5px`;

  lista.innerHTML = vals.map(v => `
    <div data-stock-row data-stock-key="${escapeHtml(v)}" style="display:grid;grid-template-columns:1fr 90px;gap:6px;align-items:center">
      <span style="font-size:12.5px;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(v)}">${escapeHtml(v)}</span>
      <input type="number" step="any" min="0" placeholder="${escapeHtml(placeholderGlobal)}" value="${escapeHtml(previos[v] || '')}" style="${inp}" />
    </div>
  `).join('');
  wrap.style.display = 'block';
}

function loteValorAAtributo(valorRaw) {
  // Convierte un texto ("Roja", "50x70", "180gr") al shape correcto del atributo
  // según _lote.charTipo. Devuelve null si no se pudo parsear.
  const v = (valorRaw || '').trim();
  if (!v) return null;
  const tipo = _lote.charTipo;
  if (tipo === 'color') {
    return { value: v, label: v, hex: colorHexParaNombre(v) };
  }
  if (tipo === 'tamano') {
    // Acepta "50x70", "50×70", "50x70 cm"
    const m = /^\s*(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*([a-z]+)?\s*$/.exec(v);
    if (m) {
      return { ancho: parseFloat(m[1]), alto: parseFloat(m[2]), unidad: m[3] || 'cm', label: `${m[1]}x${m[2]} ${m[3] || 'cm'}` };
    }
    // Fallback: lo dejo como texto libre
    return v;
  }
  if (tipo === 'gramaje' || tipo === 'medida' || tipo === 'numero') {
    // Acepta "180", "180gr", "180 gr", "12mm", "12 mm"
    const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)?\s*$/i.exec(v);
    if (m) {
      const num = parseFloat(m[1]);
      const unidad = m[2] || _lote.charUnidadDefault || '';
      return { value: num, unidad };
    }
    return { value: v, unidad: _lote.charUnidadDefault || '' };
  }
  // texto / material / marca / custom
  return v;
}

async function crearLoteVariantes() {
  if (!_lote) return;
  const errEl = document.getElementById('lpLoteError');
  errEl.style.display = 'none';

  const producto = _state.productoActivo;
  const valores = loteParsearValores(document.getElementById('lpLoteValores').value);
  if (!valores.length) {
    errEl.textContent = 'Cargá al menos un valor (Ej: "Roja, Azul, Verde").';
    errEl.style.display = 'block';
    return;
  }

  // Resolver característica a usar (se ignora si solo hay 1 valor)
  let charKey = _lote.charKey;
  let charLabel = _lote.charLabel;
  let charTipo = _lote.charTipo;
  let usarAtributo = valores.length > 1;  // Para 1 sola variante no es necesario un atributo

  if (usarAtributo && charKey === '_otro') {
    const custom = document.getElementById('lpLoteCharCustom').value.trim();
    if (!custom) {
      errEl.textContent = 'Escribí qué tipo las diferencia (Ej: Talle, Sabor, Modelo).';
      errEl.style.display = 'block';
      return;
    }
    charKey = slugify(custom);
    charLabel = custom;
    charTipo = 'texto';
  } else if (!usarAtributo && charKey === '_otro') {
    // 1 sola variante con "Otro" sin nombre: crear sin atributo
    charKey = null;
  }

  const precio = numOrNull(document.getElementById('lpLotePrecio').value);
  const costo  = numOrNull(document.getElementById('lpLoteCosto').value);
  if (precio === null || precio < 0) {
    errEl.textContent = 'Cargá un precio (o un costo + margen) para las variantes.';
    errEl.style.display = 'block';
    return;
  }
  const equiv  = numOrNull(document.getElementById('lpLoteEquiv').value);
  const equivU = document.getElementById('lpLoteEquivUnidad').value.trim();
  const stockGlobal = numOrNull(document.getElementById('lpLoteStock').value) ?? 0;
  // Mapear stock individual por variante (override del global)
  const stockPorValor = new Map();
  document.querySelectorAll('#lpLoteStockIndivLista [data-stock-row]').forEach(row => {
    const k = row.dataset.stockKey;
    const v = numOrNull(row.querySelector('input')?.value);
    if (k && v !== null) stockPorValor.set(k, v);
  });
  const tipoPres = _lote.tipoPres;
  const tipoPresDef = TIPOS_PRESENTACION.find(t => t.value === tipoPres);
  const wantsContent = !!tipoPresDef?.wantsContent;
  if (wantsContent && (equiv === null || equiv <= 0)) {
    errEl.textContent = `Cargá cuánto trae cada ${tipoPres}. Ej: 15`;
    errEl.style.display = 'block';
    return;
  }
  // Auto-complementaria (rollo→metro, pack→unidad, caja→unidad)
  const autoComplemento = (tipoPres === 'rollo' || tipoPres === 'pack' || tipoPres === 'caja')
    && document.getElementById('lpLoteAutoMetro').checked;
  const tipoComplemento = tipoPres === 'rollo' ? 'metro' : 'unidad';
  const labelComplemento = tipoPres === 'rollo' ? 'Por metro (corte)' : 'Por unidad';
  const unidadComplemento = tipoPres === 'rollo' ? 'm' : 'un';
  // Precio explícito de la complementaria (si el user lo cargó). Vacío = null = auto.
  const precioComplemento = numOrNull(document.getElementById('lpLoteAutoPrecio').value);

  const btn = document.getElementById('lpLoteCrear');
  btn.disabled = true;
  const ogTxt = document.getElementById('lpLoteCrearTxt').textContent;
  document.getElementById('lpLoteCrearTxt').textContent = 'Creando…';

  const db = _lote.db;
  try {
    // 1) Si hay característica, asegurar que esté en atributos_definidos del madre
    if (usarAtributo && charKey) {
      const defActual = (producto.atributos_definidos || []).slice();
      if (!defActual.find(d => d.key === charKey)) {
        defActual.push({
          key: charKey,
          label: charLabel,
          tipo: charTipo,
          unidad: _lote.charUnidadDefault || '',
        });
        await updateDoc(doc(db, COL_PROD, producto._id), {
          atributos_definidos: defActual,
          actualizado: serverTimestamp(),
        });
        producto.atributos_definidos = defActual;
      }
    }

    // 2) Crear cada variante
    const unidadMedida = equivU || tipoPresDef?.unidadBase || '';
    let creadas = 0;

    for (const valorRaw of valores) {
      const ref = doc(collection(db, COL_NODES));
      const idPpal = nuevoIdLocal();
      const idComp = nuevoIdLocal();
      const stock = stockPorValor.has(valorRaw) ? stockPorValor.get(valorRaw) : stockGlobal;

      // Etiqueta auto: "Pack x15", "Caja x100", "Rollo 50m"
      let etiquetaPpal = sugerirLabel(tipoPres);
      if (wantsContent && equiv > 0) {
        if (tipoPres === 'pack')      etiquetaPpal = `Pack x${equiv}`;
        else if (tipoPres === 'caja') etiquetaPpal = `Caja x${equiv}`;
        else if (tipoPres === 'rollo') etiquetaPpal = `Rollo ${equiv}${unidadMedida || 'm'}`;
      }

      const presentacionPpal = {
        id: idPpal,
        tipo: tipoPres,
        label: etiquetaPpal,
        codigo_barras: generarCodigoBarras(),
        sku_sufijo: '',
        unidad_medida: unidadMedida,
        equivalencia_base: wantsContent ? equiv : null,
        stock,
        stock_minimo: 0,
        stock_sueltos: 0,
        stock_minimo_sueltos: 0,
        precio_costo: costo,
        precio_venta: precio,
        stock_modo: 'independiente',
        vinculada_a: null,
        activo: true,
      };

      const presentaciones = [presentacionPpal];

      if (autoComplemento) {
        presentaciones.push({
          id: idComp,
          tipo: tipoComplemento,
          label: labelComplemento,
          codigo_barras: generarCodigoBarras(),
          sku_sufijo: '',
          unidad_medida: unidadComplemento,
          equivalencia_base: null,
          stock: 0,
          stock_minimo: 0,
          stock_sueltos: 0,
          stock_minimo_sueltos: 0,
          precio_costo: null,
          // Si el usuario cargó precio explícito, usarlo. Vacío = null = el POS
          // calcula auto desde la fuente (precio_pack ÷ trae × FRACCION_MARGIN)
          precio_venta: precioComplemento,
          stock_modo: 'vinculado',
          vinculada_a: idPpal,
          activo: true,
        });
      }

      const atributos = {};
      if (usarAtributo && charKey) {
        const atrValor = loteValorAAtributo(valorRaw);
        if (atrValor !== null) atributos[charKey] = atrValor;
      }

      const data = {
        id: ref.id,
        product_id: producto._id,
        parent_id: null,
        nombre: valorRaw,
        sku_sufijo: '',
        atributos,
        precio: { costo, venta: precio },
        presentaciones,
        hereda_de_padre: { categoria: true, marca: true, descripcion: true },
        overrides: {},
        es_hoja: true,
        depth: 0,
        path: [producto._id, ref.id],
        creado: serverTimestamp(),
        actualizado: serverTimestamp(),
      };
      await setDoc(ref, data);
      creadas++;
    }

    invalidateCacheByPrefix('mp:');
    cerrarModal('lote');
    await cargarVariantes(db, producto._id);
    await alertDialog({
      title: 'Listo',
      message: `Se crearon <strong>${creadas}</strong> variante(s).`,
      type: 'success',
    });
  } catch (err) {
    errEl.textContent = 'Error al crear: ' + err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    document.getElementById('lpLoteCrearTxt').textContent = ogTxt;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FILA · CARACTERÍSTICA DE VARIANTE
// ─────────────────────────────────────────────────────────────────────────────
function filaAtributoVariante(key = '', defMadre = null, valor = null) {
  // defMadre = { key, label, tipo, unidad } del producto madre (si existe)
  const tipo = defMadre?.tipo || guessTipoFromValue(valor) || 'texto';
  const label = defMadre?.label || (key ? key.charAt(0).toUpperCase() + key.slice(1) : '');

  const wrap = document.createElement('div');
  wrap.dataset.attrRow = '1';
  wrap.dataset.attrKey = key || nuevoIdLocal();
  wrap.dataset.attrTipo = tipo;
  wrap.dataset.attrLabel = label;
  wrap.dataset.attrUnidadDefault = defMadre?.unidad || '';
  wrap.style.cssText = 'background:white;border:1px solid #f5d0fe;border-radius:8px;padding:8px 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap';

  const tipoDef = TIPOS_ATRIBUTO.find(t => t.value === tipo);
  const labelHtml = `
    <div style="display:flex;align-items:center;gap:5px;min-width:90px;flex-shrink:0">
      <span class="material-icons" style="font-size:16px;color:#86198f">${tipoDef?.icon || 'label'}</span>
      <strong style="font-size:13px;color:#86198f">${escapeHtml(label || tipo)}</strong>
    </div>`;

  const inp = `${estiloInput()};padding:7px 10px;font-size:13px`;
  let valorHtml = '';
  if (tipo === 'color') {
    const v = valor || {};
    valorHtml = `
      <input data-field="hex" type="color" value="${escapeHtml(v.hex || '#dc2626')}"
        style="width:38px;height:34px;padding:0;border:1px solid var(--border);border-radius:6px;cursor:pointer" />
      <input data-field="value" type="text" placeholder="Nombre del color (ej: Roja)"
        value="${escapeHtml(v.value || v.label || '')}"
        style="${inp};flex:1;min-width:120px" />`;
  } else if (tipo === 'tamano') {
    const v = valor || {};
    valorHtml = `
      <input data-field="ancho" type="number" step="any" min="0" placeholder="ancho"
        value="${v.ancho ?? ''}" style="${inp};width:80px" />
      <span style="color:var(--text-muted);font-size:13px;font-weight:600">×</span>
      <input data-field="alto" type="number" step="any" min="0" placeholder="alto"
        value="${v.alto ?? ''}" style="${inp};width:80px" />
      <select data-field="unidad" style="${inp};width:80px">
        ${UNIDADES_MEDIDA.map(u => `<option ${u === (v.unidad || 'cm') ? 'selected' : ''}>${u}</option>`).join('')}
      </select>`;
  } else if (tipo === 'gramaje' || tipo === 'medida' || tipo === 'numero') {
    const v = valor || {};
    const valStr = v.value !== undefined ? v.value : '';
    const unidad = v.unidad || defMadre?.unidad || '';
    const unidadInp = tipo === 'medida'
      ? `<select data-field="unidad" style="${inp};width:80px">${UNIDADES_MEDIDA.map(u => `<option ${u === unidad ? 'selected' : ''}>${u}</option>`).join('')}</select>`
      : `<input data-field="unidad" type="text" placeholder="unidad" value="${escapeHtml(unidad)}" style="${inp};width:80px" />`;
    valorHtml = `
      <input data-field="value" type="number" step="any" placeholder="valor"
        value="${valStr}" style="${inp};flex:1;min-width:90px" />
      ${unidadInp}`;
  } else {
    // texto, material, marca
    const v = (valor && typeof valor === 'object') ? (valor.value || valor.label || '') : (valor || '');
    valorHtml = `
      <input data-field="value" type="text" placeholder="Valor"
        value="${escapeHtml(String(v))}" style="${inp};flex:1;min-width:120px" />`;
  }

  wrap.innerHTML = `
    ${labelHtml}
    ${valorHtml}
    <button type="button" data-attr-remove title="Quitar característica"
      style="background:#fff0f0;border:1px solid #fca5a5;color:#dc3545;border-radius:6px;width:30px;height:30px;cursor:pointer;flex-shrink:0;font-size:14px">×</button>
  `;
  wrap.querySelector('[data-attr-remove]').onclick = (e) => {
    e.stopPropagation();
    wrap.remove();
    actualizarVisibilidadEmptyAttrs();
  };
  return wrap;
}

function guessTipoFromValue(v) {
  if (!v) return null;
  if (typeof v === 'object') {
    if ('hex' in v) return 'color';
    if ('ancho' in v && 'alto' in v) return 'tamano';
    if ('value' in v && 'unidad' in v) {
      const u = (v.unidad || '').toLowerCase();
      if (UNIDADES_MEDIDA.includes(u)) return 'medida';
      return 'gramaje';
    }
  }
  return 'texto';
}

function actualizarVisibilidadEmptyAttrs() {
  const cont = document.getElementById('lpVarAttrs');
  const empty = document.getElementById('lpVarAttrsEmpty');
  if (cont && empty) empty.style.display = cont.children.length === 0 ? 'block' : 'none';
  actualizarNombreSugerido();
}

function nombreSugeridoDesdeAttrs() {
  // Recorre las filas y arma "<v1> <v2> <v3>" usando los labels visibles
  const partes = [];
  document.querySelectorAll('#lpVarAttrs > [data-attr-row]').forEach(row => {
    const tipo = row.dataset.attrTipo;
    const get  = sel => row.querySelector(`[data-field="${sel}"]`);
    if (tipo === 'color') {
      const v = get('value')?.value.trim();
      if (v) partes.push(v);
    } else if (tipo === 'tamano') {
      const a = parseFloat(get('ancho')?.value);
      const b = parseFloat(get('alto')?.value);
      const u = get('unidad')?.value || '';
      if (!isNaN(a) && !isNaN(b)) partes.push(`${a}x${b}${u}`);
    } else if (tipo === 'medida' || tipo === 'gramaje' || tipo === 'numero') {
      const v = get('value')?.value.trim();
      const u = get('unidad')?.value.trim() || '';
      if (v) partes.push(u ? `${v}${u}` : v);
    } else {
      const v = get('value')?.value.trim();
      if (v) partes.push(v);
    }
  });
  return partes.join(' ').trim();
}

function actualizarNombreSugerido() {
  const inp = document.getElementById('lpVarNombre');
  const btn = document.getElementById('lpVarNombreSugerido');
  const txt = document.getElementById('lpVarNombreSugeridoTxt');
  if (!inp || !btn || !txt) return;
  const sug = nombreSugeridoDesdeAttrs();
  // Solo mostrar si: hay sugerencia, el input está vacío o tiene exactamente
  // una sugerencia previa (para que se actualice mientras escribe en chars)
  const actual = inp.value.trim();
  const previaUsada = inp.dataset.sugeridoUsado || '';
  const inputLibre = !actual || actual === previaUsada;
  if (sug && inputLibre && sug !== actual) {
    txt.textContent = `"${sug}"`;
    btn.style.display = 'flex';
  } else {
    btn.style.display = 'none';
  }
}

function leerAtributosVariante(definidosMadre) {
  const out = {};
  const definidosNuevos = [];
  document.querySelectorAll('#lpVarAttrs > [data-attr-row]').forEach(row => {
    const key = row.dataset.attrKey;
    const tipo = row.dataset.attrTipo;
    const label = row.dataset.attrLabel || key;
    if (!key) return;

    if (tipo === 'color') {
      const v   = row.querySelector('[data-field="value"]')?.value.trim() || '';
      const hex = row.querySelector('[data-field="hex"]')?.value || '';
      if (v) out[key] = { value: v, label: v, hex };
    } else if (tipo === 'tamano') {
      const ancho  = parseFloat(row.querySelector('[data-field="ancho"]')?.value);
      const alto   = parseFloat(row.querySelector('[data-field="alto"]')?.value);
      const unidad = row.querySelector('[data-field="unidad"]')?.value || 'cm';
      if (!isNaN(ancho) && !isNaN(alto)) {
        out[key] = { ancho, alto, unidad, label: `${ancho}x${alto} ${unidad}` };
      }
    } else if (tipo === 'medida' || tipo === 'gramaje' || tipo === 'numero') {
      const valStr = row.querySelector('[data-field="value"]')?.value.trim() || '';
      const unidad = row.querySelector('[data-field="unidad"]')?.value.trim() || '';
      if (valStr !== '') {
        const v = parseFloat(valStr);
        out[key] = isNaN(v) ? { value: valStr, unidad } : { value: v, unidad };
      }
    } else {
      const v = row.querySelector('[data-field="value"]')?.value.trim() || '';
      if (v) out[key] = v;
    }

    // Registrar para sumar al madre si todavía no está
    if (!definidosMadre.find(d => d.key === key)) {
      definidosNuevos.push({
        key, label,
        tipo,
        unidad: row.dataset.attrUnidadDefault || '',
      });
    }
  });
  return { atributos: out, definidosNuevos };
}

function mergeAtributosDefinidos(actual, nuevos) {
  const out = actual.slice();
  nuevos.forEach(n => {
    if (!out.find(a => a.key === n.key)) out.push(n);
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL · ELEGIR CARACTERÍSTICA NUEVA
// ─────────────────────────────────────────────────────────────────────────────
function mostrarPanelAddAttr(producto) {
  const yaUsadas = new Set(
    Array.from(document.querySelectorAll('#lpVarAttrs > [data-attr-row]')).map(r => r.dataset.attrKey)
  );

  // Construir popover encima del botón
  document.querySelector('#lpVarAttrPopover')?.remove();
  const pop = document.createElement('div');
  pop.id = 'lpVarAttrPopover';
  pop.style.cssText = 'position:fixed;z-index:1100;background:white;border:1.5px solid var(--border);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,0.15);padding:10px;width:300px;display:flex;flex-direction:column;gap:6px';

  const btnAdd = document.getElementById('lpVarAddAttr');
  const r = btnAdd.getBoundingClientRect();
  pop.style.top  = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, r.right - 300)}px`;

  // Sugeridas del madre primero (las que no están ya cargadas)
  const sugeridasMadre = (producto.atributos_definidos || []).filter(d => !yaUsadas.has(d.key));
  // Tipos populares
  const populares = TIPOS_ATRIBUTO.filter(t => t.popular);
  const otras     = TIPOS_ATRIBUTO.filter(t => !t.popular);

  const opcion = (label, hint, icon, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.cssText = 'background:#f8f9fa;border:1px solid var(--border);border-radius:8px;padding:9px 10px;cursor:pointer;font-family:inherit;text-align:left;display:flex;align-items:center;gap:9px;color:var(--text)';
    b.innerHTML = `
      <span class="material-icons" style="font-size:20px;color:#7c3aed">${icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700">${escapeHtml(label)}</div>
        ${hint ? `<div style="font-size:11px;color:var(--text-muted)">${escapeHtml(hint)}</div>` : ''}
      </div>`;
    b.onclick = (e) => { e.stopPropagation(); onClick(); pop.remove(); };
    return b;
  };

  if (sugeridasMadre.length) {
    const lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:10.5px;font-weight:800;color:#9333ea;letter-spacing:0.5px;text-transform:uppercase;margin:2px 4px 0';
    lbl.textContent = 'Ya usadas en esta categoría';
    pop.appendChild(lbl);
    sugeridasMadre.forEach(d => {
      const t = TIPOS_ATRIBUTO.find(x => x.value === d.tipo);
      pop.appendChild(opcion(d.label, t?.ejemplo || '', t?.icon || 'label', () => {
        const cont = document.getElementById('lpVarAttrs');
        cont.appendChild(filaAtributoVariante(d.key, d, null));
        actualizarVisibilidadEmptyAttrs();
      }));
    });
  }

  const sep = document.createElement('div');
  sep.style.cssText = 'font-size:10.5px;font-weight:800;color:var(--text-muted);letter-spacing:0.5px;text-transform:uppercase;margin:6px 4px 0';
  sep.textContent = 'Crear nueva';
  pop.appendChild(sep);

  populares.forEach(t => {
    pop.appendChild(opcion(t.label, t.ejemplo, t.icon, () => {
      const def = { key: t.value, label: t.label, tipo: t.value, unidad: '' };
      const cont = document.getElementById('lpVarAttrs');
      cont.appendChild(filaAtributoVariante(t.value, def, null));
      actualizarVisibilidadEmptyAttrs();
    }));
  });

  // "Más" expansible
  const masWrap = document.createElement('details');
  masWrap.style.cssText = 'margin-top:2px';
  masWrap.innerHTML = `<summary style="cursor:pointer;font-size:12px;color:var(--text-muted);padding:4px 6px;font-weight:600;list-style:none;display:flex;align-items:center;gap:4px"><span class="material-icons" style="font-size:14px">expand_more</span> Más tipos</summary>`;
  const masCont = document.createElement('div');
  masCont.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:4px';
  otras.forEach(t => {
    masCont.appendChild(opcion(t.label, t.ejemplo, t.icon, () => {
      const def = { key: t.value, label: t.label, tipo: t.value, unidad: '' };
      const cont = document.getElementById('lpVarAttrs');
      cont.appendChild(filaAtributoVariante(t.value, def, null));
      actualizarVisibilidadEmptyAttrs();
    }));
  });
  // Texto custom
  const customBtn = document.createElement('button');
  customBtn.type = 'button';
  customBtn.style.cssText = 'background:white;border:1px dashed var(--border);border-radius:8px;padding:8px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--primary)';
  customBtn.textContent = '+ Característica con nombre propio';
  customBtn.onclick = async (e) => {
    e.stopPropagation();
    pop.remove();
    const nombre = await promptDialog({
      title: 'Característica nueva',
      message: 'Nombre de la característica (ej: <em>Talle</em>, <em>Sabor</em>):',
      placeholder: 'Talle',
    });
    if (!nombre) return;
    const key = slugify(nombre);
    if (!key) return;
    const def = { key, label: nombre.trim(), tipo: 'texto', unidad: '' };
    const cont = document.getElementById('lpVarAttrs');
    cont.appendChild(filaAtributoVariante(key, def, null));
    actualizarVisibilidadEmptyAttrs();
  };
  masCont.appendChild(customBtn);
  masWrap.appendChild(masCont);
  pop.appendChild(masWrap);

  document.body.appendChild(pop);

  // Cerrar al click fuera
  setTimeout(() => {
    const close = (e) => {
      if (!pop.contains(e.target) && e.target !== btnAdd) {
        pop.remove();
        document.removeEventListener('mousedown', close, true);
      }
    };
    document.addEventListener('mousedown', close, true);
  }, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// FILA · PRESENTACIÓN (cómo se vende)
// ─────────────────────────────────────────────────────────────────────────────
function filaPresentacion(p = {}) {
  const wrap = document.createElement('div');
  wrap.dataset.presRow = '1';
  wrap.dataset.presId = p.id || nuevoIdLocal();
  wrap.style.cssText = 'background:white;border:1px solid #fde68a;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px';

  const tipoActual = p.tipo || 'unidad';
  const inp = `${estiloInput()};padding:7px 10px;font-size:13px`;

  // Chips de tipo
  const tipoChips = TIPOS_PRESENTACION.map(t => {
    const sel = t.value === tipoActual;
    return `
      <button type="button" data-pf-tipo="${t.value}" title="${escapeHtml(t.hint)}"
        style="background:${sel ? '#fbbf24' : 'white'};border:1.5px solid ${sel ? '#f59e0b' : '#fde68a'};color:${sel ? '#78350f' : '#a16207'};border-radius:8px;padding:5px 8px;font-size:11.5px;font-weight:${sel ? 800 : 600};cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:3px">
        <span class="material-icons" style="font-size:14px">${t.icon}</span>${escapeHtml(t.label)}
      </button>`;
  }).join('');

  wrap.innerHTML = `
    <!-- Línea 1: chips de tipo + etiqueta + × -->
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <div style="display:flex;gap:4px;flex-wrap:wrap" data-pf-chips>${tipoChips}</div>
      <input data-pf="tipo" type="hidden" value="${escapeHtml(tipoActual)}" />
      <button type="button" data-pres-remove title="Quitar"
        style="margin-left:auto;background:#fff0f0;border:1px solid #fca5a5;color:#dc3545;border-radius:6px;width:30px;height:30px;cursor:pointer;font-size:14px;flex-shrink:0">×</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr 110px 1fr 100px;gap:8px;align-items:end" data-pf-grid>
      <div>
        <label style="font-size:10.5px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.4px;display:block;margin-bottom:3px">Etiqueta</label>
        <input data-pf="label" type="text" placeholder="ej: Pack x10" value="${escapeHtml(p.label || '')}" style="${inp}" />
      </div>
      <div data-pf-equiv-wrap>
        <label style="font-size:10.5px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.4px;display:block;margin-bottom:3px" data-pf-equiv-label>Contiene</label>
        <input data-pf="equivalencia_base" type="number" step="any" min="0" placeholder="ej: 10" value="${p.equivalencia_base ?? ''}" style="${inp}" />
      </div>
      <div>
        <label style="font-size:10.5px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.4px;display:block;margin-bottom:3px">Stock</label>
        <input data-pf="stock" type="number" step="any" min="0" placeholder="0" value="${p.stock ?? ''}" style="${inp}" />
      </div>
      <div>
        <label style="font-size:10.5px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:0.4px;display:block;margin-bottom:3px">Precio</label>
        <input data-pf="precio_venta" type="number" step="0.01" min="0" placeholder="usa precio var." value="${p.precio_venta ?? ''}" style="${inp};font-weight:700" />
      </div>
    </div>

    <!-- Solo si rollo: línea de sueltos -->
    <div data-pf-sueltos style="display:none;background:#fefce8;border-radius:6px;padding:8px 10px;font-size:12px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:end">
        <div>
          <label style="font-size:10.5px;font-weight:700;color:#a16207;display:block;margin-bottom:3px">Sueltos del rollo abierto</label>
          <input data-pf="stock_sueltos" type="number" step="any" min="0" placeholder="0" value="${p.stock_sueltos ?? ''}" style="${inp}" />
        </div>
        <div>
          <label style="font-size:10.5px;font-weight:700;color:#a16207;display:block;margin-bottom:3px">Mín. sueltos</label>
          <input data-pf="stock_minimo_sueltos" type="number" step="any" min="0" placeholder="0" value="${p.stock_minimo_sueltos ?? ''}" style="${inp}" />
        </div>
      </div>
    </div>

    <!-- Avanzado -->
    <details style="background:#fffbeb;border:1px dashed #fde68a;border-radius:6px">
      <summary style="cursor:pointer;font-size:11.5px;color:#a16207;padding:7px 10px;font-weight:700;list-style:none;display:flex;align-items:center;gap:5px">
        <span class="material-icons" style="font-size:14px">tune</span> Avanzado · código · vinculación · mínimo
      </summary>
      <div style="padding:0 10px 10px;display:flex;flex-direction:column;gap:8px">
        <div style="display:grid;grid-template-columns:1fr 100px;gap:8px;align-items:end">
          <div>
            <label style="font-size:10.5px;font-weight:700;color:#a16207;display:block;margin-bottom:3px">Código de barras</label>
            <div style="display:flex;gap:4px">
              <input data-pf="codigo_barras" type="text" value="${escapeHtml(p.codigo_barras || generarCodigoBarras())}" style="${inp};flex:1;font-family:'Courier New',monospace" />
              <button type="button" data-pf-regen title="Regenerar" style="background:white;border:1px solid #fde68a;color:#a16207;border-radius:6px;padding:0 8px;cursor:pointer;font-size:13px">↻</button>
            </div>
          </div>
          <div>
            <label style="font-size:10.5px;font-weight:700;color:#a16207;display:block;margin-bottom:3px">Stock mín.</label>
            <input data-pf="stock_minimo" type="number" step="any" min="0" placeholder="0" value="${p.stock_minimo ?? ''}" style="${inp}" />
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 100px 1fr;gap:8px;align-items:end">
          <div>
            <label style="font-size:10.5px;font-weight:700;color:#a16207;display:block;margin-bottom:3px">Unidad de medida</label>
            <input data-pf="unidad_medida" type="text" placeholder="un / m / kg" value="${escapeHtml(p.unidad_medida || '')}" style="${inp}" />
          </div>
          <div>
            <label style="font-size:10.5px;font-weight:700;color:#a16207;display:block;margin-bottom:3px">SKU sufijo</label>
            <input data-pf="sku_sufijo" type="text" placeholder="opcional" value="${escapeHtml(p.sku_sufijo || '')}" style="${inp}" />
          </div>
          <div>
            <label style="font-size:10.5px;font-weight:700;color:#a16207;display:block;margin-bottom:3px">Costo (opcional)</label>
            <input data-pf="precio_costo" type="number" step="0.01" min="0" placeholder="usa el de variante" value="${p.precio_costo ?? ''}" style="${inp}" />
          </div>
        </div>
        <div>
          <label style="font-size:10.5px;font-weight:700;color:#a16207;display:block;margin-bottom:3px">Vincular a otra (corte a medida)</label>
          <select data-pf="vinculada_a" style="${inp}">
            <option value="">— Independiente —</option>
          </select>
          <input data-pf="stock_modo" type="hidden" value="${escapeHtml(p.stock_modo || 'independiente')}" />
          <p data-pf-vinculada-hint style="margin:4px 0 0;font-size:10.5px;color:#a16207;font-style:italic"></p>
        </div>
      </div>
    </details>
  `;

  // Eventos
  wrap.querySelector('[data-pres-remove]').onclick = async (e) => {
    e.stopPropagation();
    const lbl = wrap.querySelector('[data-pf="label"]')?.value.trim() || 'esta forma';
    const ok = await confirmDialog({
      title: 'Quitar forma de venta',
      message: `¿Quitar <strong>"${lbl}"</strong>? Se va a perder el stock y precio cargados.`,
      confirmText: 'Quitar',
      danger: true,
    });
    if (ok) wrap.remove();
  };
  wrap.querySelector('[data-pf-regen]').onclick = (e) => {
    e.stopPropagation();
    wrap.querySelector('[data-pf="codigo_barras"]').value = generarCodigoBarras();
  };
  // Click en chip de tipo
  wrap.querySelectorAll('[data-pf-tipo]').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      const v = b.dataset.pfTipo;
      const previo = wrap.querySelector('[data-pf="tipo"]').value;
      wrap.querySelector('[data-pf="tipo"]').value = v;
      // Repintar chips (para reflejar selección)
      wrap.querySelectorAll('[data-pf-tipo]').forEach(x => {
        const sel = x.dataset.pfTipo === v;
        x.style.background = sel ? '#fbbf24' : 'white';
        x.style.borderColor = sel ? '#f59e0b' : '#fde68a';
        x.style.color       = sel ? '#78350f' : '#a16207';
        x.style.fontWeight  = sel ? 800 : 600;
      });
      ajustarLayoutPresentacion(wrap);
      recalcEtiquetaAuto(wrap);
      // Si cambió a Pack/Caja/Rollo, ofrecer auto-agregar la complementaria
      if (previo !== v) sugerirComplementaria(wrap, v);
    };
  });
  // Etiqueta auto cuando cambia "trae" o la unidad
  const equivInp = wrap.querySelector('[data-pf="equivalencia_base"]');
  if (equivInp) equivInp.addEventListener('input', () => recalcEtiquetaAuto(wrap));
  const unidadMedidaInp = wrap.querySelector('[data-pf="unidad_medida"]');
  if (unidadMedidaInp) unidadMedidaInp.addEventListener('input', () => recalcEtiquetaAuto(wrap));
  // Si el usuario edita la etiqueta a mano, no la pisamos más
  const labelInp = wrap.querySelector('[data-pf="label"]');
  if (labelInp) {
    labelInp.addEventListener('input', () => {
      if (labelInp.value.trim() !== (labelInp.dataset.autoPrev || '')) {
        delete labelInp.dataset.autoPrev;
      }
    });
  }
  // Vinculación
  const vincSel = wrap.querySelector('[data-pf="vinculada_a"]');
  if (vincSel) {
    if (p.vinculada_a) vincSel.dataset.preselect = p.vinculada_a;
    refreshVinculadaSelect(wrap);
    vincSel.onchange = () => onVinculadaChange(wrap);
    vincSel.onmousedown = () => refreshVinculadaSelect(wrap);
    onVinculadaChange(wrap);
  }
  // Layout inicial según tipo
  ajustarLayoutPresentacion(wrap);
  recalcEtiquetaAuto(wrap);
  return wrap;
}

// Recalcula la etiqueta automática "Pack x15", "Caja x100", "Rollo 50m", etc.
// según tipo + equivalencia. Solo pisa el input si está vacío o si su valor
// coincide con el último auto generado (para no romper lo que el user escribe).
function recalcEtiquetaAuto(wrap) {
  if (!wrap) return;
  const labelInp = wrap.querySelector('[data-pf="label"]');
  if (!labelInp) return;
  const tipo = wrap.querySelector('[data-pf="tipo"]')?.value || 'unidad';
  const equiv = parseFloat(wrap.querySelector('[data-pf="equivalencia_base"]')?.value);
  const unidad = (wrap.querySelector('[data-pf="unidad_medida"]')?.value || '').trim()
    || (TIPOS_PRESENTACION.find(t => t.value === tipo)?.unidadBase || '');

  let auto;
  if ((tipo === 'pack' || tipo === 'caja') && equiv > 0) {
    auto = `${tipo === 'pack' ? 'Pack' : 'Caja'} x${equiv}`;
  } else if (tipo === 'rollo' && equiv > 0) {
    auto = `Rollo ${equiv}${unidad || 'm'}`;
  } else {
    auto = sugerirLabel(tipo);
  }

  const previo = labelInp.dataset.autoPrev || '';
  const actual = labelInp.value.trim();
  if (!actual || actual === previo) {
    labelInp.value = auto;
    labelInp.dataset.autoPrev = auto;
  }
}

// Cuando se selecciona Pack/Caja → si no hay ya una "Unidad" en la fila,
// agrega una vinculada a la actual. Lo mismo para Rollo → "Metro".
// Solo dispara para filas nuevas (sin precio cargado todavía) para no
// auto-agregar al editar variantes existentes.
function sugerirComplementaria(wrap, nuevoTipo) {
  const cont = document.getElementById('lpVarPresentaciones');
  if (!cont) return;
  // Detectar si la fila es "nueva" — heurística: no tiene id que ya esté
  // guardado en Firestore (los seed son "seed_*", los locales "tmp_*").
  const meId = wrap.dataset.presId;
  const esNueva = !meId || meId.startsWith('tmp_');
  if (!esNueva) return;

  const complementoTipo = (nuevoTipo === 'rollo') ? 'metro'
    : (nuevoTipo === 'pack' || nuevoTipo === 'caja') ? 'unidad'
    : null;
  if (!complementoTipo) return;

  // ¿Ya existe en otra fila?
  const yaHay = Array.from(cont.querySelectorAll('[data-pres-row]')).some(row => {
    if (row === wrap) return false;
    return row.querySelector('[data-pf="tipo"]')?.value === complementoTipo;
  });
  if (yaHay) return;

  // Crear la complementaria, vinculada a esta
  const idEsta = wrap.dataset.presId || nuevoIdLocal();
  wrap.dataset.presId = idEsta;
  const complementaria = filaPresentacion({
    tipo: complementoTipo,
    label: complementoTipo === 'metro' ? 'Por metro (corte)' : 'Por unidad',
    stock_modo: 'vinculado',
    vinculada_a: idEsta,
  });
  cont.appendChild(complementaria);
  // Forzar refresh del select de vinculación para que aparezca como ya seleccionada
  refreshVinculadaSelect(complementaria);
  onVinculadaChange(complementaria);
}

function ajustarLayoutPresentacion(wrap) {
  const tipo = wrap.querySelector('[data-pf="tipo"]')?.value || 'unidad';
  const def  = TIPOS_PRESENTACION.find(t => t.value === tipo);
  const equivWrap  = wrap.querySelector('[data-pf-equiv-wrap]');
  const equivLbl   = wrap.querySelector('[data-pf-equiv-label]');
  const sueltos    = wrap.querySelector('[data-pf-sueltos]');
  const labelInp   = wrap.querySelector('[data-pf="label"]');
  const unidadInp  = wrap.querySelector('[data-pf="unidad_medida"]');

  // Equivalencia: solo para pack/caja/rollo
  if (def?.wantsContent) {
    equivWrap.style.visibility = 'visible';
    if (tipo === 'rollo') equivLbl.textContent = 'Mide';
    else if (tipo === 'caja') equivLbl.textContent = 'Trae';
    else equivLbl.textContent = 'Trae';
  } else {
    equivWrap.style.visibility = 'hidden';
  }
  // Sueltos: solo para rollo
  sueltos.style.display = tipo === 'rollo' ? 'block' : 'none';

  // Sugerir etiqueta y unidad si están vacías
  if (labelInp && !labelInp.value.trim()) labelInp.placeholder = sugerirLabel(tipo);
  if (unidadInp && !unidadInp.value.trim()) unidadInp.placeholder = def?.unidadBase || '';
}

function sugerirLabel(tipo) {
  switch (tipo) {
    case 'unidad': return 'Unidad';
    case 'pack':   return 'Pack x10';
    case 'caja':   return 'Caja x100';
    case 'rollo':  return 'Rollo';
    case 'metro':  return 'Por metro';
    case 'cm':     return 'Por cm';
    case 'kg':     return 'Por kilo';
    case 'gramo':  return 'Por gramo';
    default:       return 'Forma';
  }
}

function leerPresentacionesVariante() {
  const out = [];
  document.querySelectorAll('#lpVarPresentaciones [data-pres-row]').forEach(row => {
    const get = sel => row.querySelector(`[data-pf="${sel}"]`)?.value ?? '';
    const tipo = get('tipo');
    if (!tipo) return;
    const labelTxt = get('label').trim();
    const unidadTxt = get('unidad_medida').trim() ||
      (TIPOS_PRESENTACION.find(t => t.value === tipo)?.unidadBase || '');
    out.push({
      id:                row.dataset.presId,
      tipo,
      label:             labelTxt || sugerirLabel(tipo),
      codigo_barras:     get('codigo_barras').trim(),
      sku_sufijo:        get('sku_sufijo').trim(),
      unidad_medida:     unidadTxt,
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

function refreshVinculadaSelect(wrap) {
  const sel = wrap.querySelector('[data-pf="vinculada_a"]');
  if (!sel) return;
  const meId = wrap.dataset.presId;
  const cont = document.getElementById('lpVarPresentaciones');
  if (!cont) return;
  const actual = sel.value || sel.dataset.preselect || '';
  sel.innerHTML = '<option value="">— Independiente —</option>';
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
  const hintEl = wrap.querySelector('[data-pf-vinculada-hint]');
  if (hermanas === 0 && hintEl && !sel.value) {
    hintEl.textContent = 'Para usar "corte a medida" agregá primero un rollo/pack/caja con su tamaño y precio. Esta forma podrá descontar de ese contenedor.';
  }
}

function onVinculadaChange(wrap) {
  const fuenteId = wrap.querySelector('[data-pf="vinculada_a"]')?.value || '';
  const modoInp  = wrap.querySelector('[data-pf="stock_modo"]');
  const ventaInp = wrap.querySelector('[data-pf="precio_venta"]');
  const hint     = wrap.querySelector('[data-pf-vinculada-hint]');
  if (!fuenteId) {
    if (modoInp && modoInp.value === 'vinculado') modoInp.value = 'independiente';
    if (ventaInp) ventaInp.placeholder = 'usa precio var.';
    if (hint) hint.textContent = '';
    return;
  }
  if (modoInp) modoInp.value = 'vinculado';
  const cont = document.getElementById('lpVarPresentaciones');
  const src  = cont?.querySelector(`[data-pres-row][data-pres-id="${fuenteId}"]`);
  const srcPrecio = parseFloat(src?.querySelector('[data-pf="precio_venta"]')?.value || '0') || 0;
  const srcEquiv  = parseFloat(src?.querySelector('[data-pf="equivalencia_base"]')?.value || '0') || 0;
  const srcUnidad = src?.querySelector('[data-pf="unidad_medida"]')?.value || '';
  if (srcPrecio > 0 && srcEquiv > 0) {
    const auto = srcPrecio / srcEquiv * FRACCION_MARGIN;
    if (ventaInp) ventaInp.placeholder = `auto: $${auto.toFixed(2)}`;
    if (hint) hint.textContent = `Auto: $${srcPrecio.toFixed(2)} ÷ ${srcEquiv}${srcUnidad} × ${FRACCION_MARGIN} = $${auto.toFixed(2)} por ${srcUnidad || 'unidad'}.`;
  } else {
    if (ventaInp) ventaInp.placeholder = '$ (cargá precio + tamaño en la fuente)';
    if (hint) hint.textContent = 'Cargá Precio y Mide/Trae en la forma fuente para calcular el precio automático.';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COSTO ↔ MARGEN ↔ VENTA
// ─────────────────────────────────────────────────────────────────────────────
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
  costoEl.oninput  = () => recalc('costo');
  margenEl.oninput = () => recalc('margen');
  ventaEl.oninput  = () => recalc('venta');
  if (redondeoBtn) {
    redondeoBtn.onclick = () => {
      const v = parseFloat(ventaEl.value);
      if (!(v > 0)) return;
      ventaEl.value = (Math.round(v / 100) * 100).toFixed(2);
      recalc('venta');
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DESCUENTOS — UI fila + sync + resolución
// ─────────────────────────────────────────────────────────────────────────────
function filaDescuento(d = {}) {
  const wrap = document.createElement('div');
  wrap.dataset.discRow = '1';
  wrap.dataset.discId  = d._id || '';
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
        ${lblD('Etiqueta', 'Descripción visible (ej: "Promo verano").')}
        <input data-df="etiqueta" type="text" placeholder="opcional" value="${escapeHtml(d.etiqueta || '')}" style="${inp}" />
      </div>
      <div>
        ${lblD('Valor', 'Monto o porcentaje según tipo.')}
        <input data-df="valor" type="number" step="any" min="0" placeholder="ej: 10" value="${d.valor ?? ''}" style="${inp};font-weight:700;color:#5b21b6" />
      </div>
      <div>
        ${lblD('Prioridad', 'Mayor prioridad gana si hay varios activos.')}
        <input data-df="prioridad" type="number" step="1" placeholder="0" value="${d.prioridad ?? 0}" style="${inp}" />
      </div>
      <button type="button" data-df-remove title="Eliminar"
        style="background:#fff0f0;border:1px solid #fca5a5;color:#dc3545;border-radius:6px;padding:0;cursor:pointer;font-size:16px;height:30px">×</button>
    </div>

    <div data-df-cant style="display:${showCant ? 'block' : 'none'}">
      ${lblD('Cantidad mín. para aplicar', 'El descuento se activa cuando la venta supera esta cantidad.')}
      <input data-df="cantidad_min" type="number" step="any" min="0" placeholder="ej: 5" value="${d.cantidad_min ?? ''}" style="${inp}" />
    </div>

    <div data-df-fechas style="display:${showFechas ? 'grid' : 'none'};grid-template-columns:1fr 1fr;gap:6px;align-items:end">
      <div>${lblD('Desde', 'Vacío = sin límite.')}<input data-df="desde" type="date" value="${escapeHtml(d.desde || '')}" style="${inp}" /></div>
      <div>${lblD('Hasta', 'Vacío = sin límite.')}<input data-df="hasta" type="date" value="${escapeHtml(d.hasta || '')}" style="${inp}" /></div>
    </div>

    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#5b21b6;cursor:pointer;margin-top:2px">
      <input data-df="activo" type="checkbox" ${d.activo === false ? '' : 'checked'} /> Activo
    </label>
  `;

  wrap.querySelector('[data-df="tipo"]').onchange = (e) => {
    const t = e.target.value;
    wrap.querySelector('[data-df-cant]').style.display   = t === 'por_cantidad' ? 'block' : 'none';
    wrap.querySelector('[data-df-fechas]').style.display = t === 'por_fecha'    ? 'grid'  : 'none';
  };
  wrap.querySelector('[data-df-remove]').onclick = async (e) => {
    e.stopPropagation();
    const ok = await confirmDialog({
      title: 'Eliminar descuento',
      message: '¿Querés eliminar este descuento?',
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
    const num = el => { const s = (el?.value || '').trim(); if (s === '') return null; const n = parseFloat(s); return isNaN(n) ? null : n; };
    const tipo = get('tipo')?.value || 'porcentaje';
    const valor = num(get('valor'));
    if (valor === null) return;
    const obj = {
      _id:        row.dataset.discId || null,
      product_id: productoId,
      scope_type: scopeType,
      scope_id:   scopeId,
      tipo,
      valor,
      etiqueta:   get('etiqueta')?.value.trim() || '',
      prioridad:  num(get('prioridad')) ?? 0,
      activo:     !!get('activo')?.checked,
      stackable:  false,
    };
    if (tipo === 'por_cantidad') obj.cantidad_min = num(get('cantidad_min')) ?? 1;
    if (tipo === 'por_fecha') {
      obj.desde = get('desde')?.value || '';
      obj.hasta = get('hasta')?.value || '';
    }
    out.push(obj);
  });
  return out;
}

async function sincronizarDescuentos(db, originales, nuevos) {
  const idsNuevos = new Set(nuevos.filter(n => n._id).map(n => n._id));
  const aBorrar   = originales.filter(o => !idsNuevos.has(o._id));
  for (const o of aBorrar) await deleteDoc(doc(db, COL_DISC, o._id));
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

async function cargarDescuentos(db, productoId) {
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

function descuentoEfectivo(producto, nodo, presentacion, todosLosNodos, descuentos, cantidad = 1) {
  if (!descuentos?.length) return null;
  const aplicaA = (d, scopeType, scopeId) => {
    if (d.scope_type !== scopeType || d.scope_id !== scopeId) return false;
    if (!descuentoVigenteHoy(d)) return false;
    if (d.tipo === 'por_cantidad' && cantidad < (d.cantidad_min || 1)) return false;
    return true;
  };
  const elegirGanador = (cands) => cands.length
    ? cands.slice().sort((a, b) => (b.prioridad || 0) - (a.prioridad || 0))[0]
    : null;

  if (presentacion?.id) {
    const g = elegirGanador(descuentos.filter(d => aplicaA(d, 'presentation', presentacion.id)));
    if (g) return g;
  }
  if (nodo) {
    const path = nodo.path || [];
    for (let i = path.length - 1; i >= 1; i--) {
      const g = elegirGanador(descuentos.filter(d => aplicaA(d, 'node', path[i])));
      if (g) return g;
    }
  }
  return elegirGanador(descuentos.filter(d => aplicaA(d, 'product', producto._id)));
}

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

// ─────────────────────────────────────────────────────────────────────────────
// MODAL · STOCK (live, mismo módulo que la versión anterior)
// ─────────────────────────────────────────────────────────────────────────────
async function abrirModalStock(db, producto) {
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
            Cambios sincronizados en tiempo real con el POS. Cada ajuste queda registrado.
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
  let stockSnapshot = new Map();

  const qNodes = query(collection(db, COL_NODES), where('product_id', '==', producto._id));
  const unsubscribe = onSnapshot(qNodes, snap => {
    const nodosCache = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
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
    const hojas = nodos.filter(n => n.es_hoja !== false || (n.presentaciones || []).length > 0)
      .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));

    if (!hojas.length) {
      body.innerHTML = `
        <div style="text-align:center;padding:40px 20px;color:var(--text-muted)">
          <span class="material-icons" style="font-size:48px;color:#cbd5e1;display:block;margin-bottom:8px">inventory_2</span>
          Esta categoría todavía no tiene variantes cargadas.
        </div>`;
      return;
    }

    body.innerHTML = hojas.map(n => filaStockHoja(n)).join('');
    body.querySelectorAll('[data-stock-save]').forEach(btn => {
      btn.onclick = () => guardarPresStock(db, producto, btn.dataset.nodeId, btn.dataset.presId, usuarioActual, stockSnapshot);
    });
    body.querySelectorAll('[data-stock-remove]').forEach(btn => {
      btn.onclick = () => quitarPresStock(db, producto, btn.dataset.nodeId, btn.dataset.presId);
    });
    body.querySelectorAll('[data-stock-add]').forEach(btn => {
      btn.onclick = () => agregarPresStock(db, producto, btn.dataset.nodeId);
    });
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
    const presHtml = presentaciones.length
      ? presentaciones.map(p => filaPresStock(nodo._id, p)).join('')
      : `<div style="padding:14px 16px;color:var(--text-muted);font-size:13px;font-style:italic">Sin formas de venta cargadas. Agregá una con el botón de la derecha.</div>`;
    return `
      <div style="background:white;border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:10px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:200px">
            <span class="material-icons" style="color:#7c3aed;font-size:18px">style</span>
            <strong style="font-size:14px">${escapeHtml(nodo.nombre || '—')}</strong>
            ${(nodo.atributos && Object.keys(nodo.atributos).length)
              ? `<span style="font-size:11px;color:var(--text-muted)">${escapeHtml(_resumenAtributos(nodo.atributos))}</span>`
              : ''}
          </div>
          <button type="button" data-stock-add data-node-id="${nodo._id}"
            style="background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;border-radius:6px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:4px">
            <span class="material-icons" style="font-size:14px">add</span> Forma de venta
          </button>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">${presHtml}</div>
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
          title="Guardar"
          style="background:var(--primary);color:white;border:none;border-radius:6px;width:36px;height:36px;cursor:pointer;display:flex;align-items:center;justify-content:center">
          <span class="material-icons" style="font-size:18px">save</span>
        </button>
        <button type="button" data-stock-remove data-node-id="${nodeId}" data-pres-id="${escapeHtml(p.id || '')}"
          title="Eliminar"
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
          ${disabled ? 'disabled title="Stock vinculado"' : ''}
          style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px;text-align:right;font-family:'Consolas','Menlo',monospace;${disabled ? 'background:#f1f5f9;color:#94a3b8' : 'background:white'}" />
      </label>`;
  }

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
  if (cambios.stock !== null && cambios.stock < 0) {
    return alertDialog({ title: 'Stock inválido', message: 'El stock no puede ser negativo.', type: 'warning' });
  }

  const btn = row.querySelector('[data-stock-save]');
  const ogHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="material-icons" style="font-size:16px;animation:spin 1s linear infinite">refresh</span>';

  try {
    const ref = doc(db, COL_NODES, nodeId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error('La variante ya no existe.');
    const nodo = snap.data();
    const presentaciones = (nodo.presentaciones || []).slice();
    const idx = presentaciones.findIndex(pp => (pp.id || '') === presId);
    if (idx < 0) throw new Error('La forma de venta ya no existe.');

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

    const deltaStock   = (Number(presActualizada.stock)         || 0) - (Number(prev.stock)         || 0);
    const deltaSueltos = (Number(presActualizada.stock_sueltos) || 0) - (Number(prev.stock_sueltos) || 0);
    if (deltaStock !== 0 || deltaSueltos !== 0) {
      try {
        await addDoc(collection(db, 'mp_stock_movements'), {
          product_id:      producto._id,
          node_id:         nodeId,
          presentation_id: presId,
          delta:           deltaStock,
          delta_sueltos:   deltaSueltos,
          motivo:          'ajuste_web',
          usuario,
          ts:              serverTimestamp(),
        });
      } catch (e) { /* no bloquear */ }
    }

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
  const lbl = pres?.label || pres?.tipo || 'esta forma';

  const ok = await confirmDialog({
    title: 'Eliminar forma de venta',
    message: `¿Eliminar <strong>"${lbl}"</strong> de <strong>"${nodo.nombre}"</strong>?<br><br>Se va a perder el stock cargado.`,
    confirmText: 'Eliminar',
    danger: true,
  });
  if (!ok) return;

  try {
    const presentaciones = (nodo.presentaciones || []).filter(pp => (pp.id || '') !== presId);
    await updateDoc(ref, { presentaciones, actualizado: serverTimestamp() });
    invalidateCacheByPrefix('mp:');
  } catch (err) {
    await alertDialog({ title: 'Error al eliminar', message: err.message, type: 'error' });
  }
}

async function agregarPresStock(db, producto, nodeId) {
  const tipo = await promptDialog({
    title: 'Nueva forma de venta',
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
    if (!snap.exists()) throw new Error('La variante ya no existe.');
    const nodo = snap.data();
    const tipoDef = TIPOS_PRESENTACION.find(t => t.value === tipoNorm);
    const nueva = {
      id:              nuevoIdLocal(),
      tipo:            tipoNorm,
      label:           label.trim() || tipoNorm,
      codigo_barras:   generarCodigoBarras(),
      unidad_medida:   tipoDef?.unidadBase || (tipoNorm === 'unidad' || tipoNorm === 'pack' || tipoNorm === 'caja' ? 'un' : ''),
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
    await alertDialog({ title: 'Error al agregar', message: err.message, type: 'error' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEED — productos de ejemplo
// ─────────────────────────────────────────────────────────────────────────────
async function cargarSeed(db) {
  const cant = SEED_DATA.length;
  const ok = await confirmDialog({
    title: 'Cargar productos de ejemplo',
    message: `¿Cargar <strong>${cant} categoría(s)</strong> de ejemplo?<br><br>Quedan marcadas como <code>_seed</code> para borrarlas juntas.`,
    confirmText: 'Cargar',
  });
  if (!ok) return;

  const btn = document.getElementById('lpBtnCargarSeed');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-icons" style="font-size:18px;animation:spin 1s linear infinite">refresh</span> Cargando...'; }

  try {
    for (const p of SEED_DATA) {
      const codigo = generarCodigoBarras();
      const prodRef = await addDoc(collection(db, COL_PROD), {
        nombre: p.nombre, slug: slugify(p.nombre), codigo_barras: codigo,
        rubro: p.rubro || '', categoria: p.categoria || '', marca: p.marca || '',
        descripcion: p.descripcion || '',
        atributos_definidos: p.atributos_definidos || [],
        _seed: true, creado: serverTimestamp(), actualizado: serverTimestamp(),
      });
      await updateDoc(prodRef, { id: prodRef.id });

      for (const raiz of (p.raices || [])) {
        await crearNodoSeed(db, prodRef.id, null, [prodRef.id], raiz);
      }

      for (const d of (p.descuentos || [])) {
        await addDoc(collection(db, COL_DISC), {
          ...d, product_id: prodRef.id, scope_id: prodRef.id,
          stackable: false, _seed: true, creado: serverTimestamp(),
        });
      }
    }

    invalidateCacheByPrefix('mp:');
    await alertDialog({ title: 'Productos cargados', message: `Se cargaron <strong>${cant}</strong> categorías de ejemplo.`, type: 'success' });
    await renderListaCategorias(db);
  } catch (err) {
    await alertDialog({ title: 'Error cargando seed', message: err.message, type: 'error' });
  }
}

async function crearNodoSeed(db, productId, parentId, parentPath, nodoSpec) {
  const tieneHijos = Array.isArray(nodoSpec.hijos) && nodoSpec.hijos.length > 0;
  const presentaciones = (nodoSpec.presentaciones || []).map(pp => ({
    ...pp,
    id: pp.id || nuevoIdLocal(),
    codigo_barras: pp.codigo_barras || generarCodigoBarras(),
    activo: pp.activo !== false,
  }));

  const ref = doc(collection(db, COL_NODES));
  const path = [...parentPath, ref.id];
  const nodoData = {
    id: ref.id, product_id: productId, parent_id: parentId,
    nombre: nodoSpec.nombre, sku_sufijo: nodoSpec.sku_sufijo || '',
    atributos: nodoSpec.atributos || {},
    precio: nodoSpec.precio || { costo: null, venta: null },
    presentaciones,
    hereda_de_padre: nodoSpec.hereda_de_padre || { categoria: true, marca: true, descripcion: true },
    overrides: nodoSpec.overrides || {},
    es_hoja: !tieneHijos,
    depth: path.length - 2,
    path,
    _seed: true,
    creado: serverTimestamp(), actualizado: serverTimestamp(),
  };
  await setDoc(ref, nodoData);

  for (const d of (nodoSpec.descuentos || [])) {
    await addDoc(collection(db, COL_DISC), {
      ...d, product_id: productId, scope_type: 'node', scope_id: ref.id,
      stackable: false, _seed: true, creado: serverTimestamp(),
    });
  }
  for (const h of (nodoSpec.hijos || [])) {
    await crearNodoSeed(db, productId, ref.id, path, h);
  }
}

async function borrarSeed(db) {
  const ok = await confirmDialog({
    title: 'Borrar productos de ejemplo',
    message: '¿Borrar <strong>TODOS</strong> los productos de ejemplo (marcados <code>_seed</code>)?<br><br>No afecta a los cargados a mano.',
    confirmText: 'Borrar todos',
    danger: true,
  });
  if (!ok) return;

  const btn = document.getElementById('lpBtnBorrarSeed');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-icons" style="font-size:16px;animation:spin 1s linear infinite">refresh</span> Borrando...'; }

  try {
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
    await alertDialog({ title: 'Seed eliminado', message: `Se eliminaron <strong>${total}</strong> documento(s) seed.`, type: 'success' });
    await renderListaCategorias(db);
  } catch (err) {
    await alertDialog({ title: 'Error borrando seed', message: err.message, type: 'error' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENTOS GLOBALES
// ─────────────────────────────────────────────────────────────────────────────
function setupGlobalEvents(db) {
  // Cierre de modales: × y data-close="X"
  document.querySelectorAll('[data-close]').forEach(b => {
    b.onclick = () => cerrarModal(b.dataset.close);
  });
  // Cierre por click fuera (en el overlay vacío). Usamos mousedown + mouseup
  // para evitar cerrar accidentalmente cuando el usuario hace click en un
  // elemento que se elimina durante el handler (ej: × de una fila), lo que
  // hacía que el evento "termine" sobre el overlay y disparara el cierre.
  ['lpCatModal', 'lpVarModal', 'lpLoteModal'].forEach(mid => {
    const m = document.getElementById(mid);
    if (!m) return;
    let downOnOverlay = false;
    m.addEventListener('mousedown', e => { downOnOverlay = (e.target === m); });
    m.addEventListener('mouseup',   e => {
      if (downOnOverlay && e.target === m) m.style.display = 'none';
      downOnOverlay = false;
    });
  });

  // Form Categoría
  document.getElementById('lpCatForm').onsubmit = (e) => { e.preventDefault(); guardarCategoria(db); };
  document.getElementById('lpCatCodigoReGen').onclick = () => {
    document.getElementById('lpCatCodigo').value = generarCodigoBarras();
  };
  document.getElementById('lpCatAddDisc').onclick = (e) => {
    e.preventDefault();
    document.getElementById('lpCatDescuentos').appendChild(filaDescuento());
  };

  // Form Variante
  document.getElementById('lpVarForm').onsubmit = (e) => { e.preventDefault(); guardarVariante(db); };
  document.getElementById('lpVarAddAttr').onclick = (e) => {
    e.preventDefault();
    if (!_state.productoActivo) return;
    mostrarPanelAddAttr(_state.productoActivo);
  };
  document.getElementById('lpVarAddPres').onclick = (e) => {
    e.preventDefault();
    document.getElementById('lpVarPresentaciones').appendChild(filaPresentacion());
  };
  document.getElementById('lpVarAddDisc').onclick = (e) => {
    e.preventDefault();
    document.getElementById('lpVarDescuentos').appendChild(filaDescuento());
  };
  // Auto-sugerir nombre cuando cambian las características
  document.getElementById('lpVarAttrs').addEventListener('input', actualizarNombreSugerido);
  document.getElementById('lpVarAttrs').addEventListener('change', actualizarNombreSugerido);
  // Click en el botón "Usar [sugerido]" → poner el texto en el input
  document.getElementById('lpVarNombreSugerido').onclick = () => {
    const sug = nombreSugeridoDesdeAttrs();
    const inp = document.getElementById('lpVarNombre');
    if (sug && inp) {
      inp.value = sug;
      inp.dataset.sugeridoUsado = sug;
      actualizarNombreSugerido();
      inp.focus();
    }
  };
  // Si el usuario edita el nombre a mano, deja de auto-sugerir aunque cambien chars
  document.getElementById('lpVarNombre').addEventListener('input', () => {
    const inp = document.getElementById('lpVarNombre');
    if (inp.value.trim() !== (inp.dataset.sugeridoUsado || '')) {
      delete inp.dataset.sugeridoUsado;
    }
    actualizarNombreSugerido();
  });

  // Form Lote (modo rápido)
  document.getElementById('lpLoteForm').onsubmit = (e) => {
    e.preventDefault();
    crearLoteVariantes();
  };
  document.getElementById('lpLoteValores').addEventListener('input', loteActualizarConteo);
  // Si cambia el stock global, refrescar los placeholders de las filas individuales
  document.getElementById('lpLoteStock').addEventListener('input', () => {
    const vals = loteParsearValores(document.getElementById('lpLoteValores').value);
    loteRepintarStockIndividual(vals);
  });
  document.getElementById('lpLoteEquiv').addEventListener('input', loteActualizarHintAutoMetro);
  document.getElementById('lpLoteEquivUnidad').addEventListener('input', loteActualizarHintAutoMetro);
  // El precio puede cambiar por cargar venta directo o por costo×margen.
  // Usamos setTimeout(0) para correr DESPUÉS del oninput de setupCostoMargenVenta,
  // así leemos el precio recién recalculado.
  document.getElementById('lpLotePrecio').addEventListener('input', () => setTimeout(loteActualizarHintAutoMetro, 0));
  document.getElementById('lpLoteCosto').addEventListener('input', () => setTimeout(loteActualizarHintAutoMetro, 0));
  document.getElementById('lpLoteMargen').addEventListener('input', () => setTimeout(loteActualizarHintAutoMetro, 0));
  // Toggle del sub-input editable según el checkbox
  document.getElementById('lpLoteAutoMetro').addEventListener('change', loteActualizarVisibilidadPrecioAuto);
  // Redondeo del sub-precio editable
  document.getElementById('lpLoteAutoPrecioRedondeo').onclick = () => {
    const inp = document.getElementById('lpLoteAutoPrecio');
    let v = parseFloat(inp.value);
    // Si está vacío, usar el auto como base antes de redondear
    if (!(v > 0)) {
      const equiv = parseFloat(document.getElementById('lpLoteEquiv').value) || 0;
      const precio = parseFloat(document.getElementById('lpLotePrecio').value) || 0;
      if (equiv > 0 && precio > 0) v = precio / equiv * FRACCION_MARGIN;
    }
    if (!(v > 0)) return;
    inp.value = (Math.round(v / 100) * 100).toFixed(2);
  };
}

function cerrarModal(name) {
  const map = { cat: 'lpCatModal', var: 'lpVarModal', lote: 'lpLoteModal' };
  const el = document.getElementById(map[name]);
  if (el) el.style.display = 'none';
}
