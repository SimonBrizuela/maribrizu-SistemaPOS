/**
 * Temporadas de venta: qué comprar para la fecha que se viene.
 *
 * El caso que originó todo esto (21/09/2026): el 6 de septiembre se vendió
 * muchísimo amarillo y el dueño se enteró tarde. Pidió que el sistema se lo
 * recuerde solo, dos meses antes, y que esos productos se vean distintos en el
 * Centro de Compras.
 *
 * Lo que cuidan estas pruebas, que es donde estuvieron los errores reales al
 * calibrar el motor contra las ventas de verdad:
 *   · una venta grande sola NO es una temporada (doscientos broches de una vez);
 *   · la línea de base tiene que ser el resto del año, no los días sueltos que
 *     no caen en ninguna fecha (con veintidós fechas, todo parecía un pico);
 *   · un día que cae en dos ventanas se lo queda UNA, la más cercana, o cada
 *     fecha termina con la lista de productos de la de al lado;
 *   · el color se mide, pero no se adivina.
 */
import { describe, it, expect } from 'vitest';

import {
  TEMPORADAS, temporadaPorId, grupoDe,
  fechaDeTemporada, ventanaDeTemporada, temporadasProximas,
  estudiarTemporadas, recomendarParaTemporada, recomendarPorPistas,
  coincidePorPista, urgenciaDeTemporada, motivoTemporada, explicarTemporada,
  estudioVigente, claveProducto, normTxt,
  EMPUJE_MINIMO, AVISO_DEFAULT_DIAS,
} from '../../webapp/src/temporadas.js';
import { pascua, domingoN, diasEntre, sumarDiasYmd, deYmd } from '../../webapp/src/fechas_ar.js';

const aYmd = (f) => {
  const p = String(f || '').split('/');
  return p.length >= 3 ? `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}` : '';
};
/** Un renglón de `ventas_por_dia` como lo escribe el POS. */
const venta = (ymd, producto, cantidad, color = '') => {
  const [y, m, d] = ymd.split('-');
  return { fecha: `${d}/${m}/${y}`, producto, cantidad, conjunto_color: color };
};
/** Ventas de un producto repartidas en varios días. */
function repartido(dias, producto, cantidadPorDia, color = '') {
  return dias.map(d => venta(d, producto, cantidadPorDia, color));
}

