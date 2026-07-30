const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * HTTP-level test for POST /api/tools/execute (EL3 —
 * Architecture/architecture/LIVE_EMAIL_LOOKUP.md S1.1 step 7, ADR-010).
 * Mirrors test/emailRoutes.test.js's skeleton exactly (app.listen(0), native
 * fetch, no supertest). Unlike every other signed-route test in this suite,
 * this one DOES exercise a full successful 200 signed round-trip — safe to
 * do here since the 'noop' tool this milestone implements makes no real
 * Gmail/Supabase network call, unlike every other signed callback's real
 * business logic.
 */

process.env.SERVICE_REQUEST_SIGNING_SECRET = process.env.SERVICE_REQUEST_SIGNING_SECRET || 'test-service-request-secret';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';
process.env.GLOBAL_SUPABASE_ANON_KEY = process.env.GLOBAL_SUPABASE_ANON_KEY || 'test-anon-key';

const app = require('../app');
const { signServiceRequest } = require('../services/serviceRequestAuth');

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function signedBody(payload, overrides = {}) {
  const envelope = signServiceRequest({
    clientId: 'client-1',
    idempotencyKey: 'tool-exec:test-1',
    payload,
    secret: process.env.SERVICE_REQUEST_SIGNING_SECRET,
  });
  return { ...envelope, payload, ...overrides };
}

test('POST /api/tools/execute — auth gating and the noop tool round trip', async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await t.test('rejects a request with no service-request envelope', async () => {
    const res = await fetch(`${base}/api/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { toolName: 'noop' } }),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
  });

  await t.test('rejects a request with a forged signature', async () => {
    const res = await fetch(`${base}/api/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'x',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        clientId: 'client-1',
        idempotencyKey: 'tool-exec:test-1',
        signature: 'forged',
        payload: { toolName: 'noop' },
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
  });

  await t.test('rejects a tampered payload (signature no longer matches)', async () => {
    const body = signedBody({ toolName: 'noop' });
    body.payload = { toolName: 'noop', args: { tampered: true } };
    const res = await fetch(`${base}/api/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
  });

  await t.test('a system-scoped envelope is rejected (this route is clientId-scoped, not system-scoped)', async () => {
    const { signSystemServiceRequest } = require('../services/serviceRequestAuth');
    const systemEnvelope = signSystemServiceRequest({
      idempotencyKey: 'tool-exec:test-1',
      payload: { toolName: 'noop' },
      secret: process.env.SERVICE_REQUEST_SIGNING_SECRET,
    });
    const res = await fetch(`${base}/api/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...systemEnvelope, payload: { toolName: 'noop' } }),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
  });

  await t.test('a correctly signed noop tool call succeeds end to end', async () => {
    const body = signedBody({ toolName: 'noop', args: { hello: 'world' } });
    const res = await fetch(`${base}/api/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, { status: 'ok', toolName: 'noop', echoedArgs: { hello: 'world' } });
  });

  await t.test('a correctly signed but unrecognized tool name returns a 200 with a named error reason, not an HTTP error', async () => {
    const body = signedBody({ toolName: 'search_email_messages', args: {} });
    const res = await fetch(`${base}/api/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, { status: 'error', reason: 'unknown_tool' });
  });

  await t.test('a noop call with no args echoes null, not undefined/an error', async () => {
    const body = signedBody({ toolName: 'noop' });
    const res = await fetch(`${base}/api/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, { status: 'ok', toolName: 'noop', echoedArgs: null });
  });
});
