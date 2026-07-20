const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createOauthConnectionsService,
  toSafeConnectionStatus,
  SUPPORTED_PROVIDERS,
  STATUS,
} = require('../services/oauthConnectionsService');
const { KEY_ENV_VAR, KEY_VERSION_ENV_VAR, encryptCredential, decryptCredential, getCurrentKeyVersion } = require('../services/integrationCredentialEncryption');

const VALID_KEY = 'c'.repeat(64);

// Deliberately async and awaits fn() inside try: if fn is itself async and
// this only did `return fn()` without awaiting, the finally block below
// would run synchronously right after fn's first await point — restoring
// (deleting) the key while fn's later continuation (e.g. a decrypt call
// after an awaited fake-DB round trip) is still pending, silently pulling
// the key out from under it. Always awaiting here, and always awaiting
// withKey(...) at every call site, keeps "set key -> run fn to full
// completion -> restore key" strictly ordered regardless of how many
// awaits fn contains.
async function withKey(fn) {
  const original = process.env[KEY_ENV_VAR];
  process.env[KEY_ENV_VAR] = VALID_KEY;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env[KEY_ENV_VAR];
    else process.env[KEY_ENV_VAR] = original;
  }
}

const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260714_oauth_connections.sql');
const MIGRATION_SQL = fs.readFileSync(MIGRATION_PATH, 'utf8');

