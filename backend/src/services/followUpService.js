'use strict';

const crypto = require('crypto');
const pool = require('../db');
const { insertPendingRow } = require('./messageSender');
const {
  SurfaceContractError,
  attestOutboundPayload,
  listAuthorizedSurfaces,
  resolveContactAccountKey,
  validatePurposeAndUrls,
} = require('./outboundSurfaceContract');

const TEMPLATE_NAME = 'ia360_seguimiento_entregable_v1';
const TEMPLATE_LANGUAGE = 'es_MX';
const POSITIVE_BUTTON = 'Sí, compártelo';
const DEFER_BUTTON = 'Después';
const ACTIVE_STATES = ['prepared', 'opener_sending', 'active', 'claimed', 'queued', 'sending'];
const PUBLIC_STATES = new Set([
  ...ACTIVE_STATES,
  'sent', 'delivered', 'read', 'failed', 'error', 'no_verificable', 'cancelled', 'expired',
]);
const TERMINAL_STATES = new Set(['sent', 'delivered', 'read', 'failed', 'error', 'no_verificable', 'cancelled', 'expired']);
const LEASE_SECONDS = 120;

class FollowUpError extends Error {
  constructor(code, message = code, status = 400) {
    super(message);
    this.name = 'FollowUpError';
    this.code = code;
    this.status = status;
    this.public = true;
  }
}

