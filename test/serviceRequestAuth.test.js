const test = require('node:test');
const assert = require('node:assert/strict');
const {
  signServiceRequest, verifyServiceRequest,
  signSystemServiceRequest, verifySystemServiceRequest,
} = require('../services/serviceRequestAuth');

const SECRET = 'test-service-request-secret';
const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const IDEMPOTENCY_KEY = 'slack:Ev0123ABC';

test('a freshly signed envelope verifies successfully', () => {
  const payload = { question: 'What is our PTO policy?', origin: 'slack' };
  const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload, secret: SECRET });

  const result = verifyServiceRequest({ envelope, payload, secret: SECRET });
  assert.equal(result.ok, true);
  assert.equal(result.clientId, CLIENT_ID);
  assert.equal(result.idempotencyKey, IDEMPOTENCY_KEY);
});

test('a tampered payload invalidates the signature', () => {
  const payload = { question: 'original' };
  const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload, secret: SECRET });

  const tamperedPayload = { question: 'tampered' };
  const result = verifyServiceRequest({ envelope, payload: tamperedPayload, secret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('a tampered clientId in the envelope invalidates the signature', () => {
  const payload = { question: 'x' };
  const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload, secret: SECRET });

  const tampered = { ...envelope, clientId: '22222222-2222-2222-2222-222222222222' };
  const result = verifyServiceRequest({ envelope: tampered, payload, secret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('an expired envelope is rejected', () => {
  const payload = { question: 'x' };
  const past = new Date(Date.now() - 5 * 60 * 1000);
  const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload, secret: SECRET, now: past });

  const result = verifyServiceRequest({ envelope, payload, secret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
});

test('verifying with the wrong secret fails', () => {
  const payload = { question: 'x' };
  const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload, secret: SECRET });
  const result = verifyServiceRequest({ envelope, payload, secret: 'a-different-secret' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('missing envelope fields are rejected', () => {
  const result = verifyServiceRequest({ envelope: { clientId: CLIENT_ID }, payload: {}, secret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_fields');
});

test('missing secret on the verifying side is rejected as not_configured', () => {
  const payload = { question: 'x' };
  const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload, secret: SECRET });
  const result = verifyServiceRequest({ envelope, payload, secret: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});

test('an envelope with an implausibly long TTL is rejected', () => {
  const payload = { question: 'x' };
  const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload, secret: SECRET });
  // Forge a longer-than-allowed window; since the signature covers
  // expiresAt, this must also fail signature verification, not just the
  // TTL check — asserting that proves an attacker can't just widen the window.
  const forged = { ...envelope, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
  const result = verifyServiceRequest({ envelope: forged, payload, secret: SECRET });
  assert.equal(result.ok, false);
});

test('signing requires clientId and idempotencyKey', () => {
  assert.throws(() => signServiceRequest({ idempotencyKey: IDEMPOTENCY_KEY, payload: {}, secret: SECRET }));
  assert.throws(() => signServiceRequest({ clientId: CLIENT_ID, payload: {}, secret: SECRET }));
});

test('two different payloads produce different signatures for the same clientId/idempotencyKey', () => {
  const now = new Date();
  const envelopeA = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { question: 'a' }, secret: SECRET, now });
  const envelopeB = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { question: 'b' }, secret: SECRET, now });
  assert.notEqual(envelopeA.signature, envelopeB.signature);
});

// ─────────────────────────────────────────────
// System-scoped envelope (EM8 — §18.3): identical mechanics, no clientId
// anywhere in the envelope. The whole point of this variant is that a
// system envelope and a clientId-scoped envelope must never be
// interchangeable, even though both are signed with the same secret.
// ─────────────────────────────────────────────

const TICK_IDEMPOTENCY_KEY = 'email-sync-tick:2026-07-25T12:00:00.000Z';

test('a freshly signed system envelope verifies successfully and carries no clientId', () => {
  const payload = { source: 'email-sync-tick' };
  const envelope = signSystemServiceRequest({ idempotencyKey: TICK_IDEMPOTENCY_KEY, payload, secret: SECRET });

  assert.equal('clientId' in envelope, false, 'a system envelope must never carry a clientId field');
  const result = verifySystemServiceRequest({ envelope, payload, secret: SECRET });
  assert.equal(result.ok, true);
  assert.equal(result.idempotencyKey, TICK_IDEMPOTENCY_KEY);
  assert.equal('clientId' in result, false);
});

test('a system envelope is rejected by verifyServiceRequest (missing_fields — no clientId)', () => {
  const payload = { source: 'email-sync-tick' };
  const systemEnvelope = signSystemServiceRequest({ idempotencyKey: TICK_IDEMPOTENCY_KEY, payload, secret: SECRET });

  const result = verifyServiceRequest({ envelope: systemEnvelope, payload, secret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_fields');
});

test('a clientId-scoped envelope is rejected by verifySystemServiceRequest even with a forged SYSTEM clientId (signature covers the real scope, not the label)', () => {
  const payload = { question: 'x' };
  const clientEnvelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload, secret: SECRET });

  // Attacker relabels a legitimate clientId-scoped envelope as system-scoped
  // by stripping clientId — the signature was computed over the real
  // clientId, not 'SYSTEM', so this must fail, never silently pass.
  const { clientId, ...relabeled } = clientEnvelope;
  const result = verifySystemServiceRequest({ envelope: relabeled, payload, secret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('an expired system envelope is rejected', () => {
  const payload = { source: 'email-sync-tick' };
  const past = new Date(Date.now() - 5 * 60 * 1000);
  const envelope = signSystemServiceRequest({ idempotencyKey: TICK_IDEMPOTENCY_KEY, payload, secret: SECRET, now: past });

  const result = verifySystemServiceRequest({ envelope, payload, secret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
});

test('verifying a system envelope with the wrong secret fails', () => {
  const payload = { source: 'email-sync-tick' };
  const envelope = signSystemServiceRequest({ idempotencyKey: TICK_IDEMPOTENCY_KEY, payload, secret: SECRET });
  const result = verifySystemServiceRequest({ envelope, payload, secret: 'a-different-secret' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('signing a system envelope requires idempotencyKey but not clientId', () => {
  assert.throws(() => signSystemServiceRequest({ payload: {}, secret: SECRET }));
  assert.doesNotThrow(() => signSystemServiceRequest({ idempotencyKey: TICK_IDEMPOTENCY_KEY, payload: {}, secret: SECRET }));
});

test('missing system-envelope fields are rejected', () => {
  const result = verifySystemServiceRequest({ envelope: { idempotencyKey: TICK_IDEMPOTENCY_KEY }, payload: {}, secret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_fields');
});
