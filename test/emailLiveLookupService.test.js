const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmailLiveLookupService, createInMemoryCallBudget, compileLiveSearchQuery, computeMaxHistoricalDays } = require('../services/emailLiveLookupService');
const { normalizeEmailBody } = require('../services/emailNormalizationService');

/**
 * DI-faked Gmail client tests for EL4 (Architecture/architecture/
 * LIVE_EMAIL_LOOKUP.md §4, §7, §9), mirroring
 * test/emailPreviewService.test.js's fixture-mailbox convention: the real
 * pure functions (normalizeEmailBody, and emailLiveLookupService's own
 * exported compileLiveSearchQuery/computeMaxHistoricalDays) are imported
 * directly, not re-faked; only the network-shaped dependencies
 * (gmailService, oauthConnectionsService, emailConnectionService,
 * emailPolicyService's async reads, supabaseService) are faked.
 */

const CLIENT_ID = 'client-1';
const MEMBER_A = 'member-a';
const MEMBER_B = 'member-b';
const CONNECTION_A_ID = 'conn-a';

function fixtureMember(overrides = {}) {
  return {
    id: MEMBER_A, client_id: CLIENT_ID, role: 'member', status: 'active', search_enabled: true,
    // EL6 (§2.3) — consented by default so every pre-existing EL4 test
    // (written before this gate existed) keeps exercising what it actually
    // means to test, rather than tripping on the new gate; dedicated gate
    // tests below override this explicitly.
    live_lookup_consented_at: '2026-07-30T00:00:00Z',
    ...overrides,
  };
}

function fixtureEmailConnectionRow(overrides = {}) {
  return { id: 'email-conn-a', member_id: MEMBER_A, live_lookup_enabled: true, ...overrides };
}

function fixtureSettings(overrides = {}) {
  return { liveLookupEnabled: true, ...overrides };
}

function fixtureSupabaseService({ member = fixtureMember() } = {}) {
  return {
    getClientMemberById: async (memberId, clientId) => {
      if (memberId !== member.id || clientId !== CLIENT_ID) return null;
      return member;
    },
  };
}

function fixtureOauthConnectionsService({ connection = { id: CONNECTION_A_ID, status: 'active' }, forMemberId = MEMBER_A } = {}) {
  return {
    getActiveConnectionForClientAndMember: async (clientId, provider, memberId) => {
      if (clientId !== CLIENT_ID || provider !== 'gmail' || memberId !== forMemberId) return null;
      return connection;
    },
  };
}

function fixtureEmailConnectionService({ emailConnectionRow = fixtureEmailConnectionRow(), accessToken = 'valid-token', tokenError = null } = {}) {
  return {
    getEmailConnectionRecord: async (oauthConnectionId) => (oauthConnectionId === CONNECTION_A_ID ? emailConnectionRow : null),
    getValidGmailAccessToken: async () => {
      if (tokenError) throw tokenError;
      return accessToken;
    },
  };
}

function fixtureEmailPolicyService({ settings = fixtureSettings(), rules = [] } = {}) {
  return {
    getSettings: async () => settings,
    getPolicy: async () => ({ rules }),
  };
}

function fixtureGmailService(overrides = {}) {
  return {
    listMessageIdsByQuery: async () => ({ messageIds: [], nextPageToken: null }),
    getMessageMetadata: async () => { throw new Error('not stubbed'); },
    getMessageBody: async () => { throw new Error('not stubbed'); },
    getThread: async () => { throw new Error('not stubbed'); },
    ...overrides,
  };
}

// EL7B — a fake audit repo so tests never make a real Supabase call; also
// lets tests assert on exactly what got audited.
function fixtureAuditRepo() {
  const events = [];
  return { events, recordEvent: async (event) => { events.push(event); } };
}

// EL9 — every test EXCEPT the dedicated budget-enforcement tests below gets
// a fresh, effectively-unlimited budget by default (a brand-new Map per
// makeService() call, never the module's real defaultCallBudget singleton
// — sharing that across ~40 tests in one process would eventually trip the
// real default limit and fail unrelated tests). Budget tests override this
// explicitly with a real createInMemoryCallBudget at a tiny limit.
function fixtureCallBudget() {
  return createInMemoryCallBudget({ windowMs: 5 * 60 * 1000, maxCalls: 100000 });
}

