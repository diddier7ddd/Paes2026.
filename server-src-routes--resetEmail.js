/* =====================================================================
   routes/resetEmail.js
   =====================================================================
   POST /api/send-reset-email
   Body: { to, username, resetLink }

   Este endpoint NO conoce el sistema de cuentas (que sigue viviendo
   100% en localStorage, en el navegador, como ya funcionaba). Es un
   simple "relay" de correo: el navegador ya generó el token y el
   enlace de recuperación (auth.js), y este endpoint solo se encarga
   de que ese correo salga de verdad. Mantener este límite es a
   propósito: mover las cuentas a una base de datos sería un cambio de
   arquitectura mucho más grande del que se pidió.

   Protecciones (dado que no hay verificación real de "este usuario
   existe" sin una base de datos del lado del servidor):
   - Límite de tasa por IP (aplicado en server.js con express-rate-limit).
   - Valida que `to` tenga forma de correo.
   - Valida que `resetLink` apunte al mismo origen configurado en
     ALLOWED_ORIGIN (si está definido), para que este endpoint no pueda
     usarse como relay genérico para mandar cualquier enlace a cualquiera.
   ===================================================================== */
'use strict';
const express = require('express');
const { sendPasswordResetEmail, isConfigured } = require('../lib/mailer');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/send-reset-email', async (req, res) => {
  const { to, username, resetLink } = req.body || {};

  if (typeof to !== 'string' || !EMAIL_RE.test(to.trim())) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }
  if (typeof resetLink !== 'string' || !/^https?:\/\//i.test(resetLink)) {
    return res.status(400).json({ ok: false, error: 'invalid_link' });
  }
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (allowedOrigin && !resetLink.startsWith(allowedOrigin)) {
    return res.status(400).json({ ok: false, error: 'link_origin_mismatch' });
  }
  if (!isConfigured) {
    // El servidor está corriendo pero sin SMTP configurado todavía:
    // se lo decimos claro al cliente para que caiga a la pantalla simulada
    // sin que parezca un error misterioso.
    return res.status(200).json({ ok: false, error: 'smtp_not_configured' });
  }

  const result = await sendPasswordResetEmail({
    to: to.trim(),
    username: typeof username === 'string' ? username.slice(0, 80) : '',
    resetLink,
  });

  return res.status(200).json(result);
});

module.exports = router;
