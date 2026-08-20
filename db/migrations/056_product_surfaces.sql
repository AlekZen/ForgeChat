-- 056: Superficies productivas y atestaciones server-side para egresos con URL.
-- El cliente nunca aporta account_key, teléfono, firma ni una atestación preconstruida.

-- Esta tabla ya existe en producción por la operación IA360; se declara aquí para
-- que un Postgres nuevo pueda aplicar 000-057 y conservar el mismo fail-closed.
CREATE TABLE IF NOT EXISTS coexistence.ia360_contact_scope (
  contact_number TEXT NOT NULL,
  account_key    TEXT NOT NULL,
  rol            TEXT NOT NULL,
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  nota           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ia360_contact_scope_active_contact
  ON coexistence.ia360_contact_scope (contact_number, account_key)
  WHERE activo = TRUE;

CREATE TABLE IF NOT EXISTS coexistence.ia360_product_surfaces (
  id               BIGSERIAL PRIMARY KEY,
  surface_key      TEXT NOT NULL CHECK (surface_key ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  account_key      TEXT NOT NULL CHECK (btrim(account_key) <> ''),
  project_key      TEXT NOT NULL CHECK (btrim(project_key) <> ''),
  environment      TEXT NOT NULL DEFAULT 'production' CHECK (environment = 'production'),
  canonical_origin TEXT NOT NULL CHECK (canonical_origin ~ '^https://[^/?#]+$'),
  path_prefix      TEXT NOT NULL CHECK (
    left(path_prefix, 1) = '/' AND right(path_prefix, 1) = '/'
    AND path_prefix !~ '[?#]'
  ),
  auth_mode        TEXT NOT NULL CHECK (btrim(auth_mode) <> ''),
  source_ref       TEXT NOT NULL CHECK (btrim(source_ref) <> ''),
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_key, environment, surface_key),
  UNIQUE (id, account_key)
);

CREATE INDEX IF NOT EXISTS idx_ia360_product_surfaces_account_active
  ON coexistence.ia360_product_surfaces (account_key, environment, surface_key)
  WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS coexistence.ia360_surface_attestations (
  id                  BIGSERIAL PRIMARY KEY,
  public_ref          TEXT NOT NULL UNIQUE CHECK (public_ref ~ '^a_[0-9a-f]{24}$'),
  surface_id          BIGINT NOT NULL,
  account_key         TEXT NOT NULL CHECK (btrim(account_key) <> ''),
  case_ref            TEXT NOT NULL CHECK (btrim(case_ref) <> ''),
  purpose             TEXT NOT NULL CHECK (
    purpose IN ('production_review', 'production_test', 'case_delivery')
  ),
  canonical_url       TEXT NOT NULL CHECK (canonical_url ~ '^https://'),
  payload_sha256      TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  send_correlation_id TEXT NOT NULL UNIQUE CHECK (btrim(send_correlation_id) <> ''),
  actor_id            TEXT NOT NULL CHECK (btrim(actor_id) <> ''),
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > issued_at),
  UNIQUE (public_ref, account_key),
  CONSTRAINT ia360_surface_attestations_surface_account_fkey
    FOREIGN KEY (surface_id, account_key)
    REFERENCES coexistence.ia360_product_surfaces(id, account_key)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_ia360_surface_attestations_scope
  ON coexistence.ia360_surface_attestations (account_key, purpose, case_ref, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_ia360_surface_attestations_expiry
  ON coexistence.ia360_surface_attestations (expires_at);

ALTER TABLE coexistence.chat_history
  ADD COLUMN IF NOT EXISTS surface_attestation_ref TEXT,
  ADD COLUMN IF NOT EXISTS outbound_purpose TEXT,
  ADD COLUMN IF NOT EXISTS case_ref TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chat_history_surface_attestation_ref_fkey'
       AND conrelid = 'coexistence.chat_history'::regclass
  ) THEN
    ALTER TABLE coexistence.chat_history
      ADD CONSTRAINT chat_history_surface_attestation_ref_fkey
      FOREIGN KEY (surface_attestation_ref)
      REFERENCES coexistence.ia360_surface_attestations(public_ref)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chat_history_outbound_purpose_check'
       AND conrelid = 'coexistence.chat_history'::regclass
  ) THEN
    ALTER TABLE coexistence.chat_history
      ADD CONSTRAINT chat_history_outbound_purpose_check
      CHECK (
        outbound_purpose IS NULL OR outbound_purpose IN (
          'production_review', 'production_test', 'case_delivery'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chat_history_surface_contract_check'
       AND conrelid = 'coexistence.chat_history'::regclass
  ) THEN
    ALTER TABLE coexistence.chat_history
      ADD CONSTRAINT chat_history_surface_contract_check
      CHECK (
        (outbound_purpose IS NULL AND case_ref IS NULL AND surface_attestation_ref IS NULL)
        OR (
          outbound_purpose IS NOT NULL
          AND case_ref IS NOT NULL
          AND (
            outbound_purpose = 'case_delivery'
            OR surface_attestation_ref IS NOT NULL
          )
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_chat_history_surface_attestation
  ON coexistence.chat_history (surface_attestation_ref)
  WHERE surface_attestation_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_history_case_ref
  ON coexistence.chat_history (case_ref, timestamp DESC)
  WHERE case_ref IS NOT NULL;

-- Únicamente superficies demostradas por su fuente de despliegue.
INSERT INTO coexistence.ia360_product_surfaces (
  surface_key, account_key, project_key, environment,
  canonical_origin, path_prefix, auth_mode, source_ref, active
) VALUES
  (
    'cam-app', 'camiones-selectos', 'CAM', 'production',
    'https://camiones-selectos.web.app', '/app/', 'firebase_auth',
    '.firebaserc + firebase.json', TRUE
  ),
  (
    'arp-app', 'aroundaplanet', 'ARP', 'production',
    'https://aroundaplanet--arounda-planet.us-east4.hosted.app', '/', 'firebase_auth',
    'apphosting.yaml::NEXT_PUBLIC_APP_URL', TRUE
  )
ON CONFLICT (account_key, environment, surface_key)
DO UPDATE SET
  project_key = EXCLUDED.project_key,
  canonical_origin = EXCLUDED.canonical_origin,
  path_prefix = EXCLUDED.path_prefix,
  auth_mode = EXCLUDED.auth_mode,
  source_ref = EXCLUDED.source_ref,
  updated_at = NOW();

-- FiscalIA se omite deliberadamente: no hay URL oficial en su fuente de despliegue.
