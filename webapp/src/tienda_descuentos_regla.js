/**
 * Los descuentos de la tienda: la regla, sin Firebase.
 *
 * Un descuento de `tienda_descuentos` dice sobre qué cae —un rubro entero, un
 * subrubro o un artículo— y cuánto saca. Esto decide cuáles están vigentes,
 * cuál le toca a cada producto y con qué precio queda en el espejo.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ IMPORTANTE — esto es un gemelo de `descuentos_vigentes()`,               │
 * │ `descuento_para()` y `aplicar_descuento()` en scripts/sync_tienda.py.    │
 * │ Lo usan el panel (cada vez que espeja un producto o toca un descuento)  │
 * │ y el sync (en cada corrida). Si los dos no dan EXACTAMENTE lo mismo, el │
 * │ precio de la vidriera cambia solo cada seis horas: el panel pone uno y  │
 * │ el sync lo pisa con otro. tienda/pruebas/descuentos_regla.test.js corre │
 * │ las dos sobre los mismos casos.                                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Lo que el espejo guarda y la tienda lee tal cual:
 *
 *   precio            lo que paga el cliente
 *   precio_anterior   el de lista, tachado en la card (null sin descuento)
 *   precio_pack       el rollo o la caja entera, con la misma rebaja
 *   descuento         {id, nombre, porcentaje} para la cinta "−20%"
 *   variedades[].precio  el precio propio de cada color, con la misma rebaja
 *
 * `precio_pack_anterior` (y `precio_anterior` dentro de cada variedad) es el
 * precio de lista. La tienda no los mira: están para que el panel pueda rehacer
 * la cuenta desde el precio de lista cuando un descuento se apaga o cambia, sin
 * releer el catálogo.
 */

const ORDEN_ALCANCE = { rubro: 0, subrubro: 1, producto: 2 };

// Más que esto no es un descuento, es un error de tipeo.
const TOPE_PORCENTAJE = 90;

/**
 * Clave con la que se compara un rubro, un subrubro o un id de producto: sin
 * tildes, sin mayúsculas, sin espacios de sobra. Es `normalizar()` de
 * tienda_espejo.js (y de sync_tienda.py) con los espacios interiores
 * colapsados; repetida acá para que este módulo no dependa de nada.
 *
 * El objetivo de un descuento se guarda desde el catálogo crudo
 * ("LIBRERÍA|BOLIGRAFO") y el espejo publica el subrubro bonito ("Bolígrafo"):
 * comparados tal cual no coincidían nunca, y el descuento no le tocaba el
 * precio a nadie.
 */
