/**
 * El espejo público del catálogo, escrito desde el panel.
 *
 * La tienda nunca lee `catalogo`: ahí viven costo, margen y proveedor. Lee
 * `tienda_productos`, un espejo con solo los campos publicables que llena
 * `scripts/sync_tienda.py` cada 15 minutos desde la PC del local.
 *
 * Este módulo hace lo mismo que el sync, pero para un producto y al instante.
 * Sin esto, tocar un interruptor en el panel no se vería en la tienda hasta la
 * próxima corrida, y "publicar" que tarda un cuarto de hora no se siente como
 * publicar: se siente como que no anduvo.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ IMPORTANTE — esto es un gemelo de `armar_documento()` en                │
 * │ scripts/sync_tienda.py. Si cambia la forma del documento hay que tocar   │
 * │ los dos, o el sync va a pisar lo que escribió el panel con una versión   │
 * │ vieja del documento. Las pruebas de tienda/pruebas/espejo.test.js        │
 * │ comparan las dos salidas contra los mismos casos.                        │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Qué manda quién:
 *
 *   · Precio, stock y variedades salen del catálogo del POS y solo de ahí. Son
 *     los mismos números con los que se cobra en el mostrador.
 *   · Qué se publica, cómo se llama, qué foto tiene, si se ofrece el pack y qué
 *     variedades se muestran los decide el panel, en campos `tienda_*` que
 *     viven en el mismo documento del catálogo. El sync los respeta.
 */
import {
  doc, getDoc, getDocFromCache, collection, writeBatch,
  query, orderBy, limit, getDocs, serverTimestamp, deleteField,
} from 'firebase/firestore';
// La lista de tildes vive en la tienda (mismo patrón que tienda/src/horarios.js
// en tienda_ajustes.js): una sola lista en JS, y la copia en Python de
// sync_tienda.py comparada por tienda/pruebas/nombre_bonito.test.js.
import { conTilde } from '../../tienda/src/formato.js';
// Los descuentos de la tienda se aplican acá con la MISMA regla que el sync:
// hasta el 2026-09-08 cualquier re-espejado (guardar la ficha, entregar un
// pedido, tocar una foto) escribía el precio de lista y el producto perdía la
// rebaja hasta la próxima corrida.
import { aplicarDescuento, descuentosVigentes } from './tienda_descuentos_regla.js';

/* ── Texto ────────────────────────────────────────────────────────────────
 * Copias de `normalizar`, `nombre_bonito` y `tokenizar` de sync_tienda.py.
 * Tienen que dar exactamente lo mismo: si el panel indexa distinto que el
 * sync, un producto se encuentra buscándolo hasta que corre el sync y después
 * deja de encontrarse, que es la clase de error que nadie reporta bien.
 */

const MENORES = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'con', 'sin',
                         'para', 'por', 'a', 'en']);

// Las mismas que `VACIAS` en sync_tienda.py y en tienda/src/formato.js.
const VACIAS = new Set([...MENORES, 'un', 'una', 'marca']);

export function normalizar(texto) {
  return String(texto ?? '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').trim();
}

// Unidades que van en minúscula cuando acompañan a un número: "250 ml",
// "40x50 cm", "18mm". Las mismas que UNIDADES en sync_tienda.py.
const UNIDADES = new Set(['ml', 'mm', 'cm', 'cms', 'm', 'mt', 'mts', 'mtr', 'mtrs', 'gr', 'grs', 'g',
                          'kg', 'kgs', 'lt', 'lts', 'l', 'cc', 'hjs', 'hs', 'h', 'hojas', 'u', 'un',
                          'unid', 'w', 'v']);
const MEDIDA = /^([xX]?)(\d+(?:[.,]\d+)?)(?:([xX])(\d+(?:[.,]\d+)?))?([A-Za-z]{1,5})?(\.?)$/;

// Un número con su unidad o una medida pegada: 250ML → 250ml, 14X40CM →
// 14x40cm, X80 → x80. Lo que no es eso (C12-003, A4, 2B, 24/6) es un código y
// se deja en mayúsculas, que es como vino.
function medidaBonita(palabra) {
  const m = MEDIDA.exec(palabra);
  if (!m) return palabra.toUpperCase();
  const [, x1, n1, x2, n2, unidad, punto] = m;
  if (unidad && !UNIDADES.has(unidad.toLowerCase())) return palabra.toUpperCase();
  return `${x1.toLowerCase()}${n1}${(x2 || '').toLowerCase()}${n2 || ''}${(unidad || '').toLowerCase()}${punto}`;
}

const tieneDigito = (s) => /\d/.test(s || '');
const terminaEnDigito = (s) => /\d$/.test(s || '');

// El catálogo guarda todo en mayúsculas porque el POS lo muestra así en
// pantalla chica. Los códigos quedan como vinieron; las medidas se escriben
// como las escribe la gente. Gemelo de nombre_bonito() en sync_tienda.py;
// casos en tienda/pruebas/casos_nombre_bonito.json.
export function nombreBonito(texto) {
  const palabras = String(texto ?? '').trim().split(/\s+/).filter(Boolean);
  if (!palabras.length) return '';
  return palabras.map((palabra, i) => {
    if (tieneDigito(palabra)) return medidaBonita(palabra);
    const baja = palabra.toLowerCase();
    const anterior = i > 0 ? palabras[i - 1] : '';
    const siguiente = i + 1 < palabras.length ? palabras[i + 1] : '';
    if (i > 0 && UNIDADES.has(baja.replace(/\.$/, '')) && terminaEnDigito(anterior)) return baja;
    if (baja === 'x' && tieneDigito(anterior) && tieneDigito(siguiente)) return 'x';
    if (i > 0 && MENORES.has(baja)) return baja;
    // "BOLIGRAFO" → "Bolígrafo": el catálogo perdió las tildes al cargarse en
    // mayúsculas y mostradas así delatan que el nombre salió de un sistema.
    const acentuada = conTilde(baja);
    return acentuada.charAt(0).toUpperCase() + acentuada.slice(1);
  }).join(' ');
}

export function tokenizar(...textos) {
  const vistas = [];
  for (const texto of textos) {
    for (const palabra of normalizar(texto).split(/[^0-9a-z]+/)) {
      if (palabra.length >= 2 && !VACIAS.has(palabra) && !vistas.includes(palabra)) {
        vistas.push(palabra);
      }
    }
  }
  return vistas.slice(0, 25);
}

/* ── Cómo se vende ───────────────────────────────────────────────────────── */

function numero(datos, clave, porDefecto = 0) {
  const n = Number(datos?.[clave]);
  return Number.isFinite(n) ? n : porDefecto;
}

/**
 * Redondea plata al peso entero: floor(x + 0.5), la misma cuenta que hace
 * `a_peso()` en scripts/sync_tienda.py.
 *
 * Math.round() de JavaScript sube siempre (312,5 → 313) y round() de Python
 * redondea al par (312,5 → 312). El panel escribe el espejo al guardar la ficha
 * y el sync lo reescribe cada seis horas: con dos cuentas distintas el precio
 * oscilaba un peso solo, para siempre. Pasa de verdad en el catálogo (Cartulina
 * Rexon Glitter Celeste a 1.874,5; Mapa Rivadavia Grecia a 126,5).
 * `tienda_descuentos_regla.js` ya redondeaba así por la misma razón.
 */
export function aPeso(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? Math.floor(n + 0.5) : 0;
}

/**
 * Las variedades (colores, medidas) como las ve el cliente.
 *
 * En el catálogo cada una trae `unidades` (packs cerrados) y `restante`
 * (sueltas del pack abierto): el stock real es unidades × contenido + restante.
 *
 * `tienda_variedades` es lo que decidió el panel, con el nombre del catálogo
 * normalizado como clave — el nombre visible cambia y el del catálogo no.
 * Cada ajuste puede traer `imagen`: la foto de ESA variedad (el rojo, el azul),
 * que la tienda muestra al elegirla en vez de la portada del producto.
 */
export function variedadesDe(datos) {
  const colores = Array.isArray(datos?.conjunto_colores) ? datos.conjunto_colores : [];
  const contenido = Math.trunc(numero(datos, 'conjunto_contenido'));
  const ajustes = (datos?.tienda_variedades && typeof datos.tienda_variedades === 'object')
    ? datos.tienda_variedades : {};

  const salida = [];
  for (const color of colores) {
    if (!color || typeof color !== 'object') continue;
    const nombre = String(color.color ?? '').trim();
    if (!nombre) continue;

    const ajuste = ajustes[normalizar(nombre)];
    if (ajuste && ajuste.publicar === false) continue;

    const unidades = Number(color.unidades) || 0;
    const restante = Number(color.restante) || 0;
    const precio = Number(color.precio) || 0;

    salida.push({
      nombre: String(ajuste?.nombre || '').trim() || nombreBonito(nombre),
      stock: Math.max(0, Math.trunc(unidades * contenido + restante)),
      precio: precio ? aPeso(precio) : null,
      imagen: String(ajuste?.imagen ?? '').trim() || null,
    });
  }
  return salida;
}