function fail(code, message, status) {
  throw new FollowUpError(code, message, status);
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function actorId(actor) {
  const value = actor?.id ?? actor?.userId ?? actor?.actorId;
  if (value == null || String(value).trim() === '') fail('FOLLOWUP_FORBIDDEN', 'Actor requerido.', 403);
  return String(value);
}

function newFollowUpRef() {
  return `q_${crypto.randomBytes(6).toString('hex')}`;
}

function publicFollowUp(row, extra = {}) {
  if (!row) return null;
  return {
    ok: true,
    followUpRef: row.public_ref,
    status: PUBLIC_STATES.has(row.state) ? row.state : 'error',
    caseRef: row.case_ref,
    purpose: row.purpose,
    expiresAt: row.expires_at,
    errorCode: row.last_error_code || null,
    ...extra,
  };
}

function buttonTexts(buttons) {
  if (!Array.isArray(buttons)) return [];
  return buttons.map(button => String(button?.text ?? button?.title ?? button?.reply?.title ?? '').trim());
}

function assertApprovedTrigger(template) {
  const texts = buttonTexts(template?.buttons);
  if (
    !template
    || template.name !== TEMPLATE_NAME
    || template.status !== 'APPROVED'
    || template.category !== 'UTILITY'
    || template.language !== TEMPLATE_LANGUAGE
    || texts.length !== 2
    || texts[0] !== POSITIVE_BUTTON
    || texts[1] !== DEFER_BUTTON
  ) {
    fail('FOLLOWUP_TRIGGER_FAILED', 'El template aprobado no coincide con el contrato.');
  }
}

async function resolveSender(db, fromNumber) {
  const from = digits(fromNumber);
  const { rows } = await db.query(
    `SELECT id, phone_number_id, display_phone_number, is_active
       FROM coexistence.whatsapp_accounts
      WHERE regexp_replace(display_phone_number, '[^0-9]', '', 'g') = $1`,
    [from]
  );
  if (rows.length !== 1 || !rows[0].is_active) {
    fail('FOLLOWUP_TRIGGER_FAILED', 'La cuenta emisora no se resolvió de forma única.');
  }
  return rows[0];
}

async function assertSenderContactPair(db, fromNumber, toNumber) {
  const { rows } = await db.query(
    `SELECT id, COALESCE(name, profile_name) AS name
       FROM coexistence.contacts
      WHERE regexp_replace(wa_number, '[^0-9]', '', 'g') = $1
        AND regexp_replace(contact_number, '[^0-9]', '', 'g') = $2`,
    [digits(fromNumber), digits(toNumber)]
  );
  if (rows.length !== 1) fail('FOLLOWUP_NOT_FOUND', 'El contacto no pertenece a la cuenta emisora.', 404);
  return rows[0];
}

function openerComponents(contactName, deliverable) {
  return [{
    type: 'body',
    parameters: [
      { type: 'text', text: String(contactName || '¿cómo estás?') },
      { type: 'text', text: String(deliverable) },
    ],
  }];
}

async function loadApprovedTemplate(db, senderId) {
  const { rows } = await db.query(
    `SELECT id, name, category, language, status, buttons, body, whatsapp_account_id
       FROM coexistence.message_templates
      WHERE whatsapp_account_id = $1
        AND name = $2
        AND language = $3`,
    [senderId, TEMPLATE_NAME, TEMPLATE_LANGUAGE]
  );
  if (rows.length !== 1) fail('FOLLOWUP_TRIGGER_FAILED', 'No existe un único template aprobado para la cuenta.');
  assertApprovedTrigger(rows[0]);
  return rows[0];
}

async function validatePreparedBody(db, { accountKey, purpose, surfaceKey, body }) {
  const surfaces = await listAuthorizedSurfaces(db, { accountKey });
  const surface = surfaceKey ? surfaces.find(item => item.surface_key === surfaceKey) : null;
  if (surfaceKey && !surface) throw new SurfaceContractError('SURFACE_NOT_AUTHORIZED', 'La superficie no pertenece a la cuenta.');
  validatePurposeAndUrls({ purpose, surface, body });
  return surface;
}

async function addEvent(db, followUpId, eventType, {
  correlationId = null,
  inboundMessageId = null,
  publicCode = null,
} = {}) {
  await db.query(
    `INSERT INTO coexistence.message_followup_events
       (followup_id, event_type, correlation_id, inbound_message_id, public_code)
     VALUES ($1,$2,$3,$4,$5)`,
    [followUpId, eventType, correlationId, inboundMessageId, publicCode]
  );
}

async function queueFollowUpJob(jobData) {
  const { enqueueSend } = require('../queue/sendQueue');
  return enqueueSend(jobData);
}

async function prepareFollowUp({
  db = pool,
  actor,
  fromNumber,
  toNumber,
  caseRef,
  deliverable,
  purpose,
  surfaceKey = null,
  body,
  ttlHours = 72,
}) {
  const who = actorId(actor);
  const ttl = Number(ttlHours);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 168) fail('FOLLOWUP_INVALID_TTL', 'La vigencia debe ser de 1 a 168 horas.');
  if (!caseRef || !deliverable || typeof body !== 'string' || !body.trim()) {
    fail('FOLLOWUP_INVALID_INPUT', 'Caso, entregable y texto son obligatorios.');
  }
  if (body.length > 4096) fail('FOLLOWUP_INVALID_INPUT', 'El texto excede 4096 caracteres.');

  const sender = await resolveSender(db, fromNumber);
  const contact = await assertSenderContactPair(db, fromNumber, toNumber);
  const accountKey = await resolveContactAccountKey(db, toNumber);
  const template = await loadApprovedTemplate(db, sender.id);
  await validatePreparedBody(db, { accountKey, purpose, surfaceKey, body: body.trim() });

  const active = await db.query(
    `SELECT public_ref, state, case_ref, purpose, expires_at, last_error_code
       FROM coexistence.message_followups
      WHERE account_key = $1
        AND phone_number_id = $2
        AND contact_number = $3
        AND state = ANY($4::text[])
      LIMIT 2`,
    [accountKey, sender.phone_number_id, digits(toNumber), ACTIVE_STATES]
  );
  if (active.rows.length) fail('FOLLOWUP_ALREADY_ACTIVE', 'Ya existe un seguimiento activo para el contacto.', 409);

  if (actor?.dryRun === true) {
    return {
      ok: true,
      status: 'dry_run',
      caseRef: String(caseRef),
      purpose,
      surfaceKey: surfaceKey || null,
      templateName: TEMPLATE_NAME,
    };
  }

  const followUpRef = newFollowUpRef();
  const openerCorrelation = `${followUpRef}:opener`;
  const finalCorrelation = `${followUpRef}:delivery`;
  const client = await db.connect();
  let followUp;
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(73611, hashtext($1))',
      [`${accountKey}:${sender.phone_number_id}:${digits(toNumber)}`]
    );
    const raced = await client.query(
      `SELECT 1 FROM coexistence.message_followups
        WHERE account_key=$1 AND phone_number_id=$2 AND contact_number=$3
          AND state = ANY($4::text[])
        LIMIT 1`,
      [accountKey, sender.phone_number_id, digits(toNumber), ACTIVE_STATES]
    );
    if (raced.rows.length) fail('FOLLOWUP_ALREADY_ACTIVE', 'Ya existe un seguimiento activo para el contacto.', 409);

    const attestation = await attestOutboundPayload(client, {
      accountKey,
      caseRef: String(caseRef),
      purpose,
      surfaceKey: surfaceKey || null,
      body: body.trim(),
      correlationId: finalCorrelation,
      actorId: who,
    });
    const inserted = await client.query(
      `INSERT INTO coexistence.message_followups
         (public_ref, account_key, phone_number_id, from_number, contact_number,
          case_ref, actor_id, deliverable, prepared_body, purpose, surface_key,
          surface_attestation_ref, template_name, template_language,
          opener_correlation_id, final_correlation_id, state, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'prepared',
               NOW() + ($17::text || ' hours')::interval)
       RETURNING *`,
      [
        followUpRef, accountKey, sender.phone_number_id, digits(fromNumber), digits(toNumber),
        String(caseRef), who, String(deliverable), body.trim(), purpose, surfaceKey || null,
        attestation?.attestationRef || null, TEMPLATE_NAME, TEMPLATE_LANGUAGE,
        openerCorrelation, finalCorrelation, String(ttl),
      ]
    );
    followUp = inserted.rows[0];
    await insertPendingRow({
      account: {
        phoneNumberId: sender.phone_number_id,
        displayPhoneNumber: sender.display_phone_number,
      },
      toNumber,
      messageType: 'template',
      messageBody: template.body || TEMPLATE_NAME,
      templateMeta: {
        template_name: TEMPLATE_NAME,
        language: TEMPLATE_LANGUAGE,
        follow_up_ref: followUpRef,
        source: 'follow_up_opener',
      },
      db: client,
      correlationId: openerCorrelation,
    });
    await addEvent(client, followUp.id, 'prepared', { correlationId: openerCorrelation });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  let queued = true;
  try {
    await queueFollowUpJob({
      kind: 'template',
      accountId: sender.id,
      to: digits(toNumber),
      localMessageId: openerCorrelation,
      payload: {
        name: TEMPLATE_NAME,
        languageCode: TEMPLATE_LANGUAGE,
        components: openerComponents(contact.name, deliverable),
      },
      originRef: { kind: 'follow_up_opener', ref: followUpRef },
    });
  } catch {
    queued = false;
    await addEvent(db, followUp.id, 'queue_unavailable', {
      correlationId: openerCorrelation,
      publicCode: 'FOLLOWUP_QUEUE_UNAVAILABLE',
    }).catch(() => {});
  }
  return publicFollowUp(followUp, { queued });
}

