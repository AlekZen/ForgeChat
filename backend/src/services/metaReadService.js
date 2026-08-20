'use strict';

const pool = require('../db');
const { decrypt } = require('../util/crypto');
const { markMessageRead } = require('../integrations/metaSend');

const SOURCE_CHANNEL = 'whatsapp';
const PROCESSING_CHANNELS = new Set(['nexus_cli', 'forgechat_ui', 'forgechat_api']);
const MAX_BATCH_SIZE = 50;

class MetaReadError extends Error {
  constructor(statusCode, code, message = 'The Meta read request could not be completed') {
    super(message);
    this.name = 'MetaReadError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function validateActor(actor) {
  const id = String(actor?.id ?? '');
  if (!/^\d+$/.test(id) || id === '0') {
    throw new MetaReadError(401, 'ACTOR_REQUIRED');
  }
  return {
    id,
    ref: `user:${id}`,
    username: String(actor?.username || actor?.displayName || `user-${id}`).slice(0, 200),
  };
}

function validateProcessingChannel(value) {
  if (!PROCESSING_CHANNELS.has(value)) {
    throw new MetaReadError(400, 'INVALID_PROCESSING_CHANNEL');
  }
  return value;
}

function validateConversation(waNumber, contactNumber) {
  const wa = normalizePhone(waNumber);
  const contact = normalizePhone(contactNumber);
  if (!wa || !contact) throw new MetaReadError(400, 'CONVERSATION_REQUIRED');
  return { waNumber: wa, contactNumber: contact };
}

function validateMessageIds(messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > MAX_BATCH_SIZE) {
    throw new MetaReadError(400, 'INVALID_MESSAGE_SELECTION');
  }
  const ids = messageIds.map((value) => {
    if (typeof value !== 'string' || value.length < 1 || value.length > 1024) {
      throw new MetaReadError(400, 'INVALID_MESSAGE_SELECTION');
    }
    return value;
  });
  if (new Set(ids).size !== ids.length) {
    throw new MetaReadError(400, 'DUPLICATE_MESSAGE');
  }
  return ids;
}

function validateConfirmation(confirm) {
  if (confirm !== true) throw new MetaReadError(400, 'CONFIRMATION_REQUIRED');
}

