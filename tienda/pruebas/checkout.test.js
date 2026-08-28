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