async function findScopedFollowUp(db, { fromNumber, toNumber, followUpRef }) {
  const { rows } = await db.query(
    `SELECT *
       FROM coexistence.message_followups
      WHERE public_ref = $1
        AND from_number = $2
        AND contact_number = $3`,
    [followUpRef, digits(fromNumber), digits(toNumber)]
  );
  if (rows.length !== 1) fail('FOLLOWUP_NOT_FOUND', 'Seguimiento no encontrado.', 404);
  return rows[0];
}

async function getFollowUpStatus({ db = pool, actor, fromNumber, toNumber, followUpRef }) {
  actorId(actor);
  return publicFollowUp(await findScopedFollowUp(db, { fromNumber, toNumber, followUpRef }));
}

async function cancelFollowUp({ db = pool, actor, fromNumber, toNumber, followUpRef }) {
  actorId(actor);
  const current = await findScopedFollowUp(db, { fromNumber, toNumber, followUpRef });
  if (actor?.dryRun === true) return publicFollowUp(current, { status: 'dry_run' });
  if (current.state === 'cancelled') return publicFollowUp(current);
  if (!['prepared', 'active', 'claimed', 'queued'].includes(current.state)) {
    fail('FOLLOWUP_NOT_CANCELLABLE', 'El seguimiento ya no se puede cancelar.', 409);
  }
  const { rows } = await db.query(
    `UPDATE coexistence.message_followups
        SET state='cancelled', lease_token=NULL, lease_expires_at=NULL,
            last_error_code='operator_cancelled', updated_at=NOW()
      WHERE id=$1 AND state = ANY($2::text[])
      RETURNING *`,
    [current.id, ['prepared', 'active', 'claimed', 'queued']]
  );
  if (!rows.length) fail('FOLLOWUP_NOT_CANCELLABLE', 'El seguimiento cambió de estado.', 409);
  await addEvent(db, current.id, 'cancelled', { publicCode: 'operator_cancelled' });
  return publicFollowUp(rows[0]);
}

