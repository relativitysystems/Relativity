const OpenAI = require('openai');
const { toFile } = require('openai');
const { openai: openaiConfig } = require('../config');

let _client = null;
function getClient() {
  if (!_client) {
    if (!openaiConfig.apiKey) {
      throw new Error('OPENAI_API_KEY must be set');
    }
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

function extensionForMimeType(mimeType) {
  const base = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[base] || 'webm';
}

async function transcribeAudio(buffer, mimeType, language = 'en') {
  const ext = extensionForMimeType(mimeType);
  const file = await toFile(buffer, `recording.${ext}`, { type: mimeType || `audio/${ext}` });

  const result = await getClient().audio.transcriptions.create({
    file,
    model: 'gpt-4o-mini-transcribe',
    language,
  });

  return (result.text || '').trim();
}

module.exports = { transcribeAudio };
