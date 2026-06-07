const axios = require('axios');
const { dropbox } = require('../config');

async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    redirect_uri: dropbox.redirectUri,
  });

  const response = await axios.post(
    'https://api.dropboxapi.com/oauth2/token',
    params.toString(),
    {
      auth: { username: dropbox.appKey, password: dropbox.appSecret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  return response.data;
}

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await axios.post(
    'https://api.dropboxapi.com/oauth2/token',
    params.toString(),
    {
      auth: { username: dropbox.appKey, password: dropbox.appSecret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  return response.data;
}

// Legacy — used by /api/dropbox/files/:clientId (n8n route)
async function listFiles(accessToken, path = '') {
  const response = await axios.post(
    'https://api.dropboxapi.com/2/files/list_folder',
    { path, recursive: false },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data.entries;
}

module.exports = {
  exchangeCodeForToken,
  refreshAccessToken,
  listFiles,
};
