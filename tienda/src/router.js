/**
 * Ruteo con la History API.
 *
 * URLs de verdad, no con almohadilla: cada producto tiene su direccion propia,
 * se puede compartir por WhatsApp y Google la puede indexar. Netlify ya reenvia
 * todo a index.html, y Vite hace lo mismo en desarrollo.
 */

const rutas = [];
let alCambiar = null;

/**
 * @param {string} patron  '/p/:id' — los tramos con dos puntos son parametros
 * @param {Function} vista  recibe ({ params, query })
 */
export function ruta(patron, vista) {
  const nombres = [];
  const expresion = new RegExp('^' + patron
    .replace(/\/:([^/]+)/g, (_, nombre) => { nombres.push(nombre); return '/([^/]+)'; })
    .replace(/\//g, '\\/') + '$');
  rutas.push({ expresion, nombres, vista });
}

export function alNavegar(fn) {
  alCambiar = fn;
}

/** Resuelve la URL actual y devuelve { vista, params, query, ruta }. */
export function resolver() {
  const url = new URL(window.location.href);
  const camino = url.pathname.replace(/\/+$/, '') || '/';

  for (const { expresion, nombres, vista } of rutas) {
    const coincide = camino.match(expresion);
    if (!coincide) continue;
    const params = {};
    nombres.forEach((nombre, i) => { params[nombre] = decodeURIComponent(coincide[i + 1]); });
    return { vista, params, query: url.searchParams, ruta: camino };
  }
  return { vista: null, params: {}, query: url.searchParams, ruta: camino };
}

/** Navega sin recargar. */
export function ir(destino, { reemplazar = false } = {}) {
  if (destino === window.location.pathname + window.location.search) return;
  if (reemplazar) window.history.replaceState({}, '', destino);
  else window.history.pushState({}, '', destino);
  alCambiar?.();
}

/**
 * Engancha los enlaces internos.
 *
 * Se delega en el documento en vez de recorrer los enlaces: cada vez que se
 * repinta una grilla habria que volver a engancharlos uno por uno.
 */
export function iniciar() {
  document.addEventListener('click', ev => {
    // Respeta ctrl+clic, clic del medio y "abrir en pestaña nueva".
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey ||
        ev.shiftKey || ev.altKey) return;

    const enlace = ev.target.closest('a');
    if (!enlace) return;
    if (enlace.target === '_blank' || enlace.hasAttribute('download')) return;

    const href = enlace.getAttribute('href');
    if (!href || !href.startsWith('/')) return;

    ev.preventDefault();
    ir(href);
  });

  window.addEventListener('popstate', () => alCambiar?.());
}
