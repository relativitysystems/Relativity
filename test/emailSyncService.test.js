'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createEmailSyncService,
  assertSyncAllowed,
  ERROR_CODES,
  HISTORICAL_PAGE_SIZE,
} = require('../services/emailSyncService');
const { compileSearchQuery } = require('../services/gmailService');
const { evaluateMessageAgainstPolicy } = require('../services/emailPolicyService');
const { normalizeEmailBody } = require('../services/emailNormalizationService');

// Mirrors test/emailPreviewService.test.js's fixture convention: the real,
// pure compileSearchQuery/evaluateMessageAgainstPolicy/normalizeEmailBody
// functions are used unmodified (imported directly, not re-faked) — only
// the network-shaped gmailService/aikbService calls and the DB-backed
// emailSyncRepo are faked, so these tests exercise real policy/normalization
// logic against a fixture "mailbox."

const MANAGED_LABEL_ID = 'Label_managed_1';
const LABELS = [
  { id: MANAGED_LABEL_ID, name: 'Relativity/Knowledge' },
  { id: 'Label_finance', name: 'finance' },
  { id: 'Label_payroll', name: 'finance/payroll' },
  { id: 'INBOX', name: 'INBOX' },
];

const ALLOW_FINANCE = { id: 'rule-1', ruleType: 'allow', labelOrFolder: 'finance', enabled: true };
const DENY_PAYROLL = { id: 'rule-2', ruleType: 'deny', labelOrFolder: 'finance/payroll', enabled: true };

function fixtureConnection(overrides = {}) {
  return {
    id: 'conn-1',
    member_id: 'member-1',
    mailbox_address: 'sam@client.com',
    sync_mode: 'manual_selected',
    sync_enabled: true,
    managed_label_id: MANAGED_LABEL_ID,
    ...overrides,
  };
}

function fixtureGmailService({ pages = [], labels = LABELS, bodies = {}, calls = {} } = {}) {
  let pageCall = 0;
  return {
    compileSearchQuery,
    listMessageIdsByQuery: async ({ query, pageToken }) => {
      calls.listMessageIdsByQuery = calls.listMessageIdsByQuery || [];
      calls.listMessageIdsByQuery.push({ query, pageToken });
      const page = pages[pageCall] || { messages: [], nextPageToken: null };
      pageCall++;
      return { messageIds: page.messages.map((m) => m.id), nextPageToken: page.nextPageToken || null };
    },
    listLabels: async () => labels,
    getMessageMetadata: async ({ messageId }) => {
      const all = pages.flatMap((p) => p.messages);
      const m = all.find((x) => x.id === messageId);
      if (!m) throw new Error(`fixture: no metadata for ${messageId}`);
      return {
        messageId,
        threadId: m.threadId || `thread-${messageId}`,
        subject: m.subject,
        fromAddress: m.fromAddress,
        date: m.date || '2026-07-24T00:00:00Z',
        labelIds: m.labelIds || [],
        isSent: !!m.isSent,
      };
    },
    getMessageBody: async ({ messageId }) => {
      calls.getMessageBody = calls.getMessageBody || [];
      calls.getMessageBody.push(messageId);
      if (bodies[messageId] === undefined) throw new Error(`fixture: no body for ${messageId}`);
      return bodies[messageId];
    },
  };
}

function fixtureEmailPolicyService(rules) {
  return { getPolicy: async () => ({ rules }), evaluateMessageAgainstPolicy };
}

function fixtureAikbService({ documents = [], failIngestFor = new Set(), calls = {} } = {}) {
  calls.uploadAndIngest = [];
  calls.deleteDocumentById = [];
  return {
    listDocuments: async () => ({ documents }),
    uploadAndIngest: async (args) => {
      calls.uploadAndIngest.push(args);
      if (failIngestFor.has(args.sourceFileId)) throw new Error('AIKB ingest failed: simulated');
    },
    deleteDocumentById: async (clientId, documentId) => {
      calls.deleteDocumentById.push({ clientId, documentId });
    },
  };
}

