/**
 * El cupón desde el navegador: preguntarle al servidor si vale y recordar el
 * que quedó puesto.
 *
 * La cuenta no se hace acá. Los cupones no son públicos —si el navegador
 * pudiera leerlos, podría listar los códigos vigentes— y cuántas veces lo usó
 * esta persona solo se sabe mirando los pedidos. Así que se manda el código y
 * lo que hay en el carrito, y vuelve cuánto descuenta o por qué no.
 *
 * Lo que vuelve es una vista previa: el descuento de verdad lo decide el
 * servidor al guardar el pedido, con la misma cuenta. Por eso el checkout lo
 * vuelve a preguntar cada vez que cambia algo del pedido.
 */
import { normalizarCodigo, mensajeDeCupon } from './cupones.js';

const CLAVE = 'liceo.cupon.v1';
const FUNCION = '/.netlify/functions/validar-cupon';

/** El cupón que quedó puesto en este navegador, con lo último que contestó el servidor. */
export function cuponGuardado() {
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return null;
    const datos = JSON.parse(crudo);
    return datos?.cupon?.codigo ? datos : null;
  } catch {
    return null;
  }
}

export function guardarCupon(resultado) {
  try {
    localStorage.setItem(CLAVE, JSON.stringify({ ...resultado, cuando: Date.now() }));
  } catch (err) {
    // Modo incógnito, cuota llena. El cupón sigue puesto en memoria hasta
    // recargar; en el peor caso se vuelve a tipear.
    console.warn('[cupon] no se pudo recordar el cupón:', err);
  }
}

export function quitarCupon() {
  try { localStorage.removeItem(CLAVE); } catch { /* nada que sacar */ }
}

/**
 * Le pregunta al servidor si el cupón vale para este carrito.
 *
 * @returns {Promise<{ok: true, cupon, descuento, envio_gratis, aplicable, renglones}
 *                  | {ok: false, motivo, mensaje}>}
 */
export async function validarCupon({ codigo, items, modo, envio = 0, telefono = '', idToken = null }) {
  const limpio = normalizarCodigo(codigo);
  if (!limpio) return { ok: false, motivo: 'vacio', mensaje: 'Escribí el código del cupón.' };

  let respuesta;
  try {
    respuesta = await fetch(FUNCION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codigo: limpio,
        // Va el QUÉ, no el cuánto: el precio lo pone el servidor.
        items: items.map(i => ({
          id: i.id, variedad: i.variedad ?? null, cantidad: i.cantidad, es_pack: i.es_pack === true,
        })),
        entrega: { modo },
        envio,
        telefono,
        ...(idToken ? { idToken } : {}),
      }),
    });
  } catch (err) {
    console.warn('[cupon] no se pudo consultar:', err);
    return { ok: false, motivo: 'red', mensaje: 'No pudimos comprobar el cupón. Fijate la conexión y probá de nuevo.' };
  }

  let datos = null;
  try { datos = await respuesta.json(); } catch { /* cuerpo ilegible */ }

  if (respuesta.ok && datos?.ok === true && datos.cupon?.codigo) {
    return { ok: true, ...datos, mensaje: null };
  }
  if (respuesta.status === 409 && datos?.error === 'cupon') {
    return { ok: false, ...datos, mensaje: mensajeDeCupon(datos) };
  }
  if (respuesta.status === 501) {
    return { ok: false, motivo: 'sin_servicio', mensaje: 'Los cupones no están disponibles por ahora.' };
  }
  return { ok: false, motivo: 'error', mensaje: 'No pudimos comprobar el cupón. Probá de nuevo en un momento.' };
}
