/**
 * Autocompletado del campo de direccion.
 *
 * Engancha un desplegable de sugerencias a un input comun. Cuando el cliente
 * elige una, resuelve sus coordenadas y las devuelve: son las que le permiten a
 * la tienda cobrar el envio que corresponde en vez de "a confirmar".
 *
 * Y cuando no elige ninguna —que es lo que hace mucha gente: escribe la
 * direccion entera y le da a confirmar— al salir del campo se le pide al
 * servidor que resuelva ese texto. Si dice exactamente lo mismo que la primera
 * sugerencia, se toma esa; si es ambiguo, se deja sin coordenadas. Lo que sale
 * de ahi viaja marcado como aproximada, para que el checkout se lo muestre en
 * vez de cobrar un envio calculado sobre una direccion que el cliente no vio.
 *
 * Degrada solo. Si la funcion del servidor no esta desplegada o no tiene clave,
 * las sugerencias no aparecen y el campo sigue siendo un campo de texto: el
 * cliente escribe su direccion, el pedido entra igual y el envio se confirma al
 * prepararlo. Nunca bloquea el checkout, que es lo unico que no se puede
 * romper.
 */
import { esc } from './formato.js';
import { icono } from './iconos.js';

const FUNCION = '/.netlify/functions/direcciones';
const ESPERA_MS = 300;
const MINIMO_PARA_RESOLVER = 6;

/**
 * @param {HTMLInputElement} input
 * @param {(cambio: {estado:string, direccion?:string, lat?:number, lng?:number}) => void} alCambiar
 *        `estado` es uno de:
 *          escribiendo   el cliente esta tecleando; lo de antes ya no vale
 *          ubicada       eligio del desplegable, con coordenadas
 *          aproximada    lo escribio entero y el servidor lo resolvio
 *          no_ubicada    lo escribio entero y no se pudo resolver
 *          sin_servicio  la funcion no esta desplegada o no tiene clave
 * @returns {() => void} para desenganchar
 */
