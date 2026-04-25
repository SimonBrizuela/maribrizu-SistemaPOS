/**
 * Página: Perfiles de Clientes
 * Gestión de clientes para facturación con lookup automático al padrón de AFIP.
 */

import {
  collection, getDocs, addDoc, doc, updateDoc, deleteDoc, query, orderBy
} from 'firebase/firestore';
import { getCached, invalidateCacheByPrefix } from '../cache.js';

const COL = 'clientes_facturacion';
const CACHE_KEY = 'clientes:lista';

// ── Render ────────────────────────────────────────────────────────────────────
export async function renderClientes(container, db) {
  container.innerHTML = `
    <div style="max-width:900px;margin:0 auto;padding:16px 8px">

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
        <div>
          <h2 style="margin:0;font-size:20px;font-weight:700">Perfiles de Clientes</h2>
          <p style="margin:4px 0 0;color:var(--text-muted);font-size:13px">
            Clientes guardados para facturación. El cajero los selecciona al cobrar.
          </p>
        </div>
        <button id="btnNuevoCliente" style="
          background:var(--primary);color:white;border:none;border-radius:8px;
          padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;
          display:flex;align-items:center;gap:6px;font-family:inherit
        ">
          <span class="material-icons" style="font-size:18px">person_add</span> Nuevo cliente
        </button>
      </div>

      <!-- Buscador local -->
      <div style="margin-bottom:14px;position:relative">
        <span class="material-icons" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:20px">search</span>
        <input id="clienteBuscar" type="text" placeholder="Buscar por nombre o CUIT..."
          style="width:100%;box-sizing:border-box;padding:10px 12px 10px 40px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;background:var(--card-bg)" />
      </div>

      <div id="clientesLista" style="display:flex;flex-direction:column;gap:10px">
        <div style="text-align:center;padding:40px;color:var(--text-muted)">
          <span class="material-icons" style="font-size:40px;display:block;margin-bottom:8px">hourglass_empty</span>
          Cargando clientes...
        </div>
      </div>

      <!-- Modal -->
      <div id="clienteModal" style="
        display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);
        z-index:1000;align-items:center;justify-content:center;padding:16px
      ">
        <div style="
          background:white;border-radius:16px;padding:24px;width:100%;
          max-width:500px;max-height:90vh;overflow-y:auto;
          box-shadow:0 20px 60px rgba(0,0,0,0.3)
        ">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
            <h3 id="clienteModalTitulo" style="margin:0;font-size:18px;font-weight:700">Nuevo cliente</h3>
            <button id="clienteModalCerrar" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:28px;line-height:1;padding:0">&times;</button>
          </div>

          <form id="clienteForm" style="display:flex;flex-direction:column;gap:14px">
            <input type="hidden" id="clienteId" value="">

            <!-- CUIT con lookup AFIP -->
            <div>
              <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:6px">
                CUIT
                <span id="afipEstado" style="margin-left:8px;font-size:11px;font-weight:500"></span>
              </label>
              <div style="display:flex;gap:8px">
                <input id="cCuit" type="text" placeholder="20-12345678-9"
                  style="flex:1;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;box-sizing:border-box"
                  maxlength="13" inputmode="numeric" />
                <button type="button" id="btnBuscarAfip" style="
                  padding:10px 14px;background:#0d6efd;color:white;border:none;
                  border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;
                  display:flex;align-items:center;gap:5px;white-space:nowrap;font-family:inherit;flex-shrink:0
                ">
                  <span class="material-icons" style="font-size:16px">search</span> Buscar en AFIP
                </button>
              </div>
              <p style="margin:5px 0 0;font-size:11px;color:var(--text-muted)">
                Escribí el CUIT y hacé clic en "Buscar en AFIP" para auto-completar los datos.
              </p>
            </div>

            <!-- Nombre -->
            <div>
              <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                Nombre / Razón Social *
              </label>
              <input id="cNombre" type="text" placeholder="Ej: Distribuidora López"
                style="width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit">
            </div>

            <!-- Condición IVA -->
            <div>
              <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                Condición IVA
              </label>
              <select id="cCondIVA"
                style="width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;background:white">
                <option>Consumidor Final</option>
                <option>Responsable Inscripto</option>
                <option>Monotributista</option>
                <option>Exento</option>
              </select>
            </div>

            <!-- Domicilio -->
            <div>
              <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                Domicilio
              </label>
              <input id="cDomicilio" type="text" placeholder="Calle 123"
                style="width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit">
            </div>

            <!-- Localidad -->
            <div>
              <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                Localidad
              </label>
              <input id="cLocalidad" type="text"
                style="width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit">
            </div>

            <div id="clienteError" style="display:none;color:#dc3545;font-size:13px;padding:8px 12px;background:#fff0f0;border-radius:6px"></div>

            <div style="display:flex;gap:10px;margin-top:4px">
              <button type="button" id="btnCancelarClienteModal" style="
                flex:1;padding:12px;border:1.5px solid var(--border);border-radius:8px;
                background:white;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit
              ">Cancelar</button>
              <button type="submit" id="btnGuardarCliente" style="
                flex:2;padding:12px;background:var(--primary);color:white;border:none;
                border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit
              ">Guardar cliente</button>
            </div>
          </form>
        </div>
      </div>

    </div>
  `;

  await cargarClientes(db);
  setupClientesEvents(db);
}

