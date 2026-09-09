/**
 * En qué orden hay que comprar.
 *
 * El dueño lo pidió así: la lista no puede mirar solo lo que se vendió la
 * última semana. Tiene que conjugar lo que más se movió estos días, lo que más
 * se vende en el mes (las hojas de impresión, el plástico) y el stock mínimo
 * cargado, y salir ordenada del más urgente al que puede esperar.
 *
 * Los dos errores que cuestan plata son opuestos:
 *   · poner arriba algo que vende mucho pero tiene stock para tres meses, y
 *     gastar el viaje al mayorista en eso;
 *   · dejar abajo lo que sostiene el mostrador porque esa semana estuvo flojo.
 *
 * Y hay una trampa vieja de esta base: UNA venta grande no es un ritmo. Un
 * corte de 50 metros de Pañolenci dejó una vez el mínimo en 44.
 */
import { describe, it, expect } from 'vitest';

import {
  ritmoPonderado, confianzaRitmoCorto,
  escalaVentas, rankEnEscala, restarDias,
  riesgoPorCobertura, riesgoPorMinimo, importanciaDeVenta,
  puntajeUrgencia, nivelPorPuntaje, compararUrgencia,
  motivosUrgencia, explicarUrgencia,
  computarVentanas, ritmoDe,
  UMBRAL_SISI, UMBRAL_IMPORTANTE, MIN_MUESTRA_RANKING,
} from '../../webapp/src/urgencia_compra.js';

// Las fechas de `ventas_por_dia` vienen "dd/mm/yyyy" (réplica de fechaDMYtoYMD,
// que vive en config.js y arrastra Firebase).
const aYmd = (dmy) => {
  const p = String(dmy || '').split('/');
  return p.length === 3 ? `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}` : '';
};
const HOY = '2026-09-09';
/** Una fecha de hace n días en el formato que guarda el POS. */
const hace = (n) => {
  const [y, m, d] = HOY.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - n));
  const dd = (x) => String(x).padStart(2, '0');
  return `${dd(t.getUTCDate())}/${dd(t.getUTCMonth() + 1)}/${t.getUTCFullYear()}`;
};
const renglon = (producto, cantidad, dias, extra = {}) =>
  ({ producto, cantidad, fecha: hace(dias), ...extra });
const ventanas = (items, catalogo = null) => computarVentanas(items, {
  hoyYmd: HOY, aYmd,
  catalogoPorNombre: catalogo
    ? new Map(catalogo.map(p => [String(p.nombre).toLowerCase(), p]))
    : null,
});

describe('el ritmo con el que se decide', () => {
  it('el que vende parejo mide lo mismo con las dos ventanas', () => {
    // 30 en el mes = 1 por día; 7 en la semana = 1 por día.
    expect(ritmoPonderado({ velLarga: 1, velCorta: 1, diasConMovimiento: 5 })).toBeCloseTo(1, 10);
  });

  it('el que se aceleró esta semana sube', () => {
    // Vendía 1 por día y esta semana va a 4: el ritmo sube, pero no salta a 4.
    const v = ritmoPonderado({ velLarga: 1, velCorta: 4, diasConMovimiento: 5 });
    expect(v).toBeGreaterThan(1);
    expect(v).toBeLessThan(4);
    expect(v).toBeCloseTo(1 + 3 * 0.6, 10);
  });

  it('una sola venta grande NO es un ritmo', () => {
    // El caso Pañolenci: 50 metros de una, un solo día con movimiento.
    // Manda el promedio del mes, la venta suelta no lo mueve.
    expect(ritmoPonderado({ velLarga: 1, velCorta: 7, diasConMovimiento: 1 })).toBe(1);
    // Con dos días ya pesa la mitad, con tres pesa completo.
    expect(confianzaRitmoCorto(0)).toBe(0);
    expect(confianzaRitmoCorto(1)).toBe(0);
    expect(confianzaRitmoCorto(2)).toBe(0.5);
    expect(confianzaRitmoCorto(3)).toBe(1);
    expect(confianzaRitmoCorto(6)).toBe(1);
  });

  it('el que se frenó baja', () => {
    const v = ritmoPonderado({ velLarga: 2, velCorta: 0.5, diasConMovimiento: 3 });
    expect(v).toBeLessThan(2);
    expect(v).toBeGreaterThan(0);
  });

  it('el que no se movió en la semana se queda con el ritmo del mes', () => {
    // Sin días de movimiento no hay información nueva: no se castiga a ciegas
    // al que vende una vez por quincena.
    expect(ritmoPonderado({ velLarga: 1.5, velCorta: 0, diasConMovimiento: 0 })).toBe(1.5);
  });
});

