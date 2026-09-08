/**
 * Los descuentos de la tienda: el panel y el sync tienen que dar el MISMO
 * precio.
 *
 * `webapp/src/tienda_descuentos_regla.js` corre en el panel cada vez que se
 * espeja un producto (guardar la ficha, marcar un pedido entregado, cargar una
 * foto, publicar un rubro entero) y `scripts/sync_tienda.py` corre la suya cada
 * seis horas sobre el documento que dejó el panel. Si las dos cuentas no dan
 * exactamente lo mismo, el precio de la vidriera cambia solo: el panel pone uno
 * y el sync lo pisa con otro hasta la corrida siguiente.
 *
 * Esta prueba corre las dos implementaciones sobre los mismos casos
 * (`scripts/casos_espejo.py`) y compara campo por campo, igual que hace
 * espejo.test.js con el resto del espejo. Si el guión de Python no corre, la
 * comparación va a rojo: es lo único que cuida la regla escrita dos veces y
 * saltearla en silencio dejaba la suite en verde sin haber comparado nada.
 * Después van las mismas cuentas escritas a mano, que cuidan los números
 * aunque las dos implementaciones se equivoquen igual.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

import { correrGuionDePython, GUION_ESPEJO } from './casos_del_sync.js';
import {
  descuentosVigentes, descuentoPara, aplicarDescuento, recalcularEspejo,
  redondearCentena, claveDeObjetivo,
} from '../../webapp/src/tienda_descuentos_regla.js';

// La sesión y el SDK, espías: lo que se prueba es qué precio se escribe, no
// Firebase. Sin esto `tokenDeSesion()` levantaría la app de verdad.
vi.mock('../../webapp/src/auth.js', () => ({
  auth: { currentUser: { getIdToken: async () => 'TOKEN' } },
}));

const lote = { update: vi.fn(), set: vi.fn(), delete: vi.fn(), commit: vi.fn(async () => {}) };
// El aviso de stock escribe por el SDK y no por REST: sus espías van acá.
const sdk = { updateDoc: vi.fn(async () => {}), deleteDoc: vi.fn(async () => {}) };
vi.mock('firebase/firestore', () => ({
  doc: (_db, col, id) => ({ col, id }),
  getDoc: vi.fn(async () => ({ exists: () => false })),
  getDocFromCache: vi.fn(), collection: vi.fn(), query: vi.fn(), orderBy: vi.fn(),
  limit: vi.fn(), getDocs: vi.fn(async () => ({ docs: [] })),
  writeBatch: () => lote,
  updateDoc: (...a) => sdk.updateDoc(...a),
  deleteDoc: (...a) => sdk.deleteDoc(...a),
  serverTimestamp: () => ({ _methodName: 'serverTimestamp' }),
  deleteField: () => ({ _methodName: 'deleteField' }),
}));

let delSync = null;
let porQueNo = '';

beforeAll(() => {
  const { casos, porQueNo: motivo } = correrGuionDePython(GUION_ESPEJO, ['descuentos']);
  delSync = casos?.descuentos ?? null;
  porQueNo = motivo;
});

/**
 * Los casos del sync, o la prueba en rojo.
 *
 * Antes acá había un `if (!delSync) return;` y un console.warn. El warn no sale
 * en el reporter por defecto: el 08-09-2026 se probó poner `raise SystemExit`
 * arriba de casos_espejo.py y la suite dio "66 tests passed" sin comparar una
 * sola vez, con la mutación del redondeo de Python adentro. Un descuido que se
 * reporta como éxito es peor que no tener la prueba.
 */
const casosDelSync = () => {
  expect(delSync, 'no se pudo correr scripts/casos_espejo.py: la cuenta del panel '
                  + `quedó sin comparar contra la del sync.\n${porQueNo}`).not.toBeNull();
  return delSync;
};

