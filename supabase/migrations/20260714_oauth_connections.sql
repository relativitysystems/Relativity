-- Migration: 20260714_oauth_connections
-- Architecture Review Phase 4, Milestone 2 — encrypted, provider-agnostic
-- OAuth connection storage. Replaces the plaintext oauth_tokens path for
-- new providers, starting with Slack. oauth_tokens is NOT dropped — Google
-- Drive and Dropbox continue to read/write it unchanged until a later,
-- separate migration moves them onto this model.
--
-- Tenant isolation note: this repository has no established Row-Level
-- Security pattern (confirmed by grep across every existing migration —
-- no CREATE POLICY / ENABLE ROW LEVEL SECURITY anywhere). Consistent with
-- every other table here, isolation for oauth_connections/oauth_credentials
-- is enforced at the application layer (every query scoped by client_id)
-- and by the service-role-key trust boundary, not by RLS. Adding RLS as
-- defense-in-depth remains a tracked Should-Have (architecture_review_
-- report.md Phase 2 §10), not introduced in this migration so as not to
-- establish a new pattern inconsistent with the rest of this schema.
--
-- Safe to run multiple times (IF NOT EXISTS / CREATE OR REPLACE), except
-- the destructive statement in §4, which is idempotent by nature — a
-- second run deletes zero rows.

-- ─────────────────────────────────────────────
-- 1. oauth_connections
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_connections (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id              uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider               text        NOT NULL
                                        CHECK (provider IN ('slack','microsoft','gmail','google_drive','dropbox')),
  external_account_id    text,
  external_account_name  text,
  status                 text        NOT NULL DEFAULT 'active'
                                        CHECK (status IN ('active','revoked','expired','error')),
  scopes_granted         text[]      NOT NULL DEFAULT '{}',
  provider_metadata      jsonb       NOT NULL DEFAULT '{}',
  connected_by_member_id uuid        REFERENCES client_members(id) ON DELETE SET NULL,
  connected_at           timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  revoked_at             timestamptz
);

CREATE INDEX IF NOT EXISTS idx_oauth_connections_client_id ON oauth_connections(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_connections_provider  ON oauth_connections(provider);
CREATE INDEX IF NOT EXISTS idx_oauth_connections_status    ON oauth_connections(status);

-- One active connection per (client, provider) for this MVP. A client may
-- reconnect — the RPC below revokes the prior active row before inserting
-- the new one — but two simultaneously active rows for the same client and
-- provider are never permitted.
CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_connections_active_per_client_provider
  ON oauth_connections(client_id, provider)
  WHERE status = 'active';

-- An external account (e.g. one Slack workspace/team_id) must not be
-- actively connected to more than one organization at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_connections_active_external_account
  ON oauth_connections(provider, external_account_id)
  WHERE status = 'active' AND external_account_id IS NOT NULL;

-- ─────────────────────────────────────────────
-- 2. oauth_credentials
-- Encrypted-at-rest credential material, split into its own table so
-- metadata reads (status pages, connection lists) never touch a column
-- that could hold ciphertext. Application code must never insert plaintext
-- here — see services/integrationCredentialEncryption.js.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_credentials (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id           uuid        NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
  access_token_encrypted  jsonb       NOT NULL,
  refresh_token_encrypted jsonb,
  expires_at              timestamptz,
  encryption_key_version  integer     NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_credentials_connection_id ON oauth_credentials(connection_id);

-- ─────────────────────────────────────────────
-- 3. Atomic connection+credential replace (RPC)
--
-- Supabase JS has no multi-statement transaction API from the client. This
-- function is the atomicity boundary instead: a single PL/pgSQL function
-- body executes inside one transaction as part of the calling statement, so
-- if the credential insert fails, the connection revoke/insert above it is
-- rolled back too — there is never a moment where an "active" connection
-- row exists with no matching credential row.
--
-- Plaintext tokens never reach this function or this database — the caller
-- (services/oauthConnectionsService.js, via
-- services/integrationCredentialEncryption.js) encrypts in application
-- memory first; only the resulting JSON envelope crosses the RPC boundary.
--
-- Guarantee (verified in application logic by
-- test/oauthConnectionsService.test.js): this function's transaction
-- boundary means it is never possible to observe, even under a concurrent
-- failure, any of:
--   - two simultaneously active connections for the same (client, provider)
--   - an active connection row with no matching oauth_credentials row
--   - an active connection pointing at a credential insert that failed
-- If ANY statement below fails (the credential insert included), the
-- entire function raises and every change it made — including the revoke
-- of the prior connection — is rolled back atomically. The prior active
-- connection is only actually considered "replaced" once this function
-- returns successfully; a raised exception leaves the previous connection
-- exactly as it was.
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
  -- Revoke any prior active connection for this client/provider first, so
  -- the partial unique index below never sees two simultaneously active
  -- rows. Its credential row is deleted immediately — superseded
  -- ciphertext is not retained — mirroring disconnect behavior.
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

  -- If this insert fails (e.g. a NOT NULL violation on a malformed
  -- envelope), the entire function raises and the connection insert above
  -- is rolled back with it — no orphaned "active" connection is possible.
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
-- 4. Legacy plaintext Slack cleanup
--
-- DESTRUCTIVE: deletes existing plaintext Slack rows from oauth_tokens.
-- These rows were already confirmed dead by Architecture Review Phase 1 —
-- "nothing in Relativity ever reads this token again" — and Phase 1 §11
-- Decision 4 already approved discarding the old Slack OAuth flow outright.
-- Any Slack workspace connected under the old flow must reconnect through
-- the new oauth_connections-based flow (Milestone 3) after this runs —
-- there is no migration path for the old token, because the new schema
-- requires an application-layer-encrypted envelope that never existed for
-- these plaintext rows.
--
-- Google Drive and Dropbox rows are untouched by this statement — they
-- still use oauth_tokens as their only credential store.
-- No token value is read, selected, or logged by this statement.
--
-- Manual verification (recommended before running this migration): an
-- operator can independently confirm how many legacy Slack rows exist,
-- without selecting any token column:
--   SELECT count(*) FROM oauth_tokens WHERE provider = 'slack';
-- The block below performs the same count automatically and reports it as
-- a NOTICE at migration time, purely for an audit trail — it never
-- selects, returns, or logs a token value, only a row count.
--
-- Rollback note: this statement cannot be undone by re-running the
-- migration or by any code in this repository. The deleted plaintext
-- tokens are unrecoverable unless a database backup/point-in-time-recovery
-- snapshot from before this migration ran is restored — there is no
-- application-level backup of the plaintext by design (a plaintext backup
-- would defeat the purpose of this migration).
-- ─────────────────────────────────────────────
DO $$
DECLARE
  v_slack_row_count integer;
BEGIN
  SELECT count(*) INTO v_slack_row_count FROM oauth_tokens WHERE provider = 'slack';
  RAISE NOTICE 'oauth_connections migration: about to delete % legacy plaintext Slack row(s) from oauth_tokens — affected workspaces must reconnect via the new OAuth flow (Milestone 3)', v_slack_row_count;
END $$;

DELETE FROM oauth_tokens WHERE provider = 'slack';