describe('las dos ventanas de venta', () => {
  it('separa lo del mes de lo de los últimos días', () => {
    const v = ventanas([
      renglon('CUADERNO', 5, 1),
      renglon('CUADERNO', 3, 5),
      renglon('CUADERNO', 20, 25),
    ]);
    const r = ritmoDe(v, { nombre: 'CUADERNO' });
    expect(r.unidades).toBe(28);
    expect(r.unidades7).toBe(8);
    expect(r.diasConMov7).toBe(2);
  });

  it('lo de hace más de un mes no entra', () => {
    const v = ventanas([renglon('CUADERNO', 9, 45)]);
    expect(ritmoDe(v, { nombre: 'CUADERNO' }).unidades).toBe(0);
  });

  it('el renglón decorado se cuenta contra su producto', () => {
    // "1 pack(s)" es un 1 que son 500 hojas, y el nombre viene con el color.
    const RESMA = {
      nombre: 'PAPEL OBRA A4', es_conjunto: true, conjunto_tipo: 'pack',
      conjunto_contenido: 500, conjunto_unidad_medida: 'unidades',
    };
    const v = ventanas([renglon('PAPEL OBRA A4  ·  2 pack(s)', 2, 3)], [RESMA]);
    expect(ritmoDe(v, { nombre: 'PAPEL OBRA A4' }).unidades).toBe(1000);
  });

  it('mide una variedad sola cuando las ventas traen el color', () => {
    const v = ventanas([
      renglon('[Verde]  GOMA EVA', 4, 2, { conjunto_color: 'Verde' }),
      renglon('[Rojo]  GOMA EVA', 9, 2, { conjunto_color: 'Rojo' }),
    ]);
    expect(ritmoDe(v, { nombre: 'GOMA EVA', color: 'Verde' }).unidades).toBe(4);
    expect(ritmoDe(v, { nombre: 'GOMA EVA' }).unidades).toBe(13);
  });

  it('si las ventas viejas no traen color, la variedad cae al producto entero', () => {
    const v = ventanas([renglon('GOMA EVA', 13, 2)]);
    expect(ritmoDe(v, { nombre: 'GOMA EVA', color: 'Verde' }).unidades).toBe(13);
  });

  it('la hoja que se gasta al imprimir cuenta aunque no se venda suelta', () => {
    const v = ventanas([
      renglon('IMPRESION A4', 40, 2, {
        consumibles_descuentos: [{ target_id: 'hoja1', cantidad: 40 }],
      }),
    ]);
    const r = ritmoDe(v, { nombre: 'HOJA A4', docId: 'hoja1' });
    expect(r.unidades).toBe(40);
    expect(r.unidades7).toBe(40);
  });

  it('una devolución resta del ritmo', () => {
    const v = ventanas([renglon('CUADERNO', 10, 3), renglon('CUADERNO', -4, 2)]);
    expect(ritmoDe(v, { nombre: 'CUADERNO' }).unidades).toBe(6);
  });

  it('el producto nuevo se mide desde su primera venta', () => {
    // Vendió 20 en tres días. Dividido 30 parecería que casi no se mueve.
    const v = ventanas([renglon('NOVEDAD', 10, 1), renglon('NOVEDAD', 10, 2)]);
    const r = ritmoDe(v, { nombre: 'NOVEDAD' });
    expect(r.dias).toBe(7);
    expect(r.velLarga).toBeCloseTo(20 / 7, 10);
  });

  it('restar días no se marea con los cambios de mes', () => {
    expect(restarDias('2026-09-09', 30)).toBe('2026-08-10');
    expect(restarDias('2026-01-03', 7)).toBe('2025-12-27');
  });
});

