// P15 — Envejecimiento de las promesas del fallback no-silencio.
//
// El problema que resuelve: cuando el agente no resuelve un mensaje,
// `ia360_fallback_no_silence` le dice al contacto "te confirmo por aquí en
// breve" y registra la fila en `coexistence.ia360_bot_failures` con
// status='abierto'. La promesa se hace y nada la envejece: el owner sólo la ve
// en el momento (una alerta con botones que se pierde en el hilo) y el contacto
// se queda esperando. Medido 2026-08-11: 31 filas `abierto`, varias de semanas,
// de champions reales (Andrés, JC, Germán).
//
// Este barrido manda al owner UN digest cada 6 h con las promesas de más de 24 h
// que siguen abiertas. NO escribe nada al contacto: el cierre hacia el contacto
// sigue siendo humano (política de aprobación por envío). El digest visibiliza
// lo que hoy se pierde.
//
// Idempotencia: reclamo atómico `UPDATE ... WHERE digest_last_at IS NULL
// RETURNING` ANTES de encolar, el mismo patrón de diapazoSesionRecordatorio.
// At-most-once por fila aunque se solapen dos barridos o corran dos procesos.
//
// Camino de egress: resolveAccount + insertPendingRow + enqueueSend (el mismo de
// ia360Reminders / diapazoSesionRecordatorio). No se usa sendIa360DirectText
// porque vive en routes/webhook.js y un servicio no debe importar una ruta.

const pool = require('../db');
const { resolveAccount, insertPendingRow } = require('./messageSender');
const { enqueueSend } = require('../queue/sendQueue');

const OWNER_NUMBER = process.env.IA360_OWNER_NUMBER || '5213322638033';
const WA_NUMBER = process.env.IA360_WA_NUMBER || '5213321594582';

// Antigüedad mínima para que una promesa cuente como vencida. Se expresa en el
// SQL para que la decida Postgres con su reloj, no el proceso.
const PROMESA_INTERVAL = '24 hours';
// Tope de filas por digest: un mensaje de WhatsApp legible, no un volcado.
const MAX_FILAS = 5;

const { buildDigestBody, truncar, dias } = require('../util/failuresDigestBody');

// Candidatas: promesas abiertas de más de 24 h que aún no entraron a un digest.
// Los números QA (rango exacto 52199900XXXXX) quedan fuera: son harness, y el
// digest va al WhatsApp REAL del owner.
async function loadCandidatas() {
  const { rows } = await pool.query(
    `SELECT f.id, f.contact_number, f.contact_message, f.created_at, c.name
       FROM coexistence.ia360_bot_failures f
       LEFT JOIN LATERAL (
              SELECT name FROM coexistence.contacts
               WHERE contact_number = f.contact_number
               ORDER BY updated_at DESC
               LIMIT 1
            ) c ON TRUE
      WHERE f.status = 'abierto'
        AND f.digest_last_at IS NULL
        AND f.created_at < NOW() - ($1)::interval
        AND f.contact_number !~ '^52199900[0-9]{5}$'
      ORDER BY f.created_at
      LIMIT $2`,
    [PROMESA_INTERVAL, MAX_FILAS]
  );
  return rows;
}

// F8 (auditoría 2026-08-12): el owner recibió 5 digests en 15 h. Causa: el
// catch-up de 3 min corre en CADA restart y el LIMIT 5 pagina el backlog de 31
// en tandas, así que cada arranque mandaba la siguiente tanda. El freno tiene que
// sobrevivir a los reinicios ⇒ marcador PERSISTENTE en chat_history, no memoria.
async function digestEnviadoUltimas24h() {
  const { rows } = await pool.query(
    `SELECT 1
       FROM coexistence.chat_history
      WHERE direction = 'outgoing'
        AND template_meta->>'label' = 'owner_failures_digest'
        AND created_at > NOW() - INTERVAL '24 hours'
      LIMIT 1`
  );
  return rows.length > 0;
}

