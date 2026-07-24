const test = require('node:test');
const assert = require('node:assert/strict');

// Minimal in-memory sessionStorage stub — portalCache.js references the bare
// `sessionStorage` global exactly as it would in a browser tab.
class MemoryStorage {
  constructor() { this._data = new Map(); }
  getItem(key) { return this._data.has(key) ? this._data.get(key) : null; }
  setItem(key, value) { this._data.set(key, String(value)); }
  removeItem(key) { this._data.delete(key); }
  key(index) { return Array.from(this._data.keys())[index] ?? null; }
  get length() { return this._data.size; }
}

function freshStorage() {
  const store = new MemoryStorage();
  global.sessionStorage = store;
  return store;
}

// Re-require per test file run is fine since the module has no top-level state
// of its own — every function reads `sessionStorage` fresh on each call.
const PortalCache = require('../public/portal/portalCache.js');

test('buildKey embeds clientId, memberId, and resource name', () => {
  const key = PortalCache.buildKey('client-a', 'member-1', 'documents');
  assert.equal(key, 'relativity:portal:v1:client-a:member-1:documents');
});

test('get() returns a valid, non-expired cache entry', () => {
  freshStorage();
  PortalCache.set('client-a', 'member-1', 'collections', [{ id: 'c1', name: 'Default' }]);
  const result = PortalCache.get('client-a', 'member-1', 'collections', 5 * 60 * 1000);
  assert.deepEqual(result, [{ id: 'c1', name: 'Default' }]);
});

test('get() rejects and removes an expired entry', () => {
  const store = freshStorage();
  const key = PortalCache.buildKey('client-a', 'member-1', 'documents');
  store.setItem(key, JSON.stringify({ version: 1, savedAt: Date.now() - 10 * 60 * 1000, data: [{ id: 'doc1' }] }));

  const result = PortalCache.get('client-a', 'member-1', 'documents', 2 * 60 * 1000);
  assert.equal(result, null);
  assert.equal(store.getItem(key), null);
});

test('get() fails safely on malformed JSON and removes the entry', () => {
  const store = freshStorage();
  const key = PortalCache.buildKey('client-a', 'member-1', 'documents');
  store.setItem(key, '{not valid json');

  const result = PortalCache.get('client-a', 'member-1', 'documents', 60000);
  assert.equal(result, null);
  assert.equal(store.getItem(key), null);
});

test('get() fails safely on a well-formed but wrong-shaped entry (missing fields / wrong version)', () => {
  const store = freshStorage();
  const key = PortalCache.buildKey('client-a', 'member-1', 'teamMembers');

  store.setItem(key, JSON.stringify({ savedAt: Date.now(), data: [] })); // missing version
  assert.equal(PortalCache.get('client-a', 'member-1', 'teamMembers', 60000), null);
  assert.equal(store.getItem(key), null);

  store.setItem(key, JSON.stringify({ version: 99, savedAt: Date.now(), data: [] })); // wrong version
  assert.equal(PortalCache.get('client-a', 'member-1', 'teamMembers', 60000), null);
  assert.equal(store.getItem(key), null);

  store.setItem(key, JSON.stringify({ version: 1, savedAt: 'not-a-number' })); // missing data, bad savedAt
  assert.equal(PortalCache.get('client-a', 'member-1', 'teamMembers', 60000), null);
  assert.equal(store.getItem(key), null);
});

test('set() writes an entry that includes both savedAt and version', () => {
  const store = freshStorage();
  PortalCache.set('client-a', 'member-1', 'documents', [{ id: 'doc1' }]);
  const key = PortalCache.buildKey('client-a', 'member-1', 'documents');
  const entry = JSON.parse(store.getItem(key));
  assert.equal(entry.version, PortalCache.VERSION);
  assert.equal(typeof entry.savedAt, 'number');
  assert.deepEqual(entry.data, [{ id: 'doc1' }]);
});

