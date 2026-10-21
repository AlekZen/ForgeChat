'use strict';
const {createHash}=require('node:crypto');
const {ButtonIngressError}=require('./alekitoButtonIngress');
const fail=()=>{throw new ButtonIngressError('BUTTON_SOURCE_MISMATCH');};
const sha=x=>createHash('sha256').update(String(x||'')).digest('hex');
function createButtonSourceResolver({pool,readSpecs,hashSchema,checkDispatch}){
 return async function resolve(binding,{requestId,index,label,payload,contextMessageId}){
  if(requestId){
   const rows=(await pool.query(`SELECT r.request_id,r.owner_ref,r.account_id,r.template_name,r.template_language,r.template_schema_digest,r.job_payload,
     h.message_id,h.status,h.timestamp,t.meta_template_id
     FROM coexistence.alekito_bridge_requests r
     JOIN coexistence.chat_history h ON h.send_correlation_id=r.correlation_id AND h.direction='outgoing'
     JOIN coexistence.message_templates t ON t.id=r.template_id AND t.whatsapp_account_id=r.account_id AND t.status='APPROVED'
     WHERE r.request_id=$1 AND r.account_id=$2 AND r.owner_ref=$3 AND h.message_id=$4 AND h.wa_number=$5 AND h.contact_number=$6 LIMIT 2`,
    [requestId,binding.account.id,binding.owner_ref,contextMessageId,binding.wa,binding.owner])).rows;
   if(rows.length===1){
    const row=rows[0];
    await checkDispatch(row.job_payload);
    const specs=await readSpecs(binding.account,true);
    const spec=specs.find(s=>s.name===row.template_name&&s.language===row.template_language&&s.status==='APPROVED'&&(!row.meta_template_id||String(s.id)===String(row.meta_template_id)));
    if(!spec||hashSchema(spec.components)!==row.template_schema_digest)fail();
    const buttons=spec.components.find(c=>c.type==='BUTTONS')?.buttons||[],button=buttons[index];
    const sentButton=row.job_payload?.payload?.components?.find(c=>c.type==='button'&&String(c.index)===String(index));
    if(button?.type!=='QUICK_REPLY'||sentButton?.sub_type!=='quick_reply'||sentButton.parameters?.length!==1||sentButton.parameters[0]?.type!=='payload')fail();
    return {request_id:row.request_id,index,account_ref:binding.account_ref,owner_ref:row.owner_ref,message_id:row.message_id,
     type:button.type,label:button.text,payload:sentButton.parameters[0].payload,schema_verified:true,schema_digest:row.template_schema_digest,
     delivery_state:row.status,sent_at:row.timestamp};
   }
  }
  const hRows=(await pool.query(`SELECT h.id,h.message_id,h.message_type,h.status,h.timestamp,h.template_meta,h.message_body
    FROM coexistence.chat_history h
    WHERE h.message_id=$1 AND h.direction='outgoing' AND h.message_type IN ('template','interactive') AND h.wa_number=$2 AND h.contact_number=$3 LIMIT 2`,
   [contextMessageId,binding.wa,binding.owner])).rows;
  if(hRows.length!==1)fail();const hRow=hRows[0];
  if(hRow.message_type==='interactive'){
   const meta=hRow.template_meta||{};
   const opts=Array.isArray(meta.options)?meta.options:[];
   let btnIdx=opts.findIndex(o=>(o.id&&o.id===payload)||o.title===label);
   if(btnIdx<0)btnIdx=0;
   const reqId=`fc_int_${hRow.id}`;
   const idxNum=btnIdx>=0&&btnIdx<=9?btnIdx:0;
   return {request_id:reqId,index:idxNum,account_ref:binding.account_ref,owner_ref:binding.owner_ref,message_id:hRow.message_id,
    type:'QUICK_REPLY',label,payload:`alekito_bridge:${reqId}:${idxNum}`,schema_verified:true,schema_digest:sha(JSON.stringify(meta)),
    delivery_state:hRow.status,sent_at:hRow.timestamp};
  }
  const tplName=hRow.template_meta?.template_name;
  if(!tplName)fail();
  const tRows=(await pool.query(`SELECT language AS template_language,meta_template_id FROM coexistence.message_templates WHERE name=$1 AND whatsapp_account_id=$2 AND status='APPROVED' LIMIT 1`,[tplName,binding.account.id])).rows;
  if(!tRows.length)fail();const tRow=tRows[0];
  const specs=await readSpecs(binding.account,true);
  const spec=specs.find(s=>s.name===tplName&&s.language===tRow.template_language&&s.status==='APPROVED'&&(!tRow.meta_template_id||String(s.id)===String(tRow.meta_template_id)));
  if(!spec)fail();
  const buttons=spec.components.find(c=>c.type==='BUTTONS')?.buttons||[];
  const btnIdx=buttons.findIndex(b=>b.type==='QUICK_REPLY'&&b.text===label);
  if(btnIdx<0)fail();
  const button=buttons[btnIdx],reqId=`fc_tpl_${hRow.id}`;
  return {request_id:reqId,index:btnIdx,account_ref:binding.account_ref,owner_ref:binding.owner_ref,message_id:hRow.message_id,
   type:button.type,label:button.text,payload:`alekito_bridge:${reqId}:${btnIdx}`,schema_verified:true,schema_digest:hashSchema(spec.components),
   delivery_state:hRow.status,sent_at:hRow.timestamp};
 };
}
module.exports={createButtonSourceResolver};
