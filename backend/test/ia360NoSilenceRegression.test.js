// Regresión G-LIVE (P0 producción, 2026-06-11): contactos activos/beta SIEMPRE
// reciben respuesta real — nunca silencio, nunca inventar. Tests estáticos de
// patrones sobre webhook.js: cada uno protege un cierre del incidente Andrés
// (38 min mudo) y del incidente José Ramón (inyector QA a número real).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webhook.js'), 'utf8');

test('cliente activo beta memory dry-run must fall through to no-silence fallback', () => {
  // Rama dry-run legacy: persistir memoria jamás cuenta como respuesta.
  const dryRunStart = src.indexOf('if (!IA360_MEMORY_EGRESS_ON)');
  const dryRunEnd = src.indexOf("await enqueueIa360Text({ record, label: 'ia360_cliente_activo_beta_memory_reply'", dryRunStart);
  assert.notEqual(dryRunStart, -1, 'falta la rama dry-run de memoria');
  assert.notEqual(dryRunEnd, -1, 'falta la rama egress-on de memoria');
  const dryRunBlock = src.slice(dryRunStart, dryRunEnd);
  assert.match(dryRunBlock, /egress=dry_run -> fallback_required/);
  assert.match(dryRunBlock, /return false;/, 'el dry-run de memoria no es respuesta al cliente');

  // captureOnly: la captura en segundo plano tampoco es respuesta.
  const captureIdx = src.indexOf('if (captureOnly)');
  assert.notEqual(captureIdx, -1, 'falta la rama captureOnly del learning');
  const captureBlock = src.slice(captureIdx, src.indexOf('const reply = buildIa360ClienteActivoBetaReply', captureIdx));
  assert.match(captureBlock, /egress=capture_only/);
  assert.match(captureBlock, /return false;/, 'captureOnly debe devolver false siempre');

  // La rama cliente activo/beta del padre responde DE VERDAD (agente) o cae a failure.
  const betaStart = src.indexOf("if (deal.memory_mode === 'cliente_activo_beta_supervisado'");
  const betaEnd = src.indexOf('const agent = await callIa360Agent', betaStart);
  assert.notEqual(betaStart, -1, 'falta la rama cliente activo/beta en handleIa360FreeText');
  assert.notEqual(betaEnd, -1, 'falta la rama 100M del agente');
  const betaBlock = src.slice(betaStart, betaEnd);
  assert.match(betaBlock, /captureOnly: true/, 'la rama beta debe capturar memoria sin responder');
  assert.match(betaBlock, /callIa360Agent/, 'la rama beta debe pedir respuesta real al agente');
  assert.match(betaBlock, /ia360_cliente_activo_beta_agent_reply/, 'la respuesta real debe encolar al contacto');
  // G-BRAIN compuso el roleHint ([perfil ejecutivo, hint conversacional]); la
  // intención es la misma: el perfil ejecutivo SIEMPRE llega al agente.
  assert.ok(betaBlock.includes('buildIa360ClienteActivoBetaRoleHint(contactContext)'), 'el agente debe recibir el perfil ejecutivo');
  assert.match(betaBlock, /handleIa360BotFailure/, 'sin agente debe haber holding + alerta + failure');
  assert.match(betaBlock, /agente IA sin respuesta utilizable/);
});

test('invariante no-silencio: watchdog estructural en el dispatcher', () => {
  assert.match(src, /IA360_NO_SILENCE_WATCHDOG_MS/, 'falta la constante del watchdog');
  assert.match(src, /function scheduleIa360NoSilenceWatchdog\(record\)/);
  assert.match(src, /async function ia360NoSilenceWatchdogCheck\(record\)/);
  assert.match(src, /async function ia360HasOutgoingForInbound\(record\)/);

  // Se programa dentro del loop de incoming ANTES de cualquier handler (cubre
  // continues, throws y ramas fire-and-forget por igual).
  const loopIdx = src.indexOf('for (const record of incomingRecords)');
  assert.notEqual(loopIdx, -1);
  const watchdogCall = src.indexOf('scheduleIa360NoSilenceWatchdog(record);', loopIdx);
  const firstHandler = src.indexOf('handleIa360OwnerIdeaCommand', loopIdx);
  assert.notEqual(watchdogCall, -1, 'el watchdog no se programa en el dispatcher');
  assert.ok(watchdogCall < firstHandler, 'el watchdog debe programarse antes de cualquier handler');

  // El check consulta la VERDAD en chat_history (fila outgoing), no flags en memoria.
  const checkBlock = src.slice(
    src.indexOf('async function ia360HasOutgoingForInbound'),
    src.indexOf('async function ia360IsWatchedActiveContact')
  );
  assert.match(checkBlock, /direction = 'outgoing'/);
  assert.match(checkBlock, /ia360_handler_for/);

  // El disparo termina en holding + alerta + failure.
  const fireBlock = src.slice(
    src.indexOf('async function ia360NoSilenceWatchdogCheck'),
    src.indexOf('function scheduleIa360NoSilenceWatchdog')
  );
  assert.match(fireBlock, /handleIa360BotFailure/);
  assert.match(fireBlock, /invariante no-silencio/);
});

