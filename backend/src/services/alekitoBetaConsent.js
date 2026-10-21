'use strict';
// Internal backend service only. Consent never grants a domain capability.
const {createHash,randomUUID}=require('node:crypto');
const {isVerifiedButton}=require('./alekitoButtonIngress');
const sha=x=>createHash('sha256').update(x).digest('hex');
const issuedReceipts=new WeakSet();
class BetaConsentError extends Error{constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new BetaConsentError(code);};
const POLICY=Object.freeze({program:'alekito-beta-v1',revision:'owner-beta-20261017-v2-uat',
  invitation:'alekito-owner-beta-1792533023492',templateId:141,templateName:'alekito_invitacion_beta_v1',language:'es_MX',
  schemaDigest:'94cf257b59a338f6fff442b1e2110ab5a16c2783b096da4a2a12f92981a76bb7',
  accountRef:'af6adeb5076b',contactRef:'c_74634837c171'});
const REPLIES=Object.freeze({accepted:'¡Bienvenido al laboratorio beta de Alekito! 🚀 Gracias por sumarte.\n\nPara que sea súper ágil y sin escribir de cero, toca una opción para empezar:\n\n1. **Estado proyecto**: ver qué tenemos activo, avances y siguientes pasos.\n2. **Voz o imagen**: mándame una nota de voz o captura y yo la estructuro.\n3. **Calibrar estilo**: elegir en 2 toques cómo prefieres que te resuma y dé seguimiento.\n\n¿Con cuál de las 3 arrancamos?',
  declined:'Entendido. No te incorporaré a la beta de Alekito.',revoked:'Entendido. Tu participación en la beta de Alekito ha quedado revocada.',
  unchanged:'Tu decisión anterior sigue vigente. Esta respuesta no la ha cambiado.'});
