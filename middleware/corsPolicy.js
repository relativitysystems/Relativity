'use strict';

// Backlog M6 — explicit CORS policy. The portal (public/*.html + portal.js)
// is served from this same Express app/origin, so it never needs a CORS
// grant to reach its own API — this exists as a deliberate allowlist
// rather than leaving CORS unconfigured. Express sends no
// Access-Control-Allow-Origin header by default, which already blocks
// browser cross-origin reads, but "no policy" was previously an accident
// of Express's defaults, not a documented decision. config.allowedOrigins
// (ALLOWED_ORIGINS env var) lets ops add a second trusted origin — e.g. a
// staging domain — without touching code.

const cors = require('cors');
const config = require('../config');

const allowedOrigins = new Set([config.appBaseUrl, ...config.allowedOrigins]);

function corsOriginCheck(origin, callback) {
  // No Origin header: same-origin browser navigation, curl, or a
  // server-to-server call (e.g. Slack's webhook, AIKB's /deliver callback)
  // — never a cross-origin browser request, so there is nothing here for
  // CORS to police. Every such caller is already authenticated by its own
  // mechanism (Slack signature, service-request HMAC envelope, etc.).
  if (!origin) return callback(null, true);
  if (allowedOrigins.has(origin)) return callback(null, true);
  // callback(null, false) — never callback(error) — so a disallowed origin
  // simply gets no Access-Control-Allow-Origin header (the browser then
  // blocks the response client-side, which is how CORS enforcement is
  // supposed to work) instead of throwing and surfacing an unhandled
  // 500/stack-trace response. The route behind it still runs normally;
  // actual authorization is unaffected and unchanged, enforced by each
  // route's own auth middleware, not by this browser-only mechanism.
  return callback(null, false);
}

module.exports = cors({
  origin: corsOriginCheck,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