function makeService(overrides = {}) {
  const auditRepo = overrides.auditRepo || fixtureAuditRepo();
  const callBudget = overrides.callBudget || fixtureCallBudget();
  const service = createEmailLiveLookupService({
    gmailService: fixtureGmailService(overrides.gmailService),
    oauthConnectionsService: fixtureOauthConnectionsService(overrides.oauthConnectionsService),
    emailConnectionService: fixtureEmailConnectionService(overrides.emailConnectionService),
    emailPolicyService: fixtureEmailPolicyService(overrides.emailPolicyService),
    emailNormalizationService: { normalizeEmailBody },
    supabaseService: fixtureSupabaseService(overrides.supabaseService),
    auditRepo,
    callBudget,
  });
  service._auditEvents = auditRepo.events;
  return service;
}

const SEARCH_ARGS = { maxResults: 10 };
const CONTENT_ARGS_BY_MESSAGE = { messageId: 'msg-1', threadId: null, maxMessagesInThread: 5 };

// ─────────────────────────────────────────────
// The authorization gate chain — every rejection case
// ─────────────────────────────────────────────

test('gate: no consent (live_lookup_consented_at null) -> not_permitted, even with an active, live-lookup-enabled connection', async () => {
  const service = makeService({ supabaseService: { member: fixtureMember({ live_lookup_consented_at: null }) } });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.deepEqual(result, { status: 'unavailable', reason: 'not_permitted' });
});

test('gate: unknown member -> not_permitted', async () => {
  const service = makeService({ supabaseService: { member: fixtureMember({ id: 'ghost' }) } });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.deepEqual(result, { status: 'unavailable', reason: 'not_permitted' });
});

test('gate: disabled member -> not_permitted', async () => {
  const service = makeService({ supabaseService: { member: fixtureMember({ status: 'disabled' }) } });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.deepEqual(result, { status: 'unavailable', reason: 'not_permitted' });
});

test('gate: viewer role -> not_permitted', async () => {
  const service = makeService({ supabaseService: { member: fixtureMember({ role: 'viewer' }) } });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.deepEqual(result, { status: 'unavailable', reason: 'not_permitted' });
});

test('gate: search_enabled=false -> not_permitted', async () => {
  const service = makeService({ supabaseService: { member: fixtureMember({ search_enabled: false }) } });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.deepEqual(result, { status: 'unavailable', reason: 'not_permitted' });
});

test('gate: no active oauth connection -> not_connected', async () => {
  const service = makeService({ oauthConnectionsService: { connection: null } });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.deepEqual(result, { status: 'unavailable', reason: 'not_connected' });
});

test('gate: no email_connections row -> not_connected', async () => {
  const service = makeService({ emailConnectionService: { emailConnectionRow: null } });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.deepEqual(result, { status: 'unavailable', reason: 'not_connected' });
});

test('gate: org live_lookup_enabled=false -> not_permitted (even though mailbox flag is on)', async () => {
  const service = makeService({ emailPolicyService: { settings: fixtureSettings({ liveLookupEnabled: false }) } });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.deepEqual(result, { status: 'unavailable', reason: 'not_permitted' });
});

test('gate: mailbox live_lookup_enabled=false -> not_permitted (even though org flag is on)', async () => {
  const service = makeService({ emailConnectionService: { emailConnectionRow: fixtureEmailConnectionRow({ live_lookup_enabled: false }) } });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.deepEqual(result, { status: 'unavailable', reason: 'not_permitted' });
});

test('gate: expired/unrefreshable token -> auth_expired', async () => {
  const authErr = Object.assign(new Error('expired'), { code: 'AUTHORIZATION_EXPIRED' });
  const service = makeService({ emailConnectionService: { tokenError: authErr } });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.deepEqual(result, { status: 'unavailable', reason: 'auth_expired' });
});

test('gate: an unrelated thrown error from token refresh still propagates (not swallowed as auth_expired)', async () => {
  const service = makeService({ emailConnectionService: { tokenError: new Error('boom') } });
  await assert.rejects(
    () => service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS }),
    /boom/
  );
});

// ─────────────────────────────────────────────
// Cross-member isolation
// ─────────────────────────────────────────────

