'use strict';
// SQL implementation only. A pool must be injected; this module never opens a DB.
const {randomUUID}=require('node:crypto');
const TABLE='coexistence.alekito_conversation_turns';
class LedgerError extends Error {constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new LedgerError(code);};
function ref(v){if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(v))fail('INVALID_REFERENCE');return v;}
function digest(v){if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail('INVALID_DIGEST');return v;}
function scope(s){return {request_id:ref(s.request_id),conversation_ref:ref(s.conversation_ref),contact_ref:ref(s.contact_ref),digest:digest(s.digest),authorization_digest:digest(s.authorization_digest)};}
function decode(row){if(!row)return null;return {...row,response_json:typeof row.response_json==='string'?JSON.parse(row.response_json):row.response_json,
  protocol_response:typeof row.protocol_response==='string'?JSON.parse(row.protocol_response):row.protocol_response};}
function safeCode(code){return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'UNKNOWN_ERROR';}
function createTurnLedger({db,parseResult,parseProtocolResult,now=()=>new Date(),nonce=randomUUID}={}){
  if(typeof db?.query!=='function'||typeof parseResult!=='function')fail('LEDGER_NOT_BOUND');
  const timestamp=()=>now().toISOString();
  async function query(sql,values){try{return await db.query(sql,values);}catch{fail('LEDGER_STORAGE_FAILED');}}
  async function get(input){
    const s=scope(input);const {rows}=await query(`SELECT * FROM ${TABLE} WHERE request_id=$1 AND conversation_ref=$2 AND contact_ref=$3`,[s.request_id,s.conversation_ref,s.contact_ref]);
    const row=decode(rows[0]);if(!row)return null;
    if(row.content_digest!==s.digest)fail('IDEMPOTENCY_CONFLICT');
    // Digest is NOT authorization: the injected authorizer must recompute it from
    // current authoritative permissions before every call, including cached reads.
    if(row.authorization_digest!==s.authorization_digest)fail('AUTHORIZATION_CHANGED');
    return row;
  }
  async function required(s){const row=await get(s);if(!row)fail('REQUEST_NOT_FOUND');return row;}
  async function reserve(input){
    const s=scope(input),message=ref(input.message_ref),version=ref(input.route_revision),at=timestamp();
    const {rows}=await query(`INSERT INTO ${TABLE}
      (request_id,message_ref,conversation_ref,contact_ref,content_digest,authorization_digest,route_revision,state,dispatch_count,delivery_state,created_at,updated_at,ingress_ref,account_ref)
      VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',0,'pending',$8,$8,$9,$10)
      ON CONFLICT DO NOTHING RETURNING *`,[s.request_id,message,s.conversation_ref,s.contact_ref,s.digest,s.authorization_digest,version,at,input.ingress_ref===undefined?null:ref(input.ingress_ref),input.account_ref===undefined?null:ref(input.account_ref)]);
    if(rows[0])return {kind:'reserved',row:decode(rows[0])};
    const existing=await get(s);
    if(!existing)fail('MESSAGE_ALREADY_RESERVED');
    if(existing.message_ref!==message)fail('IDEMPOTENCY_CONFLICT');
    return {kind:'existing',row:existing};
  }
  async function claim(input,{leaseMs=60000}={}){
    if(!Number.isInteger(leaseMs)||leaseMs<1||leaseMs>60000)fail('INVALID_LEASE');
    const s=scope(input);await required(s);const token=nonce(),at=timestamp(),until=new Date(now().getTime()+leaseMs).toISOString();
    const {rows}=await query(`UPDATE ${TABLE} SET state='dispatching',dispatch_count=1,claim_token=$2,lease_until=$3,updated_at=$4
      WHERE request_id=$1 AND state='reserved' AND dispatch_count=0 AND content_digest=$5 AND authorization_digest=$6 RETURNING *`,[s.request_id,token,until,at,s.digest,s.authorization_digest]);
    return rows[0]?{claimed:true,token,row:decode(rows[0])}:{claimed:false,row:await get(s)};
  }
  function result(value,id){try{return parseResult(value,id);}catch{fail('INVALID_RESPONSE');}}
  async function finish(input,token,value,{protocolResponse=null}={}){
    const s=scope(input);await required(s);const parsed=result(value,s.request_id);ref(token);
    if(protocolResponse!==null){if(typeof parseProtocolResult!=='function')fail('PROTOCOL_NOT_BOUND');
      try{protocolResponse=parseProtocolResult(protocolResponse,s.request_id);}catch{fail('INVALID_PROTOCOL_RESPONSE');}}
    const op=parsed.status==='accepted'?parsed.operation_ref:null;
    const {rows}=await query(`UPDATE ${TABLE} SET state=$3,response_json=$4,operation_ref=$5,error_code=$6,lease_until=NULL,updated_at=$7,protocol_response=$10
      WHERE request_id=$1 AND claim_token=$2 AND state IN ('dispatching','unknown') AND response_json IS NULL AND content_digest=$8 AND authorization_digest=$9 RETURNING *`,[s.request_id,token,parsed.status,JSON.stringify(parsed),op,parsed.public_code||null,timestamp(),s.digest,s.authorization_digest,protocolResponse===null?null:JSON.stringify(protocolResponse)]);
    if(!rows[0])fail('CLAIM_LOST_OR_ALREADY_FINISHED');return decode(rows[0]);
  }
  async function unknown(input,token,code){
    const s=scope(input);await required(s);ref(token);
    const {rows}=await query(`UPDATE ${TABLE} SET state='unknown',error_code=$3,lease_until=NULL,updated_at=$4
      WHERE request_id=$1 AND claim_token=$2 AND state='dispatching' AND authorization_digest=$5 RETURNING *`,[s.request_id,token,safeCode(code),timestamp(),s.authorization_digest]);
    return rows[0]?decode(rows[0]):await required(s);
  }
  async function expire(input){
    const s=scope(input);await required(s);const at=timestamp();
    const {rows}=await query(`UPDATE ${TABLE} SET state='unknown',error_code='DISPATCH_LEASE_EXPIRED',lease_until=NULL,updated_at=$2
      WHERE request_id=$1 AND state='dispatching' AND lease_until<=$2 AND authorization_digest=$3 RETURNING *`,[s.request_id,at,s.authorization_digest]);
    return rows[0]?decode(rows[0]):await required(s);
  }
  async function reconcile(input,value,{expectedOperationRef=null}={}){
    const s=scope(input);const row=await required(s);if(!row)fail('REQUEST_NOT_FOUND');
    if(row.operation_ref!==expectedOperationRef)fail('OPERATION_REF_MISMATCH');
    const parsed=result(value,s.request_id);
    // Call ONLY after a trusted existing status transport validated the response.
    // This method does not authenticate an endpoint, receipt or caller by itself.
    const op=parsed.status==='accepted'?parsed.operation_ref:row.operation_ref;
    const {rows}=await query(`UPDATE ${TABLE} SET state=$3,response_json=$4,operation_ref=$5,error_code=$6,updated_at=$7
      WHERE request_id=$1 AND state IN ('accepted','unknown') AND authorization_digest=$2
      AND ((operation_ref IS NULL AND $8::text IS NULL) OR operation_ref=$8::text) RETURNING *`,[s.request_id,s.authorization_digest,parsed.status,JSON.stringify(parsed),op,parsed.public_code||null,timestamp(),expectedOperationRef]);
    if(!rows[0])fail('RECONCILIATION_STATE_CONFLICT');return decode(rows[0]);
  }
  async function claimDelivery(input){
    const s=scope(input);await required(s);const token=nonce();
    const {rows}=await query(`UPDATE ${TABLE} SET delivery_state='claimed',delivery_token=$2,updated_at=$3
      WHERE request_id=$1 AND state='completed' AND delivery_state='pending' AND authorization_digest=$4 RETURNING *`,[s.request_id,token,timestamp(),s.authorization_digest]);
    return rows[0]?{claimed:true,token,row:decode(rows[0])}:{claimed:false,row:await get(s)};
  }
  async function recordDelivery(input,token,receipt){
    const s=scope(input);await required(s);ref(token);
    if(!receipt||!['queued','delivered','read','failed','uncertain'].includes(receipt.state))fail('INVALID_DELIVERY_RECEIPT');
    const correlation=receipt.correlation_id===undefined?null:ref(receipt.correlation_id);
    if(receipt.state!=='uncertain'&&!correlation)fail('CORRELATION_REQUIRED');
    const {rows}=await query(`UPDATE ${TABLE} SET delivery_state=$3,correlation_id=COALESCE(correlation_id,$4::text),error_code=$5,updated_at=$6
      WHERE request_id=$1 AND delivery_token=$2 AND delivery_state='claimed' AND authorization_digest=$7
      AND (correlation_id IS NULL OR $4::text IS NULL OR correlation_id=$4::text) RETURNING *`,[s.request_id,token,receipt.state,correlation,receipt.state==='uncertain'?'DELIVERY_OUTCOME_UNCERTAIN':null,timestamp(),s.authorization_digest]);
    if(!rows[0])fail('DELIVERY_CLAIM_LOST');return decode(rows[0]);
  }
  async function attachDelivery(input,token,correlationId){
    // Instantiate this ledger with the writer's DB transaction so creating the
    // canonical pending row and storing its correlation commit atomically.
    const s=scope(input);await required(s);ref(token);ref(correlationId);
    const {rows}=await query(`UPDATE ${TABLE} SET correlation_id=$3,updated_at=$4
      WHERE request_id=$1 AND delivery_token=$2 AND delivery_state='claimed' AND authorization_digest=$5
      AND (correlation_id IS NULL OR correlation_id=$3) RETURNING *`,[s.request_id,token,correlationId,timestamp(),s.authorization_digest]);
    if(!rows[0])fail('DELIVERY_CORRELATION_CONFLICT');return decode(rows[0]);
  }
  async function observeDelivery(input,receipt){
    // Only a trusted canonical DB/provider receipt lookup may call this method.
    // HTTP callers must not be allowed to assert delivery state themselves.
    const s=scope(input);await required(s);
    if(!receipt||!['queued','delivered','read','failed'].includes(receipt.state))fail('INVALID_DELIVERY_RECEIPT');
    const correlation=ref(receipt.correlation_id);
    const prior=receipt.state==='read'?['claimed','uncertain','queued','delivered','read']:
      receipt.state==='delivered'?['claimed','uncertain','queued','delivered']:
      receipt.state==='failed'?['claimed','uncertain','queued','failed']:['claimed','uncertain','queued'];
    const placeholders=prior.map((_,i)=>`$${i+6}`).join(',');
    const {rows}=await query(`UPDATE ${TABLE} SET delivery_state=$3,error_code=NULL,updated_at=$4
      WHERE request_id=$1 AND authorization_digest=$2 AND correlation_id=$5
      AND delivery_state IN (${placeholders}) RETURNING *`,[s.request_id,s.authorization_digest,receipt.state,timestamp(),correlation,...prior]);
    if(!rows[0])fail('DELIVERY_RECEIPT_CONFLICT');return decode(rows[0]);
  }
  return Object.freeze({get,reserve,claim,finish,unknown,expire,reconcile,claimDelivery,attachDelivery,recordDelivery,observeDelivery});
}
module.exports={createTurnLedger,LedgerError};
