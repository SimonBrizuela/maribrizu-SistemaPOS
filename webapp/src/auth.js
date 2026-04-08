/**
 * Sistema de autenticación simple para la webapp POS.
 * Usuarios definidos localmente (no requiere backend).
 * Las credenciales pueden cambiarse aquí o en el futuro
 * conectarse a Firebase Auth.
 */

const USERS = [
  { username: 'Admin', password: 'Admin', role: 'admin', display: 'Administrador' },
  // Agregar más usuarios aquí si se necesita:
  // { username: 'vendedor', password: '1234', role: 'viewer', display: 'Vendedor' },
];

const SESSION_KEY = 'pos_session';
const SESSION_DURATION = 8 * 60 * 60 * 1000; // 8 horas

export function login(username, password) {
  const user = USERS.find(
    u => u.username.toLowerCase() === username.toLowerCase() &&
         u.password === password
  );
  if (!user) return null;

  const session = {
    username: user.username,
    display:  user.display,
    role:     user.role,
    expires:  Date.now() + SESSION_DURATION,
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function logout() {
  sessionStorage.removeItem(SESSION_KEY);
}

export function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (Date.now() > session.expires) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function isLoggedIn() {
  return getSession() !== null;
}
