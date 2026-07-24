const OpenAI = require('openai');
const { openai: openaiConfig } = require('../config');

// openai v4 exports toFile from the package root; older/newer SDKs may only
// expose it from the uploads submodule, so fall back defensively.
let toFile;
({ toFile } = require('openai'));
if (typeof toFile !== 'function') {
  ({ toFile } = require('openai/uploads'));
}

let _client = null;
function getClient() {
  if (!_client) {
    _client = new OpenAI({ apiKey: openaiConfig.apiKey });
  }
  return _client;
}

const EXT_BY_MIME = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/m4a': 'm4a',
};

// Strips codec params (e.g. 'audio/webm;codecs=opus' -> 'audio/webm') before
// mapping to an extension, so Chrome's webm/opus and Safari's mp4 both land
// on the right filename extension OpenAI expects.
function extensionForMimeType(mimeType) {
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[base] || 'webm';
}

async function buildFile(buffer, ext, mimeType) {
  return toFile(buffer, `recording.${ext}`, { type: mimeType || `audio/${ext}` });
}

const PRIMARY_MODEL = openaiConfig.transcribePrimaryModel;
const FALLBACK_MODEL = openaiConfig.transcribeFallbackModel;

function isModelUnavailableError(err) {
  return err.status === 404
    || err.code === 'model_not_found'
    || /model/i.test(err.message || '');
}

async function transcribeAudio(buffer, mimeType, language = 'en') {
  // TEMP DEBUG — confirms the key actually loaded from env without printing it.
  console.log('[voice] OPENAI_API_KEY present:', Boolean(openaiConfig.apiKey));

  if (!openaiConfig.apiKey) {
    const err = new Error('OPENAI_API_KEY is not set on the server.');
    err.code = 'OPENAI_NOT_CONFIGURED';
    throw err;
  }

  const ext = extensionForMimeType(mimeType);
  const client = getClient();

  try {
    const file = await buildFile(buffer, ext, mimeType);
    const result = await client.audio.transcriptions.create({
      file,
      model: PRIMARY_MODEL,
      language,
    });
    return (result.text || '').trim();
  } catch (err) {
    if (!isModelUnavailableError(err)) throw err;

    // TEMP DEBUG — isolates model-access issues from upload/audio issues.
    console.warn(`[voice] "${PRIMARY_MODEL}" unavailable (${err.message}), falling back to "${FALLBACK_MODEL}"`);
    const retryFile = await buildFile(buffer, ext, mimeType);
    const result = await client.audio.transcriptions.create({
      file: retryFile,
      model: FALLBACK_MODEL,
      language,
    });
    return (result.text || '').trim();
  }
}

module.exports = { transcribeAudio };
