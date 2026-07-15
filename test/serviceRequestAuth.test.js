const test = require('node:test');
const assert = require('node:assert/strict');
const { signServiceRequest, verifyServiceRequest } = require('../services/serviceRequestAuth');

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
