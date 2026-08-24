import { cargarConfig, cargarAvisos, avisoDe, traerProducto, traerProductos } from '../datos.js';
import { grilla, pie, vacio, conArticulo } from '../componentes.js';
import { pesos, esc, nombreBonito, colorDeVariedad } from '../formato.js';
import { icono } from '../iconos.js';
import * as carrito from '../carrito.js';
import { avisar } from '../avisos.js';
import { montarCinta } from '../cinta.js';
import { fijarAmbito } from '../sugerencias.js';
import { fijarTitulo, fijarProducto } from '../seo.js';
import { htmlGaleria, montarGaleria } from '../galeria.js';
import { botonFotoFicha } from '../fotos.js';

/**
 * Como se nombra el pack entero.
 *
 * El panel puede ponerle el nombre que quiera ("Rollo", "Caja de 12"); si no lo
 * pusieron se usa el tipo que trae el POS, y de ultima "el pack", que sirve
 * para cualquier cosa.
 */
function nombreDelPack(p) {
  const nombre = String(p.pack_nombre || p.pack_tipo || 'pack').toLowerCase().trim();
  if (!nombre) return 'el pack entero';

  // Si ya viene con artículo ("la caja de 12"), se respeta tal cual: quien lo
  // escribió en el panel ya decidió cómo se dice.
  if (/^(el|la|los|las) /.test(nombre)) return `${nombre} entero`;

  // Género por la última letra de la primera palabra. No es gramática, es lo
  // que alcanza para rollo, caja, bolsa, bobina, cartón y pack — que es todo
  // lo que existe en el catálogo. Sin esto salía "el bolsa entero".
  const femenino = /a$/.test(nombre.split(' ')[0]);
  return femenino ? `la ${nombre} entera` : `el ${nombre} entero`;
}

/**
 * "Se vende de a 5" bajo el precio.
 *
 * Hay productos que en el mostrador se llevan de a uno y por la web no: un
 * pedido cuesta el mismo trabajo valga $100 o $10.000, y buscar una sola goma
 * entre dos mil cuatrocientos productos no lo paga nadie.
 *
 * Esto tiene que leerse antes de tocar "Agregar", no descubrirse en el carrito.
 * Va como cartel y no como renglón gris al pie del precio: en el celular ese
 * renglón se pierde entre el stock y los colores, y enterarse tarde de que el
 * mínimo son 2 se siente como una trampa aunque no lo sea.
 */
function textoMinimo(p) {
  const minimo = carrito.minimoDe(p);
  if (minimo <= (p.unidad === 'metro' ? 0.5 : 1)) return '';

  const cuanto = p.unidad === 'metro'
    ? `${minimo.toFixed(1).replace('.', ',')} metros`
    : `${minimo} unidades`;

  return `
    <p class="aviso-minimo">
      ${icono('atencion', { tam: 17 })}
      <span>Se vende desde <strong>${cuanto}</strong> · ${pesos(p.precio * minimo)}</span>
    </p>`;
}

/**
 * Los colores y modelos.
 *
 * Con pocas variedades las cápsulas entran en dos renglones y no molestan. Con
 * treinta —la cartulina Luma tiene treinta— la pantalla del celular se llena de
 * botones y "Agregar al pedido" queda tres pantallas más abajo.
 *
 * La salida no es sacar el nombre. Se probó con muestras de color solas y el
 * problema es peor: en este catálogo hay siete verdes y cuatro rosas que en un
 * círculo de 34 píxeles son el mismo círculo, así que elegir pasa a ser tocar a
 * ver qué sale. El nombre es justamente lo que distingue "Rosa Pastel" de "Rosa
 * Luma".
 *
 * Entonces arriba de doce el mismo botón se ordena en una pista de dos filas
 * que se corre de costado: el alto queda fijo en dos renglones tenga cuatro
 * colores o cuarenta, y los nombres siguen ahí. El degradé del borde derecho es
 * lo que avisa que hay más; se apaga al llegar al final.
 */
const MUCHAS_VARIEDADES = 12;

/** "· 30 colores" cuando casi todas tienen color; si no, "· 30 opciones". */
function comoSeLlaman(variedades) {
  const conColor = variedades.filter(v => colorDeVariedad(v.nombre)).length;
  return conColor > variedades.length / 2 ? 'colores' : 'opciones';
}

