const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlackEventsService, OUTCOME } = require('../services/slackEventsService');

const CLIENT_ID = 'client-1';
const CONNECTION_ID = 'conn-1';
const TEAM_ID = 'T12345';
const BOT_USER_ID = 'U0BOT';

function activeConnection(overrides = {}) {
  return {
    id: CONNECTION_ID,
    client_id: CLIENT_ID,
    provider: 'slack',
    external_account_id: TEAM_ID,
    status: 'active',
    provider_metadata: { bot_user_id: BOT_USER_ID },
    ...overrides,
  };
}

function activeClient(overrides = {}) {
  return { id: CLIENT_ID, is_active: true, ...overrides };
}

function baseEventCallback(overrides = {}) {
  const { event: eventOverrides, ...topLevelOverrides } = overrides;
  return {
    type: 'event_callback',
    team_id: TEAM_ID,
    event_id: 'Ev001',
    ...topLevelOverrides,
    event: {
      type: 'app_mention',
      user: 'U0HUMAN',
      text: `<@${BOT_USER_ID}> What is our PTO policy?`,
      channel: 'C1',
      ts: '1700000000.000000',
      ...eventOverrides,
    },
  };
}

function createFakeSlackEventLog(initial = {}) {
  const rows = new Map();
  let nextId = 1;
  return {
    calls: [],
    insertReceived: async (params) => {
      const key = `slack:${params.externalEventId}`;
      const existing = [...rows.values()].find((r) => r.external_event_id === params.externalEventId);
      if (existing) return { inserted: false, row: existing };
      const row = { id: String(nextId++), status: 'received', channel_id: params.channelId, thread_ts: params.threadTs, event_ts: params.eventTs, external_event_id: params.externalEventId, client_id: params.clientId, connection_id: params.connectionId, ...initial };
      rows.set(row.id, row);
      return { inserted: true, row };
    },
    markEnqueued: async (id) => { const r = rows.get(id); if (r) r.status = 'enqueued'; return r; },
    markDelivered: async (id) => { const r = rows.get(id); if (r) r.status = 'delivered'; return r; },
    markFailed: async (id, opts) => { const r = rows.get(id); if (r) { r.status = 'failed'; r.error_code = opts.errorCode; } return r; },
    _rows: rows,
  };
}

function createFakeOauthConnectionsService({ connection = activeConnection(), credential = { accessToken: 'xoxb-fake' } } = {}) {
  return {
    getActiveConnectionByExternalAccount: async () => connection,
    getDecryptedCredentialForConnection: async () => credential,
  };
}

function createFakeSupabaseService({ client = activeClient() } = {}) {
  return { getClientById: async () => client };
}

function createFakeAikbAskClient({ shouldFail = false } = {}) {
  const calls = [];
  return {
    calls,
    ask: async (params) => {
      calls.push(params);
      if (shouldFail) throw Object.assign(new Error('down'), { code: 'AIKB_ASK_HTTP_ERROR' });
      return { accepted: true, eventId: 'aikb-evt-1' };
    },
  };
}

function createFakeSlackDeliveryService() {
  const calls = [];
  return { calls, postMessage: async (params) => { calls.push(params); return { ts: '1.0', channel: params.channel }; } };
}

test('a valid app_mention with a real question resolves the workspace, dedupes, and enqueues via AIKB', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const aikbAskClient = createFakeAikbAskClient();
  const oauthConnectionsService = createFakeOauthConnectionsService();
  const supabaseService = createFakeSupabaseService();
  const slackDeliveryService = createFakeSlackDeliveryService();

  const service = createSlackEventsService({ slackEventLogService, aikbAskClient, oauthConnectionsService, supabaseService, slackDeliveryService });
  const result = await service.processEventCallback(baseEventCallback());

  assert.equal(result.outcome, OUTCOME.ENQUEUED);
  assert.equal(aikbAskClient.calls.length, 1);
  assert.equal(aikbAskClient.calls[0].clientId, CLIENT_ID);
  assert.equal(aikbAskClient.calls[0].question, 'What is our PTO policy?');
  assert.equal(aikbAskClient.calls[0].idempotencyKey, 'slack:Ev001');
});

test('never trusts a client/organization id from the Slack payload — only from the DB lookup', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const aikbAskClient = createFakeAikbAskClient();
  const oauthConnectionsService = createFakeOauthConnectionsService();
  const supabaseService = createFakeSupabaseService();
  const service = createSlackEventsService({ slackEventLogService, aikbAskClient, oauthConnectionsService, supabaseService, slackDeliveryService: createFakeSlackDeliveryService() });

  const spoofed = baseEventCallback({ client_id: 'attacker-supplied-client-id', organization_id: 'attacker-org' });
  await service.processEventCallback(spoofed);

  assert.equal(aikbAskClient.calls[0].clientId, CLIENT_ID, 'clientId must come only from the trusted oauth_connections lookup');
});

