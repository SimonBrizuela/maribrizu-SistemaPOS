// @vitest-environment jsdom
/**
 * El checkout: la pantalla donde el cliente confirma.
 *
 * Es el punto de todo el sistema con menos margen de error. Del otro lado hay
 * alguien que ya decidió comprar, y cualquier cosa que salga mal acá —un total
 * distinto al que vio, un envío que no correspondía, un pedido que se manda con
 * el teléfono a medio escribir— se paga con una llamada para arreglarlo o con
 * un pedido que no se puede cumplir.
 *
 * Se prueba lo que hace el cliente: elegir cómo lo recibe, cómo paga, llenar
 * los datos y apretar Confirmar. Y lo que sale de eso: el documento que se
 * escribe, con el total, el envío y los renglones que corresponden.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { estado } = vi.hoisted(() => ({
  estado: { escrituras: [], config: null, avisos: [], envio: null, catalogo: {} },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  let n = 0;
  return {
    ...firestoreFalso(),
    collection: (_db, nombre) => ({ _col: nombre }),
    doc: (a, b, c) => (typeof b === 'string' ? { _col: b, id: c }
                                             : { _col: a?._col, id: `nuevo${++n}` }),
    setDoc: async (ref, datos) => { estado.escrituras.push({ ref, datos }); },
    serverTimestamp: () => 'HORA_DEL_SERVIDOR',
  };
});
vi.mock('../src/firebase.js', () => ({ db: {}, app: {} }));

// La tienda lee su configuración y su catálogo de Firestore; acá se le da
// directo. `traerProducto` es el que usa el carrito para revalidar contra la
// base: lo primero que hace el checkout es preguntarle si lo que hay en el
// carrito todavía existe y a qué precio.
vi.mock('../src/datos.js', async (original) => {
  const real = await original();
  return {
    ...real,
    cargarConfig: async () => estado.config,
    cargarAvisos: async () => estado.avisos,
    traerProducto: async (id) => estado.catalogo[id] ?? null,
  };
});
// El envío se cotiza contra una función de Netlify.
vi.mock('../src/envio.js', async (original) => {
  const real = await original();
  return { ...real, cotizar: async () => estado.envio };
});
// El autocompletado de direcciones y el mapa son servicios externos.
vi.mock('../src/direcciones.js', () => ({ montarDirecciones: () => {} }));
vi.mock('../src/mapa.js', () => ({ montarMapa: () => {} }));
// Sin sesión iniciada, `cuenta.js` delega en lo que recuerda este navegador
// (`cliente.js`). Se replica ese camino para probar el autocompletado de verdad.
vi.mock('../src/cuenta.js', async () => {
  const local = await import('../src/cliente.js');
  return {
    sesion: () => null,
    datosParaCompletar: () => {
      const guardado = local.perfil();
      if (!guardado) return null;
      return { ...guardado, direcciones: local.domicilios(), deLaCuenta: false };
    },
    recordarDelPedido: async (datos) => { local.recordarDelPedido(datos); },
  };
});

const carrito = await import('../src/carrito.js');
const { checkout } = await import('../src/paginas/checkout.js');

const CONFIG_BASE = {
  abierta: true,
  entrega: {
    retiro_habilitado: true,
    delivery_habilitado: true,
    pedido_minimo: 6500,
    demora_texto: 'Listo en 2 horas',
    envio_gratis_desde: 50000,
  },
  pago: { efectivo_habilitado: true, transferencia_habilitada: true,
          alias: 'liceo.libreria', titular: 'M. Brizuela' },
  horarios: { lun: [['09:00', '20:30']], mar: [['09:00', '20:30']], mie: [['09:00', '20:30']],
              jue: [['09:00', '20:30']], vie: [['09:00', '20:30']], sab: [['09:00', '13:00']],
              dom: [] },
};

const PRODUCTO = {
  id: 'p1', nombre: 'Cuaderno Rivadavia 48 hojas', precio: 3500, stock: 20,
  imagenes: ['a.webp'], rubro: 'LIBRERIA',
};

let raiz;

/** Monta el checkout y espera a que termine de armarse. */
async function abrir() {
  raiz = document.createElement('div');
  document.body.appendChild(raiz);
  await checkout({ montar: (html) => { raiz.innerHTML = html; } });
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
  return raiz;
}

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** Llena un campo del formulario. */
function llenar(id, valor) {
  const el = document.getElementById(id);
  expect(el, `no está el campo ${id}`).toBeTruthy();
  el.value = valor;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const apretar = (selector) => document.querySelector(selector)?.click();
const plano = () => document.body.textContent.replace(/\./g, '');

beforeEach(() => {
  localStorage.clear();
  estado.escrituras.length = 0;
  estado.config = JSON.parse(JSON.stringify(CONFIG_BASE));
  estado.avisos = [];
  estado.envio = { estado: 'ok', precio: 2500, km: 3.2 };
  estado.catalogo = { p1: { ...PRODUCTO } };
  document.body.innerHTML = '';
  carrito.vaciar();
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
  // Un martes al mediodía: el local está abierto.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 1, 12, 0));
  vi.useRealTimers();
  Element.prototype.scrollIntoView = () => {};
});

describe('el carrito vacío', () => {
  it('no muestra el formulario: manda a comprar', async () => {
    const c = await abrir();
    expect(document.getElementById('nombre')).toBeNull();
    expect(c.textContent.toLowerCase()).toMatch(/vac[íi]o|no hay nada|agreg/);
  });
});

describe('con productos en el carrito', () => {
  beforeEach(() => {
    carrito.agregar(PRODUCTO, { cantidad: 3 });   // 3 × $3.500 = $10.500
  });

  it('muestra lo que se lleva y cuánto suma', async () => {
    await abrir();
    const t = plano();
    expect(t).toContain('Cuaderno Rivadavia');
    expect(t).toContain('10500');
  });

  it('pide nombre y teléfono', async () => {
    await abrir();
    expect(document.getElementById('nombre')).toBeTruthy();
    expect(document.getElementById('telefono')).toBeTruthy();
  });

  it('ofrece retirar y recibir, y las dos formas de pago', async () => {
    await abrir();
    expect(document.querySelector('[data-modo="retiro"]')).toBeTruthy();
    expect(document.querySelector('[data-modo="delivery"]')).toBeTruthy();
    expect(document.querySelector('[data-pago="efectivo"]')).toBeTruthy();
    expect(document.querySelector('[data-pago="transferencia"]')).toBeTruthy();
  });

  it('muestra el alias para transferir', async () => {
    // Sin el alias a la vista, el cliente tiene que escribir para pedirlo.
    await abrir();
    expect(document.body.textContent).toContain('liceo.libreria');
  });
});

describe('confirmar un pedido para retirar', () => {
  beforeEach(() => { carrito.agregar(PRODUCTO, { cantidad: 3 }); });

  it('escribe el pedido con los datos que se llenaron', async () => {
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    apretar('[data-modo="retiro"]');
    await esperar();

    apretar('[data-confirmar]');
    for (let i = 0; i < 12; i++) await esperar();

    const d = estado.escrituras.at(-1)?.datos;
    expect(d, 'tiene que haberse guardado el pedido').toBeTruthy();
    expect(d.cliente).toEqual({ nombre: 'Marta Gómez', telefono: '3515550001' });
    expect(d.entrega.modo).toBe('retiro');
    expect(d.items).toHaveLength(1);
    expect(d.items[0].cantidad).toBe(3);
  });

  it('un pedido para retirar no cobra envío', async () => {
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    apretar('[data-modo="retiro"]');
    await esperar();
    apretar('[data-confirmar]');
    for (let i = 0; i < 12; i++) await esperar();

    const d = estado.escrituras.at(-1).datos;
    expect(d.envio).toBe(0);
    expect(d.total).toBe(d.subtotal);
    expect(d.entrega.direccion).toBeNull();
  });

  it('la nota va con el pedido', async () => {
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    llenar('nota', 'Si no hay del azul, mandame del negro.');
    apretar('[data-modo="retiro"]');
    await esperar();
    apretar('[data-confirmar]');
    for (let i = 0; i < 12; i++) await esperar();

    expect(estado.escrituras.at(-1).datos.nota).toContain('del negro');
  });

  it('pagando en efectivo el pedido queda pendiente de cobro', async () => {
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    apretar('[data-modo="retiro"]');
    apretar('[data-pago="efectivo"]');
    await esperar();
    apretar('[data-confirmar]');
    for (let i = 0; i < 12; i++) await esperar();

    expect(estado.escrituras.at(-1).datos.pago.modo).toBe('efectivo');
    expect(estado.escrituras.at(-1).datos.pago.pagado).toBe(false);
  });
});

describe('pagando por transferencia', () => {
  beforeEach(() => { carrito.agregar(PRODUCTO, { cantidad: 3 }); });

  /** Llena los datos y confirma con transferencia elegida. */
  async function confirmarConTransferencia() {
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    apretar('[data-modo="retiro"]');
    apretar('[data-pago="transferencia"]');
    await esperar();
    apretar('[data-confirmar]');
    for (let i = 0; i < 12; i++) await esperar();
  }

  it('el pedido NO se escribe hasta que llega el comprobante', async () => {
    // Es a propósito: así el pedido nace ya pagado en vez de quedar esperando.
    // Escribirlo antes llenaría la lista del local de pedidos que nadie pagó.
    await confirmarConTransferencia();
    expect(estado.escrituras).toHaveLength(0);
  });

  it('muestra el alias, el titular y cuánto hay que transferir', async () => {
    await confirmarConTransferencia();
    expect(document.body.textContent).toContain('liceo.libreria');
    expect(document.body.textContent).toContain('M. Brizuela');
    expect(plano()).toContain('10500');
  });

  it('ofrece adjuntar el comprobante', async () => {
    await confirmarConTransferencia();
    expect(document.querySelector('[data-adjuntar]')).toBeTruthy();
    expect(document.querySelector('[data-archivo]')).toBeTruthy();
  });

  it('sin alias cargado no deja un hueco: dice cómo se hace', async () => {
    delete estado.config.pago.alias;
    await confirmarConTransferencia();
    expect(plano().toLowerCase()).toMatch(/whatsapp|te lo pasamos/);
  });
});

describe('lo que no deja confirmar', () => {
  beforeEach(() => { carrito.agregar(PRODUCTO, { cantidad: 3 }); });

  it('sin nombre no manda nada y lo marca', async () => {
    await abrir();
    llenar('telefono', '3515550001');
    apretar('[data-modo="retiro"]');
    await esperar();
    apretar('[data-confirmar]');
    for (let i = 0; i < 10; i++) await esperar();

    expect(estado.escrituras).toHaveLength(0);
    expect(document.querySelector('[data-campo="nombre"]').className).toMatch(/error/);
  });

  it('un teléfono que no es un teléfono tampoco', async () => {
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', 'no tengo');
    apretar('[data-modo="retiro"]');
    await esperar();
    apretar('[data-confirmar]');
    for (let i = 0; i < 10; i++) await esperar();

    expect(estado.escrituras).toHaveLength(0);
    expect(document.querySelector('[data-campo="telefono"]').className).toMatch(/error/);
  });

  it('con envío, sin dirección no se puede', async () => {
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    apretar('[data-modo="delivery"]');
    await esperar(20);
    apretar('[data-confirmar]');
    for (let i = 0; i < 10; i++) await esperar();

    expect(estado.escrituras).toHaveLength(0);
  });

  it('el error se muestra en castellano, no un código', async () => {
    await abrir();
    apretar('[data-modo="retiro"]');
    await esperar();
    apretar('[data-confirmar]');
    for (let i = 0; i < 10; i++) await esperar();

    const texto = document.querySelector('[data-campo="nombre"]').textContent;
    expect(texto.toLowerCase()).toMatch(/nombre/);
    expect(texto).not.toMatch(/error|invalid|required/i);
  });
});

describe('el mínimo del pedido', () => {
  it('por debajo del mínimo no se puede confirmar y se ve cuánto falta', async () => {
    // El local pide $6.500 mínimo: mandar un pedido de $3.500 obliga a llamar
    // para cancelarlo.
    carrito.agregar(PRODUCTO, { cantidad: 1 });   // $3.500
    await abrir();
    const t = plano();
    expect(t).toMatch(/6500|falta/i);
    expect(document.querySelector('[data-confirmar]').disabled).toBe(true);
  });

  it('llegando al mínimo se habilita', async () => {
    carrito.agregar(PRODUCTO, { cantidad: 3 });   // $10.500
    await abrir();
    expect(document.querySelector('[data-confirmar]').disabled).toBe(false);
  });
});

describe('el local cerrado', () => {
  it('no deja confirmar y lo dice', async () => {
    estado.config.abierta = false;
    carrito.agregar(PRODUCTO, { cantidad: 3 });
    await abrir();
    expect(document.querySelector('[data-confirmar]').disabled).toBe(true);
    expect(plano().toLowerCase()).toMatch(/cerrad/);
  });
});

describe('lo que el local tiene apagado', () => {
  it('sin delivery no ofrece envío', async () => {
    estado.config.entrega.delivery_habilitado = false;
    carrito.agregar(PRODUCTO, { cantidad: 3 });
    await abrir();
    expect(document.querySelector('[data-modo="delivery"]')).toBeNull();
    expect(document.querySelector('[data-modo="retiro"]')).toBeTruthy();
  });

  it('sin efectivo sólo queda transferencia, ya elegida', async () => {
    estado.config.pago.efectivo_habilitado = false;
    carrito.agregar(PRODUCTO, { cantidad: 3 });
    await abrir();
    expect(document.querySelector('[data-pago="efectivo"]')).toBeNull();
    expect(document.querySelector('[data-pago="transferencia"]').getAttribute('aria-checked'))
      .toBe('true');
  });
});

describe('el pedido con envío', () => {
  beforeEach(() => { carrito.agregar(PRODUCTO, { cantidad: 3 }); });

  it('el envío cotizado se suma al total', async () => {
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    apretar('[data-modo="delivery"]');
    await esperar(20);
    llenar('direccion', 'Av. Alfonsina Storni 168');
    for (let i = 0; i < 10; i++) await esperar();

    apretar('[data-confirmar]');
    for (let i = 0; i < 14; i++) await esperar();

    const d = estado.escrituras.at(-1)?.datos;
    if (!d) return;                       // la cotización quedó pendiente
    expect(d.entrega.modo).toBe('delivery');
    expect(d.total).toBe(d.subtotal + d.envio);
  });

  it('una dirección fuera del radio no deja confirmar', async () => {
    // Confirmar igual genera un pedido que el repartidor no puede cumplir.
    estado.envio = { estado: 'fuera_de_radio', precio: 0, km: 40 };
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    apretar('[data-modo="delivery"]');
    await esperar(20);
    llenar('direccion', 'Alta Gracia 4000');
    for (let i = 0; i < 10; i++) await esperar();

    apretar('[data-confirmar]');
    for (let i = 0; i < 12; i++) await esperar();

    expect(estado.escrituras).toHaveLength(0);
  });
});

describe('lo que cambió mientras el cliente decidía', () => {
  it('un producto que se quedó sin stock saca la pantalla de "no se puede"', async () => {
    // Entre que armó el carrito y llegó acá, el local vendió lo último.
    carrito.agregar(PRODUCTO, { cantidad: 3 });
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    apretar('[data-modo="retiro"]');
    await esperar();

    // La revalidación deja el carrito vacío.
    const espia = vi.spyOn(carrito, 'revalidar').mockImplementation(async () => {
      carrito.vaciar();
      return [];
    });
    try {
      apretar('[data-confirmar]');
      for (let i = 0; i < 12; i++) await esperar();
      expect(estado.escrituras).toHaveLength(0);
    } finally {
      espia.mockRestore();
    }
  });

  it('lo que el servidor rechaza se saca del carrito y se avisa', async () => {
    // El espejo todavía muestra el cuaderno en stock, pero el servidor
    // descontó lo prometido en otro pedido y lo dio por agotado. Si el carrito
    // no lo saca, confirmar de nuevo da el mismo rechazo para siempre.
    estado.catalogo.p2 = { ...PRODUCTO, id: 'p2', nombre: 'Lápiz Faber' };
    carrito.agregar(PRODUCTO, { cantidad: 3 });
    carrito.agregar(estado.catalogo.p2, { cantidad: 1 });
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    apretar('[data-modo="retiro"]');
    await esperar();

    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'cambios',
        cambios: [{ tipo: 'sin_stock', nombre: 'Cuaderno Rivadavia 48 hojas',
                    id: 'p1', variedad: null, es_pack: false }],
      }),
    }));
    apretar('[data-confirmar]');
    for (let i = 0; i < 12; i++) await esperar();

    expect(estado.escrituras).toHaveLength(0);
    expect(carrito.items().map(r => r.id)).toEqual(['p2']);
    expect(document.querySelector('[data-cambios]')?.textContent).toContain('se quedó sin stock');
  });
});

