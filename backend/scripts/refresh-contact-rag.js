#!/usr/bin/env node
'use strict';

try { require('dotenv').config(); } catch (_) { /* dotenv is optional for host-side operations */ }

const {
  buildIa360AntiLeakSql,
  buildIa360RefreshContactRagSql,
} = require('../src/services/ia360MemoryIsolation');

function getPool() {
  return require('../src/db');
}

function usage() {
  return `Usage:
  node scripts/refresh-contact-rag.js --contact-id <id> --source-chat-history-id <id> --area <area> --summary <text> [options]

Options:
  --signal-type <type>       Default: mejora_en_proceso
  --status <status>          captured | audit-in-progress | fix-prepared | deployed | needs-retest | closed
  --business-impact <text>
  --missing-data <text>
  --next-action <text>
  --affected-process <text>  Default: --area
  --recurring-pain <text>    Default: --summary
  --anti-leak-contacts <ids> Comma list. Default: contact id only; use 544,768 for Camiones beta check.
  --dry-run                  Print SQL only; do not write.
  --verify-only              Only run anti-leak checks; do not write.
`;
}

function parseArgs(argv) {
  const out = { dryRun: false, verifyOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--dry-run') { out.dryRun = true; continue; }
    if (key === '--verify-only') { out.verifyOnly = true; continue; }
    if (key === '--help' || key === '-h') { out.help = true; continue; }
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    i += 1;
    const field = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[field] = value;
  }
  return out;
}

function requireInt(input, name) {
  const n = Number(input);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function antiLeakIds(args) {
  const raw = args.antiLeakContacts || String(args.contactId || '');
  const ids = raw.split(',').map(s => Number(s.trim())).filter(Number.isInteger);
  if (!ids.includes(Number(args.contactId))) ids.unshift(Number(args.contactId));
  return [...new Set(ids)];
}

async function runAntiLeak(pool, contactIds) {
  const factSql = buildIa360AntiLeakSql({ contactIds, table: 'facts' });
  const eventSql = buildIa360AntiLeakSql({ contactIds, table: 'events' });
  const [factRows, eventRows] = await Promise.all([
    pool.query(factSql),
    pool.query(eventSql),
  ]);
  return { factLeaks: factRows.rows, eventLeaks: eventRows.rows };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(usage()); return; }
  args.contactId = requireInt(args.contactId, 'contact-id');
  if (!args.verifyOnly) args.sourceChatHistoryId = requireInt(args.sourceChatHistoryId, 'source-chat-history-id');
  if (!args.verifyOnly && !args.area) throw new Error('--area is required');
  if (!args.verifyOnly && !args.summary) throw new Error('--summary is required');

  const contactIds = antiLeakIds(args);
  const refreshSql = args.verifyOnly ? '' : buildIa360RefreshContactRagSql(args);
  const factSql = buildIa360AntiLeakSql({ contactIds, table: 'facts' });
  const eventSql = buildIa360AntiLeakSql({ contactIds, table: 'events' });

  if (args.dryRun) {
    if (refreshSql) console.log(`-- refresh-contact-rag\n${refreshSql}\n`);
    console.log(`-- anti-leak facts\n${factSql}\n`);
    console.log(`-- anti-leak events\n${eventSql}\n`);
    return;
  }

  const pool = getPool();
  const before = await runAntiLeak(pool, contactIds);
  if (before.factLeaks.length || before.eventLeaks.length) {
    throw new Error(`Anti-leak preflight failed: facts=${before.factLeaks.length} events=${before.eventLeaks.length}`);
  }
  console.log(`[refresh-contact-rag] anti-leak preflight OK contacts=${contactIds.join(',')}`);

  if (!args.verifyOnly) {
    const result = await pool.query(refreshSql);
    console.log(`[refresh-contact-rag] upsert OK rows=${result.rowCount}`);
    for (const row of result.rows) {
      console.log(JSON.stringify(row));
    }
  }

  const after = await runAntiLeak(pool, contactIds);
  if (after.factLeaks.length || after.eventLeaks.length) {
    throw new Error(`Anti-leak postflight failed: facts=${after.factLeaks.length} events=${after.eventLeaks.length}`);
  }
  console.log(`[refresh-contact-rag] anti-leak postflight OK contacts=${contactIds.join(',')}`);
}

main().catch(err => {
  console.error(`[refresh-contact-rag] ERROR ${err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  try {
    const db = require.cache[require.resolve('../src/db')]?.exports;
    if (db && typeof db.end === 'function') await db.end();
  } catch (_) {}
});
