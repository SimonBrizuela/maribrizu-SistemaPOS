/**
 * Pedidos de la tienda online.
 *
 * La otra mitad del aviso: pedidos_watcher.js hace sonar la campana cuando entra
 * un pedido, y esta pantalla es donde se trabaja. Sin ella el aviso no lleva a
 * ningun lado.
 *
 * Esta pensada para el mostrador, no para un escritorio: el pedido se lee de
 * arriba abajo en el orden en que hace falta (quien es, como lo recibe, que
 * lleva, cuanto es) y cada tarjeta tiene un solo boton grande que lo empuja al
 * paso siguiente. Elegir el estado de una lista desplegable obliga a saber cual
 * viene despues; el boton ya lo sabe.
 */
import { collection, doc, onSnapshot, query, orderBy, limit, updateDoc } from 'firebase/firestore';
import { marcarVisto } from '../pedidos_watcher.js';
import { enlaceAviso } from '../avisos_pedido.js';
import { imprimirPedido } from '../ticket_pedido.js';
import { leerDocRapido } from '../config.js';
// Los botones de esta pantalla son los mismos que los de las otras dos de la
// sección. Sin esta línea salían sin estilo: la hoja la importaban solo el
// catálogo y la configuración, y entrar directo a Pedidos no la cargaba nunca.
import '../styles/tienda.css';

// El camino normal de un pedido. `cancelado` queda afuera a proposito: no es un
// paso, es una salida.
const FLUJO = {
  nuevo:      { etiqueta: 'Nuevo',        color: '#2f7a3d', icono: 'fiber_new',        siguiente: 'preparando' },
  preparando: { etiqueta: 'Preparando',   color: '#0d6efd', icono: 'inventory',        siguiente: 'listo' },
  listo:      { etiqueta: 'Listo',        color: '#7b3fa6', icono: 'check_circle',     siguiente: null },
  en_camino:  { etiqueta: 'En camino',    color: '#fd7e14', icono: 'local_shipping',   siguiente: 'entregado' },
  entregado:  { etiqueta: 'Entregado',    color: '#6c757d', icono: 'done_all',         siguiente: null },
  cancelado:  { etiqueta: 'Cancelado',    color: '#dc3545', icono: 'cancel',           siguiente: null },
};

// Un pedido listo sigue caminos distintos segun como lo reciba el cliente: el
// que retira se entrega en el mostrador, el de delivery todavia tiene que salir.
function siguienteDe(pedido) {
  if (pedido.estado === 'listo') {
    return pedido?.entrega?.modo === 'delivery' ? 'en_camino' : 'entregado';
  }
  return FLUJO[pedido.estado]?.siguiente || null;
}

const ETIQUETA_ACCION = {
  preparando: 'Empezar a preparar',
  listo:      'Marcar listo',
  en_camino:  'Salió el reparto',
  entregado:  'Entregado',
};

// El color del botón no siempre es el del estado al que lleva. "Entregado" en
// gris —el gris con el que después se marca el pedido cerrado— parece un botón
// apagado, justo el que cierra la venta.
const COLOR_ACCION = { ...Object.fromEntries(
  Object.entries(FLUJO).map(([k, v]) => [k, v.color])), entregado: '#2f7a3d' };

const FILTROS = [
  { clave: 'pendientes', texto: 'Pendientes', estados: ['nuevo', 'preparando', 'listo', 'en_camino'] },
  { clave: 'nuevo',      texto: 'Nuevos',     estados: ['nuevo'] },
  { clave: 'entregado',  texto: 'Entregados', estados: ['entregado'] },
  { clave: 'todos',      texto: 'Todos',      estados: null },
];

let _unsub = null;
let _pedidos = [];
let _filtro = 'pendientes';
let _busqueda = '';
let _db = null;
let _config = {};
// id del pedido -> { url, tipo }. Lo que adjuntaron los clientes.
let _comprobantes = new Map();
let _unsubComprobantes = null;

function cleanup() {
  _unsub?.();
  _unsub = null;
  _unsubComprobantes?.();
  _unsubComprobantes = null;
}

