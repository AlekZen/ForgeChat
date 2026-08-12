'use strict';

// Triaje de desconocidos. Lo que estos tests defienden es una política, no un
// formato: a quién se le contesta, qué se le pregunta y a quién se interrumpe.
//
// El caso que originó todo esto (12-ago-2026): 5213317399146 escribió tres veces el
// mismo día —un saludo, «Entonces buscabas una asesoría en ventas con IA?» y «Son 8
// horas de capacitación…»— y no recibió una sola respuesta. Sus tres mensajes están
// aquí abajo como casos.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  TRIAJE_MAX_MENSAJES,
  clasificarDesconocido,
  decidirTriaje,
} = require('../src/services/ia360Triaje');

const tipoDe = (texto, textoPrevio = '') => clasificarDesconocido({ texto, textoPrevio }).tipo;

test('clasifica lo que de verdad llega por esta puerta', () => {
  // Los tres mensajes reales del desconocido que quedó mudo.
  assert.equal(tipoDe('Buenos dias amigo como estas? Un gusto en saludarte, mi nombre es Manuel'), 'indeterminado');
  assert.equal(tipoDe('Entonces buscabas una asesoría en ventas con IA?'), 'proveedor');
  assert.equal(tipoDe('Son 8 horas de capacitación en inteligencia artificial con el doctor R'), 'marketing_masivo');

  assert.equal(tipoDe('Hola, necesito automatizar el seguimiento de mis clientes por WhatsApp'), 'cliente_potencial');
  assert.equal(tipoDe('¿Me pasas una cotización para un CRM?'), 'cliente_potencial');
  assert.equal(tipoDe('Somos una agencia y ofrecemos servicios de diseño'), 'proveedor');
  assert.equal(tipoDe('Te escribo del capítulo BNI, ¿te interesa que hagamos una alianza?'), 'propuesta_alianza');
  assert.equal(tipoDe('Le mando mi CV por si tienen alguna vacante'), 'reclutamiento');
  assert.equal(tipoDe('PROMOCIÓN: últimos lugares, inscríbete al webinar'), 'marketing_masivo');
});

test('la demanda en primera persona gana sobre el vocabulario de promoción', () => {
  // «capacitación» aparece en las dos familias: quien la PIDE es cliente, quien la
  // VENDE es difusión. Equivocarse hacia el lado del cliente es lo caro.
  assert.equal(tipoDe('quiero capacitación en IA para mi equipo de ventas'), 'cliente_potencial');
  assert.equal(tipoDe('Curso de IA, cupos limitados, inscríbete hoy'), 'marketing_masivo');
});

test('el segundo mensaje se entiende junto con el primero', () => {
  assert.equal(tipoDe('hola buenas tardes'), 'indeterminado');
  assert.equal(tipoDe('necesito ayuda con mi CRM', 'hola buenas tardes'), 'cliente_potencial');
});

test('sin texto no se supone nada: se pregunta', () => {
  const d = decidirTriaje({ tipo: 'indeterminado', nombre: 'Manuel', turno: 1, hayTexto: false });
  assert.equal(d.responder, true);
  assert.equal(d.motivo, 'medio_sin_texto');
  // Nunca «no puedo verlo/escucharlo»: ese «no puedo» ya fue un defecto medido.
  assert.doesNotMatch(d.cuerpo, /no puedo/i);
});

test('cada respuesta trae UNA sola pregunta y cabe en una pantalla', () => {
  for (const tipo of ['indeterminado', 'cliente_potencial', 'propuesta_alianza', 'proveedor', 'marketing_masivo', 'reclutamiento']) {
    const { cuerpo } = decidirTriaje({ tipo, nombre: 'Manuel', turno: 1, hayTexto: true });
    assert.ok(cuerpo.length <= 700, `${tipo}: ${cuerpo.length} caracteres`);
    const preguntas = (cuerpo.match(/\?/g) || []).length;
    assert.ok(preguntas <= 1, `${tipo} hace ${preguntas} preguntas`);
    // Identidad única: Alekito, el asistente de Alek.
    assert.match(cuerpo, /Alekito, el asistente de Alek/);
    // Promesas vacías que ya costaron caro en producción.
    assert.doesNotMatch(cuerpo, /te confirmo en breve|en breve te/i);
  }
});

test('la presentación va una sola vez', () => {
  const primero = decidirTriaje({ tipo: 'cliente_potencial', nombre: 'Manuel', turno: 1, hayTexto: true });
  const segundo = decidirTriaje({ tipo: 'cliente_potencial', nombre: 'Manuel', turno: 2, hayTexto: true });
  assert.match(primero.cuerpo, /Soy Alekito/);
  assert.doesNotMatch(segundo.cuerpo, /Soy Alekito/);
});

test('sólo se interrumpe a Alek por lo que cuesta dinero', () => {
  assert.equal(decidirTriaje({ tipo: 'cliente_potencial', turno: 1, hayTexto: true }).escalar, 'card');
  assert.equal(decidirTriaje({ tipo: 'propuesta_alianza', turno: 1, hayTexto: true }).escalar, 'card');
  // Proveedor y reclutamiento quedan anotados, sin tarjeta.
  assert.equal(decidirTriaje({ tipo: 'proveedor', turno: 1, hayTexto: true }).escalar, 'ledger');
  assert.equal(decidirTriaje({ tipo: 'reclutamiento', turno: 1, hayTexto: true }).escalar, 'ledger');
  // La difusión se cierra sola: ni tarjeta ni pendiente abierto.
  const spam = decidirTriaje({ tipo: 'marketing_masivo', turno: 1, hayTexto: true });
  assert.equal(spam.escalar, 'ledger_cerrado');
  assert.equal(spam.estado, 'silenciado');
});

test('no se pregunta dos veces lo mismo: al segundo turno sin clasificar, va con Alek', () => {
  const d = decidirTriaje({ tipo: 'indeterminado', nombre: 'Manuel', turno: 2, hayTexto: true });
  assert.equal(d.escalar, 'card');
  assert.equal(d.estado, 'escalado');
  assert.doesNotMatch(d.cuerpo, /de qué se trata/i);
});

test('el bot no conversa sin fin con un desconocido', () => {
  const d = decidirTriaje({ tipo: 'cliente_potencial', turno: TRIAJE_MAX_MENSAJES + 1, hayTexto: true });
  assert.equal(d.responder, false);
  assert.equal(d.estado, 'cerrado');
});

test('el carril está cableado donde antes había silencio', () => {
  const webhook = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webhook.js'), 'utf8');
  assert.match(webhook, /require\('\.\.\/services\/ia360Triaje'\)/);
  // El gate `if (!deal)` ya no puede ser un return pelón.
  assert.match(webhook, /if \(!deal\) \{[\s\S]{0,600}?handleIa360Desconocido\(/);
  // Interruptor de emergencia sin tocar código.
  assert.match(webhook, /IA360_TRIAJE_DESCONOCIDOS/);
  // Los botones de la tarjeta son los del ledger que ya existe: cero handlers nuevos.
  assert.match(webhook, /owner_take_fail:\$\{failureId\}/);
  assert.match(webhook, /owner_comment_fail:\$\{failureId\}/);
});
