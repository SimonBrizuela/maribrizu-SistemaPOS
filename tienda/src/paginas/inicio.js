import { cargarConfig, cargarRubros, traerDestacados, traerProductos } from '../datos.js';
import { plegarGrupos } from '../grupos.js';
import { cardProducto, grilla, grillaCargando, pie } from '../componentes.js';
import { franjaMarca, icono, iconoDeRubro, resplandores } from '../iconos.js';
import { esc } from '../formato.js';
import { fijarNegocio } from '../seo.js';
import { cargaContinua } from '../carga_continua.js';

/**
 * En cuántas columnas se reparten las fichas de rubro.
 *
 * Dejar que entren las que quepan parte la fila donde cae: con ocho rubros en
 * una pantalla de PC entraban seis arriba y quedaban dos abajo con medio bloque
 * vacío al lado. En el celular no se notaba porque entran de a una o dos y
 * siempre cierran.
 *
 * Se elige el ancho que deja menos lugares vacíos en la última fila, y entre dos
 * que empatan gana el que hace menos filas. Ocho da cuatro columnas: dos filas
 * llenas. Nueve da tres, que son tres filas de tres.
 *
 * @param {number} cantidad  cuántos rubros hay que acomodar
 */
export function columnasParaRubros(cantidad, { min = 3, max = 6 } = {}) {
  if (cantidad <= min) return Math.max(1, cantidad);
  let mejor = max;
  let vacios = Infinity;
  for (let columnas = max; columnas >= min; columnas -= 1) {
    const sobran = (columnas - (cantidad % columnas)) % columnas;
    if (sobran < vacios) { vacios = sobran; mejor = columnas; }
  }
  return mejor;
}

// Cuántos productos trae una tira de entrada y en cada tanda al deslizar.
const TANDA_TIRA = 12;

/**
 * Imagen de la portada.
 *
 * Antes eran fichas de color armadas con CSS, con el nombre de cada rubro
 * escrito adentro. Cumplian mientras no hubo ninguna foto en el catalogo, pero
 * eran cinco rectangulos con texto: decian que se vende sin mostrarlo. La
 * imagen mantiene el mismo recurso grafico de la marca (fichas de color
 * inclinadas sobre negro) y ademas trae los productos de verdad.
 *
 * Va como <img> y no como fondo en CSS para que el navegador la trate como
 * contenido: la descarga con prioridad alta, la puede servir en el tamano que
 * corresponde y no desaparece al imprimir.
 *
 * aria-hidden porque no aporta nada que no diga ya el titulo de al lado. Que un
 * lector de pantalla lea "cuadernos, hilos, mochilas, temperas, regalos"
 * despues del titulo es repetir el menu en desorden.
 */
function ilustracion() {
  return `
    <div class="portada__imagen entra entra--pieza" style="--entra-orden:2" aria-hidden="true">
      <img src="/portada.webp" alt="" width="1200" height="800"
           fetchpriority="high" decoding="async">
    </div>`;
}

/**
 * La misma idea que `ilustracion()` pero para el celular.
 *
 * Son dos imagenes distintas y no la misma escalada: la de escritorio es
 * apaisada y ocupa la mitad derecha de la portada; en una pantalla de 390 px esa
 * proporcion deja una franja de 120 px de alto donde no se distingue nada.
 *
 * Va de fondo de la portada entera y bien difuminada. Nitida detras del texto no
 * se puede: para que el blanco se lea sobre la mochila violeta hace falta un
 * velo tan cargado que apaga la foto. Desenfocada deja de competir —queda como
 * luz de color, no como imagen— y el texto se lee sin pelear con nada.
 *
 * Ademas no le cuesta un pixel de altura a la portada, que es la razon por la
 * que la imagen estaba oculta en el celular: el boton "Ver el catalogo" tiene
 * que entrar en la primera pantalla.
 *
 * El archivo va chico a proposito, 360 px de ancho y 17 kB. Con 26 px de
 * desenfoque el detalle no sobrevive, asi que mandar la version grande seria
 * gastar 86 kB del plan de datos del cliente para que se vean las mismas
 * manchas de color.
 */
function ilustracionMovil() {
  return `
    <div class="portada__fondo entra entra--fondo" aria-hidden="true">
      <img src="/portada-movil.webp"
           srcset="/portada-movil.webp 480w, /portada-movil@2x.webp 960w"
           sizes="100vw" alt="" width="480" height="596"
           fetchpriority="high" decoding="async">
    </div>`;
}

/**
 * Las cards de una tira con sus flechas.
 *
 * La tira se desliza de costado en cualquier pantalla: con el dedo en el
 * celular y con las flechas en la computadora. Al final va el centinela que
 * avisa que se acerca el borde y hay que traer más (ver `montarTira`).
 */