function listaDeVariedades(variedades) {
  if (!variedades.length) return '';

  const enPista = variedades.length > MUCHAS_VARIEDADES;
  const disponibles = variedades.filter(v => v.stock > 0).length;

  const botones = variedades.map(v => {
    const color = colorDeVariedad(v.nombre);
    const sinStock = v.stock <= 0;

    return `
      <button class="variedad" data-variedad="${esc(v.nombre)}" aria-pressed="false"
              ${sinStock ? 'disabled' : ''}
              title="${esc(v.nombre)}${sinStock ? ' · sin stock' : ''}">
        ${color ? `<span class="variedad__punto" style="background:${color}"></span>` : ''}
        <span class="variedad__nombre">${esc(v.nombre)}</span>
      </button>`;
  }).join('');

  const lista = `
    <div class="variedades__lista${enPista ? ' variedades__lista--pista' : ''}"
         role="group" aria-labelledby="tit-variedades"${enPista ? ' data-pista' : ''}>${botones}</div>`;

  // Las flechas existen para el mouse (el CSS las esconde en el celular, donde
  // el dedo arrastra). Van después de la lista para poder apagarlas desde CSS
  // con las clases --inicio y --fin que ya marca el scroll.
  const flechas = `
    <button type="button" class="variedades__flecha variedades__flecha--izq"
            data-pista-atras aria-label="Ver los colores anteriores">
      ${icono('izquierda', { tam: 16, grosor: 2.5 })}
    </button>
    <button type="button" class="variedades__flecha variedades__flecha--der"
            data-pista-adelante aria-label="Ver más colores">
      ${icono('derecha', { tam: 16, grosor: 2.5 })}
    </button>`;

  return `
    <div class="variedades">
      <span class="campo__label" id="tit-variedades">
        Elegí el color o modelo
        <em data-elegida class="variedades__elegida">${
          enPista ? `· ${disponibles} ${comoSeLlaman(variedades)}` : ''}</em>
      </span>
      ${enPista ? `<div class="variedades__marco">${lista}${flechas}</div>` : lista}
    </div>`;
}