function classifyInbound(record) {
  const body = String(
    record?.interactive_reply_title
    || record?.interactive_reply_id
    || record?.message_body
    || ''
  ).trim();
  const normalized = body.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (normalized === 'despues') return 'defer';
  if (normalized === 'si, compartelo' || normalized === 'si compartelo') return 'deliver';
  if (/(quiero|dame|necesito|enviame|envia|pasame|pasa|manda|comparte|comparteme).*(enlace|link|liga|url)/i.test(normalized)) return 'deliver';
  return null;
}

async function materializeDelivery(client, followUp, record) {
  const accountResult = await client.query(
    `SELECT id, phone_number_id, display_phone_number, is_active
       FROM coexistence.whatsapp_accounts
      WHERE phone_number_id=$1`,
    [followUp.phone_number_id]
  );
  if (accountResult.rows.length !== 1 || !accountResult.rows[0].is_active) {
    fail('FOLLOWUP_TRIGGER_FAILED', 'La cuenta emisora ya no está activa.');
  }
  const account = accountResult.rows[0];
  const existing = await client.query(
    `SELECT message_id FROM coexistence.chat_history WHERE send_correlation_id=$1`,
    [followUp.final_correlation_id]
  );
  if (!existing.rows.length) {
    await insertPendingRow({
      account: {
        phoneNumberId: account.phone_number_id,
        displayPhoneNumber: account.display_phone_number,
      },
      toNumber: followUp.contact_number,
      messageType: 'text',
      messageBody: followUp.prepared_body,
      templateMeta: {
        follow_up_ref: followUp.public_ref,
        ia360_handler_for: record.message_id,
        source: 'follow_up_delivery',
      },
      db: client,
      correlationId: followUp.final_correlation_id,
      surfaceAttestationRef: followUp.surface_attestation_ref,
      outboundPurpose: followUp.purpose,
      caseRef: followUp.case_ref,
    });
  }
  const { rows } = await client.query(
    `UPDATE coexistence.message_followups
        SET state='queued', lease_token=NULL, lease_expires_at=NULL, updated_at=NOW()
      WHERE id=$1 AND state='claimed'
      RETURNING *`,
    [followUp.id]
  );
  if (!rows.length) fail('FOLLOWUP_NOT_SENDABLE', 'El claim perdió su estado.', 409);
  await addEvent(client, followUp.id, 'delivery_queued', {
    correlationId: followUp.final_correlation_id,
    inboundMessageId: record.message_id,
  });
  return { followUp: rows[0], accountId: account.id };
}

