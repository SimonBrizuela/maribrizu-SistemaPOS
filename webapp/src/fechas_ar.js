// ── Fechas del almanaque argentino ────────────────────────────────────────────
// Las cuentas que hacen falta para saber en qué día cae una fecha que se mueve
// todos los años: el Domingo de Pascua (y todo lo que cuelga de él: Carnaval,
// Semana Santa) y los "tercer domingo de tal mes" (Día del Padre, del Niño, de
// la Madre).
//
// Vive aparte porque la usan DOS cosas que no se pueden importar entre sí:
//
//   · `pages/calendario_core.js`, que pinta el almanaque y necesita Firebase;
//   · `temporadas.js`, que decide qué comprar para cada fecha y tiene que ser
//     lógica pura para poder correrse en las pruebas y contra un volcado de
//     Firestore, sin navegador.
//
// Si cada uno tuviera su copia, el calendario y el aviso de compra podrían
// terminar marcando días distintos para el mismo Día de la Madre. Con una sola
// cuenta, eso no puede pasar.

/** Suma (o resta, con n negativo) días a un Date, sin tocar el original. */
export function addDays(date, n) {
  const x = new Date(date);
  x.setDate(x.getDate() + n);
  return x;
}

/** Un Date a "YYYY-MM-DD", en hora local (que es la del mostrador). */
export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "YYYY-MM-DD" a Date local (mediodía, para que ningún huso lo corra de día). */
export function deYmd(s) {
  const [y, m, d] = String(s || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** Días entre dos fechas "YYYY-MM-DD" (b − a). Negativo si b es anterior. */
export function diasEntre(a, b) {
  const [ay, am, ad] = String(a || '').split('-').map(Number);
  const [by, bm, bd] = String(b || '').split('-').map(Number);
  if (!ay || !by) return 0;
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** "YYYY-MM-DD" más (o menos) n días, como string. */
export function sumarDiasYmd(s, n) {
  const [y, m, d] = String(s || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Domingo de Pascua del año `y` (algoritmo de Meeus/Jones/Butcher).
 * De acá cuelgan Carnaval (−48 y −47) y la Semana Santa (−3 y −2).
 */
export function pascua(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, mes - 1, dia);
}

/**
 * N-ésimo domingo de un mes (`month` 0-indexado, n=1 → primer domingo).
 * Así se fijan el Día del Padre (3º de junio), el del Niño (3º de agosto) y el
 * de la Madre (3º de octubre).
 */
export function domingoN(y, month, n) {
  const first = new Date(y, month, 1);
  const offset = (7 - first.getDay()) % 7;   // días hasta el primer domingo
  return new Date(y, month, 1 + offset + (n - 1) * 7);
}
