-- 057 — Columna resources para propuestas de agenda durables
--
-- Permite registrar explícitamente los recursos seleccionados ('calendar', 'zoom')
-- para soportar citas de Calendar solo, Zoom solo o ambos de forma independiente.

ALTER TABLE coexistence.ia360_agenda_proposals
  ADD COLUMN IF NOT EXISTS resources TEXT[];