export async function producto({ montar, params }) {
  const cfg = await cargarConfig();
  const [p, avisos] = await Promise.all([
    traerProducto(params.id),
    cargarAvisos(),
  ]);

  if (!p) {
    fijarTitulo('No encontramos este producto · Librería Liceo');
    // Un producto que ya no está no tiene que quedar en Google apuntando acá.
    document.head.querySelector('meta[name="robots"]')?.remove();
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex';
    document.head.appendChild(robots);
    montar(`
      <div class="contenedor">
        ${vacio({
          titulo: 'No encontramos este producto',
          texto: 'Puede que lo hayamos sacado del catálogo o que el enlace esté cortado.',
          acciones: '<a class="boton boton--primario" href="/catalogo">Ver el catálogo</a>',
        })}
      </div>
      ${pie(cfg)}`);
    return;
  }

  fijarTitulo(`${p.nombre} · Librería Liceo`);
  fijarProducto(p);
  // Quien esta mirando un abrojo probablemente busque otra cosa de merceria.
  fijarAmbito(p.rubro);

  // Los que se cortan del rollo llevan cinta metrica en vez de contador: 350
  // productos del catalogo (cintas, cordones, elastico, abrojo).
  const porMetro = p.unidad === 'metro';

  // Solo por pack entero (las tanzas): sin cinta métrica ni precio por metro.
  // Se compra el rollo, con un contador de rollos, al precio del rollo.
  const soloRollo = carrito.soloPack(p);
  const rollosDisponibles = soloRollo
    ? Math.max(0, Math.floor(p.stock / p.pack_contenido)) : 0;

  const variedades = p.variedades || [];
  const hayVariedades = variedades.length > 0;
  const disponibles = variedades.filter(v => v.stock > 0);
  const agotado = p.stock <= 0 || (hayVariedades && !disponibles.length)
    || (soloRollo && rollosDisponibles === 0);

  // Con variedades se arranca sin ninguna elegida a proposito: preseleccionar
  // un color hace que el cliente agregue el equivocado sin darse cuenta.
  let elegida = null;

  // La foto grande, las miniaturas y el cambio de foto al elegir un color
  // viven en galeria.js.
  const medios = htmlGaleria(p);

  const listaVariedades = hayVariedades ? listaDeVariedades(variedades) : '';

  const nombrePack = String(p.pack_nombre || p.pack_tipo || 'pack').toLowerCase();
  const restante = soloRollo
    ? `${rollosDisponibles} ${nombrePack}${rollosDisponibles === 1 ? '' : 's'}`
    : porMetro ? `${p.stock} metros` : `${p.stock}`;
  const estadoStock = agotado
    ? `<span class="dato-stock" style="color:var(--text-2)">${icono('atencion', { tam: 18 })} Sin stock por ahora</span>`
    : ((soloRollo ? rollosDisponibles : p.stock) <= (soloRollo ? 2 : porMetro ? 3 : 5)
        ? `<span class="dato-stock" style="color:var(--alerta)">${icono('atencion', { tam: 18 })} Quedan ${restante}</span>`
        : `<span class="dato-stock" style="color:var(--exito)">${icono('tilde', { tam: 18 })} ${
            soloRollo ? `Hay ${restante}` : porMetro ? `Hay ${restante} en el rollo` : 'Hay stock'}</span>`);

  montar(`
    <div class="contenedor" data-rubro="${esc(p.rubro)}">
      <nav class="migas" aria-label="Dónde estás">
        <a href="/">Inicio</a>
        <span>${icono('derecha', { tam: 12 })}</span>
        <a href="/catalogo/${encodeURIComponent(p.rubro)}">${esc(nombreBonito(p.rubro))}</a>
        <span>${icono('derecha', { tam: 12 })}</span>
        <span>${esc(p.categoria || 'Producto')}</span>
      </nav>

      <div class="ficha-producto">
        <div class="ficha-producto__foto galeria" data-galeria>
          ${medios}
          ${botonFotoFicha(p)}
        </div>

        <div class="ficha-producto__datos">
          <div>
            <span class="card-producto__rubro">${esc(p.categoria || p.rubro)}</span>
            <h1 class="ficha-producto__titulo" style="margin-top:var(--e-2)">${esc(p.nombre)}</h1>
            ${p.marca ? `<p style="color:var(--text-2);font-size:var(--t-sm);margin-top:var(--e-1)">${esc(p.marca)}</p>` : ''}
          </div>

          <div class="ficha-precio">
            ${p.descuento && p.precio_anterior > p.precio ? `
              <div class="ficha-oferta">
                <span class="ficha-oferta__chapa">−${p.descuento.porcentaje}%</span>
                <span class="ficha-oferta__antes cifra">${pesos(p.precio_anterior)}</span>
                <span class="ficha-oferta__nombre">${esc(p.descuento.nombre)}</span>
              </div>` : ''}
            <div class="ficha-producto__precio cifra" data-precio>${
              pesos(soloRollo ? p.precio_pack : p.precio)}${
              soloRollo
                ? `<small style="font-size:var(--t-base);font-weight:600;color:var(--text-2)"> ${
                    esc(conArticulo(nombrePack))} de ${p.pack_contenido}${porMetro ? ' m' : ' u'}</small>`
                : porMetro ? '<small style="font-size:var(--t-base);font-weight:600;color:var(--text-2)"> el metro</small>' : ''
            }</div>
            ${estadoStock}
            ${soloRollo ? '' : textoMinimo(p)}
          </div>

          ${p.descripcion ? `<p style="color:var(--text-2);line-height:var(--alto-suelto)">${esc(p.descripcion)}</p>` : ''}

          <div class="${agotado ? '' : 'ficha-compra'}">
          ${listaVariedades}

          ${agotado ? `
            <div style="padding:var(--e-4);border-radius:var(--r-md);background:var(--surface-2);border:1px solid var(--border)">
              <p style="font-weight:600;margin-bottom:var(--e-2)">Se nos terminó</p>
              <p style="color:var(--text-2);font-size:var(--t-sm);line-height:1.5;margin-bottom:var(--e-3)">
                Escribinos y te avisamos apenas vuelva a entrar.
              </p>
              <a class="boton boton--secundario boton--chico"
                 href="https://wa.me/${esc(cfg.whatsapp)}?text=${
                   encodeURIComponent(`Hola, quiero saber cuándo vuelve: ${p.nombre}`)}"
                 target="_blank" rel="noopener">
                ${icono('whatsapp', { tam: 16 })} Consultar
              </a>
            </div>`
          : `
            ${porMetro && !soloRollo ? '<div data-cinta></div>' : `
              <div class="cantidad" data-cantidad>
                <span class="cantidad__label" id="tit-cantidad">${
                  soloRollo ? `Cuántos ${esc(nombrePack)}s llevás` : 'Cuántos llevás'}</span>
                <div class="contador contador--grande" role="group" aria-labelledby="tit-cantidad">
                  <button class="contador__boton" data-menos aria-label="Uno menos">
                    ${icono('menos', { tam: 18, grosor: 2.5 })}
                  </button>
                  <span class="contador__valor" data-valor aria-live="polite">1</span>
                  <button class="contador__boton" data-mas aria-label="Uno más">
                    ${icono('mas', { tam: 18, grosor: 2.5 })}
                  </button>
                </div>
                <span class="cantidad__tope" data-tope></span>
              </div>`}
            ${(() => {
              // Justo arriba del botón: es el momento en que decide. Enterarse
              // de que no hay devolución después de pagar es el reclamo que
              // esto viene a evitar.
              const aviso = avisoDe(p, avisos);
              return aviso ? `
                <p class="aviso-producto">
                  ${icono('atencion', { tam: 16 })}
                  <span>${esc(aviso)}</span>
                </p>` : '';
            })()}
            <button class="boton boton--primario boton--grande boton--bloque" data-agregar>
              ${icono('carrito', { tam: 20 })} <span data-etiqueta-agregar>Agregar al pedido</span>
            </button>
            ${p.precio_pack && !soloRollo ? `
              <button class="opcion-pack" data-pack>
                <span class="opcion-pack__texto">
                  <span class="opcion-pack__titulo">Llevar ${esc(nombreDelPack(p))
                  } · ${p.pack_contenido}${porMetro ? ' m' : ' u'}</span>
                  <span class="opcion-pack__ahorro">${(() => {
                    const ahorro = carrito.ahorroDePack({
                      precioSuelto: p.precio, precioPack: p.precio_pack, contenido: p.pack_contenido,
                    });
                    return ahorro
                      ? `Ahorrás ${ahorro.porcentaje}% contra comprar de a ${porMetro ? 'un metro' : 'uno'}`
                      : 'Precio por cantidad';
                  })()}</span>
                </span>
                <span class="opcion-pack__precio cifra">${pesos(p.precio_pack)}</span>
              </button>` : ''}`}
          </div>

          <div class="ficha-entrega">
            <span>
              ${icono('camion', { tam: 18 })} Envío a domicilio en Córdoba, se calcula por distancia
            </span>
            <span>
              ${icono('local', { tam: 18 })} Retiro sin costo en ${esc(cfg.direccion)}
            </span>
            <span>
              ${icono('reloj', { tam: 18 })} Demora ${esc(cfg.entrega.demora_texto)}
            </span>
          </div>
        </div>
      </div>

      <div class="seccion">
        <div class="seccion__cabecera"><h2>Otros de ${esc(nombreBonito(p.rubro))}</h2></div>
        <div data-relacionados></div>
      </div>
    </div>

    ${pie(cfg)}
  `);

  /* ── Galería ─────────────────────────────────────────────────────────────── */
  const galeria = montarGaleria(document.querySelector('[data-galeria]'), p);

  /* ── Variedades ─────────────────────────────────────────────────────────── */
  const botonAgregar = document.querySelector('[data-agregar]');
  const cajaPrecio = document.querySelector('[data-precio]');

  // En la pista el elegido se puede quedar fuera de la parte visible, así que
  // su nombre se repite al lado del título: sin eso se elige un color, se
  // arrastra la pista y ya no hay forma de saber cuál quedó.
  const cajaElegida = document.querySelector('[data-elegida]');
  const cuantasHay = disponibles.length;
  const enPista = variedades.length > MUCHAS_VARIEDADES;
  const resumen = enPista ? `· ${cuantasHay} ${comoSeLlaman(variedades)}` : '';

  document.querySelectorAll('[data-variedad]').forEach(boton => {
    boton.addEventListener('click', () => {
      const nombre = boton.dataset.variedad;
      const yaEstaba = elegida === nombre;
      elegida = yaEstaba ? null : nombre;

      document.querySelectorAll('[data-variedad]').forEach(otro => {
        otro.setAttribute('aria-pressed', String(otro.dataset.variedad === elegida));
      });

      if (cajaElegida) {
        cajaElegida.textContent = elegida ? `· ${elegida}` : resumen;
      }

      // El rojo se ve rojo: si la variedad tiene su foto, pasa a ser la grande.
      galeria.alElegirVariedad(elegida);

      cajaPrecio.textContent = pesos(precioActual());
      // El contador se rehace con el stock y el precio de esta variedad: si de
      // celeste hay 12, el tope pasa a ser 12 y el total del botón cambia.
      pintarCantidad();
    });
  });

  /* ── La pista de colores ────────────────────────────────────────────────
     El degradé del borde derecho es lo único que dice que hay más colores a la
     derecha. Tiene que apagarse al llegar al final: dejarlo puesto hace que
     parezca que siempre falta algo, y encima come el último botón. */
  const pista = document.querySelector('[data-pista]');
  if (pista) {
    const marcarBordes = () => {
      const resto = pista.scrollWidth - pista.clientWidth - pista.scrollLeft;
      pista.classList.toggle('variedades__lista--fin', resto <= 4);
      pista.classList.toggle('variedades__lista--inicio', pista.scrollLeft <= 4);
    };
    pista.addEventListener('scroll', marcarBordes, { passive: true });
    // Al entrar puede no haber desborde: en la pantalla ancha de una PC entran
    // los treinta y no hay nada que correr.
    marcarBordes();

    /* Con mouse la pista no se podía recorrer: la rueda va para abajo, no hay
       gesto de arrastre y la barrita de 8 px es un blanco imposible. La rueda
       pasa a correr la pista, y en los bordes se suelta para que la página
       siga scrolleando y no quede secuestrada. */
    pista.addEventListener('wheel', ev => {
      if (!ev.deltaY || ev.deltaX) return;   // el trackpad horizontal ya anda
      const falta = pista.scrollWidth - pista.clientWidth;
      if (falta <= 0) return;
      const enElFin = ev.deltaY > 0 && pista.scrollLeft >= falta - 1;
      const enElInicio = ev.deltaY < 0 && pista.scrollLeft <= 0;
      if (enElFin || enElInicio) return;
      ev.preventDefault();
      pista.scrollLeft += ev.deltaY;
    }, { passive: false });

    // Las flechas saltan de a pantalla, dejando un botón de solape como
    // referencia. Sin animación si el aparato pidió quietud.
    const suave = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto' : 'smooth';
    const salto = () => Math.max(pista.clientWidth * 0.8, 160);
    document.querySelector('[data-pista-atras]')?.addEventListener('click',
      () => pista.scrollBy({ left: -salto(), behavior: suave }));
    document.querySelector('[data-pista-adelante]')?.addEventListener('click',
      () => pista.scrollBy({ left: salto(), behavior: suave }));
  }

  /* ── Cuántos lleva ──────────────────────────────────────────────────────
     Lo que se corta del rollo se elige con la cinta métrica; lo demás, con un
     contador. Los dos arrancan en el mínimo que se despacha —mostrar 1 cuando
     el mínimo son 3 es ofrecer algo que después no se puede comprar— y ninguno
     de los dos deja bajar de ahí.

     El techo es el stock de la variedad elegida, no el del producto: la
     cartulina tiene 1.180 en total y 12 celestes, y prometer 30 celestes
     termina en una llamada incómoda. Por eso el contador se rearma cada vez que
     se elige un color. */
  // Solo rollo: el contador cuenta rollos, de a uno. El mínimo del producto
  // (que es el contenido del rollo, en metros) queda para la cuenta de stock.
  const minimo = soloRollo ? 1 : carrito.minimoDe(p);
  const paso = soloRollo ? 1 : carrito.pasoDe(p);
  const cajaCinta = document.querySelector('[data-cinta]');
  const cajaCantidad = document.querySelector('[data-cantidad]');
  const etiqueta = document.querySelector('[data-etiqueta-agregar]');

  let cuantos = minimo;
  let metros = Math.max(minimo, Math.min(1, p.stock));

  /** El stock que corresponde: el de la variedad elegida, o el del producto. */
  function stockDisponible() {
    const v = variedades.find(x => x.nombre === elegida);
    return v ? v.stock : p.stock;
  }

  /** El precio que corresponde: algunas variedades tienen el suyo. */
  function precioActual() {
    const v = variedades.find(x => x.nombre === elegida);
    return (v && v.precio) ? v.precio : p.precio;
  }

  function pintarCantidad() {
    if (!cajaCantidad) return;

    const tope = soloRollo
      ? Math.max(minimo, Math.floor(stockDisponible() / p.pack_contenido))
      : Math.max(minimo, Math.floor(stockDisponible() / paso) * paso);
    cuantos = Math.min(tope, Math.max(minimo, cuantos));

    cajaCantidad.querySelector('[data-valor]').textContent =
      Number.isInteger(cuantos) ? String(cuantos) : cuantos.toFixed(1).replace('.', ',');
    cajaCantidad.querySelector('[data-menos]').disabled = cuantos <= minimo;
    cajaCantidad.querySelector('[data-mas]').disabled = cuantos >= tope;

    // El renglón de abajo explica el freno en vez de dejar un botón muerto.
    const tomo = cajaCantidad.querySelector('[data-tope]');
    tomo.textContent = cuantos >= tope && tope < 99
      ? `Es todo lo que hay${elegida ? ` de ${elegida.toLowerCase()}` : ''}`
      : (minimo > 1 ? `Mínimo ${minimo}` : '');

    etiqueta.textContent = `Agregar ${cuantos} · ${
      pesos((soloRollo ? p.precio_pack : precioActual()) * cuantos)}`;
  }

  cajaCantidad?.addEventListener('click', ev => {
    if (ev.target.closest('[data-menos]')) cuantos = Math.max(minimo, cuantos - paso);
    else if (ev.target.closest('[data-mas]')) cuantos += paso;
    else return;
    // Los flotantes dejan restos al sumar de a 0,5.
    cuantos = Math.round(cuantos * 10) / 10;
    pintarCantidad();
  });

  if (cajaCinta) {
    montarCinta(cajaCinta, {
      max: p.stock,
      valor: metros,
      paso,
      minimo,
      alCambiar: m => {
        metros = m;
        // El botón dice cuánto se lleva y cuánto sale: sin eso hay que hacer la
        // multiplicación de cabeza antes de tocarlo.
        const texto = m.toFixed(1).replace('.', ',');
        etiqueta.textContent = `Agregar ${texto} m · ${pesos(precioActual() * m)}`;
      },
    });
  }

  pintarCantidad();

  document.querySelector('[data-pack]')?.addEventListener('click', () => {
    if (hayVariedades && !elegida) {
      avisar('Elegí primero el color o modelo', { tipo: 'error' });
      document.querySelector('[data-variedad]:not([disabled])')?.focus();
      return;
    }
    carrito.agregar(p, { esPack: true, variedad: elegida });
  });

  botonAgregar?.addEventListener('click', () => {
    if (hayVariedades && !elegida) {
      avisar('Elegí primero el color o modelo', { tipo: 'error' });
      // Lleva el foco al primer botón disponible: sin esto el cliente lee el
      // aviso y no sabe qué tiene que tocar.
      document.querySelector('[data-variedad]:not([disabled])')?.focus();
      return;
    }
    carrito.agregar(p, {
      variedad: elegida,
      cantidad: porMetro && !soloRollo ? metros : cuantos,
      esPack: soloRollo,
    });

    // El contador vuelve al mínimo: dejarlo en 6 hace que el próximo toque
    // sume otros 6 sin que nadie lo haya pedido.
    cuantos = minimo;
    pintarCantidad();
  });

  /* ── Relacionados ───────────────────────────────────────────────────────── */
  const { productos } = await traerProductos({ rubro: p.rubro, cantidad: 6 });
  const otros = productos.filter(x => x.id !== p.id).slice(0, 5);
  const caja = document.querySelector('[data-relacionados]');
  if (caja) caja.innerHTML = otros.length ? grilla(otros) : '';
}
