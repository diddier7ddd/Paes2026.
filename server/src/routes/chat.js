/* =====================================================================
   routes/chat.js
   =====================================================================
   POST /api/chat
   Body: { message: string, history?: Array<{role, content}> }
   Respuesta: { reply, siteSources, webSources }
   ===================================================================== */
'use strict';
const express = require('express');
const { askAssistant } = require('../lib/aiAssistant');

const router = express.Router();

const MAX_MESSAGE_LEN = 1500;
const MAX_HISTORY_TURNS = 10;

router.post('/chat', async (req, res) => {
  const { message, history } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'empty_message' });
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return res.status(400).json({ error: 'message_too_long' });
  }

  const cleanHistory = Array.isArray(history)
    ? history.slice(-MAX_HISTORY_TURNS).filter(m =>
        m && (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' && m.content.length <= MAX_MESSAGE_LEN
      )
    : [];

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'assistant_not_configured' });
  }

  try {
    const result = await askAssistant(message.trim(), cleanHistory);
    return res.status(200).json(result);
  } catch (err) {
    console.error('✗ Error en /api/chat:', err && err.message ? err.message : err);
    return res.status(502).json({ error: 'assistant_failed' });
  }
});

module.exports = router;
