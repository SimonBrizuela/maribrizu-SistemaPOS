/**
 * Las reglas del reparto: qué puede hacer el repartidor con cada pedido, en qué
 * orden conviene llevarlos y cómo se arma el viaje en Google Maps.
 *
 * Las usan la pantalla del repartidor y la función `reparto-mover`, que las
 * vuelve a aplicar: lo que llega al servidor lo puede haber armado cualquiera
 * que tenga el link.
 */
import { describe, it, expect } from 'vitest';
import {
  ESTADOS_EN_CURSO, siguientePaso, validarMovimiento, distanciaKm, ordenarRuta,
  paraLlevar, enPreparacion, enlaceNavegar, enlaceRuta, cobroDe, diaArgentina, resumenDelDia,
} from '../src/reparto.js';

const LOCAL = { lat: -31.3540, lng: -64.1730 };

const pedido = (extra = {}) => ({
  id: 'p1', codigo: 'K7M2', estado: 'listo', creado: '2026-09-15T15:00:00Z',
  cliente: { nombre: 'Marta', telefono: '3515550001' },
  entrega: { modo: 'delivery', direccion: 'Colón 1200', coordenadas: { lat: -31.40, lng: -64.20 } },
  pago: { modo: 'efectivo', pagado: false }, total: 12500,
  ...extra,
});

describe('los pasos', () => {
  it('cada estado tiene el botón del siguiente', () => {
    expect(siguientePaso(pedido({ estado: 'nuevo' }))).toMatchObject({ estado: 'preparando' });
    expect(siguientePaso(pedido({ estado: 'preparando' }))).toMatchObject({ estado: 'listo' });
    expect(siguientePaso(pedido({ estado: 'listo' }))).toMatchObject({ estado: 'en_camino' });
    expect(siguientePaso(pedido({ estado: 'en_camino' }))).toMatchObject({ estado: 'entregado' });
    expect(siguientePaso(pedido({ estado: 'entregado' }))).toBeNull();
    expect(siguientePaso(pedido({ estado: 'cancelado' }))).toBeNull();
  });

  it('los en curso son los que todavía no se entregaron ni cancelaron', () => {
    expect(ESTADOS_EN_CURSO).toEqual(['nuevo', 'preparando', 'listo', 'en_camino']);
  });
});

describe('validarMovimiento', () => {
  it('para adelante, sí; y puede saltear pasos (lo entregó sin marcar que salió)', () => {
    expect(validarMovimiento(pedido({ estado: 'listo' }), 'en_camino')).toBeNull();
    expect(validarMovimiento(pedido({ estado: 'listo' }), 'entregado')).toBeNull();
    expect(validarMovimiento(pedido({ estado: 'nuevo' }), 'preparando')).toBeNull();
  });

  it('para atrás, no: eso se corrige desde el panel', () => {
    expect(validarMovimiento(pedido({ estado: 'en_camino' }), 'listo')).toBe('hacia_atras');
    expect(validarMovimiento(pedido({ estado: 'listo' }), 'listo')).toBe('hacia_atras');
  });

  it('un pedido terminado no se mueve', () => {
    expect(validarMovimiento(pedido({ estado: 'entregado' }), 'entregado')).toBe('terminado');
    expect(validarMovimiento(pedido({ estado: 'cancelado' }), 'preparando')).toBe('terminado');
  });

  it('solo pedidos con envío: el que retira no pasa por el repartidor', () => {
    expect(validarMovimiento(pedido({ entrega: { modo: 'retiro' } }), 'preparando')).toBe('no_es_envio');
  });

  it('un estado que no existe, o cancelar, no', () => {
    expect(validarMovimiento(pedido(), 'volando')).toBe('estado_invalido');
    expect(validarMovimiento(pedido(), 'cancelado')).toBe('estado_invalido');
  });
});

