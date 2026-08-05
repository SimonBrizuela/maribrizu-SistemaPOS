/**
 * Verifica el contraste de cada par de color que la tienda usa de verdad.
 *
 * Existe porque "se ve bien" no es un criterio: el verde y el naranja del logo
 * parecen legibles sobre blanco y dan menos de 2:1. Este script corre sobre los
 * valores reales de tokens.css, así que si alguien retoca un color y rompe un
 * par, se entera acá y no en el celular de un cliente.
 *
 *   node design/contraste.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const aca = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(aca, 'tokens.css'), 'utf8');

/** Extrae las variables de un bloque (:root o el de modo oscuro). */
function leerBloque(selector) {
  const i = css.indexOf(selector);
  if (i === -1) return {};
  const desde = css.indexOf('{', i);
  const hasta = css.indexOf('\n}', desde);
  const cuerpo = css.slice(desde, hasta);
  const vars = {};
  // Toma tanto valores literales (#7B3FA6) como alias (var(--liceo-violeta)).
  for (const m of cuerpo.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8}|var\(\s*--[\w-]+\s*\))\s*;/g)) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

/**
 * Resuelve los alias: --primary vale var(--liceo-violeta), que a su vez es un
 * hex. Sin esto el informe marcaba "sin definir" justo los pares del color
 * primario, que son los que más se usan.
 */
function resolver(vars) {
  const out = {};
  for (const clave of Object.keys(vars)) {
    let valor = vars[clave];
    let saltos = 0;
    while (valor && valor.startsWith('var(') && saltos++ < 10) {
      const ref = valor.slice(4, -1).trim();
      valor = vars[ref];
    }
    if (valor && valor.startsWith('#')) out[clave] = valor;
  }
  return out;
}

const claro  = resolver(leerBloque(':root {'));
const oscuro = resolver({ ...leerBloque(':root {'), ...leerBloque(':root[data-tema="oscuro"]') });

function aRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

/** Luminancia relativa según WCAG 2.1 */
function luminancia(hex) {
  const [r, g, b] = aRgb(hex).map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const la = luminancia(a), lb = luminancia(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/* Cada par es un uso real en components.css, no una combinación teórica.
   `minimo` sale de WCAG: 4.5 para texto normal, 3 para texto grande (>= 24px o
   >= 19px en negrita) y para bordes/iconos que transmiten información. */
const PARES = [
  // [frente, fondo, dónde se usa, mínimo]
  ['--text',      '--bg',        'texto base sobre el fondo de la página', 4.5],
  ['--text',      '--surface',   'texto dentro de una card',               4.5],
  ['--text-2',    '--surface',   'texto de apoyo, ayuda de campo',         4.5],
  ['--text-2',    '--surface-2', 'texto de apoyo sobre superficie 2',      4.5],
  ['--text-3',        '--surface',   'metadatos, placeholder, +2 colores',   4.5],
  ['--text-3',        '--surface-2', 'icono del buscador sobre su fondo',    3.0],
  ['--borde-control', '--surface',   'contorno de campo, selector, contador',3.0],

  ['--primary-txt',        '--surface',            'enlace, rubro en card',        4.5],
  ['--primary-txt',        '--primary-bg',         'ficha de rubro violeta',       4.5],
  ['--liceo-violeta-txt',  '--liceo-violeta-bg',   'ficha Librería',               4.5],
  ['--liceo-verde-txt',    '--liceo-verde-bg',     'ficha Mercería',               4.5],
  ['--liceo-naranja-txt',  '--liceo-naranja-bg',   'ficha Juguetería',             4.5],
  ['--liceo-cyan-txt',     '--liceo-cyan-bg',      'ficha Papelera',               4.5],
  ['--liceo-rojo-txt',     '--liceo-rojo-bg',      'ficha Regalería',              4.5],
  ['--liceo-verde-txt',    '--surface',            'rubro Mercería en card',       4.5],
  ['--liceo-naranja-txt',  '--surface',            'rubro Juguetería en card',     4.5],
  ['--liceo-cyan-txt',     '--surface',            'rubro Papelera en card',       4.5],
  ['--liceo-rojo-txt',     '--surface',            'rubro Regalería en card',      4.5],

  ['--exito',   '--exito-bg',   'aviso "entramos en zona"',      4.5],
  ['--alerta',  '--alerta-bg',  'aviso "nos queda lejos"',       4.5],
  ['--error',   '--error-bg',   'error de campo',                4.5],
  ['--error',   '--surface',    'texto de error sobre card',     4.5],
  ['--exito',   '--surface',    '"Gratis" en opción de retiro',  4.5],
];

/* Rellenos sólidos: cada color de marca con la tinta que le corresponde. */
const SOBRE_COLOR = [
  ['--primary-ink',          '--primary',       'texto del botón primario',          4.5],
  ['--primary-ink',          '--primary-dark',  'botón primario en hover',           4.5],
  ['--liceo-violeta-tinta',  '--liceo-violeta', 'ficha de filtro activa Librería',   4.5],
  ['--liceo-verde-tinta',    '--liceo-verde',   'ficha de filtro activa Mercería',   4.5],
  ['--liceo-naranja-tinta',  '--liceo-naranja', 'ficha de filtro activa Juguetería', 4.5],
  ['--liceo-cyan-tinta',     '--liceo-cyan',    'ficha de filtro activa Papelera',   4.5],
  ['--liceo-rojo-tinta',     '--liceo-rojo',    'ficha de filtro activa Regalería',  4.5],
  ['--exito-tinta',          '--exito-solido',  'tilde de paso cumplido',            4.5],
  ['--alerta-tinta',         '--alerta-solido', 'icono de aviso fuera de zona',      4.5],
  ['--error-tinta',          '--error-solido',  'icono de error',                    4.5],

  /* Marco negro: mismos valores en los dos modos. */
  ['--ink-texto',   '--ink-superficie',   'texto sobre el negro de marca',        4.5],
  ['--ink-texto-2', '--ink-superficie',   'texto de apoyo sobre el negro',        4.5],
  ['--ink-texto',   '--ink-superficie-2', 'texto sobre el negro secundario',      4.5],
  ['--ink-borde',   '--ink-superficie',   'separador dentro del marco negro',     1.2],
];

function evaluar(vars, titulo) {
  console.log(`\n${'='.repeat(78)}\n  ${titulo}\n${'='.repeat(78)}`);
  let fallos = 0;

  const filas = [...PARES, ...SOBRE_COLOR].map(
    ([f, b, uso, min]) => [vars[f], vars[b], uso, min, `${f} / ${b}`]
  );

  for (const [frente, fondo, uso, min, etiqueta] of filas) {
    if (!frente || !fondo) {
      console.log(`  ?  ${etiqueta.padEnd(42)} sin definir`);
      continue;
    }
    const r = ratio(frente, fondo);
    const pasa = r >= min;
    if (!pasa) fallos++;
    const marca = pasa ? '✓' : '✗';
    console.log(
      `  ${marca}  ${uso.padEnd(36)} ${r.toFixed(2).padStart(5)}:1  (min ${min})  ${etiqueta}`
    );
  }

  console.log(`\n  ${fallos === 0 ? 'Sin fallos' : `${fallos} par(es) por debajo del minimo`}`);
  return fallos;
}

const fallosClaro  = evaluar(claro,  'MODO CLARO');
const fallosOscuro = evaluar(oscuro, 'MODO OSCURO');

process.exitCode = (fallosClaro + fallosOscuro) > 0 ? 1 : 0;
