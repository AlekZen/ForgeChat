'use strict';
// Verifies ONLY an already-persisted native beta acknowledgement. Does not consume,
// replay or mutate consent. Its text is finite/public; it cannot carry project data.
const {createHash}=require('node:crypto');
const sha=x=>createHash('sha256').update(x).digest('hex');
const stable=x=>Array.isArray(x)?'['+x.map(stable).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}':JSON.stringify(x);
const SQL=`SELECT receipt_ref,account_ref,contact_ref,program,invitation_request_id,event_ref,policy_revision,reply_kind,reply_to_ref
 FROM coexistence.alekito_beta_receipts WHERE receipt_ref=$1 AND account_ref=$2 AND contact_ref=$3 AND event_ref=$4
 AND program=$5 AND invitation_request_id=$6 AND policy_revision=$7`;
function denied(){const e=Error('HUMAN_READ_SYSTEM_RECEIPT_INVALID');e.code='HUMAN_READ_SYSTEM_RECEIPT_INVALID';throw e;}
function createStoredPublicReceiptVerifier({db,policy,replies}={}){
 return Object.freeze({verify:async({proof,origin,protocol}={})=>{
  const refs=protocol?.evidence_refs;
  if(!Array.isArray(refs)||!refs.some(x=>typeof x==='string'&&x.startsWith('bc_')))return false;
  if(refs.length!==1||!/^bc_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(refs[0])||typeof db?.query!=='function'||proof?.account_ref!==policy.accountRef||typeof origin?.message_id!=='string'||typeof origin?.context_message_id!=='string'||!origin.context_message_id||!['button','interactive'].includes(origin.message_type)||proof.message_ref!=='msg_'+sha(origin.message_id)||proof.ingress_ref!=='in_'+sha(origin.message_id).slice(0,32))denied();
  const found=await db.query(SQL,[refs[0],policy.accountRef,policy.contactRef,proof.message_ref,policy.program,policy.invitation,policy.revision]);
  if(!Array.isArray(found?.rows)||found.rows.length!==1)denied();const r=found.rows[0];
  if(r.receipt_ref!==refs[0]||r.account_ref!==policy.accountRef||r.contact_ref!==policy.contactRef||r.event_ref!==proof.message_ref||r.program!==policy.program||r.invitation_request_id!==policy.invitation||r.policy_revision!==policy.revision||r.reply_to_ref!=='m_'+sha(origin.context_message_id)||!Object.hasOwn(replies,r.reply_kind))denied();
  const expected={schema:'alekito.conversation.response.v1',request_id:proof.request_id,correlation_id:'ak_'+sha(proof.request_id),status:'answer',proposed_reply:replies[r.reply_kind],evidence_refs:[r.receipt_ref],pending_intent:null,capability_request:null,scope_ref:null,policy_version:policy.revision,reason_code:null,side_effects:false,dispatched:false};
  if(stable(expected)!==stable(protocol))denied();return true;
 }});
}
module.exports={createStoredPublicReceiptVerifier,SQL};
