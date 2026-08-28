// @vitest-environment jsdom
/**
 * El calendario del panel.
 *
 * Sirve para dos cosas distintas: avisar qué se viene (el Día del Niño mueve
 * ventas y hay que tener mercadería) y no dejar pasar el vencimiento de un
 * gasto fijo. Las dos dependen de calcular bien fechas, que es donde se
 * esconden los errores de un día.
 *
 * Lo que se prueba:
 *   · los feriados que se mueven cada año (Carnaval, Semana Santa) y las fechas
 *     comerciales que caen en "el tercer domingo de tal mes";
 *   · los vencimientos: que un fijo que vence el 31 no desaparezca en febrero,
 *     que uno dado de baja deje de avisar y que uno pagado no moleste más;
 *   · el aviso del menú, que es lo único que se ve sin entrar a la pantalla.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { estado } = vi.hoisted(() => ({
  estado: { emitir: null, escrituras: [], balance: {}, dias: {} },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  return {
    ...firestoreFalso({ registro: estado.escrituras }),
    onSnapshot: (_ref, cb) => {
      estado.emitir = (items) => cb({ exists: () => !!items, data: () => ({ items }) });
      return () => { estado.emitir = null; };
    },
    setDoc: async (ref, datos) => { estado.escrituras.push({ ref, datos }); },
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {} }));
vi.mock('../../webapp/src/config.js', () => ({
  loadBalanceConfig: async () => estado.balance,
  loadDiasMes: async (_db, ym) => ({ dias: estado.dias[ym] || {} }),
}));

const cal = await import('../../webapp/src/pages/calendario_core.js');

/** Los nombres de los eventos oficiales de una fecha. */
const enFecha = (y, key) => (cal.eventosDeAnio(y).get(key) || []).map(e => e.nombre);

/** Busca un evento oficial por nombre y devuelve su fecha. */
function fechaDe(y, texto) {
  for (const [fecha, evs] of cal.eventosDeAnio(y)) {
    if (evs.some(e => e.nombre.includes(texto))) return fecha;
  }
  return null;
}

beforeEach(() => {
  estado.escrituras.length = 0;
  estado.balance = {};
  estado.dias = {};
  cal.ensureSub({});
  estado.emitir?.([]);                    // sin eventos propios
  vi.useRealTimers();
});

afterEach(() => { vi.useRealTimers(); });

describe('los feriados que no se mueven', () => {
  it('Año Nuevo, Navidad y el 25 de Mayo caen donde tienen que caer', () => {
    expect(enFecha(2026, '2026-01-01')).toContain('Año Nuevo');
    expect(enFecha(2026, '2026-12-25')).toContain('Navidad');
    expect(enFecha(2026, '2026-05-25')).toContain('Revolución de Mayo');
  });

  it('los feriados por decreto de 2026 están cargados', () => {
    // Los puentes turísticos no salen de una fórmula: los fija el gobierno.
    expect(enFecha(2026, '2026-03-23').join(' ')).toMatch(/puente/i);
    expect(enFecha(2026, '2026-11-23').join(' ')).toMatch(/Soberanía/i);
  });
});

describe('las fechas que se mueven cada año', () => {
  it('la Semana Santa de 2026 cae donde corresponde', () => {
    // Pascua 2026: domingo 5 de abril.
    expect(fechaDe(2026, 'Domingo de Pascua')).toBe('2026-04-05');
    expect(fechaDe(2026, 'Viernes Santo')).toBe('2026-04-03');
    expect(fechaDe(2026, 'Jueves Santo')).toBe('2026-04-02');
  });

  it('y la de 2027 también, que cae en otro mes', () => {
    // Pascua 2027: domingo 28 de marzo.
    expect(fechaDe(2027, 'Domingo de Pascua')).toBe('2027-03-28');
  });

  it('el Carnaval son el lunes y el martes previos', () => {
    expect(fechaDe(2026, 'Lunes de Carnaval')).toBe('2026-02-16');
    expect(fechaDe(2026, 'Martes de Carnaval')).toBe('2026-02-17');
  });
});