/**
 * Precio de una unidad, precio del pack entero, y en qué se mide.
 *
 * El catálogo guarda dos precios por producto fraccionado: `precio_venta` es el
 * rollo o la caja entera y `conjunto_precio_unidad` es lo que sale uno. Un
 * metro de media perla figuraba a $23.800 cuando vale $1.200 por mostrar el
 * primero.
 */
export function medidasDe(datos) {
  const esConjunto = datos?.es_conjunto === true;
  const tipo = String(datos?.conjunto_tipo ?? '').trim().toLowerCase();
  const um = String(datos?.conjunto_unidad_medida ?? '').trim().toLowerCase();

  const precioVenta = numero(datos, 'precio_venta');
  const precioUnidad = numero(datos, 'conjunto_precio_unidad');
  const contenido = Math.trunc(numero(datos, 'conjunto_contenido'));

  const forzada = String(datos?.tienda_unidad ?? '').trim().toLowerCase();
  const unidad = (forzada === 'metro' || forzada === 'unidad')
    ? forzada
    : (um === 'metros' ? 'metro' : 'unidad');

  const variedades = variedadesDe(datos);

  if (!esConjunto) {
    return {
      unidad, precio: aPeso(precioVenta), precio_pack: null,
      pack_tipo: null, pack_nombre: null, pack_contenido: null,
      stock: Math.max(0, Math.trunc(numero(datos, 'stock'))), variedades: [],
      ...ventaMinima(datos, unidad),
    };
  }

  // `conjunto_tipo: unidad` con contenido 1 no es un pack: es un producto
  // suelto que quedó marcado como conjunto.
  let hayPack = contenido > 1
    && ['rollo', 'caja', 'pack', 'bolsa', 'bobina', 'carton'].includes(tipo);

  const ofrecer = datos?.tienda_ofrecer_pack;
  if (ofrecer === false) hayPack = false;
  else if (ofrecer === true) hayPack = contenido > 1 && precioVenta > 0;

  // El stock vendible sale de `conjunto_total`; el campo `stock` cuenta packs
  // cerrados y queda desfasado.
  const stock = variedades.length
    ? variedades.reduce((t, v) => t + v.stock, 0)
    : Math.trunc(numero(datos, 'conjunto_total') || numero(datos, 'stock'));

  return {
    unidad,
    precio: aPeso(precioUnidad || precioVenta),
    precio_pack: hayPack ? aPeso(precioVenta) : null,
    pack_tipo: hayPack ? tipo : null,
    pack_nombre: hayPack
      ? (String(datos?.tienda_pack_nombre ?? '').trim() || nombreBonito(tipo))
      : null,
    pack_contenido: hayPack ? contenido : null,
    stock: Math.max(0, stock),
    variedades,
    ...ventaMinima(datos, unidad),
  };
}

/**
 * De a cuánto se vende esto en la tienda.
 *
 * En el mostrador atender una venta cuesta cero: la persona ya está ahí. Un
 * pedido online no — hay que leerlo, recorrer el local juntando las cosas,
 * embalarlo y despacharlo. Vender un mapa de $100 que deja $40 no paga ni el
 * minuto de ir a buscarlo.
 *
 * Los dos números van en la unidad del producto: metros para lo que se corta
 * del rollo, unidades para el resto. Sin configurar queda como estaba —de a
 * uno, medio metro para lo que se mide—, así que esto no cambia nada hasta que
 * alguien lo toque. `scripts/estudio_minimos.py` calcula el valor que le
 * corresponde a cada producto según lo que deja.
 */
export function ventaMinima(datos, unidad) {
  const natural = unidad === 'metro' ? 0.5 : 1;

  const positivo = (clave, porDefecto) => {
    const v = Number(datos?.[clave]);
    return Number.isFinite(v) && v > 0 ? v : porDefecto;
  };

  const paso = positivo('tienda_paso', natural);
  let minimo = positivo('tienda_minimo', paso);

  // El mínimo tiene que caer justo en un paso, o no se puede llegar con los
  // botones: con mínimo 3 y paso 2 se salta de 2 a 4 y el 3 no existe nunca.
  if (minimo % paso) minimo = Math.ceil(minimo / paso) * paso;

  return { minimo: Math.round(minimo * 100) / 100, paso: Math.round(paso * 100) / 100 };
}

/**
 * Las fotos del producto, en el orden en que se muestran: la primera es la
 * portada (la de la card y la que abre la ficha), las demás son la galería.
 *
 * Es la MISMA regla que decide "sin foto" en motivoDeNoPublicar(): un producto
 * que pasa esa puerta tiene que salir al espejo con esas fotos y no con una
 * lista vacía. Gemelo de imagenes_de() en scripts/sync_tienda.py.
 */
export function imagenesDe(datos) {
  const propias = datos?.tienda_imagenes;
  if (Array.isArray(propias) && propias.length) return propias.filter(Boolean).map(String);
  const suelta = datos?.imagen_url || datos?.imagen;
  return suelta ? [String(suelta)] : [];
}

/** El documento tal cual va a `tienda_productos`. Gemelo de armar_documento(). */
export function documentoEspejo(datos) {
  const nombre = String(datos?.tienda_nombre ?? '').trim() || nombreBonito(datos?.nombre);

  let marca = String(datos?.marca ?? '').trim();
  if (marca.toUpperCase() === 'SIN MARCA') marca = '';

  // El grupo de tamaños: "Cierre Común" junta los cierres de 10, 12, 14 cm…
  // en una sola card de la tienda, y `tamano` es la etiqueta de ESTE producto
  // dentro del grupo. Los dos los decide el panel; sin grupo, el tamaño suelto
  // no significa nada y no se publica.
  const grupo = String(datos?.tienda_grupo ?? '').trim();
  const tamano = String(datos?.tienda_tamano ?? '').trim();

  const m = medidasDe(datos);

  return {
    nombre,
    descripcion: String(datos?.tienda_descripcion ?? '').trim(),
    // Aviso propio del producto: lo que el cliente tiene que saber ANTES de
    // comprarlo ("no se acepta devolución", "se corta a pedido"). Si está
    // vacío, la tienda cae al aviso del subrubro y después al del rubro.
    aviso: String(datos?.tienda_aviso ?? '').trim() || null,
    precio: m.precio,
    precio_anterior: null,
    precio_pack: m.precio_pack,
    pack_tipo: m.pack_tipo,
    pack_nombre: m.pack_nombre,
    pack_contenido: m.pack_contenido,
    unidad: m.unidad,
    // De a cuánto se vende: lo mínimo que se puede llevar y de a cuánto sube.
    minimo: m.minimo,
    paso: m.paso,
    stock: m.stock,
    rubro: String(datos?.rubro ?? '').trim().toUpperCase(),
    categoria: nombreBonito(datos?.categoria),
    sub_rubro: nombreBonito(datos?.sub_rubro),
    marca,
    imagenes: imagenesDe(datos),
    variedades: m.variedades,
    // Solo lo marcado a mano; lo que eligió el sync por ventas lo repone
    // `destacadoQueQueda()` antes de escribir, que acá no se puede saber.
    destacado: datos?.tienda_destacado === true,
    grupo: grupo || null,
    // Normalizado para consultar por igualdad: el nombre visible del grupo
    // puede cambiar de mayúsculas o de tildes sin partir el grupo en dos.
    grupo_clave: grupo ? normalizar(grupo) : null,
    tamano: grupo ? (tamano || null) : null,
    // El grupo también se indexa: buscar "cierre común" tiene que encontrar
    // los tamaños aunque el panel les haya cambiado el nombre propio.
    tokens: tokenizar(nombre, marca, datos?.categoria, datos?.sub_rubro, grupo),
    nombre_busqueda: normalizar(nombre),
    codigo: String(datos?.codigo ?? ''),
    actualizado: serverTimestamp(),
  };
}

/* ── Reglas de publicación ────────────────────────────────────────────────
 * Las mismas de `se_publica()` en el sync. El panel las necesita para decir
 * por qué un producto no está en la tienda: "sin stock" y "excluido a mano" se
 * arreglan de maneras muy distintas.
 */

// Los mismos de `NOMBRES_EXCLUIDOS` en el sync: productos que existen en el
// catálogo para operar el POS y no son cosas que se vendan.
const NOMBRES_INTERNOS = ['DESCUENTO POR CANTIDAD', 'VARIOS 1', 'VARIOS 2',
                          'SIN NOMBRE', 'PRUEBA'];

