/* =====================================================================
   contentSearch.js
   =====================================================================
   Índice de búsqueda en memoria sobre el temario propio del sitio
   (content-data.json, generado por scripts/extract-content.js a partir
   de app.js). Esto es lo que la IA usa para "buscar primero en la web"
   antes de salir a internet: si el estudiante pregunta algo que el
   sitio ya explica, la respuesta debe salir de ahí — con cita exacta
   de dónde (asignatura · unidad · subtema) — y no de una búsqueda web.

   Por qué MiniSearch y no algo más pesado (embeddings, vector DB): el
   temario completo son 75 subtemas (~165 mil caracteres en total). Un
   índice de texto completo en memoria responde en milisegundos, no
   necesita llamadas a una API externa de embeddings (más costo, más
   latencia, una dependencia más que puede fallar) y es más que
   suficiente para este tamaño de contenido. Si el temario creciera
   mucho más (miles de subtemas), ahí sí valdría la pena reevaluar.

   Normalización: se comparan las palabras sin tildes y en minúsculas
   (processTerm), para que "fotosintesis" encuentre "fotosíntesis" y
   viceversa — muy común al escribir rápido desde el celular.
   ===================================================================== */
'use strict';
const MiniSearch = require('minisearch');
const contentData = require('../data/content-data.json');

function stripDiacritics(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/gi, m => (m === 'ñ' ? 'n' : 'N'));
}

// Palabras funcionales en español (artículos, preposiciones, pronombres
// interrogativos, conjunciones...). Sin filtrarlas, "¿cuál es la capital
// de Francia?" -- una pregunta 100% fuera de tema -- alcanzaba scores más
// altos que preguntas genuinas de ciencias, solo por acumular coincidencias
// parciales/difusas de "cual", "es", "la", "de" contra el temario. Al
// quitarlas, el score queda dominado por las palabras con contenido real
// (sustantivos/verbos propios del tema), que es justo lo que se necesita
// para distinguir preguntas dentro y fuera de alcance.
const STOPWORDS = new Set([
  'a','al','algo','algun','alguna','algunas','alguno','algunos','ante','asi','aun',
  'cada','como','con','cual','cuales','cuando','cuanto','cuanta','cuantos','cuantas',
  'de','del','desde','donde','dos','el','ella','ellas','ellos','en','entre','era',
  'es','esa','esas','ese','eso','esos','esta','estan','estas','este','esto','estos',
  'fue','fueron','ha','hace','hacia','han','hasta','hay','la','las','le','les','lo',
  'los','mas','me','mi','mis','mucho','muy','nada','ni','no','nos','nosotros','o',
  'os','otra','otras','otro','otros','para','pero','poco','por','porque','pues',
  'que','quien','quienes','se','segun','ser','si','sin','sobre','solo','son','su',
  'sus','tal','tambien','tan','te','tiene','tienen','todo','toda','todos','todas',
  'tu','tus','un','una','unas','uno','unos','y','ya','yo',
]);

function processTerm(term) {
  const t = stripDiacritics(term.toLowerCase());
  if (t.length <= 1) return null;
  if (STOPWORDS.has(t)) return null;
  return t;
}

const miniSearch = new MiniSearch({
  idField: 'id',
  fields: ['subtopicName', 'unitName', 'subjectName', 'text'],
  storeFields: ['id', 'subjectKey', 'subjectName', 'unitId', 'unitNumber', 'unitName', 'subtopicName', 'text'],
  processTerm,
  searchOptions: {
    boost: { subtopicName: 4, unitName: 2, subjectName: 1.2, text: 1 },
    prefix: true,
    fuzzy: 0.15,
  },
});
miniSearch.addAll(contentData.entries);

const byId = new Map(contentData.entries.map(e => [e.id, e]));

/**
 * Arma el texto de cita exacto que pide el pedido original:
 * "biología unidad 2, título del tema".
 */
function citationLabel(entry) {
  return `${entry.subjectName} · Unidad ${entry.unitNumber}: ${entry.unitName} · ${entry.subtopicName}`;
}

/**
 * Busca en el temario propio. Devuelve como máximo `limit` subtemas,
 * con su texto COMPLETO (no un fragmento corto) para que el modelo
 * tenga contexto real con el que responder, no solo una oración suelta.
 */
function search(query, { limit = 3, minScore = 4 } = {}) {
  if (!query || !query.trim()) return [];
  const hits = miniSearch.search(query.trim(), { boost: { subtopicName: 4, unitName: 2, subjectName: 1.2, text: 1 }, prefix: true, fuzzy: 0.15 });
  return hits
    .filter(h => h.score >= minScore)
    .slice(0, limit)
    .map(h => {
      const entry = byId.get(h.id);
      return {
        id: entry.id,
        cita: citationLabel(entry),
        asignatura: entry.subjectName,
        unidad: `Unidad ${entry.unitNumber}: ${entry.unitName}`,
        subtema: entry.subtopicName,
        contenido: entry.text,
        relevancia: Math.round(h.score * 100) / 100,
      };
    });
}

function getById(id) {
  const entry = byId.get(id);
  return entry ? { ...entry, cita: citationLabel(entry) } : null;
}

function stats() {
  const bySubject = {};
  contentData.entries.forEach(e => { bySubject[e.subjectName] = (bySubject[e.subjectName] || 0) + 1; });
  return { total: contentData.entries.length, bySubject, generatedAt: contentData.generatedAt };
}

module.exports = { search, getById, citationLabel, stats };
