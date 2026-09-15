/**
 * Fotos pedidas.
 *
 * La lista de trabajo que arma el personal desde la tienda: recorren el
 * catálogo tildando lo que hay que fotografiar. Acá se ve junta, se le carga la
 * foto a cada uno sin salir de la pantalla, y lo resuelto desaparece solo.
 *
 * La colección `tienda_fotos_pedidas` tiene un documento por producto, con el
 * id del producto como id del documento. Ese id es el mismo del `catalogo` y el
 * del espejo `tienda_productos`, así que alcanza para ir a buscar la foto que
 * tiene hoy y para guardarle la nueva.
 *
 * La lista se escucha en vivo: mientras alguien recorre la tienda marcando
 * productos desde el celular, acá van apareciendo solos y señalados como
 * nuevos, sin tener que recargar la página cada dos minutos.
 *
 * "Cargar" o "Cambiar" abren el panel de fotos del producto: las que ya tiene
 * y las que se acaban de elegir, juntas, para decidir cuál es la portada, en
 * qué orden van, cuáles se sacan y agregar más. Nada se sube ni se toca hasta
 * "Guardar": recién ahí se suben las nuevas ya achicadas, se guarda la lista en
 * el producto (que reescribe el espejo público en el momento) y se saca al
 * producto de esta lista. Si algo falla en el medio, el producto sigue
 * pendiente: es preferible que aparezca de más y no que se pierda.
 *
 * Lo que no se va a fotografiar nunca se oculta de "Les falta la foto" y queda
 * aparte, en Ocultos (ver fotos_ocultas.js). Se mueve en el momento, con la fila
 * yéndose de a poco, y lo que oculta otra pestaña se va solo.
 */
import { collection, doc, getDoc, getDocs, onSnapshot, orderBy, query } from 'firebase/firestore';
import { getCached, peekCacheValue } from '../cache.js';
import { leerDocRapido } from '../config.js';
import { onStoreChange } from '../store.js';
import { alertDialog, confirmDialog, escHtml, verFotoGrande } from '../components/dialogs.js';
import { mostrarToast, cerrarToast } from '../components/toasts.js';
import { sacarFila, meterFila, desplegar, plegar } from '../components/filas_animadas.js';
import {
  actualizarDoc, espejar, imagenesDe, motivoDeNoPublicar, nombreBonito, subirFoto,
  borrarFoto, borrarDoc, programarRecuentoDeRubros, usarCatalogoParaRecontar,
} from '../tienda_espejo.js';
import {
  ponerDePortada, moverFoto, desvincularFoto, limpiarAjustes, fotosQuitadas,
} from '../tienda_galeria.js';
import {
  separarOcultos, cambioOcultar, cambioMostrar, diferencias, reconciliar,
  leerOcultos, escucharOcultos, guardarCambioDeOcultos,
} from '../fotos_ocultas.js';
import '../styles/tienda.css';

let _db = null;
let _lista = [];
let _esperando = [];
let _catalogo = new Map();      // doc_id -> datos del catálogo
let _habilitados = [];
let _subExcluidos = {};
let _subiendo = false;          // un guardado por vez: el input es uno solo
let _panel = null;              // el panel de fotos abierto, si hay uno
let _unsubPedidas = null;       // el listener de lo que se marca desde la tienda
let _primerSnapshot = true;     // el primero trae toda la lista, no novedades
let _repintarAlSoltar = false;  // llegó algo mientras había un panel abierto
let _nuevas = new Set();        // ids que entraron sin recargar, para señalarlos
let _olvidarNuevas = null;      // temporizador que apaga esa señal
let _ocultosServidor = new Map(); // lo último que dijo la base de lo oculto
let _pendientes = new Map();    // lo recién ocultado o mostrado, hasta que la base lo confirme
let _ocultos = new Map();       // lo que se muestra: la base con lo pendiente encima
let _verOcultos = false;        // la tabla de ocultos desplegada
let _unsubOcultos = null;
let _avisoOculto = null;        // el aviso con "Deshacer" del último que se ocultó
let _unsubCatalogo = null;      // los cambios del catálogo que trae el store
let _esperaCatalogo = null;     // junta una ráfaga de ventas en una sola mirada
let _catalogoAlSoltar = false;  // cambió el catálogo con un panel abierto

