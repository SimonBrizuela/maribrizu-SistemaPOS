/**
 * Bultos: expresar stock y umbrales en cajas / packs / rollos en vez de unidades.
 *
 * Un "bulto" es el contenedor con el que se compra el producto (caja de 12,
 * pack de 24, rollo de 50 m). El contenido se resuelve en este orden:
 *
 *   1. `bulto_contenido` + `bulto_tipo`  → cargado a mano en el editor.
 *   2. Producto Conjunto                 → `conjunto_contenido` + `conjunto_tipo`.
 *   3. Nombre del producto               → "CAJA X 12", "X 24 UN", "DOCENA"…
 *
 * `stock_min` y `stock_max` SIEMPRE se guardan en unidades base: el POS, el
 * Centro de Compras y el resto de la webapp los siguen leyendo igual. Lo único
 * que cambia con `stock_alerta_um: 'bulto'` es cómo se escriben y cómo se
 * muestran: el editor convierte cajas ⇄ unidades y los avisos dicen
 * "quedan 2 cajas" en vez de "quedan 24".
 */

export const TIPOS_BULTO = {
  caja:     { sg: 'caja',     pl: 'cajas' },
  pack:     { sg: 'pack',     pl: 'packs' },
  rollo:    { sg: 'rollo',    pl: 'rollos' },
  bolsa:    { sg: 'bolsa',    pl: 'bolsas' },
  blister:  { sg: 'blíster',  pl: 'blísters' },
  display:  { sg: 'display',  pl: 'displays' },
  plancha:  { sg: 'plancha',  pl: 'planchas' },
  bobina:   { sg: 'bobina',   pl: 'bobinas' },
  paquete:  { sg: 'paquete',  pl: 'paquetes' },
  docena:   { sg: 'docena',   pl: 'docenas' },
  resma:    { sg: 'resma',    pl: 'resmas' },
  set:      { sg: 'set',      pl: 'sets' },
  tira:     { sg: 'tira',     pl: 'tiras' },
};

// conjunto_tipo (POS) → tipo de bulto
const TIPO_DESDE_CONJUNTO = {
  rollo: 'rollo', pack: 'pack', caja: 'caja', bobina: 'bobina', bolsa: 'bolsa',
  plancha: 'plancha', cartulina: 'paquete', papel: 'paquete', carton: 'paquete',
  goma_eva: 'plancha', cinta: 'rollo', tela: 'rollo', unidad: 'caja', otro: 'caja',
};

function _num(n) { return Number(n) || 0; }
function _esConjunto(p) { return p && (p.es_conjunto === true || p.es_conjunto === 1); }

export function labelTipo(tipo) {
  return TIPOS_BULTO[String(tipo || '').toLowerCase()] || TIPOS_BULTO.caja;
}

// ── Detección desde el nombre ────────────────────────────────────────────────
// Deliberadamente conservadora: ante la duda no se detecta nada. Un falso
// positivo haría que el aviso salga con la cantidad equivocada, que es peor que
// no tener la función (el usuario siempre puede cargar el contenido a mano).
//
// Se descartan las cifras seguidas de una unidad de medida ("X 100GR" es peso,
// no cantidad) y las medidas del tipo "48 X 40".
const UM_SUFIJO = '(?!\\s*(?:GRS?|G|KGS?|KG|ML|CC|LTS?|LT|L|CM|MM|MTS?|MT|M|W|V|A|PULG|")\\b)';
// Descarta medidas ("CAJA 10 X 10", "SET 30 X 45") y códigos de artículo
// ("BOLSA 1505/03"): si el número sigue con otra cifra o con una barra, no es
// una cantidad por envase.
const NO_MEDIDA = '(?!\\s*[/×xX]\\s*\\d)(?!\\s*[/-]\\d)';

const PATRONES = [
  // "CAJA X 12", "PACK DE 24", "BLISTER X 6". El conector (X/POR/DE) es
  // obligatorio: sin él, "CAJA 10 X 10" o "BOLSA 1505/03" darían falsos positivos.
  { re: new RegExp(`\\b(CAJAS?|CJ|PACKS?|BLI?STERS?|BL[IÍ]STERS?|DISPLAYS?|BOLSAS?|SETS?|ESTUCHES?|PAQUETES?|PAQ|BANDEJAS?|PLANCHAS?|ROLLOS?|TIRAS?)\\s*(?:X|POR|DE)\\s*(\\d{1,4})\\b${NO_MEDIDA}${UM_SUFIJO}`, 'i'),
    tipo: m => _tipoDePalabra(m[1]), contenido: m => parseInt(m[2], 10) },
  // "X 12 UN", "POR 24 UNIDADES"
  { re: new RegExp(`\\b(?:X|POR)\\s*(\\d{1,4})\\s*(?:U|UN|UNI|UNID|UNIDS?|UNIDADES?)\\b${NO_MEDIDA}`, 'i'),
    tipo: () => 'caja', contenido: m => parseInt(m[1], 10) },
  { re: /\bMEDIAS?\s+DOCENAS?\b/i, tipo: () => 'docena', contenido: () => 6 },
  { re: /\bDOCENAS?\b/i,           tipo: () => 'docena', contenido: () => 12 },
  // Resma: 500 hojas salvo que el nombre diga otra cosa ("RESMA A4 120 GR X 100").
  { re: /\bRESMAS?\b/i, tipo: () => 'resma', contenido: (m, txt) => _ultimoXN(txt) || 500 },
];

