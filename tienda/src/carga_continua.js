/**
 * Cargar más solo, al acercarse al final de una lista.
 *
 * Hacia abajo en el catálogo y hacia el costado en las tiras de la portada. Un
 * elemento vacío al final de la lista (el centinela) avisa cuando se acerca a
 * la vista, y ahí se pide la tanda siguiente. Se adelanta con `margen`: la
 * tanda nueva ya está puesta cuando el dedo llega, en vez de aparecer después.
 *
 * Probado en `pruebas/carga_continua.test.js`.
 */

/**
 * @param {object}   o
 * @param {Element}  o.centinela   el elemento al final de la lista
 * @param {Function} o.cargar      async () => hayMas: pone la tanda y dice si queda algo
 * @param {Element}  [o.raiz]      el contenedor que scrollea (null = la página)
 * @param {boolean}  [o.horizontal] se acerca por la derecha y no por abajo
 * @param {string}   [o.margen]    cuánto antes del final empieza a cargar
 * @param {Function} [o.alCargar]  (cargando: boolean) => void, para mostrar que está trayendo
 * @param {Function} [o.alTerminar] cuando ya no queda nada
 * @param {Function} [o.alFallar]  (error, reintentar) => void
 * @returns {{detener: Function}|null} null si el navegador no sabe mirar: queda el botón
 */
export function cargaContinua({
  centinela, cargar, raiz = null, horizontal = false, margen = '800px',
  alCargar = null, alTerminar = null, alFallar = null,
}) {
  if (typeof IntersectionObserver !== 'function' || !centinela) return null;

  let cargando = false;
  let terminado = false;

  const observador = new IntersectionObserver(entradas => {
    if (!centinela.isConnected) { detener(); return; }
    if (entradas.some(e => e.isIntersecting)) traer();
  }, {
    root: raiz,
    rootMargin: horizontal ? `0px ${margen} 0px 0px` : `0px 0px ${margen} 0px`,
  });

  function detener() {
    terminado = true;
    observador.disconnect();
  }

  async function traer() {
    if (cargando || terminado) return;
    cargando = true;
    alCargar?.(true);
    let hayMas;
    try {
      hayMas = await cargar();
    } catch (err) {
      console.warn('[carga] no se pudo traer la tanda siguiente:', err?.message || err);
      cargando = false;
      alCargar?.(false);
      // Deja de mirar hasta que se reintente a mano: sin esto, con la red caída
      // y el final a la vista, pediría la misma tanda en un bucle.
      observador.unobserve(centinela);
      alFallar?.(err, () => { observador.observe(centinela); traer(); });
      return;
    }
    cargando = false;
    alCargar?.(false);
    if (!hayMas || !centinela.isConnected) {
      detener();
      if (!hayMas) alTerminar?.();
      return;
    }
    // Volver a observar hace que el navegador avise con el estado actual: si la
    // tanda nueva no alcanzó a empujar el final fuera de la vista, entra otra.
    observador.unobserve(centinela);
    observador.observe(centinela);
  }

  observador.observe(centinela);
  return { detener };
}
