const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyZipEntries } = require('../services/importMetadata');

function entry(entryName, { isDirectory = false, size = 100 } = {}) {
  return { isDirectory, entryName, header: { size } };
}

test('classifyZipEntries accepts allowed extensions and preserves relative path', () => {
  const { valid, skipped } = classifyZipEntries([
    entry('HR/Policies/Vacation Policy.pdf'),
  ]);
  assert.equal(skipped.length, 0);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].fileName, 'Vacation Policy.pdf');
  assert.equal(valid[0].relativePath, 'HR/Policies/Vacation Policy.pdf');
  assert.equal(valid[0].ext, '.pdf');
});

test('classifyZipEntries skips unsupported extensions with a reason', () => {
  const { valid, skipped } = classifyZipEntries([entry('notes.exe')]);
  assert.equal(valid.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /Unsupported file type/);
});

test('classifyZipEntries skips hidden/system files', () => {
  const { valid, skipped } = classifyZipEntries([
    entry('__MACOSX/._Vacation Policy.pdf'),
    entry('.DS_Store'),
    entry('Thumbs.db'),
    entry('.hidden.txt'),
  ]);
  assert.equal(valid.length, 0);
  assert.equal(skipped.length, 4);
  skipped.forEach((s) => assert.equal(s.reason, 'Hidden/system file'));
});

test('classifyZipEntries rejects unsafe/traversal paths', () => {
  const { valid, skipped } = classifyZipEntries([
    entry('../../etc/passwd.txt'),
    entry('/etc/passwd.txt'),
  ]);
  assert.equal(valid.length, 0);
  assert.equal(skipped.length, 2);
  skipped.forEach((s) => assert.equal(s.reason, 'Unsafe path in archive'));
});

test('classifyZipEntries skips directory entries entirely', () => {
  const { valid, skipped } = classifyZipEntries([entry('HR/', { isDirectory: true })]);
  assert.equal(valid.length, 0);
  assert.equal(skipped.length, 0);
});

test('classifyZipEntries detects an obvious duplicate within the same batch', () => {
  const { valid, skipped } = classifyZipEntries([
    entry('HR/Policies/Vacation Policy.pdf'),
    entry('HR/Policies/Vacation Policy.pdf'), // same normalized relative path, sent twice
  ]);
  assert.equal(valid.length, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'Duplicate file in this import');
});

test('classifyZipEntries treats backslash and forward-slash duplicates as the same path', () => {
  const { valid, skipped } = classifyZipEntries([
    entry('HR/Policies/Vacation Policy.pdf'),
    entry('HR\\Policies\\Vacation Policy.pdf'),
  ]);
  assert.equal(valid.length, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'Duplicate file in this import');
});