describe('distancias y ruta', () => {
  it('distancia en línea recta, en km', () => {
    // Plaza San Martín a Patio Olmos, Córdoba: unos 800 m.
    const d = distanciaKm({ lat: -31.4167, lng: -64.1839 }, { lat: -31.4219, lng: -64.1889 });
    expect(d).toBeGreaterThan(0.6);
    expect(d).toBeLessThan(0.9);
    expect(distanciaKm(LOCAL, LOCAL)).toBe(0);
  });

  it('ordena de a una: siempre el más cercano al punto anterior', () => {
    const cerca = pedido({ id: 'cerca', entrega: { modo: 'delivery', coordenadas: { lat: -31.356, lng: -64.175 } } });
    const medio = pedido({ id: 'medio', entrega: { modo: 'delivery', coordenadas: { lat: -31.370, lng: -64.190 } } });
    const lejos = pedido({ id: 'lejos', entrega: { modo: 'delivery', coordenadas: { lat: -31.450, lng: -64.250 } } });
    const ruta = ordenarRuta([lejos, cerca, medio], LOCAL);
    expect(ruta.map(p => p.pedido.id)).toEqual(['cerca', 'medio', 'lejos']);
    expect(ruta[0].km).toBeLessThan(ruta[1].km + ruta[0].km);
    expect(ruta[0].kmDesdeAnterior).toBeCloseTo(distanciaKm(LOCAL, cerca.entrega.coordenadas), 5);
  });

  it('sin posición, arranca desde el primero que entró', () => {
    const a = pedido({ id: 'a', creado: '2026-09-15T15:00:00Z' });
    const b = pedido({ id: 'b', creado: '2026-09-15T14:00:00Z', entrega: { modo: 'delivery', coordenadas: { lat: -31.5, lng: -64.3 } } });
    expect(ordenarRuta([a, b], null)[0].pedido.id).toBe('b');
  });

  it('los que no tienen coordenadas van al final, en el orden en que entraron', () => {
    const con = pedido({ id: 'con' });
    const sin1 = pedido({ id: 'sin1', creado: '2026-09-15T10:00:00Z', entrega: { modo: 'delivery', direccion: 'Sin mapa 1' } });
    const sin2 = pedido({ id: 'sin2', creado: '2026-09-15T11:00:00Z', entrega: { modo: 'delivery', direccion: 'Sin mapa 2' } });
    const ruta = ordenarRuta([sin2, con, sin1], LOCAL);
    expect(ruta.map(p => p.pedido.id)).toEqual(['con', 'sin1', 'sin2']);
    expect(ruta[1].km).toBeNull();
  });

  it('para llevar: listos y en camino; en preparación: nuevos y preparando', () => {
    const lista = ['nuevo', 'preparando', 'listo', 'en_camino', 'entregado'].map(estado => pedido({ id: estado, estado }));
    expect(paraLlevar(lista).map(p => p.id)).toEqual(['listo', 'en_camino']);
    expect(enPreparacion(lista).map(p => p.id)).toEqual(['nuevo', 'preparando']);
  });
});

describe('Google Maps', () => {
  it('navegar a un pedido: el viaje sale desde donde está el celular', () => {
    const url = new URL(enlaceNavegar(pedido()));
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/dir/');
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('destination')).toBe('-31.4,-64.2');
    expect(url.searchParams.get('origin')).toBeNull();
    expect(url.searchParams.get('travelmode')).toBe('driving');
  });

  it('sin coordenadas navega por la dirección escrita, con la ciudad', () => {
    const url = new URL(enlaceNavegar(pedido({ entrega: { modo: 'delivery', direccion: 'Colón 1200', referencia: 'timbre 2' } })));
    expect(url.searchParams.get('destination')).toBe('Colón 1200, Córdoba, Argentina');
  });

  it('la ruta con todos: el último es el destino y los demás, paradas en orden', () => {
    const a = pedido({ id: 'a', entrega: { modo: 'delivery', coordenadas: { lat: -31.1, lng: -64.1 } } });
    const b = pedido({ id: 'b', entrega: { modo: 'delivery', coordenadas: { lat: -31.2, lng: -64.2 } } });
    const c = pedido({ id: 'c', entrega: { modo: 'delivery', coordenadas: { lat: -31.3, lng: -64.3 } } });
    const url = new URL(enlaceRuta([a, b, c]));
    expect(url.searchParams.get('destination')).toBe('-31.3,-64.3');
    expect(url.searchParams.get('waypoints')).toBe('-31.1,-64.1|-31.2,-64.2');
  });

  it('con una sola parada la ruta es navegar a esa', () => {
    expect(enlaceRuta([pedido()])).toBe(enlaceNavegar(pedido()));
    expect(enlaceRuta([])).toBeNull();
  });
});

describe('cobro', () => {
  it('efectivo: cuánto cobrar', () => {
    expect(cobroDe(pedido())).toEqual({ efectivo: true, monto: 12500, pagado: false, texto: 'Cobrar $12.500 en efectivo' });
  });

  it('efectivo ya cobrado', () => {
    expect(cobroDe(pedido({ pago: { modo: 'efectivo', pagado: true } })).texto).toBe('Cobrado en efectivo');
  });

  it('transferencia: pagado o a confirmar con el local', () => {
    expect(cobroDe(pedido({ pago: { modo: 'transferencia', pagado: true } })).texto).toBe('Pagó por transferencia');
    expect(cobroDe(pedido({ pago: { modo: 'transferencia', pagado: false } })).texto).toBe('Transferencia sin confirmar: consultá al local');
  });

  it('con el envío a confirmar lo avisa: el total todavía puede cambiar', () => {
    const c = cobroDe(pedido({ entrega: { modo: 'delivery', envio_a_confirmar: true } }));
    expect(c.texto).toMatch(/envío a confirmar/);
  });
});

describe('el día', () => {
  it('la fecha de Argentina, aunque en UTC ya sea mañana', () => {
    expect(diaArgentina(new Date('2026-09-16T02:30:00Z'))).toBe('2026-09-15');
    expect(diaArgentina(new Date('2026-09-16T03:30:00Z'))).toBe('2026-09-16');
  });

  it('resumen de lo entregado: cuántos y cuánto en efectivo', () => {
    const entregados = [
      pedido({ estado: 'entregado', total: 1000, pago: { modo: 'efectivo', pagado: true } }),
      pedido({ estado: 'entregado', total: 2500, pago: { modo: 'efectivo', pagado: true } }),
      pedido({ estado: 'entregado', total: 9000, pago: { modo: 'transferencia', pagado: true } }),
    ];
    expect(resumenDelDia(entregados)).toEqual({ entregados: 3, efectivo: 3500 });
  });
});
