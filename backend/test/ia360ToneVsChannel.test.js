'use strict';
// G-FIX4: detector de RELACION PERSONAL (tono) vs CANAL (BNI/referido) y la
// bifurcacion de TONO ante doble señal. Sin deps externas: ejerce los modulos
// PUROS reales (ia360ReferidoIntro, ia360PersonaSuggest) + un mini-orquestador
// que replica la maquina de decision de notifyOwnerVcardCaptured.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const RI = require(path.join(__dirname, '..', 'src', 'routes', 'ia360ReferidoIntro.js'));
const PS = require(path.join(__dirname, '..', 'src', 'routes', 'ia360PersonaSuggest.js'));

const OWNER = '5213322638033';
const SANDBOX = '5219990000444';

// ── (1) Detector relacion-personal-vs-introductor ──────────────────────────
test('classifyIntroIntroducer: "es mi amiga y compañera" -> relationship', () => {
  const r = RI.classifyIntroIntroducer('Es mi amiga y compañera');
  assert.strictEqual(r.kind, 'relationship');
  assert.ok(r.value && r.value.length, 'devuelve texto saneado');
});

test('classifyIntroIntroducer: variantes de relacion', () => {
  for (const txt of ['mi colega del trabajo', 'somos vecinos', 'es de confianza', 'mi hermano', 'mi cliente de años']) {
    assert.strictEqual(RI.classifyIntroIntroducer(txt).kind, 'relationship', `"${txt}" debe ser relationship`);
  }
});

test('classifyIntroIntroducer: un NOMBRE propio -> name (no relationship)', () => {
  for (const txt of ['Jorge Samano', 'Ing. Carlos Chavez', 'Mariana Lopez BNI']) {
    assert.strictEqual(RI.classifyIntroIntroducer(txt).kind, 'name', `"${txt}" debe ser name`);
  }
});

test('buildRelationPersonalCustomFields: marca tono_personal y NO quien_intro', () => {
  const cf = RI.buildRelationPersonalCustomFields({ relationText: 'es mi amiga', nowIso: '2026-06-18T00:00:00Z' });
  assert.strictEqual(cf.tono_personal, true);
  assert.strictEqual(cf.ia360_relacion_personal, 'es mi amiga');
  assert.strictEqual(cf.quien_intro, undefined, 'jamas escribe quien_intro en la rama relacion');
});

// ── (2) Detector de conflicto de tono ──────────────────────────────────────
test('detectIa360ToneConflict: nombre "amiga BNI" -> conflict (canal+personal)', () => {
  const r = PS.detectIa360ToneConflict({ name: 'Esmeralda amiga BNI' });
  assert.strictEqual(r.conflict, true);
  assert.strictEqual(r.channel, true);
  assert.strictEqual(r.personal, true);
});

test('detectIa360ToneConflict: solo BNI -> NO conflict', () => {
  const r = PS.detectIa360ToneConflict({ name: 'Carlos Chavez BNI Industrial' });
  assert.strictEqual(r.conflict, false);
  assert.strictEqual(r.channel, true);
  assert.strictEqual(r.personal, false);
});

test('detectIa360ToneConflict: BNI + flag tono_personal persistido -> conflict', () => {
  const r = PS.detectIa360ToneConflict({ name: 'Esmeralda Cervantes Bni', relationPersonalFlag: true });
  assert.strictEqual(r.conflict, true);
});

test('detectIa360ToneConflict: nombre neutro sin flag -> NO conflict', () => {
  const r = PS.detectIa360ToneConflict({ name: 'Juan Perez' });
  assert.strictEqual(r.conflict, false);
});

// ── (3) Bifurcacion: doble señal -> tarjeta de TONO (no readout directo) ────
// Mini-orquestador espejo de notifyOwnerVcardCaptured (solo la maquina de tono).
function orchestrateVcard({ shared, relationPersonalFlag = false }, egress) {
  const tone = PS.detectIa360ToneConflict({ name: shared.name, relationPersonalFlag });
  if (tone.conflict) {
    egress.push({ to: OWNER, kind: 'tone_choice', targetContact: shared.contactNumber,
      buttons: [
        { id: `owner_tone_warm:${shared.contactNumber}`, title: 'Cálido / confianza' },
        { id: `owner_tone_referral:${shared.contactNumber}`, title: 'Referido / BNI' },
      ] });
    return { path: 'tone_choice' };
  }
  const suggestion = PS.suggestIa360Persona(shared);
  if (!suggestion) { egress.push({ to: OWNER, kind: 'persona_list' }); return { path: 'persona_list' }; }
  egress.push({ to: OWNER, kind: 'approve_card', flowKey: suggestion.persona });
  return { path: 'one_tap', flowKey: suggestion.persona };
}

test('doble señal (amiga BNI) -> tarjeta de TONO con 2 botones, no readout', () => {
  const egress = [];
  const res = orchestrateVcard({ shared: { name: 'Esmeralda amiga BNI', contactNumber: SANDBOX } }, egress);
  assert.strictEqual(res.path, 'tone_choice');
  const card = egress.find(e => e.kind === 'tone_choice');
  assert.ok(card, 'emite tarjeta de tono');
  assert.strictEqual(card.buttons.length, 2);
  assert.ok(card.buttons.some(b => b.id === `owner_tone_warm:${SANDBOX}`), 'boton cálido');
  assert.ok(card.buttons.some(b => b.id === `owner_tone_referral:${SANDBOX}`), 'boton referido');
  assert.ok(!egress.some(e => e.kind === 'approve_card'), 'NO salta al readout 1-tap');
});

test('solo BNI -> 1-tap referido directo (no tarjeta de tono)', () => {
  const egress = [];
  const res = orchestrateVcard({ shared: { name: 'Carlos Chavez BNI', contactNumber: SANDBOX } }, egress);
  assert.strictEqual(res.path, 'one_tap');
  assert.strictEqual(res.flowKey, 'persona_referido');
  assert.ok(!egress.some(e => e.kind === 'tone_choice'), 'sin tarjeta de tono cuando hay UNA sola señal');
});

test('intro relacion + nombre BNI persistido -> doble señal via flag', () => {
  const egress = [];
  const res = orchestrateVcard({ shared: { name: 'Esmeralda Cervantes Bni', contactNumber: SANDBOX }, relationPersonalFlag: true }, egress);
  assert.strictEqual(res.path, 'tone_choice');
});

// ── (4) Cero egress al contacto: todo va al owner ──────────────────────────
test('CERO egress al contacto en la bifurcacion de tono', () => {
  const egress = [];
  orchestrateVcard({ shared: { name: 'Esmeralda amiga BNI', contactNumber: SANDBOX } }, egress);
  for (const e of egress) {
    assert.strictEqual(e.to, OWNER, 'todo egress al owner');
    assert.notStrictEqual(e.to, SANDBOX, 'jamas al contacto');
  }
});

test('ids de tono parsean a [owner_tone_*, <num>] en el dispatch', () => {
  for (const action of ['owner_tone_warm', 'owner_tone_referral']) {
    const [a, arg, third] = `${action}:${SANDBOX}`.split(':');
    assert.strictEqual(a, action);
    assert.strictEqual(arg.replace(/\D/g, ''), SANDBOX);
    assert.strictEqual(third, undefined);
  }
});
