-- Migration: 20260725_email_ingestion_em9
-- EM9 — Member offboarding and policy reconciliation
-- (Architecture/architecture/EMAIL_INGESTION.md §24.5, §25, §30 item 12, §31).
--
-- No new table or column (§31's EM9 entry: "DB: none new") — one new RPC
-- function and one widened CHECK constraint.
--
-- Safe to run multiple times (CREATE OR REPLACE / DROP CONSTRAINT IF EXISTS
-- throughout). Purely additive: applies cleanly to the current post-EM8
-- schema; no existing row is rewritten or destroyed.

-- ─────────────────────────────────────────────
-- 1. offboard_client_member — atomic status transition + sync_enabled
--    cascade.
--
-- §25's "Member offboarding race condition" entry is explicit: if the
-- client_members.status write and the email_connections.sync_enabled=false
-- write are two separate application-level calls, a sync can start in the
-- window between them even though both calls happen inside the same
-- request handler. Supabase JS has no multi-statement transaction API from
-- the client (the same constraint that motivated
-- replace_active_oauth_connection, 20260714_oauth_connections.sql) — this
-- function is the atomicity boundary instead, exactly the same shape: one
-- PL/pgSQL function body executes inside one transaction as part of the
-- calling statement, so a failure in either write rolls back both.
--
-- §24.5 item 2: sync_mode is deliberately left untouched — only
-- sync_enabled is forced false. The fail-closed gate every sync path
-- already checks (assertSyncAllowed, listDueAutomaticConnections) is
-- sync_enabled, not sync_mode, so this function doesn't need to guess what
-- mode a reinstated member would want restored.
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION offboard_client_member(
  p_member_id uuid,
  p_client_id uuid,
  p_status    text
)
RETURNS client_members
LANGUAGE plpgsql
AS $$
DECLARE
  v_member client_members;
BEGIN
  IF p_status NOT IN ('disabled', 'revoked') THEN
    RAISE EXCEPTION 'offboard_client_member: p_status must be disabled or revoked, got %', p_status;
  END IF;

  UPDATE client_members
     SET status = p_status,
         updated_at = now()
   WHERE id = p_member_id
     AND client_id = p_client_id
   RETURNING * INTO v_member;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'offboard_client_member: member % not found for client %', p_member_id, p_client_id;
  END IF;

  -- §24.5 item 1 — every one of this member's email connections, forced
  -- closed immediately, before the member's own session/OAuth token is
  -- necessarily revoked. Same transaction as the status write above.
  UPDATE email_connections
     SET sync_enabled = false,
         updated_at = now()
   WHERE member_id = p_member_id
     AND sync_enabled = true;

  RETURN v_member;
END;
$$;

-- ─────────────────────────────────────────────
-- 2. email_ingestion_events.outcome — add 'tombstoned_policy_change'.
--
-- §28.1's "Label reconciliation after policy changes" case: a message
-- ingested under an old policy, still labeled, whose owning organization
-- then edits policy so it no longer matches. This is a distinct event from
-- 'tombstoned_label_removed' (§24.2's label-withdrawal-of-consent path) —
-- the label is still present here; it's the organization's policy boundary
-- that moved, not the member's own consent. Kept as its own outcome value
-- rather than reusing 'tombstoned_label_removed' so the audit trail
-- (§27) can distinguish "member withdrew consent" from "org narrowed
-- policy" — two different actors, two different questions an admin might
-- ask of this table later.
-- ─────────────────────────────────────────────
ALTER TABLE email_ingestion_events
  DROP CONSTRAINT IF EXISTS email_ingestion_events_outcome_check;
ALTER TABLE email_ingestion_events
  ADD CONSTRAINT email_ingestion_events_outcome_check
    CHECK (outcome IN
      ('ingested', 'excluded_no_matching_rule', 'excluded_deny_listed',
       'excluded_not_labeled', 'duplicate', 'skipped_size_limit', 'failed',
       'tombstoned_label_removed', 'tombstoned_policy_change'));
