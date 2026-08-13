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
 * La cuenta la hace `scripts/sync_tienda.py` (`aplicar_descuento`) sobre el
 * precio de lista, nunca sobre el ya rebajado: si se acumulara, cada corrida
 * descontaría de nuevo sobre lo descontado. Guardar acá deja el descuento
 * cargado y aplicado en el momento; el sync lo reafirma en cada corrida.
 */
import {
  collection, doc, getDocs, getDoc, setDoc, deleteDoc, updateDoc, query, orderBy, where, writeBatch,
} from 'firebase/firestore';
import { getCached } from '../cache.js';
import { alertDialog, confirmDialog, escHtml } from '../components/dialogs.js';
import { nombreBonito } from '../tienda_espejo.js';
// `.pc-btn` y las tarjetas de la seccion Tienda viven acá. Sin este import los
// botones salen con el estilo crudo del navegador.
import '../styles/tienda.css';

let _db = null;
let _descuentos = [];
let _catalogo = [];
let _publicadosPorDescuento = new Map();

const pesos = n => `$${Number(n || 0).toLocaleString('es-AR')}`;

/* ── Cuenta: el gemelo de aplicar_descuento() en sync_tienda.py ────────────── */

function precioConDescuento(lista, d) {
  const base = Number(lista) || 0;
  if (base <= 0) return base;
  const valor = Number(d.valor) || 0;
  const nuevo = d.tipo === 'monto'
    ? base - valor
    : base * (1 - Math.min(valor, 90) / 100);
  // Nunca por debajo de un peso: un precio en cero se lee como error, no como
  // oferta, y deja pasar pedidos que no se pueden cobrar.
  return Math.max(1, Math.round(nuevo));
}

/**
 * Los productos del catálogo sobre los que cae un descuento.
 *
 * Ojo: el catálogo tiene mucho más de lo que sale a la web (sin stock, sin
 * foto, rubro apagado). Para lo que se muestra en pantalla interesa cuántos
 * están PUBLICADOS — ver `publicados()` —, porque son los únicos donde el
 * cliente va a ver el precio bajar.
 */
