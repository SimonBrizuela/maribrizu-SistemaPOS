/**
 * Guardar stock desde el panel sin pisar lo que se movió mientras tanto.
 *
 * El caso real (auditoría del 29-10): se abre la ficha de la goma eva con 200,
 * mientras está abierta el POS vende 139, se cambia el precio y se guarda. La
 * ficha escribía el 200 de la pantalla y las 139 vendidas volvían al stock.
 * Pasó 36 veces.
 *
 * Lo que tiene que salir bien:
 *   · sin tocar el stock, no se escribe stock;
 *   · tocándolo sin que la nube se mueva, queda lo que se escribió;
 *   · tocándolo con la nube movida, se pregunta, y cada respuesta da la
 *     cuenta que dice;
 *   · deshacer devuelve lo que cambió el paso, no el número viejo;
 *   · el "antes" del historial es el de la nube (el "+40" del deslizador).
 */
import { describe, it, expect } from 'vitest';
import {
  fotoStock, stockVisible, mismoStock, resolverGuardado, resolverDeshacer,
  aplicarPlan, tocaCamposDeStock, textoCarrera,
} from '../../webapp/src/stock_concurrencia.js';
import { totalConjunto } from '../../webapp/src/conjunto.js';

const plano = (stock, extra = {}) => ({ es_conjunto: false, stock, ...extra });

describe('el número que se le muestra a la persona', () => {
  it('un producto común muestra su stock', () => {
    expect(stockVisible(plano(12))).toBe(12);
  });

  it('un conjunto muestra el total, no el `stock` plano que la venta no toca', () => {
    // La venta del POS baja `conjunto_total` y deja `stock` atrás: mostrar
    // `stock` daba dos números distintos para el mismo producto.
    const p = { es_conjunto: true, stock: 110, conjunto_contenido: 50,
      conjunto_unidades: 1, conjunto_restante: 45, conjunto_total: 95 };
    expect(stockVisible(p)).toBe(95);
  });

  it('con variedades, la suma de las variedades', () => {
    const p = { es_conjunto: true, stock: 999, conjunto_contenido: 50, conjunto_colores: [
      { color: 'Rojo', unidades: 1, restante: 30 },
      { color: 'Azul', unidades: 2, restante: 0, contenido: 10 },
    ] };
    expect(stockVisible(p)).toBe(80 + 20);
  });

  it('un servicio es -1, no cero', () => {
    expect(stockVisible(plano(-1, { stock_ilimitado: true }))).toBe(-1);
  });

  it('dos fotos de distinta forma nunca son el mismo stock', () => {
    expect(mismoStock(fotoStock(plano(10)), fotoStock({ es_conjunto: true, conjunto_total: 10 }))).toBe(false);
  });
});

