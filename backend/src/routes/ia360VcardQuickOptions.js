// G-FIX5: tarjeta CORTA de opciones rápidas cuando el vCard NO tiene señal.
//
// Problema: cuando `suggestIa360Persona` no devuelve señal (nombre neutro tipo
// "Musio Lopez"), el flujo caía directo al FALLBACK que muestra la LISTA COMPLETA
// de 10 personas (sendIa360VcardPersonaList). Demasiada fricción para el caso más
// común. Decisión de Alek: anteponer una tarjeta corta con SOLO 4 opciones
// rápidas + una 5ª fila "Ver todas las personas…" que reabre la lista completa.
//
// Las 4 opciones rápidas REUSAN el dispatch existente: emiten los MISMOS ids
// `owner_pipe:<num>:<key>` que la lista de 10, así que rutean a la misma lógica
// (handleIa360OwnerPipelineChoice → handleIa360PersonaChoice / terminal "guardar").
// La 5ª fila usa un id propio `owner_vcard_seeall:<num>` que reabre la lista.
//
// "Referido / BNI": Alek usa mucho este flujo con miembros de BNI Industrial.
// Antes la primera fila decía "Prospecto / pide info" aunque internamente mapeaba
// a `persona_referido`; eso ocultaba la opción BNI y llevó a clasificar contactos
// de capítulo como beta/amigo. La UI debe decir explícitamente BNI.
//
// Módulo PURO (cero require/IO) → testeable sin deps externas.

'use strict';

// Trunca respetando límites de la API de WhatsApp para list rows (title<=24,
// description<=72). Misma semántica que `compact` de ia360PersonaSuggest.js.
function compact(text, max) {
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

// Las 4 opciones rápidas, en orden. `key` es el sufijo del id
// `owner_pipe:<num>:<key>` (existente). "guardar" es un IA360_TERMINAL_VCARD_CHOICES
// (captura sin secuencia). El title va <=24 y la description <=72.
const VCARD_QUICK_OPTIONS = [
  { key: 'persona_referido', title: 'Referido / BNI', description: 'Miembro BNI, intro o recomendación' },
  { key: 'persona_beta', title: 'Beta / amigo', description: 'Conocido, técnico o prueba de confianza' },
  { key: 'persona_cliente', title: 'Cliente activo', description: 'Ya es cliente: engage o deleitar' },
  { key: 'guardar', title: 'Solo guardar', description: 'Captura el contacto sin enviar nada' },
];

// id de la fila "Ver todas las personas…" (reabre la lista completa de 10).
function seeAllRowId(contactNumber) {
  return `owner_vcard_seeall:${contactNumber}`;
}

// Construye las filas (5) de la tarjeta corta de opciones rápidas para un
// contacto. Las 4 primeras reusan `owner_pipe:<num>:<key>`; la 5ª es
// `owner_vcard_seeall:<num>`. Conserva SIEMPRE las 5 filas.
function buildVcardQuickRows({ contactNumber } = {}) {
  const rows = VCARD_QUICK_OPTIONS.map(o => ({
    id: `owner_pipe:${contactNumber}:${o.key}`,
    title: compact(o.title, 24),
    description: compact(o.description, 72),
  }));
  rows.push({
    id: seeAllRowId(contactNumber),
    title: compact('Ver todas las personas…', 24),
    description: compact('Abrir la lista completa de clasificación', 72),
  });
  return rows;
}

module.exports = {
  buildVcardQuickRows,
  seeAllRowId,
  VCARD_QUICK_OPTIONS,
  compact,
};