test('qa-guard: payload sintético jamás egresa a números reales', () => {
  assert.match(src, /function isIa360SyntheticWamid\(messageId\)/);
  assert.match(src, /function isIa360BlockedSyntheticInbound\(record\)/);
  const guardFn = src.slice(
    src.indexOf('function isIa360BlockedSyntheticInbound'),
    src.indexOf("router.post('/webhook/whatsapp'")
  );
  assert.match(guardFn, /IA360_QA_NUMBER_RE/, 'el guard debe permitir solo números QA');
  assert.match(guardFn, /IA360_OWNER_NUMBER/, 'el guard debe permitir al owner');

  // El filtro corre en el POST antes del INSERT a chat_history (sin insert, sin
  // handlers, sin egress derivado — cierre del incidente José Ramón).
  const postIdx = src.indexOf("router.post('/webhook/whatsapp'");
  const guardIdx = src.indexOf('isIa360BlockedSyntheticInbound(allRecords[i])', postIdx);
  const insertIdx = src.indexOf('INSERT INTO coexistence.chat_history', postIdx);
  assert.notEqual(guardIdx, -1, 'el guard sintético no se aplica en el POST');
  assert.ok(guardIdx < insertIdx, 'el guard debe correr antes del INSERT a chat_history');

  // Allowlist QA correcta: longitud exacta (no '\d*' laxo que admite móviles reales).
  assert.match(src, /\^52199900\\d\{5\}\$/);
});

test('datos vivos del portal: handoff explícito, nunca inventar listas', () => {
  assert.match(src, /function isIa360PortalLiveDataQuestion\(body\)/);
  assert.match(src, /ia360_cliente_activo_portal_handoff/);
  // El handoff alerta al owner sin doble-textear al contacto, pero solo afirma
  // "ya respondido" si el envío del handoff realmente se encoló.
  const handoffIdx = src.indexOf('ia360_cliente_activo_portal_handoff');
  const handoffBlock = src.slice(handoffIdx, handoffIdx + 900);
  assert.match(handoffBlock, /alreadyResponded: sentHandoff === true/);
});

