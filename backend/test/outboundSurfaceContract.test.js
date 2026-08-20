const test = require('node:test');
const assert = require('node:assert/strict');

const {
  IA360_LINK_ESCALATION,
  attestOutboundPayload,
  finalizeIa360Reply,
  payloadSha256,
  resolveContactAccountKey,
  validateOutboundAttestation,
  validatePurposeAndUrls,
} = require('../src/services/outboundSurfaceContract');

const CAM = {
  id: 1,
  canonical_origin: 'https://camiones-selectos.web.app',
  path_prefix: '/app/',
};
const ARP = {
  id: 2,
  canonical_origin: 'https://aroundaplanet--arounda-planet.us-east4.hosted.app',
  path_prefix: '/',
};

async function expectCode(fn, code) {
  await assert.rejects(fn, error => {
    assert.equal(error.code, code);
    return true;
  });
}

test('CAM y ARP exactos pasan por origen y prefijo autorizados', () => {
  assert.deepEqual(validatePurposeAndUrls({
    purpose: 'production_review',
    surface: CAM,
    body: 'Revisa https://camiones-selectos.web.app/app/uploads',
  }), ['https://camiones-selectos.web.app/app/uploads']);
  assert.deepEqual(validatePurposeAndUrls({
    purpose: 'production_test',
    surface: ARP,
    body: 'Prueba https://aroundaplanet--arounda-planet.us-east4.hosted.app/cotizaciones',
  }), ['https://aroundaplanet--arounda-planet.us-east4.hosted.app/cotizaciones']);
});

test('case_delivery permite cero URLs sólo cuando no hay superficie', () => {
  assert.deepEqual(validatePurposeAndUrls({
    purpose: 'case_delivery', surface: null, body: 'Aquí está el entregable solicitado.',
  }), []);
  assert.throws(
    () => validatePurposeAndUrls({ purpose: 'production_review', surface: null, body: 'Sin URL' }),
    error => error.code === 'SURFACE_URL_REQUIRED',
  );
});

test('propósito inválido falla con código público estable', () => {
  assert.throws(
    () => validatePurposeAndUrls({ purpose: 'production_notice', surface: CAM, body: 'Sin contrato' }),
    error => error.code === 'INVALID_PURPOSE',
  );
});

test('scope cero o múltiple falla cerrado', async () => {
  await expectCode(
    () => resolveContactAccountKey({ query: async () => ({ rows: [] }) }, '5210000000000'),
    'SURFACE_NOT_AUTHORIZED',
  );
  await expectCode(
    () => resolveContactAccountKey({
      query: async () => ({ rows: [{ account_key: 'a' }, { account_key: 'b' }] }),
    }, '5210000000000'),
    'SURFACE_NOT_AUTHORIZED',
  );
});

test('URL adicional y parámetros sensibles fallan cerrados', () => {
  assert.throws(
    () => validatePurposeAndUrls({
      purpose: 'production_review', surface: CAM,
      body: 'Uno https://camiones-selectos.web.app/app/a y dos https://camiones-selectos.web.app/app/b',
    }),
    error => error.code === 'SURFACE_URL_ADDITIONAL',
  );
  assert.throws(
    () => validatePurposeAndUrls({
      purpose: 'production_review', surface: CAM,
      body: 'Revisa https://camiones-selectos.web.app/app/a?session_id=1',
    }),
    error => error.code === 'SURFACE_SENSITIVE_URL',
  );
});

test('HTTP, userinfo, fragmento, host ajeno y ruta fuera del prefijo fallan', () => {
  const invalid = [
    'http://camiones-selectos.web.app/app/a',
    'https://user@camiones-selectos.web.app/app/a',
    'https://camiones-selectos.web.app/app/a#detalle',
    'https://example.com/app/a',
    'https://camiones-selectos.web.app/admin',
    'https://camiones-selectos.web.app/app/%252e%252e/admin',
  ];
  for (const url of invalid) {
    assert.throws(
      () => validatePurposeAndUrls({ purpose: 'production_review', surface: CAM, body: `Revisa ${url}` }),
      error => error.code === 'SURFACE_URL_MISMATCH',
      url,
    );
  }
});

