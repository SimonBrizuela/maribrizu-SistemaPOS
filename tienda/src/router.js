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

  window.addEventListener('popstate', () => {
    // El "atrás" que sacó la entrada de una capa cerrada con su propio botón.
    if (_ignorarVuelta) { _ignorarVuelta = false; return; }
    // El "atrás" con una capa abierta la cierra y deja la página como estaba.
    if (_capa) {
      const cerrar = _capa;
      _capa = null;
      cerrar();
      return;
    }
    alCambiar?.();
  });
}

/* ── Capas que usan el botón atrás ─────────────────────────────────────────
   En el celular el "atrás" es el gesto para salir de lo que se abrió encima
   (el visor de fotos). Sin esto sacaba al cliente de la ficha, y volver era
   esperar a que se cargue de nuevo y buscar dónde estaba. */
let _capa = null;
let _ignorarVuelta = false;

/**
 * Pone una entrada en el historial para una capa que se abre encima de la
 * página. El "atrás" llama a `alVolver` en vez de navegar.
 *
 * Devuelve `soltar()`, para cuando la capa se cierra con su propio botón: saca
 * la entrada que había puesto sin que la página se entere.
 */
export function capaConHistorial(alVolver) {
  window.history.pushState({ capa: true }, '', window.location.href);
  _capa = alVolver;
  return {
    soltar() {
      if (_capa !== alVolver) return;   // ya la cerró el "atrás"
      _capa = null;
      _ignorarVuelta = true;
      window.history.back();
    },
  };
}
