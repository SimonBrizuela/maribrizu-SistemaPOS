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
  espejar, espejarLote, destacadoQueQueda, olvidarDescuentosVigentes,
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

  /*
   * El fallback por SDK tiene que borrar lo mismo que borra la REST. La
   * `updateMask` reemplaza el campo entero; `{ merge: true }` hace merge
   * PROFUNDO y deja viva la clave vieja de un mapa. Borrando un aviso de rubro
   * con la REST caída, por una puerta el aviso se iba y por la otra seguía ahí.
   */
  it('crearSiFalta por el SDK pisa el mapa entero, igual que la máscara de la REST', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('sin red')));
    const avisos = { rubros: { LIBRERIA: 'Se corta a pedido' }, subrubros: {} };
    await escribirLote({}, [{ tipo: 'actualizar', col: 'tienda_config', id: 'avisos',
                              datos: avisos, crearSiFalta: true }]);
    expect(lote.set).toHaveBeenCalledWith({ col: 'tienda_config', id: 'avisos' }, avisos,
      { mergeFields: ['rubros', 'subrubros'] });
    // Los mismos campos que viajan en la máscara de la REST.
    const [w] = armarEscrituras([{ tipo: 'actualizar', col: 'tienda_config', id: 'avisos',
                                   datos: avisos, crearSiFalta: true }]);
    expect(w.updateMask.fieldPaths).toEqual(['rubros', 'subrubros']);
  });

  it('sin sesión (sin token) va directo por el SDK', async () => {
    getIdToken.mockResolvedValueOnce(null);
    globalThis.fetch = vi.fn();
    await escribirLote({}, [{ tipo: 'borrar', col: 'c', id: 'i' }]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(lote.commit).toHaveBeenCalledTimes(1);
  });
});

/*
 * Publicar o sacar un rubro entero desde Configuración de la Tienda.
 *
 * Hasta el 2026-09-08 el lote le ponía `orden` nuevo y `orden_rubro` 999999 a
 * TODOS los publicables, aunque ya estuvieran en la tienda con su lugar hecho.
 * Destildar un subrubro de Librería reescribía los ~2.000 productos del rubro:
 * la vidriera perdía el orden por destacado / stock / ventas y salía por id
 * hasta la próxima corrida del sync, y los grupos de tamaños dejaban de ser
 * contiguos, así que una card se partía entre dos páginas.
 */