async function claimFollowUpInbound({ db = pool, record }) {
  const action = classifyInbound(record);
  if (!action) return { consumed: false };
  const accountKey = await resolveContactAccountKey(db, record.contact_number);
  const client = await db.connect();
  let queued = null;
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(73612, hashtext($1))',
      [`${accountKey}:${record.phone_number_id}:${digits(record.contact_number)}`]
    );
    const { rows: candidates } = await client.query(
      `SELECT *
         FROM coexistence.message_followups
        WHERE account_key=$1 AND phone_number_id=$2 AND contact_number=$3
          AND state='active' AND expires_at > NOW()
        ORDER BY created_at
        FOR UPDATE`,
      [accountKey, record.phone_number_id, digits(record.contact_number)]
    );
    let matches = candidates;
    if (record.context_message_id) {
      matches = candidates.filter(item => item.trigger_message_id === record.context_message_id);
    }
    if (matches.length !== 1) {
      await client.query('ROLLBACK');
      return { consumed: false };
    }
    const followUp = matches[0];
    if (action === 'defer') {
      const { rows } = await client.query(
        `UPDATE coexistence.message_followups
            SET state='cancelled', last_error_code='contact_deferred', updated_at=NOW()
          WHERE id=$1 AND state='active'
          RETURNING *`,
        [followUp.id]
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return { consumed: false };
      }
      await addEvent(client, followUp.id, 'contact_deferred', {
        inboundMessageId: record.message_id,
        publicCode: 'contact_deferred',
      });
      await client.query('COMMIT');
      return { consumed: true, action: 'defer', followUp: publicFollowUp(rows[0]) };
    }

    const leaseToken = crypto.randomBytes(12).toString('hex');
    const claimed = await client.query(
      `UPDATE coexistence.message_followups
          SET state='claimed', lease_token=$2,
              lease_expires_at=NOW() + ($3::text || ' seconds')::interval,
              updated_at=NOW()
        WHERE id=$1 AND state='active'
        RETURNING *`,
      [followUp.id, leaseToken, String(LEASE_SECONDS)]
    );
    if (!claimed.rows.length) {
      await client.query('ROLLBACK');
      return { consumed: false };
    }
    await addEvent(client, followUp.id, 'claimed', { inboundMessageId: record.message_id });
    queued = await materializeDelivery(client, claimed.rows[0], record);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  try {
    await queueFollowUpJob({
      kind: 'text',
      accountId: queued.accountId,
      to: queued.followUp.contact_number,
      localMessageId: queued.followUp.final_correlation_id,
      requiresSurfaceContract: true,
      payload: {
        body: queued.followUp.prepared_body,
        previewUrl: /https?:\/\/\S+/i.test(queued.followUp.prepared_body),
      },
      originRef: { kind: 'follow_up_delivery', ref: queued.followUp.public_ref },
    });
  } catch {
    await addEvent(db, queued.followUp.id, 'queue_unavailable', {
      correlationId: queued.followUp.final_correlation_id,
      publicCode: 'FOLLOWUP_QUEUE_UNAVAILABLE',
    }).catch(() => {});
  }
  return { consumed: true, action: 'deliver', followUp: publicFollowUp(queued.followUp) };
}

async function claimFollowUpOutbound({ db = pool, originRef }) {
  if (!originRef?.ref || !['follow_up_opener', 'follow_up_delivery'].includes(originRef.kind)) return null;
  const expected = originRef.kind === 'follow_up_opener' ? 'prepared' : 'queued';
  const next = originRef.kind === 'follow_up_opener' ? 'opener_sending' : 'sending';
  const { rows } = await db.query(
    `UPDATE coexistence.message_followups
        SET state=$3, lease_token=$4,
            lease_expires_at=NOW() + ($5::text || ' seconds')::interval,
            updated_at=NOW()
      WHERE public_ref=$1 AND state=$2
      RETURNING *`,
    [originRef.ref, expected, next, crypto.randomBytes(12).toString('hex'), String(LEASE_SECONDS)]
  );
  if (!rows.length) fail('FOLLOWUP_NOT_SENDABLE', 'El seguimiento no está listo para egreso.', 409);
  await addEvent(db, rows[0].id, next, {
    correlationId: originRef.kind === 'follow_up_opener'
      ? rows[0].opener_correlation_id
      : rows[0].final_correlation_id,
  });
  return rows[0];
}

