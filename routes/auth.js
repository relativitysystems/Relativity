const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig, dropbox: dropboxConfig, googleDrive: googleDriveConfig, appBaseUrl } = require('../config');
const { sendPasswordResetEmail } = require('../services/emailService');
const clientAuth = require('../middleware/clientAuth');
const apiKey = require('../middleware/apiKey');
const dropboxService = require('../services/dropboxService');
const googleDriveService = require('../services/googleDriveService');
const supabaseService = require('../services/supabaseService');
const oauthConnectionsService = require('../services/oauthConnectionsService');

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
 * { authenticated: false, reason } when token is missing or invalid, or the
 * session has no usable client membership. reason is one of:
 * missing_token | invalid_token | membership_not_found | membership_disabled | client_inactive
 * { authenticated: true, clientId, clientName, email, dropboxConnected } when valid.
 */
router.get('/me', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) return res.json({ authenticated: false, reason: 'missing_token' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.json({ authenticated: false, reason: 'invalid_token' });

  let member;
  try {
    member = await supabaseService.getMemberByAuthUserId(user.id);
  } catch (err) {
    console.error('auth/me member lookup error:', err.message);
    return res.json({ authenticated: false, reason: 'membership_not_found' });
  }

  if (!member) return res.json({ authenticated: false, reason: 'membership_not_found' });
  if (member.status === 'disabled' || member.status === 'revoked') {
    return res.json({ authenticated: false, reason: 'membership_disabled' });
  }

  let client;
  try {
    client = await supabaseService.getClientById(member.client_id);
  } catch (err) {
    console.error('auth/me client lookup error:', err.message);
    return res.json({ authenticated: false, reason: 'client_inactive' });
  }

  if (!client || !client.is_active) return res.json({ authenticated: false, reason: 'client_inactive' });

  const connectionStatus = await supabaseService.getClientConnectionStatus(client.id);

  res.json({
    authenticated: true,
    clientId: client.id,
    clientName: client.name,
    email: member.email,
    memberId: member.id,
    memberRole: member.role,
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

    // Backlog H2: encrypted oauth_connections/oauth_credentials, mirroring
    // Slack's Milestone 3 migration — see services/oauthConnectionsService.js.
    // connectedByMemberId is null here because this callback's state (unlike
    // Slack's oauth_states row) doesn't carry a memberId — see backlog M1.
    await oauthConnectionsService.createOrReplaceConnection({
      clientId,
      provider: 'dropbox',
      accessToken: access_token,
      refreshToken: refresh_token || null,
      expiresAt,
    });

    res.redirect('/portal.html?connected=dropbox');
  } catch (err) {
    console.error('Dropbox callback error:', err.message);
    res.redirect('/portal.html?error=dropbox_failed');
  }
});

/**
 * GET /auth/slack/start
 * GET /auth/slack/callback
 *
 * RETIRED (Architecture Review Phase 4, Milestone 3). The Slack OAuth
 * connection flow has moved to routes/integrations/slack.js, mounted at
 * /api/integrations/slack/{start,callback,status,disconnect} — a fresh
 * implementation with server-side hashed OAuth state, encrypted credential
 * storage (oauth_connections/oauth_credentials via
 * services/oauthConnectionsService.js), and owner/admin-only connect/
 * disconnect. It does not extend this old flow.
 *
 * These two routes are deliberately NOT deleted outright and NOT silently
 * left as a 404: the old flow (unsigned base64(JSON) state that trusted a
 * client-supplied clientId, the incoming-webhook scope, plaintext tokens in
 * oauth_tokens) is unsafe and must never run again — Phase 1 §11 Decision 4
 * already approved discarding it, and
 * supabase/migrations/20260714_oauth_connections.sql §4 already deleted the
 * plaintext Slack rows this flow used to write, so upsertToken/
 * updateClientSlackChannel below would be writing into a path nothing else
 * ever reads again anyway. Returning a deliberate 410 Gone (rather than a
 * plain 404, which looks identical to "route never existed") gives an
 * operator a clear signal if anything — a stale bookmark, an old cached
 * portal.js — ever hits this URL again, mirroring the same reasoning
 * Milestone 1 used to neutralize AIKB's legacy Slack route. All of the old
 * flow's unsafe logic is deleted here, not flagged off, so there is no
 * config toggle that could silently re-arm it.
 */
router.get('/slack/start', (req, res) => {
  res.status(410).json({ error: 'This Slack integration endpoint has been retired. Use /api/integrations/slack/start instead.' });
});

router.get('/slack/callback', (req, res) => {
  res.status(410).json({ error: 'This Slack integration endpoint has been retired. Use /api/integrations/slack/callback instead.' });
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

    // Backlog H2: encrypted oauth_connections/oauth_credentials, mirroring
    // Slack's Milestone 3 migration — see services/oauthConnectionsService.js.
    // connectedByMemberId is null here because this callback's state (unlike
    // Slack's oauth_states row) doesn't carry a memberId — see backlog M1.
    await oauthConnectionsService.createOrReplaceConnection({
      clientId,
      provider: 'google_drive',
      accessToken: access_token,
      refreshToken: refresh_token || null,
      expiresAt,
      scopesGranted: scope ? scope.split(' ').filter(Boolean) : [],
    });

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
 * and upserts the owner row in client_members.
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
    await supabaseService.upsertOwnerMember(clientId, user.id, user.email);
  } catch (err) {
    console.error('complete-invite error:', err.message);
    return res.status(500).json({ error: 'Failed to link account' });
  }

  res.json({ success: true });
});

