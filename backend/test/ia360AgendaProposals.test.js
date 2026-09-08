// test/ia360AgendaProposals.test.js — Pruebas de comportamiento observable para propuestas de agenda,
// validación de fronteras, estados de incertidumbre ante respuestas no verificadas y asistencia supervisada.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  validateProposalInput,
  computePayloadHash,
  executeBookWriter,
  executeCancelWriter,
  handleOwnerAgendaDecision,
  handleOwnerFailureAssistance,
} = require('../src/services/ia360AgendaProposals');

test('validateProposalInput: validación de contratos de reserva y cancelación', () => {
  const futureStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const futureEnd = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString();

  // Reserva válida
  const validBook = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    source_message_id: 'wamid.HBgLMTIzNDU2Nw==',
    kind: 'book',
    start_utc: futureStart,
    end_utc: futureEnd,
    title: 'Sesión de Estrategia',
  });
  assert.equal(validBook.ok, true);
  assert.equal(validBook.sanitized.kind, 'book');
  assert.equal(validBook.sanitized.source_message_id, 'wamid.HBgLMTIzNDU2Nw==');

  // Rechazo de fecha en el pasado
  const pastBook = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    source_message_id: 'wamid.past',
    kind: 'book',
    start_utc: '2020-01-01T15:00:00.000Z',
    end_utc: '2020-01-01T16:00:00.000Z',
  });
  assert.equal(pastBook.ok, false);
  assert.ok(pastBook.errors.includes('start_must_be_in_future'));

  // Rechazo de falta de source_message_id
  const noSourceMsg = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    kind: 'book',
    start_utc: futureStart,
    end_utc: futureEnd,
  });
  assert.equal(noSourceMsg.ok, false);
  assert.ok(noSourceMsg.errors.includes('source_message_id_required'));

  // Cancelación válida
  const validCancel = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    source_message_id: 'wamid.cancel1',
    kind: 'cancel',
    event_id: 'evt_google_12345',
  });
  assert.equal(validCancel.ok, true);
  assert.equal(validCancel.sanitized.kind, 'cancel');

  // dry_run estricto
  const falseDryRun = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    source_message_id: 'wamid.dryfalse',
    kind: 'cancel',
    event_id: 'evt_1',
    dry_run: 'false',
  });
  assert.equal(falseDryRun.sanitized.dry_run, false);

  const trueDryRun = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    source_message_id: 'wamid.drytrue',
    kind: 'cancel',
    event_id: 'evt_1',
    dry_run: 'true',
  });
  assert.equal(trueDryRun.sanitized.dry_run, true);
});

test('computePayloadHash: unicidad canónica por slot y acción', () => {
  const hash1 = computePayloadHash({
    kind: 'book',
    start_utc: '2026-09-10T15:00:00.000Z',
    end_utc: '2026-09-10T16:00:00.000Z',
    title: 'Demo',
  });
  const hash2 = computePayloadHash({
    kind: 'book',
    start_utc: '2026-09-10T15:00:00.000Z',
    end_utc: '2026-09-10T16:00:00.000Z',
    title: 'Demo',
  });
  const hashDiffSlot = computePayloadHash({
    kind: 'book',
    start_utc: '2026-09-10T17:00:00.000Z',
    end_utc: '2026-09-10T18:00:00.000Z',
    title: 'Demo',
  });

  assert.equal(hash1, hash2, 'mismo payload debe generar el mismo hash');
  assert.notEqual(hash1, hashDiffSlot, 'distinto horario debe generar un hash distinto');
});

test('executeBookWriter: respuesta 200 sin verificación de readback debe producir estado incierto (uncertain: true)', async () => {
  const mockProposal = {
    id: 'prop-verify-1',
    start_utc: '2026-09-10T16:00:00.000Z',
    end_utc: '2026-09-10T17:00:00.000Z',
    contact_number: '5213322630839',
  };

  // 1. Falta de token -> precondición clara sin llamada a proveedor (uncertain: false)
  const noToken = await executeBookWriter({
    proposal: mockProposal,
    contactName: 'Musio',
    token: '',
  });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.uncertain, false);
  assert.equal(noToken.error, 'missing_calendar_token');

  // 2. Respuesta 200 del proveedor con verified: false -> INCIERTO (uncertain: true)
  const mockFetchUnverified = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, verified: false, event_id: 'unverified-created-id' }),
  });
  const unverified = await executeBookWriter({
    proposal: mockProposal,
    contactName: 'Musio',
    token: 'valid-token',
    fetchFn: mockFetchUnverified,
  });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.verified, false);
  assert.equal(unverified.uncertain, true, '200 sin readback verificado debe ser uncertain: true');
  assert.equal(unverified.error, 'unverified_provider_response');

  // 3. Respuesta 200 del proveedor con verified: true completa -> verificado con éxito
  const mockFetchVerified = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      verified: true,
      event_id: 'google_evt_musio_999',
      calendar_event_id: 'google_evt_musio_999',
      token: 'tok_random_20chars_abc123',
      enlace_estable: 'https://wa.geekstudio.dev/api/r/tok_random_20chars_abc123',
    }),
  });
  const verified = await executeBookWriter({
    proposal: mockProposal,
    contactName: 'Musio',
    token: 'valid-token',
    fetchFn: mockFetchVerified,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.verified, true);
  assert.equal(verified.event_id, 'google_evt_musio_999');
  assert.equal(verified.token, 'tok_random_20chars_abc123');
});

