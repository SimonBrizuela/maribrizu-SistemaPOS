// @vitest-environment jsdom
/**
 * La cuenta del cliente y el campo de dirección.
 *
 * Los dos existen para lo mismo: que comprar la segunda vez sea más corto que
 * la primera. La cuenta lleva los datos de un teléfono a otro; el campo de
 * dirección resuelve la calle contra Google para poder cobrar el envío exacto.
 *
 * Lo que más importa acá:
 *   · el perfil que se guarda es el de quien está adentro, y sólo el suyo;
 *   · un pedido no se puede caer porque no se pudo guardar una dirección;
 *   · sin altura no se cobra un envío sacado del centro de la calle: se pide
 *     el número, porque diez cuadras pueden cruzar de tramo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { estado } = vi.hoisted(() => ({
  estado: { escrituras: [], perfiles: {}, usuario: null, alCambiarAuth: null,
            respuestas: [] },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  return {
    ...firestoreFalso(),
    doc: (_db, col, id) => ({ _col: col, id }),
    getDoc: async (ref) => {
      const d = estado.perfiles[ref.id];
      return { exists: () => d != null, data: () => d, id: ref.id };
    },
    setDoc: async (ref, datos) => {
      estado.escrituras.push({ ref, datos });
      estado.perfiles[ref.id] = { ...(estado.perfiles[ref.id] || {}), ...datos };
    },
    serverTimestamp: () => 'AHORA',
  };
});
vi.mock('firebase/auth', () => ({
  getAuth: () => ({ get currentUser() { return estado.usuario; } }),
  setPersistence: async () => {},
  browserLocalPersistence: 'local',
  onAuthStateChanged: (_a, cb) => { estado.alCambiarAuth = cb; return () => {}; },
  createUserWithEmailAndPassword: async (_a, email) => ({
    user: { uid: 'u-nuevo', email, displayName: null },
  }),
  signInWithEmailAndPassword: async (_a, email) => ({
    user: { uid: 'u1', email, displayName: 'Marta' },
  }),
  signInWithPopup: async () => ({ user: { uid: 'u1', email: 'm@x', displayName: 'Marta' } }),
  GoogleAuthProvider: class { setCustomParameters() {} },
  updateProfile: async () => {},
  sendPasswordResetEmail: async (_a, email) => {
    if (email.includes('no-existe')) {
      const e = new Error('x'); e.code = 'auth/user-not-found'; throw e;
    }
  },
  signOut: async () => { estado.usuario = null; },
}));
vi.mock('../src/firebase.js', () => ({ db: {}, app: {} }));

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  estado.escrituras.length = 0;
  estado.perfiles = {};
  estado.usuario = null;
  estado.respuestas = [];
  vi.resetModules();
});

describe('la cuenta', () => {
  const cargar = () => import('../src/cuenta.js');

  it('sin sesión no hay nada', async () => {
    const cuenta = await cargar();
    expect(cuenta.sesion()).toBeNull();
  });

  it('no descarga el SDK de quien nunca creó cuenta', async () => {
    // Alguien que compra como invitado no tiene por qué bajarse Auth entero.
    const cuenta = await cargar();
    await cuenta.iniciarCuenta();
    expect(estado.alCambiarAuth, 'no tendría que haberse enganchado').toBeNull();
  });

  it('con rastro de una sesión anterior sí lo arranca', async () => {
    localStorage.setItem('liceo.sesion', '1');
    const cuenta = await cargar();
    await cuenta.iniciarCuenta();
    expect(estado.alCambiarAuth).toBeTypeOf('function');
  });

  it('entrar deja la sesión activa al toque', async () => {
    // No se espera el aviso del SDK: ese llega un instante después, y en ese
    // instante guardar el perfil veía la sesión vacía y no guardaba nada.
    const cuenta = await cargar();
    const s = await cuenta.entrar({ email: 'marta@x.com', clave: 'secreta' });
    expect(s).toMatchObject({ uid: 'u1' });
    expect(cuenta.sesion()).toMatchObject({ uid: 'u1' });
  });

  it('al crear la cuenta se sube lo que ya había en este teléfono', async () => {
    // Quien compró como invitado y después se registra no tiene por qué volver
    // a cargar su dirección.
    const cliente = await import('../src/cliente.js');
    cliente.recordarDelPedido({ nombre: 'Marta Gómez', telefono: '3515550001',
                                direccion: 'Colón 1200' });

    const cuenta = await cargar();
    await cuenta.crearCuenta({ email: 'marta@x.com', clave: 'secreta' });

    const guardado = estado.escrituras.at(-1);
    expect(guardado.ref._col).toBe('tienda_clientes');
    expect(guardado.datos.nombre).toBe('Marta Gómez');
    expect(guardado.datos.direcciones[0].direccion).toBe('Colón 1200');
  });

  it('el perfil se guarda en el documento de quien está adentro', async () => {
    const cuenta = await cargar();
    await cuenta.entrar({ email: 'marta@x.com', clave: 'secreta' });
    await cuenta.guardarPerfil({ nombre: 'Marta', telefono: '351', direcciones: [] });
    expect(estado.escrituras.at(-1).ref.id).toBe('u1');
  });

  it('sin sesión no escribe nada y lo dice', async () => {
    const cuenta = await cargar();
    expect(await cuenta.guardarPerfil({ nombre: 'X', telefono: '1', direcciones: [] }))
      .toBe(false);
    expect(estado.escrituras).toHaveLength(0);
  });

  it('guarda como mucho cuatro direcciones', async () => {
    const cuenta = await cargar();
    await cuenta.entrar({ email: 'marta@x.com', clave: 'secreta' });
    await cuenta.guardarPerfil({
      nombre: 'Marta', telefono: '351',
      direcciones: Array.from({ length: 9 }, (_, i) => ({ direccion: `Calle ${i}` })),
    });
    expect(estado.escrituras.at(-1).datos.direcciones).toHaveLength(4);
  });

  it('si no se puede guardar el perfil, el pedido no se cae', async () => {
    // Se llama al confirmar: un pedido no puede fallar porque no se pudo
    // guardar una dirección.
    const mod = await import('firebase/firestore');
    const original = mod.setDoc;
    mod.setDoc = async () => { throw new Error('sin permiso'); };
    try {
      const cuenta = await cargar();
      await cuenta.entrar({ email: 'marta@x.com', clave: 'secreta' });
      await expect(cuenta.guardarPerfil({ nombre: 'M', telefono: '1', direcciones: [] }))
        .resolves.toBe(false);
    } finally {
      mod.setDoc = original;
    }
  });

  it('salir deja todo limpio y borra el rastro', async () => {
    const cuenta = await cargar();
    await cuenta.entrar({ email: 'marta@x.com', clave: 'secreta' });
    expect(localStorage.getItem('liceo.sesion')).toBe('1');

    await cuenta.salir();
    expect(cuenta.sesion()).toBeNull();
    expect(localStorage.getItem('liceo.sesion')).toBeNull();
    expect(cuenta.datosParaCompletar()).toBeNull();
  });

  it('recuperar la clave de un correo que no existe no delata que no existe', async () => {
    // Contestar "esa cuenta no existe" deja probar correos hasta encontrar uno.
    const cuenta = await cargar();
    await expect(cuenta.recuperarClave('no-existe@x.com')).resolves.toBeUndefined();
  });

  it('avisa a la pantalla cuando cambia la sesión', async () => {
    const cuenta = await cargar();
    const vistos = [];
    const soltar = cuenta.alCambiarSesion(s => vistos.push(s));
    expect(vistos[0]).toBeNull();          // el estado actual, al suscribirse

    await cuenta.entrar({ email: 'marta@x.com', clave: 'secreta' });
    expect(vistos.at(-1)).toMatchObject({ uid: 'u1' });
    soltar();
  });

  it('un suscriptor que revienta después no corta a los demás', async () => {
    // El primer llamado es sincrónico y en la pila de quien se suscribe: ahí el
    // error tiene que subir, que es su propio código. Los avisos posteriores no:
    // una pantalla rota no puede dejar a las otras sin enterarse del cambio.
    const cuenta = await cargar();
    const vistos = [];
    let primeraVez = true;
    const s1 = cuenta.alCambiarSesion(() => {
      if (primeraVez) { primeraVez = false; return; }
      throw new Error('roto');
    });
    const s2 = cuenta.alCambiarSesion(s => vistos.push(s));

    await cuenta.entrar({ email: 'marta@x.com', clave: 'secreta' });
    expect(vistos.at(-1)).toMatchObject({ uid: 'u1' });
    s1(); s2();
  });
});

describe('los datos para completar el checkout', () => {
  it('sin cuenta salen de este navegador', async () => {
    const cliente = await import('../src/cliente.js');
    cliente.recordarDelPedido({ nombre: 'Marta Gómez', telefono: '351',
                                direccion: 'Colón 1200' });
    const cuenta = await import('../src/cuenta.js');
    const d = cuenta.datosParaCompletar();
    expect(d.nombre).toBe('Marta Gómez');
    expect(d.deLaCuenta).toBe(false);
    expect(d.direcciones[0].direccion).toBe('Colón 1200');
  });

  it('con cuenta salen de la cuenta, que viaja entre teléfonos', async () => {
    estado.perfiles.u1 = { nombre: 'Marta de la cuenta', telefono: '3510000000',
                           direcciones: [{ direccion: 'Rivadavia 500' }] };
    const cuenta = await import('../src/cuenta.js');
    await cuenta.entrar({ email: 'marta@x.com', clave: 'secreta' });
    const d = cuenta.datosParaCompletar();
    expect(d.nombre).toBe('Marta de la cuenta');
    expect(d.deLaCuenta).toBe(true);
  });

  it('las dos formas tienen la misma forma', async () => {
    // Al checkout no le importa de dónde vinieron.
    const cliente = await import('../src/cliente.js');
    cliente.recordarDelPedido({ nombre: 'Marta', telefono: '351', direccion: 'Colón 1200' });
    const cuenta = await import('../src/cuenta.js');
    const sinCuenta = cuenta.datosParaCompletar();

    estado.perfiles.u1 = { nombre: 'Marta', telefono: '351', direcciones: [] };
    await cuenta.entrar({ email: 'marta@x.com', clave: 'secreta' });
    const conCuenta = cuenta.datosParaCompletar();

    expect(Object.keys(sinCuenta).sort()).toEqual(Object.keys(conCuenta).sort());
  });

  it('lo de un pedido confirmado se guarda en los dos lados', async () => {
    const cuenta = await import('../src/cuenta.js');
    const cliente = await import('../src/cliente.js');
    await cuenta.entrar({ email: 'marta@x.com', clave: 'secreta' });
    await cuenta.recordarDelPedido({ nombre: 'Marta Gómez', telefono: '3515550001',
                                     direccion: 'Colón 1200' });

    expect(cliente.perfil().nombre).toBe('Marta Gómez');       // este navegador
    expect(estado.escrituras.at(-1).datos.nombre).toBe('Marta Gómez');   // la cuenta
  });
});

describe('el campo de dirección', () => {
  /** Arma el campo con el desplegable colgado. */
  async function armar() {
    const { montarDirecciones } = await import('../src/direcciones.js');
    const caja = document.createElement('div');
    caja.className = 'campo';
    const input = document.createElement('input');
    input.id = 'direccion';
    caja.appendChild(input);
    document.body.appendChild(caja);

    const cambios = [];
    const soltar = montarDirecciones(input, c => cambios.push(c));
    return { input, cambios, soltar };
  }

  /** Deja respondiendo a la función de Netlify con lo que se le pase. */
  function responder(...respuestas) {
    let i = 0;
    globalThis.fetch = vi.fn(async () => {
      const r = respuestas[Math.min(i++, respuestas.length - 1)];
      return { ok: r.status ? r.status < 400 : true, status: r.status || 200,
               json: async () => r.cuerpo };
    });
  }

  /** Escribe y deja pasar el retardo con el que se consulta. */
  async function tipear(input, texto) {
    input.value = texto;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await esperar(400);
  }

  it('sin campo no rompe', async () => {
    const { montarDirecciones } = await import('../src/direcciones.js');
    expect(() => montarDirecciones(null, () => {})).not.toThrow();
  });

  it('con menos de tres letras no consulta nada', async () => {
    // Una consulta por tecla desde la primera letra se paga en cada búsqueda.
    responder({ cuerpo: { sugerencias: [] } });
    const { input } = await armar();
    await tipear(input, 'Co');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('agrupa las teclas en una sola consulta', async () => {
    responder({ cuerpo: { sugerencias: [] } });
    const { input } = await armar();
    input.value = 'Col';   input.dispatchEvent(new Event('input', { bubbles: true }));
    input.value = 'Coló';  input.dispatchEvent(new Event('input', { bubbles: true }));
    input.value = 'Colón'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await esperar(400);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('muestra las sugerencias que devuelve', async () => {
    responder({ cuerpo: { sugerencias: [
      { id: 'a', titulo: 'Colón 1200', detalle: 'Córdoba' },
      { id: 'b', titulo: 'Colón 1300', detalle: 'Córdoba' },
    ] } });
    const { input } = await armar();
    await tipear(input, 'Colón 12');
    const opciones = document.querySelectorAll('.direccion');
    expect(opciones).toHaveLength(2);
    expect(opciones[0].textContent).toContain('Colón 1200');
  });

  it('elegir una la resuelve con coordenadas', async () => {
    responder(
      { cuerpo: { sugerencias: [{ id: 'a', titulo: 'Colón 1200', detalle: 'Córdoba' }] } },
      { cuerpo: { direccion: 'Av. Colón 1200, Córdoba', lat: -31.41, lng: -64.18,
                  altura: true } },
    );
    const { input, cambios } = await armar();
    await tipear(input, 'Colón 12');
    document.querySelector('.direccion').click();
    await esperar(50);

    const ultimo = cambios.at(-1);
    expect(ultimo.estado).toBe('ubicada');
    expect(ultimo.lat).toBeCloseTo(-31.41);
    expect(input.value).toContain('Colón 1200');
  });

  it('una calle sin altura pide el número en vez de cobrar cualquier envío', async () => {
    // "Zorrilla de San Martín" son diez cuadras: el centro de la calle puede
    // caer en otro tramo y el cliente pagaría un envío que no eligió.
    responder(
      { cuerpo: { sugerencias: [{ id: 'a', titulo: 'Zorrilla de San Martín', detalle: 'Córdoba' }] } },
      { cuerpo: { direccion: 'Zorrilla de San Martín, Córdoba', lat: -31.4, lng: -64.2,
                  altura: false } },
    );
    const { input, cambios } = await armar();
    await tipear(input, 'Zorrilla');
    document.querySelector('.direccion').click();
    await esperar(50);

    expect(cambios.at(-1).estado).toBe('falta_altura');
    expect(document.activeElement).toBe(input);   // el cursor queda para seguir tipeando
  });

  it('sin la función desplegada se apaga y el campo queda como texto libre', async () => {
    // 503 es "no hay clave", 404 es "todavía no está desplegada". Seguir
    // preguntando en cada tecla no arregla ninguna de las dos.
    responder({ status: 503, cuerpo: {} });
    const { input, cambios } = await armar();
    await tipear(input, 'Colón 1200');
    expect(cambios.at(-1).estado).toBe('sin_servicio');

    globalThis.fetch.mockClear();
    await tipear(input, 'Colón 1300');
    expect(globalThis.fetch, 'ya no tiene que preguntar más').not.toHaveBeenCalled();
  });

  it('una respuesta que llega tarde no pisa la lista nueva', async () => {
    // El cliente siguió escribiendo: pintar la vieja le cambia la lista debajo
    // del dedo.
    let resolverPrimera;
    let llamada = 0;
    globalThis.fetch = vi.fn(() => {
      llamada++;
      if (llamada === 1) {
        return new Promise(r => { resolverPrimera = () => r({
          ok: true, status: 200,
          json: async () => ({ sugerencias: [{ id: 'viejo', titulo: 'VIEJA' }] }),
        }); });
      }
      return Promise.resolve({ ok: true, status: 200,
        json: async () => ({ sugerencias: [{ id: 'nuevo', titulo: 'NUEVA' }] }) });
    });

    const { input } = await armar();
    await tipear(input, 'Colón 12');
    await tipear(input, 'Colón 1300');
    resolverPrimera();
    await esperar(50);

    expect(document.querySelector('.direcciones__lista').textContent).toContain('NUEVA');
    expect(document.querySelector('.direcciones__lista').textContent).not.toContain('VIEJA');
  });

  it('si la consulta falla, el desplegable se cierra sin romper nada', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('sin red')));
    const { input } = await armar();
    await tipear(input, 'Colón 1200');
    expect(document.querySelector('.direcciones__lista').hidden).toBe(true);
  });

  it('el nombre de una calle no se cuela como HTML', async () => {
    responder({ cuerpo: { sugerencias: [
      { id: 'a', titulo: '<img src=x onerror=alert(1)>', detalle: 'Córdoba' },
    ] } });
    const { input } = await armar();
    await tipear(input, 'Colón 12');
    expect(document.querySelector('.direcciones__lista img')).toBeNull();
  });
});
