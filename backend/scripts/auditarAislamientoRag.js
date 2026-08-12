// Auditor de la «jaula»: ¿algún contacto podría recuperar memoria de otro?
//
// POR QUÉ EXISTE (12-ago-2026): el aislamiento por contacto lo garantiza el WHERE
// de ia360MemoryIsolation, y hay tests que verifican la FORMA de ese SQL. Lo que
// no existía era un runner contra los DATOS REALES: `buildIa360AntiLeakSql` sólo
// se usaba en su propio test. Al empezar a leer medios y documentos, el texto de
// un archivo entra a message_body y de ahí a la captura de memoria — así que hace
// falta poder preguntarle a la base, no al código, si hay fuga.
//
// Qué hace: por cada contacto con memoria, simula lo que ESE contacto recuperaría
// y devuelve SÓLO las filas que serían una fuga (memoria privada de otro contacto).
// Cero filas = sano. Es de sólo lectura.
//
// Sale con código 1 si hay una sola fuga. Ese código es el criterio de aceptación.
//
//   docker exec forgecrm-backend node /app/scripts/auditarAislamientoRag.js
//   docker exec forgecrm-backend node /app/scripts/auditarAislamientoRag.js --simular-fuga
//
// --simular-fuga es la prueba negativa: un auditor que siempre dice «0» no prueba
// nada. Inserta dentro de una transacción una fila con la identidad del contacto A
// pero el forgechat_contact_id de otro contacto B, corre el mismo SQL y hace
// ROLLBACK. Debe reportar `FUGAS facts=1` y salir 1. No deja rastro en la base.

const pool = require('/app/src/db');
const { buildIa360AntiLeakSql } = require('/app/src/services/ia360MemoryIsolation');

const SIMULAR = process.argv.slice(2).includes('--simular-fuga');

async function contactosConMemoria(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT forgechat_contact_id AS id
       FROM coexistence.ia360_memory_facts WHERE forgechat_contact_id IS NOT NULL
      UNION
     SELECT DISTINCT forgechat_contact_id
       FROM coexistence.ia360_memory_events WHERE forgechat_contact_id IS NOT NULL`
  );
  return rows.map(r => Number(r.id)).filter(Number.isInteger);
}

async function fugasDe(db, contactIds, table) {
  const { rows } = await db.query(buildIa360AntiLeakSql({ contactIds, table }));
  return rows;
}

function imprimirFugas(table, filas) {
  const idCol = table === 'events' ? 'event_id' : 'fact_id';
  const contactCol = table === 'events' ? 'event_contact_id' : 'fact_contact_id';
  for (const f of filas.slice(0, 10)) {
    console.log(`    ${table}: contacto ${f.requesting_contact_id} (${f.requesting_contact || '-'}) vería ${idCol}=${f[idCol]} de contacto ${f[contactCol]} · project=${f.project_name || '-'}`);
  }
  if (filas.length > 10) console.log(`    … y ${filas.length - 10} más`);
}

// Siembra la fuga: identidad del contacto A, dueño declarado B. La jaula deja pasar
// la fila hacia A (coincide su wa_number/contact_number) pero pertenece a B.
async function sembrarFuga(db) {
  const { rows: contactos } = await db.query(
    `SELECT id, contact_number, wa_number FROM coexistence.contacts
      WHERE COALESCE(wa_number,'') <> '' AND COALESCE(contact_number,'') <> ''
      ORDER BY id LIMIT 2`
  );
  if (contactos.length < 2) throw new Error('hacen falta 2 contactos con wa_number para simular');
  const [a, b] = contactos;
  await db.query(
    `INSERT INTO coexistence.ia360_memory_facts
       (fact_key, source, contact_wa_number, contact_number, forgechat_contact_id,
        project_name, recurring_pain, affected_process)
     VALUES ($1, 'simulacro', $2, $3, $4, '', 'fila de simulacro (ROLLBACK)', 'simulacro')`,
    [`simulacro_fuga:${Date.now()}`, a.wa_number, a.contact_number, b.id]
  );
  console.log(`  Simulacro: fila con identidad del contacto ${a.id} pero forgechat_contact_id=${b.id}`);
  return a.id;
}

(async () => {
  const db = await pool.connect();
  let salida = 0;
  try {
    if (SIMULAR) await db.query('BEGIN');
    const ids = new Set(await contactosConMemoria(db));
    if (SIMULAR) ids.add(await sembrarFuga(db));
    const contactIds = [...ids];
    if (!contactIds.length) {
      console.log('FUGAS facts=0 events=0  (no hay memoria por contacto todavía)');
      return;
    }
    console.log(`  ${contactIds.length} contacto(s) con memoria auditados`);

    const facts = await fugasDe(db, contactIds, 'facts');
    const events = await fugasDe(db, contactIds, 'events');
    console.log(`FUGAS facts=${facts.length} events=${events.length}`);
    if (facts.length) imprimirFugas('facts', facts);
    if (events.length) imprimirFugas('events', events);
    salida = facts.length || events.length ? 1 : 0;
  } catch (e) {
    console.error('ERROR:', e.message);
    salida = 1;
  } finally {
    if (SIMULAR) await db.query('ROLLBACK').catch(() => {});
    db.release();
  }
  process.exit(salida);
})();