test('cross-member isolation: member B has no connection resolvable under member A\'s id, and vice versa', async () => {
  const service = makeService({
    supabaseService: { member: fixtureMember({ id: MEMBER_B }) },
    oauthConnectionsService: { forMemberId: MEMBER_A }, // fixture only "knows" member A's connection
  });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_B, args: SEARCH_ARGS });
  assert.deepEqual(result, { status: 'unavailable', reason: 'not_connected' });
});

// ─────────────────────────────────────────────
// search_email_messages — deny-rule filtering and caps
// ─────────────────────────────────────────────

const DENY_PAYROLL = { id: 'rule-deny-1', ruleType: 'deny', enabled: true, subjectKeyword: 'payroll' };

test('search: a message matching an enabled deny rule is silently excluded from results', async () => {
  const service = makeService({
    emailPolicyService: { rules: [DENY_PAYROLL] },
    gmailService: {
      listMessageIdsByQuery: async () => ({ messageIds: ['m1', 'm2'], nextPageToken: null }),
      getMessageMetadata: async ({ messageId }) => ({
        messageId,
        threadId: `t-${messageId}`,
        subject: messageId === 'm1' ? 'Q3 payroll adjustments' : 'Project kickoff notes',
        fromAddress: 'sender@example.com',
        date: '2026-07-30T00:00:00Z',
        isSent: false,
        snippet: 'preview text',
      }),
    },
  });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.equal(result.status, 'ok');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].messageId, 'm2');
});

test('search: truncated=true when the provider indicates more pages exist', async () => {
  const service = makeService({
    gmailService: {
      listMessageIdsByQuery: async () => ({ messageIds: ['m1'], nextPageToken: 'more' }),
      getMessageMetadata: async ({ messageId }) => ({
        messageId, threadId: 't1', subject: 'hi', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, snippet: 'x',
      }),
    },
  });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.equal(result.truncated, true);
});

test('search: snippet is capped at config.email.liveLookup.snippetMaxChars', async () => {
  const longSnippet = 'x'.repeat(500);
  const service = makeService({
    gmailService: {
      listMessageIdsByQuery: async () => ({ messageIds: ['m1'], nextPageToken: null }),
      getMessageMetadata: async ({ messageId }) => ({
        messageId, threadId: 't1', subject: 'hi', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, snippet: longSnippet,
      }),
    },
  });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.equal(result.matches[0].snippet.length, 200);
});

test('search: one bad candidate (metadata fetch throws) is skipped, not fatal to the whole search', async () => {
  const service = makeService({
    gmailService: {
      listMessageIdsByQuery: async () => ({ messageIds: ['bad', 'good'], nextPageToken: null }),
      getMessageMetadata: async ({ messageId }) => {
        if (messageId === 'bad') throw new Error('transient');
        return { messageId, threadId: 't1', subject: 'hi', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, snippet: 'x' };
      },
    },
  });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.equal(result.status, 'ok');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].messageId, 'good');
});

test('search: a provider failure (timeout/HTTP error) returns a named error result, never throws', async () => {
  const service = makeService({
    gmailService: { listMessageIdsByQuery: async () => { throw new Error('gmail down'); } },
  });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.deepEqual(result, { status: 'error', reason: 'provider_timeout' });
});

// ─────────────────────────────────────────────
// get_email_content — messageId vs threadId, deny-rules, body caps
// ─────────────────────────────────────────────

test('get_email_content (messageId): normalizes body and returns one message', async () => {
  const service = makeService({
    gmailService: {
      getMessageMetadata: async ({ messageId }) => ({
        messageId, threadId: 't1', subject: 'Contract update', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, snippet: 'x',
      }),
      getMessageBody: async ({ messageId }) => ({ messageId, html: null, text: 'Hello,\n\nHere is the update.\n\nBest,\nSam' }),
    },
  });
  const result = await service.getEmailContent({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: CONTENT_ARGS_BY_MESSAGE });
  assert.equal(result.status, 'ok');
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].body, /Here is the update/);
  assert.equal(result.messages[0].truncated, false);
});

