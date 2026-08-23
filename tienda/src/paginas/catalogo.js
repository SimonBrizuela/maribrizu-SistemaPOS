import { cargarConfig, cargarRubros, subrubrosDe, traerProductos, buscar, POR_PAGINA }
  from '../datos.js';
import { grilla, grillaCargando, pie, vacio } from '../componentes.js';
import { esc, nombreBonito } from '../formato.js';
import { icono } from '../iconos.js';
import { ir } from '../router.js';
import { fijarTitulo } from '../seo.js';

export async function catalogo({ montar, params, query }) {
  const rubro = params.rubro ? decodeURIComponent(params.rubro) : null;
  const texto = (query.get('q') || '').trim();
  // El subrubro viaja en la query y no en la ruta: es un refinamiento de lo que
  // se está mirando, y así compartir el enlace del rubro sigue funcionando.
  const sub = (query.get('sub') || '').trim() || null;

  const [cfg, rubros, subrubros] = await Promise.all([
    cargarConfig(), cargarRubros(), subrubrosDe(rubro),
  ]);

  const titulo = texto
    ? `Resultados para «${texto}»`
    : (sub ? nombreBonito(sub) : (rubro ? nombreBonito(rubro) : 'Todo el catálogo'));

  // Cada rubro con su título: "Mercería · Librería Liceo" es lo que Google
  // muestra y por lo que se busca; "Librería Liceo" a secas en 2.300 páginas
  // no distingue una de otra.
  fijarTitulo(texto || sub || rubro
    ? `${titulo} · Librería Liceo`
    : 'Catálogo · Librería Liceo');

  const fichas = [
    `<button class="ficha-filtro ficha-filtro--sin-punto" style="--rubro:var(--ink)"
             data-rubro-filtro="" aria-pressed="${!rubro}">Todo</button>`,
    ...rubros.map(r => `
      <button class="ficha-filtro" data-rubro="${esc(r.clave)}"
              data-rubro-filtro="${esc(r.clave)}"
              aria-pressed="${rubro === r.clave}">${esc(r.nombre)}</button>`),
  ].join('');

  // Librería tiene 150 subrubros. Sueltos son dieciséis filas de pastillas antes
  // del primer producto: la vidriera tapada por su propio índice.
  //
  // A la vista quedan los 14 primeros, que por venir ordenados por cantidad son
  // los que cubren casi todo el rubro. El resto vive en un panel con buscador y
  // scroll propio: abrirlo no empuja la página ni obliga a barrer 150 nombres
  // con el ojo — se tipea "cuaderno" y aparece.
  const A_LA_VISTA = 14;
  const hayPanel = rubro && subrubros.length > A_LA_VISTA;
  const visibles = hayPanel ? subrubros.slice(0, A_LA_VISTA) : subrubros;

  const pastilla = s => `
    <button class="ficha-sub" data-sub-filtro="${esc(s.nombre)}"
            aria-pressed="${sub === s.nombre}">${esc(s.nombre)}
      <span class="ficha-sub__n">${s.cantidad}</span>
    </button>`;

  // El elegido siempre a la vista, aunque esté en el fondo de la lista: si no,
  // el filtro activo no se ve por ningún lado.
  const elegidoOculto = sub && !visibles.some(s => s.nombre === sub)
    ? subrubros.find(s => s.nombre === sub)
    : null;

  // Segunda fila: los subrubros del rubro que se está mirando. Con uno solo no
  // se muestra nada — un filtro que no filtra es ruido.
  const fichasSub = (rubro && subrubros.length > 1) ? [
    `<button class="ficha-sub" data-sub-filtro="" aria-pressed="${!sub}">Todo</button>`,
    ...visibles.map(pastilla),
    elegidoOculto ? pastilla(elegidoOculto) : '',
    hayPanel ? `
      <button class="ficha-sub ficha-sub--mas" data-abrir-subs aria-expanded="false">
        Ver todos <span class="ficha-sub__n">${subrubros.length}</span>
      </button>` : '',
  ].join('') : '';

  // El panel con todos. Nace cerrado y con altura propia: por muchos que sean,
  // la página de atrás no se mueve.
  const panelSubs = hayPanel ? `
    <div class="panel-subs" data-panel-subs hidden>
      <div class="panel-subs__cabecera">
        <input class="panel-subs__buscar" type="search" data-buscar-sub
               placeholder="Buscar filtro…" aria-label="Buscar un filtro"
               autocomplete="off">
        <button class="panel-subs__cerrar" data-cerrar-subs aria-label="Cerrar">
          ${icono('cerrar', { tam: 16 })}
        </button>
      </div>
      <div class="panel-subs__lista" data-lista-subs>
        ${subrubros.map(s => `
          <button class="panel-subs__item" data-sub-filtro="${esc(s.nombre)}"
                  data-nombre="${esc(s.nombre.toLowerCase())}"
                  aria-pressed="${sub === s.nombre}">
            <span>${esc(s.nombre)}</span>
            <span class="ficha-sub__n">${s.cantidad}</span>
          </button>`).join('')}
      </div>
      <p class="panel-subs__vacio" data-sin-subs hidden>Ningún filtro se llama así.</p>
    </div>` : '';


  montar(`
    <div class="contenedor">
      <nav class="migas" aria-label="Dónde estás">
        <a href="/">Inicio</a>
        <span>${icono('derecha', { tam: 12 })}</span>
        ${rubro ? `<a href="/catalogo">Catálogo</a><span>${icono('derecha', { tam: 12 })}</span>
                   ${sub
                     ? `<a href="/catalogo/${encodeURIComponent(rubro)}">${esc(nombreBonito(rubro))}</a>
                        <span>${icono('derecha', { tam: 12 })}</span>
                        <span>${esc(nombreBonito(sub))}</span>`
                     : `<span>${esc(nombreBonito(rubro))}</span>`}`
                : '<span>Catálogo</span>'}
      </nav>
      <h1 style="margin-bottom:var(--e-4)">${esc(titulo)}</h1>
    </div>

    ${texto ? '' : `
      <div class="barra-catalogo">
        <div class="contenedor">
          <div class="filtros" role="group" aria-label="Filtrar por rubro">${fichas}</div>
          ${fichasSub ? `
            <div class="filtros filtros--sub" role="group"
                 aria-label="Filtrar dentro de ${esc(nombreBonito(rubro))}">${fichasSub}</div>
            ${panelSubs}` : ''}
        </div>
      </div>`}

    <div class="contenedor seccion">
      <p class="resultado-cuenta" data-cuenta style="margin-bottom:var(--e-4)"></p>
      <div data-lista>${grillaCargando(10)}</div>
      <div class="cargar-mas" data-mas></div>
    </div>

    ${pie(cfg)}
  `);

  document.querySelectorAll('[data-rubro-filtro]').forEach(boton => {
    boton.addEventListener('click', () => {
      const destino = boton.dataset.rubroFiltro;
      // Cambiar de rubro suelta el subrubro: los de un rubro no existen en otro
      // y quedaría un filtro que no devuelve nada.
      ir(destino ? `/catalogo/${encodeURIComponent(destino)}` : '/catalogo');
    });
  });

  // Panel de filtros: abrir, buscar, cerrar.
  const abrirSubs = document.querySelector('[data-abrir-subs]');
  const panel = document.querySelector('[data-panel-subs]');
  if (abrirSubs && panel) {
    const buscador = panel.querySelector('[data-buscar-sub]');
    const sinNada = panel.querySelector('[data-sin-subs]');

    const cerrar = () => {
      panel.hidden = true;
      abrirSubs.setAttribute('aria-expanded', 'false');
    };

    abrirSubs.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      abrirSubs.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) buscador.focus();
    });

    panel.querySelector('[data-cerrar-subs]').addEventListener('click', cerrar);

    buscador.addEventListener('input', () => {
      const q = buscador.value.trim().toLowerCase();
      let visto = 0;
      panel.querySelectorAll('.panel-subs__item').forEach(it => {
        const entra = !q || it.dataset.nombre.includes(q);
        it.hidden = !entra;
        if (entra) visto += 1;
      });
      sinNada.hidden = visto > 0;
    });

    // Escape cierra, y un clic afuera también: un panel que se queda abierto
    // tapando la grilla es el problema que vinimos a resolver.
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && !panel.hidden) cerrar();
    });
    document.addEventListener('click', ev => {
      if (panel.hidden) return;
      if (!panel.contains(ev.target) && ev.target !== abrirSubs
          && !abrirSubs.contains(ev.target)) cerrar();
    });
  }

  document.querySelectorAll('[data-sub-filtro]').forEach(boton => {
    boton.addEventListener('click', () => {
      const elegido = boton.dataset.subFiltro;
      const base = `/catalogo/${encodeURIComponent(rubro)}`;
      ir(elegido ? `${base}?sub=${encodeURIComponent(elegido)}` : base);
    });
  });

  const lista = document.querySelector('[data-lista]');
  const cuenta = document.querySelector('[data-cuenta]');
  const zonaMas = document.querySelector('[data-mas]');

  /* ── Búsqueda ───────────────────────────────────────────────────────────
     Trae un solo lote y no pagina: quien busca algo puntual mira los primeros
     resultados, y si no está ahí, afina la palabra. */
  if (texto) {
    const encontrados = await buscar(texto);
    if (!encontrados.length) {
      cuenta.textContent = '';
      lista.innerHTML = vacio({
        titulo: `No tenemos nada que coincida con <em>«${esc(texto)}»</em>`,
        texto: 'Puede ser un error de tipeo. Probá escribiendo menos letras, o escribinos y te decimos si lo tenemos en el local.',
        acciones: `
          <a class="boton boton--primario" href="https://wa.me/${esc(cfg.whatsapp)}?text=${
            encodeURIComponent(`Hola, busco: ${texto}`)}" target="_blank" rel="noopener">
            ${icono('whatsapp', { tam: 16 })} Escribinos por WhatsApp
          </a>
          <a class="boton boton--secundario" href="/catalogo">Ver todo el catálogo</a>`,
      });
      return;
    }
    cuenta.textContent = `${encontrados.length} producto${encontrados.length === 1 ? '' : 's'}`;
    lista.innerHTML = grilla(encontrados);
    return;
  }

  /* ── Listado con paginado ──────────────────────────────────────────────── */
  let cursor = null;
  let acumulados = 0;

  // El total sale del mismo agregado que pinta las fichas de la portada.
  // "24+ productos" mientras se pagina leía como si la tienda tuviera
  // veinticuatro cosas; el número entero dice lo que hay de verdad y no
  // cambia con cada "Ver más". Si el agregado no lo trae, se cae al conteo
  // acumulado de antes.
  const totalConocido = texto ? null
    : sub ? (subrubros.find(s => s.nombre === sub)?.cantidad || null)
    : rubro ? (rubros.find(r => r.clave === rubro)?.cantidad || null)
    : (rubros.reduce((t, r) => t + (r.cantidad || 0), 0) || null);

  async function traerTanda(primera) {
    const { productos, cursor: siguiente, hayMas } =
      await traerProductos({ rubro, sub, cursor, cantidad: POR_PAGINA });

    cursor = siguiente;
    acumulados += productos.length;

    if (primera) {
      if (!productos.length) {
        lista.innerHTML = sub
          ? vacio({
              titulo: `No hay nada en <em>${esc(nombreBonito(sub))}</em> por ahora`,
              texto: 'Puede que se haya agotado. Mirá el resto del rubro, que sí tiene cosas.',
              acciones: `<a class="boton boton--primario"
                            href="/catalogo/${encodeURIComponent(rubro)}">Ver todo ${
                              esc(nombreBonito(rubro))}</a>`,
            })
          : vacio({
              titulo: 'Todavía no hay productos en este rubro',
              texto: 'Los vamos cargando de a poco. Mientras tanto podés mirar el resto del catálogo.',
              acciones: '<a class="boton boton--primario" href="/catalogo">Ver todo el catálogo</a>',
            });
        return;
      }
      lista.innerHTML = grilla(productos);
    } else {
      // Se agrega al final sin repintar lo que ya está: repintar la grilla
      // entera reinicia la animación de todas las cards y hace saltar el scroll.
      const caja = document.createElement('div');
      caja.innerHTML = grilla(productos);
      const contenedor = lista.querySelector('.grilla');
      [...caja.querySelectorAll('.card-producto')].forEach((card, i) => {
        card.style.setProperty('--i', String(i));
        contenedor.appendChild(card);
      });
    }

    cuenta.textContent = totalConocido
      ? `${totalConocido.toLocaleString('es-AR')} producto${totalConocido === 1 ? '' : 's'}`
      : `${acumulados}${hayMas ? '+' : ''} producto${acumulados === 1 ? '' : 's'}`;

    zonaMas.innerHTML = hayMas
      ? '<button class="boton boton--secundario boton--grande" data-cargar>Ver más productos</button>'
      : '';

    zonaMas.querySelector('[data-cargar]')?.addEventListener('click', async ev => {
      ev.target.classList.add('boton--cargando');
      await traerTanda(false);
    });
  }

  await traerTanda(true);
}
