// Preserve outbound Meta status receipts across the short local-id -> wamid race.

const TERMINAL_OR_TRANSIT_STATUSES = new Set(['sent', 'delivered', 'read', 'failed', 'error']);
const MAX_MESSAGE_ID_LENGTH = 512;

function normalizeReceipt({ messageId, status, errorMessage }) {
  const normalizedMessageId = String(messageId || '');
  const normalizedStatus = String(status || '').toLowerCase();
  if (!normalizedMessageId || normalizedMessageId.length > MAX_MESSAGE_ID_LENGTH) return null;
  if (!TERMINAL_OR_TRANSIT_STATUSES.has(normalizedStatus)) return null;
  return {
    messageId: normalizedMessageId,
    status: normalizedStatus,
    errorMessage: errorMessage ? String(errorMessage).slice(0, 500) : null,
  };
}

async function lockOutboundMessage(db, messageId) {
  await db.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [String(messageId)]
  );
}

async function updateTrackedMessage(db, { messageId, status, errorMessage }) {
  return db.query(
    `UPDATE coexistence.chat_history
        SET status = CASE
              WHEN status IN ('read', 'failed', 'error') THEN status
              WHEN status = 'delivered' AND $2 = 'sent' THEN status
              ELSE $2
            END,
            error_message = CASE
              WHEN status IN ('failed', 'error') THEN error_message
              WHEN status = 'read' THEN NULL
              WHEN $2 IN ('failed', 'error') THEN COALESCE($3, error_message)
              ELSE NULL
            END
      WHERE message_id = $1`,
    [messageId, status, errorMessage]
  );
}

async function recordOutboundStatus(db, receipt) {
  const normalized = normalizeReceipt(receipt);
  if (!normalized) return 0;
  const { messageId, status, errorMessage } = normalized;

  await lockOutboundMessage(db, messageId);
  // A webhook can describe an external message that ForgeChat never tracked.
  // Bound those orphan receipts while keeping ample room for the millisecond race.
  await db.query(
    "DELETE FROM coexistence.outbound_status_receipts WHERE received_at < NOW() - INTERVAL '24 hours'"
  );
  await db.query(
    `INSERT INTO coexistence.outbound_status_receipts
       (message_id, status, error_message, received_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (message_id) DO UPDATE
       SET status = CASE
             WHEN outbound_status_receipts.status IN ('read', 'failed', 'error')
               THEN outbound_status_receipts.status
             WHEN outbound_status_receipts.status = 'delivered' AND EXCLUDED.status = 'sent'
               THEN outbound_status_receipts.status
             ELSE EXCLUDED.status
           END,
           error_message = CASE
             WHEN outbound_status_receipts.status IN ('failed', 'error')
               THEN outbound_status_receipts.error_message
             WHEN outbound_status_receipts.status = 'read' THEN NULL
             WHEN EXCLUDED.status IN ('failed', 'error')
               THEN COALESCE(EXCLUDED.error_message, outbound_status_receipts.error_message)
             ELSE NULL
           END,
           received_at = NOW()`,
    [messageId, status, errorMessage]
  );

  const result = await updateTrackedMessage(db, { messageId, status, errorMessage });
  if (result.rowCount === 1) {
    await db.query(
      'DELETE FROM coexistence.outbound_status_receipts WHERE message_id = $1',
      [messageId]
    );
  }
  return result.rowCount;
}

async function applyPendingOutboundStatus(db, messageId) {
  const { rows } = await db.query(
    `SELECT status, error_message
       FROM coexistence.outbound_status_receipts
      WHERE message_id = $1
      FOR UPDATE`,
    [messageId]
  );
  if (rows.length === 0) return false;
  if (rows.length !== 1) throw new Error('Outbound status receipt is ambiguous');

  const receipt = rows[0];
  const result = await updateTrackedMessage(db, {
    messageId,
    status: receipt.status,
    errorMessage: receipt.error_message,
  });
  if (result.rowCount !== 1) throw new Error('Outbound row missing while applying status receipt');

  await db.query(
    'DELETE FROM coexistence.outbound_status_receipts WHERE message_id = $1',
    [messageId]
  );
  return true;
}

module.exports = { applyPendingOutboundStatus, lockOutboundMessage, recordOutboundStatus };