test('get_email_content (messageId): a deny-listed message returns ok with zero messages, not an error', async () => {
  const service = makeService({
    emailPolicyService: { rules: [DENY_PAYROLL] },
    gmailService: {
      getMessageMetadata: async ({ messageId }) => ({
        messageId, threadId: 't1', subject: 'payroll details', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, snippet: 'x',
      }),
    },
  });
  const result = await service.getEmailContent({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: CONTENT_ARGS_BY_MESSAGE });
  assert.deepEqual(result, { status: 'ok', messages: [], truncated: false });
});

test('get_email_content (messageId): body is capped at config.email.liveLookup.bodyMaxChars with truncated:true', async () => {
  const longBody = 'y'.repeat(5000);
  const service = makeService({
    gmailService: {
      getMessageMetadata: async ({ messageId }) => ({
        messageId, threadId: 't1', subject: 'long', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, snippet: 'x',
      }),
      getMessageBody: async ({ messageId }) => ({ messageId, html: null, text: longBody }),
    },
  });
  const result = await service.getEmailContent({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: CONTENT_ARGS_BY_MESSAGE });
  assert.equal(result.messages[0].body.length, 3000);
  assert.equal(result.messages[0].truncated, true);
});

test('get_email_content (threadId): returns every non-denied message up to maxMessagesInThread, capped with truncated:true', async () => {
  const messages = Array.from({ length: 8 }, (_, i) => ({
    messageId: `m${i}`, threadId: 't1', subject: `msg ${i}`, fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, html: null, text: `body ${i}`,
  }));
  const service = makeService({
    gmailService: { getThread: async ({ threadId }) => ({ threadId, messages }) },
  });
  const result = await service.getEmailContent({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: { messageId: null, threadId: 't1', maxMessagesInThread: 3 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.messages.length, 3);
  assert.equal(result.truncated, true);
});

test('get_email_content (threadId): deny-listed messages in the thread are dropped, others kept', async () => {
  const messages = [
    { messageId: 'm1', threadId: 't1', subject: 'payroll numbers', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, html: null, text: 'x' },
    { messageId: 'm2', threadId: 't1', subject: 'project update', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, html: null, text: 'y' },
  ];
  const service = makeService({
    emailPolicyService: { rules: [DENY_PAYROLL] },
    gmailService: { getThread: async ({ threadId }) => ({ threadId, messages }) },
  });
  const result = await service.getEmailContent({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: { messageId: null, threadId: 't1', maxMessagesInThread: 5 } });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].messageId, 'm2');
});

// ─────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────

test('compileLiveSearchQuery: omitting every field still returns a usable query (never null)', () => {
  assert.equal(compileLiveSearchQuery({}), '-in:chats');
});

test('compileLiveSearchQuery: combines provided fields into Gmail search operators', () => {
  const query = compileLiveSearchQuery({ senderContains: 'sam@acme.com', subjectContains: 'renewal', unreadOnly: true });
  assert.equal(query, 'from:sam@acme.com subject:renewal is:unread -in:chats');
});

test('computeMaxHistoricalDays: falls back to config default when no enabled rules exist', () => {
  assert.equal(computeMaxHistoricalDays([]), 90);
});

test('computeMaxHistoricalDays: uses the most permissive enabled rule', () => {
  const rules = [
    { enabled: true, maxHistoricalDays: 30 },
    { enabled: true, maxHistoricalDays: 180 },
    { enabled: false, maxHistoricalDays: 730 },
  ];
  assert.equal(computeMaxHistoricalDays(rules), 180);
});

// ─────────────────────────────────────────────
// EL7B — audit trail (§10, pulled forward narrowly from EL9)
// ─────────────────────────────────────────────

test('search: a successful call writes one live_lookup_search audit row naming the connection, origin, tool, and result count', async () => {
  const service = makeService({
    gmailService: {
      listMessageIdsByQuery: async () => ({ messageIds: ['m1'], nextPageToken: null }),
      getMessageMetadata: async ({ messageId }) => ({
        messageId, threadId: 't1', subject: 'hi', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, snippet: 'x',
      }),
    },
  });
  await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS, origin: 'slack_dm', originMetadata: { teamId: 'T1' } });

  assert.equal(service._auditEvents.length, 1);
  const event = service._auditEvents[0];
  assert.equal(event.email_connection_id, 'email-conn-a');
  assert.equal(event.outcome, 'live_lookup_search');
  assert.equal(event.origin, 'slack_dm');
  assert.deepEqual(event.origin_metadata, { teamId: 'T1' });
  assert.equal(event.tool_name, 'search_email_messages');
  assert.equal(event.result_count, 1);
  assert.equal(event.provider_message_id, null, 'a search has no single message id to attribute');
  assert.ok(typeof event.provider_latency_ms === 'number');
});

