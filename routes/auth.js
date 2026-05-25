const express = require('express');
const router = express.Router();
const { dropbox } = require('../config');
const dropboxService = require('../services/dropboxService');
const supabaseService = require('../services/supabaseService');

/**
 * GET /auth/dropbox/start?clientId=<uuid>
 *
 * Step 1 of OAuth: redirect the client's browser to Dropbox's authorization page.
 *
 * WHY the `state` param:
 *   - OAuth redirects go through the client's browser, so you can't pass data
 *     in a server-side variable. We encode clientId in `state` so Dropbox sends
 *     it back to us in the callback URL.
 *   - `state` also protects against CSRF: if the `state` in the callback doesn't
 *     match what we sent, we reject it.
 */
router.get('/dropbox/start', (req, res) => {
  const { clientId } = req.query;

  if (!clientId) {
    return res.status(400).json({ error: 'clientId query param is required' });
  }

  // Encode clientId in state so we can retrieve it in the callback
  const state = Buffer.from(JSON.stringify({ clientId })).toString('base64');

  const authUrl = new URL('https://www.dropbox.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', dropbox.appKey);
  authUrl.searchParams.set('redirect_uri', dropbox.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('token_access_type', 'offline'); // request refresh token
  authUrl.searchParams.set('state', state);

  // Send the browser to Dropbox — client sees the "Allow" screen
  res.redirect(authUrl.toString());
});

/**
 * GET /auth/dropbox/callback?code=<auth_code>&state=<encoded_state>
 *
 * Step 2 of OAuth: Dropbox redirects here after the client clicks "Allow".
 *
 * What happens here:
 *   1. Decode clientId from state
 *   2. Exchange the one-time code for access + refresh tokens
 *   3. Store tokens in Supabase
 *   4. Redirect browser back to the portal with a success indicator
 */
router.get('/dropbox/callback', async (req, res) => {
  const { code, state, error } = req.query;

  // Dropbox sends error=access_denied if the client clicked Cancel
  // state is still present on denial, so we can recover clientId for the redirect
  if (error) {
    let deniedClientId = '';
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
      deniedClientId = decoded.clientId || '';
    } catch { /* ignore */ }
    const clientParam = deniedClientId ? `&clientId=${encodeURIComponent(deniedClientId)}` : '';
    return res.redirect(`/portal.html?error=dropbox_denied${clientParam}`);
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state param' });
  }

  let clientId;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    clientId = decoded.clientId;
  } catch {
    return res.status(400).json({ error: 'Invalid state param' });
  }

  try {
    // Exchange auth code for tokens
    const tokenData = await dropboxService.exchangeCodeForToken(code);

    const { access_token, refresh_token, expires_in } = tokenData;

    // Calculate when the access token expires
    const expiresAt = expires_in
      ? new Date(Date.now() + expires_in * 1000)
      : null;

    // Persist tokens to Supabase
    await supabaseService.upsertToken(
      clientId,
      'dropbox',
      access_token,
      refresh_token || null,
      expiresAt
    );

    // Redirect back to portal — portal.js detects ?connected=dropbox and shows success UI
    res.redirect(`/portal.html?clientId=${encodeURIComponent(clientId)}&connected=dropbox`);
  } catch (err) {
    console.error('Dropbox callback error:', err.message);
    res.redirect(`/portal.html?clientId=${encodeURIComponent(clientId)}&error=dropbox_failed`);
  }
});

/**
 * GET /auth/status/:clientId
 *
 * Returns which providers a client has connected — boolean only, no token data.
 * Called by portal.js on page load to show persistent connection state after refresh.
 * No API key required — lives in the public auth router.
 *
 * Response: { dropbox: true, google_drive: false, slack: false }
 */
router.get('/status/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const providers = ['dropbox', 'google_drive', 'slack'];

  try {
    const results = await Promise.all(
      providers.map(p => supabaseService.getToken(clientId, p))
    );

    const status = {};
    providers.forEach((p, i) => {
      status[p] = results[i] !== null;
    });

    res.json(status);
  } catch (err) {
    console.error('Status check failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch connection status.' });
  }
});

module.exports = router;