/**
 * El comprobante que adjunto el cliente, dentro de la tarjeta del pedido.
 *
 * Se muestra la imagen chica y se abre en grande al tocarla; el PDF va como
 * enlace, que es como se lee comodo. No se valida nada: el numero lo mira una
 * persona contra el homebanking, que es lo unico que confirma que entro.
 */
function bloqueComprobante(p) {
  const c = _comprobantes.get(p.id);
  if (!c) {
    if (p?.pago?.modo !== 'transferencia') return '';
    return `<span style="color:var(--text-muted);font-size:12.5px">
              <span class="material-icons" style="font-size:15px;vertical-align:-3px">hourglass_empty</span>
              Sin comprobante todavía
            </span>`;
  }

  return `
    <a href="${esc(c.url)}" target="_blank" rel="noopener" class="comprobante-chip"
       title="Abrir el comprobante en grande">
      ${c.tipo === 'pdf'
        ? '<span class="material-icons" style="font-size:19px">picture_as_pdf</span>'
        : `<img src="${esc(c.url)}" alt="" loading="lazy">`}
      <b>Comprobante ${c.tipo === 'pdf' ? 'en PDF' : 'adjuntado'}</b>
      <span class="material-icons" style="font-size:15px">open_in_new</span>
    </a>`;
}

/** Los comprobantes llegan en vivo: uno puede entrar con la pantalla abierta. */
function escucharComprobantes() {
  _unsubComprobantes?.();
  _unsubComprobantes = onSnapshot(
    collection(_db, 'tienda_comprobantes'),
    snap => {
      _comprobantes = new Map(snap.docs.map(d => {
        const v = d.data() || {};
        return [d.id, { url: v.url || '', tipo: v.tipo || 'imagen' }];
      }));
      pintarLista();
    },
    err => console.warn('[pedidos] comprobantes:', err?.code || err),
  );
}

/* ── Formato ─────────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pesos(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

function cantidadDe(item) {
  return item.unidad === 'metro'
    ? `${Number(item.cantidad).toFixed(1).replace('.', ',')} m`
    : `${Math.round(item.cantidad)}`;
}

/** "hace 4 min" · "14:30" · "ayer 14:30" */
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

/* ── Acciones ────────────────────────────────────────────────────────────── */

/**
 * Deja anotado que al cliente ya se le avisó de este estado.
 *
 * Sin esto, el botón dice "Avisarle al cliente" para siempre y no hay forma de
 * saber si se le avisó o no — que es justo lo que uno quiere saber cuando
 * alguien llama preguntando.
 */
async function marcarImpreso(id) {
  try {
    await updateDoc(doc(_db, 'tienda_pedidos', id), { impreso: true });
  } catch (e) {
    console.warn('[pedidos] no se pudo anotar la impresión:', e);
  }
}

async function marcarAvisado(id, estado) {
  try {
    await updateDoc(doc(_db, 'tienda_pedidos', id), { avisado: estado });
  } catch (e) {
    console.warn('[pedidos] no se pudo anotar el aviso:', e);
  }
}

async function cambiarEstado(id, estado) {
  try {
    await updateDoc(doc(_db, 'tienda_pedidos', id), { estado, visto: true });
  } catch (e) {
    console.warn('[pedidos] no se pudo cambiar el estado:', e);
    alert('No se pudo cambiar el estado del pedido.');
  }
}

/* ── Pintado ─────────────────────────────────────────────────────────────── */

function visibles() {
  const filtro = FILTROS.find(f => f.clave === _filtro);
  const texto = _busqueda.trim().toLowerCase();

  return _pedidos.filter(p => {
    if (filtro?.estados && !filtro.estados.includes(p.estado)) return false;
    if (!texto) return true;
    return [p.codigo, p?.cliente?.nombre, p?.cliente?.telefono, p?.entrega?.direccion]
      .filter(Boolean).some(v => String(v).toLowerCase().includes(texto));
  });
}