export async function renderTiendaFotos(container, db) {
  _db = db;
  // Cada entrada arranca de lo que diga la base: un pendiente de la visita
  // anterior no tiene por qué seguir mandando.
  _ocultosServidor = new Map();
  _pendientes = new Map();
  _ocultos = new Map();
  _verOcultos = false;

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;
                gap:16px;flex-wrap:wrap;margin-bottom:16px">
      <div style="min-width:260px;flex:1">
        <h2 style="margin:0">Fotos pedidas</h2>
        <p class="tienda-pista" style="margin:6px 0 0">
          Todo lo del catálogo al que le falta la foto entra solo a esta lista:
          lo que ya se está mostrando en la vidriera con el cuadrito gris y lo
          que sale apenas se le cargue una, más lo que se haya marcado desde la
          tienda. Cargá la foto acá mismo: al subirla, el producto sale de la
          lista y la tienda se actualiza.
        </p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="pc-btn" id="fotosImprimir"
                title="La hoja para recorrer el local, con lo pedido a mano">
          <span class="material-icons">print</span> Imprimir
        </button>
        <button class="pc-btn" id="fotosRefrescar">
          <span class="material-icons">refresh</span> Actualizar
        </button>
      </div>
    </div>

    <input type="file" id="fotosArchivo" accept="image/*" multiple hidden>
    <div id="fotosCuerpo"><div class="tienda-pista">Cargando…</div></div>`;

  // Al volver a entrar a la pantalla, cortar lo que hubiera quedado escuchando.
  cortarEscucha();
  window.__limpiarPagina = alSalir;

  document.getElementById('fotosRefrescar').addEventListener('click', cargar);
  document.getElementById('fotosImprimir').addEventListener('click', imprimir);
  document.getElementById('fotosArchivo').addEventListener('change', alElegirArchivo);
  // Un solo oyente para todos los botones de las tablas: las filas entran y
  // salen de a una (ocultar, mostrar) y cada una nueva tendría que conectarse.
  document.getElementById('fotosCuerpo').addEventListener('click', alClickEnTabla);

  await cargar();
}

/* ── Lectura ──────────────────────────────────────────────────────────────── */

async function cargar() {
  const cuerpo = document.getElementById('fotosCuerpo');
  if (!cuerpo) return;

  try {
    // Todo a la vez: la lista, el catálogo (para la foto que tiene hoy), qué se
    // publica (para no despublicar sin querer al guardar) y lo que se ocultó.
    // Lo oculto entra antes del primer pintado: pintar los doscientos y sacar
    // después los ocultos era ver la tabla entera parpadear al entrar.
    const [docs, catalogo, publicacion, ocultos] = await Promise.all([
      traerPedidas(),
      getCached('catalogo:all', async () => {
        const snap = await getDocs(query(collection(_db, 'catalogo'), orderBy('nombre')));
        return snap.docs.map(d => ({ ...d.data(), doc_id: d.id }));
      }, { ttl: 10 * 60 * 1000, memOnly: true }),
      leerPublicacionDeLaTienda(),
      leerOcultos(_db),
    ]);

    _catalogo = new Map((catalogo || []).map(d => [String(d.doc_id), d]));
    _habilitados = publicacion?.rubros || [];
    _subExcluidos = publicacion?.subrubrosExcluidos || {};
    _ocultosServidor = ocultos;
    _ocultos = reconciliar(_ocultosServidor, _pendientes).efectivo;

    // El catálogo entero que acaba de leer esta pantalla se presta para rehacer
    // el conteo por rubro y subrubro de la portada de la tienda. Sin esto el
    // recuento no tiene con qué contar y se saltea (ver tienda_espejo.js).
    usarCatalogoParaRecontar(() => [..._catalogo.values()]);

    _lista = ordenarPorFecha(docs.map(d => filaDePedido(d.id, d.data() || {})));

    _esperando = armarEsperando();

    pintarLista();

    // Recién ahora: el listener necesita el catálogo en memoria para saber qué
    // foto tiene hoy cada producto que le llegue. Su primer snapshot repite la
    // lectura de arriba —una colección de decenas de documentos, al lado de los
    // 9.000 del catálogo— y a cambio la pantalla queda al día sola.
    escucharPedidas();
    escucharOcultosEnVivo();
    escucharCatalogo();
  } catch (err) {
    console.error('[fotos] no se pudo leer la lista:', err);
    cuerpo.innerHTML = `
      <div class="tienda-pista" style="color:var(--tint-red-fg)">
        No se pudo leer la lista: ${escHtml(err?.message || String(err))}
      </div>`;
  }
}

/**
 * La lista que arma el sistema mirando el catálogo.
 *
 * Los que están sin foto entran solos. Antes dependían de que alguien los
 * marcara desde la tienda: mientras tanto se veían igual, con el cuadrito gris,
 * para cualquiera que entrara a comprar. No se pisan los pedidos a mano — esos
 * ya están arriba con su fecha.
 */
function armarEsperando() {
  const yaEstan = new Set(_lista.map(x => x.id));
  const automaticos = [];
  for (const [id, producto] of _catalogo) {
    if (imagenesDe(producto).length) continue;
    const motivo = motivoDeNoPublicar(producto, _habilitados, _subExcluidos);
    // Dos casos, y los dos se resuelven con una foto: el frenado JUSTO por
    // eso (todo lo demás está en orden y sale a la vidriera en cuanto se le
    // cargue una) y el marcado "publicar siempre", que se saltea el control
    // de la foto y YA se está mostrando con el cuadrito gris. Este segundo
    // quedaba afuera de las dos tablas mientras Tienda > Catálogo lo contaba
    // en rojo como publicado sin foto: se lo venía a buscar acá y no estaba.
    if (motivo !== null && motivo !== 'sin foto') continue;
    if (yaEstan.has(id)) continue;
    automaticos.push({
      id,
      nombre: producto.nombre || '(sin nombre)',
      rubro: producto.rubro || '',
      teniaFoto: false,
      cuando: null,
      fotos: [],
      enCatalogo: true,
      automatico: true,
      enLaVidriera: motivo === null,
    });
  }
  // Primero los que el cliente ya está viendo con el cuadrito gris: son los
  // urgentes, y ordenados solo por nombre quedaban perdidos entre doscientos
  // que todavía no salieron.
  automaticos.sort((a, b) => (Number(b.enLaVidriera) - Number(a.enLaVidriera))
    || String(a.nombre).localeCompare(String(b.nombre), 'es'));
  // Separadas a propósito: una es la lista que armó el personal a mano y la
  // otra la que arma el sistema. Mezcladas, lo pedido puntualmente se perdía
  // entre doscientos renglones automáticos.
  return automaticos;
}

/**
 * Qué rubros salen a la tienda y qué subrubros quedaron afuera.
 *
 * Por la memoria compartida del panel y no por el cache del SDK: Configuración
 * escribe `tienda_config/publicacion` por REST, nadie escucha ese documento con
 * `onSnapshot` y el SDK se queda con la lista de antes. Leyéndolo del SDK, la
 * dueña prendía JUGUETERÍA en Configuración, pasaba derecho acá a cargarle la
 * foto a uno de sus productos y al guardar el espejo lo BORRABA por "el rubro
 * no está habilitado": el producto desaparecía de la tienda justo después de
 * sacarle la foto, hasta la corrida siguiente del sync. Apagando un rubro
 * pasaba al revés. Configuración siembra acá el valor recién guardado, así que
 * esta pantalla arranca con la lista de verdad.
 *
 * Es la misma lectura, con la misma clave y la misma forma, que hace
 * Tienda > Catálogo: las dos pantallas espejan con la misma lista.
 */
async function leerPublicacionDeLaTienda() {
  return getCached('tienda:publicacion', async () => {
    // Cache-first: un getDoc suelto al server queda encolado detrás de los
    // listeners grandes del store y gatea el pintado de la pantalla.
    const datos = await leerDocRapido(doc(_db, 'tienda_config', 'publicacion'),
                                      { etiqueta: 'tienda_config/publicacion', vacio: {} });
    const excluidos = datos?.subrubros_excluidos;
    return {
      rubros: Array.isArray(datos?.rubros)
        ? datos.rubros.map(r => String(r).trim().toUpperCase()) : [],
      subrubrosExcluidos: excluidos && typeof excluidos === 'object' ? excluidos : {},
    };
  }, { ttl: 60000, memOnly: true });
}

async function traerPedidas() {
  // Ordenar por fecha necesita que todos los documentos tengan el campo. Ante
  // cualquier problema se cae a traer todo sin orden y se ordena en memoria.
  try {
    const snap = await getDocs(query(
      collection(_db, 'tienda_fotos_pedidas'), orderBy('pedido_en', 'desc')));
    return snap.docs;
  } catch (_) {
    const snap = await getDocs(collection(_db, 'tienda_fotos_pedidas'));
    return snap.docs;
  }
}

/**
 * Un renglón de la lista a partir del documento de `tienda_fotos_pedidas`.
 *
 * El nombre y el rubro viajan en el propio pedido porque quien marca puede
 * estar viendo un producto que todavía no bajó al catálogo de esta pestaña.
 */
function filaDePedido(id, v) {
  const producto = _catalogo.get(id);
  const fotos = imagenesDe(producto);
  return {
    id,
    nombre: v.nombre || producto?.nombre || '(sin nombre)',
    rubro: v.rubro || producto?.rubro || '',
    teniaFoto: v.tenia_foto === true,
    cuando: v.pedido_en?.toDate?.() || null,
    // Lo que hoy se ve en la tienda. Es lo que hay que reemplazar, así que
    // conviene tenerlo a la vista mientras se elige la nueva.
    fotos,
    enCatalogo: Boolean(producto),
    enLaVidriera: estaEnLaVidrieraSinFoto(producto, fotos),
  };
}

/**
 * Publicado y sin ninguna foto: es lo que el cliente está viendo AHORA con el
 * cuadrito gris. Pasa con lo marcado "publicar siempre", que se saltea el
 * control de la foto. Es el mismo número que Tienda > Catálogo marca en rojo.
 */
function estaEnLaVidrieraSinFoto(producto, fotos) {
  if (!producto || fotos.length) return false;
  return motivoDeNoPublicar(producto, _habilitados, _subExcluidos) === null;
}

function ordenarPorFecha(filas) {
  return filas.sort((a, b) => (b.cuando?.getTime() || 0) - (a.cuando?.getTime() || 0));
}

/**
 * Escucha `tienda_fotos_pedidas` en vivo.
 *
 * Mientras el personal recorre el local marcando desde el celular, la lista de
 * acá se va llenando sola. Antes había que recordar apretar Actualizar, y en la
 * práctica se recargaba la página entera cada dos minutos para ver si había
 * entrado algo.
 *
 * Lo que llega mientras hay un panel de fotos abierto o una subida en curso se
 * aplica al cerrar: repintar la tabla debajo de un panel abierto le mueve el
 * piso a quien está eligiendo la portada.
 */
function escucharPedidas() {
  cortarEscucha();

  const alLlegar = (snap) => {
    const primera = _primerSnapshot;
    _primerSnapshot = false;

    const antes = new Set(_lista.map(f => f.id));
    _lista = ordenarPorFecha(snap.docs.map(d => filaDePedido(d.id, d.data() || {})));

    // Lo que entró estando la pantalla abierta se señala; en el primer
    // snapshot no, que ahí es toda la lista.
    if (!primera) {
      for (const f of _lista) if (!antes.has(f.id)) _nuevas.add(f.id);
    }

    // Un producto recién marcado puede no estar en el catálogo que esta
    // pantalla tiene en memoria (se cachea diez minutos). Sin sus datos la fila
    // sale diciendo "ya no está en el catálogo" y sin el botón para cargarle la
    // foto, que es justo lo que se vino a hacer.
    const faltan = _lista.filter(f => !f.enCatalogo).map(f => f.id);
    if (faltan.length) completarDelCatalogo(faltan);

    if (_panel || _subiendo) { _repintarAlSoltar = true; return; }
    pintarLista();
  };

  const alFallar = (err) => {
    // Sin el índice o con documentos viejos sin fecha, la consulta ordenada
    // falla entera. Se escucha igual, sin orden, y se ordena en memoria.
    console.warn('[fotos] listener ordenado no disponible, se escucha sin orden:', err?.message || err);
    _unsubPedidas = onSnapshot(collection(_db, 'tienda_fotos_pedidas'), alLlegar,
      e => console.error('[fotos] no se pudo escuchar la lista:', e));
  };

  try {
    _unsubPedidas = onSnapshot(
      query(collection(_db, 'tienda_fotos_pedidas'), orderBy('pedido_en', 'desc')),
      alLlegar, alFallar);
  } catch (err) {
    alFallar(err);
  }
}

const _buscados = new Set();     // ids ya consultados de a uno, para no repetir

/**
 * Trae del catálogo los productos que la pantalla no tenía en memoria.
 *
 * Son pocos y de a uno: los que se acaban de marcar desde la tienda. Cada id se
 * consulta una sola vez — si de verdad no está en el catálogo, la fila lo dice
 * y no tiene sentido volver a preguntar en cada snapshot.
 */
async function completarDelCatalogo(ids) {
  const nuevos = ids.filter(id => !_buscados.has(id));
  if (!nuevos.length) return;
  nuevos.forEach(id => _buscados.add(id));

  let encontrados = 0;
  await Promise.all(nuevos.map(async id => {
    try {
      const snap = await getDoc(doc(_db, 'catalogo', id));
      if (!snap.exists()) return;
      _catalogo.set(id, { ...snap.data(), doc_id: id });
      encontrados++;
    } catch (err) {
      console.warn('[fotos] no se pudo traer', id, err?.message || err);
    }
  }));
  if (!encontrados) return;

  // Completar las filas que estaban a medias, sin tocar lo que ya venía del
  // pedido (la fecha, sobre todo: es el orden de la tabla).
  _lista = _lista.map(f => {
    const producto = f.enCatalogo ? null : _catalogo.get(f.id);
    if (!producto) return f;
    const fotos = imagenesDe(producto);
    return {
      ...f,
      nombre: f.nombre === '(sin nombre)' ? (producto.nombre || f.nombre) : f.nombre,
      rubro: f.rubro || producto.rubro || '',
      fotos,
      enCatalogo: true,
      enLaVidriera: estaEnLaVidrieraSinFoto(producto, fotos),
    };
  });

  if (_panel || _subiendo) { _repintarAlSoltar = true; return; }
  pintarLista();
}

function cortarEscucha() {
  for (const cortar of [_unsubPedidas, _unsubOcultos, _unsubCatalogo]) {
    if (!cortar) continue;
    try { cortar(); } catch (_) { /* ya estaba cortado */ }
  }
  _unsubPedidas = null;
  _unsubOcultos = null;
  _unsubCatalogo = null;
  _primerSnapshot = true;
  clearTimeout(_olvidarNuevas);
  clearTimeout(_esperaCatalogo);
  _nuevas.clear();
  _repintarAlSoltar = false;
  _catalogoAlSoltar = false;
}

/** Al irse de la pantalla: nada escuchando y ningún "Deshacer" suelto. */
function alSalir() {
  cortarEscucha();
  if (_avisoOculto) cerrarToast(_avisoOculto.el);
  _avisoOculto = null;
}

/** Aplica lo que llegó mientras había un panel abierto o una subida en curso. */
function soltarRepintadoPendiente() {
  if (_panel || _subiendo) return;
  if (_catalogoAlSoltar) {
    _catalogoAlSoltar = false;
    if (tomarCatalogoDelStore()) _repintarAlSoltar = true;
  }
  if (!_repintarAlSoltar) return;
  _repintarAlSoltar = false;
  pintarLista();
}

/* ── El catálogo vivo ─────────────────────────────────────────────────────── */
// La pantalla no se redibuja entera con cada cambio del store (main.js la deja
// afuera): con cada venta del POS quedaba arriba de todo, con los ocultos
// cerrados y la fila que se estaba yendo cortada. Escucha el catálogo por su
// cuenta y mueve solo lo que cambió: la foto cargada desde otro lado, el que se
// quedó sin stock, el que volvió a tener.

const ESPERA_CATALOGO_MS = 500;

function escucharCatalogo() {
  if (_unsubCatalogo) {
    try { _unsubCatalogo(); } catch (_) { /* ya estaba cortado */ }
  }
  _unsubCatalogo = onStoreChange(col => {
    if (col !== 'catalogo') return;
    clearTimeout(_esperaCatalogo);
    _esperaCatalogo = setTimeout(refrescarDelCatalogo, ESPERA_CATALOGO_MS);
  });
}

/**
 * Rehace las dos listas con el catálogo que tiene el store. `false` si todavía
 * no hay catálogo para mirar.
 */
function tomarCatalogoDelStore() {
  const datos = peekCacheValue('catalogo:all');
  if (!Array.isArray(datos) || !datos.length) return false;

  const catalogo = new Map(datos.map(d => [String(d.doc_id), d]));
  // Lo que se trajo de a uno (recién marcado desde la tienda) puede no haber
  // llegado todavía al store: sin esto su fila perdía el botón de cargar.
  for (const id of _buscados) {
    if (!catalogo.has(id) && _catalogo.has(id)) catalogo.set(id, _catalogo.get(id));
  }
  _catalogo = catalogo;

  _lista = _lista.map(f => {
    const producto = _catalogo.get(f.id);
    if (!producto) return f;
    const fotos = imagenesDe(producto);
    return { ...f, fotos, enCatalogo: true, enLaVidriera: estaEnLaVidrieraSinFoto(producto, fotos) };
  });
  _esperando = armarEsperando();
  return true;
}

function refrescarDelCatalogo() {
  if (!document.getElementById('fotosCuerpo')) return;
  if (_panel || _subiendo) { _catalogoAlSoltar = true; return; }

  const firmaLista = () => _lista
    .map(f => `${f.id}:${f.fotos.join(',')}:${f.enCatalogo}:${f.enLaVidriera}`).join('|');
  const listaAntes = firmaLista();
  const vidrieraAntes = cuentas().enVidriera;
  const antes = new Map(_esperando.map(f => [f.id, f]));
  if (!tomarCatalogoDelStore()) return;

  const ahora = new Map(_esperando.map(f => [f.id, f]));
  const salen = [...antes.keys()].filter(id => !ahora.has(id));
  const entran = [...ahora.keys()].filter(id => !antes.has(id));
  const cambiados = [...ahora.values()].some(f => {
    const a = antes.get(f.id);
    return a && (a.nombre !== f.nombre || a.rubro !== f.rubro || a.enLaVidriera !== f.enLaVidriera);
  });
  const listaCambio = firmaLista() !== listaAntes;
  // Casi todas las ventas terminan acá: cambió el stock y nada más.
  if (!salen.length && !entran.length && !cambiados && !listaCambio) return;

  // Lo que no es solo entrar o salir (un nombre, uno que pasó a la vidriera, la
  // lista a mano) se vuelve a pintar adentro de la misma pantalla: el
  // contenedor no se toca, así que la vista y los ocultos abiertos siguen donde
  // estaban.
  if (cambiados || listaCambio || cuentas().enVidriera !== vidrieraAntes
      || !_esperando.length || !document.getElementById('fotosTablaEsperando')) {
    pintarLista();
    return;
  }
  moverFilas({ salen, entran });
}

/* ── Pintado ──────────────────────────────────────────────────────────────── */

/**
 * Los números de la pantalla, de una sola cuenta: el pintado entero y el
 * retoque en el lugar (al ocultar o mostrar una fila) tienen que decir lo mismo.
 */
function cuentas() {
  const { visibles, ocultas } = separarOcultos(_esperando, _ocultos);
  return {
    visibles,
    ocultas,
    // Los que el cliente está viendo ahora mismo con el cuadrito gris, estén
    // pedidos a mano, en la lista o se hayan ocultado de ella: es el mismo
    // número que Tienda > Catálogo marca en rojo, y si acá dijera otra cosa
    // habría que dudar de los dos. Ocultar no los saca de la vidriera.
    enVidriera: _lista.filter(f => f.enLaVidriera).length
              + _esperando.filter(f => f.enLaVidriera).length,
    // Lo que queda por hacer: lo oculto no se va a fotografiar.
    porSalir: visibles.filter(f => !f.enLaVidriera).length,
    sinFoto: _lista.filter(f => !f.fotos.length).length,
  };
}

const CABECERA = `
  <thead>
    <tr>
      <th style="width:54px">Foto</th>
      <th>Producto</th>
      <th style="width:140px">Rubro</th>
      <th style="width:112px">Marcado</th>
      <th style="width:210px" data-no-imprimir></th>
    </tr>
  </thead>`;

function pintarLista() {
  const cuerpo = document.getElementById('fotosCuerpo');
  if (!cuerpo) return;

  if (!_lista.length && !_esperando.length) {
    cuerpo.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">photo_camera</span>
        <p>No hay nada esperando foto. Todo lo que tiene stock ya está en la vidriera.</p>
      </div>`;
    return;
  }

  const c = cuentas();
  // Sin ninguno visible la tabla de ocultos no tiene sentido abierta.
  if (!c.ocultas.length) _verOcultos = false;

  const tabla = (titulo, bajada, filas, id) => !filas.length ? '' : `
    <h3 style="margin:22px 0 8px;font-size:15px">${escHtml(titulo)}
      <span style="color:var(--text-muted);font-weight:400">· ${filas.length}</span>
    </h3>
    <p class="tienda-pista" style="margin:0 0 10px">${escHtml(bajada)}</p>
    <table class="tienda-tabla" id="${id}">
      ${CABECERA}
      <tbody>${filas.map(f => filaHtml(f)).join('')}</tbody>
    </table>`;

  // Se arma aunque estén todos ocultos: es la única puerta para volver a verlos.
  const faltaFoto = !_esperando.length ? '' : `
    <div class="fotos-encabezado">
      <h3>Les falta la foto
        <span class="fotos-encabezado__cuenta">· <span data-cuenta="esperando">${c.visibles.length}</span></span>
      </h3>
      <button class="pc-btn fotos-ver-ocultos" data-ver-ocultos
              aria-expanded="${_verOcultos}" aria-controls="fotosOcultosCaja"
              title="Los que se sacaron de esta lista porque no se van a fotografiar"
              ${c.ocultas.length ? '' : 'hidden'}>
        <span class="material-icons">visibility_off</span>
        Ocultos <b data-cuenta="ocultos">${c.ocultas.length}</b>
        <span class="material-icons fotos-ver-ocultos__flecha">expand_more</span>
      </button>
    </div>
    <p class="tienda-pista" style="margin:0 0 10px">${escHtml(
      'Esta la arma el sistema mirando el catálogo. Los que están en orden salen '
      + 'a la vidriera apenas se les carga una; los marcados "publicar siempre" ya '
      + 'se están mostrando, con el cuadrito gris. En los dos casos salen de la '
      + 'lista al cargarla. Al que no se le va a sacar foto se lo oculta con el '
      + 'ojo: sale de esta lista y no cambia nada en la tienda.')}</p>
    <div id="fotosOcultosCaja" class="fotos-ocultos-caja">${
      _verOcultos ? tablaOcultosHtml(c.ocultas) : ''}</div>
    <p class="tienda-pista fotos-todo-oculto" data-todo-oculto
       ${c.visibles.length ? 'hidden' : ''}>
      No queda nada a la vista: todo lo que falta está en Ocultos.
    </p>
    <table class="tienda-tabla" id="fotosTablaEsperando" ${c.visibles.length ? '' : 'hidden'}>
      ${CABECERA}
      <tbody>${c.visibles.map(f => filaHtml(f)).join('')}</tbody>
    </table>`;

  cuerpo.innerHTML = `
    <div class="tienda-resumen">
      <div class="tienda-dato">
        <b>${_lista.length}</b><span>pedidas a mano</span>
      </div>
      <div class="tienda-dato${c.porSalir ? ' alerta' : ''}" data-dato="porSalir">
        <b data-cuenta="porSalir">${c.porSalir}</b><span>esperando foto para salir</span>
      </div>
      ${c.enVidriera ? `
      <div class="tienda-dato alerta">
        <b>${c.enVidriera}</b><span>en la vidriera sin foto</span>
      </div>` : ''}
      <div class="tienda-dato">
        <b>${_lista.length - c.sinFoto}</b><span>con foto a reemplazar</span>
      </div>
    </div>

    ${tabla('Pedidas a mano',
            'Lo que se marcó desde la tienda, con su fecha.',
            _lista, 'fotosTabla')}

    ${faltaFoto}`;

  // La señal de "recién marcado" dura lo que tarda en encontrarse: el fondo se
  // apaga solo por CSS y acá se olvida el id, así el próximo pintado ya sale
  // limpio. Sin esto, lo marcado hace media hora seguiría gritando.
  if (_nuevas.size) {
    const vistos = [..._nuevas];
    clearTimeout(_olvidarNuevas);
    _olvidarNuevas = setTimeout(() => vistos.forEach(id => _nuevas.delete(id)), 8000);
  }
}