/**
 * Clave con la que se compara un rubro o un subrubro.
 *
 * En el catálogo el mismo subrubro aparece escrito de todas las formas
 * ("Abrochadora", "ABROCHADORA", " abrochadora"). Comparar el texto crudo hacía
 * que excluir uno dejara publicados sus hermanos mal tipeados.
 */
export function claveDeRubro(texto) {
  return String(texto ?? '').trim().toUpperCase();
}

/**
 * @param {object} datos                      producto del catálogo
 * @param {string[]|null} rubrosHabilitados   rubros que salen a la web
 * @param {object|null} subrubrosExcluidos    { RUBRO: ['SUBRUBRO', …] }
 *
 * El rubro manda: si está apagado no se publica nada de él, ni lo marcado a
 * mano con "publicar siempre". Prendido, sale todo salvo los subrubros
 * destildados. Así no hay forma de que las dos listas se contradigan.
 *
 * Adentro de un rubro prendido, el interruptor por producto le gana al
 * subrubro excluido y a la falta de foto. Hasta el 2026-09-08 le ganaba
 * también al rubro apagado: la dueña destildó Cotillón en la configuración y
 * lo marcado a mano siguió saliendo.
 */
export function motivoDeNoPublicar(datos, rubrosHabilitados = null,
                                   subrubrosExcluidos = null) {
  if (datos?.tienda_publicar === false) return 'excluido a mano';
  if (String(datos?.estado ?? '').toLowerCase() !== 'activo') return 'no está activo';
  if (datos?.duplicado === true) return 'marcado como duplicado';

  const nombre = String(datos?.nombre ?? '').trim().toUpperCase();
  if (!nombre) return 'sin nombre';
  if (NOMBRES_INTERNOS.some(p => nombre.startsWith(p))) return 'producto interno del POS';
  if (numero(datos, 'precio_venta') <= 0) return 'sin precio';

  const medidas = medidasDe(datos);
  if (medidas.stock <= 0) return 'sin stock';

  // Queda menos que la venta mínima: para el cliente es lo mismo que no haber.
  // Sobre el catálogo real había tres productos así (ojos móviles con mínimo 50
  // y 42 en góndola, dos tanzas de a 100 con 60 y 70): se veían en la vidriera,
  // entraban al pedido, y al confirmar desaparecían con un "se quedó sin
  // stock". Mejor no ofrecerlos.
  if (medidas.minimo && medidas.stock < medidas.minimo) return 'sin stock';

  const rubro = claveDeRubro(datos?.rubro);

  // El rubro apagado gana sobre la marca a mano y sobre el subrubro: con la
  // lista de rubros puesta se mira ANTES que todo eso. Sin la lista (quien
  // pregunta "¿por qué no está en la tienda?") se contesta por el resto.
  if (rubrosHabilitados && !rubrosHabilitados.includes(rubro)) return 'el rubro no está habilitado';

  if (datos?.tienda_publicar === true) return null;

  // Los subrubros se miran aunque no se haya pasado la lista de rubros: quien
  // llama para saber "¿por qué no está en la tienda?" pasa `null` como rubros
  // para preguntar por el resto de las reglas, y el subrubro excluido es una
  // razón tan válida como la falta de stock.
  const excluidos = subrubrosExcluidos?.[rubro];
  if (excluidos?.length) {
    const sub = claveDeRubro(datos?.sub_rubro);
    if (sub && excluidos.includes(sub)) return 'el subrubro está excluido';
  }

  if (!rubrosHabilitados) return null;

  // La foto es lo ÚLTIMO que se mira, a propósito: así "sin foto" significa
  // "sale a la vidriera apenas le saquen una", y no se mezcla con lo que igual
  // no saldría por el rubro apagado o por el precio. Gemelo de se_publica()
  // en scripts/sync_tienda.py.
  return imagenesDe(datos).length ? null : 'sin foto';
}

export function estaPublicable(datos, rubrosHabilitados = null,
                               subrubrosExcluidos = null) {
  return motivoDeNoPublicar(datos, rubrosHabilitados, subrubrosExcluidos) === null;
}

/* ── Escritura ───────────────────────────────────────────────────────────── */

/*
 * Por qué acá se evita el SDK para LEER.
 *
 * El SDK de Firestore atiende todo por una sola cola: los listeners grandes del
 * panel (el catálogo entero, las ventas por día) y cualquier lectura suelta.
 * Medido en esta webapp: un `getDoc` de un documento puede tardar más de un
 * minuto si la cola está ocupada. Guardar desde la tienda hacía tres de esas
 * lecturas en fila (el catálogo recién escrito, el espejo, y la consulta del
 * `orden`), y por eso "Guardar" tardaba una barbaridad o parecía colgado.
 *
 * Lo que se hace ahora:
 *   · El catálogo no se relee: quien guarda ya tiene el producto en memoria y
 *     pasa `datos`; los cambios se aplican encima. Sin `datos`, se lee del
 *     cache local (que ya tiene la escritura recién hecha) y solo de última
 *     del servidor.
 *   · El espejo (`tienda_productos`) es de lectura pública: se lee por la API
 *     REST, que no pasa por la cola del SDK. Si la REST falla se cae al SDK,
 *     que anda, solo que puede tardar.
 *   · Las escrituras también van por REST, con el token de la sesión (las
 *     reglas las evalúan igual que al SDK). El canal del SDK se cae y se
 *     reconecta mientras baja los listeners grandes, y una escritura que
 *     espera ese canal se queda en "Guardando…" un rato largo. Si la REST no
 *     responde o el servidor está caído, se cae al SDK; si el servidor
 *     RECHAZA (permiso, precondición), se avisa y no se reintenta por el SDK,
 *     que iba a fallar igual.
 */

const PROYECTO = 'mari-d7c71';
const BASE = `projects/${PROYECTO}/databases/(default)/documents`;
const REST = `https://firestore.googleapis.com/v1/${BASE}`;
const ESPERA_REST_MS = 8000;
const ESPERA_ESCRITURA_MS = 15000;

/** Aplica `cambios` (undefined = borrar) sobre una copia de `datos`. */
export function aplicarCambios(datos, cambios) {
  const salida = { ...(datos || {}) };
  for (const [clave, valor] of Object.entries(cambios || {})) {
    if (valor === undefined) delete salida[clave];
    else salida[clave] = valor;
  }
  return salida;
}

/**
 * Guarda lo que decidió el panel y deja la tienda igual de actualizada.
 *
 * Los campos `tienda_*` van al catálogo, que es la fuente de verdad y lo que
 * lee el sync; el espejo se reescribe acá mismo para que el cambio se vea ya.
 * Si el producto dejó de ser publicable (se apagó el interruptor, se quedó sin
 * stock) se borra del espejo: dejarlo ahí es ofrecer algo que no se puede
 * vender.
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} docId       id del documento en `catalogo`
 * @param {object} cambios     campos `tienda_*` a guardar (undefined = borrar)
 * @param {string[]|null} rubrosHabilitados
 * @param {object|null} subrubrosExcluidos
 * @param {{datos?: object|null}} [opciones]  el producto tal como lo tiene el
 *        panel en memoria; con eso no hace falta releerlo después de escribir
 * @returns {Promise<{publicado: boolean, motivo: string|null}>}
 */
export async function guardarYEspejar(db, docId, cambios, rubrosHabilitados = null,
                                      subrubrosExcluidos = null, { datos = null } = {}) {
  const referencia = doc(db, 'catalogo', docId);
  const t0 = performance.now();

  // Se limpia en vez de guardar `undefined`: un campo borrado vuelve al
  // comportamiento automático, y eso es distinto de tenerlo en falso.
  if (Object.keys(cambios || {}).length) await actualizarDoc(db, 'catalogo', docId, cambios);
  const t1 = performance.now();

  let actuales;
  if (datos && typeof datos === 'object') {
    actuales = aplicarCambios(datos, cambios);
  } else {
    // Del cache local (lo tiene el listener del catálogo) y solo de última del
    // servidor. La escritura fue por REST, así que el cache todavía no la
    // tiene: los cambios se aplican encima igual que arriba.
    let snap = null;
    try { snap = await getDocFromCache(referencia); } catch (_) { /* no estaba */ }
    if (!snap) snap = await getDoc(referencia);
    if (!snap.exists()) return { publicado: false, motivo: 'el producto ya no existe' };
    actuales = aplicarCambios(snap.data(), cambios);
  }

  const resultado = await espejar(db, docId, actuales, rubrosHabilitados, subrubrosExcluidos);
  const t2 = performance.now();
  console.info(`[tienda] guardar ${docId}: catálogo ${Math.round(t1 - t0)} ms · espejo ${Math.round(t2 - t1)} ms`);
  return resultado;
}

