const axios = require('axios');
const { googleDrive } = require('../config');
const supabaseService = require('./supabaseService');

async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    redirect_uri: googleDrive.redirectUri,
    client_id: googleDrive.clientId,
    client_secret: googleDrive.clientSecret,
  });

  const response = await axios.post(
    'https://oauth2.googleapis.com/token',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return response.data;
}

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: googleDrive.clientId,
    client_secret: googleDrive.clientSecret,
  });

  const response = await axios.post(
    'https://oauth2.googleapis.com/token',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return response.data;
}

// Returns a valid access token, refreshing in Supabase if within 60s of expiry.
async function getValidAccessToken(clientId) {
  const tokenRow = await supabaseService.getToken(clientId, 'google_drive');
  if (!tokenRow) throw new Error(`No Google Drive token found for client ${clientId}`);

  const nearExpiry = tokenRow.expires_at && new Date(tokenRow.expires_at) <= new Date(Date.now() + 60_000);
  if (!nearExpiry) return tokenRow.access_token;

  const refreshed = await refreshAccessToken(tokenRow.refresh_token);
  const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
  await supabaseService.upsertToken(clientId, 'google_drive', refreshed.access_token, tokenRow.refresh_token, expiresAt, tokenRow.scope);
  return refreshed.access_token;
}

async function listFiles(accessToken) {
  const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)',
      pageSize: 100,
    },
  });

  return response.data.files;
}

// Returns an axios response with responseType 'stream' for piping to the caller.
async function downloadFile(accessToken, fileId) {
  const response = await axios.get(
    `https://www.googleapis.com/drive/v3/files/${fileId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { alt: 'media' },
      responseType: 'stream',
    }
  );

  return response;
}

module.exports = {
  exchangeCodeForToken,
  refreshAccessToken,
  getValidAccessToken,
  listFiles,
  downloadFile,
};