function fixtureEmailSyncRepo({ previouslyIngested = [] } = {}) {
  const runs = new Map();
  const events = [];
  let nextId = 1;
  return {
    _runs: runs,
    _events: events,
    createSyncRun: async ({ clientId, emailConnectionId, runType, triggeredByMemberId }) => {
      const id = `run-${nextId++}`;
      const row = { id, clientId, emailConnectionId, runType, triggeredByMemberId, status: 'running' };
      runs.set(id, row);
      return row;
    },
    completeSyncRun: async (syncRunId, { status, counts, errorSummary }) => {
      const row = runs.get(syncRunId);
      if (row) Object.assign(row, { status, counts, errorSummary });
    },
    recordEvents: async (evts) => { events.push(...evts); },
    updateHistoricalImportStatus: async () => {},
    upsertSyncState: async () => {},
    getPreviouslyIngestedMessageIds: async () => previouslyIngested,
  };
}

function makeService({ pages, rules, labels, gmailCalls, bodies, documents, failIngestFor, aikbCalls, previouslyIngested, maxDocuments } = {}) {
  const emailSyncRepo = fixtureEmailSyncRepo({ previouslyIngested });
  const gmailService = fixtureGmailService({ pages, labels, bodies, calls: gmailCalls || {} });
  const aikbService = fixtureAikbService({ documents, failIngestFor, calls: aikbCalls || {} });
  const service = createEmailSyncService({
    gmailService,
    emailPolicyService: fixtureEmailPolicyService(rules),
    emailNormalizationService: { normalizeEmailBody },
    aikbService,
    emailSyncRepo,
    maxDocuments: maxDocuments || 50,
  });
  return { service, emailSyncRepo, gmailService, aikbService };
}

// ─────────────────────────────────────────────
// assertSyncAllowed — fail-closed connection-level gates
// ─────────────────────────────────────────────

test('assertSyncAllowed throws SEARCH_DISABLED when the member has search_enabled off', () => {
  assert.throws(
    () => assertSyncAllowed({ memberSearchEnabled: false, syncEnabled: true, syncMode: 'manual_selected' }),
    (err) => err.code === ERROR_CODES.SEARCH_DISABLED
  );
});

test('assertSyncAllowed throws SYNC_DISABLED when the connection itself is disabled', () => {
  assert.throws(
    () => assertSyncAllowed({ memberSearchEnabled: true, syncEnabled: false, syncMode: 'manual_selected' }),
    (err) => err.code === ERROR_CODES.SYNC_DISABLED
  );
});

test('assertSyncAllowed throws SYNC_PAUSED for a paused connection', () => {
  assert.throws(
    () => assertSyncAllowed({ memberSearchEnabled: true, syncEnabled: true, syncMode: 'paused' }),
    (err) => err.code === ERROR_CODES.SYNC_PAUSED
  );
});

test('assertSyncAllowed throws AUTOMATIC_SYNC_NOT_SUPPORTED for an automatic-mode connection (EM6 scope: manual only)', () => {
  assert.throws(
    () => assertSyncAllowed({ memberSearchEnabled: true, syncEnabled: true, syncMode: 'automatic' }),
    (err) => err.code === ERROR_CODES.AUTOMATIC_SYNC_NOT_SUPPORTED
  );
});

test('assertSyncAllowed does not throw for a healthy manual_selected connection', () => {
  assert.doesNotThrow(() => assertSyncAllowed({ memberSearchEnabled: true, syncEnabled: true, syncMode: 'manual_selected' }));
});

// ─────────────────────────────────────────────
// syncConnection — connection-level gates surface through the real call too
// ─────────────────────────────────────────────

