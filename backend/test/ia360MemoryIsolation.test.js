'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildIa360MemoryJaulaWhere,
  buildIa360AntiLeakSql,
  buildIa360RefreshContactRagSql,
} = require('../src/services/ia360MemoryIsolation');

test('jaula WHERE requires exact private contact match before project match', () => {
  const where = buildIa360MemoryJaulaWhere();
  assert.match(where, /contact_wa_number=\$1 AND contact_number=\$2/);
  assert.match(where, /forgechat_contact_id IS NULL/);
  assert.match(where, /COALESCE\(contact_wa_number,''\)=''/);
  assert.match(where, /COALESCE\(contact_number,''\)=''/);
  assert.doesNotMatch(where, /OR \(\$3::text IS NOT NULL AND \$3<>'' AND\s*regexp_replace\(lower\(project_name\)/);
});

test('anti-leak SQL fails only contact-private rows retrieved by another contact', () => {
  const sql = buildIa360AntiLeakSql({ contactIds: [544, 768], table: 'facts' });
  assert.match(sql, /WHERE id IN \(544,768\)/);
  assert.match(sql, /fact_contact_id IS NOT NULL/);
  assert.match(sql, /fact_contact_id IS DISTINCT FROM requesting_contact_id/);
  assert.match(sql, /f\.forgechat_contact_id IS NULL/);
  assert.match(sql, /COALESCE\(f\.contact_wa_number,''\)=''/);
  assert.match(sql, /COALESCE\(f\.contact_number,''\)=''/);
});

test('refresh-contact-rag SQL is contact-only and verifies source message ownership', () => {
  const sql = buildIa360RefreshContactRagSql({
    contactId: 544,
    sourceChatHistoryId: 2564,
    area: 'admin_usuarios_roles',
    signalType: 'mejora_en_proceso',
    status: 'audit-in-progress',
    summary: 'Alta de usuario/roles capturada.',
    businessImpact: 'Bloquea adopción y control.',
    nextAction: 'Auditar flujo de roles.',
    affectedProcess: 'admin_usuarios_roles',
    recurringPain: 'No encuentra rol adecuado ni acción clara para guardar rol.',
  });
  assert.match(sql, /WHERE h\.id=2564 AND c\.id=544/);
  assert.match(sql, /'contact_only'/);
  assert.match(sql, /project_name/);
  assert.match(sql, /'' AS project_name/);
  assert.match(sql, /external_send_allowed/);
  assert.match(sql, /false/);
});

test('webhook uses shared ia360MemoryIsolation WHERE builder', () => {
  const webhook = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webhook.js'), 'utf8');
  assert.match(webhook, /require\('\.\.\/services\/ia360MemoryIsolation'\)/);
  assert.match(webhook, /buildIa360MemoryJaulaWhere\(\)/);
});

// Lo que sigue blinda el vector que abrió la lectura de medios y documentos: el
// texto leído entra a message_body y alimenta la captura de memoria. Si una fila
// derivada de un medio se escribiera SIN identidad de contacto, la jaula la volvería
// visible para TODOS los contactos del mismo proyecto. La corrección, si alguno de
// estos tests cae, es sellar el contacto en ese INSERT — nunca relajar el test.

test('every ia360 memory INSERT in webhook seals the owning contact', () => {
  const webhook = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webhook.js'), 'utf8');
  const inserts = webhook.match(/INSERT INTO coexistence\.ia360_memory_(facts|events)[\s\S]{0,600}?\)/g) || [];
  assert.ok(inserts.length > 0, 'no memory INSERT found — did the table move?');
  for (const fragmento of inserts) {
    assert.match(fragmento, /contact_number/);
    assert.match(fragmento, /contact_wa_number/);
  }
});

test('media and document readers never touch cross-contact memory', () => {
  for (const archivo of ['mediaUnderstanding.js', 'documentUnderstanding.js']) {
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', archivo), 'utf8');
    // La lectura se guarda en chat_history.media_lectura, que ya es por mensaje y
    // por contacto. Estos servicios no leen ni escriben memoria.
    assert.doesNotMatch(fuente, /ia360_memory_(facts|events)/, `${archivo} toca memoria`);
    // Segundo vector: lo que sale del proceso hacia n8n. El contexto se arma sólo
    // con datos del dueño del record; meter memoria ahí la sacaría del proceso y
    // volvería dentro de una lectura guardada como contexto de ESTE contacto.
    assert.doesNotMatch(fuente, /lookupIa360MemoryContext|ia360_memory_/, `${archivo} exporta memoria`);
  }
});
