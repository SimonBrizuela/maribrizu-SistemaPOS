/**
 * Descuentos de la tienda online.
 *
 * Son de la WEB y no se mezclan con las Promociones del POS: en el mostrador se
 * cobra lo que dice la caja y online lo que dice acá, así se puede liquidar en
 * la web sin tocar el precio del local. Desde acá se puede copiar una promo del
 * POS para no cargarla dos veces.
 *
 * Un descuento dice sobre qué cae —un rubro entero, un subrubro o un artículo
 * puntual— y cuánto saca. Gana el más específico: el del artículo le gana al del
 * subrubro y ése al del rubro.
 *
 * La cuenta vive en `webapp/src/tienda_descuentos_regla.js`, gemelo de
 * `aplicar_descuento` en `scripts/sync_tienda.py`: parte del precio de lista,
 * nunca del ya rebajado. Guardar acá deja el descuento cargado y aplicado en el
 * momento; el sync lo reafirma en cada corrida con la misma regla.
 *
 * Al tocar un descuento (crear, editar, apagar, borrar) los productos de su
 * alcance se recalculan contra TODOS los vigentes, no solo contra el que se
 * tocó: apagar el del rubro tiene que dejar el del subrubro puesto, y prender
 * uno del rubro no tiene que pisar al del artículo.
 */
import {
  collection, doc, getDocs, getDoc, query, orderBy, where,
} from 'firebase/firestore';
import { getCached } from '../cache.js';
import { alertDialog, confirmDialog, escHtml } from '../components/dialogs.js';
import {
  nombreBonito, medidasDe, motivoDeNoPublicar, leerDocEspejoRest, consultarEspejoRest,
  actualizarDoc, borrarDoc, escribirLote, olvidarDescuentosVigentes,
} from '../tienda_espejo.js';
import {
  descuentosVigentes, descuentoPara, aplicarDescuento, recalcularEspejo, claveDeObjetivo,
} from '../tienda_descuentos_regla.js';
// `.pc-btn` y las tarjetas de la seccion Tienda viven acá. Sin este import los
// botones salen con el estilo crudo del navegador.
import '../styles/tienda.css';

let _db = null;
let _descuentos = [];
let _catalogo = [];
let _publicadosPorDescuento = new Map();

const pesos = n => `$${Number(n || 0).toLocaleString('es-AR')}`;

/* ── La regla, aplicada a lo que hay en memoria ───────────────────────────── */

/** Los vigentes de la lista en memoria, en la forma que entiende la regla. */
function vigentesAhora() {
  return descuentosVigentes(_descuentos.map(d => ({ id: d._id, datos: d })), new Date());
}

/**
 * Un descuento (o un borrador del editor) como lo ve la regla, sin mirar si
 * está activo ni vigente: es para saber a QUIÉN le tocaría.
 */
function reglaDe(d) {
  return { alcance: String(d.alcance || 'rubro'), objetivo: claveDeObjetivo(d.objetivo) };
}

/** El precio que ve el cliente en la tienda: por unidad, no el del pack. */
const precioTienda = p => medidasDe(p).precio;

/**
 * Los productos del catálogo sobre los que cae un descuento.
 *
 * Ojo: el catálogo tiene mucho más de lo que sale a la web (sin stock, sin
 * foto, rubro apagado). Para lo que se muestra en pantalla interesa cuántos
 * están PUBLICADOS — ver `contarPublicados()` —, porque son los únicos donde
 * el cliente va a ver el precio bajar.
 */
function alcanzados(d) {
  const regla = reglaDe(d);
  if (!regla.objetivo) return [];
  return _catalogo.filter(p => descuentoPara(p.doc_id, p, [regla]) !== null);
}

/**
 * Los productos del alcance a los que un monto fijo les comería el precio
 * entero: esos quedan a precio de lista, sin descuento. Solo los que pueden
 * llegar a estar en la tienda (activos, con precio y con stock): avisar por un
 * producto dado de baja a $1 sería ruido.
 */
function masBaratosQueElMonto(d) {
  if (d.tipo !== 'monto') return [];
  const monto = Number(d.valor) || 0;
  return alcanzados(d)
    .filter(p => motivoDeNoPublicar(p) === null && precioTienda(p) <= monto)
    .sort((a, b) => precioTienda(a) - precioTienda(b));
}

/* ── Pintado ──────────────────────────────────────────────────────────────── */

