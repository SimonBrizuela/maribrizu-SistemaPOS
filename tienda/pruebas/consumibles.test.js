/**
 * De qué producto se descuenta el papel cuando se vende una impresión.
 *
 * El mismo item de `ventas_por_dia` lo miran TRES manos: el POS (que lo resuelve
 * por id de producto, en su propia transacción), el watcher del panel
 * (`webapp/src/consumibles_watcher.js`, si hay una pestaña abierta) y el
 * reconciliador de GitHub Actions cada 6 horas
 * (`scripts/reconciliar_consumibles.py`). Las tres marcan
 * `consumibles_procesado` adentro de una transacción, así que no se pisan.
 *
 * Pero las dos últimas deciden por su cuenta de dónde descontar, y esa decisión
 * está escrita dos veces. Si se separan, el papel se descuenta de un lado y no
 * del otro según quién llegue primero, y eso no lo ve nadie: el stock queda mal
 * sin ningún error en ningún lado.
 *
 * Esta prueba corre las dos sobre los mismos casos y las compara.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.mock('firebase/firestore', async () => (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {} }));
vi.mock('../../webapp/src/cache.js', () => ({ invalidateCacheByPrefix: () => {} }));
vi.mock('../../webapp/src/stock_ledger.js', () => ({ registrarMovimiento: () => {} }));

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..', '..');

const casos = JSON.parse(readFileSync(join(AQUI, 'casos_consumibles.json'), 'utf-8'));

let extraerLinks;
let resolverLinks;
let delPython = null;
let porQueNo = '';

beforeAll(async () => {
  ({ _extraerLinks: extraerLinks, _resolverLinks: resolverLinks } =
    await import('../../webapp/src/consumibles_watcher.js'));

  for (const python of ['python', 'python3', 'py']) {
    try {
      const salida = execFileSync(python, [join(RAIZ, 'scripts', 'casos_consumibles.py')],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      delPython = JSON.parse(salida);
      break;
    } catch (err) {
      porQueNo = String(err?.stderr || err?.message || err).split('\n').slice(-6).join('\n');
    }
  }
});

/** Lo comparable: a qué producto y cuánto. El contexto es texto para el log. */
const soloDestinos = links =>
  links.map(l => ({ doc_id: l.target_id ?? l.doc_id, cantidad: l.cantidad_por_venta ?? l.cantidad }));

describe('el watcher del panel contra el reconciliador', () => {
  it('corre el reconciliador para comparar', () => {
    if (!delPython) console.warn(`\n  [consumibles] sin comparación contra Python:\n${porQueNo}\n`);
    expect(casos.length).toBeGreaterThan(0);
  });

  casos.forEach((caso, i) => {
    it(caso.que_prueba, () => {
      const mio = soloDestinos(resolverLinks(caso.producto, caso.item?.conjunto_color));
      if (!delPython) return;
      const suyo = delPython.items[i];
      expect(suyo.que_prueba).toBe(caso.que_prueba);
      expect(mio).toEqual(suyo.links);
    });
  });

  it('leen igual las dos formas del campo de vínculos', () => {
    if (!delPython) return;
    for (const forma of delPython.formas) {
      expect(soloDestinos(extraerLinks(forma.obj, 'x')), forma.que_prueba)
        .toEqual(forma.links);
    }
  });
});

/* Lo de abajo no depende de Python: son las decisiones que tienen que valer sí
 * o sí, escritas a mano. */
describe('las decisiones que no pueden cambiar', () => {
  it('una impresión descuenta su hoja por cada copia', () => {
    const links = resolverLinks({
      nombre: 'IMPRESION A4',
      vinculaciones: [{ doc_id: 'papel-a4', cantidad: 1 }],
    }, null);
    expect(links).toEqual([
      { target_id: 'papel-a4', cantidad_por_venta: 1, contexto: 'IMPRESION A4' },
    ]);
  });

  it('cada variedad decide su propio descuento', () => {
    // El brillante gasta papel brillante y el mate gasta papel mate: si cayera
    // a los vínculos del producto se descontaría el papel equivocado.
    const producto = {
      nombre: 'IMPRESION FOTO', es_conjunto: true,
      vinculaciones: [{ doc_id: 'papel-comun', cantidad: 1 }],
      conjunto_colores: [
        { color: 'Brillante', vinculaciones: [{ doc_id: 'papel-brillante', cantidad: 1 }] },
        { color: 'Mate', vinculaciones: [{ doc_id: 'papel-mate', cantidad: 1 }] },
      ],
    };
    expect(resolverLinks(producto, 'Mate')[0].target_id).toBe('papel-mate');
    expect(resolverLinks(producto, 'Brillante')[0].target_id).toBe('papel-brillante');
  });

  it('una variedad sin vínculos propios no descuenta nada', () => {
    // A propósito: caer a los del producto sería descontar papel común de una
    // impresión que no lo usa.
    const producto = {
      nombre: 'IMPRESION FOTO', es_conjunto: true,
      vinculaciones: [{ doc_id: 'papel-comun', cantidad: 1 }],
      conjunto_colores: [{ color: 'Brillante' }],
    };
    expect(resolverLinks(producto, 'Brillante')).toEqual([]);
  });

  it('un producto sin vínculos no descuenta nada', () => {
    expect(resolverLinks({ nombre: 'CUADERNO' }, null)).toEqual([]);
    expect(resolverLinks(null, null)).toEqual([]);
  });

  it('un vínculo sin destino o sin cantidad se descarta', () => {
    expect(extraerLinks({ vinculaciones: [{ cantidad: 2 }] }, 'x')).toEqual([]);
    expect(extraerLinks({ vinculaciones: [{ doc_id: 'p', cantidad: 0 }] }, 'x')).toEqual([]);
  });
});