test('search: a gate rejection (e.g. no consent) writes NO audit row — nothing was ever attempted against Gmail', async () => {
  const service = makeService({ supabaseService: { member: fixtureMember({ live_lookup_consented_at: null }) } });
  await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS, origin: 'portal' });
  assert.equal(service._auditEvents.length, 0);
});

test('search: a provider failure still writes an audit row, with the failure reason recorded', async () => {
  const service = makeService({
    gmailService: { listMessageIdsByQuery: async () => { throw new Error('down'); } },
  });
  await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS, origin: 'portal' });

  assert.equal(service._auditEvents.length, 1);
  assert.equal(service._auditEvents[0].outcome, 'live_lookup_search');
  assert.equal(service._auditEvents[0].reason, 'provider_timeout');
  assert.equal(service._auditEvents[0].result_count, 0);
});

test('get_email_content (messageId): writes a live_lookup_fetch audit row naming the requested message id', async () => {
  const service = makeService({
    gmailService: {
      getMessageMetadata: async ({ messageId }) => ({
        messageId, threadId: 't1', subject: 'hi', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, snippet: 'x',
      }),
      getMessageBody: async ({ messageId }) => ({ messageId, html: null, text: 'body' }),
    },
  });
  await service.getEmailContent({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: CONTENT_ARGS_BY_MESSAGE, origin: 'slack_dm' });

  assert.equal(service._auditEvents.length, 1);
  const event = service._auditEvents[0];
  assert.equal(event.outcome, 'live_lookup_fetch');
  assert.equal(event.provider_message_id, 'msg-1');
  assert.equal(event.result_count, 1);
});

test('get_email_content (threadId): audits the requested threadId as provider_message_id and the returned message count', async () => {
  const messages = [
    { messageId: 'm1', threadId: 't1', subject: 'a', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, html: null, text: 'x' },
    { messageId: 'm2', threadId: 't1', subject: 'b', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, html: null, text: 'y' },
  ];
  const service = makeService({ gmailService: { getThread: async ({ threadId }) => ({ threadId, messages }) } });
  await service.getEmailContent({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: { messageId: null, threadId: 't1', maxMessagesInThread: 5 }, origin: 'portal' });

  const event = service._auditEvents[0];
  assert.equal(event.provider_message_id, 't1');
  assert.equal(event.result_count, 2);
});

test('an audit-write failure never breaks the actual tool response (best-effort)', async () => {
  const failingAuditRepo = { events: [], recordEvent: async () => { throw new Error('db down'); } };
  const service = makeService({
    auditRepo: failingAuditRepo,
    gmailService: {
      listMessageIdsByQuery: async () => ({ messageIds: [], nextPageToken: null }),
    },
  });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS, origin: 'portal' });
  assert.equal(result.status, 'ok');
});

// ─────────────────────────────────────────────
// EL8 (§6, security requirement: "verify no OAuth/credential/hidden-
// recipient field ever appears in a rendered citation — a dedicated test,
// not just code review"). Simulates a Gmail response carrying extra,
// sensitive-shaped fields (as if a future gmailService change accidentally
// widened what getMessageMetadata/getMessageBody return) and proves the
// mapped result this file returns to AIKB never propagates them —
// structural, because every mapping below is an explicit property read,
// never an object spread.
// ─────────────────────────────────────────────

const FORBIDDEN_KEYS = ['accessToken', 'refreshToken', 'access_token', 'refresh_token', 'oauthToken', 'credential', 'bcc', 'rawPayload', 'authTag'];

function assertNoForbiddenKeys(obj) {
  const keys = Object.keys(obj);
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.includes(forbidden), false, `result must never include "${forbidden}"`);
  }
}

