'use strict';
const dns = require('node:dns').promises;
const crypto = require('node:crypto');
const pool = require('../db');
const { getAccountByPhoneNumber } = require('../routes/whatsappAccounts');
const { insertPendingRow } = require('./messageSender');
const { enqueueSend, sendQueue } = require('../queue/sendQueue');
const P = require('./alekitoBridgePolicy');
const {templateUiMetadata}=require('./alekitoTemplateUiMetadata');
const {createNexusBinding}=require('./alekitoNexusBinding');
const {envelopeForIngress,validateProtocolResponse,parseWrapperResult}=require('./alekitoConversationProtocol');
const {normalizeButtonIngress,ButtonIngressError}=require('./alekitoButtonIngress');
const {createButtonSourceResolver}=require('./alekitoButtonSource');
const {createBetaConsent,protocolForReceipt,POLICY:BETA_POLICY}=require('./alekitoBetaConsent');
const {createNotificationOptout}=require('./alekitoNotificationOptout');
const notificationPolicy=require('./alekitoNotificationPolicy');
let notificationOptout;
function updatePreferences(){if(!notificationOptout)notificationOptout=createNotificationOptout({pool,policy:notificationPolicy,
 verifyIngress:verifyOwnerIngress,verifyExisting:verifyExistingTurn,ownerAccount,ownerCanonical:OWNER_CANONICAL});return notificationOptout;}
function proofFromOrigin(origin){return Object.fromEntries(['ingress_ref','message_ref','request_id','account_ref','digest'].map(k=>[k,origin[k]]));}
async function resolveSystemResult({origin}){
 const beta=await resolveBetaResult({origin});if(beta)return beta;
 if(!updatePreferences().isPauseInput(origin))return null;
 const binding=await ownerAccount(),row=await findOwnerIngressRow(binding,{messageRef:origin.message_ref,ingressRef:origin.ingress_ref});
 await eligibleIngress(row,OWNER_REF);await ownership().assertCanary(row);
 return updatePreferences().consume({origin,proof:proofFromOrigin(origin),row});
}
async function validateStoredSystemResult(args){return updatePreferences().validateResult(args);}
async function withOwnerNotificationEgress(args,send){return updatePreferences().withOwnerEgress(args,send);}
let betaConsent;
async function resolveBetaResult({origin}){
  const betaMatch=/^alekito_bridge:(alekito-(?:owner-)?beta-[A-Za-z0-9._-]+):[01]$/.exec(origin.input?.button_payload||'');
  if(!betaMatch)return null;
  const dynamicPolicy={...BETA_POLICY,invitation:betaMatch[1]};
  const binding=await ownerAccount();
  const row=await findOwnerIngressRow(binding,{messageRef:origin.message_ref,ingressRef:origin.ingress_ref});
  await eligibleIngress(row,OWNER_REF);await ownership().assertCanary(row);
  const resolve=createButtonSourceResolver({pool,readSpecs:metaSpecs,hashSchema:components=>P.hash(P.stable(P.cleanSpec(components))),checkDispatch:validateBridgeDispatch});
  const normalizedButton=await normalizeButtonIngress(row,{wa:binding.wa,owner:binding.owner,accountRef:ACCOUNT_REF,ownerRef:OWNER_REF,resolveSource:args=>resolve(binding,args)});
  const receipt=await createBetaConsent({pool,policy:dynamicPolicy}).consume({row,binding,normalizedButton});
  return receipt?protocolForReceipt(receipt,origin):null;
}
async function ownerEnvelopeForIngress(row,binding,options){
  await require('./alekitoEngagementTelemetry.cjs').recordContactEngagement(pool,row).catch(()=>null);
  let normalizedButton=null;
  if(['audio','voice','image','video','document','location','contacts'].includes(row.message_type)){
    const {leerMedio,componerMensajeConLectura,tipoDeLectura}=require('./mediaUnderstanding');
    const {leerDocumento}=require('./documentUnderstanding');
    let composed='';
    const tipo=tipoDeLectura(row.message_type);
    if(tipo){
      let lecturaText=typeof row.media_lectura==='string'&&row.media_lectura.trim()?row.media_lectura.trim():'';
      let lecturaObj=lecturaText?{ok:true,tipo,texto:lecturaText}:null;
      if(!lecturaObj){
        lecturaObj=tipo==='documento'
          ? await leerDocumento({record:row}).catch(()=>({ok:false,tipo:'documento'}))
          : await leerMedio({record:row,contexto:'Mensaje de Alek (dueño) para Alekito'}).catch(()=>({ok:false,tipo}));
      }
      composed=componerMensajeConLectura({record:row,lectura:lecturaObj});
      if(!composed){
        const fname=row.media_filename||row.message_body||row.message_type;
        composed=`[${tipo} recibido: ${fname}]`;
      }
    }else if(row.message_type==='location'){
      const loc=row.raw_payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.location||{};
      composed=`[Ubicación compartida: ${loc.name||''} ${loc.address||''} (${loc.latitude||''}, ${loc.longitude||''})]`.trim();
    }else if(row.message_type==='contacts'){
      const cts=row.raw_payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.contacts||[];
      composed=`[Contacto compartido: ${cts.map(c=>c.name?.formatted_name||c.phones?.[0]?.phone||'contacto').join(', ')}]`;
    }
    row={...row,message_type:'text',message_body:composed||String(row.message_body||'Mensaje multimedia')};
  }else if(row.message_type!=='text'){
    try{
      const resolve=createButtonSourceResolver({pool,readSpecs:metaSpecs,hashSchema:components=>P.hash(P.stable(P.cleanSpec(components))),checkDispatch:validateBridgeDispatch});
      normalizedButton=await normalizeButtonIngress(row,{wa:binding.wa,owner:binding.owner,accountRef:ACCOUNT_REF,ownerRef:OWNER_REF,resolveSource:args=>resolve(binding,args)});
    }catch(error){
      if(row.message_type==='interactive'){
        row={...row,message_type:'text',message_body:String(row.message_body||'Opción seleccionada')};
      }else{
        if(error instanceof ButtonIngressError)P.fail(error.code,error.status);throw error;
      }
    }
  }
  let quotedPrefix='';
  if(row.context_message_id){
    const parent=(await pool.query('SELECT message_body,media_lectura FROM coexistence.chat_history WHERE message_id=$1 LIMIT 1',[row.context_message_id]).catch(()=>({rows:[]}))).rows[0];
    const parentText=String(parent?.message_body||parent?.media_lectura||'').replace(/\s+/g,' ').trim();
    if(parentText)quotedPrefix=`[En respuesta directa al mensaje: «${parentText.slice(0,320)}»]\n`;
  }
  return envelopeForIngress(row,{...options,normalizedButton,quotedPrefix});
}
const {createTurnApi}=require('./alekitoTurnApi');
const {createConversationDelivery}=require('./alekitoConversationDelivery');
const {createTurnLedger}=require('./alekitoTurnLedger');
const {createInboundOwnership}=require('./alekitoInboundOwnership');
const {createOwnerContinuityReader}=require('./alekitoContinuity');

