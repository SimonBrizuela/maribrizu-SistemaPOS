// ── Filtros de la lista del Centro de Compras ─────────────────────────────────
// Lógica pura (sin DOM): qué renglones se ven según los filtros elegidos
// (rubro, subrubro, proveedor, marca, nivel), el buscador y la marca "en el
// cuaderno". Todo se combina en Y: cada filtro achica lo que dejó el anterior,
// y el buscador busca adentro de lo que quedó.
//
// Los valores se comparan por clave normalizada (sin acentos, minúscula,
// espacios colapsados): en el catálogo conviven "LIBRERÍA" y "LIBRERIA" y
// tienen que ser el mismo rubro para el que filtra. Los productos sin valor en
// un campo (sin proveedor, sin marca) también se pueden elegir: van como la
// opción "Sin proveedor" al final de la lista.

export const SIN_VALOR = '__sin__';

export const CAMPOS_FILTRO = [
  { k: 'rubro',     label: 'Rubro',     todos: 'Todos los rubros',      sin: 'Sin rubro' },
  { k: 'sub_rubro', label: 'Subrubro',  todos: 'Todos los subrubros',   sin: 'Sin subrubro' },
  { k: 'proveedor', label: 'Proveedor', todos: 'Todos los proveedores', sin: 'Sin proveedor' },
  { k: 'marca',     label: 'Marca',     todos: 'Todas las marcas',      sin: 'Sin marca' },
  { k: 'nivel',     label: 'Nivel',     todos: 'Todos los niveles',     sin: '' },
];

export const NIVELES = [
  { k: 'sisi',       label: 'Sí o sí' },
  { k: 'importante', label: 'Importante' },
  { k: 'opcional',   label: 'Puede esperar' },
];
const NIVEL_LABEL = Object.fromEntries(NIVELES.map(n => [n.k, n.label]));
const NIVEL_ORDEN = Object.fromEntries(NIVELES.map((n, i) => [n.k, i]));