test('FiscalIA o una superficie cross-tenant no generan atestación', async () => {
  const db = { query: async () => ({ rows: [] }) };
  await expectCode(() => attestOutboundPayload(db, {
    accountKey: 'fiscalia',
    caseRef: 'QA-1',
    purpose: 'production_review',
    surfaceKey: 'fiscal-app',
    body: 'Revisa https://fiscalia.example/app',
    correlationId: 'local-1',
    actorId: 'fixture',
  }), 'SURFACE_NOT_AUTHORIZED');
});

test('attestOutboundPayload inserta hash y referencia server-side', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM coexistence.ia360_product_surfaces')) {
        return { rows: [{ ...CAM, surface_key: 'cam-app', account_key: 'camiones-selectos' }] };
      }
      return { rows: [{ public_ref: 'a_0123456789abcdef01234567', expires_at: '2026-08-27T00:00:00Z' }] };
    },
  };
  const body = 'Revisa https://camiones-selectos.web.app/app/uploads';
  const result = await attestOutboundPayload(db, {
    accountKey: 'camiones-selectos', caseRef: 'QA-2', purpose: 'production_review',
    surfaceKey: 'cam-app', body, correlationId: 'local-2', actorId: 'fixture',
  });
  assert.equal(result.attestationRef, 'a_0123456789abcdef01234567');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params[6], payloadSha256(body));
  assert.equal(calls[1].params[7], 'local-2');
});

test('atestación vencida falla aunque cuenta, correlación y payload coincidan', async () => {
  const body = 'Revisa https://camiones-selectos.web.app/app/a';
  let query = 0;
  const db = {
    async query() {
      query += 1;
      if (query === 1) return { rows: [{ account_key: 'camiones-selectos' }] };
      return { rows: [{
        public_ref: 'a_0123456789abcdef01234567', account_key: 'camiones-selectos',
        case_ref: 'QA-EXP', purpose: 'production_review',
        canonical_url: 'https://camiones-selectos.web.app/app/a',
        payload_sha256: payloadSha256(body), send_correlation_id: 'local-exp',
        expires_at: '2000-01-01T00:00:00.000Z',
        canonical_origin: CAM.canonical_origin, path_prefix: CAM.path_prefix, active: true,
      }] };
    },
  };
  await expectCode(() => validateOutboundAttestation(db, {
    attestationRef: 'a_0123456789abcdef01234567', accountKey: 'camiones-selectos',
    contactNumber: '5210000000000', body, correlationId: 'local-exp',
  }), 'SURFACE_ATTESTATION_EXPIRED');
});

test('payload alterado después de atestar falla antes del egreso', async () => {
  const original = 'Revisa https://camiones-selectos.web.app/app/a';
  let query = 0;
  const db = {
    async query() {
      query += 1;
      if (query === 1) return { rows: [{ account_key: 'camiones-selectos' }] };
      return { rows: [{
        public_ref: 'a_0123456789abcdef01234567', account_key: 'camiones-selectos',
        case_ref: 'QA-3', purpose: 'production_review',
        canonical_url: 'https://camiones-selectos.web.app/app/a',
        payload_sha256: payloadSha256(original), send_correlation_id: 'local-3',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        canonical_origin: CAM.canonical_origin, path_prefix: CAM.path_prefix, active: true,
      }] };
    },
  };
  await expectCode(() => validateOutboundAttestation(db, {
    attestationRef: 'a_0123456789abcdef01234567', accountKey: 'camiones-selectos',
    contactNumber: '5210000000000', body: `${original} alterado`, correlationId: 'local-3',
  }), 'SURFACE_URL_MISMATCH');
});

test('IA360 escala una petición de enlace sin correlación verificada', async () => {
  const db = { query: async () => ({ rows: [{ account_key: 'camiones-selectos' }] }) };
  const result = await finalizeIa360Reply(db, {
    record: { contact_number: '5210000000000', message_body: 'pásame el enlace' },
    body: 'Te lo mando después.',
  });
  assert.equal(result, IA360_LINK_ESCALATION);
});



