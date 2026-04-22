import { doc, getDoc, setDoc } from 'firebase/firestore';
import { getCached, invalidateCache } from './cache.js';

// Default: 2026-04-18 — día que empezamos a usar el sistema en serio.
// Todo lo anterior a esta fecha se considera data de prueba y se oculta.
const DEFAULT_FECHA_INICIO = '2026-04-18';

// Cache clave para la config: TTL 2 min (cambia muy poco)
const CFG_KEY = 'control_config:settings';

export async function loadControlConfig(db) {
  return getCached(CFG_KEY, async () => {
    try {
      const snap = await getDoc(doc(db, 'control_config', 'settings'));
      if (snap.exists()) return snap.data();
    } catch (_) {}
    return {};
  }, { ttl: 2 * 60 * 1000 });
}

export async function saveControlConfig(db, config) {
  await setDoc(doc(db, 'control_config', 'settings'), config, { merge: true });
  invalidateCache(CFG_KEY);
}

/** Devuelve la fecha de inicio como string "YYYY-MM-DD" */
export async function getFechaInicio(db) {
  const cfg = await loadControlConfig(db);
  return cfg.fecha_inicio || DEFAULT_FECHA_INICIO;
}

/** Devuelve la fecha de inicio como Date (00:00 hora Argentina) */
export async function getFechaInicioDate(db) {
  const str = await getFechaInicio(db);
  return new Date(str + 'T00:00:00-03:00');
}

/** Convierte un timestamp Firestore / ISO / {seconds} a Date AR */
export function parseArDate(raw) {
  if (!raw) return new Date(NaN);
  if (typeof raw.toDate === 'function') return raw.toDate();
  if (typeof raw === 'object' && raw.seconds !== undefined)
    return new Date(raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6));
  return new Date(raw);
}

/**
 * Detecta si una venta (de la coleccion `ventas`) es una factura VARIOS 2 AFIP.
 * Esas no son ventas reales — no suman a caja ni a historial.
 * El flag is_varios_2 no siempre se sincroniza desde el POS, pero la string
 * `productos` arranca con "VARIOS 2 x..." si lo es (no se mezclan con items normales).
 */
export function isVentaVarios2(v) {
  if (!v) return false;
  if (v.is_varios_2 === true) return true;
  const prods = (v.productos || '').toUpperCase();
  return prods.startsWith('VARIOS 2 X') || prods === 'VARIOS 2';
}

/**
 * Detecta si un item (de `ventas_por_dia`) es VARIOS 2.
 * Ahi cada item tiene su nombre en `producto` y rubro en `categoria`.
 */
export function isItemVarios2(v) {
  if (!v) return false;
  if (v.is_varios_2 === true) return true;
  const nombre = (v.producto || v.product_name || '').toUpperCase().trim();
  if (nombre === 'VARIOS 2' || nombre.startsWith('VARIOS 2 ')) return true;
  const cat = (v.categoria || '').toUpperCase().trim();
  return cat === 'VARIOS 2';
}

/** "DD/MM/YYYY" → "YYYY-MM-DD" para comparar con fecha_inicio */
export function fechaDMYtoYMD(dmy) {
  if (!dmy || typeof dmy !== 'string') return '';
  const parts = dmy.split('/');
  if (parts.length !== 3) return dmy; // ya viene en ISO o formato raro
  const [d, m, y] = parts;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
