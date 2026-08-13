/**
 * Auto-actualización de la app de escritorio (Tauri v2 updater).
 *
 * Solo corre dentro del .exe. Al arrancar chequea el `latest.json` publicado en
 * Firebase Storage (`downloads/latest.json`); si hay una versión nueva y firmada
 * la descarga e instala sola, sin pedir nada: muestra un aviso chico con el
 * progreso y al terminar la app se reinicia actualizada. En la web (navegador)
 * no hace absolutamente nada.
 */

import { isTauriApp } from './autostart.js';

let _yaChequeado = false;

/** Chequeo de actualizaciones al arranque. Idempotente, silencioso si no hay. */
export async function initUpdater() {
  if (!isTauriApp()) return;
  if (_yaChequeado) return;
  _yaChequeado = true;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    // check() devuelve null si ya estás en la última versión.
    if (!update) return;
    await _instalarAuto(update);
  } catch (err) {
    // Sin conexión, endpoint caído o firma inválida: no molestamos al usuario.
    console.warn('[updater] check', err);
  }
}

async function _instalarAuto(update) {
  const version = update.version || '';
  const toast = _crearToast(version);

  try {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    let total = 0, bajado = 0;
    await update.downloadAndInstall(ev => {
      switch (ev.event) {
        case 'Started':
          total = ev.data?.contentLength || 0;
          toast.setEstado('Descargando…');
          break;
        case 'Progress':
          bajado += ev.data?.chunkLength || 0;
          if (total > 0) {
            const pct = Math.min(100, Math.round((bajado / total) * 100));
            toast.setProgreso(pct);
            toast.setEstado(`Descargando… ${pct}%`);
          }
          break;
        case 'Finished':
          toast.setProgreso(100);
          toast.setEstado('Instalando… la app se reinicia sola.');
          break;
      }
    });
    // En Windows el instalador cierra y reabre la app solo; relaunch() cubre
    // el resto de plataformas y no hace daño si ya se está cerrando.
    await relaunch();
  } catch (err) {
    // Falló la descarga/instalación: se limpia el aviso y se reintenta en el
    // próximo arranque. La app sigue funcionando con la versión actual.
    console.error('[updater] install', err);
    toast.remover();
  }
}

function _crearToast(version) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:99999;width:min(340px,calc(100vw - 40px));background:#1a1814;color:#e8e3da;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:14px 16px;box-shadow:0 18px 50px rgba(0,0,0,.42);font-family:inherit';
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <span class="material-icons" style="font-size:22px;color:#1877f2">system_update_alt</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13.5px;font-weight:700;line-height:1.25">Actualizando a la versión ${_esc(version)}</div>
        <div id="upd_toast_txt" style="font-size:12px;opacity:.75;margin-top:2px">Preparando…</div>
      </div>
    </div>
    <div style="height:6px;border-radius:6px;background:rgba(255,255,255,.12);overflow:hidden;margin-top:10px">
      <div id="upd_toast_bar" style="height:100%;width:0%;background:#1877f2;transition:width .2s ease"></div>
    </div>`;
  document.body.appendChild(el);

  const txt = el.querySelector('#upd_toast_txt');
  const bar = el.querySelector('#upd_toast_bar');
  return {
    setEstado(s) { txt.textContent = s; },
    setProgreso(pct) { bar.style.width = pct + '%'; },
    remover() { el.remove(); },
  };
}

function _esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
