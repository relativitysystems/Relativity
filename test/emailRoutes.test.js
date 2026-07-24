const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Lightweight HTTP-level smoke test over the real Express app (app.js),
 * checking route wiring and auth-gating end to end. Deliberately narrow,
 * mirroring test/slackRoutes.test.js exactly: every request below either has
 * no Authorization header (rejected by clientAuth before any Supabase call
 * is made — see middleware/clientAuth.js) or hits the callback's early-return
 * paths (missing/denied params, unsupported provider — all resolved before
 * any Supabase or Gmail call), so this file makes no real Gmail or Supabase
 * network call, consistent with every other test in this suite. The route's
 * own owns-this-connection-OR-owner/admin auth check (routes/integrations/email.js's
 * POST /connections/:id/disconnect) and the cross-member isolation it
 * enforces are covered at the service layer in
 * test/emailConnectionService.test.js — EM2's own spec explicitly calls for
 * that coverage as a two-member test proving member A cannot see/mutate
 * member B's connection. A real authenticated-session route test would
 * require mocking Supabase's auth.getUser, which is outside this repo's
 * existing testing convention (no test database, no mocking library).
 */

process.env.GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || 'test-gmail-client-id';
process.env.GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || 'test-gmail-client-secret';
process.env.GMAIL_REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || 'https://relativitysystems.ai/api/integrations/email/gmail/callback';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';
process.env.GLOBAL_SUPABASE_ANON_KEY = process.env.GLOBAL_SUPABASE_ANON_KEY || 'test-anon-key';

const app = require('../app');

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('Email integration routes — auth gating and safe callback redirects', async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await t.test('GET /api/integrations/email/gmail/start requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/gmail/start`, { redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/integrations/email/connections requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/connections`, { redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  await t.test('POST /api/integrations/email/connections/:id/disconnect requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/connections/conn-1/disconnect`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/integrations/email/gmail/callback with a denial error redirects to the safe access_denied path', async () => {
    const res = await fetch(`${base}/api/integrations/email/gmail/callback?error=access_denied`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/portal.html?integration=gmail&error=access_denied');
  });

  await t.test('GET /api/integrations/email/gmail/callback with no code/state redirects to invalid_state', async () => {
    const res = await fetch(`${base}/api/integrations/email/gmail/callback`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/portal.html?integration=gmail&error=invalid_state');
  });

  await t.test('GET /api/integrations/email/gmail/callback with only a code (no state) redirects to invalid_state', async () => {
    const res = await fetch(`${base}/api/integrations/email/gmail/callback?code=abc`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/portal.html?integration=gmail&error=invalid_state');
  });

  await t.test('GET /api/integrations/email/microsoft/callback (unsupported provider) redirects to invalid_state, not a 500 or JSON error', async () => {
    const res = await fetch(`${base}/api/integrations/email/microsoft/callback`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/portal.html?integration=gmail&error=invalid_state');
  });
});