describe('producto común', () => {
  it('sin tocar el stock no se escribe stock, aunque en el medio se haya vendido', () => {
    const plan = resolverGuardado({
      inicial: plano(12), escrito: plano(12), visto: plano(12), nube: plano(10),
    });
    expect(plan.necesitaDecision).toBe(false);
    expect(plan.campos).toEqual({});
    expect(plan.omitir).toEqual(['stock']);
    expect(plan.antes).toBe(10);
    expect(plan.despues).toBe(10);
    expect(aplicarPlan({ precio_venta: 1, stock: 12 }, plan)).toEqual({ precio_venta: 1 });
  });

  it('un stock con decimales que nadie tocó no se redondea', () => {
    // La ficha lee el campo con parseInt: 2,5 se mostraba 2 y se guardaba 2.
    const plan = resolverGuardado({
      inicial: plano(2), escrito: plano(2), visto: plano(2.5), nube: plano(2.5),
    });
    expect(plan.omitir).toContain('stock');
    expect(plan.campos).toEqual({});
  });

  it('tocado y con la nube quieta, queda lo que escribió', () => {
    const plan = resolverGuardado({
      inicial: plano(12), escrito: plano(20), visto: plano(12), nube: plano(12),
    });
    expect(plan.necesitaDecision).toBe(false);
    expect(plan.campos).toEqual({ stock: 20 });
    expect([plan.antes, plan.despues]).toEqual([12, 20]);
  });

  it('tocado y con la nube movida, se pregunta y no se escribe nada todavía', () => {
    const plan = resolverGuardado({
      inicial: plano(12), escrito: plano(20), visto: plano(12), nube: plano(10),
    });
    expect(plan.necesitaDecision).toBe(true);
    expect(plan.campos).toBeNull();
    expect(plan.opciones).toEqual(['sumar', 'literal']);
    expect(plan.resumen).toMatchObject({ visto: 12, nube: 10, cambio: 8, sumado: 18, literal: 20 });
  });

  it('"sumar" aplica el cambio sobre la nube; "dejar" fija el número', () => {
    const base = { inicial: plano(12), escrito: plano(20), visto: plano(12), nube: plano(10) };
    const sumar = resolverGuardado({ ...base, decision: 'sumar' });
    expect(sumar.campos).toEqual({ stock: 18 });
    expect([sumar.antes, sumar.despues]).toEqual([10, 18]);
    const literal = resolverGuardado({ ...base, decision: 'literal' });
    expect(literal.campos).toEqual({ stock: 20 });
    expect([literal.antes, literal.despues]).toEqual([10, 20]);
  });

  it('sumar una baja nunca deja stock negativo', () => {
    const plan = resolverGuardado({
      inicial: plano(5), escrito: plano(0), visto: plano(5), nube: plano(3), decision: 'sumar',
    });
    expect(plan.campos).toEqual({ stock: 0 });
  });

  it('un servicio (-1) no se suma: sólo se puede fijar', () => {
    const plan = resolverGuardado({
      inicial: plano(0), escrito: plano(10), visto: plano(-1), nube: plano(5),
    });
    expect(plan.opciones).toEqual(['literal']);
  });

  it('un servicio que nadie tocó sigue siendo servicio', () => {
    // La ficha muestra -1 y lo guardaba como 0.
    const plan = resolverGuardado({
      inicial: plano(0), escrito: plano(0), visto: plano(-1, { stock_ilimitado: true }),
      nube: plano(-1, { stock_ilimitado: true }),
    });
    expect(plan.omitir).toContain('stock');
  });
});

describe('conjunto sin variedades', () => {
  const conj = (u, r, extra = {}) => ({ es_conjunto: true, conjunto_contenido: 50,
    conjunto_unidades: u, conjunto_restante: r, conjunto_total: u * 50 + r, ...extra });

  it('sin tocar packs ni sueltos no se escribe ningún número', () => {
    const plan = resolverGuardado({
      inicial: conj(2, 10), escrito: conj(2, 10), visto: conj(2, 10), nube: conj(1, 45),
    });
    expect(plan.necesitaDecision).toBe(false);
    expect(plan.omitir.sort()).toEqual(['conjunto_restante', 'conjunto_total', 'conjunto_unidades', 'stock']);
  });

  it('sumar dos packs sobre una venta de 15', () => {
    const base = { inicial: conj(2, 10), escrito: conj(4, 10), visto: conj(2, 10), nube: conj(1, 45) };
    const preg = resolverGuardado(base);
    expect(preg.necesitaDecision).toBe(true);
    expect(preg.resumen).toMatchObject({ visto: 110, nube: 95, cambio: 100, sumado: 195, literal: 210 });

    const sumar = resolverGuardado({ ...base, decision: 'sumar' });
    expect(sumar.campos).toEqual({ stock: 195, conjunto_unidades: 3, conjunto_restante: 45, conjunto_total: 195 });
    expect([sumar.antes, sumar.despues]).toEqual([95, 195]);

    const literal = resolverGuardado({ ...base, decision: 'literal' });
    expect(literal.campos).toMatchObject({ conjunto_unidades: 4, conjunto_restante: 10, conjunto_total: 210 });
  });

  it('si los sueltos no alcanzan para la baja, se abre un pack (misma cuenta que el POS)', () => {
    // Bajó 10 sueltos, pero en el medio se vendieron 5: quedan 95 en total.
    const plan = resolverGuardado({
      inicial: conj(2, 10), escrito: conj(2, 0), visto: conj(2, 10), nube: conj(2, 5), decision: 'sumar',
    });
    expect(plan.campos).toMatchObject({ conjunto_unidades: 1, conjunto_restante: 45, conjunto_total: 95 });
  });

  it('sueltos vacíos se guardan vacíos, como siempre', () => {
    const plan = resolverGuardado({
      inicial: conj(2, null), escrito: conj(3, null), visto: conj(2, null), nube: conj(2, null),
    });
    expect(plan.campos.conjunto_restante).toBeNull();
    expect(plan.campos.conjunto_total).toBe(150);
  });
});

