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
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// La sesión y el SDK se reemplazan por espías: lo que se prueba es qué se
// manda por REST y cuándo se cae al SDK, no Firebase.
const getIdToken = vi.fn(async () => 'TOKEN');
vi.mock('../../webapp/src/auth.js', () => ({ auth: { currentUser: { getIdToken } } }));

const lote = { update: vi.fn(), set: vi.fn(), delete: vi.fn(), commit: vi.fn(async () => {}) };
// Antes esto apuntaba a `webapp/node_modules/firebase/...` con la ruta
// completa, porque el módulo del panel resolvía su propia copia y el espía no
// lo alcanzaba. Desde que `vitest.config.js` dedupea `firebase`, las dos puntas
// resuelven al mismo módulo y alcanza con nombrarlo como lo nombra el código.
vi.mock('firebase/firestore', () => ({
  doc: (_db, col, id) => ({ col, id }),
  getDoc: vi.fn(), getDocFromCache: vi.fn(), collection: vi.fn(), query: vi.fn(),
  orderBy: vi.fn(), limit: vi.fn(), getDocs: vi.fn(),
  writeBatch: () => lote,
  serverTimestamp: () => ({ _methodName: 'serverTimestamp' }),
  deleteField: () => ({ _methodName: 'deleteField' }),
}));

import {
  aplicarCambios, decodificarValor, decodificarCampos, codificarValor,
  leerDocEspejoRest, consultarEspejoRest, armarEscrituras, escribirLote,
} from '../../webapp/src/tienda_espejo.js';

const BASE = 'projects/mari-d7c71/databases/(default)/documents';

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

describe('codificar valores anidados para escribir', () => {
  it('listas, mapas, fechas y nulos', () => {
    expect(codificarValor(['a', 2, null])).toEqual({ arrayValue: { values: [
      { stringValue: 'a' }, { integerValue: '2' }, { nullValue: null }] } });
    expect(codificarValor({ rojo: { publicar: true, nombre: null, imagen: 'r' } })).toEqual({
      mapValue: { fields: { rojo: { mapValue: { fields: {
        publicar: { booleanValue: true }, nombre: { nullValue: null }, imagen: { stringValue: 'r' },
      } } } } } });
    expect(codificarValor(new Date('2026-08-17T12:00:00Z'))).toEqual({ timestampValue: '2026-08-17T12:00:00.000Z' });
    expect(codificarValor(NaN)).toEqual({ nullValue: null });
    // Un `undefined` adentro de un mapa se salta, no se manda como null.
    expect(codificarValor({ a: undefined, b: 1 })).toEqual({ mapValue: { fields: { b: { integerValue: '1' } } } });
  });

  it('un centinela del SDK no viaja por REST: avisa en vez de mandar basura', () => {
    expect(() => codificarValor({ _methodName: 'serverTimestamp' })).toThrow(/serverTimestamp/);
  });
});

describe('cómo se arma el commit', () => {
  it('actualizar: máscara con todos los campos, sin valor los que se borran, y exige que exista', () => {
    const [w] = armarEscrituras([{ tipo: 'actualizar', col: 'catalogo', id: 'p1',
      datos: { tienda_nombre: 'X', tienda_destacado: undefined } }]);
    expect(w).toEqual({
      update: { name: `${BASE}/catalogo/p1`, fields: { tienda_nombre: { stringValue: 'X' } } },
      updateMask: { fieldPaths: ['tienda_nombre', 'tienda_destacado'] },
      currentDocument: { exists: true },
    });
  });

  it('actualizar con crearSiFalta no lleva la precondición (como setDoc con merge)', () => {
    const [w] = armarEscrituras([{ tipo: 'actualizar', col: 'tienda_descuentos', id: 'd1',
      datos: { activo: false }, crearSiFalta: true }]);
    expect(w.currentDocument).toBeUndefined();
    expect(w.updateMask).toEqual({ fieldPaths: ['activo'] });
  });

  it('reemplazar: sin máscara (pisa el documento) y la marca de tiempo va como transformación', () => {
    const [w] = armarEscrituras([{ tipo: 'reemplazar', col: 'tienda_productos', id: 'p1',
      datos: { nombre: 'A', actualizado: { _methodName: 'serverTimestamp' } }, marcaTiempo: 'actualizado' }]);
    expect(w).toEqual({
      update: { name: `${BASE}/tienda_productos/p1`, fields: { nombre: { stringValue: 'A' } } },
      updateTransforms: [{ fieldPath: 'actualizado', setToServerValue: 'REQUEST_TIME' }],
    });
  });

  it('borrar', () => {
    expect(armarEscrituras([{ tipo: 'borrar', col: 'tienda_fotos_pedidas', id: 'x' }]))
      .toEqual([{ delete: `${BASE}/tienda_fotos_pedidas/x` }]);
  });

  it('un campo con caracteres raros va entre acentos graves en la máscara', () => {
    const [w] = armarEscrituras([{ tipo: 'actualizar', col: 'c', id: 'i', datos: { 'con espacio': 1 } }]);
    expect(w.updateMask.fieldPaths).toEqual(['`con espacio`']);
  });
});

