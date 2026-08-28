/**
 * Página: Fiados — cuenta corriente de clientes.
 *
 * Comparte las colecciones `fiado_clientes` / `fiado_items` / `fiado_pagos`
 * con el POS de escritorio en tiempo real: lo que se carga acá aparece en la
 * pestaña Fiados del POS y al revés.
 *
 * Qué se puede hacer desde acá:
 *   - Alta y edición de clientes (solo el nombre es obligatorio).
 *   - Cargar productos a nombre de un cliente (del catálogo o a mano, con
 *     cantidad decimal para lo que se vende por metro/kilo).
 *   - Corregir o quitar líneas pendientes.
 *   - Ver la deuda, el saldo a favor y todo el historial.
 *
 * El COBRO se hace desde el POS: es el que arma la venta y la mete en la caja
 * abierta del día.
 *
 * Stock: lo que se carga acá NO lo descuenta (no hay forma de saber si la
 * mercadería ya salió del local), así que el POS lo descuenta al cobrarlo. Lo
 * que se carga desde el POS sí baja el stock en el momento y viaja marcado con
 * `stock_descontado` en su `item_json` para que el cobro no lo repita.
 */

import {
  collection, addDoc, doc, updateDoc, serverTimestamp, writeBatch
} from 'firebase/firestore';
import { getCached, peekCacheValue } from '../cache.js';
import { onStoreChange } from '../store.js';
import { confirmDialog, alertDialog, escHtml } from '../components/dialogs.js';

const COL_CLIENTES = 'fiado_clientes';
const COL_ITEMS    = 'fiado_items';
const COL_PAGOS    = 'fiado_pagos';

// Estado que sobrevive a los re-render del store (el módulo queda cacheado).
let _clienteSel = null;      // doc_id del cliente elegido
let _verHistorial = false;
let _buscarCliente = '';
let _borrador = [];          // líneas que se están por cargar en el modal
let _storeUnsub = null;      // suscripción realtime a las colecciones de fiado

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = n => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtCant(n) {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : v.toLocaleString('es-AR', { maximumFractionDigits: 3 });
}

function parseNum(txt) {
  // Acepta "1.234,56" y "1234.56"
  const s = String(txt ?? '').trim().replace(/\s/g, '');
  if (!s) return 0;
  const normal = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const v = Number(normal);
  return Number.isFinite(v) ? v : 0;
}

function fechaLegible(item) {
  const raw = item?.fecha_dt;
  let d = null;
  if (raw && typeof raw.toDate === 'function') d = raw.toDate();
  else if (raw && typeof raw === 'object' && raw.seconds !== undefined) d = new Date(raw.seconds * 1000);
  else if (item?.fecha_str) d = new Date(String(item.fecha_str).replace(' ', 'T') + '-03:00');
  if (!d || isNaN(d)) return String(item?.fecha_str || '').slice(0, 16);
  return d.toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'America/Argentina/Buenos_Aires',
  }).replace(',', ' ·');
}

function ahoraStrAr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const ar = new Date(d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return `${ar.getFullYear()}-${p(ar.getMonth() + 1)}-${p(ar.getDate())} `
       + `${p(ar.getHours())}:${p(ar.getMinutes())}:${p(ar.getSeconds())}`;
}

function nuevoEntregaId() {
  return 'web' + Math.random().toString(16).slice(2, 12) + Date.now().toString(16).slice(-4);
}

// ── Productos conjunto (rollo / pack / metro) y variantes ────────────────────
// Espejo de `pos_system/ui/conjunto_dialog.py`: mismos tipos, unidades y regla
// de precio. Tiene que coincidir para que la línea que se carga acá se cobre
// en el POS por el mismo importe.
const FRACCION_MARGIN = 1.15;

const CONJ_TIPOS = {
  rollo:     { label: 'Rollo',     unidad: 'm',  vendePor: ['fraccion', 'conjunto'] },
  pack:      { label: 'Pack',      unidad: 'u',  vendePor: ['unidad', 'conjunto'] },
  caja:      { label: 'Caja',      unidad: 'u',  vendePor: ['unidad', 'conjunto'] },
  bobina:    { label: 'Bobina',    unidad: 'm',  vendePor: ['fraccion', 'conjunto'] },
  bolsa:     { label: 'Bolsa',     unidad: 'kg', vendePor: ['fraccion', 'conjunto'] },
  plancha:   { label: 'Plancha',   unidad: 'm2', vendePor: ['fraccion', 'conjunto'] },
  cartulina: { label: 'Cartulina', unidad: 'u',  vendePor: ['unidad', 'conjunto'] },
  papel:     { label: 'Papel',     unidad: 'u',  vendePor: ['unidad', 'conjunto'] },
  carton:    { label: 'Cartón',    unidad: 'u',  vendePor: ['unidad', 'conjunto'] },
  goma_eva:  { label: 'Goma Eva',  unidad: 'u',  vendePor: ['unidad', 'conjunto'] },
  cinta:     { label: 'Cinta',     unidad: 'm',  vendePor: ['fraccion', 'conjunto'] },
  tela:      { label: 'Tela',      unidad: 'm',  vendePor: ['fraccion', 'conjunto'] },
  unidad:    { label: 'Unidad',    unidad: 'u',  vendePor: ['unidad', 'conjunto'] },
  otro:      { label: 'Otro',      unidad: 'u',  vendePor: ['unidad', 'conjunto'] },
};

const UNIDAD_SHORT = { m: 'm', cm: 'cm', u: 'u', g: 'g', kg: 'kg', l: 'L', ml: 'mL', m2: 'm²' };
const UNIDAD_NOMBRE = {
  m: 'metro', cm: 'centímetro', u: 'unidad', g: 'gramo',
  kg: 'kilo', l: 'litro', ml: 'mililitro', m2: 'metro²',
};
// La webapp guarda el nombre largo ('metros'); el POS trabaja con el corto.
const UNIDAD_WEB = {
  metros: 'm', metro: 'm', centimetros: 'cm', cm: 'cm', unidades: 'u', unidad: 'u',
  gramos: 'g', g: 'g', kilos: 'kg', kilogramos: 'kg', kg: 'kg',
  litros: 'l', l: 'l', mililitros: 'ml', ml: 'ml', m2: 'm2',
};

const esConjunto = p => p?.es_conjunto === true || p?.es_conjunto === 1;
const tipoKeyDe  = p => String(p?.conjunto_tipo || 'otro').toLowerCase();
const tipoDe     = p => CONJ_TIPOS[tipoKeyDe(p)] || CONJ_TIPOS.otro;

function unidadBaseDe(p) {
  const raw = String(p?.conjunto_unidad_medida || '').toLowerCase().trim();
  return UNIDAD_WEB[raw] || (UNIDAD_SHORT[raw] ? raw : tipoDe(p).unidad);
}

const variantesDe = p => (esConjunto(p) && Array.isArray(p?.conjunto_colores))
  ? p.conjunto_colores.filter(v => v && (v.color != null))
  : [];

const variantePorNombre = (p, nombre) =>
  variantesDe(p).find(v => String(v.color || '') === String(nombre || '')) || null;

function contenidoDe(p, variante) {
  const propio = Number(variante?.contenido) || 0;
  return propio > 0 ? propio : (Number(p?.conjunto_contenido) || 0);
}

const precioListaDe = p => Number(p?.precio_venta ?? p?.precio ?? 0) || 0;

/** Precio de UNA unidad base (ej. el metro de un rollo). */
function precioUnidadDe(p, variante) {
  const meta = tipoDe(p);
  const porFraccion = meta.vendePor.includes('fraccion');
  const cont = contenidoDe(p, variante);
  if (variante) {
    const propio = Number(variante.precio) || 0;
    if (propio > 0) return propio;
    const pack = Number(variante.precio_pack) || 0;
    if (pack > 0) {
      if (porFraccion && cont > 0) return Math.round(pack / cont * FRACCION_MARGIN * 100) / 100;
      if (!porFraccion) return pack;
    }
  }
  const explicito = Number(p?.conjunto_precio_unidad) || 0;
  if (explicito > 0) return explicito;
  const contGlobal = Number(p?.conjunto_contenido) || 0;
  if (porFraccion && contGlobal > 0) {
    return Math.round(precioListaDe(p) / contGlobal * FRACCION_MARGIN * 100) / 100;
  }
  return precioListaDe(p);
}

/** Precio del envase entero (rollo / pack / caja). */
function precioPackDe(p, variante) {
  const propio = Number(variante?.precio_pack) || 0;
  if (propio > 0) return propio;
  const lista = precioListaDe(p);
  if (lista > 0) return lista;
  const cont = contenidoDe(p, variante);
  return cont > 0 ? Math.round(precioUnidadDe(p, variante) * cont * 100) / 100 : 0;
}

/** Modos de venta disponibles, con su etiqueta para el select. */
function modosDe(p) {
  const meta = tipoDe(p);
  const u = unidadBaseDe(p);
  return meta.vendePor.map(modo => ({
    modo,
    label: modo === 'fraccion' ? `Por ${UNIDAD_NOMBRE[u] || u}`
         : modo === 'unidad'   ? 'Por unidad'
         : `${meta.label} entero`,
  }));
}

/** Precio unitario que corresponde a un modo de venta. */
function precioParaModo(p, variante, modo) {
  return modo === 'conjunto' ? precioPackDe(p, variante) : precioUnidadDe(p, variante);
}

/** Unidades sueltas totales de una variante (packs × contenido + suelto). */
function unidadesDeVariante(p, v) {
  const cont = contenidoDe(p, v) || 1;
  return (Number(v.unidades) || 0) * cont + (Number(v.restante) || 0);
}

/** Stock legible de un producto, para mostrar en el buscador. */
function stockTexto(p) {
  const vs = variantesDe(p);
  if (vs.length) {
    const total = vs.reduce((a, v) => a + unidadesDeVariante(p, v), 0);
    return `${fmtCant(Math.round(total))} u. en ${vs.length} variante${vs.length === 1 ? '' : 's'}`;
  }
  if (esConjunto(p)) {
    const u = UNIDAD_SHORT[unidadBaseDe(p)] || 'u';
    return `${fmtCant(Math.round(Number(p.conjunto_total) || 0))} ${u}`;
  }
  const st = Number(p?.stock) || 0;
  if (st === -1) return 'Sin control de stock';
  return `${fmtCant(st)} u.`;
}

