/* =====================================================================
   chat-widget.js — Asistente de IA de Ciencias y Matemática
   =====================================================================
   Qué hace: agrega el botón flotante ✨ (junto al de notas) que abre un
   panel de chat. Las preguntas se mandan al servidor propio (carpeta
   /server, ver server/src/lib/aiAssistant.js), que:
     1. Busca primero en el temario real del sitio y, si encuentra la
        respuesta ahí, la cita (asignatura · unidad · subtema).
     2. Si el sitio no lo cubre, investiga en la web con un proceso de
        verificación (varias fuentes, cruce de datos) y muestra de dónde
        sacó la información.
     3. Si la pregunta no es de Ciencias/Matemática, avisa que solo
        responde ese tipo de preguntas.
   Todo el criterio de cuándo hacer cada cosa vive en el servidor (el
   prompt de sistema del asistente); este archivo solo es la interfaz.

   Por qué es un archivo aparte de app.js: se pidió como una pieza nueva
   e independiente ("compartir servidor" con el correo, pero la UI del
   chat es su propia cosa). No toca ninguna función de app.js ni de
   auth.js — ni falta hace: para ocultarse durante un cuestionario
   (igual que el bloc de notas) observa el propio botón de notas
   (#notesFab) con un MutationObserver y copia su estado, en vez de que
   app.js tenga que saber que este widget existe.

   Estado del chat: vive solo en memoria (se reinicia si recargas la
   página), igual que el progreso de un invitado sin sesión — no se
   guarda en localStorage a propósito, para mantener este archivo
   simple y porque una conversación de ayuda puntual no necesita
   persistir entre sesiones.
   ===================================================================== */
