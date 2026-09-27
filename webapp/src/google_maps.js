/**
 * Carga del mapa interactivo de Google (Maps JavaScript API) para el panel.
 *
 * Lo usa el editor de la zona de reparto. Se carga recién cuando se abre, no
 * con el panel: son unos cientos de KB y cada carga cuenta en la cuota de
 * Google.
 *
 * La clave no vive en el código porque el repositorio es público. Está en
 * `config/google_maps` (campo `clave_navegador`), que solo lee el staff según
 * las reglas. Igual es una clave de navegador: viaja al navegador de quien
 * abre el editor, y por eso está restringida en Google Cloud a la Maps
 * JavaScript API y a los dominios del panel (admin.liceolibreria.com y
 * localhost:3000). Desde cualquier otro sitio no sirve.
 *
 * La clave de la tienda (Places, Routes, Static) es otra y se queda en el
 * servidor: esa no puede restringirse por dominio.
 */
import { doc, getDoc } from 'firebase/firestore';

let _promesa = null;
let _fallaDeClave = null;
const _alFallar = new Set();

/**
 * @returns {Promise<typeof google.maps>}
 */
export function cargarGoogleMaps(db) {
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  if (_promesa) return _promesa;

  _promesa = (async () => {
    const snap = await getDoc(doc(db, 'config', 'google_maps'));
    const clave = snap.exists() ? String(snap.data().clave_navegador || '').trim() : '';
    if (!clave) throw new Error('Falta la clave del mapa (config/google_maps).');

    await new Promise((listo, fallo) => {
      const nombre = `__mapaListo${Date.now()}`;
      window[nombre] = () => { delete window[nombre]; listo(); };

      // Google llama a esta función global cuando rechaza la clave (dominio no
      // autorizado, API apagada, sin facturación). Llega DESPUÉS de cargar el
      // script, así que no alcanza con el onerror: se avisa a quien tenga un
      // mapa abierto.
      window.gm_authFailure = () => {
        _fallaDeClave = 'Google rechazó la clave del mapa para este dominio.';
        _alFallar.forEach(fn => fn(_fallaDeClave));
      };

      const script = document.createElement('script');
      script.src = 'https://maps.googleapis.com/maps/api/js'
        + `?key=${encodeURIComponent(clave)}&v=weekly&language=es-419&region=AR`
        + `&loading=async&callback=${nombre}`;
      script.async = true;
      script.onerror = () => fallo(new Error('No se pudo descargar el mapa de Google.'));
      document.head.appendChild(script);
    });

    return window.google.maps;
  })();

  // Si falló, el próximo intento vuelve a probar en vez de quedarse con el error.
  _promesa.catch(() => { _promesa = null; });
  return _promesa;
}

/** Avisa si Google rechaza la clave. Devuelve con qué desengancharse. */
export function alFallarLaClave(fn) {
  if (_fallaDeClave) fn(_fallaDeClave);
  _alFallar.add(fn);
  return () => _alFallar.delete(fn);
}
