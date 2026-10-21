'use strict';
const {createHmac,hkdfSync,timingSafeEqual,randomUUID}=require('node:crypto');
const PROJECT='pry-alekito-forgechat',SCHEMA='alekito.owner-project-attestation.v1',TTL=30;
class OwnerReadError extends Error {constructor(code,status=403){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new OwnerReadError(code,status);};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function exact(x,keys){if(!object(x)||Object.keys(x).some(k=>!keys.includes(k))||keys.some(k=>x[k]===undefined))fail('OWNER_READ_INVALID_INPUT',400);}
function stable(x){return Array.isArray(x)?'['+x.map(stable).join(',')+']':object(x)?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}':JSON.stringify(x);}
function queryOf(x){
 if(!object(x)||x.project_ref!==PROJECT)fail('OWNER_READ_PROJECT_DENIED');
 if(x.operation==='piece.read'){exact(x,['project_ref','operation','piece_ref']);if(typeof x.piece_ref!=='string'||!/^[-a-zA-Z0-9_:.]{1,120}$/.test(x.piece_ref))fail('OWNER_READ_INVALID_INPUT',400);}
 else if(x.operation==='lessons.read'){exact(x,['project_ref','operation','question']);if(typeof x.question!=='string'||!x.question.trim()||x.question.length>2000)fail('OWNER_READ_INVALID_INPUT',400);}
 else fail('OWNER_READ_OPERATION_DENIED');
 return structuredClone(x);
}
function proofOf(x){exact(x,['ingress_ref','message_ref','request_id','account_ref','digest']);if(!/^in_[a-f0-9]{32}$/.test(x.ingress_ref)||!/^msg_[a-f0-9]{64}$/.test(x.message_ref)||!/^req_[a-f0-9]{64}$/.test(x.request_id)||! /^[a-f0-9]{12}$/.test(x.account_ref)||! /^[a-f0-9]{64}$/.test(x.digest))fail('OWNER_READ_INVALID_PROOF',400);return structuredClone(x);}
function key(secret){if(typeof secret!=='string'||!secret)fail('OWNER_READ_NOT_CONFIGURED',503);return hkdfSync('sha256',Buffer.from(secret,'utf8'),Buffer.from(SCHEMA),Buffer.from('forgechat-to-nexus-owner-read'),32);}
function signature(payload,secret){return createHmac('sha256',key(secret)).update(SCHEMA+'\0'+stable(payload)).digest();}
function sign({proof,query,actor,secret,now=Date.now()}){
 const p=proofOf(proof),q=queryOf(query);const issued_at=Math.floor(now/1000),ownerExpiry=Math.floor(Date.parse(actor?.expires_at)/1000);
 if(actor?.verified!==true||actor.actor?.identity!=='verified-canary-owner'||actor.request_id!==p.request_id||actor.message_ref!==p.message_ref||actor.ingress_ref!==p.ingress_ref||actor.account_ref!==p.account_ref||actor.digest!==p.digest||!/^c_[a-f0-9]{12}$/.test(actor.contact_ref)||!Number.isFinite(ownerExpiry)||ownerExpiry<=issued_at)fail('OWNER_READ_FRESH_OWNER_REQUIRED');
 const payload={schema:SCHEMA,proof:p,query:q,subject_ref:actor.contact_ref,issued_at,expires_at:Math.min(issued_at+TTL,ownerExpiry),nonce:randomUUID()};
 return {payload,signature:signature(payload,secret).toString('base64url')};
}
function verify(envelope,secret,now=Date.now()){
 exact(envelope,['payload','signature']);const p=envelope.payload;
 exact(p,['schema','proof','query','subject_ref','issued_at','expires_at','nonce']);
 if(p.schema!==SCHEMA||!/^c_[a-f0-9]{12}$/.test(p.subject_ref)||! /^[a-f0-9-]{36}$/.test(p.nonce))fail('OWNER_READ_INVALID_ATTESTATION');
 proofOf(p.proof);queryOf(p.query);
 if(typeof envelope.signature!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(envelope.signature))fail('OWNER_READ_INVALID_SIGNATURE');
 const provided=Buffer.from(envelope.signature,'base64url'),expected=signature(p,secret);
 if(provided.length!==expected.length||!timingSafeEqual(provided,expected))fail('OWNER_READ_INVALID_SIGNATURE');
 const seconds=Math.floor(now/1000);
 if(!Number.isSafeInteger(p.issued_at)||!Number.isSafeInteger(p.expires_at)||p.issued_at>seconds+2||p.expires_at<=seconds||p.expires_at<=p.issued_at||p.expires_at-p.issued_at>TTL||seconds-p.issued_at>TTL)fail('OWNER_READ_ATTESTATION_EXPIRED');
 return structuredClone(p);
}
module.exports={PROJECT,SCHEMA,TTL,OwnerReadError,fail,exact,stable,queryOf,proofOf,sign,verify};