/**
 * Si este producto va destacado en la portada, respetando lo que ya hay puesto.
 *
 * `tienda_destacado` tiene tres estados a propósito: `true` lo fija a mano el
 * panel, `false` lo saca a mano, y sin el campo decide el sync. Cuando nadie
 * marcó ninguno a mano, el sync elige los doce más vendidos y les escribe
 * `destacado` en el espejo SIN tocar el catálogo (scripts/sync_tienda.py), así
 * que esa elección no se puede deducir del producto: solo está en el espejo.
 *
 * Hasta el 2026-09-08 el panel armaba el documento con `destacado: false` y lo
 * escribía entero, igual que hacía con `orden`: cargarle una foto a uno de esos
 * doce (o entregar un pedido, o guardar la ficha) lo bajaba de la tira
 * "Destacados" de la portada, que quedaba en once hasta la corrida siguiente
 * del sync, hasta seis horas después.
 *
 * @param {object} datos             el producto del catálogo
 * @param {{destacado?: boolean}|null} anterior  lo que hoy tiene el espejo, o
 *        `null` si el producto todavía no está publicado
 */
export function destacadoQueQueda(datos, anterior) {
  const aMano = datos?.tienda_destacado;
  if (aMano === true || aMano === false) return aMano;
  return anterior ? anterior.destacado === true : false;
}

/**
 * Escribe (o borra) el documento del espejo según corresponda.
 *
 * @param {{descuentos?: object[]|null}} [opciones]  los descuentos vigentes ya
 *        leídos (`descuentosVigentes`); sin eso se leen acá, con un minuto de
 *        memoria
 */
export async function espejar(db, docId, datos, rubrosHabilitados = null,
                              subrubrosExcluidos = null, { descuentos = null } = {}) {
  const motivo = motivoDeNoPublicar(datos, rubrosHabilitados, subrubrosExcluidos);

  if (motivo) {
    await borrarDoc(db, 'tienda_productos', docId).catch(() => {});
    return { publicado: false, motivo };
  }

  const documento = documentoEspejo(datos);
  // Con el precio rebajado si le toca un descuento: el sync hace lo mismo con
  // la misma regla, así no se pisan.
  aplicarDescuento(docId, documento, descuentos ?? await leerDescuentosVigentes(db));

  // `orden` y `orden_rubro` los calcula el sync mirando el catálogo entero: son
  // la posición dentro de la lista completa y no se pueden deducir de un
  // producto solo. Lo recién publicado va al final hasta la próxima corrida,
  // que es honesto: no se cuela adelante de nada.
  const anterior = await leerEspejoAnterior(db, docId);
  if (anterior.existe) {
    documento.orden = anterior.orden ?? await proximoOrden(db);
    documento.orden_rubro = anterior.orden_rubro ?? 0;
  } else {
    documento.orden = await proximoOrden(db);
    documento.orden_rubro = 999999;
  }

  // El destacado que eligió el sync tampoco se puede deducir del producto: se
  // conserva el del espejo salvo que el panel lo haya decidido a mano.
  documento.destacado = destacadoQueQueda(datos, anterior.existe ? anterior : null);

  await reemplazarDoc(db, 'tienda_productos', docId, documento, { marcaTiempo: 'actualizado' });
  return { publicado: true, motivo: null };
}

// Qué rubros y subrubros están habilitados (tienda_config/publicacion), con
// un minuto de memoria: se consulta en cada guardado de la ficha y no cambia
// cada vez.
let _publicacion = null;
let _publicacionAt = 0;
export async function leerPublicacion(db) {
  if (_publicacion && Date.now() - _publicacionAt < 60000) return _publicacion;
  let datos = {};
  try {
    const snap = await getDoc(doc(db, 'tienda_config', 'publicacion'));
    if (snap.exists()) datos = snap.data() || {};
  } catch (_) { /* sin config: las reglas que no dependen de ella siguen valiendo */ }
  const rubros = Array.isArray(datos.rubros) ? datos.rubros.map(r => String(r).trim().toUpperCase()) : null;
  _publicacion = { rubros, subrubrosExcluidos: datos.subrubros_excluidos || null };
  _publicacionAt = Date.now();
  return _publicacion;
}

/**
 * Tira ese minuto de memoria: Configuración acaba de cambiar los rubros.
 *
 * La pantalla de Configuración escribe `tienda_config/publicacion` por REST, así
 * que ni el SDK ni este módulo se enteran. Prender JUGUETERÍA y pasar derecho a
 * Tienda > Catálogo a cargarle fotos espejaba con la lista de hace un minuto:
 * cada foto guardada borraba el producto del espejo por "el rubro no está
 * habilitado" y desaparecía de la tienda hasta la corrida siguiente del sync.
 * Apagando un rubro pasaba al revés: se lo seguía dando por publicado y
 * cualquier guardado lo volvía a subir.
 */
export function olvidarPublicacion() {
  _publicacion = null;
  _publicacionAt = 0;
}

/**
 * Los descuentos vigentes de la tienda (`tienda_descuentos`), con un minuto
 * de memoria: se consultan en cada espejado y cambian una vez por semana.
 *
 * Por REST con el token de la sesión (la colección no es pública) y no por
 * el SDK: una lectura suelta por el SDK queda encolada detrás de los
 * listeners grandes del panel. Si la REST no está, el SDK; y si tampoco se
 * pueden leer, se espeja a precio de lista y el sync lo arregla en la
 * próxima corrida, que es lo que pasaba siempre hasta ahora.
 *
 * @returns {Promise<ReturnType<typeof descuentosVigentes>>}
 */
let _descuentos = null;
let _descuentosAt = 0;
export async function leerDescuentosVigentes(db) {
  if (_descuentos && Date.now() - _descuentosAt < 60000) return _descuentos;
  let filas = await consultarRest({ coleccion: 'tienda_descuentos', conSesion: true });
  if (filas === null) {
    try {
      const snap = await getDocs(collection(db, 'tienda_descuentos'));
      filas = snap.docs.map(x => ({ id: x.id, datos: x.data() }));
    } catch (err) {
      console.warn('[tienda] no se pudieron leer los descuentos, se espeja a precio de lista:',
                   err?.message || err);
      return [];
    }
  }
  _descuentos = descuentosVigentes(filas, new Date());
  _descuentosAt = Date.now();
  return _descuentos;
}

/** El panel de descuentos acaba de cambiar uno: la próxima lectura va a la base. */
export function olvidarDescuentosVigentes() {
  _descuentos = null;
  _descuentosAt = 0;
}

/**
 * Vuelve a escribir el espejo de un producto que YA está en la tienda, con
 * los datos que acaba de guardar el panel. Un producto que no está publicado
 * no se publica desde acá: eso lo decide el catálogo de la tienda.
 *
 * Hasta el 2026-08-22 renombrar un producto o cambiarle el precio desde la
 * ficha recién llegaba a la tienda con el sync de las 6 horas; entre medio la
 * vidriera vendía con el nombre y el precio viejos.
 */
export async function reflejarSiPublicado(db, docId, datos) {
  let snap;
  try { snap = await getDoc(doc(db, 'tienda_productos', docId)); }
  catch (_) { return { publicado: false, motivo: 'no se pudo leer el espejo' }; }
  if (!snap.exists()) return { publicado: false, motivo: 'no está en la tienda' };
  const { rubros, subrubrosExcluidos } = await leerPublicacion(db);
  const resultado = await espejar(db, docId, datos, rubros, subrubrosExcluidos);

  // Cambió de rubro, de subrubro o de grupo, o se fue de la tienda: el conteo
  // de la portada quedó viejo y se rehace en unos segundos.
  const antes = snap.data() || {};
  const cambioDeLugar = claveDeRubro(antes.rubro) !== claveDeRubro(datos?.rubro)
    || claveDeRubro(antes.sub_rubro) !== claveDeRubro(datos?.sub_rubro)
    || (antes.grupo_clave || null) !== (normalizar(datos?.tienda_grupo) || null);
  if (!resultado.publicado || cambioDeLugar) programarRecuentoDeRubros(db);
  return resultado;
}

/**
 * Si el producto ya está en el espejo, y con qué `orden`, `orden_rubro` y
 * `destacado`: los tres los decide el sync mirando el catálogo entero y hay que
 * conservarlos. Por REST primero (lectura pública, sin pasar por la cola del
 * SDK); si eso falla, por el SDK.
 */
async function leerEspejoAnterior(db, docId) {
  const porRest = await leerEspejoAnteriorRest(docId);
  if (porRest) return porRest;

  const snap = await getDoc(doc(db, 'tienda_productos', docId));
  if (!snap.exists()) return SIN_ESPEJO;
  return {
    existe: true,
    orden: numeroONull(snap.get('orden')),
    orden_rubro: numeroONull(snap.get('orden_rubro')),
    destacado: snap.get('destacado') === true,
  };
}