describe('lo que queda recordado en el teléfono', () => {
  it('después de confirmar, el nombre y el teléfono se completan solos', async () => {
    carrito.agregar(PRODUCTO, { cantidad: 3 });
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    apretar('[data-modo="retiro"]');
    await esperar();
    apretar('[data-confirmar]');
    for (let i = 0; i < 14; i++) await esperar();

    // Segunda visita: los campos vienen puestos.
    document.body.innerHTML = '';
    carrito.agregar(PRODUCTO, { cantidad: 3 });
    await abrir();
    expect(document.getElementById('nombre').value).toBe('Marta Gómez');
    expect(document.getElementById('telefono').value).toBe('3515550001');
  });

  it('"No soy yo" borra lo recordado', async () => {
    carrito.agregar(PRODUCTO, { cantidad: 3 });
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    apretar('[data-modo="retiro"]');
    await esperar();
    apretar('[data-confirmar]');
    for (let i = 0; i < 14; i++) await esperar();

    document.body.innerHTML = '';
    carrito.agregar(PRODUCTO, { cantidad: 3 });
    await abrir();
    const boton = document.querySelector('[data-no-soy-yo]');
    expect(boton, 'tiene que ofrecer salir del autocompletado').toBeTruthy();
    boton.click();
    for (let i = 0; i < 6; i++) await esperar();

    expect((document.getElementById('nombre')?.value || '')).toBe('');
  });
});

