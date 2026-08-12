/**
 * Modo "marcar fotos".
 *
 * Lo que importa acá es que el tilde esté a la vista apenas se entra, que se
 * pueda apagar por aparato, y que lo marcado sobreviva a cambiar de pantalla.
 * Firestore se reemplaza por espías: lo que se prueba es la decisión, no el SDK.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setDoc = vi.fn(async () => {});
const deleteDoc = vi.fn(async () => {});

vi.mock('../src/firebase.js', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  doc: (_db, col, id) => ({ col, id }),
  setDoc: (...args) => setDoc(...args),
  deleteDoc: (...args) => deleteDoc(...args),
  serverTimestamp: () => 'AHORA',
}));

const PRODUCTO = {
  id: 'abc123',
  nombre: 'Cuaderno Rivadavia ABC',
  rubro: 'LIBRERIA',
  imagenes: [],
};

/** Módulo nuevo por prueba: guarda estado en memoria además de localStorage. */
async function cargarModulo() {
  vi.resetModules();
  return import('../src/fotos.js');
}

beforeEach(() => {
  localStorage.clear();
  setDoc.mockClear();
  deleteDoc.mockClear();
  globalThis.location = { href: 'https://beta.liceolibreria.com/catalogo' };
  globalThis.history = { replaceState: vi.fn() };
});

describe('quién ve el tilde', () => {
  it('está apenas se entra, sin ningún parámetro', async () => {
    const fotos = await cargarModulo();
    fotos.aplicarModoDesdeURL();
    expect(fotos.modoFotos()).toBe(true);
    expect(fotos.tildeFoto(PRODUCTO)).toContain('data-marcar-foto="abc123"');
  });

  it('?fotos=0 lo apaga en ese aparato', async () => {
    globalThis.location = { href: 'https://beta.liceolibreria.com/catalogo?fotos=0' };
    const fotos = await cargarModulo();
    fotos.aplicarModoDesdeURL();
    expect(fotos.modoFotos()).toBe(false);
    expect(fotos.tildeFoto(PRODUCTO)).toBe('');
  });

  it('apagado sigue apagado en la visita siguiente', async () => {
    globalThis.location = { href: 'https://beta.liceolibreria.com/catalogo?fotos=0' };
    let fotos = await cargarModulo();
    fotos.aplicarModoDesdeURL();

    globalThis.location = { href: 'https://beta.liceolibreria.com/p/abc123' };
    fotos = await cargarModulo();
    fotos.aplicarModoDesdeURL();
    expect(fotos.modoFotos()).toBe(false);
  });

  it('?fotos=1 lo vuelve a prender donde se había apagado', async () => {
    globalThis.location = { href: 'https://beta.liceolibreria.com/catalogo?fotos=0' };
    let fotos = await cargarModulo();
    fotos.aplicarModoDesdeURL();

    globalThis.location = { href: 'https://beta.liceolibreria.com/catalogo?fotos=1' };
    fotos = await cargarModulo();
    fotos.aplicarModoDesdeURL();
    expect(fotos.modoFotos()).toBe(true);
  });

  it('el parámetro se borra de la barra de direcciones', async () => {
    globalThis.location = { href: 'https://beta.liceolibreria.com/catalogo?fotos=1&q=goma' };
    const fotos = await cargarModulo();
    fotos.aplicarModoDesdeURL();

    const [, , url] = globalThis.history.replaceState.mock.calls[0];
    expect(url).not.toContain('fotos=');
    expect(url).toContain('q=goma');
  });
});

