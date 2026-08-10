'use strict';

const DEFAULT_TIMEOUT_MS = 5000;

function bridgeUrl(env = process.env) {
  const value = String(env.WHATSAPP_5G_BRIDGE_URL || '').trim();
  if (!value) return null;
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error('bridge_url_must_be_https');
  return parsed.toString();
}

async function projectSignedWebhook({
  rawBody,
  signature,
  url = bridgeUrl(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!url) return { skipped: true };
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) throw new Error('bridge_raw_body_missing');
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) {
    throw new Error('bridge_signature_missing');
  }
  if (typeof fetchImpl !== 'function') throw new Error('bridge_fetch_unavailable');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
      body: rawBody,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`bridge_http_${response.status}`);
    return { skipped: false, httpStatus: response.status };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { bridgeUrl, projectSignedWebhook };
