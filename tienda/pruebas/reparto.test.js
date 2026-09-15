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
  ESTADOS_EN_CURSO, siguientePaso, validarMovimiento, yaLlego, distanciaKm, ordenarRuta,
  paraLlevar, enPreparacion, enlaceNavegar, enlaceRuta, cobroDe, diaArgentina, resumenDelDia,
  PERIODOS_HISTORIAL, diasDelPeriodo, tandas, resumenHistorial, etiquetaDia,
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

describe('yaLlego', () => {
  it('el pedido ya está en ese paso o más adelante', () => {
    expect(yaLlego(pedido({ estado: 'en_camino' }), 'en_camino')).toBe(true);
    expect(yaLlego(pedido({ estado: 'entregado' }), 'en_camino')).toBe(true);
    expect(yaLlego(pedido({ estado: 'entregado' }), 'entregado')).toBe(true);
  });

  it('todavía no llegó, o lo cancelaron: no', () => {
    expect(yaLlego(pedido({ estado: 'listo' }), 'en_camino')).toBe(false);
    expect(yaLlego(pedido({ estado: 'cancelado' }), 'en_camino')).toBe(false);
    expect(yaLlego(null, 'en_camino')).toBe(false);
    expect(yaLlego(pedido({ estado: 'listo' }), 'volando')).toBe(false);
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

describe('el historial', () => {
  // Mediodía del 15 de septiembre en Argentina.
  const AHORA = new Date('2026-09-15T15:00:00Z');

  it('los períodos, en el orden en que se muestran', () => {
    expect(PERIODOS_HISTORIAL.map(p => p.clave)).toEqual(['hoy', 'semana', 'mes', 'mes_pasado']);
  });

  it('los días de cada período, del más nuevo al más viejo', () => {
    expect(diasDelPeriodo('hoy', AHORA)).toEqual(['2026-09-15']);
    expect(diasDelPeriodo('semana', AHORA)).toEqual([
      '2026-09-15', '2026-09-14', '2026-09-13', '2026-09-12', '2026-09-11', '2026-09-10', '2026-09-09',
    ]);
    const mes = diasDelPeriodo('mes', AHORA);
    expect(mes).toHaveLength(15);
    expect([mes[0], mes.at(-1)]).toEqual(['2026-09-15', '2026-09-01']);
    const pasado = diasDelPeriodo('mes_pasado', AHORA);
    expect(pasado).toHaveLength(31);
    expect([pasado[0], pasado.at(-1)]).toEqual(['2026-08-31', '2026-08-01']);
  });

  it('el día sale de la hora de Argentina, aunque en UTC ya sea otro mes', () => {
    const noche = new Date('2026-10-01T01:00:00Z'); // 30 de septiembre, 22 h
    expect(diasDelPeriodo('hoy', noche)).toEqual(['2026-09-30']);
    expect(diasDelPeriodo('mes', noche)).toHaveLength(30);
    expect(diasDelPeriodo('mes_pasado', noche)[0]).toBe('2026-08-31');
  });

  it('en enero, el mes pasado es diciembre del año anterior; y febrero bisiesto', () => {
    const pasado = diasDelPeriodo('mes_pasado', new Date('2027-01-10T15:00:00Z'));
    expect([pasado[0], pasado.at(-1), pasado.length]).toEqual(['2026-12-31', '2026-12-01', 31]);
    expect(diasDelPeriodo('mes_pasado', new Date('2028-03-05T15:00:00Z'))).toHaveLength(29);
  });

  it('un período que no existe es hoy', () => {
    expect(diasDelPeriodo('siempre', AHORA)).toEqual(['2026-09-15']);
  });

  it('los días van a la consulta de a 30, que es lo que acepta Firestore', () => {
    const dias = Array.from({ length: 45 }, (_, i) => `d${i}`);
    expect(tandas(dias).map(t => t.length)).toEqual([30, 15]);
    expect(tandas([])).toEqual([]);
  });

  it('suma la plata de los envíos y separa los gratis y los que están a confirmar', () => {
    const entregado = (id, dia, extra = {}) => pedido({
      id, estado: 'entregado', entregado_dia: dia, entregado_en: `${dia}T15:00:00Z`, envio: 1800, total: 5000,
      pago: { modo: 'transferencia', pagado: true }, ...extra,
    });
    const r = resumenHistorial([
      entregado('a', '2026-09-15', { entregado_en: '2026-09-15T18:00:00Z' }),
      entregado('b', '2026-09-15', { envio: 2600, total: 7000, pago: { modo: 'efectivo', pagado: true } }),
      entregado('c', '2026-09-14', { envio: 0, entrega: { modo: 'delivery', envio_gratis: true } }),
      entregado('d', '2026-09-14', { envio: 0, entrega: { modo: 'delivery', envio_a_confirmar: true } }),
      // Lo entregaron y después lo cancelaron desde el panel: no cuenta.
      entregado('e', '2026-09-13', { estado: 'cancelado' }),
      // El de hoy llega por la escucha y por la consulta: va una sola vez.
      entregado('a', '2026-09-15'),
    ]);
    expect(r).toMatchObject({ entregados: 4, envios: 4400, efectivo: 7000, gratis: 1, aConfirmar: 1 });
    expect(r.dias.map(d => [d.dia, d.cantidad, d.envios])).toEqual([['2026-09-15', 2, 4400], ['2026-09-14', 2, 0]]);
    // Dentro del día, el último entregado primero.
    expect(r.dias[0].pedidos.map(x => x.id)).toEqual(['a', 'b']);
  });

  it('sin entregas, todo en cero', () => {
    expect(resumenHistorial([])).toEqual({ entregados: 0, envios: 0, efectivo: 0, gratis: 0, aConfirmar: 0, dias: [] });
  });

  it('el nombre del día: hoy, ayer o la fecha', () => {
    expect(etiquetaDia('2026-09-15', AHORA)).toBe('Hoy');
    expect(etiquetaDia('2026-09-14', AHORA)).toBe('Ayer');
    expect(etiquetaDia('2026-09-13', AHORA)).toBe('Domingo 13 de septiembre');
    expect(etiquetaDia('2026-08-31', AHORA)).toBe('Lunes 31 de agosto');
  });
});
