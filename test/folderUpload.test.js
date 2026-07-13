const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeRelativePath } = require('../services/importMetadata');

test('sanitizeRelativePath preserves a normal nested folder path', () => {
  assert.equal(sanitizeRelativePath('HR/Policies/Vacation Policy.pdf'), 'HR/Policies/Vacation Policy.pdf');
});

test('sanitizeRelativePath normalizes backslashes to forward slashes (webkitRelativePath on Windows)', () => {
  assert.equal(sanitizeRelativePath('HR\\Policies\\Vacation Policy.pdf'), 'HR/Policies/Vacation Policy.pdf');
});

test('sanitizeRelativePath falls back to null for empty/missing input', () => {
  assert.equal(sanitizeRelativePath(null), null);
  assert.equal(sanitizeRelativePath(''), null);
  assert.equal(sanitizeRelativePath('.'), null);
});

test('sanitizeRelativePath rejects path traversal', () => {
  assert.equal(sanitizeRelativePath('../../etc/passwd'), null);
  assert.equal(sanitizeRelativePath('HR/../../etc/passwd'), null);
});

test('sanitizeRelativePath rejects absolute paths', () => {
  assert.equal(sanitizeRelativePath('/etc/passwd'), null);
});

test('sanitizeRelativePath rejects Windows drive-letter paths', () => {
  assert.equal(sanitizeRelativePath('C:\\Windows\\System32\\file.txt'), null);
});

test('sanitizeRelativePath treats the folder path as display-only metadata, never a server path', () => {
  // A path that is otherwise well-formed should just pass through untouched —
  // sanitizeRelativePath's job is normalization + rejection, not resolution.
  const result = sanitizeRelativePath('Contracts/2026/Q1/Agreement.docx');
  assert.equal(result, 'Contracts/2026/Q1/Agreement.docx');
  assert.ok(!result.startsWith('/'));
});
