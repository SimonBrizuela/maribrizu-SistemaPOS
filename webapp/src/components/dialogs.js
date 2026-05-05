/**
 * Diálogos modales reutilizables — reemplazan a confirm()/alert()/prompt() nativos.
 *
 * API:
 *   await confirmDialog({ title, message, confirmText, cancelText, danger })  → boolean
 *   await alertDialog({ title, message, type })                                → void
 *   await promptDialog({ title, message, placeholder, defaultValue, confirmText, cancelText }) → string|null
 *
 * Estilo: usa las clases globales `modal-overlay` y `modal` definidas en main.css
 * más overrides inline para acentos y espaciado consistentes con el resto de la web.
 */

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

function _icon(type) {
  // type: 'confirm' | 'danger' | 'info' | 'success' | 'warning' | 'error'
  return ({
    confirm: 'help_outline',
    danger:  'warning',
    info:    'info',
    success: 'check_circle',
    warning: 'warning_amber',
    error:   'error_outline',
  })[type] || 'help_outline';
}

function _color(type) {
  return ({
    confirm: '#7c3aed',
    danger:  '#dc2626',
    info:    '#2563eb',
    success: '#16a34a',
    warning: '#d97706',
    error:   '#dc2626',
  })[type] || '#7c3aed';
}

function _buildOverlay({ title, bodyHtml, footerHtml, type = 'confirm', maxWidth = 460 }) {
  const accent = _color(type);
  const icon   = _icon(type);
  document.querySelector('.app-dialog-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay app-dialog-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:${maxWidth}px">
      <div class="modal-header" style="border-bottom:none;padding-bottom:8px">
        <h3 style="display:flex;align-items:center;gap:10px;margin:0;font-size:16px">
          <span class="material-icons" style="color:${accent};font-size:26px">${icon}</span>
          ${_esc(title)}
        </h3>
      </div>
      <div class="modal-body" style="padding:4px 24px 20px;font-size:14px;color:var(--text);line-height:1.55">
        ${bodyHtml}
      </div>
      <div class="app-dialog-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--border);background:#f8fafc">
        ${footerHtml}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function _btnPrimary(label, accent) {
  return `<button class="ad-ok" style="padding:10px 20px;border-radius:8px;border:none;background:${accent};color:#fff;cursor:pointer;font-size:13px;font-weight:700;min-width:96px">${_esc(label)}</button>`;
}

function _btnSecondary(label) {
  return `<button class="ad-cancel" style="padding:10px 20px;border-radius:8px;border:1px solid var(--border);background:#fff;cursor:pointer;font-size:13px;font-weight:600;color:#475569;min-width:96px">${_esc(label)}</button>`;
}

export function confirmDialog({
  title = 'Confirmar',
  message = '',
  confirmText = 'Aceptar',
  cancelText = 'Cancelar',
  danger = false,
} = {}) {
  return new Promise(resolve => {
    const type = danger ? 'danger' : 'confirm';
    const accent = _color(type);
    const overlay = _buildOverlay({
      title,
      bodyHtml: message,
      footerHtml: `${_btnSecondary(cancelText)}${_btnPrimary(confirmText, accent)}`,
      type,
    });
    const cleanup = (val) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      else if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
    };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.ad-ok').addEventListener('click', () => cleanup(true));
    overlay.querySelector('.ad-cancel').addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(false); });
    setTimeout(() => overlay.querySelector('.ad-ok')?.focus(), 30);
  });
}

export function alertDialog({
  title = 'Aviso',
  message = '',
  type = 'info',          // 'info' | 'success' | 'warning' | 'error'
  confirmText = 'Entendido',
} = {}) {
  return new Promise(resolve => {
    const accent = _color(type);
    const overlay = _buildOverlay({
      title,
      bodyHtml: message,
      footerHtml: _btnPrimary(confirmText, accent),
      type,
    });
    const cleanup = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve();
    };
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); cleanup(); }
    };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.ad-ok').addEventListener('click', cleanup);
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });
    setTimeout(() => overlay.querySelector('.ad-ok')?.focus(), 30);
  });
}

export function promptDialog({
  title = 'Ingresá un valor',
  message = '',
  placeholder = '',
  defaultValue = '',
  confirmText = 'Aceptar',
  cancelText = 'Cancelar',
} = {}) {
  return new Promise(resolve => {
    const inputId = `ad_input_${Date.now()}`;
    const bodyHtml = `
      ${message ? `<div style="margin-bottom:10px">${message}</div>` : ''}
      <input id="${inputId}" type="text" value="${_esc(defaultValue)}" placeholder="${_esc(placeholder)}"
        style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;box-sizing:border-box"/>
    `;
    const overlay = _buildOverlay({
      title,
      bodyHtml,
      footerHtml: `${_btnSecondary(cancelText)}${_btnPrimary(confirmText, _color('confirm'))}`,
      type: 'confirm',
    });
    const input = overlay.querySelector(`#${inputId}`);
    const cleanup = (val) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
      else if (e.key === 'Enter') { e.preventDefault(); cleanup(input.value); }
    };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.ad-ok').addEventListener('click', () => cleanup(input.value));
    overlay.querySelector('.ad-cancel').addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(null); });
    input.addEventListener('focus', () => { input.select(); });
    setTimeout(() => input.focus(), 30);
  });
}
