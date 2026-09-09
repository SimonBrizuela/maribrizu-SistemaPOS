// ── Urgencia de compra ────────────────────────────────────────────────────────
// Cómo se decide qué comprar primero en el Centro de Compras.
//
// Pedido del dueño (09/09/2026): la lista no puede ordenarse solo por lo que se
// vendió la última semana. Tiene que conjugar tres cosas:
//
//   1. lo que más se movió en los ÚLTIMOS DÍAS (ventana corta, 7 días);
//   2. lo que más se vende EN EL MES (ventana larga, 30 días — las hojas de
//      impresión, el plástico: lo que sostiene el mostrador todos los meses);
//   3. el STOCK MÍNIMO cargado en la ficha.
//
// La cuenta no las suma: las multiplica en dos mitades, porque son dos preguntas
// distintas.
//
//   urgencia = 100 × riesgo × importancia
//
//   riesgo      → qué tan cerca está de quedarse sin nada. Es el PEOR de dos
//                 medidas: los días que le quedan al ritmo actual, y cuánto le
//                 falta para llegar al mínimo cargado.
//   importancia → cuánto duele que falte. Sale de qué tan arriba está en el
//                 ranking del mes y en el de los últimos días.
//
// Multiplicar (y no sumar) arregla el error que tenía la lista: un producto que
// vende muchísimo pero tiene stock para tres meses NO es urgente, y sumando
// quedaba arriba igual. Con el producto, sin riesgo no hay urgencia, por más
// que sea el más vendido del local.
//
// El precio NO entra en el puntaje a propósito. Si entrara, las hojas —baratas
// y lo que más se vende— quedarían siempre debajo de cualquier cosa cara que
// casi no rota, que es justo lo contrario de lo que se pidió. La plata que se
// deja de facturar se sigue mostrando y se usa para desempatar.
//
// Todo acá es lógica pura y sin DOM (ni Firebase): se prueba en
// `tienda/pruebas/urgencia_compra.test.js` y se puede correr fuera del
// navegador contra un volcado de Firestore.

// Lo que se vende fraccionado viaja con el nombre decorado y con la cantidad en
// la presentación vendida: hay que leerlo antes de contarlo.
import { parseNombreItem, unidadesDelRenglon } from './nombre_item.js';

// ── Ventanas y pesos ─────────────────────────────────────────────────────────
export const VENTANA_CORTA_DIAS = 7;    // "los últimos días"
export const VENTANA_LARGA_DIAS = 30;   // "lo que se vende en el mes"
// Hasta dónde se mira para adelante al decidir la compra: lo que tenga stock
// para más que esto no urge todavía. Es la ventana de la COMPRA, no la de la
// medición — se cambia desde Ajustes (`cobertura_dias_objetivo`). En 45 días
// porque el viaje al mayorista no es semanal: con 30 quedaba afuera lo que
// tiene stock para poco más de un mes, que igual hay que traer.
export const COBERTURA_DEFAULT_DIAS = 45;
// Días que quedan para considerar que se agota YA. Debajo de esto el riesgo
// entra en la meseta alta: entre 2 y 5 días de stock la diferencia es poca,
// las dos cosas hay que comprarlas en este viaje.
export const DIAS_CRITICOS = 7;
// Cuánto pesa el ritmo corto sobre el largo al medir el ritmo real de hoy.
export const PESO_RITMO_CORTO = 0.6;
// Piso de importancia: lo que tiene mínimo cargado y está por debajo figura
// aunque no haya vendido una sola unidad. Sin piso, el puntaje daría 0 y todos
// esos productos quedarían empatados al fondo sin orden entre ellos.
export const PISO_IMPORTANCIA = 0.20;
// Piso de riesgo al tocar el mínimo cargado (el mínimo es el punto de reponer).
export const PISO_RIESGO_MINIMO = 0.25;
// Cómo se reparte la importancia entre las dos ventanas. Mitad y mitad: es
// literalmente "conjugar" lo del mes con lo de los últimos días.
export const PESO_MES = 0.5;
export const PESO_RECIENTE = 0.5;
// Umbrales de nivel sobre el puntaje 0–100.
export const UMBRAL_SISI = 45;
export const UMBRAL_IMPORTANTE = 18;
// Percentil desde el que un producto es "top de ventas".
export const UMBRAL_TOP = 0.85;
// Muestra mínima para que un ranking signifique algo. Con tres productos
// vendidos en todo el mes, ser "el segundo" no dice nada.
export const MIN_MUESTRA_RANKING = 5;
// Unidades vendidas en el mes para considerar que un producto ROTA.
export const MIN_ROTACION = 3;

