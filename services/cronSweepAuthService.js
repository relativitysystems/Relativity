'use strict';

// Authentication for GET /api/integrations/slack/sweep — the retry-sweep
// backstop for stuck slack_event_log rows (§4.8). Modeled on
// services/slackSignatureService.js: a pure, injectable-secret verification
// function (unit-testable with no Express, no config, no env mutation) plus
// a thin Express middleware wrapper around it.
//
// Security-hardening fix (post-Milestone-4 production deployment): the
// original inline check in routes/integrations/slack.js only validated
// Authorization when config.cron.secret was truthy —
//
//   if (config.cron.secret) { ... compare ... }
//
// — so an unset CRON_SECRET (the actual state in production once the
// Vercel Cron entry was removed for exceeding the Hobby plan's schedule
// limits) skipped the check entirely and let the sweep run unauthenticated.
// This module makes "secret not configured" and "secret configured but
// caller unauthorized" two distinct, explicit outcomes — the endpoint is
// disabled-by-default, never open-by-default.
//
// Never logs the configured secret or the caller-provided token — only the
// safe REASON code below, via the caller.

const crypto = require('crypto');
const config = require('../config');

const BEARER_PREFIX = 'Bearer ';

const REASON = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  MISSING_AUTHORIZATION: 'missing_authorization',
  MALFORMED_AUTHORIZATION: 'malformed_authorization',
  TOKEN_MISMATCH: 'token_mismatch',
  OK: 'ok',
});

// undefined, null, '', and whitespace-only are all treated as "not
// configured" — a secret that is present but blank must disable the
// endpoint exactly like a secret that was never set.
function isBlank(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * Pure verification function — takes exactly what it needs rather than an
 * Express `req`, so every branch (including "not configured") can be unit
 * tested without touching process.env or the cached config module.
 *
 * @param {object} params
 * @param {string|undefined} params.authorizationHeader - raw Authorization header value.
 * @param {string|undefined} [params.configuredSecret] - defaults to config.cron.secret.
 * @returns {{ ok: boolean, reason: string }}
 */
function verifyCronSweepAuth({ authorizationHeader, configuredSecret = config.cron.secret } = {}) {
  if (isBlank(configuredSecret)) {
    return { ok: false, reason: REASON.NOT_CONFIGURED };
  }

  if (!authorizationHeader || typeof authorizationHeader !== 'string') {
    return { ok: false, reason: REASON.MISSING_AUTHORIZATION };
  }

  // Strict, single accepted scheme: exactly "Bearer <token>" (capital B,
  // one space). Any other scheme (Basic, lowercase bearer, no scheme at
  // all) or a Bearer header with nothing after it is malformed, not a
  // token-mismatch — this is decided before any secret comparison happens.
  if (!authorizationHeader.startsWith(BEARER_PREFIX)) {
    return { ok: false, reason: REASON.MALFORMED_AUTHORIZATION };
  }
  const providedToken = authorizationHeader.slice(BEARER_PREFIX.length);
  if (!providedToken) {
    return { ok: false, reason: REASON.MALFORMED_AUTHORIZATION };
  }

  const expectedBuf = Buffer.from(configuredSecret, 'utf8');
  const providedBuf = Buffer.from(providedToken, 'utf8');

  // crypto.timingSafeEqual throws on mismatched buffer lengths, so the
  // length check must short-circuit BEFORE it — but comparing lengths
  // first does not itself leak the secret (only its length, which is
  // operator-controlled and not sensitive the way the value is), and every
  // unequal-length input still gets a length-independent-timing-irrelevant
  // safe rejection here rather than a thrown exception.
  const safeEqual = expectedBuf.length === providedBuf.length
    && crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!safeEqual) {
    return { ok: false, reason: REASON.TOKEN_MISMATCH };
  }

  return { ok: true, reason: REASON.OK };
}

/**
 * Express middleware for GET /api/integrations/slack/sweep. Fail-closed by
 * construction: every branch other than the exact-match success path
 * returns before `next()` is ever called, so the sweep service function is
 * never invoked without a verified, correctly configured secret.
 *
 * Never echoes the configured secret, the provided token, or which specific
 * check failed to the client — only a generic, safe error body. The
 * `reason` code is attached to req for the route's own safe, metadata-only
 * logging (§4.16 convention), never sent to the client.
 */
function requireConfiguredCronSecret(req, res, next) {
  const result = verifyCronSweepAuth({ authorizationHeader: req.headers['authorization'] });

  req.cronSweepAuth = result;

  if (!result.ok) {
    if (result.reason === REASON.NOT_CONFIGURED) {
      return res.status(503).json({ error: 'Slack event sweep is not configured.' });
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

module.exports = {
  verifyCronSweepAuth,
  requireConfiguredCronSecret,
  REASON,
};
