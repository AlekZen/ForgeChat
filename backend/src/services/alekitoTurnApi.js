'use strict';
// Factory shared by authenticated HTTP endpoints and the owner dispatcher.
// Reservation grants one LLM invocation; it never sends a WhatsApp message.
const {createTurnLedger}=require('./alekitoTurnLedger');
const {parseWrapperResult,validateProtocolResponse,stable}=require('./alekitoConversationProtocol');
const {createHash}=require('node:crypto');
class TurnApiError extends Error{constructor(code,status=409){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new TurnApiError(code,status);};
const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(v,k)))fail('INVALID_TURN_REQUEST',400);};
const sha=v=>createHash('sha256').update(v).digest('hex');
function createTurnApi({db,verifyIngress,verifyExisting=verifyIngress,currentAuthorization,parseResult,systemResult=null,validateStoredSystemResult=null,now,nonce}={}){
  if(typeof verifyIngress!=='function'||typeof currentAuthorization!=='function')fail('TURN_NOT_BOUND',503);
  const ledger=createTurnLedger({db,parseResult,parseProtocolResult:validateProtocolResponse,now,nonce});
  async function binding(body,{existing=false}={}){
    exact(body,['ingress_ref','message_ref','request_id','account_ref','digest']);
    const origin=await (existing?verifyExisting:verifyIngress)(body);
    if(origin.verified!==true||origin.request_id!==body.request_id||origin.message_ref!==body.message_ref||
      origin.account_ref!==body.account_ref||origin.digest!==body.digest)fail('NOT_AUTHORIZED',403);
    const authorization=await currentAuthorization(origin);
    if(!authorization||typeof authorization.digest!=='string'||!/^[a-f0-9]{64}$/.test(authorization.digest))fail('NOT_AUTHORIZED',403);
    return {origin,scope:{request_id:origin.request_id,message_ref:origin.message_ref,
      conversation_ref:origin.conversation_ref,contact_ref:origin.contact_ref,digest:origin.digest,
      authorization_digest:authorization.digest}};
  }
  function receipt(row,{claim=null,decision=null}={}){
    const terminal=!!row.protocol_response;
    return {ok:true,schema:'alekito.turn-reservation.v1',request_id:row.request_id,digest:row.content_digest,
      decision:decision||(terminal&&row.protocol_response?'replay':'pending'),state:row.state,
      claim_ref:claim,lease_until:row.lease_until||null,result:terminal?row.protocol_response||null:null,
      delivery_state:row.delivery_state,correlation_id:row.correlation_id||null,public_code:row.error_code||null,
      retry_post:false,reply_owner:'forgechat',side_effects:false,dispatched:false};
  }
  async function register(body){
    const {origin,scope}=await binding(body);
    const reservation=await ledger.reserve({...scope,ingress_ref:body.ingress_ref,account_ref:body.account_ref,route_revision:'owner_canary_v1'});
    return {origin,scope,...reservation};
  }
  async function reserve(body){
    // A stored result may be read after ingress expiry under CURRENT permission.
    // Only a new/reserved invocation requires the still-fresh original ingress.
    try{
      const old=await binding(body,{existing:true});let row=await ledger.get(old.scope);
      if(row&&row.state!=='reserved'){
        if(row.protocol_response&&validateStoredSystemResult)await validateStoredSystemResult({origin:old.origin,proof:body,protocol:row.protocol_response});
        if(row.state==='dispatching')row=await ledger.expire(old.scope);
        return receipt(row);
      }
    }catch(error){if(error.code!=='REQUEST_NOT_FOUND')throw error;}
    const reserved=await register(body);let row=reserved.row;
    if(row.state==='dispatching')row=await ledger.expire(reserved.scope);
    if(row.state==='reserved'){
      const claim=await ledger.claim(reserved.scope,{leaseMs:30000});
      if(claim.claimed){
        if(systemResult){
          try{
            const trusted=await systemResult({origin:reserved.origin});
            if(trusted){
              const protocol=validateProtocolResponse(trusted,reserved.scope.request_id);
              if(protocol.capability_request!==null)fail('SYSTEM_RESULT_CAPABILITY_FORBIDDEN');
              const parsed=parseWrapperResult(protocol,{request_id:reserved.scope.request_id,correlation_id:`ak_${sha(reserved.scope.request_id)}`});
              const finished=await ledger.finish(reserved.scope,claim.token,parsed,{protocolResponse:protocol});
              return receipt(finished,{decision:'replay'});
            }
          }catch(error){
            const code=/^(?:BETA|NOTIFICATION)_[A-Z_]+$/.test(error?.code||'')?error.code:'BETA_RESULT_UNAVAILABLE';
            const unknown=await ledger.unknown(reserved.scope,claim.token,code);
            return receipt(unknown,{decision:'pending'});
          }
        }
        return receipt(claim.row,{claim:claim.token,decision:'invoke'});
      }
      row=claim.row;
    }
    return receipt(row);
  }
  async function complete(body){
    exact(body,['binding','claim_ref','result']);
    if(typeof body.claim_ref!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(body.claim_ref))fail('INVALID_CLAIM',400);
    const {scope}=await binding(body.binding,{existing:true}),existing=await ledger.get(scope);
    if(!existing)fail('REQUEST_NOT_FOUND',404);
    let protocol,parsed;
    try{protocol=validateProtocolResponse(body.result,scope.request_id);parsed=parseWrapperResult(protocol,{request_id:scope.request_id,correlation_id:`ak_${sha(scope.request_id)}`});}
    catch{fail('INVALID_PROTOCOL_RESPONSE',400);}
    if(existing.claim_token!==body.claim_ref)fail('CLAIM_MISMATCH',403);
    if(['completed','rejected','unknown'].includes(existing.state)&&existing.protocol_response){
      if(stable(existing.protocol_response)!==stable(protocol))fail('RESULT_CONFLICT',409);
      if(validateStoredSystemResult)await validateStoredSystemResult({origin:await verifyExisting(body.binding),proof:body.binding,protocol});
      return receipt(existing);
    }
    const row=await ledger.finish(scope,body.claim_ref,parsed,{protocolResponse:protocol});return receipt(row);
  }
  async function status(body){const {origin,scope}=await binding(body,{existing:true});let row=await ledger.get(scope);if(!row)fail('REQUEST_NOT_FOUND',404);
    if(row.protocol_response&&validateStoredSystemResult)await validateStoredSystemResult({origin,proof:body,protocol:row.protocol_response});
    if(row.state==='dispatching')row=await ledger.expire(scope);return receipt(row);}
  return Object.freeze({register,reserve,complete,status,ledger});
}
module.exports={createTurnApi,TurnApiError};