test('invalidate() removes only the targeted (clientId, memberId, resource) entry', () => {
  freshStorage();
  PortalCache.set('client-a', 'member-1', 'documents', ['docA']);
  PortalCache.set('client-a', 'member-1', 'collections', ['colA']);
  PortalCache.set('client-a', 'member-2', 'documents', ['docB']); // different member
  PortalCache.set('client-b', 'member-1', 'documents', ['docC']); // different client

  PortalCache.invalidate('client-a', 'member-1', 'documents');

  assert.equal(PortalCache.get('client-a', 'member-1', 'documents', 60000), null);
  assert.deepEqual(PortalCache.get('client-a', 'member-1', 'collections', 60000), ['colA']);
  assert.deepEqual(PortalCache.get('client-a', 'member-2', 'documents', 60000), ['docB']);
  assert.deepEqual(PortalCache.get('client-b', 'member-1', 'documents', 60000), ['docC']);
});

test('clearAll() removes only relativity portal cache entries, leaving unrelated storage untouched', () => {
  const store = freshStorage();
  PortalCache.set('client-a', 'member-1', 'documents', ['docA']);
  PortalCache.set('client-a', 'member-1', 'collections', ['colA']);
  store.setItem('some-other-apps-key', 'untouched');
  store.setItem('relativity-theme', 'dark'); // unrelated portal localStorage-style key, same app

  PortalCache.clearAll();

  assert.equal(PortalCache.get('client-a', 'member-1', 'documents', 60000), null);
  assert.equal(PortalCache.get('client-a', 'member-1', 'collections', 60000), null);
  assert.equal(store.getItem('some-other-apps-key'), 'untouched');
  assert.equal(store.getItem('relativity-theme'), 'dark');
});

test('staleWhileRevalidate() renders cached data before the background refresh completes', async () => {
  freshStorage();
  PortalCache.set('client-a', 'member-1', 'documents', ['cached-doc']);

  let resolveFetch;
  const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
  const renders = [];

  const swrPromise = PortalCache.staleWhileRevalidate({
    clientId: 'client-a', memberId: 'member-1', resource: 'documents', maxAgeMs: 60000,
    fetchFn: () => fetchPromise,
    onData: (data, meta) => renders.push({ data, meta }),
  });

  // Cached render must have already happened synchronously, before the fetch resolves.
  assert.equal(renders.length, 1);
  assert.deepEqual(renders[0].data, ['cached-doc']);
  assert.equal(renders[0].meta.fromCache, true);

  resolveFetch(['fresh-doc']);
  await swrPromise;
});

test('staleWhileRevalidate() replaces cached data with fresh data once the fetch resolves', async () => {
  freshStorage();
  PortalCache.set('client-a', 'member-1', 'documents', ['cached-doc']);
  const renders = [];

  await PortalCache.staleWhileRevalidate({
    clientId: 'client-a', memberId: 'member-1', resource: 'documents', maxAgeMs: 60000,
    fetchFn: async () => ['fresh-doc'],
    onData: (data, meta) => renders.push({ data, meta }),
  });

  assert.equal(renders.length, 2);
  assert.deepEqual(renders[1].data, ['fresh-doc']);
  assert.equal(renders[1].meta.fromCache, false);
  assert.deepEqual(PortalCache.get('client-a', 'member-1', 'documents', 60000), ['fresh-doc']);
});

test('staleWhileRevalidate() keeps showing cached data when the refresh fails', async () => {
  freshStorage();
  PortalCache.set('client-a', 'member-1', 'documents', ['cached-doc']);
  const renders = [];
  let errorCalled = false;

  await PortalCache.staleWhileRevalidate({
    clientId: 'client-a', memberId: 'member-1', resource: 'documents', maxAgeMs: 60000,
    fetchFn: async () => { throw new Error('network down'); },
    onData: (data, meta) => renders.push({ data, meta }),
    onError: () => { errorCalled = true; },
  });

  assert.equal(renders.length, 1); // only the cached render, no fresh render
  assert.equal(errorCalled, false);
  // Cache is untouched by the failed refresh.
  assert.deepEqual(PortalCache.get('client-a', 'member-1', 'documents', 60000), ['cached-doc']);
});

test('staleWhileRevalidate() calls onError and caches nothing when there is no cache and the fetch fails', async () => {
  freshStorage();
  const renders = [];
  let errorCalled = false;

  await PortalCache.staleWhileRevalidate({
    clientId: 'client-a', memberId: 'member-1', resource: 'documents', maxAgeMs: 60000,
    fetchFn: async () => { throw new Error('network down'); },
    onData: (data, meta) => renders.push({ data, meta }),
    onError: () => { errorCalled = true; },
  });

  assert.equal(renders.length, 0);
  assert.equal(errorCalled, true);
  assert.equal(PortalCache.get('client-a', 'member-1', 'documents', 60000), null);
});

