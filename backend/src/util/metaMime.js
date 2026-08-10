// Canonicalize and validate media MIME types against the WhatsApp Cloud API's
// supported sets, so we never store or forward a type Meta will reject.
//
// Browser/OS-reported MIME is a guess (often derived from the file extension),
// so we (1) reduce it to Meta's canonical token, falling back to the filename
// extension when the report is missing/generic, and (2) check it against the
// per-purpose allow-list. Chat media is broader than template-header media.

const path = require('path');

const MIB = 1024 * 1024;

// Public G2 input contract. `transport: transcode` is accepted only through the
// audio route and is converted before Meta upload; direct formats are provider
// upload formats. Sticker static/animated limits are refined by content
// preflight because MIME alone cannot distinguish animation.
const MEDIA_FORMATS = Object.freeze([
  { extensions: ['.jpg', '.jpeg'], mime: 'image/jpeg', kind: 'image', maxBytes: 5 * MIB, caption: true, transport: 'direct' },
  { extensions: ['.png'], mime: 'image/png', kind: 'image', maxBytes: 5 * MIB, caption: true, transport: 'direct' },
  { extensions: ['.webp'], mime: 'image/webp', kind: 'sticker', maxBytes: 500 * 1024, staticMaxBytes: 100 * 1024, animatedMaxBytes: 500 * 1024, dimensions: [512, 512], caption: false, transport: 'direct' },
  { extensions: ['.mp4'], mime: 'video/mp4', kind: 'video', maxBytes: 16 * MIB, caption: true, transport: 'direct', videoCodec: 'h264', audioCodec: 'aac' },
  { extensions: ['.3gp'], mime: 'video/3gp', kind: 'video', maxBytes: 16 * MIB, caption: true, transport: 'direct' },
  { extensions: ['.aac'], mime: 'audio/aac', kind: 'audio', maxBytes: 16 * MIB, caption: false, transport: 'direct', audioCodec: 'aac' },
  { extensions: ['.amr'], mime: 'audio/amr', kind: 'audio', maxBytes: 16 * MIB, caption: false, transport: 'direct', audioCodec: 'amr' },
  { extensions: ['.mp3'], mime: 'audio/mpeg', kind: 'audio', maxBytes: 16 * MIB, caption: false, transport: 'direct', audioCodec: 'mp3' },
  { extensions: ['.ogg', '.opus'], mime: 'audio/ogg', kind: 'audio', maxBytes: 16 * MIB, caption: false, transport: 'direct', audioCodec: 'opus', channels: 1 },
  { extensions: ['.m4a'], mime: 'audio/mp4', kind: 'audio', maxBytes: 16 * MIB, caption: false, transport: 'direct', audioCodec: 'aac' },
  { extensions: ['.wav'], mime: 'audio/wav', kind: 'audio', maxBytes: 16 * MIB, caption: false, transport: 'transcode', providerMime: 'audio/ogg', audioCodec: 'readable' },
  { extensions: ['.pdf'], mime: 'application/pdf', kind: 'document', maxBytes: 16 * MIB, caption: true, transport: 'direct' },
  { extensions: ['.txt'], mime: 'text/plain', kind: 'document', maxBytes: 16 * MIB, caption: true, transport: 'direct' },
  { extensions: ['.doc'], mime: 'application/msword', kind: 'document', maxBytes: 16 * MIB, caption: true, transport: 'direct' },
  { extensions: ['.docx'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document', maxBytes: 16 * MIB, caption: true, transport: 'direct' },
  { extensions: ['.xls'], mime: 'application/vnd.ms-excel', kind: 'document', maxBytes: 16 * MIB, caption: true, transport: 'direct' },
  { extensions: ['.xlsx'], mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'document', maxBytes: 16 * MIB, caption: true, transport: 'direct' },
  { extensions: ['.ppt'], mime: 'application/vnd.ms-powerpoint', kind: 'document', maxBytes: 16 * MIB, caption: true, transport: 'direct' },
  { extensions: ['.pptx'], mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'document', maxBytes: 16 * MIB, caption: true, transport: 'direct' },
]);

const ALIASES = Object.freeze({
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'audio/mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-aac': 'audio/aac',
  'audio/aacp': 'audio/aac',
  'video/3gpp': 'video/3gp',
  'application/x-pdf': 'application/pdf',
});
const EXT_MIME = Object.freeze(Object.fromEntries(
  MEDIA_FORMATS.flatMap((format) => format.extensions.map((extension) => [extension, format.mime]))
));
const GENERIC = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/binary']);
const DIRECT_FORMAT_BY_MIME = new Map(
  MEDIA_FORMATS.filter((format) => format.transport === 'direct').map((format) => [format.mime, format])
);
const FORMAT_BY_MIME = new Map(MEDIA_FORMATS.map((format) => [format.mime, format]));
const TEMPLATE_HEADER = new Set(['image/jpeg', 'image/png', 'video/mp4', 'application/pdf']);

// Reduce a raw MIME (+ optional filename) to the canonical contract token.
function canonicalizeMime(rawMime, filename) {
  let base = String(rawMime || '').split(';')[0].trim().toLowerCase();
  if (ALIASES[base]) base = ALIASES[base];
  if (GENERIC.has(base) && filename) {
    const ext = path.extname(String(filename)).toLowerCase();
    if (EXT_MIME[ext]) base = EXT_MIME[ext];
  }
  return base;
}

function mediaFormatFor(mime, { includeTranscodable = false } = {}) {
  return (includeTranscodable ? FORMAT_BY_MIME : DIRECT_FORMAT_BY_MIME).get(mime) || null;
}

function chatKindFor(mime) {
  return mediaFormatFor(mime)?.kind || null;
}
function isChatSendable(mime) { return chatKindFor(mime) !== null; }
function isTemplateHeaderMime(mime) { return TEMPLATE_HEADER.has(mime); }

const CHAT_TYPES_MSG = 'Accepted: JPG, PNG, WEBP, MP4, 3GP, AAC, AMR, MP3, mono OGG/OPUS, M4A, WAV (transcoded), PDF, TXT, DOC, DOCX, XLS, XLSX, PPT, or PPTX.';
const TEMPLATE_TYPES_MSG = 'Template header media must be JPG, PNG, MP4, or PDF.';

module.exports = {
  canonicalizeMime, mediaFormatFor, chatKindFor, isChatSendable, isTemplateHeaderMime,
  CHAT_TYPES_MSG, TEMPLATE_TYPES_MSG, MEDIA_FORMATS,
  // exported for tests
  ALIASES, EXT_MIME, TEMPLATE_HEADER,
};
