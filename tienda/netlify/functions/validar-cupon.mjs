/**
 * Le dice al cliente si un cupón vale para lo que tiene en el carrito y cuánto
 * le descontaría, antes de confirmar.
 *
 * Es una vista previa: el descuento de verdad lo decide `crear-pedido` al
 * guardar, con la misma cuenta. Pero se hace acá, en el servidor, y no en el
 * navegador, por dos razones:
 *
 *   · Los cupones no son públicos. Si el navegador pudiera leer la colección
 *     para validar, podría listar todos los códigos vigentes.
 *   · Cuántas veces lo usó esta persona solo se sabe mirando los pedidos, y
 *     los pedidos tampoco se pueden listar desde afuera.
 *
 * Recibe el código, qué hay en el carrito (id, variedad, cantidad, pack), cómo
 * se entrega, el envío cotizado (para mostrar el "envío gratis") y el teléfono
 * que escribió. Contesta 200 con el descuento o 409 con el motivo, y la
 * tienda pone el texto con `mensajeDeCupon()`, el mismo que usaría el pedido.
 *
 * Un código que no existe demora medio segundo en contestar: es lo único que
 * frena a un script probando códigos al azar, y el cliente de verdad no lo
 * nota.
 */
import { hayCredenciales, uidDelToken } from './lib/firestore.mjs';
import { armarRenglones } from './lib/renglones.mjs';
import { evaluarCuponDelPedido } from './lib/cupon_servidor.mjs';
import { normalizarCodigo, codigoValido } from '../../src/cupones.js';

const MAX_RENGLONES = 100;
const DEMORA_NO_EXISTE_MS = 500;

// La apiKey pública de la tienda, la misma que viaja en el bundle.
const API_KEY = 'AIzaSyDBqPTloSp1MWBFcVMY6mdgyYKoqhTwFRA';

export default async (peticion) => {
  if (peticion.method !== 'POST') {
    return new Response('Método no permitido', { status: 405 });
  }
  if (!hayCredenciales()) {
    return Response.json({ error: 'sin_credenciales' }, { status: 501 });
  }

  let cuerpo;
  try {
    cuerpo = await peticion.json();
  } catch {
    return new Response('Cuerpo inválido', { status: 400 });
  }
  if (cuerpo?.warmup) return new Response(null, { status: 204 });

  const problema = validarForma(cuerpo);
  if (problema) return Response.json({ error: 'forma', detalle: problema }, { status: 400 });

  const codigo = normalizarCodigo(cuerpo.codigo);
  if (!codigoValido(codigo)) return await noExiste();

  const modo = cuerpo.entrega.modo;
  const envio = modo === 'delivery' ? Math.max(0, Math.round(Number(cuerpo.envio) || 0)) : 0;

  let armado;
  let uid;
  try {
    [armado, uid] = await Promise.all([
      armarRenglones(cuerpo.items),
      uidDelToken(cuerpo.idToken, API_KEY),
    ]);
  } catch (err) {
    console.error('[validar-cupon] no se pudieron leer los productos:', err);
    return new Response('No se pudieron leer los productos', { status: 502 });
  }

  const resultado = await evaluarCuponDelPedido({
    codigo,
    // Lo que no cerró (sin stock, dado de baja) queda afuera de la vista
    // previa; el checkout ya lo avisa por su lado.
    renglones: armado.renglones,
    envio,
    modo,
    persona: { telefono: cuerpo.telefono || '', uid },
  });

  if (!resultado.ok) {
    if (resultado.motivo === 'no_existe') return await noExiste();
    return Response.json({ error: 'cupon', ...resultado }, { status: 409 });
  }

  return Response.json({
    ok: true,
    cupon: resultado.cupon,
    descuento: resultado.descuento,
    envio_gratis: resultado.envio_gratis,
    aplicable: resultado.aplicable,
    renglones: resultado.renglones,
  });
};

async function noExiste() {
  await new Promise(listo => setTimeout(listo, DEMORA_NO_EXISTE_MS));
  return Response.json({ error: 'cupon', motivo: 'no_existe' }, { status: 409 });
}

const esTexto = x => typeof x === 'string';

function validarForma(c) {
  if (!c || typeof c !== 'object') return 'cuerpo';
  if (!esTexto(c.codigo) || !c.codigo.trim()) return 'codigo';
  if (!c.entrega || !['delivery', 'retiro'].includes(c.entrega.modo)) return 'entrega';
  if (!Array.isArray(c.items) || !c.items.length || c.items.length > MAX_RENGLONES) return 'items';
  for (const i of c.items) {
    if (!i || typeof i !== 'object' || !esTexto(i.id) || !i.id) return 'item';
    if (!['number', 'string'].includes(typeof i.cantidad)) return 'cantidad';
    const cantidad = Number(i.cantidad);
    if (!Number.isFinite(cantidad) || !(cantidad > 0)) return 'cantidad';
    if (i.variedad !== undefined && i.variedad !== null && !esTexto(i.variedad)) return 'variedad';
  }
  if (c.telefono !== undefined && c.telefono !== null && !esTexto(c.telefono)) return 'telefono';
  if (c.envio !== undefined && c.envio !== null && !Number.isFinite(Number(c.envio))) return 'envio';
  return null;
}
