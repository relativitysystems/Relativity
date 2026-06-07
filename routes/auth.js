const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig, dropbox: dropboxConfig } = require('../config');
const clientAuth = require('../middleware/clientAuth');
const dropboxService = require('../services/dropboxService');
const supabaseService = require('../services/supabaseService');

const supabase = createClient(supabaseConfig.url, supabaseConfig.serviceKey);

/**
 * GET /auth/config
 *
 * Returns public Supabase config for the browser Supabase Auth SDK.
 * Only the anon key is returned — the service key never leaves the server.
 */
router.get('/config', (req, res) => {
  res.json({
    supabaseUrl: supabaseConfig.url,
    supabaseAnonKey: supabaseConfig.anonKey,
  });
});

/**
 * GET /auth/me
 *
 * Soft-auth: always returns 200.
 * { authenticated: false } when token is missing or invalid.
 * { authenticated: true, clientId, clientName, email, dropboxConnected } when valid.
 */
router.get('/me', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) return res.json({ authenticated: false });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.json({ authenticated: false });

  const { data: clientUser } = await supabase
    .from('client_users')
    .select('client_id, email')
    .eq('auth_user_id', user.id)
    .single();

  if (!clientUser) return res.json({ authenticated: false });

  const { data: client } = await supabase
    .from('clients')
    .select('id, name, is_active')
    .eq('id', clientUser.client_id)
    .single();

  if (!client || !client.is_active) return res.json({ authenticated: false });

  const connectionStatus = await supabaseService.getClientConnectionStatus(client.id);

  res.json({
    authenticated: true,
    clientId: client.id,
    clientName: client.name,
    email: clientUser.email,
    dropboxConnected: connectionStatus.dropbox,
  });
});

/**
 * GET /auth/dropbox/start
 *
 * Requires a valid Supabase Bearer token (enforced by clientAuth middleware).
 * Returns JSON { url } — portal.js redirects the browser there.
 * clientId is always resolved server-side; never accepted from the browser.
 */
router.get('/dropbox/start', clientAuth, (req, res) => {
  const state = Buffer.from(JSON.stringify({ clientId: req.client.id })).toString('base64');

  const authUrl = new URL('https://www.dropbox.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', dropboxConfig.appKey);
  authUrl.searchParams.set('redirect_uri', dropboxConfig.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('token_access_type', 'offline');
  authUrl.searchParams.set('state', state);

  res.json({ url: authUrl.toString() });
});

/**
 * GET /auth/dropbox/callback
 *
 * Dropbox redirects here after the user clicks Allow.
 * clientId comes from the server-generated state — never from the browser.
 * Redirects to portal without clientId in the URL.
 */
router.get('/dropbox/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect('/portal.html?error=dropbox_denied');
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
    const tokenData = await dropboxService.exchangeCodeForToken(code);
    const { access_token, refresh_token, expires_in } = tokenData;
    const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : null;

    await supabaseService.upsertToken(clientId, 'dropbox', access_token, refresh_token || null, expiresAt);

    res.redirect('/portal.html?connected=dropbox');
  } catch (err) {
    console.error('Dropbox callback error:', err.message);
    res.redirect('/portal.html?error=dropbox_failed');
  }
});

module.exports = router;
