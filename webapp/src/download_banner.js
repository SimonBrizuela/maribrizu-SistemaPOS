/**
 * Cartel de descarga de la app de escritorio.
 *
 * Aparece SOLO en la web por navegador (no dentro del propio .exe) y solo en
 * Windows de escritorio. Es descartable (no vuelve a molestar una vez cerrado).
 * El instalador vive en Firebase Storage (`downloads/WebApp-setup.exe`, lectura
 * publica). Para publicar una versión nueva se pisa ese archivo; la URL no cambia.
 */
import { isTauriApp } from './autostart.js';

// Subir el sufijo (-v2, -v3...) hace que el cartel vuelva a aparecer para
// todos, aunque lo hayan cerrado antes.
const DISMISS_KEY = 'll-exe-banner-dismissed-v2';
const INSTALLER_URL = 'https://firebasestorage.googleapis.com/v0/b/mari-d7c71.firebasestorage.app/o/downloads%2FWebApp-setup.exe?alt=media';

export function initDownloadBanner() {
  try {
    if (isTauriApp()) return;                                  // ya está en el exe
    const ua = navigator.userAgent || '';
    if (!/Windows NT/i.test(ua)) return;                       // solo Windows
    if (/Mobi|Android|iPhone|iPad|Tablet/i.test(ua)) return;   // no móvil
    if (localStorage.getItem(DISMISS_KEY)) return;             // ya lo cerró
  } catch (_) { return; }

  const style = document.createElement('style');
  style.textContent = `
    #ll-dl-banner {
      position: fixed; right: 20px; bottom: 20px; z-index: 9000; max-width: 390px;
      transform: translateY(140%); opacity: 0;
      transition: transform .45s cubic-bezier(.2,.8,.3,1), opacity .45s ease;
    }
    #ll-dl-banner.show { transform: none; opacity: 1; }
    #ll-dl-banner .ll-dl-inner {
      display: flex; align-items: center; gap: 14px;
      background: #1a1814; color: #e8e3da;
      border: 1px solid rgba(255,255,255,.08); border-radius: 16px;
      padding: 14px 16px; box-shadow: 0 18px 50px rgba(0,0,0,.42);
    }
    #ll-dl-banner .ll-dl-logo { width: 42px; height: auto; border-radius: 8px; flex-shrink: 0; }
    #ll-dl-banner .ll-dl-txt { display: flex; flex-direction: column; gap: 2px; line-height: 1.28; flex: 1; }
    #ll-dl-banner .ll-dl-txt strong { font-size: 14px; font-weight: 700; }
    #ll-dl-banner .ll-dl-txt span { font-size: 12px; opacity: .68; }
    #ll-dl-banner .ll-dl-btn {
      display: inline-flex; align-items: center; gap: 6px;
      background: linear-gradient(180deg, #F7B14D 0%, #F7941D 55%, #D47A0F 100%);
      color: #fff; text-decoration: none; white-space: nowrap; flex-shrink: 0;
      padding: 9px 14px; border-radius: 10px; font-size: 13px; font-weight: 600;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.3), 0 4px 12px rgba(247,148,29,.3);
      transition: transform .15s ease;
    }
    #ll-dl-banner .ll-dl-btn:hover { transform: translateY(-1px); }
    #ll-dl-banner .ll-dl-btn .material-icons { font-size: 18px !important; }
    #ll-dl-banner .ll-dl-x {
      background: none; border: none; cursor: pointer; color: rgba(232,227,218,.5);
      display: flex; padding: 4px; border-radius: 6px; flex-shrink: 0;
    }
    #ll-dl-banner .ll-dl-x:hover { background: rgba(255,255,255,.08); }
    #ll-dl-banner .ll-dl-x .material-icons { font-size: 18px !important; }
    @media (max-width: 480px) {
      #ll-dl-banner { left: 12px; right: 12px; bottom: 12px; max-width: none; }
    }`;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'll-dl-banner';
  bar.innerHTML = `
    <div class="ll-dl-inner">
      <img class="ll-dl-logo" src="/libreria-liceo-512.png" alt="" />
      <div class="ll-dl-txt">
        <strong>Usá la app de escritorio</strong>
        <span>Carga instantánea, sin esperas. Para Windows.</span>
      </div>
      <a class="ll-dl-btn" href="${INSTALLER_URL}" download>
        <span class="material-icons">download</span> Descargar
      </a>
      <button class="ll-dl-x" title="Ahora no" aria-label="Cerrar cartel">
        <span class="material-icons">close</span>
      </button>
    </div>`;
  document.body.appendChild(bar);
  requestAnimationFrame(() => bar.classList.add('show'));

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_) {}
    bar.classList.remove('show');
    setTimeout(() => bar.remove(), 400);
  };
  bar.querySelector('.ll-dl-x').addEventListener('click', dismiss);
  // Al descargar: marcamos como visto (no re-molestar) y el cartel pasa a
  // mostrar los pasos de instalación para alguien que lo hace por primera vez.
  bar.querySelector('.ll-dl-btn').addEventListener('click', () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_) {}
    const txt = bar.querySelector('.ll-dl-txt');
    const btn = bar.querySelector('.ll-dl-btn');
    if (txt) txt.innerHTML = `
      <strong>Descargando el instalador…</strong>
      <span>Cuando termine, abrilo y seguí los pasos. Si Windows muestra un aviso
      azul, tocá <b>Más información</b> y después <b>Ejecutar de todas formas</b>.
      Después se actualiza sola.</span>`;
    if (btn) btn.remove();
  });
}
