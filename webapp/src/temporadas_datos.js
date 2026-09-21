// ── Temporadas: la capa que habla con Firestore ───────────────────────────────
// `temporadas.js` es lógica pura y no sabe nada de la base. Acá está lo otro:
// leer las ventas para hacer el estudio, guardarlo, y armar el índice de stock
// con el que se cruzan las recomendaciones.
//
// El estudio recorre TODO el histórico de ventas (36.000 renglones a septiembre
// de 2026). Es caro, así que no se hace al abrir la pantalla: se hace cuando el
// dueño lo pide, o cuando lo guardado ya tiene más de un mes, y el resultado
// —un agregado chico— queda en `config/temporadas_aprendidas`.

import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { loadTemporadasEstudio, saveTemporadasEstudio, fechaDMYtoYMD } from './config.js';
import {
  TEMPORADAS, estudiarTemporadas, temporadasProximas, recomendarParaTemporada,
  recomendarPorPistas, claveProducto, normTxt, estudioVigente, temporadaPorId,
} from './temporadas.js';
import { ritmoDe } from './urgencia_compra.js';
import { esServicio, esIlimitado } from './notifications.js';

/** Hoy en Argentina, "YYYY-MM-DD". La fecha del mostrador, no la del navegador. */
export function hoyAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

/**
 * Rehace el estudio leyendo todas las ventas y lo guarda.
 *
 * `onProgreso(n)` se llama con la cantidad de renglones leídos, para poder
 * mostrar que la cosa avanza: son veinte megas y tarda.
 */
export async function rehacerEstudio(db, { productos = [], onProgreso = null } = {}) {
  const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha_dt', 'desc')));
  const items = snap.docs.map(d => d.data());
  onProgreso?.(items.length);

  // Catálogo por nombre normalizado: hace falta para traducir las
  // presentaciones ("1 pack(s)" son 500 hojas) antes de contar unidades.
  const porNombre = new Map();
  for (const p of (productos || [])) {
    const n = normTxt(p?.nombre);
    if (n && !porNombre.has(n)) porNombre.set(n, p);
  }

  const estudio = estudiarTemporadas(items, {
    aYmd: fechaDMYtoYMD,
    catalogoPorNombre: porNombre,
  });
  await saveTemporadasEstudio(db, estudio);
  return estudio;
}

/** El estudio guardado, con la marca de si conviene rehacerlo. */
export async function cargarEstudio(db) {
  const estudio = await loadTemporadasEstudio(db);
  return { estudio, vigente: estudioVigente(estudio, hoyAR()) };
}

// ── Stock del catálogo, indexado como lo indexan las ventas ──────────────────

function esConjunto(p) { return p?.es_conjunto === true || p?.es_conjunto === 1; }

/** Unidades sueltas de una variedad: packs × contenido + lo que quedó abierto.
 *  Misma convención que `notifications.js` y el Centro de Compras. */
function unidadesDeVariedad(c, contenidoGlobal) {
  const u = Number(c?.unidades) || 0;
  const r = Number(c?.restante) || 0;
  const propio = Number(c?.contenido) || 0;
  const gl = Number(contenidoGlobal) || 0;
  return u * (propio > 0 ? propio : (gl > 0 ? gl : 1)) + r;
}

/**
 * Índice `clave → { stock, docId, producto, color }` para cruzar el estudio
 * con lo que hay hoy en el depósito.
 *
 * Un producto con variedades entra una vez por variedad (que es como se vende
 * y como se mide) y una vez entero, por si lo aprendido vino sin color.
 */
export function indiceDeStock(productos) {
  const idx = new Map();
  for (const p of (productos || [])) {
    const n = normTxt(p?.nombre);
    if (!n) continue;
    // Lo que no se repone nunca entra a una lista de compras. Un servicio se
    // cubre comprando su insumo (la resma, no la fotocopia) y algo sin control
    // de stock no puede faltar. Es la misma regla que aplican las alertas:
    // viene de `notifications.js` para que no haya dos versiones.
    if (esServicio(p) || esIlimitado(p)) continue;
    const docId = String(p.doc_id ?? p.id ?? '');
    const contenido = Number(p.conjunto_contenido) || 0;
    const colores = esConjunto(p) && Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [];
    if (colores.length) {
      let total = 0;
      for (const c of colores) {
        const u = unidadesDeVariedad(c, contenido);
        total += u;
        const k = claveProducto(n, c.color || '');
        if (!idx.has(k)) idx.set(k, { stock: u, docId, producto: p, color: c.color || '' });
      }
      const k = claveProducto(n, '');
      if (!idx.has(k)) idx.set(k, { stock: total, docId, producto: p, color: '' });
      continue;
    }
    const k = claveProducto(n, '');
    if (idx.has(k)) continue;
    const stock = esConjunto(p) ? (Number(p.conjunto_total) || 0) : (Number(p.stock) || 0);
    idx.set(k, { stock, docId, producto: p, color: '' });
  }
  return idx;
}

/**
 * Lo que conviene comprar por la época, para todas las fechas que se vienen.
 *
 * Para las que ya tienen historia sale de lo medido; para las que todavía no
 * —el local registra ventas desde abril de 2026— sale de las pistas del rubro,
 * y va marcado como corazonada. Un producto puede aparecer en dos fechas
 * distintas (el papel de regalo sirve para la Madre y para Navidad): se queda
 * con la más urgente, que siempre es la más cercana.
 *
 * `ventanas` es lo que devuelve `computarVentanas` de `urgencia_compra.js`: de
 * ahí sale el ritmo de venta que necesitan las corazonadas.
 */
