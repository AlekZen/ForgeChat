const test = require('node:test');
const assert = require('node:assert/strict');

function responseCapture() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('POST /messages/send valida y persiste el handoff sin superficie', async () => {
  const modulePaths = [
    require.resolve('../src/db'),
    require.resolve('../src/services/messageSender'),
    require.resolve('../src/services/outboundSurfaceContract'),
    require.resolve('../src/queue/sendQueue'),
    require.resolve('../src/integrations/metaSend'),
    require.resolve('../src/services/accountHealth'),
    require.resolve('../src/util/pgStorage'),
    require.resolve('../src/routes/mediaLibrary'),
    require.resolve('../src/middleware/access'),
    require.resolve('../src/services/metaReadService'),
    require.resolve('../src/permissions'),
    require.resolve('../src/util/metaMime'),
  ];
  const originals = new Map(modulePaths.map(modulePath => [modulePath, require.cache[modulePath]]));
  const stub = (modulePath, exports) => {
    require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
  };
  const inserted = [];
  const enqueued = [];
  const routesPath = require.resolve('../src/routes/messages');

  try {
    stub(require.resolve('../src/db'), { query: async () => ({ rows: [] }) });
    stub(require.resolve('../src/services/messageSender'), {
      resolveAccount: async () => ({
        account: { id: 1, phoneNumberId: 'phone-fixture', displayPhoneNumber: '5210000004582' },
      }),
      insertPendingRow: async args => {
        inserted.push(args);
        return 'local-handoff';
      },
      secondsSinceLastIncoming: async () => 30,
      localMessageId: () => 'local-surface',
    });
    class SurfaceContractError extends Error {}
    stub(require.resolve('../src/services/outboundSurfaceContract'), {
      SurfaceContractError,
      resolveContactAccountKey: async () => 'camiones-selectos',
      attestOutboundPayload: async () => ({ attestationRef: 'a_fixture' }),
    });
    stub(require.resolve('../src/queue/sendQueue'), {
      enqueueSend: async args => enqueued.push(args),
    });
    stub(require.resolve('../src/integrations/metaSend'), { uploadMedia: async () => ({}) });
    stub(require.resolve('../src/services/accountHealth'), {
      markAccountHealth: async () => {}, classifyMetaError: () => 'unknown',
    });
    stub(require.resolve('../src/util/pgStorage'), {});
    stub(require.resolve('../src/routes/mediaLibrary'), { syncMediaToAccount: async () => ({}) });
    stub(require.resolve('../src/middleware/access'), {
      userWaNumbers: async () => [],
      assertWaAccess: async () => true,
      assertContactAccess: async () => true,
      requirePermission: () => (_req, _res, next) => next(),
    });
    stub(require.resolve('../src/services/metaReadService'), {
      recordProcessingEvidence: async () => {},
      listMetaReadCandidates: async () => [],
      confirmMetaRead: async () => {},
    });
    stub(require.resolve('../src/permissions'), { isAdmin: () => false });
    stub(require.resolve('../src/util/metaMime'), {
      canonicalizeMime: value => value,
      mediaFormatFor: () => null,
      chatKindFor: () => null,
      CHAT_TYPES_MSG: 'fixture',
    });

    delete require.cache[routesPath];
    const { router } = require('../src/routes/messages');
    const layer = router.stack.find(entry => entry.route?.path === '/messages/send');
    assert.ok(layer, 'ruta /messages/send registrada');
    const handler = layer.route.stack.at(-1).handle;
    const baseBody = {
      fromNumber: '5210000004582',
      toNumber: '5210000008033',
      text: '¿mayo sustituye o suma?',
    };

    const validRes = responseCapture();
    await handler({
      body: {
        ...baseBody,
        caseRef: ' CAM-84 ',
        replyContext: ' Responder si mayo sustituye o suma. ',
      },
      user: { id: 'operator-fixture' },
    }, validRes);

    assert.equal(validRes.statusCode, 202);
    assert.equal(inserted.length, 1);
    assert.deepEqual(inserted[0].templateMeta, {
      source: 'nexus_cli',
      case_ref: 'CAM-84',
      reply_context: 'Responder si mayo sustituye o suma.',
    });
    assert.equal(inserted[0].caseRef, undefined);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].requiresSurfaceContract, false);

    const invalidBodies = [
      { ...baseBody, caseRef: 'CAM-84' },
      { ...baseBody, replyContext: 'sin caso' },
      { ...baseBody, caseRef: 'X'.repeat(121), replyContext: 'contexto' },
      { ...baseBody, caseRef: 'CAM-84', replyContext: 'X'.repeat(501) },
      { ...baseBody, caseRef: 'CAM-84', replyContext: 'contexto', author: 'cliente' },
    ];
    for (const body of invalidBodies) {
      const res = responseCapture();
      await handler({ body, user: { id: 'operator-fixture' } }, res);
      assert.equal(res.statusCode, 400);
    }
    assert.equal(inserted.length, 1, 'ningún contrato inválido persiste');
    assert.equal(enqueued.length, 1, 'ningún contrato inválido encola');
  } finally {
    delete require.cache[routesPath];
    for (const [modulePath, original] of originals) {
      if (original) require.cache[modulePath] = original;
      else delete require.cache[modulePath];
    }
  }
});
