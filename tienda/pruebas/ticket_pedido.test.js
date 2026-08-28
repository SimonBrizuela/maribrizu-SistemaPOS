/**
 * El ticket del pedido de la tienda.
 *
 * Es el papel que se lleva quien arma el pedido por el local y el que va con el
 * reparto. Lo que dice ahí es lo que se junta y lo que se cobra: si falta un
 * renglón o el total no es el del pedido, el error sale por la puerta.
 *
 * Se prueba el HTML, que es lo que `imprimirPedido` manda a la ventana.
 */
import { describe, it, expect } from 'vitest';

import { ticketHtml } from '../../webapp/src/ticket_pedido.js';

const CFG = { nombre: 'Librería Liceo', direccion: 'Av. Alfonsina Storni 168',
              telefono: '351 704 6684' };

const pedido = (extra = {}) => ({
  id: 'abc123',
  codigo: 'K7M2',
  creado: new Date('2026-08-28T18:15:00Z'),
  cliente: { nombre: 'Marta Gómez', telefono: '351 704 6684' },
  entrega: { modo: 'retiro' },
  pago: { modo: 'efectivo' },
  items: [
    { nombre: 'Cuaderno Rivadavia', cantidad: 2, precio: 3000, subtotal: 6000 },
    { nombre: 'Cinta Raso', cantidad: 2.5, precio: 300, subtotal: 750, unidad: 'metro' },
  ],
  subtotal: 6750, envio: 0, total: 6750,
  ...extra,
});

describe('lo que hay que juntar', () => {
  it('están todos los renglones con su cantidad', () => {
    const t = ticketHtml(pedido(), CFG);
    expect(t).toContain('Cuaderno Rivadavia');
    expect(t).toContain('Cinta Raso');
    expect(t).toContain('>2<');        // dos cuadernos
    expect(t).toContain('2,5 m');      // dos metros y medio de cinta
  });

  it('la variedad y el pack se aclaran debajo del nombre', () => {
    const t = ticketHtml(pedido({ items: [
      { nombre: 'Cartulina', cantidad: 1, precio: 900, subtotal: 900, variedad: 'Celeste' },
      { nombre: 'Resma', cantidad: 1, precio: 7800, subtotal: 7800, es_pack: true, pack_contenido: 500 },
    ] }), CFG);
    expect(t).toContain('Celeste');
    expect(t).toContain('pack de 500');
  });

  it('el código se imprime grande: es lo que se dicta por teléfono', () => {
    const t = ticketHtml(pedido(), CFG);
    expect(t).toContain('K7M2');
    expect(t).toMatch(/class="codigo">K7M2/);
  });
});

describe('para quién es y a dónde va', () => {
  it('retiro en el local', () => {
    const t = ticketHtml(pedido(), CFG);
    expect(t).toContain('Marta Gómez');
    expect(t).toContain('Retira en el local');
    expect(t).toContain('sin cargo');
  });

  it('envío a domicilio con la dirección y la referencia', () => {
    const t = ticketHtml(pedido({
      entrega: { modo: 'delivery', direccion: 'Av. Colón 1234',
                 referencia: 'Piso 2 depto B', distancia_km: 4.2 },
      envio: 2500, total: 9250,
    }), CFG);
    expect(t).toContain('Envío a domicilio');
    expect(t).toContain('Av. Colón 1234');
    expect(t).toContain('Piso 2 depto B');
    expect(t).toContain('4,2 km');
  });

  it('cuando el envío no está cerrado, lo dice y pide confirmarlo', () => {
    const t = ticketHtml(pedido({
      entrega: { modo: 'delivery', direccion: 'Av. Colón 1234', envio_a_confirmar: true },
    }), CFG);
    expect(t).toContain('a confirmar');
    expect(t).toContain('Confirmar el envío antes de salir');
  });

  it('sin nombre ni teléfono no se imprime un hueco', () => {
    const t = ticketHtml(pedido({ cliente: {} }), CFG);
    expect(t).toContain('Sin nombre');
    expect(t).toContain('sin teléfono');
  });
});

describe('cuánto se cobra', () => {
  it('el total es el del pedido', () => {
    const t = ticketHtml(pedido({ subtotal: 6750, envio: 2500, total: 9250,
                                  entrega: { modo: 'delivery', direccion: 'X' } }), CFG);
    expect(t).toContain('9.250');
    expect(t).toContain('6.750');
    expect(t).toContain('2.500');
  });

  it('dice con qué paga', () => {
    expect(ticketHtml(pedido(), CFG)).toContain('efectivo');
    expect(ticketHtml(pedido({ pago: { modo: 'transferencia' } }), CFG))
      .toContain('transferencia');
  });

  it('un renglón sin subtotal se calcula del precio por la cantidad', () => {
    const t = ticketHtml(pedido({ items: [
      { nombre: 'Goma', cantidad: 3, precio: 500 },
    ] }), CFG);
    expect(t).toContain('1.500');
  });

  it('la nota del cliente se imprime', () => {
    expect(ticketHtml(pedido({ nota: 'Si no hay del azul, mandame del negro.' }), CFG))
      .toContain('Si no hay del azul');
  });
});

describe('lo que no puede romper el papel', () => {
  it('un nombre con comillas o signos no rompe el HTML', () => {
    const t = ticketHtml(pedido({
      cliente: { nombre: 'Marta "La Colo" <Gómez> & Cía', telefono: '1' },
    }), CFG);
    expect(t).toContain('&quot;La Colo&quot;');
    expect(t).toContain('&lt;Gómez&gt;');
    expect(t).toContain('&amp;');
    expect(t).not.toContain('<Gómez>');
  });

  it('un pedido sin items sigue imprimiendo el código y el cliente', () => {
    const t = ticketHtml(pedido({ items: [], subtotal: 0, total: 0 }), CFG);
    expect(t).toContain('K7M2');
    expect(t).toContain('Marta Gómez');
  });

  it('sin código se imprime una raya y no "undefined"', () => {
    const t = ticketHtml(pedido({ codigo: null }), CFG);
    expect(t).not.toContain('undefined');
    expect(t).toContain('—');
  });

  it('sin configuración del local usa el nombre por defecto', () => {
    expect(ticketHtml(pedido(), {})).toContain('Librería Liceo');
  });
});
