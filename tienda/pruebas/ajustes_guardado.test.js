// @vitest-environment jsdom
/**
 * El botón Guardar de Configuración de la Tienda.
 *
 * Es el camino que más escribe del panel y el único sin red de contención: un
 * solo click toca `tienda_config/settings` (horarios, tramos de envío, mínimo,
 * alias, efectivo, tienda abierta), `tienda_config/publicacion` (qué rubros y
 * subrubros salen), publica o saca de la vidriera todos los productos de los
 * rubros que cambiaron, y rehace el conteo por rubro que dibuja los filtros de
 * la portada. Cualquier campo de más o de menos en esa escritura se ve del lado
 * del cliente: el envío cotizado mal, el mínimo que no frena el checkout, un
 * rubro entero que desaparece de la tienda.
 *
 * Acá se mueve la pantalla de verdad, a botonazos, con las reglas de
 * publicación de producción. Lo único de mentira es la red: un `fetch` que
 * habla el mismo protocolo REST que Firestore, guarda lo que le mandan y deja
 * el registro de cada escritura. Así lo que mira la prueba es exactamente lo
 * que habría quedado en la base, no que se haya llamado a tal función.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// El codificador y el decodificador de la REST son los de la tienda
// (`netlify/functions/lib`), no los del módulo que se está probando: si el
// panel se equivocara al armar los valores tipados, la prueba lo tiene que ver.
import { aCampos, aplanar } from '../netlify/functions/lib/firestore.mjs';

// jsdom no trae el objeto `CSS`, que cualquier navegador tiene. La lista de
// rubros arma con `CSS.escape()` el selector de los subrubros al tildar uno, y
// sin esto la prueba revienta por un agujero del entorno, no del panel.
if (!globalThis.CSS) {
  globalThis.CSS = {
    // Como el de verdad: le antepone una barra a todo lo que no sea letra,
    // número, guion bajo o guion.
    escape: (valor) => String(valor).replace(/[^A-Za-z0-9_-]/g, (c) => '\\' + c),
  };
}

const { nube, registro, espia } = vi.hoisted(() => ({
  // Lo que hay en el servidor.
  nube: { catalogo: [], tienda_config: {}, tienda_productos: {} },
  // Cada escritura que llegó, en orden.
  registro: [],
  espia: { confirmar: true, avisos: [], confirmaciones: [] },
}));

/* ── El servidor de mentira ───────────────────────────────────────────────── */

const DOCS = 'projects/mari-d7c71/databases/(default)/documents';

const respuesta = (status, cuerpo) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => cuerpo,
});

/** "…/documents/tienda_config/settings" → { col, id } */
function deRuta(nombre) {
  const [col, id] = String(nombre).split('/documents/')[1].split('/');
  return { col, id };
}

function coleccion(col) {
  if (col === 'tienda_config') return nube.tienda_config;
  if (col === 'tienda_productos') return nube.tienda_productos;
  return null;
}

/**
 * Una escritura de `documents:commit`, aplicada como la aplicaría Firestore.
 *
 * La `updateMask` importa: con máscara solo se tocan los campos nombrados (y el
 * que está en la máscara pero no en `fields` se BORRA); sin máscara el
 * documento se reemplaza entero. Es la diferencia entre conservar el origen
 * verificado del local y perderlo.
 */
function aplicarEscritura(w) {
  if (w.delete) {
    const { col, id } = deRuta(w.delete);
    registro.push({ op: 'borrar', col, id, campos: null, mask: null });
    const destino = coleccion(col);
    if (destino) delete destino[id];
    return;
  }

  const { col, id } = deRuta(w.update.name);
  const campos = aplanar(w.update.fields || {});
  const mask = w.updateMask?.fieldPaths ? [...w.updateMask.fieldPaths] : null;
  registro.push({ op: 'escribir', col, id, campos, mask });

  const destino = coleccion(col);
  if (!destino) return;
  if (!mask) { destino[id] = campos; return; }
  const quedan = { ...(destino[id] || {}) };
  for (const campo of mask) {
    if (campo in campos) quedan[campo] = campos[campo];
    else delete quedan[campo];
  }
  destino[id] = quedan;
}