function parseQuotedList(pattern) {
  const match = MIGRATION_SQL.match(pattern);
  assert.ok(match, `pattern ${pattern} did not match anything in ${MIGRATION_PATH} — the migration may have been edited`);
  return match[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
}

/**
 * A minimal fake of the subset of the Supabase JS fluent query builder used
 * by services/oauthConnectionsService.js. Records every call (table,
 * operation, filters, update/select payloads) so tests can assert on
 * exactly what was scoped/sent, and lets the test control what comes back.
 * This repo has no real test-database pattern (every existing test in
 * test/*.test.js exercises pure functions only), so dependency injection
 * against a fake client — rather than a real network call — is the
 * intended approach here.
 */
function createFakeSupabaseClient({ onQuery = () => ({ data: null, error: null }), onRpc = () => ({ data: null, error: null }) } = {}) {
  const calls = { queries: [], rpc: [] };

  function makeBuilder(table) {
    const state = { table, operation: 'select', filters: {}, neqFilters: {}, updatePayload: null, selectCols: null };
    const builder = {
      select(cols) { state.selectCols = cols; return builder; },
      eq(col, val) { state.filters[col] = val; return builder; },
      neq(col, val) { state.neqFilters[col] = val; return builder; },
      update(payload) { state.operation = 'update'; state.updatePayload = payload; return builder; },
      delete() { state.operation = 'delete'; return builder; },
      maybeSingle() { return builder; },
      single() { return builder; },
      then(resolve, reject) {
        calls.queries.push({ ...state, filters: { ...state.filters }, neqFilters: { ...state.neqFilters } });
        Promise.resolve(onQuery({ ...state, filters: { ...state.filters }, neqFilters: { ...state.neqFilters } })).then(resolve, reject);
      },
    };
    return builder;
  }

  const client = {
    from(table) { return makeBuilder(table); },
    rpc(name, args) {
      calls.rpc.push({ name, args });
      return { then(resolve, reject) { Promise.resolve(onRpc(name, args)).then(resolve, reject); } };
    },
  };

  return { client, calls };
}

// ─────────────────────────────────────────────
// toSafeConnectionStatus — pure response mapping
// ─────────────────────────────────────────────

test('safe status for an active connection never includes credential fields', () => {
  const row = {
    provider: 'slack',
    external_account_id: 'T123',
    external_account_name: 'Acme Corp',
    scopes_granted: ['app_mentions:read', 'chat:write'],
    status: 'active',
    connected_at: '2026-07-14T00:00:00.000Z',
    // Simulates an accidental join/select mistake — must never leak through.
    access_token_encrypted: { ciphertext: 'should-never-appear' },
  };

  const safe = toSafeConnectionStatus(row);
  assert.equal(safe.connected, true);
  assert.equal(safe.provider, 'slack');
  assert.equal(safe.externalAccountId, 'T123');
  assert.equal(safe.externalAccountName, 'Acme Corp');
  assert.deepEqual(safe.scopes, ['app_mentions:read', 'chat:write']);
  assert.equal('access_token_encrypted' in safe, false);
  assert.equal('accessToken' in safe, false);
  assert.equal('refreshToken' in safe, false);
});

test('revoked connection reports connected: false', () => {
  const safe = toSafeConnectionStatus({ provider: 'slack', status: 'revoked' });
  assert.equal(safe.connected, false);
  assert.equal(safe.status, 'revoked');
  assert.equal(safe.externalAccountId, null);
});

test('no connection (null row) reports connected: false with no provider assumed', () => {
  const safe = toSafeConnectionStatus(null);
  assert.equal(safe.connected, false);
  assert.equal(safe.provider, null);
});

test('safe status responses never include any credential-related field, exhaustively', () => {
  const activeRow = {
    provider: 'slack',
    status: 'active',
    external_account_id: 'T1',
    external_account_name: 'Acme',
    scopes_granted: ['chat:write'],
    connected_at: '2026-07-14T00:00:00Z',
  };
  const safe = toSafeConnectionStatus(activeRow);

  const forbiddenKeys = [
    'access_token', 'refresh_token',
    'access_token_encrypted', 'refresh_token_encrypted',
    'accessToken', 'refreshToken',
    'ciphertext', 'iv', 'authTag',
    'encryption_key_version', 'encryptionKeyVersion',
  ];
  for (const key of forbiddenKeys) {
    assert.equal(key in safe, false, `safe status must not include "${key}"`);
  }
});

// ─────────────────────────────────────────────
// Query scoping
// ─────────────────────────────────────────────

test('getActiveConnectionForClient scopes strictly by the given clientId — client A cannot see client B\'s row', async () => {
  const { client, calls } = createFakeSupabaseClient({
    onQuery: (state) => {
      // Simulate real row-level scoping: only return data if the filters
      // actually match client A's id.
      if (state.filters.client_id === 'client-a' && state.filters.provider === 'slack') {
        return { data: { id: 'conn-a', client_id: 'client-a', provider: 'slack', status: 'active' }, error: null };
      }
      return { data: null, error: null };
    },
  });
  const service = createOauthConnectionsService(client);

  const forA = await service.getActiveConnectionForClient('client-a', 'slack');
  assert.equal(forA.client_id, 'client-a');

  const forB = await service.getActiveConnectionForClient('client-b', 'slack');
  assert.equal(forB, null);

  assert.equal(calls.queries[0].filters.client_id, 'client-a');
  assert.equal(calls.queries[1].filters.client_id, 'client-b');
});

test('getActiveConnectionByExternalAccount is scoped by provider, not just external account id', async () => {
  const { client, calls } = createFakeSupabaseClient({
    onQuery: () => ({ data: null, error: null }),
  });
  const service = createOauthConnectionsService(client);

  await service.getActiveConnectionByExternalAccount('slack', 'T123');

  const query = calls.queries[0];
  assert.equal(query.table, 'oauth_connections');
  assert.equal(query.filters.provider, 'slack');
  assert.equal(query.filters.external_account_id, 'T123');
  assert.equal(query.filters.status, 'active');
});

test('markConnectionRevoked is client-scoped and deletes the credential row for the revoked connection only', async () => {
  const { client, calls } = createFakeSupabaseClient({
    onQuery: (state) => {
      if (state.table === 'oauth_connections' && state.operation === 'update') {
        return { data: { id: 'conn-a' }, error: null };
      }
      return { data: null, error: null };
    },
  });
  const service = createOauthConnectionsService(client);

  const result = await service.markConnectionRevoked('client-a', 'slack');
  assert.deepEqual(result, { revoked: true });

  const updateCall = calls.queries.find(q => q.operation === 'update');
  assert.equal(updateCall.filters.client_id, 'client-a');
  assert.equal(updateCall.filters.provider, 'slack');
  assert.equal(updateCall.filters.status, 'active');

  const deleteCall = calls.queries.find(q => q.operation === 'delete');
  assert.equal(deleteCall.table, 'oauth_credentials');
  assert.equal(deleteCall.filters.connection_id, 'conn-a');
});

test('markConnectionRevoked is a no-op (revoked: false) when there is no active connection for that client', async () => {
  const { client, calls } = createFakeSupabaseClient({
    onQuery: () => ({ data: null, error: null }),
  });
  const service = createOauthConnectionsService(client);

  const result = await service.markConnectionRevoked('client-a', 'slack');
  assert.deepEqual(result, { revoked: false });
  // No credential delete should be attempted when nothing was revoked.
  assert.equal(calls.queries.some(q => q.table === 'oauth_credentials'), false);
});

test('deleteConnection is client-scoped', async () => {
  const { client, calls } = createFakeSupabaseClient();
  const service = createOauthConnectionsService(client);

  await service.deleteConnection('client-a', 'slack');

  const deleteCall = calls.queries[0];
  assert.equal(deleteCall.table, 'oauth_connections');
  assert.equal(deleteCall.operation, 'delete');
  assert.equal(deleteCall.filters.client_id, 'client-a');
  assert.equal(deleteCall.filters.provider, 'slack');
});

// ─────────────────────────────────────────────
// No default client fallback
// ─────────────────────────────────────────────

test('no method silently falls back to a default client — missing clientId throws before any query runs', async () => {
  const { client, calls } = createFakeSupabaseClient();
  const service = createOauthConnectionsService(client);

  await assert.rejects(() => service.getActiveConnectionForClient(undefined, 'slack'), /requires clientId/);
  await assert.rejects(() => service.getActiveConnectionForClient(null, 'slack'), /requires clientId/);
  await assert.rejects(() => service.markConnectionRevoked(undefined, 'slack'), /requires clientId/);
  await assert.rejects(() => service.deleteConnection('', 'slack'), /requires clientId/);
  await assert.rejects(() => service.createOrReplaceConnection({ provider: 'slack', accessToken: 'x' }), /requires clientId/);

  // None of the above should have reached the fake client at all.
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.rpc.length, 0);
});

