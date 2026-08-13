// Theming central de la webapp.
// Modo claro = original (default). Modo oscuro slate opt-in, persistido en localStorage.
// El data-theme se setea en <html>; un script anti-FOUC en index.html lo aplica
// antes del primer paint para evitar flash claro al recargar en oscuro.

const STORAGE_KEY = 'll-theme';
const listeners = new Set();

/** Devuelve 'light' | 'dark' segun el atributo aplicado (fuente de verdad visual). */
export function getTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Aplica un tema, lo persiste y notifica a los suscriptores. */
export function setTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(STORAGE_KEY, t); } catch (_) {}
  listeners.forEach(cb => { try { cb(t); } catch (_) {} });
  return t;
}

/** Alterna entre claro y oscuro. Devuelve el tema resultante. */
export function toggleTheme() {
  return setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

/**
 * Suscribe un callback a los cambios de tema. Devuelve una funcion para desuscribir.
 * Lo usan dashboard/control_total para reconstruir sus charts (el canvas hornea colores).
 */
export function onThemeChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Lee una CSS custom property resuelta del :root, para pasarla al canvas.
 * Ej: cssVar('--chart-grid'). Devuelve string trimmeado o el fallback.
 */
export function cssVar(name, fallback = '') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v && v.trim()) || fallback;
}

/**
 * Inicializa el tema desde localStorage (default claro).
 * El script anti-FOUC ya lo aplico; esto lo deja consistente si el script no corrio.
 */
export function initTheme() {
  let saved = 'light';
  try { saved = localStorage.getItem(STORAGE_KEY) || 'light'; } catch (_) {}
  if (getTheme() !== saved) document.documentElement.setAttribute('data-theme', saved);
  return getTheme();
}
