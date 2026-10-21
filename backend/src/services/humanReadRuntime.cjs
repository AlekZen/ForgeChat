'use strict';
const bridge=require('./alekitoBridge');
const {createHumanReadBackend}=require('./humanReadBackend.cjs');
const W=require('./humanReadWire.cjs');
const {createHumanHistoryGuard}=require('./humanHistoryGuard.cjs');
const policy=require('./alekitoHumanReadPolicy.cjs');
const transport=createHumanReadBackend({enabled:policy.enabled===true||policy.historyProtection===true,resolveVerifiedEndpoint:bridge.resolveVerifiedHumanReadEndpoint});
let historyGuard;
function guard(db){return historyGuard??=createHumanHistoryGuard({db,readCurrentContext:body=>transport.readContext(body)})}
module.exports={
 read:async body=>{
  if(!policy.enabled)throw Object.assign(Error('HUMAN_READ_DISABLED'),{code:'HUMAN_READ_DISABLED'});
  if(!historyGuard)throw Object.assign(Error('HUMAN_READ_UNAVAILABLE'),{code:'HUMAN_READ_UNAVAILABLE'});
  try{await historyGuard.assertTurnPolicy({proof:body?.proof})}
  catch(error){
   if(error?.code==='HUMAN_HISTORY_TURN_POLICY_DENIED'){
    const context=await transport.readContext({proof:body?.proof});
    if(context.linked===false)return W.emptyResult(W.requestOf(body.request).operation,'identity_not_linked','IDENTITY_NOT_LINKED');
   }
   throw error;
  }
  return await transport.read(body);
 },
 createHistoryGuard:db=>{
  if(policy.historyProtection!==true)throw Error('HUMAN_HISTORY_PROTECTION_REQUIRED');
  return guard(db);
 }
};