const OWNER_REF = 'c_74634837c171';
const ACCOUNT_REF = 'af6adeb5076b';
const OWNER_CANONICAL = '5213322638033';
const TABLE = 'coexistence.alekito_bridge_requests';
const OWN_TABLE = 'coexistence.alekito_inbound_ownership';
const WRAPPER_ORIGIN = 'https://n8n.geekstudio.dev';
const WRAPPER_PATHNAME = '/webhook/alekito-owner-conversation-v1';
const DEFAULT_WRAPPER_URL = `${WRAPPER_ORIGIN}${WRAPPER_PATHNAME}`;
const WRAPPER_TIMEOUT_MS = 60000;
const DISPATCH_GRACE_MS = 65000;
const ALLOWED_OWNERSHIP_FROM = Object.freeze({
  dispatching: ['pending'],
  uncertain: ['pending', 'dispatching', 'claimed', 'uncertain'],
  claimed: ['dispatching', 'uncertain', 'claimed'],
  queued: ['dispatching', 'uncertain', 'claimed', 'queued'],
  accepted: ['dispatching', 'uncertain', 'claimed', 'queued', 'accepted'],
  completed: ['dispatching', 'uncertain', 'claimed', 'queued', 'accepted'],
  failed: ['dispatching', 'uncertain', 'claimed', 'queued', 'accepted'],
  blocked: ['pending', 'dispatching', 'claimed', 'uncertain'],
  expired: ['pending', 'dispatching', 'claimed', 'queued', 'accepted', 'uncertain'],
});
function resolveWrapperUrl(rawUrl = process.env.ALEKITO_WRAPPER_WEBHOOK_URL ?? DEFAULT_WRAPPER_URL) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl !== rawUrl.trim()) return null;
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.origin !== WRAPPER_ORIGIN || parsed.hostname !== 'n8n.geekstudio.dev' ||
      parsed.port !== '' || parsed.pathname !== WRAPPER_PATHNAME || parsed.username !== '' ||
      parsed.password !== '' || parsed.search !== '' || parsed.hash !== '' || parsed.href !== DEFAULT_WRAPPER_URL) return null;
  return DEFAULT_WRAPPER_URL;
}
let ready, timer, catalogCache, nexusBinding;
let turnApiPromise;
let deliveryPromise;
let inboundOwnership;
let ownerContinuityReader;
let ownerWorkerPromise = null, ownerWorkerPending = false, ownerDispatchPaused = false, ownerWorkerStopped = false;
function isOwnerDispatchPaused(){
  return ownerDispatchPaused||process.env.ALEKITO_OWNER_DISPATCH_PAUSED==='1'||process.env.ALEKITO_OWNER_DISPATCH_PAUSED==='true';
}
function ownership(){if(!inboundOwnership)inboundOwnership=createInboundOwnership({pool,waNumber:process.env.IA360_BUSINESS_WA_NUMBER,
  ownerNumber:OWNER_CANONICAL,accountRef:ACCOUNT_REF,ownerRef:OWNER_REF,isPaused:isOwnerDispatchPaused});return inboundOwnership;}
async function claimInboundProducer(db,record){return ownership().claim({db,record});}
function nexus(){if(!nexusBinding)nexusBinding=createNexusBinding();return nexusBinding;}
function nexusFault(state,status){const details=Object.fromEntries(['remote_code','stage','error_origin','response_source','http_status','rpc_code'].filter(k=>state[k]!==undefined).map(k=>[k,state[k]]));P.fail(state.public_code,status,details);}
async function nexusStatus(){const state=await nexus().probe();if(!state.ok)nexusFault(state,503);return {ok:true,schema:'alekito.nexus-status.v2',surface:state.surface,read_only:true};}
async function ownerContinuity(body){
  if(!ownerContinuityReader)ownerContinuityReader=createOwnerContinuityReader({db:pool,verifyOwnerIngress,
    filterHistory:require('./humanReadRuntime.cjs').createHistoryGuard(pool).filter,
    resolveOwnerIdentity:async()=>{const {wa,owner}=await ownerAccount();return {wa_number:wa,contact_number:owner};}});
  return ownerContinuityReader.read(body);
}
async function currentTurnAuthorization(origin){
  await ownerAccount();
  if(origin.contact_ref!==OWNER_REF||origin.account_ref!==ACCOUNT_REF)P.fail('OWNER_PERMISSION_REQUIRED',403);
  const rows=(await pool.query(`SELECT account_key,rol FROM coexistence.ia360_contact_scope WHERE contact_number=$1 AND activo=true AND rol='owner' ORDER BY account_key,rol`,[OWNER_CANONICAL])).rows;
  if(!rows.length)P.fail('OWNER_PERMISSION_REQUIRED',403);
  return {digest:P.hash(P.stable({operation:'conversation.reply',account_ref:ACCOUNT_REF,contact_ref:OWNER_REF,individual_owner_grants:rows}))};
}
async function verifyExistingTurn(body){
  const binding=await ownerAccount();
  if(body.account_ref!==ACCOUNT_REF)P.fail('INGRESS_BINDING_MISMATCH',403);
  const conversationRef=`conv_${P.hash(`${binding.wa}\0${binding.owner}`)}`;
  const row=(await pool.query(`SELECT request_id,message_ref,ingress_ref,account_ref,content_digest FROM coexistence.alekito_conversation_turns
    WHERE request_id=$1 AND conversation_ref=$2 AND contact_ref=$3`,[body.request_id,conversationRef,OWNER_REF])).rows[0];
  if(!row)P.fail('REQUEST_NOT_FOUND',404);
  if(row.message_ref!==body.message_ref||row.ingress_ref!==body.ingress_ref||row.account_ref!==body.account_ref)P.fail('INGRESS_BINDING_MISMATCH',403);
  if(row.content_digest!==body.digest)P.fail('IDEMPOTENCY_CONFLICT',409);
  return {verified:true,request_id:row.request_id,message_ref:row.message_ref,account_ref:ACCOUNT_REF,contact_ref:OWNER_REF,
    conversation_ref:conversationRef,digest:row.content_digest};
}
async function turns(){if(!turnApiPromise)turnApiPromise=import('./conversation-contract.mjs').then(({parseConversationResult})=>createTurnApi({
  db:pool,verifyIngress:verifyOwnerIngress,verifyExisting:verifyExistingTurn,currentAuthorization:currentTurnAuthorization,parseResult:parseConversationResult,systemResult:resolveSystemResult,validateStoredSystemResult}));return turnApiPromise;}
async function reserveTurn(body){return (await turns()).reserve(body);}
async function completeTurn(body){return (await turns()).complete(body);}
async function turnScope(body){const origin=await verifyExistingTurn(body),authorization=await currentTurnAuthorization(origin);return {request_id:origin.request_id,
  message_ref:origin.message_ref,conversation_ref:origin.conversation_ref,contact_ref:origin.contact_ref,digest:origin.digest,authorization_digest:authorization.digest};}
