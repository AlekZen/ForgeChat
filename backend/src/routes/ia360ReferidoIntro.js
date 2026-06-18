// G9 (2026-06-16): reanima la INTRO del referido BNI (quien_intro).
//
// Contexto del gap (auditoria 2026-06-15-pipeline-aliado-bni-vs-journey, #2):
// en los BNI reales quien_intro=NULL porque solo se capturaba cuando un NO-owner
// compartia el vCard del referido. El owner (Alek) no tenia forma de teclear
// quien hizo la presentacion, asi que la secuencia referido_contexto se quedaba
// bloqueada: en frio con deny('cold_send_missing_quien_intro') y en caliente con
// el placeholder {{quien_intro}} (copyStatus 'blocked').
//
// Este modulo es PURO (cero requires, cero I/O): contiene el parser del comando
// del owner, el armado del mensaje de referido (draft caliente + variable fria)
// y el constructor del patch de custom_fields. webhook.js importa estas funciones
// para que el MISMO codigo que corre en produccion sea el que el test E2E ejerce.

'use strict';

const IA360_QUIEN_INTRO_PLACEHOLDER = '{{quien_intro}}';

// Comando del owner para teclear quien presento a un referido. Dos formatos
// naturales, ambos owner-only (el dispatch en webhook.js ya filtra por numero):
//   - "intro <contacto>: <quien presenta>"   (canonico; los dos puntos separan
//     sin ambiguedad, asi que sirve aun si el nombre del contacto trae " de ")
//   - "referido <contacto> de <quien presenta>"  (atajo; el primer " de " separa)
// Devuelve { target, introducer } con ambos trim, o null si no es el comando.
function parseIa360OwnerIntroCommand(body) {
  const text = String(body || '').trim();
  let m = text.match(/^intro\s+(.+?)\s*:\s*(.+)$/i);
  if (m && m[1].trim() && m[2].trim()) {
    return { target: m[1].trim(), introducer: m[2].trim() };
  }
  m = text.match(/^referido\s+(.+?)\s+de\s+(.+)$/i);
  if (m && m[1].trim() && m[2].trim()) {
    return { target: m[1].trim(), introducer: m[2].trim() };
  }
  return null;
}

// Sanitiza un nombre de introductor: quita controles/bidi/zero-width inyectables
// (un push name puede traerlos), borra llaves (no inyectar placeholders), colapsa
// espacios y topa a 60 code points. null si no queda nada con letras. Identico al
// sanitizeIa360IntroName del vCard para que ambos caminos compartan una sola regla.
function sanitizeIntroName(raw) {
  const clean = String(raw || '')
    .replace(/[\u0000-\u001F\u007F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const capped = Array.from(clean).slice(0, 60).join('').trim();
  if (!capped) return null;
  if (!/[\p{L}]/u.test(capped)) return null; // sin letras no sirve como nombre
  return capped;
}

// Compacta el quien_intro para el parametro {{2}} del template frio: colapsa
// espacios/saltos (Meta rechaza saltos de linea y 4+ espacios) y topa a max.
// Devuelve null si tras compactar no queda nada (=> cold_send_missing_quien_intro).
function compactQuienIntro(text, max = 60) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length <= max ? clean : clean.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

// Patch de custom_fields para el contacto referido a partir de la intro tecleada.
// quien_intro (ya sanitizado) es la senal primaria y siempre gana. referido_por
// solo se setea si el aliado real se resolvio a un numero distinto del owner, del
// bot y del propio contacto: nunca apuntamos el referido al owner.
function buildIntroCustomFields({
  quienIntroName, introducerNumber, ownerNumber, contactNumber, botNumber, nowIso,
}) {
  const patch = {
    quien_intro: quienIntroName,
    intro_capturada_por: 'owner-comando',
    intro_capturada_at: nowIso,
  };
  const n = introducerNumber ? String(introducerNumber).replace(/\D/g, '') : '';
  if (n && n !== String(ownerNumber || '') && n !== String(botNumber || '') && n !== String(contactNumber || '')) {
    patch.referido_por = n;
  }
  return patch;
}

// Draft del opener caliente referido_contexto.
// G-FIX3b (2026-06-18, decision de Alek): 1-tap PURO para referidos. La AUSENCIA
// de quien_intro ya NO bloquea. Dos variantes, ambas SIN placeholder sin resolver:
//   - con quienIntro: intro personalizada que menciona quien presentó (G11 intacto).
//   - sin quienIntro: variante natural que alude a "un contacto en común" SIN
//     nombrar al introductor (nada de {{quien_intro}} literal), para que el readout
//     salga directo con [Aprobar y enviar]+[Cambiar] en vez de pedir el comando intro.
// El comando "intro <contacto>: <quien>" sigue enriqueciendo: al capturar quien_intro
// el siguiente readout usa la variante personalizada.
function buildReferidoContextoDraft({ name, quienIntro }) {
  const who = String(quienIntro || '').trim();
  const saludo = String(name || '').trim() ? `Hola ${String(name).trim()}` : 'Hola';
  if (who) {
    return `${saludo}, soy la IA de Alek. Te escribo porque nos presentó ${who} y, antes de mandarte cualquier propuesta, Alek quiere entender tu contexto para no escribirte algo fuera de lugar. ¿Cómo prefieres empezar?`;
  }
  return `${saludo}, soy la IA de Alek. Te escribo porque tenemos un contacto en común y, antes de proponerte nada, Alek quiere entender un poco tu contexto para no escribirte algo fuera de lugar. ¿Cómo prefieres empezar?`;
}

// True si el texto trae el placeholder de quien_intro sin resolver.
function hasUnresolvedQuienIntroPlaceholder(text) {
  return String(text || '').includes(IA360_QUIEN_INTRO_PLACEHOLDER);
}

// G11: predicado puro "secuencia bloqueada por quien_intro". True cuando el draft
// arrastra el placeholder {{quien_intro}} sin resolver Y el contacto NO tiene
// quien_intro capturado. Las dos condiciones van juntas a propósito: en
// referido_contexto el placeholder aparece exactamente cuando falta el dato
// (ver buildReferidoContextoDraft), pero exigir ambas hace el predicado robusto
// para cualquier secuencia y deja claro el lado "desbloqueado" (quienIntro
// presente => false, aunque por error quedara un placeholder en el texto).
function isSequenceBlockedByMissingQuienIntro({ draft, quienIntro } = {}) {
  return hasUnresolvedQuienIntroPlaceholder(draft) && !String(quienIntro || '').trim();
}

// G11: mensaje accionable para el owner cuando un referido se bloquea por falta
// de quien_intro. Le da el COMANDO EXACTO y copiable que entiende
// parseIa360OwnerIntroCommand ("intro <contacto>: <quien presenta>") con el
// nombre real del contacto, para que sepa qué teclear y desbloquee el envío.
function buildIntroNeededMessage({ name } = {}) {
  const display = String(name || '').trim() || 'este contacto';
  return `Para enviarle a ${display} primero necesito saber quién lo presentó. Escríbeme:\n\nintro ${display}: <quién lo presentó>\n\ny te dejo el envío listo para aprobar.`;
}

module.exports = {
  IA360_QUIEN_INTRO_PLACEHOLDER,
  parseIa360OwnerIntroCommand,
  sanitizeIntroName,
  compactQuienIntro,
  buildIntroCustomFields,
  buildReferidoContextoDraft,
  hasUnresolvedQuienIntroPlaceholder,
  isSequenceBlockedByMissingQuienIntro,
  buildIntroNeededMessage,
};
