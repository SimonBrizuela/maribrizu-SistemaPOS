/**
 * Las reglas de las estadísticas de la tienda: qué se cuenta, cómo se limpia lo
 * que manda el navegador y cómo se juntan los días para el panel.
 */
import { describe, it, expect } from 'vitest';
import {
  claveDeDia, horaLocal, inicioDelDia, diasEntre, limpiarTermino, esIdDeProducto,
  claveDeRubro, nombreCorto, clasificarOrigen, validarEvento, agregarEventos,
  combinarDias, porcentaje, MAX_EVENTOS,
} from '../src/estadisticas.js';

// 2026-09-06 23:30 en Córdoba = 2026-09-07 02:30 UTC.
const NOCHE_AR = Date.parse('2026-09-07T02:30:00Z');

describe('la hora argentina', () => {
  it('el día se corta a la medianoche de Córdoba, no a la de Greenwich', () => {
    expect(claveDeDia(NOCHE_AR)).toBe('2026-09-06');
    expect(claveDeDia(Date.parse('2026-09-07T03:00:00Z'))).toBe('2026-09-07');
  });

  it('la hora es la del reloj del local', () => {
    expect(horaLocal(NOCHE_AR)).toBe(23);
    expect(horaLocal(Date.parse('2026-09-07T12:05:00Z'))).toBe(9);
  });

  it('el inicio de un día es su medianoche en Argentina', () => {
    expect(new Date(inicioDelDia('2026-09-06')).toISOString()).toBe('2026-09-06T03:00:00.000Z');
  });

  it('lista los días de un rango, con los dos extremos', () => {
    expect(diasEntre('2026-08-30', '2026-09-02'))
      .toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
    expect(diasEntre('2026-09-06', '2026-09-06')).toEqual(['2026-09-06']);
  });
});

describe('el término de búsqueda', () => {
  it('se cuenta en minúsculas, sin tildes ni signos', () => {
    expect(limpiarTermino('  Lápiz  Faber!! ')).toBe('lapiz faber');
    expect(limpiarTermino('CUADERNO, rivadavia')).toBe('cuaderno rivadavia');
  });

  it('lo que parece un teléfono o un correo no se cuenta', () => {
    expect(limpiarTermino('3515550001')).toBeNull();
    expect(limpiarTermino('llamame al 351 555 0001')).toBeNull();
    expect(limpiarTermino('marta@gmail.com')).toBeNull();
    // Una medida con pocos dígitos sí es una búsqueda.
    expect(limpiarTermino('cinta 25 mm')).toBe('cinta 25 mm');
  });

  it('se recorta y descarta lo que queda vacío', () => {
    expect(limpiarTermino('a')).toBeNull();
    expect(limpiarTermino('   ')).toBeNull();
    expect(limpiarTermino(null)).toBeNull();
    expect(limpiarTermino('x'.repeat(200)).length).toBe(60);
  });
});

describe('los demás campos', () => {
  it('el id del producto es letras, números, guion y guion bajo', () => {
    expect(esIdDeProducto('1035115')).toBe(true);
    expect(esIdDeProducto('A-12_b')).toBe(true);
    expect(esIdDeProducto('con espacio')).toBe(false);
    expect(esIdDeProducto('a.b')).toBe(false);
    expect(esIdDeProducto('')).toBe(false);
    expect(esIdDeProducto(12)).toBe(false);
  });

  it('el rubro queda como en el espejo', () => {
    expect(claveDeRubro('librería')).toBe('LIBRERIA');
    expect(claveDeRubro('Servicios Extra')).toBe('SERVICIOS EXTRA');
    expect(claveDeRubro('')).toBeNull();
  });

  it('el nombre se recorta', () => {
    expect(nombreCorto('  Goma   Borrar ')).toBe('Goma Borrar');
    expect(nombreCorto('x'.repeat(300)).length).toBe(120);
    expect(nombreCorto('')).toBeNull();
  });
});

describe('de dónde vino', () => {
  it('manda el utm_source si lo hay', () => {
    expect(clasificarOrigen({ url: 'https://beta.liceolibreria.com/?utm_source=Flyer', referrer: 'https://instagram.com/' }))
      .toBe('flyer');
    expect(clasificarOrigen({ url: '/catalogo?utm_source=grupo%20wsp' })).toBe('grupo_wsp');
  });

  it('reconoce las redes por el referrer', () => {
    expect(clasificarOrigen({ referrer: 'https://l.instagram.com/?u=x' })).toBe('instagram');
    expect(clasificarOrigen({ referrer: 'https://www.google.com/' })).toBe('google');
    expect(clasificarOrigen({ referrer: 'https://m.facebook.com/' })).toBe('facebook');
    expect(clasificarOrigen({ referrer: 'https://web.whatsapp.com/' })).toBe('whatsapp');
    expect(clasificarOrigen({ referrer: 'https://otrositio.com/' })).toBe('otro');
  });

  it('sin referrer es directo, y moverse dentro de la tienda también', () => {
    expect(clasificarOrigen({})).toBe('directo');
    expect(clasificarOrigen({ referrer: 'https://beta.liceolibreria.com/catalogo' })).toBe('directo');
    expect(clasificarOrigen({ referrer: 'no es una url' })).toBe('directo');
  });
});