async function findOwnerIngressRow(binding, { messageId = null, messageRef = null, ingressRef = null } = {}) {
  let targetId = messageId;
  if (!targetId && messageRef) {
    const own = (await pool.query(`SELECT message_id FROM ${OWN_TABLE} WHERE account_ref=$1 AND message_ref=$2 LIMIT 1`, [ACCOUNT_REF, messageRef]).catch(() => ({ rows: [] }))).rows[0];
    if (own?.message_id) targetId = own.message_id;
  }
  if (targetId) {
    const exactRows = (await pool.query(`SELECT message_id,wa_number,contact_number,direction,timestamp,raw_payload,message_body,media_lectura,media_mime_type,media_filename,media_size_bytes,message_type,context_message_id FROM coexistence.chat_history
      WHERE wa_number=$1 AND contact_number=$2 AND direction='incoming' AND message_id=$3 LIMIT 2`, [binding.wa, binding.owner, targetId])).rows;
    if (exactRows.length === 1) return exactRows[0];
  }
  const recent = (await pool.query(`SELECT message_id,wa_number,contact_number,direction,timestamp,raw_payload,message_body,media_lectura,message_type,context_message_id FROM coexistence.chat_history
    WHERE wa_number=$1 AND contact_number=$2 AND direction='incoming' ORDER BY timestamp DESC LIMIT 50`, [binding.wa, binding.owner])).rows;
  if (targetId) return recent.find(r => r.message_id === targetId);
  if (ingressRef) return recent.find(r => P.ingressRef(r.message_id) === ingressRef);
  if (messageRef) return recent.find(r => `msg_${P.hash(r.message_id)}` === messageRef);
  return undefined;
}
async function markOwnershipState(messageRef, dispatchState, errorCode = null, allowedFrom = ALLOWED_OWNERSHIP_FROM[dispatchState]) {
  const fromStates = Array.isArray(allowedFrom) && allowedFrom.length ? allowedFrom : (ALLOWED_OWNERSHIP_FROM[dispatchState] || []);
  const res = await pool.query(`UPDATE ${OWN_TABLE} SET dispatch_state=$3,error_code=$4,updated_at=now()
    WHERE account_ref=$1 AND message_ref=$2 AND dispatch_state = ANY($5::text[]) RETURNING *`,
    [ACCOUNT_REF, messageRef, dispatchState, errorCode, fromStates]);
  return res.rows[0] || null;
}
async function turnStatus(body){
  const api=await turns(),receipt=await api.status(body),scope=await turnScope(body),row=await api.ledger.get(scope);
  if(!row.correlation_id){
    const claimed=receipt.delivery_state==='claimed';
    return {...receipt,claimed,queued:false,provider_accepted:false,accepted:false,effective_receipt:false};
  }
  const entries=(await pool.query(`SELECT status FROM coexistence.chat_history WHERE send_correlation_id=$1 AND direction='outgoing' AND wa_number=$2 AND contact_number=$3 LIMIT 2`,[row.correlation_id,P.digits(process.env.IA360_BUSINESS_WA_NUMBER),OWNER_CANONICAL])).rows;
  if(entries.length!==1){
    const claimed=receipt.delivery_state==='claimed';
    return {...receipt,claimed,queued:false,provider_accepted:false,accepted:false,effective_receipt:false,reconciliation_required:true,provider_state:'unconfirmed'};
  }
  const state=entries[0].status;
  if(['delivered','read','failed','error'].includes(state)){
    const target=state==='error'?'failed':state;
    if(row.delivery_state!==target&&!(row.delivery_state==='read')&&!(row.delivery_state==='delivered'&&target==='failed')){
      await api.ledger.observeDelivery(scope,{state:target,correlation_id:row.correlation_id});
    }
  }
  const latest=await api.status(body);
  const claimed=latest.delivery_state==='claimed';
  const failed=latest.delivery_state==='failed'||['failed','error'].includes(state);
  const queued=!failed&&['queued','delivered','read'].includes(latest.delivery_state)&&['pending','sent','delivered','read'].includes(state);
  const providerAccepted=!failed&&['sent','delivered','read'].includes(state)&&['queued','delivered','read'].includes(latest.delivery_state);
  const effectiveReceipt=!failed&&['delivered','read'].includes(state)&&['delivered','read'].includes(latest.delivery_state);
  const reconciliationRequired=state==='no_verificable'||latest.delivery_state==='uncertain'||claimed;
  if(effectiveReceipt)await markOwnershipState(scope.message_ref,'completed',null);
  else if(failed)await markOwnershipState(scope.message_ref,'failed',latest.public_code||'DELIVERY_FAILED');
  else if(providerAccepted)await markOwnershipState(scope.message_ref,'accepted',null);
  else if(queued)await markOwnershipState(scope.message_ref,'queued',null);
  return {...latest,provider_state:state,claimed,queued,provider_accepted:providerAccepted,accepted:providerAccepted,effective_receipt:effectiveReceipt,reconciliation_required:reconciliationRequired};
}
async function loadConversationDelivery(body){
  const scope=await turnScope(body),binding=await ownerAccount(),api=await turns(),row=await api.ledger.get(scope);
  if(!row||row.state!=='completed'||row.response_json?.reply?.type!=='text')P.fail('TURN_REPLY_NOT_COMPLETED',409);
  const origin=await findOwnerIngressRow(binding,{messageRef:row.message_ref,ingressRef:body.ingress_ref});
  if(origin&&P.ingressRef(origin.message_id)!==body.ingress_ref)P.fail('INGRESS_BINDING_MISMATCH',403);
  await eligibleIngress(origin,OWNER_REF);
  await ownership().assertCanary({...origin,message_type:'text'});
  if(`msg_${P.hash(origin.message_id)}`!==row.message_ref)P.fail('INGRESS_BINDING_MISMATCH',403);
  const nativePauseReply=await validateStoredSystemResult({origin:await verifyExistingTurn(body),proof:body,protocol:row.protocol_response});
  const dynInv=/^alekito_bridge:(alekito-(?:owner-)?beta-[A-Za-z0-9._-]+):[01]$/.exec(origin.input?.button_payload||'')?.[1]||BETA_POLICY.invitation;
  const nativeBetaReply=nativePauseReply?false:await require('./storedPublicReceipt.cjs').createStoredPublicReceiptVerifier({db:pool,policy:{...BETA_POLICY,invitation:dynInv},replies:require('./alekitoBetaConsent').REPLIES}).verify({proof:body,origin,protocol:row.protocol_response});
  if(!nativePauseReply&&!nativeBetaReply)await require('./humanReadRuntime.cjs').createHistoryGuard(pool).assertTurnPolicy({proof:body,allowUnlinked:true});
  return {scope,binding,row,origin,correlation:`ak_${P.hash(scope.request_id)}`};
}
async function loadConversationJob(id){
  const row=(await pool.query('SELECT request_id,message_ref,ingress_ref,account_ref,content_digest FROM coexistence.alekito_conversation_turns WHERE request_id=$1',[id])).rows[0];
  if(!row)P.fail('REQUEST_NOT_FOUND',404);
  return loadConversationDelivery({request_id:row.request_id,message_ref:row.message_ref,ingress_ref:row.ingress_ref,account_ref:row.account_ref,digest:row.content_digest});
}
async function deliveries(){if(!deliveryPromise)deliveryPromise=Promise.all([turns(),import('./conversation-contract.mjs')]).then(([api,{parseConversationResult}])=>createConversationDelivery({
  pool,load:loadConversationDelivery,loadJob:loadConversationJob,ledger:api.ledger,transactionLedger:db=>createTurnLedger({db,parseResult:parseConversationResult}),insertPendingRow,enqueueSend}));return deliveryPromise;}
async function deliverTurn(body){P.exact(body,['ingress_ref','message_ref','request_id','account_ref','digest']);const result=await (await deliveries()).send(body);
  return {...await turnStatus(body),schema:'alekito.turn-delivery.v1',delivery_replay:result.replay,
    side_effects:!result.replay,dispatched:result.row.delivery_state==='uncertain'?null:!!result.row.correlation_id};}
async function validateConversationDispatch(job){return (await deliveries()).validate(job);}

