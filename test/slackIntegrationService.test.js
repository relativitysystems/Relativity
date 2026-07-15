const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlackIntegrationService, mapSlackStatusResponse, REDIRECT } = require('../services/slackIntegrationService');

const ACTIVE_CLIENT = { id: 'client-a', is_active: true };
const ACTIVE_ADMIN_MEMBER = { id: 'member-a', client_id: 'client-a', role: 'admin', status: 'active' };

function makeFakes(overrides = {}) {
  const calls = {
    generateAndStoreState: [],
    consumeState: [],
    exchangeCodeForToken: [],
    createOrReplaceConnection: [],
    revokeToken: [],
    markConnectionRevoked: [],
    upsertToken: [],
    updateClientSlackChannel: [],
  };

  const oauthStateService = {
    generateAndStoreState: async (args) => {
      calls.generateAndStoreState.push(args);
      return overrides.generateAndStoreState
        ? overrides.generateAndStoreState(args)
        : { rawState: 'raw-state-value', expiresAt: new Date(Date.now() + 600000).toISOString() };
    },
    consumeState: async (args) => {
      calls.consumeState.push(args);
      if (overrides.consumeState) return overrides.consumeState(args);
      return { status: 'consumed', clientId: 'client-a', memberId: 'member-a', redirectAfter: null };
    },
  };

  const slackService = {
    isSlackConfigured: overrides.isSlackConfigured || (() => true),
    buildAuthorizationUrl: overrides.buildAuthorizationUrl || (({ state }) => `https://slack.com/oauth/v2/authorize?state=${state}`),
    exchangeCodeForToken: async (code) => {
      calls.exchangeCodeForToken.push(code);
      if (overrides.exchangeCodeForToken) return overrides.exchangeCodeForToken(code);
      return {
        accessToken: 'xoxb-real-token',
        team: { id: 'T123', name: 'Acme Corp' },
        enterprise: null,
        botUserId: 'U123',
        appId: 'A123',
        tokenType: 'bot',
        scopes: ['app_mentions:read', 'chat:write'],
      };
    },
    revokeToken: async (token) => {
      calls.revokeToken.push(token);
      return overrides.revokeToken ? overrides.revokeToken(token) : true;
    },
  };

  const oauthConnectionsService = {
    createOrReplaceConnection: async (args) => {
      calls.createOrReplaceConnection.push(args);
      if (overrides.createOrReplaceConnection) return overrides.createOrReplaceConnection(args);
      return { connected: true, provider: 'slack' };
    },
    getActiveConnectionForClient: async (clientId, provider) => {
      if (overrides.getActiveConnectionForClient) return overrides.getActiveConnectionForClient(clientId, provider);
      return null;
    },
    getDecryptedCredentialForConnection: async (connectionId) => {
      if (overrides.getDecryptedCredentialForConnection) return overrides.getDecryptedCredentialForConnection(connectionId);
      return { accessToken: 'xoxb-decrypted-token', refreshToken: null, expiresAt: null };
    },
    markConnectionRevoked: async (clientId, provider) => {
      calls.markConnectionRevoked.push({ clientId, provider });
      return { revoked: true };
    },
  };

  const supabaseService = {
    getClientById: async (clientId) => {
      if (overrides.getClientById) return overrides.getClientById(clientId);
      return clientId === 'client-a' ? ACTIVE_CLIENT : null;
    },
    getClientMemberById: async (memberId, clientId) => {
      if (overrides.getClientMemberById) return overrides.getClientMemberById(memberId, clientId);
      return memberId === 'member-a' && clientId === 'client-a' ? ACTIVE_ADMIN_MEMBER : null;
    },
    // Legacy plaintext path — must NEVER be called by the new Slack flow.
    upsertToken: async (...args) => {
      calls.upsertToken.push(args);
      throw new Error('legacy upsertToken must never be called by the new Slack OAuth flow');
    },
    updateClientSlackChannel: async (...args) => {
      calls.updateClientSlackChannel.push(args);
      throw new Error('legacy updateClientSlackChannel must never be called by the new Slack OAuth flow');
    },
  };

  const service = createSlackIntegrationService({ oauthStateService, slackService, oauthConnectionsService, supabaseService });
  return { service, calls };
}

