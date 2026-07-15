const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifySlackRequest, REASON } = require('../services/slackSignatureService');

const SECRET = 'test-signing-secret';

function sign({ timestamp, rawBody, secret = SECRET }) {
  const sigBase = Buffer.concat([Buffer.from(`v0:${timestamp}:`, 'utf8'), rawBody]);
  return `v0=${crypto.createHmac('sha256', secret).update(sigBase).digest('hex')}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

test('valid signature is accepted', () => {
  const timestamp = String(nowSeconds());
  const rawBody = Buffer.from(JSON.stringify({ type: 'event_callback' }));
  const signature = sign({ timestamp, rawBody });

  const result = verifySlackRequest({ signature, timestamp, rawBody, signingSecret: SECRET });
  assert.equal(result.ok, true);
  assert.equal(result.reason, REASON.OK);
});

test('invalid signature is rejected', () => {
  const timestamp = String(nowSeconds());
  const rawBody = Buffer.from(JSON.stringify({ type: 'event_callback' }));
  const result = verifySlackRequest({ signature: 'v0=deadbeef', timestamp, rawBody, signingSecret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.SIGNATURE_MISMATCH);
});

test('a signature computed with the wrong secret is rejected', () => {
  const timestamp = String(nowSeconds());
  const rawBody = Buffer.from(JSON.stringify({ type: 'event_callback' }));
  const signature = sign({ timestamp, rawBody, secret: 'wrong-secret' });
  const result = verifySlackRequest({ signature, timestamp, rawBody, signingSecret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.SIGNATURE_MISMATCH);
});

test('missing signature header is rejected', () => {
  const timestamp = String(nowSeconds());
  const rawBody = Buffer.from('{}');
  const result = verifySlackRequest({ signature: undefined, timestamp, rawBody, signingSecret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.MISSING_HEADERS);
});

test('missing timestamp header is rejected', () => {
  const rawBody = Buffer.from('{}');
  const signature = sign({ timestamp: String(nowSeconds()), rawBody });
  const result = verifySlackRequest({ signature, timestamp: undefined, rawBody, signingSecret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.MISSING_HEADERS);
});

test('stale timestamp (older than five minutes) is rejected', () => {
  const timestamp = String(nowSeconds() - 301);
  const rawBody = Buffer.from('{}');
  const signature = sign({ timestamp, rawBody });
  const result = verifySlackRequest({ signature, timestamp, rawBody, signingSecret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.STALE_TIMESTAMP);
});

test('a timestamp too far in the future is also rejected (replay window is symmetric)', () => {
  const timestamp = String(nowSeconds() + 301);
  const rawBody = Buffer.from('{}');
  const signature = sign({ timestamp, rawBody });
  const result = verifySlackRequest({ signature, timestamp, rawBody, signingSecret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.STALE_TIMESTAMP);
});

test('a timestamp just inside the five-minute window is accepted', () => {
  const timestamp = String(nowSeconds() - 299);
  const rawBody = Buffer.from('{}');
  const signature = sign({ timestamp, rawBody });
  const result = verifySlackRequest({ signature, timestamp, rawBody, signingSecret: SECRET });
  assert.equal(result.ok, true);
});

test('malformed (non-numeric) timestamp is rejected', () => {
  const rawBody = Buffer.from('{}');
  const signature = sign({ timestamp: String(nowSeconds()), rawBody });
  const result = verifySlackRequest({ signature, timestamp: 'not-a-number', rawBody, signingSecret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.MALFORMED_TIMESTAMP);
});

test('a timestamp with trailing garbage is rejected, not silently parsed', () => {
  const rawBody = Buffer.from('{}');
  const timestamp = `${nowSeconds()}abc`;
  const signature = sign({ timestamp: String(nowSeconds()), rawBody });
  const result = verifySlackRequest({ signature, timestamp, rawBody, signingSecret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.MALFORMED_TIMESTAMP);
});

test('missing raw body is rejected (never falls back to re-serialized JSON)', () => {
  const timestamp = String(nowSeconds());
  const signature = sign({ timestamp, rawBody: Buffer.from('{}') });
  const result = verifySlackRequest({ signature, timestamp, rawBody: undefined, signingSecret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.MISSING_RAW_BODY);
});

test('signature is computed over the EXACT raw bytes — re-serialized JSON with different whitespace fails', () => {
  const timestamp = String(nowSeconds());
  const originalBody = Buffer.from('{"b":1,"a":2}');
  const signature = sign({ timestamp, rawBody: originalBody });

  // Same logical content, different byte-for-byte serialization (pretty-printed).
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(originalBody.toString()), null, 2));
  const result = verifySlackRequest({ signature, timestamp, rawBody: reserialized, signingSecret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.SIGNATURE_MISMATCH);
});

test('not configured (no signing secret) is rejected distinctly', () => {
  const timestamp = String(nowSeconds());
  const rawBody = Buffer.from('{}');
  const signature = sign({ timestamp, rawBody });
  // '' rather than undefined: a default parameter only substitutes for
  // undefined, so this proves the explicit-empty-secret path, not just
  // that the default happened to be falsy too.
  const result = verifySlackRequest({ signature, timestamp, rawBody, signingSecret: '' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.NOT_CONFIGURED);
});

test('uses constant-time comparison (mismatched-length signature is a clean mismatch, not a throw)', () => {
  const timestamp = String(nowSeconds());
  const rawBody = Buffer.from('{}');
  const result = verifySlackRequest({ signature: 'v0=short', timestamp, rawBody, signingSecret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.SIGNATURE_MISMATCH);
});
