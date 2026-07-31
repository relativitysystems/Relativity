const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createSlackUserLinkService, hashCode, generateRawCode, normalizeCode, CODE_ALPHABET, CODE_LENGTH, DEFAULT_TTL_MS,
} = require('../services/slackUserLinkService');

/**
 * A minimal fake of the Supabase JS fluent query builder subset used by
 * services/slackUserLinkService.js (insert / update / upsert / select /
 * eq / is / gt / maybeSingle), covering both tables it touches
 * (slack_link_codes, slack_user_links). Mirrors
 * test/oauthStateService.test.js's own fake exactly, extended with
 * upsert() and per-table row stores.
 */
function createFakeSupabaseClient() {
  const tables = { slack_link_codes: [], slack_user_links: [] };
  const calls = { inserts: [], updates: [], upserts: [], selects: [] };

  function makeBuilder(table) {
    const rows = tables[table];
    const state = { table, operation: 'select', filters: {}, gtFilters: {}, isFilters: {}, payload: null, onConflict: null };
    const builder = {
      insert(payload) { state.operation = 'insert'; state.payload = payload; return builder; },
      update(payload) { state.operation = 'update'; state.payload = payload; return builder; },
      upsert(payload, opts) { state.operation = 'upsert'; state.payload = payload; state.onConflict = opts && opts.onConflict; return builder; },
      select() { return builder; },
      eq(col, val) { state.filters[col] = val; return builder; },
      is(col, val) { state.isFilters[col] = val; return builder; },
      gt(col, val) { state.gtFilters[col] = val; return builder; },
      maybeSingle() { return resolve(); },
      then(resolve_, reject_) { return resolve().then(resolve_, reject_); },
    };

    function matches(r) {
      for (const [k, v] of Object.entries(state.filters)) if (r[k] !== v) return false;
      for (const [k, v] of Object.entries(state.isFilters)) if (r[k] !== v) return false;
      for (const [k, v] of Object.entries(state.gtFilters)) if (!(r[k] > v)) return false;
      return true;
    }

    async function resolve() {
      if (state.operation === 'insert') {
        calls.inserts.push({ table, payload: state.payload });
        rows.push({ id: crypto.randomUUID(), created_at: new Date().toISOString(), consumed_at: null, ...state.payload });
        return { data: null, error: null };
      }

      if (state.operation === 'update') {
        calls.updates.push({ table, filters: { ...state.filters }, isFilters: { ...state.isFilters }, gtFilters: { ...state.gtFilters }, payload: state.payload });
        const match = rows.find(matches);
        if (!match) return { data: null, error: null };
        Object.assign(match, state.payload);
        return { data: { ...match }, error: null };
      }

      if (state.operation === 'upsert') {
        calls.upserts.push({ table, payload: state.payload, onConflict: state.onConflict });
        const conflictCols = (state.onConflict || '').split(',').filter(Boolean);
        const existing = conflictCols.length
          ? rows.find((r) => conflictCols.every((c) => r[c] === state.payload[c]))
          : null;
        if (existing) {
          Object.assign(existing, state.payload);
        } else {
          rows.push({ id: crypto.randomUUID(), ...state.payload });
        }
        return { data: null, error: null };
      }

      // select
      calls.selects.push({ table, filters: { ...state.filters } });
      const match = rows.find(matches);
      return { data: match ? { ...match } : null, error: null };
    }

    return builder;
  }

  return { client: { from: (table) => makeBuilder(table) }, calls, tables };
}

// ─────────────────────────────────────────────
// Code generation
// ─────────────────────────────────────────────

test('generateRawCode produces CODE_LENGTH characters, only from CODE_ALPHABET, different every call', () => {
  const a = generateRawCode();
  const b = generateRawCode();
  assert.equal(a.length, CODE_LENGTH);
  assert.notEqual(a, b);
  for (const ch of a) assert.ok(CODE_ALPHABET.includes(ch), `"${ch}" must be in CODE_ALPHABET`);
});

