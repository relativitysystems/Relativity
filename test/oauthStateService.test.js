const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createOauthStateService, hashState, generateRawState, STATE_BYTES, DEFAULT_TTL_MS } = require('../services/oauthStateService');

/**
 * A minimal fake of the subset of the Supabase JS fluent query builder used
 * by services/oauthStateService.js (insert / update / select / eq / is / gt
 * / maybeSingle). Mirrors the approach in test/oauthConnectionsService.test.js
 * — dependency injection against a fake client instead of a real database,
 * since this repo has no test-database pattern and every existing test
 * exercises pure functions / DI'd services only.
 */
function createFakeSupabaseClient({ rows = [] } = {}) {
  // rows: in-memory array of oauth_states-shaped records, mutated by update().
  const calls = { inserts: [], updates: [], selects: [] };

  function makeBuilder(table) {
    const state = { table, operation: 'select', filters: {}, gtFilters: {}, isFilters: {}, payload: null, selectCols: null };
    const builder = {
      insert(payload) {
        state.operation = 'insert';
        state.payload = payload;
        return builder;
      },
      update(payload) {
        state.operation = 'update';
        state.payload = payload;
        return builder;
      },
      select(cols) {
        state.selectCols = cols;
        return builder;
      },
      eq(col, val) { state.filters[col] = val; return builder; },
      is(col, val) { state.isFilters[col] = val; return builder; },
      gt(col, val) { state.gtFilters[col] = val; return builder; },
      maybeSingle() {
        return resolve();
      },
      then(resolve_, reject_) {
        // insert() is awaited directly with no .select()/.maybeSingle() chained.
        return resolve().then(resolve_, reject_);
      },
    };

    async function resolve() {
      if (state.operation === 'insert') {
        calls.inserts.push(state.payload);
        rows.push({ id: crypto.randomUUID(), created_at: new Date().toISOString(), consumed_at: null, ...state.payload });
        return { data: null, error: null };
      }

      if (state.operation === 'update') {
        calls.updates.push({ filters: { ...state.filters }, isFilters: { ...state.isFilters }, gtFilters: { ...state.gtFilters }, payload: state.payload });
        const match = rows.find((r) => {
          for (const [k, v] of Object.entries(state.filters)) if (r[k] !== v) return false;
          for (const [k, v] of Object.entries(state.isFilters)) if (r[k] !== v) return false;
          for (const [k, v] of Object.entries(state.gtFilters)) if (!(r[k] > v)) return false;
          return true;
        });
        if (!match) return { data: null, error: null };
        Object.assign(match, state.payload);
        return { data: { ...match }, error: null };
      }

      // select
      calls.selects.push({ filters: { ...state.filters } });
      const match = rows.find((r) => {
        for (const [k, v] of Object.entries(state.filters)) if (r[k] !== v) return false;
        return true;
      });
      return { data: match ? { ...match } : null, error: null };
    }

    return builder;
  }

  const client = { from: (table) => makeBuilder(table) };
  return { client, calls, rows };
}

// ─────────────────────────────────────────────
// State generation
// ─────────────────────────────────────────────

test('generateRawState produces at least 32 random bytes (64 hex chars), different every call', () => {
  const a = generateRawState();
  const b = generateRawState();
  assert.equal(a.length, STATE_BYTES * 2);
  assert.match(a, /^[0-9a-f]+$/);
  assert.notEqual(a, b);
});

test('hashState is deterministic and different inputs hash differently', () => {
  const raw = generateRawState();
  assert.equal(hashState(raw), hashState(raw));
  assert.notEqual(hashState(raw), hashState(generateRawState()));
});

test('generateAndStoreState persists only the hash — the raw state never appears in the stored row', async () => {
  const { client, calls } = createFakeSupabaseClient();
  const service = createOauthStateService(client);

  const { rawState, expiresAt } = await service.generateAndStoreState({ clientId: 'client-a', memberId: 'member-a', provider: 'slack' });

  assert.equal(rawState.length, STATE_BYTES * 2);
  assert.ok(expiresAt);
  assert.equal(calls.inserts.length, 1);
  const inserted = calls.inserts[0];
  assert.equal(inserted.state_hash, hashState(rawState));
  assert.equal(JSON.stringify(inserted).includes(rawState), false, 'the raw state must never be written to the database');
  assert.equal(inserted.client_id, 'client-a');
  assert.equal(inserted.member_id, 'member-a');
  assert.equal(inserted.provider, 'slack');
});