test('executeCancelWriter: respuesta 200 sin verificación de readback debe producir estado incierto (uncertain: true)', async () => {
  const mockProposal = {
    id: 'prop-cancel-1',
    event_id: 'evt_google_123',
    contact_number: '5213322630839',
  };

  // 1. Falta de token -> precondición clara (uncertain: false)
  const noToken = await executeCancelWriter({
    proposal: mockProposal,
    token: '',
  });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.uncertain, false);
  assert.equal(noToken.error, 'missing_calendar_token');

  // 2. Respuesta 200 con verified: false -> INCIERTO (uncertain: true)
  const mockFetchUnverified = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, verified: false }),
  });
  const unverified = await executeCancelWriter({
    proposal: mockProposal,
    token: 'valid-token',
    fetchFn: mockFetchUnverified,
  });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.verified, false);
  assert.equal(unverified.uncertain, true);

  // 3. Respuesta verificada
  const mockFetchVerified = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      verified: true,
      event_id: 'evt_google_123',
      enlace_retirado: true,
    }),
  });
  const verified = await executeCancelWriter({
    proposal: mockProposal,
    token: 'valid-token',
    fetchFn: mockFetchVerified,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.verified, true);
  assert.equal(verified.enlace_retirado, true);
});

test('handleOwnerAgendaDecision: emisor no autorizado es rechazado de inmediato', async () => {
  const res = await handleOwnerAgendaDecision({
    pool: {},
    record: { contact_number: '5219990000001' },
    buttonId: 'ia360_agenda_yes:prop-123',
    sendOwnerDirectText: async () => {},
  });
  assert.equal(res, false, 'emisor que no sea el owner debe ser rechazado');
});

test('handleOwnerFailureAssistance: audience contact vs owner y ciclo de vida de awaiting flag', async () => {
  const mockTarget = {
    id: 171,
    contact_number: '5213322630839',
    contact_message: 'Necesito ver la propuesta en una reunión.',
    reason: 'desconocido:indeterminado:sigue_sin_clasificar',
    bot_fallback: 'Recibí tu mensaje y se lo paso a Alek.',
    contact_name: 'Musio Morales',
  };

  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('coexistence.chat_history')) {
        return {
          rows: [{
            message_id: 'wamid.incoming.orig.171',
            message_body: 'Necesito ver la propuesta en una reunión.',
            timestamp: new Date('2026-09-08T14:00:00.000Z'),
          }],
        };
      }
      return { rows: [] };
    },
  };

  // 1. Respuesta con response_audience === 'contact' y action === 'reply_to_contact' -> envía al contacto y limpia flag
  let contactSent = null;
  let clearedAwaiting = false;

  const mockCallAgentContact = async () => ({
    reply: 'Hola Musio, con gusto nos reunimos. ¿El jueves a las 3pm te queda bien?',
    response_audience: 'contact',
    action: 'reply_to_contact',
  });

  const resContact = await handleOwnerFailureAssistance({
    pool: mockPool,
    record: { contact_number: '5213322638033', wa_number: '5213321594582', message_id: 'wamid.owner.comment', timestamp: '2026-09-08T14:05:00.000Z' },
    failureId: '171',
    comment: 'Dale la cita, autorízasela.',
    loadFailureTarget: async () => mockTarget,
    callIa360Agent: mockCallAgentContact,
    enqueueIa360Text: async ({ body }) => { contactSent = body; return true; },
    sendIa360DirectText: async () => {},
    mergeContactState: async ({ customFields }) => {
      if (customFields && customFields.ia360_awaiting_comment_failure === '') clearedAwaiting = true;
    },
  });

  assert.equal(resContact.ok, true);
  assert.equal(resContact.handled, 'agent_reply_to_contact');
  assert.match(contactSent, /Hola Musio, con gusto nos reunimos/);
  assert.equal(clearedAwaiting, true, 'debe limpiar el flag al enviar respuesta al contacto');

  // 2. Respuesta con response_audience === 'owner' (consulta de Alek) -> responde a Alek, NO al contacto, y NO limpia flag
  let ownerDirectSent = null;
  let contactSentOwnerMode = null;
  let clearedAwaitingOwnerMode = false;

  const mockCallAgentOwner = async () => ({
    reply: 'Alek, Musio Morales es cliente potencial del sector logístico.',
    response_audience: 'owner',
    action: 'noop',
  });

  const resOwner = await handleOwnerFailureAssistance({
    pool: mockPool,
    record: { contact_number: '5213322638033', wa_number: '5213321594582', message_id: 'wamid.owner.query', timestamp: '2026-09-08T14:05:00.000Z' },
    failureId: '171',
    comment: '¿Quién es Musio?',
    loadFailureTarget: async () => mockTarget,
    callIa360Agent: mockCallAgentOwner,
    enqueueIa360Text: async ({ body }) => { contactSentOwnerMode = body; return true; },
    sendIa360DirectText: async ({ body, toNumber }) => {
      if (toNumber === '5213322638033') ownerDirectSent = body;
    },
    mergeContactState: async ({ customFields }) => {
      if (customFields && customFields.ia360_awaiting_comment_failure === '') clearedAwaitingOwnerMode = true;
    },
  });

  assert.equal(resOwner.ok, true);
  assert.equal(resOwner.handled, 'owner_info');
  assert.equal(contactSentOwnerMode, null, 'NUNCA debe enviar respuesta privada de consulta al contacto');
  assert.match(ownerDirectSent, /Alek, Musio Morales es cliente potencial/);
  assert.equal(clearedAwaitingOwnerMode, false, 'NO debe limpiar el flag awaiting tras una respuesta de información al owner');
});
