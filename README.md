# Herbario PAES — servidor (correo real + asistente de IA)

Este servidor agrega dos cosas al sitio, que antes era 100% estático:

1. **`POST /api/send-reset-email`** — manda de verdad el correo de recuperación de contraseña (antes era un panel simulado dentro de la página).
2. **`POST /api/chat`** — el asistente de IA ✨ de Ciencias y Matemática (el botón junto al de notas). Busca primero en el temario real del sitio (y cita dónde está); si no lo encuentra ahí, investiga en la web con varias fuentes y te dice de dónde sacó la información; si la pregunta no es de Ciencias/Matemática, avisa que solo responde ese tipo de preguntas.

Las cuentas de usuario **siguen viviendo en `localStorage`**, en el navegador, exactamente como antes — este servidor no tiene base de datos ni sabe nada de contraseñas. Solo manda el correo que `auth.js` le pide, y responde las preguntas que `chat-widget.js` le manda.

## Estructura

```
tu-proyecto/
├── index.html, app.js, auth.js, chat-widget.js   ← el sitio (estático, igual que antes)
└── server/                                        ← esta carpeta
    ├── server.js              → arranca todo
    ├── package.json
    ├── .env.example           → copiar a .env y completar
    ├── src/
    │   ├── routes/            → las 2 rutas HTTP
    │   ├── lib/                → correo, buscador del temario, asistente de IA
    │   └── data/content-data.json  → temario extraído de app.js (generado)
    └── scripts/extract-content.js  → regenera content-data.json desde app.js
```

## Puesta en marcha

```bash
cd server
cp .env.example .env      # completa tus credenciales, ver abajo
npm install
npm start                 # sirve en http://localhost:3000
```

Si `index.html` está justo un nivel arriba de `server/` (la estructura de arriba), `npm start` **también** sirve el sitio completo en `http://localhost:3000` — cómodo para probar todo junto. Si prefieres seguir abriendo `index.html` con doble clic o Live Server, no pasa nada: solo asegúrate de que `window.HERBARIO_API_BASE_URL` en `index.html` apunte a donde sea que corra este servidor.

Antes de publicar el sitio de verdad, cambia dos cosas:
- En `index.html`: `window.HERBARIO_API_BASE_URL` → la URL pública de este servidor una vez desplegado.
- En `server/.env`: `ALLOWED_ORIGIN` → la URL pública de tu sitio (restringe quién puede llamar a la API).

## Variables de entorno (`.env`)

