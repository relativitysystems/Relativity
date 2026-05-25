const express = require('express');
const router = express.Router();
const supabaseService = require('../services/supabaseService');
const dropboxService = require('../services/dropboxService');


/**
 * GET /api/dropbox/files/:clientId
 *
 * n8n calls this endpoint to get a client's Dropbox files.
 * Protected by apiKey middleware in server.js — requires Authorization: Bearer <N8N_API_KEY>
 *
 * Flow:
 *   1. Look up stored Dropbox token for this client
 *   2. Refresh the access token if it's expired
 *   3. Call Dropbox API with valid token
 *   4. Return file list as JSON to n8n
 *
 * n8n HTTP Request node setup:
 *   Method: GET
 *   URL: http://your-server/api/dropbox/files/CLIENT_UUID
 *   Header: Authorization: Bearer YOUR_N8N_API_KEY
 */
router.get('/dropbox/files/:clientId', async (req, res) => {
  const { clientId } = req.params;

  // 1. Retrieve stored token from Supabase
  const tokenRow = await supabaseService.getToken(clientId, 'dropbox');

  if (!tokenRow) {
    return res.status(404).json({
      error: 'No Dropbox connection found for this client. They need to connect via the portal first.',
    });
  }

  let { access_token, refresh_token, expires_at } = tokenRow;

  // 2. Refresh token if expired (or about to expire in next 60 seconds)
  const isExpired = expires_at && new Date(expires_at) < new Date(Date.now() + 60_000);

  if (isExpired && refresh_token) {
    try {
      const refreshed = await dropboxService.refreshAccessToken(refresh_token);
      access_token = refreshed.access_token;

      const newExpiresAt = refreshed.expires_in
        ? new Date(Date.now() + refreshed.expires_in * 1000)
        : null;

      // Persist the fresh access token so next call also benefits
      await supabaseService.upsertToken(clientId, 'dropbox', access_token, refresh_token, newExpiresAt);
    } catch (err) {
      console.error('Token refresh failed:', err.message);
      return res.status(500).json({ error: 'Failed to refresh Dropbox token. Client may need to reconnect.' });
    }
  }

  // 3. Fetch files from Dropbox using the valid access token
  try {
    const files = await dropboxService.listFiles(access_token, '');
    res.json({ clientId, files });
  } catch (err) {
    console.error('Dropbox API error:', err.message);
    res.status(500).json({ error: 'Failed to fetch files from Dropbox.' });
  }
});

module.exports = router;
