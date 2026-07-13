-- Migration: 20260712_document_import_log_widen
-- Widen document_import_log to support folder uploads and speed up per-document
-- lookups used by the documents-list enrichment. No new table — this repo reuses
-- the existing append-only import log for portal-specific context; AIKB remains
-- the source of truth for document state.
-- Safe to run multiple times.

ALTER TABLE document_import_log
  DROP CONSTRAINT IF EXISTS document_import_log_source_type_check;
ALTER TABLE document_import_log
  ADD CONSTRAINT document_import_log_source_type_check
    CHECK (source_type IN ('local','folder_upload','zip','google_drive'));

CREATE INDEX IF NOT EXISTS idx_document_import_log_client_source_file
  ON document_import_log(client_id, source_file_id);
