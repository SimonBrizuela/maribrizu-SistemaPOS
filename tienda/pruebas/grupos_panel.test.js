/**
 * Cómo el panel propone un grupo de tamaños a partir de los nombres.
 *
 * Armar un grupo tiene que ser tildar productos y guardar: el nombre del
 * grupo y la etiqueta de cada tamaño salen solos de lo que los nombres
 * comparten. Acá se prueba esa derivación (webapp/src/tienda_grupos.js).
 */
import { describe, it, expect } from 'vitest';
import { prefijoComun, restoDeNombre, nombreBaseDe, sugerirGrupo }
  from '../../webapp/src/tienda_grupos.js';

describe('el prefijo común', () => {
  it('es lo que todos los nombres comparten al principio', () => {
    expect(prefijoComun(['Cierre Común 10 cm', 'Cierre Común 12 cm', 'Cierre Común 14 cm']))
      .toBe('Cierre Común');
  });

  it('no deja una frase cortada: el "Nº" colgante se cae', () => {
    expect(prefijoComun(['Cinta Raso Nº 1', 'Cinta Raso Nº 3'])).toBe('Cinta Raso');
  });

  it('compara sin importar mayúsculas, pero conserva cómo se escribió', () => {
    expect(prefijoComun(['CIERRE COMUN 10 CM', 'Cierre Comun 12 cm'])).toBe('CIERRE COMUN');
  });

  it('sin nada en común queda vacío', () => {
    expect(prefijoComun(['Goma Eva', 'Cartulina Luma'])).toBe('');
  });
});

describe('la etiqueta de cada tamaño', () => {
  it('es lo que le queda al nombre después del prefijo', () => {
    expect(restoDeNombre('Cierre Común 10 cm', 'Cierre Común')).toBe('10 cm');
    expect(restoDeNombre('Cinta Raso Nº 1', 'Cinta Raso')).toBe('Nº 1');
  });

  it('si el nombre no empieza con el prefijo, no inventa nada', () => {
    expect(restoDeNombre('Goma Eva Grande', 'Cierre Común')).toBe('');
  });
});

describe('el nombre base de un producto solo', () => {
  it('recorta la cola de medida', () => {
    expect(nombreBaseDe('Cierre Común 10 cm')).toBe('Cierre Común');
    expect(nombreBaseDe('Abrojo 20 mm')).toBe('Abrojo');
  });

  it('no recorta lo que no es medida, ni deja el nombre vacío', () => {
    expect(nombreBaseDe('Goma Eva Grande')).toBe('Goma Eva Grande');
    expect(nombreBaseDe('750 ml')).toBe('750');
  });
});

describe('la propuesta entera', () => {
  it('con varios productos manda lo que comparten', () => {
    expect(sugerirGrupo(['Cierre Común 10 cm', 'Cierre Común 12 cm'])).toEqual({
      grupo: 'Cierre Común',
      tamanos: ['10 cm', '12 cm'],
    });
  });

  it('con uno solo arranca del nombre sin la medida', () => {
    expect(sugerirGrupo(['Cierre Común 10 cm'])).toEqual({
      grupo: 'Cierre Común',
      tamanos: ['10 cm'],
    });
  });

  it('sin prefijo común cae al nombre base del primero y deja las etiquetas vacías', () => {
    const { grupo, tamanos } = sugerirGrupo(['Goma Eva Grande', 'Cartulina Luma']);
    expect(grupo).toBe('Goma Eva Grande');
    expect(tamanos).toEqual(['', '']);
  });
});