function servidorFalso() {
  return vi.fn(async (url, opciones = {}) => {
    const direccion = String(url);
    const cuerpo = opciones.body ? JSON.parse(opciones.body) : null;

    if (direccion.endsWith(':commit')) {
      for (const w of cuerpo?.writes || []) aplicarEscritura(w);
      return respuesta(200, { writeResults: (cuerpo?.writes || []).map(() => ({})) });
    }

    if (direccion.endsWith(':runQuery')) {
      const col = cuerpo?.structuredQuery?.from?.[0]?.collectionId;
      if (col !== 'tienda_productos') return respuesta(200, []);   // sin descuentos vigentes
      // El `orden` más alto que hay hoy en la vidriera: es de donde sigue
      // numerando lo que entra nuevo.
      const ordenes = Object.values(nube.tienda_productos).map(d => Number(d.orden) || 0);
      return respuesta(200, [{ document: {
        name: `${DOCS}/tienda_productos/tope`,
        fields: { orden: { integerValue: String(ordenes.length ? Math.max(...ordenes) : 0) } },
      } }]);
    }

    if (direccion.endsWith(':batchGet')) {
      return respuesta(200, (cuerpo?.documents || []).map(nombre => {
        const guardado = nube.tienda_productos[String(nombre).split('/').pop()];
        if (!guardado) return { missing: nombre };
        return { found: { name: nombre, fields: aCampos({
          orden: guardado.orden ?? 0,
          orden_rubro: guardado.orden_rubro ?? 0,
          destacado: guardado.destacado === true,
        }) } };
      }));
    }

    // GET de un documento suelto, con o sin máscara.
    const ruta = direccion.split('/documents/')[1]?.split('?')[0] || '';
    const [col, id] = ruta.split('/');
    const guardado = coleccion(col)?.[id];
    return guardado
      ? respuesta(200, { name: `${DOCS}/${ruta}`, fields: aCampos(guardado) })
      : respuesta(404, {});
  });
}

/* ── Los dobles ───────────────────────────────────────────────────────────── */

vi.mock('firebase/firestore', () => {
  const instantanea = (lista) => ({
    docs: lista.map(d => ({ id: d.doc_id, ref: { id: d.doc_id }, data: () => d,
                            exists: () => true })),
    empty: lista.length === 0,
    size: lista.length,
    forEach(fn) { this.docs.forEach(fn); },
  });
  const unDoc = (ref, datos) => ({
    exists: () => !!datos, data: () => datos, get: (campo) => datos?.[campo], id: ref?.id,
  });

  return {
    collection: (_db, nombre) => ({ _col: nombre }),
    doc: (_db, col, id) => ({ _col: col, id, path: `${col}/${id}` }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    orderBy: (campo, dir) => ({ campo, dir }),
    limit: (n) => ({ limit: n }),
    where: (campo, op, valor) => ({ campo, op, valor }),
    getDocs: async (q) => instantanea(q?._col === 'catalogo' ? nube.catalogo : []),
    getDoc: async (ref) => {
      if (ref?._col === 'tienda_config') return unDoc(ref, nube.tienda_config[ref.id]);
      if (ref?._col === 'tienda_productos') return unDoc(ref, nube.tienda_productos[ref.id]);
      return unDoc(ref, nube.catalogo.find(d => d.doc_id === ref?.id));
    },
    // Como en producción la primera vez: no está en el cache local del SDK.
    getDocFromCache: async () => { throw new Error('sin cache local'); },
    onSnapshot: () => () => {},
    setDoc: async () => {},
    // Si algo cayera al SDK la prueba tiene que enterarse, no seguir en verde.
    writeBatch: () => { throw new Error('no debería caer al SDK: la REST contesta'); },
    serverTimestamp: () => ({ _methodName: 'serverTimestamp' }),
    deleteField: () => ({ _methodName: 'deleteField' }),
  };
});

vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {}, storage: {} }));
vi.mock('../../webapp/src/auth.js', () => ({
  // Con sesión, las escrituras salen por REST, que es el camino de producción.
  auth: { currentUser: { uid: 'u1', displayName: 'Mari', getIdToken: async () => 'TOKEN' } },
  getSession: () => ({ uid: 'u1', display: 'Mari', role: 'admin' }),
  isLoggedIn: () => true, onAuthReady: async () => ({ role: 'admin' }),
  hasSessionHint: () => true, logout: async () => {},
}));
vi.mock('../../webapp/src/store.js', () => ({
  ensureCollections: () => {}, onStoreChange: () => () => {},
  initStore: async () => {}, storeListo: async () => {},
}));

// Los diálogos son modales de verdad y taparían la pantalla; se reemplazan solo
// ellos dos y se guarda con qué se los llamó, que es parte de lo que se prueba.
vi.mock('../../webapp/src/components/dialogs.js', async (original) => ({
  ...(await original()),
  alertDialog: vi.fn(async (opciones) => { espia.avisos.push(opciones); }),
  confirmDialog: vi.fn(async (opciones) => {
    espia.confirmaciones.push(opciones);
    return espia.confirmar;
  }),
}));