describe('la cuenta del panel contra la del sync', () => {
  it('corre el sync para comparar', () => {
    expect(casosDelSync().length).toBeGreaterThan(0);
  });

  it('los mismos descuentos rigen, y en el mismo orden', () => {
    for (const caso of casosDelSync()) {
      const vigentes = descuentosVigentes(caso.descuentos, new Date(caso.ahora));
      expect(vigentes.map(d => d.id), caso.que_prueba).toEqual(caso.vigentes);
    }
  });

  it('y a cada producto le queda el mismo precio', () => {
    for (const caso of casosDelSync()) {
      const vigentes = descuentosVigentes(caso.descuentos, new Date(caso.ahora));
      for (const esperado of caso.resultado) {
        const entrada = caso.productos.find(p => p.doc_id === esperado.doc_id).doc;
        const obtenido = aplicarDescuento(esperado.doc_id, { ...entrada }, vigentes);
        expect(obtenido, `${caso.que_prueba} — ${esperado.doc_id}`)
          .toEqual(esperado.documento);

        // El sync corre siempre sobre lo que dejó escrito el panel: pasar el
        // documento por la regla otra vez tiene que dar lo mismo. Si la cuenta
        // partiera del precio ya rebajado, cada corrida descontaría de nuevo
        // sobre lo descontado y el precio se derrumbaría solo.
        const otraVez = aplicarDescuento(esperado.doc_id, { ...obtenido }, vigentes);
        expect(otraVez, `${caso.que_prueba} — ${esperado.doc_id}, segunda vuelta`)
          .toEqual(esperado.otra_vez);
        expect(otraVez).toEqual(obtenido);
      }
    }
  });
});

/* ── Las mismas cuentas, escritas a mano ─────────────────────────────────────
   Lo de arriba compara dos implementaciones: si las dos se equivocaran igual no
   diría nada. Acá van los números que tienen que salir. */

const AHORA = new Date('2026-09-08T12:00:00Z');
const uno = (datos, id = 'd1') => [{ id, datos }];
const rebajar = (docId, doc, docs, ahora = AHORA) =>
  aplicarDescuento(docId, { ...doc }, descuentosVigentes(docs, ahora));

