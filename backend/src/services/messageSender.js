// Central outbound orchestration. ALL message-sending paths funnel through here:
//   - Chat reply input  (routes/messages.js → POST /messages/send)
//   - Broadcast launch  (routes/broadcasts.js → /:id/send)
//   - Automation engine (engine/automationEngine.executeMessageNode)
//   - Template test     (routes/templates.js → /:id/test-send)
//
// Flow:
//   1. Insert optimistic chat_history row (status='sending', local message_id)
//   2. Enqueue BullMQ job (sendQueue.enqueueSend)
//   3. Worker calls Meta, then updates the row in place:
//        success → message_id = real wamid, status = 'sent'
//        failure → status = 'failed', error_message populated

const crypto = require('crypto');
const pool = require('../db');
const { getAccountByPhoneNumber, getAccountWithToken, getSingleAccount } = require('../routes/whatsappAccounts');
const { applyPendingOutboundStatus, lockOutboundMessage } = require('./outboundStatusReceipt');
const TERMINAL_OUTBOUND_STATUSES = new Set(['sent', 'delivered', 'read', 'failed', 'error', 'no_verificable']);

function localMessageId() {
  // Distinct from Meta's wamid format so we can tell them apart in logs
  return `local-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Resolve credentials for a sender. Accepts either an explicit accountId or a
 * fromPhoneNumber. Returns { account, error } — never throws.
 */
async function resolveAccount({ accountId, fromPhoneNumber }) {
  try {
    let acc = null;
    if (accountId) acc = await getAccountWithToken(accountId);
    else if (fromPhoneNumber) acc = await getAccountByPhoneNumber(fromPhoneNumber);
    // Single-account product: if matching by id/phone found nothing (e.g. the
    // display number isn't resolved from Meta yet), fall back to the lone account.
    if (!acc) acc = await getSingleAccount();
    if (!acc) return { error: `No WhatsApp Business account registered for ${fromPhoneNumber || `id=${accountId}`}` };
    if (!acc.isActive) return { error: `WhatsApp Business account "${acc.displayName}" is inactive` };
    if (!acc.accessToken) return { error: 'Access token missing (re-enter in Settings)' };
    return { account: acc };
  } catch (err) {
    return { error: err.message || 'Account lookup failed' };
  }
}

/**
 * Insert an optimistic chat_history row that the UI shows as "sending…".
 * The immutable send_correlation_id survives message_id changing to a wamid.
 *
 * G-BRAIN dedupe atómico: el índice único parcial
 * chat_history_ia360_handler_dedupe (contact_number, template_meta->>'ia360_handler_for')
 * convierte el dedupe IA360 en una garantía de base de datos. Si otra ruta ya
 * insertó una respuesta para el mismo handler, este INSERT no inserta nada
 * (ON CONFLICT DO NOTHING) y se devuelve null — el caller NO debe encolar.
 * Las filas sin ia360_handler_for (broadcasts, automation, chat manual) quedan
 * fuera del índice parcial y conservan el comportamiento de siempre.
 *
 * `db` acepta un client de pg para participar en una transacción del caller
 * (candado anti-doble-ruta del webhook IA360); default: el pool global.
 * `status` permite filas sandbox ('qa_sandboxed': fila visible y correlacionable
 * para los harness E2E, pero JAMÁS encolada hacia Meta); default: 'sending'.
 */
async function insertPendingRow({ account, toNumber, messageType, messageBody, mediaUrl = null, mediaMime = null, templateMeta = null, contextMessageId = null, rawPayloadExtra = null, db = pool, status = 'sending' }) {
  const messageId = localMessageId();
  const res = await db.query(
    `INSERT INTO coexistence.chat_history
       (message_id, send_correlation_id, phone_number_id, wa_number, contact_number, to_number,
        direction, message_type, message_body, raw_payload,
        media_url, media_mime_type, status, timestamp, template_meta, context_message_id)
     VALUES ($1,$1,$2,$3,$4,$5,'outgoing',$6,$7,$8,$9,$10,$13,NOW(),$11,$12)
     ON CONFLICT (contact_number, (template_meta->>'ia360_handler_for'))
       WHERE direction = 'outgoing' AND (template_meta->>'ia360_handler_for') IS NOT NULL
     DO NOTHING
     RETURNING message_id`,
    [
      messageId,
      account.phoneNumberId,
      account.displayPhoneNumber.replace(/\D/g, ''),
      String(toNumber).replace(/\D/g, ''),
      String(toNumber).replace(/\D/g, ''),
      messageType,
      messageBody || null,
      JSON.stringify({ origin: 'outbound', queued_at: new Date().toISOString(), ...(rawPayloadExtra ? { interactive: rawPayloadExtra } : {}) }),
      mediaUrl,
      mediaMime,
      templateMeta ? JSON.stringify(templateMeta) : null,
      contextMessageId || null,
      status,
    ]
  );
  if (res.rowCount === 0) {
    console.log('[messageSender] dedupe ON CONFLICT: fila no insertada (handler ya respondido) to=%s handler=%s',
      String(toNumber).replace(/\D/g, ''), templateMeta?.ia360_handler_for || '-');
    return null;
  }
  return messageId;
}

/**
 * Mark a previously-inserted row as accepted by Meta, swapping in the real
 * wamid while retaining the immutable correlation id.
 */
async function markSent(localId, wamid) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockOutboundMessage(client, wamid);
    const result = await client.query(
      `UPDATE coexistence.chat_history
          SET message_id = $1, status = 'sent', error_message = NULL
        WHERE send_correlation_id = $2`,
      [wamid, localId]
    );
    if (result.rowCount !== 1) throw new Error('Outbound correlation missing or ambiguous');
    await applyPendingOutboundStatus(client, wamid);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Mark a row as failed only while it is non-terminal. A late worker failure
 * must never overwrite provider acceptance or delivery receipts.
 */
async function markFailed(localId, errorMessage) {
  const result = await pool.query(
    `UPDATE coexistence.chat_history
        SET status = 'failed', error_message = $1
      WHERE send_correlation_id = $2
        AND status NOT IN ('sent', 'delivered', 'read', 'failed', 'error', 'no_verificable')`,
    [(errorMessage || 'send failed').slice(0, 500), localId]
  );
  if (result.rowCount === 1) return true;

  const correlated = await pool.query(
    `SELECT status
       FROM coexistence.chat_history
      WHERE send_correlation_id = $1`,
    [localId]
  );
  if (correlated.rowCount !== 1) throw new Error('Outbound correlation missing or ambiguous');
  if (TERMINAL_OUTBOUND_STATUSES.has(correlated.rows[0].status)) return false;
  throw new Error('Outbound correlation changed without reaching a terminal state');
}

/**
 * Return seconds-since the last incoming message from `contactNumber` to
 * `accountPhoneNumberId`. Returns null if no inbound message exists.
 * Meta's "customer service window" is 24h = 86400s.
 */
async function secondsSinceLastIncoming({ accountPhoneNumberId, contactNumber }) {
  const norm = String(contactNumber).replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))) AS seconds
       FROM coexistence.chat_history
      WHERE phone_number_id = $1
        AND contact_number = $2
        AND direction = 'incoming'`,
    [accountPhoneNumberId, norm]
  );
  const s = rows[0]?.seconds;
  return s != null ? Math.floor(s) : null;
}

module.exports = {
  resolveAccount,
  insertPendingRow,
  markSent,
  markFailed,
  secondsSinceLastIncoming,
  localMessageId,
  TERMINAL_OUTBOUND_STATUSES,
};
