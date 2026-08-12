-- Auditoría WhatsApp 12-ago-2026 · decisión de Alek: las promesas que se le hacen a
-- un usuario viven como tickets de Plane (proyecto CAM), no solo en este ledger.
--
-- El token de Plane vive en Bitwarden a propósito (nunca en un .env, regla del skill
-- plane-cs-ops), así que el contenedor NO puede llamar a Plane. El puente lo corre un
-- agente con el vault abierto (scripts/promesas-a-plane.sh) y escribe el folio de
-- vuelta aquí. Con eso Alekito sabe, desde su propia base, en qué va lo que prometió:
-- «lo tuyo va como CAM-42, en Backlog» en lugar de volver a prometer lo mismo.
ALTER TABLE coexistence.ia360_bot_failures
  ADD COLUMN IF NOT EXISTS plane_issue_key  text,
  ADD COLUMN IF NOT EXISTS plane_issue_id   text,
  ADD COLUMN IF NOT EXISTS plane_state      text,
  ADD COLUMN IF NOT EXISTS plane_synced_at  timestamptz;

-- El puente busca lo que aún no ha subido; índice parcial porque las filas ya
-- sincronizadas nunca se vuelven a consultar por esta vía.
CREATE INDEX IF NOT EXISTS idx_bot_failures_sin_plane
  ON coexistence.ia360_bot_failures (created_at)
  WHERE status = 'abierto' AND plane_issue_key IS NULL;