(function () {

  // Definido en index.html, compartido con auth.js.
  const API_BASE_URL = (typeof window !== 'undefined' && window.HERBARIO_API_BASE_URL) || 'http://localhost:3000';
  const MAX_HISTORY_SENT = 8; // últimos N mensajes que se mandan como contexto, para no disparar el costo

  let messages = []; // {role:'user'|'assistant', content, siteSources?, webSources?, error?}
  let sending = false;

  function escHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Formateo mínimo y seguro para las respuestas del asistente: escapa TODO
  // primero (nunca se inyecta HTML sin escapar) y recién después aplica
  // **negrita** y separación de párrafos sobre el texto ya escapado.
  function formatAssistantText(raw) {
    const escaped = escHtml(raw);
    const withBold = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const paragraphs = withBold.split(/\n{2,}/).map(p => p.replace(/\n/g, '<br>')).filter(p => p.trim());
    return paragraphs.map(p => `<p>${p}</p>`).join('') || `<p>${withBold}</p>`;
  }

  // ---------------------------------------------------------------------
  // Mostrar/ocultar el botón en conjunto con el de notas (oculto durante
  // un cuestionario), sin depender de que app.js sepa que este widget
  // existe: simplemente copiamos el estado del botón de notas cada vez
  // que cambia.
  // ---------------------------------------------------------------------
  function syncFabVisibility() {
    const notesFab = document.getElementById('notesFab');
    const aiFab = document.getElementById('aiFab');
    if (!notesFab || !aiFab) return;
    const shouldHide = notesFab.classList.contains('nf-hidden');
    aiFab.classList.toggle('nf-hidden', shouldHide);
    if (shouldHide) closePanel();
  }

  function setupVisibilityObserver() {
    const notesFab = document.getElementById('notesFab');
    if (!notesFab) return;
    syncFabVisibility();
    new MutationObserver(syncFabVisibility).observe(notesFab, { attributes: true, attributeFilter: ['class'] });
  }

  // ---------------------------------------------------------------------
  // Abrir / cerrar / posicionar el panel (mismo patrón que el bloc de
  // notas: se ancla sobre el botón, respetando los bordes de pantalla).
  // ---------------------------------------------------------------------
  function toggle() {
    const panel = document.getElementById('aiPanel');
    if (panel.classList.contains('np-hidden')) openPanel();
    else closePanel();
  }

  function openPanel() {
    const panel = document.getElementById('aiPanel');
    const fab = document.getElementById('aiFab');
    if (!panel || !fab) return;
    const fabRect = fab.getBoundingClientRect();
    const panelW = Math.min(360, window.innerWidth - 24);
    const panelH = Math.min(600, window.innerHeight * 0.78);
    let left = fabRect.left - panelW + fabRect.width;
    let top = fabRect.top - panelH - 14;
    left = Math.max(12, Math.min(window.innerWidth - panelW - 12, left));
    top = Math.max(12, Math.min(window.innerHeight - panelH - 12, top));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.classList.remove('np-hidden');
    renderMessages();
    const input = document.getElementById('aiInput');
    if (input) setTimeout(() => input.focus(), 30);
  }

  function closePanel() {
    const panel = document.getElementById('aiPanel');
    if (panel) panel.classList.add('np-hidden');
  }

  // Arrastrar el panel desde su encabezado (idéntico patrón al de notas).
  function setupDrag() {
    const header = document.getElementById('aiPanelHeader');
    const panel = document.getElementById('aiPanel');
    if (!header || !panel) return;
    let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ai-panel-close')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY; origLeft = rect.left; origTop = rect.top;
      try { header.setPointerCapture(e.pointerId); } catch (err) {}
    });
    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const rect = panel.getBoundingClientRect();
      let newLeft = origLeft + dx, newTop = origTop + dy;
      newLeft = Math.max(6, Math.min(window.innerWidth - rect.width - 6, newLeft));
      newTop = Math.max(6, Math.min(window.innerHeight - 40, newTop));
      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    });
    header.addEventListener('pointerup', () => { dragging = false; });
    header.addEventListener('pointercancel', () => { dragging = false; });
  }

  // ---------------------------------------------------------------------
  // Render de los mensajes
  // ---------------------------------------------------------------------
  function renderMessages() {
    const body = document.getElementById('aiPanelBody');
    if (!body) return;

    if (messages.length === 0) {
      body.innerHTML = `
        <div class="ai-intro">
          👋 Pregúntame lo que quieras de <b>Biología, Física, Química o Matemática</b>.<br>
          Primero reviso el temario de este sitio; si no está ahí, lo investigo en internet y te digo de dónde saqué la información.
        </div>`;
      return;
    }

    body.innerHTML = messages.map(m => {
      if (m.role === 'user') {
        return `<div class="ai-msg user">${escHtml(m.content)}</div>`;
      }
      const errorClass = m.error ? ' error' : '';
      let html = `<div class="ai-msg assistant${errorClass}">${formatAssistantText(m.content)}</div>`;
      const chips = [];
      (m.siteSources || []).forEach(cita => {
        chips.push(`<div class="ai-source-chip">📍 ${escHtml(cita)}</div>`);
      });
      (m.webSources || []).forEach(src => {
        chips.push(`<div class="ai-source-chip web">🌐 <a href="${escHtml(src.url)}" target="_blank" rel="noopener noreferrer">${escHtml(src.title || src.url)}</a></div>`);
      });
      if (chips.length) html += `<div class="ai-sources">${chips.join('')}</div>`;
      return html;
    }).join('') + (sending ? '<div class="ai-typing"><span></span><span></span><span></span></div>' : '');

    body.scrollTop = body.scrollHeight;
  }

  // ---------------------------------------------------------------------
  // Enviar un mensaje
  // ---------------------------------------------------------------------
  function send() {
    if (sending) return;
    const input = document.getElementById('aiInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    messages.push({ role: 'user', content: text });
    input.value = '';
    autoGrow(input);
    sending = true;
    renderMessages();

    const history = messages
      .slice(0, -1) // sin el mensaje que se acaba de mandar (va aparte como `message`)
      .slice(-MAX_HISTORY_SENT)
      .map(m => ({ role: m.role, content: m.content }));

    fetch(API_BASE_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history }),
    })
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw Object.assign(new Error(data.error || 'request_failed'), { code: data.error, status: res.status });
        }
        return data;
      })
      .then(data => {
        messages.push({ role: 'assistant', content: data.reply, siteSources: data.siteSources, webSources: data.webSources });
      })
      .catch(err => {
        messages.push({ role: 'assistant', content: friendlyErrorMessage(err), error: true });
      })
      .finally(() => {
        sending = false;
        renderMessages();
      });
  }

  function friendlyErrorMessage(err) {
    switch (err && err.code) {
      case 'assistant_not_configured':
        return 'El asistente de IA todavía no está configurado en el servidor (falta la llave de Anthropic en su .env).';
      case 'too_many_requests':
        return 'Has hecho muchas preguntas seguidas. Espera un momento y vuelve a intentar.';
      case 'message_too_long':
        return 'Esa pregunta es demasiado larga. ¿Puedes acortarla?';
      case 'assistant_failed':
        return 'Tuve un problema respondiendo esa pregunta. ¿Puedes intentar de nuevo?';
      default:
        return 'No pude conectarme con el servidor del asistente. Revisa que esté corriendo e inténtalo de nuevo.';
    }
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(80, el.scrollHeight) + 'px';
  }

  function setupInput() {
    const input = document.getElementById('aiInput');
    if (!input) return;
    input.addEventListener('input', () => autoGrow(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const panel = document.getElementById('aiPanel');
      if (panel && !panel.classList.contains('np-hidden')) closePanel();
    }
  });

  window.AiWidget = { toggle, close: closePanel, send };

  setupVisibilityObserver();
  setupDrag();
  setupInput();

})();
