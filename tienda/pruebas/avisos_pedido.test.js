/**
 * El aviso de WhatsApp al cliente.
 *
 * Es la parte del tablero que se puede romper sin que nadie lo note: un número
 * mal armado abre WhatsApp con un contacto que no existe, y el local se entera
 * cuando el cliente llama preguntando por qué no le avisaron.
 */
import { describe, it, expect } from 'vitest';
import { whatsappDe, mensajeDe, enlaceAviso, nombreCorto }
  from '../../webapp/src/avisos_pedido.js';

const pedido = (extra = {}) => ({
  codigo: 'P5HE',
  estado: 'en_camino',
  cliente: { nombre: 'María Fernanda Gómez', telefono: '3517046684' },
  entrega: { modo: 'delivery' },
  ...extra,
});

describe('el número para WhatsApp', () => {
  it('agrega el 549 a un número escrito como lo escribe la gente', () => {
    expect(whatsappDe(pedido())).toBe('5493517046684');
  });

  it('aguanta espacios, guiones y paréntesis', () => {
    expect(whatsappDe(pedido({ cliente: { telefono: '(0351) 704-6684' } })))
      .toBe('5493517046684');
  });

  it('saca el cero de adelante', () => {
    expect(whatsappDe(pedido({ cliente: { telefono: '03517046684' } })))
      .toBe('5493517046684');
  });

  it('respeta el que ya viene con código de país y el 9', () => {
    expect(whatsappDe(pedido({ cliente: { telefono: '+54 9 351 704 6684' } })))
      .toBe('5493517046684');
  });

  it('le pone el 9 al que vino con 54 pero sin él', () => {
    // Salió de un pedido real: el cliente copió su número de un contacto y
    // quedó +543516194411, que no resuelve a ningún celular en WhatsApp.
    expect(whatsappDe(pedido({ cliente: { telefono: '+543516194411' } })))
      .toBe('5493516194411');
  });

  it('saca el 15 de las agendas viejas', () => {
    expect(whatsappDe(pedido({ cliente: { telefono: '0351 15 619-4411' } })))
      .toBe('5493516194411');
  });

  it('sin teléfono no inventa uno', () => {
    expect(whatsappDe(pedido({ cliente: { telefono: '' } }))).toBeNull();
    expect(whatsappDe(pedido({ cliente: { telefono: '351' } }))).toBeNull();
    expect(whatsappDe({})).toBeNull();
  });
});

describe('el mensaje', () => {
  it('saluda con el primer nombre y nada más', () => {
    expect(nombreCorto(pedido())).toBe('María');
    expect(mensajeDe(pedido())).toContain('Hola María,');
    expect(mensajeDe(pedido())).not.toContain('Fernanda');
  });

  it('dice en qué anda el pedido', () => {
    expect(mensajeDe(pedido({ estado: 'preparando' }))).toContain('estamos preparando');
    expect(mensajeDe(pedido({ estado: 'en_camino' }))).toContain('salió para tu casa');
    expect(mensajeDe(pedido({ estado: 'entregado' }))).toContain('gracias por tu compra');
    expect(mensajeDe(pedido({ estado: 'cancelado' }))).toContain('cancelar tu pedido');
  });

  it('el "listo" cambia según cómo lo recibe', () => {
    const retira = mensajeDe(
      pedido({ estado: 'listo', entrega: { modo: 'retiro' } }),
      { direccionLocal: 'Av. Alfonsina Storni 168' });
    expect(retira).toContain('para que lo retires');
    expect(retira).toContain('Av. Alfonsina Storni 168');

    const envio = mensajeDe(pedido({ estado: 'listo' }));
    expect(envio).toContain('sale para tu casa');
    expect(envio).not.toContain('retires');
  });

  it('sin dirección del local no queda una frase colgada', () => {
    const retira = mensajeDe(pedido({ estado: 'listo', entrega: { modo: 'retiro' } }));
    expect(retira).not.toContain('Te esperamos en .');
    expect(retira.trim().endsWith('retires.')).toBe(true);
  });

  it('lleva el código, que es lo que el cliente dice por teléfono', () => {
    expect(mensajeDe(pedido())).toContain('P5HE');
  });
});

describe('el enlace', () => {
  it('arma la dirección de WhatsApp con el texto adentro', () => {
    const url = enlaceAviso(pedido());
    expect(url.startsWith('https://wa.me/5493517046684?text=')).toBe(true);
    expect(decodeURIComponent(url.split('text=')[1])).toContain('salió para tu casa');
  });

  it('un estado sin mensaje no genera enlace', () => {
    // "nuevo" no se avisa: el cliente acaba de hacer el pedido y ya vio la
    // pantalla de confirmación.
    expect(enlaceAviso(pedido({ estado: 'nuevo' }))).toBeNull();
  });

  it('sin teléfono no genera enlace', () => {
    expect(enlaceAviso(pedido({ cliente: { nombre: 'Ana', telefono: '' } }))).toBeNull();
  });
});
