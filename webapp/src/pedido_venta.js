/**
 * Un pedido de la tienda que se entrega es una venta: sale del stock y entra
 * en las ventas, igual que si lo hubieran cobrado en el mostrador.
 *
 * Sin DOM ni Firebase: recibe el pedido y los documentos del catálogo, devuelve
 * qué escribir. Lo prueba `tienda/pruebas/pedido_venta.test.js`; quien escribe
 * es `pages/pedidos_tienda.js`, adentro de una transacción.
 *
 * Cómo cuenta:
 *   · un renglón "pack" descuenta cantidad × contenido del pack; uno suelto,
 *     la cantidad (unidades o metros, según venda el producto).
 *   · un conjunto se descuenta del total y se vuelve a repartir en packs
 *     cerrados + sueltos (misma regla que el POS, `descontarDeTotal`).
 *   · una variedad se busca por su nombre de la tienda: el del catálogo
 *     normalizado, o el nombre público que le puso el panel en
 *     `tienda_variedades`.
 *   · el stock puede quedar negativo, como en el POS: se vendió igual y el
 *     número dice cuánto falta reponer.
 */
import { descontarDeTotal, contenidoDe, totalVariedad, totalConjunto, num } from './conjunto.js';

export const PC_TIENDA = 'TIENDA';

