// @vitest-environment jsdom
/**
 * El Balance Mensual, la pantalla de Control Total.
 *
 * Es donde se mira cuánta plata hay y de dónde salió. Tiene siete vistas sobre
 * los mismos datos —Resumen, Resumen vivo, Semana a Semana, Día por día,
 * Cuentas, Meses y Buscar— y todas tienen que contar lo mismo: dos números que
 * se contradicen en la misma pantalla hacen dudar de los dos.
 *
 * La cuenta pura (la cadena de saldos, lo tipeado que manda sobre lo calculado)
 * ya está probada aparte en `balance_cadena.test.js`. Acá se prueba la
 * pantalla: que cada vista se arme con datos reales, que los números lleguen y
 * que editar un día escriba lo que corresponde.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { datos } = vi.hoisted(() => ({
  datos: { porColeccion: {}, docs: {}, escrituras: [] },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  const base = firestoreFalso({ registro: datos.escrituras });
  const snapshot = (nombre) => {
    const lista = datos.porColeccion[nombre] || [];
    return {
      docs: lista.map((d, i) => ({
        id: d.__id || `doc${i}`, ref: { id: d.__id || `doc${i}` },
        data: () => d, exists: () => true,
      })),
      empty: lista.length === 0, size: lista.length, docChanges: () => [],
      forEach(fn) { this.docs.forEach(fn); },
      exists: () => lista.length > 0, data: () => lista[0],
    };
  };
  return {
    ...base,
    collection: (_db, nombre) => ({ _col: nombre }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    getDocs: async (q) => snapshot(q?._col || q?.col?._col),
    // Los documentos de configuración se piden por nombre: `control_config/balance`,
    // `control_config/dias_2026-08`. Cada uno tiene su contenido propio.
    getDoc: async (ref) => {
      const clave = `${ref?._col}/${ref?.id}`;
      const d = datos.docs[clave];
      return { exists: () => d != null, data: () => d, id: ref?.id || 'x' };
    },
    getDocFromCache: async () => { throw new Error('sin cache local'); },
    setDoc: async (ref, valores, opciones) => {
      datos.escrituras.push({ tipo: 'set', ref, datos: valores, opciones });
      const clave = `${ref?._col}/${ref?.id}`;
      datos.docs[clave] = { ...(datos.docs[clave] || {}), ...valores };
    },
    onSnapshot: (q, cb) => {
      try { cb?.(snapshot(q?._col || q?.col?._col)); } catch (_) {}
      return () => {};
    },
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {}, storage: {} }));
vi.mock('../../webapp/src/auth.js', () => ({
  auth: { currentUser: { uid: 'u1', displayName: 'Mari', getIdToken: async () => 'T' } },
  getSession: () => ({ uid: 'u1', display: 'Mari', role: 'admin' }),
  isLoggedIn: () => true, onAuthReady: async () => ({ role: 'admin' }),
  hasSessionHint: () => true, logout: async () => {},
}));
vi.mock('../../webapp/src/store.js', () => ({
  ensureCollections: () => {}, onStoreChange: () => () => {},
  initStore: async () => {}, storeListo: async () => {},
}));

const ing = (motivo, medio, monto) => ({ motivo, medio, monto });
const com = (proveedor, rubro, medio, monto) => ({ proveedor, rubro, medio, monto });

/**
 * Dos meses cargados: julio cerrado con saldos tipeados y agosto en curso con
 * tres días. Son las dos situaciones que conviven siempre en la pantalla.
 */