// Clave de comparación: sin acentos, minúscula, un solo espacio entre palabras.
export function claveFiltro(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

export function filtrosVacios() {
  const out = {};
  for (const c of CAMPOS_FILTRO) out[c.k] = '';
  return out;
}

// Deja solo los campos conocidos con valores de texto (lo que vuelve de
// sessionStorage o de cualquier lado no se confía a ciegas).
export function sanearFiltros(raw) {
  const out = filtrosVacios();
  if (!raw || typeof raw !== 'object') return out;
  for (const c of CAMPOS_FILTRO) {
    const v = raw[c.k];
    if (typeof v === 'string' && v.trim()) out[c.k] = v.trim();
  }
  return out;
}

export function cantidadFiltros(filtros) {
  return CAMPOS_FILTRO.reduce((n, c) => n + (filtros?.[c.k] ? 1 : 0), 0);
}

// Valor crudo del renglón para un campo. El nivel es la prioridad calculada
// (`tier`); el resto son campos del producto copiados al renglón.
function valorDe(row, campo) {
  if (campo === 'nivel') return row.tier || '';
  return row[campo] ?? '';
}

function coincideValor(crudo, elegido) {
  const clave = claveFiltro(crudo);
  if (elegido === SIN_VALOR) return clave === '';
  return clave === claveFiltro(elegido);
}

// Texto por el que busca la lupa: nombre (base y de la alerta), variante,
// código, rubro, subrubro, proveedor y marca, todo normalizado. Así "resma
// pampa papelera" encuentra la resma del proveedor PAPELERA aunque no diga
// "papelera" en el nombre.
export function textoBusquedaCompra(row) {
  return claveFiltro([
    row.nombre, row.producto?.nombre, row.esVariedad ? row.variedad : '',
    row.codigo, row.rubro, row.sub_rubro, row.proveedor, row.marca,
  ].filter(Boolean).join(' '));
}

export function tokensBusqueda(busqueda) {
  return claveFiltro(busqueda).split(' ').filter(Boolean);
}

// ¿El renglón pasa los criterios? `ignorar` saca un campo de la evaluación:
// sirve para armar las opciones de ESE select con todo lo demás aplicado.
// Todas las palabras del buscador tienen que estar, en cualquier orden
// ("goma borrar" encuentra "GOMA DE BORRAR").
export function coincideCompra(row, criterios, ignorar = null) {
  const filtros = criterios?.filtros || {};
  if (criterios?.soloAnotados && !(row.anotado && !row.registrado)) return false;
  for (const c of CAMPOS_FILTRO) {
    if (c.k === ignorar) continue;
    const elegido = filtros[c.k];
    if (!elegido) continue;
    if (!coincideValor(valorDe(row, c.k), elegido)) return false;
  }
  const toks = tokensBusqueda(criterios?.busqueda || '');
  if (toks.length) {
    const texto = row.busca != null ? row.busca : textoBusquedaCompra(row);
    if (!toks.every(t => texto.includes(t))) return false;
  }
  return true;
}

// Opciones de un select con la cuenta de renglones que quedarían al elegir
// cada una, calculada sobre lo que pasa TODOS los otros criterios (los demás
// selects, el buscador y el cuaderno). La etiqueta es la variante más usada
// del texto (si conviven "Librería" y "LIBRERIA", gana la que más aparece).
// La opción ya elegida se mantiene aunque quede en cero, para poder sacarla.
export function opcionesCompras(rows, criterios, campo) {
  const def = CAMPOS_FILTRO.find(c => c.k === campo);
  if (!def) return [];
  const mapa = new Map();   // clave → { valor, n, variantes: Map(texto → veces) }
  for (const r of rows || []) {
    if (!coincideCompra(r, criterios, campo)) continue;
    const crudo = String(valorDe(r, campo) ?? '').trim();
    const clave = claveFiltro(crudo);
    if (!clave && campo === 'nivel') continue;
    const valor = clave || SIN_VALOR;
    let e = mapa.get(valor);
    if (!e) { e = { valor, n: 0, variantes: new Map() }; mapa.set(valor, e); }
    e.n++;
    if (clave) e.variantes.set(crudo, (e.variantes.get(crudo) || 0) + 1);
  }
  const elegido = criterios?.filtros?.[campo] || '';
  const claveElegida = elegido === SIN_VALOR ? SIN_VALOR : claveFiltro(elegido);
  if (claveElegida && !mapa.has(claveElegida)) {
    const variantes = new Map();
    if (claveElegida !== SIN_VALOR) variantes.set(elegido, 1);
    mapa.set(claveElegida, { valor: claveElegida, n: 0, variantes });
  }
  const out = [];
  for (const e of mapa.values()) {
    let label;
    if (e.valor === SIN_VALOR) label = def.sin;
    else if (campo === 'nivel') label = NIVEL_LABEL[e.valor] || e.valor;
    else label = [...e.variantes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))[0]?.[0] || e.valor;
    out.push({ valor: e.valor, label, n: e.n });
  }
  out.sort((a, b) => {
    if (a.valor === SIN_VALOR) return 1;
    if (b.valor === SIN_VALOR) return -1;
    if (campo === 'nivel') return (NIVEL_ORDEN[a.valor] ?? 9) - (NIVEL_ORDEN[b.valor] ?? 9);
    return a.label.localeCompare(b.label, 'es', { sensitivity: 'base' });
  });
  return out;
}

// ¿Algún renglón de la lista tiene valor en este campo? Si ninguno lo tiene
// (un catálogo sin marcas cargadas), el select de ese campo no se muestra.
export function campoTieneValores(rows, campo) {
  if (campo === 'nivel' || campo === 'rubro') return true;
  return (rows || []).some(r => claveFiltro(valorDe(r, campo)) !== '');
}
