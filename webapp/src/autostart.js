/**
 * Autostart — arranque de la app con Windows.
 *
 * Solo aplica dentro del .exe (Tauri). En la web por navegador no hace nada.
 * La primera vez que se abre el exe, registra el autostart una sola vez; a
 * partir de ahí respeta lo que el usuario elija con el toggle "Iniciar con
 * Windows" (no lo vuelve a forzar en cada apertura).
 */

const FLAG = 'll-autostart-init';

export function isTauriApp() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

let _apiPromise = null;
function api() {
  if (!_apiPromise) _apiPromise = import('@tauri-apps/plugin-autostart');
  return _apiPromise;
}

/** Primera ejecución: activa el autostart una sola vez. Idempotente. */
export async function initAutostart() {
  if (!isTauriApp()) return;
  try {
    if (localStorage.getItem(FLAG)) return;
    localStorage.setItem(FLAG, '1');
    const { enable, isEnabled } = await api();
    if (!(await isEnabled())) await enable();
  } catch (err) {
    console.warn('[autostart] init', err);
  }
}

/** ¿Está registrado el arranque con Windows? */
export async function getAutostart() {
  if (!isTauriApp()) return false;
  try {
    const { isEnabled } = await api();
    return await isEnabled();
  } catch (err) {
    console.warn('[autostart] isEnabled', err);
    return false;
  }
}

/** Activa o desactiva el arranque con Windows. */
export async function setAutostart(on) {
  if (!isTauriApp()) return;
  const { enable, disable } = await api();
  if (on) await enable();
  else await disable();
}