function tarjeta(p) {
  const flujo = FLUJO[p.estado] || FLUJO.nuevo;
  const siguiente = siguienteDe(p);
  const entrega = p.entrega || {};
  const esDelivery = entrega.modo === 'delivery';
  const aviso = enlaceAviso(p, { direccionLocal: 'Av. Alfonsina Storni 168' });

  const whatsapp = String(p?.cliente?.telefono || '').replace(/\D/g, '');
  const mensaje = encodeURIComponent(
    `Hola ${p?.cliente?.nombre || ''}, te escribimos de Librería Liceo por tu pedido ${p.codigo || ''}.`);

  const destino = esDelivery
    ? (entrega.coordenadas
        ? `https://maps.google.com/?q=${entrega.coordenadas.lat},${entrega.coordenadas.lng}`
        : `https://maps.google.com/?q=${encodeURIComponent(entrega.direccion || '')}`)
    : null;

  const items = (p.items || []).map(i => `
    <div style="display:grid;grid-template-columns:44px 1fr auto;gap:8px;align-items:baseline;font-size:13px;padding:3px 0">
      <b style="color:var(--text-muted);font-variant-numeric:tabular-nums">${esc(cantidadDe(i))}</b>
      <span>${esc(i.nombre)}${i.variedad ? `<span style="color:var(--text-muted)"> · ${esc(i.variedad)}</span>` : ''}${
        i.es_pack ? `<span style="color:var(--text-muted)"> · pack de ${i.pack_contenido}</span>` : ''}</span>
      <span style="font-weight:600;white-space:nowrap">${pesos(i.subtotal ?? i.precio * i.cantidad)}</span>
    </div>`).join('');

  return `
    <div class="pedido-card" data-id="${esc(p.id)}"
         style="background:var(--surface);border:1px solid var(--border);border-left:4px solid ${flujo.color};
                border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px">

      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-family:ui-monospace,monospace;font-weight:800;font-size:17px;letter-spacing:2px">${esc(p.codigo || '—')}</span>
        <span style="background:${flujo.color};color:#fff;font-size:11px;font-weight:700;padding:2px 9px;border-radius:99px;
                     text-transform:uppercase;letter-spacing:.4px">${flujo.etiqueta}</span>
        ${p.visto === false ? '<span style="background:#dc3545;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:99px">SIN VER</span>' : ''}
        <span style="margin-left:auto;color:var(--text-muted);font-size:12.5px">${esc(cuando(p.creado))}</span>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:8px 18px;font-size:13.5px">
        <span><span class="material-icons" style="font-size:16px;vertical-align:-3px;color:var(--text-muted)">person</span>
          <b>${esc(p?.cliente?.nombre || 'Sin nombre')}</b></span>
        ${whatsapp ? `<a href="https://wa.me/${esc(whatsapp.length <= 10 ? '549' + whatsapp : whatsapp)}?text=${mensaje}"
             target="_blank" rel="noopener" style="color:#2f7a3d;font-weight:600;text-decoration:none">
            <span class="material-icons" style="font-size:16px;vertical-align:-3px">chat</span>
            ${esc(p.cliente.telefono)}</a>` : ''}
      </div>

      <div style="background:var(--bg);border-radius:8px;padding:10px 12px;font-size:13px;display:flex;flex-direction:column;gap:4px">
        <span>
          <span class="material-icons" style="font-size:16px;vertical-align:-3px;color:var(--text-muted)">${
            esDelivery ? 'local_shipping' : 'storefront'}</span>
          <b>${esDelivery ? 'Envío a domicilio' : 'Retira en el local'}</b>
          ${esDelivery && entrega.distancia_km ? `<span style="color:var(--text-muted)"> · ${
            String(entrega.distancia_km).replace('.', ',')} km</span>` : ''}
        </span>
        ${esDelivery ? `
          <span>${esc(entrega.direccion || 'Sin dirección')}${
            entrega.referencia ? `<span style="color:var(--text-muted)"> · ${esc(entrega.referencia)}</span>` : ''}</span>
          <a href="${destino}" target="_blank" rel="noopener"
             style="color:var(--primary);font-weight:600;text-decoration:none;font-size:12.5px">
            <span class="material-icons" style="font-size:15px;vertical-align:-3px">map</span> Ver en el mapa</a>` : ''}
        <span style="color:var(--text-muted)">
          Paga con ${p?.pago?.modo === 'transferencia' ? 'transferencia' : 'efectivo'}
        </span>
        ${bloqueComprobante(p)}
      </div>

      <div>${items}</div>

      ${p.nota ? `
        <div style="background:#fdf2e0;color:#9a5b00;border-radius:8px;padding:8px 11px;font-size:13px;line-height:1.45">
          <span class="material-icons" style="font-size:15px;vertical-align:-3px">sticky_note_2</span>
          ${esc(p.nota)}
        </div>` : ''}

      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid var(--border);padding-top:10px">
        <div style="font-size:13px;color:var(--text-muted)">
          Productos ${pesos(p.subtotal)} ·
          ${esDelivery
            ? (entrega.envio_a_confirmar
                ? '<b style="color:#9a5b00">envío a confirmar</b>'
                : `envío ${pesos(p.envio)}`)
            : 'sin envío'}
        </div>
        <div style="margin-left:auto;font-size:19px;font-weight:800">${pesos(p.total)}</div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${siguiente ? `
          <button class="pc-btn" data-act="avanzar" data-estado="${siguiente}"
                  style="flex:1;min-width:170px;justify-content:center;background:${COLOR_ACCION[siguiente]};
                         color:#fff;border:none;font-weight:700">
            <span class="material-icons" style="font-size:18px">${FLUJO[siguiente].icono}</span>
            ${ETIQUETA_ACCION[siguiente]}
          </button>` : ''}
        ${aviso ? `
          <a class="pc-btn ${p.avisado === p.estado ? '' : 'avisar-pendiente'}"
             href="${esc(aviso)}" target="_blank" rel="noopener"
             data-act="avisar" style="justify-content:center;min-width:150px">
            <span class="material-icons" style="font-size:18px">chat</span>
            ${p.avisado === p.estado ? 'Volver a avisar' : 'Avisarle al cliente'}
          </a>` : ''}
        <button class="pc-btn" data-act="imprimir" style="justify-content:center">
          <span class="material-icons" style="font-size:18px">print</span> Imprimir
        </button>
        ${p.estado !== 'cancelado' && p.estado !== 'entregado' ? `
          <button class="pc-btn danger" data-act="cancelar" style="justify-content:center">
            <span class="material-icons" style="font-size:18px">cancel</span> Cancelar
          </button>` : ''}
      </div>
    </div>`;
}

