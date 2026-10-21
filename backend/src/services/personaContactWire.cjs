'use strict';
const {createHmac,randomBytes,timingSafeEqual}=require('node:crypto');
const stable=x=>Array.isArray(x)?'['+x.map(stable).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}':JSON.stringify(x);
const PATH='/api/nexus/persona-contact-directory-v1',SCHEMA='nexus.persona-contact-directory.v1';
function fail(){const e=new Error('PERSONA_DIRECTORY_UNAVAILABLE');e.code='PERSONA_DIRECTORY_UNAVAILABLE';throw e;}
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
function signature(body,secret){if(typeof secret!=='string'||secret.length<32)fail();return createHmac('sha256',secret).update(stable(body)).digest('hex');}
function seal(body,secret){return {...body,signature:signature(body,secret)};}
function verified(envelope,secret){if(!envelope||typeof envelope.signature!=='string'||!/^[a-f0-9]{64}$/.test(envelope.signature))fail();const {signature:s,...body}=envelope,want=signature(body,secret);if(!timingSafeEqual(Buffer.from(s,'hex'),Buffer.from(want,'hex')))fail();return body;}
function requestOf(body,now){
 if(!exact(body,['schema','purpose','audience','method','path','nonce','issued_at','expires_at','query'])||body.schema!==SCHEMA||body.purpose!=='read_contact'||body.audience!=='forgechat-persona-directory'||body.method!=='POST'||body.path!==PATH||!/^[a-f0-9]{32}$/.test(body.nonce)||!Number.isSafeInteger(body.issued_at)||!Number.isSafeInteger(body.expires_at)||body.issued_at>now+1000||body.expires_at<=now||body.expires_at>body.issued_at+30000||body.expires_at<=body.issued_at||!exact(body.query,['account_ref','contact_ref'])||typeof body.query.account_ref!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(body.query.account_ref)||!/^c_[a-f0-9]{12}$/.test(body.query.contact_ref))fail();return body;
}
function resultOf(result,query){if(result===null)return null;if(!exact(result,['account_ref','contact_ref','source_digest'])||result.account_ref!==query.account_ref||result.contact_ref!==query.contact_ref||!/^[a-f0-9]{64}$/.test(result.source_digest))fail();return result;}
function createDirectoryClient({baseUrl='https://wa.geekstudio.dev',secret,fetchImpl=fetch,now=Date.now}){
 const base=new URL(baseUrl);if(base.origin!=='https://wa.geekstudio.dev'||base.pathname!=='/'||base.username||base.password||base.search||base.hash)fail();
 async function resolve(query){
  const issued=now(),body=requestOf({schema:SCHEMA,purpose:'read_contact',audience:'forgechat-persona-directory',method:'POST',path:PATH,nonce:randomBytes(16).toString('hex'),issued_at:issued,expires_at:issued+30000,query},issued);
  try{
   const response=await fetchImpl(base.origin+PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(seal(body,secret)),redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!response.ok)fail();const raw=await response.text();if(Buffer.byteLength(raw)>8192)fail();const out=verified(JSON.parse(raw),secret);
   if(!exact(out,['schema','purpose','audience','nonce','query','issued_at','expires_at','result'])||out.schema!==SCHEMA||out.purpose!=='read_contact_response'||out.audience!=='nexus-persona-directory-client'||out.nonce!==body.nonce||stable(out.query)!==stable(body.query)||!Number.isSafeInteger(out.issued_at)||!Number.isSafeInteger(out.expires_at)||out.issued_at<body.issued_at||out.issued_at>now()+1000||out.expires_at>body.expires_at||out.expires_at<=now())fail();return resultOf(out.result,body.query);
  }catch{fail();}
 }
 return Object.freeze({resolve});
}
module.exports={PATH,SCHEMA,seal,verified,requestOf,resultOf,createDirectoryClient,fail};
