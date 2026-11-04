// ── El cuaderno se refresca una vez por semana ───────────────────────────────
// Pedido del dueño (03/11/2026): los jueves y viernes van al centro con lo
// anotado. Lo que no se consiguió queda marcado, se va al fondo de la lista y
// como la recorren de arriba para abajo no lo vuelven a pedir. Un día por
// semana, solo, lo que sigue marcado y sigue faltando se desmarca y vuelve a
// su lugar por prioridad.
//
// Reglas:
//   · el refresco corre el día elegido (lunes por defecto), la primera vez que
//     alguien abre el Centro de Compras desde ese día; si nadie entra el lunes,
//     corre el martes y hace lo mismo que hubiera hecho el lunes;
//   · desmarca lo anotado ANTES de ese día. Lo anotado ese mismo día o después
//     es para el viaje que viene y no se toca;
//   · solo lo que sigue en la lista: si sigue ahí es porque sigue faltando
//     (no entró stock, o entró menos de lo que hace falta). Lo que ya se
//     repuso salió de la lista y su marca caduca sola como siempre;
//   · una sola vez por semana: queda guardado hasta qué día se refrescó.
//
// Lógica pura, sin Firebase ni DOM: se prueba en
// `tienda/pruebas/cuaderno_refresco.test.js`.

export const DIA_REFRESCO_DEFAULT = 1;   // lunes (0 = domingo, como Date)
export const SIN_REFRESCO = -1;

export const DIAS_SEMANA = [
  'domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado',
];

/** El día elegido en la config: 0–6, o SIN_REFRESCO. Sin elegir, el lunes. */
export function diaDeRefresco(cfg) {
  const v = cfg?.cuaderno_refresco_dia;
  if (v === undefined || v === null || v === '') return DIA_REFRESCO_DEFAULT;
  const n = Number(v);
  if (n === SIN_REFRESCO) return SIN_REFRESCO;
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : DIA_REFRESCO_DEFAULT;
}

function _desdeYmd(ymd) {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

/** El último `dia` de la semana que cae hoy o antes ("YYYY-MM-DD"). */
export function ultimoDiaDeRefresco(hoyYmd, dia) {
  const hoy = _desdeYmd(hoyYmd);
  if (!hoy || !(dia >= 0 && dia <= 6)) return '';
  const atras = (hoy.getUTCDay() - dia + 7) % 7;
  return new Date(hoy.getTime() - atras * 86400000).toISOString().slice(0, 10);
}

/**
 * Qué desmarcar hoy.
 *   anotados        → mapa clave → "YYYY-MM-DD" de control_config/compras
 *   enLista         → claves de lo que hoy figura en la lista (sin registrar)
 *   refrescadoHasta → `cuaderno_refrescado` guardado (el último corte hecho)
 * Devuelve { corte, desmarcar: { clave: fecha } }. `corte` vacío = no toca
 * refrescar (ya se hizo esta semana o está apagado).
 */
export function planRefrescoCuaderno({ anotados = {}, enLista, hoyYmd, dia = DIA_REFRESCO_DEFAULT, refrescadoHasta = '' } = {}) {
  const corte = ultimoDiaDeRefresco(hoyYmd, dia);
  if (!corte || String(refrescadoHasta || '') >= corte) return { corte: '', desmarcar: {} };
  const desmarcar = {};
  for (const [clave, fecha] of Object.entries(anotados || {})) {
    if (typeof fecha !== 'string' || !fecha) continue;
    if (fecha >= corte) continue;
    if (enLista && !enLista.has(clave)) continue;
    desmarcar[clave] = fecha;
  }
  return { corte, desmarcar };
}

/** "el lunes 02/11" para el aviso. */
export function textoCorte(corte) {
  const d = _desdeYmd(corte);
  if (!d) return '';
  return `el ${DIAS_SEMANA[d.getUTCDay()]} ${corte.slice(8, 10)}/${corte.slice(5, 7)}`;
}
