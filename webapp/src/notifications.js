/**
 * Notificaciones globales de stock bajo.
 *
 * Detecta productos cuyo stock efectivo ya está en o por debajo de `stock_min`,
 * y dispara dos avisos: un toast in-app que aparece arriba en cualquier página,
 * y (si el usuario lo permite) una notificación nativa del navegador. Desde
 * cualquiera de los dos, el click lleva al editor del producto en el catálogo
 * para que el usuario pueda rellenar.
 *
 * Eventos:
 *   - Init: subscribe a config/catalogo_meta y carga el catálogo una vez para
 *           establecer el baseline (no spam-ea toasts por estado inicial).
 *   - Cambio: re-carga, diff vs estado anterior, dispara toasts SÓLO para
 *             productos que recién cruzaron el umbral.
 *
 * Persistencia:
 *   - `notif:browser_enabled` (localStorage): preferencia del usuario.
 *   - `notif:silenced_until` (localStorage): timestamp hasta el que se silencia
 *     todo (no implementado todavía, dejado para futuro).
 */
import { collection, getDocs, doc, onSnapshot, query, orderBy, limit, setDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { getCached } from './cache.js';
import { fechaDMYtoYMD } from './config.js';
import { alertaPorBulto, bultoDe, textoBultos } from './bulto.js';

// ── Estado interno ───────────────────────────────────────────────────────────
let _db = null;
let _initialized = false;
let _productos = [];           // último snapshot del catálogo
let _activeIds = new Set();    // doc_ids actualmente en alerta (stock <= stock_min)
let _lastStockPorKey = new Map(); // key → último stock notificado, para re-alertar si baja más
let _listeners = new Set();    // suscriptores (página /notificaciones)
let _toastRoot = null;
let _unsubMeta = null;
let _lastMetaTs = null;
let _refreshing = false;
let _pendingRefresh = false;
let _refreshPromise = null;    // refresh en vuelo — los que llegan tarde lo esperan
let _baselineDone = false;

// ── Velocidad de venta (recomendación de reposición urgente) ─────────────────
// Mapa nombre_normalizado → unidades vendidas en la ventana reciente. Se usa
// para detectar qué productos en alerta de stock ROTAN seguido y, por lo tanto,
// son urgentes de reponer. Se carga desde la misma cache que "Productos más
// vendidos" (`productos:items_rich`), así no agrega lecturas a Firestore.
let _velocidadPorNombre = new Map();       // nombre → unidades vendidas en la ventana
let _velocidadPorNombreColor = new Map();  // "nombre||color" → unidades (variedades de conjuntos)
let _nombresConColor = new Set();          // productos cuyas ventas vienen con conjunto_color (docs nuevos)
let _consumoPorDocId = new Map();  // doc_id → unidades consumidas vía vinculaciones (impresiones → hoja, etc.)
let _primerMovPorNombre = new Map();  // nombre → ymd de la primera venta en la ventana (ritmo de productos nuevos)
let _primerMovPorDocId = new Map();   // doc_id → ymd del primer consumo vinculado en la ventana
let _hoyYmd = '';                  // fecha AR del último refresh de velocidades
let _umbralTop = Infinity;       // unidades de la ventana en el percentil 80 (top vendidos)

const VENTANA_DIAS = 30;          // ventana de ventas recientes para medir el ritmo
const UMBRAL_DIAS_COBERTURA = 7;  // si al ritmo actual se agota en ≤ esto → urgente
const MIN_VENTAS_URGENTE = 3;     // mínimo vendido para escalar a urgente una alerta ya existente
const MIN_VENTAS_RITMO = 8;       // mínimo vendido para generar urgencia SOLA por ritmo (sin stock_min)

const LS_BROWSER_ENABLED = 'notif:browser_enabled';
const LS_IGNORADOS = 'notif:ignorados';   // cache local del listado (carga instantánea)
const IGNORADOS_DOC = ['config', 'notif_ignorados'];   // doc Firestore compartido entre PCs
const TOAST_DURATION_MS = 9000;

// ── Productos ocultados por el usuario ───────────────────────────────────────
// Fuente de verdad: doc Firestore `config/notif_ignorados` { ids: [...] }, así
// lo que se oculta en una PC se oculta en todas (listener en tiempo real).
// localStorage queda solo como cache para mostrar el estado al instante mientras
// llega el primer snapshot.
let _ignorados = null;   // Set<doc_id>
let _unsubIgnorados = null;

function _cargarIgnorados() {
  if (_ignorados) return _ignorados;
  _ignorados = new Set();
  try {
    const raw = localStorage.getItem(LS_IGNORADOS);
    if (raw) for (const id of JSON.parse(raw)) _ignorados.add(String(id));
  } catch (e) { /* cache corrupto: arrancamos vacío */ }
  return _ignorados;
}

function _cacheIgnoradosLocal() {
  try { localStorage.setItem(LS_IGNORADOS, JSON.stringify([..._cargarIgnorados()])); } catch (e) {}
}

function _suscribirIgnorados() {
  if (!_db || _unsubIgnorados) return;
  try {
    _unsubIgnorados = onSnapshot(doc(_db, ...IGNORADOS_DOC), (snap) => {
      const ids = (snap.exists() && Array.isArray(snap.data().ids)) ? snap.data().ids : [];
      _ignorados = new Set(ids.map(String));
      _cacheIgnoradosLocal();
      _emitChange(_calcularAlertas(_productos));   // refresca todas las pestañas/PCs
    }, (err) => console.warn('[notificaciones] listener ignorados:', err));
  } catch (e) {
    console.warn('[notificaciones] no se pudo subscribir a ignorados:', e);
  }
}

export function obtenerIgnorados() {
  return [..._cargarIgnorados()];
}

export function ignorarProducto(docId) {
  if (!docId) return;
  const id = String(docId);
  _cargarIgnorados().add(id);            // optimista: se ve al toque
  _cacheIgnoradosLocal();
  _emitChange(_calcularAlertas(_productos));
  if (_db) setDoc(doc(_db, ...IGNORADOS_DOC), { ids: arrayUnion(id) }, { merge: true })
    .catch(e => console.warn('[notificaciones] error guardando oculto:', e));
}

export function restaurarProducto(docId) {
  if (!docId) return;
  const id = String(docId);
  _cargarIgnorados().delete(id);
  _cacheIgnoradosLocal();
  _emitChange(_calcularAlertas(_productos));
  if (_db) setDoc(doc(_db, ...IGNORADOS_DOC), { ids: arrayRemove(id) }, { merge: true })
    .catch(e => console.warn('[notificaciones] error restaurando oculto:', e));
}

export function restaurarTodos() {
  _cargarIgnorados().clear();
  _cacheIgnoradosLocal();
  _emitChange(_calcularAlertas(_productos));
  if (_db) setDoc(doc(_db, ...IGNORADOS_DOC), { ids: [] }, { merge: true })
    .catch(e => console.warn('[notificaciones] error restaurando todos:', e));
}

// ── Helpers de catálogo ──────────────────────────────────────────────────────
// Unidades que trae un pack/rollo de esta variedad: el propio si lo tiene, si
// no el global del producto. Sin ninguno de los dos vale 1 (el pack ES la
// unidad), nunca 0: con 0 los packs enteros desaparecían del total y el
// producto figuraba sin stock teniéndolo.
function _contenidoVariedad(c, globalCont) {
  const propio = Number(c && c.contenido) || 0;
  if (propio > 0) return propio;
  const gl = Number(globalCont) || 0;
  return gl > 0 ? gl : 1;
}

function _stockTotalVariedad(c, globalCont) {
  const u  = Number(c.unidades) || 0;
  const r  = Number(c.restante) || 0;
  return u * _contenidoVariedad(c, globalCont) + r;
}

// Unidad de medida del contenido — lo que se cuenta suelto (metros, unidades…).
const _UM_NOMBRES = {
  metros: ['metro', 'metros'], metro: ['metro', 'metros'],
  cm: ['cm', 'cm'], m2: ['m²', 'm²'],
  gramos: ['gramo', 'gramos'], kilos: ['kilo', 'kilos'], litros: ['litro', 'litros'],
};
function _umProducto(p) {
  const um = ((p && p.conjunto_unidad_medida) || '').toLowerCase();
  const par = _UM_NOMBRES[um] || ['unidad', 'unidades'];
  return { sg: par[0], pl: par[1] };
}

// Envase del conjunto (rollo / pack / caja / …). Tipo "unidad" o sin tipo
// reconocido: el envase ES la unidad de medida.
const _ENVASE_NOMBRES = {
  rollo: ['rollo', 'rollos'], pack: ['pack', 'packs'], caja: ['caja', 'cajas'],
  bobina: ['bobina', 'bobinas'], bolsa: ['bolsa', 'bolsas'],
  plancha: ['plancha', 'planchas'], cartulina: ['cartulina', 'cartulinas'],
  papel: ['hoja', 'hojas'], carton: ['cartón', 'cartones'],
  goma_eva: ['plancha', 'planchas'], cinta: ['rollo', 'rollos'], tela: ['rollo', 'rollos'],
};
function _envaseProducto(p) {
  if (!p || !(p.es_conjunto === true || p.es_conjunto === 1)) return _umProducto(p);
  const par = _ENVASE_NOMBRES[(p.conjunto_tipo || '').toLowerCase()];
  return par ? { sg: par[0], pl: par[1] } : _umProducto(p);
}

function _stockEfectivo(p) {
  if (p && (p.es_conjunto === true || p.es_conjunto === 1)) {
    const variedades = Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [];
    if (variedades.length > 0) {
      const globalCont = Number(p.conjunto_contenido || 0);
      const total = variedades.reduce((acc, c) => acc + _stockTotalVariedad(c, globalCont), 0);
      return total;
    }
    return Number(p.conjunto_total || 0);
  }
  return Number(p.stock) || 0;
}

// Servicios del local de fotocopias (impresión, fotocopia, plastificado,
// anillado, escaneo...). NO se reponen ellos: lo que se repone es su insumo
// (la hoja/plástico vinculado, ya contado por consumo). Aunque figuren con
// stock 0 o negativo, no deben aparecer en las alertas.
const _RE_SERVICIO = /impres|fotocopia|plastific|anillad|encuaderna|escane|laminad|ampliaci[oó]n|reducci[oó]n/i;
// Insumos cuyo nombre puede mencionar el servicio ("Hoja para fotocopias A4"):
// son lo que se REPONE, nunca deben quedar excluidos como servicio.
const _RE_INSUMO = /hoja|resma|papel|cartulina|opalina|acetato|etiqueta/i;
function _esServicio(p) {
  if (!p) return false;
  const vinc = p.vinculaciones;
  if ((Array.isArray(vinc) && vinc.length > 0) || p.vinculado_a) return true; // consume otro producto al venderse
  const nombre = p.nombre || '';
  if (_RE_INSUMO.test(nombre)) return false;
  return _RE_SERVICIO.test(nombre);
}

function _alertasProducto(p) {
  const out = [];
  // -1 = ilimitado/servicio: nunca alertar.
  const stockRaw = Number(p.stock);
  if (stockRaw === -1) return out;
  if (_esServicio(p)) return out;   // servicios (impresión/fotocopia/etc.): no se reponen

  const nombreBase = p.nombre || '(sin nombre)';
  const esConjunto = p && (p.es_conjunto === true || p.es_conjunto === 1);
  const variedades = esConjunto && Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [];

  // 1) Alerta por variedad. Dos fuentes:
  //    a. Con stock_min explícito: dispara toast + notif del navegador.
  //       Se compara el STOCK REAL de la variedad (packs enteros + unidades
  //       sueltas del pack abierto), expresado en la misma unidad en la que se
  //       escribe el mínimo: en packs/rollos cuando el pack trae más de una
  //       unidad — así "1 pack mínimo" sigue funcionando sin importar el
  //       contenido — y en unidades cuando el pack ES la unidad.
  //       NUNCA se mira sólo el contador de packs: una variedad con 0 packs y
  //       15 sueltos tiene 15, no está agotada.
  //    b. Sin stock_min, pero el TOTAL EN UNIDADES SUELTAS (unidades*contenido
  //       + restante) es 0 o ≤ 2: auto-detección de variantes bajas. Se marcan
  //       con `auto: true` y NO disparan toast individual — solo aparecen en
  //       la página /notificaciones. Esto matchea el contador "VARIANTES BAJAS"
  //       del Dashboard que también compara el total real, no el contador.
  //       Importante: una variedad con 1 pack × 5 unidades NO es "casi vacía".
  const VARIEDAD_AUTO_UMBRAL = 2;
  if (variedades.length > 0) {
    const globalCont = Number(p.conjunto_contenido || 0);
    for (const c of variedades) {
      const sMinVar = Number(c.stock_min) || 0;
      const sMaxVar = Number(c.stock_max) || 0;
      const uEnvase = _envaseProducto(p);
      const uMedida = _umProducto(p);
      const contVar = _contenidoVariedad(c, globalCont);
      const totalUnitsVar = _stockTotalVariedad(c, globalCont);
      // Unidad de los umbrales: la elegida a mano en el editor
      // (`stock_min_um`) o, si no se eligió, packs cuando el pack trae más de
      // una unidad y unidades cuando el pack ES la unidad.
      const umVar = (c.stock_min_um === 'pack' || c.stock_min_um === 'unidad')
        ? c.stock_min_um
        : (contVar > 1 ? 'pack' : 'unidad');
      const enPacks = umVar === 'pack' && contVar > 1;
      // Stock comparable contra el mínimo. En packs: packs equivalentes
      // (90 unidades de un pack de 100 = 0,9 packs, sigue por debajo de
      // "1 pack mínimo"). En unidades: el total real tal cual.
      const stockComparable = enPacks
        ? Math.round((totalUnitsVar / contVar) * 10000) / 10000
        : totalUnitsVar;

      let dispara = false;
      let auto = false;
      let stockMinUsado = sMinVar;
      let stockMostrar = stockComparable;
      let unidadSingPlural = enPacks
        ? (stockComparable === 1 ? uEnvase.sg : uEnvase.pl)
        : (stockComparable === 1 ? uMedida.sg : uMedida.pl);
      let critico = false;
      // Cuando el aviso se expresa en packs, mostrar también las unidades
      // reales: "0,9 packs (90 unidades)" en vez de un "sin stock" falso.
      let equiv = (enPacks && totalUnitsVar > 0)
        ? `${_fmt(totalUnitsVar)} ${totalUnitsVar === 1 ? uMedida.sg : uMedida.pl}`
        : null;

      if (sMinVar > 0 && stockComparable <= sMinVar) {
        // Alerta configurada: stock real (packs + sueltos) vs stock_min
        dispara = true;
        // "Sin stock" sólo si no queda NADA real, ni una unidad suelta.
        critico = totalUnitsVar <= 0;
      } else if (sMinVar <= 0 && totalUnitsVar <= VARIEDAD_AUTO_UMBRAL) {
        // Alerta auto: comparar total real en unidades sueltas
        dispara = true;
        auto = true;
        stockMinUsado = VARIEDAD_AUTO_UMBRAL;
        stockMostrar = totalUnitsVar;
        unidadSingPlural = totalUnitsVar === 1 ? uMedida.sg : uMedida.pl;
        equiv = null;
        critico = totalUnitsVar === 0;
      }
      if (!dispara) continue;

      // Se compra de a envases enteros → el faltante se redondea para arriba.
      const sugerencia = sMaxVar > stockMinUsado
        ? Math.max(0, Math.ceil(sMaxVar - stockMostrar))
        : null;
      out.push({
        key: p.doc_id + '|' + (auto ? 'varauto:' : 'var:') + (c.color || ''),
        doc_id: p.doc_id,
        variedad: c.color || '',
        nombre: nombreBase + ' · ' + (c.color || ''),
        codigo: p.codigo || '',
        rubro: p.rubro || '',
        sub_rubro: p.sub_rubro || '',
        marca: p.marca || '',
        stock: stockMostrar,
        stock_total_unidades: totalUnitsVar,
        stock_min: stockMinUsado,
        stock_max: sMaxVar || null,
        unidad_label: unidadSingPlural,
        stock_equiv: equiv,
        sugerencia,
        critico,
        auto,
        producto: p,
      });
    }
  }

  // 2) Alerta global del producto (stock_min a nivel producto)
  const stockMin = Number(p.stock_min) || 0;
  if (stockMin > 0) {
    const stock = _stockEfectivo(p);
    if (stock <= stockMin) {
      const stockMax = Number(p.stock_max) || 0;
      const sugerencia = stockMax > stockMin ? Math.max(0, stockMax - stock) : null;
      // Producto configurado para avisar por caja/pack/rollo: los umbrales
      // siguen viviendo en unidades, pero el aviso se expresa en envases
      // ("Quedan 2 cajas + 3 u · mín 3 cajas").
      const bulto = alertaPorBulto(p);
      // Sin configurar nada: si se puede deducir el envase (conjunto o nombre),
      // el aviso igual muestra a cuántas cajas equivale lo que queda.
      const bultoAuto = bulto ? null : bultoDe(p);
      out.push({
        key: p.doc_id,
        doc_id: p.doc_id,
        variedad: null,
        nombre: nombreBase,
        codigo: p.codigo || '',
        rubro: p.rubro || '',
        sub_rubro: p.sub_rubro || '',
        marca: p.marca || '',
        stock,
        stock_min: stockMin,
        stock_max: stockMax || null,
        sugerencia,
        critico: stock === 0,
        bulto: bulto || bultoAuto || null,
        stock_texto: bulto ? textoBultos(stock, bulto) : null,
        min_texto:   bulto ? textoBultos(stockMin, bulto, { exacto: true }) : null,
        max_texto:   bulto && stockMax > 0 ? textoBultos(stockMax, bulto, { exacto: true }) : null,
        sugerencia_texto: bulto && sugerencia > 0 ? textoBultos(sugerencia, bulto) : null,
        // Equivalencia informativa cuando el aviso va en unidades: "1 caja + 6 u".
        // Sólo si llega a un envase entero: "menos de 1 caja" no agrega nada a
        // las unidades que ya se muestran.
        stock_equiv: (bultoAuto && stock >= bultoAuto.contenido) ? textoBultos(stock, bultoAuto) : null,
        producto: p,
      });
    }
  }

  return out;
}

// ── Velocidad de venta ────────────────────────────────────────────────────────
function _normNombre(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Carga las unidades vendidas por producto en la ventana reciente y deja listo
// el umbral de "top vendidos". Es barato: reusa la cache de la página de
// ranking. Falla en silencio (sin ventas → simplemente no hay urgencias).
async function _cargarVelocidades() {
  try {
    const items = await getCached('productos:items_rich', async () => {
      // orderBy por fecha_dt (Timestamp): el string `fecha` + limit recortaba el mes nuevo.
      const snap = await getDocs(query(collection(_db, 'ventas_por_dia'), orderBy('fecha_dt', 'desc'), limit(5000)));
      return snap.docs.map(d => d.data());
    }, { ttl: 5 * 60 * 1000, memOnly: true });

    // Ventana en fecha ARGENTINA (los docs guardan la fecha local del local).
    const AR = { timeZone: 'America/Argentina/Buenos_Aires' };
    _hoyYmd = new Date().toLocaleDateString('en-CA', AR);
    const corteYMD = new Date(Date.now() - VENTANA_DIAS * 86400000).toLocaleDateString('en-CA', AR);

    const mapa = new Map();
    const mapaColor = new Map();
    const conColor = new Set();
    const consumo = new Map();
    const primerNombre = new Map();
    const primerDoc = new Map();
    for (const it of items) {
      if (it.deleted === true) continue;
      const ymd = fechaDMYtoYMD(it.fecha);
      if (!ymd || ymd < corteYMD) continue;

      // Consumo vía vinculaciones (ej: cada impresión descuenta hojas). Es la
      // verdad de terreno: lo que el watcher de consumibles ya descontó queda
      // registrado en `consumibles_descuentos: [{target_id, cantidad}]`. Así la
      // hoja/insumo acumula su consumo real aunque nunca se venda "suelta".
      const desc = Array.isArray(it.consumibles_descuentos) ? it.consumibles_descuentos : null;
      if (desc) {
        for (const d of desc) {
          if (!d || d.skip || d.error) continue;
          const tid = String(d.target_id || '');
          const c = Number(d.cantidad || 0);
          if (tid && c > 0) {
            consumo.set(tid, (consumo.get(tid) || 0) + c);
            const prev = primerDoc.get(tid);
            if (!prev || ymd < prev) primerDoc.set(tid, ymd);
          }
        }
      }

      const nombre = _normNombre(it.producto || it.product_name || '');
      if (!nombre) continue;
      const cant = Number(it.cantidad || it.quantity || 0);
      if (!cant) continue;
      // Las devoluciones/correcciones (cantidad negativa) restan del ritmo.
      mapa.set(nombre, (mapa.get(nombre) || 0) + cant);
      const color = _normNombre(it.conjunto_color || '');
      if (color) {
        conColor.add(nombre);
        const k = nombre + '||' + color;
        mapaColor.set(k, (mapaColor.get(k) || 0) + cant);
      }
      if (cant > 0) {
        const prev = primerNombre.get(nombre);
        if (!prev || ymd < prev) primerNombre.set(nombre, ymd);
      }
    }
    _velocidadPorNombre = mapa;
    _velocidadPorNombreColor = mapaColor;
    _nombresConColor = conColor;
    _consumoPorDocId = consumo;
    _primerMovPorNombre = primerNombre;
    _primerMovPorDocId = primerDoc;

    // "Top vendido" = percentil 80 de los que vendieron algo. Con muy pocos
    // datos no marcamos a nadie como top (evita inventar urgencias).
    const vals = Array.from(mapa.values()).filter(v => v > 0).sort((a, b) => a - b);
    _umbralTop = vals.length >= 5 ? vals[Math.floor(vals.length * 0.8)] : Infinity;
  } catch (e) {
    console.warn('[notificaciones] no se pudieron cargar velocidades de venta:', e);
  }
}

// Enriquece una alerta con ritmo de venta, días de cobertura y la marca de
// urgencia. Una alerta es URGENTE cuando el producto rota (vendió al menos
// MIN_VENTAS_URGENTE en la ventana) y al ritmo actual se agota en ≤ 7 días
// (lo que incluye los que ya están en cero). Las variantes auto-detectadas no
// escalan a urgente para no inflar el ruido.
// Días entre dos fechas "YYYY-MM-DD" (positivo si b es posterior).
function _diasEntreYmd(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// Ritmo de un producto (o de UNA variedad) en la ventana:
//   unidades = ventas directas por nombre + consumo vía vinculaciones (la hoja
//              que se gasta al imprimir cuenta aunque nunca se venda "suelta").
//   dias     = días efectivos de medición. Si el producto empezó a venderse
//              hace poco (nuevo en catálogo), se mide desde su primera venta
//              (piso 7 días) para no subestimar a los que arrancan fuerte.
// Con `color`, mide SOLO esa variedad (las ventas nuevas guardan conjunto_color).
// Si las ventas del producto no traen color (docs viejos), cae al ritmo del
// producto entero — igual que antes.
function _ritmoEfectivo(p, nombreFallback, color) {
  const nombre = _normNombre((p && p.nombre) || nombreFallback || '');
  const usaColor = !!color && _nombresConColor.has(nombre);
  let unidades;
  if (usaColor) {
    unidades = _velocidadPorNombreColor.get(nombre + '||' + _normNombre(color)) || 0;
  } else {
    unidades = _velocidadPorNombre.get(nombre) || 0;
    if (p && p.doc_id != null) unidades += _consumoPorDocId.get(String(p.doc_id)) || 0;
  }
  unidades = Math.max(0, unidades);   // devoluciones pueden dejarlo negativo

  let dias = VENTANA_DIAS;
  if (unidades > 0 && _hoyYmd) {
    const primeros = [];
    const pn = _primerMovPorNombre.get(nombre);
    if (pn) primeros.push(pn);
    if (!usaColor && p && p.doc_id != null) {
      const pd = _primerMovPorDocId.get(String(p.doc_id));
      if (pd) primeros.push(pd);
    }
    if (primeros.length) {
      const transcurridos = _diasEntreYmd(primeros.sort()[0], _hoyYmd) + 1;
      dias = Math.max(7, Math.min(VENTANA_DIAS, transcurridos));
    }
  }
  return { unidades, dias };
}

function _aplicarUrgencia(a) {
  const { unidades, dias } = _ritmoEfectivo(a.producto, a.nombre, a.variedad);
  const velDia = unidades / dias;

  a.unidades_ventana = unidades;
  a.ritmo_dias = dias;
  a.vel_dia = velDia;
  a.vel_semana = velDia * 7;
  a.es_top = velDia > 0 && unidades >= _umbralTop;
  // Cobertura en UNIDADES SUELTAS: en alertas por variedad `stock` es el contador
  // de packs/rollos, pero el ritmo se mide en unidades — usar el total real en
  // unidades para no inflar (ni ocultar) la urgencia de los conjuntos.
  const stockUnidades = Number.isFinite(Number(a.stock_total_unidades))
    ? Number(a.stock_total_unidades)
    : (Number(a.stock) || 0);
  a.dias_cobertura = velDia > 0 ? stockUnidades / velDia : Infinity;

  const rota = unidades >= MIN_VENTAS_URGENTE;
  const porAgotarse = a.dias_cobertura <= UMBRAL_DIAS_COBERTURA;
  a.urgente = !a.auto && rota && porAgotarse;
  a.cobertura_texto = _coberturaTexto(a);
  return a;
}

// Texto humano del ritmo: "Se agota en ~3 días · vendiste 12 en 30 días (~3/sem)".
function _coberturaTexto(a) {
  if (!a || !a.vel_dia || a.vel_dia <= 0) return '';
  const porSem = a.vel_semana;
  const ritmo = porSem >= 1
    ? `~${_fmt(Math.round(porSem))}/sem`
    : `~${_fmt(Math.max(1, Math.round(a.vel_dia * 30)))}/mes`;
  const vendidos = `vendiste ${_fmt(Math.round(a.unidades_ventana))} en ${a.ritmo_dias || VENTANA_DIAS} días`;
  if (a.stock <= 0) return `Sin stock · ${vendidos} (${ritmo})`;
  const d = Math.max(1, Math.round(a.dias_cobertura));
  return `Se agota en ~${d} ${d === 1 ? 'día' : 'días'} · ${vendidos} (${ritmo})`;
}

// Genera una urgencia POR RITMO de venta para un producto, sin depender de que
// tenga `stock_min` cargado. Dispara cuando el producto rota fuerte (vendió
// ≥ MIN_VENTAS_RITMO en la ventana) y figura en cero/negativo o se agota en
// ≤ 7 días. Es lo que el dueño necesita reponer aunque nunca configuró mínimos.
function _alertaVelocidad(p) {
  if (Number(p.stock) === -1) return null;            // servicio / ilimitado
  if (_esServicio(p)) return null;                    // impresión/fotocopia/etc.: se repone el insumo, no el servicio
  const { unidades, dias } = _ritmoEfectivo(p);
  if (unidades < MIN_VENTAS_RITMO) return null;
  const stock = _stockEfectivo(p);
  const velDia = unidades / dias;
  const cobertura = velDia > 0 ? (stock <= 0 ? 0 : stock / velDia) : Infinity;
  if (!(stock <= 0 || cobertura <= UMBRAL_DIAS_COBERTURA)) return null;
  return {
    key: p.doc_id + '|ritmo',
    doc_id: p.doc_id,
    variedad: null,
    nombre: p.nombre || '(sin nombre)',
    codigo: p.codigo || '',
    rubro: p.rubro || '',
    sub_rubro: p.sub_rubro || '',
    marca: p.marca || '',
    stock,
    stock_min: Number(p.stock_min) || 0,
    stock_max: Number(p.stock_max) || null,
    sugerencia: null,
    critico: stock <= 0,
    origen: 'ritmo',
    solo_pagina: true,   // se ve en la página/resumen, no spam-ea un toast por cada uno
    producto: p,
  };
}

function _calcularAlertas(productos) {
  let out = [];
  for (const p of productos) {
    const arr = _alertasProducto(p);
    for (const a of arr) out.push(a);
  }

  // Urgencias por ritmo de venta (aunque no tengan stock_min configurado).
  const velAlertas = [];
  for (const p of productos) {
    const a = _alertaVelocidad(p);
    if (a) velAlertas.push(a);
  }
  const docsConfig = new Set(out.filter(a => !a.auto).map(a => a.doc_id));
  const docsVel = new Set(velAlertas.map(a => a.doc_id));
  // Si un producto entra por ritmo, sus alertas auto-variantes se descartan
  // (la urgencia a nivel producto manda y evita duplicar la misma fila).
  out = out.filter(a => !(a.auto && docsVel.has(a.doc_id)));
  for (const a of velAlertas) {
    if (docsConfig.has(a.doc_id)) continue;  // ya tiene alerta config → esa se enriquece como urgente
    out.push(a);
  }

  // Sacar los productos que el usuario ocultó (no aparecen en lista ni toasts).
  const ign = _cargarIgnorados();
  if (ign.size) out = out.filter(a => !ign.has(String(a.doc_id)));

  for (const a of out) _aplicarUrgencia(a);

  // Orden: urgentes primero y, dentro de ellos, los MÁS VENDIDOS arriba (es lo
  // que el dueño quiere reponer primero). Luego sin stock y mayor déficit.
  out.sort((a, b) => {
    if (a.urgente !== b.urgente) return a.urgente ? -1 : 1;
    if (a.urgente && b.urgente) {
      if ((b.vel_dia || 0) !== (a.vel_dia || 0)) return (b.vel_dia || 0) - (a.vel_dia || 0);
      return a.dias_cobertura - b.dias_cobertura;
    }
    if (a.critico !== b.critico) return a.critico ? -1 : 1;
    const da = (a.stock_min - a.stock) / Math.max(a.stock_min, 1);
    const db = (b.stock_min - b.stock) / Math.max(b.stock_min, 1);
    return db - da;
  });
  return out;
}

// ── Fetch del catálogo ───────────────────────────────────────────────────────
// Usa la misma cache que el store global (`catalogo:all`) → si el listener
// está activo, devuelve al toque; si no, hace un solo getDocs y lo cachea
// para todas las páginas. Antes esto descargaba 12k docs duplicados en
// paralelo al listener del store.
async function _fetchCatalogo() {
  console.log('[notifications] usando getCached(catalogo:all)');
  const _t0 = performance.now();
  const items = await getCached('catalogo:all', async () => {
    const snap = await getDocs(query(collection(_db, 'catalogo'), orderBy('nombre')));
    // doc_id va al final para que NO lo pise un campo `id` interno del doc.
    return snap.docs.map(d => ({ ...d.data(), doc_id: d.id }));
  }, { ttl: 10 * 60 * 1000, memOnly: true });
  console.log(`[notifications] ✓ catalogo listo en ${(performance.now() - _t0).toFixed(0)}ms (${items.length} docs)`);
  return items;
}

function _refrescar({ silent = false } = {}) {
  // Si ya hay un refresh corriendo (ej: el inicial de initNotificaciones),
  // esperar ESE en vez de volver al toque — si no, quien llega segundo (el
  // Centro de Compras) calcula alertas con el catálogo todavía vacío.
  if (_refreshing) { _pendingRefresh = true; return _refreshPromise; }
  _refreshing = true;
  _refreshPromise = _doRefrescar({ silent });
  return _refreshPromise;
}

async function _doRefrescar({ silent }) {
  try {
    const productos = await _fetchCatalogo();
    _productos = productos;
    // Cargar el ritmo de venta (cacheado) antes de calcular, así las alertas ya
    // salen con la marca de "reponer urgente" según lo más vendido.
    await _cargarVelocidades();
    const alertas = _calcularAlertas(productos);
    // Cada alerta tiene una key única (doc_id o doc_id|var:Color) para
    // distinguir aviso global del producto de los avisos por variedad.
    const nuevasIds = new Set(alertas.map(a => a.key));
    const esInicial = !_baselineDone;

    // En la primera ejecución forzamos silencio para armar el baseline sin
    // disparar toasts por alertas que ya existían antes de abrir la app.
    const dispararIndividuales = !silent && !esInicial;

    if (dispararIndividuales) {
      // Diff: dispara cuando (a) la alerta es nueva o (b) el stock bajó más
      // que la última vez que avisamos. Así, si el usuario edita un producto
      // que ya estaba en alerta y vende otro item, vuelve a saltar el aviso.
      // Las alertas `auto` (variantes detectadas sin stock_min configurado)
      // NO disparan toast ni notif del navegador — sería ruidoso con 60 ítems.
      // Solo se muestran en la página /notificaciones.
      const aDisparar = alertas.filter(a => {
        if (a.auto || a.solo_pagina) return false;
        const prevStock = _lastStockPorKey.get(a.key);
        if (prevStock === undefined) return true;        // alerta nueva
        if (Number(a.stock) < Number(prevStock)) return true; // bajó más
        return false;
      });
      console.info(`[notificaciones] refresh → ${alertas.length} activas, ${aDisparar.length} a notificar`);
      for (const a of aDisparar) _mostrarToast(a);
      if (aDisparar.length && _browserEnabled() && _permPermitida()) {
        _mostrarNotifNavegador(aDisparar);
      }
    } else if (esInicial && _browserEnabled() && _permPermitida()) {
      // Carga inicial: si ya hay alertas configuradas (no auto) pendientes y
      // el usuario activó las notificaciones, mostramos un toast + notif
      // resumen para confirmar que hay cosas por rellenar. Excluimos `auto`
      // del resumen para que el toast inicial sea sobre lo que el usuario
      // configuró como mínimo — las variantes auto-bajas se ven en la página.
      const alertasResumen = alertas.filter(a => !a.auto && !a.solo_pagina);
      const urgentesRitmo  = alertas.filter(a => a.solo_pagina && a.urgente);
      if (alertasResumen.length > 0 || urgentesRitmo.length > 0) {
        _mostrarToastResumen(alertasResumen, urgentesRitmo);
        _mostrarNotifResumen(alertasResumen.concat(urgentesRitmo));
      }
    }

    _activeIds = nuevasIds;
    // Actualizar registro: para alertas vigentes guardamos el stock actual;
    // las que dejaron de alertar (subió el stock o sacaron el mín) se borran
    // para que si vuelven a bajar disparen de cero.
    const nuevaMapa = new Map();
    for (const a of alertas) nuevaMapa.set(a.key, Number(a.stock) || 0);
    _lastStockPorKey = nuevaMapa;
    _baselineDone = true;
    _emitChange(alertas);
  } catch (err) {
    console.warn('[notificaciones] error refrescando catálogo:', err);
  } finally {
    _refreshing = false;
    if (_pendingRefresh) {
      _pendingRefresh = false;
      setTimeout(() => _refrescar({ silent: false }), 100);
    }
  }
}

// ── Suscriptores externos ────────────────────────────────────────────────────
function _emitChange(alertas) {
  for (const cb of _listeners) {
    try { cb(alertas); } catch (e) { console.warn('[notificaciones] listener error:', e); }
  }
}

// ── Permiso navegador ────────────────────────────────────────────────────────
export function notificacionesSoportadas() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function permisoNotificacion() {
  if (!notificacionesSoportadas()) return 'unsupported';
  return Notification.permission;
}

export async function pedirPermisoNotificaciones() {
  if (!notificacionesSoportadas()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    const r = await Notification.requestPermission();
    if (r === 'granted') localStorage.setItem(LS_BROWSER_ENABLED, '1');
    return r;
  } catch (e) {
    return Notification.permission;
  }
}

function _permPermitida() {
  return notificacionesSoportadas() && Notification.permission === 'granted';
}

export function notificacionesNavegadorActivas() {
  return _browserEnabled() && _permPermitida();
}

function _browserEnabled() {
  return localStorage.getItem(LS_BROWSER_ENABLED) === '1';
}

export function setNotificacionesNavegador(activas) {
  if (activas) localStorage.setItem(LS_BROWSER_ENABLED, '1');
  else localStorage.removeItem(LS_BROWSER_ENABLED);
}

function _mostrarNotifNavegador(alertas) {
  try {
    if (alertas.length === 1) {
      const a = alertas[0];
      const unidad = a.unidad_label ? ' ' + a.unidad_label : '';
      const titulo = (a.urgente ? 'Reponer urgente · ' : a.critico ? 'Sin stock · ' : 'Stock bajo · ') + a.nombre;
      const cobertura = _coberturaTexto(a);
      const n = new Notification(titulo, {
        body: `Quedan ${a.stock_texto || (_fmt(a.stock) + unidad)}${a.stock_equiv ? ` = ${a.stock_equiv}` : ''} (mínimo ${a.min_texto || _fmt(a.stock_min)}).` + (cobertura ? ` ${cobertura}.` : '') + ' Tocá para reponer.',
        icon: '/libreria-liceo-512.png',
        tag: 'stock-' + a.key,
        requireInteraction: !!a.urgente,
      });
      n.onclick = () => { window.focus(); _irACatalogo(a.doc_id); n.close(); };
    } else {
      const n = new Notification(`${alertas.length} productos en stock bajo`, {
        body: alertas.slice(0, 4).map(a => `· ${a.nombre} (${_fmt(a.stock)}/${_fmt(a.stock_min)})`).join('\n'),
        icon: '/libreria-liceo-512.png',
        tag: 'stock-multi',
      });
      n.onclick = () => { window.focus(); _irANotificaciones(); n.close(); };
    }
  } catch (e) {
    console.warn('[notificaciones] error mostrando notificación del navegador:', e);
  }
}

function _mostrarNotifResumen(alertas) {
  if (!_permPermitida()) return;
  try {
    const n = new Notification(`Stock bajo: ${alertas.length} ${alertas.length === 1 ? 'producto' : 'productos'}`, {
      body: alertas.slice(0, 4).map(a => `· ${a.nombre} (${_fmt(a.stock)}/${_fmt(a.stock_min)})`).join('\n') + (alertas.length > 4 ? `\n... y ${alertas.length - 4} más` : ''),
      icon: '/libreria-liceo-512.png',
      tag: 'stock-resumen-inicial',
    });
    n.onclick = () => { window.focus(); _irANotificaciones(); n.close(); };
  } catch (e) {
    console.warn('[notificaciones] error mostrando resumen:', e);
  }
}

export function mostrarNotificacionDePrueba() {
  if (!_permPermitida()) return false;
  try {
    const n = new Notification('Notificaciones activadas ✓', {
      body: 'Vas a recibir un aviso cada vez que un producto baje del stock mínimo.',
      icon: '/libreria-liceo-512.png',
      tag: 'stock-prueba',
    });
    n.onclick = () => { window.focus(); _irANotificaciones(); n.close(); };
    return true;
  } catch (e) {
    console.warn('[notificaciones] error en prueba:', e);
    return false;
  }
}

// ── Toasts in-app ────────────────────────────────────────────────────────────
function _ensureToastRoot() {
  if (_toastRoot && document.body.contains(_toastRoot)) return _toastRoot;
  _toastRoot = document.createElement('div');
  _toastRoot.id = 'notifToastRoot';
  _toastRoot.style.cssText = [
    'position:fixed',
    'top:14px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:9000',
    'display:flex',
    'flex-direction:column',
    'gap:10px',
    'pointer-events:none',
    'width:min(440px, calc(100vw - 28px))',
  ].join(';');
  document.body.appendChild(_toastRoot);
  return _toastRoot;
}

function _fmt(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

function _mostrarToast(a) {
  const root = _ensureToastRoot();
  const toast = document.createElement('div');
  toast.setAttribute('role', 'alert');

  // Tres niveles: urgente (rota + por agotarse) > sin stock > stock bajo.
  const urgente = !!a.urgente;
  const acento  = urgente ? '#b00020' : a.critico ? '#c62828' : '#f57c00';
  const acentoTxt = urgente ? '#b00020' : a.critico ? '#c62828' : '#b45309';
  const tier    = urgente ? 'Reponer urgente' : a.critico ? 'Sin stock' : 'Stock bajo';
  const icono   = urgente ? 'priority_high' : a.critico ? 'error' : 'warning';
  const cobertura = _coberturaTexto(a);

  toast.style.cssText = [
    'pointer-events:auto',
    'background:var(--surface)',
    `border-left:${urgente ? '5px' : '4px'} solid ${acento}`,
    'border-radius:12px',
    `box-shadow:0 6px 24px rgba(0,0,0,${urgente ? '0.24' : '0.18'})`,
    'padding:12px 14px',
    'display:flex',
    'align-items:flex-start',
    'gap:10px',
    'font-family:Inter,system-ui,sans-serif',
    'color:var(--text)',
    'transform:translateY(-12px)',
    'opacity:0',
    'transition:transform 0.25s ease, opacity 0.25s ease',
  ].join(';');

  toast.innerHTML = `
    <span class="material-icons" style="color:${acento};font-size:22px;flex-shrink:0">${icono}</span>
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
        <span style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.5px;color:${acentoTxt}">${tier}</span>
        ${a.es_top ? `<span style="font-size:9px;font-weight:800;letter-spacing:0.4px;color:var(--tint-red-fg);background:var(--tint-red-bg);border:1px solid var(--border);padding:1px 6px;border-radius:99px;text-transform:uppercase">Top ventas</span>` : ''}
      </div>
      <div style="font-size:14px;font-weight:700;line-height:1.3;word-wrap:break-word">${_escape(a.nombre)}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:3px">
        Quedan <b style="color:${acentoTxt}">${_escape(a.stock_texto || (_fmt(a.stock) + (a.unidad_label ? ' ' + a.unidad_label : '')))}</b>
        ${a.stock_equiv ? `<span style="color:var(--text-muted)">(${_escape(a.stock_equiv)})</span>` : ''}
        <span style="color:var(--text-muted)">/ mín ${_escape(a.min_texto || _fmt(a.stock_min))}</span>
        ${a.sugerencia ? ` · <span style="color:var(--primary)">pedir ~${_escape(a.sugerencia_texto || _fmt(a.sugerencia))}</span>` : ''}
      </div>
      ${cobertura ? `<div style="font-size:11.5px;font-weight:600;color:${urgente ? 'var(--tint-red-fg)' : 'var(--primary)'};margin-top:3px;display:flex;align-items:center;gap:4px">
        <span class="material-icons" style="font-size:14px">trending_up</span>${_escape(cobertura)}
      </div>` : ''}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button data-act="rellenar" style="background:${urgente ? acento : '#7b3fa6'};color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
          ${urgente ? 'Reponer ahora' : 'Rellenar'}
        </button>
        <button data-act="cerrar" style="background:transparent;color:var(--text-muted);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">
          Cerrar
        </button>
      </div>
    </div>
    <button data-act="x" aria-label="Cerrar" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:2px;line-height:1;flex-shrink:0">
      <span class="material-icons" style="font-size:18px">close</span>
    </button>
  `;

  let timer = setTimeout(() => _cerrarToast(toast), TOAST_DURATION_MS);
  toast.addEventListener('mouseenter', () => { clearTimeout(timer); });
  toast.addEventListener('mouseleave', () => { timer = setTimeout(() => _cerrarToast(toast), TOAST_DURATION_MS); });

  toast.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'rellenar') {
      _cerrarToast(toast);
      _irACatalogo(a.doc_id);
    } else {
      _cerrarToast(toast);
    }
  });

  root.appendChild(toast);
  // Animar entrada
  requestAnimationFrame(() => {
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';
  });
}

function _cerrarToast(toast) {
  if (!toast || !toast.parentNode) return;
  toast.style.transform = 'translateY(-12px)';
  toast.style.opacity = '0';
  setTimeout(() => { toast.remove(); }, 250);
}

// Toast resumen: una sola tarjeta con cuántos productos hay y un botón a la
// página de notificaciones. Se usa al cargar la app, sin spam-ear con uno
// por producto.
function _mostrarToastResumen(alertas, urgentesRitmo = []) {
  const root = _ensureToastRoot();
  const toast = document.createElement('div');
  toast.setAttribute('role', 'alert');
  const hayUrgentes = urgentesRitmo.length > 0;
  const acento = hayUrgentes ? '#b00020' : '#7b3fa6';
  toast.style.cssText = [
    'pointer-events:auto',
    'background:var(--surface)',
    `border-left:${hayUrgentes ? '5px' : '4px'} solid ${acento}`,
    'border-radius:12px',
    'box-shadow:0 6px 24px rgba(0,0,0,0.18)',
    'padding:12px 14px',
    'display:flex',
    'align-items:center',
    'gap:10px',
    'font-family:Inter,system-ui,sans-serif',
    'color:var(--text)',
    'transform:translateY(-12px)',
    'opacity:0',
    'transition:transform 0.25s ease, opacity 0.25s ease',
  ].join(';');
  const criticas = alertas.filter(a => a.critico).length;
  const titulo = hayUrgentes
    ? `${urgentesRitmo.length} de tus más vendidos sin stock`
    : `${alertas.length} ${alertas.length === 1 ? 'producto' : 'productos'} con stock bajo`;
  const sub = hayUrgentes
    ? `Reponer urgente${alertas.length > 0 ? ` · ${alertas.length} con mínimo configurado` : ''}.`
    : `${criticas > 0 ? `<b style="color:var(--tint-red-fg)">${criticas} sin stock</b> · ` : ''}revisá la lista para rellenar.`;
  toast.innerHTML = `
    <span class="material-icons" style="color:${acento};font-size:24px;flex-shrink:0">${hayUrgentes ? 'priority_high' : 'inventory_2'}</span>
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;font-weight:700;color:var(--text)">${titulo}</div>
      <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px">
        ${sub}
      </div>
    </div>
    <button data-act="ver" style="background:#7b3fa6;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Ver</button>
    <button data-act="x" aria-label="Cerrar" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:2px;line-height:1;flex-shrink:0">
      <span class="material-icons" style="font-size:18px">close</span>
    </button>
  `;
  let timer = setTimeout(() => _cerrarToast(toast), TOAST_DURATION_MS + 3000);
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', () => { timer = setTimeout(() => _cerrarToast(toast), TOAST_DURATION_MS); });
  toast.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.act === 'ver') { _cerrarToast(toast); _irANotificaciones(); }
    else _cerrarToast(toast);
  });
  root.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';
  });
}

