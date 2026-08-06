process.env.AIKB_API_BASE_URL = process.env.AIKB_API_BASE_URL || 'https://aikb.example.internal';
process.env.AIKB_API_KEY = process.env.AIKB_API_KEY || 'test-aikb-api-key';
process.env.SERVICE_REQUEST_SIGNING_SECRET = process.env.SERVICE_REQUEST_SIGNING_SECRET || 'test-service-request-secret';
process.env.AIKB_SUPABASE_URL = process.env.AIKB_SUPABASE_URL || 'https://example.supabase.co';
process.env.AIKB_SUPABASE_SERVICE_ROLE_KEY = process.env.AIKB_SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';

const test = require('node:test');
const assert = require('node:assert/strict');

// aikbService.js requires('axios') directly at module scope (no dependency
// injection seam, unlike aikbAskClient.js's createAikbAskClient({ httpClient })
// factory) — so its outbound /ingest POST is faked here by substituting a
// stub into require.cache before aikbService.js is first required, the same
// require.cache substitution technique aikb/test/aikbDatabaseProvider.test.js
// uses for @supabase/supabase-js. Storage, by contrast, gets a real DI seam
// (_setAikbSupabaseClientForTests) added alongside this test file, since a
// module-level require.cache swap can't easily vary per-test the way an
// injected fake client can.
let axiosPostHandler = async () => ({ status: 202, data: { queued: true } });
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath,
  filename: axiosPath,
  loaded: true,
  exports: {
    post: (...args) => axiosPostHandler(...args),
    get: async () => ({ data: {} }),
    patch: async () => ({ data: {} }),
    delete: async () => ({ data: {} }),
  },
};
delete require.cache[require.resolve('../config')];
delete require.cache[require.resolve('../services/aikbService')];

const aikbService = require('../services/aikbService');
const {
  uploadToStorage,
  uploadAndIngest,
  allowsStorageOverwrite,
  _setAikbSupabaseClientForTests,
  _resetAikbSupabaseClientForTests,
} = aikbService;

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Minimal fake of the subset of the Supabase Storage fluent API
 * uploadToStorage uses. existingPaths is shared/mutated across calls within
 * a test so repeat uploads to the same path can be simulated; a plain
 * upload({ upsert: false }) collision returns the same shape Supabase's real
 * client returns for "The resource already exists" (this repo's exact
 * pre-fix production error — see EM10_5_STAGING_CHECKLIST.md Bug #7
 * follow-up).
 */
function createFakeStorageClient({ existingPaths = new Set(), failWith = null } = {}) {
  const uploadCalls = [];
  const client = {
    storage: {
      from(bucket) {
        return {
          upload: async (path, _buffer, opts) => {
            uploadCalls.push({ bucket, path, opts });
            if (failWith) return { data: null, error: failWith };
            if (existingPaths.has(path) && !opts.upsert) {
              return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
            }
            existingPaths.add(path);
            return { data: { path }, error: null };
          },
        };
      },
    },
  };
  return { client, uploadCalls, existingPaths };
}

test.afterEach(() => {
  _resetAikbSupabaseClientForTests();
  axiosPostHandler = async () => ({ status: 202, data: { queued: true } });
});

// --- Pure policy tests -------------------------------------------------

test('allowsStorageOverwrite: gmail is the only stable-identity provider today', () => {
  assert.equal(allowsStorageOverwrite('gmail'), true);
  assert.equal(allowsStorageOverwrite('portal_upload'), false);
  assert.equal(allowsStorageOverwrite('google_drive'), false);
  assert.equal(allowsStorageOverwrite('dropbox'), false);
  assert.equal(allowsStorageOverwrite('microsoft'), false);
  assert.equal(allowsStorageOverwrite(undefined), false);
});

// --- Scenario 1: new Gmail message --------------------------------------

