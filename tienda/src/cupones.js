/**
 * Cupones de la tienda: las reglas, sin importar nada.
 *
 * Están acá, sueltas, porque las usan tres lados: el checkout para mostrar la
 * vista previa y los mensajes, la función del servidor para decidir cuánto se
 * descuenta de verdad, y el panel para la vista previa al armar el cupón y las
 * estadísticas de uso. Si vivieran en uno solo, los otros dos tendrían su
 * copia y el día que cambie una regla cobrarían distinto.
 *
 * Un cupón dice cuánto saca (un porcentaje con tope, un monto fijo o el envío),
 * sobre qué cae (todo, algunos productos o algunos rubros), desde cuánto de
 * compra vale, cuántas veces lo puede usar una persona y cuántas en total,
 * entre qué fechas, y si es solo para la primera compra o para una forma de
 * entrega.
 *
 * El cliente nunca decide el descuento: manda el código y el servidor hace la
 * cuenta con esto mismo. Lo que ve en el checkout sale de la misma función,
 * corrida en el servidor con los precios de la base.
 *
 * Nada de acá toca Firebase ni el DOM.
 */

export const TIPOS = ['porcentaje', 'monto', 'envio_gratis'];
export const ALCANCES = ['todo', 'productos', 'rubros'];
export const ENTREGAS = ['cualquiera', 'retiro', 'delivery'];

const LARGO_MIN = 4;
const LARGO_MAX = 20;

/* ── El código ────────────────────────────────────────────────────────────── */

/**
 * "  bienvenida 10 " → "BIENVENIDA10". Mayúsculas, sin tildes, sin espacios:
 * el código se dicta y se tipea desde un celular, y "Bienvenida-10" y
 * "BIENVENIDA 10" tienen que ser el mismo.
 */
