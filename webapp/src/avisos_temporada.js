// ── Aviso de la fecha que se viene ────────────────────────────────────────────
// "Se viene Halloween, preparate mirando qué artículos." Pedido del dueño el
// 21/09/2026: no alcanza con que la información esté en el Centro de Compras,
// tiene que venir a buscarlo a él, y de un click abrirse con todo.
//
// Sale al entrar al panel, una sola vez por día y por fecha: un aviso que
// aparece cada vez que se cambia de pantalla se vuelve ruido y se aprende a
// ignorar, que es lo peor que le puede pasar a un aviso.
//
// El click lleva al Centro de Compras con el panel de fechas abierto en esa
// fecha, que es donde está la lista y la explicación.

import { mostrarToast } from './components/toasts.js';
import { temporadasProximas, cuandoEs } from './temporadas.js';

// La v1 marcaba el aviso como visto antes de mostrarlo, y como no era
// prioritario la pila lo podaba enseguida: quedaban marcadas fechas que nadie
// llegó a leer. La clave nueva descarta esas marcas inválidas.
const LS_VISTOS = 'temporadas:avisadas:v2';
/**
 * Cuántas fechas se avisan de una.
 *
 * Una. El dueño dijo que le parecían muchos mensajes, y tenía razón: con dos
 * fechas encima se entraba al panel con dos carteles que hay que cerrar antes
 * de trabajar. La que viene primero es la que importa; la otra está en la
 * franja del Tablero y en el Centro de Compras, sin interrumpir nada.
 */
const MAX_AVISOS = 1;
/**
 * Los primeros días son para enterarse; después ya lo sabe y molesta.
 *
 * Eran siete, o sea una semana entera de cartel todos los días por la misma
 * fecha. Con dos alcanza para que no se le pase, y a partir del tercero pasa a
 * una vez por semana como el resto.
 */
const DIAS_INSISTIR = 2;

function hoyAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

/** { "<id de la fecha>": "YYYY-MM-DD del último aviso" } */
function leerVistos() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_VISTOS) || '{}');
    return (raw && typeof raw === 'object') ? raw : {};
  } catch (_) {
    return {};   // storage bloqueado o cache corrupto: se avisa igual
  }
}

function marcarVisto(id, dia) {
  try {
    const vistos = leerVistos();
    vistos[id] = dia;
    // Limpieza: lo de hace más de un año ya no sirve para nada.
    const limite = String(Number(dia.slice(0, 4)) - 1) + dia.slice(4);
    for (const k of Object.keys(vistos)) if (vistos[k] < limite) delete vistos[k];
    localStorage.setItem(LS_VISTOS, JSON.stringify(vistos));
  } catch (_) { /* sin storage: el aviso sale una vez por sesión y ya */ }
}

/**
 * Qué fechas hay que avisar hoy.
 *
 * Se avisa cuando la fecha entra en su plazo (dos meses) y sólo una vez por
 * día. Los primeros días desde que entró se insiste todos los días; después,
 * una vez por semana, hasta que arranca la venta — ahí vuelve a salir todos
 * los días, porque ya es tarde para encargar y lo que queda es acomodar lo que
 * hay.
 */
export function avisosPendientes(hoy = null, proximas = null) {
  const dia = hoy || hoyAR();
  const lista = proximas || temporadasProximas(dia);
  const vistos = leerVistos();
  const out = [];
  for (const t of lista) {
    const ultimo = vistos[t.id] || '';
    if (ultimo === dia) continue;                 // ya se avisó hoy
    const reciénEntró = (t.plazoAviso - t.diasFaltan) <= DIAS_INSISTIR;
    // Una época larga en curso (tres meses de comuniones) no insiste todos los
    // días: taparía a las fechas cortas que caen adentro, y con un aviso por
    // vez el Día de la Madre no saldría nunca.
    const enCursoLarga = t.larga && t.diasFaltan <= 0;
    const insiste = reciénEntró || (t.enVenta && !enCursoLarga);
    if (!insiste && ultimo) {
      // Fuera de esos tramos, una vez por semana alcanza para no olvidarse.
      const hace = Math.round((Date.parse(dia) - Date.parse(ultimo)) / 86400000);
      if (Number.isFinite(hace) && hace < 7) continue;
    }
    out.push(t);
    if (out.length >= MAX_AVISOS) break;
  }
  return out;
}

