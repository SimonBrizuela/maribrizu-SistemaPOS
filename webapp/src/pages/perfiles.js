/**
 * Página: Perfiles ARCA
 * ─────────────────────
 * Gestión de emisores (dueños/socios) para facturación electrónica.
 * Los cambios se guardan en Firestore → el POS los sincroniza automáticamente.
 */

import {
  collection, getDocs, addDoc, doc, updateDoc, deleteDoc, setDoc,
  getDoc, query, orderBy
} from 'firebase/firestore';
import { getCached, invalidateCacheByPrefix } from '../cache.js';

const COL = 'perfiles_facturacion';
const CFG_DOC = 'config/emisor_activo';

// ── Helpers ───────────────────────────────────────────────────────────────────
function badge(text, color) {
  return `<span style="background:${color};color:white;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600">${text}</span>`;
}

// ── Render ────────────────────────────────────────────────────────────────────
export async function renderPerfiles(container, db) {
  container.innerHTML = `
    <div style="max-width:900px;margin:0 auto;padding:16px 8px">

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
        <div>
          <h2 style="margin:0;font-size:20px;font-weight:700">Perfiles ARCA</h2>
          <p style="margin:4px 0 0;color:#6c757d;font-size:13px">
            Cada perfil es un emisor (dueño / socio). El cajero elige en cuál facturar al cobrar.
          </p>
        </div>
        <button id="btnNuevoPerfil" style="
          background:#0d6efd;color:white;border:none;border-radius:8px;
          padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;
          display:flex;align-items:center;gap:6px
        ">
          <span class="material-icons" style="font-size:18px">add</span> Nuevo perfil
        </button>
      </div>

      <!-- Lista de perfiles -->
      <div id="perfilesLista" style="display:flex;flex-direction:column;gap:12px">
        <div style="text-align:center;padding:40px;color:#6c757d">
          <span class="material-icons" style="font-size:40px;display:block;margin-bottom:8px">hourglass_empty</span>
          Cargando perfiles...
        </div>
      </div>

      <!-- Modal -->
      <div id="perfilModal" style="
        display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);
        z-index:1000;align-items:center;justify-content:center;padding:16px
      ">
        <div style="
          background:white;border-radius:16px;padding:24px;width:100%;
          max-width:520px;max-height:90vh;overflow-y:auto;
          box-shadow:0 20px 60px rgba(0,0,0,0.3)
        ">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
            <h3 id="modalTitulo" style="margin:0;font-size:18px;font-weight:700">Nuevo perfil</h3>
            <button id="modalCerrar" style="
              background:none;border:none;cursor:pointer;
              color:#6c757d;font-size:24px;line-height:1;padding:0
            ">&times;</button>
          </div>

          <form id="perfilForm" style="display:flex;flex-direction:column;gap:14px">
            <input type="hidden" id="perfilId" value="">

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div style="grid-column:1/-1">
                <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                  Nombre en el botón *
                </label>
                <input id="fNombre" type="text" placeholder="Ej: María, Juan"
                  style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #dee2e6;border-radius:8px;font-size:14px;font-family:inherit">
              </div>

              <div style="grid-column:1/-1">
                <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                  Razón Social (para la factura)
                </label>
                <input id="fRazon" type="text" placeholder="Nombre completo fiscal"
                  style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #dee2e6;border-radius:8px;font-size:14px;font-family:inherit">
              </div>

              <div>
                <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                  CUIT *
                </label>
                <input id="fCuit" type="text" placeholder="20123456789"
                  style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #dee2e6;border-radius:8px;font-size:14px;font-family:inherit">
              </div>

              <div>
                <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                  Punto de Venta
                </label>
                <input id="fPV" type="number" value="1" min="1"
                  style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #dee2e6;border-radius:8px;font-size:14px;font-family:inherit">
              </div>

              <div style="grid-column:1/-1">
                <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                  Domicilio fiscal
                </label>
                <input id="fDomicilio" type="text" placeholder="Calle 123"
                  style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #dee2e6;border-radius:8px;font-size:14px;font-family:inherit">
              </div>

              <div>
                <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                  Localidad
                </label>
                <input id="fLocalidad" type="text"
                  style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #dee2e6;border-radius:8px;font-size:14px;font-family:inherit">
              </div>

              <div>
                <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                  Condición IVA
                </label>
                <select id="fCondIVA"
                  style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #dee2e6;border-radius:8px;font-size:14px;font-family:inherit;background:white">
                  <option>Monotributista</option>
                  <option>Responsable Inscripto</option>
                  <option>Exento</option>
                </select>
              </div>

              <div style="grid-column:1/-1">
                <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                  Entorno AFIP
                </label>
                <select id="fEntorno"
                  style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #dee2e6;border-radius:8px;font-size:14px;font-family:inherit;background:white">
                  <option value="1">Producción (real)</option>
                  <option value="0">Homologación (prueba)</option>
                </select>
              </div>

              <div style="grid-column:1/-1;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px">
                <p style="margin:0 0 12px;font-size:12px;color:#166534;font-weight:600;display:flex;align-items:center;gap:6px">
                  <span class="material-icons" style="font-size:16px">lock</span>
                  Certificados AFIP — se distribuyen automáticamente a todas las PCs
                </p>

                <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                  Certificado (.crt)
                </label>
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                  <input id="fCertFile" type="file" accept=".crt,.pem" style="display:none">
                  <button type="button" id="btnCertFile" style="
                    padding:8px 14px;background:#f8f9fa;border:1px solid #dee2e6;
                    border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap
                  ">Subir archivo</button>
                  <span id="certFileName" style="font-size:13px;color:#6c757d;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    Sin archivo
                  </span>
                </div>

                <label style="font-size:13px;font-weight:600;color:#495057;display:block;margin-bottom:4px">
                  Clave privada (.key)
                </label>
                <div style="display:flex;align-items:center;gap:8px">
                  <input id="fKeyFile" type="file" accept=".key,.pem" style="display:none">
                  <button type="button" id="btnKeyFile" style="
                    padding:8px 14px;background:#f8f9fa;border:1px solid #dee2e6;
                    border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap
                  ">Subir archivo</button>
                  <span id="keyFileName" style="font-size:13px;color:#6c757d;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    Sin archivo
                  </span>
                </div>

                <p style="margin:10px 0 0;font-size:11px;color:#166534">
                  Al guardar, el POS descarga y configura los certificados automáticamente en cada PC.
                </p>
              </div>
            </div>

            <div id="perfilError" style="display:none;color:#dc3545;font-size:13px;padding:8px 12px;background:#fff0f0;border-radius:6px"></div>

            <div style="display:flex;gap:10px;margin-top:4px">
              <button type="button" id="btnCancelarModal" style="
                flex:1;padding:12px;border:1px solid #dee2e6;border-radius:8px;
                background:white;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit
              ">Cancelar</button>
              <button type="submit" id="btnGuardarPerfil" style="
                flex:2;padding:12px;background:#0d6efd;color:white;border:none;
                border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit
              ">Guardar perfil</button>
            </div>
          </form>
        </div>
      </div>

    </div>
  `;

  await cargarPerfiles(db);
  setupEvents(db);
}

