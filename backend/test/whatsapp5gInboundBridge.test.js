const test = require('node:test');
const assert = require('node:assert/strict');
const { bridgeUrl, projectSignedWebhook } = require('../src/services/whatsapp5gInboundBridge');

test('disabled bridge performs no network call', async () => {
  let calls = 0;
  const result = await projectSignedWebhook({
    url: null,
    fetchImpl: async () => { calls += 1; },
  });
  assert.deepEqual(result, { skipped: true });
  assert.equal(calls, 0);
});

test('projects exact signed bytes once', async () => {
  const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');
  const signature = `sha256=${'a'.repeat(64)}`;
  const calls = [];
  const result = await projectSignedWebhook({
    rawBody,
    signature,
    url: 'https://writer.example/webhooks/meta',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
  });

  assert.deepEqual(result, { skipped: false, httpStatus: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://writer.example/webhooks/meta');
  assert.strictEqual(calls[0].options.body, rawBody);
  assert.equal(calls[0].options.headers['x-hub-signature-256'], signature);
});

test('rejects missing signature before network use', async () => {
  let calls = 0;
  await assert.rejects(
    projectSignedWebhook({
      rawBody: Buffer.from('{}'),
      url: 'https://writer.example/webhooks/meta',
      fetchImpl: async () => { calls += 1; },
    }),
    /bridge_signature_missing/,
  );
  assert.equal(calls, 0);
});

test('provider failure exposes status only', async () => {
  await assert.rejects(
    projectSignedWebhook({
      rawBody: Buffer.from('{"private":"payload"}'),
      signature: `sha256=${'b'.repeat(64)}`,
      url: 'https://writer.example/webhooks/meta',
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    (error) => error.message === 'bridge_http_503' && !error.message.includes('private'),
  );
});

test('configured bridge requires HTTPS', () => {
  assert.equal(bridgeUrl({}), null);
  assert.throws(
    () => bridgeUrl({ WHATSAPP_5G_BRIDGE_URL: 'http://writer.example/webhooks/meta' }),
    /bridge_url_must_be_https/,
  );
});
