// @vitest-environment jsdom
/**
 * Quién puede entrar al panel.
 *
 * Es la frontera de seguridad del sistema. Con login por Google cualquiera con
 * una cuenta de Google puede autenticarse, así que "estar logueado" no otorga
 * nada: el acceso depende de un claim (`admin` o `staff`) que sólo se setea con
 * el Admin SDK desde `scripts/auth_admin.py`.
 *
 * Lo que se prueba acá es exactamente eso: que una cuenta válida SIN claim no
 * entre, y que además se le cierre la sesión para que no quede una sesión
 * fantasma generando errores contra Firestore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { estado } = vi.hoisted(() => ({
  estado: { usuario: null, claims: {}, alCambiar: null, salidas: 0, tokenFalla: false },
}));

vi.mock('firebase/auth', () => ({
  getAuth: () => ({ get currentUser() { return estado.usuario; } }),
  setPersistence: async () => {},
  browserLocalPersistence: 'local',
  GoogleAuthProvider: class { setCustomParameters() {} },
  signInWithPopup: async () => ({ user: estado.usuario }),
  sendSignInLinkToEmail: async () => {},
  isSignInWithEmailLink: () => false,
  signInWithEmailLink: async () => ({ user: estado.usuario }),
  signOut: async () => { estado.salidas++; estado.usuario = null; },
  onAuthStateChanged: (_auth, cb) => { estado.alCambiar = cb; return () => {}; },
}));
vi.mock('../../webapp/src/firebase.js', () => ({ app: {}, db: {} }));

const auth = await import('../../webapp/src/auth.js');

/** Un usuario de Google, con los claims que le hayan puesto. */
function usuario(claims = {}, email = 'mari@liceo.com') {
  return {
    uid: 'u1', email, displayName: 'Mari', photoURL: null,
    getIdTokenResult: async () => {
      if (estado.tokenFalla) throw new Error('sin red');
      return { claims };
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  estado.salidas = 0;
  estado.tokenFalla = false;
  estado.usuario = null;
});

describe('el claim decide, no la cuenta', () => {
  it('un admin entra como admin', async () => {
    estado.usuario = usuario({ admin: true });
    const r = await auth.loginWithGoogle();
    expect(r.ok).toBe(true);
    expect(r.session).toMatchObject({ uid: 'u1', email: 'mari@liceo.com', role: 'admin' });
  });

  it('alguien de mostrador entra como staff', async () => {
    estado.usuario = usuario({ staff: true });
    const r = await auth.loginWithGoogle();
    expect(r.ok).toBe(true);
    expect(r.session.role).toBe('staff');
  });

  it('una cuenta de Google válida SIN claim no entra', async () => {
    // Es el caso importante: la autenticación salió bien y la autorización no.
    estado.usuario = usuario({});
    const r = await auth.loginWithGoogle();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no tiene acceso');
  });

  it('y además se le cierra la sesión, incluso la que ya había', async () => {
    // El caso real: Mari está adentro y alguien entra con otra cuenta que no
    // tiene permiso. Sin cortar la sesión vieja en el momento, `getSession()`
    // seguía devolviendo la de Mari hasta que Firebase avisara por su cuenta.
    estado.usuario = usuario({ admin: true }, 'mari@liceo.com');
    await auth.loginWithGoogle();
    expect(auth.isLoggedIn()).toBe(true);

    estado.salidas = 0;
    estado.usuario = usuario({}, 'ajeno@gmail.com');
    const r = await auth.loginWithGoogle();

    expect(r.ok).toBe(false);
    expect(estado.salidas).toBe(1);
    expect(auth.isLoggedIn()).toBe(false);
    expect(auth.getSession()).toBeNull();
    expect(auth.hasSessionHint()).toBe(false);
  });

  it('un claim que no es ninguno de los dos tampoco sirve', async () => {
    estado.usuario = usuario({ editor: true });
    expect((await auth.loginWithGoogle()).ok).toBe(false);
  });
});

describe('la pista de sesión', () => {
  it('se guarda al entrar y se borra al salir', async () => {
    estado.usuario = usuario({ admin: true });
    await auth.loginWithGoogle();
    expect(auth.hasSessionHint()).toBe(true);

    await auth.logout();
    expect(auth.hasSessionHint()).toBe(false);
    expect(auth.getSession()).toBeNull();
  });

  it('no se guarda para el que no tiene permiso', async () => {
    estado.usuario = usuario({});
    await auth.loginWithGoogle();
    expect(auth.hasSessionHint()).toBe(false);
  });

  it('es sólo una pista de la interfaz: no otorga nada', () => {
    // Falsificarla muestra un shell vacío que Firestore rechaza. Quien manda
    // es el token, no esto.
    localStorage.setItem('pos_auth_hint', 'inventado');
    expect(auth.hasSessionHint()).toBe(true);
    expect(auth.getSession()).toBeNull();
  });
});

describe('lo que pasa cuando Firebase avisa por su cuenta', () => {
  it('un usuario autorizado queda como sesión activa', async () => {
    estado.usuario = usuario({ staff: true });
    await estado.alCambiar(estado.usuario);
    expect(auth.getSession()).toMatchObject({ role: 'staff' });
  });

  it('uno sin permiso se va, aunque Firebase lo dé por válido', async () => {
    estado.usuario = usuario({});
    await estado.alCambiar(estado.usuario);
    expect(auth.getSession()).toBeNull();
    expect(estado.salidas).toBeGreaterThan(0);
  });

  it('si no se pueden leer los claims, no se asume que puede entrar', async () => {
    // Ante la duda, afuera: es la mitad segura del error.
    estado.tokenFalla = true;
    estado.usuario = usuario({ admin: true });
    await estado.alCambiar(estado.usuario);
    expect(auth.getSession()).toBeNull();
  });

  it('sin usuario no hay sesión y no se intenta cerrar nada', async () => {
    estado.salidas = 0;
    await estado.alCambiar(null);
    expect(auth.getSession()).toBeNull();
    expect(estado.salidas).toBe(0);
  });
});

describe('los errores que se le muestran a la persona', () => {
  it('cerrar la ventana de Google no se muestra como un error del sistema', async () => {
    const mod = await import('firebase/auth');
    const original = mod.signInWithPopup;
    mod.signInWithPopup = async () => {
      const e = new Error('x'); e.code = 'auth/popup-closed-by-user'; throw e;
    };
    try {
      const r = await auth.loginWithGoogle();
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/cerraste la ventana/i);
    } finally {
      mod.signInWithPopup = original;
    }
  });

  it('el dominio sin autorizar se dice con todas las letras', async () => {
    // Es el error que aparece al estrenar un dominio nuevo y el que más
    // tiempo hace perder si el mensaje es genérico.
    const mod = await import('firebase/auth');
    const original = mod.signInWithPopup;
    mod.signInWithPopup = async () => {
      const e = new Error('x'); e.code = 'auth/unauthorized-domain'; throw e;
    };
    try {
      expect((await auth.loginWithGoogle()).error).toMatch(/dominio no está autorizado/i);
    } finally {
      mod.signInWithPopup = original;
    }
  });
});