/** El texto del aviso, en criollo y sin sonar a cartel automático. */
export function textoAviso(t) {
  if (t.larga && t.enVenta && t.diasFaltan <= 0) return `Es época de ${t.nombre}: sigue ${cuandoEs(t)}`;
  if (t.enVenta) {
    return t.diasFaltan <= 0
      ? `${t.nombre} es hoy`
      : `${t.nombre} es en ${t.diasFaltan} día${t.diasFaltan === 1 ? '' : 's'} y ya se está vendiendo`;
  }
  return `Se viene ${t.nombre}: faltan ${t.diasFaltan} días`;
}

function detalleAviso(t) {
  if (t.larga && t.enVenta) return 'Todavía llegás a reponer lo que se va vendiendo.';
  if (t.enVenta) return 'Fijate qué te queda en el depósito; para encargar ya es tarde.';
  return 'Preparate mirando qué artículos conviene tener. Todavía llegás a encargar.';
}

/**
 * Muestra los avisos de las fechas que se vienen.
 *
 * `navegar(id)` lo pone quien llama: es el que sabe cómo cambiar de pantalla.
 */
export function mostrarAvisosTemporada({ navegar = null, hoy = null, proximas = null } = {}) {
  const dia = hoy || hoyAR();
  let pendientes = [];
  try {
    pendientes = avisosPendientes(dia, proximas);
  } catch (e) {
    console.warn('[temporadas] no se pudieron calcular los avisos:', e);
    return [];
  }
  for (const t of pendientes) {
    mostrarToast({
      // Naranja cuando ya arrancó la venta (hay que moverse), violeta cuando
      // todavía hay tiempo: el rojo queda para lo que se está quedando sin
      // stock hoy, que es otra urgencia.
      tono: t.enVenta ? 'naranja' : 'violeta',
      etiqueta: 'Fecha que se viene',
      icono: 'event',
      titulo: textoAviso(t),
      detalleHtml: `${detalleAviso(t)}${t.nota ? ` <span class="ll-toast-sep">·</span>${_escape(t.nota)}` : ''}`,
      acciones: [{ id: 'ver', texto: 'Ver qué conviene comprar', principal: true }],
      duracion: 0,          // queda hasta que lo cierren: es para decidir, no para mirar de reojo
      // Prioritario, si no no se ve: la pila muestra cuatro avisos y poda
      // primero los comunes. Al arrancar el panel entran los de stock bajo, que
      // son muchos, y se llevaban puesto el de la fecha antes de que nadie lo
      // leyera — y encima quedaba marcado como visto por el resto del día.
      prioritario: true,
      onAccion: (accion, api) => {
        if (accion !== 'ver') return;
        api.cerrar();
        if (typeof navegar === 'function') navegar(t.id);
      },
    });
    // Se marca recién cuando el aviso ya está en pantalla.
    marcarVisto(t.id, dia);
  }
  return pendientes;
}

function _escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Engancha el aviso al arranque del panel.
 *
 * Espera un poco: al entrar, la pantalla está cargando datos y un aviso encima
 * del primer pintado se pierde. `navegarA` recibe el id de la fecha.
 */
let _timer = null;

export function initAvisosTemporada({ navegarA = null, demoraMs = 2500 } = {}) {
  // Una sola vez por sesión. Sin esto, cada arranque del panel dejaba su propio
  // temporizador colgado y los avisos se apilaban de a varios.
  if (_timer) return;
  _timer = setTimeout(() => {
    _timer = null;
    // Sólo si el panel sigue en pantalla. Entre que se agenda y que dispara
    // pueden pasar cosas —cerrar sesión, recargar— y un aviso pegado a un
    // documento que ya no es el del panel no le sirve a nadie.
    if (!document.getElementById('app')) return;
    mostrarAvisosTemporada({ navegar: navegarA });
  }, demoraMs);
}

/** Cancela el aviso pendiente. Para las pruebas y para poder rearmar. */
export function detenerAvisosTemporada() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}
