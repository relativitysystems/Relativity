const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig, dropbox: dropboxConfig, slack: slackConfig, googleDrive: googleDriveConfig } = require('../config');
const clientAuth = require('../middleware/clientAuth');
const apiKey = require('../middleware/apiKey');
const dropboxService = require('../services/dropboxService');
const slackService = require('../services/slackService');
const googleDriveService = require('../services/googleDriveService');
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
    slackConnected: connectionStatus.slack,
    googleDriveConnected: connectionStatus.google_drive,
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

/**
 * GET /auth/slack/start
 *
 * Requires a valid Supabase Bearer token.
 * Returns JSON { url } — portal.js redirects the browser there.
 * Slack prompts the user to pick a workspace and channel.
 */
router.get('/slack/start', clientAuth, (req, res) => {
  const state = Buffer.from(JSON.stringify({ clientId: req.client.id })).toString('base64');

  const authUrl = new URL('https://slack.com/oauth/v2/authorize');
  authUrl.searchParams.set('client_id', slackConfig.appId);
  authUrl.searchParams.set('redirect_uri', slackConfig.redirectUri);
  authUrl.searchParams.set('scope', 'chat:write,incoming-webhook');
  authUrl.searchParams.set('state', state);

  res.json({ url: authUrl.toString() });
});

/**
 * GET /auth/slack/callback
 *
 * Slack redirects here after the user authorizes.
 * Stores the bot token in oauth_tokens and the chosen channel in clients.
 */
router.get('/slack/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect('/portal.html?error=slack_denied');
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
    const tokenData = await slackService.exchangeCodeForToken(code);
    const { access_token, incoming_webhook } = tokenData;

    await supabaseService.upsertToken(clientId, 'slack', access_token, null, null);

    if (incoming_webhook && incoming_webhook.channel_id) {
      await supabaseService.updateClientSlackChannel(clientId, incoming_webhook.channel_id);
    }

    res.redirect('/portal.html?connected=slack');
  } catch (err) {
    console.error('Slack callback error:', err.message);
    res.redirect('/portal.html?error=slack_failed');
  }
});

/**
 * GET /auth/google/start
 *
 * Requires a valid Supabase Bearer token (enforced by clientAuth middleware).
 * Returns JSON { url } — portal.js redirects the browser there.
 * Requests offline access so a refresh token is always returned.
 */
router.get('/google/start', clientAuth, (req, res) => {
  const state = Buffer.from(JSON.stringify({ clientId: req.client.id })).toString('base64');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', googleDriveConfig.clientId);
  authUrl.searchParams.set('redirect_uri', googleDriveConfig.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.readonly');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);

  res.json({ url: authUrl.toString() });
});

/**
 * GET /auth/google/callback
 *
 * Google redirects here after the user clicks Allow.
 * clientId comes from the server-generated state — never from the browser.
 * Redirects to portal with clientId and connected/error params preserved.
 */
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  let clientId;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    clientId = decoded.clientId;
  } catch {
    return res.status(400).json({ error: 'Invalid state param' });
  }

  if (error) {
    return res.redirect(`/portal.html?clientId=${clientId}&error=google_drive_denied`);
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state param' });
  }

  try {
    const tokenData = await googleDriveService.exchangeCodeForToken(code);
    const { access_token, refresh_token, expires_in, scope } = tokenData;
    const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : null;

    await supabaseService.upsertToken(clientId, 'google_drive', access_token, refresh_token || null, expiresAt, scope || null);

    res.redirect(`/portal.html?clientId=${clientId}&connected=google_drive`);
  } catch (err) {
    console.error('Google Drive callback error:', err.message);
    res.redirect(`/portal.html?clientId=${clientId}&error=google_drive_failed`);
  }
});

/**
 * POST /auth/complete-invite
 *
 * Called by invite-claim.js after the user sets their password.
 * Reads client_id from the JWT user metadata (set server-side during invite)
 * and creates the client_users record linking this auth user to the client.
 */
router.post('/complete-invite', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const clientId = user.user_metadata?.client_id;
  if (!clientId) return res.status(400).json({ error: 'No client linked to this invite' });

  let client;
  try {
    client = await supabaseService.getClientById(clientId);
  } catch {
    return res.status(404).json({ error: 'Client not found' });
  }

  if (!client || !client.is_active) {
    return res.status(403).json({ error: 'Client is inactive' });
  }

  try {
    await supabaseService.createClientUser(user.id, clientId, user.email);
  } catch (err) {
    console.error('complete-invite error:', err.message);
    return res.status(500).json({ error: 'Failed to link account' });
  }

  res.json({ success: true });
});

/**
 * GET /auth/status/:clientId
 *
 * Returns OAuth connection status for all providers.
 * Protected by API key — intended for n8n/Inngest consumption.
 */
router.get('/status/:clientId', apiKey, async (req, res) => {
  try {
    const status = await supabaseService.getClientConnectionStatus(req.params.clientId);
    res.json({
      dropbox: status.dropbox,
      google_drive: status.google_drive,
      slack: status.slack,
    });
  } catch (err) {
    console.error('Auth status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
