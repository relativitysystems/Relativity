'use strict';

// Slack OAuth connection routes (Architecture Review Phase 4, Milestone 3).
// Thin Express adapter — all logic lives in services/slackIntegrationService.js
// so it stays unit-testable without an HTTP layer. Mounted at
// /api/integrations/slack in app.js.
//
// clientId/memberId are ALWAYS resolved server-side by clientAuth from the
// authenticated Supabase session — never accepted from the browser.

const express = require('express');
const router = express.Router();
const clientAuth = require('../../middleware/clientAuth');
const slackIntegrationService = require('../../services/slackIntegrationService');

const OWNER_ADMIN = ['owner', 'admin'];

function requireOwnerAdmin(req, res, next) {
  if (!req.member || !OWNER_ADMIN.includes(req.member.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
}

/**
 * GET /api/integrations/slack/start
 * owner/admin only. Returns JSON { url } — the portal redirects the browser there.
 */
router.get('/start', clientAuth, requireOwnerAdmin, async (req, res) => {
  try {
    const { url } = await slackIntegrationService.startConnection({
      clientId: req.client.id,
      memberId: req.member.id,
    });
    res.json({ url });
  } catch (err) {
    if (err.code === 'SLACK_NOT_CONFIGURED') {
      return res.status(500).json({ error: 'Slack integration is not configured on the server.' });
    }
    console.error('GET /api/integrations/slack/start error:', err.message);
    res.status(500).json({ error: 'Could not start the Slack connection. Please try again.' });
  }
});

/**
 * GET /api/integrations/slack/callback
 * Public — Slack redirects the browser here with no bearer token. All
 * organization/member context comes from the consumed oauth_states row,
 * never from query parameters. Always redirects; never renders JSON, so a
 * raw Slack error/state/token can never end up in a JSON error body either.
 */
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const { redirectPath } = await slackIntegrationService.handleCallback({
    code: typeof code === 'string' ? code : null,
    state: typeof state === 'string' ? state : null,
    error: typeof error === 'string' ? error : null,
  });
  res.redirect(redirectPath);
});

/**
 * GET /api/integrations/slack/status
 * Any authenticated, active organization member — matches this repo's
 * existing convention (GET /auth/me already exposes dropbox/slack/google
 * connection booleans to any active member, not just owner/admin).
 */
router.get('/status', clientAuth, async (req, res) => {
  try {
    const status = await slackIntegrationService.getStatus({ clientId: req.client.id });
    res.json(status);
  } catch (err) {
    console.error('GET /api/integrations/slack/status error:', err.message);
    res.status(500).json({ error: 'Could not load Slack connection status.' });
  }
});

/**
 * POST /api/integrations/slack/disconnect
 * owner/admin only. Idempotent — disconnecting an already-disconnected
 * workspace returns the same safe success shape.
 */
router.post('/disconnect', clientAuth, requireOwnerAdmin, async (req, res) => {
  try {
    const result = await slackIntegrationService.disconnect({ clientId: req.client.id });
    res.json(result);
  } catch (err) {
    console.error('POST /api/integrations/slack/disconnect error:', err.message);
    res.status(500).json({ error: 'Could not disconnect Slack. Please try again.' });
  }
});

module.exports = router;