function tablaOcultosHtml(ocultas) {
  if (!ocultas.length) return '';
  return `
    <div class="fotos-ocultos">
      <p class="tienda-pista" style="margin:0 0 8px">
        Siguen sin foto y la tienda no cambió: los publicados se siguen viendo
        con el cuadrito gris. "Mostrar" los devuelve a la lista.
      </p>
      <table class="tienda-tabla fotos-tabla-ocultos" id="fotosTablaOcultos">
        ${CABECERA}
        <tbody>${ocultas.map(f => filaHtml(f, { oculta: true })).join('')}</tbody>
      </table>
    </div>`;
}

/** Los botones de las tablas, que entran y salen con las filas. */
function alClickEnTabla(ev) {
  const boton = ev.target.closest('button');
  if (!boton || boton.disabled) return;
  const { sacar: aSacar, cargar, ocultar: aOcultar, mostrar: aMostrar } = boton.dataset;
  if (aSacar) sacar(aSacar);
  else if (cargar) pedirArchivo(cargar);
  else if (aOcultar) ocultar(aOcultar);
  else if (aMostrar) mostrar(aMostrar);
  else if (boton.hasAttribute('data-ver-ocultos')) alternarOcultos();
}

function filaHtml(f, { oculta = false } = {}) {
  const foto = f.fotos[0];
  const recien = !oculta && _nuevas.has(f.id);
  const id = escHtml(f.id);
  const cuando = oculta ? _ocultos.get(f.id)?.oculto_en : null;

  let acciones;
  if (oculta) {
    acciones = `
      <button class="pc-btn" data-mostrar="${id}" title="Volver a la lista de los que les falta la foto"
              style="padding:6px 10px;white-space:nowrap">
        <span class="material-icons">visibility</span> Mostrar
      </button>`;
  } else {
    acciones = `
      ${f.enCatalogo ? `
        <button class="pc-btn" data-cargar="${id}"
                style="padding:6px 10px;white-space:nowrap">
          <span class="material-icons">add_a_photo</span>
          ${f.fotos.length ? 'Cambiar' : 'Cargar'}
        </button>` : ''}
      ${f.automatico ? `
        <button class="pc-btn" data-ocultar="${id}" title="Ocultar: no se le va a sacar foto"
                aria-label="Ocultar de esta lista" style="padding:6px 8px">
          <span class="material-icons" style="font-size:17px">visibility_off</span>
        </button>` : `
        <button class="pc-btn" data-sacar="${id}" title="Sacar de la lista"
                style="padding:6px 8px">
          <span class="material-icons" style="font-size:17px">close</span>
        </button>`}`;
  }

  return `
    <tr data-fila="${id}"${recien ? ' class="fila-recien"' : ''}>
      <td>
        ${foto
          ? `<img src="${escHtml(foto)}" alt="" class="tienda-foto" loading="lazy">`
          : `<div class="tienda-foto tienda-foto--falta">
               <span class="material-icons">image_not_supported</span>
             </div>`}
      </td>
      <td>
        <div class="tienda-nombre">${escHtml(f.nombre)}${
          recien ? '<span class="tienda-etiqueta recien">recién marcado</span>' : ''}</div>
        ${cuando ? `<div class="tienda-sub">Oculto el ${fecha(cuando)}</div>`
          : f.enCatalogo
            ? (f.fotos.length > 1
                ? `<div class="tienda-sub">${f.fotos.length} fotos cargadas</div>` : '')
            : '<div class="tienda-sub" style="color:var(--tint-red-fg)">'
              + 'Ya no está en el catálogo</div>'}
      </td>
      <td>${escHtml(nombreBonito(f.rubro))}</td>
      <td style="color:var(--text-muted)">${marcaDe(f)}</td>
      <td data-no-imprimir>
        <div style="display:flex;gap:6px;align-items:center;justify-content:flex-end">
          <span class="tienda-pista" data-estado="${id}" style="margin:0"></span>
          ${acciones}
        </div>
      </td>
    </tr>`;
}