const SIN_ESPEJO = { existe: false, orden: null, orden_rubro: null, destacado: false };

async function leerEspejoAnteriorRest(docId) {
  const leido = await leerDocEspejoRest(docId, CAMPOS_QUE_SE_CONSERVAN);
  if (leido === null) return null;
  if (!leido.existe) return SIN_ESPEJO;
  return {
    existe: true,
    orden: numeroONull(leido.datos.orden),
    orden_rubro: numeroONull(leido.datos.orden_rubro),
    destacado: leido.datos.destacado === true,
  };
}

// Lo que el panel no sabe calcular de un producto solo y le pide al espejo.
const CAMPOS_QUE_SE_CONSERVAN = ['orden', 'orden_rubro', 'destacado'];

async function maxOrdenRest() {
  const filas = await consultarEspejoRest({
    campos: ['orden'], ordenarPor: 'orden', descendente: true, limite: 1,
  });
  if (filas === null) return null;
  return filas.length ? (numeroONull(filas[0].datos.orden) ?? 0) : 0;
}

/**
 * Un documento del espejo por REST: `{existe, datos}` con los campos pedidos
 * (o todos), o `null` si la REST no respondió y hay que caer al SDK.
 * `tienda_productos` es de lectura pública: no hace falta credencial.
 */
export async function leerDocEspejoRest(docId, campos = null) {
  return leerDocRest('tienda_productos', docId, campos);
}

/**
 * Lo mismo sobre cualquier colección de lectura pública (`tienda_productos`,
 * `tienda_config`). Sin credencial y sin pasar por la cola del SDK.
 */
export async function leerDocRest(coleccion, docId, campos = null) {
  const mascara = campos?.length
    ? '?' + campos.map(c => `mask.fieldPaths=${encodeURIComponent(c)}`).join('&') : '';
  try {
    const r = await conEspera(
      `${REST}/${coleccion}/${encodeURIComponent(docId)}${mascara}`);
    if (r.status === 404) return { existe: false, datos: null };
    if (!r.ok) return null;
    const cuerpo = await r.json();
    return { existe: true, datos: decodificarCampos(cuerpo?.fields) };
  } catch (err) {
    console.warn('[tienda] lectura por REST no respondió, se usa el SDK:', err?.message || err);
    return null;
  }
}

/**
 * Consulta al espejo por REST. Devuelve `[{id, datos}]`, o `null` si la REST no
 * respondió. Filtra por igualdad en `donde` ({campo: valor}); `campos` limita
 * lo que viaja (un rubro son cientos de documentos con tokens y variedades).
 */
export function consultarEspejoRest(opciones = {}) {
  return consultarRest({ ...opciones, coleccion: 'tienda_productos', conSesion: false });
}

/**
 * Lo mismo sobre cualquier colección. Con `conSesion` va el token del usuario,
 * que es lo que hace falta para las que no son de lectura pública
 * (`tienda_descuentos`); sin sesión devuelve `null` para que se caiga al SDK.
 */
export async function consultarRest({
  coleccion = 'tienda_productos', donde = null, campos = null, ordenarPor = null,
  descendente = false, limite = null, conSesion = false,
} = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (conSesion) {
    const token = await tokenDeSesion();
    if (!token) return null;
    headers.Authorization = `Bearer ${token}`;
  }

  const consulta = { from: [{ collectionId: coleccion }] };
  const filtros = Object.entries(donde || {}).map(([campo, valor]) => ({
    fieldFilter: { field: { fieldPath: campo }, op: 'EQUAL', value: codificarValor(valor) },
  }));
  if (filtros.length === 1) consulta.where = filtros[0];
  else if (filtros.length > 1) consulta.where = { compositeFilter: { op: 'AND', filters: filtros } };
  if (campos?.length) consulta.select = { fields: campos.map(c => ({ fieldPath: c })) };
  if (ordenarPor) {
    consulta.orderBy = [{ field: { fieldPath: ordenarPor },
                          direction: descendente ? 'DESCENDING' : 'ASCENDING' }];
  }
  if (limite) consulta.limit = limite;

  try {
    const r = await conEspera(`${REST}:runQuery`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ structuredQuery: consulta }),
    });
    if (!r.ok) return null;
    const filas = await r.json();
    return (Array.isArray(filas) ? filas : [])
      .filter(f => f?.document?.name)
      .map(f => ({
        id: String(f.document.name).split('/').pop(),
        datos: decodificarCampos(f.document.fields),
      }));
  } catch (err) {
    console.warn('[tienda] consulta por REST no respondió, se usa el SDK:', err?.message || err);
    return null;
  }
}

function conEspera(url, opciones = {}, espera = ESPERA_REST_MS) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), espera);
  return fetch(url, { ...opciones, signal: control.signal }).finally(() => clearTimeout(reloj));
}

/* Los valores de la REST de Firestore vienen tipados ({integerValue: "3"},
   {stringValue: "x"}, {mapValue: {fields}}). Esto los pasa a JS común. */
export function decodificarCampos(fields) {
  const salida = {};
  for (const [clave, valor] of Object.entries(fields || {})) salida[clave] = decodificarValor(valor);
  return salida;
}

export function decodificarValor(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue?.values || []).map(decodificarValor);
  if ('mapValue' in v) return decodificarCampos(v.mapValue?.fields);
  if ('referenceValue' in v) return String(v.referenceValue).split('/').pop();
  return null;
}

/** El camino inverso: un valor de JS en la forma tipada de la REST. */
export function codificarValor(valor) {
  if (valor === null || valor === undefined) return { nullValue: null };
  if (typeof valor === 'boolean') return { booleanValue: valor };
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) return { nullValue: null };
    return Number.isInteger(valor) ? { integerValue: String(valor) } : { doubleValue: valor };
  }
  if (typeof valor === 'string') return { stringValue: valor };
  if (valor instanceof Date) return { timestampValue: valor.toISOString() };
  // Un centinela del SDK (serverTimestamp(), deleteField()) no se puede mandar
  // por REST tal cual: quien escribe tiene que usar `marcaTiempo` / undefined.
  if (typeof valor?._methodName === 'string') {
    throw new Error(`No se puede mandar ${valor._methodName}() por REST`);
  }
  // Timestamp del SDK de Firestore.
  if (typeof valor?.toDate === 'function') return { timestampValue: valor.toDate().toISOString() };
  if (Array.isArray(valor)) {
    return { arrayValue: { values: valor.filter(v => v !== undefined).map(codificarValor) } };
  }
  if (typeof valor === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(valor)) {
      if (v !== undefined) fields[k] = codificarValor(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(valor) };
}

function numeroONull(n) {
  return Number.isFinite(n) ? n : null;
}

/**
 * Publica o saca muchos productos de una.
 *
 * Es lo que hace falta al habilitar un rubro entero desde la configuración: sin
 * esto, encender "Regalería" no muestra nada hasta que corra el sync, y un
 * interruptor que tarda quince minutos en hacer algo no parece un interruptor.
 *
 * Firestore corta los lotes en 500 operaciones.
 *
 * @param {Array<{id: string, datos: object}>} productos
 * @param {(hechos: number, total: number) => void} [alProgreso]
 * @returns {Promise<{publicados: number, sacados: number}>}
 */