test('staleWhileRevalidate() calls onLoading instead of onData when there is no cache to show', async () => {
  freshStorage();
  let loadingCalled = false;

  await PortalCache.staleWhileRevalidate({
    clientId: 'client-a', memberId: 'member-1', resource: 'documents', maxAgeMs: 60000,
    fetchFn: async () => ['fresh-doc'],
    onLoading: () => { loadingCalled = true; },
    onData: () => {},
  });

  assert.equal(loadingCalled, true);
});

test('staleWhileRevalidate() does not re-render when fresh data is identical to cached data (no flicker)', async () => {
  freshStorage();
  PortalCache.set('client-a', 'member-1', 'documents', ['same-doc']);
  const renders = [];

  await PortalCache.staleWhileRevalidate({
    clientId: 'client-a', memberId: 'member-1', resource: 'documents', maxAgeMs: 60000,
    fetchFn: async () => ['same-doc'],
    onData: (data, meta) => renders.push(meta),
  });

  assert.equal(renders.length, 1); // only the initial cached render
});

// ---- In-flight request deduplication ----

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('dedupedFetch: two simultaneous calls for the same key execute one fresh request', async () => {
  freshStorage();
  let callCount = 0;
  const d = deferred();
  const fetchFn = () => { callCount++; return d.promise; };

  // Both calls are issued before either settles — fetchFn itself only runs as
  // a microtask, so we resolve first and assert on the awaited outcome rather
  // than racing the assertion against that microtask.
  const p1 = PortalCache.dedupedFetch('dedup-two-simultaneous', fetchFn);
  const p2 = PortalCache.dedupedFetch('dedup-two-simultaneous', fetchFn);

  d.resolve('result');
  await Promise.all([p1, p2]);
  assert.equal(callCount, 1);
});

test('dedupedFetch: both callers receive the same result', async () => {
  freshStorage();
  const d = deferred();
  const fetchFn = () => d.promise;

  const p1 = PortalCache.dedupedFetch('dedup-same-result', fetchFn);
  const p2 = PortalCache.dedupedFetch('dedup-same-result', fetchFn);

  d.resolve({ value: 'shared-result' });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, { value: 'shared-result' });
  assert.deepEqual(r2, { value: 'shared-result' });
});

test('dedupedFetch: three simultaneous calls for the same key still execute one request', async () => {
  freshStorage();
  let callCount = 0;
  const d = deferred();
  const fetchFn = () => { callCount++; return d.promise; };

  const p1 = PortalCache.dedupedFetch('dedup-three-simultaneous', fetchFn);
  const p2 = PortalCache.dedupedFetch('dedup-three-simultaneous', fetchFn);
  const p3 = PortalCache.dedupedFetch('dedup-three-simultaneous', fetchFn);

  d.resolve('result');
  await Promise.all([p1, p2, p3]);
  assert.equal(callCount, 1);
});

test('dedupedFetch: different resource keys execute separate requests', async () => {
  freshStorage();
  let callCount = 0;
  const fetchFn = async () => { callCount++; return 'result'; };

  const keyDocuments = PortalCache.buildKey('client-a', 'member-1', 'documents');
  const keyCollections = PortalCache.buildKey('client-a', 'member-1', 'collections');

  await Promise.all([
    PortalCache.dedupedFetch(keyDocuments, fetchFn),
    PortalCache.dedupedFetch(keyCollections, fetchFn),
  ]);

  assert.equal(callCount, 2);
});

test('dedupedFetch: different client IDs execute separate requests', async () => {
  freshStorage();
  let callCount = 0;
  const fetchFn = async () => { callCount++; return 'result'; };

  const keyClientA = PortalCache.buildKey('client-a', 'member-1', 'documents');
  const keyClientB = PortalCache.buildKey('client-b', 'member-1', 'documents');

  await Promise.all([
    PortalCache.dedupedFetch(keyClientA, fetchFn),
    PortalCache.dedupedFetch(keyClientB, fetchFn),
  ]);

  assert.equal(callCount, 2);
});

