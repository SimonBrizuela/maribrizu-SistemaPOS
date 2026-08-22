/**
 * Un pedido entregado sale del stock y entra en las ventas.
 *
 * `webapp/src/pedido_venta.js` no toca Firebase: acá se fija qué descuenta
 * cada renglón (suelto, pack, conjunto, variedad) y cómo queda la venta que
 * después leen Historial y Control Total.
 */
import { describe, it, expect } from 'vitest';
import {
  planDescuento, documentosDeVenta, unidadesBase, variedadDelCatalogo, PC_TIENDA,
} from '../../webapp/src/pedido_venta.js';

const item = (extra) => ({ id: 'X', nombre: 'Producto', cantidad: 1, precio: 100, subtotal: 100,
                           unidad: 'unidad', es_pack: false, pack_contenido: null, variedad: null, ...extra });

describe('unidades base de un renglón', () => {
  it('suelto: la cantidad tal cual (unidades o metros)', () => {
    expect(unidadesBase(item({ cantidad: 3 }))).toBe(3);
    expect(unidadesBase(item({ cantidad: 2.5, unidad: 'metro' }))).toBe(2.5);
  });
  it('pack: cantidad por contenido', () => {
    expect(unidadesBase(item({ cantidad: 2, es_pack: true, pack_contenido: 10 }))).toBe(20);
  });
});

describe('la variedad del catálogo', () => {
  const datos = {
    conjunto_colores: [{ color: 'ROJO', unidades: 1, restante: 2 }, { color: 'Azul Francia', unidades: 0, restante: 5 }],
    tienda_variedades: { 'azul francia': { nombre: 'Azul' } },
  };
  it('por el nombre del catálogo, sin importar mayúsculas ni acentos', () => {
    expect(variedadDelCatalogo(datos, 'rojo').color).toBe('ROJO');
    expect(variedadDelCatalogo(datos, 'Azul Francia').color).toBe('Azul Francia');
  });
  it('por el nombre público que le puso el panel', () => {
    expect(variedadDelCatalogo(datos, 'Azul').color).toBe('Azul Francia');
  });
  it('si no está, nada', () => {
    expect(variedadDelCatalogo(datos, 'Verde')).toBe(null);
    expect(variedadDelCatalogo(datos, '')).toBe(null);
  });
});

describe('plan de descuento', () => {
  it('producto simple: resta la cantidad y puede quedar negativo, como en el POS', () => {
    const plan = planDescuento([item({ id: 'A', cantidad: 3 })], { A: { nombre: 'GOMA', stock: 2 } });
    expect(plan.productos).toHaveLength(1);
    expect(plan.productos[0].campos).toEqual({ stock: -1 });
    expect(plan.productos[0].movimientos).toEqual([{ antes: 2, despues: -1, cantidad: -3, detalle: '' }]);
    expect(plan.saltados).toEqual([]);
  });
  it('conjunto sin variedades: descuenta del total y reparte, el pack abre solo', () => {
    const cat = { P: { nombre: 'PAPEL CREPE', es_conjunto: true, conjunto_contenido: 10, conjunto_total: 25, conjunto_unidades: 2, conjunto_restante: 5, stock: 25 } };
    const plan = planDescuento([item({ id: 'P', cantidad: 7 })], cat);
    expect(plan.productos[0].campos).toEqual({ conjunto_total: 18, conjunto_unidades: 1, conjunto_restante: 8, stock: 18 });
    expect(plan.productos[0].movimientos[0]).toEqual({ antes: 25, despues: 18, cantidad: -7, detalle: '' });
  });
  it('pack de un conjunto: cantidad × contenido', () => {
    const cat = { P: { nombre: 'PAPEL CREPE', es_conjunto: true, conjunto_contenido: 10, conjunto_total: 25, stock: 25 } };
    const plan = planDescuento([item({ id: 'P', cantidad: 2, es_pack: true, pack_contenido: 10, pack_nombre: 'pack' })], cat);
    expect(plan.productos[0].campos.conjunto_total).toBe(5);
    expect(plan.productos[0].movimientos[0].detalle).toBe('(2 packs)');
  });
  it('variedad: descuenta esa y recalcula los agregados del producto', () => {
    const cat = { C: {
      nombre: 'CARTULINA', es_conjunto: true, conjunto_contenido: 50,
      conjunto_colores: [{ color: 'ROJO', unidades: 1, restante: 10 }, { color: 'AZUL', unidades: 2, restante: 0 }],
      conjunto_total: 160,
    } };
    const plan = planDescuento([item({ id: 'C', cantidad: 15, variedad: 'Rojo' })], cat);
    const p = plan.productos[0];
    expect(p.campos.conjunto_colores).toEqual([{ color: 'ROJO', unidades: 0, restante: 45 }, { color: 'AZUL', unidades: 2, restante: 0 }]);
    expect(p.campos.conjunto_total).toBe(145);
    expect(p.campos.conjunto_unidades).toBe(2);
    expect(p.campos.conjunto_restante).toBe(45);
    expect(p.campos.stock).toBe(145);
    expect(p.movimientos[0]).toEqual({ antes: 160, despues: 145, cantidad: -15, detalle: 'Variedad ROJO' });
  });
  it('dos renglones del mismo producto se aplican uno después del otro', () => {
    const cat = { C: {
      nombre: 'CARTULINA', es_conjunto: true, conjunto_contenido: 50,
      conjunto_colores: [{ color: 'ROJO', unidades: 1, restante: 10 }, { color: 'AZUL', unidades: 2, restante: 0 }],
      conjunto_total: 160,
    } };
    const plan = planDescuento([item({ id: 'C', cantidad: 5, variedad: 'Rojo' }), item({ id: 'C', cantidad: 50, variedad: 'Azul' })], cat);
    const p = plan.productos[0];
    expect(plan.productos).toHaveLength(1);
    expect(p.campos.conjunto_total).toBe(105);
    expect(p.movimientos.map(m => [m.antes, m.despues])).toEqual([[160, 155], [155, 105]]);
  });
  it('lo que no se puede descontar se saltea y se dice por qué', () => {
    const cat = { S: { nombre: 'FOTOCOPIA', stock: -1, stock_ilimitado: true },
                  V: { nombre: 'X', es_conjunto: true, conjunto_contenido: 1, conjunto_colores: [{ color: 'A' }] } };
    const plan = planDescuento([
      item({ id: 'S' }), item({ id: 'NADIE' }), item({ id: 'V', variedad: 'Z' }), item({ id: '', cantidad: 1 }), item({ id: 'V', cantidad: 0, variedad: 'A' }),
    ], cat);
    expect(plan.saltados.map(s => s.motivo)).toEqual([
      'servicio sin stock', 'no está en el catálogo', 'variedad "Z" no encontrada', 'renglón sin producto', 'cantidad en cero',
    ]);
    expect(plan.productos.find(p => p.id === 'V').campos).toEqual({});
  });
  it('no modifica los documentos que recibió', () => {
    const cat = { A: { nombre: 'GOMA', stock: 2 } };
    planDescuento([item({ id: 'A', cantidad: 3 })], cat);
    expect(cat.A.stock).toBe(2);
  });
});