describe('validar un evento', () => {
  const ahora = Date.parse('2026-09-06T15:00:00Z');

  it('descarta lo que no tiene forma de evento', () => {
    expect(validarEvento(null, ahora)).toBeNull();
    expect(validarEvento({ tipo: 'hackeo' }, ahora)).toBeNull();
    expect(validarEvento({ tipo: 'ficha', id: 'con espacio' }, ahora)).toBeNull();
    expect(validarEvento({ tipo: 'busqueda', texto: '3515550001' }, ahora)).toBeNull();
    expect(validarEvento({ tipo: 'busqueda', texto: '' }, ahora)).toBeNull();
  });

  it('un instante fuera de la ventana vale como ahora', () => {
    expect(validarEvento({ tipo: 'chat', t: ahora - 2 * 3600 * 1000 }, ahora).t).toBe(ahora);
    expect(validarEvento({ tipo: 'chat', t: ahora + 3600 * 1000 }, ahora).t).toBe(ahora);
    expect(validarEvento({ tipo: 'chat', t: 'x' }, ahora).t).toBe(ahora);
    expect(validarEvento({ tipo: 'chat', t: ahora - 60_000 }, ahora).t).toBe(ahora - 60_000);
  });

  it('la visita solo acepta dispositivos y orígenes con forma', () => {
    const ev = validarEvento({ tipo: 'visita', nueva: 'si', dispositivo: 'tablet', origen: 'Insta gram' }, ahora);
    expect(ev).toMatchObject({ nueva: false, dispositivo: null, origen: 'otro' });
    expect(validarEvento({ tipo: 'visita', nueva: true, dispositivo: 'movil', origen: 'instagram' }, ahora))
      .toMatchObject({ nueva: true, dispositivo: 'movil', origen: 'instagram' });
  });

  it('la búsqueda guarda cuántos resultados hubo, nunca negativos', () => {
    expect(validarEvento({ tipo: 'busqueda', texto: 'Cuaderno', resultados: 12.7 }, ahora))
      .toMatchObject({ termino: 'cuaderno', resultados: 12 });
    expect(validarEvento({ tipo: 'busqueda', texto: 'cuaderno', resultados: -3 }, ahora).resultados).toBe(0);
  });
});

describe('sumar eventos', () => {
  const ahora = Date.parse('2026-09-06T15:00:00Z');   // 12:00 en Córdoba

  it('convierte una tanda en contadores del día', () => {
    const dias = agregarEventos([
      { tipo: 'visita', nueva: true, dispositivo: 'movil', origen: 'instagram' },
      { tipo: 'pagina', pantalla: 'inicio' },
      { tipo: 'pagina', pantalla: 'catalogo', rubro: 'LIBRERIA' },
      { tipo: 'busqueda', texto: 'Cuaderno', resultados: 8 },
      { tipo: 'busqueda', texto: 'mochila', resultados: 0 },
      { tipo: 'ficha', id: '1035115', nombre: 'Goma Borrar', rubro: 'LIBRERIA' },
      { tipo: 'ficha', id: '1035115', nombre: 'Goma Borrar', rubro: 'LIBRERIA' },
      { tipo: 'carrito', id: '1035115', nombre: 'Goma Borrar' },
      { tipo: 'checkout' },
      { tipo: 'chat' },
      { tipo: 'nada' },
    ], ahora);

    expect(Object.keys(dias)).toEqual(['2026-09-06']);
    const { contadores, valores } = dias['2026-09-06'];
    expect(contadores).toEqual({
      visitas: 1, visitantes_nuevos: 1,
      dispositivos: { movil: 1 }, origenes: { instagram: 1 },
      paginas: 2, horas: { 12: 2 },
      rubros: { LIBRERIA: { vistas: 1 } },
      busquedas: 2, busquedas_sin_resultado: 1,
      terminos: { cuaderno: { n: 1 }, mochila: { n: 1, sin: 1 } },
      fichas: 2, carrito: 1,
      productos: { 1035115: { vistas: 2, carrito: 1 } },
      checkouts: 1, chat: 1,
    });
    expect(valores).toEqual({
      dia: '2026-09-06',
      productos: { 1035115: { nombre: 'Goma Borrar', rubro: 'LIBRERIA' } },
    });
  });

  it('reparte por día cuando la tanda cruza la medianoche', () => {
    const dias = agregarEventos([
      { tipo: 'chat', t: NOCHE_AR },
      { tipo: 'chat', t: NOCHE_AR + 40 * 60 * 1000 },
    ], NOCHE_AR + 45 * 60 * 1000);
    expect(Object.keys(dias).sort()).toEqual(['2026-09-06', '2026-09-07']);
  });

  it('no toma más de la tanda máxima', () => {
    const muchos = Array(MAX_EVENTOS + 20).fill({ tipo: 'chat' });
    const dias = agregarEventos(muchos, ahora);
    expect(dias['2026-09-06'].contadores.chat).toBe(MAX_EVENTOS);
  });

  it('una tanda sin nada válido no arma ningún día', () => {
    expect(agregarEventos([{ tipo: 'x' }, null, 5], ahora)).toEqual({});
    expect(agregarEventos('no es lista', ahora)).toEqual({});
  });
});

