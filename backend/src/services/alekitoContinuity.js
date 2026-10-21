'use strict';
const P = require('./alekitoBridgePolicy');
const KEYS = ['ingress_ref','message_ref','request_id','account_ref','digest'];
const WINDOW_MS = 86400000, MAX_TEXT_BYTES = 8192, MAX_DTO_BYTES = 32768;
const confirmed = status => ['sent','delivered','read'].includes(status);
// Same raw_payload signals used by eligibleIngress(); no text/phone heuristics.
const REAL_SQL = `COALESCE(h.raw_payload->>'origin','') NOT IN ('qa','simulation') AND ` +
  ['dry_run','synthetic','test'].map(k => `COALESCE(h.raw_payload->'${k}','null'::jsonb) IN
  ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)`).join(' AND ');
const ANCHOR_SQL = `SELECT h.id,h.message_id,h.wa_number,h.contact_number,h.direction,h.message_type,h.timestamp,h.context_message_id
FROM coexistence.chat_history h JOIN coexistence.alekito_inbound_ownership o ON o.message_id=h.message_id
WHERE h.wa_number=$1 AND h.contact_number=$2 AND o.account_ref=$3 AND o.message_ref=$4
  AND h.direction='incoming' AND h.message_type IN ('text','button','interactive','audio','voice','image','video','document','location','contacts') LIMIT 2`;
const HISTORY_SQL = `WITH anchor AS (
 SELECT id,timestamp,context_message_id FROM coexistence.chat_history WHERE id=$1 AND message_id=$2
 AND wa_number=$3 AND contact_number=$4 AND direction='incoming' AND message_type IN ('text','button','interactive','audio','voice','image','video','document','location','contacts')
)
SELECT h.id,h.message_id,h.wa_number,h.contact_number,h.direction,h.status,h.timestamp,
 octet_length((CASE WHEN a.context_message_id IS NOT NULL AND h.message_id = a.context_message_id THEN '[MENSAJE AL QUE RESPONDE ESTE TURNO]: ' ELSE '' END) || (CASE WHEN h.media_lectura IS NOT NULL AND btrim(h.media_lectura)<>'' THEN '[' || h.message_type || ']: ' || h.media_lectura ELSE h.message_body END)) AS text_bytes,
 CASE WHEN octet_length((CASE WHEN a.context_message_id IS NOT NULL AND h.message_id = a.context_message_id THEN '[MENSAJE AL QUE RESPONDE ESTE TURNO]: ' ELSE '' END) || (CASE WHEN h.media_lectura IS NOT NULL AND btrim(h.media_lectura)<>'' THEN '[' || h.message_type || ']: ' || h.media_lectura ELSE h.message_body END))<=8192 THEN ((CASE WHEN a.context_message_id IS NOT NULL AND h.message_id = a.context_message_id THEN '[MENSAJE AL QUE RESPONDE ESTE TURNO]: ' ELSE '' END) || (CASE WHEN h.media_lectura IS NOT NULL AND btrim(h.media_lectura)<>'' THEN '[' || h.message_type || ']: ' || h.media_lectura ELSE h.message_body END)) END AS message_body,
 (${REAL_SQL}) AS is_real
FROM coexistence.chat_history h CROSS JOIN anchor a
WHERE h.wa_number=$3 AND h.contact_number=$4 AND h.message_type IN ('text','button','interactive','template','audio','voice','image','video','document','location','contacts')
 AND (h.direction='incoming' OR (h.direction='outgoing' AND h.status IN ('sent','delivered','read')))
 AND (${REAL_SQL}) AND h.message_body IS NOT NULL AND btrim(h.message_body)<>''
 AND h.timestamp >= a.timestamp - interval '24 hours'
 AND (h.timestamp,h.id) < (a.timestamp,a.id)
ORDER BY h.timestamp DESC,h.id DESC LIMIT 20`;
const RECHECK_SQL = `SELECT h.id,h.wa_number,h.contact_number,h.direction,h.status,(${REAL_SQL}) AS is_real
FROM coexistence.chat_history h WHERE h.wa_number=$1 AND h.contact_number=$2 AND h.id=ANY($3::bigint[])`;