export function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function normNombre(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// "2026-09-09" menos n días. Aritmética de fechas sobre el string, sin zona
// horaria: el local no cambia de hora y las fechas de `ventas_por_dia` son las
// del mostrador.
export function restarDias(ymd, n) {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const t = new Date(Date.UTC(y, m - 1, d - n));
  return t.toISOString().slice(0, 10);
}

function _diasEntre(a, b) {
  const [ay, am, ad] = String(a).split('-').map(Number);
  const [by, bm, bd] = String(b).split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// ── Las dos ventanas, de una sola pasada ─────────────────────────────────────
// Recibe los renglones de `ventas_por_dia` y devuelve todo lo que hace falta
// para medir el ritmo y armar el ranking del local:
//
//   porNombre / porNombreColor  → unidades del mes (30 días)
//   corto.*                     → lo mismo de los últimos días (7)
//   consumoPorDocId             → lo que se gastó por vinculaciones (la hoja
//                                 que se va con cada impresión, aunque nunca se
//                                 venda suelta)
//   diasMov                     → en cuántos días DISTINTOS se movió cada cosa
//                                 en la ventana corta; sin esto, una venta
//                                 grande sola pasa por ritmo
//   primerMov*                  → cuándo se vendió por primera vez, para no
//                                 subestimar a los que recién arrancan
//   escalaMes / escalaReciente  → las escalas contra las que se saca el
//                                 percentil de cada producto
//
// `aYmd` traduce la fecha del renglón ("dd/mm/yyyy") a "YYYY-MM-DD"; se pasa de
// afuera para que este módulo no dependa de nada.
export function computarVentanas(items, {
  hoyYmd,
  aYmd,
  catalogoPorNombre = null,
  ventanaLarga = VENTANA_LARGA_DIAS,
  ventanaCorta = VENTANA_CORTA_DIAS,
} = {}) {
  const corteLargo = restarDias(hoyYmd, ventanaLarga);
  const corteCorto = restarDias(hoyYmd, ventanaCorta);
  const porNombre = new Map();
  const porNombreColor = new Map();
  const nombresConColor = new Set();
  const consumoPorDocId = new Map();
  const porNombre7 = new Map();
  const porNombreColor7 = new Map();
  const consumo7PorDocId = new Map();
  const diasMov = new Map();
  const primerMovPorNombre = new Map();
  const primerMovPorDocId = new Map();
  const marcarDia = (clave, ymd) => {
    let set = diasMov.get(clave);
    if (!set) { set = new Set(); diasMov.set(clave, set); }
    set.add(ymd);
  };

  for (const it of (items || [])) {
    if (!it || it.deleted === true) continue;
    const ymd = aYmd(it.fecha);
    if (!ymd || ymd < corteLargo) continue;
    const reciente = ymd >= corteCorto;

    // Consumo vía vinculaciones. Es la verdad de terreno: lo que el watcher de
    // consumibles ya descontó queda en `consumibles_descuentos`.
    const desc = Array.isArray(it.consumibles_descuentos) ? it.consumibles_descuentos : null;
    if (desc) {
      for (const d of desc) {
        if (!d || d.skip || d.error) continue;
        const tid = String(d.target_id || '');
        const c = Number(d.cantidad || 0);
        if (!tid || !(c > 0)) continue;
        consumoPorDocId.set(tid, (consumoPorDocId.get(tid) || 0) + c);
        const prev = primerMovPorDocId.get(tid);
        if (!prev || ymd < prev) primerMovPorDocId.set(tid, ymd);
        if (reciente) {
          consumo7PorDocId.set(tid, (consumo7PorDocId.get(tid) || 0) + c);
          marcarDia('doc:' + tid, ymd);
        }
      }
    }

    // El renglón viene decorado ("[Verde]  CINTA  ·  2,5 m") y con la cantidad
    // en la presentación vendida ("1 pack(s)" son 500 hojas).
    const crudo = it.producto || it.product_name || '';
    const nombre = normNombre(parseNombreItem(crudo).base || crudo);
    if (!nombre) continue;
    const cant = unidadesDelRenglon(
      { producto: crudo, cantidad: it.cantidad ?? it.quantity ?? 0 },
      (catalogoPorNombre && catalogoPorNombre.get(nombre)) || null,
    );
    if (!cant) continue;

    // Las devoluciones/correcciones (cantidad negativa) restan del ritmo.
    porNombre.set(nombre, (porNombre.get(nombre) || 0) + cant);
    const color = normNombre(it.conjunto_color || '');
    const claveColor = nombre + '||' + color;
    if (color) {
      nombresConColor.add(nombre);
      porNombreColor.set(claveColor, (porNombreColor.get(claveColor) || 0) + cant);
    }
    if (reciente) {
      porNombre7.set(nombre, (porNombre7.get(nombre) || 0) + cant);
      if (color) porNombreColor7.set(claveColor, (porNombreColor7.get(claveColor) || 0) + cant);
      if (cant > 0) {
        marcarDia(nombre, ymd);
        if (color) marcarDia(claveColor, ymd);
      }
    }
    if (cant > 0) {
      const prev = primerMovPorNombre.get(nombre);
      if (!prev || ymd < prev) primerMovPorNombre.set(nombre, ymd);
    }
  }

  return {
    hoyYmd, ventanaLarga, ventanaCorta,
    porNombre, porNombreColor, nombresConColor, consumoPorDocId,
    porNombre7, porNombreColor7, consumo7PorDocId, diasMov,
    primerMovPorNombre, primerMovPorDocId,
    escalaMes: escalaVentas(porNombre.values()),
    escalaReciente: escalaVentas(porNombre7.values()),
  };
}

// Ritmo de un producto (o de UNA variedad) contra las ventanas ya computadas.
// `color` mide SOLO esa variedad, pero solo cuando las ventas de ese producto
// traen color: los documentos viejos no lo guardaban y caerían en cero.
export function ritmoDe(v, { nombre, color = '', docId = '' } = {}) {
  const n = normNombre(nombre);
  const usaColor = !!color && v.nombresConColor.has(n);
  const claveColor = n + '||' + normNombre(color);
  const dias7 = new Set();
  const sumarDias = (clave) => {
    const s = v.diasMov.get(clave);
    if (s) for (const d of s) dias7.add(d);
  };
  let unidades, unidades7;
  if (usaColor) {
    unidades = v.porNombreColor.get(claveColor) || 0;
    unidades7 = v.porNombreColor7.get(claveColor) || 0;
    sumarDias(claveColor);
  } else {
    unidades = v.porNombre.get(n) || 0;
    unidades7 = v.porNombre7.get(n) || 0;
    sumarDias(n);
    if (docId) {
      unidades += v.consumoPorDocId.get(docId) || 0;
      unidades7 += v.consumo7PorDocId.get(docId) || 0;
      sumarDias('doc:' + docId);
    }
  }
  unidades = Math.max(0, unidades);
  unidades7 = Math.max(0, unidades7);

  // Un producto nuevo se mide desde su primera venta (piso 7 días): con 30 en
  // el denominador, el que arranca fuerte parece que no vende.
  let dias = v.ventanaLarga;
  if (unidades > 0 && v.hoyYmd) {
    const primeros = [];
    const pn = v.primerMovPorNombre.get(n);
    if (pn) primeros.push(pn);
    if (!usaColor && docId) {
      const pd = v.primerMovPorDocId.get(docId);
      if (pd) primeros.push(pd);
    }
    if (primeros.length) {
      const transcurridos = _diasEntre(primeros.sort()[0], v.hoyYmd) + 1;
      dias = Math.max(v.ventanaCorta, Math.min(v.ventanaLarga, transcurridos));
    }
  }

  const velLarga = unidades / dias;
  const velCorta = unidades7 / v.ventanaCorta;
  const diasConMov7 = dias7.size;
  return {
    unidades, dias, unidades7, diasConMov7, velLarga, velCorta,
    velDia: ritmoPonderado({ velLarga, velCorta, diasConMovimiento: diasConMov7 }),
    rankMes: rankEnEscala(v.escalaMes, unidades),
    rankReciente: rankEnEscala(v.escalaReciente, unidades7),
  };
}

// ── Ritmo real de hoy ─────────────────────────────────────────────────────────
// Mezcla el ritmo del mes con el de los últimos días. El corto manda cuando hay
// con qué confiar en él: `diasConMovimiento` cuenta en cuántos DÍAS DISTINTOS
// hubo movimiento en la ventana corta.
//
// Esa cuenta es la que evita la trampa que ya costó cara al calibrar mínimos
// (PAÑOLENCI: una venta de 50 metros dejó el mínimo en 44). Una sola venta
// grande no es un ritmo: con un solo día de movimiento el ritmo corto no pesa
// nada y manda el del mes. Con tres días o más pesa completo.
export function confianzaRitmoCorto(diasConMovimiento) {
  const d = Math.max(0, Number(diasConMovimiento) || 0);
  return clamp01((d - 1) / 2);
}

export function ritmoPonderado({ velLarga = 0, velCorta = 0, diasConMovimiento = 0 } = {}) {
  const larga = Math.max(0, Number(velLarga) || 0);
  const corta = Math.max(0, Number(velCorta) || 0);
  const conf = confianzaRitmoCorto(diasConMovimiento);
  if (conf <= 0) return larga;   // sin días de movimiento no hay nada que corregir
  return Math.max(0, larga + (corta - larga) * PESO_RITMO_CORTO * conf);
}

// ── Ranking de ventas ─────────────────────────────────────────────────────────
// La escala es la lista ordenada de unidades vendidas por producto en la
// ventana. Cualquier cantidad se ubica contra esa escala y sale un percentil
// 0–1: 1 = de los que más se venden del local, 0 = no vendió nada.
//
// Se compara contra la escala de PRODUCTOS aunque la cantidad venga de una
// variedad (un color de un rollo). Es lo correcto: que el producto entero sea
// el más vendido no convierte a cada uno de sus doce colores en top, y así los
// colores no inundan la cabeza de la lista.
export function escalaVentas(valores) {
  const arr = [];
  for (const v of (valores || [])) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) arr.push(n);
  }
  arr.sort((a, b) => a - b);
  return arr;
}

