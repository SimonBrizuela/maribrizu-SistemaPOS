/**
 * Los datos de quien compra, guardados en este teléfono.
 *
 * Cuando alguien confirma un pedido escribe su nombre, su teléfono y —si se lo
 * llevan a casa— su dirección. Volver a escribir todo eso en el próximo pedido
 * es la razón más tonta por la que alguien no vuelve a comprar.
 *
 * Vive en localStorage y no en el servidor, y eso es a propósito. Un registro
 * de clientes que se pueda consultar por teléfono sin contraseña es un
 * directorio abierto: cualquiera prueba un número y se lleva el nombre y la
 * dirección de esa persona. Los teléfonos se adivinan de a miles.
 *
 * El local igual tiene su registro: sale de los pedidos, que ya guardan nombre,
 * teléfono y dirección, y se mira desde el panel. Lo que no existe es una forma
 * de preguntarle a la base "¿quién es 351...?" desde la vereda.
 *
 * Las direcciones se guardan varias porque la gente pide a su casa y al trabajo,
 * y la última usada queda de predeterminada.
 */

const CLAVE = 'liceo.cliente.v1';
const MAX_DIRECCIONES = 4;

/** @typedef {{direccion: string, referencia: string|null,
 *             lat: number|null, lng: number|null, usada: number}} Domicilio */

function leer() {
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return null;
    const d = JSON.parse(crudo);
    if (!d || typeof d !== 'object') return null;
    return {
      nombre: String(d.nombre || ''),
      telefono: String(d.telefono || ''),
      direcciones: Array.isArray(d.direcciones) ? d.direcciones.filter(esDomicilio) : [],
    };
  } catch {
    return null;
  }
}

function esDomicilio(x) {
  return x && typeof x === 'object' && typeof x.direccion === 'string' && x.direccion.trim();
}

function guardar(perfil) {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(perfil));
  } catch (err) {
    // Modo privado, cuota llena. Se pierde el autocompletado y nada más.
    console.warn('[cliente] no se pudo guardar el perfil:', err);
  }
}

/** Lo que hay que poner en el formulario, o null si es la primera vez. */
export function perfil() {
  const p = leer();
  if (!p || (!p.nombre && !p.telefono)) return null;
  return p;
}

/** Las direcciones guardadas, la más usada recientemente primero. */
export function domicilios() {
  const p = leer();
  if (!p) return [];
  return [...p.direcciones].sort((a, b) => (b.usada || 0) - (a.usada || 0));
}

/** La que se ofrece por defecto: la última que usó. */
export function domicilioPredeterminado() {
  return domicilios()[0] || null;
}

/**
 * Guarda lo que se usó en un pedido que salió bien.
 *
 * Se llama al confirmar y no mientras se escribe: a mitad de tipear, el nombre
 * es "Ma" y el teléfono tres dígitos, y eso no sirve para completar nada
 * después. Un pedido confirmado es la señal de que los datos están bien.
 */
export function recordarDelPedido({ nombre, telefono, direccion, referencia, coordenadas }) {
  const antes = leer() || { nombre: '', telefono: '', direcciones: [] };

  const perfilNuevo = {
    nombre: String(nombre || antes.nombre || '').trim(),
    telefono: String(telefono || antes.telefono || '').trim(),
    direcciones: antes.direcciones,
  };

  const texto = String(direccion || '').trim();
  if (texto) {
    // La misma dirección no se duplica: se actualiza y sube al primer lugar.
    const resto = perfilNuevo.direcciones.filter(d => !mismaDireccion(d.direccion, texto));
    perfilNuevo.direcciones = [{
      direccion: texto,
      referencia: String(referencia || '').trim() || null,
      lat: Number.isFinite(coordenadas?.lat) ? coordenadas.lat : null,
      lng: Number.isFinite(coordenadas?.lng) ? coordenadas.lng : null,
      usada: Date.now(),
    }, ...resto].slice(0, MAX_DIRECCIONES);
  }

  guardar(perfilNuevo);
}

function mismaDireccion(a, b) {
  const limpiar = t => String(t || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return limpiar(a) === limpiar(b);
}

/** Para el "no soy yo": borra todo lo guardado en este teléfono. */
export function olvidar() {
  try {
    localStorage.removeItem(CLAVE);
  } catch (err) {
    console.warn('[cliente] no se pudo borrar el perfil:', err);
  }
}
