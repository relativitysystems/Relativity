'use strict';

// Backlog M6 — general-purpose rate limiting. Scoped to the specific
// unauthenticated, brute-forceable endpoints the architecture review named:
// admin login (a single shared password, see routes/admin.js#POST /login)
// and the team-invite flow (an unauthenticated token check reachable by
// anyone with a guessed/leaked token, see routes/team.js and
// routes/auth.js#POST /complete-invite).
//
// Portal login itself (Supabase signInWithPassword, public/portal/login.js)
// never reaches this server — the browser talks directly to Supabase Auth
// using the anon key — so it cannot be rate-limited here; that surface is
// covered by Supabase's own platform-level auth rate limiting, not this
// repository. See architecture/SECURITY.md.
//
// In-memory (express-rate-limit's default MemoryStore) — consistent with
// this repo's pre-existing ad hoc limiter (routes/auth.js's password-reset
// _isResetRateLimited, left as-is rather than migrated here) and adequate
// for this app's current single-instance deployment. A future
// multi-instance deployment would need a shared store (e.g. Redis) instead
// — tracked as a follow-up, not blocking this change.

const rateLimit = require('express-rate-limit');

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

// Covers both the unauthenticated invite-verify lookup (routes/team.js) and
// the JWT-gated invite-accept call (routes/auth.js) — same token-guessing
// threat model, same limiter.
const teamInviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

module.exports = { adminLoginLimiter, teamInviteLimiter };
