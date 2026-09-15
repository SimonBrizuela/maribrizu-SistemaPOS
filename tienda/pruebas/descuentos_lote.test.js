// @vitest-environment jsdom
/**
 * Apagar y borrar un descuento de la tienda.
 *
 * Son los dos caminos del panel que escriben cientos de documentos del espejo
 * de una sola vez. Apagar el descuento de un rubro tiene que devolverle el
 * precio de lista a todo lo que estaba rebajado —el precio, el del pack y el
 * de cada color— y borrarlo tiene que hacer exactamente lo mismo antes de
 * sacar el descuento de la base. Lo que quede a medias no se nota en el panel:
 * se nota en la vidriera, con precios que nadie puede explicar hasta la
 * corrida siguiente del sync, seis horas después.
 *
 * Lo que se mueve acá es la pantalla de verdad
 * (`webapp/src/pages/tienda_descuentos.js`), a botonazos. Lo único que se
 * reemplaza son las lecturas y las escrituras: la regla que decide qué número
 * queda en cada producto (`webapp/src/tienda_descuentos_regla.js`) es la de
 * producción, la misma que corre el sync.
 */
import { describe, it, expect, vi } from 'vitest';

/* ── El espejo y la base, en memoria ──────────────────────────────────────── */

const nube = vi.hoisted(() => ({
  catalogo: [],
  descuentos: [],
  // id del producto -> documento de `tienda_productos`
  espejo: new Map(),
  // Todo lo que la pantalla escribe, en orden: los lotes al espejo, los
  // cambios sueltos y los borrados. El orden importa (los precios se rehacen
  // ANTES de borrar el descuento), así que se guarda una sola lista.
  operaciones: [],
  confirmaciones: [],
  avisos: [],
  respuestaConfirmar: true,
  falla: { lote: false },
  olvidos: 0,
}));

