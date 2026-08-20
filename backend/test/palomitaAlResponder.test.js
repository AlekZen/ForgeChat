// Palomitas azules — decisión de Alek, 19-ago-2026.
//
// La palomita NO se enciende al recibir: se enciende cuando ya hay respuesta para
// ese inbound. Como SIEMPRE sale respuesta (aunque sea el acuse automático), el
// contacto igual ve que lo leyeron — pero nunca ve una palomita azul seguida de
// silencio, que es prometer atención que no llegó.
//
// El enganche vive después de que BullMQ acepta el job. El INSERT conserva el
// dedupe, pero una falla de Redis nunca deja palomita azul sin respuesta en cola.

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  markInboundReadAfterEnqueue,
  _test: { marcarLeidoAlResponder, marcarLeidoDeInbound },
} = require('../src/services/messageSender');

const CUENTA = { accessToken: 'tok', phoneNumberId: '873315362541590' };
const WAMID = 'wamid.HBgNNTIxMzMyMjYzODAzMxUCABIYIEFDRDg1QUQ4RjU4RjRCODk2ODk1NzkyM0Y1NUI2NjJC';

function espia() {
  const llamadas = [];
  const sendRead = async (args) => { llamadas.push(args); return { success: true }; };
  return { llamadas, sendRead };
}


test('palomita se enciende sólo después de un enqueue durable', async () => {
  const { llamadas, sendRead } = espia();
  assert.equal(llamadas.length, 0);
  const marked = await markInboundReadAfterEnqueue({
    accountId: 1,
    localMessageId: 'local-post-enqueue',
    db: {
      query: async () => ({ rows: [{
        template_meta: { ia360_handler_for: `${WAMID}-POST` },
        status: 'sending',
      }] }),
    },
    loadAccount: async () => CUENTA,
    sendRead,
  });
  assert.equal(marked, true);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].messageId, `${WAMID}-POST`);
});

test('marca leído el inbound que originó la respuesta', () => {
  const { llamadas, sendRead } = espia();
  marcarLeidoAlResponder({
    account: CUENTA,
    templateMeta: { ia360_handler_for: `${WAMID}-A` },
    status: 'sending',
    sendRead,
  });
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].messageId, `${WAMID}-A`);
  assert.equal(llamadas[0].phoneNumberId, CUENTA.phoneNumberId);
});

test('extrae el wamid cuando el handler trae sufijo :direct:<to>:<label>', () => {
  const { llamadas, sendRead } = espia();
  marcarLeidoAlResponder({
    account: CUENTA,
    templateMeta: { ia360_handler_for: `${WAMID}-B:direct:5213322638033:acuse` },
    status: 'sending',
    sendRead,
  });
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].messageId, `${WAMID}-B`);
});

test('un solo acuse de lectura aunque el mismo inbound produzca varios textos', () => {
  const { llamadas, sendRead } = espia();
  const meta = { ia360_handler_for: `${WAMID}-C` };
  marcarLeidoAlResponder({ account: CUENTA, templateMeta: meta, status: 'sending', sendRead });
  marcarLeidoAlResponder({
    account: CUENTA,
    templateMeta: { ia360_handler_for: `${WAMID}-C:direct:5213322638033:readout` },
    status: 'sending',
    sendRead,
  });
  assert.equal(llamadas.length, 1);
});

test('no marca nada sin handler: broadcasts, automation y chat manual quedan fuera', () => {
  const { llamadas, sendRead } = espia();
  marcarLeidoAlResponder({ account: CUENTA, templateMeta: null, status: 'sending', sendRead });
  marcarLeidoAlResponder({ account: CUENTA, templateMeta: { ux: 'broadcast' }, status: 'sending', sendRead });
  assert.equal(llamadas.length, 0);
});

test('no marca nada en filas sandbox: esas jamás salen a Meta', () => {
  const { llamadas, sendRead } = espia();
  marcarLeidoAlResponder({
    account: CUENTA,
    templateMeta: { ia360_handler_for: `${WAMID}-D` },
    status: 'qa_sandboxed',
    sendRead,
  });
  assert.equal(llamadas.length, 0);
});

// Los wamid de los harness EMPIEZAN con `wamid.` — `wamid.e2e.gbrain.…`,
// `wamid.qa-sandbox.…` —, así que filtrar por prefijo no basta. Descubierto al leer
// `gbrain-e2e.sh`: sin el segundo filtro, cada corrida de las pruebas dispararía una
// llamada real a Meta que falla.
test('ignora wamid sintéticos de los harness: en Meta no existen', () => {
  const { llamadas, sendRead } = espia();
  for (const id of [
    'synthetic-qa-12345:direct:521:acuse',
    'wamid.e2e.gbrain.1787170000.4242',
    'wamid.qa-sandbox.1787170000.7',
    'wamid.harness.smoke.1',
  ]) {
    marcarLeidoAlResponder({
      account: CUENTA,
      templateMeta: { ia360_handler_for: id },
      status: 'sending',
      sendRead,
    });
  }
  assert.equal(llamadas.length, 0);
});

test('un fallo de Meta no tumba el envío: la palomita es fire-and-forget', () => {
  assert.doesNotThrow(() => {
    marcarLeidoAlResponder({
      account: CUENTA,
      templateMeta: { ia360_handler_for: `${WAMID}-E` },
      status: 'sending',
      sendRead: async () => { throw new Error('Meta 400: message not found'); },
    });
  });
});

// El carril diapazo-inbound tiene egress propio y no pasa por `insertPendingRow`:
// usa el mismo helper para que no haya dos implementaciones de la misma regla.
test('carril con egress propio: marca leído el inbound que contestó', () => {
  const { llamadas, sendRead } = espia();
  marcarLeidoDeInbound({ account: CUENTA, inboundMessageId: `${WAMID}-F`, sendRead });
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].messageId, `${WAMID}-F`);
});

test('carril con egress propio: sin inbound no marca nada', () => {
  const { llamadas, sendRead } = espia();
  marcarLeidoDeInbound({ account: CUENTA, inboundMessageId: null, sendRead });
  marcarLeidoDeInbound({ account: CUENTA, inboundMessageId: 'diapazo_out:algo', sendRead });
  assert.equal(llamadas.length, 0);
});
