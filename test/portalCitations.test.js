const test = require('node:test');
const assert = require('node:assert/strict');

// Pure, DOM-free logic — no jsdom or browser stub needed, mirroring
// test/portalCache.test.js's dual-mode require pattern.
const PortalCitations = require('../public/portal/portalCitations.js');
const { isEmailSource, isLiveSource, citationDate, formatCitationDate, shouldShowSourcesBox, groupSourcesForDisplay } = PortalCitations;

const DOC_SOURCE = { fileName: 'Handbook.pdf', documentId: 'doc-1', pages: [2] };
const EMAIL_SOURCE = { documentId: 'doc-email-1', fileName: 'Renewal.txt', title: '"Renewal" from Jane', subject: 'Renewal', from: 'Jane Doe', sentAt: '2026-07-20T12:00:00Z', deepLinkUrl: 'https://mail.google.com/mail/u/0/#all/msg-1' };
// EL6 (§6.2) — a live_email_message source, as returned by AIKB's
// liveSourcesFromSearchMatches/liveSourcesFromContentMessages.
const LIVE_SOURCE = { type: 'live_email_message', subject: 'Renewal terms', from: 'jane@acme.example.com', receivedAt: '2026-07-29T14:02:00Z', providerMessageId: 'gmail-msg-id', providerThreadId: 'gmail-thread-id', deepLinkUrl: 'https://mail.google.com/mail/u/0/#all/gmail-msg-id', live: true };

// ─────────────────────────────────────────────
// isEmailSource
// ─────────────────────────────────────────────

test('isEmailSource is true for a source carrying "subject" (the email-branch discriminator)', () => {
  assert.equal(isEmailSource(EMAIL_SOURCE), true);
});

test('isEmailSource is false for a plain document source', () => {
  assert.equal(isEmailSource(DOC_SOURCE), false);
});

test('isEmailSource is false for null/undefined/a bare string, never throws', () => {
  assert.equal(isEmailSource(null), false);
  assert.equal(isEmailSource(undefined), false);
  assert.equal(isEmailSource('some string source'), false);
});

// ─────────────────────────────────────────────
// formatCitationDate
// ─────────────────────────────────────────────

test('formatCitationDate formats a valid ISO timestamp as a short human-readable date', () => {
  assert.equal(formatCitationDate('2026-07-20T12:00:00Z'), 'Jul 20, 2026');
});

test('formatCitationDate returns null for null/empty/unparseable input', () => {
  assert.equal(formatCitationDate(null), null);
  assert.equal(formatCitationDate(''), null);
  assert.equal(formatCitationDate('not-a-date'), null);
});

// ─────────────────────────────────────────────
// shouldShowSourcesBox
// ─────────────────────────────────────────────

test('shouldShowSourcesBox is false with no sources, regardless of answer text', () => {
  assert.equal(shouldShowSourcesBox('Some answer. Source: x', []), false);
  assert.equal(shouldShowSourcesBox('Some answer.', null), false);
});

test('shouldShowSourcesBox is false for a plain document source when the answer already contains an inline "Source:" line (existing, pre-EM10 behavior preserved)', () => {
  assert.equal(shouldShowSourcesBox('TL;DR ... Source: Handbook.pdf', [DOC_SOURCE]), false);
});

test('shouldShowSourcesBox is true for a plain document source when the answer has NO inline "Source:" line', () => {
  assert.equal(shouldShowSourcesBox('An answer with no citation line.', [DOC_SOURCE]), true);
});

test('shouldShowSourcesBox is ALWAYS true when a source carries a deepLinkUrl, even if the answer already has an inline "Source:" line (EM10 — plain text can never render a clickable link)', () => {
  assert.equal(shouldShowSourcesBox('TL;DR ... Source: Email — "Renewal" from Jane, Jul 20, 2026', [EMAIL_SOURCE]), true);
});

test('shouldShowSourcesBox is ALWAYS true when a source carries a providerThreadId (thread grouping can never be conveyed by inline text)', () => {
  const s = { subject: 'Renewal', providerThreadId: 'thread-1' };
  assert.equal(shouldShowSourcesBox('TL;DR ... Source: something', [s]), true);
});

test('shouldShowSourcesBox is true for a mixed set (one plain doc, one rich email source) even when the answer has an inline Source line', () => {
  assert.equal(shouldShowSourcesBox('TL;DR ... Source: Handbook.pdf', [DOC_SOURCE, EMAIL_SOURCE]), true);
});

// ─────────────────────────────────────────────
// groupSourcesForDisplay
// ─────────────────────────────────────────────

test('groupSourcesForDisplay: plain document sources each get their own single-item group', () => {
  const doc2 = { fileName: 'Other.pdf', documentId: 'doc-2' };
  const groups = groupSourcesForDisplay([DOC_SOURCE, doc2]);
  assert.deepEqual(groups, [[DOC_SOURCE], [doc2]]);
});

test('groupSourcesForDisplay: email sources with no providerThreadId each get their own single-item group', () => {
  const groups = groupSourcesForDisplay([EMAIL_SOURCE]);
  assert.deepEqual(groups, [[EMAIL_SOURCE]]);
});