export function rankEnEscala(escala, unidades) {
  const v = Number(unidades) || 0;
  if (!(v > 0)) return 0;
  if (!escala || escala.length < MIN_MUESTRA_RANKING) return 0;
  let lo = 0, hi = escala.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (escala[m] < v) lo = m + 1; else hi = m;
  }
  return lo / escala.length;   // proporción de productos que venden MENOS
}

// ── Riesgo: qué tan cerca está de quedarse sin nada ──────────────────────────
// Dos medidas y manda la peor:
//
//   · por cobertura → días que aguanta al ritmo de hoy contra los días que se
//     quieren cubrir. Meseta alta debajo de una semana: entre 2 y 5 días de
//     stock la diferencia no cambia la decisión, las dos van en este viaje.
//   · por mínimo → cuánto le falta para llegar al mínimo que cargó el dueño.
//     En cero (o negativo) es 1; justo en el mínimo, 0.
export function riesgoPorCobertura(diasCobertura, coberturaObjetivo = COBERTURA_DEFAULT_DIAS) {
  const obj = Math.max(1, Number(coberturaObjetivo) || COBERTURA_DEFAULT_DIAS);
  const d = Number(diasCobertura);
  if (!Number.isFinite(d)) return 0;        // sin ritmo no se puede saber cuándo se agota
  if (d <= 0) return 1;
  const critico = Math.min(DIAS_CRITICOS, obj);
  if (d <= critico) return 0.70 + 0.30 * (1 - d / critico);
  if (d >= obj) return 0;
  return 0.70 * (1 - (d - critico) / (obj - critico));
}

