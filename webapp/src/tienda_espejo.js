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
  };
}

/** El documento tal cual va a `tienda_productos`. Gemelo de armar_documento(). */
export function documentoEspejo(datos) {
  const nombre = String(datos?.tienda_nombre ?? '').trim() || nombreBonito(datos?.nombre);

  let marca = String(datos?.marca ?? '').trim();
  if (marca.toUpperCase() === 'SIN MARCA') marca = '';

  const m = medidasDe(datos);
  const imagenes = Array.isArray(datos?.tienda_imagenes) ? datos.tienda_imagenes : [];

  return {
    nombre,
    descripcion: String(datos?.tienda_descripcion ?? '').trim(),
    precio: m.precio,
    precio_anterior: null,
    precio_pack: m.precio_pack,
    pack_tipo: m.pack_tipo,
    pack_nombre: m.pack_nombre,
    pack_contenido: m.pack_contenido,
    unidad: m.unidad,
    stock: m.stock,
    rubro: String(datos?.rubro ?? '').trim().toUpperCase(),
    categoria: nombreBonito(datos?.categoria),
    sub_rubro: nombreBonito(datos?.sub_rubro),
    marca,
    imagenes: imagenes.filter(Boolean).map(String),
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

export function motivoDeNoPublicar(datos, rubrosHabilitados = null) {
  if (datos?.tienda_publicar === false) return 'excluido a mano';
  if (String(datos?.estado ?? '').toLowerCase() !== 'activo') return 'no está activo';
  if (datos?.duplicado === true) return 'marcado como duplicado';

  const nombre = String(datos?.nombre ?? '').trim().toUpperCase();
  if (!nombre) return 'sin nombre';
  if (NOMBRES_INTERNOS.some(p => nombre.startsWith(p))) return 'producto interno del POS';
  if (numero(datos, 'precio_venta') <= 0) return 'sin precio';
  if (medidasDe(datos).stock <= 0) return 'sin stock';

  if (datos?.tienda_publicar === true) return null;
  if (!rubrosHabilitados) return null;

  const rubro = String(datos?.rubro ?? '').trim().toUpperCase();
  return rubrosHabilitados.includes(rubro) ? null : 'el rubro no está habilitado';
}

export function estaPublicable(datos, rubrosHabilitados = null) {
  return motivoDeNoPublicar(datos, rubrosHabilitados) === null;
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
 * @returns {Promise<{publicado: boolean, motivo: string|null}>}
 */
export async function guardarYEspejar(db, docId, cambios, rubrosHabilitados = null) {
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

  return espejar(db, docId, snap.data(), rubrosHabilitados);
}

/** Escribe (o borra) el documento del espejo según corresponda. */
export async function espejar(db, docId, datos, rubrosHabilitados = null) {
  const motivo = motivoDeNoPublicar(datos, rubrosHabilitados);
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
export async function espejarLote(db, productos, rubrosHabilitados, alProgreso = null) {
  let orden = await proximoOrden(db);
  let publicados = 0;
  let sacados = 0;
  let lote = writeBatch(db);
  let pendientes = 0;

  for (const [i, { id, datos }] of productos.entries()) {
    const referencia = doc(db, 'tienda_productos', id);

    if (motivoDeNoPublicar(datos, rubrosHabilitados)) {
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
export async function recomputarRubros(db, productos, rubrosHabilitados) {
  const conteo = new Map();

  for (const { datos } of productos) {
    if (motivoDeNoPublicar(datos, rubrosHabilitados)) continue;
    const rubro = String(datos?.rubro ?? '').trim().toUpperCase();
    if (!rubro) continue;

    const actual = conteo.get(rubro) || { cantidad: 0, con_stock: 0 };
    actual.cantidad++;
    // Publicado implica stock, pero se cuenta igual: el campo lo usa la portada
    // para saber hasta dónde puede saltar al elegir productos al azar.
    if (medidasDe(datos).stock > 0) actual.con_stock++;
    conteo.set(rubro, actual);
  }

  const lista = [...conteo.entries()]
    .map(([clave, n]) => ({ nombre: nombreBonito(clave), clave, ...n }))
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
