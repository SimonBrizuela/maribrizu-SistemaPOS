// @vitest-environment jsdom
/**
 * Guardar desde Tienda > Catálogo cuando el espejo público no contesta.
 *
 * Guardar son DOS escrituras: primero el producto en `catalogo` y después el
 * documento del espejo que lee la tienda. La segunda puede fallar sola (la
 * REST devuelve 4xx, se cayó el permiso, no hay sesión) con la primera ya
 * hecha, y ahí la pantalla no puede seguir mostrando lo de antes: al cerrar el
 * editor, la limpieza de fotos huérfanas compara lo que se subió contra lo que
 * hay en memoria y borra de Storage lo que sobra. Con la memoria atrasada, lo
 * que "sobra" es una foto que el catálogo sí referencia, y la ficha queda con
 * la imagen rota sin forma de recuperarla.
 *
 * Acá se prueban las dos pantallas de verdad, moviéndolas a botonazos: el
 * editor del catálogo (`webapp/src/pages/tienda_catalogo.js`) y el panel de
 * Fotos pedidas (`webapp/src/pages/tienda_fotos.js`), que guarda igual. Lo
 * único que se reemplaza son las cuatro escrituras (catálogo, espejo, subir y
 * borrar foto): las reglas de qué se publica y cómo se prepara cada producto
 * siguen siendo las de producción.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const espia = vi.hoisted(() => ({
  catalogo: vi.fn(async () => {}),
  espejo: vi.fn(),
  borrada: vi.fn(async () => {}),
  recuento: vi.fn(),
  // Qué falla en esta prueba y cuántas fotos se subieron ya.
  falla: { catalogo: false, espejo: false },
  subidas: 0,
  // Con qué se quedó el espejo la última vez: publicado o el motivo por el que
  // no. La pantalla se lo come (solo lo usa para el recuento de la portada) y
  // es justo lo que hay que mirar para saber si el producto sale a la web.
  ultimoEspejo: null,
}));

vi.mock('../../webapp/src/tienda_espejo.js', async (original) => {
  const real = await original();
  return {
    ...real,
    actualizarDoc: async (...a) => {
      if (espia.falla.catalogo) throw new Error('permiso denegado en catalogo');
      return espia.catalogo(...a);
    },
    espejar: async (_db, id, datos, rubros, subExcluidos) => {
      espia.espejo(id, { ...datos }, subExcluidos);
      if (espia.falla.espejo) throw new Error('403 al escribir el espejo');
      // La misma regla que en producción: así "publicado" es de verdad lo que
      // saldría a la tienda con esos datos.
      const motivo = real.motivoDeNoPublicar(datos, rubros, subExcluidos);
      espia.ultimoEspejo = { publicado: motivo === null, motivo };
      return espia.ultimoEspejo;
    },
    subirFoto: async () => `https://x/subida-${++espia.subidas}.webp`,
    borrarFoto: (...a) => espia.borrada(...a),
    programarRecuentoDeRubros: (...a) => espia.recuento(...a),
  };
});

vi.mock('../../webapp/src/store.js', () => ({
  onStoreChange: () => () => {},
  ensureCollections: () => {},
  initStore: async () => {},
  storeListo: async () => {},
}));

// Los diálogos de aviso no hacen falta acá y taparían la pantalla.
vi.mock('../../webapp/src/components/dialogs.js', async (original) => ({
  ...(await original()),
  alertDialog: vi.fn(async () => {}),
  confirmDialog: vi.fn(async () => true),
}));

const nube = vi.hoisted(() => ({ catalogo: [], pedidas: [], publicacion: {} }));

vi.mock('firebase/firestore', () => {
  const deColeccion = (nombre) => (nombre === 'catalogo' ? nube.catalogo
    : nombre === 'tienda_fotos_pedidas' ? nube.pedidas : []);
  const instantanea = (lista) => ({
    docs: lista.map(d => ({ id: d.doc_id, ref: { id: d.doc_id }, data: () => d,
                            exists: () => true })),
    empty: lista.length === 0,
    size: lista.length,
    forEach(fn) { this.docs.forEach(fn); },
  });
  return {
    collection: (_db, nombre) => ({ _col: nombre }),
    doc: (_db, col, id) => ({ _col: col, id, path: `${col}/${id}` }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    orderBy: (campo) => ({ campo }),
    limit: (n) => ({ limit: n }),
    where: (campo, op, valor) => ({ campo, op, valor }),
    getDocs: async (q) => instantanea(deColeccion(q?._col)),
    getDoc: async (ref) => {
      const datos = ref?._col === 'tienda_config' && ref.id === 'publicacion'
        ? nube.publicacion
        : nube.catalogo.find(d => ref?._col === 'catalogo' && d.doc_id === ref.id);
      return { exists: () => !!datos, data: () => datos, id: ref?.id };
    },
    // Como en producción la primera vez: no está en el cache local del SDK.
    getDocFromCache: async () => { throw new Error('sin cache local'); },
    onSnapshot: (q, alLlegar) => {
      try { alLlegar?.(instantanea(deColeccion(q?._col))); } catch (_) { /* nada */ }
      return () => {};
    },
    setDoc: async () => {},
    writeBatch: () => ({ update: () => {}, set: () => {}, delete: () => {},
                         commit: async () => {} }),
    serverTimestamp: () => ({ _metodo: 'serverTimestamp' }),
    deleteField: () => ({ _metodo: 'deleteField' }),
  };
});