describe('conjunto con variedades', () => {
  const conVars = (vars, extra = {}) => ({
    es_conjunto: true, conjunto_contenido: 50, conjunto_colores: vars,
    conjunto_total: totalConjunto(vars, 50), ...extra,
  });
  const visto = conVars([
    { color: 'Rojo', unidades: 2, restante: 0, precio_pack: 1000 },
    { color: 'Azul', unidades: 1, restante: 0, precio_pack: 1000 },
  ]);
  // El POS vendió 20 del rojo: abrió un pack y quedan 30 sueltos.
  const nube = conVars([
    { color: 'Rojo', unidades: 1, restante: 30, precio_pack: 1000 },
    { color: 'Azul', unidades: 1, restante: 0, precio_pack: 1000 },
  ]);

  it('cambiar sólo un precio escribe las variedades con el stock de la nube', () => {
    const escrito = conVars([
      { color: 'Rojo', unidades: 2, restante: 0, precio_pack: 1200 },
      { color: 'Azul', unidades: 1, restante: 0, precio_pack: 1000 },
    ]);
    const plan = resolverGuardado({ inicial: visto, escrito, visto, nube });
    expect(plan.necesitaDecision).toBe(false);
    const rojo = plan.campos.conjunto_colores.find(c => c.color === 'Rojo');
    expect(rojo).toMatchObject({ unidades: 1, restante: 30, precio_pack: 1200 });
    expect(plan.omitir).toContain('conjunto_total');
    expect(plan.omitir).not.toContain('conjunto_colores');
    expect(plan.despues).toBe(plan.antes);
  });

  it('cargar un pack de azul sobre la venta de rojo: sumar respeta la venta', () => {
    const escrito = conVars([
      { color: 'Rojo', unidades: 2, restante: 0, precio_pack: 1000 },
      { color: 'Azul', unidades: 2, restante: 0, precio_pack: 1000 },
    ]);
    const base = { inicial: visto, escrito, visto, nube };
    expect(resolverGuardado(base).necesitaDecision).toBe(true);

    const sumar = resolverGuardado({ ...base, decision: 'sumar' });
    const porColor = Object.fromEntries(sumar.campos.conjunto_colores.map(c => [c.color, [c.unidades, c.restante]]));
    expect(porColor).toEqual({ Rojo: [1, 30], Azul: [2, 0] });
    expect(sumar.campos).toMatchObject({ conjunto_total: 180, stock: 180, conjunto_unidades: 3, conjunto_restante: 30 });
    expect([sumar.antes, sumar.despues]).toEqual([130, 180]);

    const literal = resolverGuardado({ ...base, decision: 'literal' });
    expect(literal.campos.conjunto_total).toBe(200);
  });

  it('una variedad que agregó otra pantalla mientras tanto no se pierde', () => {
    const nubeConVerde = conVars([...nube.conjunto_colores, { color: 'Verde', unidades: 3, restante: 0 }]);
    const escrito = conVars([
      { color: 'Rojo', unidades: 2, restante: 0, precio_pack: 1300 },
      { color: 'Azul', unidades: 1, restante: 0, precio_pack: 1000 },
    ]);
    const plan = resolverGuardado({ inicial: visto, escrito, visto, nube: nubeConVerde });
    expect(plan.campos.conjunto_colores.map(c => c.color)).toEqual(['Rojo', 'Azul', 'Verde']);
  });

  it('borrar una variedad vacía a la que en el medio le cargaron stock se pregunta', () => {
    const v = conVars([
      { color: 'Rojo', unidades: 2, restante: 0 }, { color: 'Azul', unidades: 0, restante: 0 },
    ]);
    const n = conVars([
      { color: 'Rojo', unidades: 2, restante: 0 }, { color: 'Azul', unidades: 3, restante: 0 },
    ]);
    const escrito = conVars([{ color: 'Rojo', unidades: 2, restante: 0 }]);
    const plan = resolverGuardado({ inicial: v, escrito, visto: v, nube: n });
    expect(plan.necesitaDecision).toBe(true);
  });

  it('el nombre de la variedad se compara sin mayúsculas, como en el POS', () => {
    const escrito = conVars([
      { color: 'ROJO', unidades: 2, restante: 0, precio_pack: 1000 },
      { color: 'Azul', unidades: 1, restante: 0, precio_pack: 1000 },
    ]);
    const plan = resolverGuardado({ inicial: visto, escrito, visto, nube });
    expect(plan.necesitaDecision).toBe(false);
    expect(plan.campos.conjunto_colores[0]).toMatchObject({ color: 'ROJO', unidades: 1, restante: 30 });
  });
});