describe('publicar un rubro entero conservando la vidriera', () => {
  const RESPUESTA = (status, cuerpo = {}) => Promise.resolve({
    ok: status >= 200 && status < 300, status, json: () => Promise.resolve(cuerpo),
  });
  const original = globalThis.fetch;
  const BASE_DOC = `${BASE}/tienda_productos`;

  const producto = (extra = {}) => ({
    nombre: 'CUADERNO', estado: 'activo', precio_venta: 100, stock: 5,
    rubro: 'LIBRERIA', sub_rubro: 'CUADERNOS',
    tienda_imagenes: ['https://x/foto.webp'], ...extra,
  });

  /** El fetch de mentira: el espejo tiene A con lugar propio y B no está. */
  function conRed({ batchGet = null } = {}) {
    const commits = [];
    globalThis.fetch = vi.fn((url, opciones) => {
      const u = String(url);
      const cuerpo = opciones?.body ? JSON.parse(opciones.body) : {};
      if (u.endsWith(':batchGet')) {
        return batchGet ?? RESPUESTA(200, [
          { found: { name: `${BASE_DOC}/A`,
                     fields: { orden: { integerValue: '12' }, orden_rubro: { integerValue: '3' } } } },
          { missing: `${BASE_DOC}/B` },
        ]);
      }
      if (u.endsWith(':runQuery')) {
        // El último `orden` de la tienda; los descuentos, ninguno.
        return cuerpo.structuredQuery.from[0].collectionId === 'tienda_productos'
          ? RESPUESTA(200, [{ document: { name: `${BASE_DOC}/Z`,
                                          fields: { orden: { integerValue: '40' } } } }])
          : RESPUESTA(200, []);
      }
      if (u.endsWith(':commit')) { commits.push(...cuerpo.writes); return RESPUESTA(200); }
      return RESPUESTA(404, {});
    });
    return commits;
  }

  const escrituraDe = (writes, id) =>
    writes.find(w => (w.update?.name || w.delete) === `${BASE_DOC}/${id}`);

  beforeEach(() => { olvidarDescuentosVigentes(); });
  afterEach(() => { globalThis.fetch = original; });

  it('el que ya estaba conserva su lugar; solo se numera el que entra nuevo', async () => {
    const writes = conRed();

    const r = await espejarLote({}, [
      { id: 'A', datos: producto() },
      { id: 'B', datos: producto() },
      { id: 'C', datos: producto({ tienda_publicar: false }) },
    ], ['LIBRERIA'], null, {});

    expect(r).toEqual({ publicados: 2, sacados: 1 });

    const a = escrituraDe(writes, 'A').update.fields;
    expect(a.orden).toEqual({ integerValue: '12' });
    expect(a.orden_rubro).toEqual({ integerValue: '3' });

    // El nuevo va al final (el último orden era 40) y sin lugar en su rubro
    // hasta que el sync lo ubique.
    const b = escrituraDe(writes, 'B').update.fields;
    expect(b.orden).toEqual({ integerValue: '41' });
    expect(b.orden_rubro).toEqual({ integerValue: '999999' });

    expect(escrituraDe(writes, 'C')).toEqual({ delete: `${BASE_DOC}/C` });

    // Se piden los dos que se quedan, no el que se saca.
    const pedido = globalThis.fetch.mock.calls.find(([u]) => String(u).endsWith(':batchGet'));
    expect(JSON.parse(pedido[1].body)).toEqual({
      documents: [`${BASE_DOC}/A`, `${BASE_DOC}/B`],
      mask: { fieldPaths: ['orden', 'orden_rubro', 'destacado'] },
    });
  });

  it('si no se puede leer el orden de hoy, se numera al final como antes', async () => {
    const writes = conRed({ batchGet: Promise.reject(new Error('sin red')) });

    await espejarLote({}, [{ id: 'A', datos: producto() }], ['LIBRERIA'], null, {});

    const a = escrituraDe(writes, 'A').update.fields;
    expect(a.orden).toEqual({ integerValue: '41' });
    expect(a.orden_rubro).toEqual({ integerValue: '999999' });
  });
});

/*
 * Los destacados de la portada.
 *
 * Cuando nadie marcó ninguno a mano, el sync elige los doce más vendidos y les
 * escribe `destacado` en el espejo SIN tocar el catálogo. El panel arma el
 * documento desde el catálogo y lo escribe entero, así que hasta el 2026-09-08
 * cargarle una foto a uno de esos doce (o entregar un pedido, o guardar la
 * ficha) lo escribía con `destacado: false`: la tira "Destacados" de la portada
 * pasaba de doce a once hasta la corrida siguiente, hasta seis horas después.
 */