describe('el ranking de ventas del local', () => {
  const escala = escalaVentas([1, 2, 3, 10, 50, 400]);   // 400 = las hojas

  it('lo que más se vende queda arriba', () => {
    expect(rankEnEscala(escala, 400)).toBeCloseTo(5 / 6, 10);
    expect(rankEnEscala(escala, 1)).toBe(0);
  });

  it('lo que no vendió nada no rankea', () => {
    expect(rankEnEscala(escala, 0)).toBe(0);
    expect(rankEnEscala(escala, -3)).toBe(0);
  });

  it('con cuatro ventas cargadas nadie es top', () => {
    // Ser "el segundo de tres" no significa nada: sin muestra, ranking cero.
    const flaca = escalaVentas([1, 2, 3, 4]);
    expect(flaca.length).toBeLessThan(MIN_MUESTRA_RANKING);
    expect(rankEnEscala(flaca, 4)).toBe(0);
  });

  it('los ceros y la basura no entran en la escala', () => {
    expect(escalaVentas([0, -2, null, undefined, NaN, 5, 1])).toEqual([1, 5]);
  });
});

describe('el riesgo de quedarse sin nada', () => {
  it('sin stock es el riesgo máximo', () => {
    expect(riesgoPorCobertura(0, 30)).toBe(1);
  });

  it('con stock hasta el horizonte no hay riesgo', () => {
    expect(riesgoPorCobertura(30, 30)).toBe(0);
    expect(riesgoPorCobertura(90, 30)).toBe(0);
  });

  it('sin ritmo no se puede saber cuándo se agota', () => {
    expect(riesgoPorCobertura(Infinity, 30)).toBe(0);
  });

  it('debajo de una semana entra en la meseta alta', () => {
    // Entre dos y cinco días de stock la decisión es la misma: va en este viaje.
    expect(riesgoPorCobertura(3, 30)).toBeGreaterThan(0.8);
    expect(riesgoPorCobertura(7, 30)).toBeCloseTo(0.7, 10);
    expect(riesgoPorCobertura(15, 30)).toBeLessThan(0.7);
    expect(riesgoPorCobertura(15, 30)).toBeGreaterThan(0);
  });

  it('el mínimo cargado mide cuánto le falta para llegar', () => {
    expect(riesgoPorMinimo(0, 10)).toBe(1);
    expect(riesgoPorMinimo(2, 10)).toBeCloseTo(0.8, 10);
    expect(riesgoPorMinimo(40, 10)).toBe(0);
    expect(riesgoPorMinimo(-5, 10)).toBe(1);   // el stock en negativo no baja el riesgo
  });

  it('tocar el mínimo ya cuenta como riesgo', () => {
    // El mínimo ES el punto de reponer: justo ahí no puede dar cero y quedar
    // empatado con lo que tiene stock de sobra.
    expect(riesgoPorMinimo(10, 10)).toBeGreaterThan(0);
    expect(riesgoPorMinimo(10, 10)).toBeLessThan(riesgoPorMinimo(3, 10));
    expect(riesgoPorMinimo(11, 10)).toBe(0);
  });

  it('sin mínimo cargado el mínimo no opina', () => {
    expect(riesgoPorMinimo(0, 0)).toBe(0);
  });

  it('manda el peor de los dos', () => {
    // Stock para 20 días (riesgo bajo) pero en la mitad del mínimo cargado.
    const p = puntajeUrgencia({
      diasCobertura: 20, coberturaObjetivo: 30, stock: 5, stockMin: 10,
      rankMes: 1, rankReciente: 1, unidadesMes: 20,
    });
    expect(p.riesgo).toBeCloseTo(0.5, 10);
    expect(p.riesgo).toBeGreaterThan(p.riesgo_cobertura);
  });
});

