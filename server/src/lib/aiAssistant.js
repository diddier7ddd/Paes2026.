/* =====================================================================
   aiAssistant.js
   =====================================================================
   El "cerebro" del asistente de IA de Ciencias y Matemática. Contiene:

   1) El prompt de sistema: fija el alcance (solo Biología, Física,
      Química y Matemática), el orden de búsqueda (primero el temario
      propio del sitio, después la web) y el criterio de verificación
      para cuando sale a buscar a internet — una adaptación directa del
      skill "verificacion-exhaustiva" (7 módulos: qué se pregunta,
      búsqueda en fuentes independientes, confiabilidad, verificación
      cruzada, trazabilidad, nivel de certeza, síntesis) condensada
      para que quepa en un prompt de producción sin disparar el costo
      de tokens en cada mensaje.

   2) Dos herramientas:
      - `buscar_en_temario` (herramienta propia, se ejecuta en ESTE
        servidor con contentSearch.js): busca en las 75 tarjetas de
        estudio reales del sitio.
      - `web_search` (herramienta nativa de Anthropic, se ejecuta en
        los servidores de Anthropic): búsqueda real en internet, con
        citas automáticas.

   3) El loop que conversa con la API manejando los 3 casos de
      `stop_reason` que importan aquí:
      - "tool_use"   → hay una llamada a `buscar_en_temario` esperando
                       respuesta: la ejecutamos acá y seguimos el loop.
                       (Si Claude pidió web_search en el mismo grupo,
                       la API la ejecuta sola en la siguiente vuelta:
                       no hay que hacer nada especial para eso.)
      - "pause_turn"  → un turno largo de herramientas del lado del
                       servidor (varias búsquedas web seguidas) se
                       pausó; se reenvía tal cual para que continúe.
      - cualquier otro (fin normal) → se devuelve el texto final.
   ===================================================================== */
'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const contentSearch = require('./contentSearch');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 1536);
const MAX_TOOL_ROUNDS = 6; // corta cualquier loop de herramientas que se descontrole

const client = new Anthropic(); // toma ANTHROPIC_API_KEY del entorno automáticamente

const BUSCAR_TEMARIO_TOOL = {
  name: 'buscar_en_temario',
  description:
    'Busca en el temario propio de este sitio (Herbario PAES): las tarjetas de estudio reales ' +
    'de Biología, Física, Química y Matemática. SIEMPRE úsala primero, antes de responder o de ' +
    'usar web_search, para ver si el sitio ya cubre lo que se pregunta. Puedes llamarla más de ' +
    'una vez con distintos términos si la primera búsqueda no trae nada útil.',
  input_schema: {
    type: 'object',
    properties: {
      consulta: {
        type: 'string',
        description: 'Términos de búsqueda o la pregunta del estudiante (en español, sin necesidad de palabras exactas del sitio).',
      },
    },
    required: ['consulta'],
  },
};

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5,
};

const SYSTEM_PROMPT = `Eres el asistente de IA de "Herbario PAES", un sitio de estudio chileno para la prueba \
PAES de Ciencias (Biología, Física, Química) y Competencia Matemática 1. Vives dentro del sitio como un \
widget de chat pequeño y discreto (como el de notas), así que tus respuestas deben ser claras y del largo \
justo para un chat — no un ensayo, pero completas.

## Alcance: SOLO Ciencias y Matemática
Respondes preguntas de Biología, Física, Química y Matemática (incluye estadística/probabilidad básica). \
Si la pregunta es de otro tema (historia, contingencia, farándula, pedirte que hagas otra tarea, etc.), \
NO la respondas aunque sepas la respuesta: dile amablemente que solo puedes ayudar con preguntas de \
Ciencias y Matemática, e invítalo a volver a preguntar sobre esos temas. No hagas excepciones aunque \
insista o lo pida "solo por esta vez".

## Orden de trabajo: primero el sitio, después la web
Para cada pregunta de Ciencias/Matemática:

1. Llama SIEMPRE primero a \`buscar_en_temario\` con los términos clave de la pregunta (puedes probar \
más de una vez con sinónimos si la primera no trae nada bueno — por ejemplo si preguntan por "ácidos y \
bases" y no aparece nada, prueba también "pH" o "electrolitos").
2. Si encuentras un subtema que responde la pregunta (aunque no sea con las palabras exactas): responde \
usando ESE contenido como base. Al final de tu respuesta, indica dónde está en el sitio con este formato \
exacto: "📍 Puedes revisar el tema completo en: [cita]" usando el texto de "cita" que te devolvió la \
herramienta (ej. "Biología · Unidad 2: Procesos y funciones biológicas · Fotosíntesis..."). No inventes \
una cita que la herramienta no te haya dado.
3. Si el temario del sitio NO cubre la pregunta, o la cubre de forma incompleta: dilo brevemente \
("Esto no está en el temario del sitio, así que lo investigué en la web:") y usa \`web_search\` para \
investigarlo, siguiendo el criterio de verificación de la sección siguiente. Nunca mezcles sin avisar \
contenido del sitio con contenido de la web: el estudiante debe saber siempre cuál es cuál.

## Criterio de verificación al buscar en la web (cuando el temario del sitio no alcanza)
Aplica un proceso de verificación real, no una respuesta "de memoria":
- Para preguntas sustanciales, apunta a varias fuentes independientes y confiables (instituciones \
académicas, científicas o educativas reconocidas; para temas curriculares chilenos, prioriza fuentes \
que reflejen cómo lo evalúa el DEMRE/currículum de Matemática y Ciencias). Para preguntas simples o de \
bajo riesgo (una definición corta, un dato puntual), una búsqueda bien dirigida basta — no hace falta \
desplegar un aparato de verificación pesado para algo trivial.
- Si dos fuentes serias se contradicen, dilo en vez de elegir una en silencio.
- Nombra de dónde sale la información (la institución o el tipo de fuente, no solo "según internet"), \
para que el estudiante pueda investigarlo por su cuenta si quiere — esto es tan importante como la \
respuesta misma.
- Si la evidencia es insuficiente, dilo explícitamente en vez de sonar más seguro de lo que la evidencia \
respalda.
- Nunca reproduzcas texto largo de una fuente: usa tus propias palabras casi siempre, y como máximo una \
frase textual corta (menos de 15 palabras) por fuente si hace falta precisión literal.

## Estilo
- Responde en español de Chile, de tú, igual que el resto del sitio.
- Ve al grano: para preguntas simples, 1-2 párrafos cortos bastan. Para preguntas que de verdad lo \
requieren (explicar un proceso completo, comparar conceptos), puedes extenderte un poco más, pero \
evita relleno.
- Puedes usar **negritas** para resaltar términos clave y saltos de línea para separar ideas, pero no \
abuses de encabezados ni listas larguísimas: es un chat, no un apunte.
- Si la pregunta es ambigua o muy amplia, responde lo más útil que puedas con una interpretación \
razonable en vez de solo pedir que la aclaren.
- No inventes fórmulas, fechas, cifras ni nombres. Si no estás seguro después de buscar, dilo.`;