export function normalizarCodigo(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

/** Entre 4 y 20 letras o números, con guiones en el medio si se quiere. */
export function codigoValido(codigo) {
  return typeof codigo === 'string'
    && codigo.length >= LARGO_MIN && codigo.length <= LARGO_MAX
    && /^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$/.test(codigo);
}

/**
 * Un código nuevo, para el botón "Generar" del panel: seis letras y números
 * sin los que se confunden al dictarlos (I, O, 0, 1), con un prefijo opcional
 * ("LICEO-K7M2PX").
 */
export function generarCodigo(prefijo = '', largo = 6, azar = Math.random) {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let cuerpo = '';
  for (let i = 0; i < largo; i++) cuerpo += alfabeto[Math.floor(azar() * alfabeto.length) % alfabeto.length];
  const base = normalizarCodigo(prefijo).replace(/-+$/, '');
  return base ? `${base}-${cuerpo}` : cuerpo;
}

/* ── Quién es la persona ──────────────────────────────────────────────────── */

/**
 * La clave con la que se cuenta "una vez por persona": los diez dígitos del
 * teléfono, sin el prefijo de país, el 9 de celular, el 0 de larga distancia
 * ni el 15 viejo. "+54 9 351 704-6684", "0351 15 704 6684" y "3517046684" son
 * la misma persona.
 *
 * No es infalible —quien cambia de número es otra persona para esto— pero es
 * el dato que el local usa para llamar, y lo tiene siempre.
 */
export function telefonoClave(texto) {
  let d = String(texto ?? '').replace(/\D/g, '');
  if (d.length > 10 && d.startsWith('54')) d = d.slice(2);
  if (d.length > 10 && d.startsWith('9')) d = d.slice(1);
  if (d.length > 10 && d.startsWith('0')) d = d.slice(1);
  // El 15 va después del código de área, que tiene entre 2 y 4 dígitos.
  if (d.length === 12) {
    for (const corte of [2, 3, 4]) {
      if (d.slice(corte, corte + 2) === '15') { d = d.slice(0, corte) + d.slice(corte + 2); break; }
    }
  }
  return d.length > 10 ? d.slice(-10) : d;
}

/* ── Sobre qué cae ────────────────────────────────────────────────────────── */

/** "Librería" y "LIBRERIA" son el mismo rubro. */
export function claveDeRubro(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toUpperCase();
}

/** Si un renglón del pedido entra en el cupón. */
export function aplicaA(cupon, renglon) {
  const aplica = cupon?.aplica || {};
  const modo = aplica.modo || 'todo';
  if (modo === 'todo') return true;
  if (modo === 'productos') {
    return (aplica.productos || []).map(String).includes(String(renglon?.id ?? ''));
  }
  if (modo === 'rubros') {
    const rubros = (aplica.rubros || []).map(claveDeRubro);
    return rubros.includes(claveDeRubro(renglon?.rubro));
  }
  return false;
}

/**
 * Cómo se le dice al cliente sobre qué cae: "Librería", "Librería y Papelería",
 * o la etiqueta que el panel guardó al elegir productos ("Resma Pampa A4",
 * "3 productos").
 */
export function describirAlcance(cupon) {
  const aplica = cupon?.aplica || {};
  if (aplica.etiqueta) return String(aplica.etiqueta);
  if (aplica.modo === 'rubros') {
    const nombres = (aplica.rubros || []).map(bonito);
    if (nombres.length <= 2) return nombres.join(' y ');
    return `${nombres.slice(0, -1).join(', ')} y ${nombres.at(-1)}`;
  }
  if (aplica.modo === 'productos') {
    const n = (aplica.productos || []).length;
    return n === 1 ? 'un producto puntual' : `${n} productos`;
  }
  return 'todo el pedido';
}

function bonito(texto) {
  const t = String(texto ?? '').trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/* ── Fechas ───────────────────────────────────────────────────────────────── */

/**
 * "2026-09-10" → el instante en que empieza (o termina) ese día en Argentina.
 * El panel guarda solo la fecha; un cupón "hasta el 10" vale el 10 entero.
 */
export function limiteDeDia(fecha, fin = false) {
  const texto = String(fecha ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return null;
  const d = new Date(`${texto}T${fin ? '23:59:59.999' : '00:00:00.000'}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ── La cuenta ────────────────────────────────────────────────────────────── */

const falla = (motivo, extra = {}) => ({ ok: false, motivo, ...extra });

function suma(renglones) {
  return renglones.reduce((t, r) => t + subtotalDe(r), 0);
}

function subtotalDe(r) {
  const propio = Number(r?.subtotal);
  if (Number.isFinite(propio)) return propio;
  return Math.round((Number(r?.precio) || 0) * (Number(r?.cantidad) || 0));
}

/**
 * Si el cupón vale para este pedido y cuánto saca.
 *
 * @param {object|null} cupon   el documento del cupón, o null si no existe
 * @param {object} pedido
 *   renglones        [{id, rubro, precio, cantidad, subtotal, variedad, es_pack}]
 *   envio            lo que sale el envío (0 con retiro o a confirmar)
 *   modo             'retiro' | 'delivery'
 *   ahora            Date
 *   usosPersona      cuántas veces lo usó ya esta persona (pedidos no cancelados)
 *   usosTotales      cuántas veces se usó en total
 *   esPrimeraCompra  true / false, o null si no se sabe
 * @returns {{ok: true, descuento, envio_gratis, aplicable, renglones} |
 *           {ok: false, motivo, falta?, minimo?, veces?, alcance?, desde?}}
 */
export function evaluarCupon(cupon, {
  renglones = [], envio = 0, modo = 'retiro', ahora = new Date(),
  usosPersona = 0, usosTotales = 0, esPrimeraCompra = null,
} = {}) {
  if (!cupon || typeof cupon !== 'object') return falla('no_existe');
  if (cupon.activo === false) return falla('inactivo');

  const desde = limiteDeDia(cupon.desde);
  const hasta = limiteDeDia(cupon.hasta, true);
  if (desde && ahora < desde) return falla('todavia_no', { desde: cupon.desde });
  if (hasta && ahora > hasta) return falla('vencido');

  const totales = Number(cupon.usos_totales) || 0;
  if (totales > 0 && usosTotales >= totales) return falla('agotado');

  const porPersona = Number(cupon.usos_por_persona) || 0;
  if (porPersona > 0 && usosPersona >= porPersona) return falla('ya_usado', { veces: porPersona });

  if (cupon.solo_primera_compra === true && esPrimeraCompra === false) return falla('primera_compra');

  const entrega = cupon.entrega || 'cualquiera';
  if (entrega === 'retiro' && modo !== 'retiro') return falla('solo_retiro');
  if ((entrega === 'delivery' || cupon.tipo === 'envio_gratis') && modo !== 'delivery') {
    return falla('solo_delivery');
  }

  const subtotal = suma(renglones);
  const minimo = Number(cupon.minimo_compra) || 0;
  if (minimo > 0 && subtotal < minimo) return falla('minimo', { falta: minimo - subtotal, minimo });

  if (cupon.tipo === 'envio_gratis') {
    // Con el envío a confirmar el número es cero acá, pero el pedido queda
    // marcado y el local no lo cobra al prepararlo.
    return { ok: true, descuento: Math.max(0, Math.round(Number(envio) || 0)), envio_gratis: true, aplicable: 0, renglones: [] };
  }

  const elegibles = renglones.filter(r => aplicaA(cupon, r));
  const aplicable = suma(elegibles);
  if (!elegibles.length || aplicable <= 0) {
    return falla('sin_productos', { alcance: describirAlcance(cupon) });
  }

  const valor = Number(cupon.valor) || 0;
  let descuento = cupon.tipo === 'monto'
    ? Math.round(valor)
    : Math.round(aplicable * Math.min(Math.max(valor, 0), 100) / 100);
  const tope = Number(cupon.tope) || 0;
  if (cupon.tipo === 'porcentaje' && tope > 0) descuento = Math.min(descuento, tope);
  // Nunca más que lo que cuesta lo elegible: un cupón de $5.000 sobre un
  // lápiz de $800 descuenta $800, y el resto no se transforma en saldo.
  descuento = Math.min(descuento, aplicable);
  if (descuento <= 0) return falla('sin_productos', { alcance: describirAlcance(cupon) });

  return {
    ok: true,
    descuento,
    envio_gratis: false,
    aplicable,
    renglones: repartir(elegibles, descuento),
  };
}

/**
 * El descuento repartido entre los renglones, proporcional a lo que pesa cada
 * uno, con el resto del redondeo en el último: la suma de las líneas da
 * exactamente el descuento y la venta cierra al peso. Misma regla que el
 * descuento con nombre del POS.
 */
export function repartir(renglones, descuento) {
  const total = suma(renglones);
  if (!renglones.length || total <= 0 || descuento <= 0) return [];
  let repartido = 0;
  return renglones.map((r, i) => {
    const ultimo = i === renglones.length - 1;
    const parte = ultimo ? descuento - repartido : Math.floor(descuento * subtotalDe(r) / total);
    repartido += parte;
    return {
      id: String(r.id ?? ''),
      variedad: r.variedad ?? null,
      es_pack: r.es_pack === true,
      descuento: parte,
    };
  });
}

/* ── Lo que se le dice al cliente ─────────────────────────────────────────── */

const PESOS = new Intl.NumberFormat('es-AR', {
  style: 'currency', currency: 'ARS', maximumFractionDigits: 0,
});
const pesos = n => PESOS.format(Math.round(Number(n) || 0)).replace(/\s/g, '');

/** "2026-09-10" → "10/9". */
function fechaCorta(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(texto ?? ''));
  return m ? `${Number(m[3])}/${Number(m[2])}` : String(texto ?? '');
}

/**
 * Por qué no entró, dicho para el cliente. Sale de acá para que la tienda y el
 * servidor digan lo mismo: la función manda el motivo, no el texto.
 */
export function mensajeDeCupon(resultado) {
  const r = resultado || {};
  switch (r.motivo) {
    case 'no_existe':      return 'No encontramos ese cupón. Fijate que esté bien escrito.';
    case 'inactivo':
    case 'vencido':        return 'Ese cupón ya no está vigente.';
    case 'todavia_no':     return `Ese cupón vale a partir del ${fechaCorta(r.desde)}.`;
    case 'agotado':        return 'Ese cupón ya se usó todas las veces que se podía.';
    // Sin el número (o con uno que no es tal) se dice sin él: "ya lo usaste
    // null veces" es lo que se leía cuando el servidor no lo mandaba.
    case 'ya_usado':       return Number(r.veces) === 1
      ? 'Ese cupón ya lo usaste, y vale una sola vez por persona.'
      : Number(r.veces) > 1
        ? `Ese cupón ya lo usaste ${Number(r.veces)} veces, que es el máximo por persona.`
        : 'Ese cupón ya lo usaste todas las veces que se podía por persona.';
    case 'primera_compra': return 'Ese cupón es solo para la primera compra.';
    case 'minimo':         return `Te faltan ${pesos(r.falta)} para usar este cupón: vale con compras desde ${pesos(r.minimo)}.`;
    case 'sin_productos':  return `Ese cupón es solo para ${r.alcance || 'algunos productos'} y no tenés nada de eso en el pedido.`;
    case 'solo_retiro':    return 'Ese cupón vale solo retirando por el local.';
    case 'solo_delivery':  return 'Ese cupón vale solo para envíos a domicilio.';
    default:               return 'No pudimos aplicar el cupón. Probá de nuevo.';
  }
}

/** "10% de descuento", "$5.000 de descuento", "Envío sin cargo". */
export function describirCupon(cupon) {
  if (!cupon) return '';
  if (cupon.tipo === 'envio_gratis') return 'Envío sin cargo';
  if (cupon.tipo === 'monto') return `${pesos(cupon.valor)} de descuento`;
  const tope = Number(cupon.tope) || 0;
  return `${Number(cupon.valor) || 0}% de descuento${tope > 0 ? ` (hasta ${pesos(tope)})` : ''}`;
}

/* ── Estadísticas, para el panel ──────────────────────────────────────────── */

const ESTADOS_QUE_CUENTAN = new Set(['nuevo', 'preparando', 'listo', 'en_camino', 'entregado']);

/** Un pedido cancelado no gastó el cupón. */
export function pedidoCuenta(pedido) {
  return ESTADOS_QUE_CUENTAN.has(String(pedido?.estado ?? ''));
}

/** La clave de persona de un pedido: el teléfono, y la cuenta si la hay. */
export function personaDe(pedido) {
  return {
    telefono: telefonoClave(pedido?.cliente?.telefono),
    uid: pedido?.uid ? String(pedido.uid) : null,
  };
}

/**
 * Cuántas veces usó el cupón esta persona, mirando los pedidos que lo llevan.
 * Cuenta por teléfono o por cuenta: cualquiera de los dos que coincida.
 */
export function usosDePersona(pedidos, { telefono, uid }) {
  const tel = telefonoClave(telefono);
  return pedidos.filter(p => {
    if (!pedidoCuenta(p)) return false;
    const persona = personaDe(p);
    return (tel && persona.telefono === tel) || (uid && persona.uid === uid);
  }).length;
}

/**
 * El resumen de un cupón para el panel: cuántos pedidos, cuántas personas
 * distintas, cuánta plata se descontó y en qué productos cayó.
 */
export function resumenDeUsos(pedidos, codigo) {
  const propios = pedidos.filter(p => p?.cupon?.codigo === codigo);
  const validos = propios.filter(pedidoCuenta);
  const personas = new Set();
  const productos = new Map();
  let descontado = 0;
  let vendido = 0;

  for (const p of validos) {
    const persona = personaDe(p);
    personas.add(persona.uid || persona.telefono || p.id);
    descontado += Number(p.cupon?.descuento) || 0;
    vendido += Number(p.total) || 0;
    const porRenglon = new Map((p.cupon?.renglones || []).map(r => [`${r.id}|${r.variedad || ''}|${r.es_pack ? 'p' : 's'}`, Number(r.descuento) || 0]));
    for (const it of p.items || []) {
      const clave = String(it.id ?? '');
      if (!clave) continue;
      const acumulado = productos.get(clave) || { id: clave, nombre: it.nombre || clave, pedidos: 0, cantidad: 0, descuento: 0 };
      acumulado.pedidos += 1;
      acumulado.cantidad += Number(it.cantidad) || 0;
      acumulado.descuento += porRenglon.get(`${it.id}|${it.variedad || ''}|${it.es_pack ? 'p' : 's'}`) || 0;
      productos.set(clave, acumulado);
    }
  }

  return {
    usos: validos.length,
    cancelados: propios.length - validos.length,
    personas: personas.size,
    descontado,
    vendido,
    productos: [...productos.values()].sort((a, b) => b.pedidos - a.pedidos || b.cantidad - a.cantidad),
    pedidos: validos,
  };
}
