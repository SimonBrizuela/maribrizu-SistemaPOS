/**
 * Página de notificaciones de stock.
 *
 * Es la lista de qué hay que reponer. Se usa parada frente a la góndola o con
 * el proveedor esperando, así que manda la densidad: una fila por producto, la
 * pantalla entera aprovechada y todo filtrable desde arriba sin scrollear.
 *
 * Antes era una columna angosta de tarjetas de tres líneas: con 1.900 alertas
 * había que bajar cientos de pantallas para llegar a las variedades. Ahora las
 * cifras de arriba son los filtros, hay buscador, y la lista se dibuja de a
 * tandas para que no se trabe.
 *
 * Al tocar una fila se abre el editor del producto en el catálogo.
 */
import {
  obtenerAlertasActivas,
  onAlertasCambian,
  refrescarAlertas,
  pedirPermisoNotificaciones,
  permisoNotificacion,
  notificacionesSoportadas,
  notificacionesNavegadorActivas,
  setNotificacionesNavegador,
  irACatalogoYAbrir,
  mostrarNotificacionDePrueba,
  ignorarProducto,
  restaurarTodos,
  obtenerIgnorados,
} from '../notifications.js';

let _limpiar = [];

const LS_FILTRO = 'notif:filtro';
const TANDA = 60;          // filas por tanda: más que esto ya no entra en pantalla