describe('cambiar la forma del producto', () => {
  it('convertir en conjunto anota el antes real (el "+40" del deslizador)', () => {
    // DESLIZADOR CIERRE: tenía 103 sueltos y se convirtió en conjunto con 40.
    // El historial decía "de 0 a 40" porque leía el `conjunto_total` que el
    // producto todavía no tenía.
    const visto = plano(103);
    const escrito = { stock: 40, es_conjunto: true, conjunto_contenido: 1,
      conjunto_unidades: 40, conjunto_restante: null, conjunto_total: 40 };
    const plan = resolverGuardado({ inicial: plano(103), escrito, visto, nube: plano(103) });
    expect(plan.necesitaDecision).toBe(false);
    expect([plan.antes, plan.despues]).toEqual([103, 40]);
  });

  it('si además se vendió en el medio, sólo se puede fijar lo escrito', () => {
    const escrito = { es_conjunto: true, conjunto_contenido: 1, conjunto_unidades: 40, conjunto_total: 40 };
    const base = { inicial: plano(103), escrito, visto: plano(103), nube: plano(101) };
    const plan = resolverGuardado(base);
    expect(plan.necesitaDecision).toBe(true);
    expect(plan.opciones).toEqual(['literal']);
    // "Sumar" no está entre las opciones: se vuelve a preguntar.
    expect(resolverGuardado({ ...base, decision: 'sumar' }).necesitaDecision).toBe(true);
    const lit = resolverGuardado({ ...base, decision: 'literal' });
    expect([lit.antes, lit.despues]).toEqual([101, 40]);
  });

  it('si otra pantalla lo convirtió mientras tanto, se pregunta aunque no se haya tocado el stock', () => {
    const nube = { es_conjunto: true, conjunto_contenido: 10, conjunto_unidades: 1, conjunto_total: 10 };
    const plan = resolverGuardado({ inicial: plano(10), escrito: plano(10), visto: plano(10), nube });
    expect(plan.necesitaDecision).toBe(true);
    expect(plan.resumen.cambioForma).toBe(true);
  });
});

describe('sin carrera, sumar y dejar son lo mismo', () => {
  // Si nadie movió la nube, las dos respuestas tienen que dar el mismo
  // número: si no, el diálogo estaría eligiendo entre dos cosas que no son
  // lo que la persona ve.
  const casos = [
    [plano(7), plano(19)],
    [{ es_conjunto: true, conjunto_contenido: 12, conjunto_unidades: 3, conjunto_restante: 5 },
     { es_conjunto: true, conjunto_contenido: 12, conjunto_unidades: 1, conjunto_restante: 11 }],
    [{ es_conjunto: true, conjunto_contenido: 10, conjunto_colores: [{ color: 'A', unidades: 1, restante: 2 }] },
     { es_conjunto: true, conjunto_contenido: 10, conjunto_colores: [{ color: 'A', unidades: 4, restante: 0 }, { color: 'B', unidades: 1, restante: 0 }] }],
  ];
  for (const [antes, despues] of casos) {
    it(`${antes.es_conjunto ? 'conjunto' : 'plano'} ${stockVisible(antes)} → ${stockVisible(despues)}`, () => {
      const base = { inicial: antes, escrito: despues, visto: antes, nube: antes };
      const s = resolverGuardado({ ...base, decision: 'sumar' });
      const sinPreguntar = resolverGuardado(base);
      expect(sinPreguntar.necesitaDecision).toBe(false);
      expect(s.despues).toBe(sinPreguntar.despues);
      expect(sinPreguntar.despues).toBe(stockVisible(despues));
    });
  }
});

