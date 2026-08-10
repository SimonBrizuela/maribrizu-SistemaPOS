/**
 * Entrar, crear cuenta y recuperar la contraseña.
 *
 * Una sola pantalla con tres estados en vez de tres pantallas: son el mismo
 * formulario con un campo de más o de menos, y quien se equivocó de opción
 * cambia sin perder lo que escribió.
 *
 * Tener cuenta no hace falta para comprar y la pantalla lo dice. Sirve para que
 * la tienda se acuerde de los datos y para ver los pedidos desde cualquier
 * aparato.
 */
import { cargarConfig } from '../datos.js';
import { pie } from '../componentes.js';
import { esc } from '../formato.js';
import { icono } from '../iconos.js';
import { avisar } from '../avisos.js';
import { ir } from '../router.js';
import {
  sesion, entrar, crearCuenta, entrarConGoogle, recuperarClave, salir,
  datosParaCompletar, iniciarCuenta,
} from '../cuenta.js';

const TITULOS = {
  entrar: 'Entrá a tu cuenta',
  crear: 'Creá tu cuenta',
  olvide: 'Recuperar la contraseña',
};

/** Los errores de Firebase, dichos como se los diría una persona. */
const ERRORES = {
  'auth/invalid-email': 'Ese correo no parece un correo.',
  'auth/invalid-credential': 'El correo o la contraseña no coinciden.',
  'auth/wrong-password': 'El correo o la contraseña no coinciden.',
  'auth/user-not-found': 'El correo o la contraseña no coinciden.',
  'auth/email-already-in-use': 'Ya hay una cuenta con ese correo. Probá entrando.',
  'auth/weak-password': 'La contraseña tiene que tener al menos 6 caracteres.',
  'auth/too-many-requests': 'Probaste muchas veces seguidas. Esperá un momento.',
  'auth/popup-closed-by-user': 'Se cerró la ventana de Google antes de terminar.',
  'auth/network-request-failed': 'No hay conexión. Probá de nuevo.',
};

function loQueSalioMal(err) {
  return ERRORES[err?.code] || 'No pudimos completarlo. Probá de nuevo en un momento.';
}

export async function cuenta({ montar, query }) {
  const cfg = await cargarConfig();
  await iniciarCuenta({ forzar: true });

  document.title = 'Tu cuenta · Librería Liceo';

  if (sesion()) {
    montar(`${miCuenta(cfg)}${pie(cfg)}`);
    engancharSesionAbierta();
    return;
  }

  // Se puede llegar acá desde el checkout: al terminar, vuelve ahí.
  const volverA = query?.get('volver') || '/seguimiento';
  let estado = query?.get('crear') ? 'crear' : 'entrar';

  function pintar() {
    montar(`${formulario(estado)}${pie(cfg)}`);
    enganchar();
  }

  function enganchar() {
    const form = document.querySelector('[data-form-cuenta]');
    const boton = form.querySelector('[type=submit]');

    document.querySelectorAll('[data-estado]').forEach(b => {
      b.addEventListener('click', () => { estado = b.dataset.estado; pintar(); });
    });

    document.querySelector('[data-google]')?.addEventListener('click', async () => {
      try {
        await entrarConGoogle();
        avisar('Listo, entraste.');
        ir(volverA);
      } catch (err) {
        if (err?.code !== 'auth/popup-closed-by-user') console.warn('[cuenta]', err);
        avisar(loQueSalioMal(err), { tipo: 'error' });
      }
    });

    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const dato = id => (document.getElementById(id)?.value || '').trim();

      boton.disabled = true;
      const textoAntes = boton.textContent;
      boton.textContent = 'Un momento…';

      try {
        if (estado === 'olvide') {
          await recuperarClave(dato('email'));
          // El mismo mensaje exista o no la cuenta: contestar "no existe"
          // convertiría esto en una forma de averiguar quién compra acá.
          avisar('Si hay una cuenta con ese correo, te llega el enlace para '
               + 'cambiar la contraseña.', { duracion: 8000 });
          estado = 'entrar';
          pintar();
          return;
        }

        if (estado === 'crear') {
          await crearCuenta({
            email: dato('email'), clave: dato('clave'),
            nombre: dato('nombre'), telefono: dato('telefono'),
          });
          avisar('Cuenta creada. Ya guardamos tus datos.');
        } else {
          await entrar({ email: dato('email'), clave: dato('clave') });
          avisar('Listo, entraste.');
        }
        ir(volverA);
      } catch (err) {
        console.warn('[cuenta]', err?.code || err);
        avisar(loQueSalioMal(err), { tipo: 'error', duracion: 7000 });
        boton.disabled = false;
        boton.textContent = textoAntes;
      }
    });
  }

  pintar();
}

/* ── Pantallas ────────────────────────────────────────────────────────────── */