function clonar(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * Lo mismo que hace la máscara de la REST: viajan solo los campos pedidos, y
 * el que no está en el documento no llega. Sin esto la prueba le daría al
 * panel un `precio_pack_anterior: undefined` que en producción no existe, que
 * es justo el caso del espejo viejo.
 */
function soloCampos(datos, campos) {
  if (!campos?.length) return clonar(datos);
  const salida = {};
  for (const campo of campos) if (campo in datos) salida[campo] = clonar(datos[campo]);
  return salida;
}

function aplicarEnElEspejo(escrituras) {
  for (const e of escrituras || []) {
    if (e.col !== 'tienda_productos') continue;
    nube.espejo.set(e.id, { ...(nube.espejo.get(e.id) || {}), ...clonar(e.datos) });
  }
}

/** Lo que dice el botón de Apagar cuando se manda un lote: es lo que se ve. */
function textoDelBoton() {
  return document.querySelector('[data-accion="alternar"]')?.textContent.trim() || '';
}

vi.mock('../../webapp/src/tienda_espejo.js', async (original) => {
  const real = await original();
  return {
    ...real,
    leerDocEspejoRest: async (id, campos = null) => (nube.espejo.has(id)
      ? { existe: true, datos: soloCampos(nube.espejo.get(id), campos) }
      : { existe: false, datos: null }),
    consultarEspejoRest: async ({ donde = null, campos = null } = {}) => (
      [...nube.espejo.entries()]
        .filter(([, datos]) => Object.entries(donde || {})
          .every(([campo, valor]) => datos[campo] === valor))
        .map(([id, datos]) => ({ id, datos: soloCampos(datos, campos) }))),
    escribirLote: async (_db, escrituras) => {
      if (nube.falla.lote) throw new Error('403 al escribir el espejo');
      nube.operaciones.push({
        op: 'lote', escrituras: clonar(escrituras), enPantalla: textoDelBoton(),
      });
      aplicarEnElEspejo(escrituras);
    },
    actualizarDoc: async (_db, col, id, cambios) => {
      nube.operaciones.push({ op: 'actualizar', col, id, datos: clonar(cambios) });
      if (col === 'tienda_descuentos') {
        const d = nube.descuentos.find(x => x.__id === id);
        if (d) Object.assign(d, cambios);
      }
    },
    borrarDoc: async (_db, col, id) => {
      nube.operaciones.push({ op: 'borrar', col, id });
      if (col === 'tienda_descuentos') {
        nube.descuentos = nube.descuentos.filter(x => x.__id !== id);
      }
    },
    olvidarDescuentosVigentes: () => { nube.olvidos += 1; },
  };
});

vi.mock('../../webapp/src/cache.js', () => {
  // Siempre trae de nuevo, pero se acuerda de lo último: la pantalla guarda el
  // catálogo al entrar y lo vuelve a mirar al abrir el editor y al aplicar, y
  // una venta del POS lo reemplaza con `setCacheValue`, como el store.
  const memoria = new Map();
  return {
    getCached: async (clave, traer) => {
      const valor = await traer();
      memoria.set(clave, valor);
      return valor;
    },
    peekCacheValue: (clave) => memoria.get(clave),
    setCacheValue: (clave, valor) => { memoria.set(clave, valor); },
    invalidateCacheByPrefix: () => {},
    invalidateCache: () => {},
  };
});

vi.mock('../../webapp/src/components/dialogs.js', async (original) => {
  const real = await original();
  return {
    ...real,
    confirmDialog: async (opciones) => {
      nube.confirmaciones.push(opciones);
      return nube.respuestaConfirmar;
    },
    alertDialog: async (opciones) => { nube.avisos.push(opciones); },
  };
});

vi.mock('firebase/firestore', () => {
  const filasDe = (nombre) => {
    if (nombre === 'catalogo') return nube.catalogo.map(p => ({ id: p.doc_id, datos: p }));
    if (nombre === 'tienda_descuentos') return nube.descuentos.map(d => ({ id: d.__id, datos: d }));
    if (nombre === 'tienda_productos') {
      return [...nube.espejo.entries()].map(([id, datos]) => ({ id, datos }));
    }
    return [];
  };
  const instantanea = (nombre) => {
    const filas = filasDe(nombre);
    return {
      docs: filas.map(f => ({
        id: f.id, ref: { id: f.id }, data: () => f.datos, exists: () => true,
      })),
      empty: filas.length === 0,
      size: filas.length,
      forEach(fn) { this.docs.forEach(fn); },
    };
  };
  return {
    collection: (_db, nombre) => ({ _col: nombre }),
    doc: (_db, col, id) => ({ _col: col, id }),
    query: (col) => ({ _col: col?._col }),
    where: (campo, op, valor) => ({ campo, op, valor }),
    orderBy: (campo) => ({ campo }),
    limit: (n) => ({ limit: n }),
    getDocs: async (q) => instantanea(q?._col),
    getDoc: async (ref) => {
      const fila = filasDe(ref?._col).find(f => f.id === ref?.id);
      return { id: ref?.id, exists: () => !!fila, data: () => fila?.datos };
    },
    getDocFromCache: async () => { throw new Error('sin cache local'); },
    writeBatch: () => ({ update: () => {}, set: () => {}, delete: () => {}, commit: async () => {} }),
    serverTimestamp: () => 'AHORA',
    deleteField: () => ({ _metodo: 'deleteField' }),
  };
});

/* ── El catálogo y los descuentos de la prueba ────────────────────────────── */

const CATALOGO = [
  { doc_id: 'p1', nombre: 'CUADERNO RIVADAVIA 48 HOJAS', rubro: 'LIBRERIA',
    sub_rubro: 'CUADERNOS', precio_venta: 3500, stock: 12, estado: 'activo' },
  { doc_id: 'p2', nombre: 'BOLIGRAFO BIC AZUL', rubro: 'LIBRERIA',
    sub_rubro: 'BOLIGRAFO', precio_venta: 1000, stock: 40, estado: 'activo' },
  { doc_id: 'p3', nombre: 'RESMA PAMPA A4', rubro: 'PAPELERIA',
    sub_rubro: 'RESMAS', precio_venta: 18000, stock: 5, estado: 'activo' },
];

const D1 = { __id: 'd1', nombre: 'Semana del cuaderno', tipo: 'porcentaje', valor: 20,
             alcance: 'rubro', objetivo: 'LIBRERIA', activo: true };
const D2 = { __id: 'd2', nombre: 'Cuadernos al 50', tipo: 'porcentaje', valor: 50,
             alcance: 'subrubro', objetivo: 'LIBRERIA|CUADERNOS', activo: true };
const D3 = { __id: 'd3', nombre: 'Bic suelto', tipo: 'porcentaje', valor: 30,
             alcance: 'producto', objetivo: 'p2', activo: true };

// El cuaderno con el 20% del rubro puesto: precio, pack y cada color rebajados
// en la misma proporción, y el de lista guardado al lado. Es como queda el
// espejo después de aplicar un descuento, y es de donde hay que volver.
const P1_CON_D1 = {
  rubro: 'LIBRERIA', sub_rubro: 'Cuadernos',
  precio: 2800, precio_anterior: 3500,
  precio_pack: 28000, precio_pack_anterior: 35000,
  descuento: { id: 'd1', nombre: 'Semana del cuaderno', porcentaje: 20 },
  variedades: [
    { nombre: 'Rojo', stock: 4, precio: 2800, precio_anterior: 3500 },
    { nombre: 'Azul', stock: 2, precio: 3600, precio_anterior: 4500 },
    // Sin precio propio: paga el del producto y no hay nada que reescalar.
    { nombre: 'Verde', stock: 1 },
  ],
};

const P2_A_LISTA = { rubro: 'LIBRERIA', sub_rubro: 'Boligrafo', precio: 1000 };
const P3_OTRO_RUBRO = { rubro: 'PAPELERIA', sub_rubro: 'Resmas', precio: 18000 };

/* ── Mover la pantalla ────────────────────────────────────────────────────── */

const respirar = () => new Promise(r => setTimeout(r, 0));
async function asentar(vueltas = 30) {
  for (let i = 0; i < vueltas; i++) await respirar();
}

/**
 * Deja la nube como la pide el caso y monta la pantalla de cero.
 *
 * Se resetean los módulos en cada montaje porque la pantalla guarda el
 * catálogo y la lista de descuentos en variables de módulo: sin esto, el
 * segundo montaje de una misma prueba arrancaría con lo del primero.
 */
async function montar({ descuentos = [], espejo = {} } = {}) {
  vi.resetModules();
  nube.catalogo = CATALOGO.map(p => ({ ...p }));
  nube.descuentos = descuentos.map(d => ({ ...d }));
  nube.espejo = new Map(Object.entries(clonar(espejo)));
  nube.operaciones = [];
  nube.confirmaciones = [];
  nube.avisos = [];
  nube.respuestaConfirmar = true;
  nube.falla.lote = false;
  nube.olvidos = 0;

  document.body.innerHTML = '<div id="cont"></div>';
  const cont = document.getElementById('cont');
  const mod = await import('../../webapp/src/pages/tienda_descuentos.js');
  await mod.renderTiendaDescuentos(cont, {});
  await asentar(5);
  return cont;
}

async function apretar(accion, id) {
  const boton = document.querySelector(`[data-accion="${accion}"][data-id="${id}"]`);
  expect(boton, `no está el botón de ${accion} de ${id}`).toBeTruthy();
  boton.click();
  await asentar();
}

/** Los renglones escritos al espejo, uno por producto, en orden. */
function alEspejo() {
  return nube.operaciones
    .filter(o => o.op === 'lote')
    .flatMap(o => o.escrituras)
    .filter(e => e.col === 'tienda_productos')
    .map(e => ({ id: e.id, datos: e.datos }));
}

const cambiosDe = (id) => alEspejo().find(e => e.id === id)?.datos;
const lotes = () => nube.operaciones.filter(o => o.op === 'lote').map(o => o.escrituras);
const sinEtiquetas = (html) => String(html || '').replace(/<[^>]+>/g, '');

/* ── Apagar ───────────────────────────────────────────────────────────────── */

describe('apagar un descuento', () => {
  it('devuelve el precio, el del pack y el de cada color a los de lista', async () => {
    await montar({
      descuentos: [D1],
      espejo: { p1: P1_CON_D1, p2: P2_A_LISTA, p3: P3_OTRO_RUBRO },
    });
    await apretar('alternar', 'd1');

    // Se escribe justo esto y nada más: el precio de lista de vuelta, sin
    // rastro de la rebaja ni en el pack ni en los colores. `precio_anterior` en
    // null es lo que apaga el tachado de la card en la tienda, y `descuento` en
    // null lo que saca la cinta "-20%".
    expect(cambiosDe('p1')).toEqual({
      precio: 3500,
      precio_anterior: null,
      precio_pack: 35000,
      precio_pack_anterior: null,
      descuento: null,
      variedades: [
        { nombre: 'Rojo', stock: 4, precio: 3500 },
        { nombre: 'Azul', stock: 2, precio: 4500 },
        { nombre: 'Verde', stock: 1 },
      ],
    });
    // Ningún color se queda con el precio anterior colgado: la tienda cobra el
    // del color cuando el color tiene precio propio.
    for (const v of cambiosDe('p1').variedades) {
      expect('precio_anterior' in v, `${v.nombre} quedó con el precio de la rebaja`).toBe(false);
    }
  });

  it('no le toca el precio a lo que ya estaba a precio de lista ni a otro rubro', async () => {
    await montar({
      descuentos: [D1],
      espejo: { p1: P1_CON_D1, p2: P2_A_LISTA, p3: P3_OTRO_RUBRO },
    });
    await apretar('alternar', 'd1');

    // Un rubro son cientos de documentos y cada escritura se paga: solo van
    // los que de verdad cambian de precio.
    expect(alEspejo().map(e => e.id)).toEqual(['p1']);
    expect(nube.espejo.get('p3')).toEqual(P3_OTRO_RUBRO);
  });

  it('apaga el descuento en la base y avisa cuántos productos movió', async () => {
    const cont = await montar({ descuentos: [D1], espejo: { p1: P1_CON_D1, p2: P2_A_LISTA } });
    await apretar('alternar', 'd1');

    expect(nube.operaciones.some(o => o.op === 'actualizar'
      && o.col === 'tienda_descuentos' && o.id === 'd1' && o.datos.activo === false)).toBe(true);
    expect(cont.querySelector('#descAviso').textContent).toBe('Apagado · 1 producto');
    // El espejado de la ficha se acuerda de los vigentes por un minuto: si no
    // se le avisa, el próximo guardado vuelve a poner el descuento apagado.
    expect(nube.olvidos).toBeGreaterThan(0);
  });

  it('un espejo viejo sin el pack de lista no queda con el pack rebajado', async () => {
    // Los documentos escritos antes de que existiera `precio_pack_anterior`
    // tienen el pack ya rebajado y ningún lugar de dónde sacar el de lista. Se
    // deshace la proporción: 28.000 al 20% de descuento salía 35.000.
    const viejo = {
      rubro: 'LIBRERIA', sub_rubro: 'Cuadernos',
      precio: 2800, precio_anterior: 3500, precio_pack: 28000,
      descuento: { id: 'd1', nombre: 'Semana del cuaderno', porcentaje: 20 },
    };
    await montar({ descuentos: [D1], espejo: { p1: viejo } });
    await apretar('alternar', 'd1');

    // `precio_pack_anterior` no viaja: el documento no lo tenía y sin rebaja
    // tampoco lo necesita, así que escribirlo en null sería un campo de más en
    // cada uno de los cientos de productos del rubro.
    expect(cambiosDe('p1')).toEqual({
      precio: 3500, precio_anterior: null, precio_pack: 35000, descuento: null,
    });
  });
});

/* ── Precedencia: rubro < subrubro < producto ─────────────────────────────── */

describe('apagar uno con otro descuento encima', () => {
  // El cuaderno cae bajo el del rubro Y bajo el del subrubro: manda el del
  // subrubro. El bolígrafo cae bajo el del rubro y bajo el suyo propio: manda
  // el propio.
  const TRES_NIVELES = {
    descuentos: [D1, D2, D3],
    espejo: {
      p1: { rubro: 'LIBRERIA', sub_rubro: 'Cuadernos', precio: 1750, precio_anterior: 3500,
            descuento: { id: 'd2', nombre: 'Cuadernos al 50', porcentaje: 50 } },
      p2: { rubro: 'LIBRERIA', sub_rubro: 'Boligrafo', precio: 700, precio_anterior: 1000,
            descuento: { id: 'd3', nombre: 'Bic suelto', porcentaje: 30 } },
    },
  };

  it('apagar el del rubro deja puesto el del subrubro, no el precio de lista', async () => {
    await montar(TRES_NIVELES);
    await apretar('alternar', 'd1');

    // El cuaderno ni se mueve: ya estaba con el del subrubro, que sigue
    // vigente. Volverlo a 3.500 sería regalarle al cliente la sorpresa de ver
    // el precio subir con la oferta del 50% todavía anunciada.
    expect(cambiosDe('p1')).toBeUndefined();
    expect(nube.espejo.get('p1')).toMatchObject({
      precio: 1750, precio_anterior: 3500, descuento: { id: 'd2' },
    });
    expect(nube.espejo.get('p2')).toMatchObject({ precio: 700, descuento: { id: 'd3' } });
  });

  it('apagar el del subrubro deja el del rubro, no el precio de lista', async () => {
    await montar(TRES_NIVELES);
    await apretar('alternar', 'd2');

    // 3.500 con el 20% del rubro, no los 3.500 pelados.
    expect(cambiosDe('p1')).toEqual({
      precio: 2800,
      descuento: { id: 'd1', nombre: 'Semana del cuaderno', porcentaje: 20 },
    });
    expect(nube.espejo.get('p1').precio).not.toBe(3500);
    // El bolígrafo no está en el alcance del subrubro: no se lo lee ni se lo
    // escribe.
    expect(alEspejo().map(e => e.id)).toEqual(['p1']);
  });

  it('apagar el del artículo lo deja con el del rubro', async () => {
    await montar(TRES_NIVELES);
    await apretar('alternar', 'd3');

    expect(cambiosDe('p2')).toEqual({
      precio: 800,
      descuento: { id: 'd1', nombre: 'Semana del cuaderno', porcentaje: 20 },
    });
    expect(nube.espejo.get('p2').precio_anterior).toBe(1000);
  });

  it('sin nada más vigente, ahí sí vuelve al precio de lista', async () => {
    await montar({ descuentos: [D2, D3], espejo: TRES_NIVELES.espejo });
    await apretar('alternar', 'd2');

    expect(cambiosDe('p1')).toEqual({ precio: 3500, precio_anterior: null, descuento: null });
  });
});

/* ── Borrar ───────────────────────────────────────────────────────────────── */

describe('borrar un descuento', () => {
  const SIMPLE = { descuentos: [D1], espejo: { p1: P1_CON_D1, p2: P2_A_LISTA, p3: P3_OTRO_RUBRO } };

  it('deja los precios igual que apagarlo, y además lo saca de la base', async () => {
    await montar(SIMPLE);
    await apretar('alternar', 'd1');
    const alApagar = alEspejo();

    await montar(SIMPLE);
    await apretar('borrar', 'd1');
    const alBorrar = alEspejo();

    expect(alBorrar).toEqual(alApagar);
    expect(nube.descuentos.map(d => d.__id)).toEqual([]);
    // Borrar no toca `activo`: el documento se va entero.
    expect(nube.operaciones.some(o => o.op === 'actualizar')).toBe(false);
  });

  it('rehace los precios ANTES de borrar el descuento', async () => {
    await montar(SIMPLE);
    await apretar('borrar', 'd1');

    const orden = nube.operaciones.map(o => o.op);
    expect(orden).toEqual(['lote', 'borrar']);
    // Al revés queda un rubro entero rebajado y sin nada en la base que
    // explique por qué.
    expect(nube.operaciones.at(-1)).toMatchObject({ col: 'tienda_descuentos', id: 'd1' });
  });

  it('con otro descuento encima, borrar tampoco vuelve al precio de lista', async () => {
    await montar({
      descuentos: [D1, D2],
      espejo: { p1: { rubro: 'LIBRERIA', sub_rubro: 'Cuadernos', precio: 1750,
                      precio_anterior: 3500,
                      descuento: { id: 'd2', nombre: 'Cuadernos al 50', porcentaje: 50 } },
                p2: { rubro: 'LIBRERIA', sub_rubro: 'Boligrafo', precio: 800,
                      precio_anterior: 1000,
                      descuento: { id: 'd1', nombre: 'Semana del cuaderno', porcentaje: 20 } } },
    });
    await apretar('borrar', 'd1');

    expect(nube.espejo.get('p1')).toMatchObject({ precio: 1750, descuento: { id: 'd2' } });
    expect(nube.espejo.get('p2')).toMatchObject({ precio: 1000, precio_anterior: null, descuento: null });
  });

  it('si se dice que no, no se toca nada', async () => {
    await montar(SIMPLE);
    nube.respuestaConfirmar = false;
    await apretar('borrar', 'd1');

    expect(nube.operaciones).toEqual([]);
    expect(nube.descuentos.map(d => d.__id)).toEqual(['d1']);
    expect(nube.espejo.get('p1')).toEqual(P1_CON_D1);
  });

  it('si falla rehacer los precios, el descuento se queda en la base', async () => {
    const cont = await montar(SIMPLE);
    nube.falla.lote = true;
    await apretar('borrar', 'd1');

    // Nada de borrar: mientras el descuento siga cargado, el sync vuelve a
    // dejar los precios como corresponde en la corrida siguiente. Borrarlo
    // acá dejaría el rubro rebajado para siempre.
    expect(nube.operaciones.some(o => o.op === 'borrar')).toBe(false);
    expect(nube.descuentos.map(d => d.__id)).toEqual(['d1']);
    expect(nube.avisos.at(-1)?.title).toBe('No se pudo borrar');
    // Y la tarjeta vuelve a la lista: si desaparece, el que la borró cree que
    // salió bien.
    expect(cont.textContent).toContain('Semana del cuaderno');
  });
});

/* ── El cartel de Borrar ──────────────────────────────────────────────────── */

describe('el cartel de confirmación de Borrar', () => {
  it('dice qué se borra y que los precios vuelven a los de lista', async () => {
    await montar({ descuentos: [D1], espejo: { p1: P1_CON_D1 } });
    await apretar('borrar', 'd1');

    const [cartel] = nube.confirmaciones;
    const texto = sinEtiquetas(cartel.message);
    expect(cartel.title).toBe('Borrar descuento');
    expect(cartel.danger).toBe(true);
    expect(texto).toContain('Semana del cuaderno');
    expect(texto).toContain('precios vuelven a los de lista');
    // Y pasó lo que prometió: no queda nada rebajado.
    expect(nube.espejo.get('p1')).toMatchObject({ precio: 3500, precio_anterior: null, descuento: null });
  });

  it('con otro descuento vigente avisa que ésos no vuelven a la lista', async () => {
    await montar({
      descuentos: [D1, D2],
      espejo: { p1: { rubro: 'LIBRERIA', sub_rubro: 'Cuadernos', precio: 1750,
                      precio_anterior: 3500,
                      descuento: { id: 'd2', nombre: 'Cuadernos al 50', porcentaje: 50 } } },
    });
    await apretar('borrar', 'd1');

    const texto = sinEtiquetas(nube.confirmaciones[0].message);
    expect(texto).toMatch(/otro descuento/i);
    // Y de nuevo: el cartel dijo la verdad. El cuaderno sigue con el del
    // subrubro puesto.
    expect(nube.espejo.get('p1')).toMatchObject({ precio: 1750, descuento: { id: 'd2' } });
  });

  it('un descuento apagado no cuenta como "otro vigente"', async () => {
    await montar({
      descuentos: [D1, { ...D2, activo: false }],
      espejo: { p1: P1_CON_D1 },
    });
    await apretar('borrar', 'd1');

    const texto = sinEtiquetas(nube.confirmaciones[0].message);
    expect(texto).not.toMatch(/otro descuento/i);
    expect(nube.espejo.get('p1')).toMatchObject({ precio: 3500, descuento: null });
  });
});

/* ── Alcances grandes ─────────────────────────────────────────────────────── */

describe('un alcance de cientos de productos', () => {
  const CUANTOS = 950;

  function rubroGrande() {
    const espejo = {};
    for (let i = 1; i <= CUANTOS; i++) {
      espejo[`art${String(i).padStart(3, '0')}`] = {
        rubro: 'LIBRERIA', sub_rubro: 'Varios',
        precio: 800, precio_anterior: 1000,
        descuento: { id: 'd1', nombre: 'Semana del cuaderno', porcentaje: 20 },
      };
    }
    return espejo;
  }

  it('se parte en lotes de 400 sin perder ni repetir ninguno', async () => {
    await montar({ descuentos: [D1], espejo: rubroGrande() });
    await apretar('alternar', 'd1');

    // Firestore no acepta más de 500 operaciones por commit: si se mandaran
    // todas juntas, el lote se rechaza entero y no vuelve ningún precio.
    expect(lotes().map(l => l.length)).toEqual([400, 400, 150]);

    const escritos = alEspejo().map(e => e.id);
    expect(escritos.length).toBe(CUANTOS);
    expect(new Set(escritos).size).toBe(CUANTOS);
    expect(escritos).toContain('art001');
    expect(escritos).toContain('art950');
  });

  it('todos quedan a precio de lista, también el último', async () => {
    await montar({ descuentos: [D1], espejo: rubroGrande() });
    await apretar('alternar', 'd1');

    for (const [id, datos] of nube.espejo) {
      expect(datos, id).toMatchObject({ precio: 1000, precio_anterior: null, descuento: null });
    }
  });

  it('el botón va contando mientras escribe', async () => {
    await montar({ descuentos: [D1], espejo: rubroGrande() });
    await apretar('alternar', 'd1');

    // Esperar en silencio a que se escriban 950 documentos se siente como que
    // el botón no anduvo: cada lote que sale deja el número a la vista.
    const carteles = nube.operaciones.filter(o => o.op === 'lote').map(o => o.enPantalla);
    expect(carteles[0]).toBe('Aplicando…');
    expect(carteles[1]).toBe(`Aplicando… 400/${CUANTOS}`);
    expect(carteles[2]).toBe(`Aplicando… 800/${CUANTOS}`);
  });

  it('borrar el descuento del rubro grande también los devuelve a todos', async () => {
    await montar({ descuentos: [D1], espejo: rubroGrande() });
    await apretar('borrar', 'd1');

    expect(alEspejo().length).toBe(CUANTOS);
    expect(nube.operaciones.at(-1)).toMatchObject({ op: 'borrar', col: 'tienda_descuentos', id: 'd1' });
    expect(nube.espejo.get('art500')).toMatchObject({ precio: 1000, descuento: null });
  });
});

describe('el catálogo con la pantalla abierta', () => {
  // La pantalla no se redibuja con cada venta del POS, así que la copia del
  // catálogo que leyó al entrar se quedaba vieja: un artículo dado de alta
  // después no aparecía en el buscador del descuento hasta salir y volver.
  it('un artículo dado de alta después de entrar aparece en el buscador', async () => {
    await montar();
    const { setCacheValue } = await import('../../webapp/src/cache.js');
    setCacheValue('catalogo:all', [
      ...CATALOGO.map(p => ({ ...p })),
      { doc_id: 'p9', nombre: 'MARCADOR FLUO NUEVO', rubro: 'LIBRERIA', sub_rubro: 'MARCADORES',
        precio_venta: 1500, stock: 3, estado: 'activo' },
    ]);

    document.getElementById('descNuevo').click();
    await asentar();
    const alcance = document.getElementById('dAlcance');
    alcance.value = 'producto';
    alcance.dispatchEvent(new Event('change', { bubbles: true }));
    const buscador = document.getElementById('dBuscarProd');
    buscador.value = 'marcador fluo';
    buscador.dispatchEvent(new Event('input', { bubbles: true }));
    await asentar();

    expect(document.querySelector('#dResultados [data-prod="p9"]')).toBeTruthy();
  });
});

