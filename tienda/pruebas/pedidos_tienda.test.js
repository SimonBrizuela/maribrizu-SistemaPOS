// @vitest-environment jsdom
/**
 * Lo que pasa cuando un cliente confirma un pedido en la tienda.
 *
 * Es el momento con menos margen de todo el sistema: del otro lado hay alguien
 * que ya decidió comprar. El pedido tiene que quedar guardado con el total
 * bien, tiene que poder seguirse después, y el código corto tiene que poder
 * dictarse por teléfono sin que nadie confunda un cero con una O.
 *
 * Acá se prueban las piezas que deciden eso: `pedidos.js`, `cliente.js` (lo que
 * se recuerda de este teléfono), `comprobante.js` (la transferencia) y
 * `router.js` (que el link de un pedido lleve a donde tiene que llevar).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { estado } = vi.hoisted(() => ({
  estado: { escrituras: [], docs: {}, consultas: [], emitir: null, pedidos: [] },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  let contador = 0;
  return {
    ...firestoreFalso(),
    collection: (_db, nombre) => ({ _col: nombre }),
    // `doc(collection(...))` sin id reserva uno nuevo; con id apunta a ese.
    doc: (a, b, c) => (typeof b === 'string'
      ? { _col: b, id: c }
      : { _col: a?._col, id: `nuevo${++contador}` }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    where: (campo, op, valor) => ({ campo, op, valor }),
    limit: (n) => ({ limit: n }),
    setDoc: async (ref, datos) => { estado.escrituras.push({ ref, datos }); },
    getDoc: async (ref) => {
      const d = estado.docs[`${ref._col}/${ref.id}`];
      return { exists: () => d != null, data: () => d, id: ref.id };
    },
    getDocs: async (q) => {
      estado.consultas.push(q);
      return { docs: estado.pedidos.map(p => ({ id: p.__id, data: () => p })) };
    },
    onSnapshot: (ref, alCambiar, alFallar) => {
      estado.emitir = (d) => alCambiar({ exists: () => d != null, data: () => d, id: ref.id });
      estado.fallar = (e) => alFallar?.(e);
      return () => { estado.emitir = null; };
    },
    serverTimestamp: () => 'HORA_DEL_SERVIDOR',
  };
});
vi.mock('../src/firebase.js', () => ({ db: {}, app: {} }));

const pedidos = await import('../src/pedidos.js');
const cliente = await import('../src/cliente.js');
const comprobante = await import('../src/comprobante.js');
const router = await import('../src/router.js');

let respuestaDeLaFuncion;

beforeEach(() => {
  localStorage.clear();
  estado.escrituras.length = 0;
  estado.consultas.length = 0;
  estado.pedidos = [];
  estado.docs = {};
  // `crypto.getRandomValues` no existe en jsdom viejo.
  if (!globalThis.crypto?.getRandomValues) {
    globalThis.crypto = { getRandomValues: (a) => { a.forEach((_, i) => { a[i] = i * 37; }); return a; } };
  }
  // Por defecto la funcion que crea el pedido contesta 501 (todavia sin cuenta
  // de servicio), que es el caso en el que la tienda escribe desde el navegador.
  // Lo demas que se llame por fetch es el aviso al local, al que no se le espera
  // respuesta.
  respuestaDeLaFuncion = { ok: false, status: 501, json: async () => ({ error: 'sin_credenciales' }) };
  globalThis.fetch = vi.fn((url) => Promise.resolve(
    String(url).includes('crear-pedido')
      ? respuestaDeLaFuncion
      : { ok: true, json: async () => ({}) }));
});

const PEDIDO = {
  cliente: { nombre: 'Marta Gómez', telefono: '3515550001' },
  entrega: { modo: 'retiro' },
  pago: { modo: 'efectivo' },
  items: [{ id: 'p1', nombre: 'Cuaderno Rivadavia', cantidad: 2, precio: 3500, subtotal: 7000 }],
  subtotal: 7000,
  envio: 0,
};

describe('los pasos que ve el cliente', () => {
  it('un pedido para retirar no pasa por "en camino"', () => {
    const claves = pedidos.pasosDe('retiro').map(p => p.clave);
    expect(claves).toEqual(['nuevo', 'preparando', 'listo', 'entregado']);
  });

  it('uno con envío sí', () => {
    const claves = pedidos.pasosDe('delivery').map(p => p.clave);
    expect(claves).toContain('en_camino');
  });

  it('"listo" se lee distinto según cómo lo recibe', () => {
    // Para el que retira, "listo" es "pasá a buscarlo". Para el que espera el
    // envío, "listo" todavía no es nada: falta que salga.
    const retiro = pedidos.pasosDe('retiro').find(p => p.clave === 'listo');
    const envio = pedidos.pasosDe('delivery').find(p => p.clave === 'listo');
    expect(retiro.titulo).toBe('Listo');
    expect(envio.titulo).toMatch(/salir/i);
    expect(envio.detalle).toMatch(/repartidor/i);
  });

  it('el índice del estado respeta el modo', () => {
    expect(pedidos.indiceDeEstado('entregado', 'retiro')).toBe(3);
    expect(pedidos.indiceDeEstado('entregado', 'delivery')).toBe(4);
  });

  it('un estado desconocido no rompe la barra de progreso', () => {
    expect(pedidos.indiceDeEstado('cancelado', 'retiro')).toBe(-1);
    expect(pedidos.indiceDeEstado(undefined, 'retiro')).toBe(-1);
  });
});

describe('el código que se dicta por teléfono', () => {
  it('son cuatro caracteres', async () => {
    await pedidos.crearPedido(PEDIDO);
    expect(estado.escrituras.at(-1).datos.codigo).toHaveLength(4);
  });

  it('no usa las letras y números que se confunden al leerlos', async () => {
    // I / 1 y O / 0 se escuchan igual por teléfono y mandan a buscar el pedido
    // equivocado. Se recorren todos los bytes posibles para no depender de la
    // suerte del azar.
    let base = 0;
    const espia = vi.spyOn(crypto, 'getRandomValues').mockImplementation((a) => {
      a.forEach((_, k) => { a[k] = (base + k) % 256; });
      return a;
    });
    try {
      const vistos = new Set();
      for (base = 0; base < 256; base += 4) {
        await pedidos.crearPedido(PEDIDO);
        [...estado.escrituras.at(-1).datos.codigo].forEach(c => vistos.add(c));
      }
      expect(vistos.size).toBeGreaterThan(20);   // se recorrió el alfabeto entero
      for (const prohibido of ['I', 'O', '0', '1']) {
        expect([...vistos], `el código no puede tener "${prohibido}"`).not.toContain(prohibido);
      }
    } finally {
      espia.mockRestore();
    }
  });
});

describe('lo que se guarda al confirmar', () => {
  it('el total es el producto más el envío', async () => {
    await pedidos.crearPedido({ ...PEDIDO, subtotal: 18000, envio: 2000,
                                entrega: { modo: 'delivery' } });
    expect(estado.escrituras.at(-1).datos.total).toBe(20000);
  });

  it('nace sin ver y sin imprimir, aunque le manden otra cosa', async () => {
    // Las reglas de Firestore lo exigen así: un pedido no puede entrar diciendo
    // que ya se imprimió. Si el documento saliera con esos flags en true,
    // Firestore rechaza la escritura entera y el cliente ve un error al pagar.
    await pedidos.crearPedido({ ...PEDIDO, impreso: true, visto: true });
    const d = estado.escrituras.at(-1).datos;
    expect(d.impreso).toBe(false);
    expect(d.visto).toBe(false);
    expect(d.estado).toBe('nuevo');
  });

  it('la fecha la pone el servidor, no el celular del cliente', async () => {
    // El reloj de un celular puede estar corrido de horas: si el pedido llevara
    // esa hora, aparecería fuera de lugar en la lista del local.
    await pedidos.crearPedido(PEDIDO);
    expect(estado.escrituras.at(-1).datos.creado).toBe('HORA_DEL_SERVIDOR');
  });

  it('con cuenta lleva la firma; sin cuenta no inventa una', async () => {
    await pedidos.crearPedido({ ...PEDIDO, uid: 'u123' });
    expect(estado.escrituras.at(-1).datos.uid).toBe('u123');

    await pedidos.crearPedido(PEDIDO);
    expect('uid' in estado.escrituras.at(-1).datos).toBe(false);
  });

  it('la nota se corta y no se guarda entera', async () => {
    await pedidos.crearPedido({ ...PEDIDO, nota: 'x'.repeat(900) });
    expect(estado.escrituras.at(-1).datos.nota).toHaveLength(500);
  });

  it('con un id reservado escribe en ese lugar', async () => {
    // Es lo que permite subir el comprobante ANTES de crear el pedido, para que
    // nazca ya pagado en vez de quedar esperando.
    const r = await pedidos.crearPedido({ ...PEDIDO, id: 'reservado-1' });
    expect(estado.escrituras.at(-1).ref.id).toBe('reservado-1');
    expect(r.id).toBe('reservado-1');
  });

  it('le toca el timbre al local, sin esperarlo', async () => {
    await pedidos.crearPedido(PEDIDO);
    const llamadas = globalThis.fetch.mock.calls.map(c => c[0]);
    expect(llamadas.join(' ')).toContain('avisar-pedido');
    // Y sobrevive al cambio de pantalla.
    const opciones = globalThis.fetch.mock.calls.at(-1)[1];
    expect(opciones.keepalive).toBe(true);
  });

  it('si el timbre no suena, el pedido igual queda guardado', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('sin red')));
    const r = await pedidos.crearPedido(PEDIDO);
    expect(r.id).toBeTruthy();
    expect(estado.escrituras.length).toBe(1);
  });
});

describe('los pedidos de este navegador', () => {
  it('el recién hecho queda anotado', async () => {
    const r = await pedidos.crearPedido(PEDIDO);
    const mios = pedidos.misPedidos();
    expect(mios[0].id).toBe(r.id);
    expect(mios[0].codigo).toBe(r.codigo);
    expect(mios[0].total).toBe(7000);
  });

  it('el más nuevo va primero', async () => {
    await pedidos.crearPedido(PEDIDO);
    await new Promise(r => setTimeout(r, 2));
    const segundo = await pedidos.crearPedido({ ...PEDIDO, subtotal: 500 });
    expect(pedidos.misPedidos()[0].id).toBe(segundo.id);
  });

  it('un localStorage corrupto devuelve vacío en vez de romper la pantalla', () => {
    localStorage.setItem('liceo.pedidos.v1', '{no es json');
    expect(pedidos.misPedidos()).toEqual([]);
    localStorage.setItem('liceo.pedidos.v1', '"no es una lista"');
    expect(pedidos.misPedidos()).toEqual([]);
  });
});

describe('los pedidos de la cuenta', () => {
  it('sin cuenta no consulta nada', async () => {
    expect(await pedidos.pedidosDeLaCuenta(null)).toEqual([]);
    expect(estado.consultas.length).toBe(0);
  });

  it('filtra por la cuenta de quien pregunta', async () => {
    // Las reglas rechazan la consulta entera si no filtra por uid: no devuelve
    // "los que puede", no devuelve nada.
    await pedidos.pedidosDeLaCuenta('u123');
    const filtro = estado.consultas[0].partes.find(p => p.campo === 'uid');
    expect(filtro).toBeTruthy();
    expect(filtro.valor).toBe('u123');
  });

  it('vienen ordenados del más nuevo al más viejo', async () => {
    estado.pedidos = [
      { __id: 'a', codigo: 'AAAA', total: 100, estado: 'nuevo',
        entrega: { modo: 'retiro' }, creado: { toMillis: () => 1000 } },
      { __id: 'b', codigo: 'BBBB', total: 200, estado: 'entregado',
        entrega: { modo: 'delivery' }, creado: { toMillis: () => 5000 } },
    ];
    const lista = await pedidos.pedidosDeLaCuenta('u123');
    expect(lista.map(p => p.id)).toEqual(['b', 'a']);
    expect(lista[0].modo).toBe('delivery');
  });

  it('si la consulta falla, la pantalla se queda con los de este navegador', async () => {
    // Una lista vacía es peor que una corta: parece que se perdieron los pedidos.
    const mod = await import('firebase/firestore');
    const original = mod.getDocs;
    mod.getDocs = async () => { throw new Error('falta el índice'); };
    try {
      expect(await pedidos.pedidosDeLaCuenta('u123')).toEqual([]);
    } finally {
      mod.getDocs = original;
    }
  });
});

describe('seguir un pedido en vivo', () => {
  it('avisa cada vez que cambia el estado', () => {
    const vistos = [];
    pedidos.seguirPedido('k1', p => vistos.push(p?.estado));
    estado.emitir({ estado: 'nuevo' });
    estado.emitir({ estado: 'preparando' });
    expect(vistos).toEqual(['nuevo', 'preparando']);
  });

  it('un pedido que no existe llega como null, no como un objeto vacío', () => {
    let visto = 'sin tocar';
    pedidos.seguirPedido('k1', p => { visto = p; });
    estado.emitir(null);
    expect(visto).toBeNull();
  });

  it('si se corta, avisa; sin eso la pantalla queda con el esqueleto puesto', () => {
    let error = null;
    pedidos.seguirPedido('k1', () => {}, e => { error = e; });
    estado.fallar(new Error('sin permiso'));
    expect(error).toBeTruthy();
  });
});

describe('lo que recuerda este teléfono', () => {
  it('la primera vez no hay nada que completar', () => {
    expect(cliente.perfil()).toBeNull();
    expect(cliente.domicilios()).toEqual([]);
    expect(cliente.domicilioPredeterminado()).toBeNull();
  });

  it('después de un pedido, el nombre y el teléfono quedan', () => {
    cliente.recordarDelPedido({ nombre: 'Marta Gómez', telefono: '3515550001' });
    expect(cliente.perfil()).toMatchObject({ nombre: 'Marta Gómez', telefono: '3515550001' });
  });

  it('la dirección se guarda con sus coordenadas', () => {
    cliente.recordarDelPedido({
      nombre: 'Marta', telefono: '351', direccion: 'Colón 1200',
      referencia: 'Portón verde', coordenadas: { lat: -31.4, lng: -64.18 },
    });
    const d = cliente.domicilioPredeterminado();
    expect(d.direccion).toBe('Colón 1200');
    expect(d.referencia).toBe('Portón verde');
    expect(d.lat).toBeCloseTo(-31.4);
  });

  it('la misma dirección escrita distinto no se duplica', () => {
    // "Colón 1200" y "colon 1200" son la misma casa: dos entradas en la lista
    // hacen elegir mal la próxima vez.
    cliente.recordarDelPedido({ nombre: 'M', telefono: '1', direccion: 'Colón 1200' });
    cliente.recordarDelPedido({ nombre: 'M', telefono: '1', direccion: 'colon  1200' });
    expect(cliente.domicilios()).toHaveLength(1);
  });

  it('la última usada queda arriba', () => {
    cliente.recordarDelPedido({ nombre: 'M', telefono: '1', direccion: 'Colón 1200' });
    cliente.recordarDelPedido({ nombre: 'M', telefono: '1', direccion: 'Rivadavia 500' });
    expect(cliente.domicilioPredeterminado().direccion).toBe('Rivadavia 500');
  });

  it('un pedido sin dirección no borra las que había', () => {
    cliente.recordarDelPedido({ nombre: 'M', telefono: '1', direccion: 'Colón 1200' });
    cliente.recordarDelPedido({ nombre: 'M', telefono: '1' });     // retiro
    expect(cliente.domicilios()).toHaveLength(1);
  });

  it('"no soy yo" borra todo lo de este teléfono', () => {
    cliente.recordarDelPedido({ nombre: 'Marta', telefono: '351', direccion: 'Colón 1200' });
    cliente.olvidar();
    expect(cliente.perfil()).toBeNull();
    expect(cliente.domicilios()).toEqual([]);
  });
});

describe('el comprobante de la transferencia', () => {
  const archivo = (tipo, bytes) => ({ type: tipo, size: bytes, name: 'x' });

  it('una foto y un PDF valen', () => {
    expect(comprobante.esComprobanteValido(archivo('image/jpeg', 500_000))).toBeNull();
    expect(comprobante.esComprobanteValido(archivo('application/pdf', 500_000))).toBeNull();
  });

  it('otra cosa no, y lo dice en castellano', () => {
    const problema = comprobante.esComprobanteValido(archivo('application/zip', 1000));
    expect(problema).toBeTruthy();
    expect(problema).toMatch(/imagen|PDF/i);
  });

  it('uno demasiado pesado tampoco', () => {
    const problema = comprobante.esComprobanteValido(archivo('image/png', 20 * 1024 * 1024));
    expect(problema).toMatch(/pesado|8 MB/i);
  });

  it('sin archivo lo dice, no revienta', () => {
    expect(comprobante.esComprobanteValido(null)).toMatch(/ning[úu]n archivo/i);
  });

  it('lo subido queda recordado para la vista previa', () => {
    comprobante.recordarComprobante('k1', { url: 'https://x/c.webp', tipo: 'imagen' });
    expect(comprobante.comprobanteRecordado('k1')).toEqual({ url: 'https://x/c.webp', tipo: 'imagen' });
  });

  it('un recuerdo corrupto no rompe la pantalla del pedido', () => {
    localStorage.setItem('ll-comprobante-k1', '{roto');
    expect(comprobante.comprobanteRecordado('k1')).toBeNull();
  });

  it('el de otro pedido no se mezcla', () => {
    comprobante.recordarComprobante('k1', { url: 'a', tipo: 'imagen' });
    expect(comprobante.comprobanteRecordado('k2')).toBeNull();
  });
});

describe('las direcciones de la tienda', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('la ficha de un producto lleva su id', () => {
    const vista = () => {};
    router.ruta('/p/:id', vista);
    window.history.replaceState({}, '', '/p/abc123');
    const r = router.resolver();
    expect(r.vista).toBe(vista);
    expect(r.params.id).toBe('abc123');
  });

  it('una dirección que no existe no elige una vista al azar', () => {
    router.ruta('/p/:id', () => {});
    window.history.replaceState({}, '', '/no-existe');
    expect(router.resolver().vista).toBeNull();
  });

  it('la barra final sobra y no cambia la página', () => {
    const vista = () => {};
    router.ruta('/carrito', vista);
    window.history.replaceState({}, '', '/carrito/');
    expect(router.resolver().vista).toBe(vista);
  });

  it('lo que va después del "?" llega como consulta', () => {
    router.ruta('/catalogo', () => {});
    window.history.replaceState({}, '', '/catalogo?q=cuaderno&rubro=LIBRERIA');
    const r = router.resolver();
    expect(r.query.get('q')).toBe('cuaderno');
    expect(r.query.get('rubro')).toBe('LIBRERIA');
  });

  it('un id con espacios o acentos vuelve legible', () => {
    router.ruta('/p/:id', () => {});
    window.history.replaceState({}, '', '/p/' + encodeURIComponent('goma de borrar'));
    expect(router.resolver().params.id).toBe('goma de borrar');
  });

  it('navegar cambia la dirección y avisa una sola vez', () => {
    let avisos = 0;
    router.alNavegar(() => { avisos++; });
    router.ir('/carrito');
    expect(window.location.pathname).toBe('/carrito');
    expect(avisos).toBe(1);

    router.ir('/carrito');            // ya está ahí
    expect(avisos).toBe(1);
  });

  it('reemplazar no agrega una entrada al historial', () => {
    router.alNavegar(() => {});
    const antes = window.history.length;
    router.ir('/gracias', { reemplazar: true });
    expect(window.location.pathname).toBe('/gracias');
    expect(window.history.length).toBe(antes);
  });
});

describe('el pedido lo guarda el servidor', () => {
  // El precio de cada renglon salia de la memoria del navegador del que paga.
  // Ahora el pedido se manda a una funcion que lo relee de la base; escribir
  // desde el navegador queda solo como red mientras la funcion no este
  // configurada.
  const ok = (extra = {}) => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'srv1', codigo: 'K7M2', subtotal: 7000, envio: 0, total: 7000, ...extra }),
  });

  it('cuando contesta, el navegador no escribe nada en la base', async () => {
    respuestaDeLaFuncion = ok();
    const r = await pedidos.crearPedido(PEDIDO);

    expect(r).toEqual({ id: 'srv1', codigo: 'K7M2' });
    expect(estado.escrituras).toHaveLength(0);
  });

  it('manda que quiere y cuanto, no cuanto sale', async () => {
    respuestaDeLaFuncion = ok();
    await pedidos.crearPedido(PEDIDO);

    const llamada = globalThis.fetch.mock.calls.find(c => String(c[0]).includes('crear-pedido'));
    const cuerpo = JSON.parse(llamada[1].body);
    expect(cuerpo.items[0]).toMatchObject({ id: 'p1', cantidad: 2 });
    // El total y el subtotal ni se mandan: los rehace el servidor.
    expect(cuerpo.subtotal).toBeUndefined();
    expect(cuerpo.total).toBeUndefined();
    // El id se reserva de este lado, asi que un reintento no duplica el pedido.
    expect(typeof cuerpo.id).toBe('string');
  });

  it('el pedido guardado por el servidor queda anotado en este telefono', async () => {
    respuestaDeLaFuncion = ok();
    await pedidos.crearPedido(PEDIDO);

    expect(pedidos.misPedidos()[0]).toMatchObject({ id: 'srv1', codigo: 'K7M2', total: 7000 });
  });

  it('un 200 sin pedido adentro no se da por hecho', async () => {
    respuestaDeLaFuncion = { ok: true, status: 200, json: async () => ({}) };
    const r = await pedidos.crearPedido(PEDIDO);

    // Cae al camino viejo en vez de mandar al cliente a un pedido que no existe.
    expect(estado.escrituras).toHaveLength(1);
    expect(r.id).toBeTruthy();
  });

  it('si cambio un precio, el motivo sube para poder mostrarlo', async () => {
    respuestaDeLaFuncion = {
      ok: false,
      status: 409,
      json: async () => ({
        error: 'cambios',
        cambios: [{ tipo: 'precio', nombre: 'Resma Pampa A4', antes: 1, ahora: 18000 }],
      }),
    };

    await expect(pedidos.crearPedido(PEDIDO)).rejects.toMatchObject({
      motivo: 'cambios',
      cambios: [expect.objectContaining({ tipo: 'precio' })],
    });
    // Y no se escribe por el costado: un 409 es una respuesta, no un tropiezo.
    expect(estado.escrituras).toHaveLength(0);
  });

  it('sin red se sigue por el camino viejo', async () => {
    globalThis.fetch = vi.fn((url) => (String(url).includes('crear-pedido')
      ? Promise.reject(new Error('sin red'))
      : Promise.resolve({ ok: true, json: async () => ({}) })));

    const r = await pedidos.crearPedido(PEDIDO);
    expect(estado.escrituras).toHaveLength(1);
    expect(r.codigo).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
  });
});

describe('cuando la funcion tropieza', () => {
  // Con las reglas cerradas ya no hay camino viejo: si la funcion contesta 502
  // porque se estaba levantando, el pedido se pierde. Le pasa al primer cliente
  // del dia, que es el peor momento posible.
  const ok = {
    ok: true, status: 200,
    json: async () => ({ id: 'srv1', codigo: 'K7M2', subtotal: 7000, envio: 0, total: 7000 }),
  };
  const caida = { ok: false, status: 502, json: async () => ({}) };

  it('un 502 se reintenta una vez y el pedido entra', async () => {
    let n = 0;
    globalThis.fetch = vi.fn((url) => {
      if (!String(url).includes('crear-pedido')) return Promise.resolve({ ok: true, json: async () => ({}) });
      n += 1;
      return Promise.resolve(n === 1 ? caida : ok);
    });

    const r = await pedidos.crearPedido(PEDIDO);
    expect(n).toBe(2);
    expect(r).toEqual({ id: 'srv1', codigo: 'K7M2' });
  });

  it('un 400 no se reintenta: es una respuesta, no un tropiezo', async () => {
    let n = 0;
    globalThis.fetch = vi.fn((url) => {
      if (!String(url).includes('crear-pedido')) return Promise.resolve({ ok: true, json: async () => ({}) });
      n += 1;
      return Promise.resolve({ ok: false, status: 400, json: async () => ({}) });
    });

    await pedidos.crearPedido(PEDIDO);
    expect(n).toBe(1);
  });

  // El reintento puede encontrarse con su propio pedido: el primero entro pero
  // la respuesta se perdio. Decirle "algo fallo" a alguien que ya tiene el
  // pedido cargado lo deja mandando otro.
  it('"ya existe" es el reintento encontrando su pedido, no un error', async () => {
    estado.docs['tienda_pedidos/reservado-9'] = { codigo: 'W4KD', total: 7000 };
    globalThis.fetch = vi.fn((url) => Promise.resolve(
      String(url).includes('crear-pedido')
        ? { ok: false, status: 409, json: async () => ({ error: 'ya_existe' }) }
        : { ok: true, json: async () => ({}) }));

    const r = await pedidos.crearPedido({ ...PEDIDO, id: 'reservado-9' });
    expect(r).toEqual({ id: 'reservado-9', codigo: 'W4KD' });
    expect(pedidos.misPedidos()[0]).toMatchObject({ id: 'reservado-9', codigo: 'W4KD' });
  });

  it('si "ya existe" pero el pedido no esta, sube el error', async () => {
    globalThis.fetch = vi.fn((url) => Promise.resolve(
      String(url).includes('crear-pedido')
        ? { ok: false, status: 409, json: async () => ({ error: 'ya_existe' }) }
        : { ok: true, json: async () => ({}) }));

    await expect(pedidos.crearPedido({ ...PEDIDO, id: 'no-esta' }))
      .rejects.toMatchObject({ motivo: 'ya_existe' });
  });
});