// ─────────────────────────────────────────────
// Safe read boundaries — only getDecryptedCredentialForConnection may
// touch oauth_credentials; every other operation is metadata-only.
// ─────────────────────────────────────────────

test('metadata/status operations never query oauth_credentials', async () => {
  const { client, calls } = createFakeSupabaseClient({ onQuery: () => ({ data: null, error: null }) });
  const service = createOauthConnectionsService(client);

  await service.getActiveConnectionForClient('client-a', 'slack');
  await service.getActiveConnectionByExternalAccount('slack', 'T1');
  await service.getSafeConnectionStatus('client-a', 'slack');
  await service.markConnectionRevoked('client-a', 'slack'); // no active row found -> no credential delete attempted
  await service.deleteConnection('client-a', 'slack');

  assert.ok(calls.queries.length > 0, 'sanity check: queries were actually recorded');
  assert.ok(
    calls.queries.every(q => q.table === 'oauth_connections'),
    'no metadata/status/revoke/delete path should ever touch oauth_credentials'
  );
});

test('only getDecryptedCredentialForConnection reads oauth_credentials, and only the columns it needs', async () => {
  await withKey(async () => {
    const envelope = encryptCredential('xoxb-real-token');
    const { client, calls } = createFakeSupabaseClient({
      onQuery: (state) => {
        if (state.table === 'oauth_credentials') {
          return { data: { access_token_encrypted: envelope, refresh_token_encrypted: null, expires_at: null, encryption_key_version: getCurrentKeyVersion() }, error: null };
        }
        return { data: null, error: null };
      },
    });
    const service = createOauthConnectionsService(client);

    const cred = await service.getDecryptedCredentialForConnection('conn-1');
    assert.equal(cred.accessToken, 'xoxb-real-token');

    const credQueries = calls.queries.filter(q => q.table === 'oauth_credentials');
    assert.equal(credQueries.length, 1);
    // Explicit column allowlist — never select('*') on the credentials table.
    assert.equal(credQueries[0].selectCols, 'access_token_encrypted, refresh_token_encrypted, expires_at, encryption_key_version');
    assert.equal(credQueries[0].selectCols.includes('*'), false);
  });
});