test('groupSourcesForDisplay: two email sources sharing a providerThreadId collapse into one group', () => {
  const a = { subject: 'Re: Renewal', providerThreadId: 'thread-1', documentId: 'doc-a' };
  const b = { subject: 'Re: Re: Renewal', providerThreadId: 'thread-1', documentId: 'doc-b' };
  const groups = groupSourcesForDisplay([a, b]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], [a, b]);
});

test('groupSourcesForDisplay: three email sources across two threads produce two groups, each with the right members', () => {
  const a = { subject: 'A', providerThreadId: 'thread-1', documentId: 'doc-a' };
  const b = { subject: 'B', providerThreadId: 'thread-2', documentId: 'doc-b' };
  const c = { subject: 'C', providerThreadId: 'thread-1', documentId: 'doc-c' };
  const groups = groupSourcesForDisplay([a, b, c]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], [a, c]);
  assert.deepEqual(groups[1], [b]);
});

test('groupSourcesForDisplay: a mixed set (plain doc + threaded email pair + standalone email) groups correctly and preserves first-seen order', () => {
  const doc = { fileName: 'Handbook.pdf', documentId: 'doc-1' };
  const t1a = { subject: 'A', providerThreadId: 'thread-1', documentId: 'doc-t1a' };
  const solo = { subject: 'Solo', providerThreadId: null, documentId: 'doc-solo' };
  const t1b = { subject: 'B', providerThreadId: 'thread-1', documentId: 'doc-t1b' };
  const groups = groupSourcesForDisplay([doc, t1a, solo, t1b]);
  assert.deepEqual(groups, [[doc], [t1a, t1b], [solo]]);
});

// ─────────────────────────────────────────────
// isLiveSource / citationDate (EL6 — §6.2, §6.3)
// ─────────────────────────────────────────────

test('isLiveSource is true only for a source explicitly carrying live:true', () => {
  assert.equal(isLiveSource(LIVE_SOURCE), true);
  assert.equal(isLiveSource(EMAIL_SOURCE), false);
  assert.equal(isLiveSource(DOC_SOURCE), false);
  assert.equal(isLiveSource(null), false);
});

test('isLiveSource is also true for the same-shaped live_email_thread type', () => {
  assert.equal(isLiveSource({ ...LIVE_SOURCE, type: 'live_email_thread' }), true);
});

test('citationDate reads sentAt for a stored email source and receivedAt for a live one', () => {
  assert.equal(citationDate(EMAIL_SOURCE), '2026-07-20T12:00:00Z');
  assert.equal(citationDate(LIVE_SOURCE), '2026-07-29T14:02:00Z');
});

test('citationDate returns a falsy value, never throws, for a plain doc source or null', () => {
  assert.equal(citationDate(DOC_SOURCE), undefined);
  assert.equal(citationDate(null), null);
});

test('groupSourcesForDisplay threads a live source together with its live_email_thread siblings by providerThreadId, same as stored email threading', () => {
  const m1 = { ...LIVE_SOURCE, providerMessageId: 'm1' };
  const m2 = { ...LIVE_SOURCE, providerMessageId: 'm2', subject: 'Re: Renewal terms' };
  const groups = groupSourcesForDisplay([m1, m2]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], [m1, m2]);
});

// ─────────────────────────────────────────────
// EL8 (§6, security requirement: "verify no OAuth/credential/hidden-
// recipient field ever appears in a rendered citation — a dedicated test,
// not just code review"). isEmailSource/isLiveSource/citationDate never
// reshape a source into new output (they return a boolean or a single
// existing field's value) — this documents and locks in that contract, so
// portal.js's DOM-building code (which reads only .subject/.from/
// citationDate(s)/.deepLinkUrl, verified by code review — no jsdom test
// harness exists in this repo's conventions for the DOM layer itself)
// has no path to a hidden field via these helpers.
// ─────────────────────────────────────────────

const POISONED_LIVE_SOURCE = {
  ...LIVE_SOURCE,
  accessToken: 'ya29.leaked', refreshToken: '1//leaked', oauthToken: 'leaked', bcc: 'secret@b.com', rawPayload: { mime: 'raw' },
};

test('security: isEmailSource/isLiveSource return booleans only — never echo any part of a poisoned source', () => {
  assert.equal(typeof isEmailSource(POISONED_LIVE_SOURCE), 'boolean');
  assert.equal(typeof isLiveSource(POISONED_LIVE_SOURCE), 'boolean');
});

test('security: citationDate returns only the date string field — never any other property of a poisoned source', () => {
  const date = citationDate(POISONED_LIVE_SOURCE);
  assert.equal(date, POISONED_LIVE_SOURCE.receivedAt);
  assert.equal(String(date).includes('leaked'), false);
});

test('security: groupSourcesForDisplay groups references without adding, removing, or reshaping any field — no new surface for a leak to hide in', () => {
  const groups = groupSourcesForDisplay([POISONED_LIVE_SOURCE]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0][0], POISONED_LIVE_SOURCE, 'same reference, not a copy/reshape — portal.js\'s renderer is what actually decides which fields ever reach the DOM (subject/from/citationDate/deepLinkUrl only, verified by code review)');
});