function fmt(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Ritmo en corto para la fila; el detalle largo queda en el title. */
function ritmoCorto(a) {
  if (!a || !a.vel_dia || a.vel_dia <= 0) return '';
  const porSem = a.vel_semana >= 1
    ? `~${fmt(Math.round(a.vel_semana))}/sem`
    : `~${fmt(Math.max(1, Math.round(a.vel_dia * 30)))}/mes`;
  if (a.stock <= 0) return `Sin stock · ${porSem}`;
  const d = Math.max(1, Math.round(a.dias_cobertura));
  return `${d} ${d === 1 ? 'día' : 'días'} · ${porSem}`;
}

export async function renderNotificaciones(container) {
  _limpiar.forEach(f => { try { f(); } catch (_) {} });
  _limpiar = [];

  container.innerHTML = `
    <div class="nf-page">
      <div id="notifPermisoBox"></div>

      <div class="nf-bar">
        <div class="nf-chips" id="notifChips"></div>
        <div class="nf-tools">
          <div class="nf-buscar-wrap">
            <span class="material-icons">search</span>
            <input type="text" id="notifBuscar" class="nf-buscar" placeholder="Buscar producto, código o rubro…" />
          </div>
          <select id="notifRubro" class="nf-select"><option value="">Todas las secciones</option></select>
        </div>
      </div>

      <div id="notifLista" class="nf-lista"></div>
      <div id="notifPie"></div>
    </div>
  `;

  const permisoBox = container.querySelector('#notifPermisoBox');
  const chipsBox   = container.querySelector('#notifChips');
  const listaBox   = container.querySelector('#notifLista');
  const pieBox     = container.querySelector('#notifPie');
  const inputBusca = container.querySelector('#notifBuscar');
  const selRubro   = container.querySelector('#notifRubro');

  let ultimasAlertas = [];
  const abiertos = new Set();      // filas de variedades desplegadas
  let gruposPorDoc = new Map();    // para redibujar solo la fila que se abre
  let filtro   = localStorage.getItem(LS_FILTRO) || 'todas';
  let busqueda = '';
  let rubroSel = '';
  let tope     = TANDA;

  // ── Permiso del navegador ────────────────────────────────────────────────
  function renderPermiso() {
    if (!notificacionesSoportadas()) {
      permisoBox.innerHTML = `<div class="nf-permiso nf-permiso--info">
        Este navegador no avisa con la pestaña cerrada. Las alertas igual aparecen acá y al costado de la pantalla.
      </div>`;
      return;
    }
    const perm = permisoNotificacion();
    const activas = notificacionesNavegadorActivas();

    if (perm === 'granted' && activas) {
      // Activado: una línea fina. Ya está resuelto, no tiene por qué ocupar
      // el lugar de lo que hay que reponer.
      permisoBox.innerHTML = `
        <div class="nf-permiso nf-permiso--ok">
          <span class="material-icons">notifications_active</span>
          <span>Avisos del navegador activados, incluso con la pestaña cerrada.</span>
          <button id="notifProbar" class="nf-lnk">Probar</button>
          <button id="notifDesactivar" class="nf-lnk">Desactivar</button>
        </div>`;
      permisoBox.querySelector('#notifProbar').addEventListener('click', mostrarNotificacionDePrueba);
      permisoBox.querySelector('#notifDesactivar').addEventListener('click', () => {
        setNotificacionesNavegador(false);
        renderPermiso();
      });
    } else if (perm === 'granted' && !activas) {
      permisoBox.innerHTML = `
        <div class="nf-permiso nf-permiso--pausa">
          <span class="material-icons">notifications_paused</span>
          <span><b>Avisos pausados.</b> Las alertas siguen acá, pero no salta nada con la pestaña cerrada.</span>
          <button id="notifActivar" class="nf-btn-pri">Activar</button>
        </div>`;
      permisoBox.querySelector('#notifActivar').addEventListener('click', () => {
        setNotificacionesNavegador(true);
        mostrarNotificacionDePrueba();
        renderPermiso();
      });
    } else if (perm === 'denied') {
      permisoBox.innerHTML = `
        <div class="nf-permiso nf-permiso--bloq">
          <span class="material-icons">notifications_off</span>
          <span><b>Avisos bloqueados en este navegador.</b> Se habilitan desde el candado en la barra de direcciones.</span>
        </div>`;
    } else {
      permisoBox.innerHTML = `
        <div class="nf-permiso nf-permiso--cta">
          <span class="material-icons">notifications</span>
          <span><b>Activá los avisos del navegador.</b> Te salta el aviso apenas un producto llega al mínimo, aunque estés en otra pestaña.</span>
          <button id="notifActivarBtn" class="nf-btn-pri">Activar</button>
        </div>`;
      permisoBox.querySelector('#notifActivarBtn').addEventListener('click', async () => {
        const r = await pedirPermisoNotificaciones();
        if (r === 'granted') {
          setNotificacionesNavegador(true);
          mostrarNotificacionDePrueba();
        }
        renderPermiso();
      });
    }
  }

  // ── Particiones ──────────────────────────────────────────────────────────
  function particionar(alertas) {
    // Lo urgente sube arriba aunque tenga mínimo cargado: es lo que se repone
    // primero y antes quedaba enterrado en el medio de "stock bajo".
    const urgentes = alertas.filter(a => a.origen === 'ritmo' || a.urgente);
    const yaEsta   = new Set(urgentes);
    const config   = alertas.filter(a => !a.auto && !yaEsta.has(a));
    return {
      urgentes,
      criticas: config.filter(a => a.critico),
      bajas:    config.filter(a => !a.critico),
      auto:     alertas.filter(a => a.auto),
    };
  }

  function coincide(a) {
    if (rubroSel && (a.rubro || '') !== rubroSel) return false;
    if (!busqueda) return true;
    const heno = `${a.nombre || ''} ${a.codigo || ''} ${a.rubro || ''} ${a.marca || ''} ${a.variedad || ''}`.toLowerCase();
    return busqueda.split(/\s+/).filter(Boolean).every(t => heno.includes(t));
  }

  // ── Piezas ───────────────────────────────────────────────────────────────
  const fila = (a) => {
    const tono = a.urgente ? 'urg' : a.critico ? 'cero' : 'bajo';
    const icono = a.urgente ? 'priority_high' : a.critico ? 'error' : 'warning';
    const ritmo = ritmoCorto(a);
    const stockTxt = a.stock <= 0
      ? `<b class="nf-cero">Sin stock</b>${a.stock < 0 ? ` <span class="nf-fig">(figura ${fmt(a.stock)})</span>` : ''}`
      : `<b>${a.stock_texto ? escape(a.stock_texto) : `${fmt(a.stock)}${a.unidad_label ? ' ' + escape(a.unidad_label) : ''}`}</b>${a.stock_equiv ? ` <span class="nf-sec-txt">(${escape(a.stock_equiv)})</span>` : ''}`;
    return `
      <div class="nf-row nf-row--${tono}" role="button" tabindex="0"
           data-doc="${escape(a.doc_id)}" title="${escape(a.cobertura_texto || a.nombre)}">
        <span class="nf-ico material-icons">${icono}</span>
        <div class="nf-prod">
          <span class="nf-nombre">${escape(a.nombre)}</span>
          ${a.es_top ? '<span class="nf-tag nf-tag--top">Top ventas</span>' : ''}
          ${a.variedad ? '<span class="nf-tag nf-tag--var">Variedad</span>' : ''}
          ${a.codigo ? `<span class="nf-tag">#${escape(a.codigo)}</span>` : ''}
          ${a.rubro ? `<span class="nf-tag nf-tag--rubro">${escape(a.rubro)}</span>` : ''}
        </div>
        <div class="nf-datos">
          ${stockTxt}
          ${a.stock_min > 0 ? `<span class="nf-sec-txt">/ mín ${a.min_texto ? escape(a.min_texto) : fmt(a.stock_min)}</span>` : ''}
          ${a.stock_max ? `<span class="nf-sec-txt">· máx ${a.max_texto ? escape(a.max_texto) : fmt(a.stock_max)}</span>` : ''}
        </div>
        <div class="nf-ritmo">${ritmo ? `<span class="material-icons">trending_up</span>${escape(ritmo)}` : ''}</div>
        <div class="nf-pedir">${a.sugerencia ? `pedir ~${a.sugerencia_texto ? escape(a.sugerencia_texto) : fmt(a.sugerencia)}` : ''}</div>
        <div class="nf-acts">
          <button class="nf-act" data-ocultar="${escape(a.doc_id)}" title="No mostrar este producto acá">
            <span class="material-icons">visibility_off</span>
          </button>
          <button class="nf-act nf-act--ed" data-editar="${escape(a.doc_id)}" title="Abrir la ficha">
            <span class="material-icons">edit</span>
          </button>
        </div>
      </div>`;
  };

  const pastillasVariedad = (g, abierta) => {
    const lista = abierta ? g.variedades : g.variedades.slice(0, 14);
    return lista.map(v => `
      <span class="nf-var ${v.critico ? 'is-cero' : ''}">${escape(v.variedad || 'Sin nombre')} · ${fmt(v.stock)}</span>`).join('');
  };

  const grupoVariedades = (g) => {
    const abierta = abiertos.has(g.doc_id);
    return `
    <div class="nf-row nf-row--bajo nf-row--grupo${abierta ? ' nf-row--abierta' : ''}" role="button" tabindex="0" data-doc="${escape(g.doc_id)}">
      <span class="nf-ico material-icons">palette</span>
      <div class="nf-prod">
        <span class="nf-nombre">${escape(g.nombre)}</span>
        ${g.codigo ? `<span class="nf-tag">#${escape(g.codigo)}</span>` : ''}
        ${g.rubro ? `<span class="nf-tag nf-tag--rubro">${escape(g.rubro)}</span>` : ''}
      </div>
      <div class="nf-datos">
        ${g._criticas > 0 ? `<b class="nf-cero">${g._criticas} en cero</b>` : ''}
        ${g._criticas > 0 && g._bajas > 0 ? '<span class="nf-sec-txt">·</span>' : ''}
        ${g._bajas > 0 ? `<b class="nf-bajo-txt">${g._bajas} por agotarse</b>` : ''}
      </div>
      <div class="nf-vars">
        <div class="nf-chips-var">${pastillasVariedad(g, abierta)}</div>
        ${g.variedades.length > 3 ? `<button class="nf-mas-var" data-vervar="${escape(g.doc_id)}"
          title="${abierta ? 'Achicar' : 'Ver las ' + g.variedades.length + ' variedades'}">
          <span class="material-icons">${abierta ? 'unfold_less' : 'unfold_more'}</span>${g.variedades.length}
        </button>` : ''}
      </div>
      <div class="nf-acts">
        <button class="nf-act" data-ocultar="${escape(g.doc_id)}" title="No mostrar este producto acá">
          <span class="material-icons">visibility_off</span>
        </button>
        <button class="nf-act nf-act--ed" data-editar="${escape(g.doc_id)}" title="Abrir la ficha">
          <span class="material-icons">edit</span>
        </button>
      </div>
    </div>`;
  };

  const encabezado = (icono, texto, detalle, tono) => `
    <div class="nf-sec nf-sec--${tono}">
      <span class="material-icons">${icono}</span><b>${texto}</b>
      <span class="nf-sec-txt">${detalle}</span>
    </div>`;

  function agruparVariedades(lista) {
    const porDoc = new Map();
    for (const a of lista) {
      if (!porDoc.has(a.doc_id)) {
        porDoc.set(a.doc_id, {
          doc_id: a.doc_id,
          nombre: (a.producto?.nombre) || a.nombre.split(' · ')[0],
          codigo: a.codigo, rubro: a.rubro, variedades: [],
        });
      }
      porDoc.get(a.doc_id).variedades.push(a);
    }
    return Array.from(porDoc.values()).map(g => {
      g.variedades.sort((x, y) => x.stock - y.stock);
      g._criticas = g.variedades.filter(v => v.critico).length;
      g._bajas = g.variedades.length - g._criticas;
      return g;
    }).sort((a, b) => (b._criticas - a._criticas) || (b.variedades.length - a.variedades.length));
  }

  // ── Filtros de arriba ────────────────────────────────────────────────────
  function renderChips(p, nGrupos) {
    // Cuentan FILAS, no alertas sueltas: las variedades de un producto entran
    // en una sola fila, y un numero que no coincide con la lista hace dudar de
    // los dos.
    const def = [
      { id: 'todas',     txt: 'Todas',       n: p.urgentes.length + p.criticas.length + p.bajas.length + nGrupos, tono: '' },
      { id: 'urgente',   txt: 'Reponer ya',  n: p.urgentes.length, tono: 'urg' },
      { id: 'sin_stock', txt: 'Sin stock',   n: p.criticas.length, tono: 'cero' },
      { id: 'bajo',      txt: 'Stock bajo',  n: p.bajas.length,    tono: 'bajo' },
      { id: 'variantes', txt: 'Variedades',  n: nGrupos,           tono: 'bajo' },
    ];
    chipsBox.innerHTML = def.map(c => `
      <button class="nf-chip ${c.tono ? 'nf-chip--' + c.tono : ''} ${filtro === c.id ? 'on' : ''}" data-f="${c.id}" ${c.n === 0 && c.id !== 'todas' ? 'disabled' : ''}>
        <span class="nf-chip-n">${c.n}</span><span class="nf-chip-t">${c.txt}</span>
      </button>`).join('');
  }

  function poblarRubros(alertas) {
    const rubros = [...new Set(alertas.map(a => a.rubro).filter(Boolean))].sort();
    if (!rubros.includes(rubroSel)) rubroSel = '';
    selRubro.innerHTML = `<option value="">Todas las secciones</option>` +
      rubros.map(r => `<option value="${escape(r)}"${r === rubroSel ? ' selected' : ''}>${escape(r)}</option>`).join('');
  }

  // ── Lista ────────────────────────────────────────────────────────────────
  function renderAlertas(alertas) {
    ultimasAlertas = alertas;
    poblarRubros(alertas);
    const p = particionar(alertas.filter(coincide));
    const grupos = agruparVariedades(p.auto);
    gruposPorDoc = new Map(grupos.map(g => [g.doc_id, g]));
    renderChips(p, grupos.length);

    if (alertas.length === 0) {
      const nOcultos = obtenerIgnorados().length;
      listaBox.innerHTML = `
        <div class="nf-vacio">
          <span class="material-icons">check_circle</span>
          <div class="nf-vacio-t">Todo en orden</div>
          <div>No hay productos por debajo del stock mínimo.</div>
          ${nOcultos > 0 ? `<button id="notifRestaurar" class="nf-btn">Mostrar ${nOcultos} ${nOcultos === 1 ? 'oculto' : 'ocultos'}</button>` : ''}
        </div>`;
      pieBox.innerHTML = '';
      listaBox.querySelector('#notifRestaurar')?.addEventListener('click', () => restaurarTodos());
      return;
    }

    // Bloques a dibujar según el filtro elegido. Cada sección aporta su título
    // y sus filas; el tope se aplica a las filas, no a los títulos.
    const secciones = [];
    const urg = p.urgentes, cri = p.criticas, baj = p.bajas;

    if (filtro === 'todas' || filtro === 'urgente') {
      if (urg.length) secciones.push({
        cab: encabezado('priority_high', 'Reponer urgente', `${urg.length} · de los más vendidos, en cero o por agotarse`, 'urg'),
        items: urg.map(a => ({ html: () => fila(a) })),
      });
    }
    if (filtro === 'todas' || filtro === 'sin_stock') {
      if (cri.length) secciones.push({
        cab: encabezado('error', 'Sin stock', `${cri.length} con mínimo cargado`, 'cero'),
        items: cri.map(a => ({ html: () => fila(a) })),
      });
    }
    if (filtro === 'todas' || filtro === 'bajo') {
      if (baj.length) secciones.push({
        cab: encabezado('warning', 'Stock bajo', `${baj.length} por debajo del mínimo`, 'bajo'),
        items: baj.map(a => ({ html: () => fila(a) })),
      });
    }
    if (filtro === 'todas' || filtro === 'variantes') {
      if (grupos.length) secciones.push({
        cab: encabezado('palette', 'Variedades bajas',
          `${grupos.length} ${grupos.length === 1 ? 'producto' : 'productos'} · ${p.auto.length} ${p.auto.length === 1 ? 'variedad' : 'variedades'} en cero o cerca`, 'bajo'),
        items: grupos.map(g => ({ html: () => grupoVariedades(g) })),
      });
    }

    const totalItems = secciones.reduce((s, x) => s + x.items.length, 0);
    if (totalItems === 0) {
      listaBox.innerHTML = `
        <div class="nf-vacio">
          <span class="material-icons">search_off</span>
          <div class="nf-vacio-t">Nada con esos filtros</div>
          <div>Probá con otro texto o cambiá la sección.</div>
        </div>`;
      pieBox.innerHTML = '';
      return;
    }

    // Cada seccion en su propia caja: asi el titulo pegado de la siguiente
    // empuja al anterior en vez de encimarse.
    let quedan = Math.min(tope, totalItems);
    const html = [];
    for (const sec of secciones) {
      if (quedan <= 0) break;
      const cuantos = Math.min(quedan, sec.items.length);
      const filasHtml = [];
      for (let i = 0; i < cuantos; i++) filasHtml.push(sec.items[i].html());
      quedan -= cuantos;
      html.push(`<div class="nf-seccion">${sec.cab}${filasHtml.join('')}</div>`);
    }
    listaBox.innerHTML = html.join('');

    const mostrados = Math.min(tope, totalItems);
    const nOcultos = obtenerIgnorados().length;
    pieBox.innerHTML = `
      <div class="nf-pie">
        <span>Mostrando <b>${mostrados}</b> de <b>${totalItems}</b></span>
        ${mostrados < totalItems ? `<button id="nfMas" class="nf-btn nf-btn--mas">
          <span class="material-icons">expand_more</span>Mostrar ${Math.min(TANDA, totalItems - mostrados)} más</button>` : ''}
        ${mostrados > TANDA ? `<button id="nfMenos" class="nf-btn">Ver menos</button>` : ''}
        ${nOcultos > 0 ? `<button id="notifRestaurar" class="nf-btn nf-btn--fin">
          <span class="material-icons">visibility_off</span>${nOcultos} ${nOcultos === 1 ? 'oculto' : 'ocultos'} · mostrar de nuevo</button>` : ''}
      </div>`;

    pieBox.querySelector('#nfMas')?.addEventListener('click', () => {
      tope += TANDA;
      renderAlertas(ultimasAlertas);
    });
    pieBox.querySelector('#nfMenos')?.addEventListener('click', () => {
      tope = TANDA;
      renderAlertas(ultimasAlertas);
      listaBox.scrollIntoView({ block: 'start' });
    });
    pieBox.querySelector('#notifRestaurar')?.addEventListener('click', () => restaurarTodos());
  }

  // ── Eventos (delegados: la lista se redibuja entera) ─────────────────────
  listaBox.addEventListener('click', (e) => {
    const ver = e.target.closest('[data-vervar]');
    if (ver) {
      e.stopPropagation();
      const id = ver.dataset.vervar;
      const g = gruposPorDoc.get(id);
      const fila = ver.closest('.nf-row');
      if (!g || !fila) return;
      const abierta = !abiertos.has(id);
      if (abierta) abiertos.add(id); else abiertos.delete(id);
      fila.classList.toggle('nf-row--abierta', abierta);
      fila.querySelector('.nf-chips-var').innerHTML = pastillasVariedad(g, abierta);
      ver.querySelector('.material-icons').textContent = abierta ? 'unfold_less' : 'unfold_more';
      ver.title = abierta ? 'Achicar' : `Ver las ${g.variedades.length} variedades`;
      return;
    }
    const oc = e.target.closest('[data-ocultar]');
    if (oc) { e.stopPropagation(); ignorarProducto(oc.dataset.ocultar); return; }
    const row = e.target.closest('.nf-row');
    if (row?.dataset.doc) irACatalogoYAbrir(row.dataset.doc);
  });
  listaBox.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.nf-row');
    if (row?.dataset.doc) { e.preventDefault(); irACatalogoYAbrir(row.dataset.doc); }
  });

  chipsBox.addEventListener('click', (e) => {
    const chip = e.target.closest('.nf-chip');
    if (!chip || chip.disabled) return;
    filtro = chip.dataset.f;
    tope = TANDA;
    try { localStorage.setItem(LS_FILTRO, filtro); } catch (_) {}
    renderAlertas(ultimasAlertas);
  });

  let tBusca = null;
  inputBusca.addEventListener('input', () => {
    clearTimeout(tBusca);
    tBusca = setTimeout(() => {
      busqueda = inputBusca.value.trim().toLowerCase();
      tope = TANDA;
      renderAlertas(ultimasAlertas);
    }, 120);
  });
  inputBusca.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { inputBusca.value = ''; inputBusca.dispatchEvent(new Event('input')); }
  });
  selRubro.addEventListener('change', () => {
    rubroSel = selRubro.value;
    tope = TANDA;
    renderAlertas(ultimasAlertas);
  });

  renderPermiso();
  renderAlertas(obtenerAlertasActivas());

  // Refresca desde Firestore por si la página se abre antes de que init haya cargado
  refrescarAlertas().then(renderAlertas).catch(() => {});

  _limpiar.push(onAlertasCambian(renderAlertas));

  // Lo pegado de arriba se mide, no se adivina: la barra del sistema cambia de
  // alto entre desktop y celular, y la de filtros crece cuando los chips pasan
  // a dos lineas. Con un numero fijo, el titulo de la seccion quedaba cortado
  // atras de la barra.
  const page = container.querySelector('.nf-page');
  const bar  = container.querySelector('.nf-bar');
  const medir = () => {
    const topbar = document.querySelector('.topbar');
    const hTop = topbar ? Math.round(topbar.getBoundingClientRect().height) : 55;
    page.style.setProperty('--nf-bar-top', hTop + 'px');
    page.style.setProperty('--nf-sec-top', Math.round(bar.getBoundingClientRect().height) + 'px');
  };
  medir();
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(medir);
    ro.observe(bar);
    const topbar = document.querySelector('.topbar');
    if (topbar) ro.observe(topbar);
    _limpiar.push(() => ro.disconnect());
  }
  window.addEventListener('resize', medir);
  _limpiar.push(() => window.removeEventListener('resize', medir));
}