export function riesgoPorMinimo(stock, stockMin) {
  const min = Number(stockMin) || 0;
  if (!(min > 0)) return 0;
  const st = Number(stock) || 0;
  if (st > min) return 0;
  // Tocar el mínimo YA es la señal de reponer: sin este piso, "justo en el
  // mínimo" daba riesgo cero y quedaba empatado con lo que está bien de stock.
  return Math.max(PISO_RIESGO_MINIMO, clamp01((min - st) / min));
}

// ── Importancia: cuánto duele que falte ──────────────────────────────────────
export function importanciaDeVenta(rankMes, rankReciente) {
  const mes = clamp01(rankMes);
  const rec = clamp01(rankReciente);
  return PISO_IMPORTANCIA + (1 - PISO_IMPORTANCIA) * (PESO_MES * mes + PESO_RECIENTE * rec);
}

// ── Puntaje final ─────────────────────────────────────────────────────────────
// Dos pisos, para que quedarse sin nada nunca quede sepultado por el ranking:
//   · sin stock y el producto rota → como mínimo SÍ O SÍ;
//   · sin stock aunque casi no rote → como mínimo IMPORTANTE.
// Se aplican sobre el puntaje (no sobre el nivel) para que la lista ordenada
// por puntaje siga teniendo los niveles agrupados y en orden.
// `stock` y `stockMin` tienen que venir en la MISMA unidad (los dos en packs
// para una variedad, los dos en unidades para un producto). `sinStock` se pasa
// aparte porque para una variedad el stock comparable va en packs y el envase
// abierto —0,4 packs, 40 unidades sueltas— no es quedarse sin nada.
export function puntajeUrgencia({
  diasCobertura = Infinity,
  coberturaObjetivo = COBERTURA_DEFAULT_DIAS,
  stock = 0,
  stockMin = 0,
  sinStock = null,
  rankMes = 0,
  rankReciente = 0,
  unidadesMes = 0,
} = {}) {
  const rCob = riesgoPorCobertura(diasCobertura, coberturaObjetivo);
  const rMin = riesgoPorMinimo(stock, stockMin);
  const riesgo = Math.max(rCob, rMin);
  const importancia = importanciaDeVenta(rankMes, rankReciente);
  let score = 100 * riesgo * importancia;

  const vacio = sinStock == null ? Number(stock) <= 0 : !!sinStock;
  const rota = (Number(unidadesMes) || 0) >= MIN_ROTACION;
  if (vacio && rota) score = Math.max(score, UMBRAL_SISI);
  else if (vacio) score = Math.max(score, UMBRAL_IMPORTANTE);

  return {
    score: Math.round(score * 10) / 10,
    riesgo,
    riesgo_cobertura: rCob,
    riesgo_minimo: rMin,
    importancia,
    rank_mes: clamp01(rankMes),
    rank_reciente: clamp01(rankReciente),
  };
}