// ─────────────────────────────────────────────
// startConnection
// ─────────────────────────────────────────────

test('startConnection generates state bound to the caller and builds the authorization URL from it', async () => {
  const { service, calls } = makeFakes();
  const { url } = await service.startConnection({ clientId: 'client-a', memberId: 'member-a' });

  assert.equal(calls.generateAndStoreState.length, 1);
  assert.equal(calls.generateAndStoreState[0].clientId, 'client-a');
  assert.equal(calls.generateAndStoreState[0].memberId, 'member-a');
  assert.equal(calls.generateAndStoreState[0].provider, 'slack');
  assert.ok(url.includes('raw-state-value'));
});

test('startConnection throws SLACK_NOT_CONFIGURED when Slack env is missing, before generating any state', async () => {
  const { service, calls } = makeFakes({ isSlackConfigured: () => false });
  await assert.rejects(
    () => service.startConnection({ clientId: 'client-a', memberId: 'member-a' }),
    (err) => err.code === 'SLACK_NOT_CONFIGURED'
  );
  assert.equal(calls.generateAndStoreState.length, 0);
});

// ─────────────────────────────────────────────
// handleCallback — rejection paths
// ─────────────────────────────────────────────

test('Slack denial (error param present) redirects to the safe access_denied path without touching state', async () => {
  const { service, calls } = makeFakes();
  const result = await service.handleCallback({ code: null, state: null, error: 'access_denied' });
  assert.equal(result.redirectPath, REDIRECT.DENIED);
  assert.equal(calls.consumeState.length, 0);
});

test('missing code is rejected as invalid_state', async () => {
  const { service } = makeFakes();
  const result = await service.handleCallback({ code: null, state: 'some-state', error: null });
  assert.equal(result.redirectPath, REDIRECT.INVALID_STATE);
});

test('missing state is rejected as invalid_state', async () => {
  const { service } = makeFakes();
  const result = await service.handleCallback({ code: 'some-code', state: null, error: null });
  assert.equal(result.redirectPath, REDIRECT.INVALID_STATE);
});

test('unknown state redirects to invalid_state', async () => {
  const { service } = makeFakes({ consumeState: async () => ({ status: 'not_found' }) });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.INVALID_STATE);
});

test('reused state redirects to invalid_state', async () => {
  const { service } = makeFakes({ consumeState: async () => ({ status: 'reused' }) });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.INVALID_STATE);
});

test('provider-mismatched state redirects to invalid_state', async () => {
  const { service } = makeFakes({ consumeState: async () => ({ status: 'provider_mismatch' }) });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.INVALID_STATE);
});

test('expired state redirects to expired_state (distinct from invalid_state)', async () => {
  const { service } = makeFakes({ consumeState: async () => ({ status: 'expired' }) });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.EXPIRED_STATE);
});

