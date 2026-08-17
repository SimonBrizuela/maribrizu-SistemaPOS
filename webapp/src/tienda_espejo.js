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
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, writeBatch,
  query, orderBy, limit, getDocs, serverTimestamp, deleteField,
} from 'firebase/firestore';

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

export function nombreBonito(texto) {
  const palabras = String(texto ?? '').trim().split(/\s+/).filter(Boolean);
  if (!palabras.length) return '';
  return palabras.map((palabra, i) => {
    // Códigos y medidas (C12-003, A4, 500ML) se dejan como vinieron.
    if (/\d/.test(palabra)) return palabra.toUpperCase();
    const baja = palabra.toLowerCase();
    if (i > 0 && MENORES.has(baja)) return baja;
    return baja.charAt(0).toUpperCase() + baja.slice(1);
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
    tokens: tokenizar(nombre, marca, datos?.categoria, datos?.sub_rubro),
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
  if (medidasDe(datos).stock <= 0) return 'sin stock';

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
 * @returns {Promise<{publicado: boolean, motivo: string|null}>}
 */
export async function guardarYEspejar(db, docId, cambios, rubrosHabilitados = null,
                                      subrubrosExcluidos = null) {
  const referencia = doc(db, 'catalogo', docId);

  // Se limpia en vez de guardar `undefined`: un campo borrado vuelve al
  // comportamiento automático, y eso es distinto de tenerlo en falso.
  const aGuardar = {};
  for (const [clave, valor] of Object.entries(cambios)) {
    aGuardar[clave] = valor === undefined ? deleteField() : valor;
  }
  if (Object.keys(aGuardar).length) await updateDoc(referencia, aGuardar);

  const snap = await getDoc(referencia);
  if (!snap.exists()) return { publicado: false, motivo: 'el producto ya no existe' };

  return espejar(db, docId, snap.data(), rubrosHabilitados, subrubrosExcluidos);
}

/** Escribe (o borra) el documento del espejo según corresponda. */
export async function espejar(db, docId, datos, rubrosHabilitados = null,
                              subrubrosExcluidos = null) {
  const motivo = motivoDeNoPublicar(datos, rubrosHabilitados, subrubrosExcluidos);
  const referencia = doc(db, 'tienda_productos', docId);

  if (motivo) {
    await deleteDoc(referencia).catch(() => {});
    return { publicado: false, motivo };
  }

  const documento = documentoEspejo(datos);

  // `orden` y `orden_rubro` los calcula el sync mirando el catálogo entero: son
  // la posición dentro de la lista completa y no se pueden deducir de un
  // producto solo. Lo recién publicado va al final hasta la próxima corrida,
  // que es honesto: no se cuela adelante de nada.
  const anterior = await getDoc(referencia);
  if (anterior.exists()) {
    documento.orden = anterior.get('orden') ?? await proximoOrden(db);
    documento.orden_rubro = anterior.get('orden_rubro') ?? 0;
  } else {
    documento.orden = await proximoOrden(db);
    documento.orden_rubro = 999999;
  }

  await setDoc(referencia, documento);
  return { publicado: true, motivo: null };
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
  let lote = writeBatch(db);
  let pendientes = 0;

  for (const [i, { id, datos }] of productos.entries()) {
    const referencia = doc(db, 'tienda_productos', id);

    if (motivoDeNoPublicar(datos, rubrosHabilitados, subrubrosExcluidos)) {
      lote.delete(referencia);
      sacados++;
    } else {
      // `orden` real lo recalcula el sync sobre el catálogo completo; acá se
      // numera correlativo al final para no dejar huecos en el paginado.
      lote.set(referencia, { ...documentoEspejo(datos), orden: orden++, orden_rubro: 999999 });
      publicados++;
    }

    if (++pendientes >= 450) {
      await lote.commit();
      lote = writeBatch(db);
      pendientes = 0;
      alProgreso?.(i + 1, productos.length);
    }
  }

  if (pendientes) await lote.commit();
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

  for (const { datos } of productos) {
    if (motivoDeNoPublicar(datos, rubrosHabilitados, subrubrosExcluidos)) continue;
    const rubro = String(datos?.rubro ?? '').trim().toUpperCase();
    if (!rubro) continue;

    const actual = conteo.get(rubro) || { cantidad: 0, con_stock: 0, subrubros: new Map() };
    if (!actual.subrubros) actual.subrubros = new Map();

    // Los subrubros que de verdad quedaron publicados en ese rubro. Es lo que
    // la tienda usa para la segunda fila de filtros: listarlos desde el
    // catálogo entero mostraría filtros que no devuelven nada.
    const sub = claveDeRubro(datos?.sub_rubro);
    if (sub) actual.subrubros.set(sub, (actual.subrubros.get(sub) || 0) + 1);

    actual.cantidad++;
    // Publicado implica stock, pero se cuenta igual: el campo lo usa la portada
    // para saber hasta dónde puede saltar al elegir productos al azar.
    if (medidasDe(datos).stock > 0) actual.con_stock++;
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

  await setDoc(doc(db, 'tienda_config', 'rubros'), { lista, actualizado: serverTimestamp() });
  return lista;
}

async function proximoOrden(db) {
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
