/**
 * Configuración de la tienda online.
 *
 * Todo lo que la tienda muestra y cobra sin que haya que tocar código: los
 * horarios, cuánto sale el envío según la distancia, hasta dónde se reparte,
 * el alias para transferir y qué rubros salen a la web.
 *
 * Dos cosas escriben acá:
 *
 *   · `tienda_config/settings` — lo lee la tienda al cargar y también las tres
 *     funciones de servidor (envío, direcciones, asistente), que la leen por la
 *     API REST sin credenciales porque es pública.
 *   · `tienda_config/publicacion` — qué rubros se publican. Cambiarlo mueve
 *     cientos de productos, así que el panel espeja el rubro entero en el
 *     momento en vez de esperar al sync.
 *
 * Los valores por defecto son los mismos que tiene la tienda en
 * `tienda/src/datos.js`: si el documento no existe, la tienda igual funciona.
 */
import { collection, doc, getDoc, getDocs, orderBy, query, setDoc } from 'firebase/firestore';
import { getCached, invalidateCache } from '../cache.js';
import { alertDialog, confirmDialog, escHtml } from '../components/dialogs.js';
import { espejarLote, recomputarRubros, motivoDeNoPublicar, nombreBonito } from '../tienda_espejo.js';
import '../styles/tienda.css';

const POR_DEFECTO = {
  abierta: true,
  nombre: 'Librería Liceo',
  telefono: '3517046684',
  whatsapp: '5493517046684',
  email: 'libreria.liceo@hotmail.com',
  direccion: 'Av. Alfonsina Storni 168, X5019 Córdoba',
  barrio: 'Parque Liceo 1ª Sección',
  horarios_texto: '',
  banner: null,
  entrega: {
    retiro_habilitado: true,
    delivery_habilitado: true,
    radio_max_km: 12,
    tramos: [{ hasta_km: 3, precio: 1500 }, { hasta_km: 6, precio: 2500 }, { hasta_km: 12, precio: 3500 }],
    envio_gratis_desde: null,
    demora_texto: '24 a 48 hs',
    pedido_minimo: 0,
  },
  pago: { alias: null, titular: null },
};

let _db = null;
let _config = null;
let _tramos = [];
let _habilitados = [];
let _catalogo = [];

/* ── Lectura ──────────────────────────────────────────────────────────────── */

async function leerConfig(db) {
  const snap = await getDoc(doc(db, 'tienda_config', 'settings'));
  const datos = snap.exists() ? snap.data() : {};
  return {
    ...POR_DEFECTO, ...datos,
    entrega: { ...POR_DEFECTO.entrega, ...(datos.entrega || {}) },
    pago: { ...POR_DEFECTO.pago, ...(datos.pago || {}) },
  };
}

/* ── Pintado ──────────────────────────────────────────────────────────────── */

