/**
 * Si el local está abierto ahora.
 *
 * El horario se guarda estructurado —siete días, cada uno con sus tramos— y no
 * como el texto que se muestra. Adivinar "Lunes a viernes de 9 a 13 y de 17 a
 * 20:30 · Sábados de 9 a 13" con expresiones regulares anda hasta que alguien
 * escribe "17hs" o "de 9:00 a 13:00hs", y ahí la tienda cierra sola un martes a
 * la mañana sin que nadie entienda por qué. El texto que se lee se genera desde
 * la estructura, así nunca dicen cosas distintas.
 *
 * La hora es la de Argentina, no la del visitante. Alguien mirando desde España
 * a las 3 de la tarde tiene que ver el local cerrado, porque acá son las 10 de
 * la noche. El país no tiene horario de verano desde 2009, así que UTC-3 fijo
 * alcanza y evita arrastrar una biblioteca de zonas horarias.
 */

const MINUTOS_UTC3 = -3 * 60;

export const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes',
                     'sábado', 'domingo'];

/** El horario de siempre, por si `tienda_config` todavía no lo tiene. */
export const HORARIO_POR_DEFECTO = [
  [{ desde: '09:00', hasta: '13:00' }, { desde: '17:00', hasta: '20:30' }],
  [{ desde: '09:00', hasta: '13:00' }, { desde: '17:00', hasta: '20:30' }],
  [{ desde: '09:00', hasta: '13:00' }, { desde: '17:00', hasta: '20:30' }],
  [{ desde: '09:00', hasta: '13:00' }, { desde: '17:00', hasta: '20:30' }],
  [{ desde: '09:00', hasta: '13:00' }, { desde: '17:00', hasta: '20:30' }],
  [{ desde: '09:00', hasta: '13:00' }, { desde: '17:30', hasta: '20:30' }],
  [],
];

/* ── Tiempo ───────────────────────────────────────────────────────────────── */

/** Qué hora es en Argentina, sin depender del reloj del visitante. */
export function ahoraEnArgentina(fecha = new Date()) {
  const utc = fecha.getTime() + fecha.getTimezoneOffset() * 60_000;
  const local = new Date(utc + MINUTOS_UTC3 * 60_000);
  return {
    // getDay() cuenta desde el domingo; acá la semana arranca el lunes, que es
    // como se lee un cartel de horarios.
    dia: (local.getDay() + 6) % 7,
    minutos: local.getHours() * 60 + local.getMinutes(),
    fecha: local,
  };
}

function aMinutos(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function comoHora(minutos) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return m ? `${h}:${String(m).padStart(2, '0')}` : `${h}`;
}

/**
 * Los tramos de un día, saneados y ordenados.
 *
 * Se aceptan las dos formas a propósito. En memoria el horario es un arreglo de
 * arreglos, que es lo cómodo para editarlo; en Firestore es un arreglo de mapas
 * con `tramos` adentro, porque **Firestore no admite arreglos anidados** y
 * guardar el otro formato falla con "Nested arrays are not supported".
 */
function tramosDe(horario, dia) {
  const bruto = horario?.[dia];
  const lista = Array.isArray(bruto) ? bruto
              : (Array.isArray(bruto?.tramos) ? bruto.tramos : []);
  return lista
    .map(t => ({ desde: aMinutos(t?.desde), hasta: aMinutos(t?.hasta) }))
    .filter(t => t.desde !== null && t.hasta !== null && t.hasta > t.desde)
    .sort((a, b) => a.desde - b.desde);
}

/* ── La pregunta ──────────────────────────────────────────────────────────── */

/**
 * ¿Se puede comprar ahora?
 *
 * Devuelve por qué, no solo sí o no: "cerrado" a secas deja al cliente sin
 * saber si vuelve en veinte minutos o el lunes.
 *
 * @returns {{abierto: boolean, motivo: 'abierto'|'cerrado_a_mano'|'fuera_de_horario',
 *            cierra: string|null, abre: string|null}}
 */
