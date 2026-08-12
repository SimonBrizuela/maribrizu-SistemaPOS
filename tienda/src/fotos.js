/**
 * Modo "marcar fotos".
 *
 * El personal recorre la tienda como un cliente más y va tildando los productos
 * cuya foto hay que cambiar, sin abrir la ficha de cada uno. La lista se lee
 * después desde el panel.
 *
 * El modo está oculto: se prende una sola vez por dispositivo entrando con
 * `?fotos=1` y queda guardado. Un cliente común nunca ve el tilde, así que no
 * puede ensuciar la lista. Se apaga con `?fotos=0`.
 *
 * Lo marcado se escribe en `tienda_fotos_pedidas`, un documento por producto
 * (el id del doc ES el id del producto, así marcar dos veces no duplica nada).
 * Además se guarda el conjunto en el navegador: las reglas no dan lectura
 * pública de esa colección, así que los tildes se pintan desde acá y la tienda
 * no necesita permiso para leerla.
 */
import { deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from './firebase.js';
import { esc } from './formato.js';
import { icono } from './iconos.js';

const CLAVE_MODO = 'll-modo-fotos';
const CLAVE_LISTA = 'll-fotos-pedidas';

let _marcados = null;   // Set de ids, cargado una vez

/* ── Modo ────────────────────────────────────────────────────────────────── */

/**
 * Lee `?fotos=` de la URL y lo deja guardado. Se llama una vez al arrancar,
 * antes del primer pintado.
 *
 * El parámetro se borra de la barra de direcciones después de aplicarlo: si
 * queda pegado, el personal lo comparte sin querer al mandar un link de un
 * producto y el modo se le enciende a un cliente.
 */
export function aplicarModoDesdeURL() {
  let valor = null;
  try {
    valor = new URL(location.href).searchParams.get('fotos');
  } catch (_) { return; }
  if (valor === null) return;

  try {
    if (valor === '0' || valor === 'no') {
      localStorage.removeItem(CLAVE_MODO);
    } else {
      localStorage.setItem(CLAVE_MODO, '1');
    }
  } catch (_) { /* navegación privada sin storage: el modo dura la sesión */ }

  try {
    const url = new URL(location.href);
    url.searchParams.delete('fotos');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch (_) { /* si no se puede reescribir, no es grave */ }
}

export function modoFotos() {
  try {
    return localStorage.getItem(CLAVE_MODO) === '1';
  } catch (_) {
    return false;
  }
}

/* ── Lo marcado ──────────────────────────────────────────────────────────── */

function cargarMarcados() {
  if (_marcados) return _marcados;
  try {
    const crudo = JSON.parse(localStorage.getItem(CLAVE_LISTA) || '[]');
    _marcados = new Set(Array.isArray(crudo) ? crudo.map(String) : []);
  } catch (_) {
    _marcados = new Set();
  }
  return _marcados;
}

function guardarMarcados() {
  try {
    localStorage.setItem(CLAVE_LISTA, JSON.stringify([...cargarMarcados()]));
  } catch (_) { /* sin storage el tilde vale para esta sesión */ }
}

export function estaMarcado(id) {
  return cargarMarcados().has(String(id));
}

export function cuantosMarcados() {
  return cargarMarcados().size;
}

/* ── Marcar y desmarcar ──────────────────────────────────────────────────── */

/**
 * Alterna la marca de un producto. Devuelve el estado nuevo.
 *
 * El estado local se actualiza primero para que el tilde responda al toque sin
 * esperar a la red; si Firestore falla se deshace y se avisa. En un celular
 * dentro del local, con la señal que hay, esperar la confirmación haría que
 * cada toque se sintiera roto.
 */
export async function alternarMarca(p) {
  const id = String(p.id);
  const lista = cargarMarcados();
  const marcar = !lista.has(id);

  if (marcar) lista.add(id); else lista.delete(id);
  guardarMarcados();

  try {
    if (marcar) {
      await setDoc(doc(db, 'tienda_fotos_pedidas', id), {
        producto_id: id,
        nombre: String(p.nombre || ''),
        rubro: String(p.rubro || ''),
        // Sirve para saber, desde el panel, si el producto hoy no tiene foto o
        // tiene una que no sirve: son dos trabajos distintos.
        tenia_foto: Boolean(p.imagenes?.length),
        pedido_en: serverTimestamp(),
      });
    } else {
      await deleteDoc(doc(db, 'tienda_fotos_pedidas', id));
    }
    return marcar;
  } catch (err) {
    console.error('[fotos] no se pudo guardar la marca:', err);
    if (marcar) lista.delete(id); else lista.add(id);
    guardarMarcados();
    throw err;
  }
}

/* ── Interfaz ────────────────────────────────────────────────────────────── */

/**
 * El tilde que va en la card. Vacío si el modo está apagado.
 *
 * El nombre y el rubro viajan en el propio botón: cuando se toca hay que
 * guardarlos en Firestore, y el que marca puede estar en la búsqueda, en la
 * portada o en un rubro, todos con listas de productos distintas. Llevarlos
 * acá evita un registro global de todo lo que se pintó.
 */
export function tildeFoto(p) {
  if (!modoFotos()) return '';
  const marcado = estaMarcado(p.id);
  return `
    <button type="button" class="marca-foto${marcado ? ' marca-foto--puesta' : ''}"
            data-marcar-foto="${esc(p.id)}" aria-pressed="${marcado}"
            data-foto-nombre="${esc(p.nombre || '')}"
            data-foto-rubro="${esc(p.rubro || '')}"
            data-foto-tiene="${p.imagenes?.length ? '1' : ''}"
            title="${marcado ? 'Sacar de la lista de fotos' : 'Marcar para cambiar la foto'}"
            aria-label="${marcado ? 'Sacar' : 'Marcar'} la foto de ${esc(p.nombre)}">
      ${icono('tilde', { tam: 15, grosor: 3 })}
    </button>`;
}

/**
 * La barra fija que cuenta lo marcado y deja apagar el modo.
 * Se monta una sola vez; después solo se actualiza el número.
 */
export function iniciarBarraFotos() {
  if (!modoFotos() || document.querySelector('.barra-fotos')) return;

  const barra = document.createElement('div');
  barra.className = 'barra-fotos';
  barra.setAttribute('role', 'status');
  barra.innerHTML = `
    <span class="barra-fotos__texto">
      Modo fotos · <b data-cuenta-fotos>${cuantosMarcados()}</b> marcado<span data-plural-fotos>${
        cuantosMarcados() === 1 ? '' : 's'}</span>
    </span>
    <button type="button" class="barra-fotos__salir" data-salir-fotos>Salir</button>`;
  document.body.appendChild(barra);
  document.body.classList.add('con-barra-fotos');

  barra.querySelector('[data-salir-fotos]').addEventListener('click', () => {
    try { localStorage.removeItem(CLAVE_MODO); } catch (_) { /* sin storage */ }
    barra.remove();
    document.body.classList.remove('con-barra-fotos');
    document.querySelectorAll('.marca-foto').forEach(b => b.remove());
  });
}

function refrescarCuenta() {
  const n = cuantosMarcados();
  const nodo = document.querySelector('[data-cuenta-fotos]');
  if (nodo) nodo.textContent = String(n);
  const plural = document.querySelector('[data-plural-fotos]');
  if (plural) plural.textContent = n === 1 ? '' : 's';
}

/**
 * Un solo listener en el documento para todos los tildes, presentes y futuros:
 * la grilla agrega cards al paginar y volver a enganchar botón por botón deja
 * los nuevos muertos.
 */
export function engancharTildes() {
  document.addEventListener('click', async ev => {
    const boton = ev.target.closest?.('[data-marcar-foto]');
    if (!boton) return;

    // La card entera es un enlace a la ficha: sin esto, marcar abre el producto.
    ev.preventDefault();
    ev.stopPropagation();

    const id = boton.dataset.marcarFoto;
    const p = {
      id,
      nombre: boton.dataset.fotoNombre || '',
      rubro: boton.dataset.fotoRubro || '',
      imagenes: boton.dataset.fotoTiene ? ['x'] : [],
    };

    boton.disabled = true;
    try {
      const puesta = await alternarMarca(p);
      boton.classList.toggle('marca-foto--puesta', puesta);
      boton.setAttribute('aria-pressed', String(puesta));
      boton.title = puesta ? 'Sacar de la lista de fotos' : 'Marcar para cambiar la foto';
      refrescarCuenta();
    } catch (_) {
      boton.classList.add('marca-foto--error');
      setTimeout(() => boton.classList.remove('marca-foto--error'), 1200);
    } finally {
      boton.disabled = false;
    }
  }, true);
}