/** Nombre con el que se anota la línea (incluye variante y modo). */
function nombreLinea(l) {
  const base = String(l.product_name || '').trim();
  if (!l.producto || !esConjunto(l.producto)) return base;
  const partes = [];
  if (l.variedad) partes.push(`[${l.variedad}]`);
  partes.push(base);
  const u = UNIDAD_SHORT[unidadBaseDe(l.producto)] || 'u';
  if (l.modo === 'fraccion')      partes.push(`· ${fmtCant(l.quantity)} ${u}`);
  else if (l.modo === 'conjunto') partes.push(`· ${fmtCant(l.quantity)} ${tipoDe(l.producto).label.toLowerCase()}(s)`);
  else                            partes.push(`· ${fmtCant(l.quantity)} u`);
  return partes.join(' ');
}

/** Arma la línea del borrador a partir de un producto del catálogo. */
function lineaDesdeProducto(p) {
  const vs = variantesDe(p);
  const variedad = vs.length ? String(vs[0].color || '') : '';
  const variante = vs.length ? vs[0] : null;
  const modo = esConjunto(p) ? tipoDe(p).vendePor[0] : '';
  return {
    product_fid:  String(p.doc_id || ''),
    product_name: String(p.nombre || 'Producto'),
    categoria:    String(p.categoria || ''),
    quantity:     1,
    unit_price:   esConjunto(p) ? precioParaModo(p, variante, modo) : precioListaDe(p),
    producto:     p,
    variedad,
    modo,
  };
}

// ── Buscador de catálogo reutilizable ────────────────────────────────────────
// Lo usan el buscador grande del modal y el campo "Producto" de cada línea.
// Devuelve una función para desmontarlo.
function normalizar(s) {
  // NFD separa la letra de su tilde y el rango ̀-ͯ la descarta:
  // "Cartulina Rojá" y "cartulina roja" matchean igual.
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Índice de búsqueda: se arma una vez por apertura del modal. */
function armarIndice(catalogo) {
  return (catalogo || []).map(p => ({
    p,
    hay: normalizar(`${p.nombre || ''} ${p.codigo || ''} ${p.cod_barra || ''} ${p.marca || ''}`),
    nom: normalizar(p.nombre || ''),
  }));
}

function buscarEnIndice(indice, texto, limite = 24) {
  const q = normalizar(texto).trim();
  if (!q) return [];
  const terminos = q.split(/\s+/).filter(Boolean);
  const hits = [];
  for (const e of indice) {
    if (!terminos.every(t => e.hay.includes(t))) continue;
    // Ranking: empieza con lo buscado > lo tiene al principio de una palabra > contiene
    let score = 2;
    if (e.nom.startsWith(q)) score = 0;
    else if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(e.nom)) score = 1;
    hits.push({ e, score });
    if (hits.length > 400) break;   // corte de seguridad en catálogos enormes
  }
  hits.sort((a, b) => a.score - b.score || a.e.nom.length - b.e.nom.length);
  return hits.slice(0, limite).map(h => h.e.p);
}

/** Resalta el tramo buscado dentro del nombre, sin romper el escapado. */
function resaltar(nombre, texto) {
  const original = String(nombre || '');
  const q = normalizar(texto).trim();
  if (!q) return escHtml(original);
  const i = normalizar(original).indexOf(q);
  if (i < 0) return escHtml(original);
  return escHtml(original.slice(0, i))
       + '<mark>' + escHtml(original.slice(i, i + q.length)) + '</mark>'
       + escHtml(original.slice(i + q.length));
}

function chipsDe(p) {
  const chips = [];
  const vs = variantesDe(p);
  if (vs.length) chips.push(`<span class="fiado-chip-tag variantes">${vs.length} variantes</span>`);
  if (esConjunto(p)) {
    const meta = tipoDe(p);
    if (meta.vendePor.includes('fraccion')) {
      const u = UNIDAD_NOMBRE[unidadBaseDe(p)] || 'unidad';
      chips.push(`<span class="fiado-chip-tag fraccion">por ${escHtml(u)}</span>`);
    } else {
      chips.push(`<span class="fiado-chip-tag pack">${escHtml(meta.label.toLowerCase())}</span>`);
    }
  }
  return chips.join('');
}

/**
 * Monta un buscador con dropdown sobre un input.
 * @param {object} cfg
 * @param {HTMLInputElement} cfg.input
 * @param {HTMLElement} cfg.panel  contenedor del dropdown (posicionado por CSS)
 * @param {Array} cfg.indice
 * @param {(producto:object)=>void} cfg.onPick
 * @param {boolean} [cfg.limpiarAlElegir]
 */