test('a deactivated (non-active status) member is rejected as connection_failed and never reaches Slack token exchange', async () => {
  const { service, calls } = makeFakes({
    getClientMemberById: async () => ({ id: 'member-a', client_id: 'client-a', role: 'admin', status: 'disabled' }),
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
  assert.equal(calls.exchangeCodeForToken.length, 0);
});

test('a member who lost owner/admin role (e.g. demoted to member) is rejected as connection_failed', async () => {
  const { service, calls } = makeFakes({
    getClientMemberById: async () => ({ id: 'member-a', client_id: 'client-a', role: 'member', status: 'active' }),
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
  assert.equal(calls.exchangeCodeForToken.length, 0);
});

test('an inactive organization is rejected as connection_failed', async () => {
  const { service } = makeFakes({ getClientById: async () => ({ id: 'client-a', is_active: false }) });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
});

test('a Slack ok:false / exchange failure redirects to connection_failed', async () => {
  const { service } = makeFakes({
    exchangeCodeForToken: async () => { const e = new Error('oauth failed'); e.code = 'SLACK_OAUTH_FAILED'; throw e; },
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
});

test('a missing bot token / team id from Slack (surfaced as a validation throw) redirects to connection_failed', async () => {
  const { service } = makeFakes({
    exchangeCodeForToken: async () => { const e = new Error('missing team id'); e.code = 'SLACK_INVALID_RESPONSE'; throw e; },
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
});

test('a connection-persist failure redirects to connection_failed', async () => {
  const { service } = makeFakes({
    createOrReplaceConnection: async () => { throw new Error('createOrReplaceConnection failed: simulated'); },
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
});

// ─────────────────────────────────────────────
// handleCallback — success path
// ─────────────────────────────────────────────

test('a fully valid callback persists the connection with the expected metadata shape and redirects to success', async () => {
  const { service, calls } = makeFakes();
  const result = await service.handleCallback({ code: 'the-code', state: 'the-state', error: null });

  assert.equal(result.redirectPath, REDIRECT.SUCCESS);
  assert.equal(calls.createOrReplaceConnection.length, 1);

  const args = calls.createOrReplaceConnection[0];
  assert.equal(args.clientId, 'client-a');
  assert.equal(args.provider, 'slack');
  assert.equal(args.externalAccountId, 'T123');
  assert.equal(args.externalAccountName, 'Acme Corp');
  assert.deepEqual(args.scopesGranted, ['app_mentions:read', 'chat:write']);
  assert.equal(args.connectedByMemberId, 'member-a');
  assert.equal(args.accessToken, 'xoxb-real-token');
  assert.deepEqual(args.providerMetadata, {
    team_id: 'T123',
    team_name: 'Acme Corp',
    enterprise_id: null,
    enterprise_name: null,
    bot_user_id: 'U123',
    app_id: 'A123',
    token_type: 'bot',
  });
});

test('the successful-callback code path never calls legacy upsertToken or updateClientSlackChannel', async () => {
  const { service, calls } = makeFakes();
  await service.handleCallback({ code: 'the-code', state: 'the-state', error: null });
  assert.equal(calls.upsertToken.length, 0);
  assert.equal(calls.updateClientSlackChannel.length, 0);
});

test('handleCallback never throws for any input — every branch resolves to a redirect path', async () => {
  const { service } = makeFakes({ exchangeCodeForToken: async () => { throw new Error('boom'); } });
  await assert.doesNotReject(() => service.handleCallback({ code: 'c', state: 's', error: null }));
});

test('handleCallback never leaks the raw code, state, or access token into the returned redirect path', async () => {
  const { service } = makeFakes();
  const result = await service.handleCallback({ code: 'super-secret-code', state: 'super-secret-state', error: null });
  assert.equal(result.redirectPath.includes('super-secret-code'), false);
  assert.equal(result.redirectPath.includes('super-secret-state'), false);
  assert.equal(result.redirectPath.includes('xoxb-real-token'), false);
});

// ─────────────────────────────────────────────
// mapSlackStatusResponse / getStatus
// ─────────────────────────────────────────────

test('mapSlackStatusResponse: disconnected shape when there is no active connection', () => {
  assert.deepEqual(mapSlackStatusResponse(null), { connected: false, provider: 'slack' });
});

test('mapSlackStatusResponse: connected shape allowlists exactly the documented fields from provider_metadata', () => {
  const row = {
    status: 'active',
    external_account_id: 'T123',
    external_account_name: 'Example Workspace',
    scopes_granted: ['app_mentions:read', 'chat:write'],
    connected_at: '2026-07-14T00:00:00.000Z',
    provider_metadata: { bot_user_id: 'U123', team_id: 'T123', app_id: 'A123', some_future_field: 'must-not-leak' },
  };
  const safe = mapSlackStatusResponse(row);
  assert.deepEqual(safe, {
    connected: true,
    provider: 'slack',
    workspaceId: 'T123',
    workspaceName: 'Example Workspace',
    botUserId: 'U123',
    scopes: ['app_mentions:read', 'chat:write'],
    status: 'active',
    connectedAt: '2026-07-14T00:00:00.000Z',
  });
  assert.equal('some_future_field' in safe, false);
  assert.equal('provider_metadata' in safe, false);
});

test('mapSlackStatusResponse never includes any credential-related field', () => {
  const row = {
    status: 'active',
    external_account_id: 'T1',
    external_account_name: 'Acme',
    scopes_granted: [],
    connected_at: '2026-07-14T00:00:00Z',
    provider_metadata: {},
    // Simulates an accidental join/select mistake — must never leak through.
    access_token_encrypted: { ciphertext: 'should-never-appear' },
  };
  const safe = mapSlackStatusResponse(row);
  for (const key of ['access_token', 'refresh_token', 'access_token_encrypted', 'accessToken', 'ciphertext', 'iv', 'authTag']) {
    assert.equal(key in safe, false, `must not include "${key}"`);
  }
});

test('getStatus is organization-scoped and returns the safe mapped shape', async () => {
  const { service } = makeFakes({
    getActiveConnectionForClient: async (clientId, provider) => {
      assert.equal(clientId, 'client-a');
      assert.equal(provider, 'slack');
      return {
        status: 'active',
        external_account_id: 'T123',
        external_account_name: 'Acme',
        scopes_granted: ['chat:write'],
        connected_at: '2026-07-14T00:00:00Z',
        provider_metadata: { bot_user_id: 'U1' },
      };
    },
  });
  const status = await service.getStatus({ clientId: 'client-a' });
  assert.equal(status.connected, true);
  assert.equal(status.workspaceId, 'T123');
});

test('getStatus for a client with no connection returns the disconnected shape', async () => {
  const { service } = makeFakes({ getActiveConnectionForClient: async () => null });
  const status = await service.getStatus({ clientId: 'client-a' });
  assert.deepEqual(status, { connected: false, provider: 'slack' });
});

// ─────────────────────────────────────────────
// disconnect
// ─────────────────────────────────────────────

test('disconnect with no active connection is idempotent — returns safe success without calling revoke', async () => {
  const { service, calls } = makeFakes({ getActiveConnectionForClient: async () => null });
  const result = await service.disconnect({ clientId: 'client-a' });
  assert.deepEqual(result, { disconnected: true });
  assert.equal(calls.revokeToken.length, 0);
  assert.equal(calls.markConnectionRevoked.length, 0);
});

test('disconnect decrypts the token server-side, attempts best-effort provider revocation, and marks the connection revoked', async () => {
  const { service, calls } = makeFakes({
    getActiveConnectionForClient: async () => ({ id: 'conn-1', status: 'active' }),
  });
  const result = await service.disconnect({ clientId: 'client-a' });
  assert.deepEqual(result, { disconnected: true });
  assert.equal(calls.revokeToken.length, 1);
  assert.equal(calls.revokeToken[0], 'xoxb-decrypted-token');
  assert.equal(calls.markConnectionRevoked.length, 1);
  assert.deepEqual(calls.markConnectionRevoked[0], { clientId: 'client-a', provider: 'slack' });
});

test('disconnect still marks the connection revoked locally even when Slack revocation fails', async () => {
  const { service, calls } = makeFakes({
    getActiveConnectionForClient: async () => ({ id: 'conn-1', status: 'active' }),
    revokeToken: async () => false,
  });
  const result = await service.disconnect({ clientId: 'client-a' });
  assert.deepEqual(result, { disconnected: true });
  assert.equal(calls.markConnectionRevoked.length, 1);
});

test('disconnect never returns the access token in its response', async () => {
  const { service } = makeFakes({ getActiveConnectionForClient: async () => ({ id: 'conn-1', status: 'active' }) });
  const result = await service.disconnect({ clientId: 'client-a' });
  assert.equal(JSON.stringify(result).includes('xoxb'), false);
  assert.deepEqual(Object.keys(result), ['disconnected']);
});

test('disconnect is organization-scoped — only the given clientId\'s connection is ever queried', async () => {
  const { service } = makeFakes({
    getActiveConnectionForClient: async (clientId) => {
      assert.equal(clientId, 'client-b');
      return null;
    },
  });
  await service.disconnect({ clientId: 'client-b' });
});

test('a repeated disconnect call is idempotent', async () => {
  let connectionActive = true;
  const { service } = makeFakes({
    getActiveConnectionForClient: async () => (connectionActive ? { id: 'conn-1', status: 'active' } : null),
  });
  // First call revokes it (simulated externally by flipping the flag after).
  const first = await service.disconnect({ clientId: 'client-a' });
  connectionActive = false;
  const second = await service.disconnect({ clientId: 'client-a' });
  assert.deepEqual(first, { disconnected: true });
  assert.deepEqual(second, { disconnected: true });
});
