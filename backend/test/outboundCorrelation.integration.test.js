const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`Docker no pudo ejecutar ${args[0]}.`);
  }
  return result;
}

function publishedPort(container, internalPort) {
  const output = docker(['port', container, `${internalPort}/tcp`]).stdout.trim();
  const match = output.match(/:(\d+)$/);
  if (!match) throw new Error('Docker no publicó el puerto del harness.');
  return Number(match[1]);
}

async function waitFor(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Los servicios efímeros del harness no quedaron listos.');
}

test('correlación saliente usa Postgres y Redis reales en contenedores efímeros', async () => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const postgresName = `forgecrm-g1-postgres-${suffix}`;
  const redisName = `forgecrm-g1-redis-${suffix}`;
  let postgresStarted = false;
  let redisStarted = false;
  let pool;
  let redis;
  let queue;
  let outboundQueue;
  let shutdownSendQueue;

  try {
    docker([
      'run', '-d', '--rm', '--name', postgresName,
      '-e', 'POSTGRES_PASSWORD=g1-integration-only',
      '-e', 'POSTGRES_DB=g1_integration',
      '-p', '127.0.0.1::5432',
      'postgres:15',
    ]);
    postgresStarted = true;
    docker([
      'run', '-d', '--rm', '--name', redisName,
      '-p', '127.0.0.1::6379',
      'redis:7-alpine',
    ]);
    redisStarted = true;

    await waitFor(() => docker(['exec', postgresName, 'pg_isready', '-U', 'postgres', '-d', 'g1_integration'], { allowFailure: true }).status === 0);
    await waitFor(() => docker(['exec', redisName, 'redis-cli', 'ping'], { allowFailure: true }).stdout.trim() === 'PONG');

    const postgresPort = publishedPort(postgresName, 5432);
    const redisPort = publishedPort(redisName, 6379);
    const { Client } = require('pg');
    await waitFor(async () => {
      const probe = new Client({
        host: '127.0.0.1',
        port: postgresPort,
        database: 'g1_integration',
        user: 'postgres',
        password: 'g1-integration-only',
      });
      try {
        await probe.connect();
        await probe.query('SELECT 1');
        return true;
      } catch {
        return false;
      } finally {
        await probe.end().catch(() => {});
      }
    });

    process.env.DATABASE_URL = '';
    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_PORT = String(postgresPort);
    process.env.DB_NAME = 'g1_integration';
    process.env.DB_USER = 'postgres';
    process.env.DB_PASSWORD = 'g1-integration-only';
    process.env.POSTGRES_SSL = 'false';
    process.env.REDIS_URL = `redis://127.0.0.1:${redisPort}`;

    pool = require('../src/db');
    const { insertPendingRow, markSent, markFailed } = require('../src/services/messageSender');
    const { recordOutboundStatus } = require('../src/services/outboundStatusReceipt');
    const IORedis = require('ioredis');
    const { Queue } = require('bullmq');
    const sendQueueModule = require('../src/queue/sendQueue');
    outboundQueue = sendQueueModule.sendQueue;
    shutdownSendQueue = sendQueueModule.shutdownSendQueue;

    await pool.query('CREATE SCHEMA coexistence');
    await pool.query(`CREATE TABLE coexistence.chat_history (
      message_id TEXT NOT NULL UNIQUE,
      send_correlation_id TEXT,
      phone_number_id TEXT,
      wa_number TEXT NOT NULL,
      contact_number TEXT NOT NULL,
      to_number TEXT,
      direction TEXT NOT NULL,
      message_type TEXT NOT NULL,
      message_body TEXT,
      raw_payload JSONB,
      media_url TEXT,
      media_mime_type TEXT,
      status TEXT,
      timestamp TIMESTAMPTZ NOT NULL,
      template_meta JSONB,
      context_message_id TEXT,
      error_message TEXT
    )`);
    await pool.query(`CREATE UNIQUE INDEX chat_history_ia360_handler_dedupe
      ON coexistence.chat_history (contact_number, (template_meta->>'ia360_handler_for'))
      WHERE direction = 'outgoing' AND (template_meta->>'ia360_handler_for') IS NOT NULL`);
    await pool.query(`CREATE UNIQUE INDEX idx_chat_outbound_correlation
      ON coexistence.chat_history (send_correlation_id)
      WHERE send_correlation_id IS NOT NULL`);
    await pool.query(`CREATE TABLE coexistence.outbound_status_receipts (
      message_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      error_message TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    const account = { phoneNumberId: 'qa-account', displayPhoneNumber: 'qa-account' };
    const localId = await insertPendingRow({
      account,
      toNumber: 'qa-contact',
      messageType: 'text',
      messageBody: 'g1 correlation probe',
    });
    let result = await pool.query(
      'SELECT message_id, send_correlation_id, status FROM coexistence.chat_history WHERE send_correlation_id = $1',
      [localId],
    );
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].message_id, localId);
    assert.equal(result.rows[0].send_correlation_id, localId);

    const wamid = `wamid.g1.${suffix}`;
    await markSent(localId, wamid);
    result = await pool.query(
      'SELECT message_id, send_correlation_id, status FROM coexistence.chat_history WHERE send_correlation_id = $1',
      [localId],
    );
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].message_id, wamid);
    assert.equal(result.rows[0].send_correlation_id, localId);
    assert.equal(result.rows[0].status, 'sent');

    const racedId = await insertPendingRow({
      account,
      toNumber: 'qa-contact',
      messageType: 'text',
      messageBody: 'g1 raced receipt probe',
    });
    const racedWamid = `wamid.g1.raced.${suffix}`;
    assert.equal(await recordOutboundStatus(pool, { messageId: racedWamid, status: 'delivered' }), 0);
    await markSent(racedId, racedWamid);
    result = await pool.query(
      'SELECT status FROM coexistence.chat_history WHERE send_correlation_id = $1',
      [racedId],
    );
    assert.equal(result.rows[0].status, 'delivered');
    result = await pool.query(
      'SELECT COUNT(*)::int AS count FROM coexistence.outbound_status_receipts WHERE message_id = $1',
      [racedWamid],
    );
    assert.equal(result.rows[0].count, 0);

    const concurrentId = await insertPendingRow({
      account,
      toNumber: 'qa-contact',
      messageType: 'text',
      messageBody: 'g1 concurrent receipt probe',
    });
    const concurrentWamid = `wamid.g1.concurrent.${suffix}`;
    const webhookClient = await pool.connect();
    let webhookCommitted = false;
    try {
      await webhookClient.query('BEGIN');
      assert.equal(await recordOutboundStatus(webhookClient, { messageId: concurrentWamid, status: 'delivered' }), 0);
      let markSettled = false;
      const markPromise = markSent(concurrentId, concurrentWamid).finally(() => { markSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(markSettled, false);
      await webhookClient.query('COMMIT');
      webhookCommitted = true;
      await markPromise;
    } finally {
      if (!webhookCommitted) await webhookClient.query('ROLLBACK').catch(() => {});
      webhookClient.release();
    }
    result = await pool.query(
      'SELECT status FROM coexistence.chat_history WHERE send_correlation_id = $1',
      [concurrentId],
    );
    assert.equal(result.rows[0].status, 'delivered');

    const linkedId = await insertPendingRow({
      account,
      toNumber: 'qa-contact',
      messageType: 'text',
      messageBody: 'g1 linked receipt probe',
    });
    const linkedWamid = `wamid.g1.linked.${suffix}`;
    await markSent(linkedId, linkedWamid);
    assert.equal(await recordOutboundStatus(pool, { messageId: linkedWamid, status: 'read' }), 1);
    result = await pool.query(
      'SELECT status FROM coexistence.chat_history WHERE send_correlation_id = $1',
      [linkedId],
    );
    assert.equal(result.rows[0].status, 'read');
    assert.equal(await recordOutboundStatus(pool, { messageId: linkedWamid, status: 'sent' }), 1);
    result = await pool.query(
      'SELECT status FROM coexistence.chat_history WHERE send_correlation_id = $1',
      [linkedId],
    );
    assert.equal(result.rows[0].status, 'read');

    const deliveredId = await insertPendingRow({
      account,
      toNumber: 'qa-contact',
      messageType: 'text',
      messageBody: 'g2 late failure probe',
    });
    const deliveredWamid = `wamid.g2.delivered.${suffix}`;
    await markSent(deliveredId, deliveredWamid);
    assert.equal(await recordOutboundStatus(pool, { messageId: deliveredWamid, status: 'delivered' }), 1);
    assert.equal(await markFailed(deliveredId, 'late worker failure'), false);
    result = await pool.query(
      'SELECT status, error_message FROM coexistence.chat_history WHERE send_correlation_id = $1',
      [deliveredId],
    );
    assert.equal(result.rows[0].status, 'delivered');
    assert.equal(result.rows[0].error_message, null);

    const staleWamid = `wamid.g1.stale.${suffix}`;
    await pool.query(
      "INSERT INTO coexistence.outbound_status_receipts (message_id, status, received_at) VALUES ($1, 'sent', NOW() - INTERVAL '25 hours')",
      [staleWamid],
    );
    await recordOutboundStatus(pool, { messageId: `wamid.g1.external.${suffix}`, status: 'sent' });
    result = await pool.query(
      'SELECT COUNT(*)::int AS count FROM coexistence.outbound_status_receipts WHERE message_id = $1',
      [staleWamid],
    );
    assert.equal(result.rows[0].count, 0);

    const failedId = await insertPendingRow({
      account,
      toNumber: 'qa-contact',
      messageType: 'text',
      messageBody: 'g1 failed probe',
    });
    await markFailed(failedId, 'expected integration failure');
    result = await pool.query(
      'SELECT status, error_message FROM coexistence.chat_history WHERE send_correlation_id = $1',
      [failedId],
    );
    assert.equal(result.rows[0].status, 'failed');
    assert.equal(result.rows[0].error_message, 'expected integration failure');

    redis = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    queue = new Queue(`forgecrm-g1-integration-${suffix}`, { connection: redis });
    assert.equal(await redis.ping(), 'PONG');
    await queue.add('probe', { correlationId: localId }, { jobId: `g1-${suffix}` });
    const job = await queue.getJob(`g1-${suffix}`);
    assert.ok(job);
    assert.equal(job.data.correlationId, localId);

    const queuedCorrelation = `g2-at-most-once-${suffix}`;
    await sendQueueModule.enqueueSend({
      kind: 'text',
      accountId: 1,
      to: 'qa-contact',
      localMessageId: queuedCorrelation,
      payload: { body: 'queue options probe' },
    });
    const outboundJob = await outboundQueue.getJob(`send-${queuedCorrelation}`);
    assert.ok(outboundJob);
    assert.equal(outboundJob.opts.attempts, 1);
  } finally {
    if (outboundQueue) await outboundQueue.obliterate({ force: true }).catch(() => {});
    if (shutdownSendQueue) await shutdownSendQueue().catch(() => {});
    if (queue) await queue.obliterate({ force: true }).catch(() => {});
    if (queue) await queue.close().catch(() => {});
    if (redis) await redis.quit().catch(() => {});
    if (pool) await pool.end().catch(() => {});
    if (redisStarted) docker(['stop', '-t', '5', redisName], { allowFailure: true });
    if (postgresStarted) docker(['stop', '-t', '5', postgresName], { allowFailure: true });
  }
});
