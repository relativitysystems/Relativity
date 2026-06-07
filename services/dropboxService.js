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

// Fetches all entries at a path, following Dropbox pagination cursors.
async function listFolder(accessToken, path = '') {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  let response = await axios.post(
    'https://api.dropboxapi.com/2/files/list_folder',
    { path: path || '', recursive: false },
    { headers }
  );

  let entries = response.data.entries;

  while (response.data.has_more) {
    response = await axios.post(
      'https://api.dropboxapi.com/2/files/list_folder/continue',
      { cursor: response.data.cursor },
      { headers }
    );
    entries = entries.concat(response.data.entries);
  }

  return entries;
}

// Returns up to `limit` folder entries sorted newest-first.
// Handles both YYYY-MM-DD (ISO) and MM-DD-YY folder name formats.
function getRecentDayFolders(entries, limit = 5) {
  const folders = entries.filter(e => e['.tag'] === 'folder');

  folders.sort((a, b) => {
    const toSortKey = (name) => {
      // YYYY-MM-DD sorts correctly as a string
      if (/^\d{4}-\d{2}-\d{2}$/.test(name)) return name;
      // MM-DD-YY → convert to YYYY-MM-DD for comparison
      if (/^\d{2}-\d{2}-\d{2}$/.test(name)) {
        const [mm, dd, yy] = name.split('-');
        return `20${yy}-${mm}-${dd}`;
      }
      return name;
    };
    return toSortKey(b.name).localeCompare(toSortKey(a.name));
  });

  return folders.slice(0, limit);
}

module.exports = {
  exchangeCodeForToken,
  refreshAccessToken,
  listFiles,
  listFolder,
  getRecentDayFolders,
};
