/**
 * Las fotos del reclamo se achican en el celular antes de mandarse.
 *
 * Una foto de cámara pesa 4 o 5 MB y la función no recibe más de 1 MB por foto:
 * sin achicarla el cliente esperaría una subida enorme para que después se la
 * rechacen. El dibujo en el lienzo lo hace el navegador; acá se prueba la
 * cuenta de las medidas y los reintentos hasta que entra.
 */
import { describe, it, expect } from 'vitest';
import { medidasAchicadas, achicarFoto, esFotoAceptada } from '../src/fotos_reclamo.js';

describe('medidasAchicadas', () => {
  it('el lado más largo queda en el tope y se respeta la proporción', () => {
    expect(medidasAchicadas(4000, 3000, 1600)).toEqual({ ancho: 1600, alto: 1200 });
    expect(medidasAchicadas(3000, 4000, 1600)).toEqual({ ancho: 1200, alto: 1600 });
  });

  it('una foto chica no se agranda', () => {
    expect(medidasAchicadas(800, 600, 1600)).toEqual({ ancho: 800, alto: 600 });
  });
});

describe('esFotoAceptada', () => {
  it('fotos sí, otros archivos no', () => {
    expect(esFotoAceptada({ type: 'image/jpeg' })).toBe(true);
    expect(esFotoAceptada({ type: 'image/heic' })).toBe(true);
    expect(esFotoAceptada({ type: 'application/pdf' })).toBe(false);
    expect(esFotoAceptada({ type: '' })).toBe(false);
  });
});

describe('achicarFoto', () => {
  // Un "navegador" de mentira: la imagen mide lo que se diga y el JPEG pesa
  // según el área y la calidad pedidas.
  const falso = ({ ancho = 4000, alto = 3000, bytesPorPixel = 0.5, falla = false } = {}) => {
    const pedidos = [];
    return {
      pedidos,
      cargar: async () => {
        if (falla) throw new Error('no se pudo decodificar');
        return { ancho, alto, soltar() {} };
      },
      dibujar: async (_imagen, medidas, calidad) => {
        pedidos.push({ ...medidas, calidad });
        const bytes = Math.round(medidas.ancho * medidas.alto * bytesPorPixel * calidad);
        return { size: bytes, bytes: new Uint8Array(4) };
      },
      aBase64: async () => 'AAAA',
    };
  };

  it('una foto de cámara sale a 1600 px en JPEG', async () => {
    const nav = falso({ bytesPorPixel: 0.2 });
    const foto = await achicarFoto({ type: 'image/jpeg' }, { navegador: nav });
    expect(nav.pedidos[0]).toMatchObject({ ancho: 1600, alto: 1200 });
    expect(foto).toMatchObject({ tipo: 'image/jpeg', datos: 'AAAA' });
    expect(foto.bytes).toBeLessThanOrEqual(1_000_000);
  });

  it('si todavía pesa de más baja la calidad y después el tamaño, hasta que entra', async () => {
    const nav = falso({ bytesPorPixel: 1.2 });
    const foto = await achicarFoto({ type: 'image/jpeg' }, { navegador: nav, maxBytes: 1_000_000 });
    expect(nav.pedidos.length).toBeGreaterThan(1);
    expect(foto.bytes).toBeLessThanOrEqual(1_000_000);
    const ultimo = nav.pedidos.at(-1);
    expect(ultimo.ancho < 1600 || ultimo.calidad < 0.82).toBe(true);
  });

  it('una foto que no se puede abrir avisa con un mensaje para el cliente', async () => {
    const nav = falso({ falla: true });
    await expect(achicarFoto({ type: 'image/heic' }, { navegador: nav })).rejects.toThrow(/No pudimos abrir/);
  });

  it('un archivo que no es foto ni se intenta', async () => {
    const nav = falso();
    await expect(achicarFoto({ type: 'application/pdf' }, { navegador: nav })).rejects.toThrow(/foto/);
    expect(nav.pedidos).toHaveLength(0);
  });

  it('si ni al mínimo entra, lo dice', async () => {
    const nav = falso({ bytesPorPixel: 500 });
    await expect(achicarFoto({ type: 'image/jpeg' }, { navegador: nav })).rejects.toThrow(/pesada/);
  });
});