// ── Cargar y renderizar lista ─────────────────────────────────────────────────
async function cargarClientes(db) {
  const lista = document.getElementById('clientesLista');
  try {
    const clientes = await getCached(CACHE_KEY, async () => {
      const snap = await getDocs(query(collection(db, COL), orderBy('nombre')));
      const arr = [];
      snap.forEach(d => arr.push({ _docId: d.id, ...d.data() }));
      return arr;
    }, { ttl: 60000, memOnly: true });
    window._clientesData = {};
    window._clientesTodos = clientes.filter(c => c.activo !== false);
    window._clientesTodos.forEach(c => { window._clientesData[c._docId] = c; });
    renderLista(window._clientesTodos);
  } catch (e) {
    lista.innerHTML = `<div style="color:#dc3545;padding:20px">Error cargando clientes: ${e.message}</div>`;
  }
}

function renderLista(clientes) {
  const lista = document.getElementById('clientesLista');
  if (!lista) return;

  if (!clientes.length) {
    lista.innerHTML = `
      <div style="text-align:center;padding:48px 20px;color:var(--text-muted);background:white;border-radius:12px;border:2px dashed var(--border)">
        <span class="material-icons" style="font-size:48px;display:block;margin-bottom:12px;opacity:0.4">person_search</span>
        <p style="margin:0;font-size:15px">No se encontraron clientes</p>
      </div>`;
    return;
  }

  lista.innerHTML = clientes.map(c => {
    const estadoBadge = c.estado_afip === 'INACTIVO'
      ? `<span style="background:#fff3cd;color:#856404;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">INACTIVO en AFIP</span>`
      : '';
    const cuitBadge = c.cuit
      ? `<span style="background:#e7f3ff;color:#0d6efd;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600">CUIT ${fmt11(c.cuit)}</span>`
      : `<span style="background:#f8f9fa;color:var(--text-muted);padding:2px 10px;border-radius:12px;font-size:12px;border:1px solid var(--border)">Sin CUIT</span>`;
    const condBadge = `<span style="background:#f8f9fa;color:#495057;padding:2px 10px;border-radius:12px;font-size:12px;border:1px solid var(--border)">${c.condicion_iva || 'Consumidor Final'}</span>`;
    return `
      <div style="
        background:white;border-radius:12px;padding:16px 18px;
        box-shadow:0 1px 6px rgba(0,0,0,0.06);border:1px solid var(--border);
        display:flex;align-items:center;gap:14px;flex-wrap:wrap
      ">
        <div style="
          width:44px;height:44px;border-radius:10px;background:#6f42c1;
          display:flex;align-items:center;justify-content:center;flex-shrink:0
        ">
          <span class="material-icons" style="color:white;font-size:22px">person</span>
        </div>
        <div style="flex:1;min-width:150px">
          <div style="font-size:15px;font-weight:700">${c.nombre || '—'}</div>
          ${c.domicilio || c.localidad ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">${[c.domicilio, c.localidad].filter(Boolean).join(' · ')}</div>` : ''}
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            ${cuitBadge} ${condBadge} ${estadoBadge}
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button data-docid="${c._docId}" data-action="editar" style="
            padding:7px 14px;background:#f8f9fa;border:1px solid var(--border);
            border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit
          ">Editar</button>
          <button data-docid="${c._docId}" data-nombre="${c.nombre}" data-action="eliminar" style="
            padding:7px 14px;background:#fff0f0;border:1px solid #fca5a5;
            color:#dc3545;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit
          ">Eliminar</button>
        </div>
      </div>
    `;
  }).join('');
}

// ── Buscar en AFIP ────────────────────────────────────────────────────────────
async function buscarEnAfip() {
  const cuitRaw = document.getElementById('cCuit').value.replace(/[-.\s]/g, '');
  const estado  = document.getElementById('afipEstado');
  const btn     = document.getElementById('btnBuscarAfip');

  if (!/^\d{11}$/.test(cuitRaw)) {
    setAfipEstado('error', 'Ingresá los 11 dígitos del CUIT');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="material-icons" style="font-size:16px;animation:spin 1s linear infinite">refresh</span> Buscando...';
  setAfipEstado('', '');

  try {
    const res  = await fetch(`/api/afip-padron?cuit=${cuitRaw}`);
    const data = await res.json();

    if (!res.ok) {
      setAfipEstado('error', data.error || 'No encontrado');
      return;
    }

    // Auto-completar campos
    if (data.nombre)        document.getElementById('cNombre').value    = capitalizar(data.nombre);
    if (data.condicion_iva) document.getElementById('cCondIVA').value   = data.condicion_iva;
    if (data.domicilio)     document.getElementById('cDomicilio').value  = data.domicilio;
    if (data.localidad)     document.getElementById('cLocalidad').value  = data.localidad;

    // Guardar estado AFIP para usarlo al guardar
    window._afipEstadoClave = data.estado;

    const inactivo = data.estado === 'INACTIVO';
    setAfipEstado(
      inactivo ? 'warn' : 'ok',
      inactivo
        ? `Encontrado (INACTIVO en AFIP)`
        : `Encontrado · ${data.tipo === 'FISICA' ? 'Persona física' : 'Persona jurídica'}`
    );

  } catch (err) {
    setAfipEstado('error', 'Sin conexión o AFIP no disponible');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-icons" style="font-size:16px">search</span> Buscar en AFIP';
  }
}

function setAfipEstado(tipo, msg) {
  const el = document.getElementById('afipEstado');
  if (!el) return;
  const colores = { ok: '#2e7d32', error: '#c62828', warn: '#e65100', '': 'transparent' };
  el.style.color = colores[tipo] || colores[''];
  el.textContent = msg;
}

function capitalizar(str) {
  return str.toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
}

function fmt11(cuit) {
  const c = String(cuit).replace(/\D/g, '');
  if (c.length === 11) return `${c.slice(0,2)}-${c.slice(2,10)}-${c.slice(10)}`;
  return cuit;
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function abrirClienteModal(cliente = null) {
  document.getElementById('clienteModalTitulo').textContent = cliente ? 'Editar cliente' : 'Nuevo cliente';
  document.getElementById('clienteId').value    = cliente?._docId || '';
  document.getElementById('cNombre').value      = cliente?.nombre || '';
  document.getElementById('cCuit').value        = cliente?.cuit ? fmt11(cliente.cuit) : '';
  document.getElementById('cCondIVA').value     = cliente?.condicion_iva || 'Consumidor Final';
  document.getElementById('cDomicilio').value   = cliente?.domicilio || '';
  document.getElementById('cLocalidad').value   = cliente?.localidad || '';
  document.getElementById('clienteError').style.display = 'none';
  setAfipEstado('', '');
  window._afipEstadoClave = cliente?.estado_afip || '';
  document.getElementById('clienteModal').style.display = 'flex';
  document.getElementById('cCuit').focus();
}

function cerrarClienteModal() {
  document.getElementById('clienteModal').style.display = 'none';
}

// ── Eventos ───────────────────────────────────────────────────────────────────
function setupClientesEvents(db) {
  document.getElementById('btnNuevoCliente').addEventListener('click', () => abrirClienteModal());
  document.getElementById('clienteModalCerrar').addEventListener('click', cerrarClienteModal);
  document.getElementById('btnCancelarClienteModal').addEventListener('click', cerrarClienteModal);
  document.getElementById('clienteModal').addEventListener('click', e => {
    if (e.target === document.getElementById('clienteModal')) cerrarClienteModal();
  });

  // Botón buscar AFIP
  document.getElementById('btnBuscarAfip').addEventListener('click', buscarEnAfip);

  // También al presionar Enter en el campo CUIT
  document.getElementById('cCuit').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); buscarEnAfip(); }
  });

  // Búsqueda local en la lista
  document.getElementById('clienteBuscar').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    const todos = window._clientesTodos || [];
    if (!q) { renderLista(todos); return; }
    renderLista(todos.filter(c =>
      (c.nombre || '').toLowerCase().includes(q) ||
      (c.cuit   || '').replace(/\D/g,'').includes(q.replace(/\D/g,''))
    ));
  });

  // Form guardar
  document.getElementById('clienteForm').addEventListener('submit', async e => {
    e.preventDefault();
    const nombre = document.getElementById('cNombre').value.trim();
    if (!nombre) {
      const el = document.getElementById('clienteError');
      el.textContent = 'El nombre es obligatorio.';
      el.style.display = 'block';
      return;
    }

    const data = {
      nombre,
      razon_social:  nombre,
      cuit:          document.getElementById('cCuit').value.trim().replace(/\D/g, ''),
      condicion_iva: document.getElementById('cCondIVA').value,
      domicilio:     document.getElementById('cDomicilio').value.trim(),
      localidad:     document.getElementById('cLocalidad').value.trim(),
      estado_afip:   window._afipEstadoClave || '',
      activo:        true,
    };

    const btn = document.getElementById('btnGuardarCliente');
    btn.textContent = 'Guardando...';
    btn.disabled = true;

    try {
      const docId = document.getElementById('clienteId').value;
      if (docId) {
        await updateDoc(doc(db, COL, docId), data);
      } else {
        const ref = await addDoc(collection(db, COL), data);
        await updateDoc(ref, { id: ref.id });
      }
      cerrarClienteModal();
      invalidateCacheByPrefix('clientes:');
      await cargarClientes(db);
    } catch (err) {
      const el = document.getElementById('clienteError');
      el.textContent = `Error al guardar: ${err.message}`;
      el.style.display = 'block';
    } finally {
      btn.textContent = 'Guardar cliente';
      btn.disabled = false;
    }
  });

  // Editar / Eliminar
  document.getElementById('clientesLista').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const docId  = btn.dataset.docid;
    const action = btn.dataset.action;

    if (action === 'editar') {
      const cliente = window._clientesData?.[docId];
      if (cliente) abrirClienteModal(cliente);
    }
    if (action === 'eliminar') {
      const nombre = btn.dataset.nombre || 'este cliente';
      if (!confirm(`¿Eliminar "${nombre}"?`)) return;
      try {
        await updateDoc(doc(db, COL, docId), { activo: false });
        invalidateCacheByPrefix('clientes:');
        await cargarClientes(db);
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    }
  });
}
