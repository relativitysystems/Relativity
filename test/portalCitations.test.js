const test = require('node:test');
const assert = require('node:assert/strict');

// Pure, DOM-free logic — no jsdom or browser stub needed, mirroring
// test/portalCache.test.js's dual-mode require pattern.
const PortalCitations = require('../public/portal/portalCitations.js');
const { isEmailSource, formatCitationDate, shouldShowSourcesBox, groupSourcesForDisplay } = PortalCitations;

const DOC_SOURCE = { fileName: 'Handbook.pdf', documentId: 'doc-1', pages: [2] };
const EMAIL_SOURCE = { documentId: 'doc-email-1', fileName: 'Renewal.txt', title: '"Renewal" from Jane', subject: 'Renewal', from: 'Jane Doe', sentAt: '2026-07-20T12:00:00Z', deepLinkUrl: 'https://mail.google.com/mail/u/0/#all/msg-1' };

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
