/**
 * Editor de la zona de reparto, en Configuración de la tienda.
 *
 * Un mapa de Google a pantalla completa donde se dibuja hasta dónde llega el
 * envío. Se arranca con un círculo alrededor del local y se lo deforma:
 *
 *   · arrastrando los puntos blancos de las esquinas;
 *   · tirando del punto chico del medio de un lado, que agrega una esquina;
 *   · con clic derecho sobre una esquina, que la saca;
 *   · agrandando o achicando el área entera sin cambiarle la forma;
 *   · moviéndola entera, arrastrándola desde adentro.
 *
 * Además se pueden sumar áreas sueltas (un barrio aparte) y recortes, que son
 * pedazos adentro del área a los que no se llega. Y se prueba: tocando un
 * punto del mapa dice si la tienda dejaría pedir ahí, con la misma regla que
 * usa la tienda (`tienda/src/zona_reparto.js`), no con una copia.
 *
 * No guarda nada por su cuenta: devuelve la zona editada y la pantalla de
 * Configuración la guarda con el resto al tocar "Guardar".
 */
import { cargarGoogleMaps, alFallarLaClave } from '../google_maps.js';
import { confirmDialog } from './dialogs.js';
import {
  sanearZona, dentroDeZona, circulo, escalar, areaKm2, kmEntre, centroDe,
  MAX_AREAS, MAX_PUNTOS,
} from '../../../tienda/src/zona_reparto.js';

const COLOR = { incluir: '#7b3fa6', excluir: '#d32f2f' };
const PASO_ESCALA = 0.1;
const MAX_DESHACER = 60;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const km = (n) => (Math.round(n * 10) / 10).toLocaleString('es-AR');
const pesos = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');

/**
 * Abre el editor.
 *
 * @param {object} opciones
 * @param {object} opciones.db
 * @param {{areas: Array}} opciones.zona       la zona actual (puede venir vacía)
 * @param {{lat:number, lng:number}} opciones.origen  el local
 * @param {number} opciones.radioKm            el radio de hoy, para el primer círculo
 * @param {Array<{hasta_km:number, precio:number}>} opciones.tramos
 * @returns {Promise<{areas: Array}|null>}     null si se cancela
 */
export function abrirEditorZona({ db, zona, origen, radioKm, tramos }) {
  return new Promise((resolver) => {
    const editor = crearEditor({ db, zona, origen, radioKm, tramos, resolver });
    editor.abrir();
  });
}

