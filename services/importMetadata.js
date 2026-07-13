const path = require('path');

// User-facing label for a source type — the single place this mapping lives so a
// raw provider code (e.g. "google_drive") never leaks into the UI.
function sourceLabelFor(sourceType) {
  return {
    local: 'Local upload',
    folder_upload: 'Folder upload',
    zip: 'ZIP import',
    google_drive: 'Google Drive import',
  }[sourceType] || 'Local upload';
}

// Relative folder path is display-only metadata, never a filesystem path — normalize
// it and drop anything that looks like traversal/absolute/drive-letter rather than
// failing the whole upload over it.
function sanitizeRelativePath(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const normalized = raw.replace(/\\/g, '/').trim();
  if (!normalized || normalized === '.') return null;
  if (
    normalized.startsWith('/') ||
    normalized.includes('..') ||
    path.isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.pdf', '.docx']);

// Pass-1 classification for ZIP import entries: validates paths, skips hidden/system
// files and unsupported extensions, applies an optional retryOnly filter, and detects
// obvious in-batch duplicates (same normalized relative path appearing twice). Entries
// only need { isDirectory, entryName, header: { size } } — real adm-zip entries satisfy
// this, and tests can pass lightweight plain objects.
function classifyZipEntries(entries, { retryOnlySet = null } = {}) {
  const valid = [];   // { entry, fileName, relativePath, ext }
  const skipped = []; // { fileName, reason }
  const seenRelativePaths = new Set();

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const rawName = entry.entryName;
    const normalized = rawName.replace(/\\/g, '/');

    // Zip-slip / path traversal / absolute-path guard.
    if (
      normalized.startsWith('/') ||
      normalized.includes('..') ||
      path.isAbsolute(normalized) ||
      /^[a-zA-Z]:/.test(normalized)
    ) {
      skipped.push({ fileName: rawName, reason: 'Unsafe path in archive' });
      continue;
    }

    const baseName = normalized.split('/').pop();
    if (!baseName) continue;

    if (
      normalized.startsWith('__MACOSX/') ||
      baseName.toLowerCase() === '.ds_store' ||
      baseName.toLowerCase() === 'thumbs.db' ||
      baseName.startsWith('.')
    ) {
      skipped.push({ fileName: baseName, reason: 'Hidden/system file' });
      continue;
    }

    const ext = path.extname(baseName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      skipped.push({ fileName: baseName, reason: `Unsupported file type (${ext || 'no extension'})` });
      continue;
    }

    if (retryOnlySet && !retryOnlySet.has(normalized)) continue;

    if (seenRelativePaths.has(normalized)) {
      skipped.push({ fileName: baseName, reason: 'Duplicate file in this import' });
      continue;
    }
    seenRelativePaths.add(normalized);

    valid.push({ entry, fileName: baseName, relativePath: normalized, ext });
  }

  return { valid, skipped };
}

// Merges AIKB's document list with the local import-log context (by source_file_id).
// AIKB stays authoritative for fileName/status/existence — this only adds portal-specific
// display fields. `importLogMap` is expected to already be scoped to one client (built from
// a client_id-filtered query), so a doc whose sourceFileId isn't in the map — whether it's a
// legacy document predating this feature, or (structurally) a different client's row — falls
// back identically and safely, never leaking another client's import context.
function mergeDocumentImportContext(docs, importLogMap) {
  return docs.map((doc) => {
    const sourceFileId = doc.sourceFileId || doc.source_file_id;
    const logEntry = sourceFileId ? importLogMap.get(sourceFileId) : null;
    if (logEntry) {
      return {
        ...doc,
        sourceType: logEntry.sourceType,
        sourceLabel: logEntry.sourceLabel,
        sourcePath: logEntry.sourcePath,
        importedAt: logEntry.importedAt,
        importedBy: logEntry.importedBy,
      };
    }
    return {
      ...doc,
      sourceType: 'local',
      sourceLabel: sourceLabelFor('local'),
      sourcePath: null,
      importedAt: doc.created_at || null,
      importedBy: null,
    };
  });
}

module.exports = {
  ALLOWED_EXTENSIONS,
  sourceLabelFor,
  sanitizeRelativePath,
  classifyZipEntries,
  mergeDocumentImportContext,
};
