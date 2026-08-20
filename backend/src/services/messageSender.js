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
const { markMessageRead } = require('../integrations/metaSend');
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
async function insertPendingRow({
  account,
  toNumber,
  messageType,
  messageBody,
  mediaUrl = null,
  mediaMime = null,
  templateMeta = null,
  contextMessageId = null,
  rawPayloadExtra = null,
  db = pool,
  status = 'sending',
  correlationId = null,
  surfaceAttestationRef = null,
  outboundPurpose = null,
  caseRef = null,
}) {
  const messageId = correlationId ? String(correlationId) : localMessageId();
  const res = await db.query(
    `INSERT INTO coexistence.chat_history
       (message_id, send_correlation_id, phone_number_id, wa_number, contact_number, to_number,
        direction, message_type, message_body, raw_payload,
        media_url, media_mime_type, status, timestamp, template_meta, context_message_id,
        surface_attestation_ref, outbound_purpose, case_ref)
     VALUES ($1,$1,$2,$3,$4,$5,'outgoing',$6,$7,$8,$9,$10,$13,NOW(),$11,$12,$14,$15,$16)
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
      surfaceAttestationRef || null,
      outboundPurpose || null,
      caseRef || null,
    ]
  );
  if (res.rowCount === 0) {
    console.log('[messageSender] dedupe ON CONFLICT: fila no insertada (handler ya respondido) to=%s handler=%s',
      String(toNumber).replace(/\D/g, ''), templateMeta?.ia360_handler_for || '-');
    return null;
  }
  return messageId;
}

// ─── Palomitas azules ───────────────────────────────────────────────────────
// Decisión de Alek (19-ago-2026): la palomita NO se activa al recibir, sino
// cuando el agente ya tiene respuesta lista. Y como SIEMPRE hay respuesta —aunque
// sea el acuse automático— el contacto igual ve que lo leyeron.
//
// El enganche definitivo ocurre después de que BullMQ acepta el job. La fila y
// su índice único parcial conservan el dedupe, pero nunca se enciende la palomita
// si Redis rechazó el enqueue o la transacción se revirtió.
//
// El wamid del inbound viaja dentro de `ia360_handler_for`, que es o el wamid
// pelado o `<wamid>:direct:<to>:<label>`. Los wamid no llevan ':', así que el
// primer segmento es el mensaje al que hay que contestarle la lectura.
const LEIDOS_RECIENTES = new Set();
const LEIDOS_MAX = 500;

/**
 * Enciende la palomita azul de UN inbound. Sirve para los carriles que tienen su
 * propio egress y no pasan por `insertPendingRow` (hoy: diapazo-inbound).
 * Idempotente en proceso: varios textos por un mismo inbound = un solo acuse.
 */
function marcarLeidoDeInbound({ account, inboundMessageId, sendRead = markMessageRead }) {
  try {
    const inbound = String(inboundMessageId || '');
    // Sólo wamid reales. Los de los harness (`wamid.e2e.…`, `wamid.qa.…`) TAMBIÉN
    // empiezan con `wamid.`, así que el prefijo no basta: sin este segundo filtro,
    // cada corrida de las pruebas dispararía una llamada real a Meta que falla.
    // Mismo criterio que `isIa360SyntheticWamid` en webhook.js: sólo el patrón con
    // puntos, porque el base64 de un wamid real no contiene puntos.
    if (!inbound.startsWith('wamid.')) return;
    if (/(^|\.)(e2e|qa[-_a-z0-9]*|harness)\./i.test(inbound)) return;
    if (LEIDOS_RECIENTES.has(inbound)) return;
    if (LEIDOS_RECIENTES.size >= LEIDOS_MAX) LEIDOS_RECIENTES.clear();
    LEIDOS_RECIENTES.add(inbound);
    // Fire-and-forget: la palomita NUNCA puede retrasar ni tumbar el envío.
    sendRead({
      accessToken: account.accessToken,
      phoneNumberId: account.phoneNumberId,
      messageId: inbound,
    }).catch(err => console.error('[palomita] no se pudo marcar leído %s: %s', inbound, err.message));
  } catch (err) {
    console.error('[palomita] error inesperado:', err.message);
  }
}

function marcarLeidoAlResponder({ account, templateMeta, status, sendRead = markMessageRead }) {
  if (status !== 'sending') return; // 'qa_sandboxed' no sale a Meta
  const handler = templateMeta?.ia360_handler_for;
  if (!handler) return; // broadcasts, automation y chat manual quedan fuera
  marcarLeidoDeInbound({ account, inboundMessageId: String(handler).split(':')[0], sendRead });
}

async function markInboundReadAfterEnqueue({
  accountId,
  localMessageId,
  db = pool,
  loadAccount = getAccountWithToken,
  sendRead = markMessageRead,
}) {
  if (!accountId || !localMessageId) return false;
  const { rows } = await db.query(
    `SELECT template_meta, status
       FROM coexistence.chat_history
      WHERE send_correlation_id=$1`,
    [localMessageId]
  );
  if (rows.length !== 1 || rows[0].status !== 'sending'
      || !rows[0].template_meta?.ia360_handler_for) return false;
  const account = await loadAccount(accountId);
  if (!account) return false;
  marcarLeidoAlResponder({
    account,
    templateMeta: rows[0].template_meta,
    status: rows[0].status,
    sendRead,
  });
  return true;
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

async function markNoVerificable(localId, publicCode = 'FOLLOWUP_SEND_UNKNOWN') {
  const result = await pool.query(
    `UPDATE coexistence.chat_history
        SET status = 'no_verificable', error_message = $1
      WHERE send_correlation_id = $2
        AND status NOT IN ('sent', 'delivered', 'read', 'failed', 'error', 'no_verificable')`,
    [String(publicCode).slice(0, 120), localId]
  );
  if (result.rowCount === 1) return true;
  const correlated = await pool.query(
    `SELECT status FROM coexistence.chat_history WHERE send_correlation_id = $1`,
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
  markNoVerificable,
  secondsSinceLastIncoming,
  localMessageId,
  TERMINAL_OUTBOUND_STATUSES,
  marcarLeidoDeInbound,
  markInboundReadAfterEnqueue,
  _test: { marcarLeidoAlResponder, marcarLeidoDeInbound },
};
