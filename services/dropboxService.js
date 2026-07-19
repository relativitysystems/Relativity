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

module.exports = {
  exchangeCodeForToken,
  refreshAccessToken,
};
