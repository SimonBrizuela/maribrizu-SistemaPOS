// ── Balance Mensual ───────────────────────────────────────────────────────────
// Vista principal de Control Total: un único segmented control une el Resumen de
// ganancia (pestaña externa que inyecta control_total.js vía opts.extSegs) con el
// flujo del Excel "BALANCE LIBRERIA": saldos de cierre por medio de pago, breakdown
// por rubro, agregado Semana a Semana y una capa de MONTOS FIJOS compartida
// ("definir una vez, restar en todos los meses").
//
// Origen de datos híbrido: histórico del Excel (BALANCE_SEED, importable e idempotente)
// + autocompletar de ventas reales para meses nuevos. Todo editable a mano.
// Persiste en control_config/balance vía load/saveBalanceConfig (merge recursivo).

import { loadBalanceConfig, saveBalanceConfig, invalidateBalanceConfig, loadDiasMes, saveDiasMes, invalidateDiasMes, parseArDate, isVentaVarios2, saveControlConfig } from '../config.js';
import { BALANCE_SEED } from './balance_seed.js';
import { getCached } from '../cache.js';
import { collection, getDocs, getDoc, query, orderBy, limit, doc, setDoc, updateDoc, deleteField, serverTimestamp } from 'firebase/firestore';
import { cssVar } from '../theme.js';
import { confirmDialog, alertDialog, promptDialog } from '../components/dialogs.js';
import { refreshVencimientos, setPagosMesFromDias } from './calendario_core.js';
import { cadenaMeses, cajaAlDia, aperturaDe, hayMontos, rangoMeses, cuentasDelPeriodo, cuentasMpDe, normCuenta } from '../balance_cadena.js';

const MEDIOS = [
  { k: 'efectivo', label: 'Efectivo' },
  { k: 'mp',       label: 'Mercado Pago' },
  { k: 'lapos',    label: 'Lapos' },
];

// ── Estado del módulo (CT monta el pane una sola vez por carga de página) ──────
let cfg = null;
let db = null;
let mountEl = null;
let view = 'ganancia';
const openMeses = new Set();
let saving = false;
// Cadena de saldos (balance_cadena.js): ym → {apertura, cierre, origen...}. Se
// recalcula al montar y después de cada guardado; de acá sale "Caja actual".
let cadena = null;
// Nombres de cuentas de Mercado Pago vistos en los ingresos (MP JOSE, MP AGUSTIN...):
// se ofrecen en el medio de pago de las compras para saber de qué MP salió la plata.
let mpCuentas = [];

// ── Helpers de formato / parseo es-AR ─────────────────────────────────────────
function fmt(n) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parseNum(raw) {
  if (typeof raw === 'number') return raw;
  if (raw == null) return null;
  let s = String(raw).trim().replace(/[^\d.,\-]/g, '');
  if (s === '' || s === '-') return null;
  if (s.includes(',')) {
    // Formato es-AR explícito: '.' miles, ',' decimal → "1.234,56" = 1234.56
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // Sin coma: en es-AR el punto casi siempre separa miles ("312.694" = 312694).
    // Solo lo tratamos como decimal si NO calza con un patrón de miles
    // (un único punto seguido de 2 dígitos, ej "1234.56", sí queda decimal).
    const dots = (s.match(/\./g) || []).length;
    if (dots > 1 || /^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
// Formato moneda igual al Excel: "$ 1.234,56" (número es-AR con prefijo $ + espacio fijo).
function money(n) { return '$ ' + fmt(n); }
// Marca rojo los negativos (el Excel arrastra descubiertos en negativo).
function negCls(n) { return Number(n) < 0 ? ' bal-neg' : ''; }
function ymAR(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).slice(0, 7);
}
const MESES_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
// "2026-07" → "Julio 26" (mismo estilo de etiqueta del Excel).
function labelFromYm(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return `${MESES_ES[+m[2] - 1] || ''} ${m[1].slice(2)}`.trim();
}

// ── Derivados de la config ────────────────────────────────────────────────────
function mesesOrdenados(dir = 'asc') {
  const keys = Object.keys((cfg && cfg.meses) || {});
  keys.sort();
  if (dir === 'desc') keys.reverse();
  return keys;
}
function mesLabel(ym) { return (cfg.meses?.[ym]?.label) || ym; }
function rubrosLista() { return [...(cfg.rubros || []), ...(cfg.agregados || [])]; }
function esAgregado(rubro) { return (cfg.agregados || []).includes(rubro); }

function saldoVal(ym, medio) {
  const v = cfg.meses?.[ym]?.saldos?.[medio];
  return v == null ? null : Number(v);
}
function totalSaldos(ym) {
  return MEDIOS.reduce((acc, m) => acc + (Number(saldoVal(ym, m.k)) || 0), 0);
}
function rubroVal(ym, rubro) {
  const v = cfg.meses?.[ym]?.rubros?.[rubro];
  return v == null ? null : Number(v);
}
function totalRubrosMes(ym) {
  return rubrosLista().reduce((acc, r) => acc + (Number(rubroVal(ym, r)) || 0), 0);
}

function fijosActivos() { return (cfg.montosFijos || []).filter(f => f.activo !== false); }
// Mes actual (AR, "2026-07") — para saber si un fijo se está aplicando "ahora".
function ymActualAR() { return ymAR(new Date()); }
// ¿El fijo se aplica en el mes ym? Respeta la pausa global (activo:false), la baja
// "desde tal mes en adelante" (desactivadoDesde, inclusive) y la exclusión puntual
// de un mes (fijosExcluidos). Es el criterio único de "aplica o no".
function fijoAplica(fijo, ym) {
  if (fijo.activo === false) return false;
  if (fijo.desactivadoDesde && ym >= fijo.desactivadoDesde) return false;
  const mes = cfg.meses?.[ym];
  if (mes && Array.isArray(mes.fijosExcluidos) && mes.fijosExcluidos.includes(fijo.id)) return false;
  return true;
}
function fijoMontoEnMes(ym, fijo) {
  if (!fijoAplica(fijo, ym)) return 0;
  const ov = cfg.meses?.[ym]?.fijosOverride?.[fijo.id];
  if (ov != null) return Number(ov) || 0;
  return Number(fijo.monto) || 0;
}
function totalFijosMes(ym) {
  return fijosActivos().reduce((s, f) => s + fijoMontoEnMes(ym, f), 0);
}
function fuenteValida(f) { return MEDIOS.some(m => m.k === f) ? f : 'efectivo'; }

// ── Cadena de saldos ──────────────────────────────────────────────────────────
// Lo tipeado manda y lo que falta se calcula: la apertura de un mes es la
// tipeada o el cierre del anterior; el cierre son los saldos tipeados (mes
// pasado) o apertura + días. Así "Caja actual" es la de hoy sin que nadie
// tenga que "fijar el cierre" cada mes ni cargar la apertura del siguiente.
function saldosTipeados() {
  const out = {};
  Object.entries(cfg?.meses || {}).forEach(([ym, m]) => { if (m && m.saldos) out[ym] = m.saldos; });
  return out;
}
function mesesDeLaCadena() {
  const ymHoy = hoyAR().slice(0, 7);
  const primero = mesesOrdenados('asc')[0] || ymHoy;
  return ymRange(primero <= ymHoy ? primero : ymHoy, ymHoy);
}
async function recalcularCadena() {
  const meses = mesesDeLaCadena();
  const docs = {};
  await Promise.all(meses.map(async ym => { docs[ym] = await loadDiasMes(db, ym); }));
  cadena = cadenaMeses({ meses, tipeados: saldosTipeados(), docs, hoy: hoyAR() });
  mpCuentas = cuentasMpDe(docs);
  return cadena;
}
// Apertura con la que arranca un mes en el Día por día: la tipeada, o la que
// viene de la cadena (cierre del mes anterior).
function aperturaEfectiva(ym, docMes) {
  const ap = docMes && docMes.apertura;
  if (hayMontos(ap)) return { efectivo: Number(ap.efectivo) || 0, mp: Number(ap.mp) || 0, lapos: Number(ap.lapos) || 0, origen: 'tipeada' };
  const enc = aperturaDe(cadena, ym);
  if (enc) return { ...enc, origen: 'cierre_anterior' };
  return { efectivo: 0, mp: 0, lapos: 0, origen: 'ninguna' };
}

// "Caja actual" = plata que tengo hoy por medio de pago: el acumulado del mes en
// curso al último día cargado (o el cierre del último mes con datos). Hasta el
// 22-08 era el último mes con saldos tipeados y se quedaba en junio.
function cajaActual() {
  if (cadena) {
    const c = cajaAlDia(cadena, hoyAR());
    if (c) return c;
  }
  for (const ym of mesesOrdenados('desc')) {
    const s = cfg.meses?.[ym]?.saldos;
    if (s && (s.efectivo != null || s.mp != null || s.lapos != null)) return { ym, dd: null, saldos: s, origen: 'tipeado' };
  }
  return null;
}
function cajaActualHtml() {
  const c = cajaActual();
  if (!c) return '';
  const s = c.saldos;
  const ef = Number(s.efectivo) || 0, mp = Number(s.mp) || 0, lp = Number(s.lapos) || 0, sin = Number(s.sin) || 0;
  const tot = ef + mp + lp + sin;
  const cuando = c.dd ? `al ${c.dd}/${c.ym.slice(5, 7)}` : `al cierre de ${esc(mesLabel(c.ym))}`;
  const como = c.origen === 'calculado'
    ? (c.aperturaOrigen === 'cierre_anterior' ? 'sigue del cierre del mes anterior más los días cargados' : 'apertura del mes más los días cargados')
    : 'saldos tipeados en el Resumen';
  return `
    <div class="bal-caja-band">
      <div class="bal-caja-head">
        <span class="material-icons">account_balance_wallet</span>
        <span class="bal-caja-title">Caja actual</span>
        <small title="${esc(como)}">${cuando}</small>
      </div>
      <div class="bal-caja-medios">
        <div class="bal-caja-item is-efectivo"><span>Efectivo</span><b class="${negCls(ef).trim()}">${money(ef)}</b></div>
        <div class="bal-caja-item"><span>Mercado Pago</span><b class="${negCls(mp).trim()}">${money(mp)}</b></div>
        <div class="bal-caja-item"><span>Lapos</span><b class="${negCls(lp).trim()}">${money(lp)}</b></div>
        <div class="bal-caja-item is-total"><span>Total</span><b class="${negCls(tot).trim()}">${money(tot)}</b></div>
      </div>
    </div>`;
}
// Refresca la banda en el lugar (tras editar un saldo o fijar un cierre).
function refreshCajaBand() {
  const wrap = mountEl && mountEl.querySelector('.bal-wrap');
  if (!wrap) return;
  const band = wrap.querySelector('.bal-caja-band');
  const html = cajaActualHtml();
  if (band) { if (html) band.outerHTML = html; else band.remove(); }
  else if (html) { const head = wrap.querySelector('.bal-head'); if (head) head.insertAdjacentHTML('afterend', html); }
}

// Garantiza la ruta cfg.meses[ym] mutable en memoria.
function ensureMes(ym) {
  if (!cfg.meses) cfg.meses = {};
  if (!cfg.meses[ym]) cfg.meses[ym] = { label: ym, origen: 'manual' };
  return cfg.meses[ym];
}

// ── Persistencia ──────────────────────────────────────────────────────────────
async function persistMes(ym, patch) {
  try {
    await saveBalanceConfig(db, { meses: { [ym]: patch } });
    recordBal(patchLabel(ym, patch));
  } catch (err) {
    console.error('[balance] error guardando mes', ym, err);
    alertDialog({ title: 'No se pudo guardar', message: 'No se pudo guardar. Verificá la conexión; se restauró el estado anterior.', type: 'error' });
    invalidateBalanceConfig();
    const fresh = await loadBalanceConfig(db);
    if (fresh) cfg = fresh;
    render();
  }
}
async function persistFijos() {
  try {
    await saveBalanceConfig(db, { montosFijos: cfg.montosFijos });
    recordBal('Montos fijos');
    refreshVencimientos(db);   // el calendario/badge relee los vencimientos
  } catch (err) {
    console.error('[balance] error guardando montos fijos', err);
    alertDialog({ title: 'No se pudo guardar', message: 'No se pudo guardar. Verificá la conexión; se restauró el estado anterior.', type: 'error' });
    invalidateBalanceConfig();
    const fresh = await loadBalanceConfig(db);
    if (fresh) cfg = fresh;
    render();
  }
}

// Al borrar un fijo: persiste el array nuevo Y limpia los override/exclusiones
// huérfanos de ese id en todos los meses (deleteField sobre el mapa anidado).
async function removeFijoEverywhere(removedId) {
  const updates = { montosFijos: cfg.montosFijos, updatedAt: serverTimestamp() };
  for (const [ym, mes] of Object.entries(cfg.meses || {})) {
    if (mes.fijosOverride && removedId in mes.fijosOverride) {
      delete mes.fijosOverride[removedId];
      updates[`meses.${ym}.fijosOverride.${removedId}`] = deleteField();
    }
    if (Array.isArray(mes.fijosExcluidos) && mes.fijosExcluidos.includes(removedId)) {
      mes.fijosExcluidos = mes.fijosExcluidos.filter(x => x !== removedId);
      updates[`meses.${ym}.fijosExcluidos`] = mes.fijosExcluidos;
    }
  }
  try {
    await updateDoc(doc(db, 'control_config', 'balance'), updates);
    invalidateBalanceConfig();
    recordBal('Eliminar fijo');
    refreshVencimientos(db);
  } catch (err) {
    console.error('[balance] error limpiando fijo huérfano, fallback a persistFijos:', err);
    await persistFijos();
  }
}

// Excluye un fijo de varios meses en UNA sola operación (un solo guardado + una
// sola entrada de historial), para que el undo lo revierta de una. Se usa cuando
// se lo quita "solo ese mes" o "desde ese mes en adelante" (conserva el histórico).
async function excluirFijoEnMeses(fijoId, targets, label) {
  const patch = { meses: {} };
  for (const ym of targets) {
    const mes = ensureMes(ym);
    const set = new Set(mes.fijosExcluidos || []);
    set.add(fijoId);
    mes.fijosExcluidos = [...set];
    patch.meses[ym] = { fijosExcluidos: mes.fijosExcluidos };
  }
  try {
    await saveBalanceConfig(db, patch);
    recordBal(label);
    refreshVencimientos(db);
  } catch (err) {
    console.error('[balance] error excluyendo fijo', err);
    alertDialog({ title: 'No se pudo guardar', message: 'No se pudo guardar. Verificá la conexión; se restauró el estado anterior.', type: 'error' });
    invalidateBalanceConfig();
    const fresh = await loadBalanceConfig(db);
    if (fresh) cfg = fresh;
    render();
  }
}

// Escritura directa al doc (para borrados de campos / reemplazo de sub-mapas).
// Las mutaciones de cfg en memoria son optimistas; si la escritura falla,
// re-sincronizamos cfg desde Firestore y re-renderizamos para deshacerlas.
async function updateDocBalance(updates) {
  const payload = { ...updates, updatedAt: serverTimestamp() };
  try {
    await updateDoc(doc(db, 'control_config', 'balance'), payload);
    invalidateBalanceConfig();
  } catch (err) {
    console.error('[balance] updateDocBalance error:', err);
    alertDialog({ title: 'No se pudo guardar', message: 'No se pudo guardar el cambio. Verificá la conexión; se restauró el estado anterior.', type: 'error' });
    invalidateBalanceConfig();
    const fresh = await loadBalanceConfig(db);
    if (fresh) cfg = fresh;
    render();
  }
}

// ════════════════ Historial de cambios (undo / redo) ════════════════
// Mismo modo que el Catálogo, adaptado al modelo del Balance: cada entrada es un
// snapshot del scope afectado — 'bal' (control_config/balance) o 'dias' (un mes).
// En memoria (se reinicia al recargar). Atajos: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
const HIST_MAX = 60;
let hUndo = [], hRedo = [], hSeq = 0;
let snapBal = null;            // clon del contenido de balance al último commit
const snapDias = {};           // ym -> clon del mapa dias al último commit
let curDiasDoc = null;         // {ym, dias} cargado en la vista Día por día
let _histToast = null;

const hclone = (o) => JSON.parse(JSON.stringify(o ?? null));
function balContent() {
  return { version: cfg.version, rubros: cfg.rubros || [], agregados: cfg.agregados || [], montosFijos: cfg.montosFijos || [], meses: cfg.meses || {} };
}
function histReset() {
  hUndo = []; hRedo = []; hSeq = 0;
  snapBal = cfg ? hclone(balContent()) : null;
  for (const k in snapDias) delete snapDias[k];
  updateHistUI();
}
function patchLabel(ym, patch) {
  const m = mesLabel(ym);
  if (patch.saldos) return `Saldos · ${m}`;
  if (patch.rubros) return `Rubros · ${m}`;
  if (patch.fijosOverride) return `Fijo · ${m}`;
  if (patch.fijosExcluidos) return `Excluir fijo · ${m}`;
  if (patch.label) return `Nombre · ${m}`;
  return `Editar · ${m}`;
}
function recordBal(label) {
  if (!snapBal) { snapBal = hclone(balContent()); return; }
  const after = hclone(balContent());
  if (JSON.stringify(snapBal) === JSON.stringify(after)) return;   // no-op: no ensucia la pila ni pierde el redo
  hUndo.push({ id: ++hSeq, scope: 'bal', before: snapBal, after, label: label || 'Cambio' });
  if (hUndo.length > HIST_MAX) hUndo.shift();
  hRedo = []; snapBal = after; updateHistUI();
}
function snapDiasInit(ym) {
  if (!(ym in snapDias)) snapDias[ym] = hclone((curDiasDoc && curDiasDoc.ym === ym && curDiasDoc.dias) || {});
}
function recordDias(ym, label, dd) {
  snapDiasInit(ym);
  const after = hclone((curDiasDoc && curDiasDoc.ym === ym && curDiasDoc.dias) || {});
  if (JSON.stringify(snapDias[ym]) === JSON.stringify(after)) return;
  hUndo.push({ id: ++hSeq, scope: 'dias', ym, dd, before: snapDias[ym], after, label: label || 'Editar día' });
  if (hUndo.length > HIST_MAX) hUndo.shift();
  hRedo = []; snapDias[ym] = after; updateHistUI();
}

async function restoreBal(content) {
  // Escribir a Firestore PRIMERO; recién si tiene éxito tocamos memoria (si falla,
  // histApply repone la entrada y el estado en memoria queda intacto).
  await setDoc(doc(db, 'control_config', 'balance'), {
    version: content.version ?? 1, rubros: content.rubros || [], agregados: content.agregados || [],
    montosFijos: content.montosFijos || [], meses: content.meses || {}, updatedAt: serverTimestamp(),
  });
  Object.assign(cfg, hclone(content));
  snapBal = hclone(content);
  invalidateBalanceConfig();
}
async function restoreDias(ym, dias) {
  const origen = (curDiasDoc && curDiasDoc.ym === ym && curDiasDoc.origen) || 'excel';
  // El historial versiona SOLO 'dias'; la apertura no. Se escribe el doc completo
  // (setDoc sin merge para poder quitar días agregados), pero preservando la
  // apertura vigente para no borrarla al deshacer/rehacer una edición de día.
  let apertura = (curDiasDoc && curDiasDoc.ym === ym) ? curDiasDoc.apertura : undefined;
  if (apertura === undefined) { const d = await loadDiasMes(db, ym); apertura = d && d.apertura; }
  const payload = { ym, origen, dias: dias || {}, updatedAt: serverTimestamp() };
  if (apertura) payload.apertura = apertura;
  await setDoc(doc(db, 'control_config', `dias_${ym}`), payload);
  snapDias[ym] = hclone(dias);
  if (curDiasDoc && curDiasDoc.ym === ym) curDiasDoc.dias = hclone(dias);
  invalidateDiasMes(ym);
}
async function histApply(entry, dir) {
  const target = dir === 'undo' ? entry.before : entry.after;
  try {
    if (entry.scope === 'bal') await restoreBal(target);
    else { await restoreDias(entry.ym, target); if (entry.ym) curDiaYm = entry.ym; if (entry.dd) curDiaDD = entry.dd; }
  } catch (e) {
    console.error('[balance] histApply', e);
    alertDialog({ title: 'No se pudo aplicar', message: 'Revisá la conexión e intentá de nuevo.', type: 'error' });
    return false;
  }
  render();
  return true;
}
async function histUndo() {
  const e = hUndo.pop(); if (!e) return;
  if (await histApply(e, 'undo')) { hRedo.push(e); flash(`Deshecho: ${e.label}`, 'undo'); updateHistUI(); }
  else hUndo.push(e);
}
async function histRedoFn() {
  const e = hRedo.pop(); if (!e) return;
  if (await histApply(e, 'redo')) { hUndo.push(e); flash(`Rehecho: ${e.label}`, 'redo'); updateHistUI(); }
  else hRedo.push(e);
}
async function histUndoTo(id) {
  const idx = hUndo.findIndex(e => e.id === id);
  if (idx < 0) return;
  for (let i = hUndo.length - idx; i > 0; i--) await histUndo();
}
function updateHistUI() {
  const u = mountEl && mountEl.querySelector('#bal-undo');
  const r = mountEl && mountEl.querySelector('#bal-redo');
  if (u) { u.disabled = !hUndo.length; u.title = hUndo.length ? `Deshacer: ${hUndo[hUndo.length - 1].label} (Ctrl+Z)` : 'Nada para deshacer'; }
  if (r) { r.disabled = !hRedo.length; r.title = hRedo.length ? `Rehacer: ${hRedo[hRedo.length - 1].label} (Ctrl+Y)` : 'Nada para rehacer'; }
  const c = mountEl && mountEl.querySelector('#bal-hist-count');
  if (c) c.textContent = hUndo.length ? String(hUndo.length) : '';
}
function flash(msg, kind) {
  const bg = kind === 'undo' ? 'var(--tint-orange-fg)' : kind === 'redo' ? 'var(--tint-teal-fg)' : 'var(--bal-green)';
  if (_histToast) _histToast.remove();
  const t = document.createElement('div');
  t.className = 'bal-toast'; t.style.background = bg;
  t.innerHTML = `<span class="material-icons" style="font-size:18px">${kind === 'undo' ? 'undo' : kind === 'redo' ? 'redo' : 'check_circle'}</span><span>${esc(msg)}</span>`;
  document.body.appendChild(t); _histToast = t;
  setTimeout(() => { t.remove(); if (t === _histToast) _histToast = null; }, 2200);
}
function openHistPanel() {
  document.querySelector('.bal-hist-overlay')?.remove();
  const ov = document.createElement('div');
  ov.className = 'bal-hist-overlay';
  const items = [...hUndo].reverse();
  const redos = [...hRedo].reverse();
  ov.innerHTML = `
    <div class="bal-hist-drawer">
      <div class="bal-hist-head"><h3><span class="material-icons">history</span> Historial de cambios</h3><button class="bal-hist-x"><span class="material-icons">close</span></button></div>
      <div class="bal-hist-list">
        ${items.length ? items.map(e => `<button class="bal-hist-item" data-id="${e.id}"><span class="material-icons" style="font-size:15px">undo</span><span>${esc(e.label)}</span></button>`).join('') : '<div class="bal-mov-empty">Sin cambios para deshacer todavía.</div>'}
        ${redos.length ? `<div class="bal-hist-sep">Rehacer disponibles</div>` + redos.map(e => `<div class="bal-hist-item is-redo"><span class="material-icons" style="font-size:15px">redo</span><span>${esc(e.label)}</span></div>`).join('') : ''}
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('.bal-hist-x').onclick = () => ov.remove();
  ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
  ov.querySelectorAll('.bal-hist-item[data-id]').forEach(b => b.addEventListener('click', async () => { ov.remove(); await histUndoTo(Number(b.dataset.id)); }));
}
function balHistKey(e) {
  if (!mountEl || !mountEl.isConnected) return;
  // El deshacer es de las vistas editables; en el Resumen (solo lectura) no aplica.
  if (view === 'ganancia') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const z = e.key === 'z' || e.key === 'Z', y = e.key === 'y' || e.key === 'Y';
  if ((e.ctrlKey || e.metaKey) && z && !e.shiftKey) { e.preventDefault(); histUndo(); }
  else if ((e.ctrlKey || e.metaKey) && (y || (z && e.shiftKey))) { e.preventDefault(); histRedoFn(); }
}
function attachHistKeyboard() {
  if (window.__balHistKey) document.removeEventListener('keydown', window.__balHistKey);
  window.__balHistKey = balHistKey;
  document.addEventListener('keydown', balHistKey);
}

// ── Gestión de estructura: agregar / renombrar / borrar (con propagación) ──────
// Nota Firestore: los nombres de rubro pueden tener '.' (ej "ACC. CELULAR"), que
// rompen los field-paths con punto. Por eso al tocar rubros reescribimos el mapa
// entero meses.<ym>.rubros (el <ym> nunca tiene punto). Los ids de fijo y los <ym>
// sí son seguros como segmentos de path.

async function addMes() {
  const last = mesesOrdenados('desc')[0];
  let suggest = '';
  if (last) {
    const [y, mo] = last.split('-').map(Number);
    const ny = mo === 12 ? y + 1 : y;
    const nm = mo === 12 ? 1 : mo + 1;
    suggest = `${ny}-${String(nm).padStart(2, '0')}`;
  }
  const raw = await promptDialog({
    title: 'Agregar mes',
    message: 'Período en formato <b>AAAA-MM</b> (ej: 2026-07). La etiqueta se arma sola.',
    defaultValue: suggest, placeholder: 'AAAA-MM',
  });
  if (!raw) return;
  const m = /^(\d{4})-(\d{2})$/.exec(raw.trim());
  if (!m || +m[2] < 1 || +m[2] > 12) {
    return alertDialog({ title: 'Período inválido', message: 'Usá el formato AAAA-MM (ej: 2026-07).', type: 'error' });
  }
  const ym = `${m[1]}-${m[2]}`;
  if (cfg.meses && cfg.meses[ym]) {
    return alertDialog({ title: 'Ya existe', message: `El mes ${esc(labelFromYm(ym))} ya está cargado.`, type: 'warning' });
  }
  const mes = ensureMes(ym);
  mes.label = labelFromYm(ym);
  mes.origen = 'manual';
  await persistMes(ym, { label: mes.label, origen: 'manual' });
  renderBody();
}

async function addRubro(esAgr) {
  const name = (await promptDialog({
    title: esAgr ? 'Agregar agregado' : 'Agregar rubro',
    message: esAgr ? 'Nombre del agregado (se suma como fila aparte):' : 'Nombre del rubro:',
    placeholder: esAgr ? 'Ej: IMPUESTOS' : 'Ej: REGALERIA',
  }) || '').trim();
  if (!name) return;
  const todos = [...(cfg.rubros || []), ...(cfg.agregados || [])];
  if (todos.some(r => r.toUpperCase() === name.toUpperCase())) {
    return alertDialog({ title: 'Ya existe', message: `"${esc(name)}" ya está en la lista.`, type: 'warning' });
  }
  if (esAgr) { (cfg.agregados = cfg.agregados || []).push(name); await saveBalanceConfig(db, { agregados: cfg.agregados }); }
  else       { (cfg.rubros = cfg.rubros || []).push(name);       await saveBalanceConfig(db, { rubros: cfg.rubros }); }
  recordBal(esAgr ? 'Agregar agregado' : 'Agregar rubro');
  renderBody();
}

async function renameRubro(oldName, newName, esAgr) {
  const list = esAgr ? cfg.agregados : cfg.rubros;
  const i = list.indexOf(oldName);
  if (i < 0) return;
  list[i] = newName;
  const updates = { [esAgr ? 'agregados' : 'rubros']: list };
  for (const [ym, mes] of Object.entries(cfg.meses || {})) {
    if (mes.rubros && oldName in mes.rubros) {
      mes.rubros[newName] = mes.rubros[oldName];
      delete mes.rubros[oldName];
      updates[`meses.${ym}.rubros`] = mes.rubros;   // reescribe el mapa entero
    }
  }
  await updateDocBalance(updates);
  recordBal('Renombrar rubro');
}

async function removeRubro(name, esAgr) {
  const list = esAgr ? cfg.agregados : cfg.rubros;
  const i = list.indexOf(name);
  if (i < 0) return;
  list.splice(i, 1);
  const updates = { [esAgr ? 'agregados' : 'rubros']: list };
  for (const [ym, mes] of Object.entries(cfg.meses || {})) {
    if (mes.rubros && name in mes.rubros) {
      delete mes.rubros[name];
      updates[`meses.${ym}.rubros`] = Object.keys(mes.rubros).length ? mes.rubros : deleteField();
    }
  }
  await updateDocBalance(updates);
  recordBal('Eliminar rubro');
}

async function removeMes(ym) {
  if (cfg.meses) delete cfg.meses[ym];
  openMeses.delete(ym);
  await updateDocBalance({ [`meses.${ym}`]: deleteField() });
  recordBal('Eliminar mes');
}

// Las vistas del Balance (Resumen vivo, Meses, Semana a Semana…) listan los
// meses de cfg.meses, que hasta ahora se creaban a mano en "Meses": el Resumen
// vivo se quedaba clavado en el último mes agregado aunque el Día por día
// siguiera cargando caja todos los días. Al abrir, los meses que faltan hasta
// el actual se crean solos (solo la ficha, sin datos: los días ya viven en
// dias_<ym> y lo demás queda para completar). Una sola escritura, sin ensuciar
// el historial de undo (corre antes de histReset). Si falla el guardado, los
// meses igual quedan en memoria para esta sesión.
async function autocrearMesesFaltantes() {
  const ymHoy = hoyAR().slice(0, 7);
  const last = mesesOrdenados('desc')[0];
  if (!last || last >= ymHoy) return;   // sin histórico manda el import; al día no hay nada que crear
  const patch = { meses: {} };
  for (const ym of ymRange(last, ymHoy)) {
    if (cfg.meses[ym]) continue;
    const mes = ensureMes(ym);
    mes.label = labelFromYm(ym);
    mes.origen = 'auto';
    patch.meses[ym] = { label: mes.label, origen: 'auto' };
  }
  if (!Object.keys(patch.meses).length) return;
  try {
    await saveBalanceConfig(db, patch);
  } catch (err) {
    console.error('[balance] autocrear meses faltantes', err);
  }
}

// ── Punto de entrada ──────────────────────────────────────────────────────────
export async function mountBalanceMensual(paneEl, _db) {
  mountEl = paneEl;
  db = _db;
  view = localStorage.getItem('bal:view') || 'ganancia';
  if (view === 'fijos') view = 'dia';   // la pestaña Montos fijos se movió a Día por día
  if (!['ganancia', 'resumen', 'semana', 'dia', 'cuentas', 'meses', 'buscar'].includes(view)) view = 'ganancia';
  openMeses.clear();
  curDiaYm = curDiaDD = null;   // la vista Día por día arranca siempre en hoy
  paneEl.innerHTML = `<div class="ct-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div>`;
  cfg = await loadBalanceConfig(db);
  if (tieneDatos()) await autocrearMesesFaltantes();
  // Precarga el detalle diario de TODOS los meses en paralelo. Sin esto, los
  // renders y agregados que recorren el histórico llamaban loadDiasMes uno por
  // uno (~300ms c/u secuencial → ~6s con ~20 meses de histórico). loadDiasMes
  // está cacheado (getCached), así que calentar el cache en paralelo deja esos
  // loops leyendo sincrónico del cache. Baja el arranque del balance a ~0.5s.
  try {
    await Promise.all(mesesOrdenados('desc').map(ym => loadDiasMes(db, ym)));
  } catch (_) {}
  try { await recalcularCadena(); } catch (err) { console.error('[balance] cadena de saldos', err); }
  curDiasDoc = null;
  histReset();
  attachHistKeyboard();
  render();
}

function tieneDatos() {
  return cfg && cfg.meses && Object.keys(cfg.meses).length > 0;
}

// ── Render raíz ───────────────────────────────────────────────────────────────
// El shell (segmented control + banda de caja) se renderiza siempre; el estado
// vacío (sin datos importados) vive en renderBody.
function render() {
  const segs = [
    { k: 'ganancia', label: 'Resumen',          icon: 'dashboard' },
    { k: 'resumen',  label: 'Resumen vivo',     icon: 'table_chart' },
    { k: 'semana',   label: 'Semana a Semana',  icon: 'view_week' },
    { k: 'dia',      label: 'Día por día',      icon: 'today' },
    { k: 'cuentas',  label: 'Cuentas',          icon: 'account_balance' },
    { k: 'meses',    label: 'Meses',            icon: 'calendar_month' },
    { k: 'buscar',   label: 'Buscar',           icon: 'search' },
  ];
  mountEl.innerHTML = `
    <div class="bal-wrap">
      <div class="bal-head">
        <div class="bal-seg" role="tablist">
          ${segs.map(s => `
            <button type="button" class="bal-seg-btn${s.k === view ? ' active' : ''}" data-seg="${s.k}">
              <span class="material-icons">${s.icon}</span> ${s.label}
            </button>`).join('')}
        </div>
        <div class="bal-head-actions">
          <button type="button" class="bal-icon-btn" id="bal-undo" title="Deshacer (Ctrl+Z)"><span class="material-icons">undo</span></button>
          <button type="button" class="bal-icon-btn" id="bal-redo" title="Rehacer (Ctrl+Y)"><span class="material-icons">redo</span></button>
          <button type="button" class="bal-icon-btn" id="bal-hist" title="Historial de cambios"><span class="material-icons">history</span><span class="bal-hist-badge" id="bal-hist-count"></span></button>
          <button type="button" class="bal-btn bal-btn-ghost" id="bal-import-dias" title="Carga el detalle día por día del Excel (2026) al 'Día por día'. No pisa los días ya cargados.">
            <span class="material-icons">event_note</span> Importar días
          </button>
          <button type="button" class="bal-btn bal-btn-ghost" id="bal-reimport" title="Agrega los meses del Excel que falten (no pisa los ya cargados)">
            <span class="material-icons">file_download</span> Importar histórico
          </button>
        </div>
      </div>
      ${cajaActualHtml()}
      <div id="bal-body"></div>
    </div>`;

  mountEl.querySelectorAll('.bal-seg-btn').forEach(b => b.addEventListener('click', () => {
    view = b.dataset.seg;
    localStorage.setItem('bal:view', view);
    if (view === 'dia') { curDiaYm = curDiaDD = null; }   // al entrar, mostrar hoy
    mountEl.querySelectorAll('.bal-seg-btn').forEach(x => x.classList.toggle('active', x.dataset.seg === view));
    renderBody();
  }));
  mountEl.querySelector('#bal-reimport')?.addEventListener('click', () => importarHistorico(false));
  mountEl.querySelector('#bal-import-dias')?.addEventListener('click', () => importarDiasExcel(false));
  mountEl.querySelector('#bal-undo')?.addEventListener('click', histUndo);
  mountEl.querySelector('#bal-redo')?.addEventListener('click', histRedoFn);
  mountEl.querySelector('#bal-hist')?.addEventListener('click', openHistPanel);

  renderBody();
  updateHistUI();
}

// Estado vacío de las vistas del balance (las pestañas externas no lo necesitan).
function renderEmptyBody(body) {
  body.innerHTML = `
    <div class="bal-empty">
      <span class="material-icons">savings</span>
      <div class="bal-empty-title">Balance Mensual todavía sin datos</div>
      <div class="bal-empty-sub">
        Importá el histórico del Excel "BALANCE LIBRERIA" (saldos por medio de pago, rubros y montos fijos
        de 19 meses) como base. Después podés editarlo a mano y los meses nuevos se autocompletan desde las ventas reales.
      </div>
      <button type="button" class="bal-btn" id="bal-import">
        <span class="material-icons">file_download</span> Importar histórico del Excel
      </button>
    </div>`;
  body.querySelector('#bal-import')?.addEventListener('click', () => importarHistorico(true));
}

// Encuentra el contenedor que scrollea (para preservar la posición en re-renders).
function scrollAncestor() {
  let el = mountEl;
  while (el && el.nodeType === 1 && el !== document.body) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 2) return el;
    el = el.parentElement;
  }
  return null;
}