test('syncConnection rejects before any Gmail call when search_enabled is false', async () => {
  const gmailCalls = {};
  const { service } = makeService({ pages: [], rules: [], gmailCalls });
  await assert.rejects(
    () => service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: false, accessToken: 't' }),
    (err) => err.code === ERROR_CODES.SEARCH_DISABLED
  );
  assert.equal(gmailCalls.listMessageIdsByQuery, undefined);
});

test('syncConnection rejects a connection whose sync_mode is automatic, before any Gmail call', async () => {
  const gmailCalls = {};
  const { service } = makeService({ pages: [], rules: [], gmailCalls });
  await assert.rejects(
    () => service.syncConnection({
      clientId: 'c1', emailConnectionRow: fixtureConnection({ sync_mode: 'automatic' }), memberSearchEnabled: true, accessToken: 't',
    }),
    (err) => err.code === ERROR_CODES.AUTOMATIC_SYNC_NOT_SUPPORTED
  );
  assert.equal(gmailCalls.listMessageIdsQuery, undefined);
});

test('syncConnection rejects when the client is already at the document limit, before creating a sync run or any Gmail call', async () => {
  const gmailCalls = {};
  const documents = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, status: 'indexed' }));
  const { service, emailSyncRepo } = makeService({ pages: [], rules: [], gmailCalls, documents, maxDocuments: 5 });
  await assert.rejects(
    () => service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' }),
    (err) => err.code === ERROR_CODES.DOCUMENT_LIMIT_REACHED
  );
  assert.equal(gmailCalls.listMessageIdsByQuery, undefined);
  assert.equal(emailSyncRepo._runs.size, 0);
});

// ─────────────────────────────────────────────
// Policy Evaluation Model — fail-closed (§16.1 item 6) and label gating
// ─────────────────────────────────────────────

test('empty organization policy: zero enabled allow rules ingests zero messages, even a labeled one', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Invoice', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }] }];
  const { service, aikbService: fakeAikb, emailSyncRepo } = makeService({ pages, rules: [] });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'No enabled organization allow rule matches this message.');
  const event = emailSyncRepo._events.find((e) => e.provider_message_id === 'm1');
  assert.equal(event.outcome, 'excluded_no_matching_rule');
});

test('manual mode: a policy-matching but UNLABELED message is excluded (label is necessary, not sufficient)', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Invoice', fromAddress: 'ap@vendor.com', labelIds: ['Label_finance'] }] }];
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE] });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped[0].reason, 'Message does not carry the Relativity/Knowledge label.');
});

test('a member labeling an email outside organization policy still imports nothing (labeling is never an authorization override)', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Random', fromAddress: 'someone@random.com', labelIds: [MANAGED_LABEL_ID] }] }];
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE] });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
});

test('deny always overrides allow, even with the label present', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Payroll run', fromAddress: 'hr@client.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance', 'Label_payroll'] }] }];
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE, DENY_PAYROLL], bodies: {} });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped[0].reason.includes('deny rule'), true);
});

// ─────────────────────────────────────────────
// Successful ingest path
// ─────────────────────────────────────────────

test('an eligible, labeled, policy-matching message is normalized and forwarded to AIKB with the right emailMetadata shape', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Invoice #42', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'], date: '2026-01-05T10:00:00Z' }] }];
  const bodies = { m1: { html: '<p>Please see attached invoice.</p>' } };
  const aikbCalls = {};
  const { service, emailSyncRepo } = makeService({ pages, rules: [ALLOW_FINANCE], bodies, aikbCalls });

  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });

  assert.equal(result.imported.length, 1);
  assert.equal(aikbCalls.uploadAndIngest.length, 1);
  const call = aikbCalls.uploadAndIngest[0];
  assert.equal(call.clientId, 'client-a');
  assert.equal(call.sourceFileId, 'm1');
  assert.equal(call.sourceProvider, 'gmail');
  assert.equal(call.mimeType, 'text/plain');
  assert.match(call.fileBuffer.toString('utf8'), /Please see attached invoice\./);
  assert.equal(call.emailMetadata.provider, 'gmail');
  assert.equal(call.emailMetadata.providerAccountId, 'sam@client.com');
  assert.equal(call.emailMetadata.contributingMemberId, 'member-1');
  assert.equal(call.emailMetadata.providerMessageId, 'm1');
  assert.equal(call.emailMetadata.subject, 'Invoice #42');
  assert.equal(call.emailMetadata.ingestionRuleId, 'rule-1');
  assert.deepEqual(call.emailMetadata.folderOrLabels.sort(), ['Relativity/Knowledge', 'finance'].sort());

  const ingestedEvent = emailSyncRepo._events.find((e) => e.provider_message_id === 'm1');
  assert.equal(ingestedEvent.outcome, 'ingested');
});