/* ── El catálogo de la prueba ─────────────────────────────────────────────── */

const FOTO_A = 'https://x/a.webp';
const FOTO_B = 'https://x/b.webp';

// Una caja de gomitas de colores: es lo que ejercita la parte fea del editor
// (una foto por variedad, que es lo que se sube y se puede perder).
const CONJUNTO = {
  doc_id: 'p1', nombre: 'GOMITAS DE COLORES', codigo: 'G1', rubro: 'LIBRERIA',
  sub_rubro: 'ESCOLAR', estado: 'activo', precio_venta: 900,
  conjunto_precio_unidad: 100, es_conjunto: true, conjunto_tipo: 'caja',
  conjunto_contenido: 10, conjunto_total: 20,
  conjunto_colores: [{ color: 'ROJO', unidades: 2, restante: 0, precio: 100 }],
  tienda_imagenes: [FOTO_A, FOTO_B],
};

// Uno común, con una sola foto: sirve para ver qué queda en pantalla cuando el
// espejo falla justo después de borrarla.
const SIMPLE = {
  doc_id: 'p2', nombre: 'CUADERNO RIVADAVIA', codigo: 'C1', rubro: 'LIBRERIA',
  sub_rubro: 'CUADERNOS', estado: 'activo', precio_venta: 3500, stock: 12,
  tienda_imagenes: [FOTO_A],
};

// Le falta la foto y nada más: es el que entra solo a "Esperando foto".
const SIN_FOTO = {
  doc_id: 'p3', nombre: 'TIJERA ESCOLAR', codigo: 'T1', rubro: 'LIBRERIA',
  sub_rubro: 'ESCOLAR', estado: 'activo', precio_venta: 2500, stock: 8,
};

let contenedor;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  espia.catalogo.mockClear();
  espia.espejo.mockClear();
  espia.borrada.mockClear();
  espia.recuento.mockClear();
  espia.falla.catalogo = false;
  espia.falla.espejo = false;
  espia.subidas = 0;
  espia.ultimoEspejo = null;

  nube.catalogo = [structuredClone(CONJUNTO), structuredClone(SIMPLE),
                   structuredClone(SIN_FOTO)];
  nube.pedidas = [];
  nube.publicacion = { rubros: ['LIBRERIA'], subrubros_excluidos: {} };

  // Lo que el navegador tiene y jsdom no: la vista previa de la foto elegida
  // (un blob) y `CSS.escape`, con el que el panel encuentra el renglón.
  URL.createObjectURL = () => 'blob:vista-previa';
  URL.revokeObjectURL = () => {};
  globalThis.CSS = { escape: (t) => String(t) };

  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
});