/* ── Ocultar y mostrar ────────────────────────────────────────────────────── */
// La fila se mueve en el momento y el guardado va detrás. Si falla, vuelve a
// su lugar y se avisa: esperar a la base para mover la fila hacía que cada
// click tardara lo que tarda la escritura, y con doscientos renglones para
// revisar eso se siente.

function ocultar(id) {
  const f = _esperando.find(x => x.id === id);
  if (!f || _ocultos.has(id)) return;
  const cambios = cambioOcultar(f);
  cambiarOculto(f, cambios, { entrada: cambios[id], error: 'No se pudo ocultar' });
  avisarOcultado(f);
}

function mostrar(id) {
  const f = _esperando.find(x => x.id === id);
  if (!f || !_ocultos.has(id)) return;
  if (_avisoOculto?.id === id) { cerrarToast(_avisoOculto.el); _avisoOculto = null; }
  cambiarOculto(f, cambioMostrar(id), { entrada: null, error: 'No se pudo volver a mostrar' });
}

async function cambiarOculto(f, cambios, { entrada, error }) {
  const pendiente = { entrada, guardadoEn: null };
  _pendientes.set(f.id, pendiente);
  refrescarOcultos();

  try {
    await guardarCambioDeOcultos(_db, cambios);
    pendiente.guardadoEn = Date.now();
  } catch (err) {
    console.error(`[fotos] ${error.toLowerCase()}:`, err);
    // Si mientras tanto se lo volvió a tocar, manda lo último.
    if (_pendientes.get(f.id) !== pendiente) return;
    _pendientes.delete(f.id);
    if (_avisoOculto?.id === f.id) { cerrarToast(_avisoOculto.el); _avisoOculto = null; }
    refrescarOcultos();
    mostrarToast({
      tono: 'rojo', icono: 'error_outline', etiqueta: error, titulo: f.nombre,
      detalleHtml: escHtml(err?.message || 'Probá de nuevo.'), duracion: 8000,
    });
  }
}

