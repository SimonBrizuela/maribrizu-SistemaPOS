/**
 * Vigía de los reclamos de la tienda.
 *
 * Un reclamo que nadie mira es un cliente enojado dos veces. Este módulo cuenta
 * los que esperan que alguien los tome (estado `nuevo`) para el badge del menú,
 * y avisa con un toast cuando entra uno mientras el panel está abierto.
 *
 * Igual que con los pedidos, la primera carga no dispara un aviso por cada uno:
 * sale un resumen y desde ahí cada reclamo nuevo avisa solo. Sin sonido: un
 * reclamo no es plata esperando en el mostrador, y la campana ya es de los
 * pedidos.
 *
 * Si las reglas de `tienda_reclamos` todavía no están publicadas, la escucha
 * falla por permisos: se anota en la consola y el badge queda en cero, sin
 * romper nada más del panel.
 */
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { mostrarToast } from './components/toasts.js';
import { motivoLegible } from '../../tienda/src/reclamos.js';

const MAX_RECLAMOS = 50;

let _initialized = false;
let _unsub = null;
let _baselineDone = false;
let _avisados = new Set();
let _pendientes = [];
const _listeners = new Set();

function _escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _irALaBandeja(id, api) {
  if (id === 'ver') window.navigateToPage?.('tienda_reclamos');
  api.cerrar();
}

function _avisarUno(r) {
  const fotos = Array.isArray(r.fotos) ? r.fotos.length : 0;
  mostrarToast({
    tono: 'naranja',
    etiqueta: 'Reclamo de la tienda',
    icono: 'report_problem',
    titulo: `${r?.cliente?.nombre || 'Sin nombre'} · ${r.pedido_codigo || ''}`.trim(),
    detalleHtml: `${_escape(motivoLegible(r.motivo))}${
      fotos ? `<span class="ll-toast-sep">·</span>${fotos} ${fotos === 1 ? 'foto' : 'fotos'}` : ''}`,
    acciones: [{ id: 'ver', texto: 'Ver el reclamo', principal: true }],
    duracion: 0,
    onAccion: _irALaBandeja,
  });
}

function _avisarResumen(cantidad) {
  mostrarToast({
    tono: 'naranja',
    etiqueta: 'Tienda',
    icono: 'report_problem',
    titulo: `${cantidad} ${cantidad === 1 ? 'reclamo' : 'reclamos'} sin atender`,
    detalleHtml: 'Esperan que alguien los mire.',
    acciones: [{ id: 'ver', texto: 'Ver los reclamos', principal: true }],
    duracion: 0,
    onAccion: _irALaBandeja,
  });
}

function _contar(lista) {
  _pendientes = lista;
  for (const cb of _listeners) {
    try { cb(_pendientes.slice()); } catch (e) { console.warn('[reclamos] listener:', e); }
  }
}

/** Los reclamos que nadie tomó todavía, para el badge del menú. */
export function onReclamosCambian(cb) {
  _listeners.add(cb);
  cb(_pendientes.slice());
  return () => _listeners.delete(cb);
}

export function initReclamosWatcher(db) {
  if (_initialized) return;
  _initialized = true;

  // Por fecha y filtrado acá, como los pedidos: una consulta por `estado`
  // ordenada por fecha pediría un índice compuesto.
  const consulta = query(collection(db, 'tienda_reclamos'), orderBy('creado', 'desc'), limit(MAX_RECLAMOS));

  _unsub = onSnapshot(consulta, snap => {
    const nuevos = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.estado === 'nuevo');

    if (!_baselineDone) {
      _baselineDone = true;
      nuevos.forEach(r => _avisados.add(r.id));
      if (nuevos.length) _avisarResumen(nuevos.length);
    } else {
      nuevos.filter(r => !_avisados.has(r.id)).forEach(r => {
        _avisados.add(r.id);
        _avisarUno(r);
      });
    }
    _contar(nuevos);
  }, err => {
    console.warn('[reclamos] no se pudieron escuchar:', err?.code || err);
    _contar([]);
  });
}

export function detenerReclamosWatcher() {
  _unsub?.();
  _unsub = null;
  _initialized = false;
  _baselineDone = false;
  _avisados = new Set();
  _contar([]);
}