describe('las fechas que mueven ventas', () => {
  it('el Día de la Madre es el tercer domingo de octubre', () => {
    const f = fechaDe(2026, 'Día de la Madre');
    expect(f).toBe('2026-10-18');
    const [y, m, d] = f.split('-').map(Number);
    expect(new Date(y, m - 1, d).getDay()).toBe(0);   // domingo
  });

  it('el Día del Padre es el tercer domingo de junio', () => {
    const f = fechaDe(2026, 'Día del Padre');
    const [y, m, d] = f.split('-').map(Number);
    expect(m).toBe(6);
    expect(new Date(y, m - 1, d).getDay()).toBe(0);
  });

  it('el Día del Niño es el tercer domingo de agosto', () => {
    const f = fechaDe(2026, 'Día del Niño');
    const [y, m, d] = f.split('-').map(Number);
    expect(m).toBe(8);
    expect(new Date(y, m - 1, d).getDay()).toBe(0);
  });

  it('cuando el mes arranca en domingo, el tercero sigue siendo el tercero', () => {
    // Es el caso que rompe el cálculo si se cuentan mal los saltos de semana.
    for (const anio of [2024, 2025, 2026, 2027, 2028, 2029, 2030]) {
      for (const [texto, mes] of [['Día del Padre', 6], ['Día del Niño', 8], ['Día de la Madre', 10]]) {
        const [y, m, d] = fechaDe(anio, texto).split('-').map(Number);
        expect(m, `${texto} ${anio}`).toBe(mes);
        expect(new Date(y, m - 1, d).getDay(), `${texto} ${anio}`).toBe(0);
        expect(d, `${texto} ${anio}`).toBeGreaterThanOrEqual(15);
        expect(d, `${texto} ${anio}`).toBeLessThanOrEqual(21);
      }
    }
  });

  it('el 1 de enero no arrastra fechas del año anterior', () => {
    expect(fechaDe(2026, 'Reyes Magos')).toBe('2026-01-06');
    expect(fechaDe(2027, 'Reyes Magos')).toBe('2027-01-06');
  });
});

describe('las notas propias', () => {
  it('una nota de un día puntual aparece sólo ese día', () => {
    estado.emitir([{ id: 'a', nombre: 'Pedido de Ledesma', fecha: '2026-09-03', tipo: 'nota' }]);
    expect(cal.customEnFecha('2026-09-03').map(e => e.nombre)).toEqual(['Pedido de Ledesma']);
    expect(cal.customEnFecha('2026-09-04')).toEqual([]);
  });

  it('una anual vuelve todos los años', () => {
    estado.emitir([{ id: 'b', nombre: 'Cumple de Mari', fecha: '03-15', anual: true, tipo: 'personal' }]);
    expect(cal.customEnFecha('2026-03-15').length).toBe(1);
    expect(cal.customEnFecha('2031-03-15').length).toBe(1);
    expect(cal.ocurrenciaEnAnio({ anual: true, fecha: '03-15' }, 2029)).toBe('2029-03-15');
  });

  it('una entrada sin nombre o sin fecha se descarta', () => {
    // Llega de un doc compartido entre PCs: una a medias no puede romper el
    // calendario de todos.
    estado.emitir([
      { id: 'x', nombre: '', fecha: '2026-09-03' },
      { id: 'y', nombre: 'Sin fecha' },
      { id: 'z', nombre: 'Buena', fecha: '2026-09-03' },
    ]);
    expect(cal.customEnFecha('2026-09-03').map(e => e.nombre)).toEqual(['Buena']);
  });

  it('agregar una anual guarda sólo el mes y el día', () => {
    cal.agregarEvento({ nombre: 'Aniversario', fecha: '2026-09-03', tipo: 'personal', anual: true });
    const guardado = estado.escrituras.at(-1).datos.items.at(-1);
    expect(guardado.fecha).toBe('09-03');
    expect(guardado.anual).toBe(true);
  });

  it('borrar saca la entrada y lo guarda', () => {
    estado.emitir([{ id: 'a', nombre: 'Una', fecha: '2026-09-03' },
                   { id: 'b', nombre: 'Otra', fecha: '2026-09-03' }]);
    cal.borrarEvento('a');
    expect(estado.escrituras.at(-1).datos.items.map(e => e.id)).toEqual(['b']);
  });
});

