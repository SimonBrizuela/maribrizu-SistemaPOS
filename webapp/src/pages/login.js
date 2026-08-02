import { loginWithGoogle, sendLoginLink } from '../auth.js';

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

      <div class="login-form">
        <button type="button" class="btn-google" id="googleBtn">
          <svg class="google-mark" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2.1 5-4.4 6.6v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.1z"/>
            <path fill="#34A853" d="M24 46c6 0 11-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.6-3.9-12.3-9.1H4.4v5.7C7.9 40.8 15.4 46 24 46z"/>
            <path fill="#FBBC05" d="M11.7 28.1c-.4-1.3-.7-2.7-.7-4.1s.2-2.8.7-4.1v-5.7H4.4C2.9 17.1 2 20.4 2 24s.9 6.9 2.4 9.8l7.3-5.7z"/>
            <path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 30 2 24 2 15.4 2 7.9 7.2 4.4 14.2l7.3 5.7c1.7-5.2 6.6-9.1 12.3-9.1z"/>
          </svg>
          Continuar con Google
        </button>

        <div class="login-sep"><span>o</span></div>

        <form id="linkForm" autocomplete="on">
          <div class="form-group">
            <label>Recibir un enlace por correo</label>
            <div class="input-wrap">
              <span class="material-icons">mail_outline</span>
              <input type="email" id="loginEmail" placeholder="tucorreo@ejemplo.com" autocomplete="email" required />
            </div>
          </div>

          <button type="submit" class="btn-login" id="linkBtn">
            <span class="material-icons" style="font-size:18px!important">send</span>
            Enviarme el enlace
          </button>
        </form>

        <div class="login-error" id="loginError">
          <span class="material-icons" style="font-size:16px!important">error_outline</span>
          <span id="loginErrorMsg"></span>
        </div>

        <div class="login-ok" id="loginOk">
          <span class="material-icons" style="font-size:16px!important">mark_email_read</span>
          <span id="loginOkMsg"></span>
        </div>
      </div>

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

  const errDiv = document.getElementById('loginError');
  const errMsg = document.getElementById('loginErrorMsg');
  const okDiv  = document.getElementById('loginOk');
  const okMsg  = document.getElementById('loginOkMsg');

  function showError(msg) {
    okDiv.classList.remove('show');
    errMsg.textContent = msg;
    errDiv.classList.add('show');
    const card = page.querySelector('.login-card');
    card.style.animation = 'none';
    card.offsetHeight;
    card.style.animation = 'shake 0.4s ease';
  }

  function enter(session) {
    clearInterval(wiggleInterval);
    page.remove();
    document.getElementById('app').style.display = 'flex';
    const bn = document.getElementById('bottomNav');
    if (bn) bn.classList.add('visible');
    onSuccess(session);
  }

  // ── Google ──
  document.getElementById('googleBtn').addEventListener('click', async () => {
    const btn = document.getElementById('googleBtn');
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = `<div class="spinner" style="width:18px;height:18px;border-width:2px"></div> Conectando...`;

    const res = await loginWithGoogle();

    if (res.ok) {
      errDiv.classList.remove('show');
      btn.innerHTML = `<span class="material-icons" style="font-size:18px!important">check_circle</span> Hola, ${res.session.display}!`;
      setTimeout(() => enter(res.session), 600);
    } else {
      showError(res.error);
      btn.disabled = false;
      btn.innerHTML = original;
    }
  });

  // ── Enlace por correo ──
  document.getElementById('linkForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const btn   = document.getElementById('linkBtn');

    btn.disabled = true;
    btn.innerHTML = `<div class="spinner" style="width:18px;height:18px;border-width:2px;border-color:rgba(255,255,255,0.3);border-top-color:#fff"></div> Enviando...`;

    const res = await sendLoginLink(email);

    if (res.ok) {
      errDiv.classList.remove('show');
      okMsg.textContent = `Te enviamos un enlace a ${email}. Abrilo desde este dispositivo.`;
      okDiv.classList.add('show');
      btn.innerHTML = `<span class="material-icons" style="font-size:18px!important">check_circle</span> Enlace enviado`;
    } else {
      showError(res.error);
      btn.disabled = false;
      btn.innerHTML = `<span class="material-icons" style="font-size:18px!important">send</span> Enviarme el enlace`;
    }
  });
}
