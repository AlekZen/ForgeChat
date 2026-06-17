// G11 (2026-06-17): el callejón sin salida del referido BNI. Cuando el owner
// elige la secuencia 'referido_contexto' pero el contacto no tiene quien_intro,
// el borrador queda bloqueado por el placeholder {{quien_intro}}: hoy el owner
// ve un readout vago, SIN botón "Aprobar y enviar" y sin saber qué teclear, así
// que el referido nunca recibe nada (caso real: Carlos Chávez BNI, cero envío).
//
// Parte A: cuando un referido se bloquea por falta de quien_intro, el readout
//   DEBE incluir el COMANDO EXACTO y copiable ("intro <nombre>: <quién>") que
//   entiende parseIa360OwnerIntroCommand, con el nombre real del contacto.
// Parte B (cableado, afirmado contra el fuente): el comando intro re-emite el
//   readout + tarjeta tras capturar quien_intro, reusando UNA sola función
//   (emitIa360SequenceReadoutCard) compartida con handleIa360OwnerSequenceChoice.
//
// Las funciones puras ejercidas (buildIntroNeededMessage, el predicado
// isSequenceBlockedByMissingQuienIntro, parseIa360OwnerIntroCommand,
// buildReferidoContextoDraft) son EXACTAMENTE las que webhook.js importa en
// prod, así que esto prueba el código real, no una copia. Cero deps (sin pg/red).

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  IA360_QUIEN_INTRO_PLACEHOLDER,
  parseIa360OwnerIntroCommand,
  buildReferidoContextoDraft,
  isSequenceBlockedByMissingQuienIntro,
  buildIntroNeededMessage,
} = require('../src/routes/ia360ReferidoIntro');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webhook.js'), 'utf8');

// ── Parte A: el builder del mensaje accionable ──────────────────────────────

test('Parte A: el mensaje de intro requerida trae el comando exacto con el nombre real', () => {
  const msg = buildIntroNeededMessage({ name: 'Carlos Chávez' });
  // Contiene el comando copiable "intro <name>:" con el nombre REAL del contacto.
  assert.ok(msg.includes('intro Carlos Chávez:'),
    'el mensaje debe traer el comando exacto "intro <nombre>:" con el nombre real');
  // Y ese comando, tecleado tal cual (con un quién real), lo parsea el handler.
  const ejemplo = 'intro Carlos Chávez: Juan Pérez';
  assert.deepEqual(parseIa360OwnerIntroCommand(ejemplo),
    { target: 'Carlos Chávez', introducer: 'Juan Pérez' },
    'el comando que sugiere el mensaje es exactamente el que entiende el parser');
  console.log('\n  [Parte A] mensaje al owner cuando un referido se bloquea:\n  ' +
    msg.replace(/\n/g, '\n  ') + '\n');
});

test('Parte A: sin nombre cae a un genérico seguro, nunca "undefined:"', () => {
  const msg = buildIntroNeededMessage({});
  assert.ok(!msg.includes('undefined'), 'jamás imprime "undefined"');
  assert.ok(msg.includes('intro este contacto:'), 'usa un genérico cuando no hay nombre');
});

// ── Predicado "secuencia bloqueada por quien_intro" — ambos lados ───────────

test('predicado: draft con {{quien_intro}} y sin dato => bloqueado (true)', () => {
  const draft = buildReferidoContextoDraft({ name: 'Carlos', quienIntro: null });
  assert.ok(draft.includes(IA360_QUIEN_INTRO_PLACEHOLDER), 'sanity: el draft trae el placeholder');
  assert.equal(
    isSequenceBlockedByMissingQuienIntro({ draft, quienIntro: null }), true,
    'placeholder + quien_intro ausente => bloqueado');
  assert.equal(
    isSequenceBlockedByMissingQuienIntro({ draft, quienIntro: '   ' }), true,
    'quien_intro en blanco cuenta como ausente');
});

test('predicado: con quien_intro presente o sin placeholder => NO bloqueado (false)', () => {
  // Lado A: el dato ya está -> el draft no trae placeholder.
  const draftOk = buildReferidoContextoDraft({ name: 'Carlos', quienIntro: 'Juan Pérez' });
  assert.ok(!draftOk.includes(IA360_QUIEN_INTRO_PLACEHOLDER), 'sanity: draft resuelto sin placeholder');
  assert.equal(
    isSequenceBlockedByMissingQuienIntro({ draft: draftOk, quienIntro: 'Juan Pérez' }), false,
    'quien_intro presente => no bloqueado');
  // Lado B: una secuencia NO-referido (su draft no tiene el placeholder de quien_intro).
  const draftNoReferido = 'Hola Carlos, soy la IA de Alek. ¿Te late agendar 15 min?';
  assert.equal(
    isSequenceBlockedByMissingQuienIntro({ draft: draftNoReferido, quienIntro: null }), false,
    'sin placeholder de quien_intro => no es este bloqueo');
  // Defensa: aunque por error quedara un placeholder, si hay dato no bloquea.
  assert.equal(
    isSequenceBlockedByMissingQuienIntro({ draft: draftOk, quienIntro: 'Juan Pérez' }), false);
});