/** Escucha lo que se oculta desde esta pestaña o desde cualquier otra. */
function escucharOcultosEnVivo() {
  if (_unsubOcultos) {
    try { _unsubOcultos(); } catch (_) { /* ya estaba cortado */ }
  }
  _unsubOcultos = escucharOcultos(_db, (ocultos) => {
    _ocultosServidor = ocultos;
    refrescarOcultos();
  });
}

/**
 * Recalcula lo oculto (la base con lo pendiente encima) y mueve en el lugar las
 * filas que cambiaron. Con un panel de fotos abierto no se toca la tabla: se
 * repinta al cerrarlo, igual que con lo que llega desde la tienda.
 */
function refrescarOcultos() {
  const antes = _ocultos;
  const { efectivo, resueltos } = reconciliar(_ocultosServidor, _pendientes);
  resueltos.forEach(id => _pendientes.delete(id));
  _ocultos = efectivo;

  const enLaLista = new Set(_esperando.map(f => f.id));
  const { ocultados, mostrados } = diferencias(antes, efectivo);
  const aOcultar = ocultados.filter(id => enLaLista.has(id));
  const aMostrar = mostrados.filter(id => enLaLista.has(id));
  if (!aOcultar.length && !aMostrar.length) return;

  if (_panel || _subiendo) { _repintarAlSoltar = true; return; }
  // Ocultar es salir de la lista y entrar a los ocultos; mostrar, al revés.
  const movidos = [...aOcultar, ...aMostrar];
  moverFilas({ salen: movidos, entran: movidos });
}

/**
 * Mueve en el lugar las filas que cambiaron: las de `salen` se van de la tabla
 * donde estén (la lista o los ocultos) y las de `entran` van a la que les toca
 * ahora, en su posición.
 */
function moverFilas({ salen = [], entran = [] }) {
  const tabla = document.getElementById('fotosTablaEsperando');
  if (!tabla) { pintarLista(); return; }

  const { visibles, ocultas } = cuentas();
  const tablaOcultos = document.getElementById('fotosTablaOcultos');
  const salidas = [];

  for (const id of salen) {
    for (const donde of [tabla, tablaOcultos]) {
      const fila = filaViva(donde, id);
      if (fila) salidas.push(sacarFila(fila));
    }
  }
  for (const id of entran) {
    if (!_ocultos.has(id)) meterEnTabla(tabla, id, visibles);
    else if (tablaOcultos) meterEnTabla(tablaOcultos, id, ocultas, { oculta: true });
  }

  actualizarCuentas();
  // Lo que queda vacío se acomoda cuando termina de irse la última fila, no
  // antes: esconder la tabla en el momento cortaba la animación a la mitad.
  Promise.all(salidas).then(acomodarVacios);
}

function filaViva(tabla, id) {
  return tabla?.querySelector(`tbody tr[data-fila="${CSS.escape(id)}"]:not([data-saliendo])`) || null;
}

/** Pone la fila de `id` en su lugar según `orden`, abriéndose paso. */
function meterEnTabla(tabla, id, orden, opciones = {}) {
  const tbody = tabla?.tBodies?.[0];
  const indice = orden.findIndex(x => x.id === id);
  if (!tbody || indice < 0 || filaViva(tabla, id)) return;

  if (tabla.id === 'fotosTablaEsperando' && tabla.hidden) {
    tabla.hidden = false;
    const aviso = document.querySelector('[data-todo-oculto]');
    if (aviso) aviso.hidden = true;
  }

  const molde = document.createElement('tbody');
  molde.innerHTML = filaHtml(orden[indice], opciones);
  const fila = molde.firstElementChild;

  // Va antes del primer renglón vivo que en el orden viene después.
  const despues = new Set(orden.slice(indice + 1).map(x => x.id));
  const siguiente = [...tbody.rows].find(r =>
    !r.hasAttribute('data-saliendo') && despues.has(r.dataset.fila)) || null;
  meterFila(fila, () => tbody.insertBefore(fila, siguiente));
}

