/**
 * El pliegue de los grupos de tamaños en la grilla.
 *
 * "Cierre Común 10 cm", "12 cm", "14 cm"… son productos separados en el
 * catálogo (cada uno con su stock y su precio) y UNA card en la tienda. Acá se
 * prueba la lógica pura de tienda/src/grupos.js: cómo se ordenan los tamaños,
 * qué dice la card del grupo y cómo se pliega una lista paginada.
 */
import { describe, it, expect } from 'vitest';
import { valorDeTamano, ordenarPorTamano, cardDeGrupo, plegarGrupos }
  from '../src/grupos.js';

const cierre = (tamano, extra = {}) => ({
  id: `c-${tamano}`,
  nombre: `Cierre Común ${tamano}`,
  grupo: 'Cierre Común',
  grupo_clave: 'cierre comun',
  tamano,
  precio: 300,
  precio_anterior: null,
  descuento: null,
  stock: 10,
  variedades: [],
  ...extra,
});

const suelto = (id, extra = {}) => ({
  id,
  nombre: `Producto ${id}`,
  grupo: null,
  grupo_clave: null,
  tamano: null,
  precio: 500,
  stock: 5,
  variedades: [],
  ...extra,
});

describe('el orden de los tamaños', () => {
  it('ordena por el número, no por el texto: 9 antes que 10', () => {
    const orden = ordenarPorTamano([cierre('10 cm'), cierre('9 cm'), cierre('25 cm')]);
    expect(orden.map(p => p.tamano)).toEqual(['9 cm', '10 cm', '25 cm']);
  });

  it('con dos medidas compara la primera y desempata con la segunda', () => {
    const orden = ordenarPorTamano([cierre('10x20 cm'), cierre('10x15 cm'), cierre('9x50 cm')]);
    expect(orden.map(p => p.tamano)).toEqual(['9x50 cm', '10x15 cm', '10x20 cm']);
  });

  it('acepta coma decimal y deja lo sin número al final, alfabético', () => {
    expect(valorDeTamano('0,5 mm')).toEqual([0.5]);
    const orden = ordenarPorTamano([cierre('Grande'), cierre('12 cm'), cierre('Chico')]);
    expect(orden.map(p => p.tamano)).toEqual(['12 cm', 'Chico', 'Grande']);
  });
});

describe('la card del grupo', () => {
  it('lleva el nombre del grupo y el precio más bajo, avisando el "desde"', () => {
    const card = cardDeGrupo([cierre('16 cm', { precio: 400 }), cierre('10 cm', { precio: 300 })]);
    expect(card.nombre).toBe('Cierre Común');
    expect(card.precio).toBe(300);
    expect(card.grupoDesde).toBe(true);
    expect(card.esGrupo).toBe(true);
  });

  it('con todos los tamaños al mismo precio no hay "desde"', () => {
    const card = cardDeGrupo([cierre('10 cm'), cierre('12 cm')]);
    expect(card.precio).toBe(300);
    expect(card.grupoDesde).toBe(false);
  });

  it('junta los colores de todos los tamaños, sumando el stock del repetido', () => {
    const card = cardDeGrupo([
      cierre('10 cm', { variedades: [{ nombre: 'Rojo', stock: 3 }, { nombre: 'Azul', stock: 0 }] }),
      cierre('12 cm', { variedades: [{ nombre: 'Rojo', stock: 2 }, { nombre: 'Verde', stock: 4 }] }),
    ]);
    expect(card.variedades).toEqual([
      { nombre: 'Rojo', stock: 5 },
      { nombre: 'Azul', stock: 0 },
      { nombre: 'Verde', stock: 4 },
    ]);
  });

  it('el descuento se muestra solo si TODOS los tamaños lo tienen igual', () => {
    const oferta = { nombre: 'Liquidación', porcentaje: 20 };
    const parcial = cardDeGrupo([
      cierre('10 cm', { descuento: oferta, precio: 240, precio_anterior: 300 }),
      cierre('12 cm'),
    ]);
    expect(parcial.descuento).toBeNull();
    expect(parcial.precio_anterior).toBeNull();

    const total = cardDeGrupo([
      cierre('10 cm', { descuento: oferta, precio: 240, precio_anterior: 300 }),
      cierre('12 cm', { descuento: oferta, precio: 240, precio_anterior: 300 }),
    ]);
    expect(total.descuento).toEqual(oferta);
    expect(total.precio_anterior).toBe(300);
  });
});