function montarBuscador({ input, panel, indice, onPick, limpiarAlElegir = false }) {
  let hits = [];
  let activo = -1;
  let timer = null;

  const cerrar = () => {
    panel.classList.remove('open');
    panel.innerHTML = '';
    hits = []; activo = -1;
  };

  const pintar = () => {
    const texto = input.value;
    if (!texto.trim()) { cerrar(); return; }
    hits = buscarEnIndice(indice, texto);
    if (!hits.length) {
      panel.innerHTML = `<div class="fiado-res-vacio">
        <span class="material-icons">search_off</span>
        Nada con “${escHtml(texto.trim())}”
      </div>`;
      panel.classList.add('open');
      return;
    }
    activo = 0;
    panel.innerHTML = hits.map((p, i) => `
      <button type="button" class="fiado-res${i === 0 ? ' activo' : ''}" data-idx="${i}">
        <span class="fiado-res-main">
          <span class="fiado-res-nombre">${resaltar(p.nombre, texto)}</span>
          <span class="fiado-res-meta">
            ${p.categoria ? escHtml(p.categoria) + ' · ' : ''}${escHtml(stockTexto(p))}
          </span>
        </span>
        <span class="fiado-res-right">
          <span class="fiado-res-chips">${chipsDe(p)}</span>
          <span class="fiado-res-precio">$${fmt(precioListaDe(p))}</span>
        </span>
      </button>`).join('');
    panel.classList.add('open');
    panel.scrollTop = 0;
  };

  const marcarActivo = () => {
    panel.querySelectorAll('.fiado-res').forEach((el, i) => {
      const on = i === activo;
      el.classList.toggle('activo', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  };

  const elegir = i => {
    const p = hits[i];
    if (!p) return;
    onPick(p);
    if (limpiarAlElegir) input.value = '';
    cerrar();
  };

  const onInput = () => {
    clearTimeout(timer);
    timer = setTimeout(pintar, 110);
  };
  const onKeyDown = e => {
    if (!panel.classList.contains('open')) {
      if (e.key === 'ArrowDown' && input.value.trim()) { e.preventDefault(); pintar(); }
      return;
    }
    if (e.key === 'ArrowDown')      { e.preventDefault(); activo = Math.min(activo + 1, hits.length - 1); marcarActivo(); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); activo = Math.max(activo - 1, 0); marcarActivo(); }
    else if (e.key === 'Enter')     { if (hits.length) { e.preventDefault(); elegir(activo); } }
    else if (e.key === 'Escape')    { e.preventDefault(); e.stopPropagation(); cerrar(); }
  };
  const onClickPanel = e => {
    const btn = e.target.closest('[data-idx]');
    if (btn) elegir(Number(btn.dataset.idx));
  };
  // mousedown y no click: el blur del input dispararía antes y cerraría el panel.
  const onMouseDownPanel = e => e.preventDefault();
  const onBlur = () => setTimeout(cerrar, 120);
  const onFocus = () => { if (input.value.trim()) pintar(); };

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('blur', onBlur);
  input.addEventListener('focus', onFocus);
  panel.addEventListener('click', onClickPanel);
  panel.addEventListener('mousedown', onMouseDownPanel);

  return () => {
    clearTimeout(timer);
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeyDown);
    input.removeEventListener('blur', onBlur);
    input.removeEventListener('focus', onFocus);
    cerrar();
  };
}

/**
 * Filas (items o pagos) que pertenecen a un cliente.
 *
 * Una fila puede apuntar a su cliente de dos formas: por `cliente_fid` (lo
 * normal) o por `cliente_local_id` con el fid vacío — así quedan las que el
 * POS creó offline, antes de que el cliente tuviera doc en Firestore. Las dos
 * cuentan; mirar sólo una dejaría productos fuera del total.
 */
function itemsDeCliente(filas, cliente) {
  if (!cliente) return [];
  const localId = cliente.local_id ?? null;
  return filas.filter(it => {
    // Una línea borrada desde la caja llega con `deleted` en true y el estado
    // como estaba: si no se descarta acá, el producto que se dio de baja sigue
    // sumando a la deuda y el cliente queda debiendo algo que ya no debe.
    if (it.deleted === true) return false;
    const fid = String(it.cliente_fid || '').trim();
    if (fid) return fid === cliente.doc_id;
    if (localId != null && it.cliente_local_id != null) {
      return Number(it.cliente_local_id) === Number(localId);
    }
    return false;
  });
}

/**
 * Los clientes que siguen en la lista.
 *
 * Hay dos formas de dar de baja a alguien y NO escriben lo mismo. Desde el
 * panel se marca `activo: false` y `deleted: true`; desde la caja, el POS sólo
 * marca `deleted`, y el cliente sigue con `activo: true`. Mirar una sola de las
 * dos dejaba a alguien borrado en el mostrador figurando en el panel, con su
 * deuda y con la posibilidad de anotarle cosas nuevas.
 */
function clientesVivos(clientes) {
  return (clientes || []).filter(c => c.activo !== false && c.deleted !== true);
}

/** Saldo a favor = entregas a cuenta − lo ya aplicado a productos. */
function creditoDeCliente(pagos, cliente) {
  const propios = itemsDeCliente(pagos, cliente);
  let credito = 0;
  propios.forEach(p => {
    const monto = Number(p.monto || 0);
    if (p.tipo === 'a_cuenta') credito += monto;
    else if (p.tipo === 'credito_aplicado') credito -= monto;
    credito -= Number(p.credito_usado || 0);
  });
  return Math.max(0, Math.round(credito * 100) / 100);
}

function totalesCliente(items, pagos, cliente) {
  const propios = itemsDeCliente(items, cliente).filter(i => i.estado === 'pendiente');
  const pendiente = propios.reduce((a, i) => a + Number(i.subtotal || 0), 0);
  const credito = creditoDeCliente(pagos, cliente);
  return {
    pendiente: Math.round(pendiente * 100) / 100,
    items: propios.length,
    credito,
    deuda: Math.round(Math.max(0, pendiente - credito) * 100) / 100,
    saldoFavor: Math.round(Math.max(0, credito - pendiente) * 100) / 100,
  };
}

// ── Render ────────────────────────────────────────────────────────────────────
export async function renderFiados(container, db) {
  container.innerHTML = shell();

  const [clientes, items, pagos] = await Promise.all([
    getCached('fiado:clientes', async () => []),
    getCached('fiado:items',    async () => []),
    getCached('fiado:pagos',    async () => []),
  ]);

  const estado = { db, clientes, items, pagos };

  pintarResumen(estado);
  pintarLista(estado);
  pintarDetalle(estado);
  conectarEventos(estado);
  suscribirStore(estado, container);
}

/**
 * Refresco realtime EN EL LUGAR de las 3 colecciones de fiado.
 *
 * main.js NO hace loadPage cuando estamos en esta página (ver la exclusión
 * allá): sin eso, cada venta del POS —aunque no tenga nada que ver con el
 * fiado— destruía y volvía a armar toda la pantalla. Acá repintamos sólo
 * cuando cambia algo de fiado y conservando lo que el usuario está mirando.
 */
function suscribirStore(estado, container) {
  if (_storeUnsub) { try { _storeUnsub(); } catch (_) {} _storeUnsub = null; }

  _storeUnsub = onStoreChange((col) => {
    if (col !== 'fiado_clientes' && col !== 'fiado_items' && col !== 'fiado_pagos') return;

    // La página se desmontó (el usuario navegó a otra): soltar el listener.
    if (!document.body.contains(container)) {
      try { _storeUnsub && _storeUnsub(); } catch (_) {}
      _storeUnsub = null;
      return;
    }
    // Con un modal abierto no se toca nada: perderíamos el formulario a medio
    // llenar o las líneas del borrador.
    if (document.querySelector('.fiado-overlay')) return;

    const clientes = peekCacheValue('fiado:clientes');
    const items    = peekCacheValue('fiado:items');
    const pagos    = peekCacheValue('fiado:pagos');
    if (Array.isArray(clientes)) estado.clientes = clientes;
    if (Array.isArray(items))    estado.items    = items;
    if (Array.isArray(pagos))    estado.pagos    = pagos;

    // Si estabas escribiendo en el buscador de clientes, se conserva el texto
    // (vive en _buscarCliente) y no se le roba el foco.
    const enfocado = document.activeElement;
    refrescarTodo(estado);
    if (enfocado?.id === 'fiadoBuscar') {
      const nuevo = document.getElementById('fiadoBuscar');
      if (nuevo && nuevo !== enfocado) {
        nuevo.focus();
        nuevo.setSelectionRange(nuevo.value.length, nuevo.value.length);
      }
    }
  });
}

function shell() {
  return `
    <div class="fiado-wrap">
      <div class="fiado-head">
        <div>
          <h2 class="fiado-title">Fiados</h2>
          <p id="fiadoResumen" class="fiado-sub">—</p>
        </div>
        <div class="fiado-head-actions">
          <button id="btnNuevoFiadoCliente" class="fiado-btn-primary">
            <span class="material-icons">person_add</span> Nuevo cliente
          </button>
        </div>
      </div>

      <div class="fiado-grid">
        <aside class="fiado-aside">
          <div class="fiado-search">
            <span class="material-icons">search</span>
            <input id="fiadoBuscar" type="text" placeholder="Buscar cliente..." />
          </div>
          <div id="fiadoLista" class="fiado-lista"></div>
        </aside>
        <section id="fiadoDetalle" class="fiado-detalle"></section>
      </div>
    </div>
    ${estilos()}
  `;
}

function pintarResumen(estado) {
  const el = document.getElementById('fiadoResumen');
  if (!el) return;
  const pendientes = estado.items.filter(i => i.estado === 'pendiente' && i.deleted !== true);
  const total = pendientes.reduce((a, i) => a + Number(i.subtotal || 0), 0);
  const conDeuda = clientesVivos(estado.clientes)
    .filter(c => totalesCliente(estado.items, estado.pagos, c).deuda > 0).length;
  el.innerHTML = total > 0
    ? `<b>$${fmt(total)}</b> sin cobrar · ${conDeuda} cliente${conDeuda === 1 ? '' : 's'} con cuenta abierta`
    : 'Todas las cuentas al día';
}

function pintarLista(estado) {
  const host = document.getElementById('fiadoLista');
  if (!host) return;
  const q = _buscarCliente.trim().toLowerCase();

  const filas = clientesVivos(estado.clientes)
    .map(c => ({ c, t: totalesCliente(estado.items, estado.pagos, c) }))
    .filter(({ c }) => {
      if (!q) return true;
      return `${c.nombre || ''} ${c.dni || ''} ${c.telefono || ''}`.toLowerCase().includes(q);
    })
    .sort((a, b) => (b.t.deuda - a.t.deuda) ||
                    String(a.c.nombre || '').localeCompare(String(b.c.nombre || ''), 'es'));

  if (!filas.length) {
    host.innerHTML = `
      <div class="fiado-empty-small">
        <span class="material-icons">person_search</span>
        <p>${q ? 'Ningún cliente con ese nombre' : 'Todavía no hay clientes de fiado'}</p>
      </div>`;
    return;
  }

  host.innerHTML = filas.map(({ c, t }) => {
    const activo = c.doc_id === _clienteSel ? ' activo' : '';
    let estadoHtml;
    if (t.deuda > 0) {
      estadoHtml = `<span class="fiado-monto">$${fmt(t.deuda)}</span>`;
    } else if (t.saldoFavor > 0) {
      estadoHtml = `<span class="fiado-chip favor">$${fmt(t.saldoFavor)} a favor</span>`;
    } else {
      estadoHtml = `<span class="fiado-chip ok">Al día</span>`;
    }
    const detalle = t.deuda > 0
      ? `${t.items} producto${t.items === 1 ? '' : 's'} sin pagar`
      : (c.telefono ? escHtml(c.telefono) : 'Sin movimientos pendientes');
    return `
      <button class="fiado-cli${activo}" data-cliente="${escHtml(c.doc_id)}">
        <div class="fiado-cli-top">
          <span class="fiado-cli-nombre">${escHtml(c.nombre || '—')}</span>
          ${estadoHtml}
        </div>
        <div class="fiado-cli-sub">${detalle}</div>
      </button>`;
  }).join('');
}

function pintarDetalle(estado) {
  const host = document.getElementById('fiadoDetalle');
  if (!host) return;

  const cliente = estado.clientes.find(c => c.doc_id === _clienteSel);
  if (!cliente) {
    host.innerHTML = `
      <div class="fiado-empty">
        <span class="material-icons">account_balance_wallet</span>
        <h3>Elegí un cliente</h3>
        <p>Vas a ver todo lo que se llevó sin pagar, su saldo y el historial completo.</p>
        <p class="fiado-nota">El <b>cobro</b> se hace desde el POS: es el que arma la venta del día.</p>
      </div>`;
    return;
  }

  const t = totalesCliente(estado.items, estado.pagos, cliente);
  const propios = itemsDeCliente(estado.items, cliente);
  const pendientes = propios.filter(i => i.estado === 'pendiente');
  const pagados    = propios.filter(i => i.estado === 'pagado');
  const anulados   = propios.filter(i => i.estado === 'anulado');
  const pagos      = itemsDeCliente(estado.pagos, cliente);

  const datos = [
    cliente.dni ? `DNI ${escHtml(cliente.dni)}` : '',
    cliente.telefono ? escHtml(cliente.telefono) : '',
    cliente.direccion ? escHtml(cliente.direccion) : '',
    cliente.email ? escHtml(cliente.email) : '',
  ].filter(Boolean).join(' · ');

  const etiquetaSaldo = t.deuda > 0 ? 'DEBE' : (t.saldoFavor > 0 ? 'A FAVOR' : 'AL DÍA');
  const claseSaldo = t.deuda > 0 ? 'debe' : (t.saldoFavor > 0 ? 'favor' : 'cero');
  const montoSaldo = t.deuda > 0 ? t.deuda : t.saldoFavor;

  host.innerHTML = `
    <div class="fiado-card cliente">
      <div class="fiado-cliente-info">
        <h3>${escHtml(cliente.nombre || '—')}</h3>
        <p class="fiado-cliente-datos">${datos || 'Sin datos de contacto cargados'}</p>
        ${cliente.notas ? `<p class="fiado-cliente-nota">${escHtml(cliente.notas)}</p>` : ''}
      </div>
      <div class="fiado-saldo ${claseSaldo}">
        <span class="fiado-saldo-lbl">${etiquetaSaldo}</span>
        <span class="fiado-saldo-monto">$${fmt(montoSaldo)}</span>
        ${t.credito > 0 && t.deuda > 0
          ? `<span class="fiado-saldo-extra">incluye $${fmt(t.credito)} a favor</span>` : ''}
      </div>
      <div class="fiado-cliente-btns">
        <button id="btnCargarProductos" class="fiado-btn-primary">
          <span class="material-icons">add_shopping_cart</span> Cargar productos
        </button>
        <div class="fiado-cliente-btns-row">
          <button id="btnEditarCliente" class="fiado-btn-ghost">Editar datos</button>
          <button id="btnEliminarCliente" class="fiado-btn-ghost danger" title="Eliminar este cliente">
            <span class="material-icons">delete_outline</span>
          </button>
        </div>
      </div>
    </div>

    <div class="fiado-aviso">
      <span class="material-icons">point_of_sale</span>
      <div>
        <b>El cobro se hace desde el POS.</b>
        Ahí se elige qué productos paga y la venta entra a la caja del día.
      </div>
    </div>

    ${pendientes.length ? gruposHtml(pendientes) : `
      <div class="fiado-card vacio-ok">
        <span class="material-icons">check_circle</span>
        Este cliente no tiene productos sin pagar.
      </div>`}

    <div class="fiado-card historial">
      <button id="btnToggleHistorial" class="fiado-hist-head">
        <span>Historial de la cuenta</span>
        <span class="material-icons">${_verHistorial ? 'expand_less' : 'expand_more'}</span>
      </button>
      ${_verHistorial ? historialHtml(pagos, pagados, anulados) : ''}
    </div>
  `;
}

function gruposHtml(pendientes) {
  const grupos = new Map();
  pendientes.forEach(it => {
    const k = it.entrega_id || `__${it.doc_id}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(it);
  });

  const ordenados = [...grupos.values()].sort((a, b) => {
    const ms = x => {
      const r = x.fecha_dt;
      if (r && typeof r.toDate === 'function') return r.toDate().getTime();
      if (r && r.seconds !== undefined) return r.seconds * 1000;
      return 0;
    };
    return ms(b[0]) - ms(a[0]);
  });

  return ordenados.map(items => {
    const total = items.reduce((a, i) => a + Number(i.subtotal || 0), 0);
    const origen = items[0]?.origen === 'web' ? 'cargado desde la web' : 'cargado en el POS';
    return `
      <div class="fiado-card grupo">
        <div class="fiado-grupo-head">
          <div>
            <span class="fiado-grupo-fecha">Se llevó el ${escHtml(fechaLegible(items[0]))}</span>
            <span class="fiado-grupo-origen">${origen}</span>
          </div>
          <span class="fiado-grupo-total">$${fmt(total)}</span>
        </div>
        <div class="fiado-items">
          ${items.map(it => `
            <div class="fiado-item">
              <div class="fiado-item-info">
                <span class="fiado-item-nombre">${escHtml(it.product_name || '—')}</span>
                <span class="fiado-item-detalle">${fmtCant(it.quantity)} × $${fmt(it.unit_price)}${
                  it.nota ? ` · ${escHtml(it.nota)}` : ''}</span>
              </div>
              <span class="fiado-item-monto">$${fmt(it.subtotal)}</span>
              <div class="fiado-item-btns">
                <button class="fiado-icon" data-editar-item="${escHtml(it.doc_id)}" title="Corregir cantidad o precio">
                  <span class="material-icons">edit</span>
                </button>
                <button class="fiado-icon danger" data-quitar-item="${escHtml(it.doc_id)}" title="Sacar de la deuda sin cobrarlo">
                  <span class="material-icons">close</span>
                </button>
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');
}

function historialHtml(pagos, pagados, anulados) {
  const etiquetas = {
    productos: 'Cobro de productos',
    a_cuenta: 'Entrega a cuenta',
    credito_aplicado: 'Saldo a favor aplicado',
  };
  const filasPagos = [...pagos]
    .sort((a, b) => String(b.fecha_str || '').localeCompare(String(a.fecha_str || '')))
    .map(p => `
      <div class="fiado-hist-row pago">
        <span class="fiado-hist-txt">
          ${escHtml(etiquetas[p.tipo] || 'Movimiento')} · ${escHtml(fechaLegible(p))}
          ${p.metodo_pago ? ` · ${escHtml(p.metodo_pago)}` : ''}
          ${p.venta_id ? ` · venta #${escHtml(String(p.venta_id))}` : ''}
        </span>
        <span class="fiado-hist-monto verde">$${fmt(p.monto)}</span>
      </div>`).join('');

  const filasItems = [...pagados, ...anulados]
    .sort((a, b) => String(b.fecha_str || '').localeCompare(String(a.fecha_str || '')))
    .slice(0, 200)
    .map(it => `
      <div class="fiado-hist-row">
        <span class="fiado-hist-txt">
          ${escHtml(it.product_name || '')} · ${fmtCant(it.quantity)} un.
        </span>
        <span class="fiado-hist-estado">${it.estado === 'pagado' ? 'Pagado' : 'Anulado'}</span>
        <span class="fiado-hist-monto ${it.estado === 'anulado' ? 'tachado' : ''}">$${fmt(it.subtotal)}</span>
      </div>`).join('');

  if (!filasPagos && !filasItems) {
    return `<div class="fiado-hist-body"><p class="fiado-hist-vacio">Todavía no hay movimientos cerrados.</p></div>`;
  }
  return `<div class="fiado-hist-body">${filasPagos}${filasItems}</div>`;
}

// ── Eventos ───────────────────────────────────────────────────────────────────
function conectarEventos(estado) {
  const buscar = document.getElementById('fiadoBuscar');
  if (buscar) {
    buscar.value = _buscarCliente;
    buscar.addEventListener('input', e => {
      _buscarCliente = e.target.value;
      pintarLista(estado);
    });
  }

  document.getElementById('fiadoLista')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-cliente]');
    if (!btn) return;
    _clienteSel = btn.dataset.cliente;
    _verHistorial = false;
    pintarLista(estado);
    pintarDetalle(estado);
    conectarEventosDetalle(estado);
  });

  document.getElementById('btnNuevoFiadoCliente')
    ?.addEventListener('click', () => abrirModalCliente(estado, null));

  // Delegado sobre el contenedor del detalle, que NO se reemplaza entre
  // repintados (sólo su innerHTML). Va acá y no en conectarEventosDetalle
  // para no apilar un handler nuevo en cada render.
  document.getElementById('fiadoDetalle')?.addEventListener('click', async e => {
    const editar = e.target.closest('[data-editar-item]');
    if (editar) {
      const it = estado.items.find(x => x.doc_id === editar.dataset.editarItem);
      if (it) abrirModalItem(estado, it);
      return;
    }
    const quitar = e.target.closest('[data-quitar-item]');
    if (quitar) {
      const it = estado.items.find(x => x.doc_id === quitar.dataset.quitarItem);
      if (it) await quitarItem(estado, it);
    }
  });

  conectarEventosDetalle(estado);
}

/** Listeners de los botones del detalle, que se recrean en cada repintado. */
function conectarEventosDetalle(estado) {
  const cliente = estado.clientes.find(c => c.doc_id === _clienteSel);
  if (!cliente) return;

  document.getElementById('btnEditarCliente')
    ?.addEventListener('click', () => abrirModalCliente(estado, cliente));
  document.getElementById('btnCargarProductos')
    ?.addEventListener('click', () => abrirModalCarga(estado, cliente));
  document.getElementById('btnEliminarCliente')
    ?.addEventListener('click', () => eliminarCliente(estado, cliente));
  document.getElementById('btnToggleHistorial')?.addEventListener('click', () => {
    _verHistorial = !_verHistorial;
    pintarDetalle(estado);
    conectarEventosDetalle(estado);
  });
}

// ── Acciones sobre Firestore ──────────────────────────────────────────────────
async function quitarItem(estado, item) {
  const ok = await confirmDialog({
    title: 'Quitar de la deuda',
    message: `¿Sacar <b>"${escHtml(item.product_name || '')}"</b> por `
           + `<b>$${fmt(item.subtotal)}</b> de la cuenta sin cobrarlo?<br><br>`
           + `<span style="color:var(--text-muted)">Queda registrado como anulado en el historial.</span>`,
    confirmText: 'Quitar',
    danger: true,
  });
  if (!ok) return;
  try {
    await updateDoc(doc(estado.db, COL_ITEMS, item.doc_id), {
      estado: 'anulado',
      nota: 'Anulado desde la web',
      actualizado: serverTimestamp(),
    });
    item.estado = 'anulado';
    refrescarTodo(estado);
  } catch (err) {
    alertDialog({ title: 'Error', message: 'No se pudo quitar: ' + escHtml(err.message || err), type: 'error' });
  }
}

function refrescarTodo(estado) {
  pintarResumen(estado);
  pintarLista(estado);
  pintarDetalle(estado);
  conectarEventosDetalle(estado);
}

/**
 * Baja de un cliente. Pide confirmación siempre.
 *
 * Si tiene productos sin pagar no se borra: esconderlo haría desaparecer plata
 * que alguien debe. Primero hay que cobrar o quitar esas líneas.
 */
async function eliminarCliente(estado, cliente) {
  const t = totalesCliente(estado.items, estado.pagos, cliente);

  if (t.pendiente > 0) {
    alertDialog({
      title: 'Tiene cuenta abierta',
      message: `<b>${escHtml(cliente.nombre || '')}</b> tiene `
             + `<b>$${fmt(t.pendiente)}</b> en ${t.items} producto${t.items === 1 ? '' : 's'} sin pagar.<br><br>`
             + `Para no perder de vista esa deuda, primero cobrala desde el POS `
             + `o quitá esas líneas con la <b>✕</b> de cada producto.`,
      type: 'warning',
    });
    return;
  }

  const extra = t.credito > 0
    ? `<br><br><b>Ojo:</b> tiene $${fmt(t.credito)} a favor sin usar.`
    : '';
  const ok = await confirmDialog({
    title: 'Eliminar cliente',
    message: `¿Eliminar a <b>${escHtml(cliente.nombre || '')}</b> de la lista de fiado?${extra}`
           + `<br><br><span style="color:var(--text-muted)">Sale de la lista en el POS y en la web. `
           + `El historial de lo que ya pagó se conserva.</span>`,
    confirmText: 'Sí, eliminar',
    cancelText: 'No, volver',
    danger: true,
  });
  if (!ok) return;

  try {
    await updateDoc(doc(estado.db, COL_CLIENTES, cliente.doc_id), {
      activo: false, deleted: true, actualizado: serverTimestamp(),
    });
    estado.clientes = estado.clientes.filter(c => c.doc_id !== cliente.doc_id);
    if (_clienteSel === cliente.doc_id) _clienteSel = null;
    refrescarTodo(estado);
  } catch (err) {
    alertDialog({ title: 'Error', message: 'No se pudo eliminar: ' + escHtml(err.message || err), type: 'error' });
  }
}

// ── Modal: cliente ────────────────────────────────────────────────────────────
function abrirModalCliente(estado, cliente) {
  const editando = !!cliente;
  const overlay = crearOverlay(`
    <h3 class="fiado-modal-title">${editando ? 'Editar cliente' : 'Nuevo cliente de fiado'}</h3>
    <p class="fiado-modal-sub">Solo el nombre es obligatorio. El resto lo completás cuando lo tengas.</p>
    <div class="fiado-form">
      <label>Nombre *<input id="fcNombre" type="text" value="${escHtml(cliente?.nombre || '')}" placeholder="Ej: Juan Pérez"></label>
      <div class="fiado-form-row">
        <label>DNI<input id="fcDni" type="text" value="${escHtml(cliente?.dni || '')}" placeholder="Opcional"></label>
        <label>Teléfono<input id="fcTel" type="text" value="${escHtml(cliente?.telefono || '')}" placeholder="Opcional"></label>
      </div>
      <div class="fiado-form-row">
        <label>Dirección<input id="fcDir" type="text" value="${escHtml(cliente?.direccion || '')}" placeholder="Opcional"></label>
        <label>Email<input id="fcMail" type="text" value="${escHtml(cliente?.email || '')}" placeholder="Opcional"></label>
      </div>
      <label>Notas<textarea id="fcNotas" rows="2" placeholder="Ej: paga los viernes">${escHtml(cliente?.notas || '')}</textarea></label>
    </div>
    <div class="fiado-modal-footer">
      ${editando ? `<button class="fiado-btn-danger" id="fcEliminar">Eliminar cliente</button>` : ''}
      <button class="fiado-btn-ghost" data-cerrar>Cancelar</button>
      <button class="fiado-btn-primary" id="fcGuardar">Guardar</button>
    </div>
  `, 520);

  overlay.querySelector('#fcNombre')?.focus();

  // Mismo flujo que el botón de la ficha (confirmación incluida).
  overlay.querySelector('#fcEliminar')?.addEventListener('click', async () => {
    overlay.remove();
    await eliminarCliente(estado, cliente);
  });

  overlay.querySelector('#fcGuardar').addEventListener('click', async () => {
    const nombre = overlay.querySelector('#fcNombre').value.trim();
    if (!nombre) {
      alertDialog({ title: 'Falta el nombre', message: 'Poné al menos el nombre del cliente.', type: 'warning' });
      return;
    }
    const datos = {
      nombre,
      dni:       overlay.querySelector('#fcDni').value.trim(),
      telefono:  overlay.querySelector('#fcTel').value.trim(),
      direccion: overlay.querySelector('#fcDir').value.trim(),
      email:     overlay.querySelector('#fcMail').value.trim(),
      notas:     overlay.querySelector('#fcNotas').value.trim(),
      activo:    true,
      deleted:   false,
      actualizado: serverTimestamp(),
    };
    const btn = overlay.querySelector('#fcGuardar');
    btn.disabled = true; btn.textContent = 'Guardando...';
    try {
      if (editando) {
        await updateDoc(doc(estado.db, COL_CLIENTES, cliente.doc_id), datos);
        Object.assign(cliente, datos);
      } else {
        const ref = await addDoc(collection(estado.db, COL_CLIENTES), {
          ...datos, origen: 'web', pc_id: '', local_id: null, creado: serverTimestamp(),
        });
        // Optimista: el listener del store lo confirma en un instante.
        estado.clientes.push({ doc_id: ref.id, id: ref.id, ...datos, origen: 'web' });
        _clienteSel = ref.id;
      }
      overlay.remove();
      refrescarTodo(estado);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Guardar';
      alertDialog({ title: 'Error', message: 'No se pudo guardar: ' + escHtml(err.message || err), type: 'error' });
    }
  });
}

// ── Modal: editar una línea pendiente ─────────────────────────────────────────
function abrirModalItem(estado, item) {
  const overlay = crearOverlay(`
    <h3 class="fiado-modal-title">Corregir línea</h3>
    <p class="fiado-modal-sub">${escHtml(item.product_name || '')}</p>
    <div class="fiado-form">
      <label>Producto<input id="fiNombre" type="text" value="${escHtml(item.product_name || '')}"></label>
      <div class="fiado-form-row">
        <label>Cantidad<input id="fiCant" type="text" inputmode="decimal" value="${fmtCant(item.quantity)}"></label>
        <label>Precio unitario<input id="fiPrecio" type="text" inputmode="decimal" value="${fmt(item.unit_price)}"></label>
      </div>
      <label>Nota<input id="fiNota" type="text" value="${escHtml(item.nota || '')}" placeholder="Opcional"></label>
      <div class="fiado-total-preview">Subtotal: <b id="fiSubtotal">$${fmt(item.subtotal)}</b></div>
    </div>
    <div class="fiado-modal-footer">
      <button class="fiado-btn-ghost" data-cerrar>Cancelar</button>
      <button class="fiado-btn-primary" id="fiGuardar">Guardar</button>
    </div>
  `, 480);

  const recalcular = () => {
    const sub = parseNum(overlay.querySelector('#fiCant').value)
              * parseNum(overlay.querySelector('#fiPrecio').value);
    overlay.querySelector('#fiSubtotal').textContent = '$' + fmt(sub);
  };
  overlay.querySelector('#fiCant').addEventListener('input', recalcular);
  overlay.querySelector('#fiPrecio').addEventListener('input', recalcular);

  overlay.querySelector('#fiGuardar').addEventListener('click', async () => {
    const quantity = parseNum(overlay.querySelector('#fiCant').value);
    const unitPrice = parseNum(overlay.querySelector('#fiPrecio').value);
    const nombre = overlay.querySelector('#fiNombre').value.trim() || item.product_name;
    if (quantity <= 0) {
      alertDialog({ title: 'Cantidad inválida', message: 'La cantidad tiene que ser mayor a cero.', type: 'warning' });
      return;
    }
    const subtotal = Math.round(quantity * unitPrice * 100) / 100;
    const cambios = {
      product_name: nombre,
      quantity, unit_price: unitPrice, subtotal,
      nota: overlay.querySelector('#fiNota').value.trim(),
      // El snapshot del carrito queda desactualizado tras editar a mano: lo
      // limpiamos para que el POS arme la línea con estos valores.
      item_json: null,
      actualizado: serverTimestamp(),
    };
    const btn = overlay.querySelector('#fiGuardar');
    btn.disabled = true; btn.textContent = 'Guardando...';
    try {
      await updateDoc(doc(estado.db, COL_ITEMS, item.doc_id), cambios);
      Object.assign(item, cambios);
      overlay.remove();
      refrescarTodo(estado);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Guardar';
      alertDialog({ title: 'Error', message: 'No se pudo guardar: ' + escHtml(err.message || err), type: 'error' });
    }
  });
}

// ── Modal: cargar productos a la cuenta ───────────────────────────────────────
async function abrirModalCarga(estado, cliente) {
  _borrador = [];
  const overlay = crearOverlay(`
    <h3 class="fiado-modal-title">Cargar a la cuenta de ${escHtml(cliente.nombre || '')}</h3>
    <p class="fiado-modal-sub">Buscá en el catálogo o agregá una línea a mano. No descuenta stock:
      eso pasa cuando se cobra en el POS.</p>

    <div class="fiado-buscador" id="fpBuscadorWrap">
      <span class="material-icons">search</span>
      <input id="fpBuscar" type="text" autocomplete="off" spellcheck="false"
             placeholder="Buscá por nombre, código o marca...">
      <span class="fiado-buscador-hint">↑↓ para moverte · Enter para agregar</span>
      <div id="fpResultados" class="fiado-resultados"></div>
    </div>

    <button id="fpManual" class="fiado-btn-link">
      <span class="material-icons">add</span> Agregar línea a mano (no está en el catálogo)
    </button>

    <div id="fpBorrador" class="fiado-borrador"></div>

    <div class="fiado-modal-footer">
      <span id="fpTotal" class="fiado-modal-total">Total: $0,00</span>
      <button class="fiado-btn-ghost" data-cerrar>Cancelar</button>
      <button class="fiado-btn-primary" id="fpConfirmar" disabled>Cargar al fiado</button>
    </div>
  `, 780);

  let catalogo = [];
  try {
    catalogo = await getCached('catalogo:all', async () => []);
  } catch (_) { catalogo = []; }
  const indice = armarIndice(catalogo);

  const host = overlay.querySelector('#fpBorrador');
  const inputBuscar = overlay.querySelector('#fpBuscar');
  if (!catalogo.length) {
    inputBuscar.placeholder = 'Catálogo todavía cargando...';
  }

  // Buscadores montados sobre las filas: se desmontan antes de cada repintado.
  let bajasBuscadores = [];

  montarBuscador({
    input: inputBuscar,
    panel: overlay.querySelector('#fpResultados'),
    indice,
    limpiarAlElegir: true,
    onPick: p => { _borrador.push(lineaDesdeProducto(p)); pintarBorrador({ foco: 'cant' }); },
  });

  overlay.querySelector('#fpManual').addEventListener('click', () => {
    _borrador.push({
      product_fid: '', product_name: '', categoria: '',
      quantity: 1, unit_price: 0, producto: null, variedad: '', modo: '',
    });
    pintarBorrador({ foco: 'nombre' });
  });

  function totalBorrador() {
    return _borrador.reduce((a, l) => a + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);
  }

  function refrescarTotales() {
    overlay.querySelector('#fpTotal').textContent = 'Total: $' + fmt(totalBorrador());
    overlay.querySelector('#fpConfirmar').disabled = !_borrador.length;
  }

  function pintarBorrador({ foco = null } = {}) {
    bajasBuscadores.forEach(fn => { try { fn(); } catch (_) {} });
    bajasBuscadores = [];

    if (!_borrador.length) {
      host.innerHTML = `<div class="fiado-bor-vacio">
        <span class="material-icons">shopping_basket</span>
        Buscá arriba lo que se llevó y va apareciendo acá.
      </div>`;
      refrescarTotales();
      return;
    }

    host.innerHTML = `
      <div class="fiado-bor-head">
        <span>Producto</span><span>Cantidad</span><span>Precio</span><span>Subtotal</span><span></span>
      </div>
      ${_borrador.map((l, i) => filaBorradorHtml(l, i)).join('')}`;

    // Cada fila tiene su propio buscador sobre el campo Producto.
    host.querySelectorAll('.fiado-bor-fila').forEach(fila => {
      const i = Number(fila.dataset.i);
      const input = fila.querySelector('.bor-nombre');
      const panel = fila.querySelector('.fiado-bor-panel');
      if (!input || !panel) return;
      bajasBuscadores.push(montarBuscador({
        input, panel, indice,
        onPick: p => {
          const anterior = _borrador[i] || {};
          _borrador[i] = { ...lineaDesdeProducto(p), quantity: anterior.quantity || 1 };
          _borrador[i].unit_price = precioDeLinea(_borrador[i]);
          pintarBorrador({ foco: `cant:${i}` });
        },
      }));
    });

    refrescarTotales();

    // Foco: al agregar del buscador grande vamos directo a la cantidad de la
    // última fila; al agregar a mano, al nombre.
    const ultima = host.querySelector('.fiado-bor-fila:last-child');
    if (foco === 'cant') ultima?.querySelector('.bor-cant')?.focus();
    else if (foco === 'nombre') ultima?.querySelector('.bor-nombre')?.focus();
    else if (typeof foco === 'string' && foco.startsWith('cant:')) {
      host.querySelector(`.fiado-bor-fila[data-i="${foco.slice(5)}"] .bor-cant`)?.focus();
    }
    if (typeof foco === 'string') {
      const el = document.activeElement;
      if (el && el.select) el.select();
    }
  }

  function filaBorradorHtml(l, i) {
    const p = l.producto;
    const conjunto = p && esConjunto(p);
    const vs = conjunto ? variantesDe(p) : [];
    const modos = conjunto ? modosDe(p) : [];
    const variante = conjunto ? variantePorNombre(p, l.variedad) : null;
    const uShort = conjunto ? (UNIDAD_SHORT[unidadBaseDe(p)] || 'u') : '';

    let extra = '';
    if (conjunto) {
      const stockVar = variante
        ? `${fmtCant(Math.round(unidadesDeVariante(p, variante)))} ${uShort} disponibles`
        : stockTexto(p);
      const porUnidad = l.modo === 'conjunto'
        ? `$${fmt(precioPackDe(p, variante))} el ${tipoDe(p).label.toLowerCase()}`
        : `$${fmt(precioUnidadDe(p, variante))} por ${UNIDAD_NOMBRE[unidadBaseDe(p)] || 'unidad'}`;
      extra = `
        <div class="fiado-bor-extra">
          ${chipsDe(p)}
          ${vs.length ? `
            <label class="bor-mini">Variante
              <select class="bor-variedad">
                ${vs.map(v => `<option value="${escHtml(v.color || '')}"${
                  String(v.color || '') === String(l.variedad || '') ? ' selected' : ''
                }>${escHtml(v.color || '(sin nombre)')}</option>`).join('')}
              </select>
            </label>` : ''}
          ${modos.length > 1 ? `
            <label class="bor-mini">Se lleva
              <select class="bor-modo">
                ${modos.map(m => `<option value="${m.modo}"${
                  m.modo === l.modo ? ' selected' : ''
                }>${escHtml(m.label)}</option>`).join('')}
              </select>
            </label>` : ''}
          <span class="bor-hint">${escHtml(stockVar)} · ${porUnidad}</span>
        </div>`;
    } else if (l.product_fid) {
      extra = `<div class="fiado-bor-extra"><span class="bor-hint">${
        escHtml(stockTexto(p || {}))}${p?.categoria ? ' · ' + escHtml(p.categoria) : ''}</span></div>`;
    }

    const sufijoCant = conjunto && l.modo === 'fraccion' ? uShort
                     : conjunto && l.modo === 'conjunto' ? tipoDe(p).label.toLowerCase()
                     : '';

    return `
      <div class="fiado-bor-fila${conjunto ? ' es-conjunto' : ''}" data-i="${i}">
        <div class="fiado-bor-main">
          <div class="fiado-bor-prod">
            <input class="bor-nombre" type="text" autocomplete="off" spellcheck="false"
                   value="${escHtml(l.product_name)}" placeholder="Buscá o escribí el producto">
            <div class="fiado-bor-panel fiado-resultados"></div>
          </div>
          <div class="bor-cant-wrap">
            <input class="bor-cant" type="text" inputmode="decimal" value="${fmtCant(l.quantity)}">
            ${sufijoCant ? `<span class="bor-unidad">${escHtml(sufijoCant)}</span>` : ''}
          </div>
          <input class="bor-precio" type="text" inputmode="decimal" value="${fmt(l.unit_price)}">
          <span class="bor-sub">$${fmt((Number(l.quantity) || 0) * (Number(l.unit_price) || 0))}</span>
          <button type="button" class="fiado-icon danger bor-quitar" title="Quitar línea">
            <span class="material-icons">close</span>
          </button>
        </div>
        ${extra}
      </div>`;
  }

  /** Precio que corresponde a la línea según su producto, variante y modo. */
  function precioDeLinea(l) {
    if (l.precioManual) return Number(l.unit_price) || 0;
    const p = l.producto;
    if (!p) return Number(l.unit_price) || 0;
    if (!esConjunto(p)) return precioListaDe(p);
    return precioParaModo(p, variantePorNombre(p, l.variedad), l.modo);
  }

  // Tipeo en cantidad / precio / nombre: sólo actualiza el modelo y el
  // subtotal. Repintar en cada tecla mataría el foco y el buscador de la fila.
  host.addEventListener('input', e => {
    const fila = e.target.closest('.fiado-bor-fila');
    if (!fila) return;
    const l = _borrador[Number(fila.dataset.i)];
    if (!l) return;
    if (e.target.classList.contains('bor-nombre')) {
      l.product_name = e.target.value;
      // Renombrar a mano desvincula la línea del producto del catálogo.
      if (l.producto && e.target.value !== l.producto.nombre) {
        l.producto = null; l.product_fid = ''; l.variedad = ''; l.modo = '';
      }
    }
    if (e.target.classList.contains('bor-cant'))   l.quantity   = parseNum(e.target.value);
    if (e.target.classList.contains('bor-precio')) {
      l.unit_price = parseNum(e.target.value);
      l.precioManual = true;
    }
    fila.querySelector('.bor-sub').textContent =
      '$' + fmt((Number(l.quantity) || 0) * (Number(l.unit_price) || 0));
    refrescarTotales();
  });

  // Cambiar variante o modo recalcula el precio (salvo que se haya tocado a mano).
  host.addEventListener('change', e => {
    const fila = e.target.closest('.fiado-bor-fila');
    if (!fila) return;
    const i = Number(fila.dataset.i);
    const l = _borrador[i];
    if (!l) return;
    if (e.target.classList.contains('bor-variedad')) l.variedad = e.target.value;
    else if (e.target.classList.contains('bor-modo')) l.modo = e.target.value;
    else return;
    l.unit_price = precioDeLinea(l);
    pintarBorrador();
  });

  host.addEventListener('click', e => {
    if (!e.target.closest('.bor-quitar')) return;
    const fila = e.target.closest('.fiado-bor-fila');
    _borrador.splice(Number(fila.dataset.i), 1);
    pintarBorrador();
  });

  overlay.querySelector('#fpConfirmar').addEventListener('click', async () => {
    const lineas = _borrador
      .map(l => ({ ...l, product_name: String(l.product_name || '').trim() }))
      .filter(l => l.product_name && Number(l.quantity) > 0);
    if (!lineas.length) {
      alertDialog({
        title: 'Nada para cargar',
        message: 'Completá el nombre y una cantidad mayor a cero en cada línea.',
        type: 'warning',
      });
      return;
    }
    const btn = overlay.querySelector('#fpConfirmar');
    btn.disabled = true; btn.textContent = 'Cargando...';
    try {
      await guardarLineas(estado, cliente, lineas);
      overlay.remove();
      _borrador = [];
      refrescarTodo(estado);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Cargar al fiado';
      alertDialog({ title: 'Error', message: 'No se pudo cargar: ' + escHtml(err.message || err), type: 'error' });
    }
  });

  pintarBorrador();
  inputBuscar.focus();
}

/**
 * Snapshot de la línea del carrito para que el POS la cobre igual que si la
 * hubiera cargado un cajero.
 *
 * Para productos conjunto guarda el payload que espera `Sale.create` (tipo,
 * unidad, cantidad, modo de venta y variante). El "después de vender" (unidades
 * y restante) NO va acá a propósito: entre que se anota el fiado y se cobra
 * pueden pasar semanas, así que el POS lo recalcula contra el stock vivo
 * (`revalidar_conjunto`) en el momento del cobro.
 */
function itemJsonDeLinea(l, nombre, quantity, unitPrice, subtotal) {
  const p = l.producto;
  if (!p) return null;   // línea a mano: el POS la arma con los campos de la fila

  const base = {
    product_id:      0,
    product_name:    nombre,
    quantity,
    unit_price:      unitPrice,
    original_price:  unitPrice,
    discount_type:   null,
    discount_value:  0,
    discount_amount: 0,
    promo_id:        null,
    promo_label:     '',
    subtotal,
    max_stock:       9999,
    category:        String(p.categoria || l.categoria || ''),
  };
  if (!esConjunto(p)) return base;

  const unidad = unidadBaseDe(p);
  return {
    ...base,
    is_conjunto:           true,
    conjunto_tipo:         tipoKeyDe(p),
    conjunto_unidad_base:  unidad,
    conjunto_unidad_venta: unidad,
    conjunto_cantidad:     quantity,
    conjunto_cantidad_base: quantity,
    conjunto_vender_por:   l.modo || tipoDe(p).vendePor[0],
    conjunto_color:        String(l.variedad || ''),
  };
}

async function guardarLineas(estado, cliente, lineas) {
  const entregaId = nuevoEntregaId();
  const fechaStr = ahoraStrAr();
  const batch = writeBatch(estado.db);
  const nuevos = [];

  lineas.forEach(l => {
    const quantity = Number(l.quantity) || 0;
    const unitPrice = Number(l.unit_price) || 0;
    const subtotal = Math.round(quantity * unitPrice * 100) / 100;
    const nombre = nombreLinea(l);
    const ref = doc(collection(estado.db, COL_ITEMS));
    const data = {
      cliente_fid:      cliente.doc_id,
      cliente_local_id: cliente.local_id ?? null,
      cliente_nombre:   String(cliente.nombre || ''),
      entrega_id:       entregaId,
      // El POS traduce product_fid (doc del catálogo) a su id local para
      // descontar el stock correcto cuando se cobre.
      product_id:       0,
      product_fid:      String(l.product_fid || ''),
      product_name:     nombre,
      categoria:        String(l.categoria || ''),
      quantity,
      unit_price:       unitPrice,
      subtotal,
      item_json:        itemJsonDeLinea(l, nombre, quantity, unitPrice, subtotal),
      estado:           'pendiente',
      venta_id:         null,
      pago_fid:         '',
      nota:             '',
      origen:           'web',
      pc_id:            '',
      cajero:           'Web',
      deleted:          false,
      local_id:         null,
      fecha_dt:         serverTimestamp(),
      fecha_str:        fechaStr,
      actualizado:      serverTimestamp(),
    };
    batch.set(ref, data);
    nuevos.push({ doc_id: ref.id, id: ref.id, ...data, fecha_dt: new Date() });
  });

  await batch.commit();
  // Optimista: el listener del store confirma en un instante, pero así la
  // pantalla no parpadea esperando el snapshot.
  estado.items.push(...nuevos);
}

// ── Overlay genérico ──────────────────────────────────────────────────────────
function crearOverlay(innerHtml, maxWidth = 520) {
  document.querySelector('.fiado-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay fiado-overlay';
  overlay.innerHTML = `<div class="fiado-modal" style="max-width:${maxWidth}px">${innerHtml}</div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelectorAll('[data-cerrar]').forEach(b =>
    b.addEventListener('click', () => overlay.remove()));
  const onKey = e => {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);
  return overlay;
}

// ── Estilos ───────────────────────────────────────────────────────────────────
function estilos() {
  return `<style>
    .fiado-wrap { display:flex; flex-direction:column; gap:16px }
    .fiado-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap }
    .fiado-title { margin:0; font-size:22px; font-weight:800; color:var(--primary) }
    .fiado-sub { margin:4px 0 0; font-size:13px; color:var(--text-muted) }
    .fiado-head-actions { display:flex; gap:8px }

    .fiado-btn-primary { display:inline-flex; align-items:center; gap:6px; background:var(--primary);
      color:#fff; border:none; border-radius:8px; padding:10px 18px; font-size:14px; font-weight:700;
      cursor:pointer; font-family:inherit }
    .fiado-btn-primary:hover { background:var(--primary-dark) }
    .fiado-btn-primary:disabled { background:#c8b8d8; cursor:default }
    .fiado-btn-primary .material-icons { font-size:18px }
    .fiado-btn-ghost { background:var(--surface); color:var(--text-muted); border:1px solid var(--border);
      border-radius:8px; padding:10px 16px; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit }
    .fiado-btn-ghost:hover { background:var(--surface-2); color:var(--text) }
    .fiado-btn-danger { margin-right:auto; background:var(--tint-red-bg); color:var(--tint-red-fg);
      border:1px solid var(--tint-red-fg); border-radius:8px; padding:10px 16px; font-size:13px;
      font-weight:600; cursor:pointer; font-family:inherit }
    .fiado-btn-danger:hover { background:var(--tint-red-fg); color:#fff }
    .fiado-btn-link { display:inline-flex; align-items:center; gap:4px; background:none; border:none;
      color:var(--primary); font-size:13px; font-weight:600; cursor:pointer; padding:6px 0; font-family:inherit }
    .fiado-btn-link .material-icons { font-size:17px }

    .fiado-grid { display:grid; grid-template-columns:300px 1fr; gap:16px; align-items:start }
    @media (max-width:900px) { .fiado-grid { grid-template-columns:1fr } }

    .fiado-aside { background:var(--surface); border:1px solid var(--border); border-radius:12px;
      padding:12px; display:flex; flex-direction:column; gap:10px; box-shadow:var(--shadow-sm) }
    .fiado-search { position:relative }
    .fiado-search .material-icons { position:absolute; left:10px; top:50%; transform:translateY(-50%);
      color:var(--text-muted); font-size:19px }
    .fiado-search input { width:100%; box-sizing:border-box; padding:9px 12px 9px 36px; font-size:13px;
      border:1px solid var(--border); border-radius:8px; background:var(--surface-2); font-family:inherit;
      color:var(--text) }
    .fiado-search input:focus { outline:none; border-color:var(--primary); background:var(--surface) }
    .fiado-lista { display:flex; flex-direction:column; gap:6px; max-height:70vh; overflow-y:auto }

    .fiado-cli { text-align:left; background:var(--surface-2); border:1px solid var(--border);
      border-radius:9px; padding:9px 11px; cursor:pointer; font-family:inherit; display:flex;
      flex-direction:column; gap:3px }
    .fiado-cli:hover { border-color:var(--primary); background:var(--tint-purple-bg) }
    .fiado-cli.activo { border-color:var(--primary); border-width:1.5px; background:var(--tint-purple-bg) }
    .fiado-cli-top { display:flex; align-items:center; justify-content:space-between; gap:8px }
    .fiado-cli-nombre { font-size:13.5px; font-weight:700; color:var(--text) }
    .fiado-cli-sub { font-size:11.5px; color:var(--text-muted) }
    .fiado-monto { font-size:13.5px; font-weight:800; color:var(--primary); font-variant-numeric:tabular-nums }
    .fiado-chip { font-size:10.5px; font-weight:700; border-radius:10px; padding:2px 8px; white-space:nowrap }
    .fiado-chip.favor { background:var(--tint-green-bg); color:var(--tint-green-fg) }
    .fiado-chip.ok { background:var(--surface-3); color:var(--text-muted); border:1px solid var(--border) }

    .fiado-detalle { display:flex; flex-direction:column; gap:12px; min-width:0 }
    .fiado-card { background:var(--surface); border:1px solid var(--border); border-radius:12px;
      box-shadow:var(--shadow-sm) }
    .fiado-card.cliente { border-left:4px solid var(--primary); padding:16px 18px; display:flex;
      align-items:flex-start; gap:16px; flex-wrap:wrap }
    .fiado-cliente-info { flex:1; min-width:180px }
    .fiado-cliente-info h3 { margin:0; font-size:19px; font-weight:800; color:var(--text) }
    .fiado-cliente-datos { margin:4px 0 0; font-size:12px; color:var(--text-muted) }
    .fiado-cliente-nota { margin:5px 0 0; font-size:12px; color:var(--text-muted); font-style:italic }
    .fiado-saldo { display:flex; flex-direction:column; align-items:flex-end; min-width:130px }
    .fiado-saldo-lbl { font-size:10px; font-weight:800; letter-spacing:0.7px; color:var(--text-muted) }
    .fiado-saldo-monto { font-size:28px; font-weight:800; line-height:1.1; font-variant-numeric:tabular-nums }
    .fiado-saldo.debe .fiado-saldo-monto { color:var(--primary) }
    .fiado-saldo.favor .fiado-saldo-monto { color:var(--tint-green-fg) }
    .fiado-saldo.cero .fiado-saldo-monto { color:var(--text-muted) }
    .fiado-saldo-extra { font-size:11px; color:var(--text-muted); margin-top:2px }
    .fiado-cliente-btns { display:flex; flex-direction:column; gap:7px }
    .fiado-cliente-btns-row { display:flex; gap:7px }
    .fiado-cliente-btns-row .fiado-btn-ghost { flex:1 }
    .fiado-btn-ghost.danger { flex:0 0 auto; display:inline-flex; align-items:center;
      justify-content:center; padding:10px 12px; color:var(--tint-red-fg) }
    .fiado-btn-ghost.danger:hover { background:var(--tint-red-bg); border-color:var(--tint-red-fg);
      color:var(--tint-red-fg) }
    .fiado-btn-ghost.danger .material-icons { font-size:19px }

    .fiado-aviso { display:flex; align-items:center; gap:10px; background:var(--tint-purple-bg);
      border:1px solid var(--border); border-radius:10px; padding:10px 14px; font-size:12.5px;
      color:var(--tint-purple-fg) }
    .fiado-aviso .material-icons { font-size:20px }
    .fiado-aviso b { font-weight:800 }

    .fiado-card.vacio-ok { display:flex; align-items:center; justify-content:center; gap:8px;
      padding:22px; color:var(--tint-green-fg); background:var(--tint-green-bg);
      border-color:var(--tint-green-fg); font-size:13.5px; font-weight:600 }

    .fiado-grupo-head { display:flex; align-items:center; justify-content:space-between; gap:10px;
      padding:10px 16px; background:var(--surface-3); border-bottom:1px solid var(--border);
      border-radius:12px 12px 0 0 }
    .fiado-grupo-fecha { font-size:12.5px; font-weight:700; color:var(--text) }
    .fiado-grupo-origen { font-size:11px; color:var(--text-muted); margin-left:8px }
    .fiado-grupo-total { font-size:14px; font-weight:800; color:var(--primary); font-variant-numeric:tabular-nums }
    .fiado-items { display:flex; flex-direction:column }
    .fiado-item { display:flex; align-items:center; gap:12px; padding:9px 16px;
      border-bottom:1px solid var(--border) }
    .fiado-item:last-child { border-bottom:none }
    .fiado-item-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px }
    .fiado-item-nombre { font-size:13px; font-weight:600; color:var(--text) }
    .fiado-item-detalle { font-size:11.5px; color:var(--text-muted); font-variant-numeric:tabular-nums }
    .fiado-item-monto { font-size:13.5px; font-weight:700; color:var(--text); font-variant-numeric:tabular-nums }
    .fiado-item-btns { display:flex; gap:4px }
    .fiado-icon { background:none; border:1px solid transparent; border-radius:6px; cursor:pointer;
      color:var(--text-muted); padding:4px; display:flex; align-items:center }
    .fiado-icon .material-icons { font-size:17px }
    .fiado-icon:hover { background:var(--surface-3); border-color:var(--border); color:var(--text) }
    .fiado-icon.danger:hover { background:var(--tint-red-bg); border-color:var(--tint-red-fg); color:var(--tint-red-fg) }

    .fiado-hist-head { width:100%; display:flex; align-items:center; justify-content:space-between;
      background:none; border:none; padding:12px 16px; cursor:pointer; font-family:inherit;
      font-size:11.5px; font-weight:800; letter-spacing:0.5px; color:var(--text-muted); text-transform:uppercase }
    .fiado-hist-body { border-top:1px solid var(--border) }
    .fiado-hist-row { display:flex; align-items:center; gap:10px; padding:7px 16px;
      border-bottom:1px solid var(--border); font-size:11.5px; color:var(--text-muted) }
    .fiado-hist-row:last-child { border-bottom:none }
    .fiado-hist-row.pago { background:var(--surface-2) }
    .fiado-hist-txt { flex:1; min-width:0 }
    .fiado-hist-estado { font-size:10.5px; opacity:0.8 }
    .fiado-hist-monto { font-variant-numeric:tabular-nums; font-weight:600 }
    .fiado-hist-monto.verde { color:var(--tint-green-fg) }
    .fiado-hist-monto.tachado { text-decoration:line-through }
    .fiado-hist-vacio { margin:0; padding:0 16px 14px; font-size:12px; color:var(--text-muted) }

    .fiado-empty { background:var(--surface); border:2px dashed var(--border); border-radius:12px;
      padding:56px 24px; text-align:center; color:var(--text-muted) }
    .fiado-empty .material-icons { font-size:46px; opacity:0.35; display:block; margin-bottom:10px }
    .fiado-empty h3 { margin:0 0 6px; font-size:16px; color:var(--text) }
    .fiado-empty p { margin:0; font-size:13px }
    .fiado-empty .fiado-nota { margin-top:14px; font-size:12px }
    .fiado-empty-small { text-align:center; padding:28px 10px; color:var(--text-muted); font-size:12px }
    .fiado-empty-small .material-icons { font-size:30px; opacity:0.35; display:block; margin-bottom:6px }
    .fiado-empty-small p { margin:0 }

    .fiado-overlay { position:fixed; inset:0; background:var(--overlay); z-index:1200;
      display:flex; align-items:center; justify-content:center; padding:16px }
    .fiado-modal { background:var(--surface); border-radius:14px; padding:22px; width:100%;
      max-height:90vh; overflow-y:auto; box-shadow:var(--shadow-modal) }
    .fiado-modal-title { margin:0; font-size:18px; font-weight:800; color:var(--text) }
    .fiado-modal-sub { margin:5px 0 16px; font-size:12.5px; color:var(--text-muted) }
    .fiado-form { display:flex; flex-direction:column; gap:12px }
    .fiado-form label { display:flex; flex-direction:column; gap:5px; font-size:11px; font-weight:700;
      letter-spacing:0.4px; color:var(--text-muted); text-transform:uppercase; flex:1 }
    .fiado-form input, .fiado-form textarea { padding:9px 11px; border:1px solid var(--border);
      border-radius:8px; font-size:13.5px; font-family:inherit; background:var(--surface);
      color:var(--text); text-transform:none; font-weight:400; letter-spacing:normal; box-sizing:border-box }
    .fiado-form input:focus, .fiado-form textarea:focus { outline:none; border-color:var(--primary) }
    .fiado-form-row { display:flex; gap:12px }
    @media (max-width:520px) { .fiado-form-row { flex-direction:column } }
    .fiado-total-preview { font-size:13px; color:var(--text-muted); text-align:right }
    .fiado-total-preview b { color:var(--primary); font-size:16px; font-variant-numeric:tabular-nums }
    .fiado-modal-footer { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-top:18px }
    .fiado-modal-total { margin-right:auto; font-size:15px; font-weight:800; color:var(--primary);
      font-variant-numeric:tabular-nums }

    /* ── Buscador de catálogo ── */
    .fiado-buscador { position:relative; margin-bottom:6px }
    .fiado-buscador > .material-icons { position:absolute; left:12px; top:50%; transform:translateY(-50%);
      color:var(--text-muted); font-size:20px; pointer-events:none; transition:color .15s }
    .fiado-buscador:focus-within > .material-icons { color:var(--primary) }
    .fiado-buscador input { width:100%; box-sizing:border-box; padding:12px 150px 12px 40px; font-size:14px;
      border:1.5px solid var(--border); border-radius:10px; font-family:inherit; background:var(--surface-2);
      color:var(--text); transition:border-color .15s, background .15s, box-shadow .15s }
    .fiado-buscador input:focus { outline:none; border-color:var(--primary); background:var(--surface);
      box-shadow:0 0 0 3px color-mix(in srgb, var(--primary) 15%, transparent) }
    .fiado-buscador-hint { position:absolute; right:12px; top:50%; transform:translateY(-50%);
      font-size:10.5px; color:var(--text-muted); opacity:0; transition:opacity .15s; pointer-events:none;
      white-space:nowrap }
    .fiado-buscador:focus-within .fiado-buscador-hint { opacity:0.75 }
    @media (max-width:620px) {
      .fiado-buscador input { padding-right:14px }
      .fiado-buscador-hint { display:none }
    }

    .fiado-resultados { display:none; position:absolute; left:0; right:0; top:calc(100% + 5px); z-index:20;
      background:var(--surface); border:1px solid var(--border-strong); border-radius:11px;
      box-shadow:var(--shadow-lg); max-height:min(56vh, 380px); overflow-y:auto; overscroll-behavior:contain;
      animation:fiadoDrop .13s ease-out }
    .fiado-resultados.open { display:block }
    @keyframes fiadoDrop { from { opacity:0; transform:translateY(-5px) } to { opacity:1; transform:none } }

    .fiado-res { width:100%; display:flex; align-items:center; justify-content:space-between; gap:12px;
      padding:9px 13px; background:none; border:none; border-bottom:1px solid var(--border);
      cursor:pointer; font-family:inherit; text-align:left }
    .fiado-res:last-child { border-bottom:none }
    .fiado-res.activo { background:var(--tint-purple-bg); box-shadow:inset 3px 0 0 var(--primary) }
    .fiado-res-main { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1 }
    .fiado-res-nombre { font-size:13.5px; color:var(--text); font-weight:600; white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis }
    .fiado-res-nombre mark { background:color-mix(in srgb, var(--primary) 26%, transparent);
      color:inherit; border-radius:3px; padding:0 1px }
    .fiado-res-meta { font-size:11px; color:var(--text-muted); white-space:nowrap; overflow:hidden;
      text-overflow:ellipsis }
    .fiado-res-right { display:flex; align-items:center; gap:8px; flex-shrink:0 }
    .fiado-res-chips { display:flex; gap:4px }
    .fiado-res-precio { font-size:13px; font-weight:800; color:var(--primary);
      font-variant-numeric:tabular-nums; min-width:74px; text-align:right }
    .fiado-res-vacio { display:flex; align-items:center; justify-content:center; gap:7px;
      padding:18px; font-size:12.5px; color:var(--text-muted) }
    .fiado-res-vacio .material-icons { font-size:19px; opacity:0.5 }

    .fiado-chip-tag { font-size:10px; font-weight:700; border-radius:5px; padding:2px 6px;
      white-space:nowrap; letter-spacing:0.2px }
    .fiado-chip-tag.variantes { background:var(--tint-purple-bg); color:var(--tint-purple-fg) }
    .fiado-chip-tag.fraccion  { background:var(--tint-blue-bg);   color:var(--tint-blue-fg) }
    .fiado-chip-tag.pack      { background:var(--tint-orange-bg); color:var(--tint-orange-fg) }

    /* ── Borrador de líneas ── */
    /* Sin overflow:hidden — recortaría el dropdown del buscador de cada fila.
       El redondeo se aplica al encabezado y a la última fila. */
    .fiado-borrador { margin-top:10px; border:1px solid var(--border); border-radius:10px }
    .fiado-bor-head { border-radius:9px 9px 0 0 }
    .fiado-borrador > .fiado-bor-fila:last-child { border-radius:0 0 9px 9px }
    .fiado-bor-vacio { border-radius:9px }
    .fiado-bor-vacio { display:flex; flex-direction:column; align-items:center; gap:8px; padding:26px 16px;
      text-align:center; font-size:12.5px; color:var(--text-muted) }
    .fiado-bor-vacio .material-icons { font-size:30px; opacity:0.3 }
    .fiado-bor-head, .fiado-bor-main { display:grid; grid-template-columns:1fr 104px 116px 96px 32px;
      gap:8px; align-items:center }
    .fiado-bor-head { padding:7px 12px; background:var(--surface-3); font-size:10.5px; font-weight:800;
      letter-spacing:0.4px; color:var(--text-muted); text-transform:uppercase;
      border-bottom:1px solid var(--border) }
    .fiado-bor-fila { padding:8px 12px; border-bottom:1px solid var(--border) }
    .fiado-bor-fila:last-child { border-bottom:none }
    .fiado-bor-fila.es-conjunto { background:color-mix(in srgb, var(--tint-purple-bg) 40%, transparent) }
    .fiado-bor-prod { position:relative; min-width:0 }
    .fiado-bor-panel { top:calc(100% + 3px) }
    .fiado-bor-fila input, .fiado-bor-fila select { padding:7px 9px; border:1px solid var(--border);
      border-radius:6px; font-size:12.5px; font-family:inherit; background:var(--surface);
      color:var(--text); min-width:0; box-sizing:border-box }
    .fiado-bor-fila input:focus, .fiado-bor-fila select:focus { outline:none; border-color:var(--primary) }
    .fiado-bor-fila .bor-nombre { width:100% }
    .bor-cant-wrap { position:relative; display:flex; align-items:center }
    .bor-cant-wrap .bor-cant { width:100%; text-align:right; padding-right:30px;
      font-variant-numeric:tabular-nums }
    .bor-unidad { position:absolute; right:8px; font-size:10.5px; color:var(--text-muted);
      pointer-events:none; max-width:26px; overflow:hidden }
    .fiado-bor-fila .bor-precio { text-align:right; font-variant-numeric:tabular-nums }
    .bor-sub { font-size:12.5px; font-weight:700; text-align:right; font-variant-numeric:tabular-nums;
      color:var(--text) }
    .fiado-bor-extra { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:6px;
      padding-left:2px }
    .bor-mini { display:inline-flex; align-items:center; gap:5px; font-size:10px; font-weight:700;
      letter-spacing:0.3px; color:var(--text-muted); text-transform:uppercase }
    .bor-mini select { font-size:11.5px; font-weight:600; text-transform:none; letter-spacing:normal;
      padding:4px 6px; max-width:170px }
    .bor-hint { font-size:11px; color:var(--text-muted); margin-left:auto; text-align:right }
    @media (max-width:620px) {
      .fiado-bor-head { display:none }
      .fiado-bor-main { grid-template-columns:1fr 1fr 32px; grid-auto-rows:auto }
      .fiado-bor-prod { grid-column:1 / -1 }
      .bor-sub { grid-column:1 / 3; text-align:left }
      .bor-hint { margin-left:0; text-align:left; width:100% }
    }
  </style>`;
}