export function normalizarNombre(texto) {
  return String(texto ?? '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

/** Cuántas unidades base del producto se lleva el renglón. */
export function unidadesBase(item) {
  const cantidad = num(item?.cantidad);
  if (item?.es_pack) return cantidad * Math.max(1, num(item.pack_contenido) || 1);
  return cantidad;
}

/** La variedad del catálogo que corresponde al nombre con que se vendió. */
export function variedadDelCatalogo(datos, nombreVendido) {
  const buscado = normalizarNombre(nombreVendido);
  if (!buscado) return null;
  const colores = Array.isArray(datos?.conjunto_colores) ? datos.conjunto_colores : [];
  const directa = colores.find(c => c && normalizarNombre(c.color) === buscado);
  if (directa) return directa;
  // El panel pudo haberle puesto otro nombre público: tienda_variedades guarda
  // {clave normalizada del catálogo: {nombre: 'el público'}}.
  const ajustes = datos?.tienda_variedades && typeof datos.tienda_variedades === 'object' ? datos.tienda_variedades : {};
  for (const [clave, ajuste] of Object.entries(ajustes)) {
    if (normalizarNombre(ajuste?.nombre) === buscado) {
      const porClave = colores.find(c => c && normalizarNombre(c.color) === normalizarNombre(clave));
      if (porClave) return porClave;
    }
  }
  return null;
}

function esConjunto(datos) {
  return datos?.es_conjunto === true || datos?.es_conjunto === 1;
}
function esServicio(datos) {
  return datos?.stock_ilimitado === true || datos?.stock_ilimitado === 1;
}

/**
 * Qué le pasa al stock de cada producto del pedido.
 *   items:         los renglones del pedido
 *   catalogoPorId: id → documento del catálogo (o null si no existe)
 * Devuelve { productos: [{ id, nombre, campos, movimientos, saltado }], saltados }
 *   campos:      lo que hay que escribir en el doc del catálogo
 *   movimientos: [{ antes, despues, cantidad, detalle }] para el historial
 */
export function planDescuento(items, catalogoPorId) {
  const trabajo = new Map();   // id → estado que se va actualizando
  const saltados = [];

  const get = (id) => {
    if (!trabajo.has(id)) {
      const base = catalogoPorId?.[id];
      trabajo.set(id, {
        id,
        nombre: String(base?.nombre || ''),
        datos: base ? { ...base } : null,
        campos: {},
        movimientos: [],
        saltado: null,
      });
    }
    return trabajo.get(id);
  };

  (items || []).forEach((item, idx) => {
    const id = String(item?.id || '').trim();
    if (!id) { saltados.push({ idx, motivo: 'renglón sin producto' }); return; }
    const p = get(id);
    const base = unidadesBase(item);
    if (!p.datos) { p.saltado = 'no está en el catálogo'; saltados.push({ idx, id, motivo: p.saltado }); return; }
    if (esServicio(p.datos)) { p.saltado = 'servicio sin stock'; saltados.push({ idx, id, motivo: p.saltado }); return; }
    if (!(base > 0)) { saltados.push({ idx, id, motivo: 'cantidad en cero' }); return; }
    if (!p.nombre) p.nombre = String(item.nombre || '');

    const d = p.datos;
    const detallePack = item.es_pack ? ` (${num(item.cantidad)} ${item.pack_nombre || 'pack'}${num(item.cantidad) === 1 ? '' : 's'})` : '';

    if (esConjunto(d)) {
      const contGlobal = num(d.conjunto_contenido);
      const colores = Array.isArray(d.conjunto_colores) ? d.conjunto_colores : [];
      if (colores.length) {
        const v = variedadDelCatalogo(d, item.variedad);
        if (!v) { saltados.push({ idx, id, motivo: `variedad "${item.variedad || ''}" no encontrada` }); return; }
        const cont = contenidoDe(v, contGlobal);
        const antesVar = totalVariedad(v, contGlobal);
        const r = descontarDeTotal(antesVar, base, cont);
        const antesTotal = totalConjunto(colores, contGlobal);
        const nuevos = colores.map(c => (c === v ? { ...c, unidades: r.unidades, restante: r.restante } : c));
        const total = totalConjunto(nuevos, contGlobal);
        d.conjunto_colores = nuevos;
        d.conjunto_total = total;
        d.conjunto_unidades = nuevos.reduce((s, c) => s + num(c.unidades), 0);
        d.conjunto_restante = nuevos.reduce((s, c) => s + num(c.restante), 0);
        d.stock = Math.max(0, Math.floor(total));
        Object.assign(p.campos, {
          conjunto_colores: nuevos, conjunto_total: total,
          conjunto_unidades: d.conjunto_unidades, conjunto_restante: d.conjunto_restante, stock: d.stock,
        });
        p.movimientos.push({
          antes: antesTotal, despues: total, cantidad: -(antesVar - r.total),
          detalle: `Variedad ${v.color}${detallePack}`,
        });
      } else {
        const antes = num(d.conjunto_total);
        const r = descontarDeTotal(antes, base, contGlobal);
        d.conjunto_total = r.total; d.conjunto_unidades = r.unidades; d.conjunto_restante = r.restante;
        d.stock = Math.max(0, Math.floor(r.total));
        Object.assign(p.campos, {
          conjunto_total: r.total, conjunto_unidades: r.unidades, conjunto_restante: r.restante, stock: d.stock,
        });
        p.movimientos.push({ antes, despues: r.total, cantidad: -(antes - r.total), detalle: detallePack.trim() });
      }
    } else {
      const antes = num(d.stock);
      const despues = antes - base;
      d.stock = despues;
      p.campos.stock = despues;
      p.movimientos.push({ antes, despues, cantidad: -base, detalle: detallePack.trim() });
    }
  });

  return { productos: [...trabajo.values()], saltados };
}

const PAD = (n) => String(n).padStart(2, '0');

function fechaHoraAR(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  const partes = new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const hora = `${PAD(partes.hour === '24' ? '00' : partes.hour)}:${PAD(partes.minute)}:${PAD(partes.second)}`;
  return { fecha: `${partes.day}/${partes.month}/${partes.year}`, hora };
}

/**
 * La venta y sus renglones tal como los escribe el POS en `ventas` y
 * `ventas_por_dia`, para que Historial, Cierres y Control Total la vean como
 * una más. Los nombres de producto van como en el catálogo (mayúsculas): es
 * lo que buscan el historial y el reconciliador de consumibles.
 */
export function documentosDeVenta(pedido, pedidoId, catalogoPorId, ahora) {
  const codigo = String(pedido?.codigo || pedidoId || '').trim();
  const ventaId = `${PC_TIENDA}_${codigo}`;
  const modoPago = String(pedido?.pago?.modo || '').toLowerCase();
  const efectivo = modoPago === 'efectivo';
  const tipoPago = efectivo ? 'Efectivo' : 'Transferencia';
  const { fecha, hora } = fechaHoraAR(ahora);
  const items = pedido?.items || [];
  const envio = num(pedido?.envio);
  const total = num(pedido?.total) || (items.reduce((s, i) => s + num(i.subtotal), 0) + envio);
  const cliente = pedido?.cliente?.nombre ? String(pedido.cliente.nombre) : '';

  const linea = (idx, datos) => ({
    docId: `${ventaId}_${idx}`,
    datos: {
      fecha, hora,
      num_venta: codigo,
      cajero: 'Tienda online',
      tipo_pago: tipoPago,
      descuento_tipo: '', descuento_valor: 0, descuento_monto: 0,
      cash_register_id: null,
      pc_id: PC_TIENDA,
      origen: 'tienda',
      pedido_id: String(pedidoId || ''),
      cliente,
      // Sin vínculos que descontar: que el watcher y el reconciliador lo salteen.
      consumibles_procesado: true,
      ...datos,
    },
  });

  const lineas = items.map((it, idx) => {
    const d = catalogoPorId?.[String(it.id)] || null;
    const v = d ? variedadDelCatalogo(d, it.variedad) : null;
    const precio = num(it.precio);
    return linea(idx, {
      producto: String(d?.nombre || it.nombre || '').toUpperCase(),
      categoria: String(d?.categoria || 'Sin categoría'),
      cantidad: num(it.cantidad),
      precio_unitario: precio,
      precio_original: precio,
      subtotal: num(it.subtotal) || precio * num(it.cantidad),
      conjunto_color: v ? String(v.color) : (it.variedad ? String(it.variedad) : ''),
      es_pack: !!it.es_pack,
      pack_contenido: it.es_pack ? num(it.pack_contenido) : null,
      unidad: String(it.unidad || 'unidad'),
      producto_id: String(it.id || ''),
    });
  });
  if (envio > 0) {
    lineas.push(linea(items.length, {
      producto: 'ENVIO A DOMICILIO',
      categoria: 'SERVICIOS',
      cantidad: 1, precio_unitario: envio, precio_original: envio, subtotal: envio,
      conjunto_color: '', es_pack: false, pack_contenido: null, unidad: 'unidad', producto_id: '',
    }));
  }

  const productosStr = items.slice(0, 3).map(i => `${String(i.nombre || '')} x${num(i.cantidad)}`).join(', ')
    + (items.length > 3 ? ` (+${items.length - 3} más)` : '');

  const venta = {
    sale_id: codigo,
    num_venta: codigo,
    pc_id: PC_TIENDA,
    payment_type: efectivo ? 'cash' : 'transfer',
    total_amount: total,
    cash_received: efectivo ? total : 0,
    change_given: 0,
    transfer_amount: efectivo ? 0 : total,
    items_count: lineas.length,
    productos: productosStr,
    username: 'Tienda online',
    cajero: 'Tienda online',
    discount: 0,
    cash_register_id: null,
    es_fiado: false, fiado_tipo: '', fiado_cliente: '', fiado_cliente_fid: '',
    origen: 'tienda',
    pedido_id: String(pedidoId || ''),
    cliente,
    envio,
  };
  return { ventaId, venta, lineas };
}