describe('cuánto queda cada producto', () => {
  const cuaderno = { rubro: 'LIBRERÍA', sub_rubro: 'Cuadernos', precio: 6500,
                     precio_pack: 60000 };

  it('un porcentaje sobre el rubro, con el pack rebajado en la misma proporción', () => {
    // El pack tiene que seguir la rebaja: si no, llevarse la resma entera sale
    // más caro por hoja que comprar suelto y el cliente lo nota.
    const d = rebajar('p1', cuaderno, uno({ nombre: 'Semana del cuaderno', tipo: 'porcentaje',
                                            valor: 20, alcance: 'rubro', objetivo: 'LIBRERIA' }));
    expect(d).toMatchObject({
      precio: 5200, precio_anterior: 6500,
      precio_pack: 48000, precio_pack_anterior: 60000,
      descuento: { id: 'd1', nombre: 'Semana del cuaderno', porcentaje: 20 },
    });
  });

  it('un monto fijo', () => {
    const d = rebajar('p1', { rubro: 'LIBRERIA', precio: 2000 },
                      uno({ nombre: '$500 menos', tipo: 'monto', valor: 500,
                            alcance: 'rubro', objetivo: 'LIBRERIA' }));
    expect(d).toMatchObject({ precio: 1500, precio_anterior: 2000 });
    expect(d.descuento.porcentaje).toBe(25);
  });

  /*
   * Un monto de $500 sobre un rubro entero alcanza gomas de $400. Antes esas
   * quedaban a $1: un precio en un peso se lee como error, no como rebaja, y
   * deja pasar pedidos que después no se pueden cobrar. Ahora ese producto
   * queda a precio de lista y sin cinta, como si el descuento no existiera.
   */
  it('un monto que se come el precio deja el producto a precio de lista', () => {
    const monto = uno({ nombre: '$500 menos', tipo: 'monto', valor: 500,
                        alcance: 'rubro', objetivo: 'LIBRERIA' });
    for (const precio of [400, 500]) {
      const d = rebajar('p1', { rubro: 'LIBRERIA', precio }, monto);
      expect(d).toMatchObject({ precio, precio_anterior: null, descuento: null });
    }
  });

  it('redondea a la centena, salvo cuando eso empujaría el precio para arriba', () => {
    const d = uno({ nombre: 'Redondo', tipo: 'porcentaje', valor: 12, alcance: 'rubro',
                    objetivo: 'LIBRERIA', redondear: true });
    // 6.072 no es un precio de esta librería: va a 6.100.
    expect(rebajar('p1', { rubro: 'LIBRERIA', precio: 6900 }, d).precio).toBe(6100);
    // En un producto barato la centena anulaba el descuento entero: 79 se iba a
    // 100, que está ARRIBA del precio de lista. Ahí no se redondea.
    expect(rebajar('p2', { rubro: 'LIBRERIA', precio: 90 }, d).precio).toBe(79);
    expect(rebajar('p3', { rubro: 'LIBRERIA', precio: 40 }, d).precio).toBe(35);
  });

  it('el 12,5% cae del mismo lado que en Python', () => {
    // 1.004 menos 12,5% son 878,5 clavados. round() de Python redondea al par
    // (878) y Math.round() de JavaScript para arriba (879): por eso los dos
    // usan floor(x + 0,5), que es la única forma que escriben igual. Si no, el
    // precio se movía un peso solo en cada corrida, para siempre.
    expect(rebajar('p1', { rubro: 'LIBRERIA', precio: 1004 },
                   uno({ nombre: 'Doce y medio', tipo: 'porcentaje', valor: 12.5,
                         alcance: 'rubro', objetivo: 'LIBRERIA' })).precio).toBe(879);
  });

  it('más del 90% no es un descuento, es un error de tipeo', () => {
    expect(rebajar('p1', { rubro: 'LIBRERIA', precio: 1000 },
                   uno({ nombre: 'Liquidación', tipo: 'porcentaje', valor: 95,
                         alcance: 'rubro', objetivo: 'LIBRERIA' })).precio).toBe(100);
  });

  /*
   * La cartulina tiene precio propio por color y el que elige el color paga
   * ESE precio: la tienda lo prefiere sobre el del producto y el servidor hace
   * lo mismo al armar el pedido. Dejarlo a precio de lista mostraba "−20%" y
   * "antes $600" en la card, y al tocar Celeste el precio SUBÍA a $1.874,
   * que era además lo que terminaba cobrando el pedido.
   */
  it('el precio propio de cada color lleva la misma rebaja', () => {
    const cartulina = {
      rubro: 'LIBRERIA', sub_rubro: 'Papeles', precio: 600, precio_pack: 5600,
      variedades: [
        { nombre: 'Celeste', stock: 12, precio: 1874, imagen: null },
        { nombre: 'Rosa Viejo', stock: 5, precio: null, imagen: null },
      ],
    };
    const d = rebajar('p1', cartulina, uno({ nombre: 'Semana del papel', tipo: 'porcentaje',
                                             valor: 20, alcance: 'rubro', objetivo: 'LIBRERIA' }));
    expect(d.precio).toBe(480);
    expect(d.variedades).toEqual([
      // 1.874 × 480 / 600: el mismo 20% que anuncia la cinta de la card.
      { nombre: 'Celeste', stock: 12, precio: 1499, precio_anterior: 1874, imagen: null },
      // Sin precio propio paga el del producto: no hay nada que rebajar.
      { nombre: 'Rosa Viejo', stock: 5, precio: null, imagen: null },
    ]);
  });

  it('apagado el descuento, cada color vuelve a su precio de lista', () => {
    const rebajado = { rubro: 'LIBRERIA', precio: 480, precio_anterior: 600,
                       variedades: [{ nombre: 'Celeste', stock: 12, precio: 1499,
                                      precio_anterior: 1874, imagen: null }] };
    expect(aplicarDescuento('p1', { ...rebajado }, []).variedades)
      .toEqual([{ nombre: 'Celeste', stock: 12, precio: 1874, imagen: null }]);
  });

  it('sin descuentos vuelve al precio de lista, pack incluido', () => {
    const rebajado = { rubro: 'LIBRERIA', precio: 800, precio_anterior: 1000,
                       precio_pack: 8000, precio_pack_anterior: 10000,
                       descuento: { id: 'viejo', nombre: 'Vieja oferta', porcentaje: 20 } };
    expect(aplicarDescuento('p1', { ...rebajado }, [])).toMatchObject({
      precio: 1000, precio_anterior: null,
      precio_pack: 10000, precio_pack_anterior: null, descuento: null,
    });
  });
});

