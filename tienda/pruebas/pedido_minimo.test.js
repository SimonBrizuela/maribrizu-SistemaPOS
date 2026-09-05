// @vitest-environment jsdom
/**
 * El pedido mínimo, visible desde que se arma el carrito.
 *
 * Antes solo aparecía en el checkout: el cliente cargaba productos, elegía cómo
 * lo recibía, escribía la dirección y recién ahí se enteraba de que le faltaban
 * $6.000. Es la forma más cara de perder una venta, porque el cliente ya
 * invirtió cinco minutos.
 *
 * Ahora lo dicen el panel del pedido y la barra de abajo, que es donde todavía
 * está comprando y agregar algo más le cuesta un toque.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { config } = vi.hoisted(() => ({ config: { valor: null } }));

vi.mock('firebase/firestore', async () =>
  (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../src/firebase.js', () => ({ db: {}, app: {} }));

vi.mock('../src/datos.js', async (original) => ({
  ...(await original()),
  configEnCache: () => config.valor,
}));

const carrito = await import('../src/carrito.js');
const panel = await import('../src/panel_carrito.js');
const barra = await import('../src/barra_pedido.js');

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));
const sinPuntos = (t) => String(t).replace(/\./g, '');

const cuaderno = { id: 'p1', nombre: 'Cuaderno Rivadavia', precio: 1000, stock: 50 };

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  carrito.vaciar();
  config.valor = { entrega: { pedido_minimo: 6500 } };
});

describe('el panel del pedido', () => {
  it('dice cuánto falta para el mínimo, con la cuenta hecha', async () => {
    carrito.agregar(cuaderno, { cantidad: 4 });   // $4.000 de $6.500
    panel.abrir();
    await esperar(10);

    const texto = sinPuntos(document.querySelector('aside.panel').textContent);
    expect(texto).toContain('Te faltan');
    expect(texto).toContain('2500');
    expect(texto).toContain('6500');
    panel.cerrar();
  });

  it('cuando ya llega lo dice también: sin eso el cliente no sabe si puede seguir',
    async () => {
      carrito.agregar(cuaderno, { cantidad: 7 });   // $7.000
      panel.abrir();
      await esperar(10);

      const caja = document.querySelector('aside.panel');
      expect(caja.textContent).toContain('Llegaste al pedido mínimo');
      expect(caja.querySelector('.panel__minimo--listo')).not.toBeNull();
      panel.cerrar();
    });

  it('sin mínimo configurado no aparece nada', async () => {
    config.valor = { entrega: { pedido_minimo: 0 } };
    carrito.agregar(cuaderno, { cantidad: 1 });
    panel.abrir();
    await esperar(10);

    expect(document.querySelector('.panel__minimo')).toBeNull();
    expect(document.querySelector('aside.panel').textContent).not.toContain('mínimo');
    panel.cerrar();
  });

  it('la config todavía sin llegar no rompe el panel', async () => {
    config.valor = null;
    carrito.agregar(cuaderno, { cantidad: 1 });
    panel.abrir();
    await esperar(10);

    expect(document.querySelector('aside.panel').textContent).toContain('Cuaderno Rivadavia');
    expect(document.querySelector('.panel__minimo')).toBeNull();
    panel.cerrar();
  });
});

describe('la barra de abajo', () => {
  it('avisa lo que falta mientras se sigue comprando', async () => {
    barra.iniciarBarraPedido();
    carrito.agregar(cuaderno, { cantidad: 4 });
    await esperar(10);

    const nodo = document.querySelector('.barra-pedido');
    expect(sinPuntos(nodo.textContent)).toContain('2500');
    expect(nodo.querySelector('.barra-pedido__minimo')).not.toBeNull();
  });

  it('alcanzado el mínimo el renglón desaparece', async () => {
    barra.iniciarBarraPedido();
    carrito.agregar(cuaderno, { cantidad: 7 });
    await esperar(10);

    expect(document.querySelector('.barra-pedido__minimo')).toBeNull();
  });
});