function pistaConFlechas(nombre, cardsHtml, { conMas = false } = {}) {
  return `
    <div class="tira__cuerpo">
      <button type="button" class="tira__flecha tira__flecha--anterior" data-tira-anterior
              aria-label="Ver los anteriores de ${esc(nombre)}" hidden>
        ${icono('izquierda', { tam: 20, grosor: 2.5 })}
      </button>
      <div class="tira__productos" data-tira-pista>
        ${cardsHtml}
        ${conMas ? '<span class="tira__centinela" data-centinela-tira aria-hidden="true"></span>' : ''}
      </div>
      <button type="button" class="tira__flecha tira__flecha--siguiente" data-tira-siguiente
              aria-label="Ver más de ${esc(nombre)}">
        ${icono('derecha', { tam: 20, grosor: 2.5 })}
      </button>
    </div>`;
}

/** Una tira de productos de un rubro. */
function tira(rubro, productos, { hayMas = false } = {}) {
  // El mismo número que la ficha de arriba: lo que se puede comprar hoy. Con
  // `cantidad` acá y `con_stock` allá, la misma pantalla decía 4.163 y 1.024 del
  // mismo rubro, y eso hace dudar de los dos.
  const hay = rubro.con_stock ?? rubro.cantidad;
  return `
    <section class="tira" data-rubro="${esc(rubro.clave)}">
      <div class="tira__cabecera">
        <span class="tira__marca"></span>
        <h2 class="tira__titulo">${esc(rubro.nombre)}</h2>
        <span class="tira__cuenta">${hay.toLocaleString('es-AR')}</span>
        <a class="tira__ver" href="/catalogo/${encodeURIComponent(rubro.clave)}">Ver todo</a>
      </div>
      ${pistaConFlechas(rubro.nombre,
        productos.map((p, i) => cardProducto(p, i, { conRubro: false })).join(''),
        { conMas: hayMas })}
    </section>`;
}

const movimientoQuieto = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

/**
 * Las flechas de una tira: corren de a casi una pantalla (queda asomando una
 * card de la anterior, para no perder el hilo) y se esconden donde no hay a
 * dónde ir. La de la derecha sigue a la vista mientras falten tandas.
 */
function montarFlechas(seccion) {
  const pista = seccion.querySelector('[data-tira-pista]');
  const anterior = seccion.querySelector('[data-tira-anterior]');
  const siguiente = seccion.querySelector('[data-tira-siguiente]');
  if (!pista || !anterior || !siguiente) return () => {};

  const correr = sentido => pista.scrollBy({
    left: sentido * pista.clientWidth * 0.85,
    behavior: movimientoQuieto() ? 'auto' : 'smooth',
  });
  anterior.addEventListener('click', () => correr(-1));
  siguiente.addEventListener('click', () => correr(1));

  const actualizar = () => {
    const fin = pista.scrollWidth - pista.clientWidth;
    anterior.hidden = pista.scrollLeft <= 2;
    siguiente.hidden = pista.scrollLeft >= fin - 2 && !pista.querySelector('[data-centinela-tira]');
  };
  pista.addEventListener('scroll', actualizar, { passive: true });
  // El ancho cambia al achicar la ventana: con el mouse encima se recalcula.
  seccion.addEventListener('pointerenter', actualizar);
  requestAnimationFrame(actualizar);
  return actualizar;
}

/**
 * Trae más productos del rubro cuando la tira se acerca a su final, de a
 * `TANDA_TIRA`, siguiendo el cursor de la base. Los tamaños de un grupo que ya
 * salió no vuelven a dibujar su card.
 */
function montarTira(seccion, { rubro, cursor, vistos, cantidad }) {
  const pista = seccion.querySelector('[data-tira-pista]');
  const centinela = pista?.querySelector('[data-centinela-tira]');
  const actualizarFlechas = montarFlechas(seccion);
  if (!centinela) return;

  let siguiente = cursor;
  let indice = cantidad;

  cargaContinua({
    centinela,
    raiz: pista,
    horizontal: true,
    margen: '600px',
    async cargar() {
      const tanda = await traerProductos({ rubro: rubro.clave, cursor: siguiente, cantidad: TANDA_TIRA });
      siguiente = tanda.cursor;
      const molde = document.createElement('div');
      molde.innerHTML = plegarGrupos(tanda.productos, vistos)
        .map((p, i) => cardProducto(p, indice + i, { conRubro: false })).join('');
      const nuevas = [...molde.children];
      nuevas.forEach(card => pista.insertBefore(card, centinela));
      indice += nuevas.length;
      return Boolean(tanda.hayMas);
    },
    alCargar: trayendo => pista.classList.toggle('tira__productos--cargando', trayendo),
    alTerminar: () => { centinela.remove(); actualizarFlechas(); },
    alFallar: (_err, reintentar) => {
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'tira__reintentar';
      boton.textContent = 'No se pudieron traer más. Probar de nuevo';
      boton.addEventListener('click', () => { boton.remove(); reintentar(); });
      pista.insertBefore(boton, centinela);
    },
  });
}

