-- Lectura de medios (Alek, 12-ago-2026): el texto que resulta de VER una imagen o
-- ESCUCHAR un audio que mandó el contacto. Se guarda aparte de message_body porque
-- message_body es el hecho crudo (pie de foto, nombre de archivo o el placeholder
-- 'Audio message'); esta columna es la interpretación.
--
-- Con esto el ledger y el digest dejan de mostrar «Audio message» como si fuera lo
-- que pidió el champion, y el agente puede responder a lo que de verdad dijo.
ALTER TABLE coexistence.chat_history
  ADD COLUMN IF NOT EXISTS media_lectura text;

-- El barrido de rezago busca medios sin leer; índice parcial porque las filas ya
-- leídas no se vuelven a consultar por esta vía.
CREATE INDEX IF NOT EXISTS idx_chat_history_media_sin_leer
  ON coexistence.chat_history (created_at)
  WHERE direction = 'incoming' AND media_storage_path IS NOT NULL AND media_lectura IS NULL;
