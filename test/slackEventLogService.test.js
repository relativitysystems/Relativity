const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlackEventLogService, STATUS } = require('../services/slackEventLogService');

/**
 * A minimal in-memory fake of the Supabase JS fluent query builder, scoped
 * to exactly what services/slackEventLogService.js uses (insert/select/
 * update/eq/in/lt/order/limit/maybeSingle/single). Simulates the real
 * UNIQUE (provider, external_event_id) constraint (Postgres error code
 * 23505) so insertReceived's dedup-on-conflict path is exercised against
 * real duplicate-detection semantics, not a canned response. This repo has
 * no test-database pattern (see services/oauthConnectionsService.js's test
 * file) — an in-memory fake table is used instead of a real Supabase call.
 */
function createFakeSlackEventLogTable() {
  let rows = [];
  let nextId = 1;

  function matches(row, filters) {
    return Object.entries(filters).every(([col, cond]) => {
      if (cond.op === 'eq') return row[col] === cond.value;
      if (cond.op === 'in') return cond.value.includes(row[col]);
      if (cond.op === 'lt') return row[col] < cond.value;
      return true;
    });
  }

  function makeBuilder() {
    const state = { operation: null, filters: {}, insertPayload: null, updatePayload: null, single: false, order: null, limit: null };
    const builder = {
      insert(payload) { state.operation = 'insert'; state.insertPayload = payload; return builder; },
      update(payload) { state.operation = 'update'; state.updatePayload = payload; return builder; },
      select() { if (!state.operation) state.operation = 'select'; return builder; },
      eq(col, val) { state.filters[col] = { op: 'eq', value: val }; return builder; },
      in(col, val) { state.filters[col] = { op: 'in', value: val }; return builder; },
      lt(col, val) { state.filters[col] = { op: 'lt', value: val }; return builder; },
      order() { return builder; },
      limit(n) { state.limit = n; return builder; },
      maybeSingle() { state.single = 'maybe'; return builder; },
      single() { state.single = 'strict'; return builder; },
      then(resolve, reject) {
        try {
          resolve(execute());
        } catch (err) {
          reject(err);
        }
      },
    };

    function execute() {
      if (state.operation === 'insert') {
        const conflict = rows.find((r) => r.provider === state.insertPayload.provider && r.external_event_id === state.insertPayload.external_event_id);
        if (conflict) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
        const row = { id: String(nextId++), attempt_count: 0, ...state.insertPayload };
        rows.push(row);
        return { data: row, error: null };
      }

      if (state.operation === 'update') {
        const matched = rows.filter((r) => matches(r, state.filters));
        if (state.single === 'maybe' || state.single === 'strict') {
          if (matched.length === 0) return { data: null, error: null };
          Object.assign(matched[0], state.updatePayload);
          return { data: matched[0], error: null };
        }
        matched.forEach((r) => Object.assign(r, state.updatePayload));
        return { data: matched, error: null };
      }

      // select
      let matched = rows.filter((r) => matches(r, state.filters));
      if (typeof state.limit === 'number') matched = matched.slice(0, state.limit);
      if (state.single === 'maybe' || state.single === 'strict') {
        return { data: matched[0] || null, error: null };
      }
      return { data: matched, error: null };
    }

    return builder;
  }

  const client = { from: () => makeBuilder() };
  return { client, getRows: () => rows, reset: () => { rows = []; nextId = 1; } };
}

const BASE_ROW = {
  externalEventId: 'Ev001',
  clientId: 'client-1',
  connectionId: 'conn-1',
  eventType: 'app_mention',
  channelId: 'C1',
  eventTs: '1700000000.000000',
  threadTs: null,
  question: 'What is our PTO policy?',
  idempotencyKey: 'slack:Ev001',
};

test('first delivery of an event_id inserts and returns inserted: true', async () => {
  const { client } = createFakeSlackEventLogTable();
  const service = createSlackEventLogService(client);

  const result = await service.insertReceived(BASE_ROW);
  assert.equal(result.inserted, true);
  assert.equal(result.row.status, STATUS.RECEIVED);
  assert.equal(result.row.external_event_id, 'Ev001');
});

test('a redelivered event_id hits the unique constraint and returns the existing row instead of throwing', async () => {
  const { client } = createFakeSlackEventLogTable();
  const service = createSlackEventLogService(client);

  const first = await service.insertReceived(BASE_ROW);
  const second = await service.insertReceived(BASE_ROW);

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.row.id, first.row.id);
});

