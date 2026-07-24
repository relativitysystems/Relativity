const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * config/index.js reads Gmail env vars at require-time, so they must be set
 * before requiring services/gmailService.js — the module caches the config
 * snapshot on first require. Sets fake-but-well-formed values; no real
 * network call is ever made (httpClient is dependency-injected in every
 * exchangeCodeForToken/revokeToken test below). Mirrors test/slackService.test.js.
 */
process.env.GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || 'test-gmail-client-id';
process.env.GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || 'test-gmail-client-secret';
process.env.GMAIL_REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || 'https://relativitysystems.ai/api/integrations/email/gmail/callback';

const {
  createGmailService,
  buildAuthorizationUrl,
  validateTokenResponse,
  validateUserInfoResponse,
  isGmailConfigured,
  compileSearchQuery,
  extractEmailAddress,
  parseMessageHeaders,
  REQUIRED_SCOPES,
  MANAGED_LABEL_NAME,
  ERROR_CODES,
} = require('../services/gmailService');

// ─────────────────────────────────────────────
// Authorization URL
// ─────────────────────────────────────────────

test('buildAuthorizationUrl uses GMAIL_CLIENT_ID, the exact redirect URI, response_type=code, and includes the raw state', () => {
  const url = new URL(buildAuthorizationUrl({ state: 'raw-state-value' }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'test-gmail-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://relativitysystems.ai/api/integrations/email/gmail/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'raw-state-value');
});

test('buildAuthorizationUrl requests exactly gmail.readonly + gmail.labels + openid + email + profile — nothing more, nothing less (EM5 adds gmail.labels)', () => {
  const url = new URL(buildAuthorizationUrl({ state: 's' }));
  const scopes = url.searchParams.get('scope').split(' ');
  const expected = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.labels',
    'openid',
    'email',
    'profile',
  ];
  assert.deepEqual(scopes.sort(), expected.sort());
  assert.deepEqual(REQUIRED_SCOPES.sort(), expected.sort());
});

test('buildAuthorizationUrl never requests gmail.modify, gmail.compose, or gmail.send (labels.create/list is the only mutation gmail.labels permits)', () => {
  const url = new URL(buildAuthorizationUrl({ state: 's' }));
  const scopeParam = url.searchParams.get('scope');
  for (const forbidden of ['gmail.modify', 'gmail.compose', 'gmail.send']) {
    assert.equal(scopeParam.includes(forbidden), false, `scope must not include "${forbidden}"`);
  }
});

test('buildAuthorizationUrl sets access_type=offline and prompt=consent to guarantee a refresh token', () => {
  const url = new URL(buildAuthorizationUrl({ state: 's' }));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
});

test('buildAuthorizationUrl never exposes the client secret', () => {
  const url = buildAuthorizationUrl({ state: 's' });
  assert.equal(url.includes('test-gmail-client-secret'), false);
});

test('buildAuthorizationUrl requires a state value', () => {
  assert.throws(() => buildAuthorizationUrl({ state: null }), /requires state/);
});

test('isGmailConfigured is true when clientId/clientSecret/redirectUri are all set', () => {
  assert.equal(isGmailConfigured(), true);
});

// ─────────────────────────────────────────────
// validateTokenResponse / validateUserInfoResponse — pure, no network
// ─────────────────────────────────────────────

test('validateTokenResponse accepts a well-formed response and normalizes it', () => {
  const result = validateTokenResponse({
    access_token: 'ya29.access-token',
    refresh_token: '1//refresh-token',
    expires_in: 3599,
    token_type: 'Bearer',
    scope: 'https://www.googleapis.com/auth/gmail.readonly openid email profile',
  });
  assert.equal(result.accessToken, 'ya29.access-token');
  assert.equal(result.refreshToken, '1//refresh-token');
  assert.equal(result.expiresInSeconds, 3599);
  assert.deepEqual(result.scopes, ['https://www.googleapis.com/auth/gmail.readonly', 'openid', 'email', 'profile']);
});

test('validateTokenResponse rejects a missing access_token', () => {
  assert.throws(
    () => validateTokenResponse({ refresh_token: 'r' }),
    (err) => err.code === ERROR_CODES.INVALID_RESPONSE
  );
});

test('validateTokenResponse rejects a missing refresh_token', () => {
  assert.throws(
    () => validateTokenResponse({ access_token: 'a' }),
    (err) => err.code === ERROR_CODES.INVALID_RESPONSE
  );
});

test('validateTokenResponse rejects a non-object response', () => {
  assert.throws(() => validateTokenResponse(null), (err) => err.code === ERROR_CODES.INVALID_RESPONSE);
  assert.throws(() => validateTokenResponse('oops'), (err) => err.code === ERROR_CODES.INVALID_RESPONSE);
});

test('validateUserInfoResponse accepts a well-formed response', () => {
  const result = validateUserInfoResponse({ sub: '10987654321', email: 'alex@example.com', name: 'Alex Doe' });
  assert.equal(result.externalAccountId, '10987654321');
  assert.equal(result.mailboxAddress, 'alex@example.com');
  assert.equal(result.displayName, 'Alex Doe');
});

test('validateUserInfoResponse rejects a missing sub', () => {
  assert.throws(
    () => validateUserInfoResponse({ email: 'alex@example.com' }),
    (err) => err.code === ERROR_CODES.INVALID_RESPONSE
  );
});

test('validateUserInfoResponse rejects a missing email', () => {
  assert.throws(
    () => validateUserInfoResponse({ sub: '109876' }),
    (err) => err.code === ERROR_CODES.INVALID_RESPONSE
  );
});

test('validateUserInfoResponse rejects a non-object response', () => {
  assert.throws(() => validateUserInfoResponse(null), (err) => err.code === ERROR_CODES.INVALID_RESPONSE);
});

// ─────────────────────────────────────────────
// exchangeCodeForToken / revokeToken — DI'd httpClient, no real network
// ─────────────────────────────────────────────

function fakeHttpClient({ tokenResponse, userInfoResponse, tokenThrows, userInfoThrows } = {}) {
  const calls = { post: [], get: [] };
  return {
    calls,
    post: async (url, body, opts) => {
      calls.post.push({ url, body, opts });
      if (tokenThrows) throw tokenThrows;
      return tokenResponse;
    },
    get: async (url, opts) => {
      calls.get.push({ url, opts });
      if (userInfoThrows) throw userInfoThrows;
      return userInfoResponse;
    },
  };
}

test('exchangeCodeForToken posts client_id/client_secret/code/redirect_uri/grant_type, then fetches userinfo with a Bearer header', async () => {
  const httpClient = fakeHttpClient({
    tokenResponse: {
      status: 200,
      data: { access_token: 'ya29.token', refresh_token: '1//refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' },
    },
    userInfoResponse: { status: 200, data: { sub: '109', email: 'alex@example.com', name: 'Alex' } },
  });
  const service = createGmailService({ httpClient });

  const result = await service.exchangeCodeForToken('the-code');

  assert.equal(httpClient.calls.post[0].url, 'https://oauth2.googleapis.com/token');
  assert.ok(httpClient.calls.post[0].body.includes('code=the-code'));
  assert.ok(httpClient.calls.post[0].body.includes('grant_type=authorization_code'));
  assert.ok(httpClient.calls.post[0].body.includes('client_secret=test-gmail-client-secret'));

  assert.equal(httpClient.calls.get[0].url, 'https://openidconnect.googleapis.com/v1/userinfo');
  assert.equal(httpClient.calls.get[0].opts.headers.Authorization, 'Bearer ya29.token');

  assert.equal(result.accessToken, 'ya29.token');
  assert.equal(result.refreshToken, '1//refresh');
  assert.equal(result.externalAccountId, '109');
  assert.equal(result.mailboxAddress, 'alex@example.com');
  assert.equal(result.displayName, 'Alex');
  assert.ok(result.expiresAt);
});

test('exchangeCodeForToken rejects a non-2xx HTTP response from the token endpoint', async () => {
  const httpClient = fakeHttpClient({ tokenResponse: { status: 400, data: { error: 'invalid_grant' } } });
  const service = createGmailService({ httpClient });
  await assert.rejects(() => service.exchangeCodeForToken('code'), (err) => err.code === ERROR_CODES.HTTP_ERROR);
});

test('exchangeCodeForToken rejects when the HTTP client throws (network error)', async () => {
  const httpClient = fakeHttpClient({ tokenThrows: new Error('ECONNRESET') });
  const service = createGmailService({ httpClient });
  await assert.rejects(() => service.exchangeCodeForToken('code'), (err) => err.code === ERROR_CODES.HTTP_ERROR);
});

test('exchangeCodeForToken rejects an invalid token response body (missing refresh_token)', async () => {
  const httpClient = fakeHttpClient({ tokenResponse: { status: 200, data: { access_token: 'a' } } });
  const service = createGmailService({ httpClient });
  await assert.rejects(() => service.exchangeCodeForToken('code'), (err) => err.code === ERROR_CODES.INVALID_RESPONSE);
});

test('exchangeCodeForToken rejects when the userinfo call fails', async () => {
  const httpClient = fakeHttpClient({
    tokenResponse: { status: 200, data: { access_token: 'a', refresh_token: 'r' } },
    userInfoThrows: new Error('network down'),
  });
  const service = createGmailService({ httpClient });
  await assert.rejects(() => service.exchangeCodeForToken('code'), (err) => err.code === ERROR_CODES.HTTP_ERROR);
});

test('exchangeCodeForToken rejects when the userinfo response is invalid', async () => {
  const httpClient = fakeHttpClient({
    tokenResponse: { status: 200, data: { access_token: 'a', refresh_token: 'r' } },
    userInfoResponse: { status: 200, data: { sub: '109' } }, // missing email
  });
  const service = createGmailService({ httpClient });
  await assert.rejects(() => service.exchangeCodeForToken('code'), (err) => err.code === ERROR_CODES.INVALID_RESPONSE);
});

test('exchangeCodeForToken never leaks the client secret in a thrown error message', async () => {
  const httpClient = fakeHttpClient({ tokenThrows: new Error('boom with secret test-gmail-client-secret leaked') });
  const service = createGmailService({ httpClient });
  try {
    await service.exchangeCodeForToken('code');
    assert.fail('expected exchangeCodeForToken to throw');
  } catch (err) {
    assert.equal(err.message.includes('test-gmail-client-secret'), false);
  }
});

test('revokeToken returns true on a successful Google revoke response', async () => {
  const httpClient = { post: async () => ({ status: 200 }) };
  const service = createGmailService({ httpClient });
  const result = await service.revokeToken('ya29.token');
  assert.equal(result, true);
});

test('revokeToken returns false (never throws) when the HTTP call fails', async () => {
  const httpClient = { post: async () => { throw new Error('network down'); } };
  const service = createGmailService({ httpClient });
  const result = await service.revokeToken('ya29.token');
  assert.equal(result, false);
});

test('revokeToken returns false for a missing token without calling the HTTP client', async () => {
  let called = false;
  const httpClient = { post: async () => { called = true; return { status: 200 }; } };
  const service = createGmailService({ httpClient });
  const result = await service.revokeToken(null);
  assert.equal(result, false);
  assert.equal(called, false);
});

test('revokeToken never puts the token in the request URL (Google\'s revoke endpoint takes it as a form body param, not a Bearer header)', async () => {
  let captured = null;
  const httpClient = { post: async (url, body, opts) => { captured = { url, body, opts }; return { status: 200 }; } };
  const service = createGmailService({ httpClient });
  await service.revokeToken('ya29.secret-token');
  assert.equal(captured.url.includes('ya29.secret-token'), false);
  assert.ok(captured.body.includes('ya29.secret-token'));
});

// ─────────────────────────────────────────────
// refreshAccessToken (EM5 — token-refresh orchestration lives in
// emailConnectionService.js's getValidGmailAccessToken; this is only the
// raw token-endpoint call)
// ─────────────────────────────────────────────

test('refreshAccessToken posts refresh_token/client_id/client_secret/grant_type and returns the new access token', async () => {
  const httpClient = {
    post: async () => ({ status: 200, data: { access_token: 'ya29.new-token', expires_in: 3600 } }),
  };
  const service = createGmailService({ httpClient });
  const result = await service.refreshAccessToken('1//old-refresh-token');
  assert.equal(result.accessToken, 'ya29.new-token');
  assert.ok(result.expiresAt);
});

test('refreshAccessToken returns refreshToken: null when Google omits a new one (caller must preserve the prior one, not null it out)', async () => {
  const httpClient = { post: async () => ({ status: 200, data: { access_token: 'ya29.new-token', expires_in: 3600 } }) };
  const service = createGmailService({ httpClient });
  const result = await service.refreshAccessToken('1//old-refresh-token');
  assert.equal(result.refreshToken, null);
});

test('refreshAccessToken returns the new refreshToken when Google does rotate it', async () => {
  const httpClient = { post: async () => ({ status: 200, data: { access_token: 'ya29.new-token', refresh_token: '1//new-refresh', expires_in: 3600 } }) };
  const service = createGmailService({ httpClient });
  const result = await service.refreshAccessToken('1//old-refresh-token');
  assert.equal(result.refreshToken, '1//new-refresh');
});

test('refreshAccessToken rejects a non-2xx response (e.g. a revoked/expired refresh token)', async () => {
  const httpClient = { post: async () => ({ status: 400, data: { error: 'invalid_grant' } }) };
  const service = createGmailService({ httpClient });
  await assert.rejects(() => service.refreshAccessToken('1//dead'), (err) => err.code === ERROR_CODES.HTTP_ERROR);
});

test('refreshAccessToken never leaks the client secret in a thrown error message', async () => {
  const httpClient = { post: async () => { throw new Error('boom with secret test-gmail-client-secret leaked'); } };
  const service = createGmailService({ httpClient });
  try {
    await service.refreshAccessToken('1//old');
    assert.fail('expected refreshAccessToken to throw');
  } catch (err) {
    assert.equal(err.message.includes('test-gmail-client-secret'), false);
  }
});

test('refreshAccessToken requires a refreshToken', async () => {
  const service = createGmailService({ httpClient: { post: async () => ({ status: 200, data: {} }) } });
  await assert.rejects(() => service.refreshAccessToken(null), /requires refreshToken/);
});

// ─────────────────────────────────────────────
// listLabels / getOrCreateManagedLabel (§10 — idempotent managed label)
// ─────────────────────────────────────────────

test('listLabels maps the labels.list response to {id, name} pairs', async () => {
  const httpClient = { get: async () => ({ status: 200, data: { labels: [{ id: 'Label_1', name: 'Relativity/Knowledge', type: 'user' }, { id: 'INBOX', name: 'INBOX', type: 'system' }] } }) };
  const service = createGmailService({ httpClient });
  const labels = await service.listLabels('token');
  assert.deepEqual(labels, [{ id: 'Label_1', name: 'Relativity/Knowledge' }, { id: 'INBOX', name: 'INBOX' }]);
});

test('getOrCreateManagedLabel reuses an existing "Relativity/Knowledge" label rather than creating a duplicate', async () => {
  const calls = { get: 0, post: 0 };
  const httpClient = {
    get: async () => { calls.get++; return { status: 200, data: { labels: [{ id: 'Label_42', name: MANAGED_LABEL_NAME }] } }; },
    post: async () => { calls.post++; throw new Error('should not be called'); },
  };
  const service = createGmailService({ httpClient });
  const result = await service.getOrCreateManagedLabel('token');
  assert.deepEqual(result, { labelId: 'Label_42', created: false });
  assert.equal(calls.post, 0);
});

test('getOrCreateManagedLabel creates the label when it does not already exist', async () => {
  const httpClient = {
    get: async () => ({ status: 200, data: { labels: [{ id: 'INBOX', name: 'INBOX' }] } }),
    post: async (url, body) => {
      assert.equal(body.name, MANAGED_LABEL_NAME);
      return { status: 200, data: { id: 'Label_99', name: MANAGED_LABEL_NAME } };
    },
  };
  const service = createGmailService({ httpClient });
  const result = await service.getOrCreateManagedLabel('token');
  assert.deepEqual(result, { labelId: 'Label_99', created: true });
});

test('getOrCreateManagedLabel surfaces a create failure as a GMAIL_HTTP_ERROR', async () => {
  const httpClient = {
    get: async () => ({ status: 200, data: { labels: [] } }),
    post: async () => ({ status: 500, data: {} }),
  };
  const service = createGmailService({ httpClient });
  await assert.rejects(() => service.getOrCreateManagedLabel('token'), (err) => err.code === ERROR_CODES.HTTP_ERROR);
});

// ─────────────────────────────────────────────
// listMessageIdsByQuery / getMessageMetadata (§14.1 preview, §17)
// ─────────────────────────────────────────────

test('listMessageIdsByQuery returns bare message ids and passes q/maxResults/pageToken through', async () => {
  let captured;
  const httpClient = {
    get: async (url) => {
      captured = url;
      return { status: 200, data: { messages: [{ id: 'msg-1' }, { id: 'msg-2' }], nextPageToken: 'page-2' } };
    },
  };
  const service = createGmailService({ httpClient });
  const result = await service.listMessageIdsByQuery({ accessToken: 'token', query: 'label:Relativity/Knowledge', pageToken: 'page-1', maxResults: 10 });
  assert.deepEqual(result, { messageIds: ['msg-1', 'msg-2'], nextPageToken: 'page-2' });
  assert.ok(captured.includes('pageToken=page-1'));
  assert.ok(captured.includes('maxResults=10'));
});

test('listMessageIdsByQuery short-circuits to an empty result without a network call when query is null (fail-closed — §16.1 item 6)', async () => {
  let called = false;
  const httpClient = { get: async () => { called = true; return { status: 200, data: {} }; } };
  const service = createGmailService({ httpClient });
  const result = await service.listMessageIdsByQuery({ accessToken: 'token', query: null });
  assert.deepEqual(result, { messageIds: [], nextPageToken: null });
  assert.equal(called, false);
});

test('listMessageIdsByQuery returns an empty array (not a throw) when the response has no messages field (Gmail omits it for a zero-result query)', async () => {
  const httpClient = { get: async () => ({ status: 200, data: {} }) };
  const service = createGmailService({ httpClient });
  const result = await service.listMessageIdsByQuery({ accessToken: 'token', query: 'label:Nothing' });
  assert.deepEqual(result, { messageIds: [], nextPageToken: null });
});

test('getMessageMetadata parses subject/from/date headers, extracts a bare email address, and never fetches the body', async () => {
  let capturedUrl;
  const httpClient = {
    get: async (url) => {
      capturedUrl = url;
      return {
        status: 200,
        data: {
          labelIds: ['INBOX', 'Label_42'],
          payload: { headers: [
            { name: 'Subject', value: 'Q3 Invoice' },
            { name: 'From', value: 'Alex Doe <alex@example.com>' },
            { name: 'Date', value: 'Mon, 1 Jan 2026 00:00:00 +0000' },
          ] },
        },
      };
    },
  };
  const service = createGmailService({ httpClient });
  const result = await service.getMessageMetadata({ accessToken: 'token', messageId: 'msg-1' });
  assert.equal(result.subject, 'Q3 Invoice');
  assert.equal(result.fromAddress, 'alex@example.com');
  assert.ok(result.date);
  assert.deepEqual(result.labelIds, ['INBOX', 'Label_42']);
  assert.equal(result.isSent, false);
  assert.ok(capturedUrl.includes('format=metadata'));
  assert.equal(capturedUrl.includes('format=full'), false);
});

test('getMessageMetadata reports isSent: true when labelIds includes SENT', async () => {
  const httpClient = { get: async () => ({ status: 200, data: { labelIds: ['SENT'], payload: { headers: [] } } }) };
  const service = createGmailService({ httpClient });
  const result = await service.getMessageMetadata({ accessToken: 'token', messageId: 'msg-1' });
  assert.equal(result.isSent, true);
});

// ─────────────────────────────────────────────
// extractEmailAddress / parseMessageHeaders — pure
// ─────────────────────────────────────────────

test('extractEmailAddress pulls the address out of a "Display Name <addr>" header', () => {
  assert.equal(extractEmailAddress('Alex Doe <alex@example.com>'), 'alex@example.com');
});

test('extractEmailAddress accepts a bare address with no display name', () => {
  assert.equal(extractEmailAddress('alex@example.com'), 'alex@example.com');
});

test('extractEmailAddress lowercases the result', () => {
  assert.equal(extractEmailAddress('Alex Doe <Alex@Example.COM>'), 'alex@example.com');
});

test('extractEmailAddress returns null for an unparseable or missing value', () => {
  assert.equal(extractEmailAddress(''), null);
  assert.equal(extractEmailAddress(null), null);
  assert.equal(extractEmailAddress('not an address'), null);
});

// ─────────────────────────────────────────────
// compileSearchQuery — pure (§10, §17, §14.1)
// ─────────────────────────────────────────────

test('compileSearchQuery for manual_selected mode is always exactly label:Relativity/Knowledge -in:chats, regardless of policy rules', () => {
  const rules = [{ ruleType: 'allow', labelOrFolder: 'finance', enabled: true }];
  assert.equal(compileSearchQuery({ mode: 'manual_selected', rules }), 'label:Relativity/Knowledge -in:chats');
  assert.equal(compileSearchQuery({ mode: 'manual_selected', rules: [] }), 'label:Relativity/Knowledge -in:chats');
});

test('compileSearchQuery for automatic mode ORs together each enabled allow rule\'s label/sender criteria', () => {
  const rules = [
    { ruleType: 'allow', enabled: true, labelOrFolder: 'finance', senderPattern: null },
    { ruleType: 'allow', enabled: true, labelOrFolder: null, senderPattern: '@client.com' },
  ];
  const query = compileSearchQuery({ mode: 'automatic', rules });
  assert.equal(query, '(label:finance) OR (from:@client.com) -in:chats');
});

test('compileSearchQuery for automatic mode never compiles deny rules into the query (deny is local-only, §10 item 4)', () => {
  const rules = [
    { ruleType: 'allow', enabled: true, labelOrFolder: 'finance' },
    { ruleType: 'deny', enabled: true, labelOrFolder: 'finance/payroll' },
  ];
  const query = compileSearchQuery({ mode: 'automatic', rules });
  assert.equal(query.includes('payroll'), false);
});

test('compileSearchQuery for automatic mode skips disabled allow rules', () => {
  const rules = [
    { ruleType: 'allow', enabled: false, labelOrFolder: 'finance' },
    { ruleType: 'allow', enabled: true, senderPattern: '@client.com' },
  ];
  const query = compileSearchQuery({ mode: 'automatic', rules });
  assert.equal(query, 'from:@client.com -in:chats');
});

test('compileSearchQuery for automatic mode returns null when there are zero enabled allow rules (fail-closed, §16.1 item 6) — callers must not list the whole mailbox', () => {
  assert.equal(compileSearchQuery({ mode: 'automatic', rules: [] }), null);
  assert.equal(compileSearchQuery({ mode: 'automatic', rules: [{ ruleType: 'deny', enabled: true, labelOrFolder: 'x' }] }), null);
});

test('compileSearchQuery for automatic mode returns null when every allow rule has neither a compilable label nor sender criterion (e.g. subject-only rules, not query-compilable in the MVP)', () => {
  const rules = [{ ruleType: 'allow', enabled: true, labelOrFolder: null, senderPattern: null, subjectKeyword: 'invoice' }];
  assert.equal(compileSearchQuery({ mode: 'automatic', rules }), null);
});

// ─────────────────────────────────────────────
// getMessageBody / extractBodyParts / decodeBase64Url (EM6 — §19)
// ─────────────────────────────────────────────

const { decodeBase64Url, extractBodyParts } = require('../services/gmailService');

function toBase64Url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('decodeBase64Url decodes Gmail\'s url-safe, unpadded base64 encoding', () => {
  const encoded = toBase64Url('Hello, world! ünïcödé');
  assert.equal(decodeBase64Url(encoded), 'Hello, world! ünïcödé');
});

test('decodeBase64Url returns empty string for missing/empty input', () => {
  assert.equal(decodeBase64Url(''), '');
  assert.equal(decodeBase64Url(undefined), '');
});

test('extractBodyParts reads a simple single-part text/plain message', () => {
  const payload = { mimeType: 'text/plain', body: { data: toBase64Url('Plain body text.') } };
  const { html, text } = extractBodyParts(payload);
  assert.equal(text, 'Plain body text.');
  assert.equal(html, null);
});

test('extractBodyParts finds text/plain and text/html inside a multipart/alternative payload', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: toBase64Url('Plain version.') } },
      { mimeType: 'text/html', body: { data: toBase64Url('<p>HTML version.</p>') } },
    ],
  };
  const { html, text } = extractBodyParts(payload);
  assert.equal(text, 'Plain version.');
  assert.equal(html, '<p>HTML version.</p>');
});