// ── Parte A integrada en el emit: el readout SOLO añade el comando si bloquea ─
// Réplica del armado del readout de emitIa360SequenceReadoutCard (sin DB): si el
// draft está bloqueado por quien_intro, anexa buildIntroNeededMessage; si no, no.
function readoutWithIntroHint({ name, quienIntro }) {
  const draft = buildReferidoContextoDraft({ name, quienIntro });
  let readout = `Readout para ${name}\nBorrador: ${draft}`;
  if (isSequenceBlockedByMissingQuienIntro({ draft, quienIntro })) {
    readout += `\n\n${buildIntroNeededMessage({ name })}`;
  }
  return readout;
}

test('integración A: referido bloqueado => readout trae el comando; no bloqueado => NO lo trae', () => {
  const blocked = readoutWithIntroHint({ name: 'Carlos Chávez', quienIntro: null });
  assert.ok(blocked.includes('intro Carlos Chávez:'),
    'el referido bloqueado recibe el comando accionable en el readout');

  const clear = readoutWithIntroHint({ name: 'Carlos Chávez', quienIntro: 'Juan Pérez' });
  assert.ok(!clear.includes('intro Carlos Chávez:'),
    'un contacto con quien_intro NO recibe el mensaje (no cambia su readout)');
});

// ── Parte B (cableado afirmado contra webhook.js) ───────────────────────────

test('webhook.js: UNA función emitIa360SequenceReadoutCard reusada por AMBOS sitios', () => {
  assert.match(src, /async function emitIa360SequenceReadoutCard\(/,
    'falta la función extraída');
  // Definida una sola vez.
  const defs = src.match(/async function emitIa360SequenceReadoutCard\(/g) || [];
  assert.equal(defs.length, 1, 'la función de readout+tarjeta se define una sola vez (no duplicada)');
  // Llamada desde los DOS sitios: la elección de secuencia y el comando intro.
  const calls = src.match(/await emitIa360SequenceReadoutCard\(/g) || [];
  assert.ok(calls.length >= 2, 'debe llamarse desde ambos callsites (sequence-choice + intro)');
  // handleIa360OwnerSequenceChoice delega en la función extraída.
  const choice = src.indexOf('async function handleIa360OwnerSequenceChoice');
  assert.notEqual(choice, -1, 'falta handleIa360OwnerSequenceChoice');
  // El cuerpo termina justo donde arranca la función extraída.
  const choiceBody = src.slice(choice, src.indexOf('async function emitIa360SequenceReadoutCard'));
  assert.match(choiceBody,
    /await emitIa360SequenceReadoutCard\(\{ record, targetContact, flow, sequence, contact \}\)/,
    'la elección de secuencia llama a la función extraída');
});

test('webhook.js: Parte A cableada — el emit anexa el comando cuando bloquea por quien_intro', () => {
  const emit = src.indexOf('async function emitIa360SequenceReadoutCard');
  const body = src.slice(emit, emit + 2500);
  assert.match(body, /isIa360SequenceBlockedByMissingQuienIntro\(/,
    'el emit usa el predicado para detectar el bloqueo por quien_intro');
  assert.match(body, /buildIa360IntroNeededMessage\(\{ name \}\)/,
    'el emit anexa el comando accionable al readout');
});

test('webhook.js: Parte B cableada — intro re-emite el readout/tarjeta tras capturar quien_intro', () => {
  const h = src.indexOf('async function handleIa360OwnerIntroCommand');
  assert.notEqual(h, -1, 'falta handleIa360OwnerIntroCommand');
  const body = src.slice(h, h + 7000);
  // Detecta el caso pendiente ANTES del merge (que puebla quien_intro).
  assert.match(body, /wasReferidoBlockedByQuienIntro/, 'captura el estado pendiente pre-merge');
  assert.match(body, /sequence_candidate.*===.*'referido_contexto'/,
    'detecta una secuencia referido_contexto pendiente');
  // Re-emite reusando la función extraída, guardado en try/catch (no tumba el comando).
  assert.match(body, /findIa360SequenceFlow\('referido_contexto'\)/);
  assert.match(body, /await emitIa360SequenceReadoutCard\(/,
    'el comando intro re-emite el readout+tarjeta');
  assert.match(body, /catch \(e\) \{ console\.error\('\[ia360-intro\] re-emit/,
    'el re-emit va en try/catch para no tumbar el comando intro');
});

test('webhook.js: el módulo exporta y webhook importa las funciones nuevas', () => {
  assert.match(src, /isSequenceBlockedByMissingQuienIntro: isIa360SequenceBlockedByMissingQuienIntro/);
  assert.match(src, /buildIntroNeededMessage: buildIa360IntroNeededMessage/);
});
