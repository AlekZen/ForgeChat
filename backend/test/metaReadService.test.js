// Confirmación de lectura MANUAL y auditada — portada de forgechat-g1g2 (`dac77fb`)
// el 19-ago-2026, con sus dos tablas ya presentes en la base de producción.
//
// No compite con la palomita automática: aquélla es el bot contestando, ésta deja
// constancia de qué PERSONA procesó la conversación. Lo que estas pruebas defienden
// es justamente el punto donde se cruzan —un mensaje ya marcado vuelve como
// `already_read` y no se marca dos veces— y que un fallo de Meta quede clasificado
// en vez de perderse.
//
// Se usa `createMetaReadService` con dobles de base y de Meta: la lógica de claim,
// dedupe y clasificación se prueba sin infraestructura.

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createMetaReadService,
  MetaReadError,
  _test: { classifyMetaFailure, validateMessageIds },
} = require('../src/services/metaReadService');

const WA = '5213321594582';
const CONTACTO = '5213322638033';
const WAMID = 'wamid.HBgNNTIxMzMyMjYzODAzMxUCABIYIEFDRDg1QUQ4';
const ACTOR = { id: '7', username: 'alek' };
const CUENTA = { id: 1, phone_number_id: '873315362541590', access_token_encrypted: 'x' };

// Doble de pg: responde por forma de query. `receipts` simula la tabla de acuses.
function fakeDb({ receipts = [], evidencia = true } = {}) {
  const escritos = [];
  const query = async (sql, params) => {
    const s = String(sql);
    if (s.includes('FROM coexistence.chat_history')) {
      return { rows: [{ message_id: WAMID, phone_number_id: CUENTA.phone_number_id, wa_number: WA, contact_number: CONTACTO, direction: 'incoming' }] };
    }
    if (s.includes('FROM coexistence.whatsapp_accounts')) return { rows: [CUENTA] };
    if (s.includes('FROM coexistence.message_processing_evidence')) {
      return { rows: evidencia ? [{ message_id: WAMID }] : [] };
    }
    if (s.includes('pg_advisory_xact_lock') || s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
      return { rows: [] };
    }
    if (s.includes('SELECT message_id, status, attempted_at, completed_at')) return { rows: receipts };
    if (s.includes('INSERT INTO coexistence.meta_read_receipts')) {
      escritos.push(params[0]);
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('UPDATE coexistence.meta_read_receipts')) {
      return { rows: [{ completed_at: '2026-08-19T20:00:00Z' }] };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }), escritos };
}

const CREDS = () => ({ phoneNumberId: CUENTA.phone_number_id, accessToken: 'tok' });

test('marca leído y devuelve read cuando Meta acepta', async () => {
  const llamadas = [];
  const svc = createMetaReadService({
    db: fakeDb(),
    accountCredentials: CREDS,
    sendRead: async (a) => { llamadas.push(a); return { success: true }; },
  });
  const r = await svc.confirmMetaRead({
    actor: ACTOR, processingChannel: 'forgechat_api',
    waNumber: WA, contactNumber: CONTACTO, messageIds: [WAMID], confirm: true,
  });
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].messageId, WAMID);
  assert.equal(r.results[0].status, 'read');
});

test('un mensaje ya marcado vuelve already_read y NO se marca dos veces', async () => {
  const llamadas = [];
  const svc = createMetaReadService({
    db: fakeDb({ receipts: [{ message_id: WAMID, status: 'read', completed_at: '2026-08-19T19:00:00Z' }] }),
    accountCredentials: CREDS,
    sendRead: async (a) => { llamadas.push(a); return { success: true }; },
  });
  const r = await svc.confirmMetaRead({
    actor: ACTOR, processingChannel: 'forgechat_api',
    waNumber: WA, contactNumber: CONTACTO, messageIds: [WAMID], confirm: true,
  });
  assert.equal(llamadas.length, 0, 'no debe volver a llamar a Meta');
  assert.equal(r.results[0].status, 'already_read');
});

test('sin evidencia de que alguien procesó la conversación, se rechaza', async () => {
  const svc = createMetaReadService({
    db: fakeDb({ evidencia: false }),
    accountCredentials: CREDS,
    sendRead: async () => { throw new Error('no debió llamarse'); },
  });
  await assert.rejects(
    () => svc.confirmMetaRead({
      actor: ACTOR, processingChannel: 'forgechat_api',
      waNumber: WA, contactNumber: CONTACTO, messageIds: [WAMID], confirm: true,
    }),
    (e) => e instanceof MetaReadError && e.code === 'PROCESSING_EVIDENCE_REQUIRED'
  );
});

test('sin confirm explícito no se toca Meta', async () => {
  const svc = createMetaReadService({ db: fakeDb(), accountCredentials: CREDS, sendRead: async () => {} });
  await assert.rejects(
    () => svc.confirmMetaRead({
      actor: ACTOR, processingChannel: 'forgechat_api',
      waNumber: WA, contactNumber: CONTACTO, messageIds: [WAMID], confirm: false,
    }),
    (e) => e.code === 'CONFIRMATION_REQUIRED'
  );
});

test('un canal de procesamiento inventado se rechaza', async () => {
  const svc = createMetaReadService({ db: fakeDb(), accountCredentials: CREDS, sendRead: async () => {} });
  await assert.rejects(
    () => svc.confirmMetaRead({
      actor: ACTOR, processingChannel: 'canal_pirata',
      waNumber: WA, contactNumber: CONTACTO, messageIds: [WAMID], confirm: true,
    }),
    (e) => e.code === 'INVALID_PROCESSING_CHANNEL'
  );
});

test('un 4xx de Meta es failed; un 5xx o un timeout es no_verificable', () => {
  assert.equal(classifyMetaFailure({ status: 400 }).status, 'failed');
  assert.equal(classifyMetaFailure({ status: 400 }).errorCode, 'meta_http_400');
  assert.equal(classifyMetaFailure({ status: 503 }).status, 'no_verificable');
  assert.equal(classifyMetaFailure({ name: 'AbortError' }).errorCode, 'timeout');
  assert.equal(classifyMetaFailure({}).errorCode, 'network_error');
});

test('la selección de mensajes no admite duplicados ni lotes fuera de rango', () => {
  assert.throws(() => validateMessageIds([WAMID, WAMID]), (e) => e.code === 'DUPLICATE_MESSAGE');
  assert.throws(() => validateMessageIds([]), (e) => e.code === 'INVALID_MESSAGE_SELECTION');
  assert.throws(() => validateMessageIds(new Array(51).fill(0).map((_, i) => `m${i}`)),
    (e) => e.code === 'INVALID_MESSAGE_SELECTION');
});
