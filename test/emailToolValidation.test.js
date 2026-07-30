const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TOOL_NAMES,
  validateSearchEmailMessagesArgs,
  validateGetEmailContentArgs,
} = require('../services/emailToolValidation');

// Cross-repo fixture — must match aikb/services/emailToolSchemas.js's
// SEARCH_EMAIL_MESSAGES_TOOL/GET_EMAIL_CONTENT_TOOL parameters exactly
// (property names, types, enum values). See
// aikb/test/emailToolSchemas.test.js for the counterpart assertion. There is
// no shared package between the two repos, so this pair of hardcoded
// fixtures — reviewed side by side — is what keeps EL2's "both repos need
// to agree on the shape" acceptance criterion honest.
const SEARCH_EMAIL_MESSAGES_ALLOWED_KEYS = [
  'senderContains',
  'recipientContains',
  'subjectContains',
  'keywords',
  'dateFrom',
  'dateTo',
  'unreadOnly',
  'hasAttachment',
  'attachmentNameContains',
  'mailboxScope',
  'maxResults',
];
const GET_EMAIL_CONTENT_ALLOWED_KEYS = ['messageId', 'threadId', 'maxMessagesInThread'];

test('TOOL_NAMES matches aikb/services/emailToolSchemas.js exactly', () => {
  assert.deepEqual(TOOL_NAMES, {
    SEARCH_EMAIL_MESSAGES: 'search_email_messages',
    GET_EMAIL_CONTENT: 'get_email_content',
  });
});

// ─────────────────────────────────────────────
// validateSearchEmailMessagesArgs
// ─────────────────────────────────────────────

test('search_email_messages: empty/omitted args are valid and default correctly', () => {
  const result = validateSearchEmailMessagesArgs({});
  assert.equal(result.mailboxScope, 'mine');
  assert.equal(result.maxResults, 10);
  assert.equal(result.unreadOnly, false);
  assert.equal(result.hasAttachment, false);
  assert.equal(result.senderContains, null);
});

test('search_email_messages: accepts every documented field when fully populated', () => {
  const result = validateSearchEmailMessagesArgs({
    senderContains: 'jane@acme.example.com',
    recipientContains: 'me@ourcompany.com',
    subjectContains: 'renewal',
    keywords: 'contract terms',
    dateFrom: '2026-07-01',
    dateTo: '2026-07-30',
    unreadOnly: true,
    hasAttachment: true,
    attachmentNameContains: 'invoice',
    mailboxScope: 'mine',
    maxResults: 5,
  });
  assert.equal(result.senderContains, 'jane@acme.example.com');
  assert.equal(result.maxResults, 5);
  assert.equal(result.unreadOnly, true);
});

test('search_email_messages: rejects an unrecognized argument (defense in depth against a malformed tool call)', () => {
  assert.throws(
    () => validateSearchEmailMessagesArgs({ mailbox: 'mine' }),
    /unrecognized argument/
  );
});

for (const key of SEARCH_EMAIL_MESSAGES_ALLOWED_KEYS) {
  test(`search_email_messages: "${key}" is an accepted argument (cross-repo fixture check)`, () => {
    assert.doesNotThrow(() => validateSearchEmailMessagesArgs({ [key]: undefined }));
  });
}

test('search_email_messages: rejects a non-boolean unreadOnly', () => {
  assert.throws(() => validateSearchEmailMessagesArgs({ unreadOnly: 'yes' }), /unreadOnly must be a boolean/);
});

test('search_email_messages: rejects an empty-string senderContains', () => {
  assert.throws(() => validateSearchEmailMessagesArgs({ senderContains: '   ' }), /senderContains/);
});

test('search_email_messages: rejects a non-ISO dateFrom', () => {
  assert.throws(() => validateSearchEmailMessagesArgs({ dateFrom: 'last week' }), /dateFrom/);
});

test('search_email_messages: rejects dateFrom after dateTo', () => {
  assert.throws(
    () => validateSearchEmailMessagesArgs({ dateFrom: '2026-08-01', dateTo: '2026-07-01' }),
    /dateFrom must not be after dateTo/
  );
});

test('search_email_messages: rejects a mailboxScope other than "mine"', () => {
  assert.throws(
    () => validateSearchEmailMessagesArgs({ mailboxScope: 'shared' }),
    /mailboxScope must be "mine"/
  );
});

test('search_email_messages: rejects a non-integer maxResults', () => {
  assert.throws(() => validateSearchEmailMessagesArgs({ maxResults: 3.5 }), /maxResults must be a positive integer/);
  assert.throws(() => validateSearchEmailMessagesArgs({ maxResults: 0 }), /maxResults must be a positive integer/);
});

test('search_email_messages: rejects maxResults above the configured hard cap (25) — never silently clamped', () => {
  assert.throws(
    () => validateSearchEmailMessagesArgs({ maxResults: 26 }),
    /maxResults must not exceed 25/
  );
  // Exactly at the cap is fine.
  const result = validateSearchEmailMessagesArgs({ maxResults: 25 });
  assert.equal(result.maxResults, 25);
});

// ─────────────────────────────────────────────
// validateGetEmailContentArgs
// ─────────────────────────────────────────────

test('get_email_content: accepts messageId alone and defaults maxMessagesInThread', () => {
  const result = validateGetEmailContentArgs({ messageId: 'msg-1' });
  assert.equal(result.messageId, 'msg-1');
  assert.equal(result.threadId, null);
  assert.equal(result.maxMessagesInThread, 5);
});

test('get_email_content: accepts threadId alone', () => {
  const result = validateGetEmailContentArgs({ threadId: 'thread-1' });
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.messageId, null);
});

test('get_email_content: rejects neither messageId nor threadId provided', () => {
  assert.throws(
    () => validateGetEmailContentArgs({}),
    /exactly one of messageId or threadId is required \(neither was provided\)/
  );
});

test('get_email_content: rejects both messageId and threadId provided', () => {
  assert.throws(
    () => validateGetEmailContentArgs({ messageId: 'msg-1', threadId: 'thread-1' }),
    /exactly one of messageId or threadId is required \(both were provided\)/
  );
});

test('get_email_content: rejects an unrecognized argument', () => {
  assert.throws(
    () => validateGetEmailContentArgs({ messageId: 'msg-1', includeAttachments: true }),
    /unrecognized argument/
  );
});

for (const key of GET_EMAIL_CONTENT_ALLOWED_KEYS) {
  test(`get_email_content: "${key}" is a recognized argument name (cross-repo fixture check)`, () => {
    assert.ok(GET_EMAIL_CONTENT_ALLOWED_KEYS.includes(key));
  });
}

test('get_email_content: rejects maxMessagesInThread above the configured hard cap (20) — never silently clamped', () => {
  assert.throws(
    () => validateGetEmailContentArgs({ messageId: 'msg-1', maxMessagesInThread: 21 }),
    /maxMessagesInThread must not exceed 20/
  );
  const result = validateGetEmailContentArgs({ messageId: 'msg-1', maxMessagesInThread: 20 });
  assert.equal(result.maxMessagesInThread, 20);
});

test('get_email_content: rejects a non-integer maxMessagesInThread', () => {
  assert.throws(
    () => validateGetEmailContentArgs({ messageId: 'msg-1', maxMessagesInThread: 0 }),
    /maxMessagesInThread must be a positive integer/
  );
});