export function nivelPorPuntaje(score) {
  const s = Number(score) || 0;
  if (s >= UMBRAL_SISI) return 'sisi';
  if (s >= UMBRAL_IMPORTANTE) return 'importante';
  return 'opcional';
}

// ── Orden de la lista ─────────────────────────────────────────────────────────
// Del más urgente de comprar al menos urgente. El puntaje manda; los desempates
// son la plata que se deja de facturar, el ritmo y los días que aguanta.
export function compararUrgencia(a, b) {
  const ua = Number(a?.urgencia) || 0, ub = Number(b?.urgencia) || 0;
  if (ua !== ub) return ub - ua;
  const pa = Number(a?.perdidaHorizonte) || 0, pb = Number(b?.perdidaHorizonte) || 0;
  if (pa !== pb) return pb - pa;
  const va = Number(a?.vel_dia) || 0, vb = Number(b?.vel_dia) || 0;
  if (va !== vb) return vb - va;
  const da = Number.isFinite(a?.dias_cobertura) ? a.dias_cobertura : Infinity;
  const db = Number.isFinite(b?.dias_cobertura) ? b.dias_cobertura : Infinity;
  if (da !== db) return da - db;
  return String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es');
}

// ── Por qué está donde está ───────────────────────────────────────────────────
// Las razones que se muestran debajo del nombre en la lista. Cortas y en
// criollo: es lo que el dueño lee para decidir si le cree al orden.
//
// UNA sola razón de venta, la más fuerte. La línea ya trae los días que aguanta
// y las unidades de las dos ventanas; repetir los mismos números en cuatro
// frases más convertía cada fila en un párrafo que nadie lee.
export function motivosUrgencia(r) {
  const out = [];
  if (!r) return out;
  const vel30 = Number(r.vel_dia_30) || 0;
  const vel7 = Number(r.vel_dia_7) || 0;
  // Con movimiento en un solo día no se habla de la semana: fue una venta, no
  // una tendencia. El ritmo tampoco la toma (ver `ritmoPonderado`).
  const semanaCreible = Number(r.unidades_7) > 0 && Number(r.dias_con_mov_7) >= 2;
  const acelera = semanaCreible && vel30 > 0 && vel7 >= vel30 * 1.4;

  if (r.rank_mes >= UMBRAL_TOP) out.push('de lo que más se vende en el mes');
  else if (acelera) out.push('se está moviendo más que de costumbre');
  else if (semanaCreible && r.rank_reciente >= UMBRAL_TOP) out.push('de lo más vendido de estos días');
  else if (r.rank_mes >= 0.6) out.push('se vende seguido todo el mes');

  // El mínimo, solo si no quedó dicho ya en el "Sin stock" de la cobertura.
  if (Number(r.stock) > 0 && Number(r.stock_min) > 0 && Number(r.stock) < Number(r.stock_min)) {
    out.push('por debajo del mínimo cargado');
  }
  return out;
}

// Texto del tooltip del puntaje: la cuenta abierta, para poder discutirla.
export function explicarUrgencia(r) {
  if (!r) return '';
  const pct = n => `${Math.round(clamp01(n) * 100)}%`;
  const lineas = [
    `Urgencia ${_num(r.urgencia)} de 100`,
    `· Riesgo de quedarse sin stock: ${pct(r.riesgo)}`,
    `· Peso en las ventas: ${pct(r.importancia)}`,
    `· En el mes vende más que el ${pct(r.rank_mes)} del catálogo`,
    `· En los últimos días, más que el ${pct(r.rank_reciente)}`,
  ];
  if (Number(r.stock_min) > 0) lineas.push(`· Mínimo cargado: ${_num(r.stock_min)}`);
  lineas.push('Urgencia = riesgo × peso en las ventas. Vender mucho no urge si hay stock de sobra.');
  return lineas.join('\n');
}

function _num(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10).replace('.', ',');
}
