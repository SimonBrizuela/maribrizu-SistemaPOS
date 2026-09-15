// @vitest-environment jsdom
/**
 * La hoja donde el cliente cuenta qué pasó con su pedido.
 *
 * Se abre encima de la pantalla del pedido, que se rearma sola con cada cambio
 * de estado: la hoja vive aparte, en el body, así lo que el cliente está
 * escribiendo no se borra porque el local tocó algo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/router.js', () => ({
  capaConHistorial: vi.fn(() => ({ soltar: vi.fn() })),
}));

// Cada prueba con el módulo recién cargado: los borradores viven en el módulo.
let abrirHojaReclamo;
let cerrarHojaReclamo;
let mandarReclamo;

const ID = 'Ab12Cd34Ef56Gh78Ij90';
const hace = (dias) => new Date(Date.now() - dias * 86400000).toISOString();

const pedido = (extra = {}) => ({
  id: ID, codigo: 'K7M2', estado: 'entregado', creado: hace(3), entregado_en: hace(2),
  cliente: { nombre: 'Marta', telefono: '3515550001' },
  entrega: { modo: 'delivery' },
  items: [
    { id: 'p1', nombre: 'Resma A4', cantidad: 2 },
    { id: 'p2', nombre: 'Cartulina', variedad: 'Azul', cantidad: 5, foto: 'https://f/c.webp' },
  ],
  ...extra,
});

let pedidos;
let respuesta;
let achicadas;

const pedir = vi.fn(async (url, opciones) => {
  pedidos.push({ url, cuerpo: JSON.parse(opciones.body) });
  if (respuesta instanceof Error) throw respuesta;
  return { ok: respuesta.status === 200, status: respuesta.status, json: async () => respuesta.cuerpo };
});

const achicar = vi.fn(async (archivo) => {
  if (archivo.name === 'rota.heic') throw new Error('No pudimos abrir esa foto. Probá con otra.');
  achicadas.push(archivo.name);
  return { tipo: 'image/jpeg', datos: `base64-${archivo.name}`, bytes: 1000, blob: new Blob(['x']) };
});

const respirar = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); };
const hoja = () => document.querySelector('[data-hoja-reclamo]');
const $ = (sel) => hoja()?.querySelector(sel);
const $$ = (sel) => [...(hoja()?.querySelectorAll(sel) || [])];

function abrir(p = pedido(), extra = {}) {
  abrirHojaReclamo(p, { whatsapp: '5493517046684', achicar, pedir, ...extra });
}
function elegir(motivo) { $(`[data-motivo="${motivo}"]`).click(); }
function escribir(texto) {
  const campo = $('[data-detalle]');
  campo.value = texto;
  campo.dispatchEvent(new Event('input', { bubbles: true }));
}
function marcar(renglon) {
  const casilla = $(`[data-renglon="${renglon}"]`);
  casilla.checked = !casilla.checked;
  casilla.dispatchEvent(new Event('change', { bubbles: true }));
}
async function sumarFotos(...nombres) {
  const input = $('[data-sumar-fotos]');
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: nombres.map(n => new File(['x'], n, { type: n.endsWith('.heic') ? 'image/heic' : 'image/jpeg' })),
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await respirar();
}
async function enviar() {
  $('[data-enviar-reclamo]').click();
  await respirar();
}

beforeEach(async () => {
  cerrarHojaReclamo?.();
  vi.resetModules();
  ({ abrirHojaReclamo, cerrarHojaReclamo, mandarReclamo } = await import('../src/hoja_reclamo.js'));
  document.body.innerHTML = '';
  pedidos = [];
  achicadas = [];
  respuesta = { status: 200, cuerpo: { ok: true, reclamo: { id: `${ID}-1`, estado: 'nuevo', motivo: 'roto' } } };
  pedir.mockClear();
  achicar.mockClear();
  URL.createObjectURL = vi.fn(() => 'blob:vista');
  URL.revokeObjectURL = vi.fn();
});

describe('abrir', () => {
  it('muestra los motivos que tienen sentido para el pedido', () => {
    abrir();
    expect($$('[data-motivo]').map(b => b.dataset.motivo)).toContain('no_llego');
    cerrarHojaReclamo();
    abrir(pedido({ entrega: { modo: 'retiro' } }));
    expect($$('[data-motivo]').map(b => b.dataset.motivo)).not.toContain('no_llego');
  });

  it('es un diálogo con título y el código del pedido', () => {
    abrir();
    const dialogo = $('[role="dialog"]');
    expect(dialogo.getAttribute('aria-modal')).toBe('true');
    expect(hoja().textContent).toContain('K7M2');
  });

  it('abrirla dos veces no la duplica', () => {
    abrir();
    abrir();
    expect(document.querySelectorAll('[data-hoja-reclamo]')).toHaveLength(1);
  });

  it('se cierra con la X, con Escape y tocando afuera', () => {
    abrir();
    $('.reclamo-hoja__cerrar').click();
    expect(hoja()).toBeNull();

    abrir();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(hoja()).toBeNull();

    abrir();
    $('.reclamo-hoja__fondo').click();
    expect(hoja()).toBeNull();
  });

  it('lo que escribió sigue ahí si la cierra sin querer y la vuelve a abrir', () => {
    abrir();
    elegir('roto');
    marcar(1);
    escribir('Llegaron dobladas');
    cerrarHojaReclamo();
    abrir();
    expect($('[data-motivo="roto"]').getAttribute('aria-checked')).toBe('true');
    expect($('[data-renglon="1"]').checked).toBe(true);
    expect($('[data-detalle]').value).toBe('Llegaron dobladas');
  });
});

describe('completar', () => {
  it('elegir un motivo lo marca, y uno solo', () => {
    abrir();
    elegir('roto');
    elegir('cobro');
    expect($$('[aria-checked="true"]').map(b => b.dataset.motivo)).toEqual(['cobro']);
  });

  it('los productos se piden solo cuando el motivo es de productos, con su color', () => {
    abrir();
    expect($('[data-paso-productos]').hidden).toBe(true);
    elegir('roto');
    expect($('[data-paso-productos]').hidden).toBe(false);
    expect($('[data-paso-productos]').textContent).toContain('Azul');
    elegir('cobro');
    expect($('[data-paso-productos]').hidden).toBe(true);
  });

  it('el contador sigue lo que escribe', () => {
    abrir();
    escribir('Hola che');
    expect($('[data-contador]').textContent).toMatch(/^8\s*\/\s*600$/);
  });

  it('incompleto: dice qué falta al lado del campo y no manda nada', async () => {
    abrir();
    elegir('roto');
    escribir('Llegó todo doblado');
    await enviar();
    expect(pedidos).toHaveLength(0);
    expect($('[data-error]').textContent).toMatch(/producto/);
    expect($('[data-paso-productos]').classList.contains('reclamo-paso--error')).toBe(true);
  });
});

describe('fotos', () => {
  it('cada foto se achica y aparece su miniatura; se puede quitar', async () => {
    abrir();
    await sumarFotos('a.jpg', 'b.jpg');
    expect(achicadas).toEqual(['a.jpg', 'b.jpg']);
    expect($$('[data-foto]')).toHaveLength(2);
    $$('[data-quitar-foto]')[0].click();
    expect($$('[data-foto]')).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('hasta tres: la cuarta no entra y el botón de sumar desaparece', async () => {
    abrir();
    await sumarFotos('a.jpg', 'b.jpg', 'c.jpg', 'd.jpg');
    expect($$('[data-foto]')).toHaveLength(3);
    expect($('[data-sumar-fotos]')).toBeNull();
    expect($('[data-error]').textContent).toMatch(/hasta 3/);
  });

  it('una foto que no se puede abrir lo dice y las demás quedan', async () => {
    abrir();
    await sumarFotos('a.jpg', 'rota.heic');
    expect($$('[data-foto]')).toHaveLength(1);
    expect($('[data-error]').textContent).toMatch(/No pudimos abrir/);
  });
});

describe('enviar', () => {
  async function completoYEnvio() {
    abrir();
    elegir('roto');
    marcar(1);
    escribir('Dos cartulinas llegaron dobladas.');
    await sumarFotos('a.jpg');
    await enviar();
  }

  it('manda el reclamo con los renglones, el detalle y las fotos', async () => {
    await completoYEnvio();
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0].url).toBe('/.netlify/functions/crear-reclamo');
    expect(pedidos[0].cuerpo).toEqual({
      pedido: ID, motivo: 'roto', renglones: [1], detalle: 'Dos cartulinas llegaron dobladas.',
      fotos: [{ tipo: 'image/jpeg', datos: 'base64-a.jpg' }],
    });
  });

  it('al entrar muestra la confirmación y avisa a la pantalla', async () => {
    const alEnviado = vi.fn();
    abrir(pedido(), { alEnviado });
    elegir('cobro');
    escribir('Me cobraron dos veces el envío.');
    await enviar();
    expect(hoja().textContent).toContain('Recibimos tu reclamo');
    expect(alEnviado).toHaveBeenCalledWith(expect.objectContaining({ id: `${ID}-1`, estado: 'nuevo' }));
  });

  it('después de mandarlo, abrirla de nuevo empieza de cero', async () => {
    await completoYEnvio();
    cerrarHojaReclamo();
    abrir();
    expect($('[data-detalle]').value).toBe('');
    expect($$('[data-foto]')).toHaveLength(0);
  });

  it('mientras manda no deja mandar dos veces', async () => {
    let soltar;
    pedir.mockImplementationOnce((url, opciones) => new Promise(r => {
      pedidos.push({ url, cuerpo: JSON.parse(opciones.body) });
      soltar = () => r({ ok: true, status: 200, json: async () => respuesta.cuerpo });
    }));
    abrir();
    elegir('cobro');
    escribir('Me cobraron dos veces el envío.');
    $('[data-enviar-reclamo]').click();
    await respirar();
    expect($('[data-enviar-reclamo]').disabled).toBe(true);
    $('[data-enviar-reclamo]').click();
    await respirar();
    expect(pedidos).toHaveLength(1);
    soltar();
    await respirar();
    expect(hoja().textContent).toContain('Recibimos tu reclamo');
  });

  it('con un reclamo ya abierto lo explica', async () => {
    respuesta = { status: 409, cuerpo: { error: 'abierto' } };
    await completoYEnvio();
    expect($('[data-error]').textContent).toMatch(/ya tenés un reclamo abierto/i);
  });

  it('si el servidor rechaza un campo, lo muestra en ese campo', async () => {
    respuesta = { status: 400, cuerpo: { error: 'invalido', campo: 'detalle', mensaje: 'Contanos un poco más qué pasó.' } };
    await completoYEnvio();
    expect($('[data-error]').textContent).toContain('Contanos un poco más');
    expect($('[data-campo-detalle]').classList.contains('campo--error')).toBe(true);
  });

  it('si no se pudo mandar ofrece WhatsApp con lo que ya escribió, y deja reintentar', async () => {
    respuesta = new Error('sin red');
    await completoYEnvio();
    const enlace = $('[data-whatsapp-reclamo]');
    expect(enlace).toBeTruthy();
    const texto = decodeURIComponent(enlace.getAttribute('href'));
    expect(texto).toContain('wa.me/5493517046684');
    expect(texto).toContain('K7M2');
    expect(texto).toContain('Dos cartulinas llegaron dobladas.');
    expect($('[data-enviar-reclamo]').disabled).toBe(false);
  });
});

describe('mandarReclamo', () => {
  it('traduce cada respuesta a algo que la hoja entiende', async () => {
    respuesta = { status: 501, cuerpo: { error: 'sin_credenciales' } };
    expect(await mandarReclamo(ID, {}, { pedir })).toMatchObject({ ok: false, status: 501, error: 'sin_credenciales' });
    respuesta = new Error('sin red');
    expect(await mandarReclamo(ID, {}, { pedir })).toMatchObject({ ok: false, status: 0, error: 'red' });
  });
});
