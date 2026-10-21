'use strict';
const P=require('./alekitoBridgePolicy');
class OwnershipError extends Error {constructor(code,status=409){super(code);this.code=code;this.status=status;}}
const CAP='coexistence.alekito_owner_captures', OWN='coexistence.alekito_inbound_ownership';
function createInboundOwnership({pool,waNumber,ownerNumber,accountRef,ownerRef,now=()=>Date.now(),isPaused=()=>process.env.ALEKITO_OWNER_DISPATCH_PAUSED==='1'||process.env.ALEKITO_OWNER_DISPATCH_PAUSED==='true',buttonsEnabled=()=>process.env.ALEKITO_OWNER_BUTTONS_ENABLED==='1'}){
  const wa=P.digits(waNumber),owner=P.digits(ownerNumber),key=`alekito-owner-producer:${accountRef}:${ownerRef}`;
  const validBinding=wa&&owner&&P.hash(wa).slice(0,12)===accountRef&&P.contactRef(wa,owner)===ownerRef;
  const fail=(code,status)=>{throw new OwnershipError(code,status);};
  const lock=db=>db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
  function target(record){return record?.direction==='incoming'&&(['text','audio','voice','image','video','document','location','contacts'].includes(record.message_type)||(buttonsEnabled()&&['button','interactive'].includes(record.message_type)))&&P.digits(record.contact_number)===owner&&P.digits(record.wa_number)===wa;}
  async function claim({db,record}){
    if(!target(record))return {target:false,producer:'legacy',claimed:false};
    if(!validBinding)fail('OWNER_BINDING_INVALID',503);
    if(!/^wamid\.[A-Za-z0-9+/=_-]+$/.test(record.message_id||''))fail('REAL_INGRESS_REQUIRED',403);
    const messageRef=`msg_${P.hash(record.message_id)}`;
    await lock(db);
    const old=(await db.query(`SELECT producer,capture_id,message_ref,message_id,ingress_timestamp,dispatch_state,dispatch_attempts,error_code FROM ${OWN} WHERE account_ref=$1 AND message_ref=$2`,[accountRef,messageRef])).rows[0];
    if(old)return {...old,target:true,claimed:false};
    const grants=(await db.query(`SELECT 1 FROM coexistence.ia360_contact_scope WHERE contact_number=$1 AND activo=true AND rol='owner' LIMIT 1`,[owner])).rows;
    if(!grants.length)fail('OWNER_PERMISSION_REQUIRED',403);
    const paused=Boolean(isPaused());
    const capture=paused?null:(await db.query(`SELECT capture_id FROM ${CAP} WHERE exclusive=true AND message_ref IS NULL AND expires_at>now() AND after_timestamp<$1 AND account_ref=$2 AND contact_ref=$3 ORDER BY created_at,capture_id LIMIT 1 FOR UPDATE`,[record.timestamp,accountRef,ownerRef])).rows[0];
    const producer='canary',dispatchState=paused?'blocked':'pending',errorCode=paused?'ROLLBACK_PAUSED':null;
    const ins=(await db.query(`INSERT INTO ${OWN}(account_ref,message_ref,contact_ref,producer,capture_id,message_id,ingress_timestamp,dispatch_state,dispatch_attempts,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9) RETURNING producer,capture_id,message_ref,message_id,ingress_timestamp,dispatch_state,dispatch_attempts,error_code`,
      [accountRef,messageRef,ownerRef,producer,capture?.capture_id||null,record.message_id,record.timestamp||null,dispatchState,errorCode])).rows[0]||{producer,capture_id:capture?.capture_id||null,message_ref:messageRef,dispatch_state:dispatchState,dispatch_attempts:0,error_code:errorCode};
    if(capture&&ins.dispatch_state!=='blocked'){
      const bound=await db.query(`UPDATE ${CAP} SET message_ref=$2 WHERE capture_id=$1 AND message_ref IS NULL RETURNING capture_id`,[capture.capture_id,messageRef]);
      if(bound.rowCount!==1)fail('CAPTURE_CLAIM_CONFLICT');
    }
    return {target:true,claimed:true,producer:ins.producer||producer,message_ref:messageRef,capture_id:ins.capture_id??(capture?.capture_id||null),dispatch_state:ins.dispatch_state||dispatchState,dispatch_attempts:ins.dispatch_attempts??0,error_code:ins.error_code??errorCode};
  }
  async function arm({capture_id,after}){
    if(!validBinding)fail('OWNER_BINDING_INVALID',503);
    const db=await pool.connect();
    try{
      await db.query('BEGIN');await lock(db);
      let c=(await db.query(`SELECT * FROM ${CAP} WHERE capture_id=$1`,[capture_id])).rows[0];
      if(!c){
        if(Math.abs(now()-Date.parse(after))>30000)fail('CAPTURE_ANCHOR_MUST_BE_CURRENT');
        const active=(await db.query(`SELECT capture_id FROM ${CAP} WHERE exclusive=true AND message_ref IS NULL AND expires_at>now() AND account_ref=$1 AND contact_ref=$2 LIMIT 1`,[accountRef,ownerRef])).rows;
        if(active.length)fail('CAPTURE_ALREADY_ARMED');
        c=(await db.query(`INSERT INTO ${CAP}(capture_id,after_timestamp,expires_at,exclusive,account_ref,contact_ref) VALUES($1,$2,now()+interval '10 minutes',true,$3,$4) RETURNING *`,[capture_id,after,accountRef,ownerRef])).rows[0];
      }
      if(new Date(c.after_timestamp).toISOString()!==new Date(after).toISOString())fail('CAPTURE_ID_CONFLICT');
      if(new Date(c.expires_at).getTime()<=now())fail('CAPTURE_EXPIRED');
      if(c.exclusive!==true)fail('CAPTURE_NOT_EXCLUSIVE');
      if(c.account_ref!==accountRef||c.contact_ref!==ownerRef)fail('CAPTURE_SCOPE_MISMATCH',403);
      await db.query('COMMIT');return c;
    }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  }
  async function assertCanary(record){
    if(!validBinding||!target(record))fail('OWNER_BINDING_INVALID',403);
    const row=(await pool.query(`SELECT producer,capture_id,ingress_timestamp,dispatch_state,dispatch_attempts FROM ${OWN} WHERE account_ref=$1 AND message_ref=$2 AND contact_ref=$3`,[accountRef,`msg_${P.hash(record.message_id)}`,ownerRef])).rows[0];
    if(row?.producer!=='canary')fail('INGRESS_NOT_EXCLUSIVE');
    if(row.ingress_timestamp&&record.timestamp&&new Date(row.ingress_timestamp).getTime()!==new Date(record.timestamp).getTime())fail('INGRESS_TIMESTAMP_IMMUTABLE',409);
    return row;
  }
  return Object.freeze({claim,arm,assertCanary,target});
}
module.exports={createInboundOwnership,OwnershipError};
