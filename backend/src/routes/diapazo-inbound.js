'use strict';

// ============================================================================
// G7 — Ruteo de INBOUND de leads DIAPAZO (coexistencia con TransformIA/IA360)
// ----------------------------------------------------------------------------
// OPCION B (aislado, aditivo, flag-gated, REVERSIBLE). El WhatsApp del negocio es
// COMPARTIDO: hoy, cuando un lead DIAPAZO responde, su mensaje cae al monolito
// IA360 (handleIa360FreeText). Este modulo intercepta SOLO a los leads marcados
// como DIAPAZO (custom_fields.project='diapazo') y los atiende con voz DIAPAZO,
// ANTES del embudo IA360 — sin tocar el monolito, TransformIA ni al owner.
//
// Contratos duros (ver apps/web-diapazo/docs/DIAPAZO-fix-spec.md #G7):
//   - process.env.DIAPAZO_INBOUND !== 'on'  => return false (CERO cambio de
//     comportamiento; regresion cero hasta encender el flag tras tests verdes).
//   - record.contact_number === owner       => return false (el owner JAMAS se
//     rutea a DIAPAZO; cae en sus comandos/canary, que ya corrieron antes).
//   - contacto sin marca DIAPAZO             => return false (sigue al embudo
//     IA360/TransformIA intacto, igual que hoy).
//   - contacto DIAPAZO                       => responde y return true (consume).
//
// Aislamiento: este archivo NO edita webhook.js ni metaSend.js; solo IMPORTA
// metaSend (sendText) y el resolver de cuenta. Estado conversacional propio en
// custom_fields.diapazo_conv_state (NUNCA ia360_conv_state). Dedupe propio por
// message_id. En webhook.js solo se agrega el require + 1 linea de short-circuit.
// ============================================================================

const pool = require('../db');
const { sendText } = require('../integrations/metaSend');
const { getSingleAccount } = require('./whatsappAccounts');

// Owner (WhatsApp personal de Alek). NUNCA cae en DIAPAZO. Mismo numero que
// IA360_OWNER_NUMBER / DIAPAZO_OWNER_WA; se lee de env con fallback al valor real.
const OWNER_WA = process.env.IA360_OWNER_NUMBER || process.env.DIAPAZO_OWNER_WA || '5213322638033';
// Numeros QA del harness E2E (52199900XXXXX, 13 digitos exactos): egress sintetico,
// se persiste fila 'qa_sandboxed' en chat_history SIN tocar Meta. Mismo rango que
// IA360_QA_NUMBER_RE en webhook.js, replicado aqui porque DIAPAZO usa metaSend
// directo (sin la guarda de la cola IA360).
const QA_RE = /^52199900\d{5}$/;
// R0 recepcionista (n8n, persona-first). OPCIONAL: si DIAPAZO_R0_URL esta vacio,
// el handler usa la voz DIAPAZO estatica (sin reimplementar persona). Si se
// configura la URL, se REUSA R0 (read-only) y su reply tiene prioridad.
const R0_URL = process.env.DIAPAZO_R0_URL || '';

function flagOn() { return process.env.DIAPAZO_INBOUND === 'on'; }
function onlyDigits(s) { return String(s == null ? '' : s).replace(/[^0-9]/g, ''); }

// Discriminador de propiedad DIAPAZO. La UNICA senal valida es la marca dedicada
// (project='diapazo' o diapazo_lead). NO se mira project_name (esa es la llave de
// IA360): asi el cage es estricto y jamas confundimos un contacto IA360 con uno
// DIAPAZO.
function isDiapazoContact(cf) {
  if (!cf || typeof cf !== 'object' || Array.isArray(cf)) return false;
  if (String(cf.project || '').toLowerCase() === 'diapazo') return true;
  const flag = cf.diapazo_lead;
  return flag === true || flag === 1 || /^(true|1|s[ií]|yes|on)$/i.test(String(flag == null ? '' : flag));
}

// Carga del contacto por (wa_number + ULTIMOS 10 DIGITOS del numero). El WhatsApp
// de Meta entrega el wa_id de MX a veces como 52+10 y a veces como 521+10 (el
// clasico "1 despues del 52"); el intake (diapazo.js -> normalizeMx) lo guarda en
// forma 521+10. Igualar por sufijo de 10 digitos hace el ruteo robusto a esa
// discrepancia (si solo se igualara exacto, un lead DIAPAZO real con formato
// distinto se misrutearia en silencio al monolito). Se prefiere la fila que ya
// tiene estado DIAPAZO, luego la marcada project=diapazo, para converger en una
// sola fila canonica. wa_number SI se iguala exacto (es el numero del negocio,
// estable). NO se importa el loader de webhook.js (mantiene su diff en +1 linea).
async function loadContact(record) {
  if (!record || !record.wa_number || !record.contact_number) return null;
  const last10 = onlyDigits(record.contact_number).slice(-10);
  if (last10.length < 10) return null;
  const { rows } = await pool.query(
    `SELECT id, contact_number, COALESCE(name, profile_name) AS name, custom_fields
       FROM coexistence.contacts
      WHERE wa_number=$1
        AND right(regexp_replace(contact_number, '\\D', '', 'g'), 10) = $2
      ORDER BY (custom_fields->'diapazo_conv_state') IS NOT NULL DESC,
               (custom_fields->>'project'='diapazo') DESC,
               id DESC
      LIMIT 1`,
    [record.wa_number, last10]
  );
  return rows[0] || null;
}

