-- 050: Stable outbound correlation for queued sends
--
-- message_id starts as local-* and is replaced by Meta's wamid after the queue
-- worker succeeds. send_correlation_id preserves the original local identifier
-- so API clients can close the send lifecycle without matching message text.

ALTER TABLE coexistence.chat_history
  ADD COLUMN IF NOT EXISTS send_correlation_id TEXT;

-- Preserve existing public message references. For historical outbound rows the
-- current message_id is the only stable identifier still available.
UPDATE coexistence.chat_history
   SET send_correlation_id = message_id
 WHERE direction = 'outgoing'
   AND send_correlation_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_outbound_correlation
  ON coexistence.chat_history (send_correlation_id)
  WHERE send_correlation_id IS NOT NULL;
