/**
 * Catálogo de la tienda online.
 *
 * Desde acá se decide qué sale a la web y cómo se ve. Todo lo que se guarda son
 * campos `tienda_*` dentro del mismo producto del catálogo, así que el POS no
 * se entera de nada y el sync los respeta.
 *
 * La división es la que importa: el precio, el stock y las variedades salen del
 * catálogo del POS y no se editan acá — son los mismos números con los que se
 * cobra en el mostrador, y tener dos lugares donde cambiarlos termina con la
 * web vendiendo a un precio y la caja cobrando otro. Lo que se decide acá es la
 * vidriera: qué se publica, cómo se llama, con qué foto, si se ofrece el rollo
 * entero y qué colores se muestran.
 *
 * El estado de publicación se calcula con las mismas reglas que usa el sync
 * (`tienda_espejo.js`), no leyendo la tienda: leerla serían 2.300 lecturas cada
 * vez que se abre esta pantalla. Como cada cambio se espeja al instante, lo que
 * se ve acá es lo que hay publicado.
 */
import { collection, doc, getDoc, setDoc, getDocs, orderBy, query } from 'firebase/firestore';
import { getCached } from '../cache.js';
import { leerDocRapido } from '../config.js';
import { alertDialog, escHtml } from '../components/dialogs.js';
import {
  guardarYEspejar, motivoDeNoPublicar, medidasDe, nombreBonito, normalizar,
  subirFoto, borrarFoto,
} from '../tienda_espejo.js';
import '../styles/tienda.css';

const POR_TANDA = 60;

// Cada filtro es una lista para TRABAJAR, no un corte del catálogo entero: la
// pregunta que contesta esta pantalla es "qué le falta a la tienda", y para eso
// "sin foto" son los que ya están publicados y "sin stock" los que volverían
// solos con reponerlos. Los números al lado de cada uno evitan que la tarjeta
// de arriba y la lista de abajo parezcan contradecirse.
// Esta pantalla trabaja sobre lo que TIENE STOCK, que es lo único que puede
// estar en la vidriera. Un producto sin stock no se gestiona desde acá: cuando
// llega la mercadería y el POS le carga el stock, se publica solo. Tenerlos
// mezclados eran 6.600 renglones que nadie iba a tocar tapando los 500 que sí.
//
// Igual quedan a un clic en "Sin stock", para el caso de querer dejarle la foto
// y el nombre listos antes de que llegue.
const FILTROS = [
  { clave: 'todos',      texto: 'Con stock' },
  { clave: 'publicados', texto: 'En la tienda' },
  { clave: 'ocultos',    texto: 'Fuera de la tienda' },
  { clave: 'destacados', texto: 'Destacados' },
  { clave: 'sin_foto',   texto: 'Sin foto' },
  { clave: 'sin_stock',  texto: 'Sin stock' },
];

let _db = null;
let _productos = [];
let _rubrosHabilitados = [];
let _filtro = 'todos';
let _rubro = '';
let _busqueda = '';
let _mostrando = POR_TANDA;

/* ── Lectura del catálogo ─────────────────────────────────────────────────── */

/**
 * Lo que esta pantalla necesita de cada producto, ya masticado.
 *
 * Se calcula una vez y no en cada pintado: son casi ocho mil productos y
 * `medidasDe` recorre las variedades de cada uno.
 */
function preparar(datos, rubrosHabilitados) {
  const medidas = medidasDe(datos);
  const motivo = motivoDeNoPublicar(datos, rubrosHabilitados);
  const imagenes = Array.isArray(datos.tienda_imagenes) ? datos.tienda_imagenes.filter(Boolean) : [];

  return {
    id: datos.doc_id,
    datos,
    nombre: String(datos.tienda_nombre || '').trim() || nombreBonito(datos.nombre),
    nombreCatalogo: String(datos.nombre || ''),
    rubro: String(datos.rubro || '').trim().toUpperCase(),
    codigo: String(datos.codigo || ''),
    marca: String(datos.marca || '').trim(),
    interruptor: datos.tienda_publicar === true ? 'si'
               : datos.tienda_publicar === false ? 'no' : 'auto',
    destacado: datos.tienda_destacado === true,
    imagenes,
    medidas,
    motivo,
    publicado: motivo === null,
    buscable: normalizar([datos.nombre, datos.tienda_nombre, datos.marca, datos.codigo]
      .filter(Boolean).join(' ')),
  };
}

async function leerRubrosHabilitados(db) {
  return getCached('tienda:publicacion', async () => {
    // Cache-first: un getDoc suelto al server queda encolado detrás de los
    // listeners grandes del store, y este doc gatea el pintado de la pantalla.
    const datos = await leerDocRapido(doc(db, 'tienda_config', 'publicacion'),
                                      { etiqueta: 'tienda_config/publicacion', vacio: {} });
    const lista = datos?.rubros;
    return Array.isArray(lista) ? lista.map(r => String(r).trim().toUpperCase()) : [];
  }, { ttl: 60000, memOnly: true });
}

/* ── Pintado ──────────────────────────────────────────────────────────────── */

