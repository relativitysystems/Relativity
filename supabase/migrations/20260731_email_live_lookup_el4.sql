-- Migration: 20260731_email_live_lookup_el4
-- EL4 — Gmail search and content tools
-- (Architecture/architecture/LIVE_EMAIL_LOOKUP.md §1.1 step 8, §7, EL4).
--
-- One additive migration: two new boolean columns, both nullable-free with
-- a fail-closed `false` default (matching automatic_sync_enabled's existing
-- precedent, 20260723_email_ingestion_em1.sql) — a client/connection that
-- never opts in has live lookup unavailable, not silently on.
--
-- Also extends offboard_client_member (20260725_email_ingestion_em9.sql) so
-- the new per-mailbox flag joins EM9's existing atomic offboarding cascade
-- rather than becoming a second, separately-maintained gate that could drift
-- out of sync with it (§7 threat table: "Revoked/offboarded employees").
--
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE).
-- Purely additive: applies cleanly to the current post-EM9 schema; no
-- existing row is rewritten or destroyed.

-- ─────────────────────────────────────────────
-- 1. email_organization_settings.live_lookup_enabled
--
-- Org-wide switch, independent of automatic_sync_enabled (§7: "why this is
-- a separate toggle from ingestion's automatic_sync_enabled" — live lookup
-- is a materially different capability, a live read on demand rather than a
-- recurring background ingest, and an org may want one without the other).
-- ─────────────────────────────────────────────
ALTER TABLE email_organization_settings
  ADD COLUMN IF NOT EXISTS live_lookup_enabled boolean NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────
-- 2. email_connections.live_lookup_enabled
--
-- Per-mailbox switch. A member's own opt-in, distinct from sync_enabled
-- (which governs ingestion) — a member can contribute to search without
-- exposing their mailbox to live on-demand lookup, and vice versa.
-- ─────────────────────────────────────────────
ALTER TABLE email_connections
  ADD COLUMN IF NOT EXISTS live_lookup_enabled boolean NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────
-- 3. offboard_client_member — fold live_lookup_enabled into the existing
--    sync_enabled cascade.
--
-- Same atomicity boundary as EM9's original function (one PL/pgSQL body,
-- one transaction) — a failure in the status write rolls back both column
-- forces below, exactly like sync_enabled today. Signature is unchanged.
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

  -- Every one of this member's email connections, forced closed immediately
  -- across both gates (ingestion sync and live lookup) in the same
  -- transaction as the status write above — EL4's addition to EM9's
  -- original single-gate cascade.
  UPDATE email_connections
     SET sync_enabled = false,
         live_lookup_enabled = false,
         updated_at = now()
   WHERE member_id = p_member_id
     AND (sync_enabled = true OR live_lookup_enabled = true);

  RETURN v_member;
END;
$$;