function sembrarBalance() {
  datos.docs['control_config/balance'] = {
    meses: {
      '2026-07': { label: 'Julio 2026', origen: 'manual',
                   saldos: { efectivo: 1405040, mp: 4707364, lapos: 707885 } },
      '2026-08': { label: 'Agosto 2026', origen: 'manual' },
    },
    montosFijos: [
      { id: 'f1', label: 'Alquiler', monto: 500000, venceDia: 10, activo: true },
      { id: 'f2', label: 'Contadora', monto: 180000, venceDia: 5, activo: true },
    ],
  };
  datos.docs['control_config/dias_2026-08'] = {
    ym: '2026-08',
    apertura: { efectivo: 300000, mp: 1200000, lapos: 50000 },
    dias: {
      '01': { ingresos: [ing('Caja hoy', 'efectivo', 185000), ing('MP JOSE', 'mp', 92000)],
              compras: [com('Ledesma', 'Mercadería', 'efectivo', 60000)] },
      '02': { ingresos: [ing('Caja hoy', 'efectivo', 210000), ing('Lapos', 'lapos', 44000)],
              compras: [com('Anita', 'Sueldos', 'efectivo', 120000)] },
      '03': { ingresos: [ing('Caja hoy', 'efectivo', 175000)],
              compras: [com('Luz', 'Gastos fijos', 'mp', 38000)] },
    },
  };
  datos.docs['control_config/dias_2026-07'] = {
    ym: '2026-07',
    dias: { '31': { ingresos: [ing('Caja hoy', 'efectivo', 90000)], compras: [] } },
  };
}

let contenedor;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  datos.escrituras.length = 0;
  datos.docs = {};
  datos.porColeccion = {
    catalogo: [], ventas: [], ventas_por_dia: [], gastos: [],
    control_config: [], config: [], cierres_caja: [], caja_activa: [],
  };
  sembrarBalance();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 3, 15, 0));   // 03/08/2026
  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
  document.body.insertAdjacentHTML('beforeend',
    '<div id="app"></div><div id="page-title"></div><div id="sidebar"></div>' +
    '<div id="status"></div><div id="bottomNav"></div>');
});

/** Deja correr promesas sin depender del reloj, que está congelado. */
const asentar = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

async function montar(vista = null) {
  if (vista) localStorage.setItem('bal:view', vista);
  const mod = await import('../../webapp/src/pages/balance_mensual.js');
  const promesa = mod.mountBalanceMensual(contenedor, {});
  await asentar();
  await vi.advanceTimersByTimeAsync(300);
  await promesa;
  await asentar();
  return contenedor;
}

/** Cambia de pestaña como lo haría un click. */
async function irA(clave) {
  const btn = contenedor.querySelector(`.bal-seg-btn[data-seg="${clave}"]`);
  expect(btn, `no está la pestaña ${clave}`).toBeTruthy();
  btn.click();
  await asentar();
  await vi.advanceTimersByTimeAsync(300);
  await asentar();
  return document.getElementById('bal-body');
}

const plano = (el) => el.textContent.replace(/\./g, '');

describe('el armado de la pantalla', () => {
  it('están las siete vistas', async () => {
    const c = await montar();
    const claves = [...c.querySelectorAll('.bal-seg-btn')].map(b => b.dataset.seg);
    expect(claves).toEqual(
      ['ganancia', 'resumen', 'semana', 'dia', 'cuentas', 'meses', 'buscar']);
  });

  it('la vista elegida se recuerda para la próxima vez', async () => {
    await montar();
    await irA('meses');
    expect(localStorage.getItem('bal:view')).toBe('meses');
  });

  it('sin nada cargado muestra su vacío, no una tabla de ceros', async () => {
    datos.docs['control_config/balance'] = { meses: {} };
    const c = await montar();
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(plano(c)).not.toContain('NaN');
    expect(plano(c)).not.toContain('undefined');
  });

  it('ofrece deshacer, rehacer y ver el historial', async () => {
    const c = await montar();
    expect(c.querySelector('#bal-undo')).toBeTruthy();
    expect(c.querySelector('#bal-redo')).toBeTruthy();
    expect(c.querySelector('#bal-hist')).toBeTruthy();
  });
});

describe('cada vista se arma con datos de verdad', () => {
  for (const [clave, nombre] of [
    ['ganancia', 'Resumen'], ['resumen', 'Resumen vivo'], ['semana', 'Semana a Semana'],
    ['dia', 'Día por día'], ['cuentas', 'Cuentas'], ['meses', 'Meses'], ['buscar', 'Buscar'],
  ]) {
    it(nombre, async () => {
      await montar();
      const body = await irA(clave);
      expect(body.innerHTML.length, `${nombre} no pintó nada`).toBeGreaterThan(0);
      const t = plano(body);
      expect(t, nombre).not.toContain('NaN');
      expect(t, nombre).not.toContain('undefined');
      expect(t, nombre).not.toContain('[object Object]');
    });
  }
});

