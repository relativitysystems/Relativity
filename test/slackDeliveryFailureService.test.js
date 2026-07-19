const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlackDeliveryFailureService } = require('../services/slackDeliveryFailureService');

function createFakeSlackEventLogService() {
  const calls = [];
  return { calls, markDeliveryFailed: async (id, opts) => { calls.push({ id, ...opts }); } };
}

function createFakeAikbRedactClient({ shouldFail = false } = {}) {
  const calls = [];
  return {
    calls,
    redact: async (params) => {
      calls.push(params);
      if (shouldFail) throw Object.assign(new Error('down'), { code: 'AIKB_REDACT_HTTP_ERROR' });
      return { redacted: true };
    },
  };
}

const ROW = { id: 'row-1', client_id: 'client-1', idempotency_key: 'slack:Ev001' };

test('marks the row delivery_failed and best-effort redacts the AIKB-side session by idempotency key', async () => {
  const slackEventLogService = createFakeSlackEventLogService();
  const aikbRedactClient = createFakeAikbRedactClient();
  const service = createSlackDeliveryFailureService({ slackEventLogService, aikbRedactClient });

  await service.finalizeDeliveryFailure({ row: ROW, errorCode: 'SLACK_DELIVERY_NOT_OK', attemptCount: 3 });

  assert.deepEqual(slackEventLogService.calls, [{ id: 'row-1', errorCode: 'SLACK_DELIVERY_NOT_OK', attemptCount: 3 }]);
  assert.deepEqual(aikbRedactClient.calls, [{ clientId: 'client-1', idempotencyKey: 'slack:Ev001' }]);
});

test('skipAikbRedact never calls out to AIKB (no AIKB-side content could exist for this row)', async () => {
  const slackEventLogService = createFakeSlackEventLogService();
  const aikbRedactClient = createFakeAikbRedactClient();
  const service = createSlackDeliveryFailureService({ slackEventLogService, aikbRedactClient });

  await service.finalizeDeliveryFailure({ row: ROW, errorCode: 'EMPTY_QUESTION_REPLY_FAILED', attemptCount: 3, skipAikbRedact: true });

  assert.equal(slackEventLogService.calls.length, 1);
  assert.equal(aikbRedactClient.calls.length, 0);
});

test('a failing AIKB redact call is swallowed — the row is still marked delivery_failed, no throw', async () => {
  const slackEventLogService = createFakeSlackEventLogService();
  const aikbRedactClient = createFakeAikbRedactClient({ shouldFail: true });
  const service = createSlackDeliveryFailureService({ slackEventLogService, aikbRedactClient });

  await service.finalizeDeliveryFailure({ row: ROW, errorCode: 'SLACK_DELIVERY_NOT_OK', attemptCount: 3 });

  assert.equal(slackEventLogService.calls.length, 1, 'the row transition must happen even if the AIKB callback fails');
});
