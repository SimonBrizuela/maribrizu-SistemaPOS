// @vitest-environment jsdom
/**
 * El detalle de una venta.
 *
 * Es la pantalla a la que se entra cuando algo no cierra: se busca la venta en
 * la lista, se abre, y ahí tiene que estar todo — cómo se pagó, qué se llevó,
 * qué descuento se hizo y qué anotó el cajero.
 *
 * Lo que se prueba:
 *   · una venta mixta muestra las dos partes. Antes decía "Transferencia" y
 *     escondía el efectivo: al buscar por qué el cajón tenía de más, esta
 *     pantalla contestaba mal;
 *   · los ítems se buscan por número de venta, que a veces está guardado como
 *     número y a veces como texto;
 *   · las observaciones del POS se muestran, y las borradas no.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { datos } = vi.hoisted(() => ({ datos: { items: [], obs: [], consultas: [] } }));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  return {
    ...firestoreFalso(),
    getDocs: async (q) => {
      const col = q?.col?._col;
      const filtro = q?.partes?.[0];
      datos.consultas.push({ col, valor: filtro?.valor });
      const fuente = col === 'observaciones' ? datos.obs : col === 'ventas_por_dia' ? datos.items : [];
      const encontrados = fuente.filter(d => {
        if (!filtro) return true;
        const v = d[filtro.campo];
        // Firestore distingue 5 de "5": el doble también.
        return v === filtro.valor && typeof v === typeof filtro.valor;
      });
      return {
        docs: encontrados.map((d, i) => ({ id: d.__id || `d${i}`, data: () => d })),
        empty: encontrados.length === 0,
      };
    },
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {} }));
vi.mock('../../webapp/src/sale_numbers.js', () => ({
  getSaleNumberMap: async () => ({}),
  displayNumForVenta: (v) => v.sale_id ?? v.id,
}));

const { openSaleModal } = await import('../../webapp/src/components/modal.js');

const venta = (extra = {}) => ({
  sale_id: 4520, total_amount: 10000, payment_type: 'cash',
  cash_received: 10000, change_given: 0, username: 'mari',
  created_at: new Date('2026-08-28T14:30:00-03:00'), ...extra,
});

/** Abre el modal y espera a que terminen los ítems y las observaciones. */
async function abrir(v) {
  await openSaleModal(v, {});
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  return document.querySelector('.modal-overlay');
}

beforeEach(() => {
  document.body.innerHTML = '';
  datos.items = [];
  datos.obs = [];
  datos.consultas = [];
});

describe('cómo se pagó', () => {
  it('una venta en efectivo muestra lo recibido y el vuelto', async () => {
    const m = await abrir(venta({ cash_received: 12000, change_given: 2000 }));
    expect(m.textContent).toContain('Efectivo');
    expect(m.textContent).toContain('12.000');
    expect(m.textContent).toContain('2.000');
  });

  it('una transferencia no habla de vuelto', async () => {
    const m = await abrir(venta({ payment_type: 'transfer', cash_received: 0, change_given: 0 }));
    expect(m.textContent).toContain('Transferencia');
    expect(m.textContent).not.toContain('Cambio');
  });

  it('una mixta se llama mixta y muestra las DOS partes', async () => {
    // Antes decía "Transferencia" y escondía los $4.000 que sí entraron al
    // cajón: la pantalla a la que se va a entender un descuadre lo tapaba.
    const m = await abrir(venta({
      payment_type: 'mixed', total_amount: 10000,
      cash_received: 5000, change_given: 1000, transfer_amount: 6000,
    }));
    expect(m.textContent).toMatch(/Mixto/i);
    expect(m.textContent).toContain('4.000');    // efectivo neto
    expect(m.textContent).toContain('6.000');    // transferencia
  });

  it('una mixta sin desglose no inventa efectivo', async () => {
    const m = await abrir(venta({
      payment_type: 'mixed', total_amount: 10000,
      cash_received: 0, change_given: 0, transfer_amount: 0,
    }));
    expect(m.textContent).toMatch(/Mixto/i);
    const seccion = m.querySelector('.detail-grid').textContent;
    expect(seccion).toContain('10.000');         // entera como transferencia
  });

  it('el descuento de la venta se muestra sólo si lo hubo', async () => {
    expect((await abrir(venta({ discount: 500 }))).textContent).toContain('Descuento');
    document.body.innerHTML = '';
    expect((await abrir(venta({ discount: 0 }))).textContent).not.toContain('Descuento Aplicado');
  });
});