/* ── El local de la prueba ────────────────────────────────────────────────── */

// Dos rubros prendidos (Librería y Papelería) y uno apagado (Cotillón), que es
// la forma real: la tienda arrancó con lo que se podía fotografiar.
const CATALOGO = [
  { doc_id: '1001', nombre: 'CUADERNO RIVADAVIA 48 HOJAS', codigo: 'C001',
    rubro: 'LIBRERIA', sub_rubro: 'CUADERNOS', categoria: 'Cuadernos',
    marca: 'RIVADAVIA', estado: 'activo', precio_venta: 3500, costo: 2100,
    stock: 12, tienda_imagenes: ['cuaderno.webp'] },
  { doc_id: '1002', nombre: 'ABROCHADORA MAPED', codigo: 'C002',
    rubro: 'LIBRERIA', sub_rubro: 'ABROCHADORAS', categoria: 'Escritorio',
    marca: 'MAPED', estado: 'activo', precio_venta: 8900, costo: 5200,
    stock: 6, tienda_imagenes: ['abrochadora.webp'] },
  { doc_id: '2001', nombre: 'GLOBO LISO', codigo: 'C003',
    rubro: 'COTILLON', sub_rubro: 'GLOBOS', categoria: 'Globos',
    marca: 'SIN MARCA', estado: 'activo', precio_venta: 300, costo: 100,
    stock: 40, tienda_imagenes: ['globo.webp'] },
  // Marcada "Publicar siempre" desde su ficha: adentro de un rubro prendido
  // sale igual, con el rubro apagado no.
  { doc_id: '2002', nombre: 'BENGALA FANTASIA', codigo: 'C004',
    rubro: 'COTILLON', sub_rubro: 'BENGALAS', categoria: 'Velas',
    marca: 'SIN MARCA', estado: 'activo', precio_venta: 1200, costo: 600,
    stock: 14, tienda_publicar: true, tienda_imagenes: ['bengala.webp'] },
  // Sin stock: prender el rubro no lo publica.
  { doc_id: '2003', nombre: 'GORRITO CUMPLE', codigo: 'C005',
    rubro: 'COTILLON', sub_rubro: 'GLOBOS', categoria: 'Cotillon',
    marca: 'SIN MARCA', estado: 'activo', precio_venta: 800, costo: 300,
    stock: 0, tienda_imagenes: ['gorrito.webp'] },
  { doc_id: '3001', nombre: 'RESMA PAMPA A4', codigo: 'C006',
    rubro: 'PAPELERIA', sub_rubro: 'RESMAS', categoria: 'Resmas',
    marca: 'PAMPA', estado: 'activo', precio_venta: 18000, costo: 13000,
    stock: 20, tienda_imagenes: ['resma.webp'] },
];

const HABIL = [{ desde: '09:00', hasta: '13:00' }, { desde: '17:00', hasta: '20:30' }];

const SETTINGS = () => ({
  abierta: true,
  nombre: 'Librería Liceo',
  direccion: 'Av. Alfonsina Storni 168, X5019 Córdoba',
  telefono: '3517046684',
  whatsapp: '5493517046684',
  email: 'libreria.liceo@hotmail.com',
  banner: null,
  barrio: 'Parque Liceo 1ª Sección',
  // La coordenada verificada contra Places: de acá sale lo que paga cada
  // cliente por el envío y esta pantalla no la tiene que tocar nunca.
  origen: { lat: -31.3234, lng: -64.2145 },
  origen_verificado: true,
  horarios: [...Array(5)].map(() => ({ tramos: HABIL.map(t => ({ ...t })) }))
    .concat([{ tramos: [{ desde: '09:00', hasta: '13:00' }] }, { tramos: [] }]),
  horarios_texto: 'Lunes a viernes de 9 a 13 y de 17 a 20:30 · Sábado de 9 a 13 · Domingo cerrado',
  entrega: {
    retiro_habilitado: true, delivery_habilitado: true, radio_max_km: 12,
    demora_texto: '24 a 48 hs', envio_gratis_desde: null, pedido_minimo: 0,
    tramos: [{ hasta_km: 3, precio: 1500 }, { hasta_km: 6, precio: 2500 },
             { hasta_km: 12, precio: 3500 }],
  },
  pago: { alias: null, titular: null, efectivo_habilitado: false },
});