describe('a quién le toca cada descuento', () => {
  /*
   * El objetivo se guarda desde el catálogo crudo ("LIBRERÍA|BOLIGRAFO") y el
   * espejo publica el subrubro bonito ("Bolígrafo"). Comparados tal cual no
   * coincidían nunca: un descuento de subrubro no le tocaba el precio a nadie
   * y en el panel se veía activo igual.
   */
  it('el subrubro pega aunque de un lado lleve tilde y del otro no', () => {
    const d = uno({ nombre: 'Bolígrafos', tipo: 'porcentaje', valor: 15,
                    alcance: 'subrubro', objetivo: 'LIBRERÍA|BOLIGRAFO' });
    expect(rebajar('p1', { rubro: 'LIBRERIA', sub_rubro: 'Bolígrafo', precio: 1200 }, d).precio)
      .toBe(1020);
    expect(rebajar('p2', { rubro: 'LIBRERIA', sub_rubro: 'Cuadernos', precio: 1200 }, d).descuento)
      .toBe(null);
  });

  /*
   * Hay códigos con minúsculas en el catálogo (Craft1, Eco1) y el panel guarda
   * el objetivo en mayúsculas: comparados tal cual, el descuento de un artículo
   * no encontraba a su artículo.
   */
  it('el código del artículo se compara sin importar cómo esté escrito', () => {
    const d = uno({ nombre: 'Craft', tipo: 'porcentaje', valor: 30,
                    alcance: 'producto', objetivo: 'CRAFT1' });
    expect(rebajar('Craft1', { rubro: 'LIBRERIA', precio: 1000 }, d).precio).toBe(700);
  });

  it('manda el más puntual: rubro, después subrubro, después artículo', () => {
    const docs = [
      { id: 'z-producto', datos: { nombre: 'Craft', valor: 30, alcance: 'producto',
                                   objetivo: 'CRAFT1' } },
      { id: 'a-rubro', datos: { nombre: 'Librería', valor: 10, alcance: 'rubro',
                                objetivo: 'LIBRERIA' } },
      { id: 'm-subrubro', datos: { nombre: 'Cuadernos', valor: 20, alcance: 'subrubro',
                                   objetivo: 'LIBRERIA|CUADERNOS' } },
    ];
    const vigentes = descuentosVigentes(docs, AHORA);
    // Del más general al más puntual, sin importar en qué orden los devuelva
    // Firestore: el panel y el sync tienen que elegir el mismo.
    expect(vigentes.map(d => d.id)).toEqual(['a-rubro', 'm-subrubro', 'z-producto']);

    const cual = (id, doc) => descuentoPara(id, doc, vigentes)?.id ?? null;
    expect(cual('p1', { rubro: 'LIBRERIA', sub_rubro: 'Lapices' })).toBe('a-rubro');
    expect(cual('p2', { rubro: 'LIBRERIA', sub_rubro: 'Cuadernos' })).toBe('m-subrubro');
    expect(cual('Craft1', { rubro: 'LIBRERIA', sub_rubro: 'Cuadernos' })).toBe('z-producto');
    expect(cual('p3', { rubro: 'MERCERIA', sub_rubro: 'Cintas' })).toBe(null);
  });

  it('empatados en alcance decide el id, para que los dos elijan el mismo', () => {
    const docs = [
      { id: 'zz', datos: { nombre: 'El último', valor: 30, alcance: 'rubro', objetivo: 'LIBRERIA' } },
      { id: 'aa', datos: { nombre: 'El primero', valor: 10, alcance: 'rubro', objetivo: 'LIBRERIA' } },
    ];
    expect(rebajar('p1', { rubro: 'LIBRERIA', precio: 1000 }, docs).descuento.id).toBe('zz');
  });

  it('apagado, vencido, futuro o en cero no rigen', () => {
    const docs = [
      { id: 'apagado', datos: { valor: 50, activo: false, alcance: 'rubro', objetivo: 'LIBRERIA' } },
      { id: 'vencido', datos: { valor: 50, alcance: 'rubro', objetivo: 'LIBRERIA',
                                hasta: '2026-09-01T00:00:00Z' } },
      { id: 'futuro', datos: { valor: 50, alcance: 'rubro', objetivo: 'LIBRERIA',
                               desde: '2026-12-01T00:00:00Z' } },
      { id: 'sin valor', datos: { valor: 0, alcance: 'rubro', objetivo: 'LIBRERIA' } },
      { id: 'vigente', datos: { nombre: 'Mercería', valor: 10, alcance: 'rubro',
                                objetivo: 'MERCERIA', desde: '2026-09-01T00:00:00Z',
                                hasta: '2026-09-30T00:00:00Z' } },
    ];
    expect(descuentosVigentes(docs, AHORA).map(d => d.id)).toEqual(['vigente']);
    // Las fechas también llegan como Date: el SDK las devuelve así y la REST en
    // texto. Tienen que valer lo mismo.
    const conFechas = [{ id: 'vigente', datos: { valor: 10, alcance: 'rubro',
                                                 objetivo: 'MERCERIA',
                                                 desde: new Date('2026-09-01T00:00:00Z') } }];
    expect(descuentosVigentes(conFechas, AHORA)).toHaveLength(1);
  });

  it('un objetivo vacío no le pega a todo el catálogo', () => {
    const d = uno({ nombre: 'Sin objetivo', valor: 20, alcance: 'rubro', objetivo: '  ' });
    expect(descuentosVigentes(d, AHORA)).toHaveLength(1);
    expect(rebajar('p1', { rubro: 'LIBRERIA', precio: 1000 }, d).descuento).toBe(null);
  });

  it('la clave con la que se compara ignora tildes, mayúsculas y espacios', () => {
    expect(claveDeObjetivo('  LIBRERÍA   Y  Papelería ')).toBe('libreria y papeleria');
    expect(claveDeObjetivo(null)).toBe('');
  });

  it('la centena cae a decena cuando el monto es chico', () => {
    expect(redondearCentena(6072)).toBe(6100);
    expect(redondearCentena(35.2)).toBe(40);
    expect(redondearCentena(4)).toBe(4);
    expect(redondearCentena(0)).toBe(0);
  });
});