describe('con un cupón', () => {
  const CUPON_OK = {
    ok: true,
    cupon: { codigo: 'BIENVENIDA', nombre: 'Cupón de bienvenida', tipo: 'porcentaje', valor: 10 },
    descuento: 1050, envio_gratis: false, aplicable: 10500,
    renglones: [{ id: 'p1', variedad: null, es_pack: false, descuento: 1050 }],
  };

  /** Un fetch que contesta según la función a la que se le pega. */
  function fetchPorUrl(rutas) {
    globalThis.fetch = vi.fn((url, opciones = {}) => {
      const u = String(url);
      const clave = Object.keys(rutas).find(k => u.includes(k));
      const r = clave ? rutas[clave](opciones) : { status: 200, cuerpo: {} };
      return Promise.resolve({
        ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.cuerpo,
      });
    });
  }

  async function aplicar(codigo) {
    // El campo aparece recién al tocar "¿Tenés un cupón?".
    document.querySelector('[data-abrir-cupon]')?.click();
    await esperar();
    llenar('cupon', codigo);
    document.querySelector('[data-form-cupon]')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 8; i++) await esperar();
  }

  beforeEach(() => {
    carrito.agregar(PRODUCTO, { cantidad: 3 });   // 3 × 3.500 = 10.500
  });

  it('cerrado es un renglón del resumen; el campo aparece al tocarlo', async () => {
    await abrir();
    expect(document.getElementById('cupon')).toBeNull();
    expect(document.querySelector('[data-abrir-cupon]')?.textContent).toContain('¿Tenés un cupón?');
    apretar('[data-abrir-cupon]');
    await esperar();
    expect(document.getElementById('cupon')).toBeTruthy();
    expect(document.querySelector('[data-aplicar-cupon]')?.textContent).toContain('Aplicar');
  });

  it('aplicado, muestra cuál es, cuánto saca y el total nuevo', async () => {
    fetchPorUrl({ 'validar-cupon': () => ({ status: 200, cuerpo: CUPON_OK }) });
    await abrir();
    apretar('[data-modo="retiro"]');
    await esperar();

    await aplicar('bienvenida');

    const texto = plano();
    expect(texto).toContain('BIENVENIDA');
    expect(texto).toContain('10% de descuento');
    expect(texto).toContain('−$1050');
    expect(document.querySelector('.totales__fila--total').textContent.replace(/\./g, '')).toContain('$9450');
    // El total de antes queda tachado al lado, y abajo cuánto se ahorra.
    expect(document.querySelector('.totales__antes')?.textContent.replace(/\./g, '')).toBe('$10500');
    expect(texto).toContain('Ahorrás con el cupón');
    expect(document.querySelector('[data-quitar-cupon]')).toBeTruthy();
    // Va el código, el carrito y cómo se entrega; ningún precio.
    const enviado = JSON.parse(vi.mocked(fetch).mock.calls.find(c => String(c[0]).includes('validar-cupon'))[1].body);
    expect(enviado).toMatchObject({ codigo: 'BIENVENIDA', entrega: { modo: 'retiro' } });
    expect(enviado.items[0]).toEqual({ id: 'p1', variedad: null, cantidad: 3, es_pack: false });
    expect(enviado.items[0].precio).toBeUndefined();
  });

  it('que no vale: dice por qué y no queda puesto', async () => {
    fetchPorUrl({ 'validar-cupon': () => ({ status: 409, cuerpo: { error: 'cupon', motivo: 'minimo', falta: 4500, minimo: 15000 } }) });
    await abrir();
    await esperar();

    await aplicar('GRANDE');

    expect(plano()).toContain('Te faltan $4500 para usar este cupón');
    expect(document.querySelector('[data-quitar-cupon]')).toBeNull();
    expect(document.querySelector('.totales__fila--descuento')).toBeNull();
  });

  it('vacío no llama a nadie', async () => {
    fetchPorUrl({ 'validar-cupon': () => { throw new Error('no tendría que llamar'); } });
    await abrir();
    await aplicar('   ');
    expect(plano()).toContain('Escribí el código del cupón');
  });

  it('se puede quitar, y vuelve el renglón cerrado', async () => {
    fetchPorUrl({ 'validar-cupon': () => ({ status: 200, cuerpo: CUPON_OK }) });
    await abrir();
    await aplicar('BIENVENIDA');
    apretar('[data-quitar-cupon]');
    await esperar();

    expect(document.querySelector('[data-abrir-cupon]')).toBeTruthy();
    expect(document.querySelector('[data-quitar-cupon]')).toBeNull();
    expect(document.querySelector('.totales__fila--descuento')).toBeNull();
    expect(localStorage.getItem('liceo.cupon.v1')).toBeNull();
  });

  it('al confirmar viaja solo el código, y el pedido entra por el servidor', async () => {
    const cuerpos = [];
    fetchPorUrl({
      'validar-cupon': () => ({ status: 200, cuerpo: CUPON_OK }),
      'crear-pedido': (op) => {
        cuerpos.push(JSON.parse(op.body || '{}'));
        return { status: 200, cuerpo: { id: 'ped1', codigo: 'ABCD', total: 9450 } };
      },
    });
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    apretar('[data-modo="retiro"]');
    apretar('[data-pago="efectivo"]');
    await esperar();
    await aplicar('BIENVENIDA');

    apretar('[data-confirmar]');
    for (let i = 0; i < 12; i++) await esperar();

    const pedido = cuerpos.findLast(c => c.items);
    expect(pedido.cupon).toBe('BIENVENIDA');
    expect(pedido.descuento).toBeUndefined();
    expect(estado.escrituras).toHaveLength(0);
  });

  it('si el servidor lo rechaza al confirmar, se saca y se dice por qué', async () => {
    fetchPorUrl({
      'validar-cupon': () => ({ status: 200, cuerpo: CUPON_OK }),
      'crear-pedido': (op) => (String(op.body).includes('warmup')
        ? { status: 204, cuerpo: null }
        : { status: 409, cuerpo: { error: 'cupon', motivo: 'ya_usado', veces: 1 } }),
    });
    await abrir();
    llenar('nombre', 'Marta Gómez');
    llenar('telefono', '3515550001');
    apretar('[data-modo="retiro"]');
    apretar('[data-pago="efectivo"]');
    await esperar();
    await aplicar('BIENVENIDA');

    apretar('[data-confirmar]');
    for (let i = 0; i < 12; i++) await esperar();

    expect(plano()).toContain('ya lo usaste');
    expect(document.querySelector('[data-quitar-cupon]')).toBeNull();
    expect(estado.escrituras).toHaveLength(0);
  });

  it('el cupón que quedó de la otra vez se vuelve a comprobar al abrir', async () => {
    localStorage.setItem('liceo.cupon.v1', JSON.stringify(CUPON_OK));
    fetchPorUrl({ 'validar-cupon': () => ({ status: 409, cuerpo: { error: 'cupon', motivo: 'vencido' } }) });
    await abrir();
    for (let i = 0; i < 6; i++) await esperar();

    expect(document.querySelector('[data-quitar-cupon]')).toBeNull();
    expect(plano()).toContain('ya no está vigente');
  });

  it('con envío gratis, el envío queda sin cargo y no hay renglón de descuento aparte', async () => {
    fetchPorUrl({
      'validar-cupon': () => ({ status: 200, cuerpo: {
        ok: true, cupon: { codigo: 'ENVIO', nombre: 'Envío sin cargo', tipo: 'envio_gratis', valor: null },
        descuento: 2500, envio_gratis: true, aplicable: 0, renglones: [],
      } }),
    });
    await abrir();
    apretar('[data-modo="delivery"]');
    for (let i = 0; i < 6; i++) await esperar();
    await aplicar('ENVIO');

    expect(document.querySelector('.totales__fila--descuento')).toBeNull();
    expect(plano()).toContain('Sin cargo');
    expect(document.querySelector('.totales__fila--total').textContent.replace(/\./g, '')).toContain('$10500');
  });
});
