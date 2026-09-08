// test/ia360AgendaProposals.test.js — Pruebas de comportamiento observable para propuestas de agenda,
// validación de fronteras, estados de incertidumbre ante respuestas no verificadas, soporte independiente
// de recursos (Calendar solo, Zoom solo, ambos), preservación de contrapartes en cancelación y asistencia supervisada.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  canonicalizeResources,
  validateProposalInput,
  computePayloadHash,
  executeBookWriter,
  executeCancelWriter,
  handleOwnerAgendaDecision,
  handleOwnerFailureAssistance,
} = require('../src/services/ia360AgendaProposals');

test('canonicalizeResources: normalización y validación canónica de recursos', () => {
  // 1. Recursos individuales
  assert.deepEqual(canonicalizeResources(['calendar']), ['calendar']);
  assert.deepEqual(canonicalizeResources(['zoom']), ['zoom']);

  // 2. Ambos recursos en orden canónico fijo ['calendar', 'zoom']
  assert.deepEqual(canonicalizeResources(['calendar', 'zoom']), ['calendar', 'zoom']);
  assert.deepEqual(canonicalizeResources(['zoom', 'calendar']), ['calendar', 'zoom'], 'debe ordenar canónicamente');
  assert.deepEqual(canonicalizeResources(['  CALENDAR  ', 'ZOOM ']), ['calendar', 'zoom'], 'debe limpiar espacios y mayúsculas');

  // 3. Deduplicación
  assert.deepEqual(canonicalizeResources(['zoom', 'zoom', 'calendar']), ['calendar', 'zoom']);

  // 4. Rechazo de entradas inválidas / vacías / sin defaults
  assert.equal(canonicalizeResources([]), null);
  assert.equal(canonicalizeResources(null), null);
  assert.equal(canonicalizeResources(undefined), null);
  assert.equal(canonicalizeResources('calendar'), null);
  assert.equal(canonicalizeResources(['teams']), null);
  assert.equal(canonicalizeResources(['calendar', 'invalid']), null);
});

test('validateProposalInput: contrato estricto de resources para Calendar solo, Zoom solo y ambos', () => {
  const futureStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const futureEnd = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString();

  // 1. Reserva válida: ambos recursos
  const validBoth = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    source_message_id: 'wamid.HBgLMTIzNDU2Nw==',
    kind: 'book',
    resources: ['calendar', 'zoom'],
    start_utc: futureStart,
    end_utc: futureEnd,
    title: 'Sesión de Estrategia',
  });
  assert.equal(validBoth.ok, true);
  assert.equal(validBoth.sanitized.kind, 'book');
  assert.deepEqual(validBoth.sanitized.resources, ['calendar', 'zoom']);

  // 2. Reserva válida: Calendar solo
  const validCalOnly = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    source_message_id: 'wamid.calonly',
    kind: 'book',
    resources: ['calendar'],
    start_utc: futureStart,
    end_utc: futureEnd,
  });
  assert.equal(validCalOnly.ok, true);
  assert.deepEqual(validCalOnly.sanitized.resources, ['calendar']);

  // 3. Reserva válida: Zoom solo
  const validZoomOnly = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    source_message_id: 'wamid.zoomonly',
    kind: 'book',
    resources: ['zoom'],
    start_utc: futureStart,
    end_utc: futureEnd,
  });
  assert.equal(validZoomOnly.ok, true);
  assert.deepEqual(validZoomOnly.sanitized.resources, ['zoom']);

  // 4. Rechazo si falta resources (no hay default implícito que asuma ambos)
  const noResources = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    source_message_id: 'wamid.nores',
    kind: 'book',
    start_utc: futureStart,
    end_utc: futureEnd,
  });
  assert.equal(noResources.ok, false);
  assert.ok(noResources.errors.includes('resources_required'), 'debe exigir campo obligatorio resources sin defaults');

  // 5. Cancelación válida: Calendar solo (exige event_id, NO exige zoom_id)
  const validCancelCal = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    source_message_id: 'wamid.cancelcal',
    kind: 'cancel',
    resources: ['calendar'],
    event_id: 'evt_google_12345',
  });
  assert.equal(validCancelCal.ok, true);
  assert.deepEqual(validCancelCal.sanitized.resources, ['calendar']);
  assert.equal(validCancelCal.sanitized.event_id, 'evt_google_12345');

  // 6. Cancelación válida: Zoom solo (exige zoom_id, NO exige event_id)
  const validCancelZoom = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    source_message_id: 'wamid.cancelzoom',
    kind: 'cancel',
    resources: ['zoom'],
    zoom_id: '89234567890',
  });
  assert.equal(validCancelZoom.ok, true);
  assert.deepEqual(validCancelZoom.sanitized.resources, ['zoom']);
  assert.equal(validCancelZoom.sanitized.zoom_id, '89234567890');

  // 7. Rechazo de fecha en el pasado
  const pastBook = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    source_message_id: 'wamid.past',
    kind: 'book',
    resources: ['calendar'],
    start_utc: '2020-01-01T15:00:00.000Z',
    end_utc: '2020-01-01T16:00:00.000Z',
  });
  assert.equal(pastBook.ok, false);
  assert.ok(pastBook.errors.includes('start_must_be_in_future'));

  // 8. Rechazo de falta de source_message_id
  const noSourceMsg = validateProposalInput({
    wa_number: '5213321594582',
    contact_number: '5213322630839',
    kind: 'book',
    resources: ['calendar', 'zoom'],
    start_utc: futureStart,
    end_utc: futureEnd,
  });
  assert.equal(noSourceMsg.ok, false);
  assert.ok(noSourceMsg.errors.includes('source_message_id_required'));
});

