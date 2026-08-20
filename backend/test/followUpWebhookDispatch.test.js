const test = require('node:test');
const assert = require('node:assert/strict');

const { dispatchIa360FollowUpInbound } = require('../src/services/followUpInboundDispatcher');

const RECORD = {
  message_id: 'wamid.in.fixture',
  phone_number_id: 'phone-1',
  contact_number: '5212222222222',
  message_body: 'Sí, compártelo',
};

test('positivo consumido suprime ack y rutas genéricas', async () => {
  const calls = { ack: 0, watchdog: 0, ia360: 0, automation: 0 };
  const result = await dispatchIa360FollowUpInbound(RECORD, {
    db: {},
    claim: async () => ({ consumed: true, action: 'deliver' }),
    sendDeferred: async () => { calls.ack += 1; },
  });
  if (!result.consumed) {
    calls.watchdog += 1;
    calls.ia360 += 1;
    calls.automation += 1;
  }
  assert.deepEqual(calls, { ack: 0, watchdog: 0, ia360: 0, automation: 0 });
});

test('Después consumido envía exactamente un acuse y suprime rutas genéricas', async () => {
  let acknowledgements = 0;
  const result = await dispatchIa360FollowUpInbound(
    { ...RECORD, message_body: 'Después' },
    {
      db: {},
      claim: async () => ({ consumed: true, action: 'defer' }),
      sendDeferred: async () => { acknowledgements += 1; },
    },
  );
  assert.equal(result.consumed, true);
  assert.equal(acknowledgements, 1);
});

test('cero o varios candidatos dejan continuar el flujo normal', async () => {
  let acknowledgements = 0;
  const result = await dispatchIa360FollowUpInbound(RECORD, {
    db: {},
    claim: async () => ({ consumed: false }),
    sendDeferred: async () => { acknowledgements += 1; },
  });
  assert.equal(result.consumed, false);
  assert.equal(acknowledgements, 0);
});

test('fallo interno no consume ni filtra payload', async () => {
  const logged = [];
  const result = await dispatchIa360FollowUpInbound(RECORD, {
    db: {},
    claim: async () => { throw Object.assign(new Error('detalle interno'), { code: 'FOLLOWUP_TRIGGER_FAILED' }); },
    logger: { error: (...args) => logged.push(args) },
  });
  assert.equal(result.consumed, false);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].includes(RECORD.contact_number), false);
});
