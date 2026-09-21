/**
 * A cuánto está el dólar, del lado del panel.
 *
 * Los productos que se compran en dólares guardan el precio en dólares y se
 * cobran en pesos con la cotización del momento (ver `precio_usd.js`). Acá se
 * consigue esa cotización, con la misma regla que el POS: una sola consulta
 * entre todos.
 *
 * El valor vive en UN documento, `config/cotizacion_usd`, que comparten el
 * panel y las cinco cajas:
 *
 *     valor             1550        a cuánto está
 *     tipo              'blue'      cuál se usa: blue, oficial o tarjeta
 *     fuente            'dolarapi'  quién lo trajo
 *     manual            false       true = lo cargó el dueño a mano y manda
 *     actualizado       ISO         cuándo
 *     refresco_minutos  30          cada cuánto se sale a internet
 *
 * Si el documento está al día, el panel lo usa y no consulta nada: capaz lo
 * acaba de traer una caja. Si está vencido, espera unos segundos al azar (para
 * no salir junto con las PCs), mira de nuevo por si alguien se adelantó, y
 * recién ahí consulta la API y lo deja escrito para todos.
 *
 * Gemelo de `pos_system/utils/cotizacion_usd.py`. Los números de acá
 * (cada cuánto se refresca) no cambian ningún precio: si los dos lados se
 * desfasan, lo único que pasa es que uno consulta más seguido que el otro.
 * La cuenta del precio, que sí tiene que dar igual, está en `precio_usd.js`.
 */
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { cotizacionValida } from './precio_usd.js';
import {
  cotizacionEnMemoria, valorActual, recordarCotizacion, olvidarCotizacion,
} from './cotizacion_memoria.js';

// El último valor conocido vive en `cotizacion_memoria.js`, sin Firebase, para
// que lo pueda leer `tienda_espejo.js` (que lo importan las pruebas de la
// tienda). Se reexporta desde acá para no tener que saber eso en cada pantalla.
export { cotizacionEnMemoria, valorActual };

// De dónde sale cada dólar. Dos proveedores y no uno: el día que el primero
// deje de andar, el local no se queda sin poder actualizar los precios de lo
// importado. Se lee el precio de VENTA, que es lo que cuesta reponer.
export const FUENTES = {
  blue: [
    ['https://dolarapi.com/v1/dolares/blue', ['venta']],
    ['https://api.bluelytics.com.ar/v2/latest', ['blue', 'value_sell']],
  ],
  oficial: [
    ['https://dolarapi.com/v1/dolares/oficial', ['venta']],
    ['https://api.bluelytics.com.ar/v2/latest', ['oficial', 'value_sell']],
  ],
  tarjeta: [
    ['https://dolarapi.com/v1/dolares/tarjeta', ['venta']],
  ],
};

export const TIPOS = {
  blue:    'Dólar blue',
  oficial: 'Dólar oficial',
  tarjeta: 'Dólar tarjeta',
  manual:  'Cargado a mano',
};

export const TIPO_DEFAULT = 'blue';

const COLECCION = 'config';
const DOCUMENTO = 'cotizacion_usd';

// Cada cuánto, entre el panel y TODAS las cajas juntas, se sale a internet.
const REFRESCO_MINUTOS = 30;

// Antes de salir a la API, esperar un rato al azar dentro de esta ventana.
const VENTANA_DESFASAJE_MS = 4000;

// Cuánto se espera a la API antes de dejarlo por imposible.
const TIMEOUT_MS = 6000;

let _pidiendo = null;        // promesa en curso, para no salir dos veces

/** Lo que venga leído como número. */
function numero(v, porDefecto = 0) {
  if (v === null || v === undefined || v === '' || v === false) return porDefecto;
  const n = Number(v);
  return Number.isFinite(n) ? n : porDefecto;
}

function ahora() { return Date.now(); }

/** Un `actualizado` como los que escriben el panel y el POS, en milisegundos. */
export function msDeActualizado(valor) {
  if (!valor) return 0;
  // Timestamp de Firestore.
  if (typeof valor?.toMillis === 'function') {
    try { return valor.toMillis(); } catch { return 0; }
  }
  if (valor instanceof Date) return valor.getTime();
  if (typeof valor === 'number') return valor > 1e11 ? valor : valor * 1000;
  const t = Date.parse(String(valor));
  return Number.isFinite(t) ? t : 0;
}