function formulario(estado) {
  const guardado = datosParaCompletar();

  return `
    <div class="contenedor contenedor--angosto" style="padding-block:var(--e-7)">
      <h1 class="checkout__titulo">${TITULOS[estado]}</h1>
      <p class="cuenta__bajada">
        No hace falta para comprar. Sirve para que no tengas que escribir tus
        datos cada vez y para ver tus pedidos desde cualquier teléfono.
      </p>

      <form class="cuenta__form" data-form-cuenta novalidate>
        ${estado === 'crear' ? `
          <div class="campo">
            <label class="campo__label" for="nombre" data-obligatorio>Nombre y apellido</label>
            <input class="campo__control" id="nombre" type="text" autocomplete="name"
                   maxlength="80" required value="${esc(guardado?.nombre || '')}">
          </div>
          <div class="campo">
            <label class="campo__label" for="telefono" data-obligatorio>Teléfono</label>
            <input class="campo__control" id="telefono" type="tel" autocomplete="tel"
                   inputmode="tel" maxlength="30" required
                   value="${esc(guardado?.telefono || '')}">
            <span class="campo__ayuda">Para avisarte cuando el pedido esté listo.</span>
          </div>` : ''}

        <div class="campo">
          <label class="campo__label" for="email" data-obligatorio>Correo</label>
          <input class="campo__control" id="email" type="email" autocomplete="email"
                 inputmode="email" maxlength="120" required placeholder="vos@correo.com">
        </div>

        ${estado !== 'olvide' ? `
          <div class="campo">
            <label class="campo__label" for="clave" data-obligatorio>Contraseña</label>
            <input class="campo__control" id="clave" type="password" required
                   minlength="6" maxlength="64"
                   autocomplete="${estado === 'crear' ? 'new-password' : 'current-password'}">
            ${estado === 'crear'
              ? '<span class="campo__ayuda">Al menos 6 caracteres.</span>'
              : `<button type="button" class="cuenta__enlace" data-estado="olvide">
                   Me olvidé la contraseña
                 </button>`}
          </div>` : `
          <p class="campo__ayuda" style="margin-bottom:var(--e-4)">
            Te mandamos un enlace para elegir una contraseña nueva.
          </p>`}

        <button type="submit" class="boton boton--primario boton--grande boton--bloque">
          ${estado === 'crear' ? 'Crear la cuenta'
            : estado === 'olvide' ? 'Mandarme el enlace' : 'Entrar'}
        </button>
      </form>

      ${estado !== 'olvide' ? `
        <div class="cuenta__separador"><span>o</span></div>
        <button type="button" class="boton boton--secundario boton--bloque" data-google>
          Entrar con Google
        </button>` : ''}

      <p class="cuenta__pie">
        ${estado === 'crear'
          ? '¿Ya tenés cuenta? <button type="button" class="cuenta__enlace" data-estado="entrar">Entrá</button>'
          : estado === 'olvide'
            ? '<button type="button" class="cuenta__enlace" data-estado="entrar">Volver</button>'
            : '¿Es tu primera vez? <button type="button" class="cuenta__enlace" data-estado="crear">Creá tu cuenta</button>'}
      </p>
    </div>`;
}

function miCuenta(cfg) {
  const s = sesion();
  const datos = datosParaCompletar();
  const direccion = datos?.direcciones?.[0];

  return `
    <div class="contenedor contenedor--angosto" style="padding-block:var(--e-7)">
      <h1 class="checkout__titulo">Tu cuenta</h1>

      <div class="cuenta__ficha">
        <p class="cuenta__dato"><span>Correo</span><strong>${esc(s.email || '')}</strong></p>
        ${datos?.nombre ? `<p class="cuenta__dato"><span>Nombre</span><strong>${esc(datos.nombre)}</strong></p>` : ''}
        ${datos?.telefono ? `<p class="cuenta__dato"><span>Teléfono</span><strong>${esc(datos.telefono)}</strong></p>` : ''}
        ${direccion ? `<p class="cuenta__dato"><span>Dirección</span><strong>${esc(direccion.direccion)}</strong></p>` : ''}
      </div>

      <p class="cuenta__bajada">
        Tus datos se completan solos al hacer un pedido. Si cambiás algo en el
        checkout, queda guardado acá.
      </p>

      <div class="cuenta__acciones">
        <a class="boton boton--primario" href="/seguimiento">Ver mis pedidos</a>
        <a class="boton boton--secundario" href="/catalogo">Seguir comprando</a>
        <button type="button" class="boton boton--fantasma" data-salir>Cerrar sesión</button>
      </div>
    </div>`;
}

function engancharSesionAbierta() {
  document.querySelector('[data-salir]')?.addEventListener('click', async () => {
    await salir();
    avisar('Cerraste sesión.');
    ir('/');
  });
}