/**
 * Ejecuta buscar_en_temario y arma el string que se le devuelve al modelo
 * como resultado de la herramienta.
 */
function runBuscarEnTemario(input) {
  const consulta = (input && input.consulta) || '';
  const results = contentSearch.search(consulta, { limit: 3 });
  if (!results.length) {
    return {
      texto: JSON.stringify({ encontrado: false, mensaje: 'No se encontraron subtemas del sitio relevantes para esta búsqueda.' }),
      fuentes: [],
    };
  }
  const payload = results.map(r => ({
    cita: r.cita,
    asignatura: r.asignatura,
    unidad: r.unidad,
    subtema: r.subtema,
    contenido: r.contenido,
  }));
  return {
    texto: JSON.stringify({ encontrado: true, resultados: payload }),
    fuentes: results.map(r => ({ id: r.id, cita: r.cita })),
  };
}

function extractCitationsFromResponse(content) {
  const webSources = [];
  const seen = new Set();
  for (const block of content) {
    if (block.type === 'text' && Array.isArray(block.citations)) {
      for (const c of block.citations) {
        if (c.url && !seen.has(c.url)) {
          seen.add(c.url);
          webSources.push({ url: c.url, title: c.title || c.url });
        }
      }
    }
  }
  return webSources;
}

function extractText(content) {
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n\n').trim();
}

/**
 * Punto de entrada principal. `history` es un arreglo opcional de
 * {role:'user'|'assistant', content:string} con turnos previos (se
 * recomienda mandar como máximo los últimos 6-8 turnos desde el
 * cliente, para no disparar el costo de tokens en conversaciones largas).
 */
async function askAssistant(message, history = []) {
  const messages = [
    ...history
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  const siteSourcesUsed = new Map();
  let lastResponse = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [BUSCAR_TEMARIO_TOOL, WEB_SEARCH_TOOL],
      messages,
    });
    lastResponse = response;

    if (response.stop_reason === 'tool_use') {
      // Puede haber texto + uno o más tool_use de buscar_en_temario (herramienta
      // nuestra) mezclados con server_tool_use de web_search ya resueltos.
      const customCalls = response.content.filter(b => b.type === 'tool_use' && b.name === 'buscar_en_temario');

      messages.push({ role: 'assistant', content: response.content });

      if (customCalls.length === 0) {
        // No debería pasar (stop_reason tool_use siempre trae al menos una
        // tool_use nuestra pendiente), pero por robustez: si no hay nada que
        // nosotros debamos ejecutar, no seguimos insistiendo en el loop.
        break;
      }

      const toolResults = customCalls.map(call => {
        const { texto, fuentes } = runBuscarEnTemario(call.input);
        fuentes.forEach(f => siteSourcesUsed.set(f.id, f.cita));
        return { type: 'tool_result', tool_use_id: call.id, content: texto };
      });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    if (response.stop_reason === 'pause_turn') {
      // Turno largo del lado del servidor (varias búsquedas web encadenadas):
      // se reenvía el contenido tal cual para que la API continúe solo.
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    // end_turn / max_tokens / cualquier otro: terminamos acá.
    break;
  }

  const reply = lastResponse ? extractText(lastResponse.content) : '';
  const webSources = lastResponse ? extractCitationsFromResponse(lastResponse.content) : [];

  return {
    reply: reply || 'No pude generar una respuesta esta vez. ¿Puedes reformular la pregunta?',
    siteSources: Array.from(siteSourcesUsed.values()),
    webSources,
  };
}

module.exports = { askAssistant, MODEL };
