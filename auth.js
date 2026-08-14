/* =====================================================================
   auth.js — Sistema de cuentas para Herbario PAES
   =====================================================================
   Qué hace:
   - Botones "Iniciar sesión" / "Registrarse" en la esquina superior derecha.
   - Registro con usuario, correo (para recuperación) y contraseña (mín. 8
     caracteres, 1 mayúscula, 1 carácter especial, escrita dos veces).
   - Login con usuario O correo + contraseña. Mensaje genérico si algo
     no coincide (no revela si el usuario existe o no).
   - Recuperar contraseña por correo, con confirmación y nueva contraseña
     escrita dos veces (mismas reglas que el registro).
   - Todo el progreso de la app (app.js) queda ligado a la cuenta con la
     sesión iniciada. Sin sesión iniciada, el progreso NO se guarda y se
     reinicia cada vez que se abre la página (pedido explícito).

   CÓMO FUNCIONA TÉCNICAMENTE (importante, léelo antes de tocar el resto):
   Esta página es un archivo HTML/JS autocontenido, sin servidor propio.
   No existe backend, así que:

   1) No es posible enviar un correo real desde JavaScript de navegador
      sin un servicio externo. Por defecto (EMAIL_CONFIG.enabled = false)
      el paso de "enviar correo" se SIMULA dentro de la misma página: se
      muestra un panel con pinta de correo y un botón "Confirmar", en vez
      de un envío real. Queda claramente rotulado como simulado.

      Si en algún momento quieres correos reales, puedes conectar EmailJS
      (servicio gratuito pensado justo para esto: enviar correo desde
      JS sin backend). Pasos:
        a) Crea una cuenta gratis en https://www.emailjs.com
        b) Conecta un servicio de correo (por ej. tu Gmail) → te da un
           "Service ID".
        c) Crea una plantilla de correo con las variables {{to_email}} y
           {{reset_link}} → te da un "Template ID".
        d) Copia tu "Public Key" desde Account → General.
        e) Agrega ANTES de este script, en index.html:
           <script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"></script>
        f) Completa los 3 valores en EMAIL_CONFIG más abajo y cambia
           enabled a true.
      Si EmailJS falla al enviar (o no lo configuras), el código vuelve
      solo al modo simulado, así que nunca se rompe el flujo.

   2) Las "cuentas" viven en el localStorage de ESTE navegador, igual que
      el progreso ya vivía antes. Iniciar sesión en un navegador o
      computador distinto NO trae tu cuenta ni tu progreso: no hay
      sincronización entre dispositivos, porque no hay servidor. Lo que
      sí gana la cuenta es: progreso que no se pierde al recargar, y que
      varias personas puedan usar el mismo navegador sin mezclar su
      avance.

   3) app.js sigue usando localStorage.getItem/setItem exactamente igual
      que antes (STORAGE_KEY, NOTES_KEY): no se tocó su lógica. Lo que
      hace este archivo es reemplazar window.localStorage por una capa
      propia que, según haya o no sesión iniciada, guarda esas mismas
      llaves de verdad (ligadas a la cuenta) o solo en memoria (que se
      pierde al recargar, para invitados). Por eso este script se carga
      ANTES que app.js en index.html: la capa debe estar lista antes de
      que app.js lea nada.

   4) La primera vez que alguien se registra, si había progreso guardado
      de antes (de cuando no existían las cuentas), se copia automática-
      mente a esa primera cuenta para no perderlo. Solo ocurre una vez.

   5) Las contraseñas se guardan como hash SHA-256 (con sal por usuario),
      nunca en texto plano. Aun así, como todo esto vive en el navegador
      sin servidor, no es un sistema de seguridad "real" (cualquiera con
      las herramientas de desarrollador podría inspeccionar el
      localStorage) — pensado para uso personal, no para contraseñas
      importantes de verdad.
   ===================================================================== */