afterEach(() => {
  document.body.innerHTML = '';
});

const respirar = async (vueltas = 12) => {
  for (let i = 0; i < vueltas; i++) await new Promise(r => setTimeout(r, 0));
};

async function montar() {
  const mod = await import('../../webapp/src/pages/tienda_catalogo.js');
  await mod.renderTiendaCatalogo(contenedor, {});
  await respirar();
}

const fila = (id) => contenedor.querySelector(`.tienda-fila[data-id="${id}"]`);
const filtro = (clave) => contenedor.querySelector(`[data-filtro="${clave}"]`);

async function abrirEditor(id) {
  fila(id).click();
  await respirar();
}

/** Cierra el editor con "Cancelar", que es lo que hace quien no pudo guardar. */
async function cancelar() {
  document.querySelector('.tienda-editor footer [data-cerrar]').click();
  await respirar();
}

/** Sube una foto solo para esa variedad, como el botón "Subir una foto". */
async function ponerleFotoAlRojo() {
  document.querySelector('#edVariedades [data-clave="rojo"] [data-variedad="foto"]').click();
  await respirar();
  const input = document.getElementById('edArchivoVariedad');
  Object.defineProperty(input, 'files', {
    configurable: true, value: [{ name: 'rojo.jpg', type: 'image/jpeg' }],
  });
  input.dispatchEvent(new Event('change'));
  await respirar();
}

async function guardarCambios() {
  document.getElementById('edGuardar').click();
  await respirar();
}

/* ── Las pruebas ──────────────────────────────────────────────────────────── */

describe('el espejo falla con el catálogo ya escrito', () => {
  it('la foto que quedó guardada en el catálogo no se borra de Storage', async () => {
    await montar();
    await abrirEditor('p1');
    await ponerleFotoAlRojo();
    const espejadosAntes = espia.espejo.mock.calls.length;   // ninguno: no se guardó

    espia.falla.espejo = true;
    await guardarCambios();

    // El catálogo sí se escribió, con la variedad apuntando a la foto nueva.
    expect(espia.catalogo).toHaveBeenCalledTimes(1);
    expect(espia.catalogo.mock.calls[0][3].tienda_variedades.rojo.imagen)
      .toBe('https://x/subida-1.webp');
    expect(espia.espejo.mock.calls.length).toBe(espejadosAntes + 1);

    await cancelar();
    // Si se borrara, la ficha quedaría con la imagen rota y no hay vuelta.
    expect(espia.borrada).not.toHaveBeenCalled();
  });

  it('lo que se escribió en el catálogo se ve en la lista, aunque no se espeje', async () => {
    await montar();
    await abrirEditor('p2');

    espia.falla.espejo = true;
    document.querySelector('#edFotos [data-foto="borrar"][data-i="0"]').click();
    await respirar();
    await cancelar();

    // Sin foto ya no sale a la vidriera: tiene que aparecer entre los que
    // están fuera, con el motivo. Antes seguía figurando publicado con la
    // foto vieja hasta recargar la página.
    filtro('ocultos').click();
    await respirar();
    expect(fila('p2')).toBeTruthy();
    expect(fila('p2').textContent).toContain('sin foto');
  });

  it('la foto borrada del producto no se saca de Storage si no se pudo espejar',
    async () => {
      await montar();
      await abrirEditor('p2');

      espia.falla.espejo = true;
      document.querySelector('#edFotos [data-foto="borrar"][data-i="0"]').click();
      await respirar();

      // El producto quedó sin ella en el catálogo, pero el espejo público
      // todavía la muestra: sacarla de Storage ahora es una imagen rota en la
      // tienda hasta la próxima corrida del sync.
      expect(espia.borrada).not.toHaveBeenCalled();
    });
});

