/**
 * El carrito.
 *
 * Dos cosas que tienen que salir bien si o si: que el precio del renglon sea el
 * que corresponde (unidad, variedad o pack son tres precios distintos) y que no
 * se prometa mas de lo que hay en stock.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/datos.js', () => ({ traerProducto: vi.fn() }));

const { traerProducto } = await import('../src/datos.js');
const carrito = await import('../src/carrito.js');

const CINTA = {
  id: 'c1', nombre: 'Cinta Raso 10mm', precio: 300, unidad: 'metro',
  precio_pack: 4500, pack_tipo: 'rollo', pack_contenido: 25,
  stock: 100, rubro: 'MERCERIA', imagenes: ['foto.webp'], variedades: [],
};

const CARTULINA = {
  id: 'c2', nombre: 'Cartulina Luma', precio: 600, unidad: 'unidad',
  precio_pack: 5600, pack_contenido: 10, stock: 30, rubro: 'LIBRERIA', imagenes: [],
  variedades: [
    { nombre: 'Celeste', stock: 12, precio: null },
    { nombre: 'Dorada', stock: 3, precio: 900 },
  ],
};

beforeEach(() => {
  carrito.vaciar();
  vi.mocked(traerProducto).mockReset();
});

describe('agregar', () => {
  it('el paso lo decide la unidad: medio metro de cinta, un cuaderno', () => {
    expect(carrito.agregar(CINTA)).toBe(0.5);
    carrito.vaciar();
    expect(carrito.agregar(CARTULINA)).toBe(1);
  });

  it('suma sobre el renglon que ya estaba', () => {
    carrito.agregar(CINTA, { cantidad: 2 });
    carrito.agregar(CINTA, { cantidad: 1.5 });
    expect(carrito.cantidadDe('c1')).toBe(3.5);
    expect(carrito.unidades()).toBe(1);
  });

  it('no deja pasar del stock', () => {
    carrito.agregar(CARTULINA, { variedad: 'Dorada', cantidad: 10 });
    expect(carrito.cantidadDe('c2', 'Dorada')).toBe(3);
  });

  it('cobra el precio de la variedad cuando lo tiene', () => {
    carrito.agregar(CARTULINA, { variedad: 'Dorada' });
    carrito.agregar(CARTULINA, { variedad: 'Celeste' });
    const [dorada, celeste] = carrito.items();
    expect(dorada.precio).toBe(900);
    expect(celeste.precio).toBe(600);
    expect(carrito.unidades()).toBe(2);
  });

  it('el pack es otro renglon, con su precio y su stock en packs', () => {
    carrito.agregar(CINTA, { cantidad: 2 });
    carrito.agregar(CINTA, { esPack: true, cantidad: 1 });

    const pack = carrito.items().find(r => r.es_pack);
    expect(carrito.unidades()).toBe(2);
    expect(pack.precio).toBe(4500);
    expect(pack.unidad).toBe('unidad');
    // 100 metros sueltos son 4 rollos de 25, no 100 rollos.
    expect(pack.stock).toBe(4);
  });

  it('no deja restos de flotante al sumar de a medio metro', () => {
    for (let i = 0; i < 5; i++) carrito.agregar(CINTA);
    expect(carrito.cantidadDe('c1')).toBe(2.5);
    expect(carrito.subtotal()).toBe(750);
  });
});

describe('subtotal', () => {
  it('suma precio por cantidad de cada renglon', () => {
    carrito.agregar(CINTA, { cantidad: 2.5 });          // 750
    carrito.agregar(CARTULINA, { variedad: 'Dorada', cantidad: 2 }); // 1800
    expect(carrito.subtotal()).toBe(2550);
  });
});

describe('sacar y deshacer', () => {
  it('devuelve el renglon a su lugar', () => {
    carrito.agregar(CINTA);
    carrito.agregar(CARTULINA);
    const posicion = carrito.posicionDe('c1');
    const fuera = carrito.sacar('c1');

    expect(carrito.unidades()).toBe(1);
    carrito.restaurar(fuera, posicion);
    expect(carrito.items()[0].id).toBe('c1');
  });
});

describe('revalidar contra la base', () => {
  it('avisa el cambio de precio y lo corrige', async () => {
    carrito.agregar(CARTULINA, { cantidad: 2 });
    vi.mocked(traerProducto).mockResolvedValue({ ...CARTULINA, precio: 700 });

    const cambios = await carrito.revalidar();
    expect(cambios).toEqual([{ tipo: 'precio', nombre: 'Cartulina Luma', antes: 600, ahora: 700 }]);
    expect(carrito.subtotal()).toBe(1400);
  });

  it('recorta la cantidad cuando quedo menos stock', async () => {
    carrito.agregar(CARTULINA, { cantidad: 10 });
    vi.mocked(traerProducto).mockResolvedValue({ ...CARTULINA, stock: 4 });

    const cambios = await carrito.revalidar();
    expect(cambios).toEqual([{ tipo: 'menos_stock', nombre: 'Cartulina Luma', antes: 10, ahora: 4 }]);
    expect(carrito.cantidadDe('c2')).toBe(4);
  });

  it('saca lo que se quedo sin stock', async () => {
    carrito.agregar(CARTULINA);
    vi.mocked(traerProducto).mockResolvedValue({ ...CARTULINA, stock: 0 });

    expect(await carrito.revalidar()).toEqual([{ tipo: 'sin_stock', nombre: 'Cartulina Luma' }]);
    expect(carrito.estaVacio()).toBe(true);
  });

  it('saca lo que ya no esta publicado', async () => {
    carrito.agregar(CINTA);
    vi.mocked(traerProducto).mockResolvedValue(null);

    expect(await carrito.revalidar()).toEqual([{ tipo: 'baja', nombre: 'Cinta Raso 10mm' }]);
    expect(carrito.estaVacio()).toBe(true);
  });

  it('saca la variedad que dejo de existir, sin tocar el resto', async () => {
    carrito.agregar(CARTULINA, { variedad: 'Dorada' });
    carrito.agregar(CARTULINA, { variedad: 'Celeste' });
    vi.mocked(traerProducto).mockResolvedValue({
      ...CARTULINA, variedades: [{ nombre: 'Celeste', stock: 12, precio: null }],
    });

    const cambios = await carrito.revalidar();
    expect(cambios).toEqual([{ tipo: 'baja', nombre: 'Cartulina Luma (Dorada)' }]);
    expect(carrito.unidades()).toBe(1);
    expect(carrito.items()[0].variedad).toBe('Celeste');
  });

  it('sin cambios no molesta al cliente', async () => {
    carrito.agregar(CINTA, { cantidad: 2 });
    vi.mocked(traerProducto).mockResolvedValue(CINTA);
    expect(await carrito.revalidar()).toEqual([]);
  });
});
