const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlackDeliveryService, ERROR_CODES } = require('../services/slackDeliveryService');

function fakeHttpClient(handler) {
  return { post: async (url, body, opts) => handler(url, body, opts) };
}

test('posts to chat.postMessage with the correct channel, thread_ts, and text', async () => {
  let captured;
  const httpClient = fakeHttpClient((url, body, opts) => {
    captured = { url, body, opts };
    return { status: 200, data: { ok: true, ts: '1700000000.000100', channel: 'C123' } };
  });
  const service = createSlackDeliveryService({ httpClient });

  const result = await service.postMessage({ botToken: 'xoxb-secret', channel: 'C123', threadTs: '1700000000.000000', text: 'The answer' });

  assert.equal(captured.url, 'https://slack.com/api/chat.postMessage');
  assert.equal(captured.body.channel, 'C123');
  assert.equal(captured.body.thread_ts, '1700000000.000000');
  assert.equal(captured.body.text, 'The answer');
  assert.equal(captured.opts.headers.Authorization, 'Bearer xoxb-secret');
  assert.deepEqual(result, { ts: '1700000000.000100', channel: 'C123' });
});

test('rejects a Slack ok:false response', async () => {
  const httpClient = fakeHttpClient(() => ({ status: 200, data: { ok: false, error: 'channel_not_found' } }));
  const service = createSlackDeliveryService({ httpClient });

  await assert.rejects(
    () => service.postMessage({ botToken: 'xoxb-secret', channel: 'C123', threadTs: '1.0', text: 'x' }),
    (err) => err.code === ERROR_CODES.NOT_OK
  );
});

test('rejects a non-2xx HTTP response', async () => {
  const httpClient = fakeHttpClient(() => ({ status: 500, data: { ok: false } }));
  const service = createSlackDeliveryService({ httpClient });

  await assert.rejects(
    () => service.postMessage({ botToken: 'xoxb-secret', channel: 'C123', threadTs: '1.0', text: 'x' }),
    (err) => err.code === ERROR_CODES.HTTP_ERROR
  );
});

test('rejects an invalid (non-object) response body', async () => {
  const httpClient = fakeHttpClient(() => ({ status: 200, data: 'not-json-shaped' }));
  const service = createSlackDeliveryService({ httpClient });

  await assert.rejects(
    () => service.postMessage({ botToken: 'xoxb-secret', channel: 'C123', threadTs: '1.0', text: 'x' }),
    (err) => err.code === ERROR_CODES.INVALID_RESPONSE
  );
});

test('rejects on timeout without leaking the token in the thrown error', async () => {
  const httpClient = fakeHttpClient(() => {
    const err = new Error('timeout of 8000ms exceeded');
    err.code = 'ECONNABORTED';
    throw err;
  });
  const service = createSlackDeliveryService({ httpClient });

  await assert.rejects(
    () => service.postMessage({ botToken: 'xoxb-VERY-SECRET-TOKEN', channel: 'C123', threadTs: '1.0', text: 'x' }),
    (err) => {
      assert.equal(err.code, ERROR_CODES.TIMEOUT);
      assert.ok(!err.message.includes('xoxb-VERY-SECRET-TOKEN'));
      return true;
    }
  );
});

test('a generic HTTP client failure never leaks the token in the thrown error message', async () => {
  const httpClient = fakeHttpClient(() => {
    const err = new Error('request failed');
    err.config = { headers: { Authorization: 'Bearer xoxb-VERY-SECRET-TOKEN' } };
    throw err;
  });
  const service = createSlackDeliveryService({ httpClient });

  await assert.rejects(
    () => service.postMessage({ botToken: 'xoxb-VERY-SECRET-TOKEN', channel: 'C123', threadTs: '1.0', text: 'x' }),
    (err) => {
      assert.ok(!err.message.includes('xoxb-VERY-SECRET-TOKEN'));
      assert.ok(!('config' in err));
      return true;
    }
  );
});

test('rejects when no bot token is provided', async () => {
  const service = createSlackDeliveryService({ httpClient: fakeHttpClient(() => { throw new Error('should not be called'); }) });
  await assert.rejects(
    () => service.postMessage({ botToken: null, channel: 'C123', threadTs: '1.0', text: 'x' }),
    (err) => err.code === ERROR_CODES.NO_ACTIVE_CONNECTION
  );
});