function tarjeta(d) {
  const n = _publicadosPorDescuento.get(d._id);
  const signo = d.tipo === 'monto' ? '' : '%';
  const valor = d.tipo === 'monto' ? pesos(d.valor) : `${d.valor}${signo}`;
  const donde = d.alcance === 'producto'
    ? 'un artículo'
    : `${d.alcance === 'rubro' ? 'el rubro' : 'el subrubro'} ${nombreBonito(String(d.objetivo).split('|').pop())}`;

  return `
    <div class="card" style="padding:14px;display:flex;flex-direction:column;gap:10px;
                             ${d.activo === false ? 'opacity:.55' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div style="min-width:0">
          <div style="font-weight:700;font-size:15px">${escHtml(d.nombre)}</div>
          <div style="font-size:12.5px;color:var(--text-muted);margin-top:2px">
            ${escHtml(valor)} de descuento en ${escHtml(donde)}
          </div>
        </div>
        <span class="badge ${d.activo === false ? 'badge-gray' : 'badge-green'}">
          ${d.activo === false ? 'Apagado' : 'Activo'}
        </span>
      </div>
      <div style="font-size:12.5px;color:var(--text-muted)">
        <span class="material-icons" style="font-size:14px;vertical-align:-2px">inventory_2</span>
        ${n === undefined
          ? 'contando…'
          : `${n} producto${n === 1 ? '' : 's'} en la tienda con este precio`}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="pc-btn" data-accion="alternar" data-id="${escHtml(d._id)}">
          ${d.activo === false ? 'Activar' : 'Apagar'}
        </button>
        <button class="pc-btn" data-accion="editar" data-id="${escHtml(d._id)}">Editar</button>
        <button class="pc-btn" data-accion="borrar" data-id="${escHtml(d._id)}"
                style="color:var(--tint-red-fg)">Borrar</button>
      </div>
    </div>`;
}

function pintar() {
  const caja = document.getElementById('descLista');
  if (!caja) return;
  if (!_descuentos.length) {
    caja.innerHTML = `
      <div class="card" style="padding:28px;text-align:center;color:var(--text-muted);grid-column:1/-1">
        <span class="material-icons" style="font-size:34px;opacity:.4">sell</span>
        <p style="margin:10px 0 0;font-size:14px">
          Todavía no hay descuentos en la tienda.<br>
          Con "Nuevo descuento" podés bajarle el precio a un rubro entero, a un
          subrubro o a un solo artículo.
        </p>
      </div>`;
    return;
  }
  caja.innerHTML = _descuentos.map(tarjeta).join('');
}

/* ── Alta y edición ───────────────────────────────────────────────────────── */

