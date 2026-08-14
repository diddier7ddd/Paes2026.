/* =====================================================================
   server.js — Herbario PAES: servidor de correo real + asistente IA
   =====================================================================
   Qué resuelve este servidor (los "dos grandes avances" pedidos):

   1) POST /api/send-reset-email — envía de verdad el correo de
      recuperación de contraseña (antes: panel simulado dentro de la
      página, ver auth.js).
   2) POST /api/chat — asistente de IA de Ciencias y Matemática que
      responde primero con el temario propio del sitio (citando dónde
      está) y, si no lo encuentra ahí, investiga en la web con un
      proceso de verificación (ver src/lib/aiAssistant.js).

   Ambas funciones comparten este mismo servidor/proceso, tal como se
   pidió ("compartir servidor").

   Cómo correrlo:
     1. cp .env.example .env   → completa tus credenciales (ver README.md)
     2. npm install
     3. npm start              → sirve en http://localhost:3000

   El resto del sitio (index.html/app.js/auth.js/chat-widget.js) sigue
   siendo HTML/JS estático de toda la vida: puedes seguir abriéndolo
   con doble clic o Live Server, apuntando su API_BASE_URL (ver
   chat-widget.js y auth.js) a donde sea que corra ESTE servidor. Como
   comodidad adicional, si este servidor detecta un index.html en la
   carpeta justo arriba de esta (server/../index.html), también sirve
   el sitio completo él mismo — así "npm start" te deja todo andando
   en un solo lugar durante desarrollo.
   ===================================================================== */
'use strict';
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const resetEmailRoute = require('./src/routes/resetEmail');
const chatRoute = require('./src/routes/chat');
const { verifyMailer } = require('./src/lib/mailer');
const contentSearch = require('./src/lib/contentSearch');

const PORT = Number(process.env.PORT || 3000);

// Cuántos "saltos" de proxy inverso hay delante de este servidor (Render,
// Railway, Fly, nginx, Cloudflare...). En local (sin proxy) da igual. Si
// despliegas detrás de más de un proxy encadenado, ajusta este número —
// ver la guía de express-rate-limit sobre "trust proxy" si el aviso de
// abajo aparece en producción.
const TRUST_PROXY_HOPS = Number.isFinite(Number(process.env.TRUST_PROXY_HOPS))
  ? Number(process.env.TRUST_PROXY_HOPS)
  : 1;

const app = express();
app.set('trust proxy', TRUST_PROXY_HOPS);

// ---------------------------------------------------------------------
// CORS: por defecto abierto (para que sea fácil probar el sitio estático
// desde cualquier lado — file://, Live Server, otro puerto). En
// producción, define ALLOWED_ORIGIN en .env con la URL real de tu sitio
// para restringirlo.
// ---------------------------------------------------------------------
const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors({ origin: allowedOrigin || true }));

app.use(express.json({ limit: '100kb' }));

// ---------------------------------------------------------------------
// Límite de tasa: separado por endpoint porque tienen riesgos distintos
// (correo = relay de spam si se abusa; chat = costo de API de Anthropic).
// Configurable por variables de entorno si el valor por defecto no calza
// con tu uso real.
// ---------------------------------------------------------------------
const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_EMAIL_MAX || 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_requests' },
});
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_CHAT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

app.use('/api/send-reset-email', emailLimiter);
app.use('/api/chat', chatLimiter);

app.use('/api', resetEmailRoute);
app.use('/api', chatRoute);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mailConfigured: require('./src/lib/mailer').isConfigured,
    assistantConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    knowledgeBase: contentSearch.stats(),
  });
});

// ---------------------------------------------------------------------
// Comodidad opcional: si el sitio estático (index.html) vive justo un
// nivel arriba de esta carpeta, este mismo proceso también lo sirve.
// Esto es 100% opcional — el sitio funciona igual si lo sirves aparte
// (GitHub Pages, Netlify, Live Server, etc.) apuntando su API a donde
// sea que corra este servidor.
// ---------------------------------------------------------------------
const staticDir = path.join(__dirname, '..');
if (fs.existsSync(path.join(staticDir, 'index.html'))) {
  app.use(express.static(staticDir));
  app.get('/', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  console.log(`✓ Sirviendo también el sitio estático desde: ${staticDir}`);
}

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('✗ Error no manejado:', err);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(PORT, () => {
  console.log(`\n🌿 Herbario PAES — servidor escuchando en http://localhost:${PORT}`);
  console.log(`   Temario indexado: ${contentSearch.stats().total} subtemas.`);
  verifyMailer();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠ Falta ANTHROPIC_API_KEY en .env — el asistente de IA no va a funcionar hasta que la agregues.');
  } else {
    console.log(`✓ Asistente de IA listo (modelo: ${require('./src/lib/aiAssistant').MODEL}).`);
  }
});