test('security: a search match never propagates extra/sensitive fields present on the underlying Gmail metadata response', async () => {
  const service = makeService({
    gmailService: {
      listMessageIdsByQuery: async () => ({ messageIds: ['m1'], nextPageToken: null }),
      getMessageMetadata: async ({ messageId }) => ({
        messageId, threadId: 't1', subject: 'hi', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, snippet: 'x',
        // Simulated leak surface — a hypothetical widened Gmail response.
        accessToken: 'ya29.leaked', refreshToken: '1//leaked', bcc: 'secret@b.com', rawPayload: { mime: 'raw' },
      }),
    },
  });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assertNoForbiddenKeys(result.matches[0]);
  assert.deepEqual(Object.keys(result.matches[0]).sort(), ['date', 'deepLinkUrl', 'fromAddress', 'messageId', 'snippet', 'subject', 'threadId'].sort());
});

test('security: get_email_content (messageId) never propagates extra/sensitive fields, and the access token itself never appears in the response', async () => {
  const service = makeService({
    gmailService: {
      getMessageMetadata: async ({ messageId }) => ({
        messageId, threadId: 't1', subject: 'hi', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, snippet: 'x',
        accessToken: 'ya29.leaked',
      }),
      getMessageBody: async ({ messageId }) => ({ messageId, html: null, text: 'body', accessToken: 'ya29.leaked-in-body', bcc: 'secret@b.com' }),
    },
  });
  const result = await service.getEmailContent({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: CONTENT_ARGS_BY_MESSAGE });
  assertNoForbiddenKeys(result.messages[0]);
  assert.equal(JSON.stringify(result).includes('ya29.leaked'), false, 'the Gmail access token used internally must never appear anywhere in the returned result');
});

test('security: the audit row itself never contains the access token or message body content', async () => {
  const service = makeService({
    gmailService: {
      listMessageIdsByQuery: async () => ({ messageIds: [], nextPageToken: null }),
    },
  });
  await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS, origin: 'portal' });
  const event = service._auditEvents[0];
  assert.equal(JSON.stringify(event).includes('valid-token'), false, 'the access token (fixtureEmailConnectionService default) must never be audited');
  assertNoForbiddenKeys(event);
});

// ─────────────────────────────────────────────
// EL9 (§8.3, §7) — per-connection call-rate budget
// ─────────────────────────────────────────────

test('createInMemoryCallBudget: allows calls up to maxCalls, then rejects — a rejected call is not itself recorded', () => {
  const budget = createInMemoryCallBudget({ windowMs: 60000, maxCalls: 2, now: () => 1000 });
  assert.equal(budget.checkAndRecord('conn-a'), true);
  assert.equal(budget.checkAndRecord('conn-a'), true);
  assert.equal(budget.checkAndRecord('conn-a'), false);
  assert.equal(budget.checkAndRecord('conn-a'), false, 'still rejected — a rejected attempt does not consume a slot, but also does not free one up');
});

test('createInMemoryCallBudget: different connections have fully independent budgets', () => {
  const budget = createInMemoryCallBudget({ windowMs: 60000, maxCalls: 1, now: () => 1000 });
  assert.equal(budget.checkAndRecord('conn-a'), true);
  assert.equal(budget.checkAndRecord('conn-a'), false);
  assert.equal(budget.checkAndRecord('conn-b'), true, 'conn-b\'s budget is untouched by conn-a exhausting its own');
});

test('createInMemoryCallBudget: the window slides — calls older than windowMs no longer count against the cap', () => {
  let nowMs = 1000;
  const budget = createInMemoryCallBudget({ windowMs: 60000, maxCalls: 1, now: () => nowMs });
  assert.equal(budget.checkAndRecord('conn-a'), true);
  assert.equal(budget.checkAndRecord('conn-a'), false);
  nowMs += 60001; // just past the window
  assert.equal(budget.checkAndRecord('conn-a'), true, 'the earlier call has aged out of the window');
});

test('search: exceeding the per-connection budget returns a distinct rate_limited error, never a silent empty result', async () => {
  const exhaustedBudget = createInMemoryCallBudget({ windowMs: 60000, maxCalls: 0, now: () => 1000 });
  const service = makeService({ callBudget: exhaustedBudget });
  const result = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.deepEqual(result, { status: 'error', reason: 'rate_limited' });
});

