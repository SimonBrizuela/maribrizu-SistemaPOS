/**
 * Núcleo del Calendario (sin UI): estado, cálculo de feriados/fechas comerciales,
 * eventos propios (Firestore) y los helpers livianos que se usan al ARRANQUE de la
 * app (badge del sidebar + próximas fechas).
 *
 * Separado de la página (`calendario.js`, que tiene la UI pesada) para que esa
 * página se cargue lazy en su propio chunk, mientras este núcleo —necesario al
 * inicio— viaja en el bundle principal. Así desaparece el warning de Vite por
 * importar calendario.js estática y dinámicamente a la vez.
 */
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { loadBalanceConfig, loadDiasMes } from '../config.js';

const EVENTOS_DOC = ['config', 'calendario_eventos'];   // doc Firestore compartido
export let _custom = [];    // [{id, nombre, tipo, anual, fecha}]  fecha = 'YYYY-MM-DD' o 'MM-DD' (anual)
let _unsubEventos = null;
let _db = null;

// ── Cálculo de fechas ────────────────────────────────────────────────────────

export const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
export const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

// Feriados que dependen del año (puentes turísticos y traslados de feriados
// trasladables), porque los fija el gobierno por decreto y no salen de una
// fórmula. Extender acá cada año cuando se publica el calendario oficial.
const EXTRAS_POR_ANIO = {
  2026: [
    { mmdd: '03-23', nombre: 'Feriado puente turístico', tipo: 'no_laborable' },
    { mmdd: '07-10', nombre: 'Feriado puente turístico', tipo: 'no_laborable' },
    { mmdd: '11-23', nombre: 'Día de la Soberanía (feriado trasladado)', tipo: 'feriado', nota: 'Conmemora el 20/11' },
    { mmdd: '12-07', nombre: 'Feriado puente turístico', tipo: 'no_laborable' },
  ],
};

// Domingo de Pascua (algoritmo de Meeus/Jones/Butcher).
function pascua(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, mes - 1, dia);
}

export function addDays(date, n) {
  const x = new Date(date);
  x.setDate(x.getDate() + n);
  return x;
}

// N-ésimo domingo de un mes (month 0-indexado). n=1 → primer domingo.
function domingoN(y, month, n) {
  const first = new Date(y, month, 1);
  const offset = (7 - first.getDay()) % 7;   // días hasta el primer domingo
  return new Date(y, month, 1 + offset + (n - 1) * 7);
}

export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Tipos → color + ícono. Pensado para que las fechas comerciales (las que mueven
// ventas en la librería) destaquen sobre los feriados.
export const TIPOS = {
  nota:         { label: 'Nota',             color: '#eab308', icon: 'event_note' },
  personal:     { label: 'Mis fechas',       color: '#2d6cdf', icon: 'star' },
  comercial:    { label: 'Fecha comercial', color: '#f39c12', icon: 'redeem' },
  feriado:      { label: 'Feriado nacional', color: '#e63946', icon: 'flag' },
  no_laborable: { label: 'No laborable',     color: '#29abca', icon: 'event_busy' },
  religioso:    { label: 'Religioso',        color: '#7b3fa6', icon: 'church' },
  escolar:      { label: 'Escolar',          color: '#8ec63f', icon: 'school' },
  vencimiento:  { label: 'Vencimiento de pago', color: '#d84315', icon: 'payment' },
};

// Categorías que el usuario puede elegir al crear una entrada propia.
export const TIPOS_USUARIO = ['nota', 'personal', 'comercial', 'escolar'];

// Paleta de colores e íconos para que el usuario personalice sus notas.
// Colores elegidos para verse bien sobre los chips (texto blanco) y diferenciarse.
export const COLORES_NOTA = ['#7b3fa6', '#2d6cdf', '#0891b2', '#2e7d32', '#eab308', '#f39c12', '#e63946', '#db2777', '#64748b'];
// Solo íconos presentes en la fuente clásica "Material Icons" (los nuevos como
// push_pin/payments salen como cuadrito vacío).
export const ICONOS_NOTA = ['event', 'star', 'redeem', 'cake', 'school', 'celebration', 'local_shipping',
  'payment', 'shopping_cart', 'favorite', 'campaign', 'inventory_2', 'bookmark', 'lightbulb', 'flag', 'label'];

// Color/ícono efectivo de un evento: usa el que eligió el usuario, o el del tipo.
export function evColor(e) { return (e && e.color) || (TIPOS[e && e.tipo] || TIPOS.feriado).color; }
export function evIcon(e)  { return (e && e.icon)  || (TIPOS[e && e.tipo] || TIPOS.feriado).icon; }

// Texto legible (oscuro o blanco) según la luminancia del fondo del chip.
// Evita texto blanco sobre amarillo/cyan (ilegible).
export function textoSobre(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length < 6) return '#fff';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#1c1e21' : '#fff';
}

