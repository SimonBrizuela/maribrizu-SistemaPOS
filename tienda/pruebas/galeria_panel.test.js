/**
 * La galería del panel: portada, orden, y la foto de cada variedad.
 *
 * `webapp/src/tienda_galeria.js` no toca Firebase ni el DOM: es lo que decide
 * el editor antes de guardar. Lo que se cuida acá es que ninguna operación deje
 * una variedad apuntando a una foto que ya no existe, ni pierda una foto por
 * reordenar, ni guarde basura en `tienda_variedades`.
 */
import { describe, it, expect } from 'vitest';
import {
  ponerDePortada, moverFoto, quitarFoto, desvincularFoto, vincularFoto,
  fotoDeVariedad, limpiarAjustes, fotosHuerfanas, fotosQuitadas,
} from '../../webapp/src/tienda_galeria.js';

const A = 'https://x/a.webp';
const B = 'https://x/b.webp';
const C = 'https://x/c.webp';
const ROJO = 'https://x/rojo.webp';

describe('portada y orden', () => {
  it('poner de portada mueve esa foto al principio y no pierde ninguna', () => {
    expect(ponerDePortada([A, B, C], 2)).toEqual([C, A, B]);
    expect(ponerDePortada([A, B, C], 1)).toEqual([B, A, C]);
  });

  it('poner de portada la que ya es portada, o un índice inválido, no cambia nada', () => {
    expect(ponerDePortada([A, B, C], 0)).toEqual([A, B, C]);
    expect(ponerDePortada([A, B, C], 7)).toEqual([A, B, C]);
    expect(ponerDePortada([A, B, C], -1)).toEqual([A, B, C]);
    expect(ponerDePortada([A, B, C], NaN)).toEqual([A, B, C]);
  });

  it('mover corre la foto una posición sin tocar las demás', () => {
    expect(moverFoto([A, B, C], 0, 1)).toEqual([B, A, C]);
    expect(moverFoto([A, B, C], 2, 1)).toEqual([A, C, B]);
    expect(moverFoto([A, B, C], 0, 2)).toEqual([B, C, A]);
  });

  it('mover fuera de rango devuelve la lista como estaba', () => {
    expect(moverFoto([A, B], 1, 2)).toEqual([A, B]);
    expect(moverFoto([A, B], -1, 0)).toEqual([A, B]);
    expect(moverFoto([A, B], 1, 1)).toEqual([A, B]);
  });

  it('nunca muta la lista que recibe', () => {
    const original = [A, B, C];
    ponerDePortada(original, 2);
    moverFoto(original, 0, 2);
    quitarFoto(original, {}, A);
    expect(original).toEqual([A, B, C]);
  });

  it('limpia huecos y espacios: una entrada vacía no es una foto', () => {
    expect(ponerDePortada([A, '', null, ` ${B} `], 1)).toEqual([B, A]);
  });
});

describe('quitar una foto de la galería', () => {
  it('la saca de la lista y de las variedades que la usaban', () => {
    const ajustes = {
      rojo: { publicar: true, nombre: null, imagen: A },
      azul: { publicar: true, nombre: 'Azul Francia', imagen: B },
    };
    const r = quitarFoto([A, B, C], ajustes, A);
    expect(r.imagenes).toEqual([B, C]);
    expect(r.desvinculadas).toEqual(['rojo']);
    // El rojo sigue estando, con su nombre y su interruptor: solo perdió la foto.
    expect(r.ajustes.rojo).toEqual({ publicar: true, nombre: null });
    expect(r.ajustes.azul).toEqual({ publicar: true, nombre: 'Azul Francia', imagen: B });
  });

  it('si ninguna variedad la usaba, avisa que no hay nada que reescribir', () => {
    const r = quitarFoto([A, B], { rojo: { imagen: ROJO } }, A);
    expect(r.imagenes).toEqual([B]);
    expect(r.desvinculadas).toEqual([]);
    expect(r.ajustes).toEqual({ rojo: { imagen: ROJO } });
  });

  it('desvincular con una url vacía no toca a nadie', () => {
    const ajustes = { rojo: { imagen: A } };
    expect(desvincularFoto(ajustes, '').desvinculadas).toEqual([]);
    expect(desvincularFoto(ajustes, '').ajustes).toEqual(ajustes);
  });

  it('no muta los ajustes que recibe', () => {
    const ajustes = { rojo: { publicar: true, imagen: A } };
    quitarFoto([A], ajustes, A);
    expect(ajustes.rojo.imagen).toBe(A);
  });
});

