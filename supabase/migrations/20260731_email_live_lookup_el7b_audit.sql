-- Migration: 20260731_email_live_lookup_el7b_audit
-- EL7B — Slack live-email access: minimal audit trail
-- (Architecture/architecture/LIVE_EMAIL_LOOKUP.md §10, EL9's own
-- "extend, don't duplicate" recommendation, pulled forward narrowly here
-- since EL7B's own acceptance criteria requires it — "every live-lookup
-- Slack interaction produces an audit row naming the Slack user,
-- workspace, resolved member, mailbox, tool, and result count" — and full
-- EL9 (soft token budgets, per-connection rate budgets) is not built yet).
--
-- Extends email_ingestion_events (EM1) rather than a new table, per §10.1's
-- explicit recommendation: it already models
-- {client_id (via connection), connection_id, provider_message_id, outcome,
-- reason, created_at} and its outcome CHECK has already been widened once
-- (EM9's tombstoned_policy_change) — the same pattern, applied again.
--
-- provider_message_id was NOT NULL for every ingestion outcome — correct
-- for those (one specific message), wrong for a live SEARCH (many
-- candidate messages, no single id). Relaxed to nullable, with a CHECK
-- that keeps it required for every outcome except the two new live-lookup
-- ones — ingestion's own existing rows/guarantees are unaffected.
--
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF
-- EXISTS + re-ADD). Purely additive: applies cleanly to the current
-- schema; no existing row is rewritten or destroyed.

ALTER TABLE email_ingestion_events ALTER COLUMN provider_message_id DROP NOT NULL;

ALTER TABLE email_ingestion_events
  DROP CONSTRAINT IF EXISTS email_ingestion_events_outcome_check;
ALTER TABLE email_ingestion_events
  ADD CONSTRAINT email_ingestion_events_outcome_check
    CHECK (outcome IN (
      'ingested', 'excluded_no_matching_rule', 'excluded_deny_listed',
      'excluded_not_labeled', 'duplicate', 'skipped_size_limit', 'failed',
      'tombstoned_label_removed', 'tombstoned_policy_change',
      'live_lookup_search', 'live_lookup_fetch'
    ));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_email_ingestion_events_provider_message_id_required'
  ) THEN
    ALTER TABLE email_ingestion_events
      ADD CONSTRAINT chk_email_ingestion_events_provider_message_id_required
      CHECK (provider_message_id IS NOT NULL OR outcome IN ('live_lookup_search', 'live_lookup_fetch'));
  END IF;
END $$;

-- §10.2 fields — narrowed to exactly what EL7B's acceptance criteria and
-- emailLiveLookupService.js's audit write actually populate; token_usage/
-- used_in_final_answer are left for full EL9 (they need AIKB-side wiring
-- this narrower pass doesn't build).
ALTER TABLE email_ingestion_events ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE email_ingestion_events ADD COLUMN IF NOT EXISTS origin_metadata jsonb;
ALTER TABLE email_ingestion_events ADD COLUMN IF NOT EXISTS tool_name text;
ALTER TABLE email_ingestion_events ADD COLUMN IF NOT EXISTS result_count integer;
ALTER TABLE email_ingestion_events ADD COLUMN IF NOT EXISTS provider_latency_ms integer;
