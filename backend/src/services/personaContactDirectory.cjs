'use strict';
// Target src/services/personaContactDirectory.cjs. Dedicated read-only route, no changes to /internal/alekito middleware.
const W=require('./personaContactWire.cjs');
const CONTACTS_SQL='SELECT c.id,c.wa_number,c.contact_number FROM coexistence.contacts c ORDER BY c.id LIMIT 10001';
function createContactDirectoryHandler({pool,P,secret,now=Date.now}){
 return async function handle(req,res){
  res.set('Cache-Control','no-store');
  try{
   if(req.method!=='POST'||req.path!==W.PATH||typeof pool?.query!=='function'||typeof P?.contactRef!=='function'||typeof P?.hash!=='function'||typeof P?.digits!=='function')W.fail();
   if(Buffer.byteLength(JSON.stringify(req.body??{}))>8192)W.fail();
   const request=W.requestOf(W.verified(req.body,secret),now()),rows=(await pool.query(CONTACTS_SQL)).rows;
   if(!Array.isArray(rows)||rows.length>10000)W.fail();
   const matches=rows.filter(r=>P.hash(P.digits(r.wa_number)).slice(0,12)===request.query.account_ref&&P.contactRef(r.wa_number,r.contact_number)===request.query.contact_ref);
   if(matches.length>1)W.fail();
   const row=matches[0],result=row?{...request.query,source_digest:P.hash(JSON.stringify({id:String(row.id),wa:P.digits(row.wa_number),contact:P.digits(row.contact_number)}))}:null;
   W.requestOf(request,now());
   return res.json(W.seal({schema:W.SCHEMA,purpose:'read_contact_response',audience:'nexus-persona-directory-client',nonce:request.nonce,query:request.query,issued_at:now(),expires_at:request.expires_at,result},secret));
  }catch{return res.status(503).json({error_code:'PERSONA_DIRECTORY_UNAVAILABLE'});}
 };
}
function mountPersonaContactDirectory(app,{pool,P,secret,now}){app.post(W.PATH,createContactDirectoryHandler({pool,P,secret,now}));}
module.exports={mountPersonaContactDirectory,createContactDirectoryHandler,CONTACTS_SQL};
