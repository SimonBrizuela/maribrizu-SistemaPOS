/**
 * Umbrales de stock expresados en cajas, packs y rollos.
 *
 * `stock_min` y `stock_max` SIEMPRE se guardan en unidades base: el POS, el
 * Centro de Compras y el resto del panel los leen así. Lo único que cambia con
 * `stock_alerta_um: 'bulto'` es cómo se escriben y cómo se muestran: el editor
 * convierte cajas ⇄ unidades y el aviso dice "quedan 2 cajas" en vez de "24".
 *
 * Dos cosas que tienen que salir bien:
 *
 *   1. Deducir el envase del nombre del producto sin inventarlo. Un falso
 *      positivo hace que el aviso salga con la cantidad equivocada, que es peor
 *      que no tener la función.
 *   2. Que ir y volver entre unidades y cajas no corra el umbral. El campo
 *      muestra las cajas con dos decimales: abrir el editor y guardar sin tocar
 *      nada convertía un mínimo de 7 unidades en 6,96 y el producto dejaba de
 *      avisar.
 */
import { describe, it, expect } from 'vitest';

import {
  detectarBulto, bultoDe, alertaPorBulto, labelTipo,
  aUnidades, aBultos, aUnidadesEstable, comoSeVeEnBultos,
  textoBultos, textoEquivalencia,
} from '../../webapp/src/bulto.js';

const CAJA12 = { tipo: 'caja', contenido: 12, sg: 'caja', pl: 'cajas' };

describe('deducir el envase del nombre', () => {
  it('lo escrito con conector', () => {
    expect(detectarBulto('LAPIZ FABER CAJA X 12')).toEqual({ tipo: 'caja', contenido: 12 });
    expect(detectarBulto('MOÑOS PACK DE 24')).toEqual({ tipo: 'pack', contenido: 24 });
    expect(detectarBulto('CARBONILLA BLISTER X 6')).toEqual({ tipo: 'blister', contenido: 6 });
  });

  it('"X 12 UN" sin decir el envase', () => {
    expect(detectarBulto('VELITA X 12 UN')).toEqual({ tipo: 'caja', contenido: 12 });
  });

  it('la docena y la media docena', () => {
    expect(detectarBulto('ALFILER X DOCENA')).toEqual({ tipo: 'docena', contenido: 12 });
    expect(detectarBulto('PIMPOLLO MEDIA DOCENA')).toEqual({ tipo: 'docena', contenido: 6 });
  });

  it('la resma son 500 hojas salvo que el nombre diga otra cosa', () => {
    expect(detectarBulto('RESMA A4 75GR')).toEqual({ tipo: 'resma', contenido: 500 });
    expect(detectarBulto('RESMA A4 120 GR X 100')).toEqual({ tipo: 'resma', contenido: 100 });
  });

  describe('lo que NO puede confundir con una cantidad', () => {
    // Un falso positivo acá manda un aviso con el número equivocado. Ante la
    // duda, no se detecta nada y el usuario lo carga a mano.
    const NO = [
      'CAJA 10 X 10',            // medida, no cantidad
      'SET 30 X 45',
      'BOLSA 1505/03',           // código de artículo
      'PAPEL 22 X 34 X 70GR',    // gramaje
      'CINTA 12 MM X 10 MT',     // metros
      'ABROJO 100MM X Mt',
      'MARCADOR X 100GR',
      'TIJERA 21 CM',
      'FUNDA NOTEBOOK 17',
    ];
    for (const nombre of NO) {
      it(`"${nombre}"`, () => expect(detectarBulto(nombre)).toBeNull());
    }
  });

  it('un envase de uno no es un envase', () => {
    expect(detectarBulto('CUADERNO CAJA X 1')).toBeNull();
  });

  it('sin nombre no hay nada que deducir', () => {
    expect(detectarBulto('')).toBeNull();
    expect(detectarBulto(null)).toBeNull();
  });
});

