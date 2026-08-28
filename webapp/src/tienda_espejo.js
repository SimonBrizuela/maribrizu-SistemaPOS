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
      precio: precio ? Math.round(precio) : null,
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
      unidad, precio: Math.round(precioVenta), precio_pack: null,
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
    precio: Math.round(precioUnidad || precioVenta),
    precio_pack: hayPack ? Math.round(precioVenta) : null,
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
 * El rubro manda: si está apagado no se publica nada de él. Prendido, sale todo
 * salvo los subrubros destildados. Así no hay forma de que las dos listas se
 * contradigan.
 *
 * El interruptor por producto sigue ganándole a las dos: es lo más específico
 * que puede decir alguien, y por eso se evalúa antes.
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

  if (datos?.tienda_publicar === true) return null;

  const rubro = claveDeRubro(datos?.rubro);

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
  if (!rubrosHabilitados.includes(rubro)) return 'el rubro no está habilitado';

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

/** Escribe (o borra) el documento del espejo según corresponda. */
export async function espejar(db, docId, datos, rubrosHabilitados = null,
                              subrubrosExcluidos = null) {
  const motivo = motivoDeNoPublicar(datos, rubrosHabilitados, subrubrosExcluidos);

  if (motivo) {
    await borrarDoc(db, 'tienda_productos', docId).catch(() => {});
    return { publicado: false, motivo };
  }

  const documento = documentoEspejo(datos);

  // `orden` y `orden_rubro` los calcula el sync mirando el catálogo entero: son
  // la posición dentro de la lista completa y no se pueden deducir de un
  // producto solo. Lo recién publicado va al final hasta la próxima corrida,
  // que es honesto: no se cuela adelante de nada.
  const anterior = await leerOrdenDelEspejo(db, docId);
  if (anterior.existe) {
    documento.orden = anterior.orden ?? await proximoOrden(db);
    documento.orden_rubro = anterior.orden_rubro ?? 0;
  } else {
    documento.orden = await proximoOrden(db);
    documento.orden_rubro = 999999;
  }

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
  return espejar(db, docId, datos, rubros, subrubrosExcluidos);
}

/**
 * Si el producto ya está en el espejo, y con qué `orden`. Por REST primero
 * (lectura pública, sin pasar por la cola del SDK); si eso falla, por el SDK.
 */
async function leerOrdenDelEspejo(db, docId) {
  const porRest = await leerEspejoRest(docId);
  if (porRest) return porRest;

  const snap = await getDoc(doc(db, 'tienda_productos', docId));
  if (!snap.exists()) return { existe: false, orden: null, orden_rubro: null };
  return {
    existe: true,
    orden: numeroONull(snap.get('orden')),
    orden_rubro: numeroONull(snap.get('orden_rubro')),
  };
}

async function leerEspejoRest(docId) {
  const leido = await leerDocEspejoRest(docId, ['orden', 'orden_rubro']);
  if (leido === null) return null;
  if (!leido.existe) return { existe: false, orden: null, orden_rubro: null };
  return {
    existe: true,
    orden: numeroONull(leido.datos.orden),
    orden_rubro: numeroONull(leido.datos.orden_rubro),
  };
}

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
  const mascara = campos?.length
    ? '?' + campos.map(c => `mask.fieldPaths=${encodeURIComponent(c)}`).join('&') : '';
  try {
    const r = await conEspera(`${REST}/tienda_productos/${encodeURIComponent(docId)}${mascara}`);
    if (r.status === 404) return { existe: false, datos: null };
    if (!r.ok) return null;
    const cuerpo = await r.json();
    return { existe: true, datos: decodificarCampos(cuerpo?.fields) };
  } catch (err) {
    console.warn('[tienda] espejo por REST no respondió, se usa el SDK:', err?.message || err);
    return null;
  }
}

/**
 * Consulta al espejo por REST. Devuelve `[{id, datos}]`, o `null` si la REST no
 * respondió. Filtra por igualdad en `donde` ({campo: valor}); `campos` limita
 * lo que viaja (un rubro son cientos de documentos con tokens y variedades).
 */
export async function consultarEspejoRest({
  donde = null, campos = null, ordenarPor = null, descendente = false, limite = null,
} = {}) {
  const consulta = { from: [{ collectionId: 'tienda_productos' }] };
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
      headers: { 'Content-Type': 'application/json' },
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
  let publicados = 0;
  let sacados = 0;
  let lote = [];

  for (const [i, { id, datos }] of productos.entries()) {
    if (motivoDeNoPublicar(datos, rubrosHabilitados, subrubrosExcluidos)) {
      lote.push({ tipo: 'borrar', col: 'tienda_productos', id });
      sacados++;
    } else {
      // `orden` real lo recalcula el sync sobre el catálogo completo; acá se
      // numera correlativo al final para no dejar huecos en el paginado.
      lote.push({
        tipo: 'reemplazar', col: 'tienda_productos', id,
        datos: { ...documentoEspejo(datos), orden: orden++, orden_rubro: 999999 },
        marcaTiempo: 'actualizado',
      });
      publicados++;
    }

    if (lote.length >= 450) {
      await escribirLote(db, lote);
      lote = [];
      alProgreso?.(i + 1, productos.length);
    }
  }

  if (lote.length) await escribirLote(db, lote);
  alProgreso?.(productos.length, productos.length);
  return { publicados, sacados };
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
    const sub = claveDeRubro(datos?.sub_rubro);
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
    .sort((a, b) => b.cantidad - a.cantidad);

  await reemplazarDoc(db, 'tienda_config', 'rubros', { lista }, { marcaTiempo: 'actualizado' });
  return lista;
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
      if (e.crearSiFalta) lote.set(referencia, datos, { merge: true });
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
 * Le avisa a la tienda el stock nuevo de un producto, en el momento.
 *
 * El POS ya hace esto en cada venta. Esto cubre el otro lado: una reposición o
 * un conteo cargado desde el panel. Sin esto, la vidriera se enteraba recién en
 * la próxima corrida del sync.
 *
 * Misma regla que usa el POS y que usa el sync: si quedó en cero, el producto
 * sale de la vidriera. `updateDoc` falla si el producto no está publicado, que
 * es justo lo que queremos — no inventar fichas a medias para los 7.000
 * productos que no salen a la web.
 *
 * Nunca tira error hacia arriba: que la vidriera no se entere no puede voltear
 * una edición de stock que ya se guardó.
 */
export async function avisarStockALaTienda(db, docId, stock) {
  if (!db || !docId) return;
  const { doc, updateDoc, deleteDoc } = await import('firebase/firestore');
  const n = Number(stock);
  try {
    const ref = doc(db, 'tienda_productos', String(docId));
    if (Number.isFinite(n) && n > 0) {
      await updateDoc(ref, { stock: Math.round(n) });
    } else {
      await deleteDoc(ref);
    }
  } catch {
    // No está publicado (o ya no existe): no hay nada que avisar.
  }
}
