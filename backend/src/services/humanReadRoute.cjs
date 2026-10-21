'use strict';
const W=require('./humanReadWire.cjs');
function createHumanReadRoute({service}={}){
 return async(req,res)=>{
  try{return res.json(await service.read(req.body))}
  catch(error){
   const op=W.OPS.includes(req.body?.request?.operation)?req.body.request.operation:'discover_projects';
   const code=W.safeCode(error?.code);
   const status=['HUMAN_READ_INVALID_QUERY','HUMAN_READ_PROJECT_NAME_REQUIRED','HUMAN_READ_PIECE_TITLE_REQUIRED'].includes(code)?'clarify':'unavailable';
   // Route mounts INSIDE existing internal authentication. Returning a controlled
   // tool result does not relax bearer/peer checks and avoids an A16 tool crash.
   return res.json(W.emptyResult(op,status,code));
  }
 };
}
module.exports={createHumanReadRoute};
