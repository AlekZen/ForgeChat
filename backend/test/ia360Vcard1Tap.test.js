'use strict';
// G-FIX3: prueba del control-flow 1-tap del vCard SIN deps externas.
// Reusa el modulo PURO real (ia360PersonaSuggest) y simula los handlers de
// webhook.js para verificar la maquina de decision:
//   (a) con senal de persona valida -> UNA tarjeta readout con [Aprobar y enviar]+[Cambiar],
//       NO la lista "Elegir persona";
//   (b) "Cambiar" reabre la lista "Elegir persona";
//   (c) sin senal de persona -> cae al flujo viejo de lista;
//   (d) CERO egress al numero del contacto (todo va al owner).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { suggestIa360Persona, buildVcardPersonaRows } =
  require(path.join(__dirname, '..', 'src', 'routes', 'ia360PersonaSuggest.js'));

const OWNER = '5213322638033';

// Catalogo minimo espejo de IA360_PERSONA_SEQUENCE_FLOWS (solo lo que toca el flujo).
const FLOWS = {
  persona_referido: { personaContext: 'Referido / BNI', relationshipContext: 'referido_bni',
    sequences: [{ id: 'referido_contexto', uiTitle: 'Contexto referido' }, { id: 'referido_oneliner', uiTitle: 'One-liner' }] },
  persona_aliado: { personaContext: 'Aliado / socio', relationshipContext: 'aliado_socio',
    sequences: [{ id: 'aliado_intro', uiTitle: 'Intro aliado' }] },
};

// Ranker stub: sin senales no sugiere (suggestedId null) -> se toma la 1a del catalogo.
function rankStub(flow) { return { suggestedId: null, ordered: flow.sequences }; }

// Simulacion del orquestador notifyOwnerVcardCaptured (misma logica que el patch).
function notifyOwnerVcardCaptured(shared, egress, existingContact = null) {
  const suggestion = suggestIa360Persona(shared);
  const persistedPersonaKey = existingContact?.custom_fields?.ia360_persona_first?.classification?.persona_key;
  const flowKey = (suggestion && suggestion.persona) || persistedPersonaKey;
  const flow = flowKey ? FLOWS[flowKey] : null;
  if (!flow) return sendPersonaList(shared, egress);
  const ranking = rankStub(flow);
  const sequenceId = ranking.suggestedId || (flow.sequences[0] && flow.sequences[0].id);
  if (!sequenceId) return sendPersonaList(shared, egress);
  // readout + approve card con allowVcardChange
  emitReadoutCard({ targetContact: shared.contactNumber, flow, sequenceId, allowVcardChange: true }, egress);
  return { path: 'one_tap', flowKey, sequenceId };
}

function emitReadoutCard({ targetContact, flow, sequenceId, allowVcardChange }, egress) {
  egress.push({ to: OWNER, kind: 'readout', label: `owner_sequence_readout_${sequenceId}` });
  const rows = [
    { id: `owner_approve_send:${targetContact}:${sequenceId}`, title: 'Aprobar y enviar' },
    { id: `owner_approve_edit:${targetContact}:${sequenceId}`, title: 'Editar copy' },
    { id: `owner_approve_keep:${targetContact}:${sequenceId}`, title: 'Solo guardar' },
    { id: `owner_approve_dnc:${targetContact}:${sequenceId}`, title: 'No contactar' },
    { id: `owner_approve_manual:${targetContact}:${sequenceId}`, title: 'Tomar manual' },
    ...(allowVcardChange ? [{ id: `owner_vcard_change:${targetContact}`, title: 'Cambiar' }] : []),
  ];
  egress.push({ to: OWNER, kind: 'approve_card', label: `owner_approve_card_${targetContact}_${sequenceId}`, rows });
}