function alcanzados(d) {
  const obj = String(d.objetivo || '').trim().toUpperCase();
  if (!obj) return [];
  return _catalogo.filter(p => {
    const rubro = String(p.rubro || '').trim().toUpperCase();
    const sub = String(p.sub_rubro || '').trim().toUpperCase();
    if (d.alcance === 'rubro') return rubro === obj;
    if (d.alcance === 'subrubro') return `${rubro}|${sub}` === obj;
    return String(p.doc_id || '').toUpperCase() === obj;
  });
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
          <input type="text" id="dBuscarProd" class="desc-input" style="display:none;margin-top:6px"
                 placeholder="Buscar el artículo por nombre o código…">
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

  function llenarObjetivo() {
    const alcance = $('#dAlcance').value;
    $('#dLblObjetivo').textContent =
      alcance === 'rubro' ? 'Rubro' : alcance === 'subrubro' ? 'Subrubro' : 'Artículo';
    buscador.style.display = alcance === 'producto' ? '' : 'none';

    if (alcance === 'rubro') {
      selObjetivo.innerHTML = rubros.map(r =>
        `<option value="${escHtml(r)}" ${d?.objetivo === r ? 'selected' : ''}>${escHtml(nombreBonito(r))}</option>`).join('');
    } else if (alcance === 'subrubro') {
      selObjetivo.innerHTML = subrubros.map(k => {
        const [r, s] = k.split('|');
        return `<option value="${escHtml(k)}" ${d?.objetivo === k ? 'selected' : ''}>${
          escHtml(`${nombreBonito(r)} · ${nombreBonito(s)}`)}</option>`;
      }).join('');
    } else {
      pintarProductos('');
    }
    previsualizar();
  }

  function pintarProductos(q) {
    const texto = q.trim().toLowerCase();
    const lista = _catalogo
      .filter(p => !texto
        || String(p.nombre || '').toLowerCase().includes(texto)
        || String(p.doc_id || '').toLowerCase().includes(texto))
      .slice(0, 200);
    selObjetivo.innerHTML = lista.map(p =>
      `<option value="${escHtml(p.doc_id)}" ${d?.objetivo === String(p.doc_id).toUpperCase() ? 'selected' : ''}>${
        escHtml(nombreBonito(p.nombre))} · ${pesos(p.precio_venta)}</option>`).join('')
      || '<option value="">No hay artículos con ese nombre</option>';
  }

  function previsualizar() {
    const borrador = {
      tipo: $('#dTipo').value,
      valor: Number($('#dValor').value) || 0,
      alcance: $('#dAlcance').value,
      objetivo: selObjetivo.value,
    };
    const productos = alcanzados(borrador);
    const caja = $('#dPreview');
    if (!borrador.valor || !productos.length) {
      caja.innerHTML = `<span style="color:var(--text-muted)">
        ${!borrador.valor ? 'Poné cuánto descontar.' : 'Ese alcance no tiene productos publicables.'}</span>`;
      return;
    }
    const ejemplo = productos.find(p => Number(p.precio_venta) > 0);
    const antes = Number(ejemplo?.precio_venta) || 0;
    const despues = precioConDescuento(antes, borrador);
    caja.innerHTML = `
      <b>${productos.length} producto${productos.length === 1 ? '' : 's'}</b> con descuento.
      ${ejemplo ? `<br>Ejemplo: ${escHtml(nombreBonito(ejemplo.nombre))} pasa de
        <s>${pesos(antes)}</s> a <b style="color:var(--tint-green-fg)">${pesos(despues)}</b>.` : ''}`;
  }

  $('#dAlcance').addEventListener('change', llenarObjetivo);
  selObjetivo.addEventListener('change', previsualizar);
  $('#dTipo').addEventListener('change', previsualizar);
  $('#dValor').addEventListener('input', previsualizar);
  buscador.addEventListener('input', () => { pintarProductos(buscador.value); previsualizar(); });
  llenarObjetivo();

  $('.desc-guardar').addEventListener('click', async ev => {
    const nombre = $('#dNombre').value.trim();
    const valor = Number($('#dValor').value) || 0;
    const objetivo = selObjetivo.value;
    if (!nombre) { alertDialog({ title: 'Falta el nombre', message: 'Poné un nombre para reconocerlo después.', type: 'warning' }); return; }
    if (valor <= 0 || !objetivo) { alertDialog({ title: 'Faltan datos', message: 'Revisá cuánto descuenta y sobre qué se aplica.', type: 'warning' }); return; }

    const boton = ev.currentTarget;
    boton.disabled = true;
    boton.textContent = 'Guardando…';
    const datos = {
      nombre,
      tipo: $('#dTipo').value,
      valor,
      alcance: $('#dAlcance').value,
      objetivo: String(objetivo).toUpperCase(),
      activo: d ? d.activo !== false : true,
    };
    try {
      const id = d?._id || `${Date.now()}`;
      await setDoc(doc(_db, 'tienda_descuentos', id), datos, { merge: true });
      await aplicarEnLaTienda({ ...datos, _id: id });
      cerrar();
      await recargar();
    } catch (e) {
      boton.disabled = false;
      boton.textContent = d ? 'Guardar cambios' : 'Crear descuento';
      alertDialog({ title: 'No se pudo guardar', message: escHtml(e?.message || String(e)), type: 'error' });
    }
  });
}

/* ── Aplicar en el espejo ─────────────────────────────────────────────────── */

/**
 * Baja el precio en `tienda_productos` ahora mismo, sin esperar al sync.
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
 * El precio de lista es `precio_anterior` si ya hay un descuento puesto, y si
 * no el `precio` actual. Por eso aplicar dos veces da el mismo número en vez de
 * ir rebajando sobre lo rebajado.
 */
