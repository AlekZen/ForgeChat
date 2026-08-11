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

function truncar(texto, max) {
  const limpio = String(texto == null ? '' : texto).replace(/\s+/g, ' ').trim();
  if (!limpio) return '(sin texto)';
  return limpio.length <= max ? limpio : limpio.slice(0, max - 1).trimEnd() + '…';
}

function dias(desde) {
  const ms = Date.now() - new Date(desde).getTime();
  if (!Number.isFinite(ms)) return '';
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return `hace ${d} día${d === 1 ? '' : 's'}`;
  const h = Math.max(1, Math.floor(ms / 3600000));
  return `hace ${h} h`;
}

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

function buildDigestBody(filas) {
  const lineas = filas.map(f => {
    const quien = String(f.name || '').replace(/\s+WhatsApp IA360$/i, '').trim() || f.contact_number;
    return `• ${quien}: «${truncar(f.contact_message, 90)}» (${dias(f.created_at)})`;
  });
  return [
    `Tienes ${filas.length} promesa${filas.length === 1 ? '' : 's'} de respuesta sin cerrar (les dije "te confirmo por aquí en breve" hace más de 24 h):`,
    '',
    ...lineas,
    '',
    'No les he escrito nada más: el cierre lo decides tú. Responde en su hilo o tómalo manual.',
  ].join('\n');
}

// Un barrido. Invocable a mano para pruebas.
async function runIa360FailuresDigestSweep() {
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

  const body = buildDigestBody(filas);
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