test('destination collection: a matched rule\'s destinationCollectionId is forwarded as collectionId', async () => {
  const rule = { ...ALLOW_FINANCE, destinationCollectionId: 'coll-finance' };
  const pages = [{ messages: [{ id: 'm1', subject: 'Invoice', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }] }];
  const aikbCalls = {};
  const { service } = makeService({ pages, rules: [rule], bodies: { m1: { text: 'Invoice body.' } }, aikbCalls });
  await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(aikbCalls.uploadAndIngest[0].collectionId, 'coll-finance');
});

test('two distinct eligible messages both ingest independently — no client-side content-hash collapsing (dedup-narrowing is AIKB\'s responsibility, §20)', async () => {
  const pages = [{
    messages: [
      { id: 'm1', subject: 'Auto-notification', fromAddress: 'noreply@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] },
      { id: 'm2', subject: 'Auto-notification', fromAddress: 'noreply@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] },
    ],
  }];
  const bodies = {
    m1: { text: 'Your invoice is ready.' },
    m2: { text: 'Your invoice is ready.' }, // near-identical body, distinct message
  };
  const aikbCalls = {};
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE], bodies, aikbCalls });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 2);
  assert.equal(aikbCalls.uploadAndIngest.length, 2);
  assert.deepEqual(aikbCalls.uploadAndIngest.map((c) => c.sourceFileId).sort(), ['m1', 'm2']);
});

// ─────────────────────────────────────────────
// Per-message failure isolation (§17 item 5)
// ─────────────────────────────────────────────

test('a message whose body fetch fails is recorded as failed and does not stop the rest of the page', async () => {
  const pages = [{
    messages: [
      { id: 'm1', subject: 'Will fail', fromAddress: 'a@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] },
      { id: 'm2', subject: 'Will succeed', fromAddress: 'b@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] },
    ],
  }];
  const bodies = { m2: { text: 'Body two.' } }; // m1 intentionally missing -> fixture throws
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE], bodies });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].messageId, 'm1');
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].messageId, 'm2');
  assert.equal(result.status, 'partial');
});

test('a message that normalizes to empty text is recorded failed, not ingested', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Blank', fromAddress: 'a@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }] }];
  const { service, aikbService: fakeAikb } = makeService({
    pages, rules: [ALLOW_FINANCE], bodies: { m1: { html: '<img src="x"><script>void(0)</script>' } },
  });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /no extractable text/);
});

test('an AIKB ingest call that throws is recorded as failed, not silently swallowed', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'X', fromAddress: 'a@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }] }];
  const { service } = makeService({
    pages, rules: [ALLOW_FINANCE], bodies: { m1: { text: 'body' } }, failIngestFor: new Set(['m1']),
  });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.status, 'partial');
});

// ─────────────────────────────────────────────
// Pagination / resume (§17 item 3)
// ─────────────────────────────────────────────

