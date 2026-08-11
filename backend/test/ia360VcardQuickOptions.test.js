// G-FIX5 (2026-06-18): tarjeta CORTA de opciones rapidas cuando el vCard NO trae
// senal de persona. Antes: nombre neutro (ej. "Musio Lopez") caia directo a la
// lista completa de 10 personas. Ahora: 4 opciones rapidas + "Ver todas las
// personas..." (reabre la lista de 10). Con senal, el 1-tap de G-FIX3 se conserva.
//
// Test sin deps externas: ejerce la funcion pura REAL (buildVcardQuickRows) que
// webhook.js importa en prod, y afirma el cableado leyendo el fuente.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildVcardQuickRows,
  seeAllRowId,
  VCARD_QUICK_OPTIONS,
} = require('../src/routes/ia360VcardQuickOptions');

const TARGET = '5219990012345';

test('emite 6 filas: 5 opciones rapidas + Ver todas', () => {
  const rows = buildVcardQuickRows({ contactNumber: TARGET });
  assert.equal(rows.length, 6);
  const lastId = rows[5].id;
  assert.equal(lastId, seeAllRowId(TARGET));
  assert.equal(lastId, `owner_vcard_seeall:${TARGET}`);
  assert.match(rows[5].title, /Ver todas/i);
});

test('las opciones rapidas reusan ids owner_pipe:<num>:<key> existentes', () => {
  const rows = buildVcardQuickRows({ contactNumber: TARGET });
  const quick = rows.slice(0, 5).map(r => r.id);
  assert.deepEqual(quick, [
    `owner_pipe:${TARGET}:persona_referido`, // Referido / BNI
    `owner_pipe:${TARGET}:persona_beta`,     // Beta / amigo
    `owner_pipe:${TARGET}:persona_cliente`,  // Cliente activo
    `owner_pipe:${TARGET}:persona_diapazo`,  // P10: Sesion de Afinacion (Diapazo)
    `owner_pipe:${TARGET}:guardar`,          // Solo guardar (terminal, sin secuencia)
  ]);
});

test('"Referido / BNI" mapea a persona_referido y queda visible en opciones rapidas', () => {
  assert.equal(VCARD_QUICK_OPTIONS[0].key, 'persona_referido');
  assert.match(VCARD_QUICK_OPTIONS[0].title, /BNI/i);
});

test('P10: "Diapazo · Afinacion" es opcion fija de la tarjeta corta', () => {
  assert.equal(VCARD_QUICK_OPTIONS[3].key, 'persona_diapazo');
  assert.match(VCARD_QUICK_OPTIONS[3].title, /diapazo/i);
});

test('"Solo guardar" usa la persona terminal guardar (captura sin envio)', () => {
  assert.equal(VCARD_QUICK_OPTIONS[4].key, 'guardar');
});

test('titles<=24 y descriptions<=72 (limites WhatsApp list rows)', () => {
  for (const r of buildVcardQuickRows({ contactNumber: TARGET })) {
    assert.ok(r.title.length <= 24, `title largo: ${r.title}`);
    assert.ok(r.description.length <= 72, `desc larga: ${r.description}`);
  }
});

// ── Cableado en webhook.js (lo que de verdad corre en prod) ──────────────────
const WEBHOOK = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webhook.js'), 'utf8');

test('webhook importa y usa buildVcardQuickRows', () => {
  assert.match(WEBHOOK, /require\('\.\/ia360VcardQuickOptions'\)/);
  assert.match(WEBHOOK, /buildVcardQuickRows\(/);
});

test('SIN senal de persona, notifyOwnerVcardCaptured emite la tarjeta corta (no la lista de 10 directa)', () => {
  // El fallback "if (!flow)" del 1-tap debe llamar a sendIa360VcardQuickList.
  const m = WEBHOOK.match(/if \(!flow\) \{[\s\S]{0,400}?\n    \}/);
  assert.ok(m, 'no encontre el bloque if (!flow)');
  assert.match(m[0], /return await sendIa360VcardQuickList\(\{ record, shared \}\)/);
  // el return real es la tarjeta corta, no la lista de 10
  assert.doesNotMatch(m[0], /return await sendIa360VcardPersonaList/);
});

test('CON senal de persona, se conserva el 1-tap (emitIa360SequenceReadoutCard con allowVcardChange)', () => {
  // El camino feliz del 1-tap (G-FIX3) sigue intacto.
  assert.match(WEBHOOK, /return await emitIa360SequenceReadoutCard\(\{[\s\S]{0,200}?allowVcardChange: true/);
});

test('"Ver todas" (owner_vcard_seeall) reabre la lista completa', () => {
  assert.match(WEBHOOK, /ownerAction === 'owner_vcard_seeall'/);
});

test('sendIa360VcardQuickList usa label owner_vcard_captured_ (compatible con la validacion de contexto owner_pipe)', () => {
  const m = WEBHOOK.match(/async function sendIa360VcardQuickList[\s\S]*?\n\}\n/);
  assert.ok(m, 'no encontre sendIa360VcardQuickList');
  assert.match(m[0], /label: `owner_vcard_captured_\$\{shared\.contactNumber\}`/);
});
