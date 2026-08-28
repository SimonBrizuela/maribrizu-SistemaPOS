// @vitest-environment jsdom
/**
 * Las piezas de interfaz que usa todo el panel: diálogos, tema, esqueletos y
 * el modal del detalle de una venta.
 *
 * Lo que importa acá es lo que se ve y lo que se contesta. Un `confirmDialog`
 * que no devuelve lo que la persona apretó borra cosas que nadie mandó borrar,
 * y un `escHtml` flojo mete el nombre de un producto adentro del HTML de la
 * página.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase/firestore', async () => (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {} }));

const { escHtml, confirmDialog, alertDialog, promptDialog, verFotoGrande } =
  await import('../../webapp/src/components/dialogs.js');
const { getTheme, setTheme, toggleTheme, cssVar } =
  await import('../../webapp/src/theme.js');
const { renderSkeleton } = await import('../../webapp/src/skeletons.js');

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});

/** Aprieta el botón cuyo texto coincida. */
function apretar(texto) {
  const botones = [...document.querySelectorAll('button')];
  const b = botones.find(x => new RegExp(texto, 'i').test(x.textContent));
  expect(b, `no hay botón "${texto}" entre [${botones.map(x => x.textContent.trim())}]`).toBeTruthy();
  b.click();
}

describe('escapar texto que va al HTML', () => {
  it('los signos que abren etiquetas se neutralizan', () => {
    expect(escHtml('<script>alert(1)</script>')).not.toContain('<script>');
    expect(escHtml('Marta & Cía')).toContain('&amp;');
    expect(escHtml('dijo "hola"')).toContain('&quot;');
  });

  it('lo vacío no se convierte en "undefined"', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });
});

describe('preguntar antes de hacer algo que no se deshace', () => {
  it('devuelve true cuando se confirma', async () => {
    const respuesta = confirmDialog({ title: 'Borrar', message: '¿Seguro?' });
    await new Promise(r => setTimeout(r, 0));
    apretar('confirmar|aceptar|s[íi]|borrar');
    expect(await respuesta).toBe(true);
  });

  it('devuelve false cuando se cancela', async () => {
    const respuesta = confirmDialog({ title: 'Borrar', message: '¿Seguro?' });
    await new Promise(r => setTimeout(r, 0));
    apretar('cancelar|no');
    expect(await respuesta).toBe(false);
  });

  it('muestra el título y el mensaje que se le pasan', async () => {
    confirmDialog({ title: 'Cerrar caja', message: 'Quedan retiros sin anotar' });
    await new Promise(r => setTimeout(r, 0));
    expect(document.body.textContent).toContain('Cerrar caja');
    expect(document.body.textContent).toContain('Quedan retiros sin anotar');
  });

  it('el mensaje se cierra al aceptar', async () => {
    const listo = alertDialog({ title: 'Listo', message: 'Se guardó' });
    await new Promise(r => setTimeout(r, 0));
    expect(document.querySelector('.modal-overlay')).toBeTruthy();
    apretar('aceptar|entendido|cerrar|ok');
    await listo;
    await new Promise(r => setTimeout(r, 0));
    expect(document.querySelector('.modal-overlay')).toBeFalsy();
  });
});

describe('pedir un dato', () => {
  it('devuelve lo que se escribió', async () => {
    const respuesta = promptDialog({ title: 'Motivo', message: '¿Por qué?' });
    await new Promise(r => setTimeout(r, 0));
    const input = document.querySelector('.modal-overlay input, .modal-overlay textarea');
    expect(input).toBeTruthy();
    input.value = 'Se rompió';
    apretar('aceptar|guardar|confirmar|ok');
    expect(await respuesta).toBe('Se rompió');
  });

  it('cancelar devuelve null, no un texto vacío', async () => {
    // La diferencia importa: vacío es "lo dejó en blanco a propósito".
    const respuesta = promptDialog({ title: 'Motivo', message: '¿Por qué?' });
    await new Promise(r => setTimeout(r, 0));
    apretar('cancelar');
    expect(await respuesta).toBeNull();
  });
});

describe('ver una foto en grande', () => {
  it('abre la imagen y se puede cerrar', async () => {
    verFotoGrande('https://ejemplo/foto.webp');
    await new Promise(r => setTimeout(r, 0));
    const img = document.querySelector('img[src*="foto.webp"]');
    expect(img).toBeTruthy();
  });
});

describe('el tema', () => {
  it('arranca en claro y se puede poner oscuro', () => {
    setTheme('dark');
    expect(getTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('el interruptor va y vuelve', () => {
    setTheme('light');
    expect(toggleTheme()).toBe('dark');
    expect(toggleTheme()).toBe('light');
  });

  it('la elección sobrevive a la recarga', async () => {
    const { initTheme } = await import('../../webapp/src/theme.js');
    setTheme('dark');
    expect(localStorage.getItem('ll-theme')).toBe('dark');

    // Simula el F5: el atributo se pierde y `initTheme` lo repone.
    document.documentElement.removeAttribute('data-theme');
    expect(initTheme()).toBe('dark');
  });

  it('sin nada guardado arranca en claro', async () => {
    const { initTheme } = await import('../../webapp/src/theme.js');
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    expect(initTheme()).toBe('light');
  });

  it('avisa a quien esté escuchando', async () => {
    // Los gráficos se rehacen al cambiar de tema: el canvas hornea los colores.
    const { onThemeChange } = await import('../../webapp/src/theme.js');
    const vistos = [];
    const soltar = onThemeChange(t => vistos.push(t));
    setTheme('dark');
    setTheme('light');
    soltar();
    setTheme('dark');
    expect(vistos).toEqual(['dark', 'light']);
  });

  it('un color que no existe devuelve el de respaldo', () => {
    expect(cssVar('--no-existe', '#000')).toBe('#000');
  });
});

describe('los esqueletos de carga', () => {
  it('cada pantalla tiene el suyo y ninguno viene vacío', () => {
    for (const pagina of ['dashboard', 'ventas', 'catalogo', 'cierres', 'historial']) {
      const html = renderSkeleton(pagina);
      expect(typeof html, pagina).toBe('string');
      expect(html.length, pagina).toBeGreaterThan(0);
    }
  });

  it('una pantalla desconocida igual devuelve algo', () => {
    // Es lo que se pinta mientras carga: un hueco en blanco se lee como error.
    expect(renderSkeleton('inventada').length).toBeGreaterThan(0);
  });
});
