'use strict';
const crypto = require('node:crypto');

class BridgeError extends Error {
  constructor(code, status = 400, details) { super(code); this.code = code; this.status = status; this.details = details; }
}
const fail = (code, status, details) => { throw new BridgeError(code, status, details); };
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const digits = value => String(value || '').replace(/\D/g, '');
const contactRef = (wa, contact) => `c_${hash(`${digits(wa)}\0${digits(contact)}`).slice(0, 12)}`;
const ingressRef = messageId => `in_${hash(messageId).slice(0, 32)}`;
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, allowed, code = 'UNKNOWN_FIELD') {
  if (!object(value)) fail('OBJECT_REQUIRED');
  const unknown = Object.keys(value).filter(k => !allowed.includes(k));
  if (unknown.length) fail(code, 400, { fields: unknown });
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function normalizeRequest(body) {
  exact(body, ['request_id', 'template_id', 'parameters', 'preview_digest']);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(body.request_id || '')) fail('REQUEST_ID_INVALID');
  if (!Number.isSafeInteger(body.template_id) || body.template_id < 1) fail('TEMPLATE_ID_INVALID');
  if (body.parameters !== undefined && !object(body.parameters)) fail('PARAMETERS_INVALID');
  if (body.preview_digest !== undefined && !/^[a-f0-9]{64}$/.test(body.preview_digest)) fail('PREVIEW_DIGEST_INVALID');
  const normalized = { request_id: body.request_id, template_id: body.template_id, parameters: body.parameters || {} };
  if (Buffer.byteLength(stable(normalized)) > 32768) fail('PARAMETERS_TOO_LARGE', 413);
  // preview_digest is a precondition, not part of the semantic request digest.
  return { ...normalized, digest: hash(stable({ version: 1, ...normalized })), preview_digest: body.preview_digest };
}
function verifySeal(seal, secret, now = Math.floor(Date.now() / 1000)) {
  if (!secret) fail('CONTEXT_AUTH_UNAVAILABLE', 503);
  if (typeof seal !== 'string' || seal.length > 2048) fail('SEAL_INVALID', 403);
  const parts = seal.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1' || !/^c_[a-f0-9]{12}$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2]) || !/^\d{10}$/.test(parts[3]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[4])) fail('SEAL_INVALID', 403);
  const exp = Number(parts[3]);
  if (exp <= now || exp > now + 600) fail('SEAL_EXPIRED_OR_INVALID', 403);
  const expected = crypto.createHmac('sha256', secret).update(parts.slice(0, 4).join('.')).digest();
  const provided = Buffer.from(parts[4], 'base64url');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) fail('SEAL_INVALID', 403);
  const messageId = Buffer.from(parts[2], 'base64url').toString('utf8');
  if (!/^wamid\.[A-Za-z0-9+/=_-]+$/.test(messageId)) fail('REAL_INGRESS_REQUIRED', 403);
  return { contact_ref: parts[1], message_id: messageId, exp };
}
function sealIngress(ref, messageId, secret, exp) {
  const base = `v1.${ref}.${Buffer.from(messageId).toString('base64url')}.${exp}`;
  return `${base}.${crypto.createHmac('sha256', secret).update(base).digest('base64url')}`;
}
function vars(text) {
  return [...new Set([...String(text || '').matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map(m => m[1]))];
}
function textParameters(text, values = {}) {
  const names = vars(text); exact(values, names, 'UNEXPECTED_VARIABLE');
  return names.map(name => {
    const value = values[name];
    if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail('VARIABLE_REQUIRED', 422, { variable: name });
    return { type: 'text', text: value, ...(/^\d+$/.test(name) ? {} : { parameter_name: name }) };
  });
}
function render(text, values = {}) { return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => values[k]); }
function cleanSpec(spec) {
  if (Array.isArray(spec)) return spec.map(cleanSpec);
  if (object(spec)) return Object.fromEntries(Object.entries(spec).filter(([k]) => !['example', 'examples'].includes(k)).map(([k,v]) => [k,cleanSpec(v)]));
  return spec;
}
function requirements(components) {
  return (components || []).map(c => {
    const type = String(c.type).toUpperCase();
    if (type === 'BODY' || type === 'HEADER' || type === 'FOOTER') return { type, format: c.format || (type === 'HEADER' ? 'TEXT' : undefined), variables: vars(c.text), media_required: ['IMAGE','VIDEO','DOCUMENT'].includes(c.format), text: c.text };
    if (type === 'BUTTONS') return { type, buttons: (c.buttons || []).map((b,index) => ({ index, type: b.type, text: b.text, variables: vars(b.url), url: b.url, flow_action: b.flow_action, flow_id: b.flow_id, phone_number: b.phone_number })) };
    if (type === 'CAROUSEL') return { type, cards: (c.cards || []).map((card,index) => ({ index, requirements: requirements(card.components) })) };
    return { type, unsupported: true };
  });
}
function buildComponents(spec, parameters, requestId) {
  exact(parameters, ['body','header','buttons','cards']);
  if (!Array.isArray(spec.components) || !spec.components.length) fail('TEMPLATE_SPEC_INCOMPLETE', 422);
  const output = [], media = []; let renderedBody = '', renderedHeader = '';
  const seen = new Set();
  for (const c of spec.components) {
    const type = String(c.type || '').toUpperCase();
    if (seen.has(type)) fail('DUPLICATE_SPEC_COMPONENT', 422); seen.add(type);
    if (type === 'BODY') {
      const p = textParameters(c.text, parameters.body || {});
      if (p.length) output.push({ type:'body', parameters:p });
      renderedBody = render(c.text, parameters.body);
    } else if (type === 'HEADER') {
      const format = String(c.format || 'TEXT').toUpperCase();
      if (format === 'TEXT') {
        const p = textParameters(c.text, parameters.header || {});
        if (p.length) output.push({ type:'header', parameters:p });
        renderedHeader = render(c.text, parameters.header);
      } else if (['IMAGE','VIDEO','DOCUMENT'].includes(format)) {
        const input = parameters.header; exact(input || {}, ['media_id','filename']);
        if (!/^[0-9]{5,40}$/.test(input?.media_id || '')) fail('HEADER_MEDIA_ID_REQUIRED', 422, { format });
        if (input.filename !== undefined && (format !== 'DOCUMENT' || typeof input.filename !== 'string' || !/^[^\x00-\x1f/\\]{1,120}$/.test(input.filename))) fail('MEDIA_FILENAME_INVALID', 422);
        const value = { id: input.media_id, ...(input.filename ? { filename:input.filename } : {}) };
        output.push({ type:'header', parameters:[{ type:format.toLowerCase(), [format.toLowerCase()]:value }] });
        media.push({ id:input.media_id, format });
      } else fail('TEMPLATE_HEADER_UNSUPPORTED', 422, { format });
    } else if (type === 'BUTTONS') {
      const supplied = parameters.buttons || {};
      exact(supplied, (c.buttons || []).map((_,i)=>String(i)), 'UNEXPECTED_BUTTON');
      for (const [index,b] of (c.buttons || []).entries()) {
        const kind = String(b.type || '').toUpperCase(), input = supplied[index];
        const base = { type:'button', index:String(index) };
        if (kind === 'QUICK_REPLY') {
          if (input !== undefined) fail('STATIC_BUTTON_INPUT_FORBIDDEN', 422);
          output.push({ ...base, sub_type:'quick_reply', parameters:[{ type:'payload', payload:`alekito_bridge:${requestId}:${index}` }] });
        } else if (kind === 'URL') {
          const names = vars(b.url);
          const p = textParameters(b.url, input || {});
          if (p.length) {
            // Meta dynamic URL input is the template suffix, not an arbitrary URL.
            if (names.length !== 1 || !String(b.url).startsWith('https://') || !String(b.url).endsWith(`{{${names[0]}}}`) || /[\r\n]/.test(p[0].text) || /^([a-z]+:)?\/\//i.test(p[0].text)) fail('URL_SUFFIX_INVALID', 422);
            output.push({ ...base, sub_type:'url', parameters:p.map(({type,text})=>({type,text})) });
          }
        } else if (kind === 'PHONE_NUMBER') {
          if (input !== undefined) fail('STATIC_BUTTON_INPUT_FORBIDDEN', 422);
        } else if (kind === 'COPY_CODE') {
          exact(input || {}, ['coupon_code']);
          if (typeof input?.coupon_code !== 'string' || !/^[A-Za-z0-9_-]{1,15}$/.test(input.coupon_code)) fail('COUPON_CODE_REQUIRED', 422);
          output.push({ ...base, sub_type:'copy_code', parameters:[{ type:'coupon_code', coupon_code:input.coupon_code }] });
        } else if (kind === 'FLOW') {
          if (input !== undefined) fail('FLOW_INPUT_FORBIDDEN', 422);
          output.push({ ...base, sub_type:'flow', parameters:[{ type:'action', action:{ flow_token:requestId } }] });
        } else fail('TEMPLATE_BUTTON_UNSUPPORTED', 422, { type:kind, index });
      }
    } else if (type === 'CAROUSEL') {
      if (!Array.isArray(parameters.cards) || parameters.cards.length !== c.cards.length) fail('CAROUSEL_CARDS_REQUIRED', 422);
      const cards = c.cards.map((card,index) => {
        const result = buildComponents(card, parameters.cards[index], `${requestId}-card${index}`); media.push(...result.media);
        return { card_index:index, components:result.components };
      });
      output.push({ type:'carousel', cards });
    } else if (type !== 'FOOTER') fail('TEMPLATE_COMPONENT_UNSUPPORTED', 422, { type });
  }
  for (const [key,type] of [['body','BODY'],['header','HEADER'],['buttons','BUTTONS'],['cards','CAROUSEL']]) if (parameters[key] !== undefined && !seen.has(type)) fail('UNEXPECTED_COMPONENT_INPUT', 422, { component:key });
  return { components:output, media, rendered_body:renderedBody, rendered_header:renderedHeader };
}
module.exports = { BridgeError, fail, hash, digits, contactRef, ingressRef, exact, stable, normalizeRequest, verifySeal, sealIngress, vars, cleanSpec, requirements, buildComponents };
