// G-FIX6 (2026-06-18): salida cuando una secuencia se bloquea por no aplicar.
//
// Contexto del gap (auditoria 2026-06-18 - Gaps vCard, caso real Musio):
// Alek eligio "Cliente activo" -> secuencia `cliente_expansion`, cuya guardia
// (D7) exige un DEAL VIVO (status='open') en P2 (IA360 WhatsApp Revenue Pipeline)
// o P7 (Champions). Musio no tiene deal -> el flujo emitia un texto tipo "Musio
// no tiene un proyecto activo... la secuencia solo aplica..." y TERMINABA sin
// ofrecer salida (callejon sin salida). La guardia es CORRECTA (no tratar a
// alguien sin proyecto como cliente activo); lo que faltaba era la SALIDA.
//
// Este modulo es PURO (cero requires, cero I/O). Contiene:
//   1. El COPY del mensaje de bloqueo (con boton + invitacion a texto libre).
//   2. El id del boton "Crear el deal y seguir" y su parser.
//   3. Un interprete HEURISTICO por palabras clave del texto libre del owner
//      cuando responde al bloqueo (crear deal / mandar info / guardar / cambiar
//      persona). Lo que el heuristico NO entiende cae a 'unknown' (el llamador
//      pide aclaracion; NUNCA queda mudo).
// webhook.js importa estas funciones para que el MISMO codigo que corre en
// produccion sea el que el test ejerce.

'use strict';

// Pipeline por defecto donde se CREA el deal faltante al desbloquear: el mismo
// que satisface la guardia (P2). Stage pos 0 (open) -> la guardia (status='open'
// en P2/P7) pasa de BLOCKED a CLEAR.
const IA360_BLOCKEXIT_DEAL_PIPELINE = 'IA360 WhatsApp Revenue Pipeline';
const IA360_BLOCKEXIT_DEAL_STAGE = 'Nuevo contacto WA';

// id del boton que crea el deal y re-emite el readout desbloqueado.
// Formato: owner_unblock_create_deal:<targetContact>:<sequenceId>
function buildIa360UnblockCreateDealButtonId(targetContact, sequenceId) {
  return `owner_unblock_create_deal:${String(targetContact || '').replace(/\D/g, '')}:${sequenceId}`;
}

// Mensaje (texto) que reemplaza el callejon sin salida. Da el boton (via tarjeta,
// armada por el llamador con este id) e INVITA a responder en texto libre.
// `sequenceLabel` es el nombre amable de la secuencia; `pipelineHint` el pipeline
// donde nacera el deal.
function buildIa360BlockExitMessage({ name, sequenceLabel }) {
  const who = name || 'el contacto';
  return [
    `${who} no tiene un proyecto activo (deal vivo en P2/P7), así que la secuencia «${sequenceLabel}» todavía no aplica. No envié nada.`,
    '',
    'Pero no es un callejón sin salida. Puedes:',
    `• Tocar «Crear el deal y seguir»: le abro un deal en «${IA360_BLOCKEXIT_DEAL_PIPELINE}» y te re-emito el readout listo para aprobar.`,
    '• O dime aquí en texto qué hago: «créale un deal», «mándale info», «déjalo guardado» o «cambiar persona».',
  ].join('\n');
}

// Interprete HEURISTICO (palabras clave) del texto libre del owner cuando
// responde a un bloqueo. Devuelve una intencion canonica + el texto crudo.
// Intenciones: 'create_deal' | 'send_info' | 'keep' | 'change_persona' | 'unknown'.
// Es deliberadamente conservador: ante ambiguedad real -> 'unknown' (el llamador
// pide aclaracion). NO es interpretacion por IA (eso queda al owner-operator de
// Brain v2, pendiente); aqui solo reglas simples y auditables.
function interpretIa360BlockExitReply(rawText) {
  const t = String(rawText || '').toLowerCase().trim();
  if (!t) return { intent: 'unknown', text: '' };
  // normaliza acentos para el match
  const n = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const has = (...words) => words.some(w => n.includes(w));

  // cambiar persona / secuencia (revisar antes de "deal": "cambiar" es prioritario)
  if (has('cambiar persona', 'cambia persona', 'otra persona', 'cambiar secuencia',
          'cambia secuencia', 'otra secuencia', 'cambiar la persona')) {
    return { intent: 'change_persona', text: rawText };
  }
  // crear deal / proyecto
  if (has('crea', 'crear', 'creale', 'abrele', 'abrir deal', 'nuevo deal', 'abre un deal',
          'abrele un deal', 'deal en', 'proyecto') && has('deal', 'proyecto', 'p2', 'p7')) {
    return { intent: 'create_deal', text: rawText };
  }
  // crear deal forma corta ("creale", "abrele un deal")
  if (has('creale', 'abrele', 'crear deal', 'crea deal', 'crea el deal', 'crear el deal')) {
    return { intent: 'create_deal', text: rawText };
  }
  // mandar info
  if (has('manda', 'mandale', 'envia', 'enviale', 'mandar info', 'pasa info', 'pasale info',
          'mandale info', 'info')) {
    return { intent: 'send_info', text: rawText };
  }
  // dejar guardado
  if (has('guarda', 'guardalo', 'dejalo guardado', 'solo guardar', 'deja guardado',
          'guardado', 'guardar')) {
    return { intent: 'keep', text: rawText };
  }
  return { intent: 'unknown', text: rawText };
}

module.exports = {
  IA360_BLOCKEXIT_DEAL_PIPELINE,
  IA360_BLOCKEXIT_DEAL_STAGE,
  buildIa360UnblockCreateDealButtonId,
  buildIa360BlockExitMessage,
  interpretIa360BlockExitReply,
};
