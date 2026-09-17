/**
 * El link del repartidor, en Configuración de la tienda.
 *
 * La pantalla del repartidor (`/reparto` en la tienda) se abre sin usuario ni
 * clave: la llave es este link. Vive en `tienda_reparto/acceso`, que solo leen el
 * panel y las funciones de la tienda.
 *
 * Generar otro cambia la clave y anular la deja sin uso; los dos suben la
 * `version`. Las reglas de Firestore comparan esa versión con la de la sesión
 * del celular, así que un link reemplazado deja de mostrar pedidos enseguida, y
 * `reparto-mover` ya no acepta la clave vieja.
 */
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { confirmDialog, alertDialog } from './dialogs.js';
import { urlDeLaTienda } from '../avisos_cliente.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 32 bytes al azar en base64url: 43 caracteres que nadie adivina. */
function claveNueva() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const linkDe = (clave) => `${urlDeLaTienda()}/reparto#k=${clave}`;

export async function montarLinkReparto(caja, db) {
  // Sin la caja no hay dónde dibujar: la página cambió antes de montarlo.
  if (!caja) return;
  const ref = doc(db, 'tienda_reparto', 'acceso');
  let acceso = null;

  function pintar() {
    const activo = acceso && !acceso.anulado && acceso.clave;
    if (!activo) {
      caja.innerHTML = `
        <div class="tienda-pista" style="margin-bottom:10px">
          ${acceso?.anulado
            ? 'El link del repartidor está <b>anulado</b>: nadie puede entrar a la pantalla de reparto.'
            : 'Todavía no hay link del repartidor.'}
          Con el link, el repartidor ve en el celular los pedidos con envío, el
          más cercano primero, y los marca en camino o entregados.
        </div>
        <button type="button" class="pc-btn" data-generar-link>
          <span class="material-icons" style="font-size:17px">link</span> Crear link del repartidor
        </button>`;
      return;
    }
    const link = linkDe(acceso.clave);
    const mensaje = `Link para ver los pedidos a repartir de Librería Liceo (no lo compartas): ${link}`;
    caja.innerHTML = `
      <div class="tienda-pista" style="margin-bottom:8px">
        Abrilo en el celular del repartidor. Quien tenga este link ve los pedidos con
        envío: si se lo pasaste a alguien que ya no reparte, generá otro.
      </div>
      <code data-link style="display:block;padding:8px 10px;border-radius:8px;background:var(--bg);
            font-size:12px;word-break:break-all;margin-bottom:10px">${esc(link)}</code>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        <button type="button" class="pc-btn" data-copiar-link>
          <span class="material-icons" style="font-size:17px">content_copy</span> Copiar
        </button>
        <a class="pc-btn" data-whatsapp-link target="_blank" rel="noopener"
           href="https://wa.me/?text=${encodeURIComponent(mensaje)}">
          <span class="material-icons" style="font-size:17px">chat</span> Mandar por WhatsApp
        </a>
        <button type="button" class="pc-btn" data-generar-link>
          <span class="material-icons" style="font-size:17px">autorenew</span> Generar otro
        </button>
        <button type="button" class="pc-btn danger" data-anular-link>
          <span class="material-icons" style="font-size:17px">block</span> Anular
        </button>
      </div>`;
  }

  async function guardar(nuevo) {
    try {
      await setDoc(ref, nuevo);
      acceso = nuevo;
      pintar();
    } catch (err) {
      console.warn('[reparto] no se pudo guardar el link:', err);
      alertDialog({ title: 'No se pudo guardar', message: 'Revisá la conexión. Solo un administrador puede cambiar el link.', type: 'error' });
    }
  }

  caja.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-copiar-link]')) {
      const boton = ev.target.closest('[data-copiar-link]');
      try {
        await navigator.clipboard.writeText(linkDe(acceso.clave));
        boton.lastChild.textContent = ' Copiado';
      } catch {
        alertDialog({ title: 'No se pudo copiar', message: 'Seleccioná el link y copialo a mano.', type: 'info' });
      }
      return;
    }

    if (ev.target.closest('[data-generar-link]')) {
      const reemplaza = acceso && !acceso.anulado && acceso.clave;
      if (reemplaza && !(await confirmDialog({
        title: 'Generar otro link',
        message: 'El link actual deja de andar en el celular del repartidor. Vas a tener que mandarle el nuevo.',
        confirmText: 'Generar otro',
      }))) return;
      await guardar({
        clave: claveNueva(),
        version: (Number(acceso?.version) || 0) + 1,
        anulado: false,
        creado: serverTimestamp(),
      });
      return;
    }

    if (ev.target.closest('[data-anular-link]')) {
      if (!(await confirmDialog({
        title: 'Anular el link',
        message: 'Nadie va a poder entrar a la pantalla de reparto hasta que generes uno nuevo.',
        confirmText: 'Anular', danger: true,
      }))) return;
      await guardar({ ...acceso, anulado: true, version: (Number(acceso.version) || 0) + 1, anulado_en: serverTimestamp() });
    }
  });

  try {
    const snap = await getDoc(ref);
    acceso = snap.exists() ? snap.data() : null;
    pintar();
  } catch (err) {
    console.warn('[reparto] no se pudo leer el link:', err?.code || err);
    caja.innerHTML = `<div class="tienda-pista">No se pudo leer el link del repartidor. Revisá la conexión y volvé a abrir esta pantalla.</div>`;
  }
}
