const test = require('node:test');
const assert = require('node:assert/strict');

const messageSenderPath = require.resolve('../src/services/messageSender');
const originalMessageSender = require.cache[messageSenderPath];
let insertedDeliveries = 0;
require.cache[messageSenderPath] = {
  id: messageSenderPath,
  filename: messageSenderPath,
  loaded: true,
  exports: {
    insertPendingRow: async () => {
      insertedDeliveries += 1;
      return 'q_0123456789ab:delivery';
    },
  },
};
const {
  classifyInbound,
  prepareFollowUp,
  claimFollowUpInbound,
  reconcileFollowUps,
  onFollowUpReceipt,
} = require('../src/services/followUpService');

const TEMPLATE = {
  id: 7,
  name: 'ia360_seguimiento_entregable_v1',
  category: 'UTILITY',
  language: 'es_MX',
  status: 'APPROVED',
  buttons: [
    { type: 'QUICK_REPLY', text: 'Sí, compártelo' },
    { type: 'QUICK_REPLY', text: 'Después' },
  ],
  body: 'Hola, {{1}}. Ya quedó listo {{2}}.',
  whatsapp_account_id: 1,
};

function dryRunDb(template = TEMPLATE) {
  const mutations = [];
  return {
    mutations,
    async query(sql) {
      if (/^\s*(INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)/i.test(sql)) mutations.push(sql);
      if (sql.includes('FROM coexistence.whatsapp_accounts')) {
        return { rows: [{ id: 1, phone_number_id: 'phone-1', display_phone_number: '5211111111111', is_active: true }] };
      }
      if (sql.includes('FROM coexistence.contacts')) return { rows: [{ id: 2, name: 'Nico' }] };
      if (sql.includes('FROM coexistence.ia360_contact_scope')) return { rows: [{ account_key: 'camiones-selectos' }] };
      if (sql.includes('FROM coexistence.message_templates')) return { rows: [template] };
      if (sql.includes('FROM coexistence.ia360_product_surfaces')) return { rows: [] };
      if (sql.includes('FROM coexistence.message_followups')) return { rows: [] };
      throw new Error(`SQL no esperado: ${sql.slice(0, 80)}`);
    },
  };
}

test('prepare dry-run valida template y deja cero mutaciones', async () => {
  const db = dryRunDb();
  const result = await prepareFollowUp({
    db,
    actor: { id: 9, dryRun: true },
    fromNumber: '5211111111111',
    toNumber: '5212222222222',
    caseRef: 'QA-DRY',
    deliverable: 'Prueba sintética',
    purpose: 'case_delivery',
    body: 'Aquí está el entregable.',
    ttlHours: 24,
  });
  assert.equal(result.status, 'dry_run');
  assert.deepEqual(db.mutations, []);
});

test('template incorrecto falla antes de fila o job', async () => {
  const db = dryRunDb({ ...TEMPLATE, buttons: [{ text: 'Sí' }] });
  await assert.rejects(
    () => prepareFollowUp({
      db,
      actor: { id: 9, dryRun: true },
      fromNumber: '5211111111111',
      toNumber: '5212222222222',
      caseRef: 'QA-BAD-TPL',
      deliverable: 'Prueba sintética',
      purpose: 'case_delivery',
      body: 'Aquí está el entregable.',
      ttlHours: 24,
    }),
    error => error.code === 'FOLLOWUP_TRIGGER_FAILED',
  );
  assert.deepEqual(db.mutations, []);
});

test('clasificación sólo consume respuestas inequívocas', () => {
  assert.equal(classifyInbound({ message_body: 'Sí, compártelo' }), 'deliver');
  assert.equal(classifyInbound({ message_body: 'Después' }), 'defer');
  assert.equal(classifyInbound({ message_body: 'mándame el enlace' }), 'deliver');
  assert.equal(classifyInbound({ message_body: 'quiero el enlace' }), 'deliver');
  assert.equal(classifyInbound({ message_body: 'dame la liga' }), 'deliver');
  assert.equal(classifyInbound({ message_body: 'envíame el link' }), 'deliver');
  assert.equal(classifyInbound({ message_body: 'gracias' }), null);
});

