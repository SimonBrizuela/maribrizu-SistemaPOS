import './estilos/app.css';

import { ruta, alNavegar, resolver, ir, iniciar as iniciarRutas } from './router.js';
import { cabecera, navInferior, pie, vacio } from './componentes.js';
import { cargarConfig, traerProducto } from './datos.js';
import * as carrito from './carrito.js';
import { abrir as abrirCarrito, estaAbierto } from './panel_carrito.js';
import { avisar } from './avisos.js';

import { inicio } from './paginas/inicio.js';
import { catalogo } from './paginas/catalogo.js';
import { producto } from './paginas/producto.js';

const app = document.getElementById('app');

/* ── Rutas ────────────────────────────────────────────────────────────────── */

ruta('/', inicio);
ruta('/catalogo', catalogo);
ruta('/catalogo/:rubro', catalogo);
ruta('/p/:id', producto);
ruta('/checkout', enConstruccion('Checkout'));
ruta('/seguimiento', enConstruccion('Seguimiento de pedidos'));

/**
 * Las pantallas que todavía no existen lo dicen, en vez de mostrar una página en
 * blanco que parece un error.
 */
function enConstruccion(nombre) {
  return async ({ montar }) => {
    const cfg = await cargarConfig();
    montar(`
      <div class="contenedor">
        ${vacio({
          titulo: `${nombre} todavía no está listo`,
          texto: 'Esta parte de la tienda está en construcción. Tu pedido quedó guardado y no se pierde.',
          acciones: '<a class="boton boton--primario" href="/catalogo">Seguir mirando</a>',
        })}
      </div>
      ${pie(cfg)}`);
  };
}

/* ── Armado de la pantalla ────────────────────────────────────────────────── */

let cabeceraNodo = null;
let navNodo = null;

function pintarEstructura() {
  app.className = 'app';
  app.innerHTML = `
    <div data-cabecera></div>
    <main class="principal" id="principal" tabindex="-1"></main>
    <div data-nav></div>`;
  cabeceraNodo = app.querySelector('[data-cabecera]');
  navNodo = app.querySelector('[data-nav]');
}

/** Repinta solo el encabezado y la barra inferior cuando cambia el carrito. */
function refrescarChrome() {
  const unidades = carrito.unidades();
  const busqueda = new URL(location.href).searchParams.get('q') || '';
  const activo = document.activeElement;
  const editandoBusqueda = activo?.id === 'q';

  // Si el cliente está escribiendo en el buscador no se toca el encabezado:
  // repintarlo le borraría lo que escribió a mitad de palabra.
  if (!editandoBusqueda && cabeceraNodo) {
    cabeceraNodo.innerHTML = cabecera({ unidades, busqueda });
  }
  if (navNodo) {
    navNodo.innerHTML = navInferior(location.pathname, unidades);
  }
}

function montar(html) {
  const principal = app.querySelector('.principal');
  principal.innerHTML = html;
}

async function dibujar() {
  const { vista, params, query, ruta: camino } = resolver();

  if (!vista) {
    const cfg = await cargarConfig();
    document.title = 'No encontramos esta página · Librería Liceo';
    montar(`
      <div class="contenedor">
        ${vacio({
          titulo: 'No encontramos esta página',
          texto: 'Puede que el enlace esté cortado o que la hayamos movido.',
          acciones: '<a class="boton boton--primario" href="/">Ir al inicio</a>',
        })}
      </div>
      ${pie(cfg)}`);
    refrescarChrome();
    return;
  }

  if (camino === '/') document.title = 'Librería Liceo · Librería, mercería y regalería en Córdoba';

  try {
    await vista({ montar, params, query });
  } catch (err) {
    console.error('[app] la pantalla falló:', err);
    montar(`
      <div class="contenedor">
        ${vacio({
          titulo: 'Algo se rompió de nuestro lado',
          texto: 'No pudimos cargar esta pantalla. Probá de nuevo en un momento.',
          acciones: '<button class="boton boton--primario" onclick="location.reload()">Reintentar</button>',
        })}
      </div>`);
  }

  refrescarChrome();
}