export async function inicio({ montar }) {
  const cfg = await cargarConfig();

  // Direccion, telefono y horario, en la forma que Google entiende. Es lo que
  // hace la diferencia entre aparecer en una lista de resultados y aparecer en
  // el panel de la derecha con el mapa al lado, que para una libreria de barrio
  // es la busqueda que mas vende.
  fijarNegocio(cfg);

  // La portada se pinta antes de tener productos: no depende de ninguna consulta,
  // así que aparece de inmediato y la primera pantalla nunca está en blanco.
  montar(`
    <section class="marco-oscuro marco-oscuro--vivo portada">
      ${ilustracionMovil()}
      ${resplandores()}
      <div class="contenedor portada__hero" style="padding-block:var(--e-7)">
        <div class="portada__cuerpo">
          <div>
            <p class="portada__lugar entra" style="--entra-orden:0">Córdoba · Parque Liceo</p>
            <h1 class="portada__titulo entra" style="--entra-orden:1">Todo para el cole, la casa y el regalo</h1>
            <p class="portada__bajada entra" style="--entra-orden:2">
              Somos la librería de la esquina, con el catálogo entero en tu celular.
              Te lo llevamos a tu casa o lo pasás a buscar cuando te queda cómodo.
            </p>
            <div class="portada__acciones entra" style="--entra-orden:3">
              <a class="boton boton--primario boton--grande" href="/catalogo">
                Ver el catálogo ${icono('derecha', { tam: 18, grosor: 2.5 })}
              </a>
              <a class="boton boton--grande boton--sobre-negro"
                 href="https://maps.google.com/?q=${encodeURIComponent(cfg.direccion)}"
                 target="_blank" rel="noopener">
                ${icono('pin', { tam: 18 })} Cómo llegar
              </a>
            </div>
          </div>
          ${ilustracion()}
        </div>
      </div>

      <div class="contenedor" style="padding-bottom:var(--e-7)">
        <div class="rubros" data-rubros>
          ${Array(6).fill('<div class="esqueleto" style="height:76px;border-radius:var(--r-md)"></div>').join('')}
        </div>
      </div>

      ${franjaMarca({ entra: true })}
    </section>

    <div class="contenedor seccion" data-tiras>
      ${grillaCargando(6)}
    </div>

    <section class="marco-oscuro marco-oscuro--vivo">
      ${franjaMarca()}
      ${resplandores()}
      <div class="contenedor">
        <div class="pasos">
          <div style="--paso-color:var(--liceo-violeta)">
            <div class="pasos__numero">01</div>
            <h3>Armás el pedido</h3>
            <p>Buscás lo que necesitás y lo vas cargando. Sin registrarte ni crear una cuenta.</p>
          </div>
          <div style="--paso-color:var(--liceo-cyan)">
            <div class="pasos__numero">02</div>
            <h3>Elegís cómo lo recibís</h3>
            <p>Te lo llevamos a tu casa en Córdoba, o lo pasás a buscar por el local sin costo.</p>
          </div>
          <div style="--paso-color:var(--liceo-verde)">
            <div class="pasos__numero">03</div>
            <h3>Pagás al recibirlo</h3>
            <p>${cfg.pago?.efectivo_habilitado === true ? 'Efectivo o transferencia' : 'Por transferencia'
              }, cuando el pedido ya está en tus manos. Demora ${esc(cfg.entrega.demora_texto)}.</p>
          </div>
        </div>
      </div>
    </section>

    ${pie(cfg)}
  `);

  const rubros = await cargarRubros();

  // La portada es vidriera, no índice. Un rubro con "1 disponible" al lado de
  // los de ochocientos hace ver vacía la tienda entera: abajo de cinco
  // productos con stock no gana ficha ni tira. Sigue entero en el catálogo y
  // en la búsqueda. Si ninguno llega al corte —catálogo recién cargado— se
  // muestran todos, que una portada pelada es peor.
  const CORTE_PORTADA = 5;
  const conStock = r => r.con_stock ?? r.cantidad;
  const vidriera = (lista => lista.length ? lista : rubros)(
    rubros.filter(r => conStock(r) >= CORTE_PORTADA));

  // Las fichas son el menú, no la vidriera: van todos los rubros que existen en
  // el catálogo. Antes se les aplicaba el mismo corte que a las tiras y la
  // portada ofrecía seis rubros contra los ocho del catálogo — Cotillón y
  // Mercería no estaban por ningún lado, y desde la portada no había forma de
  // saber que existían.

  const cajaRubros = document.querySelector('[data-rubros]');
  if (cajaRubros) {
    // El ancho de la grilla sale de cuántos rubros hay, para que la última fila
    // no quede a medio llenar. El CSS lo usa solo de 700 px para arriba: en el
    // celular las fichas entran de a una o dos y ya cierran solas.
    cajaRubros.style.setProperty('--columnas-rubros', columnasParaRubros(rubros.length));

    // Las fichas entran escalonadas igual que el texto de arriba, pero el
    // reloj les arranca acá, cuando se insertan, y no cuando se pintó la
    // portada: llegan después de consultar los rubros y encadenarlas al
    // retraso original las dejaría apareciendo de a una con la consulta ya
    // resuelta.
    // Sin contador. Un número al lado del nombre no ayuda a elegir a dónde
    // entrar: "888" no dice nada y "6" avisa que ahí no hay nada, y con los dos
    // en la misma fila la tienda entera se lee flaca. Lo que hay de cada rubro
    // se ve entrando, que es lo que el menú tiene que conseguir.
    cajaRubros.innerHTML = rubros.map((r, i) => `
      <a class="rubro-ficha entra" style="--entra-orden:${i}"
         data-rubro="${esc(r.clave)}" href="/catalogo/${encodeURIComponent(r.clave)}">
        <span class="rubro-ficha__icono">${icono(iconoDeRubro(r.clave), { tam: 20 })}</span>
        <span class="rubro-ficha__texto">
          <span class="rubro-ficha__nombre">${esc(r.nombre)}</span>
        </span>
      </a>`).join('');

  }

  const cajaTiras = document.querySelector('[data-tiras]');
  if (!cajaTiras) return;

  const destacados = await traerDestacados(12);

  // Las consultas de todos los rubros salen juntas. En serie serían seis viajes
  // encadenados y la portada tardaría seis veces más en llenarse.
  const conProductos = await Promise.all(
    vidriera.map(async r => {
      // Cada tira arranca en el principio de su rubro: el sync pone arriba los
      // destacados y lo que más se vende, y después sigue de la A a la Z. Antes
      // saltaba a un punto al azar para variar la portada; ahora que la tira se
      // desliza y va trayendo más, arrancar en el medio escondería justo lo
      // que la gente compra.
      const tanda = await traerProductos({ rubro: r.clave, cantidad: TANDA_TIRA });
      return { rubro: r, productos: tanda.productos, cursor: tanda.cursor, hayMas: Boolean(tanda.hayMas) };
    }),
  );

  const partes = [];

  // Los destacados van arriba de todo, cuando existan. Mientras nadie marque
  // ninguno desde el panel, esta sección simplemente no aparece: un título
  // "Lo más pedido" sobre productos elegidos por orden alfabético es mentira, y
  // se nota apenas mirás lo que hay abajo.
  if (destacados.length) {
    partes.push(`
      <section class="tira">
        <div class="tira__cabecera">
          <span class="tira__marca" style="background:var(--liceo-rojo)"></span>
          <h2 class="tira__titulo">Lo más pedido</h2>
          <a class="tira__ver" href="/catalogo" style="color:var(--primary-txt)">Ver todo</a>
        </div>
        ${pistaConFlechas('Lo más pedido',
          plegarGrupos(destacados).map((p, i) => cardProducto(p, i, { conDestacado: false })).join(''))}
      </section>`);
  }

  // Una tira con una sola card se lee como un rubro vacío, que es peor que no
  // mostrarlo: "Papelera" con un producto suelto dice que ahí no hay nada. El
  // rubro sigue en las fichas de arriba y en el catálogo entero. Si ninguna
  // llega al corte —catálogo recién cargado— se muestran las que haya, que una
  // portada sin productos es peor.
  const MINIMO_TIRA = 3;
  const conCards = conProductos
    .map(x => {
      const vistos = new Set();
      return { ...x, vistos, cards: plegarGrupos(x.productos, vistos) };
    })
    .filter(x => x.cards.length);
  const llenas = conCards.filter(x => x.cards.length >= MINIMO_TIRA);
  const visibles = llenas.length ? llenas : conCards;

  partes.push(...visibles.map(x => tira(x.rubro, x.cards, { hayMas: x.hayMas })));

  cajaTiras.innerHTML = partes.length
    ? partes.join('')
    : '<p style="color:var(--text-2)">Estamos cargando el catálogo. Volvé en un rato.</p>';

  cajaTiras.querySelectorAll('.tira').forEach(seccion => {
    const datosTira = visibles.find(x => x.rubro.clave === seccion.dataset.rubro);
    if (!datosTira) { montarFlechas(seccion); return; }
    montarTira(seccion, {
      rubro: datosTira.rubro, cursor: datosTira.cursor, vistos: datosTira.vistos,
      cantidad: datosTira.cards.length,
    });
  });
}
