'use strict';
const {createHash,randomUUID}=require('node:crypto');
const stable=x=>Array.isArray(x)?'['+x.map(stable).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}':JSON.stringify(x);
const hash=x=>createHash('sha256').update(stable(x)).digest('hex');
class CaptureError extends Error{constructor(code,status=403){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new CaptureError(code,status);};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function exact(x,keys){if(!object(x)||Object.keys(x).sort().join(',')!==[...keys].sort().join(','))fail('CAPTURE_INVALID_DTO',400);}
const normalize=x=>x.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s+/g,' ').trim();
function label(x){if(typeof x!=='string'||x.length>200||/[\u0000-\u001f\u007f]/.test(x)||!normalize(x))fail('CAPTURE_INVALID_DTO',400);return x.trim();}
function requestOf(x){exact(x,['query','command']);if(!object(x.query)||Object.keys(x.query).some(k=>!['company_name','project_name'].includes(k))||!Object.hasOwn(x.query,'project_name'))fail('CAPTURE_INVALID_DTO',400);const query=Object.fromEntries(Object.entries(x.query).map(([k,v])=>[k,label(v)]));exact(x.command,['tipo','texto']);if(!['idea','encargo'].includes(x.command.tipo)||typeof x.command.texto!=='string')fail('CAPTURE_INVALID_DTO',400);const texto=x.command.texto.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g,'').trim();if(texto.length<2||texto.length>600)fail('CAPTURE_INVALID_DTO',400);return {query,command:{tipo:x.command.tipo,texto}};}
function proofOf(p){exact(p,['ingress_ref','message_ref','request_id','account_ref','digest']);if(!/^in_[a-f0-9]{32}$/.test(p.ingress_ref)||!/^msg_[a-f0-9]{64}$/.test(p.message_ref)||!/^req_[a-f0-9]{64}$/.test(p.request_id)||!/^\w[-\w]{0,159}$/.test(p.account_ref)||!/^[a-f0-9]{64}$/.test(p.digest))fail('CAPTURE_PROOF_DENIED');return structuredClone(p);}
const keyOf=proof=>'hmc_'+hash({purpose:'human-mission-capture.v1',proof:proofOf(proof)});
const ownerKey=i=>({persona_id:i.persona_id,uid:i.uid,master:i.master,authority_digest:i.authority_digest,binding_digest:i.binding_digest});
function ownerOf(i,now){if(!object(i)||!/^per-[a-z0-9-]{1,120}$/.test(i.persona_id)||i.master!==true||i.uid!==null&&!(typeof i.uid==='string'&&i.uid)||!['authority_digest','binding_digest'].every(k=>/^[a-f0-9]{64}$/.test(i[k]))||!Number.isFinite(i.expires_at)||i.expires_at<=now||Object.hasOwn(i,'agente')||Object.hasOwn(i,'dueno'))fail('CAPTURE_OWNER_REQUIRED');return i;}
function result(status,{receipt_ref=null,receipt=null,options=[],complete=true}={}){return {schema:'alekito.human-mission-capture-result.v1',status,receipt_ref:receipt?.receipt_ref??receipt_ref,receipt,options,complete,retry_capture:false};}
function privateBinding(p,e,now){if(e?.verified!==true||e.provider!=='whatsapp'||e.business_account_ref!==p.account_ref||hash(e.proof)!==hash(p)||!/^c_[a-f0-9]{12}$/.test(e.contact_ref)||!Number.isFinite(Date.parse(e.expires_at))||Date.parse(e.expires_at)<=now)fail('CAPTURE_ENDPOINT_DENIED');}
function createCaptureService({enabled=false,canonical,store,now=Date.now}={}){
 if(!canonical||['capturar','yo','accesoAProyecto','urlDePieza'].some(k=>typeof canonical[k]!=='function')||typeof store?.atomic!=='function')fail('CAPTURE_UNBOUND',503);
 async function checkedIdentity(tx,endpoint,original){const i=ownerOf(await (original?tx.identity.revalidate(original,endpoint):tx.identity.resolve(endpoint)),now());if(original&&stable(ownerKey(i))!==stable(ownerKey(original)))fail('CAPTURE_AUTHORITY_CHANGED');return i;}
 async function readback(tx,row,id){const a=await canonical.accesoAProyecto(tx.mission,id,row.project_ref,()=>new Date(now()));if(!a||a.p.empresa_id!==row.company_ref||a.permiso.vista!=='interna'||a.permiso.rol!=='master')fail('CAPTURE_PROJECT_DENIED');const p=await tx.mission.pieza({empresa_id:row.company_ref,proyecto_id:row.project_ref},row.piece_ref);if(!p||p._id!==row.project_ref+'/'+row.piece_ref||!Number.isSafeInteger(p.version)||p.version<1)fail('CAPTURE_RECEIPT_INCONSISTENT',503);return {receipt_ref:row._id,piece_ref:row.piece_ref,project_ref:row.project_ref,titulo:p.titulo,tipo:p.tipo,estado:p.estado,version:p.version,url:canonical.urlDePieza(row.project_ref,row.piece_ref,p.titulo),original_outcome:structuredClone(row.original_outcome),recorded_at:row.recorded_at??row.created_at};}
 async function capture({request,proof,endpoint}){
  if(!enabled)fail('CAPTURE_DISABLED',503);const r=requestOf(request),p=proofOf(proof),key=keyOf(p),digest=hash(r),token=randomUUID();privateBinding(p,endpoint,now());
  // Separate durable reservation prevents a later HTTP/model attempt from replaying an unknown mutation.
  // It contains hashes/scope, not text, credentials, phone or a resumable command.
  const prepared=await store.atomic(async tx=>{
   const original=await checkedIdentity(tx,endpoint),id={persona_id:original.persona_id,uid:original.uid,master:true};
   const prior=await tx.receipt(key);
   if(prior){if(prior.request_digest!==digest||prior.proof_digest!==hash(p)||prior.persona_id!==original.persona_id||prior.account_ref!==endpoint.business_account_ref||prior.contact_ref!==endpoint.contact_ref)fail('CAPTURE_IDEMPOTENCY_CONFLICT',409);if(prior.phase!=='committed'){await checkedIdentity(tx,endpoint,original);return result('unknown',{receipt_ref:key});}const receipt=await readback(tx,prior,id);await checkedIdentity(tx,endpoint,original);return result('recorded',{receipt});}
   const own=await canonical.yo(tx.mission,id,()=>new Date(now()));if(own.estado!==200||!Array.isArray(own.cuerpo.proyectos))fail('CAPTURE_PROJECT_DENIED');
   const targets=[];
   for(const item of own.cuerpo.proyectos){if(typeof item.titulo!=='string'||!normalize(item.titulo).includes(normalize(r.query.project_name)))continue;const access=await canonical.accesoAProyecto(tx.mission,id,item.id,()=>new Date(now()));if(!access||access.permiso.vista!=='interna'||access.permiso.rol!=='master')continue;const company=label(await tx.companyLabel(access.p.empresa_id));if(r.query.company_name&&!normalize(company).includes(normalize(r.query.company_name)))continue;targets.push({project:access.p,company_name:company,project_name:item.titulo});}
   await checkedIdentity(tx,endpoint,original);if(!targets.length)return result('not_found');if(targets.length!==1)return result('clarify',{options:targets.slice(0,20).map(t=>({company_name:t.company_name,project_name:t.project_name})),complete:targets.length<=20});
   const project=targets[0].project;await tx.fenceAuthority(original,endpoint);await tx.fenceProject(project);
   const row={_id:key,phase:'reserved',request_ref:p.request_id,authority_digest:original.authority_digest,binding_digest:original.binding_digest,attempt_digest:hash(token),proof_digest:hash(p),request_digest:digest,persona_id:original.persona_id,account_ref:endpoint.business_account_ref,contact_ref:endpoint.contact_ref,company_ref:project.empresa_id,project_ref:project._id,project_version:project.version,source:{channel:'whatsapp',transport:'alekito-whatsapp'},project_name:targets[0].project_name,company_name:targets[0].company_name,capture_tipo:r.command.tipo,created_at:new Date(now()).toISOString()};await tx.saveReceipt(row,null);await checkedIdentity(tx,endpoint,original);return {ready:true,original};
  });
  if(prepared.ready!==true)return prepared;
  return store.atomic(async tx=>{
   const original=await checkedIdentity(tx,endpoint,prepared.original),id={persona_id:original.persona_id,uid:original.uid,master:true},row=await tx.receipt(key);
   if(!row||row.phase!=='reserved'||row.attempt_digest!==hash(token)||row.request_digest!==digest||row.persona_id!==original.persona_id)fail('CAPTURE_RESERVATION_CHANGED',409);
   const access=await canonical.accesoAProyecto(tx.mission,id,row.project_ref,()=>new Date(now()));if(!access||access.p.empresa_id!==row.company_ref||access.p.version!==row.project_version||access.permiso.rol!=='master'||access.permiso.vista!=='interna')fail('CAPTURE_PROJECT_CHANGED',409);
   await tx.fenceAuthority(original,endpoint);await tx.fenceProject(access.p);
   const native=await canonical.capturar(tx.mission,id,row.project_ref,r.command,()=>new Date(now()),'whatsapp_alekito');let piece,created;
   if(native.estado===201&&typeof native.cuerpo?.id==='string'){piece=native.cuerpo.id;created=true;}else if(native.estado===409&&typeof native.cuerpo?.parecida?.id==='string'){piece=native.cuerpo.parecida.id;created=false;}else fail('CAPTURE_NATIVE_REJECTED',native.estado===409?409:400);
   const live=await tx.mission.pieza({empresa_id:row.company_ref,proyecto_id:row.project_ref},piece);if(!live)fail('CAPTURE_RECEIPT_INCONSISTENT',503);
   const committed={...row,phase:'committed',piece_ref:piece,original_outcome:{created,estado:live.estado,version:live.version},recorded_at:new Date(now()).toISOString()};await tx.saveReceipt(committed,'reserved');await checkedIdentity(tx,endpoint,original);const receipt=await readback(tx,committed,id);await checkedIdentity(tx,endpoint,original);return result('recorded',{receipt});
  });
 }
 async function status({receipt_ref,proof,endpoint}){
  if(!enabled)fail('CAPTURE_DISABLED',503);privateBinding(proofOf(proof),endpoint,now());if(receipt_ref!==undefined&&!/^hmc_[a-f0-9]{64}$/.test(receipt_ref))fail('CAPTURE_INVALID_DTO',400);
  return store.atomic(async tx=>{const original=await checkedIdentity(tx,endpoint);if(receipt_ref===undefined){const rows=await tx.receiptsForScope({persona_id:original.persona_id,account_ref:endpoint.business_account_ref,contact_ref:endpoint.contact_ref});await checkedIdentity(tx,endpoint,original);if(!rows.length)return result('not_found');if(rows.length>1){const options=[];for(const row of rows.slice(0,2)){const option={receipt_ref:row._id,project_name:row.project_name,company_name:row.company_name,tipo:row.capture_tipo,created_at:row.created_at};if(row.phase==='committed')option.titulo=(await readback(tx,row,{persona_id:original.persona_id,uid:original.uid,master:true})).titulo;options.push(option);}await checkedIdentity(tx,endpoint,original);return result('clarify',{options,complete:false});}receipt_ref=rows[0]._id;}const row=await tx.receipt(receipt_ref);if(!row){await checkedIdentity(tx,endpoint,original);return result('unknown',{receipt_ref});}if(row.persona_id!==original.persona_id||row.account_ref!==endpoint.business_account_ref||row.contact_ref!==endpoint.contact_ref)fail('CAPTURE_CORRELATION_DENIED');if(row.phase!=='committed'){await checkedIdentity(tx,endpoint,original);return result('unknown',{receipt_ref});}const receipt=await readback(tx,row,{persona_id:original.persona_id,uid:original.uid,master:true});await checkedIdentity(tx,endpoint,original);return result('recorded',{receipt});},{readOnly:true});
 }

 return Object.freeze({capture,status});
}
module.exports={createCaptureService,CaptureError,requestOf,proofOf,keyOf,ownerOf,ownerKey,hash,stable,normalize,result,fail,exact};