test('CODE_ALPHABET excludes visually ambiguous characters (0/O, 1/I/L)', () => {
  for (const ch of ['0', 'O', '1', 'I', 'L']) assert.equal(CODE_ALPHABET.includes(ch), false);
});

test('hashCode is deterministic and different codes hash differently', () => {
  const raw = generateRawCode();
  assert.equal(hashCode(raw), hashCode(raw));
  assert.notEqual(hashCode(raw), hashCode(generateRawCode()));
});

test('normalizeCode uppercases, strips non-alphanumeric, and is safe on non-string input', () => {
  assert.equal(normalizeCode(' k7xq-2p9m '), 'K7XQ2P9M');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode(undefined), '');
});

// ─────────────────────────────────────────────
// generateLinkCode
// ─────────────────────────────────────────────

test('generateLinkCode persists only the hash — the raw code never appears in the stored row', async () => {
  const { client, calls } = createFakeSupabaseClient();
  const service = createSlackUserLinkService(client);

  const { code, expiresAt } = await service.generateLinkCode({ clientId: 'client-a', memberId: 'member-a' });

  assert.equal(code.length, CODE_LENGTH);
  assert.ok(expiresAt);
  assert.equal(calls.inserts.length, 1);
  const inserted = calls.inserts[0].payload;
  assert.equal(inserted.code_hash, hashCode(code));
  assert.equal(JSON.stringify(inserted).includes(code), false, 'the raw code must never be written to the database');
  assert.equal(inserted.client_id, 'client-a');
  assert.equal(inserted.member_id, 'member-a');
});

test('generateLinkCode expires roughly 10 minutes from now by default', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createSlackUserLinkService(client);
  const before = Date.now();

  const { expiresAt } = await service.generateLinkCode({ clientId: 'client-a', memberId: 'member-a' });

  const deltaMs = new Date(expiresAt).getTime() - before;
  assert.equal(DEFAULT_TTL_MS, 10 * 60 * 1000);
  assert.ok(deltaMs > DEFAULT_TTL_MS - 2000 && deltaMs <= DEFAULT_TTL_MS + 2000);
});

test('generateLinkCode requires clientId/memberId', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createSlackUserLinkService(client);
  await assert.rejects(() => service.generateLinkCode({ memberId: 'm' }), /requires clientId/);
  await assert.rejects(() => service.generateLinkCode({ clientId: 'c' }), /requires memberId/);
});

// ─────────────────────────────────────────────
// completeLink — the milestone's own explicit test list: successful link,
// expired/reused code, re-linking replaces the prior link, cross-client
// isolation.
// ─────────────────────────────────────────────

test('a valid code links the Slack user to the member who generated it', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createSlackUserLinkService(client);
  const { code } = await service.generateLinkCode({ clientId: 'client-a', memberId: 'member-a' });

  const result = await service.completeLink({ rawCode: code, clientId: 'client-a', slackTeamId: 'T1', slackUserId: 'U1' });

  assert.equal(result.status, 'linked');
  assert.equal(result.clientId, 'client-a');
  assert.equal(result.memberId, 'member-a');

  const linked = await service.getLinkedMember({ clientId: 'client-a', slackUserId: 'U1' });
  assert.equal(linked.member_id, 'member-a');
});

test('completeLink is case/whitespace tolerant — a lowercase, spaced-out code still links', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createSlackUserLinkService(client);
  const { code } = await service.generateLinkCode({ clientId: 'client-a', memberId: 'member-a' });

  const result = await service.completeLink({ rawCode: ` ${code.toLowerCase()} `, clientId: 'client-a', slackTeamId: 'T1', slackUserId: 'U1' });
  assert.equal(result.status, 'linked');
});

test('a code is single-use — the second completeLink attempt is rejected as reused', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createSlackUserLinkService(client);
  const { code } = await service.generateLinkCode({ clientId: 'client-a', memberId: 'member-a' });

  const first = await service.completeLink({ rawCode: code, clientId: 'client-a', slackTeamId: 'T1', slackUserId: 'U1' });
  assert.equal(first.status, 'linked');

  const second = await service.completeLink({ rawCode: code, clientId: 'client-a', slackTeamId: 'T1', slackUserId: 'U2' });
  assert.equal(second.status, 'reused');
});