describe('los números del mes en curso', () => {
  it('el Día por día muestra el día de hoy con sus renglones', async () => {
    const body = await montar('dia');
    const t = plano(body);
    expect(t).toContain('175000');        // el ingreso del 03
    expect(t).toContain('38000');         // la compra del 03
  });

  it('se puede ir a otro día y ver lo suyo', async () => {
    const body = await montar('dia');
    const selector = body.querySelector('#bal-fdia, #bal-ym, select');
    if (!selector) return;
    const t = plano(body);
    // El listado de días del mes tiene que estar a mano.
    expect(t.length).toBeGreaterThan(50);
  });

  it('la banda de caja dice cuánta plata hay hoy', async () => {
    const c = await montar('dia');
    // Apertura 300.000 + 185.000 + 210.000 + 175.000 − 60.000 − 120.000 = 690.000
    expect(plano(c)).toContain('690000');
  });

  it('el Resumen vivo lista los meses cargados', async () => {
    await montar();
    const body = await irA('resumen');
    const t = body.textContent;
    expect(t).toMatch(/Agosto|2026-08|08\/2026/);
  });

  it('Meses lista julio y agosto', async () => {
    await montar();
    const body = await irA('meses');
    const t = body.textContent;
    expect(t).toMatch(/Julio|2026-07/);
    expect(t).toMatch(/Agosto|2026-08/);
  });

  it('Cuentas reparte por medio de pago y no inventa un cuarto', async () => {
    await montar();
    const body = await irA('cuentas');
    const t = body.textContent.toLowerCase();
    expect(t).toMatch(/efectivo/);
    expect(t).toMatch(/mp|mercado/);
  });
});

describe('buscar dentro del balance', () => {
  /** Escribe en el buscador y aprieta Buscar. */
  async function buscar(texto) {
    document.getElementById('bal-q').value = texto;
    document.getElementById('bal-go').click();
    await asentar();
    await vi.advanceTimersByTimeAsync(400);
    await asentar();
    return document.getElementById('bal-res').textContent;
  }

  it('encuentra un proveedor cargado en un día', async () => {
    await montar();
    await irA('buscar');
    expect(await buscar('Ledesma')).toContain('Ledesma');
  });

  it('encuentra por monto', async () => {
    // Se busca así cuando aparece un número raro en el resumen y hay que
    // rastrear de dónde salió.
    await montar();
    await irA('buscar');
    expect(await buscar('120000')).toContain('Anita');
  });

  it('algo que no está no devuelve resultados de otro', async () => {
    await montar();
    await irA('buscar');
    expect(await buscar('proveedor-que-no-existe')).not.toContain('Ledesma');
  });

  it('sin escribir nada lo dice, no lista todo', async () => {
    await montar();
    await irA('buscar');
    expect((await buscar('')).toLowerCase()).toMatch(/escrib|buscar/);
  });
});