async function withTransaction(db, work) {
  const client = await db.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    committed = true;
    return value;
  } finally {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

async function loadSelection(queryable, { messageIds, waNumber, contactNumber }) {
  const { rows } = await queryable.query(
    `SELECT message_id, phone_number_id, wa_number, contact_number, direction
       FROM coexistence.chat_history
      WHERE message_id = ANY($1::text[])`,
    [messageIds]
  );
  if (rows.length !== messageIds.length) {
    throw new MetaReadError(404, 'MESSAGE_SELECTION_UNAVAILABLE');
  }

  const byId = new Map(rows.map((row) => [row.message_id, row]));
  const ordered = messageIds.map((id) => byId.get(id));
  let phoneNumberId = null;
  for (const row of ordered) {
    if (!row || row.direction !== 'incoming' || !row.phone_number_id ||
        normalizePhone(row.wa_number) !== waNumber ||
        normalizePhone(row.contact_number) !== contactNumber) {
      throw new MetaReadError(404, 'MESSAGE_SELECTION_UNAVAILABLE');
    }
    if (phoneNumberId === null) phoneNumberId = row.phone_number_id;
    if (row.phone_number_id !== phoneNumberId) {
      throw new MetaReadError(409, 'MESSAGE_ACCOUNT_MISMATCH');
    }
  }
  return { rows: ordered, phoneNumberId };
}

async function assertExactActiveAccount(queryable, phoneNumberId) {
  const { rows } = await queryable.query(
    `SELECT id, phone_number_id, access_token_encrypted
       FROM coexistence.whatsapp_accounts
      WHERE phone_number_id = $1 AND is_active = TRUE`,
    [phoneNumberId]
  );
  if (rows.length !== 1) throw new MetaReadError(409, 'ACCOUNT_UNAVAILABLE');
  return rows[0];
}

function defaultAccountCredentials(accountRow) {
  const accessToken = decrypt(accountRow.access_token_encrypted);
  if (!accessToken) throw new MetaReadError(409, 'ACCOUNT_UNAVAILABLE');
  return { phoneNumberId: accountRow.phone_number_id, accessToken };
}

async function requireMatchingEvidence(queryable, { messageIds, actor, processingChannel }) {
  const { rows } = await queryable.query(
    `SELECT message_id
       FROM coexistence.message_processing_evidence
      WHERE message_id = ANY($1::text[])
        AND actor_ref = $2
        AND processing_channel = $3`,
    [messageIds, actor.ref, processingChannel]
  );
  if (rows.length !== messageIds.length) {
    throw new MetaReadError(409, 'PROCESSING_EVIDENCE_REQUIRED');
  }
}

function publicEvidenceRows(messageIds, rows, insertedIds) {
  const byId = new Map(rows.map((row) => [row.message_id, row]));
  return messageIds.map((messageId) => ({
    messageId,
    status: insertedIds.has(messageId) ? 'registered' : 'already_registered',
    processedAt: byId.get(messageId).processed_at,
  }));
}

function classifyMetaFailure(error) {
  const httpStatus = Number.isInteger(error?.status) ? error.status : null;
  const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError' ||
    error?.code === 'ABORT_ERR' || error?.code === 'UND_ERR_CONNECT_TIMEOUT';
  let errorCode;
  if (timedOut) errorCode = 'timeout';
  else if (httpStatus) errorCode = `meta_http_${httpStatus}`;
  else errorCode = 'network_error';
  return {
    status: httpStatus >= 400 && httpStatus < 500 ? 'failed' : 'no_verificable',
    httpStatus,
    errorCode,
  };
}

function createMetaReadService({
  db = pool,
  sendRead = markMessageRead,
  accountCredentials = defaultAccountCredentials,
} = {}) {
  async function recordProcessingEvidence({
    actor,
    processingChannel,
    waNumber,
    contactNumber,
    messageIds,
    confirm,
  }) {
    validateConfirmation(confirm);
    const safeActor = validateActor(actor);
    const safeChannel = validateProcessingChannel(processingChannel);
    const conversation = validateConversation(waNumber, contactNumber);
    const ids = validateMessageIds(messageIds);

    const evidence = await withTransaction(db, async (client) => {
      const selection = await loadSelection(client, { messageIds: ids, ...conversation });
      await assertExactActiveAccount(client, selection.phoneNumberId);
      const insertedIds = new Set();
      for (const row of selection.rows) {
        const inserted = await client.query(
          `INSERT INTO coexistence.message_processing_evidence
             (message_id, phone_number_id, wa_number, contact_number, source_channel,
              processing_channel, actor_user_id, actor_ref, actor_username)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (message_id, processing_channel, actor_ref) DO NOTHING
           RETURNING message_id`,
          [
            row.message_id,
            row.phone_number_id,
            conversation.waNumber,
            conversation.contactNumber,
            SOURCE_CHANNEL,
            safeChannel,
            safeActor.id,
            safeActor.ref,
            safeActor.username,
          ]
        );
        if (inserted.rowCount === 1) insertedIds.add(row.message_id);
      }
      const stored = await client.query(
        `SELECT message_id, processed_at
           FROM coexistence.message_processing_evidence
          WHERE message_id = ANY($1::text[])
            AND actor_ref = $2
            AND processing_channel = $3`,
        [ids, safeActor.ref, safeChannel]
      );
      return publicEvidenceRows(ids, stored.rows, insertedIds);
    });

    return { results: evidence, count: evidence.length };
  }

  async function listMetaReadCandidates({
    actor,
    processingChannel,
    waNumber,
    contactNumber,
    limit = 20,
    includeResolved = false,
  }) {
    const safeActor = validateActor(actor);
    const safeChannel = validateProcessingChannel(processingChannel);
    const conversation = validateConversation(waNumber, contactNumber);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
      throw new MetaReadError(400, 'INVALID_LIMIT');
    }
    if (typeof includeResolved !== 'boolean') {
      throw new MetaReadError(400, 'INVALID_INCLUDE_RESOLVED');
    }

    const { rows } = await db.query(
      `SELECT e.message_id, e.processed_at, mr.status AS receipt_status, mr.completed_at
         FROM coexistence.message_processing_evidence e
         JOIN coexistence.chat_history ch
           ON ch.message_id = e.message_id
          AND ch.direction = 'incoming'
          AND ch.phone_number_id = e.phone_number_id
          AND ch.wa_number = e.wa_number
          AND ch.contact_number = e.contact_number
         JOIN coexistence.whatsapp_accounts a
           ON a.phone_number_id = ch.phone_number_id
          AND a.is_active = TRUE
         LEFT JOIN coexistence.meta_read_receipts mr
           ON mr.message_id = e.message_id
        WHERE e.wa_number = $1
          AND e.contact_number = $2
          AND e.actor_ref = $3
          AND e.processing_channel = $4
          AND e.source_channel = 'whatsapp'
          AND ($5::boolean OR mr.message_id IS NULL)
        ORDER BY ch.timestamp DESC, e.message_id DESC
        LIMIT $6`,
      [conversation.waNumber, conversation.contactNumber, safeActor.ref, safeChannel, includeResolved, limit]
    );
    return {
      messages: rows.map((row) => ({
        messageId: row.message_id,
        status: !row.receipt_status
          ? 'candidato'
          : row.receipt_status === 'read' ? 'already_read' : 'no_verificable',
        processedAt: row.processed_at,
        completedAt: row.completed_at || null,
      })),
      count: rows.length,
    };
  }

  async function finalizeReceipt(messageId, status, httpStatus, errorCode) {
    const { rows } = await db.query(
      `UPDATE coexistence.meta_read_receipts
          SET status = $2,
              completed_at = NOW(),
              http_status = $3,
              error_code = $4
        WHERE message_id = $1 AND status = 'claimed'
        RETURNING completed_at`,
      [messageId, status, httpStatus, errorCode]
    );
    if (rows.length !== 1) throw new Error('receipt finalization was not persisted');
    return rows[0].completed_at;
  }

  async function markFinalizeUncertain(messageId) {
    try {
      return await finalizeReceipt(messageId, 'no_verificable', null, 'finalize_error');
    } catch (_) {
      return null;
    }
  }

  async function confirmMetaRead({
    actor,
    processingChannel,
    waNumber,
    contactNumber,
    messageIds,
    confirm,
  }) {
    validateConfirmation(confirm);
    const safeActor = validateActor(actor);
    const safeChannel = validateProcessingChannel(processingChannel);
    const conversation = validateConversation(waNumber, contactNumber);
    const ids = validateMessageIds(messageIds);

    const claim = await withTransaction(db, async (client) => {
      const selection = await loadSelection(client, { messageIds: ids, ...conversation });
      await requireMatchingEvidence(client, {
        messageIds: ids,
        actor: safeActor,
        processingChannel: safeChannel,
      });
      const accountRow = await assertExactActiveAccount(client, selection.phoneNumberId);
      const credentials = await accountCredentials(accountRow);
      if (!credentials?.accessToken || credentials.phoneNumberId !== selection.phoneNumberId) {
        throw new MetaReadError(409, 'ACCOUNT_UNAVAILABLE');
      }

      const sortedIds = [...ids].sort();
      for (const messageId of sortedIds) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          [messageId]
        );
      }
      const existingResult = await client.query(
        `SELECT message_id, status, attempted_at, completed_at
           FROM coexistence.meta_read_receipts
          WHERE message_id = ANY($1::text[])`,
        [ids]
      );
      const existing = new Map(existingResult.rows.map((row) => [row.message_id, row]));
      const selectedById = new Map(selection.rows.map((row) => [row.message_id, row]));
      const newlyClaimed = new Set();
      for (const messageId of sortedIds) {
        if (existing.has(messageId)) continue;
        const row = selectedById.get(messageId);
        await client.query(
          `INSERT INTO coexistence.meta_read_receipts
             (message_id, phone_number_id, wa_number, contact_number, source_channel,
              processing_channel, actor_user_id, actor_ref, actor_username, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'claimed')`,
          [
            messageId,
            row.phone_number_id,
            conversation.waNumber,
            conversation.contactNumber,
            SOURCE_CHANNEL,
            safeChannel,
            safeActor.id,
            safeActor.ref,
            safeActor.username,
          ]
        );
        newlyClaimed.add(messageId);
      }
      return { credentials, existing, newlyClaimed };
    });

    const resultById = new Map();
    for (const messageId of ids) {
      const prior = claim.existing.get(messageId);
      if (prior) {
        resultById.set(messageId, {
          messageId,
          status: prior.status === 'read' ? 'already_read' : 'no_verificable',
          completedAt: prior.completed_at || null,
        });
        continue;
      }
      if (!claim.newlyClaimed.has(messageId)) {
        resultById.set(messageId, { messageId, status: 'no_verificable', completedAt: null });
        continue;
      }

      try {
        await sendRead({
          accessToken: claim.credentials.accessToken,
          phoneNumberId: claim.credentials.phoneNumberId,
          messageId,
        });
        let completedAt;
        try {
          completedAt = await finalizeReceipt(messageId, 'read', 200, null);
        } catch (_) {
          completedAt = await markFinalizeUncertain(messageId);
          resultById.set(messageId, { messageId, status: 'no_verificable', completedAt });
          continue;
        }
        resultById.set(messageId, { messageId, status: 'read', completedAt });
      } catch (error) {
        const classified = classifyMetaFailure(error);
        let completedAt;
        try {
          completedAt = await finalizeReceipt(
            messageId,
            classified.status,
            classified.httpStatus,
            classified.errorCode
          );
        } catch (_) {
          completedAt = await markFinalizeUncertain(messageId);
          classified.status = 'no_verificable';
        }
        resultById.set(messageId, {
          messageId,
          status: classified.status,
          completedAt,
        });
      }
    }

    const results = ids.map((messageId) => resultById.get(messageId));
    return { results, count: results.length };
  }

  return {
    recordProcessingEvidence,
    listMetaReadCandidates,
    confirmMetaRead,
  };
}

const defaultService = createMetaReadService();

module.exports = {
  MetaReadError,
  createMetaReadService,
  recordProcessingEvidence: defaultService.recordProcessingEvidence,
  listMetaReadCandidates: defaultService.listMetaReadCandidates,
  confirmMetaRead: defaultService.confirmMetaRead,
  _test: {
    classifyMetaFailure,
    validateMessageIds,
  },
};