/** Los números que dependen de lo oculto, cambiados en el lugar. */
function actualizarCuentas() {
  const c = cuentas();
  const poner = (cual, valor) => {
    const nodo = document.querySelector(`[data-cuenta="${cual}"]`);
    if (!nodo || nodo.textContent === String(valor)) return;
    nodo.textContent = String(valor);
    nodo.classList.remove('val-fill');
    void nodo.offsetWidth;          // reinicia la animación si ya la tenía
    nodo.classList.add('val-fill');
  };
  poner('esperando', c.visibles.length);
  poner('ocultos', c.ocultas.length);
  poner('porSalir', c.porSalir);
  document.querySelector('[data-dato="porSalir"]')?.classList.toggle('alerta', c.porSalir > 0);
  const boton = document.querySelector('[data-ver-ocultos]');
  if (boton && c.ocultas.length) boton.hidden = false;
}

/** Cuando termina de irse lo que se iba: tablas vacías, botón sin ocultos. */
function acomodarVacios() {
  const c = cuentas();
  const tabla = document.getElementById('fotosTablaEsperando');
  if (!tabla) return;
  tabla.hidden = !c.visibles.length;
  const aviso = document.querySelector('[data-todo-oculto]');
  if (aviso) aviso.hidden = c.visibles.length > 0;

  if (c.ocultas.length) return;
  const boton = document.querySelector('[data-ver-ocultos]');
  if (boton) { boton.hidden = true; boton.setAttribute('aria-expanded', 'false'); }
  if (_verOcultos) {
    _verOcultos = false;
    const caja = document.getElementById('fotosOcultosCaja');
    if (caja) plegar(caja, () => { if (!_verOcultos) caja.innerHTML = ''; });
  }
}

function alternarOcultos() {
  const caja = document.getElementById('fotosOcultosCaja');
  const boton = document.querySelector('[data-ver-ocultos]');
  if (!caja || !boton) return;

  _verOcultos = !_verOcultos;
  boton.setAttribute('aria-expanded', String(_verOcultos));
  if (_verOcultos) {
    // Se llena siempre de nuevo: si se estaba cerrando, lo que tenía adentro
    // no se actualizó mientras tanto.
    desplegar(caja, () => { caja.innerHTML = tablaOcultosHtml(cuentas().ocultas); });
  } else {
    plegar(caja, () => { if (!_verOcultos) caja.innerHTML = ''; });
  }
}

/**
 * El aviso con "Deshacer". Uno solo a la vez: ocultando varios seguidos, una
 * pila de avisos taparía la tabla que se está revisando.
 */
function avisarOcultado(f) {
  if (_avisoOculto) cerrarToast(_avisoOculto.el);
  const aviso = mostrarToast({
    tono: 'violeta',
    icono: 'visibility_off',
    etiqueta: 'Oculto de la lista',
    titulo: f.nombre,
    acciones: [{ id: 'deshacer', texto: 'Deshacer', principal: true }],
    duracion: 6000,
    onAccion: (accion, api) => {
      // Un aviso que ya se está yendo (lo reemplazó el de otro producto) sigue
      // dibujado un instante: su "Deshacer" no puede devolver el que no es.
      if (accion !== 'deshacer' || api.el.dataset.cerrando === '1') return;
      api.cerrar();
      mostrar(f.id);
    },
  });
  _avisoOculto = { id: f.id, el: aviso.el };
}

/**
 * La columna "Marcado".
 *
 * Lo pedido a mano lleva su fecha. Lo que armó el sistema no tiene fecha, y ahí
 * lo que importa es otra cosa: si el cliente lo está viendo con el cuadrito
 * gris o si todavía no salió. Antes decía "En la vidriera" en los dos casos, y
 * los doscientos que faltaban publicar parecían estar todos a la vista.
 */
function marcaDe(f) {
  if (f.cuando) return fecha(f.cuando);
  if (f.enLaVidriera) return '<span class="tienda-etiqueta oculto">En la vidriera</span>';
  if (f.automatico) return '<span class="tienda-etiqueta sinfoto">Todavía no sale</span>';
  return '';
}

function estado(id, texto, error = false) {
  const nodo = document.querySelector(`[data-estado="${CSS.escape(id)}"]`);
  if (!nodo) return;
  nodo.textContent = texto || '';
  nodo.style.color = error ? 'var(--tint-red-fg)' : 'var(--text-muted)';
}

/* ── Carga de la foto ─────────────────────────────────────────────────────── */

function pedirArchivo(id) {
  if (_subiendo) return;
  const f = _lista.find(x => x.id === id) || _esperando.find(x => x.id === id);
  if (!f) return;

  // Con fotos ya cargadas, "Cambiar" abre el panel de una: lo primero que hace
  // falta ver es lo que hay, para decidir si se reemplaza, se suma o se
  // reordena. Sin fotos, "Cargar" va derecho al selector de archivos y el
  // panel se abre con lo elegido: pedir un click más a los doscientos que
  // esperan foto no tiene sentido.
  if (f.fotos.length) { abrirPanelFotos(id, f, []); return; }
  elegirArchivos(id);
}

function elegirArchivos(id) {
  const input = document.getElementById('fotosArchivo');
  if (!input) return;
  // El id del producto viaja en el propio input: el `change` llega después, y
  // para entonces ya no hay forma de saber desde qué fila se abrió.
  input.dataset.para = id;
  input.value = '';
  input.click();
}

async function alElegirArchivo(ev) {
  const input = ev.target;
  const id = input.dataset.para;
  const archivos = [...(input.files || [])].filter(a => a.type?.startsWith('image/'));
  input.value = '';
  if (!id || !archivos.length || _subiendo) return;

  // Si el panel de este producto ya está abierto, lo elegido se suma ahí.
  if (_panel && _panel.id === id) { _panel.agregar(archivos); return; }

  // Puede venir de cualquiera de las dos tablas.
  const f = _lista.find(x => x.id === id) || _esperando.find(x => x.id === id);
  if (!f) return;

  abrirPanelFotos(id, f, archivos);
}

/* ── El panel de fotos del producto ──────────────────────────────────────── */
// Antes se subía directo a Storage sin mostrar nada: si la foto salía movida o
// era la que no era, ya quedaba pegada en el producto. Ahora se ve todo junto
// —lo que tiene y lo que se acaba de elegir— y no se sube nada hasta Guardar.
//
// Cada foto es una clave en una lista: la url si ya está guardada, o
// `nueva:N` si es un archivo recién elegido. Así la portada y el orden se
// resuelven con las mismas funciones que usa el editor del catálogo
// (tienda_galeria.js) y lo que se prueba es lo mismo.

function cerrarPanelFotos() {
  const previo = document.querySelector('.tienda-overlay[data-panel-fotos]');
  if (previo) {
    (previo._urls || []).forEach(u => URL.revokeObjectURL(u));
    if (previo._alTeclado) document.removeEventListener('keydown', previo._alTeclado);
    previo.remove();
  }
  _panel = null;
  // Lo que entró mientras el panel estaba abierto se pinta ahora.
  soltarRepintadoPendiente();
}