let _idSeq = 0;
function _nuevoId() {
  // id estable para borrar; no usa Date.now globalmente para evitar choques.
  return 'u' + Date.now().toString(36) + (_idSeq++).toString(36);
}

const _cacheEventos = new Map();   // year → Map(ymd → [eventos])

export function eventosDeAnio(y) {
  if (_cacheEventos.has(y)) return _cacheEventos.get(y);
  const lista = [];
  const add = (date, nombre, tipo, nota) => lista.push({ fecha: ymd(date), nombre, tipo, nota: nota || '' });

  // Feriados nacionales inamovibles
  add(new Date(y, 0, 1),  'Año Nuevo', 'feriado');
  add(new Date(y, 2, 24), 'Día de la Memoria', 'feriado');
  add(new Date(y, 3, 2),  'Día del Veterano y Caídos en Malvinas', 'feriado');
  add(new Date(y, 4, 1),  'Día del Trabajador', 'feriado');
  add(new Date(y, 4, 25), 'Revolución de Mayo', 'feriado');
  add(new Date(y, 5, 20), 'Día de la Bandera (Belgrano)', 'feriado');
  add(new Date(y, 6, 9),  'Día de la Independencia', 'feriado');
  add(new Date(y, 7, 17), 'Paso a la Inmortalidad del Gral. San Martín', 'feriado', 'Trasladable al lunes');
  add(new Date(y, 9, 12), 'Día del Respeto a la Diversidad Cultural', 'feriado', 'Trasladable');
  add(new Date(y, 10, 20),'Día de la Soberanía Nacional', 'feriado', 'Trasladable');
  add(new Date(y, 11, 8), 'Inmaculada Concepción de María', 'feriado');
  add(new Date(y, 11, 25),'Navidad', 'feriado');

  // Movibles (derivadas de Pascua)
  const p = pascua(y);
  add(addDays(p, -48), 'Lunes de Carnaval', 'feriado');
  add(addDays(p, -47), 'Martes de Carnaval', 'feriado');
  add(addDays(p, -3),  'Jueves Santo', 'no_laborable');
  add(addDays(p, -2),  'Viernes Santo', 'feriado');
  add(p,               'Domingo de Pascua', 'religioso');

  // Fechas comerciales (venta) — clave para una librería
  add(new Date(y, 0, 6),  'Reyes Magos', 'comercial');
  add(new Date(y, 1, 14), 'San Valentín · Día de los Enamorados', 'comercial');
  add(new Date(y, 2, 8),  'Día de la Mujer', 'comercial');
  add(domingoN(y, 5, 3),  'Día del Padre', 'comercial');
  add(new Date(y, 6, 20), 'Día del Amigo', 'comercial');
  add(domingoN(y, 7, 3),  'Día del Niño', 'comercial');
  add(new Date(y, 8, 11), 'Día del Maestro', 'comercial');
  add(new Date(y, 8, 17), 'Día del Profesor', 'comercial');
  add(new Date(y, 8, 21), 'Día del Estudiante · Primavera', 'comercial');
  add(domingoN(y, 9, 3),  'Día de la Madre', 'comercial');
  add(new Date(y, 11, 24),'Nochebuena', 'comercial');
  add(new Date(y, 11, 31),'Fin de Año', 'comercial');

  // Escolar
  add(new Date(y, 2, 1),  'Inicio de clases (aprox.)', 'escolar', 'Varía por provincia');

  // Extras del año (puentes turísticos / traslados) — declarados por decreto.
  (EXTRAS_POR_ANIO[y] || []).forEach(x => {
    const [mm, dd] = x.mmdd.split('-').map(Number);
    add(new Date(y, mm - 1, dd), x.nombre, x.tipo || 'no_laborable', x.nota);
  });

  const mapa = new Map();
  for (const ev of lista) {
    if (!mapa.has(ev.fecha)) mapa.set(ev.fecha, []);
    mapa.get(ev.fecha).push(ev);
  }
  _cacheEventos.set(y, mapa);
  return mapa;
}

// ── Eventos propios del usuario (Firestore, compartidos entre PCs) ───────────

const _subs = new Set();   // callbacks a notificar cuando cambian los eventos propios

// Suscripción ÚNICA y persistente al doc compartido (vive toda la sesión, para
// que el aviso del sidebar funcione aunque no estés en la página del calendario).
// Acepta `db` para poder inicializarse tanto desde el badge como desde la página.
export function ensureSub(db) {
  if (db) _db = db;
  if (_unsubEventos || !_db) return;
  _unsubEventos = onSnapshot(doc(_db, ...EVENTOS_DOC), (snap) => {
    const items = (snap.exists() && Array.isArray(snap.data().items)) ? snap.data().items : [];
    _custom = items.filter(x => x && x.nombre && x.fecha);
    _subs.forEach(cb => { try { cb(); } catch (e) { /* noop */ } });
  }, (err) => console.warn('[calendario] listener eventos:', err));
}