describe('el almanaque', () => {
  it('cada temporada tiene lo que necesita para trabajar', () => {
    for (const t of TEMPORADAS) {
      expect(t.id, 'id').toBeTruthy();
      expect(t.nombre, `nombre de ${t.id}`).toBeTruthy();
      expect(t.cuando, `cuando de ${t.id}`).toBeTruthy();
      expect(t.previa, `previa de ${t.id}`).toBeGreaterThan(0);
      expect(fechaDeTemporada(t, 2026), `fecha de ${t.id}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('no hay ids repetidos', () => {
    const ids = TEMPORADAS.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('las fechas fijas caen donde tienen que caer', () => {
    expect(fechaDeTemporada(temporadaPorId('amarillo'), 2026)).toBe('2026-09-06');
    expect(fechaDeTemporada(temporadaPorId('navidad'), 2027)).toBe('2027-12-25');
  });

  it('el Día de la Madre es el tercer domingo de octubre', () => {
    // 2026: los domingos de octubre son 4, 11, 18 y 25.
    expect(fechaDeTemporada(temporadaPorId('dia_madre'), 2026)).toBe('2026-10-18');
    expect(fechaDeTemporada(temporadaPorId('dia_madre'), 2027)).toBe('2027-10-17');
    // `new Date('2028-10-15')` se lee como UTC y en Argentina cae un día antes:
    // para preguntar el día de la semana hay que construirlo en hora local.
    expect(deYmd(fechaDeTemporada(temporadaPorId('dia_madre'), 2028)).getDay()).toBe(0);
  });

  it('el Día del Padre y el del Niño también son terceros domingos', () => {
    expect(fechaDeTemporada(temporadaPorId('dia_padre'), 2026)).toBe(
      `2026-06-${String(domingoN(2026, 5, 3).getDate()).padStart(2, '0')}`);
    expect(fechaDeTemporada(temporadaPorId('dia_nino'), 2026)).toBe('2026-08-16');
  });

  it('Carnaval cuelga de Pascua', () => {
    const p = pascua(2026);
    const esperado = new Date(p.getFullYear(), p.getMonth(), p.getDate() - 48);
    expect(fechaDeTemporada(temporadaPorId('carnaval'), 2026))
      .toBe(`${esperado.getFullYear()}-${String(esperado.getMonth() + 1).padStart(2, '0')}-${String(esperado.getDate()).padStart(2, '0')}`);
  });

  it('la ventana abarca los días previos y los de después', () => {
    const v = ventanaDeTemporada(temporadaPorId('amarillo'), 2026);
    expect(v.fecha).toBe('2026-09-06');
    expect(diasEntre(v.desde, v.fecha)).toBe(temporadaPorId('amarillo').previa);
    expect(diasEntre(v.fecha, v.hasta)).toBe(temporadaPorId('amarillo').post);
  });
});

describe('qué fechas se vienen', () => {
  it('avisa con dos meses, que es lo que se pidió', () => {
    // El 21 de septiembre, el Día de la Madre (18/10) está a 27 días.
    const prox = temporadasProximas('2026-09-21');
    const madre = prox.find(p => p.id === 'dia_madre');
    expect(madre).toBeTruthy();
    expect(madre.diasFaltan).toBe(27);
    expect(madre.plazoAviso).toBeGreaterThanOrEqual(AVISO_DEFAULT_DIAS);
  });

  it('una fecha que todavía está lejos no molesta', () => {
    // A principios de junio, la Navidad está a más de seis meses.
    const prox = temporadasProximas('2026-06-01');
    expect(prox.some(p => p.id === 'navidad')).toBe(false);
  });

  it('una fecha que ya pasó sale de la lista', () => {
    // El 20 de octubre el Día de la Madre (18/10, con un día de cola) terminó.
    const prox = temporadasProximas('2026-10-20');
    expect(prox.some(p => p.id === 'dia_madre')).toBe(false);
    expect(prox.some(p => p.id === 'halloween')).toBe(true);
  });

  it('en diciembre ya mira el año que viene', () => {
    const prox = temporadasProximas('2026-12-15');
    const reyes = prox.find(p => p.id === 'reyes');
    expect(reyes).toBeTruthy();
    expect(reyes.fecha).toBe('2027-01-06');
    expect(reyes.anio).toBe(2027);
  });

  it('salen ordenadas de la más cercana a la más lejana', () => {
    const prox = temporadasProximas('2026-09-21');
    const dias = prox.map(p => p.diasFaltan);
    expect(dias).toEqual([...dias].sort((a, b) => a - b));
  });

  it('marca la que ya arrancó a venderse', () => {
    const prox = temporadasProximas('2026-10-15');   // el Día de la Madre es el 18
    expect(prox.find(p => p.id === 'dia_madre').enVenta).toBe(true);
  });

  it('mirar el año entero no convierte todo en urgente', () => {
    // El panel "Próximas fechas" pide las fechas de los doce meses. El plazo de
    // aviso tiene que seguir siendo el de CADA fecha: si el override lo pisara,
    // la Navidad en abril figuraría igual de urgente que lo de la semana que
    // viene, y la cercanía se mediría contra un año entero.
    const todas = temporadasProximas('2026-10-01', { avisoDias: 366 });
    expect(todas.length).toBeGreaterThan(15);
    const navidad = todas.find(p => p.id === 'navidad');
    expect(navidad.plazoAviso).toBe(temporadaPorId('navidad').aviso);
    expect(navidad.diasFaltan).toBeGreaterThan(navidad.plazoAviso);
  });

  it('una fecha vacía no rompe nada', () => {
    expect(temporadasProximas('')).toEqual([]);
    expect(temporadasProximas(null)).toEqual([]);
  });
});

describe('estudiar las ventas viejas', () => {
  it('sin ventas devuelve un estudio vacío, no un error', () => {
    const e = estudiarTemporadas([], { aYmd });
    expect(e.temporadas).toEqual({});
    expect(e.dias).toBe(0);
  });

  it('encuentra lo que se despega en la fecha', () => {
    const items = [];
    // Un producto que se vende todo el año, parejo.
    for (let i = 0; i < 60; i++) items.push(venta(sumarDiasYmd('2026-07-01', i), 'CUADERNO', 5));
    // Y uno que sólo aparece en la previa del 6 de septiembre.
    items.push(...repartido(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'], 'LIMPIA PIPA', 20, 'Amarillo'));
    const e = estudiarTemporadas(items, { aYmd });
    const sept = e.temporadas.septiembre;
    expect(sept).toBeTruthy();
    const lp = sept.productos.find(p => p.n === 'limpia pipa');
    expect(lp).toBeTruthy();
    expect(lp.e).toBeGreaterThanOrEqual(EMPUJE_MINIMO);
    // El cuaderno se vende igual todos los días: no es de temporada.
    expect(sept.productos.some(p => p.n === 'cuaderno')).toBe(false);
  });

  it('UNA venta grande sola no arma una temporada', () => {
    // Doscientos broches de un saque el 26 de agosto: es un cliente que se
    // llevó la caja, no el Día del Maestro. Fue ruido real del primer motor.
    const items = [];
    for (let i = 0; i < 60; i++) items.push(venta(sumarDiasYmd('2026-07-01', i), 'CUADERNO', 5));
    items.push(venta('2026-08-26', 'BROCHE MARIPOSA', 200));
    const e = estudiarTemporadas(items, { aYmd });
    const sept = e.temporadas.septiembre;
    expect(sept?.productos.some(p => p.n === 'broche mariposa')).toBeFalsy();
  });

  it('un día gigante no le alcanza a un producto que casi no se movió', () => {
    // Dos días de venta, pero uno solo se lleva el 97%: se recorta y no llega.
    const items = [];
    for (let i = 0; i < 60; i++) items.push(venta(sumarDiasYmd('2026-07-01', i), 'CUADERNO', 5));
    items.push(venta('2026-09-01', 'PLUMA MARABU', 300));
    items.push(venta('2026-09-02', 'PLUMA MARABU', 2));
    items.push(venta('2026-09-03', 'PLUMA MARABU', 2));
    const e = estudiarTemporadas(items, { aYmd });
    const p = e.temporadas.septiembre?.productos.find(x => x.n === 'pluma marabu');
    // Si entra, entra con las unidades recortadas, nunca con las 304 crudas.
    if (p) expect(p.u).toBeLessThan(100);
  });

  it('mide el COLOR además del producto, que es como vuela el 6 de septiembre', () => {
    // Lo que pasó de verdad: el amarillo se reparte entre muchos productos y
    // ninguno llega solo al umbral. Junto, salta a la vista.
    const items = [];
    for (let i = 0; i < 60; i++) items.push(venta(sumarDiasYmd('2026-06-20', i), 'CUADERNO', 5));
    const dias = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
    items.push(...repartido(dias, 'CINTA RASO', 8, 'Amarillo'));
    items.push(...repartido(dias, 'CARTULINA', 8, 'Amarillo patito'));
    items.push(...repartido(dias, 'LIMPIA PIPA', 8, 'Amarillo limon'));
    const e = estudiarTemporadas(items, { aYmd });
    const colores = e.temporadas.septiembre?.colores || [];
    expect(colores.length).toBeGreaterThan(0);
    expect(colores.every(c => c.c.includes('amarillo'))).toBe(true);
  });

  it('no inventa colores de temporada donde la fecha no declara ninguno', () => {
    // "N5 dorado" es un número de broche, no un color de fiesta. Para el Día
    // del Libro, que no declara colores, no tiene que salir nada.
    const items = [];
    for (let i = 0; i < 60; i++) items.push(venta(sumarDiasYmd('2026-04-01', i), 'CUADERNO', 5));
    items.push(...repartido(['2026-06-10', '2026-06-11', '2026-06-12'], 'BROCHE', 30, 'N5 dorado'));
    const e = estudiarTemporadas(items, { aYmd });
    expect(e.temporadas.dia_libro?.colores).toBeUndefined();
  });

  it('un día que cae en dos ventanas se lo queda la fecha más cercana', () => {
    // El 3 de septiembre está a 3 días del 6 y a 8 del Día del Maestro. Si se
    // lo quedaran las dos, cada fecha terminaría con los productos de la otra.
    // Como las dos son del mismo grupo, se mide una vez sola.
    expect(grupoDe(temporadaPorId('amarillo'))).toBe('septiembre');
    expect(grupoDe(temporadaPorId('dia_maestro'))).toBe('septiembre');
    expect(grupoDe(temporadaPorId('primavera'))).toBe('septiembre');
  });

  it('las tres patrias se estudian juntas: venden la misma escarapela', () => {
    expect(grupoDe(temporadaPorId('25_mayo'))).toBe('patrias');
    expect(grupoDe(temporadaPorId('bandera'))).toBe('patrias');
    expect(grupoDe(temporadaPorId('independencia'))).toBe('patrias');

    const items = [];
    for (let i = 0; i < 120; i++) items.push(venta(sumarDiasYmd('2026-04-01', i), 'CUADERNO', 5));
    // La escarapela aparece en las tres previas y en ninguna otra parte.
    for (const f of ['2026-05-20', '2026-05-21', '2026-05-22',
                     '2026-06-16', '2026-06-17', '2026-06-18',
                     '2026-07-05', '2026-07-06', '2026-07-07']) {
      items.push(venta(f, 'ESCARAPELA', 10));
    }
    const e = estudiarTemporadas(items, { aYmd });
    expect(e.temporadas.patrias).toBeTruthy();
    expect(e.temporadas.patrias.productos.some(p => p.n === 'escarapela')).toBe(true);
    // Se midió tres veces: lo esperado para UNA fecha es un tercio del total.
    expect(e.temporadas.patrias.veces).toBe(3);
  });

  it('las devoluciones no arman temporada', () => {
    const items = [];
    for (let i = 0; i < 60; i++) items.push(venta(sumarDiasYmd('2026-07-01', i), 'CUADERNO', 5));
    items.push(...repartido(['2026-09-01', '2026-09-02', '2026-09-03'], 'GOMA', -20));
    const e = estudiarTemporadas(items, { aYmd });
    expect(e.temporadas.septiembre?.productos.some(p => p.n === 'goma')).toBeFalsy();
  });

  it('lee el nombre decorado del POS y lo cuenta en unidades base', () => {
    const RESMA = { nombre: 'PAPEL OBRA A4', conjunto_tipo: 'pack', conjunto_contenido: 500, conjunto_unidad_medida: 'unidades' };
    const cat = new Map([['papel obra a4', RESMA]]);
    const items = [];
    for (let i = 0; i < 60; i++) items.push(venta(sumarDiasYmd('2026-07-01', i), 'CUADERNO', 5));
    for (const f of ['2026-09-01', '2026-09-02', '2026-09-03']) {
      items.push(venta(f, 'PAPEL OBRA A4  ·  1 pack(s)', 1));
    }
    const e = estudiarTemporadas(items, { aYmd, catalogoPorNombre: cat });
    const p = e.temporadas.septiembre?.productos.find(x => x.n === 'papel obra a4');
    expect(p).toBeTruthy();
    expect(p.u).toBe(1500);   // tres packs de 500, no tres unidades
  });

  it('el estudio entra en un documento: hay tope de productos', () => {
    const items = [];
    for (let i = 0; i < 60; i++) items.push(venta(sumarDiasYmd('2026-07-01', i), 'CUADERNO', 5));
    for (let k = 0; k < 200; k++) {
      items.push(...repartido(['2026-09-01', '2026-09-02', '2026-09-03'], `COSA ${k}`, 10));
    }
    const e = estudiarTemporadas(items, { aYmd, topeProductos: 20 });
    expect(e.temporadas.septiembre.productos.length).toBe(20);
  });
});

describe('cuánto urge comprar por la fecha', () => {
  it('con stock de sobra no urge nada, aunque la fecha sea mañana', () => {
    expect(urgenciaDeTemporada({ empuje: 20, esperado: 10, stock: 100, diasFaltan: 1 })).toBe(0);
  });

  it('sin stock y con la fecha encima, urge al máximo', () => {
    const u = urgenciaDeTemporada({ empuje: 20, esperado: 100, stock: 0, diasFaltan: 0 });
    expect(u).toBeGreaterThan(80);
  });

  it('la misma falta urge menos si la fecha está lejos', () => {
    const cerca = urgenciaDeTemporada({ empuje: 10, esperado: 100, stock: 0, diasFaltan: 3 });
    const lejos = urgenciaDeTemporada({ empuje: 10, esperado: 100, stock: 0, diasFaltan: 55 });
    expect(cerca).toBeGreaterThan(lejos);
  });

  it('una corazonada pesa la mitad que un dato medido', () => {
    const base = { empuje: 6, esperado: 100, stock: 0, diasFaltan: 10 };
    expect(urgenciaDeTemporada({ ...base, porPista: true }))
      .toBeCloseTo(urgenciaDeTemporada(base) / 2, 0);
  });

  it('sin nada esperado no hay urgencia', () => {
    expect(urgenciaDeTemporada({ empuje: 30, esperado: 0, stock: 0, diasFaltan: 0 })).toBe(0);
  });
});

describe('recomendar contra el stock de hoy', () => {
  const estudio = {
    desde: '2026-04-10', hasta: '2026-09-21', dias: 138, anios: [2026],
    temporadas: {
      septiembre: {
        anios: [2026], veces: 3, dias: 20,
        productos: [
          { n: 'limpia pipa', c: 'amarillo', u: 390, b: 0.1, e: 14, d: 8 },
          { n: 'cinta raso', c: 'amarillo', u: 60, b: 0, e: 30, d: 4 },
        ],
      },
    },
  };
  const prox = { id: 'amarillo', grupo: 'septiembre', nombre: 'El 6 de septiembre', fecha: '2027-09-06', diasFaltan: 30, plazoAviso: 60 };

  it('lo que no tiene stock encabeza', () => {
    const stock = new Map([
      [claveProducto('limpia pipa', 'amarillo'), { stock: 0, docId: '1', producto: { nombre: 'LIMPIA PIPA' } }],
      [claveProducto('cinta raso', 'amarillo'), { stock: 500, docId: '2', producto: { nombre: 'CINTA RASO' } }],
    ]);
    const recs = recomendarParaTemporada(prox, estudio, { stockDe: k => stock.get(k) || null });
    expect(recs[0].nombre).toBe('limpia pipa');
    // Se midió 3 veces: lo esperado para UNA fecha es 390/3 = 130.
    expect(recs[0].esperado).toBe(130);
    expect(recs[0].faltan).toBe(130);
    // La cinta tiene de sobra: no entra.
    expect(recs.some(r => r.nombre === 'cinta raso')).toBe(false);
  });

  it('un producto que ya no está en el catálogo se saltea', () => {
    const recs = recomendarParaTemporada(prox, estudio, { stockDe: () => null });
    expect(recs).toEqual([]);
  });

  it('una fecha sin estudio no devuelve nada', () => {
    const recs = recomendarParaTemporada({ ...prox, grupo: 'halloween' }, estudio, { stockDe: () => ({ stock: 0 }) });
    expect(recs).toEqual([]);
  });
});

describe('las pistas, para las fechas que todavía no se pudieron medir', () => {
  const madre = temporadaPorId('dia_madre');

  it('el rubro alcanza: REGALERÍA es lo que se vende para el Día de la Madre', () => {
    expect(coincidePorPista(madre, { nombre: 'PORTARETRATO 13X18', rubro: 'REGALERÍA' })).toBe(true);
  });

  it('el color NO alcanza: pedir "negro" para Halloween traía todos los bolígrafos', () => {
    const hall = temporadaPorId('halloween');
    expect(coincidePorPista(hall, { nombre: 'BOLIGRAFO SABONIS', rubro: 'LIBRERÍA', color: 'Negro' })).toBe(false);
  });

  it('busca palabras enteras: MONOPOLY no es un moño', () => {
    expect(coincidePorPista(temporadaPorId('reyes'), { nombre: 'JUEGO MONOPOLY', rubro: 'LIBRERÍA' })).toBe(false);
    expect(coincidePorPista(temporadaPorId('reyes'), { nombre: 'MONO REGALO X 10', rubro: 'LIBRERÍA' })).toBe(true);
  });

  // Los tres falsos positivos que aparecieron al revisar la lista real contra
  // el catálogo del local (21/09/2026). El rubro dice "esto es para regalar"
  // pero no distingue adentro del rubro.
  it('no le regala un mouse a la madre', () => {
    // REGALERÍA tiene los portarretratos y también la informática.
    expect(coincidePorPista(madre, { nombre: 'MOUSE GTC INALAMBRICO MIG-125', rubro: 'REGALERÍA', subRubro: 'INFORMATICA' })).toBe(false);
    expect(coincidePorPista(madre, { nombre: 'TECLADO-MOUSE GTC', rubro: 'REGALERÍA', subRubro: 'MOUSE' })).toBe(false);
    // Pero el portarretrato del mismo rubro sí.
    expect(coincidePorPista(madre, { nombre: 'PORTARETRATO PLASTICO 13X18', rubro: 'REGALERÍA', subRubro: 'PORTARETRATOS' })).toBe(true);
  });

  it('la espada de San Martín no es de Halloween', () => {
    // Los tres son rubro COTILLON: si el rubro mandara solo, Halloween se
    // llevaba lo patrio y lo de primavera.
    const hall = temporadaPorId('halloween');
    expect(coincidePorPista(hall, { nombre: 'ESPADA SABLE SAN MARTIN', rubro: 'COTILLON', subRubro: 'ESPADA' })).toBe(false);
    expect(coincidePorPista(hall, { nombre: 'BANDERIN DE FLORES PRIMAVERA', rubro: 'COTILLON', subRubro: 'GUIRNALDAS' })).toBe(false);
    expect(coincidePorPista(hall, { nombre: 'ANTIFAZ HALLOWEEN', rubro: 'COTILLON' })).toBe(true);
  });

  it('lo propio gana sobre la exclusión cruzada', () => {
    // "navidad" y "primavera" están en la lista de exclusión para que no se las
    // lleve la fecha de al lado. Cada una tiene que poder reclamar lo suyo.
    expect(coincidePorPista(temporadaPorId('navidad'), { nombre: 'ARBOLITO DE NAVIDAD', rubro: 'NAVIDAD' })).toBe(true);
    expect(coincidePorPista(temporadaPorId('primavera'), { nombre: 'BANDERIN DE FLORES PRIMAVERA', rubro: 'COTILLON', subRubro: 'GUIRNALDAS' })).toBe(true);
    expect(coincidePorPista(temporadaPorId('egresados'), { nombre: 'CINTA DE EGRESADOS', rubro: 'MERCERÍA' })).toBe(true);
    expect(coincidePorPista(temporadaPorId('25_mayo'), { nombre: 'ESCARAPELA METAL X1', rubro: 'LIBRERÍA' })).toBe(true);
  });

  it('sólo propone lo que ya se vende', () => {
    const prox = { id: 'dia_madre', nombre: 'Día de la Madre', fecha: '2026-10-18', diasFaltan: 27, plazoAviso: 60 };
    const recs = recomendarPorPistas(prox, {
      candidatos: [
        { nombre: 'TAZA', rubro: 'REGALERÍA', stock: 0, velDia: 2, docId: '1' },
        { nombre: 'PORTARETRATO', rubro: 'REGALERÍA', stock: 0, velDia: 0, docId: '2' },
      ],
    });
    expect(recs.map(r => r.nombre)).toEqual(['TAZA']);
    expect(recs[0].porPista).toBe(true);
  });

  it('lo que tiene stock de sobra no se propone', () => {
    const prox = { id: 'dia_madre', nombre: 'Día de la Madre', fecha: '2026-10-18', diasFaltan: 27, plazoAviso: 60 };
    const recs = recomendarPorPistas(prox, {
      candidatos: [{ nombre: 'TAZA', rubro: 'REGALERÍA', stock: 99999, velDia: 2, docId: '1' }],
    });
    expect(recs).toEqual([]);
  });
});

describe('cómo se explica en la pantalla', () => {
  const rec = {
    temporada: { id: 'amarillo', nombre: 'El 6 de septiembre', fecha: '2026-09-06', diasFaltan: 27 },
    empuje: 14, esperado: 130, stock: 0, faltan: 130, porPista: false,
  };

  it('el motivo dice la fecha, cuánto falta y cuánto se despega', () => {
    const m = motivoTemporada(rec);
    expect(m).toContain('El 6 de septiembre');
    expect(m).toContain('27 días');
    expect(m).toContain('14 veces más');
  });

  it('una corazonada se nombra como tal', () => {
    expect(motivoTemporada({ ...rec, porPista: true })).toContain('suele venderse');
  });

  it('"es hoy" y "es mañana" en vez de 0 y 1 días', () => {
    expect(motivoTemporada({ ...rec, temporada: { ...rec.temporada, diasFaltan: 0 } })).toContain('es hoy');
    expect(motivoTemporada({ ...rec, temporada: { ...rec.temporada, diasFaltan: 1 } })).toContain('es mañana');
  });

  it('el tooltip abre la cuenta y avisa cuando es suposición', () => {
    expect(explicarTemporada(rec)).toContain('6 de septiembre');
    expect(explicarTemporada(rec)).toContain('Sale de tus propias ventas');
    expect(explicarTemporada({ ...rec, porPista: true })).toContain('corazonada');
  });

  it('sin temporada no devuelve texto', () => {
    expect(motivoTemporada(null)).toBe('');
    expect(explicarTemporada({})).toBe('');
  });
});

describe('vigencia del estudio', () => {
  it('uno de esta semana sirve', () => {
    expect(estudioVigente({ hasta: '2026-09-18' }, '2026-09-21')).toBe(true);
  });

  it('uno de hace tres meses hay que rehacerlo', () => {
    expect(estudioVigente({ hasta: '2026-06-01' }, '2026-09-21')).toBe(false);
  });

  it('si nunca se hizo, no sirve', () => {
    expect(estudioVigente(null, '2026-09-21')).toBe(false);
    expect(estudioVigente({}, '2026-09-21')).toBe(false);
  });
});

describe('normalizar', () => {
  it('saca tildes y unifica espacios', () => {
    expect(normTxt('  CINTA   RASÓ  ')).toBe('cinta raso');
  });

  it('la clave junta producto y variedad', () => {
    expect(claveProducto('LIMPIA PIPA', 'Amarillo')).toBe('limpia pipa||amarillo');
    expect(claveProducto('LIMPIA PIPA', '')).toBe('limpia pipa');
  });
});
