function buildFlowButtonComponents(buttons, flowToken) {
  if (!flowToken) return [];
  const list = Array.isArray(buttons) ? buttons : [];
  return list.flatMap((button, index) => (
    String(button?.type || '').toUpperCase() === 'FLOW'
      ? [{
        type: 'button',
        sub_type: 'flow',
        index: String(index),
        parameters: [{ type: 'action', action: { flow_token: String(flowToken) } }],
      }]
      : []
  ));
}

function parseMetaFlowButton(button) {
  if (String(button?.type || '').toUpperCase() !== 'FLOW') return null;
  return {
    type: 'FLOW',
    text: button.text,
    flowId: button.flow_id ? String(button.flow_id) : '',
    flowAction: String(button.flow_action || '').toUpperCase(),
    navigateScreen: button.navigate_screen || '',
  };
}

module.exports = { buildFlowButtonComponents, parseMetaFlowButton };