test('pagination: a page with more results returns complete:false and a nextPageToken; a second call with that token continues and finishes', async () => {
  const pages = [
    { messages: [{ id: 'm1', subject: 'One', fromAddress: 'a@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }], nextPageToken: 'page-2' },
    { messages: [{ id: 'm2', subject: 'Two', fromAddress: 'a@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }], nextPageToken: null },
  ];
  const bodies = { m1: { text: 'one' }, m2: { text: 'two' } };
  const gmailCalls = {};
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE], bodies, gmailCalls });

  const first = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(first.complete, false);
  assert.equal(first.nextPageToken, 'page-2');
  assert.equal(first.imported.length, 1);

  const second = await service.syncConnection({
    clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't', pageToken: first.nextPageToken,
  });
  assert.equal(second.complete, true);
  assert.equal(second.nextPageToken, null);
  assert.equal(second.imported.length, 1);
  assert.equal(second.imported[0].messageId, 'm2');

  // Two historical-page calls plus one final reconciliation listing call
  // (§24.2, only run once the second page reports complete) — assert the
  // two paginated calls specifically, in order.
  const pageCalls = gmailCalls.listMessageIdsByQuery.slice(0, 2).map((c) => c.pageToken);
  assert.deepEqual(pageCalls, [null, 'page-2']);
});

test('the document-limit check only runs on the first page (pageToken null), not on a resumed page', async () => {
  const pages = [
    { messages: [], nextPageToken: null },
  ];
  const documents = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, status: 'indexed' }));
  const { service } = makeService({ pages, rules: [], documents, maxDocuments: 5 });
  // Resuming (pageToken set) must not re-trigger the limit check that would
  // have blocked a fresh sync — a run already in progress should be allowed
  // to finish its remaining pages.
  const result = await service.syncConnection({
    clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't', pageToken: 'resume-token',
  });
  assert.equal(result.complete, true);
});

// ─────────────────────────────────────────────
// Cross-member isolation
// ─────────────────────────────────────────────