export async function espejarLote(db, productos, rubrosHabilitados, alProgreso = null,
                                  subrubrosExcluidos = null) {
  let orden = await proximoOrden(db);
  // Una sola lectura para el lote entero: un rubro son cientos de productos.
  const descuentos = await leerDescuentosVigentes(db);

  // La decisión se calcula una sola vez: `motivoDeNoPublicar` arma las medidas
  // del producto y el lote son miles.
  const decisiones = productos.map(({ id, datos }) => ({
    id, datos, motivo: motivoDeNoPublicar(datos, rubrosHabilitados, subrubrosExcluidos),
  }));

  // Qué lugar tiene hoy en la vidriera cada uno de los que se quedan, y si el
  // sync lo había puesto entre los destacados de la portada.
  const previos = await leerEspejosAnteriores(decisiones.filter(d => !d.motivo).map(d => d.id));

  let publicados = 0;
  let sacados = 0;
  let lote = [];

  for (const [i, { id, datos, motivo }] of decisiones.entries()) {
    if (motivo) {
      lote.push({ tipo: 'borrar', col: 'tienda_productos', id });
      sacados++;
    } else {
      // El que YA está en la tienda conserva su lugar. Hasta el 2026-09-08 el
      // lote renumeraba todo: destildar un subrubro de Librería reescribía los
      // ~2.000 productos del rubro con `orden_rubro` 999999, y la tienda perdía
      // el orden por destacado / stock / ventas hasta la próxima corrida del
      // sync. Encima los grupos de tamaños dejaban de ser contiguos y una card
      // se partía entre dos páginas. Lo nuevo sí se numera al final: no se
      // cuela adelante de nada. Mismo criterio que `espejar()` de a uno.
      const anterior = previos.get(id);
      lote.push({
        tipo: 'reemplazar', col: 'tienda_productos', id,
        datos: {
          ...aplicarDescuento(id, documentoEspejo(datos), descuentos),
          orden: anterior?.orden ?? orden++,
          orden_rubro: anterior ? (anterior.orden_rubro ?? 0) : 999999,
          // Mismo criterio que `espejar()` de a uno: los destacados que eligió
          // el sync viven solo en el espejo y publicar un rubro entero no los
          // puede borrar de la portada.
          destacado: destacadoQueQueda(datos, anterior),
        },
        marcaTiempo: 'actualizado',
      });
      publicados++;
    }

    if (lote.length >= 450) {
      await escribirLote(db, lote);
      lote = [];
      alProgreso?.(i + 1, decisiones.length);
    }
  }

  if (lote.length) await escribirLote(db, lote);
  alProgreso?.(decisiones.length, decisiones.length);
  return { publicados, sacados };
}

// Cuántos documentos se piden por tanda. `documents:batchGet` los devuelve en
// una sola respuesta; 300 entran cómodos y un rubro grande son siete tandas.
const TANDA_LECTURA = 300;

/**
 * `orden`, `orden_rubro` y `destacado` de muchos productos del espejo, en
 * tandas por REST. Devuelve un Map id → {orden, orden_rubro, destacado}; el que
 * no está en la tienda no aparece.
 *
 * Si la REST no contesta se devuelve lo que se haya podido leer y el resto se
 * numera al final, como antes: leer dos mil documentos de a uno por el SDK
 * tarda más que la corrida del sync que iba a arreglarlo igual.
 */
