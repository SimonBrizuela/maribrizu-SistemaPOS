// @vitest-environment jsdom
/**
 * Separar una caja, a botonazos sobre la pantalla de verdad.
 *
 * La cuenta ya está probada aparte (`separar_caja.test.js`). Acá se prueba el
 * camino que hace el usuario: ve el cartelito en la fila, abre el cierre, toca
 * "Separar por día", mira los números, confirma — y recién ahí se escribe.
 *
 * Lo que más importa de este recorrido es lo que NO tiene que pasar: que el
 * botón se pueda tocar antes de que los chequeos contesten, que confirme sin
 * preguntar, o que una caja de un solo día ofrezca separarse.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const nube = vi.hoisted(() => ({ col: {}, confirmado: true, avisos: [], confirmaciones: [] }));

vi.mock('firebase/firestore', () => {
  const borrar = { _borrar: true };
  const coleccion = (nombre) => (nube.col[nombre] = nube.col[nombre] || {});
  const aplicar = (ref, datos, merge) => {
    const col = coleccion(ref._col);
    const base = merge ? { ...(col[ref.id] || {}) } : {};
    for (const [k, v] of Object.entries(datos)) {
      if (v && v._borrar) delete base[k];
      else base[k] = v;
    }
    col[ref.id] = base;
  };
  const cumple = (datos, partes) => (partes || [])
    .filter(p => p && p.campo !== undefined)
    .every(p => datos[p.campo] === p.valor);
  const instantanea = (nombre, partes) => {
    const col = coleccion(nombre);
    const docs = Object.entries(col)
      .filter(([, datos]) => cumple(datos, partes))
      .map(([id, datos]) => ({ id, ref: { id }, data: () => datos, exists: () => true }));
    return { docs, size: docs.length, empty: docs.length === 0,
             forEach: (fn) => docs.forEach(fn), docChanges: () => [] };
  };
  return {
    collection: (_db, nombre) => ({ _col: nombre }),
    doc: (_db, col, id) => ({ _col: col, id: String(id) }),
    query: (col, ...partes) => ({ _col: col._col, partes }),
    where: (campo, op, valor) => ({ campo, op, valor }),
    orderBy: () => ({}), limit: () => ({}),
    getDocs: async (q) => instantanea(q._col, q.partes),
    getDoc: async (ref) => {
      const datos = coleccion(ref._col)[ref.id];
      return { id: ref.id, exists: () => datos !== undefined, data: () => datos };
    },
    getDocFromCache: async () => { throw new Error('sin cache'); },
    setDoc: async (ref, datos, op = {}) => aplicar(ref, datos, op.merge === true),
    updateDoc: async (ref, datos) => aplicar(ref, datos, true),
    deleteDoc: async (ref) => { delete coleccion(ref._col)[ref.id]; },
    writeBatch: () => {
      const ops = [];
      return {
        set: (ref, datos, op = {}) => ops.push(() => aplicar(ref, datos, op.merge === true)),
        update: (ref, datos) => ops.push(() => aplicar(ref, datos, true)),
        delete: (ref) => ops.push(() => { delete coleccion(ref._col)[ref.id]; }),
        commit: async () => ops.forEach(fn => fn()),
      };
    },
    deleteField: () => borrar,
    Timestamp: { fromDate: (d) => ({ _ts: true, toDate: () => d, seconds: Math.floor(d / 1000) }),
                 now: () => ({ toDate: () => new Date() }) },
    onSnapshot: () => () => {},
    runTransaction: async (_db, fn) => fn({ get: async () => ({ exists: () => false }), set: () => {}, update: () => {} }),
    serverTimestamp: () => 'AHORA',
    addDoc: async () => ({ id: 'nuevo' }),
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {}, storage: {} }));
vi.mock('../../webapp/src/store.js', () => ({
  ensureCollections: () => {}, onStoreChange: () => () => {},
  initStore: async () => {}, storeListo: async () => {},
}));
// Los diálogos de confirmar y avisar se responden solos, pero se anota lo que
// preguntaron: confirmar tiene que preguntar SIEMPRE antes de escribir.
vi.mock('../../webapp/src/components/dialogs.js', async (original) => {
  const real = await original();
  return {
    ...real,
    confirmDialog: async (opciones) => { nube.confirmaciones.push(opciones); return nube.confirmado; },
    alertDialog: (opciones) => { nube.avisos.push(opciones); },
  };
});

const DIA_A = '2026-09-18';
const DIA_B = '2026-09-19';
const dmy = (ymd) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const hora = (ymd, hhmm) => new Date(`${ymd}T${hhmm}:00-03:00`);

/** Renglones y ventas de los dos días, como los guarda el POS. */
function sembrar({ soloUnDia = false } = {}) {
  nube.col = { cierres_caja: {}, ventas_por_dia: {}, ventas: {}, caja_activa: {},
               catalogo: {}, gastos: {}, config: {} };

  const armarDia = (ymd, cuantos, desde) => {
    for (let i = 0; i < cuantos; i++) {
      const num = desde + i;
      const hh = String(8 + (i % 11)).padStart(2, '0');
      const transferencia = i % 3 === 0;
      nube.col.ventas_por_dia[`PC1_${num}_0`] = {
        num_venta: num, pc_id: 'PC1', fecha: dmy(ymd), hora: `${hh}:30:00`,
        fecha_dt: { _ts: true, toDate: () => hora(ymd, `${hh}:30`), seconds: Math.floor(hora(ymd, `${hh}:30`) / 1000) },
        producto: 'CUADERNO', cantidad: 1, subtotal: 1000,
        monto_efectivo: transferencia ? 0 : 1000,
        monto_transferencia: transferencia ? 1000 : 0,
        tipo_pago: transferencia ? 'Transferencia' : 'Efectivo',
        cash_register_id: 138,
      };
      nube.col.ventas[`v${num}`] = {
        sale_id: num, pc_id: 'PC1', total_amount: 1000, cash_register_id: 138,
        created_at: hora(ymd, `${hh}:30`).toISOString(),
      };
    }
  };
  armarDia(DIA_A, 12, 1);
  if (!soloUnDia) armarDia(DIA_B, 15, 100);

  nube.col.cierres_caja['138'] = {
    register_id: 138, pc_id: 'DESKTOP-1', cajero: 'Marta', session_id: DIA_B,
    fecha_apertura: { _ts: true, toDate: () => hora(DIA_A, '07:58'), seconds: Math.floor(hora(DIA_A, '07:58') / 1000) },
    fecha_cierre: { _ts: true, toDate: () => hora(DIA_B, '20:33'), seconds: Math.floor(hora(DIA_B, '20:33') / 1000) },
    monto_inicial: 30000, monto_final: 0, pendiente_conteo: true,
    total_ventas: soloUnDia ? 12000 : 27000, total_efectivo: 0, total_transferencia: 0,
    total_transacciones: soloUnDia ? 12 : 27, total_retiros: 0, retiros: [], productos_vendidos: [],
  };
  nube.col.caja_activa['current'] = { status: 'closed', id: 138, register_id: 138 };
  nube.col.config['settings'] = { fecha_inicio: '2026-01-01' };
}