export function montarDirecciones(input, alCambiar) {
  if (!input) return () => {};

  // El desplegable se posiciona contra este envoltorio, no contra el campo:
  // el campo vive dentro de un .campo que tambien tiene la etiqueta y la ayuda.
  const caja = document.createElement('div');
  caja.className = 'direcciones';
  input.parentNode.insertBefore(caja, input);
  caja.appendChild(input);

  const lista = document.createElement('div');
  lista.className = 'direcciones__lista';
  lista.setAttribute('role', 'listbox');
  lista.hidden = true;
  caja.appendChild(lista);

  let sugerencias = [];
  let marcada = -1;
  let temporizador = null;
  let peticion = 0;
  let apagado = false;

  // Agrupa todas las teclas de este campo con el detalle final en una sola
  // sesion de Places. Google la factura como una busqueda en vez de una por
  // tecla. Se renueva despues de cada direccion resuelta, porque ahi la sesion
  // se cerro y las teclas siguientes son una busqueda nueva.
  let sesion = nuevaSesion();

  // El ultimo texto que ya se intento resolver contra el servidor, para no
  // repetir la consulta cada vez que el campo pierde el foco sin cambios.
  let resuelto = '';

  function nuevaSesion() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      // Safari viejo no tiene randomUUID. El token solo tiene que ser unico y
      // con forma de uuid v4: el servidor rechaza cualquier otra cosa.
      : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
          (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
  }

  async function pedir(cuerpo) {
    const respuesta = await fetch(FUNCION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...cuerpo, sesion }),
    });

    // 503 es "no hay clave configurada" y 404 es "la funcion todavia no esta
    // desplegada". En los dos casos no tiene sentido seguir preguntando en cada
    // tecla: se apaga y el campo queda como texto libre.
    if (respuesta.status === 503 || respuesta.status === 404) {
      apagado = true;
      alCambiar({ estado: 'sin_servicio' });
      return null;
    }
    if (!respuesta.ok) return null;
    return respuesta.json();
  }

  function cerrar() {
    lista.hidden = true;
    lista.innerHTML = '';
    sugerencias = [];
    marcada = -1;
    input.setAttribute('aria-expanded', 'false');
  }

  function pintar() {
    if (!sugerencias.length) { cerrar(); return; }

    lista.innerHTML = sugerencias.map((s, i) => `
      <button type="button" class="direccion" role="option" data-i="${i}"
              aria-selected="${i === marcada}">
        <span class="direccion__pin">${icono('pin', { tam: 18 })}</span>
        <span class="direccion__texto">
          <span class="direccion__titulo">${esc(s.titulo)}</span>
          ${s.detalle ? `<span class="direccion__detalle">${esc(s.detalle)}</span>` : ''}
        </span>
      </button>`).join('');

    lista.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  async function buscar() {
    const q = input.value.trim();
    if (q.length < 3) { cerrar(); return; }

    const mio = ++peticion;
    try {
      const datos = await pedir({ q });
      if (!datos) { cerrar(); return; }

      // Llegó tarde: el cliente siguió escribiendo y ya hay otra consulta en
      // vuelo. Pintar esta le cambiaría la lista por una vieja.
      if (mio !== peticion) return;

      sugerencias = datos.sugerencias || [];
      marcada = -1;
      pintar();
    } catch {
      cerrar();
    }
  }

  async function elegir(i) {
    const s = sugerencias[i];
    if (!s) return;

    cerrar();
    input.value = [s.titulo, s.detalle].filter(Boolean).join(', ');

    try {
      const datos = await pedir({ placeId: s.id });
      if (!datos) return;

      if (datos.direccion) input.value = datos.direccion;
      resuelto = input.value;
      sesion = nuevaSesion();

      if (Number.isFinite(datos.lat) && Number.isFinite(datos.lng)) {
        alCambiar({ estado: 'ubicada', direccion: input.value, lat: datos.lat, lng: datos.lng });
      }
    } catch (err) {
      console.warn('[direcciones] no se pudo resolver el lugar:', err);
    }
  }

  /**
   * Resuelve lo que quedó escrito sin haber elegido del desplegable.
   * Silencioso a proposito: si no se puede, el campo queda como estaba y el
   * envio se cotiza al preparar el pedido.
   */
  async function resolverEscrito() {
    const texto = input.value.trim();
    if (apagado || texto.length < MINIMO_PARA_RESOLVER || texto === resuelto) return;

    resuelto = texto;
    const mio = ++peticion;

    try {
      const datos = await pedir({ texto });
      if (!datos || mio !== peticion) return;

      // Solo si el campo sigue diciendo lo mismo: el cliente pudo volver y
      // corregirlo mientras la consulta viajaba.
      if (input.value.trim() !== texto) return;

      if (!Number.isFinite(datos.lat) || !Number.isFinite(datos.lng)) {
        alCambiar({ estado: 'no_ubicada' });
        return;
      }

      if (datos.direccion) {
        input.value = datos.direccion;
        resuelto = input.value;
      }
      sesion = nuevaSesion();

      alCambiar({
        estado: 'aproximada',
        direccion: input.value,
        lat: datos.lat,
        lng: datos.lng,
      });
    } catch (err) {
      console.warn('[direcciones] no se pudo resolver lo escrito:', err);
    }
  }

  /* ── Eventos ────────────────────────────────────────────────────────────── */

  function alEscribir() {
    // Cualquier tecla invalida la dirección verificada: si el cliente eligió
    // una del desplegable y después le agregó algo, las coordenadas guardadas
    // ya no son de lo que dice el campo.
    alCambiar({ estado: 'escribiendo' });

    if (apagado) return;
    clearTimeout(temporizador);
    temporizador = setTimeout(buscar, ESPERA_MS);
  }

  function alTeclear(ev) {
    if (lista.hidden || !sugerencias.length) return;

    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const paso = ev.key === 'ArrowDown' ? 1 : -1;
      marcada = (marcada + paso + sugerencias.length) % sugerencias.length;
      pintar();
    } else if (ev.key === 'Enter' && marcada >= 0) {
      ev.preventDefault();
      elegir(marcada);
    } else if (ev.key === 'Escape') {
      cerrar();
    }
  }

  function alClicar(ev) {
    const boton = ev.target.closest('[data-i]');
    if (boton) elegir(Number(boton.dataset.i));
  }

  // El clic en una sugerencia dispara el blur del campo antes que su propio
  // click. Sin el retraso, la lista se cierra y el clic cae en el vacío; y sin
  // el mismo retraso antes de resolver, se resolvería el texto a medio escribir
  // de alguien que justo estaba haciendo clic en una sugerencia.
  function alSalir() {
    setTimeout(() => {
      // Se cancela la búsqueda de sugerencias que todavía estaba esperando su
      // turno. No solo es inútil para una lista que se está cerrando: al
      // arrancar después se lleva el número de petición y la respuesta de
      // resolverEscrito llega con el número viejo y se descarta.
      //
      // En local no se notaba porque la resolución volvía antes que venciera la
      // espera. Contra el servidor, con dos consultas a Google de por medio,
      // el campo se quedaba sin coordenadas y el envío en "a confirmar".
      clearTimeout(temporizador);
      cerrar();
      resolverEscrito();
    }, 200);
  }

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('autocomplete', 'off');

  input.addEventListener('input', alEscribir);
  input.addEventListener('keydown', alTeclear);
  input.addEventListener('blur', alSalir);
  lista.addEventListener('click', alClicar);

  return () => {
    clearTimeout(temporizador);
    input.removeEventListener('input', alEscribir);
    input.removeEventListener('keydown', alTeclear);
    input.removeEventListener('blur', alSalir);
    lista.removeEventListener('click', alClicar);
    lista.remove();
  };
}
