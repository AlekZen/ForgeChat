// Auditoría WhatsApp 2026-08-12 — F1 (promesa rota en serie) y F2 (el bot no sabe
// decir "no puedo con esto"), más F8 (el digest le mintió al owner con el total).
//
// Daño medido en producción antes de este cambio:
//   · 17 veces el MISMO texto "…te confirmo por aquí en breve" a Andrés, 9 a Juan
//     Carlos, 3 a Germán. Cero cumplidas.
//   · La mayoría venían de audios / .xlsx / capturas: el bot no puede procesarlos
//     y aun así prometía una confirmación imposible.
//   · 5 digests en 15 h, cada uno diciendo "tienes 5 promesas" con 31 abiertas.

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildIa360BotFailureFallback } = require('../src/util/botFailureFallback');
const { buildDigestBody } = require('../src/util/failuresDigestBody');
const { detectIa360AgentPromise } = require('../src/util/agentPromise');

test('audio: dice la verdad (no puede escucharlo) y NO promete confirmación', () => {
  const { body, reason } = buildIa360BotFailureFallback({
    record: { message_type: 'audio', message_body: 'Audio message' },
  });
  assert.equal(reason, 'media_audio_no_soportado');
  assert.match(body, /no puedo escuchar audios/i);
  assert.match(body, /me escribes en una línea/i, 'debe pedir el formato que sí puede leer');
  assert.doesNotMatch(body, /en breve/i, 'la promesa imposible es justo el defecto F1');
});

test('voice se trata igual que audio', () => {
  const { reason } = buildIa360BotFailureFallback({ record: { message_type: 'voice' } });
  assert.equal(reason, 'media_audio_no_soportado');
});

test('documento: nombra el archivo recibido y lo escala al owner', () => {
  const { body, reason } = buildIa360BotFailureFallback({
    record: { message_type: 'document', message_body: 'cierre-julio.xlsx' },
  });
  assert.equal(reason, 'media_documento_para_owner');
  assert.match(body, /cierre-julio\.xlsx/, 'el contacto debe ver que llegó SU archivo');
  assert.doesNotMatch(body, /en breve/i);
});

test('documento sin nombre no imprime un hueco vacío', () => {
  const { body } = buildIa360BotFailureFallback({
    record: { message_type: 'document', message_body: '   ' },
  });
  assert.match(body, /«el archivo»/);
});

test('imagen/video/sticker: reconoce el límite y pide el dato en texto', () => {
  for (const message_type of ['image', 'video', 'sticker']) {
    const { body, reason } = buildIa360BotFailureFallback({ record: { message_type } });
    assert.equal(reason, 'media_imagen_no_soportada', `clase ${message_type}`);
    assert.match(body, /no puedo leer imágenes/i);
    assert.doesNotMatch(body, /en breve/i);
  }
});

test('texto sin promesas abiertas: la promesa se permite UNA vez', () => {
  const { body, reason } = buildIa360BotFailureFallback({
    record: { message_type: 'text', message_body: '¿cómo va el pipeline?' },
    openCount: 0,
  });
  assert.equal(reason, 'texto_primera_promesa');
  assert.match(body, /te confirmo por aquí en breve/i);
});

test('texto con promesas abiertas: reconoce el pendiente sin volver a prometer', () => {
  const { body, reason } = buildIa360BotFailureFallback({
    record: { message_type: 'text', message_body: 'otra pregunta' },
    openCount: 1,
  });
  assert.equal(reason, 'promesa_repetida_suprimida');
  assert.doesNotMatch(body, /te confirmo/i, 'esto es exactamente lo que se repitió 17 veces');
  assert.doesNotMatch(body, /en breve/i);
  assert.match(body, /pendientes con Alek/i);
});

test('la clase manda sobre el conteo: un audio nunca cae en el copy de texto', () => {
  const { reason } = buildIa360BotFailureFallback({
    record: { message_type: 'audio' },
    openCount: 9,
  });
  assert.equal(reason, 'media_audio_no_soportado');
});

test('record vacío degrada al copy de texto en vez de reventar', () => {
  const { reason } = buildIa360BotFailureFallback();
  assert.equal(reason, 'texto_primera_promesa');
});

// ── F8: el digest decía "tienes 5" arrastrando 31 ────────────────────────────
const FILAS = [
  { contact_number: '5213321060293', name: 'Andrés', contact_message: 'te mando el archivo', created_at: new Date(Date.now() - 3 * 864e5) },
  { contact_number: '5213321062365', name: 'Juan Carlos', contact_message: 'Audio message', created_at: new Date(Date.now() - 5 * 864e5) },
];

test('el digest declara el total real cuando hay más abiertas que las detalladas', () => {
  const body = buildDigestBody(FILAS, 31);
  assert.match(body, /En total llevas 31 promesas abiertas/);
});

test('el digest no inventa un pie cuando el detalle ya es todo', () => {
  const body = buildDigestBody(FILAS, 2);
  assert.doesNotMatch(body, /En total llevas/);
  assert.match(body, /Tienes 2 promesas de respuesta sin cerrar/);
});

test('sin total (llamada legacy) el digest sigue siendo válido', () => {
  const body = buildDigestBody(FILAS);
  assert.doesNotMatch(body, /En total llevas/);
  assert.match(body, /Andrés/);
});

// ── F4: las promesas del agente también entran al ledger ─────────────────────
test('detecta la promesa real que se le hizo a Elliot', () => {
  assert.equal(
    detectIa360AgentPromise('¿Quieres que te arme un mini-plan de 3 pasos con eso?'),
    true
  );
});

test('detecta las variantes de compromiso más comunes', () => {
  for (const frase of [
    'Te confirmo con Alek y te digo.',
    'Te comparto el resumen del mapa.',
    'Te mando la propuesta mañana.',
    'Lo reviso y te aviso.',
    'Te envío el detalle.',
    'Te escribe él directamente.',
    'Lo dejo tomado y te confirmo en breve.',
  ]) {
    assert.equal(detectIa360AgentPromise(frase), true, frase);
  }
});

test('no marca como promesa una respuesta que solo pregunta o informa', () => {
  for (const frase of [
    '¿Dónde se te cae más el seguimiento hoy: mensajes, CRM o agenda?',
    'IA360 conecta WhatsApp, CRM y agenda para que el seguimiento no dependa de nadie.',
    'Entiendo: el Excel se llena a mano y por eso se pierde.',
    '',
  ]) {
    assert.equal(detectIa360AgentPromise(frase), false, frase);
  }
});
