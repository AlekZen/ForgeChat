// DIAPAZO — recordatorio de Sesión de Afinación abandonada. Autocontenido: NO
// toca webhook.js.
//
// El problema que resuelve: un WhatsApp Flow sólo reporta al ENVIARSE
// (nfm_reply en el submit). Nunca avisa de que se abrió y se dejó a medias, así
// que la única señal de abandono es negativa — pasó el tiempo y no llegó el
// submit. `coexistence.diapazo_sesion_enviada` (migración 052) es el registro
// que hace observable esa ausencia: ForgeChat inserta una fila al mandar la
// sesión y marca `respondido_en` cuando vuelve el nfm_reply con ese flow_token.
//
// Este barrido manda `diapazo_sesion_retomar_v1` (APPROVED en Meta) UNA sola
// vez por flow_token a quien lleva >24 h sin contestar.
//
// Idempotencia: reclamo atómico `UPDATE ... WHERE recordatorio_enviado_at IS
// NULL RETURNING` ANTES de encolar, exactamente el patrón de
// ia360Reminders.fireReminder. At-most-once por flow_token aunque se solapen
// dos sweeps o corran dos procesos.
//
// Camino de egress: lookupApprovedTemplate + insertPendingRow + enqueueSend, el
// mismo que usa ia360Reminders. Se elige ese y NO enqueueIa360Template porque
// éste vive en routes/webhook.js (un servicio no debe importar una ruta),
// necesita un `record` de inbound para su dedupe por ia360_handler_for y además
// bloquea ~9 s en waitForIa360OutboundStatus por envío. Aquí el dedupe ya lo da
// el reclamo atómico sobre la tabla, que es más fuerte.

const pool = require('../db');
const { resolveAccount, insertPendingRow } = require('./messageSender');
const { enqueueSend } = require('../queue/sendQueue');

const DIAPAZO_WA_NUMBER = process.env.DIAPAZO_WA_NUMBER || process.env.IA360_WA_NUMBER || '5213321594582';
const RETOMAR_TEMPLATE = 'diapazo_sesion_retomar_v1';

// {{1}} del template. Sin nombre no se saluda con un hueco ni con "Hola, .":
// se usa un vocativo neutro que se lee como copy, no como bug.
const NOMBRE_FALLBACK = 'qué tal';
// {{2}} del template ("Dejaste pendiente afinar {{2}}"). En el recordatorio NO
// se conoce la cuerda: la sesión precisamente no se contestó.
const AFINAR_FALLBACK = 'tu operación';

// Ventana de abandono. Igual que en el resto del sistema, se expresa en el SQL
// para que la decide Postgres con su reloj, no el proceso.
const ABANDONO_INTERVAL = '24 hours';

let lastTemplateSync = 0;

function bodyComp(texts) {
  return { type: 'body', parameters: texts.map(t => ({ type: 'text', text: String(t) })) };
}

async function lookupApprovedTemplate(name) {
  const { rows } = await pool.query(
    `SELECT id, name, language, body, status
       FROM coexistence.message_templates
      WHERE name = $1
      ORDER BY (status = 'APPROVED') DESC, updated_at DESC
      LIMIT 1`,
    [name]
  );
  return rows[0] || null;
}

async function maybeKickTemplateSync() {
  // El template puede estar APPROVED en Meta y aún no reflejado en la copia
  // local (el auto-sync de index.js sólo llama a Meta si hay SUBMITTED). Empuja
  // el poller, throttle 10 min. Best-effort.
  if (Date.now() - lastTemplateSync < 10 * 60 * 1000) return;
  lastTemplateSync = Date.now();
  try {
    const { syncAllAccountTemplates } = require('../routes/templates');
    await syncAllAccountTemplates();
  } catch (err) {
    console.error('[diapazo-recordatorio] template sync nudge failed:', err.message);
  }
}

// Nombre de pila para {{1}}: la fila manda (se capturó al enviar la sesión);
// si no, el nombre del contacto; si tampoco, saludo neutro.
async function derivarNombre(row) {
  const guardado = String(row.nombre || '').trim();
  if (guardado) return guardado.split(/\s+/)[0];
  const n = String(row.contact_number || '').replace(/\D/g, '');
  if (n) {
    try {
      const { rows } = await pool.query(
        `SELECT name FROM coexistence.contacts
          WHERE contact_number = $1
          ORDER BY updated_at DESC
          LIMIT 1`,
        [n]
      );
      const cand = String(rows[0]?.name || '').replace(/\s+WhatsApp IA360$/i, '').trim();
      if (cand) return cand.split(/\s+/)[0];
    } catch (err) {
      console.error('[diapazo-recordatorio] derivarNombre error:', err.message);
    }
  }
  return NOMBRE_FALLBACK;
}