describe('el catálogo no se pudo escribir', () => {
  it('no se toca la memoria ni se borra ninguna foto', async () => {
    await montar();
    await abrirEditor('p1');
    await ponerleFotoAlRojo();

    espia.falla.catalogo = true;
    await guardarCambios();

    // Ni siquiera se intentó el espejo, y el producto sigue como estaba.
    expect(espia.espejo).not.toHaveBeenCalled();

    await cancelar();
    // No se sabe si la escritura llegó a aplicarse del otro lado: con la duda,
    // la foto se queda en Storage. Una imagen de más cuesta centavos.
    expect(espia.borrada).not.toHaveBeenCalled();
  });
});

describe('cuando todo sale bien', () => {
  it('la foto subida y descartada se borra de Storage al cerrar', async () => {
    await montar();
    await abrirEditor('p1');
    await ponerleFotoAlRojo();

    // Se arrepiente: le deja la portada y guarda. La subida queda sin dueño.
    document.querySelector('#edVariedades [data-clave="rojo"] [data-variedad="foto"]').click();
    await respirar();
    document.querySelector('.tienda-overlay[data-foto-variedad] [data-accion="quitar"]').click();
    await respirar();
    await guardarCambios();

    expect(espia.borrada).toHaveBeenCalledWith('https://x/subida-1.webp');
  });

  it('guardar la ficha deja la fila con lo nuevo sin esperar a Firestore', async () => {
    await montar();
    await abrirEditor('p1');
    document.getElementById('edNombre').value = 'Gomitas de Colores x10';
    await guardarCambios();

    expect(fila('p1').textContent).toContain('Gomitas de Colores x10');
  });

  it('el conteo de la portada se rehace solo cuando el producto entra o sale',
    async () => {
      await montar();

      // Guardar sin cambiar el estado de publicación no mueve la portada.
      await abrirEditor('p1');
      await guardarCambios();
      expect(espia.recuento).not.toHaveBeenCalled();

      // Sacarlo de la tienda sí.
      fila('p1').querySelector('[data-accion="interruptor"]').click();
      await respirar();
      expect(espia.recuento).toHaveBeenCalled();
    });
});

describe('la pantalla al entrar', () => {
  it('arranca sin filtros de la visita anterior', async () => {
    await montar();
    filtro('ocultos').click();
    contenedor.querySelector('#tiendaBuscar').value = 'cuaderno';
    contenedor.querySelector('#tiendaBuscar').dispatchEvent(new Event('input'));
    await respirar();
    expect(fila('p1')).toBeFalsy();

    // Se sale de la pantalla y se vuelve: la lista tiene que estar entera.
    document.body.innerHTML = '';
    contenedor = document.createElement('div');
    document.body.appendChild(contenedor);
    await montar();

    expect(fila('p1')).toBeTruthy();
    expect(fila('p2')).toBeTruthy();
    expect(filtro('todos').classList.contains('active')).toBe(true);
    expect(contenedor.querySelector('#tiendaBuscar').value).toBe('');
  });

  it('los números de los filtros acompañan el rubro y la búsqueda', async () => {
    await montar();
    const conStock = () => filtro('todos').querySelector('.pc-btn__n').textContent;
    expect(conStock()).toBe('3');

    const buscador = contenedor.querySelector('#tiendaBuscar');
    buscador.value = 'cuaderno';
    buscador.dispatchEvent(new Event('input'));
    await respirar();
    // El número de arriba y la lista de abajo tienen que decir lo mismo.
    expect(conStock()).toBe('1');
    expect(contenedor.querySelectorAll('.tienda-fila').length).toBe(1);
  });
});

/* ── Subrubros destildados ────────────────────────────────────────────────
   Configuración de la Tienda prende el rubro entero y adentro se pueden
   destildar subrubros. El sync los saca del espejo, así que esta pantalla
   tiene que darlos por NO publicados: dándolos por publicados, cada guardado
   (una foto, un nombre) los volvía a subir a la tienda y ahí se quedaban hasta
   la corrida siguiente del sync, seis horas después, que los sacaba otra vez.
   Un producto que aparece y desaparece solo. */

