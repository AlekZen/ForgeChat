// BullMQ outbound send queue. Rate-limited at 60 messages/sec by default
// (well under Meta Tier 1's 80/sec ceiling). All four send-origin paths
// (chat reply, broadcast, automation, template test) enqueue here.

const { Queue, Worker, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const pool = require('../db');
const { getAccountWithToken } = require('../routes/whatsappAccounts');
const { sendText, sendTemplate, sendMedia, sendInteractive, sendLocation, sendContacts, sendReaction } = require('../integrations/metaSend');
const { markSent, markFailed, markNoVerificable, markInboundReadAfterEnqueue } = require('../services/messageSender');
const { markAccountHealth, classifyMetaError } = require('../services/accountHealth');
const { validateTemplateSend } = require('../integrations/templateValidator');
const {
  SurfaceContractError,
  resolveContactAccountKey,
  validateOutboundAttestation,
  validatePurposeAndUrls,
} = require('../services/outboundSurfaceContract');
const {
  FollowUpError,
  claimFollowUpOutbound,
  onFollowUpOutboundAccepted,
  onFollowUpOutboundFailed,
  onFollowUpOutboundUnknown,
} = require('../services/followUpService');

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const QUEUE_NAME = 'forgecrm-send';
const CONCURRENCY = parseInt(process.env.SEND_QUEUE_CONCURRENCY || '5', 10);
const RATE_MAX = parseInt(process.env.SEND_RATE_MAX || '60', 10);
const RATE_DURATION_MS = parseInt(process.env.SEND_RATE_DURATION_MS || '1000', 10);
const ATTEMPTS = 1;

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
connection.on('error', err => console.error('[sendQueue] redis error:', err.message));

const sendQueue = new Queue(QUEUE_NAME, { connection });

let worker = null;
let queueEvents = null;

/**
 * Job data shape:
 * {
 *   kind: 'text' | 'template' | 'media',
 *   accountId: number,        // resolved WhatsApp account id
 *   to: string,               // recipient phone (digits only)
 *   localMessageId: string,   // matches the optimistic chat_history row
 *   payload: {                // shape depends on kind
 *     // text:    { body, previewUrl? }
 *     // template:{ name, languageCode, components, broadcastLogId? }
 *     // media:   { type, mediaId | link, caption?, filename? }
 *   },
 *   originRef?: {             // optional cross-table linkage for status writes
 *     kind: 'broadcast_log' | 'automation_step',
 *     id: number,
 *   }
 * }
 */
// El carril del operador (nx-forgechat) encola templates sin template_meta, y
// `handleEntregaButton` del webhook rutea los botones de entrega por
// `template_meta->>'template_name'`: sin ese sello el botón del contacto cae al
// clasificador léxico y termina en `ia360_boton_sin_ruta` (medido 2026-08-11).
// Se sella aquí, el único choke point por el que pasan TODOS los envíos de
// template, sin pisar las claves que la ruta origen ya haya escrito.
async function stampTemplateName(localMessageId, templateName) {
  if (!localMessageId || !templateName) return;
  await pool.query(
    `UPDATE coexistence.chat_history
        SET template_meta = jsonb_set(COALESCE(template_meta, '{}'::jsonb), '{template_name}', to_jsonb($1::text))
      WHERE send_correlation_id = $2
        AND COALESCE(template_meta->>'template_name', '') = ''`,
    [String(templateName), localMessageId]
  ).catch(err => console.error('[sendQueue] template_name stamp failed:', err.message));
}

async function validateSurfaceContractBeforeMeta({ kind, account, to, localMessageId, payload, requiresSurfaceContract = false }) {
  if (!localMessageId) return null;
  const { rows } = await pool.query(
    `SELECT phone_number_id, contact_number, message_body, surface_attestation_ref,
            outbound_purpose, case_ref, send_correlation_id
       FROM coexistence.chat_history
      WHERE send_correlation_id = $1`,
    [localMessageId]
  );
  if (rows.length !== 1) {
    if (requiresSurfaceContract) {
      throw new SurfaceContractError('SURFACE_NOT_AUTHORIZED', 'No existe un único outbox para el contrato.');
    }
    return null;
  }
  const row = rows[0];
  if (!row.outbound_purpose && !row.surface_attestation_ref) {
    if (requiresSurfaceContract) {
      throw new SurfaceContractError('SURFACE_NOT_AUTHORIZED', 'El outbox perdió su contrato de superficie.');
    }
    return null;
  }
  if (String(row.phone_number_id || '') !== String(account.phoneNumberId || '')) {
    throw new SurfaceContractError('SURFACE_NOT_AUTHORIZED', 'La cuenta emisora no coincide con el contrato.');
  }
  if (String(row.contact_number || '') !== String(to || '').replace(/\D/g, '')) {
    throw new SurfaceContractError('SURFACE_NOT_AUTHORIZED', 'El contacto no coincide con el contrato.');
  }

  let finalBody;
  if (kind === 'text') finalBody = String(payload?.body || '');
  else if (kind === 'media') finalBody = String(payload?.caption || '');
  else finalBody = String(row.message_body || '');
  if (kind === 'text' && finalBody !== String(row.message_body || '')) {
    throw new SurfaceContractError('SURFACE_URL_MISMATCH', 'El job no coincide con el payload persistido.');
  }

  const accountKey = await resolveContactAccountKey(pool, row.contact_number);
  if (row.surface_attestation_ref) {
    return validateOutboundAttestation(pool, {
      attestationRef: row.surface_attestation_ref,
      accountKey,
      contactNumber: row.contact_number,
      body: finalBody,
      correlationId: row.send_correlation_id,
    });
  }
  validatePurposeAndUrls({ purpose: row.outbound_purpose, surface: null, body: finalBody });
  return { purpose: row.outbound_purpose, caseRef: row.case_ref };
}

function isFollowUpOrigin(originRef) {
  return originRef?.kind === 'follow_up_opener' || originRef?.kind === 'follow_up_delivery';
}

function isAmbiguousSendError(error) {
  if (error?.providerAcceptancePossible) return true;
  const codes = [error?.code, error?.cause?.code]
    .map(value => String(value || '').toUpperCase())
    .filter(Boolean);
  const ambiguousCodes = new Set([
    'ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  ]);
  if (codes.some(code => ambiguousCodes.has(code))) return true;
  const messages = `${error?.message || ''} ${error?.cause?.message || ''}`;
  return /(fetch failed|timeout|timed out|socket hang up|connection reset|meta returned no message id)/i.test(messages);
}

function publicSendCode(error, ambiguous) {
  if (ambiguous) return 'FOLLOWUP_SEND_UNKNOWN';
  if (error?.templateBlocked) return 'FOLLOWUP_TRIGGER_FAILED';
  if (error instanceof SurfaceContractError || error instanceof FollowUpError) return error.code;
  return 'FOLLOWUP_SEND_FAILED';
}

async function processJob(job) {
  const { kind, accountId, to, localMessageId, payload, originRef, requiresSurfaceContract } = job.data || {};
  if (isFollowUpOrigin(originRef)) await claimFollowUpOutbound({ db: pool, originRef });
  const account = await getAccountWithToken(accountId);
  if (!account) throw new Error(`Account id=${accountId} not found`);
  if (!account.accessToken) throw new Error('Access token missing');
  if (!account.isActive) throw new Error(`Account "${account.displayName}" is inactive`);

  const args = {
    accessToken: account.accessToken,
    phoneNumberId: account.phoneNumberId,
    to,
  };

  // Universal pre-Meta guard: block any template whose outgoing component shape
  // (body/header-media/URL-button param counts) does not match the
  // Meta-registered spec. This is the last choke point every template send
  // funnels through, so it catches mismatches from ALL paths (owner pipe,
  // reminders, automation, broadcasts, test-send) before they reach Meta and
  // burn as #132000 / #132012. Thrown as skipRetry so the optimistic row is
  // marked failed once, with the exact reason, and nothing hits Meta.
  if (kind === 'template') {
    const v = await validateTemplateSend(account, payload.name, payload.languageCode, payload.components);
    if (!v.valid) {
      const e = new Error(`template "${payload.name}" blocked pre-Meta: ${v.errors.join('; ')} [authority=${v.source}]`);
      e.skipRetry = true;
      e.templateBlocked = true;
      throw e;
    }
  }

  await validateSurfaceContractBeforeMeta({ kind, account, to, localMessageId, payload, requiresSurfaceContract });

  // G-BRAIN sandbox QA: los números 52199900XXXXX son ficticios (harness E2E).
  // Enviarlos por el WABA real es riesgo de calidad ante Meta (decenas de envíos
  // a números inexistentes). Tras pasar la validación de template (fidelidad del
  // test), se corta AQUÍ — el único choke point de egress — sin llamar a Meta: la
  // fila optimista se marca 'sent' con un wamid sintético, así los harness que
  // esperan status='sent' siguen en verde con cero egress real.
  // OJO (hallazgo de review): el patrón DEBE ser el rango QA exacto. 999 es la
  // lada de Mérida — un patrón ancho tipo ^521999 dejaría mudo a un cliente real.
  if (/^52199900\d{5}$/.test(String(to || ''))) {
    const sandboxWamid = `wamid.qa-sandbox.${Date.now()}.${job.id || '0'}`;
    if (localMessageId) await markSent(localMessageId, sandboxWamid);
    if (kind === 'template') await stampTemplateName(localMessageId, payload?.name);
    if (isFollowUpOrigin(originRef)) {
      await onFollowUpOutboundAccepted({ db: pool, originRef, wamid: sandboxWamid });
    }
    console.log('[sendQueue] QA sandbox: egress a Meta OMITIDO kind=%s to=%s wamid=%s', kind, to, sandboxWamid);
    return { wamid: sandboxWamid, qaSandbox: true };
  }

  let result;
  try {
    if (kind === 'text') {
      result = await sendText({ ...args, body: payload.body, previewUrl: payload.previewUrl, contextMessageId: payload.contextMessageId });
    } else if (kind === 'template') {
      result = await sendTemplate({ ...args, templateName: payload.name, languageCode: payload.languageCode, components: payload.components });
    } else if (kind === 'media') {
      result = await sendMedia({ ...args, type: payload.type, mediaId: payload.mediaId, link: payload.link, caption: payload.caption, filename: payload.filename, contextMessageId: payload.contextMessageId });
    } else if (kind === 'interactive') {
      result = await sendInteractive({ ...args, interactive: payload.interactive });
    } else if (kind === 'location') {
      result = await sendLocation({ ...args, latitude: payload.latitude, longitude: payload.longitude, name: payload.name, address: payload.address });
    } else if (kind === 'contacts') {
      result = await sendContacts({ ...args, contacts: payload.contacts });
    } else if (kind === 'reaction') {
      result = await sendReaction({ ...args, messageId: payload.messageId, emoji: payload.emoji });
    } else {
      throw new Error(`unknown send kind: ${kind}`);
    }
    await markAccountHealth(account.id, 'healthy');
  } catch (err) {
    const cls = classifyMetaError(err);
    await markAccountHealth(account.id, cls, err.message);
    // Outbound egress is at-most-once. Every synchronous provider rejection is
    // terminal for this job; operators inspect state instead of replaying it.
    if (cls === 'invalid_token' || cls === 'payment_blocked') {
      err.skipRetry = true;
    }
    throw err;
  }

  const wamid = result?.messages?.[0]?.id;
  if (!wamid) {
    const error = new Error('Meta returned no message id');
    error.providerAcceptancePossible = true;
    throw error;
  }

  // Meta ya pudo aceptar el mensaje. Cualquier fallo local posterior es ambiguo:
  // nunca autoriza un segundo POST.
  try {
    if (localMessageId) await markSent(localMessageId, wamid);
    if (kind === 'template') await stampTemplateName(localMessageId, payload?.name);
    if (isFollowUpOrigin(originRef)) {
      await onFollowUpOutboundAccepted({ db: pool, originRef, wamid });
    }
  } catch (error) {
    error.providerAcceptancePossible = true;
    throw error;
  }

  // Update origin-side linkage (broadcast_log etc) if provided
  if (originRef?.kind === 'broadcast_log' && originRef.id) {
    await pool.query(
      `UPDATE coexistence.broadcast_logs
          SET status = 'sent', wa_message_id = $1, sent_at = NOW()
        WHERE id = $2`,
      [wamid, originRef.id]
    ).catch(err => console.error('[sendQueue] broadcast_log update failed:', err.message));
  }
  if (originRef?.kind === 'automation_step' && originRef.id) {
    await pool.query(
      `UPDATE coexistence.automation_execution_steps
          SET wa_message_id = $1, wa_message_status = 'sent'
        WHERE id = $2`,
      [wamid, originRef.id]
    ).catch(() => {});
  }

  return { wamid };
}

function startSendWorker() {
  if (worker) return worker;
  worker = new Worker(QUEUE_NAME, processJob, {
    connection,
    concurrency: CONCURRENCY,
    limiter: { max: RATE_MAX, duration: RATE_DURATION_MS },
  });

  worker.on('completed', (job) => {
    console.log(`[sendQueue] ${job.data?.kind} to ${job.data?.to} → ${job.returnvalue?.wamid}`);
  });
  worker.on('failed', async (job, err) => {
    const localId = job?.data?.localMessageId;
    console.error(`[sendQueue] ${job?.data?.kind} to ${job?.data?.to} failed attempt=${job?.attemptsMade || 1}/${ATTEMPTS}: ${err.message}`);
    if (localId) {
      const ambiguous = isAmbiguousSendError(err);
      const code = publicSendCode(err, ambiguous);
      if (ambiguous) await markNoVerificable(localId, code).catch(() => {});
      else await markFailed(localId, code).catch(() => {});
      if (isFollowUpOrigin(job?.data?.originRef)) {
        const callback = ambiguous ? onFollowUpOutboundUnknown : onFollowUpOutboundFailed;
        await callback({ db: pool, originRef: job.data.originRef, publicCode: code }).catch(() => {});
      }
      if (job?.data?.originRef?.kind === 'broadcast_log') {
        await pool.query(
          `UPDATE coexistence.broadcast_logs SET status='failed', error_message=$1 WHERE id=$2`,
          [err.message.slice(0, 500), job.data.originRef.id]
        ).catch(() => {});
      }
    }
  });

  queueEvents = new QueueEvents(QUEUE_NAME, { connection });
  queueEvents.on('error', err => console.error('[sendQueue] events error:', err.message));

  console.log(`[sendQueue] worker started, concurrency=${CONCURRENCY}, rate=${RATE_MAX}/${RATE_DURATION_MS}ms, attempts=${ATTEMPTS}`);
  return worker;
}

async function enqueueSend(jobData, opts = {}) {
  const idKey = jobData.localMessageId || `${jobData.accountId}-${jobData.to}-${Date.now()}`;
  // BullMQ reserva ':' como separador interno; la correlación durable lo usa,
  // así que el jobId conserva identidad sustituyendo sólo ese separador.
  const stableJobId = `send-${String(idKey).replace(/:/g, '~')}`;
  const addOpts = {
    jobId: stableJobId,
    attempts: ATTEMPTS,
    removeOnComplete: { count: 500, age: 3600 },
    removeOnFail: { count: 1000, age: 86400 },
  };
  // Optional delayed delivery (used by automation Delay nodes so a later message
  // lands after an earlier one). BullMQ holds the job for `delayMs` before a
  // worker picks it up — non-blocking, no scheduler needed.
  if (opts.delayMs && opts.delayMs > 0) addOpts.delay = Math.round(opts.delayMs);
  await sendQueue.add('send', jobData, addOpts);
  await markInboundReadAfterEnqueue({
    accountId: jobData.accountId,
    localMessageId: jobData.localMessageId,
  }).catch(error => console.error('[palomita] post-enqueue read failed:', error.message));
}

async function shutdownSendQueue() {
  try {
    if (worker) await worker.close();
    if (queueEvents) await queueEvents.close();
    await sendQueue.close();
    await connection.quit();
  } catch (err) {
    console.error('[sendQueue] shutdown error:', err.message);
  }
}

module.exports = {
  sendQueue,
  startSendWorker,
  enqueueSend,
  shutdownSendQueue,
  processJob,
  validateSurfaceContractBeforeMeta,
  isAmbiguousSendError,
};