describe('el pliegue de la grilla', () => {
  it('un grupo con un solo tamaño a la vista es la card del producto, sin promesas', () => {
    const solo = cierre('10 cm');
    const [card] = plegarGrupos([solo]);
    expect(card).toBe(solo);
    expect(card.esGrupo).toBeUndefined();
  });

  it('el grupo queda como una card en el lugar de su primer miembro', () => {
    const cards = plegarGrupos([suelto('a'), cierre('10 cm'), suelto('b'), cierre('12 cm')]);
    expect(cards.map(c => c.nombre)).toEqual(['Producto a', 'Cierre Común', 'Producto b']);
    expect(cards[1].esGrupo).toBe(true);
  });

  it('lo que no tiene grupo pasa tal cual', () => {
    const lista = [suelto('a'), suelto('b')];
    expect(plegarGrupos(lista)).toEqual(lista);
  });

  it('entre tandas paginadas el grupo no se dibuja dos veces', () => {
    const vistos = new Set();
    const primera = plegarGrupos([cierre('10 cm'), cierre('12 cm'), suelto('a')], vistos);
    expect(primera.map(c => c.nombre)).toEqual(['Cierre Común', 'Producto a']);

    // El 14 cm cayó en la página siguiente: la card del grupo ya está dibujada.
    const segunda = plegarGrupos([cierre('14 cm'), suelto('b')], vistos);
    expect(segunda.map(c => c.nombre)).toEqual(['Producto b']);
  });

  it('dos grupos distintos no se mezclan', () => {
    const buzo = t => cierre(t, { grupo: 'Cierre Buzo', grupo_clave: 'cierre buzo' });
    const cards = plegarGrupos([cierre('10 cm'), buzo('14 cm'), cierre('12 cm'), buzo('16 cm')]);
    expect(cards.map(c => c.nombre)).toEqual(['Cierre Común', 'Cierre Buzo']);
  });
});

describe('la card del grupo, dibujada', () => {
  const conCard = (tamano, extra = {}) => cierre(tamano, {
    rubro: 'MERCERIA', marca: '', sub_rubro: '', categoria: '',
    unidad: 'unidad', imagenes: [], tokens: [], precio_pack: null,
    pack_tipo: null, pack_nombre: null, pack_contenido: null, destacado: false,
    ...extra,
  });

  it('dice "Varios tamaños", cobra "desde" el más barato y manda a elegir', async () => {
    const { cardProducto } = await import('../src/componentes.js');
    const card = cardDeGrupo([conCard('16 cm', { precio: 400 }), conCard('10 cm', { precio: 300 })]);
    const html = cardProducto(card);

    expect(html).toContain('Varios tamaños');
    expect(html).toContain('desde');
    expect(html).toContain('$300');
    // El signo + lleva a la ficha a elegir el tamaño, no agrega a ciegas.
    expect(html).toContain('data-elegir="1"');
    expect(html).toContain(`/p/${card.id}`);
  });

  it('con un precio único no inventa un "desde"', async () => {
    const { cardProducto } = await import('../src/componentes.js');
    const html = cardProducto(cardDeGrupo([conCard('10 cm'), conCard('12 cm')]));
    expect(html).toContain('Varios tamaños');
    expect(html).not.toContain('card-producto__desde');
  });
});

describe('el selector de tamaños de la ficha', () => {
  it('marca el elegido y cada botón lleva al suyo', async () => {
    const { listaDeTamanos } = await import('../src/paginas/producto.js');
    const html = listaDeTamanos(
      [cierre('10 cm'), cierre('12 cm'), cierre('14 cm')], 'c-12 cm');

    expect(html).toContain('Elegí el tamaño');
    expect(html).toContain('· 3 tamaños');
    expect(html).toContain('data-tamano="c-10 cm"');
    // El del producto que se está mirando aparece apretado.
    expect(html).toContain('data-tamano="c-12 cm"\n            aria-pressed="true"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it('con un solo tamaño publicado no hay nada que elegir', async () => {
    const { listaDeTamanos } = await import('../src/paginas/producto.js');
    expect(listaDeTamanos([cierre('10 cm')], 'c-10 cm')).toBe('');
  });
});
