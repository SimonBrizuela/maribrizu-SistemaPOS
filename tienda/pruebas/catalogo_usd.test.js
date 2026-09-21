// @vitest-environment jsdom
/**
 * Un producto que se compra en dólares, cargado desde la pantalla.
 *
 * Es la parte del sistema donde un error no se ve en el momento: se ve cuando
 * alguien cobra un precio que no era. Por eso acá se abre el Catálogo de
 * verdad, se toca el botón de dólares como lo tocaría una persona, se escribe
 * en los campos y se mira QUÉ SE ESCRIBE en la base.
 *
 * Lo que tiene que quedar guardado, siempre, son los dos números: el precio en
 * dólares (el que manda, el que se recalcula en cada venta) y el precio en
 * pesos de hoy (con el que cobra una caja sin internet y con el que publica la
 * tienda). Si alguna vez se guarda uno solo, hay un producto que no se puede
 * vender o uno que se vende al precio de hace tres meses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { datos } = vi.hoisted(() => ({
  datos: { porColeccion: {}, escrituras: [] },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  const base = firestoreFalso({ registro: datos.escrituras });
  const snapshot = (nombre) => {
    const lista = datos.porColeccion[nombre] || [];
    return {
      docs: lista.map((d, i) => ({
        id: d.__id || `doc${i}`, ref: { id: d.__id || `doc${i}` },
        data: () => d, exists: () => true,
      })),
      empty: lista.length === 0, size: lista.length, docChanges: () => [],
      forEach(fn) { this.docs.forEach(fn); },
      exists: () => lista.length > 0, data: () => lista[0],
    };
  };
  return {
    ...base,
    collection: (_db, nombre) => ({ _col: nombre }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    getDocs: async (q) => snapshot(q?._col || q?.col?._col),
    // `config/cotizacion_usd` es un documento suelto, no una colección: se
    // devuelve puntual para que el panel lo lea como en la vida real.
    getDoc: async (ref) => {
      if (ref?._col === 'config' && ref?.id === 'cotizacion_usd') {
        const d = datos.cotizacion;
        return { exists: () => !!d, data: () => d, id: 'cotizacion_usd' };
      }
      const lista = datos.porColeccion[ref?._col] || [];
      return { exists: () => lista.length > 0, data: () => lista[0], id: ref?.id || 'x' };
    },
    getDocFromCache: async () => { throw new Error('sin cache local'); },
    onSnapshot: (ref, cb) => {
      if (ref?._col === 'config' && ref?.id === 'cotizacion_usd') {
        const d = datos.cotizacion;
        try { cb?.({ exists: () => !!d, data: () => d }); } catch (_) {}
        return () => {};
      }
      try { cb?.(snapshot()); } catch (_) {}
      return () => {};
    },
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {}, storage: {} }));
vi.mock('../../webapp/src/auth.js', () => ({
  auth: { currentUser: { uid: 'u1', displayName: 'Mari', getIdToken: async () => 'T' } },
  getSession: () => ({ uid: 'u1', display: 'Mari', role: 'admin' }),
  isLoggedIn: () => true, onAuthReady: async () => ({ role: 'admin' }),
  hasSessionHint: () => true, logout: async () => {},
}));
vi.mock('../../webapp/src/store.js', () => ({
  ensureCollections: () => {}, onStoreChange: () => () => {},
  initStore: async () => {}, storeListo: async () => {},
}));

const DOLAR = 1550;

const CATALOGO = [
  // En pesos, como toda la vida.
  { __id: 'p1', doc_id: 'p1', id: 1, nombre: 'CUADERNO RIVADAVIA 48 HOJAS', codigo: 'C001',
    rubro: 'LIBRERIA', categoria: 'Cuadernos', marca: 'RIVADAVIA', proveedor: 'DISTRI SUR',
    precio_venta: 3500, costo: 2100, stock: 12, estado: 'activo' },
  // En dólares: el precio en pesos guardado es de una cotización vieja (1400).
  { __id: 'p2', doc_id: 'p2', id: 2, nombre: 'ARGOLLITAS CHIQUITAS DE PLATA', codigo: '988155',
    rubro: 'ACCESORIOS', categoria: 'Aros', sub_rubro: 'AROS', marca: 'SIN MARCA',
    proveedor: 'SIN PROVEEDOR', moneda_costo: 'USD', costo_usd: 10, precio_usd: 35,
    precio_venta: 49000, costo: 14000, stock: 3, stock_min: 1, estado: 'activo' },
  // En dólares y fraccionado: pack, variedades y precio por unidad.
  { __id: 'p3', doc_id: 'p3', id: 3, nombre: 'CINTA IMPORTADA', codigo: '988200',
    rubro: 'MERCERIA', categoria: 'Cintas', marca: 'SIN MARCA', proveedor: 'SIN PROVEEDOR',
    moneda_costo: 'USD', costo_usd: 20, precio_usd: 50, conjunto_precio_unidad_usd: 1.2,
    precio_venta: 70000, costo: 28000, conjunto_precio_unidad: 1680,
    es_conjunto: true, conjunto_tipo: 'rollo', conjunto_unidad_medida: 'metros',
    conjunto_contenido: 50, conjunto_unidades: 2, conjunto_restante: 0, conjunto_total: 100,
    conjunto_colores: [
      { color: 'Rojo', unidades: 1, restante: 0, costo_usd: 20, precio_pack_usd: 50,
        precio_usd: 1.2, costo: 28000, precio_pack: 70000, precio: 1680 },
      { color: 'Azul', unidades: 1, restante: 0, precio_pack_usd: 55, precio_pack: 77000 },
    ],
    stock: 2, estado: 'activo' },
];

let contenedor;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  datos.escrituras.length = 0;
  datos.cotizacion = {
    valor: DOLAR, tipo: 'blue', fuente: 'dolarapi', manual: false,
    actualizado: new Date().toISOString(),
  };
  datos.porColeccion = {
    catalogo: CATALOGO.map(p => JSON.parse(JSON.stringify(p))),
    ventas_por_dia: [], inventario: [], inventario_resumen: [], rubros: [],
    control_config: [], config: [], stock_movimientos: [], catalogo_deleted: [],
  };
  // Nadie sale a internet en una prueba: si la pantalla lo intentara, esto lo
  // haría fallar en vez de dejarlo pasar en silencio.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('la prueba no sale a internet'); }));
  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
  document.body.insertAdjacentHTML('beforeend',
    '<div id="app"></div><div id="page-title"></div><div id="sidebar"></div>' +
    '<div id="status"></div><div id="bottomNav"></div>');
});

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

async function abrirCatalogo() {
  const mod = await import('../../webapp/src/pages/catalogo.js');
  await mod.renderCatalogo(contenedor, {});
  for (let i = 0; i < 8; i++) await esperar();
  return contenedor;
}

function tipear(el, valor) {
  el.value = valor;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const filaDe = (texto) => [...document.querySelectorAll('#catBody tr')]
  .find(tr => tr.textContent.includes(texto));

async function abrirFicha(nombre) {
  filaDe(nombre).querySelector('.btn-editar').click();
  for (let i = 0; i < 8; i++) await esperar();
  return document.getElementById('ed_nombre');
}

async function guardar() {
  document.getElementById('ed_guardar').click();
  for (let i = 0; i < 12; i++) await esperar();
}

const enCatalogo = () => datos.escrituras.filter(e => e.ref?._col === 'catalogo');
const ultimoGuardado = () => enCatalogo().at(-1)?.datos;

describe('la grilla', () => {
  it('muestra el precio con el dólar de hoy, no el que quedó guardado', async () => {
    // Guardado quedó $49.000 (dólar a 1.400). Hoy está a 1.550: U$S 35 × 1.550
    // = 54.250 → $54.300 redondeado a la centena.
    await abrirCatalogo();
    const fila = filaDe('ARGOLLITAS').textContent.replace(/\s+/g, ' ');
    expect(fila).toContain('54.300');
    expect(fila).not.toContain('49.000');
  });

  it('marca cuáles se compran en dólares', async () => {
    await abrirCatalogo();
    expect(filaDe('ARGOLLITAS').textContent).toContain('U$S');
    expect(filaDe('CUADERNO').textContent).not.toContain('U$S');
  });

  it('a los de pesos no les toca nada', async () => {
    await abrirCatalogo();
    const fila = filaDe('CUADERNO').textContent.replace(/\s+/g, ' ');
    expect(fila).toContain('3.500');
    expect(fila).toContain('2.100');
  });

  it('la barra de arriba dice a cuánto está y cuántos productos dependen de eso', async () => {
    await abrirCatalogo();
    const barra = document.getElementById('barraDolar');
    expect(barra.style.display).not.toBe('none');
    const t = barra.textContent.replace(/\s+/g, ' ');
    expect(t).toContain('1.550');
    expect(t).toContain('2 productos en dólares');
  });

  it('sin ningún producto en dólares la barra no ocupa lugar', async () => {
    datos.porColeccion.catalogo = [JSON.parse(JSON.stringify(CATALOGO[0]))];
    datos.cotizacion = null;
    await abrirCatalogo();
    expect(document.getElementById('barraDolar').style.display).toBe('none');
  });

  it('el precio de uno en dólares no se edita a mano desde la grilla', async () => {
    // Editarlo en pesos sería un cambio que la primera venta pisa sola.
    await abrirCatalogo();
    const celda = filaDe('ARGOLLITAS').querySelector('[data-field="precio_venta"]');
    celda.click();
    await esperar();
    expect(celda.querySelector('input')).toBeNull();
    expect(document.body.textContent).toContain('se maneja en dólares');
  });
});

describe('la ficha de un producto en dólares', () => {
  it('abre con los valores en dólares, no con los pesos', async () => {
    await abrirCatalogo();
    await abrirFicha('ARGOLLITAS');
    expect(document.getElementById('ed_costo').value).toBe('10');
    expect(document.getElementById('ed_precio').value).toBe('35');
    expect(document.getElementById('ed_margen').value).toBe('250');
  });

  it('muestra la cuenta hecha: dólares por cotización igual pesos', async () => {
    await abrirCatalogo();
    await abrirFicha('ARGOLLITAS');
    const res = document.getElementById('ed_usd_resultado');
    expect(res.style.display).not.toBe('none');
    const t = res.textContent.replace(/\s+/g, ' ');
    expect(t).toContain('U$S 35');
    expect(t).toContain('1.550');
    expect(t).toContain('54.300');
  });

  it('cambiar el precio en dólares mueve el de pesos en el momento', async () => {
    await abrirCatalogo();
    await abrirFicha('ARGOLLITAS');
    tipear(document.getElementById('ed_precio'), '40');
    await esperar();
    // 40 × 1550 = 62.000
    expect(document.getElementById('ed_usd_resultado').textContent).toContain('62.000');
  });

  it('guardar deja los dos precios: el de dólares y el de pesos de hoy', async () => {
    await abrirCatalogo();
    await abrirFicha('ARGOLLITAS');
    tipear(document.getElementById('ed_precio'), '40');
    await guardar();

    const d = ultimoGuardado();
    expect(d.moneda_costo).toBe('USD');
    expect(d.precio_usd).toBe(40);
    expect(d.costo_usd).toBe(10);
    expect(d.precio_venta).toBe(62000);     // 40 × 1550
    expect(d.costo).toBe(15500);            // 10 × 1550, sin redondear a la centena
    expect(d.cotizacion_usada).toBe(DOLAR);
  });

  it('el estado queda activo: un producto en dólares se puede vender', async () => {
    // `estado: sin_precio` lo saltea el sync del POS y el producto no llega a
    // las cajas. Se decide por el costo en pesos, que acá es calculado.
    await abrirCatalogo();
    await abrirFicha('ARGOLLITAS');
    await guardar();
    expect(ultimoGuardado().estado).toBe('activo');
  });
});

describe('pasar un producto de pesos a dólares y al revés', () => {
  it('el botón convierte lo que hay escrito en vez de borrarlo', async () => {
    await abrirCatalogo();
    await abrirFicha('CUADERNO');
    expect(document.getElementById('ed_costo').value).toBe('2100');

    document.getElementById('ed_moneda_usd').click();
    await esperar();
    // 2100 / 1550 = 1,35 · 3500 / 1550 = 2,26
    expect(document.getElementById('ed_costo').value).toBe('1.35');
    expect(document.getElementById('ed_precio').value).toBe('2.26');
  });

  it('y al volver a pesos quedan pesos otra vez', async () => {
    await abrirCatalogo();
    await abrirFicha('CUADERNO');
    document.getElementById('ed_moneda_usd').click();
    await esperar();
    document.getElementById('ed_moneda_ars').click();
    await esperar();
    // Ida y vuelta: no vuelve exacto (el redondeo del medio), pero queda en
    // pesos y en el mismo orden de magnitud.
    expect(Number(document.getElementById('ed_costo').value)).toBeGreaterThan(2000);
    expect(Number(document.getElementById('ed_precio').value)).toBeGreaterThan(3000);
  });

  it('marcar uno en dólares y guardar lo deja listo para cobrarse al día', async () => {
    await abrirCatalogo();
    await abrirFicha('CUADERNO');
    document.getElementById('ed_moneda_usd').click();
    await esperar();
    tipear(document.getElementById('ed_costo'), '2');
    tipear(document.getElementById('ed_margen'), '150');
    await esperar();
    await guardar();

    const d = ultimoGuardado();
    expect(d.moneda_costo).toBe('USD');
    expect(d.costo_usd).toBe(2);
    expect(d.precio_usd).toBe(5);           // 2 × 2,5
    expect(d.precio_venta).toBe(7800);      // 5 × 1550 = 7.750 → 7.800
    expect(d.costo).toBe(3100);
  });

  it('volver a pesos borra todo rastro de dólares', async () => {
    // Si quedara un `precio_usd` dado vuelta, la primera venta pisaría el
    // precio que se acaba de cargar a mano.
    await abrirCatalogo();
    await abrirFicha('ARGOLLITAS');
    document.getElementById('ed_moneda_ars').click();
    await esperar();
    await guardar();

    const d = ultimoGuardado();
    expect(d.moneda_costo).toBe(null);
    expect(d.precio_usd).toBe(null);
    expect(d.costo_usd).toBe(null);
    expect(d.conjunto_precio_unidad_usd).toBe(null);
    // Y el precio queda en pesos, el que mostraba la pantalla.
    expect(d.precio_venta).toBe(54300);
  });
});

describe('un producto fraccionado en dólares', () => {
  it('abre con el precio del pack y el del metro en dólares', async () => {
    await abrirCatalogo();
    await abrirFicha('CINTA IMPORTADA');
    expect(document.getElementById('ed_precio').value).toBe('50');
    expect(document.getElementById('ed_conj_precio_unidad').value).toBe('1.2');
  });

  it('las variedades muestran sus dólares, no los pesos guardados', async () => {
    await abrirCatalogo();
    await abrirFicha('CINTA IMPORTADA');
    const filas = document.querySelectorAll('[data-color-row]');
    expect(filas.length).toBe(2);
    expect(filas[0].querySelector('.ed_color_precio_pack').value).toBe('50');
    expect(filas[1].querySelector('.ed_color_precio_pack').value).toBe('55');
  });

  it('y debajo de cada una dice a cuánto queda en pesos', async () => {
    await abrirCatalogo();
    await abrirFicha('CINTA IMPORTADA');
    const linea = document.querySelectorAll('[data-color-row]')[1]
      .querySelector('.ed_color_usd');
    expect(linea.style.display).not.toBe('none');
    // 55 × 1550 = 85.250 → 85.300
    expect(linea.textContent.replace(/\s+/g, ' ')).toContain('85.300');
  });

  it('guardar deja cada variedad con sus dos precios', async () => {
    await abrirCatalogo();
    await abrirFicha('CINTA IMPORTADA');
    await guardar();

    const d = ultimoGuardado();
    expect(d.conjunto_precio_unidad_usd).toBe(1.2);
    expect(d.conjunto_precio_unidad).toBe(1860);      // 1,2 × 1550, sin centena
    const rojo = d.conjunto_colores.find(c => c.color === 'Rojo');
    const azul = d.conjunto_colores.find(c => c.color === 'Azul');
    expect(rojo.precio_pack_usd).toBe(50);
    expect(rojo.precio_pack).toBe(77500);             // 50 × 1550
    expect(rojo.costo_usd).toBe(20);
    expect(rojo.costo).toBe(31000);
    expect(azul.precio_pack_usd).toBe(55);
    expect(azul.precio_pack).toBe(85300);             // 55 × 1550 = 85.250 → 85.300
  });

  it('el stock de las variedades no se toca al cambiar de moneda', async () => {
    await abrirCatalogo();
    await abrirFicha('CINTA IMPORTADA');
    document.getElementById('ed_moneda_ars').click();
    await esperar();
    await guardar();

    const d = ultimoGuardado();
    expect(d.conjunto_total).toBe(100);
    expect(d.conjunto_colores.map(c => c.unidades)).toEqual([1, 1]);
    expect(d.conjunto_colores.every(c => c.precio_pack_usd === undefined)).toBe(true);
  });
});

describe('cuando no se sabe a cuánto está el dólar', () => {
  beforeEach(() => { datos.cotizacion = null; });

  it('la grilla cobra el último precio en pesos que quedó guardado', async () => {
    await abrirCatalogo();
    const fila = filaDe('ARGOLLITAS').textContent.replace(/\s+/g, ' ');
    expect(fila).toContain('49.000');        // el viejo, pero un precio al fin
    expect(fila).not.toContain('NaN');
    expect(fila).not.toContain('$0,00');
  });

  it('la barra lo dice en vez de disimularlo', async () => {
    await abrirCatalogo();
    const t = document.getElementById('barraDolar').textContent;
    expect(t).toContain('Todavía no se pudo averiguar');
  });

  it('la ficha avisa y no deja guardar a medias', async () => {
    await abrirCatalogo();
    await abrirFicha('ARGOLLITAS');
    expect(document.getElementById('ed_usd_resultado').textContent)
      .toContain('Todavía no se sabe a cuánto está el dólar');

    await guardar();
    expect(enCatalogo().length).toBe(0);
    expect(document.body.textContent).toContain('Falta saber a cuánto está el dólar');
  });

  it('pero uno en pesos se guarda igual que siempre', async () => {
    await abrirCatalogo();
    await abrirFicha('CUADERNO');
    tipear(document.getElementById('ed_precio'), '3900');
    await guardar();
    expect(ultimoGuardado().precio_venta).toBe(3900);
  });
});

describe('lo que escribe precios en pesos deja afuera a los de dólares', () => {
  const esperarUnPoco = async (n = 10) => { for (let i = 0; i < n; i++) await esperar(); };

  it('el detalle no deja guardar un precio en pesos', async () => {
    await abrirCatalogo();
    filaDe('ARGOLLITAS').querySelector('.btn-detalle').click();
    await esperarUnPoco();

    const btn = document.getElementById('det_guardar_precio');
    expect(btn).toBeTruthy();
    btn.click();
    await esperarUnPoco();

    expect(document.body.textContent).toContain('se maneja en dólares');
    expect(enCatalogo().length).toBe(0);
  });

  it('en uno de pesos el detalle guarda como siempre', async () => {
    await abrirCatalogo();
    filaDe('CUADERNO').querySelector('.btn-detalle').click();
    await esperarUnPoco();

    const precio = document.getElementById('det_precio');
    tipear(precio, '3900');
    document.getElementById('det_guardar_precio').click();
    await esperarUnPoco();

    expect(ultimoGuardado().precio_venta).toBe(3900);
  });

  it('redondear todos los precios no toca los de dólares', async () => {
    // El precio de uno en dólares ya sale redondeado de la conversión;
    // escribirle otro en pesos no duraría hasta la primera venta.
    await abrirCatalogo();
    const btn = document.getElementById('btnRedondearTodos');
    expect(btn).toBeTruthy();
    btn.click();
    await esperarUnPoco(20);

    const tocados = enCatalogo().map(e => e.ref.id);
    expect(tocados).not.toContain('p2');       // ARGOLLITAS, en dólares
    expect(tocados).not.toContain('p3');       // CINTA, en dólares
  });
});

describe('un catálogo sin ningún producto en dólares', () => {
  beforeEach(() => {
    datos.porColeccion.catalogo = [JSON.parse(JSON.stringify(CATALOGO[0]))];
  });

  it('no gasta una lectura en la cotización', async () => {
    // Abrir el catálogo es la pantalla más pesada del panel: pedirle el dólar
    // a la base cuando no hay nada que convertir es tiempo regalado.
    await abrirCatalogo();
    const pedidos = datos.escrituras.filter(e => e.ref?.id === 'cotizacion_usd');
    expect(pedidos.length).toBe(0);
    expect(document.getElementById('barraDolar').style.display).toBe('none');
  });

  it('pero el primero que se marca en dólares la consigue igual', async () => {
    await abrirCatalogo();
    await abrirFicha('CUADERNO');
    document.getElementById('ed_moneda_usd').click();
    for (let i = 0; i < 12; i++) await esperar();

    // El documento existe en la base: se lee al tocar el botón, no antes.
    expect(document.getElementById('ed_usd_resultado').textContent).toContain('1.550');
  });
});

describe('las etiquetas de la ficha dicen en qué moneda se carga', () => {
  // Abrir la ficha de un importado mostraba "COSTO $" arriba de un número en
  // dólares: el que lo veía cargaba pesos en el campo de dólares.
  const lbl = (id) => document.getElementById(id).textContent.trim();

  it('en dólares dicen U$S', async () => {
    await abrirCatalogo();
    await abrirFicha('ARGOLLITAS');
    expect(lbl('lbl_ed_costo')).toBe('COSTO U$S');
    expect(lbl('lbl_ed_precio')).toBe('PRECIO U$S');
  });

  it('en pesos siguen diciendo $', async () => {
    await abrirCatalogo();
    await abrirFicha('CUADERNO');
    expect(lbl('lbl_ed_costo')).toBe('COSTO $');
    expect(lbl('lbl_ed_precio')).toBe('PRECIO VENTA $');
  });

  it('y cambian al tocar el botón, sin cerrar la ficha', async () => {
    await abrirCatalogo();
    await abrirFicha('CUADERNO');
    document.getElementById('ed_moneda_usd').click();
    await esperar();
    expect(lbl('lbl_ed_costo')).toBe('COSTO U$S');

    document.getElementById('ed_moneda_ars').click();
    await esperar();
    expect(lbl('lbl_ed_costo')).toBe('COSTO $');
  });

  it('en un producto fraccionado aclaran que es el pack', async () => {
    await abrirCatalogo();
    await abrirFicha('CINTA IMPORTADA');
    expect(lbl('lbl_ed_costo')).toBe('COSTO U$S DEL PACK');
    expect(lbl('lbl_ed_precio')).toBe('PRECIO U$S DEL PACK');
  });

  it('el ±100 no aparece sobre un precio en dólares', async () => {
    // Redondear dólares a la centena dejaría precios de U$S 100 en adelante:
    // el redondeo va sobre los pesos, y lo hace la conversión.
    await abrirCatalogo();
    await abrirFicha('ARGOLLITAS');
    expect(document.getElementById('btn_redondear').style.display).toBe('none');

    document.getElementById('ed_moneda_ars').click();
    await esperar();
    expect(document.getElementById('btn_redondear').style.display).not.toBe('none');
  });
});
