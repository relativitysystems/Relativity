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
const requireServiceRequest = require('../../middleware/requireServiceRequest');
const slackIntegrationService = require('../../services/slackIntegrationService');
const slackEventsService = require('../../services/slackEventsService');
const slackDeliverService = require('../../services/slackDeliverService');
const { verifySlackSignatureMiddleware } = require('../../services/slackSignatureService');
const config = require('../../config');

const OWNER_ADMIN = ['owner', 'admin'];

// Structured, metadata-only logging (§4.16) — never a message/answer body,
// never a raw signature/token/error string.
function logSlackEvent(fields) {
  console.log('[slack events]', JSON.stringify({ provider: 'slack', ...fields }));
}

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

/**
 * POST /api/integrations/slack/events
 * Architecture Review Phase 4, Milestone 4 (§4.3-§4.9). Slack Events API
 * request URL. Signature-verified via raw request bytes (app.js's
 * express.json({ verify }) + verifySlackSignatureMiddleware) BEFORE
 * anything in this handler runs — team_id/event/user/etc. are only ever
 * read here because verification already happened.
 *
 * Always resolves quickly with a 200 (or the url_verification challenge) —
 * this handler never waits on the full AIKB RAG pipeline, only the fast
 * accept-and-enqueue leg (services/aikbAskClient.js), per §4.8.
 */
router.post('/events', verifySlackSignatureMiddleware, async (req, res) => {
  const body = req.body || {};

  const challenge = slackEventsService.handleUrlVerification(body);
  if (challenge) {
    logSlackEvent({ event_type: 'url_verification', outcome: 'ok' });
    return res.json(challenge);
  }

  if (body.type !== 'event_callback') {
    logSlackEvent({ outcome: 'unsupported_body_type' });
    return res.status(200).json({ ok: true });
  }

  try {
    const result = await slackEventsService.processEventCallback(body);
    logSlackEvent({
      event_id: body.event_id || null,
      event_type: body.event && body.event.type,
      outcome: result.outcome,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    // Never let an unexpected internal error surface Slack a 5xx that
    // would trigger a redeliver storm — log safely and still ack.
    console.error('[slack events] processing error:', err.code || 'unknown');
    return res.status(200).json({ ok: true });
  }
});

/**
 * POST /api/integrations/slack/deliver
 * AIKB's callback once a Slack-originated question has an answer (or has
 * failed) — reversed service-request auth: AIKB signs, Relativity verifies
 * (middleware/requireServiceRequest.js). Never trusts clientId from the
 * request body directly, only from the verified envelope.
 */
router.post('/deliver', requireServiceRequest, async (req, res) => {
  try {
    const { clientId, idempotencyKey } = req.serviceRequest;
    const result = await slackDeliverService.handleDeliverCallback({
      clientId,
      idempotencyKey,
      payload: req.servicePayload,
    });
    logSlackEvent({ outcome: result.result });
    return res.status(200).json({ ok: true, result: result.result });
  } catch (err) {
    console.error('[slack deliver] processing error:', err.code || 'unknown');
    return res.status(200).json({ ok: false });
  }
});

/**
 * GET /api/integrations/slack/sweep
 * Vercel Cron entry (vercel.json) — retry backstop for events stuck in
 * received/enqueued past a timeout (§4.8). Gated by CRON_SECRET: Vercel
 * sends `Authorization: Bearer <CRON_SECRET>` automatically for
 * cron-triggered requests when the project has CRON_SECRET configured.
 */
router.get('/sweep', async (req, res) => {
  if (config.cron.secret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${config.cron.secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const summary = await slackEventsService.runDeliverySweep();
    logSlackEvent({ outcome: 'sweep_complete', processed: summary.processed });
    return res.json({ ok: true, processed: summary.processed });
  } catch (err) {
    console.error('[slack sweep] error:', err.code || 'unknown');
    return res.status(500).json({ error: 'Sweep failed.' });
  }
});

module.exports = router;
