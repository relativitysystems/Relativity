'use strict';

// Minimal, additive HMAC-signed request envelope between Relativity and
// AIKB, scoped ONLY to POST /api/knowledge/ask (Relativity -> AIKB),
// POST /api/integrations/slack/deliver (AIKB -> Relativity, reversed), and
// (as of EM8) POST /api/integrations/email/sync/tick (AIKB -> Relativity,
// system-scoped, no clientId) — Architecture Review Phase 4, Milestone 4,
// §4.10; system-scoped envelope added per EMAIL_INGESTION.md §18.3.
//
// Honest scope note: this is NOT the full future signed ServiceRequest
// envelope described in Phase 2 §10 / Phase 3 principle 13 (no
// entitledCollectionIds, no multi-origin principal registry, no asymmetric
// signing, no contract versioning). It exists only so AIKB can trust a
// per-request clientId/idempotencyKey from a caller that is not a human
// with a Supabase Auth JWT (the first machine-to-machine caller AIKB has
// ever needed to trust with a client-scoped write). AIKB's identical
// counterpart is aikb/services/serviceRequestAuth.js — the signing string
// format in the two files MUST match byte-for-byte or verification will
// always fail.
//
// signature = HMAC-SHA256(secret, "requestId.issuedAt.expiresAt.clientId.idempotencyKey.sha256(payload)")
//
// System-scoped variant (signSystemServiceRequest/verifySystemServiceRequest,
// EM8): identical mechanics, but clientId in the signing string above is
// always the hardcoded literal 'SYSTEM' rather than a caller-supplied value
// — see the dedicated comment further down this file. This is a narrow,
// deliberate exception to ADR-001's "AIKB stays provider-agnostic" boundary
// (AIKB contributes only "a clock," never a clientId or provider data) —
// see EMAIL_INGESTION.md §9, §18.3, §30 item 5.

const crypto = require('crypto');

const ENVELOPE_TTL_MS = 60 * 1000; // issuedAt + 60s, per §4.10

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
}

function buildSigningString({ requestId, issuedAt, expiresAt, clientId, idempotencyKey, payloadHash }) {
  return [requestId, issuedAt, expiresAt, clientId, idempotencyKey, payloadHash].join('.');
}

/**
 * Signs an outbound request envelope.
 * @returns {{ requestId, issuedAt, expiresAt, clientId, idempotencyKey, signature }}
 */
function signServiceRequest({ clientId, idempotencyKey, payload, secret, now = new Date() }) {
  if (!secret) throw new Error('signServiceRequest requires secret');
  if (!clientId) throw new Error('signServiceRequest requires clientId');
  if (!idempotencyKey) throw new Error('signServiceRequest requires idempotencyKey');

  const requestId = crypto.randomUUID();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ENVELOPE_TTL_MS).toISOString();
  const payloadHash = hashPayload(payload);
  const signingString = buildSigningString({ requestId, issuedAt, expiresAt, clientId, idempotencyKey, payloadHash });
  const signature = crypto.createHmac('sha256', secret).update(signingString).digest('hex');

  return { requestId, issuedAt, expiresAt, clientId, idempotencyKey, signature };
}

/**
 * Verifies an inbound envelope + payload. Never throws on a bad envelope —
 * returns a safe { ok, reason } result so callers never leak verification
 * internals in an HTTP response.
 */
function verifyServiceRequest({ envelope, payload, secret, now = new Date() }) {
  if (!secret) return { ok: false, reason: 'not_configured' };
  if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'missing_envelope' };

  const { requestId, issuedAt, expiresAt, clientId, idempotencyKey, signature } = envelope;
  if (!requestId || !issuedAt || !expiresAt || !clientId || !idempotencyKey || !signature) {
    return { ok: false, reason: 'missing_fields' };
  }
  if (typeof signature !== 'string') return { ok: false, reason: 'malformed_signature' };

  const expiresAtMs = Date.parse(expiresAt);
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(issuedAtMs)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }
  if (now.getTime() > expiresAtMs) {
    return { ok: false, reason: 'expired' };
  }
  // issuedAt must not postdate expiresAt by more than the configured TTL —
  // guards against a forged envelope with an implausibly long validity window.
  if (expiresAtMs - issuedAtMs > ENVELOPE_TTL_MS + 1000) {
    return { ok: false, reason: 'invalid_ttl' };
  }

  const payloadHash = hashPayload(payload);
  const signingString = buildSigningString({ requestId, issuedAt, expiresAt, clientId, idempotencyKey, payloadHash });
  const expected = crypto.createHmac('sha256', secret).update(signingString).digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signature, 'utf8');
  const safeEqual = expectedBuf.length === providedBuf.length
    && crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!safeEqual) return { ok: false, reason: 'signature_mismatch' };

  return { ok: true, reason: 'ok', clientId, idempotencyKey, requestId };
}