async function transitionOutbound(db, { ref, kind, state, wamid = null, publicCode = null }) {
  const expected = kind === 'follow_up_opener' ? 'opener_sending' : 'sending';
  const activatingOpener = kind === 'follow_up_opener' && state === 'active';
  const result = activatingOpener
    ? await db.query(
      `UPDATE coexistence.message_followups
          SET state=$3, lease_token=NULL, lease_expires_at=NULL,
              trigger_message_id=$4, last_error_code=$5, updated_at=NOW()
        WHERE public_ref=$1 AND state=$2
        RETURNING *`,
      [ref, expected, state, wamid, publicCode]
    )
    : await db.query(
      `UPDATE coexistence.message_followups
          SET state=$3, lease_token=NULL, lease_expires_at=NULL,
              last_error_code=$4, updated_at=NOW()
        WHERE public_ref=$1 AND state=$2
        RETURNING *`,
      [ref, expected, state, publicCode]
    );
  const { rows } = result;
  if (rows.length) {
    await addEvent(db, rows[0].id, state, {
      correlationId: kind === 'follow_up_opener'
        ? rows[0].opener_correlation_id
        : rows[0].final_correlation_id,
      publicCode,
    });
  }
  return rows[0] || null;
}

async function onFollowUpOutboundAccepted({ db = pool, originRef, wamid }) {
  if (!originRef?.ref) return null;
  const opener = originRef.kind === 'follow_up_opener';
  return transitionOutbound(db, {
    ref: originRef.ref,
    kind: originRef.kind,
    state: opener ? 'active' : 'sent',
    wamid: opener ? wamid : null,
  });
}

async function onFollowUpOutboundFailed({ db = pool, originRef, publicCode = 'FOLLOWUP_SEND_FAILED' }) {
  if (!originRef?.ref) return null;
  return transitionOutbound(db, {
    ref: originRef.ref,
    kind: originRef.kind,
    state: 'failed',
    publicCode,
  });
}

async function onFollowUpOutboundUnknown({ db = pool, originRef, publicCode = 'FOLLOWUP_SEND_UNKNOWN' }) {
  if (!originRef?.ref) return null;
  return transitionOutbound(db, {
    ref: originRef.ref,
    kind: originRef.kind,
    state: 'no_verificable',
    publicCode,
  });
}

async function onFollowUpReceipt({ db = pool, messageId, status, publicCode = null }) {
  if (!['sent', 'delivered', 'read', 'failed', 'error'].includes(status)) return null;
  const { rows } = await db.query(
    `SELECT f.*,
            (SELECT current.status FROM coexistence.chat_history current
              WHERE current.message_id=$1 LIMIT 1) AS receipt_status
       FROM coexistence.message_followups f
       LEFT JOIN coexistence.chat_history h
         ON h.send_correlation_id=f.final_correlation_id
      WHERE h.message_id=$1 OR f.trigger_message_id=$1
      LIMIT 1`,
    [messageId]
  );
  if (!rows.length) return null;
  const followUp = rows[0];
  const effectiveStatus = String(followUp.receipt_status || status);
  const effectiveCode = ['failed', 'error'].includes(effectiveStatus) ? publicCode : null;
  if (messageId === followUp.trigger_message_id) {
    if (['failed', 'error'].includes(effectiveStatus) && followUp.state === 'active') {
      const updated = await db.query(
        `UPDATE coexistence.message_followups
            SET state=$2, last_error_code=$3, updated_at=NOW()
          WHERE id=$1 AND state='active'
          RETURNING *`,
        [followUp.id, effectiveStatus, effectiveCode]
      );
      return updated.rows[0] || null;
    }
    return followUp;
  }
  const rank = { sending: 0, sent: 1, delivered: 2, read: 3, failed: 4, error: 4 };
  if (effectiveStatus === followUp.state) return followUp;
  if (!(effectiveStatus in rank) || !(followUp.state in rank)
      || rank[effectiveStatus] < rank[followUp.state]) return followUp;
  const updated = await db.query(
    `UPDATE coexistence.message_followups
        SET state=$2, last_error_code=$3, updated_at=NOW()
      WHERE id=$1 AND state = ANY($4::text[])
      RETURNING *`,
    [followUp.id, effectiveStatus, effectiveCode, ['sending', 'sent', 'delivered', 'read']]
  );
  if (updated.rows.length) {
    await addEvent(db, followUp.id, `receipt_${effectiveStatus}`, { publicCode: effectiveCode });
  }
  return updated.rows[0] || followUp;
}

