'use strict';
const W=require('./alekitoOwnerReadWire.cjs');
function createOwnerProjectBinding({verifyOwnerIngress,ownerRef,accountRef,env=process.env,fetchImpl=fetch,now=Date.now}){
 if(typeof verifyOwnerIngress!=='function')W.fail('OWNER_READ_NOT_CONFIGURED',503);
 async function verified(proof){const actor=await verifyOwnerIngress(proof);if(actor?.contact_ref!==ownerRef||actor.account_ref!==accountRef)W.fail('OWNER_READ_FRESH_OWNER_REQUIRED');return actor;}
 return Object.freeze({read:async body=>{
  W.exact(body,['proof','query']);const proof=W.proofOf(body.proof),query=W.queryOf(body.query);
  const actor=await verified(proof);const envelope=W.sign({proof,query,actor,secret:env.NEXUS_SELLO_FORGECHAT,now:now()});
  if(typeof env.NEXUS_LLAVE_ALEKITO_WHATSAPP!=='string'||!env.NEXUS_LLAVE_ALEKITO_WHATSAPP)W.fail('OWNER_READ_NOT_CONFIGURED',503);
  const target=new URL('/api/v1/nexus/alekito/owner-read',env.NEXUS_INVITAR_URL||'https://diapazo.com');
  if(target.protocol!=='https:'||target.hostname!=='diapazo.com'||target.port||target.username||target.password)W.fail('OWNER_READ_TARGET_DENIED');
  let response,data;
  try{
   response=await fetchImpl(target,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+env.NEXUS_LLAVE_ALEKITO_WHATSAPP,'Content-Type':'application/json'},body:JSON.stringify(envelope),signal:AbortSignal.timeout(10000)});
   if(!response.body)W.fail('OWNER_READ_INVALID_RESPONSE',502);
   let bytes=0;const chunks=[];
   for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>32768){await response.body.cancel().catch(()=>{});W.fail('OWNER_READ_RESPONSE_TOO_LARGE',502);}chunks.push(Buffer.from(chunk));}
   data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch(error){if(error instanceof W.OwnerReadError)throw error;W.fail('OWNER_READ_UNAVAILABLE',502);}
  if(!response.ok||data?.ok!==true)W.fail(['OWNER_READ_GRANT_DENIED','OWNER_READ_NOT_FOUND','OWNER_READ_ATTESTATION_EXPIRED'].includes(data?.error_code)?data.error_code:'OWNER_READ_REMOTE_DENIED',response.status===404?404:403);
  if(data.schema!=='alekito.owner-project-read.v1'||data.project_ref!==W.PROJECT||data.operation!==query.operation||data.request_id!==proof.request_id||data.subject_ref!==ownerRef||data.account_ref!==accountRef||data.read_only!==true||!Array.isArray(data.items)||data.items.length>5)W.fail('OWNER_READ_INVALID_RESPONSE',502);
  W.exact(data,['ok','schema','request_id','subject_ref','account_ref','project_ref','operation','read_only','decision_ref','source','read_at','items']);
  if(data.source!==(query.operation==='piece.read'?'nexus.mision':'nexus.knowledge')||typeof data.decision_ref!=='string'||!/^ord_[a-f0-9]{24}$/.test(data.decision_ref)||typeof data.read_at!=='string'||!Number.isFinite(Date.parse(data.read_at)))W.fail('OWNER_READ_INVALID_RESPONSE',502);
  const fields=query.operation==='piece.read'?['id','tipo','titulo','estado','version','actualizado_en','subestado','fase']:['id','tipo','titulo','texto','por_que','como_aplicar','estado','fuente','version'];
  for(const item of data.items){if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!fields.includes(k)))W.fail('OWNER_READ_INVALID_RESPONSE',502);for(const [k,v]of Object.entries(item))if(k==='version'?!Number.isSafeInteger(v):typeof v!=='string'||v.length>12000)W.fail('OWNER_READ_INVALID_RESPONSE',502);}
  // A remote read never bypasses a fresh check of the local owner grant.
  const after=await verified(proof);W.sign({proof,query,actor:after,secret:env.NEXUS_SELLO_FORGECHAT,now:now()});
  return data;
 }});
}
module.exports={createOwnerProjectBinding};
