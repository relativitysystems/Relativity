process.env.AIKB_API_BASE_URL = process.env.AIKB_API_BASE_URL || 'https://aikb.example.internal';
process.env.AIKB_API_KEY = process.env.AIKB_API_KEY || 'test-aikb-api-key';
process.env.SERVICE_REQUEST_SIGNING_SECRET = process.env.SERVICE_REQUEST_SIGNING_SECRET || 'test-service-request-secret';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAikbRedactClient, ERROR_CODES } = require('../services/aikbRedactClient');

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';

function fakeHttpClient(handler) {
  return { post: async (url, body, opts) => handler(url, body, opts) };
}

test('sends a signed envelope with the x-api-key header, carrying no customer content', async () => {
  let captured;
  const httpClient = fakeHttpClient((url, body, opts) => {
    captured = { url, body, opts };
    return { status: 200, data: { redacted: true } };
  });
  const client = createAikbRedactClient({ httpClient });

  const result = await client.redact({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev001' });

  assert.equal(result.redacted, true);
  assert.ok(captured.url.endsWith('/api/knowledge/chat/redact'));
  assert.equal(captured.opts.headers['x-api-key'], 'test-aikb-api-key');
  assert.equal(captured.body.clientId, CLIENT_ID);
  assert.equal(captured.body.idempotencyKey, 'slack:Ev001');
  assert.deepEqual(captured.body.payload, {});
  assert.ok(captured.body.signature);
});

test('rejects on a non-2xx response', async () => {
  const httpClient = fakeHttpClient(() => ({ status: 500, data: {} }));
  const client = createAikbRedactClient({ httpClient });

  await assert.rejects(
    () => client.redact({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev002' }),
    (err) => err.code === ERROR_CODES.HTTP_ERROR
  );
});

test('rejects on timeout', async () => {
  const httpClient = fakeHttpClient(() => {
    const err = new Error('timeout');
    err.code = 'ECONNABORTED';
    throw err;
  });
  const client = createAikbRedactClient({ httpClient });

  await assert.rejects(
    () => client.redact({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev003' }),
    (err) => err.code === ERROR_CODES.TIMEOUT
  );
});

test('rejects on an unexpected response shape', async () => {
  const httpClient = fakeHttpClient(() => ({ status: 200, data: null }));
  const client = createAikbRedactClient({ httpClient });

  await assert.rejects(
    () => client.redact({ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev004' }),
    (err) => err.code === ERROR_CODES.INVALID_RESPONSE
  );
});
