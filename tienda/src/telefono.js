/**
 * Teléfonos de los clientes.
 *
 * Lo usan el panel (Pedidos, Reclamos) y la pantalla del repartidor. No puede
 * depender de Firebase ni del DOM.
 */

/**
 * El número del cliente, como lo quiere wa.me.
 *
 * WhatsApp necesita 549 + código de área + número, sin el 0 ni el 15. La gente
 * lo escribe de todas las formas posibles y ninguna es esa:
 *
 *     3516194411          como lo dice cualquiera
 *     0351 15 619-4411    como está en la agenda de papel
 *     +54 351 619 4411    copiado de un contacto, y le falta el 9
 *
 * El último es el que rompía: empieza con 54, así que se tomaba por bueno y se
 * mandaba `wa.me/543516194411`, que no resuelve a ningún celular. Salió de un
 * pedido real del tablero.
 *
 * Los fijos quedan mal —les agrega un 9 que no les corresponde— y está bien:
 * WhatsApp no funciona en un fijo, así que ese aviso no iba a llegar igual.
 */
export function whatsappDeTelefono(telefono) {
  let d = String(telefono || '').replace(/\D/g, '');
  if (d.length < 8) return null;

  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('54')) d = d.slice(2);
  d = d.replace(/^0/, '');
  if (d.startsWith('9') && d.length > 10) d = d.slice(1);
  // Un número nacional mide diez dígitos: código de área (dos a cuatro) más el
  // abonado. Con doce, esos dos de más son el 15 que se metía antes del número
  // para llamar a un celular.
  if (d.length === 12) d = d.replace(/^(\d{2,4})15/, '$1');

  return d.length >= 8 ? `549${d}` : null;
}
