-- 052 — Registro de envíos de la Sesión de Afinación DIAPAZO.
--
-- Un WhatsApp Flow sólo reporta al ENVIARSE (nfm_reply en el submit); nunca
-- avisa de que se abrió y se abandonó. Sin este registro no hay forma de saber
-- a quién se le mandó la sesión ni de detectar abandono, y por eso
-- `diapazo_sesion_retomar_v1` lleva APPROVED en Meta sin que nadie lo mande.
--
-- flow_token es la PK: es el único identificador que viaja con el Flow y vuelve
-- en el submit, así que el marcado de respuesta y el reclamo del recordatorio
-- son ambos at-most-once por construcción.
--
-- `nombre` se persiste porque el recordatorio (`diapazo_sesion_retomar_v1`,
-- {{1}} = nombre de pila) se manda justo cuando la sesión NO se contestó: no
-- hay respuesta de la que sacarlo y `coexistence.contacts` puede no tenerlo.
CREATE TABLE IF NOT EXISTS coexistence.diapazo_sesion_enviada (
  flow_token              text PRIMARY KEY,
  contact_number          text NOT NULL,
  wa_number               text NOT NULL,
  nombre                  text,
  enviado_en              timestamptz NOT NULL DEFAULT NOW(),
  respondido_en           timestamptz,
  recordatorio_enviado_at timestamptz
);

-- Índice parcial para el barrido de abandono: sólo las filas que aún pueden
-- generar un recordatorio. Las respondidas y las ya recordadas salen del índice
-- para siempre, así que el sweep no crece con el histórico.
CREATE INDEX IF NOT EXISTS idx_diapazo_sesion_enviada_pendientes
    ON coexistence.diapazo_sesion_enviada (enviado_en)
 WHERE respondido_en IS NULL AND recordatorio_enviado_at IS NULL;