async function ensureBridgeTable() {
  if (!ready) ready = pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    request_id text PRIMARY KEY, payload_digest text NOT NULL CHECK(length(payload_digest)=64),
    template_id integer NOT NULL, template_name text NOT NULL, template_language text NOT NULL,
    account_id bigint NOT NULL, owner_ref text NOT NULL, correlation_id text UNIQUE NOT NULL,
    template_schema_digest text NOT NULL,
    state text NOT NULL CHECK(state IN ('prepared','dispatching','queued','uncertain')),
    job_payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), dispatch_started_at timestamptz,
    error_code text
  )`).catch(err => { ready = null; throw err; });
  return ready;
}
async function internalAuthorized(req) {
  const secret = process.env.IA360_DIRECTIVE_SECRET;
  const value = req.get('X-IA360-Directive-Secret');
  if (!secret || typeof value !== 'string' || value.length > 512) return false;
  const a = Buffer.from(secret), b = Buffer.from(value);
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return false;
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/,'');
  // Never trust X-Forwarded-For or an RFC1918 prefix. Only the actual n8n peer,
  // plus this container's loopback for authenticated diagnostics, is accepted.
  if (peer === '127.0.0.1' || peer === '::1') return true;
  try { return (await dns.lookup('n8n', { all:true })).some(x => x.address.replace(/^::ffff:/,'') === peer); }
  catch { return false; }
}
async function ownerAccount() {
  const wa = P.digits(process.env.IA360_BUSINESS_WA_NUMBER);
  const owner = P.digits(process.env.IA360_OWNER_NUMBER || OWNER_CANONICAL);
  if (P.hash(wa).slice(0,12) !== ACCOUNT_REF || P.contactRef(wa,owner) !== OWNER_REF) P.fail('OWNER_BINDING_INVALID',503);
  const account = await getAccountByPhoneNumber(wa);
  if (!account || !account.isActive || !account.accessToken || P.digits(account.displayPhoneNumber) !== wa) P.fail('ACCOUNT_UNAVAILABLE',503);
  const result = await pool.query(`SELECT c.id FROM coexistence.contacts c
    WHERE c.wa_number=$1 AND c.contact_number=$2
    AND EXISTS (SELECT 1 FROM coexistence.ia360_contact_scope s WHERE s.contact_number=c.contact_number AND s.activo=true AND s.rol='owner')`,[wa,owner]);
  if (result.rows.length !== 1) P.fail('OWNER_PERMISSION_REQUIRED',403);
  return { account, wa, owner, owner_ref:OWNER_REF, account_ref:ACCOUNT_REF };
}
async function graph(account, path, query = {}) {
  const version = process.env.META_API_VERSION || 'v21.0';
  if (!/^v\d+\.\d+$/.test(version) || !/^[0-9]+$/.test(String(path))) P.fail('PROVIDER_CONFIG_INVALID',503);
  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [key,value] of Object.entries(query)) url.searchParams.set(key,value);
  let response, data;
  try {
    response = await fetch(url,{headers:{Authorization:`Bearer ${account.accessToken}`},signal:AbortSignal.timeout(12000),redirect:'error'});
    data = await response.json();
  } catch { P.fail('PROVIDER_READ_UNAVAILABLE',502); }
  if (!response.ok || !data || data.error) P.fail('PROVIDER_READ_UNAVAILABLE',502);
  return data;
}
async function metaSpecs(account, force = false) {
  if (!force && catalogCache && catalogCache.accountId === account.id && Date.now()-catalogCache.at < 60000) return catalogCache.specs;
  const specs = []; let after;
  for (let page=0; page<20; page++) {
    // Use cursor data, never follow provider paging.next URLs containing tokens.
    const url = new URL(`https://graph.facebook.com/${process.env.META_API_VERSION || 'v21.0'}/${encodeURIComponent(account.wabaId)}/message_templates`);
    url.searchParams.set('fields','id,name,language,status,category,components,parameter_format');
    url.searchParams.set('limit','100'); if (after) url.searchParams.set('after',after);
    let response, data;
    try { response=await fetch(url,{headers:{Authorization:`Bearer ${account.accessToken}`},signal:AbortSignal.timeout(12000),redirect:'error'}); data=await response.json(); }
    catch { P.fail('TEMPLATE_AUTHORITY_UNAVAILABLE',502); }
    if (!response.ok || !Array.isArray(data?.data) || data.error) P.fail('TEMPLATE_AUTHORITY_UNAVAILABLE',502);
    specs.push(...data.data);
    if (!data.paging?.next) { catalogCache={accountId:account.id,at:Date.now(),specs}; return specs; }
    const next = data.paging?.cursors?.after;
    if (typeof next !== 'string' || next.length>2048 || next===after) P.fail('TEMPLATE_PAGINATION_INVALID',502);
    after=next;
  }
  P.fail('TEMPLATE_CATALOG_TOO_LARGE',502);
}
async function localTemplates(account) {
  const {rows}=await pool.query(`SELECT id,name,language,status,category,meta_template_id FROM coexistence.message_templates
    WHERE whatsapp_account_id=$1 AND status='APPROVED' ORDER BY id`,[account.id]); return rows;
}
function expose(local,spec) {
  return {template_id:local.id,name:local.name,language:local.language,category:spec?.category || local.category,status:spec?.status || null,
    authority:spec?'meta':'unavailable',eligible:!!spec && spec.status==='APPROVED',
    parameter_format:spec?.parameter_format || 'POSITIONAL',
    components:spec?P.cleanSpec(spec.components):[],requirements:spec?P.requirements(spec.components):[],
    schema_digest:spec?P.hash(P.stable(P.cleanSpec(spec.components))):null};
}
async function catalog() {
  const {account}=await ownerAccount(); const [locals,specs]=await Promise.all([localTemplates(account),metaSpecs(account)]);
  const templates=locals.map(local=>expose(local,specs.find(s=>s.name===local.name && s.language===local.language)));
  return {ok:true,schema:'alekito.templates.v1',account_ref:ACCOUNT_REF,owner_ref:OWNER_REF,total:templates.length,templates,read_only:true,media_input:'Meta media_id only; links and upload handles rejected'};
}
async function validateMedia(account,media) {
  for (const item of media) {
    const data=await graph(account,item.id,{fields:'id,mime_type,file_size'});
    const mime=String(data.mime_type || '').toLowerCase(), size=Number(data.file_size);
    const valid=item.format==='IMAGE' ? ['image/jpeg','image/png'].includes(mime) && size<=5*1024*1024
      :item.format==='VIDEO' ? ['video/mp4','video/3gpp'].includes(mime) && size<=16*1024*1024
      :item.format==='DOCUMENT' ? ['application/pdf','text/plain','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation'].includes(mime) && size<=100*1024*1024:false;
    if (!valid || !Number.isFinite(size) || size<=0 || String(data.id)!==item.id) P.fail('MEDIA_FORMAT_INVALID',422,{format:item.format});
  }
}
async function prepare(normalized) {
  const binding=await ownerAccount(); const locals=await localTemplates(binding.account);
  const local=locals.find(t=>Number(t.id)===normalized.template_id); if(!local) P.fail('APPROVED_TEMPLATE_REQUIRED',422);
  const specs=await metaSpecs(binding.account,true);
  const spec=specs.find(s=>s.name===local.name && s.language===local.language && s.status==='APPROVED' && (!local.meta_template_id || String(s.id)===String(local.meta_template_id)));
  if (!spec) P.fail('LIVE_APPROVED_TEMPLATE_REQUIRED',422);
  const result=P.buildComponents(spec,normalized.parameters,normalized.request_id);
  await validateMedia(binding.account,result.media);
  const schema_digest=P.hash(P.stable(P.cleanSpec(spec.components)));
  const preview_digest=P.hash(P.stable({payload_digest:normalized.digest,schema_digest,components:result.components}));
  if (normalized.preview_digest && normalized.preview_digest!==preview_digest) P.fail('PREVIEW_CHANGED',409);
  return {...binding,local,spec,...result,schema_digest,preview_digest};
}
async function preview(body) {
  const request=P.normalizeRequest(body), plan=await prepare(request);
  return {ok:true,schema:'alekito.preview.v1',request_id:request.request_id,payload_digest:request.digest,preview_digest:plan.preview_digest,
    schema_digest:plan.schema_digest,owner_ref:OWNER_REF,account_ref:ACCOUNT_REF,template:expose(plan.local,plan.spec),
    components:plan.components,rendered_body:plan.rendered_body,rendered_header:plan.rendered_header,would_send:true,effects:false};
}
async function getRequest(requestId) {
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(requestId||'')) P.fail('REQUEST_ID_INVALID');
  await ensureBridgeTable();
  const {rows}=await pool.query(`SELECT * FROM ${TABLE} WHERE request_id=$1`,[requestId]); return rows[0];
}
async function receipt(row,replay=false) {
  const {rows}=await pool.query(`SELECT status,message_id,error_message FROM coexistence.chat_history
    WHERE send_correlation_id=$1 AND direction='outgoing' ORDER BY id LIMIT 2`,[row.correlation_id]);
  if (rows.length!==1) P.fail('RECEIPT_INTEGRITY_ERROR',503);
  const entry=rows[0]; let state=entry.status, queueState=null;
  if (!['sent','delivered','read','failed','error','no_verificable'].includes(state)) {
    try { const job=await sendQueue.getJob(`send-${row.correlation_id}`); queueState=job?await job.getState():null; } catch { queueState='unavailable'; }
    state=row.state==='uncertain' || (row.state==='dispatching' && !queueState) ? 'reconciliation_required' : row.state;
    if (Date.now()-new Date(row.created_at).getTime()>120000 && !['active','waiting','delayed','prioritized'].includes(queueState)) state='reconciliation_required';
  }
  const delivered=['delivered','read'].includes(state), failed=['failed','error','no_verificable'].includes(state);
  return {ok:true,schema:'alekito.owner_template.receipt.v1',request_id:row.request_id,payload_digest:row.payload_digest,
    owner_ref:row.owner_ref,account_ref:ACCOUNT_REF,template_id:row.template_id,template_name:row.template_name,
    correlation_id:row.correlation_id,message_ref:`m_${P.hash(entry.message_id).slice(0,12)}`,state,
    delivered,terminal:delivered || failed,replay,queue_state:queueState,
    error_code:failed?'PROVIDER_SEND_FAILED':row.error_code || (state==='reconciliation_required'?'SEND_OUTCOME_UNCERTAIN':null),
    created_at:row.created_at,updated_at:row.updated_at,retry_post:false,
    next_action:delivered || failed?'none':'GET same request_id; never create a new request to recover a timeout'};
}
async function dispatch(requestId) {
  const {rows}=await pool.query(`UPDATE ${TABLE} SET state='dispatching',dispatch_started_at=now(),updated_at=now()
    WHERE request_id=$1 AND state='prepared' RETURNING *`,[requestId]);
  if (!rows[0]) return;
  try {
    // Revalidate current owner binding and current approval immediately before enqueue.
    const row=rows[0];
    await validateBridgeDispatch(row.job_payload);
    await enqueueSend(row.job_payload);
    await pool.query(`UPDATE ${TABLE} SET state='queued',updated_at=now() WHERE request_id=$1`,[requestId]);
  } catch (err) {
    // Redis timeout is an uncertain outcome. Never call enqueue again for this request.
    await pool.query(`UPDATE ${TABLE} SET state='uncertain',error_code=$2,updated_at=now() WHERE request_id=$1`,[requestId,err instanceof P.BridgeError?err.code:'QUEUE_OUTCOME_UNCERTAIN']);
  }
}
async function sendOwnerTemplate(body) {
  const normalized=P.normalizeRequest(body); let existing=await getRequest(normalized.request_id);
  if (existing) {
    if(existing.payload_digest!==normalized.digest) P.fail('IDEMPOTENCY_CONFLICT',409);
    await ownerAccount(); return receipt(existing,true);
  }
  const plan=await prepare(normalized), db=await pool.connect();
  try {
    await db.query('BEGIN');
    // Serialize this key before creating the optimistic message. Competing requests
    // cannot leave orphan chat rows, nor enqueue twice after a conflict.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`alekito-bridge:${normalized.request_id}`]);
    existing=(await db.query(`SELECT * FROM ${TABLE} WHERE request_id=$1`,[normalized.request_id])).rows[0];
    if(existing) {
      if(existing.payload_digest!==normalized.digest) P.fail('IDEMPOTENCY_CONFLICT',409);
      await db.query('COMMIT'); return receipt(existing,true);
    }
    const correlation=await insertPendingRow({account:plan.account,toNumber:plan.owner,messageType:'template',messageBody:plan.rendered_body,
      templateMeta:{...templateUiMetadata(plan),origin:'alekito-internal-bridge',template_name:plan.local.name,bridge_request_id:normalized.request_id,payload_digest:normalized.digest,ia360_handler_for:`alekito-bridge:${normalized.request_id}`},db});
    if(!correlation) P.fail('CORRELATION_CONFLICT',409);
    const job={kind:'template',alekitoBridgeRequestId:normalized.request_id,accountId:plan.account.id,to:plan.owner,localMessageId:correlation,payload:{name:plan.local.name,languageCode:plan.local.language,components:plan.components}};
    await db.query(`INSERT INTO ${TABLE}(request_id,payload_digest,template_id,template_name,template_language,account_id,owner_ref,correlation_id,template_schema_digest,state,job_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared',$10)`,[normalized.request_id,normalized.digest,plan.local.id,plan.local.name,plan.local.language,plan.account.id,OWNER_REF,correlation,plan.schema_digest,JSON.stringify(job)]);
    await db.query('COMMIT');
  } catch(err) { await db.query('ROLLBACK'); throw err; } finally { db.release(); }
  await dispatch(normalized.request_id);
  return receipt(await getRequest(normalized.request_id));
}
async function status(requestId) { await ownerAccount(); const row=await getRequest(requestId); if(!row) P.fail('REQUEST_NOT_FOUND',404); return receipt(row); }
async function validateBridgeDispatch(job) {
  const row=await getRequest(job.alekitoBridgeRequestId), binding=await ownerAccount();
  if(!row || P.stable(row.job_payload)!==P.stable(job) || job.kind!=='template' || job.to!==binding.owner || Number(job.accountId)!==Number(binding.account.id) || row.owner_ref!==OWNER_REF) P.fail('BRIDGE_JOB_BINDING_INVALID',403);
  const local=(await localTemplates(binding.account)).find(t=>Number(t.id)===Number(row.template_id));
  if(!local) P.fail('TEMPLATE_APPROVAL_REVOKED',403);
  const specs=await metaSpecs(binding.account,true);
  const spec=specs.find(s=>s.name===row.template_name && s.language===row.template_language && s.status==='APPROVED' && (!local.meta_template_id || String(s.id)===String(local.meta_template_id)));
  if(!spec || P.hash(P.stable(P.cleanSpec(spec.components)))!==row.template_schema_digest) P.fail('TEMPLATE_APPROVAL_OR_SCHEMA_CHANGED',403);
}
async function eligibleIngress(row, expectedRef) {
  if(!row || !/^wamid\.[A-Za-z0-9+/=_-]+$/.test(row.message_id) || row.direction!=='incoming' || P.hash(P.digits(row.wa_number)).slice(0,12)!==ACCOUNT_REF) P.fail('REAL_INGRESS_REQUIRED',403);
  if(P.contactRef(row.wa_number,row.contact_number)!==expectedRef) P.fail('INGRESS_IDENTITY_MISMATCH',403);
  const age=Date.now()-new Date(row.timestamp).getTime();
  if(!Number.isFinite(age) || age< -30000 || age>=300000) P.fail('FRESH_INGRESS_REQUIRED',409);
  const raw=row.raw_payload || {};
  if(raw.dry_run || raw.synthetic || raw.test || raw.origin==='qa' || raw.origin==='simulation') P.fail('REAL_INGRESS_REQUIRED',403);
  const {rows}=await pool.query(`SELECT account_key,rol FROM coexistence.ia360_contact_scope WHERE contact_number=$1 AND activo=true`,[row.contact_number]);
  if(!rows.length) P.fail('CURRENT_CONTACT_PERMISSION_REQUIRED',403);
  return row;
}
async function latestOwnerIngress() {
  const binding=await ownerAccount();
  const {rows}=await pool.query(`SELECT message_id,timestamp FROM coexistence.chat_history WHERE wa_number=$1 AND contact_number=$2
    AND direction='incoming' AND timestamp>now()-interval '5 minutes' AND message_id ~ '^wamid\.[A-Za-z0-9+/=_-]+$' ORDER BY timestamp DESC LIMIT 1`,[binding.wa,binding.owner]);
  if(!rows[0]) P.fail('FRESH_OWNER_INGRESS_REQUIRED',409,{instruction:'Desde el WhatsApp personal de Alek, enviar a la línea Alek business: prueba de contexto Alekito. Ejecutar contexto en menos de cinco minutos.'});
  return {ok:true,schema:'alekito.ingress.v1',owner_ref:OWNER_REF,ingress_ref:P.ingressRef(rows[0].message_id),received_at:rows[0].timestamp,expires_at:new Date(new Date(rows[0].timestamp).getTime()+300000).toISOString()};
}
async function verifyOwnerIngress(body){
  P.exact(body,['ingress_ref','message_ref','request_id','account_ref','digest']);
  if(!/^in_[a-f0-9]{32}$/.test(body.ingress_ref||''))P.fail('INGRESS_REF_INVALID');
  if(!/^msg_[a-f0-9]{64}$/.test(body.message_ref||'')||!/^req_[a-f0-9]{64}$/.test(body.request_id||'')||
    !/^[a-f0-9]{64}$/.test(body.digest||'')||body.account_ref!==ACCOUNT_REF)P.fail('INGRESS_BINDING_REQUIRED',403);
  const binding=await ownerAccount();
  const row=await findOwnerIngressRow(binding,{messageRef:body.message_ref,ingressRef:body.ingress_ref});
  if(row&&P.ingressRef(row.message_id)!==body.ingress_ref)P.fail('INGRESS_BINDING_MISMATCH',403);
  await eligibleIngress(row,OWNER_REF);
  await ownership().assertCanary(row);
  const signing=process.env.NEXUS_SELLO_FORGECHAT;if(!signing)P.fail('INGRESS_ATTESTATION_UNAVAILABLE',503);
  const canonical=await ownerEnvelopeForIngress(row,binding,{wa:binding.wa,owner:binding.owner,accountRef:ACCOUNT_REF,contactRef:OWNER_REF,signing,ingressRef:body.ingress_ref});
  const envelope=canonical.envelope;
  if(body.message_ref!==envelope.message_ref||body.request_id!==envelope.request_id||body.digest!==canonical.digest)P.fail('INGRESS_BINDING_MISMATCH',403);
  return {ok:true,schema:'alekito.ingress-verified.v1',verified:true,source:'persisted-meta-ingress',
    ingress_ref:body.ingress_ref,message_ref:envelope.message_ref,request_id:envelope.request_id,conversation_ref:canonical.conversation_ref,
    account_ref:ACCOUNT_REF,contact_ref:OWNER_REF,actor_attestation_ref:envelope.actor_attestation_ref,digest:canonical.digest,
    actor:{identity:'verified-canary-owner',authorization_source:'current-server-contact-scope'},
    allowed_capabilities:['conversation.reply','contact_context.read'],
    received_at:envelope.received_at,expires_at:canonical.expires_at,
    input:{type:envelope.message_type,text:envelope.text,...(envelope.button_payload?{button_payload:envelope.button_payload,reply_to:envelope.reply_to,original_type:row.message_type}:{})},
    grants_merged:false,side_effects:false,dispatched:false};
}
async function captureNextOwner(body){
  P.exact(body,['capture_id','after']);
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(body.capture_id||'')||typeof body.after!=='string'||!Number.isFinite(Date.parse(body.after)))P.fail('CAPTURE_REQUEST_INVALID');
  const binding=await ownerAccount(),after=new Date(body.after).toISOString();
  const capture=await ownership().arm({capture_id:body.capture_id,after});
  if(!capture.message_ref)return {ok:true,schema:'alekito.owner-capture.v1',capture_id:body.capture_id,captured:false,armed:true,
    exclusive:true,after,expires_at:new Date(capture.expires_at).toISOString(),side_effects:false,dispatched:false};
  const rows=(await pool.query(`SELECT message_id,wa_number,contact_number,direction,timestamp,raw_payload,message_body,media_lectura,message_type,context_message_id FROM coexistence.chat_history
    WHERE wa_number=$1 AND contact_number=$2 AND direction='incoming' AND message_type IN ('text','button','interactive','audio','voice','image','video','document','location','contacts') AND timestamp>$3 ORDER BY timestamp ASC LIMIT 50`,[binding.wa,binding.owner,after])).rows;
  const row=rows.find(r=>`msg_${P.hash(r.message_id)}`===capture.message_ref)||(await findOwnerIngressRow(binding,{messageRef:capture.message_ref}));
  if(!row||new Date(row.timestamp).getTime()<=new Date(after).getTime())P.fail('CAPTURE_INGRESS_UNAVAILABLE',409);
  await eligibleIngress(row,OWNER_REF);await ownership().assertCanary(row);
  if(!['text','button','interactive','audio','voice','image','video','document','location','contacts'].includes(row.message_type))P.fail('CAPTURE_TEXT_OR_BUTTON_REQUIRED',409);
  const signing=process.env.NEXUS_SELLO_FORGECHAT;if(!signing)P.fail('INGRESS_ATTESTATION_UNAVAILABLE',503);
  const canonical=await ownerEnvelopeForIngress(row,binding,{wa:binding.wa,owner:binding.owner,accountRef:ACCOUNT_REF,contactRef:OWNER_REF,signing,ingressRef:P.ingressRef(row.message_id)});
  const envelope=canonical.envelope,proof={ingress_ref:envelope.ingress_ref,message_ref:envelope.message_ref,request_id:envelope.request_id,account_ref:ACCOUNT_REF,digest:canonical.digest};
  if(capture.request_id&&capture.request_id!==envelope.request_id)P.fail('CAPTURE_MESSAGE_CONFLICT',409);
  const registered=await (await turns()).register(proof);
  await pool.query(`UPDATE coexistence.alekito_owner_captures SET request_id=$2,ingress_ref=$3 WHERE capture_id=$1 AND (request_id IS NULL OR request_id=$2)`,[body.capture_id,envelope.request_id,envelope.ingress_ref]);
  return {ok:true,schema:'alekito.owner-capture.v1',capture_id:body.capture_id,captured:true,binding:proof,envelope,
    exclusive:true,producer:'canary',state:registered.row.state,replay:registered.kind==='existing',expires_at:canonical.expires_at,side_effects:false,dispatched:false};
}
async function captureStatus(id){
  await ownerAccount();if(!/^[A-Za-z0-9_-]{1,100}$/.test(id||''))P.fail('CAPTURE_REQUEST_INVALID');
  const capture=(await pool.query('SELECT after_timestamp FROM coexistence.alekito_owner_captures WHERE capture_id=$1',[id])).rows[0];
  if(!capture)P.fail('CAPTURE_NOT_FOUND',404);return captureNextOwner({capture_id:id,after:new Date(capture.after_timestamp).toISOString()});
}
async function context(body) {
  P.exact(body,['nexus_sello','ingress_ref']);
  if((!!body.nexus_sello)===(!!body.ingress_ref)) P.fail('ONE_INGRESS_PROOF_REQUIRED');
  const secret=process.env.NEXUS_SELLO_FORGECHAT, key=process.env.NEXUS_LLAVE_ALEKITO_WHATSAPP;
  if(!secret || !key || !process.env.NEXUS_INVITAR_URL) P.fail('CONTEXT_AUTH_UNAVAILABLE',503);
  let row,seal=body.nexus_sello,ref;
  if(seal) {
    const proof=P.verifySeal(seal,secret); ref=proof.contact_ref;
    row=(await pool.query(`SELECT message_id,wa_number,contact_number,direction,timestamp,raw_payload FROM coexistence.chat_history WHERE message_id=$1 AND direction='incoming' LIMIT 2`,[proof.message_id])).rows;
    if(row.length!==1) P.fail('REAL_INGRESS_REQUIRED',403); row=row[0];
  } else {
    if(!/^in_[a-f0-9]{32}$/.test(body.ingress_ref||'')) P.fail('INGRESS_REF_INVALID');
    const binding=await ownerAccount(); ref=OWNER_REF;
    const recent=(await pool.query(`SELECT message_id,wa_number,contact_number,direction,timestamp,raw_payload FROM coexistence.chat_history
      WHERE wa_number=$1 AND contact_number=$2 AND direction='incoming' AND timestamp>now()-interval '5 minutes' ORDER BY timestamp DESC LIMIT 50`,[binding.wa,binding.owner])).rows;
    row=recent.find(r=>P.ingressRef(r.message_id)===body.ingress_ref);
  }
  await eligibleIngress(row,ref);
  if(!seal) seal=P.sealIngress(ref,row.message_id,secret,Math.floor(new Date(row.timestamp).getTime()/1000)+300);
  P.verifySeal(seal,secret);
  const data=await nexus().readContext({requestId:`ctx_${P.hash(row.message_id)}`,sello:seal});
  if(!data.ok)nexusFault(data,502);
  return {ok:true,schema:'alekito.context.v2',contact_ref:ref,ingress_ref:P.ingressRef(row.message_id),
    authority:'verified restricted Nexus client surface; contexto_de_contacto',context:data.context};
}
function mapDeliveryToOwnershipState(delivery){
  if(!delivery)return {state:'uncertain',code:'DELIVERY_OUTCOME_UNCERTAIN'};
  if(delivery.delivery_state==='failed'||['failed','error'].includes(delivery.provider_state)){
    return {state:'failed',code:delivery.public_code||'DELIVERY_FAILED'};
  }
  if(delivery.delivery_state==='claimed'){
    return {state:'claimed',code:'DELIVERY_CLAIM_IN_PROGRESS'};
  }
  if(delivery.delivery_state==='uncertain'||delivery.reconciliation_required){
    return {state:'uncertain',code:delivery.public_code||'DELIVERY_OUTCOME_UNCERTAIN'};
  }
  if(['delivered','read'].includes(delivery.delivery_state)&&delivery.effective_receipt===true){
    return {state:'completed',code:null};
  }
  if(delivery.delivery_state==='queued'){
    if(delivery.provider_accepted===true)return {state:'accepted',code:null};
    return {state:'queued',code:null};
  }
  return {state:'uncertain',code:delivery.public_code||'DELIVERY_OUTCOME_UNCERTAIN'};
}
async function reconcileOwnerTurnStatus(messageRef,proof,envelope,{nativeProtocol=null,networkFailed=false}={}){
  let persisted;
  try{persisted=await turnStatus(proof);}catch(err){
    const code=err?.code||'STATUS_CHECK_FAILED',state=code==='FRESH_INGRESS_REQUIRED'?'expired':'blocked';
    await markOwnershipState(messageRef,state,code);return {ok:false,state,error_code:code};
  }
  if(!persisted||persisted.ok!==true||persisted.request_id!==proof.request_id||persisted.digest!==proof.digest){
    await markOwnershipState(messageRef,'uncertain','STATUS_UNCONFIRMED');return {ok:false,state:'uncertain',error_code:'STATUS_UNCONFIRMED'};
  }
  if(persisted.state==='rejected'){
    const code=persisted.public_code||'TURN_REJECTED';
    await markOwnershipState(messageRef,'blocked',code);return {ok:false,state:'blocked',error_code:code};
  }
  if(persisted.state!=='completed'||!persisted.result){
    const code=persisted.public_code||'TRANSPORT_UNKNOWN';
    await markOwnershipState(messageRef,'uncertain',code);return {ok:false,state:'uncertain',error_code:code,status:persisted};
  }
  let persistedProtocol;
  try{
    persistedProtocol=validateProtocolResponse(persisted.result,proof.request_id);
    parseWrapperResult(persistedProtocol,{request_id:proof.request_id,correlation_id:envelope.correlation_id});
  }catch(err){
    const code=err?.code||'INVALID_CONVERSATION_RESPONSE';
    await markOwnershipState(messageRef,'blocked',code);return {ok:false,state:'blocked',error_code:code};
  }
  if(!['answer','clarify'].includes(persistedProtocol.status)||persistedProtocol.capability_request!==null||
     typeof persistedProtocol.proposed_reply!=='string'||!persistedProtocol.proposed_reply.length||
     persistedProtocol.proposed_reply.length>4000||persistedProtocol.side_effects!==false||persistedProtocol.dispatched!==false){
    await markOwnershipState(messageRef,'blocked','RESULT_NOT_DELIVERABLE');return {ok:false,state:'blocked',error_code:'RESULT_NOT_DELIVERABLE'};
  }
  if(nativeProtocol&&(nativeProtocol.status!==persistedProtocol.status||nativeProtocol.proposed_reply!==persistedProtocol.proposed_reply)){
    await markOwnershipState(messageRef,'blocked','RESULT_MISMATCH');return {ok:false,state:'blocked',error_code:'RESULT_MISMATCH'};
  }
  if(persisted.delivery_state==='pending'){
    if(isOwnerDispatchPaused()){
      await markOwnershipState(messageRef,'blocked','ROLLBACK_PAUSED');return {ok:false,state:'blocked',error_code:'ROLLBACK_PAUSED'};
    }
    try{
      persisted=await deliverTurn(proof);
    }catch(err){
      const code=err?.code||'DELIVERY_FAILED';
      const nextState=code==='FRESH_INGRESS_REQUIRED'?'expired':(code==='DELIVERY_OUTCOME_UNCERTAIN'?'uncertain':'blocked');
      await markOwnershipState(messageRef,nextState,code);return {ok:false,state:nextState,error_code:code};
    }
  }
  const {state:doneState,code:doneCode}=mapDeliveryToOwnershipState(persisted);
  await markOwnershipState(messageRef,doneState,doneCode);
  return {ok:doneState==='completed',state:doneState,error_code:doneCode,delivery:persisted};
}
async function processOwnerInboundJob(jobRow){
  if(!jobRow||jobRow.producer!=='canary'||!['pending','dispatching','claimed','queued','accepted','uncertain'].includes(jobRow.dispatch_state))return {ok:false,skipped:true};
  if(isOwnerDispatchPaused()&&['pending','dispatching','claimed','uncertain'].includes(jobRow.dispatch_state)){
    await markOwnershipState(jobRow.message_ref,'blocked','ROLLBACK_PAUSED');
    return {ok:false,state:'blocked',error_code:'ROLLBACK_PAUSED'};
  }
  if(jobRow.dispatch_state==='dispatching'&&jobRow.dispatch_started_at){
    const startedAt=new Date(jobRow.dispatch_started_at).getTime();
    const elapsed=Date.now()-startedAt;
    if(Number.isFinite(startedAt)&&elapsed>=0&&elapsed<DISPATCH_GRACE_MS){
      return {ok:false,skipped:true,reason:'dispatch_in_flight'};
    }
  }
  let binding,row,canonical;
  try{
    binding=await ownerAccount();
    if(!jobRow.message_id||`msg_${P.hash(jobRow.message_id)}`!==jobRow.message_ref)P.fail('INGRESS_BINDING_MISMATCH',403);
    row=await findOwnerIngressRow(binding,{messageId:jobRow.message_id,messageRef:jobRow.message_ref});
    if(row&&jobRow.ingress_timestamp){
      if(new Date(row.timestamp).getTime()!==new Date(jobRow.ingress_timestamp).getTime())P.fail('INGRESS_TIMESTAMP_IMMUTABLE',409);
      const immutableAge=Date.now()-new Date(jobRow.ingress_timestamp).getTime();
      if(!Number.isFinite(immutableAge)||immutableAge<-30000||immutableAge>=300000)P.fail('FRESH_INGRESS_REQUIRED',409);
    }
    await eligibleIngress(row,OWNER_REF);
    if(!['text','button','interactive','audio','voice','image','video','document','location','contacts'].includes(row.message_type))P.fail('CAPTURE_TEXT_OR_BUTTON_REQUIRED',409);
    await ownership().assertCanary(row);
    const signing=process.env.NEXUS_SELLO_FORGECHAT;if(!signing)P.fail('INGRESS_ATTESTATION_UNAVAILABLE',503);
    canonical=await ownerEnvelopeForIngress(row,binding,{wa:binding.wa,owner:binding.owner,accountRef:ACCOUNT_REF,contactRef:OWNER_REF,signing,ingressRef:P.ingressRef(row.message_id)});
  }catch(err){
    const code=err?.code||'INGRESS_VALIDATION_FAILED',state=code==='FRESH_INGRESS_REQUIRED'?'expired':'blocked';
    await markOwnershipState(jobRow.message_ref,state,code);return {ok:false,state,error_code:code};
  }
  const envelope=canonical.envelope,proof={ingress_ref:envelope.ingress_ref,message_ref:envelope.message_ref,request_id:envelope.request_id,account_ref:ACCOUNT_REF,digest:canonical.digest};
  if(jobRow.dispatch_state!=='pending'||Number(jobRow.dispatch_attempts)>=1){
    return reconcileOwnerTurnStatus(jobRow.message_ref,proof,envelope);
  }
  const secret=process.env.IA360_DIRECTIVE_SECRET,targetWrapperUrl=resolveWrapperUrl();
  if(!secret||!targetWrapperUrl){
    await markOwnershipState(jobRow.message_ref,'blocked','WRAPPER_AUTH_UNAVAILABLE');return {ok:false,state:'blocked',error_code:'WRAPPER_AUTH_UNAVAILABLE'};
  }
  try{
    await (await turns()).register(proof);
    if(jobRow.capture_id){
      await pool.query(`UPDATE coexistence.alekito_owner_captures SET request_id=$2,ingress_ref=$3 WHERE capture_id=$1 AND (request_id IS NULL OR request_id=$2)`,[jobRow.capture_id,envelope.request_id,envelope.ingress_ref]);
    }
  }catch(err){
    const code=err?.code||'LEDGER_REGISTER_FAILED';
    await markOwnershipState(jobRow.message_ref,'blocked',code);return {ok:false,state:'blocked',error_code:code};
  }
  const claimed=await pool.query(`UPDATE ${OWN_TABLE} SET dispatch_state='dispatching',dispatch_attempts=1,request_id=$3,ingress_ref=$4,error_code=NULL,dispatch_started_at=now(),updated_at=now()
    WHERE account_ref=$1 AND message_ref=$2 AND producer='canary' AND dispatch_state='pending' AND dispatch_attempts=0 RETURNING *`,
    [ACCOUNT_REF,jobRow.message_ref,proof.request_id,proof.ingress_ref]);
  if(claimed.rowCount!==1)return {ok:false,skipped:true,reason:'already_claimed'};
  let response,nativeBody;
  try{
    response=await fetch(targetWrapperUrl,{method:'POST',headers:{'Content-Type':'application/json','X-IA360-Directive-Secret':secret},
      body:JSON.stringify({binding:proof,envelope}),signal:AbortSignal.timeout(WRAPPER_TIMEOUT_MS),redirect:'error'});
  }catch{
    return reconcileOwnerTurnStatus(jobRow.message_ref,proof,envelope,{networkFailed:true});
  }
  try{nativeBody=await response.json();}catch{
    await markOwnershipState(jobRow.message_ref,'blocked','INVALID_CONVERSATION_RESPONSE');return {ok:false,state:'blocked',error_code:'INVALID_CONVERSATION_RESPONSE'};
  }
  let nativeProtocol;
  try{
    nativeProtocol=validateProtocolResponse(nativeBody,proof.request_id);
    parseWrapperResult(nativeProtocol,{request_id:proof.request_id,correlation_id:envelope.correlation_id});
  }catch(err){
    const code=err?.code||'INVALID_CONVERSATION_RESPONSE';
    const persisted=await turnStatus(proof).catch(()=>null);
    const state=!response.ok&&persisted?.state==='unknown'?'uncertain':'blocked';
    const finalCode=state==='uncertain'?(persisted?.public_code||'TRANSPORT_UNKNOWN'):code;
    await markOwnershipState(jobRow.message_ref,state,finalCode);return {ok:false,state,error_code:finalCode};
  }
  if(!response.ok||!['answer','clarify'].includes(nativeProtocol.status)||nativeProtocol.capability_request!==null){
    const persisted=await turnStatus(proof).catch(()=>null);
    const state=persisted?.state==='unknown'?'uncertain':'blocked';
    const code=nativeProtocol.reason_code||persisted?.public_code||'TURN_NOT_DELIVERABLE';
    await markOwnershipState(jobRow.message_ref,state,code);return {ok:false,state,error_code:code};
  }
  return reconcileOwnerTurnStatus(jobRow.message_ref,proof,envelope,{nativeProtocol});
}
async function drainOwnerTurnJobs(){
  const cols=`account_ref,message_ref,contact_ref,producer,capture_id,message_id,ingress_timestamp,
      dispatch_state,dispatch_attempts,request_id,ingress_ref,dispatch_started_at,created_at,updated_at`;
  await new Promise(r => setTimeout(r, 300));
  const pending=await pool.query(`SELECT ${cols}
    FROM ${OWN_TABLE} WHERE account_ref=$1 AND contact_ref=$2 AND producer='canary'
      AND dispatch_state='pending' AND message_id IS NOT NULL
    ORDER BY ingress_timestamp ASC NULLS LAST, created_at ASC LIMIT 10`,[ACCOUNT_REF,OWNER_REF]);
  const reconcile=await pool.query(`SELECT ${cols}
    FROM ${OWN_TABLE} WHERE account_ref=$1 AND contact_ref=$2 AND producer='canary'
      AND dispatch_state IN ('dispatching','claimed','queued','accepted','uncertain') AND message_id IS NOT NULL
    ORDER BY updated_at ASC, created_at ASC LIMIT 10`,[ACCOUNT_REF,OWNER_REF]);
  const results=[];
  for(const jobRow of [...reconcile.rows,...pending.rows])results.push(await processOwnerInboundJob(jobRow));
  return results;
}
async function runOwnerTurnWorker(){
  if(ownerWorkerPromise){ownerWorkerPending=true;return ownerWorkerPromise;}
  ownerWorkerPromise=(async()=>{
    let last=[];
    do{ownerWorkerPending=false;last=await drainOwnerTurnJobs();}while(ownerWorkerPending);
    return last;
  })().finally(()=>{ownerWorkerPromise=null;});
  return ownerWorkerPromise;
}
function kickOwnerTurnWorker(){
  if(ownerWorkerStopped)return;
  setImmediate(()=>{if(!ownerWorkerStopped)runOwnerTurnWorker().catch(()=>{console.error('[alekito-bridge] owner turn worker failed');});});
}
async function runBridgeRecoveryTick(){
  try {
    const {rows}=await pool.query(`SELECT request_id FROM ${TABLE} WHERE state='prepared' ORDER BY created_at LIMIT 10`);
    for(const row of rows){
      try { await dispatch(row.request_id); } catch { console.error('[alekito-bridge] recovery dispatch failed'); }
    }
  } catch { console.error('[alekito-bridge] recovery check failed'); }
  if(ownerWorkerStopped)return [];
  try {
    return await runOwnerTurnWorker();
  } catch {
    console.error('[alekito-bridge] owner turn recovery failed');
    return [];
  }
}
function startBridgeRecovery() {
  ownerWorkerStopped=false;
  ownerDispatchPaused=false;
  if(timer) return;
  timer=setInterval(()=>{ runBridgeRecoveryTick(); },15000); timer.unref();
}
async function stopBridgeRecovery(options={}) {
  if(options&&options.pause===false)P.fail('ROLLBACK_PAUSE_REQUIRED',400);
  ownerDispatchPaused=true;
  process.env.ALEKITO_OWNER_DISPATCH_PAUSED='1';
  ownerWorkerStopped=true;
  ownerWorkerPending=false;
  if(timer){clearInterval(timer);timer=null;}
  if(ownerWorkerPromise){await ownerWorkerPromise.catch(()=>{});}
  const cols=`account_ref,message_ref,contact_ref,producer,capture_id,message_id,ingress_timestamp,
      dispatch_state,dispatch_attempts,request_id,ingress_ref,dispatch_started_at,created_at,updated_at`;
  const drained=[];
  while(true){
    const {rows}=await pool.query(`SELECT ${cols}
      FROM ${OWN_TABLE} WHERE account_ref=$1 AND contact_ref=$2 AND producer='canary'
        AND dispatch_state IN ('pending','dispatching','claimed','uncertain') AND message_id IS NOT NULL
      ORDER BY created_at ASC LIMIT 10`,[ACCOUNT_REF,OWNER_REF]);
    if(!rows.length)break;
    for(const row of rows)drained.push(await processOwnerInboundJob(row));
  }
  const reconciled=[];
  const {rows:enqueuedRows}=await pool.query(`SELECT ${cols}
    FROM ${OWN_TABLE} WHERE account_ref=$1 AND contact_ref=$2 AND producer='canary'
      AND dispatch_state IN ('queued','accepted') AND message_id IS NOT NULL
    ORDER BY updated_at ASC, created_at ASC LIMIT 10`,[ACCOUNT_REF,OWNER_REF]);
  for(const row of enqueuedRows)reconciled.push(await processOwnerInboundJob(row));
  return {paused:isOwnerDispatchPaused(),worker_stopped:ownerWorkerStopped,timer_active:Boolean(timer),in_flight:Boolean(ownerWorkerPromise),drained,reconciled};
}
// Private server-only endpoint identity. Never return through a model tool.
async function resolveVerifiedHumanReadEndpoint(proof){
 const origin=await verifyOwnerIngress(proof);
 const binding=await ownerAccount();
 const row=await findOwnerIngressRow(binding,{messageRef:proof.message_ref,ingressRef:proof.ingress_ref});
 if(!row||P.contactRef(row.wa_number,row.contact_number)!==origin.contact_ref)P.fail('INGRESS_BINDING_MISMATCH',403);
 return {verified:true,provider:'whatsapp',business_account_ref:origin.account_ref,contact_ref:origin.contact_ref,phone:'+'+P.digits(row.contact_number),proof:{...proof},received_at:origin.received_at,expires_at:origin.expires_at};
}
module.exports={withOwnerNotificationEgress,ensureBridgeTable,internalAuthorized,catalog,preview,sendOwnerTemplate,status,context,latestOwnerIngress,verifyOwnerIngress,resolveVerifiedHumanReadEndpoint,nexusStatus,ownerContinuity,
  reserveTurn,completeTurn,turnStatus,captureNextOwner,captureStatus,claimInboundProducer,deliverTurn,validateConversationDispatch,
  processOwnerInboundJob,runOwnerTurnWorker,kickOwnerTurnWorker,runBridgeRecoveryTick,startBridgeRecovery,stopBridgeRecovery,validateBridgeDispatch,resolveWrapperUrl};