export function claveDeObjetivo(texto) {
  return String(texto ?? '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

// Las fechas llegan de tres formas: Date (o Timestamp del SDK) por el SDK,
// texto ISO por la REST, y nada.
function fecha(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v && typeof v.toDate === 'function') return fecha(v.toDate());
  if (typeof v === 'string' || typeof v === 'number') return fecha(new Date(v));
  return null;
}

function numero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Los descuentos que rigen ahora, del más general al más puntual.
 *
 * @param {Array<{id: string, datos: object}>} docs  los de `tienda_descuentos`
 * @param {Date} [ahora]
 */
export function descuentosVigentes(docs, ahora = new Date()) {
  const vigentes = [];
  for (const { id, datos } of docs || []) {
    const x = datos || {};
    if (x.activo === false) continue;
    const desde = fecha(x.desde);
    const hasta = fecha(x.hasta);
    if (desde && ahora < desde) continue;
    if (hasta && ahora > hasta) continue;
    const valor = numero(x.valor);
    if (valor <= 0) continue;
    vigentes.push({
      id: String(id),
      nombre: String(x.nombre || 'Descuento'),
      tipo: String(x.tipo) === 'monto' ? 'monto' : 'porcentaje',
      valor,
      alcance: String(x.alcance || 'rubro'),
      objetivo: claveDeObjetivo(x.objetivo),
      redondear: x.redondear === true,
    });
  }
  // El más específico manda: si hay uno del rubro y otro del artículo, gana el
  // del artículo. Empatados en alcance decide el id, para que el panel y el
  // sync elijan el mismo aunque lean la colección en otro orden.
  vigentes.sort((a, b) =>
    (ORDEN_ALCANCE[a.alcance] ?? 0) - (ORDEN_ALCANCE[b.alcance] ?? 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return vigentes;
}

/**
 * Cuál de los descuentos le toca a este producto, si le toca alguno. Se
 * recorren de general a puntual y se queda el último que coincide.
 *
 * @param {string} docId
 * @param {{rubro?: string, sub_rubro?: string}} doc  el documento del espejo
 *        (o el del catálogo: se miran los mismos dos campos)
 * @param {ReturnType<typeof descuentosVigentes>} descuentos
 */
export function descuentoPara(docId, doc, descuentos) {
  const rubro = claveDeObjetivo(doc?.rubro);
  const sub = claveDeObjetivo(doc?.sub_rubro);
  const id = claveDeObjetivo(docId);
  let elegido = null;
  for (const d of descuentos || []) {
    if (!d.objetivo) continue;
    if (d.alcance === 'rubro' && d.objetivo === rubro) elegido = d;
    else if (d.alcance === 'subrubro' && d.objetivo === `${rubro}|${sub}`) elegido = d;
    else if (d.alcance === 'producto' && d.objetivo === id) elegido = d;
  }
  return elegido;
}

/**
 * A la centena más cercana, con caída a decena cuando el monto es chico. Es
 * la regla con la que se manejan los precios del local: un 20% que deja
 * $6.327 desentona al lado del resto.
 *
 * floor(x + 0.5) y no Math.round(): es la única forma de redondear que Python
 * y JavaScript escriben igual (ver `aplicarDescuento`).
 */
export function redondearCentena(v) {
  const n = numero(v);
  if (n <= 0) return 0;
  const r100 = Math.floor(n / 100 + 0.5) * 100;
  if (r100 > 0) return r100;
  const r10 = Math.floor(n / 10 + 0.5) * 10;
  return r10 > 0 ? r10 : Math.floor(n + 0.5);
}

/**
 * El precio de lista de una variedad: el que tenía antes de la rebaja cuando ya
 * está rebajada, y si no el que trae. Cero cuando no tiene precio propio: esa
 * variedad paga el del producto y no hay nada que reescalar.
 */
function listaDeVariedad(v) {
  return numero(v.precio_anterior) || numero(v.precio) || 0;
}

/**
 * Las variedades siguen la misma rebaja que el producto.
 *
 * Cada color puede tener precio propio (`variedades[].precio`, que sale del
 * catálogo) y la tienda le cobra ESE precio al que elige el color: lo prefiere
 * `precioDeRenglon` en tienda/src/precios.js y lo mismo hace el servidor al
 * armar el pedido. Dejarlas a precio de lista mostraba la cinta "−20%" y el
 * tachado en la card, y al tocar el color el precio SUBÍA al de lista, que era
 * además lo que terminaba cobrando `crear-pedido`.
 *
 * Se reescala por la proporción del producto (nuevo/lista) y no aplicando el
 * descuento otra vez: con un monto fijo, un color más barato que el monto
 * quedaría en cero o con otro porcentaje que el anunciado en la cinta.
 *
 * `precio_anterior` dentro de la variedad guarda el de lista, igual que el del
 * producto: es lo que deja rehacer la cuenta cuando el descuento cambia o se
 * apaga, sin releer el catálogo.
 */
function variedadesConRebaja(doc, nuevo, lista) {
  if (!Array.isArray(doc.variedades) || !doc.variedades.length) return;
  doc.variedades = doc.variedades.map((v) => {
    if (!v || typeof v !== 'object') return v;
    const listaV = listaDeVariedad(v);
    if (listaV <= 0) return v;
    return {
      ...v,
      precio: Math.max(1, Math.floor(listaV * nuevo / lista + 0.5)),
      precio_anterior: listaV,
    };
  });
}

/** Las variedades de vuelta a precio de lista, sin rastro de la rebaja. */
function variedadesALista(doc) {
  if (!Array.isArray(doc.variedades) || !doc.variedades.length) return;
  doc.variedades = doc.variedades.map((v) => {
    if (!v || typeof v !== 'object') return v;
    const listaV = listaDeVariedad(v);
    if (listaV <= 0) return v;
    const { precio_anterior: _sinUso, ...resto } = v;
    return { ...resto, precio: listaV };
  });
}

/**
 * Deja en el documento del espejo el precio con el descuento que le toca.
 *
 * La cuenta SIEMPRE parte del precio de lista: `precio_anterior` si ya hay un
 * descuento puesto, y si no `precio`. Si se recalculara sobre el precio ya
 * rebajado, cada pasada descontaría de nuevo sobre lo descontado y el precio
 * se derrumbaría solo. Por eso mismo aplicar dos veces da el mismo número, y
 * con la lista vacía deja el producto a precio de lista.
 *
 * Un monto fijo que se come el precio entero no es una oferta: ese producto
 * queda a precio de lista y sin descuento. Antes quedaba a $1, y un precio en
 * un peso se lee como error, no como rebaja, y deja pasar pedidos que no se
 * pueden cobrar.
 *
 * floor(x + 0.5) y no Math.round(): round() de Python redondea al par
 * (12,5 → 12) y Math.round() de JavaScript para arriba (12,5 → 13). Si el
 * panel y el sync no redondean igual, el precio se mueve un peso solo, en cada
 * corrida, para siempre.
 *
 * @returns el mismo `doc`, modificado
 */
export function aplicarDescuento(docId, doc, descuentos) {
  const lista = numero(doc.precio_anterior) || numero(doc.precio) || 0;
  const packLista = numero(doc.precio_pack_anterior) || numero(doc.precio_pack) || 0;

  const sinRebaja = () => {
    if (lista > 0) doc.precio = lista;
    doc.precio_anterior = null;
    if (packLista > 0) doc.precio_pack = packLista;
    doc.precio_pack_anterior = null;
    doc.descuento = null;
    variedadesALista(doc);
    return doc;
  };

  const d = descuentoPara(docId, doc, descuentos);
  if (!d || lista <= 0) return sinRebaja();

  let nuevo = d.tipo === 'porcentaje'
    ? lista * (1 - Math.min(d.valor, TOPE_PORCENTAJE) / 100)
    : lista - d.valor;
  if (d.redondear) {
    // Redondear a la centena puede EMPUJAR el precio para arriba: 70 se va a
    // 100. En un producto barato eso anulaba el descuento entero (el precio
    // "rebajado" quedaba arriba del de lista). Solo si sigue siendo más barato.
    const r = redondearCentena(nuevo);
    if (r > 0 && r < lista) nuevo = r;
  }
  nuevo = Math.floor(nuevo + 0.5);
  if (nuevo <= 0 || nuevo >= lista) return sinRebaja();

  doc.precio = nuevo;
  doc.precio_anterior = lista;
  doc.descuento = {
    id: d.id,
    nombre: d.nombre,
    porcentaje: Math.floor((1 - nuevo / lista) * 100 + 0.5),
  };
  // El pack sigue la misma rebaja: si no, llevarse el rollo entero saldría más
  // caro por unidad que comprar suelto y el cliente lo nota.
  if (packLista > 0) {
    doc.precio_pack_anterior = packLista;
    doc.precio_pack = Math.max(1, Math.floor(packLista * nuevo / lista + 0.5));
  } else {
    doc.precio_pack_anterior = null;
  }
  variedadesConRebaja(doc, nuevo, lista);
  return doc;
}

/* ── Rehacer el espejo desde el panel ──────────────────────────────────────
 * Esto no tiene gemelo en Python: el sync arma cada documento de cero desde
 * el catálogo. El panel, en cambio, trabaja sobre lo que YA está publicado.
 */

// `variedades` está en la lista porque el precio propio de cada color también
// lleva la rebaja: sin esto, tocar un descuento dejaba los colores a precio de
// lista abajo de la cinta que anuncia la oferta.
const CAMPOS_DE_PRECIO = ['precio', 'precio_anterior', 'precio_pack',
                          'precio_pack_anterior', 'descuento', 'variedades'];

/**
 * Dos variedades iguales. Se comparan todos los campos y no solo el precio:
 * el arreglo se escribe entero, así que si algo más cambió hay que escribirlo.
 * `null` y el campo ausente son lo mismo (al volver a precio de lista se saca
 * `precio_anterior`, que en el espejo viejo podía estar en null).
 */
function mismaVariedad(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b;
  for (const clave of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[clave];
    const y = b[clave];
    if (x == null || y == null) {
      if ((x == null) !== (y == null)) return false;
    } else if (typeof x === 'number' || typeof y === 'number') {
      if (numero(x) !== numero(y)) return false;
    } else if (String(x) !== String(y)) {
      return false;
    }
  }
  return true;
}

function mismoValor(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => mismaVariedad(v, b[i]));
  }
  if (a && typeof a === 'object') {
    return !!b && typeof b === 'object' && String(a.id) === String(b.id)
      && String(a.nombre) === String(b.nombre) && numero(a.porcentaje) === numero(b.porcentaje);
  }
  if (b && typeof b === 'object') return false;
  if (a == null || b == null) return (a == null) === (b == null);
  return numero(a) === numero(b);
}

/**
 * Qué hay que escribir en cada documento del espejo para que quede con los
 * descuentos vigentes. Devuelve solo los que cambian, y de cada uno solo los
 * campos que cambian: un rubro son cientos de productos y la mayoría no se
 * mueve al tocar un descuento de otro subrubro.
 *
 * @param {Array<{id: string, datos: object}>} docs  documentos del espejo
 * @returns {Array<{id: string, datos: object}>}
 */
export function recalcularEspejo(docs, descuentos) {
  const salida = [];
  for (const { id, datos } of docs || []) {
    const antes = datos || {};
    const base = { ...antes };
    // Espejos escritos antes de que existiera `precio_pack_anterior`: el pack
    // ya está rebajado y no quedó el de lista. Se deshace la proporción para
    // no rebajar dos veces lo mismo (ni dejarlo rebajado al apagar).
    if (antes.precio_pack_anterior === undefined && numero(antes.precio_anterior) > 0
        && numero(antes.precio) > 0 && numero(antes.precio_pack) > 0) {
      base.precio_pack_anterior = Math.floor(
        numero(antes.precio_pack) * numero(antes.precio_anterior) / numero(antes.precio) + 0.5);
    }
    const despues = aplicarDescuento(id, base, descuentos);
    const cambios = {};
    for (const campo of CAMPOS_DE_PRECIO) {
      if (!mismoValor(antes[campo], despues[campo])) cambios[campo] = despues[campo];
    }
    if (Object.keys(cambios).length) salida.push({ id, datos: cambios });
  }
  return salida;
}