test('two different connections (different members) never cross — each sync only ever touches its own connection\'s row and contributingMemberId', async () => {
  const pagesA = [{ messages: [{ id: 'a1', subject: 'A', fromAddress: 'a@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }] }];
  const pagesB = [{ messages: [{ id: 'b1', subject: 'B', fromAddress: 'b@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }] }];

  const aikbCallsA = {};
  const { service: serviceA } = makeService({ pages: pagesA, rules: [ALLOW_FINANCE], bodies: { a1: { text: 'a' } }, aikbCalls: aikbCallsA });
  const resultA = await serviceA.syncConnection({
    clientId: 'client-a', emailConnectionRow: fixtureConnection({ id: 'conn-a', member_id: 'member-a', mailbox_address: 'a@client.com' }),
    memberSearchEnabled: true, accessToken: 't',
  });

  const aikbCallsB = {};
  const { service: serviceB } = makeService({ pages: pagesB, rules: [ALLOW_FINANCE], bodies: { b1: { text: 'b' } }, aikbCalls: aikbCallsB });
  const resultB = await serviceB.syncConnection({
    clientId: 'client-a', emailConnectionRow: fixtureConnection({ id: 'conn-b', member_id: 'member-b', mailbox_address: 'b@client.com' }),
    memberSearchEnabled: true, accessToken: 't',
  });

  assert.equal(resultA.imported[0].messageId, 'a1');
  assert.equal(resultB.imported[0].messageId, 'b1');
  assert.equal(aikbCallsA.uploadAndIngest[0].emailMetadata.contributingMemberId, 'member-a');
  assert.equal(aikbCallsB.uploadAndIngest[0].emailMetadata.contributingMemberId, 'member-b');
  assert.equal(aikbCallsA.uploadAndIngest.some((c) => c.sourceFileId === 'b1'), false);
  assert.equal(aikbCallsB.uploadAndIngest.some((c) => c.sourceFileId === 'a1'), false);
});

// ─────────────────────────────────────────────
// Label-removal reconciliation (§24.2) — now runnable end-to-end (EM5 built
// the pure logic; EM6 gives it real email_ingestion_events data)
// ─────────────────────────────────────────────

test('label-removal reconciliation: a previously-ingested message no longer under the label is tombstoned via AIKB delete, once the sync completes', async () => {
  const pages = [{ messages: [], nextPageToken: null }]; // nothing new this sync
  const documents = [{ id: 'doc-old', source_provider: 'gmail', source_file_id: 'old-msg', status: 'indexed' }];
  const gmailCalls = {};
  const { service, aikbService: fakeAikb } = makeService({
    pages, rules: [ALLOW_FINANCE], documents, previouslyIngested: ['old-msg'], gmailCalls,
  });

  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });

  assert.equal(result.complete, true);
  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0].messageId, 'old-msg');
  assert.equal(result.reconciled[0].documentId, 'doc-old');
});

test('label-removal reconciliation: a message still under the label is NOT tombstoned', async () => {
  const pages = [{ messages: [], nextPageToken: null }];
  const documents = [{ id: 'doc-keep', source_provider: 'gmail', source_file_id: 'still-labeled', status: 'indexed' }];
  // The reconciliation listing call returns the same message as "currently labeled".
  const gmailService = {
    compileSearchQuery,
    listMessageIdsByQuery: async () => ({ messageIds: ['still-labeled'], nextPageToken: null }),
    listLabels: async () => LABELS,
    getMessageMetadata: async () => { throw new Error('not used in this test'); },
    getMessageBody: async () => { throw new Error('not used in this test'); },
  };
  const emailSyncRepo = fixtureEmailSyncRepo({ previouslyIngested: ['still-labeled'] });
  const aikbService = fixtureAikbService({ documents });
  const service = createEmailSyncService({
    gmailService,
    emailPolicyService: fixtureEmailPolicyService([ALLOW_FINANCE]),
    emailNormalizationService: { normalizeEmailBody },
    aikbService,
    emailSyncRepo,
    maxDocuments: 50,
  });

  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.reconciled.length, 0);
});

test('reconciliation does not run on an incomplete (paginated) sync — only once the run is complete', async () => {
  const pages = [{ messages: [], nextPageToken: 'more' }];
  const documents = [{ id: 'doc-old', source_provider: 'gmail', source_file_id: 'old-msg', status: 'indexed' }];
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE], documents, previouslyIngested: ['old-msg'] });
  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.complete, false);
  assert.equal(result.reconciled.length, 0);
});

// ─────────────────────────────────────────────
// Run-level failure
// ─────────────────────────────────────────────

test('a page-level failure (the list call itself throws) marks the run failed with an error summary, not a thrown exception', async () => {
  const gmailService = {
    compileSearchQuery,
    listMessageIdsByQuery: async () => { throw new Error('Gmail quota exceeded'); },
    listLabels: async () => LABELS,
    getMessageMetadata: async () => { throw new Error('not reached'); },
    getMessageBody: async () => { throw new Error('not reached'); },
  };
  const emailSyncRepo = fixtureEmailSyncRepo();
  const aikbService = fixtureAikbService({});
  const service = createEmailSyncService({
    gmailService,
    emailPolicyService: fixtureEmailPolicyService([ALLOW_FINANCE]),
    emailNormalizationService: { normalizeEmailBody },
    aikbService,
    emailSyncRepo,
    maxDocuments: 50,
  });

  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.status, 'failed');
  assert.match(result.errorSummary || emailSyncRepo._runs.get(result.syncRunId).errorSummary, /Gmail quota exceeded/);
});

// ─────────────────────────────────────────────
// Historical-page size bound
// ─────────────────────────────────────────────

test('HISTORICAL_PAGE_SIZE is a small, bounded page (Vercel-timeout constraint, §17 item 3)', () => {
  assert.ok(HISTORICAL_PAGE_SIZE > 0 && HISTORICAL_PAGE_SIZE <= 50);
});