function abrirEditor(d = null) {
  const rubros = [...new Set(_catalogo.map(p => String(p.rubro || '').trim().toUpperCase())
    .filter(Boolean))].sort();
  const subrubros = [...new Set(_catalogo
    .filter(p => p.rubro && p.sub_rubro)
    .map(p => `${String(p.rubro).trim().toUpperCase()}|${String(p.sub_rubro).trim().toUpperCase()}`)
  )].sort();

  document.querySelector('.desc-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay desc-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:560px;width:100%">
      <div class="modal-header">
        <h3 style="margin:0;font-size:16px">${d ? 'Editar descuento' : 'Nuevo descuento'}</h3>
        <button class="desc-cerrar" style="background:none;border:none;cursor:pointer;color:var(--text-muted)">
          <span class="material-icons">close</span>
        </button>
      </div>
      <div style="padding:16px 20px;display:flex;flex-direction:column;gap:14px">
        <label>
          <span class="desc-lbl">Nombre</span>
          <input type="text" id="dNombre" maxlength="60" value="${escHtml(d?.nombre || '')}"
                 placeholder="Liquidación de invierno" class="desc-input">
        </label>

        <div style="display:flex;gap:10px">
          <label style="flex:1">
            <span class="desc-lbl">Tipo</span>
            <select id="dTipo" class="desc-input">
              <option value="porcentaje" ${d?.tipo !== 'monto' ? 'selected' : ''}>Porcentaje %</option>
              <option value="monto" ${d?.tipo === 'monto' ? 'selected' : ''}>Monto fijo $</option>
            </select>
          </label>
          <label style="width:130px">
            <span class="desc-lbl">Cuánto</span>
            <input type="number" id="dValor" min="1" step="1" value="${escHtml(String(d?.valor || ''))}"
                   placeholder="20" class="desc-input">
          </label>
        </div>

        <label>
          <span class="desc-lbl">Se aplica a</span>
          <select id="dAlcance" class="desc-input">
            <option value="rubro" ${d?.alcance === 'rubro' || !d ? 'selected' : ''}>Un rubro entero</option>
            <option value="subrubro" ${d?.alcance === 'subrubro' ? 'selected' : ''}>Un subrubro</option>
            <option value="producto" ${d?.alcance === 'producto' ? 'selected' : ''}>Un artículo puntual</option>
          </select>
        </label>

        <label id="dCajaObjetivo">
          <span class="desc-lbl" id="dLblObjetivo">Rubro</span>
          <select id="dObjetivo" class="desc-input"></select>
          <input type="text" id="dBuscarProd" class="desc-input"
                 placeholder="Buscar…" autocomplete="off">
          <div id="dResultados" class="desc-resultados"></div>
        </label>

        <label style="display:flex;align-items:center;gap:9px;cursor:pointer">
          <input type="checkbox" id="dRedondear" ${d?.redondear ? 'checked' : ''}
                 style="width:17px;height:17px;accent-color:var(--primary);cursor:pointer">
          <span style="font-size:13px">
            Redondear el precio final a la centena
            <span style="color:var(--text-muted)"> · $6.327 queda $6.300</span>
          </span>
        </label>

        <div id="dPreview" style="padding:11px 13px;border-radius:8px;background:var(--surface-2);
                                  border:1px solid var(--border);font-size:13px;line-height:1.5"></div>
      </div>
      <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;
                  justify-content:flex-end;gap:8px;background:var(--surface-2)">
        <button class="pc-btn desc-cancelar">Cancelar</button>
        <button class="btn-primary desc-guardar">${d ? 'Guardar cambios' : 'Crear descuento'}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = sel => overlay.querySelector(sel);
  const cerrar = () => overlay.remove();
  $('.desc-cerrar').addEventListener('click', cerrar);
  $('.desc-cancelar').addEventListener('click', cerrar);
  overlay.addEventListener('click', ev => { if (ev.target === overlay) cerrar(); });

  const selObjetivo = $('#dObjetivo');
  const buscador = $('#dBuscarProd');
  const resultados = $('#dResultados');

  resultados.addEventListener('click', ev => {
    const fila = ev.target.closest('[data-prod]');
    if (fila) elegirProducto(fila.dataset.prod);
  });

  /**
   * Las opciones del alcance elegido, ya filtradas por lo que se escribió.
   *
   * Los tres casos se buscan igual —rubro, subrubro y artículo— porque en los
   * tres la lista es larga: 12 rubros, 226 subrubros solo en Librería y 9.700
   * artículos. Cada fila lleva el nombre arriba y, abajo, cuántos productos
   * abarca: es el dato que hace falta para decidir si el descuento va ahí.
   */
  function opcionesDe(alcance, texto) {
    const q = texto.trim().toLowerCase();
    const entra = t => !q || String(t).toLowerCase().includes(q);

    if (alcance === 'rubro') {
      return rubros.filter(r => entra(nombreBonito(r))).map(r => ({
        valor: r,
        titulo: nombreBonito(r),
        detalle: `${_catalogo.filter(p => String(p.rubro || '').trim().toUpperCase() === r).length} productos`,
      }));
    }
    if (alcance === 'subrubro') {
      return subrubros
        .filter(k => entra(k.split('|').map(nombreBonito).join(' ')))
        .map(k => {
          const [r, sub] = k.split('|');
          return {
            valor: k,
            titulo: nombreBonito(sub),
            detalle: `${nombreBonito(r)} · ${_catalogo.filter(p =>
              `${String(p.rubro || '').trim().toUpperCase()}|${String(p.sub_rubro || '').trim().toUpperCase()}` === k
            ).length} productos`,
          };
        })
        .slice(0, 80);
    }
    return _catalogo
      .filter(p => !q
        || String(p.nombre || '').toLowerCase().includes(q)
        || String(p.doc_id || '').toLowerCase().includes(q))
      .slice(0, 60)
      .map(p => ({
        valor: p.doc_id,
        titulo: nombreBonito(p.nombre),
        detalle: `${p.doc_id} · ${pesos(p.precio_venta)}`,
      }));
  }

  function pintarProductos(texto) {
    const alcance = $('#dAlcance').value;
    const lista = opcionesDe(alcance, texto || '');

    if (!lista.length) {
      resultados.innerHTML = '<div class="desc-vacio">No hay nada con ese nombre.</div>';
      return;
    }
    // Sin nada elegido todavía, se marca el primero: así la vista previa
    // muestra un número desde el arranque en vez de un cartel pidiendo elegir.
    if (!selObjetivo.value || !lista.some(o => o.valor === selObjetivo.value)) {
      selObjetivo.innerHTML = `<option value="${escHtml(lista[0].valor)}" selected></option>`;
      selObjetivo.value = lista[0].valor;
    }
    resultados.innerHTML = lista.map(o => `
      <button type="button" class="desc-fila${selObjetivo.value === o.valor ? ' desc-fila--elegida' : ''}"
              data-prod="${escHtml(o.valor)}">
        <span class="desc-fila__nombre">${escHtml(o.titulo)}</span>
        <span class="desc-fila__meta">${escHtml(o.detalle)}</span>
      </button>`).join('');
  }

  function llenarObjetivo() {
    const alcance = $('#dAlcance').value;
    $('#dLblObjetivo').textContent =
      alcance === 'rubro' ? 'Rubro' : alcance === 'subrubro' ? 'Subrubro' : 'Artículo';
    buscador.placeholder = alcance === 'rubro' ? 'Buscar rubro…'
      : alcance === 'subrubro' ? 'Buscar subrubro…' : 'Buscar por nombre o código…';

    // El <select> queda como el que guarda el valor, escondido: así el guardado
    // y la vista previa no se enteran de que la lista cambió de forma.
    selObjetivo.style.display = 'none';

    // Al editar, el que ya estaba elegido queda marcado y escrito arriba.
    if (d && d.alcance === alcance && d.objetivo && !selObjetivo.value) {
      selObjetivo.innerHTML = `<option value="${escHtml(d.objetivo)}" selected></option>`;
      selObjetivo.value = d.objetivo;
      const yaEsta = opcionesDe(alcance, '').find(o => o.valor === d.objetivo);
      if (yaEsta) buscador.value = yaEsta.titulo;
    }

    pintarProductos(buscador.value || '');
    previsualizar();
  }

  function elegirProducto(valor) {
    // El <select> escondido sigue siendo el que guarda el valor: así el resto
    // del formulario (vista previa y guardado) no se entera del cambio.
    selObjetivo.innerHTML = `<option value="${escHtml(valor)}" selected></option>`;
    selObjetivo.value = valor;
    pintarProductos(buscador.value);
    previsualizar();
  }

  function borradorActual() {
    return {
      tipo: $('#dTipo').value,
      valor: Number($('#dValor').value) || 0,
      alcance: $('#dAlcance').value,
      objetivo: selObjetivo.value,
      redondear: $('#dRedondear').checked,
    };
  }

  function previsualizar() {
    const borrador = borradorActual();
    const productos = alcanzados(borrador);
    const caja = $('#dPreview');
    if (!borrador.valor || !productos.length) {
      const falta = !borrador.valor
        ? 'Poné cuánto descontar.'
        : (borrador.alcance === 'producto' && !borrador.objetivo)
          ? 'Elegí un artículo de la lista.'
          : 'Ese alcance no tiene productos publicables.';
      caja.innerHTML = `<span style="color:var(--text-muted)">${falta}</span>`;
      return;
    }
    // La misma cuenta que va a hacer el espejo, sobre el precio que ve el
    // cliente (por unidad, no el del rollo).
    const [vigente] = descuentosVigentes([{ id: 'borrador', datos: { ...borrador, activo: true } }]);
    const ejemplo = productos.find(p => precioTienda(p) > 0);
    const antes = ejemplo ? precioTienda(ejemplo) : 0;
    const despues = ejemplo
      ? aplicarDescuento(ejemplo.doc_id, { precio: antes, rubro: ejemplo.rubro, sub_rubro: ejemplo.sub_rubro },
                         vigente ? [vigente] : []).precio
      : 0;
    const baratos = masBaratosQueElMonto(borrador);
    caja.innerHTML = `
      <b>${productos.length} producto${productos.length === 1 ? '' : 's'}</b> con descuento.
      ${ejemplo ? `<br>Ejemplo: ${escHtml(nombreBonito(ejemplo.nombre))} pasa de
        <s>${pesos(antes)}</s> a <b style="color:var(--tint-green-fg)">${pesos(despues)}</b>.` : ''}
      ${baratos.length ? `<br><span style="color:var(--tint-red-fg)">${textoDeBaratos(baratos)}</span>` : ''}`;
  }

  $('#dAlcance').addEventListener('change', () => {
    // Lo tipeado para buscar un rubro no sirve para buscar un artículo.
    buscador.value = '';
    selObjetivo.innerHTML = '';
    llenarObjetivo();
  });
  selObjetivo.addEventListener('change', previsualizar);
  $('#dTipo').addEventListener('change', previsualizar);
  $('#dValor').addEventListener('input', previsualizar);
  $('#dRedondear').addEventListener('change', previsualizar);
  buscador.addEventListener('input', () => pintarProductos(buscador.value));
  llenarObjetivo();

  $('.desc-guardar').addEventListener('click', async ev => {
    const nombre = $('#dNombre').value.trim();
    const valor = Number($('#dValor').value) || 0;
    const objetivo = String(selObjetivo.value || '').trim();
    if (!nombre) { alertDialog({ title: 'Falta el nombre', message: 'Poné un nombre para reconocerlo después.', type: 'warning' }); return; }
    if (valor <= 0 || !objetivo) { alertDialog({ title: 'Faltan datos', message: 'Revisá cuánto descuenta y sobre qué se aplica.', type: 'warning' }); return; }

    const alcance = $('#dAlcance').value;
    const datos = {
      nombre,
      tipo: $('#dTipo').value,
      valor,
      alcance,
      // El id del artículo va tal cual está en el catálogo: hay ids con
      // minúsculas (Craft1, Eco1) y guardado en mayúsculas después no se
      // encontraba en el espejo. Rubro y subrubro sí van en mayúsculas, que
      // es como los guarda el catálogo.
      objetivo: alcance === 'producto' ? objetivo : objetivo.toUpperCase(),
      redondear: $('#dRedondear').checked,
      activo: d ? d.activo !== false : true,
    };

    // Un monto más grande que el precio no rebaja: esos productos quedan a
    // precio de lista. Se puede guardar igual, pero sabiéndolo.
    const baratos = masBaratosQueElMonto(datos);
    if (baratos.length) {
      const seguir = await confirmDialog({
        title: 'El monto supera el precio',
        message: `${escHtml(textoDeBaratos(baratos))}<br><br>¿Guardar igual?`,
        confirmText: 'Guardar igual',
      });
      if (!seguir) return;
    }

    const boton = ev.currentTarget;
    boton.disabled = true;
    boton.textContent = 'Guardando…';
    try {
      const id = d?._id || `${Date.now()}`;
      await actualizarDoc(_db, 'tienda_descuentos', id, datos, { crearSiFalta: true });
      const guardado = { _id: id, ...(d || {}), ...datos };
      // La lista se actualiza con lo que se acaba de guardar, sin releer la
      // colección: esa relectura pasaba por la cola del SDK y era lo que dejaba
      // el botón en "Guardando…" un rato largo.
      reemplazarEnLista(guardado);
      // Se recalcula el alcance nuevo Y el viejo: si se mudó —de un rubro a
      // otro, o de rubro a artículo— lo que ya no entra vuelve a su precio.
      // Sin esto quedaba rebajado para siempre: pasó en producción con
      // Perfumería cuando el descuento se mudó a Juguetería.
      await recalcularEnLaTienda(d ? [d, guardado] : [guardado]);
      cerrar();
      await refrescarConteos();
    } catch (e) {
      boton.disabled = false;
      boton.textContent = d ? 'Guardar cambios' : 'Crear descuento';
      alertDialog({ title: 'No se pudo guardar', message: escHtml(e?.message || String(e)), type: 'error' });
    }
  });
}

/** "3 productos salen menos que el monto (el más barato, Goma Pelikan a $400)…" */
function textoDeBaratos(baratos) {
  const n = baratos.length;
  const barato = baratos[0];
  return `${n} producto${n === 1 ? '' : 's'} del alcance ${n === 1 ? 'sale' : 'salen'} menos que el monto`
    + ` (${n === 1 ? '' : 'el más barato, '}${nombreBonito(barato.nombre)} a ${pesos(precioTienda(barato))})`
    + `: ${n === 1 ? 'queda' : 'quedan'} a precio de lista, sin descuento.`;
}

/* ── Aplicar en el espejo ─────────────────────────────────────────────────── */

/**
 * Rehace el precio en `tienda_productos` ahora mismo, sin esperar al sync.
 *
 * Trabaja SOBRE EL ESPEJO y no sobre el catálogo. Dos razones, las dos costaron
 * precios mal puestos:
 *
 *   · El precio de la vidriera no siempre es `precio_venta`. En un producto que
 *     se vende suelto (un metro de cinta, un bolígrafo de una caja) la tienda
 *     muestra el precio por unidad, que se calcula aparte.
 *   · El catálogo del panel viene de una cache de diez minutos. Si un rubro se
 *     corrigió recién, los productos que todavía tienen el valor viejo no
 *     matchean y quedan sin descuento, que es justo lo que pasó al probarlo.
 *
 * Se visitan los productos que caen bajo cada descuento de `tocados` (el que
 * se acaba de crear, apagar o borrar, y el alcance viejo si se mudó) y a cada
 * uno se le aplica lo que le corresponde entre TODOS los vigentes de la lista
 * en memoria. La cuenta parte siempre del precio de lista (`precio_anterior`
 * si ya había uno puesto), así que pasar dos veces da el mismo número.
 *
 * @returns {Promise<number>} cuántos productos cambiaron de precio
 */
async function recalcularEnLaTienda(tocados, avance = null) {
  const vigentes = vigentesAhora();

  // Se le pregunta al espejo qué productos caen bajo cada alcance, en vez de
  // deducirlo de una copia del catálogo que puede estar vieja. Sin repetir:
  // al mudar un descuento de un subrubro a otro del mismo rubro, los dos
  // alcances traen productos en común.
  const porId = new Map();
  for (const d of tocados) {
    for (const x of await productosDelDescuento(d)) porId.set(x.id, x);
  }
  const cambios = recalcularEspejo([...porId.values()], vigentes);

  // En lote y no de a uno: un rubro grande son cientos de productos, y con un
  // request por producto el boton se quedaba mudo varios segundos y parecia que
  // no habia pasado nada. Firestore admite 400 operaciones por lote.
  const TOPE = 400;
  let hechos = 0;
  for (let i = 0; i < cambios.length; i += TOPE) {
    const lote = cambios.slice(i, i + TOPE).map(c => ({
      tipo: 'actualizar', col: 'tienda_productos', id: c.id, datos: c.datos,
    }));
    await escribirLote(_db, lote);
    hechos += lote.length;
    if (typeof avance === 'function') avance(hechos, cambios.length);
  }
  // El espejado de la ficha lee los vigentes con un minuto de memoria: que la
  // próxima lectura vea lo que se acaba de cambiar.
  olvidarDescuentosVigentes();
  return cambios.length;
}

// Lo que hace falta para rehacer la cuenta: los precios (de lista y rebajados)
// y por dónde cae cada descuento. `variedades` viene porque el precio propio de
// cada color lleva la misma rebaja: sin leerlas, aplicar el descuento acá
// dejaba los colores a precio de lista hasta la corrida siguiente del sync.
const CAMPOS_DEL_ESPEJO = ['precio', 'precio_anterior', 'precio_pack', 'precio_pack_anterior',
                          'descuento', 'rubro', 'sub_rubro', 'variedades'];

/**
 * Los productos publicados que caen bajo un descuento, como `[{id, datos}]`.
 *
 * Por REST y no por el SDK: en esta webapp una lectura suelta por el SDK
 * queda encolada detrás de los listeners grandes y puede tardar más de un
 * minuto, y esto corre en cada Guardar. El espejo es de lectura pública. Si
 * la REST no responde se cae al SDK, que anda pero puede tardar.
 */
async function productosDelDescuento(d) {
  const regla = reglaDe(d);
  if (!regla.objetivo) return [];

  if (regla.alcance === 'producto') {
    // El id tal cual, y si no está, el del catálogo que coincide sin mirar
    // mayúsculas: los descuentos cargados antes del 2026-09-08 guardaron el
    // objetivo en mayúsculas y `Craft1` quedó como `CRAFT1`.
    const ids = [...new Set([
      String(d.objetivo || '').trim(),
      ..._catalogo.filter(p => claveDeObjetivo(p.doc_id) === regla.objetivo).map(p => p.doc_id),
    ])].filter(Boolean);
    for (const id of ids) {
      const uno = await leerUnoDelEspejo(id);
      if (uno) return [uno];
    }
    return [];
  }

  // El espejo guarda el rubro como está escrito en el catálogo, y el mismo
  // rubro aparece con tilde y sin tilde ("MERCERÍA" y "MERCERIA"). Se pide
  // cada forma que exista y después se filtra con la regla, que compara sin
  // tildes.
  const formas = new Set([String(d.objetivo || '').split('|')[0].trim().toUpperCase()]);
  for (const p of _catalogo) {
    const rubro = String(p.rubro || '').trim().toUpperCase();
    if (rubro && claveDeObjetivo(rubro) === regla.objetivo.split('|')[0]) formas.add(rubro);
  }
  const porId = new Map();
  for (const rubro of formas) {
    if (!rubro) continue;
    for (const x of await leerRubroDelEspejo(rubro)) porId.set(x.id, x);
  }
  return [...porId.values()].filter(x => descuentoPara(x.id, x.datos, [regla]) !== null);
}

async function leerUnoDelEspejo(id) {
  const porRest = await leerDocEspejoRest(id, CAMPOS_DEL_ESPEJO);
  if (porRest !== null) return porRest.existe ? { id, datos: porRest.datos } : null;
  const uno = await getDoc(doc(_db, 'tienda_productos', id));
  return uno.exists() ? { id: uno.id, datos: uno.data() } : null;
}

async function leerRubroDelEspejo(rubro) {
  const porRest = await consultarEspejoRest({ donde: { rubro }, campos: CAMPOS_DEL_ESPEJO });
  if (porRest !== null) return porRest;
  const snap = await getDocs(query(collection(_db, 'tienda_productos'), where('rubro', '==', rubro)));
  return snap.docs.map(x => ({ id: x.id, datos: x.data() }));
}

/** Confirmación breve arriba de la lista: apretar y no ver nada da desconfianza. */
function avisar(texto) {
  const caja = document.getElementById('descAviso');
  if (!caja) return;
  caja.textContent = texto;
  caja.style.opacity = '1';
  clearTimeout(avisar._t);
  avisar._t = setTimeout(() => { caja.style.opacity = '0'; }, 2600);
}

/* ── Carga ────────────────────────────────────────────────────────────────── */

/**
 * Cuántos productos PUBLICADOS toca cada descuento.
 *
 * Se cuenta contra `tienda_productos` y no contra el catálogo: el catálogo
 * tiene 9.700 productos y en la tienda hay 2.500, así que decir "63 alcanzados"
 * cuando en la vidriera se ven 10 es mentirle a quien decide el precio.
 */
async function contarPublicados() {
  _publicadosPorDescuento = new Map();
  // Cacheado: son 2.500 lecturas de Firestore y solo se usan para un contador.
  // Sin esto, cada vez que se abre la pantalla se pagan de nuevo.
  const publicados = await getCached('tienda:publicados_rubros', async () => {
    const snap = await getDocs(collection(_db, 'tienda_productos'));
    return snap.docs.map(x => ({
      doc_id: x.id,
      rubro: (x.data() || {}).rubro || '',
      sub_rubro: (x.data() || {}).sub_rubro || '',
    }));
  }, { ttl: 5 * 60 * 1000, memOnly: true });
  for (const d of _descuentos) {
    const regla = reglaDe(d);
    _publicadosPorDescuento.set(d._id, regla.objetivo
      ? publicados.filter(p => descuentoPara(p.doc_id, p, [regla]) !== null).length
      : 0);
  }
}

async function recargar() {
  const snap = await getDocs(query(collection(_db, 'tienda_descuentos')));
  _descuentos = snap.docs.map(x => ({ _id: x.id, ...x.data() }))
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
  pintar();
  if (_descuentos.length) {
    await contarPublicados();
    pintar();
  }
}

export async function renderTiendaDescuentos(container, db) {
  _db = db;

  container.innerHTML = `
    <style>
      .desc-lbl { display:block; font-size:11.5px; font-weight:700; color:var(--text-muted);
                  text-transform:uppercase; letter-spacing:.4px; margin-bottom:4px }
      .desc-input { width:100%; padding:9px 11px; border:1.5px solid var(--border);
                    border-radius:8px; font-size:13.5px; box-sizing:border-box;
                    background:var(--surface); color:var(--text) }
      /* Lista de artículos: crece hacia ABAJO y con su propio scroll. Un
         <select> con doscientas opciones se abre para arriba y tapa todo. */
      .desc-resultados { margin-top:6px; max-height:210px; overflow-y:auto;
                         border:1.5px solid var(--border); border-radius:8px;
                         background:var(--surface) }
      .desc-fila { display:flex; flex-direction:column; gap:2px; width:100%;
                   padding:8px 11px; border:0; border-bottom:1px solid var(--border);
                   background:transparent; color:var(--text); font-family:inherit;
                   text-align:left; cursor:pointer }
      .desc-fila:last-child { border-bottom:0 }
      .desc-fila:hover { background:var(--surface-2) }
      .desc-fila--elegida { background:var(--primary); color:#fff }
      /* El hover del elegido va DESPUES y con mas peso: un hover con clase
         pesa mas que la clase sola, asi que al pasar el mouse le pisaba el
         violeta y quedaba texto blanco sobre gris claro, ilegible. */
      .desc-fila--elegida:hover { background:var(--primary-dark); color:#fff }
      .desc-fila--elegida .desc-fila__meta { color:rgba(255,255,255,.85) }
      .desc-fila__nombre { font-size:13px; font-weight:600 }
      .desc-fila__meta { font-size:11.5px; color:var(--text-muted) }
      .desc-vacio { padding:14px; text-align:center; font-size:12.5px;
                    color:var(--text-muted) }
    </style>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;
                flex-wrap:wrap;gap:10px">
      <div>
        <h3 style="margin:0">
          <span class="material-icons" style="vertical-align:middle;margin-right:6px;color:var(--tint-red-fg)">sell</span>
          Descuentos de la tienda
        </h3>
        <div style="font-size:12.5px;color:var(--text-muted);margin-top:3px">
          Solo para la web. Las Promociones del POS siguen siendo del mostrador.
        </div>
      </div>
      <span id="descAviso" style="font-size:12.5px;color:var(--tint-green-fg);font-weight:600;
                                  opacity:0;transition:opacity .2s;margin-left:auto"></span>
      <button class="btn-primary" id="descNuevo">
        <span class="material-icons" style="font-size:18px">add</span> Nuevo descuento
      </button>
    </div>
    <div id="descLista" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px">
      ${Array(3).fill('<div class="skel skel-card" style="height:150px"></div>').join('')}
    </div>`;

  _catalogo = (await getCached('catalogo:all', async () => {
    const snap = await getDocs(query(collection(db, 'catalogo'), orderBy('nombre')));
    return snap.docs.map(d => ({ ...d.data(), doc_id: d.id }));
  }, { ttl: 10 * 60 * 1000, memOnly: true })) || [];
  // Solo lo que puede llegar a estar en la tienda: descontarle el precio a algo
  // dado de baja no le sirve a nadie.
  _catalogo = _catalogo.filter(p => p && p.doc_id && p.estado !== 'baja' && !p.duplicado);

  await recargar();

  document.getElementById('descNuevo').addEventListener('click', () => abrirEditor());

  document.getElementById('descLista').addEventListener('click', async ev => {
    const boton = ev.target.closest('[data-accion]');
    if (!boton) return;
    const d = _descuentos.find(x => x._id === boton.dataset.id);
    if (!d) return;

    if (boton.dataset.accion === 'editar') { abrirEditor(d); return; }

    if (boton.dataset.accion === 'alternar') {
      const activo = d.activo === false;
      // La tarjeta cambia primero y los precios se acomodan atrás. Esperar a
      // que terminen de escribirse cientos de productos para recien mostrar
      // que se apago se siente como que el boton no anduvo.
      d.activo = activo;
      pintar();
      const btn = document.querySelector(`[data-accion="alternar"][data-id="${d._id}"]`);
      if (btn) { btn.disabled = true; btn.textContent = 'Aplicando…'; }
      try {
        await actualizarDoc(_db, 'tienda_descuentos', d._id, { activo });
        // Contra todos los vigentes: si se apaga el del rubro y hay uno del
        // subrubro, ese sigue puesto; no se vuelve a precio de lista a ciegas.
        const n = await recalcularEnLaTienda([d], (hechos, total) => {
          if (btn) btn.textContent = `Aplicando… ${hechos}/${total}`;
        });
        pintar();
        avisar(`${activo ? 'Activado' : 'Apagado'} · ${n} producto${n === 1 ? '' : 's'}`);
      } catch (e) {
        d.activo = !activo;
        pintar();
        alertDialog({ title: 'No se pudo cambiar', message: escHtml(e?.message || String(e)), type: 'error' });
      }
      return;
    }

    if (boton.dataset.accion === 'borrar') {
      // El cartel tiene que decir lo que de verdad va a pasar. "Los precios
      // vuelven a los de lista" es mentira cuando hay otro descuento vigente:
      // al borrar el del rubro, lo que también cae bajo el del subrubro queda
      // con ESE precio. Prometer la vuelta a la lista deja a quien lo borró
      // buscando por qué un producto sigue rebajado.
      const otros = vigentesAhora().filter(v => v.id !== d._id);
      const ok = await confirmDialog({
        title: 'Borrar descuento',
        message: `¿Borrar <b>${escHtml(d.nombre)}</b>? Los precios vuelven a los de lista`
          + (otros.length
            ? ', salvo los que caigan bajo otro descuento vigente: ésos quedan con ese precio.'
            : '.'),
        confirmText: 'Borrar',
        danger: true,
      });
      if (!ok) return;
      // Primero se rehacen los precios sin este descuento y después se borra:
      // al revés, queda un rubro entero rebajado y sin nada que explique por
      // qué. Si el recálculo falla a mitad, el descuento sigue en la base y el
      // sync lo reafirma: nunca queda un precio que no se pueda explicar.
      const sinEste = _descuentos.filter(x => x._id !== d._id);
      const conEste = _descuentos;
      _descuentos = sinEste;
      try {
        await recalcularEnLaTienda([d]);
        await borrarDoc(_db, 'tienda_descuentos', d._id);
      } catch (e) {
        _descuentos = conEste;
        pintar();
        alertDialog({ title: 'No se pudo borrar', message: escHtml(e?.message || String(e)), type: 'error' });
        return;
      }
      _publicadosPorDescuento.delete(d._id);
      pintar();
    }
  });
}

/** Mete o reemplaza un descuento en la lista en memoria, en su lugar por nombre. */
function reemplazarEnLista(d) {
  _descuentos = _descuentos.filter(x => x._id !== d._id).concat([d])
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
  pintar();
}

/** Recalcula cuántos publicados toca cada descuento (cacheado) y repinta. */
async function refrescarConteos() {
  try {
    await contarPublicados();
    pintar();
  } catch (e) {
    console.warn('[descuentos] no se pudieron contar los publicados:', e?.message || e);
  }
}