async function leerEspejosAnteriores(ids) {
  const salida = new Map();

  for (let i = 0; i < ids.length; i += TANDA_LECTURA) {
    const tanda = ids.slice(i, i + TANDA_LECTURA);
    let r;
    try {
      r = await conEspera(`${REST}:batchGet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documents: tanda.map(id => `${BASE}/tienda_productos/${id}`),
          mask: { fieldPaths: CAMPOS_QUE_SE_CONSERVAN },
        }),
      });
    } catch (err) {
      console.warn('[tienda] no se pudo leer lo que la tienda ya tenía puesto:', err?.message || err);
      return salida;
    }
    if (!r.ok) {
      console.warn(`[tienda] no se pudo leer lo que la tienda ya tenía puesto: ${r.status}`);
      return salida;
    }

    const filas = await r.json().catch(() => null);
    for (const fila of Array.isArray(filas) ? filas : []) {
      if (!fila?.found?.name) continue;   // `missing`: no está publicado
      const id = String(fila.found.name).split('/').pop();
      const campos = decodificarCampos(fila.found.fields);
      salida.set(id, {
        orden: numeroONull(campos.orden),
        orden_rubro: numeroONull(campos.orden_rubro),
        destacado: campos.destacado === true,
      });
    }
  }

  return salida;
}

/**
 * Rehace el conteo por rubro que usa la portada de la tienda.
 *
 * Lo escribe el sync en cada corrida, pero si el panel publica un rubro entero
 * y no lo actualiza, la portada sigue diciendo que ese rubro no tiene nada.
 */
export async function recomputarRubros(db, productos, rubrosHabilitados,
                                       subrubrosExcluidos = null) {
  const conteo = new Map();

  // Un grupo de tamaños cuenta UNA vez por rubro y por subrubro: la tienda lo
  // muestra como una sola card, y el número de la portada acompaña lo que se
  // ve. Misma regla que el bloque de lista_rubros en scripts/sync_tienda.py.
  const gruposEnRubro = new Set();
  const gruposEnSub = new Set();

  for (const { datos } of productos) {
    if (motivoDeNoPublicar(datos, rubrosHabilitados, subrubrosExcluidos)) continue;
    const rubro = String(datos?.rubro ?? '').trim().toUpperCase();
    if (!rubro) continue;

    const grupo = normalizar(datos?.tienda_grupo);

    const actual = conteo.get(rubro) || { cantidad: 0, con_stock: 0, subrubros: new Map() };
    if (!actual.subrubros) actual.subrubros = new Map();

    // Los subrubros que de verdad quedaron publicados en ese rubro. Es lo que
    // la tienda usa para la segunda fila de filtros: listarlos desde el
    // catálogo entero mostraría filtros que no devuelven nada.
    //
    // Se agrupa por el subrubro YA PUBLICADO (`nombreBonito`), que es lo que
    // hace contar_rubros() en el sync sobre el documento del espejo. Agrupar
    // por el texto crudo del catálogo partía en dos el mismo cajón: los
    // productos de "BOLIGRAFO" y los de "BOLÍGRAFO" salían como dos filtros
    // distintos, con la mitad de los productos en cada uno, y la corrida
    // siguiente del sync los volvía a juntar en uno solo.
    const sub = claveDeRubro(nombreBonito(datos?.sub_rubro));
    if (sub && (!grupo || !gruposEnSub.has(`${rubro}|${sub}|${grupo}`))) {
      if (grupo) gruposEnSub.add(`${rubro}|${sub}|${grupo}`);
      actual.subrubros.set(sub, (actual.subrubros.get(sub) || 0) + 1);
    }

    if (!grupo || !gruposEnRubro.has(`${rubro}|${grupo}`)) {
      if (grupo) gruposEnRubro.add(`${rubro}|${grupo}`);
      actual.cantidad++;
      // Publicado implica stock, pero se cuenta igual: el campo lo usa la
      // portada para saber hasta dónde puede saltar al elegir al azar.
      if (medidasDe(datos).stock > 0) actual.con_stock++;
    }
    conteo.set(rubro, actual);
  }

  // El orden de la portada NO se decide acá: se conserva el que ya tenía.
  const previo = await ordenDeRubrosPrevio(db);
  const posicion = (clave) => (previo.has(clave) ? previo.get(clave) : Infinity);

  const lista = [...conteo.entries()]
    .map(([clave, n]) => ({
      nombre: nombreBonito(clave),
      clave,
      cantidad: n.cantidad,
      con_stock: n.con_stock,
      // Firestore no admite un Map: se guarda como lista, ordenada por peso
      // igual que los rubros, para que el filtro más útil quede primero.
      subrubros: [...(n.subrubros || new Map()).entries()]
        .map(([sub, cantidad]) => ({ nombre: nombreBonito(sub), clave: sub, cantidad }))
        .sort((a, b) => b.cantidad - a.cantidad),
    }))
    .sort((a, b) => {
      const pa = posicion(a.clave);
      const pb = posicion(b.clave);
      // Empatados solo pueden ser dos rubros nuevos (los dos en Infinity): esos
      // van al final, y entre ellos por cantidad.
      return pa === pb ? b.cantidad - a.cantidad : pa - pb;
    });

  await reemplazarDoc(db, 'tienda_config', 'rubros', { lista }, { marcaTiempo: 'actualizado' });
  return lista;
}

/**
 * En qué posición está hoy cada rubro en la portada (`tienda_config/rubros`).
 *
 * El sync ordena los rubros por lo que FACTURA cada uno, a propósito: quien
 * entra tiene que ver primero lo que más se vende, no lo que más lugar ocupa en
 * el depósito (Papelera vende $2,3 millones con 244 productos; Regalería $947
 * mil con 594). Ese número sale de las ventas y el panel no lo tiene.
 *
 * Hasta el 2026-09-08 el recuento del panel ordenaba por cantidad de productos:
 * cada guardado daba vuelta la portada y la corrida siguiente del sync la
 * devolvía a su lugar. Ahora conserva el orden que ya estaba; los rubros nuevos
 * (que el sync todavía no vio) quedan al final, entre ellos por cantidad, y el
 * que desapareció se va con la lista.
 */
async function ordenDeRubrosPrevio(db) {
  let lista = null;

  const porRest = await leerDocRest('tienda_config', 'rubros', ['lista']);
  if (porRest) {
    lista = porRest.existe ? porRest.datos?.lista : [];
  } else {
    try {
      const snap = await getDoc(doc(db, 'tienda_config', 'rubros'));
      lista = snap.exists() ? snap.get('lista') : [];
    } catch (err) {
      // Sin el orden anterior se ordena por cantidad, como antes: es peor que
      // conservarlo, pero mejor que dejar la portada sin recontar.
      console.warn('[tienda] no se pudo leer el orden de la portada:', err?.message || err);
    }
  }

  const posiciones = new Map();
  (Array.isArray(lista) ? lista : []).forEach((rubro, i) => {
    const clave = claveDeRubro(rubro?.clave || rubro?.nombre);
    if (clave && !posiciones.has(clave)) posiciones.set(clave, i);
  });
  return posiciones;
}

/* ── Recuento de la portada tras un cambio suelto ───────────────────────── */

// `tienda_config/rubros` lo rehace el sync cada seis horas. Entre medio, cada
// cambio suelto del panel (mover un producto de subrubro, dejarlo sin stock,
// borrarlo, publicarlo a mano) dejaba el conteo viejo: la tienda mostraba el
// filtro "Aros 1" y adentro no había nada. Acá se programa rehacerlo unos
// segundos después del último cambio, con el catálogo que el panel ya tiene
// en memoria. Un conteo físico de veinte productos termina en UNA escritura.
const ESPERA_RECUENTO_MS = 3000;
let _fuenteCatalogo = null;
let _recuentoTimer = null;
let _recuentoEnCurso = null;

/**
 * La pantalla que tiene el catálogo entero en memoria lo presta para recontar.
 * @param {() => object[]} dame  devuelve los productos del catálogo, crudos
 */
export function usarCatalogoParaRecontar(dame) {
  _fuenteCatalogo = typeof dame === 'function' ? dame : null;
}

/** Programa rehacer el conteo por rubro y subrubro de la portada. */
export function programarRecuentoDeRubros(db, { espera = ESPERA_RECUENTO_MS } = {}) {
  if (!db || !_fuenteCatalogo) return;
  if (_recuentoTimer) clearTimeout(_recuentoTimer);
  _recuentoTimer = setTimeout(() => {
    _recuentoTimer = null;
    _recuentoEnCurso = recontarAhora(db)
      .catch(err => console.warn('[tienda] recuento de rubros:', err?.message || err))
      .finally(() => { _recuentoEnCurso = null; });
  }, espera);
}

/** Espera el recuento en curso, si hay uno. Para las pruebas. */
export async function esperarRecuento() {
  if (_recuentoEnCurso) await _recuentoEnCurso;
}

async function recontarAhora(db) {
  const catalogo = _fuenteCatalogo?.() || [];
  if (!catalogo.length) return;
  const { rubros, subrubrosExcluidos } = await leerPublicacion(db);
  // Sin la lista de rubros no se sabe qué está publicado: contar "todo"
  // pondría en la portada rubros que la tienda no muestra. Queda para el sync.
  if (!Array.isArray(rubros)) return;
  await recomputarRubros(db, catalogo.map(datos => ({ datos })), rubros, subrubrosExcluidos);
}

/* ── Escrituras ──────────────────────────────────────────────────────────
 * Cuatro operaciones, todas primero por REST y con vuelta al SDK:
 *   actualizarDoc   campos sueltos (undefined = borrar el campo)
 *   reemplazarDoc   el documento entero, con marca de tiempo del servidor
 *   borrarDoc
 *   escribirLote    varias de las anteriores en un solo commit (≤ 500)
 */

/**
 * @param {object} cambios  {campo: valor}; `undefined` borra el campo
 * @param {{crearSiFalta?: boolean}} [opciones]  por defecto falla si el
 *        documento no existe (como updateDoc); con crearSiFalta lo crea (como
 *        setDoc con merge)
 */
export async function actualizarDoc(db, col, id, cambios, { crearSiFalta = false } = {}) {
  await escribirLote(db, [{ tipo: 'actualizar', col, id, datos: cambios, crearSiFalta }]);
}

/** @param {{marcaTiempo?: string|null}} [opciones]  campo que lleva la hora del servidor */
export async function reemplazarDoc(db, col, id, datos, { marcaTiempo = null } = {}) {
  await escribirLote(db, [{ tipo: 'reemplazar', col, id, datos, marcaTiempo }]);
}

export async function borrarDoc(db, col, id) {
  await escribirLote(db, [{ tipo: 'borrar', col, id }]);
}

/**
 * @param {Array<{tipo: 'actualizar'|'reemplazar'|'borrar', col: string, id: string,
 *                datos?: object, marcaTiempo?: string|null, crearSiFalta?: boolean}>} escrituras
 */
export async function escribirLote(db, escrituras) {
  if (!escrituras?.length) return;
  const hecho = await commitRest(armarEscrituras(escrituras));
  if (hecho) return;
  await escribirLoteSdk(db, escrituras);
}

/** Las escrituras en la forma que espera `documents:commit`. Puro, para probar. */
export function armarEscrituras(escrituras) {
  return escrituras.map(e => {
    const name = `${BASE}/${e.col}/${e.id}`;
    if (e.tipo === 'borrar') return { delete: name };

    if (e.tipo === 'actualizar') {
      const fields = {};
      const fieldPaths = [];
      for (const [clave, valor] of Object.entries(e.datos || {})) {
        fieldPaths.push(rutaDeCampo(clave));
        // En la máscara pero sin valor: eso es borrar el campo.
        if (valor !== undefined) fields[clave] = codificarValor(valor);
      }
      const w = { update: { name, fields }, updateMask: { fieldPaths } };
      if (!e.crearSiFalta) w.currentDocument = { exists: true };
      return w;
    }

    // reemplazar
    const { [e.marcaTiempo]: _ignorada, ...resto } = e.datos || {};
    const fields = {};
    for (const [clave, valor] of Object.entries(e.marcaTiempo ? resto : (e.datos || {}))) {
      if (valor !== undefined) fields[clave] = codificarValor(valor);
    }
    const w = { update: { name, fields } };
    if (e.marcaTiempo) {
      w.updateTransforms = [{ fieldPath: e.marcaTiempo, setToServerValue: 'REQUEST_TIME' }];
    }
    return w;
  });
}

// Los nombres de campo con caracteres raros van entre acentos graves en la
// máscara. Los nuestros son `tienda_*`, pero mejor no depender de eso.
function rutaDeCampo(clave) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(clave) ? clave : '`' + String(clave).replace(/`/g, '\\`') + '`';
}

/**
 * Manda el commit. `true` si se hizo; `false` si hay que caer al SDK (sin
 * sesión, sin red, timeout, servidor caído). Si el servidor rechazó la
 * escritura, tira con el mensaje: eso el SDK tampoco lo iba a poder hacer.
 */
async function commitRest(writes) {
  const token = await tokenDeSesion();
  if (!token) return false;

  let r;
  try {
    r = await conEspera(`${REST}:commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes }),
    }, ESPERA_ESCRITURA_MS);
  } catch (err) {
    console.warn('[tienda] escritura por REST no respondió, se usa el SDK:', err?.message || err);
    return false;
  }
  if (r.ok) return true;
  if (r.status >= 500) {
    console.warn(`[tienda] escritura por REST devolvió ${r.status}, se usa el SDK`);
    return false;
  }
  const cuerpo = await r.json().catch(() => ({}));
  throw new Error(cuerpo?.error?.message || `Firestore respondió ${r.status}`);
}

async function tokenDeSesion() {
  try {
    const { auth } = await import('./auth.js');
    return await auth?.currentUser?.getIdToken() || null;
  } catch (_) {
    return null;
  }
}

/** El mismo lote por el SDK, para cuando la REST no está. */
async function escribirLoteSdk(db, escrituras) {
  const lote = writeBatch(db);
  for (const e of escrituras) {
    const referencia = doc(db, e.col, e.id);
    if (e.tipo === 'borrar') { lote.delete(referencia); continue; }
    if (e.tipo === 'actualizar') {
      const datos = {};
      for (const [clave, valor] of Object.entries(e.datos || {})) {
        datos[clave] = valor === undefined ? deleteField() : valor;
      }
      // `mergeFields` y no `{ merge: true }`: el merge del SDK es PROFUNDO y
      // deja vivas las claves viejas de un mapa, mientras que la `updateMask`
      // de la REST reemplaza el campo entero. Borrando un aviso de rubro con la
      // REST caída, por una puerta el mapa quedaba sin la clave y por la otra
      // el aviso borrado seguía ahí. Las dos tienen que hacer lo mismo.
      if (e.crearSiFalta) lote.set(referencia, datos, { mergeFields: Object.keys(datos) });
      else lote.update(referencia, datos);
      continue;
    }
    const datos = { ...(e.datos || {}) };
    if (e.marcaTiempo) datos[e.marcaTiempo] = serverTimestamp();
    lote.set(referencia, datos);
  }
  await lote.commit();
}

async function proximoOrden(db) {
  const porRest = await maxOrdenRest();
  if (porRest !== null) return porRest + 1;
  try {
    const snap = await getDocs(query(
      collection(db, 'tienda_productos'), orderBy('orden', 'desc'), limit(1)));
    return (snap.docs[0]?.get('orden') ?? 0) + 1;
  } catch (err) {
    console.warn('[tienda] no se pudo calcular el orden:', err);
    return 999999;
  }
}

/* ── Fotos ───────────────────────────────────────────────────────────────── */

/**
 * El SDK de Storage se carga recién cuando alguien sube o borra una foto.
 *
 * Es el único pedazo del panel que lo necesita, y son unos 40 kB: quien entra a
 * mirar qué está publicado no tiene por qué descargarlos. De paso, el resto de
 * este módulo queda importable sin Firebase, que es lo que permite compararlo
 * contra el sync en las pruebas.
 */
let _almacen = null;

async function almacenamiento() {
  if (!_almacen) {
    const [{ getStorage }, { app }] = await Promise.all([
      import('firebase/storage'),
      import('./firebase.js'),
    ]);
    _almacen = { sdk: await import('firebase/storage'), storage: getStorage(app) };
  }
  return _almacen;
}

// Lo mismo que hace scripts/importar_fotos.py: 900 px de lado mayor y WebP.
// Medido ahí: 664 KB → 21 KB. Una tienda que se abre con datos móviles no
// puede servir la foto tal como salió de la cámara.
const LADO_MAXIMO = 900;
const CALIDAD = 0.82;

/**
 * Achica, pasa a WebP y sube. Devuelve la URL pública.
 *
 * La compresión se hace en el navegador a propósito: subir 4 MB para que el
 * servidor los tire es pagar la subida dos veces, y con la conexión del local
 * eso son varios segundos por foto.
 */
export async function subirFoto(docId, archivo, { alProgreso = null } = {}) {
  if (!archivo || !archivo.type?.startsWith('image/')) {
    throw new Error('Eso no es una imagen.');
  }

  alProgreso?.('Achicando…');
  const webp = await aWebp(archivo);

  alProgreso?.('Subiendo…');
  const { sdk, storage } = await almacenamiento();
  const nombre = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
  const destino = sdk.ref(storage, `tienda/${docId}/${nombre}`);
  await sdk.uploadBytes(destino, webp,
    { contentType: 'image/webp', cacheControl: 'public,max-age=31536000' });

  return sdk.getDownloadURL(destino);
}

/**
 * Borra la foto del almacenamiento.
 *
 * Si falla no se corta nada: lo que importa es que salga del producto. Una
 * imagen huérfana en Storage cuesta centavos; un botón que no responde porque
 * el borrado falló cuesta que nadie use el panel.
 */
export async function borrarFoto(url) {
  try {
    const { sdk, storage } = await almacenamiento();
    await sdk.deleteObject(sdk.ref(storage, url));
  } catch (err) {
    console.warn('[tienda] no se pudo borrar la foto de Storage:', err?.code || err);
  }
}

function aWebp(archivo) {
  return new Promise((listo, error) => {
    const lector = new FileReader();
    lector.onerror = () => error(new Error('No se pudo leer el archivo.'));
    lector.onload = () => {
      const imagen = new Image();
      imagen.onerror = () => error(new Error('No se pudo abrir la imagen.'));
      imagen.onload = () => {
        const escala = Math.min(1, LADO_MAXIMO / Math.max(imagen.width, imagen.height));
        const lienzo = document.createElement('canvas');
        lienzo.width = Math.round(imagen.width * escala);
        lienzo.height = Math.round(imagen.height * escala);

        const pincel = lienzo.getContext('2d');
        // Fondo blanco: los PNG con transparencia quedaban con el fondo negro
        // al pasar a WebP sin canal alfa.
        pincel.fillStyle = '#ffffff';
        pincel.fillRect(0, 0, lienzo.width, lienzo.height);
        pincel.drawImage(imagen, 0, 0, lienzo.width, lienzo.height);

        lienzo.toBlob(
          blob => blob ? listo(blob) : error(new Error('No se pudo convertir la imagen.')),
          'image/webp', CALIDAD);
      };
      imagen.src = lector.result;
    };
    lector.readAsDataURL(archivo);
  });
}

/**
 * Las variedades como tienen que quedar en el espejo: con el precio propio de
 * cada color ya rebajado, si al producto le toca un descuento.
 *
 * El que elige un color paga el precio de ESE color (`precioDeRenglon` en
 * tienda/src/precios.js, y lo mismo el servidor al armar el pedido). Escribir
 * las del catálogo, a precio de lista, dejaba la cinta "−20%" y el tachado
 * puestos y el color cobrando el precio entero hasta la corrida siguiente del
 * sync, hasta seis horas después.
 *
 * Si los descuentos no se pueden leer se escriben a precio de lista, que es lo
 * que pasaba siempre: el sync lo corrige en la próxima corrida, y un stock que
 * no llega a la vidriera se nota mucho antes.
 */
async function variedadesConSuRebaja(db, docId, datos, medidas) {
  let descuentos = [];
  try { descuentos = await leerDescuentosVigentes(db); } catch (_) { /* a precio de lista */ }
  if (!descuentos.length) return medidas.variedades;
  // El documento entero y no un objeto armado a mano: a qué descuento cae el
  // producto se decide por el rubro y el subrubro tal como los publica el
  // espejo, y esa traducción vive en un solo lugar.
  return aplicarDescuento(String(docId), documentoEspejo(datos), descuentos).variedades;
}

/**
 * Le avisa a la tienda el stock nuevo de un producto, en el momento.
 *
 * El POS ya hace esto en cada venta. Esto cubre el otro lado: una reposición o
 * un conteo cargado desde el panel. Sin esto, la vidriera se enteraba recién en
 * la próxima corrida del sync.
 *
 * Se decide con `motivoDeNoPublicar()`, la MISMA regla que corre el sync, y no
 * comparando contra cero a mano. Comparar contra cero dejaba ofrecido lo que no
 * se puede comprar: un producto con venta mínima 50 y 42 en góndola seguía en
 * la vidriera, entraba al pedido y desaparecía al confirmarlo. La regla ya
 * contempla ese caso (y todos los demás), así que acá no se reimplementa nada.
 * No se le pasa la lista de rubros a propósito: el rubro y el subrubro no
 * cambiaron, lo único que cambió es el stock.
 *
 * `updateDoc` falla si el producto no está publicado, que es justo lo que
 * queremos: no inventar fichas a medias para los 7.000 productos que no salen a
 * la web. Nunca tira error hacia arriba: que la vidriera no se entere no puede
 * voltear una edición de stock que ya se guardó.
 *
 * @param {number} stock  el stock nuevo; alcanza solo si no viene `producto`
 * @param {object|null} producto  el producto del catálogo YA con el stock nuevo
 *        aplicado. Sin él no hay forma de saber la venta mínima ni el stock de
 *        cada variedad, y se cae a la comparación contra cero de siempre.
 */
export async function avisarStockALaTienda(db, docId, stock, producto = null) {
  if (!db || !docId) return;
  const { doc, updateDoc, deleteDoc } = await import('firebase/firestore');

  const datos = (producto && typeof producto === 'object') ? producto : null;
  const medidas = datos ? medidasDe(datos) : null;
  const n = Number(stock);
  const sigueEnLaTienda = datos
    ? motivoDeNoPublicar(datos) === null
    : (Number.isFinite(n) && n > 0);

  try {
    const ref = doc(db, 'tienda_productos', String(docId));
    if (sigueEnLaTienda) {
      // Las variedades viajan con el total: un producto con colores guardaba el
      // stock nuevo arriba y el de cada color viejo, así que el cliente elegía
      // un color agotado y el pedido se caía al confirmarlo. Y con la rebaja
      // puesta, o el color volvía al precio de lista abajo de la cinta.
      await updateDoc(ref, medidas
        ? { stock: medidas.stock,
            variedades: await variedadesConSuRebaja(db, docId, datos, medidas) }
        : { stock: Math.round(n) });
    } else {
      await deleteDoc(ref);
      // Se fue de la tienda: el conteo de la portada se rehace en unos segundos.
      programarRecuentoDeRubros(db);
    }
  } catch {
    // No está publicado (o ya no existe): no hay nada que avisar.
  }
}

/**
 * Un producto borrado del catálogo se va de la tienda en el momento. Antes
 * quedaba en la vidriera hasta la próxima corrida del sync (hasta seis horas)
 * y el cliente lo podía poner en el pedido.
 */
export async function sacarDeLaTienda(db, docId) {
  if (!db || !docId) return;
  try {
    await borrarDoc(db, 'tienda_productos', String(docId));
    programarRecuentoDeRubros(db);
  } catch {
    // El sync lo saca en la próxima corrida.
  }
}
