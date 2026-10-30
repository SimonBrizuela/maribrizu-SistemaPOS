/**
 * Guardar stock desde el panel sin pisar lo que se movió mientras tanto.
 *
 * El problema (auditoría del 29-10, 36 casos): la ficha del producto, la celda
 * de la grilla y el "Deshacer" escribían el stock como un número absoluto
 * sacado de la copia en memoria. Si entre que se abrió la ficha y se guardó el
 * POS vendió, otra pestaña cargó mercadería o el watcher descontó papel, ese
 * movimiento desaparecía sin dejar rastro (goma eva −139, cartulina −98).
 *
 * La regla de acá: lo que vale es lo que el usuario CAMBIÓ, no el número que
 * quedó en pantalla. Se comparan cuatro fotos del stock:
 *
 *   inicial — lo que mostraba el formulario al abrirse
 *   escrito — lo que muestra al guardar
 *   visto   — el documento tal como estaba en memoria al abrirse
 *   nube    — el documento tal como está HOY (leído en la transacción)
 *
 *   · Si no tocó el stock (escrito = inicial), no se escribe stock: queda el
 *     de la nube, con lo que haya pasado en el medio.
 *   · Si lo tocó y la nube no se movió (nube = visto), se guarda lo que
 *     escribió, tal cual.
 *   · Si lo tocó Y la nube se movió, hay dos lecturas posibles y no se elige
 *     en silencio: "sumar mi cambio" (nube + lo que cambió) o "dejar lo que
 *     escribí" (un conteo: fijar ese número). Lo decide la persona.
 *
 * Sin Firebase ni DOM: lo importan la ficha, la grilla, el historial de
 * deshacer y las pruebas de `tienda/pruebas/stock_concurrencia.test.js`.
 *
 * Las cuentas de conjunto salen de `conjunto.js` (regla duplicada con
 * `pos_system/models/conjunto.py`); acá no se cambia su semántica, sólo se
 * usan.
 */
import { num, contenidoDe, totalConjunto, repartirTotal } from './conjunto.js';

const EPS = 1e-9;

function r4(n) {
  return Math.round(n * 10000) / 10000;
}

function iguales(a, b) {
  return Math.abs(num(a) - num(b)) < EPS;
}

export function esConjunto(p) {
  return p?.es_conjunto === true || p?.es_conjunto === 1;
}

/** Servicio sin control de stock: la bandera, o el -1 de las bases viejas. */
export function esIlimitado(p) {
  return p?.stock_ilimitado === true || Number(p?.stock) === -1;
}

/** Misma clave que usa el POS para encontrar una variedad: el nombre sin mayúsculas. */
export function claveVariedad(c) {
  return String(c?.color || '').toLowerCase().trim();
}

function variedadesDe(p) {
  return (Array.isArray(p?.conjunto_colores) ? p.conjunto_colores : [])
    .filter(c => c && typeof c === 'object');
}

/**
 * Los números de stock de un producto, sin el resto de la ficha.
 * `forma` dice cómo se guarda: 'plano' (stock), 'conjunto' (packs + sueltos)
 * o 'variedades' (packs + sueltos por variedad).
 */
export function fotoStock(p) {
  const d = p || {};
  if (!esConjunto(d)) {
    return { forma: 'plano', stock: num(d.stock), ilimitado: esIlimitado(d) };
  }
  const contenido = num(d.conjunto_contenido);
  const vars = variedadesDe(d);
  if (vars.length) {
    const variedades = new Map();
    for (const c of vars) {
      variedades.set(claveVariedad(c), {
        color: c.color,
        unidades: num(c.unidades),
        restante: num(c.restante),
        contenido: contenidoDe(c, contenido),
      });
    }
    return { forma: 'variedades', contenido, variedades, total: r4(totalConjunto(vars, contenido)) };
  }
  const unidades = num(d.conjunto_unidades);
  const restante = num(d.conjunto_restante);
  // Para un conjunto la verdad es `conjunto_total`: la venta del POS lo baja
  // junto con packs y sueltos, pero no toca `stock`.
  const hayTotal = d.conjunto_total !== null && d.conjunto_total !== undefined && d.conjunto_total !== '';
  const total = hayTotal ? num(d.conjunto_total) : unidades * contenido + restante;
  return { forma: 'conjunto', contenido, unidades, restante, total: r4(total) };
}

/**
 * El stock que se le muestra a una persona: el total para un conjunto, el
 * `stock` plano para el resto (-1 = servicio). Es el número del "antes" y el
 * "después" del historial.
 */