describe('la foto de una variedad', () => {
  it('vincular pone la url y respeta lo demás del ajuste', () => {
    const antes = { rojo: { publicar: false, nombre: 'Rojo Fuego' } };
    const despues = vincularFoto(antes, 'rojo', ROJO);
    expect(despues.rojo).toEqual({ publicar: false, nombre: 'Rojo Fuego', imagen: ROJO });
    expect(fotoDeVariedad(despues, 'rojo')).toBe(ROJO);
    // El mapa original queda como estaba.
    expect(antes.rojo.imagen).toBeUndefined();
  });

  it('vincular a una variedad que no tenía ajuste lo crea', () => {
    expect(vincularFoto({}, 'verde', ROJO)).toEqual({ verde: { imagen: ROJO } });
  });

  it('vincular null (o espacios) la saca', () => {
    const con = { rojo: { publicar: true, imagen: ROJO } };
    expect(vincularFoto(con, 'rojo', null).rojo).toEqual({ publicar: true });
    expect(vincularFoto(con, 'rojo', '   ').rojo).toEqual({ publicar: true });
    expect(fotoDeVariedad(vincularFoto(con, 'rojo', null), 'rojo')).toBeNull();
  });

  it('sin ajuste, sin foto', () => {
    expect(fotoDeVariedad({}, 'rojo')).toBeNull();
    expect(fotoDeVariedad(null, 'rojo')).toBeNull();
    expect(fotoDeVariedad({ rojo: { imagen: '  ' } }, 'rojo')).toBeNull();
  });
});

describe('lo que se guarda en tienda_variedades', () => {
  it('una variedad sin nada que decir no se guarda', () => {
    expect(limpiarAjustes({ rojo: { publicar: true, nombre: '' } })).toBeUndefined();
    expect(limpiarAjustes({})).toBeUndefined();
    expect(limpiarAjustes(null)).toBeUndefined();
  });

  it('con foto se guarda aunque no tenga nombre ni esté apagada', () => {
    expect(limpiarAjustes({ rojo: { imagen: ROJO } }))
      .toEqual({ rojo: { publicar: true, nombre: null, imagen: ROJO } });
  });

  it('la forma es siempre la misma: publicar, nombre, y la imagen solo si hay', () => {
    expect(limpiarAjustes({
      rojo: { publicar: false, nombre: '  ', imagen: '' },
      azul: { nombre: ' Azul Francia ' },
      verde: {},
    })).toEqual({
      rojo: { publicar: false, nombre: null },
      azul: { publicar: true, nombre: 'Azul Francia' },
    });
  });

  it('es lo que el espejo entiende: la variedad sale con su foto', async () => {
    const { documentoEspejo } = await import('../../webapp/src/tienda_espejo.js');
    const datos = {
      nombre: 'LAPIZ', estado: 'activo', precio_venta: 100, es_conjunto: true,
      conjunto_tipo: 'caja', conjunto_contenido: 12, conjunto_precio_unidad: 10,
      conjunto_colores: [{ color: 'ROJO', unidades: 1, restante: 0 },
                         { color: 'AZUL', unidades: 1, restante: 0 }],
      tienda_imagenes: [A, B],
      tienda_variedades: limpiarAjustes(vincularFoto({}, 'rojo', ROJO)),
    };
    const d = documentoEspejo(datos);
    expect(d.imagenes).toEqual([A, B]);
    expect(d.variedades.map(v => [v.nombre, v.imagen]))
      .toEqual([['Rojo', ROJO], ['Azul', null]]);
  });
});

describe('qué se borra al guardar la galería desde Fotos Pedidas', () => {
  it('lo que estaba y ya no está; lo nuevo sin subir no cuenta', () => {
    // El panel mezcla urls guardadas con claves locales de lo recién elegido.
    expect(fotosQuitadas([A, B, C], ['nueva:0', A, C])).toEqual([B]);
    expect(fotosQuitadas([A, B], [B, A])).toEqual([]);
    expect(fotosQuitadas([], ['nueva:0'])).toEqual([]);
    expect(fotosQuitadas([A, A, B], [])).toEqual([A, B]);
  });
});

describe('fotos huérfanas al cancelar', () => {
  it('lo subido en la sesión que ni la galería ni una variedad usan, se puede borrar', () => {
    const subidas = [ROJO, C, C];
    expect(fotosHuerfanas(subidas, [A, B], { rojo: { imagen: ROJO } })).toEqual([C]);
  });

  it('si todo quedó en uso, no hay nada que borrar', () => {
    expect(fotosHuerfanas([ROJO], [A], { rojo: { imagen: ROJO } })).toEqual([]);
    expect(fotosHuerfanas([], [A], {})).toEqual([]);
  });
});
