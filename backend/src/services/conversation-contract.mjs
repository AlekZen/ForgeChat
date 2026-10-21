// Proposed internal facade, not an existing HTTP endpoint or a routing change.
export const CONVERSATION_VERSION = 'alekito-conversation-v1';
export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 30_000;

export class ContractError extends Error {
  constructor(code) { super(code); this.name = 'ContractError'; this.code = code; }
}

export function exactObject(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(k => !keys.includes(k)) ||
      required.some(k => !Object.hasOwn(value, k))) throw new ContractError('INVALID_CONTRACT');
  return value;
}

export function opaque(value, prefix = '') {
  if (typeof value !== 'string' || value.length > 160 ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(value) || !value.startsWith(prefix)) {
    throw new ContractError('INVALID_REFERENCE');
  }
  return value;
}

export function seal(value) {
  // This is only presence/size validation. The server must verify the seal.
  // Never decode, trim, regenerate, log, or substitute it with a contact id.
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 ||
      /[\r\n\u0000]/.test(value) || value.trim() !== value) {
    throw new ContractError('SEAL_REQUIRED');
  }
  return value;
}

function textInput(value) {
  exactObject(value, ['type', 'text']);
  if (value.type !== 'text' || typeof value.text !== 'string' ||
      value.text.trim().length === 0 || value.text.length > 16_000 || value.text.includes('\u0000')) {
    throw new ContractError('INVALID_TEXT');
  }
  return { type: 'text', text: value.text };
}

export function parseConversationRequest(value) {
  exactObject(value, ['contract_version', 'request_id', 'message_ref', 'conversation_ref',
    'nexus_sello', 'input', 'reply_owner']);
  if (value.contract_version !== CONVERSATION_VERSION || value.reply_owner !== 'forgechat') {
    throw new ContractError('INVALID_CONTRACT');
  }
  return Object.freeze({
    contract_version: CONVERSATION_VERSION,
    request_id: opaque(value.request_id),
    message_ref: opaque(value.message_ref),
    conversation_ref: opaque(value.conversation_ref),
    nexus_sello: seal(value.nexus_sello),
    input: Object.freeze(textInput(value.input)),
    reply_owner: 'forgechat'
  });
}

const ERROR_CODES = new Set(['NOT_AUTHORIZED', 'INVALID_REQUEST', 'IDEMPOTENCY_CONFLICT',
  'TIMEOUT', 'TRANSPORT_UNKNOWN', 'INVALID_RESPONSE', 'NOT_BOUND']);

export function parseConversationResult(value, expectedRequestId) {
  opaque(expectedRequestId);
  if (!value || value.request_id !== expectedRequestId) throw new ContractError('INVALID_RESPONSE');
  const common = ['status', 'request_id'];
  if (value.status === 'completed') {
    exactObject(value, [...common, 'reply', 'reply_owner']);
    if (value.reply_owner !== 'forgechat') throw new ContractError('INVALID_RESPONSE');
    return { status: 'completed', request_id: expectedRequestId,
      reply: textInput(value.reply), reply_owner: 'forgechat' };
  }
  if (value.status === 'accepted') {
    exactObject(value, [...common, 'operation_ref']);
    return { status: 'accepted', request_id: expectedRequestId, operation_ref: opaque(value.operation_ref) };
  }
  if (value.status === 'rejected' || value.status === 'unknown') {
    exactObject(value, [...common, 'public_code']);
    if (!ERROR_CODES.has(value.public_code)) throw new ContractError('INVALID_RESPONSE');
    return { status: value.status, request_id: expectedRequestId, public_code: value.public_code };
  }
  throw new ContractError('INVALID_RESPONSE');
}

export function deliveryDecision(result) {
  const validated = parseConversationResult(result, result?.request_id);
  // Only ForgeChat may act on a completed reply. Nothing here sends a message.
  // A rejected result is definitive non-acceptance, but does not authorize fallback.
  return Object.freeze({
    writer: 'forgechat',
    maySend: validated.status === 'completed',
    retryPost: false,
    fallback: false,
    reconcile: validated.status === 'accepted' || validated.status === 'unknown'
  });
}