let contenedor;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  document.body.appendChild(contenedor);
  nube.confirmado = true;
  nube.avisos = [];
  nube.confirmaciones = [];
  sembrar();
});

const esperar = async (veces = 6) => {
  for (let i = 0; i < veces; i++) await new Promise(r => setTimeout(r, 0));
};

async function pantalla() {
  const mod = await import('../../webapp/src/pages/cierres.js');
  await mod.renderCierres(contenedor, {});
  await esperar();
  return contenedor;
}

const modal = () => document.querySelector('.modal-overlay');
const textoModal = () => (modal()?.textContent || '').replace(/\s+/g, ' ');
const boton = (texto) => [...document.querySelectorAll('button')]
  .find(b => b.textContent.replace(/\s+/g, ' ').trim().includes(texto));

async function abrirElDetalle() {
  const fila = contenedor.querySelector('.clickable-row');
  fila.click();
  await esperar();
}

async function abrirElSeparar() {
  await abrirElDetalle();
  document.querySelector('#btn-separar-dias').click();
  await esperar(10);
}

describe('la fila avisa que la caja junta dos días', () => {
  it('el cartelito sale en la fila', async () => {
    const c = await pantalla();
    expect(c.querySelector('.cj-dias')?.textContent.trim()).toBe('2 días');
    expect(c.querySelector('.clickable-row').getAttribute('title')).toContain('separarla');
  });

  it('una caja de un día solo no lo muestra', async () => {
    sembrar({ soloUnDia: true });
    const c = await pantalla();
    expect(c.querySelector('.cj-dias')).toBe(null);
  });
});

describe('el detalle del cierre ofrece separar', () => {
  it('el aviso lista los dos días con su plata', async () => {
    await pantalla();
    await abrirElDetalle();
    expect(textoModal()).toContain('Esta caja junta 2 días');
    expect(textoModal()).toContain('18/09');
    expect(textoModal()).toContain('19/09');
    expect(document.querySelector('#btn-separar-dias')).not.toBe(null);
  });

  it('una caja de un día no lo ofrece', async () => {
    sembrar({ soloUnDia: true });
    await pantalla();
    await abrirElDetalle();
    expect(document.querySelector('#btn-separar-dias')).toBe(null);
  });
});