test('a duplicate event_id is deduped and never calls AIKB twice', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const aikbAskClient = createFakeAikbAskClient();
  const service = createSlackEventsService({
    slackEventLogService, aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const first = await service.processEventCallback(baseEventCallback());
  const second = await service.processEventCallback(baseEventCallback());

  assert.equal(first.outcome, OUTCOME.ENQUEUED);
  assert.equal(second.outcome, OUTCOME.DUPLICATE);
  assert.equal(aikbAskClient.calls.length, 1);
});

test('an unknown workspace (no active connection) is safely rejected, no AIKB call', async () => {
  const aikbAskClient = createFakeAikbAskClient();
  const service = createSlackEventsService({
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient,
    oauthConnectionsService: { getActiveConnectionByExternalAccount: async () => null },
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const result = await service.processEventCallback(baseEventCallback());
  assert.equal(result.outcome, OUTCOME.UNKNOWN_WORKSPACE);
  assert.equal(aikbAskClient.calls.length, 0);
});

test('an ambiguous mapping (lookup throws) is rejected the same as unknown, never leaks the error', async () => {
  const service = createSlackEventsService({
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: { getActiveConnectionByExternalAccount: async () => { throw new Error('PGRST116: more than one row returned'); } },
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const result = await service.processEventCallback(baseEventCallback());
  assert.equal(result.outcome, OUTCOME.UNKNOWN_WORKSPACE);
});

test('an inactive organization is rejected, no AIKB call', async () => {
  const aikbAskClient = createFakeAikbAskClient();
  const service = createSlackEventsService({
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService({ client: activeClient({ is_active: false }) }),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const result = await service.processEventCallback(baseEventCallback());
  assert.equal(result.outcome, OUTCOME.INACTIVE_ORG);
  assert.equal(aikbAskClient.calls.length, 0);
});

test('a bot-generated event is ignored', async () => {
  const aikbAskClient = createFakeAikbAskClient();
  const service = createSlackEventsService({
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const result = await service.processEventCallback(baseEventCallback({ event: { bot_id: 'B123' } }));
  assert.equal(result.outcome, OUTCOME.BOT_EVENT);
  assert.equal(aikbAskClient.calls.length, 0);
});

test('a self-generated event (from RelativityBot itself) is ignored', async () => {
  const aikbAskClient = createFakeAikbAskClient();
  const service = createSlackEventsService({
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const result = await service.processEventCallback(baseEventCallback({ event: { user: BOT_USER_ID } }));
  assert.equal(result.outcome, OUTCOME.SELF_EVENT);
  assert.equal(aikbAskClient.calls.length, 0);
});

test('an unsupported event type is ignored', async () => {
  const service = createSlackEventsService({
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const result = await service.processEventCallback(baseEventCallback({ event: { type: 'message' } }));
  assert.equal(result.outcome, OUTCOME.UNSUPPORTED_EVENT_TYPE);
});

test('an edited-message subtype is ignored', async () => {
  const service = createSlackEventsService({
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const result = await service.processEventCallback(baseEventCallback({ event: { subtype: 'message_changed' } }));
  assert.equal(result.outcome, OUTCOME.EDITED_OR_DELETED);
});

test('a malformed payload (missing team_id) is safely ignored', async () => {
  const service = createSlackEventsService({
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const result = await service.processEventCallback({ type: 'event_callback', event_id: 'Ev001', event: { type: 'app_mention' } });
  assert.equal(result.outcome, OUTCOME.MALFORMED);
});

test('a malformed payload (missing event) is safely ignored', async () => {
  const service = createSlackEventsService({
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const result = await service.processEventCallback({ type: 'event_callback', team_id: TEAM_ID, event_id: 'Ev001' });
  assert.equal(result.outcome, OUTCOME.MALFORMED);
});

test('an empty mention (no question) never calls AIKB and replies directly with the safe fallback', async () => {
  const aikbAskClient = createFakeAikbAskClient();
  const slackDeliveryService = createFakeSlackDeliveryService();
  const service = createSlackEventsService({
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService,
  });

  const result = await service.processEventCallback(baseEventCallback({ event: { text: `<@${BOT_USER_ID}>` } }));
  assert.equal(result.outcome, OUTCOME.EMPTY_QUESTION);
  assert.equal(aikbAskClient.calls.length, 0);
  assert.equal(slackDeliveryService.calls.length, 1);
  assert.equal(slackDeliveryService.calls[0].text, 'Please include a question after mentioning me.');
});

test('url_verification returns the exact challenge value', () => {
  const service = createSlackEventsService({
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const result = service.handleUrlVerification({ type: 'url_verification', challenge: 'abc123' });
  assert.deepEqual(result, { challenge: 'abc123' });
});

test('an AIKB /ask failure never throws — the row stays retryable and Slack still gets ack\'d', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const aikbAskClient = createFakeAikbAskClient({ shouldFail: true });
  const service = createSlackEventsService({
    slackEventLogService, aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
  });

  const result = await service.processEventCallback(baseEventCallback());
  assert.equal(result.status, 200);
  assert.equal(result.outcome, OUTCOME.ASK_FAILED);
});