test('extractBodyParts recurses into nested multipart/mixed > multipart/alternative (attachments alongside a body)', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: toBase64Url('Nested plain body.') } },
          { mimeType: 'text/html', body: { data: toBase64Url('<p>Nested HTML body.</p>') } },
        ],
      },
      { mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'att-1' } },
    ],
  };
  const { html, text } = extractBodyParts(payload);
  assert.equal(text, 'Nested plain body.');
  assert.equal(html, '<p>Nested HTML body.</p>');
});

test('extractBodyParts never treats a filenamed part as a body, even if it claims a text/* MIME type', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', filename: 'notes.txt', body: { attachmentId: 'att-1' } },
      { mimeType: 'text/plain', body: { data: toBase64Url('Real body.') } },
    ],
  };
  const { text } = extractBodyParts(payload);
  assert.equal(text, 'Real body.');
});

test('extractBodyParts returns nulls for an empty/missing payload', () => {
  assert.deepEqual(extractBodyParts(null), { html: null, text: null });
  assert.deepEqual(extractBodyParts({}), { html: null, text: null });
});

test('getMessageBody requests format=full and returns decoded html/text, never a raw base64 blob', async () => {
  const rawHtml = '<p>Body content.</p>';
  const httpClient = {
    get: async (url) => {
      assert.match(url, /format=full/);
      return {
        status: 200,
        data: {
          payload: {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: toBase64Url('Body content.') } },
              { mimeType: 'text/html', body: { data: toBase64Url(rawHtml) } },
            ],
          },
        },
      };
    },
  };
  const service = createGmailService({ httpClient });
  const result = await service.getMessageBody({ accessToken: 'token', messageId: 'msg-1' });
  assert.equal(result.text, 'Body content.');
  assert.equal(result.html, rawHtml);
  assert.equal(result.messageId, 'msg-1');
});

test('getMessageBody throws GMAIL_HTTP_ERROR on a non-2xx response', async () => {
  const httpClient = { get: async () => ({ status: 404, data: {} }) };
  const service = createGmailService({ httpClient });
  await assert.rejects(
    () => service.getMessageBody({ accessToken: 'token', messageId: 'missing' }),
    (err) => err.code === ERROR_CODES.HTTP_ERROR
  );
});

test('getMessageBody requires accessToken and messageId', async () => {
  const service = createGmailService({ httpClient: { get: async () => ({ status: 200, data: {} }) } });
  await assert.rejects(() => service.getMessageBody({ messageId: 'msg-1' }));
  await assert.rejects(() => service.getMessageBody({ accessToken: 'token' }));
});
