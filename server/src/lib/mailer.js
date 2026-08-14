/* =====================================================================
   mailer.js
   =====================================================================
   Envío REAL de correo por SMTP (nodemailer), para reemplazar el panel
   "correo simulado" que auth.js mostraba antes dentro de la misma
   página. Server-agnóstico a propósito: funciona con cualquier
   proveedor SMTP (Gmail, Resend, Brevo, Zoho, tu propio servidor de
   correo, etc.) — solo cambian las variables de entorno en .env, el
   código no depende de ningún proveedor en particular.

   Config esperada en .env (ver .env.example para más detalle):
     SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, EMAIL_FROM

   Nota sobre Gmail: si usas una cuenta de Gmail como remitente, Gmail
   exige una "Contraseña de aplicación" (con la verificación en 2 pasos
   activada) en vez de tu contraseña normal — la contraseña normal de
   la cuenta no funciona por SMTP. Para volumen alto o mejor entrega,
   un proveedor transaccional (Resend, Brevo, etc., todos con plan
   gratuito para pocos correos al día) suele ser más confiable que
   Gmail, pero Gmail alcanza de sobra para un sitio de estudio.
   ===================================================================== */
'use strict';
const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
} = process.env;

const isConfigured = Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS);

let transporter = null;
if (isConfigured) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    // Puerto 465 = TLS implícito (secure:true). Puerto 587/25 = STARTTLS
    // (secure:false, y nodemailer sube la conexión a TLS solo después de
    // conectar). SMTP_SECURE en .env permite forzarlo si hace falta.
    secure: typeof SMTP_SECURE === 'string' ? SMTP_SECURE === 'true' : Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

/**
 * Verifica la conexión/autenticación SMTP. Se llama una vez al arrancar
 * el servidor solo para dejar un aviso claro en consola — nunca tira el
 * servidor abajo si falla, porque el resto de la app (y el asistente de
 * IA) no depende de esto para funcionar.
 */
async function verifyMailer() {
  if (!isConfigured) {
    console.warn(
      '⚠ Correo NO configurado (faltan SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS en .env). ' +
      'La recuperación de contraseña seguirá funcionando en modo simulado desde el navegador hasta que configures esto.'
    );
    return false;
  }
  try {
    await transporter.verify();
    console.log(`✓ Correo listo: enviando como ${EMAIL_FROM || SMTP_USER} vía ${SMTP_HOST}`);
    return true;
  } catch (err) {
    console.error('✗ No se pudo verificar la conexión SMTP:', err.message);
    console.error('  Revisa SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS en tu .env.');
    return false;
  }
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Envía el correo real de recuperación de contraseña.
 * @param {{to:string, username:string, resetLink:string}} params
 * @returns {Promise<{ok:boolean, error?:string}>} nunca lanza (throw);
 *   siempre resuelve con {ok:false,...} en caso de error, para que quien
 *   llama (la ruta HTTP) decida cómodamente qué responder al cliente.
 */
async function sendPasswordResetEmail({ to, username, resetLink }) {
  if (!isConfigured) {
    return { ok: false, error: 'smtp_not_configured' };
  }
  const safeName = escapeHtml(username || to);
  const safeLink = escapeHtml(resetLink);
  const html = `
  <div style="background:#fae0e9;padding:32px 16px;font-family:Georgia,'Source Serif 4',serif;">
    <div style="max-width:480px;margin:0 auto;background:linear-gradient(160deg,#fbf2e6,#f5e6cf);border-radius:16px;padding:32px 28px;color:#4a3208;">
      <p style="font-family:'Space Grotesk',Arial,sans-serif;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;font-size:12px;color:#96701f;margin:0 0 18px;">
        🌿 Herbario PAES · Ciencias y Matemática
      </p>
      <h1 style="font-size:22px;margin:0 0 14px;color:#3d2a06;">Recupera tu contraseña</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 10px;">Hola, ${safeName}.</p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 22px;">
        Pediste recuperar tu contraseña en Herbario PAES. Haz clic en el botón de abajo para
        elegir una nueva. Este enlace vale por 30 minutos y solo puede usarse una vez.
      </p>
      <p style="text-align:center;margin:0 0 22px;">
        <a href="${safeLink}" style="display:inline-block;background:#d4af37;color:#2b1a05;font-family:'Space Grotesk',Arial,sans-serif;font-weight:700;font-size:14px;text-decoration:none;padding:13px 26px;border-radius:999px;">
          Establecer nueva contraseña
        </a>
      </p>
      <p style="font-size:12.5px;line-height:1.6;color:#8f6a1e;margin:0 0 4px;">
        Si el botón no funciona, copia y pega este enlace en tu navegador:
      </p>
      <p style="font-size:12px;line-height:1.5;color:#96701f;word-break:break-all;margin:0 0 22px;">${safeLink}</p>
      <p style="font-size:12.5px;line-height:1.6;color:#8f6a1e;margin:0;">
        Si no pediste esto, puedes ignorar este correo con tranquilidad: tu contraseña actual sigue siendo válida.
      </p>
    </div>
  </div>`;
  const text =
    `Herbario PAES - Recupera tu contraseña\n\n` +
    `Hola, ${username || to}.\n\n` +
    `Pediste recuperar tu contraseña. Abre este enlace para elegir una nueva (vale por 30 minutos):\n` +
    `${resetLink}\n\n` +
    `Si no pediste esto, puedes ignorar este correo.`;

  try {
    const info = await transporter.sendMail({
      from: EMAIL_FROM || SMTP_USER,
      to,
      subject: 'Recupera tu contraseña · Herbario PAES',
      text,
      html,
    });
    if (info.rejected && info.rejected.length > 0) {
      return { ok: false, error: 'recipient_rejected' };
    }
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error('✗ Error enviando correo de recuperación:', err.code || err.message);
    return { ok: false, error: err.code || 'send_failed' };
  }
}

module.exports = { sendPasswordResetEmail, verifyMailer, isConfigured };