async function aplicarEnLaTienda(d, avance = null) {
  const apagado = d.activo === false;
  const obj = String(d.objetivo || '').trim().toUpperCase();
  if (!obj) return 0;

  // Se le pregunta al espejo qué productos caen bajo el descuento, en vez de
  // deducirlo de una copia del catálogo que puede estar vieja.
  const col = collection(_db, 'tienda_productos');
  let docs = [];
  if (d.alcance === 'producto') {
    const uno = await getDoc(doc(_db, 'tienda_productos', obj));
    if (uno.exists()) docs = [uno];
  } else {
    const rubro = obj.split('|')[0];
    const snap = await getDocs(query(col, where('rubro', '==', rubro)));
    docs = snap.docs;
    if (d.alcance === 'subrubro') {
      const sub = obj.split('|')[1] || '';
      docs = docs.filter(x => String((x.data() || {}).sub_rubro || '')
        .trim().toUpperCase() === sub);
    }
  }

  // En lote y no de a uno: un rubro grande son cientos de productos, y con un
  // request por producto el boton se quedaba mudo varios segundos y parecia que
  // no habia pasado nada. Firestore admite 400 operaciones por lote.
  const TOPE = 400;
  let tocados = 0;
  for (let i = 0; i < docs.length; i += TOPE) {
    const lote = writeBatch(_db);
    let enLote = 0;
    for (const x of docs.slice(i, i + TOPE)) {
      const datos = x.data() || {};
      const lista = Number(datos.precio_anterior) || Number(datos.precio) || 0;
      if (lista <= 0) continue;
      const nuevo = apagado ? lista : precioConDescuento(lista, d);
      lote.update(doc(_db, 'tienda_productos', x.id), apagado || nuevo >= lista
        ? { precio: lista, precio_anterior: null, descuento: null }
        : {
            precio: nuevo,
            precio_anterior: lista,
            descuento: {
              id: d._id, nombre: d.nombre,
              porcentaje: Math.round((1 - nuevo / lista) * 100),
            },
          });
      enLote += 1;
    }
    if (!enLote) continue;
    await lote.commit();
    tocados += enLote;
    if (typeof avance === 'function') avance(tocados, docs.length);
  }
  return tocados;
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
  const snap = await getDocs(collection(_db, 'tienda_productos'));
  const publicados = snap.docs.map(x => ({ doc_id: x.id, ...(x.data() || {}) }));
  for (const d of _descuentos) {
    const obj = String(d.objetivo || '').trim().toUpperCase();
    _publicadosPorDescuento.set(d._id, publicados.filter(p => {
      const rubro = String(p.rubro || '').trim().toUpperCase();
      const sub = String(p.sub_rubro || '').trim().toUpperCase();
      if (d.alcance === 'rubro') return rubro === obj;
      if (d.alcance === 'subrubro') return `${rubro}|${sub}` === obj;
      return String(p.doc_id).toUpperCase() === obj;
    }).length);
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
        await updateDoc(doc(_db, 'tienda_descuentos', d._id), { activo });
        const n = await aplicarEnLaTienda({ ...d, activo }, (hechos, total) => {
          if (btn) btn.textContent = `Aplicando… ${hechos}/${total}`;
        });
        await recargar();
        avisar(`${activo ? 'Activado' : 'Apagado'} · ${n} producto${n === 1 ? '' : 's'}`);
      } catch (e) {
        d.activo = !activo;
        pintar();
        alertDialog({ title: 'No se pudo cambiar', message: escHtml(e?.message || String(e)), type: 'error' });
      }
      return;
    }

    if (boton.dataset.accion === 'borrar') {
      const ok = await confirmDialog({
        title: 'Borrar descuento',
        message: `¿Borrar <b>${escHtml(d.nombre)}</b>? Los precios vuelven a los de lista.`,
        confirmText: 'Borrar',
        danger: true,
      });
      if (!ok) return;
      // Primero se devuelven los precios y después se borra: al revés, queda un
      // rubro entero rebajado y sin nada que explique por qué.
      await aplicarEnLaTienda({ ...d, activo: false });
      await deleteDoc(doc(_db, 'tienda_descuentos', d._id));
      await recargar();
    }
  });
}