function _escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ── Navegación (delegada a main.js) ──────────────────────────────────────────
function _irACatalogo(docId) {
  window.__pendingCatalogoOpen = docId;
  if (typeof window.navigateToPage === 'function') {
    window.navigateToPage('catalogo');
  } else {
    location.hash = '#catalogo';
  }
}

function _irANotificaciones() {
  if (typeof window.navigateToPage === 'function') {
    window.navigateToPage('notificaciones');
  }
}

// ── API pública ──────────────────────────────────────────────────────────────
export function initNotifications(db) {
  if (_initialized) return;
  _initialized = true;
  _db = db;

  // 0. Listado compartido de productos ocultos (sincronizado entre PCs)
  _suscribirIgnorados();

  // 1. Carga inicial (silenciosa: no spam-ear al login)
  _refrescar({ silent: true });

  // 2. Escuchar cambios del catálogo via meta-doc
  try {
    _unsubMeta = onSnapshot(doc(_db, 'config', 'catalogo_meta'), (snap) => {
      if (!snap.exists()) return;
      const ts = snap.data().last_updated;
      if (_lastMetaTs === null) { _lastMetaTs = ts; return; }
      if (ts === _lastMetaTs) return;
      _lastMetaTs = ts;
      _refrescar({ silent: false });
    }, (err) => console.warn('[notificaciones] meta listener:', err));
  } catch (e) {
    console.warn('[notificaciones] no se pudo subscribir a meta:', e);
  }
}