test('computePayloadHash: unicidad canónica por slot, acción y recursos (dedup por recurso sin colisión)', () => {
  const hashCal = computePayloadHash({
    kind: 'book',
    resources: ['calendar'],
    start_utc: '2026-09-10T15:00:00.000Z',
    end_utc: '2026-09-10T16:00:00.000Z',
    title: 'Demo',
  });
  const hashZoom = computePayloadHash({
    kind: 'book',
    resources: ['zoom'],
    start_utc: '2026-09-10T15:00:00.000Z',
    end_utc: '2026-09-10T16:00:00.000Z',
    title: 'Demo',
  });
  const hashBoth = computePayloadHash({
    kind: 'book',
    resources: ['calendar', 'zoom'],
    start_utc: '2026-09-10T15:00:00.000Z',
    end_utc: '2026-09-10T16:00:00.000Z',
    title: 'Demo',
  });

  assert.notEqual(hashCal, hashZoom, 'Calendar solo y Zoom solo en el mismo horario deben tener hashes distintos');
  assert.notEqual(hashCal, hashBoth, 'Calendar solo y ambos deben tener hashes distintos');
  assert.notEqual(hashZoom, hashBoth, 'Zoom solo y ambos deben tener hashes distintos');

  const hashCalDup = computePayloadHash({
    kind: 'book',
    resources: ['calendar'],
    start_utc: '2026-09-10T15:00:00.000Z',
    end_utc: '2026-09-10T16:00:00.000Z',
    title: 'Demo',
  });
  assert.equal(hashCal, hashCalDup, 'Mismo payload de Calendar debe dar el mismo hash exacto');
});

