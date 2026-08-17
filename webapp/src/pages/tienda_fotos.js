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
 * "Cargar" o "Cambiar" abren el panel de fotos del producto: las que ya tiene
 * y las que se acaban de elegir, juntas, para decidir cuál es la portada, en
 * qué orden van, cuáles se sacan y agregar más. Nada se sube ni se toca hasta
 * "Guardar": recién ahí se suben las nuevas ya achicadas, se guarda la lista en
 * el producto (que reescribe el espejo público en el momento) y se saca al
 * producto de esta lista. Si algo falla en el medio, el producto sigue
 * pendiente: es preferible que aparezca de más y no que se pierda.
 */
import { collection, deleteDoc, doc, getDocs, orderBy, query } from 'firebase/firestore';
import { getCached } from '../cache.js';
import { leerDocRapido } from '../config.js';
import { confirmDialog, escHtml, verFotoGrande } from '../components/dialogs.js';
import {
  guardarYEspejar, imagenesDe, motivoDeNoPublicar, nombreBonito, subirFoto, borrarFoto,
} from '../tienda_espejo.js';
import {
  ponerDePortada, moverFoto, desvincularFoto, limpiarAjustes, fotosQuitadas,
} from '../tienda_galeria.js';
import '../styles/tienda.css';

let _db = null;
let _lista = [];
let _esperando = [];
let _catalogo = new Map();      // doc_id -> datos del catálogo
let _habilitados = [];
let _subExcluidos = {};
let _subiendo = false;          // un guardado por vez: el input es uno solo
let _panel = null;              // el panel de fotos abierto, si hay uno

