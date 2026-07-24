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
const emailPolicyService = require('../../services/emailPolicyService');
const { REDIRECT, PROVIDER, canDisconnectConnection } = emailConnectionService;

const OWNER_ADMIN = ['owner', 'admin'];
const SUPPORTED_PROVIDERS = [PROVIDER]; // just 'gmail' for EM2 — microsoft is EM12

// The owner/admin closure §14.1's own file-level comment anticipated this
// milestone would need, alongside the pre-existing owns-this-connection
// inline check below (§4.1's "no shared requireRole middleware" gap is not
// fixed platform-wide by this, just given a local, reusable name here —
// matches routes/collections.js's own local requireRole precedent).
function requireOwnerAdmin(req, res, next) {
  if (!req.member || !OWNER_ADMIN.includes(req.member.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
}

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

/**
 * GET /api/integrations/email/policy
 * Any active member — every member sees the same organization policy that
 * bounds their own mailbox, not just owners/admins (§14.1, §16.1: "a
 * configured allow rule's effect is immediately visible to every connected
 * member").
 */
router.get('/policy', clientAuth, async (req, res) => {
  try {
    const result = await emailPolicyService.getPolicy(req.client.id);
    res.json(result);
  } catch (err) {
    console.error('GET /api/integrations/email/policy error:', err.message);
    res.status(500).json({ error: 'Could not load organization policy.' });
  }
});

/**
 * PUT /api/integrations/email/policy
 * owner/admin only (§14.1). Body: { rules: [...] }. Replaces the FULL rule
 * set — fail-closed: {rules: []} means ingest nothing, from anyone, in any
 * mode (§16.1 item 6), enforced by emailPolicyService.replacePolicy's
 * delete-then-insert order.
 */
router.put('/policy', clientAuth, requireOwnerAdmin, async (req, res) => {
  const { rules } = req.body;
  if (!Array.isArray(rules)) {
    return res.status(400).json({ error: 'rules must be an array' });
  }
  try {
    const result = await emailPolicyService.replacePolicy({
      clientId: req.client.id,
      rules,
      updatedByMemberId: req.member.id,
    });
    res.json(result);
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error('PUT /api/integrations/email/policy error:', err.message);
    res.status(500).json({ error: 'Could not save organization policy.' });
  }
});

/**
 * GET /api/integrations/email/settings
 * Any active member — informs whether the sync-mode selector even offers
 * Automatic (§14.1). Fails closed (automaticSyncEnabled: false) when the
 * client has never visited this setting, since email_organization_settings
 * is created lazily (§13.1).
 */
router.get('/settings', clientAuth, async (req, res) => {
  try {
    const result = await emailPolicyService.getSettings(req.client.id);
    res.json(result);
  } catch (err) {
    console.error('GET /api/integrations/email/settings error:', err.message);
    res.status(500).json({ error: 'Could not load email settings.' });
  }
});

/**
 * PUT /api/integrations/email/settings
 * owner/admin only (§14.1). Body: { automaticSyncEnabled }. Toggles the
 * org-wide automatic-sync switch (§13.1).
 */
router.put('/settings', clientAuth, requireOwnerAdmin, async (req, res) => {
  const { automaticSyncEnabled } = req.body;
  if (typeof automaticSyncEnabled !== 'boolean') {
    return res.status(400).json({ error: 'automaticSyncEnabled must be a boolean' });
  }
  try {
    const result = await emailPolicyService.updateSettings({
      clientId: req.client.id,
      automaticSyncEnabled,
      updatedByMemberId: req.member.id,
    });
    res.json(result);
  } catch (err) {
    console.error('PUT /api/integrations/email/settings error:', err.message);
    res.status(500).json({ error: 'Could not save email settings.' });
  }
});

module.exports = router;