/* ── Rehacer el espejo desde el panel ───────────────────────────────────────
   Esto no tiene gemelo en Python: el sync arma cada documento de cero desde el
   catálogo y el panel trabaja sobre lo que YA está publicado. */
describe('recalcular el espejo al tocar un descuento', () => {
  const veinte = descuentosVigentes(
    uno({ nombre: 'Semana del cuaderno', tipo: 'porcentaje', valor: 20,
          alcance: 'rubro', objetivo: 'LIBRERIA' }), AHORA);

  it('devuelve solo los que cambian, y de cada uno solo lo que cambia', () => {
    // Un rubro son cientos de productos y al tocar un descuento de otro
    // subrubro la mayoría no se mueve: escribirlos todos es pagar cientos de
    // escrituras para dejar el mismo número.
    const cambios = recalcularEspejo([
      { id: 'p1', datos: { rubro: 'LIBRERIA', precio: 6500, precio_pack: 60000,
                           precio_pack_anterior: null } },
      { id: 'p2', datos: { rubro: 'MERCERIA', precio: 6500 } },
    ], veinte);

    expect(cambios).toEqual([{ id: 'p1', datos: {
      precio: 5200, precio_anterior: 6500, precio_pack: 48000, precio_pack_anterior: 60000,
      descuento: { id: 'd1', nombre: 'Semana del cuaderno', porcentaje: 20 },
    } }]);
  });

  const yaRebajado = () => ({ rubro: 'LIBRERIA', precio: 5200, precio_anterior: 6500,
                              precio_pack: 48000, precio_pack_anterior: 60000,
                              descuento: { id: 'd1', nombre: 'Semana del cuaderno',
                                           porcentaje: 20 } });

  it('el que ya está con el precio puesto no se vuelve a escribir', () => {
    expect(recalcularEspejo([{ id: 'p1', datos: yaRebajado() }], veinte)).toEqual([]);
  });

  it('apagar el descuento devuelve el precio de lista', () => {
    expect(recalcularEspejo([{ id: 'p1', datos: yaRebajado() }], [])).toEqual([{ id: 'p1', datos: {
      precio: 6500, precio_anterior: null, precio_pack: 60000, precio_pack_anterior: null,
      descuento: null,
    } }]);
  });

  it('el color con precio propio entra en lo que hay que escribir', () => {
    const [cambio] = recalcularEspejo([{ id: 'p1', datos: {
      rubro: 'LIBRERIA', precio: 6500,
      variedades: [{ nombre: 'Celeste', stock: 12, precio: 1000, imagen: null }],
    } }], veinte);
    expect(cambio.datos.variedades).toEqual([
      { nombre: 'Celeste', stock: 12, precio: 800, precio_anterior: 1000, imagen: null },
    ]);
  });

  it('el que ya tiene los colores rebajados no se vuelve a escribir', () => {
    const conColores = { ...yaRebajado(),
      variedades: [{ nombre: 'Celeste', stock: 12, precio: 800, precio_anterior: 1000,
                     imagen: null }] };
    expect(recalcularEspejo([{ id: 'p1', datos: conColores }], veinte)).toEqual([]);
  });

  it('en un espejo viejo, sin el pack de lista, deshace la proporción', () => {
    // Los documentos escritos antes de que existiera `precio_pack_anterior`
    // tienen el pack ya rebajado y no guardaron el de lista. Sin deshacer la
    // cuenta, cambiar el descuento rebajaba de nuevo sobre lo rebajado.
    const { precio_pack_anterior: _, ...viejo } = yaRebajado();
    const [cambio] = recalcularEspejo([{ id: 'p1', datos: viejo }], []);
    expect(cambio.datos).toMatchObject({ precio: 6500, precio_pack: 60000 });
  });
});

