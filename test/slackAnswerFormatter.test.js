const test = require('node:test');
const assert = require('node:assert/strict');
const { formatSlackMessage, formatCitations, truncateAnswer, FALLBACK, MAX_CITATIONS, MAX_ANSWER_CHARS } = require('../services/slackAnswerFormatter');

test('renders a plain answer with no sources', () => {
  const text = formatSlackMessage({ answer: 'The PTO policy allows 15 days.', sources: [], isKnowledgeGap: false });
  assert.equal(text, 'The PTO policy allows 15 days.');
});

test('renders an answer with sources in the exact expected shape', () => {
  const text = formatSlackMessage({
    answer: 'The PTO policy allows 15 days.',
    sources: [{ fileName: 'PTO Policy.pdf' }, { fileName: 'Handbook.pdf' }],
    isKnowledgeGap: false,
  });
  assert.equal(text, 'The PTO policy allows 15 days.\n\nSources:\n• PTO Policy.pdf\n• Handbook.pdf');
});

// EM10 (EMAIL_INGESTION.md §23) — runKnowledgeQuery.js's email-sourced
// citation shape ({documentId, fileName, title, subject, from, sentAt,
// deepLinkUrl}) is deliberately given a `title` field specifically so this
// file's existing `source.title || source.fileName` fallback (line 36
// below) keeps rendering it correctly for Slack, without this file needing
// its own email-aware branch.
test('renders an email-sourced citation via its title field (EM10 shape), not fileName', () => {
  const lines = formatCitations([{
    documentId: 'doc-email-1',
    fileName: 'Q3 Renewal Terms.txt',
    title: '"Q3 Renewal Terms" from Jane Doe',
    subject: 'Q3 Renewal Terms',
    from: 'Jane Doe',
    sentAt: '2026-07-20T12:00:00Z',
    deepLinkUrl: 'https://mail.google.com/mail/u/0/#all/msg-1',
  }]);
  assert.deepEqual(lines, ['"Q3 Renewal Terms" from Jane Doe']);
});

test('a mixed set (plain document + email-sourced) renders both correctly in one Slack message', () => {
  const text = formatSlackMessage({
    answer: 'Renewal terms are net-30.',
    sources: [
      { fileName: 'Handbook.pdf' },
      { fileName: 'Q3 Renewal Terms.txt', title: '"Q3 Renewal Terms" from Jane Doe', subject: 'Q3 Renewal Terms' },
    ],
    isKnowledgeGap: false,
  });
  assert.equal(text, 'Renewal terms are net-30.\n\nSources:\n• Handbook.pdf\n• "Q3 Renewal Terms" from Jane Doe');
});

test('deduplicates repeated citation titles (case-insensitive)', () => {
  const lines = formatCitations([
    { fileName: 'PTO Policy.pdf' },
    { fileName: 'pto policy.pdf' },
    { fileName: 'Handbook.pdf' },
  ]);
  assert.deepEqual(lines, ['PTO Policy.pdf', 'Handbook.pdf']);
});

test('caps displayed citations to MAX_CITATIONS', () => {
  const sources = Array.from({ length: 10 }, (_, i) => ({ fileName: `Doc ${i}.pdf` }));
  const lines = formatCitations(sources);
  assert.equal(lines.length, MAX_CITATIONS);
});