/**
 * El documento compartido, leído con cuidado. null si no sirve para nada.
 *
 * Todo lo que entra viene de la nube y lo pudo escribir cualquiera de las seis
 * puntas: un valor roto acá multiplicaría los precios de todo el local.
 */
export function leerDocumento(d) {
  if (!d || typeof d !== 'object') return null;
  if (!cotizacionValida(d.valor)) return null;
  const minutos = numero(d.refresco_minutos, REFRESCO_MINUTOS) || REFRESCO_MINUTOS;
  return {
    valor: Number(d.valor),
    tipo: String(d.tipo || TIPO_DEFAULT).trim().toLowerCase(),
    fuente: String(d.fuente || '').trim(),
    manual: d.manual === true,
    ts: msDeActualizado(d.actualizado),
    refrescoMinutos: Math.min(Math.max(minutos, 1), 24 * 60),
  };
}

/** La edad del valor en minutos. null si no hay valor o no se sabe de cuándo es. */
export function edadMinutos(cot) {
  if (!cot || !cot.ts) return null;
  return (ahora() - cot.ts) / 60000;
}

/**
 * True si a la cotización se le pasó la hora y le toca a alguien salir.
 *
 * Una cargada a mano no vence nunca: es una decisión del dueño, no una lectura.
 */
export function estaVencida(cot) {
  if (!cot || !cotizacionValida(cot.valor)) return true;
  if (cot.manual) return false;
  const edad = edadMinutos(cot);
  if (edad === null) return true;
  return edad > (cot.refrescoMinutos || REFRESCO_MINUTOS);
}

const recordar = recordarCotizacion;

/** El documento de Firestore. null si no existe o no se pudo leer. */
export async function leerCotizacion(db) {
  try {
    const snap = await getDoc(doc(db, COLECCION, DOCUMENTO));
    if (!snap.exists()) return null;
    const cot = leerDocumento(snap.data());
    return cot ? recordar(cot) : null;
  } catch (e) {
    console.warn('[cotizacion] no se pudo leer:', e?.message || e);
    return null;
  }
}

/**
 * Se queda escuchando el documento: cuando una caja consigue el valor nuevo,
 * el panel lo muestra en el acto. Devuelve la función para dejar de escuchar.
 */
export function escucharCotizacion(db, alCambiar) {
  try {
    return onSnapshot(doc(db, COLECCION, DOCUMENTO), (snap) => {
      const cot = snap.exists() ? leerDocumento(snap.data()) : null;
      if (cot) recordar(cot);
      try { alCambiar(cot); } catch (e) { console.warn('[cotizacion]', e); }
    }, (e) => console.warn('[cotizacion] listener:', e?.message || e));
  } catch (e) {
    console.warn('[cotizacion] no se pudo escuchar:', e?.message || e);
    return () => {};
  }
}

/** Un número de una API, o null. Nunca tira. */
async function pedirA(url, camino) {
  const control = new AbortController();
  const corte = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: control.signal, cache: 'no-store' });
    if (!resp.ok) return null;
    let d = await resp.json();
    for (const paso of camino) {
      if (!d || typeof d !== 'object') return null;
      d = d[paso];
    }
    return cotizacionValida(d) ? Number(d) : null;
  } catch (e) {
    console.warn(`[cotizacion] ${url} no contestó:`, e?.message || e);
    return null;
  } finally {
    clearTimeout(corte);
  }
}

/** El dólar de internet. null si ninguna fuente contesta algo usable. */
export async function pedirALaApi(tipo = TIPO_DEFAULT) {
  for (const [url, camino] of (FUENTES[tipo] || FUENTES[TIPO_DEFAULT])) {
    const valor = await pedirA(url, camino);
    if (valor !== null) return { valor, tipo, url };
  }
  return null;
}