function claimDb({ candidates = 1 } = {}) {
  const base = {
    id: 11,
    public_ref: 'q_0123456789ab',
    account_key: 'camiones-selectos',
    phone_number_id: 'phone-1',
    from_number: '5211111111111',
    contact_number: '5212222222222',
    case_ref: 'QA-CLAIM',
    prepared_body: 'Revisa https://camiones-selectos.web.app/app/a',
    purpose: 'production_review',
    surface_key: 'cam-app',
    surface_attestation_ref: 'a_0123456789abcdef01234567',
    final_correlation_id: 'q_0123456789ab:delivery',
    opener_correlation_id: 'q_0123456789ab:opener',
    trigger_message_id: 'wamid.opener',
    state: 'active',
    expires_at: '2099-01-01T00:00:00Z',
  };
  let state = 'active';
  const client = {
    async query(sql) {
      if (sql.includes('SELECT *') && sql.includes('message_followups')) {
        if (state !== 'active') return { rows: [] };
        return { rows: Array.from({ length: candidates }, (_, index) => ({ ...base, id: base.id + index })) };
      }
      if (sql.includes("SET state='claimed'")) {
        if (state !== 'active') return { rows: [] };
        state = 'claimed';
        return { rows: [{ ...base, state }] };
      }
      if (sql.includes("SET state='queued'")) {
        if (state !== 'claimed') return { rows: [] };
        state = 'queued';
        return { rows: [{ ...base, state }] };
      }
      if (sql.includes("SET state='cancelled'")) {
        if (state !== 'active') return { rows: [] };
        state = 'cancelled';
        return { rows: [{ ...base, state, last_error_code: 'contact_deferred' }] };
      }
      if (sql.includes('FROM coexistence.whatsapp_accounts')) {
        return { rows: [{ id: 1, phone_number_id: 'phone-1', display_phone_number: '5211111111111', is_active: true }] };
      }
      if (sql.includes('FROM coexistence.chat_history')) return { rows: [] };
      if (sql.includes('message_followup_events')) return { rows: [], rowCount: 1 };
      if (/BEGIN|COMMIT|ROLLBACK|pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      throw new Error(`SQL no esperado: ${sql.slice(0, 100)}`);
    },
    release() {},
  };
  return {
    state: () => state,
    async query(sql) {
      if (sql.includes('ia360_contact_scope')) return { rows: [{ account_key: 'camiones-selectos' }] };
      if (sql.includes('message_followup_events')) return { rows: [], rowCount: 1 };
      throw new Error(`SQL pool no esperado: ${sql.slice(0, 100)}`);
    },
    async connect() { return client; },
  };
}

test('positivo materializa y encola una sola entrega; replay no repite efectos', async () => {
  insertedDeliveries = 0;
  let queued = 0;
  const queuePath = require.resolve('../src/queue/sendQueue');
  const originalQueue = require.cache[queuePath];
  require.cache[queuePath] = {
    id: queuePath,
    filename: queuePath,
    loaded: true,
    exports: { enqueueSend: async () => { queued += 1; } },
  };
  try {
    const db = claimDb();
    const record = {
      message_id: 'wamid.in.positive',
      context_message_id: 'wamid.opener',
      phone_number_id: 'phone-1',
      contact_number: '5212222222222',
      message_body: 'Sí, compártelo',
    };
    const first = await claimFollowUpInbound({ db, record });
    const replay = await claimFollowUpInbound({ db, record });
    assert.equal(first.consumed, true);
    assert.equal(first.action, 'deliver');
    assert.equal(replay.consumed, false);
    assert.equal(insertedDeliveries, 1);
    assert.equal(queued, 1);
    assert.equal(db.state(), 'queued');
  } finally {
    if (originalQueue) require.cache[queuePath] = originalQueue;
    else delete require.cache[queuePath];
  }
});

test('dos candidatos no hacen fan-out y Después cancela uno', async () => {
  const ambiguous = await claimFollowUpInbound({
    db: claimDb({ candidates: 2 }),
    record: {
      message_id: 'wamid.in.ambiguous', phone_number_id: 'phone-1',
      contact_number: '5212222222222', message_body: 'Sí, compártelo',
    },
  });
  assert.equal(ambiguous.consumed, false);

  const deferredDb = claimDb();
  const deferred = await claimFollowUpInbound({
    db: deferredDb,
    record: {
      message_id: 'wamid.in.defer', context_message_id: 'wamid.opener',
      phone_number_id: 'phone-1', contact_number: '5212222222222', message_body: 'Después',
    },
  });
  assert.equal(deferred.consumed, true);
  assert.equal(deferred.action, 'defer');
  assert.equal(deferredDb.state(), 'cancelled');
});


test('reconciliador reencola prepared y nunca reenvía lease ambiguo vencido', async () => {
  let queued = 0;
  const updates = [];
  const queuePath = require.resolve('../src/queue/sendQueue');
  const originalQueue = require.cache[queuePath];
  require.cache[queuePath] = {
    id: queuePath,
    filename: queuePath,
    loaded: true,
    exports: { enqueueSend: async () => { queued += 1; } },
  };
  const future = '2099-01-01T00:00:00Z';
  const past = '2000-01-01T00:00:00Z';
  const rows = [
    {
      id: 21, public_ref: 'q_111111111111', state: 'prepared', account_id: 1,
      from_number: '5211111111111', contact_number: '5212222222222', deliverable: 'Reporte',
      opener_correlation_id: 'q_111111111111:opener', final_correlation_id: 'q_111111111111:delivery',
      prepared_body: 'Sin URL', expires_at: future, lease_expires_at: null,
    },
    {
      id: 22, public_ref: 'q_222222222222', state: 'opener_sending', account_id: 1,
      from_number: '5211111111111', contact_number: '5212222222222', deliverable: 'Reporte',
      opener_correlation_id: 'q_222222222222:opener', final_correlation_id: 'q_222222222222:delivery',
      prepared_body: 'Sin URL', expires_at: future, lease_expires_at: past,
      opener_chat_status: 'sending',
    },
    {
      id: 23, public_ref: 'q_333333333333', state: 'sending', account_id: 1,
      from_number: '5211111111111', contact_number: '5212222222222', deliverable: 'Reporte',
      opener_correlation_id: 'q_333333333333:opener', final_correlation_id: 'q_333333333333:delivery',
      prepared_body: 'Sin URL', expires_at: past, lease_expires_at: future,
      final_chat_status: 'sent',
    },
  ];
  const client = {
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('SELECT f.*, a.id AS account_id')) return { rows };
      if (sql.includes('SELECT status FROM coexistence.chat_history')) return { rows: [{ status: 'sending' }] };
      if (sql.includes('SET state=$2')) { updates.push('sent'); return { rows: [], rowCount: 1 }; }
      if (sql.includes("SET state='no_verificable'")) { updates.push('no_verificable'); return { rows: [], rowCount: 1 }; }
      if (sql.includes('message_followup_events')) return { rows: [], rowCount: 1 };
      if (/BEGIN|COMMIT|ROLLBACK|pg_advisory_unlock/.test(sql)) return { rows: [{ pg_advisory_unlock: true }] };
      throw new Error(`SQL reconciler no esperado: ${sql.slice(0, 100)}`);
    },
    release() {},
  };
  const db = {
    async connect() { return client; },
    async query(sql) {
      if (sql.includes('FROM coexistence.contacts')) return { rows: [{ name: 'Nico' }] };
      throw new Error(`SQL requeue no esperado: ${sql.slice(0, 100)}`);
    },
  };
  try {
    const result = await reconcileFollowUps({ db, limit: 10 });
    assert.equal(result.requeued, 1);
    assert.equal(queued, 1);
    assert.deepEqual(updates, ['no_verificable', 'sent']);
  } finally {
    if (originalQueue) require.cache[queuePath] = originalQueue;
    else delete require.cache[queuePath];
  }
});


test('receipt failed tardío no degrada delivered ya monotónico en chat_history', async () => {
  const states = [];
  const db = {
    async query(sql, params) {
      if (sql.includes('SELECT f.*')) {
        return { rows: [{
          id: 31,
          public_ref: 'q_333333333333',
          state: 'delivered',
          trigger_message_id: 'wamid.opener',
          final_correlation_id: 'q_333333333333:delivery',
          receipt_status: 'delivered',
        }] };
      }
      if (sql.includes('UPDATE coexistence.message_followups')) {
        states.push(params[1]);
        return { rows: [{ id: 31, state: params[1] }] };
      }
      if (sql.includes('message_followup_events')) return { rows: [], rowCount: 1 };
      throw new Error(`SQL receipt no esperado: ${sql.slice(0, 100)}`);
    },
  };
  const result = await onFollowUpReceipt({
    db,
    messageId: 'wamid.delivery',
    status: 'failed',
    publicCode: 'FOLLOWUP_PROVIDER_FAILED',
  });
  assert.equal(result.state, 'delivered');
  assert.deepEqual(states, []);
});

test.after(() => {
  if (originalMessageSender) require.cache[messageSenderPath] = originalMessageSender;
  else delete require.cache[messageSenderPath];
});
