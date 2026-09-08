/**
 * El que trae los casos de Python no puede devolver "todo bien" cuando no los
 * trajo.
 *
 * De esto dependen las dos pruebas que cuidan la regla escrita dos veces
 * (`espejo.test.js` y `descuentos_regla.test.js`). El 08-09-2026 se probó romper
 * `scripts/casos_espejo.py` con un `raise SystemExit` y la suite dio "66 tests
 * passed": los casos quedaban en null, el aviso era un console.warn que el
 * reporter por defecto no muestra y cada comparación se salteaba sola. Acá se
 * prueban las formas de fallar que hay que distinguir del éxito: el guión que
 * revienta, el que no imprime JSON, el que ya no trae la clave que la prueba
 * usa, y la máquina sin Python.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { correrGuionDePython, GUION_ESPEJO } from './casos_del_sync.js';

const CARPETA = mkdtempSync(join(tmpdir(), 'casos-del-sync-'));
afterAll(() => rmSync(CARPETA, { recursive: true, force: true }));

/** Un guión de mentira, para no tocar el de verdad. */
const guion = (nombre, cuerpo) => {
  const ruta = join(CARPETA, nombre);
  writeFileSync(ruta, cuerpo, 'utf-8');
  return ruta;
};

describe('traer los casos del guión de Python', () => {
  it('el guión de verdad trae las tres tandas', () => {
    // Esto es lo que hace que la comparación panel-contra-sync corra de verdad
    // en esta máquina. Si se cae, se cayó con ruido.
    const { casos, porQueNo } = correrGuionDePython(
      GUION_ESPEJO, ['documentos', 'publicacion', 'descuentos']);

    expect(porQueNo, 'no corrió scripts/casos_espejo.py').toBe('');
    expect(casos.documentos.length).toBeGreaterThan(0);
    expect(casos.publicacion.length).toBeGreaterThan(0);
    expect(casos.descuentos.length).toBeGreaterThan(0);
  });

  it('un guión que revienta no pasa por bueno', () => {
    const roto = guion('revienta.py', 'raise SystemExit("no me da la gana")\n');
    const { casos, porQueNo } = correrGuionDePython(roto, ['documentos']);

    expect(casos).toBeNull();
    expect(porQueNo).toContain('no me da la gana');
  });

  it('un guión que no imprime JSON tampoco', () => {
    // El caso real: el guión importa sync_tienda, algo escribe una advertencia
    // en la salida y lo que llega no es un JSON.
    const mudo = guion('mudo.py', 'print("Warning: firebase_admin no está instalado")\n');
    const { casos, porQueNo } = correrGuionDePython(mudo, ['documentos']);

    expect(casos).toBeNull();
    expect(porQueNo).toContain('no es JSON');
  });

  it('una clave renombrada se ve, en vez de comparar contra nada', () => {
    // Si el guión deja de llamarle `descuentos` a su tanda, el arreglo queda
    // vacío y el `for` de la comparación no da una sola vuelta: verde sin
    // haber comparado. Tiene que fallar y decir qué clave falta.
    const otroNombre = guion('renombrada.py',
      'import json\nprint(json.dumps({"documentos": [1], "rebajas": [1]}))\n');
    const { casos, porQueNo } = correrGuionDePython(otroNombre, ['documentos', 'descuentos']);

    expect(casos).toBeNull();
    expect(porQueNo).toContain('descuentos');
    // Y dice qué sí vino, para no salir a buscar a ciegas.
    expect(porQueNo).toContain('rebajas');
  });

  it('una tanda vacía es lo mismo que no tenerla', () => {
    const vacia = guion('vacia.py', 'import json\nprint(json.dumps({"documentos": []}))\n');
    const { casos } = correrGuionDePython(vacia, ['documentos']);

    expect(casos).toBeNull();
  });

  it('sin Python no inventa casos', () => {
    const { casos, porQueNo } = correrGuionDePython(
      GUION_ESPEJO, ['documentos'], ['python-que-no-existe']);

    expect(casos).toBeNull();
    expect(porQueNo).toContain('python-que-no-existe');
  });

  it('si el primer intérprete no está, sigue con el que sigue', () => {
    // En Linux el ejecutable es `python3` y en Windows a veces solo está `py`.
    const bueno = guion('bueno.py', 'import json\nprint(json.dumps({"documentos": [1]}))\n');
    const { casos, porQueNo } = correrGuionDePython(
      bueno, ['documentos'], ['python-que-no-existe', 'python', 'python3', 'py']);

    expect(porQueNo).toBe('');
    expect(casos.documentos).toEqual([1]);
  });
});