test('dedupedFetch: different member IDs execute separate requests', async () => {
  freshStorage();
  let callCount = 0;
  const fetchFn = async () => { callCount++; return 'result'; };

  const keyMember1 = PortalCache.buildKey('client-a', 'member-1', 'documents');
  const keyMember2 = PortalCache.buildKey('client-a', 'member-2', 'documents');

  await Promise.all([
    PortalCache.dedupedFetch(keyMember1, fetchFn),
    PortalCache.dedupedFetch(keyMember2, fetchFn),
  ]);

  assert.equal(callCount, 2);
});

test('dedupedFetch: the in-flight entry is removed after success', async () => {
  freshStorage();
  let callCount = 0;
  const fetchFn = async () => { callCount++; return 'result'; };

  await PortalCache.dedupedFetch('dedup-removed-after-success', fetchFn);
  assert.equal(callCount, 1);

  // A second call after the first has fully settled must invoke fetchFn again —
  // proving the in-flight map entry was cleaned up, not left dangling.
  await PortalCache.dedupedFetch('dedup-removed-after-success', fetchFn);
  assert.equal(callCount, 2);
});

test('dedupedFetch: the in-flight entry is removed after failure', async () => {
  freshStorage();
  const failingFetchFn = async () => { throw new Error('network down'); };
  let succeedCallCount = 0;
  const succeedingFetchFn = async () => { succeedCallCount++; return 'result'; };

  await assert.rejects(() => PortalCache.dedupedFetch('dedup-removed-after-failure', failingFetchFn));

  // A failed request must not remain permanently cached as an in-flight Promise —
  // the next call for the same key must run its own fetchFn, not reuse the rejection.
  const result = await PortalCache.dedupedFetch('dedup-removed-after-failure', succeedingFetchFn);
  assert.equal(succeedCallCount, 1);
  assert.equal(result, 'result');
});

test('dedupedFetch: a later call after completion starts a new (independent) request', async () => {
  freshStorage();
  let callCount = 0;
  const fetchFn = async () => { callCount++; return `result-${callCount}`; };

  const first = await PortalCache.dedupedFetch('dedup-later-call-is-new', fetchFn);
  const second = await PortalCache.dedupedFetch('dedup-later-call-is-new', fetchFn);

  assert.equal(first, 'result-1');
  assert.equal(second, 'result-2'); // proves the second call was a genuinely new request
  assert.equal(callCount, 2);
});

test('staleWhileRevalidate: cache-first behavior still works when two concurrent callers share a request', async () => {
  freshStorage();
  PortalCache.set('client-a', 'member-1', 'teamMembers', ['cached-member']);

  let fetchCallCount = 0;
  const d = deferred();
  const fetchFn = () => { fetchCallCount++; return d.promise; };

  const rendersA = [];
  const rendersB = [];

  // Simulates loadMembers() and loadTeamMembers() firing at bootstrap for the
  // same underlying /api/team/members resource at nearly the same time.
  const p1 = PortalCache.staleWhileRevalidate({
    clientId: 'client-a', memberId: 'member-1', resource: 'teamMembers', maxAgeMs: 60000,
    fetchFn,
    onData: (data, meta) => rendersA.push({ data, meta }),
  });
  const p2 = PortalCache.staleWhileRevalidate({
    clientId: 'client-a', memberId: 'member-1', resource: 'teamMembers', maxAgeMs: 60000,
    fetchFn,
    onData: (data, meta) => rendersB.push({ data, meta }),
  });

  // Both callers render cached data immediately, synchronously, before the
  // shared background fetch resolves.
  assert.equal(rendersA.length, 1);
  assert.deepEqual(rendersA[0].data, ['cached-member']);
  assert.equal(rendersA[0].meta.fromCache, true);
  assert.equal(rendersB.length, 1);
  assert.deepEqual(rendersB[0].data, ['cached-member']);
  assert.equal(rendersB[0].meta.fromCache, true);

  d.resolve(['fresh-member']);
  await Promise.all([p1, p2]);

  // Only one network request was made despite two concurrent callers.
  assert.equal(fetchCallCount, 1);
  // Both callers get the fresh re-render once the shared request resolves.
  assert.equal(rendersA.length, 2);
  assert.deepEqual(rendersA[1].data, ['fresh-member']);
  assert.equal(rendersB.length, 2);
  assert.deepEqual(rendersB[1].data, ['fresh-member']);
  // Cache reflects the fresh result.
  assert.deepEqual(PortalCache.get('client-a', 'member-1', 'teamMembers', 60000), ['fresh-member']);
});
