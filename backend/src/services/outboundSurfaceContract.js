'use strict';

const crypto = require('crypto');

const PURPOSES = new Set(['production_review', 'production_test', 'case_delivery']);
const URL_REQUIRED_PURPOSES = new Set(['production_review', 'production_test']);
const SENSITIVE_QUERY_KEY = /(token|secret|password|key|signature|code|session|auth)/i;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const ATTESTATION_TTL_HOURS = 168;
const IA360_LINK_ESCALATION = 'No tengo un enlace verificado para mandarte ahorita. Se lo paso a Alek para confirmar cuál corresponde.';

class SurfaceContractError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'SurfaceContractError';
    this.code = code;
    this.status = 400;
    this.public = true;
  }
}

function fail(code, message) {
  throw new SurfaceContractError(code, message);
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function payloadSha256(body) {
  return crypto.createHash('sha256').update(String(body), 'utf8').digest('hex');
}

function extractUrls(body) {
  const matches = String(body || '').match(URL_PATTERN) || [];
  return matches.map(value => value.replace(/[.,;:!?\])}]+$/g, ''));
}

function canonicalizeAuthorizedUrl(rawUrl, surface) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail('SURFACE_URL_MISMATCH', 'La URL no es absoluta.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    fail('SURFACE_URL_MISMATCH', 'La URL no cumple el origen HTTPS autorizado.');
  }
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      fail('SURFACE_SENSITIVE_URL', 'La URL contiene un parámetro sensible.');
    }
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    fail('SURFACE_URL_MISMATCH', 'La ruta de la URL no es válida.');
  }
  const normalizedPath = new URL(decodedPath, parsed.origin).pathname;
  if (
    normalizedPath !== decodedPath
    || parsed.origin !== surface.canonical_origin
    || !decodedPath.startsWith(surface.path_prefix)
  ) {
    fail('SURFACE_URL_MISMATCH', 'La URL no pertenece a la superficie autorizada.');
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.toString();
}

function validatePurposeAndUrls({ purpose, surface, body }) {
  if (!PURPOSES.has(purpose)) fail('INVALID_PURPOSE', 'Propósito de egreso no permitido.');
  const urls = extractUrls(body);
  if (!surface) {
    if (URL_REQUIRED_PURPOSES.has(purpose)) {
      fail('SURFACE_URL_REQUIRED', 'La revisión o prueba requiere una superficie autorizada.');
    }
    if (urls.length) fail('SURFACE_NOT_AUTHORIZED', 'El mensaje no tiene una superficie autorizada.');
    return [];
  }
  if (urls.length === 0) fail('SURFACE_URL_REQUIRED', 'Falta la URL autorizada en el payload final.');
  if (urls.length > 1) fail('SURFACE_URL_ADDITIONAL', 'El payload final contiene URLs adicionales.');
  return [canonicalizeAuthorizedUrl(urls[0], surface)];
}

async function resolveContactAccountKey(db, contactNumber) {
  const normalized = digits(contactNumber);
  if (!normalized) fail('SURFACE_NOT_AUTHORIZED', 'No se pudo resolver la cuenta del contacto.');
  const { rows } = await db.query(
    `SELECT DISTINCT account_key
       FROM coexistence.ia360_contact_scope
      WHERE contact_number = $1
        AND activo = TRUE
      ORDER BY account_key`,
    [normalized]
  );
  if (rows.length !== 1 || !rows[0].account_key) {
    fail('SURFACE_NOT_AUTHORIZED', 'El contacto no tiene una sola cuenta activa.');
  }
  return rows[0].account_key;
}

async function listAuthorizedSurfaces(db, { accountKey }) {
  if (!accountKey) fail('SURFACE_NOT_AUTHORIZED', 'La cuenta no está resuelta.');
  const { rows } = await db.query(
    `SELECT surface_key, project_key, environment, canonical_origin, path_prefix, auth_mode
       FROM coexistence.ia360_product_surfaces
      WHERE account_key = $1
        AND environment = 'production'
        AND active = TRUE
      ORDER BY surface_key`,
    [accountKey]
  );
  return rows;
}

async function loadSurface(db, { accountKey, surfaceKey }) {
  if (!surfaceKey) return null;
  const { rows } = await db.query(
    `SELECT id, surface_key, account_key, project_key, environment,
            canonical_origin, path_prefix, auth_mode
       FROM coexistence.ia360_product_surfaces
      WHERE account_key = $1
        AND surface_key = $2
        AND environment = 'production'
        AND active = TRUE`,
    [accountKey, surfaceKey]
  );
  if (rows.length !== 1) fail('SURFACE_NOT_AUTHORIZED', 'La superficie no pertenece a la cuenta.');
  return rows[0];
}

