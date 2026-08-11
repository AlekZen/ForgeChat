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
