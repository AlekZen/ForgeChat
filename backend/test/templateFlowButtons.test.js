const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMetaFlowButton,
  buildFlowButtonComponents,
} = require('../src/util/templateFlow');

test('Meta FLOW buttons remain FLOW buttons after template sync', () => {
  const parsed = parseMetaFlowButton({
    type: 'FLOW',
    text: 'Abrir sesión',
    flow_id: 2184224545480834,
    flow_action: 'NAVIGATE',
    navigate_screen: 'INICIO',
  });

  assert.deepEqual(parsed, {
    type: 'FLOW',
    text: 'Abrir sesión',
    flowId: '2184224545480834',
    flowAction: 'NAVIGATE',
    navigateScreen: 'INICIO',
  });
  });

test('Flow template sends include one correlated flow action component', () => {
  assert.deepEqual(buildFlowButtonComponents([
    { type: 'QUICK_REPLY', text: 'Otro' },
    { type: 'FLOW', text: 'Abrir sesión' },
  ], 'local-message-id'), [{
    type: 'button',
    sub_type: 'flow',
    index: '1',
    parameters: [{
      type: 'action',
      action: { flow_token: 'local-message-id' },
    }],
  }]);
});

// ── P1: el token de sesión viaja con el template ────────────────────────────
// Sin este componente el botón FLOW llega sin sesión: el submit del contacto no
// casa con la fila de diapazo_sesion_enviada y `respondido_en` nunca cierra, así
// que un contacto nuevo (siempre fuera de la ventana de 24 h) no puede hacer la
// Sesión de Afinación.

test('sin botón FLOW en la plantilla, los componentes no cambian (cero efecto)', () => {
  assert.deepEqual(buildFlowButtonComponents([
    { type: 'QUICK_REPLY', text: 'Retomar sesión' },
    { type: 'QUICK_REPLY', text: 'Ahora no' },
  ], 'ses_abc123'), []);
  // Sin token tampoco se emite nada, aunque la plantilla sí tenga botón FLOW.
  assert.deepEqual(buildFlowButtonComponents([{ type: 'FLOW', text: 'Abrir sesión' }], null), []);
  assert.deepEqual(buildFlowButtonComponents([{ type: 'FLOW', text: 'Abrir sesión' }], ''), []);
});

test('el componente lleva el flow_token de ESTA sesión, no el id local', () => {
  const [comp] = buildFlowButtonComponents(
    [{ type: 'FLOW', text: 'Abrir sesión', flowId: '2184224545480834' }],
    'ses_9wQe1TbK'
  );
  assert.equal(comp.sub_type, 'flow');
  assert.equal(comp.index, '0');
  assert.equal(comp.parameters[0].action.flow_token, 'ses_9wQe1TbK');
});

// ── Cableado real en producción (lo que de verdad corre) ────────────────────
const fs = require('node:fs');
const path = require('node:path');
const WEBHOOK = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webhook.js'), 'utf8');
const RECORDATORIO = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'diapazoSesionRecordatorio.js'), 'utf8');

test('P1: buildIa360TemplateComponents anexa el botón Flow con el token recibido', () => {
  assert.match(WEBHOOK, /require\('\.\.\/util\/templateFlow'\)/);
  assert.match(WEBHOOK, /async function buildIa360TemplateComponents\([^)]*flowToken = null\)/);
  assert.match(WEBHOOK, /components\.push\(\.\.\.buildFlowButtonComponents\(tpl\.buttons, flowToken\)\)/);
});

test('P1: enqueueIa360Template acepta flowToken y carga los botones de la plantilla', () => {
  assert.match(WEBHOOK, /async function enqueueIa360Template\(\{[^}]*flowToken = null[^}]*\}\)/);
  assert.match(WEBHOOK, /buildIa360TemplateComponents\(tpl, account, record, vars, flowToken\)/);
  // Sin la columna `buttons` en el SELECT no hay botón que cablear.
  const selects = WEBHOOK.match(/SELECT id, name, language, body, status, header_type, header_media_library_id, samples, buttons/g) || [];
  assert.equal(selects.length, 2, 'ambos lookups de plantilla deben traer buttons');
});

test('P1: el envío frío de la Sesión de Afinación pasa su flow_token', () => {
  const m = WEBHOOK.match(/templateName: DIAPAZO_SESION_INVITACION_TEMPLATE[\s\S]{0,400}?\}\);/);
  assert.ok(m, 'no encontré el envío del template de invitación Diapazo');
  assert.match(m[0], /flowToken,/);
});

test('P1: el recordatorio de sesión también cablea el botón Flow', () => {
  assert.match(RECORDATORIO, /require\('\.\.\/util\/templateFlow'\)/);
  assert.match(RECORDATORIO, /buildFlowButtonComponents\(tpl\.buttons, row\.flow_token\)/);
  assert.match(RECORDATORIO, /SELECT id, name, language, body, status, buttons/);
});
