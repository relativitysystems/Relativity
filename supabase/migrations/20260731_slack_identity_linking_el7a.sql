-- Migration: 20260731_slack_identity_linking_el7a
-- EL7A — Slack identity linking
-- (Architecture/architecture/LIVE_EMAIL_LOOKUP.md §3.1, EL7A).
--
-- A much smaller, purpose-built identity link, scoped only to enabling
-- live mailbox lookup from Slack — NOT the deferred, full Milestone 7
-- (general per-employee authorization). Two new tables:
--   - slack_link_codes: short-lived, hashed, single-use codes generated in
--     the authenticated portal, mirroring oauth_states.js's existing
--     hash-only-storage/atomic-single-use-consumption/TTL pattern exactly
--     (20260715_oauth_states.sql) — a dedicated table rather than literally
--     reusing oauth_states, since that table's schema (provider,
--     redirect_after) is OAuth-redirect-flow-specific, not a generic
--     code-payload table.
--   - slack_user_links: the resulting mapping, one row per (client,
--     Slack user), consumed by EL7B.
--
-- No RLS, consistent with every other table in this repo — app-layer +
-- service-role-key trust boundary only (20260714_oauth_connections.sql's
-- note).
--
-- Safe to run multiple times (CREATE TABLE IF NOT EXISTS). Purely
-- additive: applies cleanly to the current schema; no existing row is
-- rewritten or destroyed.

CREATE TABLE IF NOT EXISTS slack_link_codes (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash    text        NOT NULL UNIQUE,
  client_id    uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  member_id    uuid        NOT NULL REFERENCES client_members(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slack_link_codes_expires_at ON slack_link_codes(expires_at);

-- §3.1: "re-linking a Slack user id replaces, never appends to, any prior
-- link for that id" — enforced by this unique constraint plus
-- slackUserLinkService.js#completeLink's upsert-on-conflict.
CREATE TABLE IF NOT EXISTS slack_user_links (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  slack_user_id  text        NOT NULL,
  slack_team_id  text        NOT NULL,
  member_id      uuid        NOT NULL REFERENCES client_members(id) ON DELETE CASCADE,
  linked_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, slack_user_id)
);