function renderBody() {
  const body = mountEl.querySelector('#bal-body');
  if (!body) return;
  if (!tieneDatos()) { renderEmptyBody(body); return; }
  // Preservar scroll en los re-render síncronos (agregar/renombrar/borrar) para
  // no saltar al tope. Día/Buscar cargan async y manejan su propio estado.
  const scroller = scrollAncestor();
  const sTop = scroller ? scroller.scrollTop : window.scrollY;
  const restore = () => { if (scroller) scroller.scrollTop = sTop; else window.scrollTo(0, sTop); };
  if (view === 'ganancia') renderGanancia(body);
  else if (view === 'resumen') renderResumen(body).then(restore);
  else if (view === 'semana') renderSemana(body);
  else if (view === 'dia') renderDia(body);
  else if (view === 'cuentas') renderCuentas(body);
  else if (view === 'meses') { renderMeses(body); restore(); }
  else if (view === 'buscar') renderBuscar(body);
  else { view = 'dia'; renderDia(body); }
}

// ── Sub-vista: RESUMEN vivo ───────────────────────────────────────────────────
async function renderResumen(body) {
  const meses = mesesOrdenados('asc');
  const allRubros = rubrosLista();          // 12 rubros + 3 agregados (orden = índice de data-rub-rowtot)
  const rubros = cfg.rubros || [];
  const agregados = cfg.agregados || [];
  if (!cadena) { try { await recalcularCadena(); } catch (_) {} }
  if (view !== 'resumen') return;
  const cad = cadena || {};

  const inputCell = (attrs, v) =>
    `<td><input class="bal-cell-input${negCls(v)}" type="text" inputmode="decimal" ${attrs}
       value="${v == null ? '' : fmt(v)}" placeholder="—"></td>`;

  // Saldo de cierre a mostrar: el tipeado, o el calculado por la cadena
  // (apertura + días) cuando no hay nada tipeado. El calculado se ve en gris
  // e itálica; tipear un número lo fija.
  const saldoAuto = (ym, k) =>
    (saldoVal(ym, k) == null && cad[ym] && cad[ym].cierreOrigen === 'calculado') ? cad[ym].cierre[k] : null;
  const saldoEf = (ym, k) => { const t = saldoVal(ym, k); return t == null ? saldoAuto(ym, k) : t; };
  const totalEf = (ym) => MEDIOS.reduce((s, m) => s + (Number(saldoEf(ym, m.k)) || 0), 0);
  const saldoCell = (ym, m) => {
    const auto = saldoAuto(ym, m.k);
    if (auto == null) return inputCell(`data-saldo-ym="${ym}" data-saldo-medio="${m.k}"`, saldoVal(ym, m.k));
    return `<td><input class="bal-cell-input is-auto${negCls(auto)}" type="text" inputmode="decimal"
       data-saldo-ym="${ym}" data-saldo-medio="${m.k}" value="${fmt(auto)}"
       title="Calculado: apertura del mes + días cargados. Tipeá un número para fijarlo."></td>`;
  };

  // Tabla SALDOS: filas = meses, columnas = medios + total
  const saldosRows = meses.map(ym => `
    <tr>
      <td class="bal-td-lbl">${esc(mesLabel(ym))}</td>
      ${MEDIOS.map(m => saldoCell(ym, m)).join('')}
      <td class="bal-td-total${negCls(totalEf(ym))}" data-saldo-rowtot="${ym}">${money(totalEf(ym))}</td>
    </tr>`).join('');

  const colTot = {};
  MEDIOS.forEach(m => { colTot[m.k] = meses.reduce((s, ym) => s + (Number(saldoEf(ym, m.k)) || 0), 0); });
  const grandSaldos = MEDIOS.reduce((s, m) => s + colTot[m.k], 0);

  // Tabla RUBROS: filas = rubros (+ separador + agregados), columnas = meses + total fila.
  // El índice de data-rub-rowtot es la posición GLOBAL en allRubros (lo usa recomputeRubrosTotals).
  const rubroRow = (r) => {
    const idx = allRubros.indexOf(r);
    const rowTot = meses.reduce((s, ym) => s + (Number(rubroVal(ym, r)) || 0), 0);
    return `<tr class="${esAgregado(r) ? 'bal-row-agregado' : ''}">
      <td class="bal-td-lbl bal-rub-cell">
        <input class="bal-rub-name" data-rub-rename="${esc(r)}" value="${esc(r)}" title="Renombrar (se actualiza en todos los meses)">
        <button type="button" class="bal-rub-ver" data-rub-ver="${esc(r)}" title="Ver detalle de los días"><span class="material-icons">visibility</span></button>
        <button type="button" class="bal-rub-del" data-rub-del="${esc(r)}" title="Eliminar fila"><span class="material-icons">close</span></button>
      </td>
      ${meses.map(ym => inputCell(`data-rub-ym="${ym}" data-rub-rubro="${esc(r)}"`, rubroVal(ym, r))).join('')}
      <td class="bal-td-total${negCls(rowTot)}" data-rub-rowtot="${idx}">${money(rowTot)}</td>
    </tr>`;
  };
  const sepRow = agregados.length
    ? `<tr class="bal-row-sep"><td colspan="${meses.length + 2}">Agregados</td></tr>`
    : '';
  const grandRubros = allRubros.reduce((s, r) => s + meses.reduce((a, ym) => a + (Number(rubroVal(ym, r)) || 0), 0), 0);

  body.innerHTML = `
    <div class="bal-caption"><span class="material-icons">grid_on</span>
      Réplica viva de la hoja <b>RESUMEN</b> del Excel. Editás las celdas en el lugar y los totales
      (el <code>SUM</code> del Excel) se recalculan al instante. Los saldos quedan guardados en la página.</div>

    <div class="bal-card bal-xls" style="margin-bottom:16px">
      <div class="bal-card-title"><span class="material-icons">account_balance_wallet</span> Saldos de cierre por medio de pago</div>
      <div class="bal-table-wrap">
        <table class="bal-table bal-xls-table">
          <thead><tr>
            <th class="bal-th-lbl">Mes</th>
            ${MEDIOS.map(m => `<th>${esc(m.label)}</th>`).join('')}
            <th class="bal-th-total">Total</th>
          </tr></thead>
          <tbody>${saldosRows}</tbody>
          <tfoot><tr class="bal-row-total">
            <td class="bal-td-lbl">Total</td>
            ${MEDIOS.map(m => `<td data-saldo-coltot="${m.k}">${money(colTot[m.k])}</td>`).join('')}
            <td class="bal-td-total" data-saldo-grand>${money(grandSaldos)}</td>
          </tr></tfoot>
        </table>
      </div>
      <div class="bal-toolbar"><button type="button" class="bal-add-btn" data-add-mes><span class="material-icons">add</span> Agregar mes</button></div>
    </div>

    <div class="bal-card bal-xls">
      <div class="bal-card-title"><span class="material-icons">inventory_2</span> Compras / Gastos por rubro</div>
      <div class="bal-table-wrap">
        <table class="bal-table bal-xls-table">
          <thead><tr>
            <th class="bal-th-lbl">Rubro</th>
            ${meses.map(ym => `<th>${esc(mesLabel(ym))}</th>`).join('')}
            <th class="bal-th-total">Total</th>
          </tr></thead>
          <tbody>${rubros.map(rubroRow).join('')}${sepRow}${agregados.map(rubroRow).join('')}</tbody>
          <tfoot><tr class="bal-row-total">
            <td class="bal-td-lbl">Total mes</td>
            ${meses.map(ym => `<td data-rub-coltot="${ym}">${money(totalRubrosMes(ym))}</td>`).join('')}
            <td class="bal-td-total" data-rub-grand>${money(grandRubros)}</td>
          </tr></tfoot>
        </table>
      </div>
      <div class="bal-toolbar">
        <button type="button" class="bal-add-btn" data-add-rubro><span class="material-icons">add</span> Agregar rubro</button>
        <button type="button" class="bal-add-btn" data-add-agregado><span class="material-icons">add</span> Agregar agregado</button>
      </div>
    </div>`;

  body.querySelectorAll('input[data-saldo-ym]').forEach(inp => {
    bindCellSelect(inp);
    inp.addEventListener('change', () => onSaldoEdit(inp));
  });
  body.querySelectorAll('input[data-rub-ym]').forEach(inp => {
    bindCellSelect(inp);
    inp.addEventListener('change', () => onRubroEdit(inp));
  });

  // Agregar mes / rubro / agregado
  body.querySelector('[data-add-mes]')?.addEventListener('click', addMes);
  body.querySelector('[data-add-rubro]')?.addEventListener('click', () => addRubro(false));
  body.querySelector('[data-add-agregado]')?.addEventListener('click', () => addRubro(true));

  // Renombrar rubro (propaga a todos los meses)
  body.querySelectorAll('input[data-rub-rename]').forEach(inp => {
    bindCellSelect(inp);
    inp.addEventListener('change', () => {
      const oldName = inp.dataset.rubRename;
      const newName = inp.value.trim();
      if (!newName || newName === oldName) { inp.value = oldName; return; }
      const dup = [...(cfg.rubros || []), ...(cfg.agregados || [])]
        .some(r => r !== oldName && r.toUpperCase() === newName.toUpperCase());
      if (dup) { alertDialog({ title: 'Nombre repetido', message: `Ya existe "${esc(newName)}".`, type: 'warning' }); inp.value = oldName; return; }
      renameRubro(oldName, newName, esAgregado(oldName)).then(renderBody);
    });
  });

  // Ver detalle de un rubro/agregado: movimientos diarios que lo componen
  body.querySelectorAll('[data-rub-ver]').forEach(btn => {
    btn.addEventListener('click', () => openRubroDetalle(btn.dataset.rubVer));
  });

  // Eliminar rubro / agregado (borra sus valores en todos los meses)
  body.querySelectorAll('[data-rub-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.rubDel;
      const ok = await confirmDialog({
        title: 'Eliminar fila',
        message: `¿Eliminar <b>${esc(name)}</b>? Se borran sus valores en todos los meses.`,
        confirmText: 'Eliminar', danger: true,
      });
      if (!ok) return;
      await removeRubro(name, esAgregado(name));
      renderBody();
    });
  });
}

function bindCellSelect(inp) {
  inp.addEventListener('focus', () => inp.select());
}

function onSaldoEdit(inp) {
  const ym = inp.dataset.saldoYm, medio = inp.dataset.saldoMedio;
  const val = parseNum(inp.value);
  const mes = ensureMes(ym);
  if (!mes.saldos) mes.saldos = {};
  mes.saldos[medio] = val;
  if (mes.origen === 'excel') mes.origen = 'manual';
  inp.value = val == null ? '' : fmt(val);
  recomputeSaldosTotals();
  const headChip = mountEl.querySelector(`[data-mes-total="${ym}"]`);
  if (headChip) headChip.textContent = money(totalSaldos(ym));
  persistMes(ym, { saldos: { [medio]: val }, origen: mes.origen })
    .then(() => recalcularCadena()).then(refreshCajaBand).catch(() => {});
  refreshCajaBand();
}

function onRubroEdit(inp) {
  const ym = inp.dataset.rubYm, rubro = inp.dataset.rubRubro;
  const val = parseNum(inp.value);
  const mes = ensureMes(ym);
  if (!mes.rubros) mes.rubros = {};
  mes.rubros[rubro] = val;
  if (mes.origen === 'excel') mes.origen = 'manual';
  inp.value = val == null ? '' : fmt(val);
  recomputeRubrosTotals();
  persistMes(ym, { rubros: { [rubro]: val }, origen: mes.origen });
}

function recomputeSaldosTotals() {
  const meses = mesesOrdenados('asc');
  // Se lee lo que muestra cada celda (tipeado o calculado por la cadena), así
  // los totales cierran con lo que el usuario tiene adelante.
  const enCelda = (ym, k) => {
    const inp = mountEl.querySelector(`[data-saldo-ym="${ym}"][data-saldo-medio="${k}"]`);
    return inp ? (parseNum(inp.value) || 0) : (Number(saldoVal(ym, k)) || 0);
  };
  meses.forEach(ym => {
    const cell = mountEl.querySelector(`[data-saldo-rowtot="${ym}"]`);
    if (cell) cell.textContent = money(MEDIOS.reduce((s, m) => s + enCelda(ym, m.k), 0));
  });
  let grand = 0;
  MEDIOS.forEach(m => {
    const tot = meses.reduce((s, ym) => s + enCelda(ym, m.k), 0);
    grand += tot;
    const cell = mountEl.querySelector(`[data-saldo-coltot="${m.k}"]`);
    if (cell) cell.textContent = money(tot);
  });
  const g = mountEl.querySelector('[data-saldo-grand]');
  if (g) g.textContent = money(grand);
}

function recomputeRubrosTotals() {
  const meses = mesesOrdenados('asc');
  const rubros = rubrosLista();
  rubros.forEach((r, idx) => {
    const tot = meses.reduce((s, ym) => s + (Number(rubroVal(ym, r)) || 0), 0);
    const cell = mountEl.querySelector(`[data-rub-rowtot="${idx}"]`);
    if (cell) cell.textContent = money(tot);
  });
  let grand = 0;
  meses.forEach(ym => {
    const tot = totalRubrosMes(ym);
    grand += tot;
    const cell = mountEl.querySelector(`[data-rub-coltot="${ym}"]`);
    if (cell) cell.textContent = money(tot);
  });
  const g = mountEl.querySelector('[data-rub-grand]');
  if (g) g.textContent = money(grand);
}

// ── Sub-vista: MESES (acordeones) ─────────────────────────────────────────────
function renderMeses(body) {
  const meses = mesesOrdenados('desc');
  // Arriba: resumen mes a mes que se arma solo (carga async, ver fillMesAMes).
  const auto = `<div data-mes-auto>
    <div class="ct-loading" style="padding:16px 0"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div>
  </div>`;
  const fichasHead = `<div class="bal-sec-head">
    <span class="material-icons">edit_note</span>
    <div><b>Fichas del mes</b><small>Lo que cargás a mano o vino del Excel. El resumen de arriba no las toca.</small></div>
  </div>`;
  const caption = `<div class="bal-caption"><span class="material-icons">calendar_month</span>
    Una ficha por mes (como cada hoja del Excel): saldos de cierre, compras/gastos por rubro y los montos fijos
    aplicados — con override por mes. El botón <b>Autocompletar</b> trae los saldos desde las ventas reales.</div>`;
  const toolbar = `<div class="bal-toolbar" style="margin-bottom:12px">
    <button type="button" class="bal-add-btn" data-add-mes><span class="material-icons">add</span> Agregar mes</button></div>`;
  body.innerHTML = auto + fichasHead + caption + toolbar + (meses.map(ym => mesAccordionHtml(ym)).join('') || `
    <div class="bal-empty"><span class="material-icons">calendar_month</span>
      <div class="bal-empty-sub">No hay meses cargados.</div></div>`);

  body.querySelector('[data-add-mes]')?.addEventListener('click', addMes);
  meses.forEach(ym => bindMesAccordion(body, ym));

  const host = body.querySelector('[data-mes-auto]');
  if (host) fillMesAMes(host).catch(() => { if (host.isConnected) host.innerHTML = ''; });
}