// Estado conversacional DIAPAZO, enjaulado por su propia llave. NUNCA toca
// ia360_conv_state (el merge jsonb '||' es superficial: reemplaza solo la llave
// diapazo_conv_state y conserva el resto de custom_fields, incluido el estado IA360).
function loadConvState(cf) {
  const raw = cf && cf.diapazo_conv_state;
  const st = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    turns: Number(st.turns) || 0,
    last_inbound_msg_id: st.last_inbound_msg_id || null,
    processed: Array.isArray(st.processed) ? st.processed : [],
  };
}

// Escribe el estado en la MISMA fila que devolvio loadContact (su contact_number
// real, no el del record), para que load y save no se separen entre las dos formas
// del numero. Tambien sella project=diapazo en esa fila (self-heal: refuerza el
// marcador sobre la fila canonica). Merge jsonb superficial: jamas toca ia360_conv_state.
async function saveConvState(waNumber, contactNumber, st) {
  await pool.query(
    `INSERT INTO coexistence.contacts (wa_number, contact_number, custom_fields, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (wa_number, contact_number) DO UPDATE SET
       custom_fields = COALESCE(coexistence.contacts.custom_fields, '{}'::jsonb) || EXCLUDED.custom_fields,
       updated_at = NOW()`,
    [waNumber, contactNumber, JSON.stringify({ diapazo_conv_state: st, project: 'diapazo' })]
  );
}

// Voz DIAPAZO (director sereno; lexico afinar/cuerda/tono/diriges; dignidad: el
// desorden es desafinacion normal, no fracaso). El contacto ya recibio el primer
// mensaje DIAPAZO y esta respondiendo que es lo que mas le desafina; este reply
// reconoce con dignidad e invita al diagnostico (el lead magnet). Doc de voz:
// apps/web-diapazo/docs/estrategia/ (06 identidad verbal, 08 guion hero).
function buildDiapazoReply({ name }) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const hola = first ? ('Te leo, ' + first + '. ') : 'Te leo. ';
  return (
    hola +
    'Lo que me cuentas no es que algo esté roto: es tu empresa pidiendo afinación, y eso se ordena. ' +
    'Mi forma de mostrártelo es medir, ahora mismo, qué tan afinada está tu operación y decirte qué ' +
    'cuerda conviene destensar primero: tres minutos, sin costo y sin compromiso. ' +
    '¿Lo afinamos? Tú diriges; nosotros damos el tono.'
  );
}

// Reusa R0 (recepcionista persona-first) si esta configurado. Read-only: NO edita
// el workflow, solo lo invoca por HTTP. Best-effort: ante cualquier fallo, null
// (el handler cae a la voz estatica). Nunca lanza.
async function tryR0({ record, message }) {
  if (!R0_URL) return null;
  try {
    const res = await fetch(R0_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_wa_number: record.contact_number,
        message,
        project: 'diapazo',
        force_actor: 'contact',
      }),
    });
    if (!res.ok) { console.error('[diapazo-inbound] R0 status=%s', res.status); return null; }
    const text = await res.text();
    if (!text || !text.trim()) return null;
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return null; }
    const reply = parsed.reply || parsed.text || parsed.message
      || (parsed.output && (parsed.output.reply || parsed.output.text)) || null;
    return reply ? String(reply) : null;
  } catch (err) {
    console.error('[diapazo-inbound] R0 error:', err && err.message);
    return null;
  }
}