describe('el peso en las ventas', () => {
  it('el que no vende nada no queda en cero: queda en el piso', () => {
    expect(importanciaDeVenta(0, 0)).toBeGreaterThan(0);
    expect(importanciaDeVenta(0, 0)).toBeLessThan(0.3);
  });

  it('el más vendido del mes y de la semana llega a uno', () => {
    expect(importanciaDeVenta(1, 1)).toBeCloseTo(1, 10);
  });

  it('las dos ventanas pesan igual', () => {
    expect(importanciaDeVenta(1, 0)).toBeCloseTo(importanciaDeVenta(0, 1), 10);
  });
});

describe('el puntaje de urgencia', () => {
  const hojas = () => puntajeUrgencia({
    diasCobertura: 3, coberturaObjetivo: 30, stock: 1200, stockMin: 0,
    rankMes: 0.98, rankReciente: 0.95, unidadesMes: 4000,
  });

  it('las hojas que se acaban esta semana van arriba de todo', () => {
    const p = hojas();
    expect(p.score).toBeGreaterThan(80);
    expect(nivelPorPuntaje(p.score)).toBe('sisi');
  });

  it('vender muchísimo con stock de sobra NO es urgente', () => {
    // Es el error que tenía la lista: sumando, el más vendido quedaba arriba
    // aunque tuviera para tres meses. Multiplicando, sin riesgo no hay urgencia.
    const p = puntajeUrgencia({
      diasCobertura: 120, coberturaObjetivo: 30, stock: 9000, stockMin: 0,
      rankMes: 1, rankReciente: 1, unidadesMes: 4000,
    });
    expect(p.score).toBe(0);
    expect(nivelPorPuntaje(p.score)).toBe('opcional');
  });

  it('quedarse sin nada de algo que rota es sí o sí, venda lo que venda', () => {
    const p = puntajeUrgencia({
      diasCobertura: 0, coberturaObjetivo: 30, stock: 0, stockMin: 0,
      rankMes: 0, rankReciente: 0, unidadesMes: 5,
    });
    expect(p.score).toBeGreaterThanOrEqual(UMBRAL_SISI);
    expect(nivelPorPuntaje(p.score)).toBe('sisi');
  });

  it('quedarse sin nada de algo que casi no rota es importante, no sí o sí', () => {
    const p = puntajeUrgencia({
      diasCobertura: Infinity, coberturaObjetivo: 30, stock: 0, stockMin: 5,
      rankMes: 0, rankReciente: 0, unidadesMes: 1,
    });
    expect(nivelPorPuntaje(p.score)).toBe('importante');
    expect(p.score).toBeLessThan(UMBRAL_SISI);
    expect(p.score).toBeGreaterThanOrEqual(UMBRAL_IMPORTANTE);
  });

  it('un envase abierto no es quedarse sin nada', () => {
    // La variedad mide en packs: 0,4 packs son 40 unidades sueltas. Sin el
    // aviso de `sinStock` el piso lo mandaba a "sí o sí" teniendo mercadería.
    const p = puntajeUrgencia({
      diasCobertura: 25, coberturaObjetivo: 30, stock: 0.4, stockMin: 1,
      sinStock: false, rankMes: 0.2, rankReciente: 0, unidadesMes: 4,
    });
    expect(nivelPorPuntaje(p.score)).not.toBe('sisi');
  });

  it('entre dos que no venden nada, ordena el que está más lejos del mínimo', () => {
    const lejos = puntajeUrgencia({ diasCobertura: Infinity, stock: 1, stockMin: 10, unidadesMes: 0 });
    const cerca = puntajeUrgencia({ diasCobertura: Infinity, stock: 8, stockMin: 10, unidadesMes: 0 });
    expect(lejos.score).toBeGreaterThan(cerca.score);
  });

  it('el de la semana caliente le gana al que solo figura en el mes', () => {
    const base = { diasCobertura: 5, coberturaObjetivo: 30, stock: 10, stockMin: 0, unidadesMes: 30 };
    const caliente = puntajeUrgencia({ ...base, rankMes: 0.6, rankReciente: 0.95 });
    const dormido = puntajeUrgencia({ ...base, rankMes: 0.6, rankReciente: 0 });
    expect(caliente.score).toBeGreaterThan(dormido.score);
  });
});

