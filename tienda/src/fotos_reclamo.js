/**
 * Achica en el celular las fotos que el cliente suma a un reclamo.
 *
 * Una foto de cámara pesa varios MB y la función `crear-reclamo` no recibe más
 * de `LIMITES.bytesFoto` por foto. Se dibuja en un lienzo a 1600 px del lado
 * más largo (sobra para ver una esquina rota) y se guarda en JPEG, que lo
 * saben escribir todos los navegadores; WebP no lo escribe Safari. Si todavía
 * pesa de más, se baja la calidad y después el tamaño.
 *
 * El navegador dibuja la foto ya girada según la cámara (la orientación de la
 * EXIF): no hace falta leerla a mano.
 */
import { LIMITES } from './reclamos.js';

const LADO = 1600;
const CALIDAD = 0.82;
// Calidad y lado de cada intento, del primero al último.
const INTENTOS = [
  { escala: 1, calidad: CALIDAD },
  { escala: 1, calidad: 0.68 },
  { escala: 0.75, calidad: 0.68 },
  { escala: 0.55, calidad: 0.6 },
];

export function medidasAchicadas(ancho, alto, lado = LADO) {
  const mayor = Math.max(ancho, alto);
  if (mayor <= lado) return { ancho, alto };
  const factor = lado / mayor;
  return { ancho: Math.round(ancho * factor), alto: Math.round(alto * factor) };
}

/** Si el archivo elegido es una foto. HEIC incluido: Safari la convierte al leerla. */
export function esFotoAceptada(archivo) {
  return /^image\//.test(archivo?.type || '');
}

/** Lo que hace el navegador de verdad. Las pruebas pasan uno propio. */
const NAVEGADOR = {
  async cargar(archivo) {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    return { img, ancho: img.naturalWidth, alto: img.naturalHeight, soltar: () => URL.revokeObjectURL(url) };
  },
  async dibujar(imagen, { ancho, alto }, calidad) {
    const lienzo = document.createElement('canvas');
    lienzo.width = ancho;
    lienzo.height = alto;
    const ctx = lienzo.getContext('2d');
    // Fondo blanco: un PNG con transparencia en JPEG quedaría negro.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, ancho, alto);
    ctx.drawImage(imagen.img, 0, 0, ancho, alto);
    const blob = await new Promise(listo => lienzo.toBlob(listo, 'image/jpeg', calidad));
    if (!blob) throw new Error('el lienzo no devolvió la imagen');
    return blob;
  },
  aBase64(blob) {
    return new Promise((listo, fallo) => {
      const lector = new FileReader();
      lector.onload = () => listo(String(lector.result).replace(/^data:[^,]*,/, ''));
      lector.onerror = () => fallo(lector.error);
      lector.readAsDataURL(blob);
    });
  },
};

/**
 * @param {File} archivo
 * @returns {Promise<{tipo: 'image/jpeg', datos: string, bytes: number, blob: Blob}>}
 * @throws {Error} con un mensaje que se le puede mostrar al cliente
 */
export async function achicarFoto(archivo, { navegador = NAVEGADOR, maxBytes = LIMITES.bytesFoto } = {}) {
  if (!esFotoAceptada(archivo)) throw new Error('Ese archivo no es una foto.');

  let imagen;
  try {
    imagen = await navegador.cargar(archivo);
  } catch {
    throw new Error('No pudimos abrir esa foto. Probá con otra.');
  }

  try {
    for (const intento of INTENTOS) {
      const medidas = medidasAchicadas(imagen.ancho, imagen.alto, Math.round(LADO * intento.escala));
      const blob = await navegador.dibujar(imagen, medidas, intento.calidad);
      if (blob.size <= maxBytes) {
        return { tipo: 'image/jpeg', datos: await navegador.aBase64(blob), bytes: blob.size, blob };
      }
    }
  } finally {
    imagen.soltar?.();
  }
  throw new Error('Esa foto es muy pesada. Probá con otra.');
}