// Egress DIAPAZO + persistencia en chat_history. Guarda QA: a numeros sandbox
// (52199900XXXXX) NO se llama a Meta; se escribe fila 'qa_sandboxed' (correlacionable
// por template_meta->>'label') para que el harness la vea sin egress real.
async function sendDiapazoText({ record, to, body }) {
  const dest = onlyDigits(to);
  const qaSandbox = QA_RE.test(dest);
  const tmeta = JSON.stringify({ ux: 'diapazo_inbound', label: 'diapazo_inbound_reply', source: 'diapazo-inbound', diapazo_for: record.message_id || null });

  if (qaSandbox) {
    const sbId = 'diapazo_sb:' + (record.message_id || dest);
    await pool.query(
      `INSERT INTO coexistence.chat_history
         (message_id, phone_number_id, wa_number, contact_number, to_number, direction,
          message_type, message_body, status, template_meta, timestamp, context_message_id)
       VALUES ($1,$2,$3,$4,$5,'outgoing','text',$6,'qa_sandboxed',$7::jsonb,NOW(),$8)
       ON CONFLICT (message_id) DO NOTHING`,
      [sbId, record.phone_number_id || null, record.wa_number, dest, dest, body, tmeta, record.message_id || null]
    );
    console.log('[diapazo-inbound] sandbox egress (sin Meta) to=%s msg=%s', dest, sbId);
    return { sandbox: true, message_id: sbId };
  }

  const acct = await getSingleAccount();
  if (!acct || !acct.accessToken) throw new Error('no_whatsapp_account');
  const r = await sendText({
    accessToken: acct.accessToken,
    phoneNumberId: acct.phoneNumberId,
    to: dest,
    body,
    contextMessageId: record.message_id || null,
  });
  const wamid = (r && r.messages && r.messages[0] && r.messages[0].id) || null;
  await pool.query(
    `INSERT INTO coexistence.chat_history
       (message_id, phone_number_id, wa_number, contact_number, to_number, direction,
        message_type, message_body, status, template_meta, timestamp, context_message_id)
     VALUES ($1,$2,$3,$4,$5,'outgoing','text',$6,'sent',$7::jsonb,NOW(),$8)
     ON CONFLICT (message_id) DO NOTHING`,
    [wamid || ('diapazo_out:' + (record.message_id || dest)), acct.phoneNumberId, record.wa_number,
     dest, dest, body, tmeta, record.message_id || null]
  );
  console.log('[diapazo-inbound] egress real to=%s wamid=%s', dest, wamid);
  return { sandbox: false, message_id: wamid };
}

// Handler principal. Contrato: retorna true SOLO si consume el evento (lead DIAPAZO
// atendido). En cualquier otro caso retorna false y el evento sigue su curso normal
// (embudo IA360 intacto). NUNCA lanza: un throw aqui caeria en el catch del dispatch
// del webhook y podria disparar el fallback de fallo.
async function handleDiapazoInbound(record) {
  // --- Fase 1: guardas baratas + clasificacion (fail-OPEN: ante duda, false) ---
  if (!flagOn()) return false;                                   // flag off => cero cambio
  if (!record || record.direction !== 'incoming') return false;
  if (record.message_type !== 'text') return false;             // v1: solo texto; otros tipos => embudo intacto
  if (!String(record.message_body || '').trim()) return false;
  if (onlyDigits(record.contact_number) === onlyDigits(OWNER_WA)) return false; // owner JAMAS DIAPAZO

  let contact;
  try {
    contact = await loadContact(record);
  } catch (err) {
    console.error('[diapazo-inbound] loadContact error (no consume):', err && err.message);
    return false;                                               // fail-open: IA360 sigue igual
  }
  if (!contact || !isDiapazoContact(contact.custom_fields)) return false; // no es DIAPAZO => embudo intacto

  // --- Fase 2: COMPROMETIDOS con DIAPAZO. A partir de aqui devolvemos true aunque
  // falle algo interno, para garantizar UN solo reply (el monolito no responde encima). ---
  try {
    const cf = contact.custom_fields || {};
    const st = loadConvState(cf);
    const msgId = record.message_id || '';

    if (msgId && st.processed.includes(msgId)) {                // dedupe propio (reintento de Meta)
      console.log('[diapazo-inbound] dedupe msg=%s (ya procesado) contact=%s', msgId, record.contact_number);
      return true;                                             // consumido, sin re-responder
    }

    const message = String(record.message_body || '').trim();
    let reply = await tryR0({ record, message });               // reusa R0 si esta configurado
    if (!reply) reply = buildDiapazoReply({ name: contact.name });

    const out = await sendDiapazoText({ record, to: record.contact_number, body: reply });

    st.turns += 1;
    if (msgId) {
      st.last_inbound_msg_id = msgId;
      st.processed = st.processed.slice(-19).concat(msgId);     // ultimas 20 llaves
    }
    // Estado en la MISMA fila canonica que devolvio loadContact (su contact_number
    // real), nunca en una segunda fila por la discrepancia 52/521 del numero.
    await saveConvState(record.wa_number, contact.contact_number || record.contact_number, st);

    console.log('[diapazo-inbound] -> true contact=%s turns=%d sandbox=%s out=%s',
      record.contact_number, st.turns, out.sandbox, out.message_id);
    return true;
  } catch (err) {
    console.error('[diapazo-inbound] handler error (evento consumido para evitar doble-respuesta):', err && err.message);
    return true;                                                // owned: NO dejar que el monolito responda encima
  }
}

module.exports = { handleDiapazoInbound, isDiapazoContact, buildDiapazoReply };