// ── Mes a mes automático (arriba de las fichas de "Meses") ────────────────────
// Mismo criterio que Semana a Semana pero por mes: ingresos, egresos, saldo y
// caja al cierre salen del detalle del "Día por día". Es solo lectura: no
// escribe nada en cfg.meses, así que las fichas manuales quedan intactas.
async function fillMesAMes(host) {
  const hoy = hoyAR();
  const ymHoy = hoy.slice(0, 7), ddHoy = hoy.slice(8, 10);
  const primero = mesesOrdenados('asc')[0] || ymHoy;
  const meses = ymRange(primero <= ymHoy ? primero : ymHoy, ymHoy);
  const docs = {};
  await Promise.all(meses.map(async ym => { docs[ym] = await loadDiasMes(db, ym); }));
  if (!host.isConnected || view !== 'meses') return;   // cambió de pestaña mientras cargaba

  const r2 = v => Math.round(v * 100) / 100;
  const zero = () => ({ efectivo: 0, mp: 0, lapos: 0, sin: 0, total: 0 });
  const cad = cadenaMeses({ meses, tipeados: saldosTipeados(), docs, hoy: hoyAR() });
  const filas = [];
  meses.forEach(ym => {
    const doc = docs[ym];
    const dias = (doc && doc.dias) || {};
    const f = { ym, cargados: 0, ultDd: null, ing: zero(), egr: zero(), porDia: [], cierre: null, delta: null };
    Object.keys(dias).sort().forEach(dd => {
      const t = diaTotales(dias[dd]);
      if (!t.ing.total && !t.com.total) return;   // día plantilla sin montos
      ['efectivo', 'mp', 'lapos', 'sin', 'total'].forEach(k => { f.ing[k] += t.ing[k]; f.egr[k] += t.com[k]; });
      f.cargados++; f.ultDd = dd;
      f.porDia.push({ dd, ing: t.ing.total });
    });
    if (!f.cargados) return;
    // Caja al cierre: acumulado del mes al último día con datos, desde la
    // apertura que da la cadena (tipeada o el cierre del mes anterior).
    const ap = aperturaDe(cad, ym);
    if (ap) {
      const a = acumuladoHasta(dias, ap, f.ultDd);
      f.cierre = r2(a.efectivo + a.mp + a.lapos + a.sin);
    }
    filas.push(f);
  });

  if (!filas.length) {
    host.innerHTML = `<div class="bal-caption"><span class="material-icons">insights</span>
      El <b>resumen mes a mes</b> se arma solo con lo cargado en "Día por día". Cargá días ahí (o usá
      "Importar días") y los meses aparecen acá sin tocar nada.</div>`;
    return;
  }

  // Variación de ingresos contra el mes anterior con datos. Para el mes en curso
  // se compara contra los MISMOS días del mes anterior: si no, un mes a medio
  // andar siempre parece una caída.
  filas.forEach((f, i) => {
    const prev = filas[i - 1];
    if (!prev) return;
    const enCurso = f.ym === ymHoy;
    const base = enCurso
      ? prev.porDia.reduce((s, d) => s + (d.dd <= ddHoy ? d.ing : 0), 0)
      : prev.ing.total;
    if (!base) return;
    f.delta = { pct: Math.round(((f.ing.total - base) / base) * 1000) / 10, prev: prev.ym, parcial: enCurso };
  });

  // Promedios sobre los últimos 6 meses cerrados (el mes en curso distorsiona).
  const cerrados = filas.filter(f => f.ym !== ymHoy).slice(-6);
  const promIng = cerrados.length ? cerrados.reduce((s, f) => s + f.ing.total, 0) / cerrados.length : 0;
  const promEgr = cerrados.length ? cerrados.reduce((s, f) => s + f.egr.total, 0) / cerrados.length : 0;
  const promSaldo = promIng - promEgr;

  const medioRow = (label, ing, egr) => `
    <div class="bal-sem-det-item">
      <span>${label}</span>
      <b><span class="bal-sem-mas">+${fmt(r2(ing))}</span> <span class="bal-sem-menos">−${fmt(r2(egr))}</span>
      <span class="bal-sem-igual${negCls(ing - egr)}">= ${money(r2(ing - egr))}</span></b>
    </div>`;

  let anioPrev = null;
  const rows = [...filas].reverse().map(f => {
    const saldo = r2(f.ing.total - f.egr.total);
    const enCurso = f.ym === ymHoy;
    const prom = f.cargados ? r2(f.ing.total / f.cargados) : 0;
    const mejor = f.porDia.reduce((a, b) => (!a || b.ing > a.ing ? b : a), null);
    const anio = f.ym.slice(0, 4);
    const divider = anio !== anioPrev ? `<tr class="bal-row-sep"><td colspan="5">${anio}</td></tr>` : '';
    anioPrev = anio;
    const d = f.delta;
    const deltaHtml = d
      ? `<span class="kpi-delta bal-mam-delta ${d.pct >= 0 ? 'kpi-delta-up' : 'kpi-delta-down'}"
           title="Ingresos contra ${esc(mesLabelAny(d.prev))}${d.parcial ? ` (mismos días, hasta el ${ddHoy})` : ''}"
           >${d.pct >= 0 ? '+' : '−'}${fmt(Math.abs(d.pct))}%</span>`
      : '';
    return `${divider}
      <tr class="bal-sem-row" data-mam="${f.ym}">
        <td class="bal-td-lbl">
          <div class="bal-sem-lbl"><b>${esc(mesLabelAny(f.ym))}</b>
            ${enCurso ? '<span class="bal-sem-badge">Mes en curso</span>' : ''}</div>
          <small>${f.cargados} ${f.cargados === 1 ? 'día cargado' : 'días cargados'}</small>
        </td>
        <td>${money(r2(f.ing.total))}${deltaHtml}</td>
        <td>${f.egr.total ? money(r2(f.egr.total)) : '—'}</td>
        <td class="bal-sem-saldo${negCls(saldo)}">${money(saldo)}</td>
        <td class="bal-td-total${negCls(f.cierre)}">${f.cierre != null ? money(f.cierre) : '—'}</td>
      </tr>
      <tr class="bal-sem-det" data-mamdet="${f.ym}" style="display:none">
        <td colspan="5">
          <div class="bal-sem-det-grid">
            ${medioRow('Efectivo', f.ing.efectivo, f.egr.efectivo)}
            ${medioRow('Mercado Pago', f.ing.mp, f.egr.mp)}
            ${medioRow('Lapos', f.ing.lapos, f.egr.lapos)}
            ${(f.ing.sin || f.egr.sin) ? medioRow('Sin medio', f.ing.sin, f.egr.sin) : ''}
            <div class="bal-sem-det-item"><span>Ingreso promedio por día</span><b>${money(prom)}</b></div>
            ${mejor ? `<div class="bal-sem-det-item"><span>Mejor día</span><b>${ddmm(`${f.ym}-${mejor.dd}`)} · ${money(r2(mejor.ing))}</b></div>` : ''}
          </div>
        </td>
      </tr>`;
  }).join('');

  host.innerHTML = `
    <div class="bal-caption"><span class="material-icons">insights</span>
      Resumen <b>mes a mes</b> armado solo desde el detalle del "Día por día" — se actualiza cuando cargás días y
      <b>no toca</b> las fichas de abajo. Click en un mes para ver el desglose por medio de pago.</div>

    <div class="bal-sem-stats">
      <div class="bal-sem-stat"><span>Meses con datos</span><b>${filas.length}</b></div>
      <div class="bal-sem-stat"><span>Ingresos promedio ${cerrados.length ? `(últ. ${cerrados.length} ${cerrados.length === 1 ? 'mes' : 'meses'})` : ''}</span><b>${money(r2(promIng))}</b></div>
      <div class="bal-sem-stat"><span>Egresos promedio</span><b>${money(r2(promEgr))}</b></div>
      <div class="bal-sem-stat"><span>Saldo promedio</span><b class="${negCls(promSaldo).trim()}">${money(r2(promSaldo))}</b></div>
    </div>

    <div class="bal-card bal-xls">
      <div class="bal-card-title"><span class="material-icons">calendar_month</span> Mes a mes</div>
      <div class="bal-table-wrap">
        <table class="bal-table bal-xls-table">
          <thead><tr>
            <th class="bal-th-lbl">Mes</th>
            <th>Ingresos</th>
            <th>Egresos</th>
            <th>Saldo del mes</th>
            <th class="bal-th-total">Caja al cierre</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

  host.querySelectorAll('.bal-sem-row[data-mam]').forEach(tr => {
    tr.addEventListener('click', () => {
      const det = host.querySelector(`.bal-sem-det[data-mamdet="${tr.dataset.mam}"]`);
      if (det) det.style.display = det.style.display === 'none' ? '' : 'none';
    });
  });
}

function mesAccordionHtml(ym) {
  const mes = cfg.meses[ym] || {};
  const origen = mes.origen || 'manual';
  const abierto = openMeses.has(ym);
  return `
    <div class="bal-mes${abierto ? ' open' : ''}" data-mes="${ym}">
      <div class="bal-mes-head" data-mes-head="${ym}">
        <span class="material-icons bal-mes-chevron">chevron_right</span>
        <span class="bal-mes-label">${esc(mesLabel(ym))}</span>
        <span class="bal-mes-origen is-${origen}">${origen}</span>
        <span class="bal-mes-total" data-mes-total="${ym}">${money(totalSaldos(ym))}</span>
        <button type="button" class="bal-mes-del" data-mes-del="${ym}" title="Eliminar mes"><span class="material-icons">delete_outline</span></button>
      </div>
      <div class="bal-mes-body">${abierto ? mesBodyHtml(ym) : ''}</div>
    </div>`;
}

function mesBodyHtml(ym) {
  const rubros = rubrosLista();
  const fijos = fijosActivos();
  const mes = cfg.meses[ym] || {};
  const excluidos = new Set(mes.fijosExcluidos || []);
  return `
    <div class="bal-mes-namerow">
      <span class="bal-field-lbl">Nombre del mes</span>
      <input class="bal-cell-input" data-mlabel-ym="${ym}" value="${esc(mesLabel(ym))}" style="max-width:200px;text-align:left">
    </div>
    <div class="bal-mes-grid">
      <div>
        <div class="bal-sub-title">Saldos de cierre
          <button type="button" class="bal-btn bal-btn-ghost" data-autofill="${ym}" style="padding:5px 10px;font-size:12px">
            <span class="material-icons" style="font-size:15px">auto_awesome</span> Autocompletar de ventas
          </button>
        </div>
        ${MEDIOS.map(m => {
          const v = saldoVal(ym, m.k);
          return `<div class="bal-field">
            <span class="bal-field-lbl">${esc(m.label)}</span>
            <input class="bal-cell-input" type="text" inputmode="decimal"
              data-msaldo-ym="${ym}" data-msaldo-medio="${m.k}" value="${v == null ? '' : fmt(v)}" placeholder="—">
          </div>`;
        }).join('')}
        <div class="bal-subtotal"><span>Total cierre</span><span data-msaldo-tot="${ym}">${money(totalSaldos(ym))}</span></div>
      </div>

      <div>
        <div class="bal-sub-title">Compras / Gastos por rubro</div>
        ${rubros.map(r => {
          const v = rubroVal(ym, r);
          return `<div class="bal-field">
            <span class="bal-field-lbl" style="${esAgregado(r) ? 'color:var(--tint-purple-fg)' : ''}">${esc(r)}</span>
            <span style="display:flex;align-items:center;gap:6px">
              <button type="button" class="bal-rub-ver" data-mrubver="${esc(r)}" title="Ver detalle de los días"><span class="material-icons">visibility</span></button>
              <input class="bal-cell-input" type="text" inputmode="decimal" style="max-width:130px"
                data-mrub-ym="${ym}" data-mrub-rubro="${esc(r)}" value="${v == null ? '' : fmt(v)}" placeholder="—">
            </span>
          </div>`;
        }).join('')}
        <div class="bal-subtotal"><span>Total compras/gastos</span><span data-mrub-tot="${ym}">${money(totalRubrosMes(ym))}</span></div>
      </div>

      <div>
        <div class="bal-sub-title">Montos fijos aplicados</div>
        ${fijos.length ? fijos.map(f => {
          const incluido = !excluidos.has(f.id);
          const monto = fijoMontoEnMes(ym, f);
          return `<div class="bal-field">
            <span class="bal-field-lbl">${esc(f.label)}
              <small>${esc(MEDIOS.find(m => m.k === fuenteValida(f.fuente))?.label || '')}</small></span>
            <span style="display:flex;align-items:center;gap:8px">
              <input class="bal-cell-input" type="text" inputmode="decimal"
                data-mfijo-ym="${ym}" data-mfijo-id="${esc(f.id)}" value="${fmt(monto)}"
                ${incluido ? '' : 'disabled'} title="Override solo para este mes" style="max-width:120px">
              <button type="button" class="bal-fijo-toggle${incluido ? ' on' : ''}"
                data-mfijoexc-ym="${ym}" data-mfijoexc-id="${esc(f.id)}" title="Incluir / excluir este mes"></button>
            </span>
          </div>`;
        }).join('') : `<div style="font-size:12px;color:var(--text-muted)">No hay gastos fijos definidos. Cargalos desde el panel de "Día por día".</div>`}
        <div class="bal-subtotal"><span>Total fijos</span><span data-mfijo-tot="${ym}">${money(totalFijosMes(ym))}</span></div>
      </div>
    </div>
    <div class="bal-mes-detalle" data-mes-detalle="${ym}"></div>`;
}

// Detalle derivado del día por día: compras por proveedor + sueldos por persona (solo lectura).
function mesDetalleHtml(porProveedor, sueldos) {
  const prov = Object.entries(porProveedor).sort((a, b) => b[1] - a[1]);
  const sue = Object.entries(sueldos).sort((a, b) => b[1] - a[1]);
  if (!prov.length && !sue.length) {
    return `<div class="bal-mov-empty" style="margin-top:10px">Sin detalle diario cargado para este mes (cargalo en "Día por día").</div>`;
  }
  const lista = (entries) => {
    const tot = entries.reduce((s, [, v]) => s + v, 0);
    return entries.map(([k, v]) => `<div class="bal-det-row">
        <span>${esc(k)}</span>
        <span style="display:flex;align-items:center;gap:8px">
          <button type="button" class="bal-rub-ver" data-provver="${esc(k)}" title="Ver detalle de los días"><span class="material-icons">visibility</span></button>
          <b>${money(v)}</b>
        </span>
      </div>`).join('')
      + `<div class="bal-det-row bal-det-tot"><span>Total</span><b>${money(tot)}</b></div>`;
  };
  return `
    <div class="bal-mes-grid" style="margin-top:14px">
      <div>
        <div class="bal-sub-title"><span class="material-icons" style="font-size:15px">local_shipping</span> Compras / Gastos por proveedor</div>
        ${prov.length ? lista(prov) : '<div class="bal-mov-empty">—</div>'}
      </div>
      <div>
        <div class="bal-sub-title"><span class="material-icons" style="font-size:15px">badge</span> Sueldos por persona</div>
        ${sue.length ? lista(sue) : '<div class="bal-mov-empty">—</div>'}
      </div>
    </div>`;
}

function bindMesAccordion(body, ym) {
  const delBtn = body.querySelector(`[data-mes-del="${ym}"]`);
  delBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await confirmDialog({
      title: 'Eliminar mes',
      message: `¿Eliminar <b>${esc(mesLabel(ym))}</b> y todos sus datos (saldos, rubros y overrides)?`,
      confirmText: 'Eliminar', danger: true,
    });
    if (!ok) return;
    await removeMes(ym);
    if (!tieneDatos()) render(); else renderBody();
  });
  const head = body.querySelector(`[data-mes-head="${ym}"]`);
  head?.addEventListener('click', () => {
    const card = body.querySelector(`.bal-mes[data-mes="${ym}"]`);
    const bodyEl = card?.querySelector('.bal-mes-body');
    const abierto = openMeses.has(ym);
    if (abierto) {
      openMeses.delete(ym);
      card.classList.remove('open');
      if (bodyEl) bodyEl.innerHTML = '';
    } else {
      openMeses.add(ym);
      card.classList.add('open');
      if (bodyEl) { bodyEl.innerHTML = mesBodyHtml(ym); bindMesBody(card, ym); }
    }
  });
}

function bindMesBody(card, ym) {
  card.querySelector('[data-autofill]')?.addEventListener('click', () => autofillMes(ym));
  card.querySelectorAll('[data-mrubver]').forEach(b => b.addEventListener('click', () => openRubroDetalle(b.dataset.mrubver, ym)));
  // Detalle por proveedor / sueldos: se calcula del día por día (carga lazy).
  const detEl = card.querySelector(`[data-mes-detalle="${ym}"]`);
  if (detEl) {
    detEl.innerHTML = `<div class="ct-loading" style="padding:10px"><div class="spinner" style="width:20px;height:20px;border-width:2px"></div></div>`;
    loadDiasMes(db, ym)
      .then(docM => {
        if (!detEl.isConnected) return;
        const { porProveedor, sueldos } = agregadosDelMes(docM);
        detEl.innerHTML = mesDetalleHtml(porProveedor, sueldos, ym);
        detEl.querySelectorAll('[data-provver]').forEach(b => b.addEventListener('click', () => openProveedorDetalle(b.dataset.provver, ym)));
      })
      .catch(() => { if (detEl.isConnected) detEl.innerHTML = ''; });
  }
  card.querySelector('[data-mlabel-ym]')?.addEventListener('change', (e) => {
    const v = e.target.value.trim() || ym;
    ensureMes(ym).label = v;
    const lbl = card.querySelector('.bal-mes-label');
    if (lbl) lbl.textContent = v;
    persistMes(ym, { label: v });
  });
  card.querySelectorAll('input[data-msaldo-ym]').forEach(inp => {
    bindCellSelect(inp);
    inp.addEventListener('change', () => {
      const medio = inp.dataset.msaldoMedio;
      const val = parseNum(inp.value);
      const mes = ensureMes(ym);
      if (!mes.saldos) mes.saldos = {};
      mes.saldos[medio] = val;
      if (mes.origen === 'excel') mes.origen = 'manual';
      inp.value = val == null ? '' : fmt(val);
      patchMesTotales(card, ym);
      refreshCajaBand();
      persistMes(ym, { saldos: { [medio]: val }, origen: mes.origen });
    });
  });
  card.querySelectorAll('input[data-mrub-ym]').forEach(inp => {
    bindCellSelect(inp);
    inp.addEventListener('change', () => {
      const rubro = inp.dataset.mrubRubro;
      const val = parseNum(inp.value);
      const mes = ensureMes(ym);
      if (!mes.rubros) mes.rubros = {};
      mes.rubros[rubro] = val;
      if (mes.origen === 'excel') mes.origen = 'manual';
      inp.value = val == null ? '' : fmt(val);
      patchMesTotales(card, ym);
      persistMes(ym, { rubros: { [rubro]: val }, origen: mes.origen });
    });
  });
  card.querySelectorAll('input[data-mfijo-ym]').forEach(inp => {
    bindCellSelect(inp);
    inp.addEventListener('change', () => {
      const id = inp.dataset.mfijoId;
      const val = parseNum(inp.value) || 0;
      const mes = ensureMes(ym);
      if (!mes.fijosOverride) mes.fijosOverride = {};
      mes.fijosOverride[id] = val;
      inp.value = fmt(val);
      patchMesTotales(card, ym);
      persistMes(ym, { fijosOverride: { [id]: val } });
    });
  });
  card.querySelectorAll('.bal-fijo-toggle[data-mfijoexc-ym]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.mfijoexcId;
      const mes = ensureMes(ym);
      const set = new Set(mes.fijosExcluidos || []);
      let incluir;
      if (set.has(id)) { set.delete(id); incluir = true; } else { set.add(id); incluir = false; }
      mes.fijosExcluidos = [...set];
      btn.classList.toggle('on', incluir);
      const inp = card.querySelector(`input[data-mfijo-id="${CSS.escape(id)}"]`);
      if (inp) {
        inp.disabled = !incluir;
        const f = (cfg.montosFijos || []).find(x => x.id === id);
        if (f) inp.value = fmt(fijoMontoEnMes(ym, f)); // re-incluir→override/base · excluir→0
      }
      patchMesTotales(card, ym);
      persistMes(ym, { fijosExcluidos: mes.fijosExcluidos });
    });
  });
}

function patchMesTotales(card, ym) {
  const ts = card.querySelector(`[data-msaldo-tot="${ym}"]`);
  if (ts) ts.textContent = money(totalSaldos(ym));
  const tr = card.querySelector(`[data-mrub-tot="${ym}"]`);
  if (tr) tr.textContent = money(totalRubrosMes(ym));
  const tf = card.querySelector(`[data-mfijo-tot="${ym}"]`);
  if (tf) tf.textContent = money(totalFijosMes(ym));
  const head = mountEl.querySelector(`[data-mes-total="${ym}"]`);
  if (head) head.textContent = money(totalSaldos(ym));
}

// ── Sub-vista: RESUMEN (del período) ──────────────────────────────────────────
// El tablero de la página, calculado 100% desde lo anotado en el balance (los
// días del "Día por día"): ingresos − egresos = saldo del período, desglose por
// medio de pago, estado de los gastos fijos del mes, gráficos y lista de días.
// Reemplaza al viejo motor de ganancia POS (ventas × costo de catálogo).
let ganPeriodo = localStorage.getItem('bal:gan_periodo') || 'mes';
let ganRango = null;
try { ganRango = JSON.parse(localStorage.getItem('bal:gan_rango') || 'null'); } catch (_) {}

const MEDIO_COLORS = { efectivo: '#2e7d32', mp: '#1877f2', lapos: '#6a1b9a', sin: '#90a4ae' };
const PROV_COLORS = ['#1877f2', '#2e7d32', '#e65100', '#6a1b9a', '#c62828', '#00695c', '#cfd8dc'];

// Chart.js compartido con el Dashboard vía window.Chart (mismo vendor local).
let _chartJsLoad = null;
function loadChartJs() {
  if (window.Chart) return Promise.resolve(window.Chart);
  if (_chartJsLoad) return _chartJsLoad;
  _chartJsLoad = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${import.meta.env.BASE_URL}vendor/chart.umd.min.js`;
    s.async = true;
    s.onload = () => resolve(window.Chart);
    s.onerror = () => reject(new Error('No se pudo cargar Chart.js'));
    document.head.appendChild(s);
  });
  return _chartJsLoad;
}
const _ganCharts = new Map();
function destroyGanCharts() {
  _ganCharts.forEach(ch => { try { ch.destroy(); } catch (_) {} });
  _ganCharts.clear();
}
function ganMakeChart(id, el, config) {
  if (!el || !window.Chart) return;
  window.Chart.defaults.color = cssVar('--chart-text', '#65676b');
  window.Chart.defaults.borderColor = cssVar('--chart-grid', 'rgba(0,0,0,0.06)');
  _ganCharts.set(id, new window.Chart(el.getContext('2d'), config));
}
function fmtCompacto(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

// Rango [desde, hasta] (ISO inclusive) del período elegido.
function ganRangoActual() {
  const hoy = hoyAR();
  if (ganPeriodo === 'hoy') return { d: hoy, h: hoy };
  if (ganPeriodo === 'semana') return { d: shiftFecha(hoy, -6), h: hoy };
  if (ganPeriodo === 'mesant') {
    const [y, m] = hoy.slice(0, 7).split('-').map(Number);
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    const ym = `${py}-${String(pm).padStart(2, '0')}`;
    return { d: `${ym}-01`, h: `${ym}-${String(new Date(py, pm, 0).getDate()).padStart(2, '0')}` };
  }
  if (ganPeriodo === 'custom' && ganRango?.desde) {
    const hta = ganRango.hasta || ganRango.desde;
    return ganRango.desde <= hta ? { d: ganRango.desde, h: hta } : { d: hta, h: ganRango.desde };
  }
  return { d: hoy.slice(0, 8) + '01', h: hoy };   // este mes
}

// Serie de meses ISO entre dos 'YYYY-MM' inclusive. Se usa en vez de filtrar
// cfg.meses porque los docs de días pueden existir para meses que todavía no se
// agregaron al RESUMEN (ej: el mes en curso).
function ymRange(ymD, ymH) {
  const out = [];
  let [y, m] = ymD.split('-').map(Number);
  const [yH, mH] = ymH.split('-').map(Number);
  while (y < yH || (y === yH && m <= mH)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
// Etiqueta de mes aunque no esté cargado en cfg.meses ("2026-07" → "Julio 26").
function mesLabelAny(ym) { return (cfg.meses?.[ym]?.label) || labelFromYm(ym); }

// Agrega los días del balance dentro del rango: totales por medio, por día,
// por rubro y por proveedor + la lista cruda de movimientos (para el detalle).
async function ganAgg(d, h) {
  const meses = ymRange(d.slice(0, 7), h.slice(0, 7));
  const zero = () => ({ efectivo: 0, mp: 0, lapos: 0, sin: 0, total: 0 });
  const agg = { ing: zero(), egr: zero(), porDia: {}, porRubro: {}, porProv: {}, movsIng: [], movsEgr: [] };
  const acc = (o, medio, v) => { const k = medio && o[medio] != null ? medio : 'sin'; o[k] += v; o.total += v; };
  const dia0 = (iso) => (agg.porDia[iso] = agg.porDia[iso] || { ing: 0, egr: 0 });
  for (const ym of meses) {
    const docM = await loadDiasMes(db, ym);
    const dias = (docM && docM.dias) || {};
    for (const dd of Object.keys(dias).sort()) {
      const iso = `${ym}-${dd}`;
      if (iso < d || iso > h) continue;
      (dias[dd].ingresos || []).forEach(x => {
        const v = Number(x.monto) || 0;
        if (!v) return;
        acc(agg.ing, x.medio, v);
        dia0(iso).ing += v;
        agg.movsIng.push({ iso, ym, dd, motivo: x.motivo || '', medio: x.medio || '', monto: v });
      });
      (dias[dd].compras || []).forEach(x => {
        const v = Number(x.monto) || 0;
        if (!v) return;
        acc(agg.egr, x.medio, v);
        dia0(iso).egr += v;
        const rubro = (x.rubro || '').trim() || 'Sin rubro';
        const prov  = (x.proveedor || x.motivo || '').trim() || '(sin nombre)';
        agg.porRubro[rubro] = (agg.porRubro[rubro] || 0) + v;
        agg.porProv[prov]   = (agg.porProv[prov]   || 0) + v;
        agg.movsEgr.push({ iso, ym, dd, prov, rubro, medio: x.medio || '', monto: v });
      });
    }
  }
  return agg;
}

// "Mié 15/07" — etiqueta corta de un día para la tabla del período.
function diaCorto(iso) {
  const d = new Date(iso + 'T12:00:00-03:00');
  const w = d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short' });
  return `${w.charAt(0).toUpperCase() + w.slice(1)} ${ddmm(iso)}`;
}

function gotoDia(ym, dd) {
  curDiaYm = ym; curDiaDD = dd;
  view = 'dia';
  localStorage.setItem('bal:view', view);
  mountEl.querySelectorAll('.bal-seg-btn').forEach(x => x.classList.toggle('active', x.dataset.seg === 'dia'));
  renderBody();
}

async function renderGanancia(body) {
  destroyGanCharts();
  const chartLib = loadChartJs().catch(() => null);
  const { d, h } = ganRangoActual();
  const periodos = [
    { k: 'hoy',    t: 'Hoy' },
    { k: 'semana', t: '7 días' },
    { k: 'mes',    t: 'Este mes' },
    { k: 'mesant', t: 'Mes anterior' },
    { k: 'custom', t: '<span class="material-icons" style="font-size:15px;vertical-align:-3px;margin-right:3px">date_range</span>Personalizado' },
  ];
  body.innerHTML = `
    <div class="ct-toolbar">
      <div class="ct-periodo">
        ${periodos.map(p => `<button type="button" class="ct-periodo-btn${p.k === ganPeriodo ? ' active' : ''}" data-p="${p.k}">${p.t}</button>`).join('')}
      </div>
      <button type="button" id="gan-config-btn" class="ct-config-btn" title="Nombres de cuentas y fecha de inicio (usados por el resto de la webapp)">
        <span class="material-icons" style="font-size:18px">settings</span> Configurar cuentas
      </button>
    </div>
    <div id="gan-custom" class="ct-custom-panel" style="display:${ganPeriodo === 'custom' ? '' : 'none'}">
      <div class="ct-custom-grp">
        <div class="ct-custom-title">Rango por días</div>
        <div class="ct-custom-row">
          <label>Desde<input type="date" id="gan-desde" value="${ganRango?.desde || ''}"></label>
          <label>Hasta<input type="date" id="gan-hasta" value="${ganRango?.hasta || ''}"></label>
          <button type="button" id="gan-aplicar" class="ct-custom-apply">Aplicar</button>
        </div>
      </div>
    </div>
    <div id="gan-stats">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px">
        ${Array(3).fill('<div class="skel" style="height:96px;border-radius:14px"></div>').join('')}
      </div>
    </div>`;

  // Toolbar de período. En "Personalizado" el panel de rango queda visible
  // (ganRangoActual cae a "este mes" hasta que se aplique un rango).
  body.querySelectorAll('.ct-periodo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      ganPeriodo = btn.dataset.p;
      localStorage.setItem('bal:gan_periodo', ganPeriodo);
      renderBody();
    });
  });
  body.querySelector('#gan-aplicar')?.addEventListener('click', () => {
    const desde = body.querySelector('#gan-desde')?.value;
    if (!desde) return;
    ganRango = { desde, hasta: body.querySelector('#gan-hasta')?.value || desde };
    localStorage.setItem('bal:gan_rango', JSON.stringify(ganRango));
    ganPeriodo = 'custom';
    localStorage.setItem('bal:gan_periodo', 'custom');
    renderBody();
  });
  body.querySelector('#gan-config-btn')?.addEventListener('click', openConfigCuentas);

  const agg = await ganAgg(d, h);
  const ymRef = h.slice(0, 7);
  const fijosRef = fijosActivos().filter(f => fijoAplica(f, ymRef));
  const totalFijosRef = totalFijosMes(ymRef);
  let fijosPagados = 0;
  if (fijosRef.length) {
    const docRef = await loadDiasMes(db, ymRef);
    fijosRef.forEach(f => { fijosPagados += pagosDeFijo(f, (docRef && docRef.dias) || {}).reduce((s, p) => s + p.monto, 0); });
  }
  if (view !== 'ganancia') return;
  const stats = body.querySelector('#gan-stats');
  if (!stats) return;

  const r2 = v => Math.round(v * 100) / 100;
  const saldo = r2(agg.ing.total - agg.egr.total);
  const diasCon = Object.keys(agg.porDia).sort();
  const colorSaldo = saldo >= 0 ? '#1b5e20' : '#b71c1c';
  const bgSaldo    = saldo >= 0 ? 'var(--tint-green-bg)' : 'var(--tint-red-bg)';
  const fijosPend  = Math.max(0, r2(totalFijosRef - fijosPagados));

  const medioCard = (k, label, icon, color) => {
    const ing = r2(agg.ing[k]), egr = r2(agg.egr[k]), neto = r2(ing - egr);
    return `
      <div class="ct-cuenta-item">
        <span class="material-icons" style="color:${color};font-size:18px">${icon}</span>
        <div class="ct-cuenta-body">
          <div class="ct-cuenta-nombre">${label}</div>
          <div class="ct-cuenta-vals">
            <span class="ct-cuenta-ingreso">+$${fmt(ing)}</span>
            ${egr > 0 ? `<span class="ct-cuenta-gasto">−$${fmt(egr)}</span>` : ''}
            <span class="ct-cuenta-neto" style="color:${neto >= 0 ? 'var(--tint-green-fg)' : 'var(--tint-red-fg)'}">= $${fmt(neto)}</span>
          </div>
        </div>
      </div>`;
  };

  stats.innerHTML = `
    <div class="ct-ecuacion">
      <div class="ct-eq-bloque ct-clickable" data-gan-det="ing" title="Ver los ingresos anotados del período">
        <span class="material-icons ct-eq-icon" style="color:var(--tint-green-fg)">payments</span>
        <div class="ct-eq-num">$${fmt(r2(agg.ing.total))}</div>
        <div class="ct-eq-lbl">Ingresos</div>
        <div class="ct-eq-sub">${agg.movsIng.length} movimiento${agg.movsIng.length === 1 ? '' : 's'}</div>
      </div>
      <div class="ct-eq-op">−</div>
      <div class="ct-eq-bloque ct-clickable" data-gan-det="egr" title="Ver las compras / gastos anotados del período">
        <span class="material-icons ct-eq-icon" style="color:var(--tint-red-fg)">shopping_cart</span>
        <div class="ct-eq-num">$${fmt(r2(agg.egr.total))}</div>
        <div class="ct-eq-lbl">Egresos / Compras</div>
        <div class="ct-eq-sub">${agg.movsEgr.length} movimiento${agg.movsEgr.length === 1 ? '' : 's'}</div>
      </div>
      <div class="ct-eq-op">=</div>
      <div class="ct-eq-bloque ct-eq-neta" style="background:${bgSaldo};border-color:${colorSaldo}">
        <span class="material-icons ct-eq-icon" style="color:${colorSaldo}">${saldo >= 0 ? 'trending_up' : 'trending_down'}</span>
        <div class="ct-eq-num" style="color:${colorSaldo};font-size:26px;font-weight:900">$${fmt(saldo)}</div>
        <div class="ct-eq-lbl" style="color:${colorSaldo};font-weight:700">Saldo del período</div>
        <div class="ct-eq-sub">&nbsp;</div>
      </div>
    </div>

    <div class="ct-totales-reales">
      <span class="material-icons" style="font-size:16px;color:var(--text-muted)">info</span>
      <span>Período: <b>${d === h ? esc(fechaLarga(d)) : `${ddmm(d)} → ${ddmm(h)}`}</b> · ${diasCon.length} día${diasCon.length === 1 ? '' : 's'} con movimientos anotados en el balance</span>
    </div>

    ${totalFijosRef > 0 ? `
      <div class="ct-fijos-band">
        <span class="material-icons">event_repeat</span>
        <span class="ct-fijos-band-txt">Gastos fijos de <b>${esc(mesLabelAny(ymRef))}</b>: pagados <b>$${fmt(r2(fijosPagados))}</b> de <b>$${fmt(r2(totalFijosRef))}</b></span>
        <span class="ct-fijos-result" style="color:${fijosPend > 0 ? 'var(--tint-orange-fg)' : 'var(--tint-green-fg)'}">
          ${fijosPend > 0 ? `Pendiente: $${fmt(fijosPend)}` : 'Todos pagados'}</span>
        <span class="ct-fijos-link" data-gan-fijos><span class="material-icons" style="font-size:15px;color:inherit">arrow_forward</span> Ver Día por día</span>
      </div>` : ''}

    <div class="ct-cuentas-header">
      <span class="ct-cuentas-titulo">Desglose por medio de pago</span>
    </div>
    <div class="ct-cuentas-row">
      ${medioCard('efectivo', 'Efectivo', 'payments', 'var(--tint-green-fg)')}
      ${medioCard('mp', 'Mercado Pago', 'account_balance', 'var(--tint-blue-fg)')}
      ${medioCard('lapos', 'Lapos', 'account_balance', 'var(--tint-purple-fg)')}
      ${(agg.ing.sin || agg.egr.sin) ? medioCard('sin', 'Sin medio', 'help_outline', 'var(--text-muted)') : ''}
    </div>

    <div class="ct-charts-row" id="gan-charts"></div>

    ${diasCon.length ? `
      <div class="bal-card bal-xls" style="margin-top:16px">
        <div class="bal-card-title"><span class="material-icons">today</span> Días del período
          <small style="font-weight:500;color:var(--text-muted);margin-left:8px;text-transform:none;letter-spacing:0">Click en un día para ver su detalle</small>
        </div>
        <div class="bal-table-wrap">
          <table class="bal-table bal-xls-table">
            <thead><tr>
              <th class="bal-th-lbl">Día</th><th>Ingresos</th><th>Egresos</th><th class="bal-th-total">Saldo</th>
            </tr></thead>
            <tbody>
              ${[...diasCon].reverse().map(iso => {
                const x = agg.porDia[iso];
                const s = r2(x.ing - x.egr);
                return `<tr class="bal-gdia-row" data-ym="${iso.slice(0, 7)}" data-dd="${iso.slice(8, 10)}">
                  <td class="bal-td-lbl">${diaCorto(iso)}</td>
                  <td>${money(r2(x.ing))}</td>
                  <td>${x.egr ? money(r2(x.egr)) : '—'}</td>
                  <td class="bal-td-total${negCls(s)}">${money(s)}</td>
                </tr>`;
              }).join('')}
            </tbody>
            <tfoot><tr class="bal-row-total">
              <td class="bal-td-lbl">Total</td>
              <td>${money(r2(agg.ing.total))}</td>
              <td>${money(r2(agg.egr.total))}</td>
              <td class="bal-td-total${negCls(saldo)}">${money(saldo)}</td>
            </tr></tfoot>
          </table>
        </div>
      </div>` : `
      <div class="bal-empty" style="margin-top:16px">
        <span class="material-icons">event_busy</span>
        <div class="bal-empty-title">Sin movimientos anotados en este período</div>
        <div class="bal-empty-sub">Los números de este resumen salen de lo cargado en "Día por día".
        Cargá los días del período (o elegí otro rango) y se completa solo.</div>
      </div>`}
  `;

  stats.querySelectorAll('[data-gan-det]').forEach(el =>
    el.addEventListener('click', () => openGanMovs(el.dataset.ganDet, agg)));
  stats.querySelector('[data-gan-fijos]')?.addEventListener('click', () => {
    curDiaYm = curDiaDD = null;
    view = 'dia';
    localStorage.setItem('bal:view', view);
    mountEl.querySelectorAll('.bal-seg-btn').forEach(x => x.classList.toggle('active', x.dataset.seg === 'dia'));
    renderBody();
  });
  stats.querySelectorAll('.bal-gdia-row').forEach(tr =>
    tr.addEventListener('click', () => gotoDia(tr.dataset.ym, tr.dataset.dd)));

  // ── Gráficos (Chart.js, todo desde el balance) ──
  chartLib.then(Chart => {
    if (!Chart || view !== 'ganancia') return;
    const row = stats.querySelector('#gan-charts');
    if (!row) return;
    const fmtMoney = v => '$' + Number(v || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 });
    const legendCfg = { position: 'bottom', labels: { boxWidth: 10, padding: 8, font: { size: 11 }, color: cssVar('--chart-text', '#65676b') } };

    const mediosIng = MEDIOS.map(m => ({ ...m, v: r2(agg.ing[m.k]) }))
      .concat(agg.ing.sin ? [{ k: 'sin', label: 'Sin medio', v: r2(agg.ing.sin) }] : [])
      .filter(m => m.v > 0);
    const rubros = Object.entries(agg.porRubro).map(([nombre, v]) => ({ nombre, v: r2(v) }))
      .sort((a, b) => b.v - a.v).slice(0, 8);
    const provsAll = Object.entries(agg.porProv).map(([nombre, v]) => ({ nombre, v: r2(v) }))
      .sort((a, b) => b.v - a.v);
    const provs = provsAll.slice(0, 6);
    const provResto = r2(provsAll.slice(6).reduce((s, p) => s + p.v, 0));
    if (provResto > 0) provs.push({ nombre: 'Otros', v: provResto });
    const mostrarBars = diasCon.length >= 2;

    row.innerHTML = `
      ${mediosIng.length ? `
        <div class="ct-chart-card">
          <div class="ct-chart-title"><span class="material-icons">pie_chart</span>Ingresos por medio de pago</div>
          <div class="ct-chart-body"><canvas id="gan-ch-medios"></canvas></div>
        </div>` : ''}
      ${mostrarBars ? `
        <div class="ct-chart-card ct-chart-card-wide">
          <div class="ct-chart-title"><span class="material-icons">bar_chart</span>Ingresos vs egresos por día</div>
          <div class="ct-chart-body"><canvas id="gan-ch-dias"></canvas></div>
        </div>` : ''}
      ${rubros.length ? `
        <div class="ct-chart-card ct-chart-card-wide">
          <div class="ct-chart-title"><span class="material-icons">inventory_2</span>Compras / gastos por rubro</div>
          <div class="ct-chart-body" style="height:${Math.max(200, rubros.length * 28 + 50)}px"><canvas id="gan-ch-rubros"></canvas></div>
        </div>` : ''}
      ${provs.length ? `
        <div class="ct-chart-card">
          <div class="ct-chart-title"><span class="material-icons">local_shipping</span>Egresos por proveedor</div>
          <div class="ct-chart-body"><canvas id="gan-ch-provs"></canvas></div>
        </div>` : ''}
    `;

    if (mediosIng.length) {
      ganMakeChart('medios', row.querySelector('#gan-ch-medios'), {
        type: 'doughnut',
        data: {
          labels: mediosIng.map(m => m.label),
          datasets: [{ data: mediosIng.map(m => m.v), backgroundColor: mediosIng.map(m => MEDIO_COLORS[m.k]), borderWidth: 0 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '62%',
          plugins: { legend: legendCfg, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmtMoney(ctx.parsed)}` } } },
        },
      });
    }
    if (mostrarBars) {
      ganMakeChart('dias', row.querySelector('#gan-ch-dias'), {
        type: 'bar',
        data: {
          labels: diasCon.map(ddmm),
          datasets: [
            { label: 'Ingresos', data: diasCon.map(iso => r2(agg.porDia[iso].ing)), backgroundColor: 'rgba(46,125,50,0.85)', borderRadius: 4 },
            { label: 'Egresos',  data: diasCon.map(iso => r2(agg.porDia[iso].egr)), backgroundColor: 'rgba(198,40,40,0.85)', borderRadius: 4 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: legendCfg, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtMoney(ctx.parsed.y)}` } } },
          scales: {
            x: { grid: { display: false }, ticks: { font: { size: 10 }, color: cssVar('--chart-text', '#65676b') } },
            y: { ticks: { callback: v => fmtCompacto(v), font: { size: 10 }, color: cssVar('--chart-text', '#65676b') }, grid: { color: cssVar('--chart-grid', 'rgba(0,0,0,0.06)') } },
          },
        },
      });
    }
    if (rubros.length) {
      ganMakeChart('rubros', row.querySelector('#gan-ch-rubros'), {
        type: 'bar',
        data: {
          labels: rubros.map(x => x.nombre),
          datasets: [{ label: 'Egresos', data: rubros.map(x => x.v), backgroundColor: 'rgba(245,124,0,0.85)', borderRadius: 4 }],
        },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => fmtMoney(ctx.parsed.x) } } },
          scales: {
            x: { ticks: { callback: v => fmtCompacto(v), font: { size: 10 }, color: cssVar('--chart-text', '#65676b') }, grid: { color: cssVar('--chart-grid', 'rgba(0,0,0,0.06)') } },
            y: { grid: { display: false }, ticks: { font: { size: 11 }, color: cssVar('--chart-text', '#65676b') } },
          },
        },
      });
    }
    if (provs.length) {
      ganMakeChart('provs', row.querySelector('#gan-ch-provs'), {
        type: 'doughnut',
        data: {
          labels: provs.map(p => p.nombre),
          datasets: [{ data: provs.map(p => p.v), backgroundColor: provs.map((p, i) => PROV_COLORS[i % PROV_COLORS.length]), borderWidth: 0 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '62%',
          plugins: { legend: legendCfg, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmtMoney(ctx.parsed)}` } } },
        },
      });
    }
  });
}

// Modal de detalle del Resumen: los movimientos (ingresos o egresos) del período
// agrupados por día. Cada fila salta a su día en "Día por día".
function openGanMovs(tipo, agg) {
  const esIng = tipo === 'ing';
  const movs = esIng ? agg.movsIng : agg.movsEgr;
  const total = movs.reduce((s, m) => s + m.monto, 0);
  const medioLbl = k => MEDIOS.find(m => m.k === k)?.label || 'Sin medio';

  document.querySelector('.app-dialog-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay app-dialog-overlay';

  const porDia = {};
  movs.forEach(m => { (porDia[m.iso] = porDia[m.iso] || []).push(m); });
  const dias = Object.keys(porDia).sort().reverse();
  const soloUno = dias.length === 1;

  overlay.innerHTML = `
    <div class="modal" style="max-width:640px">
      <div class="modal-header" style="border-bottom:none;padding-bottom:6px">
        <h3 style="display:flex;align-items:center;gap:10px;margin:0;font-size:16px">
          <span class="material-icons" style="color:${esIng ? 'var(--tint-green-fg)' : 'var(--tint-red-fg)'};font-size:26px">${esIng ? 'payments' : 'shopping_cart'}</span>
          ${esIng ? 'Ingresos' : 'Egresos / Compras'} del período
        </h3>
      </div>
      <div class="modal-body" style="padding:4px 24px 12px">
        <div style="max-height:55vh;overflow:auto">
          ${movs.length ? `<div class="bal-buscar-tot">${movs.length} movimiento(s) en ${dias.length} día(s) · tocá para desplegar</div>` +
            dias.map(iso => {
              const arr = porDia[iso];
              const sub = arr.reduce((s, m) => s + m.monto, 0);
              return `
                <div class="bal-grp${soloUno ? ' open' : ''}">
                  <button type="button" class="bal-grp-head" data-grp-toggle>
                    <span class="material-icons bal-grp-chev">chevron_right</span>
                    <span class="bal-grp-name">${esc(fechaLarga(iso))}</span>
                    <span class="bal-grp-count">${arr.length}</span>
                    <b class="bal-grp-tot">${money(sub)}</b>
                  </button>
                  <div class="bal-grp-body">
                    ${arr.map(m => `
                      <button type="button" class="bal-grp-row" data-ym="${m.ym}" data-dd="${m.dd}">
                        <span class="bal-buscar-fecha">${esc(medioLbl(m.medio))}</span>
                        <span class="bal-buscar-desc">${esc(esIng ? (m.motivo || '(sin motivo)') : m.prov)}${!esIng && m.rubro !== 'Sin rubro' ? ` <small style="color:var(--text-muted)">· ${esc(m.rubro)}</small>` : ''}</span>
                        <span class="bal-buscar-monto ${esIng ? 'is-ing' : 'is-com'}">${esIng ? '+' : '−'}${money(m.monto)}</span>
                      </button>`).join('')}
                  </div>
                </div>`;
            }).join('') : '<div class="bal-mov-empty">Sin movimientos en el período.</div>'}
        </div>
      </div>
      <div class="app-dialog-footer" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:14px 20px;border-top:1px solid var(--border);background:var(--surface-2)">
        <span class="bal-pv-total">Total: <b>${money(total)}</b></span>
        <button class="ad-cancel" style="padding:10px 18px;border-radius:8px;border:1px solid var(--border);background:var(--surface);cursor:pointer;font-size:13px;font-weight:600;color:var(--text-muted)">Cerrar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const cleanup = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); cleanup(); } };
  document.addEventListener('keydown', onKey);
  overlay.querySelector('.ad-cancel').addEventListener('click', cleanup);
  overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });
  overlay.querySelector('.modal-body').addEventListener('click', e => {
    const head = e.target.closest('[data-grp-toggle]');
    if (head) { head.parentElement.classList.toggle('open'); return; }
    const rowb = e.target.closest('.bal-grp-row');
    if (rowb) { cleanup(); gotoDia(rowb.dataset.ym, rowb.dataset.dd); }
  });
}