/**
 * POST /auth/accept-team-invite
 *
 * Called by invite-team.js after the invited user signs up or logs in.
 * Body: { token: string }
 * Links the auth user to the pending client_members row.
 */
router.post('/accept-team-invite', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const jwtToken = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!jwtToken) return res.status(401).json({ error: 'Missing auth token' });

  const { inviteToken } = req.body;
  if (!inviteToken) return res.status(400).json({ error: 'inviteToken is required' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(jwtToken);
  if (authError || !user) return res.status(401).json({ error: 'Invalid auth token' });

  let invite;
  try {
    invite = await supabaseService.getTeamInviteByToken(inviteToken);
  } catch (err) {
    console.error('accept-team-invite lookup error:', err.message);
    return res.status(500).json({ error: 'Could not look up invite' });
  }

  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.revoked_at) return res.status(400).json({ error: 'This invite has been revoked' });
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return res.status(403).json({ error: 'This invite was sent to a different email address' });
  }

  if (invite.accepted_at) {
    // Already accepted — only a safe no-op if it's this same authenticated
    // user who is correctly, actively linked. Otherwise reject; an accepted
    // invite must never be reassigned to a different Auth user.
    let existingMember;
    try {
      existingMember = await supabaseService.getClientMemberByAuthUserId(user.id, invite.client_id);
    } catch (err) {
      console.error('accept-team-invite already-accepted lookup error:', err.message);
      return res.status(500).json({ error: 'Could not verify invite status' });
    }

    if (existingMember && existingMember.status === 'active') {
      return res.json({ success: true, alreadyAccepted: true });
    }
    return res.status(409).json({ error: 'This invite has already been accepted by another account' });
  }

  if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'This invite has expired' });

  try {
    const result = await supabaseService.acceptTeamInvite(inviteToken, user.id, invite.client_id, invite.email);
    return res.json({ success: true, alreadyAccepted: !!result.alreadyAccepted });
  } catch (err) {
    if (err.code === 'MEMBER_LINK_FAILED') {
      console.error('accept-team-invite member link failed:', err.message);
      return res.status(403).json({ error: 'This invite is no longer valid for your account' });
    }
    console.error('accept-team-invite error:', err.message);
    return res.status(500).json({ error: 'Failed to accept invite' });
  }
});

/**
 * POST /auth/password-reset/request
 *
 * Public — no auth required.
 * Generates a Supabase recovery link server-side and sends it via emailService.
 * Always returns a generic success response to prevent account enumeration.
 */

// Simple in-memory rate limit: max 3 requests per email per 10 minutes
const _resetLog = new Map();
function _isResetRateLimited(email) {
  const now = Date.now();
  const window = 10 * 60 * 1000;
  const prev = (_resetLog.get(email) || []).filter(t => now - t < window);
  if (prev.length >= 3) return true;
  _resetLog.set(email, [...prev, now]);
  return false;
}

router.post('/password-reset/request', async (req, res) => {
  // Always respond with generic success — processing happens after
  const genericOk = () => res.json({ success: true });

  const rawEmail = req.body?.email;
  if (!rawEmail || typeof rawEmail !== 'string') return genericOk();

  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return genericOk();

  if (_isResetRateLimited(email)) {
    console.warn('[password-reset] Rate limited for:', email);
    return genericOk();
  }

  try {
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo: `${appBaseUrl}/reset-password.html` },
    });

    if (error || !data?.properties?.action_link) {
      // User likely doesn't exist — log without details and bail silently
      console.warn('[password-reset] Could not generate link for request');
      return genericOk();
    }

    const resetUrl = data.properties.action_link;
    // Never log resetUrl — it contains a live credential
    await sendPasswordResetEmail({ toEmail: email, resetUrl });
    console.log('[password-reset] Reset email dispatched for:', email);
  } catch (err) {
    console.error('[password-reset] Error processing request:', err.message);
  }

  return genericOk();
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
