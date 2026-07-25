-- Migration: 20260725_email_ingestion_em8
-- EM8 — Automatic sync scheduler (Architecture/architecture/EMAIL_INGESTION.md §31).
-- One column: email_connections.pre_pause_sync_mode, needed for the new
-- pause/resume routes to restore a member's actual prior sync_mode on
-- resume (§14.1's "/resume restores the member's prior mode"), rather than
-- always defaulting back to manual_selected. Nullable, purely additive — a
-- connection that has never been paused simply never populates it.
--
-- Safe to run multiple times (IF NOT EXISTS throughout). Purely additive:
-- applies cleanly to a fresh database and to the current post-EM1 schema;
-- no existing row is rewritten or destroyed.

ALTER TABLE email_connections
  ADD COLUMN IF NOT EXISTS pre_pause_sync_mode TEXT;

COMMENT ON COLUMN email_connections.pre_pause_sync_mode IS
  'Set to the connection''s sync_mode at the moment /pause is called; read and cleared by /resume. Null when the connection has never been paused.';
