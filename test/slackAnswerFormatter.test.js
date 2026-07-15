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
