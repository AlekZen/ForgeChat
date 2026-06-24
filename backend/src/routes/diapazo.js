'use strict';

// ============================================================================
// G6 — Notificacion WhatsApp del flujo DIAPAZO (owner card + egress al contacto)
// ----------------------------------------------------------------------------
// OPCION B (aislado): TODO lo DIAPAZO vive en este archivo + una tabla propia.
// NUNCA edita webhook.js ni metaSend.js: solo IMPORTA metaSend (sendInteractive/
// sendText) y el resolver de cuenta. El flujo n8n (FyA7L8L5Bpzr2ZKq), tras el CRM
// write staged, hace POST a /api/diapazo/notify por el host interno docker.
//
// Egress al contacto = SOLO tras tap "Aprobar" del owner (human-gated). Los taps
// del owner llegan al webhook de Meta (webhook.js, que NO se toca); webhook.js los
// persiste en coexistence.chat_history. Este modulo POLLEA esa tabla (solo lectura)
// buscando taps con prefijo diapazo_ y procesa aprobar/corregir/no-contactar.
// Idempotente por request_id (egress_sent + transaccion FOR UPDATE).
// ============================================================================

const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { sendInteractive, sendText } = require('../integrations/metaSend');
const { getSingleAccount } = require('./whatsappAccounts');

const router = Router();

