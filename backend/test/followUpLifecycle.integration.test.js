const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    input,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) throw new Error(`Docker no pudo ejecutar ${args[0]}.`);
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
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Los servicios efímeros no quedaron listos.');
}

test('follow-up lifecycle conserva una sola entrega y no reintenta estado incierto', async () => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const postgresName = `forgecrm-followup-postgres-${suffix}`;
  const redisName = `forgecrm-followup-redis-${suffix}`;
  let postgresStarted = false;
  let redisStarted = false;
  let pool;
  let queueModule;
  try {
    docker([
      'run', '-d', '--rm', '--name', postgresName,
      '-e', 'POSTGRES_PASSWORD=followup-integration-only',
      '-e', 'POSTGRES_DB=followup_integration',
      '-p', '127.0.0.1::5432', 'postgres:15',
    ]);
    postgresStarted = true;
    docker(['run', '-d', '--rm', '--name', redisName, '-p', '127.0.0.1::6379', 'redis:7-alpine']);
    redisStarted = true;
    await waitFor(() => docker([
      'exec', postgresName, 'psql', '-U', 'postgres', '-d', 'followup_integration', '-Atc', 'SELECT 1',
    ], { allowFailure: true }).status === 0);
    await waitFor(() => docker(['exec', redisName, 'redis-cli', 'ping'], { allowFailure: true }).stdout.trim() === 'PONG');

    const schemaResult = docker([
      'exec', postgresName, 'psql', '-U', 'postgres', '-d', 'followup_integration',
      '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE SCHEMA IF NOT EXISTS coexistence',
    ], { allowFailure: true });
    if (schemaResult.status !== 0) {
      throw new Error(`Schema setup failed: ${String(schemaResult.stderr || '').trim().slice(0, 300)}`);
    }
    const migrationsDir = path.resolve(__dirname, '../../db/migrations');
    const migrations = fs.readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
    for (const migration of migrations) {
      const sql = fs.readFileSync(path.join(migrationsDir, migration), 'utf8');
      const applied = docker([
        'exec', '-i', postgresName,
        'psql', '-U', 'postgres', '-d', 'followup_integration', '-v', 'ON_ERROR_STOP=1',
      ], { input: sql, allowFailure: true });
      if (applied.status !== 0) throw new Error(`Migration ${migration} failed`);
    }

    const postgresPort = publishedPort(postgresName, 5432);
    const redisPort = publishedPort(redisName, 6379);
    process.env.DATABASE_URL = '';
    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_PORT = String(postgresPort);
    process.env.DB_NAME = 'followup_integration';
    process.env.DB_USER = 'postgres';
    process.env.DB_PASSWORD = 'followup-integration-only';
    process.env.POSTGRES_SSL = 'false';
    process.env.REDIS_URL = `redis://127.0.0.1:${redisPort}`;

    pool = require('../src/db');
    const { encrypt } = require('../src/util/crypto');
    const {
      prepareFollowUp,
      claimFollowUpInbound,
      claimFollowUpOutbound,
      onFollowUpOutboundAccepted,
      onFollowUpOutboundUnknown,
    } = require('../src/services/followUpService');
    const { markSent } = require('../src/services/messageSender');
    queueModule = require('../src/queue/sendQueue');

    const account = await pool.query(
      `INSERT INTO coexistence.whatsapp_accounts
         (display_name, display_phone_number, phone_number_id, waba_id,
          access_token_encrypted, is_default, is_active)
       VALUES ('CAM fixture','5211111111111','phone-fixture','waba-fixture',$1,TRUE,TRUE)
       RETURNING id`,
      [encrypt('fixture-token')],
    );
    const accountId = account.rows[0].id;
    await pool.query(
      `INSERT INTO coexistence.contacts (wa_number, contact_number, name)
       VALUES ('5211111111111','5212222222222','Nico fixture')`,
    );
    await pool.query(
      `INSERT INTO coexistence.ia360_contact_scope
         (contact_number, account_key, rol, activo, nota)
       VALUES ('5212222222222','camiones-selectos','champion',TRUE,'fixture')`,
    );
    await pool.query(
      `INSERT INTO coexistence.message_templates
         (name, category, language, body, buttons, status, whatsapp_account_id)
       VALUES ($1,'UTILITY','es_MX',$2,$3::jsonb,'APPROVED',$4)`,
      [
        'ia360_seguimiento_entregable_v1',
        'Hola, {{1}}. Ya quedó listo {{2}} que teníamos pendiente. ¿Te lo comparto por aquí?',
        JSON.stringify([
          { type: 'QUICK_REPLY', text: 'Sí, compártelo' },
          { type: 'QUICK_REPLY', text: 'Después' },
        ]),
        accountId,
      ],
    );

    const prepared = await prepareFollowUp({
      db: pool,
      actor: { id: 'integration' },
      fromNumber: '5211111111111',
      toNumber: '5212222222222',
      caseRef: 'QA-INTEGRATION',
      deliverable: 'Prueba sintética',
      purpose: 'case_delivery',
      body: 'Aquí está la prueba sintética.',
      ttlHours: 24,
    });
    assert.match(prepared.followUpRef, /^q_[0-9a-f]{12}$/);
    let result = await pool.query(
      `SELECT state, opener_correlation_id, final_correlation_id
         FROM coexistence.message_followups WHERE public_ref=$1`,
      [prepared.followUpRef],
    );
    assert.equal(result.rows[0].state, 'prepared');
    const openerCorrelation = result.rows[0].opener_correlation_id;
    const finalCorrelation = result.rows[0].final_correlation_id;
    assert.equal(await queueModule.sendQueue.getJob(`send-${openerCorrelation.replace(/:/g, '~')}`) != null, true);

    const openerOrigin = { kind: 'follow_up_opener', ref: prepared.followUpRef };
    await claimFollowUpOutbound({ db: pool, originRef: openerOrigin });
    await markSent(openerCorrelation, 'wamid.fixture.opener');
    await onFollowUpOutboundAccepted({ db: pool, originRef: openerOrigin, wamid: 'wamid.fixture.opener' });

    const makeRecord = suffixPart => ({
      message_id: `wamid.qa.integration.${suffixPart}`,
      context_message_id: 'wamid.fixture.opener',
      phone_number_id: 'phone-fixture',
      contact_number: '5212222222222',
      message_body: 'Sí, compártelo',
    });
    const claims = await Promise.all([
      claimFollowUpInbound({ db: pool, record: makeRecord('a') }),
      claimFollowUpInbound({ db: pool, record: makeRecord('b') }),
    ]);
    assert.equal(claims.filter(item => item.consumed).length, 1);
    result = await pool.query(
      `SELECT state FROM coexistence.message_followups WHERE public_ref=$1`,
      [prepared.followUpRef],
    );
    assert.equal(result.rows[0].state, 'queued');
    result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM coexistence.chat_history WHERE send_correlation_id=$1`,
      [finalCorrelation],
    );
    assert.equal(result.rows[0].count, 1);
    assert.equal(await queueModule.sendQueue.getJob(`send-${finalCorrelation.replace(/:/g, '~')}`) != null, true);

    const deliveryOrigin = { kind: 'follow_up_delivery', ref: prepared.followUpRef };
    await claimFollowUpOutbound({ db: pool, originRef: deliveryOrigin });
    await onFollowUpOutboundUnknown({ db: pool, originRef: deliveryOrigin, publicCode: 'FOLLOWUP_SEND_UNKNOWN' });
    result = await pool.query(
      `SELECT state, last_error_code FROM coexistence.message_followups WHERE public_ref=$1`,
      [prepared.followUpRef],
    );
    assert.equal(result.rows[0].state, 'no_verificable');
    assert.equal(result.rows[0].last_error_code, 'FOLLOWUP_SEND_UNKNOWN');
  } finally {
    if (queueModule?.sendQueue) await queueModule.sendQueue.obliterate({ force: true }).catch(() => {});
    if (queueModule?.shutdownSendQueue) await queueModule.shutdownSendQueue().catch(() => {});
    if (pool) await pool.end().catch(() => {});
    if (redisStarted) docker(['stop', '-t', '5', redisName], { allowFailure: true });
    if (postgresStarted) docker(['stop', '-t', '5', postgresName], { allowFailure: true });
  }
});