describe('el destacado que eligió el sync no se cae de la portada', () => {
  const RESPUESTA = (status, cuerpo = {}) => Promise.resolve({
    ok: status >= 200 && status < 300, status, json: () => Promise.resolve(cuerpo),
  });
  const original = globalThis.fetch;
  const BASE_DOC = `${BASE}/tienda_productos`;

  const producto = (extra = {}) => ({
    nombre: 'CUADERNO', estado: 'activo', precio_venta: 100, stock: 5,
    rubro: 'LIBRERIA', sub_rubro: 'CUADERNOS',
    tienda_imagenes: ['https://x/foto.webp'], ...extra,
  });

  /**
   * El fetch de mentira. `enElEspejo` es lo que hoy tiene publicado el producto
   * A (null = todavía no está en la tienda); B nunca está.
   */
  function conRed(enElEspejo) {
    const commits = [];
    globalThis.fetch = vi.fn((url, opciones) => {
      const u = String(url);
      const cuerpo = opciones?.body ? JSON.parse(opciones.body) : {};
      if (u.endsWith(':commit')) { commits.push(...cuerpo.writes); return RESPUESTA(200); }
      if (u.endsWith(':batchGet')) {
        return RESPUESTA(200, [
          enElEspejo ? { found: { name: `${BASE_DOC}/A`, fields: enElEspejo } }
                     : { missing: `${BASE_DOC}/A` },
          { missing: `${BASE_DOC}/B` },
        ]);
      }
      if (u.endsWith(':runQuery')) {
        // El último `orden` de la tienda; descuentos vigentes, ninguno.
        return cuerpo.structuredQuery.from[0].collectionId === 'tienda_productos'
          ? RESPUESTA(200, [{ document: { name: `${BASE_DOC}/Z`,
                                          fields: { orden: { integerValue: '40' } } } }])
          : RESPUESTA(200, []);
      }
      // La lectura del documento del espejo, de a uno (GET con máscara).
      if (u.includes('/tienda_productos/A')) {
        return enElEspejo ? RESPUESTA(200, { fields: enElEspejo }) : RESPUESTA(404, {});
      }
      return RESPUESTA(404, {});
    });
    return commits;
  }

  const ELEGIDO_POR_EL_SYNC = {
    orden: { integerValue: '12' }, orden_rubro: { integerValue: '3' },
    destacado: { booleanValue: true },
  };

  const escrituraDe = (writes, id) =>
    writes.find(w => (w.update?.name || w.delete) === `${BASE_DOC}/${id}`);

  beforeEach(() => { olvidarDescuentosVigentes(); });
  afterEach(() => { globalThis.fetch = original; });

  it('la regla: a mano manda, y sin decidir nada se conserva lo del espejo', () => {
    expect(destacadoQueQueda({ tienda_destacado: true }, null)).toBe(true);
    expect(destacadoQueQueda({ tienda_destacado: false }, { destacado: true })).toBe(false);
    expect(destacadoQueQueda({}, { destacado: true })).toBe(true);
    expect(destacadoQueQueda({}, { destacado: false })).toBe(false);
    // Todavía no está en la tienda: no hay nada que conservar.
    expect(destacadoQueQueda({}, null)).toBe(false);
  });

  it('guardar la ficha o cargar una foto no lo baja de los destacados', async () => {
    const commits = conRed(ELEGIDO_POR_EL_SYNC);

    await espejar({}, 'A', producto(), ['LIBRERIA'], {});

    const escrito = decodificarCampos(commits[0].update.fields);
    expect(escrito.destacado).toBe(true);
    expect(escrito.orden).toBe(12);
  });

  it('destildarlo en el panel lo saca ya, sin esperar al sync', async () => {
    const commits = conRed(ELEGIDO_POR_EL_SYNC);

    await espejar({}, 'A', producto({ tienda_destacado: false }), ['LIBRERIA'], {});

    expect(decodificarCampos(commits[0].update.fields).destacado).toBe(false);
  });

  it('el que recién entra a la tienda no sale destacado de la nada', async () => {
    const commits = conRed(null);

    await espejar({}, 'A', producto(), ['LIBRERIA'], {});

    expect(decodificarCampos(commits[0].update.fields).destacado).toBe(false);
  });

  it('publicar un rubro entero tampoco los baja', async () => {
    const writes = conRed(ELEGIDO_POR_EL_SYNC);

    await espejarLote({}, [
      { id: 'A', datos: producto() },
      { id: 'B', datos: producto() },
    ], ['LIBRERIA'], null, {});

    expect(escrituraDe(writes, 'A').update.fields.destacado).toEqual({ booleanValue: true });
    expect(escrituraDe(writes, 'B').update.fields.destacado).toEqual({ booleanValue: false });
  });
});
