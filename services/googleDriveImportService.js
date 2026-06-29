const axios = require('axios');

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
]);

async function getFileMetadata(accessToken, fileId) {
  const response = await axios.get(
    `https://www.googleapis.com/drive/v3/files/${fileId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { fields: 'id,name,mimeType,size' },
    }
  );
  return response.data;
}

async function downloadFileBuffer(accessToken, fileId) {
  const response = await axios.get(
    `https://www.googleapis.com/drive/v3/files/${fileId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { alt: 'media' },
      responseType: 'arraybuffer',
    }
  );
  return Buffer.from(response.data);
}

module.exports = { getFileMetadata, downloadFileBuffer, ALLOWED_MIME_TYPES };
