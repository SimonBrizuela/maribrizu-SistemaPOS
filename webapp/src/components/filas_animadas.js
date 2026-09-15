/**
 * Filas de tabla que se van y llegan sin saltos.
 *
 * Un renglón que desaparece de golpe hace saltar la tabla entera: lo que estaba
 * debajo del mouse pasa a ser otro producto y se pierde el hilo. Acá el renglón
 * se desvanece corriéndose un poco y después se cierra el hueco que dejó, de a
 * poco, así lo de abajo sube acompañando. Al entrar es al revés: se abre el
 * lugar y la fila aparece.
 *
 * El hueco es una fila de mentira con una sola celda que ocupa todas las
 * columnas: a una `<tr>` no se le puede animar el alto, a un `<div>` sí. Cerrar
 * el hueco en vez de deslizar las filas de abajo (FLIP) es a propósito: con FLIP
 * el borde y el fondo de la tabla saltaban al tamaño final mientras las filas
 * todavía venían bajando, y se las veía pasar por afuera de la tabla.
 *
 * Con Web Animations y no con clases de CSS: no quedan estilos colgados en las
 * filas. Lo que no puede fallar nunca es que la fila se vaya: sin soporte de
 * animaciones, con la pestaña en segundo plano (el navegador frena los cuadros)
 * o con una animación cancelada, se saca igual.
 *
 * Con movimiento reducido pedido por el sistema, nada se desplaza ni se achica:
 * solo se desvanece.
 */

const SALIDA_MS = 180;
const CIERRE_MS = 240;
const APERTURA_MS = 220;
const APARICION_MS = 240;
const REDUCIDO_MS = 140;
// El lugar se abre y se cierra con una curva pareja; la fila aparece con una
// que arranca rápido y frena al llegar.
const CURVA_ALTO = 'cubic-bezier(.4, 0, .2, 1)';
const CURVA = 'cubic-bezier(.2, .8, .2, 1)';
// Red de seguridad sobre la duración, por si `finished` no llega nunca.
const MARGEN_MS = 200;

export function movimientoReducido() {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch (_) {
    return false;
  }
}

const puedeAnimar = nodo => typeof nodo?.animate === 'function';

/** Anima y espera a que termine, o a que pase lo que tenía que durar. */
function animar(nodo, cuadros, opciones) {
  if (!puedeAnimar(nodo)) return Promise.resolve();
  let animacion;
  try {
    animacion = nodo.animate(cuadros, opciones);
  } catch (_) {
    return Promise.resolve();
  }
  const fin = animacion?.finished ? animacion.finished.catch(() => {}) : Promise.resolve();
  const espera = (opciones.duration || 0) + (opciones.delay || 0) + MARGEN_MS;
  return Promise.race([fin, new Promise(r => setTimeout(r, espera))]);
}

function cortarAnimaciones(nodo) {
  if (typeof nodo?.getAnimations !== 'function') return;
  for (const a of nodo.getAnimations()) {
    try { a.cancel(); } catch (_) { /* ya estaba terminada */ }
  }
}

function crearHueco(columnas, alto) {
  const hueco = document.createElement('tr');
  hueco.className = 'fila-hueco';
  hueco.setAttribute('aria-hidden', 'true');
  const celda = document.createElement('td');
  celda.colSpan = Math.max(1, columnas);
  celda.style.cssText = 'padding:0;border:0';
  const relleno = document.createElement('div');
  relleno.style.height = `${alto}px`;
  celda.appendChild(relleno);
  hueco.appendChild(celda);
  return hueco;
}

/**
 * Saca una fila de su tabla: se desvanece y después se cierra su lugar.
 * Desde el primer momento queda marcada `data-saliendo` y con los botones
 * apagados, para que no se la cuente como viva ni se la apriete dos veces.
 */
