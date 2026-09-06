/**
 * Estadísticas de uso de la tienda: las reglas, sin ninguna dependencia.
 *
 * Qué buscan los clientes, qué fichas abren, qué agregan al pedido, cuándo
 * entran y de dónde vienen. Tres piezas comparten estas reglas:
 *
 *   · `medicion.js` (el navegador) arma los eventos y los manda en tandas.
 *   · `netlify/functions/medir.mjs` (el servidor) los revisa y los suma en un
 *     documento por día de `tienda_estadisticas`, con la cuenta de servicio.
 *   · `webapp/src/pages/tienda_estadisticas.js` (el panel) junta los días y
 *     arma los rankings.
 *
 * Lo que se guarda son CONTADORES, no eventos sueltos ni personas: no hay
 * identificador de visitante en la base, ni teléfono, ni texto libre del
 * chat. Un término de búsqueda que parece un teléfono o un correo se
 * descarta antes de contarlo.
 *
 * El documento de un día tiene esta forma:
 *
 *   {
 *     dia: '2026-09-06',
 *     visitas, visitantes_nuevos, paginas, busquedas, busquedas_sin_resultado,
 *     fichas, carrito, checkouts, chat,
 *     horas:        { '9': n, '17': n },            páginas vistas por hora
 *     dispositivos: { movil: n, escritorio: n },
 *     origenes:     { instagram: n, directo: n },
 *     rubros:       { LIBRERIA: { vistas: n } },     catálogo abierto por rubro
 *     terminos:     { 'cuaderno': { n, sin } },      búsquedas por término
 *     productos:    { '1035115': { vistas, carrito, nombre, rubro } },
 *   }
 */
import { normalizar } from './formato.js';

export const TIPOS = ['visita', 'pagina', 'busqueda', 'ficha', 'carrito', 'checkout', 'chat'];
export const PANTALLAS = ['inicio', 'catalogo', 'producto', 'checkout', 'pedido', 'seguimiento', 'cuenta'];
export const DISPOSITIVOS = ['movil', 'escritorio'];
/** Los orígenes con nombre; cualquier otro `utm_source` entra como su propia clave. */
export const ORIGENES = ['directo', 'instagram', 'whatsapp', 'facebook', 'google', 'otro'];

export const MAX_EVENTOS = 40;
export const MAX_TERMINO = 60;
export const MAX_NOMBRE = 120;

/* ── Hora de Argentina ────────────────────────────────────────────────────── */

// Córdoba es UTC−3 todo el año: no hay horario de verano que acomodar.
const DESFASE_AR_MS = 3 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' del instante, en hora argentina. */
export function claveDeDia(ms) {
  return new Date(ms - DESFASE_AR_MS).toISOString().slice(0, 10);
}

/** La hora (0–23) del instante, en hora argentina. */
export function horaLocal(ms) {
  return new Date(ms - DESFASE_AR_MS).getUTCHours();
}

/** El instante en que empieza ese día ('YYYY-MM-DD') en Argentina. */
export function inicioDelDia(dia) {
  return Date.parse(`${dia}T00:00:00-03:00`);
}

/** Los días ('YYYY-MM-DD') desde `desde` hasta `hasta`, ambos incluidos. */
export function diasEntre(desde, hasta) {
  const salida = [];
  for (let t = inicioDelDia(desde); t <= inicioDelDia(hasta); t += 24 * 60 * 60 * 1000) {
    salida.push(claveDeDia(t + DESFASE_AR_MS));
  }
  return salida;
}

/* ── Limpieza de lo que manda el navegador ────────────────────────────────── */

const RE_TELEFONO = /\d{6,}/;
const RE_CORREO = /@/;
const RE_ID_PRODUCTO = /^[A-Za-z0-9_-]{1,40}$/;
const RE_CLAVE_ORIGEN = /^[a-z0-9_]{1,24}$/;

/**
 * Un término de búsqueda como se cuenta: minúsculas, sin tildes ni signos,
 * con un solo espacio entre palabras y como mucho 60 caracteres.
 *
 * Devuelve null si no queda nada útil, o si parece un dato personal: seis
 * dígitos seguidos son un teléfono, una arroba es un correo. Eso no se cuenta.
 */
