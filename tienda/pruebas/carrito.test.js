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

describe('soloPack', () => {
  it('mínimo igual o mayor al contenido del pack = solo se vende el pack', () => {
    expect(carrito.soloPack({ ...CINTA, minimo: 25 })).toBe(true);
    expect(carrito.soloPack({ ...CINTA, minimo: 100 })).toBe(true);
  });

  it('con mínimo menor al contenido se sigue vendiendo suelto', () => {
    expect(carrito.soloPack({ ...CINTA, minimo: 5 })).toBe(false);
    expect(carrito.soloPack(CINTA)).toBe(false);
  });

  it('sin pack ofrecido no hay solo-pack posible', () => {
    expect(carrito.soloPack({ ...CINTA, precio_pack: null, minimo: 25 })).toBe(false);
    expect(carrito.soloPack({ ...CINTA, pack_contenido: null, minimo: 25 })).toBe(false);
  });

  it('agregar un producto solo-pack como pack cuenta packs, de a uno', () => {
    const tanza = { ...CINTA, nombre: 'Tanza Rigida 0.40', minimo: 25, stock: 100 };
    expect(carrito.agregar(tanza, { esPack: true })).toBe(1);
    const r = carrito.items()[0];
    expect(r.es_pack).toBe(true);
    expect(r.precio).toBe(4500);
  });
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

  it('el renglón lleva la foto del color elegido, o la portada si no tiene', () => {
    const lapiz = {
      id: 'l1', nombre: 'Lápiz', precio: 500, unidad: 'unidad', stock: 20, rubro: 'LIBRERIA',
      imagenes: ['portada.webp', 'detalle.webp'],
      variedades: [
        { nombre: 'Rojo', stock: 10, precio: null, imagen: 'rojo.webp' },
        { nombre: 'Azul', stock: 10, precio: null, imagen: null },
      ],
    };
    carrito.agregar(lapiz, { variedad: 'Rojo' });
    carrito.agregar(lapiz, { variedad: 'Azul' });
    carrito.agregar(lapiz, { variedad: 'Rojo', esPack: false });
    const [rojo, azul] = carrito.items();
    expect(rojo.foto).toBe('rojo.webp');
    expect(azul.foto).toBe('portada.webp');
    // Sin fotos de ningún tipo, null y no undefined: el pedido lo guarda tal cual.
    carrito.vaciar();
    carrito.agregar({ ...lapiz, imagenes: [], variedades: [{ nombre: 'Rojo', stock: 3 }] },
                    { variedad: 'Rojo' });
    expect(carrito.items()[0].foto).toBeNull();
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

describe('de a cuánto se vende', () => {
  // Un mapa de $100 que deja $40 no paga el minuto de ir a buscarlo entre dos
  // mil cuatrocientos productos: por eso hay mínimos que en el mostrador no
  // existen.
  const MAPA = { id: 'm1', nombre: 'Mapa Político', precio: 100, unidad: 'unidad',
                 stock: 300, minimo: 12, paso: 6, rubro: 'LIBRERIA', imagenes: [] };
  const CINTA_MIN = { ...CINTA, id: 'c9', minimo: 3, paso: 0.5 };

  it('el primero entra directo en el mínimo', () => {
    expect(carrito.agregar(MAPA)).toBe(12);
    expect(carrito.subtotal()).toBe(1200);
  });

  it('después suma de a un paso', () => {
    carrito.agregar(MAPA);
    carrito.agregar(MAPA, { cantidad: 6 });
    expect(carrito.cantidadDe('m1')).toBe(18);
  });

  it('no se puede bajar del mínimo', () => {
    carrito.agregar(MAPA);
    carrito.cambiarCantidad('m1', null, 1);
    expect(carrito.cantidadDe('m1')).toBe(12);
  });

  it('funciona igual con metros', () => {
    expect(carrito.agregar(CINTA_MIN)).toBe(3);
    carrito.cambiarCantidad('c9', null, 0.5);
    expect(carrito.cantidadDe('c9')).toBe(3);
  });

  it('el pack entero se lleva de a uno, aunque la unidad tenga mínimo', () => {
    // El mínimo son 3 metros sueltos; el rollo es otra cosa y va de a uno.
    expect(carrito.agregar(CINTA_MIN, { esPack: true })).toBe(1);
  });

  it('sin configurar nada queda como siempre', () => {
    expect(carrito.agregar(CARTULINA)).toBe(1);
    carrito.vaciar();
    expect(carrito.agregar(CINTA)).toBe(0.5);
  });

  it('al revalidar, sube la cantidad si subió el mínimo', async () => {
    carrito.agregar({ ...MAPA, minimo: 1, paso: 1 });
    vi.mocked(traerProducto).mockResolvedValue(MAPA);

    expect(await carrito.revalidar())
      .toEqual([{ tipo: 'minimo', nombre: 'Mapa Político', antes: 1, ahora: 12 }]);
    expect(carrito.cantidadDe('m1')).toBe(12);
  });

  it('si queda menos stock que el mínimo, sale del carrito', async () => {
    carrito.agregar(MAPA);
    vi.mocked(traerProducto).mockResolvedValue({ ...MAPA, stock: 5 });

    expect(await carrito.revalidar()).toEqual([{ tipo: 'sin_stock', nombre: 'Mapa Político' }]);
    expect(carrito.estaVacio()).toBe(true);
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

  it('saca el rollo cuando el local dejo de venderlo entero', async () => {
    // El panel tiene un interruptor por producto ("ofrecer el pack") y al
    // apagarlo el espejo publica `precio_pack: null`. El renglon del rollo se
    // quedaba con precio cero y el pedido entraba con ese rollo regalado.
    carrito.agregar(CINTA, { esPack: true });
    vi.mocked(traerProducto).mockResolvedValue({
      ...CINTA, precio_pack: null, pack_contenido: null, pack_tipo: null,
    });

    expect(await carrito.revalidar())
      .toEqual([{ tipo: 'baja', nombre: 'Cinta Raso 10mm' }]);
    expect(carrito.estaVacio()).toBe(true);
  });

  it('el rollo sigue vivo si el local lo sigue vendiendo', async () => {
    carrito.agregar(CINTA, { esPack: true });
    vi.mocked(traerProducto).mockResolvedValue(CINTA);
    expect(await carrito.revalidar()).toEqual([]);
    expect(carrito.items()[0].precio).toBe(4500);
  });

  it('nunca deja un renglon en cero: sin precio, sale del pedido', async () => {
    // Un producto que vuelve sin precio no se puede cobrar. Antes se quedaba
    // en el pedido a $0 y el aviso decia "cambio de $600 a $0".
    carrito.agregar(CARTULINA, { cantidad: 2 });
    vi.mocked(traerProducto).mockResolvedValue({ ...CARTULINA, precio: 0 });

    expect(await carrito.revalidar())
      .toEqual([{ tipo: 'baja', nombre: 'Cartulina Luma' }]);
    expect(carrito.estaVacio()).toBe(true);
  });
});

describe('ahorro por llevar el pack', () => {
  it('es la diferencia contra lo mismo suelto, en pesos y en porcentaje', () => {
    // 10 cartulinas a 600 son 6.000; la bolsa sale 5.600.
    expect(carrito.ahorroDePack({ precioSuelto: 600, precioPack: 5600, contenido: 10 }))
      .toEqual({ pesos: 400, porcentaje: 7 });
  });

  it('se multiplica por la cantidad de packs', () => {
    expect(carrito.ahorroDePack({ precioSuelto: 600, precioPack: 5600, contenido: 10, cantidad: 3 }))
      .toEqual({ pesos: 1200, porcentaje: 7 });
  });

  it('no inventa ahorro cuando el pack no conviene', () => {
    expect(carrito.ahorroDePack({ precioSuelto: 500, precioPack: 5000, contenido: 10 })).toBeNull();
    expect(carrito.ahorroDePack({ precioSuelto: 500, precioPack: 6000, contenido: 10 })).toBeNull();
  });

  it('se calla cuando el ahorro es tan grande que suena a que lo suelto esta caro', () => {
    // La resma: 500 hojas a 50 son 25.000, y la resma sale 7.800 (69%).
    expect(carrito.ahorroDePack({ precioSuelto: 50, precioPack: 7800, contenido: 500 })).toBeNull();
    // Justo en el tope todavia se muestra.
    expect(carrito.ahorroDePack({ precioSuelto: 100, precioPack: 5000, contenido: 100 }))
      .toEqual({ pesos: 5000, porcentaje: 50 });
  });

  it('sin precio suelto guardado no hay contra que comparar', () => {
    expect(carrito.ahorroDePack({ precioSuelto: null, precioPack: 5600, contenido: 10 })).toBeNull();
    expect(carrito.ahorroDePack({ precioSuelto: 0, precioPack: 5600, contenido: 10 })).toBeNull();
  });

  it('el renglon del pack guarda el precio suelto para poder mostrar el ahorro', () => {
    carrito.agregar(CARTULINA, { esPack: true, variedad: 'Celeste' });
    const [r] = carrito.items();
    expect(r.precio_suelto).toBe(600);
    expect(r.variedad).toBe('Celeste');
    expect(carrito.describirPack(r)).toBe('Pack de 10');
  });

  it('el rollo se describe en metros y con su nombre', () => {
    carrito.agregar(CINTA, { esPack: true });
    const [r] = carrito.items();
    expect(carrito.describirPack(r)).toBe('Rollo de 25 m');
  });
});