export function stockVisible(p) {
  const f = fotoStock(p);
  if (f.forma === 'plano') return f.ilimitado ? -1 : r4(f.stock);
  return f.total;
}

function vacia() {
  return { unidades: 0, restante: 0, contenido: 0 };
}

function variedadIgual(a, b) {
  const x = a || vacia();
  const y = b || vacia();
  return iguales(x.unidades, y.unidades) && iguales(x.restante, y.restante)
    && (iguales(x.contenido, y.contenido) || (!x.unidades && !y.unidades));
}

/** Si dos fotos tienen los mismos números de stock. */
export function mismoStock(a, b) {
  if (a.forma !== b.forma) return false;
  if (a.forma === 'plano') return a.ilimitado === b.ilimitado && iguales(a.stock, b.stock);
  if (a.forma === 'conjunto') {
    return iguales(a.unidades, b.unidades) && iguales(a.restante, b.restante)
      && iguales(a.contenido, b.contenido) && iguales(a.total, b.total);
  }
  const claves = new Set([...a.variedades.keys(), ...b.variedades.keys()]);
  for (const k of claves) {
    if (!variedadIgual(a.variedades.get(k), b.variedades.get(k))) return false;
  }
  return true;
}

/** Packs y sueltos que nunca quedan negativos: si alguno no alcanza, se reparte el total. */
function sinNegativos(unidades, restante, contenido) {
  if (unidades >= 0 && restante >= 0) return { unidades: r4(unidades), restante: r4(restante) };
  const r = repartirTotal(Math.max(0, unidades * contenido + restante), contenido);
  return { unidades: r.unidades, restante: r.restante };
}

/** Campos de stock de un conjunto con variedades, a partir del array. */
function camposVariedades(colores, contenido) {
  const total = r4(totalConjunto(colores, contenido));
  return {
    stock: Math.max(0, Math.floor(total)),
    conjunto_unidades: r4(colores.reduce((a, c) => a + num(c.unidades), 0)),
    conjunto_restante: r4(colores.reduce((a, c) => a + num(c.restante), 0)),
    conjunto_total: total,
    conjunto_colores: colores,
  };
}

/**
 * Variedades combinadas: lo que el usuario dejó en la ficha (nombre, precio,
 * vínculos) con packs y sueltos = nube + lo que él cambió en cada una.
 * Las que agregó otra pantalla mientras tanto se conservan al final.
 */
function variedadesSumadas(fi, fe, fn, escritoColores) {
  const out = [];
  for (const c of escritoColores) {
    const k = claveVariedad(c);
    const ini = fi.forma === 'variedades' ? (fi.variedades.get(k) || vacia()) : vacia();
    const nub = fn.forma === 'variedades' ? (fn.variedades.get(k) || vacia()) : vacia();
    const cont = contenidoDe(c, fe.contenido);
    const u = nub.unidades + (num(c.unidades) - ini.unidades);
    const r = nub.restante + (num(c.restante) - ini.restante);
    out.push({ ...c, ...sinNegativos(u, r, cont) });
  }
  if (fn.forma === 'variedades') {
    const enEscrito = new Set(escritoColores.map(claveVariedad));
    const enInicial = fi.forma === 'variedades' ? fi.variedades : new Map();
    const nubeOriginal = new Map(fn._originales.map(c => [claveVariedad(c), c]));
    for (const [k, c] of nubeOriginal) {
      if (!enEscrito.has(k) && !enInicial.has(k)) out.push({ ...c });
    }
  }
  return out;
}

/** Si el usuario movió algún número de stock respecto de lo que se le mostró. */
function tocoStock(fi, fe, fn) {
  if (fi.forma !== fe.forma) return true;
  if (fe.forma === 'plano') return !iguales(fe.stock, fi.stock);
  if (fe.forma === 'conjunto') {
    return !iguales(fe.unidades, fi.unidades) || !iguales(fe.restante, fi.restante)
      || !iguales(fe.contenido, fi.contenido);
  }
  for (const [k, v] of fe.variedades) {
    if (!variedadIgual(v, fi.variedades.get(k))) return true;
  }
  for (const [k, v] of fi.variedades) {
    if (fe.variedades.has(k)) continue;
    // Borró una variedad: es un cambio de stock si tenía algo, o si en la
    // nube le entró algo mientras tanto (si no, se perdería en silencio).
    if (num(v.unidades) || num(v.restante)) return true;
    const enNube = fn.forma === 'variedades' ? fn.variedades.get(k) : null;
    if (enNube && (num(enNube.unidades) || num(enNube.restante))) return true;
  }
  return false;
}

