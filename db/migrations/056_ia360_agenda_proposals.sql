-- 056 — Propuestas de agenda durables con confirmación obligatoria del owner.
--
-- Contrato: las herramientas de agenda del agente (proponer_reunion / cancelar_reunion)
-- emiten una propuesta inmutable con clave única (source_message_id, kind, payload_hash).
-- La escritura real (POST http://n8n:5678/webhook/ia360-owner-agenda-book / cancel) SÓLO
-- se ejecuta tras el tap explícito del owner (Alek) en WhatsApp (ia360_agenda_yes:<proposal_id>),
-- con reclamo atómico condicional y bloqueo asesor (pg_try_advisory_lock) para
-- prevenir ejecuciones concurrentes o doble agendamiento.

CREATE TABLE IF NOT EXISTS coexistence.ia360_agenda_proposals (
  id                  TEXT PRIMARY KEY,
  wa_number           TEXT NOT NULL,
  contact_number      TEXT NOT NULL,
  source_message_id   TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('book', 'cancel')),
  payload_hash        TEXT NOT NULL,
  start_utc           TIMESTAMPTZ,
  end_utc             TIMESTAMPTZ,
  title               TEXT,
  event_id            TEXT,
  zoom_id             TEXT,
  contact_name        TEXT,
  estado              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (estado IN ('pending', 'executing', 'completed', 'rejected', 'expired', 'failed', 'execution_uncertain', 'blocked')),
  detalle_json        JSONB DEFAULT '{}'::jsonb,
  error_message       TEXT,
  delivery_error      TEXT,
  owner_decision      TEXT CHECK (owner_decision IN ('yes', 'no')),
  owner_decided_at    TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resuelto_at         TIMESTAMPTZ,
  CONSTRAINT uq_ia360_agenda_proposals_dedup UNIQUE (source_message_id, kind, payload_hash)
);

-- Búsqueda de propuestas pendientes por contacto / línea
CREATE INDEX IF NOT EXISTS idx_ia360_agenda_proposals_pending
  ON coexistence.ia360_agenda_proposals (contact_number, wa_number, kind, created_at DESC)
  WHERE estado = 'pending';

-- Auditoría y barridos por estado
CREATE INDEX IF NOT EXISTS idx_ia360_agenda_proposals_estado_created
  ON coexistence.ia360_agenda_proposals (estado, created_at DESC);
