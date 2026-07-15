const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlackDeliverService, RESULT } = require('../services/slackDeliverService');

const CLIENT_ID = 'client-1';
const OTHER_CLIENT_ID = 'client-2';
const CONNECTION_ID = 'conn-1';
const IDEMPOTENCY_KEY = 'slack:Ev001';

function baseRow(overrides = {}) {
  return {
    id: 'row-1',
    client_id: CLIENT_ID,
    connection_id: CONNECTION_ID,
    channel_id: 'C1',
    thread_ts: '1700000000.000000',
    event_ts: '1700000000.000000',
    status: 'enqueued',
    idempotency_key: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

function createFakeSlackEventLogService({ row } = {}) {
  const state = { row: row ? { ...row } : null };
  return {
    state,
    getByIdempotencyKey: async (key) => (state.row && state.row.idempotency_key === key ? state.row : null),
    claimForDelivery: async (id) => {
      if (state.row && state.row.id === id && state.row.status === 'enqueued') {
        state.row.status = 'answered';
        return state.row;
      }
      return null;
    },
    markDelivered: async (id) => { if (state.row && state.row.id === id) state.row.status = 'delivered'; return state.row; },
    markFailed: async (id, opts) => { if (state.row && state.row.id === id) { state.row.status = 'failed'; state.row.error_code = opts.errorCode; } return state.row; },
  };
}

function createFakeOauthConnectionsService({ connection = { id: CONNECTION_ID, status: 'active' }, credential = { accessToken: 'xoxb-fake' } } = {}) {
  return {
    getConnectionById: async () => connection,
    getDecryptedCredentialForConnection: async () => credential,
  };
}

function createFakeSlackDeliveryService({ shouldFail = false, errorCode = 'SLACK_DELIVERY_HTTP_ERROR' } = {}) {
  const calls = [];
  return {
    calls,
    postMessage: async (params) => {
      calls.push(params);
      if (shouldFail) throw Object.assign(new Error('failed'), { code: errorCode });
      return { ts: '1.1', channel: params.channel };
    },
  };
}

test('a successful answer is formatted and delivered, then the row is marked delivered', async () => {
  const slackEventLogService = createFakeSlackEventLogService({ row: baseRow() });
  const slackDeliveryService = createFakeSlackDeliveryService();
  const service = createSlackDeliverService({
    slackEventLogService,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    slackDeliveryService,
  });

  const result = await service.handleDeliverCallback({
    clientId: CLIENT_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    payload: { answer: 'You get 15 days of PTO.', sources: [{ fileName: 'PTO.pdf' }], isKnowledgeGap: false },
  });

  assert.equal(result.result, RESULT.DELIVERED);
  assert.equal(slackDeliveryService.calls.length, 1);
  assert.match(slackDeliveryService.calls[0].text, /You get 15 days of PTO\./);
  assert.match(slackDeliveryService.calls[0].text, /Sources:\n• PTO\.pdf/);
  assert.equal(slackEventLogService.state.row.status, 'delivered');
});

test('a knowledge-gap payload delivers the approved fallback message', async () => {
  const slackEventLogService = createFakeSlackEventLogService({ row: baseRow() });
  const slackDeliveryService = createFakeSlackDeliveryService();
  const service = createSlackDeliverService({
    slackEventLogService,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    slackDeliveryService,
  });

  await service.handleDeliverCallback({
    clientId: CLIENT_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    payload: { answer: '', sources: [], isKnowledgeGap: true },
  });

  assert.equal(slackDeliveryService.calls[0].text, "I couldn't find that information in your organization's knowledge base.");
});

test('an AIKB-reported error payload delivers the temporary-failure fallback', async () => {
  const slackEventLogService = createFakeSlackEventLogService({ row: baseRow() });
  const slackDeliveryService = createFakeSlackDeliveryService();
  const service = createSlackDeliverService({
    slackEventLogService,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    slackDeliveryService,
  });

  await service.handleDeliverCallback({
    clientId: CLIENT_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    payload: { error: true, errorCode: 'AIKB_PROCESSING_FAILED' },
  });

  assert.equal(slackDeliveryService.calls[0].text, "I couldn't complete that request right now. Please try again shortly.");
});

test('an unknown idempotencyKey (no matching event) is safely ignored', async () => {
  const service = createSlackDeliverService({
    slackEventLogService: createFakeSlackEventLogService({ row: null }),
    oauthConnectionsService: createFakeOauthConnectionsService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const result = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: 'slack:unknown', payload: { answer: 'x' } });
  assert.equal(result.result, RESULT.UNKNOWN_EVENT);
});

test('a clientId that does not match the event\'s own resolved clientId is rejected (cross-tenant safety)', async () => {
  const slackEventLogService = createFakeSlackEventLogService({ row: baseRow() });
  const slackDeliveryService = createFakeSlackDeliveryService();
  const service = createSlackDeliverService({
    slackEventLogService,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    slackDeliveryService,
  });

  const result = await service.handleDeliverCallback({ clientId: OTHER_CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x' } });
  assert.equal(result.result, RESULT.CLIENT_MISMATCH);
  assert.equal(slackDeliveryService.calls.length, 0);
});

test('a second /deliver callback for the same event is a safe no-op (only the first delivery attempt proceeds)', async () => {
  const slackEventLogService = createFakeSlackEventLogService({ row: baseRow() });
  const slackDeliveryService = createFakeSlackDeliveryService();
  const service = createSlackDeliverService({
    slackEventLogService,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    slackDeliveryService,
  });

  const first = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });
  const second = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });

  assert.equal(first.result, RESULT.DELIVERED);
  assert.equal(second.result, RESULT.ALREADY_PROCESSED);
  assert.equal(slackDeliveryService.calls.length, 1, 'Slack must never receive two posts for the same event');
});

test('a revoked connection is never used for delivery', async () => {
  const slackEventLogService = createFakeSlackEventLogService({ row: baseRow() });
  const slackDeliveryService = createFakeSlackDeliveryService();
  const service = createSlackDeliverService({
    slackEventLogService,
    oauthConnectionsService: createFakeOauthConnectionsService({ connection: { id: CONNECTION_ID, status: 'revoked' } }),
    slackDeliveryService,
  });

  const result = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });
  assert.equal(result.result, RESULT.CONNECTION_REVOKED);
  assert.equal(slackDeliveryService.calls.length, 0);
  assert.equal(slackEventLogService.state.row.status, 'failed');
});

test('a Slack delivery failure marks the row failed with a safe error code', async () => {
  const slackEventLogService = createFakeSlackEventLogService({ row: baseRow() });
  const slackDeliveryService = createFakeSlackDeliveryService({ shouldFail: true, errorCode: 'SLACK_DELIVERY_NOT_OK' });
  const service = createSlackDeliverService({
    slackEventLogService,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    slackDeliveryService,
  });

  const result = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });
  assert.equal(result.result, RESULT.DELIVERY_FAILED);
  assert.equal(slackEventLogService.state.row.status, 'failed');
  assert.equal(slackEventLogService.state.row.error_code, 'SLACK_DELIVERY_NOT_OK');
});

test('the token is never exposed anywhere in the result or thrown errors', async () => {
  const slackEventLogService = createFakeSlackEventLogService({ row: baseRow() });
  const service = createSlackDeliverService({
    slackEventLogService,
    oauthConnectionsService: createFakeOauthConnectionsService({ credential: { accessToken: 'xoxb-SUPER-SECRET' } }),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const result = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });
  assert.ok(!JSON.stringify(result).includes('xoxb-SUPER-SECRET'));
});
