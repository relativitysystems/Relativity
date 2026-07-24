const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmailConnectionService, mapGmailConnectionResponse, canDisconnectConnection, REDIRECT, PROVIDER } = require('../services/emailConnectionService');

const ACTIVE_CLIENT = { id: 'client-a', is_active: true };
const ACTIVE_MEMBER_A = { id: 'member-a', client_id: 'client-a', role: 'member', status: 'active' };
const ACTIVE_MEMBER_B = { id: 'member-b', client_id: 'client-a', role: 'member', status: 'active' };

const MEMBERS_BY_ID = { 'member-a': ACTIVE_MEMBER_A, 'member-b': ACTIVE_MEMBER_B };

function makeFakes(overrides = {}) {
  const calls = {
    generateAndStoreState: [],
    consumeState: [],
    exchangeCodeForToken: [],
    createOrReplaceConnection: [],
    getActiveConnectionForClientAndMember: [],
    revokeToken: [],
    markConnectionRevokedForMember: [],
    upsertConnection: [],
    getByOauthConnectionId: [],
    getConnectionById: [],
    updateSyncMode: [],
    getSettings: [],
  };

  // In-memory model of oauth_connections rows, keyed by connectionId, so
  // createOrReplaceConnection's effect is visible to the immediately
  // following getActiveConnectionForClientAndMember call within the same
  // test — mirrors the real two-step read-after-write handleCallback does.
  const connectionsStore = new Map();
  let nextConnectionId = 1;

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

  const gmailService = {
    isGmailConfigured: overrides.isGmailConfigured || (() => true),
    buildAuthorizationUrl: overrides.buildAuthorizationUrl || (({ state }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
    exchangeCodeForToken: async (code) => {
      calls.exchangeCodeForToken.push(code);
      if (overrides.exchangeCodeForToken) return overrides.exchangeCodeForToken(code);
      return {
        accessToken: 'ya29.real-access-token',
        refreshToken: '1//real-refresh-token',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'openid', 'email', 'profile'],
        externalAccountId: '109876543210',
        mailboxAddress: 'alex@example.com',
        displayName: 'Alex Doe',
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
      // Mirrors replace_active_oauth_connection's real, EM1-migrated behavior
      // for gmail/microsoft: revoke this SAME member's prior active row
      // before inserting the new one — scoped by (clientId, provider,
      // connectedByMemberId), never touching a different member's row.
      for (const row of connectionsStore.values()) {
        if (row.client_id === args.clientId && row.provider === args.provider && row.connected_by_member_id === args.connectedByMemberId && row.status === 'active') {
          row.status = 'revoked';
        }
      }
      const id = `conn-${nextConnectionId++}`;
      const row = {
        id,
        client_id: args.clientId,
        provider: args.provider,
        connected_by_member_id: args.connectedByMemberId,
        status: 'active',
        connected_at: new Date().toISOString(),
      };
      connectionsStore.set(id, row);
      return { connected: true, provider: args.provider }; // safe shape — deliberately no id, see emailConnectionService.js
    },
    getActiveConnectionForClientAndMember: async (clientId, provider, memberId) => {
      calls.getActiveConnectionForClientAndMember.push({ clientId, provider, memberId });
      if (overrides.getActiveConnectionForClientAndMember) return overrides.getActiveConnectionForClientAndMember(clientId, provider, memberId);
      for (const row of connectionsStore.values()) {
        if (row.client_id === clientId && row.provider === provider && row.connected_by_member_id === memberId && row.status === 'active') {
          return row;
        }
      }
      return null;
    },
    listActiveConnectionsForClient: async (clientId, provider) => {
      if (overrides.listActiveConnectionsForClient) return overrides.listActiveConnectionsForClient(clientId, provider);
      return [...connectionsStore.values()].filter((r) => r.client_id === clientId && r.provider === provider && r.status === 'active');
    },
    getConnectionById: async (connectionId) => {
      calls.getConnectionById.push(connectionId);
      if (overrides.getConnectionById) return overrides.getConnectionById(connectionId);
      return connectionsStore.get(connectionId) || null;
    },
    getDecryptedCredentialForConnection: async (connectionId) => {
      if (overrides.getDecryptedCredentialForConnection) return overrides.getDecryptedCredentialForConnection(connectionId);
      return { accessToken: 'ya29.decrypted-token', refreshToken: null, expiresAt: null };
    },
    markConnectionRevokedForMember: async (clientId, provider, memberId) => {
      calls.markConnectionRevokedForMember.push({ clientId, provider, memberId });
      for (const row of connectionsStore.values()) {
        if (row.client_id === clientId && row.provider === provider && row.connected_by_member_id === memberId) {
          row.status = 'revoked';
        }
      }
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
      return clientId === 'client-a' ? (MEMBERS_BY_ID[memberId] || null) : null;
    },
  };

  const emailConnectionsRepo = {
    upsertConnection: async (args) => {
      calls.upsertConnection.push(args);
      if (overrides.upsertConnection) return overrides.upsertConnection(args);
      return {
        client_id: args.clientId,
        member_id: args.memberId,
        oauth_connection_id: args.oauthConnectionId,
        provider: args.provider,
        mailbox_address: args.mailboxAddress,
        display_name: args.displayName,
        sync_mode: 'manual_selected',
        sync_enabled: true,
        historical_import_status: 'not_started',
      };
    },
    getByOauthConnectionId: async (oauthConnectionId) => {
      calls.getByOauthConnectionId.push(oauthConnectionId);
      if (overrides.getByOauthConnectionId) return overrides.getByOauthConnectionId(oauthConnectionId);
      return {
        oauth_connection_id: oauthConnectionId,
        mailbox_address: 'alex@example.com',
        display_name: 'Alex Doe',
        sync_mode: 'manual_selected',
        sync_enabled: true,
        historical_import_status: 'not_started',
      };
    },
    // EM4 — POST /connections/:id/sync-mode. `null` return models "no
    // email_connections row exists for this oauth_connection_id" (should be
    // unreachable in production once EM2's connect flow has run, but
    // updateSyncMode still treats it as CONNECTION_NOT_FOUND rather than
    // assuming the row exists).
    updateSyncMode: async (oauthConnectionId, syncMode) => {
      calls.updateSyncMode.push({ oauthConnectionId, syncMode });
      if (overrides.updateSyncMode) return overrides.updateSyncMode(oauthConnectionId, syncMode);
      return { oauth_connection_id: oauthConnectionId, sync_mode: syncMode };
    },
  };

  const emailPolicyService = {
    getSettings: async (clientId) => {
      calls.getSettings.push(clientId);
      if (overrides.getSettings) return overrides.getSettings(clientId);
      return { automaticSyncEnabled: false, updatedByMemberId: null, updatedAt: null };
    },
  };

  const service = createEmailConnectionService({
    oauthStateService, gmailService, oauthConnectionsService, supabaseService, emailConnectionsRepo, emailPolicyService,
  });
  return { service, calls, connectionsStore };
}

// ─────────────────────────────────────────────
// startConnection
// ─────────────────────────────────────────────

test('startConnection generates state bound to the caller and builds the authorization URL from it', async () => {
  const { service, calls } = makeFakes();
  const { url } = await service.startConnection({ clientId: 'client-a', memberId: 'member-a', provider: 'gmail' });

  assert.equal(calls.generateAndStoreState.length, 1);
  assert.equal(calls.generateAndStoreState[0].clientId, 'client-a');
  assert.equal(calls.generateAndStoreState[0].memberId, 'member-a');
  assert.equal(calls.generateAndStoreState[0].provider, 'gmail');
  assert.ok(url.includes('raw-state-value'));
});

test('startConnection throws GMAIL_NOT_CONFIGURED when Gmail env is missing, before generating any state', async () => {
  const { service, calls } = makeFakes({ isGmailConfigured: () => false });
  await assert.rejects(
    () => service.startConnection({ clientId: 'client-a', memberId: 'member-a', provider: 'gmail' }),
    (err) => err.code === 'GMAIL_NOT_CONFIGURED'
  );
  assert.equal(calls.generateAndStoreState.length, 0);
});

test('startConnection rejects an unsupported provider', async () => {
  const { service } = makeFakes();
  await assert.rejects(
    () => service.startConnection({ clientId: 'client-a', memberId: 'member-a', provider: 'microsoft' }),
    /unsupported provider/
  );
});

// ─────────────────────────────────────────────
// handleCallback — rejection paths
// ─────────────────────────────────────────────

test('Gmail denial (error param present) redirects to the safe access_denied path without touching state', async () => {
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

test('unknown/reused/provider-mismatched state redirects to invalid_state', async () => {
  for (const status of ['not_found', 'reused', 'provider_mismatch']) {
    const { service } = makeFakes({ consumeState: async () => ({ status }) });
    const result = await service.handleCallback({ code: 'c', state: 's', error: null });
    assert.equal(result.redirectPath, REDIRECT.INVALID_STATE, `status ${status} should map to INVALID_STATE`);
  }
});

test('expired state redirects to expired_state (distinct from invalid_state)', async () => {
  const { service } = makeFakes({ consumeState: async () => ({ status: 'expired' }) });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.EXPIRED_STATE);
});

test('a deactivated (non-active status) member is rejected as connection_failed and never reaches Gmail token exchange', async () => {
  const { service, calls } = makeFakes({
    getClientMemberById: async () => ({ id: 'member-a', client_id: 'client-a', role: 'member', status: 'disabled' }),
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
  assert.equal(calls.exchangeCodeForToken.length, 0);
});

test('a member demoted to viewer mid-round-trip is rejected as connection_failed (self-service excludes viewers)', async () => {
  const { service, calls } = makeFakes({
    getClientMemberById: async () => ({ id: 'member-a', client_id: 'client-a', role: 'viewer', status: 'active' }),
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
  assert.equal(calls.exchangeCodeForToken.length, 0);
});

test('a member with an ordinary (non-viewer) role IS allowed through — self-service is not owner/admin-gated', async () => {
  const { service } = makeFakes({
    getClientMemberById: async () => ({ id: 'member-a', client_id: 'client-a', role: 'member', status: 'active' }),
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.SUCCESS);
});

test('an inactive organization is rejected as connection_failed', async () => {
  const { service } = makeFakes({ getClientById: async () => ({ id: 'client-a', is_active: false }) });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
});

test('a Gmail token-exchange failure redirects to connection_failed', async () => {
  const { service } = makeFakes({
    exchangeCodeForToken: async () => { const e = new Error('oauth failed'); e.code = 'GMAIL_OAUTH_FAILED'; throw e; },
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
});

test('a connection-persist (oauth_connections) failure redirects to connection_failed', async () => {
  const { service } = makeFakes({
    createOrReplaceConnection: async () => { throw new Error('createOrReplaceConnection failed: simulated'); },
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
});

test('an email_connections upsert failure (after oauth_connections already succeeded) still redirects to connection_failed', async () => {
  const { service, calls } = makeFakes({
    upsertConnection: async () => { throw new Error('upsertConnection failed: simulated'); },
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
  assert.equal(calls.createOrReplaceConnection.length, 1); // the oauth_connections write did happen
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
  assert.equal(args.provider, 'gmail');
  assert.equal(args.externalAccountId, '109876543210');
  assert.equal(args.externalAccountName, 'alex@example.com');
  assert.equal(args.connectedByMemberId, 'member-a');
  assert.equal(args.accessToken, 'ya29.real-access-token');
  assert.equal(args.refreshToken, '1//real-refresh-token');

  assert.equal(calls.upsertConnection.length, 1);
  const upsertArgs = calls.upsertConnection[0];
  assert.equal(upsertArgs.clientId, 'client-a');
  assert.equal(upsertArgs.memberId, 'member-a');
  assert.equal(upsertArgs.provider, 'gmail');
  assert.equal(upsertArgs.mailboxAddress, 'alex@example.com');
  assert.equal(upsertArgs.displayName, 'Alex Doe');
  assert.ok(upsertArgs.oauthConnectionId);
});

test('handleCallback never throws for any input — every branch resolves to a redirect path', async () => {
  const { service } = makeFakes({ exchangeCodeForToken: async () => { throw new Error('boom'); } });
  await assert.doesNotReject(() => service.handleCallback({ code: 'c', state: 's', error: null }));
});

test('handleCallback never leaks the raw code, state, or access/refresh token into the returned redirect path', async () => {
  const { service } = makeFakes();
  const result = await service.handleCallback({ code: 'super-secret-code', state: 'super-secret-state', error: null });
  assert.equal(result.redirectPath.includes('super-secret-code'), false);
  assert.equal(result.redirectPath.includes('super-secret-state'), false);
  assert.equal(result.redirectPath.includes('ya29.real-access-token'), false);
  assert.equal(result.redirectPath.includes('1//real-refresh-token'), false);
});

test('reconnecting the same member replaces only that member\'s connection, leaving a different member\'s connection untouched', async () => {
  const { service, connectionsStore } = makeFakes({
    consumeState: async () => ({ status: 'consumed', clientId: 'client-a', memberId: 'member-b', redirectAfter: null }),
  });

  // Seed an existing active connection for member-a (a different member of
  // the same client) that must survive member-b's connect/reconnect below.
  connectionsStore.set('conn-a-existing', { id: 'conn-a-existing', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active', connected_at: '2026-07-01T00:00:00Z' });

  // First connect for member-b.
  const first = await service.handleCallback({ code: 'code-1', state: 'state-1', error: null });
  assert.equal(first.redirectPath, REDIRECT.SUCCESS);
  const firstActiveForB = [...connectionsStore.values()].filter((r) => r.connected_by_member_id === 'member-b' && r.status === 'active');
  assert.equal(firstActiveForB.length, 1);
  const firstConnectionId = firstActiveForB[0].id;

  // Reconnect (member-b connects again — e.g. after a disconnect+reconnect cycle).
  const second = await service.handleCallback({ code: 'code-2', state: 'state-2', error: null });
  assert.equal(second.redirectPath, REDIRECT.SUCCESS);

  const activeForB = [...connectionsStore.values()].filter((r) => r.connected_by_member_id === 'member-b' && r.status === 'active');
  assert.equal(activeForB.length, 1, 'member-b must have exactly one active connection after reconnecting, not two');
  assert.notEqual(activeForB[0].id, firstConnectionId, 'the reconnect must produce a new active connection row');

  // Member-a's pre-existing connection is completely unaffected.
  assert.equal(connectionsStore.get('conn-a-existing').status, 'active');
});

// ─────────────────────────────────────────────
// getConnections
// ─────────────────────────────────────────────

test('getConnections returns only the caller\'s own connection by default (no admin override)', async () => {
  const { service, connectionsStore } = makeFakes();
  connectionsStore.set('conn-a', { id: 'conn-a', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active', connected_at: '2026-07-23T00:00:00Z' });
  connectionsStore.set('conn-b', { id: 'conn-b', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-b', status: 'active', connected_at: '2026-07-23T00:00:00Z' });

  const result = await service.getConnections({ clientId: 'client-a', memberId: 'member-a', isOwnerAdmin: false, all: false });
  assert.equal(result.connections.length, 1);
  assert.equal(result.connections[0].connectionId, 'conn-a');
  assert.equal(result.connections[0].memberId, 'member-a');
});

test('getConnections returns an empty list when the caller has no connection', async () => {
  const { service } = makeFakes({ getActiveConnectionForClientAndMember: async () => null });
  const result = await service.getConnections({ clientId: 'client-a', memberId: 'member-a', isOwnerAdmin: false, all: false });
  assert.deepEqual(result.connections, []);
});

test('getConnections with all=true returns every member\'s connection, but ONLY for an owner/admin caller', async () => {
  const { service, connectionsStore } = makeFakes();
  connectionsStore.set('conn-a', { id: 'conn-a', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active', connected_at: '2026-07-23T00:00:00Z' });
  connectionsStore.set('conn-b', { id: 'conn-b', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-b', status: 'active', connected_at: '2026-07-23T00:00:00Z' });

  const adminResult = await service.getConnections({ clientId: 'client-a', memberId: 'member-a', isOwnerAdmin: true, all: true });
  assert.equal(adminResult.connections.length, 2);
  assert.deepEqual(adminResult.connections.map((c) => c.memberId).sort(), ['member-a', 'member-b']);
});

test('getConnections with all=true from a NON-admin caller is silently ignored — returns only their own connection', async () => {
  const { service, connectionsStore } = makeFakes();
  connectionsStore.set('conn-a', { id: 'conn-a', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active', connected_at: '2026-07-23T00:00:00Z' });
  connectionsStore.set('conn-b', { id: 'conn-b', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-b', status: 'active', connected_at: '2026-07-23T00:00:00Z' });

  const result = await service.getConnections({ clientId: 'client-a', memberId: 'member-a', isOwnerAdmin: false, all: true });
  assert.equal(result.connections.length, 1);
  assert.equal(result.connections[0].memberId, 'member-a');
});

// ─────────────────────────────────────────────
// disconnect
// ─────────────────────────────────────────────

test('disconnect with no matching/active connection is idempotent — returns safe success without calling revoke', async () => {
  const { service, calls } = makeFakes({ getConnectionById: async () => null });
  const result = await service.disconnect({ clientId: 'client-a', connectionId: 'conn-x' });
  assert.deepEqual(result, { disconnected: true });
  assert.equal(calls.revokeToken.length, 0);
  assert.equal(calls.markConnectionRevokedForMember.length, 0);
});

test('disconnect decrypts the token server-side, attempts best-effort provider revocation, and marks the member-scoped connection revoked', async () => {
  const { service, calls } = makeFakes({
    getConnectionById: async () => ({ id: 'conn-1', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active' }),
  });
  const result = await service.disconnect({ clientId: 'client-a', connectionId: 'conn-1' });
  assert.deepEqual(result, { disconnected: true });
  assert.equal(calls.revokeToken.length, 1);
  assert.equal(calls.revokeToken[0], 'ya29.decrypted-token');
  assert.equal(calls.markConnectionRevokedForMember.length, 1);
  assert.deepEqual(calls.markConnectionRevokedForMember[0], { clientId: 'client-a', provider: 'gmail', memberId: 'member-a' });
});

test('disconnect never returns the access token in its response', async () => {
  const { service } = makeFakes({
    getConnectionById: async () => ({ id: 'conn-1', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active' }),
  });
  const result = await service.disconnect({ clientId: 'client-a', connectionId: 'conn-1' });
  assert.equal(JSON.stringify(result).includes('ya29'), false);
  assert.deepEqual(Object.keys(result), ['disconnected']);
});

test('disconnect is tenant-scoped — a connectionId belonging to a different client is treated as not found', async () => {
  const { service, calls } = makeFakes({
    getConnectionById: async () => ({ id: 'conn-1', client_id: 'client-b', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active' }),
  });
  const result = await service.disconnect({ clientId: 'client-a', connectionId: 'conn-1' });
  assert.deepEqual(result, { disconnected: true });
  assert.equal(calls.revokeToken.length, 0);
  assert.equal(calls.markConnectionRevokedForMember.length, 0);
});

// ─────────────────────────────────────────────
// Cross-member isolation (EM2's own spec calls this out explicitly —
// "the single most heavily-tested authorization boundary in this feature")
// ─────────────────────────────────────────────

test('cross-member isolation: disconnecting member A\'s connection never revokes member B\'s connection for the same client', async () => {
  const { service, calls, connectionsStore } = makeFakes();
  connectionsStore.set('conn-a', { id: 'conn-a', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active' });
  connectionsStore.set('conn-b', { id: 'conn-b', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-b', status: 'active' });

  await service.disconnect({ clientId: 'client-a', connectionId: 'conn-a' });

  assert.equal(calls.markConnectionRevokedForMember.length, 1);
  assert.equal(calls.markConnectionRevokedForMember[0].memberId, 'member-a');
  // Member B's row is untouched by the fake's own scoped revoke logic.
  assert.equal(connectionsStore.get('conn-a').status, 'revoked');
  assert.equal(connectionsStore.get('conn-b').status, 'active');
});

test('cross-member isolation: member B\'s getConnections call never surfaces member A\'s connection, even though both belong to the same client', async () => {
  const { service, connectionsStore } = makeFakes();
  connectionsStore.set('conn-a', { id: 'conn-a', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active', connected_at: '2026-07-23T00:00:00Z' });

  const resultForB = await service.getConnections({ clientId: 'client-a', memberId: 'member-b', isOwnerAdmin: false, all: false });
  assert.deepEqual(resultForB.connections, []);
});

// ─────────────────────────────────────────────
// canDisconnectConnection — EM2's disconnect authorization boundary.
// Self-service ONLY: no owner/admin override exists in this milestone (that
// administrative capability is deferred to EM9 — see emailConnectionService.js's
// file header). This function takes no role/isOwnerAdmin parameter at all,
// so there is no code path by which a role could grant access here.
// ─────────────────────────────────────────────

test('canDisconnectConnection allows a member to disconnect their own connection', () => {
  const connection = { connected_by_member_id: 'member-a' };
  assert.equal(canDisconnectConnection({ connection, actingMemberId: 'member-a' }), true);
});

test('canDisconnectConnection denies a member disconnecting a DIFFERENT member\'s connection — regular members', () => {
  const connection = { connected_by_member_id: 'member-a' };
  assert.equal(canDisconnectConnection({ connection, actingMemberId: 'member-b' }), false);
});

test('canDisconnectConnection has no owner/admin override — it does not accept a role at all, so no role value can grant access to another member\'s connection', () => {
  const connection = { connected_by_member_id: 'member-a' };
  // Even if a caller mistakenly stuffed a role-like field onto the args,
  // the function signature only ever reads actingMemberId — proving there
  // is no hidden bypass path a future refactor could accidentally wire up.
  assert.equal(canDisconnectConnection({ connection, actingMemberId: 'member-owner', role: 'owner', isOwnerAdmin: true }), false);
});

test('canDisconnectConnection is a connection-ID-alone-never-grants-access guard: a null/missing connection is always denied', () => {
  assert.equal(canDisconnectConnection({ connection: null, actingMemberId: 'member-a' }), false);
  assert.equal(canDisconnectConnection({ connection: undefined, actingMemberId: 'member-a' }), false);
});

test('canDisconnectConnection denies when actingMemberId is missing, even if a connection is somehow passed', () => {
  const connection = { connected_by_member_id: 'member-a' };
  assert.equal(canDisconnectConnection({ connection, actingMemberId: null }), false);
  assert.equal(canDisconnectConnection({ connection, actingMemberId: undefined }), false);
});

// ─────────────────────────────────────────────
// updateSyncMode (EM4 — §14.1 POST /connections/:id/sync-mode)
// ─────────────────────────────────────────────

test('updateSyncMode sets manual_selected without ever consulting org automatic-sync settings', async () => {
  const { service, calls } = makeFakes();
  const result = await service.updateSyncMode({ clientId: 'client-a', oauthConnectionId: 'conn-1', syncMode: 'manual_selected' });
  assert.deepEqual(result, { syncMode: 'manual_selected' });
  assert.equal(calls.getSettings.length, 0);
  assert.equal(calls.updateSyncMode.length, 1);
  assert.deepEqual(calls.updateSyncMode[0], { oauthConnectionId: 'conn-1', syncMode: 'manual_selected' });
});

test('updateSyncMode allows automatic when the org has automatic_sync_enabled on', async () => {
  const { service, calls } = makeFakes({ getSettings: async () => ({ automaticSyncEnabled: true }) });
  const result = await service.updateSyncMode({ clientId: 'client-a', oauthConnectionId: 'conn-1', syncMode: 'automatic' });
  assert.deepEqual(result, { syncMode: 'automatic' });
  assert.equal(calls.getSettings.length, 1);
  assert.equal(calls.updateSyncMode.length, 1);
});

test('updateSyncMode rejects automatic with AUTOMATIC_SYNC_DISABLED when the org setting is off, without writing anything', async () => {
  const { service, calls } = makeFakes({ getSettings: async () => ({ automaticSyncEnabled: false }) });
  await assert.rejects(
    () => service.updateSyncMode({ clientId: 'client-a', oauthConnectionId: 'conn-1', syncMode: 'automatic' }),
    (err) => err.code === 'AUTOMATIC_SYNC_DISABLED'
  );
  assert.equal(calls.updateSyncMode.length, 0);
});

test('updateSyncMode rejects an unsupported syncMode value (e.g. "paused" — reached only via a separate pause control, not this route)', async () => {
  const { service, calls } = makeFakes();
  await assert.rejects(
    () => service.updateSyncMode({ clientId: 'client-a', oauthConnectionId: 'conn-1', syncMode: 'paused' }),
    (err) => err.code === 'INVALID_SYNC_MODE'
  );
  assert.equal(calls.updateSyncMode.length, 0);
});

test('updateSyncMode surfaces CONNECTION_NOT_FOUND when no email_connections row matches the oauth connection id', async () => {
  const { service } = makeFakes({ updateSyncMode: async () => null });
  await assert.rejects(
    () => service.updateSyncMode({ clientId: 'client-a', oauthConnectionId: 'conn-missing', syncMode: 'manual_selected' }),
    (err) => err.code === 'CONNECTION_NOT_FOUND'
  );
});

// ─────────────────────────────────────────────
// mapGmailConnectionResponse — pure response mapping
// ─────────────────────────────────────────────

test('mapGmailConnectionResponse allowlists exactly the documented fields', () => {
  const connectionRow = {
    id: 'conn-1',
    connected_by_member_id: 'member-a',
    status: 'active',
    connected_at: '2026-07-23T00:00:00Z',
    external_account_name: 'alex@example.com',
  };
  const emailConnectionRow = {
    mailbox_address: 'alex@example.com',
    display_name: 'Alex Doe',
    sync_mode: 'manual_selected',
    sync_enabled: true,
    historical_import_status: 'not_started',
  };
  const mapped = mapGmailConnectionResponse(connectionRow, emailConnectionRow);
  assert.deepEqual(mapped, {
    connectionId: 'conn-1',
    memberId: 'member-a',
    provider: PROVIDER,
    mailboxAddress: 'alex@example.com',
    displayName: 'Alex Doe',
    syncMode: 'manual_selected',
    syncEnabled: true,
    historicalImportStatus: 'not_started',
    status: 'active',
    connectedAt: '2026-07-23T00:00:00Z',
  });
});

test('mapGmailConnectionResponse never includes any credential-related field', () => {
  const connectionRow = {
    id: 'conn-1',
    connected_by_member_id: 'member-a',
    status: 'active',
    connected_at: '2026-07-23T00:00:00Z',
    // Simulates an accidental join/select mistake — must never leak through.
    access_token_encrypted: { ciphertext: 'should-never-appear' },
  };
  const mapped = mapGmailConnectionResponse(connectionRow, null);
  for (const key of ['access_token', 'refresh_token', 'access_token_encrypted', 'accessToken', 'ciphertext', 'iv', 'authTag']) {
    assert.equal(key in mapped, false, `must not include "${key}"`);
  }
});