// ─────────────────────────────────────────────
// updateCredentialForConnection — in-place refresh, no connection churn
// (backlog H2). Distinct from createOrReplaceConnection: only touches
// oauth_credentials, never oauth_connections.
// ─────────────────────────────────────────────

test('updateCredentialForConnection requires connectionId and a non-empty accessToken before touching the database', async () => {
  const { client, calls } = createFakeSupabaseClient();
  const service = createOauthConnectionsService(client);

  await assert.rejects(() => service.updateCredentialForConnection(undefined, { accessToken: 'x' }), /requires connectionId/);
  await assert.rejects(() => service.updateCredentialForConnection('conn-1', { accessToken: '' }), /requires a non-empty accessToken/);
  await assert.rejects(() => service.updateCredentialForConnection('conn-1', {}), /requires a non-empty accessToken/);

  assert.equal(calls.queries.length, 0);
});

test('updateCredentialForConnection encrypts before writing and never sends plaintext', async () => {
  await withKey(async () => {
    const { client, calls } = createFakeSupabaseClient({
      onQuery: () => ({ data: null, error: null }),
    });
    const service = createOauthConnectionsService(client);

    const plaintext = 'ya29.new-access-token';
    await service.updateCredentialForConnection('conn-1', { accessToken: plaintext, refreshToken: 'refresh-abc' });

    const updateCall = calls.queries.find(q => q.operation === 'update');
    assert.equal(updateCall.table, 'oauth_credentials');
    assert.equal(updateCall.filters.connection_id, 'conn-1');
    assert.equal(typeof updateCall.updatePayload.access_token_encrypted, 'object');
    assert.notEqual(updateCall.updatePayload.access_token_encrypted, plaintext);
    assert.equal(JSON.stringify(updateCall.updatePayload).includes(plaintext), false);
    assert.equal(updateCall.updatePayload.encryption_key_version, getCurrentKeyVersion());
  });
});

test('updateCredentialForConnection never touches oauth_connections — only the credential row', async () => {
  await withKey(async () => {
    const { client, calls } = createFakeSupabaseClient({ onQuery: () => ({ data: null, error: null }) });
    const service = createOauthConnectionsService(client);

    await service.updateCredentialForConnection('conn-1', { accessToken: 'new-token' });

    assert.ok(calls.queries.length > 0, 'sanity check: a query was actually made');
    assert.ok(calls.queries.every(q => q.table === 'oauth_credentials'), 'refresh must never write to oauth_connections');
  });
});

test('updateCredentialForConnection writes refresh_token_encrypted: null when no refreshToken is passed, rather than omitting the field', async () => {
  await withKey(async () => {
    const { client, calls } = createFakeSupabaseClient({ onQuery: () => ({ data: null, error: null }) });
    const service = createOauthConnectionsService(client);

    // Documents the contract callers must follow: if the provider's refresh
    // response didn't return a new refresh token, the CALLER must pass the
    // previous one through explicitly — this function has no memory of it
    // and will null it out otherwise (see googleDriveService.js#getValidAccessToken).
    await service.updateCredentialForConnection('conn-1', { accessToken: 'new-token' });

    const updateCall = calls.queries.find(q => q.operation === 'update');
    assert.equal(updateCall.updatePayload.refresh_token_encrypted, null);
  });
});

// ─────────────────────────────────────────────
// Atomicity / replacement semantics — failure delegated entirely to the
// RPC, no partial state, old connection never considered "replaced" on
// failure.
// ─────────────────────────────────────────────

