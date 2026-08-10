/**
 * La tienda abre y cierra sola.
 *
 * Todo se prueba con fechas fijas y en hora de Argentina: si esto se equivoca,
 * el local aparece cerrado un martes a las once de la mañana y nadie entiende
 * por qué.
 */
import { describe, it, expect } from 'vitest';
import { estadoDelLocal, textoDeHorarios, ahoraEnArgentina, HORARIO_POR_DEFECTO }
  from '../src/horarios.js';

const cfg = { abierta: true, horarios: HORARIO_POR_DEFECTO };

/** Un momento exacto en hora argentina, escrito como UTC para no depender del
 *  reloj de la máquina que corre las pruebas. */
const enArgentina = (iso) => new Date(`${iso}-03:00`);

describe('qué hora es acá', () => {
  it('lleva cualquier reloj a la hora de Argentina', () => {
    // Mediodía en Londres es la mañana acá.
    const { dia, minutos } = ahoraEnArgentina(new Date('2026-08-10T12:00:00Z'));
    expect(minutos).toBe(9 * 60);
    expect(dia).toBe(0);          // lunes
  });

  it('la semana arranca el lunes, como el cartel', () => {
    expect(ahoraEnArgentina(enArgentina('2026-08-10T10:00:00')).dia).toBe(0); // lunes
    expect(ahoraEnArgentina(enArgentina('2026-08-15T10:00:00')).dia).toBe(5); // sábado
    expect(ahoraEnArgentina(enArgentina('2026-08-16T10:00:00')).dia).toBe(6); // domingo
  });
});

describe('abierto y cerrado', () => {
  it('un lunes a las 10 está abierto', () => {
    const e = estadoDelLocal(cfg, enArgentina('2026-08-10T10:00:00'));
    expect(e.abierto).toBe(true);
    expect(e.cierra).toBe('13');
  });

  it('el mediodía largo está cerrado, y dice a qué hora vuelve', () => {
    const e = estadoDelLocal(cfg, enArgentina('2026-08-10T15:00:00'));
    expect(e.abierto).toBe(false);
    expect(e.motivo).toBe('fuera_de_horario');
    expect(e.abre).toBe('hoy a las 17');
  });

  it('a las 20:30 en punto ya cerró', () => {
    expect(estadoDelLocal(cfg, enArgentina('2026-08-10T20:29:00')).abierto).toBe(true);
    expect(estadoDelLocal(cfg, enArgentina('2026-08-10T20:30:00')).abierto).toBe(false);
  });

  it('de noche dice que abre mañana', () => {
    const e = estadoDelLocal(cfg, enArgentina('2026-08-10T22:00:00'));
    expect(e.abierto).toBe(false);
    expect(e.abre).toBe('mañana a las 9');
  });

  it('el domingo está cerrado todo el día', () => {
    const e = estadoDelLocal(cfg, enArgentina('2026-08-16T11:00:00'));
    expect(e.abierto).toBe(false);
    // Un domingo, el lunes es mañana: decir "el lunes" sería raro.
    expect(e.abre).toBe('mañana a las 9');
  });

  it('el sábado a la noche dice el día, porque el domingo no abre', () => {
    const e = estadoDelLocal(cfg, enArgentina('2026-08-15T23:00:00'));
    expect(e.abierto).toBe(false);
    expect(e.abre).toBe('el lunes a las 9');
  });

  it('el sábado abre a las 17:30 y no a las 17', () => {
    expect(estadoDelLocal(cfg, enArgentina('2026-08-15T17:10:00')).abierto).toBe(false);
    expect(estadoDelLocal(cfg, enArgentina('2026-08-15T17:40:00')).abierto).toBe(true);
  });

  it('el sábado a la tarde dice que abre a las 17:30', () => {
    expect(estadoDelLocal(cfg, enArgentina('2026-08-15T14:00:00')).abre)
      .toBe('hoy a las 17:30');
  });

  it('la hora que se mira es la de acá, no la del visitante', () => {
    // Las 15:00 en España son las 10 de la mañana en Córdoba: abierto.
    const e = estadoDelLocal(cfg, new Date('2026-08-10T13:00:00Z'));
    expect(e.abierto).toBe(true);
  });
});

describe('el interruptor del panel manda', () => {
  it('cerrado a mano cierra aunque sea horario de atención', () => {
    const e = estadoDelLocal({ ...cfg, abierta: false }, enArgentina('2026-08-10T10:00:00'));
    expect(e.abierto).toBe(false);
    expect(e.motivo).toBe('cerrado_a_mano');
  });

  it('sin horario cargado la tienda queda abierta', () => {
    // Ante la duda se vende: perder un pedido por un horario mal configurado es
    // peor que tomarlo fuera de hora.
    const e = estadoDelLocal({ abierta: true }, enArgentina('2026-08-16T03:00:00'));
    expect(e.abierto).toBe(true);
  });

  it('un horario incompleto no cierra la tienda', () => {
    const e = estadoDelLocal({ abierta: true, horarios: [[], []] },
                             enArgentina('2026-08-10T10:00:00'));
    expect(e.abierto).toBe(true);
  });

  it('un tramo al revés se ignora en vez de romper', () => {
    const roto = [[{ desde: '20:00', hasta: '09:00' }], [], [], [], [], [], []];
    const e = estadoDelLocal({ abierta: true, horarios: roto },
                             enArgentina('2026-08-10T21:00:00'));
    expect(e.abierto).toBe(false);
  });
});

describe('la forma que se guarda en la base', () => {
  it('acepta el mapa por día que exige Firestore', () => {
    // Firestore no admite arreglos anidados: cada día se guarda como un mapa
    // con `tramos` adentro. Guardar arreglo de arreglos falla con "Nested
    // arrays are not supported" y no se guarda nada del documento.
    const comoEnLaBase = HORARIO_POR_DEFECTO.map(tramos => ({ tramos }));
    const e = estadoDelLocal({ abierta: true, horarios: comoEnLaBase },
                             enArgentina('2026-08-10T10:00:00'));
    expect(e.abierto).toBe(true);
    expect(textoDeHorarios(comoEnLaBase)).toContain('Lunes a viernes de 9 a 13');
  });
});

describe('el cartel de horarios', () => {
  it('junta los días seguidos que abren igual', () => {
    expect(textoDeHorarios(HORARIO_POR_DEFECTO)).toBe(
      'Lunes a viernes de 9 a 13 y de 17 a 20:30 · '
      + 'Sábado de 9 a 13 y de 17:30 a 20:30 · Domingo cerrado');
  });

  it('un día suelto se nombra solo', () => {
    const uno = [[], [], [{ desde: '09:00', hasta: '12:00' }], [], [], [], []];
    expect(textoDeHorarios(uno)).toContain('Miércoles de 9 a 12');
  });

  it('cerrado toda la semana se dice', () => {
    expect(textoDeHorarios([[], [], [], [], [], [], []])).toBe('Lunes a domingo cerrado');
  });
});
