/**
 * Las reglas de los reclamos, las mismas en el formulario y en el servidor.
 *
 * El formulario las usa para decir qué falta antes de mandar; la función
 * `crear-reclamo` las vuelve a aplicar, porque lo que llega al servidor lo
 * puede haber armado cualquiera.
 */
import { describe, it, expect } from 'vitest';
import {
  MOTIVOS, LIMITES, motivosPara, puedeReclamar, validarReclamo, resumenDelReclamo, estadoLegible,
} from '../src/reclamos.js';

const HOY = new Date('2026-09-15T15:00:00Z');
const hace = (dias) => new Date(HOY.getTime() - dias * 86400000).toISOString();

const pedido = (extra = {}) => ({
  id: 'Ab12Cd34Ef56Gh78Ij90', codigo: 'K7M2', estado: 'entregado',
  entrega: { modo: 'delivery' }, creado: hace(3), entregado_en: hace(2),
  items: [{ id: 'p1', nombre: 'Resma' }, { id: 'p2', nombre: 'Cartulina', variedad: 'Rojo' }],
  ...extra,
});

describe('motivos', () => {
  it('los de productos piden elegir cuál', () => {
    expect(MOTIVOS.find(m => m.clave === 'roto').conProductos).toBe(true);
    expect(MOTIVOS.find(m => m.clave === 'cobro').conProductos).toBe(false);
  });

  it('"no me llegó" solo para lo que se manda: el que retira no espera un reparto', () => {
    expect(motivosPara(pedido()).map(m => m.clave)).toContain('no_llego');
    expect(motivosPara(pedido({ entrega: { modo: 'retiro' } })).map(m => m.clave)).not.toContain('no_llego');
  });
});

describe('puedeReclamar', () => {
  it('un pedido entregado hace poco, sí', () => {
    expect(puedeReclamar(pedido(), HOY)).toEqual({ puede: true, motivo: null });
  });

  it('uno recién entrado o cancelado, no: todavía no hay nada que reclamar', () => {
    expect(puedeReclamar(pedido({ estado: 'nuevo' }), HOY).motivo).toBe('estado');
    expect(puedeReclamar(pedido({ estado: 'cancelado' }), HOY).motivo).toBe('estado');
  });

  it('en camino, sí: "no me llegó" se reclama justamente antes de entregarse', () => {
    expect(puedeReclamar(pedido({ estado: 'en_camino' }), HOY).puede).toBe(true);
  });

  it(`pasados ${LIMITES.diasParaReclamar} días de entregado, no`, () => {
    expect(puedeReclamar(pedido({ entregado_en: hace(LIMITES.diasParaReclamar + 1) }), HOY).motivo).toBe('plazo');
    expect(puedeReclamar(pedido({ entregado_en: hace(LIMITES.diasParaReclamar - 1) }), HOY).puede).toBe(true);
  });

  it('sin fecha de entrega se cuenta desde que entró', () => {
    expect(puedeReclamar(pedido({ entregado_en: null, creado: hace(45) }), HOY).motivo).toBe('plazo');
  });

  it('entiende la fecha como Timestamp de Firestore', () => {
    const marca = { toDate: () => new Date(hace(1)) };
    expect(puedeReclamar(pedido({ entregado_en: marca }), HOY).puede).toBe(true);
  });

  it('con un reclamo abierto no se abre otro; con uno resuelto, sí', () => {
    expect(puedeReclamar(pedido({ reclamo: { estado: 'revisando' } }), HOY).motivo).toBe('abierto');
    expect(puedeReclamar(pedido({ reclamo: { estado: 'resuelto' } }), HOY).puede).toBe(true);
  });
});

describe('validarReclamo', () => {
  const bueno = { motivo: 'roto', items: ['p1'], detalle: 'La resma llegó mojada en una esquina.', fotos: [] };

  it('uno completo pasa', () => {
    expect(validarReclamo(bueno, pedido())).toBeNull();
  });

  it('sin motivo, o con uno que no existe, no', () => {
    expect(validarReclamo({ ...bueno, motivo: '' }, pedido()).campo).toBe('motivo');
    expect(validarReclamo({ ...bueno, motivo: 'hackeo' }, pedido()).campo).toBe('motivo');
  });

  it('"no me llegó" en un pedido de retiro, no', () => {
    expect(validarReclamo({ ...bueno, motivo: 'no_llego', items: [] }, pedido({ entrega: { modo: 'retiro' } })).campo)
      .toBe('motivo');
  });

  it('un motivo de productos pide al menos uno, y del pedido', () => {
    expect(validarReclamo({ ...bueno, items: [] }, pedido()).campo).toBe('items');
    expect(validarReclamo({ ...bueno, items: ['p9'] }, pedido()).campo).toBe('items');
  });

  it('un motivo sin productos no los pide', () => {
    expect(validarReclamo({ ...bueno, motivo: 'cobro', items: [] }, pedido())).toBeNull();
  });

  it(`el detalle va de ${LIMITES.detalleMin} a ${LIMITES.detalleMax} letras`, () => {
    expect(validarReclamo({ ...bueno, detalle: 'mal' }, pedido()).campo).toBe('detalle');
    expect(validarReclamo({ ...bueno, detalle: 'x'.repeat(LIMITES.detalleMax + 1) }, pedido()).campo).toBe('detalle');
    expect(validarReclamo({ ...bueno, detalle: '   ' + 'x'.repeat(LIMITES.detalleMin) + '   ' }, pedido())).toBeNull();
  });

  it(`hasta ${LIMITES.fotos} fotos`, () => {
    expect(validarReclamo({ ...bueno, fotos: [1, 2, 3] }, pedido())).toBeNull();
    expect(validarReclamo({ ...bueno, fotos: [1, 2, 3, 4] }, pedido()).campo).toBe('fotos');
  });

  it('cada problema lo dice en palabras del cliente', () => {
    const error = validarReclamo({ ...bueno, items: [] }, pedido());
    expect(error.mensaje).toMatch(/producto/i);
  });
});

describe('resumen y estados', () => {
  it('el resumen para el pedido lleva lo que ve el cliente y nada de sus fotos ni su detalle', () => {
    const resumen = resumenDelReclamo({
      id: 'x-1', estado: 'resuelto', motivo: 'roto', respuesta: 'Te la cambiamos.',
      detalle: 'secreto', fotos: ['https://f'], creado: HOY, actualizado: HOY,
    });
    expect(resumen).toEqual({
      id: 'x-1', estado: 'resuelto', motivo: 'roto', respuesta: 'Te la cambiamos.', creado: HOY, actualizado: HOY,
    });
  });

  it('cada estado se lee para el cliente', () => {
    expect(estadoLegible('nuevo')).toBe('Recibido');
    expect(estadoLegible('revisando')).toBe('Lo estamos revisando');
    expect(estadoLegible('resuelto')).toBe('Resuelto');
    expect(estadoLegible('rechazado')).toBe('Revisado');
  });
});