describe('marcar y desmarcar', () => {
  it('marcar guarda en Firestore con el id del producto como id del documento', async () => {
    const fotos = await cargarModulo();
    const puesta = await fotos.alternarMarca(PRODUCTO);

    expect(puesta).toBe(true);
    expect(fotos.estaMarcado('abc123')).toBe(true);
    const [ref, datos] = setDoc.mock.calls[0];
    expect(ref).toEqual({ col: 'tienda_fotos_pedidas', id: 'abc123' });
    expect(datos).toMatchObject({
      producto_id: 'abc123',
      nombre: 'Cuaderno Rivadavia ABC',
      rubro: 'LIBRERIA',
      tenia_foto: false,
    });
  });

  it('distingue el que no tiene foto del que hay que reemplazar', async () => {
    const fotos = await cargarModulo();
    await fotos.alternarMarca({ ...PRODUCTO, imagenes: ['https://x/1.webp'] });
    expect(setDoc.mock.calls[0][1].tenia_foto).toBe(true);
  });

  it('volver a tocar lo saca de la lista', async () => {
    const fotos = await cargarModulo();
    await fotos.alternarMarca(PRODUCTO);
    const puesta = await fotos.alternarMarca(PRODUCTO);

    expect(puesta).toBe(false);
    expect(fotos.estaMarcado('abc123')).toBe(false);
    expect(deleteDoc).toHaveBeenCalledTimes(1);
  });

  it('lo marcado sobrevive a recargar la página', async () => {
    let fotos = await cargarModulo();
    await fotos.alternarMarca(PRODUCTO);

    fotos = await cargarModulo();
    expect(fotos.estaMarcado('abc123')).toBe(true);
    expect(fotos.cuantosMarcados()).toBe(1);
  });

  it('si Firestore falla, el tilde no queda puesto mintiendo', async () => {
    const fotos = await cargarModulo();
    setDoc.mockRejectedValueOnce(new Error('sin conexión'));

    await expect(fotos.alternarMarca(PRODUCTO)).rejects.toThrow('sin conexión');
    expect(fotos.estaMarcado('abc123')).toBe(false);
  });

  it('el tilde de un producto ya marcado sale puesto', async () => {
    const fotos = await cargarModulo();
    fotos.aplicarModoDesdeURL();
    await fotos.alternarMarca(PRODUCTO);

    const html = fotos.tildeFoto(PRODUCTO);
    expect(html).toContain('marca-foto--puesta');
    expect(html).toContain('aria-pressed="true"');
  });

  it('escapa el nombre del producto en los atributos', async () => {
    const fotos = await cargarModulo();
    fotos.aplicarModoDesdeURL();

    const html = fotos.tildeFoto({ ...PRODUCTO, nombre: 'Regla 30" <b>rota</b>' });
    expect(html).not.toContain('<b>rota</b>');
    expect(html).toContain('&quot;');
  });
});

describe('la casilla en la card, de punta a punta', () => {
  const PROD = {
    id: 'abc123', nombre: 'Cuaderno Rivadavia ABC', rubro: 'LIBRERIA',
    precio: 1200, stock: 5, imagenes: [], variedades: [], tokens: [],
    marca: '', sub_rubro: '', categoria: '', unidad: 'unidad',
  };

  it('apagado en ese aparato, la card sale limpia', async () => {
    globalThis.location = { href: 'https://beta.liceolibreria.com/catalogo?fotos=0' };
    const fotos = await cargarModulo();
    fotos.aplicarModoDesdeURL();
    const { cardProducto } = await import('../src/componentes.js');
    expect(cardProducto(PROD)).not.toContain('marca-foto');
  });

  it('la card trae la casilla sin hacer nada', async () => {
    const fotos = await cargarModulo();
    fotos.aplicarModoDesdeURL();

    const { cardProducto } = await import('../src/componentes.js');
    const html = cardProducto(PROD);
    expect(html).toContain('class="marca-foto"');
    expect(html).toContain('data-marcar-foto="abc123"');
    // Tiene que quedar dentro de la card, no suelta al final.
    expect(html.indexOf('marca-foto')).toBeLessThan(html.indexOf('card-producto__cuerpo'));
  });

  it('también en las cards que tienen foto', async () => {
    const fotos = await cargarModulo();
    fotos.aplicarModoDesdeURL();

    const { grilla } = await import('../src/componentes.js');
    const html = grilla([{ ...PROD, imagenes: ['https://x/1.webp'] }, PROD]);
    expect((html.match(/marca-foto/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
