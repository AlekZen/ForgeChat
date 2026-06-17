// G13 (2026-06-17): sugerencia de PERSONA al capturar un contacto por vCard.
// Gap origen: `notifyOwnerVcardCaptured` mandaba 10 personas PLANAS sin pista; el
// owner (puro networking BNI) tenia que cazar la correcta cada vez -> contactos
// sin clasificar. Igual que las SECUENCIAS ya se rankean/sugieren, ahora las
// PERSONAS: inferimos del nombre del vCard, subimos la fila al tope y la marcamos
// "SUGERIDA". Es solo sugerencia (un tap), conservando las 10 opciones y sus ids.
//
// Test sin deps externas (cero DB/redis/red): ejerce las funciones puras REALES
// (suggestIa360Persona, buildVcardPersonaRows) que webhook.js importa en prod
// (se afirma el cableado abajo).

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  suggestIa360Persona,
  buildVcardPersonaRows,
  VCARD_PERSONA_ROWS,
} = require('../src/routes/ia360PersonaSuggest');

const TARGET = '5219990012345';

test('infiere persona_referido cuando el nombre trae BNI', () => {
  const s = suggestIa360Persona({ name: 'Carlos Chavez BNI Industrial', contactNumber: TARGET });
  assert.equal(s.persona, 'persona_referido');
  assert.ok(typeof s.reason === 'string' && s.reason.length > 0);
});

test('infiere persona_aliado por "socio"/"proveedor"', () => {
  assert.equal(suggestIa360Persona({ name: 'Juan socio proveedor' }).persona, 'persona_aliado');
  assert.equal(suggestIa360Persona({ name: 'Ana partner de canal' }).persona, 'persona_aliado');
});

test('infiere persona_cfo por "CFO"/"finanzas"/"tesoreria"', () => {
  assert.equal(suggestIa360Persona({ name: 'Laura CFO' }).persona, 'persona_cfo');
  assert.equal(suggestIa360Persona({ name: 'Mario Finanzas' }).persona, 'persona_cfo');
  // acento-insensible: "tesorería" debe matchear la senal "tesoreri".
  assert.equal(suggestIa360Persona({ name: 'Rosa Tesorería' }).persona, 'persona_cfo');
});

test('infiere persona_comercial por "director comercial"/"ventas"', () => {
  assert.equal(suggestIa360Persona({ name: 'Pedro Director Comercial' }).persona, 'persona_comercial');
  assert.equal(suggestIa360Persona({ name: 'Sofia Ventas' }).persona, 'persona_comercial');
});

test('infiere persona_tecnico por "CTO"/"sistemas"/"TI"', () => {
  assert.equal(suggestIa360Persona({ name: 'Hugo CTO' }).persona, 'persona_tecnico');
  assert.equal(suggestIa360Persona({ name: 'Beto Sistemas' }).persona, 'persona_tecnico');
  assert.equal(suggestIa360Persona({ name: 'Lupe TI corporativo' }).persona, 'persona_tecnico');
});

test('infiere persona_sponsor por "CEO"/"director general"/"dueno"', () => {
  assert.equal(suggestIa360Persona({ name: 'Raul CEO' }).persona, 'persona_sponsor');
  assert.equal(suggestIa360Persona({ name: 'Elena Directora General' }).persona, 'persona_sponsor');
  assert.equal(suggestIa360Persona({ name: 'Don Memo dueño' }).persona, 'persona_sponsor');
});

test('nombre neutro -> null (no inventa)', () => {
  assert.equal(suggestIa360Persona({ name: 'Pedro Ramirez' }), null);
  assert.equal(suggestIa360Persona({ name: '' }), null);
  assert.equal(suggestIa360Persona({}), null);
  assert.equal(suggestIa360Persona({ name: null }), null);
});

test('case/acento-insensible: "bni" minusculas y "BNI" mayusculas igual', () => {
  assert.equal(suggestIa360Persona({ name: 'jorge bni' }).persona, 'persona_referido');
  assert.equal(suggestIa360Persona({ name: 'JORGE BNI' }).persona, 'persona_referido');
  assert.equal(suggestIa360Persona({ name: 'Ing Jorge Sámano BNI' }).persona, 'persona_referido');
});

test('con sugerencia: la fila sugerida va PRIMERA y marcada, sin perder ninguna', () => {
  const suggestion = suggestIa360Persona({ name: 'Carlos Chavez BNI', contactNumber: TARGET });
  const rows = buildVcardPersonaRows({ contactNumber: TARGET, suggestion });
  // siguen siendo 10 filas.
  assert.equal(rows.length, 10);
  // la primera es la sugerida (referido) y esta marcada SUGERIDA.
  assert.equal(rows[0].id, `owner_pipe:${TARGET}:persona_referido`);
  assert.match(rows[0].description, /^SUGERIDA · /);
  // titulo intacto (sin marca) y dentro del limite de WhatsApp.
  assert.equal(rows[0].title, 'Referido / BNI');
  // limites de la API de WhatsApp: title <=24, description <=72.
  for (const r of rows) {
    assert.ok(r.title.length <= 24, `title largo: ${r.title}`);
    assert.ok(r.description.length <= 72, `description larga: ${r.description}`);
  }
  // ningun otro row queda marcado SUGERIDA.
  assert.equal(rows.slice(1).filter(r => /SUGERIDA/.test(r.description)).length, 0);
  // los 10 ids siguen TODOS presentes (no se elimino ninguno).
  const ids = new Set(rows.map(r => r.id));
  for (const base of VCARD_PERSONA_ROWS) {
    assert.ok(ids.has(`owner_pipe:${TARGET}:${base.key}`), `falta id ${base.key}`);
  }
});

test('sin sugerencia: la lista queda EXACTAMENTE como hoy (orden + ids + textos)', () => {
  const rows = buildVcardPersonaRows({ contactNumber: TARGET, suggestion: null });
  const expected = VCARD_PERSONA_ROWS.map(r => ({
    id: `owner_pipe:${TARGET}:${r.key}`,
    title: r.title,
    description: r.description,
  }));
  assert.deepEqual(rows, expected);
  // ninguna fila marcada SUGERIDA.
  assert.equal(rows.filter(r => /SUGERIDA/.test(r.description)).length, 0);
});

test('persona desconocida en suggestion -> lista intacta (fail-safe)', () => {
  const rows = buildVcardPersonaRows({ contactNumber: TARGET, suggestion: { persona: 'persona_inexistente' } });
  assert.equal(rows.length, 10);
  assert.equal(rows[0].id, `owner_pipe:${TARGET}:persona_beta`);
  assert.equal(rows.filter(r => /SUGERIDA/.test(r.description)).length, 0);
});

test('cableado real: webhook.js importa y usa el modulo G13', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/webhook.js'), 'utf8');
  assert.ok(src.includes("require('./ia360PersonaSuggest')"), 'webhook.js no importa el modulo');
  assert.ok(/suggestIa360Persona\(shared\)/.test(src), 'no llama suggestIa360Persona(shared)');
  assert.ok(/buildVcardPersonaRows\(\{/.test(src), 'no llama buildVcardPersonaRows');
});
