'use strict';

// Slack Events API request signature verification (Architecture Review
// Phase 4, Milestone 4, §4.4-§4.5). Modeled on AIKB's retired
// aikb/routes/slack.js#verifySlackSignature (crypto.timingSafeEqual over a
// v0:<timestamp>:<rawBody> signing string), but computed over the EXACT raw
// request bytes captured by app.js's express.json({ verify }) callback
// (req.rawBody) rather than a re-serialized JSON.stringify(req.body) — see
// app.js for why that distinction matters.
//
// Never logs the raw signature, timestamp, or body — only a boolean
// accepted/rejected outcome and a safe reason code, via the caller
// (routes/integrations/slack.js).

const crypto = require('crypto');
const config = require('../config');

const REPLAY_WINDOW_SECONDS = 300; // five minutes, per §4.5

const REASON = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  MISSING_HEADERS: 'missing_headers',
  MALFORMED_TIMESTAMP: 'malformed_timestamp',
  STALE_TIMESTAMP: 'stale_timestamp',
  MISSING_RAW_BODY: 'missing_raw_body',
  SIGNATURE_MISMATCH: 'signature_mismatch',
  OK: 'ok',
});

/**
 * Pure verification function — takes exactly what it needs rather than an
 * Express `req`, so it can be unit-tested without booting an HTTP server.
 *
 * @param {object} params
 * @param {string|undefined} params.signature - X-Slack-Signature header value.
 * @param {string|undefined} params.timestamp - X-Slack-Request-Timestamp header value.
 * @param {Buffer|undefined} params.rawBody - exact raw request bytes.
 * @param {string|undefined} params.signingSecret - defaults to config.slack.signingSecret.
 * @param {number} [params.nowSeconds] - injectable for tests; defaults to current time.
 * @returns {{ ok: boolean, reason: string }}
 */
function verifySlackRequest({ signature, timestamp, rawBody, signingSecret = config.slack.signingSecret, nowSeconds } = {}) {
  if (!signingSecret) {
    return { ok: false, reason: REASON.NOT_CONFIGURED };
  }
  if (!signature || typeof signature !== 'string' || !timestamp || typeof timestamp !== 'string') {
    return { ok: false, reason: REASON.MISSING_HEADERS };
  }

  const parsedTimestamp = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(parsedTimestamp) || String(parsedTimestamp) !== timestamp.trim()) {
    return { ok: false, reason: REASON.MALFORMED_TIMESTAMP };
  }

  const now = typeof nowSeconds === 'number' ? nowSeconds : Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsedTimestamp) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: REASON.STALE_TIMESTAMP };
  }

  if (!Buffer.isBuffer(rawBody)) {
    return { ok: false, reason: REASON.MISSING_RAW_BODY };
  }

  const sigBase = Buffer.concat([
    Buffer.from(`v0:${timestamp}:`, 'utf8'),
    rawBody,
  ]);
  const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(sigBase).digest('hex')}`;

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signature, 'utf8');
  const safeEqual = expectedBuf.length === providedBuf.length
    && crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!safeEqual) {
    return { ok: false, reason: REASON.SIGNATURE_MISMATCH };
  }

  return { ok: true, reason: REASON.OK };
}

/**
 * Express middleware. Rejects with a safe, generic body on any failure —
 * never echoes the signing secret, the raw body, or which specific check
 * failed, since that would help an attacker iterate toward a forgery. The
 * safe `reason` code is still attached to req for structured, metadata-only
 * logging by the route (§4.16), never sent to the client.
 */
function verifySlackSignatureMiddleware(req, res, next) {
  const result = verifySlackRequest({
    signature: req.headers['x-slack-signature'],
    timestamp: req.headers['x-slack-request-timestamp'],
    rawBody: req.rawBody,
  });

  req.slackSignatureVerification = result;

  if (!result.ok) {
    if (result.reason === REASON.NOT_CONFIGURED) {
      return res.status(500).json({ error: 'Slack Events is not configured on this server.' });
    }
    return res.status(401).json({ error: 'Invalid Slack request signature.' });
  }

  next();
}

module.exports = {
  verifySlackRequest,
  verifySlackSignatureMiddleware,
  REASON,
  REPLAY_WINDOW_SECONDS,
};