async function attestOutboundPayload(db, {
  accountKey,
  caseRef,
  purpose,
  surfaceKey,
  body,
  correlationId,
  actorId,
}) {
  if (!PURPOSES.has(purpose)) fail('INVALID_PURPOSE', 'Propósito de egreso no permitido.');
  if (!accountKey || !caseRef || !correlationId || !actorId || typeof body !== 'string') {
    fail('SURFACE_NOT_AUTHORIZED', 'Faltan datos derivados para atestar el payload.');
  }
  const surface = await loadSurface(db, { accountKey, surfaceKey });
  const urls = validatePurposeAndUrls({ purpose, surface, body });
  if (!surface) return null;

  const publicRef = `a_${crypto.randomBytes(12).toString('hex')}`;
  const sha = payloadSha256(body);
  const { rows } = await db.query(
    `INSERT INTO coexistence.ia360_surface_attestations
       (public_ref, surface_id, account_key, case_ref, purpose, canonical_url,
        payload_sha256, send_correlation_id, actor_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW() + ($10::text || ' hours')::interval)
     RETURNING public_ref, expires_at`,
    [
      publicRef,
      surface.id,
      accountKey,
      String(caseRef),
      purpose,
      urls[0],
      sha,
      String(correlationId),
      String(actorId),
      String(ATTESTATION_TTL_HOURS),
    ]
  );
  return { attestationRef: rows[0].public_ref, expiresAt: rows[0].expires_at };
}

async function validateOutboundAttestation(db, {
  attestationRef,
  accountKey,
  contactNumber,
  body,
  correlationId,
}) {
  if (!attestationRef || !accountKey || !correlationId || typeof body !== 'string') {
    fail('SURFACE_NOT_AUTHORIZED', 'Falta la atestación server-side.');
  }
  const resolvedAccountKey = await resolveContactAccountKey(db, contactNumber);
  if (resolvedAccountKey !== accountKey) {
    fail('SURFACE_NOT_AUTHORIZED', 'La atestación no pertenece al contacto.');
  }
  const { rows } = await db.query(
    `SELECT a.public_ref, a.account_key, a.case_ref, a.purpose, a.canonical_url,
            a.payload_sha256, a.send_correlation_id, a.expires_at,
            s.canonical_origin, s.path_prefix, s.active
       FROM coexistence.ia360_surface_attestations a
       JOIN coexistence.ia360_product_surfaces s ON s.id = a.surface_id
      WHERE a.public_ref = $1
        AND a.account_key = $2
        AND a.send_correlation_id = $3
        AND s.environment = 'production'`,
    [attestationRef, accountKey, correlationId]
  );
  if (rows.length !== 1 || !rows[0].active) {
    fail('SURFACE_NOT_AUTHORIZED', 'La atestación no está autorizada.');
  }
  const attestation = rows[0];
  if (new Date(attestation.expires_at).getTime() <= Date.now()) {
    fail('SURFACE_ATTESTATION_EXPIRED', 'La atestación expiró.');
  }
  if (payloadSha256(body) !== attestation.payload_sha256) {
    fail('SURFACE_URL_MISMATCH', 'El payload cambió después de atestarse.');
  }
  const [canonicalUrl] = validatePurposeAndUrls({ purpose: attestation.purpose, surface: attestation, body });
  if (canonicalUrl !== attestation.canonical_url) {
    fail('SURFACE_URL_MISMATCH', 'La URL no coincide con la atestación.');
  }
  return {
    attestationRef: attestation.public_ref,
    purpose: attestation.purpose,
    caseRef: attestation.case_ref,
  };
}

function inboundRequestsLink(record) {
  return /\b(enlace|link|liga|url)\b/i.test(String(record?.message_body || record?.body || ''));
}

async function finalizeIa360Reply(db, { record, body }) {
  const finalBody = String(body || '').trim();
  const hasUrl = extractUrls(finalBody).length > 0;
  if (!hasUrl && !inboundRequestsLink(record)) return finalBody;

  if (
    !record?.surface_attestation_ref
    || !record?.send_correlation_id
    || !record?.contact_number
  ) {
    return IA360_LINK_ESCALATION;
  }
  try {
    const accountKey = record?.account_key || await resolveContactAccountKey(db, record.contact_number);
    await validateOutboundAttestation(db, {
      attestationRef: record.surface_attestation_ref,
      accountKey,
      contactNumber: record.contact_number,
      body: finalBody,
      correlationId: record.send_correlation_id,
    });
    return finalBody;
  } catch (error) {
    if (error instanceof SurfaceContractError) return IA360_LINK_ESCALATION;
    throw error;
  }
}

module.exports = {
  PURPOSES,
  IA360_LINK_ESCALATION,
  SurfaceContractError,
  resolveContactAccountKey,
  listAuthorizedSurfaces,
  attestOutboundPayload,
  validateOutboundAttestation,
  finalizeIa360Reply,
  extractUrls,
  validatePurposeAndUrls,
  payloadSha256,
};
