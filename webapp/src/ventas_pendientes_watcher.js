/**
 * Registra las ventas de lo que entregó el repartidor.
 *
 * La página del repartidor deja el pedido entregado con `venta_pendiente` (no
 * tiene permiso para tocar el catálogo ni las ventas). Cualquier panel abierto
 * lo ve acá y la registra con `registrarEntrega`, la misma cuenta del botón
 * "Entregado". Con dos PCs abiertas no se registra dos veces: la transacción
 * relee el pedido y la segunda lo encuentra ya registrado.
 *
 * Si falla (sin red, un producto que no se pudo leer) se vuelve a intentar cada
 * minuto: el aviso de la base no se repite solo, y la venta no puede quedar
 * pendiente para siempre.
 */
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { registrarEntrega } from './entregar_pedido.js';

const REINTENTO_MS = 60_000;

let _unsub = null;
let _timer = null;
const _enCurso = new Set();
let _pendientes = [];

async function registrar(db, id) {
  if (_enCurso.has(id)) return;
  _enCurso.add(id);
  try {
    const r = await registrarEntrega(db, id);
    if (!r.ok) console.warn('[reparto] no se registró la venta del pedido', id, r.rechazo);
  } catch (err) {
    console.warn('[reparto] no se pudo registrar la venta del pedido', id, err?.message || err);
  } finally {
    _enCurso.delete(id);
  }
}

export function iniciarVentasPendientes(db) {
  if (_unsub) return;
  _unsub = onSnapshot(
    query(collection(db, 'tienda_pedidos'), where('venta_pendiente', '==', true)),
    snap => {
      _pendientes = snap.docs.map(d => d.id);
      _pendientes.forEach(id => registrar(db, id));
    },
    err => console.warn('[reparto] se cortó la escucha de ventas pendientes:', err?.code || err),
  );
  _timer = setInterval(() => _pendientes.forEach(id => registrar(db, id)), REINTENTO_MS);
}

export function detenerVentasPendientes() {
  _unsub?.();
  _unsub = null;
  clearInterval(_timer);
  _timer = null;
  _pendientes = [];
}