// Reclama y manda el recordatorio de UNA sesión. Devuelve un objeto de estado.
async function fireRecordatorio(account, tpl, row) {
  // Reclamo atómico at-most-once ANTES de encolar.
  const claim = await pool.query(
    `UPDATE coexistence.diapazo_sesion_enviada
        SET recordatorio_enviado_at = NOW()
      WHERE flow_token = $1 AND recordatorio_enviado_at IS NULL
      RETURNING flow_token`,
    [row.flow_token]
  );
  if (claim.rowCount === 0) return { flowToken: row.flow_token, skipped: 'lost_claim' };

  try {
    const nombre = await derivarNombre(row);
    const components = [bodyComp([nombre, AFINAR_FALLBACK])];
    const handlerFor = `diapazo_sesion_retomar:${row.flow_token}`;
    const localId = await insertPendingRow({
      account,
      toNumber: row.contact_number,
      messageType: 'template',
      messageBody: `Hola, ${nombre}. Dejaste pendiente afinar ${AFINAR_FALLBACK}. Conservamos tu contexto para que no vuelvas a empezar. ¿Lo retomamos?`,
      templateMeta: {
        ux: 'diapazo_sesion_recordatorio',
        flow_token: row.flow_token,
        ia360_handler_for: handlerFor,
        source: 'diapazoSesionRecordatorio',
        template_name: tpl.name,
        template_id: tpl.id,
      },
    });
    if (!localId) {
      // Dedupe ON CONFLICT: otra ruta ya insertó este handler. El reclamo ya
      // está tomado, así que sigue siendo at-most-once; no se encola nada.
      return { flowToken: row.flow_token, skipped: 'duplicate_row' };
    }

    await enqueueSend({
      kind: 'template',
      accountId: account.id,
      to: row.contact_number,
      localMessageId: localId,
      payload: { name: tpl.name, languageCode: tpl.language || 'es_MX', components },
    });

    console.log('[diapazo-recordatorio] encolado flow_token=%s to=%s tpl=%s local=%s', row.flow_token, row.contact_number, tpl.name, localId);
    return { flowToken: row.flow_token, sent: true, localId, handlerFor };
  } catch (err) {
    // El reclamo ya se consumió -> at-most-once preservado (sin reintento).
    // Se registra fuerte porque implica un recordatorio perdido, no duplicado.
    console.error('[diapazo-recordatorio] enqueue failed flow_token=%s: %s', row.flow_token, err.message);
    return { flowToken: row.flow_token, error: err.message };
  }
}

// Un barrido sobre las sesiones abandonadas. Invocable a mano para pruebas.
async function runDiapazoSesionRecordatorioSweep() {
  // Un envío encolado no es un envío entregado: Meta puede rechazarlo después
  // (medido 2026-08-10: (#131009) al abrir el Flow en una pantalla intermedia).
  // Recordarle "dejaste pendiente" a quien nunca recibió la sesión es peor que
  // callarse, así que la sesión cuyo outbound acabó en failed no entra al barrido.
  const { rows } = await pool.query(
    `SELECT s.flow_token, s.contact_number, s.wa_number, s.nombre, s.enviado_en
       FROM coexistence.diapazo_sesion_enviada s
      WHERE s.respondido_en IS NULL
        AND s.recordatorio_enviado_at IS NULL
        AND s.enviado_en < NOW() - ($1)::interval
        AND NOT EXISTS (
              SELECT 1 FROM coexistence.chat_history h
               WHERE h.template_meta->>'label' = 'diapazo_sesion_flow_' || s.flow_token
                 AND h.status IN ('failed', 'error')
            )
      ORDER BY s.enviado_en`,
    [ABANDONO_INTERVAL]
  );
  if (rows.length === 0) return { ok: true, candidates: 0, results: [] };

  const tpl = await lookupApprovedTemplate(RETOMAR_TEMPLATE);
  if (!tpl || tpl.status !== 'APPROVED') {
    // Degrada SIN reclamar: la fila sigue pendiente y el siguiente barrido lo
    // reintenta cuando el template esté aprobado/sincronizado.
    console.warn('[diapazo-recordatorio] template %s no APPROVED (status=%s) — degrada, %d sesión(es) pendiente(s)', RETOMAR_TEMPLATE, tpl?.status || 'missing', rows.length);
    maybeKickTemplateSync();
    return { ok: true, candidates: rows.length, skipped: 'template_not_approved', results: [] };
  }

  const { account, error } = await resolveAccount({ fromPhoneNumber: DIAPAZO_WA_NUMBER });
  if (error || !account) {
    console.error('[diapazo-recordatorio] account resolve failed:', error || 'no account');
    return { ok: false, error: error || 'no account' };
  }

  const results = [];
  for (const row of rows) results.push(await fireRecordatorio(account, tpl, row));
  const sent = results.filter(r => r.sent).length;
  if (sent > 0) console.log('[diapazo-recordatorio] sweep: %d sesión(es) abandonada(s), %d recordatorio(s) encolado(s)', rows.length, sent);
  return { ok: true, candidates: rows.length, results };
}

function startDiapazoSesionRecordatorio() {
  const MS = parseInt(process.env.DIAPAZO_SESION_RECORDATORIO_INTERVAL_MS || '', 10) || 5 * 60 * 1000;

  let running = false;
  const tick = async () => {
    if (running) return; // guarda de solape en-proceso (el reclamo cubre cross-process)
    running = true;
    try { await runDiapazoSesionRecordatorioSweep(); }
    catch (e) { console.error('[diapazo-recordatorio] sweep error:', e.message); }
    finally { running = false; }
  };

  setTimeout(tick, 60 * 1000).unref();   // catch-up poco después del arranque
  setInterval(tick, MS).unref();         // régimen: cada ~5 min
  console.log('[diapazo-recordatorio] scheduler started, interval=%dms, wa=%s, tpl=%s', MS, DIAPAZO_WA_NUMBER, RETOMAR_TEMPLATE);
}

module.exports = {
  startDiapazoSesionRecordatorio,
  runDiapazoSesionRecordatorioSweep,
  // exportados para pruebas / introspección
  derivarNombre, lookupApprovedTemplate, RETOMAR_TEMPLATE,
};
