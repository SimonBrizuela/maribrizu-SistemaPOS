/**
 * Lo que dice la notificación del celular en cada paso del pedido.
 *
 * Es lo único que el cliente lee de la tienda sin estar en la tienda, así que
 * tiene que decir lo mismo que la pantalla del pedido y en el mismo tono. Todas
 * las de un pedido llevan la misma etiqueta: la nueva reemplaza a la anterior y
 * en el celular queda una sola, que va avanzando, en vez de una pila.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { avisoDeEstado, avisoDeReclamo, pasosDeAviso, imagenesDeAvisos } from '../src/avisos_estado.js';

const retiro = (estado, extra = {}) => ({
  id: 'abc123', codigo: 'K7M2', estado, entrega: { modo: 'retiro' }, pago: { modo: 'efectivo' }, ...extra,
});
const envio = (estado, extra = {}) => retiro(estado, { entrega: { modo: 'delivery' }, ...extra });
const LOCAL = { direccionLocal: 'Av. Alfonsina Storni 168' };

describe('avisoDeEstado', () => {
  it('recién entrado no avisa: el cliente acaba de verlo en la pantalla', () => {
    expect(avisoDeEstado(retiro('nuevo'), LOCAL)).toBeNull();
  });

  it('un estado que no conoce no inventa un aviso', () => {
    expect(avisoDeEstado(retiro('perdido'), LOCAL)).toBeNull();
    expect(avisoDeEstado(null, LOCAL)).toBeNull();
  });

  it('preparando lleva el código', () => {
    const a = avisoDeEstado(retiro('preparando'), LOCAL);
    expect(a.titulo).toContain('K7M2');
    expect(a.cuerpo.length).toBeGreaterThan(0);
  });

  it('listo para retirar dice dónde', () => {
    const a = avisoDeEstado(retiro('listo'), LOCAL);
    expect(a.titulo).toContain('listo');
    expect(a.cuerpo).toContain('Av. Alfonsina Storni 168');
  });

  it('listo con envío dice que sale con el reparto, no que lo busque', () => {
    const a = avisoDeEstado(envio('listo'), LOCAL);
    expect(a.cuerpo).toMatch(/reparto/);
    expect(a.cuerpo).not.toContain('Alfonsina');
  });

  it('en camino recuerda el efectivo solo si paga en efectivo', () => {
    expect(avisoDeEstado(envio('en_camino'), LOCAL).cuerpo).toMatch(/efectivo/);
    expect(avisoDeEstado(envio('en_camino', { pago: { modo: 'transferencia' } }), LOCAL).cuerpo)
      .not.toMatch(/efectivo/);
  });

  it('entregado y cancelado también avisan', () => {
    expect(avisoDeEstado(retiro('entregado'), LOCAL).titulo).toContain('K7M2');
    expect(avisoDeEstado(retiro('cancelado'), LOCAL).titulo).toMatch(/[Cc]ancel/);
  });

  it('todas las de un pedido llevan la misma etiqueta y abren su pantalla', () => {
    const etiquetas = ['preparando', 'listo', 'entregado'].map(e => avisoDeEstado(retiro(e), LOCAL).tag);
    expect(new Set(etiquetas).size).toBe(1);
    expect(avisoDeEstado(retiro('listo'), LOCAL).url).toBe('/pedido/abc123');
  });

  it('la imagen muestra el paso del recorrido que corresponde a cómo lo recibe', () => {
    expect(avisoDeEstado(retiro('listo'), LOCAL).imagen).toBe('/avisos/retiro-listo.png');
    expect(avisoDeEstado(envio('en_camino'), LOCAL).imagen).toBe('/avisos/envio-en_camino.png');
    expect(avisoDeEstado(retiro('cancelado'), LOCAL).imagen).toBeNull();
  });

  it('ningún texto se pasa de lo que el celular muestra entero', () => {
    for (const e of ['preparando', 'listo', 'en_camino', 'entregado', 'cancelado']) {
      const a = avisoDeEstado(envio(e, { codigo: 'ZZZZ' }), LOCAL);
      expect(a.titulo.length).toBeLessThanOrEqual(60);
      expect(a.cuerpo.length).toBeLessThanOrEqual(160);
    }
  });
});

describe('las imágenes del recorrido', () => {
  it('retiro tiene cuatro pasos y envío cinco', () => {
    expect(pasosDeAviso('retiro').map(p => p.clave)).toEqual(['nuevo', 'preparando', 'listo', 'entregado']);
    expect(pasosDeAviso('envio').map(p => p.clave)).toEqual(['nuevo', 'preparando', 'listo', 'en_camino', 'entregado']);
  });

  it('cada imagen que se nombra existe en la carpeta pública', () => {
    const publica = path.resolve(import.meta.dirname, '..', 'public');
    for (const ruta of imagenesDeAvisos()) {
      expect(fs.existsSync(path.join(publica, ruta)), `falta ${ruta}`).toBe(true);
    }
  });
});

describe('avisoDeReclamo', () => {
  const pedido = retiro('entregado');

  it('revisando avisa que se está mirando', () => {
    const a = avisoDeReclamo(pedido, { estado: 'revisando' });
    expect(a.titulo).toContain('K7M2');
    expect(a.url).toBe('/pedido/abc123');
  });

  it('resuelto lleva la respuesta del local, recortada', () => {
    const a = avisoDeReclamo(pedido, { estado: 'resuelto', respuesta: 'Te mandamos otra resma sin cargo mañana a la mañana. '.repeat(6) });
    expect(a.cuerpo.startsWith('Te mandamos otra resma')).toBe(true);
    expect(a.cuerpo.length).toBeLessThanOrEqual(160);
  });

  it('va con su propia etiqueta: no reemplaza el aviso del pedido', () => {
    expect(avisoDeReclamo(pedido, { estado: 'resuelto' }).tag)
      .not.toBe(avisoDeEstado(retiro('listo'), LOCAL).tag);
  });

  it('un reclamo recién creado no avisa', () => {
    expect(avisoDeReclamo(pedido, { estado: 'nuevo' })).toBeNull();
  });
});