// Nombres de cuentas + fecha de inicio (control_config/settings): los usan otras
// páginas de la webapp (Dashboard, Historial); acá solo se editan.
async function openConfigCuentas() {
  let cfgCtrl = {};
  try {
    const snap = await getDoc(doc(db, 'control_config', 'settings'));
    if (snap.exists()) cfgCtrl = snap.data();
  } catch (_) {}
  document.querySelector('.app-dialog-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay app-dialog-overlay';
  const field = (id, lbl, val, type, ph) => `
    <div>
      <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">${lbl}</label>
      <input id="${id}" type="${type}" value="${esc(val)}" placeholder="${ph || ''}"
        style="padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;width:100%">
    </div>`;
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-header" style="border-bottom:none;padding-bottom:6px">
        <h3 style="display:flex;align-items:center;gap:10px;margin:0;font-size:16px">
          <span class="material-icons" style="color:var(--bal-green);font-size:24px">settings</span> Configurar cuentas
        </h3>
      </div>
      <div class="modal-body" style="padding:4px 24px 16px;display:flex;flex-direction:column;gap:12px">
        ${field('gcfg-c1', 'Nombre Cuenta 1 (transferencia)', cfgCtrl.cuenta1_nombre || 'Cuenta 1', 'text', 'Ej: Mercado Pago')}
        ${field('gcfg-c2', 'Nombre Cuenta 2 (transferencia)', cfgCtrl.cuenta2_nombre || 'Cuenta 2', 'text', 'Ej: Banco Galicia')}
        ${field('gcfg-fi', 'Fecha de inicio real (oculta todo lo anterior en la webapp)', cfgCtrl.fecha_inicio || '2026-04-18', 'date')}
      </div>
      <div class="app-dialog-footer" style="display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid var(--border);background:var(--surface-2)">
        <button class="ad-cancel" style="padding:10px 18px;border-radius:8px;border:1px solid var(--border);background:var(--surface);cursor:pointer;font-size:13px;font-weight:600;color:var(--text-muted)">Cancelar</button>
        <button class="bal-btn" id="gcfg-save"><span class="material-icons">save</span> Guardar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const cleanup = () => overlay.remove();
  overlay.querySelector('.ad-cancel').addEventListener('click', cleanup);
  overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });
  overlay.querySelector('#gcfg-save').addEventListener('click', async () => {
    const btn = overlay.querySelector('#gcfg-save');
    btn.disabled = true;
    try {
      await saveControlConfig(db, {
        ...cfgCtrl,
        cuenta1_nombre: overlay.querySelector('#gcfg-c1').value.trim() || 'Cuenta 1',
        cuenta2_nombre: overlay.querySelector('#gcfg-c2').value.trim() || 'Cuenta 2',
        fecha_inicio:   overlay.querySelector('#gcfg-fi').value || '2026-04-18',
      });
      location.reload();
    } catch (err) {
      btn.disabled = false;
      alertDialog({ title: 'Error', message: 'No se pudo guardar la configuración.', type: 'error' });
    }
  });
}

// ── Sub-vista: SEMANA A SEMANA (agregado semanal del Día por día) ─────────────
// Agrupa el detalle diario en semanas lunes→domingo: ingresos, egresos y saldo
// de cada semana + la caja acumulada al cierre (el SALDO DIARIO ACUMULADO del
// Excel al último día cargado de la semana). Click en una fila = desglose por
// medio de pago.
function mondayOf(iso) {
  // 12:00-03:00 → mismo día calendario en UTC, getUTCDay() da el día AR.
  const d = new Date(iso + 'T12:00:00-03:00');
  return shiftFecha(iso, -((d.getUTCDay() + 6) % 7));
}
function ddmm(iso) { return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`; }

// ── Sub-vista: CUENTAS (la plata por cuenta) ───────────────────────────────────
// Cuánto entró, cuánto salió y cuánto hay en cada cuenta: Efectivo, cada
// Mercado Pago por separado (MP JOSE, MP AGUSTIN: el nombre con que se carga el
// ingreso) y Lapos. El saldo de hoy por medio sale de la cadena; el reparto de
// Mercado Pago entre cuentas, de los movimientos del período (en las compras,
// del medio "MP JOSE" / "MP AGUSTIN" elegido en cada fila).
let ctaPeriodo = localStorage.getItem('bal:cta_periodo') || 'mes';
let ctaRango = (() => { try { return JSON.parse(localStorage.getItem('bal:cta_rango') || 'null'); } catch (_) { return null; } })();

function ctaRangoActual() {
  const hoy = hoyAR();
  const [y, m] = hoy.slice(0, 7).split('-').map(Number);
  const ym2 = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}`;
  const finMes = (yy, mm) => `${ym2(yy, mm)}-${String(new Date(yy, mm, 0).getDate()).padStart(2, '0')}`;
  if (ctaPeriodo === 'mesant') {
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    return { d: `${ym2(py, pm)}-01`, h: finMes(py, pm) };
  }
  if (ctaPeriodo === 'tres') {
    const idx = (y * 12 + (m - 1)) - 2;
    return { d: `${ym2(Math.floor(idx / 12), (idx % 12) + 1)}-01`, h: hoy };
  }
  if (ctaPeriodo === 'anio') return { d: `${y}-01-01`, h: hoy };
  if (ctaPeriodo === 'custom' && ctaRango?.desde) {
    const hta = ctaRango.hasta || ctaRango.desde;
    return ctaRango.desde <= hta ? { d: ctaRango.desde, h: hta } : { d: hta, h: ctaRango.desde };
  }
  return { d: `${ym2(y, m)}-01`, h: hoy };
}

