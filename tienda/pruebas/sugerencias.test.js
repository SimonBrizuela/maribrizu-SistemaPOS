// @vitest-environment jsdom
/**
 * Las sugerencias del buscador cuando se busca parado en un rubro.
 *
 * El caso que costaba ventas: parado en Papelera, escribir "boligrafo" contestaba
 * "Nada con «boligrafo» en este rubro" con doscientos bolígrafos en Librería. El
 * botón "Buscar en todo" estaba, pero pedirle un clic a alguien que acaba de
 * leer "no hay" es pedirle que no nos crea: se va y compra en otro lado.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { llamadas, respuestas } = vi.hoisted(() => ({
  llamadas: [],
  respuestas: { porRubro: [], global: [] },
}));

vi.mock('firebase/firestore', async () =>
  (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../src/firebase.js', () => ({ db: {}, app: {} }));

vi.mock('../src/datos.js', async (original) => ({
  ...(await original()),
  sugerir: async (texto, { rubro = null } = {}) => {
    llamadas.push({ texto, rubro });
    return rubro ? respuestas.porRubro : respuestas.global;
  },
}));

vi.mock('../src/router.js', async (original) => ({
  ...(await original()),
  ir: () => {},
}));

const { iniciarSugerencias, fijarAmbito, reponerAmbito, cerrarSugerencias } =
  await import('../src/sugerencias.js');

const boligrafo = {
  id: 'b1', nombre: 'Bolígrafo Bic Azul', precio: 900, stock: 40,
  rubro: 'LIBRERIA', marca: 'BIC', imagenes: [], unidad: 'unidad', tokens: ['boligrafo'],
};

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

/** Escribe en el buscador y espera a que la consulta pinte. */
async function escribir(texto) {
  const campo = document.querySelector('.buscador__input');
  campo.value = texto;
  campo.dispatchEvent(new Event('input', { bubbles: true }));
  await esperar(320);   // el rebote es de 220 ms
}

let enganchado = false;

beforeEach(() => {
  llamadas.length = 0;
  respuestas.porRubro = [];
  respuestas.global = [];
  document.body.innerHTML = `
    <form data-buscador>
      <input class="buscador__input" id="q" type="search">
    </form>`;
  if (!enganchado) { iniciarSugerencias(); enganchado = true; }
  fijarAmbito(null);
});

afterEach(() => cerrarSugerencias());

describe('buscando dentro de un rubro', () => {
  it('lo dice y ofrece salir a todo el catálogo', async () => {
    respuestas.porRubro = [boligrafo];
    fijarAmbito('PAPELERIA');
    await escribir('boligrafo');

    const caja = document.querySelector('.sugerencias');
    expect(caja.textContent).toContain('Buscando en');
    expect(caja.querySelector('[data-todo-el-catalogo]')).not.toBeNull();
  });

  it('sin nada en el rubro, sale a buscar en todo sin pedir un clic', async () => {
    respuestas.porRubro = [];
    respuestas.global = [boligrafo];
    fijarAmbito('PAPELERIA');
    await escribir('boligrafo');

    // Se preguntaron las dos cosas: primero el rubro, después todo.
    expect(llamadas.map(l => l.rubro)).toEqual(['PAPELERIA', null]);

    const caja = document.querySelector('.sugerencias');
    expect(caja.textContent).toContain('Bolígrafo Bic Azul');
    // Y se avisa por qué cambió, que si no parece que el filtro se soltó solo.
    expect(caja.querySelector('.sugerencias__ambito--global')).not.toBeNull();
    expect(caja.textContent).toContain('todo el catálogo');
    // Ya se está mirando todo: ofrecer "Buscar en todo" sería un botón muerto.
    expect(caja.querySelector('[data-todo-el-catalogo]')).toBeNull();
  });

  it('si no está en ningún lado no manda a mirar a otro rubro', async () => {
    respuestas.porRubro = [];
    respuestas.global = [];
    fijarAmbito('PAPELERIA');
    await escribir('zzzz');

    const caja = document.querySelector('.sugerencias');
    expect(caja.textContent).toContain('en el catálogo');
    expect(caja.textContent).not.toContain('en este rubro');
    expect(caja.querySelector('.sugerencias__ambito')).toBeNull();
  });

  it('fuera de un rubro no se consulta dos veces', async () => {
    respuestas.global = [];
    fijarAmbito(null);
    await escribir('zzzz');

    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].rubro).toBeNull();
  });
});

describe('el cartel de en que rubro se busca', () => {
  // El encabezado se repinta despues de dibujar cada pantalla y se lleva puesto
  // el campo: quedaba "Buscar cuadernos, hilos, juguetes..." estando adentro de
  // un rubro, o sea que la unica senal de que la busqueda estaba acotada no se
  // veia nunca.
  it('sobrevive al repintado del encabezado', () => {
    fijarAmbito('PAPELERA');
    expect(document.querySelector('.buscador__input').placeholder).toContain('Papelera');

    document.body.innerHTML = `
      <form data-buscador>
        <input class="buscador__input" id="q" type="search">
      </form>`;
    expect(document.querySelector('.buscador__input').placeholder).toBe('');

    reponerAmbito();
    expect(document.querySelector('.buscador__input').placeholder).toContain('Papelera');
  });

  it('fuera de un rubro vuelve el de siempre', () => {
    fijarAmbito('PAPELERA');
    fijarAmbito(null);
    expect(document.querySelector('.buscador__input').placeholder).toContain('cuadernos');
  });
});