export function obtenerAlertasActivas() {
  return _calcularAlertas(_productos);
}

// Candidatos de compra por cobertura: productos que rotan (ventas directas +
// consumo por vinculaciones, ej: hojas gastadas por impresiones/fotocopias) y
// cuyo stock NO cubre `dias` días al ritmo actual. A diferencia de las alertas
// (que saltan recién cuando quedan ≤7 días o se pisa el mínimo), esto incluye
// lo que conviene adelantar: el Centro de Compras lo usa para recomendar la
// compra ANTES de que falte.
export function obtenerCandidatosCompra(dias = 30) {
  const ign = _cargarIgnorados();
  const out = [];
  for (const p of _productos) {
    if (Number(p.stock) === -1) continue;   // servicio / ilimitado
    if (_esServicio(p)) continue;           // impresión/fotocopia/etc: se repone el insumo
    if (p.doc_id != null && ign.has(String(p.doc_id))) continue;
    const ritmo = _ritmoEfectivo(p);
    if (ritmo.unidades < MIN_VENTAS_URGENTE) continue;   // casi no rota → no vale adelantar
    const stock = _stockEfectivo(p);
    const velDia = ritmo.unidades / ritmo.dias;
    const cobertura = stock <= 0 ? 0 : stock / velDia;
    if (cobertura >= dias) continue;               // el stock alcanza hasta el objetivo
    out.push(_aplicarUrgencia({
      key: p.doc_id + '|compra',
      doc_id: p.doc_id,
      variedad: null,
      nombre: p.nombre || '(sin nombre)',
      codigo: p.codigo || '',
      rubro: p.rubro || '',
      sub_rubro: p.sub_rubro || '',
      marca: p.marca || '',
      stock,
      stock_min: Number(p.stock_min) || 0,
      stock_max: Number(p.stock_max) || null,
      sugerencia: null,
      critico: stock <= 0,
      origen: 'cobertura',
      producto: p,
    }));
  }
  return out;
}

export function onAlertasCambian(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

export async function refrescarAlertas({ silent = true } = {}) {
  await _refrescar({ silent });
  return obtenerAlertasActivas();
}

export function irACatalogoYAbrir(docId) {
  _irACatalogo(docId);
}