/* ── Navegación ───────────────────────────────────────────────────────────── */

alNavegar(async () => {
  await dibujar();
  // Cada pantalla nueva arranca arriba, y el foco va al contenido para que un
  // lector de pantalla no siga leyendo desde el encabezado anterior.
  window.scrollTo({ top: 0, behavior: 'instant' });
  app.querySelector('.principal')?.focus({ preventScroll: true });
});

/* ── Eventos globales ─────────────────────────────────────────────────────── */

// Delegado en el documento: el encabezado y las grillas se repintan todo el
// tiempo, y enganchar cada botón después de cada repintado se olvida siempre en
// algún camino.
document.addEventListener('click', async ev => {
  const abrir = ev.target.closest('[data-abrir-carrito]');
  if (abrir) {
    ev.preventDefault();
    abrirCarrito();
    return;
  }

  const agregar = ev.target.closest('[data-agregar]');
  if (agregar && agregar.dataset.agregar) {
    ev.preventDefault();
    const id = agregar.dataset.agregar;

    // Con variedades el signo lleva a la ficha a elegir: sumar a ciegas cuando
    // hay cinco colores obliga al cliente a corregirlo después.
    if (agregar.dataset.elegir) {
      ir(`/p/${id}`);
      return;
    }

    agregar.disabled = true;
    try {
      const p = await traerProducto(id);
      if (!p) { avisar('Este producto ya no está disponible', { tipo: 'error' }); return; }
      carrito.agregar(p);
      avisar(`Agregaste ${p.nombre}`, {
        accion: { texto: 'Ver pedido', alHacer: abrirCarrito },
      });
    } finally {
      agregar.disabled = false;
    }
  }
});

// Buscador plegable del celular. El foco entra al campo apenas se abre: si
// hubiera que tocar la lupa y después el campo serían dos toques para lo mismo.
document.addEventListener('click', ev => {
  const cabeceraNodo = document.querySelector('.cabecera');
  if (!cabeceraNodo) return;

  if (ev.target.closest('[data-abrir-busqueda]')) {
    cabeceraNodo.setAttribute('data-buscando', '');
    cabeceraNodo.querySelector('#q')?.focus();
  } else if (ev.target.closest('[data-cerrar-busqueda]')) {
    cabeceraNodo.removeAttribute('data-buscando');
  }
});

document.addEventListener('submit', ev => {
  const form = ev.target.closest('[data-buscador]');
  if (!form) return;
  ev.preventDefault();
  const texto = form.querySelector('input')?.value.trim() || '';
  // El teclado del celular se baja al buscar: dejarlo abierto tapa la mitad de
  // los resultados que el cliente acaba de pedir.
  form.querySelector('input')?.blur();
  document.querySelector('.cabecera')?.removeAttribute('data-buscando');
  ir(texto ? `/catalogo?q=${encodeURIComponent(texto)}` : '/catalogo');
});

// El globo del carrito y el contador de la barra inferior siguen al carrito sin
// que cada pantalla tenga que acordarse de actualizarlos.
carrito.suscribir(() => { if (!estaAbierto()) refrescarChrome(); });

/* ── Arranque ─────────────────────────────────────────────────────────────── */

async function arrancar() {
  pintarEstructura();
  iniciarRutas();
  await dibujar();

  // Aviso de tienda cerrada: se consulta después del primer pintado para no
  // demorar la portada por un caso que casi nunca pasa.
  const cfg = await cargarConfig();
  if (cfg.abierta === false) {
    const aviso = document.createElement('div');
    aviso.className = 'aviso-cerrada';
    aviso.setAttribute('role', 'status');
    aviso.textContent = 'La tienda está cerrada por ahora. Podés mirar el catálogo, pero no tomamos pedidos.';
    cabeceraNodo.after(aviso);
  }
}

arrancar();