function createBetaConsent({pool,policy=POLICY,nonce=randomUUID}={}){
  if(typeof pool?.connect!=='function')fail('BETA_STORAGE_NOT_BOUND');
  async function consume({row,binding,normalizedButton}){
    // Free text, arbitrary bridge campaigns and LLM classifications have no effect.
    if(row?.message_type==='text')return null;
    if(!isVerifiedButton(normalizedButton,row,{accountRef:policy.accountRef,contactRef:policy.contactRef}))fail('BETA_VERIFIED_BUTTON_REQUIRED');
    if(normalizedButton.source_request_id!==policy.invitation)return null;
    if(binding.account_ref!==policy.accountRef||binding.owner_ref!==policy.contactRef||
      String(binding.wa)!==String(row.wa_number)||String(binding.owner)!==String(row.contact_number)||
      ![0,1].includes(normalizedButton.button_index)||
      normalizedButton.reply_to!=='m_'+sha(row.context_message_id).slice(0,12))fail('BETA_BINDING_MISMATCH');
    const action=normalizedButton.button_index===0?'accept':'decline';
    const eventRef='msg_'+sha(row.message_id),replyTo='m_'+sha(row.context_message_id);
    const at=new Date(row.timestamp).toISOString();
    const digest=sha(JSON.stringify([policy.revision,policy.program,policy.invitation,policy.accountRef,policy.contactRef,
      eventRef,at,replyTo,normalizedButton.button_payload,normalizedButton.source_schema_digest,action]));
    const db=await pool.connect();let committed=false;
    try{
      await db.query('BEGIN');
      // Serialize every decision for this account/contact/program, across invites.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
        JSON.stringify([policy.accountRef,policy.contactRef,policy.program])]);
      const old=(await db.query(`SELECT * FROM coexistence.alekito_beta_receipts WHERE account_ref=$1 AND event_ref=$2`,[policy.accountRef,eventRef])).rows[0];
      if(old){
        if(old.event_digest!==digest)fail('BETA_EVENT_CONFLICT');
        await db.query('COMMIT');committed=true;
        return publicReceipt(old,true);
      }
      // Authoritative original invite + exact recipient + original provider reply-to.
      // Existing button resolver separately checks approved Meta schema and dispatch.
      const source=(await db.query(`SELECT r.request_id,r.template_id,r.template_name,r.template_language,r.template_schema_digest,r.job_payload,
        h.message_id,h.timestamp,h.status FROM coexistence.alekito_bridge_requests r
        JOIN coexistence.chat_history h ON h.send_correlation_id=r.correlation_id AND h.direction='outgoing'
        WHERE r.request_id=$1 AND r.account_id=$2 AND r.owner_ref=$3
        AND h.message_id=$4 AND h.wa_number=$5 AND h.contact_number=$6 FOR SHARE OF r,h`,
        [policy.invitation,binding.account.id,policy.contactRef,row.context_message_id,binding.wa,binding.owner])).rows;
      if(source.length!==1)fail('BETA_INVITATION_NOT_FOUND');
      const s=source[0],button=s.job_payload?.payload?.components?.filter(c=>c.type==='button'&&String(c.index)===String(normalizedButton.button_index));
      if(s.template_id!==policy.templateId||s.template_name!==policy.templateName||s.template_language!==policy.language||
        s.template_schema_digest!==policy.schemaDigest||normalizedButton.source_schema_digest!==policy.schemaDigest||
        !['sent','delivered','read'].includes(s.status)||!Number.isFinite(Date.parse(s.timestamp))||Date.parse(s.timestamp)>Date.parse(at)||
        button?.length!==1||button[0].sub_type!=='quick_reply'||button[0].parameters?.length!==1||
        button[0].parameters[0].type!=='payload'||button[0].parameters[0].payload!==normalizedButton.button_payload||
        normalizedButton.button_payload!==`alekito_bridge:${policy.invitation}:${normalizedButton.button_index}`)fail('BETA_INVITATION_MISMATCH');
      const current=(await db.query(`SELECT * FROM coexistence.alekito_beta_memberships
        WHERE account_ref=$1 AND contact_ref=$2 AND program=$3 FOR UPDATE`,[policy.accountRef,policy.contactRef,policy.program])).rows[0];
      // Decline/revoke is final for this invitation. A delayed Yes cannot reactivate.
      const stale=current&&(Date.parse(at)<Date.parse(current.event_at)||
        (Date.parse(at)===Date.parse(current.event_at)&&action==='accept'));
      const closed=current&&['declined','revoked'].includes(current.state);
      let state=current?.state,applied=!stale&&!closed;
      if(applied)state=action==='accept'?'accepted':current?.state==='accepted'?'revoked':'declined';
      const receiptRef='bc_'+nonce();
      const replyKind=applied?state:closed?state:(current?.invitation_request_id!==policy.invitation?state:'unchanged');
      const receipt={receipt_ref:receiptRef,account_ref:policy.accountRef,contact_ref:policy.contactRef,program:policy.program,
        invitation_request_id:policy.invitation,event_ref:eventRef,event_digest:digest,event_at:at,action,state_after:state,
        applied,reply_kind:replyKind,policy_revision:policy.revision,reply_to_ref:replyTo};
      await db.query(`INSERT INTO coexistence.alekito_beta_receipts
        (receipt_ref,account_ref,contact_ref,program,invitation_request_id,event_ref,event_digest,event_at,action,state_after,applied,reply_kind,policy_revision,reply_to_ref)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,Object.values(receipt));
      if(applied)await db.query(`INSERT INTO coexistence.alekito_beta_memberships
        (account_ref,contact_ref,program,state,event_at,last_receipt_ref,invitation_request_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_ref,contact_ref,program)
        DO UPDATE SET state=EXCLUDED.state,event_at=EXCLUDED.event_at,last_receipt_ref=EXCLUDED.last_receipt_ref,
        invitation_request_id=EXCLUDED.invitation_request_id,updated_at=now()`,
        [policy.accountRef,policy.contactRef,policy.program,state,at,receiptRef,policy.invitation]);
      await db.query('COMMIT');committed=true;
      return publicReceipt(receipt,false);
    }catch(error){
      if(!committed)await db.query('ROLLBACK').catch(()=>{});
      if(error instanceof BetaConsentError)throw error;
      // Includes uncertain COMMIT outcome. No welcome or fallback; reconcile by event.
      fail('BETA_STORAGE_OUTCOME_UNKNOWN');
    }finally{db.release();}
  }
  return Object.freeze({consume});
}
function publicReceipt(row,replay){const receipt=Object.freeze({schema:'alekito.beta-consent-receipt.v1',receipt_ref:row.receipt_ref,
  state:row.state_after,applied:row.applied,replay,reply:REPLIES[row.reply_kind],permissions_changed:false,
  provider_receipt_confirmed:false});issuedReceipts.add(receipt);return receipt;}
function protocolForReceipt(receipt,origin){
  if(!issuedReceipts.has(receipt))fail('BETA_RECEIPT_REQUIRED');
  return {schema:'alekito.conversation.response.v1',request_id:origin.request_id,correlation_id:'ak_'+sha(origin.request_id),
    status:'answer',proposed_reply:receipt.reply,evidence_refs:[receipt.receipt_ref],pending_intent:null,capability_request:null,
    scope_ref:null,policy_version:POLICY.revision,reason_code:null,side_effects:false,dispatched:false};
}

function buildDynamicBetaWelcome({ tags = [], hasMissionProject = false, hasNexusAccount = false } = {}) {
  const tagSet = new Set((Array.isArray(tags) ? tags : []).map(t => String(t).toLowerCase()));
  if (tagSet.has('cliente-activo') || hasMissionProject) {
    return [
      "¡Bienvenido al laboratorio beta de Alekito! 🚀 Gracias por sumarte.",
      "",
      "Reconozco tu proyecto activo. Toca una opción para empezar sin escribir de cero:",
      "",
      "1. **Estado proyecto**: ver avances, entregas y siguientes pasos en Misión Control.",
      "2. **Cotizar o explorar**: revisar una nueva necesidad o capacidad en Nexus.",
      "3. **Calibrar estilo**: elegir en 2 toques cómo prefieres que te resuma y dé seguimiento.",
      "",
      "¿Con cuál de las 3 arrancamos?"
    ].join("\n");
  }
  if (tagSet.has('beta-tester') || tagSet.has('laboratorio')) {
    return [
      "¡Bienvenido al laboratorio beta de Alekito! 🧪 Gracias por sumarte.",
      "",
      "Elige con un toque qué experimento quieres probar primero hoy:",
      "",
      "1. **Prueba por voz**: mándame una nota de voz con un reto de tu operación.",
      "2. **Cotizar o diagnosticar**: explorar cómo aplicar IA en un área de tu empresa.",
      "3. **Calibrar estilo**: definir cómo te gusta recibir resúmenes y opciones.",
      "",
      "¿Con cuál de las 3 empezamos?"
    ].join("\n");
  }
  if (hasMissionProject) {
    return [
      "¡Bienvenido al laboratorio beta de Alekito! 🚀 Gracias por sumarte.",
      "",
      "Para que sea súper ágil y sin escribir de cero, toca una opción para empezar:",
      "",
      "1. **Estado proyecto**: ver avances, pendientes y siguientes pasos en Misión Control.",
      "2. **Cotizar o explorar**: revisar una nueva necesidad o capacidad en Nexus.",
      "3. **Calibrar estilo**: elegir en 2 toques cómo prefieres que te resuma y dé seguimiento.",
      "",
      "¿Con cuál de las 3 arrancamos?"
    ].join("\n");
  }
  if (hasNexusAccount) {
    return [
      "¡Bienvenido al laboratorio beta de Alekito! 🚀 Gracias por sumarte.",
      "",
      "Elige con un toque por dónde quieres empezar hoy:",
      "",
      "1. **Ver mi propuesta**: revisar el avance de tu diagnóstico o solución en Nexus.",
      "2. **Explorar una mejora**: platicar por voz o botones qué área quieres fortalecer.",
      "3. **Casos prácticos**: ver ejemplos reales de cómo ayudamos en tu sector.",
      "",
      "¿Con cuál de las 3 arrancamos?"
    ].join("\n");
  }
  return [
    "¡Bienvenido al laboratorio beta de Alekito! 🚀 Gracias por sumarte.",
    "",
    "Elige con un toque qué área te gustaría explorar primero en tu empresa:",
    "",
    "1. **Ventas y atención**: seguimiento de clientes, cotizaciones y respuesta rápida.",
    "2. **Operación y control**: conectar pedidos, inventario y pendientes sin captura doble.",
    "3. **Dirección y finanzas**: visibilidad ejecutiva, conciliaciones y priorización.",
    "",
    "¿Por cuál de las 3 áreas empezamos?"
  ].join("\n");
}

module.exports={buildDynamicBetaWelcome,createBetaConsent,protocolForReceipt,POLICY,REPLIES,BetaConsentError};