test('an unknown (never-issued) code is rejected as not_found', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createSlackUserLinkService(client);

  const result = await service.completeLink({ rawCode: generateRawCode(), clientId: 'client-a', slackTeamId: 'T1', slackUserId: 'U1' });
  assert.equal(result.status, 'not_found');
});

test('an empty/missing code is rejected as not_found without touching the database', async () => {
  const { client, calls } = createFakeSupabaseClient();
  const service = createSlackUserLinkService(client);

  const result = await service.completeLink({ rawCode: '   ', clientId: 'client-a', slackTeamId: 'T1', slackUserId: 'U1' });
  assert.equal(result.status, 'not_found');
  assert.equal(calls.updates.length, 0);
});

test('an expired code is rejected as expired, not linked', async () => {
  const { client, tables } = createFakeSupabaseClient();
  const service = createSlackUserLinkService(client);
  const { code } = await service.generateLinkCode({ clientId: 'client-a', memberId: 'member-a' });
  tables.slack_link_codes[0].expires_at = new Date(Date.now() - 1000).toISOString();

  const result = await service.completeLink({ rawCode: code, clientId: 'client-a', slackTeamId: 'T1', slackUserId: 'U1' });
  assert.equal(result.status, 'expired');
});

test('cross-client isolation: a code generated for one client is rejected (and burned) if submitted under a different client\'s workspace', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createSlackUserLinkService(client);
  const { code } = await service.generateLinkCode({ clientId: 'client-a', memberId: 'member-a' });

  const result = await service.completeLink({ rawCode: code, clientId: 'client-b', slackTeamId: 'T-other', slackUserId: 'U1' });
  assert.equal(result.status, 'client_mismatch');

  // The code is burned regardless — no retry under the correct client either.
  const retry = await service.completeLink({ rawCode: code, clientId: 'client-a', slackTeamId: 'T1', slackUserId: 'U1' });
  assert.equal(retry.status, 'reused');

  const linked = await service.getLinkedMember({ clientId: 'client-b', slackUserId: 'U1' });
  assert.equal(linked, null, 'no link must be created for the mismatched client');
});

test('re-linking a Slack user id replaces, never appends to, any prior link for that id', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createSlackUserLinkService(client);

  const code1 = await service.generateLinkCode({ clientId: 'client-a', memberId: 'member-a' });
  await service.completeLink({ rawCode: code1.code, clientId: 'client-a', slackTeamId: 'T1', slackUserId: 'U1' });

  const code2 = await service.generateLinkCode({ clientId: 'client-a', memberId: 'member-b' });
  const result = await service.completeLink({ rawCode: code2.code, clientId: 'client-a', slackTeamId: 'T1', slackUserId: 'U1' });
  assert.equal(result.status, 'linked');
  assert.equal(result.memberId, 'member-b');

  const linked = await service.getLinkedMember({ clientId: 'client-a', slackUserId: 'U1' });
  assert.equal(linked.member_id, 'member-b', 'the new link must replace the old one, not coexist with it');
});

test('completeLink requires clientId/slackTeamId/slackUserId', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createSlackUserLinkService(client);
  await assert.rejects(() => service.completeLink({ rawCode: 'x', slackTeamId: 'T1', slackUserId: 'U1' }), /requires clientId/);
  await assert.rejects(() => service.completeLink({ rawCode: 'x', clientId: 'c', slackUserId: 'U1' }), /requires slackTeamId/);
  await assert.rejects(() => service.completeLink({ rawCode: 'x', clientId: 'c', slackTeamId: 'T1' }), /requires slackUserId/);
});

// ─────────────────────────────────────────────
// getLinkedMember
// ─────────────────────────────────────────────

test('getLinkedMember returns null for an unlinked Slack user, never throws', async () => {
  const { client } = createFakeSupabaseClient();
  const service = createSlackUserLinkService(client);
  const result = await service.getLinkedMember({ clientId: 'client-a', slackUserId: 'U-never-linked' });
  assert.equal(result, null);
});
