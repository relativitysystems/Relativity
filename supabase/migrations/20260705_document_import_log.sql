-- Migration: 20260705_document_import_log
-- Tracks provenance (source type, folder path, batch grouping) for knowledge
-- base imports. Relativity-local only — AIKB's schema/ingest endpoint is
-- untouched; this table exists purely so the portal can group and label
-- import history and preserve folder paths for future sync work.
-- Safe to run multiple times (uses IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS document_import_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  import_batch_id uuid        NOT NULL,
  source_type     text        NOT NULL
                                CHECK (source_type IN ('local','zip','google_drive')),
  source_path     text,
  file_name       text        NOT NULL,
  source_file_id  text        NOT NULL,
  imported_by     uuid        REFERENCES client_members(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_import_log_batch
  ON document_import_log(client_id, import_batch_id);

CREATE INDEX IF NOT EXISTS idx_document_import_log_client_created
  ON document_import_log(client_id, created_at DESC);