describe('un subrubro destildado en Configuración', () => {
  beforeEach(() => {
    // LIBRERIA prendido, pero CUADERNOS afuera: p2 (CUADERNO RIVADAVIA) no va
    // a la vidriera aunque tenga foto, stock y precio. p1 y p3 son de ESCOLAR,
    // que sigue adentro.
    nube.publicacion = {
      rubros: ['LIBRERIA'],
      subrubros_excluidos: { LIBRERIA: ['CUADERNOS'] },
    };
  });

  it('la fila lo muestra fuera de la tienda, con el motivo', async () => {
    await montar();

    expect(fila('p2').textContent).toContain('el subrubro está excluido');
    expect(fila('p2').querySelector('[data-accion="interruptor"]')
      .getAttribute('aria-checked')).toBe('false');
    // El del mismo rubro y otro subrubro no se lleva nada por delante.
    expect(fila('p1').querySelector('[data-accion="interruptor"]')
      .getAttribute('aria-checked')).toBe('true');

    // Y está en "Fuera de la tienda", que es la lista donde se lo va a buscar.
    filtro('ocultos').click();
    await respirar();
    expect(fila('p2')).toBeTruthy();
    expect(fila('p1')).toBeFalsy();
  });

  it('el editor avisa por qué no está, en vez de decir que se muestra', async () => {
    await montar();
    await abrirEditor('p2');

    const banner = document.getElementById('edBanner').textContent;
    expect(banner).toContain('el subrubro está excluido');
    expect(banner).not.toContain('Se está mostrando en la tienda');
  });

  it('guardarle el nombre no lo vuelve a subir a la tienda', async () => {
    await montar();
    await abrirEditor('p2');
    document.getElementById('edNombre').value = 'Cuaderno Rivadavia 48 hojas';
    await guardarCambios();

    // El espejo recibe la lista de excluidos y contesta con el mismo motivo:
    // el guardado no lo publica de vuelta.
    expect(espia.espejo).toHaveBeenCalledTimes(1);
    expect(espia.espejo.mock.calls[0][2]).toEqual({ LIBRERIA: ['CUADERNOS'] });
    expect(espia.ultimoEspejo)
      .toEqual({ publicado: false, motivo: 'el subrubro está excluido' });

    // La fila queda con el nombre nuevo y sigue fuera de la tienda.
    expect(fila('p2').textContent).toContain('Cuaderno Rivadavia 48 hojas');
    expect(fila('p2').textContent).toContain('el subrubro está excluido');
  });
});

/* ── Fotos pedidas ────────────────────────────────────────────────────────
   La otra pantalla que guarda fotos contra el mismo producto. Guarda igual que
   el catálogo (catálogo y después espejo), y cuando algo falla borra de
   Storage lo que acaba de subir: si el catálogo ya quedó escrito, esas fotos
   son justo las que el producto está mostrando. */

async function montarFotos() {
  const mod = await import('../../webapp/src/pages/tienda_fotos.js');
  await mod.renderTiendaFotos(contenedor, {});
  await respirar();
}

/** Elige un archivo para ese producto, como el botón "Cargar". */
async function elegirFoto(id) {
  contenedor.querySelector(`[data-cargar="${id}"]`).click();
  await respirar();
  const input = document.getElementById('fotosArchivo');
  Object.defineProperty(input, 'files', {
    configurable: true, value: [{ name: 'tijera.jpg', type: 'image/jpeg' }],
  });
  input.dispatchEvent(new Event('change'));
  await respirar();
}

async function guardarPanelDeFotos() {
  document.querySelector('.tienda-overlay[data-panel-fotos] [data-accion="guardar"]').click();
  await respirar();
}