test('new Gmail message uploads successfully and calls AIKB ingest', async () => {
  const { client, uploadCalls } = createFakeStorageClient();
  _setAikbSupabaseClientForTests(client);
  let ingestCall = null;
  axiosPostHandler = async (url, body) => { ingestCall = { url, body }; return { status: 202, data: { queued: true } }; };

  await uploadAndIngest({
    clientId: CLIENT_ID,
    sourceFileId: 'gmail-msg-1',
    fileName: 'Weekly Sales Meeting Agenda.txt',
    mimeType: 'text/plain',
    fileBuffer: Buffer.from('hello'),
    sourceProvider: 'gmail',
    emailMetadata: { provider: 'gmail', providerAccountId: 'a@example.com', providerMessageId: 'gmail-msg-1' },
  });

  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0].opts.upsert, true, 'gmail uploads must pass upsert: true');
  assert.ok(ingestCall, 'AIKB ingest must have been called');
  assert.ok(ingestCall.url.endsWith('/api/knowledge/ingest'));
  assert.equal(ingestCall.body.payload.sourceFileId, 'gmail-msg-1');
});

// --- Scenario 2: same Gmail message re-uploaded to the same path --------

test('re-uploading the same Gmail message to the same path overwrites rather than throwing, and still calls AIKB ingest', async () => {
  const { client, uploadCalls } = createFakeStorageClient();
  _setAikbSupabaseClientForTests(client);
  let ingestCallCount = 0;
  axiosPostHandler = async () => { ingestCallCount += 1; return { status: 202, data: { queued: true } }; };

  const args = {
    clientId: CLIENT_ID,
    sourceFileId: 'gmail-msg-2',
    fileName: 'Customer Refund Policy.txt',
    mimeType: 'text/plain',
    fileBuffer: Buffer.from('body v1'),
    sourceProvider: 'gmail',
    emailMetadata: { provider: 'gmail', providerAccountId: 'a@example.com', providerMessageId: 'gmail-msg-2' },
  };

  await uploadAndIngest(args); // first upload — path is new
  await assert.doesNotReject(() => uploadAndIngest({ ...args, fileBuffer: Buffer.from('body v1') })); // second — path already exists

  assert.equal(uploadCalls.length, 2);
  assert.equal(uploadCalls[0].path, uploadCalls[1].path, 'both uploads must target the same deterministic path');
  assert.equal(uploadCalls[1].opts.upsert, true);
  assert.equal(ingestCallCount, 2, 'both uploads must reach AIKB — dedup is AIKB\'s decision, not Relativity\'s');
});

// --- Scenario 3: repeated Full Scan of unchanged content -----------------

test('repeated Gmail Full Scan of the same unchanged message succeeds every time and always reaches AIKB', async () => {
  const { client } = createFakeStorageClient();
  _setAikbSupabaseClientForTests(client);
  let ingestCallCount = 0;
  axiosPostHandler = async () => { ingestCallCount += 1; return { status: 202, data: { queued: true } }; };

  const args = {
    clientId: CLIENT_ID,
    sourceFileId: 'gmail-msg-3',
    fileName: 'Project Phoenix Onboarding SOP.txt',
    mimeType: 'text/plain',
    fileBuffer: Buffer.from('unchanged body'),
    sourceProvider: 'gmail',
    emailMetadata: { provider: 'gmail', providerAccountId: 'a@example.com', providerMessageId: 'gmail-msg-3' },
  };

  // Simulates three separate Full Scan runs over the same still-labeled,
  // never-modified message — historical Full Scan revisits every matching
  // message unconditionally (emailSyncService.js's runHistoricalPage has no
  // local pre-filter), so this is the ordinary/expected repeat-scan case,
  // not an edge case.
  for (let i = 0; i < 3; i++) {
    await assert.doesNotReject(() => uploadAndIngest(args), `scan #${i + 1} must not fail on the storage write`);
  }
  assert.equal(ingestCallCount, 3, 'every scan must leave the skip/rebuild decision to AIKB\'s downstream hash/status/chunk check');
});

// --- Scenario 4: deleted document re-imported with unchanged content -----

