/**
 * Reclamos de la tienda online.
 *
 * Lo que los clientes cuentan desde la pantalla de su pedido: qué pasó, con qué
 * producto, el detalle y hasta tres fotos. Acá se leen y se contestan.
 *
 * Cada reclamo tiene cuatro estados y un botón para cada paso: "Lo estoy
 * revisando" le dice al cliente que alguien lo tomó; "Resolver" y "Rechazar"
 * piden la respuesta que el cliente va a leer en su pedido (rechazar sin
 * explicar por qué no se puede). Cada paso se escribe en el reclamo y en el
 * resumen que muestra el pedido, en una sola transacción, y después se le pide
 * a la tienda que le avise al celular.
 *
 * El resumen del pedido es el del último reclamo: si el cliente abrió otro
 * después, contestar el viejo no lo pisa.
 */
import { collection, doc, onSnapshot, query, orderBy, limit, runTransaction, serverTimestamp } from 'firebase/firestore';
import { verFotoGrande } from '../components/dialogs.js';
import { whatsappDe } from '../avisos_pedido.js';
import { avisarAlCliente, urlDeLaTienda } from '../avisos_cliente.js';
import { ABIERTOS, motivoLegible } from '../../../tienda/src/reclamos.js';
import '../styles/tienda.css';

const ESTADOS = {
  nuevo:     { etiqueta: 'Nuevo',     color: '#d9480f' },
  revisando: { etiqueta: 'Revisando', color: '#0d6efd' },
  resuelto:  { etiqueta: 'Resuelto',  color: '#2f7a3d' },
  rechazado: { etiqueta: 'Rechazado', color: '#6c757d' },
};

const FILTROS = [
  { clave: 'abiertos', texto: 'Abiertos',  estados: ABIERTOS },
  { clave: 'cerrados', texto: 'Cerrados',  estados: ['resuelto', 'rechazado'] },
  { clave: 'todos',    texto: 'Todos',     estados: null },
];

const RESPUESTA_MAX = 800;

let _unsub = null;
let _db = null;
let _reclamos = [];
let _filtro = 'abiertos';
// La respuesta que se está escribiendo: a qué reclamo y para qué estado.
let _editando = null;
let _error = null;
// id -> texto a medio escribir. Sobrevive a que la lista se vuelva a dibujar.
const _textos = new Map();
const _guardando = new Set();

function cleanup() {
  _unsub?.();
  _unsub = null;
}

/* ── Formato ─────────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "hace 4 min" · "14:30" · "ayer 14:30" · "3 sept 14:30" */
function cuando(marca) {
  if (!marca) return '';
  const fecha = marca.toDate ? marca.toDate() : new Date(marca);
  if (Number.isNaN(fecha.getTime())) return '';

  const minutos = Math.floor((Date.now() - fecha.getTime()) / 60000);
  if (minutos < 1) return 'recién';
  if (minutos < 60) return `hace ${minutos} min`;

  const hora = fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const hoy = new Date();
  if (fecha.toDateString() === hoy.toDateString()) return hora;
  const ayer = new Date(hoy);
  ayer.setDate(hoy.getDate() - 1);
  if (fecha.toDateString() === ayer.toDateString()) return `ayer ${hora}`;
  return `${fecha.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })} ${hora}`;
}

function cantidadDe(producto) {
  const n = Number(producto.cantidad);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}

/* ── Acciones ────────────────────────────────────────────────────────────── */

/**
 * Pasa un reclamo a otro estado.
 *
 * El resumen del pedido lleva la respuesta solo cuando el reclamo se cierra:
 * al reabrirlo el cliente deja de ver la respuesta vieja mientras se revisa de
 * nuevo. En el reclamo la respuesta queda guardada para quien lo retome.
 *
 * @returns {Promise<boolean>} si se guardó
 */
async function mover(reclamo, estado, respuesta) {
  const cierra = estado === 'resuelto' || estado === 'rechazado';
  const cambios = { estado, actualizado: serverTimestamp() };
  if (cierra) cambios.respuesta = respuesta || null;

  try {
    await runTransaction(_db, async (tx) => {
      const refPedido = doc(_db, 'tienda_pedidos', reclamo.pedido_id);
      // Todas las lecturas antes de la primera escritura (lo exige Firestore).
      const pedido = await tx.get(refPedido);
      tx.update(doc(_db, 'tienda_reclamos', reclamo.id), cambios);
      const resumen = pedido.exists() ? pedido.data()?.reclamo : null;
      if (resumen?.id === reclamo.id) {
        tx.update(refPedido, {
          reclamo: { ...resumen, estado, respuesta: cierra ? (respuesta || null) : null, actualizado: serverTimestamp() },
        });
      }
    });
  } catch (e) {
    console.warn('[reclamos] no se pudo mover el reclamo:', e);
    alert('No se pudo guardar el reclamo: ' + (e?.message || e) + '\nProbá de nuevo.');
    return false;
  }

  // Se ve ya, sin esperar a que la base lo devuelva por la escucha.
  const local = _reclamos.find(r => r.id === reclamo.id);
  if (local) {
    local.estado = estado;
    if (cierra) local.respuesta = respuesta || null;
  }
  avisarAlCliente(reclamo.pedido_id);
  return true;
}

