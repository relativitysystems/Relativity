/**
 * Lightweight HTTP-level test over the real Express app (app.js) for the
 * new Milestone 4 routes. Deliberately narrow, matching this repo's
 * existing convention (test/slackRoutes.test.js): every request below
 * either fails signature/envelope verification before any Supabase/AIKB
 * call is made, or (for url_verification) never reaches the database at
 * all — so this file makes no real Slack, Supabase, or AIKB network call.
 * Deeper flow coverage (event filtering, tenant mapping, dedup, delivery)
 * lives in test/slackEventsService.test.js and test/slackDeliverService.test.js,
 * which test the underlying services directly via dependency injection.
 */

process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'test-signing-secret-for-events-route-tests';
process.env.SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || 'test-client-id';
process.env.SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || 'test-client-secret';
process.env.SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI || 'https://relativitysystems.ai/api/integrations/slack/callback';
process.env.SERVICE_REQUEST_SIGNING_SECRET = process.env.SERVICE_REQUEST_SIGNING_SECRET || 'test-service-request-secret';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';
process.env.GLOBAL_SUPABASE_ANON_KEY = process.env.GLOBAL_SUPABASE_ANON_KEY || 'test-anon-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const app = require('../app');

function sign(timestamp, rawBody) {
  const sigBase = `v0:${timestamp}:${rawBody}`;
  return `v0=${crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET).update(sigBase).digest('hex')}`;
}

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('Slack events/deliver routes — signature and envelope gating', async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await t.test('POST /events with a valid signature answers url_verification with the exact challenge', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'abc123xyz' });
    const signature = sign(timestamp, rawBody);

    const res = await fetch(`${base}/api/integrations/slack/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Signature': signature,
        'X-Slack-Request-Timestamp': timestamp,
      },
      body: rawBody,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.challenge, 'abc123xyz');
  });

  await t.test('POST /events with an invalid signature is rejected before any processing', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'should-not-be-returned' });

    const res = await fetch(`${base}/api/integrations/slack/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Signature': 'v0=deadbeef',
        'X-Slack-Request-Timestamp': timestamp,
      },
      body: rawBody,
    });

    assert.equal(res.status, 401);
  });

  await t.test('POST /events with missing signature headers is rejected', async () => {
    const res = await fetch(`${base}/api/integrations/slack/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'x' }),
    });
    assert.equal(res.status, 401);
  });

  await t.test('POST /events with a stale timestamp is rejected even with an otherwise-correct signature', async () => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'x' });
    const signature = sign(staleTimestamp, rawBody);

    const res = await fetch(`${base}/api/integrations/slack/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Signature': signature,
        'X-Slack-Request-Timestamp': staleTimestamp,
      },
      body: rawBody,
    });
    assert.equal(res.status, 401);
  });

  await t.test('POST /deliver with no service-request envelope is rejected', async () => {
    const res = await fetch(`${base}/api/integrations/slack/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { answer: 'x' } }),
    });
    assert.equal(res.status, 401);
  });

  await t.test('POST /deliver with a forged signature is rejected', async () => {
    const res = await fetch(`${base}/api/integrations/slack/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'x', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
        clientId: 'client-1', idempotencyKey: 'slack:Ev001', signature: 'forged', payload: { answer: 'x' },
      }),
    });
    assert.equal(res.status, 401);
  });

  await t.test('ADR-007: GET /sweep no longer exists — the scheduled recovery sweep was removed, not restored', async () => {
    const res = await fetch(`${base}/api/integrations/slack/sweep`);
    assert.equal(res.status, 404);
  });

  await t.test('regression: Milestone 3 OAuth routes are still mounted and still require auth', async () => {
    const res = await fetch(`${base}/api/integrations/slack/status`);
    assert.equal(res.status, 401);
  });
});