async function renderCuentas(body) {
  const { d, h } = ctaRangoActual();
  const periodos = [
    { k: 'mes',    t: 'Este mes' },
    { k: 'mesant', t: 'Mes anterior' },
    { k: 'tres',   t: '3 meses' },
    { k: 'anio',   t: 'Este año' },
    { k: 'custom', t: '<span class="material-icons" style="font-size:15px;vertical-align:-3px;margin-right:3px">date_range</span>Personalizado' },
  ];
  body.innerHTML = `
    <div class="ct-toolbar">
      <div class="ct-periodo">
        ${periodos.map(p => `<button type="button" class="ct-periodo-btn${p.k === ctaPeriodo ? ' active' : ''}" data-p="${p.k}">${p.t}</button>`).join('')}
      </div>
      <span class="bal-cta-sub" style="margin-left:auto">${ddmm(d)}/${d.slice(0, 4)} → ${ddmm(h)}/${h.slice(0, 4)}</span>
    </div>
    <div id="cta-custom" class="ct-custom-panel" style="display:${ctaPeriodo === 'custom' ? '' : 'none'}">
      <div class="ct-custom-grp">
        <div class="ct-custom-title">Rango por días</div>
        <div class="ct-custom-row">
          <label>Desde<input type="date" id="cta-desde" value="${ctaRango?.desde || ''}"></label>
          <label>Hasta<input type="date" id="cta-hasta" value="${ctaRango?.hasta || ''}"></label>
          <button type="button" id="cta-aplicar" class="ct-custom-apply">Aplicar</button>
        </div>
      </div>
    </div>
    <div id="cta-body"><div class="ct-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div></div>`;

  body.querySelectorAll('.ct-periodo-btn').forEach(btn => btn.addEventListener('click', () => {
    ctaPeriodo = btn.dataset.p;
    localStorage.setItem('bal:cta_periodo', ctaPeriodo);
    renderBody();
  }));
  body.querySelector('#cta-aplicar')?.addEventListener('click', () => {
    const desde = body.querySelector('#cta-desde')?.value;
    if (!desde) return;
    ctaRango = { desde, hasta: body.querySelector('#cta-hasta')?.value || desde };
    localStorage.setItem('bal:cta_rango', JSON.stringify(ctaRango));
    ctaPeriodo = 'custom';
    localStorage.setItem('bal:cta_periodo', 'custom');
    renderBody();
  });

  const meses = rangoMeses(d.slice(0, 7), h.slice(0, 7));
  const docs = {};
  await Promise.all(meses.map(async ym => { docs[ym] = await loadDiasMes(db, ym); }));
  if (!cadena) { try { await recalcularCadena(); } catch (_) {} }
  if (view !== 'cuentas') return;
  const host = body.querySelector('#cta-body');
  if (!host) return;

  const r = cuentasDelPeriodo({ docs, desde: d, hasta: h });
  const caja = cajaActual();
  const r2 = v => Math.round(v * 100) / 100;

  if (!r.dias) {
    host.innerHTML = `<div class="bal-caption"><span class="material-icons">account_balance</span>
      No hay días cargados en este período. Cargalos en <b>Día por día</b> y acá aparece la plata por cuenta.</div>`;
    return;
  }

  // Tarjetas por medio: saldo de hoy (cadena) + lo que se movió en el período.
  const cuando = caja ? (caja.dd ? `al ${caja.dd}/${caja.ym.slice(5, 7)}` : `al cierre de ${esc(mesLabel(caja.ym))}`) : '';
  const card = (k, label, cls) => {
    const pm = r.porMedio[k] || { ingresos: 0, egresos: 0, neto: 0 };
    const saldo = caja && caja.saldos && caja.saldos[k] != null ? Number(caja.saldos[k]) : null;
    return `
      <div class="bal-cta-card ${cls}">
        <span>${label} <span class="bal-cta-sub">${saldo != null ? 'hoy ' + cuando : ''}</span></span>
        <b class="${saldo != null ? negCls(saldo).trim() : ''}">${saldo != null ? money(saldo) : '—'}</b>
        <small><span class="mas">+${fmt(pm.ingresos)}</span><span class="menos">−${fmt(pm.egresos)}</span><span class="igual${negCls(pm.neto)}">= ${money(pm.neto)}</span></small>
      </div>`;
  };
  const totalPeriodo = ['efectivo', 'mp', 'lapos', 'sin'].reduce((s, k) => s + (r.porMedio[k]?.neto || 0), 0);
  const cardTotal = `
      <div class="bal-cta-card is-total">
        <span>Total <span class="bal-cta-sub">${caja ? 'hoy ' + cuando : ''}</span></span>
        <b class="${caja ? negCls(caja.total).trim() : ''}">${caja ? money(caja.total) : '—'}</b>
        <small><span class="igual${negCls(totalPeriodo)}">período: ${money(r2(totalPeriodo))}</span></small>
      </div>`;

  // Tabla por cuenta (acá Mercado Pago se abre en MP JOSE / MP AGUSTIN).
  const totIng = r.cuentas.reduce((s, c) => s + c.ingresos, 0);
  const totEgr = r.cuentas.reduce((s, c) => s + c.egresos, 0);
  const medioLbl = { efectivo: 'Efectivo', mp: 'Mercado Pago', lapos: 'Lapos', sin: 'Sin medio' };
  const filas = r.cuentas.map(c => {
    const pct = totIng > 0 ? Math.round(c.ingresos / totIng * 100) : 0;
    return `
      <tr>
        <td class="bal-td-lbl">${esc(c.label)}${c.medio === 'mp' ? `<span class="bal-cta-sub">${medioLbl[c.medio]}</span>` : ''}</td>
        <td>${c.ingresos ? money(c.ingresos) : '—'}</td>
        <td>${c.egresos ? money(c.egresos) : '—'}</td>
        <td class="bal-td-total${negCls(c.neto)}">${money(c.neto)}</td>
        <td><div style="display:flex;align-items:center;gap:8px"><div class="bal-cta-bar" style="flex:1"><i style="width:${pct}%"></i></div><span class="bal-cta-sub">${pct}%</span></div></td>
      </tr>`;
  }).join('');
  const sinAsignar = r.cuentas.find(c => c.clave === 'mp:' && c.egresos > 0);

  // Detalle de ingresos: por cuenta, qué motivos y cuántas veces.
  const ingresosHtml = r.cuentas.filter(c => c.ingresos > 0).map(c => `
    <div class="bal-cta-grupo">
      <div class="bal-cta-grupo-h"><span>${esc(c.label)}</span><span>${money(c.ingresos)}</span></div>
      ${c.ingPorMotivo.map(x => `
        <div class="bal-cta-linea"><span>${esc(x.motivo)} <span class="veces">· ${x.veces} ${x.veces === 1 ? 'día' : 'días'}</span></span><b>${money(x.total)}</b></div>`).join('')}
    </div>`).join('');

  // Detalle de egresos: por cuenta, rubros y proveedores, y la lista completa.
  const egresosHtml = r.cuentas.filter(c => c.egresos > 0).map(c => {
    const top = c.egresos || 1;
    const movs = c.movimientos.filter(m => m.tipo === 'egreso');
    return `
    <div class="bal-cta-grupo">
      <div class="bal-cta-grupo-h"><span>${esc(c.label)}</span><span>${money(c.egresos)}</span></div>
      <div class="bal-cta-sub" style="margin:2px 0 4px">Por rubro</div>
      ${c.egrPorRubro.map(x => `
        <div class="bal-cta-linea"><span>${esc(x.rubro)} <span class="veces">· ${x.veces}</span></span>
          <div class="bal-cta-bar" style="width:90px"><i style="width:${Math.round(x.total / top * 100)}%"></i></div><b>${money(x.total)}</b></div>`).join('')}
      <div class="bal-cta-sub" style="margin:8px 0 4px">Por proveedor / motivo</div>
      ${c.egrPorProveedor.slice(0, 8).map(x => `
        <div class="bal-cta-linea"><span>${esc(x.proveedor)} <span class="veces">· ${x.veces}</span></span><b>${money(x.total)}</b></div>`).join('')}
      ${c.egrPorProveedor.length > 8 ? `<div class="bal-cta-sub">y ${c.egrPorProveedor.length - 8} más</div>` : ''}
      <details class="bal-cta-movs">
        <summary>Ver los ${movs.length} movimientos</summary>
        <div class="bal-table-wrap"><table class="bal-table">
          <thead><tr><th class="bal-th-lbl">Fecha</th><th class="bal-th-lbl">Proveedor / motivo</th><th class="bal-th-lbl">Rubro</th><th class="bal-th-total">Monto</th></tr></thead>
          <tbody>${movs.map(m => `
            <tr data-ir="${m.iso}" title="Abrir el día">
              <td class="bal-td-lbl">${ddmm(m.iso)}/${m.iso.slice(2, 4)}</td><td>${esc(m.proveedor || '—')}</td><td>${esc(m.rubro || '—')}</td>
              <td class="bal-td-total">${money(m.monto)}</td></tr>`).join('')}
          </tbody></table></div>
      </details>
    </div>`;
  }).join('');

  host.innerHTML = `
    <div class="bal-cta-cards">
      ${card('efectivo', 'Efectivo', 'is-efectivo')}
      ${card('mp', 'Mercado Pago', 'is-mp')}
      ${card('lapos', 'Lapos', 'is-lapos')}
      ${cardTotal}
    </div>
    <div class="bal-caption"><span class="material-icons">account_balance</span>
      Arriba, la plata que hay hoy en cada medio (sigue la cadena de cierres). Abajo, lo que entró y salió
      <b>por cuenta</b> en el período: Mercado Pago se abre en cada cuenta según el nombre del ingreso
      (MP JOSE, MP AGUSTIN) y, en las compras, según el medio elegido en cada fila.
      ${r.dias} ${r.dias === 1 ? 'día cargado' : 'días cargados'}.</div>

    <div class="bal-card bal-xls" style="margin-bottom:16px">
      <div class="bal-card-title"><span class="material-icons">compare_arrows</span> Por cuenta en el período</div>
      <div class="bal-table-wrap">
        <table class="bal-table bal-xls-table">
          <thead><tr><th class="bal-th-lbl">Cuenta</th><th>Ingresos</th><th>Egresos</th><th class="bal-th-total">Neto</th><th>Parte de los ingresos</th></tr></thead>
          <tbody>${filas}</tbody>
          <tfoot><tr class="bal-row-total">
            <td class="bal-td-lbl">Total</td><td>${money(r2(totIng))}</td><td>${money(r2(totEgr))}</td>
            <td class="bal-td-total${negCls(totIng - totEgr)}">${money(r2(totIng - totEgr))}</td><td></td>
          </tr></tfoot>
        </table>
      </div>
      ${sinAsignar ? `<div class="bal-dia-faltas" style="margin-top:10px"><span class="material-icons">info</span>
        Hay <b>${money(sinAsignar.egresos)}</b> de compras pagadas con Mercado Pago sin decir de cuál. En cada compra, elegí
        <b>${mpCuentas.join('</b> o <b>') || 'la cuenta'}</b> como medio para que entre en su cuenta.</div>` : ''}
    </div>

    <div class="bal-cta-grid2">
      <div class="bal-card bal-xls">
        <div class="bal-card-title"><span class="material-icons">south_east</span> Ingresos por cuenta</div>
        ${ingresosHtml || '<div class="bal-mov-empty">Sin ingresos en el período</div>'}
      </div>
      <div class="bal-card bal-xls">
        <div class="bal-card-title"><span class="material-icons">north_east</span> Egresos detallados por cuenta</div>
        ${egresosHtml || '<div class="bal-mov-empty">Sin egresos en el período</div>'}
      </div>
    </div>`;

  host.querySelectorAll('[data-ir]').forEach(tr => tr.addEventListener('click', () => {
    const iso = tr.dataset.ir;
    gotoDia(iso.slice(0, 7), iso.slice(8, 10));
  }));
}

async function renderSemana(body) {
  body.innerHTML = `<div class="ct-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div>`;
  // Del primer mes del balance al mes actual: el mes en curso puede tener días
  // cargados aunque todavía no se haya agregado al RESUMEN.
  const ymHoy = hoyAR().slice(0, 7);
  const primero = mesesOrdenados('asc')[0] || ymHoy;
  const meses = ymRange(primero <= ymHoy ? primero : ymHoy, ymHoy);
  const docs = {};
  await Promise.all(meses.map(async ym => { docs[ym] = await loadDiasMes(db, ym); }));
  if (view !== 'semana') return;   // cambió de pestaña mientras cargaba

  // Agrupar los días cargados por semana (clave = lunes de esa semana)
  const semanas = new Map();
  meses.forEach(ym => {
    const m = docs[ym];
    if (!m || !m.dias) return;
    Object.keys(m.dias).sort().forEach(dd => {
      const t = diaTotales(m.dias[dd]);
      if (!t.ing.total && !t.com.total) return;   // día plantilla sin montos
      const lun = mondayOf(`${ym}-${dd}`);
      let w = semanas.get(lun);
      if (!w) {
        w = {
          lun, dom: shiftFecha(lun, 6), dias: 0, cierre: null, fin: null,
          ing: { efectivo: 0, mp: 0, lapos: 0, sin: 0, total: 0 },
          egr: { efectivo: 0, mp: 0, lapos: 0, sin: 0, total: 0 },
        };
        semanas.set(lun, w);
      }
      ['efectivo', 'mp', 'lapos', 'sin', 'total'].forEach(k => { w.ing[k] += t.ing[k]; w.egr[k] += t.com[k]; });
      w.dias++;
      w.fin = { ym, dd };   // último día con datos (los meses vienen en orden asc)
    });
  });

  const lista = [...semanas.values()].sort((a, b) => b.lun.localeCompare(a.lun));
  if (!lista.length) {
    body.innerHTML = `
      <div class="bal-empty">
        <span class="material-icons">view_week</span>
        <div class="bal-empty-title">Todavía no hay días cargados</div>
        <div class="bal-empty-sub">El resumen semanal se arma desde el detalle del "Día por día".
        Cargá días ahí (o usá "Importar días") y las semanas aparecen solas.</div>
      </div>`;
    return;
  }

  const r2 = v => Math.round(v * 100) / 100;
  // Caja al cierre de cada semana: acumulado del mes del último día con datos,
  // arrancando de la apertura del mes según la cadena (tipeada o cierre anterior).
  const cad = cadenaMeses({ meses, tipeados: saldosTipeados(), docs, hoy: hoyAR() });
  lista.forEach(w => {
    const m = docs[w.fin.ym];
    const ap = aperturaDe(cad, w.fin.ym);
    if (m && ap) {
      const a = acumuladoHasta(m.dias, ap, w.fin.dd);
      w.cierre = r2(a.efectivo + a.mp + a.lapos + a.sin);
    }
  });

  const lunActual = mondayOf(hoyAR());
  // Promedios sobre las últimas 4 semanas cerradas (la semana en curso distorsiona)
  const cerradas = lista.filter(w => w.lun !== lunActual).slice(0, 4);
  const promIng = cerradas.length ? cerradas.reduce((s, w) => s + w.ing.total, 0) / cerradas.length : 0;
  const promEgr = cerradas.length ? cerradas.reduce((s, w) => s + w.egr.total, 0) / cerradas.length : 0;
  const promSaldo = promIng - promEgr;

  let mesPrev = null;
  const rows = lista.map(w => {
    const saldo = r2(w.ing.total - w.egr.total);
    const mesLun = w.lun.slice(0, 7);
    const divider = mesLun !== mesPrev
      ? `<tr class="bal-row-sep"><td colspan="5">${esc(mesLabelAny(mesLun))}</td></tr>` : '';
    mesPrev = mesLun;
    const medioRow = (label, ing, egr) => `
      <div class="bal-sem-det-item">
        <span>${label}</span>
        <b><span class="bal-sem-mas">+${fmt(r2(ing))}</span> <span class="bal-sem-menos">−${fmt(r2(egr))}</span>
        <span class="bal-sem-igual${negCls(ing - egr)}">= ${money(r2(ing - egr))}</span></b>
      </div>`;
    return `${divider}
      <tr class="bal-sem-row" data-sem="${w.lun}">
        <td class="bal-td-lbl">
          <div class="bal-sem-lbl"><b>${ddmm(w.lun)} → ${ddmm(w.dom)}</b>
            ${w.lun === lunActual ? '<span class="bal-sem-badge">Esta semana</span>' : ''}</div>
          <small>${w.dias} ${w.dias === 1 ? 'día cargado' : 'días cargados'}</small>
        </td>
        <td>${money(r2(w.ing.total))}</td>
        <td>${w.egr.total ? money(r2(w.egr.total)) : '—'}</td>
        <td class="bal-sem-saldo${negCls(saldo)}">${money(saldo)}</td>
        <td class="bal-td-total${negCls(w.cierre)}">${w.cierre != null ? money(w.cierre) : '—'}</td>
      </tr>
      <tr class="bal-sem-det" data-det="${w.lun}" style="display:none">
        <td colspan="5">
          <div class="bal-sem-det-grid">
            ${medioRow('Efectivo', w.ing.efectivo, w.egr.efectivo)}
            ${medioRow('Mercado Pago', w.ing.mp, w.egr.mp)}
            ${medioRow('Lapos', w.ing.lapos, w.egr.lapos)}
            ${(w.ing.sin || w.egr.sin) ? medioRow('Sin medio', w.ing.sin, w.egr.sin) : ''}
          </div>
        </td>
      </tr>`;
  }).join('');

  body.innerHTML = `
    <div class="bal-caption"><span class="material-icons">view_week</span>
      Resumen <b>semana a semana</b> (lunes a domingo), armado desde el detalle del Día por día.
      Click en una semana para ver el desglose por medio de pago.</div>

    <div class="bal-sem-stats">
      <div class="bal-sem-stat"><span>Semanas registradas</span><b>${lista.length}</b></div>
      <div class="bal-sem-stat"><span>Ingresos promedio ${cerradas.length ? `(últ. ${cerradas.length} sem.)` : ''}</span><b>${money(r2(promIng))}</b></div>
      <div class="bal-sem-stat"><span>Egresos promedio</span><b>${money(r2(promEgr))}</b></div>
      <div class="bal-sem-stat"><span>Saldo promedio</span><b class="${negCls(promSaldo).trim()}">${money(r2(promSaldo))}</b></div>
    </div>

    <div class="bal-card bal-xls">
      <div class="bal-card-title"><span class="material-icons">view_week</span> Semana a semana</div>
      <div class="bal-table-wrap">
        <table class="bal-table bal-xls-table">
          <thead><tr>
            <th class="bal-th-lbl">Semana</th>
            <th>Ingresos</th>
            <th>Egresos</th>
            <th>Saldo semana</th>
            <th class="bal-th-total">Caja al cierre</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

  body.querySelectorAll('.bal-sem-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const det = body.querySelector(`.bal-sem-det[data-det="${tr.dataset.sem}"]`);
      if (det) det.style.display = det.style.display === 'none' ? '' : 'none';
    });
  });
}

// ── Sub-vista: DÍA POR DÍA (detalle completo, flujo de cierre diario) ─────────
let curDiaYm = null, curDiaDD = null;
// Sugerencias de autocompletado (proveedores y rubros ya usados en el detalle
// diario) para no re-tipear. Se cachea por sesión y se refresca con el mes actual.
let diasAgg = null;   // { prov:Set, rub:Set }

function hoyAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}
function fechaLarga(iso) {
  const d = new Date(iso + 'T12:00:00-03:00');
  const s = d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function shiftFecha(iso, delta) {
  const d = new Date(iso + 'T12:00:00-03:00');
  d.setDate(d.getDate() + delta);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}
function setDiaDefault() {
  if (curDiaYm && curDiaDD) return;
  const t = hoyAR();
  curDiaYm = t.slice(0, 7);
  curDiaDD = t.slice(8, 10);
}
function diaTotales(dia) {
  const acc = (arr) => {
    const o = { efectivo: 0, mp: 0, lapos: 0, sin: 0, total: 0 };
    (arr || []).forEach(x => {
      const v = Number(x.monto) || 0;
      if (x.medio && o[x.medio] != null) o[x.medio] += v; else o.sin += v;
      o.total += v;
    });
    return o;
  };
  const ing = acc(dia.ingresos), com = acc(dia.compras);
  return { ing, com, saldo: ing.total - com.total };
}

// ── Cierre por medio de pago / saldo acumulado (réplica del Excel) ─────────────
// Ingresos y compras del día desglosados por medio (efectivo/mp/lapos + 'sin').
function diaPorMedio(dia) {
  const ing = { efectivo: 0, mp: 0, lapos: 0, sin: 0 };
  const com = { efectivo: 0, mp: 0, lapos: 0, sin: 0 };
  (dia.ingresos || []).forEach(x => { const m = x.medio && ing[x.medio] != null ? x.medio : 'sin'; ing[m] += Number(x.monto) || 0; });
  (dia.compras || []).forEach(x => { const m = x.medio && com[x.medio] != null ? x.medio : 'sin'; com[m] += Number(x.monto) || 0; });
  return { ing, com };
}
// Neto de un día por medio (ingresos − compras). Incluye 'sin' (medio vacío) para
// que el total del acumulado cierre con el saldo del día (que también lo suma).
function netoDiaPorMedio(dia) {
  const { ing, com } = diaPorMedio(dia);
  return { efectivo: ing.efectivo - com.efectivo, mp: ing.mp - com.mp, lapos: ing.lapos - com.lapos, sin: ing.sin - com.sin };
}
// Saldo acumulado por medio desde la apertura del mes hasta ddHasta (inclusive).
// Es el "SALDO DIARIO ACUMULADO" del Excel: apertura + suma de netos diarios.
// Redondea a 2 decimales (como cierreMes) para evitar arrastre de coma flotante.
function acumuladoHasta(dias, apertura, ddHasta) {
  const o = { efectivo: Number(apertura?.efectivo) || 0, mp: Number(apertura?.mp) || 0, lapos: Number(apertura?.lapos) || 0, sin: 0 };
  Object.keys(dias || {}).sort().forEach(dd => {
    if (dd > ddHasta) return;
    const n = netoDiaPorMedio(dias[dd]);
    o.efectivo += n.efectivo; o.mp += n.mp; o.lapos += n.lapos; o.sin += n.sin;
  });
  const r2 = v => Math.round(v * 100) / 100;
  return { efectivo: r2(o.efectivo), mp: r2(o.mp), lapos: r2(o.lapos), sin: r2(o.sin) };
}
// Cierre del mes completo = apertura + neto de todos los días.
function cierreMes(mesSeed) {
  const o = { efectivo: Number(mesSeed.apertura?.efectivo) || 0, mp: Number(mesSeed.apertura?.mp) || 0, lapos: Number(mesSeed.apertura?.lapos) || 0 };
  Object.values(mesSeed.dias || {}).forEach(d => { const n = netoDiaPorMedio(d); o.efectivo += n.efectivo; o.mp += n.mp; o.lapos += n.lapos; });
  const r2 = v => Math.round(v * 100) / 100;
  return { efectivo: r2(o.efectivo), mp: r2(o.mp), lapos: r2(o.lapos) };
}

// Mapa de rubros del libro diario → lista del RESUMEN (acentos/caso normalizados).
// "Pegamentos" y "Acc. Cabello" no estaban en la lista original; se agregan como
// rubros nuevos al importar. Los ítems sin rubro quedan sin categorizar.
const RUBRO_MAP = {
  'sueldos': 'SUELDOS', 'libreria': 'LIBRERIA', 'gastos fijos': 'GASTOS FIJOS', 'merceria': 'MERCERIA',
  'papelera': 'PAPELERA', 'sellos': 'SELLOS', 'accesorios celular': 'ACC. CELULAR', 'acc. celular': 'ACC. CELULAR',
  'formularios': 'FORMULARIOS', 'bijou': 'BIJOU', 'billeteras / mochilas': 'BILL/MOCHI', 'bill/mochi': 'BILL/MOCHI',
  'pilas': 'PILAS', 'descartables': 'DESCARTABLES', 'bazar': 'BAZAR', 'jugueteria': 'JUGUETERIA',
  'cotillon': 'COTILLON', 'pegamentos': 'PEGAMENTOS', 'acc. cabello': 'ACC. CABELLO',
};
function normRubro(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
// Suma las compras del mes por rubro, mapeadas a la lista del RESUMEN.
function rubrosDesdeDias(diasMap) {
  const agg = {};
  Object.values(diasMap || {}).forEach(d => {
    (d.compras || []).forEach(x => {
      const key = RUBRO_MAP[normRubro(x.rubro)];
      if (!key) return;
      agg[key] = (agg[key] || 0) + (Number(x.monto) || 0);
    });
  });
  Object.keys(agg).forEach(k => { agg[k] = Math.round(agg[k] * 100) / 100; });
  return agg;
}

// Plantilla por defecto de un día vacío: replica la estructura del ÚLTIMO día
// cargado del mes (mismos motivos/medios, sin montos), para que siga tus filas
// habituales (Caja hoy, MP JOSE, MP AGUSTIN, Lapos…). Si el mes no tiene datos,
// usa una estructura típica como fallback. No se persiste hasta cargar un valor.
function defaultIngresos(dias) {
  if (dias) {
    const conDatos = Object.keys(dias)
      .filter(dd => (dias[dd].ingresos || []).some(x => Number(x.monto) > 0))
      .sort();
    const last = conDatos[conDatos.length - 1];
    if (last) {
      const tpl = (dias[last].ingresos || [])
        .filter(x => Number(x.monto) > 0)
        .map(x => ({ motivo: x.motivo || '', medio: x.medio || null, monto: 0 }));
      if (tpl.length) return tpl;
    }
  }
  return [
    { motivo: 'Caja hoy', medio: 'efectivo', monto: 0 },
    { motivo: 'MP JOSE', medio: 'mp', monto: 0 },
    { motivo: 'MP AGUSTIN', medio: 'mp', monto: 0 },
    { motivo: 'Lapos', medio: 'lapos', monto: 0 },
  ];
}

// Opciones del <select> de medio para una fila de movimiento (incluye "—" vacío).
// Opciones del medio de pago. En las compras, Mercado Pago se abre en las cuentas
// vistas en los ingresos (MP JOSE, MP AGUSTIN...) para saber de cuál salió la
// plata: se guarda medio 'mp' + `cuenta`. El valor de esas opciones es 'mp:NOMBRE'.
function medioOptions(sel, cuenta = null, conCuentasMp = false) {
  const selMp = sel === 'mp' && normCuenta(cuenta) ? 'mp:' + normCuenta(cuenta) : null;
  const nombres = conCuentasMp ? [...mpCuentas] : [];
  if (selMp && !nombres.includes(selMp.slice(3))) nombres.push(selMp.slice(3));
  return MEDIOS.map(m => {
    let opts = `<option value="${m.k}" ${sel === m.k && !selMp ? 'selected' : ''}>${m.label}</option>`;
    if (m.k === 'mp') {
      opts += nombres.map(n =>
        `<option value="mp:${esc(n)}" ${selMp === 'mp:' + n ? 'selected' : ''}>&nbsp;&nbsp;${esc(n)}</option>`).join('');
    }
    return opts;
  }).join('') + `<option value="" ${!sel ? 'selected' : ''}>—</option>`;
}

// HTML de una fila de movimiento (ingreso o compra). Se usa tanto en el render
// inicial como al agregar/borrar una fila en el lugar (sin re-render del día).
function movRowHtml(x, i, tipo) {
  if (tipo === 'ingresos') {
    return `
    <div class="bal-mov-row bal-mov-ing" data-mov="ingresos" data-i="${i}">
      <input data-f="motivo" value="${esc(x.motivo || '')}" placeholder="Motivo (ej: Caja, MP)">
      <select data-f="medio">${medioOptions(x.medio)}</select>
      <input data-f="monto" inputmode="decimal" value="${fmt(Number(x.monto) || 0)}" style="text-align:right">
      <button class="bal-fijo-del" data-del title="Quitar"><span class="material-icons">close</span></button>
    </div>`;
  }
  return `
    <div class="bal-mov-row bal-mov-com" data-mov="compras" data-i="${i}">
      <input data-f="proveedor" value="${esc(x.proveedor || '')}" placeholder="Proveedor / motivo" autocomplete="off">
      <input data-f="rubro" value="${esc(x.rubro || '')}" placeholder="Rubro" autocomplete="off">
      <select data-f="medio">${medioOptions(x.medio, x.cuenta, true)}</select>
      <input data-f="monto" inputmode="decimal" value="${fmt(Number(x.monto) || 0)}" style="text-align:right">
      <button class="bal-fijo-del" data-del title="Quitar"><span class="material-icons">close</span></button>
    </div>`;
}

// Junta proveedores y rubros usados en las compras de un doc de días.
function aggDeDoc(doc, prov, rub) {
  if (!doc || !doc.dias) return;
  Object.values(doc.dias).forEach(d => (d.compras || []).forEach(c => {
    const p = (c.proveedor || '').trim(); if (p) prov.add(p);
    const r = (c.rubro || '').trim();     if (r) rub.add(r);
  }));
}
// Carga (una vez por sesión) proveedores/rubros de los meses recientes con detalle;
// en cada llamada refresca con el mes actual en memoria. loadDiasMes está cacheado.
async function cargarAggDias() {
  if (!diasAgg) {
    const prov = new Set(), rub = new Set();
    for (const ym of mesesOrdenados('desc').slice(0, 8)) aggDeDoc(await loadDiasMes(db, ym), prov, rub);
    diasAgg = { prov, rub };
  }
  aggDeDoc(curDiasDoc, diasAgg.prov, diasAgg.rub);
  return diasAgg;
}
// Listas ordenadas para los <datalist> (usan lo que haya en memoria al renderizar).
function provSugeridos() {
  const s = new Set(diasAgg ? diasAgg.prov : []);
  aggDeDoc(curDiasDoc, s, new Set());
  return [...s].sort((a, b) => a.localeCompare(b, 'es'));
}
function rubroSugeridos() {
  const s = new Set(rubrosLista());
  if (diasAgg) diasAgg.rub.forEach(r => s.add(r));
  aggDeDoc(curDiasDoc, new Set(), s);
  return [...s].sort((a, b) => a.localeCompare(b, 'es'));
}
// ── Autocomplete propio (el <datalist> nativo se ve feo) ─────────────────────
// Un solo panel flotante reutilizable, pegado bajo el input activo. Filtra en vivo,
// se elige con click o teclado, y hereda el tema (light/dark) por las CSS vars.
let acBox = null, acInput = null, acItems = [], acIdx = -1;

function acEnsure() {
  if (acBox) return acBox;
  acBox = document.createElement('div');
  acBox.className = 'bal-ac';
  acBox.style.cssText = 'position:fixed;z-index:10000;display:none;max-height:260px;overflow-y:auto;'
    + 'background:var(--surface);border:1px solid var(--border);border-radius:10px;'
    + 'box-shadow:0 10px 30px rgba(0,0,0,.22);padding:4px';
  document.body.appendChild(acBox);
  acBox.addEventListener('mousedown', e => e.preventDefault());  // no perder foco antes del click
  window.addEventListener('scroll', acHide, true);
  window.addEventListener('resize', acHide);
  return acBox;
}
function acHide() { if (acBox) acBox.style.display = 'none'; acInput = null; acIdx = -1; }
function acHighlight() {
  if (!acBox) return;
  acBox.querySelectorAll('.bal-ac-item').forEach((el, i) => {
    el.style.background = (i === acIdx) ? 'var(--surface-2)' : '';
    if (i === acIdx) el.scrollIntoView({ block: 'nearest' });
  });
}
function acPick(v) {
  if (acInput) { acInput.value = v; acInput.dispatchEvent(new Event('change', { bubbles: true })); }
  acHide();
}
function acRender() {
  const box = acEnsure();
  if (!acInput || !acItems.length) { acHide(); return; }
  box.innerHTML = acItems.map((v, i) =>
    `<div class="bal-ac-item" data-i="${i}" style="padding:8px 12px;font-size:13px;cursor:pointer;`
    + `white-space:nowrap;border-radius:7px;color:var(--text);${i === acIdx ? 'background:var(--surface-2)' : ''}">${esc(v)}</div>`
  ).join('');
  const r = acInput.getBoundingClientRect();
  box.style.left = r.left + 'px';
  box.style.top = (r.bottom + 3) + 'px';
  box.style.minWidth = r.width + 'px';
  box.style.display = 'block';
  box.scrollTop = 0;
  box.querySelectorAll('.bal-ac-item').forEach(el => {
    el.addEventListener('click', () => acPick(acItems[Number(el.dataset.i)]));
    el.addEventListener('mouseenter', () => { acIdx = Number(el.dataset.i); acHighlight(); });
  });
}
function attachAutocomplete(input, getItems) {
  const open = () => {
    acInput = input;
    const q = input.value.trim().toLowerCase();
    let items = getItems();
    if (q) items = items.filter(v => v.toLowerCase().includes(q));
    acItems = items.slice(0, 60);
    acIdx = -1;
    acRender();
  };
  input.addEventListener('focus', open);
  input.addEventListener('input', open);
  input.addEventListener('blur', () => setTimeout(() => { if (acInput === input) acHide(); }, 120));
  input.addEventListener('keydown', e => {
    if (acInput !== input || !acBox || acBox.style.display === 'none') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); acIdx = Math.min(acIdx + 1, acItems.length - 1); acHighlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); acIdx = Math.max(acIdx - 1, 0); acHighlight(); }
    else if (e.key === 'Enter') { if (acIdx >= 0) { e.preventDefault(); acPick(acItems[acIdx]); } }
    else if (e.key === 'Escape') { acHide(); }
  });
}