// Lo que la tienda ya tiene publicado: los dos de Librería y el de Papelería,
// cada uno con su lugar en la vidriera.
const ESPEJO = () => ({
  1001: { nombre: 'Cuaderno Rivadavia 48 Hojas', rubro: 'LIBRERIA', orden: 10, orden_rubro: 1 },
  1002: { nombre: 'Abrochadora Maped', rubro: 'LIBRERIA', orden: 11, orden_rubro: 2 },
  3001: { nombre: 'Resma Pampa A4', rubro: 'PAPELERIA', orden: 12, orden_rubro: 1 },
});

let contenedor;
let fetchOriginal;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  registro.length = 0;
  espia.confirmar = true;
  espia.avisos.length = 0;
  espia.confirmaciones.length = 0;

  nube.catalogo = CATALOGO.map(p => structuredClone(p));
  nube.tienda_productos = ESPEJO();
  nube.tienda_config = {
    settings: SETTINGS(),
    publicacion: { rubros: ['LIBRERIA', 'PAPELERIA'] },
    rubros: { lista: [
      { clave: 'LIBRERIA', nombre: 'Librería', cantidad: 2, con_stock: 2 },
      { clave: 'PAPELERIA', nombre: 'Papelería', cantidad: 1, con_stock: 1 },
    ] },
  };

  fetchOriginal = globalThis.fetch;
  globalThis.fetch = servidorFalso();

  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
});

afterEach(() => { globalThis.fetch = fetchOriginal; });

/* ── Manejar la pantalla ──────────────────────────────────────────────────── */

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

async function montar() {
  const mod = await import('../../webapp/src/pages/tienda_ajustes.js');
  await mod.renderTiendaAjustes(contenedor, {});
  for (let i = 0; i < 10; i++) await esperar();
  return contenedor;
}

/** Click en Guardar, y esperar a que la pantalla diga en qué terminó. */
async function guardar() {
  document.getElementById('cfgGuardar').click();
  for (let i = 0; i < 80; i++) {
    await esperar();
    const dice = document.getElementById('cfgEstado').textContent;
    if (/^Guardado|^No se pudo/.test(dice)) return dice;
  }
  return document.getElementById('cfgEstado').textContent;
}

