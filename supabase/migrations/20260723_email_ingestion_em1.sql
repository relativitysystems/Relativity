-- Migration: 20260723_email_ingestion_em1
-- EM1 — Multi-member schema foundation (Architecture/architecture/EMAIL_INGESTION.md §13.1, §31).
-- Schema only: no route, service, or provider-adapter code is wired to any
-- of this yet (that begins at EM2). Lands every new/altered table this
-- feature's Relativity side needs, reviewable independently of any Gmail/
-- Microsoft adapter.
--
-- Six new tables (email_connections, email_organization_settings,
-- email_ingestion_rules, email_ingestion_events, email_sync_state,
-- email_sync_runs) plus two altered existing tables:
--   - client_members gains search_enabled (purely additive, defaulted true).
--   - oauth_connections' single-active-per-(client,provider) uniqueness is
--     relaxed to per-member for gmail/microsoft only; Slack/Google Drive/
--     Dropbox (and any other non-email provider) keep today's exact
--     behavior — see §6 gap 10, §12, §13.1, §25, §30 item 8 of
--     EMAIL_INGESTION.md, and the inline notes in §2 below.
--
-- No RLS, consistent with every other table in this repo — see
-- 20260714_oauth_connections.sql's tenant-isolation note (app-layer +
-- service-role-key trust boundary only). No cross-project foreign keys:
-- email_ingestion_rules.destination_collection_id and
-- email_ingestion_events.ingested_document_id reference AIKB's
-- knowledge_collections/knowledge_documents, which live in a separate
-- Supabase project — stored as plain UUID columns with no FK, mirroring
-- 20260717_slack_collection_access.sql's collection_id convention.
--
-- Safe to run multiple times (IF NOT EXISTS / DROP ... IF EXISTS throughout).
-- Purely additive: applies cleanly to a fresh database and to the current
-- pre-EM1 schema; no existing row is rewritten or destroyed.

-- ─────────────────────────────────────────────
-- 1. client_members.search_enabled
--
-- Fail-closed gate referenced throughout the Policy Evaluation Model
-- (EMAIL_INGESTION.md §16) — defaults to true (permissive) deliberately: it
-- gates a member's OWN future contribution, not the organization's, so a
-- restrictive default would silently break every member's expectation that
-- connecting their mailbox does something. Not wired into any authorization
-- or retrieval path by this migration (EM1 is schema only).
-- ─────────────────────────────────────────────
ALTER TABLE client_members
  ADD COLUMN IF NOT EXISTS search_enabled boolean NOT NULL DEFAULT true;

-- ─────────────────────────────────────────────
-- 2. oauth_connections — relax single-active-per-(client,provider)
--    uniqueness to per-member, for gmail/microsoft only.
--
-- Today's uq_oauth_connections_active_per_client_provider permits exactly
-- one active connection per (client_id, provider), full stop. That is
-- correct and must remain unchanged for Slack (one workspace install per
-- client, connectable by any admin) and for Google Drive/Dropbox (whose
-- persistent-connection flow was removed entirely — backlog M15 — but whose
-- provider values remain valid CHECK values and therefore still need
-- defined uniqueness behavior). It is WRONG for Gmail/Microsoft, where two
-- different members of the same client must each be able to hold their own
-- simultaneously-active mailbox connection.
--
-- Rather than a single relaxed index across every provider (which would
-- silently let a second admin's Slack reconnect coexist with the first
-- admin's, instead of replacing it — breaking getActiveConnectionForClient's
-- .maybeSingle() read and the existing single-workspace-per-client model),
-- this migration splits the old index into two provider-partitioned partial
-- unique indexes that together cover every provider exactly once:
--
--   - uq_oauth_connections_active_per_client_provider_legacy
--       (client_id, provider) WHERE status='active' AND provider NOT IN
--       ('gmail','microsoft') — byte-for-byte the same constraint Slack/
--       Google Drive/Dropbox (and any future non-email provider) had before
--       this migration.
--   - uq_oauth_connections_active_per_client_provider_member
--       (client_id, provider, connected_by_member_id) WHERE status='active'
--       AND provider IN ('gmail','microsoft') — the new per-member scope,
--       live data confirms zero existing gmail/microsoft rows today, so
--       this is a pure forward constraint, not a retrofit against live data.
--
-- Verified against live data before writing this migration: the Global
-- project's oauth_connections holds rows for 'slack' only (1 active, 1
-- revoked), both with a non-null connected_by_member_id — Google Drive and
-- Dropbox never wrote a live row (their connection flow was deleted before
-- ever being used, confirmed by ADR-006/backlog M15). This migration does
-- not rewrite or touch any existing row.
-- ─────────────────────────────────────────────
DROP INDEX IF EXISTS uq_oauth_connections_active_per_client_provider;

CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_connections_active_per_client_provider_legacy
  ON oauth_connections(client_id, provider)
  WHERE status = 'active' AND provider NOT IN ('gmail', 'microsoft');

CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_connections_active_per_client_provider_member
  ON oauth_connections(client_id, provider, connected_by_member_id)
  WHERE status = 'active' AND provider IN ('gmail', 'microsoft');

-- connected_by_member_id stays nullable at the column level — Slack's
-- original design didn't require per-connection attribution for uniqueness,
-- only for audit display, and legacy rows/providers are entitled to keep
-- that. A global NOT NULL would be an unsafe, out-of-scope change for a
-- column other providers legitimately leave null. Instead, the member
-- requirement for gmail/microsoft is enforced narrowly, as a conditional
-- CHECK that only constrains rows for those two providers going forward:
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_oauth_connections_member_required_for_email'
  ) THEN
    ALTER TABLE oauth_connections
      ADD CONSTRAINT chk_oauth_connections_member_required_for_email
      CHECK (provider NOT IN ('gmail', 'microsoft') OR connected_by_member_id IS NOT NULL);
  END IF;
END $$;

-- ─────────────────────────────────────────────
-- 3. replace_active_oauth_connection — scope replacement by member for
--    gmail/microsoft, unchanged for every other provider.
--
-- Signature is UNCHANGED (fully backward-compatible) — every existing
-- caller (services/oauthConnectionsService.js#createOrReplaceConnection,
-- called only from services/slackIntegrationService.js today; Google
-- Drive/Dropbox's own callers were removed entirely by backlog M15) keeps
-- working with no code change. Only the internal revoke-scope branches by
-- provider:
--   - gmail/microsoft: revokes the PRIOR ACTIVE connection for this
--     client+provider+member only — a Gmail connection for member A must
--     never revoke member B's Gmail connection.
--   - every other provider (slack, google_drive, dropbox, and any future
--     non-email provider): revokes by client+provider exactly as before —
--     a Slack reconnect by any admin still replaces the client's one
--     active Slack connection, matching today's behavior byte-for-byte.
--
-- Same atomicity guarantee as the original function: both the revoke and
-- the new connection/credential inserts happen inside this one PL/pgSQL
-- transaction boundary — a failed credential insert rolls back the revoke
-- too, so a prior connection is never considered "replaced" on failure.
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION replace_active_oauth_connection(
  p_client_id               uuid,
  p_provider                text,
  p_external_account_id     text,
  p_external_account_name   text,
  p_scopes_granted          text[],
  p_provider_metadata       jsonb,
  p_connected_by_member_id  uuid,
  p_access_token_encrypted  jsonb,
  p_refresh_token_encrypted jsonb,
  p_expires_at              timestamptz,
  p_encryption_key_version  integer
)
RETURNS oauth_connections
LANGUAGE plpgsql
AS $$
DECLARE
  v_connection oauth_connections;
BEGIN
  IF p_provider IN ('gmail', 'microsoft') AND p_connected_by_member_id IS NULL THEN
    RAISE EXCEPTION 'replace_active_oauth_connection: connected_by_member_id is required for provider %', p_provider;
  END IF;

  IF p_provider IN ('gmail', 'microsoft') THEN
    -- Per-member scope: only this member's own prior active connection for
    -- this client/provider is revoked. Another member's active connection
    -- for the same client/provider is left untouched.
    WITH revoked AS (
      UPDATE oauth_connections
         SET status = 'revoked',
             revoked_at = now(),
             updated_at = now()
       WHERE client_id = p_client_id
         AND provider = p_provider
         AND connected_by_member_id = p_connected_by_member_id
         AND status = 'active'
       RETURNING id
    )
    DELETE FROM oauth_credentials
     WHERE connection_id IN (SELECT id FROM revoked);
  ELSE
    -- Legacy scope, unchanged from the pre-EM1 function body: one active
    -- connection per client+provider, regardless of which member reconnects.
    WITH revoked AS (
      UPDATE oauth_connections
         SET status = 'revoked',
             revoked_at = now(),
             updated_at = now()
       WHERE client_id = p_client_id
         AND provider = p_provider
         AND status = 'active'
       RETURNING id
    )
    DELETE FROM oauth_credentials
     WHERE connection_id IN (SELECT id FROM revoked);
  END IF;

  INSERT INTO oauth_connections (
    client_id, provider, external_account_id, external_account_name,
    status, scopes_granted, provider_metadata, connected_by_member_id,
    connected_at, updated_at
  ) VALUES (
    p_client_id, p_provider, p_external_account_id, p_external_account_name,
    'active', p_scopes_granted, p_provider_metadata, p_connected_by_member_id,
    now(), now()
  )
  RETURNING * INTO v_connection;

  INSERT INTO oauth_credentials (
    connection_id, access_token_encrypted, refresh_token_encrypted,
    expires_at, encryption_key_version, created_at, updated_at
  ) VALUES (
    v_connection.id, p_access_token_encrypted, p_refresh_token_encrypted,
    p_expires_at, p_encryption_key_version, now(), now()
  );

  RETURN v_connection;
END;
$$;

-- ─────────────────────────────────────────────
-- 4. email_connections
-- Email-specific metadata for a mailbox connection, 1:1 with an
-- oauth_connections row (EMAIL_INGESTION.md §13.1).
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_connections (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                  uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  member_id                  uuid        NOT NULL REFERENCES client_members(id) ON DELETE RESTRICT,
  oauth_connection_id        uuid        NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
  provider                   text        NOT NULL
                                          CHECK (provider IN ('gmail', 'microsoft')),
  mailbox_address            text        NOT NULL,
  display_name               text,
  sync_mode                  text        NOT NULL DEFAULT 'manual_selected'
                                          CHECK (sync_mode IN ('manual_selected', 'automatic', 'paused')),
  sync_enabled                boolean    NOT NULL DEFAULT true,
  managed_label_id            text,
  historical_import_status    text       NOT NULL DEFAULT 'not_started'
                                          CHECK (historical_import_status IN ('not_started', 'running', 'completed', 'failed')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (oauth_connection_id)
);

CREATE INDEX IF NOT EXISTS idx_email_connections_client_id ON email_connections(client_id);
CREATE INDEX IF NOT EXISTS idx_email_connections_member_id ON email_connections(member_id);

-- ─────────────────────────────────────────────
-- 5. email_organization_settings
-- One row per client; the org-wide automatic-sync on/off switch
-- (EMAIL_INGESTION.md §13.1). Fail-closed default: a client that never
-- visits this setting has automatic sync unavailable to every member.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_organization_settings (
  client_id                uuid        PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  automatic_sync_enabled   boolean     NOT NULL DEFAULT false,
  updated_by_member_id     uuid        REFERENCES client_members(id) ON DELETE SET NULL,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────
-- 6. email_ingestion_rules (Organization Policy)
-- Client-scoped allow/deny criteria — the organization's maximum ingestion
-- boundary, authored once by owners/admins and applied identically to every
-- member's mailbox (EMAIL_INGESTION.md §13.1). Deliberately NOT scoped to a
-- single email_connection_id — see the architecture doc for why this
-- differs from the original single-mailbox design.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_ingestion_rules (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider              text        CHECK (provider IN ('gmail', 'microsoft')),  -- null = applies to every connected provider
  rule_type             text        NOT NULL CHECK (rule_type IN ('allow', 'deny')),
  label_or_folder       text,          -- provider-native label/folder id or name
  sender_pattern        text,          -- exact address or domain (e.g. '@client.com')
  recipient_pattern     text,
  subject_keyword       text,
  include_sent          boolean     NOT NULL DEFAULT false,
  include_attachments   boolean     NOT NULL DEFAULT false,
  max_historical_days   integer     NOT NULL DEFAULT 90
                                      CHECK (max_historical_days > 0 AND max_historical_days <= 730),
  destination_collection_id uuid,   -- AIKB knowledge_collections.id; no FK (cross-project, matches slack_collection_access convention)
  enabled               boolean     NOT NULL DEFAULT true,
  created_by_member_id  uuid        REFERENCES client_members(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_ingestion_rules_client_id
  ON email_ingestion_rules(client_id) WHERE enabled = true;

-- ─────────────────────────────────────────────
-- 7. email_sync_state
-- One row per connection — the cursor/watermark this codebase has never
-- had a concept of before (EMAIL_INGESTION.md §6 gap 2, §13.1).
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_sync_state (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email_connection_id   uuid        NOT NULL REFERENCES email_connections(id) ON DELETE CASCADE,
  provider_cursor       text,          -- Gmail historyId or Graph @odata.deltaLink
  cursor_obtained_at    timestamptz,
  cursor_status         text        NOT NULL DEFAULT 'none'
                                      CHECK (cursor_status IN ('none', 'valid', 'expired')),
  last_sync_started_at   timestamptz,
  last_sync_completed_at timestamptz,
  last_sync_status        text       CHECK (last_sync_status IN ('completed', 'failed', 'partial')),
  next_sync_due_at        timestamptz,  -- populated only once automatic sync ships (EM8+)
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email_connection_id)
);

-- ─────────────────────────────────────────────
-- 8. email_sync_runs
-- Per-attempt audit log (EMAIL_INGESTION.md §13.1, §27).
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_sync_runs (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email_connection_id   uuid        NOT NULL REFERENCES email_connections(id) ON DELETE CASCADE,
  run_type              text        NOT NULL CHECK (run_type IN ('historical', 'incremental', 'manual')),
  status                text        NOT NULL DEFAULT 'running'
                                      CHECK (status IN ('running', 'completed', 'failed', 'partial')),
  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  messages_scanned      integer     NOT NULL DEFAULT 0,
  messages_matched      integer     NOT NULL DEFAULT 0,
  messages_ingested     integer     NOT NULL DEFAULT 0,
  messages_skipped      integer     NOT NULL DEFAULT 0,  -- excluded by rule/deny-list
  messages_duplicate    integer     NOT NULL DEFAULT 0,
  messages_failed       integer     NOT NULL DEFAULT 0,
  error_summary         text,
  cursor_before          text,
  cursor_after            text,
  triggered_by_member_id uuid       REFERENCES client_members(id) ON DELETE SET NULL  -- the connection's own member for manual runs; null for automatic (EM8+) tick-triggered runs
);

CREATE INDEX IF NOT EXISTS idx_email_sync_runs_connection
  ON email_sync_runs(email_connection_id, started_at DESC);

-- ─────────────────────────────────────────────
-- 9. email_ingestion_events
-- Per-message rule-match explanation and outcome — the only place a
-- rule-excluded or unlabeled message's existence is ever recorded (AIKB
-- never learns about it). Deliberately holds subject-free, body-free
-- metadata only (EMAIL_INGESTION.md §13.1).
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_ingestion_events (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id           uuid        REFERENCES email_sync_runs(id) ON DELETE CASCADE,  -- null for out-of-band reconciliation events not tied to a sync run
  email_connection_id   uuid        NOT NULL REFERENCES email_connections(id) ON DELETE CASCADE,
  provider_message_id   text        NOT NULL,
  outcome               text        NOT NULL CHECK (outcome IN
                          ('ingested', 'excluded_no_matching_rule', 'excluded_deny_listed',
                           'excluded_not_labeled', 'duplicate', 'skipped_size_limit', 'failed',
                           'tombstoned_label_removed')),
  matched_rule_id        uuid        REFERENCES email_ingestion_rules(id) ON DELETE SET NULL,
  reason                text,          -- human-readable, e.g. "matched label:support, no deny match"
  ingested_document_id  uuid,          -- AIKB knowledge_documents.id; no FK (cross-project), null unless outcome IN ('ingested','tombstoned_label_removed')
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_ingestion_events_run
  ON email_ingestion_events(sync_run_id);
CREATE INDEX IF NOT EXISTS idx_email_ingestion_events_message
  ON email_ingestion_events(email_connection_id, provider_message_id);
