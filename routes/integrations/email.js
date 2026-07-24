'use strict';

// Gmail OAuth connection routes (EM2 — Architecture/architecture/
// EMAIL_INGESTION.md §14.1). Thin Express adapter — all logic lives in
// services/emailConnectionService.js so it stays unit-testable without an
// HTTP layer. Mounted at /api/integrations/email in app.js.
//
// clientId/memberId are ALWAYS resolved server-side by clientAuth from the
// authenticated Supabase session — never accepted from the browser.
//
// Connecting, status, and disconnect are ALL self-service in EM2 — any
// active member, role != viewer, acting only on their OWN connection.
// Deliberately narrower than §14.1's general route table (which describes
// disconnect as "connection's own member or owner/admin"): for a
// consent-sensitive feature like a personal mailbox connection, EM2 does
// not give owners/admins any override to disconnect another member's
// Gmail account. That administrative/offboarding capability belongs to
// EM9 (member offboarding and policy reconciliation), not this milestone
// — see the EM2 Implementation Record in EMAIL_INGESTION.md. Enforced via
// emailConnectionService.canDisconnectConnection, checked after loading the
// target connection (it can't be a pre-route middleware like requireRole
// since it needs the row's connected_by_member_id first).

const express = require('express');
const router = express.Router();
const clientAuth = require('../../middleware/clientAuth');
const emailConnectionService = require('../../services/emailConnectionService');
const oauthConnectionsService = require('../../services/oauthConnectionsService');
const gmailService = require('../../services/gmailService');
const { REDIRECT, PROVIDER, canDisconnectConnection } = emailConnectionService;

const OWNER_ADMIN = ['owner', 'admin'];
const SUPPORTED_PROVIDERS = [PROVIDER]; // just 'gmail' for EM2 — microsoft is EM12

/**
 * GET /api/integrations/email/:provider/start
 * Self-service: any active member whose role isn't `viewer` — connecting
 * authorizes access to the member's OWN mailbox, not an organization-wide
 * action, so this is deliberately NOT owner/admin-gated like Slack's /start.
 * Returns JSON { url } — the portal redirects the browser there.
 */
router.get('/:provider/start', clientAuth, async (req, res) => {
  const { provider } = req.params;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `Unsupported email provider "${provider}".` });
  }
  if (req.member.role === 'viewer') {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  try {
    const { url } = await emailConnectionService.startConnection({
      clientId: req.client.id,
      memberId: req.member.id,
      provider,
    });
    res.json({ url });
  } catch (err) {
    if (err.code === 'GMAIL_NOT_CONFIGURED') {
      return res.status(500).json({ error: 'Gmail integration is not configured on the server.' });
    }
    console.error(`GET /api/integrations/email/${provider}/start error:`, err.message);
    res.status(500).json({ error: 'Could not start the Gmail connection. Please try again.' });
  }
});

/**
 * GET /api/integrations/email/:provider/callback
 * Public — Google redirects the browser here with no bearer token. All
 * client/member context comes from the consumed oauth_states row, never
 * from query parameters. Always redirects; never renders JSON, so a raw
 * error/state/token can never end up in a JSON error body either.
 */
router.get('/:provider/callback', async (req, res) => {
  const { provider } = req.params;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.redirect(REDIRECT.INVALID_STATE);
  }
  const { code, state, error } = req.query;
  const { redirectPath } = await emailConnectionService.handleCallback({
    code: typeof code === 'string' ? code : null,
    state: typeof state === 'string' ? state : null,
    error: typeof error === 'string' ? error : null,
  });
  res.redirect(redirectPath);
});

/**
 * GET /api/integrations/email/connections
 * Any authenticated, active member sees their own connection by default.
 * `?all=true` only takes effect for owner/admin callers (silently ignored
 * otherwise, fail-safe) — the admin console's future per-client roster view
 * (§27) will use this same param. This is a read-only visibility grant, not
 * a mutation authority — distinct from disconnect below, which owners/admins
 * do NOT get an override for in EM2.
 *
 * `configured` reflects whether Gmail OAuth is set up on the server at all
 * (independent of any specific connection) — the portal uses this to hide
 * the Connect button entirely rather than let a member click it and get a
 * failure only after the fact.
 */
router.get('/connections', clientAuth, async (req, res) => {
  try {
    const isOwnerAdmin = OWNER_ADMIN.includes(req.member.role);
    const result = await emailConnectionService.getConnections({
      clientId: req.client.id,
      memberId: req.member.id,
      isOwnerAdmin,
      all: req.query.all === 'true',
    });
    res.json({ ...result, configured: gmailService.isGmailConfigured() });
  } catch (err) {
    console.error('GET /api/integrations/email/connections error:', err.message);
    res.status(500).json({ error: 'Could not load email connections.' });
  }
});

/**
 * POST /api/integrations/email/connections/:id/disconnect
 * Self-service only in EM2 — callable ONLY by the connection's own member.
 * Owners/admins get no override here, deliberately (see the file-header
 * comment and the EM2 Implementation Record). The ownership check happens
 * here, inline, after loading the target row — it can't be a pre-route
 * middleware since it needs connected_by_member_id first.
 */
router.post('/connections/:id/disconnect', clientAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const connection = await oauthConnectionsService.getConnectionById(id);
    if (!connection || connection.client_id !== req.client.id || connection.provider !== PROVIDER) {
      return res.status(404).json({ error: 'Connection not found.' });
    }
    if (!canDisconnectConnection({ connection, actingMemberId: req.member.id })) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const result = await emailConnectionService.disconnect({ clientId: req.client.id, connectionId: id });
    res.json(result);
  } catch (err) {
    console.error('POST /api/integrations/email/connections/:id/disconnect error:', err.message);
    res.status(500).json({ error: 'Could not disconnect Gmail. Please try again.' });
  }
});

module.exports = router;