describe('de dónde sale el envase de un producto', () => {
  it('lo cargado a mano manda sobre todo lo demás', () => {
    const p = { nombre: 'LAPIZ CAJA X 12', bulto_contenido: 50, bulto_tipo: 'pack' };
    expect(bultoDe(p)).toMatchObject({ contenido: 50, tipo: 'pack', fuente: 'manual' });
  });

  it('después el conjunto', () => {
    const p = { nombre: 'CINTA', es_conjunto: true, conjunto_tipo: 'rollo', conjunto_contenido: 25 };
    expect(bultoDe(p)).toMatchObject({ contenido: 25, tipo: 'rollo', fuente: 'conjunto' });
  });

  it('y al final el nombre', () => {
    expect(bultoDe({ nombre: 'LAPIZ CAJA X 12' }))
      .toMatchObject({ contenido: 12, tipo: 'caja', fuente: 'nombre' });
  });

  it('un conjunto de uno no cuenta como envase', () => {
    const p = { nombre: 'CUADERNO', es_conjunto: true, conjunto_tipo: 'unidad', conjunto_contenido: 1 };
    expect(bultoDe(p)).toBeNull();
  });

  it('avisar por bulto pide las dos cosas: el interruptor y un envase', () => {
    expect(alertaPorBulto({ nombre: 'LAPIZ CAJA X 12', stock_alerta_um: 'bulto' }))
      .toMatchObject({ contenido: 12 });
    expect(alertaPorBulto({ nombre: 'LAPIZ CAJA X 12' })).toBeNull();
    expect(alertaPorBulto({ nombre: 'CUADERNO', stock_alerta_um: 'bulto' })).toBeNull();
  });

  it('un tipo desconocido cae en caja', () => {
    expect(labelTipo('inventado').sg).toBe('caja');
  });
});

describe('el umbral no se corre solo', () => {
  it('abrir y guardar sin tocar nada deja el mismo número', () => {
    // 7 unidades con cajas de 12 se ven como 0,58; volver de 0,58 daba 6,96 y
    // con stock 7 el producto dejaba de avisar.
    const enPantalla = comoSeVeEnBultos(7, CAJA12);
    expect(enPantalla).toBe(0.58);
    expect(aUnidades(enPantalla, CAJA12)).toBe(6.96);          // lo que pasaba antes
    expect(aUnidadesEstable(enPantalla, CAJA12, 7)).toBe(7);   // lo que pasa ahora
  });

  it('vale para cualquier umbral que no sea múltiplo del envase', () => {
    for (const unidades of [1, 5, 7, 13, 25, 100, 137]) {
      const visto = comoSeVeEnBultos(unidades, CAJA12);
      expect(aUnidadesEstable(visto, CAJA12, unidades)).toBe(unidades);
    }
  });

  it('si el usuario lo cambia, manda lo que escribió', () => {
    expect(aUnidadesEstable(2, CAJA12, 7)).toBe(24);
    expect(aUnidadesEstable(0.5, CAJA12, 7)).toBe(6);
  });

  it('sin valor guardado previo se convierte y listo', () => {
    expect(aUnidadesEstable(2, CAJA12, null)).toBe(24);
    expect(aUnidadesEstable(2, CAJA12, 0)).toBe(24);
  });

  it('sin envase, las unidades pasan tal cual', () => {
    expect(aUnidades(7, null)).toBe(7);
    expect(aBultos(7, { contenido: 0 })).toBe(7);
    expect(aUnidadesEstable(7, null, 7)).toBe(7);
  });
});

describe('cómo se lee la cantidad', () => {
  it('cajas enteras', () => {
    expect(textoBultos(24, CAJA12)).toBe('2 cajas');
    expect(textoBultos(12, CAJA12)).toBe('1 caja');
  });

  it('cajas más sueltas', () => {
    expect(textoBultos(29, CAJA12)).toBe('2 cajas + 5 u');
  });

  it('menos de una caja se dice en unidades', () => {
    expect(textoBultos(5, CAJA12)).toBe('5 u (menos de 1 caja)');
  });

  it('los umbrales van con decimal, que el resto suelto no aporta', () => {
    expect(textoBultos(18, CAJA12, { exacto: true })).toBe('1,5 cajas');
  });

  it('sin envase se cuenta en unidades', () => {
    expect(textoBultos(7, null)).toBe('7 u');
  });

  it('la equivalencia del editor', () => {
    expect(textoEquivalencia(24, CAJA12)).toBe('24 u = 2 cajas de 12');
    expect(textoEquivalencia(24, null)).toBe('');
  });
});
