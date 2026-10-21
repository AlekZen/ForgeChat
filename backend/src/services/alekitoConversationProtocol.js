'use strict';
const {createHash,createHmac}=require('node:crypto');
const {isVerifiedButton,PAYLOAD}=require('./alekitoButtonIngress');
const sha=value=>createHash('sha256').update(value).digest('hex');
function stable(value){if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;return JSON.stringify(value);}
function envelopeForIngress(row,{wa,owner,accountRef,contactRef,signing,ingressRef,normalizedButton=null,quotedPrefix=''}){
  if(row.message_type!=='text'&&!isVerifiedButton(normalizedButton,row,{accountRef,contactRef}))throw new Error('BUTTON_VERIFICATION_REQUIRED');
  const conversation=sha(`${wa}\0${owner}`),message_ref=`msg_${sha(row.message_id)}`;
  const request_id=`req_${sha(`alekito-conversation-v1\0${conversation}\0${row.message_id}`)}`;
  const received_at=new Date(row.timestamp).toISOString(),expires_at=new Date(new Date(row.timestamp).getTime()+300000).toISOString();
  const attestationFields={schema:'alekito.ingress-verified.v1',ingress_ref:ingressRef,message_ref,request_id,account_ref:accountRef,contact_ref:contactRef,expires_at};
  const actor_attestation_ref=`att_${createHmac('sha256',signing).update(stable(attestationFields)).digest('hex')}`;
  const envelope={schema:'alekito.conversation.request.v1',request_id,correlation_id:`ak_${sha(request_id)}`,
    ingress_ref:ingressRef,message_ref,account_ref:accountRef,actor_attestation_ref,received_at,
    message_type:'text',text:normalizedButton?normalizedButton.text:((quotedPrefix||'')+(typeof row.message_body==='string'?row.message_body:'')),
    structured:{contacts:[]},reply_to:normalizedButton?.reply_to||null,button_payload:normalizedButton?.button_payload||null,attachments:[]};
  return {envelope,conversation_ref:`conv_${conversation}`,contact_ref:contactRef,expires_at,digest:sha(stable(envelope))};
}
function parseRequest(value){
  const keys=['schema','request_id','correlation_id','ingress_ref','message_ref','account_ref','actor_attestation_ref','received_at','message_type','text','structured','reply_to','button_payload','attachments'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k))||
    value.schema!=='alekito.conversation.request.v1'||value.message_type!=='text'||typeof value.text!=='string'||!value.text.trim()||value.text.length>16000||value.text.includes('\0')||
    !((value.reply_to===null&&value.button_payload===null)||(typeof value.reply_to==='string'&&/^m_[a-f0-9]{12}$/.test(value.reply_to)&&typeof value.button_payload==='string'&&PAYLOAD.test(value.button_payload)))||!Array.isArray(value.attachments)||value.attachments.length||
    !value.structured||Object.keys(value.structured).join(',')!=='contacts'||!Array.isArray(value.structured.contacts)||value.structured.contacts.length||
    !/^req_[a-f0-9]{64}$/.test(value.request_id)||!/^ak_[a-f0-9]{64}$/.test(value.correlation_id)||!/^msg_[a-f0-9]{64}$/.test(value.message_ref)||
    !/^in_[a-f0-9]{32}$/.test(value.ingress_ref)||!/^att_[a-f0-9]{64}$/.test(value.actor_attestation_ref)||!/^[A-Za-z0-9_-]{1,160}$/.test(value.account_ref)||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.received_at))throw new Error('INVALID_CONVERSATION_REQUEST');
  return value;
}
function parseWrapperResult(value,request){
  const allowed=['schema','request_id','correlation_id','status','proposed_reply','evidence_refs','pending_intent','capability_request','scope_ref','policy_version','reason_code','side_effects','dispatched'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))||
    value.schema!=='alekito.conversation.response.v1'||value.request_id!==request.request_id||value.correlation_id!==request.correlation_id||
    value.side_effects!==false||value.dispatched!==false||!['answer','clarify','blocked','error'].includes(value.status))throw new Error('INVALID_CONVERSATION_RESPONSE');
  const reply=value.proposed_reply;
  if(['answer','clarify','blocked'].includes(value.status)&&typeof reply==='string'&&reply.trim()&&reply.length<=4096&&!reply.includes('\0'))
    return {status:'completed',request_id:request.request_id,reply:{type:'text',text:reply},reply_owner:'forgechat'};
  if(value.status==='blocked')return {status:'rejected',request_id:request.request_id,public_code:'NOT_AUTHORIZED'};
  if(value.status==='error')return {status:'unknown',request_id:request.request_id,public_code:'TRANSPORT_UNKNOWN'};
  throw new Error('INVALID_CONVERSATION_RESPONSE');
}
function validateProtocolResponse(value,id){
  const expected={request_id:id,correlation_id:`ak_${sha(id)}`};
  parseWrapperResult(value,expected);
  const serialized=JSON.stringify(value);
  if(serialized.length>65536||/\bv1\.c_[A-Za-z0-9]+\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+|\b(?:nxa_|plane_api_|cfut_)[A-Za-z0-9_-]+|Bearer\s+\S+|"(?:nexus_sello|authorization|api_key|context_packet)"\s*:/i.test(serialized))throw new Error('UNSAFE_PROTOCOL_RESPONSE');
  return JSON.parse(serialized);
}
module.exports={stable,envelopeForIngress,digestEnvelope:value=>sha(stable(value)),parseRequest,parseWrapperResult,validateProtocolResponse};
