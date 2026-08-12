'use strict';

// F4 (auditoría WhatsApp 2026-08-12).
//
// El ledger `ia360_bot_failures` sólo envejecía las promesas del fallback de
// no-silencio. Las promesas que hace el AGENTE en una conversación normal —a
// Elliot: "¿Quieres que te arme un mini-plan…?"— no las registraba nadie: si el
// contacto decía que sí, no había cola, ni digest, ni recordatorio. El ciclo de
// mejora continua sólo cierra si TODA promesa entra al mismo ledger.
//
// Detector deliberadamente conservador: verbos en primera persona con compromiso
// futuro explícito. Una pregunta ("¿te armo un mini-plan?") también cuenta: el
// contacto la lee como oferta y esperará la entrega.

// Se cubren indicativo ("te armo") y subjuntivo del ofrecimiento ("¿quieres que te
// arme…?"): para el contacto ambas son el mismo compromiso.
const PROMESA_RE = /\bte\s+(confirmo|confirme|aviso|avise|comparto|comparta|armo|arme|mando|mande|env[íi]o|env[íi]e|preparo|prepare|paso|pase)\b|\ben breve\b|\bte escribe\s+(él|el|Alek)\b/i;

function detectIa360AgentPromise(body) {
  return PROMESA_RE.test(String(body || ''));
}

module.exports = { detectIa360AgentPromise, PROMESA_RE };
