-- 053 — Envejecimiento de las promesas del fallback no-silencio.
--
-- `ia360_fallback_no_silence` le promete al contacto "te confirmo por aquí en
-- breve" y deja una fila `abierto` en coexistence.ia360_bot_failures. Nada
-- envejecía esa promesa: ni digest al owner ni seguimiento, así que 31 filas
-- llevaban semanas abiertas (medido 2026-08-11) con champions reales esperando.
--
-- La tabla nació operativamente antes de versionarse. Declararla hace que un
-- Postgres nuevo pueda aplicar 000-057 igual que producción.
CREATE TABLE IF NOT EXISTS coexistence.ia360_bot_failures (
  id             SERIAL PRIMARY KEY,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  contact_number TEXT,
  contact_message TEXT,
  reason         TEXT,
  bot_fallback   TEXT,
  owner_action   TEXT,
  owner_comment  TEXT,
  status         TEXT DEFAULT 'abierto'
);

-- `digest_last_at` es el sello del reclamo at-most-once del barrido
-- (services/botFailuresDigest.js): se escribe ANTES de encolar el digest, así
-- que dos barridos solapados no repiten el aviso. El `status` sigue siendo del
-- owner (lo_tomo / respondido_* / ignorado): el digest visibiliza, no cierra.
ALTER TABLE coexistence.ia360_bot_failures
  ADD COLUMN IF NOT EXISTS digest_last_at timestamptz;

-- Índice parcial del barrido: sólo las filas que aún pueden generar un digest.
-- Las ya avisadas y las que el owner cerró salen del índice para siempre.
CREATE INDEX IF NOT EXISTS idx_ia360_bot_failures_digest_pendientes
    ON coexistence.ia360_bot_failures (created_at)
 WHERE status = 'abierto' AND digest_last_at IS NULL;