export function limpiarTermino(texto) {
  const plano = normalizar(texto)
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TERMINO)
    .trim();
  if (plano.length < 2) return null;
  // "351 555 0001" es un teléfono aunque venga con espacios: se juntan los
  // dígitos vecinos antes de contar. "a4 500 hojas" no llega a seis.
  const digitosJuntos = plano.replace(/(\d)\s+(?=\d)/g, '$1');
  if (RE_TELEFONO.test(digitosJuntos) || RE_CORREO.test(String(texto || ''))) return null;
  return plano;
}

export function esIdDeProducto(id) {
  return typeof id === 'string' && RE_ID_PRODUCTO.test(id);
}

/** La clave de un rubro tal como está en el espejo: 'LIBRERIA', 'SERVICIOS EXTRA'. */
export function claveDeRubro(rubro) {
  const clave = normalizar(rubro).toUpperCase().replace(/[^A-Z0-9 _-]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 40);
  return clave || null;
}

/** Un nombre de producto recortado a lo que se guarda. */
export function nombreCorto(nombre) {
  const limpio = String(nombre || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOMBRE);
  return limpio || null;
}

/**
 * De dónde vino la visita.
 *
 * Primero manda el `utm_source` de la URL, que es lo que el local pone en los
 * enlaces que reparte ("?utm_source=flyer"); si no hay, el sitio del que
 * salió (`document.referrer`); y si tampoco, es directo: escribió la dirección
 * o la tenía guardada. WhatsApp no manda referrer casi nunca, así que "directo"
 * incluye a la mayoría de los que llegan por un mensaje.
 */
export function clasificarOrigen({ referrer = '', url = '' } = {}) {
  let utm = '';
  try {
    utm = new URL(String(url || ''), 'https://x').searchParams.get('utm_source') || '';
  } catch { /* URL rota: se sigue con el referrer */ }
  const clave = normalizar(utm).replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  if (RE_CLAVE_ORIGEN.test(clave)) return clave;

  let host = '';
  try {
    host = new URL(String(referrer || '')).hostname.toLowerCase();
  } catch { /* sin referrer o ilegible */ }
  if (!host) return 'directo';

  if (host.includes('instagram.')) return 'instagram';
  if (host.includes('whatsapp.')) return 'whatsapp';
  if (host.includes('facebook.') || host.includes('fb.')) return 'facebook';
  if (host.includes('google.')) return 'google';
  // Navegar dentro de la tienda no es venir de ningún lado.
  if (host.includes('liceolibreria.com') || host.includes('localhost')) return 'directo';
  return 'otro';
}

/** 'movil' o 'escritorio', o null si no se puede decir. */
export function claveDeDispositivo(valor) {
  return DISPOSITIVOS.includes(valor) ? valor : null;
}

/**
 * Un evento como lo manda el navegador, revisado campo por campo. Devuelve el
 * evento limpio, o null si no sirve. Nada de lo que no esté acá llega a la
 * base: el navegador puede mandar cualquier cosa y esta es la única puerta.
 *
 * `t` es cuándo pasó, en milisegundos. Se acepta hasta una hora hacia atrás
 * (la tanda que se manda al cerrar la pestaña puede demorarse) y cinco
 * minutos hacia adelante (relojes mal puestos); fuera de eso vale el momento
 * en que llegó.
 */
export function validarEvento(crudo, ahoraMs) {
  if (!crudo || typeof crudo !== 'object') return null;
  if (!TIPOS.includes(crudo.tipo)) return null;

  let t = Number(crudo.t);
  if (!Number.isFinite(t) || t < ahoraMs - 60 * 60 * 1000 || t > ahoraMs + 5 * 60 * 1000) t = ahoraMs;

  const ev = { tipo: crudo.tipo, t };

  switch (crudo.tipo) {
    case 'visita': {
      ev.nueva = crudo.nueva === true;
      ev.dispositivo = claveDeDispositivo(crudo.dispositivo);
      const origen = typeof crudo.origen === 'string' ? crudo.origen.toLowerCase() : '';
      ev.origen = RE_CLAVE_ORIGEN.test(origen) ? origen : 'otro';
      return ev;
    }
    case 'pagina': {
      ev.pantalla = PANTALLAS.includes(crudo.pantalla) ? crudo.pantalla : null;
      ev.rubro = crudo.rubro ? claveDeRubro(crudo.rubro) : null;
      return ev;
    }
    case 'busqueda': {
      ev.termino = limpiarTermino(crudo.texto);
      if (!ev.termino) return null;
      const resultados = Number(crudo.resultados);
      ev.resultados = Number.isFinite(resultados) && resultados > 0 ? Math.floor(resultados) : 0;
      return ev;
    }
    case 'ficha':
    case 'carrito': {
      if (!esIdDeProducto(crudo.id)) return null;
      ev.id = crudo.id;
      ev.nombre = nombreCorto(crudo.nombre);
      ev.rubro = crudo.rubro ? claveDeRubro(crudo.rubro) : null;
      return ev;
    }
    case 'checkout':
    case 'chat':
      return ev;
    default:
      return null;
  }
}