describe('los vencimientos de los gastos fijos', () => {
  beforeEach(async () => {
    estado.balance = {
      montosFijos: [
        { id: 'f1', label: 'Alquiler', venceDia: 10, activo: true },
        { id: 'f2', label: 'Internet', venceDia: 31, activo: true },
        { id: 'f3', label: 'Contadora', venceDia: 5, activo: false },
      ],
      meses: {},
    };
    await cal.refreshVencimientos({});
    // Los pagos se recuerdan por mes durante toda la sesión: se limpian para
    // que cada caso arranque sin nada pagado.
    for (const ym of ['2026-01', '2026-02', '2026-04', '2026-08', '2026-09', '2026-10']) {
      cal.setPagosMesFromDias(ym, {});
    }
  });

  it('avisan el día que vencen', () => {
    const v = cal.vencimientosEnFecha('2026-09-10');
    expect(v.map(x => x.nombre).join(' ')).toMatch(/Alquiler/);
  });

  it('uno que vence el 31 no desaparece en febrero: cae el último día', () => {
    // Sin ajustar al último día del mes, ese fijo dejaría de avisar cuatro
    // meses al año.
    expect(cal.vencimientosEnFecha('2026-02-28').map(x => x.nombre).join(' ')).toMatch(/Internet/);
    expect(cal.vencimientosEnFecha('2026-04-30').map(x => x.nombre).join(' ')).toMatch(/Internet/);
    expect(cal.vencimientosEnFecha('2026-01-31').map(x => x.nombre).join(' ')).toMatch(/Internet/);
  });

  it('uno desactivado no avisa', () => {
    expect(cal.vencimientosEnFecha('2026-09-05')).toEqual([]);
  });

  it('uno dado de baja desde un mes deja de avisar desde ahí', () => {
    estado.balance.montosFijos[0].desactivadoDesde = '2026-10';
    return cal.refreshVencimientos({}).then(() => {
      expect(cal.vencimientosEnFecha('2026-09-10').length).toBe(1);
      expect(cal.vencimientosEnFecha('2026-10-10').length).toBe(0);
    });
  });

  it('excluido a mano en un mes no avisa ese mes', () => {
    estado.balance.meses = { '2026-09': { fijosExcluidos: ['f1'] } };
    return cal.refreshVencimientos({}).then(() => {
      expect(cal.vencimientosEnFecha('2026-09-10').length).toBe(0);
      expect(cal.vencimientosEnFecha('2026-08-10').length).toBe(1);
    });
  });

  it('uno ya pagado se muestra pagado, no vencido', () => {
    cal.setPagosMesFromDias('2026-09', {
      '2026-09-08': { compras: [{ fijo_id: 'f1', monto: 500000 }] },
    });
    const v = cal.vencimientosEnFecha('2026-09-10')[0];
    expect(v.pagado).toBe(true);
    expect(v.nombre).toMatch(/pagado/i);
  });

  it('un pago cargado a mano también cuenta si coincide el proveedor', () => {
    // La gente carga el alquiler como una compra normal del rubro GASTOS FIJOS:
    // si no se reconoce, el calendario lo sigue marcando como impago.
    cal.setPagosMesFromDias('2026-09', {
      '2026-09-08': { compras: [{ rubro: 'Gastos Fijos', proveedor: 'alquiler', monto: 500000 }] },
    });
    expect(cal.vencimientosEnFecha('2026-09-10')[0].pagado).toBe(true);
  });

  it('uno que ya pasó y no se pagó sale como vencido', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 20));    // 20/09/2026
    const v = cal.vencimientosEnFecha('2026-09-10')[0];
    expect(v.nombre).toMatch(/^Vencido/);
    vi.useRealTimers();
  });

  it('el que vence hoy lo dice con todas las letras', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 10));
    expect(cal.vencimientosEnFecha('2026-09-10')[0].nombre).toMatch(/hoy/i);
    vi.useRealTimers();
  });
});

describe('el aviso del menú', () => {
  it('un día común no avisa nada', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 3));      // 03/09/2026, sin nada
    expect(cal.hayEventoHoy().hay).toBe(false);
    vi.useRealTimers();
  });

  it('el 25 de diciembre sí', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 25));
    const r = cal.hayEventoHoy();
    expect(r.hay).toBe(true);
    expect(r.items.map(i => i.nombre).join(' ')).toMatch(/Navidad/);
    vi.useRealTimers();
  });

  it('lo que se viene en los próximos días sale ordenado por cercanía', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 23));    // 23/12
    const prox = cal.proximosEventos(3);
    expect(prox.length).toBeGreaterThan(0);
    expect(prox.map(e => e.dias)).toEqual([...prox.map(e => e.dias)].sort((a, b) => a - b));
    expect(prox.map(e => e.nombre).join(' ')).toMatch(/Nochebuena/);
    vi.useRealTimers();
  });

  it('a fin de año mira también el año que viene', () => {
    // Si sólo mirara el año en curso, el 31 de diciembre no vería Año Nuevo.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 30));
    expect(cal.proximosEventos(3).map(e => e.nombre).join(' ')).toMatch(/Año Nuevo/);
    vi.useRealTimers();
  });

  it('nada se repite dos veces en la lista', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 23));
    const claves = cal.proximosEventos(7).map(e => e.fecha + '|' + e.nombre);
    expect(new Set(claves).size).toBe(claves.length);
    vi.useRealTimers();
  });
});

describe('que el texto se lea sobre el color elegido', () => {
  it('sobre un fondo claro el texto va oscuro', () => {
    expect(cal.textoSobre('#eab308')).toBe('#1c1e21');   // amarillo
  });

  it('sobre uno oscuro va blanco', () => {
    expect(cal.textoSobre('#7b3fa6')).toBe('#fff');      // violeta
  });

  it('un color inválido no rompe', () => {
    expect(cal.textoSobre('')).toBe('#fff');
    expect(cal.textoSobre(null)).toBe('#fff');
    expect(cal.textoSobre('#abc')).toBe('#fff');
  });
});
