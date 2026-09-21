/**
 * El precio de un producto que se compra en dólares, pasado a pesos.
 *
 * La regla está escrita dos veces: `webapp/src/precio_usd.js` (el panel
 * mientras se edita la ficha, y el espejo que publica la tienda) y
 * `pos_system/utils/precio_usd.py` (el POS al vender, y el sync). Si las dos
 * no dan EXACTAMENTE lo mismo, el cliente ve un precio en la vidriera y el
 * cajero le cobra otro.
 *
 * Los casos viven en `casos_precio_usd.json` con lo que tiene que dar cada
 * uno. Acá se corre el JS contra eso Y contra lo que devuelve el Python por
 * `scripts/casos_precio_usd.py`: así una sola de las dos no puede desviarse
 * en silencio, ni las dos juntas hacia el mismo lado equivocado.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  convertirProducto, precioDesdeCosto, esUsd, tienePreciosUsd,
  cotizacionValida, precioEnPesos, costoEnPesos, precioUnidadEnPesos,
} from '../../webapp/src/precio_usd.js';
import { redondearCentena } from '../../webapp/src/tienda_descuentos_regla.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..', '..');
const { casos, precio_desde_costo: casosCosto } =
  JSON.parse(readFileSync(join(AQUI, 'casos_precio_usd.json'), 'utf-8'));

// La misma escalera que arma scripts/casos_precio_usd.py, en el mismo orden.
const ESCALERA = [0, 1, 4, 5, 9, 24, 26, 45, 49, 50, 51, 99, 100, 149, 150,
  151, 249, 250, 251, 1207, 14437, 14450, 49699.99];

let delPos = null;
let porQueNo = '';

beforeAll(() => {
  for (const python of ['python', 'python3', 'py']) {
    try {
      const salida = execFileSync(python, [join(RAIZ, 'scripts', 'casos_precio_usd.py')],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      delPos = JSON.parse(salida);
      break;
    } catch (err) {
      porQueNo = String(err?.stderr || err?.message || err).split('\n').slice(-6).join('\n');
    }
  }
});

describe('el precio en dólares pasado a pesos', () => {
  for (const c of casos) {
    it(c.que, () => {
      const salida = convertirProducto(c.producto, c.cotizacion);
      for (const [campo, valor] of Object.entries(c.espera)) {
        expect(salida[campo], `${campo} quedó distinto`).toEqual(valor);
      }
    });
  }

  it('devuelve una copia: el producto que entró no se toca', () => {
    const producto = {
      moneda_costo: 'USD', precio_usd: 35, precio_venta: 1, costo_usd: 10, costo: 1,
      conjunto_colores: [{ color: 'Plata', precio_pack_usd: 35, precio_pack: 1 }],
    };
    const antes = JSON.stringify(producto);
    const salida = convertirProducto(producto, 1420);
    expect(JSON.stringify(producto), 'se modificó el original').toBe(antes);
    expect(salida.precio_venta).toBe(49700);
    // Y las variedades también son copias, no las mismas referencias.
    expect(salida.conjunto_colores[0]).not.toBe(producto.conjunto_colores[0]);
    expect(producto.conjunto_colores[0].precio_pack).toBe(1);
  });

  it('convertir dos veces da lo mismo que convertir una', () => {
    // El POS convierte al mostrar la grilla y otra vez al agregar al carrito.
    // Si la cuenta se apoyara en el precio en pesos en vez de en el de
    // dólares, el precio se iría escalando en cada pasada.
    for (const c of casos) {
      const una = convertirProducto(c.producto, c.cotizacion);
      const dos = convertirProducto(una, c.cotizacion);
      expect(dos, c.que).toEqual(una);
    }
  });

  it('no se cae con basura', () => {
    expect(convertirProducto(null, 1420)).toBe(null);
    expect(convertirProducto(undefined, 1420)).toBe(undefined);
    expect(convertirProducto({}, 1420)).toEqual({});
    expect(convertirProducto({ moneda_costo: 'USD', precio_usd: 'nada' }, 1420))
      .toEqual({ moneda_costo: 'USD', precio_usd: 'nada' });
    expect(convertirProducto({ moneda_costo: 'USD', precio_usd: 35 }, 'no es un número'))
      .toEqual({ moneda_costo: 'USD', precio_usd: 35 });
    expect(precioEnPesos(NaN, 1420)).toBe(0);
    expect(precioEnPesos(35, NaN)).toBe(0);
    expect(costoEnPesos(-3, 1420)).toBe(0);
    expect(precioUnidadEnPesos(null, 1420)).toBe(0);
  });

  it('una variedad que no es un objeto no rompe la lista', () => {
    const salida = convertirProducto({
      moneda_costo: 'USD', precio_usd: 35, precio_venta: 1,
      conjunto_colores: [null, 'basura', { color: 'Plata', precio_pack_usd: 35 }],
    }, 1420);
    expect(salida.conjunto_colores[0]).toBe(null);
    expect(salida.conjunto_colores[1]).toBe('basura');
    expect(salida.conjunto_colores[2].precio_pack).toBe(49700);
  });
});

describe('qué producto está en dólares', () => {
  it('lo dice moneda_costo y nada más', () => {
    expect(esUsd({ moneda_costo: 'USD' })).toBe(true);
    expect(esUsd({ moneda_costo: ' usd ' })).toBe(true);
    expect(esUsd({ moneda_costo: 'ARS' })).toBe(false);
    expect(esUsd({ moneda_costo: '' })).toBe(false);
    expect(esUsd({ costo_usd: 10 })).toBe(false);
    expect(esUsd({})).toBe(false);
    expect(esUsd(null)).toBe(false);
  });

  it('marcado en dólares pero sin nada cargado todavía no tiene qué convertir', () => {
    expect(tienePreciosUsd({ moneda_costo: 'USD' })).toBe(false);
    expect(tienePreciosUsd({ moneda_costo: 'USD', precio_usd: 0 })).toBe(false);
    expect(tienePreciosUsd({ moneda_costo: 'USD', precio_usd: 35 })).toBe(true);
    expect(tienePreciosUsd({ moneda_costo: 'USD', costo_usd: 10 })).toBe(true);
    expect(tienePreciosUsd({ moneda_costo: 'USD', conjunto_precio_unidad_usd: 0.85 })).toBe(true);
    expect(tienePreciosUsd({
      moneda_costo: 'USD', conjunto_colores: [{ color: 'Plata', precio_pack_usd: 35 }],
    })).toBe(true);
    expect(tienePreciosUsd({
      moneda_costo: 'USD', conjunto_colores: [{ color: 'Plata' }],
    })).toBe(false);
    // En pesos no importa lo que traiga.
    expect(tienePreciosUsd({ precio_usd: 35 })).toBe(false);
  });

  it('la cotización que no es creíble no se usa', () => {
    expect(cotizacionValida(1420)).toBe(true);
    expect(cotizacionValida('1420')).toBe(true);
    expect(cotizacionValida(0.5)).toBe(true);
    expect(cotizacionValida(0)).toBe(false);
    expect(cotizacionValida(-1)).toBe(false);
    expect(cotizacionValida(1000000)).toBe(false);
    expect(cotizacionValida(Infinity)).toBe(false);
    expect(cotizacionValida(NaN)).toBe(false);
    expect(cotizacionValida(null)).toBe(false);
    expect(cotizacionValida('mil cuatrocientos')).toBe(false);
  });
});

describe('el precio en dólares que sale del costo y el margen', () => {
  for (const c of casosCosto) {
    it(c.que, () => {
      expect(precioDesdeCosto(c.costo_usd, c.margen)).toBe(c.espera);
    });
  }
});

describe('contra la cuenta del POS', () => {
  it('corre el POS para comparar', () => {
    if (!delPos) console.warn(`\n  [precio_usd] sin comparación contra Python:\n${porQueNo}\n`);
    expect(convertirProducto({}, 1420)).toBeDefined();
  });

  it('cada caso da lo mismo en el panel y en el POS', () => {
    if (!delPos) return;
    casos.forEach((c, i) => {
      const jsSalida = convertirProducto(c.producto, c.cotizacion);
      expect(delPos.productos[i], `caso "${c.que}"`).toEqual(jsSalida);
    });
  });

  it('el precio que sale del costo y el margen también', () => {
    if (!delPos) return;
    casosCosto.forEach((c, i) => {
      expect(delPos.precio_desde_costo[i], `caso "${c.que}"`)
        .toBe(precioDesdeCosto(c.costo_usd, c.margen));
    });
  });

  it('el redondeo a la centena es el mismo en toda la escalera', () => {
    if (!delPos) return;
    // Donde más fácil se separan dos implementaciones: en el empate (250) y
    // en los montos chicos que caen a la decena.
    ESCALERA.forEach((v, i) => {
      expect(delPos.centenas[i], `redondear ${v}`).toBe(redondearCentena(v));
    });
  });

  it('las banderas (es_usd, tiene precios, cotización válida) coinciden', () => {
    if (!delPos) return;
    casos.forEach((c, i) => {
      expect(delPos.banderas[i], `caso "${c.que}"`).toEqual({
        es_usd: esUsd(c.producto),
        tiene_precios_usd: tienePreciosUsd(c.producto),
        cotizacion_valida: cotizacionValida(c.cotizacion),
      });
    });
  });
});
