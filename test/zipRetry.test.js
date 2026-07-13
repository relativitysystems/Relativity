const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyZipEntries } = require('../services/importMetadata');

function entry(entryName, { isDirectory = false, size = 100 } = {}) {
  return { isDirectory, entryName, header: { size } };
}

test('retryOnly reprocesses only the requested paths, ignoring everything else in the archive', () => {
  const entries = [
    entry('HR/Policies/Vacation Policy.pdf'),   // previously succeeded — should be skipped on retry
    entry('HR/Policies/Sick Leave.pdf'),         // previously failed — should be reprocessed
    entry('HR/Policies/Onboarding.pdf'),         // previously succeeded — should be skipped on retry
  ];

  const retryOnlySet = new Set(['HR/Policies/Sick Leave.pdf']);
  const { valid, skipped } = classifyZipEntries(entries, { retryOnlySet });

  assert.equal(valid.length, 1);
  assert.equal(valid[0].relativePath, 'HR/Policies/Sick Leave.pdf');
  // Files outside retryOnly are excluded silently — they already succeeded, so they
  // must not be re-reported as "skipped" (that would look like a new failure to the user).
  assert.equal(skipped.length, 0);
});

test('retryOnly still applies validation (unsupported extension is skipped even if requested)', () => {
  const entries = [entry('HR/Policies/Notes.exe')];
  const retryOnlySet = new Set(['HR/Policies/Notes.exe']);
  const { valid, skipped } = classifyZipEntries(entries, { retryOnlySet });

  assert.equal(valid.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /Unsupported file type/);
});

test('a missing retryOnly path (edited out of the re-uploaded archive) simply yields nothing to process', () => {
  const entries = [entry('HR/Policies/Vacation Policy.pdf')];
  const retryOnlySet = new Set(['HR/Policies/Sick Leave.pdf']); // not present in this archive
  const { valid, skipped } = classifyZipEntries(entries, { retryOnlySet });

  assert.equal(valid.length, 0);
  assert.equal(skipped.length, 0);
});
