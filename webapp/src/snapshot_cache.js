/**
 * Snapshot local del store en IndexedDB propio — arranque instantáneo.
 *
 * Problema: aun con el cache persistente de Firestore, el PRIMER snapshot de
 * cada colección grande tarda segundos (medido en el exe: catalogo ~12k docs
 * ≈ 6.6s, ventas_por_dia ~17k docs ≈ 10.3s): el SDK deserializa doc por doc
 * en el main thread. Toda la app espera eso en cada arranque.
 *
 * Solución: cada snapshot del store persiste acá los DOCS CRUDOS de su
 * colección (una entrada `col:<nombre>` por colección). Al próximo arranque,
 * store.hydrateStore() los carga de una (~100-300ms), les aplica los mismos
 * transforms de siempre y puebla el cache → las páginas pintan al instante
 * con los datos de la última sesión. Después un delta chico contra el server
 * (solo días recientes) los pone al día en ~1s, y el listener completo del
 * SDK sigue en background como fuente de verdad final.
 *
 * Este módulo es SOLO almacenamiento (IndexedDB + serialización); la
 * orquestación vive en store.js. Los Timestamp de Firestore no sobreviven el
 * structured clone (pierden el prototipo → .toDate() explota), así que se
 * serializan como {__fsts:[segundos,nanos]} y se reviven al cargar.
 */
import { Timestamp } from 'firebase/firestore';

const DB_NAME = 'pos_snapshots';
const STORE = 'kv';
const SNAP_VERSION = 1;                          // bump → descarta snapshots incompatibles
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;     // más viejo que esto no se hidrata
const DEBOUNCE_MS = 1500;                        // agrupa ráfagas de snapshots
const MIN_INTERVAL_MS = 30_000;                  // techo de escrituras por key (ventas en vivo)

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloqueada'));
  });
  return _dbPromise;
}

// ── Timestamps: Firestore ⇄ JSON plano ────────────────────────────────────────
function esTimestamp(v) {
  return v instanceof Timestamp ||
    (v && typeof v === 'object' && typeof v.toDate === 'function' &&
     typeof v.seconds === 'number' && typeof v.nanoseconds === 'number');
}
function toPlain(v) {
  if (v == null || typeof v !== 'object') return v;
  if (esTimestamp(v)) return { __fsts: [v.seconds, v.nanoseconds] };
  if (v instanceof Date) return v;               // el structured clone conserva Date
  if (Array.isArray(v)) return v.map(toPlain);
  const out = {};
  for (const k in v) out[k] = toPlain(v[k]);
  return out;
}
function revive(v) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v.__fsts)) return new Timestamp(v.__fsts[0], v.__fsts[1]);
  if (v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(revive);
  const out = {};
  for (const k in v) out[k] = revive(v[k]);
  return out;
}

// ── Carga (para hydrateStore) ─────────────────────────────────────────────────
/**
 * Devuelve Map<key, {ts, data}> con todas las entradas válidas (versión y edad
 * OK), ya revividas. Las entradas inválidas/viejas se borran de paso.
 */
export async function loadSnapshots() {
  const db = await openDb();
  const { keys, vals } = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const os = tx.objectStore(STORE);
    const kReq = os.getAllKeys();
    const vReq = os.getAll();
    tx.oncomplete = () => resolve({ keys: kReq.result, vals: vReq.result });
    tx.onerror = () => reject(tx.error);
  });
  const out = new Map();
  const basura = [];
  keys.forEach((key, i) => {
    const e = vals[i];
    const ok = e && e.v === SNAP_VERSION && (Date.now() - e.ts <= MAX_AGE_MS) && String(key).startsWith('col:');
    if (ok) out.set(String(key), { ts: e.ts, data: revive(e.data) });
    else basura.push(key);
  });
  if (basura.length) {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      basura.forEach(k => tx.objectStore(STORE).delete(k));
    } catch (_) {}
  }
  return out;
}

// ── Persistencia (debounced + throttled por key) ──────────────────────────────
const _timers = new Map();        // key → { t: timeout id, data }
const _lastWrite = new Map();     // key → ts de la última escritura

async function _persist(key, data) {
  const plain = toPlain(data);    // fuera de la transacción (el walk es lo caro)
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ v: SNAP_VERSION, ts: Date.now(), data: plain }, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  _lastWrite.set(key, Date.now());
}

/**
 * Programa la persistencia del valor de una key. Debounce corto para agrupar
 * ráfagas y un intervalo mínimo por key para no re-escribir el catálogo entero
 * con cada venta que entra. La escritura corre en idle para no pisar el render.
 */
export function schedulePersist(key, data) {
  const prev = _timers.get(key);
  if (prev) clearTimeout(prev.t);
  const since = Date.now() - (_lastWrite.get(key) || 0);
  const delay = Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - since);
  const t = setTimeout(() => {
    _timers.delete(key);
    const run = () => _persist(key, data).catch(err => console.warn('[snap] persist', key, err));
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 });
    else run();
  }, delay);
  _timers.set(key, { t, data });
}

// Al cerrar/ocultar la app, disparar lo pendiente ya mismo (best-effort: las
// transacciones IDB iniciadas durante pagehide normalmente completan).
function _flushPending() {
  _timers.forEach(({ t, data }, key) => {
    clearTimeout(t);
    _persist(key, data).catch(() => {});
  });
  _timers.clear();
}
window.addEventListener('pagehide', _flushPending);

/** Borra todos los snapshots (para hard-reset / debugging). */
export async function clearSnapshots() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