const NOTIFY_SECRET = process.env.DIAPAZO_NOTIFY_SECRET || '3fa80708374778ddadb5cc014b61ae4da781f4a38546f09d';
// Owner que revisa/aprueba (WhatsApp personal de Alek). Recibe la tarjeta.
const OWNER_WA = process.env.DIAPAZO_OWNER_WA || '5213322638033';
const POLL_MS = parseInt(process.env.DIAPAZO_POLL_MS || '5000', 10);

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function onlyDigits(s) { return String(s == null ? '' : s).replace(/[^0-9]/g, ''); }
function normalizeMx(raw) {
  let d = onlyDigits(raw);
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10) return '521' + d;
  if (d.length === 12 && d.startsWith('52')) return '521' + d.slice(2);
  if (d.length === 13 && d.startsWith('521')) return d;
  if (d.length === 11 && d.startsWith('1')) return d;
  return d;
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.diapazo_notifications (
      request_id    text PRIMARY KEY,
      contact_name  text,
      contact_phone text,
      contact_email text,
      channel       text,
      persona       text,
      etapa         text,
      next_offer    text,
      afinacion     text,
      status        text NOT NULL DEFAULT 'pending_owner_review',
      owner_msg_id  text,
      egress_sent   boolean NOT NULL DEFAULT false,
      egress_msg_id text,
      egress_channel text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      decided_at    timestamptz,
      egress_at     timestamptz
    )`);
}

const PERSONA_LABEL = {
  directivo_recursos: 'Directivo con recursos',
  dueno_cuello_botella: 'Dueno cuello de botella',
  evangelista: 'Campeon interno',
  aliado: 'Aliado / partner',
};
const ETAPA_LABEL = {
  afinacion_alta: 'Afinacion alta',
  seguimiento: 'Seguimiento',
  nuevo: 'Nuevo',
};

function ownerCard(n) {
  const persona = PERSONA_LABEL[n.persona] || n.persona || 'sin clasificar';
  const etapa = ETAPA_LABEL[n.etapa] || n.etapa || '';
  const contactLine = n.channel === 'email' ? (n.contact_email || 'sin email') : ('+' + (n.contact_phone || 'sin telefono'));
  const lines = [
    'DIAPAZO - nuevo lead para afinar',
    '',
    'Nombre: ' + (n.contact_name || 'sin nombre'),
    'Contacto: ' + contactLine + ' (' + (n.channel || 'whatsapp') + ')',
    'Persona: ' + persona,
    etapa ? ('Etapa: ' + etapa) : '',
    n.afinacion ? ('Afinacion: ' + n.afinacion) : '',
    n.next_offer ? ('Siguiente: ' + n.next_offer) : '',
    '',
    'El contacto NO recibe nada hasta que apruebes.',
  ].filter(Boolean);
  return {
    type: 'button',
    header: { type: 'text', text: 'DIAPAZO - Revision de lead' },
    body: { text: lines.join('\n').slice(0, 1024) },
    footer: { text: 'DIAPAZO - aprobacion humana' },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'diapazo_approve:' + n.request_id, title: 'Aprobar' } },
        { type: 'reply', reply: { id: 'diapazo_fix:' + n.request_id, title: 'Corregir' } },
        { type: 'reply', reply: { id: 'diapazo_skip:' + n.request_id, title: 'No contactar' } },
      ],
    },
  };
}

function contactMessage(n) {
  const first = String(n.contact_name || '').trim().split(/\s+/)[0] || '';
  const hola = first ? ('Hola ' + first + ', ') : 'Hola, ';
  return (
    hola + 'soy del equipo DIAPAZO. Gracias por tu interes en afinar tu empresa. ' +
    'Vi tu solicitud' + (n.afinacion ? (' sobre ' + n.afinacion) : '') + ' y me encantaria mostrarte el ' +
    'siguiente paso para que tu operacion suene afinada. Cuentame, que es lo que mas te esta desafinando hoy?'
  );
}

async function resolveCreds() {
  const acct = await getSingleAccount();
  if (!acct || !acct.accessToken) throw new Error('no_whatsapp_account');
  if (!acct.isActive) throw new Error('whatsapp_account_inactive');
  return acct;
}

// --- POST /api/diapazo/notify : n8n -> backend (secret-gated). Envia la tarjeta al owner. ---
router.post('/diapazo/notify', async (req, res) => {
  const provided = req.get('X-Diapazo-Notify-Secret') || '';
  if (!NOTIFY_SECRET || !timingSafeEqualStr(provided, NOTIFY_SECRET)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    await ensureTable();
    const b = req.body || {};
    const requestId = String(b.request_id || '').trim();
    if (!requestId) return res.status(422).json({ ok: false, error: 'request_id_required' });

    const contact = b.contact || {};
    const channel = contact.channel || contact.preferred_channel || (contact.email ? 'email' : 'whatsapp');
    const phone = normalizeMx(contact.phone);
    const email = contact.email || '';
    const afinacion = (b.signal && (b.signal.afinacion_hint || b.signal.pain)) || b.afinacion || '';

    // Idempotencia: si ya existe la notificacion, no re-enviar la tarjeta.
    const existing = await pool.query(
      'SELECT request_id, owner_msg_id, status FROM coexistence.diapazo_notifications WHERE request_id=$1',
      [requestId]
    );
    if (existing.rows[0]) {
      return res.status(200).json({
        ok: true, deduped: true, request_id: requestId,
        owner_msg_id: existing.rows[0].owner_msg_id, status: existing.rows[0].status,
      });
    }

    await pool.query(
      `INSERT INTO coexistence.diapazo_notifications
         (request_id, contact_name, contact_phone, contact_email, channel, persona, etapa, next_offer, afinacion, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_owner_review')
       ON CONFLICT (request_id) DO NOTHING`,
      [requestId, contact.name || '', phone || '', email, channel, b.persona || '', b.etapa || '', b.next_offer || '', afinacion]
    );

    const n = {
      request_id: requestId, contact_name: contact.name || '', contact_phone: phone || '',
      contact_email: email, channel, persona: b.persona || '', etapa: b.etapa || '',
      next_offer: b.next_offer || '', afinacion,
    };
    const acct = await resolveCreds();
    let ownerMsgId = null;
    try {
      const r = await sendInteractive({ accessToken: acct.accessToken, phoneNumberId: acct.phoneNumberId, to: OWNER_WA, interactive: ownerCard(n) });
      ownerMsgId = r && r.messages && r.messages[0] && r.messages[0].id || null;
      await pool.query('UPDATE coexistence.diapazo_notifications SET owner_msg_id=$2 WHERE request_id=$1', [requestId, ownerMsgId]);
    } catch (err) {
      console.error('[diapazo] owner card send FAILED req=%s: %s', requestId, err && err.message);
      return res.status(502).json({ ok: false, error: 'owner_card_failed', detail: err && err.message, request_id: requestId });
    }
    console.log('[diapazo] owner card enviada req=%s owner_msg_id=%s to=%s', requestId, ownerMsgId, OWNER_WA);
    return res.status(200).json({ ok: true, request_id: requestId, owner_msg_id: ownerMsgId, status: 'pending_owner_review' });
  } catch (err) {
    console.error('[diapazo] notify error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'notify_failed', detail: err && err.message });
  }
});

// --- Poller: taps diapazo_* del owner desde chat_history (escrita por webhook.js, SOLO LECTURA) ---
const BTN_PATH = "raw_payload->'entry'->0->'changes'->0->'value'->'messages'->0->'interactive'->'button_reply'->>'id'";

// Egress al contacto: SOLO aqui (tras approve). Idempotente por transaccion FOR UPDATE + egress_sent.
async function processApproval(requestId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT request_id, contact_name, contact_phone, contact_email, channel, afinacion
         FROM coexistence.diapazo_notifications
        WHERE request_id=$1 AND egress_sent=false
        FOR UPDATE`,
      [requestId]
    );
    if (!sel.rows[0]) { await client.query('ROLLBACK'); return; }
    const row = sel.rows[0];

    if (row.channel === 'email') {
      // El backend ForgeChat no tiene sender de email; se registra para seguimiento (CRM tiene el lead).
      await client.query(
        `UPDATE coexistence.diapazo_notifications
            SET status='approved', egress_sent=true, egress_channel='email', decided_at=NOW(), egress_at=NOW()
          WHERE request_id=$1`, [requestId]);
      await client.query('COMMIT');
      console.log('[diapazo] APPROVED canal=email req=%s (egress por email pendiente de canal; lead en CRM)', requestId);
      return;
    }
    if (!row.contact_phone) { await client.query('ROLLBACK'); console.warn('[diapazo] approve sin telefono req=%s', requestId); return; }

    const acct = await resolveCreds();
    const r = await sendText({ accessToken: acct.accessToken, phoneNumberId: acct.phoneNumberId, to: row.contact_phone, body: contactMessage(row) });
    const wamid = r && r.messages && r.messages[0] && r.messages[0].id || null;
    await client.query(
      `UPDATE coexistence.diapazo_notifications
          SET status='approved', egress_sent=true, egress_msg_id=$2, egress_channel='whatsapp', decided_at=NOW(), egress_at=NOW()
        WHERE request_id=$1`, [requestId, wamid]);
    await client.query('COMMIT');
    console.log('[diapazo] APPROVED -> egress al contacto req=%s to=%s wamid=%s', requestId, row.contact_phone, wamid);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('[diapazo] egress al contacto FALLO req=%s: %s', requestId, err && err.message);
  } finally {
    client.release();
  }
}

