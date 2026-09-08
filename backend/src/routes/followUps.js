'use strict';

const { Router } = require('express');
const { createHash } = require('crypto');
const pool = require('../db');
const { isAdmin } = require('../permissions');
const { requirePermission, assertContactAccess } = require('../middleware/access');
const {
  FollowUpError,
  prepareFollowUp,
  getFollowUpStatus,
  cancelFollowUp,
} = require('../services/followUpService');
const {
  SurfaceContractError,
  resolveContactAccountKey,
  listAuthorizedSurfaces,
} = require('../services/outboundSurfaceContract');

const router = Router();
router.use(requirePermission('chats'));

function hashRef(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function normalizeScopeLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('es-MX');
}

function opaqueFollowUpScope(scope) {
  return {
    contactoRef: `c_${hashRef(`${scope.from_number}\0${scope.contact_number}`)}`,
    scopeBindingRef: hashRef(
      `${normalizeScopeLabel(scope.contact_name)}\0${normalizeScopeLabel(scope.account_name)}`
    ),
  };
}

function publicError(res, error) {
  if (error instanceof FollowUpError || error instanceof SurfaceContractError) {
    return res.status(error.status || 400).json({ ok: false, code: error.code, error: error.message });
  }
  console.error('[follow-ups] internal error:', error.message);
  return res.status(500).json({ ok: false, code: 'FOLLOWUP_INTERNAL_ERROR', error: 'No se pudo completar la operación.' });
}

async function scopedFollowUp(req, followUpRef) {
  if (!/^q_[0-9a-f]{12}$/.test(String(followUpRef || ''))) return null;
  const params = [followUpRef];
  let access = '';
  if (!isAdmin(req.user)) {
    params.push(req.user.id);
    access = `AND EXISTS (
      SELECT 1 FROM coexistence.contacts c
       WHERE regexp_replace(c.wa_number, '[^0-9]', '', 'g')=f.from_number
         AND regexp_replace(c.contact_number, '[^0-9]', '', 'g')=f.contact_number
         AND c.assigned_user_id=$2
    )`;
  }
  const { rows } = await pool.query(
    `SELECT f.from_number, f.contact_number,
            COALESCE(c.name, c.profile_name) AS contact_name,
            a.display_name AS account_name
       FROM coexistence.message_followups f
       LEFT JOIN coexistence.contacts c
         ON regexp_replace(c.wa_number, '[^0-9]', '', 'g')=f.from_number
        AND regexp_replace(c.contact_number, '[^0-9]', '', 'g')=f.contact_number
       LEFT JOIN coexistence.whatsapp_accounts a
         ON a.phone_number_id=f.phone_number_id
      WHERE f.public_ref=$1 ${access}`,
    params
  );
  return rows.length === 1 ? rows[0] : null;
}

router.get('/messages/surfaces', async (req, res) => {
  try {
    const { fromNumber, toNumber } = req.query;
    if (!fromNumber || !toNumber) {
      return res.status(400).json({ ok: false, code: 'FOLLOWUP_INVALID_INPUT', error: 'fromNumber y toNumber son obligatorios.' });
    }
    if (!(await assertContactAccess(req, res, fromNumber, toNumber))) return;
    const accountKey = await resolveContactAccountKey(pool, toNumber);
    const surfaces = await listAuthorizedSurfaces(pool, { accountKey });
    return res.json({
      ok: true,
      surfaces: surfaces.map(surface => ({
        surfaceKey: surface.surface_key,
        projectKey: surface.project_key,
        environment: surface.environment,
        canonicalOrigin: surface.canonical_origin,
        pathPrefix: surface.path_prefix,
        authMode: surface.auth_mode,
      })),
    });
  } catch (error) {
    return publicError(res, error);
  }
});

router.post('/messages/follow-ups/prepare', async (req, res) => {
  try {
    const {
      fromNumber,
      toNumber,
      caseRef,
      deliverable,
      purpose,
      surfaceKey,
      text,
      ttlHours,
      dryRun = false,
      confirm = false,
    } = req.body || {};
    if (!fromNumber || !toNumber) {
      return res.status(400).json({ ok: false, code: 'FOLLOWUP_INVALID_INPUT', error: 'fromNumber y toNumber son obligatorios.' });
    }
    if (!dryRun && confirm !== true) {
      return res.status(400).json({ ok: false, code: 'CONFIRMATION_REQUIRED', error: 'confirm:true es obligatorio.' });
    }
    if (!(await assertContactAccess(req, res, fromNumber, toNumber))) return;
    const result = await prepareFollowUp({
      db: pool,
      actor: { ...req.user, dryRun: dryRun === true },
      fromNumber,
      toNumber,
      caseRef,
      deliverable,
      purpose,
      surfaceKey: surfaceKey || null,
      body: text,
      ttlHours: ttlHours ?? 72,
    });
    return res.status(dryRun ? 200 : 202).json(result);
  } catch (error) {
    return publicError(res, error);
  }
});

router.post('/messages/follow-ups/status', async (req, res) => {
  try {
    const { followUpRef } = req.body || {};
    const scope = await scopedFollowUp(req, followUpRef);
    if (!scope) throw new FollowUpError('FOLLOWUP_NOT_FOUND', 'Seguimiento no encontrado.', 404);
    const result = await getFollowUpStatus({
      db: pool,
      actor: req.user,
      fromNumber: scope.from_number,
      toNumber: scope.contact_number,
      followUpRef,
    });
    return res.json({ ...result, ...opaqueFollowUpScope(scope) });
  } catch (error) {
    return publicError(res, error);
  }
});

router.post('/messages/follow-ups/cancel', async (req, res) => {
  try {
    const { followUpRef, dryRun = false, confirm = false } = req.body || {};
    if (!dryRun && confirm !== true) {
      return res.status(400).json({ ok: false, code: 'CONFIRMATION_REQUIRED', error: 'confirm:true es obligatorio.' });
    }
    const scope = await scopedFollowUp(req, followUpRef);
    if (!scope) throw new FollowUpError('FOLLOWUP_NOT_FOUND', 'Seguimiento no encontrado.', 404);
    return res.json(await cancelFollowUp({
      db: pool,
      actor: { ...req.user, dryRun: dryRun === true },
      fromNumber: scope.from_number,
      toNumber: scope.contact_number,
      followUpRef,
    }));
  } catch (error) {
    return publicError(res, error);
  }
});

module.exports = { router, scopedFollowUp };
