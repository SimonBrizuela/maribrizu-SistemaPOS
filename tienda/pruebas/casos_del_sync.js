/**
 * Correr un guión de Python de casos y traer lo que devuelve.
 *
 * Varias reglas del negocio están escritas dos veces, una en el panel
 * (JavaScript) y otra en el sync o en el POS (Python). La única forma de que
 * esa duplicación sea segura es correr las dos sobre los mismos casos y
 * comparar: `scripts/casos_espejo.py` escupe los suyos como JSON y
 * `espejo.test.js` / `descuentos_regla.test.js` los comparan contra los del
 * panel.
 *
 * Antes cada prueba tenía su propia copia de este arranque y, si Python fallaba,
 * dejaba los casos en null, avisaba con un console.warn y seguía. El warn no
 * sale en el reporter por defecto: el 08-09-2026 se le puso un `raise SystemExit`
 * arriba a casos_espejo.py y la suite reportó "66 tests passed" sin haber
 * comparado una sola vez. La duplicación quedaba sin cuidado y nadie se
 * enteraba. Por eso el que corre el guión no decide nada: devuelve los casos o
 * el motivo, y la prueba falla si no los tiene.
 *
 * También valida que estén las claves que la prueba va a usar: si alguien
 * renombra `descuentos` en el guión, la comparación no puede quedar en verde
 * comparando un arreglo vacío contra nada.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));

/** La raíz del repo, para armar la ruta de los guiones. */
export const RAIZ = join(AQUI, '..', '..');

/** El guión del espejo, en un solo lugar: si se muda, se arregla acá. */
export const GUION_ESPEJO = join(RAIZ, 'scripts', 'casos_espejo.py');

// En esta PC el ejecutable es `python`; en Linux suele ser `python3` y el
// lanzador de Windows es `py`. Se prueban en ese orden.
const INTERPRETES = ['python', 'python3', 'py'];

/** Las últimas líneas del error, que son las que dicen algo. */
const detalle = err =>
  String(err?.stderr || err?.message || err).split('\n').slice(-6).join('\n');

/**
 * Corre `guion` con el primer Python que exista y devuelve
 * `{ casos, porQueNo }`. `casos` es el JSON parseado, o null si algo salió mal;
 * `porQueNo` explica qué, para que la prueba lo muestre al fallar.
 *
 * `claves` son las que la prueba va a usar: cada una tiene que venir como un
 * arreglo con al menos un caso adentro.
 */
export function correrGuionDePython(guion, claves = [], interpretes = INTERPRETES) {
  let porQueNo = 'no se probó ningún intérprete de Python';

  for (const python of interpretes) {
    let salida;
    try {
      salida = execFileSync(python, [guion],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // Puede ser que este Python no exista (y el que sigue sí) o que el guión
      // haya reventado. En los dos casos se prueba el siguiente intérprete;
      // si no queda ninguno, el motivo que se muestra es el último.
      porQueNo = `${python}: ${detalle(err)}`;
      continue;
    }

    // De acá para abajo el intérprete anduvo y el guión terminó bien: si lo que
    // devolvió no sirve, probar con otro Python daría exactamente lo mismo.
    let casos;
    try {
      casos = JSON.parse(salida);
    } catch (err) {
      return { casos: null,
               porQueNo: `${python}: la salida no es JSON — ${detalle(err)}\n${salida.slice(0, 300)}` };
    }

    const faltan = claves.filter(
      clave => !Array.isArray(casos?.[clave]) || casos[clave].length === 0);
    if (faltan.length) {
      return { casos: null,
               porQueNo: `${python}: la salida no trae casos en ${faltan.join(', ')} `
                         + `(claves que sí vinieron: ${Object.keys(casos ?? {}).join(', ') || 'ninguna'})` };
    }

    return { casos, porQueNo: '' };
  }

  return { casos: null, porQueNo };
}
