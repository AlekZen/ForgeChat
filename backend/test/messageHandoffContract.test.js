const test = require('node:test');
const assert = require('node:assert/strict');

const { insertPendingRow } = require('../src/services/messageSender');

test('handoff sin superficie persiste caso y contexto sólo en template_meta', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [{ message_id: 'local-handoff' }] };
    },
  };

  const messageId = await insertPendingRow({
    account: {
      phoneNumberId: 'phone-fixture',
      displayPhoneNumber: '5210000004582',
    },
    toNumber: '5210000008033',
    messageType: 'text',
    messageBody: '¿mayo sustituye o suma?',
    correlationId: 'local-handoff',
    templateMeta: {
      source: 'nexus_cli',
      case_ref: 'CAM-84',
      reply_context: 'Responder si mayo sustituye o suma.',
    },
    db,
  });

  assert.equal(messageId, 'local-handoff');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].params[10]), {
    source: 'nexus_cli',
    case_ref: 'CAM-84',
    reply_context: 'Responder si mayo sustituye o suma.',
  });
  assert.equal(calls[0].params[14], null, 'handoff no usa outbound_purpose');
  assert.equal(calls[0].params[15], null, 'handoff no viola el constraint de case_ref SQL');
});