export function subscribeEventos(cb) {
  _subs.add(cb);
  return () => _subs.delete(cb);
}

// ── Vencimientos de gastos fijos (derivados del Balance Mensual) ─────────────
// Cada fijo con `venceDia` genera un evento recurrente mensual ("vence el día N
// de cada mes") con estado pagado/pendiente según las compras cargadas en el
// detalle diario del mes (fijo_id). No se persiste nada acá: es una vista viva
// de control_config/balance + control_config/dias_<YYYY-MM>.
let _fijosVenc = [];             // fijos con venceDia (referencia del Balance)
let _mesesBal = {};              // cfg.meses (para fijosExcluidos por mes)
const _pagosMes = new Map();     // ym → Set(fijo_id con pago cargado ese mes)

function _normTx(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }

// Misma regla de vigencia que el Balance: activo, baja "desde tal mes" y
// exclusión puntual del mes.
function _fijoAplica(f, ym) {
  if (f.activo === false) return false;
  if (f.desactivadoDesde && ym >= f.desactivadoDesde) return false;
  const mes = _mesesBal[ym];
  if (mes && Array.isArray(mes.fijosExcluidos) && mes.fijosExcluidos.includes(f.id)) return false;
  return true;
}
// Día efectivo de vencimiento en el mes ('DD'), clampado al último día del mes.
function _venceDD(f, ym) {
  const d = Number(f.venceDia);
  if (!d || d < 1) return null;
  const [y, m] = ym.split('-').map(Number);
  return String(Math.min(Math.round(d), new Date(y, m, 0).getDate())).padStart(2, '0');
}

// Carga la lista de fijos con vencimiento desde el Balance + los pagos del mes
// actual, y notifica a los suscriptores (badge del sidebar / página calendario).
export async function refreshVencimientos(db) {
  if (db) _db = db;
  if (!_db) return;
  try {
    const cfg = await loadBalanceConfig(_db);
    _fijosVenc = ((cfg && cfg.montosFijos) || []).filter(f => Number(f.venceDia) >= 1);
    _mesesBal = (cfg && cfg.meses) || {};
    if (_fijosVenc.length) await ensurePagosMes(ymd(new Date()).slice(0, 7));
    _subs.forEach(cb => { try { cb(); } catch (e) { /* noop */ } });
  } catch (err) {
    console.warn('[calendario] vencimientos:', err);
  }
}

// Set de fijo_id con pago registrado en un mapa de días del Balance. Matchea
// igual que el panel de fijos: por fijo_id o, para cargas a mano, por rubro
// GASTOS FIJOS + proveedor = motivo del fijo.
function _pagosDesdeDias(dias) {
  const ids = new Set();
  Object.values(dias || {}).forEach(d => (d.compras || []).forEach(c => {
    if (c.fijo_id) { ids.add(c.fijo_id); return; }
    if (_normTx(c.rubro) !== 'gastos fijos') return;
    const f = _fijosVenc.find(x => _normTx(x.label) === _normTx(c.proveedor));
    if (f) ids.add(f.id);
  }));
  return ids;
}

// Pagos de fijos registrados en un mes (Set de fijo_id). Cachea por mes y
// devuelve true solo si cargó datos nuevos (para repintar únicamente entonces).
export async function ensurePagosMes(ym) {
  if (_pagosMes.has(ym) || !_db || !_fijosVenc.length) return false;
  let ids = new Set();
  try {
    const mesDoc = await loadDiasMes(_db, ym);
    ids = _pagosDesdeDias(mesDoc && mesDoc.dias);
  } catch (e) { /* mes sin datos */ }
  _pagosMes.set(ym, ids);
  return true;
}

// El Balance avisa acá cuando cambia el detalle de un mes en memoria (pago
// cargado/borrado): actualiza el estado sin lecturas extra y repinta el badge.
export function setPagosMesFromDias(ym, dias) {
  if (!_fijosVenc.length) return;
  _pagosMes.set(ym, _pagosDesdeDias(dias));
  _subs.forEach(cb => { try { cb(); } catch (e) { /* noop */ } });
}

