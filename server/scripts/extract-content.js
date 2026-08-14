/* =====================================================================
   extract-content.js
   =====================================================================
   Qué hace: lee el app.js de la web (SIN modificarlo) y extrae de ahí
   los 4 arreglos de contenido — BIO_UNITS, FIS_UNITS, QUI_UNITS,
   MAT_UNITS — para generar src/data/content-data.json: una base de
   conocimiento plana (texto limpio, sin HTML/SVG) que el servidor usa
   en la herramienta `buscar_en_temario` del chat con IA.

   Por qué existe como script aparte (y no a mano): app.js tiene más de
   470 preguntas y decenas de tarjetas de estudio con diagramas SVG
   incrustados. Transcribir esto a mano sería lentísimo y, peor, se
   desincronizaría de la web real apenas alguien edite una tarjeta de
   estudio. Este script SIEMPRE reconstruye content-data.json desde la
   fuente real (app.js), así que nunca hay dos copias del contenido
   que puedan quedar desalineadas.

   Cómo se extrae de forma segura: los 4 arreglos de datos viven al
   inicio de app.js, ANTES de que el archivo empiece a tocar el DOM
   (`document.getElementById`, etc. — eso empieza recién en la sección
   de navegación, mucho más abajo). Este script recorta ese bloque
   puro de datos usando como límites el texto literal
   "const BIO_UNITS = [" y "\nconst SUBJECTS = {", verifica que el
   recorte no contenga referencias a document/window/localStorage (por
   si en el futuro alguien reordena el archivo) y recién entonces lo
   ejecuta como módulo de Node para obtener los objetos reales — nunca
   se "adivina" el contenido con regex frágiles.

   Cuándo correrlo: cada vez que cambie el contenido de estudio dentro
   de app.js (agregar/editar un subtema). No hace falta correrlo si
   solo cambia la lógica de la app (motor de cuestionarios, etc.).

   Uso:
     node scripts/extract-content.js [ruta/a/app.js]

   Si no se pasa ruta, busca "../app.js" relativo a esta carpeta (o sea,
   asume que app.js vive junto a la carpeta del servidor — ajusta la
   ruta según donde hayas puesto tus archivos).
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const APP_JS_PATH = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'app.js'));
const OUT_PATH = path.join(__dirname, '..', 'src', 'data', 'content-data.json');

const SUBJECT_META = {
  BIO_UNITS: { key: 'bio', name: 'Biología' },
  FIS_UNITS: { key: 'fis', name: 'Física' },
  QUI_UNITS: { key: 'qui', name: 'Química' },
  MAT_UNITS: { key: 'mat', name: 'Matemática' },
};

function stripHtml(html) {
  if (!html) return '';
  return html
    // Los diagramas SVG son ruido puro para un modelo de texto (miles de
    // coordenadas): se descartan enteros. El <figcaption> que describe la
    // figura en palabras vive FUERA del <svg>, así que no se pierde.
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function main() {
  if (!fs.existsSync(APP_JS_PATH)) {
    console.error(`✗ No se encontró app.js en: ${APP_JS_PATH}`);
    console.error('  Pásale la ruta correcta como argumento: node scripts/extract-content.js /ruta/a/app.js');
    process.exit(1);
  }
  const src = fs.readFileSync(APP_JS_PATH, 'utf8');

  const startMarker = 'const BIO_UNITS = [';
  const endMarker = '\nconst SUBJECTS = {';
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    console.error('✗ No se encontró el bloque de datos esperado (BIO_UNITS...SUBJECTS) en app.js.');
    console.error('  Si renombraste esas variables, actualiza startMarker/endMarker en este script.');
    process.exit(1);
  }
  const dataBlock = src.slice(startIdx, endIdx);

  // Verificación defensiva: este bloque debe ser datos puros, nunca código
  // que dependa del navegador. Si esto llegara a fallar, es una señal de
  // que app.js cambió de forma y hay que revisar el recorte a mano.
  if (/\b(document|window|localStorage|navigator)\s*\./.test(dataBlock)) {
    console.error('✗ El bloque de datos extraído parece usar el DOM (document/window/localStorage).');
    console.error('  Deteniéndose por seguridad: revisa manualmente antes de continuar.');
    process.exit(1);
  }

  // Se ejecuta el recorte como módulo real de Node (no regex) para obtener
  // los objetos JS tal cual los ve la web, con arreglos/strings ya resueltos.
  const tmpModulePath = path.join(__dirname, `_extracted-data-${process.pid}.cjs`);
  fs.writeFileSync(tmpModulePath, dataBlock + '\nmodule.exports = { BIO_UNITS, FIS_UNITS, QUI_UNITS, MAT_UNITS };\n');
  let data;
  try {
    delete require.cache[require.resolve(tmpModulePath)];
    data = require(tmpModulePath);
  } finally {
    fs.unlinkSync(tmpModulePath);
  }

  const entries = [];
  const seenIds = new Set();
  for (const [varName, units] of Object.entries(data)) {
    const meta = SUBJECT_META[varName];
    units.forEach((unit, unitIdx) => {
      (unit.subtopics || []).forEach((sub) => {
        if (seenIds.has(sub.id)) {
          console.warn(`⚠ id de subtema duplicado, se omite: ${sub.id}`);
          return;
        }
        seenIds.add(sub.id);
        entries.push({
          id: sub.id,
          subjectKey: meta.key,
          subjectName: meta.name,
          unitId: unit.id,
          unitNumber: unitIdx + 1,
          unitName: unit.name,
          subtopicName: sub.name,
          text: stripHtml(sub.content),
        });
      });
    });
  }

  if (entries.length === 0) {
    console.error('✗ Se extrajeron 0 subtemas. Algo salió mal — no se sobrescribe content-data.json.');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceFile: path.basename(APP_JS_PATH),
        count: entries.length,
        entries,
      },
      null,
      2
    )
  );

  console.log(`✓ content-data.json generado con ${entries.length} subtemas → ${path.relative(process.cwd(), OUT_PATH)}`);
  const bySubject = {};
  entries.forEach(e => { bySubject[e.subjectName] = (bySubject[e.subjectName] || 0) + 1; });
  Object.entries(bySubject).forEach(([name, n]) => console.log(`   - ${name}: ${n} subtemas`));
}

main();