function pesos(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

function visibles() {
  const texto = normalizar(_busqueda.trim());

  return _productos.filter(p => {
    // Sin stock queda fuera de todo salvo de su propio filtro: no es parte del
    // mundo de la tienda hasta que llegue la mercadería.
    const conStock = p.medidas.stock > 0 || p.publicado;
    if (_filtro === 'sin_stock') {
      if (conStock) return false;
    } else if (!conStock) {
      return false;
    }
    if (_rubro && p.rubro !== _rubro) return false;
    if (_filtro === 'publicados' && !p.publicado) return false;
    if (_filtro === 'ocultos' && p.publicado) return false;
    if (_filtro === 'destacados' && !p.destacado) return false;
    // "Sin foto": los que ya están en la vidriera saliendo con el cuadrito
    // gris. Es la lista con la que alguien se sienta a sacar fotos.
    if (_filtro === 'sin_foto' && (p.imagenes.length || !p.publicado)) return false;
    if (texto && !p.buscable.includes(texto)) return false;
    return true;
  });
}

function fila(p) {
  const foto = p.imagenes[0]
    ? `<img class="tienda-foto" src="${escHtml(p.imagenes[0])}" alt="" loading="lazy">`
    : `<div class="tienda-foto tienda-foto--falta"><span class="material-icons">image_not_supported</span></div>`;

  const etiquetas = [];
  if (p.destacado) {
    etiquetas.push('<span class="tienda-etiqueta destacado"><span class="material-icons">star</span>Destacado</span>');
  }
  if (!p.imagenes.length) {
    etiquetas.push('<span class="tienda-etiqueta sinfoto">Sin foto</span>');
  }
  if (!p.publicado) {
    etiquetas.push(`<span class="tienda-etiqueta oculto">${escHtml(p.motivo)}</span>`);
  } else if (p.interruptor === 'si') {
    etiquetas.push('<span class="tienda-etiqueta publicado">Forzado</span>');
  }

  const variedades = p.medidas.variedades.length
    ? ` · ${p.medidas.variedades.length} variedades`
    : '';
  const pack = p.medidas.precio_pack
    ? ` · ${escHtml(p.medidas.pack_nombre)} ${pesos(p.medidas.precio_pack)}`
    : '';

  return `
    <div class="tienda-fila ${p.publicado ? '' : 'oculto'}" data-id="${escHtml(p.id)}">
      ${foto}
      <div style="min-width:0">
        <div class="tienda-nombre">${escHtml(p.nombre)}</div>
        <div class="tienda-sub">
          ${escHtml(p.rubro || 'sin rubro')}${escHtml(variedades)}${pack}
        </div>
        ${p.nombre !== nombreBonito(p.nombreCatalogo) ? `
          <div class="tienda-sub" style="display:flex;align-items:center;gap:3px">
            <span class="material-icons" style="font-size:12px">link</span>
            ${escHtml(p.nombreCatalogo)}
          </div>` : ''}
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px">${etiquetas.join('')}</div>
      </div>
      <div class="tienda-precio">
        ${pesos(p.medidas.precio)}
        <div class="tienda-sub" style="text-align:right">
          ${p.medidas.unidad === 'metro' ? 'por metro' : 'c/u'}
        </div>
      </div>
      <div class="tienda-stock ${p.medidas.stock > 0 ? '' : 'cero'}">
        ${p.medidas.stock > 0 ? `${p.medidas.stock} en stock` : 'sin stock'}
      </div>
      <div style="display:flex;justify-content:flex-end">
        <button class="tienda-switch" data-accion="interruptor"
                aria-checked="${p.publicado}" title="Publicar o sacar de la tienda"></button>
      </div>
    </div>`;
}

function pintarLista() {
  const caja = document.getElementById('tiendaLista');
  if (!caja) return;

  const lista = visibles();
  const tanda = lista.slice(0, _mostrando);

  if (!tanda.length) {
    caja.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">search_off</span>
        <p>Ningún producto coincide con el filtro.</p>
      </div>`;
    return;
  }

  caja.innerHTML = tanda.map(fila).join('')
    + (lista.length > tanda.length
        ? `<button class="pc-btn" id="tiendaMas" style="margin:6px auto;padding:10px 22px">
             Mostrar ${Math.min(POR_TANDA, lista.length - tanda.length)} más
             <span style="color:var(--text-muted);font-weight:500">
               (${lista.length - tanda.length} restantes)</span>
           </button>`
        : '');
}

function pintarResumen() {
  const caja = document.getElementById('tiendaResumen');
  if (!caja) return;

  const publicados = _productos.filter(p => p.publicado);
  const sinFoto = publicados.filter(p => !p.imagenes.length).length;
  const destacados = publicados.filter(p => p.destacado).length;
  const excluidos = _productos.filter(p => p.interruptor === 'no').length;

  const dato = (n, texto, alerta = false) => `
    <div class="tienda-dato ${alerta ? 'alerta' : ''}">
      <b>${n.toLocaleString('es-AR')}</b><span>${texto}</span>
    </div>`;

  caja.innerHTML = [
    dato(publicados.length, 'en la tienda'),
    dato(sinFoto, 'publicados sin foto', sinFoto > 0),
    dato(destacados, 'destacados', destacados === 0),
    dato(excluidos, 'sacados a mano'),
    dato(_productos.filter(p => p.medidas.stock > 0 || p.publicado).length, 'con stock'),
  ].join('');
}

/** Cuántos productos trae cada filtro, con el rubro y la búsqueda ya aplicados. */
function cuantosPor(clave) {
  const guardado = _filtro;
  _filtro = clave;
  const n = visibles().length;
  _filtro = guardado;
  return n;
}

function pintarContadores() {
  document.querySelectorAll('#tiendaFiltros [data-filtro]').forEach(boton => {
    boton.classList.toggle('active', boton.dataset.filtro === _filtro);
    // El número al lado de cada filtro evita la pregunta de "¿por qué acá dice
    // 220 y abajo 7.380?": se ve lo que va a traer antes de tocarlo.
    const texto = (FILTROS.find(f => f.clave === boton.dataset.filtro) || {}).texto || '';
    boton.innerHTML = `${escHtml(texto)} <span class="pc-btn__n">${
      cuantosPor(boton.dataset.filtro).toLocaleString('es-AR')}</span>`;
  });
}

/* ── Guardar ──────────────────────────────────────────────────────────────── */

/**
 * Guarda y vuelve a preparar el producto en memoria.
 *
 * No se recarga el catálogo entero: el store ya lo tiene y el snapshot va a
 * llegar solo. Se actualiza la fila para que el cambio se vea en el momento en
 * vez de esperar el rebote de Firestore.
 */
async function guardar(p, cambios) {
  const resultado = await guardarYEspejar(_db, p.id, cambios, _rubrosHabilitados);

  Object.entries(cambios).forEach(([clave, valor]) => {
    if (valor === undefined) delete p.datos[clave];
    else p.datos[clave] = valor;
  });

  const i = _productos.findIndex(x => x.id === p.id);
  if (i !== -1) _productos[i] = preparar(p.datos, _rubrosHabilitados);

  return resultado;
}

/* ── Avisos que ve el cliente ──────────────────────────────────────────────── */

/**
 * Los avisos son lo que el local necesita que el cliente lea ANTES de comprar:
 * "mercería no tiene cambio ni devolución", "las telas se cortan a pedido".
 *
 * Se cargan por rubro entero, que es como se piensan en el mostrador, y quedan
 * en un solo documento (`tienda_config/avisos`) que la tienda lee de una. Un
 * producto puede tener el suyo propio desde su editor, y ese le gana al del
 * rubro: lo específico manda.
 */
async function abrirAvisos(db, rubros) {
  const ref = doc(db, 'tienda_config', 'avisos');
  let guardados = { rubros: {}, subrubros: {} };
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const d = snap.data() || {};
      guardados = {
        rubros: d.rubros && typeof d.rubros === 'object' ? d.rubros : {},
        subrubros: d.subrubros && typeof d.subrubros === 'object' ? d.subrubros : {},
      };
    }
  } catch (e) {
    console.warn('avisos: no se pudieron leer', e?.message || e);
  }

  document.querySelector('.avisos-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay avisos-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:640px;width:100%">
      <div class="modal-header">
        <h3 style="margin:0;font-size:16px">Avisos para el cliente</h3>
        <button class="avisos-cerrar" style="background:none;border:none;cursor:pointer;color:var(--text-muted)">
          <span class="material-icons">close</span>
        </button>
      </div>
      <div style="padding:0 20px 8px;color:var(--text-muted);font-size:12.5px;line-height:1.5">
        Lo que escribas acá aparece en la ficha de cada producto del rubro, arriba
        del botón de agregar, y en el pedido. Dejalo vacío para no mostrar nada.
      </div>
      <div style="padding:8px 20px 20px;max-height:56vh;overflow:auto;display:flex;flex-direction:column;gap:12px">
        ${rubros.map(r => `
          <label style="display:block">
            <span style="font-size:12px;font-weight:700;color:var(--text-muted);
                         text-transform:uppercase;letter-spacing:.4px">${escHtml(nombreBonito(r))}</span>
            <input type="text" data-aviso-rubro="${escHtml(r)}" maxlength="160"
                   value="${escHtml(guardados.rubros?.[r] || '')}"
                   placeholder="Sin aviso"
                   style="width:100%;margin-top:4px;padding:9px 11px;border:1.5px solid var(--border);
                          border-radius:8px;font-size:13px;box-sizing:border-box">
          </label>`).join('')}
      </div>
      <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;
                  justify-content:flex-end;gap:8px;background:var(--surface-2)">
        <button class="pc-btn avisos-cancelar">Cancelar</button>
        <button class="btn-primary avisos-guardar">Guardar avisos</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const cerrar = () => overlay.remove();
  overlay.querySelector('.avisos-cerrar').addEventListener('click', cerrar);
  overlay.querySelector('.avisos-cancelar').addEventListener('click', cerrar);
  overlay.addEventListener('click', ev => { if (ev.target === overlay) cerrar(); });

  overlay.querySelector('.avisos-guardar').addEventListener('click', async ev => {
    const boton = ev.currentTarget;
    boton.disabled = true;
    boton.textContent = 'Guardando…';
    const nuevos = {};
    overlay.querySelectorAll('[data-aviso-rubro]').forEach(inp => {
      const texto = inp.value.trim();
      if (texto) nuevos[inp.dataset.avisoRubro] = texto;
    });
    try {
      await setDoc(ref, { rubros: nuevos, subrubros: guardados.subrubros || {} }, { merge: true });
      cerrar();
      avisar(`${Object.keys(nuevos).length} rubro(s) con aviso`);
    } catch (e) {
      boton.disabled = false;
      boton.textContent = 'Guardar avisos';
      alertDialog({ title: 'No se pudo guardar', message: escHtml(e?.message || String(e)), type: 'error' });
    }
  });
}

/* ── Editor ───────────────────────────────────────────────────────────────── */

function abrirEditor(p) {
  const m = p.medidas;
  const ajustes = (p.datos.tienda_variedades && typeof p.datos.tienda_variedades === 'object')
    ? { ...p.datos.tienda_variedades } : {};

  // Las variedades salen del catálogo del POS, con el nombre tal cual lo
  // cargaron ahí. Lo que se edita es si se publican y cómo se llaman.
  const colores = (Array.isArray(p.datos.conjunto_colores) ? p.datos.conjunto_colores : [])
    .filter(c => c && String(c.color || '').trim())
    .map(c => {
      const original = String(c.color).trim();
      const contenido = Number(p.datos.conjunto_contenido) || 0;
      return {
        original,
        clave: normalizar(original),
        stock: Math.max(0, Math.trunc((Number(c.unidades) || 0) * contenido + (Number(c.restante) || 0))),
        precio: Number(c.precio) || null,
      };
    });

  let imagenes = p.imagenes.slice();

  const overlay = document.createElement('div');
  overlay.className = 'tienda-overlay';
  overlay.innerHTML = `
    <div class="tienda-editor" role="dialog" aria-modal="true">
      <header>
        <div style="min-width:0;flex:1">
          <h3>${escHtml(p.nombre)}</h3>
          <p>
            Publicación de
            <button class="tienda-vinculo" data-abrir-catalogo
                    title="Abrir este producto en el catálogo general">
              <span class="material-icons">open_in_new</span>
              ${escHtml(p.nombreCatalogo)}
            </button>
            ${p.codigo ? ` · código ${escHtml(p.codigo)}` : ''}
            ${p.marca ? ` · ${escHtml(p.marca)}` : ''}
          </p>
        </div>
        <button class="pc-btn" data-cerrar style="padding:6px 10px">
          <span class="material-icons">close</span>
        </button>
      </header>

      <div class="cuerpo">
        <div id="edBanner"></div>
        <div class="tienda-columnas">

        <div class="tienda-bloque">
          <h4>En la tienda</h4>
          <div class="tienda-opciones" id="edPublicar">
            <button class="tienda-opcion" data-valor="auto">Según el rubro</button>
            <button class="tienda-opcion" data-valor="si">Publicar siempre</button>
            <button class="tienda-opcion" data-valor="no">No publicar</button>
          </div>
          <label style="display:flex;align-items:center;gap:9px;margin-top:12px;cursor:pointer;font-size:13.5px">
            <input type="checkbox" id="edDestacado" ${p.destacado ? 'checked' : ''}
                   style="width:17px;height:17px;cursor:pointer">
            Mostrar en la portada, entre los destacados
          </label>
        </div>

        <div class="tienda-bloque">
          <h4>Cómo se ve</h4>
          <div class="tienda-campo">
            <label>Nombre público</label>
            <input type="text" id="edNombre" maxlength="90"
                   value="${escHtml(String(p.datos.tienda_nombre || ''))}"
                   placeholder="${escHtml(nombreBonito(p.nombreCatalogo))}">
          </div>
          <div class="tienda-campo">
            <label>Descripción</label>
            <textarea id="edDescripcion" maxlength="600"
              placeholder="Para qué sirve, qué medida tiene, qué trae. Se lee abajo del precio.">${escHtml(String(p.datos.tienda_descripcion || ''))}</textarea>
          </div>
          <div class="tienda-campo">
            <label>Aviso antes de comprar</label>
            <input type="text" id="edAvisoTexto" maxlength="160"
              value="${escHtml(String(p.datos.tienda_aviso || ''))}"
              placeholder="Sin cambio ni devolución · Se corta a pedido">
            <div class="tienda-pista">Vacío usa el aviso del rubro.</div>
          </div>
        </div>

        <div class="tienda-bloque">
          <h4>Fotos</h4>
          <div class="tienda-fotos" id="edFotos"></div>
          <div class="tienda-pista" id="edFotosPista">
            La primera es la que se ve en el listado. Se guardan al instante.
          </div>
          <input type="file" id="edArchivo" accept="image/*" multiple hidden>
        </div>

        </div>

        <div class="tienda-bloque">
          <h4>Cómo se vende</h4>
          <div class="tienda-dos">
            <div class="tienda-campo">
              <label>Se vende por</label>
              <select id="edUnidad">
                <option value="">Como dice el POS (${m.unidad === 'metro' ? 'metro' : 'unidad'})</option>
                <option value="unidad">Unidad</option>
                <option value="metro">Metro</option>
              </select>
            </div>
            <div class="tienda-campo">
              <label>Ofrecer el pack entero</label>
              <select id="edPack">
                <option value="">Automático</option>
                <option value="si">Sí</option>
                <option value="no">No</option>
              </select>
            </div>
          </div>
          <div class="tienda-campo" id="edPackNombreCampo">
            <label>Cómo se llama el pack</label>
            <input type="text" id="edPackNombre" maxlength="40"
                   value="${escHtml(String(p.datos.tienda_pack_nombre || ''))}"
                   placeholder="${escHtml(nombreBonito(String(p.datos.conjunto_tipo || 'pack')))}">
          </div>

          <div class="tienda-dos">
            <div class="tienda-campo">
              <label>Mínimo que se puede llevar</label>
              <input type="number" id="edMinimo" min="0" step="0.5"
                     value="${escHtml(String(p.datos.tienda_minimo ?? ''))}"
                     placeholder="${m.unidad === 'metro' ? '0,5' : '1'}">
            </div>
            <div class="tienda-campo">
              <label>De a cuánto sube</label>
              <input type="number" id="edPaso" min="0" step="0.5"
                     value="${escHtml(String(p.datos.tienda_paso ?? ''))}"
                     placeholder="${m.unidad === 'metro' ? '0,5' : '1'}">
            </div>
          </div>
          <div class="tienda-pista" id="edMinimoPista"></div>
          <div class="tienda-pista">
            ${m.precio_pack
              ? `Hoy se ofrece el ${escHtml((m.pack_nombre || '').toLowerCase())} de
                 ${m.pack_contenido} a ${pesos(m.precio_pack)}, además de
                 ${pesos(m.precio)} ${m.unidad === 'metro' ? 'el metro' : 'la unidad'}.`
              : `Hoy se vende solo por ${m.unidad === 'metro' ? 'metro' : 'unidad'},
                 a ${pesos(m.precio)}.`}
            El precio y el stock salen del catálogo del POS; acá no se tocan.
          </div>
        </div>

        ${colores.length ? `
        <div class="tienda-bloque">
          <h4>Variedades</h4>
          <div id="edVariedades"></div>
          <div class="tienda-pista">
            Las que se apaguen no salen en la tienda y su stock no cuenta para el
            total publicado. El nombre en blanco usa el del catálogo.
          </div>
        </div>` : ''}
      </div>

      <footer>
        <span id="edEstado" style="margin-right:auto;font-size:12.5px;color:var(--text-muted)"></span>
        <button class="pc-btn" data-cerrar style="padding:9px 16px">Cancelar</button>
        <button class="pc-btn" id="edGuardar"
                style="padding:9px 20px;background:#4361ee;color:#fff;border-color:#4361ee">
          Guardar cambios
        </button>
      </footer>
    </div>`;

  document.body.appendChild(overlay);

  const $ = sel => overlay.querySelector(sel);
  const estado = $('#edEstado');

  /* ── Estado de publicación ── */
  let interruptor = p.interruptor;

  function pintarPublicar() {
    $('#edPublicar').querySelectorAll('[data-valor]').forEach(boton => {
      boton.setAttribute('aria-pressed', String(boton.dataset.valor === interruptor));
    });

    // El aviso dice qué pasa de verdad, que no siempre es lo que dice el
    // interruptor: "publicar siempre" no publica nada si el producto no tiene
    // stock, y sin decirlo el panel parece roto.
    const simulado = {
      ...p.datos,
      tienda_publicar: interruptor === 'si' ? true : interruptor === 'no' ? false : undefined,
    };
    const motivo = motivoDeNoPublicar(simulado, _rubrosHabilitados);
    $('#edBanner').innerHTML = motivo
      ? `<div class="tienda-aviso freno">
           <span class="material-icons">visibility_off</span>
           <div>No está en la tienda: <b>${escHtml(motivo)}</b>.
           ${motivo === 'sin stock'
             ? ' Vuelve sola apenas entre mercadería.'
             : motivo === 'el rubro no está habilitado'
               ? ' Se puede forzar con "Publicar siempre", o habilitar el rubro entero en la configuración.'
               : ''}</div>
         </div>`
      : `<div class="tienda-aviso ok">
           <span class="material-icons">storefront</span>
           <div>Se está mostrando en la tienda.</div>
         </div>`;
  }

  $('#edPublicar').addEventListener('click', ev => {
    const boton = ev.target.closest('[data-valor]');
    if (!boton) return;
    interruptor = boton.dataset.valor;
    pintarPublicar();
  });

  /* ── Forma de venta ── */
  $('#edUnidad').value = String(p.datos.tienda_unidad || '');
  $('#edPack').value = p.datos.tienda_ofrecer_pack === true ? 'si'
                     : p.datos.tienda_ofrecer_pack === false ? 'no' : '';

  function pintarPackNombre() {
    // Sin pack que ofrecer, ponerle nombre no significa nada.
    const hay = $('#edPack').value !== 'no'
      && (m.precio_pack || $('#edPack').value === 'si');
    $('#edPackNombreCampo').style.display = hay ? '' : 'none';
  }
  $('#edPack').addEventListener('change', pintarPackNombre);
  pintarPackNombre();

  /* ── De a cuánto se vende ── */
  // Un pedido online cuesta el mismo trabajo valga $500 o $50.000: leerlo,
  // buscar la cosa entre miles, embalarla, despacharla. Hay productos que en el
  // mostrador se llevan de a uno y por la web no pagan ni el minuto de ir a
  // buscarlos. Acá se ve en pesos cuánto deja el mínimo elegido, que es la
  // única forma de decidirlo sin adivinar.
  function pintarMinimo() {
    const unidad = $('#edUnidad').value || m.unidad;
    const natural = unidad === 'metro' ? 0.5 : 1;
    const paso = Number($('#edPaso').value) > 0 ? Number($('#edPaso').value) : natural;
    let minimo = Number($('#edMinimo').value) > 0 ? Number($('#edMinimo').value) : paso;
    if (minimo % paso) minimo = Math.ceil(minimo / paso) * paso;

    const comoSeVende = unidad === 'metro'
      ? `desde ${String(minimo).replace('.', ',')} m, de a ${String(paso).replace('.', ',')} m`
      : `desde ${minimo} ${minimo === 1 ? 'unidad' : 'unidades'}` +
        (paso > 1 ? `, de a ${paso}` : '');

    const ajustado = Number($('#edMinimo').value) > 0 && minimo !== Number($('#edMinimo').value)
      ? ` El mínimo se subió a ${String(minimo).replace('.', ',')} para que caiga justo en un paso.`
      : '';

    $('#edMinimoPista').innerHTML =
      `Se vende ${escHtml(comoSeVende)}: el renglón más chico queda en
       <b>${pesos(m.precio * minimo)}</b>.${escHtml(ajustado)}
       ${p.medidas.stock < minimo
         ? '<b style="color:var(--tint-red-fg)"> No hay stock suficiente para ese mínimo:'
           + ' el producto no se va a poder comprar.</b>' : ''}
       En blanco queda como siempre: de a ${unidad === 'metro' ? 'medio metro' : 'uno'}.`;
  }
  ['#edMinimo', '#edPaso', '#edUnidad'].forEach(sel =>
    $(sel).addEventListener('input', pintarMinimo));
  $('#edUnidad').addEventListener('change', pintarMinimo);
  pintarMinimo();

  /* ── Fotos ── */
  function pintarFotos() {
    $('#edFotos').innerHTML = imagenes.map((url, i) => `
      <div class="tienda-foto-item">
        <img src="${escHtml(url)}" alt="" loading="lazy">
        ${i === 0 ? '<span class="principal">PRINCIPAL</span>' : ''}
        <div class="tienda-foto-acciones">
          ${i > 0 ? `<button data-foto="principal" data-i="${i}" title="Poner de principal">
                       <span class="material-icons">arrow_upward</span></button>` : ''}
          <button data-foto="borrar" data-i="${i}" title="Borrar">
            <span class="material-icons">delete</span></button>
        </div>
      </div>`).join('')
      + `<button class="tienda-subir" data-foto="agregar">
           <span class="material-icons">add_photo_alternate</span> Agregar
         </button>`;
  }
  pintarFotos();

  async function guardarFotos(mensaje) {
    $('#edFotosPista').textContent = 'Guardando…';
    try {
      await guardar(p, { tienda_imagenes: imagenes });
      p.imagenes = imagenes.slice();
      $('#edFotosPista').textContent = mensaje;
      refrescar();
    } catch (err) {
      console.error('[tienda] fotos:', err);
      $('#edFotosPista').textContent = 'No se pudo guardar. Probá de nuevo.';
    }
  }

  $('#edFotos').addEventListener('click', async ev => {
    const boton = ev.target.closest('[data-foto]');
    if (!boton) return;
    const i = Number(boton.dataset.i);

    if (boton.dataset.foto === 'agregar') { $('#edArchivo').click(); return; }

    if (boton.dataset.foto === 'principal') {
      const [movida] = imagenes.splice(i, 1);
      imagenes.unshift(movida);
      pintarFotos();
      await guardarFotos('Listo, esa es la principal.');
      return;
    }

    if (boton.dataset.foto === 'borrar') {
      const url = imagenes[i];
      imagenes.splice(i, 1);
      pintarFotos();
      await guardarFotos('Foto borrada.');
      // Recién se saca de Storage cuando el producto ya no la referencia: al
      // revés, un fallo al guardar deja el producto apuntando a una foto que
      // ya no existe.
      borrarFoto(url);
    }
  });

  $('#edArchivo').addEventListener('change', async ev => {
    const archivos = Array.from(ev.target.files || []);
    ev.target.value = '';
    if (!archivos.length) return;

    for (const [i, archivo] of archivos.entries()) {
      $('#edFotosPista').textContent = archivos.length > 1
        ? `Subiendo ${i + 1} de ${archivos.length}…` : 'Subiendo…';
      try {
        const url = await subirFoto(p.id, archivo,
          { alProgreso: t => { $('#edFotosPista').textContent = t; } });
        imagenes.push(url);
        pintarFotos();
      } catch (err) {
        console.error('[tienda] subida:', err);
        $('#edFotosPista').textContent = `No se pudo subir ${archivo.name}: ${err.message}`;
        return;
      }
    }
    await guardarFotos(archivos.length > 1 ? 'Fotos agregadas.' : 'Foto agregada.');
  });

  /* ── Variedades ── */
  function pintarVariedades() {
    const caja = $('#edVariedades');
    if (!caja) return;
    caja.innerHTML = colores.map(c => {
      const ajuste = ajustes[c.clave] || {};
      const publicada = ajuste.publicar !== false;
      return `
        <div class="tienda-variedad ${publicada ? '' : 'apagada'}" data-clave="${escHtml(c.clave)}">
          <button class="tienda-switch" style="width:36px;height:21px" data-variedad="interruptor"
                  aria-checked="${publicada}"></button>
          <div>
            <div class="original">${escHtml(nombreBonito(c.original))}</div>
            <div class="datos">
              ${c.stock > 0 ? `${c.stock} en stock` : 'sin stock'}${c.precio ? ` · ${pesos(c.precio)}` : ''}
            </div>
          </div>
          <input type="text" data-variedad="nombre" maxlength="40"
                 value="${escHtml(String(ajuste.nombre || ''))}"
                 placeholder="${escHtml(nombreBonito(c.original))}">
          <div class="datos" style="text-align:right">
            ${publicada ? 'se muestra' : 'oculta'}
          </div>
        </div>`;
    }).join('');
  }
  pintarVariedades();

  $('#edVariedades')?.addEventListener('click', ev => {
    const boton = ev.target.closest('[data-variedad="interruptor"]');
    if (!boton) return;
    const clave = boton.closest('[data-clave]').dataset.clave;
    const ajuste = ajustes[clave] || {};
    ajustes[clave] = { ...ajuste, publicar: ajuste.publicar === false };
    pintarVariedades();
  });

  $('#edVariedades')?.addEventListener('input', ev => {
    const campo = ev.target.closest('[data-variedad="nombre"]');
    if (!campo) return;
    const clave = campo.closest('[data-clave]').dataset.clave;
    ajustes[clave] = { ...(ajustes[clave] || {}), nombre: campo.value.trim() };
  });

  /* ── Cerrar y guardar ── */
  const cerrar = () => { overlay.remove(); document.removeEventListener('keydown', alTeclado); };
  const alTeclado = ev => { if (ev.key === 'Escape') cerrar(); };
  document.addEventListener('keydown', alTeclado);

  // Precio, stock, variedades y nombre interno se editan en el catálogo
  // general, que es donde vive el producto de verdad. Desde acá se salta con el
  // editor de ese producto ya abierto, y se vuelve con un botón sin perder
  // dónde estabas.
  overlay.querySelector('[data-abrir-catalogo]')?.addEventListener('click', () => {
    window.__pendingCatalogoOpen = p.id;
    window.__catalogoVolverA = 'tienda_catalogo';
    cerrar();
    window.navigateToPage?.('catalogo');
  });

  overlay.addEventListener('click', ev => {
    if (ev.target === overlay || ev.target.closest('[data-cerrar]')) cerrar();
  });

  $('#edGuardar').addEventListener('click', async () => {
    const boton = $('#edGuardar');
    boton.disabled = true;
    estado.textContent = 'Guardando…';

    // Las variedades sin nada que decir no se guardan: un mapa lleno de
    // entradas vacías engorda el documento y no cambia nada.
    const limpias = {};
    for (const [clave, ajuste] of Object.entries(ajustes)) {
      const nombre = String(ajuste?.nombre || '').trim();
      const oculta = ajuste?.publicar === false;
      if (nombre || oculta) limpias[clave] = { publicar: !oculta, nombre: nombre || null };
    }

    const nombre = $('#edNombre').value.trim();
    const descripcion = $('#edDescripcion').value.trim();
    const packNombre = $('#edPackNombre').value.trim();
    const unidad = $('#edUnidad').value;
    const pack = $('#edPack').value;
    const minimo = Number($('#edMinimo').value) || 0;
    const paso = Number($('#edPaso').value) || 0;

    try {
      const { publicado, motivo } = await guardar(p, {
        tienda_publicar: interruptor === 'si' ? true : interruptor === 'no' ? false : undefined,
        tienda_destacado: $('#edDestacado').checked ? true : undefined,
        tienda_nombre: nombre || undefined,
        tienda_descripcion: descripcion || undefined,
        tienda_aviso: ($('#edAvisoTexto').value || '').trim() || undefined,
        tienda_unidad: unidad || undefined,
        tienda_ofrecer_pack: pack === 'si' ? true : pack === 'no' ? false : undefined,
        tienda_pack_nombre: packNombre || undefined,
        tienda_minimo: minimo > 0 ? minimo : undefined,
        tienda_paso: paso > 0 ? paso : undefined,
        tienda_variedades: Object.keys(limpias).length ? limpias : undefined,
      });

      cerrar();
      refrescar();
      avisar(publicado
        ? 'Guardado. Ya se ve en la tienda.'
        : `Guardado. No se publica: ${motivo}.`);
    } catch (err) {
      console.error('[tienda] guardar:', err);
      boton.disabled = false;
      estado.textContent = 'No se pudo guardar.';
      alertDialog({ title: 'No se pudo guardar', message: String(err?.message || err) });
    }
  });

  pintarPublicar();
  $('#edNombre').focus();
}

/* ── Avisos ───────────────────────────────────────────────────────────────── */

let _avisoTimer = null;

function avisar(texto) {
  const caja = document.getElementById('tiendaAviso');
  if (!caja) return;
  caja.textContent = texto;
  caja.style.opacity = '1';
  clearTimeout(_avisoTimer);
  _avisoTimer = setTimeout(() => { caja.style.opacity = '0'; }, 4000);
}

function refrescar() {
  pintarResumen();
  pintarLista();
}

/* ── Entrada ──────────────────────────────────────────────────────────────── */

export async function renderTiendaCatalogo(container, db) {
  _db = db;
  _mostrando = POR_TANDA;

  container.innerHTML = `
    <div class="tienda-resumen" id="tiendaResumen">
      ${Array(5).fill('<div class="skel skel-card" style="height:64px"></div>').join('')}
    </div>

    <div class="filter-bar" id="tiendaFiltros" style="margin-bottom:14px;flex-wrap:wrap;gap:8px;align-items:center">
      ${FILTROS.map(f => `<button class="pc-btn" data-filtro="${f.clave}">${f.texto}</button>`).join('')}
      <select id="tiendaRubro" style="min-width:150px"><option value="">Todos los rubros</option></select>
      <input type="text" id="tiendaBuscar" placeholder="Nombre, marca o código…"
             style="flex:1;min-width:200px;max-width:320px">
      <button class="pc-btn" id="tiendaAvisos" title="Avisos que ve el cliente antes de comprar">
        <span class="material-icons" style="font-size:16px;vertical-align:-3px">campaign</span>
        Avisos
      </button>
      <span id="tiendaAviso" style="font-size:12.5px;color:var(--tint-green-fg);font-weight:600;
                                    opacity:0;transition:opacity .2s"></span>
    </div>

    <div id="tiendaLista" style="display:flex;flex-direction:column;gap:8px">
      ${Array(8).fill('<div class="skel skel-card" style="height:72px"></div>').join('')}
    </div>`;

  // `catalogo:all` lo mantiene vivo el store; el fetcher es el plan B para
  // cuando todavía no llegó el primer snapshot.
  const [catalogo, habilitados] = await Promise.all([
    getCached('catalogo:all', async () => {
      const snap = await getDocs(query(collection(db, 'catalogo'), orderBy('nombre')));
      return snap.docs.map(d => ({ ...d.data(), doc_id: d.id }));
    }, { ttl: 10 * 60 * 1000, memOnly: true }),
    leerRubrosHabilitados(db),
  ]);

  _rubrosHabilitados = habilitados;
  _productos = (catalogo || [])
    .filter(d => d && d.doc_id)
    // Documentos viejos guardaron un `doc_id` numérico que pisa el de
    // Firestore; el resto del panel lo normaliza igual.
    .map(d => preparar(typeof d.doc_id === 'string' ? d : { ...d, doc_id: String(d.doc_id) },
                       habilitados))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  // El rubro se elige de los que existen de verdad en el catálogo, no de una
  // lista fija: los rubros los inventa quien carga los productos en el POS.
  const rubros = [...new Set(_productos.map(p => p.rubro).filter(Boolean))].sort();
  const selector = document.getElementById('tiendaRubro');
  selector.innerHTML = '<option value="">Todos los rubros</option>'
    + rubros.map(r => {
        const n = _productos.filter(p => p.rubro === r).length;
        const marca = habilitados.includes(r) ? '' : ' (fuera de la tienda)';
        return `<option value="${escHtml(r)}">${escHtml(nombreBonito(r))} · ${n}${marca}</option>`;
      }).join('');

  refrescar();
  pintarContadores();

  /* ── Eventos ── */
  document.getElementById('tiendaFiltros').addEventListener('click', ev => {
    const boton = ev.target.closest('[data-filtro]');
    if (!boton) return;
    _filtro = boton.dataset.filtro;
    _mostrando = POR_TANDA;
    pintarContadores();
    pintarLista();
  });

  selector.addEventListener('change', () => {
    _rubro = selector.value;
    _mostrando = POR_TANDA;
    pintarLista();
  });

  document.getElementById('tiendaAvisos').addEventListener('click', () => {
    abrirAvisos(db, rubros);
  });

  const buscador = document.getElementById('tiendaBuscar');
  buscador.addEventListener('input', () => {
    _busqueda = buscador.value;
    _mostrando = POR_TANDA;
    pintarLista();
  });

  document.getElementById('tiendaLista').addEventListener('click', async ev => {
    if (ev.target.closest('#tiendaMas')) {
      _mostrando += POR_TANDA;
      pintarLista();
      return;
    }

    const filaEl = ev.target.closest('[data-id]');
    if (!filaEl) return;
    const p = _productos.find(x => x.id === filaEl.dataset.id);
    if (!p) return;

    const interruptor = ev.target.closest('[data-accion="interruptor"]');
    if (!interruptor) { abrirEditor(p); return; }

    // El interruptor de la fila es el atajo: publicar o sacar sin abrir nada.
    // Sacar algo que no está publicado por otro motivo (sin stock) no tiene
    // sentido, así que ahí se abre el editor y se explica.
    if (!p.publicado && p.motivo !== 'excluido a mano'
        && p.motivo !== 'el rubro no está habilitado') {
      abrirEditor(p);
      return;
    }

    interruptor.disabled = true;
    try {
      const { publicado, motivo } = await guardar(p, {
        tienda_publicar: p.publicado ? false : true,
      });
      refrescar();
      avisar(publicado ? 'Publicado.' : `Fuera de la tienda${motivo ? `: ${motivo}` : ''}.`);
    } catch (err) {
      console.error('[tienda] interruptor:', err);
      interruptor.disabled = false;
      alertDialog({ title: 'No se pudo guardar', message: String(err?.message || err) });
    }
  });
}