export async function renderTiendaFotos(container, db) {
  _db = db;

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;
                gap:16px;flex-wrap:wrap;margin-bottom:16px">
      <div style="min-width:260px;flex:1">
        <h2 style="margin:0">Fotos pedidas</h2>
        <p class="tienda-pista" style="margin:6px 0 0">
          Todo lo que está en la vidriera sin foto entra solo a esta lista, más
          lo que se haya marcado desde la tienda. Cargá la foto acá mismo: al
          subirla, el producto sale de la lista y la tienda se actualiza.
        </p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="pc-btn" id="fotosImprimir">
          <span class="material-icons">print</span> Imprimir
        </button>
        <button class="pc-btn" id="fotosRefrescar">
          <span class="material-icons">refresh</span> Actualizar
        </button>
      </div>
    </div>

    <input type="file" id="fotosArchivo" accept="image/*" multiple hidden>
    <div id="fotosCuerpo"><div class="tienda-pista">Cargando…</div></div>`;

  document.getElementById('fotosRefrescar').addEventListener('click', cargar);
  document.getElementById('fotosImprimir').addEventListener('click', imprimir);
  document.getElementById('fotosArchivo').addEventListener('change', alElegirArchivo);

  await cargar();
}

/* ── Lectura ──────────────────────────────────────────────────────────────── */

async function cargar() {
  const cuerpo = document.getElementById('fotosCuerpo');
  if (!cuerpo) return;

  try {
    // Las tres cosas a la vez: la lista, el catálogo (para la foto que tiene
    // hoy) y qué se publica (para no despublicar sin querer al guardar).
    const [docs, catalogo, publicacion] = await Promise.all([
      traerPedidas(),
      getCached('catalogo:all', async () => {
        const snap = await getDocs(query(collection(_db, 'catalogo'), orderBy('nombre')));
        return snap.docs.map(d => ({ ...d.data(), doc_id: d.id }));
      }, { ttl: 10 * 60 * 1000, memOnly: true }),
      leerDocRapido(doc(_db, 'tienda_config', 'publicacion'),
                    { etiqueta: 'tienda_config/publicacion', vacio: {} }),
    ]);

    _catalogo = new Map((catalogo || []).map(d => [String(d.doc_id), d]));
    _habilitados = Array.isArray(publicacion?.rubros)
      ? publicacion.rubros.map(r => String(r).trim().toUpperCase()) : [];
    _subExcluidos = publicacion?.subrubros_excluidos || {};

    _lista = docs.map(d => {
      const v = d.data() || {};
      const producto = _catalogo.get(d.id);
      return {
        id: d.id,
        nombre: v.nombre || producto?.nombre || '(sin nombre)',
        rubro: v.rubro || producto?.rubro || '',
        teniaFoto: v.tenia_foto === true,
        cuando: v.pedido_en?.toDate?.() || null,
        // Lo que hoy se ve en la tienda. Es lo que hay que reemplazar, así que
        // conviene tenerlo a la vista mientras se elige la nueva.
        fotos: imagenesDe(producto),
        enCatalogo: Boolean(producto),
      };
    }).sort((a, b) => (b.cuando?.getTime() || 0) - (a.cuando?.getTime() || 0));

    // Los que YA están en la vidriera sin foto entran solos a la lista. Antes
    // dependían de que alguien los marcara desde la tienda: mientras tanto se
    // veían igual, con el cuadrito gris, para cualquiera que entrara a comprar.
    // No se pisan los pedidos a mano — esos ya están arriba con su fecha.
    const yaEstan = new Set(_lista.map(x => x.id));
    const automaticos = [];
    for (const [id, producto] of _catalogo) {
      if (yaEstan.has(id)) continue;
      if (imagenesDe(producto).length) continue;
      // Los frenados JUSTO por la foto: todo lo demás está en orden y salen a la
      // vidriera en cuanto se les cargue una.
      if (motivoDeNoPublicar(producto, _habilitados, _subExcluidos) !== 'sin foto') continue;
      automaticos.push({
        id,
        nombre: producto.nombre || '(sin nombre)',
        rubro: producto.rubro || '',
        teniaFoto: false,
        cuando: null,
        fotos: [],
        enCatalogo: true,
        automatico: true,
      });
    }
    automaticos.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
    // Separadas a propósito: una es la lista que armó el personal a mano y la
    // otra la que arma el sistema. Mezcladas, lo pedido puntualmente se perdía
    // entre doscientos renglones automáticos.
    _esperando = automaticos;

    pintarLista();
  } catch (err) {
    console.error('[fotos] no se pudo leer la lista:', err);
    cuerpo.innerHTML = `
      <div class="tienda-pista" style="color:var(--tint-red-fg)">
        No se pudo leer la lista: ${escHtml(err?.message || String(err))}
      </div>`;
  }
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

/* ── Pintado ──────────────────────────────────────────────────────────────── */

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

  const sinFoto = _lista.filter(f => !f.fotos.length).length;

  const tabla = (titulo, bajada, filas, id) => !filas.length ? '' : `
    <h3 style="margin:22px 0 8px;font-size:15px">${escHtml(titulo)}
      <span style="color:var(--text-muted);font-weight:400">· ${filas.length}</span>
    </h3>
    <p class="tienda-pista" style="margin:0 0 10px">${escHtml(bajada)}</p>
    <table class="tienda-tabla" id="${id}">
      <thead>
        <tr>
          <th style="width:54px">Foto</th>
          <th>Producto</th>
          <th style="width:140px">Rubro</th>
          <th style="width:112px">Marcado</th>
          <th style="width:210px" data-no-imprimir></th>
        </tr>
      </thead>
      <tbody>${filas.map(f => filaHtml(f)).join('')}</tbody>
    </table>`;

  cuerpo.innerHTML = `
    <div class="tienda-resumen">
      <div class="tienda-dato">
        <b>${_lista.length}</b><span>pedidas a mano</span>
      </div>
      <div class="tienda-dato${_esperando.length ? ' alerta' : ''}">
        <b>${_esperando.length}</b><span>esperando foto para salir</span>
      </div>
      <div class="tienda-dato">
        <b>${_lista.length - sinFoto}</b><span>con foto a reemplazar</span>
      </div>
    </div>

    ${tabla('Pedidas a mano',
            'Lo que se marcó desde la tienda, con su fecha.',
            _lista, 'fotosTabla')}

    ${tabla('Esperando foto para salir a la vidriera',
            'Tienen stock y todo lo demás en orden: se publican solos apenas se '
            + 'les carga una foto. Hasta entonces no se muestran en la tienda.',
            _esperando, 'fotosTablaEsperando')}`;

  cuerpo.querySelectorAll('[data-sacar]').forEach(b => {
    b.addEventListener('click', () => sacar(b.dataset.sacar));
  });
  cuerpo.querySelectorAll('[data-cargar]').forEach(b => {
    b.addEventListener('click', () => pedirArchivo(b.dataset.cargar));
  });
}

function filaHtml(f) {
  const foto = f.fotos[0];
  return `
    <tr data-fila="${escHtml(f.id)}">
      <td>
        ${foto
          ? `<img src="${escHtml(foto)}" alt="" class="tienda-foto" loading="lazy">`
          : `<div class="tienda-foto tienda-foto--falta">
               <span class="material-icons">image_not_supported</span>
             </div>`}
      </td>
      <td>
        <div class="tienda-nombre">${escHtml(f.nombre)}</div>
        ${f.enCatalogo
          ? (f.fotos.length > 1
              ? `<div class="tienda-sub">${f.fotos.length} fotos cargadas</div>` : '')
          : '<div class="tienda-sub" style="color:var(--tint-red-fg)">'
            + 'Ya no está en el catálogo</div>'}
      </td>
      <td>${escHtml(nombreBonito(f.rubro))}</td>
      <td style="color:var(--text-muted)">${f.cuando
        ? fecha(f.cuando)
        : '<span class="tienda-etiqueta sinfoto">En la vidriera</span>'}</td>
      <td data-no-imprimir>
        <div style="display:flex;gap:6px;align-items:center;justify-content:flex-end">
          <span class="tienda-pista" data-estado="${escHtml(f.id)}" style="margin:0"></span>
          ${f.enCatalogo ? `
            <button class="pc-btn" data-cargar="${escHtml(f.id)}"
                    style="padding:6px 10px;white-space:nowrap">
              <span class="material-icons">add_a_photo</span>
              ${f.fotos.length ? 'Cambiar' : 'Cargar'}
            </button>` : ''}
          <button class="pc-btn" data-sacar="${escHtml(f.id)}" title="Sacar de la lista"
                  style="padding:6px 8px">
            <span class="material-icons" style="font-size:17px">close</span>
          </button>
        </div>
      </td>
    </tr>`;
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

      decir('Guardando…');
      const resultado = await guardarYEspejar(_db, id, cambios, _habilitados, _subExcluidos,
                                              { datos: producto || null });

      // 3. El catálogo en memoria queda al día para que refrescar no la pierda.
      if (producto) {
        producto.tienda_imagenes = imagenes;
        if (hayDesvinculadas) {
          if (cambios.tienda_variedades === undefined) delete producto.tienda_variedades;
          else producto.tienda_variedades = cambios.tienda_variedades;
        }
      }
      f.fotos = imagenes.slice();

      // 4. Con foto ya no está pendiente: sale de las dos listas. Se saca
      //    recién ahora: si el guardado hubiera fallado, tenía que seguir acá.
      //    Sin fotos (las sacó todas) sigue pendiente, con lo que quedó.
      if (imagenes.length) {
        await deleteDoc(doc(_db, 'tienda_fotos_pedidas', id)).catch(() => {});
        _lista = _lista.filter(x => x.id !== id);
        _esperando = _esperando.filter(x => x.id !== id);
      }
      pintarLista();

      // 5. Recién ahora se borran de Storage las que se sacaron: al revés, un
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
      // Lo que se alcanzó a subir y no quedó guardado no sirve para nada.
      subidas.forEach(url => borrarFoto(url));
      guardando = false;
      overlay.querySelectorAll('button').forEach(b => { b.disabled = false; });
      pintar();
      decir(err?.message || 'No se pudo guardar. Probá de nuevo.', true);
    } finally {
      _subiendo = false;
      document.querySelectorAll('[data-cargar]').forEach(b => { b.disabled = false; });
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

async function sacar(id) {
  // Puede venir de cualquiera de las dos tablas.
  const f = _lista.find(x => x.id === id) || _esperando.find(x => x.id === id);
  const ok = await confirmDialog({
    title: 'Sacar de la lista',
    message: `"${f?.nombre || id}" deja de figurar como pendiente de foto.`,
    confirmText: 'Sacar',
  });
  if (!ok) return;

  try {
    await deleteDoc(doc(_db, 'tienda_fotos_pedidas', id));
    _lista = _lista.filter(x => x.id !== id);
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
  if (!_lista.length) return;

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
