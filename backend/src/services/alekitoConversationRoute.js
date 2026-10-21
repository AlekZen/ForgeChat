'use strict';
// REVIEW ONLY. No HTTP transport, auth binding, production ledger or live switch.
const { createHash } = require('node:crypto');
const VERSION = 'alekito-conversation-v1';
const DEFAULT_POLICY = Object.freeze({ mode: 'legacy' });
const MAX_REPLY = 4096;
const MAX_TIMEOUT = 30000;
const OMITTED = Object.freeze(['history','memory','structured','nexus','account_context',
  'conversation_context','role','stage','contact_name','owner_assistance','original_request']);
const sha = value => createHash('sha256').update(String(value)).digest('hex');
class ReviewRouteError extends Error {
  constructor(code) { super(code); this.name='ReviewRouteError'; this.code=code; }
}
function stop(code) { throw new ReviewRouteError(code); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value==='object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fullIdentity(payload) {
  if (!payload || !/^\d{7,16}$/.test(payload.wa_number || '') || !/^\d{7,16}$/.test(payload.contact_number || '') ||
      typeof payload.message_id!=='string' || !payload.message_id || payload.message_id.length>1024) stop('ORIGIN_RECORD_REQUIRED');
  const ref=`c_${sha(`${payload.wa_number}\0${payload.contact_number}`).slice(0,12)}`;
  if (payload.contact_ref!==ref) stop('CONTACT_IDENTITY_MISMATCH');
  return ref;
}
function mapLegacyV2ToFacade(payload) {
  if (payload?.contract_version!==2 || payload.channel!=='whatsapp' || payload.message_type!=='text') stop('LEGACY_TEXT_V2_REQUIRED');
  if ((payload.input_mode && payload.input_mode!=='standard') || payload.owner_assistance || payload.owner_message_id || payload.failure_id) stop('OWNER_ASSISTANCE_NOT_MAPPED');
  fullIdentity(payload);
  if (typeof payload.text!=='string' || !payload.text.trim() || payload.text.length>16000 || payload.text.includes('\0')) stop('INVALID_TEXT');
  if (typeof payload.nexus_sello!=='string' || !payload.nexus_sello || payload.nexus_sello.length>16384 || /[\r\n\0]/.test(payload.nexus_sello) || payload.nexus_sello.trim()!==payload.nexus_sello) stop('SEAL_REQUIRED');
  const conversation=sha(`${payload.wa_number}\0${payload.contact_number}`);
  const message=sha(payload.message_id);
  const request=Object.freeze({
    contract_version:VERSION,
    request_id:`req_${sha(`${VERSION}\0${conversation}\0${payload.message_id}`)}`,
    message_ref:`msg_${message}`,
    conversation_ref:`conv_${conversation}`,
    nexus_sello:payload.nexus_sello,
    input:Object.freeze({type:'text',text:payload.text}),
    reply_owner:'forgechat'
  });
  // Seal is forwarded byte-for-byte, never decoded, logged, persisted or re-signed.
  // Signature and current permissions MUST be verified in the future server binding.
  return Object.freeze({request,compatibility:'partial-standard-text-only',
    omitted_fields:Object.freeze(OMITTED.filter(k=>payload[k]!==undefined))});
}
function semanticDigest(request) {
  // A fresh seal must not turn a retry of the same message/content into a new turn.
  const {nexus_sello,...semantic}=request;
  return sha(stable(semantic));
}
function protectedOutput(result,parse,requestId) {
  let parsed;
  try { parsed=parse(result,requestId); } catch { stop('INVALID_RESPONSE'); }
  if (parsed.status==='completed') {
    if (parsed.reply.text.length>MAX_REPLY || /\bv1\.c_[A-Za-z0-9]+\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+|\b(?:nxa_|plane_api_|cfut_)[A-Za-z0-9_-]+|Bearer\s+\S+/i.test(parsed.reply.text)) stop('UNSAFE_REPLY');
  }
  return parsed;
}
function outcome(status,publicCode=null,extras={}) {
  return {selected:true,status,public_code:publicCode,legacyOutput:null,
    retryPost:false,fallbackToLegacy:false,maySend:false,...extras};
}
async function runHermeticReview({caller,buildPayload,policy,binding}) {
  // These labels are NOT security boundaries. Only the audited fixtures included
  // in tests are asserted hermetic; arbitrary injected dependencies could do I/O.
  if (binding?.kind!=='hermetic-fixture' || typeof binding.invoke!=='function' ||
      typeof binding.parseRequest!=='function' || typeof binding.parseResult!=='function' ||
      typeof binding.ledger?.reserve!=='function' || typeof binding.ledger?.complete!=='function' ||
      typeof binding.ledger?.uncertain!=='function') return outcome('rejected','NOT_BOUND');
  // The three-field Brain input cannot be upgraded by inventing an origin/seal.
  if (caller!=='legacy-v2') return outcome('rejected','BRAIN_ORIGIN_CONTRACT_NOT_MAPPED');
  const timeout=policy.timeoutMs ?? 20000;
  if (!Number.isInteger(timeout) || timeout<1 || timeout>MAX_TIMEOUT) return outcome('rejected','INVALID_TIMEOUT');
  let mapped,request,digest;
  try {
    const payload=buildPayload();
    fullIdentity(payload);
    if (!Array.isArray(policy.contactRefs) || !policy.contactRefs.includes(payload.contact_ref)) return outcome('rejected','CONTACT_NOT_SELECTED');
    mapped=mapLegacyV2ToFacade(payload);
    request=binding.parseRequest(mapped.request);
    digest=semanticDigest(request);
  } catch(error) { return outcome('rejected',error instanceof ReviewRouteError?error.code:'INVALID_CONTRACT'); }
  let reservation;
  try { reservation=await binding.ledger.reserve({request_id:request.request_id,message_ref:request.message_ref,
    conversation_ref:request.conversation_ref,digest}); }
  catch { return outcome('unknown','LEDGER_UNAVAILABLE'); }
  if (reservation?.kind==='conflict') return outcome('rejected','IDEMPOTENCY_CONFLICT');
  if (reservation?.kind==='existing') {
    if (!reservation.result) return outcome('unknown','RECONCILIATION_REQUIRED',{request_id:request.request_id,replay:true});
    try {
      const result=protectedOutput(reservation.result,binding.parseResult,request.request_id);
      return resultOutcome(result,mapped,true);
    } catch(error) { return outcome('unknown',error.code||'INVALID_RESPONSE',{request_id:request.request_id,replay:true}); }
  }
  if (reservation?.kind!=='reserved') return outcome('unknown','LEDGER_RESERVATION_UNVERIFIED');
  let timer;const controller=new AbortController();
  try {
    const raw=await Promise.race([
      Promise.resolve().then(()=>binding.invoke(request,{signal:controller.signal})),
      new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ReviewRouteError('TIMEOUT'));},timeout);})
    ]);
    const result=protectedOutput(raw,binding.parseResult,request.request_id);
    await binding.ledger.complete(request.request_id,result);
    return resultOutcome(result,mapped,false);
  } catch(error) {
    const code=error instanceof ReviewRouteError?error.code:'TRANSPORT_UNKNOWN';
    try { await binding.ledger.uncertain(request.request_id,code); } catch { /* Never re-dispatch. */ }
    return outcome('unknown',code,{request_id:request.request_id});
  } finally {clearTimeout(timer);}
}
function resultOutcome(result,mapped,replay) {
  // Compatibility preview only. No send, action execution, role or force_actor.
  const completed=result.status==='completed';
  return outcome(result.status,result.public_code||null,{request_id:result.request_id,
    operation_ref:result.operation_ref,replay,compatibility:mapped.compatibility,omitted_fields:mapped.omitted_fields,
    maySend:completed,legacyOutput:completed?{reply:result.reply.text}:null});
}
async function maybeUseAlekitoConversation({caller,buildPayload},policy=DEFAULT_POLICY,binding=null) {
  if (policy?.mode==='legacy') return {selected:false,reason:'LEGACY_UNCHANGED'};
  // Live mode intentionally has NO implementation or binding in this diff.
  if (policy?.mode!=='hermetic-review') return outcome('rejected','LIVE_BINDING_NOT_IMPLEMENTED');
  return runHermeticReview({caller,buildPayload,policy,binding});
}
module.exports={DEFAULT_POLICY,ReviewRouteError,mapLegacyV2ToFacade,semanticDigest,maybeUseAlekitoConversation};
