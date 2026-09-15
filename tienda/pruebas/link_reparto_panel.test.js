// @vitest-environment jsdom
/**
 * El link del repartidor, en Configuración de la tienda.
 *
 * Es la llave de la pantalla del repartidor: quien lo tiene ve los pedidos con
 * envío, con dirección y teléfono. Por eso se puede generar otro (el anterior
 * deja de andar) o anularlo en el momento, y cada cambio sube la versión que
 * las reglas comparan con la sesión del celular.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { datos } = vi.hoisted(() => ({ datos: { base: {}, escrituras: [], confirmar: true } }));

vi.mock('firebase/firestore', () => ({
  doc: (_db, col, id) => ({ col, id }),
  getDoc: async (ref) => {
    const d = datos.base[`${ref.col}/${ref.id}`];
    return { exists: () => d != null, data: () => d };
  },
  setDoc: async (ref, cambios) => {
    datos.escrituras.push({ ref, cambios });
    datos.base[`${ref.col}/${ref.id}`] = { ...cambios };
  },
  serverTimestamp: () => 'AHORA',
}));
vi.mock('../../webapp/src/components/dialogs.js', () => ({
  confirmDialog: vi.fn(async () => datos.confirmar),
  alertDialog: vi.fn(async () => {}),
  escHtml: (s) => String(s),
}));
vi.mock('../../webapp/src/avisos_cliente.js', () => ({ urlDeLaTienda: () => 'https://beta.liceolibreria.com' }));

const respirar = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); };
let caja;

async function montar() {
  const { montarLinkReparto } = await import('../../webapp/src/components/link_reparto.js');
  caja = document.createElement('div');
  document.body.appendChild(caja);
  await montarLinkReparto(caja, {});
  await respirar();
}
const tocar = async (sel) => { caja.querySelector(sel).click(); await respirar(); };

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  datos.base = {};
  datos.escrituras = [];
  datos.confirmar = true;
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});

describe('sin link', () => {
  it('ofrece crearlo, y al crearlo guarda una clave larga al azar', async () => {
    await montar();
    expect(caja.textContent).toMatch(/Todavía no hay link/);
    await tocar('[data-generar-link]');

    const acceso = datos.base['tienda_reparto/acceso'];
    expect(acceso.clave).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(acceso).toMatchObject({ version: 1, anulado: false, creado: 'AHORA' });
    expect(caja.querySelector('[data-link]').textContent).toBe(`https://beta.liceolibreria.com/reparto#k=${acceso.clave}`);
  });

  it('dos claves generadas no se repiten', async () => {
    await montar();
    await tocar('[data-generar-link]');
    const primera = datos.base['tienda_reparto/acceso'].clave;
    await tocar('[data-generar-link]');
    expect(datos.base['tienda_reparto/acceso'].clave).not.toBe(primera);
  });
});

describe('con link', () => {
  beforeEach(() => {
    datos.base['tienda_reparto/acceso'] = { clave: 'c'.repeat(43), version: 4, anulado: false };
  });

  it('muestra el link, lo copia y lo manda por WhatsApp', async () => {
    await montar();
    const link = `https://beta.liceolibreria.com/reparto#k=${'c'.repeat(43)}`;
    expect(caja.querySelector('[data-link]').textContent).toBe(link);
    await tocar('[data-copiar-link]');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(link);
    const wa = decodeURIComponent(caja.querySelector('a[data-whatsapp-link]').getAttribute('href'));
    expect(wa).toContain(link);
  });

  it('generar otro pide confirmación: el anterior deja de andar', async () => {
    await montar();
    datos.confirmar = false;
    await tocar('[data-generar-link]');
    expect(datos.escrituras).toHaveLength(0);

    datos.confirmar = true;
    await tocar('[data-generar-link]');
    const acceso = datos.base['tienda_reparto/acceso'];
    expect(acceso.clave).not.toBe('c'.repeat(43));
    expect(acceso.version).toBe(5);
  });

  it('anularlo lo deja sin uso y sube la versión, así la sesión abierta también se corta', async () => {
    await montar();
    await tocar('[data-anular-link]');
    expect(datos.base['tienda_reparto/acceso']).toMatchObject({ anulado: true, version: 5 });
    expect(caja.textContent).toMatch(/anulado/i);
    expect(caja.querySelector('[data-link]')).toBeNull();
  });

  it('si no se puede leer (sin permiso) lo dice en vez de ofrecer crear uno encima', async () => {
    const firestore = await import('firebase/firestore');
    vi.spyOn(firestore, 'getDoc').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    await montar();
    expect(caja.textContent).toMatch(/No se pudo leer el link/);
    expect(caja.querySelector('[data-generar-link]')).toBeNull();
  });
});