let lastPollAt = null;
async function pollOnce() {
  const pollStart = new Date();
  const params = lastPollAt ? [OWNER_WA, lastPollAt] : [OWNER_WA];
  const sinceClause = lastPollAt ? 'AND created_at > $2' : "AND created_at > NOW() - INTERVAL '2 hours'";
  const { rows } = await pool.query(
    `SELECT message_id, created_at, ${BTN_PATH} AS btn_id
       FROM coexistence.chat_history
      WHERE direction='incoming' AND contact_number=$1
        AND ${BTN_PATH} LIKE 'diapazo_%'
        ${sinceClause}
      ORDER BY created_at ASC`,
    params
  );
  lastPollAt = pollStart;
  for (const r of rows) {
    const m = /^diapazo_(approve|fix|skip):(.+)$/.exec(r.btn_id || '');
    if (!m) continue;
    const action = m[1];
    const requestId = m[2];
    if (action === 'approve') {
      await processApproval(requestId);
    } else if (action === 'fix') {
      await pool.query(
        `UPDATE coexistence.diapazo_notifications SET status='fix_requested', decided_at=COALESCE(decided_at, NOW())
          WHERE request_id=$1 AND status='pending_owner_review'`, [requestId]);
      console.log('[diapazo] FIX req=%s (sin egress)', requestId);
    } else if (action === 'skip') {
      await pool.query(
        `UPDATE coexistence.diapazo_notifications SET status='skipped', decided_at=COALESCE(decided_at, NOW())
          WHERE request_id=$1 AND status='pending_owner_review'`, [requestId]);
      console.log('[diapazo] SKIP req=%s (sin egress)', requestId);
    }
  }
}

let pollTimer = null;
function startDiapazoPoller() {
  if (pollTimer) return;
  ensureTable().catch((e) => console.error('[diapazo] ensureTable:', e && e.message));
  pollTimer = setInterval(() => { pollOnce().catch((e) => console.error('[diapazo] poll error:', e && e.message)); }, POLL_MS);
  if (pollTimer.unref) pollTimer.unref();
  console.log('[diapazo] poller iniciado cada %dms, owner=%s', POLL_MS, OWNER_WA);
}

module.exports = { router, startDiapazoPoller };
