const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmailLiveLookupService, compileLiveSearchQuery, computeMaxHistoricalDays } = require('../services/emailLiveLookupService');
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
  return { id: MEMBER_A, client_id: CLIENT_ID, role: 'member', status: 'active', search_enabled: true, ...overrides };
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

function makeService(overrides = {}) {
  return createEmailLiveLookupService({
    gmailService: fixtureGmailService(overrides.gmailService),
    oauthConnectionsService: fixtureOauthConnectionsService(overrides.oauthConnectionsService),
    emailConnectionService: fixtureEmailConnectionService(overrides.emailConnectionService),
    emailPolicyService: fixtureEmailPolicyService(overrides.emailPolicyService),
    emailNormalizationService: { normalizeEmailBody },
    supabaseService: fixtureSupabaseService(overrides.supabaseService),
  });
}

const SEARCH_ARGS = { maxResults: 10 };
const CONTENT_ARGS_BY_MESSAGE = { messageId: 'msg-1', threadId: null, maxMessagesInThread: 5 };

// ─────────────────────────────────────────────
// The 8-gate authorization chain — every rejection case
// ─────────────────────────────────────────────

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