function fotoConOriginales(p) {
  const f = fotoStock(p);
  if (f.forma === 'variedades') f._originales = variedadesDe(p);
  return f;
}

/** Los campos de stock a escribir para una foto "literal" (lo escrito tal cual). */
function camposLiteral(escrito, fe) {
  if (fe.forma === 'plano') return { stock: fe.ilimitado ? -1 : Math.max(0, r4(fe.stock)) };
  if (fe.forma === 'conjunto') {
    const total = r4(fe.unidades * fe.contenido + fe.restante);
    return {
      stock: Math.max(0, Math.floor(total)),
      conjunto_unidades: fe.unidades,
      // Vacío se guarda vacío, como siempre lo hizo la ficha.
      conjunto_restante: escrito.conjunto_restante ?? null,
      conjunto_total: total,
    };
  }
  return camposVariedades(variedadesDe(escrito).map(c => ({ ...c })), fe.contenido);
}

const CLAVES_STOCK = ['stock', 'conjunto_unidades', 'conjunto_restante', 'conjunto_total', 'conjunto_colores'];

/**
 * Decide qué stock escribir. Devuelve:
 *
 *   necesitaDecision — true si la persona tiene que elegir (y no eligió)
 *   opciones         — ['sumar', 'literal'] o sólo ['literal'] cuando sumar
 *                      no tiene sentido (cambió la forma, servicio)
 *   decision         — la que se aplicó, o null si no hizo falta
 *   campos           — campos de stock a escribir (null si falta decidir)
 *   omitir           — campos de stock que NO hay que escribir aunque el
 *                      formulario los traiga
 *   antes / despues  — stock visible real de la nube antes y después
 *   resumen          — números para el diálogo
 *
 * `decision` es 'sumar' o 'literal'. Si llega una que no está entre las
 * opciones (la nube cambió de forma entre la pregunta y el guardado), se
 * vuelve a preguntar.
 */
export function resolverGuardado({ inicial, escrito, visto, nube, decision = null }) {
  const fi = fotoConOriginales(inicial);
  const fe = fotoConOriginales(escrito);
  const fv = fotoConOriginales(visto);
  const fn = fotoConOriginales(nube);

  const tocado = tocoStock(fi, fe, fn);
  const carrera = !mismoStock(fv, fn);
  const cambioFormaNube = fv.forma !== fn.forma;
  const cambioFormaUsuario = fi.forma !== fe.forma;
  const sumable = !cambioFormaNube && !cambioFormaUsuario
    && !(fe.forma === 'plano' && (fe.ilimitado || fn.ilimitado || fi.ilimitado || fv.ilimitado));
  const opciones = sumable ? ['sumar', 'literal'] : ['literal'];

  const antes = stockVisible(nube);
  const literal = camposLiteral(escrito, fe);
  let sumado = null;
  if (sumable) {
    if (fe.forma === 'plano') {
      // Una baja nunca deja negativo. Una carga sobre un stock negativo
      // (vendido sin reponer) suma sobre el negativo, como la reposición.
      const d = fe.stock - fi.stock;
      const s = r4(fn.stock + d);
      sumado = { stock: d < 0 ? Math.max(0, s) : s };
    } else if (fe.forma === 'conjunto') {
      const uR = sinNegativos(
        fn.unidades + (fe.unidades - fi.unidades),
        fn.restante + (fe.restante - fi.restante),
        fe.contenido,
      );
      const total = r4(uR.unidades * fe.contenido + uR.restante);
      sumado = {
        stock: Math.max(0, Math.floor(total)),
        conjunto_unidades: uR.unidades,
        conjunto_restante: uR.restante,
        conjunto_total: total,
      };
    } else {
      sumado = camposVariedades(variedadesSumadas(fi, fe, fn, variedadesDe(escrito)), fe.contenido);
    }
  }

  const visibleDe = (campos) => (fe.forma === 'plano' ? campos.stock : campos.conjunto_total);
  const resumen = {
    unidadesForma: fe.forma,
    visto: stockVisible(visto),
    nube: antes,
    cambio: r4(stockVisible(escrito) - stockVisible(inicial)),
    sumado: sumado ? visibleDe(sumado) : null,
    literal: visibleDe(literal),
    cambioForma: cambioFormaNube || cambioFormaUsuario,
  };
  const base = { tocado, carrera, opciones, resumen, antes };

  // La nube cambió de forma (otra pantalla lo convirtió en conjunto o le sacó
  // las variedades): guardar la ficha la volvería atrás. Siempre se pregunta.
  const preguntar = (tocado && carrera) || cambioFormaNube;

  if (!preguntar && !tocado) {
    // No tocó el stock: queda el de la nube. Con variedades igual se escribe
    // el array (puede haber cambiado un precio o un nombre), pero con los
    // packs y sueltos de la nube.
    if (fe.forma === 'variedades') {
      const colores = variedadesSumadas(fi, fe, fn, variedadesDe(escrito));
      return { ...base, necesitaDecision: false, decision: null,
        campos: { conjunto_colores: colores },
        omitir: CLAVES_STOCK.filter(k => k !== 'conjunto_colores'),
        despues: antes };
    }
    return { ...base, necesitaDecision: false, decision: null, campos: {},
      omitir: CLAVES_STOCK.filter(k => fe.forma === 'plano' ? k === 'stock' : k !== 'conjunto_colores'),
      despues: antes };
  }

  if (!preguntar) {
    return { ...base, necesitaDecision: false, decision: null, campos: literal, omitir: [],
      despues: visibleDe(literal) };
  }

  if (!decision || !opciones.includes(decision)) {
    return { ...base, necesitaDecision: true, decision: null, campos: null, omitir: [], despues: null };
  }
  const campos = decision === 'sumar' ? sumado : literal;
  return { ...base, necesitaDecision: false, decision, campos, omitir: [], despues: visibleDe(campos) };
}

