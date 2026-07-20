const axios = require('axios');
const { googleDrive } = require('../config');
const oauthConnectionsService = require('./oauthConnectionsService');

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

// Returns a valid access token, refreshing via oauthConnectionsService
// (backlog H2) if within 60s of expiry. Refresh updates only the credential
// row in place (updateCredentialForConnection) — it never touches the
// connection row's id/connected_at, unlike createOrReplaceConnection.
async function getValidAccessToken(clientId) {
  const connection = await oauthConnectionsService.getActiveConnectionForClient(clientId, 'google_drive');
  if (!connection) throw new Error(`No Google Drive token found for client ${clientId}`);

  const credential = await oauthConnectionsService.getDecryptedCredentialForConnection(connection.id);
  if (!credential) throw new Error(`No Google Drive token found for client ${clientId}`);

  const nearExpiry = credential.expiresAt && new Date(credential.expiresAt) <= new Date(Date.now() + 60_000);
  if (!nearExpiry) return credential.accessToken;

  const refreshed = await refreshAccessToken(credential.refreshToken);
  const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
  // Google's refresh grant response often omits refresh_token (it stays
  // valid and unchanged) — fall back to the existing one so it's never
  // overwritten with null.
  await oauthConnectionsService.updateCredentialForConnection(connection.id, {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || credential.refreshToken,
    expiresAt,
  });
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
