// G-FIX6 (2026-06-18): salida cuando una secuencia (cliente_expansion) se bloquea
// por falta de deal vivo. Caso real Musio. La guardia es CORRECTA; lo que faltaba
// era la SALIDA: (1) botón «Crear el deal y seguir» + (2) invitación a texto libre
// que se rutea a un intérprete heurístico por palabras clave.
//
// Las funciones puras ejercidas (buildIa360BlockExitMessage,
// interpretIa360BlockExitReply, buildIa360UnblockCreateDealButtonId) son las que
// webhook.js importa en prod. El cableado (dispatch del botón, re-emisión del
// readout, routing del texto pendiente) se afirma contra el fuente de webhook.js.
// Cero deps externas (sin pg/red).

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  IA360_BLOCKEXIT_DEAL_PIPELINE,
  IA360_BLOCKEXIT_DEAL_STAGE,
  buildIa360UnblockCreateDealButtonId,
  buildIa360BlockExitMessage,
  interpretIa360BlockExitReply,
} = require('../src/routes/ia360BlockExit');

const WEBHOOK_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'webhook.js'), 'utf8'
);

// ── Caso A: bloqueo → mensaje con salida (botón + invitación a texto) ──────────
test('mensaje de bloqueo NO es callejón: ofrece botón y texto libre', () => {
  const msg = buildIa360BlockExitMessage({ name: 'Musio', sequenceLabel: 'Cliente activo' });
  assert.match(msg, /no tiene un proyecto activo/i);
  assert.match(msg, /Crear el deal y seguir/i);          // alude al botón
  assert.match(msg, /en texto/i);                         // invita a responder en texto
  assert.match(msg, /créale un deal|déjalo guardado|mándale info|cambiar persona/i);
  assert.match(msg, /Cliente activo/);                    // nombra la secuencia
});

test('id del botón crear-deal es claro y parseable (action:contacto:secuencia)', () => {
  const id = buildIa360UnblockCreateDealButtonId('5219990001234', 'cliente_expansion');
  assert.equal(id, 'owner_unblock_create_deal:5219990001234:cliente_expansion');
  const [action, num, seq] = id.split(':');
  assert.equal(action, 'owner_unblock_create_deal');
  assert.equal(num, '5219990001234');
  assert.equal(seq, 'cliente_expansion');
});

// ── Caso C: interpretación heurística del texto libre del owner ────────────────
test('intérprete heurístico reconoce intenciones simples (con acentos)', () => {
  assert.equal(interpretIa360BlockExitReply('créale un deal en P2').intent, 'create_deal');
  assert.equal(interpretIa360BlockExitReply('crea el deal y sigue').intent, 'create_deal');
  assert.equal(interpretIa360BlockExitReply('déjalo guardado').intent, 'keep');
  assert.equal(interpretIa360BlockExitReply('solo guardar').intent, 'keep');
  assert.equal(interpretIa360BlockExitReply('mándale info').intent, 'send_info');
  assert.equal(interpretIa360BlockExitReply('cambiar persona').intent, 'change_persona');
});

test('ante texto ambiguo el heurístico NO adivina (unknown)', () => {
  assert.equal(interpretIa360BlockExitReply('hola que tal').intent, 'unknown');
  assert.equal(interpretIa360BlockExitReply('').intent, 'unknown');
});

// ── Caso B: cableado — el tap crea el deal y RE-EMITE el readout ───────────────
test('la guardia no_live_deal ya NO termina muda: llama a emitIa360BlockExitOffer', () => {
  assert.match(WEBHOOK_SRC, /emitIa360BlockExitOffer\(\{ record, targetContact, name, sequence \}\)/);
  // y ya no usa el viejo deny terminal con "elige otra secuencia"
  assert.doesNotMatch(WEBHOOK_SRC, /deny\('no_live_deal'/);
});

test('el dispatch del botón rutea a handleIa360UnblockCreateDeal', () => {
  assert.match(WEBHOOK_SRC, /ownerAction === 'owner_unblock_create_deal'/);
  assert.match(WEBHOOK_SRC, /handleIa360UnblockCreateDeal\(\{ record, targetContact, sequenceId: ownerPipe \}\)/);
});

test('handleIa360UnblockCreateDeal crea el deal en P2 y re-emite el readout', () => {
  // crea el deal con el pipeline/stage del módulo
  assert.match(WEBHOOK_SRC, /targetStageName: IA360_BLOCKEXIT_DEAL_STAGE/);
  assert.match(WEBHOOK_SRC, /pipelineName: IA360_BLOCKEXIT_DEAL_PIPELINE/);
  // re-emite el MISMO readout compartido (no duplica lógica)
  assert.match(WEBHOOK_SRC, /handleIa360UnblockCreateDeal[\s\S]*emitIa360SequenceReadoutCard\(\{ record, targetContact, flow, sequence, contact \}\)/);
});

test('el texto pendiente del owner se rutea al intérprete antes del canary', () => {
  assert.match(WEBHOOK_SRC, /handleIa360BlockExitReply\(record\)/);
  // create_deal del texto reusa el MISMO handler que el botón
  assert.match(WEBHOOK_SRC, /intent === 'create_deal'[\s\S]*handleIa360UnblockCreateDeal/);
});

// El pipeline por defecto es el que satisface la guardia (P2).
test('el deal se crea en el pipeline que satisface la guardia (P2, stage inicial)', () => {
  assert.equal(IA360_BLOCKEXIT_DEAL_PIPELINE, 'IA360 WhatsApp Revenue Pipeline');
  assert.equal(IA360_BLOCKEXIT_DEAL_STAGE, 'Nuevo contacto WA');
});