test('get_email_content: exceeding the per-connection budget returns a distinct rate_limited error', async () => {
  const exhaustedBudget = createInMemoryCallBudget({ windowMs: 60000, maxCalls: 0, now: () => 1000 });
  const service = makeService({ callBudget: exhaustedBudget });
  const result = await service.getEmailContent({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: CONTENT_ARGS_BY_MESSAGE });
  assert.deepEqual(result, { status: 'error', reason: 'rate_limited' });
});

test('search and get_email_content share ONE budget per connection, not two independent ones', async () => {
  const sharedBudget = createInMemoryCallBudget({ windowMs: 60000, maxCalls: 1, now: () => 1000 });
  const service = makeService({
    callBudget: sharedBudget,
    gmailService: {
      listMessageIdsByQuery: async () => ({ messageIds: [], nextPageToken: null }),
      getMessageMetadata: async ({ messageId }) => ({ messageId, threadId: 't1', subject: 'hi', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, snippet: 'x' }),
      getMessageBody: async ({ messageId }) => ({ messageId, html: null, text: 'body' }),
    },
  });
  const first = await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.equal(first.status, 'ok');
  const second = await service.getEmailContent({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: CONTENT_ARGS_BY_MESSAGE });
  assert.deepEqual(second, { status: 'error', reason: 'rate_limited' });
});

test('a rate-limited rejection writes NO audit row — nothing was attempted against Gmail, same convention as an authorization gate rejection', async () => {
  const exhaustedBudget = createInMemoryCallBudget({ windowMs: 60000, maxCalls: 0, now: () => 1000 });
  const service = makeService({ callBudget: exhaustedBudget });
  await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.equal(service._auditEvents.length, 0);
});

test('a rate-limit rejection never even reaches Gmail — listMessageIdsQuery is never called', async () => {
  let gmailCalled = false;
  const exhaustedBudget = createInMemoryCallBudget({ windowMs: 60000, maxCalls: 0, now: () => 1000 });
  const service = makeService({
    callBudget: exhaustedBudget,
    gmailService: { listMessageIdsByQuery: async () => { gmailCalled = true; return { messageIds: [], nextPageToken: null }; } },
  });
  await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });
  assert.equal(gmailCalled, false);
});

// ─────────────────────────────────────────────
// EL9 security requirement: "audit rows must never contain a message body
// or full subject — a dedicated test asserting this, mirroring the
// platform's existing discipline for email_ingestion_events.reason."
// ─────────────────────────────────────────────

test('security (EL9): an audit row for get_email_content never contains the message body, even though the tool call itself fetched one', async () => {
  const longBody = 'The full confidential message body text that must never be audited. '.repeat(20);
  const service = makeService({
    gmailService: {
      getMessageMetadata: async ({ messageId }) => ({
        messageId, threadId: 't1', subject: 'A fairly identifying full subject line', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, snippet: 'x',
      }),
      getMessageBody: async ({ messageId }) => ({ messageId, html: null, text: longBody }),
    },
  });
  await service.getEmailContent({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: CONTENT_ARGS_BY_MESSAGE });

  const event = service._auditEvents[0];
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes('confidential message body'), false);
  assert.equal(serialized.includes('A fairly identifying full subject line'), false);
  // The audit row's own allowed field set — never a body/subject field of any name.
  assert.deepEqual(Object.keys(event).sort(), ['email_connection_id', 'origin', 'origin_metadata', 'outcome', 'provider_latency_ms', 'provider_message_id', 'reason', 'result_count', 'tool_name'].sort());
});

test('security (EL9): an audit row for search_email_messages never contains any candidate\'s subject or snippet text', async () => {
  const service = makeService({
    gmailService: {
      listMessageIdsByQuery: async () => ({ messageIds: ['m1'], nextPageToken: null }),
      getMessageMetadata: async ({ messageId }) => ({
        messageId, threadId: 't1', subject: 'The quarterly financial forecast is attached', fromAddress: 'a@b.com', date: '2026-07-30T00:00:00Z', isSent: false, snippet: 'Here is the confidential snippet preview text',
      }),
    },
  });
  await service.searchEmailMessages({ clientId: CLIENT_ID, requestingMemberId: MEMBER_A, args: SEARCH_ARGS });

  const serialized = JSON.stringify(service._auditEvents[0]);
  assert.equal(serialized.includes('quarterly financial forecast'), false);
  assert.equal(serialized.includes('confidential snippet'), false);
});