export function estadoDelLocal(cfg, fecha = new Date()) {
  // El interruptor del panel manda sobre el horario: es el que se usa para
  // cerrar por vacaciones o por un feriado que no está en la grilla.
  if (cfg?.abierta === false) {
    return { abierto: false, motivo: 'cerrado_a_mano', cierra: null, abre: null };
  }

  const horario = Array.isArray(cfg?.horarios) && cfg.horarios.length === 7
    ? cfg.horarios
    : null;


  // Sin horario cargado la tienda queda abierta. Es lo que hacía antes de que
  // esto existiera, y es la respuesta correcta ante la duda: perder un pedido
  // por un horario mal configurado es peor que tomarlo fuera de hora.
  if (!horario) {
    return { abierto: true, motivo: 'abierto', cierra: null, abre: null };
  }

  const { dia, minutos } = ahoraEnArgentina(fecha);

  for (const tramo of tramosDe(horario, dia)) {
    if (minutos >= tramo.desde && minutos < tramo.hasta) {
      return { abierto: true, motivo: 'abierto', cierra: comoHora(tramo.hasta), abre: null };
    }
  }

  return {
    abierto: false,
    motivo: 'fuera_de_horario',
    cierra: null,
    abre: proximaApertura(horario, dia, minutos),
  };
}

/**
 * Cuándo vuelve a abrir, dicho como lo diría alguien del local.
 *
 * "Abrimos a las 17" si es hoy, "mañana a las 9", o "el lunes a las 9". Se
 * miran los siete días siguientes; si en toda la semana no abre nunca, devuelve
 * null y el cartel no promete nada.
 */
function proximaApertura(horario, dia, minutos) {
  for (let salto = 0; salto < 8; salto++) {
    const cual = (dia + salto) % 7;
    for (const tramo of tramosDe(horario, cual)) {
      if (salto === 0 && tramo.desde <= minutos) continue;
      const hora = comoHora(tramo.desde);
      if (salto === 0) return `hoy a las ${hora}`;
      if (salto === 1) return `mañana a las ${hora}`;
      return `el ${DIAS[cual]} a las ${hora}`;
    }
  }
  return null;
}

/* ── El cartel ────────────────────────────────────────────────────────────── */

/**
 * El texto de los horarios, armado desde la estructura.
 *
 * Junta los días seguidos que tienen el mismo horario, que es como se escribe
 * un cartel: "Lunes a viernes de 9 a 13 y de 17 a 20:30", no cinco renglones
 * iguales.
 */
export function textoDeHorarios(horario) {
  if (!Array.isArray(horario) || horario.length !== 7) return '';

  const comoTexto = dia => {
    const tramos = tramosDe(horario, dia);
    if (!tramos.length) return 'cerrado';
    return tramos.map(t => `de ${comoHora(t.desde)} a ${comoHora(t.hasta)}`).join(' y ');
  };

  const partes = [];
  let inicio = 0;

  for (let dia = 1; dia <= 7; dia++) {
    if (dia < 7 && comoTexto(dia) === comoTexto(inicio)) continue;

    const fin = dia - 1;
    const horas = comoTexto(inicio);
    const nombre = inicio === fin
      ? mayuscula(DIAS[inicio])
      : `${mayuscula(DIAS[inicio])} a ${DIAS[fin]}`;

    partes.push(horas === 'cerrado' ? `${nombre} cerrado` : `${nombre} ${horas}`);
    inicio = dia;
  }

  return partes.join(' · ');
}

function mayuscula(texto) {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/**
 * Lo que dice el cartel cuando está cerrado.
 *
 * Siempre con la vuelta: "cerrado" a secas hace que la persona se vaya, y saber
 * que abre en dos horas la hace volver. Cuando el cierre es a mano no se
 * promete un horario, porque nadie sabe cuándo termina unas vacaciones.
 */
export function textoDeCerrado(estado) {
  if (estado.motivo === 'cerrado_a_mano') {
    return 'La tienda está cerrada por ahora. Podés mirar el catálogo, '
         + 'pero no tomamos pedidos.';
  }
  return estado.abre
    ? `Ahora está cerrado. Abrimos ${estado.abre}: podés mirar el catálogo y `
      + 'dejar el pedido armado.'
    : 'Ahora está cerrado. Podés mirar el catálogo, pero no tomamos pedidos.';
}