/**
 * Aplica el plan sobre los campos que arma la ficha: saca los de stock que no
 * hay que escribir y pone los decididos.
 */
export function aplicarPlan(update, plan) {
  const out = { ...update };
  for (const k of plan.omitir || []) delete out[k];
  Object.assign(out, plan.campos || {});
  return out;
}

/** Si un conjunto de campos (un paso del historial) mueve stock. */
export function tocaCamposDeStock(campos) {
  return !!campos && CLAVES_STOCK.some(k => k in campos);
}

/**
 * Deshacer o rehacer un paso que movió stock, como diferencia sobre la nube:
 * si en el medio se vendió algo, deshacer devuelve lo que cambió el paso y
 * respeta la venta. `desde` es el lado del paso que hay que dejar atrás y
 * `hacia` el que se quiere recuperar.
 */
export function resolverDeshacer({ desde, hacia, nube }) {
  const n = nube || {};
  const inicial = { ...n, ...desde };
  const escrito = { ...n, ...hacia };
  const plan = resolverGuardado({ inicial, escrito, visto: inicial, nube: n, decision: 'sumar' });
  if (plan.necesitaDecision) {
    return resolverGuardado({ inicial, escrito, visto: inicial, nube: n, decision: 'literal' });
  }
  return plan;
}

function fmtNum(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('es-AR', { maximumFractionDigits: 2 });
}

/**
 * Textos del aviso cuando el stock cambió mientras la ficha estaba abierta.
 * `unidad` es el plural a mostrar ("unidades", "metros") e `inicio` cómo
 * empieza la frase según la pantalla ("Al abrir la ficha").
 */
export function textoCarrera(resumen, { unidad = 'unidades', inicio = 'Al abrir la ficha' } = {}) {
  const { visto, nube, cambio, sumado, literal, cambioForma } = resumen;
  const signo = cambio > 0 ? '+' : '';
  if (cambioForma) {
    return {
      titulo: 'El producto cambió mientras lo editabas',
      cuerpo: `${inicio} el stock era ${fmtNum(visto)} ${unidad}; ahora la nube tiene ${fmtNum(nube)} `
        + 'y además cambió cómo se guarda (conjunto, variedades o stock simple). '
        + `Si guardás, queda exactamente lo que escribiste: ${fmtNum(literal)} ${unidad}.`,
      sumar: null,
      literal: `Guardar ${fmtNum(literal)} igual`,
    };
  }
  return {
    titulo: 'El stock cambió mientras editabas',
    cuerpo: `${inicio} había ${fmtNum(visto)} ${unidad}. Mientras editabas pasó a `
      + `${fmtNum(nube)} por una venta, una carga u otra pantalla. Tu cambio fue de ${signo}${fmtNum(cambio)}.`,
    sumar: sumado === null ? null : `Sumar mi cambio (${signo}${fmtNum(cambio)} → ${fmtNum(sumado)})`,
    literal: `Dejar ${fmtNum(literal)}, lo que escribí`,
  };
}