function abrirPanelFotos(id, f, archivosIniciales) {
  cerrarPanelFotos();

  const nuevas = new Map();          // 'nueva:N' -> { archivo, url (blob) }
  let contador = 0;
  let claves = f.fotos.slice();      // el orden actual; la primera es la portada
  let guardando = false;

  const overlay = document.createElement('div');
  overlay.className = 'tienda-overlay';
  overlay.setAttribute('data-panel-fotos', '');
  overlay._urls = [];
  overlay.innerHTML = `
    <div class="tienda-editor" style="max-width:640px" role="dialog" aria-modal="true">
      <header>
        <div style="min-width:0;flex:1">
          <h3>${escHtml(f.nombre)}</h3>
          <p>La portada es la que se ve en el listado y abre la ficha; las demás
             van como miniaturas debajo.</p>
        </div>
        <button class="pc-btn" data-accion="cancelar" style="padding:6px 10px">
          <span class="material-icons">close</span>
        </button>
      </header>
      <div class="cuerpo">
        <div class="tienda-fotos" data-fotos></div>
        <div class="tienda-pista" data-pista style="margin-top:10px"></div>
      </div>
      <footer>
        <span class="tienda-pista" data-estado style="margin:0 auto 0 0"></span>
        <button class="pc-btn" data-accion="cancelar" style="padding:9px 16px">Cancelar</button>
        <button class="pc-btn" data-accion="guardar"
                style="padding:9px 20px;background:#4361ee;color:#fff;border-color:#4361ee">
          Guardar
        </button>
      </footer>
    </div>`;

  const $ = sel => overlay.querySelector(sel);
  const decir = (texto, error = false) => {
    const nodo = $('[data-estado]');
    nodo.textContent = texto || '';
    nodo.style.color = error ? 'var(--tint-red-fg)' : 'var(--text-muted)';
  };
  const srcDe = clave => nuevas.has(clave) ? nuevas.get(clave).url : clave;

  function agregar(archivos) {
    // Lo nuevo va ADELANTE: quien sube una foto la sube para que se vea, y
    // la primera nueva pasa a ser la portada. Después se puede acomodar.
    const frescas = [];
    for (const archivo of archivos) {
      const clave = `nueva:${contador++}`;
      const url = URL.createObjectURL(archivo);
      overlay._urls.push(url);
      nuevas.set(clave, { archivo, url });
      frescas.push(clave);
    }
    claves = [...frescas, ...claves];
    pintar();
  }

  function pintar() {
    const ultima = claves.length - 1;
    const cuantasNuevas = claves.filter(c => nuevas.has(c)).length;
    const quitadas = fotosQuitadas(f.fotos, claves).length;

    $('[data-fotos]').innerHTML = claves.map((clave, i) => `
      <div class="tienda-foto-item ${i === 0 ? 'es-portada' : ''} ${nuevas.has(clave) ? 'es-nueva' : ''}">
        <img src="${escHtml(srcDe(clave))}" alt="" data-accion="ver" data-i="${i}">
        ${nuevas.has(clave) ? '<span class="tienda-foto-nueva">NUEVA</span>' : ''}
        ${i === 0 ? '<span class="principal">PORTADA</span>' : ''}
        <div class="tienda-foto-acciones">
          ${i > 0 ? `<button data-accion="portada" data-i="${i}" title="Usar de portada">
                       <span class="material-icons">star</span></button>` : ''}
          ${i > 0 ? `<button data-accion="izquierda" data-i="${i}" title="Mover a la izquierda">
                       <span class="material-icons">chevron_left</span></button>` : ''}
          ${i < ultima ? `<button data-accion="derecha" data-i="${i}" title="Mover a la derecha">
                       <span class="material-icons">chevron_right</span></button>` : ''}
          <button data-accion="quitar" data-i="${i}" title="${nuevas.has(clave) ? 'No subir esta' : 'Sacar esta foto del producto'}">
            <span class="material-icons">delete</span></button>
        </div>
      </div>`).join('')
      + `<button class="tienda-subir" data-accion="agregar">
           <span class="material-icons">add_photo_alternate</span> Agregar
         </button>`;

    // El pie dice qué va a pasar al guardar, para que no haya sorpresas: "se
    // suben 2, se saca 1" antes de tocar el botón.
    const partes = [];
    if (cuantasNuevas) partes.push(`se ${cuantasNuevas === 1 ? 'sube 1 foto nueva' : `suben ${cuantasNuevas} fotos nuevas`}`);
    if (quitadas) partes.push(`se ${quitadas === 1 ? 'saca 1' : `sacan ${quitadas}`} del producto`);
    $('[data-pista]').textContent = !claves.length
      ? 'Sin fotos el producto no sale a la vidriera. Agregá al menos una.'
      : partes.length
        ? `Al guardar ${partes.join(' y ')}. La tienda se actualiza en el momento.`
        : 'Acomodá el orden o agregá más. Nada cambia hasta guardar.';

    $('[data-accion="guardar"]').disabled = guardando
      || (!cuantasNuevas && !quitadas && claves.join('\n') === f.fotos.join('\n'));
  }

  async function guardar() {
    if (guardando) return;
    guardando = true;
    _subiendo = true;
    overlay.querySelectorAll('button').forEach(b => { b.disabled = true; });
    document.querySelectorAll('[data-cargar]').forEach(b => { b.disabled = true; });

    const subidas = [];
    // Si el catálogo quedó escrito, las fotos recién subidas son las que el
    // producto está mostrando: borrarlas ahí es dejar la ficha rota.
    let catalogoGuardado = false;
    try {
      // 1. Se suben las nuevas, en el orden en que quedaron.
      const imagenes = [];
      const pendientes = claves.filter(c => nuevas.has(c)).length;
      let n = 0;
      for (const clave of claves) {
        if (!nuevas.has(clave)) { imagenes.push(clave); continue; }
        n++;
        const cual = pendientes > 1 ? ` (${n} de ${pendientes})` : '';
        const url = await subirFoto(id, nuevas.get(clave).archivo,
          { alProgreso: t => decir(t + cual) });
        subidas.push(url);
        imagenes.push(url);
      }

      // 2. Lo que se sacó de la galería se desvincula de las variedades que
      //    lo usaran, en el mismo guardado: si no, la ficha queda con una
      //    imagen rota al elegir ese color.
      const quitadas = fotosQuitadas(f.fotos, imagenes);
      const producto = _catalogo.get(id);
      const cambios = { tienda_imagenes: imagenes };
      let ajustes = producto?.tienda_variedades;
      let hayDesvinculadas = false;
      for (const url of quitadas) {
        const r = desvincularFoto(ajustes, url);
        if (r.desvinculadas.length) { ajustes = r.ajustes; hayDesvinculadas = true; }
      }
      if (hayDesvinculadas) cambios.tienda_variedades = limpiarAjustes(ajustes);

      // El botón de cargar no se ofrece para lo que ya no está en el catálogo;
      // si igual se llegó hasta acá, mejor cortar que escribir una ficha a
      // medias en la tienda.
      if (!producto) throw new Error('El producto ya no está en el catálogo.');

      // Si el cliente lo estaba viendo ANTES de tocar las fotos. Se mide acá,
      // con el producto todavía sin cambiar, para compararlo después contra lo
      // que decidió el espejo.
      const estabaPublicado = motivoDeNoPublicar(producto, _habilitados, _subExcluidos) === null;

      decir('Guardando…');

      // 3. El catálogo primero y el espejo después, en dos pasos y no con
      //    `guardarYEspejar`: ese escribe el catálogo y espeja después, así que
      //    un espejado que falla (la REST vuelve 4xx) tiraba el error con las
      //    fotos YA guardadas en el producto y el `catch` de abajo borraba de
      //    Storage justo esas: la ficha quedaba apuntando a archivos que no
      //    existían más. Separados se sabe qué llegó a escribirse.
      await actualizarDoc(_db, 'catalogo', id, cambios);
      catalogoGuardado = true;

      // 4. Lo que hay en pantalla acompaña a lo que quedó escrito, sin esperar
      //    al espejo: si el espejado falla, la lista igual tiene que mostrar
      //    las fotos nuevas.
      producto.tienda_imagenes = imagenes;
      if (hayDesvinculadas) {
        if (cambios.tienda_variedades === undefined) delete producto.tienda_variedades;
        else producto.tienda_variedades = cambios.tienda_variedades;
      }
      f.fotos = imagenes.slice();
      // El renglón que se queda (se sacaron todas las fotos) tiene que decir si
      // el cliente lo sigue viendo así: los "publicar siempre" salen a la
      // vidriera igual, sin ninguna.
      f.enLaVidriera = estaEnLaVidrieraSinFoto(producto, imagenes);

      const resultado = await espejar(_db, id, producto, _habilitados, _subExcluidos);

      // Esta es la pantalla por la que MÁS productos entran a la tienda: al que
      // ya tenía stock y el rubro prendido lo único que le faltaba era la foto,
      // y con ella se publica en el momento. El conteo por rubro y subrubro que
      // dibuja los filtros de la portada seguía con el número de antes hasta la
      // corrida siguiente del sync, hasta seis horas: el filtro decía "Aros 1"
      // y adentro no había nada, o al revés, contaba uno que ya no estaba.
      // Solo cuando entra o sale: acomodar el orden de las fotos o cambiar la
      // portada no mueve ningún número.
      const quedoPublicado = resultado?.publicado === true;
      if (quedoPublicado !== estabaPublicado) programarRecuentoDeRubros(_db);

      // 5. Con foto ya no está pendiente: sale de las dos listas. Se saca
      //    recién ahora: si el guardado hubiera fallado, tenía que seguir acá.
      //    Sin fotos (las sacó todas) sigue pendiente, con lo que quedó.
      if (imagenes.length) {
        await borrarDoc(_db, 'tienda_fotos_pedidas', id).catch(() => {});
        _lista = _lista.filter(x => x.id !== id);
        _esperando = _esperando.filter(x => x.id !== id);
      }
      pintarLista();

      // 6. Recién ahora se borran de Storage las que se sacaron: al revés, un
      //    fallo al guardar dejaba el producto apuntando a fotos que ya no
      //    existen.
      quitadas.forEach(url => borrarFoto(url));

      if (!resultado?.publicado) {
        // Pasa cuando el producto está sin stock o su rubro no se publica: la
        // foto quedó guardada igual, pero no se ve en la tienda todavía.
        console.info(`[fotos] ${id}: fotos guardadas, sin publicar (${resultado?.motivo})`);
      }
      cerrarPanelFotos();
      estado(id, imagenes.length ? '' : 'Quedó sin fotos: sigue pendiente.');
    } catch (err) {
      console.error('[fotos] no se pudo guardar:', err);
      // Lo que se alcanzó a subir y no quedó guardado no sirve para nada. Si el
      // catálogo sí se escribió (falló el espejo, o el sacar de la lista) esas
      // fotos son las que el producto muestra: se quedan donde están.
      if (!catalogoGuardado) subidas.forEach(url => borrarFoto(url));
      guardando = false;
      overlay.querySelectorAll('button').forEach(b => { b.disabled = false; });
      pintar();
      decir(err?.message || 'No se pudo guardar. Probá de nuevo.', true);
    } finally {
      _subiendo = false;
      document.querySelectorAll('[data-cargar]').forEach(b => { b.disabled = false; });
      // Si mientras se subía entró algo desde la tienda, se pinta ahora.
      soltarRepintadoPendiente();
    }
  }

  // Seleccionar texto del título y soltar el mouse afuera del recuadro
  // también dispara "click" en el overlay: sin este control, cerraba el
  // panel solo por marcar texto.
  let bajoPropio = false;
  overlay.addEventListener('mousedown', ev => { bajoPropio = ev.target === overlay; });
  overlay.addEventListener('click', ev => {
    const boton = ev.target.closest('[data-accion]');
    const accion = boton?.dataset.accion;
    if (!accion) {
      if (ev.target === overlay && bajoPropio && !guardando) cerrarPanelFotos();
      return;
    }
    const i = Number(boton.dataset.i);

    if (accion === 'ver') { verFotoGrande(srcDe(claves[i])); return; }
    if (guardando) return;
    if (accion === 'cancelar') { cerrarPanelFotos(); return; }
    if (accion === 'guardar') { guardar(); return; }
    if (accion === 'agregar') { elegirArchivos(id); return; }
    if (accion === 'portada') { claves = ponerDePortada(claves, i); pintar(); return; }
    if (accion === 'izquierda') { claves = moverFoto(claves, i, i - 1); pintar(); return; }
    if (accion === 'derecha') { claves = moverFoto(claves, i, i + 1); pintar(); return; }
    if (accion === 'quitar') {
      const clave = claves[i];
      claves = claves.filter((_, k) => k !== i);
      if (nuevas.has(clave)) {
        URL.revokeObjectURL(nuevas.get(clave).url);
        nuevas.delete(clave);
      }
      pintar();
    }
  });

  overlay._alTeclado = ev => { if (ev.key === 'Escape' && !guardando) cerrarPanelFotos(); };
  document.addEventListener('keydown', overlay._alTeclado);

  document.body.appendChild(overlay);
  _panel = { id, agregar };
  agregar(archivosIniciales);
}