test('executeBookWriter: verificación estricta de componentes y ausencia de I/O a recurso excluido', async () => {
  const baseProposal = {
    id: 'prop-book-test-1',
    start_utc: '2026-09-10T16:00:00.000Z',
    end_utc: '2026-09-10T17:00:00.000Z',
    contact_number: '5213322630839',
  };

  // 1. Calendar solo: éxito verificado cuando components.calendar está 'verified' (cero exigencia de Zoom)
  let calSentBody = null;
  const calOnlyRes = await executeBookWriter({
    proposal: { ...baseProposal, resources: ['calendar'] },
    contactName: 'Musio',
    token: 'valid-token',
    fetchFn: async (_url, opts) => {
      calSentBody = JSON.parse(opts.body);
      assert.deepEqual(calSentBody.resources, ['calendar']);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          verified: true,
          token: 'tok_calendar_only_123',
          components: {
            calendar: { state: 'verified', id: 'gcal_evt_100' },
          },
        }),
      };
    },
  });
  assert.equal(calOnlyRes.ok, true);
  assert.equal(calOnlyRes.verified, true);
  assert.equal(calOnlyRes.event_id, 'gcal_evt_100');
  assert.equal(calOnlyRes.zoom_meeting_id, null, 'No debe registrar Zoom cuando solo se pidió Calendar');
  assert.deepEqual(calOnlyRes.resources, ['calendar']);

  // 2. Zoom solo: éxito verificado cuando components.zoom está 'verified' (cero exigencia de Calendar)
  let zoomSentBody = null;
  const zoomOnlyRes = await executeBookWriter({
    proposal: { ...baseProposal, resources: ['zoom'] },
    contactName: 'Musio',
    token: 'valid-token',
    fetchFn: async (_url, opts) => {
      zoomSentBody = JSON.parse(opts.body);
      assert.deepEqual(zoomSentBody.resources, ['zoom']);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          verified: true,
          token: 'tok_zoom_only_123',
          components: {
            zoom: { state: 'verified', id: 'zoom_mtg_888', join_url: 'https://zoom.us/j/888' },
          },
        }),
      };
    },
  });
  assert.equal(zoomOnlyRes.ok, true);
  assert.equal(zoomOnlyRes.verified, true);
  assert.equal(zoomOnlyRes.zoom_join_url, 'https://zoom.us/j/888');
  assert.equal(zoomOnlyRes.event_id, null, 'No debe registrar event_id cuando solo se pidió Zoom');
  assert.deepEqual(zoomOnlyRes.resources, ['zoom']);

  // 3. Ambos: si uno falla (parcial), ok global debe ser false y conservar el estado de componentes
  const partialRes = await executeBookWriter({
    proposal: { ...baseProposal, resources: ['calendar', 'zoom'] },
    contactName: 'Musio',
    token: 'valid-token',
    fetchFn: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: false,
        verified: false,
        components: {
          calendar: { state: 'verified', id: 'gcal_evt_100' },
          zoom: { state: 'failed', error: 'zoom_rate_limit' },
        },
      }),
    }),
  });
  assert.equal(partialRes.ok, false);
  assert.equal(partialRes.verified, false);
  assert.equal(partialRes.uncertain, false);
  assert.equal(partialRes.components.calendar.state, 'verified');
  assert.equal(partialRes.components.zoom.state, 'failed');

  // 4. Respuesta 200 con cuerpo vacío o sin verified -> INCIERTO (uncertain: true, nunca éxito)
  const empty200Res = await executeBookWriter({
    proposal: { ...baseProposal, resources: ['calendar', 'zoom'] },
    contactName: 'Musio',
    token: 'valid-token',
    fetchFn: async () => ({
      ok: true,
      status: 200,
      text: async () => '',
    }),
  });
  assert.equal(empty200Res.ok, false);
  assert.equal(empty200Res.uncertain, true, '200 con cuerpo vacío debe ser uncertain: true');
});

test('executeCancelWriter: cancelación independiente por recurso sin exigir ID de la contraparte', async () => {
  const baseProposal = {
    id: 'prop-cancel-test-1',
    contact_number: '5213322630839',
  };

  // 1. Cancelar Calendar solo
  const cancelCalRes = await executeCancelWriter({
    proposal: { ...baseProposal, resources: ['calendar'], event_id: 'gcal_evt_100' },
    token: 'valid-token',
    fetchFn: async (_url, opts) => {
      const payload = JSON.parse(opts.body);
      assert.deepEqual(payload.resources, ['calendar']);
      assert.equal(payload.event_id, 'gcal_evt_100');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          verified: true,
          components: {
            calendar: { state: 'verified', id: 'gcal_evt_100' },
          },
        }),
      };
    },
  });
  assert.equal(cancelCalRes.ok, true);
  assert.equal(cancelCalRes.verified, true);
  assert.deepEqual(cancelCalRes.resources, ['calendar']);

  // 2. Cancelar Zoom solo sin event_id de Calendar
  const cancelZoomRes = await executeCancelWriter({
    proposal: { ...baseProposal, resources: ['zoom'], zoom_id: 'zoom_mtg_888' },
    token: 'valid-token',
    fetchFn: async (_url, opts) => {
      const payload = JSON.parse(opts.body);
      assert.deepEqual(payload.resources, ['zoom']);
      assert.equal(payload.zoom_id, 'zoom_mtg_888');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          verified: true,
          components: {
            zoom: { state: 'verified', id: 'zoom_mtg_888' },
          },
        }),
      };
    },
  });
  assert.equal(cancelZoomRes.ok, true);
  assert.equal(cancelZoomRes.verified, true);
  assert.deepEqual(cancelZoomRes.resources, ['zoom']);
});

test('handleOwnerAgendaDecision: emisor no autorizado y control de línea', async () => {
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