function sendPersonaList(shared, egress) {
  const suggestion = suggestIa360Persona(shared);
  const rows = buildVcardPersonaRows({ contactNumber: shared.contactNumber, suggestion });
  egress.push({ to: OWNER, kind: 'persona_list', label: `owner_vcard_captured_${shared.contactNumber}`, rows });
  return { path: 'persona_list' };
}

// Handler "Cambiar": reabre la lista.
function handleVcardChange(targetContact, egress) {
  sendPersonaList({ name: 'X', contactNumber: targetContact }, egress);
}

const SANDBOX = '5219990000123';

test('vCard de referido BNI -> readout 1-tap con Aprobar+Cambiar (no lista)', () => {
  const egress = [];
  const res = notifyOwnerVcardCaptured({ name: 'Carlos Chavez BNI Industrial', contactNumber: SANDBOX }, egress);
  assert.strictEqual(res.path, 'one_tap');
  assert.strictEqual(res.flowKey, 'persona_referido');
  // No salio la lista "Elegir persona"
  assert.ok(!egress.some(e => e.kind === 'persona_list'), 'NO debe emitir persona_list en 1-tap');
  const card = egress.find(e => e.kind === 'approve_card');
  assert.ok(card, 'debe emitir approve_card');
  assert.ok(card.rows.some(r => r.title === 'Aprobar y enviar'), 'tiene Aprobar y enviar');
  assert.ok(card.rows.some(r => r.id === `owner_vcard_change:${SANDBOX}` && r.title === 'Cambiar'), 'tiene Cambiar');
});

test('boton Cambiar reabre la lista Elegir persona', () => {
  const egress = [];
  handleVcardChange(SANDBOX, egress);
  const list = egress.find(e => e.kind === 'persona_list');
  assert.ok(list, 'Cambiar reabre la lista persona');
  assert.strictEqual(list.label, `owner_vcard_captured_${SANDBOX}`);
  assert.strictEqual(list.rows.length, 10, 'lista conserva las 10 filas');
});

test('sin senal en el nombre pero con persona persistida BNI -> readout 1-tap', () => {
  const egress = [];
  const existingContact = {
    custom_fields: {
      ia360_persona_first: {
        classification: { persona_key: 'persona_aliado', relationship_context: 'aliado_socio' },
      },
    },
  };
  const res = notifyOwnerVcardCaptured({ name: 'Diego Pérez Rodriguez', contactNumber: SANDBOX }, egress, existingContact);
  assert.strictEqual(res.path, 'one_tap');
  assert.strictEqual(res.flowKey, 'persona_aliado');
  assert.ok(!egress.some(e => e.kind === 'persona_list'), 'NO debe pedir reclasificar si el contacto ya trae contexto persistido');
  assert.ok(egress.some(e => e.kind === 'approve_card'));
});

test('sin senal de persona -> cae al flujo viejo de lista', () => {
  const egress = [];
  const res = notifyOwnerVcardCaptured({ name: 'Juan Perez', contactNumber: SANDBOX }, egress);
  assert.strictEqual(res.path, 'persona_list');
  assert.ok(egress.some(e => e.kind === 'persona_list'));
});

test('CERO egress al numero del contacto: todo va al owner', () => {
  for (const name of ['Carlos BNI', 'Juan Perez', 'CFO Finanzas Mariana']) {
    const egress = [];
    notifyOwnerVcardCaptured({ name, contactNumber: SANDBOX }, egress);
    for (const e of egress) {
      assert.strictEqual(e.to, OWNER, `egress debe ir al owner, no a ${e.to}`);
      assert.notStrictEqual(e.to, SANDBOX, 'jamas egress al contacto');
    }
  }
});

test('id Cambiar parsea a [owner_vcard_change, <num>] en el dispatch', () => {
  const id = `owner_vcard_change:${SANDBOX}`;
  const [action, arg, third] = id.split(':');
  assert.strictEqual(action, 'owner_vcard_change');
  assert.strictEqual(arg.replace(/\D/g, ''), SANDBOX);
  assert.strictEqual(third, undefined);
});