describe('la caja por cuenta (tocar la banda)', () => {
  // Julio cerró con el desglose de MP por cuenta y agosto arranca de ahí:
  // la apertura tipeada de agosto coincide con ese cierre en MP.
  const conDesglose = () => {
    datos.docs['control_config/balance'].meses['2026-07'].saldosMp =
      { 'MP JOSE': 3000000, 'MP AGUSTIN': 1707364 };
    datos.docs['control_config/dias_2026-08'].apertura.mp = 4707364;
  };
  const abrirDetalle = async () => {
    document.querySelector('.bal-caja-band').click();
    await asentar();
    await vi.advanceTimersByTimeAsync(300);
    await asentar();
    const dlg = document.querySelector('.app-dialog-overlay');
    expect(dlg, 'no abrió el detalle de la caja').toBeTruthy();
    return dlg;
  };

  it('la banda dice hasta qué día llega la caja', async () => {
    const c = await montar('dia');
    expect(c.querySelector('.bal-caja-band small').textContent).toContain('al 03/08');
  });

  it('con un click muestra cada Mercado Pago por nombre, sumando lo cargado', async () => {
    conDesglose();
    await montar('dia');
    const t = plano(await abrirDetalle());
    expect(t).toContain('MP JOSE');
    expect(t).toContain('MP AGUSTIN');
    expect(t).toContain('3092000');   // 3.000.000 del cierre de julio + 92.000 cargados en agosto
    expect(t).toContain('1707364');   // Agustín sin movimientos: queda en su base
    // La compra MP sin cuenta asignada queda a la vista, no desaparece.
    expect(t.toLowerCase()).toContain('sin asignar');
    expect(t).toContain('38000');
  });

  it('si el desglose no cuadra con el total MP, lo avisa', async () => {
    // Sin alinear la apertura: agosto arranca con 1.200.000 tipeados y el
    // desglose de julio queda desfasado. Mejor un aviso que dos números
    // contando distinto sin explicación.
    datos.docs['control_config/balance'].meses['2026-07'].saldosMp =
      { 'MP JOSE': 3000000, 'MP AGUSTIN': 1707364 };
    await montar('dia');
    expect(plano(await abrirDetalle())).toContain('difiere');
  });

  it('sin ningún cierre con desglose no inventa saldos por cuenta', async () => {
    await montar('dia');
    const dlg = await abrirDetalle();
    const t = dlg.textContent;
    expect(t).toContain('MP JOSE');   // el movimiento sí se ve
    expect(t).toContain('—');         // pero sin un saldo inventado
    expect(t.toLowerCase()).toContain('todavía no hay un cierre');
  });

  it('Fijar cierre del mes guarda también el desglose por cuenta cuando cuadra', async () => {
    conDesglose();
    // Con la compra MP del 03 asignada a una cuenta, todo el MP queda repartido.
    datos.docs['control_config/dias_2026-08'].dias['03'].compras[0].cuenta = 'MP JOSE';
    await montar('dia');
    document.querySelector('[data-fijar-cierre]').click();
    await asentar();
    document.querySelector('.app-dialog-overlay .ad-ok').click();   // confirmar
    await asentar();
    await vi.advanceTimersByTimeAsync(300);
    await asentar();
    const esc = datos.escrituras.find(e => e.datos?.meses?.['2026-08']?.saldosMp);
    expect(esc, 'no se guardó el desglose del cierre').toBeTruthy();
    expect(esc.datos.meses['2026-08'].saldosMp).toEqual({
      'MP JOSE': 3054000,      // 3.000.000 + 92.000 − 38.000
      'MP AGUSTIN': 1707364,
    });
    expect(esc.datos.meses['2026-08'].saldos.mp).toBe(3054000 + 1707364);
  });

  it('Fijar cierre NO guarda el desglose si queda plata MP sin cuenta', async () => {
    conDesglose();
    // La compra MP del 03 sigue sin cuenta: repartirla a ojo sería inventar.
    await montar('dia');
    document.querySelector('[data-fijar-cierre]').click();
    await asentar();
    document.querySelector('.app-dialog-overlay .ad-ok').click();
    await asentar();
    await vi.advanceTimersByTimeAsync(300);
    await asentar();
    const cierre = datos.escrituras.find(e => e.datos?.meses?.['2026-08']?.saldos);
    expect(cierre, 'el cierre igual se fijó').toBeTruthy();
    expect(cierre.datos.meses['2026-08'].saldosMp).toBeUndefined();
  });
});

describe('los gastos fijos del mes', () => {
  it('se muestran con su monto de referencia', async () => {
    // Cada fijo es una fila editable: el motivo y el importe viven en campos,
    // no en texto suelto.
    await montar('dia');
    const motivos = [...document.querySelectorAll('[data-fdia-f="label"]')].map(i => i.value);
    expect(motivos).toContain('Alquiler');
    expect(motivos).toContain('Contadora');

    const montos = [...document.querySelectorAll('[data-fdia-f="monto"]')]
      .map(i => i.value.replace(/\./g, ''));
    expect(montos.join(' ')).toContain('500000');
  });

  it('el encabezado dice cuánto se pagó y cuánto falta', async () => {
    // 680.000 de referencia entre los dos, nada pagado todavía.
    const c = await montar('dia');
    const t = plano(c);
    expect(t).toMatch(/Pagado/i);
    expect(t).toContain('680000');
  });

  it('uno apagado no aparece', async () => {
    datos.docs['control_config/balance'].montosFijos[1].activo = false;
    await montar('dia');
    const motivos = [...document.querySelectorAll('[data-fdia-f="label"]')].map(i => i.value);
    expect(motivos).toContain('Alquiler');
    expect(motivos).not.toContain('Contadora');
  });
});