describe('escribir: REST primero, SDK si la REST no está', () => {
  const RESPUESTA = (status, cuerpo = {}) => Promise.resolve({
    ok: status >= 200 && status < 300, status, json: () => Promise.resolve(cuerpo),
  });
  const original = globalThis.fetch;
  beforeEach(() => {
    lote.commit.mockClear(); lote.update.mockClear(); lote.set.mockClear(); lote.delete.mockClear();
  });
  afterEach(() => { globalThis.fetch = original; });

  it('con la REST andando, manda el commit con el token y no toca el SDK', async () => {
    let pedido = null;
    globalThis.fetch = vi.fn((url, opciones) => { pedido = { url: String(url), opciones }; return RESPUESTA(200); });
    await escribirLote({}, [{ tipo: 'borrar', col: 'tienda_productos', id: 'p1' }]);
    expect(pedido.url).toContain('/documents:commit');
    expect(pedido.opciones.headers.Authorization).toBe('Bearer TOKEN');
    expect(JSON.parse(pedido.opciones.body).writes).toHaveLength(1);
    expect(lote.commit).not.toHaveBeenCalled();
  });

  it('si el servidor rechaza (permiso, precondición), tira con el mensaje y no reintenta por el SDK', async () => {
    globalThis.fetch = vi.fn(() => RESPUESTA(403, { error: { message: 'Missing or insufficient permissions.' } }));
    await expect(escribirLote({}, [{ tipo: 'borrar', col: 'c', id: 'i' }]))
      .rejects.toThrow('Missing or insufficient permissions.');
    expect(lote.commit).not.toHaveBeenCalled();
  });

  it('si la REST no responde o el servidor está caído, cae al SDK con las mismas escrituras', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('sin red')));
    await escribirLote({}, [
      { tipo: 'actualizar', col: 'catalogo', id: 'p1', datos: { tienda_nombre: 'X', tienda_destacado: undefined } },
      { tipo: 'reemplazar', col: 'tienda_productos', id: 'p1', datos: { nombre: 'A' }, marcaTiempo: 'actualizado' },
      { tipo: 'borrar', col: 'tienda_fotos_pedidas', id: 'p1' },
    ]);
    expect(lote.update).toHaveBeenCalledWith({ col: 'catalogo', id: 'p1' },
      { tienda_nombre: 'X', tienda_destacado: { _methodName: 'deleteField' } });
    expect(lote.set).toHaveBeenCalledWith({ col: 'tienda_productos', id: 'p1' },
      { nombre: 'A', actualizado: { _methodName: 'serverTimestamp' } });
    expect(lote.delete).toHaveBeenCalledWith({ col: 'tienda_fotos_pedidas', id: 'p1' });
    expect(lote.commit).toHaveBeenCalledTimes(1);

    lote.commit.mockClear();
    globalThis.fetch = vi.fn(() => RESPUESTA(503));
    await escribirLote({}, [{ tipo: 'borrar', col: 'c', id: 'i' }]);
    expect(lote.commit).toHaveBeenCalledTimes(1);
  });

  it('sin sesión (sin token) va directo por el SDK', async () => {
    getIdToken.mockResolvedValueOnce(null);
    globalThis.fetch = vi.fn();
    await escribirLote({}, [{ tipo: 'borrar', col: 'c', id: 'i' }]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(lote.commit).toHaveBeenCalledTimes(1);
  });
});