describe('la venta que se escribe', () => {
  const pedido = {
    codigo: 'AB12', total: 7800, subtotal: 7500, envio: 300,
    pago: { modo: 'transferencia', pagado: true },
    cliente: { nombre: 'Ana' },
    items: [
      { id: 'P', nombre: 'Papel Crepe Comun X Un', cantidad: 1, precio: 7500, subtotal: 7500, unidad: 'unidad', es_pack: true, pack_contenido: 10, variedad: 'Rojo' },
    ],
  };
  const cat = { P: { nombre: 'PAPEL CREPE COMUN X UN', categoria: 'PAPELERA', es_conjunto: true, conjunto_contenido: 10,
                     conjunto_colores: [{ color: 'ROJO', unidades: 3, restante: 0 }] } };
  const ahora = new Date('2026-08-22T20:05:09-03:00');
  const { ventaId, venta, lineas } = documentosDeVenta(pedido, 'doc1', cat, ahora);

  it('va como PC TIENDA con el código del pedido', () => {
    expect(ventaId).toBe('TIENDA_AB12');
    expect(venta.pc_id).toBe(PC_TIENDA);
    expect(venta.num_venta).toBe('AB12');
    expect(venta.payment_type).toBe('transfer');
    expect(venta.transfer_amount).toBe(7800);
    expect(venta.total_amount).toBe(7800);
    expect(venta.cash_register_id).toBe(null);
    expect(venta.origen).toBe('tienda');
    expect(venta.items_count).toBe(2);
  });
  it('cada renglón como en ventas_por_dia, con el nombre del catálogo y el envío aparte', () => {
    expect(lineas.map(l => l.docId)).toEqual(['TIENDA_AB12_0', 'TIENDA_AB12_1']);
    const l0 = lineas[0].datos;
    expect(l0.producto).toBe('PAPEL CREPE COMUN X UN');
    expect(l0.categoria).toBe('PAPELERA');
    expect(l0.cantidad).toBe(1);
    expect(l0.precio_unitario).toBe(7500);
    expect(l0.subtotal).toBe(7500);
    expect(l0.tipo_pago).toBe('Transferencia');
    expect(l0.conjunto_color).toBe('ROJO');
    expect(l0.es_pack).toBe(true);
    expect(l0.fecha).toBe('22/08/2026');
    expect(l0.hora).toBe('20:05:09');
    expect(l0.pc_id).toBe('TIENDA');
    expect(l0.consumibles_procesado).toBe(true);
    const envio = lineas[1].datos;
    expect(envio.producto).toBe('ENVIO A DOMICILIO');
    expect(envio.subtotal).toBe(300);
  });
  it('en efectivo, el efectivo recibido es el total y no hay línea de envío si es cero', () => {
    const r = documentosDeVenta({ ...pedido, envio: 0, total: 7500, pago: { modo: 'efectivo' } }, 'doc1', cat, ahora);
    expect(r.venta.payment_type).toBe('cash');
    expect(r.venta.cash_received).toBe(7500);
    expect(r.lineas).toHaveLength(1);
    expect(r.lineas[0].datos.tipo_pago).toBe('Efectivo');
  });
});