function exactBinding(body) {
  P.exact(body, KEYS, 'CONTINUITY_UNKNOWN_FIELD');
  const patterns = [/^in_[a-f0-9]{32}$/,/^msg_[a-f0-9]{64}$/,/^req_[a-f0-9]{64}$/,/^[a-f0-9]{12}$/,/^[a-f0-9]{64}$/];
  if (Object.keys(body).length!==KEYS.length || KEYS.some((k,i) =>
    typeof body[k]!=='string' || !patterns[i].test(body[k]))) P.fail('CONTINUITY_BINDING_REQUIRED',400);
  return Object.fromEntries(KEYS.map(k => [k,body[k]]));
}
function scopeFor(identity) {
  const wa=P.digits(identity?.wa_number),contact=P.digits(identity?.contact_number);
  if (!wa || !contact) P.fail('CONTINUITY_OWNER_UNAVAILABLE',503);
  return {wa,contact,account_ref:P.hash(wa).slice(0,12),contact_ref:P.contactRef(wa,contact),
    conversation_ref:`conv_${P.hash(`${wa}\0${contact}`)}`};
}
function validateOrigin(origin,binding,scope,now) {
  if (origin?.ok!==true || origin.verified!==true || origin.schema!=='alekito.ingress-verified.v1' ||
    origin.source!=='persisted-meta-ingress' || origin.grants_merged!==false ||
    KEYS.some(k => origin[k]!==binding[k])) P.fail('CONTINUITY_BINDING_MISMATCH',403);
  if (origin.account_ref!==scope.account_ref || origin.contact_ref!==scope.contact_ref ||
    origin.conversation_ref!==scope.conversation_ref) P.fail('CONTINUITY_SCOPE_MISMATCH',403);
  const received=Date.parse(origin.received_at),expires=Date.parse(origin.expires_at);
  if (!Number.isFinite(received) || !Number.isFinite(expires) || expires<=received) P.fail('CONTINUITY_INVALID_PROOF',403);
  if (now>=expires) P.fail('FRESH_INGRESS_REQUIRED',409);
  return received;
}
const sameIdentity = (row,scope) => row.wa_number===scope.wa && row.contact_number===scope.contact;
const realResult = row => row.is_real===true;
function bounded(dto) {
  if (Buffer.byteLength(JSON.stringify(dto),'utf8')>MAX_DTO_BYTES) P.fail('CONTINUITY_DTO_TOO_LARGE',413);
  return dto;
}
function createOwnerContinuityReader({db,verifyOwnerIngress,resolveOwnerIdentity,filterHistory,now=Date.now}={}) {
  if (typeof db?.query!=='function' || typeof verifyOwnerIngress!=='function' ||
    typeof resolveOwnerIdentity!=='function' || typeof now!=='function') P.fail('CONTINUITY_NOT_BOUND',503);
  async function query(sql,args) {
    try { const result=await db.query(sql,args); if (!Array.isArray(result?.rows)) throw Error(); return result.rows; }
    catch { P.fail('CONTINUITY_UNAVAILABLE',503); }
  }
  async function read(body) {
    const binding=exactBinding(body),origin=await verifyOwnerIngress(binding);
    const scope=scopeFor(await resolveOwnerIdentity()),received=validateOrigin(origin,binding,scope,now());
    const candidates=await query(ANCHOR_SQL,[scope.wa,scope.contact,binding.account_ref,binding.message_ref]);
    if (candidates.length!==1) P.fail('CONTINUITY_INGRESS_NOT_FOUND',409);
    const anchor=candidates[0];
    if (!sameIdentity(anchor,scope) || anchor.direction!=='incoming' || !['text','button','interactive','audio','voice','image','video','document','location','contacts'].includes(anchor.message_type) ||
      (['button','interactive'].includes(anchor.message_type) && (origin.input?.original_type!==anchor.message_type || typeof origin.input?.button_payload!=='string' || typeof origin.input?.reply_to!=='string' || origin.input.reply_to!=='m_'+P.hash(anchor.context_message_id||'').slice(0,12))) ||
      typeof anchor.message_id!=='string' || P.ingressRef(anchor.message_id)!==binding.ingress_ref ||
      `msg_${P.hash(anchor.message_id)}`!==binding.message_ref || !/^\d+$/.test(String(anchor.id)) ||
      new Date(anchor.timestamp).getTime()!==received) P.fail('CONTINUITY_INGRESS_MISMATCH',403);
    let rows=await query(HISTORY_SQL,[String(anchor.id),anchor.message_id,scope.wa,scope.contact]);
    if (filterHistory!==undefined) {
      if (typeof filterHistory!=='function') P.fail('CONTINUITY_HISTORY_GUARD_REQUIRED',503);
      const originalRows=rows.slice();
      rows=await filterHistory({binding,origin,scope,anchor,rows});
      if (!Array.isArray(rows) || rows.length>originalRows.length || new Set(rows).size!==rows.length || rows.some(row=>!originalRows.includes(row))) P.fail('CONTINUITY_INVALID_HISTORY_GUARD',503);
    }
    if (rows.length>20 || new Set(rows.map(r => String(r.id))).size!==rows.length) P.fail('CONTINUITY_INVALID_RESULT',503);
    for (const row of rows) {
      if (Number(row.text_bytes)>MAX_TEXT_BYTES) P.fail('CONTINUITY_TEXT_TOO_LARGE',413);
      const time=new Date(row.timestamp).getTime();
      if (!sameIdentity(row,scope) || !realResult(row) || !['incoming','outgoing'].includes(row.direction) ||
        (row.direction==='outgoing' && !confirmed(row.status)) || typeof row.message_body!=='string' ||
        !row.message_body.trim() || !/^\d+$/.test(String(row.id)) ||
        Buffer.byteLength(row.message_body,'utf8')!==Number(row.text_bytes) ||
        row.message_id===anchor.message_id || String(row.id)===String(anchor.id) ||
        !Number.isFinite(time) || time<received-WINDOW_MS || time>received) P.fail('CONTINUITY_INVALID_RESULT',503);
    }
    const dto=bounded({ok:true,schema:'alekito.continuity.v2',request_id:binding.request_id,ingress_ref:binding.ingress_ref,
      account_ref:scope.account_ref,contact_ref:scope.contact_ref,conversation_ref:scope.conversation_ref,
      received_at:origin.received_at,expires_at:origin.expires_at,window_hours:24,max_messages:20,
      max_text_bytes:MAX_TEXT_BYTES,max_dto_bytes:MAX_DTO_BYTES,
      messages:rows.slice().reverse().map(r => ({role:r.direction==='incoming'?'user':'assistant',text:r.message_body,
        date:new Date(r.timestamp).toISOString(),delivery_status:r.direction==='outgoing'?r.status:null})),
      side_effects:false,dispatched:false});
    if (rows.length) {
      const latest=await query(RECHECK_SQL,[scope.wa,scope.contact,rows.map(r => String(r.id))]);
      const byId=new Map(latest.map(r => [String(r.id),r]));
      if (latest.length!==rows.length || byId.size!==rows.length) P.fail('CONTINUITY_HISTORY_CHANGED',409);
      for (const [i,row] of rows.slice().reverse().entries()) {
        const current=byId.get(String(row.id));
        if (!current || !sameIdentity(current,scope) || !realResult(current) || current.direction!==row.direction ||
          (row.direction==='outgoing' && !confirmed(current.status))) P.fail('CONTINUITY_HISTORY_CHANGED',409);
        dto.messages[i].delivery_status=row.direction==='outgoing'?current.status:null;
      }
    }
    const current=await verifyOwnerIngress(binding),currentScope=scopeFor(await resolveOwnerIdentity());
    validateOrigin(current,binding,currentScope,now());
    if (currentScope.wa!==scope.wa || currentScope.contact!==scope.contact || current.received_at!==origin.received_at ||
      current.expires_at!==origin.expires_at) P.fail('CONTINUITY_SCOPE_CHANGED',403);
    return bounded(dto);
  }
  return Object.freeze({read});
}
module.exports={createOwnerContinuityReader};