(function () {

  // ---------------------------------------------------------------------
  // Config EmailJS (opcional) — ver instrucciones completas arriba
  // ---------------------------------------------------------------------
  const EMAIL_CONFIG = {
    enabled: false,
    serviceId: 'TU_SERVICE_ID',
    templateId: 'TU_TEMPLATE_ID',
    publicKey: 'TU_PUBLIC_KEY'
  };
  if (EMAIL_CONFIG.enabled && window.emailjs) {
    window.emailjs.init({ publicKey: EMAIL_CONFIG.publicKey });
  }

  // ---------------------------------------------------------------------
  // Referencia real a localStorage, ANTES de reemplazarla más abajo.
  // Todo lo de este bloque (cuentas, sesión, tokens) usa SIEMPRE esta
  // referencia real, nunca la capa que se instala después.
  // ---------------------------------------------------------------------
  const REAL_LS = window.localStorage;

  const SYS_USERS = '__authSys_users';
  const SYS_SESSION = '__authSys_session';
  const SYS_RESET = '__authSys_resetTokens';
  const SYS_MIGRATED = '__authSys_migratedV1';
  const DATA_PREFIX = '__authData_';
  const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutos

  // ---------------------------------------------------------------------
  // Capa de almacenamiento: cuenta activa → localStorage real (persiste);
  // invitado (sin sesión) → memoria (se pierde al recargar la página).
  // app.js sigue llamando a localStorage.getItem/setItem tal cual, sin
  // saber que esta capa existe.
  // ---------------------------------------------------------------------
  let guestMemory = Object.create(null);

  function currentAccountKey() {
    try { return REAL_LS.getItem(SYS_SESSION); } catch (e) { return null; }
  }

  function accountDataKeys() {
    const user = currentAccountKey();
    if (!user) return null;
    const prefix = DATA_PREFIX + user + '__';
    const keys = [];
    for (let i = 0; i < REAL_LS.length; i++) {
      const k = REAL_LS.key(i);
      if (k && k.indexOf(prefix) === 0) keys.push(k);
    }
    return { prefix, keys };
  }

  const storageShim = {
    getItem(key) {
      const user = currentAccountKey();
      if (user) return REAL_LS.getItem(DATA_PREFIX + user + '__' + key);
      return Object.prototype.hasOwnProperty.call(guestMemory, key) ? guestMemory[key] : null;
    },
    setItem(key, value) {
      const user = currentAccountKey();
      if (user) REAL_LS.setItem(DATA_PREFIX + user + '__' + key, String(value));
      else guestMemory[key] = String(value);
    },
    removeItem(key) {
      const user = currentAccountKey();
      if (user) REAL_LS.removeItem(DATA_PREFIX + user + '__' + key);
      else delete guestMemory[key];
    },
    clear() {
      const info = accountDataKeys();
      if (info) info.keys.forEach(k => REAL_LS.removeItem(k));
      else guestMemory = Object.create(null);
    },
    key(i) {
      const info = accountDataKeys();
      if (info) {
        const short = info.keys.map(k => k.slice(info.prefix.length));
        return short[i] !== undefined ? short[i] : null;
      }
      const gKeys = Object.keys(guestMemory);
      return gKeys[i] !== undefined ? gKeys[i] : null;
    },
    get length() {
      const info = accountDataKeys();
      if (info) return info.keys.length;
      return Object.keys(guestMemory).length;
    }
  };

  try {
    Object.defineProperty(window, 'localStorage', {
      value: storageShim, configurable: true, enumerable: true, writable: false
    });
  } catch (e) {
    console.warn('No se pudo instalar el sistema de cuentas sobre localStorage:', e);
  }

  // ---------------------------------------------------------------------
  // Utilidades: escape HTML, hash de contraseña, ids al azar
  // ---------------------------------------------------------------------
  function escHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function randomHex(bytes) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.prototype.map.call(arr, b => b.toString(16).padStart(2, '0')).join('');
  }
  function hashPassword(password, salt) {
    const data = new TextEncoder().encode(salt + ':' + password);
    return crypto.subtle.digest('SHA-256', data).then(buf =>
      Array.prototype.map.call(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
    );
  }

  // ---------------------------------------------------------------------
  // Datos del sistema (usuarios, sesión, tokens de recuperación)
  // ---------------------------------------------------------------------
  function getUsers() {
    try { const raw = REAL_LS.getItem(SYS_USERS); return raw ? JSON.parse(raw) : []; }
    catch (e) { return []; }
  }
  function saveUsers(users) { REAL_LS.setItem(SYS_USERS, JSON.stringify(users)); }
  function getResetTokens() {
    try { const raw = REAL_LS.getItem(SYS_RESET); return raw ? JSON.parse(raw) : {}; }
    catch (e) { return {}; }
  }
  function saveResetTokens(tokens) { REAL_LS.setItem(SYS_RESET, JSON.stringify(tokens)); }
  function getSession() { return REAL_LS.getItem(SYS_SESSION); }
  function setSession(usernameLower) {
    if (usernameLower) REAL_LS.setItem(SYS_SESSION, usernameLower);
    else REAL_LS.removeItem(SYS_SESSION);
  }
  function findUserByUsername(usernameLower) {
    return getUsers().find(u => u.usernameLower === usernameLower) || null;
  }
  function findUserByEmail(emailLower) {
    return getUsers().find(u => u.emailLower === emailLower) || null;
  }
  function findUserByUsernameOrEmail(idLower) {
    return getUsers().find(u => u.usernameLower === idLower || u.emailLower === idLower) || null;
  }

  // Copia, una sola vez, el progreso/notas que hubiera de antes de que
  // existieran las cuentas hacia la primera cuenta que se cree. No borra
  // las llaves viejas, solo deja de usarlas. Devuelve true si recuperó algo.
  function migrateLegacyDataIfNeeded(usernameLower) {
    if (REAL_LS.getItem(SYS_MIGRATED)) return false;
    const legacyKeys = [];
    for (let i = 0; i < REAL_LS.length; i++) {
      const k = REAL_LS.key(i);
      if (k && k.indexOf(DATA_PREFIX) !== 0 && k.indexOf('__authSys_') !== 0) legacyKeys.push(k);
    }
    legacyKeys.forEach(k => {
      REAL_LS.setItem(DATA_PREFIX + usernameLower + '__' + k, REAL_LS.getItem(k));
    });
    REAL_LS.setItem(SYS_MIGRATED, '1');
    return legacyKeys.length > 0;
  }

  // ---------------------------------------------------------------------
  // Validación
  // ---------------------------------------------------------------------
  const PASSWORD_RULES = [
    { test: p => p.length >= 8, label: 'Al menos 8 caracteres' },
    { test: p => /[A-Z]/.test(p), label: 'Al menos una letra mayúscula' },
    { test: p => /[^A-Za-z0-9]/.test(p), label: 'Al menos un carácter especial' }
  ];
  function passwordMeetsRules(p) { return PASSWORD_RULES.every(r => r.test(p)); }
  function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
  function pwRulesListHtml(idPrefix) {
    return PASSWORD_RULES.map((r, i) => `<li id="${idPrefix}${i}">${escHtml(r.label)}</li>`).join('');
  }

  // ---------------------------------------------------------------------
  // Estado del modal
  // ---------------------------------------------------------------------
  let modalScreen = null;
  let modalContext = {};

  function openModalOverlay() {
    const ov = document.getElementById('authModalOverlay');
    if (ov) ov.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    const ov = document.getElementById('authModalOverlay');
    if (ov) ov.classList.add('hidden');
    document.body.style.overflow = '';
    modalScreen = null;
  }
  function overlayClick() { closeModal(); }

  function focusFirstField(box) {
    const el = box.querySelector('input');
    if (el) setTimeout(() => el.focus(), 30);
  }

  function openRegister(evt) { if (evt) evt.preventDefault(); modalScreen = 'register'; openModalOverlay(); renderModal(); }
  function openLogin(evt) { if (evt) evt.preventDefault(); modalScreen = 'login'; openModalOverlay(); renderModal(); }
  function openForgot(evt) { if (evt) evt.preventDefault(); modalScreen = 'forgot'; openModalOverlay(); renderModal(); }

  function openResetScreen(token) {
    const entry = getResetTokens()[token];
    openModalOverlay();
    const box = document.getElementById('authModalBox');
    if (!entry || entry.expiresAt < Date.now()) {
      box.innerHTML = `
        <button class="modal-close" onclick="AuthUI.closeModal()" aria-label="Cerrar">✕</button>
        <h3 class="modal-title">Enlace no válido</h3>
        <p class="modal-sub">Este enlace de recuperación ya no es válido o expiró (dura 30 minutos). Solicita uno nuevo.</p>
        <p class="modal-switch"><a href="#" onclick="AuthUI.openForgot(event)">Solicitar de nuevo</a></p>
      `;
      return;
    }
    modalContext = { resetToken: token, resetUsernameLower: entry.usernameLower };
    modalScreen = 'reset';
    renderModal();
  }

  // ---------------------------------------------------------------------
  // Render de cada pantalla del modal
  // ---------------------------------------------------------------------
  function renderModal() {
    const box = document.getElementById('authModalBox');
    if (!box) return;
    if (modalScreen === 'register') box.innerHTML = registerScreenHtml();
    else if (modalScreen === 'login') box.innerHTML = loginScreenHtml();
    else if (modalScreen === 'forgot') box.innerHTML = forgotScreenHtml();
    else if (modalScreen === 'reset') box.innerHTML = resetScreenHtml();
    else return;
    focusFirstField(box);
  }

  function registerScreenHtml() {
    return `
      <button class="modal-close" onclick="AuthUI.closeModal()" aria-label="Cerrar">✕</button>
      <h3 class="modal-title">Crear cuenta</h3>
      <p class="modal-sub">Para que tu progreso se guarde y no se reinicie.</p>
      <form onsubmit="AuthUI.submitRegister(event)">
        <label class="field-label" for="regUsername">Usuario</label>
        <input class="field-input" id="regUsername" type="text" autocomplete="username" required>

        <label class="field-label" for="regEmail">Correo (por si necesitas recuperar la cuenta)</label>
        <input class="field-input" id="regEmail" type="email" autocomplete="email" required>

        <label class="field-label" for="regPassword">Contraseña</label>
        <input class="field-input" id="regPassword" type="password" autocomplete="new-password" oninput="AuthUI.onPasswordInput('reg')" required>
        <ul class="pw-rules">${pwRulesListHtml('regRule')}</ul>

        <label class="field-label" for="regPassword2">Confirmar contraseña</label>
        <input class="field-input" id="regPassword2" type="password" autocomplete="new-password" oninput="AuthUI.onPasswordInput('reg')" required>
        <p class="field-hint" id="regMatchHint"></p>

        <p class="form-error" id="regError"></p>
        <button type="submit" class="btn btn-primary modal-submit">Crear cuenta</button>
      </form>
      <p class="modal-switch">¿Ya tienes cuenta? <a href="#" onclick="AuthUI.openLogin(event)">Inicia sesión</a></p>
    `;
  }

  function loginScreenHtml() {
    return `
      <button class="modal-close" onclick="AuthUI.closeModal()" aria-label="Cerrar">✕</button>
      <h3 class="modal-title">Iniciar sesión</h3>
      <form onsubmit="AuthUI.submitLogin(event)">
        <label class="field-label" for="loginId">Usuario o correo</label>
        <input class="field-input" id="loginId" type="text" autocomplete="username" required>

        <label class="field-label" for="loginPassword">Contraseña</label>
        <input class="field-input" id="loginPassword" type="password" autocomplete="current-password" required>

        <p class="form-error" id="loginError"></p>
        <button type="submit" class="btn btn-primary modal-submit">Entrar</button>
      </form>
      <p class="modal-switch"><a href="#" onclick="AuthUI.openForgot(event)">¿Olvidaste tu contraseña?</a></p>
      <p class="modal-switch">¿No tienes cuenta? <a href="#" onclick="AuthUI.openRegister(event)">Regístrate</a></p>
    `;
  }

  function forgotScreenHtml() {
    return `
      <button class="modal-close" onclick="AuthUI.closeModal()" aria-label="Cerrar">✕</button>
      <h3 class="modal-title">Recuperar contraseña</h3>
      <p class="modal-sub">Escribe el correo con el que te registraste.</p>
      <form onsubmit="AuthUI.submitForgot(event)">
        <label class="field-label" for="forgotEmail">Correo electrónico</label>
        <input class="field-input" id="forgotEmail" type="email" autocomplete="email" required>
        <p class="form-error" id="forgotError"></p>
        <button type="submit" class="btn btn-primary modal-submit">Enviar</button>
      </form>
      <p class="modal-switch"><a href="#" onclick="AuthUI.openLogin(event)">← Volver a iniciar sesión</a></p>
    `;
  }

  function resetScreenHtml() {
    return `
      <button class="modal-close" onclick="AuthUI.closeModal()" aria-label="Cerrar">✕</button>
      <h3 class="modal-title">Nueva contraseña</h3>
      <form onsubmit="AuthUI.submitReset(event)">
        <label class="field-label" for="resetPassword">Nueva contraseña</label>
        <input class="field-input" id="resetPassword" type="password" autocomplete="new-password" oninput="AuthUI.onPasswordInput('reset')" required>
        <ul class="pw-rules">${pwRulesListHtml('resetRule')}</ul>

        <label class="field-label" for="resetPassword2">Confirmar nueva contraseña</label>
        <input class="field-input" id="resetPassword2" type="password" autocomplete="new-password" oninput="AuthUI.onPasswordInput('reset')" required>
        <p class="field-hint" id="resetMatchHint"></p>

        <p class="form-error" id="resetError"></p>
        <button type="submit" class="btn btn-primary modal-submit">Cambiar contraseña</button>
      </form>
    `;
  }

  function showModalSuccess(msg) {
    const box = document.getElementById('authModalBox');
    if (box) box.innerHTML = `<div class="modal-success"><div class="big-check">✓</div><p>${escHtml(msg)}</p></div>`;
  }

  function renderSimulatedEmailScreen(email, token) {
    modalContext.pendingToken = token;
    const box = document.getElementById('authModalBox');
    box.innerHTML = `
      <button class="modal-close" onclick="AuthUI.closeModal()" aria-label="Cerrar">✕</button>
      <h3 class="modal-title">Revisa tu correo</h3>
      <div class="fake-email">
        <div class="fake-email-head">
          <span>De: Herbario PAES &lt;no-reply@herbario-paes.local&gt;</span>
          <span>Para: ${escHtml(email)}</span>
          <span>Asunto: Recupera tu contraseña</span>
        </div>
        <div class="fake-email-body">
          <p>Hola,</p>
          <p>Pediste recuperar tu contraseña. Confirma que fuiste tú para continuar:</p>
          <button type="button" class="btn btn-primary" onclick="AuthUI.confirmSimulatedEmail()">Confirmar y establecer nueva contraseña</button>
        </div>
      </div>
      <p class="fake-email-note">📧 Este correo es simulado: esta página es un archivo HTML sin servidor propio y no puede enviar correos reales. Este panel muestra lo que llegaría a tu bandeja de entrada.</p>
      <p class="modal-switch"><a href="#" onclick="AuthUI.openLogin(event)">← Volver a iniciar sesión</a></p>
    `;
  }
  function confirmSimulatedEmail() { openResetScreen(modalContext.pendingToken); }

  function renderRealEmailSentScreen(email) {
    const box = document.getElementById('authModalBox');
    box.innerHTML = `
      <button class="modal-close" onclick="AuthUI.closeModal()" aria-label="Cerrar">✕</button>
      <h3 class="modal-title">Revisa tu correo</h3>
      <p class="modal-sub">Enviamos un enlace para recuperar tu contraseña a <strong>${escHtml(email)}</strong>. Ábrelo desde tu bandeja de entrada para continuar (revisa también spam).</p>
      <p class="modal-switch"><a href="#" onclick="AuthUI.openLogin(event)">← Volver a iniciar sesión</a></p>
    `;
  }

  // ---------------------------------------------------------------------
  // Validación en vivo de contraseña (sin re-renderizar el formulario,
  // para no perder el foco mientras se escribe)
  // ---------------------------------------------------------------------
  function onPasswordInput(ctx) {
    const p1id = ctx === 'reg' ? 'regPassword' : 'resetPassword';
    const p2id = ctx === 'reg' ? 'regPassword2' : 'resetPassword2';
    const rulePrefix = ctx === 'reg' ? 'regRule' : 'resetRule';
    const matchId = ctx === 'reg' ? 'regMatchHint' : 'resetMatchHint';
    const p1el = document.getElementById(p1id), p2el = document.getElementById(p2id);
    if (!p1el || !p2el) return;
    const p1 = p1el.value, p2 = p2el.value;
    PASSWORD_RULES.forEach((rule, i) => {
      const el = document.getElementById(rulePrefix + i);
      if (el) el.classList.toggle('ok', rule.test(p1));
    });
    const matchEl = document.getElementById(matchId);
    if (matchEl) {
      if (!p2) { matchEl.textContent = ''; matchEl.className = 'field-hint'; }
      else if (p1 === p2) { matchEl.textContent = '✓ Coinciden'; matchEl.className = 'field-hint ok'; }
      else { matchEl.textContent = 'Las contraseñas no coinciden'; matchEl.className = 'field-hint bad'; }
    }
  }

  // ---------------------------------------------------------------------
  // Envío de formularios
  // ---------------------------------------------------------------------
  function submitRegister(evt) {
    evt.preventDefault();
    const username = document.getElementById('regUsername').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const password2 = document.getElementById('regPassword2').value;
    const errorEl = document.getElementById('regError');
    errorEl.textContent = '';

    if (!username) return errorEl.textContent = 'Escribe un nombre de usuario.';
    if (!isValidEmail(email)) return errorEl.textContent = 'Escribe un correo electrónico válido.';
    if (!passwordMeetsRules(password)) return errorEl.textContent = 'La contraseña no cumple los requisitos de arriba.';
    if (password !== password2) return errorEl.textContent = 'Las contraseñas no coinciden.';

    const usernameLower = username.toLowerCase();
    const emailLower = email.toLowerCase();
    if (findUserByUsername(usernameLower)) return errorEl.textContent = 'Ese nombre de usuario ya está en uso.';
    if (findUserByEmail(emailLower)) return errorEl.textContent = 'Ese correo ya tiene una cuenta asociada.';

    const btn = evt.target.querySelector('.modal-submit');
    btn.disabled = true; btn.textContent = 'Creando…';

    const salt = randomHex(16);
    hashPassword(password, salt).then(hash => {
      const users = getUsers();
      users.push({ username, usernameLower, email, emailLower, passwordHash: hash, salt, createdAt: Date.now() });
      saveUsers(users);
      const recovered = migrateLegacyDataIfNeeded(usernameLower);
      setSession(usernameLower);
      showModalSuccess(recovered ? '¡Cuenta creada! Recuperamos tu progreso guardado en este navegador.' : '¡Cuenta creada!');
      setTimeout(() => location.reload(), 900);
    }).catch(() => {
      errorEl.textContent = 'Ocurrió un error creando la cuenta. Intenta de nuevo.';
      btn.disabled = false; btn.textContent = 'Crear cuenta';
    });
  }

  function submitLogin(evt) {
    evt.preventDefault();
    const idRaw = document.getElementById('loginId').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');
    errorEl.textContent = '';
    const GENERIC = 'Usuario/correo o contraseña incorrectos.';
    if (!idRaw || !password) return errorEl.textContent = 'Completa usuario/correo y contraseña.';

    const user = findUserByUsernameOrEmail(idRaw.toLowerCase());
    if (!user) return errorEl.textContent = GENERIC;

    const btn = evt.target.querySelector('.modal-submit');
    btn.disabled = true; btn.textContent = 'Entrando…';

    hashPassword(password, user.salt).then(hash => {
      if (hash !== user.passwordHash) {
        errorEl.textContent = GENERIC;
        btn.disabled = false; btn.textContent = 'Entrar';
        return;
      }
      setSession(user.usernameLower);
      showModalSuccess('¡Bienvenido de nuevo!');
      setTimeout(() => location.reload(), 700);
    }).catch(() => {
      errorEl.textContent = 'Ocurrió un error. Intenta de nuevo.';
      btn.disabled = false; btn.textContent = 'Entrar';
    });
  }

  function submitForgot(evt) {
    evt.preventDefault();
    const email = document.getElementById('forgotEmail').value.trim();
    const errorEl = document.getElementById('forgotError');
    errorEl.textContent = '';
    const user = findUserByEmail(email.toLowerCase());
    if (!user) return errorEl.textContent = 'No encontramos una cuenta con ese correo.';

    const btn = evt.target.querySelector('.modal-submit');
    btn.disabled = true; btn.textContent = 'Enviando…';

    const token = randomHex(20);
    const tokens = getResetTokens();
    Object.keys(tokens).forEach(t => { if (tokens[t].usernameLower === user.usernameLower) delete tokens[t]; });
    tokens[token] = { usernameLower: user.usernameLower, expiresAt: Date.now() + RESET_TOKEN_TTL_MS };
    saveResetTokens(tokens);

    if (EMAIL_CONFIG.enabled && window.emailjs) {
      const link = location.origin + location.pathname + '#auth-reset=' + token;
      window.emailjs.send(EMAIL_CONFIG.serviceId, EMAIL_CONFIG.templateId, { to_email: user.email, reset_link: link })
        .then(() => renderRealEmailSentScreen(user.email))
        .catch(() => renderSimulatedEmailScreen(user.email, token));
    } else {
      renderSimulatedEmailScreen(user.email, token);
    }
  }

  function submitReset(evt) {
    evt.preventDefault();
    const p1 = document.getElementById('resetPassword').value;
    const p2 = document.getElementById('resetPassword2').value;
    const errorEl = document.getElementById('resetError');
    errorEl.textContent = '';
    if (!passwordMeetsRules(p1)) return errorEl.textContent = 'La contraseña no cumple los requisitos de arriba.';
    if (p1 !== p2) return errorEl.textContent = 'Las contraseñas no coinciden.';

    const tokens = getResetTokens();
    const entry = tokens[modalContext.resetToken];
    if (!entry || entry.expiresAt < Date.now()) return openResetScreen(modalContext.resetToken);

    const btn = evt.target.querySelector('.modal-submit');
    btn.disabled = true; btn.textContent = 'Guardando…';

    const salt = randomHex(16);
    hashPassword(p1, salt).then(hash => {
      const users = getUsers();
      const idx = users.findIndex(u => u.usernameLower === entry.usernameLower);
      if (idx === -1) { errorEl.textContent = 'No se encontró la cuenta.'; return; }
      users[idx].passwordHash = hash;
      users[idx].salt = salt;
      saveUsers(users);
      delete tokens[modalContext.resetToken];
      saveResetTokens(tokens);
      setSession(entry.usernameLower);
      showModalSuccess('¡Contraseña actualizada!');
      setTimeout(() => location.reload(), 900);
    }).catch(() => {
      errorEl.textContent = 'Ocurrió un error. Intenta de nuevo.';
      btn.disabled = false; btn.textContent = 'Cambiar contraseña';
    });
  }

  function logout() { setSession(null); location.reload(); }

  // ---------------------------------------------------------------------
  // UI de la barra superior y el aviso de invitado
  // ---------------------------------------------------------------------
  function renderAuthActions() {
    const el = document.getElementById('authActions');
    if (!el) return;
    const sessionLower = getSession();
    if (sessionLower) {
      const u = findUserByUsername(sessionLower);
      const name = u ? u.username : sessionLower;
      el.innerHTML = `
        <span class="auth-chip" title="${escHtml(name)}">👤 ${escHtml(name)}</span>
        <button class="auth-btn" onclick="AuthUI.logout()">Cerrar sesión</button>
      `;
    } else {
      el.innerHTML = `
        <button class="auth-btn" onclick="AuthUI.openLogin()">Iniciar sesión</button>
        <button class="auth-btn auth-btn-primary" onclick="AuthUI.openRegister()">Registrarse</button>
      `;
    }
  }

  function renderGuestBanner() {
    const el = document.getElementById('guestBanner');
    if (!el) return;
    if (getSession()) {
      el.classList.add('hidden');
      el.innerHTML = '';
    } else {
      el.classList.remove('hidden');
      el.innerHTML = `
        ⚠️ No has iniciado sesión — tu progreso no se guardará al cerrar o recargar la página.
        <a href="#" onclick="AuthUI.openRegister(event)">Crear cuenta</a> ·
        <a href="#" onclick="AuthUI.openLogin(event)">Iniciar sesión</a>
      `;
    }
  }

  // Usada desde app.js (pantalla de Progreso) para explicar dónde vive el progreso.
  function progressStorageNoticeHtml() {
    const sessionLower = getSession();
    if (sessionLower) {
      const u = findUserByUsername(sessionLower);
      const name = u ? u.username : sessionLower;
      return `Tu progreso se guarda en tu cuenta <strong>${escHtml(name)}</strong>, dentro de este navegador. Las cuentas no se sincronizan entre dispositivos: si abres la web en otro computador o navegador, no verás este progreso allí.`;
    }
    return `No has iniciado sesión: tu progreso <strong>no se está guardando</strong> y se reiniciará la próxima vez que abras la página. <a href="#" onclick="AuthUI.openRegister(event)">Crea una cuenta</a> para guardarlo.`;
  }

  // ---------------------------------------------------------------------
  // Enlace de recuperación real (EmailJS): #auth-reset=TOKEN al cargar
  // ---------------------------------------------------------------------
  function checkResetHashOnLoad() {
    const m = /(?:^|[#&])auth-reset=([a-zA-Z0-9]+)/.exec(location.hash);
    if (m) {
      history.replaceState(null, '', location.pathname + location.search);
      openResetScreen(m[1]);
    }
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const ov = document.getElementById('authModalOverlay');
      if (ov && !ov.classList.contains('hidden')) closeModal();
    }
  });

  // ---------------------------------------------------------------------
  // API pública (usada desde los atributos onclick del HTML y desde app.js)
  // ---------------------------------------------------------------------
  window.AuthUI = {
    openRegister, openLogin, openForgot, openResetScreen, closeModal, overlayClick,
    submitRegister, submitLogin, submitForgot, submitReset, confirmSimulatedEmail,
    onPasswordInput, logout, progressStorageNoticeHtml
  };

  renderAuthActions();
  renderGuestBanner();
  checkResetHashOnLoad();

})();
