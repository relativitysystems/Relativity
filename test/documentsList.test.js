const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeDocumentImportContext, sourceLabelFor } = require('../services/importMetadata');

test('mergeDocumentImportContext attaches import context for a matched document', () => {
  const docs = [{ sourceFileId: 'sfid-1', fileName: 'Employee Handbook.pdf', status: 'indexed' }];
  const importLogMap = new Map([
    ['sfid-1', {
      sourceType: 'google_drive',
      sourceLabel: sourceLabelFor('google_drive'),
      sourcePath: null,
      importedBy: 'member-1',
      importedAt: '2026-07-12T00:00:00.000Z',
    }],
  ]);

  const [enriched] = mergeDocumentImportContext(docs, importLogMap);
  assert.equal(enriched.sourceType, 'google_drive');
  assert.equal(enriched.sourceLabel, 'Google Drive import');
  assert.equal(enriched.importedAt, '2026-07-12T00:00:00.000Z');
  // AIKB's own fields must stay untouched.
  assert.equal(enriched.fileName, 'Employee Handbook.pdf');
  assert.equal(enriched.status, 'indexed');
});

test('mergeDocumentImportContext falls back safely for a legacy document with no import-log row', () => {
  const docs = [{ sourceFileId: 'sfid-legacy', fileName: 'Old Doc.pdf', status: 'indexed', created_at: '2026-01-01T00:00:00.000Z' }];
  const importLogMap = new Map(); // empty — as if this doc predates the feature

  const [enriched] = mergeDocumentImportContext(docs, importLogMap);
  assert.equal(enriched.sourceType, 'local');
  assert.equal(enriched.sourceLabel, 'Local upload');
  assert.equal(enriched.sourcePath, null);
  assert.equal(enriched.importedAt, '2026-01-01T00:00:00.000Z'); // falls back to AIKB's own created_at
  assert.equal(enriched.importedBy, null);
});

test('mergeDocumentImportContext never invents a timestamp when neither source has one', () => {
  const docs = [{ sourceFileId: 'sfid-legacy-2', fileName: 'No Date.pdf', status: 'indexed' }];
  const [enriched] = mergeDocumentImportContext(docs, new Map());
  assert.equal(enriched.importedAt, null);
});

test('mergeDocumentImportContext keeps client isolation: a map scoped to one client never leaks into another client\'s doc', () => {
  // Simulates two clients' import logs never being mixed — the map passed in is the
  // caller's responsibility to scope (via a client_id-filtered query), and a document
  // whose sourceFileId only exists under a *different* client's map must fall back
  // exactly like a legacy/unknown document, never accidentally matching cross-client data.
  const clientADoc = { sourceFileId: 'sfid-client-b-doc', fileName: 'Someone Else\'s Doc.pdf', status: 'indexed' };
  const clientAImportLogMap = new Map([
    ['sfid-client-a-doc', { sourceType: 'zip', sourceLabel: sourceLabelFor('zip'), sourcePath: 'Docs/a.pdf', importedBy: 'member-a', importedAt: '2026-07-01T00:00:00.000Z' }],
  ]);

  const [enriched] = mergeDocumentImportContext([clientADoc], clientAImportLogMap);
  assert.equal(enriched.sourceType, 'local');
  assert.equal(enriched.sourceLabel, 'Local upload');
  assert.equal(enriched.sourcePath, null);
  assert.equal(enriched.importedBy, null);
});