async function requeueFollowUp(row, db = pool) {
  const opener = row.state === 'prepared';
  let components = [];
  if (opener) {
    const contact = await db.query(
      `SELECT COALESCE(name, profile_name) AS name
         FROM coexistence.contacts
        WHERE regexp_replace(wa_number, '[^0-9]', '', 'g')=$1
          AND regexp_replace(contact_number, '[^0-9]', '', 'g')=$2
        LIMIT 1`,
      [row.from_number, row.contact_number]
    );
    components = openerComponents(contact.rows[0]?.name, row.deliverable);
  }
  return queueFollowUpJob({
    kind: opener ? 'template' : 'text',
    accountId: row.account_id,
    to: row.contact_number,
    localMessageId: opener ? row.opener_correlation_id : row.final_correlation_id,
    requiresSurfaceContract: !opener,
    payload: opener
      ? { name: TEMPLATE_NAME, languageCode: TEMPLATE_LANGUAGE, components }
      : { body: row.prepared_body, previewUrl: /https?:\/\/\S+/i.test(row.prepared_body) },
    originRef: { kind: opener ? 'follow_up_opener' : 'follow_up_delivery', ref: row.public_ref },
  });
}

async function reconcileFollowUps({ db = pool, limit = 100 }) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const client = await db.connect();
  let locked = false;
  const requeue = [];
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(73613, 1) AS locked');
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { locked: false, scanned: 0, requeued: 0 };
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT f.*, a.id AS account_id,
              (SELECT h.status FROM coexistence.chat_history h
                WHERE h.send_correlation_id=f.opener_correlation_id LIMIT 1) AS opener_chat_status,
              (SELECT h.message_id FROM coexistence.chat_history h
                WHERE h.send_correlation_id=f.opener_correlation_id LIMIT 1) AS opener_message_id,
              (SELECT h.status FROM coexistence.chat_history h
                WHERE h.send_correlation_id=f.final_correlation_id LIMIT 1) AS final_chat_status
         FROM coexistence.message_followups f
         JOIN coexistence.whatsapp_accounts a ON a.phone_number_id=f.phone_number_id
        WHERE f.state = ANY($1::text[])
        ORDER BY f.updated_at
        LIMIT $2
        FOR UPDATE OF f SKIP LOCKED`,
      [ACTIVE_STATES, boundedLimit]
    );
    for (let row of rows) {
      if (['prepared', 'active', 'claimed', 'queued'].includes(row.state)
          && new Date(row.expires_at).getTime() <= Date.now()) {
        await client.query(
          `UPDATE coexistence.message_followups
              SET state='expired', lease_token=NULL, lease_expires_at=NULL,
                  last_error_code='expired', updated_at=NOW()
            WHERE id=$1`,
          [row.id]
        );
        await addEvent(client, row.id, 'expired', { publicCode: 'expired' });
        continue;
      }
      if (row.state === 'opener_sending' && ['sent', 'delivered', 'read'].includes(row.opener_chat_status)) {
        await client.query(
          `UPDATE coexistence.message_followups
              SET state='active', trigger_message_id=$2,
                  lease_token=NULL, lease_expires_at=NULL, updated_at=NOW()
            WHERE id=$1 AND state='opener_sending'`,
          [row.id, row.opener_message_id]
        );
        await addEvent(client, row.id, 'active_reconciled', {
          correlationId: row.opener_correlation_id,
        });
        continue;
      }
      if (row.state === 'opener_sending' && ['failed', 'error', 'no_verificable'].includes(row.opener_chat_status)) {
        await client.query(
          `UPDATE coexistence.message_followups
              SET state=$2, lease_token=NULL, lease_expires_at=NULL,
                  last_error_code='outbox_reconciled', updated_at=NOW()
            WHERE id=$1 AND state='opener_sending'`,
          [row.id, row.opener_chat_status]
        );
        await addEvent(client, row.id, `${row.opener_chat_status}_reconciled`, {
          correlationId: row.opener_correlation_id,
          publicCode: 'outbox_reconciled',
        });
        continue;
      }
      if (row.state === 'sending' && ['sent', 'delivered', 'read', 'failed', 'error', 'no_verificable'].includes(row.final_chat_status)) {
        await client.query(
          `UPDATE coexistence.message_followups
              SET state=$2, lease_token=NULL, lease_expires_at=NULL,
                  last_error_code=CASE WHEN $2 IN ('failed','error','no_verificable')
                                       THEN 'outbox_reconciled' ELSE NULL END,
                  updated_at=NOW()
            WHERE id=$1 AND state='sending'`,
          [row.id, row.final_chat_status]
        );
        await addEvent(client, row.id, `${row.final_chat_status}_reconciled`, {
          correlationId: row.final_correlation_id,
          publicCode: ['failed', 'error', 'no_verificable'].includes(row.final_chat_status)
            ? 'outbox_reconciled'
            : null,
        });
        continue;
      }
      if (['opener_sending', 'sending'].includes(row.state)
          && row.lease_expires_at && new Date(row.lease_expires_at).getTime() <= Date.now()) {
        const correlation = row.state === 'opener_sending' ? row.opener_correlation_id : row.final_correlation_id;
        const chat = await client.query(
          `SELECT status FROM coexistence.chat_history WHERE send_correlation_id=$1`,
          [correlation]
        );
        if (chat.rows[0]?.status === 'sending') {
          await client.query(
            `UPDATE coexistence.message_followups
                SET state='no_verificable', lease_token=NULL, lease_expires_at=NULL,
                    last_error_code='lease_expired_after_possible_send', updated_at=NOW()
              WHERE id=$1`,
            [row.id]
          );
          await addEvent(client, row.id, 'no_verificable', {
            correlationId: correlation,
            publicCode: 'lease_expired_after_possible_send',
          });
        }
        continue;
      }
      if (row.state === 'claimed' && row.lease_expires_at
          && new Date(row.lease_expires_at).getTime() <= Date.now()) {
        const materialized = await materializeDelivery(client, row, { message_id: `reconcile:${row.public_ref}` });
        row = { ...materialized.followUp, account_id: materialized.accountId };
      }
      if (row.state === 'prepared' || row.state === 'queued') requeue.push(row);
    }
    await client.query('COMMIT');
    for (const row of requeue) {
      await requeueFollowUp(row, db).catch(() => {});
    }
    return { locked: true, scanned: rows.length, requeued: requeue.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(73613, 1)').catch(() => {});
    client.release();
  }
}

module.exports = {
  TEMPLATE_NAME,
  TEMPLATE_LANGUAGE,
  POSITIVE_BUTTON,
  DEFER_BUTTON,
  ACTIVE_STATES,
  TERMINAL_STATES,
  FollowUpError,
  prepareFollowUp,
  getFollowUpStatus,
  cancelFollowUp,
  claimFollowUpInbound,
  reconcileFollowUps,
  claimFollowUpOutbound,
  onFollowUpOutboundAccepted,
  onFollowUpOutboundFailed,
  onFollowUpOutboundUnknown,
  onFollowUpReceipt,
  classifyInbound,
  publicFollowUp,
};
