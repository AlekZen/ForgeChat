'use strict';

function sqlQuote(value) {
  if (value == null) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeContactIds(contactIds) {
  const ids = (contactIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) throw new Error('contactIds required');
  return [...new Set(ids)].join(',');
}

function buildIa360MemoryJaulaWhere() {
  return `(\n        (contact_wa_number=$1 AND contact_number=$2\n         AND (COALESCE($3::text,'')=''\n              OR COALESCE(project_name,'')=''\n              OR regexp_replace(lower(project_name),'[-_ ]','','g') = regexp_replace(lower($3),'[-_ ]','','g')))\n        OR ($3::text IS NOT NULL AND $3<>''\n            AND COALESCE(contact_wa_number,'')=''\n            AND COALESCE(contact_number,'')=''\n            AND forgechat_contact_id IS NULL\n            AND regexp_replace(lower(project_name),'[-_ ]','','g') = regexp_replace(lower($3),'[-_ ]','','g'))\n      )`;
}

function buildIa360AntiLeakSql({ contactIds, table = 'facts' }) {
  const ids = normalizeContactIds(contactIds);
  const sourceTable = table === 'events' ? 'coexistence.ia360_memory_events' : 'coexistence.ia360_memory_facts';
  const idAlias = table === 'events' ? 'event_id' : 'fact_id';
  const contactAlias = table === 'events' ? 'event_contact_id' : 'fact_contact_id';
  const processExpr = table === 'events' ? 'f.area AS affected_process' : 'f.affected_process';
  return `WITH contact_ctx AS (\n  SELECT id, contact_number, wa_number, coalesce(name,profile_name) name,\n         (custom_fields->'ia360_cliente_activo_beta'->>'project') AS beta_project,\n         custom_fields->>'project_name' AS cf_project\n  FROM coexistence.contacts\n  WHERE id IN (${ids})\n), sim AS (\n  SELECT ctx.id AS requesting_contact_id, ctx.name AS requesting_contact,\n         COALESCE(ctx.beta_project, ctx.cf_project) AS project_key,\n         f.id AS ${idAlias}, f.forgechat_contact_id AS ${contactAlias},\n         f.contact_number AS row_contact_number, f.contact_wa_number AS row_contact_wa_number,\n         f.project_name, ${processExpr}\n  FROM contact_ctx ctx\n  JOIN ${sourceTable} f ON (\n    (f.contact_wa_number=ctx.wa_number AND f.contact_number=ctx.contact_number\n      AND (COALESCE(COALESCE(ctx.beta_project, ctx.cf_project),'')=''\n           OR COALESCE(f.project_name,'')=''\n           OR regexp_replace(lower(f.project_name),'[-_ ]','','g') = regexp_replace(lower(COALESCE(ctx.beta_project, ctx.cf_project)),'[-_ ]','','g')))\n    OR (COALESCE(ctx.beta_project, ctx.cf_project) IS NOT NULL\n      AND COALESCE(ctx.beta_project, ctx.cf_project)<>''\n      AND COALESCE(f.contact_wa_number,'')=''\n      AND COALESCE(f.contact_number,'')=''\n      AND f.forgechat_contact_id IS NULL\n      AND regexp_replace(lower(f.project_name),'[-_ ]','','g') = regexp_replace(lower(COALESCE(ctx.beta_project, ctx.cf_project)),'[-_ ]','','g'))\n  )\n)\nSELECT * FROM sim\nWHERE ${contactAlias} IS NOT NULL\n  AND ${contactAlias} IS DISTINCT FROM requesting_contact_id;`;
}

function buildIa360RefreshContactRagSql(input) {
  const contactId = Number(input.contactId);
  const sourceChatHistoryId = Number(input.sourceChatHistoryId);
  if (!Number.isInteger(contactId) || !Number.isInteger(sourceChatHistoryId)) {
    throw new Error('contactId and sourceChatHistoryId must be integers');
  }
  const area = input.area || 'general';
  const signalType = input.signalType || 'mejora_en_proceso';
  const status = input.status || 'audit-in-progress';
  const summary = input.summary || '';
  const businessImpact = input.businessImpact || '';
  const missingData = input.missingData || '';
  const nextAction = input.nextAction || '';
  const affectedProcess = input.affectedProcess || area;
  const recurringPain = input.recurringPain || summary;
  const factKey = `forgechat_contact:${contactId}:${area}:${signalType}`;
  return `WITH src AS (\n  SELECT h.id AS chat_history_id, h.message_id, c.id AS contact_id,\n         c.contact_number, c.wa_number, coalesce(c.name,c.profile_name) AS contact_name\n  FROM coexistence.chat_history h\n  JOIN coexistence.contacts c ON c.contact_number=h.contact_number\n  WHERE h.id=${sourceChatHistoryId} AND c.id=${contactId}\n), ev AS (\n  INSERT INTO coexistence.ia360_memory_events (\n    source, contact_wa_number, contact_number, forgechat_contact_id, contact_name,\n    account_name, project_name, area, signal_type, confidence, summary, business_impact,\n    missing_data, next_action, should_be_fact, crm_sync_status, rag_index_status,\n    owner_review_status, external_send_allowed, contains_sensitive_data, store_transcript,\n    source_message_id, source_chat_history_id, payload\n  )\n  SELECT 'forgechat', wa_number, contact_number, contact_id, contact_name,\n         'Camiones Selectos', '' AS project_name, ${sqlQuote(area)}, ${sqlQuote(signalType)}, 0.95,\n         ${sqlQuote(summary)}, ${sqlQuote(businessImpact)}, ${sqlQuote(missingData)}, ${sqlQuote(nextAction)},\n         true, 'not_required', 'structured_lookup_ready', 'approved_by_owner', false, false, false,\n         message_id, chat_history_id,\n         jsonb_build_object(\n           'guardrails', jsonb_build_object('contact_scope','contact_only'),\n           'trace', jsonb_build_object('source_chat_history_id', chat_history_id, 'contact_id', contact_id),\n           'status', ${sqlQuote(status)}\n         )\n  FROM src\n  ON CONFLICT (source_message_id, area, signal_type) WHERE source_message_id IS NOT NULL\n  DO UPDATE SET summary=EXCLUDED.summary, business_impact=EXCLUDED.business_impact,\n                missing_data=EXCLUDED.missing_data, next_action=EXCLUDED.next_action,\n                rag_index_status='structured_lookup_ready', owner_review_status='approved_by_owner',\n                external_send_allowed=false, contains_sensitive_data=false, store_transcript=false,\n                payload=EXCLUDED.payload, updated_at=NOW()\n  RETURNING id, contact_wa_number, contact_number, forgechat_contact_id, account_name\n)\nINSERT INTO coexistence.ia360_memory_facts (\n  fact_key, source_event_id, source, contact_wa_number, contact_number, forgechat_contact_id,\n  account_name, project_name, recurring_pain, affected_process, confidence, owner_review_status,\n  status, evidence_count, payload\n)\nSELECT ${sqlQuote(factKey)}, id, 'forgechat', contact_wa_number, contact_number, forgechat_contact_id,\n       account_name, '' AS project_name, ${sqlQuote(recurringPain)}, ${sqlQuote(affectedProcess)}, 0.95,\n       'approved_by_owner', ${sqlQuote(status)}, 1,\n       jsonb_build_object('guardrails', jsonb_build_object('contact_scope','contact_only'), 'source_event_id', id)\nFROM ev\nON CONFLICT (fact_key)\nDO UPDATE SET source_event_id=EXCLUDED.source_event_id, recurring_pain=EXCLUDED.recurring_pain,\n              affected_process=EXCLUDED.affected_process, status=EXCLUDED.status,\n              owner_review_status='approved_by_owner', evidence_count=coexistence.ia360_memory_facts.evidence_count + 1,\n              payload=EXCLUDED.payload, last_seen_at=NOW(), updated_at=NOW()\nRETURNING id AS fact_id, source_event_id, forgechat_contact_id, status;`;
}

module.exports = {
  buildIa360MemoryJaulaWhere,
  buildIa360AntiLeakSql,
  buildIa360RefreshContactRagSql,
};