/** Deja el valor escrito para el panel y las cinco cajas. */
export async function guardarCotizacion(db, { valor, tipo, fuente, manual, refrescoMinutos }) {
  if (!cotizacionValida(valor)) return null;
  const datos = {
    valor: Number(valor),
    tipo: String(tipo || TIPO_DEFAULT).trim().toLowerCase(),
    fuente: fuente || 'dolarapi',
    manual: manual === true,
    actualizado: new Date().toISOString(),
  };
  if (refrescoMinutos) datos.refresco_minutos = Math.min(Math.max(Number(refrescoMinutos), 1), 24 * 60);
  await setDoc(doc(db, COLECCION, DOCUMENTO), datos, { merge: true });
  return recordar({ ...datos, ts: ahora(), refrescoMinutos: datos.refresco_minutos || REFRESCO_MINUTOS });
}

/**
 * La cotización lista para usar, saliendo a internet solo si hace falta.
 *
 * Es la función que usa la pantalla: devuelve siempre lo mejor que haya,
 * incluso si todo falla (en ese caso, null, y el precio en pesos guardado
 * sigue siendo válido).
 *
 * `forzar` saltea la edad y consulta igual — es el botón "Actualizar".
 * `desfasajeMs` es la ventana de espera antes de salir; las pruebas la ponen
 * en cero para no quedarse esperando de gusto.
 */
export async function asegurarCotizacion(db, { forzar = false, desfasajeMs = VENTANA_DESFASAJE_MS } = {}) {
  if (_pidiendo) return _pidiendo;

  _pidiendo = (async () => {
    let cot = await leerCotizacion(db);
    if (cot && cot.manual && !forzar) return cot;
    if (cot && !estaVencida(cot) && !forzar) return cot;

    const tipo = (cot && cot.tipo && cot.tipo !== 'manual') ? cot.tipo : TIPO_DEFAULT;

    // Desfasaje: si el panel y las cajas ven el documento vencido al mismo
    // tiempo, sin esto salen todos juntos. Al volver se mira de nuevo por si
    // alguno se adelantó. En el forzado no se espera: lo pidió una persona.
    //
    // Si no hay NINGUNA cotización todavía (primera vez, documento vacío)
    // tampoco se espera: no hay ningún valor que se pueda estar pisando y
    // alguien tiene que traer el primero.
    if (!forzar && cot && desfasajeMs > 0) {
      await new Promise(r => setTimeout(r, Math.random() * desfasajeMs));
      const denuevo = await leerCotizacion(db);
      if (denuevo && !estaVencida(denuevo)) return denuevo;
      if (denuevo) cot = denuevo;
    }

    const traido = await pedirALaApi(tipo);
    if (!traido) return cot;             // lo viejo sigue siendo mejor que nada

    try {
      return await guardarCotizacion(db, {
        valor: traido.valor, tipo, fuente: 'dolarapi', manual: false,
      });
    } catch (e) {
      console.warn('[cotizacion] no se pudo guardar:', e?.message || e);
      return recordar({
        valor: traido.valor, tipo, fuente: 'dolarapi', manual: false,
        ts: ahora(), refrescoMinutos: cot?.refrescoMinutos || REFRESCO_MINUTOS,
      });
    }
  })();

  try {
    return await _pidiendo;
  } finally {
    _pidiendo = null;
  }
}

/**
 * Fija el dólar a dedo. Queda así hasta que se vuelva a un tipo automático.
 *
 * Sirve cuando el proveedor cobra a un dólar propio, o cuando la API dice
 * cualquier cosa y hay que vender igual.
 */
export async function fijarAMano(db, valor, tipo = 'manual') {
  if (!cotizacionValida(valor)) return null;
  return guardarCotizacion(db, { valor, tipo, fuente: 'a mano', manual: true });
}

/** Vuelve a un dólar automático y sale a buscarlo ahora mismo. */
export async function usarTipo(db, tipo) {
  const elegido = FUENTES[tipo] ? tipo : TIPO_DEFAULT;
  const traido = await pedirALaApi(elegido);
  if (!traido) {
    // Sin internet igual se deja anotado el tipo elegido, para la próxima.
    const actual = cotizacionEnMemoria();
    if (!actual) return null;
    return guardarCotizacion(db, {
      valor: actual.valor, tipo: elegido, fuente: actual.fuente || 'local', manual: false,
    });
  }
  return guardarCotizacion(db, {
    valor: traido.valor, tipo: elegido, fuente: 'dolarapi', manual: false,
  });
}

/** Solo para las pruebas: vuelve a empezar de cero. */
export function _olvidarTodo() {
  _pidiendo = null;
  olvidarCotizacion();
}
