import { login } from '../auth.js';

export function renderLogin(onSuccess) {
  // Ocultar app shell completo
  document.getElementById('app').style.display = 'none';
  const bottomNav = document.getElementById('bottomNav');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  if (bottomNav) bottomNav.style.display = 'none';
  if (sidebarOverlay) sidebarOverlay.style.display = 'none';

  // Crear página de login
  const page = document.createElement('div');
  page.id = 'loginPage';
  page.className = 'login-page';
  page.innerHTML = `
    <div class="login-card">
      <div class="login-logo">
        <div class="login-libreria">Librería</div>
        <div class="login-tiles">
          <div class="login-tile"><span>L</span></div>
          <div class="login-tile"><span>I</span></div>
          <div class="login-tile"><span>C</span></div>
          <div class="login-tile"><span>E</span></div>
          <div class="login-tile"><span>O</span></div>
        </div>
        <div class="login-tagline">
          <span>Librería</span><span class="dot"></span>
          <span>Mercería</span><span class="dot"></span>
          <span>Regalería</span>
        </div>
      </div>

      <form class="login-form" id="loginForm" autocomplete="off">
        <div class="form-group">
          <label>Usuario</label>
          <div class="input-wrap">
            <span class="material-icons">person</span>
            <input type="text" id="loginUser" placeholder="Ingresá tu usuario" autocomplete="username" required />
          </div>
        </div>

        <div class="form-group">
          <label>Contraseña</label>
          <div class="input-wrap">
            <span class="material-icons">lock</span>
            <input type="password" id="loginPass" placeholder="Ingresá tu contraseña" autocomplete="current-password" required />
          </div>
        </div>

        <div class="login-error" id="loginError">
          <span class="material-icons" style="font-size:16px!important">error_outline</span>
          <span id="loginErrorMsg">Usuario o contraseña incorrectos</span>
        </div>

        <button type="submit" class="btn-login" id="loginBtn">
          <span class="material-icons" style="font-size:18px!important">login</span>
          Ingresar
        </button>
      </form>

      <div class="login-footer">
        Sistema POS v2.0
      </div>
    </div>
  `;

  document.body.appendChild(page);

  // Idle wiggle: cada ~4.5s, una tile al azar hace un saltito
  const wiggleInterval = setInterval(() => {
    const tiles = page.querySelectorAll('.login-tile');
    if (!tiles.length) return;
    const t = tiles[Math.floor(Math.random() * tiles.length)];
    t.classList.remove('wiggle');
    void t.offsetWidth; // force reflow to restart animation
    t.classList.add('wiggle');
    setTimeout(() => t.classList.remove('wiggle'), 1000);
  }, 4500);

  // Focus automático
  setTimeout(() => document.getElementById('loginUser').focus(), 100);

  // Submit
  document.getElementById('loginForm').addEventListener('submit', e => {
    e.preventDefault();
    const username = document.getElementById('loginUser').value.trim();
    const password = document.getElementById('loginPass').value;
    const btn      = document.getElementById('loginBtn');
    const errDiv   = document.getElementById('loginError');

    // Loading state
    btn.disabled = true;
    btn.innerHTML = `<div class="spinner" style="width:18px;height:18px;border-width:2px;border-color:rgba(255,255,255,0.3);border-top-color:#fff"></div> Verificando...`;

    setTimeout(() => {
      const session = login(username, password);
      if (session) {
        errDiv.classList.remove('show');
        btn.innerHTML = `<span class="material-icons" style="font-size:18px!important">check_circle</span> Bienvenido, ${session.display}!`;
        btn.style.background = '#2e7d32';
        setTimeout(() => {
          clearInterval(wiggleInterval);
          page.remove();
          document.getElementById('app').style.display = 'flex';
          const bn = document.getElementById('bottomNav');
          if (bn) bn.classList.add('visible');
          onSuccess(session);
        }, 600);
      } else {
        errDiv.classList.add('show');
        document.getElementById('loginErrorMsg').textContent = 'Usuario o contraseña incorrectos';
        btn.disabled = false;
        btn.innerHTML = `<span class="material-icons" style="font-size:18px!important">login</span> Ingresar`;
        document.getElementById('loginPass').value = '';
        document.getElementById('loginPass').focus();
        // Shake animation
        const card = page.querySelector('.login-card');
        card.style.animation = 'none';
        card.offsetHeight;
        card.style.animation = 'shake 0.4s ease';
      }
    }, 500);
  });
}