describe('el panel de Fotos pedidas', () => {
  it('la foto recién subida no se borra si el catálogo ya la tiene', async () => {
    await montarFotos();
    await elegirFoto('p3');

    espia.falla.espejo = true;
    await guardarPanelDeFotos();

    expect(espia.catalogo.mock.calls[0][3].tienda_imagenes)
      .toEqual(['https://x/subida-1.webp']);
    // Borrarla dejaría al producto apuntando a un archivo que ya no existe.
    expect(espia.borrada).not.toHaveBeenCalled();
    // Y el panel queda abierto, con el aviso, para volver a intentar.
    expect(document.querySelector('.tienda-overlay[data-panel-fotos]')).toBeTruthy();
  });

  it('si no se pudo escribir el catálogo, lo subido sí se limpia', async () => {
    await montarFotos();
    await elegirFoto('p3');

    espia.falla.catalogo = true;
    await guardarPanelDeFotos();

    expect(espia.borrada).toHaveBeenCalledWith('https://x/subida-1.webp');
  });

  it('con todo bien el producto sale de la lista y la foto se queda', async () => {
    await montarFotos();
    await elegirFoto('p3');
    await guardarPanelDeFotos();

    expect(espia.borrada).not.toHaveBeenCalled();
    expect(contenedor.querySelector('[data-fila="p3"]')).toBeFalsy();
    // Y el panel se cierra solo: si hubiera fallado algo seguiría abierto.
    expect(document.querySelector('.tienda-overlay[data-panel-fotos]')).toBeFalsy();
  });

  it('lo que espera foto no ofrece "Sacar": no hay nada que sacar', async () => {
    // Esa fila la calcula la pantalla del catálogo, no es un pedido guardado.
    // El botón borraba un documento inexistente y la fila volvía al repintar.
    nube.pedidas = [{ doc_id: 'p2', nombre: 'CUADERNO RIVADAVIA', rubro: 'LIBRERIA' }];
    await montarFotos();

    expect(contenedor.querySelector('[data-fila="p3"]')).toBeTruthy();
    expect(contenedor.querySelector('[data-fila="p3"] [data-sacar]')).toBeFalsy();
    // Lo pedido a mano sí: ahí hay un documento que borrar.
    expect(contenedor.querySelector('[data-fila="p2"] [data-sacar]')).toBeTruthy();
  });
});

/*
 * El casillero "Mostrar en la portada, entre los destacados".
 *
 * `tienda_destacado` tiene tres estados: marcado a mano, sacado a mano, y sin
 * decidir. Sin decidir manda el sync, que cuando no hay ninguno a mano elige los
 * doce más vendidos y les escribe `destacado` en el espejo sin tocar el
 * catálogo. Por eso guardar la ficha no puede escribir una decisión que nadie
 * tomó: hasta el 2026-09-08 la tira "Destacados" de la portada bajaba de doce a
 * once cada vez que alguien entraba a cambiarle la descripción a uno de ellos.
 */
describe('el casillero de destacado guarda solo lo que se decidió', () => {
  const cambiosGuardados = () => espia.catalogo.mock.calls[0][3];

  it('guardar sin tocarlo no escribe ninguna decisión', async () => {
    await montar();
    await abrirEditor('p2');
    await guardarCambios();

    const cambios = cambiosGuardados();
    // El campo viaja igual, en `undefined`: eso lo borra del catálogo y deja
    // que el espejo conserve al elegido por el sync.
    expect('tienda_destacado' in cambios).toBe(true);
    expect(cambios.tienda_destacado).toBeUndefined();
  });

  it('marcarlo a mano lo fija', async () => {
    await montar();
    await abrirEditor('p2');
    document.getElementById('edDestacado').click();
    await guardarCambios();

    expect(cambiosGuardados().tienda_destacado).toBe(true);
  });

  it('destildar uno marcado a mano lo saca, y no vuelve al automático', async () => {
    nube.catalogo.find(d => d.doc_id === 'p2').tienda_destacado = true;
    await montar();
    await abrirEditor('p2');
    expect(document.getElementById('edDestacado').checked).toBe(true);

    document.getElementById('edDestacado').click();
    await guardarCambios();

    // `false` y no borrar el campo: borrándolo, el espejo conservaba el
    // `destacado` que ya tenía puesto y destildarlo no hacía nada.
    expect(cambiosGuardados().tienda_destacado).toBe(false);
  });
});
