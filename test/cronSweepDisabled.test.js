'use strict';

/**
 * HTTP-level proof, over the real Express app (app.js), that
 * GET /api/integrations/slack/sweep is disabled-by-default when
 * CRON_SECRET is unset — the exact production scenario found after
 * Milestone 4's deployment (the Vercel Cron entry that would have set
 * CRON_SECRET via the crons config was removed for exceeding the Hobby
 * plan's schedule limits, leaving the secret unset).
 *
 * Deliberately in its own file/process: `node --test` runs each matched
 * file as a separate process (the existing convention in this suite —
 * see test/slackEventsRoutes.test.js and test/slackRoutes.test.js, each of
 * which sets its own process.env before requiring ../app), so this file
 * can require the real app with CRON_SECRET genuinely absent without any
 * other test file's process.env.CRON_SECRET assignment leaking in.
 *
 * CRON_SECRET is intentionally NEVER set anywhere in this file.
 */

process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'test-signing-secret-for-sweep-disabled-tests';
process.env.SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || 'test-client-id';
process.env.SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || 'test-client-secret';
process.env.SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI || 'https://relativitysystems.ai/api/integrations/slack/callback';
process.env.SERVICE_REQUEST_SIGNING_SECRET = process.env.SERVICE_REQUEST_SIGNING_SECRET || 'test-service-request-secret';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';
process.env.GLOBAL_SUPABASE_ANON_KEY = process.env.GLOBAL_SUPABASE_ANON_KEY || 'test-anon-key';
delete process.env.CRON_SECRET;

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../app');
const slackEventsService = require('../services/slackEventsService');

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('GET /sweep with CRON_SECRET unset — secure-by-default', async (t) => {
  assert.equal(process.env.CRON_SECRET, undefined, 'precondition: CRON_SECRET must be genuinely unset for this file');

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await t.test('returns 503 with the exact safe disabled body, not 401 and not 200', async () => {
    const sweepSpy = t.mock.method(slackEventsService, 'runDeliverySweep', async () => ({ processed: 0 }));

    const res = await fetch(`${base}/api/integrations/slack/sweep`, {
      headers: { Authorization: 'Bearer some-token-someone-guessed' },
    });

    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Slack event sweep is not configured.' });
    assert.equal(sweepSpy.mock.callCount(), 0, 'sweep logic must never execute while the endpoint is disabled');
  });

  await t.test('returns 503 even with NO Authorization header at all', async () => {
    const sweepSpy = t.mock.method(slackEventsService, 'runDeliverySweep', async () => ({ processed: 0 }));

    const res = await fetch(`${base}/api/integrations/slack/sweep`);

    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Slack event sweep is not configured.' });
    assert.equal(sweepSpy.mock.callCount(), 0, 'sweep logic must never execute while the endpoint is disabled');
  });

  await t.test('returns 503 even with a well-formed Authorization header matching nothing in particular', async () => {
    const sweepSpy = t.mock.method(slackEventsService, 'runDeliverySweep', async () => ({ processed: 0 }));

    const res = await fetch(`${base}/api/integrations/slack/sweep`, {
      headers: { Authorization: 'Bearer ' },
    });

    assert.equal(res.status, 503);
    assert.equal(sweepSpy.mock.callCount(), 0);
  });

  await t.test('the disabled response body never contains the word "CRON_SECRET" or any secret-looking value', async () => {
    const res = await fetch(`${base}/api/integrations/slack/sweep`);
    const text = await res.text();
    assert.ok(!text.includes('CRON_SECRET'));
    assert.equal(text, JSON.stringify({ error: 'Slack event sweep is not configured.' }));
  });
});