test('deleted Gmail document re-imported with unchanged content uploads successfully and reaches AIKB (lets the reindex fix run)', async () => {
  // existingPaths pre-seeded to represent the orphaned storage object left
  // behind by the pre-fix stale-hash bug (EM10.5 Bug #7): AIKB's early
  // return on that bug happened before upsertKnowledgeDocument, so the row
  // never reflected the new object, but the bytes were already there.
  const existingPaths = new Set([`uploads/${CLIENT_ID}/gmail-msg-4`]);
  const { client, uploadCalls } = createFakeStorageClient({ existingPaths });
  _setAikbSupabaseClientForTests(client);
  let ingestCall = null;
  axiosPostHandler = async (url, body) => { ingestCall = { url, body }; return { status: 202, data: { queued: true } }; };

  await assert.doesNotReject(() => uploadAndIngest({
    clientId: CLIENT_ID,
    sourceFileId: 'gmail-msg-4',
    fileName: 'Weekly Sales Meeting Agenda.txt',
    mimeType: 'text/plain',
    fileBuffer: Buffer.from('unchanged body'),
    sourceProvider: 'gmail',
    emailMetadata: { provider: 'gmail', providerAccountId: 'a@example.com', providerMessageId: 'gmail-msg-4' },
  }));

  assert.equal(uploadCalls[0].opts.upsert, true);
  assert.ok(ingestCall, 'the request must reach AIKB so canSkipUnchangedHash\'s status/chunk check can decide to rebuild it');
});

// --- Scenario 5: normal portal upload retains upsert: false --------------

test('normal portal upload with a fresh UUID source id retains upsert: false', async () => {
  const { client, uploadCalls } = createFakeStorageClient();
  _setAikbSupabaseClientForTests(client);
  axiosPostHandler = async () => ({ status: 202, data: { queued: true } });

  await uploadAndIngest({
    clientId: CLIENT_ID,
    sourceFileId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    fileName: 'handbook.pdf',
    mimeType: 'application/pdf',
    fileBuffer: Buffer.from('%PDF-1.4'),
    // sourceProvider omitted — defaults to 'portal_upload', as every real
    // portal-upload call site does.
  });

  assert.equal(uploadCalls[0].opts.upsert, false);
});

// --- Scenario 6: ZIP / Google Drive import collision behavior unchanged --

test('ZIP and Google Drive imports (portal_upload, fresh UUID) still collide loudly on a path that already exists', async () => {
  const existingPaths = new Set([`uploads/${CLIENT_ID}/dup-uuid`]);
  const { client } = createFakeStorageClient({ existingPaths });
  _setAikbSupabaseClientForTests(client);

  await assert.rejects(
    () => uploadToStorage(CLIENT_ID, 'dup-uuid', Buffer.from('x'), 'application/octet-stream', 'portal_upload'),
    /already exists/,
  );
});

// --- Scenario 7: a non-conflict Storage error still throws ---------------

test('a non-conflict Supabase Storage error (e.g. permission denied) still throws, even for gmail', async () => {
  const { client } = createFakeStorageClient({ failWith: { message: 'permission denied for bucket' } });
  _setAikbSupabaseClientForTests(client);
  let ingestCalled = false;
  axiosPostHandler = async () => { ingestCalled = true; return { status: 202, data: {} }; };

  await assert.rejects(
    () => uploadAndIngest({
      clientId: CLIENT_ID,
      sourceFileId: 'gmail-msg-err',
      fileName: 'x.txt',
      mimeType: 'text/plain',
      fileBuffer: Buffer.from('x'),
      sourceProvider: 'gmail',
      emailMetadata: { provider: 'gmail', providerAccountId: 'a@example.com', providerMessageId: 'gmail-msg-err' },
    }),
    /permission denied/,
  );
  assert.equal(ingestCalled, false, 'a genuine storage failure must never reach AIKB');
});

// --- Scenario 8: the exact pre-fix production error no longer fails ------

test('the exact pre-fix "The resource already exists" collision for a Gmail path no longer fails', async () => {
  const existingPaths = new Set([`uploads/${CLIENT_ID}/gmail-msg-orphan`]);
  const { client } = createFakeStorageClient({ existingPaths });
  _setAikbSupabaseClientForTests(client);
  axiosPostHandler = async () => ({ status: 202, data: { queued: true } });

  await assert.doesNotReject(() => uploadToStorage(
    CLIENT_ID, 'gmail-msg-orphan', Buffer.from('x'), 'text/plain', 'gmail',
  ));
});