describe('los productos de la venta', () => {
  it('salen con cantidad y subtotal', async () => {
    datos.items = [
      { num_venta: 4520, producto: 'CUADERNO RIVADAVIA', cantidad: 2, precio_unitario: 1500, subtotal: 3000 },
      { num_venta: 4520, producto: 'LAPIZ FABER', cantidad: 1, precio_unitario: 300, subtotal: 300 },
    ];
    const m = await abrir(venta());
    expect(m.textContent).toContain('CUADERNO RIVADAVIA');
    expect(m.textContent).toContain('LAPIZ FABER');
    expect(m.textContent).toContain('3.000');
  });

  it('el número de venta se busca como número Y como texto', async () => {
    // En el histórico quedaron guardados de las dos formas: si sólo se probara
    // una, la venta se abriría sin detalle y parecería una venta vacía.
    datos.items = [{ num_venta: '4520', producto: 'CUADERNO', cantidad: 1, subtotal: 1000 }];
    const m = await abrir(venta());
    expect(m.textContent).toContain('CUADERNO');
    const buscados = datos.consultas.filter(c => c.col === 'ventas_por_dia').map(c => c.valor);
    expect(buscados).toContain(4520);
    expect(buscados).toContain('4520');
  });

  it('sin detalle lo dice, no deja el cartel de "cargando" para siempre', async () => {
    const m = await abrir(venta());
    expect(m.textContent).toContain('Sin detalle');
    expect(m.querySelector('.spinner')).toBeNull();
  });

  it('un producto con descuento muestra el precio tachado y lo que se descontó', async () => {
    datos.items = [{
      num_venta: 4520, producto: 'RESMA', cantidad: 3, precio_unitario: 800,
      precio_original: 1000, descuento_monto: 600, descuento_tipo: 'percentage',
      descuento_valor: 20, subtotal: 2400,
    }];
    const m = await abrir(venta());
    expect(m.textContent).toContain('20% OFF');
    expect(m.textContent).toContain('600');
    expect(m.querySelector('[style*="line-through"]')).toBeTruthy();
  });

  it('un producto suelto escrito a mano se marca como VARIOS', async () => {
    datos.items = [{
      num_venta: 4520, producto: 'FOTOCOPIA COLOR', cantidad: 1,
      categoria: 'Varios', precio_unitario: 500, subtotal: 500,
    }];
    const m = await abrir(venta());
    expect(m.textContent).toContain('VARIOS');
    expect(m.textContent).toContain('FOTOCOPIA COLOR');
  });

  it('el total de descuentos se suma abajo', async () => {
    datos.items = [
      { num_venta: 4520, producto: 'A', cantidad: 1, descuento_monto: 300, subtotal: 700 },
      { num_venta: 4520, producto: 'B', cantidad: 1, descuento_monto: 200, subtotal: 800 },
    ];
    const m = await abrir(venta());
    expect(m.textContent).toContain('Total descuentos');
    expect(m.textContent).toContain('500');
  });
});

describe('lo que anotó el cajero', () => {
  it('la observación aparece', async () => {
    datos.obs = [{ __id: 'o1', sale_id: 4520, text: 'Se lo lleva mañana', created_by_name: 'mari' }];
    const m = await abrir(venta());
    expect(m.textContent).toContain('Se lo lleva mañana');
    expect(document.getElementById('modalObsSection').style.display).not.toBe('none');
  });

  it('una borrada no se muestra', async () => {
    datos.obs = [{ __id: 'o1', sale_id: 4520, text: 'Error de tipeo', deleted: true }];
    const m = await abrir(venta());
    expect(m.textContent).not.toContain('Error de tipeo');
    expect(document.getElementById('modalObsSection').style.display).toBe('none');
  });

  it('sin observaciones la sección queda oculta, no vacía', async () => {
    await abrir(venta());
    expect(document.getElementById('modalObsSection').style.display).toBe('none');
  });

  it('la misma observación guardada dos veces se muestra una sola', async () => {
    // Se busca por sale_id numérico y de texto: si el doc matchea los dos, no
    // puede duplicarse en pantalla.
    datos.obs = [{ __id: 'o1', sale_id: 4520, text: 'Pagó con billete grande' }];
    const m = await abrir(venta());
    const apariciones = m.textContent.split('Pagó con billete grande').length - 1;
    expect(apariciones).toBe(1);
  });

  it('la nota de un ítem VARIOS se muestra con su nombre', async () => {
    datos.obs = [{ __id: 'o1', sale_id: 4520, text: '[Varios] FOTOCOPIAS: 40 hojas a color' }];
    const m = await abrir(venta());
    expect(m.textContent).toContain('FOTOCOPIAS');
    expect(m.textContent).toContain('40 hojas a color');
  });
});

describe('abrir y cerrar', () => {
  it('abrir otra venta no deja la anterior abajo', async () => {
    await abrir(venta({ sale_id: 4520 }));
    await abrir(venta({ sale_id: 4521 }));
    expect(document.querySelectorAll('.modal-overlay').length).toBe(1);
  });

  it('la cruz lo cierra', async () => {
    const m = await abrir(venta());
    m.querySelector('.modal-close').click();
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  it('Escape lo cierra', async () => {
    await abrir(venta());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  it('hacer clic afuera lo cierra; adentro no', async () => {
    const m = await abrir(venta());
    m.querySelector('.modal-body').click();
    expect(document.querySelector('.modal-overlay')).toBeTruthy();
    m.click();
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });
});
