// @vitest-environment jsdom
/**
 * Los tres módulos que sólo tienen sentido dentro del .exe: arranque con
 * Windows, actualización automática y el cartel de descarga.
 *
 * Hoy el panel se usa por navegador — el .exe se retiró de distribución. Lo que
 * importa entonces es lo contrario de lo que hacen: que en la web NO hagan
 * nada. Un `import('@tauri-apps/...')` en el navegador es un error en la
 * consola en cada arranque; un cartel ofreciendo un instalador que ya no se
 * publica manda a la gente a descargar algo viejo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const autostart = await import('../../webapp/src/autostart.js');
const { initUpdater } = await import('../../webapp/src/updater.js');
const { initDownloadBanner } = await import('../../webapp/src/download_banner.js');

/** Finge estar adentro del .exe. */
function comoExe(si) {
  if (si) window.__TAURI_INTERNALS__ = { invoke: () => {} };
  else delete window.__TAURI_INTERNALS__;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  localStorage.clear();
  comoExe(false);
});

afterEach(() => { comoExe(false); vi.restoreAllMocks(); });

describe('saber dónde está corriendo', () => {
  it('en el navegador no es el .exe', () => {
    expect(autostart.isTauriApp()).toBe(false);
  });

  it('adentro del .exe sí', () => {
    comoExe(true);
    expect(autostart.isTauriApp()).toBe(true);
  });
});

describe('arranque con Windows', () => {
  it('en la web no intenta nada y no rompe', async () => {
    // Si intentara importar el plugin de Tauri, tiraría un error en cada
    // arranque del panel en el navegador.
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(autostart.initAutostart()).resolves.toBeUndefined();
    expect(avisos).not.toHaveBeenCalled();
    expect(localStorage.getItem('ll-autostart-init')).toBeNull();
  });

  it('en la web dice que no está activado', async () => {
    expect(await autostart.getAutostart()).toBe(false);
  });

  it('en la web, prenderlo o apagarlo no hace nada', async () => {
    await expect(autostart.setAutostart(true)).resolves.toBeUndefined();
    await expect(autostart.setAutostart(false)).resolves.toBeUndefined();
  });
});

describe('actualización automática', () => {
  it('en la web ni siquiera chequea', async () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await initUpdater();
    expect(avisos).not.toHaveBeenCalled();
    expect(document.body.innerHTML).toBe('');
  });
});

describe('el cartel de descarga del .exe', () => {
  it('no está enganchado al arranque del panel', async () => {
    // El .exe se retiró: el cartel ofrece un instalador que ya no se publica.
    // La prueba fija que siga desconectado, para que no vuelva por accidente.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const main = readFileSync(join(process.cwd(), '..', 'webapp', 'src', 'main.js'), 'utf8');
    expect(main).not.toContain('initDownloadBanner');
  });

  it('adentro del .exe no se muestra', () => {
    comoExe(true);
    Object.defineProperty(navigator, 'userAgent',
      { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true });
    initDownloadBanner();
    expect(document.getElementById('ll-dl-banner')).toBeNull();
  });

  it('en un celular tampoco', () => {
    Object.defineProperty(navigator, 'userAgent',
      { value: 'Mozilla/5.0 (Linux; Android 13) Mobile', configurable: true });
    initDownloadBanner();
    expect(document.getElementById('ll-dl-banner')).toBeNull();
  });

  it('si ya lo cerraron una vez, no vuelve', () => {
    Object.defineProperty(navigator, 'userAgent',
      { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true });
    localStorage.setItem('ll-exe-banner-dismissed-v2', '1');
    initDownloadBanner();
    expect(document.getElementById('ll-dl-banner')).toBeNull();
  });

  it('llamado a mano en Windows aparece, y la cruz lo cierra para siempre', () => {
    Object.defineProperty(navigator, 'userAgent',
      { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true });
    initDownloadBanner();
    const cartel = document.getElementById('ll-dl-banner');
    expect(cartel).toBeTruthy();

    cartel.querySelector('.ll-dl-x').click();
    expect(localStorage.getItem('ll-exe-banner-dismissed-v2')).toBe('1');
  });
});
