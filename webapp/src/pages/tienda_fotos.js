/**
 * Fotos pedidas.
 *
 * La lista de trabajo que arma el personal desde la tienda: recorren el
 * catálogo con el modo oculto prendido (`?fotos=1`) y van tildando lo que hay
 * que fotografiar. Acá se ve junta, se imprime para llevarla al mostrador y se
 * saca lo que ya se resolvió.
 *
 * La colección `tienda_fotos_pedidas` tiene un documento por producto, con el
 * id del producto como id del documento: marcar dos veces no duplica nada.
 */
import { collection, deleteDoc, doc, getDocs, orderBy, query } from 'firebase/firestore';
import { confirmDialog, escHtml } from '../components/dialogs.js';
import { nombreBonito } from '../tienda_espejo.js';
import '../styles/tienda.css';

let _db = null;
let _lista = [];

export async function renderTiendaFotos(container, db) {
  _db = db;

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;
                gap:16px;flex-wrap:wrap;margin-bottom:16px">
      <div style="min-width:260px;flex:1">
        <h2 style="margin:0">Fotos pedidas</h2>
        <p class="tienda-pista" style="margin:6px 0 0">
          Lo que se marcó desde la tienda. El tilde aparece en cada producto
          apenas se entra, sin ningún link especial. Como lo ve cualquiera,
          puede llegar algo de más: sacarlo de acá es un click.
        </p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="pc-btn" id="fotosImprimir">
          <span class="material-icons">print</span> Imprimir
        </button>
        <button class="pc-btn" id="fotosRefrescar">
          <span class="material-icons">refresh</span> Actualizar
        </button>
      </div>
    </div>

    <div id="fotosCuerpo"><div class="tienda-pista">Cargando…</div></div>`;

  document.getElementById('fotosRefrescar').addEventListener('click', cargar);
  document.getElementById('fotosImprimir').addEventListener('click', imprimir);

  await cargar();
}

async function cargar() {
  const cuerpo = document.getElementById('fotosCuerpo');
  if (!cuerpo) return;

  try {
    // Ordenar por fecha necesita que todos los documentos tengan el campo. Si
    // alguno quedó sin él, Firestore lo deja afuera en silencio, así que ante
    // cualquier problema se cae a traer todo sin orden y se ordena acá.
    let docs;
    try {
      const snap = await getDocs(query(
        collection(_db, 'tienda_fotos_pedidas'), orderBy('pedido_en', 'desc')));
      docs = snap.docs;
    } catch (_) {
      const snap = await getDocs(collection(_db, 'tienda_fotos_pedidas'));
      docs = snap.docs;
    }

    _lista = docs.map(d => {
      const v = d.data() || {};
      return {
        id: d.id,
        nombre: v.nombre || '(sin nombre)',
        rubro: v.rubro || '',
        teniaFoto: v.tenia_foto === true,
        cuando: v.pedido_en?.toDate?.() || null,
      };
    }).sort((a, b) => (b.cuando?.getTime() || 0) - (a.cuando?.getTime() || 0));

    pintar();
  } catch (err) {
    console.error('[fotos] no se pudo leer la lista:', err);
    cuerpo.innerHTML = `
      <div class="tienda-pista" style="color:var(--danger)">
        No se pudo leer la lista: ${escHtml(err?.message || String(err))}
      </div>`;
  }
}

function pintar() {
  const cuerpo = document.getElementById('fotosCuerpo');
  if (!cuerpo) return;

  if (!_lista.length) {
    cuerpo.innerHTML = `
      <div class="empty-state">
        <span class="material-icons">photo_camera</span>
        <p>Todavía no hay productos marcados.</p>
      </div>`;
    return;
  }

  const sinFoto = _lista.filter(f => !f.teniaFoto).length;

  cuerpo.innerHTML = `
    <div class="tienda-resumen">
      <div class="tienda-dato">
        <b>${_lista.length}</b><span>en la lista</span>
      </div>
      <div class="tienda-dato${sinFoto ? ' alerta' : ''}">
        <b>${sinFoto}</b><span>sin ninguna foto</span>
      </div>
      <div class="tienda-dato">
        <b>${_lista.length - sinFoto}</b><span>con foto a reemplazar</span>
      </div>
    </div>

    <table class="tienda-tabla" id="fotosTabla">
      <thead>
        <tr>
          <th style="width:34px"></th>
          <th>Producto</th>
          <th style="width:150px">Rubro</th>
          <th style="width:120px">Estado</th>
          <th style="width:120px">Marcado</th>
          <th style="width:44px" data-no-imprimir></th>
        </tr>
      </thead>
      <tbody>
        ${_lista.map((f, i) => `
          <tr data-fila="${escHtml(f.id)}">
            <td style="color:var(--text-muted)">${i + 1}</td>
            <td><b>${escHtml(f.nombre)}</b></td>
            <td>${escHtml(nombreBonito(f.rubro))}</td>
            <td>${f.teniaFoto
                  ? '<span class="tienda-etiqueta auto">Cambiar la que tiene</span>'
                  : '<span class="tienda-etiqueta oculto">No tiene foto</span>'}</td>
            <td style="color:var(--text-muted)">${f.cuando ? fecha(f.cuando) : '—'}</td>
            <td data-no-imprimir>
              <button class="pc-btn" data-sacar="${escHtml(f.id)}" title="Sacar de la lista"
                      style="padding:4px 7px">
                <span class="material-icons" style="font-size:17px">close</span>
              </button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  cuerpo.querySelectorAll('[data-sacar]').forEach(boton => {
    boton.addEventListener('click', () => sacar(boton.dataset.sacar));
  });
}

async function sacar(id) {
  const f = _lista.find(x => x.id === id);
  const ok = await confirmDialog({
    title: 'Sacar de la lista',
    message: `"${f?.nombre || id}" deja de figurar como pendiente de foto.`,
    confirmText: 'Sacar',
  });
  if (!ok) return;

  try {
    await deleteDoc(doc(_db, 'tienda_fotos_pedidas', id));
    _lista = _lista.filter(x => x.id !== id);
    pintar();
  } catch (err) {
    console.error('[fotos] no se pudo sacar:', err);
  }
}

function fecha(d) {
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })
       + ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Se imprime en una ventana aparte y no con `window.print()` sobre el panel:
 * así la hoja sale con la lista sola, sin el menú lateral ni los botones, y sin
 * tener que mantener una hoja de estilos de impresión para toda la aplicación.
 */
function imprimir() {
  if (!_lista.length) return;

  const filas = _lista.map((f, i) => `
    <tr>
      <td class="n">${i + 1}</td>
      <td>${escHtml(f.nombre)}</td>
      <td>${escHtml(nombreBonito(f.rubro))}</td>
      <td>${f.teniaFoto ? 'Cambiar' : 'No tiene'}</td>
      <td class="tilde"></td>
    </tr>`).join('');

  const hoy = new Date().toLocaleDateString('es-AR',
    { day: '2-digit', month: '2-digit', year: 'numeric' });

  const ventana = window.open('', '_blank');
  if (!ventana) return;

  ventana.document.write(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Fotos pedidas</title>
<style>
  * { box-sizing: border-box; }
  body { font: 12px/1.45 system-ui, sans-serif; color: #111; margin: 24px; }
  h1 { font-size: 17px; margin: 0 0 2px; }
  .apoyo { color: #666; font-size: 11px; margin: 0 0 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd;
           vertical-align: top; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
       color: #666; border-bottom: 1.5px solid #999; }
  .n { color: #888; width: 26px; }
  .tilde { width: 30px; }
  .tilde::after { content: ''; display: block; width: 15px; height: 15px;
                  border: 1.5px solid #999; border-radius: 3px; }
  tr { break-inside: avoid; }
  @page { margin: 14mm; }
</style></head>
<body>
  <h1>Fotos pedidas</h1>
  <p class="apoyo">${_lista.length} producto${_lista.length === 1 ? '' : 's'} · ${hoy}</p>
  <table>
    <thead><tr><th></th><th>Producto</th><th>Rubro</th><th>Foto</th><th>Hecho</th></tr></thead>
    <tbody>${filas}</tbody>
  </table>
</body></html>`);
  ventana.document.close();
  ventana.focus();
  ventana.print();
}