test('concurrent duplicate inserts: only one wins, both callers get a consistent row back', async () => {
  const { client } = createFakeSlackEventLogTable();
  const service = createSlackEventLogService(client);

  const [a, b] = await Promise.all([
    service.insertReceived(BASE_ROW),
    service.insertReceived(BASE_ROW),
  ]);

  const insertedCount = [a, b].filter((r) => r.inserted).length;
  assert.equal(insertedCount, 1);
  assert.equal(a.row.id, b.row.id);
});

test('markEnqueued only transitions a received row, and reports which', async () => {
  const { client } = createFakeSlackEventLogTable();
  const service = createSlackEventLogService(client);
  const { row } = await service.insertReceived(BASE_ROW);

  const updated = await service.markEnqueued(row.id);
  assert.equal(updated.status, STATUS.ENQUEUED);
});

test('claimForDelivery ("only the first delivery attempt proceeds"): second concurrent claim is a no-op', async () => {
  const { client } = createFakeSlackEventLogTable();
  const service = createSlackEventLogService(client);
  const { row } = await service.insertReceived(BASE_ROW);
  await service.markEnqueued(row.id);

  const [claimA, claimB] = await Promise.all([
    service.claimForDelivery(row.id),
    service.claimForDelivery(row.id),
  ]);

  const wonCount = [claimA, claimB].filter(Boolean).length;
  assert.equal(wonCount, 1, 'exactly one concurrent claim should succeed');
});

test('claimForDelivery is a no-op on a row still in "received" (never skipped straight to answered)', async () => {
  const { client } = createFakeSlackEventLogTable();
  const service = createSlackEventLogService(client);
  const { row } = await service.insertReceived(BASE_ROW);

  const claimed = await service.claimForDelivery(row.id);
  assert.equal(claimed, null);
});

test('a delivered row can never be re-claimed or re-marked delivered', async () => {
  const { client } = createFakeSlackEventLogTable();
  const service = createSlackEventLogService(client);
  const { row } = await service.insertReceived(BASE_ROW);
  await service.markEnqueued(row.id);
  await service.claimForDelivery(row.id);
  await service.markDelivered(row.id);

  const secondClaim = await service.claimForDelivery(row.id);
  assert.equal(secondClaim, null);
});

test('markFailed records a safe error code and attempt count, never a raw message', async () => {
  const { client } = createFakeSlackEventLogTable();
  const service = createSlackEventLogService(client);
  const { row } = await service.insertReceived(BASE_ROW);

  const failed = await service.markFailed(row.id, { errorCode: 'AIKB_TIMEOUT', attemptCount: 3 });
  assert.equal(failed.status, STATUS.FAILED);
  assert.equal(failed.error_code, 'AIKB_TIMEOUT');
  assert.equal(failed.attempt_count, 3);
});

test('getByIdempotencyKey finds the row created for that key', async () => {
  const { client } = createFakeSlackEventLogTable();
  const service = createSlackEventLogService(client);
  await service.insertReceived(BASE_ROW);

  const found = await service.getByIdempotencyKey('slack:Ev001');
  assert.ok(found);
  assert.equal(found.idempotency_key, 'slack:Ev001');
});

test('listStuckForRetry only returns received/enqueued rows past the stale threshold, under the attempt cap', async () => {
  const { client } = createFakeSlackEventLogTable();
  const service = createSlackEventLogService(client);

  const stale = new Date(Date.now() - 60_000).toISOString();
  const fresh = new Date().toISOString();

  const { row: staleReceived } = await service.insertReceived({ ...BASE_ROW, externalEventId: 'Ev-stale', idempotencyKey: 'slack:Ev-stale' });
  staleReceived.received_at = stale;
  const { row: freshReceived } = await service.insertReceived({ ...BASE_ROW, externalEventId: 'Ev-fresh', idempotencyKey: 'slack:Ev-fresh' });
  freshReceived.received_at = fresh;
  const { row: staleDelivered } = await service.insertReceived({ ...BASE_ROW, externalEventId: 'Ev-delivered', idempotencyKey: 'slack:Ev-delivered' });
  staleDelivered.received_at = stale;
  staleDelivered.status = STATUS.DELIVERED;

  const stuck = await service.listStuckForRetry({ staleAfterMs: 30_000, maxAttempts: 3 });
  const ids = stuck.map((r) => r.external_event_id);

  assert.ok(ids.includes('Ev-stale'));
  assert.ok(!ids.includes('Ev-fresh'), 'fresh rows should not be retried yet');
  assert.ok(!ids.includes('Ev-delivered'), 'a delivered row must never be reprocessed by the sweep');
});