test('never includes internal fields (documentId, chunkId, storage path) in a formatted line', () => {
  const lines = formatCitations([{ fileName: 'Doc.pdf', documentId: 'uuid-123', chunkId: 'chunk-456', storagePath: '/private/doc.pdf' }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'Doc.pdf');
  assert.ok(!lines[0].includes('uuid-123'));
  assert.ok(!lines[0].includes('/private/doc.pdf'));
});

test('skips sources with no usable title', () => {
  const lines = formatCitations([{ documentId: 'uuid-only' }, { fileName: 'Real.pdf' }]);
  assert.deepEqual(lines, ['Real.pdf']);
});

test('handles an empty/undefined sources array', () => {
  assert.deepEqual(formatCitations([]), []);
  assert.deepEqual(formatCitations(undefined), []);
});

test('truncates a long answer safely and adds an ellipsis', () => {
  const longAnswer = 'a'.repeat(MAX_ANSWER_CHARS + 500);
  const truncated = truncateAnswer(longAnswer);
  assert.ok(truncated.length <= MAX_ANSWER_CHARS);
  assert.ok(truncated.endsWith('…'));
});

test('does not truncate an answer under the limit', () => {
  const answer = 'a short answer';
  assert.equal(truncateAnswer(answer), answer);
});

test('a knowledge-gap result renders the exact approved fallback, ignoring answer/sources', () => {
  const text = formatSlackMessage({ answer: 'ignored', sources: [{ fileName: 'ignored.pdf' }], isKnowledgeGap: true });
  assert.equal(text, FALLBACK.KNOWLEDGE_GAP);
  assert.equal(text, "I couldn't find that information in your organization's knowledge base.");
});

test('the temporary-failure fallback string matches the approved copy exactly', () => {
  assert.equal(FALLBACK.TEMPORARY_FAILURE, "I couldn't complete that request right now. Please try again shortly.");
});

test('a long answer combined with citations still respects the citation format', () => {
  const longAnswer = 'a'.repeat(MAX_ANSWER_CHARS + 100);
  const text = formatSlackMessage({ answer: longAnswer, sources: [{ fileName: 'Doc.pdf' }], isKnowledgeGap: false });
  assert.ok(text.includes('Sources:\n• Doc.pdf'));
  assert.ok(text.length < longAnswer.length + 100);
});

// ─────────────────────────────────────────────
// EL7B — live-source citations (§3.2, §6.3) and the unlinked/no-mailbox
// link-prompt hint (§3.2's "never a silent failure").
// ─────────────────────────────────────────────

const LIVE_SOURCE = {
  type: 'live_email_message', subject: 'Renewal terms', from: 'jane@acme.example.com',
  receivedAt: '2026-07-29T14:02:00Z', providerMessageId: 'gmail-msg-id', providerThreadId: null,
  deepLinkUrl: 'https://mail.google.com/mail/u/0/#all/gmail-msg-id', live: true,
};

test('a live source (no title/fileName field) renders via subject/from, marked (Live)', () => {
  const lines = formatCitations([LIVE_SOURCE]);
  assert.deepEqual(lines, ['"Renewal terms" from jane@acme.example.com (Live)']);
});

test('a stored citation is never marked (Live) — only live:true sources get the marker', () => {
  const lines = formatCitations([{ fileName: 'Handbook.pdf' }]);
  assert.deepEqual(lines, ['Handbook.pdf']);
});

test('a hybrid answer citing both a stored document and a live email renders both, only the live one marked', () => {
  const lines = formatCitations([{ fileName: 'Handbook.pdf' }, LIVE_SOURCE]);
  assert.deepEqual(lines, ['Handbook.pdf', '"Renewal terms" from jane@acme.example.com (Live)']);
});

test('emailLookupSuggested appends the link-prompt hint to a normal answer', () => {
  const text = formatSlackMessage({ answer: 'Here is what I found.', sources: [], isKnowledgeGap: false, emailLookupSuggested: true });
  assert.ok(text.startsWith('Here is what I found.'));
  assert.match(text, /link your Slack account/i);
});

test('emailLookupSuggested appends the hint even to a knowledge-gap answer — never a silent failure', () => {
  const text = formatSlackMessage({ answer: 'ignored', sources: [], isKnowledgeGap: true, emailLookupSuggested: true });
  assert.ok(text.startsWith(FALLBACK.KNOWLEDGE_GAP));
  assert.match(text, /link your Slack account/i);
});

test('emailLookupSuggested is omitted entirely when false/absent — no behavior change for every pre-EL7B caller', () => {
  const withoutFlag = formatSlackMessage({ answer: 'An answer.', sources: [], isKnowledgeGap: false });
  const withFalseFlag = formatSlackMessage({ answer: 'An answer.', sources: [], isKnowledgeGap: false, emailLookupSuggested: false });
  assert.equal(withoutFlag, 'An answer.');
  assert.equal(withFalseFlag, 'An answer.');
});