// System-scoped envelope (EM8 — Architecture/architecture/EMAIL_INGESTION.md
// §18.3, §31): for exactly one caller, AIKB's Inngest cron tick calling
// POST /api/integrations/email/sync/tick, which carries no client-specific
// data at all (§18.3: "it does not know which clients have email
// connections"). Reuses the identical HMAC/TTL mechanics above but replaces
// clientId with the hardcoded literal 'SYSTEM' baked into the signing
// string itself — never a caller-supplied field — so a signed system
// envelope can never be replayed as a valid clientId-scoped envelope (or
// vice versa): the two signing strings are structurally different inputs to
// the same HMAC, not just a value swap one could forge from the other.
const SYSTEM_SCOPE = 'SYSTEM';

/**
 * Signs an outbound system-scoped envelope (no clientId).
 * @returns {{ requestId, issuedAt, expiresAt, idempotencyKey, signature }}
 */
function signSystemServiceRequest({ idempotencyKey, payload, secret, now = new Date() }) {
  if (!secret) throw new Error('signSystemServiceRequest requires secret');
  if (!idempotencyKey) throw new Error('signSystemServiceRequest requires idempotencyKey');

  const requestId = crypto.randomUUID();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ENVELOPE_TTL_MS).toISOString();
  const payloadHash = hashPayload(payload);
  const signingString = buildSigningString({ requestId, issuedAt, expiresAt, clientId: SYSTEM_SCOPE, idempotencyKey, payloadHash });
  const signature = crypto.createHmac('sha256', secret).update(signingString).digest('hex');

  return { requestId, issuedAt, expiresAt, idempotencyKey, signature };
}

/**
 * Verifies an inbound system-scoped envelope + payload. Same never-throws
 * contract as verifyServiceRequest. Deliberately does NOT accept a caller-
 * supplied clientId anywhere in the envelope — only requestId/issuedAt/
 * expiresAt/idempotencyKey/signature are read from it.
 */
function verifySystemServiceRequest({ envelope, payload, secret, now = new Date() }) {
  if (!secret) return { ok: false, reason: 'not_configured' };
  if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'missing_envelope' };

  const { requestId, issuedAt, expiresAt, idempotencyKey, signature } = envelope;
  if (!requestId || !issuedAt || !expiresAt || !idempotencyKey || !signature) {
    return { ok: false, reason: 'missing_fields' };
  }
  if (typeof signature !== 'string') return { ok: false, reason: 'malformed_signature' };

  const expiresAtMs = Date.parse(expiresAt);
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(issuedAtMs)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }
  if (now.getTime() > expiresAtMs) {
    return { ok: false, reason: 'expired' };
  }
  if (expiresAtMs - issuedAtMs > ENVELOPE_TTL_MS + 1000) {
    return { ok: false, reason: 'invalid_ttl' };
  }

  const payloadHash = hashPayload(payload);
  const signingString = buildSigningString({ requestId, issuedAt, expiresAt, clientId: SYSTEM_SCOPE, idempotencyKey, payloadHash });
  const expected = crypto.createHmac('sha256', secret).update(signingString).digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signature, 'utf8');
  const safeEqual = expectedBuf.length === providedBuf.length
    && crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!safeEqual) return { ok: false, reason: 'signature_mismatch' };

  return { ok: true, reason: 'ok', idempotencyKey, requestId };
}

module.exports = {
  signServiceRequest,
  verifyServiceRequest,
  signSystemServiceRequest,
  verifySystemServiceRequest,
  ENVELOPE_TTL_MS,
};
