-- Migration: 20260731_email_live_lookup_el6
-- EL6 — Portal automatic/live-search experience: consent
-- (Architecture/architecture/LIVE_EMAIL_LOOKUP.md §2.3, EL6).
--
-- One additive column: client_members.live_lookup_consented_at, nullable,
-- no default (null = not consented = tool-offering blocked, fail-closed —
-- same pattern as every other email-feature gate in this codebase).
--
-- Naming note: §EL6's own milestone table names this column
-- `live_lookup_ack_at`; §2.3 ("Consent design — confirmed, 2026-07-30"),
-- the more detailed and explicitly dated design section, names it
-- `live_lookup_consented_at` and defines its exact semantics (set on first
-- attempted use, cleared on revocation via a settings-panel toggle). This
-- migration follows §2.3 as authoritative — a genuine inconsistency in the
-- source document between its own summary table and its detailed design
-- section, not a judgment call this migration needed to invent.
--
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS). Purely additive:
-- applies cleanly to the current post-EL4 schema; no existing row is
-- rewritten or destroyed.

ALTER TABLE client_members
  ADD COLUMN IF NOT EXISTS live_lookup_consented_at timestamptz;
