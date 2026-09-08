/**
 * El cupón, del lado del servidor: leerlo, contar cuántas veces se usó y
 * decidir con las reglas de `src/cupones.js`.
 *
 * Los usos no se llevan en un contador: se cuentan de los pedidos que llevan
 * el cupón, igual que los resúmenes se calculan de las ventas y no de un
 * acumulado aparte. Así un pedido cancelado devuelve el uso solo, y el panel
 * puede decir quién lo usó y en qué sin una segunda tabla que mantener.
 *
 * La persona es el teléfono (los diez dígitos, sin prefijos) o la cuenta si
 * entró con una. No es infalible —quien cambia de número es otra persona para
 * esto— pero es el dato que el local usa para llamar, y lo tiene siempre.
 */
import { leerDocPrivado, consultar } from './firestore.mjs';
import {
  evaluarCupon, codigoValido, telefonoClave, usosDePersona, pedidoCuenta,
} from '../../../src/cupones.js';

/** Lo que hace falta de cada pedido para contar usos: nada más. */
const CAMPOS_DE_USO = ['estado', 'cliente', 'uid'];

/** El cupón por su código, o null. Un código con forma inválida ni se busca. */
export async function leerCupon(codigo) {
  if (!codigoValido(codigo)) return null;
  return leerDocPrivado('tienda_cupones', codigo);
}

/** Los pedidos que llevan este cupón, con lo justo para contar. */
export async function usosDelCupon(codigo) {
  return consultar('tienda_pedidos', {
    where: [['cupon.codigo', 'EQUAL', codigo]],
    limite: 2000,
    campos: CAMPOS_DE_USO,
  });
}

/**
 * Si esta persona nunca hizo un pedido (no cancelado). Se mira por teléfono y
 * por cuenta. Los pedidos anteriores a que existiera `telefono_clave` no se
 * encuentran por teléfono: un cliente viejo puede usar un cupón de primera
 * compra una vez. Es un regalo, no un agujero.
 */
export async function esPrimeraCompra(persona) {
  const tel = telefonoClave(persona?.telefono);
  const consultas = [];
  if (tel) {
    consultas.push(consultar('tienda_pedidos', {
      where: [['cliente.telefono_clave', 'EQUAL', tel]], limite: 20, campos: ['estado'],
    }));
  }
  if (persona?.uid) {
    consultas.push(consultar('tienda_pedidos', {
      where: [['uid', 'EQUAL', String(persona.uid)]], limite: 20, campos: ['estado'],
    }));
  }
  const listas = await Promise.all(consultas);
  return !listas.flat().some(pedidoCuenta);
}

/**
 * Si el cupón vale para este pedido y cuánto saca, con la base como única
 * fuente.
 *
 * Si no se pueden contar los usos, el cupón NO se aplica: regalar plata por
 * un error de lectura es peor que pedirle al cliente que pruebe de nuevo.
 *
 * @returns {Promise<{ok: true, cupon, descuento, envio_gratis, aplicable, renglones}
 *                  | {ok: false, motivo, [detalle]: any}>}
 */
export async function evaluarCuponDelPedido({ codigo, renglones, envio, modo, persona, ahora = new Date() }) {
  let cupon;
  try {
    cupon = await leerCupon(codigo);
  } catch (err) {
    console.warn('[cupon] no se pudo leer el cupón:', err);
    return { ok: false, motivo: 'error' };
  }
  if (!cupon) return { ok: false, motivo: 'no_existe' };

  let usosTotales = 0;
  let usosPersona = 0;
  let primera = null;
  try {
    // Contar cuesta una consulta: solo cuando el cupón tiene límites.
    if (Number(cupon.usos_totales) > 0 || Number(cupon.usos_por_persona) > 0) {
      const usos = await usosDelCupon(codigo);
      usosTotales = usos.filter(pedidoCuenta).length;
      usosPersona = usosDePersona(usos, persona || {});
    }
    if (cupon.solo_primera_compra === true) primera = await esPrimeraCompra(persona || {});
  } catch (err) {
    console.warn('[cupon] no se pudieron contar los usos:', err);
    return { ok: false, motivo: 'error' };
  }

  const resultado = evaluarCupon(cupon, {
    renglones, envio, modo, ahora, usosPersona, usosTotales, esPrimeraCompra: primera,
  });
  if (!resultado.ok) return resultado;

  return {
    ...resultado,
    cupon: {
      codigo,
      nombre: String(cupon.nombre || codigo),
      tipo: cupon.tipo,
      valor: cupon.valor ?? null,
      tope: cupon.tope ?? null,
    },
  };
}

/**
 * Segunda mirada, ya con el pedido escrito: si otro pedido con el mismo cupón
 * entró en el mismo instante y entre los dos pasan el límite —el total o el de
 * esta persona—, este se retira. Devuelve `{ motivo }` con lo que le hace
 * falta al mensaje (`veces`, para "ya lo usaste N veces"), o null si está bien.
 */
export async function cuponExcedidoTrasEscribir({ codigo, persona }) {
  let cupon;
  let usos;
  try {
    cupon = await leerCupon(codigo);
    if (!cupon) return null;
    const totales = Number(cupon.usos_totales) || 0;
    const porPersona = Number(cupon.usos_por_persona) || 0;
    if (!totales && !porPersona) return null;
    usos = await usosDelCupon(codigo);
    if (totales > 0 && usos.filter(pedidoCuenta).length > totales) return { motivo: 'agotado' };
    if (porPersona > 0 && usosDePersona(usos, persona || {}) > porPersona) {
      return { motivo: 'ya_usado', veces: porPersona };
    }
    return null;
  } catch (err) {
    // No se pudo mirar de nuevo: el pedido queda. Ya pasó el primer control.
    console.warn('[cupon] no se pudo hacer la segunda mirada:', err);
    return null;
  }
}