export async function sacarFila(fila) {
  if (!fila?.isConnected) return;
  fila.setAttribute('data-saliendo', '');
  fila.querySelectorAll('button').forEach(b => { b.disabled = true; });

  if (movimientoReducido()) {
    await animar(fila, [{ opacity: 1 }, { opacity: 0 }],
                 { duration: REDUCIDO_MS, easing: 'ease-out', fill: 'forwards' });
    fila.remove();
    return;
  }

  await animar(fila,
    [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '28px 0' }],
    { duration: SALIDA_MS, easing: 'ease-in', fill: 'forwards' });
  if (!fila.isConnected) return;       // la tabla se repintó entera mientras tanto
  if (!puedeAnimar(fila)) { fila.remove(); return; }

  const alto = fila.getBoundingClientRect().height;
  const hueco = crearHueco(fila.cells.length, alto);
  fila.replaceWith(hueco);
  await animar(hueco.firstChild.firstChild,
    [{ height: `${alto}px` }, { height: '0px' }],
    { duration: CIERRE_MS, easing: CURVA_ALTO, fill: 'forwards' });
  hueco.remove();
}

/**
 * Pone una fila en la tabla con `colocar()` (que decide dónde va): primero se
 * abre su lugar y después aparece.
 */
export async function meterFila(fila, colocar) {
  colocar();
  if (!puedeAnimar(fila)) return;

  if (movimientoReducido()) {
    await animar(fila, [{ opacity: 0 }, { opacity: 1 }],
                 { duration: REDUCIDO_MS, easing: 'ease-out' });
    return;
  }

  // Se mide ya puesta y se la cambia por el hueco antes de que se dibuje nada.
  const alto = fila.getBoundingClientRect().height;
  const hueco = crearHueco(fila.cells.length, 0);
  fila.replaceWith(hueco);
  await animar(hueco.firstChild.firstChild,
    [{ height: '0px' }, { height: `${alto}px` }],
    { duration: APERTURA_MS, easing: CURVA_ALTO, fill: 'forwards' });
  // Si la tabla se repintó mientras se abría el lugar, la fila ya no va.
  if (!hueco.isConnected) return;
  hueco.replaceWith(fila);
  await animar(fila,
    [{ opacity: 0, translate: '-20px 0' }, { opacity: 1, translate: '0 0' }],
    { duration: APARICION_MS, easing: CURVA });
}

/*
 * Una caja que se abre y se cierra (la lista de ocultos). Se puede apretar
 * rápido: cada vez arranca desde el alto que tiene en ese momento, no desde
 * cerrada o abierta del todo, y una animación que quedó vieja no toca nada al
 * terminar. Medido cuadro a cuadro antes de esto: con clicks seguidos la caja
 * saltaba de 135 a 360 px o de 250 a 0 en un solo cuadro, y a veces la lista no
 * aparecía porque un cierre viejo cortaba la apertura nueva.
 */

const CAJA_MS = 280;

async function moverAlto(caja, { abrir, llenar = null, vaciar = null }) {
  if (!caja) return false;
  const turno = (caja._turnoAlto || 0) + 1;
  caja._turnoAlto = turno;

  if (!puedeAnimar(caja) || movimientoReducido()) {
    cortarAnimaciones(caja);
    llenar?.();
    vaciar?.();
    caja.style.overflow = '';
    return true;
  }

  // El alto que se ve ahora, con lo que se estuviera moviendo: desde ahí sigue.
  const desde = caja.getBoundingClientRect().height;
  cortarAnimaciones(caja);
  llenar?.();
  const hasta = abrir ? caja.scrollHeight : 0;
  caja.style.overflow = 'hidden';
  // Lo que falta recorrer, no el recorrido entero: cerrar una caja abierta a
  // medias no tiene por qué tardar lo mismo que cerrarla entera.
  const falta = Math.abs(hasta - desde) / Math.max(hasta, desde, 1);
  await animar(caja, [{ height: `${desde}px` }, { height: `${hasta}px` }],
    { duration: Math.max(120, Math.round(CAJA_MS * falta)), easing: CURVA_ALTO, fill: 'forwards' });

  // Otro click la tomó mientras tanto: esa decide cómo termina.
  if (caja._turnoAlto !== turno) return false;
  vaciar?.();
  cortarAnimaciones(caja);
  caja.style.overflow = '';
  return true;
}

/** Abre una caja; `llenar()` le pone el contenido justo antes de medirla. */
export function desplegar(caja, llenar = null) {
  return moverAlto(caja, { abrir: true, llenar });
}

/**
 * Cierra una caja y la vacía con `vaciar()` al terminar. La animación se corta
 * recién después de vaciarla: si quedara puesta, la caja seguiría en alto cero
 * la próxima vez que se abra.
 */
export function plegar(caja, vaciar = null) {
  return moverAlto(caja, { abrir: false, vaciar });
}