test('generateAndStoreState expires roughly 10 minutes from now by default', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createOauthStateService(client);
  const before = Date.now();

  const { expiresAt } = await service.generateAndStoreState({ clientId: 'client-a', memberId: 'member-a', provider: 'slack' });

  const deltaMs = new Date(expiresAt).getTime() - before;
  assert.equal(DEFAULT_TTL_MS, 10 * 60 * 1000);
  assert.ok(deltaMs > DEFAULT_TTL_MS - 2000 && deltaMs <= DEFAULT_TTL_MS + 2000, `expected ~10min TTL, got ${deltaMs}ms`);
});

test('generateAndStoreState rejects an unsupported provider before writing anything', async () => {
  const { client, calls } = createFakeSupabaseClient();
  const service = createOauthStateService(client);

  await assert.rejects(
    () => service.generateAndStoreState({ clientId: 'client-a', memberId: 'member-a', provider: 'not_a_real_provider' }),
    /unsupported provider/
  );
  assert.equal(calls.inserts.length, 0);
});

test('generateAndStoreState requires clientId/memberId/provider', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createOauthStateService(client);

  await assert.rejects(() => service.generateAndStoreState({ memberId: 'm', provider: 'slack' }), /requires clientId/);
  await assert.rejects(() => service.generateAndStoreState({ clientId: 'c', provider: 'slack' }), /requires memberId/);
  await assert.rejects(() => service.generateAndStoreState({ clientId: 'c', memberId: 'm' }), /requires provider/);
});

// ─────────────────────────────────────────────
// Consumption
// ─────────────────────────────────────────────

test('a valid state is consumed exactly once — binding client/member is preserved from the stored row', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createOauthStateService(client);

  const { rawState } = await service.generateAndStoreState({ clientId: 'client-a', memberId: 'member-a', provider: 'slack' });

  const first = await service.consumeState({ rawState, provider: 'slack' });
  assert.equal(first.status, 'consumed');
  assert.equal(first.clientId, 'client-a');
  assert.equal(first.memberId, 'member-a');

  const second = await service.consumeState({ rawState, provider: 'slack' });
  assert.equal(second.status, 'reused');
});

test('an unknown (never-issued) state is rejected as not_found', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createOauthStateService(client);

  const result = await service.consumeState({ rawState: generateRawState(), provider: 'slack' });
  assert.equal(result.status, 'not_found');
});

test('missing rawState is rejected as not_found without touching the database', async () => {
  const { client, calls } = createFakeSupabaseClient();
  const service = createOauthStateService(client);

  const result = await service.consumeState({ rawState: null, provider: 'slack' });
  assert.equal(result.status, 'not_found');
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.selects.length, 0);
});

test('an expired state is rejected as expired, not consumed', async () => {
  const { client, rows } = createFakeSupabaseClient();
  const service = createOauthStateService(client);

  const { rawState } = await service.generateAndStoreState({ clientId: 'client-a', memberId: 'member-a', provider: 'slack', ttlMs: 10 * 60 * 1000 });
  // Force expiry directly on the stored row.
  rows[0].expires_at = new Date(Date.now() - 1000).toISOString();

  const result = await service.consumeState({ rawState, provider: 'slack' });
  assert.equal(result.status, 'expired');
});

test('a state issued for a different provider is rejected as provider_mismatch', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createOauthStateService(client);

  const { rawState } = await service.generateAndStoreState({ clientId: 'client-a', memberId: 'member-a', provider: 'dropbox' });

  const result = await service.consumeState({ rawState, provider: 'slack' });
  assert.equal(result.status, 'provider_mismatch');
});

test('consumeState requires provider', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createOauthStateService(client);
  await assert.rejects(() => service.consumeState({ rawState: 'x' }), /requires provider/);
});

test('the atomic consume UPDATE is scoped by state_hash, provider, consumed_at IS NULL, and expires_at > now', async () => {
  const { client, calls } = createFakeSupabaseClient();
  const service = createOauthStateService(client);

  const { rawState } = await service.generateAndStoreState({ clientId: 'client-a', memberId: 'member-a', provider: 'slack' });
  await service.consumeState({ rawState, provider: 'slack' });

  assert.equal(calls.updates.length, 1);
  const call = calls.updates[0];
  assert.equal(call.filters.state_hash, hashState(rawState));
  assert.equal(call.filters.provider, 'slack');
  assert.equal(call.isFilters.consumed_at, null);
  assert.ok('expires_at' in call.gtFilters);
  assert.ok(call.payload.consumed_at, 'the update must set consumed_at');
});
