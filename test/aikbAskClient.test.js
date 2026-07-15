process.env.AIKB_API_BASE_URL = process.env.AIKB_API_BASE_URL || 'https://aikb.example.internal';
process.env.AIKB_API_KEY = process.env.AIKB_API_KEY || 'test-aikb-api-key';
process.env.SERVICE_REQUEST_SIGNING_SECRET = process.env.SERVICE_REQUEST_SIGNING_SECRET || 'test-service-request-secret';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAikbAskClient, ERROR_CODES } = require('../services/aikbAskClient');

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';

function fakeHttpClient(handler) {
  return { post: async (url, body, opts) => handler(url, body, opts) };
}

test('sends a signed envelope with the x-api-key header and never includes a Slack token', async () => {
  let captured;
  const httpClient = fakeHttpClient((url, body, opts) => {
    captured = { url, body, opts };
    return { status: 200, data: { accepted: true, eventId: 'evt-1' } };
  });
  const client = createAikbAskClient({ httpClient });

  const result = await client.ask({
    clientId: CLIENT_ID,
    question: 'What is our PTO policy?',
    idempotencyKey: 'slack:Ev001',
    originMetadata: { teamId: 'T1', channelId: 'C1', threadTs: '1.0', eventId: 'Ev001' },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.eventId, 'evt-1');
  assert.ok(captured.url.endsWith('/api/knowledge/ask'));
  assert.equal(captured.opts.headers['x-api-key'], 'test-aikb-api-key');
  assert.equal(captured.body.clientId, CLIENT_ID);
  assert.equal(captured.body.idempotencyKey, 'slack:Ev001');
  assert.equal(captured.body.payload.origin, 'slack');
  assert.ok(captured.body.signature);
  assert.equal(JSON.stringify(captured.body).includes('xoxb-'), false);
});

test('rejects on a non-2xx response', async () => {
  const httpClient = fakeHttpClient(() => ({ status: 500, data: {} }));
  const client = createAikbAskClient({ httpClient });

  await assert.rejects(
    () => client.ask({ clientId: CLIENT_ID, question: 'x', idempotencyKey: 'slack:Ev002', originMetadata: {} }),
    (err) => err.code === ERROR_CODES.HTTP_ERROR
  );
});

test('rejects on an unexpected response shape', async () => {
  const httpClient = fakeHttpClient(() => ({ status: 200, data: { accepted: false } }));
  const client = createAikbAskClient({ httpClient });

  await assert.rejects(
    () => client.ask({ clientId: CLIENT_ID, question: 'x', idempotencyKey: 'slack:Ev003', originMetadata: {} }),
    (err) => err.code === ERROR_CODES.INVALID_RESPONSE
  );
});

test('rejects on timeout', async () => {
  const httpClient = fakeHttpClient(() => {
    const err = new Error('timeout');
    err.code = 'ECONNABORTED';
    throw err;
  });
  const client = createAikbAskClient({ httpClient });

  await assert.rejects(
    () => client.ask({ clientId: CLIENT_ID, question: 'x', idempotencyKey: 'slack:Ev004', originMetadata: {} }),
    (err) => err.code === ERROR_CODES.TIMEOUT
  );
});