// Total real de promesas vencidas abiertas (no solo las 5 del detalle): sin esto
// el digest dice "tienes 5" cuando en realidad arrastra 31.
async function contarAbiertasVencidas() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM coexistence.ia360_bot_failures
      WHERE status = 'abierto'
        AND created_at < NOW() - ($1)::interval
        AND contact_number !~ '^52199900[0-9]{5}$'`,
    [PROMESA_INTERVAL]
  );
  return rows[0]?.n || 0;
}

// Reclamo atómico del lote. Devuelve los ids realmente reclamados: si otro
// barrido se adelantó, esa fila no vuelve y no se incluye en el digest.
// `owner_action` sólo se sella si estaba vacío — una acción real del owner
// (lo_tomo / respondio_con_comentario / ignorado) jamás se pisa.
async function reclamar(ids) {
  const { rows } = await pool.query(
    `UPDATE coexistence.ia360_bot_failures
        SET digest_last_at = NOW(),
            owner_action = COALESCE(owner_action, 'digest_enviado')
      WHERE id = ANY($1::int[])
        AND digest_last_at IS NULL
      RETURNING id`,
    [ids]
  );
  return new Set(rows.map(r => r.id));
}

// Un barrido. Invocable a mano para pruebas.
async function runIa360FailuresDigestSweep() {
  // Máximo un digest cada 24 h, decidido contra chat_history (sobrevive restarts).
  if (await digestEnviadoUltimas24h()) return { ok: true, skipped: 'digest_reciente_24h' };

  const candidatas = await loadCandidatas();
  if (candidatas.length === 0) return { ok: true, candidates: 0 };

  const { account, error } = await resolveAccount({ fromPhoneNumber: WA_NUMBER });
  if (error || !account) {
    // Degrada SIN reclamar: las filas siguen pendientes para el siguiente barrido.
    console.error('[bot-failures-digest] account resolve failed:', error || 'no account');
    return { ok: false, error: error || 'no account', candidates: candidatas.length };
  }

  const reclamados = await reclamar(candidatas.map(r => r.id));
  const filas = candidatas.filter(r => reclamados.has(r.id));
  if (filas.length === 0) return { ok: true, candidates: candidatas.length, claimed: 0 };

  const totalAbiertas = await contarAbiertasVencidas().catch(() => 0);
  const body = buildDigestBody(filas, totalAbiertas);
  const handlerFor = `ia360_failures_digest:${filas[0].id}:${Date.now()}`;
  try {
    const localId = await insertPendingRow({
      account,
      toNumber: OWNER_NUMBER,
      messageType: 'text',
      messageBody: body,
      templateMeta: {
        ux: 'ia360_owner',
        label: 'owner_failures_digest',
        ia360_handler_for: handlerFor,
        source: 'botFailuresDigest',
        failure_ids: filas.map(f => f.id),
      },
    });
    if (!localId) return { ok: true, candidates: candidatas.length, claimed: filas.length, skipped: 'duplicate_row' };
    await enqueueSend({
      kind: 'text',
      accountId: account.id,
      to: OWNER_NUMBER,
      localMessageId: localId,
      payload: { body, previewUrl: false },
    });
    console.log('[bot-failures-digest] digest encolado filas=%d ids=%s', filas.length, filas.map(f => f.id).join(','));
    return { ok: true, candidates: candidatas.length, claimed: filas.length, sent: true, ids: filas.map(f => f.id) };
  } catch (err) {
    // El reclamo ya se consumió → at-most-once preservado (sin reintento). Se
    // registra fuerte: implica un digest perdido, no duplicado.
    console.error('[bot-failures-digest] enqueue failed ids=%s: %s', filas.map(f => f.id).join(','), err.message);
    return { ok: false, error: err.message, claimed: filas.length };
  }
}

function startIa360FailuresSweep() {
  const MS = parseInt(process.env.IA360_FAILURES_DIGEST_INTERVAL_MS || '', 10) || 6 * 60 * 60 * 1000;

  let running = false;
  const tick = async () => {
    if (running) return; // guarda de solape en-proceso (el reclamo cubre cross-process)
    running = true;
    try { await runIa360FailuresDigestSweep(); }
    catch (e) { console.error('[bot-failures-digest] sweep error:', e.message); }
    finally { running = false; }
  };

  setTimeout(tick, 3 * 60 * 1000).unref(); // catch-up unos minutos tras el arranque
  setInterval(tick, MS).unref();
  console.log('[bot-failures-digest] scheduler started, interval=%dms, owner=%s, max=%d', MS, OWNER_NUMBER, MAX_FILAS);
}

module.exports = {
  startIa360FailuresSweep,
  runIa360FailuresDigestSweep,
  // exportados para pruebas / introspección
  buildDigestBody, truncar,
};