### Correo (obligatorio para el correo real)
Cualquier proveedor SMTP sirve — solo llena estas 5 variables:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=tucuenta@gmail.com
SMTP_PASS=xxxxxxxxxxxxxxxx
EMAIL_FROM=Herbario PAES <tucuenta@gmail.com>
```
Con **Gmail**: activa la verificación en 2 pasos y crea una "Contraseña de aplicación" en https://myaccount.google.com/apppasswords (tu contraseña normal de Gmail no sirve por SMTP). Alternativas con plan gratuito, pensadas para esto y más confiables a mayor volumen: **Resend** (resend.com), **Brevo** (brevo.com), **Zoho ZeptoMail**.

Si dejas estas variables vacías, el servidor sigue funcionando: `/api/send-reset-email` responde `{ok:false, error:"smtp_not_configured"}` y el sitio cae solo al panel de correo simulado de siempre.

### Asistente de IA (obligatorio para el chat)
```
ANTHROPIC_API_KEY=sk-ant-...
```
Se crea en https://console.anthropic.com/settings/keys (requiere una cuenta de Anthropic con facturación activada; el consumo de un sitio de estudio personal es bajo). Sin esta llave, `/api/chat` responde 503 y el widget muestra un aviso claro en vez de fallar en silencio.

Modelo por defecto: `claude-sonnet-5` (buen equilibrio calidad/costo). Se puede cambiar con `ANTHROPIC_MODEL` — `claude-haiku-4-5-20251001` es más barato/rápido, `claude-opus-4-8` da la mejor calidad si el costo no es problema.

### El resto (`PORT`, `ALLOWED_ORIGIN`, límites de tasa)
Ya tienen valores por defecto razonables — ver los comentarios en `.env.example`.

## Publicar el sitio (GitHub Pages + Render)

GitHub por sí solo **no puede ejecutar** este servidor (GitHub Pages solo sirve archivos estáticos). La forma de tener todo funcionando de verdad es repartir el trabajo:

- **GitHub Pages** → sirve `index.html`, `app.js`, `auth.js`, `chat-widget.js` (gratis).
- **Render** (u otro host de Node) → corre `server/` de verdad, 24/7 (plan gratis disponible, sin tarjeta).

Pasos:

1. Sube este proyecto a un repositorio de GitHub (ya viene con `git init` y un commit hecho — solo falta `git remote add origin <url> && git push -u origin main`).
2. En GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`**. Tu sitio queda en `https://tu-usuario.github.io/tu-repo/`.
3. En [render.com](https://render.com): **New → Blueprint**, conecta el mismo repo. Render detecta `render.yaml` solo y arma el servicio (carpeta `server/`); te va a pedir los valores marcados como secretos (`ANTHROPIC_API_KEY`, los `SMTP_*`, etc.) en pantalla. Al terminar te da una URL tipo `https://herbario-paes-server.onrender.com`.
4. Conecta ambas partes:
   - En `index.html`, cambia `window.HERBARIO_API_BASE_URL` de `http://localhost:3000` a tu URL de Render.
   - En Render, la variable `ALLOWED_ORIGIN` debe ser `https://tu-usuario.github.io` (sin la barra ni el nombre del repo al final — el origen no incluye la ruta).
   - Vuelve a hacer commit + push del cambio en `index.html`; GitHub Pages se actualiza sola.

El plan gratis de Render "duerme" el servidor tras 15 minutos sin uso: la primera visita después de un rato de inactividad tarda ~30-60 segundos en responder (el widget de IA ya muestra una animación de "escribiendo" mientras tanto, así que no se siente roto). Si eso molesta, el plan pagado más económico de Render lo mantiene siempre despierto.

## Si el temario cambia

`content-data.json` (lo que usa el asistente para "buscar primero en el sitio") se genera automáticamente desde `app.js`, **no se edita a mano**. Si agregas o editas una tarjeta de estudio en `app.js`, vuelve a generarlo:

```bash
npm run extract-content
```

## Probar que funciona

```bash
curl http://localhost:3000/api/health
```
Te dice si el correo y el asistente están configurados, y cuántos subtemas indexó del temario.

## Limitaciones conocidas (léelo antes de considerar esto "listo para producción a gran escala")

- **Cuentas sin servidor real:** como las cuentas siguen en `localStorage`, `/api/send-reset-email` no puede verificar del lado del servidor que el correo pertenece a una cuenta real — confía en lo que le manda el navegador. Se mitigó con límite de tasa por IP y validando que el enlace apunte a `ALLOWED_ORIGIN`, pero no es lo mismo que una cuenta real en base de datos. Para este tamaño de proyecto (sitio de estudio personal) es un compromiso razonable; si en algún momento se agregan cuentas de verdad del lado del servidor, este endpoint debería revisarse.
- **Historial del chat en memoria:** el widget no guarda las conversaciones en `localStorage` — se reinician al recargar la página, a propósito, para mantenerlo simple.
- **Búsqueda en el temario:** es un índice de texto (MiniSearch), no embeddings/IA — rápido y sin costo extra, pero puede no encontrar un subtema si la pregunta usa vocabulario muy distinto al del sitio. En ese caso, el asistente simplemente pasa a buscar en la web, que es el comportamiento pedido.
- **Sin streaming:** las respuestas del asistente llegan completas, no palabra por palabra. El widget muestra una animación de "escribiendo" mientras espera.
