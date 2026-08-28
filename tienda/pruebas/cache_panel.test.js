/**
 * El cache del panel.
 *
 * Dos capas: memoria y localStorage con vencimiento. De acá sale si una
 * pantalla pinta al instante o se queda con el spinner, y —lo que importa
 * más— si muestra un dato viejo creyéndolo fresco.
 *
 * El bug que motivó que cada entrada guarde SU propio vencimiento: `peekCache`
 * asumía el de 5 minutos por defecto y a veces contestaba "está fresco" cuando
 * `getCached` iba a re-consultar igual, dejando la pantalla congelada sin
 * spinner durante toda la consulta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase/firestore', async () => (await import('./firestore_falso.js')).firestoreFalso());

const {
  getCached, peekCache, peekCacheValue, setCacheValue, invalidateCache,
  invalidateCacheByPrefix, pinCacheKey, unpinCacheKey,
  hydrateCacheValue, isHydrated,
} = await import('../../webapp/src/cache.js');

beforeEach(() => {
  localStorage.clear();
  invalidateCacheByPrefix('');   // limpia memoria y disco
});

describe('traer un dato', () => {
  it('la primera vez consulta, la segunda no', async () => {
    const consultar = vi.fn(async () => ['uno']);
    expect(await getCached('k1', consultar)).toEqual(['uno']);
    expect(await getCached('k1', consultar)).toEqual(['uno']);
    expect(consultar).toHaveBeenCalledTimes(1);
  });

  it('vencido, vuelve a consultar', async () => {
    const consultar = vi.fn(async () => 'fresco');
    await getCached('k1', consultar, { ttl: -1 });   // nace vencido
    await getCached('k1', consultar, { ttl: -1 });
    expect(consultar).toHaveBeenCalledTimes(2);
  });

  it('dos pedidos a la vez consultan una sola vez', async () => {
    // Sin esto, abrir una pantalla que pide lo mismo dos veces dispara dos
    // descargas iguales contra Firestore.
    let llamadas = 0;
    const consultar = async () => {
      llamadas++;
      await new Promise(r => setTimeout(r, 10));
      return llamadas;
    };
    const [a, b] = await Promise.all([getCached('k1', consultar), getCached('k1', consultar)]);
    expect(llamadas).toBe(1);
    expect(a).toBe(b);
  });

  it('si la consulta falla, el error llega a quien la pidió', async () => {
    await expect(getCached('k1', async () => { throw new Error('sin red'); }))
      .rejects.toThrow('sin red');
    // Y no queda un fetch colgado que trabe el siguiente intento.
    expect(await getCached('k1', async () => 'ok')).toBe('ok');
  });
});

describe('mirar sin traer', () => {
  // `peekCache` devuelve un booleano pelado. Hoy no lo llama nadie en el
  // panel (quedó como ayudante público) pero la regla que implementa sí
  // importa y es la que se prueba acá.
  it('dice si hay algo fresco, sin consultar', async () => {
    await getCached('k1', async () => 'x', { ttl: 60000 });
    expect(peekCache('k1')).toBe(true);
    expect(peekCacheValue('k1')).toBe('x');
  });

  it('cada entrada recuerda SU vencimiento', async () => {
    // Es el bug viejo: guardada con 1 ms de vida, no puede decirse fresca
    // sólo porque el default son 5 minutos.
    await getCached('corta', async () => 'x', { ttl: 1 });
    await new Promise(r => setTimeout(r, 20));
    expect(peekCache('corta')).toBe(false);
  });

  it('lo que no está, no está', () => {
    expect(peekCache('nada')).toBe(false);
    expect(peekCacheValue('nada')).toBeUndefined();
  });
});

describe('invalidar', () => {
  it('una key', async () => {
    const consultar = vi.fn(async () => 'x');
    await getCached('k1', consultar);
    invalidateCache('k1');
    await getCached('k1', consultar);
    expect(consultar).toHaveBeenCalledTimes(2);
  });

  it('todo un grupo por su prefijo', async () => {
    // Es lo que hace el botón de refrescar de cada pantalla.
    await getCached('cierres:caja', async () => 'a');
    await getCached('cierres:otro', async () => 'b');
    await getCached('ventas:lista', async () => 'c');
    invalidateCacheByPrefix('cierres');
    expect(peekCacheValue('cierres:caja')).toBeUndefined();
    expect(peekCacheValue('cierres:otro')).toBeUndefined();
    expect(peekCacheValue('ventas:lista')).toBe('c');
  });
});

describe('las keys que mantiene el store en vivo', () => {
  it('con la key pinneada no se consulta: se devuelve lo que trajo el listener', async () => {
    pinCacheKey('vivo');
    setCacheValue('vivo', ['del listener']);
    const consultar = vi.fn(async () => ['de la consulta']);
    expect(await getCached('vivo', consultar)).toEqual(['del listener']);
    expect(consultar).not.toHaveBeenCalled();
    unpinCacheKey('vivo');
  });

  it('si el listener llega después, el que esperaba lo recibe igual', async () => {
    pinCacheKey('vivo');
    const pedido = getCached('vivo', async () => 'no deberia usarse');
    setTimeout(() => setCacheValue('vivo', 'llego el snapshot'), 10);
    expect(await pedido).toBe('llego el snapshot');
    unpinCacheKey('vivo');
  });

  it('despinnear la devuelve al comportamiento normal', async () => {
    pinCacheKey('vivo');
    unpinCacheKey('vivo');
    expect(await getCached('vivo', async () => 'consultado')).toBe('consultado');
  });
});

describe('los datos de la sesión anterior', () => {
  it('se marcan como hidratados hasta que llegue el snapshot real', () => {
    // Pintan al instante al abrir, y el primer snapshot del listener los pisa.
    // Sólo se hidratan keys del store: una key suelta no se toca.
    pinCacheKey('catalogo:all');
    expect(hydrateCacheValue('catalogo:all', [{ nombre: 'CUADERNO' }])).toBe(true);
    expect(isHydrated('catalogo:all')).toBe(true);
    expect(peekCacheValue('catalogo:all')).toEqual([{ nombre: 'CUADERNO' }]);

    setCacheValue('catalogo:all', [{ nombre: 'CUADERNO' }, { nombre: 'BIROME' }]);
    expect(isHydrated('catalogo:all')).toBe(false);
    expect(peekCacheValue('catalogo:all').length).toBe(2);
    unpinCacheKey('catalogo:all');
  });

  it('no se hidrata una key que no mantiene el store', () => {
    expect(hydrateCacheValue('suelta', ['x'])).toBe(false);
    expect(peekCacheValue('suelta')).toBeUndefined();
  });

  it('el listener que llegó primero no se pisa con lo viejo', () => {
    pinCacheKey('catalogo:all');
    setCacheValue('catalogo:all', ['lo fresco']);
    expect(hydrateCacheValue('catalogo:all', ['lo viejo'])).toBe(false);
    expect(peekCacheValue('catalogo:all')).toEqual(['lo fresco']);
    unpinCacheKey('catalogo:all');
  });
});

describe('el disco', () => {
  it('lo guardado sobrevive a la recarga', async () => {
    await getCached('k1', async () => ({ n: 1 }), { ttl: 60000 });
    // Simula el F5: se pierde la memoria, queda localStorage.
    const guardado = localStorage.getItem('pos_c_k1');
    expect(guardado).toBeTruthy();
    expect(JSON.parse(guardado).data).toEqual({ n: 1 });
  });

  it('lo marcado como memOnly no toca el disco', async () => {
    // Para datasets grandes: llenarían la cuota de localStorage.
    await getCached('grande', async () => [1, 2, 3], { memOnly: true });
    expect(localStorage.getItem('pos_c_grande')).toBeNull();
    expect(peekCacheValue('grande')).toEqual([1, 2, 3]);
  });
});