test('IA360 escala incluso si el contacto perdió su scope antes de responder', async () => {
  const result = await finalizeIa360Reply(
    { query: async () => ({ rows: [] }) },
    {
      record: {
        contact_number: '5210000000000',
        message_body: 'pásame el enlace',
        surface_attestation_ref: 'a_0123456789abcdef01234567',
        send_correlation_id: 'local-scope-lost',
      },
      body: 'Revisa https://camiones-selectos.web.app/app/a',
    },
  );
  assert.equal(result, IA360_LINK_ESCALATION);
});

test('processJob bloquea payload alterado antes de llamar a Meta', async () => {
  const modulePaths = [
    require.resolve('bullmq'),
    require.resolve('ioredis'),
    require.resolve('../src/db'),
    require.resolve('../src/routes/whatsappAccounts'),
    require.resolve('../src/integrations/metaSend'),
    require.resolve('../src/services/messageSender'),
    require.resolve('../src/services/accountHealth'),
    require.resolve('../src/integrations/templateValidator'),
  ];
  const originals = new Map(modulePaths.map(modulePath => [modulePath, require.cache[modulePath]]));
  const stub = (modulePath, exports) => {
    require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
  };
  let metaCalls = 0;
  class FakeRedis {
    on() {}
    async quit() {}
  }
  class FakeQueue {
    async add() {}
    async close() {}
  }
  class FakeWorker {}
  class FakeQueueEvents {
    on() {}
    async close() {}
  }
  const persistedBody = 'Revisa https://camiones-selectos.web.app/app/a';
  try {
    stub(require.resolve('bullmq'), { Queue: FakeQueue, Worker: FakeWorker, QueueEvents: FakeQueueEvents });
    stub(require.resolve('ioredis'), FakeRedis);
    stub(require.resolve('../src/db'), {
      query: async () => ({ rows: [{
        phone_number_id: 'phone-1',
        contact_number: '5210000000000',
        message_body: persistedBody,
        surface_attestation_ref: 'a_0123456789abcdef01234567',
        outbound_purpose: 'production_review',
        case_ref: 'QA-QUEUE',
        send_correlation_id: 'local-queue',
      }] }),
    });
    stub(require.resolve('../src/routes/whatsappAccounts'), {
      getAccountWithToken: async () => ({
        id: 1, accessToken: 'fixture-only', phoneNumberId: 'phone-1', isActive: true,
      }),
    });
    stub(require.resolve('../src/integrations/metaSend'), {
      sendText: async () => { metaCalls += 1; },
      sendTemplate: async () => { metaCalls += 1; },
      sendMedia: async () => { metaCalls += 1; },
      sendInteractive: async () => { metaCalls += 1; },
      sendLocation: async () => { metaCalls += 1; },
      sendContacts: async () => { metaCalls += 1; },
      sendReaction: async () => { metaCalls += 1; },
    });
    stub(require.resolve('../src/services/messageSender'), {
      markSent: async () => {}, markFailed: async () => {},
    });
    stub(require.resolve('../src/services/accountHealth'), {
      markAccountHealth: async () => {}, classifyMetaError: () => 'unknown',
    });
    stub(require.resolve('../src/integrations/templateValidator'), {
      validateTemplateSend: async () => ({ valid: true }),
    });
    const queueModulePath = require.resolve('../src/queue/sendQueue');
    delete require.cache[queueModulePath];
    const { processJob, isAmbiguousSendError } = require('../src/queue/sendQueue');
    const transportError = new TypeError('fetch failed');
    transportError.cause = Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' });
    assert.equal(isAmbiguousSendError(transportError), true);
    await assert.rejects(
      () => processJob({ data: {
        kind: 'text', accountId: 1, to: '5210000000000',
        localMessageId: 'local-queue', requiresSurfaceContract: true,
        payload: { body: `${persistedBody} alterado` },
      } }),
      error => error.code === 'SURFACE_URL_MISMATCH',
    );
    assert.equal(metaCalls, 0);
    delete require.cache[queueModulePath];
  } finally {
    for (const [modulePath, original] of originals) {
      if (original) require.cache[modulePath] = original;
      else delete require.cache[modulePath];
    }
  }
});
