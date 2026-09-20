// @vitest-environment jsdom
/**
 * El aviso de "se está vendiendo sin caja abierta".
 *
 * Existe por el sábado 05/09/2026: se cerró la caja el viernes a las 20:29,
 * nadie abrió una nueva y las 127 ventas del sábado se fueron pegando a tres
 * cajas viejas que cada PC tenía guardadas. Nadie se enteró
 * hasta el lunes.
 *
 * Los dos errores posibles del aviso son opuestos y los dos caros: si no salta,
 * se repite el sábado; si salta de más —todas las noches hay unos segundos
 * entre el cierre de una caja y la apertura de la siguiente— nadie lo va a
 * mirar cuando importe.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase/firestore', async () => (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {} }));

const { evaluarCaja, cajaAbiertaId, aMillis, textoDelAviso } =
  await import('../../webapp/src/caja_watcher.js');

const T = (iso) => new Date(iso).getTime();

// Un renglón de ventas_por_dia como los que guarda el POS.
const item = (extra = {}) => ({
  num_venta: 1,
  pc_id: 'LIBRERIA-1',
  subtotal: 1000,
  cash_register_id: 126,
  fecha: '05/09/2026',
  fecha_dt: new Date('2026-09-05T12:00:00-03:00'),
  producto: 'CUADERNO',
  ...extra,
});

const cerrada = { status: 'closed', id: 126, updated_at: '2026-09-04T20:29:00-03:00' };
const abierta = { status: 'open', id: 127, opening_date: '2026-09-05T08:30:00-03:00' };

const AHORA = T('2026-09-05T20:00:00-03:00');

describe('cuál es la caja abierta', () => {
  it('no hay ninguna si el doc dice cerrada', () => {
    expect(cajaAbiertaId(cerrada)).toBe(null);
    expect(cajaAbiertaId(null)).toBe(null);
  });

  it('acepta el id venga como `id` o como `register_id`', () => {
    expect(cajaAbiertaId({ status: 'open', id: 127 })).toBe(127);
    expect(cajaAbiertaId({ status: 'open', register_id: '131' })).toBe(131);
  });
});

describe('fechas de Firestore', () => {
  it('entiende Timestamp, Date y texto ISO', () => {
    const esperado = T('2026-09-05T12:00:00-03:00');
    expect(aMillis(new Date('2026-09-05T12:00:00-03:00'))).toBe(esperado);
    expect(aMillis('2026-09-05T12:00:00-03:00')).toBe(esperado);
    expect(aMillis({ seconds: Math.floor(esperado / 1000), nanoseconds: 0 })).toBe(esperado);
    expect(aMillis({ toDate: () => new Date(esperado) })).toBe(esperado);
    expect(aMillis(null)).toBe(null);
    expect(aMillis('cualquier cosa')).toBe(null);
  });
});

describe('el sábado que no abrieron caja', () => {
  it('avisa con las ventas, la plata y desde qué hora', () => {
    const items = [
      item({ num_venta: 10, cash_register_id: 123, subtotal: 5000, pc_id: 'LIBRERIA-1',
             fecha_dt: new Date('2026-09-05T09:16:00-03:00') }),
      item({ num_venta: 11, cash_register_id: 125, subtotal: 3000, pc_id: 'DESKTOP8',
             fecha_dt: new Date('2026-09-05T10:00:00-03:00') }),
    ];
    const a = evaluarCaja({ cajaActiva: cerrada, items, ahora: AHORA });
    expect(a.tipo).toBe('sin_caja');
    expect(a.ventas).toBe(2);
    expect(a.total).toBe(8000);
    expect(a.pcs).toEqual(['DESKTOP8', 'LIBRERIA-1']);
    expect(a.desde).toBe(T('2026-09-05T09:16:00-03:00'));
  });

  it('los renglones de una misma venta cuentan como una sola venta', () => {
    const items = [
      item({ num_venta: 10, subtotal: 5000 }),
      item({ num_venta: 10, subtotal: 2000 }),
    ];
    const a = evaluarCaja({ cajaActiva: cerrada, items, ahora: AHORA });
    expect(a.ventas).toBe(1);
    expect(a.total).toBe(7000);
  });

  it('no cuenta lo borrado ni los VARIOS 2', () => {
    const items = [
      item({ num_venta: 10, subtotal: 5000 }),
      item({ num_venta: 11, subtotal: 9999, deleted: true }),
      item({ num_venta: 12, subtotal: 8888, producto: 'VARIOS 2' }),
    ];
    const a = evaluarCaja({ cajaActiva: cerrada, items, ahora: AHORA });
    expect(a.ventas).toBe(1);
    expect(a.total).toBe(5000);
  });

  it('sin caja abierta pero sin ventas todavía, no molesta', () => {
    expect(evaluarCaja({ cajaActiva: cerrada, items: [], ahora: AHORA })).toBe(null);
  });
});

describe('la rotación de todas las noches', () => {
  it('los segundos entre un cierre y la apertura siguiente no disparan nada', () => {
    const cerroRecien = { status: 'closed', id: 126, updated_at: '2026-09-05T20:29:00-03:00' };
    const items = [item({ fecha_dt: new Date('2026-09-05T20:29:30-03:00') })];
    const a = evaluarCaja({ cajaActiva: cerroRecien, items, ahora: T('2026-09-05T20:29:40-03:00') });
    expect(a).toBe(null);
  });

  it('pero si al rato siguen vendiendo con la caja sin abrir, sí', () => {
    const cerroRecien = { status: 'closed', id: 126, updated_at: '2026-09-05T20:29:00-03:00' };
    const items = [item({ fecha_dt: new Date('2026-09-05T20:45:00-03:00') })];
    const a = evaluarCaja({ cajaActiva: cerroRecien, items, ahora: T('2026-09-05T20:50:00-03:00') });
    expect(a.tipo).toBe('sin_caja');
  });

  // La venta 5566 del 19/09: se cobró 21 segundos después de cerrar la caja y
  // se le quedó pegado el número de esa misma caja, así que está en su cierre.
  // El panel la estaba acusando de andar suelta.
  it('lo que se cobra en el minuto del cierre queda en esa caja, no se acusa', () => {
    const cerroRecien = { status: 'closed', id: 139, register_id: 139,
                          opening_date: '2026-09-18T20:28:00-03:00',
                          updated_at: '2026-09-19T20:33:04-03:00' };
    const items = [item({ num_venta: 5566, cash_register_id: 139, subtotal: 16400,
                          fecha: '19/09/2026',
                          fecha_dt: new Date('2026-09-19T20:33:26-03:00') })];
    expect(evaluarCaja({ cajaActiva: cerroRecien, items, ahora: T('2026-09-19T21:45:00-03:00') }))
      .toBe(null);
  });

  it('las ventas de antes del cierre no acusan a nadie', () => {
    // Todo el día vendió bien con la 126; recién cerró. No hay nada que avisar.
    const cerroRecien = { status: 'closed', id: 126, updated_at: '2026-09-05T20:29:00-03:00' };
    const items = [item({ fecha_dt: new Date('2026-09-05T11:00:00-03:00') })];
    expect(evaluarCaja({ cajaActiva: cerroRecien, items, ahora: T('2026-09-05T21:30:00-03:00') })).toBe(null);
  });

  // El documento REAL de una caja cerrada, que es el que faltaba acá: el POS
  // lo escribe con merge al cerrar, así que `opening_date` se queda con la
  // apertura de ayer y `updated_at` trae el cierre de recién. Midiendo la
  // gracia contra la apertura daba un día entero, nunca menos de diez minutos,
  // y el panel avisaba "nadie abrió la caja" con la plata del día completo en
  // cada rotación. El dueño lo veía casi todas las noches.
  const CERRADA_COMO_EN_LA_BASE = {
    status: 'closed',
    id: 129,
    register_id: 129,
    opening_date: '2026-09-07T20:47:00-03:00',
    updated_at: '2026-09-08T20:35:51-03:00',
  };

  it('con el documento real, la rotación de la noche sigue sin disparar nada', () => {
    const items = [
      item({ fecha_dt: new Date('2026-09-08T11:00:00-03:00'), cash_register_id: 129 }),
      item({ fecha_dt: new Date('2026-09-08T20:30:00-03:00'), cash_register_id: 129 }),
    ];
    const a = evaluarCaja({
      cajaActiva: CERRADA_COMO_EN_LA_BASE, items,
      ahora: T('2026-09-08T20:36:00-03:00'),
    });
    expect(a).toBe(null);
  });

  it('y si de verdad nadie abre en toda la mañana, avisa igual', () => {
    const items = [item({ fecha_dt: new Date('2026-09-09T09:15:00-03:00'), cash_register_id: 129 })];
    const a = evaluarCaja({
      cajaActiva: CERRADA_COMO_EN_LA_BASE, items,
      ahora: T('2026-09-09T09:30:00-03:00'),
    });
    expect(a.tipo).toBe('sin_caja');
  });

  // La noche del 19/09 el dueño cerró la caja 139 a las 20:33 con las 158
  // ventas del día adentro, todo en orden, y a las 21:45 el panel le seguía
  // mostrando "158 ventas sin caja desde las 09:30" con $1.260.930. Pasada la
  // gracia, el corte se tomaba del `opening_date` que la caja cerrada conserva
  // —el de ella misma, del día anterior— y el aviso se comía el día entero.
  it('una caja cerrada hace una hora, con su día completo adentro, no acusa nada', () => {
    const cerrada139 = {
      status: 'closed',
      id: 139,
      register_id: 139,
      opening_date: '2026-09-18T20:28:00-03:00',
      updated_at: '2026-09-19T20:33:00-03:00',
    };
    const items = [
      item({ num_venta: 1, cash_register_id: 139, subtotal: 5000,
             fecha: '19/09/2026', fecha_dt: new Date('2026-09-19T09:30:00-03:00') }),
      item({ num_venta: 2, cash_register_id: 139, subtotal: 7000,
             fecha: '19/09/2026', fecha_dt: new Date('2026-09-19T18:00:00-03:00') }),
    ];
    expect(evaluarCaja({ cajaActiva: cerrada139, items, ahora: T('2026-09-19T21:45:00-03:00') }))
      .toBe(null);
    // Y si después del cierre alguien vende igual, eso sí se avisa.
    const conVentaPosterior = [...items, item({
      num_venta: 3, cash_register_id: 139, subtotal: 2500,
      fecha: '19/09/2026', fecha_dt: new Date('2026-09-19T21:10:00-03:00'),
    })];
    const a = evaluarCaja({
      cajaActiva: cerrada139, items: conVentaPosterior, ahora: T('2026-09-19T21:45:00-03:00'),
    });
    expect(a.tipo).toBe('sin_caja');
    expect(a.ventas).toBe(1);
    expect(a.total).toBe(2500);
    expect(a.desde).toBe(T('2026-09-19T21:10:00-03:00'));
  });

  it('un renglón sin fecha no alcanza para acusar a nadie', () => {
    const cerroHaceRato = { status: 'closed', id: 126, updated_at: '2026-09-05T08:00:00-03:00' };
    const items = [item({ fecha_dt: null })];
    expect(evaluarCaja({ cajaActiva: cerroHaceRato, items, ahora: AHORA })).toBe(null);
  });
});

describe('la PC colgada de una caja vieja', () => {
  it('avisa cuál es y con cuánta plata', () => {
    const items = [
      item({ num_venta: 20, cash_register_id: 127, fecha_dt: new Date('2026-09-05T09:00:00-03:00') }),
      item({ num_venta: 21, cash_register_id: 123, subtotal: 4000, pc_id: 'LIBRERIA-ed82',
             fecha_dt: new Date('2026-09-05T09:30:00-03:00') }),
    ];
    const a = evaluarCaja({ cajaActiva: abierta, items, ahora: AHORA });
    expect(a.tipo).toBe('caja_ajena');
    expect(a.caja).toBe(127);
    expect(a.ventas).toBe(1);
    expect(a.total).toBe(4000);
    expect(a.pcs).toEqual(['LIBRERIA-ed82']);
  });

  it('lo vendido antes de abrir esta caja lleva con razón el número anterior', () => {
    const items = [item({ cash_register_id: 126, fecha_dt: new Date('2026-09-05T07:00:00-03:00') })];
    expect(evaluarCaja({ cajaActiva: abierta, items, ahora: AHORA })).toBe(null);
  });

  it('con todo en su caja, silencio', () => {
    const items = [item({ cash_register_id: 127, fecha_dt: new Date('2026-09-05T09:00:00-03:00') })];
    expect(evaluarCaja({ cajaActiva: abierta, items, ahora: AHORA })).toBe(null);
  });

  it('los renglones viejos sin número de caja no acusan a ninguna PC', () => {
    const items = [item({ cash_register_id: null, fecha_dt: new Date('2026-09-05T09:00:00-03:00') })];
    expect(evaluarCaja({ cajaActiva: abierta, items, ahora: AHORA })).toBe(null);
  });
});

describe('lo que lee la persona', () => {
  it('el aviso sin caja dice qué hacer, no qué pasó', () => {
    const t = textoDelAviso({ tipo: 'sin_caja', ventas: 12, total: 87500, pcs: [], caja: null,
                              desde: T('2026-09-05T09:16:00-03:00') });
    expect(t.titulo).toContain('12 ventas');
    expect(t.cuerpo).toContain('$87.500');
    expect(t.cuerpo).toMatch(/Abrí la caja/);
  });

  it('el de la PC colgada nombra la PC', () => {
    const t = textoDelAviso({ tipo: 'caja_ajena', ventas: 1, total: 4000,
                              pcs: ['LIBRERIA-ed82'], caja: 127, desde: null });
    expect(t.cuerpo).toContain('LIBRERIA-ed82');
    expect(t.cuerpo).toContain('127');
  });
});