/* ── El espejo escrito de verdad ─────────────────────────────────────────────
 * Hasta el 2026-09-08 cualquier re-espejado pisaba la rebaja: el documento se
 * arma de cero desde el catálogo, con el precio de lista, y se escribe entero.
 * Guardar la ficha, marcar un pedido entregado, cambiar una foto o publicar un
 * rubro dejaba al producto a precio de lista hasta la corrida siguiente del
 * sync, con la cinta "−20%" ya anunciada en la vidriera.
 */
describe('espejar un producto con un descuento vigente', () => {
  const RESPUESTA = (status, cuerpo = {}) => Promise.resolve({
    ok: status >= 200 && status < 300, status, json: () => Promise.resolve(cuerpo),
  });
  const BASE = 'projects/mari-d7c71/databases/(default)/documents';
  const original = globalThis.fetch;

  // Una cartulina de las de verdad: se vende por unidad y también el pack de 10.
  const CARTULINA = {
    estado: 'activo', nombre: 'CARTULINA LUMA', rubro: 'LIBRERÍA', sub_rubro: 'PAPELES',
    precio_venta: 5600, conjunto_precio_unidad: 600, tienda_imagenes: ['https://x/foto.webp'],
    es_conjunto: true, conjunto_tipo: 'pack', conjunto_contenido: 10,
    conjunto_colores: [{ color: 'CELESTE', unidades: 1, restante: 2 }],
  };

  const DESCUENTO = {
    nombre: { stringValue: 'Semana del cuaderno' }, tipo: { stringValue: 'porcentaje' },
    valor: { integerValue: '20' }, alcance: { stringValue: 'rubro' },
    objetivo: { stringValue: 'LIBRERIA' },
  };

  /** El fetch de mentira: el producto no está en el espejo y hay un descuento. */
  function conRed() {
    const commits = [];
    globalThis.fetch = vi.fn((url, opciones) => {
      const u = String(url);
      const cuerpo = opciones?.body ? JSON.parse(opciones.body) : {};
      if (u.endsWith(':runQuery')) {
        return cuerpo.structuredQuery.from[0].collectionId === 'tienda_descuentos'
          ? RESPUESTA(200, [{ document: { name: `${BASE}/tienda_descuentos/d1`,
                                          fields: DESCUENTO } }])
          : RESPUESTA(200, []);
      }
      if (u.endsWith(':batchGet')) {
        return RESPUESTA(200, [{ missing: `${BASE}/tienda_productos/A` }]);
      }
      if (u.endsWith(':commit')) { commits.push(...cuerpo.writes); return RESPUESTA(200); }
      return RESPUESTA(404, {});
    });
    return commits;
  }

  let espejar;
  let espejarLote;
  let avisarStockALaTienda;
  let decodificarCampos;
  let olvidarDescuentosVigentes;

  beforeEach(async () => {
    ({ espejar, espejarLote, avisarStockALaTienda, decodificarCampos,
       olvidarDescuentosVigentes } = await import('../../webapp/src/tienda_espejo.js'));
    sdk.updateDoc.mockClear();
    sdk.deleteDoc.mockClear();
    // Los descuentos se recuerdan un minuto: cada prueba tiene que leer los
    // suyos.
    olvidarDescuentosVigentes();
  });

  afterEach(() => { globalThis.fetch = original; });

  it('escribe el precio rebajado, el tachado y la cinta', async () => {
    const commits = conRed();

    const r = await espejar({}, 'A', CARTULINA, ['LIBRERÍA'], {});
    expect(r).toEqual({ publicado: true, motivo: null });

    const escrito = decodificarCampos(commits[0].update.fields);
    expect(escrito).toMatchObject({
      precio: 480, precio_anterior: 600,
      precio_pack: 4480, precio_pack_anterior: 5600,
      descuento: { id: 'd1', nombre: 'Semana del cuaderno', porcentaje: 20 },
    });
  });

  it('re-espejarlo no lo devuelve a precio de lista ni descuenta de nuevo', async () => {
    // Es lo que pasa todo el día: se guarda la ficha, se marca un pedido
    // entregado, se cambia una foto. El precio tiene que quedar donde estaba.
    const commits = conRed();

    await espejar({}, 'A', CARTULINA, ['LIBRERÍA'], {});
    await espejar({}, 'A', CARTULINA, ['LIBRERÍA'], {});

    expect(commits).toHaveLength(2);
    expect(decodificarCampos(commits[1].update.fields))
      .toEqual(decodificarCampos(commits[0].update.fields));
  });

  it('sin descuentos que apliquen sale a precio de lista y sin cinta', async () => {
    const commits = conRed();

    await espejar({}, 'A', { ...CARTULINA, rubro: 'MERCERÍA' }, ['MERCERÍA'], {});

    expect(decodificarCampos(commits[0].update.fields)).toMatchObject({
      precio: 600, precio_anterior: null, precio_pack: 5600,
      precio_pack_anterior: null, descuento: null,
    });
  });

  /*
   * El color con precio propio es el caso caro: la tienda le cobra al cliente
   * el precio de la variedad y no el del producto, así que un color a precio de
   * lista arriba de la cinta "−20%" es un producto anunciado en oferta que se
   * cobra entero. Pasa en las cartulinas, que tienen un precio por color.
   */
  it('el color con precio propio sale rebajado igual que el producto', async () => {
    const commits = conRed();

    await espejar({}, 'A', { ...CARTULINA,
      conjunto_colores: [{ color: 'CELESTE', unidades: 1, restante: 2, precio: 1874 }],
    }, ['LIBRERÍA'], {});

    expect(decodificarCampos(commits[0].update.fields)).toMatchObject({
      precio: 480, precio_anterior: 600,
      variedades: [{ nombre: 'Celeste', stock: 12, precio: 1499, precio_anterior: 1874 }],
    });
  });

  /*
   * El aviso de stock escribe stock y variedades y nada más. Mandaba las del
   * catálogo, a precio de lista: un conteo o una reposición devolvía el color a
   * $1.874 con la cinta "−20%" puesta, hasta la corrida siguiente del sync.
   */
  it('un conteo de stock no devuelve el color al precio de lista', async () => {
    conRed();

    await avisarStockALaTienda({}, 'A', 12, { ...CARTULINA,
      conjunto_colores: [{ color: 'CELESTE', unidades: 1, restante: 2, precio: 1874 }],
    });

    expect(sdk.updateDoc).toHaveBeenCalledWith({ col: 'tienda_productos', id: 'A' }, {
      stock: 12,
      variedades: [{ nombre: 'Celeste', stock: 12, precio: 1499, precio_anterior: 1874,
                     imagen: null }],
    });
  });

  it('publicar un rubro entero tampoco pisa la rebaja', async () => {
    // El lote de Configuración de la Tienda pasa por otro camino que el
    // guardado de a uno, y también reescribe el documento completo.
    const commits = conRed();

    const r = await espejarLote({}, [{ id: 'A', datos: CARTULINA }], ['LIBRERÍA'], null, {});
    expect(r).toEqual({ publicados: 1, sacados: 0 });

    expect(decodificarCampos(commits[0].update.fields)).toMatchObject({
      precio: 480, precio_anterior: 600,
      descuento: { id: 'd1', nombre: 'Semana del cuaderno', porcentaje: 20 },
    });
  });
});
