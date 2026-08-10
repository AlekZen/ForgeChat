const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalizeMime,
  mediaFormatFor,
  chatKindFor,
  MEDIA_FORMATS,
  EXT_MIME,
} = require('../src/util/metaMime');

test('G2 media contract publishes only the approved portable extensions', () => {
  const extensions = MEDIA_FORMATS.flatMap((format) => format.extensions);
  assert.deepEqual(extensions, [
    '.jpg', '.jpeg', '.png', '.webp', '.mp4', '.3gp',
    '.aac', '.amr', '.mp3', '.ogg', '.opus', '.m4a', '.wav',
    '.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  ]);
  assert.equal(EXT_MIME['.csv'], undefined);
});

test('direct and transcodable formats remain distinct', () => {
  assert.equal(chatKindFor('audio/ogg'), 'audio');
  assert.equal(chatKindFor('audio/wav'), null);
  assert.equal(mediaFormatFor('audio/wav'), null);
  assert.equal(mediaFormatFor('audio/wav', { includeTranscodable: true }).transport, 'transcode');
});

test('sticker limits encode static and animated contracts', () => {
  const sticker = mediaFormatFor('image/webp');
  assert.deepEqual(sticker.dimensions, [512, 512]);
  assert.equal(sticker.staticMaxBytes, 100 * 1024);
  assert.equal(sticker.animatedMaxBytes, 500 * 1024);
});

test('generic MIME falls back only to an approved filename extension', () => {
  assert.equal(canonicalizeMime('application/octet-stream', 'foto.jpeg'), 'image/jpeg');
  assert.equal(canonicalizeMime('application/octet-stream', 'datos.csv'), 'application/octet-stream');
});
