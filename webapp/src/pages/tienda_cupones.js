/**
 * Cupones de la tienda online.
 *
 * Un cupón es un código que el cliente escribe en el checkout y que le
 * descuenta algo: un porcentaje (con tope si se quiere), un monto fijo o el
 * envío. Se le puede decir sobre qué cae —todo, algunos productos o algunos
 * rubros—, desde cuánto de compra vale, cuántas veces lo puede usar cada
 * persona y cuántas en total, entre qué fechas, y si es solo para la primera
 * compra o para una forma de entrega.
 *
 * Nada de esto lo decide el navegador del cliente: la tienda manda el código y
 * la función `crear-pedido` hace la cuenta con las mismas reglas que se ven
 * acá en la vista previa (`tienda/src/cupones.js`, compartido).
 *
 * Los usos no se llevan en un contador: se cuentan de los pedidos que llevan
 * el cupón. Un pedido cancelado devuelve el uso solo, y de los mismos pedidos
 * sale quién lo usó y en qué productos.
 */
import {
  collection, doc, getDocs, query, where, setDoc, updateDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore';
import { getCached } from '../cache.js';
import { alertDialog, confirmDialog, escHtml } from '../components/dialogs.js';
import { nombreBonito, decodificarCampos, codificarValor } from '../tienda_espejo.js';
import { auth } from '../auth.js';
import {
  normalizarCodigo, codigoValido, generarCodigo, describirCupon, describirAlcance,
  limiteDeDia, resumenDeUsos, claveDeRubro, TIPOS, ALCANCES, ENTREGAS,
} from '../../../tienda/src/cupones.js';
import '../styles/tienda.css';

const REST = 'https://firestore.googleapis.com/v1/projects/mari-d7c71/databases/(default)/documents';

let _db = null;
let _cupones = [];
let _catalogo = [];
/** código → resumen de usos (o null mientras se cuenta). */
let _usos = new Map();
/** Todos los pedidos que llevan cupón, con lo justo para contar. */
let _pedidosConCupon = null;

const pesos = n => `$${Math.round(Number(n) || 0).toLocaleString('es-AR')}`;
const hoy = () => new Date();

/* ── Lectura de los pedidos con cupón ─────────────────────────────────────── */

/**
 * Los pedidos que llevan cupón. Por REST con el token de la sesión —una
 * lectura suelta por el SDK queda encolada detrás de los listeners grandes
 * del panel y puede tardar más de un minuto— y si la REST no responde, por el
 * SDK. Con `codigo` trae solo los de ese cupón, con todos los campos, para la
 * pantalla de usos; sin código trae los de todos con lo justo para contar.
 */
async function pedidosConCupon(codigo = null) {
  const porRest = await consultarPedidosRest(codigo);
  if (porRest !== null) return porRest;

  const filtro = codigo
    ? where('cupon.codigo', '==', codigo)
    : where('cupon.codigo', '!=', null);
  const snap = await getDocs(query(collection(_db, 'tienda_pedidos'), filtro));
  return snap.docs
    .map(d => ({ id: d.id, ...(d.data() || {}) }))
    .filter(p => p?.cupon?.codigo && (!codigo || p.cupon.codigo === codigo));
}

async function consultarPedidosRest(codigo) {
  if (typeof fetch !== 'function') return null;
  let token;
  try {
    token = await auth.currentUser?.getIdToken?.();
  } catch { return null; }
  if (!token) return null;

  const consulta = {
    from: [{ collectionId: 'tienda_pedidos' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'cupon.codigo' },
        op: codigo ? 'EQUAL' : 'NOT_EQUAL',
        value: codigo ? codificarValor(codigo) : { nullValue: null },
      },
    },
    limit: 3000,
    ...(codigo ? {} : { select: { fields: ['estado', 'cliente', 'uid', 'total', 'cupon', 'creado']
      .map(c => ({ fieldPath: c })) } }),
  };

  try {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), 8000);
    const r = await fetch(`${REST}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ structuredQuery: consulta }),
      signal: control.signal,
    }).finally(() => clearTimeout(reloj));
    if (!r.ok) return null;
    const filas = await r.json();
    return (Array.isArray(filas) ? filas : [])
      .filter(f => f?.document?.name)
      .map(f => ({ id: String(f.document.name).split('/').pop(), ...decodificarCampos(f.document.fields) }))
      .filter(p => p?.cupon?.codigo);
  } catch (err) {
    console.warn('[cupones] los pedidos por REST no respondieron, se usa el SDK:', err?.message || err);
    return null;
  }
}

/* ── Cómo se lee un cupón ─────────────────────────────────────────────────── */

/** "3/9" de un "2026-09-03". */
function fechaCorta(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(texto || ''));
  return m ? `${Number(m[3])}/${Number(m[2])}` : '';
}

function estadoDe(c, resumen) {
  if (c.activo === false) return { texto: 'Apagado', clase: 'badge-gray' };
  const ahora = hoy();
  const hasta = limiteDeDia(c.hasta, true);
  if (hasta && ahora > hasta) return { texto: 'Vencido', clase: 'badge-gray' };
  const desde = limiteDeDia(c.desde);
  if (desde && ahora < desde) return { texto: `Empieza el ${fechaCorta(c.desde)}`, clase: 'badge-orange' };
  const totales = Number(c.usos_totales) || 0;
  if (totales > 0 && resumen && resumen.usos >= totales) return { texto: 'Agotado', clase: 'badge-orange' };
  return { texto: 'Activo', clase: 'badge-green' };
}

/** Las condiciones, en una línea: lo que el local tiene que recordar de un vistazo. */
function condicionesDe(c) {
  const partes = [];
  if (Number(c.minimo_compra) > 0) partes.push(`compras desde ${pesos(c.minimo_compra)}`);
  const porPersona = Number(c.usos_por_persona) || 0;
  if (porPersona > 0) partes.push(porPersona === 1 ? 'una vez por persona' : `${porPersona} veces por persona`);
  const totales = Number(c.usos_totales) || 0;
  if (totales > 0) partes.push(`${totales} usos en total`);
  if (c.desde && c.hasta) partes.push(`del ${fechaCorta(c.desde)} al ${fechaCorta(c.hasta)}`);
  else if (c.desde) partes.push(`desde el ${fechaCorta(c.desde)}`);
  else if (c.hasta) partes.push(`hasta el ${fechaCorta(c.hasta)}`);
  if (c.solo_primera_compra) partes.push('solo primera compra');
  if (c.entrega === 'retiro') partes.push('solo retirando');
  if (c.entrega === 'delivery') partes.push('solo con envío');
  return partes;
}

function usosTexto(resumen) {
  if (resumen === undefined) return 'contando…';
  if (!resumen || !resumen.usos) return 'Todavía nadie lo usó';
  return `${resumen.usos} pedido${resumen.usos === 1 ? '' : 's'} · ${resumen.personas} persona${
    resumen.personas === 1 ? '' : 's'} · ${pesos(resumen.descontado)} descontados`;
}

/* ── Pintado ──────────────────────────────────────────────────────────────── */

function tarjeta(c) {
  const resumen = _usos.get(c._id);
  const estado = estadoDe(c, resumen);
  const condiciones = condicionesDe(c);
  const alcance = c.aplica?.modo && c.aplica.modo !== 'todo' ? ` en ${describirAlcance(c)}` : '';

  return `
    <div class="card cupon-card" data-id="${escHtml(c._id)}"
         style="${c.activo === false ? 'opacity:.6' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div style="min-width:0">
          <div class="cupon-codigo">${escHtml(c.codigo || c._id)}</div>
          <div style="font-weight:700;font-size:14.5px;margin-top:4px">${escHtml(c.nombre || '')}</div>
          <div style="font-size:12.5px;color:var(--text-muted);margin-top:2px">
            ${escHtml(describirCupon(c))}${escHtml(alcance)}
          </div>
        </div>
        <span class="badge ${estado.clase}" style="white-space:nowrap">${escHtml(estado.texto)}</span>
      </div>
      ${condiciones.length ? `
        <div style="font-size:12.5px;color:var(--text-muted);line-height:1.5">
          ${condiciones.map(escHtml).join(' · ')}
        </div>` : ''}
      <div style="font-size:12.5px;color:${resumen?.usos ? 'var(--text)' : 'var(--text-muted)'}">
        <span class="material-icons" style="font-size:14px;vertical-align:-2px">receipt_long</span>
        ${escHtml(usosTexto(resumen))}
      </div>
      ${c.nota_interna ? `
        <div style="font-size:12px;color:var(--text-muted);font-style:italic">${escHtml(c.nota_interna)}</div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="pc-btn" data-accion="usos" data-id="${escHtml(c._id)}">Ver usos</button>
        <button class="pc-btn" data-accion="editar" data-id="${escHtml(c._id)}">Editar</button>
        <button class="pc-btn" data-accion="alternar" data-id="${escHtml(c._id)}">
          ${c.activo === false ? 'Activar' : 'Apagar'}
        </button>
        <button class="pc-btn" data-accion="borrar" data-id="${escHtml(c._id)}"
                style="color:var(--tint-red-fg)">Borrar</button>
      </div>
    </div>`;
}

function pintar() {
  const caja = document.getElementById('cupLista');
  if (!caja) return;
  if (!_cupones.length) {
    caja.innerHTML = `
      <div class="card" style="padding:28px;text-align:center;color:var(--text-muted);grid-column:1/-1">
        <span class="material-icons" style="font-size:34px;opacity:.4">confirmation_number</span>
        <p style="margin:10px 0 0;font-size:14px;line-height:1.5">
          Todavía no hay cupones.<br>
          Con "Nuevo cupón" armás un código para pasarle a los clientes: un porcentaje,
          una plata fija o el envío sin cargo, con las condiciones que quieras.
        </p>
      </div>`;
    return;
  }
  caja.innerHTML = _cupones.map(tarjeta).join('');
}

/* ── Alta y edición ───────────────────────────────────────────────────────── */

function abrirEditor(c = null) {
  const rubros = [...new Set(_catalogo.map(p => claveDeRubro(p.rubro)).filter(Boolean))].sort();
  const elegidos = new Set((c?.aplica?.productos || []).map(String));

  document.querySelector('.cup-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay cup-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:620px;width:100%">
      <div class="modal-header">
        <h3 style="margin:0;font-size:16px">${c ? 'Editar cupón' : 'Nuevo cupón'}</h3>
        <button class="cup-cerrar" style="background:none;border:none;cursor:pointer;color:var(--text-muted)">
          <span class="material-icons">close</span>
        </button>
      </div>
      <div style="padding:16px 20px;display:flex;flex-direction:column;gap:14px;max-height:70vh;overflow-y:auto">

        <div style="display:flex;gap:10px;align-items:flex-end">
          <label style="flex:1">
            <span class="cup-lbl">Código</span>
            <input type="text" id="cuCodigo" maxlength="20" class="cup-input cup-input--codigo"
                   value="${escHtml(c?.codigo || c?._id || '')}" ${c ? 'disabled' : ''}
                   placeholder="BIENVENIDA" autocomplete="off" spellcheck="false">
          </label>
          ${c ? '' : '<button type="button" class="pc-btn" id="cuGenerar" style="height:40px">Generar</button>'}
        </div>
        ${c ? '<div class="cup-ayuda">El código no se cambia: es lo que ya circula. Para otro código, armá otro cupón.</div>'
            : '<div class="cup-ayuda">Letras y números, sin espacios. Es lo que el cliente escribe en el checkout.</div>'}

        <label>
          <span class="cup-lbl">Nombre</span>
          <input type="text" id="cuNombre" maxlength="60" class="cup-input"
                 value="${escHtml(c?.nombre || '')}" placeholder="Cupón de bienvenida">
          <div class="cup-ayuda">Lo ve el cliente al lado del código cuando lo aplica.</div>
        </label>

        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label style="flex:1;min-width:160px">
            <span class="cup-lbl">Qué descuenta</span>
            <select id="cuTipo" class="cup-input">
              <option value="porcentaje" ${!c || c.tipo === 'porcentaje' ? 'selected' : ''}>Porcentaje %</option>
              <option value="monto" ${c?.tipo === 'monto' ? 'selected' : ''}>Plata fija $</option>
              <option value="envio_gratis" ${c?.tipo === 'envio_gratis' ? 'selected' : ''}>Envío sin cargo</option>
            </select>
          </label>
          <label style="width:120px" id="cuCajaValor">
            <span class="cup-lbl" id="cuLblValor">Cuánto</span>
            <input type="number" id="cuValor" min="1" step="1" class="cup-input"
                   value="${escHtml(String(c?.valor ?? ''))}" placeholder="10">
          </label>
          <label style="width:150px" id="cuCajaTope">
            <span class="cup-lbl">Tope en $</span>
            <input type="number" id="cuTope" min="0" step="100" class="cup-input"
                   value="${escHtml(String(c?.tope ?? ''))}" placeholder="sin tope">
          </label>
        </div>

        <label>
          <span class="cup-lbl">Compra mínima en $</span>
          <input type="number" id="cuMinimo" min="0" step="500" class="cup-input"
                 value="${escHtml(String(c?.minimo_compra ?? ''))}" placeholder="sin mínimo">
          <div class="cup-ayuda">Sobre los productos, sin el envío. Si no llega, el cliente ve cuánto le falta.</div>
        </label>

        <label>
          <span class="cup-lbl">Se aplica a</span>
          <select id="cuAlcance" class="cup-input">
            <option value="todo" ${!c || c.aplica?.modo === 'todo' || !c.aplica ? 'selected' : ''}>Todo el pedido</option>
            <option value="rubros" ${c?.aplica?.modo === 'rubros' ? 'selected' : ''}>Algunos rubros</option>
            <option value="productos" ${c?.aplica?.modo === 'productos' ? 'selected' : ''}>Algunos productos</option>
          </select>
        </label>

        <div id="cuCajaRubros" hidden>
          <span class="cup-lbl">Rubros</span>
          <div class="cup-rubros">
            ${rubros.map(r => `
              <label class="cup-rubro">
                <input type="checkbox" value="${escHtml(r)}"
                       ${(c?.aplica?.rubros || []).map(claveDeRubro).includes(r) ? 'checked' : ''}>
                <span>${escHtml(nombreBonito(r))}</span>
              </label>`).join('')}
          </div>
        </div>

        <div id="cuCajaProductos" hidden>
          <span class="cup-lbl">Productos</span>
          <div id="cuElegidos" class="cup-elegidos"></div>
          <input type="text" id="cuBuscar" class="cup-input" placeholder="Buscar por nombre o código…" autocomplete="off">
          <div id="cuResultados" class="cup-resultados"></div>
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label style="flex:1;min-width:140px">
            <span class="cup-lbl">Veces por persona</span>
            <input type="number" id="cuPorPersona" min="0" step="1" class="cup-input"
                   value="${escHtml(String(c?.usos_por_persona ?? ''))}" placeholder="sin límite">
          </label>
          <label style="flex:1;min-width:140px">
            <span class="cup-lbl">Usos en total</span>
            <input type="number" id="cuTotales" min="0" step="1" class="cup-input"
                   value="${escHtml(String(c?.usos_totales ?? ''))}" placeholder="sin límite">
          </label>
        </div>
        <div class="cup-ayuda" style="margin-top:-8px">
          La persona se reconoce por el teléfono, y por la cuenta si entró con una.
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label style="flex:1;min-width:140px">
            <span class="cup-lbl">Vale desde</span>
            <input type="date" id="cuDesde" class="cup-input" value="${escHtml(c?.desde || '')}">
          </label>
          <label style="flex:1;min-width:140px">
            <span class="cup-lbl">Hasta</span>
            <input type="date" id="cuHasta" class="cup-input" value="${escHtml(c?.hasta || '')}">
          </label>
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <label style="flex:1;min-width:180px">
            <span class="cup-lbl">Forma de entrega</span>
            <select id="cuEntrega" class="cup-input">
              <option value="cualquiera" ${!c?.entrega || c.entrega === 'cualquiera' ? 'selected' : ''}>Cualquiera</option>
              <option value="retiro" ${c?.entrega === 'retiro' ? 'selected' : ''}>Solo retirando por el local</option>
              <option value="delivery" ${c?.entrega === 'delivery' ? 'selected' : ''}>Solo con envío</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:9px;cursor:pointer;padding-top:18px">
            <input type="checkbox" id="cuPrimera" ${c?.solo_primera_compra ? 'checked' : ''}
                   style="width:17px;height:17px;accent-color:var(--primary);cursor:pointer">
            <span style="font-size:13px">Solo para la primera compra</span>
          </label>
        </div>

        <label>
          <span class="cup-lbl">Nota interna</span>
          <input type="text" id="cuNota" maxlength="120" class="cup-input"
                 value="${escHtml(c?.nota_interna || '')}" placeholder="Para el grupo de WhatsApp de septiembre">
          <div class="cup-ayuda">Solo la ve el panel.</div>
        </label>

        <div id="cuPreview" style="padding:11px 13px;border-radius:8px;background:var(--surface-2);
                                   border:1px solid var(--border);font-size:13px;line-height:1.55"></div>
      </div>
      <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;
                  justify-content:flex-end;gap:8px;background:var(--surface-2)">
        <button class="pc-btn cup-cancelar">Cancelar</button>
        <button class="btn-primary cup-guardar">${c ? 'Guardar cambios' : 'Crear cupón'}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = sel => overlay.querySelector(sel);
  const cerrar = () => overlay.remove();
  $('.cup-cerrar').addEventListener('click', cerrar);
  $('.cup-cancelar').addEventListener('click', cerrar);
  overlay.addEventListener('click', ev => { if (ev.target === overlay) cerrar(); });

  $('#cuGenerar')?.addEventListener('click', () => {
    $('#cuCodigo').value = generarCodigo('', 6);
    previsualizar();
  });
  $('#cuCodigo').addEventListener('input', ev => {
    // Se ve en mayúsculas mientras se escribe: es como va a quedar.
    const pos = ev.target.selectionStart;
    ev.target.value = normalizarCodigo(ev.target.value);
    try { ev.target.setSelectionRange(pos, pos); } catch { /* no importa */ }
    previsualizar();
  });

  /* Productos: buscador con lista abajo y lo elegido arriba, como chips. */
  const buscador = $('#cuBuscar');
  const resultados = $('#cuResultados');
  const cajaElegidos = $('#cuElegidos');

  function pintarElegidos() {
    if (!elegidos.size) {
      cajaElegidos.innerHTML = '<span class="cup-ayuda">Todavía no elegiste ninguno.</span>';
      return;
    }
    cajaElegidos.innerHTML = [...elegidos].map(id => {
      const p = _catalogo.find(x => String(x.doc_id) === id);
      return `
        <span class="cup-chip">
          ${escHtml(p ? nombreBonito(p.nombre) : id)}
          <button type="button" data-sacar="${escHtml(id)}" aria-label="Sacar">
            <span class="material-icons" style="font-size:14px">close</span>
          </button>
        </span>`;
    }).join('');
  }

  function pintarResultados() {
    const q = buscador.value.trim().toLowerCase();
    const lista = _catalogo
      .filter(p => q && (String(p.nombre || '').toLowerCase().includes(q)
        || String(p.doc_id || '').toLowerCase().includes(q)))
      .slice(0, 40);
    if (!q) { resultados.innerHTML = ''; return; }
    if (!lista.length) {
      resultados.innerHTML = '<div class="cup-vacio">No hay nada con ese nombre.</div>';
      return;
    }
    resultados.innerHTML = lista.map(p => `
      <button type="button" class="cup-fila${elegidos.has(String(p.doc_id)) ? ' cup-fila--elegida' : ''}"
              data-prod="${escHtml(p.doc_id)}">
        <span class="cup-fila__nombre">${escHtml(nombreBonito(p.nombre))}</span>
        <span class="cup-fila__meta">${escHtml(p.doc_id)} · ${pesos(p.precio_venta)}</span>
      </button>`).join('');
  }

  resultados.addEventListener('click', ev => {
    const fila = ev.target.closest('[data-prod]');
    if (!fila) return;
    const id = fila.dataset.prod;
    if (elegidos.has(id)) elegidos.delete(id); else elegidos.add(id);
    pintarElegidos();
    pintarResultados();
    previsualizar();
  });
  cajaElegidos.addEventListener('click', ev => {
    const boton = ev.target.closest('[data-sacar]');
    if (!boton) return;
    elegidos.delete(boton.dataset.sacar);
    pintarElegidos();
    pintarResultados();
    previsualizar();
  });
  buscador.addEventListener('input', pintarResultados);

  function acomodarCampos() {
    const tipo = $('#cuTipo').value;
    $('#cuCajaValor').hidden = tipo === 'envio_gratis';
    $('#cuCajaTope').hidden = tipo !== 'porcentaje';
    $('#cuLblValor').textContent = tipo === 'monto' ? 'Cuánto en $' : 'Cuánto en %';
    $('#cuValor').placeholder = tipo === 'monto' ? '5000' : '10';
    const alcance = $('#cuAlcance').value;
    $('#cuCajaRubros').hidden = alcance !== 'rubros';
    $('#cuCajaProductos').hidden = alcance !== 'productos';
    if (tipo === 'envio_gratis' && $('#cuEntrega').value !== 'delivery') {
      // El envío gratis solo tiene sentido con envío.
      $('#cuEntrega').value = 'delivery';
    }
  }

  /** Lo que hay en el formulario, como documento. `error` si algo no cierra. */
  function leerFormulario() {
    const codigo = normalizarCodigo($('#cuCodigo').value);
    const nombre = $('#cuNombre').value.trim();
    const tipo = $('#cuTipo').value;
    const valor = Number($('#cuValor').value) || 0;
    const tope = Number($('#cuTope').value) || 0;
    const minimo = Number($('#cuMinimo').value) || 0;
    const alcance = $('#cuAlcance').value;
    const rubrosElegidos = [...overlay.querySelectorAll('#cuCajaRubros input:checked')].map(i => i.value);
    const porPersona = Number($('#cuPorPersona').value) || 0;
    const totales = Number($('#cuTotales').value) || 0;
    const desde = $('#cuDesde').value || null;
    const hasta = $('#cuHasta').value || null;

    let error = null;
    if (!codigoValido(codigo)) error = 'El código lleva entre 4 y 20 letras o números, sin espacios.';
    else if (!c && _cupones.some(x => normalizarCodigo(x.codigo || x._id) === codigo)) error = 'Ya hay un cupón con ese código.';
    else if (!nombre) error = 'Poné un nombre: es lo que el cliente ve al lado del código.';
    else if (!TIPOS.includes(tipo)) error = 'Elegí qué descuenta.';
    else if (tipo === 'porcentaje' && !(valor > 0 && valor <= 100)) error = 'El porcentaje va de 1 a 100.';
    else if (tipo === 'monto' && !(valor > 0)) error = 'Poné cuánta plata descuenta.';
    else if (tipo === 'monto' && minimo > 0 && valor >= minimo) error = 'La plata fija tiene que ser menor que la compra mínima, si no el pedido sale gratis.';
    else if (!ALCANCES.includes(alcance)) error = 'Elegí sobre qué se aplica.';
    else if (alcance === 'rubros' && !rubrosElegidos.length) error = 'Marcá al menos un rubro.';
    else if (alcance === 'productos' && !elegidos.size) error = 'Elegí al menos un producto.';
    else if (!Number.isInteger(porPersona) || porPersona < 0 || !Number.isInteger(totales) || totales < 0) error = 'Los usos son números enteros.';
    else if (desde && hasta && desde > hasta) error = 'La fecha "desde" no puede ser después de "hasta".';

    let etiqueta = null;
    if (alcance === 'productos') {
      const ids = [...elegidos];
      const unico = ids.length === 1 ? _catalogo.find(p => String(p.doc_id) === ids[0]) : null;
      etiqueta = unico ? nombreBonito(unico.nombre) : `${ids.length} productos`;
    } else if (alcance === 'rubros') {
      const nombres = rubrosElegidos.map(nombreBonito);
      etiqueta = nombres.length <= 2 ? nombres.join(' y ') : `${nombres.slice(0, -1).join(', ')} y ${nombres.at(-1)}`;
    }

    const datos = {
      codigo,
      nombre,
      tipo,
      valor: tipo === 'envio_gratis' ? null : valor,
      tope: tipo === 'porcentaje' && tope > 0 ? tope : null,
      minimo_compra: minimo > 0 ? minimo : null,
      aplica: {
        modo: alcance,
        productos: alcance === 'productos' ? [...elegidos] : [],
        rubros: alcance === 'rubros' ? rubrosElegidos : [],
        etiqueta,
      },
      usos_por_persona: porPersona > 0 ? porPersona : null,
      usos_totales: totales > 0 ? totales : null,
      desde,
      hasta,
      solo_primera_compra: $('#cuPrimera').checked,
      entrega: ENTREGAS.includes($('#cuEntrega').value) ? $('#cuEntrega').value : 'cualquiera',
      nota_interna: $('#cuNota').value.trim() || null,
      activo: c ? c.activo !== false : true,
    };
    return { datos, error };
  }

  function previsualizar() {
    const { datos, error } = leerFormulario();
    const caja = $('#cuPreview');
    if (error) {
      caja.innerHTML = `<span style="color:var(--text-muted)">${escHtml(error)}</span>`;
      return;
    }
    const condiciones = condicionesDe(datos);
    const donde = datos.aplica.modo === 'todo' ? '' : ` en ${describirAlcance(datos)}`;
    caja.innerHTML = `
      Con el código <b class="cupon-codigo" style="font-size:14px">${escHtml(datos.codigo)}</b>:
      <b>${escHtml(describirCupon(datos))}</b>${escHtml(donde)}${
        condiciones.length ? `<br><span style="color:var(--text-muted)">${escHtml(condiciones.join(' · '))}.</span>` : ''}`;
  }

  ['#cuTipo', '#cuAlcance', '#cuEntrega'].forEach(sel => $(sel).addEventListener('change', () => { acomodarCampos(); previsualizar(); }));
  ['#cuNombre', '#cuValor', '#cuTope', '#cuMinimo', '#cuPorPersona', '#cuTotales', '#cuDesde', '#cuHasta', '#cuNota']
    .forEach(sel => $(sel).addEventListener('input', previsualizar));
  $('#cuPrimera').addEventListener('change', previsualizar);
  overlay.querySelectorAll('#cuCajaRubros input').forEach(i => i.addEventListener('change', previsualizar));

  acomodarCampos();
  pintarElegidos();
  previsualizar();
  if (!c) $('#cuCodigo').focus();

  $('.cup-guardar').addEventListener('click', async ev => {
    const { datos, error } = leerFormulario();
    if (error) {
      alertDialog({ title: 'Revisá el cupón', message: escHtml(error), type: 'warning' });
      return;
    }
    const boton = ev.currentTarget;
    boton.disabled = true;
    boton.textContent = 'Guardando…';
    try {
      const id = c?._id || datos.codigo;
      const marca = c
        ? { actualizado: serverTimestamp() }
        : { creado: serverTimestamp(), creado_por: auth.currentUser?.email || null, actualizado: serverTimestamp() };
      await setDoc(doc(_db, 'tienda_cupones', id), { ...datos, ...marca }, { merge: true });
      cerrar();
      reemplazarEnLista({ ...(c || {}), ...datos, _id: id });
      avisar(c ? 'Cupón guardado' : `Cupón ${datos.codigo} creado`);
    } catch (e) {
      boton.disabled = false;
      boton.textContent = c ? 'Guardar cambios' : 'Crear cupón';
      alertDialog({ title: 'No se pudo guardar', message: escHtml(e?.message || String(e)), type: 'error' });
    }
  });
}

/* ── Los usos de un cupón ─────────────────────────────────────────────────── */

function cuando(valor) {
  const d = valor?.toDate?.() ?? (valor ? new Date(valor) : null);
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const ETIQUETA_ESTADO = {
  nuevo: 'Nuevo', preparando: 'Preparando', listo: 'Listo', en_camino: 'En camino',
  entregado: 'Entregado', cancelado: 'Cancelado',
};

async function abrirUsos(c) {
  document.querySelector('.cup-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay cup-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:760px;width:100%">
      <div class="modal-header">
        <h3 style="margin:0;font-size:16px">
          Usos de <span class="cupon-codigo" style="font-size:15px">${escHtml(c.codigo || c._id)}</span>
        </h3>
        <button class="cup-cerrar" style="background:none;border:none;cursor:pointer;color:var(--text-muted)">
          <span class="material-icons">close</span>
        </button>
      </div>
      <div id="cuUsos" style="padding:16px 20px;max-height:70vh;overflow-y:auto">
        <div class="skel skel-card" style="height:120px"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const cerrar = () => overlay.remove();
  overlay.querySelector('.cup-cerrar').addEventListener('click', cerrar);
  overlay.addEventListener('click', ev => { if (ev.target === overlay) cerrar(); });

  const caja = overlay.querySelector('#cuUsos');
  let resumen;
  try {
    const pedidos = await pedidosConCupon(c.codigo || c._id);
    resumen = resumenDeUsos(pedidos, c.codigo || c._id);
    _usos.set(c._id, resumen);
    pintar();
  } catch (e) {
    caja.innerHTML = `<p style="color:var(--tint-red-fg)">No se pudieron leer los pedidos: ${escHtml(e?.message || String(e))}</p>`;
    return;
  }

  if (!resumen.usos && !resumen.cancelados) {
    caja.innerHTML = `
      <p style="margin:0;color:var(--text-muted);font-size:14px;line-height:1.5">
        Todavía nadie usó este cupón. Cuando entre un pedido con el código, acá
        van a aparecer quién lo usó, cuánto se descontó y en qué productos.
      </p>`;
    return;
  }

  const dato = (titulo, valor) => `
    <div style="flex:1;min-width:120px;padding:10px 12px;border-radius:8px;background:var(--surface-2);border:1px solid var(--border)">
      <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px">${titulo}</div>
      <div style="font-size:19px;font-weight:800;margin-top:2px">${valor}</div>
    </div>`;

  caja.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      ${dato('Pedidos', resumen.usos)}
      ${dato('Personas', resumen.personas)}
      ${dato('Descontado', pesos(resumen.descontado))}
      ${dato('Vendido con cupón', pesos(resumen.vendido))}
      ${resumen.cancelados ? dato('Cancelados', resumen.cancelados) : ''}
    </div>

    ${resumen.productos.length ? `
      <h4 style="margin:0 0 8px;font-size:13px">En qué productos</h4>
      <table class="tienda-tabla cup-tabla">
        <thead><tr><th>Producto</th><th>Pedidos</th><th>Cantidad</th><th>Descontado</th></tr></thead>
        <tbody>
          ${resumen.productos.slice(0, 30).map(p => `
            <tr>
              <td>${escHtml(nombreBonito(p.nombre))}</td>
              <td>${p.pedidos}</td>
              <td>${escHtml(String(p.cantidad).replace('.', ','))}</td>
              <td>${pesos(p.descuento)}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : ''}

    <h4 style="margin:16px 0 8px;font-size:13px">Quién lo usó</h4>
    <table class="tienda-tabla cup-tabla">
      <thead><tr><th>Cuándo</th><th>Pedido</th><th>Cliente</th><th>Total</th><th>Descuento</th><th>Estado</th></tr></thead>
      <tbody>
        ${resumen.pedidos
          .sort((a, b) => (b.creado?.toMillis?.() ?? Date.parse(b.creado) ?? 0) - (a.creado?.toMillis?.() ?? Date.parse(a.creado) ?? 0))
          .map(p => `
          <tr>
            <td style="white-space:nowrap">${escHtml(cuando(p.creado))}</td>
            <td><span class="cupon-codigo" style="font-size:13px">${escHtml(p.codigo || '')}</span></td>
            <td>${escHtml(p.cliente?.nombre || '')}<br>
                <span style="color:var(--text-muted);font-size:12px">${escHtml(p.cliente?.telefono || '')}</span></td>
            <td>${pesos(p.total)}</td>
            <td style="color:var(--tint-green-fg);font-weight:600">−${pesos(p.cupon?.descuento)}</td>
            <td>${escHtml(ETIQUETA_ESTADO[p.estado] || p.estado || '')}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

/* ── Avisos y carga ───────────────────────────────────────────────────────── */

function avisar(texto) {
  const caja = document.getElementById('cupAviso');
  if (!caja) return;
  caja.textContent = texto;
  caja.style.opacity = '1';
  clearTimeout(avisar._t);
  avisar._t = setTimeout(() => { caja.style.opacity = '0'; }, 2600);
}

function reemplazarEnLista(c) {
  _cupones = _cupones.filter(x => x._id !== c._id).concat([c])
    .sort((a, b) => String(a.codigo || a._id).localeCompare(String(b.codigo || b._id), 'es'));
  pintar();
}

async function contarUsos() {
  try {
    _pedidosConCupon = await pedidosConCupon();
  } catch (e) {
    console.warn('[cupones] no se pudieron contar los usos:', e?.message || e);
    _pedidosConCupon = [];
  }
  for (const c of _cupones) {
    _usos.set(c._id, resumenDeUsos(_pedidosConCupon, c.codigo || c._id));
  }
  pintar();
}

async function recargar() {
  const snap = await getDocs(query(collection(_db, 'tienda_cupones')));
  _cupones = snap.docs.map(x => ({ _id: x.id, ...x.data() }))
    .sort((a, b) => String(a.codigo || a._id).localeCompare(String(b.codigo || b._id), 'es'));
  pintar();
  if (_cupones.length) await contarUsos();
}

export async function renderTiendaCupones(container, db) {
  _db = db;
  _usos = new Map();

  container.innerHTML = `
    <style>
      .cup-lbl { display:block; font-size:11.5px; font-weight:700; color:var(--text-muted);
                 text-transform:uppercase; letter-spacing:.4px; margin-bottom:4px }
      .cup-input { width:100%; padding:9px 11px; border:1.5px solid var(--border);
                   border-radius:8px; font-size:13.5px; box-sizing:border-box;
                   background:var(--surface); color:var(--text) }
      .cup-input--codigo { font-family:ui-monospace,monospace; font-weight:800; letter-spacing:2px;
                           text-transform:uppercase }
      .cup-input:disabled { opacity:.7 }
      .cup-ayuda { font-size:12px; color:var(--text-muted); margin-top:4px; line-height:1.4 }
      .cupon-codigo { display:inline-block; font-family:ui-monospace,monospace; font-weight:800;
                      font-size:17px; letter-spacing:2px; padding:2px 8px; border-radius:6px;
                      background:var(--surface-2); border:1px dashed var(--border) }
      .cupon-card { padding:14px; display:flex; flex-direction:column; gap:10px }
      .cup-rubros { display:flex; flex-wrap:wrap; gap:6px }
      .cup-rubro { display:inline-flex; align-items:center; gap:6px; padding:6px 10px;
                   border:1.5px solid var(--border); border-radius:99px; font-size:12.5px;
                   cursor:pointer; background:var(--surface) }
      .cup-rubro:has(input:checked) { border-color:var(--primary); background:var(--primary); color:#fff }
      .cup-rubro input { width:14px; height:14px; accent-color:var(--primary) }
      .cup-elegidos { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; min-height:22px }
      .cup-chip { display:inline-flex; align-items:center; gap:4px; padding:4px 6px 4px 10px;
                  border-radius:99px; background:var(--primary); color:#fff; font-size:12.5px }
      .cup-chip button { display:inline-flex; background:rgba(255,255,255,.2); border:0; color:#fff;
                         border-radius:99px; width:18px; height:18px; align-items:center;
                         justify-content:center; cursor:pointer; padding:0 }
      .cup-resultados { margin-top:6px; max-height:210px; overflow-y:auto;
                        border:1.5px solid var(--border); border-radius:8px; background:var(--surface) }
      .cup-resultados:empty { display:none }
      .cup-fila { display:flex; flex-direction:column; gap:2px; width:100%; padding:8px 11px; border:0;
                  border-bottom:1px solid var(--border); background:transparent; color:var(--text);
                  font-family:inherit; text-align:left; cursor:pointer }
      .cup-fila:last-child { border-bottom:0 }
      .cup-fila:hover { background:var(--surface-2) }
      .cup-fila--elegida { background:var(--primary); color:#fff }
      .cup-fila--elegida:hover { background:var(--primary-dark); color:#fff }
      .cup-fila--elegida .cup-fila__meta { color:rgba(255,255,255,.85) }
      .cup-fila__nombre { font-size:13px; font-weight:600 }
      .cup-fila__meta { font-size:11.5px; color:var(--text-muted) }
      .cup-vacio { padding:14px; text-align:center; font-size:12.5px; color:var(--text-muted) }
      .cup-tabla { width:100%; border-collapse:collapse; font-size:13px }
      .cup-tabla th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.4px;
                      color:var(--text-muted); padding:6px 8px; border-bottom:1px solid var(--border) }
      .cup-tabla td { padding:7px 8px; border-bottom:1px solid var(--border); vertical-align:top }
    </style>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;
                flex-wrap:wrap;gap:10px">
      <div>
        <h3 style="margin:0">
          <span class="material-icons" style="vertical-align:middle;margin-right:6px;color:var(--primary)">confirmation_number</span>
          Cupones de la tienda
        </h3>
        <div style="font-size:12.5px;color:var(--text-muted);margin-top:3px">
          Códigos para pasarle a los clientes. Lo que descuentan lo decide el servidor al
          guardar el pedido, con estas mismas reglas.
        </div>
      </div>
      <span id="cupAviso" style="font-size:12.5px;color:var(--tint-green-fg);font-weight:600;
                                 opacity:0;transition:opacity .2s;margin-left:auto"></span>
      <button class="btn-primary" id="cupNuevo">
        <span class="material-icons" style="font-size:18px">add</span> Nuevo cupón
      </button>
    </div>
    <div id="cupLista" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px">
      ${Array(3).fill('<div class="skel skel-card" style="height:170px"></div>').join('')}
    </div>`;

  _catalogo = (await getCached('catalogo:all', async () => {
    const snap = await getDocs(query(collection(db, 'catalogo')));
    return snap.docs.map(d => ({ ...d.data(), doc_id: d.id }));
  }, { ttl: 10 * 60 * 1000, memOnly: true })) || [];
  _catalogo = _catalogo
    .filter(p => p && p.doc_id && p.estado !== 'baja' && !p.duplicado)
    .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));

  await recargar();

  document.getElementById('cupNuevo').addEventListener('click', () => abrirEditor());

  document.getElementById('cupLista').addEventListener('click', async ev => {
    const boton = ev.target.closest('[data-accion]');
    if (!boton) return;
    const c = _cupones.find(x => x._id === boton.dataset.id);
    if (!c) return;

    if (boton.dataset.accion === 'editar') { abrirEditor(c); return; }
    if (boton.dataset.accion === 'usos') { abrirUsos(c); return; }

    if (boton.dataset.accion === 'alternar') {
      const activo = c.activo === false;
      c.activo = activo;
      pintar();
      try {
        await updateDoc(doc(_db, 'tienda_cupones', c._id), { activo, actualizado: serverTimestamp() });
        avisar(activo ? `${c.codigo || c._id} activado` : `${c.codigo || c._id} apagado`);
      } catch (e) {
        c.activo = !activo;
        pintar();
        alertDialog({ title: 'No se pudo cambiar', message: escHtml(e?.message || String(e)), type: 'error' });
      }
      return;
    }

    if (boton.dataset.accion === 'borrar') {
      const resumen = _usos.get(c._id);
      const ok = await confirmDialog({
        title: 'Borrar cupón',
        message: `¿Borrar <b>${escHtml(c.codigo || c._id)}</b>?${
          resumen?.usos ? ` Ya se usó en ${resumen.usos} pedido${resumen.usos === 1 ? '' : 's'}; esos pedidos no cambian.` : ''
        }<br>Si lo que querés es que deje de valer un tiempo, mejor apagalo.`,
        confirmText: 'Borrar',
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteDoc(doc(_db, 'tienda_cupones', c._id));
        _cupones = _cupones.filter(x => x._id !== c._id);
        _usos.delete(c._id);
        pintar();
      } catch (e) {
        alertDialog({ title: 'No se pudo borrar', message: escHtml(e?.message || String(e)), type: 'error' });
      }
    }
  });
}
