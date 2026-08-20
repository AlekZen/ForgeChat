const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildIa360ContinuationContext,
  buildIa360ContextualMemorySignal,
  buildIa360SharedThreadFallback,
  isIa360AgentFailure,
  loadIa360AccountContext,
} = require('../src/services/ia360SharedThread');

const EXECUTION_3187 = Object.freeze({
  previousQuestion: '¿el archivo de mayo sustituye por completo el mes o viene a sumar?',
  currentReply: 'Sustituye por favor',
  agentError: 'Service unavailable',
  account: Object.freeze({ accountKey: 'camiones-selectos', projectKeys: ['CAM'] }),
  caseRef: 'CAM-84',
  history: Object.freeze([
    Object.freeze({
      dir: 'outgoing',
      body: '¿el archivo de mayo sustituye por completo el mes o viene a sumar?',
      autor: 'otro_agente',
      caseRef: 'CAM-84',
      replyContext: 'Aclarar si el archivo reemplaza mayo o se agrega al acumulado.',
    }),
  ]),
  threadContext: Object.freeze({
    otroAgente: true,
    ultimaPregunta: Object.freeze({
      texto: '¿el archivo de mayo sustituye por completo el mes o viene a sumar?',
      autor: 'otro_agente',
      minutos: 286,
      caseRef: 'CAM-84',
      replyContext: 'Aclarar si el archivo reemplaza mayo o se agrega al acumulado.',
    }),
  }),
  record: Object.freeze({ message_body: 'Sustituye por favor' }),
});

test('execution 3187 conserva pregunta, respuesta, cuenta y caso sin transcript crudo', () => {
  const context = buildIa360ContinuationContext(
    EXECUTION_3187.history,
    EXECUTION_3187.threadContext,
    EXECUTION_3187.record,
  );

  assert.equal(context.previousQuestion, EXECUTION_3187.previousQuestion);
  assert.equal(context.currentReply, EXECUTION_3187.currentReply);
  assert.equal(context.caseRef, EXECUTION_3187.caseRef);
  assert.equal(
    context.contextualText,
    `${EXECUTION_3187.previousQuestion}\nRespuesta: ${EXECUTION_3187.currentReply}`,
  );
  assert.deepEqual(EXECUTION_3187.account, {
    accountKey: 'camiones-selectos',
    projectKeys: ['CAM'],
  });
  assert.equal(EXECUTION_3187.agentError, 'Service unavailable');
});

test('execution 3187 produce fallback contextual acotado ante caída del provider', () => {
  const fallback = buildIa360SharedThreadFallback({
    record: EXECUTION_3187.record,
    threadContext: EXECUTION_3187.threadContext,
  });

  assert.equal(
    fallback,
    'Entendido: «Sustituye por favor». Lo tomo como respuesta a «¿el archivo de mayo sustituye por completo el mes o viene a sumar?» (CAM-84) y lo dejo registrado para el equipo que lleva ese caso.',
  );
  assert.doesNotMatch(fallback, /Te leo|revisión de Alek|te confirmo/i);
  assert.equal((fallback.match(/\?/g) || []).length, 1);
});

test('sin pregunta previa deja el fallback normal a la rama llamadora', () => {
  assert.equal(
    buildIa360SharedThreadFallback({
      record: EXECUTION_3187.record,
      threadContext: { otroAgente: false, ultimaPregunta: null },
    }),
    null,
  );
});

test('cuenta única no-owner carga proyectos y cero o múltiples fallan cerrados', async () => {
  const one = await loadIa360AccountContext({
    async query(_sql, params) {
      assert.deepEqual(params, ['contacto-fixture']);
      return {
        rows: [{
          account_key: 'camiones-selectos',
          display_name: 'Camiones Selectos',
          projects: [{
            projectKey: 'CAM',
            projectId: 'project-cam',
            workspace: 'codigo',
            isDefault: true,
          }],
        }],
      };
    },
  }, { contact_number: 'contacto-fixture' });

  assert.deepEqual(one, {
    accountKey: 'camiones-selectos',
    name: 'Camiones Selectos',
    projects: [{
      projectKey: 'CAM',
      projectId: 'project-cam',
      workspace: 'codigo',
      isDefault: true,
    }],
  });
  assert.equal(await loadIa360AccountContext(
    { query: async () => ({ rows: [] }) },
    { contact_number: 'contacto-fixture' },
  ), null);
  assert.equal(await loadIa360AccountContext(
    { query: async () => ({ rows: [{ account_key: 'a' }, { account_key: 'b' }] }) },
    { contact_number: 'contacto-fixture' },
  ), null);
});

test('execution 3187 captura un fact contextual acotado con case en payload', () => {
  const signal = buildIa360ContextualMemorySignal({
    record: EXECUTION_3187.record,
    threadContext: EXECUTION_3187.threadContext,
  });

  assert.equal(signal.signalType, 'respuesta_contextual');
  assert.equal(signal.summary, 'El contacto respondió «Sustituye por favor» a «¿el archivo de mayo sustituye por completo el mes o viene a sumar?»');
  assert.equal(signal.caseRef, 'CAM-84');
  assert.equal(signal.shouldBeFact, true);
  assert.equal(signal.nextAction.includes('sin prometer ejecución'), true);
  assert.equal(buildIa360ContextualMemorySignal({
    record: { message_body: 'X'.repeat(121) },
    threadContext: EXECUTION_3187.threadContext,
  }), null);
});

test('provider error, agente ausente y canned reply nunca cuentan como respuesta válida', () => {
  assert.equal(isIa360AgentFailure(null), true);
  assert.equal(isIa360AgentFailure({
    reply: 'Te leo. Para cuidarlo bien, lo dejo como revisión de Alek antes de responder automático.',
  }), true);
  assert.equal(isIa360AgentFailure({
    reply: 'Respuesta aparentemente útil',
    agent_error_code: 'AGENT_PROVIDER_UNAVAILABLE',
  }), true);
  assert.equal(isIa360AgentFailure({ reply: 'Entendido, mayo sustituye el archivo anterior.' }), false);
});