// Último "X <número>" del nombre que sea una cantidad y no una medida
// ("22 X 34 X 70GR X 500" → 500).
function _ultimoXN(txt) {
  const re = new RegExp(`\\bX\\s*(\\d{1,4})\\b${NO_MEDIDA}${UM_SUFIJO}`, 'gi');
  let m, ultimo = null;
  while ((m = re.exec(String(txt || '')))) ultimo = parseInt(m[1], 10);
  return ultimo && ultimo > 1 ? ultimo : null;
}

function _tipoDePalabra(w) {
  const s = String(w || '').toLowerCase();
  if (s.startsWith('caj') || s === 'cj') return 'caja';
  if (s.startsWith('pack')) return 'pack';
  if (s.startsWith('bli') || s.startsWith('blí')) return 'blister';
  if (s.startsWith('display')) return 'display';
  if (s.startsWith('bolsa')) return 'bolsa';
  if (s.startsWith('set')) return 'set';
  if (s.startsWith('plancha')) return 'plancha';
  if (s.startsWith('rollo')) return 'rollo';
  if (s.startsWith('tira')) return 'tira';
  return 'paquete';
}

/**
 * Intenta deducir el bulto desde el nombre del producto.
 * @returns {{tipo: string, contenido: number}|null}
 */
export function detectarBulto(nombre) {
  const txt = String(nombre || '');
  if (!txt) return null;
  for (const p of PATRONES) {
    const m = txt.match(p.re);
    if (!m) continue;
    const contenido = p.contenido(m, txt);
    if (!(contenido > 1) || contenido > 10000) continue;
    return { tipo: p.tipo(m), contenido };
  }
  return null;
}

/**
 * Bulto efectivo de un producto (manual → conjunto → nombre).
 * @returns {{tipo, contenido, fuente, sg, pl}|null}
 */
export function bultoDe(p) {
  if (!p) return null;
  const manual = _num(p.bulto_contenido);
  if (manual > 1) {
    const tipo = String(p.bulto_tipo || 'caja').toLowerCase();
    return { tipo, contenido: manual, fuente: 'manual', ...labelTipo(tipo) };
  }
  if (_esConjunto(p)) {
    const cont = _num(p.conjunto_contenido);
    if (cont > 1) {
      const tipo = TIPO_DESDE_CONJUNTO[String(p.conjunto_tipo || '').toLowerCase()] || 'caja';
      return { tipo, contenido: cont, fuente: 'conjunto', ...labelTipo(tipo) };
    }
  }
  const det = detectarBulto(p.nombre || p.name);
  if (det) return { ...det, fuente: 'nombre', ...labelTipo(det.tipo) };
  return null;
}

/** ¿El producto tiene configurado avisar por bulto y hay bulto disponible? */
export function alertaPorBulto(p) {
  if (!p || p.stock_alerta_um !== 'bulto') return null;
  return bultoDe(p);
}

// ── Conversión ───────────────────────────────────────────────────────────────
export function aUnidades(cantBultos, bulto) {
  const c = _num(bulto && bulto.contenido);
  if (!(c > 0)) return _num(cantBultos);
  return Math.round(_num(cantBultos) * c * 10000) / 10000;
}

export function aBultos(unidades, bulto) {
  const c = _num(bulto && bulto.contenido);
  if (!(c > 0)) return _num(unidades);
  return Math.round((_num(unidades) / c) * 10000) / 10000;
}

function _fmt(n) {
  const v = Math.round(_num(n) * 100) / 100;
  return v.toLocaleString('es-AR', { maximumFractionDigits: 2 });
}

/**
 * Texto de una cantidad expresada en bultos: "3 cajas", "2 cajas + 5 u",
 * "8 u (menos de 1 caja)". `exacto: true` fuerza el decimal ("1,5 cajas") para
 * umbrales, donde el resto suelto no aporta.
 */
export function textoBultos(unidades, bulto, { exacto = false } = {}) {
  const u = _num(unidades);
  if (!bulto || !(bulto.contenido > 0)) return `${_fmt(u)} u`;
  if (exacto) {
    const b = aBultos(u, bulto);
    return `${_fmt(b)} ${b === 1 ? bulto.sg : bulto.pl}`;
  }
  const enteros = Math.floor(u / bulto.contenido);
  const resto = Math.round((u - enteros * bulto.contenido) * 100) / 100;
  if (enteros <= 0) return `${_fmt(u)} u (menos de 1 ${bulto.sg})`;
  const base = `${_fmt(enteros)} ${enteros === 1 ? bulto.sg : bulto.pl}`;
  return resto > 0 ? `${base} + ${_fmt(resto)} u` : base;
}

/** "24 u = 2 cajas de 12" — para hints del editor. */
export function textoEquivalencia(unidades, bulto) {
  if (!bulto || !(bulto.contenido > 0)) return '';
  const b = aBultos(unidades, bulto);
  return `${_fmt(unidades)} u = ${_fmt(b)} ${b === 1 ? bulto.sg : bulto.pl} de ${_fmt(bulto.contenido)}`;
}
