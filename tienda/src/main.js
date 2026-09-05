import './estilos/app.css';

import { ruta, alNavegar, resolver, ir, iniciar as iniciarRutas } from './router.js';
import { cabecera, navInferior, pie, vacio } from './componentes.js';
import { cargarConfig, traerProducto } from './datos.js';
import * as carrito from './carrito.js';
import { abrir as abrirCarrito, estaAbierto } from './panel_carrito.js';
import { avisar } from './avisos.js';
import { iniciarSugerencias, fijarAmbito, cerrarSugerencias } from './sugerencias.js';
import { iniciarAsistente, refrescarAsistente } from './asistente.js';
import { iniciarBarraPedido, refrescarBarraPedido } from './barra_pedido.js';
import { iniciarCuenta } from './cuenta.js';
import { estadoDelLocal, textoDeCerrado } from './horarios.js';
import { aplicarModoDesdeURL, engancharTildes, iniciarBarraFotos } from './fotos.js';
import { fijarPantalla } from './seo.js';

import { inicio } from './paginas/inicio.js';
import { catalogo } from './paginas/catalogo.js';
import { producto } from './paginas/producto.js';
import { checkout } from './paginas/checkout.js';
import { pedido } from './paginas/pedido.js';
import { seguimiento } from './paginas/seguimiento.js';
import { cuenta } from './paginas/cuenta.js';

const app = document.getElementById('app');

/* ── Rutas ────────────────────────────────────────────────────────────────── */

ruta('/', inicio);
ruta('/catalogo', catalogo);
ruta('/catalogo/:rubro', catalogo);
ruta('/p/:id', producto);
ruta('/checkout', checkout);
ruta('/pedido/:id', pedido);
ruta('/seguimiento', seguimiento);
ruta('/cuenta', cuenta);

/* ── Armado de la pantalla ────────────────────────────────────────────────── */

let cabeceraNodo = null;
let navNodo = null;

let reponerCompacta = () => {};

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
  reponerCompacta();
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
    fijarPantalla({ privada: true });
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

  // Lo que se le dice a Google de esta pantalla. Las de una sola persona
  // (pedido, checkout, cuenta) no se indexan nunca; las demás, salvo que la
  // tienda esté corriendo en un host de prueba.
  fijarPantalla({
    privada: ['/checkout', '/pedido', '/seguimiento', '/cuenta']
      .some(r => camino === r || camino.startsWith(`${r}/`)),
  });

  // El buscador sabe dónde está parada la persona: en /catalogo/PAPELERA
  // sugiere dentro de Papelera y lo dice, con la salida a todo el catálogo a un
  // toque. La ficha de un producto fija el suyo, que es el rubro del producto.
  if (camino !== '/p') fijarAmbito(params.rubro ? decodeURIComponent(params.rubro) : null);

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
  cerrarSugerencias();
  await dibujar();
  // Ni la barra del pedido ni el botón del chat van en todas las pantallas: en
  // el checkout una tapa las opciones de entrega y el otro se apoya sobre
  // "Confirmar el pedido".
  refrescarBarraPedido();
  refrescarAsistente();
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
      // Sin aviso: la barra de abajo muestra la foto entrando y el total
      // moverse, y a diferencia del aviso se queda ahí mientras se sigue
      // comprando.
      carrito.agregar(p, { esPack: carrito.soloPack(p) });
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

/* ── El encabezado se queda ────────────────────────────────────────────────────
   No se esconde al bajar. La version anterior lo hacia y en la mano se sentia
   como que la barra se escapa: bajabas, desaparecia, y para buscar algo habia
   que hacer un gesto hacia arriba primero.

   Lo unico que cambia con el scroll es que se compacta y levanta sombra apenas
   se despega del tope, para que se lea como una capa por encima del contenido
   en vez de como parte de la pagina. */
function seguirScroll() {
  let compacta = false;
  let pendiente = false;

  function evaluar() {
    pendiente = false;
    // Histeresis: se compacta a los 24 px y se vuelve a expandir recien abajo de
    // 8. Con un solo umbral, quedar justo en el limite hace que la barra cambie
    // de alto en cada micromovimiento del scroll.
    const y = window.scrollY;
    const deberia = compacta ? y > 8 : y > 24;
    if (deberia === compacta) return;

    compacta = deberia;
    document.querySelector('.cabecera')?.classList.toggle('cabecera--compacta', compacta);
  }

  // Listener pasivo y el trabajo en el cuadro siguiente: leer scrollY dentro del
  // evento fuerza al navegador a recalcular el layout en medio del scroll, que
  // es lo que lo hace ir a los tirones.
  window.addEventListener('scroll', () => {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(evaluar);
  }, { passive: true });

  // El estado se vuelve a aplicar despues de cada repintado del encabezado, que
  // reemplaza el elemento y se lleva la clase puesta.
  return () => document.querySelector('.cabecera')
    ?.classList.toggle('cabecera--compacta', compacta);
}

/* ── Arranque ─────────────────────────────────────────────────────────────── */

async function arrancar() {
  // Antes de pintar: las cards preguntan si el modo fotos está prendido
  // mientras se arman, así que llegar tarde las dejaría sin tilde.
  aplicarModoDesdeURL();

  pintarEstructura();
  iniciarRutas();
  reponerCompacta = seguirScroll();
  iniciarSugerencias();
  await dibujar();

  // La barra que muestra lo que se va llevando. Se monta después del primer
  // pintado igual que el chat, pero antes que él: si el carrito ya tiene algo
  // de una visita anterior, tiene que aparecer enseguida.
  iniciarBarraPedido();

  // Marcado de fotos. El listener va siempre —es uno solo y no cuesta nada—,
  // pero la barra de abajo solo aparece con el modo prendido.
  engancharTildes();
  iniciarBarraFotos();

  // La sesión se retoma sola si había una. El SDK de Auth se descarga recién
  // ahí: quien nunca creó cuenta no paga esos 40 kB.
  iniciarCuenta();

  // El chat se agrega después del primer pintado: es un extra sobre el
  // catálogo, y montarlo antes le agrega trabajo a la primera pantalla, que es
  // la que decide si alguien se queda.
  iniciarAsistente();

  // Los avisos de arriba de todo se consultan después del primer pintado: son
  // casos que casi nunca pasan y no valen demorar la portada.
  //
  // Si están los dos, el de cerrada va primero: es el que cambia lo que la
  // persona puede hacer.
  const cfg = await cargarConfig();
  const estado = estadoDelLocal(cfg);
  const avisos = [];
  if (!estado.abierto) {
    avisos.push(['aviso-cerrada', textoDeCerrado(estado)]);
  }
  if (cfg.banner) avisos.push(['aviso-banner', String(cfg.banner)]);

  avisos.reverse().forEach(([clase, texto]) => {
    const aviso = document.createElement('div');
    aviso.className = clase;
    aviso.setAttribute('role', 'status');
    aviso.textContent = texto;
    cabeceraNodo.after(aviso);
  });
}

arrancar();