test('operaciones beta sin deal entra al camino no-silencio sin telefono hard-coded', () => {
  assert.match(src, /function isIa360OperacionesChampionContact\(contact\)/);
  assert.match(src, /champion_operaciones/);
  assert.match(src, /director_operativo/);
  assert.match(src, /function buildIa360ClienteActivoBetaPseudoDeal\(contact\)/);
  assert.match(src, /stage_name: 'Cliente activo beta supervisado'/);
  assert.match(src, /memory_mode: 'cliente_activo_beta_supervisado'/);

  const handlerStart = src.indexOf('async function handleIa360FreeText');
  const betaStart = src.indexOf("if (deal.memory_mode === 'cliente_activo_beta_supervisado'", handlerStart);
  assert.notEqual(handlerStart, -1, 'falta handleIa360FreeText');
  assert.notEqual(betaStart, -1, 'falta rama cliente activo/beta');
  const preBetaBlock = src.slice(handlerStart, betaStart);
  assert.match(preBetaBlock, /preloadedContactContext = await loadIa360ContactContext\(record\)/);
  assert.match(preBetaBlock, /!deal && isIa360ClienteActivoBetaContact\(preloadedContactContext\)/);
  assert.match(preBetaBlock, /buildIa360ClienteActivoBetaPseudoDeal\(preloadedContactContext\)/);
  // Sin deal se sale SIEMPRE del carril beta (nadie entra a la rama de cliente
  // activo por accidente), pero ya no en silencio: desde el 12-ago-2026 el
  // desconocido pasa por el triaje antes del return.
  assert.match(preBetaBlock, /if \(!deal\) \{[\s\S]{0,600}?handleIa360Desconocido\([\s\S]{0,300}?return;/);

  assert.doesNotMatch(src, /Hendri/i, 'la elegibilidad no debe depender del nombre real');
  assert.doesNotMatch(src, /2844/, 'la elegibilidad no debe depender del id real del contacto');
});

test('operaciones live-data usa holding honesto y failure trazable por chokepoint', () => {
  assert.match(src, /function isIa360OperacionesLiveDataQuestion\(body\)/);
  const detectorStart = src.indexOf('function isIa360OperacionesLiveDataQuestion');
  const detectorEnd = src.indexOf('function buildIa360OperacionesLiveDataHoldingResponse', detectorStart);
  const detectorBlock = src.slice(detectorStart, detectorEnd);
  assert.match(detectorBlock, /normalizeIa360Marker\(body\)\.split\('_'\)/);
  assert.match(detectorBlock, /tokens\.some/);
  assert.match(detectorBlock, /'inventario'/);
  assert.match(detectorBlock, /'taller'/);
  assert.match(detectorBlock, /'refacciones'/);
  assert.doesNotMatch(detectorBlock, /\\b\(inventario\|taller/, 'no debe usar \\b sobre texto normalizado con guiones bajos');
  assert.match(src, /function buildIa360OperacionesLiveDataHoldingResponse\(\)/);
  assert.match(src, /no inventarte datos de inventario/);

  const holdingIdx = src.indexOf('ia360_operaciones_live_data_holding');
  assert.notEqual(holdingIdx, -1, 'falta el holding de Operaciones');
  const holdingBlock = src.slice(holdingIdx - 500, holdingIdx + 900);
  assert.match(holdingBlock, /isIa360OperacionesChampionContact\(contactContext\)/);
  assert.match(holdingBlock, /isIa360OperacionesLiveDataQuestion\(record\.message_body\)/);
  assert.match(holdingBlock, /await enqueueIa360Text/);
  assert.match(holdingBlock, /buildIa360OperacionesLiveDataHoldingResponse\(\)/);
  assert.match(holdingBlock, /await handleIa360BotFailure/);
  assert.match(holdingBlock, /alreadyResponded: sentHandoff === true/);
  assert.doesNotMatch(holdingBlock, /sendText|sendTemplate|sendInteractive|metaSend/i, 'no debe introducir egress directo a Meta');
});

test('failure handoff: alerta al owner con nombre y el comentario de Alek responde al contacto', () => {
  assert.match(src, /function ia360ContactDisplayName/);
  assert.match(src, /async function loadIa360FailureTarget/);
  assert.match(src, /async function sendIa360OwnerCommentToFailureContact/);

  const failureStart = src.indexOf('async function handleIa360BotFailure');
  const failureEnd = src.indexOf('// ── G-LIVE: invariante estructural no-silencio', failureStart);
  assert.notEqual(failureStart, -1, 'falta handleIa360BotFailure');
  const failureBlock = src.slice(failureStart, failureEnd);
  assert.match(failureBlock, /loadIa360ContactContext\(record\)/, 'la alerta debe resolver contacto');
  assert.match(failureBlock, /ia360ContactDisplayName/, 'la alerta debe preferir nombre sobre número');
  const ownerAlertStart = failureBlock.lastIndexOf("label: 'owner_bot_failure'");
  assert.notEqual(ownerAlertStart, -1, 'falta alerta real al owner');
  const ownerAlertBlock = failureBlock.slice(ownerAlertStart);
  assert.doesNotMatch(ownerAlertBlock, /mensaje de \$\{record\.contact_number/, 'la alerta real al owner no debe anunciar solo el teléfono');
  assert.match(ownerAlertBlock, /title: 'Responder'/, 'el botón debe expresar que la respuesta saldrá al contacto');

  const captureStart = src.indexOf("custom_fields->>'ia360_awaiting_comment_failure'");
  const captureEnd = src.indexOf('// ── G-RAG: intake del vault', captureStart);
  assert.notEqual(captureStart, -1, 'falta captura de comentario owner');
  const captureBlock = src.slice(captureStart, captureEnd);
  assert.match(captureBlock, /sendIa360OwnerCommentToFailureContact/, 'el comentario de Alek debe enviarse al contacto');
  assert.match(captureBlock, /respondido_por_comentario_owner/, 'debe quedar trazabilidad de respuesta enviada');
  assert.match(src, /Alek me confirmó lo siguiente/, 'el contacto debe recibir contexto de que viene de Alek');
});

test('owner directo en Brain v2 canary enruta al OOA con fallback a menu (nunca mudo)', () => {
  const handlerStart = src.indexOf('async function handleBrainV2Canary(record)');
  assert.notEqual(handlerStart, -1, 'falta handleBrainV2Canary');
  const handlerEnd = src.indexOf('// G-LIVE QA-GUARD', handlerStart);
  const handler = src.slice(handlerStart, handlerEnd);
  assert.match(handler, /isOwnerDirect/, 'la ruta owner directa debe estar explicita');
  // F1 OOA: el owner ahora SI se enruta al Brain v2 con force_actor owner...
  const ownerBlock = handler.slice(handler.indexOf('if (isOwnerDirect)'));
  assert.match(ownerBlock, /callBrainV2\([^)]*forceActor:\s*'owner'/, 'owner directo debe llamar callBrainV2 con force_actor owner');
  // ...pero el menu local sigue presente como FALLBACK para nunca quedar mudo.
  assert.match(ownerBlock, /brainv2_owner_operator_local/, 'debe conservar el menu local como fallback');
  assert.match(ownerBlock, /ooaReply\s*\|\|\s*ownerOperatorMenu/, 'el cuerpo debe caer al menu si el OOA no responde');
});
