-- 057: Seguimientos durables después de un template fuera de ventana.
-- chat_history sigue siendo el único outbox; esta tabla conserva intención y estado.

ALTER TABLE coexistence.chat_history
  DROP CONSTRAINT IF EXISTS chat_history_status_check;

ALTER TABLE coexistence.chat_history
  ADD CONSTRAINT chat_history_status_check
  CHECK (status IN (
    'received', 'sending', 'sent', 'delivered', 'read', 'failed', 'error', 'unknown',
    'no_verificable', 'qa_sandboxed'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS chat_history_ia360_handler_dedupe
  ON coexistence.chat_history (contact_number, (template_meta->>'ia360_handler_for'))
  WHERE direction = 'outgoing' AND (template_meta->>'ia360_handler_for') IS NOT NULL;

CREATE TABLE IF NOT EXISTS coexistence.message_followups (
  id                       BIGSERIAL PRIMARY KEY,
  public_ref               TEXT NOT NULL UNIQUE CHECK (public_ref ~ '^q_[0-9a-f]{12}$'),
  account_key              TEXT NOT NULL CHECK (btrim(account_key) <> ''),
  phone_number_id          TEXT NOT NULL CHECK (btrim(phone_number_id) <> ''),
  from_number              TEXT NOT NULL CHECK (btrim(from_number) <> ''),
  contact_number           TEXT NOT NULL CHECK (btrim(contact_number) <> ''),
  case_ref                 TEXT NOT NULL CHECK (btrim(case_ref) <> ''),
  actor_id                 TEXT NOT NULL CHECK (btrim(actor_id) <> ''),
  deliverable              TEXT NOT NULL CHECK (btrim(deliverable) <> ''),
  prepared_body            TEXT NOT NULL,
  purpose                  TEXT NOT NULL CHECK (
    purpose IN ('production_review', 'production_test', 'case_delivery')
  ),
  surface_key              TEXT,
  surface_attestation_ref  TEXT,
  template_name            TEXT NOT NULL,
  template_language        TEXT NOT NULL DEFAULT 'es_MX',
  opener_correlation_id    TEXT NOT NULL UNIQUE,
  final_correlation_id     TEXT UNIQUE,
  trigger_message_id       TEXT UNIQUE,
  state                    TEXT NOT NULL CHECK (state IN (
    'prepared', 'opener_sending', 'active', 'claimed', 'queued', 'sending',
    'sent', 'delivered', 'read',
    'failed', 'error', 'no_verificable', 'cancelled', 'expired'
  )),
  lease_token              TEXT,
  lease_expires_at         TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ NOT NULL,
  last_error_code          TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (
    (surface_key IS NULL AND surface_attestation_ref IS NULL)
    OR (surface_key IS NOT NULL AND surface_attestation_ref IS NOT NULL)
  ),
  CONSTRAINT message_followups_attestation_account_fkey
    FOREIGN KEY (surface_attestation_ref, account_key)
    REFERENCES coexistence.ia360_surface_attestations(public_ref, account_key)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_followups_one_active_contact
  ON coexistence.message_followups (account_key, phone_number_id, contact_number)
  WHERE state IN ('prepared', 'opener_sending', 'active', 'claimed', 'queued', 'sending');

CREATE INDEX IF NOT EXISTS idx_message_followups_state_lease
  ON coexistence.message_followups (state, lease_expires_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_message_followups_expiry
  ON coexistence.message_followups (expires_at)
  WHERE state IN ('prepared', 'opener_sending', 'active', 'claimed', 'queued', 'sending');

CREATE INDEX IF NOT EXISTS idx_message_followups_contact
  ON coexistence.message_followups (account_key, phone_number_id, contact_number, created_at DESC);

CREATE TABLE IF NOT EXISTS coexistence.message_followup_events (
  id                 BIGSERIAL PRIMARY KEY,
  followup_id        BIGINT NOT NULL
    REFERENCES coexistence.message_followups(id) ON DELETE RESTRICT,
  event_type         TEXT NOT NULL CHECK (btrim(event_type) <> ''),
  correlation_id     TEXT,
  inbound_message_id TEXT,
  public_code        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_followup_events_followup
  ON coexistence.message_followup_events (followup_id, created_at);

CREATE INDEX IF NOT EXISTS idx_message_followup_events_inbound
  ON coexistence.message_followup_events (inbound_message_id)
  WHERE inbound_message_id IS NOT NULL;

COMMENT ON COLUMN coexistence.message_followup_events.public_code IS
  'Código público sanitizado; esta tabla nunca guarda cuerpo, URL ni payload crudo.';
