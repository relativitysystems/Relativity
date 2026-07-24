// Small stale-while-revalidate cache for the client portal, backed by sessionStorage
// (per-tab, cleared when the tab closes — see architecture/PORTAL_FRONTEND_CACHE.md).
// Loaded as a plain <script> in portal.html, and required directly from node:test files.
(function (global) {
  'use strict';

  var KEY_PREFIX = 'relativity:portal:v1:';
  var ENTRY_VERSION = 1;

  // In-memory only — never persisted to sessionStorage. Tracks the single
  // Promise currently fetching fresh data for a given (clientId, memberId,
  // resource) key, so concurrent SWR callers for the same key share one
  // underlying network request instead of each firing their own.
  var inFlightRequests = new Map();

  function buildKey(clientId, memberId, resource) {
    return KEY_PREFIX + clientId + ':' + memberId + ':' + resource;
  }

  function safeRemove(key) {
    try { sessionStorage.removeItem(key); } catch (e) { /* storage unavailable */ }
  }

  function get(clientId, memberId, resource, maxAgeMs) {
    var key = buildKey(clientId, memberId, resource);
    var raw;
    try {
      raw = sessionStorage.getItem(key);
    } catch (e) {
      return null;
    }
    if (!raw) return null;

    var entry;
    try {
      entry = JSON.parse(raw);
    } catch (e) {
      safeRemove(key);
      return null;
    }

    if (
      !entry || typeof entry !== 'object' ||
      entry.version !== ENTRY_VERSION ||
      typeof entry.savedAt !== 'number' ||
      !('data' in entry)
    ) {
      safeRemove(key);
      return null;
    }

    if (Date.now() - entry.savedAt > maxAgeMs) {
      safeRemove(key);
      return null;
    }

    return entry.data;
  }

  function set(clientId, memberId, resource, data) {
    var key = buildKey(clientId, memberId, resource);
    var entry = { version: ENTRY_VERSION, savedAt: Date.now(), data: data };
    try {
      sessionStorage.setItem(key, JSON.stringify(entry));
    } catch (e) {
      // sessionStorage full/unavailable — caching is a pure optimization, safe to skip
    }
  }

  function invalidate(clientId, memberId, resource) {
    safeRemove(buildKey(clientId, memberId, resource));
  }

  // Runs fetchFn at most once per `key` while a call for that key is pending.
  // Any additional caller made before the first resolves/rejects gets the
  // exact same Promise (and therefore the same result), rather than starting
  // its own network request. The entry is always removed once the request
  // settles (success or failure), so the next call after that starts fresh.
  function dedupedFetch(key, fetchFn) {
    var existing = inFlightRequests.get(key);
    if (existing) return existing;

    var promise = Promise.resolve().then(fetchFn).finally(function () {
      inFlightRequests.delete(key);
    });
    inFlightRequests.set(key, promise);
    return promise;
  }

  function clearAll() {
    var store;
    try { store = sessionStorage; } catch (e) { return; }

    var keysToRemove = [];
    try {
      for (var i = 0; i < store.length; i++) {
        var k = store.key(i);
        if (k && k.indexOf(KEY_PREFIX) === 0) keysToRemove.push(k);
      }
    } catch (e) {
      return;
    }
    keysToRemove.forEach(safeRemove);
  }

  // Renders cached data immediately (if valid), then always fetches fresh data in the
  // background, writes it to cache, and re-renders — unless it's identical to what the
  // cache already showed. Falls back to today's plain loading/error behavior when there
  // is no valid cache entry.
  async function staleWhileRevalidate(opts) {
    var clientId = opts.clientId;
    var memberId = opts.memberId;
    var resource = opts.resource;
    var maxAgeMs = opts.maxAgeMs;
    var fetchFn = opts.fetchFn;
    var onData = opts.onData;
    var onError = opts.onError;
    var onLoading = opts.onLoading;

    var cached = get(clientId, memberId, resource, maxAgeMs);
    var hadCache = cached !== null;
    if (hadCache) {
      onData(cached, { fromCache: true });
    } else if (onLoading) {
      // No valid cache to show immediately — preserve today's loading state.
      onLoading();
    }

    try {
      var key = buildKey(clientId, memberId, resource);
      var fresh = await dedupedFetch(key, fetchFn);
      set(clientId, memberId, resource, fresh);
      if (!hadCache || JSON.stringify(fresh) !== JSON.stringify(cached)) {
        onData(fresh, { fromCache: false });
      }
      return fresh;
    } catch (err) {
      if (!hadCache && onError) onError(err);
      return hadCache ? cached : null;
    }
  }

  var PortalCache = {
    VERSION: ENTRY_VERSION,
    KEY_PREFIX: KEY_PREFIX,
    buildKey: buildKey,
    get: get,
    set: set,
    invalidate: invalidate,
    clearAll: clearAll,
    dedupedFetch: dedupedFetch,
    staleWhileRevalidate: staleWhileRevalidate,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = PortalCache;
  } else {
    global.PortalCache = PortalCache;
  }
})(typeof self !== 'undefined' ? self : this);
