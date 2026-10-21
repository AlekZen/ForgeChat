'use strict';
// Server-only pause for this owner's piece-update purpose. Never CRM, beta,
// campaign-wide unsubscribe, grants, or a second writer/provider implementation.
const {randomUUID}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const P=require('./alekitoBridgePolicy');
const W=require('./alekitoOwnerReadWire.cjs');
const {NotificationError}=require('./alekitoNotificationError');
const PREF='coexistence.alekito_notification_preferences';
const RECEIPTS='coexistence.alekito_notification_pause_receipts';
const PURPOSE='piece-updates-pry-alekito-forgechat-template86-v1';
const ACK='He pausado las actualizaciones de piezas. Un mensaje que ya estuviera en proceso podría llegar.';
const NOTICE='Las actualizaciones de piezas están pausadas. Esta respuesta no las ha reactivado.';
const fail=(code,status=409)=>{throw new NotificationError(code,status);};
const folded=x=>typeof x==='string'?x.normalize('NFKC').toLocaleLowerCase('es').replace(/[¿?¡!.,]/g,'').trim().replace(/\s+/g,' '):'';
function data(x,depth=0){
 if(depth>14||x===undefined)fail('NOTIFICATION_INVALID_INPUT',400);
 if(x===null||typeof x==='string'||typeof x==='boolean')return x;
 if(typeof x==='number'&&Number.isSafeInteger(x))return x;
 if(typeof x!=='object'||![Object.prototype,Array.prototype,null].includes(Object.getPrototypeOf(x))||Object.getOwnPropertySymbols(x).length)fail('NOTIFICATION_INVALID_INPUT',400);
 const out=Array.isArray(x)?[]:{};
 for(const k of Object.getOwnPropertyNames(x)){if(Array.isArray(x)&&k==='length')continue;
  const d=Object.getOwnPropertyDescriptor(x,k);if(!d||!('value'in d)||!d.enumerable||['__proto__','constructor','prototype'].includes(k))fail('NOTIFICATION_INVALID_INPUT',400);
  out[k]=data(d.value,depth+1);
 }return out;
}
function id(x){if(typeof x==='number'&&!Number.isSafeInteger(x)||!['number','string'].includes(typeof x)||! /^[1-9][0-9]{0,18}$/.test(String(x))||BigInt(x)>9223372036854775807n)fail('NOTIFICATION_ACCOUNT_ID_INVALID',403);return String(x);}
function createNotificationOptout({pool,policy,verifyIngress,verifyExisting,ownerAccount,ownerCanonical,now=Date.now,monotonic=()=>performance.now(),timeoutMs=24000}={}){
 const cfg=data(policy);
 if(!pool?.query||!pool?.connect||![verifyIngress,verifyExisting,ownerAccount].every(f=>typeof f==='function')||ownerCanonical!=='5213322638033'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>25000)fail('NOTIFICATION_OPTOUT_NOT_BOUND',503);
 const lockKey=`alekito-update-pause:${cfg.accountRef}:${cfg.contactRef}:${PURPOSE}`;
 function enabled(){if(cfg.optOutEnabled!==true)fail('NOTIFICATION_OPTOUT_DISABLED',503);
  if(cfg.accountRef!=='af6adeb5076b'||cfg.contactRef!=='c_74634837c171'||cfg.projectRef!=='pry-alekito-forgechat')fail('NOTIFICATION_OPTOUT_SCOPE_INVALID',503);}
 function clock(){const at=now();if(!Number.isSafeInteger(at)||at<0)fail('NOTIFICATION_INVALID_CLOCK',503);return at;}
 function budget(){const start=monotonic();
  function left(){const elapsed=monotonic()-start;if(!Number.isFinite(start)||!Number.isFinite(elapsed)||elapsed<0)fail('NOTIFICATION_INVALID_CLOCK',503);return timeoutMs-elapsed;}
  function check(){if(left()<=0)fail('NOTIFICATION_DEADLINE',503);}
  check.wait=async(work,{late=null,code='NOTIFICATION_DEADLINE'}={})=>{check();let timer,expired=false,value,got=false;
   const promise=Promise.resolve().then(work).then(v=>{got=true;value=v;if(expired&&late)late(v);return v;});
   try{const v=await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new NotificationError(code,503)),Math.max(1,Math.ceil(left())));})]);check();return v;}
   catch(e){expired=true;if(got&&late)late(value);throw e;}finally{clearTimeout(timer);}
  };check.remaining=left;return check;
 }
 async function binding(check){const b=await check.wait(()=>ownerAccount());
  if(b.account_ref!==cfg.accountRef||b.owner_ref!==cfg.contactRef||P.digits(b.owner)!==ownerCanonical)fail('NOTIFICATION_OWNER_REQUIRED',403);return b;}
 async function actor(proof,check,{existing=false}={}){const p=W.proofOf(data(proof)),a=data(await check.wait(()=>(existing?verifyExisting:verifyIngress)(p)));
  if(a.verified!==true||a.account_ref!==cfg.accountRef||a.contact_ref!==cfg.contactRef||['request_id','message_ref','account_ref','digest'].some(k=>a[k]!==p[k]))fail('NOTIFICATION_OWNER_REQUIRED',403);
  if(!existing&&(a.ingress_ref!==p.ingress_ref||a.actor?.identity!=='verified-canary-owner'||!Number.isFinite(Date.parse(a.expires_at))||Date.parse(a.expires_at)<=clock()))fail('NOTIFICATION_OWNER_REQUIRED',403);
  await binding(check);check();return {p,a};
 }
 async function preference(db){return (await db.query(`SELECT * FROM ${PREF} WHERE account_ref=$1 AND contact_ref=$2 AND purpose=$3`,[cfg.accountRef,cfg.contactRef,PURPOSE])).rows[0]||null;}
 async function acquire(db){await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey]);}
 async function lockAndAssert(db){enabled();await acquire(db);if(await preference(db))fail('NOTIFICATION_UPDATES_PAUSED',403);}
 async function assertAllowed(){enabled();const check=budget();if(await check.wait(()=>preference(pool)))fail('NOTIFICATION_UPDATES_PAUSED',403);}
 async function transaction(check,work){
  const client=await check.wait(()=>pool.connect(),{late:c=>c.release(true)});let commitStarted=false,confirmedRollback=false,destroyed=false;
  const db={query:(sql,values)=>check.wait(()=>client.query(sql,values))};
  try{await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');await db.query("SET LOCAL statement_timeout='23000ms'");await acquire(db);check();
   const result=await work(db);check();commitStarted=true;
   const reply=await check.wait(()=>client.query('COMMIT'),{code:'NOTIFICATION_STORE_OUTCOME_UNKNOWN'});
   if(reply.command==='ROLLBACK'){confirmedRollback=true;fail('NOTIFICATION_STORE_ROLLED_BACK',503);}if(reply.command!=='COMMIT')fail('NOTIFICATION_STORE_OUTCOME_UNKNOWN',503);
   check();return result;
  }catch(e){if(commitStarted&&!confirmedRollback){client.release(true);destroyed=true;fail('NOTIFICATION_STORE_OUTCOME_UNKNOWN',503);}
   if(!commitStarted){try{await check.wait(()=>client.query('ROLLBACK'));}catch{client.release(true);destroyed=true;}}
   if(e instanceof NotificationError)throw e;fail('NOTIFICATION_STORAGE_FAILED',503);
  }finally{if(!destroyed)client.release();}
 }
 function protocol(origin,receipt,notice=false){return {schema:'alekito.conversation.response.v1',request_id:origin.request_id,correlation_id:'ak_'+P.hash(origin.request_id),
  status:notice?'blocked':'answer',proposed_reply:notice?NOTICE:ACK,evidence_refs:[receipt],pending_intent:null,capability_request:null,scope_ref:null,
  policy_version:'owner-piece-updates-pause-v1',reason_code:notice?'UPDATES_PAUSED':'OWNER_UPDATES_PAUSED',side_effects:false,dispatched:false};}
 function isPauseInput(origin){return cfg.optOutEnabled===true&&origin.input?.type==='text'&&folded(origin.input?.text)==='baja';}
 async function consume({origin,proof,row}){
  if(!isPauseInput(origin))return null;
  enabled();const check=budget(),{p,a}=await actor(proof,check),b=await binding(check);
  if(row.message_type!=='text'||row.direction!=='incoming'||P.digits(row.wa_number)!==P.digits(b.wa)||P.digits(row.contact_number)!==b.owner||
   'msg_'+P.hash(row.message_id)!==a.message_ref||folded(row.message_body)!=='baja'||a.request_id!==origin.request_id)fail('NOTIFICATION_INGRESS_MISMATCH',403);
  return transaction(check,async db=>{
   const old=(await db.query(`SELECT * FROM ${RECEIPTS} WHERE account_ref=$1 AND contact_ref=$2 AND purpose=$3 AND event_ref=$4`,[cfg.accountRef,cfg.contactRef,PURPOSE,a.message_ref])).rows[0];
   if(old){if(old.input_digest!==p.digest||old.turn_request_id!==a.request_id)fail('NOTIFICATION_PAUSE_EVENT_CONFLICT');return old.protocol_response;}
   const receipt='np_'+randomUUID(),response=protocol(a,receipt);await actor(p,check);check();
   await db.query(`INSERT INTO ${RECEIPTS}(receipt_ref,turn_request_id,event_ref,account_ref,contact_ref,purpose,input_digest,protocol_response,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[receipt,a.request_id,a.message_ref,cfg.accountRef,cfg.contactRef,PURPOSE,p.digest,JSON.stringify(response),new Date(clock()).toISOString()]);
   await db.query(`INSERT INTO ${PREF}(account_ref,contact_ref,purpose,state,version,last_receipt_ref,updated_at) VALUES($1,$2,$3,'paused',1,$4,$5)
    ON CONFLICT(account_ref,contact_ref,purpose) DO UPDATE SET state='paused',version=alekito_notification_preferences.version+1,last_receipt_ref=EXCLUDED.last_receipt_ref,updated_at=EXCLUDED.updated_at`,
    [cfg.accountRef,cfg.contactRef,PURPOSE,receipt,new Date(clock()).toISOString()]);check();return response;
  });
 }
 async function pausedProtocol(origin,db=pool){enabled();const pref=await preference(db);return pref?protocol(origin,pref.last_receipt_ref,true):null;}
 async function validateResult({origin,proof,protocol:response}){
  const evidence=response?.evidence_refs?.filter(x=>typeof x==='string'&&x.startsWith('np_'))||[];if(!evidence.length)return false;
  enabled();const check=budget(),{p,a}=await actor(proof,check,{existing:true});
  const receipt=(await check.wait(()=>pool.query(`SELECT * FROM ${RECEIPTS} WHERE receipt_ref=$1 AND account_ref=$2 AND contact_ref=$3 AND purpose=$4`,[evidence[0],cfg.accountRef,cfg.contactRef,PURPOSE]))).rows[0];
  const pref=await check.wait(()=>preference(pool));if(!receipt||!pref||a.request_id!==origin.request_id)fail('NOTIFICATION_PAUSE_RESULT_INVALID',403);
  if(response.reason_code==='UPDATES_PAUSED'){
   if(P.stable(response)!==P.stable(protocol(a,receipt.receipt_ref,true)))fail('NOTIFICATION_PAUSE_RESULT_INVALID',403);
  }else if(receipt.turn_request_id!==p.request_id||receipt.event_ref!==p.message_ref||receipt.input_digest!==p.digest||P.stable(receipt.protocol_response)!==P.stable(response))fail('NOTIFICATION_PAUSE_RESULT_INVALID',403);
  check();return true;
 }
 async function withOwnerEgress({job,account},send){
  // account was resolved by getAccountWithToken, not an HTTP/model identity.
  const template86=job?.kind==='template'&&job.payload?.name==='ia360_seguimiento_entregable_v1'&&job.payload?.languageCode==='es_MX';
  const possibleDetail=job?.kind==='text'&&typeof job.alekitoConversationRequestId==='string';
  if((!template86&&!possibleDetail)||P.digits(job.to)!==ownerCanonical)return send();
  const check=budget(),b=await binding(check);if(id(account.id)!==id(b.account.id)||id(job.accountId)!==id(b.account.id))return send();
  let detail=false;
  if(possibleDetail){const records=(await check.wait(()=>pool.query(`SELECT protocol_response FROM coexistence.alekito_conversation_turns
    WHERE request_id=$1 AND account_ref=$2 AND contact_ref=$3 AND correlation_id=$4`,[job.alekitoConversationRequestId,cfg.accountRef,cfg.contactRef,job.localMessageId]))).rows;
   if(records.length>1)fail('NOTIFICATION_RESULT_BINDING_INVALID',403);
   detail=records.length===1&&Array.isArray(records[0].protocol_response?.evidence_refs)&&records[0].protocol_response.evidence_refs.some(ref=>typeof ref==='string'&&ref.startsWith('nf_'));
  }
  if(!template86&&!detail)return send();enabled();
  const client=await check.wait(()=>pool.connect(),{late:c=>c.release(true)});let started=false,destroy=false,signal;
  const db={query:(sql,values)=>check.wait(()=>client.query(sql,values))};
  try{await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');await db.query("SET LOCAL statement_timeout='500ms'");await lockAndAssert(db);check();
   // The final awaited permission/lock operation is above. The EXISTING provider
   // function is invoked here while holding the SAME pause lock. No new sender.
   // Current metaSend.postJson calls fetch synchronously before its first await.
   // Capture that EXISTING request's promise and release the scope lock BEFORE
   // awaiting its HTTP/body result. STOP never queues behind 5x provider timeout.
   // Waiters reread the durable pause; a fetch initiated here may already be in flight.
   signal=AbortSignal.timeout(Math.max(1,Math.min(12000,Math.floor(check.remaining()))));
   check();started=true;const request=Promise.resolve(send({signal})).catch(e=>{
    if(signal.aborted){const error=new NotificationError('NOTIFICATION_PROVIDER_OUTCOME_UNKNOWN',503);error.skipRetry=true;error.providerAcceptancePossible=true;throw error;}throw e;
   });
   request.catch(()=>{}); // Observe early rejection while lock cleanup is pending.
   return request;
  }catch(e){if(!started){const error=e instanceof NotificationError?e:new NotificationError('NOTIFICATION_EGRESS_GUARD_FAILED',503);
    error.skipRetry=true;error.notificationSuppressed=true;throw error;}
   if(signal?.aborted){const error=new NotificationError('NOTIFICATION_PROVIDER_OUTCOME_UNKNOWN',503);error.skipRetry=true;error.providerAcceptancePossible=true;throw error;}throw e;}
  finally{
   // Read/lock transaction only: releasing it cannot invalidate a known provider
   // result. A cleanup failure must not hide a returned wamid or trigger resend.
   let timer;
   try{await Promise.race([client.query('ROLLBACK'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('cleanup timeout')),1000);timer.unref?.();})]);}
   catch{destroy=true;}finally{clearTimeout(timer);}client.release(destroy);
  }
 }
 return Object.freeze({isPauseInput,consume,validateResult,assertAllowed,lockAndAssert,acquire,pausedProtocol,withOwnerEgress,PURPOSE});
}
module.exports={createNotificationOptout,PURPOSE,ACK,NOTICE};