describe('deshacer', () => {
  it('deshace el cambio, no vuelve al número viejo: la venta del medio queda', () => {
    // Celda: 8 → 12. Después el POS vende 2 (queda 10). Deshacer: 10 − 4 = 6.
    const deshacer = resolverDeshacer({ desde: { stock: 12 }, hacia: { stock: 8 }, nube: plano(10, { nombre: 'X' }) });
    expect(deshacer.campos).toEqual({ stock: 6 });
    expect([deshacer.antes, deshacer.despues]).toEqual([10, 6]);
    // Rehacer vuelve a sumar los 4.
    const rehacer = resolverDeshacer({ desde: { stock: 8 }, hacia: { stock: 12 }, nube: plano(6) });
    expect(rehacer.campos).toEqual({ stock: 10 });
  });

  it('una reposición suma sobre lo de hoy, aunque sea negativo (vendido sin reponer)', () => {
    // La reposición de Inventario usa la misma cuenta: -6 + 10 = 4, y si en
    // el medio se vendieron 2 más, -8 + 10 = 2.
    const r = resolverDeshacer({ desde: { stock: -6 }, hacia: { stock: 4 }, nube: plano(-8) });
    expect(r.campos).toEqual({ stock: 2 });
    expect([r.antes, r.despues]).toEqual([-8, 2]);
  });

  it('sin nada en el medio, deshacer deja exactamente lo de antes', () => {
    const plan = resolverDeshacer({ desde: { stock: 12 }, hacia: { stock: 8 }, nube: plano(12) });
    expect(plan.campos).toEqual({ stock: 8 });
  });

  it('deshacer una carga por variedad respeta lo que se vendió de otra', () => {
    const antes = [{ color: 'Rojo', unidades: 1, restante: 0 }, { color: 'Azul', unidades: 1, restante: 0 }];
    const despues = [{ color: 'Rojo', unidades: 3, restante: 0 }, { color: 'Azul', unidades: 1, restante: 0 }];
    const nube = { es_conjunto: true, conjunto_contenido: 10,
      conjunto_colores: [{ color: 'Rojo', unidades: 3, restante: 0 }, { color: 'Azul', unidades: 0, restante: 6 }] };
    const plan = resolverDeshacer({
      desde: { conjunto_colores: despues, conjunto_total: 40 },
      hacia: { conjunto_colores: antes, conjunto_total: 20 },
      nube,
    });
    const porColor = Object.fromEntries(plan.campos.conjunto_colores.map(c => [c.color, [c.unidades, c.restante]]));
    expect(porColor).toEqual({ Rojo: [1, 0], Azul: [0, 6] });
    expect(plan.campos.conjunto_total).toBe(16);
  });

  it('deshacer una conversión a conjunto vuelve a la forma de antes tal cual', () => {
    const plan = resolverDeshacer({
      desde: { es_conjunto: true, conjunto_contenido: 1, conjunto_unidades: 40, conjunto_total: 40 },
      hacia: { es_conjunto: false, stock: 103, conjunto_total: null },
      nube: { es_conjunto: true, conjunto_contenido: 1, conjunto_unidades: 38, conjunto_total: 38 },
    });
    expect(plan.campos).toEqual({ stock: 103 });
  });
});

describe('piezas sueltas', () => {
  it('qué campos son de stock', () => {
    expect(tocaCamposDeStock({ stock: 3 })).toBe(true);
    expect(tocaCamposDeStock({ conjunto_colores: [] })).toBe(true);
    expect(tocaCamposDeStock({ stock_min: 3, precio_venta: 1 })).toBe(false);
  });

  it('el aviso dice de cuánto a cuánto y qué queda con cada opción', () => {
    const t = textoCarrera({ visto: 200, nube: 61, cambio: 10, sumado: 71, literal: 210 });
    expect(t.cuerpo).toContain('200');
    expect(t.cuerpo).toContain('61');
    expect(t.cuerpo).toContain('+10');
    expect(t.sumar).toContain('71');
    expect(t.literal).toContain('210');
  });

  it('cuando cambió la forma no ofrece sumar', () => {
    const t = textoCarrera({ visto: 10, nube: 10, cambio: 0, sumado: null, literal: 10, cambioForma: true });
    expect(t.sumar).toBeNull();
  });
});