/* ── De eventos a contadores ──────────────────────────────────────────────── */

function sumar(objeto, ruta, cuanto = 1) {
  let nodo = objeto;
  for (const parte of ruta.slice(0, -1)) {
    if (!nodo[parte] || typeof nodo[parte] !== 'object') nodo[parte] = {};
    nodo = nodo[parte];
  }
  const ultima = ruta[ruta.length - 1];
  nodo[ultima] = (Number(nodo[ultima]) || 0) + cuanto;
}

function fijar(objeto, ruta, valor) {
  if (valor === null || valor === undefined) return;
  let nodo = objeto;
  for (const parte of ruta.slice(0, -1)) {
    if (!nodo[parte] || typeof nodo[parte] !== 'object') nodo[parte] = {};
    nodo = nodo[parte];
  }
  nodo[ruta[ruta.length - 1]] = valor;
}

/**
 * Los eventos válidos, agrupados por día y convertidos en lo que hay que
 * sumar y lo que hay que dejar escrito en el documento de ese día.
 *
 * Devuelve `{ 'YYYY-MM-DD': { contadores, valores } }`. Los contadores son
 * cuánto sumarle a cada campo (se aplican con incrementos atómicos, así dos
 * tandas que llegan a la vez no se pisan); los valores son textos que se
 * dejan como están (el nombre de un producto, el día).
 *
 * @param {Array<object>} crudos  lo que mandó el navegador
 * @param {number} ahoraMs
 */
export function agregarEventos(crudos, ahoraMs) {
  const porDia = {};
  const lista = Array.isArray(crudos) ? crudos.slice(0, MAX_EVENTOS) : [];

  for (const crudo of lista) {
    const ev = validarEvento(crudo, ahoraMs);
    if (!ev) continue;

    const dia = claveDeDia(ev.t);
    if (!porDia[dia]) porDia[dia] = { contadores: {}, valores: { dia } };
    const { contadores, valores } = porDia[dia];

    switch (ev.tipo) {
      case 'visita':
        sumar(contadores, ['visitas']);
        if (ev.nueva) sumar(contadores, ['visitantes_nuevos']);
        if (ev.dispositivo) sumar(contadores, ['dispositivos', ev.dispositivo]);
        sumar(contadores, ['origenes', ev.origen]);
        break;
      case 'pagina':
        sumar(contadores, ['paginas']);
        sumar(contadores, ['horas', String(horaLocal(ev.t))]);
        if (ev.pantalla === 'catalogo' && ev.rubro) sumar(contadores, ['rubros', ev.rubro, 'vistas']);
        break;
      case 'busqueda':
        sumar(contadores, ['busquedas']);
        sumar(contadores, ['terminos', ev.termino, 'n']);
        if (!ev.resultados) {
          sumar(contadores, ['busquedas_sin_resultado']);
          sumar(contadores, ['terminos', ev.termino, 'sin']);
        }
        break;
      case 'ficha':
        sumar(contadores, ['fichas']);
        sumar(contadores, ['productos', ev.id, 'vistas']);
        fijar(valores, ['productos', ev.id, 'nombre'], ev.nombre);
        fijar(valores, ['productos', ev.id, 'rubro'], ev.rubro);
        break;
      case 'carrito':
        sumar(contadores, ['carrito']);
        sumar(contadores, ['productos', ev.id, 'carrito']);
        fijar(valores, ['productos', ev.id, 'nombre'], ev.nombre);
        fijar(valores, ['productos', ev.id, 'rubro'], ev.rubro);
        break;
      case 'checkout':
        sumar(contadores, ['checkouts']);
        break;
      case 'chat':
        sumar(contadores, ['chat']);
        break;
      default:
        break;
    }
  }
  return porDia;
}

