/**
 * El service worker de los avisos: lo que muestra el celular con la tienda
 * cerrada, y a dónde lleva tocarlo.
 *
 * Se carga el archivo de verdad (`public/avisos-sw.js`) con un `self` de
 * mentira. Lo que importa: que arme la notificación con lo que mandó el
 * servidor, que el aviso nuevo reemplace al anterior del mismo pedido, que no
 * moleste a quien ya está mirando su pedido, y que tocarla abra ESE pedido.
 *
 * Y lo que no hace: no escucha `fetch`. Un service worker que intercepta la
 * navegación puede dejar a la tienda sirviendo una versión vieja; este solo
 * atiende avisos.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CODIGO = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'avisos-sw.js'), 'utf8');

let oyentes;
let mostradas;
let ventanas;
let abiertas;

function cargarSw() {
  oyentes = {};
  mostradas = [];
  abiertas = [];
  const self = {
    location: { origin: 'https://beta.liceolibreria.com' },
    addEventListener: (tipo, fn) => { oyentes[tipo] = fn; },
    skipWaiting: () => Promise.resolve(),
    registration: { showNotification: async (titulo, opciones) => { mostradas.push({ titulo, opciones }); } },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: async () => ventanas,
      openWindow: async (url) => { abiertas.push(url); return null; },
    },
  };
  new Function('self', CODIGO)(self);
}

/** Dispara un evento y espera lo que el service worker dejó en waitUntil. */
async function disparar(tipo, evento) {
  let promesa = Promise.resolve();
  oyentes[tipo]({ ...evento, waitUntil: (p) => { promesa = p; } });
  await promesa;
}

const push = (data) => ({ data: { json: () => ({ data, from: '477197039887', priority: 'high' }) } });

const DATOS = {
  titulo: 'Tu pedido K7M2 está listo', cuerpo: 'Pasalo a buscar por Av. Alfonsina Storni 168.',
  tag: 'pedido-abc', url: '/pedido/abc', imagen: '/avisos/retiro-listo.png',
};

beforeEach(() => {
  ventanas = [];
  cargarSw();
});

describe('al llegar un aviso', () => {
  it('muestra la notificación con lo que mandó el servidor', async () => {
    await disparar('push', push(DATOS));
    expect(mostradas).toHaveLength(1);
    const { titulo, opciones } = mostradas[0];
    expect(titulo).toBe(DATOS.titulo);
    expect(opciones.body).toBe(DATOS.cuerpo);
    expect(opciones.image).toBe('/avisos/retiro-listo.png');
    expect(opciones.icon).toMatch(/icono-192\.png$/);
    expect(opciones.data.url).toBe('/pedido/abc');
  });

  it('el aviso nuevo del mismo pedido reemplaza al anterior y vuelve a sonar', async () => {
    await disparar('push', push(DATOS));
    expect(mostradas[0].opciones.tag).toBe('pedido-abc');
    expect(mostradas[0].opciones.renotify).toBe(true);
  });

  it('sin imagen no manda una vacía', async () => {
    await disparar('push', push({ ...DATOS, imagen: '' }));
    expect(mostradas[0].opciones.image).toBeUndefined();
  });

  it('también entiende los datos sin envolver', async () => {
    await disparar('push', { data: { json: () => DATOS } });
    expect(mostradas[0].titulo).toBe(DATOS.titulo);
  });

  it('si el cliente ya está mirando ese pedido, no lo interrumpe', async () => {
    ventanas = [{ url: 'https://beta.liceolibreria.com/pedido/abc', focused: true, visibilityState: 'visible' }];
    await disparar('push', push(DATOS));
    expect(mostradas).toHaveLength(0);
  });

  it('un aviso roto no muestra nada ni revienta', async () => {
    await disparar('push', { data: { json: () => { throw new Error('no es json'); } } });
    await disparar('push', push({ cuerpo: 'sin título' }));
    await disparar('push', {});
    expect(mostradas).toHaveLength(0);
  });
});

describe('al tocar la notificación', () => {
  const tocar = (url = '/pedido/abc') => disparar('notificationclick', {
    notification: { data: { url }, close() { this.cerrada = true; } },
  });

  it('abre el pedido', async () => {
    await tocar();
    expect(abiertas).toEqual(['https://beta.liceolibreria.com/pedido/abc']);
  });

  it('si la tienda ya está abierta en ese pedido, la trae al frente', async () => {
    let enfocada = false;
    ventanas = [{ url: 'https://beta.liceolibreria.com/pedido/abc', focus: async () => { enfocada = true; } }];
    await tocar();
    expect(enfocada).toBe(true);
    expect(abiertas).toEqual([]);
  });

  it('si la tienda está abierta en otra página, la lleva al pedido', async () => {
    let fue = null;
    ventanas = [{
      url: 'https://beta.liceolibreria.com/catalogo',
      navigate: async (url) => { fue = url; }, focus: async () => {},
    }];
    await tocar();
    expect(fue).toBe('https://beta.liceolibreria.com/pedido/abc');
  });

  it('no lleva a ninguna página de otro sitio', async () => {
    await tocar('https://otro.com/estafa');
    expect(abiertas).toEqual(['https://beta.liceolibreria.com/']);
  });
});

it('las imágenes que nombra existen en la carpeta pública', () => {
  const publica = path.resolve(import.meta.dirname, '..', 'public');
  for (const ruta of CODIGO.match(/'\/[^']+\.png'/g).map(r => r.slice(1, -1))) {
    expect(fs.existsSync(path.join(publica, ruta)), `falta ${ruta}`).toBe(true);
  }
});

it('no intercepta la navegación de la tienda', () => {
  expect(oyentes.fetch).toBeUndefined();
});
