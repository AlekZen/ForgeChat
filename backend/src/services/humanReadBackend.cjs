'use strict';
const W=require('./humanReadWire.cjs');
function createHumanReadBackend({enabled=false,resolveVerifiedEndpoint,fetchImpl=fetch,env=process.env,now=Date.now}={}){
 async function perform(body,contextOnly){
  if(!enabled)W.fail('HUMAN_READ_DISABLED',503);W.exact(body,contextOnly?['proof']:['proof','request']);
  const proof=W.proofOf(body.proof),request=contextOnly?{operation:'discover_projects',query:{}}:W.requestOf(body.request);
  if(typeof resolveVerifiedEndpoint!=='function')W.fail('HUMAN_READ_IDENTITY_UNAVAILABLE',503);
  const endpoint=W.endpointOf(await resolveVerifiedEndpoint(proof),proof,now());
  const signed=W.sign({proof,request,endpoint,secret:env.NEXUS_SELLO_FORGECHAT,now:now()});
  const target=new URL(contextOnly?W.CONTEXT_PATH:W.PATH,env.NEXUS_INVITAR_URL||'https://diapazo.com');
  if(target.protocol!=='https:'||target.hostname!=='diapazo.com'||target.port||target.username||target.password)W.fail('HUMAN_READ_TARGET_DENIED');
  const key=env.NEXUS_LLAVE_ALEKITO_WHATSAPP;if(typeof key!=='string'||!key||/[\r\n]/.test(key))W.fail('HUMAN_READ_CLIENT_UNAVAILABLE',503);
  let response,result;
  try{response=await fetchImpl(target,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(signed),signal:AbortSignal.timeout(10000)});if(!response.body)W.fail('HUMAN_READ_INVALID_RESPONSE',502);let size=0;const parts=[];for await(const c of response.body){size+=c.byteLength;if(size>32768)W.fail('HUMAN_READ_INVALID_RESPONSE',502);parts.push(Buffer.from(c))}result=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch(e){if(e instanceof W.HumanReadError)throw e;W.fail('HUMAN_READ_UNAVAILABLE',502)}
  if(!response.ok)W.fail(response.status===403?'HUMAN_READ_REMOTE_DENIED':'HUMAN_READ_REMOTE_UNAVAILABLE',response.status===403?403:502);
  const clean=contextOnly?W.contextOf(result,now()):W.resultOf(result,request);
  const after=W.endpointOf(await resolveVerifiedEndpoint(proof),proof,now());
  if(W.hash(after)!==W.hash(endpoint))W.fail('HUMAN_READ_INGRESS_CHANGED');
  return clean;
 }
 return Object.freeze({read:body=>perform(body,false),readContext:body=>perform(body,true)});
}
module.exports={createHumanReadBackend};
