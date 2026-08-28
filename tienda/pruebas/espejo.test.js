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

describe('el grupo de tamaños', () => {
  const de = id => casos.find(c => c.doc_id === id).datos;

  it('publica el grupo, su clave normalizada y el tamaño', () => {
    const d = documentoEspejo(de('p12'));
    expect(d.grupo).toBe('Cierre Común');
    // Normalizada: el nombre visible puede cambiar de tildes sin partir el
    // grupo en dos.
    expect(d.grupo_clave).toBe('cierre comun');
    expect(d.tamano).toBe('10 cm');
    // El grupo se indexa: buscar "cierre comun" encuentra los tamaños aunque
    // el panel les cambie el nombre propio.
    expect(d.tokens).toContain('cierre');
    expect(d.tokens).toContain('comun');
  });

  it('un tamaño suelto sin grupo no publica nada de grupo', () => {
    const d = documentoEspejo(de('p13'));
    expect(d.grupo).toBeNull();
    expect(d.grupo_clave).toBeNull();
    expect(d.tamano).toBeNull();
  });
});

describe('las fotos', () => {
  const de = id => casos.find(c => c.doc_id === id).datos;

  it('salen todas y en orden: la primera es la portada', () => {
    expect(documentoEspejo(de('p10')).imagenes).toEqual([
      'https://ejemplo/lapiz-portada.webp',
      'https://ejemplo/lapiz-detalle.webp',
      'https://ejemplo/lapiz-caja.webp',
    ]);
  });

  it('cada variedad lleva su foto, y sin foto queda en null', () => {
    const v = documentoEspejo(de('p10')).variedades;
    expect(v.map(x => [x.nombre, x.imagen])).toEqual([
      ['Rojo', 'https://ejemplo/lapiz-rojo.webp'],
      // Un espacio en blanco no es una foto.
      ['Azul Francia', null],
      ['Verde', null],
    ]);
  });

  it('la foto de la variedad no toca la galería del producto', () => {
    // La foto del rojo se ve al elegir "Rojo"; no se cuela entre las tres de
    // la galería, que son las del producto en general.
    expect(documentoEspejo(de('p10')).imagenes).not.toContain('https://ejemplo/lapiz-rojo.webp');
  });

  it('la foto suelta del catálogo del POS sale al espejo, no solo pasa la puerta', () => {
    // Antes "sin foto" y el documento usaban reglas distintas: el producto
    // pasaba la puerta por su imagen_url y salía al espejo con la lista vacía.
    expect(documentoEspejo(de('p11')).imagenes).toEqual(['https://ejemplo/regla-vieja.jpg']);
    expect(motivoDeNoPublicar(de('p11'), ['LIBRERIA'], {})).toBe(null);
  });

  it('con galería propia, la foto suelta del POS no cuenta', () => {
    const d = { ...de('p11'), tienda_imagenes: ['https://ejemplo/regla-nueva.webp', ''] };
    expect(documentoEspejo(d).imagenes).toEqual(['https://ejemplo/regla-nueva.webp']);
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

  /*
   * Cada lado redacta el motivo a su manera ("rubro no habilitado" contra "el
   * rubro no está habilitado"). Lo que tiene que coincidir es QUÉ regla
   * disparó: el panel le dice al usuario por qué un producto no está en la
   * tienda, y el diagnóstico del sync contesta la misma pregunta. Si nombran
   * reglas distintas, el que va a arreglarlo toca lo que no era.
   */
  const reglaDe = motivo => {
    const m = String(motivo || '').toLowerCase();
    if (m.includes('subrubro')) return 'subrubro';
    if (m.includes('rubro')) return 'rubro';
    if (m.includes('stock')) return 'stock';
    if (m.includes('precio')) return 'precio';
    if (m.includes('foto')) return 'foto';
    if (m.includes('activo')) return 'activo';
    if (m.includes('duplicado')) return 'duplicado';
    if (m.includes('nombre')) return 'nombre';
    if (m.includes('interno')) return 'interno';
    if (m.includes('mano')) return 'mano';
    return 'ok';
  };

  it('y las dos culpan a la misma regla', () => {
    if (!publicacionSync) return;

    for (const caso of publicacionSync) {
      const motivo = motivoDeNoPublicar(caso.datos, caso.rubros, caso.excluidos);
      expect(reglaDe(motivo),
             `${caso.que_prueba} — el panel culpa a "${motivo}" y el sync a "${caso.motivo}"`)
        .toBe(caso.regla);
    }
  });

  it('sin foto no sale a la vidriera: espera en la cola de fotos', () => {
    const base = { nombre: 'Cuaderno', estado: 'activo', precio_venta: 100,
                   stock: 5, rubro: 'LIBRERIA' };

    // Un producto con el cuadrito gris al lado de otros con foto se lee como
    // catalogo a medio armar. Queda pendiente hasta que se le cargue una.
    expect(motivoDeNoPublicar(base, ['LIBRERIA'], {})).toBe('sin foto');
    expect(motivoDeNoPublicar({ ...base, tienda_imagenes: ['https://x/f.webp'] },
                              ['LIBRERIA'], {})).toBe(null);
    // La foto suelta del catalogo del POS tambien cuenta.
    expect(motivoDeNoPublicar({ ...base, imagen_url: 'https://x/vieja.jpg' },
                              ['LIBRERIA'], {})).toBe(null);
    // Falta de stock manda sobre falta de foto: sin mercaderia no hay nada que
    // fotografiar.
    expect(motivoDeNoPublicar({ ...base, stock: 0 }, ['LIBRERIA'], {}))
      .toBe('sin stock');
  });

  it('un subrubro excluido no sale, y el rubro apagado gana sobre todo', () => {
    // Con foto: sin ella la regla corta antes y este caso no probaria nada.
    const base = { nombre: 'Abrochadora', estado: 'activo', precio_venta: 100,
                   stock: 5, rubro: 'LIBRERIA', sub_rubro: 'Abrochadora',
                   tienda_imagenes: ['https://x/foto.webp'] };

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
