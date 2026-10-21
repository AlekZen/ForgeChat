'use strict';

function boundedText(value, maxLength) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function lastSpanishQuestion(value) {
  const matches = boundedText(value, 2_000).match(/¿[^?]{1,298}\?/g);
  return matches?.at(-1) || null;
}

function questionFromHistory(history) {
  for (const entry of [...(history || [])].reverse()) {
    if (entry?.dir !== 'outgoing') continue;
    const texto = lastSpanishQuestion(entry.body);
    if (!texto) continue;
    return {
      texto,
      autor: boundedText(entry.autor, 40) || null,
      minutos: null,
      caseRef: boundedText(entry.caseRef, 120) || null,
      replyContext: boundedText(entry.replyContext, 500) || null,
    };
  }
  return null;
}

function buildIa360ContinuationContext(history, threadContext, record) {
  const latestQuestion = threadContext?.ultimaPregunta || questionFromHistory(history);
  const previousQuestion = boundedText(latestQuestion?.texto, 300);
  const currentReply = boundedText(record?.message_body, 300);
  if (!previousQuestion || !currentReply) return null;
  return {
    previousQuestion,
    currentReply,
    caseRef: boundedText(latestQuestion?.caseRef, 120) || null,
    replyContext: boundedText(latestQuestion?.replyContext, 500) || null,
    author: boundedText(latestQuestion?.autor, 40) || null,
    minutes: Number.isFinite(Number(latestQuestion?.minutos))
      ? Math.max(1, Math.round(Number(latestQuestion.minutos)))
      : null,
    contextualText: `${previousQuestion}\nRespuesta: ${currentReply}`,
  };
}

function buildIa360SharedThreadFallback({ record, threadContext }) {
  const context = buildIa360ContinuationContext([], threadContext, record);
  if (!context) return null;
  const caseSuffix = context.caseRef ? ` (${context.caseRef})` : '';
  return `Entendido: «${context.currentReply}». Lo tomo como respuesta a «${context.previousQuestion}»${caseSuffix} y lo dejo registrado para el equipo que lleva ese caso.`;
}

function isIa360AgentFailure(agent) {
  if (!agent || agent.agent_error_code) return true;
  const reply = boundedText(agent.reply, 600);
  if (!reply) return true;
  return /te leo[\s\S]{0,160}revisi[oó]n de alek/i.test(reply);
}

function redactSensitive(value, maxLength) {
  return boundedText(value, maxLength)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]')
    .replace(/(?:sk|pk|rk|org|proj)-[A-Za-z0-9_-]{16,}/g, '[secret]');
}

function buildIa360ContextualMemorySignal({ record, threadContext }) {
  const rawReply = String(record?.message_body || '').trim();
  if (!rawReply || rawReply.length > 120) return null;
  const continuation = buildIa360ContinuationContext([], threadContext, record);
  if (!continuation) return null;
  const respuesta = redactSensitive(continuation.currentReply, 120);
  const pregunta = redactSensitive(continuation.previousQuestion, 180);
  return {
    area: 'continuidad_conversacional',
    label: 'respuesta contextual',
    signalType: 'respuesta_contextual',
    summary: `El contacto respondió «${respuesta}» a «${pregunta}»`,
    businessImpact: 'Preserva la decisión del contacto y evita perder el contexto del caso compartido.',
    missingData: '',
    nextAction: 'Entregar la respuesta al equipo responsable del caso sin prometer ejecución.',
    affectedProcess: 'hilo compartido',
    missingMetric: '',
    confidence: 0.98,
    shouldBeFact: true,
    caseRef: continuation.caseRef,
  };
}

async function loadIa360AccountContext(db, record) {
  if (!db?.query || !record?.contact_number) return null;
  const { rows } = await db.query(
    `SELECT cs.account_key,
            a.display_name,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'projectKey', ap.plane_identifier,
                  'projectId', ap.plane_project_id,
                  'workspace', ap.plane_workspace,
                  'isDefault', ap.es_default
                )
                ORDER BY ap.es_default DESC, ap.plane_identifier
              ) FILTER (WHERE ap.plane_project_id IS NOT NULL),
              '[]'::jsonb
            ) AS projects
       FROM coexistence.ia360_contact_scope cs
       JOIN coexistence.ia360_accounts a
         ON a.account_key = cs.account_key AND a.activo
       LEFT JOIN coexistence.ia360_account_projects ap
         ON ap.account_key = cs.account_key AND ap.activo
      WHERE cs.contact_number = $1
        AND cs.activo
        AND cs.rol <> 'owner'
      GROUP BY cs.account_key, a.display_name
      ORDER BY cs.account_key`,
    [record.contact_number],
  );
  if (rows.length !== 1) return null;
  const row = rows[0];
  return {
    accountKey: boundedText(row.account_key, 120),
    name: boundedText(row.display_name, 200) || null,
    projects: (Array.isArray(row.projects) ? row.projects : []).map(project => ({
      projectKey: boundedText(project.projectKey, 120),
      projectId: boundedText(project.projectId, 120),
      workspace: boundedText(project.workspace, 120),
      isDefault: project.isDefault === true,
    })),
  };
}

module.exports = {
  buildIa360ContinuationContext,
  buildIa360ContextualMemorySignal,
  buildIa360SharedThreadFallback,
  extractIa360LastQuestion: lastSpanishQuestion,
  isIa360AgentFailure,
  loadIa360AccountContext,
};