/* ── Dibujo ──────────────────────────────────────────────────────────────── */

function visibles() {
  const f = FILTROS.find(x => x.clave === _filtro) || FILTROS[0];
  return f.estados ? _reclamos.filter(r => f.estados.includes(r.estado)) : _reclamos;
}

function editor(r) {
  const rechaza = _editando.estado === 'rechazado';
  const texto = _textos.has(r.id) ? _textos.get(r.id) : (r.respuesta || '');
  return `
    <div style="display:flex;flex-direction:column;gap:6px;background:var(--bg);border-radius:8px;padding:10px 12px">
      <label for="respuesta-${esc(r.id)}" style="font-size:13px;font-weight:700">
        ${rechaza ? 'Por qué no corresponde' : 'Cómo lo resolvieron'}
      </label>
      <textarea id="respuesta-${esc(r.id)}" data-respuesta rows="3" maxlength="${RESPUESTA_MAX}"
                placeholder="${rechaza
                  ? 'Por ejemplo: el producto llegó bien embalado y lo revisamos al entregarlo.'
                  : 'Por ejemplo: mañana te llevamos las dos cartulinas, sin cargo.'}"
                style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;
                       font:inherit;font-size:13.5px;resize:vertical;box-sizing:border-box">${esc(texto)}</textarea>
      <span style="font-size:12px;color:var(--text-muted)">
        El cliente lo lee en la página de su pedido y le llega al celular si activó los avisos.
      </span>
      ${_error ? `<span data-error-respuesta style="font-size:12.5px;font-weight:600;color:#dc3545">${esc(_error)}</span>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="pc-btn" data-act="guardar" ${_guardando.has(r.id) ? 'disabled' : ''}
                style="background:${ESTADOS[_editando.estado].color};color:#fff;border:none;font-weight:700">
          <span class="material-icons" style="font-size:18px">send</span>
          ${rechaza ? 'Rechazar y avisar' : 'Resolver y avisar'}
        </button>
        <button class="pc-btn" data-act="cancelar-edicion">Cancelar</button>
      </div>
    </div>`;
}

function tarjeta(r) {
  const e = ESTADOS[r.estado] || ESTADOS.nuevo;
  const abierto = ABIERTOS.includes(r.estado);
  const editando = _editando?.id === r.id;
  const ocupado = _guardando.has(r.id);
  const nombre = r?.cliente?.nombre || 'Sin nombre';
  const telefono = String(r?.cliente?.telefono || '').trim();
  const whatsapp = whatsappDe(r);
  const mensaje = encodeURIComponent(
    `Hola ${nombre}, te escribimos de Librería Liceo por tu reclamo del pedido ${r.pedido_codigo || ''}.`);
  const productos = Array.isArray(r.productos) ? r.productos : [];
  const fotos = Array.isArray(r.fotos) ? r.fotos.filter(f => f?.url) : [];

  return `
    <div class="reclamo-card" data-reclamo-id="${esc(r.id)}"
         style="background:var(--surface);border:1px solid var(--border);border-left:4px solid ${e.color};
                border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px">

      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-family:ui-monospace,monospace;font-weight:800;font-size:17px;letter-spacing:2px">${esc(r.pedido_codigo || '—')}</span>
        <span style="background:${e.color};color:#fff;font-size:11px;font-weight:700;padding:2px 9px;border-radius:99px;
                     text-transform:uppercase;letter-spacing:.4px">${e.etiqueta}</span>
        <b style="font-size:14px">${esc(motivoLegible(r.motivo))}</b>
        <span style="margin-left:auto;color:var(--text-muted);font-size:12.5px">${esc(cuando(r.creado))}</span>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:8px 18px;font-size:13.5px">
        <span><span class="material-icons" style="font-size:16px;vertical-align:-3px;color:var(--text-muted)">person</span>
          <b>${esc(nombre)}</b></span>
        ${!telefono ? '' : whatsapp
          ? `<a href="https://wa.me/${esc(whatsapp)}?text=${mensaje}" target="_blank" rel="noopener"
                style="color:#2f7a3d;font-weight:600;text-decoration:none">
               <span class="material-icons" style="font-size:16px;vertical-align:-3px">chat</span>
               ${esc(telefono)}</a>`
          : `<span style="color:var(--text-muted)">
               <span class="material-icons" style="font-size:16px;vertical-align:-3px">call</span>
               ${esc(telefono)}</span>`}
        <span style="color:var(--text-muted)">
          <span class="material-icons" style="font-size:16px;vertical-align:-3px">${
            r.entrega_modo === 'delivery' ? 'local_shipping' : 'storefront'}</span>
          ${r.entrega_modo === 'delivery' ? 'Envío a domicilio' : 'Retiró en el local'}
        </span>
      </div>

      ${productos.length ? `
        <div style="font-size:13px;display:flex;flex-direction:column;gap:2px">
          ${productos.map(p => `
            <div style="display:grid;grid-template-columns:36px 1fr;gap:8px;align-items:baseline">
              <b style="color:var(--text-muted);font-variant-numeric:tabular-nums">${esc(cantidadDe(p))}</b>
              <span>${esc(p.nombre)}${p.variedad ? `<span style="color:var(--text-muted)"> · ${esc(p.variedad)}</span>` : ''}</span>
            </div>`).join('')}
        </div>` : ''}

      <div style="background:var(--bg);border-radius:8px;padding:10px 12px;font-size:13.5px;line-height:1.5;white-space:pre-line">${esc(r.detalle || '')}</div>

      ${fotos.length ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${fotos.map((f, i) => `
            <button type="button" data-act="foto" data-url="${esc(f.url)}" title="Ver la foto en grande"
                    aria-label="Ver la foto ${i + 1} en grande"
                    style="width:84px;height:84px;padding:0;border:1px solid var(--border);border-radius:8px;
                           overflow:hidden;cursor:zoom-in;background:var(--bg)">
              <img src="${esc(f.url)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block">
            </button>`).join('')}
        </div>` : ''}

      ${r.respuesta && !editando ? `
        <div style="border:1px solid var(--border);border-radius:8px;padding:9px 12px;font-size:13px;line-height:1.45">
          <span style="display:block;font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.3px">
            Le respondieron</span>
          <span style="white-space:pre-line">${esc(r.respuesta)}</span>
        </div>` : ''}

      ${editando ? editor(r) : ''}

      <div style="display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--border);padding-top:10px">
        ${r.estado === 'nuevo' && !editando ? `
          <button class="pc-btn" data-act="revisando" ${ocupado ? 'disabled' : ''}
                  style="background:${ESTADOS.revisando.color};color:#fff;border:none;font-weight:700">
            <span class="material-icons" style="font-size:18px">visibility</span> Lo estoy revisando
          </button>` : ''}
        ${abierto && !editando ? `
          <button class="pc-btn" data-act="resolver" ${ocupado ? 'disabled' : ''}>
            <span class="material-icons" style="font-size:18px">check_circle</span> Resolver
          </button>
          <button class="pc-btn" data-act="rechazar" ${ocupado ? 'disabled' : ''}>
            <span class="material-icons" style="font-size:18px">block</span> Rechazar
          </button>` : ''}
        ${!abierto ? `
          <button class="pc-btn" data-act="reabrir" ${ocupado ? 'disabled' : ''}>
            <span class="material-icons" style="font-size:18px">undo</span> Reabrir
          </button>` : ''}
        <a class="pc-btn" href="${esc(`${urlDeLaTienda()}/pedido/${r.pedido_id}`)}" target="_blank" rel="noopener"
           style="margin-left:auto">
          <span class="material-icons" style="font-size:18px">open_in_new</span> Ver el pedido como el cliente
        </a>
      </div>
    </div>`;
}

function pintarLista() {
  const caja = document.getElementById('reclamosLista');
  if (!caja) return;

  // Si se está escribiendo una respuesta, el foco y el cursor vuelven a su
  // lugar después de redibujar: un reclamo que entra no le corta la frase a
  // nadie.
  const activo = document.activeElement?.matches?.('[data-respuesta]') ? document.activeElement : null;
  const cursor = activo ? [activo.selectionStart, activo.selectionEnd] : null;

  const lista = visibles();
  caja.innerHTML = lista.length
    ? lista.map(tarjeta).join('')
    : `<div class="empty-state">
         <span class="material-icons">sentiment_satisfied</span>
         <p>${_filtro === 'abiertos' ? 'No hay reclamos abiertos.' : 'No hay reclamos en esta lista.'}</p>
       </div>`;

  if (cursor) {
    const nuevo = caja.querySelector('[data-respuesta]');
    if (nuevo) {
      nuevo.focus();
      nuevo.setSelectionRange(cursor[0], cursor[1]);
    }
  }
}

function pintarContadores() {
  const barra = document.getElementById('reclamosFiltros');
  if (!barra) return;
  barra.querySelectorAll('[data-filtro]').forEach(boton => {
    const f = FILTROS.find(x => x.clave === boton.dataset.filtro);
    const n = f?.estados ? _reclamos.filter(r => f.estados.includes(r.estado)).length : _reclamos.length;
    boton.querySelector('.cuenta').textContent = n;
    boton.classList.toggle('active', boton.dataset.filtro === _filtro);
  });
}

/* ── Entrada ─────────────────────────────────────────────────────────────── */

export async function renderTiendaReclamos(container, db) {
  cleanup();
  window.__limpiarPagina = cleanup;
  _db = db;
  _editando = null;
  _error = null;

  container.innerHTML = `
    <div class="filter-bar" id="reclamosFiltros"
         style="margin-bottom:16px;flex-wrap:wrap;gap:8px;align-items:center">
      ${FILTROS.map(f => `
        <button class="pc-btn" data-filtro="${f.clave}" style="gap:7px">
          ${f.texto} <span class="cuenta"
            style="background:var(--bg);border-radius:99px;padding:1px 7px;font-size:11.5px;font-weight:700">0</span>
        </button>`).join('')}
    </div>
    <div id="reclamosLista" style="display:flex;flex-direction:column;gap:12px">
      <div class="empty-state"><span class="material-icons">hourglass_empty</span><p>Cargando reclamos…</p></div>
    </div>`;

  if (_reclamos.length) {
    pintarContadores();
    pintarLista();
  }

  document.getElementById('reclamosFiltros').addEventListener('click', ev => {
    const boton = ev.target.closest('[data-filtro]');
    if (!boton) return;
    _filtro = boton.dataset.filtro;
    pintarContadores();
    pintarLista();
  });

  const lista = document.getElementById('reclamosLista');

  lista.addEventListener('input', ev => {
    const campo = ev.target.closest('[data-respuesta]');
    const id = campo?.closest('[data-reclamo-id]')?.dataset.reclamoId;
    if (id) _textos.set(id, campo.value);
  });

  lista.addEventListener('click', async ev => {
    const boton = ev.target.closest('[data-act]');
    if (!boton) return;
    const id = boton.closest('[data-reclamo-id]')?.dataset.reclamoId;
    const reclamo = _reclamos.find(r => r.id === id);
    if (!reclamo) return;
    const accion = boton.dataset.act;

    if (accion === 'foto') {
      verFotoGrande(boton.dataset.url);
      return;
    }

    if (accion === 'resolver' || accion === 'rechazar') {
      _editando = { id, estado: accion === 'resolver' ? 'resuelto' : 'rechazado' };
      _error = null;
      pintarLista();
      lista.querySelector('[data-respuesta]')?.focus();
      return;
    }

    if (accion === 'cancelar-edicion') {
      _editando = null;
      _error = null;
      _textos.delete(id);
      pintarLista();
      return;
    }

    if (_guardando.has(id)) return;

    if (accion === 'guardar') {
      const respuesta = String(_textos.has(id) ? _textos.get(id) : (reclamo.respuesta || '')).trim();
      if (_editando?.estado === 'rechazado' && !respuesta) {
        _error = 'Contale al cliente por qué no corresponde: lo va a leer en su pedido.';
        pintarLista();
        return;
      }
      _guardando.add(id);
      pintarLista();
      const ok = await mover(reclamo, _editando.estado, respuesta);
      _guardando.delete(id);
      if (ok) {
        _editando = null;
        _error = null;
        _textos.delete(id);
      }
      pintarContadores();
      pintarLista();
      return;
    }

    if (accion === 'revisando' || accion === 'reabrir') {
      _guardando.add(id);
      pintarLista();
      await mover(reclamo, 'revisando');
      _guardando.delete(id);
      pintarContadores();
      pintarLista();
    }
  });

  _unsub = onSnapshot(
    query(collection(db, 'tienda_reclamos'), orderBy('creado', 'desc'), limit(200)),
    snap => {
      _reclamos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      pintarContadores();
      pintarLista();
    },
    err => {
      console.warn('[reclamos] se cortó la escucha:', err?.code || err);
      const caja = document.getElementById('reclamosLista');
      if (caja) {
        caja.innerHTML = `
          <div class="empty-state">
            <span class="material-icons">cloud_off</span>
            <p>No se pudieron cargar los reclamos. Revisá la conexión.</p>
          </div>`;
      }
    },
  );
}
