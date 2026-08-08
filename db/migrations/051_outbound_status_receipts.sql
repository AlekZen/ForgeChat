-- 051: Bridge Meta status receipts that race the local-id -> wamid update.
-- Rows normally live only for the duration of that race; resolved receipts are deleted.

CREATE TABLE IF NOT EXISTS coexistence.outbound_status_receipts (
  message_id    TEXT PRIMARY KEY,
  status        TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed', 'error')),
  error_message TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbound_status_receipts_received
  ON coexistence.outbound_status_receipts (received_at);