test('createOrReplaceConnection rejects an unsupported provider before ever touching the database', async () => {
  const { client, calls } = createFakeSupabaseClient();
  const service = createOauthConnectionsService(client);

  await assert.rejects(
    () => service.createOrReplaceConnection({ clientId: 'client-a', provider: 'not_a_real_provider', accessToken: 'x' }),
    /unsupported provider/
  );
  assert.equal(calls.rpc.length, 0);
});

test('createOrReplaceConnection encrypts before calling the database and never sends plaintext', async () => {
  await withKey(async () => {
    let capturedArgs = null;
    const { client } = createFakeSupabaseClient({
      onRpc: (name, args) => {
        capturedArgs = args;
        return { data: { id: 'conn-1', provider: 'slack', status: 'active', external_account_id: 'T1', external_account_name: 'Acme', scopes_granted: [], connected_at: '2026-07-14T00:00:00Z' }, error: null };
      },
    });
    const service = createOauthConnectionsService(client);

    const plaintext = 'xoxb-super-secret-token';
    const safe = await service.createOrReplaceConnection({
      clientId: 'client-a',
      provider: 'slack',
      externalAccountId: 'T1',
      externalAccountName: 'Acme',
      accessToken: plaintext,
    });

    assert.equal(capturedArgs.p_client_id, 'client-a');
    assert.equal(capturedArgs.p_provider, 'slack');
    // The RPC must only ever receive an encrypted envelope, never the plaintext.
    assert.notEqual(capturedArgs.p_access_token_encrypted, plaintext);
    assert.equal(typeof capturedArgs.p_access_token_encrypted, 'object');
    // Envelope version (serialization/algorithm format, nested inside the
    // encrypted envelope object) and key version (which key encrypted this
    // row, a top-level RPC argument) are two distinct fields, sent
    // independently and never merged into one:
    assert.equal(capturedArgs.p_access_token_encrypted.version, 1); // envelope format version
    assert.equal(capturedArgs.p_encryption_key_version, getCurrentKeyVersion()); // which key
    assert.equal(JSON.stringify(capturedArgs).includes(plaintext), false);

    // The returned safe status never includes the token either.
    assert.equal('accessToken' in safe, false);
    assert.equal(safe.connected, true);
  });
});

test('when the RPC fails, createOrReplaceConnection throws and never fabricates a "replaced" status — the prior connection is not considered replaced', async () => {
  await withKey(async () => {
    const { client, calls } = createFakeSupabaseClient({
      onRpc: () => ({ data: null, error: { message: 'simulated: oauth_credentials insert violates not-null constraint' } }),
    });
    const service = createOauthConnectionsService(client);

    let result;
    let thrown = null;
    try {
      result = await service.createOrReplaceConnection({ clientId: 'client-a', provider: 'slack', accessToken: 'xoxb-token' });
    } catch (err) {
      thrown = err;
    }

    assert.equal(result, undefined, 'no safe status object should ever be returned on failure');
    assert.ok(thrown);
    assert.match(thrown.message, /createOrReplaceConnection failed/);

    // The service made exactly one atomic call and nothing else — no
    // separate compensating writes, no follow-up "did it actually work?"
    // query, no fallback insert. Whether the prior connection was left
    // untouched is the RPC transaction's guarantee (see the migration
    // comment on replace_active_oauth_connection); from the Node service's
    // side, the only observable behavior is: exactly one call, and a thrown
    // error, with nothing else attempted.
    assert.equal(calls.rpc.length, 1);
    assert.equal(calls.queries.length, 0);
  });
});

// ─────────────────────────────────────────────
// Key rotation (backlog M3)
// ─────────────────────────────────────────────

