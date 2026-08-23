/**
 * Comprobante de transferencia.
 *
 * El cliente adjunta la captura o el PDF de la transferencia desde la pantalla
 * de su pedido, y en el panel se ve junto al pedido para que el local mire los
 * datos y decida. No se valida nada automáticamente: confirmar que la plata
 * entró lo hace una persona mirando el homebanking, que es lo único que da
 * certeza.
 *
 * Se guarda en `tienda_comprobantes/{pedidoId}` y NO adentro del pedido: el
 * documento del pedido tiene el total, el estado y la dirección, y solo lo puede
 * tocar el local. Dejar que el cliente le escriba encima para adjuntar algo
 * abriría esa puerta por una función accesoria.
 *
 * Las fotos se achican antes de subir —una foto de celular son 4 MB y hay que
 * poder abrirla desde el mostrador con la conexión del local— pero no tanto como
 * las de producto: acá hay números chicos que se tienen que poder leer.
 */
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from './firebase.js';

const LADO_MAXIMO = 1600;
const CALIDAD = 0.86;
const TOPE_BYTES = 8 * 1024 * 1024;

let _almacen = null;

async function almacenamiento() {
  if (!_almacen) {
    const [sdk, { app }] = await Promise.all([
      import('firebase/storage'),
      import('./firebase.js'),
    ]);
    _almacen = { sdk, storage: sdk.getStorage(app) };
  }
  return _almacen;
}

export function esComprobanteValido(archivo) {
  if (!archivo) return 'No se eligió ningún archivo.';
  const tipo = archivo.type || '';
  if (!tipo.startsWith('image/') && tipo !== 'application/pdf') {
    return 'Tiene que ser una imagen o un PDF.';
  }
  if (archivo.size > TOPE_BYTES) return 'El archivo es muy pesado (máximo 8 MB).';
  return null;
}

/**
 * Lo que este navegador subió para un pedido, para poder mostrárselo.
 *
 * `tienda_comprobantes` no tiene lectura pública a propósito, así que la
 * pantalla del pedido no puede preguntarle a la base "¿ya mandó algo?". Pero
 * el que sube es casi siempre el que vuelve a mirar, y en su aparato el dato
 * está: se guarda acá al subir y la pantalla lo usa para la vista previa.
 * En otro aparato simplemente no hay miniatura; el estado "enviado" no depende
 * de esto, porque un pedido por transferencia nace recién con el comprobante.
 */
const CLAVE_RECUERDO = 'll-comprobante-';

export function comprobanteRecordado(pedidoId) {
  try {
    return JSON.parse(localStorage.getItem(CLAVE_RECUERDO + String(pedidoId)) || 'null');
  } catch (_) {
    return null;
  }
}

function recordarComprobante(pedidoId, dato) {
  try {
    localStorage.setItem(CLAVE_RECUERDO + String(pedidoId), JSON.stringify(dato));
  } catch (_) { /* navegación privada: la vista previa no aparece y ya */ }
}

/**
 * Sube el comprobante y lo deja anotado para el local.
 * Devuelve { url, tipo }.
 */
export async function subirComprobante(pedidoId, archivo, { alProgreso = null } = {}) {
  const problema = esComprobanteValido(archivo);
  if (problema) throw new Error(problema);

  const esPdf = archivo.type === 'application/pdf';
  let cuerpo = archivo;

  if (!esPdf) {
    alProgreso?.('Preparando…');
    cuerpo = await aWebp(archivo);
  }

  alProgreso?.('Subiendo…');
  const { sdk, storage } = await almacenamiento();
  const nombre = `${Date.now()}.${esPdf ? 'pdf' : 'webp'}`;
  const destino = sdk.ref(storage, `comprobantes/${pedidoId}/${nombre}`);
  await sdk.uploadBytes(destino, cuerpo, {
    contentType: esPdf ? 'application/pdf' : 'image/webp',
    cacheControl: 'private,max-age=0',
  });
  const url = await sdk.getDownloadURL(destino);

  alProgreso?.('Avisando al local…');
  await setDoc(doc(db, 'tienda_comprobantes', String(pedidoId)), {
    pedido_id: String(pedidoId),
    url,
    tipo: esPdf ? 'pdf' : 'imagen',
    subido_en: serverTimestamp(),
  });

  const subido = { url, tipo: esPdf ? 'pdf' : 'imagen' };
  recordarComprobante(pedidoId, subido);
  return subido;
}

/**
 * Achica y pasa a WebP. Si algo falla —un HEIC que el navegador no abre, por
 * ejemplo— se sube el archivo original: es preferible un comprobante pesado
 * antes que uno que no llegó.
 */
function aWebp(archivo) {
  return new Promise(listo => {
    const lector = new FileReader();
    lector.onerror = () => listo(archivo);
    lector.onload = () => {
      const imagen = new Image();
      imagen.onerror = () => listo(archivo);
      imagen.onload = () => {
        try {
          const escala = Math.min(1, LADO_MAXIMO / Math.max(imagen.width, imagen.height));
          const lienzo = document.createElement('canvas');
          lienzo.width = Math.round(imagen.width * escala);
          lienzo.height = Math.round(imagen.height * escala);
          lienzo.getContext('2d').drawImage(imagen, 0, 0, lienzo.width, lienzo.height);
          lienzo.toBlob(b => listo(b || archivo), 'image/webp', CALIDAD);
        } catch (_) {
          listo(archivo);
        }
      };
      imagen.src = lector.result;
    };
    lector.readAsDataURL(archivo);
  });
}
