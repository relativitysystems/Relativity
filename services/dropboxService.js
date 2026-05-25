const axios = require('axios');
const { dropbox } = require('../config');

/**
 * Exchange the one-time authorization code (from Dropbox callback) for tokens.
 * Dropbox returns: access_token, refresh_token, expires_in (seconds)
 *
 * WHY: The browser receives only a short-lived "code" — your backend must
 * immediately trade it for real tokens before it expires (usually ~60 seconds).
 */
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
      auth: {
        username: dropbox.appKey,
        password: dropbox.appSecret,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  return response.data;
  // Returns: { access_token, refresh_token, expires_in, token_type, account_id, ... }
}

/**
 * Use a stored refresh_token to get a new access_token.
 *
 * WHY: Dropbox access tokens expire (typically after 4 hours with short-lived tokens).
 * Refresh tokens don't expire (unless revoked), so we use them to silently
 * get a new access token without the client needing to re-authorize.
 *
 * Flow:
 *   1. Check if access token is expired (expires_at < now)
 *   2. Call this function with the stored refresh token
 *   3. Store the new access token back to Supabase
 *   4. Use the new access token for the API call
 */
async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await axios.post(
    'https://api.dropboxapi.com/oauth2/token',
    params.toString(),
    {
      auth: {
        username: dropbox.appKey,
        password: dropbox.appSecret,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  return response.data;
  // Returns: { access_token, expires_in, token_type }
}

/**
 * List files/folders at a given Dropbox path for a client.
 *
 * @param {string} accessToken - The client's stored Dropbox access token
 * @param {string} path        - Dropbox folder path, e.g. '' (root) or '/Documents'
 */
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
  // Returns array of file/folder metadata objects
}

module.exports = { exchangeCodeForToken, refreshAccessToken, listFiles };
