/**
 * Las reglas de los cupones, que comparten el checkout, la función del servidor
 * y el panel. Si algo de acá cambia, cambia en los tres.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizarCodigo, codigoValido, generarCodigo, telefonoClave, claveDeRubro,
  aplicaA, describirAlcance, limiteDeDia, evaluarCupon, repartir,
  mensajeDeCupon, describirCupon, usosDePersona, resumenDeUsos,
} from '../src/cupones.js';

const RESMA = { id: 'resma', nombre: 'Resma Pampa A4', rubro: 'PAPELERÍA', precio: 18000, cantidad: 1, subtotal: 18000 };
const LAPIZ = { id: 'lapiz', nombre: 'Lápiz Faber', rubro: 'LIBRERIA', precio: 800, cantidad: 3, subtotal: 2400 };
const CINTA = { id: 'cinta', nombre: 'Cinta raso', rubro: 'MERCERIA', precio: 300, cantidad: 2.5, subtotal: 750, variedad: 'Rojo' };

const cupon = (extra = {}) => ({
  codigo: 'PRUEBA', nombre: 'Cupón de prueba', tipo: 'porcentaje', valor: 10,
  aplica: { modo: 'todo' }, activo: true, ...extra,
});

const pedido = (extra = {}) => ({
  renglones: [RESMA, LAPIZ, CINTA], envio: 0, modo: 'retiro',
  ahora: new Date('2026-09-10T15:00:00Z'), ...extra,
});

describe('el código', () => {
  it('se normaliza: mayúsculas, sin tildes, sin espacios', () => {
    expect(normalizarCodigo('  bienvenida 10 ')).toBe('BIENVENIDA10');
    expect(normalizarCodigo('Día-del-Niño')).toBe('DIA-DEL-NINO');
    expect(normalizarCodigo('¡hola!')).toBe('HOLA');
    expect(normalizarCodigo(null)).toBe('');
  });

  it('vale con 4 a 20 letras o números, y guiones solo en el medio', () => {
    expect(codigoValido('LICEO')).toBe(true);
    expect(codigoValido('LICEO-K7M2PX')).toBe(true);
    expect(codigoValido('ABC')).toBe(false);
    expect(codigoValido('-ABCD')).toBe(false);
    expect(codigoValido('ABCD-')).toBe(false);
    expect(codigoValido('A'.repeat(21))).toBe(false);
    expect(codigoValido('con espacio')).toBe(false);
  });

  it('se genera sin letras que se confundan al dictarlo', () => {
    const c = generarCodigo('liceo', 6, () => 0.99);
    expect(c).toMatch(/^LICEO-[A-HJ-NP-Z2-9]{6}$/);
    for (let i = 0; i < 50; i++) {
      expect(generarCodigo()).not.toMatch(/[IO01]/);
      expect(codigoValido(generarCodigo())).toBe(true);
    }
  });
});

describe('la persona', () => {
  it('el mismo teléfono escrito de siete formas es la misma persona', () => {
    const formas = ['3517046684', '351 704 6684', '351-704-6684', '+54 9 351 704 6684',
      '549 351 7046684', '0351 15 704 6684', '(0351) 15-704-6684'];
    for (const f of formas) expect(telefonoClave(f), f).toBe('3517046684');
  });

  it('un teléfono corto se deja como está', () => {
    expect(telefonoClave('4567890')).toBe('4567890');
    expect(telefonoClave('')).toBe('');
  });
});

describe('sobre qué cae', () => {
  it('todo, unos productos o unos rubros', () => {
    expect(aplicaA(cupon(), LAPIZ)).toBe(true);
    expect(aplicaA(cupon({ aplica: { modo: 'productos', productos: ['resma'] } }), RESMA)).toBe(true);
    expect(aplicaA(cupon({ aplica: { modo: 'productos', productos: ['resma'] } }), LAPIZ)).toBe(false);
    expect(aplicaA(cupon({ aplica: { modo: 'rubros', rubros: ['Papelería'] } }), RESMA)).toBe(true);
    expect(aplicaA(cupon({ aplica: { modo: 'rubros', rubros: ['PAPELERIA'] } }), LAPIZ)).toBe(false);
  });

  it('el rubro se compara sin tildes ni mayúsculas', () => {
    expect(claveDeRubro('Librería')).toBe('LIBRERIA');
    expect(claveDeRubro(' papelería ')).toBe('PAPELERIA');
  });

  it('se describe como lo leería el cliente', () => {
    expect(describirAlcance(cupon())).toBe('todo el pedido');
    expect(describirAlcance(cupon({ aplica: { modo: 'rubros', rubros: ['LIBRERIA'] } }))).toBe('Libreria');
    expect(describirAlcance(cupon({ aplica: { modo: 'rubros', rubros: ['LIBRERIA', 'PAPELERIA', 'MERCERIA'] } })))
      .toBe('Libreria, Papeleria y Merceria');
    expect(describirAlcance(cupon({ aplica: { modo: 'productos', productos: ['a', 'b'] } }))).toBe('2 productos');
    expect(describirAlcance(cupon({ aplica: { modo: 'productos', productos: ['a'], etiqueta: 'Resma Pampa A4' } })))
      .toBe('Resma Pampa A4');
  });
});

describe('las fechas', () => {
  it('un día del panel vale entero, en hora de Argentina', () => {
    expect(limiteDeDia('2026-09-10').toISOString()).toBe('2026-09-10T03:00:00.000Z');
    expect(limiteDeDia('2026-09-10', true).toISOString()).toBe('2026-09-11T02:59:59.999Z');
    expect(limiteDeDia('')).toBeNull();
    expect(limiteDeDia('ayer')).toBeNull();
  });

  it('antes del "desde" no vale, y dice cuándo', () => {
    const r = evaluarCupon(cupon({ desde: '2026-09-11' }), pedido());
    expect(r).toMatchObject({ ok: false, motivo: 'todavia_no', desde: '2026-09-11' });
    expect(mensajeDeCupon(r)).toBe('Ese cupón vale a partir del 11/9.');
  });

  it('el último día vale hasta la medianoche de acá', () => {
    const c = cupon({ hasta: '2026-09-10' });
    expect(evaluarCupon(c, pedido({ ahora: new Date('2026-09-11T02:30:00Z') })).ok).toBe(true);
    expect(evaluarCupon(c, pedido({ ahora: new Date('2026-09-11T03:30:00Z') })).motivo).toBe('vencido');
  });
});

describe('la cuenta', () => {
  it('un porcentaje sobre todo el pedido', () => {
    const r = evaluarCupon(cupon(), pedido());
    expect(r.ok).toBe(true);
    expect(r.descuento).toBe(2115);   // 10% de 21.150
    expect(r.aplicable).toBe(21150);
    expect(r.renglones.reduce((t, x) => t + x.descuento, 0)).toBe(2115);
  });

  it('un porcentaje con tope no pasa del tope', () => {
    const r = evaluarCupon(cupon({ valor: 50, tope: 3000 }), pedido());
    expect(r.descuento).toBe(3000);
  });

  it('un monto fijo, y nunca más que lo que cuesta lo elegible', () => {
    expect(evaluarCupon(cupon({ tipo: 'monto', valor: 5000 }), pedido()).descuento).toBe(5000);
    const soloLapiz = cupon({ tipo: 'monto', valor: 5000, aplica: { modo: 'productos', productos: ['lapiz'] } });
    expect(evaluarCupon(soloLapiz, pedido()).descuento).toBe(2400);
  });

  it('con mínimo de compra dice cuánto falta', () => {
    const r = evaluarCupon(cupon({ tipo: 'monto', valor: 5000, minimo_compra: 25000 }), pedido());
    expect(r).toMatchObject({ ok: false, motivo: 'minimo', falta: 3850, minimo: 25000 });
    expect(mensajeDeCupon(r)).toBe('Te faltan $3.850 para usar este cupón: vale con compras desde $25.000.');
  });

  it('justo en el mínimo entra', () => {
    expect(evaluarCupon(cupon({ minimo_compra: 21150 }), pedido()).ok).toBe(true);
  });

  it('el mínimo se mide sobre los productos, no sobre el envío', () => {
    const r = evaluarCupon(cupon({ minimo_compra: 22000 }), pedido({ modo: 'delivery', envio: 3000 }));
    expect(r.motivo).toBe('minimo');
  });

  it('sobre unos rubros solo descuenta esos', () => {
    const r = evaluarCupon(cupon({ valor: 20, aplica: { modo: 'rubros', rubros: ['libreria', 'merceria'] } }), pedido());
    expect(r.aplicable).toBe(3150);
    expect(r.descuento).toBe(630);
    expect(r.renglones.map(x => x.id)).toEqual(['lapiz', 'cinta']);
  });

  it('sin nada de lo que cubre, avisa para qué es', () => {
    const r = evaluarCupon(cupon({ aplica: { modo: 'rubros', rubros: ['JUGUETERIA'] } }), pedido());
    expect(r).toMatchObject({ ok: false, motivo: 'sin_productos', alcance: 'Jugueteria' });
    expect(mensajeDeCupon(r)).toBe('Ese cupón es solo para Jugueteria y no tenés nada de eso en el pedido.');
  });

  it('el envío gratis descuenta el envío y deja la marca', () => {
    const r = evaluarCupon(cupon({ tipo: 'envio_gratis' }), pedido({ modo: 'delivery', envio: 2500 }));
    expect(r).toMatchObject({ ok: true, descuento: 2500, envio_gratis: true, renglones: [] });
  });

  it('el envío gratis con retiro no tiene sentido', () => {
    const r = evaluarCupon(cupon({ tipo: 'envio_gratis' }), pedido({ modo: 'retiro' }));
    expect(r.motivo).toBe('solo_delivery');
  });

  it('el envío gratis con el envío a confirmar entra con cero y la marca', () => {
    const r = evaluarCupon(cupon({ tipo: 'envio_gratis' }), pedido({ modo: 'delivery', envio: 0 }));
    expect(r).toMatchObject({ ok: true, descuento: 0, envio_gratis: true });
  });

  it('un porcentaje mayor a 100 o negativo no regala plata', () => {
    expect(evaluarCupon(cupon({ valor: 150 }), pedido()).descuento).toBe(21150);
    expect(evaluarCupon(cupon({ valor: -10 }), pedido()).motivo).toBe('sin_productos');
    expect(evaluarCupon(cupon({ tipo: 'monto', valor: -500 }), pedido()).motivo).toBe('sin_productos');
  });
});

describe('quién y cuántas veces', () => {
  it('apagado, agotado o ya usado', () => {
    expect(evaluarCupon(null, pedido()).motivo).toBe('no_existe');
    expect(evaluarCupon(cupon({ activo: false }), pedido()).motivo).toBe('inactivo');
    expect(evaluarCupon(cupon({ usos_totales: 100 }), pedido({ usosTotales: 100 })).motivo).toBe('agotado');
    expect(evaluarCupon(cupon({ usos_totales: 100 }), pedido({ usosTotales: 99 })).ok).toBe(true);
    const r = evaluarCupon(cupon({ usos_por_persona: 1 }), pedido({ usosPersona: 1 }));
    expect(r).toMatchObject({ motivo: 'ya_usado', veces: 1 });
    expect(mensajeDeCupon(r)).toBe('Ese cupón ya lo usaste, y vale una sola vez por persona.');
    expect(mensajeDeCupon(evaluarCupon(cupon({ usos_por_persona: 2 }), pedido({ usosPersona: 2 }))))
      .toBe('Ese cupón ya lo usaste 2 veces, que es el máximo por persona.');
  });

  it('solo primera compra: con historial no, sin saber sí', () => {
    expect(evaluarCupon(cupon({ solo_primera_compra: true }), pedido({ esPrimeraCompra: false })).motivo).toBe('primera_compra');
    expect(evaluarCupon(cupon({ solo_primera_compra: true }), pedido({ esPrimeraCompra: true })).ok).toBe(true);
    expect(evaluarCupon(cupon({ solo_primera_compra: true }), pedido({ esPrimeraCompra: null })).ok).toBe(true);
  });

  it('solo para una forma de entrega', () => {
    expect(evaluarCupon(cupon({ entrega: 'retiro' }), pedido({ modo: 'delivery' })).motivo).toBe('solo_retiro');
    expect(evaluarCupon(cupon({ entrega: 'delivery' }), pedido({ modo: 'retiro' })).motivo).toBe('solo_delivery');
    expect(evaluarCupon(cupon({ entrega: 'delivery' }), pedido({ modo: 'delivery' })).ok).toBe(true);
  });

  it('los usos de una persona se cuentan por teléfono o por cuenta, sin los cancelados', () => {
    const pedidos = [
      { estado: 'entregado', cliente: { telefono: '351 704 6684' }, cupon: { codigo: 'X' } },
      { estado: 'nuevo', cliente: { telefono: '+54 9 351 704-6684' }, cupon: { codigo: 'X' } },
      { estado: 'cancelado', cliente: { telefono: '3517046684' }, cupon: { codigo: 'X' } },
      { estado: 'nuevo', cliente: { telefono: '3510000000' }, uid: 'u1', cupon: { codigo: 'X' } },
    ];
    expect(usosDePersona(pedidos, { telefono: '3517046684' })).toBe(2);
    expect(usosDePersona(pedidos, { telefono: '3519999999', uid: 'u1' })).toBe(1);
    expect(usosDePersona(pedidos, { telefono: '', uid: null })).toBe(0);
  });
});

describe('el reparto entre renglones', () => {
  it('proporcional, con el resto en el último, y suma exacta', () => {
    const partes = repartir([RESMA, LAPIZ, CINTA], 2115);
    expect(partes.map(p => p.descuento)).toEqual([1800, 240, 75]);
    expect(partes.reduce((t, p) => t + p.descuento, 0)).toBe(2115);
    expect(partes[2]).toMatchObject({ id: 'cinta', variedad: 'Rojo', es_pack: false });
  });

  it('un peso entre tres renglones no se pierde', () => {
    const partes = repartir([{ id: 'a', subtotal: 100 }, { id: 'b', subtotal: 100 }, { id: 'c', subtotal: 100 }], 1);
    expect(partes.map(p => p.descuento)).toEqual([0, 0, 1]);
  });
});

describe('cómo se lee', () => {
  it('el cupón se describe corto', () => {
    expect(describirCupon(cupon())).toBe('10% de descuento');
    expect(describirCupon(cupon({ tope: 3000 }))).toBe('10% de descuento (hasta $3.000)');
    expect(describirCupon(cupon({ tipo: 'monto', valor: 5000 }))).toBe('$5.000 de descuento');
    expect(describirCupon(cupon({ tipo: 'envio_gratis' }))).toBe('Envío sin cargo');
  });

  it('"ya usado" dice las veces si las sabe, y nunca "null veces"', () => {
    // El servidor no siempre manda el número: en la segunda mirada de
    // crear-pedido llegaba null, y el cliente leía "ya lo usaste null veces".
    expect(mensajeDeCupon({ motivo: 'ya_usado', veces: 1 })).toContain('una sola vez');
    expect(mensajeDeCupon({ motivo: 'ya_usado', veces: 3 })).toContain('3 veces');
    for (const veces of [null, undefined, 'x', 0]) {
      const texto = mensajeDeCupon({ motivo: 'ya_usado', veces });
      expect(texto).toMatch(/ya lo usaste/);
      expect(texto).not.toMatch(/null|undefined|NaN|0 veces/);
    }
  });

  it('cada motivo tiene su frase, y lo desconocido no queda mudo', () => {
    for (const motivo of ['no_existe', 'inactivo', 'vencido', 'agotado', 'primera_compra', 'solo_retiro', 'solo_delivery']) {
      expect(mensajeDeCupon({ motivo }).length).toBeGreaterThan(10);
    }
    expect(mensajeDeCupon({ motivo: 'marciano' })).toContain('No pudimos');
  });
});

describe('el resumen para el panel', () => {
  it('pedidos, personas, plata y productos, sin contar los cancelados', () => {
    const pedidos = [
      { id: 'a', estado: 'entregado', total: 20000, cliente: { telefono: '3517046684' },
        cupon: { codigo: 'X', descuento: 2000, renglones: [{ id: 'resma', variedad: null, es_pack: false, descuento: 2000 }] },
        items: [{ id: 'resma', nombre: 'Resma', cantidad: 1 }] },
      { id: 'b', estado: 'nuevo', total: 5000, cliente: { telefono: '351 704 6684' },
        cupon: { codigo: 'X', descuento: 500, renglones: [{ id: 'lapiz', variedad: null, es_pack: false, descuento: 500 }] },
        items: [{ id: 'lapiz', nombre: 'Lápiz', cantidad: 3 }, { id: 'resma', nombre: 'Resma', cantidad: 1 }] },
      { id: 'c', estado: 'cancelado', total: 9000, cliente: { telefono: '3510000000' },
        cupon: { codigo: 'X', descuento: 900 }, items: [{ id: 'resma', nombre: 'Resma', cantidad: 1 }] },
      { id: 'd', estado: 'nuevo', total: 9000, cliente: { telefono: '3510000001' },
        cupon: { codigo: 'OTRO', descuento: 900 }, items: [] },
    ];
    const r = resumenDeUsos(pedidos, 'X');
    expect(r.usos).toBe(2);
    expect(r.cancelados).toBe(1);
    expect(r.personas).toBe(1);
    expect(r.descontado).toBe(2500);
    expect(r.vendido).toBe(25000);
    expect(r.productos[0]).toMatchObject({ id: 'resma', pedidos: 2, cantidad: 2, descuento: 2000 });
    expect(r.productos[1]).toMatchObject({ id: 'lapiz', pedidos: 1, cantidad: 3, descuento: 500 });
  });
});
