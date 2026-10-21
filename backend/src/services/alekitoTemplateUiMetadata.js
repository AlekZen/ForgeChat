'use strict';
// UI projection only. No provider payload, identity or dispatch behavior.
function templateUiMetadata(plan) {
 const components=Array.isArray(plan.spec?.components)?plan.spec.components:[];
 const header=components.find(c=>c.type==='HEADER');
 const footer=components.find(c=>c.type==='FOOTER');
 const buttons=components.find(c=>c.type==='BUTTONS');
 return {
  header_type:header?.format||'NONE',
  ...(header?.format==='TEXT'?{header_text:plan.rendered_header||header.text||''}:{}),
  ...(typeof footer?.text==='string'?{footer:footer.text}:{}),
  buttons:(buttons?.buttons||[]).map(b=>({type:b.type,text:b.text||''}))
 };
}
module.exports={templateUiMetadata};