function tipear(el, valor) {
  el.value = valor;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function tildar(el, tildado) {
  el.checked = tildado;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const casilla = (rubro) => contenedor.querySelector(`[data-rubro="${rubro}"]`);
const casillaSub = (rubro, sub) =>
  contenedor.querySelector(`[data-subrubro="${sub}"][data-subrubro-de="${rubro}"]`);

const tramoDeEnvio = (i, campo) =>
  contenedor.querySelector(`[data-tramo="${i}"] input[data-campo="${campo}"]`);
const tramoDelDia = (dia, i, punta) =>
  contenedor.querySelector(`[data-dia="${dia}"] input[data-tramo="${i}"][data-punta="${punta}"]`);

const escrituras = (col, id = null) =>
  registro.filter(e => e.col === col && (id === null || e.id === id));
const ultima = (col, id = null) => escrituras(col, id).at(-1);

/* ── Lo que queda escrito en settings ─────────────────────────────────────── */

// Los catorce campos que esta pantalla maneja. Ni uno más (un campo que se cuela
// pisa lo que escribió otro lado) ni uno menos (el que falta se queda con el
// valor viejo y la pantalla miente).
const CAMPOS_DE_SETTINGS = [
  'abierta', 'banner', 'barrio', 'direccion', 'email', 'entrega', 'horarios',
  'horarios_texto', 'nombre', 'origen', 'origen_verificado', 'pago', 'telefono',
  'whatsapp',
].sort();

describe('lo que se guarda es lo que se tildó', () => {
  it('escribe los catorce campos de la pantalla, con lo que quedó cargado', async () => {
    await montar();

    // La dueña cierra la tienda por vacaciones, deja de repartir a domicilio,
    // acepta efectivo, carga el alias y pone el mínimo de $6.500.
    document.getElementById('cfgAbierta').click();
    tildar(document.getElementById('cfgDelivery'), false);
    tildar(document.getElementById('cfgEfectivo'), true);
    tipear(document.getElementById('cfgAlias'), '  libreria.liceo.mp  ');
    tipear(document.getElementById('cfgTitular'), 'María Brizuela');
    tipear(document.getElementById('cfgMinimo'), '6500');
    tipear(document.getElementById('cfgBanner'), 'Cerramos del 1 al 10 de enero');

    expect(await guardar()).toBe('Guardado.');

    const escrito = ultima('tienda_config', 'settings');
    expect(escrito.op).toBe('escribir');
    // La máscara es lo que decide qué campos se pisan: si lista de más, borra
    // lo que no sale de esta pantalla.
    expect([...escrito.mask].sort()).toEqual(CAMPOS_DE_SETTINGS);
    expect(Object.keys(escrito.campos).sort()).toEqual(CAMPOS_DE_SETTINGS);

    expect(escrito.campos.abierta).toBe(false);
    expect(escrito.campos.banner).toBe('Cerramos del 1 al 10 de enero');
    expect(escrito.campos.entrega.retiro_habilitado).toBe(true);
    expect(escrito.campos.entrega.delivery_habilitado).toBe(false);
    expect(escrito.campos.entrega.pedido_minimo).toBe(6500);
    // Vacío es "nunca", no cero: con cero todos los envíos saldrían gratis.
    expect(escrito.campos.entrega.envio_gratis_desde).toBeNull();
    expect(escrito.campos.pago).toEqual({
      alias: 'libreria.liceo.mp', titular: 'María Brizuela', efectivo_habilitado: true,
    });
    expect(Object.keys(escrito.campos.entrega).sort()).toEqual([
      'delivery_habilitado', 'demora_texto', 'envio_gratis_desde', 'pedido_minimo',
      'radio_max_km', 'retiro_habilitado', 'tramos',
    ]);
  });

  it('el origen verificado del local vuelve tal cual, no se pisa desde acá', async () => {
    await montar();
    tipear(document.getElementById('cfgDireccion'), 'Otra dirección 500');
    await guardar();

    const escrito = ultima('tienda_config', 'settings');
    // Se cambió la dirección escrita, pero la coordenada con la que se cotiza
    // el envío es la verificada contra Places y sigue siendo la misma.
    expect(escrito.campos.direccion).toBe('Otra dirección 500');
    expect(escrito.campos.origen).toEqual({ lat: -31.3234, lng: -64.2145 });
    expect(escrito.campos.origen_verificado).toBe(true);
    expect(nube.tienda_config.settings.origen).toEqual({ lat: -31.3234, lng: -64.2145 });
  });

  it('los tramos de envío se guardan ordenados, sin los vacíos y sin precios negativos', async () => {
    await montar();

    // El primer tramo se anula poniéndole 0 km, el último pasa a 9 km y le
    // entra un guion de más en el precio.
    tipear(tramoDeEnvio(0, 'hasta_km'), '0');
    tipear(tramoDeEnvio(2, 'hasta_km'), '9');
    tipear(tramoDeEnvio(2, 'precio'), '-500');
    await guardar();

    // Queda una tabla que la tienda puede leer: en orden, sin el tramo que no
    // cubre nada y sin un precio que le devolvería plata al cliente.
    expect(ultima('tienda_config', 'settings').campos.entrega.tramos).toEqual([
      { hasta_km: 6, precio: 2500 },
      { hasta_km: 9, precio: 0 },
    ]);
  });

  it('sin tocar rubros no escribe nada más que settings', async () => {
    await montar();
    tipear(document.getElementById('cfgTelefono'), '3512345678');
    expect(await guardar()).toBe('Guardado.');

    // Ni el aviso de "esto mueve cientos de productos", ni la publicación, ni
    // la vidriera, ni el conteo de la portada: cambiar un teléfono no puede
    // costar cientos de escrituras.
    expect(espia.confirmaciones).toHaveLength(0);
    expect(registro).toHaveLength(1);
    expect(escrituras('tienda_config', 'publicacion')).toHaveLength(0);
    expect(escrituras('tienda_productos')).toHaveLength(0);
    expect(escrituras('tienda_config', 'rubros')).toHaveLength(0);
  });
});

/* ── Prender y apagar rubros ──────────────────────────────────────────────── */

describe('prender y apagar un rubro mueve la vidriera en el momento', () => {
  it('prender el rubro publica sus productos, salvo los que no pueden salir', async () => {
    await montar();
    tildar(casilla('COTILLON'), true);
    const dice = await guardar();

    // Se avisa antes, con el número puesto: son tres productos de Cotillón.
    expect(espia.confirmaciones).toHaveLength(1);
    expect(espia.confirmaciones[0].message).toContain('Entran: Cotillón');
    expect(espia.confirmaciones[0].message).toContain('3 productos');

    expect([...ultima('tienda_config', 'publicacion').campos.rubros].sort())
      .toEqual(['COTILLON', 'LIBRERIA', 'PAPELERIA']);

    // El globo y la bengala salen a la web; el gorrito sin stock no, y encima
    // se lo saca por las dudas (podría estar publicado de antes).
    expect(ultima('tienda_productos', '2001').op).toBe('escribir');
    expect(ultima('tienda_productos', '2001').campos.nombre).toBe('Globo Liso');
    expect(ultima('tienda_productos', '2002').op).toBe('escribir');
    expect(ultima('tienda_productos', '2003').op).toBe('borrar');
    expect(dice).toBe('Guardado. 2 productos en la tienda, 1 afuera.');

    // Los rubros que no cambiaron no se tocan: reescribirlos les borraría el
    // lugar que tienen en la vidriera.
    expect(escrituras('tienda_productos', '1001')).toHaveLength(0);
    expect(escrituras('tienda_productos', '3001')).toHaveLength(0);
  });

  it('publica con el catálogo de ahora, no con el que había al abrir la pantalla', async () => {
    // La pantalla se deja abierta y mientras tanto el POS sigue: cambia un
    // precio, entra stock, se da de alta un producto. Prender el rubro
    // publicaba con la copia del catálogo leída al entrar, y la tienda quedaba
    // con el precio y el stock de hace horas hasta la corrida siguiente del sync.
    await montar();

    const { setCacheValue } = await import('../../webapp/src/cache.js');
    const ahora = CATALOGO.map(p => structuredClone(p));
    ahora.find(p => p.doc_id === '2001').precio_venta = 450;
    ahora.find(p => p.doc_id === '2003').stock = 5;
    ahora.push({ doc_id: '2004', nombre: 'VELA NUMERO', codigo: 'C007', rubro: 'COTILLON',
                 sub_rubro: 'VELAS', categoria: 'Velas', marca: 'SIN MARCA', estado: 'activo',
                 precio_venta: 900, costo: 400, stock: 9, tienda_imagenes: ['vela.webp'] });
    setCacheValue('catalogo:all', ahora);

    tildar(casilla('COTILLON'), true);
    const dice = await guardar();

    expect(espia.confirmaciones[0].message).toContain('4 productos');
    expect(ultima('tienda_productos', '2001').campos.precio).toBe(450);
    expect(ultima('tienda_productos', '2003').op, 'el gorrito ya tiene stock').toBe('escribir');
    expect(ultima('tienda_productos', '2004')?.op, 'el producto nuevo no se publicó').toBe('escribir');
    expect(dice).toBe('Guardado. 4 productos en la tienda, 0 afuera.');
  });

  it('lo que entra nuevo se numera al final y no se mete adelante de nada', async () => {
    await montar();
    tildar(casilla('COTILLON'), true);
    await guardar();

    // El tope de la vidriera era 12: los dos de Cotillón siguen desde ahí, y
    // el `orden_rubro` de lo nuevo queda al fondo hasta que ordene el sync.
    const ordenes = ['2001', '2002'].map(id => nube.tienda_productos[id].orden).sort();
    expect(ordenes).toEqual([13, 14]);
    expect(nube.tienda_productos['2001'].orden_rubro).toBe(999999);
    // Y los que ya estaban conservan el suyo.
    expect(nube.tienda_productos['1001'].orden).toBe(10);
  });

  it('apagar el rubro saca sus productos de la tienda', async () => {
    await montar();
    tildar(casilla('PAPELERIA'), false);
    const dice = await guardar();

    expect(espia.confirmaciones[0].message).toContain('Salen: Papelería');
    expect(ultima('tienda_config', 'publicacion').campos.rubros).toEqual(['LIBRERIA']);
    expect(ultima('tienda_productos', '3001').op).toBe('borrar');
    expect(nube.tienda_productos['3001']).toBeUndefined();
    expect(dice).toBe('Guardado. 0 productos en la tienda, 1 afuera.');

    // Y la portada deja de ofrecer un filtro que no devuelve nada.
    const lista = ultima('tienda_config', 'rubros').campos.lista;
    expect(lista.map(r => r.clave)).toEqual(['LIBRERIA']);
  });

  it('el rubro apagado se lleva hasta lo marcado "Publicar siempre"', async () => {
    // La bengala está forzada desde su ficha. Se prende Cotillón, sale, se
    // vuelve a apagar y se tiene que ir igual: es el caso que en septiembre
    // dejó a la dueña destildando un rubro que seguía apareciendo en la tienda.
    await montar();
    tildar(casilla('COTILLON'), true);
    await guardar();
    expect(nube.tienda_productos['2002']).toBeTruthy();

    await montar();
    tildar(casilla('COTILLON'), false);
    await guardar();
    expect(ultima('tienda_productos', '2002').op).toBe('borrar');
    expect(nube.tienda_productos['2002']).toBeUndefined();
  });
});

/* ── Subrubros ────────────────────────────────────────────────────────────── */

describe('los subrubros destildados', () => {
  it('un subrubro destildado sale de la tienda y el resto del rubro se queda', async () => {
    await montar();
    tildar(casillaSub('LIBRERIA', 'ABROCHADORAS'), false);
    await guardar();

    expect(espia.confirmaciones[0].message).toContain('Subrubros sin publicar: Abrochadoras');
    expect(ultima('tienda_config', 'publicacion').campos.subrubros_excluidos)
      .toEqual({ LIBRERIA: ['ABROCHADORAS'] });

    expect(ultima('tienda_productos', '1002').op).toBe('borrar');
    expect(nube.tienda_productos['1002']).toBeUndefined();
    // El cuaderno sigue publicado y con su lugar de siempre.
    expect(nube.tienda_productos['1001'].orden).toBe(10);
    expect(nube.tienda_productos['1001'].orden_rubro).toBe(1);

    // El filtro de la portada tampoco lo ofrece más.
    const libreria = ultima('tienda_config', 'rubros').campos.lista
      .find(r => r.clave === 'LIBRERIA');
    expect(libreria.cantidad).toBe(1);
    expect(libreria.subrubros.map(s => s.clave)).toEqual(['CUADERNOS']);
  });

  it('destildar un subrubro de un rubro apagado no guarda nada', async () => {
    // Apagar Papelería esconde sus subrubros, pero las casillas siguen en la
    // pantalla. Guardar la exclusión de un rubro que no publica es ruido que
    // después nadie entiende al volver a prenderlo.
    await montar();
    tildar(casillaSub('PAPELERIA', 'RESMAS'), false);
    tildar(casilla('PAPELERIA'), false);
    await guardar();

    expect(ultima('tienda_config', 'publicacion').campos.subrubros_excluidos).toEqual({});
  });

  it('volver a tildar el subrubro lo devuelve a la tienda', async () => {
    nube.tienda_config.publicacion = {
      rubros: ['LIBRERIA', 'PAPELERIA'], subrubros_excluidos: { LIBRERIA: ['ABROCHADORAS'] },
    };
    delete nube.tienda_productos['1002'];

    await montar();
    const sub = casillaSub('LIBRERIA', 'ABROCHADORAS');
    expect(sub.checked).toBe(false);
    tildar(sub, true);
    await guardar();

    expect(ultima('tienda_config', 'publicacion').campos.subrubros_excluidos).toEqual({});
    expect(ultima('tienda_productos', '1002').op).toBe('escribir');
    expect(nube.tienda_productos['1002'].nombre).toBe('Abrochadora Maped');
  });
});

/* ── El cache compartido ──────────────────────────────────────────────────── */

describe('lo recién guardado queda sembrado donde lo va a buscar el resto del panel', () => {
  it('Tienda > Catálogo lee la lista nueva sin volver a la base', async () => {
    // La escritura va por REST: el SDK no se entera y nadie escucha ese
    // documento. Prender Cotillón y pasar derecho a cargarle fotos arrancaba
    // con la lista vieja, y cada foto que se subía borraba el producto del
    // espejo por "el rubro no está habilitado".
    await montar();
    tildar(casilla('COTILLON'), true);
    tildar(casillaSub('LIBRERIA', 'ABROCHADORAS'), false);
    await guardar();

    const { getCached, peekCacheValue } = await import('../../webapp/src/cache.js');
    expect(peekCacheValue('tienda:publicacion')).toEqual({
      rubros: expect.arrayContaining(['LIBRERIA', 'PAPELERIA', 'COTILLON']),
      subrubrosExcluidos: { LIBRERIA: ['ABROCHADORAS'] },
    });

    // Es la misma llave con la que entra el catálogo de la tienda: su lectura
    // se resuelve con lo sembrado y ni siquiera llama al fetcher.
    const fetcher = vi.fn(async () => ({ rubros: ['VIEJO'], subrubrosExcluidos: {} }));
    const leido = await getCached('tienda:publicacion', fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(leido.rubros).toContain('COTILLON');
  });

  it('el minuto de memoria del espejo se tira, así el guardado de una ficha no usa la lista vieja', async () => {
    const espejo = await import('../../webapp/src/tienda_espejo.js');
    // Alguien abrió una ficha antes de guardar: la lista quedó en memoria.
    expect((await espejo.leerPublicacion({})).rubros).toEqual(['LIBRERIA', 'PAPELERIA']);

    await montar();
    tildar(casilla('COTILLON'), true);
    await guardar();

    expect([...(await espejo.leerPublicacion({})).rubros].sort())
      .toEqual(['COTILLON', 'LIBRERIA', 'PAPELERIA']);
  });
});

/* ── Horarios ─────────────────────────────────────────────────────────────── */

describe('un horario mal cargado no escribe basura', () => {
  it('se guarda como siete mapas con sus tramos, nunca como arreglos anidados', async () => {
    // Un settings viejo, guardado con la forma que se usa en memoria. Firestore
    // no admite arreglos anidados: si esto volviera a salir así, la escritura
    // entera se rechaza y no se guarda nada, ni el alias ni el mínimo.
    nube.tienda_config.settings.horarios = [
      HABIL, HABIL, HABIL, HABIL, HABIL, [{ desde: '09:00', hasta: '13:00' }], [],
    ];
    await montar();
    await guardar();

    const horarios = ultima('tienda_config', 'settings').campos.horarios;
    expect(horarios).toHaveLength(7);
    for (const dia of horarios) {
      expect(Array.isArray(dia)).toBe(false);
      expect(Object.keys(dia)).toEqual(['tramos']);
      for (const tramo of dia.tramos) {
        expect(Object.keys(tramo).sort()).toEqual(['desde', 'hasta']);
        expect(typeof tramo.desde).toBe('string');
        expect(typeof tramo.hasta).toBe('string');
      }
    }
    // El domingo cerrado es un día sin tramos, no un día que falta.
    expect(horarios[6]).toEqual({ tramos: [] });
  });

  it('un día que se abre desde el interruptor copia el horario del lunes', async () => {
    await montar();
    contenedor.querySelector('[data-dia="6"] [data-dia-abrir]').click();
    await esperar();
    await guardar();

    const campos = ultima('tienda_config', 'settings').campos;
    expect(campos.horarios[6].tramos).toEqual(HABIL);
    expect(campos.horarios_texto).toContain('de 9 a 13 y de 17 a 20:30');
    expect(campos.horarios_texto).not.toContain('Domingo cerrado');
  });

  it('un tramo a medio cargar o dado vuelta no se lee como abierto', async () => {
    await montar();

    // El martes queda con las dos puntas al revés (termina antes de empezar) y
    // al sábado le falta la hora de cierre. La tienda decide con esta
    // estructura si toma pedidos: un tramo así no puede quedar como abierto.
    tipear(tramoDelDia(1, 0, 'hasta'), '08:00');
    tipear(tramoDelDia(1, 1, 'hasta'), '16:00');
    tipear(tramoDelDia(5, 0, 'hasta'), '');
    await guardar();

    const campos = ultima('tienda_config', 'settings').campos;
    expect(campos.horarios_texto).toContain('Martes cerrado');
    expect(campos.horarios_texto).toContain('Sábado a domingo cerrado');
    expect(campos.horarios_texto).not.toMatch(/de 9 a 8|de 17 a 16|NaN|undefined|null/);
    // Y lo que se guarda sigue siendo texto, no huecos: la punta vacía es una
    // cadena vacía y no desaparece del mapa.
    expect(campos.horarios[5].tramos[0]).toEqual({ desde: '09:00', hasta: '' });
  });

  it('el texto que se muestra sale de la estructura, no de lo que había escrito', async () => {
    // Los dos vivían separados y podían contradecirse: el cartel decía "hasta
    // las 20:30" con la grilla cargada hasta las 13.
    nube.tienda_config.settings.horarios_texto = 'Todos los días de 8 a 22';
    await montar();
    await guardar();

    const campos = ultima('tienda_config', 'settings').campos;
    expect(campos.horarios_texto).not.toContain('de 8 a 22');
    expect(campos.horarios_texto)
      .toBe('Lunes a viernes de 9 a 13 y de 17 a 20:30 · Sábado de 9 a 13 · Domingo cerrado');
  });
});

/* ── Cuando se dice que no ────────────────────────────────────────────────── */

describe('cancelar el aviso', () => {
  it('deja todo como estaba, sin escribir una sola cosa', async () => {
    espia.confirmar = false;
    await montar();
    tipear(document.getElementById('cfgAlias'), 'libreria.liceo.mp');
    tildar(casilla('COTILLON'), true);
    await guardar();

    // "Cancelar" es cancelar el guardado entero, no solo la parte de los
    // rubros: la pantalla queda igual y la base sin tocar.
    expect(registro).toHaveLength(0);
    expect(nube.tienda_config.publicacion.rubros).toEqual(['LIBRERIA', 'PAPELERIA']);
    expect(nube.tienda_config.settings.pago.alias).toBeNull();
    expect(document.getElementById('cfgEstado').textContent).toBe('');
  });
});