test('listConnectionIdsNeedingKeyRotation queries only rows whose encryption_key_version differs from current, and selects only what it needs', async () => {
  const { client, calls } = createFakeSupabaseClient({
    onQuery: (state) => {
      if (state.table === 'oauth_credentials') {
        return { data: [{ connection_id: 'conn-old-1', encryption_key_version: 1 }], error: null };
      }
      return { data: null, error: null };
    },
  });
  const service = createOauthConnectionsService(client);

  const rows = await service.listConnectionIdsNeedingKeyRotation();
  assert.deepEqual(rows, [{ connectionId: 'conn-old-1', encryptionKeyVersion: 1 }]);

  const query = calls.queries.find(q => q.table === 'oauth_credentials');
  assert.equal(query.neqFilters['encryption_key_version'], getCurrentKeyVersion());
  assert.equal(query.selectCols, 'connection_id, encryption_key_version');
});

test('reencryptCredentialForConnection is a no-op when the row is already on the current key version', async () => {
  await withKey(async () => {
    const { client, calls } = createFakeSupabaseClient({
      onQuery: (state) => {
        if (state.table === 'oauth_credentials' && state.operation === 'select') {
          return { data: { access_token_encrypted: encryptCredential('tok'), refresh_token_encrypted: null, expires_at: null, encryption_key_version: getCurrentKeyVersion() }, error: null };
        }
        return { data: null, error: null };
      },
    });
    const service = createOauthConnectionsService(client);

    const result = await service.reencryptCredentialForConnection('conn-1');
    assert.deepEqual(result, { rotated: false });
    // No update should have been attempted — already current.
    assert.equal(calls.queries.some(q => q.operation === 'update'), false);
  });
});

test('reencryptCredentialForConnection is a no-op when the connection no longer has a credential row', async () => {
  const { client, calls } = createFakeSupabaseClient({ onQuery: () => ({ data: null, error: null }) });
  const service = createOauthConnectionsService(client);

  const result = await service.reencryptCredentialForConnection('conn-gone');
  assert.deepEqual(result, { rotated: false });
  assert.equal(calls.queries.some(q => q.operation === 'update'), false);
});

test('reencryptCredentialForConnection decrypts with the OLD stored version and re-encrypts under the current one, never sending plaintext', async () => {
  const OLD_KEY = 'e'.repeat(64);
  const NEW_KEY = 'f'.repeat(64);
  const PLAINTEXT = 'ya29.token-under-rotation';

  const oldEnvelope = await withEnv({ [KEY_ENV_VAR]: OLD_KEY, [KEY_VERSION_ENV_VAR]: undefined }, () => encryptCredential(PLAINTEXT));

  await withEnv({ [KEY_ENV_VAR]: NEW_KEY, [KEY_VERSION_ENV_VAR]: '2', [`${KEY_ENV_VAR}_V1`]: OLD_KEY }, async () => {
    const { client, calls } = createFakeSupabaseClient({
      onQuery: (state) => {
        if (state.table === 'oauth_credentials' && state.operation === 'select') {
          return { data: { access_token_encrypted: oldEnvelope, refresh_token_encrypted: null, expires_at: null, encryption_key_version: 1 }, error: null };
        }
        return { data: null, error: null };
      },
    });
    const service = createOauthConnectionsService(client);

    const result = await service.reencryptCredentialForConnection('conn-1');
    assert.deepEqual(result, { rotated: true, fromVersion: 1, toVersion: 2 });

    const updateCall = calls.queries.find(q => q.operation === 'update');
    assert.equal(updateCall.table, 'oauth_credentials');
    assert.equal(updateCall.updatePayload.encryption_key_version, 2);
    assert.equal(JSON.stringify(updateCall.updatePayload).includes(PLAINTEXT), false);

    // The rewritten envelope decrypts back to the same plaintext under the new key/version.
    assert.equal(decryptCredential(updateCall.updatePayload.access_token_encrypted, 2), PLAINTEXT);
  });
});