/* ── Lo que arma el panel ─────────────────────────────────────────────────── */

const n = x => (Number.isFinite(Number(x)) ? Number(x) : 0);

/**
 * Varios documentos de día, juntos: los totales, los rankings y la serie por
 * día, que es lo que la pantalla del panel pinta.
 *
 * @param {Array<object>} docs  documentos de `tienda_estadisticas`
 */
export function combinarDias(docs) {
  const total = {
    visitas: 0, visitantes_nuevos: 0, paginas: 0, busquedas: 0, busquedas_sin_resultado: 0,
    fichas: 0, carrito: 0, checkouts: 0, chat: 0,
  };
  const horas = Array(24).fill(0);
  const dispositivos = {};
  const origenes = {};
  const rubros = {};
  const terminos = {};
  const productos = {};
  const porDia = [];

  for (const d of docs || []) {
    if (!d || typeof d !== 'object') continue;
    for (const clave of Object.keys(total)) total[clave] += n(d[clave]);

    for (const [h, v] of Object.entries(d.horas || {})) {
      const i = Number(h);
      if (Number.isInteger(i) && i >= 0 && i < 24) horas[i] += n(v);
    }
    for (const [k, v] of Object.entries(d.dispositivos || {})) dispositivos[k] = (dispositivos[k] || 0) + n(v);
    for (const [k, v] of Object.entries(d.origenes || {})) origenes[k] = (origenes[k] || 0) + n(v);
    for (const [k, v] of Object.entries(d.rubros || {})) {
      if (!rubros[k]) rubros[k] = { clave: k, vistas: 0 };
      rubros[k].vistas += n(v?.vistas);
    }
    for (const [k, v] of Object.entries(d.terminos || {})) {
      if (!terminos[k]) terminos[k] = { termino: k, n: 0, sin: 0 };
      terminos[k].n += n(v?.n);
      terminos[k].sin += n(v?.sin);
    }
    for (const [k, v] of Object.entries(d.productos || {})) {
      if (!productos[k]) productos[k] = { id: k, nombre: null, rubro: null, vistas: 0, carrito: 0 };
      productos[k].vistas += n(v?.vistas);
      productos[k].carrito += n(v?.carrito);
      if (v?.nombre) productos[k].nombre = String(v.nombre);
      if (v?.rubro) productos[k].rubro = String(v.rubro);
    }
    porDia.push({
      dia: String(d.dia || ''),
      visitas: n(d.visitas), paginas: n(d.paginas), busquedas: n(d.busquedas),
      fichas: n(d.fichas), carrito: n(d.carrito), checkouts: n(d.checkouts),
    });
  }

  porDia.sort((a, b) => a.dia.localeCompare(b.dia));

  const porCantidad = (a, b) => b.n - a.n || a.termino.localeCompare(b.termino);

  return {
    total,
    horas,
    dispositivos,
    origenes: Object.entries(origenes).map(([clave, visitas]) => ({ clave, visitas }))
      .sort((a, b) => b.visitas - a.visitas || a.clave.localeCompare(b.clave)),
    rubros: Object.values(rubros).sort((a, b) => b.vistas - a.vistas || a.clave.localeCompare(b.clave)),
    terminos: Object.values(terminos).sort(porCantidad),
    // Lo que buscaron y no estaba: ordenado por cuántas veces dio vacío. Un
    // término que a veces sí encuentra (buscado con y sin stock) entra igual,
    // con las dos cifras a la vista.
    sinResultado: Object.values(terminos).filter(t => t.sin > 0)
      .sort((a, b) => b.sin - a.sin || b.n - a.n || a.termino.localeCompare(b.termino)),
    productos: Object.values(productos)
      .sort((a, b) => b.vistas - a.vistas || b.carrito - a.carrito || a.id.localeCompare(b.id)),
    porDia,
  };
}

/** `parte` de `todo`, en porcentaje entero. 0 si no hay de qué sacarlo. */
export function porcentaje(parte, todo) {
  if (!(todo > 0)) return 0;
  return Math.round((n(parte) / todo) * 100);
}