describe('el orden de la lista', () => {
  const fila = (nombre, extra) => ({ nombre, perdidaHorizonte: 0, vel_dia: 0, dias_cobertura: Infinity, ...extra });

  it('va del más urgente al que puede esperar', () => {
    const filas = [
      fila('TIJERA', { urgencia: 20 }),
      fila('HOJAS A4', { urgencia: 92 }),
      fila('CINTA', { urgencia: 47 }),
      fila('ADORNO', { urgencia: 3 }),
    ];
    filas.sort(compararUrgencia);
    expect(filas.map(f => f.nombre)).toEqual(['HOJAS A4', 'CINTA', 'TIJERA', 'ADORNO']);
  });

  it('los niveles quedan agrupados sin ordenar dos veces', () => {
    const filas = [30, 90, 5, 60, 19].map((u, i) => fila(`P${i}`, { urgencia: u }));
    filas.sort(compararUrgencia);
    const niveles = filas.map(f => nivelPorPuntaje(f.urgencia));
    expect(niveles).toEqual(['sisi', 'sisi', 'importante', 'importante', 'opcional']);
  });

  it('empatados en urgencia, primero el que hace perder más plata', () => {
    const filas = [
      fila('BARATO', { urgencia: 50, perdidaHorizonte: 1000 }),
      fila('CARO', { urgencia: 50, perdidaHorizonte: 90000 }),
    ];
    filas.sort(compararUrgencia);
    expect(filas[0].nombre).toBe('CARO');
  });
});

describe('por qué está donde está', () => {
  it('lo que más se vende en el mes lo dice', () => {
    const m = motivosUrgencia({ rank_mes: 0.97, rank_reciente: 0.5, unidades_7: 0, stock: 5, stock_min: 0 });
    expect(m.join(' ')).toContain('más se vende en el mes');
  });

  it('avisa cuando se está moviendo más que de costumbre', () => {
    const m = motivosUrgencia({
      rank_mes: 0.3, rank_reciente: 0.7, unidades_7: 20, dias_con_mov_7: 4,
      vel_dia_30: 1, vel_dia_7: 2.9, stock: 5, stock_min: 0,
    });
    expect(m.join(' ')).toContain('más que de costumbre');
  });

  it('una sola venta en la semana no genera un motivo', () => {
    const m = motivosUrgencia({
      rank_mes: 0.3, rank_reciente: 0.9, unidades_7: 50, dias_con_mov_7: 1,
      vel_dia_30: 1, vel_dia_7: 7, stock: 5, stock_min: 0,
    });
    expect(m.join(' ')).not.toContain('costumbre');
    expect(m.join(' ')).not.toContain('estos días');
  });

  it('una sola razón de venta, no cuatro frases con los mismos números', () => {
    const m = motivosUrgencia({
      rank_mes: 0.97, rank_reciente: 0.99, unidades_7: 20, dias_con_mov_7: 5,
      vel_dia_30: 1, vel_dia_7: 2.9, stock: 5, stock_min: 0,
    });
    expect(m).toEqual(['de lo que más se vende en el mes']);
  });

  it('dice cuando está por debajo del mínimo cargado', () => {
    expect(motivosUrgencia({ rank_mes: 0, stock: 2, stock_min: 10 }).join(' '))
      .toContain('debajo del mínimo');
  });

  it('sin stock no repite el mínimo: ya lo dice la cobertura', () => {
    expect(motivosUrgencia({ rank_mes: 0, stock: 0, stock_min: 10 })).toEqual([]);
  });

  it('la cuenta se puede leer entera', () => {
    const t = explicarUrgencia({
      urgencia: 87, riesgo: 0.87, importancia: 1, rank_mes: 0.98, rank_reciente: 0.9, stock_min: 0,
    });
    expect(t).toContain('Urgencia 87 de 100');
    expect(t).toContain('Riesgo de quedarse sin stock: 87%');
    expect(t).toContain('Peso en las ventas: 100%');
    expect(t).toContain('98%');   // lo que vende en el mes contra el resto
    expect(t).toContain('90%');   // y en los últimos días
    expect(t).not.toContain('Mínimo cargado');   // sin mínimo, no se inventa la línea
  });
});