export function recomendacionesDeTemporada({
  estudio, productos, ventanas, hoy = null, topePorFecha = 25, extraIds = [],
} = {}) {
  const hoyYmd = hoy || hoyAR();
  const proximas = temporadasProximas(hoyYmd);
  // Fechas que el dueño abrió a mano desde "Próximas fechas", aunque todavía
  // falte más que el plazo de aviso: si las quiere mirar en abril, se calculan.
  const pedidas = new Set((extraIds || []).filter(Boolean));
  if (pedidas.size) {
    const yaEstan = new Set(proximas.map(p => p.id));
    for (const t of fechasDelAnio(hoyYmd)) {
      if (pedidas.has(t.id) && !yaEstan.has(t.id)) proximas.push(t);
    }
  }
  if (!proximas.length) return { proximas: [], recomendaciones: [] };

  const idx = indiceDeStock(productos);
  const stockDe = clave => idx.get(clave) || null;

  // Candidatos para el camino de las pistas: todo lo del catálogo que se vende.
  // Se arma una sola vez aunque haya varias fechas sin historia.
  let candidatos = null;
  const armarCandidatos = () => {
    if (candidatos) return candidatos;
    candidatos = [];
    if (!ventanas) return candidatos;
    for (const [, info] of idx) {
      const p = info.producto;
      const nombre = normTxt(p?.nombre);
      if (!nombre) continue;
      // De un producto con variedades se compran las variedades, no el producto
      // entero: el índice tiene las dos entradas y sin esto la bolsa de organza
      // salía dos veces, una por color y otra sumando todos los colores.
      if (!info.color && Array.isArray(p?.conjunto_colores) && p.conjunto_colores.length) continue;
      const r = ritmoDe(ventanas, { nombre, color: info.color, docId: info.docId });
      if (!(r.velDia > 0)) continue;
      candidatos.push({
        nombre: p?.nombre || nombre,
        color: info.color,
        rubro: p?.rubro || '',
        subRubro: p?.sub_rubro || '',
        stock: info.stock,
        velDia: r.velDia,
        docId: info.docId,
        producto: p,
      });
    }
    return candidatos;
  };

  const mejorPorClave = new Map();
  for (const prox of proximas) {
    const medido = !!estudio?.temporadas?.[prox.grupo || prox.id];
    const recs = medido
      ? recomendarParaTemporada(prox, estudio, { stockDe, tope: topePorFecha })
      : recomendarPorPistas(prox, { candidatos: armarCandidatos(), tope: topePorFecha });
    for (const r of recs) {
      const previo = mejorPorClave.get(r.clave);
      if (!previo || r.urgencia > previo.urgencia) mejorPorClave.set(r.clave, r);
    }
  }
  return {
    proximas: proximas.map(p => ({ ...p, medida: !!estudio?.temporadas?.[p.grupo || p.id] })),
    recomendaciones: [...mejorPorClave.values()].sort((a, b) => b.urgencia - a.urgencia),
  };
}

/**
 * TODAS las fechas del almanaque que vienen en los próximos doce meses, no sólo
 * las que están a dos meses.
 *
 * Es lo que muestra el botón "Próximas fechas" del Centro de Compras: el dueño
 * quiso poder abrir cualquiera —aunque falte medio año— y ver qué convendría
 * comprar para esa. El aviso automático sigue siendo a dos meses; esto es para
 * ir a mirar.
 */
export function fechasDelAnio(hoy = null) {
  return temporadasProximas(hoy || hoyAR(), { avisoDias: 366 });
}

/** Qué sabe el estudio de una fecha: si está medida y con cuántas pasadas. */
export function estadoDeFecha(estudio, temp) {
  const datos = estudio?.temporadas?.[temp?.grupo || temp?.id];
  if (!datos) return { medida: false, veces: 0, productos: 0 };
  return {
    medida: true,
    veces: Number(datos.veces) || 1,
    productos: (datos.productos || []).length,
    colores: (datos.colores || []).map(c => c.c),
  };
}

/**
 * Ideas para una fecha que el catálogo todavía no tiene.
 *
 * `TEMPORADAS[].ideas` es una lista corta de lo que se suele vender para cada
 * fecha en una librería/regalería. No sale de las ventas del local —es
 * conocimiento del rubro— y por eso se muestra aparte y como pregunta: "esto se
 * vende para el Día de la Madre, ¿lo tenés?". Lo que ya está en el catálogo se
 * saca de la lista, así queda sólo lo que falta mirar.
 */
export function ideasQueFaltan(idTemporada, productos) {
  const temp = temporadaPorId(idTemporada);
  const ideas = temp?.ideas || [];
  if (!ideas.length || !(productos || []).length) return [];
  const textos = (productos || []).map(p => normTxt([p?.nombre, p?.sub_rubro].filter(Boolean).join(' ')));
  return ideas.filter(idea => {
    // Se busca por la palabra más significativa de la idea (la primera que no
    // sea una preposición): "bolsas de organza" se busca como "organza", que es
    // lo que de verdad figura en el nombre del producto.
    const clave = _palabraClave(idea);
    if (!clave) return false;
    return !textos.some(t => t.includes(clave));
  });
}

const _VACIAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'para', 'y', 'con', 'en', 'un', 'una']);
function _palabraClave(idea) {
  const palabras = normTxt(idea).split(' ').filter(w => w && !_VACIAS.has(w));
  if (!palabras.length) return '';
  // La más larga suele ser la específica ("organza" sobre "bolsas",
  // "escarapelas" sobre "cintas"). Se quita el plural para que "moños"
  // encuentre "MOÑO".
  const larga = palabras.slice().sort((a, b) => b.length - a.length)[0];
  return larga.replace(/(es|s)$/, '');
}

export { TEMPORADAS, temporadasProximas };