describe('juntar los días para el panel', () => {
  const DIAS = [
    { dia: '2026-09-05', visitas: 10, paginas: 30, busquedas: 4, busquedas_sin_resultado: 1,
      fichas: 12, carrito: 3, checkouts: 1,
      horas: { 9: 5, 18: 25 }, dispositivos: { movil: 8, escritorio: 2 },
      origenes: { directo: 7, instagram: 3 },
      rubros: { LIBRERIA: { vistas: 6 } },
      terminos: { cuaderno: { n: 3 }, mochila: { n: 1, sin: 1 } },
      productos: { 1035115: { vistas: 5, carrito: 2, nombre: 'Goma Borrar', rubro: 'LIBRERIA' },
                   7: { vistas: 7, nombre: 'Resma' } } },
    { dia: '2026-09-06', visitas: 4, paginas: 9, busquedas: 2, busquedas_sin_resultado: 2,
      fichas: 3, carrito: 1,
      horas: { 9: 9 }, dispositivos: { movil: 4 },
      origenes: { directo: 4 },
      rubros: { LIBRERIA: { vistas: 2 }, MERCERIA: { vistas: 5 } },
      terminos: { mochila: { n: 2, sin: 2 } },
      productos: { 1035115: { vistas: 1, carrito: 1, nombre: 'Goma Borrar Keyroad' } } },
  ];

  it('suma los totales', () => {
    const r = combinarDias(DIAS);
    expect(r.total).toMatchObject({ visitas: 14, paginas: 39, busquedas: 6, busquedas_sin_resultado: 3,
                                    fichas: 15, carrito: 4, checkouts: 1, chat: 0 });
    expect(r.horas[9]).toBe(14);
    expect(r.horas[18]).toBe(25);
    expect(r.dispositivos).toEqual({ movil: 12, escritorio: 2 });
  });

  it('arma los rankings de más a menos', () => {
    const r = combinarDias(DIAS);
    expect(r.terminos.map(t => t.termino)).toEqual(['cuaderno', 'mochila']);
    expect(r.sinResultado).toEqual([{ termino: 'mochila', n: 3, sin: 3 }]);
    expect(r.productos.map(p => p.id)).toEqual(['7', '1035115']);
    // El nombre que queda es el último que se vio.
    expect(r.productos[1]).toMatchObject({ vistas: 6, carrito: 3, nombre: 'Goma Borrar Keyroad', rubro: 'LIBRERIA' });
    expect(r.rubros).toEqual([{ clave: 'LIBRERIA', vistas: 8 }, { clave: 'MERCERIA', vistas: 5 }]);
    expect(r.origenes).toEqual([{ clave: 'directo', visitas: 11 }, { clave: 'instagram', visitas: 3 }]);
  });

  it('la serie por día viene ordenada aunque los documentos no', () => {
    const r = combinarDias([DIAS[1], DIAS[0]]);
    expect(r.porDia.map(d => d.dia)).toEqual(['2026-09-05', '2026-09-06']);
    expect(r.porDia[1]).toMatchObject({ visitas: 4, checkouts: 0 });
  });

  it('con nada, todo en cero y sin romperse', () => {
    const r = combinarDias([]);
    expect(r.total.visitas).toBe(0);
    expect(r.productos).toEqual([]);
    expect(combinarDias([null, 'x']).total.visitas).toBe(0);
  });

  it('porcentaje entero, cero sin base', () => {
    expect(porcentaje(3, 10)).toBe(30);
    expect(porcentaje(1, 3)).toBe(33);
    expect(porcentaje(5, 0)).toBe(0);
  });
});
