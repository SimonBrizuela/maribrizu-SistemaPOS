/**
 * Cómo el panel arma un grupo de tamaños a partir de los nombres.
 *
 * "Cierre Común 10 cm", "Cierre Común 12 cm", "Cierre Común 14 cm" son el
 * mismo producto en tres tamaños: el nombre del grupo es lo que comparten
 * ("Cierre Común") y la etiqueta de cada uno es lo que les queda propio
 * ("10 cm"). Esto lo precalcula para que armar un grupo sea tildar productos
 * y apretar guardar, sin tipear nada dos veces.
 *
 * Lógica pura, sin Firebase: la prueban tienda/pruebas/grupos_panel.test.js.
 */

// Palabras que no pueden quedar colgando al final del nombre de un grupo:
// "Cinta Raso Nº" o "Goma Eva de" no son nombres, son frases cortadas.
const COLGANTES = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'con',
                           'sin', 'para', 'por', 'a', 'en', 'x', 'nº', 'n°',
                           'no.', 'numero', 'número']);

const tieneDigito = (s) => /\d/.test(s || '');

// Unidades que acompañan a un número en los nombres del catálogo.
const UNIDADES = new Set(['ml', 'mm', 'cm', 'cms', 'm', 'mt', 'mts', 'mtr', 'mtrs',
                          'gr', 'grs', 'g', 'kg', 'kgs', 'lt', 'lts', 'l', 'cc',
                          'hjs', 'hs', 'hojas', 'u', 'un', 'unid', 'w', 'v']);

function palabrasDe(nombre) {
  return String(nombre || '').trim().split(/\s+/).filter(Boolean);
}

function sinColgantes(palabras) {
  const salida = palabras.slice();
  while (salida.length && COLGANTES.has(salida[salida.length - 1].toLowerCase())) {
    salida.pop();
  }
  return salida;
}

/**
 * Las palabras que TODOS los nombres comparten al principio, sin dejar una
 * frase cortada: de "Cinta Raso Nº 1" y "Cinta Raso Nº 3" sale "Cinta Raso",
 * no "Cinta Raso Nº".
 */
export function prefijoComun(nombres) {
  const listas = (nombres || []).map(palabrasDe).filter(l => l.length);
  if (!listas.length) return '';

  const [primera, ...resto] = listas;
  const comunes = [];
  for (const [i, palabra] of primera.entries()) {
    const igualEnTodos = resto.every(l => l[i]?.toLowerCase() === palabra.toLowerCase());
    if (!igualEnTodos) break;
    comunes.push(palabra);
  }
  return sinColgantes(comunes).join(' ');
}

/**
 * Lo que le queda propio a un nombre después del prefijo del grupo:
 * "Cierre Común 10 cm" menos "Cierre Común" es "10 cm". Si el nombre no
 * empieza con el prefijo, no se puede derivar nada y queda vacío para que lo
 * escriba una persona.
 */
export function restoDeNombre(nombre, prefijo) {
  const palabras = palabrasDe(nombre);
  const delPrefijo = palabrasDe(prefijo);
  if (!delPrefijo.length) return '';

  const coincide = delPrefijo.every(
    (p, i) => palabras[i]?.toLowerCase() === p.toLowerCase());
  if (!coincide) return '';
  return palabras.slice(delPrefijo.length).join(' ');
}

/**
 * El nombre sin la cola de medida: "Cierre Común 10 cm" → "Cierre Común".
 * Es lo que sirve de arranque cuando el grupo nace de UN solo producto y
 * todavía no hay con qué comparar.
 */
export function nombreBaseDe(nombre) {
  const palabras = palabrasDe(nombre);
  let corte = palabras.length;
  while (corte > 1) {
    const palabra = palabras[corte - 1].toLowerCase();
    const esMedida = tieneDigito(palabra) || UNIDADES.has(palabra.replace(/\.$/, ''));
    if (!esMedida) break;
    corte -= 1;
  }
  return sinColgantes(palabras.slice(0, corte)).join(' ');
}

/**
 * La propuesta entera: el nombre del grupo y la etiqueta de cada producto.
 * Con un solo nombre se recorta la medida; con varios, manda lo que
 * comparten. Las etiquetas que no se pueden derivar quedan vacías.
 */
export function sugerirGrupo(nombres) {
  const lista = (nombres || []).filter(Boolean);
  if (!lista.length) return { grupo: '', tamanos: [] };

  const grupo = lista.length === 1
    ? nombreBaseDe(lista[0])
    : (prefijoComun(lista) || nombreBaseDe(lista[0]));

  return { grupo, tamanos: lista.map(n => restoDeNombre(n, grupo)) };
}