// ── Cargar y renderizar lista ─────────────────────────────────────────────────
async function cargarPerfiles(db) {
  const lista = document.getElementById('perfilesLista');
  try {
    // Leer perfiles y emisor activo en paralelo (cache 60s memoria)
    const [perfiles, emisorActivoId] = await Promise.all([
      getCached('perfiles:lista', async () => {
        const snap = await getDocs(query(collection(db, COL), orderBy('nombre')));
        const arr = [];
        snap.forEach(d => arr.push({ _docId: d.id, ...d.data() }));
        return arr;
      }, { ttl: 60000, memOnly: true }),
      getCached('perfiles:emisor_activo', async () => {
        const cfgSnap = await getDoc(doc(db, 'config', 'emisor_activo'));
        return cfgSnap.exists() ? cfgSnap.data().firebase_id : null;
      }, { ttl: 60000, memOnly: true }),
    ]);
    const activos = perfiles.filter(p => p.activo !== false);

    if (!activos.length) {
      lista.innerHTML = `
        <div style="text-align:center;padding:48px 20px;color:#6c757d;background:white;border-radius:12px;border:2px dashed #dee2e6">
          <span class="material-icons" style="font-size:48px;display:block;margin-bottom:12px;color:#adb5bd">person_add</span>
          <p style="margin:0;font-size:15px">No hay perfiles cargados</p>
          <p style="margin:6px 0 0;font-size:13px">Hacé clic en "Nuevo perfil" para agregar el primero</p>
        </div>`;
      return;
    }

    lista.innerHTML = activos.map(p => {
      const esActivo = p._docId === emisorActivoId;
      const entorno = p.produccion
        ? badge('PRODUCCIÓN', '#198754')
        : badge('HOMOLOGACIÓN', '#856404');
      const cert = (p.cert_content || p.cert_path)
        ? badge('CERT OK', '#0d6efd')
        : badge('SIN CERT', '#dc3545');

      const cardBorder = esActivo
        ? 'border:2px solid #198754;'
        : 'border:1px solid #f0f0f0;';
      const iconBg = esActivo ? '#198754' : '#0d6efd';
      const activoBadge = esActivo
        ? `<span style="background:#198754;color:white;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:700;display:inline-flex;align-items:center;gap:4px">
             ★ EMISOR ACTIVO HOY
           </span>`
        : '';

      return `
        <div style="
          background:white;border-radius:12px;padding:18px 20px;
          box-shadow:0 2px 8px rgba(0,0,0,0.07);${cardBorder}
          display:flex;align-items:center;gap:16px;flex-wrap:wrap
        ">
          <div style="
            width:48px;height:48px;border-radius:12px;background:${iconBg};
            display:flex;align-items:center;justify-content:center;flex-shrink:0
          ">
            <span class="material-icons" style="color:white;font-size:26px">person</span>
          </div>
          <div style="flex:1;min-width:180px">
            <div style="font-size:16px;font-weight:700;color:#212529">${p.nombre || '—'}</div>
            <div style="font-size:13px;color:#6c757d;margin-top:2px">
              ${p.razon_social && p.razon_social !== p.nombre ? p.razon_social + ' · ' : ''}
              CUIT: <b>${p.cuit || '—'}</b> · PV: ${p.punto_venta || 1}
            </div>
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
              ${activoBadge}
              ${entorno} ${cert}
              <span style="background:#f8f9fa;color:#495057;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:500;border:1px solid #dee2e6">${p.condicion_iva || 'Monotributista'}</span>
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap">
            ${esActivo
              ? `<button data-docid="${p._docId}" data-action="desactivar" style="
                  padding:8px 14px;background:#e8f5e9;border:1px solid #a5d6a7;
                  color:#2e7d32;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit
                ">★ Activo</button>`
              : `<button data-docid="${p._docId}" data-nombre="${p.nombre}" data-action="activar" style="
                  padding:8px 14px;background:#f8f9fa;border:1px solid #dee2e6;
                  color:#495057;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit
                ">Activar hoy</button>`
            }
            <button data-docid="${p._docId}" data-action="editar" style="
              padding:8px 14px;background:#f8f9fa;border:1px solid #dee2e6;
              border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit
            ">Editar</button>
            <button data-docid="${p._docId}" data-nombre="${p.nombre}" data-action="eliminar" style="
              padding:8px 14px;background:#fff0f0;border:1px solid #fca5a5;
              color:#dc3545;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit
            ">Eliminar</button>
          </div>
        </div>
      `;
    }).join('');

    // Guardar datos para edición
    window._perfilesData = {};
    activos.forEach(p => { window._perfilesData[p._docId] = p; });

  } catch (e) {
    lista.innerHTML = `<div style="color:#dc3545;padding:20px">Error cargando perfiles: ${e.message}</div>`;
  }
}

// ── Estado de archivos seleccionados ─────────────────────────────────────────
let _certB64 = null;   // base64 del .crt seleccionado (null = sin cambio)
let _keyB64  = null;   // base64 del .key seleccionado

function leerArchivo(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const bytes = new Uint8Array(e.target.result);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      resolve(btoa(binary));
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function abrirModal(perfil = null) {
  _certB64 = null;
  _keyB64  = null;

  const modal = document.getElementById('perfilModal');
  document.getElementById('modalTitulo').textContent = perfil ? 'Editar perfil' : 'Nuevo perfil';
  document.getElementById('perfilId').value = perfil ? (perfil._docId || '') : '';
  document.getElementById('fNombre').value = perfil?.nombre || '';
  document.getElementById('fRazon').value = perfil?.razon_social || '';
  document.getElementById('fCuit').value = perfil?.cuit || '';
  document.getElementById('fPV').value = perfil?.punto_venta || 1;
  document.getElementById('fDomicilio').value = perfil?.domicilio || '';
  document.getElementById('fLocalidad').value = perfil?.localidad || '';
  document.getElementById('fCondIVA').value = perfil?.condicion_iva || 'Monotributista';
  document.getElementById('fEntorno').value = perfil ? (perfil.produccion ? '1' : '0') : '1';

  // Mostrar si ya tenía cert cargado
  const hasCert = !!perfil?.cert_content;
  const hasKey  = !!perfil?.key_content;
  document.getElementById('certFileName').textContent = hasCert ? 'Cert cargado anteriormente' : 'Sin archivo';
  document.getElementById('certFileName').style.color = hasCert ? '#198754' : '#6c757d';
  document.getElementById('keyFileName').textContent  = hasKey  ? 'Key cargada anteriormente'  : 'Sin archivo';
  document.getElementById('keyFileName').style.color  = hasKey  ? '#198754' : '#6c757d';

  // Limpiar inputs file
  document.getElementById('fCertFile').value = '';
  document.getElementById('fKeyFile').value  = '';

  document.getElementById('perfilError').style.display = 'none';
  modal.style.display = 'flex';
  document.getElementById('fNombre').focus();
}

function cerrarModal() {
  document.getElementById('perfilModal').style.display = 'none';
}

async function formData() {
  const data = {
    nombre:        document.getElementById('fNombre').value.trim(),
    razon_social:  document.getElementById('fRazon').value.trim(),
    cuit:          document.getElementById('fCuit').value.trim(),
    punto_venta:   parseInt(document.getElementById('fPV').value) || 1,
    domicilio:     document.getElementById('fDomicilio').value.trim(),
    localidad:     document.getElementById('fLocalidad').value.trim(),
    condicion_iva: document.getElementById('fCondIVA').value,
    produccion:    document.getElementById('fEntorno').value === '1',
    activo:        true,
  };
  // Solo incluir cert/key si se seleccionó un archivo nuevo
  if (_certB64 !== null) data.cert_content = _certB64;
  if (_keyB64  !== null) data.key_content  = _keyB64;
  return data;
}

function mostrarError(msg) {
  const el = document.getElementById('perfilError');
  el.textContent = msg;
  el.style.display = 'block';
}

// ── Eventos ───────────────────────────────────────────────────────────────────
function setupEvents(db) {
  document.getElementById('btnNuevoPerfil').addEventListener('click', () => abrirModal());
  document.getElementById('modalCerrar').addEventListener('click', cerrarModal);
  document.getElementById('btnCancelarModal').addEventListener('click', cerrarModal);

  // Cerrar modal al hacer clic en el overlay
  document.getElementById('perfilModal').addEventListener('click', e => {
    if (e.target === document.getElementById('perfilModal')) cerrarModal();
  });

  // Botones de archivo → disparan el input hidden
  document.getElementById('btnCertFile').addEventListener('click', () => {
    document.getElementById('fCertFile').click();
  });
  document.getElementById('btnKeyFile').addEventListener('click', () => {
    document.getElementById('fKeyFile').click();
  });

  // Cuando se selecciona un .crt
  document.getElementById('fCertFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    _certB64 = await leerArchivo(file);
    const lbl = document.getElementById('certFileName');
    lbl.textContent = file.name;
    lbl.style.color = '#198754';
  });

  // Cuando se selecciona un .key
  document.getElementById('fKeyFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    _keyB64 = await leerArchivo(file);
    const lbl = document.getElementById('keyFileName');
    lbl.textContent = file.name;
    lbl.style.color = '#198754';
  });

  // Guardar perfil
  document.getElementById('perfilForm').addEventListener('submit', async e => {
    e.preventDefault();
    const data = await formData();
    if (!data.nombre) return mostrarError('El nombre del botón es obligatorio.');
    if (!data.cuit) return mostrarError('El CUIT es obligatorio.');

    const btn = document.getElementById('btnGuardarPerfil');
    btn.textContent = 'Guardando...';
    btn.disabled = true;

    try {
      const docId = document.getElementById('perfilId').value;

      if (docId) {
        await updateDoc(doc(db, COL, docId), data);
      } else {
        const ref = await addDoc(collection(db, COL), data);
        // Guardar el docId de Firestore como campo "id" para que el POS haga upsert
        await updateDoc(ref, { id: ref.id });
      }

      cerrarModal();
      invalidateCacheByPrefix('perfiles:');
      await cargarPerfiles(db);
    } catch (err) {
      mostrarError(`Error al guardar: ${err.message}`);
    } finally {
      btn.textContent = 'Guardar perfil';
      btn.disabled = false;
    }
  });

  // Editar / Eliminar desde la lista
  document.getElementById('perfilesLista').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const docId = btn.dataset.docid;
    const action = btn.dataset.action;

    if (action === 'editar') {
      const perfil = window._perfilesData?.[docId];
      if (perfil) abrirModal(perfil);
    }

    if (action === 'activar') {
      const nombre = btn.dataset.nombre || '';
      try {
        await setDoc(doc(db, 'config', 'emisor_activo'), {
          firebase_id: docId,
          nombre,
          activado_en: new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' }).replace(' ', 'T'),
        });
        invalidateCacheByPrefix('perfiles:');
        await cargarPerfiles(db);
      } catch (err) {
        alert(`Error al activar emisor: ${err.message}`);
      }
    }

    if (action === 'desactivar') {
      try {
        await setDoc(doc(db, 'config', 'emisor_activo'), {
          firebase_id: null,
          nombre: '',
          activado_en: new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' }).replace(' ', 'T'),
        });
        invalidateCacheByPrefix('perfiles:');
        await cargarPerfiles(db);
      } catch (err) {
        alert(`Error al desactivar emisor: ${err.message}`);
      }
    }

    if (action === 'eliminar') {
      const nombre = btn.dataset.nombre || 'este perfil';
      if (!confirm(`¿Eliminar "${nombre}"? Se sincronizará al POS.`)) return;
      try {
        await updateDoc(doc(db, COL, docId), { activo: false });
        invalidateCacheByPrefix('perfiles:');
        await cargarPerfiles(db);
      } catch (err) {
        alert(`Error al eliminar: ${err.message}`);
      }
    }
  });
}
