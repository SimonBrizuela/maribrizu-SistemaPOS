// @vitest-environment jsdom
/**
 * La pantalla de "qué hay que reponer".
 *
 * Se usa parada frente a la góndola o con el proveedor esperando, y el catálogo
 * tiene 1.900 alertas: si hay que bajar cientos de pantallas para encontrar algo,
 * no se usa. Lo que esta prueba cuida es justamente eso:
 *
 *   · una fila por producto, no una tarjeta de tres líneas;
 *   · los números de arriba son los filtros y cuentan bien;
 *   · el buscador encuentra por nombre, código o sección;
 *   · la lista se dibuja de a tandas (con 1.900 filas de una, el navegador se traba);
 *   · el ojo oculta el producto y NO abre la ficha (dos acciones en la misma fila);
 *   · un nombre con HTML no inyecta nada.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { estado } = vi.hoisted(() => ({
  estado: { alertas: [], ocultos: [], abiertos: [], ignorados: [], restaurado: 0 },
}));

vi.mock('../../webapp/src/notifications.js', () => ({
  obtenerAlertasActivas: () => estado.alertas,
  onAlertasCambian: () => () => {},
  refrescarAlertas: async () => estado.alertas,
  pedirPermisoNotificaciones: async () => 'granted',
  permisoNotificacion: () => 'granted',
  notificacionesSoportadas: () => true,
  notificacionesNavegadorActivas: () => true,
  setNotificacionesNavegador: () => {},
  irACatalogoYAbrir: (id) => estado.abiertos.push(id),
  mostrarNotificacionDePrueba: () => true,
  ignorarProducto: (id) => estado.ignorados.push(id),
  restaurarTodos: () => { estado.restaurado++; },
  obtenerIgnorados: () => estado.ocultos,
}));

const { renderNotificaciones } = await import('../../webapp/src/pages/notificaciones.js');

const alerta = (extra = {}) => ({
  key: Math.random().toString(36).slice(2),
  doc_id: 'p' + Math.random().toString(36).slice(2),
  nombre: 'CUADERNO RIVADAVIA', codigo: 'C1', rubro: 'LIBRERIA', marca: 'RIVADAVIA',
  variedad: null, stock: 2, stock_min: 10, critico: false, urgente: false, auto: false,
  origen: 'min', ...extra,
});

const urgente = (extra = {}) => alerta({
  urgente: true, origen: 'ritmo', solo_pagina: true, es_top: true, stock: 0, critico: true,
  vel_dia: 5, vel_semana: 35, dias_cobertura: 0, unidades_ventana: 100, ritmo_dias: 20,
  cobertura_texto: 'Sin stock - vendiste 100 en 20 dias', ...extra,
});

const filas = () => [...document.querySelectorAll('.nf-row')];
const chip = (f) => document.querySelector(`.nf-chip[data-f="${f}"]`);
const textoChip = (f) => chip(f)?.textContent.replace(/\s+/g, ' ').trim();

let cont;
async function montar(alertas) {
  estado.alertas = alertas;
  cont = document.createElement('div');
  document.body.appendChild(cont);
  await renderNotificaciones(cont);
  await new Promise(r => setTimeout(r, 0));   // el refrescarAlertas() del final
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  estado.ocultos = [];
  estado.abiertos = [];
  estado.ignorados = [];
  estado.restaurado = 0;
});

describe('la lista', () => {
  it('dibuja una fila por producto', async () => {
    await montar([urgente({ nombre: 'UHU PEGAMENTO' }), alerta({ nombre: 'CINTA RIBBON' }),
                  alerta({ nombre: 'GEMA REDONDA', stock: 0, critico: true })]);
    expect(filas().length).toBe(3);
    expect(document.body.textContent).toContain('UHU PEGAMENTO');
  });

  it('lo urgente va arriba de todo, aunque tenga minimo cargado', async () => {
    await montar([alerta({ nombre: 'COMUN' }), urgente({ nombre: 'EL QUE SE AGOTA' })]);
    expect(filas()[0].textContent).toContain('EL QUE SE AGOTA');
    expect(filas()[0].classList.contains('nf-row--urg')).toBe(true);
  });

  it('agrupa las variedades de un mismo producto en una sola fila', async () => {
    const doc = 'papel1';
    await montar([
      alerta({ doc_id: doc, auto: true, variedad: 'Rojo', stock: 0, critico: true, nombre: 'PAPEL - Rojo' }),
      alerta({ doc_id: doc, auto: true, variedad: 'Azul', stock: 1, nombre: 'PAPEL - Azul' }),
      alerta({ doc_id: doc, auto: true, variedad: 'Verde', stock: 2, nombre: 'PAPEL - Verde' }),
    ]);
    expect(filas().length).toBe(1);
    expect(document.querySelectorAll('.nf-var').length).toBe(3);
    expect(document.querySelector('.nf-datos').textContent).toContain('1 en cero');
  });

  it('sin alertas muestra que esta todo en orden', async () => {
    await montar([]);
    expect(document.querySelector('.nf-vacio').textContent).toContain('Todo en orden');
  });
});

describe('los numeros de arriba son los filtros', () => {
  it('cuentan cada grupo', async () => {
    await montar([
      urgente(), urgente(),
      alerta({ stock: 0, critico: true }),
      alerta({ stock: 3 }), alerta({ stock: 4 }), alerta({ stock: 5 }),
      alerta({ auto: true, variedad: 'Rojo', doc_id: 'v1' }),
    ]);
    expect(textoChip('todas')).toContain('7');
    expect(textoChip('urgente')).toContain('2');
    expect(textoChip('sin_stock')).toContain('1');
    expect(textoChip('bajo')).toContain('3');
    expect(textoChip('variantes')).toContain('1');
  });

  it('cuentan filas y no alertas sueltas: tres colores de un producto son uno', async () => {
    // Si arriba dice 3 y abajo hay una sola fila, no se le cree a ninguno de los dos.
    await montar([
      alerta({ doc_id: 'g1', auto: true, variedad: 'Rojo', stock: 0, critico: true }),
      alerta({ doc_id: 'g1', auto: true, variedad: 'Azul', stock: 1 }),
      alerta({ doc_id: 'g1', auto: true, variedad: 'Verde', stock: 1 }),
    ]);
    expect(textoChip('variantes')).toContain('1');
    expect(textoChip('todas')).toContain('1');
    expect(filas().length).toBe(1);
    expect(document.body.textContent).toContain('3 variedades');
  });

  it('el buscador tambien mueve los numeros de arriba', async () => {
    await montar([alerta({ nombre: 'CUADERNO ABC' }), alerta({ nombre: 'LAPIZ NEGRO' })]);
    const inp = document.getElementById('notifBuscar');
    inp.value = 'lapiz';
    inp.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 180));
    expect(textoChip('todas')).toContain('1');
  });

  it('al tocar uno queda solo ese grupo', async () => {
    await montar([urgente({ nombre: 'URGENTE UNO' }), alerta({ nombre: 'TRANQUILO' })]);
    chip('bajo').click();
    expect(filas().length).toBe(1);
    expect(document.body.textContent).toContain('TRANQUILO');
    expect(filas()[0].textContent).not.toContain('URGENTE UNO');
  });

  it('el filtro elegido se recuerda para la proxima vez', async () => {
    await montar([urgente(), alerta()]);
    chip('urgente').click();
    expect(localStorage.getItem('notif:filtro')).toBe('urgente');
  });

  it('un grupo vacio no se puede tocar', async () => {
    await montar([alerta()]);
    expect(chip('urgente').disabled).toBe(true);
  });
});

describe('un producto con muchisimos colores', () => {
  const colores = (n, doc = 'muchos') => Array.from({ length: n }, (_, i) =>
    alerta({ doc_id: doc, auto: true, variedad: 'Color ' + i, stock: i < 5 ? 0 : 1,
             critico: i < 5, nombre: 'HILO BORDAR · Color ' + i }));

  it('cerrada muestra una tira, no las cien', async () => {
    await montar(colores(60));
    expect(document.querySelectorAll('.nf-var').length).toBe(14);
    expect(document.querySelector('.nf-mas-var').textContent.trim()).toContain('60');
  });

  it('el boton con el numero las abre todas', async () => {
    await montar(colores(60));
    document.querySelector('.nf-mas-var').click();
    expect(document.querySelectorAll('.nf-var').length).toBe(60);
    expect(filas()[0].classList.contains('nf-row--abierta')).toBe(true);
  });

  it('abrirla no abre la ficha del producto', async () => {
    await montar(colores(60));
    document.querySelector('.nf-mas-var').click();
    expect(estado.abiertos).toEqual([]);
  });

  it('se vuelve a cerrar', async () => {
    await montar(colores(60));
    const btn = document.querySelector('.nf-mas-var');
    btn.click();
    btn.click();
    expect(document.querySelectorAll('.nf-var').length).toBe(14);
    expect(filas()[0].classList.contains('nf-row--abierta')).toBe(false);
  });

  it('con pocas variedades no hace falta el boton', async () => {
    await montar(colores(3));
    expect(document.querySelector('.nf-mas-var')).toBeNull();
    expect(document.querySelectorAll('.nf-var').length).toBe(3);
  });
});

describe('el buscador', () => {
  it('filtra por nombre', async () => {
    await montar([alerta({ nombre: 'CUADERNO ABC' }), alerta({ nombre: 'LAPIZ NEGRO' })]);
    const inp = document.getElementById('notifBuscar');
    inp.value = 'lapiz';
    inp.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 180));
    expect(filas().length).toBe(1);
    expect(filas()[0].textContent).toContain('LAPIZ NEGRO');
  });

  it('avisa cuando no queda nada', async () => {
    await montar([alerta({ nombre: 'CUADERNO ABC' })]);
    const inp = document.getElementById('notifBuscar');
    inp.value = 'nohayasi';
    inp.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 180));
    expect(document.querySelector('.nf-vacio').textContent).toContain('Nada con esos filtros');
  });
});

describe('la lista se dibuja de a tandas', () => {
  it('no mete 200 filas de una', async () => {
    await montar(Array.from({ length: 200 }, (_, i) => alerta({ nombre: 'PROD ' + i })));
    expect(filas().length).toBe(60);
    expect(document.body.textContent).toContain('Mostrando');
  });

  it('el boton trae la tanda siguiente', async () => {
    await montar(Array.from({ length: 200 }, (_, i) => alerta({ nombre: 'PROD ' + i })));
    document.getElementById('nfMas').click();
    expect(filas().length).toBe(120);
  });
});

describe('las dos acciones de la fila', () => {
  it('tocar la fila abre la ficha del producto', async () => {
    await montar([alerta({ doc_id: 'abc123' })]);
    filas()[0].click();
    expect(estado.abiertos).toEqual(['abc123']);
  });

  it('el ojo oculta y no abre la ficha', async () => {
    await montar([alerta({ doc_id: 'abc123' })]);
    filas()[0].querySelector('[data-ocultar]').click();
    expect(estado.ignorados).toEqual(['abc123']);
    expect(estado.abiertos).toEqual([]);
  });

  it('los ocultos se pueden volver a mostrar', async () => {
    estado.ocultos = ['x1', 'x2'];
    await montar([alerta()]);
    document.getElementById('notifRestaurar').click();
    expect(estado.restaurado).toBe(1);
  });
});

describe('los datos que vienen del catalogo', () => {
  it('un nombre con HTML no inyecta nada', async () => {
    await montar([alerta({ nombre: '<img src=x onerror=alert(1)>' })]);
    expect(document.querySelector('.nf-row img')).toBeNull();
    expect(document.querySelector('.nf-nombre').innerHTML).toContain('&lt;img');
  });
});
