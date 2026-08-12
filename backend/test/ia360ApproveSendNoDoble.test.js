// Incidente 2026-08-12, contacto REAL (ElliotEsGenial): el owner aprobó, Meta
// entregó el opener (`delivered`) y ForgeChat le dijo "No pude enviar… No salió
// nada al contacto". El owner reclasificó y volvió a aprobar: el prospecto
// recibió DOS openers distintos en 17 segundos.
//
// Dos defectos, dos defensas. Este test cubre ambas sobre el código que corre en
// producción (webhook.js no es importable sin DB/Redis, así que se afirma el
// contrato leyendo la fuente, como el resto de los tests del repo).

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WEBHOOK = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webhook.js'), 'utf8');

test('un template ENTREGADO cuenta como éxito, no como fallo', () => {
  // La causa raíz: ok se calculaba con === 'sent', así que una entrega rápida
  // (delivered antes de que expirara el poll) se reportaba como fallo.
  assert.doesNotMatch(
    WEBHOOK,
    /ok: String\(status\?\.status \|\| ''\)\.toLowerCase\(\) === 'sent'/,
    'enqueueIa360Template volvió a tratar delivered/read como fallo'
  );
  assert.match(WEBHOOK, /\['sent', 'delivered', 'read'\]\.includes\(st\)/);
});

test('el camino frío (todo contacto nuevo) ackea al encolar, sin esperar a Meta', () => {
  const m = WEBHOOK.match(/const res = await enqueueIa360Template\(\{ record: targetRecord[^\n]*\n/);
  assert.ok(m, 'no encontré el envío del opener frío en handleIa360OwnerApproveSend');
  assert.match(m[0], /waitForStatus: false/);
  // Y si de verdad falla, el vigilante a 30 s es quien avisa.
  assert.match(WEBHOOK, /if \(res\.ok && res\.handlerFor\) \{\s*\n\s*scheduleIa360OutboundFailureWatch\(/);
});

test('enqueueIa360Template puede devolver el handler para vigilar sin bloquear', () => {
  assert.match(WEBHOOK, /waitForStatus = true \}\)/);
  assert.match(WEBHOOK, /if \(!waitForStatus\) return \{ ok: true, status: 'queued', error: null, handlerFor \};/);
});

test('un contacto no puede recibir dos openers distintos en 24 h', () => {
  // La guarda mira el HECHO (salió un opener) y no el estado persistido, que es
  // justo lo que cambió al reclasificar y dejó pasar el segundo envío.
  const m = WEBHOOK.match(/ANTI DOBLE-OPENER[\s\S]*?deny\('opener_ya_enviado'[^\n]*\n/);
  assert.ok(m, 'desapareció la guarda anti doble-opener');
  assert.match(m[0], /template_meta->>'label' LIKE 'ia360_seq_opener_%'/);
  assert.match(m[0], /diapazo_sesion_invitacion/, 'la sesión de Diapazo también cuenta como primer contacto');
  assert.match(m[0], /status NOT IN \('failed','error'\)/, 'un envío fallido SÍ debe poder reintentarse');
  assert.match(m[0], /INTERVAL '24 hours'/);
});

test('la guarda corre ANTES de cualquier envío del approve-send', () => {
  const guarda = WEBHOOK.indexOf("deny('opener_ya_enviado'");
  const envioCaliente = WEBHOOK.indexOf('const openerInteractive = buildIa360OpenerInteractive(');
  const envioFrio = WEBHOOK.indexOf('const res = await enqueueIa360Template({ record: targetRecord');
  const envioDiapazo = WEBHOOK.indexOf('await handleIa360ApproveSendDiapazo(');
  assert.ok(guarda > 0 && envioCaliente > guarda, 'la guarda quedó después del envío en ventana');
  assert.ok(envioFrio > guarda, 'la guarda quedó después del envío frío');
  assert.ok(envioDiapazo > guarda, 'la guarda quedó después del envío de Diapazo');
});