function pesos(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

function campo(id, etiqueta, valor, { pista = '', tipo = 'text', placeholder = '' } = {}) {
  return `
    <div class="tienda-campo">
      <label for="${id}">${etiqueta}</label>
      <input type="${tipo}" id="${id}" value="${escHtml(valor ?? '')}"
             placeholder="${escHtml(placeholder)}">
      ${pista ? `<div class="tienda-pista">${pista}</div>` : ''}
    </div>`;
}

function pintarTramos() {
  const caja = document.getElementById('cfgTramos');
  if (!caja) return;

  caja.innerHTML = _tramos.map((t, i) => `
    <div style="display:grid;grid-template-columns:1fr 1fr 38px;gap:10px;align-items:end;margin-bottom:8px"
         data-tramo="${i}">
      <div class="tienda-campo" style="margin:0">
        <label>Hasta (km)</label>
        <input type="number" step="0.5" min="0" data-campo="hasta_km" value="${t.hasta_km}">
      </div>
      <div class="tienda-campo" style="margin:0">
        <label>Cuesta</label>
        <input type="number" step="100" min="0" data-campo="precio" value="${t.precio}">
      </div>
      <button class="pc-btn danger" data-quitar="${i}" style="height:37px" title="Quitar tramo">
        <span class="material-icons">delete</span>
      </button>
    </div>`).join('')
    + `<button class="pc-btn" id="cfgAgregarTramo" style="margin-top:4px">
         <span class="material-icons">add</span> Agregar tramo
       </button>`;

  pintarTramosResumen(_tramos);
}

/**
 * La tabla leída como la lee el cliente.
 *
 * Los campos dicen "hasta 6 km, $2.500", que es la forma de cargarlo, pero lo
 * que se cobra es un rango. Verlo escrito es lo que hace notar el tramo que
 * quedó cubriendo desde cero.
 */
function pintarTramosResumen(tramos) {
  const resumen = document.getElementById('cfgTramosResumen');
  if (!resumen) return;

  const ordenados = [...tramos].filter(t => t.hasta_km > 0).sort((a, b) => a.hasta_km - b.hasta_km);
  resumen.innerHTML = ordenados.length
    ? ordenados.map((t, i) => {
        const desde = i === 0 ? 0 : ordenados[i - 1].hasta_km;
        return `<div>De ${String(desde).replace('.', ',')} a
                ${String(t.hasta_km).replace('.', ',')} km · <b>${pesos(t.precio)}</b></div>`;
      }).join('')
      + `<div style="margin-top:5px;color:var(--tint-red-fg)">
           Más de ${String(ordenados[ordenados.length - 1].hasta_km).replace('.', ',')} km ·
           fuera de reparto</div>`
    : '<div>Sin tramos cargados: la tienda cotiza "a confirmar".</div>';
}

function pintarRubros() {
  const caja = document.getElementById('cfgRubros');
  if (!caja) return;

  // Cuántos productos entrarían por cada rubro si se habilita. Se calcula sobre
  // el catálogo entero con las reglas del sync, no adivinando: habilitar un
  // rubro de 600 productos donde 53 tienen stock publica 53.
  const porRubro = new Map();
  for (const d of _catalogo) {
    const rubro = String(d.rubro || '').trim().toUpperCase();
    if (!rubro) continue;
    const actual = porRubro.get(rubro) || { total: 0, publicables: 0 };
    actual.total++;
    // Se pregunta como si el rubro estuviera habilitado: interesa cuántos
    // entrarían, no cuántos entran hoy.
    if (!motivoDeNoPublicar(d, null)) actual.publicables++;
    porRubro.set(rubro, actual);
  }

  const lista = [...porRubro.entries()].sort((a, b) => b[1].publicables - a[1].publicables);

  caja.innerHTML = lista.map(([rubro, n]) => `
    <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;
                  cursor:pointer;border:1px solid var(--border);background:var(--card-bg)">
      <input type="checkbox" data-rubro="${escHtml(rubro)}"
             ${_habilitados.includes(rubro) ? 'checked' : ''}
             style="width:17px;height:17px;cursor:pointer">
      <span style="flex:1;min-width:0">
        <b style="font-size:13.5px">${escHtml(nombreBonito(rubro))}</b>
        <span style="display:block;font-size:11.5px;color:var(--text-muted)">
          ${n.publicables} con stock de ${n.total}
        </span>
      </span>
    </label>`).join('');
}

/* ── Entrada ──────────────────────────────────────────────────────────────── */

export async function renderTiendaAjustes(container, db) {
  _db = db;

  container.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px">
    ${Array(4).fill('<div class="skel skel-card" style="height:120px"></div>').join('')}
  </div>`;

  const [config, publicacion, catalogo] = await Promise.all([
    leerConfig(db),
    getDoc(doc(db, 'tienda_config', 'publicacion')),
    getCached('catalogo:all', async () => {
      const snap = await getDocs(query(collection(db, 'catalogo'), orderBy('nombre')));
      return snap.docs.map(d => ({ ...d.data(), doc_id: d.id }));
    }, { ttl: 10 * 60 * 1000, memOnly: true }),
  ]);

  _config = config;
  _tramos = (config.entrega.tramos || []).map(t => ({
    hasta_km: Number(t.hasta_km) || 0, precio: Number(t.precio) || 0,
  }));
  _habilitados = Array.isArray(publicacion.data()?.rubros)
    ? publicacion.data().rubros.map(r => String(r).trim().toUpperCase()) : [];
  _catalogo = (catalogo || []).filter(d => d && d.doc_id)
    .map(d => (typeof d.doc_id === 'string' ? d : { ...d, doc_id: String(d.doc_id) }));

  const e = config.entrega;

  container.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px;align-items:start">

      <section class="tienda-bloque" style="background:var(--surface);border:1px solid var(--border);
               border-radius:12px;padding:18px 20px;margin:0">
        <h4>El local</h4>
        <label style="display:flex;align-items:center;gap:10px;margin-bottom:14px;cursor:pointer">
          <button class="tienda-switch" id="cfgAbierta" aria-checked="${config.abierta !== false}"></button>
          <span style="font-size:13.5px">
            <b id="cfgAbiertaTexto">${config.abierta !== false ? 'La tienda toma pedidos' : 'Tienda cerrada'}</b>
            <span style="display:block;font-size:11.5px;color:var(--text-muted)">
              Cerrada se puede mirar el catálogo, pero no se puede confirmar un pedido.
            </span>
          </span>
        </label>
        ${campo('cfgNombre', 'Nombre', config.nombre)}
        ${campo('cfgDireccion', 'Dirección', config.direccion)}
        ${campo('cfgTelefono', 'Teléfono', config.telefono)}
        ${campo('cfgWhatsapp', 'WhatsApp', config.whatsapp,
          { pista: 'Con código de país y sin signos: 5493517046684' })}
        ${campo('cfgEmail', 'Email', config.email)}
        <div class="tienda-campo">
          <label for="cfgHorarios">Horarios</label>
          <textarea id="cfgHorarios" rows="3">${escHtml(config.horarios_texto || '')}</textarea>
          <div class="tienda-pista">
            Separados por punto medio (·). Cada tramo se muestra en su renglón.
          </div>
        </div>
        ${campo('cfgBanner', 'Aviso en la portada', config.banner,
          { placeholder: 'Vacío = sin aviso',
            pista: 'Una línea arriba de todo: "Cerramos por vacaciones del 1 al 10".' })}
      </section>

      <section class="tienda-bloque" style="background:var(--surface);border:1px solid var(--border);
               border-radius:12px;padding:18px 20px;margin:0">
        <h4>Entrega</h4>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13.5px">
            <input type="checkbox" id="cfgRetiro" ${e.retiro_habilitado !== false ? 'checked' : ''}
                   style="width:17px;height:17px;cursor:pointer">
            Retiro en el local
          </label>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13.5px">
            <input type="checkbox" id="cfgDelivery" ${e.delivery_habilitado !== false ? 'checked' : ''}
                   style="width:17px;height:17px;cursor:pointer">
            Envío a domicilio
          </label>
        </div>

        <div class="tienda-dos">
          ${campo('cfgRadio', 'Radio máximo (km)', e.radio_max_km, { tipo: 'number' })}
          ${campo('cfgDemora', 'Demora que se promete', e.demora_texto)}
        </div>
        ${campo('cfgGratis', 'Envío gratis desde', e.envio_gratis_desde ?? '',
          { tipo: 'number', placeholder: 'Vacío = nunca',
            pista: 'Monto de productos, sin contar el envío.' })}
        ${campo('cfgMinimo', 'Pedido mínimo', e.pedido_minimo ?? '',
          { tipo: 'number', placeholder: 'Vacío = sin mínimo',
            pista: 'Preparar un pedido cuesta lo mismo valga $500 o $50.000. '
                 + 'Debajo del mínimo el checkout muestra cuánto falta y no deja confirmar.' })}

        <h4 style="margin-top:18px">Cuánto sale el envío</h4>
        <div id="cfgTramos"></div>
        <div class="tienda-pista" id="cfgTramosResumen" style="margin-top:10px;line-height:1.7"></div>
      </section>

      <section class="tienda-bloque" style="background:var(--surface);border:1px solid var(--border);
               border-radius:12px;padding:18px 20px;margin:0">
        <h4>Transferencia</h4>
        ${campo('cfgAlias', 'Alias', config.pago?.alias,
          { placeholder: 'libreria.liceo.mp' })}
        ${campo('cfgTitular', 'A nombre de', config.pago?.titular,
          { placeholder: 'María Brizuela' })}
        <div class="tienda-pista">
          Mientras estén vacíos, el checkout le dice al cliente que los datos se
          los pasan al confirmar. Cargados, los muestra y los deja copiar.
        </div>
      </section>

      <section class="tienda-bloque" style="background:var(--surface);border:1px solid var(--border);
               border-radius:12px;padding:18px 20px;margin:0">
        <h4>Rubros en la tienda</h4>
        <div class="tienda-pista" style="margin-bottom:12px">
          Lo tildado sale a la web. Un producto suelto se puede forzar o sacar
          desde el catálogo de la tienda, sin tocar el rubro entero.
        </div>
        <div id="cfgRubros" style="display:flex;flex-direction:column;gap:6px;
                                   max-height:340px;overflow-y:auto"></div>
      </section>
    </div>

    <div style="display:flex;gap:12px;align-items:center;margin-top:18px;flex-wrap:wrap">
      <button class="pc-btn" id="cfgGuardar"
              style="padding:11px 26px;background:#4361ee;color:#fff;border-color:#4361ee;font-size:14px">
        <span class="material-icons">save</span> Guardar
      </button>
      <span id="cfgEstado" style="font-size:13px;color:var(--text-muted)"></span>
    </div>`;

  pintarTramos();
  pintarRubros();

  /* ── Eventos ── */
  const $ = sel => container.querySelector(sel);

  $('#cfgAbierta').addEventListener('click', () => {
    const abierta = $('#cfgAbierta').getAttribute('aria-checked') !== 'true';
    $('#cfgAbierta').setAttribute('aria-checked', String(abierta));
    $('#cfgAbiertaTexto').textContent = abierta ? 'La tienda toma pedidos' : 'Tienda cerrada';
  });

  $('#cfgTramos').addEventListener('click', ev => {
    if (ev.target.closest('#cfgAgregarTramo')) {
      const ultimo = _tramos[_tramos.length - 1];
      _tramos.push({ hasta_km: (ultimo?.hasta_km || 0) + 3, precio: ultimo?.precio || 1500 });
      pintarTramos();
      return;
    }
    const quitar = ev.target.closest('[data-quitar]');
    if (quitar) {
      _tramos.splice(Number(quitar.dataset.quitar), 1);
      pintarTramos();
    }
  });

  $('#cfgTramos').addEventListener('input', ev => {
    const entrada = ev.target.closest('[data-campo]');
    if (!entrada) return;
    const i = Number(entrada.closest('[data-tramo]').dataset.tramo);
    _tramos[i][entrada.dataset.campo] = Number(entrada.value) || 0;
    // Se repinta solo el resumen: repintar los campos mientras se escribe
    // pierde el cursor.
    pintarTramosResumen(_tramos);
  });

  $('#cfgGuardar').addEventListener('click', () => guardarTodo(container));
}

/* ── Guardar ──────────────────────────────────────────────────────────────── */

async function guardarTodo(container) {
  const $ = sel => container.querySelector(sel);
  const boton = $('#cfgGuardar');
  const estado = $('#cfgEstado');

  const elegidos = [...container.querySelectorAll('[data-rubro]')]
    .filter(c => c.checked).map(c => c.dataset.rubro);

  const entraron = elegidos.filter(r => !_habilitados.includes(r));
  const salieron = _habilitados.filter(r => !elegidos.includes(r));

  // Mover un rubro entero es cientos de escrituras y se ve en la tienda al
  // instante. Se avisa antes con el número puesto, no después.
  if (entraron.length || salieron.length) {
    const afectados = _catalogo.filter(d => {
      const rubro = String(d.rubro || '').trim().toUpperCase();
      return entraron.includes(rubro) || salieron.includes(rubro);
    });

    const ok = await confirmDialog({
      title: 'Cambiar los rubros publicados',
      message: [
        entraron.length ? `Entran: ${entraron.map(nombreBonito).join(', ')}.` : '',
        salieron.length ? `Salen: ${salieron.map(nombreBonito).join(', ')}.` : '',
        `Se van a revisar ${afectados.length.toLocaleString('es-AR')} productos y la tienda`,
        'va a cambiar en el momento.',
      ].filter(Boolean).join(' '),
      confirmText: 'Aplicar',
    });
    if (!ok) return;
  }

  boton.disabled = true;
  estado.textContent = 'Guardando…';

  const numero = (id) => {
    const v = $(id).value.trim();
    return v === '' ? null : Number(v);
  };
  const texto = (id) => $(id).value.trim() || null;

  try {
    const ajustes = {
      abierta: $('#cfgAbierta').getAttribute('aria-checked') === 'true',
      nombre: texto('#cfgNombre') || 'Librería Liceo',
      direccion: texto('#cfgDireccion'),
      telefono: texto('#cfgTelefono'),
      whatsapp: texto('#cfgWhatsapp'),
      email: texto('#cfgEmail'),
      horarios_texto: $('#cfgHorarios').value.trim(),
      banner: texto('#cfgBanner'),
      entrega: {
        retiro_habilitado: $('#cfgRetiro').checked,
        delivery_habilitado: $('#cfgDelivery').checked,
        radio_max_km: numero('#cfgRadio') ?? 12,
        demora_texto: texto('#cfgDemora') || '24 a 48 hs',
        envio_gratis_desde: numero('#cfgGratis'),
        pedido_minimo: numero('#cfgMinimo') ?? 0,
        tramos: _tramos
          .filter(t => t.hasta_km > 0)
          .sort((a, b) => a.hasta_km - b.hasta_km)
          .map(t => ({ hasta_km: t.hasta_km, precio: Math.max(0, t.precio) })),
      },
      pago: { alias: texto('#cfgAlias'), titular: texto('#cfgTitular') },
      // El origen no se toca desde acá: está verificado contra Places y de esa
      // coordenada sale lo que paga cada cliente. Se conserva tal cual estaba.
      origen: _config.origen,
      origen_verificado: _config.origen_verificado,
      barrio: _config.barrio,
    };

    await setDoc(doc(_db, 'tienda_config', 'settings'), ajustes, { merge: true });

    if (entraron.length || salieron.length) {
      await setDoc(doc(_db, 'tienda_config', 'publicacion'), { rubros: elegidos });

      const afectados = _catalogo
        .filter(d => {
          const rubro = String(d.rubro || '').trim().toUpperCase();
          return entraron.includes(rubro) || salieron.includes(rubro);
        })
        .map(d => ({ id: d.doc_id, datos: d }));

      const { publicados, sacados } = await espejarLote(
        _db, afectados, elegidos,
        (hechos, total) => { estado.textContent = `Publicando… ${hechos} de ${total}`; });

      estado.textContent = 'Actualizando la portada…';
      await recomputarRubros(_db,
        _catalogo.map(d => ({ datos: d })), elegidos);

      _habilitados = elegidos;
      invalidateCache('tienda:publicacion');
      estado.textContent = `Guardado. ${publicados} productos en la tienda, ${sacados} afuera.`;
    } else {
      estado.textContent = 'Guardado.';
    }

    _config = { ...(_config || {}), ...ajustes };
  } catch (err) {
    console.error('[tienda] configuración:', err);
    estado.textContent = 'No se pudo guardar.';
    alertDialog({
      title: 'No se pudo guardar',
      message: err?.code === 'permission-denied'
        ? 'La configuración de la tienda la puede cambiar solo un administrador.'
        : String(err?.message || err),
    });
  } finally {
    boton.disabled = false;
  }
}
