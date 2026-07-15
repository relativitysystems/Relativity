-- Migration: 20260715_oauth_states
-- Architecture Review Phase 4, Milestone 3 — secure, server-side OAuth
-- state storage for the Slack OAuth connection flow (services/oauthStateService.js,
-- routes/integrations/slack.js). Provider-neutral, same as oauth_connections/
-- oauth_credentials, so a future provider reuses this table rather than
-- getting its own. Additive only; does not touch oauth_connections,
-- oauth_credentials, or oauth_tokens.
--
-- Threat model / design:
-- - The raw state value (32 random bytes, hex-encoded — see
--   services/oauthStateService.js#generateRawState) is sent to the provider
--   (Slack) as the `state` query parameter and is NEVER written to this
--   table or logged anywhere. Only its SHA-256 hash (`state_hash`) is
--   persisted, so a leaked database row cannot be replayed as a live state
--   value — this is the "hash, don't store raw" requirement.
-- - `client_id`/`member_id` are captured here at /start time, from the
--   authenticated session server-side — never from anything the browser or
--   Slack later supplies. The callback resolves organization/member
--   identity ONLY from this row, closing the confused-deputy gap in the
--   old unsigned base64(JSON) state that trusted a client-supplied
--   clientId (see supabase/migrations/20260714_oauth_connections.sql §4
--   for that flow's retirement).
-- - Single-use consumption is enforced by ONE atomic conditional UPDATE
--   issued by services/oauthStateService.js#consumeState — no RPC needed,
--   because a single UPDATE statement already executes as one Postgres
--   command:
--     UPDATE oauth_states SET consumed_at = now()
--      WHERE state_hash = $1 AND provider = $2
--        AND consumed_at IS NULL AND expires_at > now()
--     RETURNING *;
--   Postgres re-evaluates the WHERE clause for each candidate row under the
--   row lock the UPDATE takes, so two concurrent callback requests for the
--   same state can never both succeed: whichever executes second observes
--   consumed_at already set (or expires_at already elapsed) and matches
--   zero rows. This is the "reused state rejected" / "single consume"
--   guarantee.
-- - A short, fixed TTL (10 minutes, enforced by services/oauthStateService.js,
--   not by a database trigger) keeps a stolen-but-unused state's window of
--   validity small.
--
-- Tenant isolation note: consistent with oauth_connections/oauth_credentials
-- (see supabase/migrations/20260714_oauth_connections.sql), isolation is
-- enforced at the application layer (every query scoped by client_id/
-- state_hash), not by Row-Level Security — this repository has no
-- established RLS pattern (see that migration's note for the same
-- rationale, tracked as a Should-Have, not introduced here).
--
-- Safe to run multiple times (IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT
-- EXISTS throughout). No destructive statements.

CREATE TABLE IF NOT EXISTS oauth_states (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash     text        NOT NULL,
  client_id      uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  member_id      uuid        NOT NULL REFERENCES client_members(id) ON DELETE CASCADE,
  provider       text        NOT NULL
                                CHECK (provider IN ('slack','microsoft','gmail','google_drive','dropbox')),
  redirect_after text,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Unique, not just indexed — a hash collision between two stored rows would
-- let one row's lookup accidentally match another's, which must never be
-- possible for a single-use security token.
CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_states_state_hash ON oauth_states(state_hash);

-- Supports the atomic consume UPDATE's WHERE clause and the read-only
-- classification lookup services/oauthStateService.js performs when the
-- atomic update matches nothing (to tell "expired" apart from "unknown"
-- apart from "already used" apart from "wrong provider" for a safe,
-- non-leaking user-facing redirect).
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_states_client_id   ON oauth_states(client_id);

-- Expired/consumed rows hold no secret material (only a hash, never the raw
-- state or any token), so retaining them briefly is harmless, but periodic
-- cleanup is still good hygiene. No scheduled job is added by this
-- migration; an operator can safely run this manually or via a future cron:
--   DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day';
