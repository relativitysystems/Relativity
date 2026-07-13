const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceLabelFor } = require('../services/importMetadata');

test('sourceLabelFor maps every known source type to its user-facing label', () => {
  assert.equal(sourceLabelFor('local'), 'Local upload');
  assert.equal(sourceLabelFor('folder_upload'), 'Folder upload');
  assert.equal(sourceLabelFor('zip'), 'ZIP import');
  assert.equal(sourceLabelFor('google_drive'), 'Google Drive import');
});

test('sourceLabelFor never leaks a raw/unknown provider code', () => {
  assert.equal(sourceLabelFor('some_future_provider'), 'Local upload');
  assert.equal(sourceLabelFor(undefined), 'Local upload');
  assert.equal(sourceLabelFor(null), 'Local upload');
});