// Eventos de vencimiento que caen en una fecha 'YYYY-MM-DD'. Color/ícono según
// estado: pagado (verde ✓) · vence hoy o vencido (rojo) · próximo (naranja).
export function vencimientosEnFecha(key) {
  if (!_fijosVenc.length) return [];
  const ym = key.slice(0, 7);
  const hoy = ymd(new Date());
  const pagos = _pagosMes.get(ym);
  return _fijosVenc
    .filter(f => _fijoAplica(f, ym) && _venceDD(f, ym) === key.slice(8))
    .map(f => {
      const label = f.label || 'Gasto fijo';
      const pagado = !!(pagos && pagos.has(f.id));
      const vencido = !pagado && key < hoy;
      return {
        fecha: key, tipo: 'vencimiento', pagado,
        nombre: pagado ? `${label} · pagado` : vencido ? `Vencido: ${label}` : key === hoy ? `Vence hoy: ${label}` : `Vence: ${label}`,
        color: pagado ? '#2e7d32' : (vencido || key === hoy) ? '#c62828' : TIPOS.vencimiento.color,
        icon: pagado ? 'check_circle' : 'payment',
        nota: 'Cada mes',
      };
    });
}

// Eventos (oficiales + propios + vencimientos) que caen HOY. Para el aviso del
// sidebar. Los vencimientos ya pagados no avisan: están resueltos.
export function hayEventoHoy() {
  const k = ymd(new Date());
  const oficiales = (eventosDeAnio(new Date().getFullYear()).get(k) || []);
  const propios = customEnFecha(k);
  const venc = vencimientosEnFecha(k).filter(v => !v.pagado);
  const items = [...venc, ...oficiales, ...propios];
  return { hay: items.length > 0, items };
}

// Eventos (oficiales + propios) que caen entre HOY y los próximos `diasMax`
// días. Para el aviso de "se viene una fecha" al entrar a la app.
export function proximosEventos(diasMax = 3) {
  const hoyD = new Date();
  const base = new Date(hoyD.getFullYear(), hoyD.getMonth(), hoyD.getDate());
  const acum = [];
  for (const y of [hoyD.getFullYear(), hoyD.getFullYear() + 1]) {
    for (const evs of eventosDeAnio(y).values()) for (const e of evs) acum.push(e);
    for (const e of _custom) acum.push({ fecha: ocurrenciaEnAnio(e, y), nombre: e.nombre, tipo: e.tipo, color: e.color, icon: e.icon, nota: e.anual ? 'Cada año' : '' });
  }
  // Vencimientos de gastos fijos dentro de la ventana (los pagados no avisan).
  for (let i = 0; i <= diasMax; i++) {
    for (const v of vencimientosEnFecha(ymd(addDays(base, i)))) if (!v.pagado) acum.push(v);
  }
  const seen = new Set();
  return acum
    .map(e => {
      const [yy, mm, dd] = e.fecha.split('-').map(Number);
      const dias = Math.round((new Date(yy, mm - 1, dd) - base) / 86400000);
      return { fecha: e.fecha, nombre: e.nombre, dias, color: evColor(e), icon: evIcon(e), nota: e.nota || '' };
    })
    .filter(e => e.dias >= 0 && e.dias <= diasMax)
    .filter(e => { const k = e.fecha + '|' + e.nombre; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.dias - b.dias);
}

// Arranca la suscripción global y notifica al `render` cada vez que cambia el
// estado de "hoy" (al iniciar la app y ante cualquier alta/baja de eventos).
export function initCalendarioBadge(db, render) {
  ensureSub(db);
  subscribeEventos(() => render(hayEventoHoy()));
  render(hayEventoHoy());
  refreshVencimientos(db);   // async: al cargar notifica a _subs y el badge se repinta
}

function _persistEventos() {
  if (!_db) return;
  setDoc(doc(_db, ...EVENTOS_DOC), { items: _custom }, { merge: true })
    .catch(e => console.warn('[calendario] error guardando evento:', e));
}

export function agregarEvento({ nombre, fecha, tipo, anual, color, icon }) {
  // fecha entra como 'YYYY-MM-DD'; si es anual guardamos solo 'MM-DD'.
  const f = anual ? fecha.slice(5) : fecha;
  _custom = [..._custom, { id: _nuevoId(), nombre: nombre.trim(), tipo: tipo || 'personal', anual: !!anual, fecha: f, color: color || '', icon: icon || '' }];
  _persistEventos();
}

export function borrarEvento(id) {
  _custom = _custom.filter(e => e.id !== id);
  _persistEventos();
}

// Eventos propios que caen en una fecha 'YYYY-MM-DD'.
export function customEnFecha(key) {
  const mmdd = key.slice(5);
  return _custom
    .filter(e => e.anual ? e.fecha === mmdd : e.fecha === key)
    .map(e => ({ fecha: key, nombre: e.nombre, tipo: e.tipo, color: e.color, icon: e.icon, nota: e.anual ? 'Cada año' : '', _id: e.id }));
}

// Ocurrencia (fecha 'YYYY-MM-DD') de un evento propio para un año dado.
export function ocurrenciaEnAnio(e, year) {
  if (e.anual) return `${year}-${e.fecha}`;
  return e.fecha;   // one-time: su fecha real
}