/* ── Sacar de la lista ────────────────────────────────────────────────────── */

/**
 * Solo para lo pedido a mano. La tabla "Esperando foto" no ofrece este botón:
 * esas filas se calculan del catálogo y no hay documento que borrar, así que
 * "Sacar" las borraba de la pantalla hasta el próximo refresco y volvían.
 * Salen solas cuando se les carga la foto.
 */
async function sacar(id) {
  const f = _lista.find(x => x.id === id);
  if (!f) return;
  const ok = await confirmDialog({
    title: 'Sacar de la lista',
    message: `"${f.nombre || id}" deja de figurar como pendiente de foto.`,
    confirmText: 'Sacar',
  });
  if (!ok) return;

  try {
    await borrarDoc(_db, 'tienda_fotos_pedidas', id);
    _lista = _lista.filter(x => x.id !== id);
    _nuevas.delete(id);
    pintarLista();
  } catch (err) {
    console.error('[fotos] no se pudo sacar:', err);
    estado(id, 'No se pudo sacar.', true);
  }
}

function fecha(d) {
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })
       + ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/* ── Impresión ────────────────────────────────────────────────────────────── */

/**
 * Se imprime en una ventana aparte y no con `window.print()` sobre el panel:
 * así la hoja sale con la lista sola, sin el menú lateral ni los botones, y sin
 * tener que mantener una hoja de estilos de impresión para toda la aplicación.
 */
function imprimir() {
  // La hoja lleva lo pedido a mano y nada más: es la que alguien se lleva
  // encima para ir sacando las fotos. Lo que espera foto para salir son
  // cientos de renglones que se resuelven solos apenas se les carga una.
  if (!_lista.length) {
    alertDialog({
      title: 'No hay nada para imprimir',
      message: 'La hoja lleva lo que se marcó a mano desde la tienda, y ahora '
             + 'mismo no hay nada marcado.',
    });
    return;
  }

  const filas = _lista.map((f, i) => `
    <tr>
      <td class="n">${i + 1}</td>
      <td>${escHtml(f.nombre)}</td>
      <td>${escHtml(nombreBonito(f.rubro))}</td>
      <td>${f.fotos.length ? 'Cambiar' : 'No tiene'}</td>
      <td class="tilde"></td>
    </tr>`).join('');

  const hoy = new Date().toLocaleDateString('es-AR',
    { day: '2-digit', month: '2-digit', year: 'numeric' });

  const ventana = window.open('', '_blank');
  if (!ventana) return;

  ventana.document.write(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Fotos pedidas</title>
<style>
  * { box-sizing: border-box; }
  body { font: 12px/1.45 system-ui, sans-serif; color: #111; margin: 24px; }
  h1 { font-size: 17px; margin: 0 0 2px; }
  .apoyo { color: #666; font-size: 11px; margin: 0 0 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd;
           vertical-align: top; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
       color: #666; border-bottom: 1.5px solid #999; }
  .n { color: #888; width: 26px; }
  .tilde { width: 30px; }
  .tilde::after { content: ''; display: block; width: 15px; height: 15px;
                  border: 1.5px solid #999; border-radius: 3px; }
  tr { break-inside: avoid; }
  @page { margin: 14mm; }
</style></head>
<body>
  <h1>Fotos pedidas</h1>
  <p class="apoyo">${_lista.length} producto${_lista.length === 1 ? '' : 's'} · ${hoy}</p>
  <table>
    <thead><tr><th></th><th>Producto</th><th>Rubro</th><th>Foto</th><th>Hecho</th></tr></thead>
    <tbody>${filas}</tbody>
  </table>
</body></html>`);
  ventana.document.close();
  ventana.focus();
  ventana.print();
}
