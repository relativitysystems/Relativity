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
  REQUIRED_SCOPES,
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

test('buildAuthorizationUrl requests exactly gmail.readonly + openid + email + profile — nothing more, nothing less', () => {
  const url = new URL(buildAuthorizationUrl({ state: 's' }));
  const scopes = url.searchParams.get('scope').split(' ');
  const expected = ['https://www.googleapis.com/auth/gmail.readonly', 'openid', 'email', 'profile'];
  assert.deepEqual(scopes.sort(), expected.sort());
  assert.deepEqual(REQUIRED_SCOPES.sort(), expected.sort());
});

test('buildAuthorizationUrl never requests gmail.labels, gmail.modify, or gmail.compose', () => {
  const url = new URL(buildAuthorizationUrl({ state: 's' }));
  const scopeParam = url.searchParams.get('scope');
  for (const forbidden of ['gmail.labels', 'gmail.modify', 'gmail.compose', 'gmail.send']) {
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