describe('el diálogo de separar', () => {
  it('muestra los días, las dos cajas y el número nuevo', async () => {
    await pantalla();
    await abrirElSeparar();
    const t = textoModal();
    expect(t).toContain('Separar la caja #138');
    expect(t).toContain('Caja #139');
    expect(t).toContain('Los días que tiene adentro');
    expect(document.querySelectorAll('.sep-caja')).toHaveLength(2);
  });

  it('el monto inicial viene cargado y se puede cambiar', async () => {
    await pantalla();
    await abrirElSeparar();
    const montos = [...document.querySelectorAll('[data-monto]')];
    expect(montos).toHaveLength(2);
    expect(montos[1].value).toBe('30000');

    montos[1].value = '50000';
    montos[1].dispatchEvent(new Event('input'));
    await esperar();
    // Esperado = inicial + efectivo del día. El día 19 tiene 10 ventas en
    // efectivo de $1.000.
    expect(document.querySelector('[data-calc="esperado-1"]').textContent).toBe('$60.000,00');
  });

  it('destildar "nadie la contó" habilita cargar el efectivo', async () => {
    await pantalla();
    await abrirElSeparar();
    const check = document.querySelectorAll('[data-pendiente]')[1];
    expect(document.querySelectorAll('[data-conteo]')[1].disabled).toBe(true);
    check.checked = false;
    check.dispatchEvent(new Event('change'));
    await esperar();
    expect(document.querySelectorAll('[data-conteo]')[1].disabled).toBe(false);
  });

  it('el chequeo de los números se ve en pantalla', async () => {
    await pantalla();
    await abrirElSeparar();
    expect(textoModal()).toContain('El número #139 está libre');
  });

  it('si el número que sigue ya tiene cierre, agarra el siguiente', async () => {
    nube.col.cierres_caja['139'] = { register_id: 139, fecha_cierre: 'x' };
    await pantalla();
    await abrirElSeparar();
    expect(textoModal()).toContain('Caja #140');
    expect(textoModal()).toContain('El número #140 está libre');
    expect(boton('Separar en').disabled).toBe(false);
  });

  it('un número sin cierre pero con ventas viejas frena todo', async () => {
    // Lo que no se ve mirando la lista de cierres: una PC usó el 139 y nunca
    // subió su cierre. Pisar ese número mezclaría las dos cajas.
    nube.col.ventas['vieja'] = { sale_id: 900, cash_register_id: 139, total_amount: 5000 };
    await pantalla();
    await abrirElSeparar();
    expect(textoModal()).toContain('no está libre');
    expect(boton('Separar en').disabled).toBe(true);
  });

  it('sacar el corte deja todo en una caja y no se puede separar', async () => {
    await pantalla();
    await abrirElSeparar();
    document.querySelector('[data-corte="1"]').click();
    await esperar();
    expect(textoModal()).toContain('Así no se separa nada');
    expect(boton('Separar').disabled).toBe(true);
  });
});

describe('separar desde la pantalla', () => {
  it('pregunta antes de escribir y mueve lo del segundo día', async () => {
    await pantalla();
    await abrirElSeparar();
    boton('Separar en 2 cajas').click();
    await esperar(20);

    expect(nube.confirmaciones).toHaveLength(1);
    expect(nube.confirmaciones[0].title).toContain('#138');

    const renglones = Object.values(nube.col.ventas_por_dia);
    expect(renglones.filter(r => r.cash_register_id === 139)).toHaveLength(15);
    expect(renglones.filter(r => r.cash_register_id === 138)).toHaveLength(12);
    expect(nube.col.cierres_caja['139'].total_ventas).toBe(15000);
    expect(nube.col.cierres_caja['138'].total_ventas).toBe(12000);
    expect(nube.avisos.some(a => a.title === 'Caja separada')).toBe(true);
  });

  it('si se dice que no, no se escribe nada', async () => {
    nube.confirmado = false;
    await pantalla();
    await abrirElSeparar();
    boton('Separar en 2 cajas').click();
    await esperar(10);

    expect(nube.col.cierres_caja['139']).toBe(undefined);
    expect(Object.values(nube.col.ventas_por_dia).every(r => r.cash_register_id === 138)).toBe(true);
  });

  it('con una caja abierta con ese número, avisa y no escribe', async () => {
    nube.col.caja_activa['current'] = { status: 'open', id: 138, register_id: 138 };
    await pantalla();
    await abrirElSeparar();
    expect(textoModal()).toContain('abierta ahora mismo');
    expect(boton('Separar en').disabled).toBe(true);
  });
});
