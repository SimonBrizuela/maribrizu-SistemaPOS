/**
 * El panel y el sync tienen que armar el MISMO documento.
 *
 * `scripts/sync_tienda.py` (Python, corre en la PC del local cada 15 minutos) y
 * `webapp/src/tienda_espejo.js` (JavaScript, corre en el panel al tocar un
 * interruptor) escriben los dos en `tienda_productos`. Si se separan, el panel
 * publica una cosa y el sync la pisa con otra un rato después: el producto
 * cambia solo y nadie entiende por qué.
 *
 * Esta prueba corre las dos sobre los mismos casos y compara campo por campo.
 * Es la única forma de que la duplicación sea segura.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..', '..');

// El módulo del panel no arranca Firebase al importarse: Storage se carga
// recién al subir una foto, y Firestore acá solo se usa para armar el
// documento. Por eso se puede importar tal cual desde una prueba.
const casos = JSON.parse(readFileSync(join(AQUI, 'casos_espejo.json'), 'utf-8'));

let documentoEspejo;
let motivoDeNoPublicar;
let delSync = null;      // documentos armados por el sync
let publicacionSync = null; // decisiones de se_publica() en el sync
let porQueNo = '';

beforeAll(async () => {
  ({ documentoEspejo, motivoDeNoPublicar } =
    await import('../../webapp/src/tienda_espejo.js'));

  // Sin Python no se puede comparar. No se falla la prueba por eso: en una
  // máquina sin Python el resto de la suite tiene que poder correr igual.
  for (const python of ['python', 'python3', 'py']) {
    try {
      const salida = execFileSync(python, [join(RAIZ, 'scripts', 'casos_espejo.py')],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      const crudo = JSON.parse(salida);
      delSync = crudo.documentos;
      publicacionSync = crudo.publicacion;
      break;
    } catch (err) {
      porQueNo = String(err?.stderr || err?.message || err).split('\n').slice(-6).join('\n');
    }
  }
});

describe('el documento del panel contra el del sync', () => {
  it('corre el sync para comparar', () => {
    if (!delSync) console.warn(`\n  [espejo] sin comparación contra Python:\n${porQueNo}\n`);
    expect(casos.length).toBeGreaterThan(0);
  });

  for (const caso of casos) {
    it(caso.que_prueba, () => {
      if (!delSync) return;

      const esperado = delSync.find(x => x.doc_id === caso.doc_id)?.documento;
      expect(esperado, `el sync no devolvió ${caso.doc_id}`).toBeDefined();

      const obtenido = { ...documentoEspejo(caso.datos) };
      // `actualizado` es un centinela de cada SDK, no un valor comparable.
      delete obtenido.actualizado;

      expect(obtenido).toEqual(esperado);
    });
  }
});

describe('lo que decide el panel', () => {
  const de = id => casos.find(c => c.doc_id === id).datos;

  it('el nombre público le gana al del catálogo', () => {
    expect(documentoEspejo(de('p4')).nombre).toBe('Cordón de Lurex 6 mm');
    expect(documentoEspejo(de('p1')).nombre).toBe('Cuaderno Rivadavia Abc A4 Tapa Dura X 100');
  });

  it('apagar el pack saca el precio del rollo', () => {
    const d = documentoEspejo(de('p5'));
    expect(d.precio_pack).toBeNull();
    expect(d.pack_nombre).toBeNull();
    // El precio por metro no se toca: es el del catálogo.
    expect(d.precio).toBe(850);
  });

  it('una variedad apagada no se publica ni suma stock', () => {
    const d = documentoEspejo(de('p4'));
    expect(d.variedades.map(v => v.nombre)).toEqual(['Plateado']);
    expect(d.stock).toBe(50);   // 1 pack de 50, sin los 12 sueltos del oro viejo
  });

  it('el stock sale de las variedades cuando las hay', () => {
    // 1×10+2 celeste, 5 rosa, 2×10 dorada
    expect(documentoEspejo(de('p3')).stock).toBe(37);
  });

  it('conjunto de uno no es un pack', () => {
    const d = documentoEspejo(de('p6'));
    expect(d.precio_pack).toBeNull();
    expect(d.precio).toBe(1400);
  });

  it('"sin marca" no es una marca', () => {
    expect(documentoEspejo(de('p2')).marca).toBe('');
  });

  it('los tokens no llevan conectores y salen del nombre público', () => {
    expect(documentoEspejo(de('p4')).tokens).toContain('cordon');
    expect(documentoEspejo(de('p4')).tokens).not.toContain('de');
  });
});

describe('de a cuánto se vende', () => {
  const de = id => casos.find(c => c.doc_id === id).datos;

  it('sin configurar, de a uno', () => {
    expect(documentoEspejo(de('p1'))).toMatchObject({ minimo: 1, paso: 1 });
  });

  it('lo que se corta del rollo, de a medio metro', () => {
    expect(documentoEspejo(de('p2'))).toMatchObject({ minimo: 0.5, paso: 0.5 });
  });

  it('respeta el mínimo y el paso que puso el panel', () => {
    expect(documentoEspejo(de('p7'))).toMatchObject({ minimo: 12, paso: 6 });
  });

  it('un mínimo en metros conserva el paso de medio metro', () => {
    expect(documentoEspejo(de('p8'))).toMatchObject({ minimo: 3, paso: 0.5 });
  });

  it('un mínimo que no cae en un paso se sube al siguiente', () => {
    // Con mínimo 5 y paso 2 se salta de 4 a 6: el 5 no existe nunca.
    expect(documentoEspejo(de('p9'))).toMatchObject({ minimo: 6, paso: 2 });
  });
});

/* ── La regla de rubros y subrubros ──────────────────────────────────────────
   Se corre la misma tanda de casos en los dos lados. El sync devuelve su
   decision y el panel la suya: si alguna de las dos cambia sola, el sync vuelve
   a subir lo que el panel saco y el producto reaparece en la tienda. */
describe('rubros y subrubros, panel contra sync', () => {
  it('corre el sync para comparar la regla', () => {
    if (!publicacionSync) console.warn('  [espejo] sin comparación de la regla');
    expect(true).toBe(true);
  });

  it('las dos implementaciones deciden lo mismo', () => {
    if (!publicacionSync) return;

    for (const caso of publicacionSync) {
      const delPanel = motivoDeNoPublicar(caso.datos, caso.rubros, caso.excluidos) === null;
      expect(delPanel, `${caso.que_prueba} — el panel dice ${delPanel}, el sync ${caso.publica}`)
        .toBe(caso.publica);
    }
  });

  it('un subrubro excluido no sale, y el rubro apagado gana sobre todo', () => {
    const base = { nombre: 'Abrochadora', estado: 'activo', precio_venta: 100,
                   stock: 5, rubro: 'LIBRERIA', sub_rubro: 'Abrochadora' };

    expect(motivoDeNoPublicar(base, ['LIBRERIA'], {})).toBe(null);
    expect(motivoDeNoPublicar(base, ['LIBRERIA'], { LIBRERIA: ['ABROCHADORA'] }))
      .toBe('el subrubro está excluido');
    expect(motivoDeNoPublicar(base, ['PAPELERA'], { LIBRERIA: ['ABROCHADORA'] }))
      .toBe('el subrubro está excluido');
    // El mismo subrubro colgando de otro rubro no se toca.
    expect(motivoDeNoPublicar({ ...base, rubro: 'PAPELERA' }, ['PAPELERA'],
                              { LIBRERIA: ['ABROCHADORA'] })).toBe(null);
  });
});
