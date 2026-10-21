'use strict';
// Durable orchestration. All network, permission and writer bindings are
// injected by the backend; this module neither opens endpoints nor reads secrets.
const {mapLegacyV2ToFacade,semanticDigest}=require('./alekitoConversationRoute');
const {createTurnLedger}=require('./alekitoTurnLedger');
class TurnError extends Error {constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new TurnError(code);};
const result=(status,code,extra={})=>({selected:true,status,public_code:code,
  retryPost:false,fallbackToLegacy:false,maySend:false,...extra});
function createConversationTurn({db,parseRequest,parseResult,authorize,transport,writer,now,nonce,
  mapRequest=payload=>mapLegacyV2ToFacade(payload).request,requestDigest=semanticDigest}={}){
  if(typeof authorize!=='function'||typeof parseRequest!=='function'||typeof parseResult!=='function')fail('NOT_BOUND');
  const ledger=createTurnLedger({db,parseResult,now,nonce});
  function checkResult(value,id){
    const parsed=parseResult(value,id);
    if(parsed.status==='completed'&&(parsed.reply.text.length>4096||
      /\bv1\.c_[A-Za-z0-9]+\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+|\b(?:nxa_|plane_api_|cfut_)[A-Za-z0-9_-]+|Bearer\s+\S+/i.test(parsed.reply.text)))fail('UNSAFE_REPLY');
    return parsed;
  }
  async function authenticated(payload,request){
    // authorize MUST check the original persisted inbound record, current grants,
    // configured owner/account identity and seal. Request fields are not grants.
    const permit=await authorize({payload,request,operation:'conversation.reply'});
    if(!permit||permit.allowed!==true||permit.contact_ref!==payload.contact_ref||
      typeof permit.authorization_digest!=='string'||!/^[a-f0-9]{64}$/.test(permit.authorization_digest))fail('NOT_AUTHORIZED');
    return {request_id:request.request_id,message_ref:request.message_ref,
      conversation_ref:request.conversation_ref||permit.conversation_ref,contact_ref:permit.contact_ref,
      digest:requestDigest(request),authorization_digest:permit.authorization_digest};
  }
  async function deliver(scope,row,payload,request){
    if(row.state!=='completed'||!writer)return row;
    // Recheck current authoritative permission immediately before writer claim.
    const current=await authenticated(payload,request);
    if(current.authorization_digest!==scope.authorization_digest)fail('AUTHORIZATION_CHANGED');
    const claim=await ledger.claimDelivery(scope);
    if(!claim.claimed)return claim.row;
    try{
      // writer must atomically attach correlation with canonical pending-row
      // insertion BEFORE enqueue. It must never send through a second transport.
      const receipt=await writer({scope,delivery_token:claim.token,reply:row.response_json.reply,
        payload,attachInTransaction:async(tx,correlation)=>createTurnLedger({db:tx,parseResult,now,nonce}).attachDelivery(scope,claim.token,correlation)});
      return await ledger.recordDelivery(scope,claim.token,receipt);
    }catch{
      return await ledger.recordDelivery(scope,claim.token,{state:'uncertain'});
    }
  }
  async function run({buildPayload,policy={mode:'legacy'}}={}){
    if(policy?.mode==='legacy')return {selected:false,reason:'LEGACY_UNCHANGED'};
    if(policy?.mode!=='alekito-owner-canary')return result('rejected','NOT_BOUND');
    if(!transport||typeof transport.invoke!=='function'||typeof policy.routeRevision!=='string')return result('rejected','NOT_BOUND');
    const timeout=policy.timeoutMs??20000;
    if(!Number.isInteger(timeout)||timeout<1||timeout>30000)return result('rejected','INVALID_TIMEOUT');
    let payload,request,scope;
    try{
      payload=buildPayload();
      if(!Array.isArray(policy.contactRefs)||policy.contactRefs.length!==1||!policy.contactRefs.includes(payload.contact_ref))fail('CONTACT_NOT_SELECTED');
      request=parseRequest(mapRequest(payload));
      scope=await authenticated(payload,request);
    }catch{return result('rejected','NOT_AUTHORIZED');}
    let row;
    try{
      const reservation=await ledger.reserve({...scope,route_revision:policy.routeRevision});
      row=reservation.row;
      if(row.state==='dispatching')row=await ledger.expire(scope);
      if(row.state==='reserved'){
        const claim=await ledger.claim(scope,{leaseMs:timeout});
        row=claim.row;
        if(claim.claimed){
          let timer;const controller=new AbortController();
          try{
            const raw=await Promise.race([Promise.resolve().then(()=>transport.invoke(request,{signal:controller.signal})),
              new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new TurnError('TIMEOUT'));},timeout);})]);
            row=await ledger.finish(scope,claim.token,checkResult(raw,request.request_id));
          }catch(error){row=await ledger.unknown(scope,claim.token,error instanceof TurnError?error.code:'TRANSPORT_UNKNOWN');}
          finally{clearTimeout(timer);}
        }
      }
      row=await deliver(scope,row,payload,request);
      return result(row.state,row.error_code||null,{request_id:request.request_id,
        delivery_state:row.delivery_state,correlation_id:row.correlation_id||null,
        operation_ref:row.operation_ref||null,replay:reservation.kind==='existing'});
    }catch(error){return result('unknown',error?.code==='IDEMPOTENCY_CONFLICT'?'IDEMPOTENCY_CONFLICT':'RECONCILIATION_REQUIRED',
      {request_id:request.request_id});}
  }
  return Object.freeze({run,ledger});
}
module.exports={createConversationTurn,TurnError};