function crearEditor({ db, zona, origen, radioKm, tramos, resolver }) {
  let siguienteId = 1;
  const conId = (a) => ({ id: siguienteId++, tipo: a.tipo, puntos: a.puntos.map(p => ({ ...p })) });

  let areas = sanearZona({ areas: zona?.areas || [] }).areas.map(conId);
  const inicial = JSON.stringify(areas.map(({ tipo, puntos }) => ({ tipo, puntos })));

  let seleccion = areas[0]?.id ?? null;
  let modo = 'editar';               // 'editar' | 'dibujar' | 'probar'
  let tipoDibujo = 'incluir';
  // Tocando una esquina se la saca. Es la forma de hacerlo en el celular,
  // donde no hay clic derecho.
  let sacandoEsquinas = false;
  let trazo = [];
  let deshacer = [];
  let ultimo = foto();

  let gm = null;
  let mapa = null;
  let marcaLocal = null;
  let lineaTrazo = null;
  let puntosTrazo = [];
  let marcaPrueba = null;
  let resultadoPrueba = null;
  const poligonos = new Map();       // id -> google.maps.Polygon
  let repintando = false;
  let temporizador = null;
  let soltarFalla = () => {};

  const overlay = document.createElement('div');
  overlay.className = 'zona-editor';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Zona de reparto');
  overlay.dataset.modo = 'editar';

  /* ── Estado ─────────────────────────────────────────────────────────────── */

  function foto() {
    return JSON.stringify(areas.map(({ id, tipo, puntos }) => ({ id, tipo, puntos })));
  }

  /** Antes de un cambio hecho desde los botones: deja la foto para deshacer. */
  function antesDeCambiar() {
    deshacer.push(ultimo);
    if (deshacer.length > MAX_DESHACER) deshacer.shift();
  }

  function despuesDeCambiar() {
    ultimo = foto();
    pintarLateral();
  }

  const areaSeleccionada = () => areas.find(a => a.id === seleccion) || null;
  const hayCambios = () =>
    JSON.stringify(areas.map(({ tipo, puntos }) => ({ tipo, puntos }))) !== inicial;

  /* ── Armado ─────────────────────────────────────────────────────────────── */

  function abrir() {
    overlay.innerHTML = `
      <header class="zona-editor__cabecera">
        <div class="zona-editor__titulo">
          <span class="material-icons" aria-hidden="true">map</span>
          <div>
            <h3>Zona de reparto</h3>
            <p>Adentro de lo violeta se puede pedir con envío. Afuera, la tienda solo ofrece retirarlo del local.</p>
          </div>
        </div>
        <div class="zona-editor__acciones">
          <button class="pc-btn" data-accion="cancelar">Cancelar</button>
          <button class="pc-btn zona-editor__aplicar" data-accion="aplicar">
            <span class="material-icons">check</span> Usar esta zona
          </button>
        </div>
      </header>
      <div class="zona-editor__cuerpo">
        <aside class="zona-editor__lateral" data-lateral></aside>
        <div class="zona-editor__mapa-caja">
          <div class="zona-editor__mapa" data-mapa></div>
          <div class="zona-editor__barra" data-barra hidden></div>
          <div class="zona-editor__leyenda" aria-hidden="true">
            <span><i class="zona-editor__muestra zona-editor__muestra--incluir"></i> Llegamos</span>
            <span><i class="zona-editor__muestra zona-editor__muestra--excluir"></i> No llegamos</span>
            <span><i class="zona-editor__punto-local"></i> El local</span>
          </div>
          <div class="zona-editor__cartel" data-cartel hidden></div>
          <div class="zona-editor__cargando" data-cargando>
            <span class="material-icons">map</span> Cargando el mapa…
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.body.classList.add('zona-editor-abierto');

    overlay.addEventListener('click', alClic);
    document.addEventListener('keydown', alTeclado);

    pintarLateral();
    iniciarMapa();
  }

  async function iniciarMapa() {
    const caja = overlay.querySelector('[data-mapa]');
    try {
      gm = await cargarGoogleMaps(db);
    } catch (err) {
      mostrarFallaDelMapa(err.message);
      return;
    }
    if (!overlay.isConnected) return;

    soltarFalla = alFallarLaClave(mostrarFallaDelMapa);
    overlay.querySelector('[data-cargando]')?.remove();

    mapa = new gm.Map(caja, {
      center: origen,
      zoom: 12,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      clickableIcons: false,
      gestureHandling: 'greedy',
      styles: [
        { featureType: 'poi', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit', stylers: [{ visibility: 'off' }] },
      ],
    });

    marcaLocal = new gm.Marker({
      position: origen,
      map: mapa,
      title: 'El local',
      zIndex: 1000,
      clickable: false,
      icon: {
        path: gm.SymbolPath.CIRCLE, scale: 8,
        fillColor: '#1c1c1c', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3,
      },
    });

    mapa.addListener('click', alTocarElMapa);
    escucharToquesParaDibujar(caja);

    dibujarPoligonos();
    encuadrar();
  }

  /**
   * Al dibujar, cada punto sale de soltar el dedo o el botón sobre el mapa,
   * escuchado en el contenedor ANTES que Google.
   *
   * Los eventos de Google no alcanzan: dos toques rápidos en dos esquinas los
   * toma como un doble toque y no manda nada del segundo, ni click, ni
   * mouseup, ni dblclick (medido: cuatro clics cada 250 ms dejaban dos
   * puntos, y en el celular tres toques cercanos dejaban dos). Si el puntero
   * se movió, era un arrastre del mapa; con dos dedos, un pellizco. Ninguno
   * de los dos suma un punto.
   */
  function escucharToquesParaDibujar(caja) {
    const capa = new gm.OverlayView();
    capa.onAdd = () => {};
    capa.draw = () => {};
    capa.onRemove = () => {};
    capa.setMap(mapa);

    const apoyados = new Set();
    let toque = null;

    caja.addEventListener('pointerdown', (ev) => {
      apoyados.add(ev.pointerId);
      const sobreControl = ev.target.closest?.('button, a, .gmnoprint, .gm-style-cc');
      toque = modo === 'dibujar' && apoyados.size === 1 && ev.button === 0 && !sobreControl
        ? { id: ev.pointerId, x: ev.clientX, y: ev.clientY }
        : null;
    }, true);

    const soltar = (ev) => {
      apoyados.delete(ev.pointerId);
      const inicio = toque;
      if (!inicio || inicio.id !== ev.pointerId) return;
      toque = null;
      if (ev.type !== 'pointerup' || modo !== 'dibujar') return;
      if (Math.hypot(ev.clientX - inicio.x, ev.clientY - inicio.y) > 6) return;

      const r = caja.getBoundingClientRect();
      const lugar = capa.getProjection()
        ?.fromContainerPixelToLatLng(new gm.Point(ev.clientX - r.left, ev.clientY - r.top));
      if (lugar) sumarEsquina(aPunto(lugar));
    };
    caja.addEventListener('pointerup', soltar, true);
    caja.addEventListener('pointercancel', soltar, true);
  }

  function mostrarFallaDelMapa(mensaje) {
    const caja = overlay.querySelector('.zona-editor__mapa-caja');
    if (!caja) return;
    caja.innerHTML = `
      <div class="zona-editor__falla">
        <span class="material-icons">location_off</span>
        <b>No se pudo abrir el mapa</b>
        <span>${esc(mensaje)}</span>
        <span>La zona guardada no se tocó. Probá de nuevo en un rato.</span>
      </div>`;
  }

  /** Que se vea toda la zona, o el local con el radio de hoy si no hay zona. */
  function encuadrar() {
    if (!mapa) return;
    const limites = new gm.LatLngBounds();
    const todos = areas.flatMap(a => a.puntos);
    if (todos.length) {
      todos.forEach(p => limites.extend(p));
      limites.extend(origen);
    } else {
      circulo(origen, Math.max(2, radioKm || 5), 8).forEach(p => limites.extend(p));
    }
    mapa.fitBounds(limites, 40);
  }

  /* ── Polígonos ──────────────────────────────────────────────────────────── */

  function opcionesDe(area) {
    const elegida = area.id === seleccion && modo === 'editar';
    return {
      paths: area.puntos,
      strokeColor: COLOR[area.tipo],
      strokeOpacity: 0.95,
      strokeWeight: elegida ? 3 : 2,
      fillColor: COLOR[area.tipo],
      fillOpacity: area.tipo === 'excluir' ? 0.28 : (elegida ? 0.18 : 0.1),
      editable: elegida,
      draggable: elegida,
      clickable: modo === 'editar',
      // Los recortes arriba: si no, tocarlos selecciona el área de abajo.
      zIndex: area.tipo === 'excluir' ? 20 : 10,
    };
  }

  function dibujarPoligonos() {
    if (!mapa) return;
    repintando = true;
    poligonos.forEach(p => p.setMap(null));
    poligonos.clear();

    for (const area of areas) {
      const poligono = new gm.Polygon({ ...opcionesDe(area), map: mapa });
      poligonos.set(area.id, poligono);
      engancharPoligono(area.id, poligono);
    }
    repintando = false;
  }

  function engancharPoligono(id, poligono) {
    poligono.addListener('click', (ev) => {
      if (modo !== 'editar') return;
      if (sacandoEsquinas && seleccion === id && ev.vertex != null) {
        sacarEsquina(poligono, ev.vertex);
        return;
      }
      if (seleccion === id) return;
      seleccion = id;
      refrescarEstilos();
      pintarLateral();
    });

    // Clic derecho sobre una esquina la saca. Con menos de tres ya no es un
    // área, así que la última no se deja sacar.
    poligono.addListener('contextmenu', (ev) => {
      if (ev.vertex != null) sacarEsquina(poligono, ev.vertex);
    });

    let arrastrando = false;
    poligono.addListener('dragstart', () => { arrastrando = true; });
    poligono.addListener('dragend', () => { arrastrando = false; alMoverse(id); });

    const camino = poligono.getPath();
    const alCambiar = () => { if (!repintando && !arrastrando) alMoverse(id); };
    camino.addListener('set_at', alCambiar);
    camino.addListener('insert_at', alCambiar);
    camino.addListener('remove_at', alCambiar);
  }

  function sacarEsquina(poligono, indice) {
    const camino = poligono.getPath();
    if (camino.getLength() <= 3) {
      mostrarCartel('Tiene que quedar con al menos tres puntos. Para sacarla entera, usá Borrar.');
      return;
    }
    camino.removeAt(indice);
  }

  /**
   * Un cambio hecho con el mouse sobre el mapa. Arrastrar el área entera
   * dispara un aviso por esquina: se juntan en uno solo para que "deshacer"
   * vuelva el movimiento entero y no una esquina.
   */
  function alMoverse(id) {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => {
      const area = areas.find(a => a.id === id);
      const poligono = poligonos.get(id);
      if (!area || !poligono) return;

      const puntos = poligono.getPath().getArray()
        .map(p => ({ lat: p.lat(), lng: p.lng() }));
      const saneada = sanearZona({ areas: [{ tipo: area.tipo, puntos }] }).areas[0];
      if (!saneada) return;

      deshacer.push(ultimo);
      if (deshacer.length > MAX_DESHACER) deshacer.shift();
      area.puntos = saneada.puntos.slice(0, MAX_PUNTOS);
      despuesDeCambiar();
      actualizarPrueba();
    }, 60);
  }

  function refrescarEstilos() {
    repintando = true;
    for (const area of areas) {
      const poligono = poligonos.get(area.id);
      if (!poligono) continue;
      const { paths, ...resto } = opcionesDe(area);
      poligono.setOptions(resto);
    }
    repintando = false;
  }

  /* ── Acciones ───────────────────────────────────────────────────────────── */

  function agregarArea(tipo, puntos) {
    if (areas.length >= MAX_AREAS) {
      mostrarCartel(`Hay un tope de ${MAX_AREAS} zonas y recortes.`);
      return;
    }
    antesDeCambiar();
    const area = conId({ tipo, puntos });
    areas.push(area);
    seleccion = area.id;
    dibujarPoligonos();
    despuesDeCambiar();
    actualizarPrueba();
  }

  function agregarCirculo() {
    const entrada = overlay.querySelector('[data-radio]');
    const radio = Number(String(entrada?.value || '').replace(',', '.'));
    if (!(radio > 0 && radio <= 60)) {
      mostrarCartel('Poné un radio entre 0,1 y 60 km.');
      entrada?.focus();
      return;
    }
    // Es el primer paso: siempre alrededor del local. Los barrios sueltos
    // salen de "Otro lugar donde llegamos", en el centro de lo que se ve.
    agregarArea('incluir', circulo(origen, radio, 36));
    encuadrar();
  }

  /** Un recorte chico en el centro de lo que se ve, para llevarlo a su lugar. */
  function agregarRecorte() {
    const centro = mapa ? aPunto(mapa.getCenter()) : origen;
    agregarArea('excluir', circulo(centro, radioSegunVista(), 12));
    mostrarCartel('Llevá el recorte rojo hasta donde no se llega y ajustale los puntos.');
  }

  /** Otro lugar donde se llega: un círculo en el centro de lo que se ve. */
  function agregarOtraZona() {
    const centro = mapa ? aPunto(mapa.getCenter()) : origen;
    agregarArea('incluir', circulo(centro, radioSegunVista() * 1.6, 24));
    mostrarCartel('Llevá la zona nueva hasta el barrio y ajustale los puntos.');
  }

  /** Un radio de un catorceavo del ancho que se ve: ni un punto perdido ni media ciudad. */
  function radioSegunVista() {
    const limites = mapa?.getBounds();
    if (!limites) return 0.8;
    const ne = aPunto(limites.getNorthEast());
    const so = aPunto(limites.getSouthWest());
    return Math.max(0.15, kmEntre({ lat: ne.lat, lng: so.lng }, ne) / 14);
  }

  function escalarSeleccion(factor) {
    const area = areaSeleccionada();
    if (!area) return;
    antesDeCambiar();
    area.puntos = escalar(area.puntos, factor);
    dibujarPoligonos();
    despuesDeCambiar();
    actualizarPrueba();
  }

  function borrarSeleccion() {
    const area = areaSeleccionada();
    if (!area) return;
    antesDeCambiar();
    areas = areas.filter(a => a.id !== area.id);
    seleccion = areas[areas.length - 1]?.id ?? null;
    dibujarPoligonos();
    despuesDeCambiar();
    actualizarPrueba();
  }

  async function borrarTodo() {
    if (!areas.length) return;
    const ok = await confirmDialog({
      title: 'Empezar de nuevo',
      message: 'Se borran todas las zonas y los recortes del mapa. Se puede deshacer mientras el editor siga abierto.',
      confirmText: 'Borrar y empezar',
      danger: true,
    });
    if (!ok) return;
    antesDeCambiar();
    areas = [];
    seleccion = null;
    dibujarPoligonos();
    despuesDeCambiar();
    actualizarPrueba();
  }

  function deshacerUltimo() {
    const anterior = deshacer.pop();
    if (!anterior) return;
    areas = JSON.parse(anterior);
    if (!areas.some(a => a.id === seleccion)) seleccion = areas[areas.length - 1]?.id ?? null;
    ultimo = anterior;
    dibujarPoligonos();
    pintarLateral();
    actualizarPrueba();
  }

  /* ── Modos: dibujar a mano y probar ─────────────────────────────────────── */

  function cambiarModo(nuevo) {
    sacandoEsquinas = false;
    if (modo === 'dibujar') limpiarTrazo();
    if (modo === 'probar') limpiarPrueba();
    modo = nuevo;
    // En el celular, mientras se dibuja o se prueba, el mapa ocupa todo: la
    // barra de arriba del mapa ya tiene lo que hace falta.
    overlay.dataset.modo = modo;
    mapa?.setOptions({
      draggableCursor: modo === 'editar' ? null : 'crosshair',
      disableDoubleClickZoom: modo === 'dibujar',
    });
    refrescarEstilos();
    pintarLateral();
  }

  function empezarDibujo(tipo) {
    tipoDibujo = tipo;
    cambiarModo('dibujar');
  }

  function alTocarElMapa(ev) {
    const punto = aPunto(ev.latLng);
    // Al dibujar, los puntos los pone escucharToquesParaDibujar().
    if (modo === 'dibujar') return;
    if (modo === 'probar') {
      probarEn(punto);
    } else if (seleccion !== null) {
      // Tocar afuera suelta el área elegida, así se puede mover el mapa sin
      // arrastrarla por error.
      seleccion = null;
      sacandoEsquinas = false;
      refrescarEstilos();
      pintarLateral();
    }
  }

  function sumarEsquina(punto) {
    if (trazo.length >= MAX_PUNTOS) return;
    trazo.push(punto);
    pintarTrazo();
    pintarLateral();
  }

  function pintarTrazo() {
    if (!mapa) return;
    lineaTrazo?.setMap(null);
    puntosTrazo.forEach(m => m.setMap(null));
    lineaTrazo = new gm.Polyline({
      map: mapa, path: trazo, clickable: false,
      strokeColor: COLOR[tipoDibujo], strokeWeight: 2, strokeOpacity: 0.9,
    });
    puntosTrazo = trazo.map((p, i) => new gm.Marker({
      map: mapa, position: p, clickable: false,
      icon: {
        path: gm.SymbolPath.CIRCLE, scale: i === 0 ? 6 : 4,
        fillColor: '#ffffff', fillOpacity: 1, strokeColor: COLOR[tipoDibujo], strokeWeight: 2,
      },
    }));
  }

  function limpiarTrazo() {
    trazo = [];
    lineaTrazo?.setMap(null);
    lineaTrazo = null;
    puntosTrazo.forEach(m => m.setMap(null));
    puntosTrazo = [];
  }

  function terminarDibujo() {
    if (trazo.length < 3) {
      mostrarCartel('Faltan puntos: hacen falta al menos tres.');
      return;
    }
    const puntos = [...trazo];
    const tipo = tipoDibujo;
    cambiarModo('editar');
    agregarArea(tipo, puntos);
  }

  function probarEn(punto) {
    const adentro = dentroDeZona(punto, { activa: true, areas });
    resultadoPrueba = { punto, adentro, km: kmEntre(origen, punto) };
    marcaPrueba?.setMap(null);
    marcaPrueba = new gm.Marker({
      map: mapa, position: punto, clickable: false, zIndex: 900,
      icon: {
        path: gm.SymbolPath.CIRCLE, scale: 9,
        fillColor: adentro ? '#2e7d32' : '#d32f2f', fillOpacity: 1,
        strokeColor: '#ffffff', strokeWeight: 3,
      },
    });
    pintarLateral();
  }

  /** Si hay un punto de prueba puesto, se vuelve a medir tras cada cambio. */
  function actualizarPrueba() {
    if (resultadoPrueba && modo === 'probar') probarEn(resultadoPrueba.punto);
  }

  function limpiarPrueba() {
    marcaPrueba?.setMap(null);
    marcaPrueba = null;
    resultadoPrueba = null;
  }

  /* ── Lateral y barra del mapa ───────────────────────────────────────────── */

  // "incluir" y "excluir" dicho como lo dice el local: dónde llegamos y dónde no.
  const NOMBRE = { incluir: 'Zona', excluir: 'Recorte' };
  const DICE = { incluir: 'Llegamos', excluir: 'No llegamos' };

  function pintarLateral() {
    const lateral = overlay.querySelector('[data-lateral]');
    if (!lateral) return;
    const radioAnterior = lateral.querySelector('[data-radio]')?.value;

    const deReparto = areas.filter(a => a.tipo === 'incluir');
    const elegida = areaSeleccionada();
    const localAdentro = dentroDeZona(origen, { activa: true, areas });
    const alcance = deReparto.length
      ? Math.max(...deReparto.flatMap(a => a.puntos.map(p => kmEntre(origen, p))))
      : 0;
    const ultimoTramo = [...(tramos || [])].filter(t => t.hasta_km > 0)
      .sort((a, b) => a.hasta_km - b.hasta_km).pop();

    const avisos = [];
    if (areas.length && !deReparto.length) {
      avisos.push(`Solo hay recortes. Sin una zona violeta no se usa el mapa y la tienda sigue con el radio de ${km(radioKm || 12)} km.`);
    } else if (deReparto.length && !localAdentro) {
      avisos.push('El local quedó afuera de la zona. Si no es a propósito, agrandala o movela.');
    }
    if (deReparto.length && ultimoTramo && alcance > ultimoTramo.hasta_km) {
      avisos.push(`La zona llega a ${km(alcance)} km y el último precio es hasta `
        + `${km(ultimoTramo.hasta_km)} km: lo que quede más lejos paga ${pesos(ultimoTramo.precio)}.`);
    }

    const numero = (area) => areas.filter(a => a.tipo === area.tipo).indexOf(area) + 1;
    const nombreDe = (area) => `${NOMBRE[area.tipo]} ${numero(area)}`;

    const filaDeArea = (area) => `
      <button class="zona-editor__area zona-editor__area--${area.tipo} ${area.id === seleccion ? 'es-elegida' : ''}"
              data-elegir="${area.id}" aria-pressed="${area.id === seleccion}">
        <i class="zona-editor__muestra zona-editor__muestra--${area.tipo}" aria-hidden="true"></i>
        <span class="zona-editor__area-nombre">${nombreDe(area)}</span>
        <span class="zona-editor__area-dice zona-editor__area-dice--${area.tipo}">${DICE[area.tipo]}</span>
        <span class="zona-editor__area-dato">${km(areaKm2(area.puntos))} km²</span>
      </button>`;

    // En una pantalla táctil no hay clic derecho: la ayuda nombra el botón.
    const tactil = window.matchMedia?.('(pointer: coarse)').matches;

    const ayuda = (icono, texto) => `
      <li><span class="material-icons" aria-hidden="true">${icono}</span><span>${texto}</span></li>`;

    let html;

    if (modo === 'dibujar') {
      html = `
        <section class="zona-editor__seccion">
          <h4>${tipoDibujo === 'excluir' ? 'Dibujando un recorte' : 'Dibujando una zona'}</h4>
          <ul class="zona-editor__ayuda">
            ${ayuda('touch_app', 'Tocá el mapa en cada esquina, una después de la otra.')}
            ${ayuda('check', 'Con tres o más, tocá <b>Terminar</b>. Se cierra sola.')}
            ${ayuda('undo', 'Si marcaste mal, <b>Sacar la última</b>.')}
          </ul>
        </section>`;
    } else if (!areas.length) {
      // El primer paso, guiado: casi siempre es un círculo alrededor del local.
      html = `
        <section class="zona-editor__seccion zona-editor__inicio">
          <span class="zona-editor__paso">Paso 1</span>
          <h3>Marcá hasta dónde llevan los pedidos</h3>
          <p>Empezá con un círculo alrededor del local. Después le cambiás la forma para que siga las calles.</p>
          <label class="zona-editor__circulo" for="zonaRadio">
            <span>Radio</span>
            <input type="number" id="zonaRadio" data-radio min="0.1" max="60" step="0.5"
                   value="${esc(radioAnterior ?? radioKm ?? 5)}">
            <span>km</span>
          </label>
          <button class="pc-btn zona-editor__principal zona-editor__ancho" data-accion="circulo">
            <span class="material-icons">radio_button_checked</span> Crear la zona
          </button>
          <button class="zona-editor__enlace" data-accion="dibujar-area">o dibujala punto por punto</button>
        </section>`;
    } else {
      html = `
        <section class="zona-editor__seccion">
          <h4>Tu zona</h4>
          ${deReparto.length ? `
          <div class="zona-editor__resumen">
            <div><span>Llega hasta</span><b>${km(alcance)} km</b></div>
            <div><span>Superficie</span><b>${km(deReparto.reduce((t, a) => t + areaKm2(a.puntos), 0))} km²</b></div>
          </div>` : ''}
          <div class="zona-editor__areas">${areas.map(filaDeArea).join('')}</div>
        </section>

        <section class="zona-editor__seccion zona-editor__caja">
          ${elegida ? `
            <h4>Cambiar ${nombreDe(elegida).toLowerCase()}</h4>
            <div class="zona-editor__grilla">
              <button class="pc-btn" data-accion="agrandar"><span class="material-icons">add</span> Agrandar</button>
              <button class="pc-btn" data-accion="achicar"><span class="material-icons">remove</span> Achicar</button>
              <button class="pc-btn ${sacandoEsquinas ? 'active' : ''}" data-accion="sacar-esquinas"
                      aria-pressed="${sacandoEsquinas}">
                <span class="material-icons">${sacandoEsquinas ? 'check' : 'highlight_off'}</span>
                ${sacandoEsquinas ? 'Listo' : 'Sacar puntos'}
              </button>
              <button class="pc-btn danger" data-accion="borrar"><span class="material-icons">delete_outline</span> Borrar</button>
            </div>
            <ul class="zona-editor__ayuda">
              ${ayuda('open_with', 'Arrastrá un <b>punto blanco</b> para mover esa esquina.')}
              ${ayuda('add_circle_outline', 'Tirá del <b>punto chiquito</b> entre dos esquinas para sumar una.')}
              ${sacandoEsquinas
                ? ayuda('touch_app', 'Tocá los puntos que quieras sacar.')
                : (tactil
                    ? ayuda('highlight_off', 'Para sacar un punto, tocá <b>Sacar puntos</b> y después el punto.')
                    : ayuda('mouse', '<b>Clic derecho</b> sobre un punto para sacarlo.'))}
              ${ayuda('pan_tool', 'Arrastrá desde adentro para mover todo.')}
            </ul>` : `
            <h4>Cambiar la forma</h4>
            <p class="zona-editor__pista">Tocá una zona en el mapa o en la lista de arriba para agrandarla, achicarla o moverle los puntos.</p>`}
        </section>

        <section class="zona-editor__seccion">
          <h4>Agregar</h4>
          <div class="zona-editor__agregar zona-editor__agregar--incluir">
            <div>
              <b>Otro lugar donde llegamos</b>
              <span>Un barrio suelto, lejos de la zona.</span>
            </div>
            <div class="zona-editor__fila">
              <button class="pc-btn" data-accion="otra-zona" title="Un círculo en el centro de lo que se ve">
                <span class="material-icons">radio_button_unchecked</span> Círculo
              </button>
              <button class="pc-btn" data-accion="dibujar-area" title="Marcando las esquinas en el mapa">
                <span class="material-icons">gesture</span> A mano
              </button>
            </div>
          </div>
          <div class="zona-editor__agregar zona-editor__agregar--excluir">
            <div>
              <b>Una parte donde no llegamos</b>
              <span>Adentro de la zona, pero ahí no se entrega.</span>
            </div>
            <div class="zona-editor__fila">
              <button class="pc-btn" data-accion="recorte" title="Un círculo en el centro de lo que se ve">
                <span class="material-icons">radio_button_unchecked</span> Círculo
              </button>
              <button class="pc-btn" data-accion="dibujar-recorte" title="Marcando las esquinas en el mapa">
                <span class="material-icons">gesture</span> A mano
              </button>
            </div>
          </div>
        </section>

        <section class="zona-editor__seccion">
          <button class="pc-btn zona-editor__ancho ${modo === 'probar' ? 'active' : ''}" data-accion="probar"
                  aria-pressed="${modo === 'probar'}">
            <span class="material-icons">${modo === 'probar' ? 'check' : 'where_to_vote'}</span>
            ${modo === 'probar' ? 'Terminar la prueba' : 'Probar un lugar del mapa'}
          </button>
        </section>

        ${avisos.map(a => `
          <p class="zona-editor__aviso"><span class="material-icons">warning_amber</span><span>${esc(a)}</span></p>`).join('')}

        <div class="zona-editor__pie">
          <button class="pc-btn" data-accion="deshacer" ${deshacer.length ? '' : 'disabled'}>
            <span class="material-icons">undo</span> Deshacer
          </button>
          <button class="pc-btn" data-accion="encuadrar">
            <span class="material-icons">zoom_out_map</span> Ver todo
          </button>
          <button class="pc-btn danger" data-accion="borrar-todo">
            <span class="material-icons">layers_clear</span> Empezar de nuevo
          </button>
        </div>`;
    }

    lateral.innerHTML = html;
    pintarBarra();
  }

  /**
   * La barra de arriba del mapa mientras se dibuja o se prueba: lo que hay que
   * hacer y los botones para terminar, al lado de donde se está tocando.
   */
  function pintarBarra() {
    const barra = overlay.querySelector('[data-barra]');
    if (!barra) return;

    if (modo === 'dibujar') {
      barra.hidden = false;
      barra.className = `zona-editor__barra zona-editor__barra--${tipoDibujo}`;
      barra.innerHTML = `
        <span class="zona-editor__barra-texto">
          <span class="material-icons">touch_app</span>
          <span>Tocá el mapa en cada esquina · <b>${trazo.length}</b> ${trazo.length === 1 ? 'punto' : 'puntos'}</span>
        </span>
        <span class="zona-editor__barra-botones">
          <button class="pc-btn" data-accion="quitar-esquina" ${trazo.length ? '' : 'disabled'}>Sacar la última</button>
          <button class="pc-btn" data-accion="modo-editar">Cancelar</button>
          <button class="pc-btn zona-editor__principal" data-accion="terminar" ${trazo.length < 3 ? 'disabled' : ''}>
            <span class="material-icons">check</span> Terminar
          </button>
        </span>`;
    } else if (modo === 'probar') {
      barra.hidden = false;
      const r = resultadoPrueba;
      barra.className = `zona-editor__barra ${r ? (r.adentro ? 'zona-editor__barra--si' : 'zona-editor__barra--no') : ''}`;
      barra.innerHTML = `
        <span class="zona-editor__barra-texto">
          <span class="material-icons">${r ? (r.adentro ? 'check_circle' : 'block') : 'where_to_vote'}</span>
          <span>${r
            ? (r.adentro
                ? `<b>Llegamos.</b> La tienda deja pedir con envío. A ${km(r.km)} km del local.`
                : `<b>No llegamos.</b> La tienda solo ofrece retirarlo. A ${km(r.km)} km del local.`)
            : 'Tocá cualquier lugar del mapa y te digo si la tienda deja pedir con envío ahí.'}</span>
        </span>
        <span class="zona-editor__barra-botones">
          <button class="pc-btn" data-accion="probar">Terminar</button>
        </span>`;
    } else {
      barra.hidden = true;
      barra.innerHTML = '';
    }
  }

  let temporizadorCartel = null;
  function mostrarCartel(texto) {
    const cartel = overlay.querySelector('[data-cartel]');
    if (!cartel) return;
    cartel.textContent = texto;
    cartel.hidden = false;
    clearTimeout(temporizadorCartel);
    temporizadorCartel = setTimeout(() => { cartel.hidden = true; }, 5000);
  }

  /* ── Eventos ────────────────────────────────────────────────────────────── */

  function alClic(ev) {
    const elegir = ev.target.closest('[data-elegir]');
    if (elegir) {
      seleccion = Number(elegir.dataset.elegir);
      refrescarEstilos();
      pintarLateral();
      // Llevar el mapa hasta el área, por si quedó fuera de la vista.
      const area = areaSeleccionada();
      if (mapa && area) {
        const c = centroDe(area.puntos);
        if (!mapa.getBounds()?.contains(c)) mapa.panTo(c);
      }
      return;
    }

    const boton = ev.target.closest('[data-accion]');
    if (!boton || boton.disabled) return;
    const acciones = {
      cancelar: cancelar,
      aplicar: aplicar,
      circulo: agregarCirculo,
      recorte: agregarRecorte,
      'otra-zona': agregarOtraZona,
      'dibujar-area': () => empezarDibujo('incluir'),
      'dibujar-recorte': () => empezarDibujo('excluir'),
      terminar: terminarDibujo,
      'quitar-esquina': () => { trazo.pop(); pintarTrazo(); pintarLateral(); },
      'modo-editar': () => cambiarModo('editar'),
      probar: () => cambiarModo(modo === 'probar' ? 'editar' : 'probar'),
      agrandar: () => escalarSeleccion(1 + PASO_ESCALA),
      achicar: () => escalarSeleccion(1 / (1 + PASO_ESCALA)),
      borrar: borrarSeleccion,
      'borrar-todo': borrarTodo,
      'sacar-esquinas': () => {
        sacandoEsquinas = !sacandoEsquinas;
        pintarLateral();
        if (sacandoEsquinas) mostrarCartel('Tocá los puntos blancos que quieras sacar.');
      },
      deshacer: deshacerUltimo,
      encuadrar: encuadrar,
    };
    acciones[boton.dataset.accion]?.();
  }

  function alTeclado(ev) {
    if (!overlay.isConnected) return;
    // Con un diálogo de confirmación arriba, las teclas son de él.
    if (document.querySelector('.app-dialog-overlay')) return;
    // Enter en el radio agrega el círculo: es lo que se espera al escribir un número.
    if (ev.key === 'Enter' && ev.target.matches?.('[data-radio]')) {
      ev.preventDefault();
      agregarCirculo();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      if (ev.target.matches?.('input')) return;
      ev.preventDefault();
      if (modo === 'dibujar') { trazo.pop(); pintarTrazo(); pintarLateral(); } else deshacerUltimo();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      if (modo !== 'editar') cambiarModo('editar');
      else cancelar();
    }
  }

  /* ── Salir ──────────────────────────────────────────────────────────────── */

  async function cancelar() {
    if (hayCambios()) {
      const ok = await confirmDialog({
        title: 'Descartar los cambios',
        message: 'Lo que dibujaste en el mapa se pierde. La zona guardada queda como estaba.',
        confirmText: 'Descartar',
        cancelText: 'Seguir editando',
        danger: true,
      });
      if (!ok) return;
    }
    cerrar(null);
  }

  function aplicar() {
    if (modo === 'dibujar' && trazo.length >= 3) terminarDibujo();
    const zonaFinal = sanearZona({ areas: areas.map(({ tipo, puntos }) => ({ tipo, puntos })) });
    cerrar({ areas: zonaFinal.areas });
  }

  function cerrar(resultado) {
    clearTimeout(temporizador);
    clearTimeout(temporizadorCartel);
    soltarFalla();
    document.removeEventListener('keydown', alTeclado);
    poligonos.forEach(p => p.setMap(null));
    marcaLocal?.setMap(null);
    limpiarTrazo();
    limpiarPrueba();
    overlay.remove();
    document.body.classList.remove('zona-editor-abierto');
    resolver(resultado);
  }

  return { abrir };
}

function aPunto(latLng) {
  return { lat: latLng.lat(), lng: latLng.lng() };
}