// withEnv mirrors integrationCredentialEncryption.test.js's helper — kept
// local (not shared) since these two test files intentionally have no
// cross-file dependency on each other's test-only utilities.
async function withEnv(overrides, fn) {
  const originals = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(originals)) {
      const original = originals[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

// ─────────────────────────────────────────────
// Migration <-> service consistency
//
// These tests parse the actual migration SQL file rather than hardcoding a
// second copy of its constraints, so a future edit to the migration that
// silently drifts from the service (or vice versa) fails a test instead of
// only being caught in production by an opaque Postgres error.
// ─────────────────────────────────────────────

test('SUPPORTED_PROVIDERS matches the oauth_connections.provider CHECK constraint exactly', () => {
  const dbProviders = parseQuotedList(/CHECK \(provider IN \(([^)]+)\)\)/);
  assert.deepEqual([...SUPPORTED_PROVIDERS].sort(), [...dbProviders].sort());
});

test('STATUS values are all members of the oauth_connections.status CHECK constraint', () => {
  const dbStatuses = parseQuotedList(/CHECK \(status IN \(([^)]+)\)\)/);
  for (const value of Object.values(STATUS)) {
    assert.ok(dbStatuses.includes(value), `STATUS value "${value}" is not in the database CHECK constraint (${dbStatuses.join(', ')})`);
  }
  // ...and every DB-allowed status is accounted for in STATUS, so a future
  // migration edit that adds a new status is caught here too.
  assert.deepEqual([...Object.values(STATUS)].sort(), [...dbStatuses].sort());
});

test('both partial unique indexes are scoped to active rows only (revoked rows never block reconnecting)', () => {
  assert.match(
    MIGRATION_SQL,
    /uq_oauth_connections_active_per_client_provider[\s\S]*?WHERE status = 'active'/,
    'the per-client-provider unique index must be partial (WHERE status = \'active\'), so a revoked row never blocks a reconnect'
  );
  assert.match(
    MIGRATION_SQL,
    /uq_oauth_connections_active_external_account[\s\S]*?WHERE status = 'active' AND external_account_id IS NOT NULL/,
    'the external-account unique index must be partial and explicitly null-safe'
  );
});

test('the external-account uniqueness rule is provider-scoped, not global', () => {
  assert.match(
    MIGRATION_SQL,
    /uq_oauth_connections_active_external_account\s*\n\s*ON oauth_connections\(provider, external_account_id\)/,
    'the external-account unique index must include provider as part of the key, not external_account_id alone'
  );
});

test('oauth_credentials cascades from oauth_connections deletion', () => {
  assert.match(
    MIGRATION_SQL,
    /connection_id\s+uuid\s+NOT NULL REFERENCES oauth_connections\(id\) ON DELETE CASCADE/,
    'oauth_credentials.connection_id must cascade on delete, or deleteConnection would orphan credential rows'
  );
});

test('encryption_key_version is declared as an integer column, matching the integer value the service sends', () => {
  assert.match(MIGRATION_SQL, /encryption_key_version\s+integer\s+NOT NULL/);
  assert.equal(Number.isInteger(getCurrentKeyVersion()), true);
});

test('the RPC call sends exactly the parameter names the migration function declares', async () => {
  const fnSignatureMatch = MIGRATION_SQL.match(/CREATE OR REPLACE FUNCTION replace_active_oauth_connection\(([\s\S]*?)\)\s*\nRETURNS/);
  assert.ok(fnSignatureMatch, 'could not find the replace_active_oauth_connection function signature in the migration');
  const dbParamNames = [...fnSignatureMatch[1].matchAll(/\b(p_[a-z_]+)\b/g)].map(m => m[1]).sort();

  await withKey(async () => {
    let capturedArgs = null;
    const { client } = createFakeSupabaseClient({
      onRpc: (name, args) => {
        capturedArgs = args;
        return { data: { id: 'conn-1', provider: 'slack', status: 'active', scopes_granted: [] }, error: null };
      },
    });
    const service = createOauthConnectionsService(client);
    await service.createOrReplaceConnection({ clientId: 'client-a', provider: 'slack', accessToken: 'xoxb-token' });

    const serviceParamNames = Object.keys(capturedArgs).sort();
    assert.deepEqual(serviceParamNames, dbParamNames);
  });
});