// ── Gastos fijos del mes (panel dentro de Día por día) ────────────────────────
// El control de los fijos es día por día: cada pago se carga como una compra del
// día (rubro GASTOS FIJOS, marcada con fijo_id) el día que realmente se paga, con
// el importe real de ese mes. cfg.montosFijos queda como lista de referencia (qué
// fijos existen y su importe típico); el panel muestra qué se pagó y qué falta.
const RUBRO_FIJO = 'GASTOS FIJOS';

function normTexto(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
// Día de vencimiento efectivo de un fijo en un mes ('DD') o null si no tiene fecha.
// Clampa al último día del mes (venceDia 31 en febrero → 28/29).
function fijoVenceDD(f, ym) {
  const d = Number(f.venceDia);
  if (!d || d < 1) return null;
  const [y, m] = ym.split('-').map(Number);
  return String(Math.min(Math.round(d), new Date(y, m, 0).getDate())).padStart(2, '0');
}
// Pagos del mes de un fijo: compras marcadas con su fijo_id o, para cargas hechas
// a mano, compras de rubro GASTOS FIJOS cuyo proveedor coincide con el motivo.
function pagosDeFijo(f, dias) {
  const out = [];
  Object.keys(dias || {}).sort().forEach(dd => {
    (dias[dd].compras || []).forEach(x => {
      const esSuyo = x.fijo_id
        ? x.fijo_id === f.id
        : (normRubro(x.rubro) === 'gastos fijos' && normTexto(x.proveedor) === normTexto(f.label));
      if (esSuyo) out.push({ dd, monto: Number(x.monto) || 0 });
    });
  });
  return out;
}

function fijoDiaRowHtml(f, workDias, esHoy) {
  const pagos = pagosDeFijo(f, workDias);
  const pagado = pagos.reduce((s, p) => s + p.monto, 0);
  const ref = Number(f.monto) || 0;
  const completo = pagado > 0 && pagado >= ref - 0.5;
  const mm = +curDiaYm.slice(5, 7);
  const venceDD = fijoVenceDD(f, curDiaYm);
  let estado;
  if (pagos.length) {
    estado = pagos.map(p => `<button type="button" class="bal-fdia-pago" data-fdia-go="${p.dd}" title="Ver el día ${+p.dd}">${+p.dd}/${mm} · ${money(p.monto)}</button>`).join('');
  } else if (venceDD) {
    // Sin pago pero con fecha: el pill refleja dónde está parado el vencimiento
    // respecto de HOY (próximo / vence hoy / vencido).
    const dueIso = `${curDiaYm}-${venceDD}`;
    const hoy = hoyAR();
    if (dueIso === hoy)      estado = `<span class="bal-fdia-pend is-vence-hoy"><span class="material-icons">notifications_active</span>Vence hoy</span>`;
    else if (dueIso < hoy)   estado = `<span class="bal-fdia-pend is-vencido"><span class="material-icons">error_outline</span>Vencido el ${+venceDD}/${mm}</span>`;
    else                     estado = `<span class="bal-fdia-pend is-prox"><span class="material-icons">schedule</span>Vence el ${+venceDD}/${mm}</span>`;
  } else {
    estado = `<span class="bal-fdia-pend">Pendiente</span>`;
  }
  const tieneVence = Number(f.venceDia) >= 1;
  return `
    <div class="bal-fdia-row${completo ? ' is-pagado' : pagos.length ? ' is-parcial' : ''}" data-fdia-id="${esc(f.id)}">
      <input data-fdia-f="label" value="${esc(f.label || '')}" placeholder="Motivo (ej: Alquiler)">
      <input data-fdia-f="monto" inputmode="decimal" value="${fmt(ref)}" style="text-align:right" title="Importe de referencia del mes">
      <select data-fdia-f="fuente">${MEDIOS.map(m => `<option value="${m.k}" ${fuenteValida(f.fuente) === m.k ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
      <button type="button" class="bal-vence-btn${tieneVence ? ' has-fecha' : ''}" data-fdia-vence="${esc(f.id)}"
        title="Fecha límite de pago: el pago aparece ese día en Compras/Gastos y en el calendario, todos los meses">
        <span class="material-icons">${tieneVence ? 'event' : 'event_available'}</span>
        <span class="bal-vence-btn-tx">${tieneVence ? 'Día ' + Number(f.venceDia) : 'Fecha'}</span>
      </button>
      <span class="bal-fdia-estado">${estado}</span>
      <button type="button" class="bal-btn bal-btn-ghost bal-fdia-pagar" data-fdia-pagar="${esc(f.id)}" title="Cargar el pago como compra/gasto de este día">
        <span class="material-icons" style="font-size:15px">payments</span> Pagar ${esHoy ? 'hoy' : 'este día'}
      </button>
      <button type="button" class="bal-fijo-del" data-fdia-del="${esc(f.id)}" title="Quitar de la lista desde este mes (el histórico se conserva)"><span class="material-icons">delete_outline</span></button>
    </div>`;
}

// Resumen del header del panel: pagado / referencia / lo que falta este mes.
function fdiaTotsHtml(workDias) {
  const fijos = (cfg.montosFijos || []).filter(f => fijoAplica(f, curDiaYm));
  const totRef = fijos.reduce((s, f) => s + (Number(f.monto) || 0), 0);
  const totPag = fijos.reduce((s, f) => s + pagosDeFijo(f, workDias).reduce((a, p) => a + p.monto, 0), 0);
  const pend = Math.max(0, Math.round((totRef - totPag) * 100) / 100);
  // Vencidos: fijos con fecha límite ya pasada (vs. hoy) y sin pago en el mes.
  const hoy = hoyAR();
  const vencidos = fijos.filter(f => {
    const dd = fijoVenceDD(f, curDiaYm);
    return dd && `${curDiaYm}-${dd}` < hoy && !pagosDeFijo(f, workDias).length;
  }).length;
  return `Pagado <b class="${totPag > 0 ? 'is-ok' : ''}">${money(totPag)}</b> de <b>${money(totRef)}</b>${pend > 0.5 ? ` · faltan <b class="is-falta">${money(pend)}</b>` : totRef > 0 ? ' · <b class="is-ok">al día</b>' : ''}${vencidos ? ` · <b class="is-vencido">${vencidos} vencido${vencidos > 1 ? 's' : ''}</b>` : ''}`;
}

// Popover para elegir el día de vencimiento de un fijo: grilla 1–31 tipo
// calendario, montada sobre body (fixed) junto al botón. Se cierra al elegir,
// al hacer click afuera o con Esc; si ya está abierto para ese fijo, lo cierra.
function abrirVencePicker(anchor, f, onPick) {
  const prev = document.querySelector('.bal-vence-pop');
  if (prev) {
    const mismo = prev.dataset.fijo === f.id;
    prev.remove();
    if (mismo) return;   // segundo click en el mismo botón → toggle
  }
  const pop = document.createElement('div');
  pop.className = 'bal-vence-pop';
  pop.dataset.fijo = f.id;
  const sel = Number(f.venceDia) || 0;
  pop.innerHTML = `
    <div class="bal-vence-pop-title"><span class="material-icons">event_repeat</span> Vence cada mes el día</div>
    <div class="bal-vence-grid">
      ${Array.from({ length: 31 }, (_, k) => `<button type="button" class="bal-vence-dia${k + 1 === sel ? ' is-sel' : ''}" data-d="${k + 1}">${k + 1}</button>`).join('')}
    </div>
    <div class="bal-vence-pop-hint">Ese día el pago aparece en Compras/Gastos y en el calendario.</div>
    ${sel ? `<button type="button" class="bal-vence-clear" data-clear><span class="material-icons">event_busy</span> Quitar vencimiento</button>` : ''}`;
  document.body.appendChild(pop);
  // Posición: pegado al botón, sin salirse del viewport (abre arriba si no entra).
  const r = anchor.getBoundingClientRect();
  const x = Math.min(Math.max(8, r.left), window.innerWidth - pop.offsetWidth - 8);
  let y = r.bottom + 6;
  if (y + pop.offsetHeight > window.innerHeight - 8) y = r.top - pop.offsetHeight - 6;
  pop.style.left = x + 'px';
  pop.style.top = Math.max(8, y) + 'px';
  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', onKey, true);
  pop.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => { close(); onPick(Number(b.dataset.d)); }));
  pop.querySelector('[data-clear]')?.addEventListener('click', () => { close(); onPick(null); });
}

// Pagos programados que "caen" en el día visto: fijos con vencimiento ese día
// exacto o ya vencidos sin pago (el recordatorio se arrastra hasta HOY, no se
// proyecta a días futuros). Se muestran dentro de "Compras / Gastos del día"
// precargados, listos para confirmar con un click.
function fijosProgramadosDelDia(workDias, ym, dd) {
  const hoy = hoyAR();
  const iso = `${ym}-${dd}`;
  return (cfg.montosFijos || [])
    .filter(f => fijoAplica(f, ym))
    .map(f => ({ f, venceDD: fijoVenceDD(f, ym) }))
    .filter(x => {
      if (!x.venceDD || pagosDeFijo(x.f, workDias).length) return false;
      if (x.venceDD === dd) return true;                 // su día exacto (aunque sea a futuro)
      const dueIso = `${ym}-${x.venceDD}`;
      return dueIso < iso && iso <= hoy;                 // vencido: se arrastra solo hasta hoy
    });
}

function progRowsHtml(workDias, ym, dd, esHoy) {
  const items = fijosProgramadosDelDia(workDias, ym, dd);
  if (!items.length) return '';
  const mm = +ym.slice(5, 7);
  return items.map(({ f, venceDD }) => {
    const vencido = venceDD < dd;
    const medio = MEDIOS.find(m => m.k === fuenteValida(f.fuente));
    const cuando = vencido ? `Vencido el ${+venceDD}/${mm}` : (esHoy ? 'Vence hoy' : 'Vence este día');
    return `
      <div class="bal-prog-row${vencido ? ' is-vencido' : ''}" data-prog-id="${esc(f.id)}">
        <span class="material-icons bal-prog-ic">${vencido ? 'error_outline' : 'event_repeat'}</span>
        <div class="bal-prog-info">
          <span class="bal-prog-nombre">${esc(f.label || 'Gasto fijo')}</span>
          <span class="bal-prog-meta">${cuando} · Gasto fijo mensual · ${esc(medio.label)}</span>
        </div>
        <span class="bal-prog-monto">${money(Number(f.monto) || 0)}</span>
        <button type="button" class="bal-btn bal-prog-btn" data-prog-pagar="${esc(f.id)}" title="Cargar el pago como compra/gasto de este día (rubro ${RUBRO_FIJO})">
          <span class="material-icons" style="font-size:15px">check_circle</span> Confirmar pago
        </button>
      </div>`;
  }).join('');
}

function fijosPanelHtml(workDias, esHoy) {
  const fijos = (cfg.montosFijos || []).filter(f => fijoAplica(f, curDiaYm));
  return `
    <div class="bal-card bal-xls bal-fdia" id="bal-fdia">
      <div class="bal-card-title"><span class="material-icons">event_repeat</span> Gastos fijos del mes <small style="font-weight:600;color:var(--text-muted)">(${esc(mesLabel(curDiaYm))})</small>
        <span class="bal-fdia-tots">${fdiaTotsHtml(workDias)}</span>
      </div>
      <div class="bal-fdia-head"><span>Motivo</span><span>Importe ref.</span><span>Fuente</span><span>Vencimiento</span><span>Estado</span><span></span><span></span></div>
      <div id="bal-fdia-list">
        ${fijos.length ? fijos.map(f => fijoDiaRowHtml(f, workDias, esHoy)).join('') : '<div class="bal-mov-empty">Sin gastos fijos cargados. Agregalos acá y pagalos el día que corresponda.</div>'}
      </div>
      <div class="bal-fijos-foot">
        <button type="button" class="bal-add-btn" data-fdia-add><span class="material-icons">add</span> Agregar fijo</button>
        <span class="bal-fdia-hint">Con vencimiento cargado, el pago aparece solo ese día en "Compras / Gastos del día" y en el calendario, todos los meses. Al pagar entra como compra del día (rubro ${RUBRO_FIJO}); si vino distinto, lo corregís ahí.</span>
      </div>
    </div>`;
}

async function renderDia(body) {
  setDiaDefault();
  body.innerHTML = `<div class="ct-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div>`;
  const mesDoc = await loadDiasMes(db, curDiaYm);
  curDiasDoc = mesDoc || { ym: curDiaYm, dias: {} };
  if (!curDiasDoc.ym) curDiasDoc.ym = curDiaYm;
  curDiasDoc.dias = curDiasDoc.dias || {};
  if (!curDiasDoc.apertura) curDiasDoc.apertura = { efectivo: null, mp: null, lapos: null };
  snapDiasInit(curDiaYm);
  const dias = curDiasDoc.dias;
  const iso = `${curDiaYm}-${curDiaDD}`;
  const dia = dias[curDiaDD] || { fecha: iso, ingresos: [], compras: [] };
  // Plantilla por defecto: un día sin ingresos arranca con las filas típicas
  // (Caja/Efectivo · MP · Lapos) vacías y editables. No se persiste hasta cargar un monto.
  if (!dia.ingresos || !dia.ingresos.length) dia.ingresos = defaultIngresos(dias);
  // Las cuentas MP del día entran a la lista que ofrecen las compras.
  (dia.ingresos || []).forEach(x => {
    const n = x.medio === 'mp' ? normCuenta(x.motivo) : '';
    if (n && !mpCuentas.includes(n)) { mpCuentas.push(n); mpCuentas.sort(); }
  });
  const t = diaTotales(dia);
  // Cierre por medio + saldo acumulado (réplica del Excel). El "work" incluye el
  // día en edición para que el acumulado refleje lo que se está cargando ahora.
  // La apertura es la tipeada o, si no hay, el cierre del mes anterior (cadena).
  const apTipeada = curDiasDoc.apertura || {};
  const apertura = aperturaEfectiva(curDiaYm, curDiasDoc);
  const workDias = Object.assign({}, dias, { [curDiaDD]: dia });
  const pm = diaPorMedio(dia);
  const accum = acumuladoHasta(workDias, apertura, curDiaDD);
  const esHoy = iso === hoyAR();
  // Estado: respeta el flag explícito; si no hay flag, un día pasado se considera
  // CERRADO (histórico ya cargado) y hoy/futuro ABIERTO.
  const cerrado = (dia.cerrado === true || dia.cerrado === false) ? dia.cerrado : (iso < hoyAR());

  // Cerrar el día ya no es un paso: los días pasados se cierran solos y la
  // caja de arriba sigue al último día cargado. Lo único que falta es cargar.
  const faltas = [];
  if (!dia.ingresos.some(x => Number(x.monto) > 0)) faltas.push('cargar la caja / ingresos');

  // Tira de días del mes (estado) + "mes a la fecha"
  const [yy, mm] = curDiaYm.split('-').map(Number);
  const ndays = new Date(yy, mm, 0).getDate();
  const today = hoyAR();
  const diaState = (d) => {
    const fiso = `${curDiaYm}-${d}`;
    const dd2 = dias[d];
    const hasData = !!(dd2 && (((dd2.ingresos || []).some(x => Number(x.monto) > 0)) || (dd2.compras || []).length));
    if (fiso > today) return 'is-futuro';
    const cerr = dd2 ? (dd2.cerrado === true || (dd2.cerrado == null && fiso < today)) : false;
    if (hasData && cerr) return 'is-cerrado';
    if (hasData) return 'is-abierto';
    return 'is-vacio';
  };
  const stripHtml = Array.from({ length: ndays }, (_, k) => {
    const d = String(k + 1).padStart(2, '0');
    const st = diaState(d) + (d === curDiaDD ? ' is-sel' : '');
    return `<button class="bal-strip-day ${st}" data-strip="${d}" title="${curDiaYm}-${d}">${k + 1}</button>`;
  }).join('');
  let sinCerrar = 0;
  for (let k = 1; k <= ndays; k++) {
    const d = String(k).padStart(2, '0');
    if (`${curDiaYm}-${d}` > today) continue;
    const s = diaState(d);
    // Solo días PASADOS operados y reabiertos a mano: hoy está abierto porque sí.
    if (s === 'is-abierto' && `${curDiaYm}-${d}` < today) sinCerrar++;
  }
  let mesIng = 0, mesCom = 0, cargados = 0;
  Object.keys(dias).forEach(k => {
    if (`${curDiaYm}-${k}` > today) return;   // no contar futuro
    const tt = diaTotales(dias[k]);
    mesIng += tt.ing.total; mesCom += tt.com.total;
    if (tt.ing.total > 0 || (dias[k].compras || []).length) cargados++;
  });

  const ingRows = (dia.ingresos || []).map((x, i) => movRowHtml(x, i, 'ingresos')).join('');
  const comRows = (dia.compras || []).map((x, i) => movRowHtml(x, i, 'compras')).join('');

  body.innerHTML = `
    <div class="bal-caption"><span class="material-icons">today</span>
      Detalle día por día (cada movimiento, como el Excel). Cargá ingresos y compras y el saldo se calcula solo.
      Los días pasados <b>se cierran solos</b> y la caja de arriba sigue al último día cargado. Todo se guarda.</div>


    <div class="bal-dia-nav">
      <button class="bal-add-btn bal-nav-btn" data-nav="-1" title="Día anterior"><span class="material-icons">chevron_left</span></button>
      <input type="date" class="bal-dia-date" value="${iso}">
      <button class="bal-add-btn bal-nav-btn" data-nav="1" title="Día siguiente"><span class="material-icons">chevron_right</span></button>
      <button class="bal-add-btn" data-hoy><span class="material-icons">today</span> Hoy</button>
      <span class="bal-dia-fecha">${fechaLarga(iso)}${esHoy ? ' <span class="bal-dia-hoy">HOY</span>' : ''}</span>
      <span class="bal-dia-estado ${cerrado ? 'is-cerrado' : 'is-abierto'}">${cerrado ? 'Cerrado' : 'Abierto'}</span>
    </div>

    <div class="bal-strip-wrap">
      <div class="bal-strip">${stripHtml}</div>
      <div class="bal-strip-legend">
        <span><i class="lg-cerrado"></i>Cerrado</span><span><i class="lg-abierto"></i>Abierto</span><span><i class="lg-vacio"></i>Sin cargar</span>
        ${sinCerrar ? `<span class="bal-strip-warn">${sinCerrar} día(s) sin cerrar</span>` : ''}
      </div>
    </div>

    <div class="bal-mesband">
      <span><span class="material-icons" style="font-size:16px">trending_up</span> Mes: ingresos <b>${money(mesIng)}</b> · compras/gastos <b>${money(mesCom)}</b> · resultado <b class="${negCls(mesIng - mesCom).trim()}">${money(mesIng - mesCom)}</b></span>
      <span class="bal-mesband-sub">${cargados} día(s) cargados</span>
    </div>

    ${faltas.length && !cerrado ? `<div class="bal-dia-faltas"><span class="material-icons">info</span> Para completar el día falta: <b>${faltas.join(' · ')}</b>.</div>` : ''}

    <div class="bal-dia-grid">
      <div class="bal-card bal-xls">
        <div class="bal-card-title"><span class="material-icons">south_east</span> Ingresos / Caja del día
          <button class="bal-btn bal-btn-ghost" data-autofill-dia style="margin-left:auto;padding:5px 10px;font-size:12px"><span class="material-icons" style="font-size:15px">auto_awesome</span> Autocompletar de ventas</button>
        </div>
        <div id="bal-ing-list">${ingRows || '<div class="bal-mov-empty">Sin ingresos cargados</div>'}</div>
        <button class="bal-add-btn" data-add="ingresos" style="margin-top:8px"><span class="material-icons">add</span> Agregar ingreso</button>
        <div class="bal-subtotal"><span>Total ingresos</span><span data-tot="ing">${money(t.ing.total)}</span></div>
      </div>

      <div class="bal-card bal-xls">
        <div class="bal-card-title"><span class="material-icons">north_east</span> Compras / Gastos del día</div>
        <div id="bal-com-prog">${progRowsHtml(workDias, curDiaYm, curDiaDD, esHoy)}</div>
        <div id="bal-com-list">${comRows || '<div class="bal-mov-empty">Sin compras/gastos cargados</div>'}</div>
        <button class="bal-add-btn" data-add="compras" style="margin-top:8px"><span class="material-icons">add</span> Agregar compra/gasto</button>
        <div class="bal-subtotal"><span>Total compras/gastos</span><span data-tot="com">${money(t.com.total)}</span></div>
      </div>
    </div>

    <div class="bal-dia-resumen">
      <div class="bal-dia-stat"><span>Ingresos</span><b>${money(t.ing.total)}</b></div>
      <div class="bal-dia-op">−</div>
      <div class="bal-dia-stat"><span>Compras/Gastos</span><b>${money(t.com.total)}</b></div>
      <div class="bal-dia-op">=</div>
      <div class="bal-dia-stat bal-dia-saldo"><span>Saldo del día</span><b class="${negCls(t.saldo).trim()}">${money(t.saldo)}</b></div>
      <button class="bal-btn ${cerrado ? 'bal-btn-ghost' : ''}" data-cerrar style="margin-left:auto">
        <span class="material-icons">${cerrado ? 'lock_open' : 'check_circle'}</span> ${cerrado ? 'Reabrir día' : 'Cerrar día y siguiente'}
      </button>
    </div>

    ${fijosPanelHtml(workDias, esHoy)}

    <div class="bal-card bal-xls bal-dia-cierre">
      <div class="bal-card-title"><span class="material-icons">account_balance</span> Cierre del día por medio de pago
        <button class="bal-btn bal-btn-ghost" data-fijar-cierre style="margin-left:auto;padding:5px 10px;font-size:12px" title="Copia el saldo acumulado del mes como saldo de cierre en el Resumen">
          <span class="material-icons" style="font-size:15px">playlist_add_check</span> Fijar cierre del mes
        </button>
      </div>
      <div class="bal-table-wrap">
        <table class="bal-table bal-xls-table bal-medios-table">
          <thead><tr>
            <th class="bal-th-lbl">Medio</th><th>Ingresos</th><th>Compras</th>
            <th>Saldo del día</th><th class="bal-th-total">Acumulado</th>
          </tr></thead>
          <tbody>
            ${MEDIOS.map(m => {
              const i = pm.ing[m.k] || 0, c = pm.com[m.k] || 0, sd = i - c, ac = accum[m.k] || 0;
              return `<tr>
                <td class="bal-td-lbl">${esc(m.label)}</td>
                <td data-med-ing="${m.k}">${money(i)}</td>
                <td data-med-com="${m.k}">${money(c)}</td>
                <td class="${negCls(sd).trim()}" data-med-saldo="${m.k}">${money(sd)}</td>
                <td class="bal-td-total${negCls(ac)}" data-med-acum="${m.k}">${money(ac)}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot><tr class="bal-row-total">
            <td class="bal-td-lbl">Total</td>
            <td data-med-ing="total">${money(pm.ing.efectivo + pm.ing.mp + pm.ing.lapos + pm.ing.sin)}</td>
            <td data-med-com="total">${money(pm.com.efectivo + pm.com.mp + pm.com.lapos + pm.com.sin)}</td>
            <td class="${negCls(t.saldo).trim()}" data-med-saldo="total">${money(t.saldo)}</td>
            <td class="bal-td-total${negCls(accum.efectivo + accum.mp + accum.lapos + accum.sin)}" data-med-acum="total">${money(accum.efectivo + accum.mp + accum.lapos + accum.sin)}</td>
          </tr></tfoot>
        </table>
      </div>
      <div class="bal-apertura">
        <span class="bal-field-lbl">Saldo inicial del mes <small>(${esc(mesLabel(curDiaYm))})</small></span>
        <span class="bal-apertura-inputs">
          ${MEDIOS.map(m => `<label><small>${esc(m.label)}</small>
            <input class="bal-cell-input${apertura.origen === 'cierre_anterior' && apTipeada[m.k] == null ? ' is-auto' : ''}" type="text" inputmode="decimal" data-apertura="${m.k}"
              value="${apTipeada[m.k] == null ? '' : fmt(apTipeada[m.k])}"
              placeholder="${apertura.origen === 'cierre_anterior' ? fmt(apertura[m.k]) : '0,00'}"></label>`).join('')}
        </span>
        ${apertura.origen === 'cierre_anterior'
          ? `<small class="bal-apertura-hint">Sigue del cierre del mes anterior (${money(apertura.efectivo)} · ${money(apertura.mp)} · ${money(apertura.lapos)}). Tipeá un número solo si contaste la plata.</small>`
          : apertura.origen === 'ninguna'
            ? `<small class="bal-apertura-hint">Sin apertura: el acumulado arranca de cero. Cargá con cuánto empezó el mes.</small>`
            : ''}
      </div>
    </div>`;

  bindDia(body, dia);
  // Precarga las sugerencias de meses anteriores (el autocomplete lee la lista
  // en vivo en cada tecla, así que aparecen apenas termina esta carga).
  cargarAggDias().catch(() => {});
}

function patchDiaTotales(body, dia) {
  const t = diaTotales(dia);
  const qi = body.querySelector('[data-tot="ing"]'); if (qi) qi.textContent = money(t.ing.total);
  const qc = body.querySelector('[data-tot="com"]'); if (qc) qc.textContent = money(t.com.total);
  const stats = body.querySelectorAll('.bal-dia-stat b');
  if (stats[0]) stats[0].textContent = money(t.ing.total);
  if (stats[1]) stats[1].textContent = money(t.com.total);
  if (stats[2]) { stats[2].textContent = money(t.saldo); stats[2].className = negCls(t.saldo).trim(); }
  updateMedios(body, dia);
}

// Recalcula el bloque "Cierre del día por medio de pago" (ingresos/compras/saldo/
// acumulado por medio) sin re-renderizar todo el día — mantiene el foco al editar.
function updateMedios(body, dia) {
  if (!curDiasDoc || !dia) return;
  // Derivar el día del propio 'dia' (no del global curDiaDD, que puede haber
  // cambiado por navegación mientras un change quedaba pendiente).
  const ym = dia.fecha ? dia.fecha.slice(0, 7) : curDiaYm;
  const dd = dia.fecha ? dia.fecha.slice(8, 10) : curDiaDD;
  if (curDiasDoc.ym !== ym) return;   // navegación en curso: el reload renderiza
  const dias = curDiasDoc.dias || {};
  const apertura = aperturaEfectiva(ym, curDiasDoc);
  const work = Object.assign({}, dias, { [dd]: dia });
  const pm = diaPorMedio(dia);
  const accum = acumuladoHasta(work, apertura, dd);
  const set = (sel, val, neg) => {
    const el = body.querySelector(sel);
    if (!el) return;
    el.textContent = money(val);
    if (neg !== undefined) el.classList.toggle('bal-neg', Number(neg) < 0);
  };
  MEDIOS.forEach(m => {
    const i = pm.ing[m.k] || 0, c = pm.com[m.k] || 0, sd = i - c, ac = accum[m.k] || 0;
    set(`[data-med-ing="${m.k}"]`, i);
    set(`[data-med-com="${m.k}"]`, c);
    set(`[data-med-saldo="${m.k}"]`, sd, sd);
    set(`[data-med-acum="${m.k}"]`, ac, ac);
  });
  const ti = pm.ing.efectivo + pm.ing.mp + pm.ing.lapos + pm.ing.sin;
  const tc = pm.com.efectivo + pm.com.mp + pm.com.lapos + pm.com.sin;
  const ta = accum.efectivo + accum.mp + accum.lapos + accum.sin;
  set('[data-med-ing="total"]', ti);
  set('[data-med-com="total"]', tc);
  set('[data-med-saldo="total"]', ti - tc, ti - tc);
  set('[data-med-acum="total"]', ta, ta);
}

function bindDia(body, dia) {
  const reload = () => renderDia(body);
  // Capturamos las coordenadas del bind para que save() sea consistente con 'dia'
  // aunque cambien los globales, y manejamos el error como el resto del módulo.
  const ymAtBind = curDiaYm, ddAtBind = curDiaDD;
  const save = () => {
    if (curDiasDoc && curDiasDoc.ym === ymAtBind) { curDiasDoc.dias = curDiasDoc.dias || {}; curDiasDoc.dias[ddAtBind] = dia; }
    // Estado pagado/pendiente de los vencimientos en el calendario (en memoria).
    setPagosMesFromDias(ymAtBind, Object.assign({}, (curDiasDoc && curDiasDoc.dias) || {}, { [ddAtBind]: dia }));
    return saveDiasMes(db, ymAtBind, { dias: { [ddAtBind]: dia } })
      .then(() => recordDias(ymAtBind, `Día ${ddAtBind} · ${mesLabel(ymAtBind)}`, ddAtBind))
      // La caja de arriba sigue al día: cada movimiento guardado la mueve.
      .then(() => recalcularCadena().then(refreshCajaBand).catch(() => {}))
      .catch(err => {
        console.error('[balance] error guardando día', err);
        alertDialog({ title: 'No se pudo guardar', message: 'Revisá la conexión e intentá de nuevo.', type: 'error' });
      });
  };

  body.querySelector('.bal-dia-date')?.addEventListener('change', e => {
    const v = e.target.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    curDiaYm = v.slice(0, 7); curDiaDD = v.slice(8, 10); reload();
  });
  body.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
    const iso = shiftFecha(`${curDiaYm}-${curDiaDD}`, Number(b.dataset.nav));
    curDiaYm = iso.slice(0, 7); curDiaDD = iso.slice(8, 10); reload();
  }));
  body.querySelector('[data-hoy]')?.addEventListener('click', () => {
    const t = hoyAR(); curDiaYm = t.slice(0, 7); curDiaDD = t.slice(8, 10); reload();
  });
  body.querySelectorAll('[data-strip]').forEach(b => b.addEventListener('click', () => {
    curDiaDD = b.dataset.strip; reload();
  }));

  // Reconstruye una lista (ingresos|compras) en el lugar tras un borrado, re-
  // indexando data-i. Evita el re-render del día entero (que se sentía como recarga).
  const rebuildMovList = (tipo) => {
    const list = body.querySelector(tipo === 'ingresos' ? '#bal-ing-list' : '#bal-com-list');
    if (!list) return;
    const rows = dia[tipo] || [];
    list.innerHTML = rows.length
      ? rows.map((x, i) => movRowHtml(x, i, tipo)).join('')
      : `<div class="bal-mov-empty">${tipo === 'ingresos' ? 'Sin ingresos cargados' : 'Sin compras/gastos cargados'}</div>`;
    list.querySelectorAll('.bal-mov-row').forEach(bindMovRow);
  };

  const bindMovRow = (row) => {
    const tipo = row.dataset.mov;            // 'ingresos' | 'compras'
    const i = Number(row.dataset.i);
    const item = (dia[tipo] || [])[i];
    if (!item) return;
    row.querySelectorAll('[data-f]').forEach(inp => {
      const f = inp.dataset.f;
      if (inp.tagName === 'INPUT' && f === 'monto') inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('change', () => {
        if (f === 'monto') { item.monto = parseNum(inp.value) || 0; inp.value = fmt(item.monto); }
        else if (f === 'medio') {
          // 'mp:NOMBRE' = Mercado Pago de una cuenta en particular.
          if (inp.value.startsWith('mp:')) { item.medio = 'mp'; item.cuenta = inp.value.slice(3); }
          else { item.medio = inp.value || null; delete item.cuenta; }
        }
        else item[f] = inp.value.trim();
        patchDiaTotales(body, dia);
        if (tipo === 'compras') refreshFdiaPanel();
        save();
      });
    });
    row.querySelector('[data-del]')?.addEventListener('click', () => {
      dia[tipo].splice(i, 1);
      rebuildMovList(tipo);
      patchDiaTotales(body, dia);
      if (tipo === 'compras') refreshFdiaPanel();
      save();
    });
    // Autocomplete propio en compras: proveedor y rubro sugieren lo ya usado.
    if (tipo === 'compras') {
      const provInp = row.querySelector('[data-f="proveedor"]');
      if (provInp) attachAutocomplete(provInp, provSugeridos);
      const rubInp = row.querySelector('[data-f="rubro"]');
      if (rubInp) attachAutocomplete(rubInp, rubroSugeridos);
    }
  };

  body.querySelectorAll('.bal-mov-row').forEach(bindMovRow);

  // Agregar fila: se inserta y enfoca al instante; el guardado va en segundo plano.
  // Nada de re-render del día (antes hacía await save() + reload(), que parpadeaba).
  body.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
    const tipo = b.dataset.add;
    if (!dia[tipo]) dia[tipo] = [];
    const item = tipo === 'ingresos'
      ? { motivo: '', medio: 'efectivo', monto: 0 }
      : { proveedor: '', rubro: '', medio: 'efectivo', monto: 0 };
    dia[tipo].push(item);
    const list = body.querySelector(tipo === 'ingresos' ? '#bal-ing-list' : '#bal-com-list');
    if (!list) return;
    list.querySelector('.bal-mov-empty')?.remove();
    list.insertAdjacentHTML('beforeend', movRowHtml(item, dia[tipo].length - 1, tipo));
    const newRow = list.lastElementChild;
    bindMovRow(newRow);
    newRow.querySelector('input')?.focus();
    save();
  }));

  body.querySelector('[data-autofill-dia]')?.addEventListener('click', () => autofillDia(dia, body));

  body.querySelector('[data-cerrar]')?.addEventListener('click', async () => {
    const iso = `${ymAtBind}-${ddAtBind}`;
    const eff = (dia.cerrado === true || dia.cerrado === false) ? dia.cerrado : (iso < hoyAR());
    dia.cerrado = !eff;
    await save();
    if (dia.cerrado) {
      const next = shiftFecha(iso, 1);
      curDiaYm = next.slice(0, 7); curDiaDD = next.slice(8, 10);
    }
    reload();
  });

  // Saldo inicial del mes (apertura): base del saldo acumulado. Se guarda en el
  // doc del mes; al cambiar, recalcula el acumulado en vivo sin re-render.
  body.querySelectorAll('[data-apertura]').forEach(inp => {
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('change', () => {
      const medio = inp.dataset.apertura;
      const v = parseNum(inp.value);
      if (!curDiasDoc.apertura) curDiasDoc.apertura = {};
      curDiasDoc.apertura[medio] = v;
      inp.value = v == null ? '' : fmt(v);
      updateMedios(body, dia);
      // Vacío ⇒ deleteField (el merge de Firestore ignora null y dejaría el viejo).
      saveDiasMes(db, ymAtBind, { apertura: { [medio]: v == null ? deleteField() : v } })
        .then(() => recalcularCadena().then(refreshCajaBand).catch(() => {}))
        .catch(err => { console.error('[balance] error guardando apertura', err); });
    });
  });

  // Fijar cierre del mes: usa el saldo acumulado (todos los días) como saldo de
  // cierre del mes en el Resumen — igual que el último "SALDO DIARIO ACUMULADO".
  body.querySelector('[data-fijar-cierre]')?.addEventListener('click', async () => {
    const dias = curDiasDoc.dias || {};
    const apertura = aperturaEfectiva(ymAtBind, curDiasDoc);
    const work = Object.assign({}, dias, { [curDiaDD]: dia });
    const close = acumuladoHasta(work, apertura, '31');
    const r2 = v => Math.round(v * 100) / 100;
    close.efectivo = r2(close.efectivo); close.mp = r2(close.mp); close.lapos = r2(close.lapos);
    const ok = await confirmDialog({
      title: 'Fijar cierre del mes',
      message: `Se usará el saldo acumulado como saldo de cierre de <b>${esc(mesLabel(ymAtBind))}</b> en el Resumen:<br>` +
        `Efectivo ${money(close.efectivo)} · Mercado Pago ${money(close.mp)} · Lapos ${money(close.lapos)}.<br><br>` +
        `Reemplaza los saldos cargados de ese mes. ¿Continuar?`,
      confirmText: 'Fijar cierre',
    });
    if (!ok) return;
    const mes = ensureMes(ymAtBind);
    mes.saldos = close;
    if (mes.origen === 'excel') mes.origen = 'manual';
    refreshCajaBand();
    await persistMes(ymAtBind, { saldos: close, origen: mes.origen });
    alertDialog({ title: 'Cierre fijado', message: `El saldo de cierre de ${esc(mesLabel(ymAtBind))} se guardó en el Resumen.`, type: 'success' });
  });

  // ── Panel "Gastos fijos del mes" ──
  // Carga el pago de un fijo como compra/gasto del día visible (importe de
  // referencia, medio de su fuente). Se usa desde el panel y desde el bloque de
  // pagos programados. Todo en el lugar, sin re-render del día.
  function pagarFijoEnDia(f) {
    if (!dia.compras) dia.compras = [];
    dia.compras.push({ proveedor: f.label || 'Gasto fijo', rubro: RUBRO_FIJO, medio: fuenteValida(f.fuente), monto: Number(f.monto) || 0, fijo_id: f.id });
    rebuildMovList('compras');
    patchDiaTotales(body, dia);
    refreshFdiaPanel();
    save();
  }

  // Bloque "pagos programados" dentro de la card de compras: re-render + rebind.
  function refreshProg() {
    const box = body.querySelector('#bal-com-prog');
    if (!box) return;
    const work = Object.assign({}, (curDiasDoc && curDiasDoc.dias) || {}, { [ddAtBind]: dia });
    box.innerHTML = progRowsHtml(work, ymAtBind, ddAtBind, `${ymAtBind}-${ddAtBind}` === hoyAR());
    bindProg();
  }
  function bindProg() {
    body.querySelectorAll('[data-prog-pagar]').forEach(b => b.addEventListener('click', () => {
      const f = (cfg.montosFijos || []).find(x => x.id === b.dataset.progPagar);
      if (f) pagarFijoEnDia(f);
    }));
  }

  // Re-render del panel en el lugar (tras editar/borrar un pago en compras).
  // También refresca los programados: ambos derivan del mismo estado de pagos.
  function refreshFdiaPanel() {
    const p = body.querySelector('#bal-fdia');
    if (p) {
      const work = Object.assign({}, (curDiasDoc && curDiasDoc.dias) || {}, { [ddAtBind]: dia });
      p.outerHTML = fijosPanelHtml(work, `${ymAtBind}-${ddAtBind}` === hoyAR());
      bindFdiaPanel();
    }
    refreshProg();
  }
  function bindFdiaPanel() {
    const fPanel = body.querySelector('#bal-fdia');
    if (!fPanel) return;
    const refreshFdiaTots = () => {
      if (curDiaYm !== ymAtBind) return;
      const el = fPanel.querySelector('.bal-fdia-tots');
      if (!el) return;
      const work = Object.assign({}, (curDiasDoc && curDiasDoc.dias) || {}, { [ddAtBind]: dia });
      el.innerHTML = fdiaTotsHtml(work);
    };
    // Ir al día donde se registró un pago
    fPanel.querySelectorAll('[data-fdia-go]').forEach(b => b.addEventListener('click', () => {
      curDiaDD = b.dataset.fdiaGo; reload();
    }));
    // Pagar: entra como compra/gasto del día visible con el importe de referencia.
    // Todo en el lugar (lista de compras + totales + panel), sin re-render del día.
    fPanel.querySelectorAll('[data-fdia-pagar]').forEach(b => b.addEventListener('click', () => {
      const f = (cfg.montosFijos || []).find(x => x.id === b.dataset.fdiaPagar);
      if (f) pagarFijoEnDia(f);
    }));
    // Editar la referencia (motivo / importe / fuente) en el lugar
    fPanel.querySelectorAll('[data-fdia-f]').forEach(inp => {
      const row = inp.closest('.bal-fdia-row');
      const f = (cfg.montosFijos || []).find(x => x.id === row?.dataset.fdiaId);
      if (!f) return;
      if (inp.dataset.fdiaF === 'monto') inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('change', () => {
        const campo = inp.dataset.fdiaF;
        if (campo === 'monto') { f.monto = parseNum(inp.value) || 0; inp.value = fmt(f.monto); refreshFdiaTots(); }
        else if (campo === 'fuente') f.fuente = inp.value;
        else f.label = inp.value.trim();
        persistFijos();
      });
    });
    // Fecha de vencimiento: popover con grilla de días (1–31).
    fPanel.querySelectorAll('[data-fdia-vence]').forEach(b => b.addEventListener('click', () => {
      const f = (cfg.montosFijos || []).find(x => x.id === b.dataset.fdiaVence);
      if (!f) return;
      abrirVencePicker(b, f, (d) => {
        f.venceDia = d;
        persistFijos();
        refreshFdiaPanel();   // repinta botón, pill de estado y programados del día
      });
    }));
    // Agregar fijo nuevo (fila en el lugar, foco en el motivo)
    fPanel.querySelector('[data-fdia-add]')?.addEventListener('click', () => {
      if (!cfg.montosFijos) cfg.montosFijos = [];
      const id = 'fijo_' + ((typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      cfg.montosFijos.push({ id, label: '', fuente: 'efectivo', monto: 0, activo: true });
      persistFijos();
      refreshFdiaPanel();
      body.querySelector(`.bal-fdia-row[data-fdia-id="${CSS.escape(id)}"] [data-fdia-f="label"]`)?.focus();
    });
    // Quitar de la lista desde este mes (histórico y pagos cargados se conservan)
    fPanel.querySelectorAll('[data-fdia-del]').forEach(b => b.addEventListener('click', async () => {
      const f = (cfg.montosFijos || []).find(x => x.id === b.dataset.fdiaDel);
      if (!f) return;
      const ok = await confirmDialog({
        title: 'Quitar gasto fijo',
        message: `¿Quitar <b>${esc(f.label || 'sin nombre')}</b> de la lista desde ${esc(mesLabel(ymAtBind))}? Los meses anteriores y los pagos ya cargados se conservan.`,
        confirmText: 'Quitar', danger: true,
      });
      if (!ok) return;
      if (f.label || Number(f.monto)) {
        f.desactivadoDesde = ymAtBind;   // baja hacia adelante, conserva histórico
      } else {
        const i = cfg.montosFijos.indexOf(f);   // fila vacía recién creada → fuera
        if (i >= 0) cfg.montosFijos.splice(i, 1);
      }
      await persistFijos();
      refreshFdiaPanel();
    }));
  }
  bindFdiaPanel();
  bindProg();
}

async function autofillDia(dia, body) {
  const ventas = await getCached('dashboard:ventas', async () => {
    const snap = await getDocs(query(collection(db, 'ventas'), orderBy('created_at', 'desc'), limit(5000)));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }, { ttl: 60 * 1000 });
  const iso = `${curDiaYm}-${curDiaDD}`;
  const acc = { efectivo: 0, mp: 0, lapos: 0, count: 0 };
  ventas.forEach(v => {
    if (v.deleted === true || isVentaVarios2(v)) return;
    const f = parseArDate(v.created_at);
    if (f.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }) !== iso) return;
    const monto = v.total_amount || 0; acc.count++;
    if (v.payment_type === 'cash') acc.efectivo += monto;
    else { const c = v.transfer_account || v.cuenta_id || 'cuenta1'; if (c === 'cuenta2') acc.lapos += monto; else acc.mp += monto; }
  });
  if (!acc.count) {
    return alertDialog({ title: 'Sin ventas', message: `No hay ventas registradas el ${fechaLarga(iso)}.`, type: 'warning' });
  }
  const r2 = n => Math.round(n * 100) / 100;
  const pos = { efectivo: r2(acc.efectivo), mp: r2(acc.mp), lapos: r2(acc.lapos) };

  const res = await autofillPreview(iso, acc.count, pos, dia.ingresos || []);
  if (!res) return;
  dia.ingresos = dia.ingresos || [];
  res.asignar.forEach(({ i, monto }) => { if (dia.ingresos[i]) dia.ingresos[i].monto = monto; });
  res.nuevos.forEach(o => dia.ingresos.push(o));
  if (curDiasDoc && curDiasDoc.ym === curDiaYm) { curDiasDoc.dias = curDiasDoc.dias || {}; curDiasDoc.dias[curDiaDD] = dia; }
  await saveDiasMes(db, curDiaYm, { dias: { [curDiaDD]: dia } });
  recordDias(curDiaYm, `Autocompletar · ${mesLabel(curDiaYm)}`, curDiaDD);
  renderDia(body);
}

// Modal de vista previa del autocompletar: reparte cada medio entre las filas
// existentes del día (ej. el total de MP entre MP JOSE y MP AGUSTIN) con "resta"
// por medio en vivo, y permite agregar filas para medios sin cuenta. Devuelve
// { asignar:[{i,monto}], nuevos:[{motivo,medio,monto}] } o null si se cancela.
function autofillPreview(iso, count, pos, rows) {
  return new Promise(resolve => {
    const r2 = n => Math.round(n * 100) / 100;
    const lbl = k => MEDIOS.find(m => m.k === k)?.label || k || '—';
    // Prefill: a la primera fila de cada medio se le asigna el total POS de ese medio.
    const firstByMedio = {};
    const items = rows.map((x, i) => {
      const medio = x.medio || null;
      let prefill = 0, on = false;
      if (medio && pos[medio] > 0 && firstByMedio[medio] === undefined) {
        prefill = pos[medio]; on = true; firstByMedio[medio] = i;
      }
      return { i, motivo: x.motivo || '(sin nombre)', medio, prefill, on, nuevo: false };
    });
    ['efectivo', 'mp', 'lapos'].forEach(m => {
      if (pos[m] > 0 && firstByMedio[m] === undefined) {
        items.push({ i: null, motivo: 'Ventas ' + lbl(m), medio: m, prefill: pos[m], on: true, nuevo: true });
      }
    });

    document.querySelector('.app-dialog-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay app-dialog-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:540px">
        <div class="modal-header" style="border-bottom:none;padding-bottom:6px">
          <h3 style="display:flex;align-items:center;gap:10px;margin:0;font-size:16px">
            <span class="material-icons" style="color:var(--bal-green);font-size:26px">auto_awesome</span>
            Autocompletar de ventas
          </h3>
        </div>
        <div class="modal-body" style="padding:4px 24px 14px">
          <div style="color:var(--text-muted);font-size:13px;margin-bottom:10px">
            Ventas del ${esc(fechaLarga(iso))} (${count}). Repartí cada medio entre tus cuentas (ej. MP JOSE / MP AGUSTIN). La "resta" muestra lo que falta asignar.
          </div>
          <div class="bal-pv-chips">
            ${['efectivo', 'mp', 'lapos'].filter(m => pos[m] > 0).map(m => `
              <span class="bal-pv-chip">${esc(lbl(m))}: <b>${money(pos[m])}</b> · resta <b data-resta="${m}">$ 0,00</b></span>`).join('')}
          </div>
          <div class="bal-pv-list">
            ${items.map((it, k) => `
              <label class="bal-pv-row${it.nuevo ? ' is-nuevo' : ''}">
                <input type="checkbox" data-pv="${k}" ${it.on ? 'checked' : ''}>
                <span class="bal-pv-lbl">${esc(it.motivo)}<small>${esc(lbl(it.medio))}${it.nuevo ? ' · nueva fila' : ''}</small></span>
                <input type="text" inputmode="decimal" data-pvm="${k}" class="bal-pv-monto" value="${fmt(it.prefill)}">
              </label>`).join('')}
          </div>
        </div>
        <div class="app-dialog-footer" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:14px 20px;border-top:1px solid var(--border);background:var(--surface-2)">
          <span class="bal-pv-total">Total: <b data-pv-total></b></span>
          <span style="display:flex;gap:8px">
            <button class="ad-cancel" style="padding:10px 18px;border-radius:8px;border:1px solid var(--border);background:var(--surface);cursor:pointer;font-size:13px;font-weight:600;color:var(--text-muted)">Cancelar</button>
            <button class="ad-ok" style="padding:10px 18px;border-radius:8px;border:none;background:var(--bal-green);color:#fff;cursor:pointer;font-size:13px;font-weight:700">Aplicar</button>
          </span>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const leer = () => items.map((it, k) => {
      const chk = overlay.querySelector(`[data-pv="${k}"]`).checked;
      const monto = parseNum(overlay.querySelector(`[data-pvm="${k}"]`).value) || 0;
      return { ...it, chk, monto };
    });
    const recompute = () => {
      const cur = leer();
      ['efectivo', 'mp', 'lapos'].forEach(m => {
        if (!(pos[m] > 0)) return;
        const asign = cur.filter(c => c.chk && c.medio === m).reduce((s, c) => s + c.monto, 0);
        const el = overlay.querySelector(`[data-resta="${m}"]`);
        if (el) {
          const resta = r2(pos[m] - asign);
          el.textContent = money(resta);
          el.style.color = Math.abs(resta) < 0.5 ? 'var(--tint-green-fg)' : (resta < 0 ? 'var(--tint-red-fg)' : 'var(--tint-orange-fg)');
        }
      });
      const tot = cur.filter(c => c.chk).reduce((s, c) => s + c.monto, 0);
      const t = overlay.querySelector('[data-pv-total]'); if (t) t.textContent = money(tot);
    };
    recompute();
    overlay.querySelectorAll('[data-pv], [data-pvm]').forEach(el => {
      el.addEventListener('input', recompute);
      el.addEventListener('change', recompute);
    });
    overlay.querySelectorAll('.bal-pv-monto').forEach(inp => inp.addEventListener('focus', () => inp.select()));

    const cleanup = (val) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); cleanup(null); } };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.ad-cancel').addEventListener('click', () => cleanup(null));
    overlay.querySelector('.ad-ok').addEventListener('click', () => {
      const cur = leer().filter(c => c.chk && c.monto > 0);
      cleanup({
        asignar: cur.filter(c => !c.nuevo).map(c => ({ i: c.i, monto: c.monto })),
        nuevos: cur.filter(c => c.nuevo).map(c => ({ motivo: c.motivo, medio: c.medio, monto: c.monto })),
      });
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(null); });
  });
}

// Agrega el detalle diario de un mes por proveedor y por persona (sueldos).
function agregadosDelMes(diasDoc) {
  const dias = (diasDoc && diasDoc.dias) || {};
  const porProveedor = {}, sueldos = {};
  for (const dd in dias) {
    for (const c of (dias[dd].compras || [])) {
      const prov = (c.proveedor || '').trim();
      const monto = Number(c.monto) || 0;
      if (!prov || !monto) continue;
      porProveedor[prov] = (porProveedor[prov] || 0) + monto;
      if ((c.rubro || '').trim().toUpperCase() === 'SUELDOS') sueldos[prov] = (sueldos[prov] || 0) + monto;
    }
  }
  return { porProveedor, sueldos };
}

// Detalle de un rubro/agregado: abre un modal con los movimientos diarios que lo
// componen (filtrable por mes y por proveedor), con click para saltar al día.
function openRubroDetalle(rubro, ym0) { return openDetalle('rubro', rubro, ym0); }
function openProveedorDetalle(prov, ym0) { return openDetalle('proveedor', prov, ym0); }

// Modal de detalle genérico: por RUBRO o por PROVEEDOR. Filtra por mes/medio/texto,
// agrupa (la otra dimensión o por mes) en grupos colapsables con subtotal, y cada
// movimiento salta al día. ym0 opcional preselecciona un mes.
async function openDetalle(modo, key, ym0) {
  const isRubro = modo === 'rubro';
  const keyU = (key || '').trim().toUpperCase();
  const matchC = (c) => isRubro
    ? (c.rubro || '').trim().toUpperCase() === keyU
    : (c.proveedor || '').trim().toUpperCase() === keyU;
  const grpOpts = isRubro
    ? [{ k: 'prov', t: 'Por proveedor' }, { k: 'mes', t: 'Por mes' }]
    : [{ k: 'rubro', t: 'Por rubro' }, { k: 'mes', t: 'Por mes' }];
  let group = grpOpts[0].k;
  const grpKeyOf = (h) => group === 'mes' ? h.ym : (group === 'prov' ? (h.c.proveedor || '(sin nombre)') : (h.c.rubro || '(sin rubro)'));
  const descOf = (h) => group === 'mes'
    ? esc(isRubro ? (h.c.proveedor || '(sin nombre)') : (h.c.rubro || '(sin rubro)'))
    : esc(MEDIOS.find(m => m.k === h.c.medio)?.label || '');

  document.querySelector('.app-dialog-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay app-dialog-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:640px">
      <div class="modal-header" style="border-bottom:none;padding-bottom:6px">
        <h3 style="display:flex;align-items:center;gap:10px;margin:0;font-size:16px">
          <span class="material-icons" style="color:var(--bal-green);font-size:26px">${isRubro ? 'receipt_long' : 'local_shipping'}</span>
          ${esc(key)} — detalle
        </h3>
      </div>
      <div class="modal-body" style="padding:4px 24px 12px">
        <div class="bal-rd-filtros">
          <select id="rd-ym">
            <option value="__all__">Todos los meses</option>
            ${mesesOrdenados('desc').map(ym => `<option value="${ym}" ${ym === ym0 ? 'selected' : ''}>${esc(mesLabel(ym))}</option>`).join('')}
          </select>
          <select id="rd-medio">
            <option value="">Todos los medios</option>
            ${MEDIOS.map(m => `<option value="${m.k}">${esc(m.label)}</option>`).join('')}
          </select>
          <input id="rd-q" class="bal-q" placeholder="Filtrar ${isRubro ? 'proveedor' : 'rubro'}…">
          <div class="bal-seg bal-rd-seg">
            ${grpOpts.map((o, i) => `<button type="button" class="bal-seg-btn${i === 0 ? ' active' : ''}" data-grp="${o.k}">${o.t}</button>`).join('')}
          </div>
        </div>
        <div id="rd-res" style="max-height:50vh;overflow:auto;margin-top:10px"></div>
      </div>
      <div class="app-dialog-footer" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:14px 20px;border-top:1px solid var(--border);background:var(--surface-2)">
        <span class="bal-pv-total">Total: <b id="rd-tot">$ 0,00</b></span>
        <button class="ad-cancel" style="padding:10px 18px;border-radius:8px;border:1px solid var(--border);background:var(--surface);cursor:pointer;font-size:13px;font-weight:600;color:var(--text-muted)">Cerrar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const run = async () => {
    const ym = overlay.querySelector('#rd-ym').value;
    const medio = overlay.querySelector('#rd-medio').value;
    const q = overlay.querySelector('#rd-q').value.trim().toLowerCase();
    const res = overlay.querySelector('#rd-res');
    res.innerHTML = `<div class="ct-loading"><div class="spinner" style="width:22px;height:22px;border-width:3px"></div></div>`;
    const meses = ym === '__all__' ? mesesOrdenados('desc') : [ym];
    const hits = [];
    for (const m of meses) {
      const docM = await loadDiasMes(db, m);
      const dias = (docM && docM.dias) || {};
      for (const dd of Object.keys(dias).sort().reverse()) {
        for (const c of (dias[dd].compras || [])) {
          if (!matchC(c)) continue;
          if (medio && (c.medio || '') !== medio) continue;
          const campo = isRubro ? (c.proveedor || '') : (c.rubro || '');
          if (q && !campo.toLowerCase().includes(q)) continue;
          hits.push({ ym: m, dd, fecha: dias[dd].fecha || `${m}-${dd}`, c });
        }
      }
    }
    const tot = hits.reduce((s, h) => s + (Number(h.c.monto) || 0), 0);
    overlay.querySelector('#rd-tot').textContent = money(tot);
    if (!hits.length) { res.innerHTML = '<div class="bal-mov-empty">Sin movimientos.</div>'; return; }

    const map = {};
    hits.forEach(h => { const k = grpKeyOf(h); (map[k] = map[k] || []).push(h); });
    let grupos = Object.entries(map).map(([k, arr]) => ({ k, arr, tot: arr.reduce((s, h) => s + (Number(h.c.monto) || 0), 0) }));
    grupos = group === 'mes' ? grupos.sort((a, b) => b.k.localeCompare(a.k)) : grupos.sort((a, b) => b.tot - a.tot);
    const unidad = group === 'mes' ? 'mes(es)' : (group === 'prov' ? 'proveedor(es)' : 'rubro(s)');
    const soloUno = grupos.length === 1;

    res.innerHTML = `<div class="bal-buscar-tot">${hits.length} movimiento(s) en ${grupos.length} ${unidad} · tocá para desplegar</div>` +
      grupos.map(g => `
        <div class="bal-grp${soloUno ? ' open' : ''}">
          <button type="button" class="bal-grp-head" data-grp-toggle>
            <span class="material-icons bal-grp-chev">chevron_right</span>
            <span class="bal-grp-name">${group === 'mes' ? esc(mesLabel(g.k)) : esc(g.k)}</span>
            <span class="bal-grp-count">${g.arr.length}</span>
            <b class="bal-grp-tot">${money(g.tot)}</b>
          </button>
          <div class="bal-grp-body">
            ${g.arr.map(h => `
              <button type="button" class="bal-grp-row" data-ym="${h.ym}" data-dd="${h.dd}">
                <span class="bal-buscar-fecha">${esc(fechaLarga(h.fecha))}</span>
                <span class="bal-buscar-desc">${descOf(h)}</span>
                <span class="bal-buscar-monto is-com">−${money(Number(h.c.monto) || 0)}</span>
              </button>`).join('')}
          </div>
        </div>`).join('');
    res.onclick = (e) => {
      const head = e.target.closest('[data-grp-toggle]');
      if (head) { head.parentElement.classList.toggle('open'); return; }
      const rowb = e.target.closest('.bal-grp-row');
      if (rowb) {
        curDiaYm = rowb.dataset.ym; curDiaDD = rowb.dataset.dd;
        view = 'dia'; localStorage.setItem('bal:view', view);
        cleanup(); render();
      }
    };
  };

  const cleanup = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); cleanup(); } };
  document.addEventListener('keydown', onKey);
  overlay.querySelector('#rd-ym').addEventListener('change', run);
  overlay.querySelector('#rd-medio').addEventListener('change', run);
  overlay.querySelector('#rd-q').addEventListener('input', run);
  overlay.querySelectorAll('[data-grp]').forEach(b => b.addEventListener('click', () => {
    group = b.dataset.grp;
    overlay.querySelectorAll('[data-grp]').forEach(x => x.classList.toggle('active', x.dataset.grp === group));
    run();
  }));
  overlay.querySelector('.ad-cancel').addEventListener('click', cleanup);
  overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });
  run();
}

// ── Sub-vista: BUSCAR (movimientos por proveedor / rubro / motivo / monto) ─────
let buscarState = { q: '', tipo: 'todos', ym: '__all__' };

async function renderBuscar(body) {
  body.innerHTML = `
    <div class="bal-caption"><span class="material-icons">search</span>
      Buscá movimientos por proveedor, rubro, motivo o monto. Tocá un resultado para abrir ese día.</div>
    <div class="bal-buscar-bar">
      <input type="text" id="bal-q" class="bal-q" placeholder="Ej: Mercecor, Papelera, 50000…" value="${esc(buscarState.q)}">
      <select id="bal-tipo">
        <option value="todos" ${buscarState.tipo === 'todos' ? 'selected' : ''}>Todo</option>
        <option value="compras" ${buscarState.tipo === 'compras' ? 'selected' : ''}>Compras/Gastos</option>
        <option value="ingresos" ${buscarState.tipo === 'ingresos' ? 'selected' : ''}>Ingresos</option>
      </select>
      <select id="bal-ym">
        <option value="__all__" ${buscarState.ym === '__all__' ? 'selected' : ''}>Todos los meses</option>
        ${mesesOrdenados('desc').map(ym => `<option value="${ym}" ${buscarState.ym === ym ? 'selected' : ''}>${esc(mesLabel(ym))}</option>`).join('')}
      </select>
      <button class="bal-btn" id="bal-go"><span class="material-icons">search</span> Buscar</button>
    </div>
    <div id="bal-res"></div>`;

  const run = async () => {
    buscarState.q = body.querySelector('#bal-q').value.trim();
    buscarState.tipo = body.querySelector('#bal-tipo').value;
    buscarState.ym = body.querySelector('#bal-ym').value;
    const res = body.querySelector('#bal-res');
    const q = buscarState.q.toLowerCase();
    if (!q) { res.innerHTML = '<div class="bal-mov-empty">Escribí algo para buscar.</div>'; return; }
    res.innerHTML = `<div class="ct-loading"><div class="spinner" style="width:22px;height:22px;border-width:3px"></div></div>`;
    const meses = buscarState.ym === '__all__' ? mesesOrdenados('desc') : [buscarState.ym];
    // Solo matchear por monto si la consulta es esencialmente numérica (evita
    // falsos positivos como "ruta 2" matcheando montos de $2).
    const qnum = /^[\d.,\s$\-]+$/.test(q) ? parseNum(q) : null;
    const hits = [];
    for (const ym of meses) {
      const docM = await loadDiasMes(db, ym);
      const dias = (docM && docM.dias) || {};
      for (const dd of Object.keys(dias).sort().reverse()) {
        const dia = dias[dd];
        const push = (tipo, x) => {
          const txt = `${x.motivo || x.proveedor || ''} ${x.rubro || ''}`.toLowerCase();
          const m = Number(x.monto) || 0;
          if (txt.includes(q) || (qnum != null && Math.abs(m - qnum) < 0.5)) {
            hits.push({ ym, dd, fecha: dia.fecha || `${ym}-${dd}`, tipo, x });
          }
        };
        if (buscarState.tipo !== 'ingresos') (dia.compras || []).forEach(x => push('compra', x));
        if (buscarState.tipo !== 'compras') (dia.ingresos || []).forEach(x => push('ingreso', x));
        if (hits.length >= 300) break;
      }
      if (hits.length >= 300) break;
    }
    if (!hits.length) { res.innerHTML = '<div class="bal-mov-empty">Sin resultados.</div>'; return; }
    const shown = hits.slice(0, 300);
    const total = shown.reduce((s, h) => s + (Number(h.x.monto) || 0), 0);
    res.innerHTML = `
      <div class="bal-buscar-tot">${shown.length} resultado(s) · total <b>${money(total)}</b></div>
      <div class="bal-buscar-list">
        ${shown.map(h => `
          <button class="bal-buscar-row" data-ym="${h.ym}" data-dd="${h.dd}">
            <span class="bal-buscar-fecha">${esc(fechaLarga(h.fecha))}</span>
            <span class="bal-buscar-desc">${esc(h.x.proveedor || h.x.motivo || '')}${h.x.rubro ? ` <small>${esc(h.x.rubro)}</small>` : ''}</span>
            <span class="bal-buscar-medio">${esc(MEDIOS.find(m => m.k === h.x.medio)?.label || '')}</span>
            <span class="bal-buscar-monto ${h.tipo === 'compra' ? 'is-com' : 'is-ing'}">${h.tipo === 'compra' ? '−' : '+'}${money(Number(h.x.monto) || 0)}</span>
          </button>`).join('')}
      </div>
      ${hits.length > shown.length ? '<div class="bal-mov-empty">Hay más coincidencias; afiná la búsqueda o filtrá por mes.</div>' : ''}`;
    res.querySelectorAll('.bal-buscar-row').forEach(b => b.addEventListener('click', () => {
      curDiaYm = b.dataset.ym; curDiaDD = b.dataset.dd;
      view = 'dia'; localStorage.setItem('bal:view', view);
      render();
    }));
  };

  body.querySelector('#bal-go').addEventListener('click', run);
  body.querySelector('#bal-q').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  if (buscarState.q) run();
}

// ── Autocompletar saldos desde ventas reales ──────────────────────────────────
async function autofillMes(ym) {
  const ventas = await getCached('dashboard:ventas', async () => {
    const snap = await getDocs(query(collection(db, 'ventas'), orderBy('created_at', 'desc'), limit(5000)));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }, { ttl: 60 * 1000 });

  const acc = { efectivo: 0, mp: 0, lapos: 0, count: 0 };
  ventas.forEach(v => {
    if (v.deleted === true || isVentaVarios2(v)) return;
    const f = parseArDate(v.created_at);
    if (ymAR(f) !== ym) return;
    const monto = v.total_amount || 0;
    acc.count++;
    if (v.payment_type === 'cash') { acc.efectivo += monto; return; }
    const cuenta = v.transfer_account || v.cuenta_id || 'cuenta1';
    if (cuenta === 'cuenta2') acc.lapos += monto; else acc.mp += monto;
  });

  if (acc.count === 0) {
    alertDialog({
      title: 'Sin ventas en el cache',
      message: `No se encontraron ventas de <b>${esc(mesLabel(ym))}</b> entre las recientes. ` +
        `Si es un mes viejo, cargá los saldos a mano.`,
      type: 'warning',
    });
    return;
  }

  const ok = await confirmDialog({
    title: 'Autocompletar desde ventas',
    message: `Se calcularon los ingresos de <b>${esc(mesLabel(ym))}</b> (${acc.count} ventas):<br>` +
      `Efectivo ${money(acc.efectivo)} · Mercado Pago ${money(acc.mp)} · Lapos ${money(acc.lapos)}.<br><br>` +
      `Esto reemplaza los saldos cargados de ese mes. ¿Continuar?`,
    confirmText: 'Autocompletar',
  });
  if (!ok) return;

  const mes = ensureMes(ym);
  mes.saldos = { efectivo: acc.efectivo, mp: acc.mp, lapos: acc.lapos };
  mes.origen = 'auto';
  await persistMes(ym, { saldos: mes.saldos, origen: 'auto' });
  refreshCajaBand();

  // refrescar el cuerpo del acordeón abierto
  const card = mountEl.querySelector(`.bal-mes[data-mes="${ym}"]`);
  if (card) {
    const bodyEl = card.querySelector('.bal-mes-body');
    const origenBadge = card.querySelector('.bal-mes-origen');
    if (origenBadge) { origenBadge.className = 'bal-mes-origen is-auto'; origenBadge.textContent = 'auto'; }
    if (bodyEl && openMeses.has(ym)) { bodyEl.innerHTML = mesBodyHtml(ym); bindMesBody(card, ym); }
    patchMesTotales(card, ym);
  }
}

// ── Importar histórico del Excel (idempotente) ────────────────────────────────
async function importarHistorico(esPrimera) {
  if (saving) return;
  const current = await loadBalanceConfig(db) || {};
  const curMeses = current.meses || {};

  const toAdd = {};
  let nuevos = 0;
  for (const [ym, data] of Object.entries(BALANCE_SEED.meses)) {
    if (!curMeses[ym]) { toAdd[ym] = data; nuevos++; }
  }

  if (!esPrimera) {
    const ok = await confirmDialog({
      title: 'Importar histórico',
      message: nuevos > 0
        ? `Se agregarán <b>${nuevos}</b> mes(es) del Excel que faltan. Los meses ya cargados <b>no se tocan</b>.`
        : `Ya están todos los meses del Excel. No hay nada nuevo para importar.`,
      confirmText: nuevos > 0 ? 'Importar' : 'Entendido',
    });
    if (!ok || nuevos === 0) return;
  }

  const partial = { meses: toAdd };
  if (!current.version) partial.version = BALANCE_SEED.version;
  if (!current.rubros || !current.rubros.length) partial.rubros = BALANCE_SEED.rubros;
  if (!current.agregados || !current.agregados.length) partial.agregados = BALANCE_SEED.agregados;
  if (!current.montosFijos || !current.montosFijos.length) partial.montosFijos = BALANCE_SEED.montosFijos;

  saving = true;
  try {
    await saveBalanceConfig(db, partial);
    cfg = await loadBalanceConfig(db);
    histReset();   // la importación es la nueva línea base del historial
    render();
  } catch (err) {
    console.error('[balance] error importando histórico:', err);
    alertDialog({ title: 'No se pudo importar', message: 'Revisá la conexión e intentá de nuevo.', type: 'error' });
  } finally {
    saving = false;
  }
}

// ── Importar el detalle día por día del Excel (2026) — idempotente ─────────────
// Carga BALANCE_DIAS_SEED (lazy, chunk aparte). Por cada mes agrega SOLO los días
// que no existen todavía en dias_<ym> (no pisa lo cargado a mano), guarda la
// apertura del mes si falta, y completa los saldos de cierre del RESUMEN que estén
// vacíos usando el acumulado (apertura + neto de todos los días del mes).
async function importarDiasExcel(esPrimera) {
  if (saving) return;
  let seed;
  try {
    ({ BALANCE_DIAS_SEED: seed } = await import('./balance_dias_seed.js'));
  } catch (err) {
    console.error('[balance] no se pudo cargar el seed de días:', err);
    return alertDialog({ title: 'No se pudo cargar', message: 'No se encontró el detalle diario del Excel.', type: 'error' });
  }
  const meses = (seed && seed.meses) || {};

  // Plan: qué días nuevos hay por mes (idempotente: no toca los ya cargados) y
  // qué falta completar en el RESUMEN. Saldos y rubros se completan SOLO si el mes
  // no los tiene — respeta lo que el usuario ya haya tocado.
  const plan = [];
  const saldosPatch = {};
  const nuevosRubros = new Set();
  const yaHay = new Set([...(cfg.rubros || []), ...(cfg.agregados || [])]);
  for (const [ym, m] of Object.entries(meses)) {
    const existing = await loadDiasMes(db, ym);
    const exDias = (existing && existing.dias) || {};
    const nuevos = {};
    for (const [dd, d] of Object.entries(m.dias || {})) if (!exDias[dd]) nuevos[dd] = d;
    plan.push({ ym, m, existing, nuevos, nNuevos: Object.keys(nuevos).length });
    const mesCfg = cfg.meses && cfg.meses[ym];
    const close = cierreMes(m);
    const rub = rubrosDesdeDias(m.dias);
    Object.keys(rub).forEach(k => { if (!yaHay.has(k)) nuevosRubros.add(k); });
    const patchMes = {};
    if (!mesCfg) { patchMes.label = m.label; patchMes.origen = 'excel'; patchMes.saldos = close; }
    else if (!mesCfg.saldos) patchMes.saldos = close;
    if ((!mesCfg || !mesCfg.rubros || !Object.keys(mesCfg.rubros).length) && Object.keys(rub).length) patchMes.rubros = rub;
    if (Object.keys(patchMes).length) saldosPatch[ym] = patchMes;
  }
  const totalNuevos = plan.reduce((s, p) => s + p.nNuevos, 0);

  if (!esPrimera) {
    const ok = await confirmDialog({
      title: 'Importar días del Excel',
      message: totalNuevos > 0
        ? `Se agregarán <b>${totalNuevos}</b> día(s) del libro diario 2026 (Ene→Jun) al "Día por día". Los días ya cargados <b>no se tocan</b>.`
        : `Ya están todos los días del Excel importados. No hay nada nuevo.`,
      confirmText: totalNuevos > 0 ? 'Importar' : 'Entendido',
    });
    if (!ok || totalNuevos === 0) return;
  }

  saving = true;
  try {
    // Los saldos/rubros de cierre se derivan del seed (no de los días recién
    // escritos), por eso se guardan PRIMERO: si luego falla algún día, el Resumen
    // queda completo y una re-importación (idempotente) termina de cargar los días.
    if (Object.keys(saldosPatch).length || nuevosRubros.size) {
      const balPatch = {};
      if (Object.keys(saldosPatch).length) balPatch.meses = saldosPatch;
      if (nuevosRubros.size) balPatch.rubros = [...(cfg.rubros || []), ...nuevosRubros];
      await saveBalanceConfig(db, balPatch);
    }

    let diasImportados = 0, mesesTocados = 0;
    for (const { ym, m, existing, nuevos, nNuevos } of plan) {
      const patch = {};
      if (nNuevos) patch.dias = nuevos;
      if (!(existing && existing.apertura)) patch.apertura = m.apertura;
      if (!(existing && existing.origen)) patch.origen = 'excel';
      if (Object.keys(patch).length) {
        await saveDiasMes(db, ym, patch);
        invalidateDiasMes(ym);
        diasImportados += nNuevos;
        if (nNuevos) mesesTocados++;
      }
    }

    invalidateBalanceConfig();
    cfg = await loadBalanceConfig(db);
    curDiasDoc = null;
    histReset();
    view = 'dia'; localStorage.setItem('bal:view', view);
    // Aterrizar en el último día importado (no en hoy, que puede estar vacío).
    const lastYm = Object.keys(meses).sort().pop();
    const lastDd = lastYm ? Object.keys(meses[lastYm].dias || {}).sort().pop() : null;
    if (lastYm && lastDd) { curDiaYm = lastYm; curDiaDD = lastDd; } else { curDiaYm = curDiaDD = null; }
    render();
    alertDialog({
      title: 'Días importados',
      message: totalNuevos > 0
        ? `Se importaron <b>${diasImportados}</b> día(s) en ${mesesTocados} mes(es) desde el Excel. Mirá la pestaña <b>Día por día</b>.`
        : `No había días nuevos para importar.`,
      type: 'success',
    });
  } catch (err) {
    console.error('[balance] error importando días:', err);
    // Mantener el cache coherente aunque falle a mitad de camino.
    invalidateBalanceConfig();
    try { const fresh = await loadBalanceConfig(db); if (fresh) cfg = fresh; } catch (_) { /* offline */ }
    alertDialog({ title: 'No se pudo importar', message: 'Revisá la conexión e intentá de nuevo. Podés reintentar: la importación es idempotente y no duplica lo ya cargado.', type: 'error' });
  } finally {
    saving = false;
  }
}
