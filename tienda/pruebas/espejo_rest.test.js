/**
 * El camino rápido de guardar en el panel.
 *
 * Guardar desde la sección Tienda leía tres veces por el SDK en fila, y en la
 * webapp una lectura suelta por el SDK queda encolada detrás de los listeners
 * grandes (medido: más de un minuto). Ahora el catálogo no se relee (se aplican
 * los cambios sobre lo que el panel ya tiene) y el espejo se lee por la API
 * REST, que no pasa por esa cola. Acá se prueba la parte pura: cómo se aplican
 * los cambios y cómo se traducen los valores tipados de la REST. La red se
 * reemplaza por un `fetch` de mentira.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  aplicarCambios, decodificarValor, decodificarCampos, codificarValor,
  leerDocEspejoRest, consultarEspejoRest,
} from '../../webapp/src/tienda_espejo.js';

describe('aplicar los cambios sobre el producto en memoria', () => {
  it('pisa, agrega y borra (undefined = borrar el campo), sin tocar el original', () => {
    const datos = { nombre: 'X', tienda_nombre: 'Viejo', tienda_destacado: true };
    const salida = aplicarCambios(datos, {
      tienda_nombre: 'Nuevo', tienda_destacado: undefined, tienda_imagenes: ['a'],
    });
    expect(salida).toEqual({ nombre: 'X', tienda_nombre: 'Nuevo', tienda_imagenes: ['a'] });
    expect(datos.tienda_destacado).toBe(true);
  });

  it('aguanta datos o cambios vacíos', () => {
    expect(aplicarCambios(null, { a: 1 })).toEqual({ a: 1 });
    expect(aplicarCambios({ a: 1 }, null)).toEqual({ a: 1 });
  });
});

describe('los valores tipados de la REST de Firestore', () => {
  it('se traducen a JS común, incluso anidados', () => {
    expect(decodificarValor({ integerValue: '309' })).toBe(309);
    expect(decodificarValor({ doubleValue: 2.5 })).toBe(2.5);
    expect(decodificarValor({ stringValue: 'Rojo' })).toBe('Rojo');
    expect(decodificarValor({ booleanValue: true })).toBe(true);
    expect(decodificarValor({ nullValue: null })).toBeNull();
    expect(decodificarValor({ arrayValue: { values: [{ stringValue: 'a' }, { integerValue: '2' }] } }))
      .toEqual(['a', 2]);
    expect(decodificarValor({ arrayValue: {} })).toEqual([]);
    expect(decodificarValor({ mapValue: { fields: { nombre: { stringValue: 'Oferta' },
                                                     porcentaje: { integerValue: '10' } } } }))
      .toEqual({ nombre: 'Oferta', porcentaje: 10 });
    expect(decodificarValor({ timestampValue: '2026-08-17T12:00:00Z' })).toBeInstanceOf(Date);
    expect(decodificarValor(undefined)).toBeNull();
    expect(decodificarValor({ raroValue: 1 })).toBeNull();
  });

  it('un documento entero', () => {
    expect(decodificarCampos({
      precio: { integerValue: '9900' }, precio_anterior: { nullValue: null },
      variedades: { arrayValue: { values: [{ mapValue: { fields: {
        nombre: { stringValue: 'Rojo' }, imagen: { nullValue: null } } } }] } },
    })).toEqual({ precio: 9900, precio_anterior: null, variedades: [{ nombre: 'Rojo', imagen: null }] });
    expect(decodificarCampos(undefined)).toEqual({});
  });

  it('el camino inverso para filtrar por igualdad', () => {
    expect(codificarValor('LIBRERÍA')).toEqual({ stringValue: 'LIBRERÍA' });
    expect(codificarValor(3)).toEqual({ integerValue: '3' });
    expect(codificarValor(2.5)).toEqual({ doubleValue: 2.5 });
    expect(codificarValor(true)).toEqual({ booleanValue: true });
    expect(codificarValor(null)).toEqual({ nullValue: null });
  });
});

describe('leer el espejo por REST', () => {
  const RESPUESTA = (status, cuerpo) => Promise.resolve({
    ok: status >= 200 && status < 300, status, json: () => Promise.resolve(cuerpo),
  });
  const original = globalThis.fetch;
  afterEach(() => { globalThis.fetch = original; });

  it('un documento existente vuelve decodificado y con la máscara pedida', async () => {
    const llamadas = [];
    globalThis.fetch = vi.fn((url) => {
      llamadas.push(String(url));
      return RESPUESTA(200, { fields: { orden: { integerValue: '309' }, orden_rubro: { integerValue: '5' } } });
    });
    const r = await leerDocEspejoRest('190500000047', ['orden', 'orden_rubro']);
    expect(r).toEqual({ existe: true, datos: { orden: 309, orden_rubro: 5 } });
    expect(llamadas[0]).toContain('/tienda_productos/190500000047?mask.fieldPaths=orden&mask.fieldPaths=orden_rubro');
  });

  it('404 es "no existe", y un error de red o de servidor es null para caer al SDK', async () => {
    globalThis.fetch = vi.fn(() => RESPUESTA(404, {}));
    expect(await leerDocEspejoRest('nada')).toEqual({ existe: false, datos: null });

    globalThis.fetch = vi.fn(() => RESPUESTA(500, {}));
    expect(await leerDocEspejoRest('x')).toBeNull();

    globalThis.fetch = vi.fn(() => Promise.reject(new Error('sin red')));
    expect(await leerDocEspejoRest('x')).toBeNull();
  });

  it('la consulta arma el where, el select y el orden, y devuelve id + datos', async () => {
    let cuerpoEnviado = null;
    globalThis.fetch = vi.fn((url, opciones) => {
      cuerpoEnviado = JSON.parse(opciones.body);
      return RESPUESTA(200, [
        { document: { name: 'projects/p/databases/(default)/documents/tienda_productos/A1',
                      fields: { precio: { integerValue: '100' } } } },
        { readTime: 'x' },   // Firestore manda filas sin documento: se ignoran
        { document: { name: 'projects/p/databases/(default)/documents/tienda_productos/B2',
                      fields: { precio: { integerValue: '200' } } } },
      ]);
    });
    const filas = await consultarEspejoRest({
      donde: { rubro: 'LIBRERÍA' }, campos: ['precio'], ordenarPor: 'orden', descendente: true, limite: 1,
    });
    expect(filas).toEqual([{ id: 'A1', datos: { precio: 100 } }, { id: 'B2', datos: { precio: 200 } }]);
    expect(cuerpoEnviado.structuredQuery).toEqual({
      from: [{ collectionId: 'tienda_productos' }],
      where: { fieldFilter: { field: { fieldPath: 'rubro' }, op: 'EQUAL', value: { stringValue: 'LIBRERÍA' } } },
      select: { fields: [{ fieldPath: 'precio' }] },
      orderBy: [{ field: { fieldPath: 'orden' }, direction: 'DESCENDING' }],
      limit: 1,
    });
  });

  it('sin filas es una lista vacía, y si la REST falla es null', async () => {
    globalThis.fetch = vi.fn(() => RESPUESTA(200, [{ readTime: 'x' }]));
    expect(await consultarEspejoRest({ donde: { rubro: 'NADA' } })).toEqual([]);
    globalThis.fetch = vi.fn(() => RESPUESTA(403, {}));
    expect(await consultarEspejoRest({})).toBeNull();
  });
});