function pintarLista() {
  const caja = document.getElementById('pedidosLista');
  if (!caja) return;

  const lista = visibles();

  if (!lista.length) {
    caja.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">receipt_long</span>
        <p>${_busqueda ? 'Ningún pedido coincide con la búsqueda.'
                       : 'No hay pedidos en este estado.'}</p>
      </div>`;
    return;
  }

  caja.innerHTML = lista.map(tarjeta).join('');
}

function pintarContadores() {
  const barra = document.getElementById('pedidosFiltros');
  if (!barra) return;

  barra.querySelectorAll('[data-filtro]').forEach(boton => {
    const f = FILTROS.find(x => x.clave === boton.dataset.filtro);
    const n = f?.estados
      ? _pedidos.filter(p => f.estados.includes(p.estado)).length
      : _pedidos.length;
    boton.querySelector('.cuenta').textContent = n;
    boton.classList.toggle('active', boton.dataset.filtro === _filtro);
  });
}

/* ── Entrada ─────────────────────────────────────────────────────────────── */

export async function renderPedidosTienda(container, db) {
  cleanup();
  _db = db;

  // Los comprobantes de transferencia que adjuntaron los clientes. Se leen
  // aparte del pedido: viven en su propia coleccion para que el cliente no
  // tenga que poder escribir en el documento del pedido.
  escucharComprobantes();

  // El nombre, la dirección y el teléfono del local van en el encabezado del
  // ticket. Se leen del cache del SDK y se revalidan atrás: si fallan, el ticket
  // sale igual, sin encabezado.
  leerDocRapido(doc(db, 'tienda_config', 'settings'),
                { etiqueta: 'tienda_config/settings', vacio: {} })
    .then(datos => { _config = datos || {}; })
    .catch(() => {});

  container.innerHTML = `
    <div class="filter-bar" id="pedidosFiltros"
         style="margin-bottom:16px;flex-wrap:wrap;gap:8px;align-items:center">
      ${FILTROS.map(f => `
        <button class="pc-btn" data-filtro="${f.clave}" style="gap:7px">
          ${f.texto} <span class="cuenta"
            style="background:var(--bg);border-radius:99px;padding:1px 7px;font-size:11.5px;font-weight:700">0</span>
        </button>`).join('')}
      <input type="text" id="pedidosBuscar" placeholder="Código, nombre, teléfono o dirección…"
             style="flex:1;min-width:200px;max-width:320px;padding:6px 10px;border:1px solid var(--border);
                    border-radius:6px;font-size:13px" />
    </div>

    <div id="pedidosLista" style="display:flex;flex-direction:column;gap:12px">
      <div class="empty-state"><span class="material-icons">hourglass_empty</span><p>Cargando pedidos…</p></div>
    </div>`;

  // Los pedidos de la visita anterior siguen en memoria: se pintan ya y el
  // snapshot los corrige cuando llega. Volver a Pedidos era esperar de nuevo la
  // consulta entera para ver, casi siempre, exactamente lo mismo.
  if (_pedidos.length) {
    pintarContadores();
    pintarLista();
  }

  // ── Eventos ──
  document.getElementById('pedidosFiltros').addEventListener('click', ev => {
    const boton = ev.target.closest('[data-filtro]');
    if (!boton) return;
    _filtro = boton.dataset.filtro;
    pintarContadores();
    pintarLista();
  });

  const buscador = document.getElementById('pedidosBuscar');
  buscador.addEventListener('input', () => {
    _busqueda = buscador.value;
    pintarLista();
  });

  document.getElementById('pedidosLista').addEventListener('click', async ev => {
    const boton = ev.target.closest('[data-act]');
    if (!boton) return;
    const id = boton.closest('[data-id]')?.dataset.id;
    if (!id) return;

    if (boton.dataset.act === 'avisar') {
      // El enlace abre WhatsApp solo; acá únicamente se anota que ya se avisó
      // de este estado, para que el botón no quede pidiendo lo mismo.
      const p = _pedidos.find(x => x.id === id);
      if (p) marcarAvisado(id, p.estado);
      return;
    }

    if (boton.dataset.act === 'imprimir') {
      const p = _pedidos.find(x => x.id === id);
      if (p) {
        imprimirPedido(p, _config);
        // Queda anotado que se imprimio: el POS usa el mismo campo, asi que un
        // pedido impreso desde aca no se vuelve a imprimir solo alla.
        marcarImpreso(id);
      }
      return;
    }

    if (boton.dataset.act === 'avanzar') {
      boton.disabled = true;
      await cambiarEstado(id, boton.dataset.estado);
      return;
    }

    if (boton.dataset.act === 'cancelar') {
      const p = _pedidos.find(x => x.id === id);
      if (!confirm(`¿Cancelar el pedido ${p?.codigo || ''} de ${p?.cliente?.nombre || ''}?`)) return;
      boton.disabled = true;
      await cambiarEstado(id, 'cancelado');
    }
  });

  // ── Datos en vivo ──
  // Se escucha en vez de leer una vez: mientras alguien mira esta pantalla puede
  // entrar un pedido, y tiene que aparecer solo. Es la pantalla donde mas
  // importa.
  _unsub = onSnapshot(
    query(collection(db, 'tienda_pedidos'), orderBy('creado', 'desc'), limit(200)),
    snap => {
      _pedidos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      pintarContadores();
      pintarLista();

      // Estar en esta pantalla es haberlos visto: se apaga el aviso rojo para
      // que la campana no vuelva a sonar por algo que ya se miro.
      _pedidos.filter(p => p.visto === false).forEach(p => marcarVisto(p.id));
    },
    err => {
      console.warn('[pedidos] se cortó la escucha:', err);
      const caja = document.getElementById('pedidosLista');
      if (caja) {
        caja.innerHTML = `
          <div class="empty-state">
            <span class="material-icons">cloud_off</span>
            <p>No se pudieron cargar los pedidos. Revisá la conexión.</p>
          </div>`;
      }
    },
  );
}
